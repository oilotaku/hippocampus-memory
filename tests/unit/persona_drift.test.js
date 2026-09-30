'use strict';
// G3 漂移偵測：錨點、相似度比較（嵌入／Jaccard 退回）、回滾、開關、每日維護整合。LLM 與嵌入全部 stub。
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');
const { seedQualifiedTrait } = require('./_persona_helpers');

const dbPath = setupEnv('persona-drift');
let restore, db, persona;
const CORE = '你是一個溫柔的夥伴，說話簡短。{{CORE_INSIGHT}}';
const PROBES = ['你會怎麼安慰一個考試失利的朋友？', '你怎麼看待說謊？'];
const OFF = { persona: { auto_apply: false } };

// 依系統提示是否帶 <relationship_context> 決定回答；answers.anchor / answers.full 可在各測試改
let answers, calls;
const callLLM = async (messages, sys) => {
    calls.push({ withRel: sys.includes('<relationship_context>'), q: messages[0].parts[0].text, sys });
    const key = sys.includes('<relationship_context>') ? 'full' : 'anchor';
    const a = typeof answers[key] === 'function' ? answers[key](calls.length) : answers[key];
    if (a instanceof Error) throw a;
    return { reply: a };
};
// 「冷淡」開頭的向量與其他文字正交；其餘同向
const embed = async (t) => (t.startsWith('冷淡') ? [0, 1] : [1, 0]);
const drift = (extra = {}) => persona.runDriftCheck({ coreText: CORE, probes: PROBES, callLLM, embed, configId: null, ...extra });

const reset = () => {
    for (const t of ['persona_proposals', 'persona_relationship_versions', 'persona_model', 'persona_events', 'persona_core_versions', 'user_model', 'memory_fragments']) db.prepare(`DELETE FROM ${t}`).run();
    answers = { anchor: '我會先抱抱他，告訴他沒關係。', full: '我會先抱抱他，告訴他沒關係。' };
    calls = [];
};
const applyTrait = (name) => {
    seedQualifiedTrait(db, name, 0.9);
    persona.generateProposals({ cfg: OFF });
    const p = persona.listProposals({ status: 'pending' }).find(x => x.content === name);
    persona.applyProposal(p.id);
    return p.id;
};

before(() => {
    restore = quiet();
    require('../../database').initDatabase();
    db = require('../../database').getDb();
    persona = require('../../services/persona');
});
after(() => { restore(); cleanupDb(dbPath); });
beforeEach(reset);

describe('錨點', () => {
    test('沒有關係層時只建立錨點（核心層回答）並回報 no_relationship；再跑一次不重新產生', async () => {
        const r = await drift();
        assert.equal(r.status, 'no_relationship');
        assert.equal(r.llmCalls, PROBES.length);
        assert.ok(calls.every(c => !c.withRel));
        assert.equal(persona.getAnchor(1).length, PROBES.length);
        assert.equal(persona.getCoreHistory()[0].anchor_method, 'core_only');
        calls = [];
        await drift();
        assert.equal(calls.length, 0, '錨點已存在，不該再呼叫 LLM');
    });
    test('錨點提示詞：核心層原文（拿掉洞察占位）、不含關係層', async () => {
        await drift();
        assert.ok(calls[0].sys.includes('你是一個溫柔的夥伴'));
        assert.ok(!calls[0].sys.includes('{{CORE_INSIGHT}}'));
        assert.ok(!calls[0].sys.includes('<relationship_context>'));
    });
    test('核心層改了 → 新版本要重新產生錨點', async () => {
        await drift();
        calls = [];
        await drift({ coreText: CORE + '你也很愛開玩笑。' });
        assert.equal(persona.getCoreHistory().length, 2);
        assert.equal(calls.length, PROBES.length);
        assert.ok(persona.getAnchor(2));
    });
    test('錨點產生失敗（LLM 掛了）→ no_anchor，不動任何東西', async () => {
        answers.anchor = new Error('LLM down');
        const r = await drift();
        assert.equal(r.status, 'no_anchor');
        assert.equal(persona.getAnchor(1), null);
    });
});

