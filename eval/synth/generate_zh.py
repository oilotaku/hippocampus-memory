#!/usr/bin/env python3
"""繁體中文長期對話評測資料集產生器（LoCoMo 格式）。

三個角色各自獨立呼叫 `claude -p`，只拿到自己該知道的資訊：
  A 使用者（Haiku）：自己的人設、到目前為止的生活事件、本次要聊的事。
  B 助理（Haiku）：助理人設、前幾次對話的摘要（由 C 產生）。
  C 導演兼評審（Sonnet）：規劃事件時間軸；每次對話後檢查、修正矛盾並依計畫改寫少數句子
     （只差一個細節的誘餌、換句話說、事實更新、相對日期、簡體句）；最後出題並標註證據。

輸出與 LoCoMo 的 locomo10.json 相同結構，可直接沿用 eval/ 的評測腳本。
在 Pi 上執行（只呼叫遠端模型，不跑 node）。每一步都寫檢查點，中斷後加 --resume 從上次繼續。

用法：
  python3 eval/synth/generate_zh.py --out data/zh_synth --conversations 1 --sessions 3 --turns 12
  python3 eval/synth/generate_zh.py --out data/zh_synth --resume
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

MODELS = {"A": "haiku", "B": "haiku", "C": "sonnet"}
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")
# 必須在「往上層找不到任何 CLAUDE.md」的目錄執行：claude CLI 會沿工作目錄往上載入 CLAUDE.md，
# 若放在 ~/.claude/ 底下會把使用者全域 CLAUDE.md（約 9 萬 token）當專案設定載入，每次呼叫都重付（實測成本差約 400 倍）。
# 另以 --setting-sources project 排除使用者層設定。
WORKDIR = os.environ.get("SYNTH_WORKDIR", "/tmp/claude-synth-48ec94c2")


class Budget:
    def __init__(self, max_cost, state):
        self.max_cost = max_cost
        self.state = state  # 共用 state["usage"]

    def add(self, role, cost):
        u = self.state.setdefault("usage", {"calls": {}, "cost": 0.0})
        u["calls"][role] = u["calls"].get(role, 0) + 1
        u["cost"] = round(u["cost"] + (cost or 0.0), 6)
        if self.max_cost and u["cost"] > self.max_cost:
            raise SystemExit(f"已超過成本上限 {self.max_cost}（目前 {u['cost']:.4f}），已存檢查點，可加大上限後 --resume")


def call(role, system, user, budget, expect_json=False, retries=2):
    os.makedirs(WORKDIR, exist_ok=True)
    cmd = [CLAUDE, "-p", "--model", MODELS[role], "--setting-sources", "project",
           "--strict-mcp-config", "--tools", "", "--no-session-persistence",
           "--system-prompt", system, "--output-format", "json"]
    last_err = None
    for attempt in range(retries + 1):
        try:
            p = subprocess.run(cmd, input=user, capture_output=True, text=True, cwd=WORKDIR, timeout=600)
            d = json.loads(p.stdout)
            budget.add(role, d.get("total_cost_usd"))
            if d.get("is_error"):
                raise RuntimeError(str(d.get("result"))[:200])
            text = (d.get("result") or "").strip()
            if not expect_json:
                return text
            return parse_json(text)
        except (json.JSONDecodeError, RuntimeError, subprocess.TimeoutExpired, ValueError) as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"角色 {role} 呼叫失敗：{last_err}")


def parse_json(text):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise ValueError("回覆中沒有 JSON")
    s = min(starts)
    closer = "}" if text[s] == "{" else "]"
    e = text.rfind(closer)
    return json.loads(text[s:e + 1])


# ── C：規劃 ─────────────────────────────────────────────────────
PLAN_SYS = """你是長期對話評測資料集的導演。用繁體中文（台灣用語）設計一段「使用者與 AI 陪伴助理」持續數月的對話計畫。
只輸出一個 JSON 物件，不要任何說明文字。"""

PLAN_USER = """請設計第 {n} 組對話（與其他組的人物、職業、城市要不同，種子：{seed}）。共 {sessions} 次對話，時間跨度約 {months} 個月，日期逐次遞增（格式 YYYY-MM-DD HH:MM，年份用 2026）。
JSON 結構：
{{
 "user": {{"name": "中文名", "age": 數字, "city": "台灣縣市", "job": "...", "family": ["..."], "habits": ["..."], "traits": "個性一句話"}},
 "assistant": {{"name": "助理名字", "style": "說話風格一句話"}},
 "sessions": [
   {{"idx": 1, "date": "2026-..", "user_events": ["這次使用者要自然提到的具體生活細節，含人名、地點、數字、星期"], "injections": [{{"type": "lure|paraphrase|update|relative_date|simplified", "detail": "要怎麼改寫、改寫哪個事實"}}]}}
 ]
}}
規則：
- 每次 3～5 個 user_events，要具體可查證（例如「每週三晚上在三重打羽球」「媽媽生日 10 月 8 日」）。
- 跨對話安排這些測試情境（injections 放在應該發生的那一次）：
  lure：新提到一個與舊事實只差一個細節的「不同事實」（例如先前是週三打羽球，這次是週五上瑜伽課；或學日文之外朋友在學韓文），不可是更正；
  paraphrase：用完全不同的說法再提一次先前的事實；
  update：事實真的改變（搬家、換工作、分手、換寵物名字等），要讓新舊值都明確；
  relative_date：用「下個月十五號」「下週三」「三天後」這類相對日期講未來計畫；
  simplified：這次挑一句使用者訊息改用簡體字。
