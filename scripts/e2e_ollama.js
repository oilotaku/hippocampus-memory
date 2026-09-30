// scripts/e2e_ollama.js — 用本機 Ollama 真跑一次 Scribe 抽取 + Librarian 檢索（端到端）
//
// 不屬於 `npm test`（要真模型、CPU 推論每次約 5~11 秒）。用法（Windows cmd）：
//   set LLM_ENDPOINT_ALLOWLIST=http://127.0.0.1:11434&& set SANCTUARY_ENCRYPTION_KEY=<64 hex>&& node scripts/e2e_ollama.js
// 可選環境變數：OLLAMA_URL（預設 http://127.0.0.1:11434）、OLLAMA_MODEL（預設 qwen3-8b-zh）、
//   E2E_REUSE_DB=<路徑>：沿用上次跑完 Scribe 的暫存 DB，只重跑 Librarian 查詢（省下幾分鐘推論）
//
// 流程：暫存 DB → 寫入一條 Ollama 預設 api_config（與 setup_llm.js 相同做法，
// Scribe 寫死的 config id 會回落到預設）→ 10 則模擬中文對話 → runScribe →
// Librarian 查「我住哪」「媽媽生日」「我對什麼過敏」。ChromaDB 不啟動，向量路徑降級。

const os = require('os');
const path = require('path');

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-8b-zh';

const REUSE = process.env.E2E_REUSE_DB || '';
process.env.DB_PATH = REUSE || path.join(os.tmpdir(), `mc-e2e-ollama-${process.pid}-${Date.now()}.db`);
if (!process.env.SANCTUARY_ENCRYPTION_KEY) process.env.SANCTUARY_ENCRYPTION_KEY = '0'.repeat(64);
if (!process.env.LLM_ENDPOINT_ALLOWLIST) process.env.LLM_ENDPOINT_ALLOWLIST = OLLAMA_URL;

const llm = require('../services/llm');
const memory = require('../services/memory');

// Chroma 未啟動：讓向量路徑直接失敗並降級（Scribe/Librarian 都有 try/catch 降級）
memory.chromaDBOperation = async () => { throw new Error('Chroma 未啟動（e2e 刻意降級）'); };

// 包一層 callLLM 記錄耗時與模型原始輸出
const realCallLLM = llm.callLLM;
const llmLog = [];
llm.callLLM = async (...args) => {
    const t0 = Date.now();
    const r = await realCallLLM(...args);
    llmLog.push({ ms: Date.now() - t0, reply: r.reply, usage: r.usage });
    return r;
};

const { initDatabase, getDb } = require('../database');
initDatabase();
const db = getDb();

// 與 scripts/setup_llm.js --provider ollama 等價
if (!REUSE) {
    db.prepare('UPDATE api_configs SET is_default = 0').run();
    db.prepare(`INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                VALUES (?, 'openai_compatible', ?, 'none', ?, 1, 1)`)
        .run('本機 Ollama', `${OLLAMA_URL}/v1`, OLLAMA_MODEL);
}
// embedding 通道：名稱含 "embedding" 的配置會被 getEmbedding 選用（模型 bge-m3，1024 維）
if (!db.prepare("SELECT 1 FROM api_configs WHERE name LIKE '%embedding%'").get()) {
    db.prepare(`INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                VALUES ('本機 Ollama embedding', 'openai_compatible', ?, 'none', 'bge-m3', 0, 0)`)
        .run(`${OLLAMA_URL}/v1`);
}

const { runScribe } = require('../services/scribe');
const { searchHybrid } = require('../services/librarian');

const DAY = '2026-06-01';
const convo = [
    ['user', '早安，今天有點涼'],
    ['ai',   '早安！記得帶件外套。'],
    ['user', '我現在住在三重，離捷運站走路五分鐘'],
    ['ai',   '三重交通很方便呢。'],
    ['user', '對了，我媽媽的生日是10月8號，我想先訂蛋糕'],
    ['ai',   '好主意，早點訂比較不會沒位子。'],
    ['user', '我最近在學日文，每天晚上背五十音'],
    ['ai',   '很棒，持續下去一定會進步。'],
    ['user', '提醒你一下，我對花生過敏，吃到會起疹子喘不過氣'],
    ['ai',   '我記住了，之後推薦食物會避開花生。'],
    ['user', '下個月十五號要去東京玩，超期待，不過一個人搭飛機有點緊張'],
    ['ai',   '第一次自己出國嗎？'],
    ['user', '今天被主管當眾罵，氣死我了，真的很想離職'],
    ['ai',   '聽起來你真的很難受。'],
];
const messages = convo.map(([sender, content], i) => ({
    id: i + 1, sender, content, message_type: 'text', is_encrypted: 0,
    timestamp: `${DAY} 20:${String(i).padStart(2, '0')}:00`,
}));

