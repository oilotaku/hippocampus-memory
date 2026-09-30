'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('correction');
let restore, db, cor, USER;
const chromaCalls = [];
let chromaFail = false;
let llmImpl = null;         // (messages, system, ...) => Promise<{reply}>
const llmCalls = [];
let vecResults = [];
let recentPool = [];

before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    // correction.js 載入時解構 callLLM / chromaDBOperation，先換掉再 require
    const memory = require('../../services/memory');
    memory.chromaDBOperation = async (op, payload) => { chromaCalls.push({ op, payload }); if (chromaFail) throw new Error('chroma down'); return {}; };
    memory.searchMemoriesByVector = async () => vecResults;     // 函式內才 require，換屬性即可
    require('../../services/workingMemory').getRecentFragments = () => recentPool;
    require('../../services/llm').callLLM = async (...args) => { llmCalls.push(args); return llmImpl(...args); };
    ({ USER } = require('../../services/nameResolver'));
    cor = require('../../services/correction');
});
after(() => { restore(); cleanupDb(dbPath); });
beforeEach(() => {
    chromaCalls.length = 0; llmCalls.length = 0; chromaFail = false;
    vecResults = []; recentPool = [];
    llmImpl = async () => { throw new Error('LLM 未設定 stub'); };
    db.exec('DELETE FROM correction_log; DELETE FROM memory_fragments; DELETE FROM memories; DELETE FROM ontology_changelog; DELETE FROM user_settings; DELETE FROM sqlite_sequence;');
});

const rows = (t, w = '') => db.prepare(`SELECT * FROM ${t} ${w}`).all();
const addFrag = (content = '原碎片') => Number(db.prepare("INSERT INTO memory_fragments (type, entity, content) VALUES ('event','X',?)").run(content).lastInsertRowid);
const addMem = (weight = 5) => Number(db.prepare("INSERT INTO memories (title, content, tags, weight) VALUES ('標題','內容','[]',?)").run(weight).lastInsertRowid);
const judged = (obj) => async () => ({ reply: JSON.stringify(obj) });
const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('waitFor 逾時'); await new Promise(r => setTimeout(r, 10)); } };

describe('recordCorrection', () => {
    test('寫入 active 紀錄並回傳 id；source 預設 manual；manual 不寫 changelog', () => {
        const id = cor.recordCorrection({ targetType: 'hallucination', wrongSummary: '錯', correctSummary: '對' });
        const r = rows('correction_log')[0];
        assert.equal(r.id, id);
        assert.equal(r.status, 'active');
        assert.equal(r.source, 'manual');
        assert.equal(r.target_id, null);
        assert.equal(rows('ontology_changelog').length, 0);
    });

    test('source=chat_correction → 額外寫 ontology_changelog（memory_correction，wrong/correct 截 80 字）', () => {
        cor.recordCorrection({ targetType: 'hallucination', wrongSummary: 'w'.repeat(100), correctSummary: 'c', source: 'chat_correction' });
        const c = rows('ontology_changelog')[0];
        assert.equal(c.action, 'memory_correction');
        assert.equal(c.category_path, null);
        assert.deepEqual(JSON.parse(c.detail), { wrong: 'w'.repeat(80), correct: 'c', target: 'hallucination' });
    });

    test('target=memory → weight = MAX(1, weight*0.3)', () => {
        const a = addMem(5), b = addMem(2);
        cor.recordCorrection({ targetType: 'memory', targetId: a, wrongSummary: 'w', correctSummary: 'c' });
        cor.recordCorrection({ targetType: 'memory', targetId: b, wrongSummary: 'w', correctSummary: 'c' });
        assert.equal(db.prepare('SELECT weight FROM memories WHERE id=?').get(a).weight, 1.5);
        assert.equal(db.prepare('SELECT weight FROM memories WHERE id=?').get(b).weight, 1);
    });

    test('target=fragment → 碎片 status 變 consolidated', () => {
        const f = addFrag();
        cor.recordCorrection({ targetType: 'fragment', targetId: f, wrongSummary: 'w', correctSummary: 'c' });
        assert.equal(db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(f).status, 'consolidated');
    });
});

