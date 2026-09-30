'use strict';
// W9：簡繁並存。外部輸入（使用者訊息、LLM 輸出、舊資料庫裡的簡體內容）與程式內的繁體常數互相比對時，
// 簡體與繁體都要命中。本檔的簡體字串都是「刻意保留的簡體輸入」，請勿轉成繁體。
// npm test 會分別在 MEMORY_ENCRYPTION=on／off 兩種模式下各跑一遍（檢索案例兩種模式都要通過）。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');

const dbPath = setupEnv('zhvariants');

const { toTraditionalChars, MAP_SIZE } = require('../../utils/zhNormalize');
const { toIndexTokens, toIndexTokenList, toMatchQuery, TOKENIZER_VERSION } = require('../../utils/cjkTokenize');
const Q = require('../../services/scribeQuality');
const guards = require('../../services/archivist/guards');

after(() => { cleanupDb(dbPath); });

describe('zhNormalize：逐字簡轉繁', () => {
    test('正規化結果不含 CJK 相容表意字元（例如「六」不會變成 U+F9D1）', () => {
        const isCompat = (ch) => { const c = ch.codePointAt(0); return (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x2F800 && c <= 0x2FA1F); };
        const { MAP_ENTRIES } = require('../../utils/zhNormalize');
        for (const [from, to] of MAP_ENTRIES()) {
            assert.ok(!isCompat(to), `對照表目標含相容字元：${from} → U+${to.codePointAt(0).toString(16)}`);
        }
        for (const s of ['週六', '六月', '流行', '調整', '亮度', '洞察', '禮物', '畫畫']) {
            const out = toTraditionalChars(s);
            assert.ok(![...out].some(isCompat), `${s} → ${out} 含相容字元`);
            assert.equal(out, out.normalize('NFC'));
        }
        assert.equal(toTraditionalChars('周六'), toTraditionalChars('週六'));
        assert.equal(toTraditionalChars('\uF9D1'), '六');
    });
    test('正規化後仍能被一般字寫成的關鍵字比對到', () => {
        assert.ok(/週六|禮拜六|星期六/.test(toTraditionalChars('这周六要去看电影')));
        assert.ok(/六月/.test(toTraditionalChars('六月份')));
    });
    test('對照表夠大、null 安全、繁體字不變', () => {
        assert.ok(MAP_SIZE >= 3000, `對照表只有 ${MAP_SIZE} 字`);
        assert.equal(toTraditionalChars(null), '');
        assert.equal(toTraditionalChars(undefined), '');
        assert.equal(toTraditionalChars('媽媽的生日'), '媽媽的生日');
        assert.equal(toTraditionalChars('abc 123 ，。'), 'abc 123 ，。');
    });
    test('簡體逐字轉成繁體；異體字也歸一', () => {
        // 代表字由對照表決定（同組字形歸一），所以用「簡體與繁體轉出來相同」來斷言
        assert.equal(toTraditionalChars('我对什么过敏'), toTraditionalChars('我對什麼過敏'));
        assert.equal(toTraditionalChars('妈妈生日'), toTraditionalChars('媽媽生日'));
        assert.equal(toTraditionalChars('一只狗'), toTraditionalChars('一隻狗'));
        assert.equal(toTraditionalChars('周末'), toTraditionalChars('週末'));
        assert.equal(toTraditionalChars('后天'), toTraditionalChars('後天'));
        assert.equal(toTraditionalChars('台北'), toTraditionalChars('臺北'));
        assert.notEqual(toTraditionalChars('妈妈'), '妈妈');
        assert.equal(toTraditionalChars('哪里'), toTraditionalChars('哪裡'));
        assert.equal(toTraditionalChars('为什么'), toTraditionalChars('為什麼'));
    });
    test('只做逐字對照，不做詞語替換、不改字數', () => {
        const s = '软件和内存';
        assert.equal(toTraditionalChars(s).length, s.length);
        assert.equal(toTraditionalChars(s), toTraditionalChars('軟件和內存'));
    });
});

