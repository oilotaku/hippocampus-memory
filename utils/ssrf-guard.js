// =================================================================
// utils/ssrf-guard.js — SSRF（CWE-918）防護
//
// 規則：
//   1. 只允許 https，網址不可夾帶帳密（user:pass@）。
//   2. 先做 DNS 解析，解析出的「所有」IP 都必須是公網地址；私有/保留網段一律拒絕。
//      IP 寫法（十進位 2130706433、十六進位 0x7f.1、八進位 017700000001…）由 WHATWG URL
//      解析器統一正規化成點分十進位後才檢查；IPv6 手動解析成 8 個 hextet 後判斷，
//      IPv4-mapped（::ffff:a.b.c.d）、NAT64（64:ff9b::/96）、6to4（2002::/16）都會取出內嵌 IPv4 再判斷。
//   3. 禁止跟隨轉址（3xx 視為封鎖）——見 safeFetch。
//   4. 例外：環境變數 LLM_ENDPOINT_ALLOWLIST（逗號分隔的完整 origin，如 http://127.0.0.1:11434）。
//      只有 origin「完全相符」（scheme+host+port，先正規化）的端點可以是私有 IP 或 http，
//      絕不使用字串字首比對。預設為空 = 完全套用上述規則。
//
// 殘餘風險（DNS rebinding / TOCTOU）：
//   assertSafeEndpoint 驗證與實際連線是兩次 DNS 查詢，攻擊者可讓第二次查詢回內網 IP。
//   safeFetch 用 undici Agent 的 connect.lookup 把連線「釘」在驗證過的 IP 上（URL 主機名不變，
//   所以 Host 與 TLS SNI/證書驗證照常），可消除這個風險。但 services/llm.js 走 axios 或
//   經本機代理（127.0.0.1:7890）的路徑無法釘 IP：那些路徑只做「連線前驗證」，仍有極小的 rebinding 視窗；
//   經代理時目標主機的 DNS 解析發生在代理端。
// =================================================================

const dns = require('dns');
const net = require('net');

class SsrfError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SsrfError';
        this.code = 'SSRF_BLOCKED';
        this.status = 400;
    }
}

// ---------- IPv4 ----------
function parseIPv4(str) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(str);
    if (!m) return null;
    const p = m.slice(1).map(Number);
    return p.every(n => n <= 255) ? p : null;
}

// [起始, 字首長度]
const V4_BLOCKED = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([a, bits]) => [ipv4ToInt(parseIPv4(a)), bits]);

function ipv4ToInt(p) { return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; }

function isBlockedIPv4Parts(p) {
    const n = ipv4ToInt(p);
    return V4_BLOCKED.some(([base, bits]) => {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return ((n & mask) >>> 0) === ((base & mask) >>> 0);
    });
}

// ---------- IPv6 ----------
// 回傳 8 個 hextet（數字）或 null
function parseIPv6(str) {
    let s = str.toLowerCase();
    const zone = s.indexOf('%');
    if (zone !== -1) s = s.slice(0, zone);
    if (!/^[0-9a-f:.]+$/.test(s)) return null;
    // 結尾內嵌 IPv4 → 轉成兩個 hextet
    const lastColon = s.lastIndexOf(':');
    if (lastColon === -1) return null;
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
        const v4 = parseIPv4(tail);
        if (!v4) return null;
        s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const toGroups = (t) => (t === '' ? [] : t.split(':'));
    const head = toGroups(halves[0]);
    const rest = halves.length === 2 ? toGroups(halves[1]) : [];
    let groups;
    if (halves.length === 2) {
        const missing = 8 - head.length - rest.length;
        if (missing < 1) return null;
        groups = [...head, ...Array(missing).fill('0'), ...rest];
    } else {
        groups = head;
    }
    if (groups.length !== 8) return null;
    const out = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
    }
    return out;
}

function embeddedV4(h6, a, b) { // 取 h6[a],h6[b] 兩個 hextet 為 IPv4
    return [h6[a] >> 8, h6[a] & 255, h6[b] >> 8, h6[b] & 255];
}

function isBlockedIPv6Parts(h) {
    const firstFiveZero = h.slice(0, 5).every(x => x === 0);
    if (firstFiveZero && h[5] === 0xffff) return isBlockedIPv4Parts(embeddedV4(h, 6, 7)); // IPv4-mapped
    // NAT64 64:ff9b::/96
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every(x => x === 0)) return isBlockedIPv4Parts(embeddedV4(h, 6, 7));
    // 6to4 2002::/16
    if (h[0] === 0x2002) return isBlockedIPv4Parts(embeddedV4(h, 1, 2));
    // 只放行全球單播 2000::/3，再剔除特殊用途段
    if ((h[0] & 0xe000) !== 0x2000) return true; // ::、::1、fc00::/7、fe80::/10、fec0::/10、ff00::/8、::/8 等全部落在這裡
    if (h[0] === 0x2001 && h[1] === 0x0000) return true;      // Teredo 2001::/32
    if (h[0] === 0x2001 && h[1] === 0x0db8) return true;      // 文件用 2001:db8::/32
    if (h[0] === 0x2001 && h[1] < 0x0200) return true;        // IETF 保留 2001::/23
    if (h[0] === 0x3fff && h[1] < 0x1000) return true;        // 文件用 3fff::/20
    return false;
}

