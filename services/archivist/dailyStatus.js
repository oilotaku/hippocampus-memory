// =================================================================
// services/archivist/dailyStatus.js — 每日主角狀態（current_status 日誌行）與範例檔讀取
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { sealField } = require('../memoryCrypto');
const { callLLM } = require('../llm');
const { USER } = require('../memoryConfig');
const { ARCHIVIST_LLM_CONFIG_ID } = require('./constants');


// 每日狀態案例（可選檔案 data/daily_status_examples.txt，私有內容不入庫）
let _dailyStatusExamples = null;

function getDailyStatusExamples() {
    if (_dailyStatusExamples !== null) return _dailyStatusExamples;
    try {
        const fs = require('fs');
        const path = require('path');
        const p = path.join(__dirname, '..', '..', 'data', 'daily_status_examples.txt');
        if (fs.existsSync(p)) {
            _dailyStatusExamples = fs.readFileSync(p, 'utf8').trim();
        }
    } catch (_) {}
    if (!_dailyStatusExamples) {
        _dailyStatusExamples = 'X月X日：無明顯變化。';
    }
    return _dailyStatusExamples;
}


// ═══════════════════════════════════════════════════════
// 每日主角狀態（v5.13）
// ═══════════════════════════════════════════════════════
// 主角（USER）不在 regenerateEntityOverviews 的掃描範圍裡——那條查詢帶 SKIP_NAMES
// 過濾，雙星被整體排除。她的 current_status 由這個任務獨佔維護：寫「X月X日：…」
// 形式的日誌行，今天條目前置、舊行不可變、最多留 DAILY_STATUS_MAX_LINES 行。
//
// ⚠️ entityProfile.js / lifecycle.js 那邊是靠「看到主角就跳過、不寫」來避讓的
// （見各自注釋「由每日 cron 獨佔維護」）。所以這個任務不跑，主角星座不是被覆蓋，
// 是根本沒人寫——點開永遠是空的。
//
// 時區：按執行環境的 TZ 判定「昨天」（容器在 docker-compose 裡已設 TZ）。
// 庫裡的時間統一存 UTC，所以用 SQLite 的 localtime 換算，兩邊口徑一致。

const DAILY_STATUS_MAX_LINES = 10;


// 目標日期（'YYYY-MM-DD'）：不傳就是「昨天」（按執行環境時區），傳 Date 則用那天。
function resolveDailyStatusDate(targetDate) {
    const explicit = targetDate instanceof Date && !isNaN(targetDate);
    const base = explicit ? targetDate : new Date();
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(base).map(x => [x.type, x.value]));
    let d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
    if (!explicit) d = new Date(d.getTime() - 86400000);
    const pad = n => String(n).padStart(2, '0');
    return {
        y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate(),
        str: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    };
}


