// pm2 程序配置 —— `pm2 start ecosystem.config.js`
//
// 記憶管線是常駐後臺迴圈（Archivist 每 2 分鐘一個 tick，Scribe 每 5 分鐘敲門），
// 所以要用 pm2 這類程序管理器跑，別掛在某個請求上。
// .env 由 index.js 裡的 dotenv 讀取，cwd 就是本目錄，不用另外配。
module.exports = {
  apps: [{
    name: 'memory-constellations',
    script: 'index.js',
    // 崩潰保護：指數退避 + 上限停止，避免壞配置下無限重啟刷日誌
    min_uptime: 10000,               // 10 秒內崩潰視為不穩定
    max_restarts: 10,                // 10 次不穩定重啟後永久停止
    restart_delay: 3000,             // 最短間隔 3 秒
    exp_backoff_restart_delay: 5000, // 首次等 5 秒，之後翻倍
    // SIGKILL 延遲放寬到 12 秒：給 SQLite 留出 WAL checkpoint 的時間
    // （預設 1600ms 太短，程序被硬殺時容易留下 -wal/-shm 殘留）
    kill_timeout: 12000,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
