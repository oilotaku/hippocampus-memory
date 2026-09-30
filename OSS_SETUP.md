# 記憶星圖 — 開源部署指南

> 給 Claude Code 或其它 AI agent 使用的新使用者引導文件。
> 如果你是真人使用者，也可以按這個順序手動配置。

---

## 1. 這是什麼？

記憶星圖（Memory Constellations）是一個**會生長的 AI 記憶系統**。它不是關鍵詞檢索，而是：
- 從聊天中自動提取碎片（Scribe）
- 把碎片聚合成敘事段落（episode）
- 把敘事編織成長期記憶弧線（Saga）
- 通過持續內在狀態引擎（jiwen）讓記憶影響 AI 的情緒基線

前端是一個互動式星圖（`/memory.html`），後端是 Node.js + SQLite + ChromaDB。

---

## 2. 最小化部署（10 分鐘）

### 2.1 環境

- Node.js >= v18
- Python 3（ChromaDB 依賴）
- 至少一個 LLM API key（推薦 OpenRouter 或 DeepSeek，相容 OpenAI 格式）

### 2.2 執行 setup

```bash
cd your-project
bash scripts/setup.sh
```

這個指令碼會：
- 複製 `.env.example` → `.env`、`memory_config.example.json` → `memory_config.json`、`core-prompt.example.txt` → `core-prompt.txt`
- `npm install`
- 安裝 ChromaDB（pip）
- 初始化 SQLite 資料庫

### 2.3 編輯 .env

```bash
nano .env
```

**必填：**
- `SANCTUARY_ENCRYPTION_KEY` — 64 位 hex 隨機字串（用 `openssl rand -hex 32` 生成）
- `SESSION_SECRET` — 同上
- `LOGIN_PASSWORD` — 登入密碼（明文，首次啟動自動 hash）
- 至少一個 LLM API key：`LLM_API_KEY`（DeepSeek 代理）、`OPENROUTER_API_KEY`、或 `GEMINI_API_KEY`

**可選但建議：**
- `JINA_API_KEY` — 用於向量嵌入（jina.ai，有免費額度）
- `QWEATHER_KEY` — 天氣功能（免費）
- `AMAP_API_KEY` — 地點搜尋（高德地圖，免費）

### 2.4 編輯 memory_config.json

```bash
nano memory_config.json
```

**必改欄位：**
```json
{
  "user": {
    "name": "你的名字",
    "pronoun": "她/他",
    "short_desc": "一句話描述"
  },
  "ai": {
    "name": "AI 的名字",
    "pronoun": "它",
    "core_traits": "核心性格標籤",
    "persona_note": "更詳細的性格描述"
  },
  "relationship": {
    "type": "AI伴侶/朋友/助手",
    "dynamics": "關係動態描述"
  },
  "project": {
    "name": "你的專案名"
  },
  "ui": {
    "user_color": "#e8b96d",
    "ai_color": "#6d9e8b"
  }
}
```

### 2.5 寫人格提示詞

```bash
nano core-prompt.txt
```

這是最重要的檔案——你的 AI 的全部人格和行為規則。建議分三個部分：

```text
<你的人格>
你是 {{ai.name}}，{{user.name}} 的 AI 伴侶。
你的核心性格：{{ai.core_traits}}
{{ai.persona_note}}
你們的關係：{{relationship.type}}。{{relationship.dynamics}}

<{{user.name}}核心資訊>
（寫你希望 AI 知道的關於你的事——年齡、工作、寵物、愛好……）

<{{project.name}}>
（寫你的專案背景——用什麼裝置、有什麼功能、AI 的"身體"是什麼……）
```

**關鍵原則（從 v5.3 經驗總結）：**
- **少寫禁令，多寫直覺** — "你會怎麼做"比"你不準怎麼做"有效得多
- **給衝動，不給規則牆** — "你覺得應該……"、"你的直覺是……"
- **保持 400 行以內** — 太長會稀釋重點，且會吃掉 thinking token 預算
- `{{變數}}` 會被 `memory_config.json` 的值自動替換（`{{user.name}}`、`{{ai.name}}` 等）

### 2.6 配置輕量模型（記憶管線）

