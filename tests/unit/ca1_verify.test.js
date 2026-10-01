'use strict';
// CA1 比對器（recall.verify）：細節判斷、判定解析、核對說明、超時與失敗略過、接進檢索管線。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('ca1verify');
let restore, db, G, pipeline, V;
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    const mem = require('../../services/memory');
    mem.searchMemoriesByVector = async () => [];
    const wm = require('../../services/workingMemory');
    wm.getBoostMap = async () => new Map();
    wm.getRecentFragments = () => [];
    wm.updatePool = () => {};
    wm.touchPool = () => 0;
    G = require('../../services/recallGate');
    pipeline = require('../../services/recallPipeline');
    V = require('../../services/hippocampus/ca1/verify');
});
after(() => { restore(); cleanupDb(dbPath); });

const addFrag = (content) => Number(db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, status, created_at, source_date)
    VALUES ('event', 'X', ?, 0.4, 'chat', 'active', datetime('now'), '2026-09-20')`).run(content).lastInsertRowid);
const reply = (obj) => async () => ({ reply: JSON.stringify(obj) });

describe('hasConcreteDetail', () => {
    test('星期、日期、數字、時間詞 → 需要核對', () => {
        for (const s of ['怡君週五去哪打羽球？', '媽媽生日是3月8日嗎', '下午三點的約在哪', '星期六要做什麼', '去年去了哪裡']) {
            assert.equal(V.hasConcreteDetail(s), true, s);
        }
    });
    test('沒有具體細節的閒聊 → 不核對', () => {
        for (const s of ['你好嗎', '最近心情怎麼樣', '在做什麼呀']) assert.equal(V.hasConcreteDetail(s), false, s);
    });
});

describe('parseVerdict 與 buildCheckNote', () => {
    test('合法判定解析；夾雜文字也能取出；非法判定回 null', () => {
        assert.equal(V.parseVerdict('{"verdict":"supported","mismatches":[]}').verdict, 'supported');
        assert.equal(V.parseVerdict('結果如下：```json\n{"verdict":"unknown","missing":"週五"}\n```').missing, '週五');
        assert.equal(V.parseVerdict('{"verdict":"maybe"}'), null);
        assert.equal(V.parseVerdict('不是 JSON'), null);
    });
    test('contradicted 列出不符細節；unknown 提示不要猜；supported 不附說明', () => {
        const c = V.buildCheckNote({ verdict: 'contradicted', mismatches: [{ asked: '週五', memory: '週三', memory_id: 12 }], missing: '' });
        assert.match(c, /<memory_check>[\s\S]*「週五」[\s\S]*「週三」（#12）[\s\S]*沒有提到/);
        assert.match(V.buildCheckNote({ verdict: 'unknown', mismatches: [], missing: '週五的羽球' }), /沒有提到「週五的羽球」/);
        assert.equal(V.buildCheckNote({ verdict: 'supported', mismatches: [], missing: '' }), '');
    });
});

describe('verifyRecall', () => {
    const items = [{ id: 1, content: '怡君每週三晚上在三重運動中心打羽球', source_date: '2026-09-01' }];
    test('呼叫模型時溫度 0，回傳判定與說明', async () => {
        let gen;
        const res = await V.verifyRecall('怡君週五在哪打羽球', items, {
            callLLM: async (_m, _s, _t, g) => { gen = g; return { reply: '{"verdict":"contradicted","mismatches":[{"asked":"週五","memory":"週三","memory_id":1}]}' }; },
        });
        assert.equal(gen.temperature, 0);
        assert.equal(res.verdict, 'contradicted');
        assert.match(res.note, /週三/);
    });
    test('模型出錯、回覆無法解析、逾時 → null（不擋回覆）', async () => {
        assert.equal(await V.verifyRecall('週五', items, { callLLM: async () => { throw new Error('down'); } }), null);
        assert.equal(await V.verifyRecall('週五', items, { callLLM: async () => ({ reply: '???' }) }), null);
        const slow = () => new Promise(r => setTimeout(() => r({ reply: '{"verdict":"supported"}' }), 3000));
        assert.equal(await V.verifyRecall('週五', items, { callLLM: slow, timeoutMs: 50 }), null);
    });
    test('沒有記憶就不呼叫模型', async () => {
        let called = false;
        assert.equal(await V.verifyRecall('週五', [], { callLLM: async () => { called = true; return { reply: '' }; } }), null);
        assert.equal(called, false);
    });
});

describe('接進檢索管線（buildGatedMemory）', () => {
    test('verify 開啟且問題有具體細節：不符時附上 <memory_check>，回傳 check', async () => {
        addFrag('怡君每週三晚上在三重運動中心打羽球');
        const r = await pipeline.buildGatedMemory('怡君週五晚上在哪裡打羽球？', {
            cfg: G.getRecallConfig({ recall: { verify: true } }), db, now: NOW,
            callLLM: reply({ verdict: 'contradicted', mismatches: [{ asked: '週五', memory: '週三' }] }),
        });
        assert.ok(r.injected.length >= 1);
        assert.equal(r.check.verdict, 'contradicted');
        assert.match(r.parts.join('\n'), /<memory_check>[\s\S]*週三/);
    });
    test('記憶相符（supported）時不附任何說明', async () => {
        const r = await pipeline.buildGatedMemory('怡君週三晚上在哪裡打羽球？', {
            cfg: G.getRecallConfig({ recall: { verify: true } }), db, now: NOW + 3600000,
            callLLM: reply({ verdict: 'supported', mismatches: [] }),
        });
        assert.equal(r.check.verdict, 'supported');
        assert.doesNotMatch(r.parts.join('\n'), /memory_check/);
    });
    test('verify 關閉（預設）不呼叫核對', async () => {
        let called = false;
        const r = await pipeline.buildGatedMemory('怡君週五晚上在哪裡打羽球？', {
            cfg: G.getRecallConfig({ recall: {} }), db, now: NOW + 7200000,
            callLLM: async () => { called = true; return { reply: '{"verdict":"unknown"}' }; },
        });
        assert.equal(called, false);
        assert.equal(r.check, null);
        assert.equal(G.getRecallConfig({ recall: {} }).verify, false);
    });
});
