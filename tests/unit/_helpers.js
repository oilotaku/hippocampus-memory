// 特性測試共用工具：獨立暫存 DB、靜音 console、stub 外部依賴。
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

// 偶發失敗根因（llm_local_endpoint 等）：server.listen(0) 由作業系統挑埠，偶爾挑到 fetch（WHATWG 規格）
// 明令禁止的「壞埠」（如 6000、6665–6669、10080），fetch 直接丟 TypeError: fetch failed / bad port。
// 用這個代替 listen(0, host)：挑到壞埠就關掉重挑。回傳 Promise<server>。
const FETCH_BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
    111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
    587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
    6697, 10080]);
function listenSafe(server, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const attempt = () => {
            server.once('error', reject);
            server.listen(0, host, () => {
                server.removeListener('error', reject);
                if (!FETCH_BAD_PORTS.has(server.address().port)) return resolve(server);
                server.close(() => attempt());
            });
        };
        attempt();
    });
}

module.exports = { listenSafe, FETCH_BAD_PORTS, setupEnv, cleanupDb, quiet, TEST_KEY, rawMemoryPlaintext };
