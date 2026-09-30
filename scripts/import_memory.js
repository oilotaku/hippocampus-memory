// scripts/import_memory.js — 匯入記憶庫匯出檔案（遷移 / 恢復）
//
// 用法：
//   node scripts/import_memory.js <檔案.jsonl> [--merge]
//
//   預設：跳過已存在的記錄（INSERT OR IGNORE，按主鍵 id 去重，可安全重複匯入）。
//   --merge：對已存在的 id 做覆蓋更新（慎用，會覆蓋目標庫現有內容）。
//
// 注意：匯入前目標庫應是乾淨的新庫（或至少沒有同 id 衝突的記錄）。

const fs = require('fs');
const { initDatabase, getDb } = require('../database');
const { isEncryptedField, sealField } = require('../services/memoryCrypto');

// 白名單：只允許匯入這些表，防止惡意匯出檔案執行任意 SQL
const ALLOWED_TABLES = new Set(['entity_profiles', 'memory_fragments', 'fragment_entities', 'memories']);

function main() {
    const args = process.argv.slice(2);
    const inFile = args.find(a => !a.startsWith('--'));
    const merge = args.includes('--merge');

    if (!inFile || !fs.existsSync(inFile)) {
        console.log('用法: node scripts/import_memory.js <檔案.jsonl> [--merge]');
        process.exit(1);
    }

    initDatabase();
    const db = getDb();

    const lines = fs.readFileSync(inFile, 'utf8').split('\n');
    let imported = 0, skipped = 0;
    const counts = {};

    const tx = db.transaction(() => {
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            let obj;
            try { obj = JSON.parse(t); } catch { continue; }
            const { table, row } = obj || {};
            if (!table || !row || typeof row !== 'object' || !ALLOWED_TABLES.has(table)) continue;

            const cols = Object.keys(row);
            const placeholders = cols.map(() => '?').join(',');
            // W3：記憶本體欄位寫入前加密（MEMORY_ENCRYPTION=off 時原樣）。
            // 匯出檔裡已經是 enc: 的值（舊版匯出的密文）原樣保留，不重複加密。
            const values = cols.map(c => {
                const v = row[c];
                if (!isEncryptedField(table, c) || (typeof v === 'string' && v.startsWith('enc:'))) return v;
                return sealField(table, c, v);
            });

            if (merge) {
                // 覆蓋更新：REPLACE INTO（按主鍵 id 替換）
                db.prepare(`REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(...values);
                imported++;
            } else {
                const r = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(...values);
                if (r.changes > 0) imported++; else skipped++;
            }
            counts[table] = (counts[table] || 0) + 1;
        }
    });
    tx();

    console.log('✅ 記憶庫匯入完成');
    for (const t of Object.keys(counts)) console.log(`   ${t}: ${counts[t]} 條`);
    console.log(`   寫入 ${imported} 條，跳過 ${skipped} 條（已存在）`);
    console.log('\n匯入後，FTS 全文索引會由觸發器自動重建，無需手動操作。');
    process.exit(0);
}

main().catch(e => { console.error('❌ 匯入失敗:', e); process.exit(1); });
