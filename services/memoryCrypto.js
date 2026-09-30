// services/memoryCrypto.js — 记忆本体静态加密（W3）
//
// 范围（MEMORY_ENCRYPTION=on，预设）：
//   memory_fragments.content / quote
//   memories.content / title
//   entity_profiles.facts / current_status / judgment / overview
// 刻意不加密：entity_profiles.name 与 aliases（实体比对、星图、SQL 以名字 JOIN/比对都需要明文）、
//   memory_fragments.entity（同理）、tags。
//
// 写入：所有写这些栏位的地方一律经过 sealField(表, 栏, 值)。
//   on  → AES-256-GCM（encryption.js v2），AAD = "表:栏"（插入时还没有 id，见下方取舍说明）
//   off → 原样写明文（行为与加密功能上线前相同）
// 读取：wrapDatabase(db) 把 db.prepare 包一层——凡是结果栏位的「来源」是上述栏位
//   （better-sqlite3 的 stmt.columns() 给出 table/column，别名也追得到），值是 enc: 开头就解密。
//   所以全专案的 SELECT 不必逐一改；解密失败回 null（绝不回 enc: 字串，也绝不写回）。
//   两种模式读取端相同：是 enc: 就解密，否则原样 → 明文与密文可以并存。
// 全文索引：FTS 触发器改呼叫 mem_fts(domain, aad, 值)——在 JS 端解密后，
//   on 产生盲 token（utils/blindIndex.js），off 产生原本的两字组；查询端用 fragmentsMatchQuery／
//   memoriesMatchQuery 依模式产生对应的 MATCH 字串。所以写入点不必管索引。
// SQL 文字操作：LIKE / length 对密文无意义，改用 mem_like(aad, 值, 样式)／mem_len(aad, 值)。
//
// AAD 取舍：绑「表:栏」而非「表:栏:id」。INSERT 当下没有 id，要做到逐列绑定得把每个写入点
//   改成「先插入再回填」或集中改写，改动面太大。残余风险：同表同栏的密文在列之间可互换
//   （能写资料库的人可以把 A 碎片的 content 密文搬到 B 碎片，解密会成功）；跨栏／跨表搬动会被 AAD 挡下。

const { encryption } = require('../encryption');
const { toIndexTokens } = require('../utils/cjkTokenize');
const blind = require('../utils/blindIndex');

const FIELDS = Object.freeze({
    memory_fragments: Object.freeze(['content', 'quote']),
    memories: Object.freeze(['content', 'title']),
    entity_profiles: Object.freeze(['facts', 'current_status', 'judgment', 'overview']),
});

const AAD_SET = new Set();
const NAME_CANDIDATES = new Map();   // 栏位名 → 可能的 AAD（用于来源不明的运算式栏位）
for (const [t, cols] of Object.entries(FIELDS)) {
    for (const c of cols) {
        const aad = `${t}:${c}`;
        AAD_SET.add(aad);
        if (!NAME_CANDIDATES.has(c)) NAME_CANDIDATES.set(c, []);
        NAME_CANDIDATES.get(c).push(aad);
    }
}

// FTS 栏位的盲索引 domain（每栏一把子金钥）
const DOMAIN_MF_CONTENT = 'memory_fragments_fts.content';
const DOMAIN_MEM_TITLE = 'memories_fts.title';

let _warnedMode = false;
function isEnabled() {
    const raw = process.env.MEMORY_ENCRYPTION;
    const v = String(raw === undefined ? 'on' : raw).trim().toLowerCase();
    if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false;
    if (!['on', '1', 'true', 'yes', ''].includes(v) && !_warnedMode) {
        _warnedMode = true;
        console.warn(`[memoryCrypto] MEMORY_ENCRYPTION=${raw} 无法辨识，按 on 处理（fail-closed）`);
    }
    return true;
}

function aadFor(table, col) {
    const aad = `${table}:${col}`;
    if (!AAD_SET.has(aad)) throw new Error(`memoryCrypto: ${aad} 不在加密栏位清单内`);
    return aad;
}

function isEncryptedField(table, col) {
    return AAD_SET.has(`${table}:${col}`);
}

