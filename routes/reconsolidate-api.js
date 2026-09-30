'use strict';
// H1：星圖側欄的「再鞏固」操作——使用者在「看到一條記憶」的當下確認、否認或修改它。
//
// POST /api/memory/reconsolidate/confirm  { type, id, entityId? }
// POST /api/memory/reconsolidate/deny     { type, id, entityId?, content? }   有 content ＝ 修改
// POST /api/memory/reconsolidate/modify   { type, id, entityId?, content }
//   type：'fragment'（碎片，星圖上的星）｜'episode'（敘事，memories 表）
//   id：整數，或 'f12'／'fragment_12'／'episode_5'（前綴必須與 type 相符）
//
// 全程不經 LLM：使用者親手指出的錯誤比任何自動比對都可靠。
// 一律透過舊路徑 require 服務（G5 把 services/ 搬進 services/hippocampus/ 前後都可用）。
// 瀏覽星圖不算回想（G4）：只有使用者明確按「確認」才會累加 cited_count。

const express = require('express');
const { getDb } = require('../database');
const { requireAuth } = require('./auth');
const { sealField } = require('../services/memoryCrypto');
const { recordCorrection } = require('../services/correction');
const { markCited } = require('../services/recallGate');
const { STAR_COLUMNS, formatStar } = require('../utils/starFormat');

const router = express.Router();

const MAX_CONTENT_CHARS = 300;
const CONFIRM_DEDUP_MINUTES = 10;
const FRAGMENT_STATES = ['active', 'consolidated', 'cooling', 'frozen'];
const DENY_NOTE = '（使用者在星圖否認此記憶，未提供正確內容）';

class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

// ── 驗證 ──
function parseTarget(body) {
    const b = body || {};
    const type = b.type;
    if (type !== 'fragment' && type !== 'episode') throw new ApiError(400, 'type 必須是 fragment（碎片）或 episode（敘事）。');
    let raw = b.id;
    if (typeof raw === 'string') {
        const m = raw.trim().match(/^(?:(f|fragment_|episode_))?(\d+)$/i);
        if (!m) throw new ApiError(400, '記憶編號格式不正確。');
        const prefix = (m[1] || '').toLowerCase();
        if (prefix === 'episode_' && type !== 'episode') throw new ApiError(400, '編號前綴與記憶型別不符。');
        if ((prefix === 'f' || prefix === 'fragment_') && type !== 'fragment') throw new ApiError(400, '編號前綴與記憶型別不符。');
        raw = m[2];
    }
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, '記憶編號必須是正整數。');
    let entityId = null;
    if (b.entityId != null && b.entityId !== '') {
        const s = String(b.entityId).replace(/^e/i, '');
        entityId = Number(s);
        if (!Number.isSafeInteger(entityId) || entityId <= 0) throw new ApiError(400, '星座編號格式不正確。');
    }
    return { type, id, entityId };
}

function parseContent(body, { required }) {
    const c = body ? body.content : undefined;
    if (c == null) {
        if (required) throw new ApiError(400, '請輸入正確的內容。');
        return null;
    }
    if (typeof c !== 'string') throw new ApiError(400, '內容必須是文字。');
    const text = c.trim();
    if (!text) {
        if (required) throw new ApiError(400, '內容不可為空白。');
        return null;
    }
    if ([...text].length > MAX_CONTENT_CHARS) throw new ApiError(400, `內容過長（上限 ${MAX_CONTENT_CHARS} 字）。`);
    return text;
}

// ── 讀取目標 ──
function loadStar(db, fragmentId, entityId) {
    const row = db.prepare(`
        SELECT ${STAR_COLUMNS}, mf.entity, fe.relation
        FROM memory_fragments mf
        LEFT JOIN fragment_entities fe ON fe.fragment_id = mf.id AND fe.entity_id = COALESCE(?, mf.entity_id)
        WHERE mf.id = ?
    `).get(entityId, fragmentId);
    return row || null;
}

