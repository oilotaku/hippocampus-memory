'use strict';
// 時間資訊修正：Scribe 給模型看當地時間＋星期、每條記憶用原話所在訊息的日期、
// 注入記憶時附上對話日期（而非以寫入時間算的「N天前」）。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('temporal_info');
let restore, db, lib;

before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    lib = require('../../services/librarian');
});
after(() => { restore(); cleanupDb(dbPath); });

describe('utils/time 當地時間工具', () => {
    const { toLocalMinute, weekdayZh, daysSinceLocalDate } = require('../../utils/time');
    test('weekdayZh：依日期本身算星期；無效日期回空字串', () => {
        assert.equal(weekdayZh('2026-05-02'), '週六');
        assert.equal(weekdayZh('2026-04-29 21:30'), '週三');
        assert.equal(weekdayZh('2026-02-30'), '');
        assert.equal(weekdayZh('昨天'), '');
        assert.equal(weekdayZh(null), '');
    });
    test('toLocalMinute：DB 的 UTC 時間轉當地（UTC+8），跨日時日期跟著進位', () => {
        assert.equal(toLocalMinute('2026-04-21 23:30:00'), '2026-04-22 07:30');
        assert.equal(toLocalMinute('2026-04-22 13:30'), '2026-04-22 21:30');
        assert.equal(toLocalMinute('not a time'), '');
    });
    test('daysSinceLocalDate：以當地日曆日計算；未來為負數', () => {
        const now = Date.UTC(2026, 3, 22, 1, 0);          // 當地 2026-04-22 09:00
        assert.equal(daysSinceLocalDate('2026-04-20', now), 2);
        assert.equal(daysSinceLocalDate('2026-04-22', now), 0);
        assert.equal(daysSinceLocalDate('2026-04-25', now), -3);
        const lateUtc = Date.UTC(2026, 3, 21, 17, 0);      // UTC 還是 21 日，當地已是 22 日 01:00
        assert.equal(daysSinceLocalDate('2026-04-21', lateUtc), 1);
        assert.equal(daysSinceLocalDate('bad', now), null);
    });
});

describe('quoteSourceDate：原話出自哪則訊息就用哪天', () => {
    const { quoteSourceDate } = require('../../services/hippocampus/dentate/scribeQuality');
    const msgs = [
        { text: '我下週三要去高雄出差', date: '2026-03-02' },
        { text: '語彤今天拆掉腳踏車輔助輪了！', date: '2026-03-18' },
    ];
    test('找到原話 → 那則訊息的日期（不是整批最後一則）', () => {
        assert.equal(quoteSourceDate('下週三要去高雄出差', msgs), '2026-03-02');
        assert.equal(quoteSourceDate('拆掉腳踏車輔助輪', msgs), '2026-03-18');
    });
    test('標點與空白差異不影響比對（與原話佐證同一套正規化）', () => {
        assert.equal(quoteSourceDate('拆掉腳踏車輔助輪了!', msgs), '2026-03-18');
    });
    test('對不上或太短 → null（呼叫端退回批次日期）', () => {
        assert.equal(quoteSourceDate('完全沒說過的話', msgs), null);
        assert.equal(quoteSourceDate('我', msgs), null);
        assert.equal(quoteSourceDate('', msgs), null);
        assert.equal(quoteSourceDate(null, msgs), null);
    });
});

describe('formatHybridContext：注入記憶附上對話日期', () => {
    const addFrag = (sourceDate) => Number(db.prepare(
        `INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_date, status, created_at)
         VALUES ('event', 'X', '內容', 0.3, 'scribe', ?, 'active', datetime('now'))`).run(sourceDate).lastInsertRowid);

    test('有 source_date：顯示「記於 日期（星期，N天前）」，不再是以寫入時間算的「0天前」', () => {
        const id = addFrag('2026-04-29');   // 剛寫入（created_at＝現在）；呼叫端只帶以寫入時間算的 _daysAgo=0
        const out = lib.formatHybridContext([{ id, source_table: 'fragment', content: '家長座談會', _daysAgo: 0 }], { count: false });
        assert.match(out, /^※ .+ · #\d+ · 記於 2026-04-29（週三(，\d+天前)?）\n家長座談會$/);
        assert.ok(!out.includes('· 0天前'));
    });
    test('呼叫端已帶 source_date 時直接用，不另查資料庫', () => {
        const out = lib.formatHybridContext([{ id: 999999, source_table: 'fragment', content: 'c', source_date: '2026-05-02', _daysAgo: 1 }], { count: false });
        assert.match(out, /記於 2026-05-02（週六/);
    });
    test('沒有 source_date：維持舊格式「N天前」', () => {
        const id = addFrag(null);
        const out = lib.formatHybridContext([{ id, source_table: 'fragment', content: 'c', _daysAgo: 4 }], { count: false });
        assert.match(out, /· 4天前\nc$/);
    });
    test('未來日期（預定的事）只顯示日期與星期，不寫負的天數', () => {
        const out = lib.formatHybridContext([{ id: 999998, source_table: 'fragment', content: 'c', source_date: '2099-01-01' }], { count: false });
        assert.match(out, /記於 2099-01-01（週四）\nc$/);
    });
});
