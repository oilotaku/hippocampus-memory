// =================================================================
// services/cognitiveModel/profile.js — 個人檔案特質整合：分層、衝突檢查、決策紀錄
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');


// ═══════════════════════════════════════════════════════
// v5.10: Integrate verified traits into {{user.name}} profile
// ═══════════════════════════════════════════════════════

const PROFILE_TIERS = {
    locked:  { categories: ['basic'],                                        minDiversity: Infinity, allowCreate: false, allowRefine: false },
    high:    { categories: ['personality', 'communication'],                 minDiversity: 5,        allowCreate: false, allowRefine: true  },
    medium:  { categories: ['career', 'social', 'personal_history', 'relationship_with_companion', 'creative_work'], minDiversity: 3, allowCreate: true, allowRefine: true },
    low:     { categories: ['preference', 'lifestyle', 'health', 'finance'], minDiversity: 1,        allowCreate: true,  allowRefine: true },
};


function _getProfileTier(category) {
    for (const [name, tier] of Object.entries(PROFILE_TIERS)) {
        if (tier.categories.includes(category)) return { name, ...tier };
    }
    return { name: 'low', ...PROFILE_TIERS.low }; // default: low stability
}


/**
 * 画像写入协议：在 detectNewTraits / reviewStableTraits 产出新 trait 后，
 * 加载全量 User 画像做门禁检查，按稳定性分级写入。
 * @returns {{ integrated: number, rejected: number, conflicts: number }}
 */
async function integrateProfileTraits() {
    const db = getDb();
    const result = { integrated: 0, rejected: 0, conflicts: 0 };

    // 1. 加载全量 User 画像（12分类全部 active 条目）
    const profileEntries = db.prepare(`
        SELECT id, type, content, confidence, tags, evidence_count, source_diversity,
               source_quality, source_fragment_ids, evolution_history, status
        FROM user_model
        WHERE status IN ('active', 'dormant')
          AND type IN ('stable_trait', 'active_hypothesis')
        ORDER BY confidence DESC
    `).all();

    // 2. 只处理 source_diversity 达标的 candidate（刚 detectNewTraits/reviewStableTraits 产出或修改的）
    const candidates = profileEntries.filter(e => {
        if (e.status !== 'active') return false;
        // Check if this entry was recently created/modified (within last 6h)
        // We track this by checking if it lacks a profile_integrated marker in evolution_history
        let history = [];
        try { history = JSON.parse(e.evolution_history || '[]'); } catch (_) {}
        const alreadyIntegrated = history.some(h => h.action === 'profile_integrated');
        return !alreadyIntegrated && e.source_diversity >= 2 && e.confidence >= 0.55;
    });

    if (!candidates.length) return result;

    // 3. 对每个候选条目按稳定性分级处理
    for (const candidate of candidates) {
        let tags = [];
        try { tags = typeof candidate.tags === 'string' ? JSON.parse(candidate.tags) : (candidate.tags || []); } catch (_) {}

        // Determine primary category from tags
        const CATEGORY_ORDER = ['basic','personality','career','social','preference','lifestyle','health','creative_work','personal_history','relationship_with_companion','finance','communication'];
        let category = 'other';
        for (const cat of CATEGORY_ORDER) {
            if (tags.includes(cat)) { category = cat; break; }
        }

        const tier = _getProfileTier(category);

        // 3a. 门禁检查
        if (tier.name === 'locked') {
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — category '${category}' is locked`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `locked category: ${category}`);
            continue;
        }

        if (candidate.source_diversity < tier.minDiversity) {
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — diversity ${candidate.source_diversity} < ${tier.minDiversity}`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `diversity ${candidate.source_diversity} < ${tier.minDiversity}`);
            continue;
        }

        // 3b. High tier: only refine existing, never create new
        if (tier.name === 'high' && !tier.allowCreate) {
            const existingInCategory = profileEntries.filter(e =>
                e.id !== candidate.id && e.status === 'active' &&
                (() => { try { const t = JSON.parse(e.tags || '[]'); return t.includes(category); } catch(_) { return false; } })()
            );
            if (existingInCategory.length > 0) {
                // Refine mode: candidate supplements existing entry
                // Log the evidence but don't create a new entry
                console.log(`[UserModel] profile: SKIPPED #${candidate.id} — high-stability category '${category}' has existing entries, evidence logged`);
                _logProfileDecision(db, candidate.id, 'skipped_high_stability', `existing entries in ${category}, evidence logged for review`);
                result.integrated++;
                continue;
            }
            // No existing entry → explicitly reject creation
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — cannot create new entry in high-stability category '${category}'`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `no existing entry to refine in high-stability ${category}`);
            continue;
        }

        // 3c. 矛盾扫描（medium + high tiers）
        if (tier.requireContradictionCheck) {
            const sameCategory = profileEntries.filter(e =>
                e.id !== candidate.id && e.type === 'stable_trait' && e.status === 'active' &&
                (() => { try { const t = JSON.parse(e.tags || '[]'); return t.includes(category); } catch(_) { return false; } })()
            );

            if (sameCategory.length > 0) {
                const conflictCheck = await _checkProfileConflict(candidate, sameCategory, profileEntries);
                if (conflictCheck.has_conflict) {
                    console.log(`[UserModel] profile: CONFLICT #${candidate.id} — ${conflictCheck.conflict_type} with #${conflictCheck.conflict_with_id}: ${conflictCheck.reasoning}`);
                    result.conflicts++;
                    _logProfileDecision(db, candidate.id, 'conflict', JSON.stringify(conflictCheck));
                    if (conflictCheck.resolution === 'discard_new') {
                        result.rejected++;
                        continue;
                    }
                    // supersede or keep_both: proceed with integration
                }
            }
        }

        // 3d. 写入 evolution_history
        let history = [];
        try { history = JSON.parse(candidate.evolution_history || '[]'); } catch (_) {}
        history.push({
            action: 'profile_integrated',
            at: new Date().toISOString(),
            tier: tier.name,
            category,
            diversity: candidate.source_diversity,
            evidence: candidate.evidence_count,
        });
        db.prepare(`UPDATE user_model SET evolution_history = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(JSON.stringify(history), candidate.id);

        console.log(`[UserModel] profile: INTEGRATED #${candidate.id} — tier=${tier.name} cat=${category} diversity=${candidate.source_diversity}`);
        result.integrated++;
    }

    return result;
}


