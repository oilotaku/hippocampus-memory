// ========================================
// 記憶星圖 — 再鞏固操作（確認／否認／修改）
// 記憶被想起時有一段可修改的窗口；側欄是使用者「看到一條記憶」的時刻，所以在這裡當場處理。
// 瀏覽不算回想：只有按下按鈕才會送 API（G4：點星本身不 bumpAccess）。
// 否認會延遲 5 秒才送出，期間可復原；離開頁面時把待送出的否認立刻送出（keepalive）。
// ========================================

const TOKEN = () => { try { return localStorage.getItem('token'); } catch (_) { return null; } };
const csrf = () => { const m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') : ''; };
const headers = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN()}`, 'X-CSRF-Token': csrf() });

export const MAX_CONTENT = 300;
export const DENY_UNDO_MS = 5000;

const pending = new Set();   // 尚未送出的否認 { send(keepalive) }

export async function postAction(action, body, keepalive = false) {
    const resp = await fetch('/api/memory/reconsolidate/' + action, {
        method: 'POST', credentials: 'include', headers: headers(), body: JSON.stringify(body), keepalive,
    });
    let data = null;
    try { data = await resp.json(); } catch (_) {}
    if (!resp.ok) throw new Error((data && data.error) || ('HTTP ' + resp.status));
    return data;
}

window.addEventListener('pagehide', () => { for (const p of [...pending]) p.flush(); });

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/**
 * 在 host 內掛上三個按鈕。
 *  target: { type:'fragment'|'episode', id:number, entityId:number|null }
 *  opts.compact：敘事卡片用的精簡版
 *  opts.onResult(result, action)：操作成功後由呼叫端更新資料／畫面
 *  opts.notice：掛載時先顯示的一行訊息
 */
export function mountReconsolidate(host, target, opts = {}) {
    const box = el('div', opts.compact ? 'rc-ep-actions-wrap' : 'rc-box');
    if (!opts.compact) box.appendChild(el('div', 'rc-title', '再鞏固 · 這條記憶對嗎？'));
    const row = el('div', opts.compact ? 'rc-ep-actions' : 'rc-actions');
    const bOk = el('button', 'rc-btn ok', '✓ 這沒錯');
    const bNo = el('button', 'rc-btn no', '✗ 這不對');
    const bMod = el('button', 'rc-btn mod', '✎ 修改');
    [bOk, bNo, bMod].forEach(b => { b.type = 'button'; row.appendChild(b); });
    const area = el('div', 'rc-area');
    box.append(row, area);
    host.appendChild(box);

    let busy = false;
    const setBusy = v => { busy = v; [bOk, bNo, bMod].forEach(b => { b.disabled = v; }); };
    const status = (text, err = false, undo = null) => {
        area.innerHTML = '';
        if (!text) return;
        const s = el('div', 'rc-status' + (err ? ' err' : ''));
        s.appendChild(el('span', null, text));
        if (undo) { const u = el('button', 'rc-undo', '復原'); u.type = 'button'; u.addEventListener('click', undo); s.appendChild(u); }
        area.appendChild(s);
    };
    if (opts.notice) status(opts.notice);
    const body = extra => ({ type: target.type, id: target.id, entityId: target.entityId || undefined, ...extra });

    async function run(action, extra, keepalive) {
        setBusy(true);
        try {
            const r = await postAction(action, body(extra), keepalive);
            opts.onResult && opts.onResult(r, action);
            return r;
        } catch (e) {
            status(e.message || '操作失敗', true);
            return null;
        } finally { setBusy(false); }
    }

    bOk.addEventListener('click', async () => {
        if (busy) return;
        const r = await run('confirm');
        if (!r) return;
        const n = r.state && (r.state.citedCount ?? r.state.confirmations);
        status(r.deduped ? '剛剛才確認過，不重複計算。' : `已確認 ✓${n != null ? ' · 累計 ' + n + ' 次' : ''}`);
    });

    bNo.addEventListener('click', () => {
        if (busy) return;
        area.innerHTML = '';
        const c = el('div', 'rc-form');
        c.appendChild(el('div', 'rc-hint', '確定這條記憶不正確？它會被標為「冷卻」，並記入更正紀錄。'));
        const go = el('button', 'rc-btn no', '確定否認'); go.type = 'button';
        const cancel = el('button', 'rc-btn', '取消'); cancel.type = 'button';
        const r2 = el('div', 'rc-actions'); r2.append(go, cancel); c.appendChild(r2);
        area.appendChild(c);
        cancel.addEventListener('click', () => status(''));
        go.addEventListener('click', () => {
            setBusy(true);
            let done = false;
            const send = async (keepalive) => {
                if (done) return; done = true;
                clearTimeout(timer); pending.delete(handle);
                const r = await run('deny', {}, keepalive);
                if (r) status('已標為不正確（冷卻中），並記入更正紀錄。');
            };
            const handle = { flush: () => send(true) };
            const timer = setTimeout(() => send(false), DENY_UNDO_MS);
            pending.add(handle);
            status(`將在 ${DENY_UNDO_MS / 1000} 秒後送出否認…`, false, () => {
                if (done) return; done = true;
                clearTimeout(timer); pending.delete(handle);
                setBusy(false);
                status('已復原，什麼都沒有改變。');
            });
        });
    });

    bMod.addEventListener('click', () => {
        if (busy) return;
        area.innerHTML = '';
        const f = el('div', 'rc-form');
        const ta = el('textarea'); ta.placeholder = '正確的內容是……'; ta.maxLength = MAX_CONTENT * 2;
        const hint = el('div', 'rc-hint'); const cnt = el('span', null, `0 / ${MAX_CONTENT}`);
        hint.append(el('span', null, '舊記憶會降溫，並新增你輸入的這條'), cnt);
        const go = el('button', 'rc-btn mod', '送出修改'); go.type = 'button';
        const cancel = el('button', 'rc-btn', '取消'); cancel.type = 'button';
        const r2 = el('div', 'rc-actions'); r2.append(go, cancel);
        f.append(ta, hint, r2); area.appendChild(f);
        ta.focus();
        let armed = false, armTimer = 0;
        const len = () => [...ta.value.trim()].length;
        ta.addEventListener('input', () => {
            const n = len(); cnt.textContent = `${n} / ${MAX_CONTENT}`;
            cnt.style.color = n > MAX_CONTENT ? '#ff9c8a' : '';
            armed = false; go.textContent = '送出修改';
        });
        cancel.addEventListener('click', () => status(''));
        go.addEventListener('click', async () => {
            const n = len();
            if (!n) { cnt.textContent = '請輸入內容'; cnt.style.color = '#ff9c8a'; return; }
            if (n > MAX_CONTENT) return;
            if (!armed) {   // 第二次點擊才真的送出（確認提示）
                armed = true; go.textContent = '確定修改？再按一次';
                clearTimeout(armTimer); armTimer = setTimeout(() => { armed = false; go.textContent = '送出修改'; }, 4000);
                return;
            }
            clearTimeout(armTimer);
            const r = await run('modify', { content: ta.value.trim() });
            if (r) status('已修改：舊記憶降溫，新記憶已加入。');
        });
    });

    return { setStatus: status };
}
