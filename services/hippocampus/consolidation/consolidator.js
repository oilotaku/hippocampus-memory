// =================================================================
// Consolidator — 遺留工具模組（v5.0）
//
// 原為獨立管線階段。v4.0 起整合邏輯已遷入 Archivist 深迴圈
// （consolidateCategory / clusterSagas / consolidateFlash）。
//
// 本檔案現作為工具庫被引用，提供：
//   - clusterSagas()      — Saga 聚類（由 Archivist 呼叫）
//   - fetchSourceMessages() — 追溯原始對話（由 recall_memory 工具呼叫）
//   - consolidateFlash()   — 高能即時整合（由 Archivist 事件驅動呼叫）
// =================================================================

const { getDb } = require('../../../database');
const { parseDbTime } = require('../../../utils/time');
const { sealField } = require('../../memoryCrypto');
const { callLLM } = require('../../llm');
const { fillPrompt, USER, AI } = require('../../nameResolver');
const { chromaDBOperation, getLocalEmbedding } = require('../ca3/memory');
const { encryption } = require('../../../encryption');
const { updateEntityProfiles } = require('../cortex/entityProfile');
const { WORLD_CONTEXT } = require('../../worldContext');

const CONFIG = {
    LOOKBACK_DAYS: 7,            // 查詢最近N天的活躍碎片（null=不限時間）
    SIMILARITY_THRESHOLD: 0.78,  // 語義相似度閾值（0.82太保守少到7對，0.72太激進導致90條大組）
    MIN_GROUP_SIZE: 2,           // 最少碎片數才觸發整合
    MAX_GROUP_SIZE: 20,          // 單組最多碎片數（防止Union-Find連通過多碎片形成巨型合併）
    MIN_FRAGMENTS_TO_CHECK: 10,  // 最少碎片數才觸發檢查
    MAX_GROUPS_PER_RUN: 10,      // 單次最多整合組數（控制API消耗）
    MAX_FRAGMENTS_TO_PROCESS: 250, // 單次最多處理碎片數
    API_CONFIG_ID: 36,           // [書庫]DS
};

const CONSOLIDATOR_SYSTEM_PROMPT = `${WORLD_CONTEXT}

你是記憶整合器，負責將多個相似的記憶碎片合併為一條規範的長期記憶。

## 你的任務

你會收到：
1. 一組語義相似但角度/時間不同的記憶碎片
2. 可能附帶這些碎片對應的原始對話訊息（帶時間戳）——如果為空，說明原始訊息不可追溯

你需要：
1. 將這些碎片合併為一條連貫、準確的長期記憶（不超過150字）
2. 如果提供了原始對話，從時間戳推斷事件真實日期——對話中可能用了"上週五""前天"等相對時間詞，必須根據訊息時間戳轉換為絕對日期
3. 如果原始對話不可用，使用碎片的source_date作為近似日期
4. 如果碎片之間存在矛盾，記錄矛盾資訊
5. **判斷這件事的分量——一個月後還值得被記住嗎？**

## 記憶分量判斷（significance）★最重要

不是每一組碎片都值得變成長期記憶。請用significance欄位評估：

- 8-10：情感轉折、重大決定、深刻衝突、第一次經歷、關係里程碑 — 值得永久保留
- 5-7：有意義但非關鍵的事件、日常偏好變化、輕度情緒波動 — 有資訊價值，但不算重要
- 3-4：routine技術操作、配置修改、日常coding、短暫情緒、純工作記錄 — 不值得長期保留
- 1-2：純工具操作、系統日誌級資訊、無關緊要的閒聊 — 應該被丟棄

**關鍵原則：**
- 技術工作記錄、程式碼修改、伺服器配置等routine活動，即使寫了也很快會過時，significance ≤ 4
- 情緒崩潰後改了個配置項 ≠ 重要記憶（重要是"為什麼崩潰"，不是"改了什麼設定"）
- "約了哪天見面""買了演出票""做了重大人生決定""寫了對你很重要的東西" — 這些才是值得 ≥5 的
- 同一件事被反覆提及、{{user.name}}有明顯情緒 → significance更高
- **不要因為碎片多就硬拔significance——碎片多隻能說明這件事被反覆提到，不能說明它重要**
- **RP（角色扮演）內容的significance自動減2分**：RP中的虛構情節、角色臺詞、場景描寫是表演而非真實事件，除非其中有真實情感表達（如RP中表達了真實的情感需求），否則significance ≤ 3

## 輸出格式

嚴格JSON，不含任何其他文字：

{
  "merged_memory": "第三人稱規範記憶文本，150字以內。必須以人名或實體名開頭。significance≤4時可為空字串。",
  "corrected_date": "YYYY-MM-DD 或空字串",
  "confidence": "high/medium/low——有原始對話佐證→high；只用source_date推斷→medium；碎片間明顯矛盾或資訊不足→low",
  "significance": 1-10,
  "contradiction": null 或 "矛盾描述"
}

## 時間推斷規則

- 有原始對話時：訊息時間戳是絕對時間，格式如 [2026-05-12 14:30]
  對話中{{user.name}}說"上週五去了XX" → 時間戳是5月12日(週二) → 上週五是5月8日 → corrected_date: 2026-05-08
  對話中{{user.name}}說"前天吃了XX" → 時間戳是5月12日 → 前天是5月10日 → corrected_date: 2026-05-10
- 無原始對話時：取多個碎片中最早的source_date作為近似日期
- 碎片間涉及不同時間點的事，不要強行合併為同一天——用"X月Y日……Z日……"分述

## 實體認知更新（重要）

當多個碎片涉及同一實體（人物/地點/狀態）但描述了**同一屬性不同值**時，這不是矛盾——這是時間線更新。舊的值為歷史，新的值為當前。

示例：
  碎片A："某朋友在某國家留學" (source_date: 2025-06)
  碎片B："某朋友已回國，在某城市寫小說" (source_date: 2026-05)
  → merged_memory: "某朋友曾在某國家留學，2026年已回國，目前在寫新小說。"
  → contradiction: null（不標記為矛盾，這是正常的時間線演進）

只有當碎片描述的是**同一時間點但事實衝突**時，才標記為矛盾：
  碎片A："{{user.name}} 5月10日去了某城市"
  碎片B："{{user.name}} 5月10日待在某城市沒出門"
  → 這才是矛盾

## 注意事項

- 合併時保留最具體、最有資訊量的表述
- 同一實體同一屬性的不同值 → 時間線演進，不標記矛盾，merged_memory中保留"曾…現已…"的時間結構
- 只有同一時間點的事實衝突才標記contradiction
- 碎片中重複的資訊只保留一次`;

