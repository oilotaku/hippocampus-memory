#!/usr/bin/env python3
"""抽取穩定度報告：同一設定跑多次抽取（eval/locomo_e2e.js extract），比較記憶數、證據召回率與跨次一致度。

用法：python3 eval/stability_report.py 'legacy=results/e2e_*_pl*_extract.json' 'v2=results/e2e_*_pv*_extract.json'
每個參數是「標籤=glob」；同一對話的多次執行依檔名中的對話編號（e2e_<對話>_...）分組。
輸出 Markdown 表格：
- 記憶數：平均、變異係數（標準差／平均）
- 證據召回率（evidence turn）：平均、標準差、最小～最大
- 一致度：同一對話各次「涵蓋到的證據輪次」集合兩兩 Jaccard 的平均
"""
import glob
import itertools
import json
import os
import statistics
import sys


def load(pattern):
    by_conv = {}
    for f in sorted(glob.glob(pattern)):
        d = json.load(open(f, encoding='utf-8'))
        if not d.get('done') or 'recall' not in d:
            continue
        by_conv.setdefault(d['conv'], []).append(d)
    return by_conv


def ev_turns(d, data_qa):
    return {e for q in data_qa for e in q.get('evidence', []) if q.get('category') != 5} & set(d.get('covered', []))


def jaccard(a, b):
    return len(a & b) / len(a | b) if (a | b) else 1.0


def fmt(x, pct=False):
    return '–' if x is None else (f'{x * 100:.1f}%' if pct else f'{x:.1f}')


def main():
    data_path = os.environ.get('LOCOMO_DATA', 'data/zh_synth/zh_synth.json')
    qa = {c['sample_id']: c['qa'] for c in json.load(open(data_path, encoding='utf-8'))}
    print('| Setup | Conversation | Runs | Memories (mean) | Memories CV | Evidence recall (mean ± sd) | Range | Run-to-run Jaccard |')
    print('|---|---|---|---|---|---|---|---|')
    for arg in sys.argv[1:]:
        label, pattern = arg.split('=', 1)
        groups = load(pattern)
        allrec, allcv, alljac = [], [], []
        for conv, runs in sorted(groups.items()):
            n = [r['n_frags'] for r in runs]
            rec = [r['recall']['turn'] for r in runs]
            sets = [ev_turns(r, qa.get(conv, [])) for r in runs]
            jac = [jaccard(a, b) for a, b in itertools.combinations(sets, 2)]
            cv = statistics.pstdev(n) / statistics.mean(n) if len(n) > 1 and statistics.mean(n) else None
            sd = statistics.pstdev(rec) if len(rec) > 1 else None
            mj = statistics.mean(jac) if jac else None
            allrec += rec
            if cv is not None: allcv.append(cv)
            if mj is not None: alljac.append(mj)
            print(f'| {label} | {conv} | {len(runs)} | {fmt(statistics.mean(n))} | {fmt(cv, True)} | {fmt(statistics.mean(rec), True)} ± {fmt(sd, True)} | {fmt(min(rec), True)}–{fmt(max(rec), True)} | {fmt(mj, True)} |')
        if allrec:
            print(f'| **{label} overall** | | {len(allrec)} | | {fmt(statistics.mean(allcv), True) if allcv else "–"} | {fmt(statistics.mean(allrec), True)} ± {fmt(statistics.pstdev(allrec), True)} | {fmt(min(allrec), True)}–{fmt(max(allrec), True)} | {fmt(statistics.mean(alljac), True) if alljac else "–"} |')


if __name__ == '__main__':
    main()
