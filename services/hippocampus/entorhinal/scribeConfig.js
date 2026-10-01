'use strict';
// =================================================================
// services/hippocampus/entorhinal/scribeConfig.js — Scribe 設定（memory_config.json 的 scribe.*）
// 與 scribe.js 分開放，scribe 的對外介面（G5 快照）不變。
// =================================================================
// prompt: 'v2'（預設）→ 整理壓縮後的提示詞（scribePromptV2.js）；'legacy' → 舊版提示詞，逐字不變。
//   2026-10 改預設：v2 在中文合成集短／長對話問答 69%→79%、71%→78%，誘餌題持平（前提感知評分）。
// max_output_tokens: 單批抽取的輸出上限（預設 16384）。原本寫死 4096，但一批 60 則訊息的 JSON 輸出
//   實測中位數約 5,500～6,100 token、最大 1.2 萬，大多數批次會被截斷而整批作廢。
//   本機小模型受 num_ctx 限制；超過時由截斷切半機制兜底。
// temperature: 抽取溫度（預設 0.3；允許 0）。
// fix_dates: 寫入前校正內文「M月D日（週X）」日期與星期不一致（預設 true，見 dentate/dateFix.js）。
// 非法值一律回退預設。測試與評測可用 setScribeConfigOverride 覆蓋整個區段。
const SCRIBE_DEFAULTS = Object.freeze({ prompt: 'v2', max_output_tokens: 16384, temperature: 0.3, fix_dates: true });
let _override = null;
function setScribeConfigOverride(cfg) { _override = cfg == null ? null : cfg; }
function getScribeConfig() {
    let raw = _override;
    if (!raw) {
        try { raw = require('../../../memory_config.json').scribe || {}; } catch (_) { raw = {}; }
    }
    const D = SCRIBE_DEFAULTS;
    const num = (v, d, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d);
    return {
        prompt: raw.prompt === 'legacy' ? 'legacy' : D.prompt,
        max_output_tokens: Math.round(num(raw.max_output_tokens, D.max_output_tokens, 512, 65536)),
        temperature: num(raw.temperature, D.temperature, 0, 2),
        fix_dates: typeof raw.fix_dates === 'boolean' ? raw.fix_dates : D.fix_dates,
    };
}

module.exports = { getScribeConfig, setScribeConfigOverride, SCRIBE_DEFAULTS };
