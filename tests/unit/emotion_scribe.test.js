// G2：Scribe 解析八維情緒與 event_at、範圍檢查、缺值、底噪、raised_at、enabled=false 不影響既有行為。
// LLM / Chroma / Librarian 全部 stub。
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `emotion_scribe_${process.pid}_${Date.now()}.db`);
process.env.SANCTUARY_ENCRYPTION_KEY = '0'.repeat(64);

const llm = require('../../services/llm');
const memory = require('../../services/memory');
let llmEntries = [];
let lastSystemPrompt = '';
llm.callLLM = async (_msgs, systemPrompt) => {
    lastSystemPrompt = systemPrompt;
    return { reply: JSON.stringify({ entries: llmEntries, fulfilled_intention_ids: [] }) };
};
memory.chromaDBOperation = async () => { throw new Error('ECONNREFUSED (stub)'); };
const libPath = require.resolve('../../services/librarian');
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { searchHybrid: async () => [] } };

const { initDatabase, getDb } = require('../../database');
initDatabase();
const db = getDb();
const { runScribe } = require('../../services/scribe');
const emotion = require('../../services/emotion');

let nextId = 1;
const msg = (sender, content, ts) => ({ id: nextId++, sender, content, timestamp: ts, message_type: 'text', is_encrypted: 0 });
let seq = 0;
const entry = (over = {}) => {
    seq++;
    return {
        type: 'observation', entities: [{ name: `G2實體${seq}`, relation: 'related_to' }],
        content: `G2實體${seq}的事`, emotional_weight: 0.4, value_tags: [], source: 'chat', quote: '今天主管當眾罵我', ...over,
    };
};
const EIGHT = (o = {}) => ({ joy: 0.1, trust: 0.1, fear: 0.3, surprise: 0.2, sadness: 0.5, disgust: 0.2, anger: 0.9, anticipation: 0.1, ...o });
async function run(entries, msgs) {
    llmEntries = entries;
    return runScribe(msgs, msgs[msgs.length - 1].timestamp);
}
const row = (id) => db.prepare('SELECT * FROM memory_fragments WHERE id = ?').get(id);
const lastRow = () => db.prepare('SELECT * FROM memory_fragments ORDER BY id DESC LIMIT 1').get();
const M = () => [msg('user', '今天主管當眾罵我', '2026-05-01 15:30:00')];   // UTC 15:30 = 台北 23:30（深夜）

test.afterEach(() => emotion._setOverride(null));

test('八維與 event_at：解析、扣底噪、衍生 intensity / valence，emotional_weight 改由 intensity 填入', async () => {
    const r = await run([entry({ emotions: EIGHT(), event_at: '2026-06-15' })], M());
    assert.equal(r.written, 1);
    const f = lastRow();
    assert.equal(f.emo_anger, 0.9);
    assert.equal(f.emo_joy, 0.1);
    assert.ok(Math.abs(f.intensity - 0.7) < 1e-9);                       // 0.9 − 0.2
    // valence = (喜悅+信任+期待) − (悲傷+恐懼+憤怒+厭惡)，各維先扣 0.2：0 − (0.3+0.1+0.7+0) = −1.1 → 夾到 −1
    assert.equal(f.valence, -1);
    assert.ok(Math.abs(f.emotional_weight - 0.7) < 1e-9);
    assert.equal(f.emotion_conf, 1);
    assert.equal(f.event_at, '2026-06-15');
    assert.equal(f.raised_at, '2026-05-01 15:30:00');
    assert.equal(f.raised_slot, 'night');        // 台北 23:30
    assert.equal(f.tz, 'Asia/Taipei');
    assert.equal(f.weekday, 5);                  // 台北 2026-05-01 23:30 是週五
});

test('valence 不夾住時的正常值：喜悅 0.8、期待 0.6 → 0.6 + 0.4 = 1.0 → 夾到 1；混合情緒保留符號', async () => {
    await run([entry({ emotions: EIGHT({ joy: 0.5, anticipation: 0.4, anger: 0.1, sadness: 0.1, fear: 0.1, disgust: 0.1 }) })], M());
    const f = lastRow();
    assert.ok(Math.abs(f.valence - (0.3 + 0.2)) < 1e-9);   // 正 0.5、負 0
});

