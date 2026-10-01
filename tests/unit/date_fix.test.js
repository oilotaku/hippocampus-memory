'use strict';
// 記憶內文日期與星期一致性校正（dentate/dateFix.js）。日期皆為 2026 年實際日曆：2026-03-10 週二。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fixDateWeekday } = require('../../services/hippocampus/dentate/dateFix');

describe('fixDateWeekday', () => {
    test('日期與星期一致 → 不動', () => {
        const r = fixDateWeekday('3月18日（週三）回診', '下週三回診', '2026-03-10');
        assert.equal(r.content, '3月18日（週三）回診');
        assert.equal(r.fixes.length, 0);
    });
    test('原話有相對說法 → 依訊息日期換算（下週三＝3/18）', () => {
        const r = fixDateWeekday('林怡廷計畫在3月19日（週三）帶語safe回診', '下週三要帶她回成大回診', '2026-03-10');
        assert.equal(r.content, '林怡廷計畫在3月18日（週三）帶語safe回診');
        assert.equal(r.fixes[0].how, 'relative');
    });
    test('這週、上週、明天、大後天', () => {
        assert.equal(fixDateWeekday('3月13日（週六）', '這週六去', '2026-03-10').content, '3月14日（週六）');
        assert.equal(fixDateWeekday('3月5日（週五）', '上週五去過', '2026-03-10').content, '3月6日（週五）');
        assert.equal(fixDateWeekday('3月12日（週三）', '明天要開會', '2026-03-10').content, '3月11日（週三）');
        assert.equal(fixDateWeekday('3月14日（週五）', '大後天出發', '2026-03-10').content, '3月13日（週五）');
    });
    test('原話只說「週六」（可能是過去或未來）→ 不換算，取最近的同星期日期', () => {
        // 週二（1/20）說「週六陪她去公園玩」＝剛過去的 1/17；換算成下週六（1/24）是錯的
        const r = fixDateWeekday('1月18日（週六）陪語safe去永康公園', '可能是週六陪語safe在永康公園玩太久了', '2026-01-20');
        assert.equal(r.content, '1月17日（週六）陪語safe去永康公園');
        assert.equal(r.fixes[0].how, 'nearest');
        assert.equal(fixDateWeekday('全家於8月12日（週六）前往高雄', '週六要去高雄參加訂婚宴', '2026-08-11').content, '全家於8月15日（週六）前往高雄');
    });
    test('「上週六」「下週三」有前綴 → 依訊息日期換算（實測兩例）', () => {
        assert.equal(fixDateWeekday('4月5日（週六）騎腳踏車', '上週六在永康公園就已經能騎一小段了', '2026-04-14').content, '4月11日（週六）騎腳踏車');
        assert.equal(fixDateWeekday('10月9日（週三）校外教學', '下週三要帶小宇去校外教學', '2026-10-06').content, '10月14日（週三）校外教學');
    });
    test('沒有相對說法 → 信星期，改成前後 3 天內同星期的日期', () => {
        const r = fixDateWeekday('全家於8月12日（週六）前往高雄', '要去高雄參加訂婚宴', '2026-08-11');
        assert.equal(r.content, '全家於8月15日（週六）前往高雄');
        assert.equal(r.fixes[0].how, 'nearest');
        assert.equal(fixDateWeekday('2月24日（週三）下午3點開會', '要開IEP會議', '2026-02-17').content, '2月25日（週三）下午3點開會');
    });
    test('原話寫了日期 → 信日期，改星期', () => {
        const r = fixDateWeekday('3月19日（週三）回診', '3月19日要回診', '2026-03-10');
        assert.equal(r.content, '3月19日（週四）回診');
        assert.equal(r.fixes[0].how, 'weekday');
        assert.equal(fixDateWeekday('3月19日（週三）回診', '3/19回診', '2026-03-10').content, '3月19日（週四）回診');
    });
    test('跨月、跨年、寫了年份、半形括號與「星期」', () => {
        assert.equal(fixDateWeekday('1月1日（週五）', '下週五', '2026-12-28').content, '1月1日（週五）');
        assert.equal(fixDateWeekday('2026年3月19日(星期三)', '下星期三', '2026-03-10').content, '2026年3月18日(星期三)');
        assert.equal(fixDateWeekday('4月1日（週二）', '下週二', '2026-03-26').content, '3月31日（週二）');
    });
    test('無效日期、沒有星期、refDate 無效 → 不動', () => {
        assert.equal(fixDateWeekday('2月30日（週一）', '', '2026-02-10').content, '2月30日（週一）');
        assert.equal(fixDateWeekday('3月19日要回診', '', '2026-03-10').fixes.length, 0);
        assert.equal(fixDateWeekday('3月19日（週三）', '', null).content, '3月19日（週三）');
    });
    test('一句多個日期各自校正', () => {
        const r = fixDateWeekday('8月12日（週六）出發，8月11日（週五）晚間返回', '', '2026-08-11');
        assert.equal(r.content, '8月15日（週六）出發，8月14日（週五）晚間返回');
        assert.equal(r.fixes.length, 2);
    });
});
