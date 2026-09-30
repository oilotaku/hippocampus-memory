// =================================================================
// 情緒引擎的時間工具：三種時間、時段、星期（依使用者當地時區）
// 資料庫內時間一律是 UTC 的 'YYYY-MM-DD HH:MM:SS'（與 datetime('now') 同格式）。
// =================================================================
const SLOTS = ['morning', 'noon', 'evening', 'night'];
const SLOT_LABELS = { morning: '早上', noon: '中午', evening: '晚上', night: '深夜' };

function validTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

// 'YYYY-MM-DD HH:MM[:SS]'／ISO／Date → Date（無時區標記者視為 UTC）
function parseUtc(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v !== 'string' || !v.trim()) return null;
    let s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += ' 00:00:00';
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    else s = s.replace(' ', 'T');
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function toSqlUtc(d) { return d.toISOString().replace('T', ' ').slice(0, 19); }

// 當地時間分解：{ year, month, day, hour, weekday(0=週日) }
function localParts(v, tz) {
    const d = parseUtc(v);
    if (!d) return null;
    const zone = validTz(tz) ? tz : 'Asia/Taipei';
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', weekday: 'short',
    }).formatToParts(d);
    const g = (t) => parts.find(p => p.type === t)?.value;
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year: +g('year'), month: +g('month'), day: +g('day'),
        hour: +g('hour') % 24, weekday: WD[g('weekday')],
    };
}

// 早上 05–11、中午 11–17、晚上 17–23、深夜 23–05
function slotOfHour(h) {
    if (h >= 5 && h < 11) return 'morning';
    if (h >= 11 && h < 17) return 'noon';
    if (h >= 17 && h < 23) return 'evening';
    return 'night';
}

function slotOf(v, tz) {
    const p = localParts(v, tz);
    return p ? slotOfHour(p.hour) : null;
}

function localDate(v, tz) {
    const p = localParts(v, tz);
    if (!p) return null;
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// 兩個時間相差幾小時（b − a）
function hoursBetween(a, b) {
    const da = parseUtc(a), db = parseUtc(b);
    if (!da || !db) return null;
    return (db.getTime() - da.getTime()) / 3600000;
}

module.exports = { SLOTS, SLOT_LABELS, validTz, parseUtc, toSqlUtc, localParts, slotOfHour, slotOf, localDate, hoursBetween };
