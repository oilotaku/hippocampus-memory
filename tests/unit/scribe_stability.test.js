'use strict';
// Scribe 穩定度（內嗅皮質止血）：容錯解析、截斷切半、失敗不越過游標、毒訊息處理、逐批背景訊息、
// 本批 chat_mode、去重參考關閉隨機浮現、溫度與輸出上限可設定。LLM / Chroma / Librarian 全部 stub。
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('scribe_stability');

// runScribe 解析失敗時會等 3 秒再重試；測試裡改成立刻重試
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 3000 ? 0 : ms, ...a);

const llm = require('../../services/llm');
const memory = require('../../services/memory');
let llmCalls = [];
let llmImpl = null;           // (call) => { reply, finishReason } 或 throw
llm.callLLM = async (msgs, systemPrompt, _tools, gen) => {
    const call = { text: msgs[0].parts[0].text, systemPrompt, gen };
    llmCalls.push(call);
    return llmImpl(call);
};
memory.chromaDBOperation = async () => { throw new Error('ECONNREFUSED (stub)'); };
let searchOpts = [];
const libPath = require.resolve('../../services/librarian');
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true,
    exports: { searchHybrid: async (_q, _n, opts) => { searchOpts.push(opts); return []; } } };

let restore, db, scribe, scribeConfig;
before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    scribe = require('../../services/scribe');
    scribeConfig = require('../../services/hippocampus/entorhinal/scribeConfig');
});
after(() => { restore(); global.setTimeout = realSetTimeout; cleanupDb(dbPath); });
beforeEach(() => { llmCalls = []; searchOpts = []; scribeConfig.setScribeConfigOverride(null); });

const { parseScribeReply } = require('../../services/hippocampus/dentate/scribeQuality');

// ── 測試資料：每則訊息內容「我今天做了第 N 件事」，時間每分鐘一則 ──
let chatSeq = 0;
function seedMessages(n, { start = '2026-05-01 00:00:00', mode = () => 'default' } = {}) {
    const chatId = Number(db.prepare(`INSERT INTO chats (name) VALUES (?)`).run(`穩定度${++chatSeq}`).lastInsertRowid);
    const t0 = Date.parse(start.replace(' ', 'T') + 'Z');
    const ins = db.prepare(`INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted, message_type, chat_mode) VALUES (?, 'user', ?, ?, 0, 'text', ?)`);
    const out = [];
    for (let i = 1; i <= n; i++) {
        const ts = new Date(t0 + i * 60000).toISOString().slice(0, 19).replace('T', ' ');
        const content = `我今天做了第${i}件事`;
        const id = Number(ins.run(chatId, content, ts, mode(i)).lastInsertRowid);
        out.push({ id, sender: 'user', content, timestamp: ts, message_type: 'text', is_encrypted: 0 });
    }
    return out;
}
const mainPart = (text) => (text.includes('[以下為本次處理內容]') ? text.split('[以下為本次處理內容]')[1] : text);
const bgPart = (text) => (text.includes('[以下為本次處理內容]') ? text.split('[以下為本次處理內容]')[0] : '');
const numsIn = (s) => [...s.matchAll(/第(\d+)件事/g)].map(m => Number(m[1]));
// 實體與內容每次都不同：跨測試重複的內容會被確定性去重當成同一件事（改成證據 +1），寫入數就對不上
let uid = 0;
const entryFor = (n) => { uid++; return { type: 'event', entities: [{ name: `穩定度實體${n}號${uid}`, relation: 'related_to' }],
    content: `穩定度實體${n}號${uid}做了第${n}件事`, quote: `我今天做了第${n}件事`, emotional_weight: 0.2, value_tags: [], source: 'chat' }; };
// 正常回覆：本批每則訊息各一條
const okReply = (call) => ({ reply: JSON.stringify({ entries: numsIn(mainPart(call.text)).map(entryFor), fulfilled_intention_ids: [] }), finishReason: 'stop' });
const runs = () => db.prepare(`SELECT status, processed_until, messages_processed FROM scribe_runs ORDER BY id`).all();
const resetRuns = () => db.prepare(`DELETE FROM scribe_runs`).run();

