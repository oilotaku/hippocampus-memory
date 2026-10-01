'use strict';
// =================================================================
// services/hippocampus/dentate/dateFix.js — 記憶內文「M月D日（週X）」日期與星期一致性校正
// =================================================================
// Scribe 提示詞要求模型把「下週三」「後天」換算成具體日期並附星期。模型抄星期多半抄對，
// 但日期常差一到三天（實測中文合成長集 37 組日期＋星期有 19 組對不上，例：「3月19日（週三）」，
// 2026-03-19 其實是週四）。問答時日期題因此答錯，而且錯在記憶本身，檢索與回答都救不回來。
// 這裡在寫入前用程式檢查，對不上時依序：
//   1. 原話寫了這個日期（「3月19日」「3/19」）→ 信日期，改星期；
//   2. 原話有相對說法（下週三、這週六、明天、後天…）且換算結果是同一個星期 → 用換算結果；
//   3. 其餘 → 信星期，改成原日期前後 3 天內同星期的那天。
// refDate 是說這句話那則訊息的當地日期 'YYYY-MM-DD'（一週從週一開始，與提示詞一致）。

const WD = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const WD_ZH = '日一二三四五六';
const DATE_RE = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日號号]\s*([（(])\s*(週|周|星期|禮拜|礼拜)([一二三四五六日天])\s*([）)])/g;
const REL_WEEK_RE = /(上上|上|這|这|本|下下|下)(?:個|个)?(?:週|周|星期|禮拜|礼拜)([一二三四五六日天])/g;
const REL_DAY = { 大前天: -3, 前天: -2, 昨天: -1, 今天: 0, 明天: 1, 後天: 2, 后天: 2, 大後天: 3, 大后天: 3 };
const WEEK_OFFSET = { 上上: -2, 上: -1, 這: 0, 这: 0, 本: 0, 下: 1, 下下: 2 };
const DAY_MS = 86400000;

function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Number.isNaN(d) ? null : d;
}

// 有效日期才回傳 UTC 毫秒（排除 2月30日 之類）
function utcDate(y, mo, d) {
    const t = Date.UTC(y, mo - 1, d);
    const x = new Date(t);
    return x.getUTCMonth() === mo - 1 && x.getUTCDate() === d ? t : null;
}

// 原話中的相對日期說法 → 候選日期（UTC 毫秒）
function relativeCandidates(quote, ref) {
    const out = [];
    const q = String(quote || '');
    const refWd = new Date(ref).getUTCDay();
    const monday = ref - ((refWd + 6) % 7) * DAY_MS;
    for (const m of q.matchAll(REL_WEEK_RE)) {
        const wd = WD[m[2]];
        out.push(monday + WEEK_OFFSET[m[1]] * 7 * DAY_MS + ((wd + 6) % 7) * DAY_MS);
    }
    // 長的先比（大後天 不要被 後天 搶先）
    for (const k of Object.keys(REL_DAY).sort((a, b) => b.length - a.length)) {
        if (q.includes(k)) out.push(ref + REL_DAY[k] * DAY_MS);
    }
    return out;
}

/**
 * 校正內文的日期與星期。回傳 { content, fixes }，fixes = [{ from, to, how }]，
 * how ∈ 'weekday'（信日期改星期）| 'relative'（依原話相對說法換算）| 'nearest'（信星期改日期）。
 * refDate 無效時原樣回傳。
 */
function fixDateWeekday(content, quote, refDate) {
    const text = String(content ?? '');
    const ref = parseYmd(refDate);
    const fixes = [];
    if (ref == null || !text) return { content: text, fixes };
    const refYear = new Date(ref).getUTCFullYear();
    const q = String(quote || '');
    const out = text.replace(DATE_RE, (all, y, mo, d, lp, word, wch, rp) => {
        mo = +mo; d = +d;
        let year = y ? +y : null, t = null;
        if (year) t = utcDate(year, mo, d);
        else {
            // 沒寫年份：取最接近訊息日期的那一年
            for (const yy of [refYear - 1, refYear, refYear + 1]) {
                const c = utcDate(yy, mo, d);
                if (c != null && (t == null || Math.abs(c - ref) < Math.abs(t - ref))) { t = c; year = yy; }
            }
        }
        if (t == null) return all;
        const want = WD[wch];
        const has = new Date(t).getUTCDay();
        if (has === want) return all;
        const rebuild = (ms, wdc) => {
            const x = new Date(ms);
            const yPart = y ? `${x.getUTCFullYear()}年` : '';
            return `${yPart}${x.getUTCMonth() + 1}月${x.getUTCDate()}日${lp}${word}${wdc}${rp}`;
        };
        let to, how;
        const literal = new RegExp(`(?<!\\d)${mo}\\s*(?:月\\s*${d}\\s*[日號号]|[/／.]\\s*${d})(?!\\d)`);
        if (literal.test(q)) {
            to = rebuild(t, WD_ZH[has]); how = 'weekday';
        } else {
            const rel = relativeCandidates(q, ref).filter(c => new Date(c).getUTCDay() === want);
            const uniq = [...new Set(rel)];
            if (uniq.length === 1) { to = rebuild(uniq[0], wch); how = 'relative'; }
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
