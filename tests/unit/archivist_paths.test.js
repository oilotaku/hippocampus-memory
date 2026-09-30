'use strict';
// W7 拆分安全網：檔案位置相關的行為。
// archivist 用 __dirname 組出 data/daily_status_examples.txt 的路徑；
// 拆到 services/archivist/ 子目錄後 __dirname 變了，必須仍指向專案根目錄下的 data/。
// 這裡攔截 fs.existsSync / readFileSync 來看實際讀的路徑（不真的在 repo 建檔，
// 以免和平行執行的其他測試互相干擾）。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('archivist-paths');
const ROOT = path.resolve(__dirname, '..', '..');
const EXPECTED = path.join(ROOT, 'data', 'daily_status_examples.txt');
let restore, db, a, USER;
const prompts = [];
const seen = [];

before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    require('../../services/memory').chromaDBOperation = async () => ({});
    require('../../services/llm').callLLM = async (messages) => { prompts.push(messages[0].parts[0].text); return { reply: '' }; };
    ({ USER } = require('../../services/memoryConfig'));
    a = require('../../services/archivist');
});
after(() => { restore(); cleanupDb(dbPath); });

test('generateDailyEntityStatus 讀的是 <專案根>/data/daily_status_examples.txt', async () => {
    const eid = Number(db.prepare("INSERT INTO entity_profiles (name, category, status) VALUES (?, 'person', 'active')").run(USER.name).lastInsertRowid);
    const fid = Number(db.prepare("INSERT INTO memory_fragments (type, entity, content, created_at) VALUES ('event', 'X', '去公園散步', datetime('now', '-1 days'))").run().lastInsertRowid);
    db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id) VALUES (?, ?)').run(fid, eid);

    const origExists = fs.existsSync, origRead = fs.readFileSync;
    fs.existsSync = (p, ...r) => (String(p).endsWith('daily_status_examples.txt') ? (seen.push(path.resolve(String(p))), true) : origExists(p, ...r));
    fs.readFileSync = (p, ...r) => (String(p).endsWith('daily_status_examples.txt') ? '示範標記W7：去了某處。' : origRead(p, ...r));
    try {
        await a.generateDailyEntityStatus();
    } finally {
        fs.existsSync = origExists; fs.readFileSync = origRead;
    }
    assert.deepEqual(seen, [EXPECTED]);
    assert.ok(prompts.length >= 1);
    assert.match(prompts[0], /示範標記W7：去了某處。/);
});
