// eval/locomo_retrieval.js — LoCoMo 第一階段：檢索評測（不經 LLM 抽取）
// 用法（Windows）：
//   node eval/locomo_retrieval.js                  # 跑所有變體 × 10 組（每個變體/對話一個子行程）
//   node eval/locomo_retrieval.js --variants A,B   # 只跑指定變體
//   node eval/locomo_retrieval.js --child <變體> <對話索引>   # 內部使用
// 變體：
//   A  產品預設（MEMORY_ENCRYPTION=on，無向量通道）
//   B  MEMORY_ENCRYPTION=off
//   C  A ＋ bge-m3 向量通道（替身取代 searchMemoriesByVector，記憶體內暴力餘弦）
//   D  純 FTS/BM25（product 的 searchFragments）
//   E  純向量（bge-m3 餘弦，無融合）
//   後綴旗標：-S 整組時間軸平移到「現在」（最後一個 session＝昨天；檢視時間衰減／分數底線的影響）
//            -F 全部碎片都是「剛寫入」（created_at 在最近幾分鐘內，沒有時間衰減；檢視排序邏輯本身的上限）
//            -N 不建立實體與連結（檢視實體通道的影響）；可組合，如 A-SN、B-SN、C-SN
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT = path.join(__dirname, 'results', 'raw');
const KS = [5, 10, 20];
const VARIANTS = ['A', 'B', 'C', 'D', 'E', 'A-S', 'A-N', 'A-SN', 'B-SN', 'C-S', 'C-N', 'C-SN', 'A-F', 'A-FN', 'B-FN', 'C-F', 'C-FN'];

