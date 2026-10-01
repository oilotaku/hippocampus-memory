'use strict';
// =================================================================
// services/hippocampus/ca1/verify.js — CA1 比對器：回覆前核對（recall.verify，預設關）
// -----------------------------------------------------------------
// 海馬迴的 CA1 把 CA3 補全出來的記憶和當下的輸入比對，不符就當成「新奇」而不是照單全收。
// 這裡對應的問題：嵌入與全文檢索只看話題，分不出「週三／週五」「貓／狗」「台北／台中」。
// 問「週五在哪打羽球」時，取回的「每週三在 X 打羽球」話題完全相符，作答模型就會答 X——
// 端到端評測中，長對話的誘餌題（只差一個細節、答案應為未提及）用提示詞 v2 只答對 65%。
//
// 做法：問題含具體細節（星期、日期、數字、時間詞、已知人物）且有取回記憶時，用一次 LLM 呼叫
// 判斷記憶是否支持問題的前提：supported／contradicted／unknown。不符或找不到時，在記憶區塊後
// 附上 <memory_check> 說明，請作答模型不要拿相近的記憶充數。支持時不附任何東西。
// 核對失敗或超時一律略過（不擋回覆）。
// =================================================================

const DETAIL_PATTERNS = [
    /\d/,                                                     // 數字（日期、時間、數量）
    /[週周][一二三四五六日天末]|星期[一二三四五六日天]|禮拜[一二三四五六日天]/,
    /[一二三四五六七八九十兩幾]+\s*[月號日點歲次個本隻位天年]/,
    /昨天|今天|明天|前天|後天|上週|下週|這週|本週|上個月|下個月|這個月|去年|今年|明年|早上|上午|中午|下午|傍晚|晚上|半夜|凌晨/,
];

/** 問題是否含值得核對的具體細節（時間、數字、星期，或提到已知人物／地點等實體） */
function hasConcreteDetail(text, db) {
    const s = String(text || '');
    if (DETAIL_PATTERNS.some(re => re.test(s))) return true;
    if (db) {
        try { if (require('../ca3/recallGate').findKnownEntity(s, db)) return true; } catch (_) { /* 沒有實體表也沒關係 */ }
    }
    return false;
}

const SYSTEM_PROMPT = `你是記憶核對員。給你使用者的一句話（通常是問題）和幾條記憶，判斷記憶是否支持這句話裡提到或預設的具體細節。
逐項比對人物、時間、星期、日期、地點、數量、物品、活動。只依記憶內容判斷，不要用常識補。

判定（三選一）：
- supported：至少有一條記憶與這句話的細節相符（例：問「週三在哪打羽球」，記憶是「每週三在X打羽球」）。
- contradicted：記憶談的是同一件事，但有細節不同（例：問「週五」，記憶是「週三」；問「貓」，記憶是「狗」）。
- unknown：記憶沒有提到這件事。
同一件事有新舊兩種說法時，以較新的為準，只要有一條相符就是 supported。

只輸出 JSON，不要其他文字：
{"verdict":"supported|contradicted|unknown","mismatches":[{"asked":"週五","memory":"週三","memory_id":12}],"missing":"記憶沒提到的細節（unknown 時填）"}`;

function parseVerdict(raw) {
    const t = String(raw || '').replace(/```(?:json)?/gi, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
        const j = JSON.parse(t.slice(a, b + 1));
        if (!['supported', 'contradicted', 'unknown'].includes(j.verdict)) return null;
        return {
            verdict: j.verdict,
            mismatches: Array.isArray(j.mismatches) ? j.mismatches.filter(m => m && (m.asked || m.memory)).slice(0, 5) : [],
            missing: typeof j.missing === 'string' ? j.missing.slice(0, 80) : '',
        };
    } catch (_) { return null; }
}

/** 給作答模型看的核對說明；supported 或無法判定時回傳空字串 */
function buildCheckNote(res) {
    if (!res || res.verdict === 'supported') return '';
    if (res.verdict === 'contradicted') {
        const lines = res.mismatches.map(m => `- 問的是「${m.asked}」，記憶中是「${m.memory}」${m.memory_id != null ? `（#${m.memory_id}）` : ''}`);
        return `<memory_check>\n核對結果：記憶談到相近的事，但細節和這句話不符，所以記憶裡沒有提到這句話所說的情況。\n${lines.join('\n')}\n不要把不符的記憶當成答案；可以說明記憶中的實際內容，或直接說沒有提到。\n</memory_check>`;
    }
    return `<memory_check>\n核對結果：記憶中沒有提到${res.missing ? `「${res.missing}」` : '這句話所說的事'}。不要猜測，也不要拿相近的記憶充數；回答沒有提到，或用問句向對方確認。\n</memory_check>`;
}

function memoryLine(f) {
    const date = f.source_date || f.date_label || '';
    return `#${f.id}${date ? ` (${String(date).slice(0, 10)})` : ''} ${String(f.content || '').slice(0, 200)}`;
}

/**
 * 核對一句話與取回的記憶。
 * @param {string} message
 * @param {Array} items 取回的記憶（需有 id、content，可有 source_date／date_label）
 * @param {object} o { callLLM, timeoutMs, maxMemories }
 * @returns {Promise<{verdict, mismatches, missing, note, ms}|null>} 失敗或超時回 null
 */
async function verifyRecall(message, items, o = {}) {
    const list = (items || []).filter(f => f && f.content).slice(0, o.maxMemories || 8);
    if (!list.length) return null;
    const callLLM = o.callLLM || require('../../llm').callLLM;
    const user = `這句話：${String(message).slice(0, 300)}\n\n記憶：\n${list.map(memoryLine).join('\n')}`;
    const t0 = Date.now();
    let timer;
    try {
        const raw = await Promise.race([
            callLLM([{ role: 'user', parts: [{ text: user }] }], SYSTEM_PROMPT, null, { temperature: 0, maxOutputTokens: 600 }),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('CA1 核對逾時')), o.timeoutMs || 30000); }),
        ]);
        const res = parseVerdict(raw && raw.reply);
        if (!res) return null;
        return { ...res, note: buildCheckNote(res), ms: Date.now() - t0 };
    } catch (e) {
        console.error('[CA1] 核對失敗，略過:', e.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { hasConcreteDetail, verifyRecall, buildCheckNote, parseVerdict, SYSTEM_PROMPT };
