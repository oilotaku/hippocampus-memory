// =================================================================
// services/archivist/rematch.js — 種子回補：字面回補與語義回補
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { callLLM } = require('../../../llm');
const { WORLD_CONTEXT } = require('../../../worldContext');
const { SKIP_NAMES } = require('../../../memoryConfig');
const { SKIP_PH, ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { agentState, _canCallLLM } = require('./runtime');


// ═══════════════════════════════════════════════════════
// v4.7: rematchFragmentsForSeeds — 回補漏判碎片
//
// The batch classifier misses ~74% of potential matches because
// output space limits prevent exhaustive assignment. This runs a
// targeted pass: for each seed, gather fragments that literally
// mention its name but aren't linked, ask LLM yes/no per fragment.
// ═══════════════════════════════════════════════════════

async function rematchFragmentsForSeeds() {
    const db = getDb();

    // Find seeds where fragment_count < actual mentions in fragments
    // Exclude music/book fragments (data exhaust, excluded from entity classification)
    const seeds = db.prepare(`
        SELECT * FROM (
            SELECT ep.id, ep.name, ep.category, ep.fragment_count,
                (SELECT COUNT(*) FROM memory_fragments mf
                 WHERE mem_like('memory_fragments:content', mf.content, '%' || ep.name || '%')
                   AND mf.status = 'active'
                   AND mf.source NOT IN ('music', 'book')
                   AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ep.id)
                ) as unlinked
            FROM entity_profiles ep
            WHERE ep.status IN ('seed', 'active')
              AND ep.name NOT IN (${SKIP_PH})
              AND ep.category NOT LIKE '%aggregate%'
        )
        WHERE unlinked > 0
        ORDER BY unlinked DESC
        LIMIT 100
    `).all(...SKIP_NAMES);

    if (seeds.length === 0) {
        console.log('[Archivist] 回補: 沒有需要補分的種子');
        return { rematched: 0 };
    }

    console.log(`[Archivist] 回補: ${seeds.length} 個種子有漏判碎片`);

    // Process seeds in batches of 8 to keep prompt manageable
    const BATCH_SIZE = 8;
    let totalRematched = 0;

    for (let i = 0; i < seeds.length; i += BATCH_SIZE) {
        const batch = seeds.slice(i, i + BATCH_SIZE);

        // Gather unlinked fragments for each seed (max 15 per seed to limit prompt size)
        const seedFragments = [];
        for (const s of batch) {
            const frags = db.prepare(`
                SELECT id, content, created_at FROM memory_fragments
                WHERE mem_like('memory_fragments:content', content, ?) AND status = 'active'
                  AND source NOT IN ('music', 'book')
                  AND id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                ORDER BY created_at DESC
                LIMIT 15
            `).all('%' + s.name + '%', s.id);

            if (frags.length > 0) {
                seedFragments.push({ seed: s, frags });
            }
        }

        if (seedFragments.length === 0) continue;

        // Build prompt
        let prompt = '回補漏判碎片。對每個種子 + 它的候選碎片，判斷是否屬於該種子。\\n\\n';
        for (const { seed, frags } of seedFragments) {
            prompt += `種子: ${seed.name}[id=${seed.id},${seed.category}] 當前⭐${seed.fragment_count}\\n`;
            prompt += `候選碎片（文本中提到"${seed.name}"，判斷是否屬於該種子）:\\n`;
            for (const f of frags) {
                const text = (f.content || '').slice(0, 180).replace(/\\n/g, ' ');
                prompt += `  [frag_${f.id}] ${text}\\n`;
            }
            prompt += '\\n';
        }

        prompt += `對每條候選碎片判斷match:true/false。一條碎片可以同時match多個種子（如果文本中提到了多個）。不確定就match:false（寧漏勿錯）。\\n\\n只輸出JSON陣列:\\n[{"frag_id":101,"seed_id":1626,"match":true}, ...]`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT,
                null,
                { temperature: 0.1, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );

            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                console.error(`[Archivist] 回補 LLM響應無法解析: ${replyText.slice(0, 200)}`);
                continue;
            }

            const items = JSON.parse(jsonMatch[0]);
            const insertFe = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.60, ?)');
            const updateFc = db.prepare('UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?');

            let batchRematched = 0;
            const writeBatch = db.transaction(() => {
                for (const item of items) {
                    if (item.match === true && item.frag_id && item.seed_id) {
                        const r = insertFe.run(item.frag_id, item.seed_id, 'companion_rematch');
                        if (r.changes > 0) batchRematched++;
                    }
                }
                // Update fragment_counts for affected seeds
                const seedIds = [...new Set(items.filter(i => i.match).map(i => i.seed_id))];
                for (const sid of seedIds) {
                    updateFc.run(sid, sid);
                }
            });
            writeBatch();

            totalRematched += batchRematched;
            console.log(`[Archivist] 回補批次: ${batchRematched} 條匹配 (${seedFragments.map(s => s.seed.name).join(', ')})`);
        } catch (e) {
            console.error('[Archivist] 回補 LLM呼叫失敗:', e.message);
        }
    }

    console.log(`[Archivist] 回補完成: ${totalRematched} 條碎片歸位`);
    return { rematched: totalRematched };
}