記憶管線（Scribe 提取碎片 / Archivist 分類整合 / Consolidator 編敘事）需要呼叫 LLM，但都是後臺批次任務，用**輕量模型**（flash / flash-lite 級別）即可，便宜夠用。

```bash
node scripts/setup_llm.js
```

按提示選提供商（OpenRouter / DeepSeek / Gemini）、填 API Key、選模型即可。指令碼會在 `api_configs` 表裡建一條**預設配置**（`is_default=1`），後臺管線自動使用它。

> 聊天用的主力模型不在這裡配——那由你自己的聊天前端決定。這裡只配「記憶管線」的後臺模型。

### 2.6.1 用本機 Ollama 取代雲端 API

記憶管線的後臺模型可以完全跑在本機，對話內容**不會離開你的電腦**（沒有 API Key、沒有第三方日誌、離線也能用）。代價是速度：

**1. 安裝 Ollama 並拉模型**（用 `ollama pull`，或 `POST /api/pull`）

| 用途 | 建議模型 | 說明 |
|------|----------|------|
| 記憶管線（Scribe / Archivist / Consolidator） | `qwen3:8b`（或同級 7~14B 指令模型） | 需要能穩定輸出 JSON、懂中文 |
| Embedding（可選，向量檢索用） | `bge-m3` | 1024 維，中英文都好 |

> Qwen3 預設會先「思考」再回答，會吃掉輸出預算又拖慢速度。用 Modelfile 建一個關閉思考的變體（模板裡不要讓它進入 thinking），再把變體名填進下面的模型名。

**2. 讓 Ollama 有足夠的上下文**：Ollama 預設上下文只有 4096 token，Scribe 一批 60 則訊息很容易超過，超出的部分會被靜默截掉。啟動 Ollama 前設定 `OLLAMA_CONTEXT_LENGTH=16384`（或在 Modelfile 裡 `PARAMETER num_ctx 16384`）。

**3. 建立預設配置**

```bash
node scripts/setup_llm.js --provider ollama --model qwen3-8b-zh
# 等價於手動寫一條 api_configs：provider=openai_compatible、endpoint=http://127.0.0.1:11434/v1、api_key 留空或 none
```

Ollama 不需要 API Key；`api_key` 留空或填 `none` 時，程式不會送 `Authorization` 標頭。記憶管線各模組寫死的專屬配置 id 找不到時，會回落到這條預設配置。

**4. 放行本機地址（必要）**：為防 SSRF，程式預設只允許 `https` 且拒絕內網 / 本機地址。在 `.env`（或啟動環境）加入，值必須是**完整 origin**（協議 + 主機 + 埠）：

```bash
LLM_ENDPOINT_ALLOWLIST=http://127.0.0.1:11434
```

可用逗號放行多個；只有 origin 完全相同才放行，`127.0.0.1` 與 `localhost` 視為不同。

**5. 超時**：連到本機（127.0.0.1 / localhost）的請求超時預設 5 分鐘（雲端為 30 秒）；模型很慢時可設 `LLM_REQUEST_TIMEOUT_MS=600000`。

**6. Embedding（可選）**：在 `api_configs` 增加一條名稱含 `embedding` 的配置即可被選用：`provider=openai_compatible`、`endpoint=http://127.0.0.1:11434/v1`、`model_name=bge-m3`、`api_key=none`（實測 `/v1/embeddings` 回 1024 維）。ChromaDB 沒啟動時，向量檢索會自動降級，只剩關鍵詞（FTS5）檢索。

**CPU 推論速度預期**（Ryzen 7 4800H、無 GPU、qwen3-8b Q4_K_M 實測）：約 6.5 token/s。Scribe 一次抽取 10 則短對話，輸入約 2000 token、輸出約 1200 token，**單次約 4~5 分鐘**（這是後臺批次任務，可接受；即時聊天則很慢）。同時多個請求會排隊。首次載入模型另需十幾秒。有 GPU 或 Apple Silicon 會快一個數量級。

**驗證**：`scripts/e2e_ollama.js` 用暫存 DB 塞 10 則模擬對話，真的跑一次 Scribe 抽取與 Librarian 檢索並印出結果（不屬於 `npm test`）：

