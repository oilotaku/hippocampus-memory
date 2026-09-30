// =================================================================
// Scribe 品质守门：原话佐证 + 跨天去重（纯函数，无 DB / 网络依赖）
// =================================================================
const crypto = require('crypto');

// AI 观察型 entry 允许的 type（prompt 只允许从 AI 发言抽「情绪感知」「强烈情感表达」两类）
const AI_QUOTE_TYPES = new Set(['observation', 'state', 'reflection']);
const MAX_QUOTE_LEN = 60;

// 正规化：NFKC（全形→半形）→ 小写 → 去空白/标点/符号
function normalizeText(s) {
    return String(s ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

// entry 的引用来源：默认只能来自用户；quote_from='ai' 且 type 属于观察型才可查 AI 发言
function quoteSource(entry) {
    if (String(entry?.quote_from || '').toLowerCase() === 'ai' && AI_QUOTE_TYPES.has(entry.type)) return 'ai';
    if (String(entry?.quote_from || '').toLowerCase() === 'ai') return 'invalid';
    return 'user';
}

/**
 * 验证 entry.quote 是来源消息的逐字子串（正规化后）。
 * sources = { user: [文本...], ai: [文本...] }
 * 返回 { ok, reason }
 */
function validateQuote(entry, sources) {
    const raw = entry?.quote;
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'missing' };
    if (raw.trim().length > MAX_QUOTE_LEN) return { ok: false, reason: 'too_long' };
    const q = normalizeText(raw);
    if (q.length < 2) return { ok: false, reason: 'too_short' };
    const src = quoteSource(entry);
    if (src === 'invalid') return { ok: false, reason: 'ai_type_not_allowed' };
    const pool = (sources && sources[src]) || [];
    for (const text of pool) {
        if (normalizeText(text).includes(q)) return { ok: true, reason: null };
    }
    return { ok: false, reason: 'not_found' };
}

/** 过滤 entries；返回 { kept, dropped, droppedByType } */
function filterEntriesByQuote(entries, sources) {
    const kept = [];
    const droppedByType = {};
    let dropped = 0;
    for (const e of entries || []) {
        if (e && validateQuote(e, sources).ok) kept.push(e);
        else {
            dropped++;
            const t = (e && e.type) || 'unknown';
            droppedByType[t] = (droppedByType[t] || 0) + 1;
        }
    }
    return { kept, dropped, droppedByType };
}

// ── 去重 ─────────────────────────────────────────────────────────

// 正规化内容哈希（不含日期）。entity 参与，同一句话关于不同实体不合并。
function normalizedContentHash(entity, content) {
    return crypto.createHash('sha256')
        .update(`${normalizeText(entity)}\u0000${normalizeText(content)}`)
        .digest('hex');
}

function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
}

const NUM = '0-9零〇一二两兩三四五六七八九十百千万萬';
// 关键 token：数字串 / 星期·周X·礼拜X / 时间词。两句的关键 token 多重集不同 → 不同事实
const KEY_RE = new RegExp(
    `(?:星期|礼拜|禮拜|周|週)[${NUM}日天]` +
    `|[${NUM}]+` +
    `|今天|明天|昨天|前天|后天|後天|今晚|昨晚|明晚|上午|下午|中午|早上|晚上|凌晨|傍晚|清晨|半夜|上周|下周|上週|下週|上个月|下个月|今年|去年|明年|周末|週末`,
    'gu'
);

function keyTokens(s) {
    return (s.match(KEY_RE) || []).sort().join('|');
}

/**
 * 近似重复：正规化后完全相同，或
 *   bigram Jaccard ≥ 0.8 且 关键 token 相同 且 差异 bigram 极少。
 * 保守：任一方独有 bigram ≥2 → 不同；两方都有独有 bigram（=「换掉一个词」）→ 不同。
 * 寧可不合并，也不要把「週三/週五」「貓/狗」「高雄/台北」误合并。
 */
function isNearDuplicate(a, b) {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (keyTokens(na) !== keyTokens(nb)) return false;
    const A = bigrams(na);
    const B = bigrams(nb);
    if (A.size === 0 || B.size === 0) return false;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const union = A.size + B.size - inter;
    if (inter / union < 0.8) return false;
    const onlyA = A.size - inter;
    const onlyB = B.size - inter;
    if (onlyA >= 2 || onlyB >= 2) return false;
    if (onlyA > 0 && onlyB > 0) return false;
    return true;
}

/**
 * 在同实体的 active 候选里找重复。candidates: [{id, content, content_hash, ...}]
 * 返回命中的候选或 null。
 */
function findDuplicate(entity, content, candidates) {
    const hash = normalizedContentHash(entity, content);
    for (const c of candidates) if (c.content_hash === hash) return c;
    for (const c of candidates) if (isNearDuplicate(content, c.content)) return c;
    return null;
}

module.exports = {
    normalizeText, validateQuote, filterEntriesByQuote,
    normalizedContentHash, isNearDuplicate, findDuplicate,
    AI_QUOTE_TYPES, MAX_QUOTE_LEN,
};
