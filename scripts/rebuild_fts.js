// scripts/rebuild_fts.js — FTS 索引重建 / 体检
//
// 为什么需要单独一个脚本：
// FTS5 的 external content 表（content='memory_fragments'）不存原文，正文读的是内容表。
// 这带来两个坑：
//   1. 用 COUNT(*) / rowid 查询验证同步状态是**量不到**的——它会委托到内容表，永远返回"看起来对"。
//      真正可信的是 _docsize 影子表（每个被索引的文档一行）。
//   2. 索引里的文本是 splitCJK 展开过的（中文按重叠两字组切），而 FTS5 自带的 'rebuild' 指令
//      是拿内容表**原文**重新分词——跑一次，两字组索引整条失效，而且零报错。
//
// 所以本脚本不用 'rebuild' 指令，而是 DROP + CREATE + 回补，最后用 _docsize 验证。
// W3：回补与触发器都走 services/memoryCrypto.js——内容栏／标题栏依 MEMORY_ENCRYPTION 产生
//     盲 token（on，HMAC 两字组，JS 端先解密）或明文两字组（off）；entity／tags 维持明文两字组。
//     跑完会把索引指纹写进 memory_crypto_meta，下次启动不会再重建一次。
//
// 什么时候要跑：检索结果对不上、搜旧词还能命中已删的记忆、数据库损坏恢复之后。
//
// 用法：
//   node scripts/rebuild_fts.js          # 体检 + 重建
//   node scripts/rebuild_fts.js --check  # 只体检，不动数据

require('dotenv').config();
const { initDatabase, getDb } = require('../database');
const memoryCrypto = require('../services/memoryCrypto');

const CHECK_ONLY = process.argv.includes('--check');

initDatabase();
const db = getDb();

// ── 体检：用 _docsize 影子表，而不是 COUNT(*) ──
function health() {
    const fragIndexed = db.prepare('SELECT COUNT(*) c FROM memory_fragments_fts_docsize').get().c;
    const fragActive  = db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c;
    const memIndexed  = db.prepare('SELECT COUNT(*) c FROM memories_fts_docsize').get().c;
    const memTotal    = db.prepare('SELECT COUNT(*) c FROM memories').get().c;
    const triggers    = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'trigger'").get().c;

    console.log('── FTS 体检 ──');
    console.log(`  memory_fragments_fts 已索引 ${fragIndexed} 条（碎片总数 ${fragActive}，触发器对所有状态建索引）${fragIndexed === fragActive ? ' ✅' : ' ❌ 不一致'}`);
    console.log(`  memories_fts 已索引 ${memIndexed} 条（源表 ${memTotal}）${memIndexed === memTotal ? ' ✅' : ' ❌ 不一致'}`);
    console.log(`  触发器 ${triggers} 个（应为 6）${triggers === 6 ? ' ✅' : ' ❌'}`);
    console.log('  （注：COUNT(*) 查 FTS 表会委托到内容表，量不到不一致——所以这里必须看 _docsize）');
    const fp = memoryCrypto.getMeta(db, 'fts_index_fingerprint');
    const fpOk = fp === memoryCrypto.indexFingerprint();
    console.log(`  索引模式 ${memoryCrypto.isEnabled() ? 'on（盲索引）' : 'off（明文两字组）'}，指纹${fpOk ? '相符 ✅' : '不符 ❌（金钥或模式换过）'}`);

    return fragIndexed === fragActive && memIndexed === memTotal && triggers === 6 && fpOk;
}

if (CHECK_ONLY) {
    const ok = health();
    console.log(ok ? '\n体检通过。' : '\n发现问题，去掉 --check 跑一次重建。');
    process.exit(ok ? 0 : 1);
}

// ── 重建 ──
console.log(`开始重建 FTS 索引（模式 ${memoryCrypto.isEnabled() ? 'on：盲索引' : 'off：明文两字组'}）……\n`);

memoryCrypto.withSecureDelete(db, () => db.transaction(() => {
    // 1. 清掉旧的触发器和表（连同可能损坏的影子表）
    memoryCrypto.dropTriggers(db);
    db.exec(`
        DROP TABLE IF EXISTS memory_fragments_fts;
        DROP TABLE IF EXISTS memories_fts;
        CREATE VIRTUAL TABLE memory_fragments_fts
            USING fts5(content, entity, content='memory_fragments', content_rowid='id');
        CREATE VIRTUAL TABLE memories_fts
            USING fts5(title, tags_text);
    `);
    // 2. 回补两个 FTS 表（与触发器同一套 mem_fts／splitCJK）
    memoryCrypto.rebuildFts(db);
    // 3. 装回 6 个触发器 + 记索引指纹
    memoryCrypto.installTriggers(db);
    memoryCrypto.ensureMetaTable(db);
    memoryCrypto.setMeta(db, 'fts_index_fingerprint', memoryCrypto.indexFingerprint());
})());

console.log(`  回补 memory_fragments_fts: ${db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c} 条`);
console.log(`  回补 memories_fts: ${db.prepare('SELECT COUNT(*) c FROM memories').get().c} 条`);
console.log('');
const ok = health();
process.exit(ok ? 0 : 1);
