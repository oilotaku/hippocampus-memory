// =================================================================
// services/cognitiveModel/currentState.js — current_state 管理：TTL 表、到期時間計算、相似狀態比對與建立／更新
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { sqlNow, sqlTimeAhead } = require('../../utils/time');
const { createEntry } = require('./entries');


// ══════════════════════════════════════════════════════════════
// v5.4: manageCurrentState — 統一 current_state 寫入入口
//
// 被 chat_companion（manageUserState.js）和 deep_cycle（readUserRawMessages）
// 共同呼叫。處理去重、自動合併、TTL 調整和演化記錄。
//
// 規則：
//   - 同話題 active 條目 → extend（更新內容 + 延 TTL）
//   - 舊條目已過時 → resolve 舊 + create 新
//   - 在消退中 → 縮短 TTL，不新建
//   - 無匹配 → create 新條目
// ══════════════════════════════════════════════════════════════

// ── bigram tokenizer (same as manageUserState.js) ──
function _tokenizeState(text) {
    const segments = (text || '')
        .replace(/[，。、！？\n,.\s]+/g, '\n')
        .split('\n')
        .filter(s => s.length >= 2);
    const bigrams = [];
    for (const seg of segments) {
        for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
    }
    return bigrams;
}


function _bigramOverlap(a, b) {
    const setA = new Set(_tokenizeState(a));
    const tokensB = _tokenizeState(b);
    if (tokensB.length === 0) return 0;
    let overlap = 0;
    for (const bg of tokensB) { if (setA.has(bg)) overlap++; }
    return overlap / Math.max(tokensB.length, 1);
}


// ── TTL map by category ──
const STATE_TTL_MAP = {
    physical:    { hours: 8,  day: 24,  days: 72  },  // 身體狀態 3天
    emotional:   { hours: 4,  day: 12,  days: 36  },  // 情緒狀態 1.5天
    situational: { hours: 12, day: 24,  days: 72  },  // 境遇狀態 3天
    relational:  { hours: 4,  day: 12,  days: 72  },  // 關係狀態
};

const DEFAULT_TTL_HOURS = 48; // 預設 2 天


function _computeExpiresAt(category, ttlCategory) {
    const catMap = STATE_TTL_MAP[category] || STATE_TTL_MAP.emotional;
    const hours = catMap[ttlCategory] || DEFAULT_TTL_HOURS;
    if (hours === Infinity) return null;
    return sqlTimeAhead(hours * 60 * 60 * 1000);
}


/**
 * @param {string} content — 狀態內容
 * @param {object} opts
 *   created_by: 'chat_companion' | 'deep_cycle'
 *   category: 'physical'|'emotional'|'situational'|'relational'
 *   ttl_category: 'hours'|'day'|'days'|'until_event'
 *   tags: string[]
 *   source_quality: 'direct_statement'|'inferred'
 *   confidence: number
 *   extra_context: string (optional, for evolution_history)
 * @returns {{ action: 'created'|'updated'|'superseded'|'skipped', id: number, previous_id?: number }}
 */
