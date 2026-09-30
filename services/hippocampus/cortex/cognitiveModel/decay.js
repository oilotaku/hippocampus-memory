// =================================================================
// services/cognitiveModel/decay.js — 衰減與到期：processModelDecay、resolveExpiredStates
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { HYPOTHESIS_UPGRADE_EVIDENCE, HYPOTHESIS_ABANDON_DAYS, TRAIT_CONTRADICTION_THRESHOLD } = require('./constants');
const { safeParseJson } = require('./helpers');


// ═══════════════════════════════════════════════════════
// Decay Processing (zero LLM — pure math/SQL)
// ═══════════════════════════════════════════════════════

function processModelDecay() {
    const db = getDb();
    const now = new Date();
    const changes = { decayed: 0, resolved: 0, abandoned: 0, flagged: 0, dormant: 0, revived: 0 };

    // --- current_state: per-category TTL auto-resolve ---
    // TTL is set by readUserRawMessages based on state type:
    //   physical: hours→8h, day→24h, days→72h
    //   emotional: hours→4h, day→12h, days→36h
    //   situational: hours→12h, day→24h, days→72h, until_event→∞
    //   relational: hours→4h, day→12h, until_event→∞
    const TTL_MAP = {
        physical:    { hours: 8, day: 24, days: 72 },
        emotional:   { hours: 4, day: 12, days: 36 },
        situational: { hours: 12, day: 24, days: 72 },
        relational:  { hours: 4, day: 12, days: 72 },
    };
    const states = db.prepare(`
        SELECT id, content, created_at, expires_at, decay_params, created_by FROM user_model
        WHERE type = 'current_state' AND status = 'active'
        ORDER BY created_at ASC
    `).all();

    // ── Hard cap: max 12 active current_state entries ──
    // If exceeded, auto-resolve oldest non-chat_companion entries first
    const MAX_ACTIVE_STATES = 12;
    if (states.length > MAX_ACTIVE_STATES) {
        const excess = states.length - MAX_ACTIVE_STATES;
        // Prefer resolving old deep_cycle entries over chat_companion ones
        const toResolve = states
            .filter(s => s.created_by !== 'chat_companion')
            .slice(0, excess);
        // If not enough deep_cycle entries, also resolve oldest chat_companion ones
        if (toResolve.length < excess) {
            const chatEntries = states
                .filter(s => s.created_by === 'chat_companion')
                .slice(0, excess - toResolve.length);
            toResolve.push(...chatEntries);
        }
        for (const s of toResolve.slice(0, excess)) {
            db.prepare(`UPDATE user_model SET status = 'resolved', resolved_at = datetime('now'),
                resolve_reason = 'auto-resolved: hard cap (12 active limit)', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`).run(s.id);
            changes.resolved++;
            console.log(`[UserModel] 🧹 current_state #${s.id} 自動過期 (硬上限12條, created_by=${s.created_by})`);
        }
    }

    // Re-fetch after cap enforcement
    const activeStates = db.prepare(`
        SELECT id, content, created_at, expires_at, decay_params FROM user_model
        WHERE type = 'current_state' AND status = 'active'
    `).all();

    for (const s of activeStates) {
        // ── v5.0: explicit expires_at takes priority ──
        if (s.expires_at) {
            const expiresAt = new Date(s.expires_at);
            if (now >= expiresAt) {
                db.prepare(`UPDATE user_model SET status = 'resolved', resolved_at = datetime('now'),
                    resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(`auto-resolved: expires_at ${s.expires_at} reached`, s.id);
                changes.resolved++;
                console.log(`[UserModel] ⏰ current_state #${s.id} 到期 (expires_at=${s.expires_at})`);
            }
            continue; // explicit expires_at → skip old TTL logic
        }

        // ── Legacy: category-based TTL for entries without expires_at ──
        const dp = safeParseJson(s.decay_params);
        const category = dp?.category || 'emotional';
        const ttlCat = dp?.ttl_category || 'day';
        const catMap = TTL_MAP[category] || TTL_MAP.emotional;
        const ttlHours = catMap[ttlCat];

        // until_event → never auto-resolve (waits for explicit replacement)
        if (ttlHours === undefined || ttlHours === Infinity) continue;

        const hoursSince = (now - new Date(s.created_at)) / (1000 * 60 * 60);
        if (hoursSince >= ttlHours) {
            db.prepare(`UPDATE user_model SET status = 'resolved', resolved_at = datetime('now'),
                resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(`auto-resolved: TTL ${category}/${ttlCat} (${ttlHours}h) exceeded after ${hoursSince.toFixed(1)}h`, s.id);
            changes.resolved++;
            console.log(`[UserModel] ⏰ current_state #${s.id} 自動過期 (${category}/${ttlCat}, ${hoursSince.toFixed(0)}h/${ttlHours}h)`);
        }
    }

    // --- active_hypothesis: abandon if stale ---
    const hyps = db.prepare(`
        SELECT id, content, last_evidence_at, evidence_count, created_at
        FROM user_model WHERE type = 'active_hypothesis' AND status = 'active'
    `).all();

    for (const h of hyps) {
        const lastEv = h.last_evidence_at ? new Date(h.last_evidence_at) : new Date(h.created_at);
        const daysSince = (now - lastEv) / (1000 * 60 * 60 * 24);

        if (daysSince >= HYPOTHESIS_ABANDON_DAYS && h.evidence_count < HYPOTHESIS_UPGRADE_EVIDENCE) {
            db.prepare(`UPDATE user_model SET status = 'abandoned', resolved_at = datetime('now'),
                resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(`auto-abandoned: ${daysSince.toFixed(0)}d no evidence, only ${h.evidence_count} confirmations`, h.id);
            changes.abandoned++;
        }
    }

    // --- stable_trait: flag for review if contradictions >= threshold ---
    const traits = db.prepare(`
        SELECT id, content, confidence, last_contradiction_at, evidence_count
        FROM user_model WHERE type = 'stable_trait' AND status = 'active'
    `).all();

    for (const t of traits) {
        // Count contradictions in last 30 days
        if (!t.last_contradiction_at) continue;
        const contradictionAge = (now - new Date(t.last_contradiction_at)) / (1000 * 60 * 60 * 24);
        if (contradictionAge > 30) continue; // stale contradictions don't count

        // Check contradiction count from evolution history
        const history = db.prepare('SELECT evolution_history FROM user_model WHERE id = ?').get(t.id);
        const hist = JSON.parse(history?.evolution_history || '[]');
        const recentContradictions = hist.filter(h =>
            h.type === 'contradiction' &&
            (now - new Date(h.at)) / (1000 * 60 * 60 * 24) < 30
        ).length;

        if (recentContradictions >= TRAIT_CONTRADICTION_THRESHOLD) {
            // Flag for LLM review — don't auto-downgrade
            db.prepare(`UPDATE user_model SET tags = ?, priority = MAX(priority, 5),
                updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify([...new Set([...JSON.parse(t.tags || '[]'), 'needs_review'])]), t.id);
            changes.flagged++;
        }
    }

    // --- stable_trait: dormant/revive based on evidence freshness ---
    const dormantCheck = db.prepare(`
        SELECT id, last_evidence_at, tags FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
    `).all();

    for (const t of dormantCheck) {
        const tags = safeParseJson(t.tags);
        const daysSince = t.last_evidence_at
            ? (now - new Date(t.last_evidence_at)) / (1000 * 60 * 60 * 24)
            : 999;

        if (daysSince > 14 && !tags.includes('dormant')) {
            tags.push('dormant');
            db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify(tags), t.id);
            changes.dormant++;
            console.log(`[UserModel] 💤 trait #${t.id} 標記 dormant (${daysSince.toFixed(0)}天無證據)`);
        } else if (daysSince <= 14 && tags.includes('dormant')) {
            const revived = tags.filter(tag => tag !== 'dormant');
            db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(JSON.stringify(revived), t.id);
            changes.revived++;
            console.log(`[UserModel] 🌱 trait #${t.id} 復活 (${daysSince.toFixed(0)}天前有新證據)`);
        }
    }

    if (changes.decayed + changes.resolved + changes.abandoned + changes.flagged + changes.dormant + changes.revived > 0) {
        console.log(`[UserModel] 衰減處理: decayed=${changes.decayed} resolved=${changes.resolved} abandoned=${changes.abandoned} flagged=${changes.flagged} dormant=${changes.dormant} revived=${changes.revived}`);
    }

    return changes;
}


// ═══════════════════════════════════════════════════════
// Resolve Expired States (pure SQL)
// ═══════════════════════════════════════════════════════

function resolveExpiredStates() {
    const db = getDb();
    // current_state older than 14 days with no evidence → resolve
    const result = db.prepare(`
        UPDATE user_model SET status = 'resolved', resolved_at = datetime('now'),
            resolve_reason = 'auto-resolved: stale current_state',
            updated_at = CURRENT_TIMESTAMP
        WHERE type = 'current_state' AND status = 'active'
          AND (last_evidence_at IS NULL AND created_at < datetime('now', '-14 days')
               OR last_evidence_at < datetime('now', '-14 days'))
    `).run();
    if (result.changes > 0) {
        console.log(`[UserModel] 過期狀態自動 resolved: ${result.changes}`);
    }
    return result.changes;
}

module.exports = {
    processModelDecay,
    resolveExpiredStates,
};
