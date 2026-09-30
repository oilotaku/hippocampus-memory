'use strict';
// memory_encryption.test.js 的子程式：需要「不同環境變數／重新開庫」的情境（off→on 遷移、
// 遷移中途失敗、金鑰輪替後用新金鑰讀）放在獨立程式跑，避免模組單例（initDatabase、encryption）互相汙染。
// 用法：node tests/unit/_memenc_child.js <情境> [JSON 引數]；結果印成一行 @@RESULT@@<json>。
// 檔名以 _ 開頭且不含 .test.，node --test 不會把它當測試檔。
const fs = require('fs');

const scenario = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
// 產品碼的 console 輸出一律靜音，只留結果行
console.log = console.warn = console.error = console.info = () => {};

const CORPUS = [
    '使用者住在新北三重',
    '媽媽下週三生日',
    '喜歡看動漫不喜歡恐怖片',
    '使用者在臺積電上班',
    '動物園很好玩',
    '畫畫是興趣',
    '週末喜歡看電影，尤其是恐怖電影',
    '重要的事情要記得',
];
const QUERIES = ['動漫', '三重', '媽媽生日', '恐怖電影', '我在哪上班'];

function out(obj) { process.stdout.write('@@RESULT@@' + JSON.stringify(obj) + '\n'); }
const rawPrepare = (db, sql) => Object.getPrototypeOf(db).prepare.call(db, sql);

function rawValues(db) {
    const { FIELDS } = require('../../services/memoryCrypto');
    const o = {};
    for (const [t, cols] of Object.entries(FIELDS)) {
        for (const c of cols) {
            o[`${t}.${c}`] = rawPrepare(db, `SELECT id, ${c} AS v FROM ${t} ORDER BY id`).all();
        }
    }
    return o;
}

// 以「產品寫入點的方式」寫入一組資料：memory_fragments（content+quote）、memories（title+content）、
// entity_profiles（四個加密欄位），全部經 sealField（off 時就是明文）
function seedAll(db) {
    const { sealField } = require('../../services/memoryCrypto');
    const s = sealField;
    const insF = db.prepare(`INSERT INTO memory_fragments (type, entity, content, quote, emotional_weight, source, source_date, status, created_at, content_hash)
        VALUES ('fact', 'E', ?, ?, 0.5, 'chat', '2026-01-01', 'active', datetime('now'), ?)`);
    const { normalizedContentHash } = require('../../services/scribeQuality');
    for (const t of CORPUS) insF.run(s('memory_fragments', 'content', t), s('memory_fragments', 'quote', '原話：' + t), normalizedContentHash('E', t));
    db.prepare(`INSERT INTO memories (title, content, tags, layer, status, weight, created_at)
        VALUES (?, ?, '[]', 'episode', 'permanent', 5, datetime('now'))`).run(s('memories', 'title', '喜歡看動漫'), s('memories', 'content', '使用者從小就喜歡看動漫'));
    db.prepare(`INSERT INTO entity_profiles (name, category, facts, current_status, judgment, overview)
        VALUES ('E', 'person', ?, ?, ?, ?)`).run(s('entity_profiles', 'facts', '媽媽生日在三月'), s('entity_profiles', 'current_status', '最近在看恐怖電影'),
        s('entity_profiles', 'judgment', '對動漫很有熱情'), s('entity_profiles', 'overview', '住在新北三重的上班族'));
}

function topLists() {
    const librarian = require('../../services/librarian');
    const r = {};
    for (const q of QUERIES) r[q] = librarian.searchFragments(q, 8).map(x => `${x.source_table}:${x.content}`);
    return r;
}

function counts(db) {
    return {
        mf: rawPrepare(db, 'SELECT COUNT(*) c FROM memory_fragments').get().c,
        mem: rawPrepare(db, 'SELECT COUNT(*) c FROM memories').get().c,
        ep: rawPrepare(db, 'SELECT COUNT(*) c FROM entity_profiles').get().c,
        mfFts: rawPrepare(db, 'SELECT COUNT(*) c FROM memory_fragments_fts_docsize').get().c,
        memFts: rawPrepare(db, 'SELECT COUNT(*) c FROM memories_fts_docsize').get().c,
    };
}

