// =================================================================
// services/cognitiveModel/cycle.js — 深循環：runUserModelCycle
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { seedAnchorOrphanEntries, backfillModelEvidence } = require('./evidence');
const { processModelDecay, resolveExpiredStates } = require('./decay');
const { validateHypotheses, detectNewTraits, reviewFlaggedTraits, reviewStableTraits } = require('./traits');
const { readUserRawMessages } = require('./observation');
const { integrateProfileTraits } = require('./profile');
const { crossRefStateWithEntities, detectModelOverlaps } = require('./overlap');


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
        const { autoSpotCheck } = require('../../scripts/spotCheckModel');
        spotCheckResult = await autoSpotCheck([]);
    } catch (e) {
        console.error('[UserModel] autoSpotCheck error:', e.message);
    }

    console.log(`[UserModel] 周期完成: observation=${!observationResult.skipped} decay=${decayResult.decayed + decayResult.resolved + decayResult.abandoned} validate=${validateResult.validated} detected=${detectResult.detected} reviewed=${reviewedResult.reviewed} proactive=${proactiveReviewResult.refined + proactiveReviewResult.weakened + proactiveReviewResult.noted} crossref=${crossRefResult.entityFlags + crossRefResult.traitFlags + crossRefResult.stateConflicts} dedup=${dedupResult.merged} insight=${insightResult.synthesized} spotcheck=${spotCheckResult.checked}`);

    return { observation: observationResult, decay: decayResult, resolved, validate: validateResult, detect: detectResult, reviewed: reviewedResult, crossref: crossRefResult, dedup: dedupResult, insight: insightResult, spotCheck: spotCheckResult };
}

module.exports = {
    runUserModelCycle,
};
