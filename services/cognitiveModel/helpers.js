// =================================================================
// services/cognitiveModel/helpers.js — 共用小工具：認知模型 system prompt、訊息純文字抽取、安全 JSON 解析
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { WORLD_CONTEXT } = require('../worldContext');
const { encryption } = require('../../encryption');
const { getCompanionPersonaBase } = require('../companionPersona');


// v5.10: 增强版 system prompt — Companion 人格 + User 画像
// 供 detectNewTraits / readUserRawMessages 等需要深度理解 {{user.name}} 的 LLM 调用使用
function _buildModelSystemPrompt() {
    let sp = WORLD_CONTEXT + '\n\n---\n\n';
    // Companion 人格
    const persona = getCompanionPersonaBase();
    if (persona) sp += persona + '\n\n---\n\n';
    // {{user.name}} 现有画像摘要
    try {
        const { assembleProfile } = require('../userProfile');
        const profile = assembleProfile(300);
        if (profile) sp += profile;
    } catch (_) {}
    return sp;
}


// ═══════════════════════════════════════════════════════
// Helper: extract plain text from message content
// Handles: encrypted JSON → decrypt → parse components → plain text
// ═══════════════════════════════════════════════════════

function extractMessageText(rawContent) {
    if (!rawContent) return '';
    let text = rawContent;

    // 1. Decrypt if encrypted
    if (text.startsWith('enc:')) {
        try { text = encryption.decrypt(text, { silent: true }); } catch (_) { return ''; }
        if (text === null) return '';
    }

    // 2. Parse JSON components if present
    if (text.startsWith('{') && text.includes('"components"')) {
        try {
            const parsed = JSON.parse(text);
            if (parsed.components && Array.isArray(parsed.components)) {
                text = parsed.components
                    .filter(c => c.type === 'text' && c.content)
                    .map(c => c.content)
                    .join(' ');
            }
        } catch (_) { /* not JSON, use as-is */ }
    }

    return text.trim();
}


function safeParseJson(str) {
    try { return JSON.parse(str); } catch { return []; }
}

module.exports = {
    _buildModelSystemPrompt,
    extractMessageText,
    safeParseJson,
};
