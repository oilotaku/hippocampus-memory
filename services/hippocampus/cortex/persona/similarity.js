// services/persona/similarity.js — 兩段回答的相似度：優先嵌入餘弦，嵌入不可用時退回兩字組 Jaccard。
const { toTraditionalChars } = require('../../../../utils/zhNormalize');

function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return null;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function bigrams(text) {
    const t = Array.from(toTraditionalChars(String(text || '')).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase());
    const set = new Set();
    if (t.length === 1) set.add(t[0]);
    for (let i = 0; i < t.length - 1; i++) set.add(t[i] + t[i + 1]);
    return set;
}

/** 兩字組 Jaccard（簡繁逐字正規化後比對）。兩邊都空 = 1。 */
function bigramJaccard(a, b) {
    const x = bigrams(a), y = bigrams(b);
    if (x.size === 0 && y.size === 0) return 1;
    let inter = 0;
    for (const g of x) if (y.has(g)) inter++;
    const union = x.size + y.size - inter;
    return union === 0 ? 1 : inter / union;
}

module.exports = { cosine, bigramJaccard };