describe('parseScribeReply：容錯解析', () => {
    test('完整 JSON、前後夾雜說明文字都能解析', () => {
        const j = { entries: [entryFor(1)], fulfilled_intention_ids: [3] };
        assert.deepEqual(parseScribeReply(JSON.stringify(j)).result, j);
        const r = parseScribeReply('好的，以下是結果：\n```json\n' + JSON.stringify(j) + '\n```\n以上。');
        assert.deepEqual(r.result, j);
        assert.equal(r.truncated, false);
    });
    test('輸出被截斷：救回所有完整條目，標記 truncated', () => {
        const full = JSON.stringify({ entries: [entryFor(1), entryFor(2), entryFor(3)] });
        const cut = full.slice(0, full.indexOf('第3件事') + 2);            // 第三條寫到一半
        const r = parseScribeReply(cut);
        assert.equal(r.salvaged, true);
        assert.equal(r.truncated, true);
        assert.deepEqual(r.result.entries.map(e => e.quote), ['我今天做了第1件事', '我今天做了第2件事']);
    });
    test('字串裡的大括號與跳脫引號不會打亂掃描', () => {
        const e = { ...entryFor(1), content: '他說「{不是} JSON」還有 \\"引號\\" }' };
        const cut = JSON.stringify({ entries: [e, entryFor(2)] }).slice(0, -20);
        const r = parseScribeReply(cut);
        assert.equal(r.result.entries.length, 1);
        assert.equal(r.result.entries[0].content, e.content);
    });
    test('完全不是 JSON → result 為 null', () => {
        assert.equal(parseScribeReply('抱歉，我無法處理這段對話。').result, null);
        assert.equal(parseScribeReply('').result, null);
    });
});

describe('runScribe：截斷切半、輸出上限與溫度', () => {
    test('finishReason=length 時對半切開重跑，兩半都寫入、各自推進游標', async () => {
        resetRuns();
        const msgs = seedMessages(20, { start: '2026-05-02 00:00:00' });
        let first = true;
        llmImpl = (call) => {
            if (first) { first = false; return { reply: '{"entries": [' + JSON.stringify(entryFor(1)) + ', {"type": "ev', finishReason: 'length' }; }
            return okReply(call);
        };
        const r = await scribe.runScribe(msgs, '2026-05-02 00:00:00');
        assert.equal(r.ok, true);
        assert.equal(r.split, true);
        assert.equal(llmCalls.length, 3);
        assert.equal(r.written, 20);                                 // 截斷那次的部分結果丟掉，兩半重跑各寫 10 條
        const done = runs().filter(x => x.status === 'done');
        assert.deepEqual(done.map(x => x.messages_processed), [10, 10]);
        assert.equal(done[1].processed_until, msgs[19].timestamp);
    });
    test('批次已很小時不再切，改用救回的完整條目', async () => {
        resetRuns();
        const msgs = seedMessages(4, { start: '2026-05-03 00:00:00' });
        llmImpl = () => ({ reply: '{"entries": [' + JSON.stringify(entryFor(1)) + ', ' + JSON.stringify(entryFor(2)) + ', {"type"', finishReason: 'length' });
        const r = await scribe.runScribe(msgs, '2026-05-03 00:00:00');
        assert.equal(r.ok, true);
        assert.equal(r.truncated, true);
        assert.equal(llmCalls.length, 1);
        assert.equal(r.written, 2);
    });
    test('輸出上限與溫度取自設定，溫度 0 原樣送出；去重參考關閉隨機浮現', async () => {
        resetRuns();
        const msgs = seedMessages(3, { start: '2026-05-04 00:00:00' });
        llmImpl = okReply;
        await scribe.runScribe(msgs, '2026-05-04 00:00:00');
        assert.deepEqual(llmCalls[0].gen, { temperature: 0.3, maxOutputTokens: 16384 });
        assert.deepEqual(searchOpts[0], { surface: 'none' });
        llmCalls = [];
        scribeConfig.setScribeConfigOverride({ temperature: 0, max_output_tokens: 8192 });
        await scribe.runScribe(seedMessages(2, { start: '2026-05-04 06:00:00' }), '2026-05-04 06:00:00');
        assert.deepEqual(llmCalls[0].gen, { temperature: 0, maxOutputTokens: 8192 });
    });
});

describe('runScribe：本批 chat_mode', () => {
    test('cinema 訊息不送給模型、引用它的條目被丟；游標涵蓋整批', async () => {
        resetRuns();
        const msgs = seedMessages(6, { start: '2026-05-05 00:00:00', mode: i => (i <= 3 ? 'cinema' : 'default') });
        llmImpl = (call) => ({ reply: JSON.stringify({ entries: [1, 2, 3, 4, 5, 6].map(entryFor) }), finishReason: 'stop' });
        const r = await scribe.runScribe(msgs, '2026-05-05 00:00:00');
        assert.deepEqual(numsIn(mainPart(llmCalls[0].text)), [4, 5, 6]);
        assert.equal(r.written, 3);                                  // 第 1～3 條引用 cinema 訊息，原話佐證找不到來源
        assert.deepEqual(runs().map(x => [x.status, x.messages_processed, x.processed_until]), [['done', 6, msgs[5].timestamp]]);
    });
    test('整批都是 cinema：不呼叫模型，直接寫 done 推進游標', async () => {
        resetRuns();
        const msgs = seedMessages(4, { start: '2026-05-06 00:00:00', mode: () => 'cinema' });
        llmImpl = okReply;
        const r = await scribe.runScribe(msgs, '2026-05-06 00:00:00');
        assert.equal(r.ok, true);
        assert.equal(llmCalls.length, 0);
        assert.deepEqual(runs().map(x => [x.status, x.processed_until]), [['done', msgs[3].timestamp]]);
    });
    test('roleplay 取本批多數，不受背景訊息影響', async () => {
        resetRuns();
        seedMessages(10, { start: '2026-05-07 00:00:00', mode: () => 'roleplay' });   // 會成為背景訊息
        const msgs = seedMessages(5, { start: '2026-05-07 01:00:00', mode: i => (i === 1 ? 'roleplay' : 'default') });
        llmImpl = okReply;
        await scribe.runScribe(msgs, '2026-05-07 01:00:00');
        const rows = db.prepare(`SELECT is_rp, chat_mode FROM memory_fragments WHERE content LIKE '穩定度實體%' ORDER BY id DESC LIMIT 5`).all();
        assert.ok(rows.every(x => x.is_rp === 0 && x.chat_mode === 'default'));
    });
});

