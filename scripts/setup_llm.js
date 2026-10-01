// scripts/setup_llm.js — 引導配置輕量模型（記憶管線用的後臺模型）
//
// 用法：
//   node scripts/setup_llm.js                      （互動式，推薦）
//   node scripts/setup_llm.js --provider openrouter --key sk-xxx --model "deepseek/deepseek-chat"
//   echo sk-xxx | node scripts/setup_llm.js --provider openrouter --key -   （key 從 stdin 讀，不留在命令列與 shell 歷史）
//
// 說明：
//   記憶管線（Scribe 提取碎片 / Archivist 分類整合 / Consolidator 編敘事）
//   需要呼叫 LLM，但都是後臺批次任務，用「輕量模型」（flash / flash-lite 級別）
//   即可，便宜夠用。聊天用的主力模型不在這裡配。
//
//   本指令碼在 api_configs 表裡建一條 is_default=1 的配置，後臺管線在
//   找不到專屬配置時會自動回落到這條預設配置。
//
// 提供商預設（endpoint 自動填）：
//   openrouter   OpenAI 相容，https://openrouter.ai/api/v1
//   deepseek     OpenAI 相容，https://api.deepseek.com/v1
//   gemini       Gemini 原生，https://generativelanguage.googleapis.com/v1beta/models/
//   ollama       本機 Ollama（OpenAI 相容），http://127.0.0.1:11434/v1，不需要 API Key
//                ⚠️ 需另設環境變數 LLM_ENDPOINT_ALLOWLIST=http://127.0.0.1:11434（SSRF 防護預設拒絕私有地址/http）

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });   // 資料庫加密金鑰在 .env
const readline = require('readline');
const { initDatabase, getDb } = require('../database');

const PROVIDERS = {
    openrouter: { provider: 'openai_compatible', endpoint: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', label: 'OpenRouter' },
    deepseek:   { provider: 'openai_compatible', endpoint: 'https://api.deepseek.com/v1',      model: 'deepseek-chat',        label: 'DeepSeek' },
    ollama:     { provider: 'openai_compatible', endpoint: 'http://127.0.0.1:11434/v1',       model: 'qwen3-8b-zh',          label: 'Ollama（本機）', keyless: true },
    gemini:     { provider: 'gemini',             endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/', model: 'gemini-2.5-flash', label: 'Gemini 官方' },
};

function parseArgs(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--provider') a.provider = argv[++i];
        else if (argv[i] === '--key' || argv[i] === '--api-key') a.key = argv[++i];
        else if (argv[i] === '--model') a.model = argv[++i];
        else if (argv[i] === '--endpoint') a.endpoint = argv[++i];
        else if (argv[i] === '--name') a.name = argv[++i];
    }
    return a;
}

function ask(rl, q) {
    return new Promise(res => rl.question(q, res));
}

function readStdinLine() {
    return new Promise((resolve, reject) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => { buf += d; });
        process.stdin.on('end', () => resolve(buf.split(/\r?\n/)[0].trim()));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.key === '-') flags.key = await readStdinLine();

    let providerKey, apiKey, model, endpoint, name;

    if (flags.provider && (flags.key || PROVIDERS[flags.provider]?.keyless)) {
        // 非互動模式
        providerKey = flags.provider;
        apiKey = flags.key || (PROVIDERS[providerKey]?.keyless ? 'none' : '');
        model = flags.model || PROVIDERS[providerKey]?.model;
        endpoint = flags.endpoint || PROVIDERS[providerKey]?.endpoint;
        name = flags.name || `輕量模型 (${providerKey})`;
    } else {
        // 互動模式
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log('\n🌟 配置記憶管線用的輕量模型\n');
        console.log('可選提供商：');
        for (const [k, v] of Object.entries(PROVIDERS)) {
            console.log(`   ${k.padEnd(12)} ${v.label}  (${v.endpoint})`);
        }
        console.log('（預設 openrouter）\n');

        const p = (await ask(rl, '提供商 [openrouter/deepseek/gemini/ollama] (回車=openrouter): ')).trim().toLowerCase() || 'openrouter';
        providerKey = PROVIDERS[p] ? p : 'openrouter';
        if (PROVIDERS[providerKey].keyless) {
            apiKey = (await ask(rl, 'API Key (本機 Ollama 不需要，回車跳過): ')).trim() || 'none';
        } else {
            apiKey = (await ask(rl, `API Key (${PROVIDERS[providerKey].label}): `)).trim();
        }
        if (!apiKey) { console.error('❌ API Key 不能為空'); process.exit(1); }
        const dm = PROVIDERS[providerKey].model;
        model = (await ask(rl, `模型名 (回車=${dm}): `)).trim() || dm;
        endpoint = (await ask(rl, `Endpoint (回車=${PROVIDERS[providerKey].endpoint}): `)).trim() || PROVIDERS[providerKey].endpoint;
        name = (await ask(rl, '這條配置的名字 (回車=輕量模型): ')).trim() || '輕量模型';
        rl.close();
    }

    if (!apiKey) { console.error('❌ 缺少 API Key'); process.exit(1); }
    if (!model) { console.error('❌ 缺少模型名'); process.exit(1); }

    const preset = PROVIDERS[providerKey];
    if (!preset) { console.error(`❌ 未知提供商: ${providerKey}（可選 openrouter/deepseek/gemini/ollama）`); process.exit(1); }

    initDatabase();
    const db = getDb();

    // 若已有預設配置，先取消預設（避免衝突），再插入新的預設配置
    db.prepare('UPDATE api_configs SET is_default = 0 WHERE is_default = 1').run();
    const info = db.prepare(`
        INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
        VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run(name, preset.provider, endpoint, apiKey, model);

    console.log(`\n✅ 輕量模型已配置（api_configs #${info.lastInsertRowid}）`);
    console.log(`   名字:     ${name}`);
    console.log(`   提供商:   ${preset.provider}`);
    console.log(`   模型:     ${model}`);
    console.log(`   Endpoint: ${endpoint}`);
    console.log(`   已設為預設（is_default=1）`);
    console.log('\n後臺記憶管線（Scribe/Archivist/Consolidator）會自動使用這條配置。');
    console.log('如需更改，重新執行本指令碼即可。');
    process.exit(0);
}

main().catch(e => { console.error('❌ 配置失敗:', e); process.exit(1); });
