// 特性测试共用工具：独立暫存 DB、靜音 console、stub 外部依賴。
// 檔名以 _ 開頭且不含 .test.，node --test 不會把它當測試檔。
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TEST_KEY = '0123456789abcdef'.repeat(4);

function setupEnv(tag) {
    const dbPath = path.join(os.tmpdir(), `mc-${tag}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
    process.env.DB_PATH = dbPath;
    process.env.SANCTUARY_ENCRYPTION_KEY = TEST_KEY;
    return dbPath;
}

function cleanupDb(dbPath) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
    }
}

// 靜音產品碼大量的 console 輸出（測試自己的輸出走 node:test reporter，不受影響）
function quiet() {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    return () => Object.assign(console, orig);
}

// W3：記憶本體欄位的「原始儲存值」（不經 database.js 的透明解密）裡有幾個明文。
// MEMORY_ENCRYPTION=on 時，產品碼與經 sealField 播種的資料都應該是 0。
function rawMemoryPlaintext(db) {
    const { FIELDS } = require('../../services/memoryCrypto');
    const raw = (sql) => Object.getPrototypeOf(db).prepare.call(db, sql);
    const found = [];
    for (const [t, cols] of Object.entries(FIELDS)) {
        for (const c of cols) {
            for (const r of raw(`SELECT id, ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND ${c} != ''`).all()) {
                if (typeof r.v === 'string' && !r.v.startsWith('enc:')) found.push(`${t}.${c}#${r.id}`);
            }
        }
    }
    return found;
}

module.exports = { setupEnv, cleanupDb, quiet, TEST_KEY, rawMemoryPlaintext };
