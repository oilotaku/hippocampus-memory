// ============================================================
// Archivist 守衛規則迴歸測試（純函式，不碰庫）
// 執行：/usr/bin/node services/archivistGuards.test.js
//   （要用 /usr/bin/node —— better-sqlite3 編譯在 v18 上）
//
// 三條規則都是 2026-09-28 加的止血：
//   1. isTimePhraseName    —— 純日期/時間短語不是實體（2026-09-04 b6800fd 立）
//   2. isPeriodPhraseName  —— 以期間詞收尾的名字不是實體（2026-09-28 新）
//   3. isNoChangeSentinel  —— 「無明顯變化」是哨兵，不落庫（2026-09-28 新）
//   4. _mentionWeight / _aliasAmbiguous —— 別名的三道門（2026-09-28 新，見第 4 節）
//
// ⚠️ 改詞表前先讀這三條規則的註釋（services/archivist.js 頂部附近）。
//    第 2 條刻意不含「計劃」「系列」「記錄」——「曼哈頓計劃」「哈利波特系列」
//    這類可能是正經專案/作品名，誤殺代價比放過一條大。要加詞先在這裡補用例。
//
// ⚠️ **所有用例一律用完全中性的造詞**（工程/流程類）。別用真實的人名、店名、
//    作品名、地名——哪怕前面加個「某」也沒用：幾個具體名詞湊在一起本身就是可識別
//    資訊，遮住專有名詞不等於匿名。第 4 節的 owners 表就是現造的。
// ============================================================

const { isTimePhraseName, isPeriodPhraseName, isNoChangeSentinel,
        _mentionWeight, _aliasAmbiguous } = require('./archivist');

let passed = 0;
let failed = 0;

function ok(desc, cond) {
    if (cond) { passed++; console.log(`  ✓ ${desc}`); }
    else { failed++; console.error(`  ✗ ${desc}`); }
}

console.log('\n[1] isTimePhraseName — 純日期/時間短語');
for (const s of ['日晚', '日凌晨', '日傍晚', '日上午', '日下午', '三點半', '週六', '年月日']) {
    ok(`拒「${s}」`, isTimePhraseName(s) === true);
}
for (const s of ['阿日斯蘭', '下午茶', '哈利波特', '日晚報', '星鐵', '點數']) {
    ok(`放行「${s}」`, isTimePhraseName(s) === false);
}

console.log('\n[2] isPeriodPhraseName — 期間詞收尾');
// ⚠️ 用例一律用**完全中性的詞**（工程/流程類）。
// **不要寫帶著生活特徵的組合——哪怕前面加個「某」也沒用**：幾個具體名詞湊在一起，
// 本身就是可識別資訊，遮住專有名詞不等於匿名。這條同樣適用於以後往這裡加用例的人。
for (const s of [
    '籌備季', '審計期', '交付歷程', '遷移過程', '巡檢日常', '試執行階段',
    '招標季', '驗收期', '最佳化歷程', '聯調過程',
]) {
    ok(`拒「${s}」`, isPeriodPhraseName(s) === true);
}
for (const s of [
    // 專有名詞：不以期間詞收尾的一律放行
    '曼哈頓計劃', '阿波羅計劃', '哈利波特系列', 'freeCodeCamp', 'Kubernetes',
    // 刻意不收的詞 —— 可能是正經專案/作品名
    '夢境記錄', '操作日誌', '維基百科',
]) {
    ok(`放行「${s}」`, isPeriodPhraseName(s) === false);
}

console.log('\n[3] isNoChangeSentinel — 哨兵');
for (const s of ['無明顯變化', '無明顯變化。', '無明顯變化。 ', '無', '無。', '暫無', '無變化', '近期無新動態', '']) {
    ok(`哨兵「${s}」`, isNoChangeSentinel(s) === true);
}
for (const s of ['新增了兩項待辦事項。', '無花果採購', '無明顯變化發生後的安排']) {
    ok(`非哨兵「${s}」`, isNoChangeSentinel(s) === false);
}

// ── [4] 別名的三道門 ──
// 字面連結器把「實體名 + 別名」都拿去做 LIKE 匹配。不加門時，模型寫的別名清單裡
// 那些泛稱（職業通用詞、地區名、話題詞）每個都會吸進幾十上百條碎片。
// 判據是純函式，所以能在這兒離線測——不用真庫、不用真名。
console.log('\n[4a] _mentionWeight — 資訊量權重（拉丁 0.5 / 漢字 1）');
for (const [s, want] of [
    ['abc', 1.5], ['abcd', 2], ['abcde', 2.5], ['abcdef', 3],
    ['籌備', 2], ['籌備組', 3], ['圖靈測試', 4],
    ['AI 峰會', 3], ['A B', 1], ['', 0],
]) {
    ok(`「${s}」→ ${want}`, Math.abs(_mentionWeight(s) - want) < 1e-9);
}
// 門檻是 3 分：3 個拉丁字母（1.5）過不去，3 個漢字（3）剛好過得去。
ok('3 個拉丁字母過不了門', _mentionWeight('abc') < 3);
ok('3 個漢字過得去', _mentionWeight('籌備組') >= 3);

console.log('\n[4b] _aliasAmbiguous — 跟別人的叫法互相包含');
{
    // 現造的所有權表：id 1 叫「工程組」，id 2 叫「總部工程組」，3 自己有兩個叫法。
    const owners = new Map([
        ['工程組', new Set([1])],
        ['總部工程組', new Set([2])],
        ['正式名', new Set([3])],
        ['簡稱', new Set([3])],
        ['無關項', new Set([4])],
    ]);
    ok('子串跨實體 → 指代不明', _aliasAmbiguous(1, '工程組', owners) === true);
    ok('超串跨實體 → 也指代不明', _aliasAmbiguous(2, '總部工程組', owners) === true);
    ok('跟自己的另一個叫法互相包含 → 不算', _aliasAmbiguous(3, '簡稱', owners) === false);
    ok('誰也不挨著 → 放行', _aliasAmbiguous(4, '無關項', owners) === false);
    ok('全新的詞 → 放行', _aliasAmbiguous(1, '尚未出現過的說法', owners) === false);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
