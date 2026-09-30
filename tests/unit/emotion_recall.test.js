// G2：週年日查詢、事件預期與回顧、情緒褪色、查詢 API（需登入）
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { boot } = require('./_emotion_helpers');
const { listenSafe } = require('./_helpers');
const { effectiveIntensity, halfLifeDays } = require('../../services/emotion/fading');

test('週年日：過去同月同日的事件（event_at）與被提出的話題（raised_at，依當地日期），附當時情緒', () => {
    const t = boot('emo_anniv');
    try {
        const { db, emotion, frag } = t;
        // 阿嬤過世：事件日 2025-03-14，當時提出（台北 3/14 深夜 = UTC 3/14 15:30）
        frag({ content: '阿嬤走了', entities: ['阿嬤'], emotions: { sadness: 0.95, fear: 0.4 }, raisedAt: '2025-03-14 15:30:00', eventAt: '2025-03-14' });
        // 去年同日被提出的別件事（UTC 3/13 18:00 = 台北 3/14 02:00：UTC 日期差一天，當地才是 3/14）
        frag({ content: '半夜睡不著', entities: [], emotions: { sadness: 0.5 }, raisedAt: '2025-03-13 18:00:00' });
        // 今年（不算）與不同日（不算）與只有月份的 event_at（不算）
        frag({ content: '今年', entities: [], emotions: { joy: 0.9 }, raisedAt: '2026-03-14 02:00:00', eventAt: '2026-03-14' });
        frag({ content: '隔天', entities: [], emotions: { joy: 0.9 }, raisedAt: '2025-03-15 02:00:00', eventAt: '2025-03-15' });
        frag({ content: '只有月份', entities: [], emotions: { joy: 0.9 }, raisedAt: '2024-05-01 02:00:00', eventAt: '2024-03' });
        // 兩年前的同日事件
        frag({ content: '兩年前旅行', entities: [], emotions: { joy: 0.8, anticipation: 0.6 }, raisedAt: '2024-03-01 02:00:00', eventAt: '2024-03-14' });

        const r = emotion.getAnniversaries(db, '2026-03-14');
        const by = (c) => r.filter(x => x.content === c);
        assert.equal(by('阿嬤走了').length, 2);                   // 同時是 event 與 raised（去重鍵含 kind）
        assert.deepEqual(by('阿嬤走了').map(x => x.kind).sort(), ['event', 'raised']);
        assert.equal(by('阿嬤走了')[0].years_ago, 1);
        assert.ok(by('阿嬤走了')[0].emotions.sadness > 0.9);
        assert.ok(by('阿嬤走了')[0].intensity > 0.7 && by('阿嬤走了')[0].valence < 0);
        assert.equal(by('半夜睡不著').length, 1);                 // 依當地日期比對到
        assert.equal(by('半夜睡不著')[0].kind, 'raised');
        assert.equal(by('兩年前旅行')[0].years_ago, 2);
        for (const c of ['今年', '隔天', '只有月份']) assert.equal(by(c).length, 0, c);
        assert.equal(r[0].content, '阿嬤走了');                   // 依強度排序
        // 內容經過加密欄位也能取回明文
        assert.ok(r.every(x => typeof x.content === 'string' && !x.content.startsWith('enc:')));
        // Date 物件、其他日子
        assert.equal(emotion.getAnniversaries(db, new Date('2026-03-14T04:00:00Z')).length, r.length);   // 台北 3/14 12:00
        assert.equal(emotion.getAnniversaries(db, '2026-07-01').length, 0);
        // 只回 active
        db.prepare("UPDATE memory_fragments SET status = 'archived' WHERE content IS NOT NULL").run();
        assert.equal(emotion.getAnniversaries(db, '2026-03-14').length, 0);
    } finally { t.restore(); t.cleanup(); }
});

test('事件預期與回顧：事件日前累積期待／恐懼，之後記錄實際反應與落差', () => {
    const t = boot('emo_arc');
    try {
        const { db, emotion, frag } = t;
        // 東京旅行 2026-06-15：出發前期待＋緊張，回來後回顧
        frag({ content: '下個月要去東京', emotions: { anticipation: 0.8, fear: 0.3 }, raisedAt: '2026-05-10 02:00:00', eventAt: '2026-06-15' });
        frag({ content: '行李還沒收', emotions: { anticipation: 0.9, fear: 0.5 }, raisedAt: '2026-06-10 02:00:00', eventAt: '2026-06-15' });
        frag({ content: '東京玩得超開心', emotions: { joy: 0.9, anticipation: 0.3, fear: 0.1 }, raisedAt: '2026-06-18 02:00:00', eventAt: '2026-06-15' });
        // 只有事前：尚未發生
        frag({ content: '下週面試', emotions: { fear: 0.8, anticipation: 0.5 }, raisedAt: '2026-06-20 02:00:00', eventAt: '2026-06-25' });
        const arcs = emotion.getEventArcs(db);
        const tokyo = arcs.find(a => a.event_at === '2026-06-15');
        assert.equal(tokyo.fragments_before, 2);
        assert.equal(tokyo.fragments_after, 1);
        assert.ok(tokyo.expected.anticipation > 0.8);
        assert.ok(tokyo.expected.fear > 0.35);
        assert.ok(tokyo.actual.joy > 0.85);
        assert.ok(tokyo.delta.joy > 0.5 && tokyo.delta.fear < 0);      // 比預期開心、比預期不怕
        const interview = arcs.find(a => a.event_at === '2026-06-25');
        assert.equal(interview.fragments_after, 0);
        assert.equal(interview.actual, null);
        assert.equal(interview.delta, null);
        assert.equal(emotion.getEventArcs(db, { since: '2026-06-20' }).length, 1);
    } finally { t.restore(); t.cleanup(); }
});