- 每種情境在整組中至少出現一次；lure 與 update 各至少兩次。"""

# ── A、B：發言 ─────────────────────────────────────────────────
A_SYS = """你是 {name}，{age} 歲，住在{city}，職業：{job}。家人：{family}。習慣：{habits}。個性：{traits}
你正在和 AI 陪伴助理「{aname}」用手機聊天。今天是 {date}。
你到目前為止的生活（只有你知道，助理不一定知道）：
{life}
這次聊天你會在適當時機自然提到（分散在不同訊息裡，不要擠在同一句）：
{todo}
規則：用繁體中文、台灣口語，像真人傳訊息，一次一到三句；不要一次把所有事情講完；可以閒聊、抱怨、分享心情；
不要自稱 AI；不要重複自己剛說過的話；時間到了可以說晚安或先忙結束。只輸出你要傳的那則訊息本身。"""

B_SYS = """你是 AI 陪伴助理「{aname}」，說話風格：{style}。對方是 {uname}。今天是 {date}。
你記得的過去對話摘要（可能不完整）：
{memory}
規則：用繁體中文、台灣用語，一次一到三句；自然回應、關心、追問細節；可以提起摘要中記得的事；
不要編造對方沒說過的事；不要列清單；只輸出你要回的那則訊息本身。"""

TURN_USER = """目前這次聊天的內容：
{transcript}

請寫出你的下一則訊息。"""

# ── C：每次對話後的評審與修正 ─────────────────────────────────────
REVIEW_SYS = """你是長期對話評測資料集的評審兼編輯，只用繁體中文（台灣用語），只輸出 JSON。"""
REVIEW_USER = """使用者資料：{user}
先前已確立的事實（含 dia_id）：
{facts}
本次（第 {idx} 次，{date}）預定的測試情境：
{injections}
本次對話逐字稿（dia_id｜說話者｜內容）：
{transcript}

請做三件事並輸出 JSON：
1. 修正：找出與先前事實矛盾（非刻意安排的 update）或與使用者資料不符的句子並最小幅度修正；
   預定的測試情境多半已在對話中自然出現；只有漏掉的才改寫，最多 3 句使用者的話，每句只落實一個情境；
   若改寫了使用者的話，可同時微調緊接的那一句助理回覆，讓它自然回應新內容；
   simplified 情境：把指定的一句使用者訊息改成簡體字（其他一律繁體）。
   不可新增或刪除句子，dia_id 與說話者不可變。
   **只能根據逐字稿與「先前已確立的事實」判斷**：不可引用計畫或你自己想像、但對話中沒有說出口的內容。
2. 摘要：用 3～5 句寫出本次對話摘要（給助理下次參考）。
3. 標註：列出本次新出現的可查證事實，每條附上出處 dia_id 與類型 new|update|lure|paraphrase|relative_date；
   update 要寫出被取代的舊值與其 dia_id，**舊值必須出自上方「先前已確立的事實」清單並使用它的 dia_id**；
   找不到對應的舊事實就不是 update，改標 new；lure 的說明也不可提到對話中沒出現過的事物；
   relative_date 要寫出換算後的絕對日期（以本次日期為基準）。
JSON 結構：
{{"turns": [{{"dia_id": "...", "speaker": "...", "text": "..."}}],
  "edited": ["被改寫的 dia_id"],
  "summary": "...",
  "facts": [{{"dia_id": "...", "fact": "...", "kind": "...", "replaces": "舊值（可空）", "replaces_dia_id": "（可空）", "resolved_date": "YYYY-MM-DD（可空）"}}]}}"""

# ── C：出題 ─────────────────────────────────────────────────────
QA_SYS = """你是長期對話記憶評測的出題者，只用繁體中文（台灣用語），只輸出 JSON 陣列。"""
QA_USER = """以下是一組完整的長期對話（每次對話前有日期）與已標註的事實。
請出 {nq} 題問答，題目要站在「助理事後回想使用者的事」的角度問（例如「{uname} 每週幾打羽球？」）。
類別（category）與比例：
 4 單跳事實（約 35%）：答案在單一句話；
 2 時間（約 20%）：問日期、先後、多久以前，答案用絕對日期；
 1 多跳（約 15%）：需要結合兩句以上（例如搬家後住的城市＋在那裡的活動）；
 3 推理（約 5%）：需要常識推論，但仍以對話為根據；
 5 無解（約 25%）：問對話中從未提過的事，其中至少一半要是「誘餌」——與真實事實只差一個細節（例如問週五打羽球的地點，但實際是週三），答案一律為「未提及」。
