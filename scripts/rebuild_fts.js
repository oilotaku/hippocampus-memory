// scripts/rebuild_fts.js — FTS 索引重建 / 體檢
//
// 為什麼需要單獨一個指令碼：
// FTS5 的 external content 表（content='memory_fragments'）不存原文，正文讀的是內容表。
// 這帶來兩個坑：
//   1. 用 COUNT(*) / rowid 查詢驗證同步狀態是**量不到**的——它會委託到內容表，永遠返回"看起來對"。
//      真正可信的是 _docsize 影子表（每個被索引的文件一行）。
//   2. 索引裡的文本是 splitCJK 展開過的（中文按重疊兩字組切），而 FTS5 自帶的 'rebuild' 指令
//      是拿內容表**原文**重新分詞——跑一次，兩字組索引整條失效，而且零報錯。
//
// 所以本指令碼不用 'rebuild' 指令，而是 DROP + CREATE + 回補，最後用 _docsize 驗證。
// W3：回補與觸發器都走 services/memoryCrypto.js——內容欄／標題欄依 MEMORY_ENCRYPTION 產生
//     盲 token（on，HMAC 兩字組，JS 端先解密）或明文兩字組（off）；entity／tags 維持明文兩字組。
//     跑完會把索引指紋寫進 memory_crypto_meta，下次啟動不會再重建一次。
//
// 什麼時候要跑：檢索結果對不上、搜舊詞還能命中已刪的記憶、資料庫損壞恢復之後。
//
// 用法：
//   node scripts/rebuild_fts.js          # 體檢 + 重建
//   node scripts/rebuild_fts.js --check  # 只體檢，不動資料

require('dotenv').config();
const { initDatabase, getDb } = require('../database');
const memoryCrypto = require('../services/memoryCrypto');

const CHECK_ONLY = process.argv.includes('--check');

initDatabase();
const db = getDb();

// ── 體檢：用 _docsize 影子表，而不是 COUNT(*) ──
function health() {
    const fragIndexed = db.prepare('SELECT COUNT(*) c FROM memory_fragments_fts_docsize').get().c;
    const fragActive  = db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c;
    const memIndexed  = db.prepare('SELECT COUNT(*) c FROM memories_fts_docsize').get().c;
    const memTotal    = db.prepare('SELECT COUNT(*) c FROM memories').get().c;
    const triggers    = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'trigger'").get().c;

    console.log('── FTS 體檢 ──');
    console.log(`  memory_fragments_fts 已索引 ${fragIndexed} 條（碎片總數 ${fragActive}，觸發器對所有狀態建索引）${fragIndexed === fragActive ? ' ✅' : ' ❌ 不一致'}`);
    console.log(`  memories_fts 已索引 ${memIndexed} 條（源表 ${memTotal}）${memIndexed === memTotal ? ' ✅' : ' ❌ 不一致'}`);
    console.log(`  觸發器 ${triggers} 個（應為 6）${triggers === 6 ? ' ✅' : ' ❌'}`);
    console.log('  （注：COUNT(*) 查 FTS 表會委託到內容表，量不到不一致——所以這裡必須看 _docsize）');
    const fp = memoryCrypto.getMeta(db, 'fts_index_fingerprint');
    const fpOk = fp === memoryCrypto.indexFingerprint();
    console.log(`  索引模式 ${memoryCrypto.isEnabled() ? 'on（盲索引）' : 'off（明文兩字組）'}，指紋${fpOk ? '相符 ✅' : '不符 ❌（金鑰或模式換過）'}`);

    return fragIndexed === fragActive && memIndexed === memTotal && triggers === 6 && fpOk;
}

if (CHECK_ONLY) {
    const ok = health();
    console.log(ok ? '\n體檢通過。' : '\n發現問題，去掉 --check 跑一次重建。');
    process.exit(ok ? 0 : 1);
}

// ── 重建 ──
console.log(`開始重建 FTS 索引（模式 ${memoryCrypto.isEnabled() ? 'on：盲索引' : 'off：明文兩字組'}）……\n`);

memoryCrypto.withSecureDelete(db, () => db.transaction(() => {
    // 1. 清掉舊的觸發器和表（連同可能損壞的影子表）
    memoryCrypto.dropTriggers(db);
    db.exec(`
        DROP TABLE IF EXISTS memory_fragments_fts;
        DROP TABLE IF EXISTS memories_fts;
        CREATE VIRTUAL TABLE memory_fragments_fts
            USING fts5(content, entity, content='memory_fragments', content_rowid='id');
        CREATE VIRTUAL TABLE memories_fts
            USING fts5(title, tags_text);
    `);
    // 2. 回補兩個 FTS 表（與觸發器同一套 mem_fts／splitCJK）
    memoryCrypto.rebuildFts(db);
    // 3. 裝回 6 個觸發器 + 記索引指紋
    memoryCrypto.installTriggers(db);
    memoryCrypto.ensureMetaTable(db);
    memoryCrypto.setMeta(db, 'fts_index_fingerprint', memoryCrypto.indexFingerprint());
})());

console.log(`  回補 memory_fragments_fts: ${db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c} 條`);
console.log(`  回補 memories_fts: ${db.prepare('SELECT COUNT(*) c FROM memories').get().c} 條`);
console.log('');
const ok = health();
process.exit(ok ? 0 : 1);
