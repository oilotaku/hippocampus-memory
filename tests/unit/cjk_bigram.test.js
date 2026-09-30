const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `mc-cjk-bigram-${process.pid}-${Date.now()}.db`);
process.env.SANCTUARY_ENCRYPTION_KEY = '0'.repeat(64);
// 本檔直接檢查明文兩字組索引的格式（MATCH '"動畫"'），所以固定在 off 模式；
// on 模式（盲索引）的同組檢索斷言在 memory_encryption.test.js。
process.env.MEMORY_ENCRYPTION = 'off';

const { toIndexTokens, toQueryTokens, toMatchQuery } = require('../../utils/cjkTokenize');

test('toIndexTokens: 中文切成重疊兩字組', () => {
    assert.deepStrictEqual(toIndexTokens('動畫片').trim().split(/\s+/), ['動畫', '畫片']);
});

test('toIndexTokens: 單字串保留單字，非 CJK 轉小寫', () => {
    assert.deepStrictEqual(toIndexTokens('我 iPhone 15').trim().split(/\s+/), ['我', 'iphone', '15']);
});

test('toIndexTokens: 中英混合邊界有空白隔開', () => {
    assert.deepStrictEqual(toIndexTokens('用Claude寫程式').trim().split(/\s+/), ['用', 'claude', '寫程', '程式']);
});

test('toIndexTokens: 空值', () => {
    assert.strictEqual(toIndexTokens(''), '');
    assert.strictEqual(toIndexTokens(null), '');
    assert.strictEqual(toIndexTokens(undefined), '');
});

test('toMatchQuery: 兩字組 OR 並加引號', () => {
    assert.strictEqual(toMatchQuery('媽媽生日'), '"媽媽" OR "媽生" OR "生日"');
});

test('toMatchQuery: 空字串或全標點回傳 null', () => {
    assert.strictEqual(toMatchQuery(''), null);
    assert.strictEqual(toMatchQuery('   '), null);
    assert.strictEqual(toMatchQuery('，。！？…()"*:-'), null);
    assert.strictEqual(toMatchQuery(null), null);
});

