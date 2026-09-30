// G2：三種時間與時段（跨時區、深夜跨日）。純函式，不需要資料庫。
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../services/emotion/time');

test('時段邊界：05–11 早上、11–17 中午、17–23 晚上、23–05 深夜', () => {
    const want = { 4: 'night', 5: 'morning', 10: 'morning', 11: 'noon', 16: 'noon', 17: 'evening', 22: 'evening', 23: 'night', 0: 'night' };
    for (const [h, s] of Object.entries(want)) assert.equal(T.slotOfHour(+h), s, `${h} 點`);
});

test('UTC 時間依時區換算當地時段：同一瞬間在不同地方時段不同', () => {
    const utc = '2026-05-02 15:30:00';   // 台北 23:30、倫敦 16:30（夏令）、紐約 11:30
    assert.equal(T.slotOf(utc, 'Asia/Taipei'), 'night');
    assert.equal(T.slotOf(utc, 'Europe/London'), 'noon');
    assert.equal(T.slotOf(utc, 'America/New_York'), 'noon');
    assert.equal(T.slotOf('2026-05-02 03:00:00', 'America/New_York'), 'night');   // 紐約 前一天 23:00
    assert.equal(T.slotOf('2026-05-02 09:00:00', 'Asia/Tokyo'), 'evening');       // 東京 18:00
});

test('深夜跨日：23:30 與隔天 02:00 同屬深夜，但當地日期與星期不同', () => {
    const a = T.localParts('2026-05-02 15:30:00', 'Asia/Taipei');   // 台北 5/2 23:30 週六
    const b = T.localParts('2026-05-02 18:00:00', 'Asia/Taipei');   // 台北 5/3 02:00 週日
    assert.equal(T.slotOfHour(a.hour), 'night');
    assert.equal(T.slotOfHour(b.hour), 'night');
    assert.equal(a.weekday, 6);
    assert.equal(b.weekday, 0);
    assert.equal(T.localDate('2026-05-02 15:30:00', 'Asia/Taipei'), '2026-05-02');
    assert.equal(T.localDate('2026-05-02 18:00:00', 'Asia/Taipei'), '2026-05-03');
});

test('UTC 與當地差一天（台北凌晨 = UTC 前一天）', () => {
    const p = T.localParts('2026-12-31 20:00:00', 'Asia/Taipei');   // 台北 2027-01-01 04:00
    assert.deepEqual([p.year, p.month, p.day, p.hour], [2027, 1, 1, 4]);
    assert.equal(T.slotOfHour(p.hour), 'night');
});

test('無效時區退回 Asia/Taipei；無效時間回 null', () => {
    assert.equal(T.localParts('2026-05-02 00:00:00', 'Not/AZone').hour, 8);
    assert.equal(T.localParts('不是時間', 'Asia/Taipei'), null);
    assert.equal(T.slotOf(null, 'Asia/Taipei'), null);
});

test('parseUtc：無時區標記視為 UTC；ISO 帶時區照算', () => {
    assert.equal(T.parseUtc('2026-05-02 08:00:00').toISOString(), '2026-05-02T08:00:00.000Z');
    assert.equal(T.parseUtc('2026-05-02T08:00:00+08:00').toISOString(), '2026-05-02T00:00:00.000Z');
    assert.equal(T.toSqlUtc(new Date('2026-05-02T08:00:00Z')), '2026-05-02 08:00:00');
});
