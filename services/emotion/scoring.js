// =================================================================
// 八維情緒分數：驗證、底噪扣除、衍生 intensity / valence；event_at 解析
// =================================================================
const { getEmotionConfig } = require('./config');

// Plutchik 八維（資料庫欄位 emo_<key>）
const DIMS = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'];
const DIM_LABELS = { joy: '喜悅', trust: '信任', fear: '恐懼', surprise: '驚訝', sadness: '悲傷', disgust: '厭惡', anger: '憤怒', anticipation: '期待' };
const POSITIVE = ['joy', 'trust', 'anticipation'];
const NEGATIVE = ['sadness', 'fear', 'anger', 'disgust'];

// 模型可能輸出的鍵名別名（中文、常見英文同義詞）
const ALIASES = {};
for (const d of DIMS) { ALIASES[d] = d; ALIASES[DIM_LABELS[d]] = d; }
Object.assign(ALIASES, { happiness: 'joy', happy: 'joy', 快樂: 'joy', 高興: 'joy', 開心: 'joy', 期待感: 'anticipation', expectation: 'anticipation', 難過: 'sadness', sad: 'sadness', 生氣: 'anger', angry: 'anger', 害怕: 'fear', 恐惧: 'fear', 喜悦: 'joy', 信任感: 'trust', 惊讶: 'surprise', 悲伤: 'sadness', 愤怒: 'anger', 厌恶: 'disgust', 期待值: 'anticipation' });

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
}

// 回傳 { raw:{dim:0..1}, valid, total }；emotions 不是物件、或有鍵但一個維度都認不得 → null
// 空物件 {} = 模型明確表示「沒有明顯情緒」（Scribe 只列高於底噪的維度）→ 全 0
function sanitizeEmotions(emotions) {
    if (!emotions || typeof emotions !== 'object' || Array.isArray(emotions)) return null;
    const raw = Object.fromEntries(DIMS.map(d => [d, 0]));
    const keys = Object.entries(emotions);
    let valid = 0;
    for (const [k, v] of keys) {
        const dim = ALIASES[String(k).trim().toLowerCase()] || ALIASES[String(k).trim()];
        if (!dim) continue;
        const n = toNum(v);
        if (n === null) continue;
        raw[dim] = clamp(n, 0, 1);
        valid++;
    }
    if (keys.length && !valid) return null;
    return { raw, valid, total: keys.length };
}

// 扣底噪後的八維（不足 0 的截成 0）
function floored(raw, floor = getEmotionConfig().noise_floor) {
    return Object.fromEntries(DIMS.map(d => [d, Math.max(0, (raw[d] || 0) - floor)]));
}

function deriveIntensity(f) { return Math.max(...DIMS.map(d => f[d] || 0)); }

function deriveValence(f) {
    const pos = POSITIVE.reduce((s, d) => s + (f[d] || 0), 0);
    const neg = NEGATIVE.reduce((s, d) => s + (f[d] || 0), 0);
    return clamp(pos - neg, -1, 1);
}

// 信心：模型給的鍵裡有多少比例是認得且數值合法的（{} 視為明確的「沒有明顯情緒」= 1）
function confidenceOf(s) {
    if (!s) return 0;
    return s.total ? s.valid / s.total : 1;
}

// 整批分析：Scribe entry 的 emotions → 要存的欄位；無法解析回 null
function analyzeEmotions(emotions, cfg = getEmotionConfig()) {
    const s = sanitizeEmotions(emotions);
    if (!s) return null;
    const f = floored(s.raw, cfg.noise_floor);
    const intensity = deriveIntensity(f);
    return {
        raw: s.raw, floored: f, intensity, valence: deriveValence(f),
        confidence: confidenceOf(s),
        informative: intensity > 1e-9,
    };
}

// event_at：只接受 YYYY-MM-DD 或 YYYY-MM（含 ISO 時間則取日期），且日期真實存在；否則 null
function parseEventAt(v) {
    if (typeof v !== 'string') return null;
    const m = v.trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ].*)?$/);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = m[3] ? +m[3] : null;
    if (y < 1900 || y > 2200 || mo < 1 || mo > 12) return null;
    if (d !== null) {
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
        return `${m[1]}-${m[2]}-${m[3]}`;
    }
    return `${m[1]}-${m[2]}`;
}

module.exports = { DIMS, DIM_LABELS, POSITIVE, NEGATIVE, sanitizeEmotions, floored, deriveIntensity, deriveValence, analyzeEmotions, parseEventAt, clamp };
