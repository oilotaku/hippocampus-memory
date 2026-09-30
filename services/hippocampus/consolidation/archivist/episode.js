// =================================================================
// services/archivist/episode.js — Episode：寫入質檢與按類別合併碎片為 episode
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { sealField } = require('../../../memoryCrypto');
const { callLLM } = require('../../../llm');
const { chromaDBOperation } = require('../../ca3/memory');
const { WORLD_CONTEXT } = require('../../../worldContext');
const { USER, AI } = require('../../../memoryConfig');
const { ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { agentState, _canCallLLM } = require('./runtime');
const { buildLandscapeIndex } = require('./shared');


// ═══════════════════════════════════════════════════════
// v4.8: auditNewEpisodes — Episode 寫入質檢
//
// 新 episode（consolidateCategory 產出）追溯其 source_msg_ids 原始訊息，
// LLM 判斷片段忠實度。faithful=正常 / distorted=降權標記 / fabricated=歸檔。
// 每輪 ≤3 條。觀星手記可見。
// ═══════════════════════════════════════════════════════

async function auditNewEpisodes() {
    const db = getDb();
    const { encryption } = require('../../../../encryption');

    const episodes = db.prepare(`
        SELECT id, content, source_msg_ids, created_at FROM memories
        WHERE layer = 'episode' AND consolidation_type = 'standard'
          AND (audit_status IS NULL OR audit_status = '')
        ORDER BY created_at DESC LIMIT 3
    `).all();
    if (episodes.length === 0) return { audited: 0 };

    if (!_canCallLLM(1)) return { audited: 0 };

    const markAudit = db.prepare(`UPDATE memories SET audit_status = ? WHERE id = ?`);

    for (const ep of episodes) {
        let sourceIds = [];
        try { sourceIds = JSON.parse(ep.source_msg_ids || '[]'); } catch (_) {}
        if (sourceIds.length === 0) { markAudit.run('skipped_no_sources', ep.id); continue; }

        // 最多讀 5 條源訊息做抽樣驗證
        const msgIds = sourceIds.slice(0, 5);
        const placeholders = msgIds.map(() => '?').join(',');
        const messages = db.prepare(`
            SELECT id, sender, content FROM messages WHERE id IN (${placeholders})
        `).all(...msgIds);

        const origTexts = messages.map(m => {
            let text = m.content || '';
            if (text.startsWith('enc:')) {
                try { text = encryption.decrypt(text, { silent: true }) || ''; } catch (_) { text = ''; }
            }
            try { const j = JSON.parse(text); text = (j.components || []).filter(c => c.type === 'text').map(c => c.content || c.text || '').join(' '); } catch (_) {}
            return `[${m.sender}] ${text.slice(0, 150)}`;
        }).join('\n');

        if (!origTexts.trim()) { markAudit.run('skipped_empty_msgs', ep.id); continue; }

        const prompt = `下面的「記憶片段」是從聊天記錄中自動整合生成的。請對比原始對話，判斷這份總結是否忠實。

原始對話抽樣：
${origTexts.slice(0, 2000)}

記憶片段：
${(ep.content || '').slice(0, 500)}

判斷（三選一）：
- faithful: 總結準確反映了對話中的事實，無編造
- distorted: 有輕微偏差（日期/細節/人物混淆），但不至於完全錯誤
- fabricated: 編造了對話中不存在的事實或事件

只輸出JSON: {"verdict":"faithful|distorted|fabricated","reason":"一句話"}`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.1, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const verdict = JSON.parse(jsonMatch[0]);

            if (verdict.verdict === 'distorted') {
                db.prepare('UPDATE memories SET weight = MAX(1, weight * 0.5), audit_status = ? WHERE id = ?').run('distorted', ep.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('episode_audit', NULL, ?, 'done')`)
                    .run(JSON.stringify({ verdict: 'distorted', reason: verdict.reason, episode_id: ep.id, snippet: (ep.content || '').slice(0, 60) }));
                console.log(`[Archivist] 📋 質檢 distorted: ep#${ep.id} — ${(verdict.reason || '').slice(0, 60)}`);
            } else if (verdict.verdict === 'fabricated') {
                db.prepare("UPDATE memories SET status = 'archived', audit_status = 'fabricated' WHERE id = ?").run(ep.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('episode_audit', NULL, ?, 'done')`)
                    .run(JSON.stringify({ verdict: 'fabricated', reason: verdict.reason, episode_id: ep.id, snippet: (ep.content || '').slice(0, 60) }));
                console.log(`[Archivist] 🚨 質檢 fabricated: ep#${ep.id} ⇒ archived — ${(verdict.reason || '').slice(0, 60)}`);
            } else {
                markAudit.run('faithful', ep.id);
            }
        } catch (e) {
            console.error('[Archivist] episode audit LLM fail:', e.message);
        }
    }
    return { audited: episodes.length };
}


// ═══════════════════════════════════════════════════════
// Tool: consolidateCategory
//
// Deep cycle task: select dense leaf categories, merge related
// fragments within each category into episodes. Unlike the old
// Consolidator (blind ChromaDB clustering), this uses the knowledge
// tree structure — fragments already in the same category share a
// semantic context, so LLM merges are more precise.
//
// Each category gets one LLM call that simultaneously:
//   1. Identifies mergeable fragment groups (≥3 related fragments)
//   2. Merges each group into an episode → memories table
//   3. Updates the category description if new facts emerged
// ═══════════════════════════════════════════════════════

const CATEGORY_CONSOLIDATE_MIN_FRAGS = 15;   // min fragment_count to consider

const CATEGORY_CONSOLIDATE_MAX_CATS = 5;     // max categories per run


const CATEGORY_CONSOLIDATE_MAX_FRAGS = 30;   // max fragments to fetch per category


async function consolidateCategory() {
    const db = getDb();

    // v5.3: 從 entity_profiles 星座讀取（替代舊的 memory_ontology 知識樹）
    // 跳過 使用者/AI（碎片太多，每次取30條無法覆蓋）和聚合實體
    const CONSOLIDATE_SKIP = [USER.name, AI.name, '音樂', '共讀', '音乐', '共读'];
    const CONSOLIDATE_SKIP_PH = CONSOLIDATE_SKIP.map(() => '?').join(',');

    const candidates = db.prepare(`
        SELECT ep.id, ep.name as path, ep.name as label, ep.facts as description, ep.fragment_count,
               ep.category,
               (SELECT COUNT(*) FROM memory_fragments mf
                JOIN fragment_entities fe ON fe.fragment_id = mf.id
                WHERE fe.entity_id = ep.id AND mf.status = 'active') as active_count
        FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND ep.fragment_count >= ?
          AND ep.name NOT IN (${CONSOLIDATE_SKIP_PH})
        ORDER BY ep.fragment_count DESC
        LIMIT ?
    `).all(CATEGORY_CONSOLIDATE_MIN_FRAGS, ...CONSOLIDATE_SKIP, CATEGORY_CONSOLIDATE_MAX_CATS);

    if (candidates.length === 0) return { categories: 0, episodes: 0 };

    let categoriesProcessed = 0;
    let episodesWritten = 0;
    const newEpisodes = [];  // for Entity Profile trigger

    for (const cat of candidates) {
        if (cat.active_count < 3) continue; // need at least 3 active fragments

        categoriesProcessed++;

        // Fetch active fragments linked to this constellation
        const fragments = db.prepare(`
            SELECT mf.id, mf.content, mf.emotional_weight, mf.source, mf.source_date,
                   mf.source_msg_ids, mf.entity, mf.created_at
            FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status = 'active'
            ORDER BY mf.created_at DESC
            LIMIT ?
        `).all(cat.id, CATEGORY_CONSOLIDATE_MAX_FRAGS);

        if (fragments.length < 3) continue;

        // Build prompt
        const fragmentsBlock = fragments.map((f, i) => {
            const ew = (f.emotional_weight || 0).toFixed(2);
            const src = f.source || 'chat';
            return `[${i}] src=${src} date=${f.source_date || '?'} ew=${ew}\n  ${f.content}`;
        }).join('\n\n');

        const prompt = `${WORLD_CONTEXT}

${buildLandscapeIndex()}

你是星座記憶整合器。你看到的碎片都來自同一個記憶星座：
**星座名稱**：${cat.path}（${cat.category || 'unknown'}）
**當前概述**：${cat.description || '無'}

## 你的任務

1. **審視所有碎片**，判斷哪些碎片是"同一事件的多個側面"（語義高度相關、講的是同一個具體的事件或關係），將它們分組。
   - 注意：不是所有話題相同的就是同一事件——"媽媽做飯"和"媽媽打電話"雖然都涉及媽媽，但是兩個獨立事件
   - 只有真正講述同一個具體事件的碎片才應該被合併
   - 每組至少3條碎片才值得合併

2. **對每個可合併的組**，將碎片合併為一條規範episode記憶（第三人稱，不超過150字）。

## 分量判斷 (significance)
- 8-10：情感轉折、重大決定、深刻衝突、關係里程碑
- 5-7：有意義但非關鍵的事件、日常偏好變化
- 3-4：日常工作記錄、routine操作 — 不值得長期保留
- 1-2：瑣碎閒聊 — 應丟棄

## 輸出格式

嚴格JSON，不含任何其他文字：
{
  "clusters": [
    {
      "fragment_indices": [0, 3, 7],
      "merged_memory": "第三人稱規範記憶，150字以內",
      "corrected_date": "YYYY-MM-DD 或空字串",
      "significance": 1-10,
      "confidence": "high/medium/low",
      "contradiction": null
    }
  ]
}`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: `${fragmentsBlock}\n\n請整合以上碎片。` }] }],
                prompt,
                null,
                { temperature: 0.3, maxOutputTokens: 4000 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            let text = response?.reply || '';
            text = text.replace(/```json|```/g, '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                console.error(`[Archivist] consolidateCategory 返回非JSON: ${cat.path}`);
                continue;
            }

            const result = JSON.parse(match[0]);
            const clusters = result.clusters || [];

            // Process each mergeable cluster
            for (const cluster of clusters) {
                const indices = cluster.fragment_indices || [];
                if (indices.length < 3) continue;
                if (!cluster.merged_memory) continue;

                const sig = typeof cluster.significance === 'number' ? cluster.significance : 5;
                if (sig < 4) {
                    console.log(`[Archivist] 星座整合跳過(分量不足 sig=${sig}): ${cat.path}`);
                    continue;
                }

                // Collect merged fragment IDs
                const mergedIds = [];
                for (const idx of indices) {
                    if (fragments[idx]) mergedIds.push(fragments[idx].id);
                }
                if (mergedIds.length < 3) continue;

                // Collect source_msg_ids
                const allMsgIds = new Set();
                for (const idx of indices) {
                    const f = fragments[idx];
                    if (!f) continue;
                    try {
                        const ids = JSON.parse(f.source_msg_ids || '[]');
                        for (const mid of ids) allMsgIds.add(mid);
                    } catch (_) {}
                }

                // Average emotional weight
                const avgEW = indices.reduce((s, i) => s + (fragments[i]?.emotional_weight || 0.5), 0) / indices.length;
                const mergedWeight = Math.min(10, Math.round(sig * 0.7 + (5 + avgEW * 3) * 0.3));

                const finalDate = cluster.corrected_date || fragments[indices[0]]?.source_date || '';

                // Write to memories table
                const title = cluster.merged_memory.slice(0, 50);
                const insert = db.prepare(`
                    INSERT INTO memories (title, content, weight, valid_from, status, source_msg_ids, entity_id, layer, consolidation_type, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'permanent', ?, ?, 'episode', 'standard', datetime('now'), datetime('now'))
                `);
                const info = insert.run(
                    sealField('memories', 'title', title),
                    sealField('memories', 'content', cluster.merged_memory),
                    mergedWeight,
                    finalDate,
                    JSON.stringify([...allMsgIds]),
                    cat.id
                );
                const memoryId = info.lastInsertRowid;

                // Index to ChromaDB (v5.3: re-enabled for Librarian retrieval)
                try {
                    const { chromaDBOperation } = require('../../ca3/memory');
                    const idxResult = await chromaDBOperation('index_batch', {
                        items: [{ id: `memory_${memoryId}`, text: cluster.merged_memory, metadata: { source: 'archivist_consolidate', entity_id: cat.id } }]
                    });
                    const chromaId = idxResult.indexed > 0 ? `memory_${memoryId}`
                        : (idxResult.duplicates?.length > 0 ? `dup_of_${idxResult.duplicates[0].existing_id}` : null);
                    if (chromaId) {
                        db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?').run(chromaId, memoryId);
                    }
                } catch (e) {
                    console.error(`[Archivist] consolidateCategory ChromaDB index failed:`, e.message);
                }

                // v5.12: 共享碎片實體同步 — 碎片可能同時連結到多個entity
                // （如"和朋友看某劇"連結到「某朋友」和「某劇名」）
                // 合併後的episode應兩邊都有，否則consumed類實體永遠拿不到敘事弧線
                const sharedEntities = db.prepare(`
                    SELECT fe.entity_id, ep.name, ep.category, COUNT(*) as shared_count
                    FROM fragment_entities fe
                    JOIN entity_profiles ep ON ep.id = fe.entity_id
                    WHERE fe.fragment_id IN (${mergedIds.map(() => '?').join(',')})
                      AND fe.entity_id != ?
                    GROUP BY fe.entity_id
                    HAVING shared_count >= 3
                `).all(...mergedIds, cat.id);

                for (const shared of sharedEntities) {
                    const sharedInfo = insert.run(
                        title,
                        cluster.merged_memory,
                        mergedWeight,
                        finalDate,
                        JSON.stringify([...allMsgIds]),
                        shared.entity_id
                    );
                    console.log(`[Archivist] 星座整合 [${shared.name}(${shared.category})]: 共享episode #${sharedInfo.lastInsertRowid} (${shared.shared_count}/${mergedIds.length}個共享碎片, from ${cat.path})`);
                    newEpisodes.push({
                        memoryId: sharedInfo.lastInsertRowid,
                        memoryContent: cluster.merged_memory,
                        fragmentIds: mergedIds,
                        correctedDate: cluster.corrected_date || null,
                        confidence: cluster.confidence || 'medium',
                        contradiction: cluster.contradiction || null,
                        significance: sig,
                        entityId: shared.entity_id,
                        entityName: shared.name,
                    });
                }

                // Mark fragments as consolidated
                const markStmt = db.prepare('UPDATE memory_fragments SET status = ? WHERE id = ?');
                for (const fid of mergedIds) {
                    markStmt.run('consolidated', fid);
                }

                episodesWritten++;
                newEpisodes.push({
                    memoryId,
                    memoryContent: cluster.merged_memory,
                    fragmentIds: mergedIds,
                    correctedDate: cluster.corrected_date || null,
                    confidence: cluster.confidence || 'medium',
                    contradiction: cluster.contradiction || null,
                    significance: sig,
                    entityId: cat.id,
                    entityName: cat.path,
                });

                console.log(`[Archivist] 星座整合 [${cat.path}]: ${mergedIds.length}碎片 → episode #${memoryId} (sig=${sig})`);
            }

            // 概述更新已移除——統一由 regenerateEntityOverviews 負責
            // consolidateCategory 本職是碎片→敘事記憶合併，不應兼職寫概述

            // v5.3: entity_profiles doesn't have centroid_embedding — skip centroid refresh
            // Fragment counts will be refreshed naturally on next classification cycle

        } catch (e) {
            console.error(`[Archivist] consolidateCategory 失敗 [${cat.path}]:`, e.message);
        }
    }

    // Trigger downstream: Entity Profile + Saga Weaver
    if (episodesWritten > 0) {
        try {
            const { updateEntityProfiles } = require('../../cortex/entityProfile');
            await updateEntityProfiles(newEpisodes).catch(e =>
                console.error('[Archivist] 實體檔案更新失敗:', e.message)
            );
        } catch (_) {}

        // v5.3: Saga trigger kept for immediate effect, but clusterSagas is ALSO independently
        // schedulable in GARDEN_TASKS. This dual-trigger ensures sagas update promptly
        // when new episodes arrive, while the garden plan covers periodic full-clustering.
        try {
            const episodeCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE layer='episode' AND status='permanent'").get();
            if (episodeCount.c >= 5) {
                const { clusterSagas } = require('../consolidator');
                console.log(`[Archivist] episode已累積${episodeCount.c}條，觸發Saga聚類...`);
                await clusterSagas().catch(e =>
                    console.error('[Archivist] Saga聚類失敗:', e.message)
                );
            }
        } catch (_) {}
    }

    console.log(`[Archivist] 星座整合完成: ${categoriesProcessed}個星座 → ${episodesWritten}條episode`);
    return { categories: categoriesProcessed, episodes: episodesWritten };
}

module.exports = {
    auditNewEpisodes,
    CATEGORY_CONSOLIDATE_MIN_FRAGS,
    CATEGORY_CONSOLIDATE_MAX_CATS,
    CATEGORY_CONSOLIDATE_MAX_FRAGS,
    consolidateCategory,
};
