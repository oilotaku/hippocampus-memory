// scripts/rotate_memory_keys.js — 記憶本體欄位的金鑰輪替（W3）
//
// 把 services/memoryCrypto.js FIELDS 裡的所有加密欄位用「目前金鑰」重新加密，並重建 FTS 盲索引、
// 重算 content_hash（兩者都由金鑰衍生，金鑰一換就全部失效）。整段一個交易：任何一步失敗全部回滾。
//
// 步驟：
//   1. 產生新金鑰：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   2. 設定環境變數（.env）：
//        SANCTUARY_ENCRYPTION_KEY=<新金鑰>
//        SANCTUARY_ENCRYPTION_KEY_ID=<新 kid，例如 k2>
//        SANCTUARY_ENCRYPTION_KEYS_OLD=k1=<舊金鑰>        （多把用逗號分隔）
//   3. 先預演：node scripts/rotate_memory_keys.js --dry-run   （只讀開庫，不改任何資料）
//   4. 正式：  node scripts/rotate_memory_keys.js
//   5. 確認無誤後（下次啟動、檢索正常），才從 SANCTUARY_ENCRYPTION_KEYS_OLD 移除舊金鑰。
//
// 有任何值用現有金鑰都解不開時，正式執行會整批中止（不會只輪替一半）。
// 注意：本指令碼只處理記憶本體欄位；api_configs.api_key、chat_summaries、messages 等其他密文不在範圍內。

require('dotenv').config();
const DRY_RUN = process.argv.includes('--dry-run');

function summarize(db, memoryCrypto) {
    const { encryption } = require('../encryption');
    const rawPrepare = (sql) => Object.getPrototypeOf(db).prepare.call(db, sql);
    const byKid = {};
    let plain = 0;
    for (const [table, cols] of Object.entries(memoryCrypto.FIELDS)) {
        for (const col of cols) {
            let rows;
            try { rows = rawPrepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`).all(); }
            catch (_) { continue; }
            for (const r of rows) {
                if (typeof r.v !== 'string') continue;
                if (!r.v.startsWith('enc:')) { plain++; continue; }
                const kid = r.v.startsWith('enc:v2:') ? r.v.split(':')[2] : 'v1';
                byKid[kid] = (byKid[kid] || 0) + 1;
            }
        }
    }
    return { byKid, plain, currentKid: encryption.keyId };
}

function main() {
    const memoryCrypto = require('../services/memoryCrypto');
    let db;
    if (DRY_RUN) {
        // 只讀開庫：不跑 migration、不做啟動同步，保證預演不改任何資料
        const Database = require('better-sqlite3');
        db = new Database(process.env.DB_PATH || 'sanctuary.db', { readonly: true, fileMustExist: true });
        memoryCrypto.wrapDatabase(db);
        db.function('splitCJK', (t) => require('../utils/cjkTokenize').toIndexTokens(t));
    } else {
        process.env.MEMORY_CRYPTO_SKIP_AUTOSYNC = '1';   // 啟動同步交給下面的輪替一次做完
        db = require('../database').initDatabase();
    }

    const before = summarize(db, memoryCrypto);
    console.log(`模式 MEMORY_ENCRYPTION=${memoryCrypto.isEnabled() ? 'on' : 'off'}，目前 kid=${before.currentKid}`);
    console.log(`  現有密文（依 kid）: ${JSON.stringify(before.byKid)}，明文 ${before.plain} 個`);

    if (DRY_RUN) {
        const stats = memoryCrypto.processAllFields(db, { mode: 'rotate', dryRun: true });
        const rehash = memoryCrypto.recomputeContentHashes(db, { dryRun: true });
        const fp = memoryCrypto.getMeta(db, 'fts_index_fingerprint');
        console.log('── 預演（不寫入）──');
        console.log(`  會改成目前 kid 重新加密: ${stats.rotated}`);
        console.log(`  舊格式（v1／無 AAD）會改成 v2+AAD: ${stats.resealed}`);
        console.log(`  明文會加密: ${stats.sealed}${memoryCrypto.isEnabled() ? '' : '（off 模式不加密明文）'}`);
        console.log(`  content_hash 會重算: ${rehash}`);
        console.log(`  FTS 索引指紋: ${fp === memoryCrypto.indexFingerprint() ? '相符（仍會重建）' : '不符 → 需要重建'}`);
        if (stats.undecryptable.length) {
            console.log(`  ❌ 無法解密 ${stats.undecryptable.length} 個（${stats.undecryptable.slice(0, 10).join(', ')}）——正式執行會中止，請補上舊金鑰`);
            process.exit(2);
        }
        console.log('預演完成，資料未變動。');
        process.exit(0);
    }

    let stats;
    try {
        memoryCrypto.withSecureDelete(db, () => db.transaction(() => {
            stats = memoryCrypto.fullSync(db, { mode: 'rotate' });
        })());
    } catch (e) {
        console.error('❌ 輪替失敗，已整批迴滾：', e.message);
        process.exit(1);
    }
    memoryCrypto.scrubFile(db);   // 舊金鑰的密文與舊盲 token 不留在空閒頁面
    const after = summarize(db, memoryCrypto);
    console.log('✅ 輪替完成');
    console.log(`  重新加密 ${stats.rotated}、舊格式改 v2+AAD ${stats.resealed}、明文加密 ${stats.sealed}、content_hash 重算 ${stats.rehashed}`);
    console.log(`  現在的密文（依 kid）: ${JSON.stringify(after.byKid)}，明文 ${after.plain} 個；FTS 盲索引已用新金鑰重建`);
    process.exit(0);
}

main();
