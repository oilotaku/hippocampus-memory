// services/memoryCrypto.js — 記憶本體靜態加密（W3）
//
// 範圍（MEMORY_ENCRYPTION=on，預設）：
//   memory_fragments.content / quote
//   memories.content / title
//   entity_profiles.facts / current_status / judgment / overview
//   persona_model.content、persona_proposals.content / diff、persona_relationship_versions.content、
//   entity_judgment_history.judgment（G3 人格關係層）
// 刻意不加密：entity_profiles.name 與 aliases（實體比對、星圖、SQL 以名字 JOIN/比對都需要明文）、
//   memory_fragments.entity（同理）、tags。
//
// 寫入：所有寫這些欄位的地方一律經過 sealField(表, 欄, 值)。
//   on  → AES-256-GCM（encryption.js v2），AAD = "表:欄"（插入時還沒有 id，見下方取捨說明）
//   off → 原樣寫明文（行為與加密功能上線前相同）
// 讀取：wrapDatabase(db) 把 db.prepare 包一層——凡是結果欄位的「來源」是上述欄位
//   （better-sqlite3 的 stmt.columns() 給出 table/column，別名也追得到），值是 enc: 開頭就解密。
//   所以全專案的 SELECT 不必逐一改；解密失敗回 null（絕不回 enc: 字串，也絕不寫回）。
//   兩種模式讀取端相同：是 enc: 就解密，否則原樣 → 明文與密文可以並存。
// 全文索引：FTS 觸發器改呼叫 mem_fts(domain, aad, 值)——在 JS 端解密後，
//   on 產生盲 token（utils/blindIndex.js），off 產生原本的兩字組；查詢端用 fragmentsMatchQuery／
//   memoriesMatchQuery 依模式產生對應的 MATCH 字串。所以寫入點不必管索引。
// SQL 文字操作：LIKE / length 對密文無意義，改用 mem_like(aad, 值, 樣式)／mem_len(aad, 值)。
//
// AAD 取捨：綁「表:欄」而非「表:欄:id」。INSERT 當下沒有 id，要做到逐列繫結得把每個寫入點
//   改成「先插入再回填」或集中改寫，改動面太大。殘餘風險：同表同欄的密文在列之間可互換
//   （能寫資料庫的人可以把 A 碎片的 content 密文搬到 B 碎片，解密會成功）；跨欄／跨表搬動會被 AAD 擋下。

const { encryption } = require('../encryption');
const { toIndexTokens, TOKENIZER_VERSION } = require('../utils/cjkTokenize');
const blind = require('../utils/blindIndex');

const FIELDS = Object.freeze({
    memory_fragments: Object.freeze(['content', 'quote']),
    memories: Object.freeze(['content', 'title']),
    entity_profiles: Object.freeze(['facts', 'current_status', 'judgment', 'overview']),
    // G3（v112）：人格關係層與 judgment 歷史同屬「AI 對人的認識」，一併加密
    persona_model: Object.freeze(['content']),
    persona_proposals: Object.freeze(['content', 'diff']),
    persona_relationship_versions: Object.freeze(['content']),
    entity_judgment_history: Object.freeze(['judgment']),
});

const AAD_SET = new Set();
const NAME_CANDIDATES = new Map();   // 欄位名 → 可能的 AAD（用於來源不明的運算式欄位）
for (const [t, cols] of Object.entries(FIELDS)) {
    for (const c of cols) {
        const aad = `${t}:${c}`;
        AAD_SET.add(aad);
        if (!NAME_CANDIDATES.has(c)) NAME_CANDIDATES.set(c, []);
        NAME_CANDIDATES.get(c).push(aad);
    }
}

// FTS 欄位的盲索引 domain（每欄一把子金鑰）
const DOMAIN_MF_CONTENT = 'memory_fragments_fts.content';
const DOMAIN_MEM_TITLE = 'memories_fts.title';

let _warnedMode = false;
function isEnabled() {
    const raw = process.env.MEMORY_ENCRYPTION;
    const v = String(raw === undefined ? 'on' : raw).trim().toLowerCase();
    if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false;
    if (!['on', '1', 'true', 'yes', ''].includes(v) && !_warnedMode) {
        _warnedMode = true;
        console.warn(`[memoryCrypto] MEMORY_ENCRYPTION=${raw} 無法辨識，按 on 處理（fail-closed）`);
    }
    return true;
}

