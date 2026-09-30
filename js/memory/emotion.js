// ========================================
// 記憶星圖 — 依情緒上色（純函式，無 DOM／three.js 相依，可在 Node 測試）
// 八維情緒（Plutchik）：喜悅 信任 恐懼 驚訝 悲傷 厭惡 憤怒 期待。
// 分數是 0～1 的原始值，扣掉 0.2 底噪後才算「真的有情緒」（與後端 services/emotion 同一慣例）。
// ========================================

export const NOISE_FLOOR = 0.2;
export const EMOTION_DIMS = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'];

// 配色：Plutchik 慣用色，微調過明度，確保在深色背景（#020410）上仍可辨識、彼此可分
export const EMOTION_INFO = {
    joy:          { label: '喜悅', hex: '#ffd23f' },   // 黃
    trust:        { label: '信任', hex: '#9be37e' },   // 淺綠
    fear:         { label: '恐懼', hex: '#1fa363' },   // 深綠
    surprise:     { label: '驚訝', hex: '#37d5e3' },   // 青
    sadness:      { label: '悲傷', hex: '#4d82ff' },   // 藍
    disgust:      { label: '厭惡', hex: '#b16be6' },   // 紫
    anger:        { label: '憤怒', hex: '#ff4b4b' },   // 紅
    anticipation: { label: '期待', hex: '#ff9a3c' },   // 橙
};
export const NEUTRAL_RGB = [128, 134, 150];   // 沒有情緒訊號的星：中性灰
const STRENGTH_FULL = 0.6;                    // 扣底噪後的 intensity 達此值視為滿飽和

const clamp01 = x => Math.max(0, Math.min(1, x));
export function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** 主導情緒：八維中扣底噪後最大者；全部 ≤ 底噪或沒有資料 → null。平手取 EMOTION_DIMS 順序在前者。 */
export function dominantEmotion(emotion) {
    if (!emotion || typeof emotion !== 'object') return null;
    let best = null;
    for (const dim of EMOTION_DIMS) {
        const raw = Number(emotion[dim]);
        if (!Number.isFinite(raw)) continue;
        const net = raw - NOISE_FLOOR;
        if (net > 0 && (!best || net > best.net + 1e-9)) best = { dim, raw, net };
    }
    return best;
}

/**
 * 情緒模式下一顆星的顏色。
 * 回傳 { rgb:[r,g,b], dim:string|null, strength:0..1, neutral:boolean }。
 * strength 取 intensity（後端已扣底噪）；intensity 缺就用主導情緒的淨分數。
 * 色調由主導情緒決定，飽和度／亮度隨 strength 由中性灰漸進到滿色；intensity 為 0 或 null → 中性灰且較暗。
 */
export function emotionColor(emotion, intensity) {
    const dom = dominantEmotion(emotion);
    const inten = Number.isFinite(intensity) ? intensity : (dom ? dom.net : 0);
    if (!dom || !(inten > 0)) return { rgb: mix(NEUTRAL_RGB, [0, 0, 0], 0.35), dim: null, strength: 0, neutral: true };
    const strength = clamp01(inten / STRENGTH_FULL);
    const base = hexToRgb(EMOTION_INFO[dom.dim].hex);
    const rgb = mix(mix(NEUTRAL_RGB, [0, 0, 0], 0.15), base, 0.4 + 0.6 * strength);
    return { rgb, dim: dom.dim, strength, neutral: false };
}

/** 給 2D 用的 "r,g,b" 字串 */
export function emotionRgbString(emotion, intensity) {
    const c = emotionColor(emotion, intensity);
    return c.rgb.join(',');
}

/** 每顆星的顏色（依上色模式）：'galaxy' 回 fallbackRgb（[r,g,b]），'emotion' 回情緒色 */
export function starRgb(star, colorMode, fallbackRgb) {
    if (colorMode !== 'emotion') return fallbackRgb;
    return emotionColor(star && star.emotion, star && star.intensity).rgb;
}

// ── 上色模式偏好（localStorage；隱私模式／被封鎖時讀寫皆可能丟例外）──
export const COLOR_MODE_KEY = 'memory.colorMode';
export function loadColorMode(storage) {
    try {
        const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        const v = s && s.getItem(COLOR_MODE_KEY);
        return v === 'emotion' ? 'emotion' : 'galaxy';
    } catch (_) { return 'galaxy'; }
}
export function saveColorMode(mode, storage) {
    try {
        const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (s) s.setItem(COLOR_MODE_KEY, mode);
    } catch (_) { /* 無法記住偏好不影響功能 */ }
}

// ── 目前的上色模式（模組單例；2D／4D／圖例共用）──
let _mode = loadColorMode();
const _listeners = [];
export const getColorMode = () => _mode;
export function setColorMode(mode) {
    _mode = mode === 'emotion' ? 'emotion' : 'galaxy';
    saveColorMode(_mode);
    _listeners.forEach(fn => { try { fn(_mode); } catch (e) { console.error(e); } });
}
export function onColorModeChange(fn) { _listeners.push(fn); }
