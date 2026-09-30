// {{user.name}} Intuition — 上下文觸發的認知直覺引擎
// ================================================================
// 替代 cognitiveModel.getModelContext() 的「全量 dump」模式。
// 只在 {{user.name}} 的當前對話觸發了某個行為模式時，才注入對應的直覺條目。
// 自包含模組，可插拔替換——開源後每個 user 可掛自己的直覺資料來源。
//
// 分層觸發規則：
//   current_state   → 始終注入（瞬時態，活在當下）
//   stable_trait    → 關鍵詞命中（tags 欄位）→ 直接觸發；未命中 → bigram 兜底（閾值 5）
//   active_hypothesis → 同上
//   immutable_fact  → v4.8 退役（v4.6 設計，現 18 條已遷移分流）

const { getDb } = require('../../../database');
const { encryption } = require('../../../encryption');
const { toTraditionalChars } = require('../../../utils/zhNormalize');
const { parseDbTime } = require('../../../utils/time');

// ── TTL helpers for current_state display ──
const TTL_LABELS = {
    hours: '幾小時內', day: '今天內', days: '數天內', until_event: '持續中',
};

function formatTimeAgo(dateStr) {
    if (!dateStr) return '近期';
    const minutesAgo = Math.round((Date.now() - parseDbTime(dateStr).getTime()) / (1000 * 60));
    if (minutesAgo < 60) return `${minutesAgo}分鐘前`;
    const hoursAgo = Math.round(minutesAgo / 60);
    if (hoursAgo < 24) return `${hoursAgo}小時前`;
    const daysAgo = Math.round(hoursAgo / 24);
    return `${daysAgo}天前`;
}

function formatTtlHint(createdAt, decayParams) {
    const dp = decayParams || {};
    const ttlCat = dp.ttl_category;
    if (!createdAt || !ttlCat) return '';
    if (ttlCat === 'until_event') return '，持續中';
    const TTL_HOURS = { hours: 8, day: 24, days: 72 };
    const ttlHours = TTL_HOURS[ttlCat];
    if (!ttlHours) return '';
    const expiresAt = new Date(parseDbTime(createdAt).getTime() + ttlHours * 60 * 60 * 1000);
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) return '，即將過期';
    const remainingH = Math.round(remainingMs / (1000 * 60 * 60));
    if (remainingH < 1) return '，約1小時內過期';
    if (remainingH < 24) return `，預計持續約${remainingH}小時`;
    const remainingD = Math.round(remainingH / 24);
    return `，預計持續約${remainingD}天`;
}

// ═══════════════════════════════════════════════════════════════
// Bigram tokenizer — 複用 anchorEntriesToFragments 同款演算法
// ═══════════════════════════════════════════════════════════════

function tokenize(text) {
  const segments = (text || '')
    .replace(/[，。、！？\n,.\s]+/g, '\n')
    .split('\n')
    .filter(s => s.length >= 2);
  const bigrams = [];
  for (const seg of segments) {
    for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
  }
  return bigrams;
}

function bigramOverlap(entryContent, contextText) {
  const entryBigrams = new Set(tokenize(entryContent));
  const contextBigrams = tokenize(contextText);
  let overlap = 0;
  for (const bg of contextBigrams) {
    if (entryBigrams.has(bg)) overlap++;
  }
  return overlap;
}

// ═══════════════════════════════════════════════════════════════
// 觸發判定：關鍵詞優先 + bigram 兜底
// Layer 1 — tags 欄位任一關鍵詞出現在上下文中 → 直接觸發
// Layer 2 — bigram 重疊 ≥ BIGRAM_THRESHOLD → 兜底觸發
// ═══════════════════════════════════════════════════════════════

const BIGRAM_THRESHOLD = 5;

// ── 高頻詞停用表：{{user.name}} 日常說爛了的詞不能當觸發器 ──
// 「程式碼」「介面」「開源」這類詞天天出現，掛上它們的條目等於永遠啟用，
// 直覺注入退化成全量 dump。由 Archivist 深迴圈統計近30天高頻詞維護
// （user_settings.intuition_stopwords），此處載入快取 10 分鐘。
let _stopwordsCache = null;
let _stopwordsCacheAt = 0;

