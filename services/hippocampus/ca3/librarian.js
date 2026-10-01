const { getDb } = require('../../../database');
const { encryption } = require('../../../encryption');
const { fragmentsMatchQuery, memoriesMatchQuery } = require('../../memoryCrypto');
const { AI, SKIP_NAMES } = require('../../nameResolver');
const { toQueryTokens } = require('../../../utils/cjkTokenize');
const { toTraditionalChars } = require('../../../utils/zhNormalize');
const { weekdayZh, daysSinceLocalDate } = require('../../../utils/time');
const { effectiveIntensity } = require('../amygdala/fading');
const { getEmotionConfig } = require('../amygdala/config');
const { getRecallConfig } = require('./recallGate');

// ── 檢索排除源（從 memory_config.json 讀取）──
const EXCLUDED_SOURCES = (() => {
    try {
        const cfg = require('../../../memory_config.json');
        if (cfg.librarian?.exclude_sources && Array.isArray(cfg.librarian.exclude_sources)) {
            return cfg.librarian.exclude_sources.filter(s => typeof s === 'string');
        }
    } catch (_) {}
    return [];
})();
const EXCLUDE_SOURCE_SQL = EXCLUDED_SOURCES.length > 0
    ? `AND mf.source NOT IN (${EXCLUDED_SOURCES.map(() => '?').join(',')})`
    : '';
const EXCLUDE_SOURCE_PARAMS = EXCLUDED_SOURCES;

// 檢索排序設定（librarian.ranking／entity_boost／fts_only_penalty／decay_weight／min_relevance／candidate_overfetch）見 ./librarianConfig.js
const { getLibrarianConfig } = require('./librarianConfig');

// 時間衰減（半衰期、分段、時效加權）見 ./decay.js；記憶年齡見 ../entorhinal/timing.js
const { timeFactorParts } = require('./decay');
const { memoryAgeDays } = require('../entorhinal/timing');

// 召回分數底線：低於此值的碎片不返回（被衰減+低權重自然淘汰）
// YantrikDB 思路：召回端多道關卡，訊號弱時寧可空返回也不塞噪音
const MIN_COMBINED_SCORE = 0.005;   // 綜合分底線（0.002→0.005，過濾弱關聯）
const VEC_SIMILARITY_FLOOR = 0.22;  // 向量結果相似度地板，低於此值不進RRF
const EPISODE_BOOST = 1.5;          // EbbingFlow思路：整合過的episode權重高於原始碎片
const FTS5_ONLY_PENALTY = 0.7;      // legacy 專用：FTS5單字匹配無向量交叉驗證 → 降權（v2 改用 librarian.fts_only_penalty，見上方說明）

// 新穎度懲罰：被訪問越多次的碎片越往後讓，防止通用碎片汙染所有查詢
// read_count=0→1.0, 35→0.46, 100→0.33, 500→0.27, 1000→0.25
// 真正的通用碎片(500+)受影響較大，一般熱門(100-)不誤傷
function noveltyPenalty(readCount) {
  if (!readCount || readCount <= 1) return 1.0;
  return 1 / (1 + Math.log10(readCount + 1));
}

// 記憶年齡的計算在 entorhinal/timing.js（單一來源）；此處保留匯出的薄包裝
function daysAgo(dateLabel) {
  return memoryAgeDays(dateLabel);
}

// ── 實體聚合輔助：從使用者訊息中識別已知實體 → 按 entity_id 全量撈碎片 ──
// 活動詞 → 聚合實體（活動桶）對映。
// 聚合實體（觀影/音樂/共讀）不是真人/地點/作品，而是按「活動型別」歸堆的桶。
// 它們的日常說法（看電影/聽歌/看書）是閉集，放程式碼裡做版本控制——
// 不放 DB 別名，否則別名漏配或被遷移沖掉就會靜默失效。
const ACTIVITY_ENTITY_KEYWORDS = [
    { entityName: '觀影', keywords: ['看電影', '電影', '影片', '看片', '觀影', '观影', '看电影', '电影'] },
    { entityName: '音樂', keywords: ['聽歌', '歌曲', '歌單', '聽音樂', '音樂', '音乐', '听歌', '歌单', '听音乐'] },
    { entityName: '共讀', keywords: ['看書', '讀書', '閱讀', '一起讀', '共讀', '共读', '看书', '读书', '阅读', '一起读'] },
];

