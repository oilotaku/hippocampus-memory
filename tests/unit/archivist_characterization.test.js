'use strict';
// W7 拆分安全網：services/archivist.js 的特性測試。
// 1) 純函式與註冊表的明確斷言；2) 一段固定情境（播種資料 → 逐一呼叫匯出的任務 →
//    跑三個 agent tick）的完整指紋，與 tests/unit/fixtures/archivist_scenario.json 比對。
// 指紋記錄的是「拆分前的現況」，包含現有的錯誤訊息（例如 aggregateLink 的
// 「db is not defined」、classify 的 SQL 語法錯）——那些是既有行為，不是這次要修的。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, rawMemoryPlaintext } = require('./_helpers');
const { captureConsole, llmRecord, dumpTables, checkFingerprint, normValue, hash } = require('./_fingerprint');

const dbPath = setupEnv('archivist-char');
const logs = [];
const llmCalls = [];
const chromaCalls = [];
let restore, db, a, USER, AI;
let llmReply = '[]';

before(() => {
    restore = captureConsole(logs);
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    // 記憶體閘門讀 os.freemem()，固定成充足值，指紋才不受測試機當下記憶體影響
    require('os').freemem = () => 8 * 1024 * 1024 * 1024;
    // archivist 載入時解構 callLLM / chromaDBOperation，必須在 require 之前換掉
    const memory = require('../../services/memory');
    memory.chromaDBOperation = async (op) => { chromaCalls.push(op); return {}; };
    memory.searchMemoriesByVector = async () => [];
    require('../../services/llm').callLLM = async (...args) => { llmCalls.push(llmRecord(args)); return { reply: llmReply }; };
    ({ USER, AI } = require('../../services/memoryConfig'));
    a = require('../../services/archivist');
    logs.length = 0;
});
after(() => { try { a.stop(); } catch (_) {} restore(); cleanupDb(dbPath); });

// W3：播種經 sealField（MEMORY_ENCRYPTION=on 時存密文），模擬真實加密庫；
// 指紋由 dumpTables 經透明解密層取得，所以與加密前錄的指紋相同 = 差異只來自加密。
const seal = (t, c, v) => require('../../services/memoryCrypto').sealField(t, c, v);

