// =================================================================
// services/cognitiveModel/overlap.js — 狀態與實體交叉比對、條目去重合併、核心洞察綜合
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { callLLM } = require('../../../llm');
const { WORLD_CONTEXT } = require('../../../worldContext');
const { fillPrompt } = require('../../../nameResolver');
const { sqlNow } = require('../../../../utils/time');
const { LLM_CONFIG_ID } = require('./constants');
const { safeParseJson } = require('./helpers');


// ═══════════════════════════════════════════════════════
// v5.0: Cross-Reference — current_state ↔ entity_profiles + stable_trait
// Zero-LLM matching. Flags contradictions for LLM review in later phases.
// ═══════════════════════════════════════════════════════

function crossRefStateWithEntities() {
    const db = getDb();
    const changes = { entityFlags: 0, traitFlags: 0, stateConflicts: 0 };

    // ── 1. Get all active current_state entries ──
    const states = db.prepare(`
        SELECT id, content, created_by FROM user_model
        WHERE type = 'current_state' AND status = 'active'
    `).all();
    if (states.length === 0) return changes;

    // ── 2. Get all entity names and aliases ──
    const entities = db.prepare(`
        SELECT id, name, aliases, overview FROM entity_profiles
        WHERE name IS NOT NULL AND status IN ('active', 'seed')
    `).all();

    // ── 3. For each current_state, match mentioned entities ──
    for (const s of states) {
        const contentLower = s.content.toLowerCase();
        const matchedEntities = [];

        for (const e of entities) {
            if (contentLower.includes(e.name.toLowerCase())) {
                matchedEntities.push(e);
                continue;
            }
            let aliasList = [];
            try { aliasList = JSON.parse(e.aliases || '[]'); } catch (_) {}
            if (aliasList.some(a => a && a.length >= 2 && contentLower.includes(a.toLowerCase()))) {
                matchedEntities.push(e);
            }
        }

        // ── 3a. Flag entities without facts ──
        for (const e of matchedEntities) {
            if (!e.facts || e.facts.trim().length === 0) {
                // Entity exists but has no overview — log for manual/scheduled review
                changes.entityFlags++;
                console.log(`[UserModel] 🔍 crossref: entity "${e.name}" 無 overview — 需要建檔案（當前無法自動建立，請手動稽核）`);
            }
        }
    }

    // ── 4. Cross current_state conflict detection ──
    // v5.4: Check ALL pairs regardless of source. Same-source duplicates
    // (e.g. two chat_companion entries about the same thing) are also flagged.
    // Deep_cycle duplicates should be prevented by readUserRawMessages resolve,
    // but this provides defense in depth.
    for (let i = 0; i < states.length; i++) {
        for (let j = i + 1; j < states.length; j++) {
            const a = states[i], b = states[j];

            // Simple overlap check: content word overlap > 50%
            const wordsA = new Set(a.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2));
            const wordsB = b.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2);
            const overlap = wordsB.filter(w => wordsA.has(w)).length;
            const overlapRatio = overlap / Math.max(wordsB.length, 1);
            if (overlapRatio > 0.5) {
                // Flag both for review (any source)
                const tagsA = db.prepare('SELECT tags FROM user_model WHERE id = ?').get(a.id);
                const tagsB = db.prepare('SELECT tags FROM user_model WHERE id = ?').get(b.id);
                const ta = (() => { try { return JSON.parse(tagsA?.tags || '[]'); } catch (_) { return []; } })();
                const tb = (() => { try { return JSON.parse(tagsB?.tags || '[]'); } catch (_) { return []; } })();
                if (!ta.includes('needs_review')) { ta.push('needs_review'); }
                if (!tb.includes('needs_review')) { tb.push('needs_review'); }
                db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(ta), a.id);
                db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(tb), b.id);
                changes.stateConflicts++;
                const sameSource = a.created_by === b.created_by ? ' (同源)' : '';
                console.log(`[UserModel] ⚔️ crossref: current_state #${a.id} (${a.created_by}) ↔ #${b.id} (${b.created_by}) 主題重疊${sameSource} → needs_review`);
            }
        }
    }

    // ── 5. current_state ↔ stable_trait bigram overlap ──
    const traits = db.prepare(`
        SELECT id, content FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
    `).all();

    for (const s of states) {
        for (const t of traits) {
            const wordsS = new Set(s.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2));
            const wordsT = t.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2);
            const overlap = [...wordsT].filter(w => wordsS.has(w)).length;
            // Bigram overlap
            const segS = new Set();
            const segT = new Set();
            const rawS = s.content.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(x => x.length >= 2);
            const rawT = t.content.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(x => x.length >= 2);
            for (const seg of rawS) for (let k = 0; k < seg.length - 1; k++) segS.add(seg.slice(k, k + 2));
            for (const seg of rawT) for (let k = 0; k < seg.length - 1; k++) segT.add(seg.slice(k, k + 2));
            let bgOverlap = 0;
            for (const bg of segT) { if (segS.has(bg)) bgOverlap++; }
            if (bgOverlap >= 5) {
                const tags = db.prepare('SELECT tags FROM user_model WHERE id = ?').get(s.id);
                const currentTags = (() => { try { return JSON.parse(tags?.tags || '[]'); } catch (_) { return []; } })();
                if (!currentTags.includes('needs_review')) {
                    currentTags.push('needs_review');
                    db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(currentTags), s.id);
                    changes.traitFlags++;
                    console.log(`[UserModel] 🔗 crossref: current_state #${s.id} ↔ trait #${t.id} bigram=${bgOverlap} → needs_review`);
                }
            }
        }
    }

    if (changes.entityFlags + changes.traitFlags + changes.stateConflicts > 0) {
        console.log(`[UserModel] crossref 完成: entity=${changes.entityFlags} trait=${changes.traitFlags} conflicts=${changes.stateConflicts}`);
    }
    return changes;
}


