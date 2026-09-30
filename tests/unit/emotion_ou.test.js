// G2：OU／Kalman 個人化基準、分層收縮、短句不更新、轉折偵測（固定種子模擬，給容差）
const test = require('node:test');
const assert = require('node:assert/strict');
const { simulate, runDetector } = require('./_emotion_sim');
const { estimate, kalmanStep } = require('../../services/emotion/ou');
const { getEmotionConfig } = require('../../services/emotion/config');
const { boot } = require('./_emotion_helpers');

const SEEDS = [...Array(12).keys()].map(i => i + 1);
const cfg = getEmotionConfig();

function pooled(opts = {}) {
    const agg = { slot: { tp: 0, fp: 0, fn: 0 }, user: { tp: 0, fp: 0, fn: 0 } };
    const mu = { morning: 0, noon: 0, evening: 0, night: 0 };
    let overall = 0;
    for (const seed of SEEDS) {
        const obs = simulate({ seed, days: 120, ...type });
        const a = runDetector(obs, opts), b = runDetector(obs, { ...opts, slotOverride: 'noon' });   // b = 只有個人基準
        for (const f of ['tp', 'fp', 'fn']) { agg.slot[f] += a[f]; agg.user[f] += b[f]; }
        for (const s of Object.keys(mu)) mu[s] += a.est.slots[s].mu / SEEDS.length;
        overall += a.est.overall / SEEDS.length;
    }
    const f1 = (r) => { const p = r.tp / (r.tp + r.fp || 1), c = r.tp / (r.tp + r.fn || 1); return p + c ? 2 * p * c / (p + c) : 0; };
    return { slotF1: f1(agg.slot), userF1: f1(agg.user), agg, mu, overall };
}

const STEADY = { mu: { morning: 0.2, noon: 0.2, evening: 0.2, night: 0.2 }, sigma: 0.06 };
const LOW_MOOD = { mu: { morning: 0.4, noon: 0.4, evening: 0.4, night: 0.4 }, sigma: 0.12 };
const NIGHT_LOW = { mu: { morning: 0.15, noon: 0.15, evening: 0.2, night: 0.55 }, sigma: 0.05, weights: { morning: 0.25, noon: 0.3, evening: 0.3, night: 0.15 } };
let type;

test('平穩型：各時段基準都估在 0.2 附近，偵測有合理的 F1', () => {
    type = STEADY;
    const r = pooled();
    for (const s of Object.keys(r.mu)) assert.ok(Math.abs(r.mu[s] - 0.2) < 0.04, `${s} 基準 ${r.mu[s].toFixed(3)}`);
    assert.ok(r.slotF1 > 0.5, `F1 ${r.slotF1.toFixed(2)}`);
});

test('易低落型：整體基準明顯高於平穩型（方向正確）', () => {
    type = LOW_MOOD;
    const low = pooled();
    type = STEADY;
    const steady = pooled();
    assert.ok(low.overall - steady.overall > 0.15, `${low.overall.toFixed(2)} vs ${steady.overall.toFixed(2)}`);
    assert.ok(Math.abs(low.overall - 0.4) < 0.06);
});

test('晚上低落型：深夜基準明顯高於白天；只有「個人」基準時平常的深夜被誤判成轉折，時段基準才偵測得準', () => {
    type = NIGHT_LOW;
    const r = pooled();
    assert.ok(r.mu.night - r.mu.morning > 0.25, `深夜 ${r.mu.night.toFixed(2)} 早上 ${r.mu.morning.toFixed(2)}`);
    assert.ok(r.mu.night - r.mu.noon > 0.25);
    assert.ok(r.slotF1 - r.userF1 > 0.05, `時段 F1 ${r.slotF1.toFixed(2)} 個人 F1 ${r.userF1.toFixed(2)}`);
    assert.ok(r.agg.slot.fp < r.agg.user.fp, `誤報 時段 ${r.agg.slot.fp} 個人 ${r.agg.user.fp}`);
    assert.ok(r.agg.slot.tp >= r.agg.user.tp, `命中 時段 ${r.agg.slot.tp} 個人 ${r.agg.user.tp}`);
});

test('同一份模擬重跑結果完全相同（可重現）', () => {
    type = NIGHT_LOW;
    const a = runDetector(simulate({ seed: 7, days: 60, ...type }));
    const b = runDetector(simulate({ seed: 7, days: 60, ...type }));
    assert.deepEqual([a.tp, a.fp, a.fn], [b.tp, b.fp, b.fn]);
    assert.equal(a.est.overall, b.est.overall);
});

