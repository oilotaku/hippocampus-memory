// =================================================================
// tasks/cron.js — 後臺記憶管線排程
//
// 記憶管線不是請求驅動的：Scribe 要在沉默期後回掃訊息，Archivist 要每 2 分鐘
// 走一次自主迴圈，主角的每日日誌要按天寫。這些都不會被某次 HTTP 請求帶起來，
// 必須有人定期去問一次——就是這裡。
//
// ⚠️ 註冊順序有講究：`archivist.start()` 只調一次，它自己管 2 分鐘 tick 和
// 「Scribe 寫完碎片」的事件監聽；其餘都是「定期去問一次」的定時器，觸發條件
// （沉默 ≥20 分鐘 / 積壓條數）在各自的 checkAndRun* 內部判斷，這裡不要重複實現。
// =================================================================

const cron = require('node-cron');

// 時區統一走 TZ 環境變數（docker-compose 裡已設）。不設就用系統時區——
// generateDailyEntityStatus 判「昨天」用的也是同一套口徑，別在這兒單獨寫死。
const TZ = process.env.TZ;
const TZ_OPT = TZ ? { timezone: TZ } : {};

let registered = false;

function registerCronJobs() {
    if (registered) return;
    registered = true;

    const { start: startArchivist } = require('../services/archivist');

    // ── Archivist Agent：自主迴圈（2min tick + 事件驅動）──
    // 啟動即生效，不是定時任務；沒這一步後面的 Scribe/分類/整合都不會發生。
    startArchivist()
        .then(() => console.log('[Cron] Archivist Agent started (2min tick loop + event-driven)'))
        .catch(err => console.error('[Cron] Archivist Agent start error:', err));

    // ── Scribe：每 5 分鐘去問一次「該不該提取了」──
    // 門檻（沉默 ≥20min + 積壓 ≥60 條，或積壓 ≥100 條）在 checkAndRunScribe 裡面，
    // 這裡只負責定期敲門。掛在自己的 cron 上、不要串進別的 tick——上游踩過：
    // 排在一串會 return 的閘門後面時，兜底那句「超過 N 小時也跑」可能永遠輪不到執行。
    cron.schedule('*/5 * * * *', () => {
        require('../services/scribe').checkAndRunScribe().catch(err => {
            console.error('[Cron] Scribe error:', err.message);
        });
    }, TZ_OPT);
    console.log('[Cron] Scribe registered: every 5 minutes');

    // ── 每日主角狀態：寫主角星座的「X月X日：…」日誌行 ──
    // 主角不在 regenerateEntityOverviews 的掃描範圍裡（SKIP_NAMES），這一條是她
    // current_status 的唯一寫入方。
    cron.schedule('0 3 * * *', () => {
        require('../services/archivist').generateDailyEntityStatus().catch(err => {
            console.error('[Cron] Daily entity status error:', err.message);
        });
    }, TZ_OPT);
    console.log('[Cron] Daily entity status registered: 03:00');

    // ── 生命週期引擎：碎片冷卻/凍結/清空、episode 衰減 ──
    cron.schedule('47 4 * * *', () => {
        require('../services/lifecycle').runLifecycleMaintenance().catch(err => {
            console.error('[Cron] Lifecycle maintenance error:', err.message);
        });
    }, TZ_OPT);
    console.log('[Cron] Lifecycle maintenance registered: 04:47');
}

module.exports = { registerCronJobs };