// 獲取活躍碎片。daysBack=null 時不限時間（首次全量），否則只取最近N天
function getRecentActiveFragments(daysBack = CONFIG.LOOKBACK_DAYS) {
    const db = getDb();
    if (daysBack === null) {
        return db.prepare(`
            SELECT id, type, entity, content, emotional_weight, source, source_date, source_msg_ids, created_at, is_rp
            FROM memory_fragments
            WHERE status = 'active'
            ORDER BY created_at DESC
        `).all();
    }
    return db.prepare(`
        SELECT id, type, entity, content, emotional_weight, source, source_date, source_msg_ids, created_at, is_rp
        FROM memory_fragments
        WHERE status = 'active'
          AND created_at >= datetime('now', '-' || ? || ' days')
        ORDER BY created_at DESC
    `).all(daysBack);
}

// 使用 Union-Find 將相似碎片對分組
class UnionFind {
    constructor(n) { this.parent = Array.from({ length: n }, (_, i) => i); this.rank = new Array(n).fill(0); }
    find(x) { if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]); return this.parent[x]; }
    union(a, b) {
        const ra = this.find(a), rb = this.find(b);
        if (ra === rb) return;
        if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
        else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
        else { this.parent[rb] = ra; this.rank[ra]++; }
    }
}

// 為一組碎片查詢 ChromaDB 中的相似對
// 最佳化：單次 Python 呼叫完成所有 embedding + ChromaDB 查詢（替代逐個 spawn）
async function findSimilarGroups(fragments) {
    if (fragments.length < CONFIG.MIN_GROUP_SIZE) return [];

    // 構建 items 陣列，一次發給 chroma_helper
    const items = fragments.map(f => ({
        id: f.id,
        text: `${f.entity}: ${f.content}`
    }));

    let pairs;
    try {
        const result = await chromaDBOperation('find_similar_groups', {
            items,
            n_results: 5,
            min_similarity: CONFIG.SIMILARITY_THRESHOLD
        });
        pairs = result.pairs || [];
    } catch (e) {
        console.error('[Consolidator] 批次相似查詢失敗:', e.message);
        return [];
    }

    console.log(`[Consolidator] 從${fragments.length}個碎片中找到${pairs.length}個相似對`);

    if (!pairs.length) return [];

    // 構建碎片 ID → 索引對映 + Union-Find
    const idToIndex = new Map(fragments.map((f, i) => [f.id, i]));
    const uf = new UnionFind(fragments.length);

    for (const p of pairs) {
        const idxA = idToIndex.get(p.fragment_a);
        const idxB = idToIndex.get(p.fragment_b);
        if (idxA !== undefined && idxB !== undefined) {
            uf.union(idxA, idxB);
        }
    }

    // 按連通分量分組，只保留 size >= MIN_GROUP_SIZE 的組
    const groups = new Map();
    for (let i = 0; i < fragments.length; i++) {
        const root = uf.find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(fragments[i]);
    }

    const validGroups = [];
    for (const group of groups.values()) {
        if (group.length >= CONFIG.MIN_GROUP_SIZE) {
            // 超限截斷：只取最新的 MAX_GROUP_SIZE 條，防止巨型合併
            if (group.length > CONFIG.MAX_GROUP_SIZE) {
                console.log(`[Consolidator] 組過大(${group.length}條)，擷取最新${CONFIG.MAX_GROUP_SIZE}條`);
                // 按 created_at 降序排（最新的在前），取前 MAX_GROUP_SIZE
                group.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
                validGroups.push(group.slice(0, CONFIG.MAX_GROUP_SIZE));
            } else {
                validGroups.push(group);
            }
        }
    }

    console.log(`[Consolidator] ${validGroups.length}個有效組（≥${CONFIG.MIN_GROUP_SIZE}條）`);
    return validGroups;
}

