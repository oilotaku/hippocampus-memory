// =================================================================
// services/recallGate.js — 取記憶時機閘門（G1）
//
// 回答五個問題：
//   1. 這一則要不要查記憶？        decideRecall()
//   2. 查到的要留幾條？            selectDynamicK() + splitBudget()
//   3. 「想起」與「引用」怎麼分開？ markCited()／markCitedFromReply()（欄位 injected_count／cited_count）
//   4. 什麼時候讓舊事浮現？        pickSurface()（閒置後第一句、同一日期，含冷卻）
//   5. 即將發生的事怎麼提醒？      findUpcoming()（不必等查詢命中）
//
// 全部規則由 memory_config.json 的 recall.* 控制；recall.gate=false 時本模組不介入，
// 各呼叫端退回原本行為（每則都查 8 條、隨機浮現、hard trigger 無上限、novelty 看 read_count）。
// 純函式為主；需要資料庫的函式一律可注入 db／now／rng，方便測試。
// =================================================================

const { toTraditionalChars } = require('../utils/zhNormalize');
const { toIndexTokenList } = require('../utils/cjkTokenize');

// ── 預設設定與詞表（簡繁並存；比對前一律逐字轉繁體，所以這裡寫繁體即可） ──
const DEFAULT_CONFIG = {
    gate: true,
    // 檢索
    candidate_k: 16,            // 向量／關鍵詞候選數
    max_k: 8,                   // 動態 k 的上限
    relative_cutoff: 0.5,       // 只留分數 ≥ 第一名 × 此值的結果
    budget_share: { core: 0.3, retrieval: 0.5, extra: 0.2 },   // 核心／檢索／浮現與前瞻
    // 要不要查
    min_chars: 4,               // 去掉標點後少於此字數，且無實體／指涉線索／問句 → 不查
    command_max_chars: 14,      // 指令型短句的長度上限
    smalltalk_words: ['好', '好的', '好啊', '好喔', '好吧', '好哦', '嗯', '嗯嗯', '哦', '喔', '噢', '哈', '哈哈', '呵呵', '嘿嘿', '對', '對啊', '是', '是的', '是啊', '行', '可以', '沒問題', '了解', '知道了', '收到', '明白', '謝謝', '謝了', '多謝', '感謝', '不客氣', '拜拜', '掰掰', '再見', '晚安', '早安', '午安', '早', '嗨', '哈囉', '你好', '在嗎', 'ok', 'okay', 'thanks', 'thx', 'hi', 'hello', 'bye', 'yes', 'no'],
    command_prefixes: ['幫我', '請幫', '請你', '麻煩', '打開', '開啟', '關閉', '關掉', '開', '關', '播放', '暫停', '設定', '設置', '提醒我', '叫我', '調', '切換', '搜尋', '查一下', '訂', '取消'],
    cue_words: ['上次', '之前', '以前', '那次', '那個', '那件', '那天', '還記得', '記得', '記不記得', '曾經', '當時', '那時', '前陣子', '上回', '你說過', '我說過', '提過'],
    question_words: ['？', '?', '嗎', '呢', '什麼', '甚麼', '哪', '誰', '幾', '多少', '何時', '怎麼', '怎樣', '為什麼', '為何', '是不是', '有沒有', '能不能', '可不可以'],
    // 話題延續
    topic_overlap: 0.3,         // 與上一則的兩字組重疊比例（以較小集合為分母）≥ 此值視為同話題
    continuation_minutes: 30,   // 與上一則相隔超過此分鐘數就不算延續（對齊工作記憶 TTL）
    // 浮現
    surface_idle_hours: 6,
    surface_cooldown_days: 7,
    surface_max: 2,
    surface_noise: 0.15,        // 挑選分數的高斯擾動標準差
    surface_min_age_days: 3,
    // 前瞻
    prospective_days: 7,
    prospective_max: 3,
    prospective_lookback_days: 120,   // 只看這段時間內寫下的碎片（更舊的日期推不出年份）
    prospective_scan_limit: 400,
    // hard trigger
    hard_trigger_max: 3,
    // 引用判斷
    cite_min_overlap: 0.3,
    cite_min_shared: 3,
};