describe('相似度高 → 不動', () => {
    test('回答一致 → ok，目前版本標為通過，關係層不變', async () => {
        applyTrait('會先聽完再給建議');
        const r = await drift();
        assert.equal(r.status, 'ok');
        assert.equal(r.method, 'embedding');
        assert.ok(r.score >= 0.75);
        assert.equal(r.rechecked, false);
        assert.ok(calls.some(c => c.withRel), '完整人格的提示詞帶關係層');
        assert.deepEqual(persona.getActiveRelationship().lines, ['會先聽完再給建議']);
        assert.equal(persona.getActiveRelationship().drift_passed, 1);
        assert.equal(persona.listPersonaEvents({ kind: 'drift_ok' }).length, 1);
    });
});

describe('相似度低 → 回滾到上一個通過的版本', () => {
    test('漂移：關係層回到通過的舊版，提案標 rolled_back，記事件', async () => {
        applyTrait('穩定特質');
        await drift();                                    // 建立錨點 + 通過，v1 標為通過
        const badId = applyTrait('讓人變冷淡的特質');       // v2，未檢查
        answers.full = '冷淡地說：那是你自己的事。';
        const r = await drift();
        assert.equal(r.status, 'drifted');
        assert.equal(r.rechecked, true);
        assert.ok(r.score < 0.75);
        assert.deepEqual(persona.getActiveRelationship().lines, ['穩定特質']);
        assert.equal(persona.getProposal(badId).status, 'rolled_back');
        assert.equal(persona.listRelationshipVersions()[0].source, 'drift_rollback');
        const ev = persona.listPersonaEvents({ kind: 'drift_detected' })[0].detail;
        assert.equal(ev.rollback.restored_from, 1);
        assert.equal(ev.method, 'embedding');
        // 回滾後再檢查應通過
        answers.full = answers.anchor;
        assert.equal((await drift()).status, 'ok');
    });
    test('沒有通過過的舊版 → 回到空白關係層（出廠狀態）', async () => {
        const id = applyTrait('第一項就漂移');
        answers.full = '冷淡地說：關我什麼事。';
        const r = await drift();                          // 錨點與比較在同一次執行
        assert.equal(r.status, 'drifted');
        assert.equal(r.rollback.restored_from, 0);
        assert.deepEqual(persona.getActiveRelationship().lines, []);
        assert.equal(persona.getProposal(id).status, 'rolled_back');
        assert.equal(db.prepare("SELECT content FROM persona_model WHERE section = 'relationship'").get().content, '');
    });
    test('確認機制：第一輪隨機偏低、第二輪正常 → 不回滾，取較高的一輪', async () => {
        applyTrait('穩定特質');
        await drift();
        let n = 0;
        answers.full = () => (n++ < PROBES.length ? '冷淡地帶過。' : '我會先抱抱他，告訴他沒關係。');
        const r = await drift();
        assert.equal(r.status, 'ok');
        assert.equal(r.rechecked, true);
        assert.ok(r.first_score < 0.75 && r.score >= 0.75);
        assert.deepEqual(persona.getActiveRelationship().lines, ['穩定特質']);
    });
    test('drift_samples 多次取樣：呼叫次數 = 探針數 × 取樣數（平均降低隨機性）', async () => {
        applyTrait('穩定特質');
        await drift();
        calls = [];
        const r = await drift({ cfg: { persona: { drift_samples: 3 } } });
        assert.equal(r.status, 'ok');
        assert.equal(calls.filter(c => c.withRel).length, PROBES.length * 3);
    });
});

