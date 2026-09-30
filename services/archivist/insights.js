// =================================================================
// services/archivist/insights.js — 碎片洞察提取
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { WORLD_CONTEXT } = require('../worldContext');
const { ARCHIVIST_VERIFY_CONFIG_ID, INSIGHT_BATCH_MAX } = require('./constants');


// ═══════════════════════════════════════════════════════
// Tool: extractFragmentInsights
// ═══════════════════════════════════════════════════════

async function extractFragmentInsights(batchSize = INSIGHT_BATCH_MAX) {
    const db = getDb();

    const fragments = db.prepare(`
        SELECT mf.id, mf.content, mf.entity_id, mf.entity
        FROM memory_fragments mf
        WHERE mf.insight IS NULL
          AND mf.status = 'active'
          AND mf.content IS NOT NULL
          AND mem_len('memory_fragments:content', mf.content) > 10
        ORDER BY mf.created_at DESC
        LIMIT ?
    `).all(batchSize);

    if (fragments.length === 0) return { extracted: 0 };

    const entityIds = [...new Set(fragments.filter(f => f.entity_id).map(f => f.entity_id))];
    const entityMap = new Map();
    if (entityIds.length > 0) {
        const profiles = db.prepare(`
            SELECT id, name, relationship_to_user, emotional_significance
            FROM entity_profiles WHERE id IN (${entityIds.map(() => '?').join(',')})
        `).all(...entityIds);
        for (const p of profiles) entityMap.set(p.id, p);
    }

    let entityContext = '';
    for (const [id, ep] of entityMap) {
        if (ep.relationship_to_user) {
            entityContext += `- ${ep.name}: ${ep.relationship_to_user}`;
            if (ep.emotional_significance) entityContext += ` (${ep.emotional_significance})`;
            entityContext += '\n';
        }
    }

    const fragmentList = fragments.map((f, i) => {
        const ep = f.entity_id ? entityMap.get(f.entity_id) : null;
        const entityNote = ep && ep.relationship_to_user
            ? ` [已知關係: ${ep.name} — ${ep.relationship_to_user}]`
            : (f.entity ? ` [涉及: ${f.entity}]` : '');
        return `[${i}] ${f.content}${entityNote}`;
    }).join('\n\n');

    const prompt = `${WORLD_CONTEXT}
${entityContext ? '## 人物關係參考\n' + entityContext + '\n' : ''}
你是User的個人認知提取器。閱讀以下記憶碎片，提取每條碎片**揭示了User的什麼個人特質/價值觀/行為模式/情感傾向**。

## 碎片

${fragmentList}

## 任務

對每條碎片，用第三人稱一句話概括它揭示了User的什麼（性格側面 / 情感模式 / 價值取向 / 行為規律）。
- 如果碎片只是純事實記錄（如"今天吃了大餐"）沒有揭示個人特質，輸出 null
- 不要重複碎片內容本身，要提取它**暗示的更深層的東西**
- 句子要有溫度，像是在理解一個人而不是分析資料

## 輸出格式

只輸出一個JSON陣列，不要markdown包裹（下面內容是虛構的，只演示格式）：
[{"index":0,"insight":"User在疲憊時會用一個固定的小習慣給自己緩衝，那對User而言是恢復的方式"},{"index":2,"insight":"User對某類事物有一套自己的取捨標準，平時很少明說但一直在按它選","dimension":"emotional"},{"index":3,"insight":null}]`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.2, maxOutputTokens: Math.max(800, batchSize * 50) },
            ARCHIVIST_VERIFY_CONFIG_ID
        );

        let text = (response?.reply || '').replace(/```json|```/g, '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
            console.error('[Archivist] insight 提取: LLM返回非JSON陣列');
            return { extracted: 0 };
        }

        const results = JSON.parse(match[0]);
        const updateStmt = db.prepare('UPDATE memory_fragments SET insight = ? WHERE id = ?');

        let extracted = 0;
        for (const r of results) {
            if (r.insight && r.insight !== 'null' && fragments[r.index]) {
                updateStmt.run(r.insight, fragments[r.index].id);
                extracted++;
            }
        }

        console.log(`[Archivist] insight 提取: ${extracted}/${fragments.length} 條`);
        return { extracted };
    } catch (e) {
        console.error('[Archivist] insight 提取失敗:', e.message);
        return { extracted: 0 };
    }
}

module.exports = {
    extractFragmentInsights,
};
