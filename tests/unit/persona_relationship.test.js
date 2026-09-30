'use strict';
// G3 關係層：證據門檻、提案內容、每週上限、auto_apply 開關、回滾。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet, rawMemoryPlaintext } = require('./_helpers');
const { seedFragments, seedTrait, seedQualifiedTrait, DAYS3 } = require('./_persona_helpers');

const dbPath = setupEnv('persona-rel');
let restore, db, persona;
const ON = { persona: { auto_apply: true } };
const OFF = { persona: { auto_apply: false } };
const clear = () => {
    for (const t of ['persona_proposals', 'persona_relationship_versions', 'persona_model', 'persona_events', 'user_model', 'memory_fragments']) db.prepare(`DELETE FROM ${t}`).run();
};

before(() => {
    restore = quiet();
    require('../../database').initDatabase();
    db = require('../../database').getDb();
    persona = require('../../services/persona');
});
after(() => { restore(); cleanupDb(dbPath); });

describe('證據門檻', () => {
    test('證據不足（2 條碎片、3 天）→ 不產生提案', () => {
        clear();
        const ids = seedFragments(db, 2, DAYS3);
        seedTrait(db, { content: '習慣早起', fragIds: ids });
        const r = persona.generateProposals({ cfg: ON });
        assert.equal(r.created.length, 0);
        assert.equal(r.insufficient, 1);
    });
    test('證據不足（4 條碎片但都在同一天）→ 不產生提案', () => {
        clear();
        const ids = seedFragments(db, 4, ['2026-09-01']);
        seedTrait(db, { content: '習慣早起', fragIds: ids });
        assert.equal(persona.generateProposals({ cfg: ON }).created.length, 0);
    });
    test('碎片已不是 active（被刪／凍結）不算證據', () => {
        clear();
        const ids = seedFragments(db, 3, DAYS3);
        db.prepare("UPDATE memory_fragments SET status = 'deleted' WHERE id = ?").run(ids[0]);
        seedTrait(db, { content: '習慣早起', fragIds: ids });
        assert.equal(persona.generateProposals({ cfg: ON }).created.length, 0);
    });
    test('重複的碎片 id 只算一條', () => {
        clear();
        const ids = seedFragments(db, 2, DAYS3);
        seedTrait(db, { content: '習慣早起', fragIds: [ids[0], ids[0], ids[1], ids[1]] });
        assert.equal(persona.generateProposals({ cfg: ON }).created.length, 0);
    });
    test('信心不足（0.6）的特質不提案；壞的 source_fragment_ids 不會拋錯', () => {
        clear();
        const ids = seedFragments(db, 3, DAYS3);
        seedTrait(db, { content: '低信心特質', confidence: 0.6, fragIds: ids });
        db.prepare("INSERT INTO user_model (type, content, confidence, source_fragment_ids) VALUES ('stable_trait', '壞資料', 0.9, 'not json')").run();
        assert.equal(persona.generateProposals({ cfg: ON }).created.length, 0);
    });
    test('滿足（3 條、3 天）→ 產生提案，含證據 id、天數與 diff', () => {
        clear();
        const ids = seedFragments(db, 3, DAYS3);
        seedTrait(db, { content: '習慣早起', fragIds: ids });
        const r = persona.generateProposals({ cfg: ON });
        assert.equal(r.created.length, 1);
        const p = persona.getProposal(r.created[0]);
        assert.equal(p.status, 'pending');
        assert.equal(p.content, '習慣早起');
        assert.deepEqual(p.evidence_ids.slice().sort(), ids.slice().sort());
        assert.equal(p.evidence_days, 3);
        assert.deepEqual(p.diff, { before: '', after: '習慣早起', added: '習慣早起' });
    });
    test('同一條特質不會重複提案（含被拒絕之後）', () => {
        const first = persona.listProposals()[0];
        assert.equal(persona.generateProposals({ cfg: ON }).created.length, 0);
        persona.rejectProposal(first.id);
        assert.equal(persona.generateProposals({ cfg: ON }).created.length, 0);
        assert.equal(persona.getProposal(first.id).status, 'rejected');
    });
    test('MEMORY_ENCRYPTION=on 時，提案與關係層內文在資料庫裡是密文', () => {
        clear();
        seedQualifiedTrait(db, '很怕冷');
        const r = persona.generateProposals({ cfg: ON });
        persona.applyProposal(r.created[0]);
        const raw = Object.getPrototypeOf(db).prepare.call(db, 'SELECT content, diff FROM persona_proposals').get();
        const rawRel = Object.getPrototypeOf(db).prepare.call(db, "SELECT content FROM persona_model WHERE section = 'relationship'").get();
        if (String(process.env.MEMORY_ENCRYPTION || 'on').toLowerCase() === 'off') {
            assert.equal(raw.content, '很怕冷');
        } else {
            assert.ok(raw.content.startsWith('enc:') && raw.diff.startsWith('enc:') && rawRel.content.startsWith('enc:'));
            assert.deepEqual(rawMemoryPlaintext(db), []);
        }
        // 透明解密：讀出來是明文
        assert.equal(persona.getActiveRelationship().content, '很怕冷');
    });
});