describe('開關與降級', () => {
    test('drift_check=false → 完全不執行（連錨點都不產生、不呼叫 LLM）', async () => {
        applyTrait('穩定特質');
        const r = await drift({ cfg: { persona: { drift_check: false } } });
        assert.equal(r.status, 'disabled');
        assert.equal(calls.length, 0);
        assert.equal(persona.getAnchor(1), null);
    });
    test('嵌入不可用（拋錯）→ 退回兩字組 Jaccard，用 Jaccard 專屬門檻', async () => {
        applyTrait('穩定特質');
        const bad = async () => { throw new Error('chroma down'); };
        const ok = await drift({ embed: bad });
        assert.equal(ok.status, 'ok');
        assert.equal(ok.method, 'jaccard');
        assert.equal(ok.threshold, 0.2);
        assert.ok(ok.score > 0.99);
        // 完全不同的文字 → Jaccard 也低 → 漂移
        applyTrait('另一項特質');
        answers.full = 'zzzz qqqq 完全無關的一段話啊啊啊';
        const drifted = await drift({ embed: bad });
        assert.equal(drifted.status, 'drifted');
        assert.equal(drifted.method, 'jaccard');
        assert.deepEqual(persona.getActiveRelationship().lines, ['穩定特質']);
    });
    test('嵌入回傳無效向量也退回 Jaccard', async () => {
        applyTrait('穩定特質');
        const r = await drift({ embed: async () => null });
        assert.equal(r.method, 'jaccard');
    });
    test('未注入 embed 時用 memory.getLocalEmbedding；它失敗就退回 Jaccard', async () => {
        applyTrait('穩定特質');
        const memory = require('../../services/memory');
        const orig = memory.getLocalEmbedding;
        memory.getLocalEmbedding = async () => { throw new Error('offline'); };
        try {
            const r = await persona.runDriftCheck({ coreText: CORE, probes: PROBES, callLLM, configId: null });
            assert.equal(r.method, 'jaccard');
            assert.equal(r.status, 'ok');
        } finally { memory.getLocalEmbedding = orig; }
    });
    test('完整人格回答大多失敗 → llm_unavailable，不回滾', async () => {
        applyTrait('穩定特質');
        await drift();
        answers.full = new Error('LLM down');
        const r = await drift();
        assert.equal(r.status, 'llm_unavailable');
        assert.deepEqual(persona.getActiveRelationship().lines, ['穩定特質']);
    });
    test('簡繁並存：簡體回答與繁體錨點的 Jaccard 視為相同', async () => {
        applyTrait('穩定特質');
        answers.anchor = '我會先抱抱他，告訴他沒關係，然後陪他把問題整理清楚。';
        answers.full = '我会先抱抱他，告诉他没关系，然后陪他把问题整理清楚。';
        const r = await drift({ embed: null });
        assert.equal(r.method, 'jaccard');
        assert.ok(r.score > 0.99);
    });
});

describe('每日維護 runPersonaMaintenance', () => {
    test('依序：核心版本 → 產生提案 → 自動套用 → 漂移偵測；回傳 llmCalls', async () => {
        seedQualifiedTrait(db, '愛喝熱茶', 0.9);
        const r = await persona.runPersonaMaintenance({ cfg: { persona: { auto_apply: true } }, coreText: CORE, probes: PROBES, callLLM, embed, configId: null });
        assert.equal(r.core.version, 1);
        assert.equal(r.proposalsCreated, 1);
        assert.equal(r.proposalsApplied, 1);
        assert.equal(r.drift, 'ok');
        assert.equal(r.llmCalls, PROBES.length * 2);          // 錨點 + 完整人格
        assert.deepEqual(persona.getActiveRelationship().lines, ['愛喝熱茶']);
    });
    test('drift_check=false 且 auto_apply=false：只產生提案，不套用、不呼叫 LLM', async () => {
        seedQualifiedTrait(db, '愛喝熱茶', 0.9);
        const r = await persona.runPersonaMaintenance({ cfg: { persona: { auto_apply: false, drift_check: false } }, coreText: CORE, probes: PROBES, callLLM, embed, configId: null });
        assert.equal(r.proposalsCreated, 1);
        assert.equal(r.proposalsApplied, 0);
        assert.equal(r.drift, 'disabled');
        assert.equal(r.llmCalls, 0);
        assert.equal(calls.length, 0);
    });
    test('探針檔（probes.json）是繁體、5～8 題', () => {
        const probes = persona.loadProbes();
        assert.ok(probes.length >= 5 && probes.length <= 8);
        assert.ok(probes.every(q => typeof q === 'string' && q.endsWith('？')));
    });
});
