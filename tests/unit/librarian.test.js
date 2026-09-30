'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('librarian');
let restore, db, lib;
let vecResults = [];      // 向量通道 stub 的回傳
let vecThrows = false;
let boostMap = new Map(); // workingMemory stub
const realRandom = Math.random;

before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    // 向量通道／工作記憶：用模組屬性 stub（librarian 是在函式內 require，拿到同一個 exports 物件）
    const memory = require('../../services/memory');
    memory.searchMemoriesByVector = async () => {
        if (vecThrows) throw new Error('chroma down');
        return vecResults;
    };
    const wm = require('../../services/workingMemory');
    wm.getBoostMap = async () => boostMap;
    lib = require('../../services/librarian');
    Math.random = () => 0.99; // 關掉「隨機浮現」
});

after(() => {
    Math.random = realRandom;
    restore();
    cleanupDb(dbPath);
});

beforeEach(() => {
    vecResults = [];
    vecThrows = false;
    boostMap = new Map();
    db.exec('DELETE FROM fragment_entities; DELETE FROM memory_fragments; DELETE FROM memories; DELETE FROM entity_profiles;');
});

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

function addFrag({ content, ew = 0.5, daysAgo = 0, readCount = 0, status = 'active', source = 'chat' }) {
    // G1：novelty 看 injected_count（舊資料庫由 v113 以 read_count 初始化），測試沿用 readCount 語意兩欄同步
    return Number(db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, status, created_at, read_count, injected_count)
        VALUES ('event', 'X', ?, ?, ?, ?, ?, ?, ?)`).run(content, ew, source, status, iso(daysAgo), readCount, readCount).lastInsertRowid);
}

// 與 librarian.js 內部公式一致的參考實作（內部函式未 export，這裡照抄以驗證數值）
function refDecay(days, ew) {
    const lambda = ew >= 0.8 ? 0.005 : ew >= 0.6 ? 0.01 : ew >= 0.4 ? 0.02 : 0.04;
    const timeDecay = Math.exp(-lambda * days);
    const retention = 0.3 + ew * 0.7;
    return days <= 3 ? 0.7 * timeDecay + 0.3 * retention : 0.3 * timeDecay + 0.7 * retention;
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-3 + 1e-9, `${msg || ''} got ${a} want ${b}`);

// ─────────────────────────────────────────────
describe('classifyIntent', () => {
    const cases = [
        ['', 'semantic'], [null, 'semantic'], ['   ', 'semantic'],
        ['你好啊', 'semantic'],
        ['還記得那家店嗎', 'long_term'],
        ['以前看過什麼書', 'long_term'],               // long_term 優先於 fact（「什麼」）
        ['最近在忙什麼', 'summary'],                     // summary 優先於 fact
        ['我們聊了什麼', 'summary'],
        ['之前最近', 'long_term'],                       // long_term > summary
        ['電話是多少', 'fact'],
        ['他住哪裡', 'fact'],
        ['花了30元', 'fact'],                            // 數字 + 單位
        ['今年 25 歲', 'fact'],
        ['我很開心', 'semantic'],
    ];
    for (const [q, want] of cases) {
        test(`${JSON.stringify(q)} → ${want}`, () => assert.equal(lib.classifyIntent(q), want));
    }
    // W9：外部輸入的意圖關鍵字簡繁都要命中（下面是刻意保留的簡體輸入）
    const simplifiedCases = [
        ['还记得那家店吗', 'long_term'],
        ['以前看过什么书', 'long_term'],
        ['最近在忙什么', 'summary'],
        ['我们聊了什么', 'summary'],
        ['这段时间进展如何', 'summary'],
        ['电话是多少', 'fact'],
        ['他住哪里', 'fact'],
        ['今年 25 岁', 'fact'],
        ['花了30块', 'fact'],
        ['我很开心', 'semantic'],
    ];
    for (const [q, want] of simplifiedCases) {
        test(`簡體輸入 ${JSON.stringify(q)} → ${want}`, () => assert.equal(lib.classifyIntent(q), want));
    }
    test('繁體「還記得」命中 long_term，簡體「还记得」同樣命中', () => {
        assert.equal(lib.classifyIntent('還記得那家店嗎'), 'long_term');
        assert.equal(lib.classifyIntent('还记得那家店吗'), 'long_term');
    });
});

// ─────────────────────────────────────────────
// computePermission 未 export → 透過 formatHybridContext 的輸出首行觀察
describe('computePermission（經 formatHybridContext 觀察）', () => {
    const perm = (f) => {
        const out = lib.formatHybridContext([{ id: 1, source_table: 'fragment', content: 'c', ...f }]);
        return /^※ (\S+) · /.exec(out)[1];
    };
    test('_isFloated → 僅聯想（即使其他條件都最好）', () =>
        assert.equal(perm({ _isFloated: true, _daysAgo: 1, _confidence: 'high', _source: 'BOTH' }), '僅聯想'));
    test('days >= 90 → 僅聯想', () => {
        assert.equal(perm({ _daysAgo: 90, _confidence: 'high', _source: 'BOTH' }), '僅聯想');
        assert.equal(perm({ _daysAgo: 89, _confidence: 'high', _source: 'BOTH' }), '需謹慎');
    });
    test('沒有天數資訊 → 視為 999 天 → 僅聯想', () =>
        assert.equal(perm({ _confidence: 'high', _source: 'BOTH' }), '僅聯想'));
    test('_daysOld 可替代 _daysAgo；_daysAgo=0 不被當成缺值', () => {
        assert.equal(perm({ _daysOld: 5, _confidence: 'high', _source: 'BOTH' }), '可引用');
        assert.equal(perm({ _daysAgo: 0, _daysOld: 200, _confidence: 'high', _source: 'BOTH' }), '可引用');
    });
    test('confidence low 或預設 → 僅聯想', () => {
        assert.equal(perm({ _daysAgo: 1, _confidence: 'low', _source: 'BOTH' }), '僅聯想');
        assert.equal(perm({ _daysAgo: 1, _source: 'BOTH' }), '僅聯想');
    });
    test('high + <30天 + BOTH → 可引用；30 天邊界 → 需謹慎', () => {
        assert.equal(perm({ _daysAgo: 29, _confidence: 'high', _source: 'BOTH' }), '可引用');
        assert.equal(perm({ _daysAgo: 30, _confidence: 'high', _source: 'BOTH' }), '需謹慎');
    });
    test('high 但單一來源 → 需謹慎', () => {
        for (const src of ['VEC', 'FTS5', 'FTS5*', 'ENTITY', 'ENTITY+VEC']) {
            assert.equal(perm({ _daysAgo: 1, _confidence: 'high', _source: src }), '需謹慎', src);
        }
    });
    test('medium + BOTH + 新 → 需謹慎', () =>
        assert.equal(perm({ _daysAgo: 1, _confidence: 'medium', _source: 'BOTH' }), '需謹慎'));
});

describe('formatHybridContext 輸出格式', () => {
    test('空輸入 → null', () => {
        assert.equal(lib.formatHybridContext([]), null);
        assert.equal(lib.formatHybridContext(null), null);
    });
    test('單筆：「※ 許可權 · #id · N天前\\n內容」；無天數顯示 ?', () => {
        const out = lib.formatHybridContext([{ id: 7, source_table: 'fragment', content: '內容A', _daysAgo: 3, _confidence: 'medium', _source: 'VEC' }]);
        assert.equal(out, '※ 需謹慎 · #7 · 3天前\n內容A');
        const out2 = lib.formatHybridContext([{ id: 8, source_table: 'fragment', content: 'B' }]);
        assert.equal(out2, '※ 僅聯想 · #8 · ?\nB');
    });
    test('碎片被注入後 read_count +1、last_accessed_at 被寫入', () => {
        const id = addFrag({ content: 'read me' });
        lib.formatHybridContext([{ id, source_table: 'fragment', content: 'read me', _daysAgo: 1 }]);
        const r = db.prepare('SELECT read_count, last_accessed_at FROM memory_fragments WHERE id=?').get(id);
        assert.equal(r.read_count, 1);
        assert.ok(r.last_accessed_at);
    });
    test('episode（memory）內容會解密', () => {
        const { encryption } = require('../../encryption');
        const out = lib.formatHybridContext([{ id: 1, source_table: 'memory', content: encryption.encrypt('秘密'), _daysAgo: 1 }]);
        assert.ok(out.endsWith('\n秘密'));
    });
    test('多實體：分組標頭、【其他】、兩個 person 時附跨人物告警', () => {
        const a = addFrag({ content: 'a' }), b = addFrag({ content: 'b' }), c = addFrag({ content: 'c' });
        const eA = Number(db.prepare("INSERT INTO entity_profiles (name, category) VALUES ('小甲','person')").run().lastInsertRowid);
        const eB = Number(db.prepare("INSERT INTO entity_profiles (name, category) VALUES ('小乙','person')").run().lastInsertRowid);
        db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id) VALUES (?,?)').run(a, eA);
        db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id) VALUES (?,?)').run(b, eB);
        const mk = (id, content) => ({ id, source_table: 'fragment', content, _daysAgo: 1 });
        const out = lib.formatHybridContext([mk(a, 'a'), mk(b, 'b'), mk(c, 'c')]);
        assert.ok(out.includes('【關於 小甲】'));
        assert.ok(out.includes('【關於 小乙】'));
        assert.ok(out.includes('【其他】'));
        assert.ok(out.includes('⚠️ 以上記憶涉及不同的人（小甲、小乙），不要混為一談。'));
    });
    test('單一實體且無未分組碎片 → 不加分組標頭', () => {
        const a = addFrag({ content: 'a' }), b = addFrag({ content: 'b' });
        const e = Number(db.prepare("INSERT INTO entity_profiles (name, category) VALUES ('小甲','person')").run().lastInsertRowid);
        db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id) VALUES (?,?)').run(a, e);
        db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id) VALUES (?,?)').run(b, e);
        const out = lib.formatHybridContext([{ id: a, source_table: 'fragment', content: 'a' }, { id: b, source_table: 'fragment', content: 'b' }]);
        assert.ok(!out.includes('【'));
    });
});

// ─────────────────────────────────────────────
describe('searchFragments（FTS5）', () => {
    test('空查詢 → []', () => {
        assert.deepEqual(lib.searchFragments(''), []);
        assert.deepEqual(lib.searchFragments('   '), []);
    });
    test('CJK 單字粒度命中；非 active 狀態不回傳', () => {
        const a = addFrag({ content: '我喜歡蘋果派' });
        addFrag({ content: '我喜歡蘋果派', status: 'cooling' });
        const r = lib.searchFragments('蘋果');
        assert.deepEqual(r.map(x => x.id), [a]);
        assert.equal(r[0].source_table, 'fragment');
    });
    test('limit 生效', () => {
        for (let i = 0; i < 5; i++) addFrag({ content: `蘋果 ${i}` });
        assert.equal(lib.searchFragments('蘋果', 3).length, 3);
    });
    test('episode：只回 layer=episode 且 status=permanent，weight = weight/10', () => {
        db.prepare("INSERT INTO memories (title, content, tags, weight, status, layer) VALUES ('蘋果派食譜','c','[]',8,'permanent','episode')").run();
        db.prepare("INSERT INTO memories (title, content, tags, weight, status, layer) VALUES ('蘋果派舊','c','[]',8,'archived','episode')").run();
        const r = lib.searchFragments('蘋果派');
        assert.equal(r.length, 1);
        assert.equal(r[0].source_table, 'memory');
        assert.equal(r[0].weight, 0.8);
    });
});

// ─────────────────────────────────────────────
describe('lookupEntityIds / getEntityFragments', () => {
    test('標準名、別名（>=2 字）命中；單字別名被忽略；大小寫不敏感', async () => {
        const eA = Number(db.prepare("INSERT INTO entity_profiles (name, category, aliases) VALUES ('Alice','person','[\"艾莉\",\"A\"]')").run().lastInsertRowid);
        assert.deepEqual(await lib.lookupEntityIds('今天見了 alice'), [eA]);
        assert.deepEqual(await lib.lookupEntityIds('艾莉來了'), [eA]);
        assert.deepEqual(await lib.lookupEntityIds('A'), []);   // 單字別名 + 語意降級模組不存在 → 空
    });
    test('活動詞 → 聚合實體（先於名稱匹配）；status 非 active/seed 的實體不參與', async () => {
        const eF = Number(db.prepare("INSERT INTO entity_profiles (name, category) VALUES ('觀影','activity')").run().lastInsertRowid);
        db.prepare("INSERT INTO entity_profiles (name, category, status) VALUES ('已合併','person','merged')").run();
        assert.deepEqual(await lib.lookupEntityIds('週末想看電影'), [eF]);
        assert.deepEqual(await lib.lookupEntityIds('已合併'), []);
    });
    test('getEntityFragments：只取 active、created_at 由新到舊、limit', () => {
        const e = Number(db.prepare("INSERT INTO entity_profiles (name) VALUES ('E')").run().lastInsertRowid);
        const old = addFrag({ content: 'old', daysAgo: 5 });
        const nw = addFrag({ content: 'new', daysAgo: 1 });
        const cool = addFrag({ content: 'cool', status: 'cooling' });
        for (const f of [old, nw, cool]) db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id) VALUES (?,?)').run(f, e);
        assert.deepEqual(lib.getEntityFragments([e]).map(r => r.id), [nw, old]);
        assert.equal(lib.getEntityFragments([e], 1).length, 1);
        assert.deepEqual(lib.getEntityFragments([]), []);
    });
});

// ─────────────────────────────────────────────
describe('daysAgo：DB 的 UTC 時間字串', () => {
    const pad = (n) => String(n).padStart(2, '0');
    const dbStr = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
    test('datetime("now") 格式在非 UTC 時區（UTC+8）也以 UTC 解析：1 天前 ≈ 1 天', () => {
        const oldTz = process.env.TZ;
        process.env.TZ = 'Asia/Taipei';
        try {
            const d = lib.daysAgo(dbStr(Date.now() - DAY));
            assert.ok(Math.abs(d - 1) < 0.01, `got ${d}`);
            assert.ok(Math.abs(lib.daysAgo(dbStr(Date.now())) - 0) < 0.01);
        } finally {
            if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
        }
    });
    test('ISO（帶 Z）、純日期、空值、亂碼維持原行為', () => {
        assert.ok(Math.abs(lib.daysAgo(iso(2)) - 2) < 0.01);
        assert.equal(lib.daysAgo(null), 365);
        assert.equal(lib.daysAgo('不是日期'), 365);
        assert.ok(lib.daysAgo('2020-01-01') > 365);
    });
});

describe('searchHybrid：隨機浮現', () => {
    test('三路皆無候選也照規則浮現：注入 random<0.4 → 撈出 >3 天未讀的舊碎片', async () => {
        const old = addFrag({ content: '很久以前的事', daysAgo: 10 });
        addFrag({ content: '已讀過', daysAgo: 10, readCount: 3 });
        const r = await lib.searchHybrid('沒有匹配的zzz', 6, { random: () => 0.1 });
        assert.deepEqual(r.map(x => x.id), [old]);
        assert.equal(r[0]._isFloated, true);
        assert.equal(r[0]._source, 'FLOAT');
    });
    test('隨機數超過門檻（>=0.4）→ 無候選時仍回 []', async () => {
        addFrag({ content: '很久以前的事', daysAgo: 10 });
        assert.deepEqual(await lib.searchHybrid('沒有匹配的zzz', 6, { random: () => 0.5 }), []);
    });
    test('結果已有 3 條以上就不浮現', async () => {
        for (let i = 0; i < 3; i++) addFrag({ content: `蘋果 ${i}`, ew: 0.9, daysAgo: 0.5 });
        addFrag({ content: '舊事', daysAgo: 10 });
        const r = await lib.searchHybrid('蘋果', 6, { random: () => 0.1 });
        assert.ok(r.every(x => !x._isFloated));
    });
});

describe('searchHybrid：RRF 與 combined 分數', () => {
    test('空查詢 → []', async () => assert.deepEqual(await lib.searchHybrid('  '), []));

    test('只有 FTS5（無向量）：source=FTS5*、乘 0.7 懲罰，數值符合公式', async () => {
        const id = addFrag({ content: '我喜歡蘋果派', ew: 0.5, daysAgo: 0.5 });
        const before = Date.now();
        const r = await lib.searchHybrid('蘋果派');
        assert.equal(r.length, 1);
        const it = r[0];
        assert.equal(it.id, id);
        assert.equal(it._source, 'FTS5*');
        assert.equal(it._confidence, 'medium'); // rrf 1/61 > 0.015（懲罰前判斷）
        const days = (before - (Date.now() - 0.5 * DAY)) / DAY;
        const want = (1 / 61) * 0.7 * refDecay(days, 0.5) * (0.4 + 0.5 * 0.6) * 1 * 1 * 1.3;
        close(it._rrf, want, 'combined');
        assert.equal(it._novelty, 1);
        assert.equal(it._recencyBoost, 1.3);
    });

    test('fact 意圖：FTS5 權重 1.5，且不套用 FTS5-only 懲罰', async () => {
        addFrag({ content: '蘋果很好吃', ew: 0.5, daysAgo: 0.5 });
        const r = await lib.searchHybrid('蘋果多少');
        assert.equal(r.length, 1);
        assert.equal(r[0]._source, 'FTS5');
        const want = (1 / 61) * 1.5 * refDecay(0.5, 0.5) * 0.7 * 1.3;
        close(r[0]._rrf, want);
    });

    test('summary / long_term 意圖：FTS5 權重 0.6 / 0.7（且仍有 FTS5-only 懲罰）', async () => {
        addFrag({ content: '蘋果進展', ew: 0.5, daysAgo: 0.5 });
        const s = await lib.searchHybrid('最近蘋果');
        close(s[0]._rrf, (1 / 61) * 0.6 * 0.7 * refDecay(0.5, 0.5) * 0.7 * 1.3);
        const l = await lib.searchHybrid('之前蘋果');
        // long_term：時間衰減用 days*0.4；recencyBoost 仍用真實天數
        close(l[0]._rrf, (1 / 61) * 0.7 * 0.7 * refDecay(0.5 * 0.4, 0.5) * 0.7 * 1.3);
    });

    test('BOTH（FTS5 + 向量）：無懲罰、confidence=high、RRF 兩路相加', async () => {
        const id = addFrag({ content: '我喜歡蘋果派', ew: 0.5, daysAgo: 0.5 });
        vecResults = [{ id, _table: 'fragments', _similarity: 0.6, content: '我喜歡蘋果派', emotional_weight: 0.5 }];
        const r = await lib.searchHybrid('蘋果派');
        assert.equal(r.length, 1);
        assert.equal(r[0]._source, 'BOTH');
        assert.equal(r[0]._confidence, 'high');
        close(r[0]._rrf, (2 / 61) * refDecay(0.5, 0.5) * 0.7 * 1.3);
        assert.equal(lib.formatHybridContext(r).startsWith('※ 可引用'), true);
    });

    test('向量地板 0.22：低於不進 RRF，等於則進入', async () => {
        vecResults = [{ id: 901, _table: 'fragments', _similarity: 0.2, content: 'low', emotional_weight: 0.5, created_at: iso(0.5) }];
        assert.deepEqual(await lib.searchHybrid('沒有匹配的zzz'), []);
        vecResults = [{ id: 902, _table: 'fragments', _similarity: 0.22, content: 'edge', emotional_weight: 0.5, created_at: iso(0.5) }];
        const r = await lib.searchHybrid('沒有匹配的zzz');
        assert.equal(r.length, 1);
        assert.equal(r[0]._source, 'VEC');
    });

    test('向量 confidence：sim>0.35 → high；否則 rrf>0.015 → medium', async () => {
        vecResults = [
            { id: 911, _table: 'fragments', _similarity: 0.5, content: 'a', emotional_weight: 0.5, created_at: iso(0.5) },
            { id: 912, _table: 'fragments', _similarity: 0.3, content: 'b', emotional_weight: 0.5, created_at: iso(0.5) },
        ];
        const r = await lib.searchHybrid('沒有匹配的zzz');
        const by = Object.fromEntries(r.map(x => [x.id, x._confidence]));
        assert.equal(by[911], 'high');
        assert.equal(by[912], 'medium'); // rank1 → 1/62 ≈ 0.0161 > 0.015
    });

    test('向量結果的 memory（episode）RRF 乘 EPISODE_BOOST 1.5；summary/long_term 為 2.0；fact 為 1.0', async () => {
        const mk = () => [{ id: 921, _table: 'memories', _similarity: 0.5, title: 'ep', emotional_weight: 0.5, created_at: iso(0.5) }];
        const rrfOf = async (q) => { vecResults = mk(); return (await lib.searchHybrid(q))[0]._rrf; };
        const base = refDecay(0.5, 0.5) * 0.7 * 1.3 / 61;
        close(await rrfOf('沒有匹配的zzz'), base * 1.5 * 1.0);
        close(await rrfOf('最近沒有匹配的zzz'), base * 2.0 * 1.4);   // summary vecWeight 1.4
        close(await rrfOf('之前沒有匹配的zzz'), base * 2.0 * 1.3 * refDecay(0.5 * 0.4, 0.5) / refDecay(0.5, 0.5));   // long_term vecWeight 1.3、衰減天數 ×0.4
        close(await rrfOf('沒有匹配的多少zzz'), base * 1.0 * 0.5);   // fact vecWeight 0.5
    });

    test('向量通道拋錯 → 退化為只用 FTS5，不丟擲', async () => {
        addFrag({ content: '我喜歡蘋果派', daysAgo: 0.5 });
        vecThrows = true;
        const r = await lib.searchHybrid('蘋果派');
        assert.equal(r.length, 1);
        assert.equal(r[0]._source, 'FTS5*');
    });

    test('MIN_COMBINED_SCORE=0.005：低 ew 舊碎片被濾掉，高 ew 舊碎片存活', async () => {
        addFrag({ content: '蘋果 低情緒', ew: 0.2, daysAgo: 400 });
        assert.deepEqual(await lib.searchHybrid('蘋果'), []);
        const hi = addFrag({ content: '蘋果 高情緒', ew: 0.9, daysAgo: 400 });
        const r = await lib.searchHybrid('蘋果');
        assert.deepEqual(r.map(x => x.id), [hi]);
        assert.ok(r[0]._rrf >= 0.005);
    });

    test('recencyBoost 階梯：<=1天 1.3、<=3天 1.15、<=7天 1.05、更久 1.0', async () => {
        const ids = {
            d05: addFrag({ content: '蘋果 a', daysAgo: 0.5, ew: 0.9 }),
            d2: addFrag({ content: '蘋果 b', daysAgo: 2, ew: 0.9 }),
            d5: addFrag({ content: '蘋果 c', daysAgo: 5, ew: 0.9 }),
            d10: addFrag({ content: '蘋果 d', daysAgo: 10, ew: 0.9 }),
        };
        const r = await lib.searchHybrid('蘋果', 10);
        const boost = Object.fromEntries(r.map(x => [x.id, x._recencyBoost]));
        assert.equal(boost[ids.d05], 1.3);
        assert.equal(boost[ids.d2], 1.15);
        assert.equal(boost[ids.d5], 1.05);
        assert.equal(boost[ids.d10], 1.0);
    });

    test('分段衰減：3 天以內新鮮度主導（0.7/0.3），3 天後情緒主導（0.3/0.7）', async () => {
        const a = addFrag({ content: '蘋果 a', daysAgo: 2.9, ew: 0.5 });
        const b = addFrag({ content: '蘋果 b', daysAgo: 3.1, ew: 0.5 });
        const r = await lib.searchHybrid('蘋果', 10);
        const by = Object.fromEntries(r.map(x => [x.id, x._decay]));
        close(by[a], refDecay(2.9, 0.5));
        close(by[b], refDecay(3.1, 0.5));
        assert.ok(by[a] > by[b]);
    });

    test('新穎度：read_count 0/1 → 1；9 → 0.5；99 → 1/3', async () => {
        const ids = [0, 1, 9, 99].map(n => addFrag({ content: `蘋果 ${n}`, readCount: n, daysAgo: 0.5, ew: 0.9 }));
        // fact 意圖（權重 1.5、無 FTS5 懲罰）讓低新穎度的碎片也能通過 MIN_COMBINED_SCORE
        const r = await lib.searchHybrid('蘋果多少', 10);
        const nov = Object.fromEntries(r.map(x => [x.id, x._novelty]));
        assert.equal(nov[ids[0]], 1);
        assert.equal(nov[ids[1]], 1);
        close(nov[ids[2]], 0.5);
        close(nov[ids[3]], 1 / 3);
    });

    test('workingMemory boost 會乘進 combined 分數', async () => {
        const id = addFrag({ content: '我喜歡蘋果派', daysAgo: 0.5 });
        const plain = (await lib.searchHybrid('蘋果派'))[0]._rrf;
        boostMap = new Map([[`fragment-${id}`, 1.25]]);
        const boosted = (await lib.searchHybrid('蘋果派'))[0];
        assert.equal(boosted._wmBoost, 1.25);
        close(boosted._rrf, plain * 1.25);
    });

    test('實體聚合：訊息含實體名 → 走 ENTITY 通道，虛擬 rank 使 rrf = 1/(60+4+i)', async () => {
        const e = Number(db.prepare("INSERT INTO entity_profiles (name, category) VALUES ('Zed','person')").run().lastInsertRowid);
        const f = addFrag({ content: '喜歡爬山', ew: 0.5, daysAgo: 0.5 });
        db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id) VALUES (?,?)').run(f, e);
        const r = await lib.searchHybrid('Zed');
        assert.equal(r.length, 1);
        assert.equal(r[0]._source, 'ENTITY');
        assert.equal(r[0]._confidence, 'medium');
        close(r[0]._rrf, (1 / 64) * refDecay(0.5, 0.5) * 0.7 * 1.3);
    });

    test('limit 截斷，結果依 combined 分數降序', async () => {
        for (let i = 0; i < 4; i++) addFrag({ content: `蘋果 ${i}`, ew: 0.9, daysAgo: 0.5 + i * 20 });
        const r = await lib.searchHybrid('蘋果', 3);
        assert.equal(r.length, 3);
        for (let i = 1; i < r.length; i++) assert.ok(r[i - 1]._rrf >= r[i]._rrf);
    });

    test('沒有任何 FTS5／向量／實體候選：random<0.4 時照規則浮現（Math.random 亦可）；random>=0.4 則回 []', async () => {
        const old = addFrag({ content: '完全無關的舊事', daysAgo: 30, readCount: 0 });
        Math.random = () => 0.1;
        try {
            const r = await lib.searchHybrid('沒有匹配的zzz');
            assert.deepEqual(r.map(x => x.id), [old]);
            assert.equal(r[0]._isFloated, true);
        } finally {
            Math.random = () => 0.99;
        }
        assert.deepEqual(await lib.searchHybrid('沒有匹配的zzz'), []);
    });

    test('隨機浮現：有候選但被分數底線濾光（結果 <3）且 random<0.4 → 補入從未被讀過、>3 天的舊碎片（FLOAT、_rrf=0.002）', async () => {
        addFrag({ content: '蘋果 被濾掉', ew: 0.2, daysAgo: 400, readCount: 5 });   // 匹配但分數過低，且 read_count>0 不會被浮現
        const old = addFrag({ content: '完全無關的舊事', daysAgo: 30, readCount: 0 });
        Math.random = () => 0.1;
        try {
            const r = await lib.searchHybrid('蘋果');
            assert.equal(r.length, 1);
            assert.equal(r[0].id, old);
            assert.equal(r[0]._source, 'FLOAT');
            assert.equal(r[0]._isFloated, true);
            assert.equal(r[0]._rrf, 0.002);
            assert.equal(lib.formatHybridContext(r).startsWith('※ 僅聯想'), true);
        } finally {
            Math.random = () => 0.99;
        }
    });

    test('random>=0.4 → 不浮現', async () => {
        addFrag({ content: '蘋果 被濾掉', ew: 0.2, daysAgo: 400, readCount: 5 });
        addFrag({ content: '完全無關的舊事', daysAgo: 30, readCount: 0 });
        assert.deepEqual(await lib.searchHybrid('蘋果'), []);
    });
});
