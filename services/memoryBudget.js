// =================================================================
// services/memoryBudget.js — 记忆区块 token 总预算（纯函数 + 设定读取）
//
// 设定：memory_config.json 的 context.memory_token_budget（正整数，预设 1200）。
// 估算方式沿用 context.js 既有的「字数 / 4」。
// 截断规则：依传入顺序（即排序）逐条收，遇到第一条放不下就停——
// 只会整条丢弃，绝不切在一条记忆中间，也不会为了塞更多而跳过排序较前的条目。
// =================================================================

const DEFAULT_MEMORY_TOKEN_BUDGET = 1200;

function loadConfig() {
    try { return require('../memory_config.json'); } catch (_) { return {}; }
}

/** 读取预算；cfg 可注入（测试用）。非正整数一律回退预设值。 */
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
 * 依序收入 items，累计成本不超过 budget。
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

/** entityProfile.getEntityContext 的输出以「※ 」开头分条，切回各条实体档案 */
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