function requireTarget(db, { type, id, entityId }) {
    if (type === 'fragment') {
        const row = loadStar(db, id, entityId);
        if (!row) throw new ApiError(404, `找不到碎片 #${id}。`);
        if (!FRAGMENT_STATES.includes(row.lifecycle)) throw new ApiError(409, `碎片 #${id} 已封存或刪除，無法再操作。`);
        if (entityId != null) {
            const linked = db.prepare('SELECT 1 FROM fragment_entities WHERE fragment_id = ? AND entity_id = ?').get(id, entityId);
            if (!linked) throw new ApiError(400, '這條碎片不屬於指定的星座。');
        }
        return row;
    }
    const ep = db.prepare('SELECT id, title, content, weight, layer, entity_id, last_accessed_at, valid_from FROM memories WHERE id = ?').get(id);
    if (!ep) throw new ApiError(404, `找不到敘事 #${id}。`);
    if (ep.layer !== 'episode' && ep.layer !== 'cooling') throw new ApiError(409, `記憶 #${id} 不是敘事，無法操作。`);
    if (entityId != null && ep.entity_id !== entityId) throw new ApiError(400, '這條敘事不屬於指定的星座。');
    return ep;
}

function episodeState(db, id) {
    const ep = db.prepare('SELECT id, weight, layer, last_accessed_at FROM memories WHERE id = ?').get(id);
    const n = db.prepare("SELECT COUNT(*) AS c FROM reconsolidation_log WHERE action = 'confirm' AND target_type = 'episode' AND target_id = ?").get(id).c;
    return {
        type: 'episode', id, weight: ep.weight,
        lifecycle: ep.layer === 'cooling' ? 'cooling' : 'active',
        lastAccessedAt: ep.last_accessed_at || null, confirmations: n,
    };
}

function stateOf(db, target) {
    if (target.type === 'episode') return episodeState(db, target.id);
    return { type: 'fragment', ...formatStar(loadStar(db, target.id, target.entityId)) };
}

function logAction(db, action, target, extra = {}) {
    return db.prepare('INSERT INTO reconsolidation_log (action, target_type, target_id, new_fragment_id, correction_id) VALUES (?, ?, ?, ?, ?)')
        .run(action, target.type, target.id, extra.newFragmentId || null, extra.correctionId || null).lastInsertRowid;
}

// ── 三個操作 ──
function doConfirm(db, target) {
    const rec = db.prepare(`SELECT 1 FROM reconsolidation_log
        WHERE action = 'confirm' AND target_type = ? AND target_id = ? AND created_at >= datetime('now', ?) LIMIT 1`)
        .get(target.type, target.id, `-${CONFIRM_DEDUP_MINUTES} minutes`);
    if (rec) return { deduped: true };
    db.transaction(() => {
        if (target.type === 'fragment') {
            markCited([{ id: target.id, source_table: 'fragment' }], db);   // cited_count +1、last_accessed_at = 現在
            // 使用者明確說「這沒錯」：冷卻／凍結的記憶回到活躍（再鞏固＝重新被穩固）
            db.prepare("UPDATE memory_fragments SET status = 'active', lifecycle_updated_at = datetime('now') WHERE id = ? AND status IN ('cooling', 'frozen')").run(target.id);
        } else {
            db.prepare("UPDATE memories SET last_accessed_at = datetime('now'), layer = CASE WHEN layer = 'cooling' THEN 'episode' ELSE layer END WHERE id = ?").run(target.id);
        }
        logAction(db, 'confirm', target);
    })();
    return { deduped: false };
}

function coolTarget(db, target) {
    if (target.type === 'fragment') {
        db.prepare("UPDATE memory_fragments SET status = 'cooling', lifecycle_updated_at = datetime('now') WHERE id = ?").run(target.id);
    } else {
        db.prepare("UPDATE memories SET layer = 'cooling' WHERE id = ?").run(target.id);
    }
}

function oldSummary(row) {
    return String(row.content || row.title || '').slice(0, 100) || '（空白記憶）';
}

function doDeny(db, target, row) {
    return db.transaction(() => {
        coolTarget(db, target);   // 必須先於 recordCorrection：它不會把 cooling 的碎片蓋回 consolidated
        const correctionId = recordCorrection({
            targetType: target.type === 'episode' ? 'memory' : 'fragment',
            targetId: target.id, wrongSummary: oldSummary(row), correctSummary: DENY_NOTE, source: 'starmap',
        });
        logAction(db, 'deny', target, { correctionId });
        return { correctionId };
    })();
}

