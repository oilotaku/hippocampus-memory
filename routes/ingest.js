// routes/ingest.js — 聊天記錄接入（旁路管線入口）
//
// 用途：接收外部聊天機器人的對話，寫入 messages 表，供 Scribe 提取記憶。
// 記憶庫不負責回覆——回覆由外部機器人（如 AstrBot）自己處理。
//
// POST /api/messages  接受三種格式：
//   1. 簡單格式（推薦，AstrBot 外掛轉發用）：
//      { "sender": "user"|"bot", "content": "...", "timestamp": "2026-08-15 14:30:00", "chat_id": 1 }
//      或 { "role": "user"|"assistant", "content": "..." }
//   2. 陣列： [ {sender, content, timestamp}, ... ]
//   3. OneBot v11 message 事件（SnowLuma 直連時用）：
//      { "post_type":"message", "message_type":"private"|"group", "user_id":123,
//        "self_id":456, "raw_message":"...", "time":1755234600, "group_id":789 }
//
// sender 判定（對映到 messages.sender 的 'user'/'ai'）：
//   'user'/'human'/'我' → 'user'
//   'assistant'/'ai'/'bot'/'它' → 'ai'
//   OneBot：user_id === self_id → ai（機器人自己），否則 user
//
// ⚠️ 本介面無鑑權，僅供內網/localhost 使用，不要暴露到公網。

const express = require('express');
const { getDb } = require('../database');
const router = express.Router();

// 歸一化時間戳 → 'YYYY-MM-DD HH:MM:SS'
function normalizeTime(ts) {
    if (!ts) return null;
    let d = null;
    const s = String(ts).trim();
    if (/^\d+$/.test(s)) {
        const n = parseInt(s, 10);
        d = new Date(n > 1e12 ? n : n * 1000); // 秒或毫秒
    } else {
        d = new Date(s.replace(' ', 'T'));
    }
    if (!d || isNaN(d.getTime())) return null;
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 簡單格式的 sender → 'user'/'ai'
function mapSender(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'user' || s === 'human' || s === '我' || s === 'me') return 'user';
    return 'ai'; // assistant/ai/bot/它 及其它預設當 AI
}

// 把一條訊息（簡單格式 或 OneBot 事件）規整成 {sender, content, timestamp}
function normalizeMessage(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // OneBot v11 事件
    if (obj.post_type === 'message') {
        const content = obj.raw_message || obj.message || '';
        if (!content) return null;
        const sender = String(obj.user_id) === String(obj.self_id) ? 'ai' : 'user';
        return { sender, content: String(content), timestamp: normalizeTime(obj.time) };
    }

    // 簡單格式
    const content = obj.content ?? obj.text ?? obj.message ?? '';
    if (!content) return null;
    const sender = mapSender(obj.sender ?? obj.role);
    return { sender, content: String(content), timestamp: normalizeTime(obj.timestamp ?? obj.time) };
}

router.post('/messages', (req, res) => {
    const db = getDb();
    const body = req.body;

    // 規整成訊息陣列
    const rawList = Array.isArray(body) ? body : [body];
    const msgs = [];
    for (const item of rawList) {
        const m = normalizeMessage(item);
        if (m) msgs.push(m);
    }

    if (msgs.length === 0) {
        return res.status(400).json({ success: false, error: '沒有解析出有效訊息（需 content + sender/role 或 OneBot message 事件）' });
    }

    // 補預設時間戳（無時間的按當前時間遞增寫入）
    let cursor = Date.now();
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (!msgs[i].timestamp) {
            msgs[i].timestamp = normalizeTime(cursor);
            cursor -= 1000;
        } else {
            cursor = new Date(msgs[i].timestamp.replace(' ', 'T')).getTime() - 1000;
        }
    }

    // 預設 chat_id=1（若沒有獨立 chat 概念）
    const chatId = body.chat_id ?? body.group_id ?? 1;

    const insert = db.prepare(`
        INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted, message_type, status)
        VALUES (?, ?, ?, ?, 0, 'text', 'sent')
    `);
    const tx = db.transaction((list) => {
        for (const m of list) insert.run(chatId, m.sender, m.content, m.timestamp);
    });
    tx(msgs);

    res.json({ success: true, count: msgs.length });
});

module.exports = router;