function fileHas(path, words) {
    const found = [];
    for (const suffix of ['', '-wal']) {
        let buf;
        try { buf = fs.readFileSync(path + suffix); } catch (_) { continue; }
        for (const w of words) if (buf.indexOf(Buffer.from(w, 'utf8')) !== -1) found.push(`${w}@${suffix || 'db'}`);
    }
    return found;
}

(async () => {
    const { initDatabase } = require('../../database');
    switch (scenario) {
        // 在目前模式開庫、寫入語料，回傳檢索結果與原始值（給 on/off 排名比對、遷移前置用）
        case 'seed': {
            const db = initDatabase();
            seedAll(db);
            if (args.extra) {   // 大量資料：驗證遷移後空閒頁面／WAL 也不留明文
                const { sealField } = require('../../services/memoryCrypto');
                const ins = db.prepare(`INSERT INTO memory_fragments (type, entity, content, quote, source, status) VALUES ('fact','X',?,?,'chat','active')`);
                db.transaction(() => {
                    for (let i = 0; i < args.extra; i++) {
                        const t = `第${i}則：今天吃了葡萄柚，心情${'很好'.repeat(i % 7 + 1)}，想起${i % 3 ? '奶奶家' : '海邊小屋'}`;
                        ins.run(sealField('memory_fragments', 'content', t), sealField('memory_fragments', 'quote', t.slice(0, 20)));
                    }
                })();
            }
            out({ top: topLists(), raw: rawValues(db), counts: counts(db) });
            break;
        }
        // 只開庫（跑 migration／啟動同步），回傳狀態
        case 'open': {
            if (args.failEncryptAfter !== undefined) {
                // 模擬遷移中途加密失敗：第 N+1 次 encrypt 起拋 EncryptionError
                const enc = require('../../encryption');
                const orig = enc.encryption.encrypt.bind(enc.encryption);
                let n = 0;
                enc.encryption.encrypt = (...a) => { if (++n > args.failEncryptAfter) throw new enc.EncryptionError('模擬失敗'); return orig(...a); };
            }
            const db = initDatabase();
            const res = {
                v107: !!rawPrepare(db, 'SELECT 1 FROM schema_version WHERE version = 107').get(),
                raw: rawValues(db),
                counts: counts(db),
                triggers: rawPrepare(db, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all(),
                fingerprint: require('../../services/memoryCrypto').getMeta(db, 'fts_index_fingerprint'),
            };
            if (!args.noSearch) res.top = topLists();
            if (args.readBack) res.read = db.prepare('SELECT id, content, quote FROM memory_fragments ORDER BY id').all();
            if (args.write) {
                const { sealField } = require('../../services/memoryCrypto');
                const id = db.prepare(`INSERT INTO memory_fragments (type, entity, content, source, status) VALUES ('fact','E',?, 'chat','active')`)
                    .run(sealField('memory_fragments', 'content', args.write)).lastInsertRowid;
                res.written = rawPrepare(db, 'SELECT content FROM memory_fragments WHERE id = ?').get(id).content;
            }
            if (args.putRaw) {   // 把指定的原始密文寫回某列（驗證舊金鑰密文還讀得到）
                rawPrepare(db, 'UPDATE memory_fragments SET content = ? WHERE id = ?').run(args.putRaw.value, args.putRaw.id);
                res.putRead = db.prepare('SELECT content FROM memory_fragments WHERE id = ?').get(args.putRaw.id).content;
            }
            if (args.grep) {
                db.pragma('wal_checkpoint(TRUNCATE)');
                res.plaintextFound = fileHas(process.env.DB_PATH, args.grep);
            }
            out(res);
            break;
        }
        default:
            out({ error: 'unknown scenario ' + scenario });
    }
    process.exit(0);
})().catch(e => { out({ error: e.stack || String(e) }); process.exit(1); });
