// eval/locomo_aggregate.js — 彙整第一階段 raw 結果 → retrieval_summary.{md,json}
const fs = require('fs');
const path = require('path');
const RAW = process.env.LOCOMO_OUT ? path.resolve(process.env.LOCOMO_OUT) : path.join(__dirname, 'results', 'raw');
const SUMDIR = process.env.LOCOMO_SUMMARY_DIR ? path.resolve(process.env.LOCOMO_SUMMARY_DIR) : path.join(__dirname, 'results');
const KS = [5, 10, 20];
const CATN = { 1: '多跳', 2: '時間', 3: '開放推理', 4: '單跳', 5: '對抗/無解' };
const DESC = { A: '產品預設（加密 on、無向量；真實 2023 日期）', B: '加密 off', C: 'A ＋ bge-m3 向量通道', D: '純 FTS/BM25（searchFragments）',
    E: '純向量（bge-m3 餘弦）', 'A-S': 'A，時間軸平移到現在', 'A-N': 'A，無實體連結', 'A-SN': 'A，平移時間＋無實體連結', 'B-SN': 'B，平移時間＋無實體連結（加密 off）',
    'A-F': 'A，全部剛寫入（無衰減）', 'A-FN': 'A，全部剛寫入＋無實體連結', 'B-FN': 'B，全部剛寫入＋無實體連結（加密 off）', 'C-F': 'C，全部剛寫入', 'C-FN': 'C，全部剛寫入＋無實體連結',
    'C-S': 'C，平移時間', 'C-N': 'C，無實體連結', 'C-SN': 'C，平移時間＋無實體連結' };
const files = fs.readdirSync(RAW).filter(f => f.startsWith('retr_'));
const by = {};
for (const f of files) { const j = JSON.parse(fs.readFileSync(path.join(RAW, f))); (by[j.variant] ||= []).push(j); }
const variants = Object.keys(DESC).filter(v => by[v]);
const pct = (x) => (100 * x).toFixed(1);
function agg(recs) {
    const withEv = recs.filter(r => r.nev > 0);
    const o = { n: recs.length, n_ev: withEv.length };
    for (const k of KS) {
        o['hit@' + k] = withEv.length ? withEv.filter(r => r.hit[k]).length / withEv.length : null;
        o['all@' + k] = withEv.length ? withEv.filter(r => r.all[k]).length / withEv.length : null;
        o['nret@' + k] = recs.length ? recs.reduce((s, r) => s + r.nret[k], 0) / recs.length : null;
    }
    o.mrr = withEv.length ? withEv.reduce((s, r) => s + r.rr, 0) / withEv.length : null;
    return o;
}
const summary = {};
let md = '# LoCoMo 檢索評測（第一階段）\n\n' +
    '每個輪次寫成一條記憶碎片（`說話者: 文字`，圖片說明附在句尾），兩位說話者建為實體並連結所有其碎片；對每題呼叫產品 `searchHybrid(question, k, {surface:"none"})`（k=5/10/20 各跑一次；`surface:none` 關閉隨機浮現）。' +
    '命中＝前 k 名含至少一個證據 dia_id；全中＝所有證據 dia_id 都在前 k 名；MRR 取 k=20 的第一個命中名次。單位：%。\n\n';
for (const v of variants) {
    const recs = by[v].flatMap(j => j.results);
    summary[v] = { desc: DESC[v], convs: by[v].length, all: agg(recs), byCat: {} };
    for (const c of [1, 2, 3, 4, 5]) summary[v].byCat[c] = agg(recs.filter(r => r.cat === c));
}
// 總表（不含 cat 5，因其多半無證據或為對抗題；有證據者另列）
md += '## 總覽（全部題目中有證據者）\n\n| 變體 | 說明 | 命中@5 | 命中@10 | 命中@20 | 全中@5 | 全中@10 | 全中@20 | MRR | 平均回傳數@10 |\n|---|---|---|---|---|---|---|---|---|---|\n';
for (const v of variants) { const a = summary[v].all;
    md += `| ${v} | ${DESC[v]} | ${KS.map(k => pct(a['hit@' + k])).join(' | ')} | ${KS.map(k => pct(a['all@' + k])).join(' | ')} | ${a.mrr.toFixed(3)} | ${a['nret@10'].toFixed(1)} |\n`; }
md += '\n## 依 category 分開（命中@5 / @10 / @20；MRR）\n\n';
for (const c of [1, 2, 3, 4, 5]) {
    const n = summary[variants[0]].byCat[c];
    md += `### category ${c}：${CATN[c]}（${n.n} 題，其中有證據 ${n.n_ev}）\n\n| 變體 | 命中@5 | 命中@10 | 命中@20 | 全中@5 | 全中@10 | 全中@20 | MRR |\n|---|---|---|---|---|---|---|---|\n`;
    for (const v of variants) { const a = summary[v].byCat[c]; if (!a.n_ev) continue;
        md += `| ${v} | ${KS.map(k => pct(a['hit@' + k])).join(' | ')} | ${KS.map(k => pct(a['all@' + k])).join(' | ')} | ${a.mrr.toFixed(3)} |\n`; }
    md += '\n';
}
fs.writeFileSync(path.join(SUMDIR, 'retrieval_summary.json'), JSON.stringify(summary, null, 1));
const notes = path.join(__dirname, 'retrieval_notes.md');
if (fs.existsSync(notes)) md += fs.readFileSync(notes, 'utf8');
fs.writeFileSync(path.join(SUMDIR, 'retrieval_summary.md'), md);
console.log(md);