async function generateDailyEntityStatus(targetDate) {
    const db = getDb();
    const examplesBlock = getDailyStatusExamples();
    const t = resolveDailyStatusDate(targetDate);
    const datePrefix = `${t.m}月${t.day}日：`;

    const ent = db.prepare(
        "SELECT id, name, category, current_status FROM entity_profiles WHERE name = ? AND status = 'active'"
    ).get(USER.name);
    if (!ent) {
        console.log(`[DailyStatus] 未找到主角星座「${USER.name}」，跳過`);
        return { updated: 0 };
    }

    console.log(`[DailyStatus] 開始每日狀態總結 — ${datePrefix.replace('：', '')}`);

    // 目標日（當地）的碎片；庫裡的 created_at 是 UTC，用 localtime 折算回當地日期
    const frags = db.prepare(`
        SELECT mf.content, COALESCE(mf.source_date, DATE(mf.created_at, 'localtime')) AS date,
               mf.emotional_weight
        FROM memory_fragments mf
        JOIN fragment_entities fe ON fe.fragment_id = mf.id
        WHERE fe.entity_id = ?
          AND DATE(mf.created_at, 'localtime') = ?
        ORDER BY mf.created_at DESC
        LIMIT 20
    `).all(ent.id, t.str);

    // 昨天沒碎片 → 寫一行「無明顯變化」（日誌要連續，缺行比空行更難讀）
    if (frags.length === 0) {
        const noChangeLine = datePrefix + '無明顯變化。';
        const existing = ent.current_status || '';
        const lines = existing.split('\n').filter(l => /^\d+月\d+日[：:]/.test(l.trim()));
        const oldLines = lines.filter(l => !l.startsWith(datePrefix));
        const newStatus = [noChangeLine, ...oldLines.slice(0, DAILY_STATUS_MAX_LINES - 1)].join('\n');
        db.prepare(`UPDATE entity_profiles SET current_status = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(sealField('entity_profiles', 'current_status', newStatus), ent.id);
        console.log('[DailyStatus] 無明顯變化');
        return { updated: 1 };
    }

    const fragBlock = frags.map((f, i) => {
        const dateStr = (f.date || '?').slice(5);
        const w = typeof f.emotional_weight === 'number' ? ` [w:${f.emotional_weight.toFixed(0)}]` : '';
        return `[${i + 1}] (${dateStr})${w} ${(f.content || '').slice(0, 350)}`;
    }).join('\n');

    const prompt = `<task>
以下是 ${USER.name}（使用者本人）昨天（${datePrefix.replace('：', '')}）的記憶碎片：

${fragBlock}

請為昨天寫一行總結。格式："${datePrefix}xxx。"

你是資訊提取器，不是日記作家。讀者需要看完這一行就知道昨天發生了什麼——具體的人名、地名、事件名是你給讀者的錨點。沒名字的動詞（「參加了一個活動」「跟一個人吃了飯」）等於沒寫。

像寫日記一樣客觀記錄昨天發生的事。標準：
- 外部行為優先：去了哪裡、見了誰、做了什麼事、做了什麼決定。內在情緒不寫。
- 私密互動只寫事件型別，不寫具體內容/臺詞。
- 已經知道的資訊不說成"發現"——之前就知道的事寫"(此前已...)"，新發生的寫"今天..."
- 不確定的細節直接跳過。模糊資訊不如不寫。
- 昨天沒值得記的事 → 輸出"${datePrefix}無明顯變化。"
- ≤150字，一行。

優秀案例（注意格式、密度、客觀性）：
${examplesBlock}

只輸出一行文本。不要 JSON、不要解釋、不要 Markdown。
</task>`;

    try {
        const generationConfig = { temperature: 0.3, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } };
        let response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null, generationConfig, ARCHIVIST_LLM_CONFIG_ID
        );
        let raw = (response?.reply || '').trim();
        if (!raw || raw.length < 4) {   // 空返回 → 降一檔溫度重試一次
            console.warn('[DailyStatus] 空返回，重試中...');
            try {
                const retry = await callLLM(
                    [{ role: 'user', parts: [{ text: prompt }] }],
                    null, null, { ...generationConfig, temperature: 0.1 }, ARCHIVIST_LLM_CONFIG_ID
                );
                raw = (retry?.reply || '').trim();
            } catch (_) {}
        }
        if (!raw || raw.length < 4) {
            console.warn('[DailyStatus] 空返回（重試後），跳過');
            return { updated: 0 };
        }

        // prompt 原文洩漏 / 殘句檢測：模型偶爾把任務說明覆讀回來
        const GARBAGE_STARTS = ['<task>', '相關碎片', '只輸出', '你是資訊', '請為昨天', 'Only output', 'Analyze', 'Summary', '相关碎片', '只输出', '你是信息', '请为昨天'];
        if (GARBAGE_STARTS.some(s => raw.startsWith(s)) || /^[)\]}>.,;:!?`'"\\]/.test(raw)) {
            console.warn(`[DailyStatus] 疑似 prompt 洩漏或殘句，跳過 — "${raw.slice(0, 40)}"`);
            return { updated: 0 };
        }

        let statusText = raw
            .replace(/^["'「]|["'」]$/g, '')
            .replace(/```[\s\S]*?```/g, '')
            .trim()
            .slice(0, 200);

        // 補日期字首 + 確保中文全形冒號
        if (!statusText.startsWith(datePrefix)) {
            statusText = datePrefix + statusText.replace(/^[：:]\s*/, '');
        }
        if (statusText.indexOf('：') === -1 && statusText.indexOf(':') > -1) {
            statusText = statusText.replace(':', '：');
        }
        if (!statusText.slice(datePrefix.length).trim()) {
            console.warn('[DailyStatus] 只返回了日期字首，跳過寫入');
            return { updated: 0 };
        }

        // 前置今天這一行；舊行不可變，只剔除同一天的歷史行和不合格式的殘留
        const existing = ent.current_status || '';
        const lines = existing.split('\n').filter(l => /^\d+月\d+日[：:]/.test(l.trim()));
        const oldLines = lines.filter(l => !l.startsWith(datePrefix));
        const newStatus = [statusText, ...oldLines.slice(0, DAILY_STATUS_MAX_LINES - 1)].join('\n');

        db.prepare(`UPDATE entity_profiles SET current_status = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(sealField('entity_profiles', 'current_status', newStatus), ent.id);
        console.log(`[DailyStatus] ${statusText.slice(0, 100)}`);
        return { updated: 1 };
    } catch (e) {
        console.error('[DailyStatus] 失敗:', e.message);
        return { updated: 0 };
    }
}

module.exports = {
    _dailyStatusExamples,
    getDailyStatusExamples,
    DAILY_STATUS_MAX_LINES,
    resolveDailyStatusDate,
    generateDailyEntityStatus,
};