describe('getActiveCorrections / 合併門檻', () => {
    test('沒有活躍教訓 → null；有則格式化並只取最近 5 筆（新到舊）', () => {
        assert.equal(cor.getActiveCorrections(), null);
        for (let i = 1; i <= 7; i++) {
            db.prepare("INSERT INTO correction_log (target_type, wrong_summary, correct_summary, status, created_at) VALUES ('hallucination', ?, ?, 'active', ?)")
                .run(`錯${i}`, `對${i}`, `2026-01-0${i} 00:00:00`);
        }
        const out = cor.getActiveCorrections().split('\n');
        assert.equal(out.length, 5);
        assert.equal(out[0], '- 錯誤：錯7 → 正確：對7');
        assert.equal(out[4], '- 錯誤：錯3 → 正確：對3');
    });

    test('9 條 active 不觸發合併；merged 的不計入 active', async () => {
        llmImpl = async () => ({ reply: '{"guidelines":["g"]}' });
        for (let i = 0; i < 9; i++) cor.recordCorrection({ targetType: 'hallucination', wrongSummary: `w${i}`, correctSummary: `c${i}` });
        await new Promise(r => setTimeout(r, 50));
        assert.equal(llmCalls.length, 0);
        assert.equal(rows('correction_log', "WHERE status='active'").length, 9);
    });

    test('第 10 條 active → 觸發歸納：LLM 準則寫入 scribe_guidelines，全部 active 標 merged', async () => {
        llmImpl = async () => ({ reply: '```json\n{"guidelines":["準則A","準則B"]}\n```' });
        for (let i = 0; i < 10; i++) cor.recordCorrection({ targetType: 'hallucination', wrongSummary: `w${i}`, correctSummary: `c${i}` });
        await waitFor(() => rows('correction_log', "WHERE status='merged'").length === 10);
        assert.equal(llmCalls.length, 1);
        assert.match(llmCalls[0][0][0].parts[0].text, /wrong: w0\n {2}correct: c0/);
        const setting = JSON.parse(db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='scribe_guidelines'").get().setting_value);
        assert.deepEqual(setting.guidelines, ['準則A', '準則B']);
        assert.equal(setting.merged_from, 10);
        assert.equal(await cor.getMergedGuidelines(), '1. 準則A\n2. 準則B');
        assert.equal(cor.getActiveCorrections(), null);
    });

    test('歸納 LLM 失敗 → 退回「錯 → 對」原文當準則，仍標 merged', async () => {
        llmImpl = async () => { throw new Error('llm down'); };
        for (let i = 0; i < 10; i++) cor.recordCorrection({ targetType: 'hallucination', wrongSummary: `w${i}`, correctSummary: `c${i}` });
        await waitFor(() => rows('correction_log', "WHERE status='merged'").length === 10);
        const setting = JSON.parse(db.prepare("SELECT setting_value FROM user_settings WHERE setting_key='scribe_guidelines'").get().setting_value);
        assert.equal(setting.guidelines.length, 10);
        assert.equal(setting.guidelines[0], 'w0 → c0');
    });

    test('mergeGuidelines：LLM 呼叫期間新進的修正不被誤標 merged（只標送進 LLM 的那批）', async () => {
        for (let i = 0; i < 10; i++) db.prepare("INSERT INTO correction_log (target_type, wrong_summary, correct_summary, source, status) VALUES ('hallucination', ?, 'c', 'manual', 'active')").run(`w${i}`);
        llmImpl = async () => {
            db.prepare("INSERT INTO correction_log (target_type, wrong_summary, correct_summary, source, status) VALUES ('hallucination', '中途新進', 'c', 'manual', 'active')").run();
            return { reply: '{"guidelines":["g"]}' };
        };
        await cor.mergeGuidelines();
        assert.equal(rows('correction_log', "WHERE status='merged'").length, 10);
        const active = rows('correction_log', "WHERE status='active'");
        assert.equal(active.length, 1);
        assert.equal(active[0].wrong_summary, '中途新進');
    });

    test('mergeGuidelines 直接呼叫：不足 10 條 → null 且不呼叫 LLM', async () => {
        for (let i = 0; i < 3; i++) cor.recordCorrection({ targetType: 'hallucination', wrongSummary: 'w', correctSummary: 'c' });
        assert.equal(await cor.mergeGuidelines(), null);
        assert.equal(llmCalls.length, 0);
    });

    test('getMergedGuidelines：沒設定 → null', async () => {
        assert.equal(await cor.getMergedGuidelines(), null);
    });
});

describe('processChatCorrection', () => {
    test('缺引數 → success:false，不動 DB', async () => {
        const r = await cor.processChatCorrection({ wrongStatement: '', correction: 'x' });
        assert.equal(r.success, false);
        assert.match(r.formatted, /wrong_statement/);
        assert.equal((await cor.processChatCorrection({ wrongStatement: 'x' })).success, false);
        assert.equal(rows('correction_log').length, 0);
    });

    test('無候選（幻覺）：不呼叫 LLM；新增 correction 碎片、寫 Chroma、記 hallucination、寫 changelog', async () => {
        const r = await cor.processChatCorrection({ wrongStatement: '你養了貓', correction: '我沒有養貓', chatId: 42 });
        assert.equal(llmCalls.length, 0);
        const frag = rows('memory_fragments')[0];
        assert.equal(frag.type, 'correction');
        assert.equal(frag.entity, USER.name);
        assert.equal(frag.content, '我沒有養貓');
        assert.equal(frag.emotional_weight, 0.7);
        assert.equal(frag.source, 'chat_correction');
        assert.equal(frag.layer, 'event');
        assert.equal(frag.status, 'active');
        assert.equal(frag.source_msg_ids, '[]');
        const log = rows('correction_log')[0];
        assert.equal(log.target_type, 'hallucination');
        assert.equal(log.target_id, null);
        assert.equal(log.source, 'chat_correction');
        assert.equal(log.chat_message_id, 42);
        assert.equal(rows('ontology_changelog').length, 1);
        assert.equal(chromaCalls.length, 1);
        assert.equal(chromaCalls[0].op, 'index_batch');
        assert.equal(chromaCalls[0].payload.items[0].id, `fragment_${frag.id}`);
        assert.equal(r.success, true);
        assert.ok(r.formatted.includes(`#${frag.id}`));
        assert.match(r.formatted, /記憶庫裡沒有找到相關的記憶/);
    });

    test('Chroma 索引失敗不影響修正流程', async () => {
        chromaFail = true;
        const r = await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c' });
        assert.equal(r.success, true);
        assert.equal(rows('memory_fragments').length, 1);
        assert.equal(rows('correction_log').length, 1);
    });

    test('來自已存記憶（fragment，經 memoryId 取得候選）：記 target=fragment，寫入修正碎片；來源碎片維持 cooling（與回覆「已標記為降溫」一致）', async () => {
        const src = addFrag('你養了貓');
        llmImpl = judged({ matched: true, memory_id: src, source_table: 'fragment', corrected_content: '他沒有養貓', explanation: '來自碎片' });
        // memoryId 先查 memories 表；用不會撞號的做法：此測試 memories 表為空
        const r = await cor.processChatCorrection({ wrongStatement: '你養了貓', correction: '我沒有養貓', memoryId: src, chatId: 7 });
        assert.equal(r.success, true);
        assert.match(r.formatted, new RegExp(`#${src}`));
        // correction.js 把來源設為 cooling；recordCorrection(target=fragment) 不可再蓋成 consolidated
        const s = db.prepare('SELECT status, lifecycle_updated_at FROM memory_fragments WHERE id=?').get(src);
        assert.equal(s.status, 'cooling');
        assert.match(r.formatted, /降溫/);
        assert.ok(s.lifecycle_updated_at);
        const fixed = rows('memory_fragments', 'WHERE id != ' + src)[0];
        assert.equal(fixed.content, '他沒有養貓');
        assert.equal(fixed.type, 'correction');
        const log = rows('correction_log')[0];
        assert.equal(log.target_type, 'fragment');
        assert.equal(log.target_id, src);
        assert.equal(log.wrong_summary, '你養了貓');
        assert.equal(log.correct_summary, '我沒有養貓');   // 記的是使用者原文，不是 corrected_content
    });

    test('來自已存記憶（memory）：layer 設為 cooling，weight ×0.3，記 target=memory', async () => {
        const m = addMem(5);
        llmImpl = judged({ matched: true, memory_id: m, source_table: 'memory', corrected_content: '修正版', explanation: '' });
        const r = await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: m });
        assert.equal(r.success, true);
        const row = db.prepare('SELECT layer, weight FROM memories WHERE id=?').get(m);
        assert.equal(row.layer, 'cooling');
        assert.equal(row.weight, 1.5);
        const log = rows('correction_log')[0];
        assert.equal(log.target_type, 'memory');
        assert.equal(log.target_id, m);
        assert.match(r.formatted, /內容有誤/);   // explanation 為空時的預設文字
    });

    test('memoryId 同時存在於 memories 與 fragments 且未指定型別 → 兩筆都列為候選', async () => {
        const f = addFrag('碎片內容');
        const m = addMem();
        assert.equal(f, m); // 兩張表 id 皆從 1 起算
        llmImpl = async () => ({ reply: '{"matched":false}' });
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: m });
        const prompt = llmCalls[0][0][0].parts[0].text;
        assert.match(prompt, /id=1 source_table=memory/);
        assert.match(prompt, /id=1 source_table=fragment/);
    });

    test('memoryType 明確指定時只取該表（fragment / episode），撞號不再指錯', async () => {
        addFrag('碎片內容'); addMem();
        llmImpl = async () => ({ reply: '{"matched":false}' });
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: 1, memoryType: 'fragment' });
        let prompt = llmCalls[0][0][0].parts[0].text;
        assert.match(prompt, /source_table=fragment/);
        assert.doesNotMatch(prompt, /source_table=memory/);
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: 1, memoryType: 'episode' });
        prompt = llmCalls[1][0][0].parts[0].text;
        assert.match(prompt, /source_table=memory/);
        assert.doesNotMatch(prompt, /source_table=fragment/);
    });

    test('memoryId 可帶前綴（fragment_1 / memory_1 / episode_1），前綴優先於缺省行為', async () => {
        addFrag('碎片內容'); addMem();
        llmImpl = async () => ({ reply: '{"matched":false}' });
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: 'fragment_1' });
        const p1 = llmCalls[0][0][0].parts[0].text;
        assert.match(p1, /source_table=fragment/); assert.doesNotMatch(p1, /source_table=memory/);
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: 'episode_1' });
        const p2 = llmCalls[1][0][0].parts[0].text;
        assert.match(p2, /source_table=memory/); assert.doesNotMatch(p2, /source_table=fragment/);
    });

    test('撞號時 LLM 回 source_table=fragment → 修的是碎片，不動同號的 memory', async () => {
        addFrag('碎片內容'); const m = addMem(5);
        llmImpl = judged({ matched: true, memory_id: 1, source_table: 'fragment', corrected_content: 'x' });
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: 1 });
        assert.equal(db.prepare('SELECT status FROM memory_fragments WHERE id=1').get().status, 'cooling');
        const row = db.prepare('SELECT layer, weight FROM memories WHERE id=?').get(m);
        assert.notEqual(row.layer, 'cooling');
        assert.equal(row.weight, 5);
    });

    test('LLM 沒給 source_table 且兩表撞號無法判定 → 按幻聽處理', async () => {
        addFrag('碎片內容'); addMem();
        llmImpl = judged({ matched: true, memory_id: 1, source_table: null, corrected_content: 'x' });
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: 1 });
        assert.equal(rows('correction_log')[0].target_type, 'hallucination');
    });

    test('候選也來自工作記憶池與向量搜尋（去重），一併交給 LLM', async () => {
        recentPool = [{ id: 11, content: '池內碎片', source_table: 'fragment' }];
        vecResults = [
            { id: 11, _table: 'fragments', content: '重複' },
            { id: 12, _table: 'memories', title: '向量記憶' },
        ];
        llmImpl = async () => ({ reply: '{"matched":false}' });
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c' });
        const prompt = llmCalls[0][0][0].parts[0].text;
        assert.match(prompt, /\[0\] id=11 source_table=fragment\n內容: 池內碎片/);
        assert.match(prompt, /id=12 source_table=memory/);
        assert.doesNotMatch(prompt, /重複/);
    });

    test('LLM 判 matched=false（幻聽）：記 hallucination、不動任何來源，仍寫入修正碎片（用 corrected_content）', async () => {
        const src = addFrag('無關碎片');
        llmImpl = judged({ matched: false, corrected_content: '第三人稱修正', explanation: '找不到' });
        const r = await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: src });
        assert.equal(db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(src).status, 'active');
        assert.equal(rows('correction_log')[0].target_type, 'hallucination');
        assert.equal(rows('memory_fragments', 'WHERE id != ' + src)[0].content, '第三人稱修正');
        assert.match(r.formatted, /1 條/);
    });

    test('matched=true 但 memory_id 為 null → 視為幻聽', async () => {
        addFrag('候選');
        llmImpl = judged({ matched: true, memory_id: null, corrected_content: 'x' });
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: 1 });
        assert.equal(rows('correction_log')[0].target_type, 'hallucination');
    });

    test('LLM 呼叫失敗 → 「LLM呼叫失敗，按幻聽處理」，用使用者原文當修正內容', async () => {
        addFrag('候選');
        llmImpl = async () => { throw new Error('timeout'); };
        const r = await cor.processChatCorrection({ wrongStatement: 'w', correction: '原文修正', memoryId: 1 });
        assert.equal(rows('correction_log')[0].target_type, 'hallucination');
        assert.equal(rows('memory_fragments', "WHERE type='correction'")[0].content, '原文修正');
        assert.match(r.formatted, /LLM呼叫失敗，按幻聽處理/);
    });

    test('LLM 回非 JSON → 「解析失敗，按幻聽處理」', async () => {
        addFrag('候選');
        llmImpl = async () => ({ reply: '不是 json' });
        const r = await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: 1 });
        assert.equal(rows('correction_log')[0].target_type, 'hallucination');
        assert.match(r.formatted, /解析失敗，按幻聽處理/);
    });

    test('LLM 回傳的 memory_id 不在候選內 → 走幻聽路徑，不對該 id 動手、target 不記假 id', async () => {
        const c = addFrag('候選');
        const other = addFrag('存在但不是候選');
        for (const bad of [999, other]) {
            llmImpl = judged({ matched: true, memory_id: bad, source_table: 'fragment', corrected_content: 'x', explanation: '亂編' });
            const r = await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: c });
            assert.equal(r.success, true);
            assert.match(r.formatted, /編造或混淆/);
        }
        assert.ok(rows('correction_log').every(l => l.target_type === 'hallucination' && l.target_id === null));
        assert.equal(db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(other).status, 'active');
    });

    test('source_table 非 memory 一律當 fragment（含 null）', async () => {
        const f = addFrag('候選');
        llmImpl = judged({ matched: true, memory_id: f, source_table: null, corrected_content: 'x' });
        await cor.processChatCorrection({ wrongStatement: 'w', correction: 'c', memoryId: f });
        assert.equal(rows('correction_log')[0].target_type, 'fragment');
    });

    test('端到端：第 10 條 chat 修正觸發歸納（歸納 LLM 為 stub）', async () => {
        llmImpl = async () => ({ reply: '{"guidelines":["只留一條"]}' });
        for (let i = 0; i < 10; i++) await cor.processChatCorrection({ wrongStatement: `w${i}`, correction: `c${i}` });
        await waitFor(() => rows('correction_log', "WHERE status='merged'").length === 10);
        assert.equal(await cor.getMergedGuidelines(), '1. 只留一條');
    });
});