test('toMatchQuery: FTS5 保留字與特殊符號不會拋錯', () => {
    const { initDatabase } = require('../../database');
    const db = initDatabase();
    const nasty = ['OR', 'AND', 'NOT', 'NEAR', 'NEAR/2', 'foo AND bar', '"unbalanced', '(a OR b', 'a*', 'col:val',
        '-neg', '^x', 'x"y"z', "it's", '媽媽 OR 生日', '{a}', 'NOT 動畫', '\\', ';DROP TABLE x'];
    for (const q of nasty) {
        const m = toMatchQuery(q);
        if (m === null) continue;
        assert.doesNotThrow(() => db.prepare('SELECT rowid FROM memory_fragments_fts WHERE memory_fragments_fts MATCH ?').all(m), q);
        assert.doesNotThrow(() => db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').all(m), q);
    }
});

test('toQueryTokens: 停用字整個 token 都是停用字才丟', () => {
    const stop = new Set(['我', '在', '哪']);
    assert.deepStrictEqual(toQueryTokens('我在哪上班', { stopChars: stop }), ['哪上', '上班']);
});

// ── 端到端：走 librarian 的實際 FTS 檢索路徑 ──
const { initDatabase, getDb } = require('../../database');
const librarian = require('../../services/librarian');

function seed(db, texts) {
    const ins = db.prepare(`INSERT INTO memory_fragments
        (type, entity, content, emotional_weight, source, source_date, status, created_at)
        VALUES ('fact', '', ?, 0.5, 'chat', '2026-01-01', 'active', datetime('now'))`);
    for (const t of texts) ins.run(t);
}

const CORPUS = [
    '使用者住在新北三重',
    '媽媽下週三生日',
    '喜歡看動畫不喜歡恐怖片',
    '使用者在臺積電上班',
    '動物園很好玩',
    '畫畫是興趣',
    '週末喜歡看電影，尤其是恐怖電影',
    '重要的事情要記得',
];

test('librarian FTS 通道：兩字詞第一名正確、無單字幹擾', () => {
    initDatabase();
    const db = getDb();
    seed(db, CORPUS);

    const top = (q) => librarian.searchFragments(q, 8).map(r => r.content);

    let r = top('動畫');
    assert.strictEqual(r[0], '喜歡看動畫不喜歡恐怖片');
    assert.ok(!r.includes('動物園很好玩') && !r.includes('畫畫是興趣'), '不應命中單字幹擾句: ' + r);

    r = top('三重');
    assert.strictEqual(r[0], '使用者住在新北三重');
    assert.ok(!r.includes('重要的事情要記得'));

    r = top('媽媽生日');
    assert.strictEqual(r[0], '媽媽下週三生日');

    r = top('恐怖電影');
    assert.strictEqual(r[0], '週末喜歡看電影，尤其是恐怖電影');

    r = top('我在哪上班');
    assert.strictEqual(r[0], '使用者在臺積電上班');

    assert.deepStrictEqual(top(''), []);
    assert.deepStrictEqual(top('，。！'), []);
    assert.doesNotThrow(() => top('NEAR( OR "a'));
});

test('更新與刪除後索引同步（無幽靈 posting）', () => {
    const db = getDb();
    const id = db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_date, status, created_at)
        VALUES ('fact', '', '養了一隻柴犬', 0.5, 'chat', '2026-01-01', 'active', datetime('now'))`).run().lastInsertRowid;
    assert.strictEqual(librarian.searchFragments('柴犬')[0].id, id);
    db.prepare('UPDATE memory_fragments SET content = ? WHERE id = ?').run('養了一隻貓咪', id);
    assert.strictEqual(librarian.searchFragments('柴犬').length, 0);
    assert.strictEqual(librarian.searchFragments('貓咪')[0].id, id);
    db.prepare('DELETE FROM memory_fragments WHERE id = ?').run(id);
    assert.strictEqual(librarian.searchFragments('貓咪').length, 0);
});

test('memories_fts 也走兩字組（episode 通道）', () => {
    const db = getDb();
    db.prepare(`INSERT INTO memories (title, content, tags, layer, status, weight, content_hash, created_at)
        VALUES ('喜歡看動畫', '使用者喜歡看動畫', '["動畫","興趣"]', 'episode', 'permanent', 5, 'h1', datetime('now'))`).run();
    const r = librarian.searchFragments('動畫');
    assert.ok(r.some(x => x.source_table === 'memory' && x.content === '喜歡看動畫'));
});

test('migration v104：舊單字索引會被重建成兩字組', () => {
    const db = getDb();
    const oldSplit = t => (t || '').replace(/[一-鿿㐀-䶿豈-﫿]/g, ' $& ');
    // 還原成舊格式索引 + 拿掉版本紀錄
    db.exec(`INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES ('delete-all')`);
    const rows = db.prepare('SELECT id, content, COALESCE(entity, \'\') e FROM memory_fragments').all();
    const ins = db.prepare('INSERT INTO memory_fragments_fts(rowid, content, entity) VALUES (?, ?, ?)');
    for (const r of rows) ins.run(r.id, oldSplit(r.content), oldSplit(r.e));
    db.exec('DELETE FROM memories_fts');
    for (const m of db.prepare('SELECT id, title FROM memories').all()) {
        db.prepare('INSERT INTO memories_fts(rowid, title, tags_text) VALUES (?, ?, ?)').run(m.id, oldSplit(m.title), '');
    }
    db.prepare('DELETE FROM schema_version WHERE version = 104').run();
    // 舊索引下「動畫」會命中單字幹擾句
    const oldHit = db.prepare(`SELECT rowid FROM memory_fragments_fts WHERE memory_fragments_fts MATCH '"動" OR "畫"'`).all();
    assert.ok(oldHit.length >= 3);

    // 重新載入 database.js 跑 migration
    for (const k of Object.keys(require.cache)) {
        if (/[\\/](database|services[\\/]librarian)\.js$/.test(k)) delete require.cache[k];
    }
    const fresh = require('../../database').initDatabase();
    assert.ok(fresh.prepare('SELECT 1 FROM schema_version WHERE version = 104').get());
    const bigramHit = fresh.prepare(`SELECT rowid FROM memory_fragments_fts WHERE memory_fragments_fts MATCH '"動畫"'`).all();
    assert.strictEqual(bigramHit.length, 1);
    const singleHit = fresh.prepare(`SELECT rowid FROM memory_fragments_fts WHERE memory_fragments_fts MATCH '"動"'`).all();
    assert.strictEqual(singleHit.length, 0);
    const docs = fresh.prepare('SELECT COUNT(*) c FROM memory_fragments_fts_docsize').get().c;
    assert.strictEqual(docs, fresh.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c);
    const memHit = fresh.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH '"動畫"'`).all();
    assert.strictEqual(memHit.length, 1);
    // 新庫第二次執行是 no-op
    assert.doesNotThrow(() => require('../../database').initDatabase());
});
