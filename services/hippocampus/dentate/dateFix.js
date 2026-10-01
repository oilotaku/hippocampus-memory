'use strict';
// =================================================================
// services/hippocampus/dentate/dateFix.js — 記憶內文「M月D日（週X）」日期與星期一致性校正
// =================================================================
// Scribe 提示詞要求模型把「下週三」「後天」換算成具體日期並附星期。模型抄星期多半抄對，
// 但日期常差一到三天（實測中文合成長集 37 組日期＋星期有 19 組對不上，例：「3月19日（週三）」，
// 2026-03-19 其實是週四）。問答時日期題因此答錯，而且錯在記憶本身，檢索與回答都救不回來。
// 原話的日期換算與 event_at 共用 utils/dateParse（同一套規則，一週從週一開始），對不上時依序：
//   1. 原話寫了這個日期（「3月19日」「3/19」）→ 信日期，改星期；
//   2. 原話換算出唯一一個同星期的日期（下週三、這週六、明天…）→ 用它；
//   3. 其餘 → 信星期，改成原日期前後 3 天內同星期的那天。
// refDate 是說這句話那則訊息的當地日期 'YYYY-MM-DD'。
const { scanDates } = require('../../../utils/dateParse');

const WD = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const WD_ZH = '日一二三四五六';
const DATE_RE = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日號号]\s*([（(])\s*(週|周|星期|禮拜|礼拜)([一二三四五六日天])\s*([）)])/g;
const DAY_MS = 86400000;
const OPTS = { past: true, nearest: true };

function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

function validDay(y, mo, d) {
    const t = Date.UTC(y, mo - 1, d);
    const x = new Date(t);
    return x.getUTCMonth() === mo - 1 && x.getUTCDate() === d ? t : null;
}

/**
 * 校正內文的日期與星期。回傳 { content, fixes }，fixes = [{ from, to, how }]，
 * how ∈ 'weekday'（信日期改星期）| 'relative'（依原話換算）| 'nearest'（信星期改日期）。
 * refDate 無效時原樣回傳。
 */
function fixDateWeekday(content, quote, refDate) {
    const text = String(content ?? '');
    const ref = parseYmd(refDate);
    const fixes = [];
    if (!ref || Number.isNaN(ref.getTime()) || !text) return { content: text, fixes };
    let quoteDates = null;                       // 用到才解析
    const out = text.replace(DATE_RE, (all, y, mo, d, lp, word, wch, rp) => {
        mo = +mo; d = +d;
        // 年份：有寫就用；沒寫依 dateParse 的「最近一次」規則（與 event_at 一致）
        const t = y ? validDay(+y, mo, d) : (scanDates(`${mo}月${d}日`, ref, OPTS)[0]?.ms ?? null);
        if (t == null) return all;
        const want = WD[wch];
        const has = new Date(t).getUTCDay();
        if (has === want) return all;
        const rebuild = (ms, wdc) => {
            const x = new Date(ms);
            return `${y ? `${x.getUTCFullYear()}年` : ''}${x.getUTCMonth() + 1}月${x.getUTCDate()}日${lp}${word}${wdc}${rp}`;
        };
        if (!quoteDates) quoteDates = scanDates(quote, ref, OPTS).map(x => x.ms);
        const md = (ms) => new Date(ms).toISOString().slice(5, 10);
        let to, how;
        if (quoteDates.some(ms => md(ms) === md(t))) {
            to = rebuild(t, WD_ZH[has]); how = 'weekday';
        } else {
            const same = quoteDates.filter(ms => new Date(ms).getUTCDay() === want);
            if (same.length === 1) { to = rebuild(same[0], wch); how = 'relative'; }
            else {
                let delta = (want - has + 7) % 7;      // 0..6 往後
                if (delta > 3) delta -= 7;             // 改成 -3..3 最近
                to = rebuild(t + delta * DAY_MS, wch); how = 'nearest';
            }
        }
        fixes.push({ from: all, to, how });
        return to;
    });
    return { content: out, fixes };
}

module.exports = { fixDateWeekday };
