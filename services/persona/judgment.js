// =================================================================
// services/persona/judgment.js — 實體 judgment 的錨點式增量更新
//
// AI 對一個人的主觀印象（entity_profiles.judgment）以前每次 overview 重生都被整段重寫，
// 沒有錨點。現在把上一版當錨點交給 LLM，要求小幅修改並附上支持修改的素材編號；
// 程式端再驗一次，不合格就保留舊版並記錄：
//   1. 有舊版且新舊不同 → 必須引用至少一個有效素材（編號對得到真實碎片／敘事 id）
//   2. 差異比例（字元層級編輯距離 / 較長者長度，簡繁逐字正規化後）不得超過 judgment_max_change
//   3. 新版是空的或「無」、舊版有實質內容 → 不允許（等於把印象抹掉）
// 沒有舊版（第一次產生）不受限制。被接受且有變化時，舊版存進 entity_judgment_history。
// =================================================================

const { getDb } = require('../../database');
const { sealField } = require('../memoryCrypto');
const { toTraditionalChars } = require('../../utils/zhNormalize');
const { getPersonaConfig } = require('./config');
const { logPersonaEvent } = require('./events');

const BLANKS = new Set(['', '無', '无', '(無)', '（無）', '無明顯變化', '无明显变化']);
const isBlankJudgment = (s) => BLANKS.has(String(s || '').trim());

/** 字元層級 Levenshtein 距離（judgment 上限 500 字，O(n·m) 足夠）。 */
function editDistance(a, b) {
    const x = Array.from(a), y = Array.from(b);
    if (x.length === 0) return y.length;
    if (y.length === 0) return x.length;
    let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
        const cur = [i];
        for (let j = 1; j <= y.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[y.length];
}

/** 差異比例 0~1：編輯距離 / 兩者較長的字數；簡繁寫法不同不算改動。 */
function changeRatio(oldText, newText) {
    const a = toTraditionalChars(String(oldText || '').trim());
    const b = toTraditionalChars(String(newText || '').trim());
    const len = Math.max(Array.from(a).length, Array.from(b).length);
    if (len === 0) return 0;
    return editDistance(a, b) / len;
}

/**
 * @param {{oldJudgment:?string, newJudgment:?string, citedIds:Array, cfg?:object}} p
 *   citedIds：已驗證有效的引用（呼叫端把 LLM 給的素材編號對應到真實 id 後傳入）
 * @returns {{accept:boolean, reason:string, ratio:number}}
 *   reason：first | unchanged | ok | blank_replace | no_citation | too_large
 */
function evaluateJudgmentUpdate({ oldJudgment, newJudgment, citedIds = [], cfg } = {}) {
    const c = getPersonaConfig(cfg);
    // 沒有舊版（含「無」）：不受限制。NULL→「無」照舊寫入，用來標記「試過了、沒什麼好說的」
    if (isBlankJudgment(oldJudgment)) return { accept: true, reason: 'first', ratio: 1 };
    if (isBlankJudgment(newJudgment)) return { accept: false, reason: 'blank_replace', ratio: 1 };
    const ratio = changeRatio(oldJudgment, newJudgment);
    if (ratio === 0) return { accept: true, reason: 'unchanged', ratio };
    if (!Array.isArray(citedIds) || citedIds.length === 0) return { accept: false, reason: 'no_citation', ratio };
    if (ratio > c.judgment_max_change) return { accept: false, reason: 'too_large', ratio };
    return { accept: true, reason: 'ok', ratio };
}

/** 舊版存進歷史（舊版有實質內容才存）。 */
function recordJudgmentHistory(entityId, oldJudgment, reason) {
    if (isBlankJudgment(oldJudgment)) return;
    getDb().prepare('INSERT INTO entity_judgment_history (entity_id, judgment, reason) VALUES (?, ?, ?)')
        .run(entityId, sealField('entity_judgment_history', 'judgment', String(oldJudgment)), reason || null);
}

function getJudgmentHistory(entityId, limit = 20) {
    return getDb().prepare('SELECT id, entity_id, judgment, reason, created_at FROM entity_judgment_history WHERE entity_id = ? ORDER BY id DESC LIMIT ?')
        .all(entityId, Math.max(1, Math.min(100, parseInt(limit, 10) || 20)));
}

/**
 * 把 LLM 給的素材編號（1 起算）對應到真實 id：items[i] 帶 { id, source }。
 * 越界、非整數、沒有 id 的一律略過。回傳 [{ type:'fragment'|'episode', id }]（去重）。
 */
function resolveCitedIds(indices, items) {
    const out = [], seen = new Set();
    for (const n of Array.isArray(indices) ? indices : []) {
        const i = Number(n);
        if (!Number.isInteger(i) || i < 1 || i > items.length) continue;
        const it = items[i - 1];
        if (!it || !Number.isInteger(it.id)) continue;
        const type = it.source === 'episode' ? 'episode' : 'fragment';
        const key = `${type}:${it.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type, id: it.id });
    }
    return out;
}

/** 被擋下時記一筆事件（不含 judgment 文字）。 */
function logJudgmentRejected(entityId, entityName, verdict) {
    logPersonaEvent('judgment_rejected', { entity_id: entityId, reason: verdict.reason, ratio: Math.round(verdict.ratio * 100) / 100 });
    console.log(`[Archivist] ⚓ ${entityName} 的 judgment 更新被擋下（${verdict.reason}，差異 ${Math.round(verdict.ratio * 100)}%），保留舊版`);
}

module.exports = { isBlankJudgment, editDistance, changeRatio, evaluateJudgmentUpdate, recordJudgmentHistory, getJudgmentHistory, resolveCitedIds, logJudgmentRejected };
