// eval/locomo_e2e_report.js — 彙整第二階段結果 → eval/results/e2e_<id>.md / .json
// 用法：node eval/locomo_e2e_report.js <conv-id> <qa 執行名稱>[,<名稱>...]
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'results');
const id = process.argv[2];
const names = (process.argv[3] || 'run').split(',');
const CATN = { 1: '多跳', 2: '時間', 3: '開放推理', 4: '單跳', 5: '對抗/無解' };
const ext = JSON.parse(fs.readFileSync(path.join(OUT, `e2e_${id}_extract.json`)));
const pct = (x) => (100 * x).toFixed(1);
let md = `# LoCoMo 第二階段：${id} 完整流程\n\n`;
// 抽取
const b = ext.batches;
const sum = (k) => b.reduce((s, x) => s + (x[k] || 0), 0);
md += `## 抽取（Scribe，qwen3-8b-zh-8k，批次 ${b.length} 個 × 60 則）\n\n| 批次 | 範圍 | 耗時(分) | 模型提出 | 寫入 | 重複 | quote 驗證丟棄 | 助理閒聊丟棄 | 錯誤 |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const x of b) md += `| ${x.batch} | ${x.first}~${x.last} | ${(x.ms / 60000).toFixed(1)} | ${x.proposed} | ${x.written} | ${x.duplicates} | ${x.quoteDropped} | ${x.aiChitchatDropped} | ${x.error || ''} |\n`;
md += `| 合計 | | ${(ext.total_ms / 60000).toFixed(1)} | ${sum('proposed')} | ${sum('written')} | ${sum('duplicates')} | ${sum('quoteDropped')} | ${sum('aiChitchatDropped')} | |\n\n`;
const summary = { conv: id, extract: { batches: b.length, minutes: ext.total_ms / 60000, proposed: sum('proposed'), written: sum('written'), quoteDropped: sum('quoteDropped'), aiChitchatDropped: sum('aiChitchatDropped') }, runs: {} };
for (const name of names) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, `e2e_${id}_${name}.json`)));
    const R = j.results;
    const agg = (rs) => ({ n: rs.length, f1: rs.reduce((s, r) => s + r.f1, 0) / (rs.length || 1), judge: rs.filter(r => r.judge === 'CORRECT').length / (rs.length || 1) });
    summary.runs[name] = { options: j.options, all: agg(R), noCat5: agg(R.filter(r => r.cat !== 5)), byCat: {}, n_frags: j.n_frags, covered: j.covered.length, minutes: j.ms / 60000 };
    md += `## QA 執行「${name}」（選項：${(j.options || []).join(' ') || '預設'}；碎片 ${j.n_frags} 條；被抽成碎片的輪次 ${j.covered.length}；耗時 ${(j.ms / 60000).toFixed(0)} 分）\n\n| category | 題數 | token F1 | LLM 評審正確率 | 證據全被抽取 | 證據有被撈到（任一） | 未呼叫檢索(gate) |\n|---|---|---|---|---|---|---|\n`;
    for (const c of [1, 2, 3, 4, 5, 'all', 'no5']) {
        const rs = c === 'all' ? R : c === 'no5' ? R.filter(r => r.cat !== 5) : R.filter(r => r.cat === c);
        if (!rs.length) continue;
        const a = agg(rs); const withEv = rs.filter(r => r.ev_extracted !== null && r.ev_extracted !== undefined);
        const label = c === 'all' ? '全部' : c === 'no5' ? '不含 cat5' : `${c} ${CATN[c]}`;
        md += `| ${label} | ${rs.length} | ${pct(a.f1)} | ${pct(a.judge)} | ${withEv.length ? pct(withEv.filter(r => r.ev_extracted).length / withEv.length) : '-'} | ${withEv.length ? pct(withEv.filter(r => r.ev_retrieved_any).length / withEv.length) : '-'} | ${rs.filter(r => r.retrieve === false).length} |\n`;
        if (typeof c === 'number') summary.runs[name].byCat[c] = a;
    }
    // 錯誤原因自動分類（非 cat5、判定 WRONG）
    const wrong = R.filter(r => r.cat !== 5 && r.judge !== 'CORRECT');
    const cls = (r) => r.error ? '執行錯誤' : r.ev_extracted === null ? '無證據標註' : !r.ev_extracted_any ? '抽取漏掉（證據輪次沒有任何碎片）' : !r.ev_extracted ? '抽取不完整（多證據部分漏）' : r.retrieve === false ? '閘門判定不檢索' : !r.ev_retrieved_any ? '檢索沒撈到' : REFUSAL_RE.test(r.answer || '') ? '有撈到但模型拒答' : '有撈到但答錯（生成／評審）';
    const REFUSAL_RE = /not mentioned/i;
    const dist = {}; wrong.forEach(r => { const k = cls(r); dist[k] = (dist[k] || 0) + 1; r.err_class = k; });
    summary.runs[name].wrong_dist = dist;
    md += `\n答錯（非 cat5）${wrong.length} 題的自動分類：\n\n| 原因 | 題數 | 比例 |\n|---|---|---|\n` + Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} | ${pct(n / wrong.length)} |`).join('\n') + '\n\n';
    const c5 = R.filter(r => r.cat === 5);
    if (c5.length) md += `cat5（對抗/無解）拒答率 ${pct(c5.filter(r => r.judge === 'CORRECT').length / c5.length)}（${c5.length} 題）。\n\n`;
    // 抽樣 10 題答錯
    const rnd = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
    const pool = wrong.slice(); const sample = [];
    while (sample.length < 10 && pool.length) sample.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    summary.runs[name].wrong_sample = sample.map(r => ({ qi: r.qi, cat: r.cat, q: r.question, gold: r.gold, answer: r.answer, evidence: r.evidence, err_class: r.err_class, retrieved_dia: r.retrieved_dia, memory: (r.memory || '').slice(0, 1500) }));
    md += `### 答錯抽樣 10 題（固定亂數種子；人工分析欄見 summary.json 的 wrong_sample，結論請見報告）\n\n| # | cat | 問題 | 標準答案 | 模型答案 | 自動分類 |\n|---|---|---|---|---|---|\n` + sample.map(r => `| ${r.qi} | ${r.cat} | ${r.question.replace(/\|/g, '/')} | ${String(r.gold).replace(/\|/g, '/')} | ${String(r.answer).replace(/\|/g, '/').replace(/\n/g, ' ')} | ${r.err_class} |`).join('\n') + '\n\n';
}
fs.writeFileSync(path.join(OUT, `e2e_${id}.md`), md);
fs.writeFileSync(path.join(OUT, `e2e_${id}.json`), JSON.stringify(summary, null, 1));
console.log(md);
