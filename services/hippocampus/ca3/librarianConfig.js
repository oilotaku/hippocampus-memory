'use strict';
// =================================================================
// services/hippocampus/ca3/librarianConfig.js — 檢索排序設定（memory_config.json 的 librarian.*）
// 與 librarian.js 分開放，librarian 的對外介面（G5 快照）不變。
// =================================================================
// ── 檢索排序設定（memory_config.json 的 librarian.*；非法值一律回退預設）──
// ranking:'legacy' → 與修正前（W1 特性測試固定的行為）完全相同；'v2'（預設）→ 下列修正：
//   entity_boost      實體不再當獨立候選通道（舊版取「該實體最新 N 條」給固定虛擬名次，與問題無關卻常蓋過真正答案），
//                     改為對「已由 FTS／向量找到、且連到訊息中提到之實體」的候選把相關度乘 (1 + entity_boost)。
//                     使用者本人與 AI 的名稱（SKIP_NAMES）不觸發。
//   fts_only_penalty  只被 FTS 找到（無向量交叉驗證）的候選相關度乘此值。舊版 0.7 的理由是「CJK 單字索引太鬆」，
//                     W4 已改兩字切分；LoCoMo／中文合成評測顯示打折只會把真正答案壓到後面（沒有向量時全部候選都是單通道），故預設 1.0。
//   decay_weight      時間因子（分段衰減 × 時效加權）以 factor^decay_weight 進排序分數；0＝時間不影響排序、1＝舊版強度。
//                     衰減只影響排序、不影響是否保留。
//   min_relevance     保留門檻只看相關度（RRF 融合分，含實體加分、不含衰減／重要性／新穎度），很舊但相關的記憶照樣回傳。
//   candidate_overfetch FTS 候選多取 limit × 此值，讓實體加分與時間排序有機會把前 limit 名之外的相關結果換進來。
// 預設值依據：LoCoMo 與中文合成資料集的調參比較（eval/results/ranking_tuning.md）。
const LIBRARIAN_DEFAULTS = Object.freeze({
    ranking: 'v2',
    entity_boost: 0.1,
    fts_only_penalty: 1.0,
    decay_weight: 0.05,
    min_relevance: 0.005,
    candidate_overfetch: 2,
});
let _librarianOverride = null;   // 測試／評測用：整份 librarian 區段覆蓋
function setLibrarianConfigOverride(cfg) { _librarianOverride = cfg == null ? null : cfg; }
function getLibrarianConfig() {
    let raw = _librarianOverride;
    if (!raw) {
        try { raw = require('../../../memory_config.json').librarian || {}; } catch (_) { raw = {}; }
    }
    const D = LIBRARIAN_DEFAULTS;
    const num = (v, d, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d);
    return {
        ranking: raw.ranking === 'legacy' ? 'legacy' : 'v2',
        entity_boost: num(raw.entity_boost, D.entity_boost, 0, 10),
        fts_only_penalty: num(raw.fts_only_penalty, D.fts_only_penalty, 0, 1),
        decay_weight: num(raw.decay_weight, D.decay_weight, 0, 1),
        min_relevance: num(raw.min_relevance, D.min_relevance, 0, 1),
        candidate_overfetch: num(raw.candidate_overfetch, D.candidate_overfetch, 1, 10),
    };
}

module.exports = { getLibrarianConfig, setLibrarianConfigOverride, LIBRARIAN_DEFAULTS };