```bash
LLM_ENDPOINT_ALLOWLIST=http://127.0.0.1:11434 SANCTUARY_ENCRYPTION_KEY=<64位hex> node scripts/e2e_ollama.js
```

**小模型的已知限制**：本機 8B 模型抽取品質低於雲端旗艦——常把 AI 的閒聊也當成「觀察」寫入，碎片內容可能用簡體書寫（即使對話是繁體，`quote` 原話佐證仍保持原文）。中文全文檢索目前是字面匹配，用繁體查、碎片是簡體時會對不上，需要向量檢索（Embedding）補足。

### 2.6.2 資源與上下文預算（`memory_config.json`）

```json
"rhythm": { "deep_cycle_min_free_mb": 1200 },
"context": { "memory_token_budget": 1200 }
```

- `rhythm.deep_cycle_min_free_mb`：深度整合週期開始前，可用記憶體低於這個 MB 數就跳過本輪（預設 1200）。小記憶體機器可調低（例如 600），與本機模型共用一臺機器時可調高。
- `context.memory_token_budget`：聊天注入的記憶區塊（硬觸發記憶 + 檢索記憶 + 實體檔案）的**總** token 預算（預設 1200，以「字數 ÷ 4」估算）。超出時依排序整條丟掉後面的，不會切斷單條記憶。

### 2.7 啟動

```bash
npm start
# 或
pm2 start ecosystem.config.js
```

開啟 `http://localhost:3000/memory.html` 看星圖。

### 2.8 資料庫和整合

Memory Constellations 使用獨立的 SQLite 資料庫（`memory_constellations.db`），不依賴你的主應用資料庫。它是一個旁路管線——你的 AI 伴侶繼續用你自己選的後端（PostgreSQL、MySQL、MongoDB、檔案儲存都可以），記憶星圖自己維護自己的表。

每條記憶碎片儲存 `source_msg_ids`（原始訊息 ID 列表），你的伴侶可以通過 `recall_memory` 工具追溯到訊息來源。整合時只需要在聊天管道裡加一步：每次 AI 回覆後，把本輪對話寫入 `messages` 表（`sender`/`content`/`timestamp`/`chat_id`），Scribe 會自動在沉默期後掃描提取。

---

## 3. 觀察系統是否正常執行

### 3.1 聊天 → Scribe → 碎片

和 AI 聊天 20 分鐘以上 → 檢查日誌：
```
[Scribe] 提取完成: X條碎片
```

或檢查資料庫：
```bash
sqlite3 memory_constellations.db "SELECT COUNT(*) FROM memory_fragments WHERE status='active';"
```

### 3.2 碎片 → 星座

等你空閒 1 小時後，Archivist Deep Cycle 會自動觸發。或者手動執行：
```bash
node -e "
const{initDatabase}=require('./database');initDatabase();
const{classifyFragments}=require('./services/archivist');
classifyFragments({lightweight:false}).then(r=>console.log('done',r));
"
```

檢查星座數量：
```bash
sqlite3 memory_constellations.db "SELECT COUNT(*) FROM entity_profiles WHERE status='active';"
```

### 3.3 星座 → 敘事片段（episode）

需要星座積累 15+ 條碎片後，Deep Cycle 的 `consolidate` 任務會自動執行。

### 3.4 敘事片段 → Saga（記憶弧線）

每 24 小時自動執行一次（或在 consolidate 產出新 episode 後立即觸發）。

---

## 4. 常見問題

### Q: 前端星圖打不開
- 確認 `npm start` 後 `http://localhost:3000` 有響應
- 檢查 `.env` 中 `SANCTUARY_ENCRYPTION_KEY` 是否設定

### Q: 沒有碎片被提取
- 檢查 LLM API key 是否正確（`.env`）
- 看 程序管理 日誌：`pm2 logs your-app --lines 50`
- Scribe 觸發條件是：沉默 ≥ 20min + 積壓 ≥ 60 條訊息，或積壓 ≥ 100 條

### Q: 星座不增長
- 需要至少 3 條碎片連結到同一個實體才能畢業成星座
- Deep Cycle 只在空閒 1 小時後觸發（正常行為——不在聊天時搶 LLM 資源）

