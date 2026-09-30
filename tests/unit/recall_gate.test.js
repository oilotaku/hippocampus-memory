'use strict';
// G1：取記憶時機閘門（services/recallGate.js、recallPipeline.js 與各處掛鉤）
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('recallgate');
let restore, db, G, lib, pipeline, mem, wm, lifecycle;
let vecResults = [];
let vecCalls = 0;
let poolStore = [];   // workingMemory 池（stub）
let touchCalls = 0;

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);   // 2026-09-30（週三）12:00 UTC
const DAY = 86400000;
const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const daysBefore = (d) => sql(NOW - d * DAY);

before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    mem = require('../../services/memory');
    mem.searchMemoriesByVector = async () => { vecCalls++; return vecResults; };
    wm = require('../../services/workingMemory');
    wm.getBoostMap = async () => new Map();
    wm.getRecentFragments = () => poolStore.slice();
    wm.updatePool = (frags) => { poolStore = frags.map(f => ({ id: f.id, content: f.content, source_table: f.source_table })); };
    wm.touchPool = () => { touchCalls++; return poolStore.length; };
    G = require('../../services/recallGate');
    lib = require('../../services/librarian');
    pipeline = require('../../services/recallPipeline');
    lifecycle = require('../../services/lifecycle');
});

after(() => {
    G.setRecallConfigOverride(undefined);
    restore();
    cleanupDb(dbPath);
});

beforeEach(() => {
    vecResults = [];
    vecCalls = 0;
    poolStore = [];
    touchCalls = 0;
    G.setRecallConfigOverride(undefined);
    pipeline.resetPipelineState();
    db.exec('DELETE FROM fragment_entities; DELETE FROM memory_fragments; DELETE FROM memories; DELETE FROM entity_profiles; DELETE FROM recall_surface_log; DELETE FROM recall_state;');
});

