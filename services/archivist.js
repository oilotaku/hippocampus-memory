// =================================================================
// Archivist Agent — 记忆认知核心
//
// 自主节律：Agent 循环 (2min tick) + 事件驱动 + Companion 感知
// 职责：分类碎片、维护知识树、发现关系、提取洞察
// 类比：养一棵树 — 浇水(分类)/修剪(拆分)/除草(纠错)/观察(主题发现)
//
// 数据源：聊天消息（经 ingest API 写入）
// 所有数据源的碎片统一走分类管道 → 知识树
// =================================================================

const os = require('os');
const EventEmitter = require('events');
const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { chromaDBOperation } = require('./memory');
const { WORLD_CONTEXT } = require('./worldContext');
const { getTagRouting } = require('./tagRouting');
const { SKIP_NAMES, USER, AI } = require('./memoryConfig');
const { runUserModelCycle, matchEvidenceFromFragments, harvestFacts, processModelDecay, resolveExpiredStates, MIN_GAP_USER_MODEL } = require('./cognitiveModel');
// ── W7 拆分進行中：以下名稱已搬到 services/archivist/ ──
const { archivistEvents, agentState, registerTool, getTool, listTools, isCompanionActive, setCompanionActive } = require('./archivist/runtime');
const { isTimePhraseName, isPeriodPhraseName, isNoChangeSentinel } = require('./archivist/guards');
const { _mentionWeight, _entityMentionOwners, _aliasAmbiguous, ensureTagEntities, linkTaggedFragment, linkTaggedFragments } = require('./archivist/entityLink');
const { generateDailyEntityStatus } = require('./archivist/dailyStatus');
const { reviewEntityRelations, discoverTagRelations, discoverRelatedEntities } = require('./archivist/relations');
const { mergeDuplicateSeeds, executeEntityMerge, graduateSeedsAndPrune } = require('./archivist/seeds');
const { classifyFragments, classifyFragmentBatch, spotCheckClassifications, reviewConstellationAfterClassification } = require('./archivist/classify');
const { rematchFragmentsForSeeds, semanticRematchForSeeds } = require('./archivist/rematch');
const { refreshIntuitionStopwords } = require('./archivist/intuitionStopwords');
const { consolidateCategory } = require('./archivist/episode');
const { buildEmergentJudgePrompt, screenEmergentVerdict, detectEmergentPlacesAndEvents } = require('./archivist/emergent');
const { MIN_GAP_PATTERN_CLUSTER, maintainPatterns, clusterObservations } = require('./archivist/patterns');
const { regenerateEntityOverviews } = require('./archivist/entityOverview');
const { scanContentForNewEntities, discoverEntityRelationships } = require('./archivist/entityDiscovery');
const { extractFragmentInsights } = require('./archivist/insights');
const { start, stop, getStatus } = require('./archivist/tick');

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

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

module.exports = {
    // 按值标路由的聚合星座（测试/脚本要用）
    ensureTagEntities,
    linkTaggedFragment,
    linkTaggedFragments,
    // 守卫规则（导出供回归测试复用；改名单/哨兵词表时先看 archivistGuards.test.js）
    isTimePhraseName,
    isPeriodPhraseName,
    isNoChangeSentinel,
    // 涌现判据（导出供回归探针复用，别另抄一份会走样的）
    buildEmergentJudgePrompt,
    screenEmergentVerdict,
    // 别名的三道门（字面链接器用它决定哪些别名敢拿去 LIKE 匹配）。
    // 导出供回归测试复用——改判据时先看 archivistGuards.test.js 的第 4 节。
    _mentionWeight,
    _aliasAmbiguous,
    _entityMentionOwners,
    // 关系表体检 + 标签桥（导出供一次性清理脚本 + 探针复用）
    reviewEntityRelations,
    discoverTagRelations,
    // Agent lifecycle
    start,
    stop,
    getStatus,
    setCompanionActive,
    isCompanionActive,
    archivistEvents,

    // Tool registry
    registerTool,
    getTool,
    listTools,

    // Individual tools (direct access)
    classifyFragments,
    classifyFragmentBatch,
    rematchFragmentsForSeeds,
    semanticRematchForSeeds,
    mergeDuplicateSeeds,
    executeEntityMerge,
    discoverRelatedEntities,
    detectEmergentPlacesAndEvents,
    refreshIntuitionStopwords,
    // 仅供独立脚本（classifyBacklog/growFromScratch）逐轮重置 tick 预算，服务进程不要调
    resetTickBudget: () => { agentState.tickLLMCalls = 0; },
    graduateSeedsAndPrune,

    // User behavior patterns (v5.10)
    maintainPatterns,
    clusterObservations,
    spotCheckClassifications,
    reviewConstellationAfterClassification,
    discoverEntityRelationships,
    extractFragmentInsights,
    regenerateEntityOverviews,
    consolidateCategory,
    scanContentForNewEntities,

    // 每日主角状态（cron 调用；entityProfile/lifecycle 靠「跳过主角」避让，别改成
    // 只在这儿写——两处都写会互相漂移）
    generateDailyEntityStatus,
};
