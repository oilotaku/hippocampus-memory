'use strict';
// F4：DB 的 UTC 時間字串（無時區標記）不可被 new Date() 當成伺服器本地時間。
// 一律在 TZ=Asia/Taipei（UTC+8）下驗證——UTC 主機上寫錯也看不出來。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('f4-time');
const oldTz = process.env.TZ;
let restore, db;
before(() => {
    process.env.TZ = 'Asia/Taipei';
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
});
after(() => {
    restore();
    if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
    cleanupDb(dbPath);
});

const pad = (n) => String(n).padStart(2, '0');
const dbStr = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const DAY = 86400000;

describe('parseDbTime（utils/time）', () => {
    const { parseDbTime, dbTimeMs } = require('../../utils/time');
    test('無時區標記 → UTC（TZ=Asia/Taipei 也一樣）', () => {
        assert.equal(parseDbTime('2026-06-01 12:00:00').toISOString(), '2026-06-01T12:00:00.000Z');
        assert.equal(parseDbTime('2026-06-01 12:00').toISOString(), '2026-06-01T12:00:00.000Z');
        assert.equal(parseDbTime('2026-06-01T12:00:00').toISOString(), '2026-06-01T12:00:00.000Z');
        assert.equal(parseDbTime('2026-06-01').toISOString(), '2026-06-01T00:00:00.000Z');
    });
    test('已帶時區、數字、Date、亂碼照原樣', () => {
        assert.equal(parseDbTime('2026-06-01T12:00:00Z').toISOString(), '2026-06-01T12:00:00.000Z');
        assert.equal(parseDbTime('2026-06-01T20:00:00+08:00').toISOString(), '2026-06-01T12:00:00.000Z');
        assert.equal(parseDbTime(0).getTime(), 0);
        const d = new Date(5); assert.equal(parseDbTime(d), d);
        assert.ok(Number.isNaN(dbTimeMs('不是日期')));
    });
});

describe('archivist/patterns：freshness 以 UTC 解析', () => {
    test('6.9 天前的 UTC 字串 → 仍在 7 天內（係數 1.0），不因 +8h 偏差落到 0.85', () => {
        const { _freshnessDecay } = require('../../services/archivist/patterns');
        assert.equal(_freshnessDecay(dbStr(Date.now() - 6.9 * DAY)), 1.0);
    });
});

describe('archivist/tick：getLastUserMessageTime', () => {
    test('回傳的毫秒值 = 該 UTC 字串的真實時刻', () => {
        db.prepare("INSERT OR IGNORE INTO chats (id, name) VALUES (1, 'f4')").run();
        const ts = Date.now() - 3 * 3600000;
        db.prepare("INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted) VALUES (1, 'user', 'hi', ?, 0)").run(dbStr(ts));
        const { getLastUserMessageTime } = require('../../services/archivist/tick');
        assert.ok(Math.abs(getLastUserMessageTime() - ts) < 1500, `差 ${getLastUserMessageTime() - ts} ms`);
    });
});

describe('routes/ingest：normalizeTime 一律輸出 UTC', () => {
    const { normalizeTime } = require('../../routes/ingest');
    test('epoch 秒／毫秒 → UTC 字串', () => {
        assert.equal(normalizeTime(1780315200), '2026-06-01 12:00:00');
        assert.equal(normalizeTime('1780315200000'), '2026-06-01 12:00:00');
    });
    test('帶時區的字串換成 UTC', () => {
        assert.equal(normalizeTime('2026-06-01T20:00:00+08:00'), '2026-06-01 12:00:00');
        assert.equal(normalizeTime('2026-06-01T12:00:00Z'), '2026-06-01 12:00:00');
    });
    test('無時區字串視為伺服器本地時間（Taipei）後換成 UTC', () => {
        assert.equal(normalizeTime('2026-06-01 20:00:00'), '2026-06-01 12:00:00');
    });
    test('空值與亂碼 → null', () => {
        assert.equal(normalizeTime(''), null);
        assert.equal(normalizeTime(null), null);
        assert.equal(normalizeTime('亂碼'), null);
    });
});

describe('原始碼守衛：不得再對 DB 時間欄位直接 new Date()', () => {
    // intuition／userProfile／scribe／summary／consolidator 的相關函式不對外匯出，
    // 以原始碼樣式守住（行為由上面的 parseDbTime 測試涵蓋）。
    const root = path.join(__dirname, '..', '..');
    const BANNED = [
        ['services/intuition.js', /new Date\((dateStr|createdAt|s\.expires_at|e\.overview_updated_at|p\.last_seen|p\.first_seen)\)/],
        ['services/userProfile.js', /new Date\(entry\./],
        ['services/archivist/patterns.js', /new Date\((firstSeen|lastSeen|p\.last_seen)\)/],
        ['services/archivist/tick.js', /new Date\(row\.timestamp\)/],
        ['services/summary.js', /new Date\(ts\.includes/],
        ['services/scribe.js', /new Date\((ts|unprocessed\[[^\]]*\]\.timestamp|lastRun\.processed_until)\)/],
        ['services/consolidator.js', /\+08:00/],
    ];
    for (const [file, re] of BANNED) {
        test(file, () => {
            const src = fs.readFileSync(path.join(root, file), 'utf8');
            assert.ok(!re.test(src), `${file} 仍有把 DB 時間當本地時間解析的寫法（${re}）`);
        });
    }
});
