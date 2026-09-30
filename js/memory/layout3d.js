// ========================================
// 記憶星圖 4D — 3D 排版與時間軸純函式
// 不依賴 DOM / three.js / data.js，瀏覽器（ES module）與 Node 測試都能直接載入。
// 全程確定性：只用 mulberry32(hash(id))，不碰 Math.random / Date.now，
// 所以重新整理位置不會亂跳；新增一顆星時只有同星座少數鄰居被輕微推開。
// ========================================

export function strHash(str) {
    let h = 2166136261;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Box-Muller：標準常態亂數（截在 ±2.5σ，避免極端離群點）
export function gaussian(rng) {
    const u = Math.max(rng(), 1e-9), v = rng();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(-2.5, Math.min(2.5, g));
}

export const DEFAULTS = {
    ringRadius: 100,        // 星系錨點所在球殼／傾斜圓盤半徑
    tilt: 0.38,             // 圓盤繞 x 軸傾斜（弧度）
    galaxyBase: 24,         // 星系半徑 = base + k*sqrt(星座數)
    galaxyK: 5,
    conBase: 3,             // 星座半徑 = base + k*sqrt(星數)
    conK: 0.9,
    conGap: 2.5,            // 星座之間的最小間隙
    starMinDist: 0.8,       // 星與星最小距離
    starSigmaRatio: 0.5,    // 星座內高斯抖動 σ = 星座半徑 * ratio
    conIterations: 140,
};

function hashVec(id, salt, sigma) {
    const rng = mulberry32(strHash(id + '#' + salt));
    return [gaussian(rng) * sigma, gaussian(rng) * sigma, gaussian(rng) * sigma];
}

export function conRadius(nStars, o = DEFAULTS) { return o.conBase + o.conK * Math.sqrt(Math.max(0, nStars)); }
export function galaxyRadius(nCons, o = DEFAULTS) { return o.galaxyBase + o.galaxyK * Math.sqrt(Math.max(0, nCons)); }

// 星系錨點：方位角沿用 2D 版，放在繞 x 軸傾斜的圓盤上，再加一點確定性的高度起伏
export function galaxyAnchor(g, o = DEFAULTS) {
    const az = (g.azimuth !== undefined ? g.azimuth : (strHash(g.id) % 360)) * Math.PI / 180;
    const x = Math.cos(az) * o.ringRadius;
    const z = Math.sin(az) * o.ringRadius;
    const y0 = Math.sin(az * 2 + 0.7) * o.ringRadius * 0.16;
    // 繞 x 軸傾斜
    const ct = Math.cos(o.tilt), st = Math.sin(o.tilt);
    return { x, y: y0 * ct - z * st, z: y0 * st + z * ct };
}

/**
 * 計算整張星圖的 3D 位置。
 * input: {
 *   galaxies: [{id, azimuth}],
 *   constellations: [{id, galaxyId, stars:[{id}]}],
 *   bridges: [{a, b, weight}]   // conId 對
 * }
 * 回傳 { galaxies:{id:{x,y,z,r}}, cons:{id:{x,y,z,r,galaxyId}}, stars:{"conId|starId":{x,y,z,conId,starId}}, radius }
 */
export function computeLayout3D(input, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const galaxyList = [...(input.galaxies || [])];
    const cons = [...(input.constellations || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    // 星系清單補上出現在星座裡卻沒定義的 id
    const known = new Set(galaxyList.map(g => g.id));
    for (const c of cons) if (!known.has(c.galaxyId)) { known.add(c.galaxyId); galaxyList.push({ id: c.galaxyId }); }

    const out = { galaxies: {}, cons: {}, stars: {}, radius: 0 };
    const consOf = {};
    for (const c of cons) (consOf[c.galaxyId] = consOf[c.galaxyId] || []).push(c);

    for (const g of galaxyList) {
        const list = consOf[g.id] || [];
        const a = galaxyAnchor(g, o);
        out.galaxies[g.id] = { x: a.x, y: a.y, z: a.z, r: galaxyRadius(list.length, o) };
    }

    const conById = {};
    for (const c of cons) conById[c.id] = c;
    const bridges = (input.bridges || []).filter(b => conById[b.a] && conById[b.b]);

    // ── 星座：每個星系各跑一次力導向 ──
    for (const g of galaxyList) {
        const list = consOf[g.id] || [];
        if (!list.length) continue;
        const G = out.galaxies[g.id];
        const nodes = list.map(c => {
            const r = conRadius((c.stars || []).length, o);
            const v = hashVec(c.id, 'con', G.r * 0.4);   // 高斯初始抖動，只跟自己的 id 有關
            return { id: c.id, r, x: G.x + v[0], y: G.y + v[1], z: G.z + v[2], dx: 0, dy: 0, dz: 0 };
        });
        const idx = {};
        nodes.forEach((n, i) => { idx[n.id] = i; });
        const inBridges = [], outBridges = [];
        for (const b of bridges) {
            const ia = idx[b.a], ib = idx[b.b];
            const w = Math.min(6, Math.max(1, b.weight || 1));
            if (ia !== undefined && ib !== undefined) inBridges.push({ ia, ib, w });
            else if (ia !== undefined && conById[b.b]) outBridges.push({ i: ia, other: conById[b.b].galaxyId, w });
            else if (ib !== undefined && conById[b.a]) outBridges.push({ i: ib, other: conById[b.a].galaxyId, w });
        }
        const bound = G.r * 0.85;
        for (let it = 0; it < o.conIterations; it++) {
            const temp = 1 - it / o.conIterations * 0.85;
            for (const n of nodes) { n.dx = n.dy = n.dz = 0; }
            // 斥力 / 防重疊
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const A = nodes[i], B = nodes[j];
                    let dx = A.x - B.x, dy = A.y - B.y, dz = A.z - B.z;
                    let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (d < 1e-6) { dx = 1e-3 * (i + 1); dy = 1e-3; dz = 1e-3 * (j + 1); d = Math.sqrt(dx * dx + dy * dy + dz * dz); }
                    const need = A.r + B.r + o.conGap;
                    let f = 0;
                    if (d < need) f += (need - d) * 0.5;
                    f += 40 / (d * d + 4);                // 軟斥力
                    const ux = dx / d, uy = dy / d, uz = dz / d;
                    A.dx += ux * f; A.dy += uy * f; A.dz += uz * f;
                    B.dx -= ux * f; B.dy -= uy * f; B.dz -= uz * f;
                }
            }
            // 橋 = 吸引力（彈簧，靜止長度為兩星座相切距離的 1.15 倍，只在比這更遠時才拉近）
            for (const b of inBridges) {
                const A = nodes[b.ia], B = nodes[b.ib];
                const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
                const rest = (A.r + B.r + o.conGap) * 1.15;
                if (d <= rest) continue;                   // 只拉近、不推開
                const f = (d - rest) * 0.08 * b.w;
                A.dx += dx / d * f; A.dy += dy / d * f; A.dz += dz / d * f;
                B.dx -= dx / d * f; B.dy -= dy / d * f; B.dz -= dz / d * f;
            }
            // 跨星系的橋：輕輕朝對方星系的錨點偏
            for (const b of outBridges) {
                const O = out.galaxies[b.other];
                if (!O) continue;
                const N = nodes[b.i];
                const dx = O.x - N.x, dy = O.y - N.y, dz = O.z - N.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
                N.dx += dx / d * 0.12 * b.w; N.dy += dy / d * 0.12 * b.w; N.dz += dz / d * 0.12 * b.w;
            }
            // 彈簧拉回錨點 + 位移上限（降溫）
            for (const n of nodes) {
                n.dx += (G.x - n.x) * 0.06; n.dy += (G.y - n.y) * 0.06; n.dz += (G.z - n.z) * 0.06;
                const m = Math.sqrt(n.dx * n.dx + n.dy * n.dy + n.dz * n.dz);
                const cap = 2.5 * temp;
                const k = m > cap ? cap / m : 1;
                n.x += n.dx * k; n.y += n.dy * k; n.z += n.dz * k;
                const ox = n.x - G.x, oy = n.y - G.y, oz = n.z - G.z;
                const od = Math.sqrt(ox * ox + oy * oy + oz * oz);
                if (od > bound) { const s = bound / od; n.x = G.x + ox * s; n.y = G.y + oy * s; n.z = G.z + oz * s; }
            }
        }
        for (const n of nodes) out.cons[n.id] = { x: n.x, y: n.y, z: n.z, r: n.r, galaxyId: g.id };
    }

    // ── 星：星座中心 + 高斯抖動，再做確定性的分離 ──
    const all = [];
    for (const c of cons) {
        const C = out.cons[c.id];
        if (!C) continue;
        const sigma = C.r * o.starSigmaRatio;
        const local = (c.stars || []).map(s => {
            const key = c.id + '|' + s.id;
            const v = hashVec(key, 'star', sigma);
            return { key, conId: c.id, starId: s.id, x: C.x + v[0], y: C.y + v[1], z: C.z + v[2] };
        }).sort((a, b) => (a.key < b.key ? -1 : 1));
        separate(local, o.starMinDist, 40);
        for (const s of local) all.push(s);
    }
    // 全域再擠一次（不同星座的星可能貼在一起），用網格加速
    separateGrid(all, o.starMinDist, 12);
    let maxR = 0;
    for (const s of all) {
        out.stars[s.key] = { x: s.x, y: s.y, z: s.z, conId: s.conId, starId: s.starId };
        maxR = Math.max(maxR, Math.hypot(s.x, s.y, s.z));
    }
    for (const c of Object.values(out.cons)) maxR = Math.max(maxR, Math.hypot(c.x, c.y, c.z) + c.r);
    for (const g of Object.values(out.galaxies)) maxR = Math.max(maxR, Math.hypot(g.x, g.y, g.z));
    out.radius = maxR;
    return out;
}

function pushApart(A, B, minD, i, j) {
    let dx = A.x - B.x, dy = A.y - B.y, dz = A.z - B.z;
    let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= minD) return false;
    if (d < 1e-9) { dx = 1 + (i % 3); dy = 1 + (j % 5); dz = 1; d = Math.sqrt(dx * dx + dy * dy + dz * dz); }
    const push = (minD - d) * 0.5 + 1e-4;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    A.x += ux * push; A.y += uy * push; A.z += uz * push;
    B.x -= ux * push; B.y -= uy * push; B.z -= uz * push;
    return true;
}

