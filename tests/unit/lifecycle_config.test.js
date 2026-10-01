'use strict';
// 生命週期門檻可由 memory_config.json 的 lifecycle.* 設定；無設定時行為與原本寫死的常數相同
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('lifecycle_config');
let restore, db, lc, cfg, sqlDaysAgo;

before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    require('../../services/memory').chromaDBOperation = async () => ({});
    ({ sqlDaysAgo } = require('../../utils/time'));
    cfg = require('../../services/hippocampus/homeostasis/lifecycleConfig');
    lc = require('../../services/lifecycle');
});
after(() => { cfg.setLifecycleConfigOverride(null); restore(); cleanupDb(dbPath); });
beforeEach(() => {
    cfg.setLifecycleConfigOverride(null);
    db.exec('DELETE FROM memory_fragments; DELETE FROM memories;');
});

function frag({ status = 'active', createdDaysAgo = 0, lifecycleDaysAgo = null }) {
    return Number(db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, status, read_count, cited_count, created_at, lifecycle_updated_at)
        VALUES ('event','X','c',0.5,?,0,0,?,?)`).run(status, sqlDaysAgo(createdDaysAgo),
        lifecycleDaysAgo == null ? null : sqlDaysAgo(lifecycleDaysAgo)).lastInsertRowid);
}
const statusOf = (id) => db.prepare('SELECT status FROM memory_fragments WHERE id=?').get(id).status;

describe('lifecycleConfig：預設與驗證', () => {
    test('預設值等於原本寫死的常數，且已凍結', () => {
        assert.deepEqual({ ...cfg.LIFECYCLE_DEFAULTS }, {
            fragment_cooling_days: 14, fragment_frozen_days: 30, fragment_tombstone_days: 90,
            episode_mature_months: 6, episode_archive_months: 12, min_frags_for_entity: 2, correction_days_lookback: 7,
        });
        assert.ok(Object.isFrozen(cfg.LIFECYCLE_DEFAULTS));
        assert.deepEqual(cfg.getLifecycleConfig(), { ...cfg.LIFECYCLE_DEFAULTS });
    });

    test('合法值生效，未給的鍵用預設', () => {
        cfg.setLifecycleConfigOverride({ fragment_cooling_days: 3, episode_archive_months: 24 });
        const c = cfg.getLifecycleConfig();
        assert.equal(c.fragment_cooling_days, 3);
        assert.equal(c.episode_archive_months, 24);
        assert.equal(c.fragment_frozen_days, 30);
    });

    test('非法值（0、負數、小數、字串、超出上限、null）回退預設', () => {
        cfg.setLifecycleConfigOverride({
            fragment_cooling_days: 0, fragment_frozen_days: -5, fragment_tombstone_days: 1.5,
            episode_mature_months: '6', episode_archive_months: 99999, min_frags_for_entity: null, correction_days_lookback: NaN,
        });
        assert.deepEqual(cfg.getLifecycleConfig(), { ...cfg.LIFECYCLE_DEFAULTS });
    });
});

describe('lifecycle.js 讀取覆蓋值', () => {
    test('預設：10 天的碎片不冷卻', async () => {
        const id = frag({ createdDaysAgo: 10 });
        await lc.runFragmentGC();
        assert.equal(statusOf(id), 'active');
    });

    test('fragment_cooling_days=5：10 天的碎片 active → cooling', async () => {
        cfg.setLifecycleConfigOverride({ fragment_cooling_days: 5 });
        const id = frag({ createdDaysAgo: 10 });
        await lc.runFragmentGC();
        assert.equal(statusOf(id), 'cooling');
    });

    test('fragment_frozen_days=10：冷卻 11 天 → frozen（預設 30 天不會）', async () => {
        const a = frag({ status: 'cooling', createdDaysAgo: 40, lifecycleDaysAgo: 11 });
        await lc.runFragmentGC();
        assert.equal(statusOf(a), 'cooling');
        cfg.setLifecycleConfigOverride({ fragment_frozen_days: 10 });
        await lc.runFragmentGC();
        assert.equal(statusOf(a), 'frozen');
    });

    test('episode_mature_months=1：2 個月未動的 episode → mature', async () => {
        const id = Number(db.prepare(`INSERT INTO memories (title, content, tags, weight, status, consolidation_type, created_at, updated_at)
            VALUES ('t','c','[]',5,'permanent','standard',?,?)`).run(sqlDaysAgo(65), sqlDaysAgo(65)).lastInsertRowid);
        await lc.runEpisodeDecay();
        assert.equal(db.prepare('SELECT status FROM memories WHERE id=?').get(id).status, 'permanent');
        cfg.setLifecycleConfigOverride({ episode_mature_months: 1 });
        await lc.runEpisodeDecay();
        assert.equal(db.prepare('SELECT status FROM memories WHERE id=?').get(id).status, 'mature');
    });
});