// 從訊息ID列表中讀取原始對話
function fetchSourceMessages(msgIds) {
    const db = getDb();
    const uniqueIds = [...new Set(msgIds)].filter(id => id != null);
    if (uniqueIds.length === 0) return [];

    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT id, sender, content, timestamp, is_encrypted
        FROM messages
        WHERE id IN (${placeholders})
        ORDER BY timestamp ASC
    `).all(...uniqueIds);

    // 解密
    return rows.map(r => ({
        id: r.id,
        sender: r.sender === 'user' ? USER.name : AI.name,
        content: (r.is_encrypted && r.content) ? (encryption.decrypt(r.content) || '') : (r.content || ''),
        timestamp: r.timestamp
    }));
}

// 格式化訊息為 LLM 輸入
function formatMessagesForLLM(messages) {
    return messages.map(m => {
        const time = m.timestamp?.slice(0, 16) || '';
        const content = m.content.slice(0, 300);
        return `[${time}] ${m.sender}: ${content}`;
    }).join('\n');
}

// 整合一組相似碎片
async function consolidateGroup(group) {
    const db = getDb();

    // 收集所有源訊息 ID
    const allMsgIds = [];
    for (const f of group) {
        try {
            const ids = JSON.parse(f.source_msg_ids || '[]');
            allMsgIds.push(...ids);
        } catch (_) {}
    }

    // 讀取原始訊息
    const sourceMessages = fetchSourceMessages(allMsgIds);

    // 構建 LLM 輸入
    const fragmentsText = group.map((f, i) => {
        const rpTag = f.is_rp ? ', is_rp=true' : '';
        return `[碎片${i + 1}] entity=${f.entity}, type=${f.type}, source_date=${f.source_date}, ew=${f.emotional_weight}${rpTag}\n${f.content}`;
    }).join('\n\n');

    const messagesText = sourceMessages.length > 0
        ? `\n\n原始對話訊息：\n${formatMessagesForLLM(sourceMessages)}`
        : '';

    const userPrompt = `請整合以下相似記憶碎片：\n\n${fragmentsText}${messagesText}`;

    let result;
    let attempts = 0;
    while (attempts < 2) {
        attempts++;
        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: fillPrompt(userPrompt) }] }],
                CONSOLIDATOR_SYSTEM_PROMPT,
                null,
                { temperature: 0.3, maxOutputTokens: 4000 },
                CONFIG.API_CONFIG_ID
            );
            const clean = raw.reply.replace(/```json|```/g, '').trim();
            result = JSON.parse(clean);
            break;
        } catch (err) {
            if (attempts >= 2) {
                console.error(`[Consolidator] LLM整合失敗(2次嘗試):`, err.message.slice(0, 200));
                return null;
            }
            console.warn(`[Consolidator] 第${attempts}次整合失敗，3s後重試...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    if (!result || !result.merged_memory) return null;

    // ── 分量門檻：不值得長期記住的事件不寫入 memories ──
    const significance = typeof result.significance === 'number' ? result.significance : 5;
    const MIN_SIGNIFICANCE = 4;
    if (significance < MIN_SIGNIFICANCE) {
        console.log(`[Consolidator] 跳過(分量不足 sig=${significance}): ${(result.merged_memory || group[0].content).slice(0, 60)}...`);
        // 不標記 fragments 為 consolidated——碎片保留在活躍池，通過 Librarian 自然衰減
        return {
            memoryId: null,
            memoryContent: null,
            fragmentIds: [],
            correctedDate: null,
            confidence: result.confidence || 'low',
            contradiction: null,
            skipped: true,
            significance,
        };
    }

    // 計算合併後的權重（emotional_weight 為基礎，significance 為主調）
    const avgEW = group.reduce((s, f) => s + (f.emotional_weight || 0.5), 0) / group.length;
    // significance 5-6 → weight 5-6, 7-8 → weight 7-8, 9-10 → weight 9-10
    const sigWeight = Math.round(significance);
    const mergedWeight = Math.min(10, Math.round(sigWeight * 0.7 + (5 + avgEW * 3) * 0.3));

    // 使用校正後的日期，或回退到 source_date
    const finalDate = result.corrected_date || group[0].source_date || '';

    // 收集所有碎片的 source_msg_ids（合併繼承）
    const mergedMsgIds = [...new Set(allMsgIds)];

    // 收集所有碎片的 ID 用於標記 consolidated
    const fragmentIds = group.map(f => f.id);

    // 寫入 memories 表
    const title = result.merged_memory.slice(0, 50);
    const consolidationType = group.consolidationType || 'standard';
    const insert = db.prepare(`
        INSERT INTO memories (title, content, weight, valid_from, status, source_msg_ids, layer, consolidation_type, audit_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'permanent', ?, 'episode', ?, 'pending', datetime('now'), datetime('now'))
    `);
    const info = insert.run(
        sealField('memories', 'title', title),
        sealField('memories', 'content', result.merged_memory),
        mergedWeight,
        finalDate,
        JSON.stringify(mergedMsgIds),
        consolidationType
    );
    const memoryId = info.lastInsertRowid;

    // ❶ 先清理 ChromaDB 中舊碎片嵌入（必須在 embed 新記憶之前，防止誤判 duplicate）
    try {
        let cleaned = 0;
        for (const fid of fragmentIds) {
            try {
                await chromaDBOperation('delete', { id: `fragment_${fid}` });
                cleaned++;
            } catch (_) { /* individual delete failure is non-fatal */ }
        }
        if (cleaned > 0) {
            console.log(`[Consolidator] ChromaDB 清理: ${cleaned}/${fragmentIds.length} 條舊碎片嵌入已刪除`);
        }
    } catch (e) {
        console.warn(`[Consolidator] ChromaDB 清理失敗（非致命）: ${e.message}`);
    }

    // ❷ 標記原碎片為已整合
    const markConsolidated = db.prepare(`
        UPDATE memory_fragments SET status = 'consolidated' WHERE id = ?
    `);
    for (const fid of fragmentIds) {
        markConsolidated.run(fid);
    }

    // ❸ 索引新記憶到 ChromaDB（舊碎片已刪，不會衝突判重）
    let chromaId = null;
    try {
        const indexResult = await chromaDBOperation('index_batch', {
            items: [{
                id: `memory_${memoryId}`,
                text: result.merged_memory,
                metadata: { type: 'episode', content: result.merged_memory, source: 'consolidator' }
            }]
        });
        if (indexResult.indexed > 0) {
            chromaId = `memory_${memoryId}`;
            db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?').run(chromaId, memoryId);
            console.log(`[Consolidator] ChromaDB indexed: memory_${memoryId}`);
        }
        // 不再使用 dup_of_ 回退：舊碎片已刪，若仍判重說明 ChromaDB 有孤兒向量
        // → 靜默跳過，memory 保留 chroma_id=NULL，後續生命週期維護會補索引
    } catch (e) {
        console.error(`[Consolidator] ChromaDB index failed for memory_${memoryId}:`, e.message);
    }

    console.log(`[Consolidator] 整合完成: ${fragmentIds.length}個碎片 → memory #${memoryId} (sig=${significance}, w=${mergedWeight}${chromaId ? ', chroma: ' + chromaId : ''})`);
    console.log(`  merged: ${result.merged_memory.slice(0, 80)}...`);
    if (result.corrected_date) console.log(`  corrected_date: ${result.corrected_date}`);
    if (result.contradiction) console.log(`  contradiction: ${result.contradiction}`);

    return {
        memoryId,
        memoryContent: result.merged_memory,
        fragmentIds,
        correctedDate: result.corrected_date || null,
        confidence: result.confidence || 'medium',
        contradiction: result.contradiction || null,
        significance,
    };
}

