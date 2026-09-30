// 4D 星圖排版與時間軸純函式測試（js/memory/layout3d.js 是 ES module，用動態 import 載入）
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let L;
test.before(async () => {
    L = await import(pathToFileURL(path.join(__dirname, '..', '..', 'js', 'memory', 'layout3d.js')).href);
});

const GALAXIES = [
    { id: '愛好', azimuth: -90 }, { id: '社交', azimuth: -18 }, { id: '創作', azimuth: 54 },
    { id: '事件', azimuth: 126 }, { id: '地點', azimuth: 198 },
];

function makeInput() {
    const constellations = [];
    let sid = 1;
    GALAXIES.forEach((g, gi) => {
        for (let k = 0; k < 4 + gi; k++) {
            const n = 3 + ((gi * 7 + k * 5) % 30);
            const stars = [];
            for (let i = 0; i < n; i++) stars.push({ id: 'f' + (sid++) });
            constellations.push({ id: `e${gi * 10 + k + 1}`, galaxyId: g.id, stars });
        }
    });
    const bridges = [
        { a: 'e1', b: 'e2', weight: 4 }, { a: 'e2', b: 'e3', weight: 2 },
        { a: 'e11', b: 'e12', weight: 5 }, { a: 'e1', b: 'e11', weight: 3 },   // 跨星系
        { a: 'e21', b: 'e22', weight: 1 },
    ];
    return { galaxies: GALAXIES, constellations, bridges };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clone = (x) => JSON.parse(JSON.stringify(x));

test('同樣輸入兩次輸出完全相同（穩定）', () => {
    const a = L.computeLayout3D(makeInput());
    const b = L.computeLayout3D(clone(makeInput()));
    assert.deepStrictEqual(a, b);
    assert.ok(Object.keys(a.stars).length > 100);
});

test('輸入順序不影響結果', () => {
    const inp = makeInput();
    const rev = clone(inp);
    rev.constellations.reverse();
    rev.constellations.forEach(c => c.stars.reverse());
    const a = L.computeLayout3D(inp);
    const b = L.computeLayout3D(rev);
    assert.deepStrictEqual(a.cons, b.cons);
    for (const k of Object.keys(a.stars)) {
        assert.ok(dist(a.stars[k], b.stars[k]) < 1e-9, k);
    }
});

test('新增一顆星：其他星位移很小（給上限）', () => {
    const inp = makeInput();
    const before = L.computeLayout3D(inp);
    const inp2 = clone(inp);
    inp2.constellations[3].stars.push({ id: 'f99999' });
    const after = L.computeLayout3D(inp2);
    let maxD = 0, sum = 0, n = 0;
    for (const k of Object.keys(before.stars)) {
        const d = dist(before.stars[k], after.stars[k]);
        sum += d; n++;
        if (d > maxD) maxD = d;
    }
    // 星座半徑約 3~8。新增一顆星只會讓該星座的高斯 σ 微幅變大（半徑隨 sqrt(星數)），
    // 所以位移上限取 0.5 個單位、全體平均更小；別的星座的星完全不動。
    assert.ok(maxD < 0.5, `最大位移 ${maxD}`);
    assert.ok(sum / n < 0.05, `平均位移 ${sum / n}`);
    // 其他星座的中心位置不變（星座半徑變化只影響同星座）
    const cid = inp.constellations[3].id;
    for (const id of Object.keys(before.cons)) {
        if (id === cid) continue;
        assert.ok(dist(before.cons[id], after.cons[id]) < 3, `星座 ${id} 漂移`);
    }
});

test('沒有兩顆星距離小於下限', () => {
    const lay = L.computeLayout3D(makeInput());
    const keys = Object.keys(lay.stars);
    let minD = Infinity;
    for (let i = 0; i < keys.length; i++)
        for (let j = i + 1; j < keys.length; j++)
            minD = Math.min(minD, dist(lay.stars[keys[i]], lay.stars[keys[j]]));
    assert.ok(minD >= L.DEFAULTS.starMinDist * 0.9, `最小距離 ${minD}`);
});

test('星座彼此不重疊（中心距 >= 半徑和的 0.8）', () => {
    const lay = L.computeLayout3D(makeInput());
    const cons = Object.values(lay.cons);
    for (let i = 0; i < cons.length; i++)
        for (let j = i + 1; j < cons.length; j++) {
            if (cons[i].galaxyId !== cons[j].galaxyId) continue;
            assert.ok(dist(cons[i], cons[j]) >= (cons[i].r + cons[j].r) * 0.8,
                `${i}-${j} 太近 ${dist(cons[i], cons[j])}`);
        }
});

test('錨點被拉住：星座中心距星系錨點在星系半徑內；星在星座附近', () => {
    const lay = L.computeLayout3D(makeInput());
    for (const c of Object.values(lay.cons)) {
        const G = lay.galaxies[c.galaxyId];
        assert.ok(dist(c, G) <= G.r * 0.86 + 1e-6, `星座離錨點 ${dist(c, G)} > ${G.r}`);
    }
    for (const s of Object.values(lay.stars)) {
        const C = lay.cons[s.conId];
        assert.ok(dist(s, C) <= C.r * 2.2 + 2, `星離星座中心過遠 ${dist(s, C)}`);
    }
    // 星系錨點之間互相分開
    const gs = Object.values(lay.galaxies);
    for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) assert.ok(dist(gs[i], gs[j]) > 50);
});

