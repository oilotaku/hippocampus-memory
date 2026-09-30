// W5：Scribe 原话佐证 + 跨天去重。LLM / Chroma / Librarian 全部 stub，不连网。
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `scribe_quality_${process.pid}_${Date.now()}.db`);
process.env.SANCTUARY_ENCRYPTION_KEY = '0'.repeat(64);

const llm = require('../../services/llm');
const memory = require('../../services/memory');
let llmEntries = [];
llm.callLLM = async () => ({ reply: JSON.stringify({ entries: llmEntries, fulfilled_intention_ids: [] }) });
let chromaMode = 'down';  // 'down' 抛错；'ok' 回空
let chromaCalls = 0;
memory.chromaDBOperation = async () => {
    chromaCalls++;
    if (chromaMode === 'down') throw new Error('ECONNREFUSED (stub)');
    return { duplicates: [] };
};
// 免去 Librarian 的向量检索
const libPath = require.resolve('../../services/librarian');
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { searchHybrid: async () => [] } };

const { initDatabase, getDb } = require('../../database');
initDatabase();
const db = getDb();
const { runScribe } = require('../../services/scribe');
const Q = require('../../services/scribeQuality');

let nextId = 1;
const msg = (sender, content, ts) => ({
    id: nextId++, sender, content, timestamp: ts, message_type: 'text', is_encrypted: 0,
});
const T1 = '2026-05-01 10:00:00';

async function run(entries, msgs, since) {
    llmEntries = entries;
    return runScribe(msgs, since || msgs[msgs.length - 1].timestamp);
}
const entry = (over) => ({
    type: 'fact', entities: [{ name: '小明', relation: 'related_to' }],
    content: '小明住在台北', emotional_weight: 0.2, value_tags: [], source: 'chat', ...over,
});
const rows = (ent) => db.prepare(`SELECT * FROM memory_fragments WHERE entity = ? ORDER BY id`).all(ent);

test('DB migration 105/106 建出 quote / evidence_count 欄位', () => {
    const cols = db.prepare('PRAGMA table_info(memory_fragments)').all().map(c => c.name);
    assert.ok(cols.includes('quote'));
    assert.ok(cols.includes('evidence_count'));
});

test('quote 在用户消息中 → 保留并存入 quote', async () => {
    const ent = 'Q保留';
    const r = await run([entry({ entities: [{ name: ent }], content: `${ent}住在台北`, quote: '我住在台北 ，很喜歡。' })],
        [msg('user', '最近我住在台北，很喜歡這裡', T1), msg('ai', '真好', T1)]);
    assert.strictEqual(r.written, 1);
    const f = rows(ent);
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].quote, '我住在台北 ，很喜歡。');
    assert.strictEqual(f[0].evidence_count, 1);
});

test('quote 被竄改一字 → 丢弃', async () => {
    const ent = 'Q竄改';
    const r = await run([entry({ entities: [{ name: ent }], content: `${ent}住在台北`, quote: '我住在台南，很喜歡' })],
        [msg('user', '最近我住在台北，很喜歡這裡', T1)]);
    assert.strictEqual(r.written, 0);
    assert.strictEqual(r.quoteDropped, 1);
    assert.deepStrictEqual(r.quoteDroppedByType, { fact: 1 });
    assert.strictEqual(rows(ent).length, 0);
});

test('quote 只在 AI 消息中但 entry 是一般型 → 丢弃', async () => {
    const ent = 'Q只有AI';
    const r = await run([entry({ entities: [{ name: ent }], content: `${ent}養了一隻貓`, quote: '你養了一隻貓對吧' })],
        [msg('user', '晚安', T1), msg('ai', '你養了一隻貓對吧', T1)]);
    assert.strictEqual(r.written, 0);
    assert.strictEqual(rows(ent).length, 0);
});

test('一般型即使标 quote_from=ai（type 不在观察型）→ 丢弃', async () => {
    const ent = 'Q假AI';
    const r = await run([entry({ entities: [{ name: ent }], content: `${ent}有病`, quote: '你生病了吧', quote_from: 'ai' })],
        [msg('user', '晚安', T1), msg('ai', '你生病了吧', T1)]);
    assert.strictEqual(r.written, 0);
});

test('AI 观察型且 quote 在 AI 消息 → 保留', async () => {
    const ent = 'Q觀察';
    const r = await run([entry({ type: 'observation', quote_from: 'ai', entities: [{ name: ent }],
        content: `${ent}語氣帶著委屈`, quote: '你語氣裡帶著委屈' })],
        [msg('user', '沒事啦', T1), msg('ai', '我聽得出來，你語氣裡帶著委屈。', T1)]);
    assert.strictEqual(r.written, 1);
    assert.strictEqual(rows(ent).length, 1);
});

test('缺 quote → 丢弃', async () => {
    const ent = 'Q缺';
    const r = await run([entry({ entities: [{ name: ent }], content: `${ent}住在台北` }),
        entry({ entities: [{ name: ent }], content: `${ent}住在台北A`, quote: '   ' })],
        [msg('user', '我住在台北', T1)]);
    assert.strictEqual(r.written, 0);
    assert.strictEqual(r.quoteDropped, 2);
});

test('全形/大小写/标点差异的 quote 仍算逐字（正规化）', async () => {
    const ent = 'Q正規';
    const r = await run([entry({ entities: [{ name: ent }], content: `${ent}用ＡＢＣ`, quote: 'i use abc app' })],
        [msg('user', 'I  USE ＡＢＣ，app!', T1)]);
    assert.strictEqual(r.written, 1);
});

