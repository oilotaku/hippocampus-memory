// scripts/vacuum.js — 資料庫整理（運維指令碼）
//
// 為什麼需要：SQLite 的 DELETE 只把頁標記為空閒，不會把空間還給作業系統；
// 碎片墓碑化（內容改寫成 '[expired]'）也會在原來的頁裡留下空洞。長期執行下來
// 檔案只漲不縮。VACUUM 會重建整個資料庫檔案，把這些空洞收掉。
//
// ⚠️ 兩個代價，指令碼會先幫你判斷值不值：
//   1. 需要**臨時雙倍磁碟**（重建期間新舊檔案同時存在）
//   2. 全程**獨佔鎖庫**，期間服務的寫入會被阻塞 —— 所以建議先停服務再跑
//
// 用法：
//   node scripts/vacuum.js              # 檢查 → 夠划算就執行
//   node scripts/vacuum.js --dry-run    # 只報告能回收多少，不動手
//   node scripts/vacuum.js --force      # 忽略「回收量太小」的判斷，強制執行
//
// 掛 cron 的話建議低峰期每週一次，例如：
//   30 4 * * 0  cd /path/to/app && node scripts/vacuum.js >> logs/vacuum.log 2>&1

require('dotenv').config();
const fs = require('fs');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

const MIN_RECLAIM_MB = 20;   // 回收量低於這個數就不值得鎖庫重建
const DB_PATH = process.env.DB_PATH || 'sanctuary.db';

const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

function fileSize(p) {
    try { return fs.statSync(p).size; } catch { return 0; }
}

function freeDiskBytes(dir) {
    try {
        if (typeof fs.statfsSync !== 'function') return null;   // Node < 18.15
        const s = fs.statfsSync(dir);
        return s.bavail * s.bsize;
    } catch { return null; }
}

console.log('── 資料庫整理 (VACUUM) ──');
console.log('檔案:', DB_PATH);

const sizeBefore = fileSize(DB_PATH);
if (!sizeBefore) {
    console.error(`找不到資料庫檔案 ${DB_PATH}（用 DB_PATH 環境變數指定路徑）`);
    process.exit(1);
}
console.log('當前大小:', mb(sizeBefore));

const { initDatabase, getDb } = require('../database');
initDatabase();
const db = getDb();

// ── 1. 估算可回收量 ──
// freelist_count = 已經被整頁標記空閒、但還佔著檔案大小的頁數。
// 頁內碎片（半空的頁）沒法用 SQL 便宜地估出來，所以這只是**下限**。
const pageSize = db.pragma('page_size', { simple: true });
const pageCount = db.pragma('page_count', { simple: true });
const freelist = db.pragma('freelist_count', { simple: true });
const reclaimEstimate = freelist * pageSize;

console.log(`頁: ${pageCount} × ${pageSize}B，空閒頁 ${freelist} → 至少可回收 ${mb(reclaimEstimate)}`);
console.log('（頁內碎片收不回來，實際回收量通常高於這個數）');

if (DRY_RUN) {
    console.log('\n--dry-run：只做檢查，未執行 VACUUM。');
    process.exit(0);
}

// ── 2. 空間檢查 ──
const free = freeDiskBytes('.');
if (free === null) {
    console.warn('⚠️  無法讀取磁碟剩餘空間（Node < 18.15 或平臺不支援），跳過檢查。VACUUM 期間請自行確認剩餘空間 > ' + mb(sizeBefore));
} else {
    console.log('磁碟剩餘:', mb(free));
    const need = sizeBefore * 1.2;   // 新舊檔案同時存在 + 一點餘量
    if (free < need) {
        console.error(`❌ 剩餘空間不足：需要約 ${mb(need)}，實際 ${mb(free)}。`);
        console.error('   先清理磁碟，或用 --force 強行嘗試（不建議）。');
        if (!FORCE) process.exit(1);
    }
}

// ── 3. 值不值得做 ──
if (reclaimEstimate < MIN_RECLAIM_MB * 1048576 && !FORCE) {
    console.log(`\n可回收量低於 ${MIN_RECLAIM_MB} MB，重建整個檔案的收益不大，跳過。`);
    console.log('（確認要做可以加 --force）');
    process.exit(0);
}

// ── 4. WAL 落盤，然後 VACUUM ──
try {
    db.pragma('wal_checkpoint(TRUNCATE)');
} catch (e) {
    console.warn('wal_checkpoint 失敗（可忽略）:', e.message);
}

console.log('\n開始 VACUUM……');
const t0 = Date.now();
try {
    db.exec('VACUUM');
} catch (e) {
    if (/busy|locked/i.test(e.message)) {
        console.error('❌ 資料庫被佔用（多半是服務還在跑）。先停掉服務再執行：');
        console.error('   pm2 stop <name>   # 或者直接停掉 node index.js');
    } else {
        console.error('❌ VACUUM 失敗:', e.message);
    }
    process.exit(1);
}

// VACUUM 的寫入先落在 WAL 裡，要 checkpoint + 關連線之後檔案大小才是最終值
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
db.close();

const sizeAfter = fileSize(DB_PATH);
console.log(`完成，用時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`檔案大小：${mb(sizeBefore)} → ${mb(sizeAfter)}（回收 ${mb(sizeBefore - sizeAfter)}）`);