function runChild(variant, idx) {
    const [base, flags = ''] = variant.split('-');
    const cfg = {
        encryption: base === 'B' ? 'off' : 'on',
        vector: /^(C|E)/.test(base),
        shift: flags.includes('S'),
        fresh: flags.includes('F'),
        noEntity: flags.includes('N'),
        ftsOnly: base === 'D',
        denseOnly: base === 'E',
    };
    process.env.MEMORY_ENCRYPTION = cfg.encryption;
    process.env.SANCTUARY_ENCRYPTION_KEY = '0'.repeat(64);
    process.env.DB_PATH = path.join(os.tmpdir(), `locomo-retr-${variant}-${idx}-${process.pid}.db`);
    const { loadConversations, shiftTimes } = require('./locomo_common');
    const conv = loadConversations()[idx];
    if (cfg.shift) shiftTimes(conv.turns);
    if (cfg.fresh) {   // 全部碎片都是「剛寫入」：created_at 落在最近幾分鐘內（保留順序）
        const now = Date.now(); const n = conv.turns.length;
        conv.turns.forEach((t, i) => { t.time_shifted = new Date(now - (n - i) * 1000).toISOString().slice(0, 19).replace('T', ' '); });
    }

    const origLog = console.log; console.log = () => {}; console.error = () => {};
    const { initDatabase, getDb } = require('../database');
    initDatabase();
    const db = getDb();
    const memoryCrypto = require('../services/memoryCrypto');
    const { sealField } = memoryCrypto;

    // 寫入：與產品相同的 INSERT（content/quote 經 sealField；FTS 觸發器自動建索引）
    const ins = db.prepare(`INSERT INTO memory_fragments
        (type, entity, content, emotional_weight, source, source_date, source_msg_ids, created_at, content_hash, quote)
        VALUES ('observation', ?, ?, 0.5, 'chat', ?, ?, ?, ?, ?)`);
    const t0 = Date.now();
    const idToDia = new Map();
    const frags = [];
    db.exec('BEGIN');
    for (const t of conv.turns) {
        const ts = (cfg.shift || cfg.fresh) ? t.time_shifted : t.time;
        const info = ins.run(t.speaker, sealField('memory_fragments', 'content', t.content), ts.slice(0, 10),
            JSON.stringify([t.dia_id]), ts, `locomo-${t.dia_id}`, sealField('memory_fragments', 'quote', t.text));
        idToDia.set(Number(info.lastInsertRowid), t.dia_id);
        frags.push(Number(info.lastInsertRowid));
    }
    db.exec('COMMIT');
    const insertMs = Date.now() - t0;

    // 實體與連結
    if (!cfg.noEntity) {
        const insEnt = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases) VALUES (?, 'person', 'active', '[]')`);
        const insLink = db.prepare(`INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, 'related_to', 0.7, 'locomo_eval')`);
        const entIds = {};
        for (const n of [conv.speaker_a, conv.speaker_b]) entIds[n] = Number(insEnt.run(n).lastInsertRowid);
        db.exec('BEGIN');
        conv.turns.forEach((t, i) => insLink.run(frags[i], entIds[t.speaker]));
        db.exec('COMMIT');
    }

    // 向量替身
    let qVec = null, tVec = null;
    const dec = (b64) => { const b = Buffer.from(b64, 'base64'); const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
        let n = 0; for (const x of f) n += x * x; n = Math.sqrt(n) || 1; return f.map(x => x / n); };
    if (cfg.vector) {
        const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', `emb_${conv.id}.json`), 'utf8'));
        tVec = cache.turns.map(dec); qVec = cache.qa.map(dec);
    }
    let curQ = -1;
    const simsFor = (qi) => tVec.map(v => { let s = 0; const q = qVec[qi]; for (let i = 0; i < v.length; i++) s += v[i] * q[i]; return s; });
    if (cfg.vector && !cfg.denseOnly) {
        const mem = require('../services/memory');
        mem.searchMemoriesByVector = async (query, n) => {
            const sims = simsFor(curQ);
            const order = sims.map((s, i) => [s, i]).filter(x => x[0] >= 0.20).sort((a, b) => b[0] - a[0]).slice(0, n);
            if (!order.length) return [];
            const ids = order.map(x => frags[x[1]]);
            const rows = db.prepare(`SELECT * FROM memory_fragments WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'active'`).all(...ids);
            const byId = new Map(rows.map(r => [r.id, r]));
            return order.map(([s, i]) => ({ _table: 'fragments', _similarity: s, ...byId.get(frags[i]) })).filter(x => x.id);
        };
    }
    const lib = require('../services/librarian');

    const results = [];
    const tQ = Date.now();
    (async () => {
        for (const q of conv.qa) {
            curQ = q.qi;
            const rec = { qi: q.qi, cat: q.category, nev: q.evidence.length, hit: {}, all: {}, nret: {}, rr: 0 };
            const evSet = new Set(q.evidence);
            for (const k of KS) {
                let dias;
                if (cfg.denseOnly) {
                    const sims = simsFor(q.qi);
                    dias = sims.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, k).map(x => conv.turns[x[1]].dia_id);
                } else if (cfg.ftsOnly) {
                    dias = lib.searchFragments(q.question, k).map(r => idToDia.get(r.id)).filter(Boolean);
                } else {
                    const hits = await lib.searchHybrid(q.question, k, { surface: 'none' });
                    dias = hits.map(r => r.source_table === 'fragment' ? idToDia.get(r.id) : null).filter(Boolean);
                }
                rec.nret[k] = dias.length;
                if (q.evidence.length) {
                    rec.hit[k] = dias.some(d => evSet.has(d)) ? 1 : 0;
                    rec.all[k] = q.evidence.every(e => dias.includes(e)) ? 1 : 0;
                    if (k === Math.max(...KS)) { const r = dias.findIndex(d => evSet.has(d)); rec.rr = r >= 0 ? 1 / (r + 1) : 0; }
                }
            }
            results.push(rec);
        }
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, `retr_${variant}_${conv.id}.json`),
            JSON.stringify({ variant, conv: conv.id, turns: conv.turns.length, insertMs, queryMs: Date.now() - tQ, results }));
        try { db.close(); } catch (_) {}
        for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(process.env.DB_PATH + s); } catch (_) {}
        origLog(`OK ${variant} ${conv.id} turns=${conv.turns.length} insert=${insertMs}ms query=${Date.now() - tQ}ms`);
        process.exit(0);
    })().catch(e => { origLog('FAIL', variant, idx, e.stack); process.exit(1); });
}

function main() {
    const a = process.argv.slice(2);
    if (a[0] === '--child') return runChild(a[1], parseInt(a[2], 10));
    const vi = a.indexOf('--variants');
    const variants = vi >= 0 ? a[vi + 1].split(',') : VARIANTS;
    for (const v of variants) for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(OUT, `retr_${v}_${require('./locomo_common').loadConversations()[i].id}.json`)) && !a.includes('--force')) continue;
        const r = spawnSync(process.execPath, [__filename, '--child', v, String(i)], { stdio: 'inherit', env: process.env });
        if (r.status !== 0) { console.error('子行程失敗', v, i); process.exit(1); }
    }
    console.log('ALL DONE');
}
main();