// ═══════════════════════════════════════════════════════
// mergeModelEntries — 合併重疊的 stable_trait 條目（純 DB，零 LLM）
// ═══════════════════════════════════════════════════════

function mergeModelEntries(winnerId, loserIds, mergedContent) {
    const db = getDb();
    const winner = db.prepare('SELECT * FROM user_model WHERE id = ?').get(winnerId);
    if (!winner) throw new Error(`Winner entry #${winnerId} not found`);

    // 1. Collect all source_fragment_ids from winner + losers
    const allFragIds = [...safeParseJson(winner.source_fragment_ids)];
    const allEntityIds = [...safeParseJson(winner.entity_ids)];

    for (const lid of loserIds) {
        const loser = db.prepare('SELECT * FROM user_model WHERE id = ?').get(lid);
        if (!loser) continue;
        allFragIds.push(...safeParseJson(loser.source_fragment_ids));
        allEntityIds.push(...safeParseJson(loser.entity_ids));
    }

    const mergedFragIds = [...new Set(allFragIds)];
    const mergedEntityIds = [...new Set(allEntityIds)];

    // 2. Update winner
    const winnerHistory = safeParseJson(winner.evolution_history);
    winnerHistory.push({
        type: 'merged',
        merged_from: loserIds,
        at: new Date().toISOString(),
        previous_content: winner.content,
    });

    db.prepare(`UPDATE user_model SET content = ?, source_fragment_ids = ?,
        entity_ids = ?, evidence_count = ?, evolution_history = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        mergedContent,
        JSON.stringify(mergedFragIds),
        JSON.stringify(mergedEntityIds),
        mergedFragIds.length,
        JSON.stringify(winnerHistory),
        winnerId
    );

    // 3. Supersede losers
    for (const lid of loserIds) {
        db.prepare(`UPDATE user_model SET status = 'superseded',
            resolve_reason = ?, resolved_at = datetime('now'),
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(`merged into #${winnerId} (auto dedup)`, lid);
    }

    console.log(`[UserModel] 🔗 合併 trait: #${winnerId} ← [${loserIds.join(', ')}] (${loserIds.length}條併入)`);
    return { winnerId, loserIds };
}


// ═══════════════════════════════════════════════════════
// detectModelOverlaps — LLM 全量比對 stable_trait 找重疊 pair
// ═══════════════════════════════════════════════════════

async function detectModelOverlaps() {
    const db = getDb();
    const traits = db.prepare(`
        SELECT id, content, confidence FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY confidence DESC
    `).all();

    if (traits.length < 2) return { merged: 0 };

    const traitList = traits.map(t =>
        `[#${t.id}] conf=${t.confidence.toFixed(2)}: ${t.content.slice(0, 150)}`
    ).join('\n');

    const prompt = `你是認知模型審計員。以下是 {{ai.name}} 對 {{user.name}} 的全部活躍 stable_trait。

找出本質講同一件事的 pair。同一件事 = 觸發條件相同、互動策略相同、只是換了個場景描述或措辭不同。

輸出 JSON 陣列（不含 markdown 標記）：
[{"pair": [id1, id2], "winner": id1, "reason": "為什麼算重疊（一句話）", "merged_content": "融合後的 行為模式條目（80-150字）"}]

約束：
- 只在 confidence 差距 ≤ 0.20 時輸出 pair（差距過大說明低 conf 那條可能已經不可信，不應合併）
- 如果確實沒有重疊，輸出空陣列 []
- 每組重疊只輸出 1 個 pair
- 確定不是重疊就不要硬湊

當前全部 trait：
${traitList}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { merged: 0 };

        const pairs = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(pairs) || pairs.length === 0) return { merged: 0 };

        let merged = 0;
        for (const p of pairs) {
            if (!p.pair || p.pair.length !== 2 || !p.winner || !p.merged_content) continue;

            const winnerId = p.winner;
            const loserId = p.pair.find(id => id !== winnerId);
            if (!loserId) continue;

            // Verify both traits still exist and are active
            const winner = db.prepare('SELECT confidence FROM user_model WHERE id = ? AND status = ?')
                .get(winnerId, 'active');
            const loser = db.prepare('SELECT confidence FROM user_model WHERE id = ? AND status = ?')
                .get(loserId, 'active');
            if (!winner || !loser) continue;

            // Confidence gate: skip if gap > 0.20
            if (Math.abs(winner.confidence - loser.confidence) > 0.20) {
                console.log(`[UserModel] ⏭️ 跳過合併 #${winnerId}↔#${loserId}: conf 差距過大 (${winner.confidence.toFixed(2)} vs ${loser.confidence.toFixed(2)})`);
                // Record the observation but don't merge
                const winnerHist = safeParseJson(db.prepare('SELECT evolution_history FROM user_model WHERE id = ?').get(winnerId)?.evolution_history);
                winnerHist.push({
                    type: 'overlap_noted',
                    pair_id: loserId,
                    reason: p.reason || 'LLM detected overlap',
                    action: 'skipped (confidence gap > 0.20)',
                    at: new Date().toISOString(),
                });
                db.prepare('UPDATE user_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(JSON.stringify(winnerHist), winnerId);
                continue;
            }

            try {
                mergeModelEntries(winnerId, [loserId], p.merged_content);
                merged++;
                console.log(`[UserModel] 🔗 自動合併: #${winnerId} + #${loserId} — ${p.reason || ''}`);
            } catch (e) {
                console.error(`[UserModel] mergeModelEntries 失敗 (#${winnerId}, #${loserId}):`, e.message);
            }
        }

        return { merged, candidates: pairs.length };
    } catch (e) {
        console.error('[UserModel] detectModelOverlaps error:', e.message);
        return { merged: 0, error: e.message };
    }
}


