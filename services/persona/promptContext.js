// =================================================================
// services/persona/promptContext.js — 把關係層與穩定特質接回聊天 prompt
//
// buildRelationshipContext()：關係層（已套用的提案）+ confidence ≥ 0.7 的 stable_trait，
// 去重後合併成一段 <relationship_context>，最多 max_prompt_lines 行（預設 5），
// 受獨立的小預算 persona.prompt_token_budget（預設 300 token，字數 / 4）限制，
// 不佔用 context.memory_token_budget（W8）。超出預算時整行丟棄、不切斷單行。
//
// getSituationalLayer()：情境層 = 未過期的 current_state。聊天時它已由
// services/intuition.js 每輪注入（帶 TTL），這裡只提供給漂移偵測組完整人格用，不重複注入。
// =================================================================

const { getDb } = require('../../database');
const { estimateTokens, takeWithinBudget } = require('../memoryBudget');
const { USER } = require('../memoryConfig');
const { getPersonaConfig } = require('./config');
const { getActiveRelationship, normKey } = require('./relationship');

function collectLines(c) {
    const db = getDb();
    const out = [];
    const keys = [];
    const push = (text) => {
        const line = String(text || '').replace(/\s+/g, ' ').trim();
        const k = normKey(line);
        if (!k) return;
        // 完全相同、或其中一行包含另一行，視為重複（關係層的行通常就是某條特質的原文）
        if (keys.some(e => e === k || e.includes(k) || k.includes(e))) return;
        keys.push(k);
        out.push(line);
    };
    for (const l of getActiveRelationship().lines) push(l);
    const traits = db.prepare(`SELECT content FROM user_model
        WHERE type = 'stable_trait' AND status = 'active' AND confidence >= ?
        ORDER BY confidence DESC, evidence_count DESC, id LIMIT 30`).all(c.min_confidence);
    for (const t of traits) push(t.content);
    return out;
}

/** 把已挑好的行組成 <relationship_context> 區塊；budgetTokens 內整行取捨，不切斷單行。 */
function renderRelationshipBlock(lines, budgetTokens) {
    if (!lines || lines.length === 0) return '';
    const head = `<relationship_context>\n（你對${USER.name}長期觀察後形成的認識，自然地融入對話，不必逐條複述。）\n`;
    const tail = '\n</relationship_context>';
    const budget = budgetTokens - estimateTokens(head + tail);
    const r = takeWithinBudget(lines, budget, l => estimateTokens('- ' + l) + 1);
    if (r.kept.length === 0) return '';
    return head + r.kept.map(l => `- ${l}`).join('\n') + tail;
}

/** @returns {string} 空字串表示沒有內容可注入 */
function buildRelationshipContext({ cfg } = {}) {
    const c = getPersonaConfig(cfg);
    if (c.max_prompt_lines <= 0) return '';
    const lines = collectLines(c).slice(0, c.max_prompt_lines);
    return renderRelationshipBlock(lines, c.prompt_token_budget);
}

/** 情境層：未過期的 current_state（最近有證據的優先），最多 limit 行。 */
function getSituationalLayer(limit = 3) {
    return getDb().prepare(`SELECT content FROM user_model
        WHERE type = 'current_state' AND status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY last_evidence_at DESC, id DESC LIMIT ?`).all(limit).map(r => r.content);
}

module.exports = { buildRelationshipContext, renderRelationshipBlock, getSituationalLayer };
