// =================================================================
// 情緒引擎的資料層
//   階段 A（Scribe 寫入碎片當下）：applyScribeEmotion —— 情緒欄位、三種時間、時段
//   階段 B（實體連結完成之後）：processFragments —— OU/Kalman 狀態更新、轉折偵測、事件歸因
//   rebuildEmotionState —— 依 raised_at 順序重放全部碎片（設定改變、補資料時用）
// =================================================================
const { getEmotionConfig } = require('./config');
const { SKIP_NAMES } = require('../memoryConfig');
const { DIMS, analyzeEmotions, parseEventAt, floored } = require('./scoring');
const { SLOTS, parseUtc, toSqlUtc, localParts, slotOfHour } = require('./time');
const { estimate, kalmanStep, zScore, robustResidualSq } = require('./ou');
const { parseEventDateFromText } = require('../../utils/dateParse');

const DAY_MS = 86400000;
const TIMELESS_TYPES = new Set(['preference', 'fact', 'entity_new', 'reflection']);

// ── 階段 A ──────────────────────────────────────────────

// 該條碎片的「話題被提出的時間」：來源訊息（含 quote 那幾則）中最早的一則；找不到就用整批最早
// msgs: [{ ts, text }]；回傳 UTC 'YYYY-MM-DD HH:MM:SS' 或 null
function resolveRaisedAt(quote, msgs) {
    const q = String(quote || '').trim();
    const withTime = (msgs || []).map(m => ({ d: parseUtc(m.ts), text: m.text || '' })).filter(m => m.d);
    if (!withTime.length) return null;
    let pool = q ? withTime.filter(m => m.text.includes(q)) : [];
    if (!pool.length) pool = withTime;
    const earliest = pool.reduce((a, b) => (b.d < a.d ? b : a));
    return toSqlUtc(earliest.d);
}

// 事件日期：由程式從 quote（原話）依「來源訊息時間」確定性換算，模型輸出只當備援。
// 8B 模型的 event_at 不可靠：常把日常狀態填成訊息當天，「下個月十五號」也會算錯月份。
//   1. 沒有時間性的類型 → null
//   2. quote 解析得到日期 → 以程式結果為準（不看模型）
//   3. 解析不到 → 採用模型輸出，但若它等於訊息當天（當地或 UTC 日期）就視為不可信 → null
//      （quote 已確認沒有日期片語；連「今天」都沒說，卻標成今天多半是拿訊息日期充數）
function resolveEventAt(entry, raisedUtc, tz) {
    if (TIMELESS_TYPES.has(entry?.type)) return null;
    const lp = localParts(raisedUtc, tz);
    if (lp) {
        const ref = new Date(Date.UTC(lp.year, lp.month - 1, lp.day));   // 以當地日曆日為「今天」
        const fromQuote = parseEventDateFromText(entry?.quote, ref);
        if (fromQuote) return fromQuote;
    }
    const model = parseEventAt(entry?.event_at);
    if (!model) return null;
    if (model.length === 10) {
        const local = lp ? `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}` : null;
        if (model === local || model === String(raisedUtc).slice(0, 10)) return null;
    }
    return model;
}

// 寫入情緒欄位與時間欄位；emotion.enabled=false 時什麼都不做。回傳分析結果（或 null）
function applyScribeEmotion(db, fragId, entry, { raisedAt } = {}) {
    const cfg = getEmotionConfig();
    if (!cfg.enabled) return null;
    const an = analyzeEmotions(entry?.emotions, cfg);
    const raised = raisedAt || toSqlUtc(new Date());
    const eventAt = resolveEventAt(entry, raised, cfg.timezone);
    const lp = localParts(raised, cfg.timezone);
    const sets = ['raised_at = ?', 'event_at = ?', 'raised_slot = ?', 'weekday = ?', 'tz = ?'];
    const vals = [raised, eventAt, lp ? slotOfHour(lp.hour) : null, lp ? lp.weekday : null, cfg.timezone];
    if (an) {
        for (const d of DIMS) { sets.push(`emo_${d} = ?`); vals.push(an.raw[d]); }
        sets.push('emotion_conf = ?', 'intensity = ?', 'valence = ?', 'emotional_weight = ?');
        // 舊排序公式讀 emotional_weight，且多處以 `|| 0.5` 當預設，0 會被當成缺值 → 設下限 0.1
        vals.push(an.confidence, an.intensity, an.valence, Math.max(0.1, an.intensity));
    }
    db.prepare(`UPDATE memory_fragments SET ${sets.join(', ')} WHERE id = ?`).run(...vals, fragId);
    return an;
}

// ── 衰減累積 ──────────────────────────────────────────────

const decayFactor = (gapMs, halfDays) => Math.pow(0.5, Math.max(0, gapMs) / DAY_MS / halfDays);

