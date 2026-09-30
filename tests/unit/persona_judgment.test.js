'use strict';
// G3 judgment 錨點式增量更新：純函式判斷 + 經 regenerateEntityOverviews 的整合。LLM 全部 stub。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');
const { seedFragment } = require('./_persona_helpers');

const dbPath = setupEnv('persona-judgment');
let restore, db, persona, llmReply = '', prompts = [];

const llm = require('../../services/llm');
llm.callLLM = async (messages) => { prompts.push(JSON.stringify(messages)); return { reply: llmReply }; };

before(() => {
    restore = quiet();
    require('../../database').initDatabase();
    db = require('../../database').getDb();
    require('os').freemem = () => 8 * 1024 * 1024 * 1024;
    persona = require('../../services/persona');
});
after(() => { restore(); cleanupDb(dbPath); });

const OLD = '我覺得阿明是個很可靠的朋友，遇到事情他總是第一個出現，讓人安心。';

describe('evaluateJudgmentUpdate（純判斷）', () => {
    test('小幅修改且有引用 → 接受', () => {
        const v = persona.evaluateJudgmentUpdate({ oldJudgment: OLD, newJudgment: OLD.replace('可靠', '很可靠'), citedIds: [{ type: 'fragment', id: 1 }] });
        assert.equal(v.accept, true);
        assert.equal(v.reason, 'ok');
        assert.ok(v.ratio > 0 && v.ratio < 0.4);
    });
    test('大改（差異 > 40%）→ 拒絕，即使有引用', () => {
        const v = persona.evaluateJudgmentUpdate({ oldJudgment: OLD, newJudgment: '其實我現在對阿明有點失望，他最近常常臨時取消約定，讓人很難再信任他了。', citedIds: [{ type: 'fragment', id: 1 }] });
        assert.deepEqual([v.accept, v.reason], [false, 'too_large']);
        assert.ok(v.ratio > 0.4);
    });
    test('有改動但沒有引用 → 拒絕', () => {
        const v = persona.evaluateJudgmentUpdate({ oldJudgment: OLD, newJudgment: OLD.replace('可靠', '很可靠'), citedIds: [] });
        assert.deepEqual([v.accept, v.reason], [false, 'no_citation']);
    });
    test('門檻可設定', () => {
        const nv = OLD.replace('可靠', '很可靠');
        const strict = persona.evaluateJudgmentUpdate({ oldJudgment: OLD, newJudgment: nv, citedIds: [{ id: 1 }], cfg: { persona: { judgment_max_change: 0.01 } } });
        assert.equal(strict.reason, 'too_large');
    });
    test('沒有舊版（含 NULL、「無」）→ 第一次形成，不受限制', () => {
        for (const old of [null, '', '無']) {
            assert.equal(persona.evaluateJudgmentUpdate({ oldJudgment: old, newJudgment: '全新的看法，寫得很長很長很長。', citedIds: [] }).accept, true);
        }
    });
    test('新版是「無」而舊版有內容 → 不允許抹掉；完全相同（含簡繁差異）→ 視為沒變', () => {
        assert.deepEqual(persona.evaluateJudgmentUpdate({ oldJudgment: OLD, newJudgment: '無', citedIds: [{ id: 1 }] }).reason, 'blank_replace');
        assert.equal(persona.evaluateJudgmentUpdate({ oldJudgment: OLD, newJudgment: OLD, citedIds: [] }).reason, 'unchanged');
        assert.equal(persona.evaluateJudgmentUpdate({ oldJudgment: '我喜歡這個朋友', newJudgment: '我喜欢这个朋友', citedIds: [] }).reason, 'unchanged');
    });
    test('resolveCitedIds：素材編號對應到真實 id，越界與無效編號略過、去重', () => {
        const items = [{ id: 11, source: 'fragment' }, { id: 22, source: 'episode' }, { source: 'fragment' }];
        assert.deepEqual(persona.resolveCitedIds([1, 2, 2, 3, 9, 0, 'x', 1.5], items), [{ type: 'fragment', id: 11 }, { type: 'episode', id: 22 }]);
        assert.deepEqual(persona.resolveCitedIds(null, items), []);
    });
    test('editDistance：基本案例', () => {
        assert.equal(persona.editDistance('kitten', 'sitting'), 3);
        assert.equal(persona.editDistance('', 'abc'), 3);
        assert.equal(persona.editDistance('你好嗎', '你好嗎'), 0);
    });
});