// 写入前呼叫。非字串／空字串原样回传（'' 保持 ''，SQL 的 != '' 判断不受影响）。
// 加密失败抛 EncryptionError（fail-closed：宁可写入失败，也不写明文）。
function sealField(table, col, value) {
    const aad = aadFor(table, col);
    if (!isEnabled()) return value;
    if (typeof value !== 'string' || value === '') return value;
    return encryption.encrypt(value, { aad });
}

// ── 解密（带快取） ──
// 快取键含 AAD：同一密文换个栏位读，不会因为命中快取而绕过 AAD 检查。
const CACHE_MAX = 20000;   // 约 2 万列的全表 mem_like 扫描也能全部命中快取
const _cache = new Map();
function _cacheGet(k) { return _cache.get(k); }
function _cacheSet(k, v) {
    if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
    _cache.set(k, v);
}
function clearCache() { _cache.clear(); }

let _failCount = 0;
function _warnFail(aad) {
    _failCount++;
    if (_failCount <= 5 || _failCount % 100 === 0) {
        console.warn(`[memoryCrypto] ${aad} 解密失败（金钥/AAD 不符或资料被窜改），以 null 处理（累计 ${_failCount} 次）`);
    }
}

// 解密一个值。回传 { ok, value, legacy }：legacy=true 表示是没有 AAD 的旧密文（v1 或无 AAD 的 v2）。
function _open(aad, value, { allowLegacy = true } = {}) {
    if (typeof value !== 'string' || !value.startsWith('enc:')) return { ok: true, value, legacy: false, plain: true };
    const ck = aad + '\u0000' + value;
    const hit = _cacheGet(ck);
    if (hit) return hit;
    let out = encryption.decrypt(value, { aad, silent: true });
    let legacy = false;
    if (out === null && allowLegacy) {
        // 加密功能上线前 routes/memory-api.js 就会以「无 AAD」加密 memories.content；v1 本来就没有 AAD。
        // 新写入的密文一律带 AAD，所以这个退路不会让「搬到别栏的新密文」解开。
        out = encryption.decrypt(value, { silent: true });
        legacy = out !== null;
    } else if (out !== null && !value.startsWith('enc:v2:')) {
        legacy = true;   // v1：decrypt 会忽略 aad
    }
    const r = out === null ? { ok: false, value: null, legacy: false } : { ok: true, value: out, legacy };
    if (r.ok) _cacheSet(ck, r);
    return r;
}

// 读取后呼叫：是 enc: 就解密，否则原样。解密失败回 null（并记一笔警告）。
function openField(table, col, value) {
    const aad = aadFor(table, col);
    const r = _open(aad, value);
    if (!r.ok) { _warnFail(aad); return null; }
    return r.value;
}

// ── 透明解密：包装 db.prepare ──
function _planFor(stmt) {
    let cols;
    try { cols = stmt.columns(); } catch (_) { return null; }
    const plan = [];
    let any = false;
    for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        let entry = null;
        if (c.table && c.column) {
            const aad = `${c.table}:${c.column}`;
            if (AAD_SET.has(aad)) entry = { name: c.name, strict: true, aad };
        } else if (NAME_CANDIDATES.has(c.name)) {
            // 运算式栏位（COALESCE(...) AS content 之类）：来源不明，只试同名栏位的 AAD，
            // 解不开就原样放行（可能根本不是记忆栏位，例如 messages 的内容）
            entry = { name: c.name, strict: false, aads: NAME_CANDIDATES.get(c.name) };
        }
        plan.push(entry);
        if (entry) any = true;
    }
    return any ? plan : null;
}

function _fixValue(v, entry) {
    if (!entry || typeof v !== 'string' || !v.startsWith('enc:')) return v;
    if (entry.strict) {
        const r = _open(entry.aad, v);
        if (!r.ok) { _warnFail(entry.aad); return null; }
        return r.value;
    }
    for (const aad of entry.aads) {
        const r = _open(aad, v, { allowLegacy: false });
        if (r.ok) return r.value;
    }
    return v;
}

