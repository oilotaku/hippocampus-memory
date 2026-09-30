// ========================================
// 記憶星圖 v5 — DOM 面板層
// 詳情面板、麵包屑、觀星手記、User 認知模型、tooltip
// ========================================

import { universe, conById, decideMergeProposal } from './data.js';
import { view, breadcrumb, gotoConstellation } from './state.js';
import { bridgesOfCon } from './layout.js';

const TOKEN = () => localStorage.getItem('token');
const authHeaders = () => {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    return {
        'Authorization': `Bearer ${TOKEN()}`,
        'X-CSRF-Token': csrfMeta ? csrfMeta.getAttribute('content') : '',
    };
};

const $ = id => document.getElementById(id);

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ── 麵包屑 ──
export function renderBreadcrumb() {
    const el = $('breadcrumb');
    el.innerHTML = '';
    breadcrumb().forEach((item, i, arr) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'bc-sep'; sep.textContent = '›';
            el.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.className = 'bc-item' + (item.active ? ' active' : '');
        btn.textContent = item.label;
        if (!item.active) btn.addEventListener('click', item.action);
        el.appendChild(btn);
    });
}

// ── 頂部統計 ──
export function renderTopCount() {
    $('tb-count').textContent = `${universe.totalFragments} fragments · ${universe.constellations.length} constellations`;
}
export function showConnectionLost() {
    $('tb-count').textContent = 'connection lost';
}

// ── 詳情面板 ──
function panelBase(color) {
    const p = $('panel');
    p.style.setProperty('--pc', color);
    $('p-accent').style.cssText = `background:${color};box-shadow:0 0 7px ${color}`;
    $('p-tags').innerHTML = '';
    $('p-meta').innerHTML = '';
    p.classList.add('visible');
    return p;
}

function addTag(text) {
    const el = document.createElement('span');
    el.className = 'tag'; el.textContent = text;
    $('p-tags').appendChild(el);
}

function addMeta(label, valuePct, valueText) {
    const row = document.createElement('div');
    row.className = 'p-mag-row';
    row.innerHTML = `<span class="p-mag-label">${esc(label)}</span>
      <div class="mag-track"><div class="mag-fill" style="width:${Math.max(0, Math.min(100, valuePct))}%"></div></div>
      <span class="mag-val">${esc(valueText)}</span>`;
    $('p-meta').appendChild(row);
}

// 星星（碎片）詳情
export function showStarPanel(star, viewConId) {
    const con = conById(viewConId);
    const color = con?.color || '#7c9dff';
    panelBase(color);
    $('p-cat').textContent = (con?.galaxyLabel || '') + ' · ' + (con?.label || '');
    $('p-title').textContent = star.title || '…';
    $('p-body').textContent = star.content || '';
    if (con) addTag('✦ ' + con.label);
    if (star.relation) addTag(star.relation);
    if (star.lifecycle === 'cooling') addTag('冷卻中 — 很久沒被想起');
    else if (star.lifecycle === 'frozen') addTag('已凍結 — 即將歸檔');
    addMeta('鮮活度', (star.conf || 0) * 100, ((star.conf || 0) * 100).toFixed(0) + '%');
    addMeta('視星等', Math.max(0, (6.5 - (star.mag || 4)) / 5.5 * 100), (star.mag || 4).toFixed(1) + '等');
    $('p-date').textContent = star.date || '';

    // v5.0: 星星操作 — 解除與該星座的關聯
    // star.id = "f12345" → fragId = 12345, con needs real id (strip 'e' prefix)
    const fragId = parseInt(String(star.id).replace('f', ''));
    const entityId = con ? parseInt(String(con.id).replace('e', '')) : null;
    if (con && fragId && entityId) {
        const actions = document.createElement('div');
        actions.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.04)';
        const unlink = document.createElement('button');
        unlink.textContent = '解除與「' + con.label + '」的關聯';
        unlink.style.cssText = 'background:rgba(255,80,80,0.06);border:1px solid rgba(255,80,80,0.12);border-radius:6px;color:rgba(255,120,120,0.5);font-family:inherit;font-size:10px;cursor:pointer;padding:4px 10px;transition:all .2s';
        unlink.addEventListener('mouseenter', () => { unlink.style.background = 'rgba(255,80,80,0.12)'; unlink.style.borderColor = 'rgba(255,80,80,0.3)'; });
        unlink.addEventListener('mouseleave', () => { unlink.style.background = 'rgba(255,80,80,0.06)'; unlink.style.borderColor = 'rgba(255,80,80,0.12)'; });
        unlink.addEventListener('click', async () => {
            unlink.disabled = true;
            unlink.textContent = '…';
            try {
                const r = await fetch('/api/memory/unlink-fragment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ entity_id: entityId, fragment_id: fragId }),
                });
                const d = await r.json();
                if (d.ok) {
                    unlink.textContent = '已解除';
                    unlink.style.color = 'rgba(120,200,120,0.5)';
                    unlink.style.borderColor = 'rgba(120,200,120,0.15)';
                    unlink.style.background = 'rgba(120,200,120,0.04)';
                    window.dispatchEvent(new CustomEvent('memory-refresh'));
                } else {
                    unlink.textContent = '解除失敗';
                    unlink.disabled = false;
                }
            } catch (_) {
                unlink.textContent = '解除失敗';
                unlink.disabled = false;
            }
        });
        actions.appendChild(unlink);
        $('p-meta').appendChild(actions);
    }
}

