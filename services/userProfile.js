// services/userProfile.js
// v5.4 Phase 2b: User 畫像組裝
//
// 從認知模型中讀取活躍條目，按分類組裝為可注入 system prompt 的文本塊。
// 替代 core-prompt.txt 中手動維護的 <使用者核心資訊>。

const { getDb } = require('../database');
const { fillPrompt, USER, AI } = require('./nameResolver');

// ── 分類標籤 → 顯示名稱 ──
const CATEGORY_ORDER = [
    { key: 'basic',                label: '基本資訊' },
    { key: 'personality',          label: '性格' },
    { key: 'career',               label: '職業' },
    { key: 'social',               label: '社交關係' },
    { key: 'preference',           label: '偏好' },
    { key: 'lifestyle',            label: '生活方式' },
    { key: 'health',               label: '健康' },
    { key: 'creative_work',        label: '創作' },
    { key: 'personal_history',     label: '過去經歷' },
    { key: 'relationship_with_companion', label: '與伴侶的關係' },
    { key: 'finance',              label: '經濟' },
    { key: 'communication',        label: '溝通風格' },
];

const SUB_TAGS = new Set([
    'identity','birth','appearance','education','mbti','core',
    'persistence','romantic','living','pets',
    'aesthetic','fandom','food','recent','hobbies','sleep','creative',
    'health_tech','home','bond','devotion','trauma','current',
]);

// ── Public API ──

/**
 * 組裝 User 畫像文本（用於注入 system prompt）
 * @param {number} maxTokens — 預算上限（估算）
 * @returns {string} 格式化的畫像文本
 */
function assembleProfile(maxTokens = 500) {
    const db = getDb();
    const entries = db.prepare(`
        SELECT id, type, content, tags, confidence, source_quality,
               evidence_count, last_evidence_at, created_at
        FROM user_model
        WHERE status = 'active'
          AND type IN ('stable_trait', 'immutable_fact')
          AND confidence >= 0.5
        ORDER BY priority DESC, confidence DESC, created_at
    `).all();

    if (!entries.length) return '';

    // Assign injection tiers
    for (const e of entries) {
        if ((e.source_diversity || 0) >= 5 && (e.evidence_count || 0) >= 30) {
            e.injection_tier = 'core';
        } else if ((e.source_diversity || 0) >= 3) {
            e.injection_tier = 'high';
        } else {
            e.injection_tier = 'normal';
        }
    }

    // Group by category
    const groups = {};
    for (const e of entries) {
        let tags = [];
        try { tags = typeof e.tags === 'string' ? JSON.parse(e.tags) : (e.tags || []); } catch(_) {}
        // Skip companion profile entries — they belong in persona_model, not the user's portrait
        if (tags.includes('companion_profile')) continue;
        // Skip companion's intuitive observations — personal intuitions, not objective user facts
        if (tags.includes('companion_intuition')) continue;
        const cat = _primaryCategory(tags);
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(e);
    }

    // Assemble text
    const lines = [];
    lines.push(`<User_profile>`);

    // Core traits first (鐵證級 — 始終在伴侶視野中)
    const coreTraits = entries.filter(e => e.injection_tier === 'core');
    if (coreTraits.length > 0) {
        lines.push('\n[核心認知 — 以下條目經反覆驗證，置信度極高]');
        for (const e of coreTraits) {
            lines.push(`- ${e.content}`);
        }
    }

    for (const { key, label } of CATEGORY_ORDER) {
        const items = groups[key];
        if (!items || !items.length) continue;
        delete groups[key]; // mark as consumed

        // Don't repeat core traits in their category section
        const nonCore = items.filter(e => e.injection_tier !== 'core');
        if (!nonCore.length) continue;

        lines.push(`\n[${label}]`);
        for (const e of nonCore) {
            // Mark stale entries
            const staleMarker = _isStale(e) ? ' [可能過時]' : '';
            const tierMarker = e.injection_tier === 'high' ? ' ★' : '';
            lines.push(`- ${e.content}${tierMarker}${staleMarker}`);
        }

        // Early exit if approaching token budget
        if (lines.join('\n').length > maxTokens * 3) break;
    }

    // Any remaining categories not in CATEGORY_ORDER
    for (const [cat, items] of Object.entries(groups)) {
        if (!items || !items.length) continue;
        lines.push(`\n[${cat}]`);
        for (const e of items) {
            lines.push(`- ${e.content}${_isStale(e) ? ' [可能過時]' : ''}`);
        }
    }

    lines.push('</User_profile>');
    return lines.join('\n');
}

/**
 * 組裝 User 畫像 JSON（用於前端編輯器 API）
 * @returns {object} { groups: [{ category, label, entries: [...] }] }
 */
function assembleProfileJSON() {
    const db = getDb();
    const entries = db.prepare(`
        SELECT id, type, content, tags, confidence, source_quality,
               evidence_count, last_evidence_at, created_at, updated_at
        FROM user_model
        WHERE status = 'active'
          AND type IN ('stable_trait', 'immutable_fact')
        ORDER BY priority DESC, confidence DESC, created_at
    `).all();

    const groups = {};
    for (const e of entries) {
        let tags = [];
        try { tags = typeof e.tags === 'string' ? JSON.parse(e.tags) : (e.tags || []); } catch(_) {}
        // Skip companion profile entries — they belong in persona_model, not the user's portrait
        if (tags.includes('companion_profile')) continue;
        // Skip companion's intuitive observations — personal intuitions, not objective user facts
        if (tags.includes('companion_intuition')) continue;
        const cat = _primaryCategory(tags);
        if (!groups[cat]) groups[cat] = { category: cat, label: _categoryLabel(cat), entries: [] };
        groups[cat].entries.push({
            id: e.id,
            type: e.type,
            content: e.content,
            tags,
            confidence: e.confidence,
            source_quality: e.source_quality,
            evidence_count: e.evidence_count,
            stale: _isStale(e),
            created_at: e.created_at,
            updated_at: e.updated_at,
        });
    }

    return { groups: Object.values(groups) };
}

// ── Helpers ──

function _primaryCategory(tags) {
    if (!Array.isArray(tags) || !tags.length) return 'other';
    // Find first tag that's a valid category (not a sub-tag)
    const cat = tags.find(t =>
        CATEGORY_ORDER.some(c => c.key === t) && !SUB_TAGS.has(t)
    );
    if (cat) return cat;
    // Fallback: first category-matching tag
    const anyCat = tags.find(t => CATEGORY_ORDER.some(c => c.key === t));
    return anyCat || tags[0] || 'other';
}

function _categoryLabel(key) {
    const found = CATEGORY_ORDER.find(c => c.key === key);
    return found ? found.label : key;
}

function _isStale(entry) {
    // Entries with no new evidence in 90+ days
    if (!entry.last_evidence_at) {
        // Check created_at instead
        if (!entry.created_at) return false;
        const created = new Date(entry.created_at);
        return (Date.now() - created) > 90 * 24 * 60 * 60 * 1000;
    }
    const last = new Date(entry.last_evidence_at);
    return (Date.now() - last) > 90 * 24 * 60 * 60 * 1000;
}

module.exports = { assembleProfile, assembleProfileJSON };