async function lookupEntityIds(userMessage) {
    const db = getDb();
    const entities = db.prepare(`
        SELECT id, name, aliases FROM entity_profiles
        WHERE name IS NOT NULL AND status IN ('active','seed')
    `).all();

    const ids = [];
    // 簡繁正規化只用於比對：實體名／別名可能是簡體（舊資料）或繁體，使用者訊息亦然
    const msgLower = toTraditionalChars(userMessage).toLowerCase();
    const normName = (v) => toTraditionalChars(v).toLowerCase();

    // 1. 活動詞 → 聚合實體（程式碼級詞表，先於名稱/別名匹配）
    for (const act of ACTIVITY_ENTITY_KEYWORDS) {
        if (act.keywords.some(k => k.length >= 2 && msgLower.includes(normName(k)))) {
            const entity = entities.find(e => normName(e.name) === normName(act.entityName));
            if (entity) ids.push(entity.id);
        }
    }

    // 2. 標準名匹配 + 別名匹配（真實人/地點/作品）
    for (const e of entities) {
        if (msgLower.includes(normName(e.name))) {
            ids.push(e.id);
            continue;
        }
        let aliasList = [];
        try { aliasList = JSON.parse(e.aliases || '[]'); } catch (_) {}
        if (aliasList.some(a => a && a.length >= 2 && msgLower.includes(normName(a)))) {
            ids.push(e.id);
        }
    }

    // 3. 語義降級：關鍵詞零命中時，用向量匹配實體名稱（處理變體/別稱）
    if (ids.length === 0 && userMessage.trim().length >= 2) {
        try {
            const { queryEntityByText } = require('../../entityEmbedding');
            const semMatches = await queryEntityByText(userMessage, 3);
            for (const m of semMatches) {
                ids.push(m.entity_id);
                console.log(`Librarian: 語義實體匹配 "${m.entity_name}" sim=${m.similarity} ← "${userMessage.slice(0, 40)}"`);
            }
        } catch (e) {
            // entityEmbedding 尚未隨本倉庫提供時（MODULE_NOT_FOUND）靜默降級，其他錯誤才打印
            if (e.code !== 'MODULE_NOT_FOUND') {
                console.error('Librarian: 語義實體匹配失敗:', e.message);
            }
        }
    }

    // 去重（活動詞可能同時命中名稱匹配）
    return [...new Set(ids)];
}

// 撈排序用的情緒欄位（intensity／valence／raised_at／created_at）。emotion.enabled=false 或欄位不存在時回空表
function loadEmotionRows(items) {
  const out = new Map();
  try {
    if (!getEmotionConfig().enabled) return out;
    const ids = [...new Set(items.filter(r => r.source_table === 'fragment').map(r => r.id))];
    if (ids.length === 0) return out;
    const rows = getDb().prepare(`SELECT id, intensity, valence, raised_at, created_at FROM memory_fragments
      WHERE id IN (${ids.map(() => '?').join(',')}) AND intensity IS NOT NULL`).all(...ids);
    for (const r of rows) out.set(r.id, r);
  } catch (e) { console.error('Hybrid: 情緒欄位讀取失敗，退回 emotional_weight:', e.message); }
  return out;
}

