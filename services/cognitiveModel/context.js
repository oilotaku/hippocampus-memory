// =================================================================
// services/cognitiveModel/context.js — 上下文注入：首次觀察時間、getModelContext、whisper 相關項
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { HYPOTHESIS_UPGRADE_EVIDENCE } = require('./constants');


// ═══════════════════════════════════════════════════════
// Context Generation for Chat
// ═══════════════════════════════════════════════════════

function resolveFirstObservedFromMessages(traits) {
    if (traits.length === 0) return;
    const db = getDb();

    // Collect all unique fragment IDs
    const allFragIds = new Set();
    for (const t of traits) {
        let ids = [];
        try { ids = JSON.parse(t.source_fragment_ids || '[]'); } catch (_) {}
        if (Array.isArray(ids)) ids.forEach(id => allFragIds.add(id));
    }
    if (allFragIds.size === 0) return;

    // Batch-query all fragments: id → { created_at, msgIds }
    const fragMap = new Map(); // fid → { created_at, msgIds }
    const fragPlaceholders = [...allFragIds].map(() => '?').join(',');
    const frags = db.prepare(`SELECT id, created_at, source_msg_ids FROM memory_fragments WHERE id IN (${fragPlaceholders})`).all(...allFragIds);
    for (const f of frags) {
        let msgIds = [];
        try { msgIds = JSON.parse(f.source_msg_ids || '[]'); } catch (_) {}
        if (!Array.isArray(msgIds)) msgIds = [];
        fragMap.set(f.id, { created_at: f.created_at, msgIds });
    }

    // Collect all unique message IDs from all traits' fragments
    const allMsgIds = new Set();
    for (const f of fragMap.values()) f.msgIds.forEach(id => allMsgIds.add(id));

    // Message ID → timestamp (only if we have message IDs to look up)
    const msgTimestamps = new Map();
    if (allMsgIds.size > 0) {
        const msgPlaceholders = [...allMsgIds].map(() => '?').join(',');
        const msgs = db.prepare(`SELECT id, timestamp FROM messages WHERE id IN (${msgPlaceholders})`).all(...allMsgIds);
        for (const m of msgs) msgTimestamps.set(m.id, m.timestamp);
    }

    // For each trait, resolve first_observed_at and latest_evidence_at from the full chain
    for (const t of traits) {
        let fragIds = [];
        try { fragIds = JSON.parse(t.source_fragment_ids || '[]'); } catch (_) {}
        if (!Array.isArray(fragIds)) fragIds = [];
        let earliest = null, latest = null;
        for (const fid of fragIds) {
            const info = fragMap.get(fid);
            if (!info) continue;
            // 1st priority: message timestamp
            for (const mid of info.msgIds) {
                const ts = msgTimestamps.get(mid);
                if (ts) {
                    if (!earliest || ts < earliest) earliest = ts;
                    if (!latest || ts > latest) latest = ts;
                }
            }
            // 2nd priority fallback: fragment created_at (old fragments may have no msg link)
            if (info.created_at) {
                if (!earliest || info.created_at < earliest) earliest = info.created_at;
                if (!latest || info.created_at > latest) latest = info.created_at;
            }
        }
        t.first_observed_at = earliest;
        t.resolved_latest_at = latest; // Always use evidence-chain time for display
    }
}


