// G2：事件歸因（轉折 → 實體 × 情緒，貝氏平均、時間衰減）與話題（實體類別）× 時段分布
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./_emotion_helpers');

// 先讓使用者學會「平常」：一批中性、偶爾小起伏的碎片（不掛任何實體，避免污染歸因統計）
function seedBaseline(t, n = 30, startDay = 1) {
    const ids = [];
    for (let i = 0; i < n; i++) {
        const day = startDay + Math.floor(i / 3);
        const hour = [9, 13, 20][i % 3];
        ids.push(t.frag({
            content: `日常${i}`, entities: [],
            emotions: { joy: 0.3 + (i % 4) * 0.03, anticipation: 0.3, sadness: 0.15 },
            raisedAt: `2026-03-${String(day).padStart(2, '0')} ${String(hour - 8 < 0 ? hour + 16 : hour - 8).padStart(2, '0')}:00:00`,
        }));
    }
    t.emotion.processFragments(t.db, ids);
}

test('情緒轉折歸給該碎片連到的實體：主管 → 憤怒；同事沒轉折', () => {
    const t = boot('emo_attr');
    try {
        const { db, emotion, frag } = t;
        seedBaseline(t);
        const ids = [];
        for (let i = 0; i < 4; i++) {
            ids.push(frag({ content: `主管事件${i}`, entities: ['主管'], emotions: { anger: 0.9, sadness: 0.4 }, raisedAt: `2026-04-0${i + 1} 02:00:00` }));
            ids.push(frag({ content: `同事閒聊${i}`, entities: ['同事'], emotions: { joy: 0.3, anger: 0.15 }, raisedAt: `2026-04-0${i + 1} 04:00:00` }));
        }
        const res = emotion.processFragments(db, ids);
        assert.ok(res.filter(r => r.anomalies.some(a => a.dim === 'anger')).length >= 3, '主管碎片應被偵測出憤怒轉折');
        const list = emotion.getEntityEmotions(db, { dim: 'anger', now: '2026-04-05 00:00:00' });
        const boss = list.find(e => e.name === '主管'), mate = list.find(e => e.name === '同事');
        assert.ok(boss && mate);
        assert.equal(list[0].name, '主管');                       // 依憤怒轉折率排序
        assert.equal(boss.top, 'anger');
        assert.ok(boss.dims.anger.rate > mate.dims.anger.rate + 0.3, `${boss.dims.anger.rate} vs ${mate.dims.anger.rate}`);
        assert.ok(boss.dims.anger.lift > 1 && mate.dims.anger.lift < 1);
        assert.ok(boss.dims.anger.hits >= 3);
        assert.equal(mate.dims.anger.hits, 0);
        // 使用者本人不當歸因對象
        const { USER } = require('../../services/memoryConfig');
        assert.ok(!list.some(e => e.name === USER.name));
    } finally { t.restore(); t.cleanup(); }
});

test('貝氏平均：樣本少時向先驗收縮（1 筆轉折不會直接變 100%），樣本多才逼近實際比例', () => {
    const t = boot('emo_bayes');
    try {
        const { db, emotion, frag } = t;
        seedBaseline(t);
        const one = frag({ content: '一次', entities: ['路人甲'], emotions: { anger: 0.95 }, raisedAt: '2026-04-01 02:00:00' });
        const many = [];
        for (let i = 0; i < 12; i++) many.push(frag({ content: `多次${i}`, entities: ['路人乙'], emotions: { anger: 0.95 }, raisedAt: `2026-04-${String(1 + i).padStart(2, '0')} 02:00:00` }));
        // 一批平淡的碎片掛在別的實體上，讓「全域轉折率」維持在低處（否則兩個實體自己就拉高了先驗）
        const calm = [];
        for (let i = 0; i < 25; i++) calm.push(frag({ content: `平淡${i}`, entities: ['路人丙'], emotions: { joy: 0.35 }, raisedAt: `2026-04-${String(1 + (i % 12)).padStart(2, '0')} 0${i % 9}:30:00` }));
        emotion.processFragments(db, [one, ...many, ...calm]);
        const list = emotion.getEntityEmotions(db, { dim: 'anger', now: '2026-04-13 00:00:00' });
        const a = list.find(e => e.name === '路人甲'), b = list.find(e => e.name === '路人乙');
        assert.ok(a.dims.anger.rate < 0.75, `1 筆：${a.dims.anger.rate}`);
        assert.ok(b.dims.anger.rate > a.dims.anger.rate);
        assert.ok(b.dims.anger.rate > 0.6);
        // min_n 過濾
        assert.ok(!emotion.getEntityEmotions(db, { minN: 5, now: '2026-04-13 00:00:00' }).some(e => e.name === '路人甲'));
    } finally { t.restore(); t.cleanup(); }
});