function seed() {
    const ins = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases, tags, fragment_count, relationship_to_user, current_status, created_at, updated_at, last_mentioned_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?), date('now', ?))`);
    const ent = {};
    const rows = [
        [USER.name, 'person', 'active', '[]', '[]', 6, null, '', '-60 days', '-3 days', '-1 days'],
        [AI.name, 'person', 'active', '[]', '[]', 2, null, '', '-60 days', '-3 days', '-1 days'],
        ['阿明', 'person', 'active', '["明哥"]', '["同事"]', 5, '同事', '最近在忙專案', '-40 days', '-10 days', '-2 days'],
        ['阿明哥', 'person', 'seed', '[]', '[]', 1, null, null, '-5 days', '-5 days', '-5 days'],
        ['一蘭拉麵', 'place', 'active', '["一蘭"]', '[]', 3, null, null, '-30 days', '-20 days', '-2 days'],
        ['週年旅行', 'event', 'seed', '[]', '[]', 2, null, null, '-8 days', '-8 days', '-8 days'],
        ['三月', 'event', 'seed', '[]', '[]', 1, null, null, '-8 days', '-8 days', '-8 days'],
        ['冬季', 'event', 'seed', '[]', '[]', 1, null, null, '-8 days', '-8 days', '-8 days'],
    ];
    for (const r of rows) ent[r[0]] = Number(ins.run(...r.slice(0, 7), seal('entity_profiles', 'current_status', r[7]), ...r.slice(8)).lastInsertRowid);

    const frag = db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, created_at, source_msg_ids, value_tags, source_date)
        VALUES (?, ?, ?, ?, datetime('now', ?), ?, ?, date('now', ?))`);
    const link = db.prepare(`INSERT INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, ?, ?, ?)`);
    const fr = {};
    const frs = [
        ['f1', 'event', USER.name, '今天和阿明去一蘭拉麵吃宵夜，明哥說專案終於上線了', 0.6, '-1 days', '[1,2]', '[]', link => { link(ent['阿明'], 'appeared_in'); link(ent['一蘭拉麵'], 'visited'); link(ent[USER.name], 'about'); }],
        ['f2', 'event', USER.name, '阿明又加班到半夜，說下個月要去週年旅行', 0.5, '-2 days', '[3]', '[]', link => { link(ent['阿明'], 'appeared_in'); }],
        ['f3', 'trait', USER.name, '我每次壓力大就想吃拉麵', 0.7, '-3 days', '[4]', '["health"]', link => { link(ent[USER.name], 'about'); }],
        ['f4', 'event', USER.name, '週年旅行訂了京都的旅館', 0.8, '-4 days', '[5]', '[]', () => {}],
        ['f5', 'event', USER.name, '一蘭的豚骨湯頭還是一樣濃', 0.4, '-5 days', '[6]', '[]', () => {}],
        ['f6', 'feeling', USER.name, '最近睡不好，覺得有點焦慮', 0.9, '-1 days', '[7]', '["health"]', link => { link(ent[USER.name], 'about'); }],
        ['f7', 'event', USER.name, '和明哥討論新的架構設計', 0.5, '-6 days', '[8]', '[]', () => {}],
        ['f8', 'event', USER.name, '三月的時候天氣很冷', 0.2, '-7 days', '[9]', '[]', () => {}],
    ];
    for (const [k, type, entity, content, ew, ago, msgs, tags, links] of frs) {
        const id = Number(frag.run(type, entity, seal('memory_fragments', 'content', content), ew, ago, msgs, tags, ago).lastInsertRowid);
        fr[k] = id;
        links((eid, rel) => link.run(id, eid, rel, 0.8, 'test_seed'));
    }
    db.prepare("INSERT OR IGNORE INTO chats (id, name) VALUES (1, 'w7')").run();
    const msg = db.prepare(`INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted) VALUES (1, ?, ?, datetime('now', ?), 0)`);
    for (let i = 0; i < 12; i++) msg.run(i % 2 ? 'ai' : 'user', `第${i}句：今天和阿明吃拉麵，聊了很多工作的事`, `-${2 + i} days`);
    db.prepare(`INSERT INTO memories (title, content, tags, weight, status, entity_id, created_at) VALUES (?, ?, '[]', 5, 'permanent', ?, datetime('now','-1 days'))`)
        .run(seal('memories', 'title', '拉麵宵夜'), seal('memories', 'content', '和阿明吃一蘭'), ent['阿明']);
    db.prepare(`INSERT INTO user_patterns (content, category, evidence_count, first_seen, last_seen, confidence) VALUES ('壓力大時會吃拉麵', 'behavior', 3, datetime('now','-20 days'), datetime('now','-3 days'), 0.5)`).run();
    return { ent, fr };
}

