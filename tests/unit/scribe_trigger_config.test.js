'use strict';
// Scribe 觸發門檻可由 memory_config.json scribe.* 設定（scribeConfig.js）
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setScribeConfigOverride, getScribeConfig } = require('../../services/hippocampus/entorhinal/scribeConfig');

afterEach(() => setScribeConfigOverride(null));

test('預設門檻與原本寫死的值相同', () => {
    setScribeConfigOverride({});
    const c = getScribeConfig();
    assert.deepEqual(
        [c.silence_minutes, c.min_messages, c.force_messages, c.stale_hours, c.stale_min_messages],
        [20, 60, 100, 4, 30]);
});

test('可調低；非法值回退預設', () => {
    setScribeConfigOverride({ silence_minutes: 10, min_messages: 10, force_messages: 40, stale_hours: 2, stale_min_messages: 6 });
    const c = getScribeConfig();
    assert.deepEqual([c.silence_minutes, c.min_messages, c.force_messages, c.stale_hours, c.stale_min_messages], [10, 10, 40, 2, 6]);
    setScribeConfigOverride({ min_messages: 0, stale_hours: -1, silence_minutes: '5' });
    const d = getScribeConfig();
    assert.deepEqual([d.min_messages, d.stale_hours, d.silence_minutes], [60, 4, 20]);
});
