// =================================================================
// services/archivist/guards.js — 名稱守衛（時間／期間短語）、「無變化」哨兵、名稱兩字組
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================



// ═══════════════════════════════════════════════════════
// v4.8: mergeDuplicateSeeds — 重複種子合併
//
// 「某日展會」「展會簽名事件」「某日展會簽名活動」是同
// 一件事的三個種子，碎片被攤薄後誰都到不了升格線。同 category
// 內名字相似或共享碎片的種子對 → LLM 判同 → 合併。
// ═══════════════════════════════════════════════════════

function _nameBigrams(name) {
    const s = (name || '').toLowerCase().replace(/[\s\d\-—·:：年月日]/g, '');
    const grams = new Set();
    for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
    return grams;
}


// ═══════════════════════════════════════════════════════
// 種子名守衛：純日期/時間短語不是實體
//
// LLM 會把 Scribe 每日狀態裡「9月3日上午抵達…」的「日上午」「日下午」
// 當成有名字的 term 實體播種，汙染星圖 + autoLinkLiteralMentions 再
// 用 LIKE '%上午%' 把它們喂到 65/108 條碎片。鐵證規則：名字的每一個
// 字元都落在日期/時間字元集內 → 拒絕（不靠 LLM 自覺，不進人工佇列）。
// 「阿日斯蘭」「下午茶」這類混了非時間字的正常名字不受影響。
// ═══════════════════════════════════════════════════════
const TIME_PHRASE_NAME_RE = /^[\d零一二三四五六七八九十百千萬兩〇年月日號周週星期禮拜天時分秒點上下中早晚午晨夜凌傍黃晌今明昨天后天前個半初末旬幾更]+$|^[\d零一二三四五六七八九十百千万两〇年月日号周星期礼拜天时分秒点上下中早晚午晨夜凌傍黄晌今明昨天后天前个半初末旬几更]+$/;

function isTimePhraseName(name) {
    if (typeof name !== 'string') return true;
    const s = name.trim();
    if (s.length < 2) return true;
    return TIME_PHRASE_NAME_RE.test(s);
}


// ── 種子名守衛（二）：以「期間詞」收尾的名字不是實體 ──────────────
//
// 上一條只攔"全是日期/時間字"的名字，攔不住「XX告別季」「XX購置季」
// 「XX倦怠期」這類——它們是模型把**一段反覆出現的行為/狀態**包裝成
// "獨立事件"來繞開判據的產物（湧現檢測的 prompt 要求"必須是獨立的具體
// 地點或事件"，起名就成了它的解法）。
//
// 判據：**專有名詞不會以期間詞收尾**。季/期/歷程/過程/日常/階段 收尾
// 一律拒。刻意不含「計劃」「系列」「記錄」——「曼哈頓計劃」「某作品系列」
// 這類可能是正經專案/作品名，誤殺代價比放過一條大。
const PERIOD_PHRASE_NAME_RE = /(季|期|歷程|過程|日常|階段)$|(季|期|历程|过程|日常|阶段)$/;

function isPeriodPhraseName(name) {
    if (typeof name !== 'string') return true;
    const s = name.trim();
    if (s.length < 2) return true;
    return PERIOD_PHRASE_NAME_RE.test(s);
}


// ── 近況哨兵：「無明顯變化」是"沒有新動態"，不是一條動態 ───────────
//
// 寫 current_status 的地方都是**替換**語義，收到哨兵照樣 UPDATE，就會把
// 上一次的有效近況整個擦掉。哨兵一律不落庫，舊值留著。
//
// ⚠️ 只用於 current_status，**不要拿去判 judgment**：judgment 的「無」是
// 合法值（沒話可說就不硬編），不是哨兵。
const NO_CHANGE_SENTINEL_RE = /^(無|暫無|無明顯變化|無變化|沒有明顯變化|無新動態|近期無新動態|無明顯動態)[。.，,、\s]*$|^(无|暂无|无明显变化|无变化|没有明显变化|无新动态|近期无新动态|无明显动态)[。.，,、\s]*$/;

function isNoChangeSentinel(text) {
    if (typeof text !== 'string') return true;
    const s = text.trim();
    if (!s) return true;
    return NO_CHANGE_SENTINEL_RE.test(s);
}

module.exports = {
    _nameBigrams,
    TIME_PHRASE_NAME_RE,
    isTimePhraseName,
    PERIOD_PHRASE_NAME_RE,
    isPeriodPhraseName,
    NO_CHANGE_SENTINEL_RE,
    isNoChangeSentinel,
};
