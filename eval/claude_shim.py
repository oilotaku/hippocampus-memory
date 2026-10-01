#!/usr/bin/env python3
"""OpenAI 相容端點 → `claude -p`（走 Claude 訂閱額度）的轉接器，只給評測用。

- 只綁 127.0.0.1，Windows 端經 `ssh -R <port>:127.0.0.1:<port> win` 反向通道連進來，不對區網開放。
- 支援 POST /v1/chat/completions（stream 與非 stream），忽略 tools / temperature / max_tokens。
- 每次呼叫一律 --tools "" --strict-mcp-config --setting-sources project，並在「往上層找不到任何 CLAUDE.md」
  的目錄執行，避免把使用者全域 CLAUDE.md（約 9 萬 token）帶進每次呼叫（實測成本差約 400 倍）。
- SHIM_MAX_COST（美元等值，取自 CLI 回報的 total_cost_usd）超過後一律回 429，評測端會視為錯誤而停下。

環境變數：SHIM_PORT(18765) SHIM_MODEL(覆蓋請求的 model；預設 haiku) SHIM_CONCURRENCY(2)
          SHIM_MAX_COST(0=不限) SHIM_LOG(每次呼叫一行 JSONL) SHIM_WORKDIR
          SHIM_THINKING(傳給 MAX_THINKING_TOKENS，預設 0＝不思考)
          SHIM_ENFORCE_MAX_TOKENS(1＝依請求的 max_tokens 截斷回覆並回 finish_reason=length，重現正式 API 的截斷)
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SHIM_PORT", "18765"))
MODEL = os.environ.get("SHIM_MODEL", "haiku")
MAX_COST = float(os.environ.get("SHIM_MAX_COST", "0") or 0)
ENFORCE_MAX_TOKENS = os.environ.get("SHIM_ENFORCE_MAX_TOKENS", "") not in ("", "0")
LOG = os.environ.get("SHIM_LOG", "")
WORKDIR = os.environ.get("SHIM_WORKDIR", f"/tmp/claude-shim-{os.getuid()}")
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")
SEM = threading.Semaphore(int(os.environ.get("SHIM_CONCURRENCY", "2")))
LOCK = threading.Lock()
STATE = {"calls": 0, "errors": 0, "cost": 0.0, "in": 0, "out": 0, "cache_read": 0, "cache_write": 0}


def _check_workdir():
    os.makedirs(WORKDIR, exist_ok=True)
    d = os.path.realpath(WORKDIR)
    while True:
        for name in ("CLAUDE.md", ".claude/CLAUDE.md"):
            if os.path.exists(os.path.join(d, name)):
                sys.exit(f"SHIM_WORKDIR 往上找得到 {os.path.join(d, name)}，會被 claude CLI 載入，請換目錄")
        parent = os.path.dirname(d)
        if parent == d:
            return
        d = parent


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return "" if content is None else str(content)


def build_prompt(messages):
    system = "\n\n".join(_text(m.get("content")) for m in messages if m.get("role") == "system")
    convo = [m for m in messages if m.get("role") != "system"]
    if len(convo) == 1 and convo[0].get("role") == "user":
        return system, _text(convo[0].get("content"))
    lines = []
    for m in convo:
        role = {"user": "USER", "assistant": "ASSISTANT", "tool": "TOOL RESULT"}.get(m.get("role"), m.get("role", "").upper())
        lines.append(f"[{role}]\n{_text(m.get('content'))}")
    lines.append("[ASSISTANT]")
    return system, "Continue the conversation below as the assistant. Reply with the assistant's next message only.\n\n" + "\n\n".join(lines)


def call_claude(system, prompt, model):
    cmd = [CLAUDE, "-p", "--model", model, "--setting-sources", "project", "--strict-mcp-config",
           "--tools", "", "--no-session-persistence", "--output-format", "json"]
    # 一律帶系統提示詞：不帶時 CLI 會套用 Claude Code 自己約 6.5k token 的預設系統提示詞（實測）。
    # 用 --system-prompt-file 而不是 --system-prompt：Linux 單一命令列參數上限 128KB（MAX_ARG_STRLEN），
    # 整段長對話（約 6 萬個中文字＝約 19 萬位元組）放進參數會 E2BIG「Argument list too long」。
    fd, sp_path = tempfile.mkstemp(prefix="sysprompt-", suffix=".txt", dir=WORKDIR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(system or "You are a helpful assistant.")
    cmd += ["--system-prompt-file", sp_path]
    t0 = time.time()
    # 預設關閉延伸思考（MAX_THINKING_TOKENS=0）：開著時 Haiku 一批 Scribe 抽取輸出約 2.3 萬 token、209 秒；
    # 關閉後輸出約少 5 倍。本機 qwen3 的思考也是關閉的，兩邊條件一致。SHIM_THINKING 可覆寫。
    env = dict(os.environ, MAX_THINKING_TOKENS=os.environ.get("SHIM_THINKING", "0"))
    try:
        p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=WORKDIR, timeout=900, env=env)
    finally:
        try:
            os.unlink(sp_path)
        except OSError:
            pass
    if p.returncode != 0:
        raise RuntimeError(f"claude exit {p.returncode}: {(p.stderr or p.stdout)[-400:]}")
    out = json.loads(p.stdout)
    if out.get("is_error"):
        raise RuntimeError(f"claude error: {str(out.get('result'))[:400]}")
    u = out.get("usage") or {}
    rec = {"t": time.strftime("%H:%M:%S"), "s": round(time.time() - t0, 1), "model": model,
           "in": u.get("input_tokens", 0), "out": u.get("output_tokens", 0),
           "cache_read": u.get("cache_read_input_tokens", 0), "cache_write": u.get("cache_creation_input_tokens", 0),
           "cost": out.get("total_cost_usd") or 0.0}
    with LOCK:
        STATE["calls"] += 1
        STATE["cost"] += rec["cost"]
        for k in ("in", "out", "cache_read", "cache_write"):
            STATE[k] += rec[k]
        if LOG:
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
    return out.get("result") or "", rec


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        if self.path.rstrip("/").endswith("/stats"):
            with LOCK:
                return self._json(200, dict(STATE))
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if MAX_COST and STATE["cost"] >= MAX_COST:
            return self._json(429, {"error": {"message": f"shim budget {MAX_COST} exhausted"}})
        system, prompt = build_prompt(body.get("messages") or [])
        model = os.environ.get("SHIM_MODEL") or body.get("model") or MODEL
        try:
            with SEM:
                text, rec = call_claude(system, prompt, model)
        except Exception as e:  # noqa: BLE001
            with LOCK:
                STATE["errors"] += 1
            print(f"[shim] 錯誤：{e}", file=sys.stderr, flush=True)
            return self._json(502, {"error": {"message": str(e)[:500]}})
        cid = "chatcmpl-" + uuid.uuid4().hex[:12]
        # SHIM_ENFORCE_MAX_TOKENS=1：重現正式 API 的輸出上限。claude -p 無法設定輸出上限，所以在回覆超過請求的
        # max_tokens 時，依 token 比例截斷文字並回 finish_reason="length"（正式環境截斷時的樣子）。
        finish = "stop"
        max_tok = body.get("max_tokens")
        if ENFORCE_MAX_TOKENS and isinstance(max_tok, int) and max_tok > 0 and rec["out"] > max_tok and text:
            text = text[: max(1, int(len(text) * max_tok / rec["out"]))]
            finish = "length"
            with LOCK:
                STATE["truncated"] = STATE.get("truncated", 0) + 1
        usage = {"prompt_tokens": rec["in"] + rec["cache_read"] + rec["cache_write"], "completion_tokens": min(rec["out"], max_tok) if finish == "length" else rec["out"]}
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        if not body.get("stream"):
            return self._json(200, {"id": cid, "object": "chat.completion", "model": model, "usage": usage,
                                    "choices": [{"index": 0, "finish_reason": finish,
                                                 "message": {"role": "assistant", "content": text}}]})
        chunks = [
            {"id": cid, "object": "chat.completion.chunk", "model": model,
             "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
            {"id": cid, "object": "chat.completion.chunk", "model": model, "usage": usage,
             "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
        ]
        payload = "".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        b = payload.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


if __name__ == "__main__":
    _check_workdir()
    print(f"[shim] 127.0.0.1:{PORT} model={MODEL} max_cost={MAX_COST or '不限'} workdir={WORKDIR}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
