'use strict';
// W3：记忆本体静态加密 + FTS 盲索引。LLM／Chroma 全部 stub，不连网。
// 同程序内跑 MEMORY_ENCRYPTION=on 的情境；需要换环境变数重开库的（off→on 迁移、迁移失败、金钥轮替）
// 交给 _memenc_child.js 子程序。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { setupEnv, cleanupDb, quiet, TEST_KEY } = require('./_helpers');

const dbPath = setupEnv('memenc');
process.env.MEMORY_ENCRYPTION = 'on';

const ROOT = path.join(__dirname, '..', '..');
const CHILD = path.join(__dirname, '_memenc_child.js');
const WORDS = ['媽媽', '生日', '三重', '動畫', '恐怖', '電影', '台積電', '上班', '豆豆', '花生過敏', '拉麵'];

let restore, db, mc, librarian, scribe;
const rawPrepare = (sql) => Object.getPrototypeOf(db).prepare.call(db, sql);

// stub：LLM 回传指定 entries；Chroma 一律不可用
const llm = require('../../services/llm');
const memory = require('../../services/memory');
let llmEntries = [];
llm.callLLM = async () => ({ reply: JSON.stringify({ entries: llmEntries, fulfilled_intention_ids: [] }) });
memory.chromaDBOperation = async () => { throw new Error('ECONNREFUSED (stub)'); };
memory.searchMemoriesByVector = async () => [];

before(() => {
    restore = quiet();
    db = require('../../database').initDatabase();
    mc = require('../../services/memoryCrypto');
    librarian = require('../../services/librarian');
    librarian.searchHybrid = async () => [];   // scribe 执行时才解构，替换有效
    scribe = require('../../services/scribe');
});
after(() => { restore(); cleanupDb(dbPath); });

