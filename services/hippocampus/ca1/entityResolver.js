// =================================================================
// Entity Resolver（實體解析器）：自動繫結 fragment → entity
//
// 在 Scribe 寫入碎片後呼叫，四層管線：
//   1. 關鍵詞匹配：fragment 的 entity/content 含已知人名/別名 → 直接關聯
//   2. ★ 向量聯想：embed fragment → ChromaDB 查相似碎片 → 聚合已有 entity 關聯 →
//                候選實體投票
//   3. LLM 指代消解：結合候選實體列表 + 描述，做單選判斷（一條碎片一個直接歸屬）
//   4. ★ 派生關聯：從直接實體出發，沿 related_entities 自動派生二級連結，
//                標記為 derived_from，供 Librarian/overview 做輔助參考
//
// 寫入目標：fragment_entities 多對多表（+ 相容 memory_fragments.entity_id 舊欄位）
// 設計原則：同步執行，Scribe 返回前 entity 連結已填充完畢。
// LLM 只做單選（準確性最高），多維度關聯走確定性的關係圖譜派生。
// =================================================================

const { getDb } = require('../../../database');
const { callLLM } = require('../../llm');
const { USER, AI, SKIP_NAMES, fillPrompt } = require('../../nameResolver');
const { chromaDBOperation, getLocalEmbedding } = require('../ca3/memory');

// 向量聯想配置
const VECTOR_HINT_TOP_K = 5;
const VECTOR_HINT_MIN_SIMILARITY = 0.55;
const VECTOR_HINT_MAX_CANDIDATES = 5;

// 派生關聯置信度（低於直接關聯，供下游區分權重）
const DERIVED_CONFIDENCE = 0.45;

