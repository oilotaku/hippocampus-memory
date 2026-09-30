// =================================================================
// services/memoryBudget.js — 記憶區塊 token 總預算（純函式 + 設定讀取）
//
// 設定：memory_config.json 的 context.memory_token_budget（正整數，預設 1200）。
// 估算方式沿用 context.js 既有的「字數 / 4」。
// 截斷規則：依傳入順序（即排序）逐條收，遇到第一條放不下就停——
// 只會整條丟棄，絕不切在一條記憶中間，也不會為了塞更多而跳過排序較前的條目。
// =================================================================

const DEFAULT_MEMORY_TOKEN_BUDGET = 1200;

function loadConfig() {
    try { return require('../memory_config.json'); } catch (_) { return {}; }
}

/** 讀取預算；cfg 可注入（測試用）。非正整數一律回退預設值。 */
function getMemoryTokenBudget(cfg) {
    const c = cfg === undefined ? loadConfig() : cfg;
    const v = c && c.context && c.context.memory_token_budget;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
    return DEFAULT_MEMORY_TOKEN_BUDGET;
}

function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

/**
 * 依序收入 items，累計成本不超過 budget。
 * @returns {{kept: Array, used: number, dropped: number}}
 */
function takeWithinBudget(items, budget, costFn) {
    const kept = [];
    let used = 0;
    const list = items || [];
    for (const item of list) {
        const cost = costFn(item);
        if (used + cost > budget) break;
        kept.push(item);
        used += cost;
    }
    return { kept, used, dropped: list.length - kept.length };
}

/** entityProfile.getEntityContext 的輸出以「※ 」開頭分條，切回各條實體檔案 */
function splitEntityBlocks(text) {
    if (!text) return [];
    return String(text).split(/\n(?=※ )/);
}

module.exports = {
    DEFAULT_MEMORY_TOKEN_BUDGET,
    getMemoryTokenBudget,
    estimateTokens,
    takeWithinBudget,
    splitEntityBlocks,
};
