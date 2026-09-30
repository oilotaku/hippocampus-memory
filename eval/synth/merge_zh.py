#!/usr/bin/env python3
"""合併平行產生的多份 zh_synth.json 成一份（LoCoMo 格式），並彙總用量。
用法：python3 eval/synth/merge_zh.py data/zh_synth_p1 data/zh_synth_p2 data/zh_synth_p3 --out data/zh_synth/zh_synth.json
"""
import argparse, json, os
ap = argparse.ArgumentParser()
ap.add_argument("dirs", nargs="+")
ap.add_argument("--out", required=True)
a = ap.parse_args()
data, cost, calls = [], 0.0, {}
for d in a.dirs:
    data += json.load(open(os.path.join(d, "zh_synth.json"), encoding="utf-8"))
    u = json.load(open(os.path.join(d, "checkpoint.json"), encoding="utf-8")).get("usage", {})
    cost += u.get("cost", 0.0)
    for k, v in u.get("calls", {}).items():
        calls[k] = calls.get(k, 0) + v
os.makedirs(os.path.dirname(a.out), exist_ok=True)
json.dump(data, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"合併 {len(data)} 組、{sum(len(x['qa']) for x in data)} 題 → {a.out}｜呼叫 {calls}｜API 等值成本 {cost:.4f} 美元")
