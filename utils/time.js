// =================================================================
// 時間工具函式（某城市時區 UTC+8）
// =================================================================

const getShanghaiTime = () => {
    try {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const shanghaiTime = new Date(utc + (8 * 3600000));
        
        const year = shanghaiTime.getFullYear();
        const month = String(shanghaiTime.getMonth() + 1).padStart(2, '0');
        const day = String(shanghaiTime.getDate()).padStart(2, '0');
        const hour = String(shanghaiTime.getHours()).padStart(2, '0');
        const minute = String(shanghaiTime.getMinutes()).padStart(2, '0');
        const second = String(shanghaiTime.getSeconds()).padStart(2, '0');
        
        return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    } catch (error) {
        console.error('getShanghaiTime failed:', error);
        return new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).replace(/\//g, '-').replace(/,/g, '');
    }
};

const getTimeOfDay = () => {
    try {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const shanghaiTime = new Date(utc + (8 * 3600000));
        const hour = shanghaiTime.getHours();
        
        if (hour >= 5 && hour < 11) return '早上';
        if (hour >= 11 && hour < 13) return '中午';
        if (hour >= 13 && hour < 17) return '下午';
        if (hour >= 17 && hour < 19) return '傍晚';
        if (hour >= 19 && hour < 23) return '晚上';
        return '深夜';
    } catch (error) {
        console.error('getTimeOfDay failed:', error);
        return '';
    }
};

// ── 寫庫用的時間：必須和 SQLite 的 datetime('now') 同格式 ──
// datetime('now') 是 UTC 的 "YYYY-MM-DD HH:MM:SS"（空格分隔、不帶 Z）。
// 別用 new Date().toISOString()——那是 "2026-09-15T13:00:00.000Z"，
// 跟 datetime('now') 做字串比較時，會在第 11 個字元上按 'T'(0x54) vs ' '(0x20) 分出勝負，
// 同一天的時間於是被靜默地當成"更晚"，誤差最多一天，而且一句報錯都沒有。
// 一列裡混進兩種格式之後，就再也沒法回答"這列到底是什麼單位"——所以寫入口統一放這裡。
const DAY_MS = 24 * 3600 * 1000;

/** N 毫秒前，SQLite datetime('now') 同格式（UTC） */
const sqlTimeAgo = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);

/** 當前時間，同上格式 */
const sqlNow = () => sqlTimeAgo(0);

/** N 天前，同上格式——用來跟 datetime('now', '-N days') 對齊 */
const sqlDaysAgo = (days) => sqlTimeAgo(days * DAY_MS);

/** N 毫秒後，同上格式（有效期上限之類的未來時間點） */
const sqlTimeAhead = (ms) => sqlTimeAgo(-ms);

/**
 * 解析 DB 存的時間字串。SQLite 的 datetime('now') 與本專案寫庫工具（sqlNow 等）產生的
 * 'YYYY-MM-DD HH:MM[:SS]'（無時區標記）是 UTC；直接 new Date() 會被當成伺服器本地時間，
 * 非 UTC 時區的天數／時段就會偏差。無時區標記者一律補 Z 以 UTC 解析；純日期 'YYYY-MM-DD' 視為 UTC 當天 00:00；
 * 已帶時區（Z 或 ±hh:mm）、數字（epoch）、Date 物件則照原樣處理。無法解析時回傳 Invalid Date。
 */
function parseDbTime(label) {
    if (label instanceof Date) return label;
    if (typeof label === 'string') {
        const s = label.trim();
        const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
        if (m) return new Date(`${m[1]}T${m[2]}Z`);
        const d = s.match(/^(\d{4}-\d{2}-\d{2})$/);
        if (d) return new Date(`${d[1]}T00:00:00Z`);
        return new Date(s);
    }
    return new Date(label);
}

/** parseDbTime 的毫秒值；無法解析回傳 NaN（呼叫端自行決定預設） */
const dbTimeMs = (label) => parseDbTime(label).getTime();

module.exports = { parseDbTime, dbTimeMs, getShanghaiTime, getTimeOfDay, sqlNow, sqlTimeAgo, sqlDaysAgo, sqlTimeAhead, DAY_MS };