function child(scenario, env, args) {
    const out = execFileSync(process.execPath, [CHILD, scenario, JSON.stringify(args || {})], {
        cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const line = out.split('\n').find(l => l.startsWith('@@RESULT@@'));
    assert.ok(line, '子程序没有结果：' + out.slice(-500));
    const r = JSON.parse(line.slice('@@RESULT@@'.length));
    assert.ok(!r.error, r.error);
    return r;
}
function tmpDb(tag) {
    return path.join(os.tmpdir(), `mc-memenc-${tag}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
}
const allRaw = (raw) => Object.values(raw).flat().map(r => r.v).filter(v => typeof v === 'string' && v !== '');

let nextMsgId = 1;
const msg = (sender, content, ts) => ({ id: nextMsgId++, sender, content, timestamp: ts, message_type: 'text', is_encrypted: 0 });
const entry = (over) => ({ type: 'fact', entities: [{ name: 'W3實體', relation: 'related_to' }], content: '', emotional_weight: 0.2, value_tags: [], source: 'chat', ...over });
async function runScribe(entries, msgs) { llmEntries = entries; return scribe.runScribe(msgs, msgs[msgs.length - 1].timestamp); }

describe('on：写入即加密，DB 档案里找不到明文', () => {
    test('scribe 写入路径：content／quote 是 v2 密文且 AAD 绑表:栏', async () => {
        const r = await runScribe([entry({ content: 'W3實體養了一隻叫豆豆的狗', quote: '我養了一隻叫豆豆的狗' })],
            [msg('user', '我養了一隻叫豆豆的狗', '2026-05-01 10:00:00')]);
        assert.equal(r.written, 1);
        const raw = rawPrepare("SELECT content, quote, content_hash FROM memory_fragments WHERE entity = 'W3實體'").get();
        assert.match(raw.content, /^enc:v2:k1:/);
        assert.match(raw.quote, /^enc:v2:k1:/);
        const { encryption } = require('../../encryption');
        assert.equal(encryption.decrypt(raw.content, { aad: 'memory_fragments:content', silent: true }), 'W3實體養了一隻叫豆豆的狗');
        assert.equal(encryption.decrypt(raw.content, { aad: 'memory_fragments:quote', silent: true }), null);
        // content_hash 是带金钥的 HMAC，不是明文的 SHA-256
        const Q = require('../../services/scribeQuality');
        const plainSha = crypto.createHash('sha256').update(`${Q.normalizeText('W3實體')}\u0000${Q.normalizeText('W3實體養了一隻叫豆豆的狗')}`).digest('hex');
        assert.notEqual(raw.content_hash, plainSha);
        assert.equal(raw.content_hash, Q.normalizedContentHash('W3實體', 'W3實體養了一隻叫豆豆的狗'));
        // 透明解密：一般 SELECT 读到明文
        const row = db.prepare("SELECT content, quote FROM memory_fragments WHERE entity = 'W3實體'").get();
        assert.equal(row.content, 'W3實體養了一隻叫豆豆的狗');
        assert.equal(row.quote, '我養了一隻叫豆豆的狗');
    });

    test('八个加密栏位 + 两个 FTS 表：DB／WAL 档案 bytes 找不到已知中文词', () => {
        const s = mc.sealField;
        const CORPUS = ['使用者住在新北三重', '媽媽下週三生日', '喜歡看動畫不喜歡恐怖片', '使用者在台積電上班', '週末喜歡看電影，尤其是恐怖電影'];
        const ins = db.prepare(`INSERT INTO memory_fragments (type, entity, content, quote, source, status) VALUES ('fact', 'E', ?, ?, 'chat', 'active')`);
        for (const t of CORPUS) ins.run(s('memory_fragments', 'content', t), s('memory_fragments', 'quote', t));
        db.prepare(`INSERT INTO memories (title, content, tags, layer, status) VALUES (?, ?, '[]', 'episode', 'permanent')`)
            .run(s('memories', 'title', '拉麵與動畫'), s('memories', 'content', '媽媽生日那天去看恐怖電影'));
        db.prepare(`INSERT INTO entity_profiles (name, category, facts, current_status, judgment, overview) VALUES ('E', 'person', ?, ?, ?, ?)`)
            .run(s('entity_profiles', 'facts', '住在三重'), s('entity_profiles', 'current_status', '在台積電上班'),
                s('entity_profiles', 'judgment', '喜歡動畫'), s('entity_profiles', 'overview', '對花生過敏'));
        // 原始值全是密文
        for (const [t, cols] of Object.entries(mc.FIELDS)) {
            for (const c of cols) {
                for (const r of rawPrepare(`SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND ${c} != ''`).all()) {
                    assert.match(r.v, /^enc:v2:/, `${t}.${c} 有明文`);
                }
            }
        }
        // FTS 表内容也不含明文（memories_fts 存的是 token 字串）
        for (const r of rawPrepare('SELECT title FROM memories_fts').all()) {
            for (const w of WORDS) assert.ok(!r.title.includes(w), 'memories_fts 有明文 ' + w);
        }
        db.pragma('wal_checkpoint(TRUNCATE)');
        for (const suffix of ['', '-wal']) {
            let buf; try { buf = fs.readFileSync(dbPath + suffix); } catch (_) { continue; }
            for (const w of WORDS) assert.equal(buf.indexOf(Buffer.from(w, 'utf8')), -1, `档案${suffix || ''}里找到明文「${w}」`);
        }
    });
});

describe('on：检索（盲索引）', () => {
    test('动画／三重／妈妈生日／恐怖电影／我在哪上班 第一名正确', () => {
        const top = (q) => librarian.searchFragments(q, 8).map(r => r.content);
        assert.equal(top('動畫')[0], '喜歡看動畫不喜歡恐怖片');
        assert.ok(!top('動畫').some(c => c === '動物園很好玩'));
        assert.equal(top('三重')[0], '使用者住在新北三重');
        assert.equal(top('媽媽生日')[0], '媽媽下週三生日');
        assert.equal(top('恐怖電影')[0], '週末喜歡看電影，尤其是恐怖電影');
        assert.equal(top('我在哪上班')[0], '使用者在台積電上班');
        assert.deepEqual(top(''), []);
        assert.doesNotThrow(() => top('NEAR( OR "a'));
        // episode 通道（memories.title 盲索引）
        assert.ok(librarian.searchFragments('拉麵', 8).some(r => r.source_table === 'memory' && r.content === '拉麵與動畫'));
    });

    test('排名与明文模式完全相同（同一组语料，on 与 off 各开一个库比对）', () => {
        const on = child('seed', { DB_PATH: tmpDb('rank-on'), MEMORY_ENCRYPTION: 'on' });
        const off = child('seed', { DB_PATH: tmpDb('rank-off'), MEMORY_ENCRYPTION: 'off' });
        assert.deepEqual(on.top, off.top);
        assert.ok(on.top['媽媽生日'].length > 0);
        // off 库里是明文、on 库里是密文
        assert.ok(allRaw(off.raw).every(v => !v.startsWith('enc:')));
        assert.ok(allRaw(on.raw).every(v => v.startsWith('enc:v2:')));
    });

    test('更新与删除后索引同步（无幽灵 posting）', () => {
        const s = (t) => mc.sealField('memory_fragments', 'content', t);
        const id = db.prepare(`INSERT INTO memory_fragments (type, entity, content, source, status) VALUES ('fact', '', ?, 'chat', 'active')`).run(s('養了一隻柴犬')).lastInsertRowid;
        assert.equal(librarian.searchFragments('柴犬')[0].id, id);
        db.prepare('UPDATE memory_fragments SET content = ? WHERE id = ?').run(s('養了一隻貓咪'), id);
        assert.equal(librarian.searchFragments('柴犬').length, 0);
        assert.equal(librarian.searchFragments('貓咪')[0].id, id);
        db.prepare('UPDATE memory_fragments SET read_count = 3 WHERE id = ?').run(id);   // 非内容栏位更新不影响索引
        assert.equal(librarian.searchFragments('貓咪')[0].id, id);
        db.prepare('DELETE FROM memory_fragments WHERE id = ?').run(id);
        assert.equal(librarian.searchFragments('貓咪').length, 0);
        const docs = rawPrepare('SELECT COUNT(*) c FROM memory_fragments_fts_docsize').get().c;
        assert.equal(docs, rawPrepare('SELECT COUNT(*) c FROM memory_fragments').get().c);
    });

    test('FTS 盲 token 只是 16 hex；entity 栏维持明文两字组', () => {
        const blind = require('../../utils/blindIndex');
        const t = blind.blindTokens('媽媽生日', mc.DOMAIN_MF_CONTENT).split(' ');
        assert.equal(t.length, 3);
        assert.ok(t.every(x => /^[0-9a-f]{16}$/.test(x)));
        // 不同栏位 domain 的 token 不同
        assert.notEqual(blind.blindToken('媽媽', mc.DOMAIN_MF_CONTENT), blind.blindToken('媽媽', mc.DOMAIN_MEM_TITLE));
        assert.match(mc.fragmentsMatchQuery(['媽媽']), /^content : "[0-9a-f]{16}" OR entity : "媽媽"$/);
    });
});

describe('AAD 与解密失败的安全处理', () => {
    test('把密文搬到别的栏位／别的表 → 读回 null，不会回传 enc: 字串', () => {
        const s = mc.sealField;
        const a = db.prepare(`INSERT INTO memory_fragments (type, entity, content, quote, source, status) VALUES ('fact','AAD',?,?,'chat','active')`)
            .run(s('memory_fragments', 'content', '秘密內容甲'), s('memory_fragments', 'quote', '秘密引用甲')).lastInsertRowid;
        const m = db.prepare(`INSERT INTO memories (title, content, tags) VALUES (?, ?, '[]')`).run(s('memories', 'title', '標題乙'), s('memories', 'content', '內容乙')).lastInsertRowid;
        const rawA = rawPrepare('SELECT content FROM memory_fragments WHERE id = ?').get(a).content;
        const rawM = rawPrepare('SELECT content FROM memories WHERE id = ?').get(m).content;
        // content → quote（同表不同栏）；memories.content → memory_fragments.content（跨表）
        rawPrepare('UPDATE memory_fragments SET quote = ? WHERE id = ?').run(rawA, a);
        const b = rawPrepare(`INSERT INTO memory_fragments (type, entity, content, source, status) VALUES ('fact','AAD2',?,'chat','active')`).run(rawM).lastInsertRowid;
        mc.clearCache();
        const ra = db.prepare('SELECT * FROM memory_fragments WHERE id = ?').get(a);
        assert.equal(ra.content, '秘密內容甲');
        assert.equal(ra.quote, null);
        const rb = db.prepare('SELECT id, content FROM memory_fragments WHERE id = ?').get(b);
        assert.equal(rb.content, null);
        assert.equal(mc.openField('memory_fragments', 'content', rawM), null);
        assert.equal(mc.openField('memories', 'content', rawM), '內容乙');
        // 所有记忆栏位的 SELECT 都不会漏出 enc: 字串
        for (const t of Object.keys(mc.FIELDS)) {
            for (const row of db.prepare(`SELECT * FROM ${t}`).all()) {
                for (const c of mc.FIELDS[t]) assert.ok(!(typeof row[c] === 'string' && row[c].startsWith('enc:')), `${t}.${c} 漏出密文`);
            }
        }
        // 检索／格式化路径不崩溃（解不开的碎片不索引 → 搜不到）
        assert.doesNotThrow(() => librarian.searchFragments('內容乙'));
        assert.equal(librarian.searchFragments('內容乙').filter(r => r.id === b).length, 0);
        assert.equal(librarian.formatForContext([{ id: b, content: null, source_table: 'fragment' }]), null);
        assert.ok(!librarian.formatForContext([{ id: b, content: null, source_table: 'fragment' }, { id: a, content: '秘密內容甲', source_table: 'fragment' }]).includes('null'));
        rawPrepare('DELETE FROM memory_fragments WHERE id IN (?, ?)').run(a, b);
    });

    test('透明解密：pluck／raw／iterate／别名／运算式栏位', () => {
        const id = db.prepare(`INSERT INTO memories (title, content, tags) VALUES (?, ?, '[]')`)
            .run(mc.sealField('memories', 'title', '別名標題'), mc.sealField('memories', 'content', '別名內容')).lastInsertRowid;
        assert.equal(db.prepare('SELECT title FROM memories WHERE id = ?').pluck().get(id), '別名標題');
        assert.deepEqual(db.prepare('SELECT title, content FROM memories WHERE id = ?').raw().get(id), ['別名標題', '別名內容']);
        assert.deepEqual([...db.prepare('SELECT m.title AS x FROM memories m WHERE m.id = ?').iterate(id)], [{ x: '別名標題' }]);
        // 运算式栏位（来源不明）：依栏位名试同名 AAD
        assert.equal(db.prepare("SELECT COALESCE(title, '') AS title FROM memories WHERE id = ?").get(id).title, '別名標題');
        // 非记忆栏位的 enc: 值不动（例如 api key 的密文）
        const { encryption } = require('../../encryption');
        const k = encryption.encrypt('sk-test');
        assert.equal(db.prepare('SELECT ? AS api_key').get(k).api_key, k);
    });
});

describe('SQL 文字操作改走 mem_like／mem_len', () => {
    test('mem_like 语义同 SQLite LIKE（ASCII 不分大小写、% 与 _）', () => {
        assert.equal(mc.sqlLike('Hello 世界', '%hello%'), 1);
        assert.equal(mc.sqlLike('Hello 世界', '%世_'), 1);
        assert.equal(mc.sqlLike('Hello 世界', '%世'), 0);
        assert.equal(mc.sqlLike('ÄB', '%äb%'), 0);   // 非 ASCII 不折叠（与 SQLite 预设一致）
        assert.equal(mc.sqlLike('a.b', 'a_b'), 1);
        assert.equal(mc.sqlLike('a(b)', '%(b)%'), 1);
        assert.equal(mc.sqlLike(null, '%x%'), null);
        for (const [v, p] of [['Hello 世界', '%hello%'], ['abc', 'A_C'], ['a%b', 'a%'], ['xyz', '%q%']]) {
            assert.equal(mc.sqlLike(v, p), rawPrepare('SELECT ? LIKE ? AS r').get(v, p).r, `${v} LIKE ${p}`);
        }
    });

    test('密文栏位上 LIKE 找不到、mem_like 找得到；mem_len 算明文字数', () => {
        const id = db.prepare(`INSERT INTO memory_fragments (type, entity, content, source, status) VALUES ('fact','L',?,'chat','active')`)
            .run(mc.sealField('memory_fragments', 'content', '今天和阿明吃拉麵')).lastInsertRowid;
        assert.equal(rawPrepare("SELECT COUNT(*) c FROM memory_fragments WHERE id = ? AND content LIKE '%阿明%'").get(id).c, 0);
        assert.equal(db.prepare("SELECT COUNT(*) c FROM memory_fragments WHERE id = ? AND mem_like('memory_fragments:content', content, '%阿明%')").get(id).c, 1);
        assert.equal(db.prepare("SELECT mem_len('memory_fragments:content', content) n FROM memory_fragments WHERE id = ?").get(id).n, 8);
        rawPrepare('DELETE FROM memory_fragments WHERE id = ?').run(id);
    });
});

describe('W5 去重在加密模式下', () => {
    const rows = (ent) => db.prepare('SELECT * FROM memory_fragments WHERE entity = ? ORDER BY id').all(ent);
    test('跨天重复 → 证据累加，不新增', async () => {
        const ent = 'W3跨天';
        const e = () => entry({ entities: [{ name: ent }], content: `${ent}對花生過敏`, quote: '我對花生過敏' });
        await runScribe([e()], [msg('user', '我對花生過敏', '2026-05-01 10:00:00')]);
        const r = await runScribe([entry({ entities: [{ name: ent }], content: `${ent} 對花生過敏。`, quote: '對花生過敏' })],
            [msg('user', '我對花生過敏喔', '2026-05-03 09:00:00')]);
        assert.equal(r.written, 0);
        assert.equal(r.evidenceMerged, 1);
        const f = rows(ent);
        assert.equal(f.length, 1);
        assert.equal(f[0].evidence_count, 2);
        assert.match(rawPrepare('SELECT content FROM memory_fragments WHERE id = ?').get(f[0].id).content, /^enc:v2:/);
    });
    for (const [name, a, b] of [['週三/週五', '每週三打羽球', '每週五打羽球'], ['貓/狗', '小橘是一隻貓', '小橘是一隻狗'], ['數字', '我每天跑5公里', '我每天跑8公里']]) {
        test(`誘餌不合併：${name}`, async () => {
            const ent = `W3誘餌${name}`;
            await runScribe([entry({ entities: [{ name: ent }], content: `${ent}：${a}`, quote: a })], [msg('user', a, '2026-07-01 10:00:00')]);
            const r = await runScribe([entry({ entities: [{ name: ent }], content: `${ent}：${b}`, quote: b })], [msg('user', b, '2026-07-02 10:00:00')]);
            assert.equal(r.written, 1);
            assert.equal(rows(ent).length, 2);
        });
    }
});

describe('迁移（子程序）', () => {
    test('off 写明文 → 切 on 启动：全部加密、索引可查、笔数不变、档案无明文', () => {
        const p = tmpDb('mig');
        try {
            const off = child('seed', { DB_PATH: p, MEMORY_ENCRYPTION: 'off' }, { extra: 2000 });
            assert.ok(allRaw(off.raw).every(v => !v.startsWith('enc:')));
            const on = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' }, { grep: [...WORDS, '葡萄柚', '奶奶家', '海邊小屋'] });
            assert.ok(on.v107);
            assert.ok(allRaw(on.raw).every(v => v.startsWith('enc:v2:')), '仍有明文');
            assert.deepEqual(on.counts, off.counts);
            assert.equal(on.counts.mfFts, on.counts.mf);
            assert.deepEqual(on.top, off.top, '迁移后检索结果应与明文时相同');
            assert.match(on.fingerprint, /^blind:/);
            assert.deepEqual(on.plaintextFound, [], '档案仍有明文：' + on.plaintextFound.join(','));
            // 再开一次是 no-op（密文不变）
            const again = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' }, { noSearch: true });
            assert.deepEqual(again.raw, on.raw);
            // 切回 off：资料维持密文（读取端照样解密），索引改回明文两字组、检索一样
            const back = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'off' }, {});
            assert.equal(back.fingerprint, 'plain');
            assert.deepEqual(back.top, off.top);
            assert.deepEqual(back.raw, on.raw);
        } finally { cleanupDb(p); }
    });

    test('迁移中途加密失败 → 整批回滚：没有半加密、索引与触发器不变', () => {
        const p = tmpDb('migfail');
        try {
            const off = child('seed', { DB_PATH: p, MEMORY_ENCRYPTION: 'off' });
            const failed = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' }, { failEncryptAfter: 3, noSearch: true });
            assert.deepEqual(failed.raw, off.raw, '应完全回滚');
            assert.equal(failed.fingerprint, 'plain');
            assert.equal(failed.triggers.length, 6);
            // 下次正常启动就会完成
            const ok = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' }, {});
            assert.ok(allRaw(ok.raw).every(v => v.startsWith('enc:v2:')));
            assert.deepEqual(ok.top, off.top);
        } finally { cleanupDb(p); }
    });

    test('v107 本身失败 → 不记版本、资料维持明文', () => {
        const p = tmpDb('v107fail');
        try {
            child('seed', { DB_PATH: p, MEMORY_ENCRYPTION: 'off' });
            // 伪造「还没跑过 v107」的旧库
            const Database = require('better-sqlite3');
            const d = new Database(p);
            d.prepare('DELETE FROM schema_version WHERE version = 107').run();
            d.close();
            const failed = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' }, { failEncryptAfter: 2, noSearch: true });
            assert.equal(failed.v107, false);
            assert.ok(allRaw(failed.raw).every(v => !v.startsWith('enc:')));
            const ok = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' }, { noSearch: true });
            assert.equal(ok.v107, true);
            assert.ok(allRaw(ok.raw).every(v => v.startsWith('enc:v2:')));
        } finally { cleanupDb(p); }
    });

    test('旧版无 AAD 的 memories.content 密文 → 读得到，迁移后改成带 AAD', () => {
        const p = tmpDb('legacy');
        try {
            child('seed', { DB_PATH: p, MEMORY_ENCRYPTION: 'off' });
            const { encryption } = require('../../encryption');
            const legacy = encryption.encrypt('舊版加密的敘事');   // routes/memory-api.js 上线前的写法：无 AAD
            const Database = require('better-sqlite3');
            const d = new Database(p);
            d.prepare('UPDATE memories SET content = ? WHERE id = 1').run(legacy);
            d.close();
            const on = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' }, { noSearch: true });
            const v = on.raw['memories.content'][0].v;
            assert.notEqual(v, legacy);
            assert.equal(encryption.decrypt(v, { aad: 'memories:content', silent: true }), '舊版加密的敘事');
        } finally { cleanupDb(p); }
    });
});

describe('金钥核对（子程序）', () => {
    test('金钥设错 → 拒绝启动，资料不被改动；换回正确金钥照常', () => {
        const p = tmpDb('wrongkey');
        try {
            const seeded = child('seed', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' });
            let err = null;
            try {
                child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on', SANCTUARY_ENCRYPTION_KEY: 'ab'.repeat(32) }, {});
            } catch (e) { err = e; }
            assert.ok(err, '金钥错误时应拒绝启动');
            assert.match(String(err.stdout || err.message), /MemoryKeyMismatchError|金钥与资料库不符/);
            const ok = child('open', { DB_PATH: p, MEMORY_ENCRYPTION: 'on' }, {});
            assert.deepEqual(ok.raw, seeded.raw);
            assert.deepEqual(ok.top, seeded.top);
        } finally { cleanupDb(p); }
    });
});

describe('金钥轮替脚本（子程序）', () => {
    const K1 = TEST_KEY;
    const K2 = 'fedcba9876543210'.repeat(4);
    test('--dry-run 不改资料；正式执行后全部换成新 kid、旧金钥仍可读、新写入用新 kid', () => {
        const p = tmpDb('rotate');
        try {
            const base = { DB_PATH: p, MEMORY_ENCRYPTION: 'on' };
            const seeded = child('seed', { ...base, SANCTUARY_ENCRYPTION_KEY: K1, SANCTUARY_ENCRYPTION_KEY_ID: 'k1' });
            assert.ok(allRaw(seeded.raw).every(v => v.startsWith('enc:v2:k1:')));
            const oldCipher = seeded.raw['memory_fragments.content'][0];
            const rotEnv = { ...process.env, ...base, SANCTUARY_ENCRYPTION_KEY: K2, SANCTUARY_ENCRYPTION_KEY_ID: 'k2', SANCTUARY_ENCRYPTION_KEYS_OLD: `k1=${K1}` };
            const script = path.join(ROOT, 'scripts', 'rotate_memory_keys.js');

            const dry = execFileSync(process.execPath, [script, '--dry-run'], { cwd: ROOT, env: rotEnv, encoding: 'utf8' });
            assert.match(dry, /预演完成，资料未变动/);
            const afterDry = child('open', { ...base, SANCTUARY_ENCRYPTION_KEY: K1, SANCTUARY_ENCRYPTION_KEY_ID: 'k1', MEMORY_CRYPTO_SKIP_AUTOSYNC: '1' }, { noSearch: true });
            assert.deepEqual(afterDry.raw, seeded.raw, 'dry-run 改到了资料');

            const real = execFileSync(process.execPath, [script], { cwd: ROOT, env: rotEnv, encoding: 'utf8' });
            assert.match(real, /轮替完成/);

            // 新金钥 + 旧金钥：全部是 k2、检索正常、新写入 k2、旧 k1 密文仍读得到
            const k2 = child('open', { ...base, SANCTUARY_ENCRYPTION_KEY: K2, SANCTUARY_ENCRYPTION_KEY_ID: 'k2', SANCTUARY_ENCRYPTION_KEYS_OLD: `k1=${K1}` },
                { write: '輪替後新寫入', putRaw: { id: oldCipher.id, value: oldCipher.v } });
            const others = allRaw(k2.raw).filter(v => v !== oldCipher.v);
            assert.ok(others.every(v => v.startsWith('enc:v2:k2:')), '还有旧 kid 的密文');
            assert.deepEqual(k2.top, seeded.top, '轮替后检索结果应不变');
            assert.match(k2.written, /^enc:v2:k2:/);
            assert.equal(k2.putRead, '使用者住在新北三重');
            // 拿掉旧金钥：新资料照读，旧 k1 密文读不到（null，不是 enc: 字串）
            const only2 = child('open', { ...base, SANCTUARY_ENCRYPTION_KEY: K2, SANCTUARY_ENCRYPTION_KEY_ID: 'k2', SANCTUARY_ENCRYPTION_KEYS_OLD: '' },
                { noSearch: true, readBack: true });
            const r1 = only2.read.find(r => r.id === oldCipher.id);
            assert.equal(r1.content, null);
            assert.ok(only2.read.filter(r => r.id !== oldCipher.id).every(r => typeof r.content === 'string' && !r.content.startsWith('enc:')));
        } finally { cleanupDb(p); }
    });
});
