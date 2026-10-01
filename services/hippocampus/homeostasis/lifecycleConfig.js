'use strict';
// =================================================================
// services/hippocampus/homeostasis/lifecycleConfig.js — 生命週期門檻（memory_config.json 的 lifecycle.*）
// 與 lifecycle.js 分開放，lifecycle 的對外介面（G5 快照）不變。
// =================================================================
// 全部為正整數；非法值（非整數、超出範圍）一律回退預設。預設值＝原本寫死在 lifecycle.js 的常數。
//   fragment_cooling_days    活躍碎片多少天沒人讀／引用 → 冷卻
//   fragment_frozen_days     冷卻後多少天 → 凍結（從 ChromaDB 刪除向量）
//   fragment_tombstone_days  凍結後多少天 → 墓碑（清空內容，僅留證據鏈）
//   episode_mature_months    episode 多少個月未觸達 → 成熟（權重減半；月以 30 天計）
//   episode_archive_months   episode 多少個月 → 歸檔（月以 30 天計）
//   min_frags_for_entity     實體最少碎片數才提取
//   correction_days_lookback 糾正反饋追溯天數
const LIFECYCLE_DEFAULTS = Object.freeze({
    fragment_cooling_days: 14,
    fragment_frozen_days: 30,
    fragment_tombstone_days: 90,
    episode_mature_months: 6,
    episode_archive_months: 12,
    min_frags_for_entity: 2,
    correction_days_lookback: 7,
});
const RANGES = Object.freeze({
    fragment_cooling_days: [1, 3650],
    fragment_frozen_days: [1, 3650],
    fragment_tombstone_days: [1, 3650],
    episode_mature_months: [1, 120],
    episode_archive_months: [1, 120],
    min_frags_for_entity: [1, 100],
    correction_days_lookback: [1, 365],
});
let _lifecycleOverride = null;   // 測試用：整份 lifecycle 區段覆蓋
function setLifecycleConfigOverride(cfg) { _lifecycleOverride = cfg == null ? null : cfg; }
function getLifecycleConfig() {
    let raw = _lifecycleOverride;
    if (!raw) {
        try { raw = require('../../../memory_config.json').lifecycle || {}; } catch (_) { raw = {}; }
    }
    const out = {};
    for (const k of Object.keys(LIFECYCLE_DEFAULTS)) {
        const [min, max] = RANGES[k];
        const v = raw[k];
        out[k] = Number.isInteger(v) && v >= min && v <= max ? v : LIFECYCLE_DEFAULTS[k];
    }
    return out;
}

module.exports = { getLifecycleConfig, setLifecycleConfigOverride, LIFECYCLE_DEFAULTS };