另外務必涵蓋：被 update 取代的事實要問「現在」的值；lure 要各出一題；簡體句中的事實要出一題。
每題：{{"question": "...", "answer": "...", "category": 數字, "evidence": ["D1:3", ...]}}；無解題的 evidence 放最相關的誘餌出處（可為空陣列）。
evidence 必須是下面出現過的 dia_id。

對話：
{dialogue}

已標註事實：
{facts}"""


def fmt_transcript(turns):
    return "\n".join(f"{t['dia_id']}｜{t['speaker']}｜{t['text']}" for t in turns) or "（尚未開始）"


def life_so_far(plan, upto_idx):
    lines = []
    for s in plan["sessions"]:
        if s["idx"] < upto_idx:
            lines += [f"- {e}" for e in s.get("user_events", [])]
    return "\n".join(lines) or "（這是你第一次和助理聊天）"


def run_session(conv, plan, s, args, budget):
    u, a = plan["user"], plan["assistant"]
    idx, date = s["idx"], s["date"]
    a_sys = A_SYS.format(name=u["name"], age=u["age"], city=u["city"], job=u["job"],
                         family="、".join(u.get("family", [])), habits="、".join(u.get("habits", [])),
                         traits=u.get("traits", ""), aname=a["name"], date=date,
                         life=life_so_far(plan, idx), todo="\n".join([f"- {e}" for e in s.get("user_events", [])]
                                         + [f"- {i['detail']}" for i in s.get("injections", [])
                                            if isinstance(i, dict) and i.get("type") != "simplified" and i.get("detail")]))
    b_sys = B_SYS.format(aname=a["name"], style=a.get("style", ""), uname=u["name"], date=date,
                         memory="\n".join(f"- {x}" for x in conv["summaries"]) or "（第一次聊天）")
    turns = []
    for t in range(args.turns):
        speaker, role, system = (u["name"], "A", a_sys) if t % 2 == 0 else (a["name"], "B", b_sys)
        text = call(role, system, TURN_USER.format(transcript=fmt_transcript(turns)), budget)
        text = re.sub(r"^\s*[^｜:：\n]{1,12}[:：]\s*", "", text).strip()  # 去掉模型自己加的「名字：」
        turns.append({"speaker": speaker, "dia_id": f"D{idx}:{t + 1}", "text": text})
    review = call("C", REVIEW_SYS, REVIEW_USER.format(
        user=json.dumps(u, ensure_ascii=False), facts="\n".join(
            f"{f['dia_id']}｜{f['fact']}｜{f['kind']}" for f in conv["facts"]) or "（無）",
        idx=idx, date=date, injections=json.dumps(s.get("injections", []), ensure_ascii=False),
        transcript=fmt_transcript(turns)), budget, expect_json=True)
    fixed = {x["dia_id"]: x for x in review.get("turns", []) if isinstance(x, dict)}
    for t in turns:  # 只接受同 dia_id、同說話者的修改；不接受新增或刪除
        f = fixed.get(t["dia_id"])
        if f and f.get("speaker") == t["speaker"] and f.get("text"):
            if f["text"] != t["text"]:
                t["original_text"] = t["text"]
            t["text"] = f["text"]
    valid = {t["dia_id"] for t in turns}
    prior_ids = {f["dia_id"] for f in conv["facts"]}
    facts = []
    for f in review.get("facts", []):
        if not isinstance(f, dict) or f.get("dia_id") not in valid:
            continue
        if f.get("kind") == "update" and f.get("replaces_dia_id") not in prior_ids:
            # 被取代的舊事實必須是對話中真的說過、已標註的事實；否則不是 update
            f["kind"] = "new"
            f["replaces"] = ""
            f["replaces_dia_id"] = ""
        facts.append(f)
    return turns, review.get("summary", ""), facts, review.get("edited", [])


def make_qa(conv, plan, args, budget):
    dialogue = []
    for s in plan["sessions"]:
        k = f"session_{s['idx']}"
        if k in conv["sessions"]:
            dialogue.append(f"【第 {s['idx']} 次 {s['date']}】\n" + fmt_transcript(conv["sessions"][k]))
    nq = max(10, args.qa_per_session * len(conv["sessions"]))
    qa = call("C", QA_SYS, QA_USER.format(nq=nq, uname=plan["user"]["name"], dialogue="\n\n".join(dialogue),
                                          facts="\n".join(f"{f['dia_id']}｜{f['fact']}｜{f['kind']}"
                                                          + (f"｜取代 {f.get('replaces')}（{f.get('replaces_dia_id')}）" if f.get('replaces') else "")
                                                          + (f"｜日期 {f.get('resolved_date')}" if f.get('resolved_date') else "")
                                                          for f in conv["facts"])), budget, expect_json=True)
    valid = {t["dia_id"] for ss in conv["sessions"].values() for t in ss}
    out = []
    for q in qa if isinstance(qa, list) else []:
        if not isinstance(q, dict) or not q.get("question") or q.get("category") not in (1, 2, 3, 4, 5):
            continue
        ev = [e for e in q.get("evidence", []) if e in valid]
        if q["category"] != 5 and not ev:
            continue  # 有解題必須有有效證據
        out.append({"question": q["question"], "answer": q.get("answer", ""), "category": q["category"], "evidence": ev})
    return out


def to_locomo(conv, plan, sample_id):
    c = {"speaker_a": plan["user"]["name"], "speaker_b": plan["assistant"]["name"]}
    for s in plan["sessions"]:
        k = f"session_{s['idx']}"
        if k in conv["sessions"]:
            c[k] = [{kk: t[kk] for kk in ("speaker", "dia_id", "text")} for t in conv["sessions"][k]]
            c[f"{k}_date_time"] = s["date"]
    return {"sample_id": sample_id, "conversation": c, "qa": conv.get("qa", []),
            "session_summary": {f"session_{i + 1}_summary": x for i, x in enumerate(conv["summaries"])},
            "observation": conv["facts"], "plan": plan, "edits": conv["edits"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--conversations", type=int, default=1)
    ap.add_argument("--sessions", type=int, default=3)
    ap.add_argument("--turns", type=int, default=16, help="每次對話的訊息數（A、B 輪流）")
    ap.add_argument("--months", type=int, default=6)
    ap.add_argument("--qa-per-session", type=int, default=8)
    ap.add_argument("--max-cost", type=float, default=5.0, help="API 等值成本上限（美元），超過即停並存檢查點")
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    ckpt = os.path.join(args.out, "checkpoint.json")
    state = json.load(open(ckpt, encoding="utf-8")) if args.resume and os.path.exists(ckpt) else {"convs": []}
    if args.resume:
        a0 = state.get("args", {})
        for k in ("conversations", "sessions", "turns", "months", "qa_per_session"):
            if k in a0:
                setattr(args, k, a0[k])
    state["args"] = {k: getattr(args, k) for k in ("conversations", "sessions", "turns", "months", "qa_per_session")}
    budget = Budget(args.max_cost, state)

    def save():
        tmp = ckpt + ".tmp"
        json.dump(state, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        os.replace(tmp, ckpt)

    for n in range(1, args.conversations + 1):
        if len(state["convs"]) < n:
            print(f"[計畫] 第 {n} 組", flush=True)
            plan = call("C", PLAN_SYS, PLAN_USER.format(n=n, seed=f"zh-{n}-{int(time.time())}",
                                                        sessions=args.sessions, months=args.months), budget, expect_json=True)
            plan["sessions"] = sorted(plan["sessions"], key=lambda s: s["idx"])[: args.sessions]
            state["convs"].append({"plan": plan, "sessions": {}, "summaries": [], "facts": [], "edits": {}, "qa": None})
            save()
        conv = state["convs"][n - 1]
        plan = conv["plan"]
        for s in plan["sessions"]:
            k = f"session_{s['idx']}"
            if k in conv["sessions"]:
                continue
            t0 = time.time()
            turns, summary, facts, edited = run_session(conv, plan, s, args, budget)
            conv["sessions"][k] = turns
            conv["summaries"].append(summary)
            conv["facts"] += facts
            conv["edits"][k] = edited
            save()
            print(f"[對話] 第 {n} 組 第 {s['idx']} 次 {s['date']}：{len(turns)} 則、改寫 {len(edited)}、事實 {len(facts)}，"
                  f"{time.time() - t0:.0f} 秒，累計成本 {state['usage']['cost']:.4f}", flush=True)
        if conv["qa"] is None:
            conv["qa"] = make_qa(conv, plan, args, budget)
            save()
            print(f"[出題] 第 {n} 組：{len(conv['qa'])} 題", flush=True)
    data = [to_locomo(c, c["plan"], f"zh-{i + 1}") for i, c in enumerate(state["convs"])]
    out = os.path.join(args.out, "zh_synth.json")
    json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    u = state["usage"]
    print(f"完成：{out}｜呼叫次數 {u['calls']}｜API 等值成本 {u['cost']:.4f} 美元", flush=True)


if __name__ == "__main__":
    sys.exit(main())