test('範圍檢查與缺值：超出範圍夾住、字串數字接受、非數字與未知鍵略過、缺的維度補 0、中文鍵接受', async () => {
    await run([entry({ emotions: { joy: 5, sadness: -3, anger: '0.7', fear: 'abc', 悲傷: 0.9, foo: 1, trust: null } })], M());
    const f = lastRow();
    assert.equal(f.emo_joy, 1);
    assert.equal(f.emo_anger, 0.7);
    assert.equal(f.emo_fear, 0);
    assert.equal(f.emo_trust, 0);
    assert.equal(f.emo_sadness, 0.9);            // 中文鍵「悲傷」後寫入，蓋過 −3
    assert.equal(f.emo_disgust, 0);              // 缺 → 0
    assert.ok(f.emotion_conf > 0 && f.emotion_conf < 1);   // 只有 4 個維度有效 → 信心下調
    for (const c of ['emo_joy', 'emo_trust', 'emo_fear', 'emo_surprise', 'emo_sadness', 'emo_disgust', 'emo_anger', 'emo_anticipation']) {
        assert.ok(f[c] >= 0 && f[c] <= 1, c);
    }
});

test('稀疏輸出：只列高於底噪的維度，{} = 沒有明顯情緒（全 0、信心 1）；有鍵但全不認得 → 視為沒給', async () => {
    await run([entry({ emotions: { anger: 0.8 } })], M());
    let f = lastRow();
    assert.equal(f.emo_anger, 0.8);
    assert.equal(f.emo_joy, 0);
    assert.equal(f.emotion_conf, 1);
    assert.ok(Math.abs(f.intensity - 0.6) < 1e-9);
    await run([entry({ emotions: {} })], M());
    f = lastRow();
    assert.equal(f.emo_anger, 0);
    assert.equal(f.intensity, 0);
    assert.equal(f.emotion_conf, 1);
    assert.equal(f.emotional_weight, 0.1);
    await run([entry({ emotions: { foo: 1, bar: 'x' }, emotional_weight: 0.5 })], M());
    f = lastRow();
    assert.equal(f.intensity, null);
    assert.equal(f.emotional_weight, 0.5);
    await run([entry({ emotions: [0.5, 0.5] })], M());
    assert.equal(lastRow().intensity, null);
});

test('event_at：沒有時間性的類型（偏好、個人資料、反思）即使模型填了日期也丟掉；事件類保留', async () => {
    for (const type of ['preference', 'fact', 'entity_new', 'reflection']) {
        await run([entry({ type, emotions: EIGHT(), event_at: '2026-05-01' })], M());
        assert.equal(lastRow().event_at, null, type);
    }
    for (const type of ['event', 'intention', 'state']) {
        await run([entry({ type, emotions: EIGHT(), event_at: '2026-05-01' })], M());
        assert.equal(lastRow().event_at, '2026-05-01', type);
    }
});

test('event_at：無效值（不存在的日期、相對詞、非字串）→ null；YYYY-MM 保留', async () => {
    for (const bad of ['2026-02-30', '明天', 20260615, null, '', '2026-13-01']) {
        await run([entry({ emotions: EIGHT(), event_at: bad })], M());
        assert.equal(lastRow().event_at, null, String(bad));
    }
    await run([entry({ emotions: EIGHT(), event_at: '2026-06' })], M());
    assert.equal(lastRow().event_at, '2026-06');
    await run([entry({ emotions: EIGHT(), event_at: '2026-06-15T09:00:00' })], M());
    assert.equal(lastRow().event_at, '2026-06-15');
});

test('模型沒給 emotions：情緒欄位維持 NULL、emotional_weight 沿用模型給的分數；時間欄位仍會寫', async () => {
    await run([entry({ emotional_weight: 0.55 })], M());
    const f = lastRow();
    assert.equal(f.emo_joy, null);
    assert.equal(f.intensity, null);
    assert.equal(f.emotional_weight, 0.55);
    assert.equal(f.raised_slot, 'night');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_events WHERE fragment_id = ?').get(f.id).c, 0);
});