function separate(list, minD, passes) {
    for (let p = 0; p < passes; p++) {
        let moved = false;
        for (let i = 0; i < list.length; i++)
            for (let j = i + 1; j < list.length; j++)
                if (pushApart(list[i], list[j], minD, i, j)) moved = true;
        if (!moved) break;
    }
}

function separateGrid(list, minD, passes) {
    for (let p = 0; p < passes; p++) {
        const grid = new Map();
        const cell = minD;
        const key = (x, y, z) => x + ',' + y + ',' + z;
        list.forEach((s, i) => {
            const k = key(Math.floor(s.x / cell), Math.floor(s.y / cell), Math.floor(s.z / cell));
            let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
        });
        let moved = false;
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            const cx = Math.floor(s.x / cell), cy = Math.floor(s.y / cell), cz = Math.floor(s.z / cell);
            for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++) {
                const a = grid.get(key(x, y, z));
                if (!a) continue;
                for (const j of a) if (j > i && pushApart(s, list[j], minD, i, j)) moved = true;
            }
        }
        if (!moved) break;
    }
}

// ══════════════ 第四維：時間 ══════════════

const DAY = 86400000;

// SQLite 的 CURRENT_TIMESTAMP 是 UTC 的 'YYYY-MM-DD HH:MM:SS'（沒有時區標記）
export function parseSqlTime(s) {
    if (s === null || s === undefined || s === '') return NaN;
    if (typeof s === 'number') return s;
    const str = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return Date.parse(str + 'T00:00:00Z');
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(str)) return Date.parse(str.replace(' ', 'T') + (str.length === 16 ? ':00' : '') + 'Z');
    return Date.parse(str);
}

