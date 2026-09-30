// =================================================================
// services/recallPipeline.js — recall.gate 開啟時，buildSmartContext 的記憶區塊組裝（G1）
//
// 順序：hard trigger（核心份額）→ 閘門判斷 → 檢索（動態 k、檢索份額）→ 實體檔案（核心份額）
//       → 情境浮現與前瞻（浮現份額）。輸出是要接在 dynamicParts 後面的區塊文字。
// recall.gate=false 時 context.js 不會呼叫這裡，維持原本「每則都查 8 條」的舊流程。
// =================================================================

const { getDb } = require('../database');
const recall = require('./recallGate');
const { getMemoryTokenBudget, estimateTokens, takeWithinBudget, splitEntityBlocks } = require('./memoryBudget');

// 上一則訊息的話題狀態（僅記憶體：重啟後第一則一定會查，是保守方向）
let lastTurn = null;
function resetPipelineState() { lastTurn = null; }

/** 把工作記憶池裡的碎片撈回完整內容（話題延續時沿用） */
function loadPoolFragments(db) {
    let pooled = [];
    try { pooled = require('./workingMemory').getRecentFragments(); } catch (_) { return []; }
    const out = [];
    const now = Date.now();
    for (const p of pooled) {
        try {
            if (p.source_table === 'memory') {
                const r = db.prepare(`SELECT id, title AS content, (weight / 10.0) AS emotional_weight, valid_from AS date_label, created_at
                                      FROM memories WHERE id = ? AND layer = 'episode' AND status = 'permanent'`).get(p.id);
                if (r) out.push({ ...r, source_table: 'memory' });
            } else {
                const r = db.prepare(`SELECT id, content, emotional_weight, source_date AS date_label, created_at
                                      FROM memory_fragments WHERE id = ? AND status = 'active'`).get(p.id);
                if (r && r.content != null) out.push({ ...r, source_table: 'fragment' });
            }
        } catch (_) {}
    }
    for (const f of out) {
        const t = f.created_at ? new Date(String(f.created_at).includes('T') ? f.created_at : String(f.created_at).replace(' ', 'T') + 'Z').getTime() : NaN;
        f._daysAgo = Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 86400000)) : undefined;
        f._confidence = 'medium';
        f._source = 'WM';
        f._rrf = 0.01;
    }
    return out;
}

function bumpInjected(items, db) {
    const stmt = db.prepare("UPDATE memory_fragments SET read_count = COALESCE(read_count, 0) + 1, injected_count = COALESCE(injected_count, 0) + 1, last_accessed_at = datetime('now') WHERE id = ?");
    for (const it of items) {
        if ((it.source_table || 'fragment') !== 'fragment') continue;
        try { stmt.run(it.id); } catch (_) {}
    }
}

/**
 * @param {string} userMessage
 * @param {object} o
 *   wrapMemoryContext(libText) → 包上說明文字的 <memory_context> 區塊
 *   USER/AI 不需要——文字由 wrapMemoryContext 與 context.js 決定
 *   now / rng / db / cfg：測試可注入
 * @returns {Promise<{parts:string[], tokens:number, injected:Array, decision:object}>}
 */
