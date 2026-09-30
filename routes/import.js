// routes/import.js — 記憶庫匯入/匯出 API（memory.html 前端入口用）
//
// POST /api/import/chat   匯入聊天記錄（body: { content, name }）
// GET  /api/export/memory 匯出記憶庫為 JSONL 下載

const express = require('express');
const { getDb } = require('../database');
const { parseAny } = require('../services/chatParser');
const { fillTimestamps, importMessages } = require('../services/chatImport');

const router = express.Router();

// ── 匯入聊天記錄 ──
router.post('/import/chat', (req, res) => {
    const { content, name } = req.body || {};
    const text = String(content || '').trim();
    if (!text) {
        return res.status(400).json({ success: false, error: '缺少檔案內容' });
    }

    const msgs = fillTimestamps(parseAny(text));
    if (msgs.length === 0) {
        return res.status(400).json({
            success: false,
            error: '沒有解析出有效訊息（支援 JSON 陣列 / JSONL / TXT「名字: 內容」格式）',
        });
    }

    const { chatId, count } = importMessages(msgs, { name: name || undefined });
    res.json({
        success: true,
        count,
        chatId,
        userCount: msgs.filter(m => m.sender === 'user').length,
        aiCount: msgs.filter(m => m.sender === 'ai').length,
        preview: msgs.slice(0, 5).map(m => ({ sender: m.sender, content: m.content.slice(0, 60), timestamp: m.timestamp })),
    });
});

// ── 匯出記憶庫（JSONL 下載）──
router.get('/export/memory', (req, res) => {
    const db = getDb();
    const TABLES = ['entity_profiles', 'memory_fragments', 'fragment_entities', 'memories'];

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', 'attachment; filename="memory_export.jsonl"');

    for (const table of TABLES) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        for (const row of rows) {
            res.write(JSON.stringify({ table, row }) + '\n');
        }
    }
    res.end();
});

module.exports = router;
