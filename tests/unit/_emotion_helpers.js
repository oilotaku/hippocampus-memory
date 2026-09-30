// G2 測試共用：建暫存 DB、插碎片／實體、跑階段 A/B。檔名以 _ 開頭，不會被當成測試。
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

function boot(tag) {
    const dbPath = setupEnv(tag);
    const restore = quiet();
    const { initDatabase, getDb } = require('../../database');
    initDatabase();
    const db = getDb();
    // database.js 是單例：同一個檔案內的多個測試共用同一個連線 → 每次 boot 先清乾淨
    for (const t of ['emotion_baseline_stats', 'emotion_state', 'emotion_events', 'emotion_entity_stats', 'emotion_topic_slot', 'fragment_entities', 'memory_fragments', 'entity_profiles']) db.exec(`DELETE FROM ${t}`);
    const emotion = require('../../services/emotion');
    const { sealField } = require('../../services/memoryCrypto');
    let seq = 0;
    const ent = (name, category = 'person') => {
        const r = db.prepare('SELECT id FROM entity_profiles WHERE name = ?').get(name);
        if (r) return r.id;
        return Number(db.prepare("INSERT INTO entity_profiles (name, category, status) VALUES (?, ?, 'active')").run(name, category).lastInsertRowid);
    };
    // 插一條碎片並走階段 A；emotions 是八維原始分數（缺的維度 = 0.15）
    const frag = ({ content, entities = [], emotions, raisedAt, eventAt = null, quote }) => {
        seq++;
        const text = content || `事實${seq}`;
        const id = Number(db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_date, quote)
            VALUES ('observation', ?, ?, 0.3, 'chat', ?, ?)`).run(entities[0] || 'X', sealField('memory_fragments', 'content', text), (raisedAt || '').slice(0, 10) || null, quote ? sealField('memory_fragments', 'quote', quote) : null).lastInsertRowid);
        const base = Object.fromEntries(emotion.DIMS.map(d => [d, 0.15]));
        emotion.applyScribeEmotion(db, id, { emotions: { ...base, ...(emotions || {}) }, event_at: eventAt }, { raisedAt });
        // 這些測試檢查的是「已存在 event_at 之後」的查詢；F4 起 Scribe 會把「等於訊息當天、quote 又沒日期片語」的
        // 模型 event_at 視為不可信，所以直接寫入欄位，繞過寫入端的正規化。
        if (eventAt) db.prepare('UPDATE memory_fragments SET event_at = ? WHERE id = ?').run(eventAt, id);
        for (const name of entities) {
            db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation) VALUES (?, ?, ?)').run(id, ent(name), 'related_to');
        }
        return id;
    };
    return { db, emotion, frag, ent, restore, cleanup: () => cleanupDb(dbPath) };
}

module.exports = { boot };