describe('cjkTokenize：斷詞前先簡轉繁', () => {
    test('簡體與繁體產生相同的索引 token 與查詢', () => {
        assert.equal(toIndexTokens('我对花生过敏').trim(), toIndexTokens('我對花生過敏').trim());
        assert.deepEqual(toIndexTokenList('妈妈生日'), toIndexTokenList('媽媽生日'));
        assert.equal(toMatchQuery('我对什么过敏'), toMatchQuery('我對什麼過敏'));
    });
    test('停用字集合含簡體時，簡體 token 一樣被濾掉', () => {
        const stop = new Set(['的', '们']);
        assert.deepEqual(require('../../utils/cjkTokenize').toQueryTokens('們的', { stopChars: stop }), []);
        assert.deepEqual(require('../../utils/cjkTokenize').toQueryTokens('们的', { stopChars: stop }), []);
    });
    test('斷詞版本字串（索引指紋的一部分）', () => {
        assert.equal(TOKENIZER_VERSION, 'cjk-bigram-v3-t');
        const mc = require('../../services/memoryCrypto');
        assert.ok(mc.indexFingerprint().endsWith(':cjk-bigram-v3-t'));
    });
});

describe('FTS 檢索：簡體內容可被繁體查詢命中、繁體內容可被簡體查詢命中', () => {
    let restore, db, librarian, mc;
    before(() => {
        restore = quiet();
        db = require('../../database').initDatabase();
        mc = require('../../services/memoryCrypto');
        librarian = require('../../services/librarian');
        const s = mc.sealField;
        const ins = db.prepare(`INSERT INTO memory_fragments (type, entity, content, quote, source, status) VALUES ('fact', 'E', ?, ?, 'chat', 'active')`);
        for (const t of ['使用者对花生过敏', '妈妈的生日是三月五日', '住在新北三重', '喜歡看電影，尤其是恐怖電影', '週末去爬山']) {
            ins.run(s('memory_fragments', 'content', t), s('memory_fragments', 'quote', t));
        }
        db.prepare(`INSERT INTO memories (title, content, tags, layer, status) VALUES (?, ?, '[]', 'episode', 'permanent')`)
            .run(s('memories', 'title', '关于拉面的回忆'), s('memories', 'content', '去了一间很好吃的拉面店'));
    });
    after(() => { restore(); });
    const top = (q) => librarian.searchFragments(q, 8).map(r => r.content);

    test('簡體內容（花生过敏）← 繁體查詢與簡體查詢都命中第一名', () => {
        assert.equal(top('我對什麼過敏')[0], '使用者对花生过敏');
        assert.equal(top('我对什么过敏')[0], '使用者对花生过敏');
        assert.equal(top('花生過敏')[0], '使用者对花生过敏');
    });
    test('簡體內容（妈妈生日）← 繁體查詢命中', () => {
        assert.equal(top('媽媽生日')[0], '妈妈的生日是三月五日');
        assert.equal(top('妈妈生日')[0], '妈妈的生日是三月五日');
    });
    test('繁體內容 ← 簡體查詢命中', () => {
        assert.equal(top('恐怖电影')[0], '喜歡看電影，尤其是恐怖電影');
        assert.equal(top('住在哪里三重')[0], '住在新北三重');
        assert.ok(top('週末').includes('週末去爬山'));
        assert.ok(top('周末').includes('週末去爬山'));
    });
    test('episode 通道（memories.title 索引）簡繁互通', () => {
        assert.ok(librarian.searchFragments('關於拉麵', 8).some(r => r.source_table === 'memory' && r.content.includes('拉面')));
        assert.ok(librarian.searchFragments('关于拉面', 8).some(r => r.source_table === 'memory' && r.content.includes('拉面')));
    });
});

