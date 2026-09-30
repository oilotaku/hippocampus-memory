// =================================================================
// Ornstein-Uhlenbeck 情緒起伏模型（純數學，無資料庫）
//
// 每一維情緒是一個 OU 過程：
//   x(t+Δ) = μ_s + a·(x(t) − μ_s) + ε,  a = e^(−Δ/τ),  ε ~ N(0, σ²(1 − a²))
//   觀測 y = x + v,  v ~ N(0, R²)
// μ_s 是時段 s 的基準、τ 是恢復時間（以先驗為主，不從資料估）、σ 是穩態標準差（起伏）。
//
// 估計：
//   - 線上狀態用 Kalman 濾波（觀測雜訊 R = 0.07）。
//   - 時段基準 μ_s 用「OU 感知」的估計：每筆觀測都扣掉上一個狀態帶來的慣性再換算成對 μ 的一筆
//     觀測（m = (y − a·x_prev)/(1 − a)），並以其精度（1−a)²/Var 加權。相隔太近（a→1）的觀測
//     幾乎不提供基準資訊，所以「昨晚低落的餘波」不會把深夜基準拉偏。
//   - 分層收縮：時段基準先向使用者自己的整體平均收縮（n0≈8），整體平均再向族群先驗收縮（n0≈10）。
//   - σ 同樣向族群先驗 σ0 收縮。
// =================================================================
const { SLOTS } = require('./time');

const MIN_SIGMA = 0.03;
// 截尾 k 個 σ 的常態殘差，平方後期望值是 0.9205（k=2）→ 估變異數時除回去
const ROBUST_K = 2;
const ROBUST_CORR = 1 / 0.9205;

// stats: { slots: { slot: { n, w, s } }, all: { nr, r2 } }
// 回傳 { overall, sigma, slots: { slot: { mu, n } }, n }
function estimate(stats, cfg) {
    const R2 = cfg.obs_noise * cfg.obs_noise;
    const slots = stats?.slots || {};
    let n = 0, wSum = 0, sSum = 0;
    for (const k of SLOTS) {
        const r = slots[k];
        if (!r) continue;
        n += r.n || 0; wSum += r.w || 0; sSum += r.s || 0;
    }
    const userRaw = wSum > 0 ? sSum / wSum : cfg.prior_mu;
    const overall = n > 0 ? (n * userRaw + cfg.shrink_user_n0 * cfg.prior_mu) / (n + cfg.shrink_user_n0) : cfg.prior_mu;

    const out = {};
    for (const k of SLOTS) {
        const r = slots[k];
        const ns = r?.n || 0;
        const raw = (r && r.w > 0) ? r.s / r.w : overall;
        out[k] = { mu: ns > 0 ? (ns * raw + cfg.shrink_slot_n0 * overall) / (ns + cfg.shrink_slot_n0) : overall, n: ns };
    }

    const nr = stats?.all?.nr || 0;
    const s0 = cfg.prior_sigma * cfg.prior_sigma;
    const dataVar = nr > 0 ? Math.max((stats.all.r2 / nr) * ROBUST_CORR - R2, MIN_SIGMA * MIN_SIGMA) : s0;
    const sigma = Math.sqrt(nr > 0 ? (nr * dataVar + cfg.shrink_user_n0 * s0) / (nr + cfg.shrink_user_n0) : s0);
    return { overall, sigma: Math.max(sigma, MIN_SIGMA), slots: out, n };
}

// 一步 Kalman：state = { x, p, t(ms) } 或 null（第一筆）；回傳新狀態與對 μ 的觀測
function kalmanStep(state, y, tMs, mu, sigma, tauHours, obsNoise) {
    const R2 = obsNoise * obsNoise;
    const s2 = sigma * sigma;
    let a = 0, xPrior, pPrior;
    let muObs = null;
    if (!state) {
        xPrior = mu; pPrior = s2;
        muObs = { m: y, w: 1 / (s2 + R2) };
    } else {
        const dh = Math.max(0, (tMs - state.t) / 3600000);
        a = Math.exp(-dh / tauHours);
        xPrior = mu + a * (state.x - mu);
        pPrior = a * a * state.p + s2 * (1 - a * a);
        if (1 - a >= 0.05) {
            const v = s2 * (1 - a * a) + R2 + a * a * state.p;
            muObs = { m: (y - a * state.x) / (1 - a), w: ((1 - a) * (1 - a)) / v };
        }
    }
    const K = pPrior / (pPrior + R2);
    return { x: xPrior + K * (y - xPrior), p: (1 - K) * pPrior, t: tMs, muObs, a };
}

// 偏離「個人＋時段」基準幾個 σ（σ 含觀測雜訊）
function zScore(y, mu, sigma, obsNoise) {
    return (y - mu) / Math.sqrt(sigma * sigma + obsNoise * obsNoise);
}

// 估 σ 用的殘差平方：截尾在 ±2 個目前的 σ（含觀測雜訊），
// 免得少數真實的情緒事件（正是要偵測的對象）把「平常的起伏」估大、反過來讓事件變得偵測不到
function robustResidualSq(y, mu, sigma, obsNoise, k = ROBUST_K) {
    const c = k * Math.sqrt(sigma * sigma + obsNoise * obsNoise);
    const r = Math.max(-c, Math.min(c, y - mu));
    return r * r;
}

module.exports = { estimate, kalmanStep, zScore, robustResidualSq, MIN_SIGMA };
