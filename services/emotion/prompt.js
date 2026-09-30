// =================================================================
// Scribe prompt 的情緒片段：emotion.enabled=false 時兩段都是空字串（prompt 與功能上線前逐字相同）
// =================================================================
const { isEnabled } = require('./config');

const FIELDS = `
      "emotions": {"joy": 0.0, "trust": 0.0, "fear": 0.0, "surprise": 0.0, "sadness": 0.0, "disgust": 0.0, "anger": 0.0, "anticipation": 0.0},
      "event_at": "YYYY-MM-DD 或 YYYY-MM 或 null",`;

const RULES = `## emotions 與 event_at（每條 entry 都要填）

emotions：這條事實裡使用者本人的情緒，八維各 0～1，彼此獨立、可同時偏高（例：期待與恐懼並存）。
- 喜悅 joy／信任 trust／恐懼 fear／驚訝 surprise／悲傷 sadness／厭惡 disgust／憤怒 anger／期待 anticipation。
- 沒被觸發的維度給 0.1～0.2（不要全填 0）；只有明顯感受到的才給 0.5 以上；極端才給 0.8 以上。
- 八個鍵都要寫。

event_at：事件本身發生（或將發生）的日期，依訊息時間戳換算成 YYYY-MM-DD（例：訊息 2026-05-02 說「下個月去東京」→ 只能確定月份就填 "2026-06"）。推不出來、或只是日常狀態就填 null。

`;

const fields = () => (isEnabled() ? FIELDS : '');
const rules = () => (isEnabled() ? RULES : '');

module.exports = { fields, rules, FIELDS, RULES };
