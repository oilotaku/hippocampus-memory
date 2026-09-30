'use strict';
// W7 拆分安全網：services/cognitiveModel.js 的特性測試。
// 1) 信心度加減與上下限、假設升級、current_state 到期等明確斷言；
// 2) 一段固定情境（播種 → 逐一呼叫匯出函式）的完整指紋，與
//    tests/unit/fixtures/cognitiveModel_scenario.json 比對（拆分前錄製）。
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb } = require('./_helpers');
const { captureConsole, llmRecord, dumpTables, checkFingerprint, normValue } = require('./_fingerprint');

const dbPath = setupEnv('cogmodel-char');
const logs = [];
const llmCalls = [];
let restore, db, cm, USER, AI;
let llmReply = '[]';

before(() => {
    restore = captureConsole(logs);
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    const memory = require('../../services/memory');
    memory.chromaDBOperation = async () => ({});
    memory.searchMemoriesByVector = async () => [];
    require('../../services/llm').callLLM = async (...args) => { llmCalls.push(llmRecord(args)); return { reply: llmReply }; };
    ({ USER, AI } = require('../../services/memoryConfig'));
    cm = require('../../services/cognitiveModel');
});
after(() => { restore(); cleanupDb(dbPath); });

const getE = (id) => db.prepare('SELECT * FROM user_model WHERE id = ?').get(id);
const frag = (content, ago = '-1 days', msgs = '[]') => Number(db.prepare(
    "INSERT INTO memory_fragments (type, entity, content, created_at, source_msg_ids) VALUES ('event', 'X', ?, datetime('now', ?), ?)").run(content, ago, msgs).lastInsertRowid);

describe('cognitiveModel 明確規則', () => {
    beforeEach(() => { db.exec('DELETE FROM user_model; DELETE FROM memory_fragments;'); });

    test('createEntry：inferred 上限 0.70、direct_statement +0.15 且依類型封頂、decay_type 推定', () => {
        const a = cm.createEntry('stable_trait', '喜歡拉麵', { confidence: 0.9 });
        assert.equal(getE(a).confidence, 0.7);
        assert.equal(getE(a).decay_type, 'evidence_dependent');
        const b = cm.createEntry('stable_trait', '住在台北', { confidence: 0.8, source_quality: 'direct_statement' });
        assert.equal(getE(b).confidence, 0.85);
        const c = cm.createEntry('immutable_fact', '生日在三月', { confidence: 0.9, source_quality: 'direct_statement' });
        assert.equal(getE(c).confidence, 0.99);
        assert.equal(getE(c).decay_type, 'none');
        const d = cm.createEntry('current_state', '最近很忙', { confidence: 0.5, source_quality: 'backfilled' });
        assert.equal(getE(d).confidence, 0.5);
        assert.equal(getE(d).decay_type, 'exponential');
    });

    test('addEvidence：確認加分封頂、反證扣分保底並標 needs_review', () => {
        const t = cm.createEntry('stable_trait', '喜歡拉麵', { confidence: 0.78 });
        const f1 = frag('又吃拉麵', '-3 days');
        let r = cm.addEvidence(t, f1, true);
        assert.equal(r.upgraded, false);
        assert.equal(getE(t).confidence, 0.75);   // 0.70 起跳 + 0.05（第一筆證據＝獨立來源）
        const f2 = frag('再吃拉麵', '-2 days');
        cm.addEvidence(t, f2, true);
        assert.equal(getE(t).confidence, 0.8);    // 封頂 0.80
        const f3 = frag('說不想吃拉麵了', '-1 days');
        cm.addEvidence(t, f3, false);
        const e = getE(t);
        assert.equal(Math.round(e.confidence * 100), 68);   // 0.80 - 0.12
        assert.ok(JSON.parse(e.tags).includes('needs_review'));
        assert.equal(e.evidence_count, 3);
        assert.equal(JSON.parse(e.evolution_history).filter(h => h.type === 'contradiction').length, 1);
        assert.equal(cm.addEvidence(999999, f1, true), null);
    });

    test('addEvidence：假設在 3 個獨立來源且信心 ≥0.70 時升級為特質', () => {
        const h = cm.createEntry('active_hypothesis', '可能在準備考試', { confidence: 0.5 });
        let last;
        for (let i = 0; i < 3; i++) last = cm.addEvidence(h, frag('讀書' + i, `-${5 - i} days`), true, { sourceMsgIds: [100 + i * 10] });
        assert.equal(last.upgraded, true);
        assert.equal(getE(h).type, 'stable_trait');
    });
});