function wrapStatement(stmt) {
    const plan = _planFor(stmt);
    if (!plan) return stmt;
    const byName = new Map();
    plan.forEach(e => { if (e) byName.set(e.name, e); });   // 同名栏位：物件模式下后者覆盖前者
    let mode = 'object';
    const fixRow = (row) => {
        if (row === undefined || row === null) return row;
        if (mode === 'pluck') return _fixValue(row, plan[0]);
        if (mode === 'raw') { for (let i = 0; i < plan.length; i++) if (plan[i]) row[i] = _fixValue(row[i], plan[i]); return row; }
        if (mode === 'expand') {
            for (const sub of Object.values(row)) {
                if (sub && typeof sub === 'object') for (const k of Object.keys(sub)) if (byName.has(k)) sub[k] = _fixValue(sub[k], byName.get(k));
            }
            return row;
        }
        for (const [k, e] of byName) if (k in row) row[k] = _fixValue(row[k], e);
        return row;
    };
    const setMode = (m, on) => { if (on === false) { if (mode === m) mode = 'object'; } else mode = m; };
    let proxy;
    proxy = new Proxy(stmt, {
        get(target, prop) {
            switch (prop) {
                case 'get': return (...a) => fixRow(target.get(...a));
                case 'all': return (...a) => { const rows = target.all(...a); for (let i = 0; i < rows.length; i++) rows[i] = fixRow(rows[i]); return rows; };
                case 'iterate': return function* (...a) { for (const r of target.iterate(...a)) yield fixRow(r); };
                case 'pluck': case 'raw': case 'expand':
                    return (on) => { const v = on === undefined ? true : on; target[prop](v); setMode(prop, v); return proxy; };
                case 'bind': case 'safeIntegers':
                    return (...a) => { target[prop](...a); return proxy; };
                default: {
                    const v = Reflect.get(target, prop, target);
                    return typeof v === 'function' ? v.bind(target) : v;
                }
            }
        },
    });
    return proxy;
}

// ── SQL 函式 ──
function _plainOf(aad, value) {
    if (value === null || value === undefined) return null;
    const r = _open(aad, String(value));
    if (!r.ok) { _warnFail(aad); return null; }
    return r.value;
}

function indexTokensFor(domain, aad, value) {
    const plain = _plainOf(aad, value);
    if (plain === null || plain === '') return '';
    return isEnabled() ? blind.blindTokens(plain, domain) : toIndexTokens(plain);
}

const _likeCache = new Map();
const _asciiLower = (s) => s.replace(/[A-Z]/g, ch => ch.toLowerCase());
function _likeRegex(pattern) {
    let re = _likeCache.get(pattern);
    if (re) return re;
    let src = '';
    for (const ch of _asciiLower(pattern)) {
        if (ch === '%') src += '[\\s\\S]*';
        else if (ch === '_') src += '[\\s\\S]';
        else src += ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    }
    re = new RegExp('^' + src + '$', 'u');
    if (_likeCache.size > 500) _likeCache.clear();
    _likeCache.set(pattern, re);
    return re;
}

// 与 SQLite 预设 LIKE 相同语义：% 任意长度、_ 单一字元、只对 ASCII 不分大小写、NULL 回 NULL
function sqlLike(plain, pattern) {
    if (plain === null || plain === undefined || pattern === null || pattern === undefined) return null;
    return _likeRegex(String(pattern)).test(_asciiLower(String(plain))) ? 1 : 0;
}

function registerSqlFunctions(db) {
    db.function('mem_fts', (domain, aad, value) => indexTokensFor(domain, aad, value));
    db.function('mem_like', (aad, value, pattern) => {
        if (value === null || value === undefined) return null;
        const plain = _plainOf(aad, value);
        if (plain === null) return 0;
        return sqlLike(plain, pattern);
    });
    db.function('mem_len', (aad, value) => {
        if (value === null || value === undefined) return null;
        const plain = _plainOf(aad, value);
        if (plain === null) return 0;
        return [...String(plain)].length;
    });
}

function wrapDatabase(db) {
    if (db.__memoryCryptoWrapped) return db;
    const orig = db.prepare.bind(db);
    db.prepare = function (...args) {
        const st = orig(...args);
        return st.reader ? wrapStatement(st) : st;
    };
    Object.defineProperty(db, '__memoryCryptoWrapped', { value: true });
    registerSqlFunctions(db);
    return db;
}

