// routes/emotion-api.js — 情緒引擎查詢（唯讀，需登入）
//   GET /api/emotion/baseline          使用者目前各維基準、時段基準、OU 狀態；有效樣本不足時 learning=true
//   GET /api/emotion/entities          實體 × 情緒統計（?dim=anger&limit=20&min_n=3）
//   GET /api/emotion/topic-slots       話題（實體類別）× 時段的情緒分布
//   GET /api/emotion/anniversaries     過去同月同日的事件與當時情緒（?date=YYYY-MM-DD，預設今天）
//   GET /api/emotion/events            事件預期與實際反應（?since=&until=）
const express = require('express');
const { getDb } = require('../database');
const { requireAuth } = require('./auth');
const emotion = require('../services/emotion');

const router = express.Router();
const intParam = (v, d, max) => Math.min(max, Math.max(1, parseInt(v, 10) || d));

router.get('/api/emotion/baseline', requireAuth, (req, res) => {
    try { res.json({ success: true, ...emotion.getBaselineStatus(getDb()) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/api/emotion/entities', requireAuth, (req, res) => {
    try {
        const dim = req.query.dim ? String(req.query.dim) : undefined;
        if (dim && !emotion.DIMS.includes(dim)) return res.status(400).json({ success: false, error: `dim 需為 ${emotion.DIMS.join('/')}` });
        const items = emotion.getEntityEmotions(getDb(), {
            dim, limit: intParam(req.query.limit, 50, 200), minN: Math.max(0, parseFloat(req.query.min_n) || 0),
        });
        res.json({ success: true, count: items.length, items });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/api/emotion/topic-slots', requireAuth, (req, res) => {
    try { res.json({ success: true, topics: emotion.getTopicSlotDistribution(getDb()) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/api/emotion/anniversaries', requireAuth, (req, res) => {
    try {
        const date = req.query.date ? String(req.query.date) : undefined;
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'date 格式需為 YYYY-MM-DD' });
        const items = emotion.getAnniversaries(getDb(), date || new Date(), { limit: intParam(req.query.limit, 20, 100) });
        res.json({ success: true, count: items.length, items });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/api/emotion/events', requireAuth, (req, res) => {
    try {
        const ok = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
        const items = emotion.getEventArcs(getDb(), { since: ok(req.query.since), until: ok(req.query.until), limit: intParam(req.query.limit, 50, 200) });
        res.json({ success: true, count: items.length, items });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
