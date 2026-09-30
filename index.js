// =================================================================
// Memory Constellations — 入口檔案
// =================================================================

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDatabase } = require('./database');
const { CONFIG } = require('./config');
const { registerCronJobs } = require('./tasks/cron');

const db = initDatabase();

// 後臺記憶管線（Archivist 自主迴圈 + Scribe + 每日任務）。
// 只掛路由不啟管線的話，庫不會自己長：訊息進來沒人提取、碎片沒人分類、星座不增加。
registerCronJobs();

const app = express();
app.set('trust proxy', 1);

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'memory-constellations-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── CSRF ──
const csrf = require('csrf');
const tokens = new csrf();
app.set('generateCsrfToken', (req, res) => {
  const secret = tokens.secretSync();
  if (req.session) req.session.csrfSecret = secret;
  return tokens.create(secret);
});

// ── Simple auth middleware ──
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  if (req.path === '/login') return next();
  if (req.method === 'POST' && req.path === '/login') return next();
  res.redirect('/login');
};

// ── Login ──
app.get('/login', (req, res) => {
  // 用 root 形式：express 5 / Windows 下直接傳絕對路徑會 404
  res.sendFile('login.html', { root: __dirname });
});
app.post('/login', (req, res) => {
  if (req.body.password === process.env.LOGIN_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/memory.html');
  }
  res.status(401).send('Wrong password');
});
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Memory page (主頁面) ──
app.get('/memory.html', requireAuth, (req, res) => {
  const memoryConfig = require('./memory_config.json');
  const csrfToken = req.app.get('generateCsrfToken')(req, res);
  const html = require('fs').readFileSync(path.join(__dirname, 'memory.html'), 'utf8');
  const configScript = `<script>window.MEMORY_UI_CONFIG = ${JSON.stringify({
    user: { name: memoryConfig.user.name, color: memoryConfig.ui.user_color },
    ai:   { name: memoryConfig.ai.name,   color: memoryConfig.ui.ai_color },
  })};</script>`;
  const injected = html
    .replace('</head>', `<meta name="csrf-token" content="${csrfToken}">\n${configScript}\n</head>`);
  res.type('html').send(injected);
});

// ── Memory API ──
// 注意：memory-api.js 內部寫的是完整路徑（'/api/memory/...'），這裡不能再加字首，
// 否則實際路徑會變成 /api/memory/api/memory/...，前端全部 404。
app.use(require('./routes/memory-api'));

// ── Chat ingest API（接收外部機器人訊息，攢記憶）──
app.use('/api', require('./routes/ingest'));

// ── Memory recall API（外部機器人回覆前查記憶）──
app.use('/api', require('./routes/recall'));

// ── Import/Export API（memory.html 前端匯入匯出）──
app.use('/api', require('./routes/import'));

// ── Root redirect ──
app.get('/', requireAuth, (req, res) => res.redirect('/memory.html'));

// ── 靜態資源（放在路由之後 + 要求已登入）──
// 以前這一行註冊在最前面且沒有鑑權，等於把整個專案目錄對外開放：
// 未登入就能下載 sanctuary.db / sanctuary.db-wal（整個記憶庫）和 memory_config.json。
// 現在必須先通過 requireAuth；登入頁由上面的 /login 路由直接傳送，不經過這裡。
const staticDir = express.static(path.join(__dirname), { index: false, dotfiles: 'deny' });
app.use(requireAuth, staticDir);

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Memory Constellations running at http://localhost:${PORT}/memory.html`);
});