test('分層收縮：沒有資料 = 族群先驗；樣本少時接近先驗、樣本多時接近個人值', () => {
    const empty = estimate({ slots: {}, all: { nr: 0, r2: 0 } }, cfg);
    assert.equal(empty.overall, cfg.prior_mu);
    assert.equal(empty.slots.night.mu, cfg.prior_mu);
    assert.ok(Math.abs(empty.sigma - cfg.prior_sigma) < 1e-9);

    const mk = (n) => ({ slots: { night: { n, w: n * 20, s: n * 20 * 0.8 }, morning: { n: 0, w: 0, s: 0 } }, all: { n, nr: n, r2: n * (0.05 ** 2 + cfg.obs_noise ** 2) } });
    const few = estimate(mk(2), cfg), many = estimate(mk(400), cfg);
    // 個人值 0.8：2 筆幾乎沒動，400 筆幾乎到位
    assert.ok(few.slots.night.mu < 0.5, `少 ${few.slots.night.mu.toFixed(2)}`);   // 離個人值 0.8 還很遠，較靠近先驗 0.2
    assert.ok(Math.abs(many.slots.night.mu - 0.8) < 0.03, `多 ${many.slots.night.mu.toFixed(2)}`);
    assert.ok(few.slots.night.mu < many.slots.night.mu);
    // 起伏 σ 也是：樣本多時接近個人值 0.05（不低於下限）
    assert.ok(Math.abs(many.sigma - 0.05) < 0.02, `σ ${many.sigma.toFixed(3)}`);
    assert.ok(few.sigma > many.sigma);
    // 時段沒資料 → 退回使用者整體平均（不是先驗）
    assert.ok(Math.abs(many.slots.morning.mu - many.overall) < 1e-9);
});

test('OU 慣性：相隔很近的觀測幾乎不提供基準資訊；相隔很久才等同獨立觀測', () => {
    const st = { x: 0.8, p: 0.01, t: 0 };
    const near = kalmanStep(st, 0.8, 5 * 60000, 0.2, 0.1, 6, 0.07);
    const far = kalmanStep(st, 0.8, 48 * 3600000, 0.2, 0.1, 6, 0.07);
    assert.ok(!near.muObs || near.muObs.w < far.muObs.w / 20);
    assert.ok(Math.abs(far.muObs.m - 0.8) < 0.01);   // 隔兩天：把觀測當成對基準的直接證據
    // 5 分鐘後，狀態幾乎不動
    assert.ok(Math.abs(near.x - 0.8) < 0.01);
});

test('短句（扣底噪後八維全 ≤ 0）不更新狀態與統計；有內容的句子才更新', () => {
    const t = boot('emo_short');
    try {
        const { db, emotion, frag } = t;
        const quiet = Object.fromEntries(emotion.DIMS.map(d => [d, 0.15]));   // 「好啊」：每維 0.1～0.2
        const a = frag({ content: '好啊', emotions: quiet, raisedAt: '2026-05-01 10:00:00' });
        const b = frag({ content: '嗯嗯', emotions: { ...quiet, joy: 0.2 }, raisedAt: '2026-05-01 10:05:00' });   // 剛好等於底噪
        const r = emotion.processFragments(db, [a, b]);
        assert.deepEqual(r.map(x => x.informative), [false, false]);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_state').get().c, 0);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_baseline_stats').get().c, 0);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_events WHERE informative = 0').get().c, 2);
        assert.equal(emotion.getBaselineStatus(db).samples, 0);

        const c = frag({ content: '今天被主管罵了', emotions: { anger: 0.7, sadness: 0.5 }, raisedAt: '2026-05-01 11:00:00' });
        const r2 = emotion.processFragments(db, [c]);
        assert.equal(r2[0].informative, true);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_state').get().c, 8);
        assert.equal(emotion.getBaselineStatus(db).samples, 1);
        // 重複處理同一條不會重複計數
        emotion.processFragments(db, [c]);
        assert.equal(emotion.getBaselineStatus(db).samples, 1);
    } finally { t.restore(); t.cleanup(); }
});

test('有效樣本不足標示「學習中」，滿門檻後解除；重放結果與線上一致', () => {
    const t = boot('emo_learning');
    try {
        const { db, emotion, frag } = t;
        const ids = [];
        for (let i = 0; i < 52; i++) {
            const h = 1 + Math.floor(i / 4) * 5 % 24;
            ids.push(frag({ content: `事${i}`, emotions: { sadness: 0.4 + (i % 5) * 0.05 }, raisedAt: `2026-04-${String(1 + Math.floor(i / 4)).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00` }));
        }
        emotion.processFragments(db, ids.slice(0, 10));
        let st = emotion.getBaselineStatus(db);
        assert.equal(st.learning, true);
        assert.equal(st.samples, 10);
        assert.equal(db.prepare('SELECT MAX(learning) m FROM emotion_events').get().m, 1);
        emotion.processFragments(db, ids.slice(10));
        st = emotion.getBaselineStatus(db);
        assert.equal(st.learning, false);
        assert.equal(st.samples, 52);
        const online = JSON.stringify(st.dims.sadness);
        emotion.rebuildEmotionState(db);
        assert.equal(JSON.stringify(emotion.getBaselineStatus(db).dims.sadness), online);
        // 悲傷基準已經學到高於預設先驗
        assert.ok(st.dims.sadness.baseline > cfg.prior_mu + 0.1);
    } finally { t.restore(); t.cleanup(); }
});