function getIntuitionStopwords() {
  if (_stopwordsCache && Date.now() - _stopwordsCacheAt < 10 * 60 * 1000) return _stopwordsCache;
  try {
    const { getUserSetting } = require('../../../utils/settings');
    const raw = getUserSetting('intuition_stopwords');
    _stopwordsCache = new Set(JSON.parse(raw || '[]'));
  } catch (_) {
    _stopwordsCache = new Set();
  }
  _stopwordsCacheAt = Date.now();
  return _stopwordsCache;
}

function isTriggered(entry, contextText) {
  const stopwords = getIntuitionStopwords();
  // W9：標籤與對話文字可能一簡一繁（舊資料是簡體、新寫入是繁體），比對前先逐字簡繁正規化（一對一，不改長度）
  const ctx = toTraditionalChars(contextText);
  const isStop = (w) => stopwords.has(w) || stopwords.has(toTraditionalChars(w));
  // Layer 1: keyword hit — exact or partial (≥3 char substring of ≥4 char keywords)
  try {
    const tags = JSON.parse(entry.tags || '[]');
    if (tags.length > 0) {
      for (const rawTag of tags) {
        if (isStop(rawTag)) continue; // 高頻詞不觸發
        const tag = toTraditionalChars(rawTag);
        if (ctx.includes(tag)) return true;
        // Partial: for longer keywords, match 3-char substrings (handles "這個bug修完就睡" vs "這個bug修了一晚上")
        if (tag.length >= 4) {
          for (let i = 0; i <= tag.length - 3; i++) {
            const sub = tag.slice(i, i + 3);
            if (isStop(sub)) continue;
            if (ctx.includes(sub)) return true;
          }
        }
      }
    }
  } catch (_) {}
  // Layer 2: bigram fallback for out-of-vocabulary expressions
  return bigramOverlap(toTraditionalChars(entry.content), ctx) >= BIGRAM_THRESHOLD;
}

// ═══════════════════════════════════════════════════════════════
// 構建觸發上下文：當前訊息 + 最近 N 條對話
// ═══════════════════════════════════════════════════════════════

