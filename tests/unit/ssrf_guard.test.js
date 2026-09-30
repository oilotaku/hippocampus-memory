const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const guard = require('../../utils/ssrf-guard');
const { assertSafeEndpoint, joinEndpointPath, safeFetch, isBlockedIP, SsrfError } = guard;

const pub = async () => ['93.184.216.34'];
const rejects = (url, opts = {}) => assert.rejects(() => assertSafeEndpoint(url, { resolver: pub, allowlist: '', ...opts }), SsrfError);
const ok = (url, opts = {}) => assertSafeEndpoint(url, { resolver: pub, allowlist: '', ...opts });

test('公網 https 域名通過', async () => {
    const r = await ok('https://api.example.com/v1beta');
    assert.deepStrictEqual(r.addresses, ['93.184.216.34']);
});

test('私有/保留 IPv4 字面量被拒絕', async () => {
    for (const ip of ['0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.0.1',
        '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
        '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255']) {
        await rejects(`https://${ip}/`);
    }
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '198.17.0.1', '198.20.0.1', '1.1.1.1']) {
        await ok(`https://${ip}/`);
    }
});

test('IPv6 私有/保留被拒絕，公網通過', async () => {
    for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2002:a9fe:a9fe::1']) {
        await rejects(`https://[${ip}]/`);
    }
    await ok('https://[2606:4700:4700::1111]/');
    await ok('https://[2001:4860:4860::8888]/');
});

test('IPv4-mapped IPv6 以實際 hextet 解碼判斷', async () => {
    await rejects('https://[::ffff:127.0.0.1]/');
    await rejects('https://[::ffff:7f00:1]/');
    await rejects('https://[::ffff:a9fe:a9fe]/');   // 169.254.169.254
    await rejects('https://[0:0:0:0:0:ffff:c0a8:0101]/'); // 192.168.1.1
    await ok('https://[::ffff:808:808]/');           // 8.8.8.8
    assert.strictEqual(isBlockedIP('::ffff:10.0.0.1'), true);
    assert.strictEqual(isBlockedIP('::ffff:8.8.8.8'), false);
});

test('十進位/十六進位/八進位 IP 寫法被正規化後拒絕', async () => {
    for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://0177.0.0.1/', 'http://0x7f000001/',
        'http://127.1/', 'http://2852039166/', 'http://0xa9fea9fe/', 'http://0/']) {
        await rejects(u.replace('http:', 'https:'));
        await rejects(u); // http 也拒絕
    }
});

test('wildcard DNS（nip.io 類）解析到內網 IP 被拒絕；任一 IP 私有即拒絕', async () => {
    const r = async () => ['169.254.169.254'];
    await assert.rejects(() => assertSafeEndpoint('https://169.254.169.254.nip.io/', { resolver: r, allowlist: '' }), SsrfError);
    const mixed = async () => ['93.184.216.34', '10.0.0.5'];
    await assert.rejects(() => assertSafeEndpoint('https://evil.example.com/', { resolver: mixed, allowlist: '' }), SsrfError);
    const v6 = async () => [{ address: '::ffff:127.0.0.1', family: 6 }];
    await assert.rejects(() => assertSafeEndpoint('https://evil.example.com/', { resolver: v6, allowlist: '' }), SsrfError);
    await assert.rejects(() => assertSafeEndpoint('https://evil.example.com/', { resolver: async () => [], allowlist: '' }), SsrfError);
});

test('localhost 與 *.localhost 被拒絕', async () => {
    await rejects('https://localhost/');
    await rejects('https://localhost./');
    await rejects('https://foo.localhost/');
});

test('帳密、非 http(s)、http 非白名單、空值被拒絕', async () => {
    await rejects('https://user:pass@api.example.com/');
    await rejects('https://user@api.example.com/');
    await rejects('http://api.example.com/');
    await rejects('ftp://api.example.com/');
    await rejects('file:///etc/passwd');
    await rejects('not a url');
    await rejects('');
    await assert.rejects(() => assertSafeEndpoint(undefined, { resolver: pub }), SsrfError);
    await rejects('http://user:pw@127.0.0.1:11434', { allowlist: 'http://127.0.0.1:11434' }); // 白名單也不可帶帳密
});