let _override = null;   // 測試用：整份覆蓋（含 undefined 表示走檔案）
function setRecallConfigOverride(cfg) { _override = cfg === undefined ? null : cfg; }

function loadRaw() {
    if (_override) return _override;
    try { return require('../memory_config.json'); } catch (_) { return {}; }
}

const numOr = (v, d, { min = -Infinity, max = Infinity, int = false } = {}) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return d;
    return int ? Math.floor(v) : v;
};
const listOr = (v, d) => (Array.isArray(v) && v.every(x => typeof x === 'string') ? v : d);

/** 讀 recall.* 並補上預設值；cfg 可注入（整份 memory_config 物件）。非法值一律回退預設。 */
function getRecallConfig(cfg) {
    const raw = cfg === undefined ? loadRaw() : cfg;
    const r = (raw && raw.recall) || {};
    const D = DEFAULT_CONFIG;
    const share = r.budget_share || {};
    let core = numOr(share.core, D.budget_share.core, { min: 0 });
    let retrieval = numOr(share.retrieval, D.budget_share.retrieval, { min: 0 });
    let extra = numOr(share.extra, D.budget_share.extra, { min: 0 });
    const sum = core + retrieval + extra;
    if (sum <= 0) { ({ core, retrieval, extra } = D.budget_share); }
    else { core /= sum; retrieval /= sum; extra /= sum; }
    return {
        gate: r.gate === false ? false : true,
        candidate_k: numOr(r.candidate_k, D.candidate_k, { min: 1, int: true }),
        max_k: numOr(r.max_k, D.max_k, { min: 1, int: true }),
        relative_cutoff: numOr(r.relative_cutoff, D.relative_cutoff, { min: 0, max: 1 }),
        budget_share: { core, retrieval, extra },
        min_chars: numOr(r.min_chars, D.min_chars, { min: 0, int: true }),
        command_max_chars: numOr(r.command_max_chars, D.command_max_chars, { min: 0, int: true }),
        smalltalk_words: listOr(r.smalltalk_words, D.smalltalk_words),
        command_prefixes: listOr(r.command_prefixes, D.command_prefixes),
        cue_words: listOr(r.cue_words, D.cue_words),
        question_words: listOr(r.question_words, D.question_words),
        topic_overlap: numOr(r.topic_overlap, D.topic_overlap, { min: 0, max: 1 }),
        continuation_minutes: numOr(r.continuation_minutes, D.continuation_minutes, { min: 0 }),
        surface_idle_hours: numOr(r.surface_idle_hours, D.surface_idle_hours, { min: 0 }),
        surface_cooldown_days: numOr(r.surface_cooldown_days, D.surface_cooldown_days, { min: 0 }),
        surface_max: numOr(r.surface_max, D.surface_max, { min: 0, int: true }),
        surface_noise: numOr(r.surface_noise, D.surface_noise, { min: 0 }),
        surface_min_age_days: numOr(r.surface_min_age_days, D.surface_min_age_days, { min: 0 }),
        prospective_days: numOr(r.prospective_days, D.prospective_days, { min: 0 }),
        prospective_max: numOr(r.prospective_max, D.prospective_max, { min: 0, int: true }),
        prospective_lookback_days: numOr(r.prospective_lookback_days, D.prospective_lookback_days, { min: 1 }),
        prospective_scan_limit: numOr(r.prospective_scan_limit, D.prospective_scan_limit, { min: 1, int: true }),
        hard_trigger_max: numOr(r.hard_trigger_max, D.hard_trigger_max, { min: 0, int: true }),
        cite_min_overlap: numOr(r.cite_min_overlap, D.cite_min_overlap, { min: 0, max: 1 }),
        cite_min_shared: numOr(r.cite_min_shared, D.cite_min_shared, { min: 1, int: true }),
    };
}

// ── 共用小工具 ─────────────────────────────────────────────

const norm = (s) => toTraditionalChars(String(s || '')).toLowerCase();
const PUNCT_RE = /[\s\p{P}\p{S}]+/gu;
const stripPunct = (s) => norm(s).replace(PUNCT_RE, '');

const DAY_MS = 86400000;

