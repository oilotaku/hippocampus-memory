# Memory Constellations 記憶庫 — Docker 映象
FROM node:20-bookworm

WORKDIR /app

# 先裝依賴（利用 Docker 層快取）
COPY package.json ./
RUN npm install

# 複製原始碼
COPY . .

EXPOSE 3000

# 啟動前初始化資料庫，再起服務（首次執行自動從 example 生成 core-prompt.txt）
CMD ["sh", "-c", "cp -n core-prompt.example.txt core-prompt.txt 2>/dev/null; cp -n memory_config.example.json memory_config.json 2>/dev/null; node -e \"require('./database').initDatabase()\" && node index.js"]