async function buildGatedMemory(userMessage, o = {}) {
    const db = o.db || getDb();
    const cfg = o.cfg || recall.getRecallConfig();
    const now = o.now != null ? o.now : Date.now();
    const rng = o.rng || Math.random;
    const { searchMemoriesByHardTrigger } = require('./memory');
    const { searchHybrid, formatHybridContext, classifyIntent } = require('./librarian');
    const { getEntityContext } = require('./entityProfile');
    const { AI } = require('./nameResolver');

    const parts = [];
    let tokens = 0;
    const injected = [];

    const total = o.budget != null ? o.budget : getMemoryTokenBudget();
    const share = recall.splitBudget(total, cfg.budget_share);
    let coreLeft = share.core;

    // 上一則的時間（判斷閒置）；本則立即記下
    const lastMessageAt = recall.getLastMessageAt(db);
    recall.touchLastMessage(db, now);

    // ── 硬觸發（核心份額）──
    let hardMatches = searchMemoriesByHardTrigger(userMessage, { cfg });
    {
        const r = takeWithinBudget(hardMatches, coreLeft, m => estimateTokens(m.content) + 8);
        if (r.dropped > 0) console.log(`buildSmartContext: hard trigger 超出核心預算，丟棄 ${r.dropped} 條`);
        coreLeft -= r.used;
        hardMatches = r.kept;
    }
    if (hardMatches.length > 0) {
        parts.push('<relevant_memories>');
        parts.push('Thinking Process: 檢測到關鍵詞，已從冥想盆調取相關記憶：');
        for (const mem of hardMatches) {
            parts.push(`※ 相關記憶 #${mem.id}`);
            parts.push(`${mem.content}`);
            parts.push('');
            tokens += Math.ceil(mem.content.length / 4);
        }
        parts.push('</relevant_memories>');
        try {
            const touch = db.prepare("UPDATE memories SET last_accessed_at = datetime('now') WHERE id = ?");
            hardMatches.forEach(m => { try { touch.run(m.id); } catch (_) {} });
        } catch (_) {}
        console.log(`buildSmartContext: hard trigger injected ${hardMatches.length} memories`);
    }

    // ── 閘門 ──
    let poolSize = 0;
    try { poolSize = require('./workingMemory').getRecentFragments().length; } catch (_) {}
    const decision = recall.decideRecall(userMessage, {
        cfg, db, now, poolSize, prev: lastTurn, intent: classifyIntent(userMessage),
    });
    // 只記結論與長度，不記訊息全文
    console.log(`[recallGate] retrieve=${decision.retrieve} reason=${decision.reason}${decision.overlap != null ? ` overlap=${decision.overlap}` : ''} len=${[...String(userMessage)].length}`);
    lastTurn = { at: now, bigrams: recall.bigramSet(userMessage), retrieved: decision.retrieve || !!decision.continuation };

    // ── 檢索（動態 k）或沿用工作記憶 ──
    let frags = [];
    let fromPool = false;
    if (decision.retrieve) {
        try {
            const candidates = await searchHybrid(userMessage, cfg.candidate_k, { surface: 'none' });
            const kept = recall.selectDynamicK(candidates, { relativeCutoff: cfg.relative_cutoff, maxK: cfg.max_k });
            const r = takeWithinBudget(kept, share.retrieval, f => estimateTokens(f.content) + 10);
            if (r.dropped > 0) console.log(`buildSmartContext: 檢索超出預算，丟棄 ${r.dropped} 條`);
            console.log(`[recallGate] 候選 ${candidates.length} → 相對門檻後 ${kept.length} → 預算後 ${r.kept.length}`);
            frags = r.kept;
        } catch (e) {
            console.error('Librarian注入失敗:', e.message);
        }
    } else if (decision.continuation) {
        frags = loadPoolFragments(db);
        fromPool = true;
        try { require('./workingMemory').touchPool(); } catch (_) {}
        console.log(`[recallGate] 話題延續，沿用工作記憶 ${frags.length} 條`);
    }

    // ── 情境浮現 + 前瞻（浮現份額）──
    let extraLeft = share.extra;
    let surfaced = [];
    try {
        const exclude = new Set(frags.map(f => `${f.source_table}-${f.id}`));
        const picked = recall.pickSurface({ db, cfg, now, lastMessageAt, rng, exclude });
        const r = takeWithinBudget(picked, extraLeft, f => estimateTokens(f.content) + 10);
        extraLeft -= r.used;
        surfaced = r.kept;
    } catch (e) { console.error('[recallGate] 浮現失敗:', e.message); }

    const memoryItems = [...frags, ...surfaced];
    if (memoryItems.length > 0) {
        const libText = formatHybridContext(memoryItems, { count: !fromPool });
        if (libText) {
            if (fromPool && surfaced.length > 0) bumpInjected(surfaced, db);   // 沿用的不重複計次，新浮現的要計
            parts.push(o.wrapMemoryContext ? o.wrapMemoryContext(libText) : `<memory_context>\n${libText}\n</memory_context>`);
            tokens += Math.ceil(libText.length / 4);
            console.log(`buildSmartContext: recall gate injected ${frags.length} fragments${surfaced.length ? ` + ${surfaced.length} 浮現` : ''}`);
            for (const f of memoryItems) injected.push({ id: f.id, source_table: f.source_table });
            if (surfaced.length > 0) {
                recall.recordSurfaced(surfaced, db, now);
                console.log(`[recallGate] 浮現 ${surfaced.length} 條（${[...new Set(surfaced.map(f => f._surfaceReason))].join('、')}）`);
            }

            if (frags.length > 0 && !fromPool) {
                try { require('./workingMemory').updatePool(frags); } catch (e) { console.error('WorkingMemory updatePool failed:', e.message); }
            }

            // 實體檔案（核心份額的剩餘）
            try {
                let entityCtx = getEntityContext(frags);
                if (entityCtx) {
                    const r = takeWithinBudget(splitEntityBlocks(entityCtx), coreLeft, b => estimateTokens(b));
                    if (r.dropped > 0) console.log(`buildSmartContext: entity 超出核心預算，丟棄 ${r.dropped} 份檔案`);
                    coreLeft -= r.used;
                    entityCtx = r.kept.join('\n');
                }
                if (entityCtx) {
                    parts.push(`<entity_context>\n以下是記憶中涉及人物的最新近況（來自${AI.name}的記憶檔案）：\n${entityCtx}\n</entity_context>`);
                    tokens += Math.ceil(entityCtx.length / 4);
                }
            } catch (_) {}
        }
    }

    // 前瞻：即將發生的事（不必等查詢命中；不受閘門影響）
    try {
        const upcoming = recall.findUpcoming({ db, cfg, now });
        const r = takeWithinBudget(upcoming, extraLeft, u => estimateTokens(u.content) + 10);
        if (r.kept.length > 0) {
            const text = r.kept.map(recall.formatUpcomingLine).join('\n');
            parts.push(`<upcoming_events>\n以下是記憶中${cfg.prospective_days}天內即將發生的事。若和當下對話自然相關，可以順口提醒一下；不相關就不要硬提。\n${text}\n</upcoming_events>`);
            tokens += Math.ceil(text.length / 4);
            bumpInjected(r.kept, db);
            for (const u of r.kept) injected.push({ id: u.id, source_table: 'fragment' });
            console.log(`[recallGate] 前瞻 ${r.kept.length} 條（${r.kept.map(u => `#${u.id}:${u.daysUntil}天後`).join(' ')}）`);
        }
    } catch (e) { console.error('[recallGate] 前瞻失敗:', e.message); }

    return { parts, tokens, injected, decision };
}

module.exports = { buildGatedMemory, loadPoolFragments, resetPipelineState };
