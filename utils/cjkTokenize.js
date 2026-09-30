// utils/cjkTokenize.js — 中日韓文本的兩字組（bigram）切分，FTS5 索引與查詢共用
//
// 索引側：連續 CJK 串切成重疊的兩字組（「動畫片」→「動畫 畫片」），單字串保留單字，
//         非 CJK 詞轉小寫原樣保留，之後交給 FTS5 unicode61 斷詞器（以空白分隔）。
// 查詢側：同樣切分，每個 token 加雙引號、以 OR 連線，交給 bm25 排序。
// 為什麼不用單字：「動畫」會命中所有含「動」或「畫」的碎片，噪聲很大。
// 為什麼不用 trigram：它查不到兩字中文詞。

const { toTraditionalChars } = require('./zhNormalize');

// 斷詞版本：索引指紋（services/memoryCrypto.js）會納入它，斷詞規則變動時既有資料庫下次啟動自動重建索引。
// v2-t：斷詞前先做逐字簡→繁正規化（簡體內容可被繁體查詢命中，反之亦然）。
const TOKENIZER_VERSION = 'cjk-bigram-v2-t';

const CJK_RUN_RE = /[㐀-䶿一-鿿豈-﫿]+/g;
const WORD_RE = /[\p{L}\p{N}_]+/gu;
const MAX_QUERY_TOKENS = 64;

function bigrams(run) {
    if (run.length <= 1) return [run];
    const out = [];
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    return out;
}

// 索引用：文本 → 以空白分隔的 token 字串（給 FTS5 unicode61 吃）
function toIndexTokens(text) {
    if (text === null || text === undefined) return '';
    const s = toTraditionalChars(text);
    if (!s) return '';
    return s.replace(CJK_RUN_RE, run => ' ' + bigrams(run).join(' ') + ' ').toLowerCase();
}

// 索引用（token 陣列版）：與 toIndexTokens 的輸出再經 FTS5 unicode61 斷詞後的結果一致
// （CJK 兩字組 + 非 CJK 詞轉小寫），保留重複與出現順序（bm25 需要詞頻）。
// 盲索引（utils/blindIndex.js）用它逐個 token 做 HMAC；查詢側仍用 toQueryTokens，兩邊切法相同。
function toIndexTokenList(text) {
    if (text === null || text === undefined) return [];
    const s = toTraditionalChars(text);
    if (!s) return [];
    const out = [];
    let last = 0;
    const words = (seg) => { for (const w of seg.toLowerCase().match(WORD_RE) || []) out.push(w); };
    for (const m of s.matchAll(CJK_RUN_RE)) {
        words(s.slice(last, m.index));
        out.push(...bigrams(m[0]));
        last = m.index + m[0].length;
    }
    words(s.slice(last));
    return out;
}

// 停用字集合也要正規化成同一套字形（呼叫端的集合可能混有簡體或異體字）；以 WeakMap 快取
const _stopCache = new WeakMap();
function normalizedStop(stop) {
    let n = _stopCache.get(stop);
    if (!n) {
        n = new Set();
        for (const ch of stop) n.add(toTraditionalChars(ch));
        _stopCache.set(stop, n);
    }
    return n;
}

// 查詢用：文本 → token 陣列（去重、保序）
// opts.stopChars: Set，整個 token 由停用字組成時丟棄（單字停用字、或兩字都是停用字的 bigram）
// opts.minWordLen: 非 CJK 詞的最短長度（預設 1）
function toQueryTokens(text, opts = {}) {
    if (text === null || text === undefined) return [];
    const s = toTraditionalChars(text);
    if (!s) return [];
    const stop = opts.stopChars ? normalizedStop(opts.stopChars) : null;
    const minWordLen = opts.minWordLen || 1;
    const seen = new Set();
    const tokens = [];
    const push = t => {
        if (!seen.has(t) && tokens.length < MAX_QUERY_TOKENS) { seen.add(t); tokens.push(t); }
    };
    // 先挖出 CJK 串，其餘部分再按字詞切
    const rest = s.replace(CJK_RUN_RE, run => {
        for (const bg of bigrams(run)) {
            if (stop && [...bg].every(ch => stop.has(ch))) continue;
            push(bg);
        }
        return ' ';
    });
    for (const w of rest.toLowerCase().match(WORD_RE) || []) {
        if (w.length >= minWordLen) push(w);
    }
    return tokens;
}

// 組成 FTS5 MATCH 字串；沒有可查的內容時回傳 null（呼叫端應直接跳過查詢）
// token 只含字母／數字／下劃線／CJK，加雙引號後 OR/AND/NOT/NEAR、*、:、-、括號都只是字面。
function toMatchQuery(text, opts = {}) {
    const tokens = toQueryTokens(text, opts);
    if (tokens.length === 0) return null;
    return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

module.exports = { TOKENIZER_VERSION, toIndexTokens, toIndexTokenList, toQueryTokens, toMatchQuery };
