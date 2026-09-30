// services/persona/events.js — 人格子系統事件紀錄（persona_events）。
// detail 只放編號、分數、計數等中性資料，不放使用者相關的文字內容（該表不加密）。
const { getDb } = require('../../database');

function logPersonaEvent(kind, detail = {}) {
    try {
        getDb().prepare('INSERT INTO persona_events (kind, detail) VALUES (?, ?)')
            .run(kind, JSON.stringify(detail));
    } catch (e) {
        console.error('[Persona] 事件寫入失敗:', e.message);
    }
}

function listPersonaEvents({ kind = null, limit = 50 } = {}) {
    const db = getDb();
    const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const rows = kind
        ? db.prepare('SELECT id, kind, detail, created_at FROM persona_events WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, n)
        : db.prepare('SELECT id, kind, detail, created_at FROM persona_events ORDER BY id DESC LIMIT ?').all(n);
    return rows.map(r => { let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch (_) {} return { ...r, detail: d }; });
}

module.exports = { logPersonaEvent, listPersonaEvents };
