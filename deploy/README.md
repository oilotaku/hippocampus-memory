# 部署到 AstrBot + SnowLuma 的說明

記憶庫（Memory Constellations）是**獨立的 Node.js 服務**，不是 AstrBot 外掛。
要接入 AstrBot，需要兩件事一起做：

1. **記憶庫跑成一個 Docker 容器**（獨立服務，監聽 3000 埠）
2. **（可選）ChromaDB 跑一個容器**（向量/語義檢索，監聽 7707 埠）
3. **AstrBot 裝一個橋接外掛**（把聊天訊息轉發給記憶庫）

---

## 第一步：把記憶庫加進 docker-compose

把 `docker-compose.memory.yml` 裡的 `memory-constellations` 服務，合併到你的 `docker-compose.yml` 的 `services:` 下面（和 `astrbot`、`snowluma` 平級）。

改好後：

```bash
# 生成兩個隨機金鑰
openssl rand -hex 32   # 填到 SANCTUARY_ENCRYPTION_KEY
openssl rand -hex 32   # 填到 SESSION_SECRET

docker compose up -d --build
```

啟動後記憶庫在 `http://localhost:3000`，Web 星圖在 `http://localhost:3000/memory.html`（登入密碼是 `LOGIN_PASSWORD`）。

---

## 第二步：裝 AstrBot 橋接外掛

橋接外掛的檔案在 `deploy/astrbot-plugin/` 目錄（`metadata.yaml` + `main.py` + `requirements.txt`）。

**AstrBot 的「從 GitHub 匯入外掛」要求 `metadata.yaml` 在倉庫根目錄**，所以這個外掛需要放在一個**獨立的 GitHub 倉庫**（不能放在記憶庫倉庫的子目錄裡）。

做法（二選一）：

1. 新建一個 GitHub 倉庫，把 `deploy/astrbot-plugin/` 裡的三個檔案上傳到倉庫根目錄，然後在 AstrBot 裡貼上這個倉庫地址匯入；
2. 或者手動：把 `main.py` 複製到 AstrBot 的外掛目錄，`requirements.txt` 裡的 `aiohttp` 用 `pip install aiohttp` 裝上。

匯入後，在外掛的環境變數裡設定（或直接改 `main.py` 頂部）：

```
MEMORY_API_BASE=http://memory-constellations:3000
```

（`memory-constellations` 是 docker-compose 裡的容器名，AstrBot 容器內能通過這個名字訪問它。）

---

## 完事後的效果

- AstrBot 收到的使用者訊息 → 自動 POST 給記憶庫 → Scribe 提取記憶碎片
- AstrBot 的回覆 → 也 POST 給記憶庫 → 記住機器人說過的話
- 記憶庫 Web 星圖（`memory.html`）能看到星座生長

記憶庫**不負責回覆**，回覆還是 AstrBot 自己的 LLM。

---

## 備註

- 記憶庫的**向量檢索需要 ChromaDB 服務**（`chroma_service.py`，埠 7707），已隨倉庫提供（`deploy/Dockerfile.chroma` + compose 裡的 `chroma` 服務）。記憶庫通過 `CHROMA_URL` 環境變數連 chroma 容器（compose 裡已配好 `CHROMA_URL=http://chroma:7707`）。沒有 ChromaDB 時記憶庫仍能跑、能提取碎片，只是「向量語義檢索」降級為「關鍵詞檢索」。
- `deploy/astrbot-plugin/main.py` 裡的 `on_decorating_result` 是 AstrBot 的 LLM 生命週期鉤子，如果 AstrBot 版本不同導致報錯，刪掉這個函式、只留 `on_user_message` 也能用（只是不記機器人回覆）。
