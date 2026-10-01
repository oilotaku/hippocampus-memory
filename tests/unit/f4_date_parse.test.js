'use strict';
// F4：日期解析共用模組（utils/dateParse.js）與 Scribe event_at 由程式換算（emotion.resolveEventAt）
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');
const { parseDatesFromText, parseEventDateFromText, cnToInt } = require('../../utils/dateParse');

const dbPath = setupEnv('f4-date');
let restore;
before(() => { restore = quiet(); });
after(() => { restore(); cleanupDb(dbPath); });

const utc = (s) => new Date(`${s}T00:00:00Z`);
const ev = (text, ref, opts) => parseEventDateFromText(text, utc(ref), opts);
const dates = (text, ref, opts) => parseDatesFromText(text, utc(ref), opts).map(d => d.toISOString().slice(0, 10));

describe('中文數字', () => {
    test('cnToInt', () => {
        for (const [s, n] of [['15', 15], ['十', 10], ['十五', 15], ['二十', 20], ['二十五', 25], ['三十一', 31], ['兩', 2], ['五', 5]]) assert.equal(cnToInt(s), n, s);
        assert.equal(cnToInt('好'), null);
    });
});

describe('下個月N號（G2 實測 8B 模型算錯的案例）', () => {
    test('2026-06-01 說「下個月十五號」→ 2026-07-15', () => {
        assert.equal(ev('我下個月十五號要去面試', '2026-06-01'), '2026-07-15');
    });
    test('各種寫法', () => {
        assert.equal(ev('下個月15號', '2026-06-01'), '2026-07-15');
        assert.equal(ev('下個月十五日', '2026-06-01'), '2026-07-15');
        assert.equal(ev('下月二十號', '2026-06-01'), '2026-07-20');
        assert.equal(ev('下个月十五号', '2026-06-01'), '2026-07-15');   // 簡體
        assert.equal(ev('這個月二十八號', '2026-06-01'), '2026-06-28');
        assert.equal(ev('本月三十日', '2026-06-01'), '2026-06-30');
    });
    test('跨年：12 月說下個月 → 隔年 1 月', () => {
        assert.equal(ev('下個月五號', '2026-12-20'), '2027-01-05');
        assert.equal(ev('下個月底', '2026-12-20'), '2027-01-31');
    });
    test('不存在的日期 → null（2 月 30 日、下個月 31 號但下月只有 30 天）', () => {
        assert.equal(ev('2月30日', '2026-01-10'), null);
        assert.equal(ev('下個月三十號', '2026-01-10'), null);      // 2026-02-30
        assert.equal(ev('下個月三十一號', '2026-06-10'), '2026-07-31');    // 存在則照算
        assert.equal(ev('下個月三十一號', '2026-05-10'), null);    // 2026-06-31 不存在
    });
});

describe('N天後／週後／月底', () => {
    test('N 天後', () => {
        assert.equal(ev('3天後要交報告', '2026-06-01'), '2026-06-04');
        assert.equal(ev('三日後', '2026-06-29'), '2026-07-02');
        assert.equal(ev('兩天之後', '2026-12-30'), '2027-01-01');
        assert.equal(ev('十天后', '2026-06-01'), '2026-06-11');
    });
    test('N 週／禮拜後', () => {
        assert.equal(ev('兩週後', '2026-06-01'), '2026-06-15');
        assert.equal(ev('三個禮拜後', '2026-06-01'), '2026-06-22');
    });
    test('月底', () => {
        assert.equal(ev('月底前要搬家', '2026-06-01'), '2026-06-30');
        assert.equal(ev('這個月底', '2026-02-10'), '2026-02-28');
        assert.equal(ev('下個月底', '2026-01-31'), '2026-02-28');
    });
});