test('情緒褪色：同樣強度，負面褪得比正面快；原始分數不動', () => {
    const now = '2026-06-01 00:00:00';
    const neg = { intensity: 0.8, valence: -0.6, raised_at: '2026-04-02 00:00:00' };   // 60 天前
    const pos = { intensity: 0.8, valence: 0.6, raised_at: '2026-04-02 00:00:00' };
    assert.ok(Math.abs(effectiveIntensity(neg, now) - 0.4) < 0.01);      // 負面半衰期 60 天
    assert.ok(Math.abs(effectiveIntensity(pos, now) - 0.8 * Math.pow(0.5, 60 / 120)) < 0.01);
    assert.ok(effectiveIntensity(pos, now) > effectiveIntensity(neg, now));
    assert.equal(neg.intensity, 0.8);
    // 半衰期：負 60、正 120、中間線性
    assert.equal(halfLifeDays(-1), 60);
    assert.equal(halfLifeDays(1), 120);
    assert.equal(halfLifeDays(0), 90);
    // 剛發生 = 原始強度；沒有情緒資料 = null（呼叫端沿用 emotional_weight）；沒有時間退回 created_at
    assert.equal(effectiveIntensity({ intensity: 0.7, valence: -1, raised_at: now }, now), 0.7);
    assert.equal(effectiveIntensity({ intensity: null }, now), null);
    assert.ok(Math.abs(effectiveIntensity({ intensity: 0.8, valence: -1, created_at: '2026-04-02 00:00:00' }, now) - 0.4) < 0.01);
    // 未來時間（時鐘誤差）不放大
    assert.equal(effectiveIntensity({ intensity: 0.5, valence: -1, raised_at: '2026-07-01 00:00:00' }, now), 0.5);
});

test('情緒褪色半衰期可由 emotion.* 設定', () => {
    const emotion = require('../../services/emotion');
    emotion._setOverride({ fade_half_life_neg_days: 10, fade_half_life_pos_days: 20 });
    try {
        const f = { intensity: 1, valence: -1, raised_at: '2026-05-22 00:00:00' };
        assert.ok(Math.abs(effectiveIntensity(f, '2026-06-01 00:00:00') - 0.5) < 1e-9);
    } finally { emotion._setOverride(null); }
});

// ── API ──
function serve(authenticated) {
    const app = express();
    app.use((req, _res, next) => { req.session = { authenticated }; next(); });
    app.use(require('../../routes/emotion-api'));
    const server = http.createServer(app);
    return listenSafe(server).then(() => ({
        server, get: async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual' }); return { status: r.status, body: await r.text() }; },
    }));
}

test('API：未登入擋下；登入後可查基準、實體、話題×時段、週年日、事件', async () => {
    const t = boot('emo_api');
    let s1, s2;
    try {
        const { db, emotion, frag } = t;
        const ids = [frag({ content: '主管罵人', entities: ['主管'], emotions: { anger: 0.9 }, raisedAt: '2025-03-14 02:00:00', eventAt: '2025-03-14' })];
        emotion.processFragments(db, ids);

        s1 = await serve(false);
        for (const p of ['/api/emotion/baseline', '/api/emotion/entities', '/api/emotion/topic-slots', '/api/emotion/anniversaries', '/api/emotion/events']) {
            const r = await s1.get(p);
            assert.ok(r.status === 401 || r.status === 302 || r.status === 403, `${p} → ${r.status}`);
        }

        s2 = await serve(true);
        const base = JSON.parse((await s2.get('/api/emotion/baseline')).body);
        assert.equal(base.success, true);
        assert.equal(base.learning, true);
        assert.equal(base.samples, 1);
        assert.deepEqual(Object.keys(base.dims), emotion.DIMS);
        assert.ok(base.dims.anger.slots.morning.mu > 0);
        const ents = JSON.parse((await s2.get('/api/emotion/entities?dim=anger&limit=5')).body);
        assert.equal(ents.items[0].name, '主管');
        assert.equal((await s2.get('/api/emotion/entities?dim=bogus')).status, 400);
        assert.equal(JSON.parse((await s2.get('/api/emotion/topic-slots')).body).success, true);
        const an = JSON.parse((await s2.get('/api/emotion/anniversaries?date=2026-03-14')).body);
        assert.ok(an.count >= 1);
        assert.equal((await s2.get('/api/emotion/anniversaries?date=昨天')).status, 400);
        assert.equal(JSON.parse((await s2.get('/api/emotion/events')).body).count, 1);
    } finally {
        s1?.server.close(); s2?.server.close();
        t.restore(); t.cleanup();
    }
});
