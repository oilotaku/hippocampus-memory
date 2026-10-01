'use strict';
// 齒狀迴編碼強度（dentate/strength.js）：初始權重、強度換算下限、重複證據累加（走真實寫入路徑）。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('dentate_strength');
const strength = require('../../services/hippocampus/dentate/strength');

describe('initialWeight / weightFromIntensity', () => {
    test('有給就用（含 0），沒給退回 0.3', () => {
        assert.equal(strength.initialWeight({ emotional_weight: 0.8 }), 0.8);
        assert.equal(strength.initialWeight({ emotional_weight: 0 }), 0);
        assert.equal(strength.initialWeight({}), 0.3);
        assert.equal(strength.initialWeight({ emotional_weight: null }), 0.3);
    });
    test('強度換算權重：下限 0.1', () => {
        assert.equal(strength.weightFromIntensity(0), 0.1);
        assert.equal(strength.weightFromIntensity(0.05), 0.1);
        assert.equal(strength.weightFromIntensity(0.6), 0.6);
    });
    test('常數', () => {
        assert.equal(strength.CONFIDENCE_STEP, 0.05);
        assert.equal(strength.CONFIDENCE_MAX, 1.0);
        assert.equal(strength.CONFIDENCE_DEFAULT, 0.5);
    });
});

describe('重複條目走真實寫入路徑', () => {
    let restore, db, encodeEntries;
    before(() => {
        restore = quiet();
        const { initDatabase, getDb } = require('../../database');
        initDatabase();
        db = getDb();
        ({ encodeEntries } = require('../../services/hippocampus/dentate/encode'));
    });
    after(() => { restore(); cleanupDb(dbPath); });

    const quote = '我養了一隻叫小白的貓';
    const mkMsgs = (id) => [{ id, sender: 'user', content: quote, timestamp: '2026-05-01 00:00:00', message_type: 'text', is_encrypted: 0 }];
    const run = (id, entry) => encodeEntries(db, { entries: [entry] },
        { messages: mkMsgs(id), buffer: [], modeInfo: { mode: 'default', isRP: false }, dec: (m) => m.content });

    test('初始權重寫入；重複時 confidence +0.05、evidence_count +1', async () => {
        const entry = () => ({ type: 'fact', entity: '測試者', content: '養了一隻叫小白的貓', quote, emotional_weight: 0 });
        const r1 = await run(1001, entry());
        assert.equal(r1.written, 1);
        const id = r1.newFragmentIds[0];
        const before = db.prepare('SELECT emotional_weight, confidence, evidence_count FROM memory_fragments WHERE id = ?').get(id);
        assert.equal(before.emotional_weight, 0);

        const r2 = await run(1002, entry());
        assert.equal(r2.written, 0);
        assert.equal(r2.evidenceMerged, 1);
        const after2 = db.prepare('SELECT confidence, evidence_count FROM memory_fragments WHERE id = ?').get(id);
        assert.ok(Math.abs(after2.confidence - ((before.confidence ?? 0.5) + 0.05)) < 1e-9);
        assert.equal(after2.evidence_count, (before.evidence_count ?? 1) + 1);
    });

    test('confidence 上限 1.0', async () => {
        const id = db.prepare("SELECT id FROM memory_fragments WHERE entity = '測試者' LIMIT 1").get().id;
        db.prepare('UPDATE memory_fragments SET confidence = 0.98 WHERE id = ?').run(id);
        await run(1003, { type: 'fact', entity: '測試者', content: '養了一隻叫小白的貓', quote });
        assert.equal(db.prepare('SELECT confidence FROM memory_fragments WHERE id = ?').get(id).confidence, 1.0);
    });
});
