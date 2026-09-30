// =================================================================
// services/cognitiveModel/entries.js — CRUD：建立、更新、結案、放棄、取代、更正
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { sqlTimeAhead, DAY_MS } = require('../../../../utils/time');


// ═══════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════

function createEntry(type, content, opts = {}) {
    const db = getDb();
    const {
        confidence = 0.3,
        decay_type = null,
        decay_params = {},
        source_fragment_ids = [],
        entity_ids = [],
        parent_skill_id = null,
        migration_source = null,
        tags = [],
        priority = 0,
        source_quality = 'inferred', // direct_statement | inferred | backfilled
        source_diversity = 1,        // number of independent source batches
        created_by = 'deep_cycle',   // v5.0: chat_companion | deep_cycle
        expires_at = null,           // v5.0: ISO 8601 timestamp for explicit TTL
    } = opts;

    // Infer decay_type from entry type if not specified
    const effectiveDecay = decay_type || {
        immutable_fact: 'none',
        stable_trait: 'evidence_dependent',
        current_state: 'exponential',
        active_hypothesis: 'evidence_dependent',
    }[type] || null;

    // Adjust initial confidence based on source_quality
    let effectiveConfidence = confidence;
    if (source_quality === 'direct_statement') {
        // Direct statement from user: high starting confidence
        const directCaps = { immutable_fact: 0.99, stable_trait: 0.85, current_state: 0.95, active_hypothesis: 0.75 };
        effectiveConfidence = Math.min(directCaps[type] || 0.85, confidence + 0.15);
    } else if (source_quality === 'inferred') {
        // LLM-inferred: cap at 0.70 — needs independent confirmation
        effectiveConfidence = Math.min(0.70, confidence);
    }

    // v5.0: expires_at hard cap — max 90 days from now
    if (expires_at) {
        const maxExpiry = sqlTimeAhead(90 * DAY_MS);
        if (expires_at > maxExpiry) {
            console.log(`[UserModel] ⚠️ expires_at ${expires_at} exceeds 90d cap, clamping to ${maxExpiry}`);
            expires_at = maxExpiry;
        }
    }

    const result = db.prepare(`
        INSERT INTO user_model (type, content, confidence, decay_type, decay_params,
            source_fragment_ids, entity_ids, parent_skill_id, migration_source, tags, priority,
            source_quality, source_diversity, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        type, content, effectiveConfidence, effectiveDecay,
        JSON.stringify(decay_params),
        JSON.stringify(source_fragment_ids),
        JSON.stringify(entity_ids),
        parent_skill_id, migration_source,
        JSON.stringify(tags), priority,
        source_quality, source_diversity,
        created_by, expires_at
    );

    console.log(`[UserModel] 建立 ${type}[${source_quality}][${created_by}]: "${content.slice(0, 60)}" (id=${result.lastInsertRowid}, conf=${effectiveConfidence.toFixed(2)})`);
    return result.lastInsertRowid;
}


function updateEntry(id, updates) {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM user_model WHERE id = ?').get(id);
    if (!existing) return null;

    const allowed = ['content', 'confidence', 'decay_type', 'decay_params',
        'source_fragment_ids', 'entity_ids', 'tags', 'priority', 'status', 'parent_skill_id',
        'created_by', 'expires_at', 'schedule'];
    const sets = [];
    const vals = [];

    for (const [k, v] of Object.entries(updates)) {
        if (!allowed.includes(k)) continue;
        sets.push(`${k} = ?`);
        vals.push(v === null ? null : (typeof v === 'object' ? JSON.stringify(v) : v));
    }

    if (sets.length === 0) return null;

    // Track evolution for trait updates
    if (existing.type === 'stable_trait' && updates.content && updates.content !== existing.content) {
        const history = JSON.parse(existing.evolution_history || '[]');
        history.push({
            previous: existing.content,
            updated: updates.content,
            confidence_before: existing.confidence,
            confidence_after: updates.confidence ?? existing.confidence,
            at: new Date().toISOString(),
        });
        sets.push('evolution_history = ?');
        vals.push(JSON.stringify(history));
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(id);

    db.prepare(`UPDATE user_model SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return true;
}


function resolveEntry(id, reason = '') {
    const db = getDb();
    db.prepare(`UPDATE user_model SET status = 'resolved', resolved_at = datetime('now'),
        resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reason, id);
}


function abandonEntry(id, reason = '') {
    const db = getDb();
    db.prepare(`UPDATE user_model SET status = 'abandoned', resolved_at = datetime('now'),
        resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reason, id);
}


function supersedeEntry(id, newId, reason = '') {
    const db = getDb();
    db.prepare(`UPDATE user_model SET status = 'superseded', superseded_by = ?,
        resolved_at = datetime('now'), resolve_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(newId, reason, id);
}


function correctEntry(id, newContent) {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM user_model WHERE id = ?').get(id);
    if (!existing) return null;

    const history = JSON.parse(existing.evolution_history || '[]');
    history.push({
        previous: existing.content,
        corrected_to: newContent,
        at: new Date().toISOString(),
    });

    db.prepare(`UPDATE user_model SET status = 'corrected', content = ?,
        evolution_history = ?, resolved_at = datetime('now'), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(newContent, JSON.stringify(history), id);
    return true;
}

module.exports = {
    createEntry,
    updateEntry,
    resolveEntry,
    abandonEntry,
    supersedeEntry,
    correctEntry,
};
