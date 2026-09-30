// =================================================================
// Scribe prompt 的情緒片段：emotion.enabled=false 時兩段都是空字串（prompt 與功能上線前逐字相同）
// =================================================================
const { isEnabled } = require('./config');

const FIELDS = `
      "emotions": {"anger": 0.8, "sadness": 0.5},
      "event_at": "YYYY-MM-DD 或 YYYY-MM 或 null",`;

const RULES = `## emotions 與 event_at（每條 entry 都要填）

emotions：這條事實裡使用者本人的情緒。八個維度各 0～1，彼此獨立、可同時偏高（例：期待與恐懼並存）：喜悅 joy／信任 trust／恐懼 fear／驚訝 surprise／悲傷 sadness／厭惡 disgust／憤怒 anger／期待 anticipation。
- 只寫高於 0.2 的維度（0.2 以下是底噪，一律省略）；明顯感受到的給 0.5 以上，極端給 0.8 以上。
- 沒有明顯情緒（純事實、日常流水）就寫 {}。

event_at：只有這條事實描述「某件特定事件」，而且能指出它發生（或將發生）的日期時才填，依訊息時間戳換算成 YYYY-MM-DD。
- 例（訊息時間 2026-05-02）：「下個月十五號去東京」→ "2026-06-15"；「昨天吵架」→ "2026-05-01"；只知道月份 → "2026-06"。
- 日常狀態、偏好、習慣、個人資料（例：今天有點涼、住在三重、對花生過敏、在學日文）一律填 null，不要拿訊息日期充數。

`;

const fields = () => (isEnabled() ? FIELDS : '');
const rules = () => (isEnabled() ? RULES : '');

module.exports = { fields, rules, FIELDS, RULES };