// 星座（實體）詳情
let _conPanelMode = 'facts'; // 'facts' | 'judgment'

export function showConPanel(con) {
    panelBase(con.color);
    $('p-cat').textContent = (con.galaxyLabel || '') + '星系';
    $('p-title').textContent = con.label;

    // Determine which content to show
    const hasFacts = con.facts && con.facts.trim().length > 0;
    const hasJudgment = con.judgment && con.judgment.trim().length > 0;
    const hasBoth = hasFacts && hasJudgment;

    // Default to facts if available, otherwise judgment, otherwise overview
    _conPanelMode = hasFacts ? 'facts' : (hasJudgment ? 'judgment' : 'facts');
    _renderConBody(con);

    // Toggle button
    if (hasBoth) {
        const existingBtn = document.getElementById('p-toggle-mode');
        if (existingBtn) existingBtn.remove();
        const btn = document.createElement('button');
        btn.id = 'p-toggle-mode';
        btn.className = 'p-toggle-btn';
        btn.title = '切換事實/私語';
        btn.textContent = '◆ 私語';
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            _conPanelMode = _conPanelMode === 'facts' ? 'judgment' : 'facts';
            btn.textContent = _conPanelMode === 'facts' ? '◆ 私語' : '◇ 事實';
            _renderConBody(con);
        });
        $('p-title').appendChild(btn);
    }

    if (con.category) {
        const catLabel = con.subcategory ? `${con.category} · ${con.subcategory}` : con.category;
        addTag(catLabel);
    }
    // v5.1: 別稱（精準觸發，藍色標籤）
    if (con.aliases && con.aliases.length > 0) {
        con.aliases.forEach(a => {
            const el = document.createElement('span');
            el.className = 'tag tag-alias';
            el.textContent = a;
            $('p-tags').appendChild(el);
        });
    }
    // v5.1: 向量標籤（語義關聯，紫色標籤）
    if (con.tags && con.tags.length > 0) {
        con.tags.forEach(t => {
            const el = document.createElement('span');
            el.className = 'tag tag-label';
            el.textContent = t;
            $('p-tags').appendChild(el);
        });
    }
    if (con.relationship) addTag(con.relationship.slice(0, 40));
    // v5.3: Tab切換 — 關聯星座 / 敘事片段（二選一顯示，防止面板過長）
    const bridges = bridgesOfCon(con.id);
    const hasEpisodes = con.episodes && con.episodes.length > 0;
    const hasBridges = bridges.length > 0;

    if (hasBridges || hasEpisodes) {
        const tabBar = document.createElement('div');
        tabBar.className = 'p-tab-bar';

        const bridgeTab = document.createElement('button');
        bridgeTab.className = 'p-tab-btn active';
        bridgeTab.textContent = '關聯星座' + (hasBridges ? ` · ${bridges.length}` : '');
        bridgeTab.dataset.tab = 'bridges';

        const epTab = document.createElement('button');
        epTab.className = 'p-tab-btn';
        epTab.textContent = '敘事片段' + (hasEpisodes ? ` · ${con.episodes.length}` : '');
        epTab.dataset.tab = 'episodes';

        // Default: show bridges if any, else episodes
        const defaultTab = hasBridges ? 'bridges' : 'episodes';
        if (defaultTab === 'episodes') {
            bridgeTab.classList.remove('active');
            epTab.classList.add('active');
        }

        tabBar.appendChild(bridgeTab);
        tabBar.appendChild(epTab);
        $('p-meta').appendChild(tabBar);

        // Tab content container
        const tabContent = document.createElement('div');
        tabContent.className = 'p-tab-content';

        // Bridges panel
        if (hasBridges) {
            const linksDiv = document.createElement('div');
            linksDiv.className = 'p-bridges' + (defaultTab === 'bridges' ? '' : ' hidden');
            linksDiv.dataset.panel = 'bridges';
            bridges.sort((a, b) => b.weight - a.weight).slice(0, 6).forEach(br => {
                const other = conById(br.otherId);
                if (!other) return;
                const wrap = document.createElement('div');
                wrap.className = 'p-bridge';

                const a = document.createElement('button');
                a.className = 'p-bridge-link';
                a.style.color = other.color;
                a.textContent = br.relation
                    ? `${other.label} — ${br.relation}`
                    : `${other.label} · ${br.weight}條共享記憶`;
                a.addEventListener('click', () => gotoConstellation(other.id));
                wrap.appendChild(a);

                // 橋那頭的最新一條近況，**並排顯示**——站在這顆星上也看得見對面的動靜。
                // 注意是**並排**不是合併：兩邊的近況各寫各的，誰都不冒充誰的事實。
                // （寫進去會爛：那邊的事一旦過去，這一頭就永遠掛著別人的舊聞。）
                const otherLatest = _bridgeLatestStatus(other);
                if (otherLatest) {
                    const s = document.createElement('div');
                    s.className = 'p-bridge-status';
                    s.textContent = otherLatest;
                    wrap.appendChild(s);
                }

                linksDiv.appendChild(wrap);
            });
            tabContent.appendChild(linksDiv);
        }

        // Episodes panel
        if (hasEpisodes) {
            const epDiv = document.createElement('div');
            epDiv.className = 'p-episodes' + (defaultTab === 'episodes' ? '' : ' hidden');
            epDiv.dataset.panel = 'episodes';
            const epList = document.createElement('div');
            epList.className = 'p-episodes-list';
            con.episodes.forEach(ep => {
                const card = document.createElement('div');
                card.className = 'p-episode-card';
                const wStars = ep.weight >= 8 ? '★★★' : ep.weight >= 6 ? '★★☆' : ep.weight >= 4 ? '★☆☆' : '☆☆☆';
                card.innerHTML = `<div class="p-episode-header">
                    <span class="p-episode-weight">${wStars}</span>
                    <span class="p-episode-date">${esc(ep.date || '')}</span>
                </div>
                <div class="p-episode-content">${esc(ep.content)}</div>`;
                epList.appendChild(card);
            });
            epDiv.appendChild(epList);
            tabContent.appendChild(epDiv);
        }

        $('p-meta').appendChild(tabContent);

        // Tab switch handler
        tabBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.p-tab-btn');
            if (!btn) return;
            const target = btn.dataset.tab;
            tabBar.querySelectorAll('.p-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            tabContent.querySelectorAll('[data-panel]').forEach(p => p.classList.add('hidden'));
            const targetPanel = tabContent.querySelector(`[data-panel="${target}"]`);
            if (targetPanel) targetPanel.classList.remove('hidden');
        });
    }

    const coolingN = con.coolingCount || 0;
    addMeta('記憶碎片', Math.min(100, con.stars.length / 40 * 100),
        coolingN > 0 ? `${con.stars.length} 顆 · ${coolingN} 冷卻` : con.stars.length + ' 顆');
    $('p-date').textContent = con.updatedAt ? '更新於 ' + (con.updatedAt || '').slice(0, 10) : '';
}