test('白名單：origin 完全相符才放行', async () => {
    const allowlist = 'http://127.0.0.1:11434';
    const r = await assertSafeEndpoint('http://127.0.0.1:11434/v1', { resolver: pub, allowlist });
    assert.strictEqual(r.allowlisted, true);
    await assertSafeEndpoint('http://127.0.0.1:11434', { resolver: pub, allowlist });
    await assertSafeEndpoint('http://127.0.0.1:11434/', { resolver: pub, allowlist });
    // 白名單條目帶尾斜線、大寫、空白也正規化
    await assertSafeEndpoint('http://127.0.0.1:11434/v1', { resolver: pub, allowlist: ' HTTP://127.0.0.1:11434/ ' });
    await assertSafeEndpoint('http://localhost:11434/v1', { resolver: pub, allowlist: 'http://LocalHost:11434' });
    // 預設 port 補齊
    await assertSafeEndpoint('https://127.0.0.1/v1', { resolver: pub, allowlist: 'https://127.0.0.1:443' });
    // 多個條目
    await assertSafeEndpoint('http://127.0.0.1:11434', { resolver: pub, allowlist: 'http://10.0.0.1:80, http://127.0.0.1:11434' });
    // 繞過嘗試
    for (const bad of ['http://127.0.0.1:11434.evil.com', 'http://127.0.0.1:114340', 'http://127.0.0.1:1143',
        'https://127.0.0.1:11434', 'http://127.0.0.2:11434', 'http://127.0.0.1', 'http://127.0.0.1@evil.com:11434',
        'http://evil.com#@127.0.0.1:11434', 'http://127.0.0.1.evil.com:11434']) {
        await assert.rejects(() => assertSafeEndpoint(bad, { resolver: async () => ['127.0.0.1'], allowlist }), SsrfError, bad);
    }
});

test('白名單預設讀取環境變數 LLM_ENDPOINT_ALLOWLIST，且預設為空即完全套用規則', async () => {
    const old = process.env.LLM_ENDPOINT_ALLOWLIST;
    try {
        delete process.env.LLM_ENDPOINT_ALLOWLIST;
        await assert.rejects(() => assertSafeEndpoint('http://127.0.0.1:11434', { resolver: pub }), SsrfError);
        process.env.LLM_ENDPOINT_ALLOWLIST = 'http://127.0.0.1:11434';
        await assertSafeEndpoint('http://127.0.0.1:11434/v1', { resolver: pub });
        await assert.rejects(() => assertSafeEndpoint('http://127.0.0.1:11435', { resolver: pub }), SsrfError);
    } finally {
        if (old === undefined) delete process.env.LLM_ENDPOINT_ALLOWLIST; else process.env.LLM_ENDPOINT_ALLOWLIST = old;
    }
});

test('joinEndpointPath 保留 endpoint 路徑並編碼特殊字元', () => {
    assert.strictEqual(joinEndpointPath('https://a.com/v1beta', 'models/x:generateContent', { key: 'k' }),
        'https://a.com/v1beta/models/x:generateContent?key=k');
    assert.strictEqual(joinEndpointPath('https://a.com/v1beta/', '/models/x'), 'https://a.com/v1beta/models/x');
    assert.strictEqual(joinEndpointPath('https://a.com', 'embeddings'), 'https://a.com/embeddings');
    const u = new URL(joinEndpointPath('https://a.com/v1beta', 'models/x?evil=1#frag:gen', { key: 'a&b=c' }));
    assert.strictEqual(u.host, 'a.com');
    assert.strictEqual(u.searchParams.get('key'), 'a&b=c');
    assert.strictEqual(u.searchParams.get('evil'), null);
    assert.strictEqual(u.hash, '');
});

// ---------- 本機 server：轉址與釘 IP ----------
function listen(handler) {
    return new Promise(resolve => {
        const hits = [];
        const srv = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
        srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port }));
    });
}

