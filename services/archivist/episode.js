// =================================================================
// services/archivist/episode.js — Episode：寫入質檢與按類別合併碎片為 episode
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { sealField } = require('../memoryCrypto');
const { callLLM } = require('../llm');
const { chromaDBOperation } = require('../memory');
const { WORLD_CONTEXT } = require('../worldContext');
const { USER, AI } = require('../memoryConfig');
const { ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { agentState, _canCallLLM } = require('./runtime');
const { buildLandscapeIndex } = require('./shared');


// ═══════════════════════════════════════════════════════
// v4.8: auditNewEpisodes — Episode 写入质检
//
// 新 episode（consolidateCategory 产出）追溯其 source_msg_ids 原始消息，
// LLM 判断片段忠实度。faithful=正常 / distorted=降权标记 / fabricated=归档。
// 每轮 ≤3 条。观星手记可见。
// ═══════════════════════════════════════════════════════

async function auditNewEpisodes() {
    const db = getDb();
    const { encryption } = require('../../encryption');

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

        // 最多读 5 条源消息做抽样验证
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

        const prompt = `下面的「记忆片段」是从聊天记录中自动整合生成的。请对比原始对话，判断这份总结是否忠实。

原始对话抽样：
${origTexts.slice(0, 2000)}

记忆片段：
${(ep.content || '').slice(0, 500)}

判断（三选一）：
- faithful: 总结准确反映了对话中的事实，无编造
- distorted: 有轻微偏差（日期/细节/人物混淆），但不至于完全错误
- fabricated: 编造了对话中不存在的事实或事件

只输出JSON: {"verdict":"faithful|distorted|fabricated","reason":"一句话"}`;

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
                console.log(`[Archivist] 📋 质检 distorted: ep#${ep.id} — ${(verdict.reason || '').slice(0, 60)}`);
            } else if (verdict.verdict === 'fabricated') {
                db.prepare("UPDATE memories SET status = 'archived', audit_status = 'fabricated' WHERE id = ?").run(ep.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('episode_audit', NULL, ?, 'done')`)
                    .run(JSON.stringify({ verdict: 'fabricated', reason: verdict.reason, episode_id: ep.id, snippet: (ep.content || '').slice(0, 60) }));
                console.log(`[Archivist] 🚨 质检 fabricated: ep#${ep.id} ⇒ archived — ${(verdict.reason || '').slice(0, 60)}`);
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

    // v5.3: 从 entity_profiles 星座读取（替代旧的 memory_ontology 知识树）
    // 跳过 用户/AI（碎片太多，每次取30条无法覆盖）和聚合实体
    const CONSOLIDATE_SKIP = [USER.name, AI.name, '音乐', '共读'];
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

你是星座记忆整合器。你看到的碎片都来自同一个记忆星座：
**星座名称**：${cat.path}（${cat.category || 'unknown'}）
**当前概述**：${cat.description || '无'}

## 你的任务

1. **审视所有碎片**，判断哪些碎片是"同一事件的多个侧面"（语义高度相关、讲的是同一个具体的事件或关系），将它们分组。
   - 注意：不是所有话题相同的就是同一事件——"妈妈做饭"和"妈妈打电话"虽然都涉及妈妈，但是两个独立事件
   - 只有真正讲述同一个具体事件的碎片才应该被合并
   - 每组至少3条碎片才值得合并

2. **对每个可合并的组**，将碎片合并为一条规范episode记忆（第三人称，不超过150字）。

## 分量判断 (significance)
- 8-10：情感转折、重大决定、深刻冲突、关系里程碑
- 5-7：有意义但非关键的事件、日常偏好变化
- 3-4：日常工作记录、routine操作 — 不值得长期保留
- 1-2：琐碎闲聊 — 应丢弃

## 输出格式

严格JSON，不含任何其他文字：
{
  "clusters": [
    {
      "fragment_indices": [0, 3, 7],
      "merged_memory": "第三人称规范记忆，150字以内",
      "corrected_date": "YYYY-MM-DD 或空字符串",
      "significance": 1-10,
      "confidence": "high/medium/low",
      "contradiction": null
    }
  ]
}`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: `${fragmentsBlock}\n\n请整合以上碎片。` }] }],
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
                    console.log(`[Archivist] 星座整合跳过(分量不足 sig=${sig}): ${cat.path}`);
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
                    const { chromaDBOperation } = require('../memory');
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

                // v5.12: 共享碎片实体同步 — 碎片可能同时链接到多个entity
                // （如"和朋友看某剧"链接到「某朋友」和「某剧名」）
                // 合并后的episode应两边都有，否则consumed类实体永远拿不到叙事弧线
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
                    console.log(`[Archivist] 星座整合 [${shared.name}(${shared.category})]: 共享episode #${sharedInfo.lastInsertRowid} (${shared.shared_count}/${mergedIds.length}个共享碎片, from ${cat.path})`);
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

            // 概述更新已移除——统一由 regenerateEntityOverviews 负责
            // consolidateCategory 本职是碎片→叙事记忆合并，不应兼职写概述

            // v5.3: entity_profiles doesn't have centroid_embedding — skip centroid refresh
            // Fragment counts will be refreshed naturally on next classification cycle

        } catch (e) {
            console.error(`[Archivist] consolidateCategory 失败 [${cat.path}]:`, e.message);
        }
    }

    // Trigger downstream: Entity Profile + Saga Weaver
    if (episodesWritten > 0) {
        try {
            const { updateEntityProfiles } = require('../entityProfile');
            await updateEntityProfiles(newEpisodes).catch(e =>
                console.error('[Archivist] 实体档案更新失败:', e.message)
            );
        } catch (_) {}

        // v5.3: Saga trigger kept for immediate effect, but clusterSagas is ALSO independently
        // schedulable in GARDEN_TASKS. This dual-trigger ensures sagas update promptly
        // when new episodes arrive, while the garden plan covers periodic full-clustering.
        try {
            const episodeCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE layer='episode' AND status='permanent'").get();
            if (episodeCount.c >= 5) {
                const { clusterSagas } = require('../consolidator');
                console.log(`[Archivist] episode已累积${episodeCount.c}条，触发Saga聚类...`);
                await clusterSagas().catch(e =>
                    console.error('[Archivist] Saga聚类失败:', e.message)
                );
            }
        } catch (_) {}
    }

    console.log(`[Archivist] 星座整合完成: ${categoriesProcessed}个星座 → ${episodesWritten}条episode`);
    return { categories: categoriesProcessed, episodes: episodesWritten };
}

module.exports = {
    auditNewEpisodes,
    CATEGORY_CONSOLIDATE_MIN_FRAGS,
    CATEGORY_CONSOLIDATE_MAX_CATS,
    CATEGORY_CONSOLIDATE_MAX_FRAGS,
    consolidateCategory,
};
