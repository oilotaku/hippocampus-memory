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

// ═══════════════════════════════════════════════════════
// Main Deep Cycle Entry Point
// ═══════════════════════════════════════════════════════

async function runUserModelCycle() {
    console.log('[UserModel] 🧠 认知模型维护周期开始');

    // Phase 0: Backfill evidence for entries that need it (zero LLM)
    backfillModelEvidence();

    // Phase 0b: Anchor orphan seed entries to source fragments (zero LLM, bigram match)
    seedAnchorOrphanEntries();

    // Phase 0c: {{ai.name}} reads user's raw words → current_state impression (LLM)
    let observationResult = { skipped: true, reason: 'not attempted' };
    try {
        observationResult = await readUserRawMessages();
    } catch (e) {
        console.error('[UserModel] readUserRawMessages error:', e.message);
    }

    // Phase 1: Pure mechanical decay (zero LLM)
    const decayResult = processModelDecay();

    // Phase 2: Resolve expired states (zero LLM)
    const resolved = resolveExpiredStates();

    // Phase 3: LLM validation of hypotheses
    const validateResult = await validateHypotheses();

    // Phase 4: LLM detection of new traits
    const detectResult = await detectNewTraits();

    // Phase 5: Review flagged traits (LLM — re-evaluate traits with contradictions)
    const reviewedResult = await reviewFlaggedTraits();

    // Phase 5b: Proactive trait review — predictive-processing: contrast stable_traits
    // against recent fragments even when no contradiction alarm has fired
    let proactiveReviewResult = { reviewed: 0 };
    try {
        proactiveReviewResult = await reviewStableTraits();
    } catch (e) {
        console.error('[UserModel] reviewStableTraits error:', e.message);
    }

    // Phase 5b2: Integrate high-confidence traits into {{user.name}} profile (NEW — v5.10)
    let profileResult = { integrated: 0, rejected: 0, conflicts: 0 };
    try {
        profileResult = await integrateProfileTraits();
    } catch (e) {
        console.error('[UserModel] integrateProfileTraits error:', e.message);
    }

    // Phase 5c: Cross-reference — current_state ↔ entity_profiles + stable_trait (zero LLM)
    let crossRefResult = { entityFlags: 0, traitFlags: 0, stateConflicts: 0 };
    try {
        crossRefResult = crossRefStateWithEntities();
    } catch (e) {
        console.error('[UserModel] crossRefStateWithEntities error:', e.message);
    }

    // Phase 6: 全量 trait 去重审查（LLM，24h 冷却）
    let dedupResult = { merged: 0 };
    try {
        const DEDUP_GAP_MS = 24 * 60 * 60 * 1000;
        if (!runUserModelCycle._lastDedupAt || (Date.now() - runUserModelCycle._lastDedupAt) >= DEDUP_GAP_MS) {
            dedupResult = await detectModelOverlaps();
            if (dedupResult.merged > 0) runUserModelCycle._lastDedupAt = Date.now();
        }
    } catch (e) {
        console.error('[UserModel] detectModelOverlaps error:', e.message);
    }

    // Phase 7: CORE_INSIGHT — v5.4 退役。被 {{user.name}} Model + Intuition 覆盖。
    const insightResult = { synthesized: false };

    // Phase 8: Auto spot-check — verify up to 3 recent inferred entries against source messages
    let spotCheckResult = { checked: 0 };
    try {
        const { autoSpotCheck } = require('../scripts/spotCheckModel');
        spotCheckResult = await autoSpotCheck([]);
    } catch (e) {
        console.error('[UserModel] autoSpotCheck error:', e.message);
    }

    console.log(`[UserModel] 周期完成: observation=${!observationResult.skipped} decay=${decayResult.decayed + decayResult.resolved + decayResult.abandoned} validate=${validateResult.validated} detected=${detectResult.detected} reviewed=${reviewedResult.reviewed} proactive=${proactiveReviewResult.refined + proactiveReviewResult.weakened + proactiveReviewResult.noted} crossref=${crossRefResult.entityFlags + crossRefResult.traitFlags + crossRefResult.stateConflicts} dedup=${dedupResult.merged} insight=${insightResult.synthesized} spotcheck=${spotCheckResult.checked}`);

    return { observation: observationResult, decay: decayResult, resolved, validate: validateResult, detect: detectResult, reviewed: reviewedResult, crossref: crossRefResult, dedup: dedupResult, insight: insightResult, spotCheck: spotCheckResult };
}

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