function getEntityFragments(entityIds, limit = 10) {
    if (!entityIds || entityIds.length === 0) return [];
    const db = getDb();
    const placeholders = entityIds.map(() => '?').join(',');
    // v5.0 fix: use fragment_entities junction table (canonical source),
    // not memory_fragments.entity_id (which is mostly NULL)
    return db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight, mf.source_date AS date_label,
               mf.created_at, mf.read_count, mf.layer, fe.entity_id,
               'fragment' AS source_table
        FROM memory_fragments mf
        JOIN fragment_entities fe ON fe.fragment_id = mf.id
        WHERE fe.entity_id IN (${placeholders})
          AND mf.status = 'active'
        ORDER BY mf.created_at DESC
        LIMIT ?
    `).all(...entityIds, limit);
}

// v2：使用者本人與 AI 的名稱（SKIP_NAMES）不觸發實體加分——幾乎每條記憶都和他們有關，加分等於沒加、卻會擾動排序
function dropSkipEntities(entityIds) {
    if (!entityIds || entityIds.length === 0) return [];
    const skip = new Set((SKIP_NAMES || []).filter(Boolean).map(n => toTraditionalChars(String(n)).toLowerCase()));
    if (skip.size === 0) return entityIds;
    const rows = getDb().prepare(`SELECT id, name FROM entity_profiles WHERE id IN (${entityIds.map(() => '?').join(',')})`).all(...entityIds);
    const nameOf = new Map(rows.map(r => [r.id, r.name]));
    return entityIds.filter(id => !skip.has(toTraditionalChars(String(nameOf.get(id) || '')).toLowerCase()));
}

// v2：候選（key = `${source_table}-${id}`）中連到指定實體者 → Map(key → entity_id)
function linkedToEntities(keys, entityIds) {
    const out = new Map();
    if (!entityIds.length || !keys.length) return out;
    const db = getDb();
    const ents = entityIds.map(() => '?').join(',');
    const fragIds = [], memIds = [];
    for (const k of keys) {
        const i = k.lastIndexOf('-');
        const table = k.slice(0, i), id = Number(k.slice(i + 1));
        if (!Number.isFinite(id)) continue;
        if (table === 'fragment') fragIds.push(id); else if (table === 'memory') memIds.push(id);
    }
    try {
        if (fragIds.length) {
            for (const r of db.prepare(`SELECT fragment_id, entity_id FROM fragment_entities
                WHERE fragment_id IN (${fragIds.map(() => '?').join(',')}) AND entity_id IN (${ents})`).all(...fragIds, ...entityIds)) {
                if (!out.has(`fragment-${r.fragment_id}`)) out.set(`fragment-${r.fragment_id}`, r.entity_id);
            }
        }
        if (memIds.length) {
            for (const r of db.prepare(`SELECT id, entity_id FROM memories
                WHERE id IN (${memIds.map(() => '?').join(',')}) AND entity_id IN (${ents})`).all(...memIds, ...entityIds)) {
                out.set(`memory-${r.id}`, r.entity_id);
            }
        }
    } catch (e) { console.error('Hybrid: 實體連結查詢失敗，略過實體加分:', e.message); }
    return out;
}

// =================================================================
// 意圖路由：規則分類查詢意圖（ebbingflow 同款方案）
// 優先順序：fact > long_term > summary → 預設 semantic
// =================================================================

function classifyIntent(userMessage) {
  const q = (userMessage || '').trim();
  if (!q) return 'semantic';

  // Long-term: 跨會話、長期記憶回溯（優先於fact——"以前看過什麼書"是記憶回溯而非事實查詢）
  const longTermMarkers = ['之前', '以前', '上次', '那次', '曾經', '長期', '一直', '還記得', '主線', '脈絡', '曾经', '长期', '还记得', '主线', '脉络'];
  if (longTermMarkers.some(m => q.includes(m))) {
    return 'long_term';
  }

  // Summary: 近期總結、狀態回顧
  const summaryMarkers = ['最近', '這段時間', '這陣子', '近來', '進展', '總結', '回顧', '我們聊了什麼', '这段时间', '这阵子', '近来', '进展', '总结', '回顾', '我们聊了什么'];
  if (summaryMarkers.some(m => q.includes(m))) {
    return 'summary';
  }

  // Fact: 精確事實查詢（數字、時間、地點、價格等）——排在long_term/summary之後，避免誤吞記憶回溯類查詢
  const factMarkers = [
    '多少', '哪裡', '什麼時候', '誰', '有沒有', '電話', '地址', '日期',
    '幾點', '哪個', '多少錢', '為什麼', '怎麼', '什麼', '哪里', '什么时候', '谁', '有没有', '电话', '几点', '哪个', '多少钱', '为什么', '怎么', '什么'
  ];
  const numericFactRe = /\d+\s*(元|塊|萬|億|%|歲|年|月|日|號|點|分鐘|小時|天|個)|\d+\s*(元|块|万|亿|%|岁|年|月|日|号|点|分钟|小时|天|个)/;
  if (factMarkers.some(m => q.includes(m)) || numericFactRe.test(q)) {
    return 'fact';
  }

  return 'semantic';
}

// 按空格/標點分詞，過濾虛詞和單字
function tokenize(userMessage) {
  if (!userMessage) return [];
  const stopWords = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '們', '和', '與', '或', '但', '而', '也', '都', '就', '把', '被', '讓', '給', '從', '到', '對', '為', '以', '及', '等', '這', '那', '有', '沒', '不', '很', '太', '更', '最', '會', '能', '要', '想', '說', '去', '來', '看', '做', '用', '中', '上', '下', '裡', '外', '们', '与', '让', '给', '从', '对', '为', '这', '没', '会', '说', '来', '里']);
  return userMessage.trim()
    .split(/[\s,，。.！!？?、；;：:\n\r]+/)
    .filter(t => t.length >= 2 && !stopWords.has(t));
}

// CJK 兩字組切分（memory_fragments_fts / memories_fts 的索引是重疊兩字組，見 utils/cjkTokenize.js）
// 停用字：整個 token 全由停用字組成（單字，或兩字都是）時丟棄，避免「在哪」「什麼」之類噪聲
const CJK_STOP_CHARS = new Set(['的','了','在','是','我','你','他','她','它','們','和','與','或','但','而','也','都','就','把','被','讓','給','從','到','對','為','以','及','等','這','那','有','沒','不','很','太','更','最','會','能','要','想','說','去','來','看','做','用','中','上','下','裡','外','嗎','呢','吧','啊','哦','嗯','啦','嘛','哈','呀','哇','呵','嗨','喲','嘿','噢',
  // 繁體對應
  '們','與','為','對','沒','會','說','來','裡','裡','過','著','嗎','喔','哪','麼','麼','什', '们', '与', '让', '给', '从', '对', '为', '这', '没', '会', '说', '来', '里', '吗', '哟', '裏', '么']);
function tokenizeCJK(userMessage) {
  return toQueryTokens(userMessage, { stopChars: CJK_STOP_CHARS, minWordLen: 2 });
}

function searchFragments(userMessage, limit = 8) {
  if (!userMessage || userMessage.trim().length === 0) return [];

  try {
    const db = getDb();
    const results = [];

    // 查 memory_fragments — CJK單字粒度索引
    const cjkTokens = tokenizeCJK(userMessage);
    if (cjkTokens.length > 0) {
      try {
        // W3：on → 內容欄用盲 token（HMAC）查、entity 欄用明文兩字組；off → 與原本相同
        const matchStr = fragmentsMatchQuery(cjkTokens);
        const rows = db.prepare(`
          SELECT mf.id, mf.content, mf.emotional_weight AS weight,
                 mf.source_date AS date_label, mf.created_at,
                 mf.read_count, mf.layer,
                 'fragment' AS source_table,
                 rank
          FROM memory_fragments_fts fts
          JOIN memory_fragments mf ON mf.id = fts.rowid
          WHERE memory_fragments_fts MATCH ?
            AND mf.status = 'active'
            ${EXCLUDE_SOURCE_SQL}
          ORDER BY rank
          LIMIT ?
        `).all(matchStr, ...EXCLUDE_SOURCE_PARAMS, limit);
        results.push(...rows);
      } catch(e) {
        console.error('Librarian memory_fragments查詢失敗:', e.message);
      }
    }

    // v5.3: 重新啟用 episode（memories 表）FTS5 檢索
    // v5.0 退役舊冥想盆是因為 episode 來源（舊知識樹）已廢棄
    // v5.3 consolidateCategory 改為從 entity_profiles 星座產出，episode 質量可靠
    // memories_fts 同樣是兩字組索引（v104），與碎片通道共用 token
    if (cjkTokens.length > 0) {
      try {
        const matchStr = memoriesMatchQuery(cjkTokens);
        const rows = db.prepare(`
          SELECT m.id, m.title AS content, (m.weight / 10.0) AS weight,
                 m.valid_from AS date_label, m.created_at,
                 m.layer,
                 'memory' AS source_table,
                 rank
          FROM memories_fts fts
          JOIN memories m ON m.id = fts.rowid
          WHERE memories_fts MATCH ?
            AND m.layer = 'episode'
            AND m.status = 'permanent'
          ORDER BY rank
          LIMIT ?
        `).all(matchStr, limit);
        results.push(...rows);
      } catch(e) {
        console.error('Librarian memories查詢失敗:', e.message);
      }
    }

    // 合併去重，按 FTS5 rank（相關性）為主、weight 為次，取前limit條
    const seen = new Set();
    return results
      .filter(r => {
        const key = `${r.source_table}-${r.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (a.rank || 0) - (b.rank || 0))   // FTS5 rank: 越小越相關
      .slice(0, limit);

  } catch(e) {
    console.error('Librarian查詢失敗:', e.message);
    return [];
  }
}

