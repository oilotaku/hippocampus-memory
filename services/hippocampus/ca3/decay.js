// =================================================================
// 時間因子：把「記憶年齡 + 情緒權重 + 意圖」換成 { decay, recencyBoost }。
// 未來的對數時間衰減模型（log-time decay）從這裡接入；
// librarian 的排序迴圈只呼叫 timeFactorParts，不直接碰衰減公式。
// =================================================================

// 時間衰減：半衰期由 emotional_weight 決定
// ew ≥ 0.8 → λ=0.005 (140天半衰期)  重要記憶持久
// ew ≥ 0.6 → λ=0.01  (70天半衰期)   標準
// ew ≥ 0.4 → λ=0.02  (35天半衰期)   輕度記憶較快消退
// ew  < 0.4 → λ=0.04  (17天半衰期)   瑣碎資訊快速沉底
function getDecayLambda(emotionalWeight) {
  const ew = emotionalWeight || 0.5;
  if (ew >= 0.8) return 0.005;
  if (ew >= 0.6) return 0.01;
  if (ew >= 0.4) return 0.02;
  return 0.04;
}

// 分段衰減（Ombre Brain 啟發）：前3天新鮮度主導，3天後情緒強度主導
// 短線：timeWeight=0.7 emotionWeight=0.3 → 新鮮事優先浮現
// 長線：timeWeight=0.3 emotionWeight=0.7 → 高ew記憶頑強存活，低ew瑣碎快速沉底
const STM_TIME_WEIGHT = 0.7;     // ≤3天：時間新鮮度權重
const LTM_EMOTION_WEIGHT = 0.7;  // >3天：情緒強度權重
const SEGMENT_DAYS = 3;          // 分段切換天數

function segmentedDecay(days, emotionalWeight) {
  const ew = emotionalWeight || 0.5;
  const lambda = getDecayLambda(ew);
  // 純時間衰減
  const timeDecay = Math.exp(-lambda * days);
  // 情緒保留：越高ew記憶越不容易被時間沖淡
  const emotionRetention = 0.3 + ew * 0.7;

  if (days <= SEGMENT_DAYS) {
    // 短期：新鮮度為王。近期發生的事即使分量輕也值得浮現
    return STM_TIME_WEIGHT * timeDecay + (1 - STM_TIME_WEIGHT) * emotionRetention;
  }
  // 長期：情緒接管。3天後時間不再是最重要的——ew=0.8的記憶可能比ew=0.3的存活長4倍
  return (1 - LTM_EMOTION_WEIGHT) * timeDecay + LTM_EMOTION_WEIGHT * emotionRetention;
}

// days：記憶年齡（天，牆鐘）；ew：有效情緒權重；intent：檢索意圖
function timeFactorParts({ days, ew, intent }) {
  const actualDays = intent === 'long_term' ? days * 0.4 : days;  // long_term 意圖下時間走得慢
  const decay = segmentedDecay(actualDays, ew);
  // 時效加權：語義相近時，新記憶優先。≤1天的×1.3，≤3天×1.15，≤7天×1.05，之後無加成（用未縮放的 days）
  const recencyBoost = days <= 1 ? 1.3 : days <= 3 ? 1.15 : days <= 7 ? 1.05 : 1.0;
  return { decay, recencyBoost };
}

module.exports = { timeFactorParts };