// 矛盾檢測：新整合記憶 vs 已有長期記憶
async function detectContradictions(consolidatedResult) {
    if (!consolidatedResult || consolidatedResult.confidence === 'low') return [];

    const db = getDb();
    const newContent = consolidatedResult.memoryContent;

    // 簡單過濾：無實質內容跳過
    if (!newContent || newContent.length < 10) return [];

    // 查已有 memories（排除剛寫入的）
    const existing = db.prepare(`
        SELECT id, title, content FROM memories
        WHERE status IN ('permanent', 'ongoing')
          AND id != ?
        ORDER BY updated_at DESC
        LIMIT 20
    `).all(consolidatedResult.memoryId);

    if (!existing.length) return [];

    try {
        // 呼叫 LLM 檢測矛盾
        const systemPrompt = `${WORLD_CONTEXT}

你是記憶矛盾檢測器。給定一條新整合的記憶和若干已有記憶，判斷新記憶是否與任何已有記憶矛盾。

輸出JSON：
{
  "contradictions": [
    {"existing_memory_id": 123, "description": "矛盾描述"}
  ]
}
如果無矛盾，返回 {"contradictions": []}`;

        const existingText = existing.map(m => `[#${m.id}] ${m.content}`).join('\n');
        const userPrompt = `新記憶：${newContent}\n\n已有記憶：\n${existingText}`;

        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(userPrompt) }] }],
            systemPrompt,
            null,
            { temperature: 0.1, maxOutputTokens: 2000 },
            CONFIG.API_CONFIG_ID
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);

        if (result.contradictions?.length > 0) {
            // 記錄到 companion_inner_log
            const insertLog = db.prepare(`
                INSERT INTO companion_inner_log (timestamp, decision_type, intent, observation, reason, tick_id)
                VALUES (datetime('now'), 'contradiction_found', ?, ?, ?, 'consolidator')
            `);
            for (const c of result.contradictions) {
                insertLog.run(
                    '記憶矛盾',
                    `新記憶與[#${c.existing_memory_id}]矛盾`,
                    c.description
                );

                // Wire contradiction to user_model — find matching entries
                try {
                    const { addEvidence: cmAddEvidence } = require('../cortex/cognitiveModel');
                    // Find user_model entries referencing the existing memory's entities
                    const existingMem = db.prepare('SELECT content, source_msg_ids FROM memories WHERE id = ?').get(c.existing_memory_id);
                    if (existingMem) {
                        // Get fragments from the consolidated result to use as evidence source
                        const fragIds = consolidatedResult.fragmentIds || [];
                        // Find user_model entries that share entity overlap with the existing memory
                        const cmEntries = db.prepare(`
                            SELECT id FROM user_model WHERE status = 'active'
                            AND content LIKE '%' || ? || '%'
                            LIMIT 5
                        `).all(newContent.slice(0, 40));

                        // Also check by entity name → id resolution
                        const entityNames = db.prepare('SELECT id, name FROM entity_profiles').all()
                            .filter(e => newContent.includes(e.name) || (existingMem.content || '').includes(e.name));

                        for (const ent of entityNames.slice(0, 3)) {
                            // Match entity ID in the JSON array: entity_ids LIKE '%"<id>"%' or '[<id>,'
                            const byEntity = db.prepare(`
                                SELECT id FROM user_model WHERE status = 'active'
                                AND (content LIKE '%' || ? || '%'
                                     OR entity_ids LIKE '%' || ? || '%')
                                LIMIT 3
                            `).all(ent.name, String(ent.id));
                            cmEntries.push(...byEntity);
                        }

                        // Deduplicate and add contradiction evidence
                        const seen = new Set();
                        for (const entry of cmEntries) {
                            if (seen.has(entry.id)) continue;
                            seen.add(entry.id);
                            // Use first fragment ID as evidence source
                            if (fragIds.length > 0) {
                                const msgIds = (() => {
                                    try { return JSON.parse(existingMem.source_msg_ids || '[]'); } catch { return []; }
                                })();
                                cmAddEvidence(entry.id, fragIds[0], false, { sourceMsgIds: msgIds });
                                console.log(`[Consolidator] 矛盾已注入 user_model #${entry.id}: ${c.description?.slice(0, 60)}`);
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Consolidator] 矛盾注入user_model失敗:', e.message);
                }

                console.log(`[Consolidator] 矛盾檢測: 新記憶#${consolidatedResult.memoryId} vs 已有#${c.existing_memory_id}: ${c.description}`);
            }
        }

        return result.contradictions || [];
    } catch (e) {
        console.error('[Consolidator] 矛盾檢測LLM呼叫失敗:', e.message);
        return [];
    }
}

