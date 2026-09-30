// =================================================================
// 情緒引擎的查詢：使用者基準與狀態、實體情緒統計、話題×時段分布、週年日、事件預期與回顧
// =================================================================
const { getEmotionConfig } = require('./config');
const { DIMS, DIM_LABELS } = require('./scoring');
const { SLOTS, SLOT_LABELS, parseUtc, localParts, localDate } = require('./time');
const { estimate } = require('./ou');
const { loadStats, loadStates, decayFactor } = require('./store');

const r4 = (x) => Math.round(x * 10000) / 10000;

// 目前各維基準與狀態
function getBaselineStatus(db) {
    const cfg = getEmotionConfig();
    const stats = loadStats(db);
    const states = loadStates(db);
    const samples = stats[DIMS[0]].all.n || 0;
    const dims = {};
    for (const d of DIMS) {
        const est = estimate(stats[d], cfg);
        dims[d] = {
            label: DIM_LABELS[d],
            baseline: r4(est.overall),
            sigma: r4(est.sigma),
            tau_hours: cfg.tau_hours,
            slots: Object.fromEntries(SLOTS.map(s => [s, { label: SLOT_LABELS[s], mu: r4(est.slots[s].mu), n: r4(est.slots[s].n) }])),
            state: states[d] ? { x: r4(states[d].x), p: r4(states[d].p), t: new Date(states[d].t).toISOString() } : null,
        };
    }
    return {
        enabled: cfg.enabled, learning: samples < cfg.learning_min_samples,
        samples, min_samples: cfg.learning_min_samples, timezone: cfg.timezone, dims,
    };
}

// 實體 × 情緒：貝氏平均轉折率（依時間衰減到 now）
//   rate = (hits + m·p0) / (n + m)，p0 = 該維全域轉折率（無資料則用 attribution_prior_rate）
function getEntityEmotions(db, { dim, limit = 50, minN = 0, now = new Date() } = {}) {
    const cfg = getEmotionConfig();
    const nowMs = (parseUtc(now) || new Date()).getTime();
    const m = cfg.attribution_prior_strength;
    const rows = db.prepare(`SELECT s.entity_id, s.dim, s.n, s.hits, s.mag, s.last_at, ep.name, ep.category
        FROM emotion_entity_stats s JOIN entity_profiles ep ON ep.id = s.entity_id`).all();
    const g = {};
    const ents = new Map();
    for (const r of rows) {
        const last = parseUtc(r.last_at)?.getTime() ?? nowMs;
        const f = decayFactor(nowMs - last, cfg.attribution_half_life_days);
        const n = r.n * f, hits = r.hits * f, mag = r.mag * f;
        g[r.dim] = g[r.dim] || { n: 0, hits: 0 };
        g[r.dim].n += n; g[r.dim].hits += hits;
        if (!ents.has(r.entity_id)) ents.set(r.entity_id, { entity_id: r.entity_id, name: r.name, category: r.category, dims: {} });
        ents.get(r.entity_id).dims[r.dim] = { n, hits, mag };
    }
    const p0 = (d) => (g[d] && g[d].n > 0 ? (g[d].hits + m * cfg.attribution_prior_rate) / (g[d].n + m) : cfg.attribution_prior_rate);
    const out = [];
    for (const e of ents.values()) {
        const dims = {};
        let total = 0;
        for (const d of DIMS) {
            const v = e.dims[d];
            if (!v) continue;
            const base = p0(d);
            const rate = (v.hits + m * base) / (v.n + m);
            dims[d] = { label: DIM_LABELS[d], n: r4(v.n), hits: r4(v.hits), rate: r4(rate), lift: r4(rate / base), avg_intensity: v.n > 0 ? r4(v.mag / v.n) : 0 };
            total = Math.max(total, v.n);
        }
        if (total < minN) continue;
        const ranked = Object.entries(dims).sort((a, b) => b[1].rate - a[1].rate);
        out.push({ entity_id: e.entity_id, name: e.name, category: e.category, n: r4(total), top: ranked[0] ? ranked[0][0] : null, dims });
    }
    const key = (e) => (dim ? (e.dims[dim]?.rate ?? -1) : (e.dims[e.top]?.rate ?? -1));
    out.sort((a, b) => key(b) - key(a));
    return out.slice(0, limit);
}

// 話題（實體類別）× 時段的情緒分布（每格：筆數與各維平均強度，扣底噪後）
function getTopicSlotDistribution(db, { now = new Date() } = {}) {
    const cfg = getEmotionConfig();
    const nowMs = (parseUtc(now) || new Date()).getTime();
    const out = {};
    for (const r of db.prepare('SELECT category, slot, dim, n, sum, last_at FROM emotion_topic_slot').all()) {
        const last = parseUtc(r.last_at)?.getTime() ?? nowMs;
        const f = decayFactor(nowMs - last, cfg.attribution_half_life_days);
        const cell = ((out[r.category] = out[r.category] || {})[r.slot] = out[r.category][r.slot] || { label: SLOT_LABELS[r.slot], n: 0, mean: {} });
        cell.n = Math.max(cell.n, r.n * f);
        cell.mean[r.dim] = r.n > 0 ? r4(r.sum / r.n) : 0;   // 衰減對分子分母同倍，平均不變
    }
    for (const c of Object.values(out)) for (const s of Object.values(c)) s.n = r4(s.n);
    return out;
}