test('底噪：短句那種每維 0.1～0.2 → intensity 0、emotional_weight 取下限 0.1，且被判無資訊不更新狀態', async () => {
    const before = emotion.getBaselineStatus(db).samples;
    await run([entry({ emotions: EIGHT({ joy: 0.2, trust: 0.15, fear: 0.1, surprise: 0.1, sadness: 0.1, disgust: 0.1, anger: 0.2, anticipation: 0.15 }) })], M());
    const f = lastRow();
    assert.equal(f.intensity, 0);
    assert.equal(f.valence, 0);
    assert.equal(f.emotional_weight, 0.1);
    assert.equal(f.emo_joy, 0.2);                 // 原始分數保留
    assert.equal(db.prepare('SELECT informative FROM emotion_events WHERE fragment_id = ?').get(f.id).informative, 0);
    assert.equal(emotion.getBaselineStatus(db).samples, before);
});

test('raised_at：取「含 quote 的來源訊息」中最早一則；quote 在兩則都出現取較早', async () => {
    const msgs = [
        msg('user', '早安', '2026-05-01 00:10:00'),
        msg('user', '今天主管當眾罵我', '2026-05-01 03:00:00'),
        msg('ai', '聽起來很難受', '2026-05-01 03:01:00'),
        msg('user', '今天主管當眾罵我，我真的很氣', '2026-05-01 04:00:00'),
    ];
    await run([entry({ emotions: EIGHT() })], msgs);
    assert.equal(lastRow().raised_at, '2026-05-01 03:00:00');
    assert.equal(lastRow().raised_slot, 'noon');      // UTC 03:00 = 台北 11:00
});

test('emotion.timezone 換算時段：同一瞬間設成紐約則落在不同時段', async () => {
    emotion._setOverride({ timezone: 'America/New_York' });
    await run([entry({ emotions: EIGHT() })], M());   // UTC 15:30 → 紐約 11:30（夏令）
    const f = lastRow();
    assert.equal(f.raised_slot, 'noon');
    assert.equal(f.tz, 'America/New_York');
});

test('階段 B：Scribe 結束後已更新個人基準並記錄轉折', async () => {
    const before = emotion.getBaselineStatus(db).samples;
    const r = await run([entry({ emotions: EIGHT({ disgust: 0.95 }) })], M());   // 前面的測試已把憤怒學成常態，換一個沒學過的維度
    assert.equal(r.written, 1);
    const f = lastRow();
    const ev = db.prepare('SELECT * FROM emotion_events WHERE fragment_id = ?').get(f.id);
    assert.equal(ev.informative, 1);
    assert.equal(emotion.getBaselineStatus(db).samples, before + 1);
    assert.ok(JSON.parse(ev.anomalies).some(a => a.dim === 'disgust'));   // 0.95 遠超過個人基準 + 2σ
    assert.ok(!JSON.parse(ev.anomalies).some(a => a.dim === 'anger'), '已學成常態的憤怒不再算轉折');
});

test('prompt：啟用時含 emotions／event_at 的欄位與規則；記錄增加的字數（估 token）', async () => {
    await run([entry({ emotions: EIGHT() })], M());
    assert.match(lastSystemPrompt, /"emotions": \{"anger": 0\.8/);
    assert.match(lastSystemPrompt, /"event_at"/);
    assert.match(lastSystemPrompt, /## emotions 與 event_at/);
    const added = emotion.prompt.FIELDS.length + emotion.prompt.RULES.length;
    console.log(`[G2] Scribe prompt 增加 ${added} 字（約 ${Math.ceil(added / 1.6)} token，中文 1 字約 0.6~1 token）`);
    assert.ok(added < 900);
});

test('emotion.enabled=false：prompt 不含情緒段落、不寫情緒／時間欄位、不動狀態，其餘行為照舊', async () => {
    emotion._setOverride({ enabled: false });
    const before = emotion.getBaselineStatus(db).samples;
    const r = await run([entry({ emotions: EIGHT(), event_at: '2026-06-15', emotional_weight: 0.42 })], M());
    assert.equal(r.written, 1);
    assert.doesNotMatch(lastSystemPrompt, /emotions/);
    assert.doesNotMatch(lastSystemPrompt, /event_at/);
    assert.doesNotMatch(lastSystemPrompt, /\{EMOTION/);
    const f = lastRow();
    assert.equal(f.emotional_weight, 0.42);
    for (const c of ['emo_joy', 'emo_anger', 'intensity', 'valence', 'raised_at', 'event_at', 'raised_slot', 'weekday', 'tz']) assert.equal(f[c], null, c);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_events WHERE fragment_id = ?').get(f.id).c, 0);
    assert.equal(emotion.getBaselineStatus(db).samples, before);
    assert.equal(emotion.processFragments(db).length, 0);
});
