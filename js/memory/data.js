// ========================================
// 記憶星圖 v5 — 資料層
// fetch universe API、星系定義、顏色分配（hash hue 偏移）、跨星系橋推導
// ========================================

const TOKEN = () => localStorage.getItem('token');
const AUTH = () => ({ headers: { 'Authorization': `Bearer ${TOKEN()}` } });

// ── 五固定星系（方位角：上/右上/右下/左下/左上） ──
// 「{{user}}的」星系 ID 由 memory_config.json 動態生成
const UI = window.MEMORY_UI_CONFIG || { user: { name: 'User' } };
export const OWN_GALAXY_ID = UI.user.name + '的';

export const GALAXIES = [
    { id: '愛好', hue: 0,   azimuth: -90, desc: '遊戲、影視、書籍、音樂——喜歡的東西' },
    { id: '社交', hue: 22,  azimuth: -18, desc: '人際關係網——認識的人、養的寵物' },
    { id: '創作', hue: 275, azimuth: 54,  desc: '創作——小說、程式碼、專案、工作' },
    { id: '事件', hue: 152, azimuth: 126, desc: '有時間跨度的經歷' },
    { id: '地點', hue: 215, azimuth: 198, desc: '走過的物理空間' },
];
export const GALAXY_BY_ID = Object.fromEntries(GALAXIES.map(g => [g.id, g]));

// ── 確定性 hash / PRNG ──
export function strHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
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

// ── 星系色相家族：基準 hue + 名字 hash 偏移 ±25° ──
export function colorFor(galaxyId, name) {
    const g = GALAXY_BY_ID[galaxyId] || GALAXIES[0];
    const h = strHash(name);
    const hue = (g.hue + (h % 51) - 25 + 360) % 360;
    const sat = 62 + ((h >>> 8) % 18);          // 62-79%
    const lit = 62 + ((h >>> 16) % 14);         // 62-75%
    return { hue, sat, lit, css: `hsl(${hue},${sat}%,${lit}%)` };
}

export function hslToRgbStr(hue, sat, lit) {
    const s = sat / 100, l = lit / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return `${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)}`;
}

// ── 宇宙資料（模組內單例） ──
export const universe = {
    constellations: [],   // 普通星座（不含雙星核心）
    core: [],             // 雙星核心檔案
    userModel: [],
    archlog: [],
    mergeProposals: [],   // 待使用者裁決的合併提案
    bridges: [],          // 星座橋 [{a, b, weight}]（conId 對）
    galaxyBridges: [],    // 星系聚合橋 [{a, b, weight}]（galaxyId 對）
    totalFragments: 0,
    loaded: false,
};

// 橋推導，兩個來源：
// 1) 後端 related_entities（Archivist 維護，帶關係描述）— 優先
// 2) 共享碎片推導（前端兜底，無語義標籤）
function deriveBridges(cons) {
    const conByEntId = new Map(); // 數字實體id → con
    cons.forEach(c => conByEntId.set(parseInt(c.id.slice(1), 10), c));

    // 來源1：related_entities
    const labeled = new Map(); // "a|b" → {weight, relation}
    cons.forEach(c => (c.relatedEntities || []).forEach(r => {
        if (!r || !r.id || !conByEntId.has(r.id)) return;
        const other = conByEntId.get(r.id);
        const key = c.id < other.id ? c.id + '|' + other.id : other.id + '|' + c.id;
        if (!labeled.has(key)) labeled.set(key, { weight: r.shared_count || 2, relation: r.relation || '' });
    }));
    if (labeled.size > 0) {
        const conById = Object.fromEntries(cons.map(c => [c.id, c]));
        const bridges = [];
        labeled.forEach((v, key) => {
            const [a, b] = key.split('|');
            bridges.push({ a, b, weight: v.weight, relation: v.relation });
        });
        const gPair = new Map();
        bridges.forEach(br => {
            const ga = conById[br.a]?.galaxyLabel, gb = conById[br.b]?.galaxyLabel;
            if (!ga || !gb || ga === gb) return;
            const k = ga < gb ? ga + '|' + gb : gb + '|' + ga;
            gPair.set(k, (gPair.get(k) || 0) + br.weight);
        });
        const galaxyBridges = [];
        gPair.forEach((weight, k) => { const [a, b] = k.split('|'); galaxyBridges.push({ a, b, weight }); });
        return { bridges, galaxyBridges };
    }
    // 來源2：兜底推導
    return deriveBridgesFromSharedFragments(cons);
}