function addFrag({ content, ew = 0.5, created = daysBefore(0), injected = 0, read = 0, cited = 0, status = 'active' }) {
    return Number(db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, status, created_at, read_count, injected_count, cited_count)
        VALUES ('event', 'X', ?, ?, 'chat', ?, ?, ?, ?, ?)`).run(content, ew, status, created, read, injected, cited).lastInsertRowid);
}
const getF = (id) => db.prepare('SELECT * FROM memory_fragments WHERE id = ?').get(id);
const cfgOf = (recall) => G.getRecallConfig({ recall });

// ─────────────────────────────────────────────
describe('設定', () => {
    test('預設值與 gate 開關', () => {
        const c = G.getRecallConfig({});
        assert.equal(c.gate, true);
        assert.equal(c.candidate_k, 16);
        assert.equal(c.relative_cutoff, 0.5);
        assert.equal(c.surface_idle_hours, 6);
        assert.equal(c.surface_cooldown_days, 7);
        assert.equal(c.prospective_days, 7);
        assert.equal(c.hard_trigger_max, 3);
        assert.equal(G.getRecallConfig({ recall: { gate: false } }).gate, false);
        assert.equal(G.getRecallConfig(null).gate, true);
    });
    test('非法值回退預設；預算比例正規化為總和 1', () => {
        const c = cfgOf({ candidate_k: -3, relative_cutoff: 7, smalltalk_words: 'x', budget_share: { core: 3, retrieval: 5, extra: 2 } });
        assert.equal(c.candidate_k, 16);
        assert.equal(c.relative_cutoff, 0.5);
        assert.ok(Array.isArray(c.smalltalk_words) && c.smalltalk_words.length > 5);
        assert.deepEqual(c.budget_share, { core: 0.3, retrieval: 0.5, extra: 0.2 });
    });
});

// ─────────────────────────────────────────────
describe('要不要查（decideRecall）', () => {
    const cfg = G.getRecallConfig({});
    const ask = (msg, extra = {}) => G.decideRecall(msg, { cfg, db, now: NOW, ...extra });

    test('寒暄／附和／指令型短句不查（含簡體）', () => {
        for (const m of ['好', '嗯嗯', '謝謝', '谢谢', '晚安！', '好的，謝謝', 'ok', '哈哈哈', '幫我開燈', '帮我开灯', '打開電風扇', '關掉音樂', '播放音樂']) {
            const r = ask(m);
            assert.equal(r.retrieve, false, `${m} → ${r.reason}`);
        }
        assert.equal(ask('好').reason, 'smalltalk');
        assert.equal(ask('幫我開燈').reason, 'command');
    });

    test('極短且無線索不查；有問句／實體則要查', () => {
        assert.equal(ask('累').reason, 'too_short');
        assert.equal(ask('累了').retrieve, false);
        assert.equal(ask('累嗎').retrieve, true);   // 問句
    });

    test('問句要查（中文問句詞、問號）', () => {
        for (const m of ['今天吃什麼', '他是誰', '那家店在哪', '花了多少', '你覺得呢', '真的嗎', '为什么会这样']) {
            const r = ask(m);
            assert.equal(r.retrieve, true, `${m} → ${r.reason}`);
        }
        assert.equal(ask('好?').retrieve, true);
    });

    test('指涉線索要查（簡繁皆可）', () => {
        for (const m of ['上次那個很好吃', '还记得吗', '之前說的那件事', '記得那天嗎']) {
            const r = ask(m);
            assert.equal(r.retrieve, true, m);
        }
        assert.equal(ask('上次去了哪').reason, 'cue');
    });

    test('含已知實體名或別名要查（實體名簡繁皆可，且優先於寒暄／指令）', () => {
        db.prepare("INSERT INTO entity_profiles (name, category, status, aliases) VALUES (?, 'person', 'active', ?)").run('阿明', JSON.stringify(['明哥']));
        db.prepare("INSERT INTO entity_profiles (name, category, status, aliases) VALUES (?, 'place', 'active', '[]')").run('車站小吃');
        assert.equal(ask('阿明').reason, 'entity');
        assert.equal(ask('謝謝明哥').reason, 'entity');
        assert.equal(ask('幫我打給阿明').retrieve, true);
        assert.equal(ask('车站小吃好好吃').reason, 'entity');      // 簡繁
        assert.equal(ask('今天去公園').retrieve, true);        // 無實體但長度夠 → default
        assert.equal(ask('今天去公園').reason, 'default');
    });

    test('classifyIntent 判為 long_term／summary／fact 者要查', () => {
        assert.equal(ask('最近怎樣', { intent: 'summary' }).retrieve, true);
        assert.equal(ask('累', { intent: 'fact' }).reason, 'intent:fact');
    });

    test('同話題延續：沿用工作記憶、不重查；超時、池空、線索都會破例', () => {
        const prevMsg = '昨天去京都旅行住了旅館';
        const prev = { at: NOW - 5 * 60000, bigrams: G.bigramSet(prevMsg), retrieved: true };
        const msg = '京都旅行的旅館很舒服';
        const r = ask(msg, { prev, poolSize: 3 });
        assert.equal(r.retrieve, false);
        assert.equal(r.continuation, true);
        assert.equal(r.reason, 'continuation');
        // 隔太久
        assert.equal(ask(msg, { prev: { ...prev, at: NOW - 40 * 60000 }, poolSize: 3 }).retrieve, true);
        // 工作記憶是空的（沒東西可沿用）
        assert.equal(ask(msg, { prev, poolSize: 0 }).retrieve, true);
        // 上一則本身沒查
        assert.equal(ask(msg, { prev: { ...prev, retrieved: false }, poolSize: 3 }).retrieve, true);
        // 話題不同
        assert.equal(ask('明天下午要開會準備簡報', { prev, poolSize: 3 }).retrieve, true);
        // 明說回想 → 不延續
        assert.equal(ask('還記得京都旅行嗎', { prev, poolSize: 3 }).retrieve, true);
        // 簡體同話題也算
        assert.equal(ask('京都旅行的旅馆很舒服', { prev, poolSize: 3 }).continuation, true);
    });
});

// ─────────────────────────────────────────────
describe('動態 k 與預算', () => {
    const mk = (...scores) => scores.map((s, i) => ({ id: i + 1, content: 'x'.repeat(40), _rrf: s }));
    test('只留 ≥ 第一名 × 門檻；分布不同保留數不同', () => {
        assert.equal(G.selectDynamicK(mk(1, 0.9, 0.6, 0.4, 0.1), { relativeCutoff: 0.5, maxK: 8 }).length, 3);
        assert.equal(G.selectDynamicK(mk(1, 0.2, 0.1), { relativeCutoff: 0.5, maxK: 8 }).length, 1);
        assert.equal(G.selectDynamicK(mk(1, 0.95, 0.9, 0.85, 0.8, 0.75), { relativeCutoff: 0.5, maxK: 4 }).length, 4);
        assert.equal(G.selectDynamicK(mk(1, 0.5), { relativeCutoff: 0.5, maxK: 8 }).length, 2);   // 剛好等於門檻保留
        assert.deepEqual(G.selectDynamicK([], {}), []);
        assert.equal(G.selectDynamicK(mk(0, 0), { relativeCutoff: 0.5, maxK: 8 }).length, 2);   // 第一名為 0 時不做相對比較
    });
    test('預算拆分：30/50/20，總和不變', () => {
        assert.deepEqual(G.splitBudget(1200, { core: 0.3, retrieval: 0.5, extra: 0.2 }), { core: 360, extra: 240, retrieval: 600 });
        const s = G.splitBudget(1001, { core: 0.3, retrieval: 0.5, extra: 0.2 });
        assert.equal(s.core + s.retrieval + s.extra, 1001);
    });
    test('管線：檢索份額不足時整條丟棄，不切在單條中間', async () => {
        for (let i = 0; i < 6; i++) addFrag({ content: `拉麵店的第${i}次拜訪記錄${'很好吃'.repeat(20)}`, ew: 0.9 });
        // 總預算 100 → 檢索份額 50 token（每條約 ≥ 25 token）→ 最多 1~2 條，且每條完整
        const r = await pipeline.buildGatedMemory('拉麵店的拜訪記錄怎麼樣', { budget: 100, cfg: cfgOf({}), db, now: NOW });
        const ctx = r.parts.join('\n');
        const shown = (ctx.match(/拉麵店的第\d次拜訪記錄/g) || []).length;
        assert.ok(shown >= 1 && shown < 6, `顯示 ${shown} 條`);
        assert.equal(shown, r.injected.length);
    });
});

// ─────────────────────────────────────────────
describe('injected_count／cited_count', () => {
    test('注入累加 injected_count（同時保留 read_count 相容），cited_count 不動', async () => {
        const id = addFrag({ content: '阿明去京都旅遊訂了旅館' });
        vecResults = [];
        const r = await pipeline.buildGatedMemory('阿明去京都旅遊的旅館', { cfg: cfgOf({}), db, now: NOW });
        assert.ok(r.injected.some(x => x.id === id));
        const f = getF(id);
        assert.equal(f.injected_count, 1);
        assert.equal(f.read_count, 1);
        assert.equal(f.cited_count, 0);
    });
    test('markCited：只算碎片、去重、寫 last_accessed_at', () => {
        const id = addFrag({ content: '某事' });
        const n = G.markCited([{ id, source_table: 'fragment' }, { id, source_table: 'fragment' }, { id: 999, source_table: 'memory' }], db);
        assert.equal(n, 1);
        const f = getF(id);
        assert.equal(f.cited_count, 1);
        assert.equal(f.injected_count, 0);
        assert.ok(f.last_accessed_at);
    });
    test('markCitedFromReply：回覆用到才算，沒用到不算（簡繁皆可）', () => {
        const a = addFrag({ content: '阿明去京都旅遊訂了旅館' });
        const b = addFrag({ content: '小華每週三固定去游泳' });
        const items = [{ id: a, source_table: 'fragment' }, { id: b, source_table: 'fragment' }];
        const cited = G.markCitedFromReply('聽說阿明去京都旅遊，還訂了旅館喔', items, { db });
        assert.deepEqual(cited, [a]);
        assert.equal(getF(a).cited_count, 1);
        assert.equal(getF(b).cited_count, 0);
        assert.deepEqual(G.markCitedFromReply('今天天氣很好', items, { db }), []);
        assert.deepEqual(G.markCitedFromReply('听说阿明去京都旅游，还订了旅馆哦', [items[0]], { db }), [a]);
    });
    test('recall_memory 工具取用 → cited_count（且同時是一次注入）', async () => {
        const id = addFrag({ content: '阿明去京都旅遊訂了旅館', ew: 0.8 });
        const tool = require('../../services/tools/memoryTools').find(t => t.name === 'recall_memory');
        const r = await tool.handler({ query: '京都旅遊' }, { chatId: null, lastUserMessage: '京都旅遊' });
        assert.ok(r.success);
        assert.match(r.formatted, /京都/);
        const f = getF(id);
        assert.equal(f.cited_count, 1);
        assert.equal(f.injected_count, 1);
    });
    test('novelty 看 injected_count：被注入多次的降權，只有 read_count 高（舊欄位）不影響', async () => {
        const hot = addFrag({ content: '蘋果 熱門', ew: 0.9, created: daysBefore(0.5), injected: 99 });
        const cold = addFrag({ content: '蘋果 冷門', ew: 0.9, created: daysBefore(0.5), injected: 0, read: 500 });
        const res = await lib.searchHybrid('蘋果多少', 8, { surface: 'none' });
        const h = res.find(r => r.id === hot), c = res.find(r => r.id === cold);
        assert.ok(h && c);
        assert.ok(Math.abs(h._novelty - 1 / 3) < 1e-3, `hot ${h._novelty}`);
        assert.equal(c._novelty, 1);
    });
    test('gate=false：novelty 沿用 read_count', async () => {
        G.setRecallConfigOverride({ recall: { gate: false } });
        const a = addFrag({ content: '蘋果 甲', ew: 0.9, created: daysBefore(0.5), injected: 0, read: 99 });
        const res = await lib.searchHybrid('蘋果多少', 8, { surface: 'none' });
        assert.ok(Math.abs(res.find(r => r.id === a)._novelty - 1 / 3) < 1e-3);
    });
    test('migration v113：injected_count 以 read_count 初始化、新欄位與新表存在', () => {
        const cols = db.prepare('PRAGMA table_info(memory_fragments)').all().map(c => c.name);
        assert.ok(cols.includes('injected_count') && cols.includes('cited_count'));
        assert.ok(db.prepare("SELECT 1 FROM schema_version WHERE version = 113").get());
        // 模擬舊資料庫：拿掉 v113 的產物、把 read_count 設好，再由另一個行程重跑 initDatabase
        const a = addFrag({ content: '舊資料甲', read: 5 });
        const b = addFrag({ content: '舊資料乙', read: 0 });
        db.exec('ALTER TABLE memory_fragments DROP COLUMN injected_count; ALTER TABLE memory_fragments DROP COLUMN cited_count; DROP TABLE recall_surface_log; DROP TABLE recall_state; DELETE FROM schema_version WHERE version = 113;');
        const r = spawnSync(process.execPath, ['-e', "require('./database').initDatabase()"], { cwd: path.join(__dirname, '..', '..'), env: process.env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(getF(a).injected_count, 5);
        assert.equal(getF(a).cited_count, 0);
        assert.equal(getF(b).injected_count, 0);
        assert.ok(db.prepare("SELECT 1 FROM schema_version WHERE version = 113").get());
        db.prepare("SELECT COUNT(*) FROM recall_surface_log").get();
        db.prepare("SELECT COUNT(*) FROM recall_state").get();
    });
});

// ─────────────────────────────────────────────
describe('lifecycle：續命看 cited_count 或近期存取', () => {
    test('只被注入過（read_count>0）但沒被引用、也沒有近期存取 → 仍會冷卻', async () => {
        const id = addFrag({ content: '舊事', created: daysBefore(100), read: 3, injected: 3 });
        await lifecycle.runFragmentGC();
        assert.equal(getF(id).status, 'cooling');
    });
    test('被引用過、或 14 天內有存取 → 不冷卻', async () => {
        const cited = addFrag({ content: '被引用', created: daysBefore(100), cited: 1 });
        const recent = addFrag({ content: '近期存取', created: daysBefore(100) });
        db.prepare("UPDATE memory_fragments SET last_accessed_at = datetime('now', '-3 days') WHERE id = ?").run(recent);
        await lifecycle.runFragmentGC();
        assert.equal(getF(cited).status, 'active');
        assert.equal(getF(recent).status, 'active');
    });
    test('冷卻中的碎片：被引用 → 復活；沒有 → 維持', async () => {
        const a = addFrag({ content: '冷卻甲', status: 'cooling', created: daysBefore(100), cited: 1 });
        const b = addFrag({ content: '冷卻乙', status: 'cooling', created: daysBefore(100) });
        db.prepare("UPDATE memory_fragments SET lifecycle_updated_at = datetime('now', '-5 days')").run();
        await lifecycle.runFragmentGC();
        assert.equal(getF(a).status, 'active');
        assert.equal(getF(b).status, 'cooling');
    });
    test('gate=false：維持 read_count 舊規則', async () => {
        G.setRecallConfigOverride({ recall: { gate: false } });
        const id = addFrag({ content: '舊事', created: daysBefore(100), read: 3, injected: 3 });
        const zero = addFrag({ content: '沒讀過', created: daysBefore(100) });
        await lifecycle.runFragmentGC();
        assert.equal(getF(id).status, 'active');
        assert.equal(getF(zero).status, 'cooling');
    });
});

// ─────────────────────────────────────────────
describe('情境浮現', () => {
    const base = { get cfg() { return cfgOf({}); } };
    const pick = (o = {}) => G.pickSurface({ db, cfg: base.cfg, now: NOW, rng: G.seededRng(42), ...o });

    test('閒置超過門檻後的第一句會浮現；沒閒置、沒有上一則都不浮現', () => {
        const old = addFrag({ content: '很久以前的一件事', created: daysBefore(30), ew: 0.7 });
        assert.deepEqual(pick({ lastMessageAt: NOW - 7 * 3600000 }).map(f => f.id), [old]);
        assert.equal(pick({ lastMessageAt: NOW - 5 * 3600000 }).length, 0);
        assert.equal(pick({ lastMessageAt: null }).length, 0);
        const it = pick({ lastMessageAt: NOW - 7 * 3600000 })[0];
        assert.equal(it._isFloated, true);
        assert.equal(it._surfaceReason, 'idle');
    });
    test('只挑沒被注入過、且超過最小天數的碎片', () => {
        addFrag({ content: '太新', created: daysBefore(1) });
        addFrag({ content: '注入過', created: daysBefore(30), injected: 2 });
        addFrag({ content: '已冷卻', created: daysBefore(30), status: 'cooling' });
        assert.equal(pick({ lastMessageAt: NOW - 8 * 3600000 }).length, 0);
    });
    test('同一日期（去年今天）不必閒置也會浮現；今年同月日不算', () => {
        const ann = addFrag({ content: '去年今天的事', created: '2025-09-30 08:00:00', injected: 3 });
        addFrag({ content: '今年今天', created: '2026-09-30 01:00:00' });
        const r = pick({ lastMessageAt: NOW - 60000 });
        assert.deepEqual(r.map(f => f.id), [ann]);
        assert.equal(r[0]._surfaceReason, 'anniversary');
    });
    test('F4：G2 啟用時週年日走 getAnniversaries——以當地日期比對 raised_at（UTC 差一天也算）', () => {
        // NOW = 2026-09-30 12:00 UTC（台北 20:00，同日）；去年 UTC 09-29 18:00 = 台北 09-30 02:00 → 當地是「去年今天」
        const id = addFrag({ content: '去年半夜想到的事', created: '2025-05-01 00:00:00', injected: 3 });
        db.prepare("UPDATE memory_fragments SET raised_at = '2025-09-29 18:00:00', intensity = 0.5, valence = -0.2 WHERE id = ?").run(id);
        const r = pick({ lastMessageAt: NOW - 60000 });
        assert.deepEqual(r.map(f => f.id), [id]);
        assert.equal(r[0]._surfaceReason, 'anniversary');
    });
    test('F4：event_at 為去年今天也算（即使 created_at 是別天）', () => {
        const id = addFrag({ content: '去年今天的婚禮', created: '2025-10-15 00:00:00', injected: 3 });
        db.prepare("UPDATE memory_fragments SET raised_at = '2025-10-15 00:00:00', event_at = '2025-09-30', intensity = 0.6, valence = 0.8 WHERE id = ?").run(id);
        const r = pick({ lastMessageAt: NOW - 60000 });
        assert.deepEqual(r.map(f => f.id), [id]);
    });
    test('F4：有 raised_at 的碎片不再用 created_at 月日比對（避免 UTC 月日誤判）；沒有的舊碎片仍走 created_at', () => {
        const wrong = addFrag({ content: '建立日相同但被提出在別天', created: '2025-09-30 08:00:00', injected: 3 });
        db.prepare("UPDATE memory_fragments SET raised_at = '2025-03-01 08:00:00', intensity = 0.5, valence = 0 WHERE id = ?").run(wrong);
        const legacy = addFrag({ content: '舊碎片沒有情緒欄位', created: '2025-09-30 09:00:00', injected: 3 });
        const r = pick({ lastMessageAt: NOW - 60000 });
        assert.deepEqual(r.map(f => f.id), [legacy]);
    });
    test('F4：G2 關閉 → 退回原本的 created_at 比對', () => {
        const emotion = require('../../services/emotion');
        const wrong = addFrag({ content: '建立日相同但被提出在別天', created: '2025-09-30 08:00:00', injected: 3 });
        db.prepare("UPDATE memory_fragments SET raised_at = '2025-03-01 08:00:00', intensity = 0.5, valence = 0 WHERE id = ?").run(wrong);
        emotion._setOverride({ enabled: false });
        try {
            assert.deepEqual(pick({ lastMessageAt: NOW - 60000 }).map(f => f.id), [wrong]);
        } finally { emotion._setOverride(null); }
    });
    test('冷卻期內不重複、過了冷卻可再浮現', () => {
        const id = addFrag({ content: '舊事一件', created: daysBefore(30) });
        const o = { lastMessageAt: NOW - 8 * 3600000 };
        const first = pick(o);
        assert.equal(first.length, 1);
        G.recordSurfaced(first, db, NOW);
        assert.equal(pick(o).length, 0);
        assert.equal(pick({ ...o, now: NOW + 6 * DAY }).length, 0);
        assert.deepEqual(pick({ ...o, now: NOW + 7 * DAY + 1000, lastMessageAt: NOW + 6 * DAY }).map(f => f.id), [id]);
    });
    test('固定種子可重現；不同種子可挑出不同者；surface_max 限制條數', () => {
        for (let i = 0; i < 10; i++) addFrag({ content: `舊事${i}`, created: daysBefore(30 + i), ew: 0.5 });
        const o = { lastMessageAt: NOW - 8 * 3600000 };
        const a = pick({ ...o, rng: G.seededRng(7) }).map(f => f.id);
        const b = pick({ ...o, rng: G.seededRng(7) }).map(f => f.id);
        assert.deepEqual(a, b);
        assert.equal(a.length, 2);
        const seen = new Set();
        for (let s = 1; s <= 30; s++) pick({ ...o, rng: G.seededRng(s) }).forEach(f => seen.add(f.id));
        assert.ok(seen.size > 2, '擾動應讓不同種子挑到不同碎片');
        // 無擾動時就是 emotional_weight 高者優先
        const hi = addFrag({ content: '最重要的舊事', created: daysBefore(40), ew: 0.95 });
        const cfg0 = cfgOf({ surface_noise: 0, surface_max: 1 });
        assert.deepEqual(G.pickSurface({ db, cfg: cfg0, now: NOW, lastMessageAt: NOW - 8 * 3600000 }).map(f => f.id), [hi]);
    });
    test('管線：閒置後第一句（即使是寒暄）浮現並記冷卻；再問一次不重複', async () => {
        const id = addFrag({ content: '很久以前一起去過海邊', created: daysBefore(40), ew: 0.8 });
        G.touchLastMessage(db, NOW - 9 * 3600000);
        const r1 = await pipeline.buildGatedMemory('早安', { cfg: cfgOf({}), db, now: NOW, rng: G.seededRng(1) });
        assert.equal(r1.decision.retrieve, false);
        assert.match(r1.parts.join('\n'), /海邊/);
        assert.match(r1.parts.join('\n'), /僅聯想/);
        assert.equal(getF(id).injected_count, 1);
        assert.ok(db.prepare("SELECT 1 FROM recall_surface_log WHERE source_table='fragment' AND ref_id = ?").get(id));
        const r2 = await pipeline.buildGatedMemory('早安', { cfg: cfgOf({}), db, now: NOW + 8 * 3600000, rng: G.seededRng(1) });
        assert.doesNotMatch(r2.parts.join('\n'), /海邊/);
    });
});

// ─────────────────────────────────────────────
describe('前瞻記憶：日期解析', () => {
    const REF = new Date(Date.UTC(2026, 8, 30));   // 2026-09-30 週三
    const ymd = (ds) => ds.map(d => d.toISOString().slice(0, 10));
    const cases = [
        ['10月5日要看醫生', ['2026-10-05']],
        ['10月5號聚餐', ['2026-10-05']],
        ['10/5 開會', ['2026-10-05']],
        ['10 月 5 日', ['2026-10-05']],
        ['2026年11月3日交件', ['2026-11-03']],
        ['2026-11-03 交件', ['2026-11-03']],
        ['9月30日今天', ['2026-09-30']],
        ['9月29日已過', ['2027-09-29']],                  // 年份取下一個出現的日期
        ['下週二開會', ['2026-10-06']],
        ['下星期日去爬山', ['2026-10-11']],
        ['下禮拜五面試', ['2026-10-09']],
        ['下周三', ['2026-10-07']],                         // 簡繁異體
        ['週五要交報告', ['2026-10-02']],
        ['周六去看展', ['2026-10-03']],
        ['星期三有課', ['2026-09-30']],                      // 含當天
        ['這週日出遊', ['2026-10-04']],
        ['明天有會議', ['2026-10-01']],
        ['後天出發', ['2026-10-02']],
        ['大後天回來', ['2026-10-03']],
        ['明天是10月5日', ['2026-10-05', '2026-10-01']],
        ['沒有日期的句子', []],
        ['2月30日不存在', []],
        ['價格是3/4杯', ['2027-03-04']],                    // 已知限制：分數寫法會被當日期（前後接數字才排除）
    ];
    for (const [text, want] of cases) {
        test(`${text} → ${want.join(',') || '無'}`, () => {
            assert.deepEqual(ymd(G.parseDatesFromText(text, REF)).sort(), [...want].sort());
        });
    }
    test('跨年：12 月寫的「1月2日」是明年', () => {
        assert.deepEqual(ymd(G.parseDatesFromText('1月2日開工', new Date(Date.UTC(2026, 11, 28)))), ['2027-01-02']);
    });
    test('週幾以碎片寫下的時間為基準，而不是現在', () => {
        // 9/28（週一）寫的「下週三」是 10/7 之前那個週三：10/7？→ 下週 = 10/5 起的那週 → 10/7
        assert.deepEqual(ymd(G.parseDatesFromText('下週三', new Date(Date.UTC(2026, 8, 28)))), ['2026-10-07']);
        assert.deepEqual(ymd(G.parseDatesFromText('週三', new Date(Date.UTC(2026, 8, 28)))), ['2026-09-30']);
    });
});

describe('前瞻記憶：即將發生的事', () => {
    const find = (o = {}) => G.findUpcoming({ db, cfg: cfgOf({}), now: NOW, ...o });
    test('7 天內列入、超過不列、已過去不列；依日期排序', () => {
        const a = addFrag({ content: '10月2日要去看牙醫', created: daysBefore(3) });
        const b = addFrag({ content: '10月7日聚餐', created: daysBefore(3) });     // 第 7 天，含
        addFrag({ content: '10月8日出國', created: daysBefore(3) });               // 第 8 天
        addFrag({ content: '9月25日開過會', created: daysBefore(5) });             // 已過（下一次出現在明年）
        const c = addFrag({ content: '明天要交報告', created: daysBefore(0) });
        const r = find();
        assert.deepEqual(r.map(x => x.id), [c, a, b]);
        assert.deepEqual(r.map(x => x.daysUntil), [1, 2, 7]);
    });
    test('跨年：12/30 看「1月2日」（碎片寫於 12/28）', () => {
        const id = addFrag({ content: '1月2日開工', created: '2026-12-28 09:00:00' });
        const r = G.findUpcoming({ db, cfg: cfgOf({}), now: Date.UTC(2026, 11, 30, 12) });
        assert.deepEqual(r.map(x => x.id), [id]);
        assert.equal(r[0].daysUntil, 3);
    });
    test('只看有效碎片與回看期內的；prospective_max 限制條數；prospective_days=0 關閉', () => {
        addFrag({ content: '10月2日舊碎片', created: daysBefore(200) });
        addFrag({ content: '10月2日已冷卻', created: daysBefore(2), status: 'cooling' });
        for (let i = 0; i < 5; i++) addFrag({ content: `10月${i + 1}日的第${i}件事`, created: daysBefore(2) });
        assert.equal(find().length, 3);
        assert.equal(G.findUpcoming({ db, cfg: cfgOf({ prospective_days: 0 }), now: NOW }).length, 0);
    });
    test('管線：不必查詢命中，寒暄也會帶出「即將到來」區塊並記注入', async () => {
        const id = addFrag({ content: '10月2日要去看牙醫', created: daysBefore(3) });
        const r = await pipeline.buildGatedMemory('晚安', { cfg: cfgOf({}), db, now: NOW });
        assert.equal(r.decision.retrieve, false);
        const ctx = r.parts.join('\n');
        assert.match(ctx, /<upcoming_events>/);
        assert.match(ctx, /2天後（10\/2）· #\d+\n10月2日要去看牙醫/);
        assert.equal(getF(id).injected_count, 1);
    });
    test('event_at 欄位存在時優先使用（G2 之後可替換來源）', () => {
        // G2 的 migration v111 已經建了這個欄位；沒有時（舊庫）才自己補，測完只拿掉自己補的
        const had = db.prepare('PRAGMA table_info(memory_fragments)').all().some(c => c.name === 'event_at');
        if (!had) db.exec('ALTER TABLE memory_fragments ADD COLUMN event_at TEXT');
        try {
            const id = addFrag({ content: '沒有任何日期字樣的事件', created: daysBefore(2) });
            db.prepare('UPDATE memory_fragments SET event_at = ? WHERE id = ?').run('2026-10-03', id);
            const r = find();
            assert.deepEqual(r.map(x => x.id), [id]);
            assert.equal(r[0].daysUntil, 3);
        } finally {
            if (!had) db.exec('ALTER TABLE memory_fragments DROP COLUMN event_at');
        }
    });
});

// ─────────────────────────────────────────────
describe('hard trigger', () => {
    const addMem = (title, tags, id) => db.prepare(`INSERT INTO memories (title, content, tags, weight, status, layer, created_at)
        VALUES (?, ?, ?, 5, 'permanent', 'core', datetime('now'))`).run(title, `內容：${title}`, JSON.stringify(tags)).lastInsertRowid;

    test('兩字組比對：簡繁皆命中；只有部分字不算', () => {
        addMem('咖啡廳', ['咖啡廳']);
        addMem('拉麵', ['拉麵']);
        const cfg = cfgOf({});
        assert.equal(mem.searchMemoriesByHardTrigger('我想去咖啡廳', { cfg }).length, 1);
        assert.equal(mem.searchMemoriesByHardTrigger('想去咖啡厅', { cfg }).length, 1);
        assert.equal(mem.searchMemoriesByHardTrigger('想去咖啡', { cfg }).length, 0);   // 「啡廳」沒出現
        assert.equal(mem.searchMemoriesByHardTrigger('吃了拉面', { cfg }).length, 1);
        assert.equal(mem.searchMemoriesByHardTrigger('拉風的麵', { cfg }).length, 0);
    });
    test('上限 hard_trigger_max：標籤越長者優先，超過只留上限條數', () => {
        addMem('甲', ['京都']);
        addMem('乙', ['京都旅行']);
        addMem('丙', ['京都旅行計畫']);
        addMem('丁', ['旅行']);
        addMem('戊', ['計畫']);
        const r = mem.searchMemoriesByHardTrigger('京都旅行計畫', { cfg: cfgOf({ hard_trigger_max: 3 }) });
        assert.equal(r.length, 3);
        assert.equal(r[0].content, '內容：丙');
        assert.equal(mem.searchMemoriesByHardTrigger('京都旅行計畫', { cfg: cfgOf({ hard_trigger_max: 1 }) }).length, 1);
        assert.equal(mem.searchMemoriesByHardTrigger('京都旅行計畫', { cfg: cfgOf({ hard_trigger_max: 0 }) }).length, 0);
    });
    test('gate=false：維持原本的子字串比對且不設上限', () => {
        for (let i = 0; i < 5; i++) addMem(`標籤${i}`, ['京都']);
        addMem('單字', ['京']);
        const off = cfgOf({ gate: false });
        assert.equal(mem.searchMemoriesByHardTrigger('去京都玩', { cfg: off }).length, 6);
        assert.equal(mem.searchMemoriesByHardTrigger('去京都玩', { cfg: cfgOf({}) }).length, 3);
    });
});

// ─────────────────────────────────────────────
describe('buildSmartContext：gate 開／關', () => {
    let readOrig;
    before(() => {
        readOrig = fs.readFileSync;
        fs.readFileSync = (p, ...r) => (String(p) === 'core-prompt.txt' ? '核心人格 {{CORE_INSIGHT}}' : readOrig(p, ...r));
    });
    after(() => { fs.readFileSync = readOrig; });

    test('寒暄：gate 開 → 不查也不注入；gate 關 → 與舊行為相同（仍查）', async () => {
        addFrag({ content: '晚安之前聊過睡眠的事', created: daysBefore(2), ew: 0.8 });
        const { buildSmartContext } = require('../../services/context');
        const on = await buildSmartContext('晚安', '');
        assert.doesNotMatch(on.dynamicContext, /<memory_context>/);
        assert.equal(on.injectedMemories.length, 0);
        pipeline.resetPipelineState();
        G.setRecallConfigOverride({ recall: { gate: false } });
        const off = await buildSmartContext('晚安', '');
        assert.match(off.dynamicContext, /<memory_context>/);
        assert.match(off.dynamicContext, /睡眠/);
        assert.deepEqual(off.injectedMemories, []);
    });
    test('G3 人格關係區塊不受閘門影響：寒暄不查記憶時仍每輪注入', async () => {
        const persona = require('../../services/persona');
        const orig = persona.buildRelationshipContext;
        persona.buildRelationshipContext = () => '<relationship_context>測試關係層</relationship_context>';
        try {
            const { buildSmartContext } = require('../../services/context');
            const r = await buildSmartContext('晚安', '');
            assert.doesNotMatch(r.dynamicContext, /<memory_context>/);
            assert.match(r.dynamicContext, /<relationship_context>測試關係層/);
        } finally { persona.buildRelationshipContext = orig; }
    });
    test('gate 開：問句照常查並回報 injectedMemories', async () => {
        const id = addFrag({ content: '阿明去京都旅遊訂了旅館', created: daysBefore(2), ew: 0.8 });
        const { buildSmartContext } = require('../../services/context');
        const r = await buildSmartContext('阿明去京都旅遊住哪間旅館', '');
        assert.match(r.dynamicContext, /<memory_context>/);
        assert.ok(r.injectedMemories.some(x => x.id === id));
    });
    test('話題延續：第二則不重新檢索、沿用工作記憶內容且不重複計次', async () => {
        const id = addFrag({ content: '一蘭拉麵的湯頭很濃很好吃', created: daysBefore(2), ew: 0.8 });
        const { buildSmartContext } = require('../../services/context');
        const r1 = await buildSmartContext('一蘭拉麵的湯頭怎麼樣', '');
        assert.ok(r1.injectedMemories.some(x => x.id === id));
        assert.equal(getF(id).injected_count, 1);
        const before = vecCalls;
        const r2 = await buildSmartContext('那家一蘭拉麵的湯頭很濃', '');
        assert.equal(vecCalls, before, '延續時不應再查向量');
        assert.match(r2.dynamicContext, /一蘭拉麵/);
        assert.equal(getF(id).injected_count, 1);
        assert.ok(touchCalls >= 1);
    });
});
