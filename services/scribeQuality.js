// =================================================================
// Scribe 品質守門：原話佐證 + 跨天去重（純函式，無 DB / 網路依賴）
// =================================================================
const crypto = require('crypto');
const { toTraditionalChars } = require('../utils/zhNormalize');

// AI 觀察型 entry 允許的 type（prompt 只允許從 AI 發言抽「情緒感知」「強烈情感表達」兩類）
const AI_QUOTE_TYPES = new Set(['observation', 'state', 'reflection']);
const MAX_QUOTE_LEN = 60;

// 正規化：NFKC（全形→半形）→ 逐字簡轉繁 → 小寫 → 去空白/標點/符號
// 逐字簡轉繁：使用者用簡體、模型抄成繁體（或反過來）時，quote 驗證與去重不會誤判
function normalizeText(s) {
    return toTraditionalChars(String(s ?? '').normalize('NFKC'))
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

// ── F2：以 quote 實際出現的訊息方為準判斷來源（不信任模型自報的 quote_from）──
// 使用者訊息有（含兩邊都有）→ 'user'；只在助理訊息出現 → 'ai'；都沒有 → null
function detectQuoteSource(entry, sources) {
    const q = normalizeText(entry?.quote);
    const has = (pool) => (pool || []).some(t => normalizeText(t).includes(q));
    if (has(sources && sources.user)) return 'user';
    if (has(sources && sources.ai)) return 'ai';
    return null;
}

// AI 來源 entry 要保留，content 必須真的在描述「使用者」的情緒／狀態。
// 詞表簡繁並存，比對前先過 normalizeText（逐字簡轉繁）。寧可少收。
const EMOTION_WORDS = [
    '委屈', '難過', '傷心', '悲傷', '沮喪', '失落', '低落', '焦慮', '緊張', '不安', '擔心', '害怕', '恐懼', '恐慌',
    '生氣', '憤怒', '煩躁', '煩悶', '崩潰', '壓抑', '隱忍', '疲憊', '疲倦', '很累', '好累', '累了', '倦怠', '孤單', '孤獨', '寂寞',
    '無助', '無力', '挫折', '自責', '愧疚', '內疚', '羞愧', '尷尬', '失望', '絕望', '痛苦', '難受', '不開心', '不快樂',
    '開心', '快樂', '高興', '興奮', '期待', '滿足', '放鬆', '安心', '感動', '感激', '自豪', '驕傲', '依賴', '信任', '在意',
    '情緒', '心情', '心事', '低潮', '脆弱', '逞強', '強撐',
];
// 助理自己的建議／提醒／承諾／客套／稱讚：出現就丟棄
const CHITCHAT_WORDS = [
    '提醒', '建議', '推薦', '承諾', '答應', '保證', '會避開', '會幫', '幫你', '之後會', '下次會', '記得', '別忘', '謝謝', '感謝', '不客氣',
    '稱讚', '誇獎', '誇讚', '歡迎', '加油', '祝', '晚安', '早安', '交通方便', '應該要', '需要帶',
];

function includesAny(text, words) {
    return words.some(w => text.includes(normalizeText(w)));
}

/**
 * 助理視角的 entry 是否只是閒聊／客套／建議（true = 應丟棄）。
 * 保留條件：type 屬觀察型 ∧ 含情緒詞 ∧ 不含閒聊詞 ∧（若提到助理自己則必須同時提到使用者）
 */
function isAiChitchat(entry) {
    if (!AI_QUOTE_TYPES.has(entry?.type)) return true;
    const c = normalizeText(entry?.content);
    if (!c) return true;
    if (!includesAny(c, EMOTION_WORDS)) return true;
    if (includesAny(c, CHITCHAT_WORDS)) return true;
    const { AI, USER } = require('./memoryConfig');
    const aiName = normalizeText(AI.name);
    if (aiName && c.includes(aiName)) {
        const rest = c.split(aiName).join('');
        const userRefs = [USER.name, 'user', '使用者', '用戶', '你'].filter(Boolean).map(normalizeText);
        if (!userRefs.some(u => rest.includes(u))) return true;
    }
    return false;
}

/**
 * 驗證 entry.quote 是來源訊息的逐字子串（正規化後）。
 * sources = { user: [文本...], ai: [文本...] }
 * 返回 { ok, reason, source }；reason 可為 ai_chitchat（助理閒聊，非偽造）
 */
function validateQuote(entry, sources) {
    const raw = entry?.quote;
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'missing' };
    if (raw.trim().length > MAX_QUOTE_LEN) return { ok: false, reason: 'too_long' };
    const q = normalizeText(raw);
    if (q.length < 2) return { ok: false, reason: 'too_short' };
    const source = detectQuoteSource(entry, sources);
    if (!source) return { ok: false, reason: 'not_found' };
    if (source === 'ai') {
        if (!AI_QUOTE_TYPES.has(entry.type)) return { ok: false, reason: 'ai_type_not_allowed', source };
        if (isAiChitchat(entry)) return { ok: false, reason: 'ai_chitchat', source };
    }
    return { ok: true, reason: null, source };
}