// 橋那頭的最新一條近況（近況是倒序的日誌，第一行最新）。
// 取不到就返回空串——不佔位、不寫"暫無"（面板裡已經夠多"暫無"了）。
// 自己判一下哨兵，不引別的模組的 helper：這裡只需要"這行字值不值得顯示"。
function _bridgeLatestStatus(con) {
    const raw = (con.currentStatus || '').replace(/\r/g, '');
    if (!raw || !raw.trim()) return '';
    const first = raw.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    if (first.length < 3) return '';
    if (/^(無|暫無|無明顯變化|無變化|沒有明顯變化|無新動態|近期無新動態)[。.，,、\s]*$|^(无|暂无|无明显变化|无变化|没有明显变化|无新动态|近期无新动态)[。.，,、\s]*$/.test(first)) return '';
    return first.length > 96 ? first.slice(0, 96) + '…' : first;
}

function _renderConBody(con) {
    // 近況（current_status） — 放在 body 最前面
    // ⚠️ 取 camelCase 的 currentStatus：後端 /api/memory/universe 映射出來的是這個名。
    // 以前這裡讀下劃線寫法，永遠 undefined，近況那一行從來沒渲染過。
    let bodyHtml = '';
    if (con.currentStatus) {
        bodyHtml += '<div class="p-cs">' + con.currentStatus + '</div>';
    }
    let mainText = '';
    if (_conPanelMode === 'facts') {
        mainText = con.facts || '';
    } else if (_conPanelMode === 'judgment') {
        mainText = con.judgment || '';
    } else {
        mainText = con.facts || '';
    }
    $('p-body').innerHTML = bodyHtml + mainText;
    // Talking points
    let tps = [];
    try { tps = typeof con.talking_points === 'string' ? JSON.parse(con.talking_points) : (con.talking_points || []); } catch(_) {}
    if (tps.length > 0) {
        const tpDiv = document.createElement('div');
        tpDiv.className = 'p-tps';
        tpDiv.innerHTML = '<div class="p-tps-label">可聊</div>' +
            tps.map(function(tp) { return '<div class="p-tp-item">' + (tp.content || '') + '</div>'; }).join('');
        $('p-body').appendChild(tpDiv);
    }
}