function aadFor(table, col) {
    const aad = `${table}:${col}`;
    if (!AAD_SET.has(aad)) throw new Error(`memoryCrypto: ${aad} 不在加密欄位清單內`);
    return aad;
}

function isEncryptedField(table, col) {
    return AAD_SET.has(`${table}:${col}`);
}

// 寫入前呼叫。非字串／空字串原樣回傳（'' 保持 ''，SQL 的 != '' 判斷不受影響）。
// 加密失敗拋 EncryptionError（fail-closed：寧可寫入失敗，也不寫明文）。
function sealField(table, col, value) {
    const aad = aadFor(table, col);
    if (!isEnabled()) return value;
    if (typeof value !== 'string' || value === '') return value;
    return encryption.encrypt(value, { aad });
}

// ── 解密（帶快取） ──
// 快取鍵含 AAD：同一密文換個欄位讀，不會因為命中快取而繞過 AAD 檢查。
const CACHE_MAX = 20000;   // 約 2 萬列的全表 mem_like 掃描也能全部命中快取
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
        console.warn(`[memoryCrypto] ${aad} 解密失敗（金鑰/AAD 不符或資料被竄改），以 null 處理（累計 ${_failCount} 次）`);
    }
}

// 解密一個值。回傳 { ok, value, legacy }：legacy=true 表示是沒有 AAD 的舊密文（v1 或無 AAD 的 v2）。
function _open(aad, value, { allowLegacy = true } = {}) {
    if (typeof value !== 'string' || !value.startsWith('enc:')) return { ok: true, value, legacy: false, plain: true };
    const ck = aad + '\u0000' + value;
    const hit = _cacheGet(ck);
    if (hit) return hit;
    let out = encryption.decrypt(value, { aad, silent: true });
    let legacy = false;
    if (out === null && allowLegacy) {
        // 加密功能上線前 routes/memory-api.js 就會以「無 AAD」加密 memories.content；v1 本來就沒有 AAD。
        // 新寫入的密文一律帶 AAD，所以這個退路不會讓「搬到別欄的新密文」解開。
        out = encryption.decrypt(value, { silent: true });
        legacy = out !== null;
    } else if (out !== null && !value.startsWith('enc:v2:')) {
        legacy = true;   // v1：decrypt 會忽略 aad
    }
    const r = out === null ? { ok: false, value: null, legacy: false } : { ok: true, value: out, legacy };
    if (r.ok) _cacheSet(ck, r);
    return r;
}

// 讀取後呼叫：是 enc: 就解密，否則原樣。解密失敗回 null（並記一筆警告）。
function openField(table, col, value) {
    const aad = aadFor(table, col);
    const r = _open(aad, value);
    if (!r.ok) { _warnFail(aad); return null; }
    return r.value;
}

// ── 透明解密：包裝 db.prepare ──
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
            // 運算式欄位（COALESCE(...) AS content 之類）：來源不明，只試同名欄位的 AAD，
            // 解不開就原樣放行（可能根本不是記憶欄位，例如 messages 的內容）
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
    plan.forEach(e => { if (e) byName.set(e.name, e); });   // 同名欄位：物件模式下後者覆蓋前者
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

// 與 SQLite 預設 LIKE 相同語義：% 任意長度、_ 單一字元、只對 ASCII 不分大小寫、NULL 回 NULL
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

// ── 查詢端：MATCH 字串 ──
const quoteTok = (t) => `"${String(t).replace(/"/g, '""')}"`;

// tokens：toQueryTokens 的輸出（librarian 的 tokenizeCJK）
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

// ── 觸發器／索引重建／整批加密 ──
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

