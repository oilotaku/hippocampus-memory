'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('lifecycle');
let restore, db, lc, sqlDaysAgo, sqlNow;
const chromaCalls = [];
let chromaFail = false;

before(() => {
    restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    db = getDb();
    // lifecycle.js 在載入時解構 chromaDBOperation，所以必須在 require 之前先換掉
    require('../../services/memory').chromaDBOperation = async (op, payload) => { chromaCalls.push({ op, payload }); if (chromaFail) throw new Error('boom'); return {}; };
    ({ sqlDaysAgo, sqlNow } = require('../../utils/time'));
    lc = require('../../services/lifecycle');
});
after(() => { restore(); cleanupDb(dbPath); });
beforeEach(() => {
    chromaCalls.length = 0;
    db.exec('DELETE FROM memory_fragments; DELETE FROM memories; DELETE FROM correction_log;');
});

function frag({ status = 'active', readCount = 0, createdDaysAgo = 0, lifecycleDaysAgo = null, chromaId = null, content = 'c', ew = 0.5 }) {
    return Number(db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, status, read_count, created_at, lifecycle_updated_at, chroma_id)
        VALUES ('event','X',?,?,?,?,?,?,?)`).run(content, ew, status, readCount, sqlDaysAgo(createdDaysAgo),
        lifecycleDaysAgo == null ? null : sqlDaysAgo(lifecycleDaysAgo), chromaId).lastInsertRowid);
}
const getF = (id) => db.prepare('SELECT * FROM memory_fragments WHERE id=?').get(id);

function mem({ status = 'permanent', weight = 5, type = 'standard', updatedDaysAgo = 0, accessedDaysAgo = null, createdDaysAgo = 0 }) {
    return Number(db.prepare(`INSERT INTO memories (title, content, tags, weight, status, consolidation_type, created_at, updated_at, last_accessed_at)
        VALUES ('t','c','[]',?,?,?,?,?,?)`).run(weight, status, type, sqlDaysAgo(createdDaysAgo), sqlDaysAgo(updatedDaysAgo),
        accessedDaysAgo == null ? null : sqlDaysAgo(accessedDaysAgo)).lastInsertRowid);
}
const getM = (id) => db.prepare('SELECT * FROM memories WHERE id=?').get(id);

describe('runFragmentGC：碎片生命週期', () => {
    test('冷卻：active 且 read_count=0 且建立超過 14 天 → cooling，並寫 lifecycle_updated_at', async () => {
        const old = frag({ createdDaysAgo: 15 });
        const young = frag({ createdDaysAgo: 13 });
        const read = frag({ createdDaysAgo: 100, readCount: 1 });
        const stats = await lc.runFragmentGC();
        assert.equal(getF(old).status, 'cooling');
        assert.ok(getF(old).lifecycle_updated_at >= sqlDaysAgo(0.01).slice(0, 10));
        assert.equal(getF(young).status, 'active');
        assert.equal(getF(read).status, 'active');
        assert.deepEqual(stats, { cooled: 1, resurrected: 0, frozen: 0, tombstoned: 0 });
    });

    test('復活：cooling 但 read_count>0 → 回到 active', async () => {
        const id = frag({ status: 'cooling', readCount: 2, createdDaysAgo: 20, lifecycleDaysAgo: 5 });
        const stats = await lc.runFragmentGC();
        assert.equal(getF(id).status, 'active');
        assert.equal(stats.resurrected, 1);
    });

    test('冷卻中且 read_count=0 → 維持 cooling（未達凍結門檻）', async () => {
        const id = frag({ status: 'cooling', createdDaysAgo: 40, lifecycleDaysAgo: 29 });
        await lc.runFragmentGC();
        assert.equal(getF(id).status, 'cooling');
    });

    test('凍結：cooling 且 lifecycle_updated_at 超過 30 天 → frozen，並從 Chroma 刪向量', async () => {
        const id = frag({ status: 'cooling', createdDaysAgo: 60, lifecycleDaysAgo: 31, chromaId: 'chroma-abc' });
        const stats = await lc.runFragmentGC();
        assert.equal(getF(id).status, 'frozen');
        assert.equal(stats.frozen, 1);
        assert.deepEqual(chromaCalls, [{ op: 'delete', payload: { id: 'chroma-abc' } }]);
    });

    test('凍結：chroma_id 為空或 dup_of_ 開頭不呼叫 Chroma；lifecycle_updated_at 為 NULL 不會凍結', async () => {
        const a = frag({ status: 'cooling', lifecycleDaysAgo: 31, chromaId: null });
        const b = frag({ status: 'cooling', lifecycleDaysAgo: 31, chromaId: 'dup_of_12' });
        const c = frag({ status: 'cooling', lifecycleDaysAgo: null, createdDaysAgo: 200 });
        await lc.runFragmentGC();
        assert.equal(getF(a).status, 'frozen');
        assert.equal(getF(b).status, 'frozen');
        assert.equal(getF(c).status, 'cooling');
        assert.equal(chromaCalls.length, 0);
    });

    test('凍結：Chroma 刪除失敗（rejection）不影響狀態轉換', async () => {
        chromaFail = true;
        try {
            const id = frag({ status: 'cooling', lifecycleDaysAgo: 31, chromaId: 'x1' });
            await lc.runFragmentGC();
            assert.equal(getF(id).status, 'frozen');
            assert.equal(chromaCalls.length, 1);
        } finally {
            chromaFail = false;
        }
    });

    test('墓碑：frozen 且超過 90 天 → tombstone，內容變 [expired]；89 天不動', async () => {
        const old = frag({ status: 'frozen', content: '秘密內容', lifecycleDaysAgo: 91 });
        const young = frag({ status: 'frozen', content: '還在', lifecycleDaysAgo: 89 });
        const stats = await lc.runFragmentGC();
        assert.equal(getF(old).status, 'tombstone');
        assert.equal(getF(old).content, '[expired]');
        assert.equal(getF(young).status, 'frozen');
        assert.equal(getF(young).content, '還在');
        assert.equal(stats.tombstoned, 1);
    });

    test('一次 GC 最多隻推進一級（剛冷卻的不會同輪凍結，剛凍結的不會同輪墓碑）', async () => {
        const a = frag({ createdDaysAgo: 500 });                                     // active → cooling
        const b = frag({ status: 'cooling', lifecycleDaysAgo: 400 });                 // cooling → frozen
        const c = frag({ status: 'frozen', lifecycleDaysAgo: 400 });                  // frozen → tombstone
        await lc.runFragmentGC();
        assert.equal(getF(a).status, 'cooling');
        assert.equal(getF(b).status, 'frozen');
        assert.equal(getF(c).status, 'tombstone');
    });

    test('tombstone / consolidated 等其他狀態不被觸碰', async () => {
        const t = frag({ status: 'tombstone', content: '[expired]', lifecycleDaysAgo: 999, createdDaysAgo: 999 });
        const k = frag({ status: 'consolidated', createdDaysAgo: 999 });
        await lc.runFragmentGC();
        assert.equal(getF(t).status, 'tombstone');
        assert.equal(getF(k).status, 'consolidated');
    });
});

describe('runEpisodeDecay：episode 衰減', () => {
    test('標準 episode：>180 天未存取且未更新 → mature，weight 減半（浮點除法，下限 1）：5 → 2.5', async () => {
        const a = mem({ weight: 5, updatedDaysAgo: 181 });
        const b = mem({ weight: 1, updatedDaysAgo: 181 });
        const stats = await lc.runEpisodeDecay();
        assert.equal(getM(a).status, 'mature');
        assert.equal(getM(a).weight, 2.5);
        assert.equal(getM(b).weight, 1);
        assert.equal(stats.matured, 2);
    });

    test('近期存取或近期更新的 episode 不衰減', async () => {
        const accessed = mem({ updatedDaysAgo: 300, accessedDaysAgo: 10 });
        const updated = mem({ updatedDaysAgo: 100 });
        await lc.runEpisodeDecay();
        assert.equal(getM(accessed).status, 'permanent');
        assert.equal(getM(updated).status, 'permanent');
    });

    test('flash episode 門檻加倍：181 天不動、361 天才 mature', async () => {
        const a = mem({ type: 'flash', updatedDaysAgo: 181 });
        const b = mem({ type: 'flash', updatedDaysAgo: 361 });
        await lc.runEpisodeDecay();
        assert.equal(getM(a).status, 'permanent');
        assert.equal(getM(b).status, 'mature');
    });

    test('mature → archived：標準 >360 天、flash >720 天（依 updated_at）', async () => {
        const a = mem({ status: 'mature', updatedDaysAgo: 361 });
        const b = mem({ status: 'mature', updatedDaysAgo: 359 });
        const c = mem({ status: 'mature', type: 'flash', updatedDaysAgo: 721 });
        const d = mem({ status: 'mature', type: 'flash', updatedDaysAgo: 719 });
        const stats = await lc.runEpisodeDecay();
        assert.equal(getM(a).status, 'archived');
        assert.equal(getM(b).status, 'mature');
        assert.equal(getM(c).status, 'archived');
        assert.equal(getM(d).status, 'mature');
        assert.equal(stats.archived, 2);
    });

    test('同一輪剛 mature 的不會馬上 archived（updated_at 被更新為現在）', async () => {
        const a = mem({ updatedDaysAgo: 1000 });
        await lc.runEpisodeDecay();
        assert.equal(getM(a).status, 'mature');
    });

    test('ongoing / completed 狀態不參與衰減', async () => {
        const a = mem({ status: 'ongoing', updatedDaysAgo: 1000 });
        const b = mem({ status: 'completed', updatedDaysAgo: 1000 });
        await lc.runEpisodeDecay();
        assert.equal(getM(a).status, 'ongoing');
        assert.equal(getM(b).status, 'completed');
    });
});

describe('recalculateMemoryWeights：每日權重重算（範圍 2–8）', () => {
    // 這裡直接用 SQLite 的 datetime('now', ...) 造時間，與函式內 SQL 同一時鐘
    function memSql({ status = 'permanent', createdDays, accessedDays = null }) {
        return Number(db.prepare(`INSERT INTO memories (title, content, tags, weight, status, created_at, last_accessed_at)
            VALUES ('t','c','[]',5,?, datetime('now', ?), ${accessedDays == null ? 'NULL' : "datetime('now', ?)"})`)
            .run(...[status, `-${createdDays} days`, ...(accessedDays == null ? [] : [`-${accessedDays} days`])]).lastInsertRowid);
    }
    const w = (id) => getM(id).weight;

    test('新建且從未存取 → 5', () => {
        const id = memSql({ createdDays: 0 });
        lc.recalculateMemoryWeights();
        assert.equal(w(id), 5);
    });
    test('7 天記憶體取 +2、30 天記憶體取 +1', () => {
        const a = memSql({ createdDays: 0, accessedDays: 3 });
        const b = memSql({ createdDays: 0, accessedDays: 20 });
        const c = memSql({ createdDays: 0, accessedDays: 40 });
        lc.recalculateMemoryWeights();
        assert.equal(w(a), 7);
        assert.equal(w(b), 6);
        assert.equal(w(c), 5);
    });
    test('每滿 30 天 -0.5，結果 CAST 成整數（截斷）', () => {
        const a = memSql({ createdDays: 60 });                    // 5 - 1.0 = 4
        const b = memSql({ createdDays: 45 });                    // 5 - 0.5 = 4.5 → 4
        const c = memSql({ createdDays: 35, accessedDays: 3 });   // 5 + 2 - 0.5 = 6.5 → 6
        lc.recalculateMemoryWeights();
        assert.equal(w(a), 4);
        assert.equal(w(b), 4);
        assert.equal(w(c), 6);
    });
    test('下限 2：很舊的 episode 不會低於 2', () => {
        const id = memSql({ createdDays: 3000 });
        lc.recalculateMemoryWeights();
        assert.equal(w(id), 2);
    });
    test('上限 8 是保護性 clamp：實際輸入最高只到 7（5+2），公式不改', () => {
        const id = memSql({ createdDays: 0, accessedDays: 1 });
        lc.recalculateMemoryWeights();
        assert.equal(w(id), 7);
    });
    test('只處理 permanent / ongoing；mature / archived 不動（保留減半後的權重）', () => {
        const a = memSql({ status: 'ongoing', createdDays: 0, accessedDays: 1 });
        const m = mem({ status: 'mature', weight: 3, createdDaysAgo: 0 });
        const ar = mem({ status: 'archived', weight: 1 });
        const r = lc.recalculateMemoryWeights();
        assert.equal(w(a), 7);
        assert.equal(getM(m).weight, 3);
        assert.equal(getM(ar).weight, 1);
        assert.deepEqual(r, { memoriesUpdated: 1 });
    });
});

describe('runCorrectionFeedback（每週級聯降權）', () => {
    test('被刪 memory 的 source_msg_ids 指到的 active 碎片 ew 減半（下限 0.1），log 標 applied', async () => {
        const f1 = frag({ ew: 0.8 });
        const f2 = frag({ ew: 0.15 });
        const f3 = frag({ ew: 0.8, status: 'cooling' });
        const m = Number(db.prepare(`INSERT INTO memories (title, content, tags, source_msg_ids) VALUES ('t','c','[]', ?)`).run(JSON.stringify([f1, f2, f3])).lastInsertRowid);
        const cid = Number(db.prepare(`INSERT INTO correction_log (target_type, target_id, wrong_summary, correct_summary, status) VALUES ('memory', ?, 'w', 'c', 'active')`).run(m).lastInsertRowid);
        const stats = await lc.runCorrectionFeedback();
        assert.equal(getF(f1).emotional_weight, 0.4);
        assert.equal(getF(f2).emotional_weight, 0.1);
        assert.equal(getF(f3).emotional_weight, 0.8);
        assert.deepEqual(stats, { processed: 1, cascaded: 2 });
        assert.equal(db.prepare('SELECT status FROM correction_log WHERE id=?').get(cid).status, 'applied');
    });

    test('非 memory 型別的紀錄只被標記 applied，不降權', async () => {
        const f = frag({ ew: 0.8 });
        db.prepare(`INSERT INTO correction_log (target_type, target_id, wrong_summary, correct_summary, status) VALUES ('hallucination', ?, 'w','c','active')`).run(f);
        const stats = await lc.runCorrectionFeedback();
        assert.equal(getF(f).emotional_weight, 0.8);
        assert.deepEqual(stats, { processed: 1, cascaded: 0 });
    });
});

describe('runLifecycleMaintenance：每日主流程', () => {
    test('依序執行 GC、episode 衰減、權重重算並回傳各項統計', async () => {
        const f = frag({ createdDaysAgo: 30 });
        const m = mem({ updatedDaysAgo: 200 });
        const r = await lc.runLifecycleMaintenance();
        assert.equal(getF(f).status, 'cooling');
        assert.equal(getM(m).status, 'mature');
        assert.equal(r.gcStats.cooled, 1);
        assert.equal(r.decayStats.matured, 1);
        assert.ok('memoriesUpdated' in r.weightStats);
        // 實體提取與糾正回饋只在週日跑
        if (new Date().getDay() === 0) assert.ok(r.entityStats && r.correctionStats);
        else assert.equal(r.entityStats, null), assert.equal(r.correctionStats, null);
    });
});
