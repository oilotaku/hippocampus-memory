// ========================================
// 記憶星圖 — 檢視模式切換（4D / 2D / 列表）＋ 時間軸
// 4D（three.js）採動態載入：不支援 WebGL 或 prefers-reduced-motion 或手機寬度時預設 2D，
// 且 2D 路徑完全不會載入 three.js。
// ========================================

import { universe, conById } from './data.js';
import { view, onViewChange, gotoConstellation, gotoGalaxy, gotoStar } from './state.js';
import { showStarPanel, showTooltip, hideTooltip } from './panels.js';
import { parseSqlTime } from './layout3d.js';
import { EMOTION_DIMS, EMOTION_INFO, NEUTRAL_RGB, getColorMode, setColorMode, onColorModeChange } from './emotion.js';

const $ = id => document.getElementById(id);

export const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
export function hasWebGL() {
    try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (_) { return false; }
}

let mode = '2d';
let map4d = null;
let loading = null;
let onMode = () => {};
export const getMode = () => mode;

function defaultMode() {
    if (innerWidth < 700) return '2d';
    if (reducedMotion()) return '2d';
    if (!hasWebGL()) return '2d';
    return '4d';
}

async function ensure4D() {
    if (map4d) return map4d;
    if (!loading) {
        loading = import('./starmap4d.js').then(m => {
            map4d = m.createStarMap4D({
                container: $('gl-wrap'),
                labelLayer: $('gl-labels'),
                reducedMotion: reducedMotion(),
                onHover(item, x, y) {
                    if (!item) { hideTooltip(); return; }
                    showTooltip(x, y, `${item.star.title || '…'} · ${item.star.conLabel || ''}`);
                },
                onPickStar(item) {
                    hideTooltip();
                    // 點星只是「瀏覽」，不算回憶：不呼叫 bumpAccess，不改 read_count / last_accessed_at
                    gotoStar(item.star.id, item.conId);
                    showStarPanel(item.star, item.conId);
                },
                onPickCon(id) { gotoConstellation(id); },
                onPickGalaxy(id) { gotoGalaxy(id); },
            });
            window.__mcStarMap = map4d;   // 除錯／截圖驗證用
            map4d.setColorMode(getColorMode());
            if (universe.loaded) { map4d.setData(universe); syncTimebar(); }
            return map4d;
        });
    }
    return loading;
}

