// W8：本機 OpenAI 相容端點（Ollama）——無 API key 不送 Authorization；找不到專屬配置回落預設配置
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const { listenSafe } = require('./_helpers');

process.env.DB_PATH = path.join(os.tmpdir(), `mc-llm-local-${process.pid}-${Date.now()}.db`);
process.env.SANCTUARY_ENCRYPTION_KEY = '0'.repeat(64);

const { initDatabase, getDb } = require('../../database');
initDatabase();
const db = getDb();
const llm = require('../../services/llm');

let server, base, seen = [];
test.before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
            res.setHeader('Content-Type', 'application/json');
            if (req.url.endsWith('/embeddings')) return res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
            res.end(JSON.stringify({ choices: [{ message: { content: ' 你好 ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        });
    });
    // 整套並行、機器吃緊時，undici 會重用閒置的 keep-alive 連線；伺服器預設 5 秒就關閒置連線，
    // 兩邊剛好錯身會多一次重試（2 秒）而讓 seen 內容順序不可預期。拉長閒置時限、並以路徑挑紀錄。
    server.keepAliveTimeout = 60000;
    await listenSafe(server);
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.LLM_ENDPOINT_ALLOWLIST = base;
});
test.after(() => { server.closeAllConnections(); server.close(); });

function addConfig(name, key, isDefault) {
    return db.prepare(`INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                       VALUES (?, 'openai_compatible', ?, ?, 'qwen3-8b-zh', ?, 0)`).run(name, `${base}/v1`, key, isDefault).lastInsertRowid;
}
const msgs = [{ role: 'user', parts: [{ text: 'hi' }] }];

test('api_key 為 none 或空：不送 Authorization，路徑拼成 /v1/chat/completions', async () => {
    for (const key of ['none', '']) {
        seen = [];
        const id = addConfig(`local-${key || 'empty'}`, key, 0);
        const r = await llm.callLLM(msgs, 'sys', null, {}, id);
        assert.strictEqual(r.reply, '你好');
        assert.strictEqual(seen[0].url, '/v1/chat/completions');
        assert.strictEqual(seen[0].auth, undefined);
    }
});

test('有 api_key 仍送 Bearer', async () => {
    seen = [];
    const id = addConfig('keyed', 'sk-abc', 0);
    await llm.callLLM(msgs, 'sys', null, {}, id);
    assert.strictEqual(seen[0].auth, 'Bearer sk-abc');
});

test('專屬配置 id 不存在 → 回落到預設配置；無預設則報錯', async () => {
    db.prepare('UPDATE api_configs SET is_default = 0').run();
    await assert.rejects(() => llm.callLLM(msgs, 'sys', null, {}, 52), /未找到有效的API配置/);
    addConfig('default-local', 'none', 1);
    seen = [];
    const r = await llm.callLLM(msgs, 'sys', null, {}, 52);
    assert.strictEqual(r.reply, '你好');
    assert.strictEqual(seen.length, 1);
});

test('embedding：名稱含 embedding 的配置被選用，無 key 不送 Authorization', async () => {
    db.prepare(`INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                VALUES ('本機 Ollama embedding', 'openai_compatible', ?, 'none', 'bge-m3', 0, 0)`).run(`${base}/v1`);
    seen = [];
    const v = await llm.getEmbedding('我住在三重');
    assert.deepStrictEqual(v, [0.1, 0.2]);
    const emb = seen.filter(x => x.url === '/v1/embeddings');
    assert.ok(emb.length >= 1, `應打到 /v1/embeddings，實際 ${JSON.stringify(seen.map(x => x.url))}`);
    assert.strictEqual(emb[0].auth, undefined);
    assert.strictEqual(emb[0].body.model, 'bge-m3');
});
