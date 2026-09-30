'use strict';
// H1：星圖再鞏固 API（確認／否認／修改）。LLM 不參與這條路徑；chroma 一律 stub。
// 加密 on／off 兩模式都要過：DB 內為密文（on），讀回明文正確。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupEnv, cleanupDb, quiet, listenSafe } = require('./_helpers');

const dbPath = setupEnv('reconsolidate');
let restore, db, server, base, authed = true, entityId, entityName = '小雨';
let sealField, chromaCalls = [];
const ENC_ON = process.env.MEMORY_ENCRYPTION !== 'off';

const call = async (action, body) => {
    const res = await fetch(`${base}/api/memory/reconsolidate/${action}`, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json, location: res.headers.get('location') };
};
const raw = (sql, ...a) => Object.getPrototypeOf(db).prepare.call(db, sql).get(...a);

function addFragment(text, { status = 'active', emo = null } = {}) {
    const r = db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, status, entity_id, created_at, last_accessed_at)
        VALUES ('event', ?, ?, 0.5, 'chat', ?, ?, datetime('now', '-30 days'), datetime('now', '-30 days'))`)
        .run(entityName, sealField('memory_fragments', 'content', text), status, entityId);
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id, confidence, classified_by, relation) VALUES (?, ?, 0.9, ?, NULL)').run(id, entityId, 'test');
    if (emo) db.prepare('UPDATE memory_fragments SET emo_joy=?, emo_sadness=?, intensity=?, valence=?, emotion_conf=? WHERE id=?').run(emo.joy, emo.sadness, emo.intensity, emo.valence, 0.7, id);
    return id;
}
function addEpisode(title, text) {
    const r = db.prepare(`INSERT INTO memories (title, content, weight, layer, status, entity_id, valid_from) VALUES (?, ?, 6, 'episode', 'permanent', ?, '2026-08-01')`)
        .run(sealField('memories', 'title', title), sealField('memories', 'content', text), entityId);
    return Number(r.lastInsertRowid);
}
const frag = id => db.prepare('SELECT * FROM memory_fragments WHERE id = ?').get(id);

before(async () => {
    restore = quiet();
    require('../../database').initDatabase();
    db = require('../../database').getDb();
    sealField = require('../../services/memoryCrypto').sealField;
    // 向量庫一律 stub（呼叫時才取用，見 routes/reconsolidate-api.js）
    require('../../services/memory').chromaDBOperation = async (action, data) => { chromaCalls.push({ action, data }); return {}; };
    entityId = Number(db.prepare("INSERT INTO entity_profiles (name, category, facts, status, fragment_count, related_entities, aliases, tags) VALUES (?, 'person', 'x', 'active', 0, '[]', '[]', '[]')").run(entityName).lastInsertRowid);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { authenticated: authed }; next(); });
    app.use(require('../../routes/memory-api'));
    app.use(require('../../routes/reconsolidate-api'));
    server = http.createServer(app);
    await listenSafe(server);
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => server.close(r)); restore(); cleanupDb(dbPath); });

test('未登入 → 導向登入頁，不動任何資料', async () => {
    const id = addFragment('未登入不可動我');
    authed = false;
    for (const a of ['confirm', 'deny', 'modify']) {
        const r = await call(a, { type: 'fragment', id, content: 'x' });
        assert.equal(r.status, 302, a);
        assert.equal(r.location, '/login');
    }
    authed = true;
    assert.equal(frag(id).cited_count, 0);
    assert.equal(frag(id).status, 'active');
});

test('驗證：型別、編號、不存在、空字串、超長、前綴不符', async () => {
    const id = addFragment('驗證用');
    const cases = [
        [{ id }, 400, /type/],
        [{ type: 'star', id }, 400, /type/],
        [{ type: 'fragment' }, 400, /編號/],
        [{ type: 'fragment', id: 'abc' }, 400, /編號/],
        [{ type: 'fragment', id: -3 }, 400, /正整數/],
        [{ type: 'fragment', id: 1.5 }, 400, /正整數/],
        [{ type: 'fragment', id: 'episode_' + id }, 400, /前綴/],
        [{ type: 'episode', id: 'f' + id }, 400, /前綴/],
        [{ type: 'fragment', id: 999999 }, 404, /找不到/],
        [{ type: 'episode', id: 999999 }, 404, /找不到/],
        [{ type: 'fragment', id, entityId: 'zz' }, 400, /星座/],
        [{ type: 'fragment', id, entityId: 424242 }, 400, /不屬於/],
    ];
    for (const [body, status, re] of cases) {
        const r = await call('confirm', body);
        assert.equal(r.status, status, JSON.stringify(body));
        assert.match(r.json.error, re);
    }
    // 修改的內容驗證
    for (const [content, re] of [[undefined, /輸入/], ['', /空白/], ['   \n ', /空白/], [123, /文字/], ['字'.repeat(301), /過長/]]) {
        const r = await call('modify', { type: 'fragment', id, content });
        assert.equal(r.status, 400, String(content).slice(0, 10));
        assert.match(r.json.error, re);
    }
    // 否認帶超長內容也擋
    assert.equal((await call('deny', { type: 'fragment', id, content: '字'.repeat(301) })).status, 400);
    // 驗證失敗不留下任何痕跡
    assert.equal(frag(id).status, 'active');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM reconsolidation_log WHERE target_id = ?').get(id).c, 0);
});

test('已封存的碎片 → 409', async () => {
    const id = addFragment('封存的', { status: 'archived' });
    const r = await call('confirm', { type: 'fragment', id });
    assert.equal(r.status, 409);
});

test('確認：cited_count +1、last_accessed_at 更新；10 分鐘內重複確認不重複累加', async () => {
    const id = addFragment('一起去看了海邊的日落');
    const before = frag(id);
    assert.equal(before.cited_count, 0);
    const r = await call('confirm', { type: 'fragment', id: 'f' + id, entityId: 'e' + entityId });
    assert.equal(r.status, 200);
    assert.equal(r.json.deduped, false);
    assert.equal(r.json.state.citedCount, 1);
    assert.equal(r.json.state.lifecycle, 'active');
    assert.ok(r.json.state.conf > 0.5, '剛確認過的記憶應該變亮（decay 重置）');
    const after1 = frag(id);
    assert.equal(after1.cited_count, 1);
    assert.ok(Date.parse(after1.last_accessed_at.replace(' ', 'T') + 'Z') > Date.now() - 60000, 'last_accessed_at 應為現在');
    assert.equal(after1.read_count, before.read_count, '確認不動 read_count（那是檢索命中次數）');

    const r2 = await call('confirm', { type: 'fragment', id });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.deduped, true);
    assert.equal(frag(id).cited_count, 1);
    assert.equal(r2.json.state.citedCount, 1);

    // 10 分鐘後再確認 → 再 +1
    db.prepare("UPDATE reconsolidation_log SET created_at = datetime('now', '-11 minutes') WHERE target_id = ?").run(id);
    const r3 = await call('confirm', { type: 'fragment', id });
    assert.equal(r3.json.deduped, false);
    assert.equal(frag(id).cited_count, 2);
});

test('確認冷卻中的記憶 → 回到 active', async () => {
    const id = addFragment('冷卻中的', { status: 'cooling' });
    const r = await call('confirm', { type: 'fragment', id });
    assert.equal(r.json.state.lifecycle, 'active');
    assert.equal(frag(id).status, 'active');
});

test('否認（無內容）：碎片標為 cooling、寫 correction_log（source=starmap）', async () => {
    const id = addFragment('她說最喜歡下雨天的咖啡店');
    const r = await call('deny', { type: 'fragment', id });
    assert.equal(r.status, 200);
    assert.equal(r.json.action, 'deny');
    assert.equal(r.json.state.lifecycle, 'cooling');
    assert.ok(r.json.state.conf <= 0.3, '冷卻的星亮度上限 0.3');
    assert.equal(frag(id).status, 'cooling');
    const c = db.prepare('SELECT * FROM correction_log WHERE id = ?').get(r.json.correctionId);
    assert.equal(c.source, 'starmap');
    assert.equal(c.target_type, 'fragment');
    assert.equal(c.target_id, id);
    assert.equal(c.wrong_summary, '她說最喜歡下雨天的咖啡店');
    assert.match(c.correct_summary, /否認/);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM memory_fragments WHERE source = 'starmap'").get().c, 0, '只否認不會生出新碎片');
});

test('修改：舊記憶降溫、新碎片寫入（加密、quote 為使用者原文）、可追溯', async () => {
    const id = addFragment('她的生日是三月');
    const text = '  她的生日是四月十二日  ';
    chromaCalls = [];
    const r = await call('modify', { type: 'fragment', id, entityId: entityId, content: text });
    assert.equal(r.status, 200);
    assert.equal(r.json.action, 'modify');
    assert.equal(r.json.state.lifecycle, 'cooling');
    assert.equal(frag(id).status, 'cooling');

    const newId = Number(r.json.newStar.id.slice(1));
    assert.notEqual(newId, id);
    assert.equal(r.json.conId, 'e' + entityId);
    assert.equal(r.json.newStar.content, '她的生日是四月十二日');
    assert.equal(r.json.newStar.lifecycle, 'active');
    // 讀回（透明解密）是明文
    const nf = frag(newId);
    assert.equal(nf.content, '她的生日是四月十二日');
    assert.equal(nf.quote, text.trim(), 'quote = 使用者輸入原文');
    assert.equal(nf.source, 'starmap');
    assert.equal(nf.status, 'active');
    assert.equal(nf.entity, entityName);
    assert.equal(nf.entity_id, entityId);
    // DB 內原始儲存值：加密模式為密文、關閉模式為明文
    const rawRow = raw('SELECT content, quote FROM memory_fragments WHERE id = ?', newId);
    if (ENC_ON) {
        assert.ok(rawRow.content.startsWith('enc:') && rawRow.quote.startsWith('enc:'), '加密模式下 DB 內必須是密文');
        assert.ok(!rawRow.content.includes('四月'));
    } else {
        assert.equal(rawRow.content, '她的生日是四月十二日');
    }
    // 星座連結與計數
    const link = db.prepare('SELECT * FROM fragment_entities WHERE fragment_id = ? AND entity_id = ?').get(newId, entityId);
    assert.ok(link);
    assert.equal(link.classified_by, 'starmap');
    assert.ok(db.prepare('SELECT fragment_count c FROM entity_profiles WHERE id = ?').get(entityId).c >= 2);
    // correction_log 與可追溯關係
    const c = db.prepare('SELECT * FROM correction_log WHERE id = ?').get(r.json.correctionId);
    assert.equal(c.source, 'starmap');
    assert.equal(c.target_id, id);
    assert.equal(c.wrong_summary, '她的生日是三月');
    assert.equal(c.correct_summary, '她的生日是四月十二日');
    const lg = db.prepare("SELECT * FROM reconsolidation_log WHERE action = 'modify' AND target_id = ?").get(id);
    assert.equal(lg.new_fragment_id, newId);
    assert.equal(lg.correction_id, r.json.correctionId);
    // 向量庫有嘗試索引新碎片
    assert.equal(chromaCalls.length, 1);
    assert.equal(chromaCalls[0].data.items[0].id, `fragment_${newId}`);
    // 舊記憶還在（降溫不是刪除）
    assert.ok(frag(id));
});

test('否認 + 同時給正確內容 ＝ 修改；300 字剛好可以', async () => {
    const id = addFragment('阿翔在台北工作');
    const text = '翔'.repeat(300);
    const r = await call('deny', { type: 'fragment', id, content: text });
    assert.equal(r.status, 200);
    assert.equal(r.json.action, 'modify');
    assert.equal(frag(Number(r.json.newStar.id.slice(1))).quote, text);
});

test('修改後 fragment 進星圖 API；情緒欄位新增且舊碎片為 null', async () => {
    const emoId = addFragment('第一次去現場聽爵士', { emo: { joy: 0.8, sadness: 0.1, intensity: 0.6, valence: 0.7 } });
    const res = await fetch(base + '/api/memory/universe');
    assert.equal(res.status, 200);
    const u = await res.json();
    const con = u.constellations.find(c => c.id === 'e' + entityId);
    assert.ok(con, '星座在星圖 API 內');
    const s = con.stars.find(x => x.id === 'f' + emoId);
    assert.equal(s.emotion.joy, 0.8);
    assert.equal(s.emotion.sadness, 0.1);
    assert.equal(s.emotion.trust, 0);
    assert.equal(s.intensity, 0.6);
    assert.equal(s.valence, 0.7);
    assert.equal(s.citedCount, 0);
    const old = con.stars.find(x => x.emotion === null);
    assert.ok(old, '沒有情緒資料的舊碎片 emotion 為 null');
    assert.equal(old.intensity, null);
    assert.equal(old.valence, null);
    // 既有欄位語意不變
    for (const k of ['id', 'title', 'content', 'conf', 'mag', 'lifecycle', 'date', 'createdAt', 'lastAccessedAt', 'readCount', 'entity_id', 'relation']) assert.ok(k in s, k);
    // 修改產生的新碎片會出現在星座裡
    assert.ok(con.stars.some(x => x.content === '她的生日是四月十二日'));
});

test('敘事（episode）：確認、否認、修改', async () => {
    const ep = addEpisode('海邊的日落', '兩人在淡水看了日落');
    const c = await call('confirm', { type: 'episode', id: 'episode_' + ep, entityId });
    assert.equal(c.status, 200);
    assert.equal(c.json.state.confirmations, 1);
    assert.ok(db.prepare('SELECT last_accessed_at FROM memories WHERE id = ?').get(ep).last_accessed_at);
    assert.equal((await call('confirm', { type: 'episode', id: ep })).json.deduped, true);

    const d = await call('deny', { type: 'episode', id: ep });
    assert.equal(d.status, 200);
    assert.equal(d.json.state.lifecycle, 'cooling');
    const mem = db.prepare('SELECT layer, weight FROM memories WHERE id = ?').get(ep);
    assert.equal(mem.layer, 'cooling');
    assert.ok(mem.weight < 6, 'recordCorrection 對 memories 降權');
    const cl = db.prepare('SELECT * FROM correction_log WHERE id = ?').get(d.json.correctionId);
    assert.equal(cl.target_type, 'memory');
    assert.equal(cl.source, 'starmap');

    // 冷卻中的敘事仍可修改；新碎片帶 source_memory_id
    const m = await call('modify', { type: 'episode', id: ep, content: '兩人在漁人碼頭看了日落' });
    assert.equal(m.status, 200);
    const nf = frag(Number(m.json.newStar.id.slice(1)));
    assert.equal(nf.source_memory_id, ep);
    assert.equal(nf.content, '兩人在漁人碼頭看了日落');
    assert.equal(nf.entity_id, entityId);
    // 型別不符：碎片編號當成敘事
    const fid = addFragment('另一條');
    const bad = await call('confirm', { type: 'episode', id: 999000 + fid });
    assert.equal(bad.status, 404);
});
