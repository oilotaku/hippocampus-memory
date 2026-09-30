// =================================================================
// services/persona/relationship.js — 關係層（從 user_model 的 stable_trait 慢慢長出來）
//
// 一條特質要「≥N 條獨立證據（不同碎片）且跨 ≥M 個不同日期」才會產生 persona 提案；
// 提案預設自動套用（persona.auto_apply），每 7 天最多自動套用 weekly_apply_limit 項；
// 關掉 auto_apply 就一律停在 pending 等人工審核（API：routes/persona-api.js）。
// 套用 = 把該特質的一行文字加進關係層，寫進 persona_model 的 relationship section，
// 並在 persona_relationship_versions 留下完整快照（可查歷史、可回滾）。
//
// 關係層內容 = 一行一項；提案 diff 存的是 { before, after, added } 三段文字。
// =================================================================

const { getDb } = require('../../database');
const { sealField } = require('../memoryCrypto');
const { toTraditionalChars } = require('../../utils/zhNormalize');
const { getPersonaConfig } = require('./config');
const { logPersonaEvent } = require('./events');

const SECTION = 'relationship';
const WEEK_MS = 7 * 24 * 3600 * 1000;
const MAX_LINE_CHARS = 200;

const fmt = (d) => d.toISOString().replace('T', ' ').slice(0, 19);   // 與 SQLite datetime('now') 同格式（UTC）
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS);