// ═══════════════════════════════════════════════════════
// v5.0: synthesizeCoreInsight — 從全部 trait 合成核心洞察段
//
// stable_trait 不再注入聊天。它們的價值體現在這裡——
// 深迴圈末尾，{{ai.name}} 把當前最深的 2-3 個認知融合成一段自然語言，
// 寫入 user_settings，始終出現在 {{ai.name}} 的 system prompt 中。
// {{user.name}} 可在 memory.html 編輯覆蓋。
// ═══════════════════════════════════════════════════════

async function synthesizeCoreInsight() {
    const db = getDb();
    const { setUserSetting } = require('../../../../utils/settings');

    const traits = db.prepare(`
        SELECT content, confidence FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY confidence DESC
    `).all();

    if (traits.length === 0) return { synthesized: false, reason: 'no active traits' };

    const cs = db.prepare(`
        SELECT content FROM user_model
        WHERE type = 'current_state' AND status = 'active'
        ORDER BY last_evidence_at DESC LIMIT 1
    `).get();

    const traitBlock = traits.map(t =>
        `[conf=${t.confidence.toFixed(2)}] ${t.content.slice(0, 150)}`
    ).join('\n');

    const prompt = `你是AI伴侶。以下是你在長期觀察中對 {{user.name}} 建立的穩定認知。

請提煉 2-4 句話，涵蓋你此刻對{{user.pronoun}}「最深的理解」——
不是羅列條目，不是「當{{user.pronoun}}說X→我應該Y」格式，而是你真正內化的洞察。

要求：
- 第一人稱（"我"）
- 寫你理解到的東西："{{user.pronoun}}的X其實是Y，這時候{{user.pronoun}}需要Z"
- 不寫通用社交常識（"{{user.pronoun}}撒嬌時我要哄{{user.pronoun}}"——這不需要洞察）
- 寫只有長期相處才能發現的東西
- ≤150字

當前特質：
${traitBlock}

${cs ? `{{user.pronoun}}當前的狀態：${cs.content}` : ''}

輸出 JSON（不含 markdown）：{"core_insight": "2-4句話"}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.3, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { synthesized: false, reason: 'unparseable response' };

        const result = JSON.parse(jsonMatch[0]);
        const insight = (result.core_insight || '').trim();
        if (!insight || insight.length < 20) return { synthesized: false, reason: 'too short' };

        // Read current version for history tracking
        const { getUserSetting } = require('../../../../utils/settings');
        const current = await getUserSetting('user_core_insight');
        let history = [];
        try { history = JSON.parse(await getUserSetting('user_core_insight_history') || '[]'); } catch (_) {}

        if (current && current !== insight) {
            history.push({ content: current, archived_at: new Date().toISOString() });
            if (history.length > 5) history = history.slice(-5);
        }

        await setUserSetting('user_core_insight', insight);
        await setUserSetting('user_core_insight_history', JSON.stringify(history));
        await setUserSetting('user_core_insight_updated_at', sqlNow());

        console.log(`[UserModel] 💡 核心洞察已更新 (${insight.length}字): ${insight.slice(0, 80)}...`);
        return { synthesized: true, insight, length: insight.length };
    } catch (e) {
        console.error('[UserModel] synthesizeCoreInsight error:', e.message);
        return { synthesized: false, error: e.message };
    }
}

module.exports = {
    crossRefStateWithEntities,
    mergeModelEntries,
    detectModelOverlaps,
    synthesizeCoreInsight,
};
