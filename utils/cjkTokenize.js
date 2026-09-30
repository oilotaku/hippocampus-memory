// utils/cjkTokenize.js — 中日韩文本的两字组（bigram）切分，FTS5 索引与查询共用
//
// 索引侧：连续 CJK 串切成重疊的两字组（「動畫片」→「動畫 畫片」），单字串保留单字，
//         非 CJK 词转小写原样保留，之后交给 FTS5 unicode61 断词器（以空白分隔）。
// 查询侧：同样切分，每个 token 加双引号、以 OR 连接，交给 bm25 排序。
// 为什么不用单字：「動畫」会命中所有含「動」或「畫」的碎片，噪声很大。
// 为什么不用 trigram：它查不到两字中文词。

const CJK_RUN_RE = /[㐀-䶿一-鿿豈-﫿]+/g;
const WORD_RE = /[\p{L}\p{N}_]+/gu;
const MAX_QUERY_TOKENS = 64;

function bigrams(run) {
    if (run.length <= 1) return [run];
    const out = [];
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    return out;
}

// 索引用：文本 → 以空白分隔的 token 字串（给 FTS5 unicode61 吃）
function toIndexTokens(text) {
    if (text === null || text === undefined) return '';
    const s = String(text);
    if (!s) return '';
    return s.replace(CJK_RUN_RE, run => ' ' + bigrams(run).join(' ') + ' ').toLowerCase();
}

// 索引用（token 陣列版）：与 toIndexTokens 的输出再经 FTS5 unicode61 断词后的结果一致
// （CJK 两字组 + 非 CJK 词转小写），保留重复与出现顺序（bm25 需要词频）。
// 盲索引（utils/blindIndex.js）用它逐个 token 做 HMAC；查询侧仍用 toQueryTokens，两边切法相同。
function toIndexTokenList(text) {
    if (text === null || text === undefined) return [];
    const s = String(text);
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

// 查询用：文本 → token 陣列（去重、保序）
// opts.stopChars: Set，整个 token 由停用字组成时丢弃（单字停用字、或两字都是停用字的 bigram）
// opts.minWordLen: 非 CJK 词的最短长度（预设 1）
function toQueryTokens(text, opts = {}) {
    if (text === null || text === undefined) return [];
    const s = String(text);
    if (!s) return [];
    const stop = opts.stopChars || null;
    const minWordLen = opts.minWordLen || 1;
    const seen = new Set();
    const tokens = [];
    const push = t => {
        if (!seen.has(t) && tokens.length < MAX_QUERY_TOKENS) { seen.add(t); tokens.push(t); }
    };
    // 先挖出 CJK 串，其余部分再按字词切
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

// 组成 FTS5 MATCH 字串；没有可查的内容时回传 null（呼叫端应直接跳过查询）
// token 只含字母／数字／下划线／CJK，加双引号后 OR/AND/NOT/NEAR、*、:、-、括号都只是字面。
function toMatchQuery(text, opts = {}) {
    const tokens = toQueryTokens(text, opts);
    if (tokens.length === 0) return null;
    return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

module.exports = { toIndexTokens, toIndexTokenList, toQueryTokens, toMatchQuery };