function getModelContext(maxTokens = 500) {
    const db = getDb();

    const facts = db.prepare(`
        SELECT content FROM user_model
        WHERE type = 'immutable_fact' AND status = 'active'
        ORDER BY priority DESC, confidence DESC
    `).all();

    const traits = db.prepare(`
        SELECT cm.id, cm.content, cm.confidence, cm.evidence_count, cm.source_quality,
               cm.last_evidence_at, cm.source_fragment_ids
        FROM user_model cm
        WHERE cm.type = 'stable_trait' AND cm.status = 'active'
        ORDER BY cm.confidence DESC LIMIT 10
    `).all();

    // Resolve first_observed_at from actual message timestamps (not fragment created_at)
    resolveFirstObservedFromMessages(traits);

    const states = db.prepare(`
        SELECT content, confidence, last_evidence_at, source_quality FROM user_model
        WHERE type = 'current_state' AND status = 'active'
        ORDER BY last_evidence_at DESC LIMIT 8
    `).all();

    const hyps = db.prepare(`
        SELECT content, confidence, evidence_count, last_evidence_at FROM user_model
        WHERE type = 'active_hypothesis' AND status = 'active'
        ORDER BY confidence DESC LIMIT 6
    `).all();

    if (facts.length === 0 && traits.length === 0 && states.length === 0 && hyps.length === 0) {
        return '';
    }

    const lines = ['<user_model>',
        '（以下是你通过长期观察已内化的认知，不需要再从记忆库里翻出来重复确认。）',
        ''];

    if (facts.length > 0) {
        lines.push('★ 不变事实 — 你确定知道的：');
        for (const f of facts) lines.push(`- ${f.content}`);
        lines.push('');
    }

    if (traits.length > 0) {
        lines.push('◆ 稳定特质 — 经反复观察确认：');
        for (const t of traits) {
            const inferredMark = t.source_quality === 'inferred' ? '[推断] ' : '';
            // Build time anchor from evidence chain
            const timeAnchor = [];
            if (t.first_observed_at) {
                const firstDate = new Date(t.first_observed_at);
                timeAnchor.push(`首次：${firstDate.getFullYear()}年${firstDate.getMonth()+1}月`);
            }
            if (t.resolved_latest_at || t.last_evidence_at) {
                const latestTs = t.resolved_latest_at || t.last_evidence_at;
                const daysAgo = Math.round((Date.now() - new Date(latestTs)) / (1000 * 60 * 60 * 24));
                timeAnchor.push(`最近：${daysAgo}天前`);
            }
            const anchor = timeAnchor.length > 0 ? ` — ${timeAnchor.join(' | ')}` : '';
            lines.push(`- ${inferredMark}${t.content}（置信度${t.confidence.toFixed(2)}，确认${t.evidence_count}次${anchor}）`);
        }
        lines.push('');
    }

    if (states.length > 0) {
        lines.push('● 当前状态 — 近期有效：');
        for (const s of states) {
            const daysAgo = s.last_evidence_at
                ? Math.round((Date.now() - new Date(s.last_evidence_at)) / (1000 * 60 * 60 * 24))
                : null;
            const ago = daysAgo !== null ? `${daysAgo}天前` : '近期';
            const inferredMark = s.source_quality === 'inferred' ? '[推断] ' : '';
            lines.push(`- ${inferredMark}${s.content}（最后确认：${ago}）`);
        }
        lines.push('');
    }

    if (hyps.length > 0) {
        lines.push('? 活跃假设 — 你在观察但还不确定：');
        for (const h of hyps) {
            const daysAgo = h.last_evidence_at
                ? Math.round((Date.now() - new Date(h.last_evidence_at)) / (1000 * 60 * 60 * 24))
                : null;
            const ago = daysAgo !== null ? `${daysAgo}天前` : '近期';
            lines.push(`- ${h.content}（确认${h.evidence_count}/${HYPOTHESIS_UPGRADE_EVIDENCE}次，${ago}）`);
        }
        lines.push('');
    }

    lines.push('</user_model>');

    // Rough token estimate: ~1.5 chars per token for Chinese, trim if needed
    const text = lines.join('\n');
    const estimatedTokens = text.length / 1.5;
    if (estimatedTokens > maxTokens) {
        // Trim least confident items first
        const trimmed = lines.slice(0, Math.floor(lines.length * maxTokens / estimatedTokens));
        trimmed.push('</user_model>');
        return trimmed.join('\n');
    }

    return text;
}


// ═══════════════════════════════════════════════════════
// Whisper Context — recent model changes
// ═══════════════════════════════════════════════════════

function getWhisperRelevant() {
    const db = getDb();

    const recent = db.prepare(`
        SELECT type, content, status, confidence, evidence_count, updated_at, resolve_reason
        FROM user_model
        WHERE updated_at > datetime('now', '-7 days')
          AND (status != 'active' OR type = 'stable_trait')
        ORDER BY updated_at DESC
        LIMIT 15
    `).all();

    if (recent.length === 0) return '';

    const lines = [];
    for (const r of recent) {
        if (r.status === 'resolved') {
            lines.push(`[状态过期] ${r.content}`);
        } else if (r.status === 'abandoned') {
            lines.push(`[假设放弃] ${r.content} — ${r.resolve_reason || ''}`);
        } else if (r.status === 'superseded') {
            lines.push(`[被替代] ${r.content}`);
        } else if (r.type === 'stable_trait' && r.evidence_count >= 5) {
            lines.push(`[特质强化] ${r.content}（置信度${r.confidence.toFixed(2)}，${r.evidence_count}次确认）`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : '';
}

module.exports = {
    resolveFirstObservedFromMessages,
    getModelContext,
    getWhisperRelevant,
};
