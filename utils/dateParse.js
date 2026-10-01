// =================================================================
// utils/dateParse.js — 從中文口語文字確定性解析日期（簡繁並存）
//
// 用途：G1 前瞻記憶（recallGate）與 Scribe 寫入 event_at 共用。
// 為什麼不讓模型算：8B 模型的相對日期不可靠（「下個月十五號」在 6/1 常算成 6/15），
// 由程式以「來源訊息時間」為基準換算才穩定。
//
// 支援寫法（數字可用阿拉伯或中文，如 15／十五／二十五）：
//   完整日期  YYYY-M-D、YYYY/M/D、YYYY年M月D日
//   月日      M月D日／M月D號／M/D（未寫年份：預設取 ref 起第一個出現；nearest 取 240 天內的未來、否則最近的過去）
//   週幾      下週X／下星期X／下禮拜X／下個禮拜X、這週X／本週X、週X（ref 起下一個，含當天）
//   相對日    明天／明日、後天、大後天
//   月份      下個月N號／下個月N日／下月N號、這個月N號／本月N號
//   月底      月底／這個月底／下個月底
//   多久之後  N天後／N日後／N天之後、N週後／N個禮拜後
//   past 選項額外支援（敘述已發生的事）：今天／今日／今晚、昨天／昨日／昨晚、前天／大前天、
//             上週X／上個禮拜X、上個月N號、上個月底、N天前
// ref：文字寫下的時間（Date）；以 ref 的 UTC 日曆日為「今天」。呼叫端若要用當地日曆日，
//      先把當地年月日編成 Date.UTC(y, m-1, d) 傳進來。
// =================================================================
const { toTraditionalChars } = require('./zhNormalize');

const DAY_MS = 86400000;
const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

const WEEKDAY = { '一': 0, '二': 1, '三': 2, '四': 3, '五': 4, '六': 5, '日': 6, '天': 6 };
const WK = '(?:週|周|星期|禮拜|礼拜)';
const WD = '([一二三四五六日天])';
const CN_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '兩': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const NUM = '(\\d{1,3}|[零〇一二兩两三四五六七八九十]{1,3})';
const DAYSUF = '[日號号]';
// 語氣（文字已轉繁體）：只用於 past 模式下沒有前綴的「週X」該往前還是往後算
// 「過來／過去／過幾天／過生日／過年／過節／過夜／過日子」與「不過」都不是完成語氣
const PAST_TONE = /了|(?<!不)過(?![來去幾生年節夜]|日子)|剛/;
const FUTURE_TONE = /要|會|打算|準備|預計|計畫|計劃|將|想去|約好|排了/;
const CLAUSE_END = '，,。．.；;！!？?\n';      // 語氣判斷以子句為範圍
const CLAUSE_END_RE = /[，,。．.；;！!？?\n]/;

/** '15'／'十五'／'二十'／'三十一'／'兩' → 整數；認不得回 null */
function cnToInt(s) {
    s = String(s);
    if (/^\d+$/.test(s)) return +s;
    if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s];
    const m = s.match(/^([一二兩两三四五六七八九])?十([一二兩两三四五六七八九])?$/);
    if (!m) return null;
    return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
}

