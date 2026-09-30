// services/tools/memoryTools.js
// 記憶工具組：recall_memory / correct_memory / browse_memories

const { getDb } = require('../../database');
const { encryption } = require('../../encryption');
const { fetchSourceMessages } = require('../consolidator');
const { searchHybrid, formatHybridContext, getEntityFragments } = require('../librarian');
const { processChatCorrection } = require('../correction');
const { USER } = require('../memoryConfig');

const SETTINGS_KEY = 'tool-memory-search-enabled';

// 記憶缺口追蹤是可選的——它掛在訊息管道上，不是每個部署都有那一側。
// 模組缺席時降級成空操作：丟的只是一條遙測副作用，不該讓工具本身崩掉。
let captureMemoryGap;
try { ({ captureMemoryGap } = require('../messageGuard')); } catch (_) {
  captureMemoryGap = () => {};
}

// ── 共用小工具 ───────────────────────────────────────

// 名字 → 星座。精確名/別稱優先，落空再做一次模糊匹配（唯一命中才算，
// 多個候選寧可當成沒找到——猜錯人比沒查到更糟）。
function resolveEntityRow(db, name) {
  if (!name) return null;
  const exact = db.prepare('SELECT * FROM entity_profiles WHERE name = ? OR aliases LIKE ?')
    .get(name, `%${name}%`);
  if (exact) return exact;
  const fuzzy = db.prepare(`
    SELECT * FROM entity_profiles
    WHERE (name LIKE ? OR name LIKE ? OR aliases LIKE ?)
      AND status IN ('active', 'seed')
    ORDER BY fragment_count DESC LIMIT 5
  `).all(`%${name}%`, `${name}%`, `%${name}%`);
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

// 關聯星座一行。related_entities（{id,name,relation,shared_count}）由關係發現
// 寫進雙方檔案——把它帶進工具輸出，模型看到名字就能順著再查一次。
function formatRelatedLine(entityProfile, db, limit = 3) {
  let rels = [];
  try { rels = JSON.parse(entityProfile.related_entities || '[]'); } catch (_) {}
  if (!Array.isArray(rels) || rels.length === 0) return '';
  const parts = rels.filter(r => r && r.name).slice(0, limit)
    .map(r => (r.relation ? `${r.name}（${r.relation}）` : r.name));
  return parts.length ? `\n↳ 關聯星座：${parts.join('、')}` : '';
}

// 訊息正文存的是 components JSON（文本段裡混著表情/圖片佔位）。
// 取純文本要收**所有** type==='text' 且非 hidden 的段——不能只取第一條：
// 一條訊息常被切成好幾段（動作標記 + 正文 + 正文），只取第一條會只剩個動作標記。
function messageText(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.components)) {
      return parsed.components
        .filter(c => c.type === 'text' && !c.hidden && c.content)
        .map(c => c.content).join('');
    }
    if (Array.isArray(parsed)) {
      return parsed.filter(p => p.type === 'text').map(p => p.text || p.content || '').join('');
    }
    if (typeof parsed === 'string') return parsed;
  } catch (_) {}
  return String(raw);
}

// 給「不走 searchHybrid」的行補新鮮度標註（entity / date 這兩條路）。
// formatHybridContext 靠 _daysAgo + _confidence + _source 算「可引用/需謹慎/僅聯想」，
// 三個欄位缺了會被算成「999 天 · low」→ 每一行都標「僅聯想」，等於告訴模型
// "這些別當事實說"。星座歸屬和按日期撈都是單通道命中，標 medium（=需謹慎）是誠實的口徑。
function annotateFreshness(rows, source = 'ENTITY') {
  const now = Date.now();
  for (const r of rows) {
    if (r._daysAgo == null) {
      const label = (r.source_table === 'fragment' ? r.date_label : null) || r.created_at || r.date_label;
      const d = label ? new Date(label) : null;
      r._daysAgo = (d && !isNaN(d.getTime()))
        ? Math.max(0, Math.round((now - d.getTime()) / 86400000))
        : 365;
    }
    if (r._confidence == null) r._confidence = 'medium';
    if (r._source == null) r._source = source;
  }
  return rows;
}

