// G3 測試共用：在暫存資料庫裡播種碎片、穩定特質、實體。檔名以 _ 開頭，node --test 不會當測試跑。
function seedFragment(db, content, createdAt) {
    const { sealField } = require('../../services/memoryCrypto');   // 延後載入：要等測試先設好加密金鑰環境變數
    return Number(db.prepare(`INSERT INTO memory_fragments (type, entity, content, status, created_at)
        VALUES ('fact', 'user', ?, 'active', ?)`).run(sealField('memory_fragments', 'content', content), createdAt).lastInsertRowid);
}

/** 建立 n 條碎片，日期依 days 陣列循環（例如 ['2026-09-01','2026-09-02','2026-09-03']）。 */
function seedFragments(db, n, days, tag = '證據') {
    return Array.from({ length: n }, (_, i) => seedFragment(db, `${tag}${i}`, `${days[i % days.length]} 10:00:00`));
}

function seedTrait(db, { content, confidence = 0.8, fragIds = [], evidenceCount = 3, status = 'active' }) {
    return Number(db.prepare(`INSERT INTO user_model (type, content, confidence, evidence_count, source_fragment_ids, status)
        VALUES ('stable_trait', ?, ?, ?, ?, ?)`).run(content, confidence, evidenceCount, JSON.stringify(fragIds), status).lastInsertRowid);
}

const DAYS3 = ['2026-09-01', '2026-09-02', '2026-09-03'];

/** 建立一條證據充足（3 碎片、3 天）的特質。 */
function seedQualifiedTrait(db, content, confidence = 0.8) {
    const ids = seedFragments(db, 3, DAYS3, content);
    return seedTrait(db, { content, confidence, fragIds: ids });
}

module.exports = { seedFragment, seedFragments, seedTrait, seedQualifiedTrait, DAYS3 };