/** 該 IP 字串是否屬於私有/保留網段（無法解析的一律視為封鎖） */
function isBlockedIP(ip) {
    if (typeof ip !== 'string') return true;
    let s = ip.trim();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    const v4 = parseIPv4(s);
    if (v4) return isBlockedIPv4Parts(v4);
    const v6 = parseIPv6(s);
    if (v6) return isBlockedIPv6Parts(v6);
    return true;
}

// ---------- 白名單 ----------
function normalizeOrigin(str) {
    try {
        const u = new URL(String(str).trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.username || u.password) return null;
        return u.origin.toLowerCase(); // URL 已小寫 host、去掉預設 port
    } catch { return null; }
}

function parseAllowlist(value) {
    if (Array.isArray(value)) value = value.join(',');
    if (!value) return [];
    return String(value).split(',').map(normalizeOrigin).filter(Boolean);
}

function getAllowlist(opts) {
    if (opts && opts.allowlist !== undefined) return parseAllowlist(opts.allowlist);
    return parseAllowlist(process.env.LLM_ENDPOINT_ALLOWLIST);
}

// ---------- DNS ----------
async function defaultResolver(hostname) {
    const res = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return res.map(r => r.address);
}

async function resolveAll(hostname, resolver) {
    const raw = await (resolver || defaultResolver)(hostname);
    const list = (Array.isArray(raw) ? raw : [raw]).map(r => (typeof r === 'string' ? r : r && r.address)).filter(Boolean);
    if (list.length === 0) throw new SsrfError(`無法解析主機名：${hostname}`);
    return list;
}

/**
 * 驗證端點是否安全。通過時回傳 { url, addresses, allowlisted }，失敗拋 SsrfError（status 400）。
 * @param {string} endpoint
 * @param {{resolver?: (host:string)=>Promise<Array<string|{address:string}>>, allowlist?: string|string[]}} [opts]
 */
async function assertSafeEndpoint(endpoint, opts = {}) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) throw new SsrfError('端點不能為空');
    let url;
    try { url = new URL(endpoint.trim()); } catch { throw new SsrfError('端點不是合法的網址'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfError('端點只允許 http(s) 協議');
    if (url.username || url.password) throw new SsrfError('端點網址不可包含帳號密碼');

    const allowlisted = getAllowlist(opts).includes(url.origin.toLowerCase());
    if (url.protocol !== 'https:' && !allowlisted) throw new SsrfError('端點必須使用 HTTPS');

    let host = url.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    host = host.replace(/\.+$/, '');

    const isLiteral = net.isIP(host) !== 0 || parseIPv4(host) !== null;
    if (isLiteral) {
        if (!allowlisted && isBlockedIP(host)) throw new SsrfError('端點指向私有或保留地址，已被阻止');
        return { url, addresses: [host], allowlisted };
    }
    if (!allowlisted && (host === 'localhost' || host.endsWith('.localhost'))) {
        throw new SsrfError('端點指向私有或保留地址，已被阻止');
    }
    const addresses = await resolveAll(host, opts.resolver);
    if (!allowlisted && addresses.some(isBlockedIP)) {
        throw new SsrfError('端點解析到私有或保留地址，已被阻止');
    }
    return { url, addresses, allowlisted };
}

// ---------- URL 拼接 ----------
/**
 * 把 suffix 接在 endpoint 的路徑之後（保留 endpoint 自帶的路徑，如 /v1beta），
 * 不像 new URL('/models/x', endpoint) 會吃掉 endpoint 的路徑。
 * suffix 裡的 ? # 會被當成路徑字元編碼，不會改變主機或查詢。
 * query 為物件時以 searchParams 附加（自動編碼）。
 */
function joinEndpointPath(endpoint, suffix, query) {
    const u = new URL(endpoint);
    const base = u.pathname.replace(/\/+$/, '');
    const tail = String(suffix || '').replace(/^\/+/, '');
    u.pathname = tail ? `${base}/${tail}` : (base || '/');
    u.search = '';
    u.hash = '';
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
}

// ---------- 釘 IP 連線 ----------
function createPinnedDispatcher(addresses) {
    const { Agent } = require('undici');
    let i = 0;
    return new Agent({
        keepAliveTimeout: 1000, // 一次性連線，不長時間佔用 socket
        connect: {
            lookup: (hostname, options, cb) => {
                if (typeof options === 'function') { cb = options; options = {}; }
                const list = addresses.map(a => ({ address: a, family: net.isIP(a) || 4 }));
                if (options && options.all) return cb(null, list);
                const pick = list[i++ % list.length];
                cb(null, pick.address, pick.family);
            },
        },
    });
}

/**
 * 驗證 + 釘 IP + 禁止轉址的 fetch。3xx 回應一律拋 SsrfError。
 */
async function safeFetch(url, options = {}, guardOpts = {}) {
    const { addresses } = await assertSafeEndpoint(url, guardOpts);
    const dispatcher = createPinnedDispatcher(addresses);
    try {
        const resp = await fetch(url, { ...options, redirect: 'manual', dispatcher });
        if ((resp.status >= 300 && resp.status < 400) || resp.type === 'opaqueredirect') {
            try { await resp.body?.cancel(); } catch { /* ignore */ }
            throw new SsrfError('端點回應轉址（3xx），為防止 SSRF 已阻止');
        }
        return resp; // dispatcher 不主動 close：body 尚未讀完，keepAliveTimeout 到期後自動釋放
    } catch (e) {
        dispatcher.close().catch(() => {});
        throw e;
    }
}

module.exports = {
    SsrfError, assertSafeEndpoint, joinEndpointPath, safeFetch, createPinnedDispatcher,
    isBlockedIP, parseAllowlist, normalizeOrigin,
};