test('時間衰減：半衰期 30 天，60 天後的統計是原來的 1/4；查詢時間往後拉，轉折率回落到先驗', () => {
    const t = boot('emo_decay');
    try {
        const { db, emotion, frag } = t;
        seedBaseline(t);
        const ids = [];
        for (let i = 0; i < 4; i++) ids.push(frag({ content: `衝突${i}`, entities: ['前任'], emotions: { anger: 0.9 }, raisedAt: `2026-04-0${i + 1} 02:00:00` }));
        emotion.processFragments(db, ids);
        const at = (now) => emotion.getEntityEmotions(db, { dim: 'anger', now }).find(e => e.name === '前任');
        const fresh = at('2026-04-04 02:00:00');
        const d30 = at('2026-05-04 02:00:00');
        const d60 = at('2026-06-03 02:00:00');
        const far = at('2028-04-04 02:00:00');
        assert.ok(Math.abs(d30.dims.anger.n / fresh.dims.anger.n - 0.5) < 0.01, `30 天 ${d30.dims.anger.n / fresh.dims.anger.n}`);
        assert.ok(Math.abs(d60.dims.anger.n / fresh.dims.anger.n - 0.25) < 0.01);
        assert.ok(Math.abs(d30.dims.anger.hits / fresh.dims.anger.hits - 0.5) < 0.01);
        assert.ok(fresh.dims.anger.rate > d30.dims.anger.rate && d30.dims.anger.rate > d60.dims.anger.rate);
        assert.ok(far.dims.anger.n < 0.001);
        assert.ok(Math.abs(far.dims.anger.rate - 0.1) < 0.02);   // 衰減殆盡 → 全域先驗（attribution_prior_rate）
    } finally { t.restore(); t.cleanup(); }
});

test('衰減半衰期可設定；亂序（較舊的碎片後處理）與依序處理結果一致', () => {
    const t = boot('emo_order');
    try {
        const { db, emotion, frag } = t;
        seedBaseline(t);
        const a = frag({ content: 'A', entities: ['某人'], emotions: { anger: 0.9 }, raisedAt: '2026-04-01 02:00:00' });
        const b = frag({ content: 'B', entities: ['某人'], emotions: { anger: 0.9 }, raisedAt: '2026-04-11 02:00:00' });
        emotion.processFragments(db, [b]);
        emotion.processFragments(db, [a]);
        const n1 = emotion.getEntityEmotions(db, { dim: 'anger', now: '2026-05-11 02:00:00' })[0].dims.anger.n;
        // 理論值：B 距今 30 天（×0.5）＋ A 距今 40 天（×0.5^(40/30)）
        assert.ok(Math.abs(n1 - (0.5 + Math.pow(0.5, 40 / 30))) < 0.01, `${n1}`);
        emotion._setOverride({ attribution_half_life_days: 10 });
        const n2 = emotion.getEntityEmotions(db, { dim: 'anger', now: '2026-05-11 02:00:00' })[0].dims.anger.n;
        emotion._setOverride(null);
        assert.ok(n2 < n1 / 3);
    } finally { t.restore(); t.cleanup(); }
});

test('話題（實體類別）× 時段的情緒分布', () => {
    const t = boot('emo_topic');
    try {
        const { db, emotion, frag, ent } = t;
        ent('公司甲', 'company'); ent('阿明', 'person');
        const ids = [
            // 台北 09:30、10:00 → 早上，工作類
            frag({ content: 'w1', entities: ['公司甲'], emotions: { sadness: 0.8 }, raisedAt: '2026-04-01 01:30:00' }),
            frag({ content: 'w2', entities: ['公司甲'], emotions: { sadness: 0.6 }, raisedAt: '2026-04-02 02:00:00' }),
            // 台北 20:00 → 晚上，人物類
            frag({ content: 'p1', entities: ['阿明'], emotions: { joy: 0.9 }, raisedAt: '2026-04-01 12:00:00' }),
            // 同一條碎片連到兩個同類別實體只算一次
            frag({ content: 'p2', entities: ['阿明', '阿華'], emotions: { joy: 0.5 }, raisedAt: '2026-04-02 12:30:00' }),
        ];
        emotion.processFragments(db, ids);
        const d = emotion.getTopicSlotDistribution(db, { now: '2026-04-02 13:00:00' });
        assert.ok(d.company.morning.mean.sadness > d.company.morning.mean.joy);
        assert.equal(d.company.morning.label, '早上');
        assert.ok(d.company.morning.n > 1.9 && d.company.morning.n <= 2);
        assert.ok(!d.company.evening);
        assert.ok(d.person.evening.mean.joy > d.person.evening.mean.sadness);
        assert.ok(d.person.evening.n > 1.9 && d.person.evening.n <= 2, `${d.person.evening.n}`);
        assert.ok(Math.abs(d.company.morning.mean.sadness - 0.5) < 0.05);   // (0.6 + 0.4)/2：底噪已扣
    } finally { t.restore(); t.cleanup(); }
});

test('重放：連結晚於處理時（實體後來才解析出來）可用 rebuildEmotionState 補歸因', () => {
    const t = boot('emo_rebuild');
    try {
        const { db, emotion, frag, ent } = t;
        const id = frag({ content: '尚未連結', entities: [], emotions: { anger: 0.9 }, raisedAt: '2026-04-01 02:00:00' });
        emotion.processFragments(db, [id]);
        assert.equal(emotion.getEntityEmotions(db).length, 0);
        db.prepare('INSERT INTO fragment_entities (fragment_id, entity_id, relation) VALUES (?, ?, ?)').run(id, ent('遲到的實體'), 'related_to');
        emotion.rebuildEmotionState(db);
        assert.equal(emotion.getEntityEmotions(db)[0].name, '遲到的實體');
    } finally { t.restore(); t.cleanup(); }
});
