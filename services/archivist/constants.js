// =================================================================
// services/archivist/constants.js — 模型設定 id、tick 間隔、各任務冷卻（MIN_GAP_*）與門檻常數
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { SKIP_NAMES } = require('../memoryConfig');

const SKIP_PH = SKIP_NAMES.map(() => '?').join(', '); // SQL placeholder string for NOT IN clauses


// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const ARCHIVIST_LLM_CONFIG_ID = 36;  // [书库]DS — 主题提案/树审计/关系发现

const ARCHIVIST_VERIFY_CONFIG_ID = 38;  // [心跳]flash — 分类校验/insight，便宜够用


const TICK_INTERVAL_MS = 2 * 60 * 1000;       // Agent 循环 tick 间隔

// 从 memory_config.json 读取深循环触发间隔（默认 60 分钟）
const USER_IDLE_DEEP_CYCLE_MS = (() => {
    try {
        const cfg = require('../../memory_config.json');
        const mins = cfg.rhythm?.deep_cycle_idle_minutes;
        if (typeof mins === 'number' && mins > 0) return mins * 60 * 1000;
    } catch (_) {}
    return 60 * 60 * 1000; // 默认 1h
})();


const ENTITY_DISCOVERY_MIN_FRAGS = 5;

const INSIGHT_BATCH_MAX = 20;

const CLASSIFY_THRESHOLD = 0.35;

const CLASSIFY_MARGIN = 0.12;

const VERIFY_HIGH_THRESHOLD = 0.75;

const VERIFY_BATCH_MAX = 15;

const MAX_TAGS_PER_FRAGMENT = 3;

const MIN_CLUSTER_SIZE = 3;

const THEME_SIMILARITY = 0.72;

const THEME_SAMPLE_SIZE = 200;

const THEME_COOLDOWN_HOURS = 24;


const KEYWORD_SEED_LIMIT = 12;

const KEYWORD_SEED_CONFIDENCE = 0.80;


const BOOTSTRAP_MIN_CLUSTER = 3;

const BOOTSTRAP_MAX_CATEGORIES = 8;

const BOOTSTRAP_SAMPLE = 300;


// Cost controls
const MAX_DAILY_LLM_CALLS = 500;          // 硬上限：日总调用次数

const MAX_LLM_PER_TICK_IDLE = 50;         // Companion 空闲时每 tick 最大 LLM 调用

const MAX_LLM_PER_TICK_ACTIVE = 10;       // Companion 活跃时每 tick 最大 LLM 调用


// Min intervals between task types (ms) — prevents thrashing
const MIN_GAP_CLASSIFY = 2 * 60 * 1000;

const MIN_GAP_INSIGHTS = 10 * 60 * 1000;

const MIN_GAP_DESCRIPTIONS = 30 * 60 * 1000;

const MIN_GAP_ENTITY_OVERVIEWS = 30 * 60 * 1000;

const MIN_GAP_THEMES = 6 * 60 * 60 * 1000;

const MIN_GAP_SKILLS = 30 * 60 * 1000;

const MIN_GAP_PROPOSALS = 10 * 60 * 1000;

const MIN_GAP_RECONCILE = 30 * 60 * 1000;

const MIN_GAP_RELATIONSHIPS = 30 * 60 * 1000;

const MIN_GAP_EMERGENT = 30 * 60 * 1000;           // 涌现地点/事件检测（聚类第二遍扫描）——清积压期30min

const MIN_GAP_ENTITY_VERIFY = 60 * 60 * 1000;           // 管道A实体分类LLM抽检

const MIN_GAP_CATEGORY_CONSOLIDATE = 60 * 60 * 1000;    // 按类别合并碎片为episode

const MIN_GAP_CATEGORY_MERGE = 6 * 60 * 60 * 1000;        // 重叠类别自动合并（LLM审视全貌）

const MIN_GAP_MUSIC_EXTRACT = 2 * 60 * 60 * 1000;   // 音乐品味变化慢

const MIN_GAP_BOOK_EXTRACT = 60 * 60 * 1000;         // 读书批注新增较快

const MIN_GAP_AUTO_LINK = 2 * 60 * 1000;             // 字面自动链接 2min（轻量，零LLM）