describe('週幾', () => {
    // 2026-06-01 是週一
    test('下禮拜X／下週X／下個禮拜X／這週X', () => {
        assert.equal(ev('下禮拜三開會', '2026-06-01'), '2026-06-10');
        assert.equal(ev('下週五', '2026-06-01'), '2026-06-12');
        assert.equal(ev('下個禮拜天', '2026-06-01'), '2026-06-14');
        assert.equal(ev('這週四', '2026-06-01'), '2026-06-04');
        assert.equal(ev('周三', '2026-06-01'), '2026-06-03');
        assert.equal(ev('下礼拜三', '2026-06-01'), '2026-06-10');
    });
    test('沒有前綴的週X（past）：完成語氣取剛過去的，未來語氣或沒有語氣取下一個', () => {
        // 2026-01-20 是週二：「週六陪她玩太久了」＝1/17，不是 1/24
        assert.equal(ev('可能是週六陪語safe在永康公園玩太久了', '2026-01-20'), '2026-01-17');
        assert.equal(ev('週六去過那家店', '2026-01-20'), '2026-01-17');
        assert.equal(ev('週二剛跑完步', '2026-01-20'), '2026-01-20');               // 同一天：當天
        assert.equal(ev('週六要去高雄參加訂婚宴', '2026-08-11'), '2026-08-15');
        assert.equal(ev('週六約好了要去爬山', '2026-01-20'), '2026-01-24');        // 同時有「了」與未來語氣 → 未來
        assert.equal(ev('週六去爬山', '2026-01-20'), '2026-01-24');                // 沒有語氣 → 維持原本（下一個）
        assert.equal(ev('週六過來找我', '2026-01-20'), '2026-01-24');              // 「過來」不是完成語氣
        assert.deepEqual(dates('週六陪她玩太久了', '2026-01-20'), ['2026-01-24']);  // 前瞻模式不受影響
    });
    test('語氣只看週X所在子句；過生日／過年／不過不是完成語氣', () => {
        assert.equal(ev('累死了，週六去爬山', '2026-01-20'), '2026-01-24');        // 「了」在前一句
        assert.equal(ev('週六爬山，不過天氣不好', '2026-01-20'), '2026-01-24');
        assert.equal(ev('我週六過生日', '2026-01-20'), '2026-01-24');
        assert.equal(ev('週六過年回老家', '2026-01-20'), '2026-01-24');
        assert.equal(ev('我剛下班，週六要去爬山', '2026-01-20'), '2026-01-24');
        assert.equal(ev('週六玩太久了，累死', '2026-01-20'), '2026-01-17');        // 同一子句的「了」仍算
        assert.equal(ev('週六去過日本料理店', '2026-01-20'), '2026-01-17');        // 「去過」＋日本，不是「過日子」
    });
    test('hint（模型日期）決定沒有前綴的週X往前或往後；明確說法不受影響', () => {
        const H = (hint) => ({ past: true, nearest: true, hint });
        // 2026-01-20 週二：語氣規則判成過去的，模型說下週 → 下週六（模型日期差一天也對齊到週六）
        assert.equal(ev('週六的報告寫完了', '2026-01-20', H('2026-01-23')), '2026-01-24');
        // 語氣規則判成未來的，模型說上週 → 上週六
        assert.equal(ev('週六在公園遇到她', '2026-01-20', H('2026-01-17')), '2026-01-17');
        assert.equal(ev('週六在公園遇到她', '2026-01-20', H('2026-01-17T15:00')), '2026-01-17');
        // 沒有 hint → 語氣規則
        assert.equal(ev('週六的報告寫完了', '2026-01-20'), '2026-01-17');
        // hint 只取日期、比距離（上週六差 3 天、下週六差 4 天）；當天的 hint 由 resolveEventAt 先濾掉
        assert.equal(ev('週六去爬山', '2026-01-20', H('2026-01-20T12:00')), '2026-01-17');
        // 明確說法（下週六、上週六、日期）不看 hint
        assert.equal(ev('下週六去爬山', '2026-01-20', H('2026-01-17')), '2026-01-31');
        assert.equal(ev('上週六去爬山', '2026-01-20', H('2026-01-31')), '2026-01-17');
        assert.equal(ev('1月24日去爬山', '2026-01-20', H('2026-01-17')), '2026-01-24');
        // 當天說「週二」沒有歧義
        assert.equal(ev('週二剛跑完步', '2026-01-20', H('2026-01-13')), '2026-01-20');
    });
});

