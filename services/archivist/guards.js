// =================================================================
// services/archivist/guards.js — 名稱守衛（時間／期間短語）、「無變化」哨兵、名稱兩字組
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================



// ═══════════════════════════════════════════════════════
// v4.8: mergeDuplicateSeeds — 重复种子合并
//
// 「某日展会」「展会签名事件」「某日展会签名活动」是同
// 一件事的三个种子，碎片被摊薄后谁都到不了升格线。同 category
// 内名字相似或共享碎片的种子对 → LLM 判同 → 合并。
// ═══════════════════════════════════════════════════════

function _nameBigrams(name) {
    const s = (name || '').toLowerCase().replace(/[\s\d\-—·:：年月日]/g, '');
    const grams = new Set();
    for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
    return grams;
}


// ═══════════════════════════════════════════════════════
// 种子名守卫：纯日期/时间短语不是实体
//
// LLM 会把 Scribe 每日状态里「9月3日上午抵达…」的「日上午」「日下午」
// 当成有名字的 term 实体播种，污染星图 + autoLinkLiteralMentions 再
// 用 LIKE '%上午%' 把它们喂到 65/108 条碎片。铁证规则：名字的每一个
// 字符都落在日期/时间字符集内 → 拒绝（不靠 LLM 自觉，不进人工队列）。
// 「阿日斯兰」「下午茶」这类混了非时间字的正常名字不受影响。
// ═══════════════════════════════════════════════════════
const TIME_PHRASE_NAME_RE = /^[\d零一二三四五六七八九十百千万两〇年月日号周星期礼拜天时分秒点上下中早晚午晨夜凌傍黄晌今明昨天后天前个半初末旬几更]+$/;

function isTimePhraseName(name) {
    if (typeof name !== 'string') return true;
    const s = name.trim();
    if (s.length < 2) return true;
    return TIME_PHRASE_NAME_RE.test(s);
}


// ── 种子名守卫（二）：以「期间词」收尾的名字不是实体 ──────────────
//
// 上一条只拦"全是日期/时间字"的名字，拦不住「XX告别季」「XX购置季」
// 「XX倦怠期」这类——它们是模型把**一段反复出现的行为/状态**包装成
// "独立事件"来绕开判据的产物（涌现检测的 prompt 要求"必须是独立的具体
// 地点或事件"，起名就成了它的解法）。
//
// 判据：**专有名词不会以期间词收尾**。季/期/历程/过程/日常/阶段 收尾
// 一律拒。刻意不含「计划」「系列」「记录」——「曼哈顿计划」「某作品系列」
// 这类可能是正经项目/作品名，误杀代价比放过一条大。
const PERIOD_PHRASE_NAME_RE = /(季|期|历程|过程|日常|阶段)$/;

function isPeriodPhraseName(name) {
    if (typeof name !== 'string') return true;
    const s = name.trim();
    if (s.length < 2) return true;
    return PERIOD_PHRASE_NAME_RE.test(s);
}


// ── 近况哨兵：「无明显变化」是"没有新动态"，不是一条动态 ───────────
//
// 写 current_status 的地方都是**替换**语义，收到哨兵照样 UPDATE，就会把
// 上一次的有效近况整个擦掉。哨兵一律不落库，旧值留着。
//
// ⚠️ 只用于 current_status，**不要拿去判 judgment**：judgment 的「无」是
// 合法值（没话可说就不硬编），不是哨兵。
const NO_CHANGE_SENTINEL_RE = /^(无|暂无|无明显变化|无变化|没有明显变化|无新动态|近期无新动态|无明显动态)[。.，,、\s]*$/;

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