// ── 週年日 ────────────────────────────────────────────────

const FRAG_COLS = `id, entity, type, content, source_date, created_at, raised_at, event_at, raised_slot, weekday, intensity, valence, ${DIMS.map(d => 'emo_' + d).join(', ')}`;

function emotionsOf(row) {
    const o = {};
    for (const d of DIMS) if (row[`emo_${d}`] !== null && row[`emo_${d}`] !== undefined) o[d] = row[`emo_${d}`];
    return o;
}

function ymd(date, tz) {
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return localDate(date instanceof Date ? date : (parseUtc(date) || new Date()), tz);
}

// 過去「同月同日」的事件（event_at）與被提出的話題（raised_at，依當地日期）及當時情緒。
// date：'YYYY-MM-DD'（使用者當地日期）或 Date；只回傳「早於今年」者。供 G1 取記憶閘門使用。
function getAnniversaries(db, date = new Date(), { limit = 20 } = {}) {
    const cfg = getEmotionConfig();
    const today = ymd(date, cfg.timezone);
    if (!today) return [];
    const [ty, tm, td] = today.split('-').map(Number);
    const md = `${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`;
    const out = [];
    const seen = new Set();
    const push = (row, kind, dateStr) => {
        const key = `${row.id}:${kind}`;
        if (seen.has(key)) return;
        seen.add(key);
        const y = +dateStr.slice(0, 4);
        if (y >= ty) return;
        out.push({
            fragment_id: row.id, kind, date: dateStr, years_ago: ty - y, entity: row.entity, type: row.type,
            content: row.content, intensity: row.intensity, valence: row.valence, emotions: emotionsOf(row),
        });
    };
    // event_at：只認完整日期
    for (const r of db.prepare(`SELECT ${FRAG_COLS} FROM memory_fragments
        WHERE status = 'active' AND event_at LIKE ? AND length(event_at) = 10`).all(`____-${md}`)) {
        push(r, 'event', r.event_at);
    }
    // raised_at 是 UTC，當地日期可能差一天 → 先用 ±1 天的 UTC 月日撈，再用當地日期精確比對
    const near = [-1, 0, 1].map(k => {
        const d = new Date(Date.UTC(2001, tm - 1, td + k));   // 2001 非閏年；2/29 不比對
        return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    });
    for (const r of db.prepare(`SELECT ${FRAG_COLS} FROM memory_fragments
        WHERE status = 'active' AND raised_at IS NOT NULL AND substr(raised_at, 6, 5) IN (?, ?, ?)`).all(...near)) {
        const ld = localDate(r.raised_at, cfg.timezone);
        if (ld && ld.slice(5) === md) push(r, 'raised', ld);
    }
    out.sort((a, b) => (b.intensity || 0) - (a.intensity || 0) || a.years_ago - b.years_ago);
    return out.slice(0, limit);
}

// ── 事件預期與回顧 ─────────────────────────────────────────
// 同一個 event_at 的碎片：事件日之前提出的累積「期待／恐懼」，事件日當天與之後提出的記錄實際反應。
function getEventArcs(db, { since, until, limit = 50 } = {}) {
    const cfg = getEmotionConfig();
    const rows = db.prepare(`SELECT ${FRAG_COLS} FROM memory_fragments
        WHERE status = 'active' AND event_at IS NOT NULL AND length(event_at) = 10 AND intensity IS NOT NULL
          ${since ? 'AND event_at >= ?' : ''} ${until ? 'AND event_at <= ?' : ''}
        ORDER BY event_at DESC, raised_at`).all(...[since, until].filter(Boolean));
    const groups = new Map();
    for (const r of rows) {
        const rd = localDate(r.raised_at, cfg.timezone) || (r.raised_at || '').slice(0, 10);
        const phase = rd < r.event_at ? 'before' : 'after';
        const g = groups.get(r.event_at) || { event_at: r.event_at, before: [], after: [] };
        g[phase].push(r);
        groups.set(r.event_at, g);
    }
    const avg = (list) => {
        if (!list.length) return null;
        const o = {};
        for (const d of DIMS) o[d] = r4(list.reduce((s, r) => s + (r[`emo_${d}`] || 0), 0) / list.length);
        return o;
    };
    const out = [];
    for (const g of groups.values()) {
        const expected = avg(g.before), actual = avg(g.after);
        out.push({
            event_at: g.event_at, fragments_before: g.before.length, fragments_after: g.after.length,
            expected, actual,
            // 預期落差：實際反應 − 事前預期（正 = 比預期更強）
            delta: expected && actual ? Object.fromEntries(DIMS.map(d => [d, r4(actual[d] - expected[d])])) : null,
        });
    }
    return out.slice(0, limit);
}

module.exports = { getBaselineStatus, getEntityEmotions, getTopicSlotDistribution, getAnniversaries, getEventArcs, localParts };
