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
        '未分类碎片自动分类（质心相似度 + LLM校验）');
    registerTool('discover_relationships', discoverEntityRelationships,
        '从碎片中推断人物与User的关系，创建/更新 entity_profiles');
    registerTool('extract_insights', extractFragmentInsights,
        '提取碎片揭示的User个人特质/价值观/行为模式');
    registerTool('detect_emergent_places_events', detectEmergentPlacesAndEvents,
        '涌现地点/事件检测：聚类未链接place/event的碎片，补漏掉的星座');
    registerTool('regenerate_entity_overviews', regenerateEntityOverviews,
        '为实体生成 Companion 视角的叙事概述');
    registerTool('maintain_patterns', maintainPatterns,
        '维护已有行为模式——bigram匹配新碎片、追加证据、刷新freshness、检测漂移',
        'bigram', 'zero', 'zero', { cooldown: MIN_GAP_PATTERN_CLUSTER },
        '轻量维护已有行为模式（零LLM+零ChromaDB）');
    registerTool('cluster_observations', clusterObservations,
        '行为模式聚类（maintainPatterns别名，兼容旧调度）',
        'bigram', 'zero', 'zero', { cooldown: MIN_GAP_PATTERN_CLUSTER },
        '行为模式维护和聚类');
    registerTool('consolidate_category', consolidateCategory,
        '按类别合并高密度碎片的碎片为episode，更新描述和质心');
}

// Register on load (once only — require() may re-enter via entityResolver circular imports)
if (!global.__archivistToolsRegistered) {
    global.__archivistToolsRegistered = true;
    registerAllTools();
}

module.exports = {
    registerAllTools,
};
