// utils/blindIndex.js — 全文盲索引（blind index）與帶金鑰的內容雜湊
//
// 記憶本體加密後，FTS 不能再存明文兩字組。做法：把每個索引 token（兩字組／英數詞）
// 用一把獨立金鑰做 HMAC-SHA256、截 16 hex 後才放進 FTS5；查詢時對查詢 token 做同樣的 HMAC，
// 再用 OR + bm25 排序。FTS5 只看得到不透明的 token，排名行為與明文兩字組相同。
//
// 金鑰：由 SANCTUARY_ENCRYPTION_KEY 以 HKDF-SHA256 衍生（info 固定字串），與 AES 金鑰分開，
// 不需要新的環境變數。每個 FTS 欄位（domain）再各自衍生一把子金鑰，
// 讓「同一個兩字組」在不同欄位產生不同 token（避免用明文欄位的 token 反推密文欄位）。
//
// 已知洩漏（盲索引的本質限制）：同一個兩字組在同一欄位永遠得到同一個 token，
// 所以看得到資料庫的人能統計 token 出現頻率、判斷哪些列共享同一個兩字組，
// 但看不到兩字組本身。
//
// 金鑰輪替（SANCTUARY_ENCRYPTION_KEY 換掉）後盲 token 全部改變，
// 必須重建 FTS——services/memoryCrypto.js 的 indexFingerprint 會在啟動時偵測並自動重建，
// scripts/rotate_memory_keys.js 也會重建。

const crypto = require('crypto');
const { toIndexTokenList, toQueryTokens } = require('./cjkTokenize');

const HKDF_SALT = Buffer.from('hippocampus-memory', 'utf8');
const INFO_BLIND = 'hippocampus-memory/fts-blind-index/v1';
const INFO_HASH = 'hippocampus-memory/content-hash/v1';
const TOKEN_HEX = 16;

let _cache = { keyHex: null, blind: null, hash: null, domains: new Map() };

function _masterKeyHex() {
    // 以 encryption 例項現用的金鑰為準（測試可能直接改例項），退回環境變數
    let hex;
    try { hex = require('../encryption').encryption.encryptionKey; } catch (_) { hex = null; }
    hex = hex || process.env.SANCTUARY_ENCRYPTION_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('盲索引：SANCTUARY_ENCRYPTION_KEY 無效');
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

// 單一 token → 盲 token（16 hex）
function blindToken(token, domain = 'default') {
    return crypto.createHmac('sha256', _domainKey(domain)).update(String(token), 'utf8').digest('hex').slice(0, TOKEN_HEX);
}

// 索引用：明文 → 以空白分隔的盲 token 字串（保留詞頻與順序）
function blindTokens(text, domain = 'default') {
    const toks = toIndexTokenList(text);
    if (toks.length === 0) return '';
    const dk = _domainKey(domain);
    return toks.map(t => crypto.createHmac('sha256', dk).update(t, 'utf8').digest('hex').slice(0, TOKEN_HEX)).join(' ');
}

// 查詢 token 陣列 → 盲 token 陣列（去重後順序不變）
function blindQueryTokens(tokens, domain = 'default') {
    const out = [];
    const seen = new Set();
    for (const t of tokens || []) {
        const b = blindToken(t, domain);
        if (!seen.has(b)) { seen.add(b); out.push(b); }
    }
    return out;
}

// 查詢用：明文 → FTS5 MATCH 字串（盲 token 以 OR 連線）；沒有可查內容回傳 null
// opts 同 toQueryTokens（stopChars／minWordLen）；opts.column 指定時每個 token 前加欄位過濾
function blindMatchQuery(text, domain = 'default', opts = {}) {
    const toks = blindQueryTokens(toQueryTokens(text, opts), domain);
    if (toks.length === 0) return null;
    const col = opts.column ? `${opts.column} : ` : '';
    return toks.map(t => `${col}"${t}"`).join(' OR ');
}

// 帶金鑰的內容雜湊（取代明文內容的 SHA-256，避免對短句做字典攻擊）
function keyedHash(str) {
    return crypto.createHmac('sha256', _keys().hash).update(String(str), 'utf8').digest('hex');
}

// 盲索引金鑰指紋：寫進資料庫，用來偵測「金鑰換了、索引還是舊 token」
function blindKeyFingerprint() {
    return crypto.createHmac('sha256', _keys().blind).update('fingerprint').digest('hex').slice(0, 16);
}

module.exports = { blindToken, blindTokens, blindQueryTokens, blindMatchQuery, keyedHash, blindKeyFingerprint, TOKEN_HEX };