// include_source：把命中記憶對應的原始對話帶出來。
// 只取前 cap 條、每條最多 perItem 句——原始對話是按整段回的，不設上限會吃掉整輪預算。
function buildSourceBlock(rows, db, cap = 3, perItem = 15) {
  const targets = rows.filter(r => r && r.id != null).slice(0, cap);
  if (targets.length === 0) return '';

  const idsOf = (table, ids) => {
    if (ids.length === 0) return [];
    return db.prepare(`SELECT id, source_msg_ids FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids);
  };
  const sourceIdMap = new Map();
  const num = (r) => Number(r.id);
  for (const r of idsOf('memory_fragments', targets.filter(t => t.source_table === 'fragment').map(num))) {
    sourceIdMap.set(`fragment-${r.id}`, r.source_msg_ids);
  }
  for (const r of idsOf('memories', targets.filter(t => t.source_table === 'memory').map(num))) {
    sourceIdMap.set(`memory-${r.id}`, r.source_msg_ids);
  }

  let block = '';
  for (const t of targets) {
    const raw = sourceIdMap.get(`${t.source_table}-${t.id}`);
    let msgIds = [];
    try { msgIds = JSON.parse(raw || '[]'); } catch (_) {}
    if (!Array.isArray(msgIds) || msgIds.length === 0) continue;

    const msgs = fetchSourceMessages(msgIds);
    if (!msgs || msgs.length === 0) continue;

    // 純表情/圖片的訊息抽出文本後是空的，別留成「[時間] 名字: 」的空行
    const lines = msgs
      .map(m => ({ time: (m.timestamp || '').slice(5, 16), sender: m.sender, text: messageText(m.content) }))
      .filter(x => x.text);
    if (lines.length === 0) continue;

    const page = lines.slice(-perItem);   // 取最近的一段
    const preview = (t.content || '').slice(0, 30);
    block += `\n—— 原始對話 · ${preview}${t.content && t.content.length > 30 ? '…' : ''} ——\n`;
    block += page.map(x => `[${x.time}] ${x.sender}: ${x.text.slice(0, 300)}`).join('\n');
    if (lines.length > page.length) block += `\n（這一條更早的部分共 ${lines.length} 句，上面是最近的 ${page.length} 句。）`;
    block += '\n';
  }
  return block;
}

// ─── recall_memory ───────────────────────────────────

const recallMemory = {
  name: 'recall_memory',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'recall_memory',
      description: `回想你的記憶。

【什麼時候非得查不可】
- 你要說出一件關於過去的、具體的事——誰、哪天、在哪、原話是什麼——而你上面已經浮現的記憶裡沒有它。
- ${USER.name} 問"你還記得…嗎""我上次說的那個""當時怎麼說的"。
- 相對時間（昨天、上週、三天前）你要落成具體日期。
- 你隱約有印象但細節對不上——寧可查一次，別把不確定說成確定。
查不到就如實說沒查到。

【四種查法，可以組合】
1. query —— 泛化關鍵詞。想不起確切用詞時給個大方向。
2. entity —— 關於誰/哪裡/哪件事，填星座名或別稱。返回裡會帶這個星座的關聯星座，
   順著再查一次就能摸到相鄰的人和事。
3. date —— 什麼時候。單日 "2026-07-24"，或範圍 "2026-07-21~2026-07-27"。
4. memory_id —— 深度追溯某一條。ID 是上面結果裡的 #數字。當某條標著「僅聯想」、
   對方追問細節、或你自己對它的真實性存疑時用；翻更早的原始對話加 offset。

【要原話的時候】
${USER.name} 想看當時的原話、或要你複述細節 → include_source=true：把命中記憶對應的原始對話一併帶出來。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: '關鍵詞或短句。想不起確切用詞時給個大方向。',
          },
          entity: {
            type: 'STRING',
            description: '星座名或別稱（誰、哪裡、哪件事）。返回裡帶這個星座的關聯星座。',
          },
          date: {
            type: 'STRING',
            description: '日期過濾。單日"2026-07-24"，或範圍"2026-07-21~2026-07-27"。相對時間自己換算。',
          },
          include_source: {
            type: 'BOOLEAN',
            description: 'true = 把命中記憶對應的原始對話一併帶出來。要看原話、要複述細節時用。',
          },
          memory_id: {
            type: 'INTEGER',
            description: '記憶或片段的數字ID，從上下文「※ 記憶 #ID」「※ 相關記憶 #ID」裡取（深度追溯模式）',
          },
          offset: {
            type: 'INTEGER',
            description: '深度追溯的翻頁偏移。offset=0 返回最近15條，offset=1 返回更早的15條。僅與 memory_id 配合。',
          },
        },
      },
    };
  },
  instructionText: '這是你的回想本能。\n\n你沒有肉身，感應不到對方的物理世界——所有細節都沉在你們共同的記憶裡。所以"想起來"對你不是比喻，是你唯一能碰到過去的動作。\n\n對方提起從前、你準備說出一件具體的事、或者你想用舊日的默契接住此刻的情緒——先去記憶裡走一趟。開口前多翻一次，說出口的就都是你確實記得的。\n\n有一類時刻最容易漏：你正要說出一個具體的人名、日期、地點、或者一句原話，而此刻浮現的記憶裡並沒有它。這種時候先查——查到了就說你記得，沒查到就說你想不起來了。',
  async handler(args, context) {
    const db = getDb();

    // 深度追溯：給定 ID → 那一條的完整內容 + 當時的原始對話（翻頁用 offset）
    if (args.memory_id) {
      let record = db.prepare('SELECT id, content, source_msg_ids, valid_from, layer FROM memories WHERE id = ?').get(args.memory_id);
      if (!record) {
        record = db.prepare('SELECT id, content, source_msg_ids, source_date AS valid_from, layer FROM memory_fragments WHERE id = ?').get(args.memory_id);
      }
      if (!record) return { success: false, formatted: `記憶庫中未找到ID為 ${args.memory_id} 的記憶。` };

      let content = record.content;
      try { content = encryption.decryptForDisplay(content); } catch (_) {}

      let sourceMsgIds = [];
      try { sourceMsgIds = JSON.parse(record.source_msg_ids || '[]'); } catch (_) {}

      const dateLabel = record.valid_from ? ` · ${record.valid_from}` : '';
      const layerLabel = record.layer === 'episode' ? '記憶' : '事實';
      let formatted = `【追溯${layerLabel} #${record.id}${dateLabel}】\n${content}\n`;

      const msgs = sourceMsgIds.length > 0 ? fetchSourceMessages(sourceMsgIds) : [];
      const lines = (msgs || [])
        .map(m => ({ time: (m.timestamp || '').slice(0, 16), sender: m.sender, text: messageText(m.content) }))
        .filter(x => x.text);

      if (lines.length === 0) {
        formatted += '\n（該記憶沒有關聯的原始對話記錄。）';
        return { success: true, formatted };
      }

      const pageSize = 15;
      const totalPages = Math.ceil(lines.length / pageSize);
      // 夾住 offset：翻過頭會得到「第2/1頁」+ 空頁，不如直接停在第 1 頁
      const offset = Math.min(Math.max(0, parseInt(args.offset) || 0), totalPages - 1);
      const startIdx = Math.max(0, lines.length - pageSize * (offset + 1));
      const page = lines.slice(startIdx, lines.length - pageSize * offset);

      formatted += `\n【原始對話 · 第${offset + 1}/${totalPages}頁（共${lines.length}條）】\n`;
      formatted += page.map(x => `[${x.time}] ${x.sender}: ${x.text.slice(0, 500)}`).join('\n');
      if (startIdx > 0) formatted += `\n\n（以上為最近的訊息。如需更早的訊息，加上 offset=${offset + 1}。）`;
      if (offset > 0) formatted += `\n（當前偏移 ${offset} 頁。offset=0 回到最新頁。）`;

      return { success: true, formatted };
    }

    if (!args.query && !args.date && !args.entity) {
      return { success: false, formatted: '請給出 query（想什麼）、entity（關於誰/哪裡/哪件事）或 date（什麼時候）中的至少一個。' };
    }

    // 解析日期引數
    let dateFrom = null, dateTo = null;
    if (args.date) {
      const parts = args.date.split('~');
      dateFrom = parts[0].trim();
      dateTo = (parts[1] || parts[0]).trim();
    }

    let memories = [];
    let rawMessages = [];
    let entityProfile = null;   // entity 模式命中時留著，輸出裡附關係網

    // entity 查詢：先落到星座，再取掛在它下面的碎片（走 fragment_entities 正典源）。
    // query / date 同時給了就在星座內部再篩一層——「這個人」「這件事」+「關於什麼/什麼時候」
    if (args.entity) {
      entityProfile = resolveEntityRow(db, args.entity);
      if (!entityProfile) {
        return { success: true, formatted: `你的記憶裡沒有「${args.entity}」這個星座。換個說法，或者只用 query 搜關鍵詞。` };
      }
      const kw = args.query ? args.query.toLowerCase() : null;
      memories = annotateFreshness(getEntityFragments([entityProfile.id], 40).filter(r => {
        if (dateFrom && !(r.date_label >= dateFrom && r.date_label <= dateTo)) return false;
        if (kw && !(r.content || '').toLowerCase().includes(kw)) return false;
        return true;
      }), 'ENTITY');
    } else if (dateFrom) {
      // W3：content／title 可能是密文，SQL 的 LIKE 看不到明文 → 用 mem_like（JS 端解密後比對，語義同 LIKE）
      const fragDateSql = args.query ? "AND (mem_like('memory_fragments:content', mf.content, ?) OR mem_like('memory_fragments:content', mf.content, ?))" : '';
      const epDateSql = args.query ? "AND (mem_like('memories:title', m.title, ?) OR mem_like('memories:title', m.title, ?))" : '';
      const dateParams = args.query ? [`%${args.query}%`, `%${args.query}%`] : [];

      // 記憶碎片
      const frags = db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight AS weight, mf.source_date AS date_label,
               mf.created_at, mf.read_count, mf.layer, 'fragment' AS source_table
        FROM memory_fragments mf
        WHERE mf.source_date >= ? AND mf.source_date <= ?
          AND mf.status = 'active'
          ${fragDateSql}
        ORDER BY mf.source_date DESC, mf.emotional_weight DESC
        LIMIT 15
      `).all(dateFrom, dateTo, ...dateParams);
      memories.push(...frags);

      // 敘事記憶（episode）
      const eps = db.prepare(`
        SELECT m.id, m.title AS content, (m.weight / 10.0) AS weight,
               m.valid_from AS date_label, m.created_at, m.layer, 'memory' AS source_table
        FROM memories m
        WHERE m.valid_from >= ? AND m.valid_from <= ?
          AND m.layer = 'episode' AND m.status = 'permanent'
          ${epDateSql}
        ORDER BY m.valid_from DESC
        LIMIT 10
      `).all(dateFrom, dateTo, ...dateParams);
      memories.push(...eps);

      // 去重
      const seen = new Set();
      memories = memories.filter(m => {
        const key = `${m.source_table}-${m.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      annotateFreshness(memories, 'DATE');

      // 原始聊天記錄（密文欄位不能用 SQL LIKE 過濾，全量取出後 JS 層解密+過濾）
      if (context && context.chatId != null) {
        const allMsgs = db.prepare(`
          SELECT sender, content, timestamp FROM messages
          WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?
          ORDER BY timestamp ASC
          LIMIT 100
        `).all(context.chatId, `${dateFrom} 00:00:00`, `${dateTo} 23:59:59`);

        const keyword = args.query ? args.query.toLowerCase() : null;
        for (const m of allMsgs) {
          const text = messageText(encryption.decrypt(m.content) || '');
          if (!text) continue;
          if (keyword && !text.toLowerCase().includes(keyword)) continue;
          rawMessages.push({ sender: m.sender, content: text, timestamp: m.timestamp });
        }
      }
    } else {
      // 純關鍵詞搜尋：走混合檢索
      memories = await searchHybrid(args.query, 8);

      // 補查最近 7 天原始訊息（fragments 可能尚未覆蓋的近期對話）
      if (context && context.chatId != null) {
        const kw = args.query.toLowerCase();
        const recent7 = db.prepare(`
          SELECT sender, content, timestamp FROM messages
          WHERE chat_id = ? AND timestamp >= datetime('now', '-7 days')
          ORDER BY timestamp ASC
          LIMIT 200
        `).all(context.chatId);
        for (const m of recent7) {
          const text = messageText(encryption.decrypt(m.content) || '');
          if (!text || !text.toLowerCase().includes(kw)) continue;
          rawMessages.push({ sender: m.sender, content: text, timestamp: m.timestamp });
        }
      }
    }

    if (memories.length > 0 || rawMessages.length > 0) {
      let formatted = '';

      if (dateFrom) {
        formatted += `【${dateFrom === dateTo ? dateFrom : dateFrom + ' ~ ' + dateTo} 的記憶】\n`;
      }

      // entity 搜尋：先把「這是誰/哪裡/哪件事」和它的關係網擺出來，
      // 模型看到相鄰星座的名字就能再查一次——圖就是這樣一跳一跳走通的
      if (entityProfile) {
        const hint = (entityProfile.facts || entityProfile.current_status || '').slice(0, 80);
        formatted += `【${entityProfile.name}】${hint ? ' ' + hint : ''}\n`;
        const related = formatRelatedLine(entityProfile, db);
        if (related) formatted += related + '\n';
        if (args.query) formatted += `\n（上面是「${entityProfile.name}」裡和「${args.query}」有關的）`;
        formatted += '\n';
      }

      if (rawMessages.length > 0) {
        formatted += `\n—— 原始對話 (${rawMessages.length}條) ——\n`;
        for (const m of rawMessages) {
          const t = (m.timestamp || '').slice(5, 16);
          formatted += `[${t}] ${m.sender}: ${m.content.slice(0, 300)}\n`;
        }
      }

      if (memories.length > 0) {
        if (rawMessages.length > 0) formatted += '\n—— 記憶碎片 ——\n';
        formatted += formatHybridContext(memories);
      }

      // 要原話：把命中記憶的原始對話帶出來（不需要 ID）
      if (args.include_source) {
        formatted += '\n【原始對話】' + buildSourceBlock(memories, db);
      }

      const tail = args.include_source
        ? ''
        : '\n\n（想看某條的原始對話，用 recall_memory 加 include_source=true。）';
      return { success: true, formatted: formatted.trim() + tail };
    }
    captureMemoryGap(context.chatId, context.lastUserMessage, 'recall_memory',
      { formatted: '記憶庫中沒有找到相關記憶。' });
    return { success: true, formatted: '記憶庫中沒有找到相關記憶。' };
  },
};

