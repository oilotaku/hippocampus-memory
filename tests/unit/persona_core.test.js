'use strict';
// G3 核心層：只記版本與雜湊，內容改了版本遞增、歷史可查。LLM 不涉及。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('persona-core');
let restore, db, persona;
before(() => {
    restore = quiet();
    require('../../database').initDatabase();
    db = require('../../database').getDb();
    persona = require('../../services/persona');
});
after(() => { restore(); cleanupDb(dbPath); });

test('首次記錄 → 版本 1；內容不變 → 不遞增', () => {
    const a = persona.recordCoreVersion({ text: '你是一個溫柔的夥伴。{{CORE_INSIGHT}}' });
    assert.deepEqual([a.version, a.changed], [1, true]);
    const b = persona.recordCoreVersion({ text: '你是一個溫柔的夥伴。{{CORE_INSIGHT}}' });
    assert.deepEqual([b.version, b.changed], [1, false]);
    assert.equal(b.hash, a.hash);
});

test('改 core prompt 內容 → 版本遞增，歷史可查（新到舊）', () => {
    const c = persona.recordCoreVersion({ text: '你是一個溫柔而直率的夥伴。{{CORE_INSIGHT}}' });
    assert.deepEqual([c.version, c.changed], [2, true]);
    const hist = persona.getCoreHistory();
    assert.deepEqual(hist.map(h => h.version), [2, 1]);
    assert.notEqual(hist[0].content_hash, hist[1].content_hash);
    assert.equal(hist[0].has_anchor, false);
    const events = persona.listPersonaEvents({ kind: 'core_version' });
    assert.equal(events.length, 2);
    assert.equal(events[0].detail.version, 2);
    assert.equal(events[0].detail.previous, 1);
});

test('改回舊內容也算新版本（雜湊只跟「最新一版」比，歷史不被覆蓋）', () => {
    const d = persona.recordCoreVersion({ text: '你是一個溫柔的夥伴。{{CORE_INSIGHT}}' });
    assert.deepEqual([d.version, d.changed], [3, true]);
    assert.equal(persona.getCoreHistory().length, 3);
});

test('空內容或缺檔不記錄', () => {
    assert.equal(persona.recordCoreVersion({ text: '   ' }), null);
    assert.equal(persona.getCoreHistory().length, 3);
});

test('錨點：存取往返，且掛在指定版本上', () => {
    persona.saveAnchor(3, [{ q: '問', a: '答' }], 'core_only');
    assert.deepEqual(persona.getAnchor(3), [{ q: '問', a: '答' }]);
    assert.equal(persona.getAnchor(2), null);
    assert.equal(persona.getCoreHistory()[0].has_anchor, true);
});
