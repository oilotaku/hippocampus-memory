// =================================================================
// utils/ssrf-guard.js — SSRF（CWE-918）防护
//
// 规则：
//   1. 只允许 https，网址不可夹带帐密（user:pass@）。
//   2. 先做 DNS 解析，解析出的「所有」IP 都必须是公网地址；私有/保留网段一律拒绝。
//      IP 写法（十进位 2130706433、十六进位 0x7f.1、八进位 017700000001…）由 WHATWG URL
//      解析器统一正规化成点分十进位后才检查；IPv6 手动解析成 8 个 hextet 后判断，
//      IPv4-mapped（::ffff:a.b.c.d）、NAT64（64:ff9b::/96）、6to4（2002::/16）都会取出内嵌 IPv4 再判断。
//   3. 禁止跟随转址（3xx 视为封锁）——见 safeFetch。
//   4. 例外：环境变量 LLM_ENDPOINT_ALLOWLIST（逗号分隔的完整 origin，如 http://127.0.0.1:11434）。
//      只有 origin「完全相符」（scheme+host+port，先正规化）的端点可以是私有 IP 或 http，
//      绝不使用字串前缀比对。预设为空 = 完全套用上述规则。
//
// 残余风险（DNS rebinding / TOCTOU）：
//   assertSafeEndpoint 验证与实际连线是两次 DNS 查询，攻击者可让第二次查询回内网 IP。
//   safeFetch 用 undici Agent 的 connect.lookup 把连线「钉」在验证过的 IP 上（URL 主机名不变，
//   所以 Host 与 TLS SNI/证书验证照常），可消除这个风险。但 services/llm.js 走 axios 或
//   经本机代理（127.0.0.1:7890）的路径无法钉 IP：那些路径只做「连线前验证」，仍有极小的 rebinding 窗口；
//   经代理时目标主机的 DNS 解析发生在代理端。
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

// [起始, 前缀长度]
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
// 回传 8 个 hextet（数字）或 null
function parseIPv6(str) {
    let s = str.toLowerCase();
    const zone = s.indexOf('%');
    if (zone !== -1) s = s.slice(0, zone);
    if (!/^[0-9a-f:.]+$/.test(s)) return null;
    // 结尾内嵌 IPv4 → 转成两个 hextet
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

function embeddedV4(h6, a, b) { // 取 h6[a],h6[b] 两个 hextet 为 IPv4
    return [h6[a] >> 8, h6[a] & 255, h6[b] >> 8, h6[b] & 255];
}

function isBlockedIPv6Parts(h) {
    const firstFiveZero = h.slice(0, 5).every(x => x === 0);
    if (firstFiveZero && h[5] === 0xffff) return isBlockedIPv4Parts(embeddedV4(h, 6, 7)); // IPv4-mapped
    // NAT64 64:ff9b::/96
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every(x => x === 0)) return isBlockedIPv4Parts(embeddedV4(h, 6, 7));
    // 6to4 2002::/16
    if (h[0] === 0x2002) return isBlockedIPv4Parts(embeddedV4(h, 1, 2));
    // 只放行全球单播 2000::/3，再剔除特殊用途段
    if ((h[0] & 0xe000) !== 0x2000) return true; // ::、::1、fc00::/7、fe80::/10、fec0::/10、ff00::/8、::/8 等全部落在这里
    if (h[0] === 0x2001 && h[1] === 0x0000) return true;      // Teredo 2001::/32
    if (h[0] === 0x2001 && h[1] === 0x0db8) return true;      // 文档用 2001:db8::/32
    if (h[0] === 0x2001 && h[1] < 0x0200) return true;        // IETF 保留 2001::/23
    if (h[0] === 0x3fff && h[1] < 0x1000) return true;        // 文档用 3fff::/20
    return false;
}

/** 该 IP 字串是否属于私有/保留网段（无法解析的一律视为封锁） */
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

// ---------- 白名单 ----------
function normalizeOrigin(str) {
    try {
        const u = new URL(String(str).trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.username || u.password) return null;
        return u.origin.toLowerCase(); // URL 已小写 host、去掉预设 port
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
    if (list.length === 0) throw new SsrfError(`无法解析主机名：${hostname}`);
    return list;
}

/**
 * 验证端点是否安全。通过时回传 { url, addresses, allowlisted }，失败抛 SsrfError（status 400）。
 * @param {string} endpoint
 * @param {{resolver?: (host:string)=>Promise<Array<string|{address:string}>>, allowlist?: string|string[]}} [opts]
 */
async function assertSafeEndpoint(endpoint, opts = {}) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) throw new SsrfError('端点不能为空');
    let url;
    try { url = new URL(endpoint.trim()); } catch { throw new SsrfError('端点不是合法的网址'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfError('端点只允许 http(s) 协议');
    if (url.username || url.password) throw new SsrfError('端点网址不可包含帐号密码');

    const allowlisted = getAllowlist(opts).includes(url.origin.toLowerCase());
    if (url.protocol !== 'https:' && !allowlisted) throw new SsrfError('端点必须使用 HTTPS');

    let host = url.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    host = host.replace(/\.+$/, '');

    const isLiteral = net.isIP(host) !== 0 || parseIPv4(host) !== null;
    if (isLiteral) {
        if (!allowlisted && isBlockedIP(host)) throw new SsrfError('端点指向私有或保留地址，已被阻止');
        return { url, addresses: [host], allowlisted };
    }
    if (!allowlisted && (host === 'localhost' || host.endsWith('.localhost'))) {
        throw new SsrfError('端点指向私有或保留地址，已被阻止');
    }
    const addresses = await resolveAll(host, opts.resolver);
    if (!allowlisted && addresses.some(isBlockedIP)) {
        throw new SsrfError('端点解析到私有或保留地址，已被阻止');
    }
    return { url, addresses, allowlisted };
}

// ---------- URL 拼接 ----------
/**
 * 把 suffix 接在 endpoint 的路径之后（保留 endpoint 自带的路径，如 /v1beta），
 * 不像 new URL('/models/x', endpoint) 会吃掉 endpoint 的路径。
 * suffix 里的 ? # 会被当成路径字符编码，不会改变主机或查询。
 * query 为物件时以 searchParams 附加（自动编码）。
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

// ---------- 钉 IP 连线 ----------
function createPinnedDispatcher(addresses) {
    const { Agent } = require('undici');
    let i = 0;
    return new Agent({
        keepAliveTimeout: 1000, // 一次性连线，不长时间占用 socket
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
 * 验证 + 钉 IP + 禁止转址的 fetch。3xx 回应一律抛 SsrfError。
 */
async function safeFetch(url, options = {}, guardOpts = {}) {
    const { addresses } = await assertSafeEndpoint(url, guardOpts);
    const dispatcher = createPinnedDispatcher(addresses);
    try {
        const resp = await fetch(url, { ...options, redirect: 'manual', dispatcher });
        if ((resp.status >= 300 && resp.status < 400) || resp.type === 'opaqueredirect') {
            try { await resp.body?.cancel(); } catch { /* ignore */ }
            throw new SsrfError('端点回应转址（3xx），为防止 SSRF 已阻止');
        }
        return resp; // dispatcher 不主动 close：body 尚未读完，keepAliveTimeout 到期后自动释放
    } catch (e) {
        dispatcher.close().catch(() => {});
        throw e;
    }
}

module.exports = {
    SsrfError, assertSafeEndpoint, joinEndpointPath, safeFetch, createPinnedDispatcher,
    isBlockedIP, parseAllowlist, normalizeOrigin,
};
