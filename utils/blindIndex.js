// utils/blindIndex.js — 全文盲索引（blind index）与带金钥的内容杂凑
//
// 记忆本体加密后，FTS 不能再存明文两字组。做法：把每个索引 token（两字组／英数词）
// 用一把独立金钥做 HMAC-SHA256、截 16 hex 后才放进 FTS5；查询时对查询 token 做同样的 HMAC，
// 再用 OR + bm25 排序。FTS5 只看得到不透明的 token，排名行为与明文两字组相同。
//
// 金钥：由 SANCTUARY_ENCRYPTION_KEY 以 HKDF-SHA256 衍生（info 固定字串），与 AES 金钥分开，
// 不需要新的环境变数。每个 FTS 栏位（domain）再各自衍生一把子金钥，
// 让「同一个两字组」在不同栏位产生不同 token（避免用明文栏位的 token 反推密文栏位）。
//
// 已知洩漏（盲索引的本质限制）：同一个两字组在同一栏位永远得到同一个 token，
// 所以看得到资料库的人能统计 token 出现频率、判断哪些列共享同一个两字组，
// 但看不到两字组本身。
//
// 金钥轮替（SANCTUARY_ENCRYPTION_KEY 换掉）后盲 token 全部改变，
// 必须重建 FTS——services/memoryCrypto.js 的 indexFingerprint 会在启动时侦测并自动重建，
// scripts/rotate_memory_keys.js 也会重建。

const crypto = require('crypto');
const { toIndexTokenList, toQueryTokens } = require('./cjkTokenize');

const HKDF_SALT = Buffer.from('hippocampus-memory', 'utf8');
const INFO_BLIND = 'hippocampus-memory/fts-blind-index/v1';
const INFO_HASH = 'hippocampus-memory/content-hash/v1';
const TOKEN_HEX = 16;

let _cache = { keyHex: null, blind: null, hash: null, domains: new Map() };

function _masterKeyHex() {
    // 以 encryption 实例现用的金钥为准（测试可能直接改实例），退回环境变数
    let hex;
    try { hex = require('../encryption').encryption.encryptionKey; } catch (_) { hex = null; }
    hex = hex || process.env.SANCTUARY_ENCRYPTION_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('盲索引：SANCTUARY_ENCRYPTION_KEY 无效');
    return hex.toLowerCase();
}

function _keys() {
    const hex = _masterKeyHex();
    if (_cache.keyHex !== hex) {
        const ikm = Buffer.from(hex, 'hex');
        _cache = {
            keyHex: hex,
            blind: Buffer.from(crypto.hkdfSync('sha256', ikm, HKDF_SALT, INFO_BLIND, 32)),
            hash: Buffer.from(crypto.hkdfSync('sha256', ikm, HKDF_SALT, INFO_HASH, 32)),
            domains: new Map(),
        };
    }
    return _cache;
}

function _domainKey(domain) {
    const k = _keys();
    let dk = k.domains.get(domain);
    if (!dk) {
        dk = crypto.createHmac('sha256', k.blind).update('domain:' + String(domain)).digest();
        k.domains.set(domain, dk);
    }
    return dk;
}

// 单一 token → 盲 token（16 hex）
function blindToken(token, domain = 'default') {
    return crypto.createHmac('sha256', _domainKey(domain)).update(String(token), 'utf8').digest('hex').slice(0, TOKEN_HEX);
}

// 索引用：明文 → 以空白分隔的盲 token 字串（保留词频与顺序）
function blindTokens(text, domain = 'default') {
    const toks = toIndexTokenList(text);
    if (toks.length === 0) return '';
    const dk = _domainKey(domain);
    return toks.map(t => crypto.createHmac('sha256', dk).update(t, 'utf8').digest('hex').slice(0, TOKEN_HEX)).join(' ');
}

// 查询 token 陣列 → 盲 token 陣列（去重后顺序不变）
function blindQueryTokens(tokens, domain = 'default') {
    const out = [];
    const seen = new Set();
    for (const t of tokens || []) {
        const b = blindToken(t, domain);
        if (!seen.has(b)) { seen.add(b); out.push(b); }
    }
    return out;
}

// 查询用：明文 → FTS5 MATCH 字串（盲 token 以 OR 连接）；没有可查内容回传 null
// opts 同 toQueryTokens（stopChars／minWordLen）；opts.column 指定时每个 token 前加栏位过滤
function blindMatchQuery(text, domain = 'default', opts = {}) {
    const toks = blindQueryTokens(toQueryTokens(text, opts), domain);
    if (toks.length === 0) return null;
    const col = opts.column ? `${opts.column} : ` : '';
    return toks.map(t => `${col}"${t}"`).join(' OR ');
}

// 带金钥的内容杂凑（取代明文内容的 SHA-256，避免对短句做字典攻击）
function keyedHash(str) {
    return crypto.createHmac('sha256', _keys().hash).update(String(str), 'utf8').digest('hex');
}

// 盲索引金钥指纹：写进资料库，用来侦测「金钥换了、索引还是旧 token」
function blindKeyFingerprint() {
    return crypto.createHmac('sha256', _keys().blind).update('fingerprint').digest('hex').slice(0, 16);
}

module.exports = { blindToken, blindTokens, blindQueryTokens, blindMatchQuery, keyedHash, blindKeyFingerprint, TOKEN_HEX };
