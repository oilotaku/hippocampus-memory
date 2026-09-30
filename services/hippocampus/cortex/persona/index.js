// =================================================================
// services/persona/index.js — 人格三層（G3）
//
//   核心層    core.js          只能手寫（core-prompt.txt），這裡只記版本與雜湊
//   關係層    relationship.js  由 user_model 的穩定特質慢慢長出，提案 → 套用 → 可回滾
//   情境層    promptContext.js 未過期的 current_state（聊天時由 intuition 每輪注入）
//   接回 prompt  promptContext.js  <relationship_context>
//   漂移偵測  drift.js         固定探針 + 錨點回答，漂移就回滾關係層
//   judgment  judgment.js      實體印象的錨點式增量更新（由 archivist/entityOverview.js 呼叫）
// =================================================================

const config = require('./config');
const core = require('./core');
const relationship = require('./relationship');
const promptContext = require('./promptContext');
const drift = require('./drift');
const judgment = require('./judgment');
const events = require('./events');

/**
 * 每日人格維護（掛在 archivist 深迴圈，runTaskIfDue 冷卻 20 小時）：
 * 核心層版本 → 產生提案 → 自動套用 → 漂移偵測。
 * 每一步各自 try/catch，任何一步失敗不影響其他步。
 */
async function runPersonaMaintenance(opts = {}) {
    const out = { llmCalls: 0 };
    try { out.core = core.recordCoreVersion({ text: opts.coreText }); }
    catch (e) { console.error('[Persona] 核心層版本記錄失敗:', e.message); }
    try {
        const g = relationship.generateProposals(opts);
        out.proposalsCreated = g.created.length;
        const a = relationship.autoApplyPending(opts);
        out.proposalsApplied = a.applied.length;
    } catch (e) { console.error('[Persona] 關係層提案失敗:', e.message); }
    try {
        const d = await drift.runDriftCheck(opts);
        out.drift = d.status;
        out.llmCalls += d.llmCalls || 0;
    } catch (e) { console.error('[Persona] 漂移偵測失敗:', e.message); }
    return out;
}

module.exports = {
    ...config, ...core, ...relationship, ...promptContext, ...drift, ...judgment, ...events,
    runPersonaMaintenance,
};
