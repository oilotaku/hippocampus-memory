'use strict';
// W7 拆分安全網：services/archivist.js 與 services/cognitiveModel.js 的對外介面快照。
// 拆成目錄模組後，module.exports 的鍵名（含順序）與每個值的 typeof 必須完全相同。
// 快照在拆分前由實際 require 產生，之後不要手改——介面真的要變時另開工作項。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('module-surface');
let restore;
before(() => { restore = quiet(); });
after(() => { restore(); cleanupDb(dbPath); });

const ARCHIVIST = [
        ['ensureTagEntities', 'function'],
        ['linkTaggedFragment', 'function'],
        ['linkTaggedFragments', 'function'],
        ['isTimePhraseName', 'function'],
        ['isPeriodPhraseName', 'function'],
        ['isNoChangeSentinel', 'function'],
        ['buildEmergentJudgePrompt', 'function'],
        ['screenEmergentVerdict', 'function'],
        ['_mentionWeight', 'function'],
        ['_aliasAmbiguous', 'function'],
        ['_entityMentionOwners', 'function'],
        ['reviewEntityRelations', 'function'],
        ['discoverTagRelations', 'function'],
        ['start', 'function'],
        ['stop', 'function'],
        ['getStatus', 'function'],
        ['setCompanionActive', 'function'],
        ['isCompanionActive', 'function'],
        ['archivistEvents', 'object'],
        ['registerTool', 'function'],
        ['getTool', 'function'],
        ['listTools', 'function'],
        ['classifyFragments', 'function'],
        ['classifyFragmentBatch', 'function'],
        ['rematchFragmentsForSeeds', 'function'],
        ['semanticRematchForSeeds', 'function'],
        ['mergeDuplicateSeeds', 'function'],
        ['executeEntityMerge', 'function'],
        ['discoverRelatedEntities', 'function'],
        ['detectEmergentPlacesAndEvents', 'function'],
        ['refreshIntuitionStopwords', 'function'],
        ['resetTickBudget', 'function'],
        ['graduateSeedsAndPrune', 'function'],
        ['maintainPatterns', 'function'],
        ['clusterObservations', 'function'],
        ['spotCheckClassifications', 'function'],
        ['reviewConstellationAfterClassification', 'function'],
        ['discoverEntityRelationships', 'function'],
        ['extractFragmentInsights', 'function'],
        ['regenerateEntityOverviews', 'function'],
        ['consolidateCategory', 'function'],
        ['scanContentForNewEntities', 'function'],
        ['generateDailyEntityStatus', 'function'],
];

const COGNITIVE_MODEL = [
        ['createEntry', 'function'],
        ['updateEntry', 'function'],
        ['manageCurrentState', 'function'],
        ['resolveEntry', 'function'],
        ['abandonEntry', 'function'],
        ['supersedeEntry', 'function'],
        ['correctEntry', 'function'],
        ['addEvidence', 'function'],
        ['matchEvidenceFromFragments', 'function'],
        ['harvestFacts', 'function'],
        ['bridgeStarMapToModel', 'function'],
        ['processModelDecay', 'function'],
        ['validateHypotheses', 'function'],
        ['detectNewTraits', 'function'],
        ['reviewFlaggedTraits', 'function'],
        ['resolveExpiredStates', 'function'],
        ['reviewStableTraits', 'function'],
        ['seedAnchorOrphanEntries', 'function'],
        ['anchorEntriesToFragments', 'function'],
        ['integrateProfileTraits', 'function'],
        ['detectModelOverlaps', 'function'],
        ['mergeModelEntries', 'function'],
        ['crossRefStateWithEntities', 'function'],
        ['synthesizeCoreInsight', 'function'],
        ['getModelContext', 'function'],
        ['getWhisperRelevant', 'function'],
        ['seedFromExisting', 'function'],
        ['backfillModelEvidence', 'function'],
        ['runUserModelCycle', 'function'],
        ['readUserRawMessages', 'function'],
        ['MIN_GAP_USER_MODEL', 'number'],
];

const surface = (m) => Object.keys(m).map(k => [k, typeof m[k]]);

test('services/archivist 的匯出介面與拆分前相同', () => {
    assert.deepEqual(surface(require('../../services/archivist')), ARCHIVIST);
});

test('services/cognitiveModel 的匯出介面與拆分前相同', () => {
    assert.deepEqual(surface(require('../../services/cognitiveModel')), COGNITIVE_MODEL);
});

test('archivist 與 cognitiveModel 各自只有一份模組實例（入口檔轉出的是同一個物件）', () => {
    const a1 = require('../../services/archivist');
    assert.equal(require('../../services/archivist.js'), a1);
    const c1 = require('../../services/cognitiveModel');
    assert.equal(require('../../services/cognitiveModel.js'), c1);
});
