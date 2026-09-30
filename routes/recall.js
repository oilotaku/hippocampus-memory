// routes/recall.js — 記憶檢索（讀側），供外部機器人回覆前查詢
//
// POST /api/recall
//   body: { "query": "今天好累", "limit": 8 }
//   → 返回相關的記憶碎片/敘事/實體，formatted 是拼好可塞進 LLM prompt 的文本。
//
// 配合 routes/ingest.js（寫側 /api/messages）形成完整閉環：
//   收到訊息 → POST /api/messages 攢記憶
//   回覆前   → POST /api/recall 查記憶 → 拼 prompt → LLM 回覆
//
// ⚠️ 本介面無鑑權，僅供內網/localhost 使用。

const express = require('express');
const { searchHybrid, formatHybridContext } = require('../services/librarian');
const router = express.Router();

router.post('/recall', async (req, res) => {
    const { query, limit } = req.body || {};
    const q = String(query || '').trim();
    if (!q) {
        return res.status(400).json({ success: false, error: '需提供 query（檢索關鍵詞或短句）' });
    }

    try {
        const n = Math.min(parseInt(limit, 10) || 8, 20);
        const memories = await searchHybrid(q, n);

        const formatted = memories.length > 0
            ? `【記憶庫檢索結果】\n${formatHybridContext(memories)}`
            : '記憶庫中沒有找到相關記憶。';

        res.json({
            success: true,
            query: q,
            count: memories.length,
            formatted,
        });
    } catch (e) {
        console.error('[recall] 檢索失敗:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
