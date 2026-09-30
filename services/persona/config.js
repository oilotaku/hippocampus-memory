// =================================================================
// services/persona/config.js — memory_config.json 的 persona 區段（G3）
//
// 所有鍵都可省略、非法值一律退回預設。cfg 可注入（測試用），不傳就讀真實設定檔。
// =================================================================

const DEFAULTS = Object.freeze({
    auto_apply: true,              // 關係層提案是否自動套用（false = 一律等人工審核）
    drift_check: true,             // 每日漂移偵測（false = 完全不跑）
    min_evidence: 3,               // 提案所需的獨立證據（碎片）數
    min_days: 3,                   // 證據需跨幾個不同日期
    min_confidence: 0.7,           // 特質信心門檻（提案與聊天注入共用）
    weekly_apply_limit: 2,         // 每 7 天最多自動套用幾項
    max_prompt_lines: 5,           // 聊天 prompt 的 <relationship_context> 最多幾行
    prompt_token_budget: 300,      // 該區塊的獨立 token 預算（字數 / 4）
    drift_threshold: 0.75,         // 嵌入餘弦相似度的平均門檻，低於就判定漂移
    drift_threshold_jaccard: 0.2,  // 嵌入不可用、退回兩字組 Jaccard 時的門檻（該指標本來就偏低）
    drift_samples: 1,              // 每題探針取樣次數（取平均）
    judgment_max_change: 0.4,      // judgment 新舊差異比例（編輯距離 / 較長者長度）上限
});

function loadConfig() {
    try { return require('../../memory_config.json'); } catch (_) { /* 沒有就退回範例 */ }
    try { return require('../../memory_config.example.json'); } catch (_) { return {}; }
}

const num = (v, def, { min = -Infinity, max = Infinity, int = false } = {}) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return def;
    return int ? Math.floor(v) : v;
};
const bool = (v, def) => (typeof v === 'boolean' ? v : def);

function getPersonaConfig(cfg) {
    const c = cfg === undefined ? loadConfig() : cfg;
    const p = (c && c.persona) || {};
    return {
        auto_apply: bool(p.auto_apply, DEFAULTS.auto_apply),
        drift_check: bool(p.drift_check, DEFAULTS.drift_check),
        min_evidence: num(p.min_evidence, DEFAULTS.min_evidence, { min: 1, int: true }),
        min_days: num(p.min_days, DEFAULTS.min_days, { min: 1, int: true }),
        min_confidence: num(p.min_confidence, DEFAULTS.min_confidence, { min: 0, max: 1 }),
        weekly_apply_limit: num(p.weekly_apply_limit, DEFAULTS.weekly_apply_limit, { min: 0, int: true }),
        max_prompt_lines: num(p.max_prompt_lines, DEFAULTS.max_prompt_lines, { min: 0, int: true }),
        prompt_token_budget: num(p.prompt_token_budget, DEFAULTS.prompt_token_budget, { min: 1, int: true }),
        drift_threshold: num(p.drift_threshold, DEFAULTS.drift_threshold, { min: 0, max: 1 }),
        drift_threshold_jaccard: num(p.drift_threshold_jaccard, DEFAULTS.drift_threshold_jaccard, { min: 0, max: 1 }),
        drift_samples: num(p.drift_samples, DEFAULTS.drift_samples, { min: 1, max: 5, int: true }),
        judgment_max_change: num(p.judgment_max_change, DEFAULTS.judgment_max_change, { min: 0, max: 1 }),
    };
}

module.exports = { DEFAULTS, getPersonaConfig };
