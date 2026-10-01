'use strict';
// 時間因子特性測試：釘住 timeFactorParts／memoryAgeDays 與搬移前 librarian 公式逐位元相同。
// 參考實作逐字抄自搬移前的 librarian.js（getDecayLambda／segmentedDecay／long_term×0.4／recencyBoost）。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { timeFactorParts } = require('../../services/hippocampus/ca3/decay');
const { memoryAgeDays } = require('../../services/hippocampus/entorhinal/timing');
const { setupEnv, cleanupDb } = require('./_helpers');
const dbPath = setupEnv('ca3-decay');
const { daysAgo } = require('../../services/hippocampus/ca3/librarian');
after(() => cleanupDb(dbPath));

function refLambda(emotionalWeight) {
  const ew = emotionalWeight || 0.5;
  if (ew >= 0.8) return 0.005;
  if (ew >= 0.6) return 0.01;
  if (ew >= 0.4) return 0.02;
  return 0.04;
}
function refSegmented(days, emotionalWeight) {
  const ew = emotionalWeight || 0.5;
  const timeDecay = Math.exp(-refLambda(ew) * days);
  const emotionRetention = 0.3 + ew * 0.7;
  if (days <= 3) return 0.7 * timeDecay + (1 - 0.7) * emotionRetention;
  return (1 - 0.7) * timeDecay + 0.7 * emotionRetention;
}
function refParts(days, ew, intent) {
  const actualDays = intent === 'long_term' ? days * 0.4 : days;
  const decay = refSegmented(actualDays, ew);
  const recencyBoost = days <= 1 ? 1.3 : days <= 3 ? 1.15 : days <= 7 ? 1.05 : 1.0;
  return { decay, recencyBoost };
}

test('timeFactorParts：手算錨點', () => {
  // days=0, ew=0.5：timeDecay=1，emotionRetention=0.65 → 0.7*1 + 0.3*0.65
  const p = timeFactorParts({ days: 0, ew: 0.5, intent: 'general' });
  assert.equal(p.decay, 0.7 * 1 + 0.3 * 0.65);
  assert.equal(p.recencyBoost, 1.3);
});

test('timeFactorParts：與原公式逐位元相同（含 long_term、缺值 ew）', () => {
  const dayList = [0, 0.5, 1, 1.0001, 3, 3.5, 7, 7.2, 30, 365];
  const ewList = [undefined, 0, 0.1, 0.39, 0.4, 0.5, 0.6, 0.8, 1];
  for (const intent of ['general', 'long_term', undefined]) {
    for (const days of dayList) {
      for (const ew of ewList) {
        const got = timeFactorParts({ days, ew, intent });
        const want = refParts(days, ew, intent);
        assert.equal(got.decay, want.decay, `decay days=${days} ew=${ew} intent=${intent}`);
        assert.equal(got.recencyBoost, want.recencyBoost, `boost days=${days} ew=${ew} intent=${intent}`);
      }
    }
  }
});

test('timeFactorParts：recencyBoost 階梯用未縮放的 days（long_term 不影響）', () => {
  assert.equal(timeFactorParts({ days: 2, ew: 0.5, intent: 'long_term' }).recencyBoost, 1.15);
  assert.equal(timeFactorParts({ days: 5, ew: 0.5, intent: 'general' }).recencyBoost, 1.05);
  assert.equal(timeFactorParts({ days: 8, ew: 0.5, intent: 'general' }).recencyBoost, 1.0);
});

test('memoryAgeDays：缺值／無效回 365，未來日期夾到 0', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  assert.equal(memoryAgeDays(null, now), 365);
  assert.equal(memoryAgeDays(undefined, now), 365);
  assert.equal(memoryAgeDays('', now), 365);
  assert.equal(memoryAgeDays('not-a-date', now), 365);
  assert.equal(memoryAgeDays('2026-02-01 00:00:00', now), 0);
});

test('memoryAgeDays：DB 無時區字串視為 UTC，now 可注入', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  assert.equal(memoryAgeDays('2026-01-08 00:00:00', now), 2);
  assert.equal(memoryAgeDays('2026-01-09 12:00:00', now), 0.5);
});

test('librarian.daysAgo 是 memoryAgeDays 的薄包裝', () => {
  assert.equal(daysAgo(null), 365);
  assert.equal(daysAgo('not-a-date'), 365);
  const d = daysAgo(new Date(Date.now() - 86400000 * 2).toISOString());
  assert.ok(d >= 2 && d < 2.01);
});