test('跨天完全相同 → 只留一条，evidence_count 与 confidence 增加', async () => {
    const ent = 'D跨天';
    const e = () => entry({ entities: [{ name: ent }], content: `${ent}對花生過敏`, quote: '我對花生過敏' });
    await run([e()], [msg('user', '我對花生過敏', '2026-05-01 10:00:00')]);
    const before = rows(ent);
    assert.strictEqual(before.length, 1);
    const conf0 = before[0].confidence ?? 0.5;
    const r = await run([e()], [msg('user', '我對花生過敏喔', '2026-05-03 09:00:00')]);
    assert.strictEqual(r.written, 0);
    assert.strictEqual(r.evidenceMerged, 1);
    const after = rows(ent);
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].evidence_count, 2);
    assert.ok(Math.abs(after[0].confidence - (conf0 + 0.05)) < 1e-9);
    assert.strictEqual(after[0].last_accessed_at, before[0].last_accessed_at);
    // 再来一次，且标点/空白不同也算重复；confidence 上限 1.0
    db.prepare('UPDATE memory_fragments SET confidence = 0.99 WHERE id = ?').run(after[0].id);
    await run([entry({ entities: [{ name: ent }], content: `${ent} 對花生過敏。`, quote: '對花生過敏' })],
        [msg('user', '我對花生過敏', '2026-05-05 09:00:00')]);
    const fin = rows(ent);
    assert.strictEqual(fin.length, 1);
    assert.strictEqual(fin[0].evidence_count, 3);
    assert.strictEqual(fin[0].confidence, 1.0);
});

test('同一批消息重跑不重复累加证据', async () => {
    const ent = 'D重跑';
    const ms = [msg('user', '我養了一隻叫豆豆的狗', '2026-06-01 10:00:00')];
    const e = () => entry({ entities: [{ name: ent }], content: `${ent}養了一隻叫豆豆的狗`, quote: '我養了一隻叫豆豆的狗' });
    await run([e()], ms);
    await run([e()], ms);
    const f = rows(ent);
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].evidence_count, 1);
});

// 誘餌：嵌入相似度 0.9+，但是是不同事實，绝不可合并
const DECOYS = [
    ['週三/週五', '每週三打羽球', '每週五打羽球'],
    ['貓/狗', '小橘是一隻貓', '小橘是一隻狗'],
    ['高雄/台北', '弟弟現在住在高雄', '弟弟現在住在台北'],
    ['日文/韓文', '最近開始學日文', '最近開始學韓文'],
    ['十月八日/十月九日', '演唱會在十月八日', '演唱會在十月九日'],
    ['长句末尾换词', '小橘是我去年在巷口撿回來養了很久的那隻貓', '小橘是我去年在巷口撿回來養了很久的那隻狗'],
    ['阿拉伯数字', '我每天跑5公里', '我每天跑8公里'],
];
for (const [name, a, b] of DECOYS) {
    test(`誘餌不可合併：${name}`, async () => {
        const ent = `X${name}`;
        const ms1 = [msg('user', a, '2026-07-01 10:00:00')];
        const ms2 = [msg('user', b, '2026-07-02 10:00:00')];
        await run([entry({ entities: [{ name: ent }], content: `${ent}：${a}`, quote: a })], ms1);
        const r = await run([entry({ entities: [{ name: ent }], content: `${ent}：${b}`, quote: b })], ms2);
        assert.strictEqual(r.written, 1, '第二条必须写入');
        const f = rows(ent);
        assert.strictEqual(f.length, 2);
        assert.ok(f.every(x => x.evidence_count === 1));
    });
}

test('isNearDuplicate：纯标点/空白/全形差异 = 重复；不同事实 ≠ 重复', () => {
    assert.ok(Q.isNearDuplicate('小明住在台北。', '小明 住在台北'));
    assert.ok(Q.isNearDuplicate('Jason 喜歡 iPhone', 'jason喜歡ＩＰＨＯＮＥ'));
    assert.ok(!Q.isNearDuplicate('小明每週三打羽球', '小明每週五打羽球'));
    assert.ok(!Q.isNearDuplicate('小明每周日打羽球', '小明每周一打羽球'));
    assert.ok(!Q.isNearDuplicate('會議在今天下午', '會議在明天下午'));
});

test('Chroma 不可用时整批仍能完成（含多条写入）', async () => {
    chromaMode = 'down';
    chromaCalls = 0;
    const ent = 'C降級';
    const ms = [msg('user', '我今天吃了拉麵，還買了新鍵盤', '2026-08-01 10:00:00')];
    const r = await run([
        entry({ type: 'event', entities: [{ name: ent }], content: `${ent}吃了拉麵`, quote: '我今天吃了拉麵' }),
        entry({ type: 'event', entities: [{ name: ent }], content: `${ent}買了新鍵盤`, quote: '還買了新鍵盤' }),
    ], ms);
    assert.ok(chromaCalls >= 1, '应尝试过 Chroma');
    assert.strictEqual(r.written, 2);
    assert.strictEqual(rows(ent).length, 2);
    const run_ = db.prepare(`SELECT status FROM scribe_runs ORDER BY id DESC LIMIT 1`).get();
    assert.strictEqual(run_.status, 'done');
});
