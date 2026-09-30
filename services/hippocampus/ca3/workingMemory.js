// =================================================================
// 話題感知工作記憶池（Ombre Brain / MemGPT 模式）
// =================================================================
const { getDb } = require('../../../database');
const { getLocalEmbedding } = require('./memory');

const MAX_POOL_SIZE = 5;
const TTL_MS = 30 * 60 * 1000;

// 記憶體快取：fragmentKey → { key, content, emotional_weight, _rrf, topicEmbedding, lastBoostedAt }
let pool = new Map();
let lastQueryEmbedding = null;   // 上一輪的 query embedding
let lastAccessTime = null;

// =================================================================
// 持久化
// =================================================================

function persistPool() {
  try {
    const db = getDb();
    db.prepare('DELETE FROM working_memory_pool').run();
    const insert = db.prepare(`INSERT INTO working_memory_pool
      (fragment_key, content, emotional_weight, last_rrf, topic_embedding_json, boosted_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [key, item] of pool) {
      insert.run(key, item.content, item.emotional_weight, item._rrf,
        JSON.stringify(item.topicEmbedding || []), item.lastBoostedAt || Date.now());
    }
  } catch (e) {
    console.error('[WorkingMemory] 持久化失敗:', e.message);
  }
}

function loadFromDB() {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM working_memory_pool
      WHERE boosted_at > ? ORDER BY boosted_at DESC`).all(Date.now() - TTL_MS);
    for (const r of rows) {
      let emb = [];
      try { emb = JSON.parse(r.topic_embedding_json || '[]'); } catch (_) {}
      if (emb.length > 0) lastQueryEmbedding = emb;  // 用最近一條的 embedding
      pool.set(r.fragment_key, {
        key: r.fragment_key,
        content: r.content,
        emotional_weight: r.emotional_weight,
        _rrf: r.last_rrf,
        topicEmbedding: emb,
        lastBoostedAt: r.boosted_at,
      });
    }
    if (rows.length > 0) {
      lastAccessTime = rows[0].boosted_at;
      console.log(`[WorkingMemory] 從DB恢復 ${rows.length} 條工作記憶`);
    }
  } catch (e) {
    console.error('[WorkingMemory] 從DB載入失敗:', e.message);
  }
}

// =================================================================
// 餘弦相似度
// =================================================================

function cosineSim(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// =================================================================
// 話題連續性
// =================================================================

function topicContinuity(currentEmbedding) {
  if (!lastQueryEmbedding || lastQueryEmbedding.length === 0) return 0;
  return cosineSim(currentEmbedding, lastQueryEmbedding);
}

// =================================================================
// 獲取 Boost Map（在 searchHybrid 中呼叫）
// =================================================================

async function getBoostMap(userMessage) {
  // 檢查 TTL
  if (lastAccessTime && (Date.now() - lastAccessTime) > TTL_MS) {
    pool.clear();
    lastQueryEmbedding = null;
    lastAccessTime = null;
    console.log('[WorkingMemory] TTL過期，池已清空');
  }

  if (pool.size === 0) return new Map();

  let currentEmbedding;
  try {
    currentEmbedding = await getLocalEmbedding(userMessage);
  } catch (e) {
    console.error('[WorkingMemory] embedding失敗，跳過boost:', e.message);
    return new Map();
  }

  const sim = topicContinuity(currentEmbedding);
  lastQueryEmbedding = currentEmbedding;  // 快取給 updatePool 用

  // 話題切換 → 清空
  if (sim < 0.2) {
    console.log(`[WorkingMemory] 話題切換 (sim=${sim.toFixed(3)} < 0.2)，清空工作記憶池`);
    pool.clear();
    persistPool();
    return new Map();
  }

  const boost = sim >= 0.6 ? 1.15 : 1.05;  // 持續話題 vs 部分重疊
  const boostMap = new Map();
  for (const [key] of pool) {
    boostMap.set(key, boost);
  }
  console.log(`[WorkingMemory] 話題連續性 sim=${sim.toFixed(3)}，boost=${boost}，池內 ${pool.size} 條`);
  lastAccessTime = Date.now();
  return boostMap;
}

// =================================================================
// 更新工作記憶池（在 buildSmartContext 注入後呼叫）
// =================================================================

function updatePool(fragments) {
  if (!fragments || fragments.length === 0) return;

  const emb = lastQueryEmbedding;  // 使用 getBoostMap 時快取的 embedding

  for (const f of fragments.slice(0, MAX_POOL_SIZE)) {
    const key = `${f.source_table || 'fragment'}-${f.id}`;
    // LRU：如果已存在，更新；否則新增（超限時淘汰最舊的）
    if (pool.has(key)) {
      pool.delete(key);  // 移到最前
    } else if (pool.size >= MAX_POOL_SIZE) {
      // 淘汰最舊條目
      const oldest = [...pool.entries()].sort((a, b) => (a[1].lastBoostedAt || 0) - (b[1].lastBoostedAt || 0))[0];
      if (oldest) pool.delete(oldest[0]);
    }
    pool.set(key, {
      key,
      content: f.content || '',
      emotional_weight: f.emotional_weight || 0.5,
      _rrf: f._rrf || 0,
      topicEmbedding: emb || [],
      lastBoostedAt: Date.now(),
    });
  }

  lastAccessTime = Date.now();
  persistPool();
  console.log(`[WorkingMemory] 池更新完成，${pool.size} 條 (target query: ${fragments[0]?.content?.slice(0, 40) || '?'})`);
}

// =================================================================
// 初始化
// =================================================================

loadFromDB();

// 暴露最近注入的記憶，供 correct_memory 查詢工作記憶池
function getRecentFragments() {
    const now = Date.now();
    const result = [];
    for (const [key, entry] of pool) {
        if (now - entry.lastBoostedAt < TTL_MS) {
            const [source_table, idStr] = key.split('-');
            result.push({ id: parseInt(idStr), content: entry.content, source_table });
        }
    }
    return result;
}

// 話題延續、本則不重查時：只刷新工作記憶的存活時間（G1 閘門用），不改內容也不重算 embedding
function touchPool() {
  if (pool.size === 0) return 0;
  const now = Date.now();
  for (const item of pool.values()) item.lastBoostedAt = now;
  lastAccessTime = now;
  persistPool();
  return pool.size;
}

module.exports = { getBoostMap, updatePool, getRecentFragments, touchPool };
