'use strict';
// =================================================================
// services/hippocampus/entorhinal/scribeConfig.js — Scribe 設定（memory_config.json 的 scribe.*）
// 與 scribe.js 分開放，scribe 的對外介面（G5 快照）不變。
// =================================================================
// prompt: 'legacy'（預設）→ 舊版提示詞，逐字不變；'v2' → 整理壓縮後的提示詞（scribePromptV2.js）。
// 非法值一律回退預設。測試與評測可用 setScribeConfigOverride 覆蓋整個區段。
const SCRIBE_DEFAULTS = Object.freeze({ prompt: 'legacy' });
let _override = null;
function setScribeConfigOverride(cfg) { _override = cfg == null ? null : cfg; }
function getScribeConfig() {
    let raw = _override;
    if (!raw) {
        try { raw = require('../../../memory_config.json').scribe || {}; } catch (_) { raw = {}; }
    }
    return { prompt: raw.prompt === 'v2' ? 'v2' : SCRIBE_DEFAULTS.prompt };
}

module.exports = { getScribeConfig, setScribeConfigOverride, SCRIBE_DEFAULTS };
