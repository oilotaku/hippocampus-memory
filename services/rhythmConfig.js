// =================================================================
// services/rhythmConfig.js — memory_config.json 的 rhythm 區段讀取
// =================================================================

const DEFAULT_DEEP_CYCLE_MIN_FREE_MB = 1200;

function loadConfig() {
    try { return require('../memory_config.json'); } catch (_) { return {}; }
}

/** 深度迴圈最低可用記憶體（MB），不足則跳過。cfg 可注入（測試用）。 */
function getDeepCycleMinFreeMb(cfg) {
    const c = cfg === undefined ? loadConfig() : cfg;
    const v = c && c.rhythm && c.rhythm.deep_cycle_min_free_mb;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    return DEFAULT_DEEP_CYCLE_MIN_FREE_MB;
}

module.exports = { DEFAULT_DEEP_CYCLE_MIN_FREE_MB, getDeepCycleMinFreeMb };