describe('scribeQuality：quote 驗證與去重簡繁互通', () => {
    test('使用者用簡體、模型抄成繁體 → 通過；反過來也通過', () => {
        assert.equal(Q.validateQuote({ quote: '我養了一隻叫豆豆的狗' }, { user: ['我养了一只叫豆豆的狗'] }).ok, true);
        assert.equal(Q.validateQuote({ quote: '我养了一只叫豆豆的狗' }, { user: ['我養了一隻叫豆豆的狗'] }).ok, true);
        assert.equal(Q.validateQuote({ quote: '我养了一只叫豆豆的狗' }, { user: ['我養了一隻貓'] }).ok, false);
    });
    test('關鍵 token（星期／時間詞／數字）簡繁都能區分不同事實', () => {
        // 同一句只差「週三／週五」：繁體、簡體都不能被誤合併
        assert.equal(Q.isNearDuplicate('小明星期三要去臺北開會討論預算', '小明星期五要去臺北開會討論預算'), false);
        assert.equal(Q.isNearDuplicate('小明礼拜三要去台北开会讨论预算', '小明礼拜五要去台北开会讨论预算'), false);
        assert.equal(Q.isNearDuplicate('小明上个月搬到新北市三重區', '小明下个月搬到新北市三重區'), false);
        assert.equal(Q.isNearDuplicate('小明上個月搬到新北市三重區', '小明下個月搬到新北市三重區'), false);
        // 簡繁混寫、內容相同 → 視為重複
        assert.equal(Q.isNearDuplicate('小明礼拜三要去台北开会', '小明禮拜三要去臺北開會'), true);
        assert.equal(Q.isNearDuplicate('小明两点去医院', '小明兩點去醫院'), true);
    });
    test('normalizedContentHash：簡體與繁體同一句得到同一個雜湊', () => {
        assert.equal(Q.normalizedContentHash('小明', '小明养了一只狗'), Q.normalizedContentHash('小明', '小明養了一隻狗'));
    });
});

describe('比對外部輸入的中文常數：簡繁兩種寫法都命中', () => {
    const lib = require('../../services/librarian');
    test('意圖關鍵字（long_term／summary／fact）', () => {
        const cases = [
            ['還記得那家店嗎', 'long_term'], ['还记得那家店吗', 'long_term'],
            ['這段時間進展如何', 'summary'], ['这段时间进展如何', 'summary'],
            ['我們聊了什麼', 'summary'], ['我们聊了什么', 'summary'],
            ['他的電話是多少', 'fact'], ['他的电话是多少', 'fact'],
            ['花了30塊', 'fact'], ['花了30块', 'fact'], ['今年 25 歲', 'fact'], ['今年 25 岁', 'fact'],
            ['我很開心', 'semantic'], ['我很开心', 'semantic'],
        ];
        for (const [q, want] of cases) assert.equal(lib.classifyIntent(q), want, q);
    });

    test('近況哨兵（無明顯變化）', () => {
        for (const s of ['無明顯變化', '無明顯變化。', '暫無', '無', '近期無新動態',
            '无明显变化', '无明显变化。', '暂无', '无', '近期无新动态']) {
            assert.equal(guards.isNoChangeSentinel(s), true, s);
        }
        for (const s of ['新增了兩項待辦事項。', '新增了两项待办事项。', '無花果採購', '无花果采购', '無明顯變化發生後的安排', '无明显变化发生后的安排']) {
            assert.equal(guards.isNoChangeSentinel(s), false, s);
        }
    });

    test('日期時間短語與期間詞的種子名守衛', () => {
        for (const s of ['日晚', '日凌晨', '周六', '週六', '三點半', '三点半', '年月日']) assert.equal(guards.isTimePhraseName(s), true, s);
        for (const s of ['阿日斯蘭', '阿日斯兰', '下午茶', '點數', '点数']) assert.equal(guards.isTimePhraseName(s), false, s);
        for (const s of ['籌備季', '筹备季', '審計期', '审计期', '交付歷程', '交付历程', '遷移過程', '迁移过程', '試運行階段', '试运行阶段']) {
            assert.equal(guards.isPeriodPhraseName(s), true, s);
        }
        for (const s of ['曼哈頓計劃', '曼哈顿计划']) assert.equal(guards.isPeriodPhraseName(s), false, s);
    });

    test('近況哨兵、健康簡報：健康資料檔簡繁都能解析', () => {
        const ctx = require('../../services/context');
        if (typeof ctx.generateHealthSummary !== 'function') return;   // 未匯出時略過
        const trad = '   時間段：04-01 01:45 → 04-01 08:24\n   總時長：420 分鐘 (7.0 小時)\n   睡眠效率：90%\n   靜息心率：60 bpm 基線：62 bpm\n   HRV：35.3 ms\n   步數：8000 步';
        const simp = trad.replace('時間段', '时间段').replace('總時長', '总时长').replace('分鐘', '分钟').replace('小時', '小时').replace('睡眠效率', '睡眠效率').replace('靜息心率', '静息心率').replace('基線', '基线').replace('步數', '步数');
        assert.equal(ctx.generateHealthSummary(simp), ctx.generateHealthSummary(trad));
    });
});
