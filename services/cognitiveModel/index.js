// =================================================================
// services/cognitiveModel/index.js — 對外介面（原 services/cognitiveModel.js 的 module.exports，逐字保留）
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
//
// 分檔（依相依順序，下層在前；子模組之間無循環 require）：
//   constants.js            LLM 設定 id、假設升級／放棄、狀態半衰期／自動結案、特質矛盾門檻、深循環冷卻
//   helpers.js              共用小工具：認知模型 system prompt、訊息純文字抽取、安全 JSON 解析
//   entries.js              CRUD：建立、更新、結案、放棄、取代、更正
//   evidence.js             證據：加證據與信心度加減、碎片比對、事實收割、碎片錨定與回填、星圖橋接
//   decay.js                衰減與到期：processModelDecay、resolveExpiredStates
//   currentState.js         current_state 管理：TTL 表、到期時間計算、相似狀態比對與建立／更新
//   traits.js               假設驗證、新特質偵測、旗標特質複審、穩定特質複審
//   context.js              上下文注入：首次觀察時間、getModelContext、whisper 相關項
//   migration.js            從既有資料播種（seedFromExisting）
//   observation.js          讀使用者原始訊息的深度觀察（readUserRawMessages）
//   profile.js              個人檔案特質整合：分層、衝突檢查、決策紀錄
//   overlap.js              狀態與實體交叉比對、條目去重合併、核心洞察綜合
//   cycle.js                深循環：runUserModelCycle
//   index.js                對外介面（原 services/cognitiveModel.js 的 module.exports，逐字保留）
//
// 本模組沒有模組層級的可變狀態（沒有頂層 let；常數表 STATE_TTL_MAP／PROFILE_TIERS 只讀）。
// =================================================================

// 保持原檔的外部模組載入順序（原檔頂端依此順序 require）
require('../../database');
require('../llm');
require('../worldContext');
require('../nameResolver');
require('../../encryption');
require('../companionPersona');
require('../../utils/time');
const { MIN_GAP_USER_MODEL } = require('./constants');
const { createEntry, updateEntry, resolveEntry, abandonEntry, supersedeEntry, correctEntry } = require('./entries');
const { addEvidence, matchEvidenceFromFragments, anchorEntriesToFragments, seedAnchorOrphanEntries, harvestFacts, backfillModelEvidence, bridgeStarMapToModel } = require('./evidence');
const { processModelDecay, resolveExpiredStates } = require('./decay');
const { manageCurrentState } = require('./currentState');
const { validateHypotheses, detectNewTraits, reviewFlaggedTraits, reviewStableTraits } = require('./traits');
const { getModelContext, getWhisperRelevant } = require('./context');
const { seedFromExisting } = require('./migration');
const { readUserRawMessages } = require('./observation');
const { integrateProfileTraits } = require('./profile');
const { crossRefStateWithEntities, mergeModelEntries, detectModelOverlaps, synthesizeCoreInsight } = require('./overlap');
const { runUserModelCycle } = require('./cycle');


// ══════════════════════════════════════════════════════════════

module.exports = {
    createEntry, updateEntry, manageCurrentState,
    // CRUD
    createEntry,
    updateEntry,
    resolveEntry,
    abandonEntry,
    supersedeEntry,
    correctEntry,

    // Evidence
    addEvidence,
    matchEvidenceFromFragments,
    harvestFacts,  // v4.8 退役，保留兼容
    bridgeStarMapToModel,

    // Decay & validation
    processModelDecay,
    validateHypotheses,
    detectNewTraits,
    reviewFlaggedTraits,
    resolveExpiredStates,
    reviewStableTraits,
    seedAnchorOrphanEntries,
    anchorEntriesToFragments,

    // Profile integration (v5.10)
    integrateProfileTraits,

    // Dedup (v4.9)
    detectModelOverlaps,
    mergeModelEntries,

    // Cross-reference (v5.0)
    crossRefStateWithEntities,

    // Core insight (v5.0)
    synthesizeCoreInsight,

    // Context
    getModelContext,
    getWhisperRelevant,

    // Migration
    seedFromExisting,

    // Evidence
    backfillModelEvidence,

    // Deep cycle
    runUserModelCycle,
    readUserRawMessages,
    MIN_GAP_USER_MODEL,
};