function accumulate(row, tMs, halfDays, add) {
    // row: { vals:{...}, last: ms|null }；就地修改
    if (row.last == null) {
        for (const k of Object.keys(add)) row.vals[k] = add[k];
        row.last = tMs;
    } else if (tMs >= row.last) {
        const f = decayFactor(tMs - row.last, halfDays);
        for (const k of Object.keys(add)) row.vals[k] = (row.vals[k] || 0) * f + add[k];
        row.last = tMs;
    } else {
        const f = decayFactor(row.last - tMs, halfDays);
        for (const k of Object.keys(add)) row.vals[k] = (row.vals[k] || 0) + add[k] * f;
    }
    return row;
}

// ── 讀寫基準統計 ──────────────────────────────────────────

function loadStats(db) {
    const stats = Object.fromEntries(DIMS.map(d => [d, { slots: {}, all: { n: 0, nr: 0, r2: 0 } }]));
    for (const r of db.prepare('SELECT dim, slot, n, w, s, nr, r2 FROM emotion_baseline_stats').all()) {
        if (!stats[r.dim]) continue;
        if (r.slot === 'all') stats[r.dim].all = { n: r.n, nr: r.nr, r2: r.r2 };
        else stats[r.dim].slots[r.slot] = { n: r.n, w: r.w, s: r.s };
    }
    return stats;
}

function loadStates(db) {
    const out = {};
    for (const r of db.prepare('SELECT dim, x, p, t FROM emotion_state').all()) {
        const d = parseUtc(r.t);
        out[r.dim] = d ? { x: r.x, p: r.p, t: d.getTime() } : null;
    }
    return out;
}

const upsertSlot = (db) => db.prepare(`
    INSERT INTO emotion_baseline_stats (dim, slot, n, w, s, nr, r2) VALUES (?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT(dim, slot) DO UPDATE SET n = n + excluded.n, w = w + excluded.w, s = s + excluded.s`);
const upsertAll = (db) => db.prepare(`
    INSERT INTO emotion_baseline_stats (dim, slot, n, w, s, nr, r2) VALUES (?, 'all', 1, 0, 0, 1, ?)
    ON CONFLICT(dim, slot) DO UPDATE SET n = n + 1, nr = nr + 1, r2 = r2 + excluded.r2`);
const upsertState = (db) => db.prepare(`
    INSERT INTO emotion_state (dim, x, p, t) VALUES (?, ?, ?, ?)
    ON CONFLICT(dim) DO UPDATE SET x = excluded.x, p = excluded.p, t = excluded.t`);

// ── 階段 B：狀態更新、轉折偵測、歸因 ──────────────────────────

function attribute(db, frag, anomalyDims, f, cfg, tMs) {
    const links = db.prepare(`
        SELECT DISTINCT ep.id, ep.name, ep.category
        FROM fragment_entities fe JOIN entity_profiles ep ON ep.id = fe.entity_id
        WHERE fe.fragment_id = ?`).all(frag.id);
    const skip = new Set(SKIP_NAMES.map(s => String(s).toLowerCase()));
    const targets = links.filter(l => !skip.has(String(l.name || '').toLowerCase()));
    const half = cfg.attribution_half_life_days;

    const getE = db.prepare('SELECT n, hits, mag, last_at FROM emotion_entity_stats WHERE entity_id = ? AND dim = ?');
    const putE = db.prepare(`INSERT INTO emotion_entity_stats (entity_id, dim, n, hits, mag, last_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id, dim) DO UPDATE SET n = excluded.n, hits = excluded.hits, mag = excluded.mag, last_at = excluded.last_at`);
    for (const ent of targets) {
        for (const d of DIMS) {
            const cur = getE.get(ent.id, d);
            const last = cur ? parseUtc(cur.last_at)?.getTime() : null;
            const row = { vals: cur ? { n: cur.n, hits: cur.hits, mag: cur.mag } : {}, last: cur ? last : null };
            accumulate(row, tMs, half, { n: 1, hits: anomalyDims.has(d) ? 1 : 0, mag: f[d] || 0 });
            putE.run(ent.id, d, row.vals.n, row.vals.hits, row.vals.mag, toSqlUtc(new Date(row.last)));
        }
    }

    // 話題（實體類別）× 時段：每個類別每條碎片只算一次
    const cats = [...new Set(links.map(l => l.category).filter(Boolean))];
    const getT = db.prepare('SELECT n, sum, last_at FROM emotion_topic_slot WHERE category = ? AND slot = ? AND dim = ?');
    const putT = db.prepare(`INSERT INTO emotion_topic_slot (category, slot, dim, n, sum, last_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(category, slot, dim) DO UPDATE SET n = excluded.n, sum = excluded.sum, last_at = excluded.last_at`);
    for (const cat of cats) {
        for (const d of DIMS) {
            const cur = getT.get(cat, frag.raised_slot, d);
            const last = cur ? parseUtc(cur.last_at)?.getTime() : null;
            const row = { vals: cur ? { n: cur.n, sum: cur.sum } : {}, last: cur ? last : null };
            accumulate(row, tMs, half, { n: 1, sum: f[d] || 0 });
            putT.run(cat, frag.raised_slot, d, row.vals.n, row.vals.sum, toSqlUtc(new Date(row.last)));
        }
    }
    return targets.map(t => t.name);
}