// ═══════════════════════════════════════════════════════
// v4.8: semanticRematchForSeeds — 語義回補
//
// 字面 rematch 撈不到「去某地那次」「在某景點累癱了」這類
// 描述性提及（碎片不含實體名）。對小實體用 name+overview 做
// 向量檢索，候選送 flash 確認。地點/事件類實體的主要歸位通路。
// 僅深迴圈呼叫（ChromaDB 依賴，輕量模式禁入）。
// ═══════════════════════════════════════════════════════

const SEMANTIC_REMATCH_SIM_FLOOR = 0.40;   // 向量相似度門檻

const SEMANTIC_REMATCH_MAX_ENTITIES = 12;  // 每輪處理實體數（控制 LLM 用量）


async function semanticRematchForSeeds() {
    const db = getDb();
    const { searchMemoriesByVector } = require('../../ca3/memory');

    // 小實體優先：碎片少的星座最需要喂
    const targets = db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.overview, ep.fragment_count
        FROM entity_profiles ep
        WHERE ep.status IN ('seed', 'active')
          AND ep.name NOT IN (${SKIP_PH})
          AND ep.fragment_count < 5
        ORDER BY ep.fragment_count ASC, ep.updated_at DESC
        LIMIT ?
    `).all(...SKIP_NAMES, SEMANTIC_REMATCH_MAX_ENTITIES);

    if (targets.length === 0) return { rematched: 0 };

    const insertFe = db.prepare(`INSERT OR IGNORE INTO fragment_entities
        (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.55, 'semantic_rematch')`);
    const updateFc = db.prepare(`UPDATE entity_profiles SET fragment_count =
        (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?`);

    let total = 0;
    for (const ent of targets) {
        if (!_canCallLLM(1)) break;

        // 用實體名+概述做語義查詢，撈描述性提及
        const queryText = ent.overview ? `${ent.name}：${ent.overview.slice(0, 120)}` : ent.name;
        let hits;
        try {
            hits = await searchMemoriesByVector(queryText, 10);
        } catch (e) {
            console.error(`[Archivist] 語義回補向量查詢失敗 (${ent.name}):`, e.message);
            continue;
        }

        const linked = new Set(db.prepare('SELECT fragment_id FROM fragment_entities WHERE entity_id = ?')
            .all(ent.id).map(r => r.fragment_id));
        const candidates = (hits || []).filter(h =>
            h._table === 'memory_fragments' &&
            h._similarity >= SEMANTIC_REMATCH_SIM_FLOOR &&
            !linked.has(h.id)
        ).slice(0, 8);

        if (candidates.length === 0) continue;

        const fragLines = candidates.map(c =>
            `[frag_${c.id}] ${(c.content || '').slice(0, 180).replace(/\n/g, ' ')}`).join('\n');
        const prompt = `實體: ${ent.name} (${ent.category})${ent.overview ? '\n概述: ' + ent.overview.slice(0, 150) : ''}

以下碎片是語義檢索找到的候選（文本裡不一定出現"${ent.name}"，可能是間接提及，如"去某地那次"指代某地旅行）。
判斷每條是否確實在講這個實體。間接指代算 match。只是主題相似但講的不是它，不算。不確定就 false。

${fragLines}

只輸出JSON陣列: [{"frag_id":101,"match":true}, ...]`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT,
                null,
                { temperature: 0.1, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) continue;
            const items = JSON.parse(jsonMatch[0]);

            let matched = 0;
            const writeBatch = db.transaction(() => {
                for (const item of items) {
                    if (item.match === true && item.frag_id) {
                        const r = insertFe.run(item.frag_id, ent.id);
                        if (r.changes > 0) matched++;
                    }
                }
                if (matched > 0) updateFc.run(ent.id, ent.id);
            });
            writeBatch();
            if (matched > 0) {
                total += matched;
                console.log(`[Archivist] 🔭 語義回補: ${ent.name} +${matched} 顆星 (${ent.fragment_count}→${ent.fragment_count + matched})`);
            }
        } catch (e) {
            console.error(`[Archivist] 語義回補 LLM 失敗 (${ent.name}):`, e.message);
        }
    }

    if (total > 0) console.log(`[Archivist] 語義回補完成: ${total} 條碎片歸位`);
    return { rematched: total };
}

module.exports = {
    rematchFragmentsForSeeds,
    SEMANTIC_REMATCH_SIM_FLOOR,
    SEMANTIC_REMATCH_MAX_ENTITIES,
    semanticRematchForSeeds,
};