function doModify(db, target, row, text) {
    let entityId = target.entityId;
    let entityName = null;
    if (target.type === 'fragment') {
        entityId = entityId || row.entity_id || (db.prepare('SELECT entity_id FROM fragment_entities WHERE fragment_id = ? ORDER BY confidence DESC LIMIT 1').get(target.id) || {}).entity_id || null;
        entityName = row.entity;
    } else {
        entityId = entityId || row.entity_id || null;
    }
    if (entityId) {
        const ent = db.prepare('SELECT name FROM entity_profiles WHERE id = ?').get(entityId);
        if (ent) entityName = ent.name;
    }
    if (!entityName) entityName = require('../services/nameResolver').USER.name;
    const today = new Date().toISOString().slice(0, 10);
    return db.transaction(() => {
        coolTarget(db, target);
        const info = db.prepare(`
            INSERT INTO memory_fragments (type, entity, content, quote, emotional_weight, source, source_date, source_msg_ids, layer, status, entity_id, source_memory_id)
            VALUES ('correction', ?, ?, ?, 0.7, 'starmap', ?, '[]', 'event', 'active', ?, ?)
        `).run(entityName, sealField('memory_fragments', 'content', text), sealField('memory_fragments', 'quote', text), today,
            entityId, target.type === 'episode' ? target.id : null);
        const newId = Number(info.lastInsertRowid);
        if (entityId) {
            db.prepare("INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by, relation) VALUES (?, ?, 1.0, 'starmap', '使用者修正')").run(newId, entityId);
            db.prepare('UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?').run(entityId, entityId);
        }
        const correctionId = recordCorrection({
            targetType: target.type === 'episode' ? 'memory' : 'fragment',
            targetId: target.id, wrongSummary: oldSummary(row), correctSummary: text.slice(0, 200), source: 'starmap',
        });
        logAction(db, 'modify', target, { newFragmentId: newId, correctionId });
        return { newId, correctionId, entityId, entityName };
    })();
}

// 新碎片進向量庫（盡力而為；失敗不影響修改本身，與 createCoreFragment 同一慣例）
async function indexNewFragment(newId, text, entityName) {
    try {
        const { USER } = require('../services/nameResolver');
        await require('../services/memory').chromaDBOperation('index_batch', {
            items: [{
                id: `fragment_${newId}`, text: `${USER.name}: ${text}`,
                metadata: { type: 'correction', entity: entityName, content: text, source: 'starmap', fragment_id: newId },
            }],
        });
    } catch (e) {
        console.error(`[reconsolidate] ChromaDB 索引失敗 fragment_${newId}:`, e.message);
    }
}

// ── 路由 ──
async function handle(action, req, res) {
    try {
        const target = parseTarget(req.body);
        const text = parseContent(req.body, { required: action === 'modify' });
        const db = getDb();
        const row = requireTarget(db, target);

        // 否認 + 有正確內容 ＝ 修改
        const effective = action === 'deny' && text ? 'modify' : action;

        if (effective === 'confirm') {
            const r = doConfirm(db, target);
            return res.json({ ok: true, action: 'confirm', deduped: r.deduped, state: stateOf(db, target) });
        }
        if (effective === 'deny') {
            const r = doDeny(db, target, row);
            return res.json({ ok: true, action: 'deny', correctionId: r.correctionId, state: stateOf(db, target) });
        }
        const r = doModify(db, target, row, text);
        await indexNewFragment(r.newId, text, r.entityName);
        const star = formatStar(loadStar(db, r.newId, r.entityId), {});
        return res.json({
            ok: true, action: 'modify', correctionId: r.correctionId,
            state: stateOf(db, target), newStar: star, conId: r.entityId ? 'e' + r.entityId : null,
        });
    } catch (e) {
        if (e instanceof ApiError) return res.status(e.status).json({ error: e.message });
        console.error(`[reconsolidate] ${action} 失敗:`, e.message);
        return res.status(500).json({ error: '操作失敗，請稍後再試。' });
    }
}

for (const action of ['confirm', 'deny', 'modify']) {
    router.post(`/api/memory/reconsolidate/${action}`, requireAuth, (req, res) => handle(action, req, res));
}

module.exports = router;
module.exports.MAX_CONTENT_CHARS = MAX_CONTENT_CHARS;
