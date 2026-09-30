// W8：记忆区块 token 预算、rhythm.deep_cycle_min_free_mb 设定读取（纯函数，不碰 DB / 网络）
const test = require('node:test');
const assert = require('node:assert');

const B = require('../../services/memoryBudget');
const R = require('../../services/rhythmConfig');

// ---------- getMemoryTokenBudget ----------
test('预算：未设定回预设 1200', () => {
    assert.strictEqual(B.getMemoryTokenBudget({}), 1200);
    assert.strictEqual(B.getMemoryTokenBudget({ context: {} }), 1200);
    assert.strictEqual(B.getMemoryTokenBudget(null), 1200);
    assert.strictEqual(B.DEFAULT_MEMORY_TOKEN_BUDGET, 1200);
});

test('预算：合法值生效（小数向下取整）', () => {
    assert.strictEqual(B.getMemoryTokenBudget({ context: { memory_token_budget: 500 } }), 500);
    assert.strictEqual(B.getMemoryTokenBudget({ context: { memory_token_budget: 800.9 } }), 800);
});

test('预算：非法值（0、负数、字串、NaN）一律回预设', () => {
    for (const bad of [0, -5, '900', NaN, Infinity, null, {}]) {
        assert.strictEqual(B.getMemoryTokenBudget({ context: { memory_token_budget: bad } }), 1200, String(bad));
    }
});

test('预算：不传 cfg 时读真实 memory_config（不抛错、回正整数）', () => {
    const v = B.getMemoryTokenBudget();
    assert.ok(Number.isInteger(v) && v > 0);
});

// ---------- estimateTokens ----------
test('estimateTokens：字数/4 向上取整，空值为 0', () => {
    assert.strictEqual(B.estimateTokens(''), 0);
    assert.strictEqual(B.estimateTokens(null), 0);
    assert.strictEqual(B.estimateTokens('abcd'), 1);
    assert.strictEqual(B.estimateTokens('abcde'), 2);
});

// ---------- takeWithinBudget 边界 ----------
const items = [{ t: 'a'.repeat(40) }, { t: 'b'.repeat(40) }, { t: 'c'.repeat(40) }]; // 各 10 token
const cost = i => B.estimateTokens(i.t);

test('截断：刚好等于预算全留（含边界）', () => {
    const r = B.takeWithinBudget(items, 30, cost);
    assert.strictEqual(r.kept.length, 3);
    assert.strictEqual(r.used, 30);
    assert.strictEqual(r.dropped, 0);
});

test('截断：差 1 token 就整条丢掉最后一条，不切断内容', () => {
    const r = B.takeWithinBudget(items, 29, cost);
    assert.strictEqual(r.kept.length, 2);
    assert.strictEqual(r.dropped, 1);
    assert.strictEqual(r.used, 20);
    for (const k of r.kept) assert.strictEqual(k.t.length, 40); // 每条原封不动
});

test('截断：保持排序，遇到第一条放不下就停（不为了塞更多跳过前面的）', () => {
    const list = [{ t: 'a'.repeat(8) }, { t: 'b'.repeat(400) }, { t: 'c'.repeat(4) }]; // 2, 100, 1
    const r = B.takeWithinBudget(list, 50, cost);
    assert.deepStrictEqual(r.kept.map(x => x.t[0]), ['a']); // 小的 c 不会越过 b 被收入
    assert.strictEqual(r.dropped, 2);
});

test('截断：第一条就超过预算 → 全丢；预算 0 → 全丢；空清单', () => {
    assert.strictEqual(B.takeWithinBudget([{ t: 'x'.repeat(400) }], 50, cost).kept.length, 0);
    assert.strictEqual(B.takeWithinBudget(items, 0, cost).kept.length, 0);
    const e = B.takeWithinBudget([], 100, cost);
    assert.deepStrictEqual(e, { kept: [], used: 0, dropped: 0 });
    assert.deepStrictEqual(B.takeWithinBudget(null, 100, cost), { kept: [], used: 0, dropped: 0 });
});

test('截断：预算可跨区块递减使用（used 扣除后继续）', () => {
    let left = 25;
    const r1 = B.takeWithinBudget(items, left, cost); left -= r1.used;
    assert.strictEqual(r1.kept.length, 2);
    assert.strictEqual(left, 5);
    const r2 = B.takeWithinBudget(items, left, cost);
    assert.strictEqual(r2.kept.length, 0);
});

// ---------- splitEntityBlocks ----------
test('splitEntityBlocks：依「※ 」开头切回各实体档案，条内换行不被切开', () => {
    const text = '※ 小明（person）\n  Facts: 住台北\n  Status: 好\n※ 小华（person）\n  Facts: 学日文';
    const blocks = B.splitEntityBlocks(text);
    assert.strictEqual(blocks.length, 2);
    assert.ok(blocks[0].includes('Status: 好'));
    assert.ok(blocks[1].startsWith('※ 小华'));
    assert.strictEqual(blocks.join('\n'), text);
    assert.deepStrictEqual(B.splitEntityBlocks(null), []);
    assert.deepStrictEqual(B.splitEntityBlocks(''), []);
});

// ---------- rhythm.deep_cycle_min_free_mb ----------
test('rhythm：未设定回预设 1200', () => {
    assert.strictEqual(R.getDeepCycleMinFreeMb({}), 1200);
    assert.strictEqual(R.getDeepCycleMinFreeMb({ rhythm: {} }), 1200);
    assert.strictEqual(R.getDeepCycleMinFreeMb(null), 1200);
    assert.strictEqual(R.DEFAULT_DEEP_CYCLE_MIN_FREE_MB, 1200);
});

test('rhythm：合法值生效（含 0 = 不设门槛）', () => {
    assert.strictEqual(R.getDeepCycleMinFreeMb({ rhythm: { deep_cycle_min_free_mb: 600 } }), 600);
    assert.strictEqual(R.getDeepCycleMinFreeMb({ rhythm: { deep_cycle_min_free_mb: 0 } }), 0);
});

test('rhythm：非法值（负数、字串、NaN）回预设', () => {
    for (const bad of [-1, '600', NaN, null]) {
        assert.strictEqual(R.getDeepCycleMinFreeMb({ rhythm: { deep_cycle_min_free_mb: bad } }), 1200, String(bad));
    }
});

test('example 设定档含新键且预设与代码一致', () => {
    const ex = require('../../memory_config.example.json');
    assert.strictEqual(R.getDeepCycleMinFreeMb(ex), 1200);
    assert.strictEqual(B.getMemoryTokenBudget(ex), 1200);
    assert.strictEqual(ex.rhythm.deep_cycle_min_free_mb, 1200);
    assert.strictEqual(ex.context.memory_token_budget, 1200);
});