// ── 查询端：MATCH 字串 ──
const quoteTok = (t) => `"${String(t).replace(/"/g, '""')}"`;

// tokens：toQueryTokens 的输出（librarian 的 tokenizeCJK）
function fragmentsMatchQuery(tokens) {
    if (!tokens || tokens.length === 0) return null;
    if (!isEnabled()) return tokens.map(quoteTok).join(' OR ');
    const parts = blind.blindQueryTokens(tokens, DOMAIN_MF_CONTENT).map(b => `content : "${b}"`);
    for (const t of tokens) parts.push(`entity : ${quoteTok(t)}`);
    return parts.join(' OR ');
}

function memoriesMatchQuery(tokens) {
    if (!tokens || tokens.length === 0) return null;
    if (!isEnabled()) return tokens.map(quoteTok).join(' OR ');
    const parts = blind.blindQueryTokens(tokens, DOMAIN_MEM_TITLE).map(b => `title : "${b}"`);
    for (const t of tokens) parts.push(`tags_text : ${quoteTok(t)}`);
    return parts.join(' OR ');
}

// ── 触发器／索引重建／整批加密 ──
const TAGS_EXPR = (c) => `COALESCE(REPLACE(REPLACE(REPLACE(REPLACE(${c}, '["', ''), '"]', ''), '","', ' '), '"', ''), '')`;
const MF_IDX = (row) => `mem_fts('${DOMAIN_MF_CONTENT}', 'memory_fragments:content', ${row}.content)`;
const MEM_IDX = (row) => `mem_fts('${DOMAIN_MEM_TITLE}', 'memories:title', COALESCE(${row}.title, ''))`;

const TRIGGERS_SQL = `
    DROP TRIGGER IF EXISTS mf_fts_insert;
    DROP TRIGGER IF EXISTS mf_fts_update;
    DROP TRIGGER IF EXISTS mf_fts_delete;
    DROP TRIGGER IF EXISTS memories_fts_insert;
    DROP TRIGGER IF EXISTS memories_fts_update;
    DROP TRIGGER IF EXISTS memories_fts_delete;
    CREATE TRIGGER mf_fts_insert
        AFTER INSERT ON memory_fragments BEGIN
            INSERT INTO memory_fragments_fts(rowid, content, entity)
            VALUES (new.id, ${MF_IDX('new')}, splitCJK(COALESCE(new.entity, '')));
        END;
    CREATE TRIGGER mf_fts_update
        AFTER UPDATE OF content, entity ON memory_fragments BEGIN
            INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, content, entity)
            VALUES ('delete', old.id, ${MF_IDX('old')}, splitCJK(COALESCE(old.entity, '')));
            INSERT INTO memory_fragments_fts(rowid, content, entity)
            VALUES (new.id, ${MF_IDX('new')}, splitCJK(COALESCE(new.entity, '')));
        END;
    CREATE TRIGGER mf_fts_delete
        AFTER DELETE ON memory_fragments BEGIN
            INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, content, entity)
            VALUES ('delete', old.id, ${MF_IDX('old')}, splitCJK(COALESCE(old.entity, '')));
        END;
    CREATE TRIGGER memories_fts_insert
        AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, title, tags_text)
            VALUES (new.id, ${MEM_IDX('new')}, splitCJK(${TAGS_EXPR('new.tags')}));
        END;
    CREATE TRIGGER memories_fts_update
        AFTER UPDATE OF title, tags ON memories BEGIN
            UPDATE memories_fts
            SET title = ${MEM_IDX('new')},
                tags_text = splitCJK(${TAGS_EXPR('new.tags')})
            WHERE rowid = new.id;
        END;
    CREATE TRIGGER memories_fts_delete
        AFTER DELETE ON memories BEGIN
            DELETE FROM memories_fts WHERE rowid = old.id;
        END;
`;

function installTriggers(db) { db.exec(TRIGGERS_SQL); }