/** 時間軸範圍：最早到最新的 created_at（至少含 now，且範圍不為 0） */
export function timeRange(items, now) {
    let min = Infinity, max = -Infinity;
    for (const it of items) {
        const t = it.createdMs;
        if (Number.isFinite(t)) { if (t < min) min = t; if (t > max) max = t; }
    }
    if (!Number.isFinite(min)) { min = now - DAY; max = now; }
    if (Number.isFinite(now) && now > max) max = now;
    if (max - min < DAY) max = min + DAY;
    return { min, max };
}

// 冷卻／凍結的時間近似：後端只知道「現在」的生命週期狀態，
// 所以假設一顆現在冷卻的星，是在最後一次被想起（或誕生）後 COOL_AFTER 天開始冷卻，再過 FREEZE_AFTER 天凍結。
export const COOL_AFTER_DAYS = 14;
export const FREEZE_AFTER_DAYS = 30;
export const RECALL_HALFLIFE_DAYS = 10;

/** 某顆星在時間 t 的生命週期：'active' | 'cooling' | 'frozen' */
export function lifecycleAt(star, t, now) {
    const cur = star.lifecycle || 'active';
    if (cur === 'active' || cur === 'consolidated') return 'active';
    const ref = Number.isFinite(star.lastAccessedMs) ? star.lastAccessedMs : star.createdMs;
    let coolStart = ref + COOL_AFTER_DAYS * DAY;
    // 不可能在「現在」之後才冷卻（否則現在的狀態對不上）
    if (Number.isFinite(now) && coolStart > now - DAY) coolStart = now - DAY;
    if (coolStart < star.createdMs) coolStart = star.createdMs;
    if (t < coolStart) return 'active';
    if (cur === 'cooling') return 'cooling';
    // 現在是 frozen
    let freezeStart = coolStart + FREEZE_AFTER_DAYS * DAY;
    if (Number.isFinite(now) && freezeStart > now - DAY / 2) freezeStart = Math.max(coolStart, now - DAY / 2);
    return t < freezeStart ? 'cooling' : 'frozen';
}