function manageCurrentState(content, opts = {}) {
    const db = getDb();
    const {
        created_by = 'deep_cycle',
        category = 'emotional',
        ttl_category = 'day',
        tags = [],
        source_quality = 'inferred',
        confidence = 0.65,
        extra_context = '',
    } = opts;

    const expiresAt = _computeExpiresAt(category, ttl_category);
    const now = new Date();
    const nowISO = sqlNow();

    // ── Step 1: Find existing active current_state entries ──
    const activeStates = db.prepare(
        'SELECT * FROM user_model WHERE type = ? AND status = ? ORDER BY created_at DESC'
    ).all('current_state', 'active');

    // ── Step 2: Check for overlap ──
    let bestMatch = null;
    let bestScore = 0;

    for (const s of activeStates) {
        const score = _bigramOverlap(s.content, content);
        if (score > bestScore) { bestScore = score; bestMatch = s; }
    }

    // ── Step 3: Rule dispatch ──

    // v5.12: chat_companion rapid-fire guard — if same source created an entry
    // within 30 minutes, use looser keyword matching to prevent duplicate states
    // describing the same event with different wording (bigrams fail on Chinese synonyms)
    if (created_by === 'chat_companion' && bestScore < 0.8) {
        const recentCompanionEntry = activeStates.find(s =>
            s.created_by === 'chat_companion' &&
            s.created_at && (now - new Date(s.created_at + 'Z')) / (1000 * 60) < 30
        );
        if (recentCompanionEntry) {
            // Keyword-level check: extract 2+ char tokens from both contents
            const kwSplit = (text) => {
                // Split on punctuation, keep tokens >= 2 chars
                return (text || '')
                    .replace(/[，。、！？\n,.\s：:；;（）()「」【】《》""''——…]+/g, '\n')
                    .split('\n')
                    .filter(s => s.length >= 2);
            };
            const kwNew = new Set(kwSplit(content));
            const kwOld = kwSplit(recentCompanionEntry.content);
            const kwOverlap = kwOld.filter(w => kwNew.has(w)).length;

            // If they share >= 2 keyword tokens OR bigram overlap > 0.15 → treat as same topic
            if (kwOverlap >= 2 || bestScore > 0.15) {
                console.log(`[UserModel] 🛡️ chat_companion rapid-fire guard: merging into #${recentCompanionEntry.id} (kw=${kwOverlap}, bg=${Math.round(bestScore*100)}%)`);
                // Force update the recent entry
                const hist = (() => { try { return JSON.parse(recentCompanionEntry.evolution_history || '[]'); } catch(_) { return []; } })();
                hist.push({
                    type: 'rapid_merge',
                    previous: recentCompanionEntry.content.slice(0, 120),
                    trigger: extra_context || 'Companion refined within 30min window',
                    at: nowISO,
                });
                db.prepare(`UPDATE user_model SET content = ?,
                    expires_at = COALESCE(?, expires_at),
                    evolution_history = ?, evidence_count = evidence_count + 1,
                    last_evidence_at = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?`).run(
                    content.slice(0, 500),
                    expiresAt,
                    JSON.stringify(hist),
                    nowISO,
                    recentCompanionEntry.id
                );
                return { action: 'updated', id: recentCompanionEntry.id };
            }
        }
    }

    // Case A: Very high overlap (>80%) — same topic,持續中 → update
    if (bestMatch && bestScore > 0.8) {
        const prevContent = bestMatch.content.slice(0, 120);
        const hist = (() => { try { return JSON.parse(bestMatch.evolution_history || '[]'); } catch(_) { return []; } })();
        hist.push({
            type: 'extended',
            previous: prevContent,
            trigger: extra_context || `${created_by} detected continuation`,
            at: nowISO,
        });

        db.prepare(`UPDATE user_model SET content = ?,
            expires_at = COALESCE(?, expires_at),
            evolution_history = ?, evidence_count = evidence_count + 1,
            last_evidence_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`).run(
            content.slice(0, 500),
            expiresAt,
            JSON.stringify(hist),
            nowISO,
            bestMatch.id
        );

        console.log(`[UserModel] 🔄 current_state extend #${bestMatch.id} (${Math.round(bestScore*100)}% overlap, ${created_by}) → TTL ${expiresAt?.slice(0,10) || 'unchanged'}`);
        return { action: 'updated', id: bestMatch.id };
    }

    // Case B: Moderate overlap (50-80%) — topic related but內容變了 → supersede
    if (bestMatch && bestScore > 0.5) {
        const prevContent = bestMatch.content.slice(0, 120);
        const oldHist = (() => { try { return JSON.parse(bestMatch.evolution_history || '[]'); } catch(_) { return []; } })();
        oldHist.push({
            type: 'superseded',
            previous: prevContent,
            reason: extra_context || `${created_by} replaced with updated state`,
            at: nowISO,
        });

        db.prepare(`UPDATE user_model SET status = 'resolved', resolved_at = ?,
            resolve_reason = ?, evolution_history = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`).run(
            nowISO,
            `auto-superseded by ${created_by}: ${extra_context || 'state evolved'} (${Math.round(bestScore*100)}% overlap)`,
            JSON.stringify(oldHist),
            bestMatch.id
        );

        console.log(`[UserModel] 🔀 current_state supersede #${bestMatch.id} → new (${Math.round(bestScore*100)}% overlap, ${created_by})`);
        // Fall through to create new
    }

    // Case C: Low/no overlap — fresh state

    // ── Step 4: Deep cycle should NOT duplicate chat_companion ──
    if (created_by === 'deep_cycle' && activeStates.length > 0) {
        // Don't create if any chat_companion entry already covers this day's key topics
        // Simple check: if there's a chat_companion entry from today, skip
        const todayCompanionEntry = activeStates.find(s =>
            s.created_by === 'chat_companion' &&
            s.created_at && s.created_at.slice(0, 10) === nowISO.slice(0, 10)
        );
        if (todayCompanionEntry && bestScore < 0.4) {
            console.log(`[UserModel] ⏭️ deep_cycle skip: chat_companion already wrote today (#${todayCompanionEntry.id})`);
            return { action: 'skipped', id: todayCompanionEntry.id };
        }
    }

    // ── Step 5: Create new entry ──
    const hist = [{
        type: 'created',
        trigger: extra_context || `${created_by} observed new state`,
        at: nowISO,
    }];

    const id = createEntry('current_state', content.slice(0, 500), {
        confidence,
        source_quality,
        created_by,
        expires_at: expiresAt,
        tags: [...tags, 'current_state'],
        decay_params: { category, ttl_category },
        evolution_history: hist,
    });

    const previousId = (bestMatch && bestScore > 0.5) ? bestMatch.id : null;

    console.log(`[UserModel] ✨ current_state create #${id} (${created_by}) → TTL ${expiresAt?.slice(0,10) || 'none'}` +
        (previousId ? ` ← supersedes #${previousId}` : ''));
    return { action: 'created', id, previous_id: previousId };
}

module.exports = {
    _tokenizeState,
    _bigramOverlap,
    STATE_TTL_MAP,
    DEFAULT_TTL_HOURS,
    _computeExpiresAt,
    manageCurrentState,
};