// DB 的 'YYYY-MM-DD HH:MM:SS'（無時區）是 UTC；與 librarian.parseDbTime 同規則
function parseDbTime(label) {
    if (label instanceof Date) return label;
    if (typeof label === 'string') {
        const m = label.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
        if (m) return new Date(`${m[1]}T${m[2]}Z`);
        const d = label.trim().match(/^(\d{4}-\d{2}-\d{2})$/);
        if (d) return new Date(`${d[1]}T00:00:00Z`);
    }
    return new Date(label);
}
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const dayIndex = (d) => Math.floor(utcDay(d) / DAY_MS);

/** 文字 → CJK 兩字組集合（與 FTS 相同的切法，簡繁正規化；非 CJK 詞轉小寫，濾掉單字） */
function bigramSet(text) {
    const set = new Set();
    for (const t of toIndexTokenList(text)) if (t.length >= 2) set.add(t);
    return set;
}

/** 兩個集合的重疊比例（分母取較小者）；任一為空回 0 */
function overlapRatio(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / Math.min(a.size, b.size);
}

// ── 1. 要不要查 ────────────────────────────────────────────

function containsAny(text, words) {
    for (const w of words) { const n = norm(w); if (n && text.includes(n)) return n; }
    return null;
}

/** 整句由寒暄詞（可重複、可連接）組成，例如「嗯嗯」「好的謝謝」 */
function isPureSmalltalk(stripped, words) {
    if (!stripped) return true;
    const list = [...new Set(words.map(stripPunct).filter(Boolean))].sort((a, b) => b.length - a.length);
    if (!list.length) return false;
    const esc = list.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^(?:${esc.join('|')})+$`, 'u').test(stripped);
}

function startsWithCommand(text, prefixes) {
    const t = text.replace(/^[\s\p{P}]+/u, '');
    return prefixes.some(p => { const n = norm(p); return n && t.startsWith(n); });
}

/** 訊息含已知實體名／別名？（entity_profiles.name/aliases，未加密；不做向量比對，保持輕量） */
function findKnownEntity(message, db) {
    const msg = norm(message);
    let rows = [];
    try {
        rows = db.prepare(`SELECT name, aliases FROM entity_profiles WHERE name IS NOT NULL AND status IN ('active','seed')`).all();
    } catch (_) { return null; }
    for (const e of rows) {
        const name = norm(e.name);
        if (name.length >= 2 && msg.includes(name)) return e.name;
        let aliases = [];
        try { aliases = JSON.parse(e.aliases || '[]'); } catch (_) {}
        for (const a of aliases) {
            const na = norm(a);
            if (na.length >= 2 && msg.includes(na)) return e.name;
        }
    }
    return null;
}

/**
 * 判斷這一則要不要查記憶。
 * @param {string} message
 * @param {object} o
 *   cfg       getRecallConfig() 的結果
 *   db        資料庫（查實體用）
 *   intent    classifyIntent 的結果（由呼叫端傳入，避免這裡依賴 librarian）
 *   prev      上一則的 { at:Date|number, bigrams:Set, retrieved:boolean }；沒有就不做延續判斷
 *   now       目前時間（毫秒）
 *   poolSize  工作記憶目前條數（0 表示沒有可沿用的東西，不能算延續）
 * @returns {{retrieve:boolean, reason:string, continuation?:boolean}}
 */
function decideRecall(message, o = {}) {
    const cfg = o.cfg || getRecallConfig();
    const text = norm(message);
    const stripped = stripPunct(message);
    const len = [...stripped].length;
    const now = o.now != null ? Number(o.now) : Date.now();

    // 強訊號：一律要查（不做延續判斷——這些是使用者明說要回想）
    const entity = o.db ? findKnownEntity(message, o.db) : null;
    if (entity) return { retrieve: true, reason: 'entity' };
    if (containsAny(text, cfg.cue_words)) return { retrieve: true, reason: 'cue' };
    if (o.intent && ['long_term', 'summary', 'fact'].includes(o.intent)) return { retrieve: true, reason: `intent:${o.intent}` };

    // 明確不查
    // 寒暄詞後面接問號（「好？」）是在發問，不算純寒暄
    if (!/[?？]/.test(text) && isPureSmalltalk(stripped, cfg.smalltalk_words)) return { retrieve: false, reason: 'smalltalk' };
    const isQuestion = !!containsAny(text, cfg.question_words);
    if (!isQuestion) {
        if (len <= cfg.command_max_chars && startsWithCommand(text, cfg.command_prefixes)) return { retrieve: false, reason: 'command' };
        if (len < cfg.min_chars) return { retrieve: false, reason: 'too_short' };
    }

    // 同話題延續：沿用工作記憶，不重查
    const prev = o.prev;
    if (prev && prev.retrieved && (o.poolSize || 0) > 0) {
        const gapMin = (now - Number(prev.at instanceof Date ? prev.at.getTime() : prev.at)) / 60000;
        if (gapMin >= 0 && gapMin <= cfg.continuation_minutes) {
            const ov = overlapRatio(bigramSet(message), prev.bigrams || new Set());
            if (ov >= cfg.topic_overlap) return { retrieve: false, reason: 'continuation', continuation: true, overlap: Math.round(ov * 100) / 100 };
        }
    }

    return { retrieve: true, reason: isQuestion ? 'question' : 'default' };
}

// ── 2. 動態 k 與預算 ───────────────────────────────────────

/**
 * results 需已依分數（_rrf）由高到低排序。
 * 只留 _rrf ≥ 第一名 × relativeCutoff 的項目，最多 maxK 條。
 */
function selectDynamicK(results, { relativeCutoff = 0.5, maxK = 8 } = {}) {
    const list = (results || []).filter(Boolean);
    if (!list.length) return [];
    const top = Number(list[0]._rrf) || 0;
    if (top <= 0) return list.slice(0, maxK);
    return list.filter(r => (Number(r._rrf) || 0) >= top * relativeCutoff).slice(0, maxK);
}

/** 總預算依比例拆成 核心／檢索／浮現與前瞻 三份（整數，餘數併入檢索） */
function splitBudget(total, share) {
    const s = share || DEFAULT_CONFIG.budget_share;
    const core = Math.floor(total * s.core);
    const extra = Math.floor(total * s.extra);
    return { core, extra, retrieval: total - core - extra };
}

// ── 3. injected_count／cited_count ────────────────────────

/** 標記碎片「真的被引用」。items 為 { id, source_table } 陣列；只有碎片表有計數欄位。 */
function markCited(items, db) {
    const d = db || require('../database').getDb();
    let n = 0;
    let stmt;
    try {
        stmt = d.prepare(`UPDATE memory_fragments SET cited_count = COALESCE(cited_count, 0) + 1, last_accessed_at = datetime('now') WHERE id = ?`);
    } catch (e) { console.error('[recallGate] cited_count 更新準備失敗:', e.message); return 0; }
    const seen = new Set();
    for (const it of items || []) {
        if (!it || it.id == null) continue;
        const table = it.source_table || 'fragment';
        if (table !== 'fragment') continue;
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        try { n += stmt.run(it.id).changes; } catch (e) { console.error(`[recallGate] cited_count 更新失敗 #${it.id}:`, e.message); }
    }
    return n;
}

