'use strict';
// =================================================================
// services/hippocampus/dentate/strength.js — 齒狀迴：編碼強度的唯一決策點
// =================================================================
// 一條記憶「寫進去時有多強」只在這裡決定：初始情緒權重、情緒強度換算權重、
// 重複出現時的證據累加步長。encode.js 與杏仁核寫入都從這裡取值，不各自寫死數字。
// 之後的編碼強度模型（間隔效應、提取練習、對數時間遺忘）直接擴充本檔，呼叫端不必改。

// 證據累加（同一事實再次出現）：confidence 每次 +CONFIDENCE_STEP，上限 CONFIDENCE_MAX；
// 既有碎片沒有 confidence 時以 CONFIDENCE_DEFAULT 起算
const CONFIDENCE_STEP = 0.05;
const CONFIDENCE_MAX = 1.0;
const CONFIDENCE_DEFAULT = 0.5;

// 新碎片的初始 emotional_weight：模型有給就用（含 0），沒給退回 0.3
function initialWeight(entry) {
    return entry.emotional_weight ?? 0.3;
}

// 情緒強度換算 emotional_weight：下限 0.1。舊排序公式讀 emotional_weight，
// 且多處以 `|| 0.5` 當預設，0 會被當成缺值
function weightFromIntensity(intensity) {
    return Math.max(0.1, intensity);
}

module.exports = { initialWeight, weightFromIntensity, CONFIDENCE_STEP, CONFIDENCE_MAX, CONFIDENCE_DEFAULT };
