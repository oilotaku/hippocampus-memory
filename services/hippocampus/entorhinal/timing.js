// =================================================================
// 記憶年齡的唯一來源：「這則記憶多老了」都從這裡取。
// 目前回傳牆鐘天數；之後的主觀時間模型（注意力閘門／pacemaker、
// 外側內嗅皮質的經驗式時間）從這裡接入，呼叫端不必改。
// =================================================================
const { parseDbTime } = require('../../../utils/time');

// parseDbTime：DB 的無時區時間字串是 UTC，見 utils/time.js
// 缺值或無效日期回 365；未來日期夾到 0。now：毫秒時間戳（預設現在）
function memoryAgeDays(dateLabel, now = Date.now()) {
  if (!dateLabel) return 365;
  try {
    const d = parseDbTime(dateLabel);
    if (isNaN(d.getTime())) return 365;
    return Math.max(0, (now - d.getTime()) / (1000 * 60 * 60 * 24));
  } catch { return 365; }
}

module.exports = { memoryAgeDays };