describe('套用、每週上限、auto_apply', () => {
    test('auto_apply=true：每週最多套用 2 項，其餘留 pending；隔週再套用', () => {
        clear();
        for (const t of ['特質甲', '特質乙', '特質丙']) seedQualifiedTrait(db, t, 0.9);
        persona.generateProposals({ cfg: ON });
        const t0 = new Date('2026-09-10T00:00:00Z');
        const a = persona.autoApplyPending({ cfg: ON, now: t0 });
        assert.equal(a.applied.length, 2);
        assert.equal(a.deferred, 1);
        assert.equal(persona.listProposals({ status: 'pending' }).length, 1);
        // 同一週再跑：仍是 2 項，不會多套
        assert.equal(persona.autoApplyPending({ cfg: ON, now: new Date('2026-09-12T00:00:00Z') }).applied.length, 0);
        // 8 天後：第一批已滑出 7 天視窗
        const later = persona.autoApplyPending({ cfg: ON, now: new Date('2026-09-18T00:00:00Z') });
        assert.equal(later.applied.length, 1);
        assert.deepEqual(persona.getActiveRelationship().lines, ['特質甲', '特質乙', '特質丙']);
    });
    test('關係層寫進 persona_model 的 relationship section，並保留版本快照', () => {
        const row = db.prepare("SELECT content FROM persona_model WHERE section = 'relationship'").get();
        assert.equal(row.content, '特質甲\n特質乙\n特質丙');
        const versions = persona.listRelationshipVersions();
        assert.deepEqual(versions.map(v => v.version), [3, 2, 1]);
        assert.deepEqual(versions.map(v => v.active), [1, 0, 0]);
        assert.equal(versions[2].content, '特質甲');
        // companionPersona 讀得到（後台用）
        assert.match(require('../../services/companionPersona').getCompanionPersonaBase(), /特質乙/);
    });
    test('auto_apply=false：提案保持 pending，不自動套用', () => {
        clear();
        seedQualifiedTrait(db, '特質丁', 0.9);
        persona.generateProposals({ cfg: OFF });
        const r = persona.autoApplyPending({ cfg: OFF });
        assert.equal(r.disabled, true);
        assert.equal(r.applied.length, 0);
        assert.equal(persona.listProposals({ status: 'pending' }).length, 1);
        assert.deepEqual(persona.getActiveRelationship().lines, []);
    });
    test('手動套用不受每週上限限制；已處理的提案不能重複套用或拒絕', () => {
        clear();
        const names = ['一', '二', '三'].map(s => `手動特質${s}`);
        names.forEach(n => seedQualifiedTrait(db, n, 0.9));
        const created = persona.generateProposals({ cfg: OFF }).created;
        for (const id of created) assert.equal(persona.applyProposal(id).ok, true);
        assert.equal(persona.getActiveRelationship().lines.length, 3);
        assert.equal(persona.applyProposal(created[0]).ok, false);
        assert.equal(persona.rejectProposal(created[0]).ok, false);
        assert.equal(persona.applyProposal(99999).ok, false);
    });
    test('手動拒絕：狀態 rejected，關係層不變', () => {
        clear();
        seedQualifiedTrait(db, '被拒特質', 0.9);
        const id = persona.generateProposals({ cfg: OFF }).created[0];
        assert.equal(persona.rejectProposal(id, { note: '不像我' }).ok, true);
        const p = persona.getProposal(id);
        assert.deepEqual([p.status, p.note], ['rejected', '不像我']);
        assert.equal(persona.getActiveRelationship().version, 0);
    });
});

describe('回滾', () => {
    test('手動回滾一項提案：只拿掉它那一行，其他不動，狀態 rolled_back', () => {
        clear();
        ['甲', '乙'].forEach(s => seedQualifiedTrait(db, `回滾特質${s}`, 0.9));
        const [a, b] = persona.generateProposals({ cfg: OFF }).created;
        persona.applyProposal(a); persona.applyProposal(b);
        const r = persona.rollbackProposal(a);
        assert.equal(r.ok, true);
        assert.deepEqual(persona.getActiveRelationship().lines, ['回滾特質乙']);
        assert.equal(persona.getProposal(a).status, 'rolled_back');
        assert.equal(persona.getProposal(b).status, 'applied');
        assert.equal(persona.rollbackProposal(a).ok, false);   // 已回滾不能再回滾
    });
    test('回到「上一個通過漂移檢查的版本」；沒有通過過的版本就回到空白', () => {
        clear();
        ['甲', '乙', '丙'].forEach(s => seedQualifiedTrait(db, `漂移特質${s}`, 0.9));
        const [a, b, c] = persona.generateProposals({ cfg: OFF }).created;
        persona.applyProposal(a);
        persona.markActivePassed();                 // v1 通過
        persona.applyProposal(b); persona.applyProposal(c);   // v2、v3 未檢查
        const r = persona.rollbackToLastPassed();
        assert.equal(r.ok, true);
        assert.equal(r.restored_from, 1);
        assert.deepEqual(persona.getActiveRelationship().lines, ['漂移特質甲']);
        assert.deepEqual([b, c].map(id => persona.getProposal(id).status), ['rolled_back', 'rolled_back']);
        assert.equal(persona.getProposal(a).status, 'applied');
        const vs = persona.listRelationshipVersions();
        assert.equal(vs.find(v => v.version === 3).drift_passed, 0);   // 被判定漂移的那版
        assert.equal(vs[0].source, 'drift_rollback');
        // 沒有任何通過過的版本 → 回到空白
        const noPassed = (() => {
            clear();
            seedQualifiedTrait(db, '孤單特質', 0.9);
            const id = persona.generateProposals({ cfg: OFF }).created[0];
            persona.applyProposal(id);
            return persona.rollbackToLastPassed();
        })();
        assert.equal(noPassed.restored_from, 0);
        assert.deepEqual(persona.getActiveRelationship().lines, []);
    });
});
