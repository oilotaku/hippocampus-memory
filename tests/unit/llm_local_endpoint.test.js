// W8：本机 OpenAI 兼容端点（Ollama）——无 API key 不送 Authorization；找不到专属配置回落默认配置
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');

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
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.LLM_ENDPOINT_ALLOWLIST = base;
});
test.after(() => server.close());

function addConfig(name, key, isDefault) {
    return db.prepare(`INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                       VALUES (?, 'openai_compatible', ?, ?, 'qwen3-8b-zh', ?, 0)`).run(name, `${base}/v1`, key, isDefault).lastInsertRowid;
}
const msgs = [{ role: 'user', parts: [{ text: 'hi' }] }];

test('api_key 为 none 或空：不送 Authorization，路径拼成 /v1/chat/completions', async () => {
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

test('专属配置 id 不存在 → 回落到默认配置；无默认则报错', async () => {
    db.prepare('UPDATE api_configs SET is_default = 0').run();
    await assert.rejects(() => llm.callLLM(msgs, 'sys', null, {}, 52), /未找到有效的API配置/);
    addConfig('default-local', 'none', 1);
    seen = [];
    const r = await llm.callLLM(msgs, 'sys', null, {}, 52);
    assert.strictEqual(r.reply, '你好');
    assert.strictEqual(seen.length, 1);
});

test('embedding：名称含 embedding 的配置被选用，无 key 不送 Authorization', async () => {
    db.prepare(`INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                VALUES ('本机 Ollama embedding', 'openai_compatible', ?, 'none', 'bge-m3', 0, 0)`).run(`${base}/v1`);
    seen = [];
    const v = await llm.getEmbedding('我住在三重');
    assert.deepStrictEqual(v, [0.1, 0.2]);
    assert.strictEqual(seen[0].url, '/v1/embeddings');
    assert.strictEqual(seen[0].auth, undefined);
    assert.strictEqual(seen[0].body.model, 'bge-m3');
});
