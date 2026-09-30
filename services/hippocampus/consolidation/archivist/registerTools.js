// =================================================================
// services/archivist/registerTools.js — 工具註冊（載入時執行一次）
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { registerTool } = require('./runtime');
const { classifyFragments } = require('./classify');
const { consolidateCategory } = require('./episode');
const { detectEmergentPlacesAndEvents } = require('./emergent');
const { MIN_GAP_PATTERN_CLUSTER, maintainPatterns, clusterObservations } = require('./patterns');
const { regenerateEntityOverviews } = require('./entityOverview');
const { discoverEntityRelationships } = require('./entityDiscovery');
const { extractFragmentInsights } = require('./insights');


// ═══════════════════════════════════════════════════════
// Tool Registration — called after module loads
// ═══════════════════════════════════════════════════════

function registerAllTools() {
    registerTool('classify_fragments', classifyFragments,
        '未分類碎片自動分類（質心相似度 + LLM校驗）');
    registerTool('discover_relationships', discoverEntityRelationships,
        '從碎片中推斷人物與User的關係，建立/更新 entity_profiles');
    registerTool('extract_insights', extractFragmentInsights,
        '提取碎片揭示的User個人特質/價值觀/行為模式');
    registerTool('detect_emergent_places_events', detectEmergentPlacesAndEvents,
        '湧現地點/事件檢測：聚類未連結place/event的碎片，補漏掉的星座');
    registerTool('regenerate_entity_overviews', regenerateEntityOverviews,
        '為實體生成 Companion 視角的敘事概述');
    registerTool('maintain_patterns', maintainPatterns,
        '維護已有行為模式——bigram匹配新碎片、追加證據、重新整理freshness、檢測漂移',
        'bigram', 'zero', 'zero', { cooldown: MIN_GAP_PATTERN_CLUSTER },
        '輕量維護已有行為模式（零LLM+零ChromaDB）');
    registerTool('cluster_observations', clusterObservations,
        '行為模式聚類（maintainPatterns別名，相容舊排程）',
        'bigram', 'zero', 'zero', { cooldown: MIN_GAP_PATTERN_CLUSTER },
        '行為模式維護和聚類');
    registerTool('consolidate_category', consolidateCategory,
        '按類別合併高密度碎片的碎片為episode，更新描述和質心');
}

// Register on load (once only — require() may re-enter via entityResolver circular imports)
if (!global.__archivistToolsRegistered) {
    global.__archivistToolsRegistered = true;
    registerAllTools();
}

module.exports = {
    registerAllTools,
};