test('safeFetch：3xx 轉址被阻止，且不會跟到目標', async () => {
    const target = await listen((req, res) => res.end('secret'));
    const redirector = await listen((req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.port}/meta` }); res.end(); });
    try {
        const allowlist = `http://127.0.0.1:${redirector.port}`;
        await assert.rejects(() => safeFetch(`http://127.0.0.1:${redirector.port}/x`, {}, { allowlist }), /轉址/);
        assert.deepStrictEqual(redirector.hits, ['/x']);
        assert.deepStrictEqual(target.hits, []);
    } finally { redirector.srv.close(); target.srv.close(); }
});

test('safeFetch：正常回應可讀取；連線釘在驗證過的 IP（不再另行解析）', async () => {
    const s = await listen((req, res) => res.end('hello'));
    try {
        // 主機名是假的，resolver 回 127.0.0.1（白名單放行），釘 IP 後才連得上
        const allowlist = `http://pinned.invalid:${s.port}`;
        const resp = await safeFetch(`http://pinned.invalid:${s.port}/ok`, {}, { allowlist, resolver: async () => ['127.0.0.1'] });
        assert.strictEqual(await resp.text(), 'hello');
        assert.deepStrictEqual(s.hits, ['/ok']);
    } finally { s.srv.close(); }
});

test('safeFetch：被阻止的端點完全不發出請求', async () => {
    const s = await listen((req, res) => res.end('x'));
    try {
        await assert.rejects(() => safeFetch(`http://127.0.0.1:${s.port}/`, {}, { allowlist: '' }), SsrfError);
        await assert.rejects(() => safeFetch(`https://evil.example/`, {}, { allowlist: '', resolver: async () => ['127.0.0.1'] }), SsrfError);
        assert.deepStrictEqual(s.hits, []);
    } finally { s.srv.close(); }
});

// ---------- 整合：/api/test-llm ----------
test('/api/test-llm：惡意 endpoint 回 400 且目標未收到請求；白名單端點可正常使用', async () => {
    process.env.DB_PATH = path.join(os.tmpdir(), `ssrf-int-${process.pid}.db`);
    process.env.SANCTUARY_ENCRYPTION_KEY = process.env.SANCTUARY_ENCRYPTION_KEY || '0'.repeat(64);
    delete process.env.LLM_ENDPOINT_ALLOWLIST;
    const express = require('express');
    const memoryApi = require('../../routes/memory-api');

    const victim = await listen((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { authenticated: true }; next(); });
    app.use(memoryApi);
    const appSrv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = async (endpoint) => {
        const r = await fetch(`http://127.0.0.1:${appSrv.address().port}/api/test-llm`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: 'k', model_name: 'm', endpoint }),
        });
        return { status: r.status, body: await r.json() };
    };
    try {
        for (const ep of [`http://127.0.0.1:${victim.port}`, `https://127.0.0.1:${victim.port}`,
            'https://169.254.169.254/latest/meta-data', 'https://[::ffff:169.254.169.254]/', 'http://2130706433/',
            'https://user:pw@example.com/']) {
            const r = await call(ep);
            assert.strictEqual(r.status, 400, ep);
            assert.strictEqual(r.body.success, false);
        }
        assert.deepStrictEqual(victim.hits, []);

        // 白名單精準放行後，同一個端點可用（證明路徑拼接與釘 IP 沒弄壞正常流程）
        process.env.LLM_ENDPOINT_ALLOWLIST = `http://127.0.0.1:${victim.port}`;
        const good = await call(`http://127.0.0.1:${victim.port}/v1beta`);
        assert.strictEqual(good.status, 200);
        assert.strictEqual(good.body.success, true);
        assert.strictEqual(victim.hits.length, 1);
        assert.ok(victim.hits[0].startsWith('/v1beta/models/m:generateContent'), victim.hits[0]);
    } finally {
        delete process.env.LLM_ENDPOINT_ALLOWLIST;
        appSrv.close(); victim.srv.close();
    }
});