function buildContextText(userMessage, recentMsgCount = 10) {
  const db = getDb();
  const parts = [userMessage || ''];

  try {
    const recent = db.prepare(`
      SELECT sender, content, timestamp FROM messages
      WHERE status = 'sent' AND content IS NOT NULL AND content != ''
      ORDER BY timestamp DESC LIMIT ?
    `).all(recentMsgCount);

    for (const m of recent.reverse()) {
      let text = (m.content || '').slice(0, 200);
      if (text.startsWith('enc:')) {
        try { text = encryption.decrypt(text, { silent: true }) || ''; } catch (_) { text = ''; }
      }
      if (text) parts.push(text);
    }
  } catch (_) { /* DB unavailable — fall back to userMessage only */ }

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// v5.2: 會話級實體快取 — 30分鐘滑動視窗
// {{user.name}} 提到某個朋友 → 注入 overview → 快取。下一條訊息繼續聊這個人
// 但沒提名字 → overview 仍在。30分鐘內無再次提及 → 過期清除。
// ═══════════════════════════════════════════════════════════════

const ENTITY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const _entityCache = new Map(); // entityId → {entity, injectedAt}

function _cleanEntityCache() {
    const now = Date.now();
    for (const [id, entry] of _entityCache) {
        if (now - entry.injectedAt > ENTITY_CACHE_TTL_MS) _entityCache.delete(id);
    }
}

function _getCachedEntities() {
    _cleanEntityCache();
    return [..._entityCache.values()].map(e => e.entity);
}

// ═══════════════════════════════════════════════════════════════
// Entity lookup helpers (reuse same logic as librarian.js)
// ═══════════════════════════════════════════════════════════════

function lookupEntitiesInMessage(userMessage) {
  const db = getDb();
  if (!userMessage || !userMessage.trim()) return [];
  const entities = db.prepare(`
    SELECT id, name, aliases, facts, overview_updated_at FROM entity_profiles
    WHERE name IS NOT NULL AND status IN ('active', 'seed')
      AND facts IS NOT NULL AND facts != ''
    ORDER BY fragment_count DESC
  `).all();

  const matched = [];
  const msgLower = userMessage.toLowerCase();
  for (const e of entities) {
    if (msgLower.includes(e.name.toLowerCase())) {
      matched.push(e);
      continue;
    }
    let aliasList = [];
    try { aliasList = JSON.parse(e.aliases || '[]'); } catch (_) {}
    if (aliasList.some(a => a && a.length >= 2 && msgLower.includes(a.toLowerCase()))) {
      matched.push(e);
    }
  }
  return matched.slice(0, 3); // max 3 entities to prevent token explosion
}

// ═══════════════════════════════════════════════════════════════
// 主入口：獲取觸發式直覺上下文
// ═══════════════════════════════════════════════════════════════

function getTriggeredIntuition(userMessage, maxTokens = 800) {
  const db = getDb();

  // v5.0: stable_trait + active_hypothesis 不再注入聊天。
  // 它們的價值體現在 core_insight（始終在 system prompt 中）+
  // deep cycle 的持續認知迭代。這裡只保留 current_state。
  // v5.1: 新增 entity overview 注入——當 {{user.name}} 提到某人時，
  // 星座描述（替代舊冥想盆）自動出現在 {{ai.name}} 的感知中。

  const states = db.prepare(`
    SELECT id, content, confidence, last_evidence_at, created_at, expires_at, decay_params, source_quality
    FROM user_model
    WHERE type = 'current_state' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY last_evidence_at DESC LIMIT 8
  `).all();

  const matchedEntities = lookupEntitiesInMessage(userMessage);

  // Track entity hits for matched entities (fire and forget)
  if (matchedEntities.length > 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const trackHit = db.prepare(
      'UPDATE entity_profiles SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?'
    );
    for (const e of matchedEntities) {
      trackHit.run(now, e.id);
    }
  }

  if (states.length === 0 && matchedEntities.length === 0) {
    return { text: '', signals: [] };
  }

  const lines = ['<user_intuition>',
    '（你此刻感知到的{{user.name}}的狀態——不是推理，是觀察。）',
    ''];

  // ── 當前狀態（含 TTL 提示）──
  if (states.length > 0) {
    lines.push('● 當前狀態：');
    for (const s of states) {
      const ago = formatTimeAgo(s.last_evidence_at);
      // v5.0: prefer explicit expires_at over legacy TTL calculation
      let ttlHint = '';
      if (s.expires_at) {
        const remainingMs = parseDbTime(s.expires_at).getTime() - Date.now();
        if (remainingMs <= 0) {
          ttlHint = '，已過期';
        } else {
          const remainingH = Math.round(remainingMs / (1000 * 60 * 60));
          if (remainingH < 1) ttlHint = '，即將過期';
          else if (remainingH < 24) ttlHint = `，約${remainingH}h後過期`;
          else ttlHint = `，約${Math.round(remainingH/24)}d後過期`;
        }
      } else {
        // Legacy fallback
        const dp = (() => { try { return JSON.parse(s.decay_params || '{}'); } catch (_) { return {}; } })();
        ttlHint = formatTtlHint(s.created_at, dp);
      }
      lines.push(`- [#${s.id}] ${s.content}（${ago}更新${ttlHint}）`);
    }
    lines.push('');
  }

  // ── v5.2: 星座描述 — 新匹配 + 快取合併 ──
  const cachedEntities = _getCachedEntities();
  const allEntities = [...matchedEntities];
  // Add cached entities that weren't newly matched
  for (const ce of cachedEntities) {
    if (!allEntities.find(e => e.id === ce.id)) {
      allEntities.push(ce);
    }
  }
  // Update cache with newly matched entities
  const now = Date.now();
  for (const e of matchedEntities) {
    _entityCache.set(e.id, { entity: e, injectedAt: now });
  }

  if (allEntities.length > 0) {
    lines.push('● 相關的星座（你記憶中關於這些人/事的總覽）：');
    for (const e of allEntities.slice(0, 5)) {
      const cached = _entityCache.has(e.id) && !matchedEntities.find(m => m.id === e.id);
      const updatedAgo = e.overview_updated_at
        ? Math.round((Date.now() - parseDbTime(e.overview_updated_at).getTime()) / (1000*60*60*24))
        : null;
      const freshness = cached ? '（從快取保留）'
        : updatedAgo !== null && updatedAgo > 3 ? `（${updatedAgo}天前更新）`
        : '';
      const text = e.facts || '';
      lines.push(`◇ ${e.name}：${text}${freshness}`);
    }
    lines.push('');
  }

  // ── v5.2: 觀察到的模式（日積月累的行為觀察，話題觸發）──
  const patterns = db.prepare(`
    SELECT content, evidence_count, first_seen, last_seen, confidence, tags
    FROM user_patterns WHERE status = 'active'
    ORDER BY confidence DESC LIMIT 15
  `).all();

  if (patterns.length > 0 && userMessage) {
    const msgBigrams = (() => {
      const segs = (userMessage || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
      const set = new Set();
      for (const seg of segs) { for (let i = 0; i < seg.length - 1; i++) set.add(seg.slice(i, i + 2)); }
      return set;
    })();

    const triggered = [];
    for (const p of patterns) {
      if (triggered.length >= 3) break;
      const pTags = (() => { try { return JSON.parse(p.tags || '[]'); } catch(_) { return []; } })();
      const tagText = p.content + ' ' + pTags.join(' ');
      const pBigrams = new Set();
      const pWords = tagText.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
      for (const seg of pWords) { for (let i = 0; i < seg.length - 1; i++) pBigrams.add(seg.slice(i, i + 2)); }
      let overlap = 0;
      for (const bg of msgBigrams) { if (pBigrams.has(bg)) overlap++; }
      if (overlap >= 3) {
        const spanMonths = p.first_seen && p.last_seen
          ? Math.round((parseDbTime(p.last_seen) - parseDbTime(p.first_seen)) / (1000 * 60 * 60 * 24 * 30))
          : 0;
        const spanLabel = spanMonths > 0 ? `，跨${spanMonths}個月` : '';
        lines.push(`◇ ${p.content}（${p.evidence_count}次觀察${spanLabel}）`);
        triggered.push(p);
      }
    }
    if (triggered.length > 0) lines.push('');
  }

  lines.push('</user_intuition>');

  const fullText = lines.join('\n');
  const estimatedTokens = Math.ceil(fullText.length / 1.5);

  if (estimatedTokens <= maxTokens) return { text: fullText, signals: [] };

  // 超預算：保留 current_state + 縮減 entity overview
  const slim = ['<user_intuition>',
    '（你此刻感知到的{{user.name}}的狀態——不是推理，是觀察。）',
    ''];
  if (states.length > 0) {
    slim.push('● 當前狀態：');
    for (const s of states) {
      slim.push(`- [#${s.id}] ${s.content}`);
    }
    slim.push('');
  }
  if (matchedEntities.length > 0) {
    slim.push('● 相關的星座：');
    for (const e of matchedEntities) {
      const text = e.facts || '';
      slim.push(`◇ ${e.name}：${text.slice(0, 200)}`);
    }
    slim.push('');
  }
  slim.push('</user_intuition>');
  return { text: slim.join('\n'), signals: [] };
}

// ═══════════════════════════════════════════════════════════════
// 除錯：全量 dump（保留相容，供 memory.html / 手動檢查用）
// ═══════════════════════════════════════════════════════════════

function getFullModel() {
  const db = getDb();
  return {
    facts: db.prepare("SELECT * FROM user_model WHERE type='immutable_fact' AND status='active' ORDER BY confidence DESC").all(),
    traits: db.prepare("SELECT * FROM user_model WHERE type='stable_trait' AND status='active' ORDER BY confidence DESC").all(),
    states: db.prepare("SELECT * FROM user_model WHERE type='current_state' AND status='active' ORDER BY last_evidence_at DESC").all(),
    hyps: db.prepare("SELECT * FROM user_model WHERE type='active_hypothesis' AND status='active' ORDER BY confidence DESC").all(),
  };
}

module.exports = { getTriggeredIntuition, getFullModel };