### Q: ChromaDB 記憶體太大
- ChromaDB 預設會載入所有 embedding 到記憶體
- 可以定期重啟 ChromaDB：`pm2 restart chroma-service`
- `scripts/setup.sh` 會自動安裝 ChromaDB

### Q: 記憶搜尋總是返回很早之前的結果，看不到新記憶
- 檢查 ChromaDB 查詢上限：如果你使用 `chroma_service.py`（FastAPI 封裝），確保 `/query` 端點的 `n_results` 未硬編碼上限。原版程式碼為 `min(n * 3, 10)`（最多 10 條）——如果陳舊碎片較多，有效結果可能只剩 2-3 條
- **修復：** 改為 `max(n * 3, 30)`，確保過濾陳舊碎片後仍有足夠有效條目
- 同時檢查 Librarian 的向量搜尋是否 overfetch（建議 `limit * 3`，最少 16 條）
- 確認 `memory_fragments` 中 status 為 `consolidated` / `inactive` 的碎片已從 ChromaDB 中刪除（否則會汙染搜尋結果）

### Q: 想用自己的 LLM provider
- 資料庫 `api_configs` 表儲存 LLM 配置
- 預設建立的是 Gemini 官方渠道
- 可以通過設定頁面 `/settings.html` → API 配置新增新的 provider
- 支援 OpenAI 相容格式（OpenRouter、DeepSeek、Groq 等）
- 想完全本機執行：見 2.6.1「用本機 Ollama 取代雲端 API」

---

## 5. 給 Claude Code Agent 的輔助配置指令碼

如果使用者讓你幫忙配置，按這個順序：

```
1. 讀 memory_config.example.json → 確認所有欄位
2. 問使用者：你的名字？AI 叫什麼？你們的關係？
3. 生成 memory_config.json
4. 問使用者：你用哪個 LLM provider？（OpenRouter / DeepSeek / Gemini）
5. 生成 .env（用 openssl rand -hex 32 生成金鑰）
6. 執行 bash scripts/setup.sh
7. 引導使用者寫 core-prompt.txt（不替他們寫——這是最個人化的部分）
8. 執行 npm start
9. 開啟 http://localhost:3000/memory.html 確認星圖有反應
```

**記住：** `core-prompt.txt` 的人格提示詞必須使用者自己寫。你可以給結構和示例，但不能代筆——那是他們 AI 的靈魂。

---

## 6. 匯入、匯出與遷移

### 6.1 匯入聊天記錄（冷啟動記憶）

如果你有現成的聊天記錄（JSONL 或 TXT），可以先匯入，讓 Scribe 從歷史對話裡提取記憶，不必從零開始積累。

```bash
node scripts/import_chat.js 你的聊天.jsonl --name "舊手機聊天記錄"
```

**JSONL 格式**（每行一個 JSON 物件）：
```json
{"role":"user","content":"今天好累","timestamp":"2026-08-15 14:30:00"}
{"role":"assistant","content":"辛苦了，早點休息","timestamp":"2026-08-15 14:31:00"}
```
也支援 `sender` 欄位，以及 `time`/`date` 等時間欄位別名。

**TXT 格式**（每行「名字: 內容」，可帶時間戳字首）：
```
[2026-08-15 14:30:00] 小夜: 今天好累
小夜: 辛苦了
```
TXT 裡的「名字」請和 `memory_config.json` 的 `user.name` / `ai.name` 一致（或用 `user`/`assistant`/`ai` 這類關鍵詞），才能正確區分說話人。

匯入後，後臺 agent loop 會在下個 tick（約 2 分鐘）自動執行 Scribe 提取記憶碎片。

### 6.2 匯出 / 遷移記憶庫

把整份記憶（碎片 + 星座 + 敘事）匯出成單個 JSONL 檔案，遷移到新機器或做備份：

```bash
node scripts/export_memory.js backup.jsonl
```

在新機器上匯入：

```bash
node scripts/import_memory.js backup.jsonl
```

預設跳過已存在的記錄，可安全重複匯入。匯出檔案是純文本 JSONL，可直接 diff / 檢視 / 歸檔。