test('橋當吸引力：有橋的星座對比沒橋時更近', () => {
    const inp = makeInput();
    const intra = { ...inp, bridges: inp.bridges.filter(b => !(b.a === 'e1' && b.b === 'e11')) };
    const withB = L.computeLayout3D(intra);
    const noB = L.computeLayout3D({ ...inp, bridges: [] });   // 只比較同星系內的橋
    // 同星系內有橋的幾對星座，總距離不會比沒橋時更遠（跨星系的橋另外只做輕微偏移，不列入）
    const pairs = [['e1', 'e2'], ['e2', 'e3'], ['e11', 'e12'], ['e21', 'e22']];
    const sum = (lay) => pairs.reduce((t, [a, b]) => t + dist(lay.cons[a], lay.cons[b]), 0);
    assert.ok(sum(withB) <= sum(noB) + 1e-6, `有橋 ${sum(withB)} vs 無橋 ${sum(noB)}`);
});

test('高斯抖動：同 id 同結果、不同 id 不同結果', () => {
    const r1 = L.mulberry32(L.strHash('a')), r2 = L.mulberry32(L.strHash('a'));
    assert.strictEqual(L.gaussian(r1), L.gaussian(r2));
    const xs = [];
    const r = L.mulberry32(7);
    for (let i = 0; i < 2000; i++) xs.push(L.gaussian(r));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    assert.ok(Math.abs(mean) < 0.1 && sd > 0.85 && sd < 1.1, `mean=${mean} sd=${sd}`);
});

test('空輸入不會丟例外', () => {
    const lay = L.computeLayout3D({ galaxies: [], constellations: [], bridges: [] });
    assert.deepStrictEqual(lay.stars, {});
});

// ── 時間軸 ──
const D = 86400000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const NOW = T0 + 100 * D;

test('parseSqlTime：SQLite UTC 時間字串', () => {
    assert.strictEqual(L.parseSqlTime('2026-01-01 00:00:00'), T0);
    assert.strictEqual(L.parseSqlTime('2026-01-01'), T0);
    assert.ok(Number.isNaN(L.parseSqlTime(null)));
    assert.ok(Number.isNaN(L.parseSqlTime('')));
});

test('timeRange：最早到最新，含 now，範圍不為 0', () => {
    const r = L.timeRange([{ createdMs: T0 + 5 * D }, { createdMs: T0 + 20 * D }, { createdMs: NaN }], NOW);
    assert.strictEqual(r.min, T0 + 5 * D);
    assert.strictEqual(r.max, NOW);
    const single = L.timeRange([{ createdMs: T0 }], T0);
    assert.ok(single.max > single.min);
    assert.ok(L.timeRange([], NOW).max > L.timeRange([], NOW).min);
});

test('filterVisible：只留那時已存在的星', () => {
    const stars = [{ id: 1, createdMs: T0 }, { id: 2, createdMs: T0 + 10 * D }, { id: 3, createdMs: T0 + 50 * D }];
    assert.deepStrictEqual(L.filterVisible(stars, T0 - 1).map(s => s.id), []);
    assert.deepStrictEqual(L.filterVisible(stars, T0 + 10 * D).map(s => s.id), [1, 2]);
    assert.deepStrictEqual(L.filterVisible(stars, NOW).map(s => s.id), [1, 2, 3]);
});

test('starStateAt：誕生前不可見、之後淡入', () => {
    const s = { createdMs: T0 + 10 * D, lifecycle: 'active' };
    assert.strictEqual(L.starStateAt(s, T0, NOW).visible, false);
    const half = L.starStateAt(s, s.createdMs + 1.5 * D, NOW, 3 * D);
    assert.ok(half.visible && Math.abs(half.fade - 0.5) < 1e-9);
    assert.strictEqual(L.starStateAt(s, s.createdMs + 10 * D, NOW, 3 * D).fade, 1);
});

test('starStateAt：最近被回憶的較亮', () => {
    const recent = { createdMs: T0, lastAccessedMs: NOW - D, lifecycle: 'active', readCount: 0 };
    const old = { createdMs: T0, lastAccessedMs: T0 + 2 * D, lifecycle: 'active', readCount: 0 };
    assert.ok(L.starStateAt(recent, NOW, NOW).glow > L.starStateAt(old, NOW, NOW).glow);
    // 被回憶之前的時間點，不能用「未來的回憶」提亮
    const before = L.starStateAt(recent, NOW - 30 * D, NOW);
    assert.ok(before.glow <= 1);
    // 回憶次數多的略亮
    const many = { ...old, readCount: 20 };
    assert.ok(L.starStateAt(many, NOW, NOW).glow > L.starStateAt(old, NOW, NOW).glow);
});

test('lifecycleAt：現在冷卻／凍結的星，依時間逐步變冷；現在活躍的永遠活躍', () => {
    const active = { createdMs: T0, lifecycle: 'active' };
    assert.strictEqual(L.lifecycleAt(active, NOW, NOW), 'active');
    const cooling = { createdMs: T0, lastAccessedMs: T0 + 5 * D, lifecycle: 'cooling' };
    assert.strictEqual(L.lifecycleAt(cooling, T0 + 6 * D, NOW), 'active');
    assert.strictEqual(L.lifecycleAt(cooling, NOW, NOW), 'cooling');
    const frozen = { createdMs: T0, lastAccessedMs: T0 + 5 * D, lifecycle: 'frozen' };
    assert.strictEqual(L.lifecycleAt(frozen, T0 + 6 * D, NOW), 'active');
    assert.strictEqual(L.lifecycleAt(frozen, T0 + 25 * D, NOW), 'cooling');
    assert.strictEqual(L.lifecycleAt(frozen, NOW, NOW), 'frozen');
});