// entity_profiles.related_entities 是 Archivist 維護的 JSON：[{id,name,relation,shared_count,...}]。
// （過去這裡查一個從來沒被任何 migration 建立的 related_entity_ids 欄位，整條解析管線因
//  「no such column」而失效；現在改讀既有欄位，取出其中的 id。）
function parseRelatedIds(json) {
    let list = [];
    try { list = JSON.parse(json || '[]'); } catch (_) { return []; }
    if (!Array.isArray(list)) return [];
    const ids = [];
    for (const r of list) {
        const id = (r && typeof r === 'object') ? Number(r.id) : Number(r);
        if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

// 記憶體快取，5分鐘重新整理
let _aliasCache = null;
let _cacheAge = 0;

function getAliasData() {
    const now = Date.now();
    if (_aliasCache && (now - _cacheAge) < 300000) return _aliasCache;

    const db = getDb();
    const rows = db.prepare(`
        SELECT id, name, category, aliases, facts, related_entities FROM entity_profiles
        WHERE name IS NOT NULL AND category != 'term'
    `).all();

    const aliasMap = new Map();
    const knownEntities = [];
    const entityDescriptors = new Map();
    // ★ 關係圖譜：entity_id → [related_entity_id, ...]  供派生關聯用
    const relationGraph = new Map();

    for (const row of rows) {
        let aliasList = [];
        try { aliasList = JSON.parse(row.aliases || '[]'); } catch (_) {}
        const relatedIds = parseRelatedIds(row.related_entities);

        knownEntities.push({ id: row.id, name: row.name, aliases: aliasList });

        let shortDesc = '';
        if (row.facts) {
            shortDesc = row.facts.replace(/\n/g, ' ').substring(0, 120);
            if (row.facts.length > 120) shortDesc += '…';
        }
        entityDescriptors.set(row.id, {
            name: row.name,
            category: row.category || 'unknown',
            shortDesc,
        });

        if (relatedIds.length > 0) {
            relationGraph.set(row.id, relatedIds);
        }

        aliasMap.set(row.name.toLowerCase(), { id: row.id, name: row.name });
        for (const alias of aliasList) {
            if (alias && alias.trim()) {
                aliasMap.set(alias.trim().toLowerCase(), { id: row.id, name: row.name });
            }
        }
    }

    _aliasCache = { aliasMap, knownEntities, entityDescriptors, relationGraph };
    _cacheAge = now;
    return _aliasCache;
}

// ── 內部：寫入 fragment_entities（替換舊 entity_id UPDATE）──
function linkFragmentToEntity(fragmentId, entityId, relation, confidence, classifiedBy) {
    const db = getDb();
    db.prepare(`
        INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(fragmentId, entityId, relation || null, confidence, classifiedBy);

    // 同步更新 entity_profiles.fragment_count
    db.prepare(`
        UPDATE entity_profiles SET fragment_count = (
            SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?
        ) WHERE id = ?
    `).run(entityId, entityId);

    // 相容舊欄位
    db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
        .run(entityId, fragmentId);
}

// ── 內部：從直接實體派生二級關聯 ──
// 讀取 entity 的 related_entities（取其中 id），寫入 fragment_entities（標記 derived_from）
function deriveEntityLinks(fragmentId, directEntityId) {
    const db = getDb();
    const { relationGraph, entityDescriptors } = _aliasCache;  // 可能在當前 tick 內已過期，fallback 到實查

    // 先查快取，快取沒有則查 DB
    let relatedIds = relationGraph?.get(directEntityId);
    if (!relatedIds) {
        const row = db.prepare('SELECT related_entities FROM entity_profiles WHERE id = ?').get(directEntityId);
        if (!row?.related_entities) return 0;
        relatedIds = parseRelatedIds(row.related_entities);
        if (!relatedIds.length) return 0;
    }

    let derived = 0;
    for (const rid of relatedIds) {
        // 跳過不存在的 entity
        const exists = db.prepare('SELECT 1 FROM entity_profiles WHERE id = ? AND status = ?').get(rid, 'active');
        if (!exists) continue;

        const relation = `derived_from:${directEntityId}`;
        db.prepare(`
            INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(fragmentId, rid, relation, DERIVED_CONFIDENCE, 'resolver.derived');

        // 更新派生 entity 的 fragment_count
        db.prepare(`
            UPDATE entity_profiles SET fragment_count = (
                SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?
            ) WHERE id = ?
        `).run(rid, rid);

        derived++;
    }

    if (derived > 0) {
        const entName = entityDescriptors?.get(directEntityId)?.name || `#${directEntityId}`;
        console.log(`[EntityResolver] 🔗 派生關聯: frag #${fragmentId} → ${derived} 個實體 (from ${entName})`);
    }

    return derived;
}

// ── 內部：關鍵詞匹配 ──
function matchByKeyword(fragment, aliasMap) {
    if (fragment.entity && fragment.entity.trim()) {
        const key = fragment.entity.trim().toLowerCase();
        if (aliasMap.has(key)) return aliasMap.get(key);
    }

    const content = (fragment.content || '').toLowerCase();
    for (const [alias, entry] of aliasMap) {
        if (alias.length >= 2 && content.includes(alias)) {
            if (entry.name === USER.name || entry.name === AI.name) continue;
            return entry;
        }
    }
    return null;
}

// ── 內部：向量聯想 ──
async function matchByVectorHint(unmatchedFragments) {
    if (unmatchedFragments.length === 0) return {};

    const db = getDb();
    const { entityDescriptors } = getAliasData();
    const candidates = {};

    for (const frag of unmatchedFragments) {
        try {
            const embedding = await getLocalEmbedding(frag.content);
            if (!embedding) continue;

            const queryResult = await chromaDBOperation('query', {
                embedding,
                n_results: VECTOR_HINT_TOP_K,
                min_similarity: VECTOR_HINT_MIN_SIMILARITY,
                query_text: frag.content,
            });

            const ids = queryResult?.ids?.[0] || [];
            const distances = queryResult?.distances?.[0] || [];
            if (ids.length === 0) continue;

            const neighborIds = [];
            const neighborScores = new Map();
            for (let i = 0; i < ids.length; i++) {
                const fragMatch = ids[i]?.match(/^fragment_(\d+)$/);
                if (fragMatch) {
                    const nid = parseInt(fragMatch[1]);
                    neighborIds.push(nid);
                    const sim = 1 - (distances[i] || 0);
                    const existing = neighborScores.get(nid) || 0;
                    neighborScores.set(nid, Math.max(existing, sim));
                }
            }

            if (neighborIds.length === 0) continue;

            const placeholders = neighborIds.map(() => '?').join(',');
            const links = db.prepare(`
                SELECT fe.entity_id, fe.fragment_id
                FROM fragment_entities fe
                WHERE fe.fragment_id IN (${placeholders})
            `).all(...neighborIds);

            if (links.length === 0) continue;

            const voteMap = new Map();
            for (const link of links) {
                const sim = neighborScores.get(link.fragment_id) || 0;
                const existing = voteMap.get(link.entity_id);
                if (existing) {
                    existing.votes++;
                    existing.max_sim = Math.max(existing.max_sim, sim);
                    existing.sum_sim += sim;
                } else {
                    const desc = entityDescriptors.get(link.entity_id);
                    voteMap.set(link.entity_id, {
                        entity_id: link.entity_id,
                        entity_name: desc?.name || `id:${link.entity_id}`,
                        category: desc?.category || 'unknown',
                        shortDesc: desc?.shortDesc || '',
                        votes: 1,
                        max_sim: sim,
                        sum_sim: sim,
                    });
                }
            }

            const ranked = Array.from(voteMap.values())
                .sort((a, b) => (b.votes * b.max_sim) - (a.votes * a.max_sim))
                .slice(0, VECTOR_HINT_MAX_CANDIDATES);

            if (ranked.length > 0) candidates[frag.id] = ranked;
        } catch (e) {
            console.error(`[EntityResolver] 向量聯想失敗 frag #${frag.id}:`, e.message);
        }
    }

    if (Object.keys(candidates).length > 0) {
        const totalHints = Object.values(candidates).reduce((s, c) => s + c.length, 0);
        console.log(`[EntityResolver] 🔗 向量聯想: ${Object.keys(candidates).length}/${unmatchedFragments.length} 條碎片獲得候選 (共 ${totalHints} 個候選實體)`);
    }

    return candidates;
}

// ── 內部：LLM 指代消解（單選）──
async function resolveByLLM(unmatchedFragments, conversationText, knownEntities, entityCandidates) {
    if (unmatchedFragments.length === 0) return {};

    const entityLines = knownEntities.map(e => {
        const desc = entityCandidates?.[e.id] || null;
        const catTag = desc?.category ? ` | ${desc.category}` : '';
        const overviewHint = desc?.shortDesc ? ` — ${desc.shortDesc}` : '';
        return `- [ID:${e.id}] ${e.name}${catTag}${overviewHint}${e.aliases.length ? '（別名：' + e.aliases.join('、') + '）' : ''}`;
    });

    const fragmentLines = unmatchedFragments.map(f => {
        const hints = entityCandidates[f.id];
        let hintText = '';
        if (hints && hints.length > 0) {
            hintText = '\n  ★ 向量關聯候選（按相似度排序）：' + hints.map(h =>
                `[ID:${h.entity_id}] ${h.entity_name}${h.category ? ' (' + h.category + ')' : ''} — 鄰居碎片投票 ${h.votes} 票, 最高相似度 ${h.max_sim.toFixed(2)}${h.shortDesc ? ' | ' + h.shortDesc : ''}`
            ).join('；');
        }
        return `[frag_${f.id}] entity="${f.entity_label}" content="${f.content}"${hintText}`;
    });

    const prompt = `你是實體指代消解器。給定對話上下文、已知實體列表和記憶碎片，判斷每條碎片提及的人物/事物指向哪個已知實體。

已知實體：
${entityLines.join('\n')}

規則：
- 每條碎片最多分配一個實體——選最直接的那一個
- ★ 向量關聯候選的使用方法：
  · 訊號強（同一實體 ≥2 票 或 最高相似度 ≥0.75）→ 候選很可能是對的，結合描述判斷後確認
  · 訊號弱（各實體各1票且相似度 <0.70）→ 候選只是"聽起來有點像"，不要強行關聯
  · 候選實體描述與碎片內容明顯不是一回事 → 即使票數高也輸出 null
- ★ 使用已知實體的描述（category + 概述）來判斷語義關聯
- 代詞（他/她/它/這個人/那人）在上下文中指向誰，就輸出誰的 ID
- 如果是 {{user.name}} 或 {{ai.name}} 自己，輸出 entity_id: null
- 如果無法確定指向誰，輸出 entity_id: null
- 不要因為"好像有點關係"就分配 ID——只在確定時分配

輸出嚴格JSON：
{
  "resolutions": [
    {"fragment_id": 123, "entity_id": 1, "entity_name": "某個朋友"},
    {"fragment_id": 124, "entity_id": null, "reason": "指代不明"}
  ]
}`;

    const userContent = `對話上下文：
${conversationText.slice(0, 4000)}

待消解的記憶碎片：
${fragmentLines.join('\n')}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: userContent }] }],
            fillPrompt(prompt),
            null,
            { temperature: 0.1, maxOutputTokens: 2000 },
            36
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);

        const resolutions = {};
        if (result?.resolutions) {
            for (const r of result.resolutions) {
                if (r.entity_id != null) {
                    resolutions[r.fragment_id] = r.entity_id;
                    console.log(`[EntityResolver] 🎯 LLM消解: frag #${r.fragment_id} → entity ${r.entity_id} (${r.entity_name || '?'})`);
                }
            }
        }
        return resolutions;
    } catch (e) {
        console.error('[EntityResolver] LLM指代消解失敗:', e.message);
        return {};
    }
}