/** 過濾 entries；返回 { kept, dropped, droppedByType, aiChitchatDropped, aiChitchatDroppedByType } */
function filterEntriesByQuote(entries, sources) {
    const kept = [];
    const droppedByType = {};
    const aiChitchatDroppedByType = {};
    let dropped = 0, aiChitchatDropped = 0;
    for (const e of entries || []) {
        const v = e ? validateQuote(e, sources) : { ok: false };
        const t = (e && e.type) || 'unknown';
        if (v.ok) kept.push(e);
        else if (v.reason === 'ai_chitchat') {
            aiChitchatDropped++;
            aiChitchatDroppedByType[t] = (aiChitchatDroppedByType[t] || 0) + 1;
        } else {
            dropped++;
            droppedByType[t] = (droppedByType[t] || 0) + 1;
        }
    }
    return { kept, dropped, droppedByType, aiChitchatDropped, aiChitchatDroppedByType };
}

// ── 去重 ─────────────────────────────────────────────────────────

// 正規化內容雜湊（不含日期）。entity 參與，同一句話關於不同實體不合並。
// W3：MEMORY_ENCRYPTION=on 時改用帶金鑰的 HMAC（金鑰由主金鑰 HKDF 衍生，見 utils/blindIndex.js）——
// 內容加密後若還存明文的 SHA-256，短句可以被字典猜出來。off 時維持原本的 SHA-256。
// 兩種模式互換時，services/memoryCrypto.js 會在啟動同步裡重算既有碎片的 content_hash。
function normalizedContentHash(entity, content) {
    const input = `${normalizeText(entity)}\u0000${normalizeText(content)}`;
    if (require('./memoryCrypto').isEnabled()) return require('../utils/blindIndex').keyedHash(input);
    return crypto.createHash('sha256').update(input).digest('hex');
}

function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
}

// 簡體寫法（两、万）與繁體並列；normalizeText 已先簡轉繁，這裡並列是雙重保險
const NUM = '0-9零〇一二兩两三四五六七八九十百千萬万';
// 關鍵 token：數字串 / 星期·周X·禮拜X / 時間詞。兩句的關鍵 token 多重集不同 → 不同事實
const KEY_RE = new RegExp(
    `(?:星期|禮拜|礼拜|周|週)[${NUM}日天]` +
    `|[${NUM}]+` +
    `|今天|明天|昨天|前天|後天|后天|今晚|昨晚|明晚|上午|下午|中午|早上|晚上|凌晨|傍晚|清晨|半夜|上週|下週|上周|下周|上個月|下個月|上个月|下个月|今年|去年|明年|週末|周末`,
    'gu'
);

function keyTokens(s) {
    return (s.match(KEY_RE) || []).sort().join('|');
}

/**
 * 近似重複：正規化後完全相同，或
 *   bigram Jaccard ≥ 0.8 且 關鍵 token 相同 且 差異 bigram 極少。
 * 保守：任一方獨有 bigram ≥2 → 不同；兩方都有獨有 bigram（=「換掉一個詞」）→ 不同。
 * 寧可不合並，也不要把「週三/週五」「貓/狗」「高雄/臺北」誤合併。
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
 * 在同實體的 active 候選裡找重複。candidates: [{id, content, content_hash, ...}]
 * 返回命中的候選或 null。
 */
function findDuplicate(entity, content, candidates) {
    const hash = normalizedContentHash(entity, content);
    for (const c of candidates) if (c.content_hash === hash) return c;
    for (const c of candidates) if (isNearDuplicate(content, c.content)) return c;
    return null;
}

module.exports = {
    normalizeText, validateQuote, filterEntriesByQuote, detectQuoteSource, isAiChitchat,
    normalizedContentHash, isNearDuplicate, findDuplicate,
    AI_QUOTE_TYPES, MAX_QUOTE_LEN,
};
