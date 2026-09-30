'use strict';
// G3 API：需要登入；列出、套用、拒絕、回滾提案；事件與狀態查詢。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupEnv, cleanupDb, quiet, listenSafe } = require('./_helpers');
const { seedQualifiedTrait } = require('./_persona_helpers');

const dbPath = setupEnv('persona-api');
let restore, db, persona, server, base, authed = true;

const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json, location: res.headers.get('location') };
};

before(async () => {
    restore = quiet();
    require('../../database').initDatabase();
    db = require('../../database').getDb();
    persona = require('../../services/persona');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { authenticated: authed }; next(); });
    app.use(require('../../routes/persona-api'));
    server = http.createServer(app);
    await listenSafe(server);
    base = `http://127.0.0.1:${server.address().port}`;
    persona.recordCoreVersion({ text: '核心層文字' });
    for (const t of ['特質一', '特質二', '特質三']) seedQualifiedTrait(db, t, 0.9);
    persona.generateProposals({ cfg: { persona: { auto_apply: false } } });
});
after(async () => { await new Promise(r => server.close(r)); restore(); cleanupDb(dbPath); });

test('未登入 → 導向登入頁，不洩漏資料', async () => {
    authed = false;
    for (const [m, p] of [['GET', '/api/persona/status'], ['GET', '/api/persona/proposals'], ['POST', '/api/persona/proposals/1/apply'], ['POST', '/api/persona/drift-check']]) {
        const r = await call(m, p);
        assert.equal(r.status, 302, `${m} ${p}`);
        assert.equal(r.location, '/login');
    }
    authed = true;
});

test('列出提案（可依狀態篩選、無效狀態 400）', async () => {
    const all = await call('GET', '/api/persona/proposals');
    assert.equal(all.json.proposals.length, 3);
    const p = all.json.proposals[0];
    assert.ok(p.content && Array.isArray(p.evidence_ids) && p.evidence_ids.length === 3 && p.diff && p.status === 'pending');
    assert.equal((await call('GET', '/api/persona/proposals?status=applied')).json.proposals.length, 0);
    assert.equal((await call('GET', '/api/persona/proposals?status=bogus')).status, 400);
});

test('套用 → 409 重複套用；拒絕；回滾；找不到 404；壞編號 400', async () => {
    const [p1, p2, p3] = (await call('GET', '/api/persona/proposals')).json.proposals.map(p => p.id).sort((a, b) => a - b);
    const applied = await call('POST', `/api/persona/proposals/${p1}/apply`);
    assert.equal(applied.status, 200);
    assert.equal(applied.json.version, 1);
    assert.equal(applied.json.proposal.status, 'applied');
    assert.equal((await call('POST', `/api/persona/proposals/${p1}/apply`)).status, 409);
    const rejected = await call('POST', `/api/persona/proposals/${p2}/reject`, { note: '不準' });
    assert.equal(rejected.json.proposal.status, 'rejected');
    assert.equal(rejected.json.proposal.note, '不準');
    await call('POST', `/api/persona/proposals/${p3}/apply`);
    const rb = await call('POST', `/api/persona/proposals/${p1}/rollback`);
    assert.equal(rb.status, 200);
    assert.equal(rb.json.proposal.status, 'rolled_back');
    assert.equal((await call('POST', '/api/persona/proposals/99999/apply')).status, 404);
    assert.equal((await call('POST', '/api/persona/proposals/abc/apply')).status, 400);
    assert.equal((await call('POST', `/api/persona/proposals/${p2}/rollback`)).status, 409);
});

test('狀態、核心歷史、關係層版本、事件', async () => {
    const st = (await call('GET', '/api/persona/status')).json;
    assert.equal(st.core.version, 1);
    assert.equal(st.relationship.lines.length, 1);
    assert.equal(st.pending_proposals, 0);
    assert.equal(st.config.auto_apply, true);
    assert.equal((await call('GET', '/api/persona/core-history')).json.versions.length, 1);
    const versions = (await call('GET', '/api/persona/relationship/versions')).json.versions;
    assert.equal(versions.length, 3);
    const events = (await call('GET', '/api/persona/events?kind=proposal_applied')).json.events;
    assert.equal(events.length, 2);
});

test('judgment 歷史查詢；壞編號 400', async () => {
    db.prepare("INSERT INTO entity_judgment_history (entity_id, judgment, reason) VALUES (7, '舊印象', 'replaced')").run();
    const r = (await call('GET', '/api/persona/judgment/7')).json;
    assert.equal(r.history.length, 1);
    assert.equal(r.history[0].judgment, '舊印象');
    assert.equal((await call('GET', '/api/persona/judgment/x')).status, 400);
});
