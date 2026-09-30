// =================================================================
// 情緒褪色（fading affect bias）：負面情緒褪得比正面快
// 排序用的有效強度隨時間褪色；原始分數（intensity）保留不動。
// =================================================================
const { getEmotionConfig } = require('./config');
const { parseUtc } = require('./time');

// 依 valence 決定半衰期：≤ −0.1 用負面、≥ +0.1 用正面，中間線性過渡
function halfLifeDays(valence, cfg = getEmotionConfig()) {
    const neg = cfg.fade_half_life_neg_days, pos = cfg.fade_half_life_pos_days;
    const t = Math.min(1, Math.max(0, ((valence || 0) + 0.1) / 0.2));
    return neg + (pos - neg) * t;
}

// fragment: { intensity, valence, raised_at, created_at }；now: Date | 字串（預設現在）
function effectiveIntensity(fragment, now = new Date()) {
    if (!fragment) return 0;
    const base = fragment.intensity;
    if (base === null || base === undefined) return null;   // 沒有情緒資料：呼叫端改用 emotional_weight
    const t0 = parseUtc(fragment.raised_at) || parseUtc(fragment.created_at);
    const t1 = parseUtc(now) || new Date();
    if (!t0) return base;
    const days = Math.max(0, (t1.getTime() - t0.getTime()) / 86400000);
    return base * Math.pow(0.5, days / halfLifeDays(fragment.valence));
}

module.exports = { effectiveIntensity, halfLifeDays };
