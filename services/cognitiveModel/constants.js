// =================================================================
// services/cognitiveModel/constants.js — LLM 設定 id、假設升級／放棄、狀態半衰期／自動結案、特質矛盾門檻、深迴圈冷卻
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================



// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const LLM_CONFIG_ID = 52; // gemini-flash-lite 官key（隱私敏感：讀使用者原始訊息）


const HYPOTHESIS_UPGRADE_EVIDENCE = 3;   // 3次確認 → 升級為 trait

const HYPOTHESIS_ABANDON_DAYS = 14;      // 14天無證據 → 放棄

const STATE_HALF_LIFE_DAYS = 7;          // current_state 半衰期

const STATE_AUTO_RESOLVE_DAYS = 14;      // 14天無證據 → 自動 resolved

const TRAIT_CONTRADICTION_THRESHOLD = 3; // 矛盾≥3 → 降級重審

const MIN_GAP_USER_MODEL = 4 * 60 * 60 * 1000; // 深迴圈冷卻 4h

module.exports = {
    LLM_CONFIG_ID,
    HYPOTHESIS_UPGRADE_EVIDENCE,
    HYPOTHESIS_ABANDON_DAYS,
    STATE_HALF_LIFE_DAYS,
    STATE_AUTO_RESOLVE_DAYS,
    TRAIT_CONTRADICTION_THRESHOLD,
    MIN_GAP_USER_MODEL,
};