describe('checkAndRunScribe：逐批游標、失敗不越過、毒訊息', () => {
    // 每個測試前清空訊息與執行紀錄，讓 checkAndRunScribe 只看到這個測試的訊息
    const resetAll = () => { db.prepare('DELETE FROM messages').run(); resetRuns(); };

    test('第 2 批的背景訊息是第 1 批最後 10 則', async () => {
        resetAll();
        seedMessages(70, { start: '2026-06-01 00:00:00' });
        llmImpl = okReply;
        await scribe.checkAndRunScribe();
        assert.equal(llmCalls.length, 2);
        const bg = numsIn(bgPart(llmCalls[1].text));
        assert.deepEqual(bg, [51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
        assert.deepEqual(runs().map(x => x.status), ['done', 'done']);
    });

    test('中間批連線失敗：停止本輪、游標停在失敗批前；下次 tick 從失敗批重試', async () => {
        resetAll();
        const msgs = seedMessages(130, { start: '2026-06-02 00:00:00' });
        let n = 0;
        llmImpl = (call) => { n++; if (n === 2 || n === 3) throw new Error('ECONNREFUSED'); return okReply(call); };
        await scribe.checkAndRunScribe();
        assert.equal(llmCalls.length, 3);                            // 第 1 批成功、第 2 批兩次嘗試都失敗、第 3 批沒跑
        assert.deepEqual(runs().map(x => x.status), ['done', 'failed']);
        await scribe.checkAndRunScribe();
        const done = runs().filter(x => x.status === 'done');
        assert.equal(done[done.length - 1].processed_until, msgs[129].timestamp);
        assert.deepEqual(runs().map(x => x.status), ['done', 'failed', 'done', 'done']);
    });

    test('連線失敗不計入毒訊息：連續失敗多次也不會跳過訊息', async () => {
        resetAll();
        seedMessages(40, { start: '2026-06-03 00:00:00' });
        llmImpl = () => { throw new Error('ECONNREFUSED'); };
        for (let i = 0; i < 7; i++) await scribe.checkAndRunScribe();
        assert.ok(runs().every(x => x.status === 'failed'));
        assert.ok(llmCalls.every(c => numsIn(mainPart(c.text)).length === 40));   // 一直是整批，沒有縮小
    });

    test('有回覆但一直解析不了：3 次後縮成小批、5 次後逐則，單則仍失敗就記 skipped 推進', async () => {
        resetAll();
        const msgs = seedMessages(40, { start: '2026-06-04 00:00:00' });
        llmImpl = (call) => (numsIn(mainPart(call.text)).includes(1)
            ? { reply: '這不是 JSON', finishReason: 'stop' }            // 第 1 則是毒訊息
            : okReply(call));
        const sizes = [];
        for (let i = 0; i < 6; i++) {
            const before = llmCalls.length;
            await scribe.checkAndRunScribe();
            sizes.push(numsIn(mainPart(llmCalls[before].text)).length);
        }
        assert.deepEqual(sizes.slice(0, 3), [40, 40, 40]);
        assert.deepEqual(sizes.slice(3, 5), [8, 8]);
        assert.equal(sizes[5], 1);
        const st = runs().map(x => x.status);
        assert.equal(st.filter(s => s === 'failed_parse').length, 6);
        assert.equal(st[st.length - 1], 'skipped');
        assert.equal(runs()[runs().length - 1].processed_until, msgs[0].timestamp);
        // 下一輪恢復整批，從第 2 則起正常處理
        await scribe.checkAndRunScribe();
        const last = runs().filter(x => x.status === 'done').pop();
        assert.equal(last.processed_until, msgs[39].timestamp);
    });
});
