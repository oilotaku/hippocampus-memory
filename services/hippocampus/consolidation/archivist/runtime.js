// =================================================================
// services/archivist/runtime.js — agent 共用執行期狀態（agentState、事件匯流排、工具登錄檔）、記憶體閘門、Companion 活動旗標、LLM 呼叫預算、任務執行與冷卻
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const os = require('os');
const EventEmitter = require('events');
const { getDb } = require('../../../../database');
const { MAX_DAILY_LLM_CALLS, MAX_LLM_PER_TICK_IDLE, MAX_LLM_PER_TICK_ACTIVE } = require('./constants');


// ═══════════════════════════════════════════════════════
// Event Bus — Scribe 發事件，Archivist 監聽
// ═══════════════════════════════════════════════════════

const archivistEvents = new EventEmitter();
archivistEvents.setMaxListeners(20);


// ═══════════════════════════════════════════════════════
// Agent State
// ═══════════════════════════════════════════════════════

let agentState = {
    running: false,
    tickTimer: null,
    inTick: false,

    // Companion activity tracking
    companionActive: false,
    companionLastActive: Date.now(),

    // User idle → deep cycle trigger
    lastUserMessageTime: 0,
    deepCycleSinceLastUserMsg: false,

    // Cost tracking
    dailyLLMCalls: 0,
    dailyLLMReset: Date.now(),
    tickLLMCalls: 0,

    // Work tracking (last execution timestamps)
    lastClassify: 0,
    lastInsights: 0,
    lastDescriptions: 0,
    lastEntityOverviews: 0,
    lastThemes: 0,
    lastOverdensity: 0,
    lastSkills: 0,
    lastAudit: 0,
    lastProposals: 0,
    lastReconcile: 0,
    lastRelationships: 0,
    lastLeafStructure: 0,
    lastEntityVerify: 0,
    lastCategoryConsolidate: 0,
    lastMusicExtract: 0,
    lastBookExtract: 0,
    lastEmergence: 0,
    lastAutoMerge: 0,
    lastUserModel: 0,
    lastCategoryMerge: 0,
    lastBeliefDrift: 0,

    // Tree change tracker (whisper refresh trigger)
    treeChanged: false,

    // Stats
    totalClassified: 0,
    totalTasksRun: 0,

    // Event tracking
    newFragmentsSinceLastTick: 0,
};


// ═══════════════════════════════════════════════════════
// Memory protection — prevent OOM during ChromaDB-heavy ops
// ═══════════════════════════════════════════════════════

function _freeMemoryMB() {
    return os.freemem() / (1024 * 1024);
}


function _checkMemoryGate(minMB, label) {
    const free = _freeMemoryMB();
    if (free < minMB) {
        console.log(`[Archivist] ⚠️ 記憶體不足，跳過${label}: 可用 ${free.toFixed(0)}MB < 需要 ${minMB}MB`);
        return false;
    }
    return true;
}


// ═══════════════════════════════════════════════════════
// Tool Registry
// ═══════════════════════════════════════════════════════

const toolRegistry = new Map();


function registerTool(name, handler, description, opts = {}) {
    toolRegistry.set(name, { handler, description, ...opts });
    console.log(`[Archivist Agent] 工具註冊: ${name} — ${description}`);
}


function getTool(name) {
    return toolRegistry.get(name);
}


function listTools() {
    return [...toolRegistry.entries()].map(([name, t]) => ({ name, description: t.description }));
}


// ═══════════════════════════════════════════════════════
// Agent Loop — Start / Stop
// ═══════════════════════════════════════════════════════

function _isCompanionActive() {
    // Use notify flag first (stream.js/proactive.js set this)
    if (agentState.companionActive) return true;
    // Fallback: check actual scene (catches proactive actions)
    try {
        const stateService = require('../../../state');
        const scene = stateService.getCompanionScene();
        if (scene && scene.scene !== 'idle') return true;
    } catch (_) {}
    return false;
}


function _getLastCompanionActivityTime() {
    try {
        const stateService = require('../../../state');
        const state = stateService.getStateSync();
        return state ? state.lastActivity : agentState.companionLastActive;
    } catch (_) {
        return agentState.companionLastActive;
    }
}


// Called by stream.js when Companion starts/finishes responding
// Proactive notification: reduces need for state service polling
function isCompanionActive() {
    // Use the same logic as internal _isCompanionActive
    if (agentState.companionActive) return true;
    try {
        const stateService = require('../../../state');
        const scene = stateService.getCompanionScene();
        if (scene && scene.scene !== 'idle') return true;
    } catch (_) {}
    return false;
}


function setCompanionActive(active) {
    const wasActive = agentState.companionActive;
    agentState.companionActive = active;
    if (!active) {
        agentState.companionLastActive = Date.now();
    }
    if (wasActive && !active) {
        console.log('[Archivist Agent] Companion 回覆結束，恢復全速');
    }
}