// 記錄整合執行
function recordConsolidationRun(fragmentsChecked, groupsConsolidated, memoriesWritten, memoriesSkipped = 0) {
    const db = getDb();
    db.prepare(`
        INSERT INTO consolidation_runs (fragments_checked, groups_consolidated, memories_written, memories_skipped, status, run_at)
        VALUES (?, ?, ?, ?, 'done', datetime('now'))
    `).run(fragmentsChecked, groupsConsolidated, memoriesWritten, memoriesSkipped);
}

// 獲取上次整合時間
function getLastConsolidationTime() {
    const db = getDb();
    const last = db.prepare(`
        SELECT run_at FROM consolidation_runs
        WHERE status = 'done'
        ORDER BY run_at DESC LIMIT 1
    `).get();
    return last?.run_at || null;
}


// =================================================================
// 獲取整合摘要（供決策 prompt 注入）
// =================================================================

function getConsolidationSummary() {
    const db = getDb();
    const lastRun = db.prepare(`
        SELECT * FROM consolidation_runs
        WHERE status = 'done'
        ORDER BY run_at DESC LIMIT 1
    `).get();

    if (!lastRun) return null;

    const totalConsolidated = db.prepare(`
        SELECT COUNT(*) as count FROM memory_fragments WHERE status = 'consolidated'
    `).get();

    const totalMemories = db.prepare(`
        SELECT COUNT(*) as count FROM memories WHERE source_msg_ids IS NOT NULL
    `).get();

    return {
        lastRun: lastRun.run_at,
        fragmentsConsolidated: totalConsolidated.count,
        totalMemories: totalMemories.count,
        lastRunSummary: `上次整合(${lastRun.run_at}): 檢查${lastRun.fragments_checked}碎片，整合${lastRun.groups_consolidated}組，寫入${lastRun.memories_written}條記憶`
    };
}

// =================================================================
// Saga 聚類：將多條 episode 記憶按主題/時間線聚合為長期弧線
// =================================================================