function validMD(y, m, d) {
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 核心：回傳 [{ ms, idx }]（ms = UTC 零點毫秒；idx = 在文字中的位置），依解析順序、已去重。
 * opts.past：也解析已過去／今天的說法。opts.nearest：無年份的月日：ref 起 240 天內的未來優先、否則取最近的過去（預設取 ref 起第一個出現）。
 */
function scanDates(text, ref, opts = {}) {
    // toTraditionalChars 會把「六」等字換成 CJK 相容字元（U+F9D1），NFC 換回一般字元，正規式才對得上
    const t = toTraditionalChars(String(text || '')).normalize('NFC');
    const refDay = utcDay(ref);
    const refY = ref.getUTCFullYear(), refM = ref.getUTCMonth();   // refM: 0-11
    const refWd = (new Date(refDay).getUTCDay() + 6) % 7;          // 週一=0
    const out = [];
    const push = (ms, idx, weak = false) => {
        if (ms == null || out.some(x => x.ms === ms)) return null;
        const x = { ms, idx, weak }; out.push(x); return x;
    };
    const pushPast = (ms, idx) => { if (opts.past) push(ms, idx); };

    const nextOccurrence = (m, d) => {
        for (let y = refY; y <= refY + 4; y++) {   // 跳過不存在的日子（2/29）
            if (!validMD(y, m, d)) continue;
            const ms = Date.UTC(y, m - 1, d);
            if (ms >= refDay) return ms;
        }
        return null;
    };
    // 無年份、敘述已發生或將發生的事：ref 起 240 天內的未來優先（「12月25日聖誕節」六月說是今年底），
    // 否則取最近的過去（「3月5日去看醫生」六月說是今年三月，不是明年）
    const nearestOccurrence = (m, d) => {
        let past = null, future = null;
        for (let y = refY - 1; y <= refY + 1; y++) {
            if (!validMD(y, m, d)) continue;
            const ms = Date.UTC(y, m - 1, d);
            if (ms >= refDay) { if (future === null || ms < future) future = ms; }
            else if (past === null || ms > past) past = ms;
        }
        if (future !== null && (past === null || future - refDay <= 240 * DAY_MS)) return future;
        return past !== null ? past : future;
    };
    const monthDay = opts.nearest ? nearestOccurrence : nextOccurrence;
    const inMonth = (k, d) => {            // ref 所在月 +k 個月的第 d 天；不存在的日期回 null
        const mm = refM + k;
        const y = refY + Math.floor(mm / 12), m = ((mm % 12) + 12) % 12 + 1;
        return validMD(y, m, d) ? Date.UTC(y, m - 1, d) : null;
    };
    const monthEnd = (k) => {
        const mm = refM + k + 1;
        return Date.UTC(refY + Math.floor(mm / 12), ((mm % 12) + 12) % 12, 0);
    };

    let rest = t;
    const eat = (re, fn) => {
        rest = rest.replace(re, (...a) => { fn(a, a[a.length - 2]); return ' '.repeat(a[0].length); });
    };

    // 完整年月日
    eat(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日號号]?/g, (a, i) => {
        const [y, m, d] = [+a[1], +a[2], +a[3]];
        if (validMD(y, m, d)) push(Date.UTC(y, m - 1, d), i);
    });

    // 相對月份 + 幾號（先於一般「M月D日」，避免「下個月」的「月」被吃掉）
    eat(new RegExp(`(下(?:個)?月|上(?:個)?月|這(?:個)?月|本月)\\s*${NUM}\\s*${DAYSUF}`, 'g'), (a, i) => {
        const k = /^下/.test(a[1]) ? 1 : /^上/.test(a[1]) ? -1 : 0;
        const d = cnToInt(a[2]);
        if (d == null) return;
        const ms = inMonth(k, d);
        if (k < 0) pushPast(ms, i); else push(ms, i);
    });
    // 月底
    eat(/(下(?:個)?|上(?:個)?|這(?:個)?|本)?月底/g, (a, i) => {
        const k = !a[1] ? 0 : /^下/.test(a[1]) ? 1 : /^上/.test(a[1]) ? -1 : 0;
        if (k < 0) pushPast(monthEnd(k), i); else push(monthEnd(k), i);
    });
    // N 天後／N 週後（先於「M月D日」與相對日，避免「三日後」被當成幾號）
    eat(new RegExp(`${NUM}\\s*(?:個)?\\s*(天|日)\\s*(?:之|以)?後`, 'g'), (a, i) => {
        const n = cnToInt(a[1]); if (n != null && n >= 1 && n <= 730) push(refDay + n * DAY_MS, i);
    });
    eat(new RegExp(`${NUM}\\s*(?:個)?\\s*${WK}\\s*(?:之|以)?後`, 'g'), (a, i) => {
        const n = cnToInt(a[1]); if (n != null && n >= 1 && n <= 104) push(refDay + n * 7 * DAY_MS, i);
    });
    if (opts.past) {
        eat(new RegExp(`${NUM}\\s*(?:個)?\\s*(天|日)\\s*(?:之|以)?前`, 'g'), (a, i) => {
            const n = cnToInt(a[1]); if (n != null && n >= 1 && n <= 730) push(refDay - n * DAY_MS, i);
        });
    }

    // M月D日／M月D號（月日皆可為中文數字）
    eat(new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*${DAYSUF}`, 'g'), (a, i) => {
        const [m, d] = [cnToInt(a[1]), cnToInt(a[2])];
        if (m != null && d != null && m >= 1 && m <= 12) push(monthDay(m, d), i);
    });
    // M/D（前後不可再接數字，避開分數與年份片段）
    eat(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, (a, i) => {
        const [m, d] = [+a[1], +a[2]];
        if (m >= 1 && m <= 12) push(monthDay(m, d), i);
    });

    // 週幾（以週一為一週起點）；上週先吃掉，免得被當成「週X」而算成未來
    const monday = refDay - refWd * DAY_MS;
    eat(new RegExp(`上(?:個)?${WK}${WD}`, 'g'), (a, i) => pushPast(monday + (WEEKDAY[a[1]] - 7) * DAY_MS, i));
    eat(new RegExp(`下(?:個)?${WK}${WD}`, 'g'), (a, i) => push(monday + (7 + WEEKDAY[a[1]]) * DAY_MS, i));
    eat(new RegExp(`(?:這|本)(?:個)?${WK}${WD}`, 'g'), (a, i) => push(monday + WEEKDAY[a[1]] * DAY_MS, i));
    // 沒有前綴的「週X」：預設取 ref 起下一個（含當天）。past 模式（敘述已發生的事）下依語氣：
    // 週X 所在子句有完成語氣（了／過／剛）且沒有未來語氣（要／會／打算…）→ 取最近一個過去的（含當天）。
    // 實測：週二說「週六陪她在公園玩太久了」是剛過去的週六，取下一個會差一週。
    // 只看同一子句：「累死了，週六去爬山」的「了」屬於前一句，週六仍是未來。
    // 語氣只是猜測：past 模式下另附上一個／下一個兩個候選（cands），呼叫端有模型給的日期時以它選邊。
    const clauseAt = (i) => {
        const before = t.slice(0, i), after = t.slice(i);
        const start = Math.max(...[...CLAUSE_END].map(c => before.lastIndexOf(c))) + 1;
        const m = after.search(CLAUSE_END_RE);
        return t.slice(start, m < 0 ? t.length : i + m);
    };
    eat(new RegExp(`${WK}${WD}`, 'g'), (a, i) => {
        const fwd = (WEEKDAY[a[1]] - refWd + 7) % 7;
        const clause = opts.past ? clauseAt(i) : '';
        const back = opts.past && PAST_TONE.test(clause) && !FUTURE_TONE.test(clause);
        const x = push(refDay + (back && fwd > 0 ? fwd - 7 : fwd) * DAY_MS, i);
        if (x && opts.past && fwd > 0) x.cands = [refDay + (fwd - 7) * DAY_MS, refDay + fwd * DAY_MS];
    });

    // 相對日
    eat(/大後天|大后天/g, (a, i) => push(refDay + 3 * DAY_MS, i));
    eat(/後天|后天/g, (a, i) => push(refDay + 2 * DAY_MS, i));
    eat(/明天|明日/g, (a, i) => push(refDay + 1 * DAY_MS, i));
    if (opts.past) {
        eat(/大前天/g, (a, i) => push(refDay - 3 * DAY_MS, i, true));
        eat(/前天/g, (a, i) => push(refDay - 2 * DAY_MS, i, true));
        eat(/昨天|昨日|昨晚/g, (a, i) => push(refDay - 1 * DAY_MS, i, true));
        eat(/今天|今日|今晚|今早|今晨/g, (a, i) => push(refDay, i, true));
    }
    return out;
}

/** 文字 → Date（UTC 零點）陣列，依解析順序。G1 前瞻記憶用（預設只認「今天之後」的說法）。 */
function parseDatesFromText(text, ref, opts) {
    return scanDates(text, ref, opts).map(x => new Date(x.ms));
}

/**
 * 文字 → 文中最先出現的那個日期（'YYYY-MM-DD'），沒有回 null。Scribe 寫 event_at 用。
 * opts.hint（'YYYY-MM-DD…'，模型給的 event_at）：選中的是沒有前綴的「週X」時，
 * 在剛過去／下一個之間取離 hint 較近者（模型看得到上下文，方向較準；日期常差幾天，所以只拿來選邊）。
 */
function parseEventDateFromText(text, ref, opts = { past: true, nearest: true }) {
    // 「今天／昨天／前天」只是敘述時間的錨點，句中另有具體日期（下個月十五號）時以具體者為準
    const all = scanDates(text, ref, opts);
    const strong = all.filter(x => !x.weak);
    const list = (strong.length ? strong : all).sort((a, b) => a.idx - b.idx);
    if (!list.length) return null;
    let ms = list[0].ms;
    const hint = opts.hint ? Date.parse(String(opts.hint).slice(0, 10) + 'T00:00:00Z') : NaN;
    if (list[0].cands && Number.isFinite(hint)) {
        const [back, next] = list[0].cands;
        const db = Math.abs(hint - back), dn = Math.abs(hint - next);
        if (db !== dn) ms = db < dn ? back : next;   // 等距時維持語氣規則的結果
    }
    return new Date(ms).toISOString().slice(0, 10);
}

module.exports = { parseDatesFromText, parseEventDateFromText, cnToInt, scanDates };