// 雙星核心檔案（顏色從API讀取）
export function showCorePanel(name, ent) {
    const color = ent?.color || '#7c9dff';
    const isUser = ent?.role === 'user';
    panelBase(color);
    $('p-cat').textContent = '雙星核心';
    $('p-title').textContent = name;
    $('p-body').textContent = ent?.facts || (isUser ? '這個宇宙的創造者。' : '這個宇宙的守護者。');
    addTag(isUser ? '恆星 · 暖金' : '恆星 · 銀綠');
    if (ent?.relationship) addTag(ent.relationship.slice(0, 40));
    addMeta('記憶碎片', 100, (ent?.fragment_count || 0) + ' 條');
    $('p-date').textContent = ent?.updatedAt ? '更新於 ' + (ent.updatedAt || '').slice(0, 10) : '';
}

export function hidePanel() { $('panel').classList.remove('visible'); }

// ── tooltip ──
export function showTooltip(mx, my, text) {
    const tt = $('tt');
    tt.style.opacity = '1';
    tt.style.left = (mx + 14) + 'px';
    tt.style.top = (my - 8) + 'px';
    tt.textContent = text;
}
export function hideTooltip() { $('tt').style.opacity = '0'; }

// ── 觀星手記 ──
export function renderArchlog() {
    const body = $('arch-body');
    body.innerHTML = '';
    const data = universe.archlog || [];
    if (!data.length) {
        body.innerHTML = '<div class="arch-empty">尚無活動記錄</div>';
        return;
    }
    data.slice(0, 15).forEach((e, i, arr) => {
        const div = document.createElement('div');
        div.className = 'arch-entry';
        div.innerHTML = `<span class="arch-time">${esc(e.time)}</span>
          <div class="arch-dot-col"><div class="arch-edot" style="background:${e.color};box-shadow:0 0 5px ${e.color}"></div>${i < Math.min(arr.length, 15) - 1 ? '<div class="arch-line"></div>' : ''}</div>
          <span class="arch-text">${e.text || ''}</span>`;
        body.appendChild(div);
    });
}

// ── User 認知模型 ──
// immutable_fact v4.8 退役。stable_trait/active_hypothesis v5.2 退役，由 user_patterns 替代。
const MODEL_LAYERS = [
    { type: 'current_state', label: '● 當前狀態', cls: 'state' },
    { type: 'pattern', label: '◇ 觀察模式', cls: 'pat' },
];

export function renderModelPanel() {
    const counts = {};
    universe.userModel.forEach(e => counts[e.type] = (counts[e.type] || 0) + 1);
    const patCount = (universe.patterns || []).filter(p => p.status === 'active').length;
    counts['pattern'] = patCount;
    $('mp-body').innerHTML = MODEL_LAYERS.map(l => `
      <div class="mp-layer" data-type="${l.type}">
        <div class="mp-dot-s ${l.cls}"></div>
        <span class="mp-label">${l.label}</span>
        <span class="mp-count">${counts[l.type] || 0}</span>
      </div>`).join('');
    document.querySelectorAll('.mp-layer').forEach(el => {
        el.addEventListener('click', e => { e.stopPropagation(); showModelDetail(el.dataset.type); });
    });
}

