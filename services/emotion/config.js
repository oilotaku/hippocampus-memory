// =================================================================
// 情緒引擎設定：memory_config.json 的 emotion.* + 預設值
// =================================================================
const { config } = require('../memoryConfig');

const DEFAULTS = Object.freeze({
    enabled: true,
    timezone: 'Asia/Taipei',
    noise_floor: 0.2,               // 八維底噪：分數先扣掉它才算「真的有情緒」
    prior_mu: 0.2,                  // 族群先驗：基準
    prior_sigma: 0.15,              // 族群先驗：起伏（穩態標準差）
    tau_hours: 6,                   // 恢復時間（以先驗為主，不從資料估）
    obs_noise: 0.07,                // Kalman 觀測雜訊 R 的標準差（量測：兩輪平均差 0.04、r=0.95）
    shrink_slot_n0: 8,              // 時段基準向使用者整體平均收縮的強度
    shrink_user_n0: 10,             // 使用者整體平均／σ 向族群先驗收縮的強度
    learning_min_samples: 50,       // 有效樣本少於這個數，標示「學習中」
    anomaly_sigma: 2,               // 偏離「個人＋時段」基準幾個 σ 算情緒轉折
    attribution_half_life_days: 30, // 實體 × 情緒統計的時間衰減半衰期
    attribution_prior_strength: 3,  // 貝氏平均：先驗相當於幾筆觀察
    attribution_prior_rate: 0.1,    // 全域還沒有資料時的預設轉折率
    fade_half_life_neg_days: 60,    // 情緒褪色：負面情緒半衰期
    fade_half_life_pos_days: 120,   // 情緒褪色：正面情緒半衰期
});

let override = null;

function num(v, d) { return (typeof v === 'number' && Number.isFinite(v)) ? v : d; }

function getEmotionConfig() {
    const src = { ...(config.emotion || {}), ...(override || {}) };
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        if (src[k] === undefined) continue;
        if (typeof DEFAULTS[k] === 'boolean') out[k] = src[k] !== false && src[k] !== 'false';
        else if (typeof DEFAULTS[k] === 'string') out[k] = String(src[k] || DEFAULTS[k]);
        else out[k] = num(src[k], DEFAULTS[k]);
    }
    return out;
}

function isEnabled() { return getEmotionConfig().enabled; }

// 測試用：暫時覆寫設定（傳 null 還原）
function _setOverride(o) { override = o; }

module.exports = { DEFAULTS, getEmotionConfig, isEnabled, _setOverride };