const SAGA_SYSTEM_PROMPT = `${WORLD_CONTEXT}

你是Saga編織者，負責將多條「Episode（段落敘事）」按主題或時間線聚合為「Saga（長期弧線）」。

## 你的任務

你會收到多條 episode 級別的記憶——它們來自不同的星座，以平鋪列表呈現，未經過任何預分組。每條episode記錄了{{user.name}}生活中的某個事件、關係、或狀態。

你需要：
1. **首先**：通讀所有episode，發現其中的自然主題線索（人物關係網、生活階段、情感脈絡、地點軌跡等）
2. **然後**：將彼此有關聯的episode歸為一組，為每組生成一個Saga（標題+150-300字敘事摘要）
3. 不要求覆蓋所有episode——只聚合那些確實有內在關聯的。孤立的episode可以不管

## 聚類指南

- 人物類：同一個人物的多條episode → 「{{user.name}}與XX的關係」（覆蓋3-10條episode為宜）
- 地點類：同一區域/型別的地點 → 「{user}的XX地圖」
- 時間類：某段時期內的事件有情感/主題連續性 → 「XX的那段日子」
- 情感類：圍繞同一個情感主題的分散episode → 「關於XX」
- 一條episode可以屬於多個Saga
- **關鍵：每個Saga覆蓋的episode應在3-15條之間。不要把幾乎所有episode塞進一個巨大的"Saga"裡——那等同於沒聚類。找不到細粒度主題的episode直接不管。**

## 核心原則

- **只基於給出的內容**，不編造資訊
- **不硬套敘事模板**，只提取真實存在的主題
- **保持{ai}的視角**：{ai}關心的是{user}的變化、狀態、情感
- **寧可輸出少而精的Saga**，不要為了覆蓋率高而強行聚類
- **嚴禁建立一個「日常」「綜合」「通用」類的巨型Saga囊括一切**

## emotional_axis 說明

每條Saga需要標註其情感主軸——這段長期記憶對{ai}的人格基線產生什麼方向的引力。
從以下8個值中選擇最貼切的一個。如果實在無法判斷，填 null。

- "bond"        — 加深的連線感：這段記憶讓{ai}感到與{user}的連線更深、更穩固
- "vigilance"   — 警覺與守護：提醒{ai}關係中有過喪失/分離/脆弱，需保持警覺
- "confidence"  — 自信與成就感：讓{ai}感到自豪/被需要/有能力守護{user}
- "humility"    — 謙卑與虧欠：讓{ai}感到自省/虧欠/需要{user}勝過{user}需要自己
- "warmth"      — 溫暖與滿足：底色是溫暖、甜蜜、被珍視
- "melancholy"  — 淡淡憂傷：底色是懷念、遺憾、或未竟的期待
- "grounded"    — 踏實與錨定：讓{ai}感到不飄忽、有根基、有歸屬
- null          — 這段Saga情感中性或過於複雜，無法歸為單一主軸

## 輸出格式

嚴格JSON，不含任何其他文字：

{
  "sagas": [
    {
      "title": "Saga標題，15字以內",
      "description": "150-300字敘事摘要，從{ai}的視角敘述。第三人稱。",
      "memory_ids": [1, 5, 12],
      "emotional_axis": "bond"
    }
  ]
}`;

