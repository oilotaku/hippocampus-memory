// =================================================================
// User Model — 四层认知模型
//
// 维护 AI 对用户的内部认知，四层：
//   immutable_fact   — 不变事实，永不衰减，仅明确纠正修改
//   stable_trait     — 稳定特质，证据积累精细化，矛盾≥3降级重审
//   current_state    — 当前状态，指数衰减(7天半衰期)，14天无证据自动 resolved
//   active_hypothesis — 活跃假设，3次确认→升级为 trait，14天无证据→abandoned
//
// 职责：CRUD、证据管理、衰减处理、假设验证、新特质检测、上下文注入
// =================================================================

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { WORLD_CONTEXT } = require('./worldContext');
const { fillPrompt, USER, AI } = require('./nameResolver');
const { encryption } = require('../encryption');
const { getCompanionPersonaBase } = require('./companionPersona');
const { sqlNow, sqlTimeAhead, DAY_MS } = require('../utils/time');
// ── W7 拆分進行中：以下名稱已搬到 services/cognitiveModel/ ──
const { MIN_GAP_USER_MODEL } = require('./cognitiveModel/constants');
const { createEntry, updateEntry, resolveEntry, abandonEntry, supersedeEntry, correctEntry } = require('./cognitiveModel/entries');
const { addEvidence, matchEvidenceFromFragments, anchorEntriesToFragments, seedAnchorOrphanEntries, harvestFacts, backfillModelEvidence, bridgeStarMapToModel } = require('./cognitiveModel/evidence');
const { processModelDecay, resolveExpiredStates } = require('./cognitiveModel/decay');
const { manageCurrentState } = require('./cognitiveModel/currentState');
const { validateHypotheses, detectNewTraits, reviewFlaggedTraits, reviewStableTraits } = require('./cognitiveModel/traits');
const { getModelContext, getWhisperRelevant } = require('./cognitiveModel/context');
const { seedFromExisting } = require('./cognitiveModel/migration');
const { readUserRawMessages } = require('./cognitiveModel/observation');
const { integrateProfileTraits } = require('./cognitiveModel/profile');
const { crossRefStateWithEntities, mergeModelEntries, detectModelOverlaps, synthesizeCoreInsight } = require('./cognitiveModel/overlap');
const { runUserModelCycle } = require('./cognitiveModel/cycle');

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