function dropTriggers(db) {
    db.exec(`
        DROP TRIGGER IF EXISTS mf_fts_insert; DROP TRIGGER IF EXISTS mf_fts_update; DROP TRIGGER IF EXISTS mf_fts_delete;
        DROP TRIGGER IF EXISTS memories_fts_insert; DROP TRIGGER IF EXISTS memories_fts_update; DROP TRIGGER IF EXISTS memories_fts_delete;
    `);
}

// 两个 FTS 表整批重建（不用 FTS5 的 'rebuild' 指令：它会拿内容表的原文／密文直接分词）
function rebuildFts(db) {
    db.exec(`
        INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES ('delete-all');
        INSERT INTO memory_fragments_fts(rowid, content, entity)
            SELECT id, ${MF_IDX('memory_fragments')}, splitCJK(COALESCE(entity, '')) FROM memory_fragments;
        DELETE FROM memories_fts;
        INSERT INTO memories_fts(rowid, title, tags_text)
            SELECT id, ${MEM_IDX('memories')}, splitCJK(${TAGS_EXPR('tags')}) FROM memories;
        -- memories_fts 是一般 FTS5 表，DELETE 只写删除标记，旧 segment（含旧 token）要合并才会消失；
        -- optimize 把所有 segment 合成一个，旧页面释放（搭配 secure_delete 清零）
        INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES ('optimize');
        INSERT INTO memories_fts(memories_fts) VALUES ('optimize');
    `);
}

function indexFingerprint() {
    return isEnabled() ? 'blind:' + blind.blindKeyFingerprint() : 'plain';
}

function ensureMetaTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_crypto_meta (key TEXT PRIMARY KEY, value TEXT)`);
}
function getMeta(db, key) {
    try { const r = db.prepare('SELECT value FROM memory_crypto_meta WHERE key = ?').get(key); return r ? r.value : null; }
    catch (_) { return null; }
}
function setMeta(db, key, value) {
    db.prepare('INSERT INTO memory_crypto_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// 不经透明解密的 prepare：整批处理要看原始储存值（明文或 enc: 密文）
function _rawPrepare(db, sql) {
    return Object.getPrototypeOf(db).prepare.call(db, sql);
}

// 整批处理加密栏位：
//   mode 'seal'   ：on 时把明文加密；旧的无 AAD 密文／v1 改成带 AAD 的 v2（金钥不变）
//   mode 'rotate' ：所有密文用目前金钥重新加密（旧 kid → 新 kid），明文也加密（on 时）
// 解不开的值：seal 模式略过并计数（它本来就是密文，不是明文外洩）；rotate 模式整批中止。
// 回传统计；dryRun 时不写入。
function processAllFields(db, { mode = 'seal', dryRun = false } = {}) {
    const on = isEnabled();
    const stats = { sealed: 0, resealed: 0, rotated: 0, undecryptable: [], scanned: 0 };
    const kidNow = encryption.keyId;
    for (const [table, cols] of Object.entries(FIELDS)) {
        for (const col of cols) {
            const aad = `${table}:${col}`;
            const rows = _rawPrepare(db, `SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`).all();
            const upd = dryRun ? null : _rawPrepare(db, `UPDATE ${table} SET ${col} = ? WHERE id = ?`);
            for (const r of rows) {
                stats.scanned++;
                if (typeof r.v !== 'string') continue;
                if (!r.v.startsWith('enc:')) {
                    if (on) { stats.sealed++; if (upd) upd.run(encryption.encrypt(r.v, { aad }), r.id); }
                    continue;
                }
                const o = _open(aad, r.v);
                if (!o.ok) { stats.undecryptable.push(`${aad}#${r.id}`); continue; }
                const kid = r.v.startsWith('enc:v2:') ? r.v.split(':')[2] : null;
                if (o.legacy && (on || mode === 'rotate')) {
                    stats.resealed++;
                    if (upd) upd.run(encryption.encrypt(o.value, { aad }), r.id);
                } else if (mode === 'rotate' && kid !== kidNow) {
                    stats.rotated++;
                    if (upd) upd.run(encryption.encrypt(o.value, { aad }), r.id);
                }
            }
        }
    }
    return stats;
}

