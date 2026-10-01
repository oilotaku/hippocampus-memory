'use strict';
// =================================================================
// services/hippocampus/dentate/timeFields.js — 齒狀迴：碎片的時間欄位（結構化編碼）
// =================================================================
// raised_at（話題被提出的時間）、event_at（事件日期）、raised_slot（時段）、weekday、tz。
// 原本寫在杏仁核 applyScribeEmotion 裡；算法移到這裡，杏仁核轉出、介面不變。
// 是否寫入仍跟著 emotion.enabled（G2 的既有設計，關閉時 CA3 的前瞻記憶與週年日退回內文日期與 created_at）。
// 時區沿用 memory_config 的 emotion.timezone（預設 Asia/Taipei）。
const { getEmotionConfig } = require('../amygdala/config');
const { parseEventAt } = require('../amygdala/scoring');
const { parseUtc, toSqlUtc, localParts, slotOfHour } = require('../amygdala/time');
const { parseEventDateFromText } = require('../../../utils/dateParse');

const TIMELESS_TYPES = new Set(['preference', 'fact', 'entity_new', 'reflection']);

// 該條碎片的「話題被提出的時間」：來源訊息（含 quote 那幾則）中最早的一則；找不到就用整批最早
// msgs: [{ ts, text }]；回傳 UTC 'YYYY-MM-DD HH:MM:SS' 或 null
function resolveRaisedAt(quote, msgs) {
    const q = String(quote || '').trim();
    const withTime = (msgs || []).map(m => ({ d: parseUtc(m.ts), text: m.text || '' })).filter(m => m.d);
    if (!withTime.length) return null;
    let pool = q ? withTime.filter(m => m.text.includes(q)) : [];
    if (!pool.length) pool = withTime;
    const earliest = pool.reduce((a, b) => (b.d < a.d ? b : a));
    return toSqlUtc(earliest.d);
}

// 事件日期：由程式從 quote（原話）依「來源訊息時間」確定性換算，模型輸出只當備援。
// 8B 模型的 event_at 不可靠：常把日常狀態填成訊息當天，「下個月十五號」也會算錯月份。
//   1. 沒有時間性的類型 → null
//   2. quote 解析得到日期 → 以程式結果為準（不看模型）
//   3. 解析不到 → 採用模型輸出，但若它等於訊息當天（當地或 UTC 日期）就視為不可信 → null
//      （quote 已確認沒有日期片語；連「今天」都沒說，卻標成今天多半是拿訊息日期充數）
function resolveEventAt(entry, raisedUtc, tz) {
    if (TIMELESS_TYPES.has(entry?.type)) return null;
    const lp = localParts(raisedUtc, tz);
    if (lp) {
        const ref = new Date(Date.UTC(lp.year, lp.month - 1, lp.day));   // 以當地日曆日為「今天」
        const fromQuote = parseEventDateFromText(entry?.quote, ref);
        if (fromQuote) return fromQuote;
    }
    const model = parseEventAt(entry?.event_at);
    if (!model) return null;
    if (model.length === 10) {
        const local = lp ? `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}` : null;
        if (model === local || model === String(raisedUtc).slice(0, 10)) return null;
    }
    return model;
}

// 時間欄位的 SET 子句與值（applyScribeEmotion 相容路徑也用這個，兩邊算法只有一份）
function timeColumns(entry, raisedAt, tz) {
    const raised = raisedAt || toSqlUtc(new Date());
    const lp = localParts(raised, tz);
    return {
        sets: ['raised_at = ?', 'event_at = ?', 'raised_slot = ?', 'weekday = ?', 'tz = ?'],
        vals: [raised, resolveEventAt(entry, raised, tz), lp ? slotOfHour(lp.hour) : null, lp ? lp.weekday : null, tz],
    };
}

// 寫入時間欄位（是否該寫由呼叫端依 emotion.enabled 決定）
function applyTimeFields(db, fragId, entry, { raisedAt } = {}) {
    const { sets, vals } = timeColumns(entry, raisedAt, getEmotionConfig().timezone);
    db.prepare(`UPDATE memory_fragments SET ${sets.join(', ')} WHERE id = ?`).run(...vals, fragId);
}

module.exports = { resolveRaisedAt, resolveEventAt, timeColumns, applyTimeFields, TIMELESS_TYPES };
