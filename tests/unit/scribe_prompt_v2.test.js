// Scribe 提示詞 v2（scribe.prompt='v2'）：legacy 逐字不變、v2 結構完整、情緒關閉時不提 emotions/event_at、長度約減半、寫入行為照舊。
// LLM / Chroma / Librarian 全部 stub。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `scribe_prompt_v2_${process.pid}_${Date.now()}.db`);
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
const { setScribeConfigOverride, getScribeConfig } = require('../../services/hippocampus/entorhinal/scribeConfig');
const emotion = require('../../services/emotion');

// 舊版提示詞（scribe.prompt=legacy）在空資料庫下的 SHA-256。用改動前的程式（main 9e856d8 之後、本分支之前）算出；
// 這個值變了代表 legacy 提示詞被改動——'legacy' 必須與舊版逐字相同。
const LEGACY_SHA256 = 'db0d5b3f59e4451f644fb6f59c7d6a4c694af3add30930514875c8108a909660';

let nextId = 1;
const msg = (sender, content, ts) => ({ id: nextId++, sender, content, timestamp: ts, message_type: 'text', is_encrypted: 0 });
let seq = 0;
const entry = (over = {}) => {
    seq++;
    return {
        type: 'event', entities: [{ name: `V2實體${seq}`, relation: 'related_to' }],
        content: `V2實體${seq}的事`, emotional_weight: 0.2, value_tags: [], source: 'chat', quote: '我今天去爬山', ...over,
    };
};
async function promptFor(cfg, entries = []) {
    setScribeConfigOverride(cfg);
    llmEntries = entries;
    const m = [msg('user', '我今天去爬山，好累', '2026-05-02 05:22:00')];
    const r = await runScribe(m, m[0].timestamp);
    return { prompt: lastSystemPrompt, result: r };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test.afterEach(() => { setScribeConfigOverride(null); emotion._setOverride(null); });

test('設定：預設 v2，只認 legacy，其他值回退 v2', () => {
    setScribeConfigOverride({});
    assert.equal(getScribeConfig().prompt, 'v2');
    setScribeConfigOverride({ prompt: 'legacy' });
    assert.equal(getScribeConfig().prompt, 'legacy');
    setScribeConfigOverride({ prompt: 'Legacy!' });
    assert.equal(getScribeConfig().prompt, 'v2');
});

test('legacy：與舊版提示詞逐字相同（SHA-256 鎖定）', async () => {
    const { prompt } = await promptFor({ prompt: 'legacy' });
    assert.equal(sha(prompt), LEGACY_SHA256);
});

test('v2：沒有殘留佔位符，包含完整輸出格式與型別、關係列舉', async () => {
    const { prompt } = await promptFor({ prompt: 'v2' });
    assert.doesNotMatch(prompt, /\{[A-Z_]{4,}\}/);
    assert.doesNotMatch(prompt, /\{\{[a-z.]+\}\}/);
    for (const k of ['"entries"', '"type"', '"entities"', '"quote"', '"quote_from"', '"content"', '"emotional_weight"', '"value_tags"', '"source"', '"is_rp"', '"fulfilled_intention_ids"']) {
        assert.ok(prompt.includes(k), k);
    }
    assert.ok(prompt.includes('state|observation|preference|event|intention|reflection|entity_new|fact'));
    assert.ok(prompt.includes('related_to|knows|visited|consumed|created|attended|cares_for'));
    assert.ok(prompt.includes('## 角色與世界背景'));          // WORLD_CONTEXT 照舊
    assert.ok(prompt.includes('future_hook'));
});

test('v2：拿掉互相矛盾的取捨字眼，改為覆蓋原則', async () => {
    const { prompt } = await promptFor({ prompt: 'v2' });
    for (const w of ['少而精', '寧可跳過', '不要為了產出而產出']) assert.ok(!prompt.includes(w), w);
    assert.ok(prompt.includes('拿不準重不重要就記'));
});

test('v2：情緒開啟時含 emotions／event_at 段落；關閉時全文不提', async () => {
    let { prompt } = await promptFor({ prompt: 'v2' });
    assert.match(prompt, /"emotions": \{"anger": 0\.8/);
    assert.match(prompt, /## emotions 與 event_at/);
    emotion._setOverride({ enabled: false });
    ({ prompt } = await promptFor({ prompt: 'v2' }));
    assert.doesNotMatch(prompt, /emotions/);
    assert.doesNotMatch(prompt, /event_at/);
});

test('v2：長度不到舊版的 60%（記錄實際字數）', async () => {
    const legacy = (await promptFor({ prompt: 'legacy' })).prompt;
    const v2 = (await promptFor({ prompt: 'v2' })).prompt;
    console.log(`[scribe_prompt_v2] legacy ${legacy.length} 字，v2 ${v2.length} 字（${Math.round(v2.length / legacy.length * 100)}%）`);
    assert.ok(v2.length < legacy.length * 0.6);
});

test('v2：寫入流程照舊（原話佐證、欄位落地）', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c;
    const { result } = await promptFor({ prompt: 'v2' }, [entry(), entry({ quote: '沒說過的話' })]);
    assert.equal(result.written, 1);            // 第二條 quote 對不上原文，照舊被丟
    assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c, before + 1);
});
