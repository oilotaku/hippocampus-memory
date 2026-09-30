// G2 情緒引擎的可重現模擬（固定種子）。檔名以 _ 開頭，node --test 不會當成測試檔。
const { estimate, kalmanStep, zScore, robustResidualSq } = require('../../services/emotion/ou');
const { getEmotionConfig } = require('../../services/emotion/config');
const { slotOfHour } = require('../../services/emotion/time');

function rng(seed) {   // mulberry32
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function gauss(r) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const HOURS = { morning: [5, 11], noon: [11, 17], evening: [17, 23], night: [23, 29] };
const DEFAULT_W = { morning: 0.25, noon: 0.3, evening: 0.35, night: 0.1 };

// 潛在狀態 OU（基準依時段）＋每天 shockProb 的真實事件（+shockMag）＋觀測雜訊
function simulate({ seed, days = 60, mu, sigma = 0.08, tau = 6, shockProb = 0.08, shockMag = 0.4, obsPerDay = 8, weights = DEFAULT_W, noise = 0.07 }) {
    const r = rng(seed);
    const obs = [];
    const day0 = Date.UTC(2026, 0, 1);
    let x = null, tPrev = null, shockRes = 0;
    for (let d = 0; d < days; d++) {
        const times = [];
        for (let i = 0; i < obsPerDay; i++) {
            let u = r(), slot = 'evening';
            for (const [k, w] of Object.entries(weights)) { if (u < w) { slot = k; break; } u -= w; }
            const [h0, h1] = HOURS[slot];
            times.push(day0 + d * 86400000 + (h0 + r() * (h1 - h0)) * 3600000);
        }
        times.sort((a, b) => a - b);
        const shockAt = r() < shockProb ? Math.floor(r() * times.length) : -1;
        let shockT = null;
        times.forEach((t, i) => {
            const slot = slotOfHour(new Date(t).getUTCHours());
            const m = mu[slot];
            if (x === null) x = m + sigma * gauss(r);
            else {
                const a = Math.exp(-((t - tPrev) / 3600000) / tau);
                x = m + a * (x - m) + sigma * Math.sqrt(1 - a * a) * gauss(r);
                shockRes *= a;
            }
            if (i === shockAt) { x += shockMag; shockRes += shockMag; shockT = t; }
            tPrev = t;
            // 真值：事件效應還剩一半以上（≥ shockMag/2）才算「仍在情緒轉折中」
            const truth = shockRes >= shockMag / 2;
            obs.push({ t, slot, day: d, y: Math.min(1, Math.max(0, x + noise * gauss(r))), truth });
        });
    }
    return obs;
}

// 依序餵入觀測：回傳每筆的 z 與最終估計。slotOverride：把所有觀測當成同一時段（= 只有個人基準）
function runDetector(obs, { slotOverride = null, cfg = getEmotionConfig(), burnIn = 20 } = {}) {
    const stats = { slots: {}, all: { n: 0, nr: 0, r2: 0 } };
    let state = null;
    let tp = 0, fp = 0, fn = 0;
    for (const o of obs) {
        const slot = slotOverride || o.slot;
        const est = estimate(stats, cfg);
        const mu = est.slots[slot].mu;
        const z = zScore(o.y, mu, est.sigma, cfg.obs_noise);
        const flagged = z >= cfg.anomaly_sigma;
        if (o.day >= burnIn) {
            if (flagged && o.truth) tp++; else if (flagged) fp++; else if (o.truth) fn++;
        }
        const step = kalmanStep(state, o.y, o.t, mu, est.sigma, cfg.tau_hours, cfg.obs_noise);
        state = { x: step.x, p: step.p, t: step.t };
        const w = step.muObs ? step.muObs.w : 0;
        const s = stats.slots[slot] = stats.slots[slot] || { n: 0, w: 0, s: 0 };
        s.n += Math.min(1, w * (est.sigma ** 2 + cfg.obs_noise ** 2));
        s.w += w; s.s += step.muObs ? w * step.muObs.m : 0;
        stats.all.n++; stats.all.nr++; stats.all.r2 += robustResidualSq(o.y, mu, est.sigma, cfg.obs_noise);
    }
    const p = tp + fp ? tp / (tp + fp) : 0, rc = tp + fn ? tp / (tp + fn) : 0;
    return { tp, fp, fn, precision: p, recall: rc, f1: p + rc ? 2 * p * rc / (p + rc) : 0, est: estimate(stats, cfg), stats };
}

module.exports = { rng, gauss, simulate, runDetector };
