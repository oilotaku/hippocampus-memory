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
            ? ` [已知关系: ${ep.name} — ${ep.relationship_to_user}]`
            : (f.entity ? ` [涉及: ${f.entity}]` : '');
        return `[${i}] ${f.content}${entityNote}`;
    }).join('\n\n');

    const prompt = `${WORLD_CONTEXT}
${entityContext ? '## 人物关系参考\n' + entityContext + '\n' : ''}
你是User的个人认知提取器。阅读以下记忆碎片，提取每条碎片**揭示了User的什么个人特质/价值观/行为模式/情感倾向**。

## 碎片

${fragmentList}

## 任务

对每条碎片，用第三人称一句话概括它揭示了User的什么（性格侧面 / 情感模式 / 价值取向 / 行为规律）。
- 如果碎片只是纯事实记录（如"今天吃了大餐"）没有揭示个人特质，输出 null
- 不要重复碎片内容本身，要提取它**暗示的更深层的东西**
- 句子要有温度，像是在理解一个人而不是分析数据

## 输出格式

只输出一个JSON数组，不要markdown包裹（下面内容是虚构的，只演示格式）：
[{"index":0,"insight":"User在疲惫时会用一个固定的小习惯给自己缓冲，那对User而言是恢复的方式"},{"index":2,"insight":"User对某类事物有一套自己的取舍标准，平时很少明说但一直在按它选","dimension":"emotional"},{"index":3,"insight":null}]`;

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
            console.error('[Archivist] insight 提取: LLM返回非JSON数组');
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

        console.log(`[Archivist] insight 提取: ${extracted}/${fragments.length} 条`);
        return { extracted };
    } catch (e) {
        console.error('[Archivist] insight 提取失败:', e.message);
        return { extracted: 0 };
    }
}

module.exports = {
    extractFragmentInsights,
};