function deriveBridgesFromSharedFragments(cons) {
    const fragMap = new Map(); // fragId → [conId]
    cons.forEach(c => c.stars.forEach(s => {
        if (!fragMap.has(s.id)) fragMap.set(s.id, []);
        fragMap.get(s.id).push(c.id);
    }));
    const pairCount = new Map(); // "a|b" → count
    fragMap.forEach(conIds => {
        if (conIds.length < 2) return;
        for (let i = 0; i < conIds.length; i++)
            for (let j = i + 1; j < conIds.length; j++) {
                const key = conIds[i] < conIds[j] ? conIds[i] + '|' + conIds[j] : conIds[j] + '|' + conIds[i];
                pairCount.set(key, (pairCount.get(key) || 0) + 1);
            }
    });
    const conById = Object.fromEntries(cons.map(c => [c.id, c]));
    const bridges = [];
    pairCount.forEach((count, key) => {
        if (count < 2) return; // 共享碎片 ≥2 才畫橋
        const [a, b] = key.split('|');
        bridges.push({ a, b, weight: count });
    });
    // 星系級聚合
    const gPair = new Map();
    bridges.forEach(br => {
        const ga = conById[br.a]?.galaxyLabel, gb = conById[br.b]?.galaxyLabel;
        if (!ga || !gb || ga === gb) return;
        const key = ga < gb ? ga + '|' + gb : gb + '|' + ga;
        gPair.set(key, (gPair.get(key) || 0) + br.weight);
    });
    const galaxyBridges = [];
    gPair.forEach((weight, key) => {
        const [a, b] = key.split('|');
        galaxyBridges.push({ a, b, weight });
    });
    return { bridges, galaxyBridges };
}

export async function loadUniverse() {
    const resp = await fetch('/api/memory/universe', AUTH());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();

    const cons = (data.constellations || []).map(c => {
        const galaxyLabel = c.galaxyLabel || OWN_GALAXY_ID;
        const col = colorFor(galaxyLabel, c.label);
        return {
            ...c,
            galaxyLabel,
            color: col.css,
            rgb: hslToRgbStr(col.hue, col.sat, col.lit),
            stars: (c.stars || []).map(s => ({
                ...s,
                conId: c.id,
                conLabel: c.label,
            })),
        };
    });

    const { bridges, galaxyBridges } = deriveBridges(cons);

    universe.constellations = cons;
    universe.core = data.core || [];
    universe.userModel = data.cognitiveModel || [];   // 後端 /universe 返回的鍵名是 cognitiveModel
    universe.patterns = data.patterns || [];
    universe.archlog = data.archlog || [];
    universe.mergeProposals = data.mergeProposals || [];
    universe.bridges = bridges;
    universe.galaxyBridges = galaxyBridges;
    universe.totalFragments = data.total_fragments || 0;
    universe.loaded = true;
    return universe;
}

export function consOfGalaxy(galaxyId) {
    return universe.constellations.filter(c => c.galaxyLabel === galaxyId);
}

export function conById(id) {
    return universe.constellations.find(c => c.id === id) || null;
}

// 碎片訪問打點（重新整理 decay 亮度），fire-and-forget。
// ⚠️ G4：星圖「點星瀏覽」不可呼叫這個——它會把瀏覽算成回憶（read/access_count、last_accessed_at），
// 汙染生命週期衰減。目前星圖前端已不再呼叫；函式保留（語意不變）供確實需要標記「被想起」的呼叫端使用。
export function bumpAccess(starId) {
    if (starId && starId.startsWith('f')) {
        fetch('/api/memory/trace/' + starId.slice(1), AUTH()).catch(() => {});
    }
}

// 合併提案裁決（CSRF 由頁面 meta 注入；memory.html 不走 api.js 的 fetch 補丁）
export async function decideMergeProposal(proposalId, decision) {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const resp = await fetch('/api/memory/merge-proposal/' + proposalId, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TOKEN()}`,
            'X-CSRF-Token': csrfMeta ? csrfMeta.getAttribute('content') : '',
        },
        body: JSON.stringify({ decision }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    universe.mergeProposals = universe.mergeProposals.filter(p => p.id !== proposalId);
    return resp.json();
}
