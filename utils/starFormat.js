'use strict';
// 星圖「一顆星」的資料形狀（/api/memory/universe 與再鞏固 API 共用，確保前端拿到的欄位一致）。
// 亮度規則原本內嵌在 routes/memory-api.js，抽到這裡以免兩處各寫一份而日後漂移。

const EMOTION_DIMS = Object.freeze(['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation']);

// SELECT 用欄位（別名固定；status 一律叫 lifecycle）
const STAR_COLUMNS = `mf.id, mf.content AS title, mf.content,
    mf.emotional_weight, mf.created_at AS date, mf.status AS lifecycle,
    CAST(julianday('now') - julianday(COALESCE(mf.last_accessed_at, mf.created_at)) AS REAL) AS days_since_access,
    mf.read_count, mf.cited_count, mf.created_at, mf.last_accessed_at, mf.entity_id,
    mf.emo_joy, mf.emo_trust, mf.emo_fear, mf.emo_surprise, mf.emo_sadness, mf.emo_disgust, mf.emo_anger, mf.emo_anticipation,
    mf.intensity, mf.valence, mf.emotion_conf`;

// 衰減 λ 依情緒權重四檔（與 Librarian segmentedDecay 同語義）：高情緒記憶亮得久，瑣事快速變暗
function ewLambda(ew) {
    if (ew >= 0.8) return 0.005;
    if (ew >= 0.6) return 0.01;
    if (ew >= 0.4) return 0.02;
    return 0.04;
}

function computeBrightness({ emotional_weight, days_since_access, read_count, lifecycle }) {
    const daysSince = Math.max(0, days_since_access || 0);
    const decay = Math.exp(-ewLambda(emotional_weight || 0.3) * daysSince);
    // read_count = Librarian 檢索命中次數（聊天裡被想起 → 星星更亮）
    const recallBonus = Math.min(0.3, Math.log(1 + (read_count || 0)) * 0.08);
    let brightness = Math.min(1.0, decay + recallBonus);
    // 生命週期硬上限：冷卻的星不可能亮，凍結的星接近熄滅
    if (lifecycle === 'cooling') brightness = Math.min(brightness, 0.30);
    else if (lifecycle === 'frozen') brightness = Math.min(brightness, 0.12);
    return brightness;
}

// 八維情緒：全部為 NULL（G2 之前的舊碎片）回 null；否則回 {joy,…}（缺的維度補 0）
function emotionOf(row) {
    let any = false;
    const out = {};
    for (const d of EMOTION_DIMS) {
        const v = row['emo_' + d];
        if (v != null) any = true;
        out[d] = Number.isFinite(v) ? +v.toFixed(3) : 0;
    }
    return any ? out : null;
}

function formatStar(f, extra = {}) {
    const brightness = computeBrightness(f);
    const emotion = emotionOf(f);
    return {
        id: 'f' + f.id,
        title: (f.title || '').slice(0, 40) || '…',
        content: (f.content || '').slice(0, 200),
        conf: brightness,
        mag: +(6.5 - brightness * 5.5).toFixed(1),
        lifecycle: f.lifecycle,
        date: f.date?.slice(0, 10) || '',
        // G4（4D 星圖時間軸）欄位：完整時間戳（UTC）與被回憶次數
        createdAt: f.created_at || null,
        lastAccessedAt: f.last_accessed_at || null,
        readCount: f.read_count || 0,
        entity_id: f.entity_id,
        relation: f.relation || null,
        // H1：再鞏固（被確認引用次數）與情緒（沒有情緒資料的舊碎片 → null）
        citedCount: f.cited_count || 0,
        emotion,
        intensity: emotion && Number.isFinite(f.intensity) ? +f.intensity.toFixed(3) : null,
        valence: emotion && Number.isFinite(f.valence) ? +f.valence.toFixed(3) : null,
        emotionConf: emotion && Number.isFinite(f.emotion_conf) ? +f.emotion_conf.toFixed(3) : null,
        ...extra,
    };
}

module.exports = { EMOTION_DIMS, STAR_COLUMNS, computeBrightness, emotionOf, formatStar, ewLambda };