function processOne(db, frag, cfg) {
    const raw = Object.fromEntries(DIMS.map(d => [d, frag[`emo_${d}`] ?? 0]));
    const f = floored(raw, cfg.noise_floor);
    const informative = (frag.intensity || 0) > 1e-9;
    const dt = parseUtc(frag.raised_at);
    const slot = frag.raised_slot || (dt ? slotOfHour(localParts(dt, cfg.timezone).hour) : 'noon');
    const insEvent = db.prepare(`INSERT OR IGNORE INTO emotion_events (fragment_id, raised_at, slot, informative, learning, anomalies, max_z)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);

    // 無資訊（扣底噪後每維 ≤ 0）：不更新狀態（時間推進隱含在下一次 Kalman 步驟）
    if (!informative || !dt) {
        insEvent.run(frag.id, frag.raised_at, slot, 0, 0, '[]', 0);
        return { informative: false, anomalies: [] };
    }

    const tMs = dt.getTime();
    const stats = loadStats(db);
    const states = loadStates(db);
    const learning = (stats[DIMS[0]].all.n || 0) < cfg.learning_min_samples;
    const anomalies = [];
    const sSlot = upsertSlot(db), sAll = upsertAll(db), sState = upsertState(db);

    for (const d of DIMS) {
        const est = estimate(stats[d], cfg);
        const mu = est.slots[slot].mu;
        // 底噪以下無從分辨（Scribe 也只列高於底噪的維度）→ 觀測值在底噪處截斷，與族群先驗 μ=0.2 同一尺度
        const y = Math.max(raw[d], cfg.noise_floor);
        const z = zScore(y, mu, est.sigma, cfg.obs_noise);
        if (z >= cfg.anomaly_sigma && f[d] > 0) anomalies.push({ dim: d, z: +z.toFixed(3), dev: +(y - mu).toFixed(4) });

        const step = kalmanStep(states[d] || null, y, tMs, mu, est.sigma, cfg.tau_hours, cfg.obs_noise);
        // 有效獨立觀測數：精度換算成「幾筆彼此獨立的觀測」（最多 1）
        const w = step.muObs ? step.muObs.w : 0;
        const nEff = Math.min(1, w * (est.sigma * est.sigma + cfg.obs_noise * cfg.obs_noise));
        sSlot.run(d, slot, nEff, w, step.muObs ? w * step.muObs.m : 0);
        sAll.run(d, robustResidualSq(y, mu, est.sigma, cfg.obs_noise));
        sState.run(d, step.x, step.p, toSqlUtc(new Date(tMs)));
    }

    const anomalyDims = new Set(anomalies.map(a => a.dim));
    const entities = attribute(db, { id: frag.id, raised_slot: slot }, anomalyDims, f, cfg, tMs);
    insEvent.run(frag.id, frag.raised_at, slot, 1, learning ? 1 : 0, JSON.stringify(anomalies),
        anomalies.length ? Math.max(...anomalies.map(a => a.z)) : 0);
    return { informative: true, learning, anomalies, entities };
}

// 處理指定碎片（省略＝所有尚未處理、有情緒資料的碎片），依 raised_at 排序
function processFragments(db, ids) {
    const cfg = getEmotionConfig();
    if (!cfg.enabled) return [];
    let rows;
    const base = `SELECT id, raised_at, raised_slot, intensity, ${DIMS.map(d => 'emo_' + d).join(', ')}
        FROM memory_fragments
        WHERE intensity IS NOT NULL AND raised_at IS NOT NULL
          AND id NOT IN (SELECT fragment_id FROM emotion_events)`;
    if (Array.isArray(ids) && ids.length) {
        rows = db.prepare(`${base} AND id IN (${ids.map(() => '?').join(',')}) ORDER BY raised_at, id`).all(...ids);
    } else if (Array.isArray(ids)) {
        return [];
    } else {
        rows = db.prepare(`${base} ORDER BY raised_at, id`).all();
    }
    const run = db.transaction((r) => processOne(db, r, cfg));
    return rows.map(r => ({ id: r.id, ...run(r) }));
}

// 清掉所有學到的統計後，依 raised_at 順序重放
function rebuildEmotionState(db) {
    db.transaction(() => {
        for (const t of ['emotion_baseline_stats', 'emotion_state', 'emotion_events', 'emotion_entity_stats', 'emotion_topic_slot']) {
            db.exec(`DELETE FROM ${t}`);
        }
    })();
    return processFragments(db);
}

module.exports = { resolveRaisedAt, resolveEventAt, applyScribeEmotion, processFragments, rebuildEmotionState, accumulate, decayFactor, loadStats, loadStates, SLOTS };