/** 比對用鍵：簡繁逐字正規化、去掉空白與標點（只用於去重比對，不顯示）。 */
function normKey(s) {
    return toTraditionalChars(String(s || '')).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function linesOf(content) {
    return String(content || '').split('\n').map(l => l.trim()).filter(Boolean);
}

// ── 版本 ─────────────────────────────────────────────

/** 目前生效的關係層；還沒有任何版本 = 版本 0、空內容。 */
function getActiveRelationship() {
    const row = getDb().prepare('SELECT * FROM persona_relationship_versions WHERE active = 1 ORDER BY version DESC LIMIT 1').get();
    if (!row) return { id: null, version: 0, content: '', lines: [], drift_passed: 1 };
    return { id: row.id, version: row.version, content: row.content || '', lines: linesOf(row.content), drift_passed: row.drift_passed, source: row.source };
}

function listRelationshipVersions(limit = 50) {
    return getDb().prepare('SELECT id, version, content, source, proposal_id, drift_passed, active, created_at FROM persona_relationship_versions ORDER BY version DESC LIMIT ?')
        .all(Math.max(1, Math.min(200, parseInt(limit, 10) || 50)));
}

/** 寫入新的關係層快照並設為生效；同步 persona_model。整段一個交易。 */
function setRelationship(content, { source, proposalId = null, driftPassed = null } = {}) {
    const db = getDb();
    const text = linesOf(content).join('\n');
    return db.transaction(() => {
        const maxV = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM persona_relationship_versions').get().v;
        const version = maxV + 1;
        db.prepare('UPDATE persona_relationship_versions SET active = 0 WHERE active = 1').run();
        db.prepare(`INSERT INTO persona_relationship_versions (version, content, source, proposal_id, drift_passed, active)
                    VALUES (?, ?, ?, ?, ?, 1)`)
            .run(version, sealField('persona_relationship_versions', 'content', text), source || null, proposalId, driftPassed);
        const sealed = sealField('persona_model', 'content', text);
        db.prepare(`INSERT INTO persona_model (section, content, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(section) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`)
            .run(SECTION, sealed);
        return version;
    })();
}

// ── 證據 ─────────────────────────────────────────────

/** 一條特質的證據：source_fragment_ids 裡仍存在且有效（status=active）的不同碎片，及其涵蓋的不同日期數。 */
function collectEvidence(trait) {
    let ids = [];
    try { ids = JSON.parse(trait.source_fragment_ids || '[]'); } catch (_) { /* 壞資料視為無證據 */ }
    if (!Array.isArray(ids)) ids = [];
    ids = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) return { ids: [], days: 0 };
    const db = getDb();
    const rows = db.prepare(`SELECT id, substr(created_at, 1, 10) AS day FROM memory_fragments
        WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    return { ids: rows.map(r => r.id), days: new Set(rows.map(r => r.day).filter(Boolean)).size };
}

// ── 提案 ─────────────────────────────────────────────

/**
 * 掃描 stable_trait，證據夠的、還沒提案過的產生 pending 提案。
 * 同一條特質只提案一次（不論後來被套用、拒絕或回滾），避免被拒絕的提案每天重生。
 */
function generateProposals({ cfg } = {}) {
    const c = getPersonaConfig(cfg);
    const db = getDb();
    const traits = db.prepare(`SELECT id, content, confidence, evidence_count, source_fragment_ids FROM user_model
        WHERE type = 'stable_trait' AND status = 'active' AND confidence >= ?
        ORDER BY confidence DESC, evidence_count DESC, id`).all(c.min_confidence);
    const active = getActiveRelationship();
    const created = [];
    let insufficient = 0, existing = 0;
    for (const t of traits) {
        if (db.prepare('SELECT 1 FROM persona_proposals WHERE trait_id = ? LIMIT 1').get(t.id)) { existing++; continue; }
        const line = oneLine(t.content);
        if (!line) continue;
        const ev = collectEvidence(t);
        if (ev.ids.length < c.min_evidence || ev.days < c.min_days) { insufficient++; continue; }
        const after = [...active.lines, line].join('\n');
        const diff = JSON.stringify({ before: active.content, after, added: line });
        const info = db.prepare(`INSERT INTO persona_proposals (trait_id, content, evidence_ids, evidence_days, diff)
            VALUES (?, ?, ?, ?, ?)`).run(t.id, sealField('persona_proposals', 'content', line), JSON.stringify(ev.ids), ev.days,
            sealField('persona_proposals', 'diff', diff));
        created.push(Number(info.lastInsertRowid));
        logPersonaEvent('proposal_created', { proposal_id: Number(info.lastInsertRowid), trait_id: t.id, evidence: ev.ids.length, days: ev.days });
    }
    return { created, insufficient, existing };
}

function _parse(row) {
    if (!row) return null;
    let evidence_ids = [], diff = null;
    try { evidence_ids = JSON.parse(row.evidence_ids || '[]'); } catch (_) {}
    try { diff = row.diff ? JSON.parse(row.diff) : null; } catch (_) {}
    return { ...row, evidence_ids, diff };
}

function getProposal(id) {
    return _parse(getDb().prepare('SELECT * FROM persona_proposals WHERE id = ?').get(id));
}

function listProposals({ status = null, limit = 100 } = {}) {
    const db = getDb();
    const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
    const rows = status
        ? db.prepare('SELECT * FROM persona_proposals WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, n)
        : db.prepare('SELECT * FROM persona_proposals ORDER BY id DESC LIMIT ?').all(n);
    return rows.map(_parse);
}

/** 套用一項 pending 提案：把那一行加進關係層。回傳 { ok, version } 或 { ok:false, error }。 */
function applyProposal(id, { now = new Date(), note = null } = {}) {
    const db = getDb();
    const p = getProposal(id);
    if (!p) return { ok: false, error: '找不到提案' };
    if (p.status !== 'pending') return { ok: false, error: `提案狀態為 ${p.status}，只有 pending 可以套用` };
    const active = getActiveRelationship();
    const already = active.lines.some(l => normKey(l) === normKey(p.content));
    const lines = already ? active.lines : [...active.lines, oneLine(p.content)];
    const version = setRelationship(lines.join('\n'), { source: 'apply', proposalId: p.id });
    db.prepare(`UPDATE persona_proposals SET status = 'applied', applied_version = ?, applied_at = ?, decided_at = ?, note = COALESCE(?, note) WHERE id = ?`)
        .run(version, fmt(now), fmt(now), note, id);
    logPersonaEvent('proposal_applied', { proposal_id: id, version });
    console.log(`[Persona] 關係層套用提案 #${id} → v${version}`);
    return { ok: true, version };
}

function rejectProposal(id, { now = new Date(), note = null } = {}) {
    const p = getProposal(id);
    if (!p) return { ok: false, error: '找不到提案' };
    if (p.status !== 'pending') return { ok: false, error: `提案狀態為 ${p.status}，只有 pending 可以拒絕` };
    getDb().prepare(`UPDATE persona_proposals SET status = 'rejected', decided_at = ?, note = COALESCE(?, note) WHERE id = ?`)
        .run(fmt(now), note, id);
    logPersonaEvent('proposal_rejected', { proposal_id: id });
    return { ok: true };
}

/** 手動回滾一項已套用的提案：把它那一行從關係層拿掉（其他項不動），產生新版本。 */
function rollbackProposal(id, { now = new Date(), note = null } = {}) {
    const p = getProposal(id);
    if (!p) return { ok: false, error: '找不到提案' };
    if (p.status !== 'applied') return { ok: false, error: `提案狀態為 ${p.status}，只有 applied 可以回滾` };
    const active = getActiveRelationship();
    const key = normKey(p.content);
    const lines = active.lines.filter(l => normKey(l) !== key);
    const version = setRelationship(lines.join('\n'), { source: 'manual_rollback', proposalId: p.id, driftPassed: null });
    getDb().prepare(`UPDATE persona_proposals SET status = 'rolled_back', decided_at = ?, note = COALESCE(?, note) WHERE id = ?`)
        .run(fmt(now), note, id);
    logPersonaEvent('proposal_rolled_back', { proposal_id: id, version, reason: 'manual' });
    return { ok: true, version };
}

/** 最近 7 天內（含）已套用的提案數。 */
function appliedInLastWeek(now = new Date()) {
    return getDb().prepare(`SELECT COUNT(*) AS c FROM persona_proposals WHERE status = 'applied' AND applied_at >= ?`)
        .get(fmt(new Date(now.getTime() - WEEK_MS))).c;
}

/**
 * auto_apply 開著時，依提案順序（舊的先）自動套用，直到達到每週上限；其餘留在 pending。
 * 手動套用（API）不受每週上限限制——人工審核就是人的決定。
 */
function autoApplyPending({ cfg, now = new Date() } = {}) {
    const c = getPersonaConfig(cfg);
    if (!c.auto_apply) return { applied: [], deferred: 0, disabled: true };
    let room = c.weekly_apply_limit - appliedInLastWeek(now);
    const pending = getDb().prepare(`SELECT id FROM persona_proposals WHERE status = 'pending' ORDER BY id`).all();
    const applied = [];
    for (const { id } of pending) {
        if (room <= 0) break;
        const r = applyProposal(id, { now, note: '自動套用' });
        if (r.ok) { applied.push(id); room--; }
    }
    return { applied, deferred: pending.length - applied.length, disabled: false };
}

// ── 回滾到「上一個通過漂移檢查的版本」 ──────────────

/** 標記目前生效的版本通過漂移檢查。 */
function markActivePassed() {
    getDb().prepare('UPDATE persona_relationship_versions SET drift_passed = 1 WHERE active = 1').run();
}

/**
 * 漂移時呼叫：把目前版本標為未通過，回到「最近一個 drift_passed=1 的較舊版本」；
 * 沒有這樣的版本就回到空的關係層（出廠狀態）。內容比目前少掉的那些行，
 * 對應的 applied 提案改為 rolled_back。產生一個新版本（source='drift_rollback'）。
 */
function rollbackToLastPassed({ now = new Date() } = {}) {
    const db = getDb();
    const active = getActiveRelationship();
    if (!active.id) return { ok: false, error: '關係層沒有任何版本' };
    db.prepare('UPDATE persona_relationship_versions SET drift_passed = 0 WHERE id = ?').run(active.id);
    const target = db.prepare(`SELECT * FROM persona_relationship_versions
        WHERE drift_passed = 1 AND version < ? ORDER BY version DESC LIMIT 1`).get(active.version);
    const targetLines = target ? linesOf(target.content) : [];
    const keep = new Set(targetLines.map(normKey));
    const removed = active.lines.filter(l => !keep.has(normKey(l)));
    const version = setRelationship(targetLines.join('\n'), { source: 'drift_rollback', driftPassed: 1 });
    const rolled = [];
    for (const p of db.prepare(`SELECT id, content FROM persona_proposals WHERE status = 'applied'`).all()) {
        if (removed.some(l => normKey(l) === normKey(p.content))) {
            db.prepare(`UPDATE persona_proposals SET status = 'rolled_back', decided_at = ?, note = '漂移偵測自動回滾' WHERE id = ?`).run(fmt(now), p.id);
            rolled.push(p.id);
        }
    }
    return { ok: true, from: active.version, to_version: version, restored_from: target ? target.version : 0, rolled_back_proposals: rolled };
}

module.exports = {
    SECTION, normKey, linesOf, getActiveRelationship, listRelationshipVersions, setRelationship, collectEvidence,
    generateProposals, getProposal, listProposals, applyProposal, rejectProposal, rollbackProposal,
    appliedInLastWeek, autoApplyPending, markActivePassed, rollbackToLastPassed,
};
