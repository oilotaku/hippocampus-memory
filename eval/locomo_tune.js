// eval/locomo_tune.js — 檢索排序調參：對一組 librarian.* 候選值各跑一次檢索評測，彙整命中率與 MRR
// 用法（Windows）：node eval/locomo_tune.js <grid.json>
//   grid.json：{ "variants": ["A","C"], "configs": [ { "name": "b0_w0", "cfg": { "entity_boost": 0, "decay_weight": 0 } }, ... ] }
//   環境變數：LOCOMO_DATA（資料集）、TUNE_OUT（輸出目錄，預設 eval/results/tune）；已有 raw 結果的組合會略過（加 --force 重跑）
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const grid = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUT = path.resolve(process.env.TUNE_OUT || path.join(__dirname, 'results', 'tune'));
const force = process.argv.includes('--force');
const KS = [5, 10, 20];
const rows = [];
for (const c of grid.configs) {
    const raw = path.join(OUT, c.name, 'raw');
    const args = [path.join(__dirname, 'locomo_retrieval.js'), '--variants', grid.variants.join(',')];
    if (force) args.push('--force');
    const t0 = Date.now();
    const r = spawnSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, LOCOMO_OUT: raw, LIBRARIAN_OVERRIDE: JSON.stringify(c.cfg) } });
    if (r.status !== 0) { console.error('失敗', c.name); process.exit(1); }
    for (const v of grid.variants) {
        const recs = fs.readdirSync(raw).filter(f => f.startsWith(`retr_${v}_`))
            .flatMap(f => JSON.parse(fs.readFileSync(path.join(raw, f))).results).filter(x => x.nev > 0);
        const o = { config: c.name, cfg: c.cfg, variant: v, n: recs.length };
        for (const k of KS) o['hit@' + k] = recs.filter(x => x.hit[k]).length / recs.length;
        o.mrr = recs.reduce((s, x) => s + x.rr, 0) / recs.length;
        rows.push(o);
        console.log(`${c.name}\t${v}\t${KS.map(k => (100 * o['hit@' + k]).toFixed(1)).join('\t')}\t${o.mrr.toFixed(3)}\t(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'tune_summary.json'), JSON.stringify(rows, null, 1));
let md = '| 設定 | 變體 | 命中@5 | 命中@10 | 命中@20 | MRR |\n|---|---|---|---|---|---|\n';
for (const o of rows) md += `| ${o.config} | ${o.variant} | ${KS.map(k => (100 * o['hit@' + k]).toFixed(1)).join(' | ')} | ${o.mrr.toFixed(3)} |\n`;
fs.writeFileSync(path.join(OUT, 'tune_summary.md'), md);
console.log(md);