/**
 * Check if a candidate trait conflicts with existing profile entries in the same category.
 * Uses LLM (flash-lite) for semantic contradiction detection.
 */
async function _checkProfileConflict(candidate, sameCategoryEntries, allProfileEntries) {
    const db = getDb();
    // Build a compact profile snapshot
    const profileSummary = allProfileEntries
        .filter(e => e.type === 'stable_trait' && e.status === 'active')
        .map(e => `[#${e.id}] ${e.content.slice(0, 120)}`).join('\n');

    const existingSummary = sameCategoryEntries
        .map(e => `[#${e.id}] ${e.content.slice(0, 150)} (conf:${e.confidence?.toFixed(2)})`).join('\n');

    const prompt = `你是 User 画像的矛盾检测器。判断新特质是否与已有画像条目存在逻辑冲突。

新特质: "${candidate.content.slice(0, 200)}" (置信度:${candidate.confidence?.toFixed(2)}, 来源多样性:${candidate.source_diversity})

同分类已有条目:
${existingSummary || '(无)'}

全量画像参考:
${profileSummary.slice(0, 800)}

输出 JSON:
{
  "has_conflict": true/false,
  "conflict_with_id": null,
  "conflict_type": "direct_contradiction|partial_overlap|drift|none",
  "resolution": "supersede|discard_new|keep_both|none",
  "reasoning": "一句话"
}

规则：
- direct_contradiction（直接矛盾，如"{{user.pronoun}}喜欢社交" vs "{{user.pronoun}}讨厌社交"）→ resolution=supersede（新证据更强时）/discard_new（新证据更弱时）
- partial_overlap（部分重叠但方向不同）→ resolution=keep_both
- drift（旧认知可能过时了，如"{{user.pronoun}}住在某城市"→"{{user.pronoun}}搬到了某城市"）→ resolution=supersede
- 无明显冲突 → resolution=none

只返回 JSON。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            '', null,
            { temperature: 0.15, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
            null // use default LLM config
        );
        const replyText = (raw?.reply || raw?.text || '');
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.warn('[UserModel] _checkProfileConflict LLM error:', e.message);
    }
    return { has_conflict: false, conflict_with_id: null, conflict_type: 'none', resolution: 'none', reasoning: 'LLM check failed, defaulting to no conflict' };
}


function _logProfileDecision(db, entryId, decision, detail) {
    let history = [];
    try {
        const row = db.prepare('SELECT evolution_history FROM user_model WHERE id = ?').get(entryId);
        if (row?.evolution_history) history = JSON.parse(row.evolution_history);
    } catch (_) {}
    history.push({
        action: `profile_${decision}`,
        at: new Date().toISOString(),
        detail: detail?.slice(0, 300),
    });
    db.prepare(`UPDATE user_model SET evolution_history = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(history), entryId);
}

module.exports = {
    PROFILE_TIERS,
    _getProfileTier,
    integrateProfileTraits,
    _checkProfileConflict,
    _logProfileDecision,
};
