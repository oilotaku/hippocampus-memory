// =================================================================
// services/cognitiveModel/evidence.js — 證據：加證據與信心度加減、碎片比對、事實收割、碎片錨定與回填、星圖橋接
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { callLLM } = require('../../../llm');
const { WORLD_CONTEXT } = require('../../../worldContext');
const { fillPrompt, USER } = require('../../../nameResolver');
const { sqlNow } = require('../../../../utils/time');
const { LLM_CONFIG_ID } = require('./constants');
const { safeParseJson } = require('./helpers');
const { createEntry } = require('./entries');


// ═══════════════════════════════════════════════════════
// Evidence Management
// ═══════════════════════════════════════════════════════

function addEvidence(id, fragmentId, confirms = true, opts = {}) {
    const db = getDb();
    const entry = db.prepare('SELECT * FROM user_model WHERE id = ?').get(id);
    if (!entry) return null;

    const { sourceMsgIds = [] } = opts; // message IDs that produced this evidence

    // ── Source diversity: check if this is truly independent evidence ──
    let sourceDiversity = entry.source_diversity || 1;
    let isIndependentSource = false;

    if (sourceMsgIds.length > 0) {
        // Check existing source fragments for message ID overlap
        const existingFragIds = JSON.parse(entry.source_fragment_ids || '[]');
        if (existingFragIds.length > 0) {
            const placeholders = existingFragIds.map(() => '?').join(',');
            const existingMsgIds = db.prepare(`
                SELECT DISTINCT source_msg_ids FROM memory_fragments
                WHERE id IN (${placeholders}) AND source_msg_ids IS NOT NULL
            `).all(...existingFragIds)
                .flatMap(r => { try { return JSON.parse(r.source_msg_ids || '[]'); } catch { return []; } });

            const overlap = sourceMsgIds.filter(mid => existingMsgIds.includes(mid));
            // < 30% message overlap → likely independent source batch
            if (overlap.length / Math.max(sourceMsgIds.length, 1) < 0.3) {
                isIndependentSource = true;
                sourceDiversity++;
            }
        } else {
            // First evidence with message IDs — always independent
            isIndependentSource = true;
        }
    } else {
        // No message IDs — use date-based diversity as fallback
        const fragDate = db.prepare('SELECT DATE(created_at) as d FROM memory_fragments WHERE id = ?').get(fragmentId)?.d;
        if (fragDate) {
            const existingFragIds = JSON.parse(entry.source_fragment_ids || '[]');
            if (existingFragIds.length > 0) {
                const placeholders = existingFragIds.map(() => '?').join(',');
                const hasSameDate = db.prepare(`
                    SELECT COUNT(*) as c FROM memory_fragments
                    WHERE id IN (${placeholders}) AND DATE(created_at) = ?
                `).get(...existingFragIds, fragDate)?.c || 0;
                // Different date from all existing evidence → independent source
                isIndependentSource = (hasSameDate === 0);
            } else {
                isIndependentSource = true;
            }
        } else {
            // No date info — be conservative
            isIndependentSource = false;
        }
    }

    // ── Confidence adjustment ──
    const newCount = entry.evidence_count + 1;
    let newConfidence = entry.confidence;
    const now = sqlNow();

    // Cap depends on source_quality
    const sourceQuality = entry.source_quality || 'inferred';
    const isDirectStatement = sourceQuality === 'direct_statement';

    if (confirms) {
        let bump;
        switch (entry.type) {
            case 'stable_trait':
                // Independent observation: +0.05; echo/same-batch: +0.02
                bump = isIndependentSource ? 0.05 : 0.02;
                newConfidence = Math.min(isDirectStatement ? 0.99 : 0.80, entry.confidence + bump);
                break;
            case 'current_state':
                // Direct: +0.15 cap 0.99; inferred: +0.08 cap 0.75
                bump = isIndependentSource ? (isDirectStatement ? 0.15 : 0.08) : 0.04;
                newConfidence = Math.min(isDirectStatement ? 0.99 : 0.75, entry.confidence + bump);
                break;
            case 'active_hypothesis':
                bump = isIndependentSource ? 0.10 : 0.05;
                newConfidence = Math.min(0.75, entry.confidence + bump);
                break;
            default: // immutable_fact
                bump = 0.01;
                newConfidence = Math.min(0.99, entry.confidence + bump);
        }
    } else {
        // Contradiction: weight depends on source independence
        const penalty = isIndependentSource ? 0.12 : 0.05;
        switch (entry.type) {
            case 'stable_trait':
                newConfidence = Math.max(0.10, entry.confidence - penalty);
                break;
            case 'current_state':
                newConfidence = Math.max(0.05, entry.confidence - penalty * 1.2);
                break;
            case 'active_hypothesis':
                newConfidence = Math.max(0.05, entry.confidence - penalty * 1.5);
                break;
            default:
                newConfidence = Math.max(0.20, entry.confidence - penalty * 0.5);
        }

        // If this contradiction is independent and entry was inferred-only,
        // flag for LLM review
        if (isIndependentSource && !isDirectStatement && entry.confidence >= 0.50) {
            const tags = JSON.parse(entry.tags || '[]');
            if (!tags.includes('needs_review')) {
                tags.push('needs_review');
                db.prepare(`UPDATE user_model SET tags = ?, priority = MAX(priority, 5),
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(tags), id);
            }
        }

        // Record contradiction in evolution_history for processModelDecay counting
        const evoHistory = JSON.parse(entry.evolution_history || '[]');
        evoHistory.push({ type: 'contradiction', at: now, source_independent: isIndependentSource });
        db.prepare(`UPDATE user_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(JSON.stringify(evoHistory), id);
    }

    // Append fragment to source list
    let sourceIds = JSON.parse(entry.source_fragment_ids || '[]');
    if (!sourceIds.includes(fragmentId)) {
        sourceIds.push(fragmentId);
        if (sourceIds.length > 50) sourceIds = sourceIds.slice(-50);
    }

    db.prepare(`UPDATE user_model SET evidence_count = ?, confidence = ?,
        last_evidence_at = ?, source_fragment_ids = ?, source_diversity = ?,
        ${confirms ? '' : 'last_contradiction_at = ?, '}
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(
            newCount, newConfidence, now, JSON.stringify(sourceIds), sourceDiversity,
            ...(confirms ? [id] : [now, id])
        );

    // Auto-upgrade hypothesis: requires diverse independent sources (not same-day echo)
    if (entry.type === 'active_hypothesis' && sourceDiversity >= 3 && newConfidence >= 0.70) {
        db.prepare(`UPDATE user_model SET type = 'stable_trait', decay_type = 'evidence_dependent',
            source_quality = 'inferred', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
        console.log(`[UserModel] 🆙 假設升級為特質: "${entry.content.slice(0, 60)}" (id=${id}, evidence=${newCount}, diversity=${sourceDiversity})`);
        return { upgraded: true, id, content: entry.content };
    }

    return { upgraded: false, id, confidence: newConfidence };
}


// ═══════════════════════════════════════════════════════
// Lightweight Evidence Matching (zero LLM + zero ChromaDB)
// Runs in tick cycle — matches recent fragments against user_model entries
// via keyword/entity overlap. Accumulates evidence without LLM cost.
// ═══════════════════════════════════════════════════════

function matchEvidenceFromFragments() {
    const db = getDb();

    // Get fragments written since last evidence match run
    const lastRunKey = 'user_model_last_evidence_match';
    const lastRun = db.prepare(
        "SELECT setting_value FROM user_settings WHERE setting_key = ?"
    ).get(lastRunKey);
    const since = lastRun?.setting_value || '2000-01-01T00:00:00Z';

    // Get recently written fragments (not already matched to model entries)
    const newFragments = db.prepare(`
        SELECT mf.id, mf.entity, mf.content, mf.emotional_weight, mf.source_msg_ids, mf.created_at
        FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.created_at > ?
          AND mf.id NOT IN (
            SELECT DISTINCT value FROM json_each(
                (SELECT COALESCE(setting_value, '[]') FROM user_settings WHERE setting_key = 'cm_evidenced_frag_ids')
            )
          )
        ORDER BY mf.created_at DESC
        LIMIT 100
    `).all(since);

    if (newFragments.length === 0) return { matched: 0 };

    // Get all active model entries that can accept evidence
    const entries = db.prepare(`
        SELECT id, type, content, entity_ids, source_fragment_ids, source_quality, confidence
        FROM user_model WHERE status = 'active'
        ORDER BY priority DESC, confidence DESC
    `).all();

    if (entries.length === 0) return { matched: 0 };

    // Preload all entity names into a Map (avoid N+1 queries in inner loop)
    const entityNameCache = new Map();
    for (const entry of entries) {
        const entityIds = JSON.parse(entry.entity_ids || '[]');
        for (const eid of entityIds) {
            if (!entityNameCache.has(eid)) {
                const ep = db.prepare('SELECT name FROM entity_profiles WHERE id = ?').get(eid);
                entityNameCache.set(eid, ep?.name || '');
            }
        }
    }

    let matched = 0;
    const evidencedFragIds = [];

    for (const frag of newFragments) {
        let bestEntry = null;
        let bestScore = 0;

        for (const entry of entries) {
            let score = 0;

            const entityIds = JSON.parse(entry.entity_ids || '[]');
            const entityNames = entityIds.map(eid => entityNameCache.get(eid) || '').filter(Boolean);

            // 1. Entity name match in fragment content/entity field
            for (const ename of entityNames) {
                if (frag.entity && frag.entity.includes(ename)) score += 3;
                if (frag.content && frag.content.includes(ename)) score += 2;
            }

            // 2. Bigram overlap for Chinese text (split on punctuation, then character bigrams)
            const tokenize = (text) => {
                const segments = (text || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
                const bigrams = [];
                for (const seg of segments) {
                    for (let i = 0; i < seg.length - 1; i++) {
                        bigrams.push(seg.slice(i, i + 2));
                    }
                }
                return bigrams;
            };
            const entryBigrams = new Set(tokenize(entry.content));
            const fragBigrams = tokenize(frag.content);
            let bigramOverlap = 0;
            for (const bg of fragBigrams) {
                if (entryBigrams.has(bg)) bigramOverlap++;
            }
            score += bigramOverlap * 0.3;

            // 3. Entity field substring match (bidirectional)
            if (frag.entity) {
                const fragEntityLower = frag.entity.toLowerCase();
                for (const ename of entityNames) {
                    if (ename.toLowerCase().includes(fragEntityLower) || fragEntityLower.includes(ename.toLowerCase())) {
                        score += 2;
                    }
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestEntry = entry;
            }
        }

        // Threshold: need at least score 3 for a meaningful match
        if (bestEntry && bestScore >= 3) {
            try {
                const msgIds = JSON.parse(frag.source_msg_ids || '[]');
                addEvidence(bestEntry.id, frag.id, true, { sourceMsgIds: msgIds });
                evidencedFragIds.push(frag.id);
                matched++;
            } catch (e) {
                // Non-fatal — skip this match
            }
        }
    }

    // Persist state
    const now = sqlNow();
    db.prepare("INSERT OR REPLACE INTO user_settings (setting_key, setting_value) VALUES (?, ?)")
        .run(lastRunKey, now);

    if (evidencedFragIds.length > 0) {
        const existing = db.prepare(
            "SELECT setting_value FROM user_settings WHERE setting_key = 'cm_evidenced_frag_ids'"
        ).get();
        const existingIds = (() => { try { return JSON.parse(existing?.setting_value || '[]'); } catch { return []; } })();
        const merged = [...new Set([...existingIds, ...evidencedFragIds])].slice(-500); // keep last 500
        db.prepare("INSERT OR REPLACE INTO user_settings (setting_key, setting_value) VALUES (?, ?)")
            .run('cm_evidenced_frag_ids', JSON.stringify(merged));
    }

    if (matched > 0) {
        console.log(`[UserModel] 🔍 輕量證據匹配: ${matched}/${newFragments.length} 條碎片匹配到認知條目`);
    }
    return { matched, fragmentsScanned: newFragments.length };
}


// Anchor newly detected entries to source fragments via bigram overlap
function anchorEntriesToFragments(entryIds, opts = {}) {
    const { timeWindow = '-7 days', fragLimit = 300, minOverlap = 4, orderDir = 'DESC' } = opts;
    const db = getDb();

    if (!Array.isArray(entryIds) || entryIds.length === 0) return;

    // Look up entry objects
    const placeholders = entryIds.map(() => '?').join(',');
    const entries = db.prepare(`SELECT id, content FROM user_model WHERE id IN (${placeholders})`).all(...entryIds);
    if (entries.length === 0) return;

    // orderDir ASC = oldest-first for seed anchoring (capture earliest evidence);
    // orderDir DESC = newest-first for regular detectNewTraits anchoring
    const orderClause = `ORDER BY created_at ${orderDir === 'ASC' ? 'ASC' : 'DESC'}`;
    const recentFrags = db.prepare(`
        SELECT id, entity, content, emotional_weight, source_msg_ids, source
        FROM memory_fragments WHERE status = 'active'
        AND created_at > datetime('now', ?)
        ${orderClause} LIMIT ?
    `).all(timeWindow, fragLimit);

    if (recentFrags.length === 0) return;

    const allEntities = db.prepare('SELECT id, name FROM entity_profiles').all();
    const entityNameToId = new Map(allEntities.map(e => [e.name.toLowerCase(), e.id]));

    // Shared tokenizer
    const tokenize = (text) => {
        const segments = (text || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
        const bigrams = [];
        for (const seg of segments) {
            for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
        }
        return bigrams;
    };

    for (const entry of entries) {
        const entryLower = entry.content.toLowerCase();
        const entryBigrams = new Set(tokenize(entry.content));
        const matchedFragIds = [];
        const matchedEntityIds = new Set();

        for (const frag of recentFrags) {
            const fragBigrams = tokenize(frag.content);
            let overlap = 0;
            for (const bg of fragBigrams) {
                if (entryBigrams.has(bg)) overlap++;
            }
            if (overlap >= minOverlap) {
                matchedFragIds.push(frag.id);
                for (const [ename, eid] of entityNameToId) {
                    if (entryLower.includes(ename) || (frag.content || '').toLowerCase().includes(ename)) {
                        matchedEntityIds.add(eid);
                    }
                }
            }
        }

        if (matchedFragIds.length > 0) {
            const existing = db.prepare('SELECT source_fragment_ids, entity_ids FROM user_model WHERE id = ?').get(entry.id);
            const existingFragIds = safeParseJson(existing?.source_fragment_ids);
            const rawEntityIds = safeParseJson(existing?.entity_ids);
            const existingEntityIds = Array.isArray(rawEntityIds) ? rawEntityIds : [];
            const allFrags = [...new Set([...existingFragIds, ...matchedFragIds])];
            // Keep half oldest + half newest to span the full timeline
            const maxFrags = opts.maxFrags || 50;
            let mergedFrags;
            if (allFrags.length <= maxFrags) {
                mergedFrags = allFrags;
            } else {
                const half = Math.floor(maxFrags / 2);
                mergedFrags = [...allFrags.slice(0, half), ...allFrags.slice(-(maxFrags - half))];
            }
            const mergedEntities = [...new Set([...existingEntityIds, ...matchedEntityIds])];

            db.prepare(`UPDATE user_model SET source_fragment_ids = ?, entity_ids = ?,
                evidence_count = ?, last_evidence_at = datetime('now'),
                updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify(mergedFrags), JSON.stringify(mergedEntities),
                    mergedFrags.length, entry.id);

            console.log(`[UserModel] ⚓ 錨定條目 #${entry.id}: ${matchedFragIds.length} frags — "${entry.content.slice(0, 50)}"`);
        }
    }
}


// Seed-anchor orphan entries: entries with empty source_fragment_ids that were
// created by seedFromExisting or early detectNewTraits runs before the anchor bug
// was fixed. Searches ALL active fragments (not just 7 days), run once per deep cycle.
function seedAnchorOrphanEntries() {
    const db = getDb();

    const orphans = db.prepare(`
        SELECT id FROM user_model
        WHERE status = 'active'
          AND (source_fragment_ids IS NULL OR source_fragment_ids = '' OR source_fragment_ids = '[]')
        LIMIT 20
    `).all();

    if (orphans.length === 0) return { anchored: 0 };

    const orphanIds = orphans.map(o => o.id);
    console.log(`[UserModel] 🦴 種子錨定: ${orphanIds.length} 條孤立條目 → 搜尋全量碎片`);

    // Two-pass: oldest first (capture earliest evidence), then newest (capture recent)
    anchorEntriesToFragments(orphanIds, { timeWindow: '-999 days', fragLimit: 250, minOverlap: 4, orderDir: 'ASC', maxFrags: 25 });
    anchorEntriesToFragments(orphanIds, { timeWindow: '-999 days', fragLimit: 250, minOverlap: 4, orderDir: 'DESC', maxFrags: 50 });
    return { anchored: orphanIds.length };
}


// Harvest facts from fragments → immutable_fact entries
// Scans ALL fragment types (not just type='fact'), pre-filters with keywords, then LLM flash verifies
async function harvestFacts() {
    const db = getDb();

    // Scan all fragment types from last 7 days, not yet harvested
    const candidates = db.prepare(`
        SELECT mf.id, mf.content, mf.entity, mf.type, mf.source_msg_ids, mf.created_at
        FROM memory_fragments mf
        WHERE mf.status = 'active'
          AND mf.content IS NOT NULL
          AND mf.created_at > datetime('now', '-7 days')
          AND mf.id NOT IN (
            SELECT DISTINCT value FROM json_each(
                (SELECT COALESCE(setting_value, '[]') FROM user_settings WHERE setting_key = 'cm_harvested_fact_ids')
            )
          )
        ORDER BY mf.created_at DESC
        LIMIT 100
    `).all();

    if (candidates.length === 0) return { harvested: 0 };

    // Get existing immutable_fact entries for dedup
    const existingFacts = db.prepare(`
        SELECT content FROM user_model WHERE type = 'immutable_fact' AND status = 'active'
    `).all();
    const existingContents = existingFacts.map(e => e.content);

    // Pre-filter: keyword heuristics
    // Specific fact-indicating patterns — excludes generic 是/在 which match everything
    const factPattern = /出生於|畢業於|就讀於|家裡有|家人|老家|家鄉|媽媽|爸爸|妹妹|弟弟|姐姐|哥哥|大學|專業|職業|公司|[\d]{4}年|生日|身高|體重|血型|星座|MBTI|屬相|住在|搬到|出生于|毕业于|就读于|家里有|家人|老家|家乡|妈妈|爸爸|妹妹|弟弟|姐姐|哥哥|大学|专业|职业|公司|[\d]{4}年|生日|身高|体重|血型|星座|MBTI|属相|住在|搬到/;
    const transientPattern = /今天|現在|最近|這週|這個月|正在|準備|今天|现在|最近|这周|这个月|正在|准备/;

    const preFiltered = [];
    for (const frag of candidates) {
        // Skip if doesn't mention {{user.name}}
        if (!frag.content.includes(USER.name) && !frag.content.includes(USER.pronoun)) continue;
        // Skip transient statements
        if (transientPattern.test(frag.content)) continue;
        // Must contain at least one fact-indicating pattern
        if (!factPattern.test(frag.content)) continue;
        // Skip if >70% character overlap with existing fact
        const fragLower = frag.content.toLowerCase();
        const isDup = existingContents.some(c => {
            const cLower = c.toLowerCase();
            const overlap = [...fragLower].filter(ch => cLower.includes(ch)).length;
            return overlap / Math.max(fragLower.length, 1) > 0.7;
        });
        if (isDup) continue;

        preFiltered.push(frag);
    }

    if (preFiltered.length === 0) {
        console.log(`[UserModel] 🔍 事實收割: 掃描${candidates.length}條, 0條通過關鍵詞預篩`);
        return { harvested: 0, scanned: candidates.length };
    }

    // Cap to top 25 candidates (most recent first) to avoid token overflow
    const verifyBatch = preFiltered.slice(0, 25);

    // LLM flash verification: which candidates contain verifiable immutable facts?
    let verified = [];
    try {
        const verifyPrompt = `你是事實稽核器。檢查以下碎片是否包含關於{{user.name}}的可驗證、不會改變的客觀事實。

事實標準：一旦確認就不會變（生日、血型、畢業院校、家庭成員、曾經居住地、學歷、職業經歷等）。必須是{{user.name}}本人陳述，不是{{ai.name}}推測。不是臨時狀態或偏好。

對每條碎片判斷是否收入為immutable_fact。只返回JSON陣列。

碎片列表：
${verifyBatch.map((f, i) => `[${i}] [${f.type}] ${f.content}`).join('\n')}

返回格式：[{"idx": 0, "harvest": true, "content": "{{user.name}}..."}, {"idx": 1, "harvest": false}]
只返回JSON陣列，不要其他內容。`;

        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(verifyPrompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            verified = JSON.parse(jsonMatch[0]).filter(d => d.harvest);
        }
    } catch (e) {
        console.error('[UserModel] harvestFacts LLM verification error:', e.message);
        return { harvested: 0, scanned: candidates.length, prefiltered: preFiltered.length, error: e.message };
    }

    let harvested = 0;
    const harvestedIds = [];

    for (const decision of verified) {
        const frag = preFiltered[decision.idx];
        if (!frag) continue;

        const factContent = (decision.content || frag.content).slice(0, 200);

        const id = createEntry('immutable_fact', factContent, {
            confidence: 0.85,
            source_quality: 'direct_statement',
            source_fragment_ids: [frag.id],
            migration_source: `harvestFacts: fragment #${frag.id} [${frag.type}]`,
            tags: ['auto_harvested', 'llm_verified'],
        });
        if (id) {
            harvested++;
            harvestedIds.push(frag.id);
            try {
                const msgIds = JSON.parse(frag.source_msg_ids || '[]');
                addEvidence(id, frag.id, true, { sourceMsgIds: msgIds });
            } catch (_) {}
        }
    }

    // Track harvested fragment IDs
    if (harvestedIds.length > 0) {
        const existing = db.prepare(
            "SELECT setting_value FROM user_settings WHERE setting_key = 'cm_harvested_fact_ids'"
        ).get();
        const existingIds = (() => { try { return JSON.parse(existing?.setting_value || '[]'); } catch { return []; } })();
        const merged = [...new Set([...existingIds, ...harvestedIds])].slice(-500);
        db.prepare("INSERT OR REPLACE INTO user_settings (setting_key, setting_value) VALUES (?, ?)")
            .run('cm_harvested_fact_ids', JSON.stringify(merged));
    }

    if (harvested > 0) {
        console.log(`[UserModel] 📥 事實收割: ${harvested}/${verified.length}條確認 → immutable_fact (掃描${candidates.length}, 預篩${preFiltered.length})`);
    } else {
        console.log(`[UserModel] 🔍 事實收割: 掃描${candidates.length}, 預篩${preFiltered.length}, LLM確認0條`);
    }
    return { harvested, scanned: candidates.length, prefiltered: preFiltered.length, verified: verified.length };
}


// ═══════════════════════════════════════════════════════
// Evidence Backfill — link existing entries to their source fragments
// ═══════════════════════════════════════════════════════

function backfillModelEvidence() {
    const db = getDb();

    // ── 一次性修復：已有 source_fragment_ids 的條目，evidence_count/source_diversity 重算 ──
    // 原來的 entity_id 回填導致所有共享 entity_ids 的條目拿到相同的證據計數。
    // evidence_count = source_fragment_ids 陣列長度
    // source_diversity = source_fragment_ids 中不同日期的數量
    const dirtyEntries = db.prepare(`
        SELECT id, source_fragment_ids FROM user_model
        WHERE status = 'active'
          AND source_fragment_ids IS NOT NULL
          AND source_fragment_ids != ''
          AND source_fragment_ids != '[]'
    `).all();
    let fixCount = 0;
    for (const e of dirtyEntries) {
        const fids = safeParseJson(e.source_fragment_ids);
        if (fids.length === 0) continue;
        const placeholders = fids.map(() => '?').join(',');
        const distinctDates = db.prepare(`
            SELECT COUNT(DISTINCT DATE(created_at)) as c FROM memory_fragments
            WHERE id IN (${placeholders}) AND status = 'active'
        `).get(...fids)?.c || 0;
        db.prepare(`UPDATE user_model SET evidence_count = ?,
            source_diversity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(fids.length, Math.max(distinctDates, 1), e.id);
        fixCount++;
    }
    if (fixCount > 0) {
        console.log(`[UserModel] 證據修復: ${fixCount} 條 entry 的 evidence_count + source_diversity 已重算`);
    }

    // ── 孤兒錨定：source_fragment_ids 為空的條目，用 bigram 匹配補證據 ──
    const orphans = db.prepare(`
        SELECT id FROM user_model
        WHERE status = 'active'
          AND (source_fragment_ids IS NULL OR source_fragment_ids = '' OR source_fragment_ids = '[]')
        LIMIT 20
    `).all();

    if (orphans.length === 0) return { backfilled: fixCount };

    const orphanIds = orphans.map(o => o.id);
    console.log(`[UserModel] 證據回填: ${orphanIds.length} 條孤立條目 → bigram錨定`);

    // Two-pass anchor: oldest first (capture earliest evidence), then newest (capture recent)
    anchorEntriesToFragments(orphanIds, { timeWindow: '-999 days', fragLimit: 250, minOverlap: 4, orderDir: 'ASC', maxFrags: 25 });
    anchorEntriesToFragments(orphanIds, { timeWindow: '-999 days', fragLimit: 250, minOverlap: 4, orderDir: 'DESC', maxFrags: 50 });

    // After anchoring, recalculate evidence_count from the now-populated source_fragment_ids
    db.prepare(`
        UPDATE user_model
        SET evidence_count = json_array_length(source_fragment_ids),
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${orphanIds.map(() => '?').join(',')})
    `).run(...orphanIds);

    return { backfilled: fixCount + orphanIds.length };
}


// ═══════════════════════════════════════════════════════
// v4.8: bridgeStarMapToModel — 星圖→使用者模型橋
//
// 星圖的 term 實體（使用者的一些脆弱時刻、深夜寫程式碼等行為模式…）
// 是 archivist 從碎片中聚類出的行為模式，天然適合作為
// stable_trait 或 active_hypothesis 的候選。
//
// 本函式掃描 fragment_count≥5 且有 overview 的 term 實體，
// 查重後提案進 user_model。不替換現有訊號管線——作為
// 第7個訊號源，走同一套 dedup/verify/review 質檢。
// ═══════════════════════════════════════════════════════

async function bridgeStarMapToModel() {
    // v4.9 退役：term overview 不是可測試的假設/特質，直接灌入產出的
    // 是文學獨白（見 #171-176 教訓）。星圖→{{user.name}} Model 的正確關係是
    // 「引用」而非「橋」：trait.entity_ids 包含星圖實體 ID。
    // 保留函式簽名以便未來重設計時起手有框架。
    return { proposed: 0 };
}

module.exports = {
    addEvidence,
    matchEvidenceFromFragments,
    anchorEntriesToFragments,
    seedAnchorOrphanEntries,
    harvestFacts,
    backfillModelEvidence,
    bridgeStarMapToModel,
};
