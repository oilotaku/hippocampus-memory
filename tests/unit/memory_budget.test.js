// W8：記憶區塊 token 預算、rhythm.deep_cycle_min_free_mb 設定讀取（純函式，不碰 DB / 網路）
const test = require('node:test');
const assert = require('node:assert');

const B = require('../../services/memoryBudget');
const R = require('../../services/rhythmConfig');

// ---------- getMemoryTokenBudget ----------
test('預算：未設定回預設 1200', () => {
    assert.strictEqual(B.getMemoryTokenBudget({}), 1200);
    assert.strictEqual(B.getMemoryTokenBudget({ context: {} }), 1200);
    assert.strictEqual(B.getMemoryTokenBudget(null), 1200);
    assert.strictEqual(B.DEFAULT_MEMORY_TOKEN_BUDGET, 1200);
});

test('預算：合法值生效（小數向下取整）', () => {
    assert.strictEqual(B.getMemoryTokenBudget({ context: { memory_token_budget: 500 } }), 500);
    assert.strictEqual(B.getMemoryTokenBudget({ context: { memory_token_budget: 800.9 } }), 800);
});

test('預算：非法值（0、負數、字串、NaN）一律回預設', () => {
    for (const bad of [0, -5, '900', NaN, Infinity, null, {}]) {
        assert.strictEqual(B.getMemoryTokenBudget({ context: { memory_token_budget: bad } }), 1200, String(bad));
    }
});

test('預算：不傳 cfg 時讀真實 memory_config（不拋錯、回正整數）', () => {
    const v = B.getMemoryTokenBudget();
    assert.ok(Number.isInteger(v) && v > 0);
});

// ---------- estimateTokens ----------
test('estimateTokens：字數/4 向上取整，空值為 0', () => {
    assert.strictEqual(B.estimateTokens(''), 0);
    assert.strictEqual(B.estimateTokens(null), 0);
    assert.strictEqual(B.estimateTokens('abcd'), 1);
    assert.strictEqual(B.estimateTokens('abcde'), 2);
});

// ---------- takeWithinBudget 邊界 ----------
const items = [{ t: 'a'.repeat(40) }, { t: 'b'.repeat(40) }, { t: 'c'.repeat(40) }]; // 各 10 token
const cost = i => B.estimateTokens(i.t);

test('截斷：剛好等於預算全留（含邊界）', () => {
    const r = B.takeWithinBudget(items, 30, cost);
    assert.strictEqual(r.kept.length, 3);
    assert.strictEqual(r.used, 30);
    assert.strictEqual(r.dropped, 0);
});

test('截斷：差 1 token 就整條丟掉最後一條，不切斷內容', () => {
    const r = B.takeWithinBudget(items, 29, cost);
    assert.strictEqual(r.kept.length, 2);
    assert.strictEqual(r.dropped, 1);
    assert.strictEqual(r.used, 20);
    for (const k of r.kept) assert.strictEqual(k.t.length, 40); // 每條原封不動
});

test('截斷：保持排序，遇到第一條放不下就停（不為了塞更多跳過前面的）', () => {
    const list = [{ t: 'a'.repeat(8) }, { t: 'b'.repeat(400) }, { t: 'c'.repeat(4) }]; // 2, 100, 1
    const r = B.takeWithinBudget(list, 50, cost);
    assert.deepStrictEqual(r.kept.map(x => x.t[0]), ['a']); // 小的 c 不會越過 b 被收入
    assert.strictEqual(r.dropped, 2);
});

test('截斷：第一條就超過預算 → 全丟；預算 0 → 全丟；空清單', () => {
    assert.strictEqual(B.takeWithinBudget([{ t: 'x'.repeat(400) }], 50, cost).kept.length, 0);
    assert.strictEqual(B.takeWithinBudget(items, 0, cost).kept.length, 0);
    const e = B.takeWithinBudget([], 100, cost);
    assert.deepStrictEqual(e, { kept: [], used: 0, dropped: 0 });
    assert.deepStrictEqual(B.takeWithinBudget(null, 100, cost), { kept: [], used: 0, dropped: 0 });
});

test('截斷：預算可跨區塊遞減使用（used 扣除後繼續）', () => {
    let left = 25;
    const r1 = B.takeWithinBudget(items, left, cost); left -= r1.used;
    assert.strictEqual(r1.kept.length, 2);
    assert.strictEqual(left, 5);
    const r2 = B.takeWithinBudget(items, left, cost);
    assert.strictEqual(r2.kept.length, 0);
});

// ---------- splitEntityBlocks ----------
test('splitEntityBlocks：依「※ 」開頭切回各實體檔案，條內換行不被切開', () => {
    const text = '※ 小明（person）\n  Facts: 住臺北\n  Status: 好\n※ 小華（person）\n  Facts: 學日文';
    const blocks = B.splitEntityBlocks(text);
    assert.strictEqual(blocks.length, 2);
    assert.ok(blocks[0].includes('Status: 好'));
    assert.ok(blocks[1].startsWith('※ 小華'));
    assert.strictEqual(blocks.join('\n'), text);
    assert.deepStrictEqual(B.splitEntityBlocks(null), []);
    assert.deepStrictEqual(B.splitEntityBlocks(''), []);
});

// ---------- rhythm.deep_cycle_min_free_mb ----------
test('rhythm：未設定回預設 1200', () => {
    assert.strictEqual(R.getDeepCycleMinFreeMb({}), 1200);
    assert.strictEqual(R.getDeepCycleMinFreeMb({ rhythm: {} }), 1200);
    assert.strictEqual(R.getDeepCycleMinFreeMb(null), 1200);
    assert.strictEqual(R.DEFAULT_DEEP_CYCLE_MIN_FREE_MB, 1200);
});

test('rhythm：合法值生效（含 0 = 不設門檻）', () => {
    assert.strictEqual(R.getDeepCycleMinFreeMb({ rhythm: { deep_cycle_min_free_mb: 600 } }), 600);
    assert.strictEqual(R.getDeepCycleMinFreeMb({ rhythm: { deep_cycle_min_free_mb: 0 } }), 0);
});

test('rhythm：非法值（負數、字串、NaN）回預設', () => {
    for (const bad of [-1, '600', NaN, null]) {
        assert.strictEqual(R.getDeepCycleMinFreeMb({ rhythm: { deep_cycle_min_free_mb: bad } }), 1200, String(bad));
    }
});

test('example 設定檔含新鍵且預設與程式碼一致', () => {
    const ex = require('../../memory_config.example.json');
    assert.strictEqual(R.getDeepCycleMinFreeMb(ex), 1200);
    assert.strictEqual(B.getMemoryTokenBudget(ex), 1200);
    assert.strictEqual(ex.rhythm.deep_cycle_min_free_mb, 1200);
    assert.strictEqual(ex.context.memory_token_budget, 1200);
});
