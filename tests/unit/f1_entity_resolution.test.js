'use strict';
// F1：實體解析修復 + archivist 四個既有錯誤的回歸測試。LLM / Chroma 全部 stub，不連網。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb } = require('./_helpers');

const dbPath = setupEnv('f1-entity');
const logs = [];
const origConsole = { log: console.log, warn: console.warn, error: console.error };
const capture = (lvl) => (...args) => { logs.push(`${lvl} ${args.join(' ')}`); };

let db, llmResolveMap = {};
const memory = require('../../services/memory');
memory.chromaDBOperation = async () => ({});
memory.searchMemoriesByVector = async () => [];
memory.getLocalEmbedding = async () => null;
const llm = require('../../services/llm');
let scribeEntries = [];
llm.callLLM = async (messages, systemPrompt) => {
    const text = JSON.stringify(messages);
    if (String(systemPrompt || '').includes('實體指代消解器')) {
        // 從 prompt 抓 [frag_N]，依內容關鍵字決定歸屬
        const res = [];
        for (const m of text.matchAll(/\[frag_(\d+)\][^\[]*?content=\\?"([^"\\]*)/g)) {
            const fid = Number(m[1]);
            const hit = Object.entries(llmResolveMap).find(([kw]) => m[2].includes(kw));
            res.push(hit ? { fragment_id: fid, entity_id: hit[1], entity_name: 'stub' } : { fragment_id: fid, entity_id: null });
        }
        return { reply: JSON.stringify({ resolutions: res }) };
    }
    return { reply: JSON.stringify({ entries: scribeEntries, fulfilled_intention_ids: [] }) };
};
const libPath = require.resolve('../../services/librarian');
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { searchHybrid: async () => [] } };

before(() => {
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    require('os').freemem = () => 8 * 1024 * 1024 * 1024;
    console.log = capture('L'); console.warn = capture('W'); console.error = capture('E');
});
after(() => { Object.assign(console, origConsole); cleanupDb(dbPath); });

describe('問題1：實體解析（Scribe 端到端）', () => {
    test('Scribe 寫入含實體的碎片後，fragment_entities 連到正確實體（關鍵詞 / LLM / 派生）', async () => {
        const ins = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases, related_entities, fragment_count)
            VALUES (?, 'person', 'active', ?, ?, 0)`);
        const xiaohua = Number(ins.run('小華', '[]', '[]').lastInsertRowid);
        const amin = Number(ins.run('阿明', '["明哥"]', JSON.stringify([{ id: xiaohua, name: '小華', relation: '同學', shared_count: 3 }])).lastInsertRowid);
        const alan = Number(ins.run('阿倫', '[]', '[]').lastInsertRowid);
        llmResolveMap = { '請了病假': alan };

        const { runScribe } = require('../../services/scribe');
        scribeEntries = [
            { type: 'fact', entities: [{ name: '某位同事' }], content: '明哥今天帶了自己做的便當來公司', emotional_weight: 0.3, value_tags: [], source: 'chat', quote: '明哥今天帶了自己做的便當' },
            { type: 'fact', entities: [{ name: '某位同事' }], content: '那位室友這週請了病假在家休息', emotional_weight: 0.3, value_tags: [], source: 'chat', quote: '那位室友這週請了病假' },
        ];
        logs.length = 0;
        const r = await runScribe([
            { id: 1, sender: 'user', content: '明哥今天帶了自己做的便當，那位室友這週請了病假', timestamp: '2026-05-01 10:00:00', message_type: 'text', is_encrypted: 0 },
        ], '2026-05-01 10:00:00');
        assert.equal(r.written, 2);

        assert.equal(logs.filter(l => /實體解析失敗/.test(l)).length, 0, `不應再有實體解析失敗：${logs.filter(l => /失敗/.test(l))}`);
        // content 在 MEMORY_ENCRYPTION=on 時是密文，不能 LIKE；依寫入順序取碎片（第 1 條便當、第 2 條病假）
        const fids = db.prepare('SELECT id FROM memory_fragments ORDER BY id').all().map(x => x.id);
        assert.equal(fids.length, 2);
        const linkOf = (i) => db.prepare(`SELECT entity_id, relation, classified_by FROM fragment_entities
            WHERE fragment_id = ? ORDER BY entity_id`).all(fids[i]);
        const kw = linkOf(0);
        assert.deepEqual(kw.map(x => [x.entity_id, x.classified_by]).sort(), [[xiaohua, 'resolver.derived'], [amin, 'resolver.keyword']].sort());
        assert.equal(kw.find(x => x.entity_id === xiaohua).relation, `derived_from:${amin}`);
        const llmLinks = linkOf(1);
        assert.deepEqual(llmLinks.map(x => [x.entity_id, x.classified_by]), [[alan, 'resolver.llm']]);
    });
});

describe('問題2：archivist 四個既有錯誤', () => {
    let a;
    before(() => { a = require('../../services/archivist'); });

    test('classifyFragments 空庫不再報 SQL 語法錯', async () => {
        db.prepare('DELETE FROM fragment_entities').run();
        db.prepare('DELETE FROM memory_fragments').run();
        const r = await a.classifyFragments();
        assert.deepEqual(r, { classified: 0 });
    });

    test('discoverRelatedEntities 不再報 Too few parameter values', async () => {
        const r = await a.discoverRelatedEntities();
        assert.equal(typeof r.discovered, 'number');
    });

    test('agentTick 的 aggregateLink 不再報 db is not defined', async () => {
        const realST = global.setTimeout;
        const ticks = [];
        global.setTimeout = (fn, ms, ...rest) => (ms === 2 * 60 * 1000 ? (ticks.push(fn), { f1: true }) : realST(fn, ms, ...rest));
        try {
            logs.length = 0;
            await a.start();
            await ticks.shift()();
            a.stop();
        } finally { global.setTimeout = realST; }
        const bad = logs.filter(l => /aggregateLink 失敗|db is not defined/.test(l));
        assert.deepEqual(bad, []);
    });

    test('認知模型週期缺少 spotCheckModel 腳本時安全略過，不再報 Cannot find module', async () => {
        const { runUserModelCycle } = require('../../services/cognitiveModel');
        logs.length = 0;
        const r = await runUserModelCycle();
        assert.equal(logs.filter(l => /autoSpotCheck error|Cannot find module/.test(l)).length, 0);
        assert.deepEqual(r.spotCheck, { checked: 0 });
    });
});