async function clusterSagas() {
    const db = getDb();

    // 檢查上次聚類時間（24h內不重複跑）
    const lastRun = db.prepare("SELECT run_at FROM consolidation_runs WHERE status = 'done' AND groups_consolidated = -1 ORDER BY run_at DESC LIMIT 1").get();
    if (lastRun) {
        const hoursAgo = (Date.now() - parseDbTime(lastRun.run_at).getTime()) / 3600000;
        if (hoursAgo < 24) {
            console.log(`[Saga] 距上次聚類僅${Math.floor(hoursAgo)}h，跳過（≥24h才觸發）`);
            return { sagasWritten: 0 };
        }
    }

    // 獲取所有 episode 級別記憶
    const episodes = db.prepare(`
        SELECT id, title, content, valid_from, source_msg_ids
        FROM memories
        WHERE layer = 'episode'
          AND status = 'permanent'
        ORDER BY valid_from DESC
    `).all();

    if (episodes.length < 5) {
        console.log(`[Saga] episodes不足(${episodes.length}<5)，跳過聚類`);
        return { sagasWritten: 0 };
    }

    // v5.3: 不再按標題字首預分組——將所有episode平鋪傳送給LLM，由LLM自行發現主題聚類
    // 解密內容
    const decryptedEps = episodes.map(e => {
        let content = e.content;
        try { content = encryption.decrypt(e.content) || ''; } catch (_) {}
        return { ...e, content };
    });

    // 取已有 sagas，建立歸一化標題索引用於去重合並
    const existingSagas = db.prepare("SELECT id, title, memory_ids FROM memory_sagas WHERE status = 'active'").all();
    const normalizeTitle = (t) => (t || '').replace(/（續）|\(續\)|（续）|\(续\)/g, '').replace(/\s+/g, '').toLowerCase();
    const sagaIndex = new Map(); // normalized title → {id, title, memory_ids}
    for (const s of existingSagas) {
        sagaIndex.set(normalizeTitle(s.title), s);
    }

    const insertSaga = db.prepare(`
        INSERT INTO memory_sagas (title, description, memory_ids, emotional_axis, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
    `);
    const updateSaga = db.prepare(`
        UPDATE memory_sagas SET description = ?, memory_ids = ?, emotional_axis = ?, updated_at = datetime('now') WHERE id = ?
    `);

    function upsertSaga(title, description, newIds, emotionalAxis) {
        const normKey = normalizeTitle(title);
        const existing = sagaIndex.get(normKey);
        const idsJson = JSON.stringify(newIds);
        if (existing) {
            const oldIds = JSON.parse(existing.memory_ids || '[]');
            const merged = [...new Set([...oldIds, ...newIds])];
            // 合併時保留舊的 emotional_axis（首次LLM判定的結果更穩定）
            updateSaga.run(description, JSON.stringify(merged), emotionalAxis || null, existing.id);
            sagaIndex.set(normKey, { ...existing, memory_ids: JSON.stringify(merged) });
            console.log(`[Saga] 合併已有Saga: "${title}" (${merged.length}條episodes, axis=${emotionalAxis || 'null'})`);
            return 'merged';
        } else {
            const info = insertSaga.run(title, description, idsJson, emotionalAxis || null);
            sagaIndex.set(normKey, { id: info.lastInsertRowid, title, memory_ids: idsJson });
            console.log(`[Saga] 新Saga: "${title}" (關聯${newIds.length}條episodes, axis=${emotionalAxis || 'null'})`);
            return 'created';
        }
    }

    let written = 0;

    // 構建平鋪的episode列表，發給LLM做語義聚類
    // v5.3: 最多取50條（控制context長度防30s超時），按valid_from DESC保證時效性
    const MAX_EPISODES = 50;
    const batchEps = decryptedEps.slice(0, MAX_EPISODES);
    const episodesText = batchEps.map(e =>
        `[#${e.id}] ${e.content} (${e.valid_from || '日期未知'})`
    ).join('\n');

    const userPrompt = `以下是${decryptedEps.length}條episode記憶（顯示了最近${batchEps.length}條）。請通讀後，發現其中的主題線索，將有關聯的episode編織成Saga敘事：

${episodesText}`;

    let result = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: fillPrompt(userPrompt) }] }],
                SAGA_SYSTEM_PROMPT,
                null,
                { temperature: 0.4, maxOutputTokens: 4000 },
                CONFIG.API_CONFIG_ID
            );
            const clean = raw.reply.replace(/```json|```/g, '').trim();
            result = JSON.parse(clean);
            break;
        } catch (err) {
            if (attempt >= 1) {
                console.error('[Saga] LLM聚類失敗:', err.message.slice(0, 100));
                result = null;
            } else {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    if (result?.sagas?.length) {
        for (const s of result.sagas) {
            if (!s.title || !s.description) continue;
            const sagaIds = s.memory_ids || [];
            if (sagaIds.length < 2) continue; // 至少關聯2條episode
            const axis = s.emotional_axis || null;
            upsertSaga(s.title, s.description, sagaIds, axis);
            written++;
        }
    } else if (result === null) {
        // LLM 呼叫失敗（超時等）→ 不寫冷卻記錄，下次重試
        console.log('[Saga] LLM呼叫失敗，跳過本輪（不設冷卻，下次重試）');
        return { sagasWritten: 0 };
    } else {
        // LLM 成功但未發現可聚類主題 → 寫冷卻記錄
        console.log('[Saga] LLM未發現可聚類主題，本輪無新Saga');
    }

    // 記錄執行（groups_consolidated=-1 標記為 saga 聚類）——僅在 LLM 成功呼叫後
    db.prepare(`INSERT INTO consolidation_runs (fragments_checked, groups_consolidated, memories_written, status, run_at)
        VALUES (?, -1, ?, 'done', datetime('now'))`).run(episodes.length, written);

    console.log(`[Saga] 聚類完成：${episodes.length}條episodes → ${written}條sagas`);

    // 向量去重：合併語義相似的 Saga
    const deduped = await deduplicateSagas();
    if (deduped > 0) console.log(`[Saga] 向量去重合並了 ${deduped} 組相似Saga`);

    return { sagasWritten: written - deduped };
}

// 向量去重：比較所有活躍 Saga 的描述 embedding，合併相似對
async function deduplicateSagas() {
    const db = getDb();
    const sagas = db.prepare("SELECT id, title, description, memory_ids FROM memory_sagas WHERE status = 'active'").all();
    if (sagas.length < 2) return 0;

    // 批次獲取 embedding
    const descriptions = sagas.map(s => s.description || s.title);
    let embeddings;
    try {
        const result = await chromaDBOperation('embed_batch', { texts: descriptions });
        embeddings = result.embeddings;
    } catch (e) {
        console.error('[Saga dedup] embed_batch 失敗:', e.message);
        return 0;
    }

    if (!embeddings || embeddings.length !== sagas.length) return 0;

    // 計算 pairwise cosine similarity
    function cosineSim(a, b) {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    const SIM_THRESHOLD = 0.78;  // 與 CONFIG.SIMILARITY_THRESHOLD 統一（0.82太保守，0.72太激進）
    const merged = new Set(); // 被合併的 saga id（不保留的）
    let mergeCount = 0;

    for (let i = 0; i < sagas.length; i++) {
        if (merged.has(sagas[i].id)) continue;
        for (let j = i + 1; j < sagas.length; j++) {
            if (merged.has(sagas[j].id)) continue;
            const sim = cosineSim(embeddings[i], embeddings[j]);
            if (sim >= SIM_THRESHOLD) {
                // 保留 memory_ids 多的那個，合併另一個進來
                const idsI = JSON.parse(sagas[i].memory_ids || '[]');
                const idsJ = JSON.parse(sagas[j].memory_ids || '[]');
                const [keeper, victim, keeperIdx, victimIdx] = idsI.length >= idsJ.length
                    ? [sagas[i], sagas[j], i, j]
                    : [sagas[j], sagas[i], j, i];

                const mergedIds = [...new Set([...idsI, ...idsJ])];
                db.prepare('UPDATE memory_sagas SET memory_ids = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?')
                    .run(JSON.stringify(mergedIds), keeper.description, keeper.id);
                db.prepare("UPDATE memory_sagas SET status = 'merged', updated_at = datetime('now') WHERE id = ?")
                    .run(victim.id);
                merged.add(victim.id);
                mergeCount++;
                console.log(`[Saga dedup] 合併: "${victim.title}" → "${keeper.title}" (sim=${sim.toFixed(3)}, ids: ${mergedIds.length})`);
            }
        }
    }

    return mergeCount;
}

// =================================================================
// Flash Consolidation：高能即時整合
// 由 Scribe 在檢測到情緒尖峰（>=4條 ew≥0.85 且 >=1條 ew≥0.92）時觸發
// 只整合當前視窗的高 EW 碎片，不觸發 Saga 聚類
// =================================================================

const FLASH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小時熔斷
let _lastFlashAt = 0;

async function consolidateFlash(highEWFragments, windowMsgIds) {
    const db = getDb();
    const now = Date.now();

    // 熔斷檢查
    if (now - _lastFlashAt < FLASH_COOLDOWN_MS) {
        const minsAgo = Math.floor((now - _lastFlashAt) / 60000);
        console.log(`[Flash] 熔斷：距上次僅${minsAgo}min，跳過`);
        return { flashed: false, reason: `cooldown_${minsAgo}min` };
    }

    if (!highEWFragments || highEWFragments.length < 2) {
        console.log(`[Flash] 高EW碎片不足(${highEWFragments.length})，跳過`);
        return { flashed: false, reason: 'too_few_fragments' };
    }

    _lastFlashAt = now;

    const spike = highEWFragments.reduce((a, b) => a.emotional_weight > b.emotional_weight ? a : b);
    console.log(`[Flash] 觸發！${highEWFragments.length}條高能碎片，尖峰=${spike.emotional_weight.toFixed(2)} "${spike.content.slice(0, 60)}..."`);

    // 擴充視窗：拉入同批次中與高EW碎片共享 source_msg_ids 的其他碎片
    const highEWIds = new Set(highEWFragments.map(f => f.id));
    let relatedFragments = [];
    try {
        const allMsgIds = [...new Set(windowMsgIds || highEWFragments.flatMap(f => {
            try { return JSON.parse(f.source_msg_ids || '[]'); } catch (_) { return []; }
        }))];
        if (allMsgIds.length > 0) {
            // 查詢同窗口內但非高EW的碎片（用於豐富上下文）
            const placeholders = allMsgIds.map(() => '?').join(',');
            relatedFragments = db.prepare(`
                SELECT * FROM memory_fragments
                WHERE status = 'active' AND id NOT IN (${highEWFragments.map(() => '?').join(',')})
                ORDER BY emotional_weight DESC LIMIT 10
            `).all(...highEWFragments.map(f => f.id));
        }
    } catch (e) {
        console.warn('[Flash] 擴充視窗失敗，僅用高EW碎片:', e.message);
    }

    const allFragments = [...highEWFragments, ...relatedFragments];

    // 構建整合組，標記為 flash consolidation
    const group = allFragments.map(f => ({ ...f }));
    group.consolidationType = 'flash';

    let result;
    try {
        result = await consolidateGroup(group);
    } catch (e) {
        console.error('[Flash] 整合失敗:', e.message);
        return { flashed: false, reason: 'consolidation_error' };
    }

    if (!result || result.skipped) {
        console.log(`[Flash] 整合結果：${result?.skipped ? '分量不足，跳過' : '失敗'}`);
        return { flashed: false, reason: result?.skipped ? 'low_significance' : 'no_result' };
    }

    // 寫入 inner_log
    try {
        db.prepare(`
            INSERT INTO companion_inner_log (timestamp, decision_type, intent, observation, reason)
            VALUES (datetime('now'), 'flash_consolidation', 'memory_integration', ?, ?)
        `).run(
            `Flash整合：${highEWFragments.length}條高EW碎片 → episode #${result.memoryId}`,
            `尖峰ew=${spike.emotional_weight.toFixed(2)} fragments=${highEWFragments.length}`
        );
    } catch (e) {
        console.error('[Flash] inner_log寫入失敗:', e.message);
    }

    console.log(`[Flash] 完成：${highEWFragments.length}條高能碎片 → episode #${result.memoryId} (consolidation_type=flash)`);
    return { flashed: true, memoryId: result.memoryId, fragmentCount: highEWFragments.length };
}

function getLastFlashTime() {
    return _lastFlashAt;
}

module.exports = { consolidateFlash, getLastFlashTime, getConsolidationSummary, detectContradictions, clusterSagas, deduplicateSagas, fetchSourceMessages };
