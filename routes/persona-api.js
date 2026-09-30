// routes/persona-api.js — 人格三層的查詢與審核（G3）。全部需要登入。
//
//   GET  /api/persona/status                 核心層版本、關係層現況、設定、最近一次漂移偵測
//   GET  /api/persona/core-history           核心層版本歷史（雜湊、是否已有錨點）
//   GET  /api/persona/proposals?status=      關係層提案（pending / applied / rejected / rolled_back）
//   POST /api/persona/proposals/:id/apply    套用（人工審核不受每週上限限制）
//   POST /api/persona/proposals/:id/reject   拒絕（body.note 可選）
//   POST /api/persona/proposals/:id/rollback 回滾已套用的提案
//   GET  /api/persona/relationship/versions  關係層版本快照
//   GET  /api/persona/events?kind=&limit=    漂移、提案、judgment 被擋等事件
//   GET  /api/persona/judgment/:entityId     某實體 judgment 的歷史版本
//   POST /api/persona/drift-check            立刻跑一次漂移偵測（會呼叫 LLM）

const express = require('express');
const { requireAuth } = require('./auth');
const persona = require('../services/persona');

const router = express.Router();
const STATUSES = new Set(['pending', 'applied', 'rejected', 'rolled_back']);
const publicProposal = (p) => p && ({
    id: p.id, trait_id: p.trait_id, content: p.content, evidence_ids: p.evidence_ids, evidence_days: p.evidence_days,
    diff: p.diff, status: p.status, applied_version: p.applied_version, note: p.note,
    created_at: p.created_at, applied_at: p.applied_at, decided_at: p.decided_at,
});

const wrap = (fn) => (req, res) => {
    Promise.resolve().then(() => fn(req, res)).catch(e => {
        console.error('[persona-api]', e.message);
        res.status(500).json({ success: false, error: e.message });
    });
};
const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };

router.get('/api/persona/status', requireAuth, wrap((req, res) => {
    const events = persona.listPersonaEvents({ limit: 200 });
    const lastDrift = events.find(e => e.kind === 'drift_ok' || e.kind === 'drift_detected') || null;
    const rel = persona.getActiveRelationship();
    res.json({
        success: true,
        core: (persona.getCoreHistory()[0]) || null,
        relationship: { version: rel.version, lines: rel.lines, drift_passed: rel.drift_passed },
        pending_proposals: persona.listProposals({ status: 'pending' }).length,
        applied_last_7_days: persona.appliedInLastWeek(),
        config: persona.getPersonaConfig(),
        last_drift_check: lastDrift,
    });
}));

router.get('/api/persona/core-history', requireAuth, wrap((req, res) => {
    res.json({ success: true, versions: persona.getCoreHistory() });
}));

router.get('/api/persona/proposals', requireAuth, wrap((req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !STATUSES.has(status)) return res.status(400).json({ success: false, error: '無效的 status' });
    res.json({ success: true, proposals: persona.listProposals({ status, limit: req.query.limit }).map(publicProposal) });
}));

function decide(action) {
    return wrap((req, res) => {
        const id = idOf(req);
        if (!id) return res.status(400).json({ success: false, error: '無效的提案編號' });
        const note = req.body && typeof req.body.note === 'string' ? req.body.note.slice(0, 200) : null;
        const r = action(id, { note });
        if (!r.ok) return res.status(r.error === '找不到提案' ? 404 : 409).json({ success: false, error: r.error });
        res.json({ success: true, version: r.version === undefined ? null : r.version, proposal: publicProposal(persona.getProposal(id)) });
    });
}
router.post('/api/persona/proposals/:id/apply', requireAuth, decide(persona.applyProposal));
router.post('/api/persona/proposals/:id/reject', requireAuth, decide(persona.rejectProposal));
router.post('/api/persona/proposals/:id/rollback', requireAuth, decide(persona.rollbackProposal));

router.get('/api/persona/relationship/versions', requireAuth, wrap((req, res) => {
    res.json({ success: true, versions: persona.listRelationshipVersions(req.query.limit) });
}));

router.get('/api/persona/events', requireAuth, wrap((req, res) => {
    res.json({ success: true, events: persona.listPersonaEvents({ kind: req.query.kind ? String(req.query.kind) : null, limit: req.query.limit }) });
}));

router.get('/api/persona/judgment/:entityId', requireAuth, wrap((req, res) => {
    const id = Number(req.params.entityId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: '無效的實體編號' });
    res.json({ success: true, history: persona.getJudgmentHistory(id, req.query.limit) });
}));

router.post('/api/persona/drift-check', requireAuth, wrap(async (req, res) => {
    const r = await persona.runDriftCheck();
    res.json({ success: true, result: r });
}));

module.exports = router;