describe('archivist 純函式與註冊表', () => {
    test('守衛規則：時間短語、期間短語、無變化哨兵', () => {
        assert.equal(a.isTimePhraseName('三月'), true);
        assert.equal(a.isTimePhraseName('昨天晚上'), true);
        assert.equal(a.isTimePhraseName('阿明'), false);
        assert.equal(a.isPeriodPhraseName('冬季'), true);
        assert.equal(a.isPeriodPhraseName('考试期'), true);
        assert.equal(a.isPeriodPhraseName('一蘭拉麵'), false);
        assert.equal(a.isNoChangeSentinel('无明显变化。'), true);
        assert.equal(a.isNoChangeSentinel('暂无'), true);
        assert.equal(a.isNoChangeSentinel('最近在忙專案'), false);
    });

    test('別名門檻：_mentionWeight 與 _aliasAmbiguous', () => {
        assert.equal(a._mentionWeight('阿明'), 2);
        assert.equal(a._mentionWeight('abc'), 1.5);
        assert.equal(a._mentionWeight('阿明abc'), 3.5);
        const owners = new Map([['阿明', new Set([1])], ['阿明哥', new Set([2])], ['一蘭', new Set([3])], ['一蘭拉麵', new Set([3])]]);
        assert.equal(a._aliasAmbiguous(1, '阿明', owners), true);
        assert.equal(a._aliasAmbiguous(2, '阿明哥', owners), true);
        assert.equal(a._aliasAmbiguous(3, '一蘭', owners), false);
    });

    test('涌现判據：prompt 內容與 verdict 篩選', () => {
        const p = a.buildEmergentJudgePrompt('樣本文字', 7, '（無）');
        assert.match(p, /樣本文字/);
        assert.match(p, /7/);
        for (const v of [null, {}, { is_entity: false }, { is_entity: true, name: '阿明', category: 'person' },
            { is_entity: true, name: '一蘭拉麵', category: 'place' }, { is_entity: true, name: '三月', category: 'event' }]) {
            assert.doesNotThrow(() => a.screenEmergentVerdict(v));
        }
    });

    test('工具註冊表：載入時註冊 8 個工具、冷卻設定、getStatus 形狀', () => {
        const names = a.listTools().map(t => t.name);
        assert.deepEqual(names, ['classify_fragments', 'discover_relationships', 'extract_insights',
            'detect_emergent_places_events', 'regenerate_entity_overviews', 'maintain_patterns',
            'cluster_observations', 'consolidate_category']);
        const mp = a.getTool('maintain_patterns');
        assert.equal(typeof mp.handler, 'function');
        assert.equal(mp.handler, a.maintainPatterns);
        assert.equal(a.getTool('classify_fragments').handler, a.classifyFragments);
        const st = a.getStatus();
        assert.deepEqual(Object.keys(st), ['running', 'companionActive', 'inTick', 'dailyLLMCalls', 'totalClassified', 'totalTasksRun', 'lastTick', 'tools']);
        assert.equal(st.running, false);
        assert.equal(st.lastTick, 'idle');
        a.registerTool('w7_probe', async () => 1, '測試用');
        assert.equal(a.getTool('w7_probe').description, '測試用');
        assert.ok(a.getStatus().tools.includes('w7_probe'));
    });

    test('Companion 活動旗標', () => {
        assert.equal(a.isCompanionActive(), false);
        a.setCompanionActive(true);
        assert.equal(a.isCompanionActive(), true);
        assert.equal(a.getStatus().companionActive, true);
        a.setCompanionActive(false);
        assert.equal(a.isCompanionActive(), false);
        a.resetTickBudget();
    });

    test('archivistEvents 是同一個 EventEmitter，maxListeners=20', () => {
        assert.equal(a.archivistEvents.getMaxListeners(), 20);
        assert.equal(require('../../services/archivist').archivistEvents, a.archivistEvents);
    });
});

