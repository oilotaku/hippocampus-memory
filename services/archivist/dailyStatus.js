// =================================================================
// services/archivist/dailyStatus.js — 每日主角狀態（current_status 日誌行）與範例檔讀取
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { USER } = require('../memoryConfig');
const { ARCHIVIST_LLM_CONFIG_ID } = require('./constants');


// 每日状态案例（可选文件 data/daily_status_examples.txt，私有内容不入库）
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
        _dailyStatusExamples = 'X月X日：无明显变化。';
    }
    return _dailyStatusExamples;
}


// ═══════════════════════════════════════════════════════
// 每日主角状态（v5.13）
// ═══════════════════════════════════════════════════════
// 主角（USER）不在 regenerateEntityOverviews 的扫描范围里——那条查询带 SKIP_NAMES
// 过滤，双星被整体排除。她的 current_status 由这个任务独占维护：写「X月X日：…」
// 形式的日志行，今天条目前置、旧行不可变、最多留 DAILY_STATUS_MAX_LINES 行。
//
// ⚠️ entityProfile.js / lifecycle.js 那边是靠「看到主角就跳过、不写」来避让的
// （见各自注释「由每日 cron 独占维护」）。所以这个任务不跑，主角星座不是被覆盖，
// 是根本没人写——点开永远是空的。
//
// 时区：按运行环境的 TZ 判定「昨天」（容器在 docker-compose 里已设 TZ）。
// 库里的时间统一存 UTC，所以用 SQLite 的 localtime 换算，两边口径一致。

const DAILY_STATUS_MAX_LINES = 10;


// 目标日期（'YYYY-MM-DD'）：不传就是「昨天」（按运行环境时区），传 Date 则用那天。
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
        console.log(`[DailyStatus] 未找到主角星座「${USER.name}」，跳过`);
        return { updated: 0 };
    }

    console.log(`[DailyStatus] 开始每日状态总结 — ${datePrefix.replace('：', '')}`);

    // 目标日（当地）的碎片；库里的 created_at 是 UTC，用 localtime 折算回当地日期
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

    // 昨天没碎片 → 写一行「无明显变化」（日志要连续，缺行比空行更难读）
    if (frags.length === 0) {
        const noChangeLine = datePrefix + '无明显变化。';
        const existing = ent.current_status || '';
        const lines = existing.split('\n').filter(l => /^\d+月\d+日[：:]/.test(l.trim()));
        const oldLines = lines.filter(l => !l.startsWith(datePrefix));
        const newStatus = [noChangeLine, ...oldLines.slice(0, DAILY_STATUS_MAX_LINES - 1)].join('\n');
        db.prepare(`UPDATE entity_profiles SET current_status = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(newStatus, ent.id);
        console.log('[DailyStatus] 无明显变化');
        return { updated: 1 };
    }

    const fragBlock = frags.map((f, i) => {
        const dateStr = (f.date || '?').slice(5);
        const w = typeof f.emotional_weight === 'number' ? ` [w:${f.emotional_weight.toFixed(0)}]` : '';
        return `[${i + 1}] (${dateStr})${w} ${(f.content || '').slice(0, 350)}`;
    }).join('\n');

    const prompt = `<task>
以下是 ${USER.name}（用户本人）昨天（${datePrefix.replace('：', '')}）的记忆碎片：

${fragBlock}

请为昨天写一行总结。格式："${datePrefix}xxx。"

你是信息提取器，不是日记作家。读者需要看完这一行就知道昨天发生了什么——具体的人名、地名、事件名是你给读者的锚点。没名字的动词（「参加了一个活动」「跟一个人吃了饭」）等于没写。

像写日记一样客观记录昨天发生的事。标准：
- 外部行为优先：去了哪里、见了谁、做了什么事、做了什么决定。内在情绪不写。
- 私密互动只写事件类型，不写具体内容/台词。
- 已经知道的信息不说成"发现"——之前就知道的事写"(此前已...)"，新发生的写"今天..."
- 不确定的细节直接跳过。模糊信息不如不写。
- 昨天没值得记的事 → 输出"${datePrefix}无明显变化。"
- ≤150字，一行。

优秀案例（注意格式、密度、客观性）：
${examplesBlock}

只输出一行文本。不要 JSON、不要解释、不要 Markdown。
</task>`;

    try {
        const generationConfig = { temperature: 0.3, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } };
        let response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null, generationConfig, ARCHIVIST_LLM_CONFIG_ID
        );
        let raw = (response?.reply || '').trim();
        if (!raw || raw.length < 4) {   // 空返回 → 降一档温度重试一次
            console.warn('[DailyStatus] 空返回，重试中...');
            try {
                const retry = await callLLM(
                    [{ role: 'user', parts: [{ text: prompt }] }],
                    null, null, { ...generationConfig, temperature: 0.1 }, ARCHIVIST_LLM_CONFIG_ID
                );
                raw = (retry?.reply || '').trim();
            } catch (_) {}
        }
        if (!raw || raw.length < 4) {
            console.warn('[DailyStatus] 空返回（重试后），跳过');
            return { updated: 0 };
        }

        // prompt 原文泄漏 / 残句检测：模型偶尔把任务说明复读回来
        const GARBAGE_STARTS = ['<task>', '相关碎片', '只输出', '你是信息', '请为昨天', 'Only output', 'Analyze', 'Summary'];
        if (GARBAGE_STARTS.some(s => raw.startsWith(s)) || /^[)\]}>.,;:!?`'"\\]/.test(raw)) {
            console.warn(`[DailyStatus] 疑似 prompt 泄漏或残句，跳过 — "${raw.slice(0, 40)}"`);
            return { updated: 0 };
        }

        let statusText = raw
            .replace(/^["'「]|["'」]$/g, '')
            .replace(/```[\s\S]*?```/g, '')
            .trim()
            .slice(0, 200);

        // 补日期前缀 + 确保中文全角冒号
        if (!statusText.startsWith(datePrefix)) {
            statusText = datePrefix + statusText.replace(/^[：:]\s*/, '');
        }
        if (statusText.indexOf('：') === -1 && statusText.indexOf(':') > -1) {
            statusText = statusText.replace(':', '：');
        }
        if (!statusText.slice(datePrefix.length).trim()) {
            console.warn('[DailyStatus] 只返回了日期前缀，跳过写入');
            return { updated: 0 };
        }

        // 前置今天这一行；旧行不可变，只剔除同一天的历史行和不合格式的残留
        const existing = ent.current_status || '';
        const lines = existing.split('\n').filter(l => /^\d+月\d+日[：:]/.test(l.trim()));
        const oldLines = lines.filter(l => !l.startsWith(datePrefix));
        const newStatus = [statusText, ...oldLines.slice(0, DAILY_STATUS_MAX_LINES - 1)].join('\n');

        db.prepare(`UPDATE entity_profiles SET current_status = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(newStatus, ent.id);
        console.log(`[DailyStatus] ${statusText.slice(0, 100)}`);
        return { updated: 1 };
    } catch (e) {
        console.error('[DailyStatus] 失败:', e.message);
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