/**
 * 回覆後檢查：助理回覆是否用到某條碎片（兩字組重疊）。
 * items：buildSmartContext 回傳的 injectedMemories（{id, source_table}）。
 * 本專案內沒有取得助理回覆的掛點，這是給宿主（聊天管線）在回覆完成後呼叫的入口。
 * @returns {number[]} 被判定引用的碎片 id
 */
function markCitedFromReply(replyText, items, { db, cfg } = {}) {
    const d = db || require('../database').getDb();
    const c = cfg || getRecallConfig();
    const reply = bigramSet(replyText);
    if (!reply.size) return [];
    const cited = [];
    for (const it of items || []) {
        if (!it || it.id == null || (it.source_table || 'fragment') !== 'fragment') continue;
        let row;
        try { row = d.prepare('SELECT content FROM memory_fragments WHERE id = ?').get(it.id); } catch (_) { continue; }
        if (!row || !row.content) continue;
        const frag = bigramSet(row.content);
        if (!frag.size) continue;
        let shared = 0;
        for (const t of frag) if (reply.has(t)) shared++;
        if (shared >= c.cite_min_shared && shared / frag.size >= c.cite_min_overlap) cited.push(it.id);
    }
    if (cited.length) markCited(cited.map(id => ({ id, source_table: 'fragment' })), d);
    return cited;
}

// ── 4. 情境浮現 ────────────────────────────────────────────

