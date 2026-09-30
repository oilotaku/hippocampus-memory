// =================================================================
// services/archivist/index.js — 對外介面（原 services/archivist.js 的 module.exports，逐字保留）
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
//
// 分檔（依相依順序，下層在前；子模組之間無迴圈 require）：
//   constants.js            模型設定 id、tick 間隔、各任務冷卻（MIN_GAP_*）與門檻常數
//   runtime.js              agent 共用執行期狀態（agentState、事件匯流排、工具登錄檔）、記憶體閘門、Companion 活動旗標、LLM 呼叫預算、任務執行與冷卻
//   guards.js               名稱守衛（時間／期間短語）、「無變化」哨兵、名稱兩字組
//   shared.js               共用小工具：向量相似度、連通分量、Companion 人格快取、記憶全景索引
//   entityLink.js           碎片連實體：字面提及自動連結（別名三道門）、值標路由聚合星座
//   dailyStatus.js          每日主角狀態（current_status 日誌行）與範例檔讀取
//   relations.js            實體關係：related_entities 讀寫、關係體檢、標籤橋、共現關係發現
//   seeds.js                種子星座：重複種子合併、實體合併執行、種子畢業與修剪
//   classify.js             碎片分類：LLM 批分類、實體名索引、分類抽檢與分類後複查
//   rematch.js              種子回補：字面回補與語義回補
//   intuitionStopwords.js   直覺觸發詞去高頻（intuition_stopwords）
//   episode.js              Episode：寫入質檢與按類別合併碎片為 episode
//   emergent.js             湧現地點／事件偵測與判據
//   patterns.js             使用者行為模式：信心度與新鮮度、漂移偵測、維護與合併
//   entityOverview.js       實體概述（overview）重生
//   entityDiscovery.js      新實體內容掃描與人物關係推斷（entity_profiles）
//   insights.js             碎片洞察提取
//   tick.js                 Agent 迴圈：啟停與狀態、事件驅動、tick 排程、深度整合、樹健康評估、園藝決策
//   registerTools.js        工具註冊（載入時執行一次）
//   index.js                對外介面（原 services/archivist.js 的 module.exports，逐字保留）
//
// 共用可變狀態只有 runtime.js 的 agentState（物件本身不重新指派，各模組拿到同一個參考）、
// toolRegistry、archivistEvents；只在單一函式內用的快取（_corePersonaCache、
// _dailyStatusExamples）與使用它的函式放在同一檔。
// =================================================================

// 保持原檔的外部模組載入順序（原檔頂端依此順序 require）
require('../../../../database');
require('../../../llm');
require('../../ca3/memory');
require('../../../worldContext');
require('../../../tagRouting');
require('../../../memoryConfig');
require('../../cortex/cognitiveModel');
const { archivistEvents, agentState, registerTool, getTool, listTools, isCompanionActive, setCompanionActive } = require('./runtime');
const { isTimePhraseName, isPeriodPhraseName, isNoChangeSentinel } = require('./guards');
const { _mentionWeight, _entityMentionOwners, _aliasAmbiguous, ensureTagEntities, linkTaggedFragment, linkTaggedFragments } = require('./entityLink');
const { generateDailyEntityStatus } = require('./dailyStatus');
const { reviewEntityRelations, discoverTagRelations, discoverRelatedEntities } = require('./relations');
const { mergeDuplicateSeeds, executeEntityMerge, graduateSeedsAndPrune } = require('./seeds');
const { classifyFragments, classifyFragmentBatch, spotCheckClassifications, reviewConstellationAfterClassification } = require('./classify');
const { rematchFragmentsForSeeds, semanticRematchForSeeds } = require('./rematch');
const { refreshIntuitionStopwords } = require('./intuitionStopwords');
const { consolidateCategory } = require('./episode');
const { buildEmergentJudgePrompt, screenEmergentVerdict, detectEmergentPlacesAndEvents } = require('./emergent');
const { maintainPatterns, clusterObservations } = require('./patterns');
const { regenerateEntityOverviews } = require('./entityOverview');
const { scanContentForNewEntities, discoverEntityRelationships } = require('./entityDiscovery');
const { extractFragmentInsights } = require('./insights');
const { start, stop, getStatus } = require('./tick');
require('./registerTools');  // 載入時註冊工具（原檔尾端的 registerAllTools 區塊）


// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

module.exports = {
    // 按值標路由的聚合星座（測試/指令碼要用）
    ensureTagEntities,
    linkTaggedFragment,
    linkTaggedFragments,
    // 守衛規則（匯出供迴歸測試複用；改名單/哨兵詞表時先看 archivistGuards.test.js）
    isTimePhraseName,
    isPeriodPhraseName,
    isNoChangeSentinel,
    // 湧現判據（匯出供迴歸探針複用，別另抄一份會走樣的）
    buildEmergentJudgePrompt,
    screenEmergentVerdict,
    // 別名的三道門（字面連結器用它決定哪些別名敢拿去 LIKE 匹配）。
    // 匯出供迴歸測試複用——改判據時先看 archivistGuards.test.js 的第 4 節。
    _mentionWeight,
    _aliasAmbiguous,
    _entityMentionOwners,
    // 關係表體檢 + 標籤橋（匯出供一次性清理指令碼 + 探針複用）
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
    // 僅供獨立指令碼（classifyBacklog/growFromScratch）逐輪重置 tick 預算，服務程序不要調
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

    // 每日主角狀態（cron 呼叫；entityProfile/lifecycle 靠「跳過主角」避讓，別改成
    // 只在這兒寫——兩處都寫會互相漂移）
    generateDailyEntityStatus,
};
