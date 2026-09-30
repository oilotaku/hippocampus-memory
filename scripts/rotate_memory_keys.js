// scripts/rotate_memory_keys.js — 记忆本体栏位的金钥轮替（W3）
//
// 把 services/memoryCrypto.js FIELDS 里的所有加密栏位用「目前金钥」重新加密，并重建 FTS 盲索引、
// 重算 content_hash（两者都由金钥衍生，金钥一换就全部失效）。整段一个交易：任何一步失败全部回滚。
//
// 步骤：
//   1. 产生新金钥：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   2. 设定环境变数（.env）：
//        SANCTUARY_ENCRYPTION_KEY=<新金钥>
//        SANCTUARY_ENCRYPTION_KEY_ID=<新 kid，例如 k2>
//        SANCTUARY_ENCRYPTION_KEYS_OLD=k1=<旧金钥>        （多把用逗号分隔）
//   3. 先预演：node scripts/rotate_memory_keys.js --dry-run   （只读开库，不改任何资料）
//   4. 正式：  node scripts/rotate_memory_keys.js
//   5. 确认无误后（下次启动、检索正常），才从 SANCTUARY_ENCRYPTION_KEYS_OLD 移除旧金钥。
//
// 有任何值用现有金钥都解不开时，正式执行会整批中止（不会只轮替一半）。
// 注意：本脚本只处理记忆本体栏位；api_configs.api_key、chat_summaries、messages 等其他密文不在范围内。

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
        // 只读开库：不跑 migration、不做启动同步，保证预演不改任何资料
        const Database = require('better-sqlite3');
        db = new Database(process.env.DB_PATH || 'sanctuary.db', { readonly: true, fileMustExist: true });
        memoryCrypto.wrapDatabase(db);
        db.function('splitCJK', (t) => require('../utils/cjkTokenize').toIndexTokens(t));
    } else {
        process.env.MEMORY_CRYPTO_SKIP_AUTOSYNC = '1';   // 启动同步交给下面的轮替一次做完
        db = require('../database').initDatabase();
    }

    const before = summarize(db, memoryCrypto);
    console.log(`模式 MEMORY_ENCRYPTION=${memoryCrypto.isEnabled() ? 'on' : 'off'}，目前 kid=${before.currentKid}`);
    console.log(`  现有密文（依 kid）: ${JSON.stringify(before.byKid)}，明文 ${before.plain} 个`);

    if (DRY_RUN) {
        const stats = memoryCrypto.processAllFields(db, { mode: 'rotate', dryRun: true });
        const rehash = memoryCrypto.recomputeContentHashes(db, { dryRun: true });
        const fp = memoryCrypto.getMeta(db, 'fts_index_fingerprint');
        console.log('── 预演（不写入）──');
        console.log(`  会改成目前 kid 重新加密: ${stats.rotated}`);
        console.log(`  旧格式（v1／无 AAD）会改成 v2+AAD: ${stats.resealed}`);
        console.log(`  明文会加密: ${stats.sealed}${memoryCrypto.isEnabled() ? '' : '（off 模式不加密明文）'}`);
        console.log(`  content_hash 会重算: ${rehash}`);
        console.log(`  FTS 索引指纹: ${fp === memoryCrypto.indexFingerprint() ? '相符（仍会重建）' : '不符 → 需要重建'}`);
        if (stats.undecryptable.length) {
            console.log(`  ❌ 无法解密 ${stats.undecryptable.length} 个（${stats.undecryptable.slice(0, 10).join(', ')}）——正式执行会中止，请补上旧金钥`);
            process.exit(2);
        }
        console.log('预演完成，资料未变动。');
        process.exit(0);
    }

    let stats;
    try {
        memoryCrypto.withSecureDelete(db, () => db.transaction(() => {
            stats = memoryCrypto.fullSync(db, { mode: 'rotate' });
        })());
    } catch (e) {
        console.error('❌ 轮替失败，已整批回滚：', e.message);
        process.exit(1);
    }
    memoryCrypto.scrubFile(db);   // 旧金钥的密文与旧盲 token 不留在空闲页面
    const after = summarize(db, memoryCrypto);
    console.log('✅ 轮替完成');
    console.log(`  重新加密 ${stats.rotated}、旧格式改 v2+AAD ${stats.resealed}、明文加密 ${stats.sealed}、content_hash 重算 ${stats.rehashed}`);
    console.log(`  现在的密文（依 kid）: ${JSON.stringify(after.byKid)}，明文 ${after.plain} 个；FTS 盲索引已用新金钥重建`);
    process.exit(0);
}

main();