describe('經 regenerateEntityOverviews 的整合', () => {
    let entityId, fragIds;
    const reply = (judgment, evidence) => {
        const meta = { facts: '阿明是使用者的朋友。', current_status: '無明顯變化', judgment, judgment_evidence: evidence, talking_points: [], aliases: ['阿明', '明哥'], tags: ['朋友', '同學'], entity_type: 'person' };
        return `阿明是使用者的朋友，我覺得他很可靠，讓人放心。\n\n[依據: 1,2]\n\n${JSON.stringify(meta)}`;
    };
    const setup = (name) => {
        const { sealField } = require('../../services/memoryCrypto');
        entityId = Number(db.prepare(`INSERT INTO entity_profiles (name, category, status, facts, judgment, aliases, tags, fragment_count, last_eval_frag_count)
            VALUES (?, 'person', 'active', ?, ?, '["阿明"]', '["朋友"]', 3, 0)`).run(name, sealField('entity_profiles', 'facts', '舊事實'), sealField('entity_profiles', 'judgment', OLD)).lastInsertRowid);
        fragIds = [1, 2, 3].map(i => seedFragment(db, `${name}的事${i}`, `2026-09-0${i} 10:00:00`));
        for (const f of fragIds) db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id) VALUES (?, ?)').run(f, entityId);
    };
    const judgmentNow = () => db.prepare('SELECT judgment FROM entity_profiles WHERE id = ?').get(entityId).judgment;
    const run = async (judgment, evidence) => {
        db.prepare("UPDATE entity_profiles SET last_eval_frag_count = 0, overview_updated_at = NULL WHERE id = ?").run(entityId);
        llmReply = reply(judgment, evidence);
        prompts = [];
        return require('../../services/archivist').regenerateEntityOverviews();
    };

    test('提示詞把舊 judgment 當錨點，並要求小幅修改與引用素材編號', async () => {
        setup('阿明');
        await run(OLD, []);
        assert.ok(prompts[0].includes('Judgment 是錨點'));
        assert.ok(prompts[0].includes('judgment_evidence'));
        assert.ok(prompts[0].includes(OLD));
    });
    test('小幅修改 + 引用有效素材 → 接受，舊版存進歷史', async () => {
        const nv = OLD.replace('可靠', '很可靠');
        await run(nv, [1, 2]);
        assert.equal(judgmentNow(), nv);
        const hist = persona.getJudgmentHistory(entityId);
        assert.equal(hist.length, 1);
        assert.equal(hist[0].judgment, OLD);
        assert.equal(hist[0].reason, 'replaced');
    });
    test('大改 → 保留舊版並記一筆事件；歷史不增加', async () => {
        const before = judgmentNow();
        await run('我現在對阿明有點失望，他最近常常臨時取消約定，很難再信任他了，真的讓我很難過。', [1, 2]);
        assert.equal(judgmentNow(), before);
        const ev = persona.listPersonaEvents({ kind: 'judgment_rejected' });
        assert.equal(ev.length, 1);
        assert.equal(ev[0].detail.reason, 'too_large');
        assert.equal(ev[0].detail.entity_id, entityId);
        assert.equal(persona.getJudgmentHistory(entityId).length, 1);
    });
    test('沒有引用（或引用越界）→ 保留舊版並記事件', async () => {
        const before = judgmentNow();
        await run(before.replace('安心', '很安心'), []);
        await run(before.replace('安心', '很安心'), [99]);
        assert.equal(judgmentNow(), before);
        const reasons = persona.listPersonaEvents({ kind: 'judgment_rejected' }).map(e => e.detail.reason);
        assert.deepEqual(reasons.slice(0, 2), ['no_citation', 'no_citation']);
    });
    test('新版是「無」→ 不會把已有的印象抹掉', async () => {
        const before = judgmentNow();
        await run('無', [1]);
        assert.equal(judgmentNow(), before);
    });
    test('第一次形成（judgment 為 NULL）不受限制，「無」照舊寫入作為已嘗試標記', async () => {
        setup('小華');
        db.prepare('UPDATE entity_profiles SET judgment = NULL WHERE id = ?').run(entityId);
        await run('無', []);
        assert.equal(judgmentNow(), '無');
        assert.equal(persona.getJudgmentHistory(entityId).length, 0);
    });
});
