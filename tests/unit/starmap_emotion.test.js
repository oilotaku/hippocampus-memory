// H1 情緒上色純函式（js/memory/emotion.js 是 ES module，用動態 import 載入）
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let E;
test.before(async () => {
    E = await import(pathToFileURL(path.join(__dirname, '..', '..', 'js', 'memory', 'emotion.js')).href);
});

const zero = () => Object.fromEntries(E.EMOTION_DIMS.map(d => [d, 0]));

test('主導情緒：扣 0.2 底噪後最大者', () => {
    assert.strictEqual(E.NOISE_FLOOR, 0.2);
    const d = E.dominantEmotion({ ...zero(), joy: 0.5, sadness: 0.7, trust: 0.3 });
    assert.strictEqual(d.dim, 'sadness');
    assert.ok(Math.abs(d.net - 0.5) < 1e-9);
    assert.strictEqual(d.raw, 0.7);
});

test('主導情緒：全部在底噪以下（含剛好 0.2）→ null；沒資料 → null', () => {
    assert.strictEqual(E.dominantEmotion({ ...zero(), joy: 0.2, anger: 0.15 }), null);
    assert.strictEqual(E.dominantEmotion(zero()), null);
    assert.strictEqual(E.dominantEmotion(null), null);
    assert.strictEqual(E.dominantEmotion(undefined), null);
    assert.strictEqual(E.dominantEmotion('joy'), null);
});

test('主導情緒：平手取八維順序在前者；非數值維度略過', () => {
    assert.strictEqual(E.dominantEmotion({ ...zero(), anger: 0.6, joy: 0.6 }).dim, 'joy');
    assert.strictEqual(E.dominantEmotion({ joy: 'x', fear: 0.5 }).dim, 'fear');
});

test('色彩對照表：八種情緒、Plutchik 慣用色相，且彼此不同', () => {
    const hues = {};
    for (const d of E.EMOTION_DIMS) {
        const [r, g, b] = E.hexToRgb(E.EMOTION_INFO[d].hex);
        assert.ok(E.EMOTION_INFO[d].label.length >= 2);
        hues[d] = { r, g, b };
    }
    assert.strictEqual(new Set(E.EMOTION_DIMS.map(d => E.EMOTION_INFO[d].hex)).size, 8);
    const h = hues;
    assert.ok(h.joy.r > 200 && h.joy.g > 180 && h.joy.b < 120, '喜悅＝黃');
    assert.ok(h.trust.g > h.trust.r && h.trust.g > 200, '信任＝淺綠');
    assert.ok(h.fear.g > h.fear.r && h.fear.g > h.fear.b && h.fear.g < 200, '恐懼＝深綠（比信任暗）');
    assert.ok(h.surprise.b > 200 && h.surprise.g > 180 && h.surprise.r < 100, '驚訝＝青');
    assert.ok(h.sadness.b > 220 && h.sadness.r < 100, '悲傷＝藍');
    assert.ok(h.disgust.b > h.disgust.g && h.disgust.r > h.disgust.g, '厭惡＝紫');
    assert.ok(h.anger.r > 220 && h.anger.g < 100, '憤怒＝紅');
    assert.ok(h.anticipation.r > 220 && h.anticipation.g > 120 && h.anticipation.b < 100, '期待＝橙');
    // 深色背景上可辨識：每種顏色的相對亮度不能太低
    for (const d of E.EMOTION_DIMS) {
        const { r, g, b } = hues[d];
        assert.ok(0.2126 * r + 0.7152 * g + 0.0722 * b > 70, d + ' 在深色背景上太暗');
    }
});

test('emotionColor：色調由主導情緒決定，強度愈高愈飽和', () => {
    const weak = E.emotionColor({ ...zero(), anger: 0.3 }, 0.1);
    const strong = E.emotionColor({ ...zero(), anger: 0.9 }, 0.7);
    assert.strictEqual(weak.dim, 'anger');
    assert.strictEqual(strong.dim, 'anger');
    assert.ok(strong.strength > weak.strength);
    assert.ok(strong.rgb[0] > weak.rgb[0], '愈強愈接近紅');
    assert.ok(strong.rgb[1] < weak.rgb[1], '愈強綠色愈少（愈不灰）');
    // 滿強度就是表定的顏色
    const full = E.emotionColor({ ...zero(), joy: 1 }, 0.8);
    assert.deepStrictEqual(full.rgb, E.hexToRgb(E.EMOTION_INFO.joy.hex));
    assert.strictEqual(full.strength, 1);
    assert.strictEqual(full.neutral, false);
});

test('intensity 為 0／null／底噪內 → 中性灰且較暗', () => {
    const lum = c => c.rgb[0] + c.rgb[1] + c.rgb[2];
    const base = E.NEUTRAL_RGB[0] + E.NEUTRAL_RGB[1] + E.NEUTRAL_RGB[2];
    for (const c of [E.emotionColor({ ...zero(), joy: 0.9 }, 0), E.emotionColor(null, null), E.emotionColor(undefined, 0.5), E.emotionColor({ ...zero(), joy: 0.1 }, null)]) {
        assert.strictEqual(c.neutral, true);
        assert.strictEqual(c.dim, null);
        assert.ok(lum(c) < base, '比中性灰基準更暗');
        assert.ok(Math.max(...c.rgb) - Math.min(...c.rgb) < 40, '灰階');
    }
});

test('intensity 缺值時退回主導情緒的淨分數', () => {
    const c = E.emotionColor({ ...zero(), sadness: 0.8 }, null);
    assert.strictEqual(c.dim, 'sadness');
    assert.ok(c.strength > 0.9);
});

test('starRgb：星系模式回傳原色，情緒模式回傳情緒色', () => {
    const star = { emotion: { ...zero(), trust: 0.7 }, intensity: 0.5 };
    assert.deepStrictEqual(E.starRgb(star, 'galaxy', [1, 2, 3]), [1, 2, 3]);
    assert.deepStrictEqual(E.starRgb(star, undefined, [1, 2, 3]), [1, 2, 3]);
    assert.strictEqual(E.emotionColor(star.emotion, star.intensity).dim, 'trust');
    assert.deepStrictEqual(E.starRgb(star, 'emotion', [1, 2, 3]), E.emotionColor(star.emotion, star.intensity).rgb);
    assert.strictEqual(E.emotionRgbString(star.emotion, star.intensity), E.emotionColor(star.emotion, star.intensity).rgb.join(','));
});

test('上色偏好的 localStorage 讀寫包 try/catch：壞掉的 storage 不丟例外', () => {
    const mem = {}; const ok = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
    assert.strictEqual(E.loadColorMode(ok), 'galaxy');
    E.saveColorMode('emotion', ok);
    assert.strictEqual(mem[E.COLOR_MODE_KEY], 'emotion');
    assert.strictEqual(E.loadColorMode(ok), 'emotion');
    mem[E.COLOR_MODE_KEY] = '亂寫';
    assert.strictEqual(E.loadColorMode(ok), 'galaxy');
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.strictEqual(E.loadColorMode(broken), 'galaxy');
    assert.doesNotThrow(() => E.saveColorMode('emotion', broken));
});
