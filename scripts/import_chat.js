// scripts/import_chat.js — 匯入聊天記錄到記憶庫
//
// 用法：
//   node scripts/import_chat.js <檔案.jsonl|檔案.txt> [選項]
//
// 選項：
//   --name "會話名"    新會話的名字（預設 "匯入 <檔名> <日期>"）
//   --chat-id <N>      寫入到已有的 chat（不新建）
//   --dry-run          只解析不寫入，列印前幾行預覽
//
// 支援格式（與 services/chatParser.js 一致）：
//   JSON 陣列 / JSONL（每行一個 JSON）/ TXT（每行「名字: 內容」）
//
// 匯入後，後臺 agent loop（2 分鐘一次 tick）會自動觸發 Scribe 掃描這批訊息、
// 提取記憶碎片，無需手動操作。

const fs = require('fs');
const path = require('path');
const { initDatabase, getDb } = require('../database');
const { USER, AI } = require('../services/nameResolver');
const { parseAny } = require('../services/chatParser');
const { fillTimestamps, importMessages } = require('../services/chatImport');

// ── 引數解析 ──
function parseArgs(argv) {
    const args = { file: null, name: null, chatId: null, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--name' || a === '-n') args.name = argv[++i];
        else if (a === '--chat-id') args.chatId = parseInt(argv[++i], 10);
        else if (a === '--dry-run') args.dryRun = true;
        else if (!args.file) args.file = a;
    }
    return args;
}

// ── 主流程 ──
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.file) {
        console.log('用法: node scripts/import_chat.js <檔案.jsonl|檔案.txt> [--name "會話名"] [--chat-id N] [--dry-run]');
        process.exit(1);
    }
    if (!fs.existsSync(args.file)) {
        console.error(`❌ 檔案不存在: ${args.file}`);
        process.exit(1);
    }

    initDatabase();

    const raw = fs.readFileSync(args.file, 'utf8');
    const msgs = fillTimestamps(parseAny(raw));
    if (msgs.length === 0) {
        console.error('❌ 沒有解析出任何訊息。請檢查格式（JSON 陣列 / JSONL 每行一個 JSON / TXT 每行「名字: 內容」）。');
        process.exit(1);
    }

    console.log(`\n📥 解析到 ${msgs.length} 條訊息`);
    console.log(`   使用者訊息: ${msgs.filter(m => m.sender === 'user').length} 條`);
    console.log(`   伴侶訊息: ${msgs.filter(m => m.sender === 'ai').length} 條`);
    console.log('   預覽：');
    for (const m of msgs.slice(0, 5)) {
        console.log(`     [${m.timestamp}] ${m.sender === 'user' ? USER.name : AI.name}: ${m.content.slice(0, 40)}`);
    }

    if (args.dryRun) {
        console.log('\n(dry-run 模式，未寫入)');
        process.exit(0);
    }

    const name = args.name || `匯入 ${path.basename(args.file)} ${new Date().toISOString().slice(0, 10)}`;
    const { chatId, count } = importMessages(msgs, { chatId: args.chatId, name });

    console.log(`✅ 已寫入 ${count} 條訊息到 chat #${chatId}`);
    console.log(`\n下一步：後臺 agent loop 會在下個 tick（約 2 分鐘內）自動執行 Scribe 提取記憶碎片。`);
    process.exit(0);
}

main().catch(e => { console.error('❌ 匯入失敗:', e); process.exit(1); });