// ═══════════════════════════════════════════════════════
// Task Runner — cost-controlled, Companion-aware
// ═══════════════════════════════════════════════════════

function _checkDailyLLMReset() {
    const now = Date.now();
    if (now - agentState.dailyLLMReset > 24 * 60 * 60 * 1000) {
        if (agentState.dailyLLMCalls > 0) {
            console.log(`[Archivist Agent] 日呼叫計數器重置 (昨日: ${agentState.dailyLLMCalls})`);
        }
        agentState.dailyLLMCalls = 0;
        agentState.dailyLLMReset = now;
    }
}


function _canCallLLM(count = 1) {
    const maxPerTick = agentState.companionActive ? MAX_LLM_PER_TICK_ACTIVE : MAX_LLM_PER_TICK_IDLE;
    if (agentState.tickLLMCalls + count > maxPerTick) return false;
    if (agentState.dailyLLMCalls + count > MAX_DAILY_LLM_CALLS) {
        console.warn(`[Archivist Agent] ⚠️ 日 LLM 呼叫達上限 (${MAX_DAILY_LLM_CALLS})，跳過本 tick 剩餘任務`);
        return false;
    }
    return true;
}


function _countRemainingLLM() {
    const maxPerTick = agentState.companionActive ? MAX_LLM_PER_TICK_ACTIVE : MAX_LLM_PER_TICK_IDLE;
    const tickRemaining = Math.max(0, maxPerTick - agentState.tickLLMCalls);
    const dailyRemaining = Math.max(0, MAX_DAILY_LLM_CALLS - agentState.dailyLLMCalls);
    return Math.min(tickRemaining, dailyRemaining);
}


async function runTask(name, fn) {
    if (!_canCallLLM()) return null;
    try {
        const result = await fn();
        agentState.totalTasksRun++;
        if (result && result.llmCalls) {
            agentState.tickLLMCalls += result.llmCalls;
            agentState.dailyLLMCalls += result.llmCalls;
        }
        if (result && (result.classified > 0 || result.regenerated > 0 || result.proposals > 0
            || result.reconciled > 0 || result.discovered > 0)) {
            agentState.treeChanged = true;
        }
        if (result) {
            const summary = typeof result === 'object'
                ? Object.entries(result).filter(([,v]) => v !== 0 && v !== false && v !== null)
                    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
                : result;
            if (summary) console.log(`[Archivist Agent]   ${name}: ${summary}`);
        }
        return result;
    } catch (e) {
        console.error(`[Archivist Agent] ${name} 失敗:`, e.message);
        return null;
    }
}


// ── 觀星手記日誌：將園藝操作結果寫入 ontology_changelog ──
function _logGardenActivity(taskName, result) {
    if (!result) return;
    const db = getDb();
    const insert = db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
        VALUES (?, ?, ?, 0.80, 'completed')`);

    try {
        if (taskName === 'classify' && result.classified > 0) {
            insert.run('classify', `+${result.classified}條`, JSON.stringify({ count: result.classified, constellations: result.constellationCount || '?' }));
        } else if (taskName === 'rematch' && result.rematched > 0) {
            insert.run('rematch', `+${result.rematched}條`, JSON.stringify({ count: result.rematched }));
        } else if (taskName === 'semanticRematch' && result.rematched > 0) {
            insert.run('semantic_rematch', `+${result.rematched}條`, JSON.stringify({ count: result.rematched }));
        } else if (taskName === 'insights' && result.extracted > 0) {
            insert.run('insights', `+${result.extracted}條`, JSON.stringify({ count: result.extracted }));
        }
    } catch (_) { /* 觀星日誌寫入失敗不阻斷主流程 */ }
}


function _taskKey(name) {
    // Convert snake_case task name to lastCamelCase state key
    const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return `last${camel.charAt(0).toUpperCase() + camel.slice(1)}`;
}


async function runTaskIfDue(name, fn, minGapMs) {
    const key = _taskKey(name);
    const lastRun = agentState[key] || 0;
    if (Date.now() - lastRun < minGapMs) return null;
    const result = await runTask(name, fn);
    agentState[key] = Date.now();
    return result;
}


function _refreshWhisper() {
    try {
        const { invalidateCache } = require('../../../whisper');
        invalidateCache();
        agentState.treeChanged = false;
    } catch (_) {}
}

module.exports = {
    archivistEvents,
    agentState,
    _freeMemoryMB,
    _checkMemoryGate,
    toolRegistry,
    registerTool,
    getTool,
    listTools,
    _isCompanionActive,
    _getLastCompanionActivityTime,
    isCompanionActive,
    setCompanionActive,
    _checkDailyLLMReset,
    _canCallLLM,
    _countRemainingLLM,
    runTask,
    _logGardenActivity,
    _taskKey,
    runTaskIfDue,
    _refreshWhisper,
};