// =================================================================
// 公開 API
// =================================================================

/**
 * 解析新寫入 fragments 的 entity 關聯
 * @param {number[]} fragmentIds - 剛寫入的 fragment IDs
 * @param {string} conversationText - Scribe 已解密的格式化對話文本
 * @returns {number} 成功解析的數量（含直接+派生）
 */
async function resolveEntityIds(fragmentIds, conversationText) {
    if (!fragmentIds || fragmentIds.length === 0) return 0;

    const db = getDb();
    const { aliasMap, knownEntities } = getAliasData();
    if (aliasMap.size === 0) return 0;

    const placeholders = fragmentIds.map(() => '?').join(',');
    const fragments = db.prepare(`
        SELECT id, entity, content FROM memory_fragments WHERE id IN (${placeholders})
    `).all(...fragmentIds);

    const unmatched = [];
    let totalDirect = 0, totalDerived = 0;

    // —— 第一層：關鍵詞匹配 ——
    for (const frag of fragments) {
        const match = matchByKeyword(frag, aliasMap);
        if (match) {
            linkFragmentToEntity(frag.id, match.id, 'keyword', 0.90, 'resolver.keyword');
            totalDerived += deriveEntityLinks(frag.id, match.id);
            totalDirect++;
        } else {
            unmatched.push(frag);
        }
    }

    if (totalDirect > 0) {
        console.log(`[EntityResolver] 關鍵詞匹配: ${totalDirect}/${fragments.length} 條 (+${totalDerived} 派生)`);
    }

    // —— 第二層：向量聯想 ——
    let entityCandidates = {};
    if (unmatched.length > 0) {
        entityCandidates = await matchByVectorHint(unmatched);
    }

    // —— 第三層：LLM 指代消解 ——
    if (unmatched.length > 0 && conversationText) {
        const llmResolutions = await resolveByLLM(unmatched, conversationText, knownEntities, entityCandidates);
        let llmDirect = 0, llmDerived = 0;
        for (const [fragId, entityId] of Object.entries(llmResolutions)) {
            linkFragmentToEntity(parseInt(fragId), entityId, 'llm_resolved', 0.70, 'resolver.llm');
            llmDerived += deriveEntityLinks(parseInt(fragId), entityId);
            llmDirect++;
        }
        totalDirect += llmDirect;
        totalDerived += llmDerived;
        if (llmDirect > 0) {
            console.log(`[EntityResolver] LLM指代消解: ${llmDirect}/${unmatched.length} 條 (+${llmDerived} 派生)`);
        }

        const hintedUnresolved = unmatched.filter(
            f => entityCandidates[f.id]?.length > 0 && !llmResolutions[f.id]
        );
        if (hintedUnresolved.length > 0) {
            console.log(`[EntityResolver] ⚠️ 向量有候選但LLM判定不關聯: ${hintedUnresolved.length} 條 (frag #${hintedUnresolved.map(f => f.id).join(',')})`);
        }
    }

    // —— 第四層（fire-and-forget）：實體關係發現 ——
    try {
        const { discoverEntityRelationships } = require('../../archivist');
        const db = getDb();

        const missingRels = db.prepare(`
            SELECT COUNT(*) as c FROM entity_profiles ep
            WHERE ep.category = 'person'
              AND ep.name NOT IN ('${USER.name}', '${AI.name}')
              AND (ep.relationship_to_user IS NULL OR ep.relationship_to_user = '')
              AND (SELECT COUNT(*) FROM memory_fragments WHERE entity_id = ep.id AND status = 'active') >= 5
        `).get();

        const lowConfRels = db.prepare(`
            SELECT COUNT(*) as c FROM entity_profiles ep
            WHERE ep.category = 'person'
              AND ep.name NOT IN ('${USER.name}', '${AI.name}')
              AND ep.relationship_confidence IN ('low', 'medium')
              AND (ep.last_evaluated_at IS NULL OR ep.last_evaluated_at < datetime('now', '-1 day'))
              AND (SELECT COUNT(*) FROM memory_fragments
                   WHERE entity_id = ep.id AND status = 'active'
                     AND created_at > COALESCE(ep.last_evaluated_at, '1970-01-01')) >= 3
        `).get();

        if (missingRels?.c > 0 || lowConfRels?.c > 0) {
            discoverEntityRelationships({ includeReEval: true }).catch(e =>
                console.error('[EntityResolver] 關係發現失敗（非致命）:', e.message));
        }
    } catch (e) {
        // 不阻塞
    }

    return totalDirect + totalDerived;
}

module.exports = { resolveEntityIds };
