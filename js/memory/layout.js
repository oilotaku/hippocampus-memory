// ========================================
// 記憶星圖 v5 — 佈局層
// 三套確定性佈局：universe / galaxy 俯瞰 / constellation 展開
// 所有隨機量來自 mulberry32(seed)，重新整理零抖動
// ========================================

import { GALAXIES, GALAXY_BY_ID, strHash, mulberry32, consOfGalaxy, universe } from './data.js';

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// ── universe 檢視 ──
// 雙星核心居中；四星系按固定方位角環繞；星系內星座做種子化 spiral 擺位（星團點）
export function layoutUniverse(W, H) {
    const cx = W / 2, cy = H / 2;
    const orbitR = Math.min(W, H) * 0.32;
    const galaxies = GALAXIES.map(g => {
        const ang = g.azimuth * Math.PI / 180;
        const gx = cx + Math.cos(ang) * orbitR * (W > H ? 1.25 : 0.9);
        const gy = cy + Math.sin(ang) * orbitR;
        const cons = consOfGalaxy(g.id);
        const nebulaR = Math.min(W, H) * 0.17 + Math.sqrt(cons.length + 1) * 6;
        // 星系內星座：種子化 sunflower spiral（按碎片數降序，大的居中）
        const sorted = [...cons].sort((a, b) => (b.fragment_count || 0) - (a.fragment_count || 0));
        const rng = mulberry32(strHash(g.id));
        const points = sorted.map((c, i) => {
            const angle = i * GOLDEN + rng() * 0.5;
            const r = nebulaR * 0.78 * Math.sqrt((i + 0.5) / Math.max(sorted.length, 1));
            return {
                con: c,
                x: gx + Math.cos(angle) * r,
                y: gy + Math.sin(angle) * r,
                r: Math.max(2.0, Math.min(5.5, 1.8 + Math.sqrt(c.stars.length) * 0.7)),
            };
        });
        return { galaxy: g, x: gx, y: gy, nebulaR, points };
    });
    return { cx, cy, coreOrbitR: Math.min(W, H) * 0.035, galaxies };
}

// ── galaxy 俯瞰檢視 ──
// 該星系星座全屏 spiral 鋪開，星座半徑 ∝ sqrt(star數)，星座內有個體星點
// v5.1: 視覺半徑與點選半徑分離，加碰撞推開避免星座重疊無法點選
export function layoutGalaxy(galaxyId, W, H) {
    const cons = [...consOfGalaxy(galaxyId)].sort((a, b) => (b.fragment_count || 0) - (a.fragment_count || 0));
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.40;
    const placed = [];
    cons.forEach((c, i) => {
        const seed = strHash(c.id + c.label);
        const rng = mulberry32(seed);
        const angle = i * GOLDEN + rng() * 0.6;
        const r = maxR * Math.sqrt((i + 0.5) / Math.max(cons.length, 1));
        const conX = cx + Math.cos(angle) * r * (W > H ? 1.35 : 1);
        const conY = cy + Math.sin(angle) * r;
        // 視覺半徑：小幅增長，上限收緊；點選半徑：至少 30px 保證可點
        const conR = Math.min(70, 18 + Math.sqrt(c.stars.length) * 7);
        const hitR = Math.max(conR, 30);
        placed.push({ con: c, x: conX, y: conY, r: conR, hitR, stars: layoutStarsInCon(c, conX, conY, conR) });
    });
    // 碰撞推開：中心距 < hitR1+hitR2+8px → 推開，3輪迭代
    for (let iter = 0; iter < 3; iter++) {
        for (let i = 0; i < placed.length; i++) {
            for (let j = i + 1; j < placed.length; j++) {
                const a = placed[i], b = placed[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const dist = Math.hypot(dx, dy);
                const minDist = a.hitR + b.hitR + 8;
                if (dist < minDist && dist > 0.01) {
                    const push = (minDist - dist) / 2;
                    const nx = dx / dist, ny = dy / dist;
                    a.x -= nx * push; a.y -= ny * push;
                    b.x += nx * push; b.y += ny * push;
                }
            }
        }
    }
    return { galaxy: GALAXY_BY_ID[galaxyId], cx, cy, cons: placed };
}

// ── constellation 展開檢視 ──
// 星星全屏環繞分佈：亮星（conf 高）靠內大，暗星靠外小
export function layoutConstellation(con, W, H) {
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.36;
    const stars = layoutStarsInCon(con, cx, cy, R, true);
    return { con, cx, cy, R, stars };
}

// 星座內星點排布（共用）：seed=fragment id；expanded 模式按 conf 排序內亮外暗
function layoutStarsInCon(con, cx, cy, R, expanded = false) {
    const list = expanded
        ? [...con.stars].sort((a, b) => (b.conf || 0) - (a.conf || 0))
        : con.stars;
    const n = Math.max(list.length, 1);
    return list.map((s, i) => {
        const seed = strHash(s.id);
        const rng = mulberry32(seed);
        const angle = i * GOLDEN + rng() * (expanded ? 0.9 : 1.6);
        // expanded: 排序後 spiral 半徑自然內→外；cluster: 全隨機散佈
        const rNorm = expanded ? Math.sqrt((i + 0.5) / n) : (0.25 + rng() * 0.75);
        const r = R * (expanded ? (0.18 + rNorm * 0.82) : rNorm);
        const baseR = Math.max(1.4, 6.2 - (s.mag || 4) * 0.72) * (expanded ? 1.5 : 0.55);
        return {
            star: s,
            x: cx + Math.cos(angle) * r,
            y: cy + Math.sin(angle) * r,
            baseR,
            phase: rng() * Math.PI * 2,
        };
    });
}

// ── 橋線查詢 ──
// universe 層級：星系間聚合橋端點
export function universeBridgeSegments(uLayout) {
    const gPos = Object.fromEntries(uLayout.galaxies.map(g => [g.galaxy.id, g]));
    return universe.galaxyBridges.map(br => {
        const a = gPos[br.a], b = gPos[br.b];
        if (!a || !b) return null;
        return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, weight: br.weight, r1: a.nebulaR, r2: b.nebulaR };
    }).filter(Boolean);
}

// galaxy 層級：該星系內部星座間的橋 + 跨星系橋只畫到螢幕邊緣方向的提示（省略，畫內部橋即可）
export function galaxyBridgeSegments(gLayout) {
    const pos = Object.fromEntries(gLayout.cons.map(p => [p.con.id, p]));
    return universe.bridges.map(br => {
        const a = pos[br.a], b = pos[br.b];
        if (!a || !b) return null; // 只畫兩端都在本星系的橋
        return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, weight: br.weight, r1: a.r, r2: b.r };
    }).filter(Boolean);
}

// constellation 層級：與當前星座有橋的其他星座（供面板/提示顯示）
export function bridgesOfCon(conId) {
    return universe.bridges
        .filter(br => br.a === conId || br.b === conId)
        .map(br => ({ otherId: br.a === conId ? br.b : br.a, weight: br.weight, relation: br.relation || '' }));
}
