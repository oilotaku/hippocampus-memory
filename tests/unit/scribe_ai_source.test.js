// F2：不要把助理自己的閒聊與客套話抽成記憶。LLM / Chroma / Librarian 全部 stub。
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `scribe_ai_source_${process.pid}_${Date.now()}.db`);
process.env.SANCTUARY_ENCRYPTION_KEY = '0'.repeat(64);

const llm = require('../../services/llm');
const memory = require('../../services/memory');
let llmEntries = [];
llm.callLLM = async () => ({ reply: JSON.stringify({ entries: llmEntries, fulfilled_intention_ids: [] }) });
memory.chromaDBOperation = async () => { throw new Error('ECONNREFUSED (stub)'); };
const libPath = require.resolve('../../services/librarian');
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { searchHybrid: async () => [] } };

const { initDatabase, getDb } = require('../../database');
initDatabase();
const db = getDb();
const { runScribe } = require('../../services/scribe');
const { USER, AI } = require('../../services/memoryConfig');

let nextId = 1;
const T1 = '2026-05-01 10:00:00';
const msg = (sender, content) => ({ id: nextId++, sender, content, timestamp: T1, message_type: 'text', is_encrypted: 0 });
const entry = (ent, over) => ({
    type: 'observation', entities: [{ name: ent, relation: 'related_to' }],
    content: `${ent}的事`, emotional_weight: 0.3, value_tags: [], source: 'chat', ...over,
});
async function run(entries, msgs) {
    llmEntries = entries;
    return runScribe(msgs, msgs[msgs.length - 1].timestamp);
}
const count = (ent) => db.prepare('SELECT COUNT(*) c FROM memory_fragments WHERE entity = ?').get(ent).c;

const CHITCHATS = [
    ['提醒', `${AI.name} 提醒 ${USER.name} 帶外套`, '記得帶外套喔，晚點會變冷'],
    ['建議', `${AI.name} 建議 ${USER.name} 早點睡覺`, '我建議你今晚早點睡覺'],
    ['承諾', `${AI.name} 說之後推薦食物會避開花生`, '之後推薦食物我會避開花生'],
    ['客套', `${AI.name} 說三重交通方便`, '三重交通真的很方便呢'],
];

for (const [name, content, quote] of CHITCHATS) {
    for (const claim of ['ai', 'user', undefined]) {
        test(`助理${name}（模型自報 quote_from=${claim}）→ 丟棄並計入 aiChitchatDropped`, async () => {
            const ent = `F2丟_${name}_${claim}`;
            const r = await run([entry(ent, { content, quote, quote_from: claim })],
                [msg('user', '好喔'), msg('ai', quote)]);
            assert.strictEqual(r.written, 0);
            assert.strictEqual(count(ent), 0);
            assert.strictEqual(r.aiChitchatDropped, 1);
            assert.deepStrictEqual(r.aiChitchatDroppedByType, { observation: 1 });
            assert.strictEqual(r.quoteDropped, 0);
        });
    }
}

test('助理感知使用者情緒 → 保留', async () => {
    const ent = 'F2留_情緒';
    const r = await run([entry(ent, { type: 'state', quote_from: 'ai', content: `${USER.name}今天很疲憊`, quote: '你聽起來很累' })],
        [msg('user', '嗯，還好'), msg('ai', '你聽起來很累，要不要休息一下？')]);
    assert.strictEqual(r.written, 1);
    assert.strictEqual(r.aiChitchatDropped, 0);
});

test('助理感知情緒但模型漏標 quote_from → 仍以實際來源判斷並保留', async () => {
    const ent = 'F2留_漏標';
    const r = await run([entry(ent, { content: `${USER.name}語氣帶著委屈`, quote: '你語氣裡帶著委屈' })],
        [msg('user', '沒事啦'), msg('ai', '我聽得出來，你語氣裡帶著委屈。')]);
    assert.strictEqual(r.written, 1);
});

test('助理自己的情緒（未提及使用者）→ 丟棄', async () => {
    const ent = 'F2丟_自己情緒';
    const r = await run([entry(ent, { quote_from: 'ai', content: `${AI.name}今天很開心`, quote: '我今天真的很開心' })],
        [msg('user', '哦'), msg('ai', '我今天真的很開心')]);
    assert.strictEqual(r.written, 0);
    assert.strictEqual(r.aiChitchatDropped, 1);
});

test('助理來源但 type 為 fact → 丟棄（沿用 quote 驗證，不算閒聊）', async () => {
    const ent = 'F2丟_fact';
    const r = await run([entry(ent, { type: 'fact', quote_from: 'user', content: `${USER.name}很累`, quote: '你聽起來很累' })],
        [msg('user', '嗯'), msg('ai', '你聽起來很累')]);
    assert.strictEqual(r.written, 0);
    assert.strictEqual(r.quoteDropped, 1);
    assert.strictEqual(r.aiChitchatDropped, 0);
});

test('使用者自己說的事實 → 保留（不受影響，即使模型標 quote_from=ai）', async () => {
    const ent = 'F2留_事實';
    const r = await run([
        entry(ent, { type: 'fact', content: `${ent}對花生過敏`, quote: '我對花生過敏' }),
        entry(ent + 'b', { type: 'observation', quote_from: 'ai', content: `${ent}b住在三重`, quote: '我住在三重' }),
    ], [msg('user', '我對花生過敏，我住在三重'), msg('ai', '好的')]);
    assert.strictEqual(r.written, 2);
    assert.strictEqual(r.aiChitchatDropped, 0);
});

test('quote 兩邊都出現 → 以使用者為準（不套助理規則）', async () => {
    const ent = 'F2留_兩邊';
    const r = await run([entry(ent, { quote_from: 'ai', content: `${ent}住在三重`, quote: '我住在三重' })],
        [msg('user', '我住在三重'), msg('ai', '對，我住在三重是嗎？你說你住在三重')]);
    assert.strictEqual(r.written, 1);
    assert.strictEqual(r.aiChitchatDropped, 0);
});

test('簡體輸入：助理提醒丟棄、情緒感知保留', async () => {
    const drop = 'F2簡_丟', keep = 'F2簡_留';
    const r = await run([
        entry(drop, { quote_from: 'ai', content: `${AI.name}提醒${USER.name}带外套`, quote: '记得带外套哦' }),
        entry(keep, { quote_from: 'ai', content: `${USER.name}今天很疲惫`, quote: '你听起来很累' }),
    ], [msg('user', '嗯'), msg('ai', '记得带外套哦。你听起来很累，早点休息')]);
    assert.strictEqual(count(drop), 0);
    assert.strictEqual(count(keep), 1);
    assert.strictEqual(r.aiChitchatDropped, 1);
});