// Add pattern dot class CSS
const MP_DOT_STYLE = document.createElement('style');
MP_DOT_STYLE.textContent = '.mp-dot-s.pat { background: rgba(255,179,212,0.7); box-shadow: 0 0 6px rgba(255,150,200,0.5); }';
document.head.appendChild(MP_DOT_STYLE);

function showModelDetail(filterType) {
    const detail = $('model-detail');
    const content = $('md-content');
    let html = '<button class="md-close" id="md-close">✕</button>';

    // ── Current State ──
    if (!filterType || filterType === 'current_state') {
        const states = universe.userModel.filter(e => e.type === 'current_state');
        html += `<div class="md-section"><div class="md-section-title">● 當前狀態 (${states.length})</div>`;
        if (!states.length) html += '<div class="md-empty">暫無</div>';
        else states.forEach(e => {
            let extra = '';
            if (e.expires_at) {
                const remainMs = new Date(e.expires_at) - Date.now();
                if (remainMs <= 0) extra = '<span class="md-ttl md-expired">已過期</span>';
                else {
                    const remainH = Math.round(remainMs / 3600000);
                    const remainText = remainH < 1 ? '即將過期' : remainH < 24 ? `約${remainH}h` : `約${Math.round(remainH/24)}d`;
                    extra = `<span class="md-ttl">${remainText}</span>`;
                }
            }
            if (e.created_by === 'chat_companion') extra += '<span class="md-source">🖊️ AI</span>';
            else if (e.created_by === 'deep_cycle') extra += '<span class="md-source">🌙 深迴圈</span>';
            html += `<div class="md-row"><span class="mdot mp-dot-s state"></span><span style="flex:1">${esc(e.content)}</span>${extra}</div>`;
        });
        html += '</div>';
    }

    // ── Patterns (v5.2) ──
    if (!filterType || filterType === 'pattern') {
        const patterns = (universe.patterns || []).filter(p => p.status === 'active');
        html += `<div class="md-section"><div class="md-section-title">◇ 觀察模式 (${patterns.length})</div>`;
        if (!patterns.length) html += '<div class="md-empty">暫無。深迴圈會在觀察積累足夠後自動生成。</div>';
        else patterns.forEach(p => {
            const conf = Math.round((p.confidence || 0) * 100);
            const spanDays = p.first_seen && p.last_seen
                ? Math.round((new Date(p.last_seen) - new Date(p.first_seen)) / (1000*60*60*24))
                : 0;
            const tags = (p.tags || []).slice(0, 5).map(t => `<span class="md-tag">${esc(t)}</span>`).join('');
            html += `<div class="md-row"><span class="mdot mp-dot-s pat"></span>
              <span style="flex:1">${esc(p.content)}</span>
              <span class="mconf">${p.evidence_count}次 · ${spanDays}d · ${conf}%</span></div>
              <div class="md-row-sub">${tags}</div>`;
        });
        html += '</div>';
    }

    content.innerHTML = html;
    detail.classList.add('show');
    document.getElementById('md-close')?.addEventListener('click', closeModelDetail);
    detail.addEventListener('click', (e) => { if (e.target === detail) closeModelDetail(); });
}
export function closeModelDetail() { $('model-detail').classList.remove('show'); }