describe('既有寫法維持（G1）', () => {
    test('M月D日／M月D號／M/D／YYYY年M月D日／YYYY-MM-DD／明天後天大後天', () => {
        assert.equal(ev('6月15日', '2026-06-01'), '2026-06-15');
        assert.equal(ev('6月15號', '2026-06-01'), '2026-06-15');
        assert.equal(ev('6/15', '2026-06-01'), '2026-06-15');
        assert.equal(ev('2027年3月5日', '2026-06-01'), '2027-03-05');
        assert.equal(ev('2026-08-20', '2026-06-01'), '2026-08-20');
        assert.equal(ev('明天', '2026-06-01', {}), '2026-06-02');
        assert.equal(ev('後天', '2026-06-01', {}), '2026-06-03');
        assert.equal(ev('大後天', '2026-06-01', {}), '2026-06-04');
        assert.equal(ev('三月五日', '2026-06-01', {}), '2027-03-05');   // 預設：ref 起第一個出現（跨年）
    });
    test('預設（前瞻）不解析今天／昨天／上週；past 才解析', () => {
        assert.deepEqual(dates('昨天去看牙醫', '2026-06-10'), []);
        assert.deepEqual(dates('今天很累', '2026-06-10'), []);
        assert.deepEqual(dates('上週三開會', '2026-06-10'), []);   // 不可被當成「週三」而算成未來
        assert.equal(ev('昨天去看牙醫', '2026-06-10'), '2026-06-09');
        assert.equal(ev('上週三開會', '2026-06-10'), '2026-06-03');
        assert.equal(ev('上個月十五號搬家', '2026-06-10'), '2026-05-15');
        assert.equal(ev('三天前', '2026-06-10'), '2026-06-07');
    });
    test('無年份月日：nearest：240 天內未來優先、否則最近的過去（已發生的事不會跳到明年）', () => {
        assert.equal(ev('3月5日去看醫生', '2026-06-10'), '2026-03-05');
        assert.equal(ev('12月25日聖誕節', '2026-06-10'), '2026-12-25');
        assert.equal(ev('1月3日', '2026-12-20'), '2027-01-03');
        assert.equal(ev('12月30日', '2027-01-05'), '2026-12-30');
        assert.equal(ev('2月14日', '2026-06-10'), '2026-02-14');   // 未來要 8 個月 → 取過去
    });
    test('多個日期取文中最先出現者；日常句子沒有日期', () => {
        assert.equal(ev('7月3號出發，7月9號回來', '2026-06-01'), '2026-07-03');
        assert.equal(ev('最近睡不好，覺得有點焦慮', '2026-06-01'), null);
        assert.equal(ev('我每次壓力大就想吃拉麵', '2026-06-01'), null);
        assert.equal(ev('', '2026-06-01'), null);
        assert.equal(ev(null, '2026-06-01'), null);
    });
});

describe('emotion.resolveEventAt：quote 為準、模型為備援', () => {
    const { resolveEventAt } = require('../../services/emotion/store');
    const TZ = 'Asia/Taipei';
    const raised = '2026-06-01 02:00:00';   // UTC；台北為 06-01 10:00
    test('quote 有日期 → 以程式結果為準，覆蓋模型的錯誤輸出', () => {
        assert.equal(resolveEventAt({ type: 'event', quote: '我下個月十五號要去面試', event_at: '2026-06-15' }, raised, TZ), '2026-07-15');
    });
    test('quote 無日期、模型填訊息當天 → 不可信 → null', () => {
        assert.equal(resolveEventAt({ type: 'state', quote: '最近睡不好', event_at: '2026-06-01' }, raised, TZ), null);
    });
    test('訊息時間跨日：UTC 前一天、台北已是隔天，兩種當天都算「訊息當天」', () => {
        const late = '2026-05-31 20:00:00';   // 台北 06-01 04:00
        assert.equal(resolveEventAt({ type: 'state', quote: '好累', event_at: '2026-06-01' }, late, TZ), null);
        assert.equal(resolveEventAt({ type: 'state', quote: '好累', event_at: '2026-05-31' }, late, TZ), null);
    });
    test('以當地日曆日為基準：台北 06-01 04:00 說「明天」→ 06-02', () => {
        assert.equal(resolveEventAt({ type: 'event', quote: '明天要考試' }, '2026-05-31 20:00:00', TZ), '2026-06-02');
    });
    test('quote 無日期、模型給了別天 → 採用模型（備援）；YYYY-MM 保留', () => {
        assert.equal(resolveEventAt({ type: 'event', quote: '那次旅行超開心', event_at: '2026-03-08' }, raised, TZ), '2026-03-08');
        assert.equal(resolveEventAt({ type: 'event', quote: '那次旅行超開心', event_at: '2026-03' }, raised, TZ), '2026-03');
    });
    test('無時間性類型一律 null；亂碼 null', () => {
        assert.equal(resolveEventAt({ type: 'preference', quote: '下個月十五號', event_at: '2026-07-15' }, raised, TZ), null);
        assert.equal(resolveEventAt({ type: 'event', quote: '嗯', event_at: '明天' }, raised, TZ), null);
    });
    test('沒有前綴的週X：依模型 event_at 選上週或下週；模型只填當天不算', () => {
        // 台北 2026-06-01（週一）
        assert.equal(resolveEventAt({ type: 'event', quote: '週六的報告寫完了', event_at: '2026-06-05' }, raised, TZ), '2026-06-06');
        assert.equal(resolveEventAt({ type: 'event', quote: '週六去爬山', event_at: '2026-05-30' }, raised, TZ), '2026-05-30');
        assert.equal(resolveEventAt({ type: 'event', quote: '週六去爬山', event_at: '2026-06-01' }, raised, TZ), '2026-06-06');
        assert.equal(resolveEventAt({ type: 'event', quote: '週六玩太久了', event_at: null }, raised, TZ), '2026-05-30');
    });
    test('「今天」在 quote 中 → 事件就是訊息當天（有日期片語，可信）', () => {
        assert.equal(resolveEventAt({ type: 'event', quote: '今天去看牙醫', event_at: null }, raised, TZ), '2026-06-01');
    });
});