describe('cognitiveModel 固定情境指紋（拆分前後必須完全相同）', () => {
    test('播種 → 逐一呼叫匯出函式 → 資料庫終態', async () => {
        db.exec('DELETE FROM user_model; DELETE FROM memory_fragments;');
        db.prepare("INSERT OR IGNORE INTO chats (id, name) VALUES (1, 'w7')").run();
        const msg = db.prepare("INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted) VALUES (1, ?, ?, datetime('now', ?), 0)");
        for (let i = 0; i < 60; i++) msg.run(i % 3 === 2 ? 'ai' : 'user', `第${i}句：最近工作很累，週末想去吃拉麵放鬆`, `-${(i + 1) * 10} minutes`);
        for (const [n, c] of [[USER.name, 'person'], [AI.name, 'person'], ['阿明', 'person'], ['一蘭拉麵', 'place']]) {
            db.prepare("INSERT INTO entity_profiles (name, category, status, fragment_count, current_status) VALUES (?, ?, 'active', 3, '最近在忙專案')").run(n, c);
        }
        const fids = [];
        for (let i = 0; i < 8; i++) fids.push(frag(['最近工作很累', '週末去吃拉麵', '阿明說專案上線了', '睡不好覺', '喜歡豚骨湯頭', '準備考證照', '每天讀書兩小時', '考試快到了'][i], `-${i + 1} days`, `[${i + 1}]`));
        const ins = db.prepare(`INSERT INTO user_model (type, content, confidence, decay_type, evidence_count, last_evidence_at, status, tags, evolution_history, created_at, updated_at, expires_at, source_fragment_ids, created_by)
            VALUES (?, ?, ?, ?, ?, datetime('now', ?), 'active', ?, ?, datetime('now', ?), datetime('now', ?), ?, ?, ?)`);
        ins.run('stable_trait', '喜歡吃拉麵', 0.6, 'evidence_dependent', 3, '-2 days', '[]', '[]', '-30 days', '-2 days', null, `[${fids[1]}]`, 'deep_cycle');
        ins.run('stable_trait', '工作壓力大', 0.55, 'evidence_dependent', 2, '-40 days', '["needs_review"]',
            JSON.stringify([{ type: 'contradiction', at: '2026-01-01 00:00:00' }, { type: 'contradiction', at: '2026-01-02 00:00:00' }, { type: 'contradiction', at: '2026-01-03 00:00:00' }]), '-60 days', '-40 days', null, '[]', 'deep_cycle');
        ins.run('current_state', '最近睡不好', 0.6, 'exponential', 1, '-20 days', '[]', '[]', '-20 days', '-20 days', null, `[${fids[3]}]`, 'chat_companion');
        ins.run('current_state', '這週在趕報告', 0.7, 'exponential', 1, '-3 days', '[]', '[]', '-3 days', '-3 days', '2020-01-01 00:00:00', '[]', 'chat_companion');
        ins.run('active_hypothesis', '可能在準備考試', 0.5, 'evidence_dependent', 1, '-20 days', '[]', '[]', '-25 days', '-20 days', null, `[${fids[5]}]`, 'deep_cycle');
        ins.run('active_hypothesis', '可能想換工作', 0.4, 'evidence_dependent', 0, '-2 days', '[]', '[]', '-2 days', '-2 days', null, '[]', 'deep_cycle');
        ins.run('immutable_fact', '住在台北', 0.95, 'none', 5, '-10 days', '[]', '[]', '-90 days', '-10 days', null, '[]', 'deep_cycle');

        const fp = {};
        const step = async (name, fn) => {
            logs.length = 0; llmCalls.length = 0;
            let result;
            try { result = { ok: normValue(await fn()) }; } catch (e) { result = { threw: normValue(e) }; }
            fp[name] = { result, llm: [...llmCalls], logs: [...logs] };
        };
        await step('getModelContext', () => cm.getModelContext());
        await step('getWhisperRelevant', () => cm.getWhisperRelevant());
        await step('matchEvidenceFromFragments', () => cm.matchEvidenceFromFragments());
        await step('harvestFacts', () => cm.harvestFacts());
        await step('bridgeStarMapToModel', () => cm.bridgeStarMapToModel());
        await step('processModelDecay', () => cm.processModelDecay());
        await step('resolveExpiredStates', () => cm.resolveExpiredStates());
        await step('validateHypotheses', () => cm.validateHypotheses());
        await step('detectNewTraits', () => cm.detectNewTraits());
        await step('reviewFlaggedTraits', () => cm.reviewFlaggedTraits());
        await step('reviewStableTraits', () => cm.reviewStableTraits());
        await step('seedAnchorOrphanEntries', () => cm.seedAnchorOrphanEntries());
        await step('anchorEntriesToFragments', () => cm.anchorEntriesToFragments());
        await step('integrateProfileTraits', () => cm.integrateProfileTraits());
        await step('detectModelOverlaps', () => cm.detectModelOverlaps());
        await step('crossRefStateWithEntities', () => cm.crossRefStateWithEntities());
        await step('synthesizeCoreInsight', () => cm.synthesizeCoreInsight());
        await step('seedFromExisting', () => cm.seedFromExisting());
        await step('backfillModelEvidence', () => cm.backfillModelEvidence());
        await step('readUserRawMessages', () => cm.readUserRawMessages());
        llmReply = '{}';
        await step('readUserRawMessages.obj', () => cm.readUserRawMessages());
        await step('synthesizeCoreInsight.obj', () => cm.synthesizeCoreInsight());
        llmReply = '[]';
        await step('runUserModelCycle', () => cm.runUserModelCycle());
        await step('manageCurrentState.create', () => cm.manageCurrentState('這週在準備簡報，壓力很大', { category: 'work', created_by: 'chat_companion', source_quality: 'direct_statement' }));
        await step('manageCurrentState.again', () => cm.manageCurrentState('這週在準備簡報，壓力很大', { category: 'work', created_by: 'deep_cycle' }));
        await step('resolveEntry', () => cm.resolveEntry(1, 'w7 測試'));
        await step('abandonEntry', () => cm.abandonEntry(6, 'w7 測試'));
        await step('supersedeEntry', () => cm.supersedeEntry(2, 1, 'w7'));
        await step('correctEntry', () => cm.correctEntry(7, '住在新北'));
        await step('updateEntry', () => cm.updateEntry(3, { content: '最近睡得比較好', confidence: 0.4 }));
        await step('mergeModelEntries', () => cm.mergeModelEntries(3, [4], '最近睡不好，也在趕報告'));
        await step('MIN_GAP_USER_MODEL', () => cm.MIN_GAP_USER_MODEL);

        fp.db = dumpTables(db, ['user_model', 'memory_fragments', 'entity_profiles', 'user_settings', 'user_patterns']);
        checkFingerprint('cognitiveModel_scenario', fp);
    });
});
