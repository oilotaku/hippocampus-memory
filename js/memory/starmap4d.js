// ========================================
// 記憶星圖 4D — three.js 渲染層（3D 空間 + 時間軸）
// 只在使用者切到 4D 時才動態載入（連同 three.js），2D 路徑完全不受影響。
// 位置來自 layout3d.js（力導向 + 高斯抖動，固定種子）；時間篩選見 layout3d 的 starStateAt。
// 效能：所有星是單一 Points（自訂 shader），橋與星座連線各是單一 LineSegments。
// ========================================

import * as THREE from 'three';
import { OrbitControls } from '/js/vendor/three/OrbitControls.js';
import {
    computeLayout3D, starStateAt, timeRange, parseSqlTime, mulberry32, strHash,
} from './layout3d.js';
import { GALAXIES, GALAXY_BY_ID, hslToRgbStr } from './data.js';

const DAY = 86400000;
const LIFE_ALPHA = { active: 1, consolidated: 1, cooling: 0.62, frozen: 0.4 };

const STAR_VS = `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aPhase;
uniform float uScale;
uniform float uTime;
uniform float uPulse;
uniform float uMinPx;
uniform float uMaxPx;
varying vec3 vColor;
varying float vAlpha;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pulse = 1.0 + uPulse * 0.14 * sin(uTime * 1.25 + aPhase);
    float px = aSize * pulse * uScale / max(0.001, -mv.z);
    gl_PointSize = clamp(px, uMinPx, uMaxPx);
    if (aSize <= 0.0 || aAlpha <= 0.001) gl_PointSize = 0.0;
    vColor = aColor;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * mv;
}`;
const STAR_FS = `
varying vec3 vColor;
varying float vAlpha;
void main() {
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.38, 0.0, d);
    float glow = pow(1.0 - d, 2.6) * 0.75;
    float a = (core + glow) * vAlpha;
    gl_FragColor = vec4(vColor * (0.55 + core * 0.9), a);
}`;
const HAZE_FS = `
varying vec3 vColor;
varying float vAlpha;
void main() {
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (d > 1.0) discard;
    float a = pow(1.0 - d, 2.2) * vAlpha;
    gl_FragColor = vec4(vColor, a);
}`;

function rgbOf(str) { const p = String(str || '150,170,255').split(',').map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255]; }
function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

export function webglSupported() {
    try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (_) { return false; }
}

/**
 * opts: { container, labelLayer, reducedMotion, onHover(item|null,x,y), onPickStar(item), onPickCon(conId), onPickGalaxy(id) }
 */