/** 高斯亂數（Box-Muller），rng 為 [0,1) 來源；可注入固定種子 */
function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 可重現的小型亂數（mulberry32），測試與需要固定種子時用 */
function seededRng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function getState(db, key) {
    try { const r = db.prepare('SELECT value FROM recall_state WHERE key = ?').get(key); return r ? r.value : null; }
    catch (_) { return null; }
}
function setState(db, key, value) {
    try {
        db.prepare(`INSERT INTO recall_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, String(value));
    } catch (e) { console.error('[recallGate] 狀態寫入失敗:', e.message); }
}

/** 上一則訊息時間（毫秒，UTC）；沒有回 null */
function getLastMessageAt(db) {
    const v = getState(db, 'last_message_at');
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
}
function touchLastMessage(db, now) { setState(db, 'last_message_at', String(now)); }

/**
 * 依情境挑要「突然想起」的舊碎片。
 * 觸發：(a) 距上一則訊息閒置 ≥ surface_idle_hours；(b) 有碎片建立於「同一月日、不同年」（去年今天）。
 * 每條浮現後冷卻 surface_cooldown_days 天（recall_surface_log）。
 * 挑選：以 emotional_weight 為基礎加高斯擾動（rng 可注入），取前 surface_max 條。
 * 不寫冷卻紀錄——呼叫端確定注入後才呼叫 recordSurfaced()。
 * @returns {Array} 形如 searchHybrid 浮現項目（_isFloated、_source:'FLOAT'），另有 _surfaceReason
 */
function pickSurface({ db, cfg, now = Date.now(), lastMessageAt = null, rng = Math.random, exclude = new Set() } = {}) {
    const c = cfg || getRecallConfig();
    if (!db || c.surface_max <= 0) return [];
    const nowDate = new Date(now);
    const idle = lastMessageAt != null && (now - lastMessageAt) >= c.surface_idle_hours * 3600000;
    const cooldownCutoff = sqlTime(new Date(now - c.surface_cooldown_days * DAY_MS));
    const ageCutoff = sqlTime(new Date(now - c.surface_min_age_days * DAY_MS));
    const mmdd = `${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}-${String(nowDate.getUTCDate()).padStart(2, '0')}`;
    const thisYear = String(nowDate.getUTCFullYear());

    const cols = `mf.id, mf.content, mf.emotional_weight, mf.source_date AS date_label, mf.created_at,
                  mf.read_count, mf.layer, 'fragment' AS source_table`;
    const notCooling = `NOT EXISTS (SELECT 1 FROM recall_surface_log l
                         WHERE l.source_table = 'fragment' AND l.ref_id = mf.id AND l.surfaced_at > ?)`;
    const candidates = new Map();

    try {
        // (b) 同一日期（去年今天）：不要求閒置
        const anniv = db.prepare(`
            SELECT ${cols} FROM memory_fragments mf
            WHERE mf.status = 'active'
              AND substr(mf.created_at, 6, 5) = ?
              AND substr(mf.created_at, 1, 4) != ?
              AND ${notCooling}
            ORDER BY mf.emotional_weight DESC, mf.id DESC LIMIT 50
        `).all(mmdd, thisYear, cooldownCutoff);
        for (const f of anniv) candidates.set(f.id, { ...f, _surfaceReason: 'anniversary' });

        // (a) 閒置後第一句：從沒被注入過的舊碎片
        if (idle) {
            const old = db.prepare(`
                SELECT ${cols} FROM memory_fragments mf
                WHERE mf.status = 'active'
                  AND COALESCE(mf.injected_count, 0) = 0
                  AND mf.created_at < ?
                  AND ${notCooling}
                ORDER BY mf.emotional_weight DESC, mf.id DESC LIMIT 200
            `).all(ageCutoff, cooldownCutoff);
            for (const f of old) if (!candidates.has(f.id)) candidates.set(f.id, { ...f, _surfaceReason: 'idle' });
        }
    } catch (e) {
        console.error('[recallGate] 浮現查詢失敗:', e.message);
        return [];
    }

    const scored = [];
    for (const f of candidates.values()) {
        if (exclude.has(`fragment-${f.id}`)) continue;
        const base = (f.emotional_weight || 0.5) + (f._surfaceReason === 'anniversary' ? 1 : 0);   // 同日期優先於閒置
        scored.push({ f, score: base + gaussian(rng) * c.surface_noise });
    }
    scored.sort((a, b) => b.score - a.score || a.f.id - b.f.id);

    return scored.slice(0, c.surface_max).map(({ f }) => {
        const daysOld = Math.max(0, Math.round((now - parseDbTime(f.created_at).getTime()) / DAY_MS));
        return {
            ...f,
            weight: f.emotional_weight || 0.5,
            _rrf: 0.002,
            _confidence: 'low',
            _source: 'FLOAT',
            _isFloated: true,
            _daysOld: daysOld,
        };
    });
}

/** 浮現確定注入後記下冷卻起點 */
function recordSurfaced(items, db, now = Date.now()) {
    const d = db || require('../database').getDb();
    const at = sqlTime(new Date(now));
    for (const it of items || []) {
        if (!it || it.id == null) continue;
        try {
            d.prepare(`INSERT INTO recall_surface_log (source_table, ref_id, surfaced_at) VALUES (?, ?, ?)
                       ON CONFLICT(source_table, ref_id) DO UPDATE SET surfaced_at = excluded.surfaced_at`)
                .run(it.source_table || 'fragment', it.id, at);
        } catch (e) { console.error('[recallGate] 浮現冷卻紀錄失敗:', e.message); }
    }
}

// ── 5. 前瞻記憶 ────────────────────────────────────────────

const WEEKDAY = { '一': 0, '二': 1, '三': 2, '四': 3, '五': 4, '六': 5, '日': 6, '天': 6 };
const WK = '(?:週|周|星期|禮拜|礼拜)';

/**
 * 從文字解析日期，回傳 Date（UTC 零點）陣列。ref 為文字寫下的時間（碎片 created_at），
 * 未寫年份的日期取「ref 之後（含當天）第一個出現」的那一天（跨年會進位）。
 * 支援：YYYY-M-D、YYYY年M月D日、M月D日／M月D號／M/D、
 *       下週X／下星期X／下禮拜X、這週X／本週X、週X（ref 起下一個）、明天／後天／大後天。
 * 簡繁並存（週/周、禮/礼）。
 */
function parseDatesFromText(text, ref) {
    // toTraditionalChars 會把「六」等字換成 CJK 相容字元（U+F9D1），NFC 換回一般字元，日期正規式才對得上
    const t = toTraditionalChars(String(text || '')).normalize('NFC');
    const refDay = utcDay(ref);
    const out = [];
    const push = (ms) => { if (!out.some(x => x.getTime() === ms)) out.push(new Date(ms)); };
    const validMD = (y, m, d) => {
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
    };
    const nextOccurrence = (m, d) => {
        const y0 = ref.getUTCFullYear();
        for (const y of [y0, y0 + 1, y0 + 2, y0 + 3, y0 + 4]) {   // 跳過不存在的日子（2/29）
            if (!validMD(y, m, d)) continue;
            const ms = Date.UTC(y, m - 1, d);
            if (ms >= refDay) return ms;
        }
        return null;
    };
    let rest = t;
    const eat = (re, fn) => {
        rest = rest.replace(re, (...a) => { fn(a); return ' '.repeat(a[0].length); });
    };

    // 完整年月日
    eat(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日號号]?/g, a => {
        const [y, m, d] = [+a[1], +a[2], +a[3]];
        if (validMD(y, m, d)) push(Date.UTC(y, m - 1, d));
    });
    // M月D日／M月D號
    eat(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]/g, a => {
        const [m, d] = [+a[1], +a[2]];
        if (m >= 1 && m <= 12) { const ms = nextOccurrence(m, d); if (ms != null) push(ms); }
    });
    // M/D（前後不可再接數字，避開分數與年份片段）
    eat(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, a => {
        const [m, d] = [+a[1], +a[2]];
        if (m >= 1 && m <= 12) { const ms = nextOccurrence(m, d); if (ms != null) push(ms); }
    });

    // 週幾（以週一為一週起點）
    const monday = refDay - ((new Date(refDay).getUTCDay() + 6) % 7) * DAY_MS;
    eat(new RegExp(`下(?:個)?${WK}([一二三四五六日天])`, 'g'), a => push(monday + (7 + WEEKDAY[a[1]]) * DAY_MS));
    eat(new RegExp(`(?:這|本)(?:個)?${WK}([一二三四五六日天])`, 'g'), a => push(monday + WEEKDAY[a[1]] * DAY_MS));
    eat(new RegExp(`${WK}([一二三四五六日天])`, 'g'), a => {
        const off = (WEEKDAY[a[1]] - ((new Date(refDay).getUTCDay() + 6) % 7) + 7) % 7;   // 含當天
        push(refDay + off * DAY_MS);
    });

    // 相對日
    eat(/大後天|大后天/g, () => push(refDay + 3 * DAY_MS));
    eat(/後天|后天/g, () => push(refDay + 2 * DAY_MS));
    eat(/明天|明日/g, () => push(refDay + 1 * DAY_MS));
    return out;
}

/**
 * 取得一條碎片的事件日期（可替換）：G2 若加了 event_at 欄位就直接用，
 * 否則從內容解析（相對於碎片寫下的時間）。回傳 Date[]（可能多個）。
 */
function getEventDates(fragment) {
    if (fragment && fragment.event_at) {
        const d = parseDbTime(fragment.event_at);
        if (!isNaN(d.getTime())) return [new Date(utcDay(d))];
    }
    const ref = parseDbTime(fragment && fragment.created_at);
    if (!fragment || !fragment.content || isNaN(ref.getTime())) return [];
    return parseDatesFromText(fragment.content, ref);
}

/**
 * 找 prospective_days 天內（含今天）即將發生的事。
 * @returns {Array<{id, content, eventDate:Date, daysUntil:number, source_table}>} 依日期由近到遠
 */
function findUpcoming({ db, cfg, now = Date.now() } = {}) {
    const c = cfg || getRecallConfig();
    if (!db || c.prospective_days <= 0 || c.prospective_max <= 0) return [];
    const today = dayIndex(new Date(now));
    let hasEventAt = false;
    try { hasEventAt = db.prepare('PRAGMA table_info(memory_fragments)').all().some(col => col.name === 'event_at'); } catch (_) {}
    const cutoff = sqlTime(new Date(now - c.prospective_lookback_days * DAY_MS));
    let rows = [];
    try {
        rows = db.prepare(`
            SELECT id, content, created_at${hasEventAt ? ', event_at' : ''}
            FROM memory_fragments
            WHERE status = 'active' AND (created_at >= ?${hasEventAt ? ' OR event_at IS NOT NULL' : ''})
            ORDER BY id DESC LIMIT ?
        `).all(cutoff, c.prospective_scan_limit);
    } catch (e) { console.error('[recallGate] 前瞻查詢失敗:', e.message); return []; }

    const hits = [];
    for (const r of rows) {
        let best = null;
        for (const d of getEventDates(r)) {
            const delta = dayIndex(d) - today;
            if (delta >= 0 && delta <= c.prospective_days && (best === null || delta < best.daysUntil)) best = { eventDate: d, daysUntil: delta };
        }
        if (best) hits.push({ id: r.id, content: r.content, source_table: 'fragment', ...best });
    }
    hits.sort((a, b) => a.daysUntil - b.daysUntil || a.id - b.id);
    return hits.slice(0, c.prospective_max);
}

/** 「即將到來」區塊的單條文字 */
function formatUpcomingLine(u) {
    const when = u.daysUntil === 0 ? '今天' : u.daysUntil === 1 ? '明天' : `${u.daysUntil}天後`;
    const md = `${u.eventDate.getUTCMonth() + 1}/${u.eventDate.getUTCDate()}`;
    return `※ ${when}（${md}）· #${u.id}\n${u.content}`;
}

module.exports = {
    DEFAULT_CONFIG,
    getRecallConfig,
    setRecallConfigOverride,
    decideRecall,
    findKnownEntity,
    bigramSet,
    overlapRatio,
    selectDynamicK,
    splitBudget,
    markCited,
    markCitedFromReply,
    gaussian,
    seededRng,
    getLastMessageAt,
    touchLastMessage,
    pickSurface,
    recordSurfaced,
    parseDatesFromText,
    getEventDates,
    findUpcoming,
    formatUpcomingLine,
    sqlTime,
};
