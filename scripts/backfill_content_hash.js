// scripts/backfill_content_hash.js — memory_fragments.content_hash 一次性回填
// 為已有碎片計算確定性內容雜湊，使 hash 硬去重對歷史資料同樣生效。
// 冪等：只處理 content_hash IS NULL 的行，可安全重複執行。
// 執行：node scripts/backfill_content_hash.js

const { initDatabase, getDb } = require('../database');
// W5 把 utils/text 的 hashFragmentContent 換成 scribeQuality.normalizedContentHash 時漏改這裡（原本 require 不到而報錯）。
// W3：on 模式下 normalizedContentHash 是帶金鑰的 HMAC；content 由 database.js 的透明解密層讀成明文。
const { normalizedContentHash: hashFragmentContent } = require('../services/scribeQuality');

initDatabase();
const db = getDb();

const rows = db.prepare(`
    SELECT id, entity, content FROM memory_fragments
    WHERE content_hash IS NULL
`).all();

console.log(`待回填 ${rows.length} 條碎片`);

if (rows.length > 0) {
    const update = db.prepare('UPDATE memory_fragments SET content_hash = ? WHERE id = ?');
    const tx = db.transaction((batch) => {
        for (const r of batch) {
            update.run(hashFragmentContent(r.entity, r.content), r.id);
        }
    });

    const BATCH = 500;
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        tx(rows.slice(i, i + BATCH));
        done += Math.min(BATCH, rows.length - i);
        console.log(`已回填 ${done}/${rows.length}`);
    }
    console.log('回填完成');
}

// 校驗：統計「同內容 + 同一天」的重複組數（與 scribe.js 去重規則一致）
// 跨天的同一句話是 source_diversity 證據，不算重複，不在這裡統計
const dup = db.prepare(`
    SELECT COUNT(*) AS c FROM (
        SELECT content_hash, source_date FROM memory_fragments
        WHERE content_hash IS NOT NULL
        GROUP BY content_hash, source_date HAVING COUNT(*) > 1
    )
`).get().c;
const remainingNull = db.prepare('SELECT COUNT(*) AS c FROM memory_fragments WHERE content_hash IS NULL').get().c;
console.log(`校驗：剩餘 NULL=${remainingNull}，同天重複組=${dup}`);