// memory_fragments.content_hash 依目前模式／金钥重算（on：带金钥 HMAC；off：原本的 SHA-256）
function recomputeContentHashes(db, { dryRun = false } = {}) {
    const { normalizedContentHash } = require('./scribeQuality');
    let rows;
    try {
        rows = db.prepare('SELECT id, entity, content, content_hash FROM memory_fragments WHERE content_hash IS NOT NULL').all();
    } catch (_) { return 0; }   // 老库没有 content_hash 栏
    const upd = dryRun ? null : _rawPrepare(db, 'UPDATE memory_fragments SET content_hash = ? WHERE id = ?');
    let n = 0;
    for (const r of rows) {
        if (r.content === null) continue;   // 解不开：保留原值
        const h = normalizedContentHash(r.entity, r.content);
        if (h !== r.content_hash) { n++; if (upd) upd.run(h, r.id); }
    }
    return n;
}

function _plaintextExists(db) {
    const conds = {
        memory_fragments: ['content', 'quote'],
        memories: ['content', 'title'],
        entity_profiles: ['facts', 'current_status', 'judgment', 'overview'],
    };
    for (const [t, cols] of Object.entries(conds)) {
        const where = cols.map(c => `(${c} IS NOT NULL AND ${c} != '' AND substr(${c}, 1, 4) != 'enc:')`).join(' OR ');
        try { if (_rawPrepare(db, `SELECT 1 FROM ${t} WHERE ${where} LIMIT 1`).get()) return true; } catch (_) { /* 栏位不存在（极老的库） */ }
    }
    return false;
}

// 完整同步：拆触发器 → （on）整批加密 → 重建两个 FTS → 重算 content_hash → 装回触发器 → 记指纹。
// 必须在交易中呼叫（呼叫端负责），任何一步失败整段回滚。
function fullSync(db, opts = {}) {
    dropTriggers(db);
    const stats = processAllFields(db, { mode: opts.mode || 'seal' });
    if (opts.mode === 'rotate' && stats.undecryptable.length) {
        throw new Error(`有 ${stats.undecryptable.length} 个值无法解密（${stats.undecryptable.slice(0, 5).join(', ')}…），中止；请把旧金钥放进 SANCTUARY_ENCRYPTION_KEYS_OLD`);
    }
    clearCache();
    rebuildFts(db);
    stats.rehashed = recomputeContentHashes(db);
    installTriggers(db);
    ensureMetaTable(db);
    setMeta(db, 'fts_index_fingerprint', indexFingerprint());
    setMeta(db, 'key_check', encryption.encrypt(KEY_CHECK_PLAIN, { aad: KEY_CHECK_AAD }));
    return stats;
}

// ── 金钥核对 ──
// 金钥设错（格式正确但不是这个库的金钥）时，所有记忆读出来都是 null；若照常启动，
// 背景任务会把 null 当空值「补写」回去（例如近况整段被新的一行覆盖），加上启动同步会用错的金钥
// 重建索引——等于慢慢毁掉资料。所以资料库里存一个用金钥加密的核对值，启动时先解开它，
// 解不开（目前金钥与 SANCTUARY_ENCRYPTION_KEYS_OLD 都不对）就拒绝启动（fail-closed）。
const KEY_CHECK_PLAIN = 'hippocampus-memory key check v1';
const KEY_CHECK_AAD = 'memory_crypto_meta:key_check';

class MemoryKeyMismatchError extends Error {
    constructor(msg) { super(msg); this.name = 'MemoryKeyMismatchError'; }
}

function verifyKeyCheck(db) {
    const v = getMeta(db, 'key_check');
    if (!v) return 'absent';
    const out = encryption.decrypt(v, { aad: KEY_CHECK_AAD, silent: true });
    if (out !== KEY_CHECK_PLAIN) {
        throw new MemoryKeyMismatchError('记忆加密金钥与资料库不符：SANCTUARY_ENCRYPTION_KEY（及 SANCTUARY_ENCRYPTION_KEYS_OLD）都解不开核对值。'
            + '拒绝启动，避免把解不开的记忆当空值覆写。换金钥请用 scripts/rotate_memory_keys.js，并把旧金钥放进 SANCTUARY_ENCRYPTION_KEYS_OLD。');
    }
    return 'ok';
}