async function main() {
    console.log(`Ollama: ${OLLAMA_URL}  模型: ${OLLAMA_MODEL}  DB: ${process.env.DB_PATH}`);
    const t0 = Date.now();
    const r = REUSE ? null : await runScribe(messages, messages[messages.length - 1].timestamp);
    const scribeMs = Date.now() - t0;

    let proposed = null;
    try {
        const raw = llmLog[llmLog.length - 1]?.reply || '';
        proposed = JSON.parse(raw.replace(/```json|```/g, '').trim()).entries?.length ?? null;
    } catch (_) {}

    if (!REUSE) {
    console.log('\n===== Scribe 結果 =====');
    console.log(`LLM 呼叫: ${llmLog.length} 次，耗時 ${llmLog.map(l => (l.ms / 1000).toFixed(1) + 's').join(' + ')}，tokens ${JSON.stringify(llmLog[llmLog.length - 1]?.usage)}`);
    console.log(`模型提出條目: ${proposed}`);
    console.log(`寫入: ${r?.written}  |  quote 驗證丟棄: ${r?.quoteDropped} ${JSON.stringify(r?.quoteDroppedByType || {})}  |  重複: ${r?.duplicates}`);
    console.log(`Scribe 總耗時: ${(scribeMs / 1000).toFixed(1)}s`);
    if (!r?.written || process.env.E2E_SHOW_REPLY) console.log('模型原始輸出（前 3000 字）:\n' + String(llmLog[llmLog.length - 1]?.reply || '').slice(0, 3000));

    }
    const rows = db.prepare('SELECT * FROM memory_fragments ORDER BY id').all();
    console.log('\n寫入的碎片:');
    for (const f of rows) {
        console.log(`  #${f.id} [${f.type}] ${f.entity}: ${f.content}  （quote: ${f.quote}）`);
        // G2：八維情緒（原始分數）、衍生 intensity / valence、事件日期、時間與時段
        if (f.intensity !== null && f.intensity !== undefined) {
            const emo = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation']
                .map(d => `${d}=${(f['emo_' + d] ?? 0).toFixed(2)}`).join(' ');
            console.log(`      情緒 ${emo}`);
            console.log(`      intensity=${f.intensity.toFixed(2)} valence=${f.valence.toFixed(2)} conf=${f.emotion_conf} emotional_weight=${f.emotional_weight.toFixed(2)}`);
        } else {
            console.log('      情緒：（模型未輸出或 emotion.enabled=false）');
        }
        console.log(`      event_at=${f.event_at ?? 'null'} raised_at=${f.raised_at} 時段=${f.raised_slot} 週${f.weekday} tz=${f.tz}`);
    }
    const emo = require('../services/emotion');
    const bs = emo.getBaselineStatus(db);
    console.log(`\n個人情緒基準：學習中=${bs.learning}（有效樣本 ${bs.samples}/${bs.min_samples}）；轉折 ${db.prepare("SELECT COUNT(*) c FROM emotion_events WHERE anomalies != '[]'").get().c} 條碎片`);

    console.log('\n===== Librarian 查詢 =====');
    // 前三個是繁體查詢；後三個是簡體寫法對照（W9：斷詞前逐字簡繁正規化，簡繁查詢都應命中，與碎片本身是哪種字體無關）
    for (const q of ['我住在哪裡', '媽媽生日', '我對什麼過敏', '我住在哪里', '妈妈生日', '我对什么过敏']) {
        const t1 = Date.now();
        const hits = await searchHybrid(q, 8);
        console.log(`\n查詢「${q}」 (${Date.now() - t1}ms，命中 ${hits.length})`);
        hits.slice(0, 3).forEach((h, i) => console.log(`  Top${i + 1}: #${h.id} ${h.entity ? h.entity + ': ' : ''}${h.content}`));
        if (hits.length === 0) console.log('  （無命中）');
    }
}

async function embeddingCheck() {
    console.log('\n===== Embedding（bge-m3 經 /v1/embeddings）=====');
    try {
        const t = Date.now();
        const v = await llm.getEmbedding('我住在三重');
        console.log(`維度 ${v.length}，耗時 ${Date.now() - t}ms，前 3 值 ${v.slice(0, 3).map(x => x.toFixed(4)).join(', ')}`);
    } catch (e) { console.log('embedding 失敗:', e.message); }
}

main().then(embeddingCheck).then(() => process.exit(0)).catch(e => { console.error('e2e 失敗:', e); process.exit(1); });
