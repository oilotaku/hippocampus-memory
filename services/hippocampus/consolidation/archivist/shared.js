// =================================================================
// services/archivist/shared.js — 共用小工具：向量相似度、連通分量、Companion 人格快取、記憶全景索引
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');


// ═══════════════════════════════════════════════════════
// Utility: Cosine Similarity
// ═══════════════════════════════════════════════════════

function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}


function buildConnectedComponents(pairs, allIds) {
    const adj = new Map();
    for (const id of allIds) adj.set(id, new Set());
    for (const pair of pairs) {
        const a = typeof pair.fragment_a === 'number' ? pair.fragment_a : parseInt(pair.fragment_a);
        const b = typeof pair.fragment_b === 'number' ? pair.fragment_b : parseInt(pair.fragment_b);
        if (adj.has(a) && adj.has(b)) {
            adj.get(a).add(b);
            adj.get(b).add(a);
        }
    }
    const visited = new Set();
    const components = [];
    for (const id of allIds) {
        if (visited.has(id) || !adj.has(id)) continue;
        const comp = new Set();
        const stack = [id];
        while (stack.length > 0) {
            const node = stack.pop();
            if (visited.has(node)) continue;
            visited.add(node);
            comp.add(node);
            for (const neighbor of adj.get(node) || []) {
                if (!visited.has(neighbor)) stack.push(neighbor);
            }
        }
        if (comp.size >= 2) components.push(comp);
    }
    return components;
}


// ═══════════════════════════════════════════════════════
// Category Centroid
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Keyword Seeding
// ═══════════════════════════════════════════════════════

let _seedKeywordMap = null;

let _boostKeywordMap = null;


// ═══════════════════════════════════════════════════════
// Core Persona / Daily Status — 認知審計 prompt 的輔助上下文
// ═══════════════════════════════════════════════════════

// Companion 核心人格上下文。OSS 裡人格已由 WORLD_CONTEXT 注入（AI.core_traits），
// 這裡返回空串，保留佔位以免 regenerateEntityOverviews 引用報錯。
let _corePersonaCache = null;

function getCorePersonaContext() {
    if (_corePersonaCache !== null) return _corePersonaCache;
    _corePersonaCache = '';
    return _corePersonaCache;
}


// ═══════════════════════════════════════════════════════
// Memory Landscape — gives the agent full visibility of its own memory structure
// ═══════════════════════════════════════════════════════

function buildLandscapeIndex() {
    const db = getDb();
    // v5.x: 星圖從 entity_profiles 星座讀取（替代已退役的 memory_ontology 話題樹）
    const cats = db.prepare(`
        SELECT id, name AS path, category AS label, facts AS description, fragment_count
        FROM entity_profiles
        WHERE status = 'active'
        ORDER BY fragment_count DESC
        LIMIT 40
    `).all();

    if (cats.length === 0) return '（記憶星圖為空——還沒有任何星座）';

    const lines = [`🪐 記憶星圖 · 當前共 ${cats.length} 個星座`];
    lines.push('═══════════════════════════════════════');
    for (let i = 0; i < cats.length; i++) {
        const c = cats[i];
        const desc = (c.description || '').substring(0, 50);
        lines.push(`${String(i + 1).padStart(2)}. ${c.path} (${c.fragment_count}條)${desc ? ' — ' + desc : ''}`);
    }
    lines.push('═══════════════════════════════════════');
    return lines.join('\n');
}

module.exports = {
    cosineSimilarity,
    buildConnectedComponents,
    _seedKeywordMap,
    _boostKeywordMap,
    _corePersonaCache,
    getCorePersonaContext,
    buildLandscapeIndex,
};
