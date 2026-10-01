// 印出 Scribe 在空資料庫、預設設定下實際送出的系統提示詞 SHA-256 與字數（用來確認 legacy 提示詞逐字不變）。
// 用法：node eval/scribe_prompt_hash.js   （LLM／Chroma／Librarian 全部 stub，不打外部服務）
const crypto = require('crypto');
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `scribe_prompt_hash_${process.pid}_${Date.now()}.db`);
process.env.SANCTUARY_ENCRYPTION_KEY = process.env.SANCTUARY_ENCRYPTION_KEY || '0'.repeat(64);
const llm = require('../services/llm');
const memory = require('../services/memory');
let captured = '';
llm.callLLM = async (_m, sys) => { captured = sys; return { reply: '{"entries":[],"fulfilled_intention_ids":[]}' }; };
memory.chromaDBOperation = async () => { throw new Error('stub'); };
const libPath = require.resolve('../services/librarian');
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { searchHybrid: async () => [] } };
require('../database').initDatabase();
const { runScribe } = require('../services/scribe');
const m = [{ id: 1, sender: 'user', content: '我今天去爬山，好累', timestamp: '2026-05-02 05:22:00', message_type: 'text', is_encrypted: 0 }];
runScribe(m, m[0].timestamp).then(() => {
    console.log(`sha256=${crypto.createHash('sha256').update(captured).digest('hex')} chars=${captured.length}`);
    process.exit(0);
});
