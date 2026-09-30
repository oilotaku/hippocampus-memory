'use strict';
// G5 搬移安全網：模組依海馬迴架構搬到 services/hippocampus/ 之後，
//   1) 每個被搬動模組的對外介面（module.exports 鍵名、順序、typeof）與搬移前相同；
//   2) 舊路徑（轉接檔）與新路徑取得的是同一個模組實例（可變狀態只有一份）。
// 介面快照 fixtures/g5_module_surface.json 在搬移前由實際 require 舊路徑產生（set G5_RECORD=1&& node --test ...），
// 之後不要重錄——介面真的要變時另開工作項。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('g5-surface');
let restore;
before(() => { restore = quiet(); });
after(() => { restore(); cleanupDb(dbPath); });

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'g5_module_surface.json');
const surface = (m) => Object.keys(m).map(k => [k, typeof m[k]]);
const load = (p) => require(path.join(ROOT, p));

// 舊路徑 → 新路徑（已搬的群）
const MOVED = [

];

if (process.env.G5_RECORD === '1') {
    test('錄製 G5 介面快照', () => {
        const snap = {};
        for (const p of [
        "services/archivist/classify.js",
        "services/archivist/constants.js",
        "services/archivist/dailyStatus.js",
        "services/archivist/emergent.js",
        "services/archivist/entityDiscovery.js",
        "services/archivist/entityLink.js",
        "services/archivist/entityOverview.js",
        "services/archivist/episode.js",
        "services/archivist/guards.js",
        "services/archivist/index.js",
        "services/archivist/insights.js",
        "services/archivist/intuitionStopwords.js",
        "services/archivist/patterns.js",
        "services/archivist/registerTools.js",
        "services/archivist/relations.js",
        "services/archivist/rematch.js",
        "services/archivist/runtime.js",
        "services/archivist/seeds.js",
        "services/archivist/shared.js",
        "services/archivist/tick.js",
        "services/chatImport.js",
        "services/chatParser.js",
        "services/cognitiveModel/constants.js",
        "services/cognitiveModel/context.js",
        "services/cognitiveModel/currentState.js",
        "services/cognitiveModel/cycle.js",
        "services/cognitiveModel/decay.js",
        "services/cognitiveModel/entries.js",
        "services/cognitiveModel/evidence.js",
        "services/cognitiveModel/helpers.js",
        "services/cognitiveModel/index.js",
        "services/cognitiveModel/migration.js",
        "services/cognitiveModel/observation.js",
        "services/cognitiveModel/overlap.js",
        "services/cognitiveModel/profile.js",
        "services/cognitiveModel/traits.js",
        "services/companionPersona.js",
        "services/consolidator.js",
        "services/correction.js",
        "services/emotion/config.js",
        "services/emotion/fading.js",
        "services/emotion/index.js",
        "services/emotion/ou.js",
        "services/emotion/prompt.js",
        "services/emotion/queries.js",
        "services/emotion/scoring.js",
        "services/emotion/store.js",
        "services/emotion/time.js",
        "services/entityProfile.js",
        "services/entityResolver.js",
        "services/intuition.js",
        "services/librarian.js",
        "services/lifecycle.js",
        "services/memory.js",
        "services/memoryBudget.js",
        "services/persona/config.js",
        "services/persona/core.js",
        "services/persona/drift.js",
        "services/persona/events.js",
        "services/persona/index.js",
        "services/persona/judgment.js",
        "services/persona/promptContext.js",
        "services/persona/relationship.js",
        "services/persona/similarity.js",
        "services/recallGate.js",
        "services/recallPipeline.js",
        "services/rhythmConfig.js",
        "services/scribe.js",
        "services/scribeQuality.js",
        "services/summary.js",
        "services/userProfile.js",
        "services/workingMemory.js"
]) snap[p] = surface(load(p));
        fs.writeFileSync(FIXTURE, JSON.stringify(snap, null, 1) + '\n');
    });
} else {
    const SNAP = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

    test('被搬動模組的匯出介面與搬移前相同（舊路徑）', () => {
        for (const [p, s] of Object.entries(SNAP)) assert.deepEqual(surface(load(p)), s, p);
    });

    test('新路徑的匯出介面與搬移前相同', () => {
        for (const [oldP, newP] of MOVED) assert.deepEqual(surface(load(newP)), SNAP[oldP], newP);
    });

    test('舊路徑與新路徑取得同一個模組實例', () => {
        for (const [oldP, newP] of MOVED) assert.equal(load(oldP), load(newP), `${oldP} !== ${newP}`);
        // 既有的目錄入口轉接檔也一樣
        assert.equal(load('services/archivist.js'), load('services/archivist/index.js'));
        assert.equal(load('services/cognitiveModel.js'), load('services/cognitiveModel/index.js'));
    });
}