// 执行 fn 期间开 secure_delete（被覆写的明文页面会清零），结束后把 WAL 截断，
// 避免旧明文留在 -wal 档或空闲页面里。
function withSecureDelete(db, fn) {
    let prev = 0;
    try { prev = db.pragma('secure_delete', { simple: true }); db.pragma('secure_delete = ON'); } catch (_) { /* 旧版 SQLite */ }
    try { return fn(); }
    finally {
        try { db.pragma(`secure_delete = ${prev ? 'ON' : 'OFF'}`); } catch (_) {}
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    }
}

// 把明文加密之后：UPDATE 过的列在 B-tree 重新平衡时，旧页面内容不一定会被 secure_delete 清掉
// （2000 笔实测仍残留明文），所以只要这次真的加密了明文／旧密文，就 VACUUM 整个档案重写一遍，
// 再把 WAL 截断。VACUUM 失败不影响资料正确性（已加密），只记警告。
function scrubFile(db) {
    try { db.exec('VACUUM'); } catch (e) { console.warn('[memoryCrypto] VACUUM 失败（旧明文可能残留在空闲页面，可稍后手动跑 scripts/vacuum.js）:', e.message); }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
}

// database.js 启动时呼叫（在所有 migration 之后）。
//   migrationRecorded(107) 为假 → 跑 v107（完整同步 + 记版本，同一个交易）
//   已跑过 → 每次启动重装触发器（幂等），并在「指纹不符／需要强制重建／on 却还有明文」时做完整同步
function initMemoryCrypto(db, { versionRecorded, recordVersion, forceReindex = false } = {}) {
    if (!versionRecorded) {
        try {
            let stats;
            withSecureDelete(db, () => db.transaction(() => {
                stats = fullSync(db);
                recordVersion();
            })());
            console.log(`[DB] v107 记忆本体加密 + FTS 盲索引（模式 ${isEnabled() ? 'on' : 'off'}）✓ 加密 ${stats.sealed}、旧密文改 AAD ${stats.resealed}、无法解密 ${stats.undecryptable.length}`);
            if (stats.sealed + stats.resealed > 0) scrubFile(db);
        } catch (e) {
            console.error('[DB] v107 记忆本体加密失败（已回滚，不记版本）:', e.message);
        }
        return;
    }
    // 金钥核对放在任何同步之前、而且不吞例外：金钥错了就整个 initDatabase 失败
    verifyKeyCheck(db);
    try {
        // 轮替脚本会自己做完整同步（rotate 模式），启动时先不做，避免重复重建
        const skipAuto = process.env.MEMORY_CRYPTO_SKIP_AUTOSYNC === '1';
        const needSync = !skipAuto && (forceReindex
            || getMeta(db, 'fts_index_fingerprint') !== indexFingerprint()
            || (isEnabled() && _plaintextExists(db)));
        if (needSync) {
            let stats;
            withSecureDelete(db, () => db.transaction(() => { stats = fullSync(db); })());
            console.log(`[memoryCrypto] 索引／加密状态同步完成（模式 ${isEnabled() ? 'on' : 'off'}）：加密 ${stats.sealed}、旧密文改 AAD ${stats.resealed}、无法解密 ${stats.undecryptable.length}`);
            // off→on 时连同旧的明文两字组索引一起清掉；单纯换金钥／换模式重建索引也顺便清
            scrubFile(db);
        } else {
            db.transaction(() => installTriggers(db))();
        }
    } catch (e) {
        console.error('[memoryCrypto] 启动同步失败（已回滚）:', e.message);
    }
}

module.exports = {
    FIELDS, isEnabled, aadFor, isEncryptedField,
    sealField, openField, clearCache,
    wrapDatabase, wrapStatement, registerSqlFunctions,
    fragmentsMatchQuery, memoriesMatchQuery, sqlLike,
    installTriggers, dropTriggers, rebuildFts, indexFingerprint,
    processAllFields, recomputeContentHashes, fullSync, withSecureDelete, scrubFile, initMemoryCrypto,
    getMeta, setMeta, ensureMetaTable, verifyKeyCheck, MemoryKeyMismatchError,
    DOMAIN_MF_CONTENT, DOMAIN_MEM_TITLE,
};