// ── v5.2: Patterns (日積月累的行為觀察) ──
export function renderPatterns() {
    const box = $('patterns-box');
    const body = $('pat-body');
    const patterns = universe.patterns || [];
    if (!patterns.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    $('pat-count').textContent = patterns.length + ' 個模式';
    body.innerHTML = patterns.slice(0, 5).map(p => {
        const conf = Math.round((p.confidence || 0) * 100);
        const tags = (p.tags || []).slice(0, 4).map(t => `<span class="pat-tag">${esc(t)}</span>`).join('');
        return `<div class="pat-item" onclick="document.querySelector('[data-type=pattern]').click()" title="點選檢視全部模式">
          <div class="pat-content">${esc(p.content.slice(0, 60))}${p.content.length>60?'…':''}</div>
          <div class="pat-meta">
            <span class="pat-stat">${p.evidence_count}次 · 置信${conf}%</span>
            ${tags}
          </div>
        </div>`;
    }).join('');
    if (patterns.length > 5) {
        body.innerHTML += `<div class="pat-more" onclick="document.querySelector('[data-type=pattern]').click()">檢視全部 ${patterns.length} 個模式 →</div>`;
    }
}

// ── 合併提案佇列（AI 的疑問 → User 裁決）──
export function renderMergeProposals() {
    const box = $('merge-proposals');
    const body = $('mq-body');
    const proposals = universe.mergeProposals || [];
    if (!proposals.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    $('mq-count').textContent = proposals.length + ' 待裁決';
    body.innerHTML = '';
    proposals.forEach(p => {
        const item = document.createElement('div');
        item.className = 'mq-item';
        const q = document.createElement('div');
        q.className = 'mq-q';
        q.innerHTML = `<strong>${esc(p.a_name)}</strong>（${p.a_fc || 0}星）和 <strong>${esc(p.b_name)}</strong>（${p.b_fc || 0}星）是同一個嗎？`;
        const reason = document.createElement('div');
        reason.className = 'mq-reason';
        reason.textContent = `依據：${p.reason || '?'}${p.shared ? ` · 共享${p.shared}條記憶` : ''}`;
        const actions = document.createElement('div');
        actions.className = 'mq-actions';
        const mkBtn = (label, cls, decision) => {
            const b = document.createElement('button');
            b.className = 'mq-btn ' + cls;
            b.textContent = label;
            b.addEventListener('click', async () => {
                b.disabled = true;
                try {
                    await decideMergeProposal(p.id, decision);
                    item.remove();
                    const left = universe.mergeProposals.length;
                    if (!left) box.style.display = 'none';
                    else $('mq-count').textContent = left + ' 待裁決';
                } catch (e) {
                    b.disabled = false;
                    b.textContent = '失敗，重試';
                }
            });
            return b;
        };
        actions.appendChild(mkBtn('是，合併', 'approve', 'approve'));
        actions.appendChild(mkBtn('不是', 'reject', 'reject'));
        item.appendChild(q); item.appendChild(reason); item.appendChild(actions);
        body.appendChild(item);
    });
}

// ── v5.0: 核心洞察編輯 ──
async function loadCoreInsight() {
    try {
        const r = await fetch('/api/memory/core-insight', { headers: authHeaders() });
        const d = await r.json();
        if (d.ok) {
            $('ci-editor').value = d.insight || '';
            if (d.updated_at) {
                $('ci-updated').textContent = '更新於 ' + new Date(d.updated_at).toLocaleString('zh-CN');
            }
        }
    } catch (_) {}
}
export async function renderCoreInsight() {
    await loadCoreInsight();
    $('ci-save').addEventListener('click', async () => {
        const insight = $('ci-editor').value.trim();
        if (!insight) return;
        $('ci-save').disabled = true;
        $('ci-save').textContent = '儲存中…';
        try {
            const r = await fetch('/api/memory/core-insight', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ insight }),
            });
            const d = await r.json();
            if (d.ok) {
                $('ci-save').textContent = '已儲存';
                $('ci-updated').textContent = '更新於 ' + new Date().toLocaleString('zh-CN');
            } else {
                $('ci-save').textContent = '失敗，重試';
            }
        } catch (_) {
            $('ci-save').textContent = '失敗，重試';
        }
        $('ci-save').disabled = false;
    });
}

// ── 摺疊面板初始化 ──
export function initPanelEvents() {
    $('panel-close').addEventListener('click', hidePanel);
    $('arch-header').addEventListener('click', () => {
        $('archlog').classList.toggle('collapsed'); $('archlog').classList.toggle('expanded');
        const archExp = $('archlog').classList.contains('expanded');
        $('model-panel').style.bottom = archExp ? '272px' : '68px';
        closeModelDetail();
    });
    $('mp-header').addEventListener('click', () => {
        $('model-panel').classList.toggle('collapsed'); $('model-panel').classList.toggle('expanded');
    });
    loadPipelineStatus();
    setInterval(loadPipelineStatus, 5 * 60 * 1000);
}

// ================================================================
// Pipeline Status
// ================================================================

async function loadPipelineStatus() {
    try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/memory/pipeline-status', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!res.ok) return;
        const s = await res.json();
        if (!$('tb-count')) return;
        $('tb-count').textContent = '碎片 ' + (s.fragments?.total || 0).toLocaleString();
        $('tb-entities').textContent = '實體 ' + (s.entities?.total || 0) + (s.entities?.seeds > 0 ? '/' + s.entities.seeds + '種' : '');
        $('tb-cm').textContent = 'CM ' + (s.userModel?.total || 0);
        if (s.lastScribe) {
            const mins = Math.round((Date.now() - new Date(s.lastScribe + 'Z').getTime()) / 60000);
            $('tb-scribe').textContent = 'Scribe ' + (mins < 60 ? mins + 'min前' : Math.round(mins/60) + 'h前');
        }
    } catch (_) {}
}
