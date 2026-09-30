// scripts/export_memory.js — 匯出記憶庫，方便遷移 / 備份
//
// 用法：
//   node scripts/export_memory.js [輸出檔案.jsonl]     （預設 memory_export.jsonl）
//
// 匯出內容（按依賴順序）：
//   entity_profiles    星座（人物/地點/事件實體，三欄位模型）
//   memory_fragments   記憶碎片（Scribe 提取的原始事實）
//   fragment_entities  碎片 ↔ 實體關聯
//   memories           敘事記憶（episode / saga）
//
// 匯出為 JSONL，每行一個 JSON 物件：
//   {"table":"memory_fragments","row":{...全部欄位...}}
//
// 對應的匯入指令碼：node scripts/import_memory.js <檔案.jsonl>

const fs = require('fs');
const { initDatabase, getDb } = require('../database');

const TABLES = ['entity_profiles', 'memory_fragments', 'fragment_entities', 'memories'];

function main() {
    const outFile = process.argv[2] || 'memory_export.jsonl';
    initDatabase();
    const db = getDb();

    const stream = fs.createWriteStream(outFile);
    let total = 0;
    const counts = {};

    for (const table of TABLES) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        counts[table] = rows.length;
        for (const row of rows) {
            stream.write(JSON.stringify({ table, row }) + '\n');
            total++;
        }
    }
    stream.end();

    console.log('✅ 記憶庫匯出完成');
    console.log(`   輸出檔案: ${outFile}`);
    for (const t of TABLES) console.log(`   ${t}: ${counts[t]} 條`);
    console.log(`   合計: ${total} 條記錄`);
    console.log('⚠️  匯出檔是**明文**（加密欄位已由透明解密層還原，方便換金鑰／換機器匯入），請妥善保管，用完刪除。');
    console.log('\n遷移到新機器後，用 `node scripts/import_memory.js ' + outFile + '` 匯入。');
    process.exit(0);
}

main().catch(e => { console.error('❌ 匯出失敗:', e); process.exit(1); });
