// services/chatImport.js — 聊天記錄寫入（CLI 匯入指令碼 + API 介面共用）
const { getDb } = require('../database');
const { normalizeTime } = require('./chatParser');

// 補全預設時間戳（從後往前，無時間的用當前時間遞減）
function fillTimestamps(msgs) {
    let cursor = Date.now();
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (!msgs[i].timestamp) {
            msgs[i].timestamp = normalizeTime(cursor);
            cursor -= 1000;
        } else {
            cursor = new Date(msgs[i].timestamp.replace(' ', 'T')).getTime() - 1000;
        }
    }
    return msgs;
}

// 寫入 messages 表（明文 is_encrypted=0，Scribe 直接讀取）
// opts: { chatId, name } — 有 chatId 直接寫入，否則新建會話
function importMessages(msgs, opts = {}) {
    const db = getDb();
    let chatId = opts.chatId;
    if (!chatId) {
        const name = opts.name || `匯入 ${new Date().toISOString().slice(0, 10)}`;
        chatId = db.prepare('INSERT INTO chats (name) VALUES (?)').run(name).lastInsertRowid;
    }

    const insert = db.prepare(`
        INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted, message_type, status)
        VALUES (?, ?, ?, ?, 0, 'text', 'sent')
    `);
    const tx = db.transaction((batch) => {
        for (const m of batch) insert.run(chatId, m.sender, m.content, m.timestamp);
    });
    tx(msgs);

    return { chatId, count: msgs.length };
}

module.exports = { fillTimestamps, importMessages };