function formatForContext(fragments) {
  // W3：解密失敗的碎片 content 為 null——略過，不把 null／密文送進 prompt
  if (fragments) fragments = fragments.filter(f => f && f.content !== null && f.content !== undefined);
  if (!fragments || fragments.length === 0) return null;

  const db = getDb();
  const incRead = db.prepare("UPDATE memory_fragments SET read_count = COALESCE(read_count, 0) + 1, injected_count = COALESCE(injected_count, 0) + 1, last_accessed_at = datetime('now') WHERE id = ?");
  const touchMemory = db.prepare("UPDATE memories SET last_accessed_at = datetime('now') WHERE id = ?");

  const lines = fragments.map(f => {
    const date = f.date_label ? `(${f.date_label})` : '';
    const preview = f.content ? f.content.slice(0, 30) : '';
    console.log(`Librarian命中: [#${f.id}/${f.source_table}] ${preview}...`);

    if (f.source_table === 'fragment') {
      try { incRead.run(f.id); } catch (e) { console.error(`Librarian: read_count更新失敗 #${f.id}:`, e.message); }
    } else if (f.source_table === 'memory') {
      try { touchMemory.run(f.id); } catch (e) { console.error(`Librarian: last_accessed更新失敗 #${f.id}:`, e.message); }
      try { f.content = encryption.decryptForDisplay(f.content); } catch (_) {}
    }

    return `- ${f.content} ${date}`.trim();
  });

  return `※ ${AI.name}的記憶碎片\n${lines.join('\n')}`;
}

// =================================================================
// 混合檢索：FTS5（關鍵詞）+ 向量（語義），RRF 融合
// =================================================================