// 兩個 FTS 表整批重建（不用 FTS5 的 'rebuild' 指令：它會拿內容表的原文／密文直接分詞）
function rebuildFts(db) {
    db.exec(`
        INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES ('delete-all');
        INSERT INTO memory_fragments_fts(rowid, content, entity)
            SELECT id, ${MF_IDX('memory_fragments')}, splitCJK(COALESCE(entity, '')) FROM memory_fragments;
        DELETE FROM memories_fts;
        INSERT INTO memories_fts(rowid, title, tags_text)
            SELECT id, ${MEM_IDX('memories')}, splitCJK(${TAGS_EXPR('tags')}) FROM memories;
        -- memories_fts 是一般 FTS5 表，DELETE 只寫刪除標記，舊 segment（含舊 token）要合併才會消失；
        -- optimize 把所有 segment 合成一個，舊頁面釋放（搭配 secure_delete 清零）
        INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES ('optimize');
        INSERT INTO memories_fts(memories_fts) VALUES ('optimize');
    `);
}

function indexFingerprint() {
    // 斷詞版本納入指紋：斷詞規則改變（如 v2-t 加入簡繁正規化）時，既有資料庫下次啟動自動重建索引
    return isEnabled() ? `blind:${blind.blindKeyFingerprint()}:${TOKENIZER_VERSION}` : `plain:${TOKENIZER_VERSION}`;
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

// 不經透明解密的 prepare：整批處理要看原始儲存值（明文或 enc: 密文）
function _rawPrepare(db, sql) {
    return Object.getPrototypeOf(db).prepare.call(db, sql);
}

// 整批處理加密欄位：
//   mode 'seal'   ：on 時把明文加密；舊的無 AAD 密文／v1 改成帶 AAD 的 v2（金鑰不變）
//   mode 'rotate' ：所有密文用目前金鑰重新加密（舊 kid → 新 kid），明文也加密（on 時）
// 解不開的值：seal 模式略過並計數（它本來就是密文，不是明文外洩）；rotate 模式整批中止。
// 回傳統計；dryRun 時不寫入。
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

// memory_fragments.content_hash 依目前模式／金鑰重算（on：帶金鑰 HMAC；off：原本的 SHA-256）
function recomputeContentHashes(db, { dryRun = false } = {}) {
    const { normalizedContentHash } = require('./scribeQuality');
    let rows;
    try {
        rows = db.prepare('SELECT id, entity, content, content_hash FROM memory_fragments WHERE content_hash IS NOT NULL').all();
    } catch (_) { return 0; }   // 老庫沒有 content_hash 欄
    const upd = dryRun ? null : _rawPrepare(db, 'UPDATE memory_fragments SET content_hash = ? WHERE id = ?');
    let n = 0;
    for (const r of rows) {
        if (r.content === null) continue;   // 解不開：保留原值
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
        persona_model: ['content'],
        persona_proposals: ['content', 'diff'],
        persona_relationship_versions: ['content'],
        entity_judgment_history: ['judgment'],
    };
    for (const [t, cols] of Object.entries(conds)) {
        const where = cols.map(c => `(${c} IS NOT NULL AND ${c} != '' AND substr(${c}, 1, 4) != 'enc:')`).join(' OR ');
        try { if (_rawPrepare(db, `SELECT 1 FROM ${t} WHERE ${where} LIMIT 1`).get()) return true; } catch (_) { /* 欄位不存在（極老的庫） */ }
    }
    return false;
}

// 完整同步：拆觸發器 → （on）整批加密 → 重建兩個 FTS → 重算 content_hash → 裝回觸發器 → 記指紋。
// 必須在交易中呼叫（呼叫端負責），任何一步失敗整段回滾。
function fullSync(db, opts = {}) {
    dropTriggers(db);
    const stats = processAllFields(db, { mode: opts.mode || 'seal' });
    if (opts.mode === 'rotate' && stats.undecryptable.length) {
        throw new Error(`有 ${stats.undecryptable.length} 個值無法解密（${stats.undecryptable.slice(0, 5).join(', ')}…），中止；請把舊金鑰放進 SANCTUARY_ENCRYPTION_KEYS_OLD`);
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

// ── 金鑰核對 ──
// 金鑰設錯（格式正確但不是這個庫的金鑰）時，所有記憶讀出來都是 null；若照常啟動，
// 背景任務會把 null 當空值「補寫」回去（例如近況整段被新的一行覆蓋），加上啟動同步會用錯的金鑰
// 重建索引——等於慢慢毀掉資料。所以資料庫裡存一個用金鑰加密的核對值，啟動時先解開它，
// 解不開（目前金鑰與 SANCTUARY_ENCRYPTION_KEYS_OLD 都不對）就拒絕啟動（fail-closed）。
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
        throw new MemoryKeyMismatchError('記憶加密金鑰與資料庫不符：SANCTUARY_ENCRYPTION_KEY（及 SANCTUARY_ENCRYPTION_KEYS_OLD）都解不開核對值。'
            + '拒絕啟動，避免把解不開的記憶當空值覆寫。換金鑰請用 scripts/rotate_memory_keys.js，並把舊金鑰放進 SANCTUARY_ENCRYPTION_KEYS_OLD。');
    }
    return 'ok';
}

// 執行 fn 期間開 secure_delete（被覆寫的明文頁面會清零），結束後把 WAL 截斷，
// 避免舊明文留在 -wal 檔或空閒頁面裡。
function withSecureDelete(db, fn) {
    let prev = 0;
    try { prev = db.pragma('secure_delete', { simple: true }); db.pragma('secure_delete = ON'); } catch (_) { /* 舊版 SQLite */ }
    try { return fn(); }
    finally {
        try { db.pragma(`secure_delete = ${prev ? 'ON' : 'OFF'}`); } catch (_) {}
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    }
}

// 把明文加密之後：UPDATE 過的列在 B-tree 重新平衡時，舊頁面內容不一定會被 secure_delete 清掉
// （2000 筆實測仍殘留明文），所以只要這次真的加密了明文／舊密文，就 VACUUM 整個檔案重寫一遍，
// 再把 WAL 截斷。VACUUM 失敗不影響資料正確性（已加密），只記警告。
function scrubFile(db) {
    try { db.exec('VACUUM'); } catch (e) { console.warn('[memoryCrypto] VACUUM 失敗（舊明文可能殘留在空閒頁面，可稍後手動跑 scripts/vacuum.js）:', e.message); }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
}

// database.js 啟動時呼叫（在所有 migration 之後）。
//   migrationRecorded(107) 為假 → 跑 v107（完整同步 + 記版本，同一個交易）
//   已跑過 → 每次啟動重灌觸發器（冪等），並在「指紋不符／需要強制重建／on 卻還有明文」時做完整同步
function initMemoryCrypto(db, { versionRecorded, recordVersion, forceReindex = false } = {}) {
    if (!versionRecorded) {
        try {
            let stats;
            withSecureDelete(db, () => db.transaction(() => {
                stats = fullSync(db);
                recordVersion();
            })());
            console.log(`[DB] v107 記憶本體加密 + FTS 盲索引（模式 ${isEnabled() ? 'on' : 'off'}）✓ 加密 ${stats.sealed}、舊密文改 AAD ${stats.resealed}、無法解密 ${stats.undecryptable.length}`);
            if (stats.sealed + stats.resealed > 0) scrubFile(db);
        } catch (e) {
            console.error('[DB] v107 記憶本體加密失敗（已回滾，不記版本）:', e.message);
        }
        return;
    }
    // 金鑰核對放在任何同步之前、而且不吞例外：金鑰錯了就整個 initDatabase 失敗
    verifyKeyCheck(db);
    try {
        // 輪替指令碼會自己做完整同步（rotate 模式），啟動時先不做，避免重複重建
        const skipAuto = process.env.MEMORY_CRYPTO_SKIP_AUTOSYNC === '1';
        const needSync = !skipAuto && (forceReindex
            || getMeta(db, 'fts_index_fingerprint') !== indexFingerprint()
            || (isEnabled() && _plaintextExists(db)));
        if (needSync) {
            let stats;
            withSecureDelete(db, () => db.transaction(() => { stats = fullSync(db); })());
            console.log(`[memoryCrypto] 索引／加密狀態同步完成（模式 ${isEnabled() ? 'on' : 'off'}）：加密 ${stats.sealed}、舊密文改 AAD ${stats.resealed}、無法解密 ${stats.undecryptable.length}`);
            // off→on 時連同舊的明文兩字組索引一起清掉；單純換金鑰／換模式重建索引也順便清
            scrubFile(db);
        } else {
            db.transaction(() => installTriggers(db))();
        }
    } catch (e) {
        console.error('[memoryCrypto] 啟動同步失敗（已回滾）:', e.message);
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
