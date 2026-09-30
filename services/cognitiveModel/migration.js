// =================================================================
// services/cognitiveModel/migration.js — 從既有資料播種（seedFromExisting）
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { safeParseJson } = require('./helpers');
const { createEntry } = require('./entries');


// ═══════════════════════════════════════════════════════
// Seed from Existing Data (one-time migration)
// ═══════════════════════════════════════════════════════

function seedFromExisting() {
    const db = getDb();

    // Check if already seeded
    const existing = db.prepare('SELECT COUNT(*) as c FROM user_model').get();
    if (existing.c > 0) {
        console.log(`[UserModel] 已有 ${existing.c} 條記錄，跳過播種`);
        return { skipped: true, existing: existing.c };
    }

    let created = { immutable_fact: 0, stable_trait: 0, current_state: 0, active_hypothesis: 0 };

    // From archivist_skills: verified monitors → stable_trait, hypothesis → active_hypothesis
    const skills = db.prepare(`
        SELECT * FROM archivist_skills WHERE status IN ('verified', 'active')
        ORDER BY confidence DESC
    `).all();

    for (const sk of skills) {
        const analysis = sk.analysis_config || '';
        const trigger = sk.trigger_config || '';
        const selfEval = sk.self_evaluation || '';

        if (sk.type === 'monitor' && sk.status === 'verified' && sk.confidence >= 0.7) {
            // Verified monitor → stable_trait
            const content = selfEval || analysis || trigger;
            if (content && content.length > 5) {
                createEntry('stable_trait', content.slice(0, 200), {
                    confidence: sk.confidence,
                    parent_skill_id: sk.id,
                    migration_source: 'archivist_skills verified monitor',
                    source_fragment_ids: safeParseJson(sk.observations).slice(0, 20),
                    entity_ids: safeParseJson(sk.entity_ids),
                });
                created.stable_trait++;
            }
        } else if (sk.type === 'hypothesis' && sk.status === 'active') {
            const content = analysis || trigger;
            if (content && content.length > 5) {
                createEntry('active_hypothesis', content.slice(0, 200), {
                    confidence: sk.confidence,
                    parent_skill_id: sk.id,
                    migration_source: 'archivist_skills hypothesis',
                    source_fragment_ids: safeParseJson(sk.observations).slice(0, 20),
                    entity_ids: safeParseJson(sk.entity_ids),
                });
                created.active_hypothesis++;
            }
        }
    }

    // From entity_profiles: high-confidence relationships → immutable_fact or stable_trait
    const entities = db.prepare(`
        SELECT * FROM entity_profiles
        WHERE relationship_to_user IS NOT NULL AND relationship_to_user != ''
        ORDER BY last_mentioned_date DESC
    `).all();

    for (const ent of entities) {
        if (!ent.relationship_to_user) continue;

        // Parse confidence from string or number
        let relConf = 0.5;
        if (typeof ent.relationship_confidence === 'string') {
            const map = { high: 0.85, medium: 0.6, low: 0.4 };
            relConf = map[ent.relationship_confidence.toLowerCase()] || 0.5;
        } else if (typeof ent.relationship_confidence === 'number') {
            relConf = ent.relationship_confidence;
        }

        // Skip fictional characters, public figures without real interaction
        const relText = ent.relationship_to_user;
        if (/虛構|文學角色|作品中的人物|並無實際人際|而非現實人物|欣賞其.*作品|虚构|文学角色|作品中的人物|并无实际人际|而非现实人物|欣赏其.*作品/.test(relText)) continue;
        if (ent.entity_type === 'fictional' || ent.entity_type === 'public_figure') continue;

        const content = `${ent.name}: ${relText}`;
        const type = relConf >= 0.85 ? 'immutable_fact' : 'stable_trait';
        const isHighConf = typeof ent.relationship_confidence === 'string'
            ? ent.relationship_confidence.toLowerCase() === 'high'
            : relConf >= 0.85;
        createEntry(type, content.slice(0, 200), {
            confidence: Math.max(0.5, relConf),
            source_quality: isHighConf ? 'direct_statement' : 'inferred',
            entity_ids: [ent.id],
            migration_source: 'entity_profiles',
            source_fragment_ids: safeParseJson(ent.source_fragment_ids).slice(0, 30),
        });
        if (type === 'immutable_fact') created.immutable_fact++;
        else created.stable_trait++;
    }

    console.log(`[UserModel] 播種完成: immutable_fact=${created.immutable_fact} stable_trait=${created.stable_trait} active_hypothesis=${created.active_hypothesis}`);
    return { created };
}

module.exports = {
    seedFromExisting,
};