describe('archivist 固定情境指紋（拆分前後必須完全相同）', () => {
    test('播種 → 逐一呼叫任務 → 三個 tick → 資料庫終態', async () => {
        logs.length = 0; llmCalls.length = 0; chromaCalls.length = 0;
        const { ent } = seed();
        const fp = {};
        const step = async (name, fn) => {
            logs.length = 0; llmCalls.length = 0; chromaCalls.length = 0;
            let result;
            try { result = { ok: normValue(await fn()) }; } catch (e) { result = { threw: normValue(e) }; }
            fp[name] = { result, llm: [...llmCalls], chroma: [...chromaCalls], logs: [...logs] };
        };

        await step('emergentPrompt', () => {
            const p = a.buildEmergentJudgePrompt('樣本文字', 7, '（無）');
            return { h: hash(p), len: p.length, verdicts: [null, {}, { is_entity: false }, { is_entity: true, name: '阿明', category: 'person' },
                { is_entity: true, name: '一蘭拉麵', category: 'place', confidence: 0.9 }, { is_entity: true, name: '三月', category: 'event' }]
                .map(v => { try { return a.screenEmergentVerdict(v); } catch (e) { return 'threw:' + e.message; } }) };
        });
        await step('entityMentionOwners', () => {
            const m = a._entityMentionOwners(db);
            return [...m.entries()].map(([k, v]) => [k, [...v].sort((x, y) => x - y)]).sort();
        });
        await step('ensureTagEntities', () => a.ensureTagEntities(db));
        await step('linkTaggedFragments', () => a.linkTaggedFragments(db));
        await step('reviewEntityRelations.dry', () => a.reviewEntityRelations({ dryRun: true }));
        await step('discoverTagRelations.dry', () => a.discoverTagRelations({ dryRun: true }));
        await step('classifyFragments', () => a.classifyFragments());
        await step('rematchFragmentsForSeeds', () => a.rematchFragmentsForSeeds());
        await step('semanticRematchForSeeds', () => a.semanticRematchForSeeds());
        await step('mergeDuplicateSeeds', () => a.mergeDuplicateSeeds());
        await step('discoverRelatedEntities', () => a.discoverRelatedEntities());
        await step('detectEmergentPlacesAndEvents', () => a.detectEmergentPlacesAndEvents());
        await step('refreshIntuitionStopwords', () => a.refreshIntuitionStopwords());
        await step('graduateSeedsAndPrune', () => a.graduateSeedsAndPrune());
        await step('maintainPatterns', () => a.maintainPatterns());
        await step('clusterObservations', () => a.clusterObservations());
        await step('spotCheckClassifications', () => a.spotCheckClassifications());
        await step('reviewConstellationAfterClassification', () => a.reviewConstellationAfterClassification(ent['阿明']));
        await step('discoverEntityRelationships', () => a.discoverEntityRelationships());
        await step('extractFragmentInsights', () => a.extractFragmentInsights());
        await step('regenerateEntityOverviews', () => a.regenerateEntityOverviews());
        await step('consolidateCategory', () => a.consolidateCategory());
        await step('scanContentForNewEntities', () => a.scanContentForNewEntities());
        await step('generateDailyEntityStatus', () => a.generateDailyEntityStatus());
        await step('reviewEntityRelations', () => a.reviewEntityRelations());
        await step('discoverTagRelations', () => a.discoverTagRelations());
        llmReply = '{}';
        await step('regenerateEntityOverviews.obj', () => a.regenerateEntityOverviews());
        await step('discoverEntityRelationships.obj', () => a.discoverEntityRelationships());
        llmReply = '[]';
        await step('classifyFragmentBatch', () => a.classifyFragmentBatch(
            db.prepare('SELECT * FROM memory_fragments ORDER BY id LIMIT 3').all(),
            db.prepare("SELECT * FROM entity_profiles WHERE status='active' ORDER BY id").all(), []));
        await step('executeEntityMerge', () => a.executeEntityMerge(ent['阿明'], ent['阿明哥']));

        // agent 迴圈：攔下 2 分鐘的 tick 計時器，手動逐次觸發
        const realST = global.setTimeout;
        const ticks = [];
        global.setTimeout = (fn, ms, ...rest) => (ms === 2 * 60 * 1000 ? (ticks.push(fn), { w7: true }) : realST(fn, ms, ...rest));
        try {
            await step('start', () => a.start());
            await step('event', async () => {
                const ids = db.prepare('SELECT id FROM memory_fragments ORDER BY id LIMIT 2').all().map(r => r.id);
                a.archivistEvents.emit('fragments:written', { fragmentIds: ids, sourceMsgIds: [1] });
                await new Promise(r => realST(r, 300));
                return a.getStatus();
            });
            for (let i = 0; i < 3; i++) {
                const fn = ticks.shift();
                await step('tick' + i, async () => { await fn(); return a.getStatus(); });
            }
            await step('stop', () => { a.stop(); return a.getStatus(); });
        } finally {
            global.setTimeout = realST;
        }

        fp.db = dumpTables(db, ['entity_profiles', 'fragment_entities', 'fragment_categories', 'memory_ontology',
            'memory_fragments', 'memories', 'entity_timeline', 'user_patterns', 'user_model', 'ontology_changelog',
            'user_settings', 'archivist_skills', 'memory_sagas']);
        checkFingerprint('archivist_scenario', fp);
        if (require('../../services/memoryCrypto').isEnabled()) assert.deepEqual(rawMemoryPlaintext(db), [], 'W3：記憶本體欄位不應有明文');
    });
});