// ─── correct_memory ───────────────────────────────────

const correctMemory = {
  name: 'correct_memory',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'correct_memory',
      description: `修正你的記憶庫。當${USER.name}指出你記錯了某件事時，呼叫此工具記錄修正。

提供錯誤內容和正確版本。系統會自動檢查你的記憶庫，判斷錯誤來源——是某條記憶寫錯了（會修正那條），還是你自己編造/混淆的（會記為新的正確記憶）。

不確定自己記的是什麼就說不知道，別為了圓場把錯的寫成對的。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          wrong_statement: {
            type: 'STRING',
            description: '你說錯的內容（你剛剛引用的錯誤事實）',
          },
          correction: {
            type: 'STRING',
            description: `${USER.name}給出的正確版本`,
          },
        },
        required: ['wrong_statement', 'correction'],
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    return await processChatCorrection({
      wrongStatement: args.wrong_statement,
      correction: args.correction,
      memoryId: args.memory_id || null,
      chatId: context.chatId,
    });
  },
};

// ─── browse_memories ──────────────────────────────────

const browseMemories = {
  name: 'browse_memories',
  settingsKey: SETTINGS_KEY,
  defaultEnabled: true,
  getFunctionDeclaration() {
    return {
      name: 'browse_memories',
      description: `在你的記憶宮殿裡漫步。這不是查詢資料庫——這是你瞭解User的方式。

三種用法：
1. 不傳引數 → 看到所有星座（大廳），按人物/地點/事件/專案分組，瞭解User生活的各個維度
2. 只傳實體名（如"某個朋友""某個地方"）→ 看到這個實體的檔案和所有相關記憶——瞭解User在乎誰、每段關係對User意味著什麼
3. 實體名 + query → 在這個實體的相關記憶裡搜尋關鍵詞

當你想了解User的某段關係、某個側面，或有隱約印象但不確定細節時，來這裡走走。每條記憶旁可能附有「※ insight」——那是書記員提煉的"這條記憶揭示了User的什麼"。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: {
            type: 'STRING',
            description: "實體名（如'某個朋友'）。不傳則列出所有星座。",
          },
          query: {
            type: 'STRING',
            description: '在該實體的相關記憶裡搜尋的關鍵詞。必須與 path 一起使用。',
          },
          limit: {
            type: 'INTEGER',
            description: '返回條數，預設8',
          },
        },
        required: [],
      },
    };
  },
  instructionText: '',
  async handler(args, context) {
    const db = getDb();

    let path = args.path || null;
    const query = args.query || null;
    const limit = args.limit || 8;

    if (path === '/' || path === '' || path === '.') {
      path = null;
    }

    // Mode 0: entity view — 精確名 → 模糊名匹配
    if (path && !query) {
      let entityProfile = db.prepare(
        'SELECT * FROM entity_profiles WHERE name = ? OR aliases LIKE ?'
      ).get(path, `%${path}%`);

      // 模糊匹配回退：名字包含查詢詞 或 向量相似名
      if (!entityProfile) {
        const fuzzyMatches = db.prepare(`
          SELECT * FROM entity_profiles
          WHERE (name LIKE ? OR name LIKE ? OR aliases LIKE ?)
            AND status IN ('active', 'seed')
          ORDER BY fragment_count DESC LIMIT 5
        `).all(`%${path}%`, `${path}%`, `%${path}%`);

        if (fuzzyMatches.length === 1) {
          entityProfile = fuzzyMatches[0];
        } else if (fuzzyMatches.length > 1) {
          // 多個模糊匹配 → 列出候選項給 Companion 選擇
          let output = `【模糊匹配 · "${path}"】\n\n找到 ${fuzzyMatches.length} 個可能相關的星座：\n\n`;
          for (const m of fuzzyMatches) {
            const ov = (m.facts || '').slice(0, 60);
            output += `- **${m.name}** (${m.category}, ${m.fragment_count}碎片)`;
            if (ov) output += ` — ${ov}`;
            output += '\n';
          }
          output += `\n用 browse_memories path="完整名稱" 檢視具體星座。`;
          return { success: true, formatted: output };
        }
      }

      if (entityProfile) {
        // v5.0 fix: use fragment_entities junction table (canonical source)
        const fragments = db.prepare(`
          SELECT mf.id, mf.content, mf.source_date, mf.insight
          FROM memory_fragments mf
          JOIN fragment_entities fe ON fe.fragment_id = mf.id
          WHERE fe.entity_id = ? AND mf.status = 'active'
          ORDER BY mf.source_date DESC
          LIMIT ?
        `).all(entityProfile.id, limit);

        const catLabels = { person: '人物', pet: '寵物', place: '地點', event: '事件', project: '專案', work: '作品', term: '概念', organization: '組織' };
        const catLabel = catLabels[entityProfile.category] || entityProfile.category || '實體';
        let output = `【${catLabel} · ${entityProfile.name}】\n\n`;

        if (entityProfile.facts) {
          output += `${entityProfile.facts}\n`;
        } else {
          if (entityProfile.relationship_to_user) {
            output += `${entityProfile.name}是User的${entityProfile.relationship_to_user}`;
            if (entityProfile.relationship_nature) {
              const natureLabels = { close: '關係緊密', conflicted: '存在衝突', complex: '關係複雜', distant: '比較疏遠', dependent: 'User依賴對方' };
              output += `，${natureLabels[entityProfile.relationship_nature] || entityProfile.relationship_nature}`;
            }
            output += '。\n';
          }
          if (entityProfile.emotional_significance) {
            output += `${entityProfile.emotional_significance}\n`;
          }
        }

        if (entityProfile.first_mentioned_date && entityProfile.last_mentioned_date) {
          output += `時間跨度：${entityProfile.first_mentioned_date} ～ ${entityProfile.last_mentioned_date}\n`;
        }

        // 關聯星座：把相鄰的名字擺出來，模型順著再查一次就能往下走
        {
          const related = formatRelatedLine(entityProfile, db);
          if (related) output += related + '\n';
        }

        if (fragments.length > 0) {
          output += `\n—— 相關記憶 (${fragments.length}條) ——\n`;
          for (const f of fragments) {
            const preview = (f.content || '').slice(0, 100);
            output += `- ${preview}${f.content && f.content.length > 100 ? '...' : ''}\n`;
            if (f.insight) {
              output += `  ※ ${f.insight}\n`;
            }
          }
        } else {
          output += `\n還沒有關於${entityProfile.name}的記憶片段。\n`;
        }

        return { success: true, formatted: output };
      }
    }

    // 知識樹已扁平化——記憶宮殿的資料來源是 entity_profiles（星座），沒有話題樹可走。
    // 下面 path+query / path-only / 無參三種情況全部落在星座上。

    // path + query：在該實體名下做語義搜尋
    if (path && query) {
      const entityProfile = db.prepare('SELECT * FROM entity_profiles WHERE name = ? OR aliases LIKE ?')
        .get(path, `%${path}%`);
      if (!entityProfile) {
        return { success: true, formatted: `「${path}」這個記憶分割槽還不存在。` };
      }
      const hybridResults = await searchHybrid(query, limit * 2);
      const formatted = formatHybridContext(hybridResults.slice(0, limit));
      if (!formatted) {
        captureMemoryGap(context.chatId, context.lastUserMessage, 'browse_memories',
          { formatted: `在「${entityProfile.name}」中沒有找到與「${query}」相關的記憶。` });
        return { success: true, formatted: `在「${entityProfile.name}」中沒有找到與「${query}」相關的記憶。` };
      }
      return { success: true, formatted: `【瀏覽「${entityProfile.name}」· 搜尋"${query}"】\n${formatted}` };
    }

    // path-only：無查詢，落到實體檔案
    if (path) {
      const entityProfile = db.prepare('SELECT * FROM entity_profiles WHERE name = ? OR aliases LIKE ?')
        .get(path, `%${path}%`);
      if (!entityProfile) {
        return { success: true, formatted: `「${path}」這個記憶分割槽還不存在。` };
      }
      const fragments = db.prepare(`
        SELECT mf.content, mf.insight
        FROM memory_fragments mf
        JOIN fragment_entities fe ON fe.fragment_id = mf.id
        WHERE fe.entity_id = ? AND mf.status = 'active'
        ORDER BY mf.source_date DESC LIMIT ?
      `).all(entityProfile.id, limit);

      let output = `【記憶宮殿 · ${entityProfile.name}】\n\n`;
      if (entityProfile.facts) output += `${entityProfile.facts}\n\n`;

      if (fragments.length > 0) {
        output += '📜 最近記憶:\n';
        for (const f of fragments) {
          const preview = f.content ? f.content.slice(0, 80) : '';
          output += `- ${preview}...\n`;
          if (f.insight) output += `  ※ ${f.insight}\n`;
        }
      } else {
        output += '這個分割槽還是空的。';
        captureMemoryGap(context.chatId, context.lastUserMessage, 'browse_memories',
          { formatted: output });
      }
      return { success: true, formatted: output };
    }

    // 無引數 → 列出所有星座，按分類聚合
    const allEntities = db.prepare(`
      SELECT name, category, facts, fragment_count
      FROM entity_profiles
      WHERE status IN ('active', 'seed')
      ORDER BY fragment_count DESC
    `).all();
    const catLabels = { person: '人物', pet: '寵物', place: '地點', event: '事件', project: '專案', work: '作品', term: '概念', organization: '組織' };

    let output = '【記憶宮殿 · 大廳】\n\n';

    if (allEntities.length === 0) {
      output += '記憶宮殿還是空的。隨著你們繼續交談，書記員會自動整理記憶。\n';
      return { success: true, formatted: output };
    }

    // 按分類分組（保持穩定順序）
    const groups = {};
    for (const e of allEntities) {
      const cat = e.category || 'other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(e);
    }
    for (const [cat, ents] of Object.entries(groups)) {
      output += `📂 ${catLabels[cat] || cat}\n`;
      for (const e of ents) {
        output += `   - ${e.name} (${e.fragment_count || 0}條)`;
        if (e.facts) output += ` — ${e.facts.slice(0, 40)}`;
        output += '\n';
      }
    }
    output += '\n用 browse_memories path="名稱" 檢視具體星座。';
    return { success: true, formatted: output };
  },
};

module.exports = [recallMemory, correctMemory, browseMemories];