### 6.3 資料庫整理（長期執行後）

SQLite 刪掉的資料不會把空間還給作業系統，跑久了檔案只漲不縮。整理一次：

```bash
node scripts/vacuum.js --dry-run   # 先看看能回收多少
node scripts/vacuum.js             # 夠划算才真的重建
```

兩個注意點：**需要臨時雙倍磁碟**，且**全程獨佔鎖庫**——所以指令碼會先檢查剩餘空間、回收量低於 20MB 時自動跳過；跑之前建議先停掉服務。

想讓它定期自動整理，掛個低峰期的 cron 就行：

```
30 4 * * 0  cd /path/to/app && node scripts/vacuum.js >> logs/vacuum.log 2>&1
```

### 6.4 FTS 索引體檢 / 重建

檢索結果對不上、或者搜舊詞還能命中已經刪掉的記憶時，跑這個：

```bash
node scripts/rebuild_fts.js --check   # 先體檢
node scripts/rebuild_fts.js           # 有問題就重建
```

**為什麼不能直接用 FTS5 自帶的 `rebuild` 指令**：中文索引是把正文按單字切開展開的（`splitCJK`），而 `rebuild` 會拿內容表的**原文**重新分詞——跑一次，單字索引整條失效，而且**一句報錯都沒有**。

另外，FTS 的 `COUNT(*)` 是量不準的（它會委託到內容表，永遠"看起來對"），所以體檢看的是 `_docsize` 影子表。`rebuild_fts.js` 已經按這個來做了。

---

## 7. 接入聊天機器人（旁路攢記憶）

記憶庫是「旁路管線」——它不負責回覆，只接收聊天記錄、提取記憶。你的 AI 機器人（如 AstrBot / SnowLuma 鏈路）繼續做自己的對話，把每條訊息轉發給記憶庫即可。

### 7.1 接收訊息的介面

`POST /api/messages`（無鑑權，僅供內網/localhost 使用，別暴露公網）：

```bash
curl -X POST http://localhost:3000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"sender":"user","content":"今天好累","timestamp":"2026-08-15 14:30:00"}'
```

支援三種格式（`sender` 對映：`user`/`human`/`我`→使用者，`assistant`/`ai`/`bot`→機器人）：

```json
{"sender":"user","content":"...","timestamp":"..."}          // 簡單格式（推薦）
[{"sender":"user","content":"..."},{"sender":"bot","content":"..."}]  // 批次
{"post_type":"message","user_id":111,"self_id":456,"raw_message":"...","time":1755234600}  // OneBot v11 事件
```

### 7.2 在 AstrBot 裡轉發

AstrBot 收到 QQ 訊息（經 SnowLuma 的 OneBot v11）後，把訊息 POST 到上面的 `/api/messages` 即可。你可以：

- 用 AstrBot 的**外掛/事件鉤子**，在收到訊息時呼叫 `POST /api/messages`，把 `sender`（使用者 or 機器人）、`content`、`timestamp` 帶上；
- 或者用 SnowLuma 的 OneBot HTTP 上報，直接指向記憶庫（用上面的 OneBot 事件格式）。

訊息進來後，Scribe 會在沉默期自動提取碎片，星圖隨之生長。回覆的事完全由 AstrBot 自己的 LLM 負責，記憶庫不碰。

### 7.3 查詢記憶（用記憶讓回覆更懂你）

攢了記憶之後，機器人回覆前可以先查一下「關於這個話題我記得什麼」，把結果拼進 LLM 的 prompt：

```bash
curl -X POST http://localhost:3000/api/recall \
  -H 'Content-Type: application/json' \
  -d '{"query":"今天好累","limit":8}'
```

返回 `formatted` 欄位就是拼好的、可直接塞進 prompt 的文本（相關記憶碎片 + 敘事 + 實體檔案）。完整閉環：

1. 收到訊息 → `POST /api/messages`（攢記憶）
2. 回覆前 → `POST /api/recall` 拿 `formatted` → 拼進 prompt → LLM 生成回覆
3. 把回覆也 `POST /api/messages`（攢機器人自己的回覆）