// ── 檢視切換 ──
export async function setMode(next) {
    if (next === '4d' && !hasWebGL()) next = '2d';
    if (next === '4d') {
        try { await ensure4D(); } catch (e) { console.error('[memory] 4D 載入失敗，退回 2D：', e); loading = null; next = '2d'; }
    }
    mode = next;
    document.body.classList.remove('mode-4d', 'mode-2d', 'mode-list');
    document.body.classList.add('mode-' + next);
    document.querySelectorAll('#view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.mode === next));
    if (map4d) map4d.setRunning(next === '4d');
    $('timebar').style.display = next === '4d' ? 'flex' : 'none';
    $('list-view').style.display = next === 'list' ? 'block' : 'none';
    const hint = $('hint');
    if (hint) hint.innerHTML = next === '4d'
        ? '拖曳旋轉 · 滾輪縮放 · 右鍵／雙指平移<br>點星看內容 · 下方時間軸拖曳或播放'
        : 'scroll to zoom · drag to pan<br>click to dive in · Esc to surface';
    if (next === '4d') { syncTimebar(); syncFocus(); }
    else stopPlay();
    if (next === 'list') renderList();
    onMode(next);
}

// ── 時間軸 ──
let playing = false, playRaf = 0, playLast = 0;
const PLAY_MS = 24000;   // 從最早播到最新的時長

function fmtDate(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function fmtTime(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' +
        d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function rangeFrac() {
    const r = map4d.getRange();
    return (map4d.getTime() - r.min) / Math.max(1, r.max - r.min);
}
function syncTimebar() {
    if (!map4d) return;
    const r = map4d.getRange();
    $('tl-min').textContent = fmtDate(r.min);
    $('tl-max').textContent = fmtDate(r.max);
    $('tl-range').value = String(Math.round(rangeFrac() * 1000));
    updateNow();
}
function updateNow() {
    if (!map4d) return;
    $('tl-now').textContent = `${fmtTime(map4d.getTime())} · ${map4d.getVisibleCount()} 顆`;
}
function setTimeFrac(f) {
    const r = map4d.getRange();
    map4d.setTime(r.min + Math.min(1, Math.max(0, f)) * (r.max - r.min));
    $('tl-range').value = String(Math.round(f * 1000));
    updateNow();
}
function stopPlay() {
    playing = false;
    cancelAnimationFrame(playRaf);
    const b = $('tl-play');
    if (b) { b.textContent = '▶'; b.setAttribute('aria-label', '播放'); }
}
function startPlay() {
    if (!map4d) return;
    if (rangeFrac() >= 0.999) setTimeFrac(0);
    playing = true;
    $('tl-play').textContent = '⏸';
    $('tl-play').setAttribute('aria-label', '暫停');
    playLast = performance.now();
    const step = (now) => {
        if (!playing) return;
        const dt = now - playLast; playLast = now;
        const f = rangeFrac() + dt / PLAY_MS;
        map4d.poke();
        if (f >= 1) { setTimeFrac(1); stopPlay(); return; }
        setTimeFrac(f);
        playRaf = requestAnimationFrame(step);
    };
    playRaf = requestAnimationFrame(step);
}

// ── 列表檢視 ──
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
const LIFE_LABEL = { cooling: '冷卻中', frozen: '已凍結' };
export function renderList() {
    const el = $('list-view');
    const rows = [];
    for (const c of universe.constellations) {
        for (const s of c.stars || []) {
            rows.push({ c, s, t: parseSqlTime(s.createdAt || s.date) });
        }
    }
    rows.sort((a, b) => (Number.isFinite(b.t) ? b.t : 0) - (Number.isFinite(a.t) ? a.t : 0));
    const cap = 400;
    el.innerHTML = '<div class="lv-inner"><div class="lv-head">記憶清單 · 依時間由新到舊 · ' + rows.length + ' 顆' +
        (rows.length > cap ? '（僅顯示最新 ' + cap + '）' : '') + '</div>' +
        rows.slice(0, cap).map((r, i) => `<button class="lv-item" data-i="${i}">
            <div class="lv-meta"><span class="lv-dot" style="background:${esc(r.c.color)}"></span>
            <span>${Number.isFinite(r.t) ? esc(fmtTime(r.t)) : esc(r.s.date)}</span>
            <span>${esc(r.c.galaxyLabel)} · ${esc(r.c.label)}</span>
            ${LIFE_LABEL[r.s.lifecycle] ? '<span class="lv-badge">' + LIFE_LABEL[r.s.lifecycle] + '</span>' : ''}</div>
            <div class="lv-title">${esc(r.s.content || r.s.title)}</div></button>`).join('') + '</div>';
    el.querySelectorAll('.lv-item').forEach(btn => btn.addEventListener('click', () => {
        const r = rows[parseInt(btn.dataset.i, 10)];
        if (r) showStarPanel(r.s, r.c.id);
    }));
}

// ── 檢視層級（麵包屑／星系按鈕）同步到 4D 相機 ──
function syncFocus() {
    if (mode !== '4d' || !map4d) return;
    if (view.level === 'galaxy') map4d.focus('galaxy', view.galaxyId);
    else if (view.level === 'constellation') map4d.focus('constellation', view.conId);
    else if (view.level === 'star') map4d.focus('star', view.starId, view.conId);
    else map4d.focus('universe');
}

// ── 上色切換（星系／情緒）與情緒圖例 ──
function buildLegend() {
    $('emo-legend-body').innerHTML = EMOTION_DIMS.map(d =>
        `<div class="el-row"><span class="el-swatch" style="background:${EMOTION_INFO[d].hex};color:${EMOTION_INFO[d].hex}"></span>${EMOTION_INFO[d].label}</div>`).join('') +
        `<div class="el-row neutral"><span class="el-swatch" style="background:rgb(${NEUTRAL_RGB.join(',')});color:transparent"></span>無明顯情緒</div>`;
}
function syncColorUI(m) {
    document.querySelectorAll('#color-toggle button').forEach(b => b.classList.toggle('active', b.dataset.cmode === m));
    $('emo-legend').style.display = m === 'emotion' ? 'block' : 'none';
    if (map4d) map4d.setColorMode(m);
    if (mode === '2d') window.dispatchEvent(new Event('memory-recolor'));
}
function initColorMode() {
    buildLegend();
    document.querySelectorAll('#color-toggle button').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        setColorMode(b.dataset.cmode);
    }));
    $('emo-legend-head').addEventListener('click', () => {
        const c = $('emo-legend').classList.toggle('collapsed');
        $('emo-legend-head').setAttribute('aria-expanded', String(!c));
    });
    onColorModeChange(syncColorUI);
    syncColorUI(getColorMode());
}

export function onDataLoaded() {
    if (map4d) {
        const r0 = map4d.getRange();
        const atEnd = map4d.getTime() >= r0.max - 1;
        map4d.setData(universe);
        if (atEnd) map4d.setTime(map4d.getRange().max);
        syncTimebar();
    }
    if (mode === 'list') renderList();
}

export function initViewModes(cb) {
    onMode = cb || onMode;
    const canGL = hasWebGL();
    const btn4 = document.querySelector('#view-toggle [data-mode="4d"]');
    if (!canGL && btn4) { btn4.disabled = true; btn4.title = '此瀏覽器不支援 WebGL，已使用 2D'; }
    document.querySelectorAll('#view-toggle button').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        setMode(b.dataset.mode);
    }));
    $('tl-range').addEventListener('input', e => {
        if (!map4d) return;
        stopPlay();
        map4d.poke();
        setTimeFrac(parseInt(e.target.value, 10) / 1000);
    });
    $('tl-play').addEventListener('click', () => { if (playing) stopPlay(); else startPlay(); });
    initColorMode();
    onViewChange(() => syncFocus());
    document.addEventListener('keydown', e => {
        if (mode === '4d' && e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
            e.preventDefault(); if (playing) stopPlay(); else startPlay();
        }
    });
    // 螢幕寬度／偏好變動時不強制切換使用者已選的模式；只有 WebGL 掉了才退回 2D
    return setMode(defaultMode());
}

export function getMap4D() { return map4d; }