/**
 * 某顆星在時間 t 的呈現狀態。
 *  visible：t >= createdMs
 *  fade：誕生後 fadeMs 內由 0 淡入到 1
 *  glow：最近被回憶（last_accessed_at）的亮度加成 0..1，隨時間指數衰減；
 *        尚未被回憶過的星以誕生時刻當作第一次被想起。
 */
export function starStateAt(star, t, now, fadeMs = 3 * DAY) {
    if (!(t >= star.createdMs)) return { visible: false, fade: 0, glow: 0, lifecycle: 'active' };
    const fade = Math.min(1, (t - star.createdMs) / Math.max(1, fadeMs));
    let ref = star.createdMs;
    if (Number.isFinite(star.lastAccessedMs) && star.lastAccessedMs <= t && star.lastAccessedMs > ref) ref = star.lastAccessedMs;
    const ageDays = Math.max(0, (t - ref) / DAY);
    const bonus = Math.min(0.25, Math.log(1 + (star.readCount || 0)) * 0.06);
    const glow = Math.min(1, Math.pow(0.5, ageDays / RECALL_HALFLIFE_DAYS) + bonus);
    return { visible: true, fade, glow, lifecycle: lifecycleAt(star, t, now) };
}

/** 時間篩選：回傳在時間 t 已存在的星（保留原順序） */
export function filterVisible(stars, t) {
    return stars.filter(s => t >= s.createdMs);
}