// opts.now：情緒褪色計算用的「現在」（預設現在，測試可注入）
// opts.random：隨機浮現的亂數來源（預設 Math.random，測試可注入）
// opts.surface：'random'（預設，原行為：結果 <3 條時 40% 機率隨機浮現）｜'none'（不在這裡浮現；
//   recall.gate 開啟時 buildSmartContext 改用 recallGate.pickSurface 依情境浮現）
async function searchHybrid(userMessage, limit = 6, opts = {}) {
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  if (!userMessage || userMessage.trim().length === 0) return [];

  // 話題工作記憶 Boost
  let boostMap = new Map();
  try {
    const { getBoostMap } = require('./workingMemory');
    boostMap = await getBoostMap(userMessage);
  } catch (e) {
    console.error('Hybrid: workingMemory boost failed:', e.message);
  }

  // 意圖路由：分類查詢意圖，調整後續檢索權重
  const intent = classifyIntent(userMessage);
  if (intent !== 'semantic') {
    console.log(`Hybrid: 意圖路由 → ${intent} (query: "${userMessage.slice(0, 50)}")`);
  }

  const libCfg = getLibrarianConfig();
  const v2 = libCfg.ranking !== 'legacy';

  // 1. FTS5 關鍵詞檢索（同步）；v2 多取候選，讓實體加分／時間排序能把前 limit 名之外的相關結果換進來
  const ftsResults = searchFragments(userMessage, v2 ? Math.max(limit, Math.ceil(limit * libCfg.candidate_overfetch)) : limit);

  // 1.5 實體：legacy → 按 entity_id 撈「最新 N 條」當獨立候選（實體時間線）；
  //     v2 → 不提供候選，只在後面對「已被 FTS／向量找到、且連到這些實體」的候選加分（排除使用者本人與 AI）
  let entityIds = await lookupEntityIds(userMessage);
  if (v2) entityIds = dropSkipEntities(entityIds);
  const entityResults = !v2 && entityIds.length > 0 ? getEntityFragments(entityIds, limit) : [];
  if (entityResults.length > 0) {
    console.log(`Hybrid: 實體聚合命中 ${entityResults.length} 條 (entity_ids=${entityIds.join(',')}) → "${userMessage.slice(0, 40)}"`);
  }

  // 2. 向量語義檢索（非同步）—— 多取 3x 補償 ChromaDB stale 碎片
  const VEC_OVERFETCH = 3;
  let vecResults = [];
  try {
    const { searchMemoriesByVector } = require('./memory');
    vecResults = await searchMemoriesByVector(userMessage, Math.max(limit * VEC_OVERFETCH, 16));
  } catch (e) {
    console.error('Hybrid: vector search failed:', e.message);
  }

  // 向量相似度地板：弱關聯不進RRF（YantrikDB思路——訊號弱則不參與融合）
  const filteredVec = vecResults.filter(v => (v._similarity || 0) >= VEC_SIMILARITY_FLOOR);
  if (filteredVec.length < vecResults.length) {
    console.log(`Hybrid: 向量地板過濾 ${vecResults.length - filteredVec.length}/${vecResults.length} 條弱結果 (sim<${VEC_SIMILARITY_FLOOR})`);
  }

  // 3. RRF 融合
  const kRRF = 60;
  const rrfScores = new Map();
  const itemMap = new Map();

  // 新增 FTS5 排名（意圖權重調整）
  const ftsWeight = intent === 'fact' ? 1.5 : intent === 'summary' ? 0.6 : intent === 'long_term' ? 0.7 : 1.0;
  ftsResults.forEach((item, rank) => {
    const key = `${item.source_table}-${item.id}`;
    const rrf = 1 / (kRRF + rank + 1);
    rrfScores.set(key, (rrfScores.get(key) || 0) + rrf * ftsWeight);
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        ...item,
        emotional_weight: item.weight || 0.5,
        _created_at: item.created_at || '',
        _read_count: item.read_count || 0,
      });
    }
  });

  // 新增實體聚合排名（固定中位 RRF，約等於 FTS5 rank 3-5）
  // 實體時間線是"關於這個人的所有碎片"，不是語義匹配——給中等權重，不沖淡主檢索
  const ENTITY_RRF_RANK = 4;  // 虛擬排名，rrf = 1/(60+4+1) ≈ 0.015
  entityResults.forEach((item, i) => {
    const key = `${item.source_table}-${item.id}`;
    const rrf = 1 / (kRRF + ENTITY_RRF_RANK + i);
    rrfScores.set(key, (rrfScores.get(key) || 0) + rrf);
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        id: item.id,
        content: item.content,
        weight: item.emotional_weight || 0.5,
        date_label: item.date_label || '',
        source_table: item.source_table,
        _similarity: 0,
        emotional_weight: item.emotional_weight || 0.5,
        _created_at: item.created_at || '',
        _read_count: item.read_count || 0,
        _entity_id: item.entity_id,
      });
    }
  });

  // 新增向量排名（意圖權重調整 + episode加權）
  const episodeBoost = intent === 'summary' || intent === 'long_term' ? 2.0 : intent === 'fact' ? 1.0 : EPISODE_BOOST;
  const vecWeight = intent === 'summary' ? 1.4 : intent === 'long_term' ? 1.3 : intent === 'fact' ? 0.5 : 1.0;
  filteredVec.forEach((item, rank) => {
    const sourceTable = item._table === 'fragments' ? 'fragment' : 'memory';
    const key = `${sourceTable}-${item.id || item.memory_id}`;
    let rrf = 1 / (kRRF + rank + 1);
    if (sourceTable === 'memory') rrf *= episodeBoost;  // episode 加權
    rrfScores.set(key, (rrfScores.get(key) || 0) + rrf * vecWeight);
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        id: item.id,
        content: item.content || item.title,
        weight: item._similarity || 0,
        date_label: item.source_date || item.valid_from || '',
        source_table: sourceTable,
        _similarity: item._similarity || 0,
        emotional_weight: item.emotional_weight || 0.5,
        _created_at: item.created_at || '',
        _read_count: item.read_count || 0,
      });
    } else {
      const existing = itemMap.get(key);
      existing._similarity = item._similarity || existing._similarity || 0;
      if (!existing._read_count && item.read_count) {
        existing._read_count = item.read_count;
      }
      if (!existing.emotional_weight || existing.emotional_weight === 0.5) {
        existing.emotional_weight = item.emotional_weight || 0.5;
      }
      if (!existing._created_at) {
        existing._created_at = item.created_at || '';
      }
    }
  });

  // 沒有任何候選時不提前返回：後面的排序/過濾對空集合自然得到 []，
  // 「檢索結果太少（含 0 條）時偶爾隨機浮現」仍要照規則執行（結果 <3 條且機率門檻）。
  if (rrfScores.size === 0) {
    console.log('Hybrid: 無候選結果通過質量關卡（仍會依規則嘗試隨機浮現）');
  }

  // v2：候選中連到訊息所提實體者（實體加分用）
  const entityLinked = v2 && entityIds.length > 0 && libCfg.entity_boost > 0
    ? linkedToEntities([...rrfScores.keys()], entityIds) : new Map();
  if (entityLinked.size > 0) {
    console.log(`Hybrid: 實體加分 ${entityLinked.size}/${rrfScores.size} 條候選 (entity_ids=${entityIds.join(',')}, ×${1 + libCfg.entity_boost})`);
  }
  const ftsOnlyPenalty = v2 ? libCfg.fts_only_penalty : FTS5_ONLY_PENALTY;

  // 按 RRF 分數降序排列
  const ranked = Array.from(rrfScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, rrf]) => {
      const item = itemMap.get(key);
      const ftsRank = ftsResults.findIndex(f => `${f.source_table}-${f.id}` === key);
      const vecRank = filteredVec.findIndex(v => {
        const vt = v._table === 'fragments' ? 'fragment' : 'memory';
        return `${vt}-${v.id}` === key;
      });

      if (v2 && entityLinked.has(key)) item._entity_id = entityLinked.get(key);
      const isEntity = item._entity_id != null;

      let confidence = 'low';
      if (ftsRank >= 0 && vecRank >= 0) confidence = 'high';
      else if (item._similarity > 0.35) confidence = 'high';
      else if (rrf > 0.015 || item._similarity > 0.2) confidence = 'medium';
      else if (isEntity) confidence = 'medium';  // 實體聚合——確定性高但不是語義匹配
      else confidence = 'low';

      let source = ftsRank >= 0 && vecRank >= 0 ? 'BOTH'
        : isEntity && ftsRank >= 0 ? 'ENTITY+FTS5'
        : isEntity && vecRank >= 0 ? 'ENTITY+VEC'
        : isEntity ? 'ENTITY'
        : ftsRank >= 0 ? 'FTS5' : 'VEC';
      // 無向量交叉驗證 → 降權（fact意圖不需要交叉驗證）。legacy 固定 0.7；v2 預設 1.0（=不打折，見 LIBRARIAN_DEFAULTS）
      if (source === 'FTS5' && intent !== 'fact' && ftsOnlyPenalty < 1) {
        rrf *= ftsOnlyPenalty;
        source = 'FTS5*';
      }
      // v2 實體加分：乘在相關度上（只加給本來就被 FTS／向量找到的候選）
      if (v2 && entityLinked.has(key)) rrf *= 1 + libCfg.entity_boost;
      return { ...item, _rrf: rrf, _confidence: confidence, _source: source };
    });

  // 新穎度看「被注入的次數」（injected_count），不是 read_count：recall.gate 開啟時才切換，關閉則沿用 read_count。
  // （被引用與否由 cited_count 記錄，那是 lifecycle 續命用的，兩個角色分開。）
  const injectedById = new Map();
  if (getRecallConfig().gate) {
    const fragIds = ranked.filter(r => r.source_table === 'fragment').map(r => r.id);
    if (fragIds.length > 0) {
      try {
        const rows = getDb().prepare(`SELECT id, injected_count FROM memory_fragments WHERE id IN (${fragIds.map(() => '?').join(',')})`).all(...fragIds);
        for (const r of rows) injectedById.set(r.id, r.injected_count || 0);
      } catch (e) { console.error('Hybrid: injected_count 讀取失敗，novelty 退回 read_count:', e.message); }
    }
  }

  // G2 情緒褪色：碎片有八維情緒（intensity）時，排序用「褪色後的有效強度」取代 emotional_weight。
  // 負面情緒褪得比正面快；沒有情緒資料的碎片與 emotion.enabled=false 時維持原本的 emotional_weight。
  const emoById = loadEmotionRows(ranked);
  const emoNow = opts.now != null ? new Date(opts.now) : new Date();
  const weightOf = (item) => {
    const base = item.emotional_weight || 0.5;
    const row = item.source_table === 'fragment' ? emoById.get(item.id) : null;
    if (!row) return base;
    const eff = effectiveIntensity(row, emoNow);
    // 0.1 下限與 G2 寫入 emotional_weight 時一致：下游多處以 `|| 0.5` 當缺值，0 會被當成缺值
    return eff == null ? base : Math.max(0.1, eff);
  };

  // 時間衰減（分段：前3天新鮮度主導，3天後情緒主導）+ 重要性 + 新穎度
  const decayed = ranked.map(item => {
    const dateForDecay = item._created_at || item.date_label;
    const days = daysAgo(dateForDecay);
    const ew = weightOf(item);
    const { decay, recencyBoost } = timeFactorParts({ days, ew, intent });
    const importance = 0.4 + ew * 0.6;
    const novelty = noveltyPenalty(injectedById.has(item.id) && item.source_table === 'fragment' ? injectedById.get(item.id) : (item._read_count || 0));
    const wmBoost = boostMap.get(`${item.source_table}-${item.id}`) || 1.0;
    if (!v2) {
      const combinedScore = item._rrf * decay * importance * novelty * wmBoost * recencyBoost;
      return { ...item, _rrf: combinedScore, _decay: decay, _importance: importance, _novelty: novelty, _daysAgo: Math.round(days), _wmBoost: wmBoost, _recencyBoost: recencyBoost };
    }
    // v2：_relevance＝相關度（決定去留）；_rrf＝排序分數（相關度 × 時間因子^decay_weight × 重要性 × 新穎度 × 工作記憶）
    const relevance = item._rrf;
    const timeFactor = Math.pow(decay * recencyBoost, libCfg.decay_weight);
    const rankScore = relevance * timeFactor * importance * novelty * wmBoost;
    return { ...item, _rrf: rankScore, _relevance: relevance, _timeFactor: timeFactor, _decay: decay, _importance: importance, _novelty: novelty, _daysAgo: Math.round(days), _wmBoost: wmBoost, _recencyBoost: recencyBoost };
  })
  // legacy：綜合分（含衰減）低於底線就丟——舊記憶會整批消失；v2：只看相關度，衰減只影響排序
  .filter(item => v2 ? item._relevance >= libCfg.min_relevance : item._rrf >= MIN_COMBINED_SCORE)
  .sort((a, b) => b._rrf - a._rrf);

  // 直接取 top-N，不強制保留向量結果（讓質量說話，不做多樣性配額）
  const finalResults = decayed.slice(0, limit);

  // 隨機浮現（Ombre Brain 啟發）：檢索結果太少時，偶爾「突然想起」無關的舊事
  // 讓從未被召回過的記憶也有機會浮出水面，模擬真人沒來由的聯想
  if (opts.surface !== 'none' && finalResults.length < 3 && random() < 0.4) {
    try {
      const db = getDb();
      const floatCount = Math.min(3 - finalResults.length, 3);
      const floatFrags = db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight, mf.source_date AS date_label,
               mf.created_at, mf.read_count, mf.layer, 'fragment' AS source_table
        FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND (mf.read_count IS NULL OR mf.read_count = 0)
          AND mf.created_at < datetime('now', '-3 days')
        ORDER BY RANDOM()
        LIMIT ?
      `).all(floatCount);

      for (const f of floatFrags) {
        const daysOld = daysAgo(f.created_at);
        const ew = f.emotional_weight || 0.5;
        finalResults.push({
          ...f,
          weight: ew,
          _rrf: 0.002,  // 極低分，排在最後但不觸發MIN_COMBINED_SCORE過濾
          _confidence: 'low',
          _source: 'FLOAT',
          _isFloated: true,
          _daysOld: Math.round(daysOld),
        });
      }

      if (floatFrags.length > 0) {
        const previews = floatFrags.map(f => f.content.slice(0, 30)).join(' | ');
        console.log(`Hybrid: 隨機浮現 ${floatFrags.length} 條舊碎片 (${previews})`);
      }
    } catch (e) {
      console.error('Hybrid: 隨機浮現查詢失敗:', e.message);
    }
  }

  // Filter excluded sources (e.g. music fragments — config in memory_config.json)
  if (EXCLUDED_SOURCES.length > 0) {
    const db2 = getDb();
    const fragIds = finalResults.filter(r => r.source_table === 'fragment').map(r => r.id);
    if (fragIds.length > 0) {
      const placeholders = fragIds.map(() => '?').join(',');
      const excludedFragIds = new Set(
        db2.prepare(`SELECT id FROM memory_fragments WHERE id IN (${placeholders}) AND source IN (${EXCLUDED_SOURCES.map(() => '?').join(',')})`)
          .all(...fragIds, ...EXCLUDED_SOURCES)
          .map(r => r.id)
      );
      const before = finalResults.length;
      const filtered = finalResults.filter(r => r.source_table !== 'fragment' || !excludedFragIds.has(r.id));
      if (filtered.length < before) {
        console.log(`Hybrid: 排除源過濾 ${before - filtered.length} 條 (${EXCLUDED_SOURCES.join(',')})`);
      }
      return filtered;
    }
  }

  return finalResults;
}

// 計算引用許可權（確定性規則，不依賴 LLM）
function computePermission(f) {
  const days = f._daysAgo ?? f._daysOld ?? 999;
  const conf = f._confidence || 'low';
  const src = f._source || '?';

  if (f._isFloated) return '僅聯想';
  if (days >= 90) return '僅聯想';
  if (conf === 'low') return '僅聯想';
  if (conf === 'high' && days < 30 && src === 'BOTH') return '可引用';
  // medium confidence, or 30-90 days, or single-source
  return '需謹慎';
}

// opts.count=false：只格式化、不累加注入計數（沿用工作記憶時用，同一批碎片不重複計次）
function formatHybridContext(fragments, opts = {}) {
  if (!fragments || fragments.length === 0) return null;
  const countInjection = opts.count !== false;

  const db = getDb();
  const incRead = db.prepare("UPDATE memory_fragments SET read_count = COALESCE(read_count, 0) + 1, injected_count = COALESCE(injected_count, 0) + 1, last_accessed_at = datetime('now') WHERE id = ?");
  const touchMemory = db.prepare("UPDATE memories SET last_accessed_at = datetime('now') WHERE id = ?");

  // 碎片的對話日期（source_date，當地日期）。各檢索通道回傳的欄位不一，缺的一次補查。
  // 只給「N天前」（以寫入時間 created_at 起算）時，批次抽取的記憶全都變成「0天前」，
  // 模型答不出「哪一天」「哪件事先發生」——實測中文端到端評測的時間題只答對 30%。
  const dateOf = new Map();
  try {
    const missing = fragments.filter(f => f.source_table === 'fragment' && !(f.source_date || f.date_label)).map(f => f.id);
    if (missing.length) {
      const rows = db.prepare(`SELECT id, source_date FROM memory_fragments WHERE id IN (${missing.map(() => '?').join(',')})`).all(...missing);
      for (const r of rows) if (r.source_date) dateOf.set(r.id, r.source_date);
    }
  } catch (e) { console.error('Librarian: 查詢碎片日期失敗:', e.message); }

  // v5.5: 先處理全部碎片（日誌+解密+read_count），同時收集 entity 歸屬
  const processed = [];
  for (const f of fragments) {
    const permission = computePermission(f);
    const days = f._daysAgo ?? f._daysOld;
    const sd = f.source_table === 'fragment' ? String(f.source_date || f.date_label || dateOf.get(f.id) || '').slice(0, 10) : '';
    const wd = weekdayZh(sd);
    const sdDays = wd ? daysSinceLocalDate(sd) : null;
    const daysStr = wd ? `記於 ${sd}（${wd}${sdDays != null && sdDays >= 0 ? `，${sdDays}天前` : ''}）`
        : days != null ? `${days}天前` : '?';
    const preview = f.content ? f.content.slice(0, 30) : '';
    const srcTag = f._isFloated ? '[FLOAT]'
        : f._source === 'BOTH' ? '[BOTH]'
        : f._source === 'ENTITY+FTS5' ? '[ENT+FTS]'
        : f._source === 'ENTITY+VEC' ? '[ENT+VEC]'
        : f._source === 'ENTITY' ? '[ENTITY]'
        : f._source === 'FTS5' ? '[FTS5]'
        : f._source === 'FTS5*' ? '[FTS5*]'
        : '[VEC]';
    const ew = f.emotional_weight != null ? f.emotional_weight.toFixed(1) : '?';

    console.log(`Hybrid命中: [#${f.id}/${f.source_table}] ${srcTag} ew=${ew} ${daysStr} [${permission}] ${preview}...`);

    if (f.source_table === 'fragment') {
      if (countInjection) { try { incRead.run(f.id); } catch (e) { console.error(`Librarian: read_count更新失敗 #${f.id}:`, e.message); } }
    } else if (f.source_table === 'memory') {
      if (countInjection) { try { touchMemory.run(f.id); } catch (e) { console.error(`Librarian: last_accessed更新失敗 #${f.id}:`, e.message); } }
      try { f.content = encryption.decryptForDisplay(f.content); } catch (_) {}
    }

    processed.push({
      line: `※ ${permission} · #${f.id} · ${daysStr}\n${f.content}`.trim(),
      id: f.id,
      sourceTable: f.source_table,
    });
  }

  // v5.5: 按實體分組碎片，防止不同人的記憶平鋪在一起導致 LLM 交叉汙染
  if (processed.length <= 1) return processed.map(p => p.line).join('\n');

  // 查每條碎片的 entity 歸屬
  const fragIds = processed.filter(p => p.sourceTable === 'fragment').map(p => p.id);
  const memIds = processed.filter(p => p.sourceTable === 'memory').map(p => p.id);

  const fragEntityMap = new Map(); // fragment_id → entity name
  if (fragIds.length > 0) {
    const rows = db.prepare(`
      SELECT fe.fragment_id, ep.name
      FROM fragment_entities fe
      JOIN entity_profiles ep ON ep.id = fe.entity_id
      WHERE fe.fragment_id IN (${fragIds.map(() => '?').join(',')})
    `).all(...fragIds);
    for (const r of rows) {
      const existing = fragEntityMap.get(r.fragment_id);
      fragEntityMap.set(r.fragment_id, existing ? existing + '、' + r.name : r.name);
    }
  }
  if (memIds.length > 0) {
    const rows = db.prepare(`
      SELECT m.id, ep.name
      FROM memories m
      JOIN entity_profiles ep ON ep.id = m.entity_id
      WHERE m.id IN (${memIds.map(() => '?').join(',')})
    `).all(...memIds);
    for (const r of rows) {
      const key = `mem_${r.id}`;
      fragEntityMap.set(key, r.name);
    }
  }

  // 按 entity 分組
  const groups = new Map(); // entity name → [lines]
  const ungrouped = [];
  for (const p of processed) {
    const key = p.sourceTable === 'memory' ? `mem_${p.id}` : p.id;
    const entityName = fragEntityMap.get(key);
    if (entityName) {
      if (!groups.has(entityName)) groups.set(entityName, []);
      groups.get(entityName).push(p.line);
    } else {
      ungrouped.push(p.line);
    }
  }

  // 組裝輸出：分組頭 + 碎片，ungrouped 放最後
  const output = [];
  const personEntities = [];

  for (const [entityName, entityLines] of groups) {
    // 判定該 entity 的 category（用於跨人物告警）
    const cat = db.prepare('SELECT category FROM entity_profiles WHERE name = ?').get(entityName);
    if (cat && cat.category === 'person') personEntities.push(entityName);

    if (groups.size === 1 && ungrouped.length === 0) {
      // 單一實體，不加分組頭（避免無意義的噪音）
      output.push(...entityLines);
    } else {
      output.push(`【關於 ${entityName}】`);
      output.push(...entityLines);
    }
  }
  if (ungrouped.length > 0) {
    if (groups.size > 0) output.push('【其他】');
    output.push(...ungrouped);
  }

  // v5.5: 跨人物告警——同一輪注入涉及 >=2 個 person 實體時提醒模型不要混為一談
  if (personEntities.length >= 2) {
    output.push(`\n⚠️ 以上記憶涉及不同的人（${personEntities.join('、')}），不要混為一談。`);
  }

  return output.join('\n');
}

module.exports = { daysAgo, tokenizeCJK, searchFragments, formatForContext, searchHybrid, formatHybridContext, classifyIntent, lookupEntityIds, getEntityFragments };