export function createStarMap4D(opts) {
    const container = opts.container;
    const reduced = !!opts.reducedMotion;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'default' });
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    renderer.domElement.id = 'gl';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 4000);
    camera.position.set(0, 120, 300);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 6;
    controls.maxDistance = 900;
    controls.autoRotate = !reduced;
    controls.autoRotateSpeed = 0.25;

    const uniforms = {
        uScale: { value: 800 }, uTime: { value: 0 }, uPulse: { value: reduced ? 0 : 1 },
        uMinPx: { value: 2.5 }, uMaxPx: { value: 64 },
    };
    const hazeUniforms = { ...uniforms, uMinPx: { value: 0 }, uMaxPx: { value: 700 }, uPulse: { value: 0 } };
    const mkMat = (fs, u) => new THREE.ShaderMaterial({
        vertexShader: STAR_VS, fragmentShader: fs, uniforms: u,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });

    // 資料狀態
    let items = [];          // 每顆星（星座內的一個實例）
    let cons = [];           // 星座 {id, label, x,y,z,r, rgb, first, last, galaxyId}
    let galaxies = [];       // 星系 {id, x,y,z,r, rgb}
    let bridgeList = [];     // [{ia, ib, w}] 索引 cons
    let layout = null;
    let range = { min: 0, max: 1 };
    let nowMs = Date.now();
    let curTime = Infinity;
    let hoverIdx = -1, selIdx = -1;
    let starPts = null, hazePts = null, bridgeLines = null, spokeLines = null;
    let starGeo, hazeGeo, bridgeGeo, spokeGeo;
    let visibleCount = 0;

    const labelEls = new Map();   // 'g:id' / 'c:id' / 'core' → element
    const labelLayer = opts.labelLayer;

    function mkLabel(key, text, cls, onClick) {
        let el = labelEls.get(key);
        if (!el) {
            el = document.createElement('div');
            labelLayer.appendChild(el);
            labelEls.set(key, el);
        }
        el.className = 'gl-label ' + cls;
        el.textContent = text;
        el.onclick = onClick || null;
        return el;
    }

    function disposeObjects() {
        for (const o of [starPts, hazePts, bridgeLines, spokeLines]) {
            if (o) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
        }
        starPts = hazePts = bridgeLines = spokeLines = null;
        for (const el of labelEls.values()) el.remove();
        labelEls.clear();
    }

    function setData(universe) {
        disposeObjects();
        nowMs = Date.now();
        const conList = universe.constellations || [];
        layout = computeLayout3D({
            galaxies: GALAXIES.map(g => ({ id: g.id, azimuth: g.azimuth })),
            constellations: conList.map(c => ({ id: c.id, galaxyId: c.galaxyLabel, stars: (c.stars || []).map(s => ({ id: s.id })) })),
            bridges: (universe.bridges || []).map(b => ({ a: b.a, b: b.b, weight: b.weight })),
        });

        // 星系
        galaxies = Object.entries(layout.galaxies).map(([id, g]) => {
            const def = GALAXY_BY_ID[id] || { hue: strHash(id) % 360 };
            return { id, x: g.x, y: g.y, z: g.z, r: g.r, rgb: rgbOf(hslToRgbStr(def.hue, 70, 62)) };
        });
        // 星座 + 星
        cons = []; items = [];
        const conIdx = new Map();
        for (const c of conList) {
            const L = layout.cons[c.id];
            if (!L) continue;
            const rgb = rgbOf(c.rgb);
            const ci = cons.length;
            conIdx.set(c.id, ci);
            const rec = { id: c.id, label: c.label, x: L.x, y: L.y, z: L.z, r: L.r, rgb, galaxyId: c.galaxyLabel, first: items.length, count: 0 };
            cons.push(rec);
            for (const s of c.stars || []) {
                const P = layout.stars[c.id + '|' + s.id];
                if (!P) continue;
                items.push({
                    idx: items.length, key: c.id + '|' + s.id, conId: c.id, ci, star: s,
                    x: P.x, y: P.y, z: P.z, rgb,
                    createdMs: parseSqlTime(s.createdAt || s.date),
                    lastAccessedMs: parseSqlTime(s.lastAccessedAt),
                    lifecycle: s.lifecycle || 'active',
                    readCount: s.readCount || 0,
                    baseSize: 3.4 + Math.max(0, Math.min(1, (6.5 - (s.mag || 4)) / 5.5)) * 3.0,
                    phase: (strHash(c.id + '|' + s.id) % 628) / 100,
                    alpha: 0,
                });
                rec.count++;
            }
        }
        bridgeList = [];
        for (const b of universe.bridges || []) {
            const ia = conIdx.get(b.a), ib = conIdx.get(b.b);
            if (ia !== undefined && ib !== undefined) bridgeList.push({ ia, ib, w: b.weight || 1 });
        }
        range = timeRange(items, nowMs);

        // ── star points ──
        const n = items.length;
        starGeo = new THREE.BufferGeometry();
        const pos = new Float32Array(n * 3);
        items.forEach((it, i) => { pos[i * 3] = it.x; pos[i * 3 + 1] = it.y; pos[i * 3 + 2] = it.z; });
        starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        starGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
        starGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
        starGeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
        starGeo.setAttribute('aPhase', new THREE.BufferAttribute(Float32Array.from(items.map(i => i.phase)), 1));
        starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        starPts = new THREE.Points(starGeo, mkMat(STAR_FS, uniforms));
        starPts.frustumCulled = false;
        starPts.renderOrder = 3;

        // ── haze（星系、星座、核心的柔光）──
        const hn = galaxies.length + cons.length + 1;
        hazeGeo = new THREE.BufferGeometry();
        const hp = new Float32Array(hn * 3), hc = new Float32Array(hn * 3), hs = new Float32Array(hn), ha = new Float32Array(hn), hph = new Float32Array(hn);
        let k = 0;
        for (const g of galaxies) { hp.set([g.x, g.y, g.z], k * 3); hc.set(g.rgb, k * 3); hs[k] = g.r * 2.4; ha[k] = 0.10; k++; }
        const conHazeBase = k;
        for (const c of cons) { hp.set([c.x, c.y, c.z], k * 3); hc.set(c.rgb, k * 3); hs[k] = c.r * 2.4; ha[k] = 0; k++; }
        hp.set([0, 0, 0], k * 3); hc.set([1, 0.85, 0.6], k * 3); hs[k] = 14; ha[k] = 0.55; k++;
        hazeGeo.setAttribute('position', new THREE.BufferAttribute(hp, 3));
        hazeGeo.setAttribute('aColor', new THREE.BufferAttribute(hc, 3));
        hazeGeo.setAttribute('aSize', new THREE.BufferAttribute(hs, 1));
        hazeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(ha, 1).setUsage(THREE.DynamicDrawUsage));
        hazeGeo.setAttribute('aPhase', new THREE.BufferAttribute(hph, 1));
        hazeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        hazePts = new THREE.Points(hazeGeo, mkMat(HAZE_FS, hazeUniforms));
        hazePts.frustumCulled = false;
        hazePts.renderOrder = 1;
        hazePts.userData.conHazeBase = conHazeBase;

        // ── 橋 ──
        bridgeGeo = new THREE.BufferGeometry();
        const bp = new Float32Array(bridgeList.length * 6), bc = new Float32Array(bridgeList.length * 6);
        bridgeList.forEach((b, i) => {
            const A = cons[b.ia], B = cons[b.ib];
            bp.set([A.x, A.y, A.z, B.x, B.y, B.z], i * 6);
        });
        bridgeGeo.setAttribute('position', new THREE.BufferAttribute(bp, 3));
        bridgeGeo.setAttribute('color', new THREE.BufferAttribute(bc, 3).setUsage(THREE.DynamicDrawUsage));
        bridgeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        bridgeLines = new THREE.LineSegments(bridgeGeo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
        }));
        bridgeLines.frustumCulled = false;
        bridgeLines.renderOrder = 2;

        // ── 星座中心 → 星 的細線（讓星座讀得出來是一群）──
        spokeGeo = new THREE.BufferGeometry();
        const sp = new Float32Array(n * 6), sc = new Float32Array(n * 6);
        items.forEach((it, i) => { const C = cons[it.ci]; sp.set([C.x, C.y, C.z, it.x, it.y, it.z], i * 6); });
        spokeGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
        spokeGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3).setUsage(THREE.DynamicDrawUsage));
        spokeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        spokeLines = new THREE.LineSegments(spokeGeo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
        }));
        spokeLines.frustumCulled = false;
        spokeLines.renderOrder = 2;

        scene.add(hazePts, spokeLines, bridgeLines, starPts);

        // ── 標籤 ──
        mkLabel('core', '雙星核心', 'gl-core');
        for (const g of galaxies) mkLabel('g:' + g.id, g.id + '星系', 'gl-galaxy', () => opts.onPickGalaxy && opts.onPickGalaxy(g.id));
        for (const c of cons) mkLabel('c:' + c.id, c.label, 'gl-con', () => opts.onPickCon && opts.onPickCon(c.id));

        // 第一次載入才擺相機；刷新資料時保留使用者視角
        if (!setData.cameraPlaced) {
            const R = Math.max(120, layout.radius);
            camera.position.set(R * 0.3, R * 0.6, R * 1.3);
            controls.target.set(0, 0, 0);
            camera.lookAt(controls.target);
            controls.maxDistance = R * 5;
            setData.cameraPlaced = true;
        }
        selIdx = -1; hoverIdx = -1;
        if (!Number.isFinite(curTime) || curTime === Infinity) curTime = range.max;
        curTime = Math.min(Math.max(curTime, range.min), range.max);
        applyTime(curTime);
    }

    // ── 時間 → 每顆星的外觀 ──
    const COOL_RGB = [0.45, 0.58, 0.85], FROZEN_RGB = [0.5, 0.55, 0.68];
    function applyTime(t) {
        curTime = t;
        if (!starGeo) return;
        const aC = starGeo.attributes.aColor, aS = starGeo.attributes.aSize, aA = starGeo.attributes.aAlpha;
        const fadeMs = Math.max(DAY, (range.max - range.min) * 0.04);
        const conVisible = new Uint32Array(cons.length);
        visibleCount = 0;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const st = starStateAt(it, t, nowMs, fadeMs);
            if (!st.visible) { aA.array[i] = 0; aS.array[i] = 0; it.alpha = 0; continue; }
            const la = LIFE_ALPHA[st.lifecycle] ?? 1;
            const alpha = st.fade * (0.5 + 0.5 * st.glow) * la;
            let rgb = it.rgb;
            if (st.lifecycle === 'cooling') rgb = mix3(it.rgb, COOL_RGB, 0.55);
            else if (st.lifecycle === 'frozen') rgb = mix3(it.rgb, FROZEN_RGB, 0.8);
            // 最近被回憶的星再多一點白（亮）
            rgb = mix3(rgb, [1, 1, 1], Math.min(0.5, st.glow * 0.45) * la);
            aC.array[i * 3] = rgb[0]; aC.array[i * 3 + 1] = rgb[1]; aC.array[i * 3 + 2] = rgb[2];
            let size = it.baseSize * (0.7 + 0.5 * st.glow) * (0.4 + 0.6 * st.fade);
            if (i === selIdx) size *= 1.9; else if (i === hoverIdx) size *= 1.5;
            aS.array[i] = size;
            aA.array[i] = Math.min(1, alpha + (i === selIdx || i === hoverIdx ? 0.35 : 0));
            it.alpha = alpha;
            conVisible[it.ci] += 1;
            visibleCount++;
        }
        aC.needsUpdate = aS.needsUpdate = aA.needsUpdate = true;

        // 星座柔光與細線
        const hA = hazeGeo.attributes.aAlpha, base = hazePts.userData.conHazeBase;
        for (let ci = 0; ci < cons.length; ci++) {
            const c = cons[ci];
            const frac = c.count ? conVisible[ci] / c.count : 0;
            hA.array[base + ci] = 0.13 * Math.min(1, frac * 1.5);
        }
        hA.needsUpdate = true;
        const sc = spokeGeo.attributes.color;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const a = it.alpha * 0.16;
            const r = it.rgb[0] * a, g = it.rgb[1] * a, b = it.rgb[2] * a;
            sc.array.set([r, g, b, r * 0.3, g * 0.3, b * 0.3], i * 6);
        }
        sc.needsUpdate = true;
        // 橋：兩端星座都已有星才出現
        const bcol = bridgeGeo.attributes.color;
        bridgeList.forEach((b, i) => {
            const A = cons[b.ia], B = cons[b.ib];
            const on = conVisible[b.ia] > 0 && conVisible[b.ib] > 0;
            // 跨星系的橋通常很長，畫淡一點，免得蓋過星星
            const cross = A.galaxyId !== B.galaxyId;
            const a = on ? Math.min(0.32, 0.08 + b.w * 0.04) * (cross ? 0.45 : 1) : 0;
            bcol.array.set([A.rgb[0] * a, A.rgb[1] * a, A.rgb[2] * a, B.rgb[0] * a, B.rgb[1] * a, B.rgb[2] * a], i * 6);
        });
        bcol.needsUpdate = true;
        conVis = conVisible;
        dirty = true;
    }
    let conVis = new Uint32Array(0);

    // ── 相機聚焦 ──
    let tween = null;
    function tweenTo(target, dist) {
        const dir = camera.position.clone().sub(controls.target).normalize();
        const toPos = target.clone().add(dir.multiplyScalar(dist));
        tween = { t0: performance.now(), dur: 900, fromT: controls.target.clone(), toT: target.clone(), fromP: camera.position.clone(), toP: toPos };
        dirty = true;
    }
    function focus(level, id, conId) {
        if (!layout) return;
        if (level === 'galaxy' && layout.galaxies[id]) {
            const g = layout.galaxies[id];
            tweenTo(new THREE.Vector3(g.x, g.y, g.z), Math.max(50, g.r * 2.4));
        } else if (level === 'constellation' && layout.cons[id]) {
            const c = layout.cons[id];
            tweenTo(new THREE.Vector3(c.x, c.y, c.z), Math.max(18, c.r * 4));
        } else if (level === 'star') {
            const it = items.find(x => x.star.id === id && (!conId || x.conId === conId)) || items.find(x => x.star.id === id);
            if (it) { selIdx = it.idx; tweenTo(new THREE.Vector3(it.x, it.y, it.z), 16); applyTime(curTime); }
        } else {
            selIdx = -1;
            const R = Math.max(120, layout.radius);
            tweenTo(new THREE.Vector3(0, 0, 0), R * 2);
            applyTime(curTime);
        }
    }

    // ── 投影與挑選 ──
    const v3 = new THREE.Vector3();
    function project(x, y, z, out) {
        v3.set(x, y, z).project(camera);
        out.x = (v3.x * 0.5 + 0.5) * W; out.y = (-v3.y * 0.5 + 0.5) * H; out.z = v3.z; out.behind = v3.z > 1 || v3.z < -1;
    }
    const tmp = { x: 0, y: 0, z: 0, behind: false };
    function pick(mx, my) {
        let best = -1, bestScore = Infinity;
        const rect = renderer.domElement.getBoundingClientRect();
        const px = mx - rect.left, py = my - rect.top;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.alpha < 0.06) continue;
            project(it.x, it.y, it.z, tmp);
            if (tmp.behind) continue;
            const d = Math.hypot(tmp.x - px, tmp.y - py);
            const rad = 9 + it.baseSize * 1.5;
            if (d > rad) continue;
            const score = d + tmp.z * 6;        // 距離相近時偏向較近的星
            if (score < bestScore) { bestScore = score; best = i; }
        }
        return best;
    }

    // ── 標籤位置 ──
    function updateLabels() {
        const camPos = camera.position;
        const place = (key, x, y, z, show) => {
            const el = labelEls.get(key);
            if (!el) return;
            project(x, y, z, tmp);
            if (!show || tmp.behind || tmp.x < -50 || tmp.x > W + 50 || tmp.y < -20 || tmp.y > H + 20) { el.style.display = 'none'; return; }
            el.style.display = 'block';
            el.style.transform = `translate(${tmp.x.toFixed(1)}px, ${tmp.y.toFixed(1)}px) translate(-50%, -50%)`;
        };
        place('core', 0, 0, 0, true);
        for (const g of galaxies) place('g:' + g.id, g.x, g.y + g.r * 0.95, g.z, true);
        for (const c of cons) {
            const ci = cons.indexOf(c);
            const near = Math.hypot(camPos.x - c.x, camPos.y - c.y, camPos.z - c.z) < 110 + c.r * 6;
            place('c:' + c.id, c.x, c.y + c.r * 0.9, c.z, near && conVis[ci] > 0);
        }
    }

    // ── 尺寸 ──
    let W = 1, H = 1;
    function resize() {
        W = container.clientWidth || innerWidth; H = container.clientHeight || innerHeight;
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        renderer.setSize(W, H, false);
        renderer.domElement.style.width = W + 'px'; renderer.domElement.style.height = H + 'px';
        camera.aspect = W / H;
        camera.updateProjectionMatrix();
        const scale = (H * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
        uniforms.uScale.value = scale; hazeUniforms.uScale.value = scale;
        uniforms.uMaxPx.value = 64 * renderer.getPixelRatio();
        uniforms.uMinPx.value = 2.5 * renderer.getPixelRatio();
        dirty = true;
    }

    // ── 主迴圈（隱藏時暫停、閒置 3 秒降到 30fps）──
    let running = false, dirty = true, lastInteraction = performance.now(), skip = false, T = 0, raf = 0;
    function poke() { lastInteraction = performance.now(); skip = false; dirty = true; }
    controls.addEventListener('start', poke);
    controls.addEventListener('change', () => { dirty = true; });
    function frame() {
        raf = requestAnimationFrame(frame);
        if (!running || document.hidden) return;
        const idle = performance.now() - lastInteraction > 3000;
        if (idle) { skip = !skip; if (skip) return; }
        if (tween) {
            const k = Math.min(1, (performance.now() - tween.t0) / tween.dur);
            const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            controls.target.lerpVectors(tween.fromT, tween.toT, e);
            camera.position.lerpVectors(tween.fromP, tween.toP, e);
            if (k >= 1) tween = null;
            dirty = true;
        }
        const wasAuto = controls.autoRotate && idle && !reduced;
        controls.autoRotate = !reduced && idle && !tween;
        controls.update();
        if (!reduced) { T += 0.016; uniforms.uTime.value = T; }
        if (dirty || wasAuto || controls.autoRotate || !reduced) {
            updateLabels();
            renderer.render(scene, camera);
            dirty = false;
        }
    }

    // ── 指標事件 ──
    const el = renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; poke(); });
    el.addEventListener('pointermove', e => {
        poke();
        if (e.buttons) return;
        const i = pick(e.clientX, e.clientY);
        if (i !== hoverIdx) { hoverIdx = i; applyTime(curTime); }
        el.style.cursor = i >= 0 ? 'pointer' : 'grab';
        opts.onHover && opts.onHover(i >= 0 ? items[i] : null, e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', () => { if (hoverIdx !== -1) { hoverIdx = -1; applyTime(curTime); } opts.onHover && opts.onHover(null, 0, 0); });
    el.addEventListener('pointerup', e => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        down = null;
        if (moved > 5) return;
        const i = pick(e.clientX, e.clientY);
        if (i >= 0) { selIdx = i; applyTime(curTime); opts.onPickStar && opts.onPickStar(items[i]); }
    });
    window.addEventListener('resize', () => { if (running) resize(); });

    return {
        setData, setTime: applyTime, focus, resize, poke,
        getRange: () => ({ ...range }),
        getTime: () => curTime,
        getItems: () => items,
        getVisibleCount: () => visibleCount,
        selectStar(starId) { const it = items.find(x => x.star.id === starId); selIdx = it ? it.idx : -1; applyTime(curTime); },
        setRunning(v) {
            running = v;
            container.style.display = v ? 'block' : 'none';
            labelLayer.style.display = v ? 'block' : 'none';
            if (v) { resize(); poke(); if (!raf) raf = requestAnimationFrame(frame); }
        },
        // 給截圖驗證用：直接指定相機
        // 給截圖驗證用：某顆星目前的螢幕座標（不可見回 null）
        debugScreenPos(starId) {
            const it = items.find(x => x.star.id === starId && x.alpha > 0.06);
            if (!it) return null;
            project(it.x, it.y, it.z, tmp);
            const r = renderer.domElement.getBoundingClientRect();
            return { x: tmp.x + r.left, y: tmp.y + r.top };
        },
        debugCamera(px, py, pz) { camera.position.set(px, py, pz); controls.update(); dirty = true; },
    };
}