const AUTO_MERGE_OVERLAP_THRESHOLD = 0.80;           // 小类别 ≥80% 碎片已在另一类别中 → 自动合并


const EMERGENCE_THRESHOLD = 50;                    // 未分类积累到 50 条 → 触发生长脉冲

const EMERGENCE_SAMPLE = 150;                      // 生长脉冲采样碎片数

const EMBED_BATCH_SIZE = 50;                       // ChromaDB embed_batch 单次最大（过proxy有限制）

const MIN_GAP_EMERGENCE = 30 * 60 * 1000;          // 生长脉冲冷却 30min

const MIN_GAP_REMATCH = 2 * 60 * 60 * 1000;            // 字面回补 2h

const MIN_GAP_SEMANTIC_REMATCH = 4 * 60 * 60 * 1000;   // 语义回补 4h（ChromaDB + LLM 较重）

const MIN_GAP_SEED_MERGE = 12 * 60 * 60 * 1000;        // 种子合并 12h

const MIN_GAP_RELATED_ENTITIES = 24 * 60 * 60 * 1000;  // 实体关系发现 24h

const MIN_GAP_EPISODE_AUDIT = 6 * 60 * 60 * 1000;        // Episode质检 6h

const MIN_FREE_MEMORY_MB = require('../rhythmConfig').getDeepCycleMinFreeMb();  // 深度循环最低可用内存（MB），不足跳过；可由 memory_config.json rhythm.deep_cycle_min_free_mb 设定

const MEMORY_CHECK_GRACE_MB = 300;                 // 每轮分类后额外保留内存

module.exports = {
    SKIP_PH,
    ARCHIVIST_LLM_CONFIG_ID,
    ARCHIVIST_VERIFY_CONFIG_ID,
    TICK_INTERVAL_MS,
    USER_IDLE_DEEP_CYCLE_MS,
    ENTITY_DISCOVERY_MIN_FRAGS,
    INSIGHT_BATCH_MAX,
    CLASSIFY_THRESHOLD,
    CLASSIFY_MARGIN,
    VERIFY_HIGH_THRESHOLD,
    VERIFY_BATCH_MAX,
    MAX_TAGS_PER_FRAGMENT,
    MIN_CLUSTER_SIZE,
    THEME_SIMILARITY,
    THEME_SAMPLE_SIZE,
    THEME_COOLDOWN_HOURS,
    KEYWORD_SEED_LIMIT,
    KEYWORD_SEED_CONFIDENCE,
    BOOTSTRAP_MIN_CLUSTER,
    BOOTSTRAP_MAX_CATEGORIES,
    BOOTSTRAP_SAMPLE,
    MAX_DAILY_LLM_CALLS,
    MAX_LLM_PER_TICK_IDLE,
    MAX_LLM_PER_TICK_ACTIVE,
    MIN_GAP_CLASSIFY,
    MIN_GAP_INSIGHTS,
    MIN_GAP_DESCRIPTIONS,
    MIN_GAP_ENTITY_OVERVIEWS,
    MIN_GAP_THEMES,
    MIN_GAP_SKILLS,
    MIN_GAP_PROPOSALS,
    MIN_GAP_RECONCILE,
    MIN_GAP_RELATIONSHIPS,
    MIN_GAP_EMERGENT,
    MIN_GAP_ENTITY_VERIFY,
    MIN_GAP_CATEGORY_CONSOLIDATE,
    MIN_GAP_CATEGORY_MERGE,
    MIN_GAP_MUSIC_EXTRACT,
    MIN_GAP_BOOK_EXTRACT,
    MIN_GAP_AUTO_LINK,
    AUTO_MERGE_OVERLAP_THRESHOLD,
    EMERGENCE_THRESHOLD,
    EMERGENCE_SAMPLE,
    EMBED_BATCH_SIZE,
    MIN_GAP_EMERGENCE,
    MIN_GAP_REMATCH,
    MIN_GAP_SEMANTIC_REMATCH,
    MIN_GAP_SEED_MERGE,
    MIN_GAP_RELATED_ENTITIES,
    MIN_GAP_EPISODE_AUDIT,
    MIN_FREE_MEMORY_MB,
    MEMORY_CHECK_GRACE_MB,
};
