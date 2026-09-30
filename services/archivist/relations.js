// =================================================================
// services/archivist/relations.js — 實體關係：related_entities 讀寫、關係體檢、標籤橋、共現關係發現
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { WORLD_CONTEXT } = require('../worldContext');
const { SKIP_NAMES } = require('../memoryConfig');
const { SKIP_PH, ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { agentState, _canCallLLM } = require('./runtime');
const { AUTO_LINK_ALIAS_MIN_WEIGHT, _mentionWeight, _entityMentionOwners, _aliasAmbiguous } = require('./entityLink');


// ═══════════════════════════════════════════════════════
// v4.8: discoverRelatedEntities — 實體關係發現
//
// 共享碎片 ≥2 的實體對 → LLM 寫一句關係描述 → 雙方
// related_entities。星圖橋線 + 聊天 entity context 共用。
// ═══════════════════════════════════════════════════════

// 寫實體關係到雙方 related_entities（新增或更新）
// opts.reviewed = 'YYYY-MM-DD' stamps `last_reviewed` — for relations that have no
// co-occurring fragments by construction (tag-derived ones). Without the stamp they'd
// be re-judged as dead by reviewEntityRelations() on the very next run.
function _writeEntityRelation(a, b, relation, sharedCount, opts = {}) {
    const db = getDb();
    let relsA = [];
    try { relsA = JSON.parse(a.related_entities || '[]'); } catch (_) {}
    const existingA = relsA.findIndex(r => r.id === b.id);
    // `since` is only stamped on new entries: it means "when this relation started
    // being remembered" and survives later description updates.
    const prev = existingA >= 0 ? relsA[existingA] : null;
    const since = (prev && prev.since) ? prev.since : new Date().toISOString().slice(0, 10);
    const entry = { id: b.id, name: b.name, relation, shared_count: sharedCount, since };
    if (opts.reviewed) entry.last_reviewed = opts.reviewed;
    else if (prev && prev.last_reviewed) entry.last_reviewed = prev.last_reviewed;
    if (existingA >= 0) relsA[existingA] = entry; else relsA.push(entry);
    db.prepare('UPDATE entity_profiles SET related_entities = ? WHERE id = ?')
        .run(JSON.stringify(relsA), a.id);
}


// ── read/write helpers for the relation list (used by reviewEntityRelations) ──
function _parseRelations(ent) {
    try { const r = JSON.parse(ent.related_entities || '[]'); return Array.isArray(r) ? r : []; }
    catch (_) { return []; }
}


function _writeRelations(entId, rels) {
    getDb().prepare('UPDATE entity_profiles SET related_entities = ? WHERE id = ?')
        .run(JSON.stringify(rels), entId);
}


// Drop the entry pointing at otherId from entId's list; true if something was removed.
function _dropEntityRelation(entId, otherId) {
    const db = getDb();
    const ent = db.prepare('SELECT id, related_entities FROM entity_profiles WHERE id = ?').get(entId);
    if (!ent) return false;
    const rels = _parseRelations(ent);
    const next = rels.filter(r => r.id !== otherId);
    if (next.length === rels.length) return false;
    _writeRelations(entId, next);
    return true;
}


// ═══════════════════════════════════════════════════════
// v5.3: reviewEntityRelations — the relation table has to be able to LOSE entries
//
// `related_entities` had a write path and no cleanup path — once a bridge was written
// it stayed forever. That produced three kinds of rot:
//   · dead pointers — when an entity is merged/superseded, nothing went back and fixed
//     the relation lists that point at it. The consumer (memoryTools.formatRelatedLine,
//     entityProfile) injects related constellations straight into the model's context,
//     so this isn't just an ugly star map: it feeds the model entities that don't exist.
//   · zero co-occurrence — the pair shared fragments when the bridge was written and
//     shares none now (fragment links were removed since), yet the bridge lingers.
//   · false relations — two things that merely appeared in the same sentence got
//     recorded as a relation. The prompt criterion for that is fixed at the write side;
//     this cleans the backlog.
//
// The criterion for "is this bridge still real" (kept deliberately narrow):
//   **If these two constellations stopped being related, would it change how either
//   one's current-status gets updated?** Yes → keep. No → cut.
//   So "two stops on the same trip" survives, while "went to X on the way to Y once"
//   gets cut once it's stale.
//
// ⚠️ Cutting is self-healing: if a real relation co-occurs again (≥2 shared fragments),
//    discoverRelatedEntities() simply re-creates it (a cut entry is no longer filtered
//    out by `fresh`).
// ⚠️ A relation judged "keep" gets a `last_reviewed` stamp so it isn't re-asked every
//    cycle; it comes back up after maxAgeDays.
// ═══════════════════════════════════════════════════════

const RELATION_MAX_AGE_DAYS = 90;    // how long a co-occurrence may go quiet before review

const RELATION_REVIEW_PER_RUN = 3;   // max pairs re-judged per run (= 3 LLM calls)


async function reviewEntityRelations({ dryRun = false, maxAgeDays = RELATION_MAX_AGE_DAYS, maxReview = RELATION_REVIEW_PER_RUN } = {}) {
    const db = getDb();
    const today = new Date();
    const dayOf = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00+08:00`);
    const ageInDays = (d) => Math.floor((today - dayOf(d)) / 86400000);

    const ents = db.prepare(`
        SELECT id, name, status, related_entities FROM entity_profiles
        WHERE related_entities IS NOT NULL AND related_entities != '[]'
    `).all();
    const peerOf = db.prepare(`
        SELECT id, name, category, status, current_status, updated_at FROM entity_profiles WHERE id = ?
    `);
    // How many fragments this pair shares *now*, and the most recent one.
    // source_date can be an empty string, so fall back to created_at — otherwise those
    // rows would be misread as "zero co-occurrence".
    const lastSharedOf = db.prepare(`
        SELECT MAX(COALESCE(NULLIF(mf.source_date, ''), substr(mf.created_at, 1, 10))) AS d,
               COUNT(*) AS n
        FROM memory_fragments mf
        JOIN fragment_entities f1 ON f1.fragment_id = mf.id AND f1.entity_id = ?
        JOIN fragment_entities f2 ON f2.fragment_id = mf.id AND f2.entity_id = ?
    `);

    // Statuses that can actually surface: the star map queries `active`, the chat
    // context injects `active`+`seed`. `dormant` is "asleep, not dead" and is kept clean
    // so it wakes up tidy. merged/superseded are skipped for review — the peer is gone.
    const LIVE_STATUS = new Set(['active', 'seed', 'dormant']);

    const deadPtrs = [], stale = [], alive = [];
    let total = 0, totalLive = 0;
    for (const e of ents) {
        for (const r of _parseRelations(e)) {
            total++;
            if (LIVE_STATUS.has(e.status)) totalLive++;
            const peer = peerOf.get(r.id);
            if (!peer || peer.status === 'merged' || peer.status === 'superseded') {
                // Dead pointers are free to remove and are removed for EVERY status:
                // archived entities do get revived (a tombstone can be set back to
                // active), and a relation list full of ghosts would come back with it.
                deadPtrs.push({ ent: e, rel: r, peerStatus: peer ? peer.status : '不存在' });
                continue;
            }
            // Only queue pairs where both sides can surface — spending LLM calls on
            // relations between dormant/seed entities isn't worth it.
            if (!LIVE_STATUS.has(e.status) || !LIVE_STATUS.has(peer.status)) continue;
            const ls = lastSharedOf.get(e.id, r.id) || {};
            const days = ls.d ? ageInDays(ls.d) : null;
            const reviewed = r.last_reviewed ? ageInDays(r.last_reviewed) : null;
            const fresh = (ls.n > 0 && days != null && days <= maxAgeDays)
                || (reviewed != null && reviewed <= maxAgeDays);
            (fresh ? alive : stale).push({ ent: e, peer, rel: r, sharedNow: ls.n || 0, days });
        }
    }

    // ── ① dead pointers: free, remove directly ──
    let dropped = 0;
    for (const d of deadPtrs) {
        if (dryRun) { dropped++; console.log(`[Archivist] ✂️ (dry) 斷橋（對端${d.peerStatus}）: ${d.ent.name} ↔ ${d.rel.name}`); continue; }
        if (_dropEntityRelation(d.ent.id, d.rel.id)) dropped++;
        console.log(`[Archivist] ✂️ 斷橋（對端${d.peerStatus}）: ${d.ent.name} ↔ ${d.rel.name} — 「${(d.rel.relation || '').slice(0, 30)}」`);
    }

    // ── ② review queue, deduped by pair (A→B and B→A are one judgement, not two) ──
    const byPair = new Map();
    for (const s of stale) {
        const key = `${Math.min(s.ent.id, s.rel.id)}-${Math.max(s.ent.id, s.rel.id)}`;
        if (!byPair.has(key)) byPair.set(key, s);
    }
    const queue = [...byPair.values()];
    // dryRun means "don't write", not "don't judge" — a probe needs to see the verdicts.
    const willReview = _canCallLLM(1) ? queue.slice(0, maxReview) : [];
    let kept = 0, cut = 0;

    const stamp = today.toISOString().slice(0, 10);
    for (const q of willReview) {
        const a = db.prepare('SELECT id, name, category, current_status FROM entity_profiles WHERE id = ?').get(q.ent.id);
        const b = db.prepare('SELECT id, name, category, current_status FROM entity_profiles WHERE id = ?').get(q.rel.id);
        if (!a || !b) continue;

        // Evidence: a few recent fragments from each side. Judging a relation without
        // showing the material means the model can only invent a plausible-sounding one.
        const sideFrags = db.prepare(`
            SELECT mf.source_date, mf.content FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id AND fe.entity_id = ?
            ORDER BY COALESCE(NULLIF(mf.source_date, ''), mf.created_at) DESC LIMIT 3
        `);
        const fmtSide = (ent) => {
            const st = (ent.current_status || '').replace(/\n/g, ' / ').slice(0, 160) || '（空）';
            const frags = sideFrags.all(ent.id)
                .map(f => `      · [${String(f.source_date || '').slice(5, 10)}] ${(f.content || '').slice(0, 80)}`)
                .join('\n');
            return `【${ent.name}】(${ent.category})\n    近況：${st}\n    最近素材：\n${frags || '      （無）'}`;
        };

        const prompt = `有兩個"記憶星座"，它們之間記著一條關係。請複審這條關係**現在還成不成立**。

${fmtSide(a)}

${fmtSide(b)}

記錄的關係：「${q.rel.relation}」（當初共享 ${q.rel.shared_count || 0} 條記憶，最近一次共現：${q.days != null ? q.days + ' 天前' : '已經沒有共現'}）

⚠️ 判據只有一條：**如果這兩個星座從此不再關聯，會影響其中一方「近況」的更新嗎？**
  · **會影響** → 留著（同一位房東與住處、同一個專案的兩個環節、天天在一起的人）
  · **不影響** → 斷掉（某天順路去過一次的地方、某句話裡順口提到的兩隻貓、一次性的活動參與）
    ——那類關係記在過去就夠了，不需要一直掛在星座上

只輸出JSON: {"keep":true|false,"why":"十個字以內"}`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT, null,
                { temperature: 0.1, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const m = (raw?.reply || raw?.text || raw?.content || '').match(/\{[\s\S]*\}/);
            if (!m) continue;
            const v = JSON.parse(m[0]);
            if (v.keep) {
                // Stamp both sides (keep `since`, only touch `last_reviewed`).
                if (!dryRun) for (const [self, other] of [[a, b], [b, a]]) {
                    const ent = db.prepare('SELECT id, related_entities FROM entity_profiles WHERE id = ?').get(self.id);
                    const rels = _parseRelations(ent);
                    const i = rels.findIndex(r => r.id === other.id);
                    if (i >= 0) { rels[i] = { ...rels[i], last_reviewed: stamp }; _writeRelations(self.id, rels); }
                }
                kept++;
                console.log(`[Archivist] 🌉 複審判留${dryRun ? '(dry)' : ''}: ${a.name} ↔ ${b.name} — ${v.why || ''}`);
            } else {
                if (!dryRun) { _dropEntityRelation(a.id, b.id); _dropEntityRelation(b.id, a.id); }
                cut++;
                console.log(`[Archivist] ✂️ 斷橋（複審）${dryRun ? '(dry)' : ''}: ${a.name} ↔ ${b.name} — ${v.why || ''}（原關係：「${(q.rel.relation || '').slice(0, 30)}」）`);
            }
        } catch (err) {
            console.error('[Archivist] 關係複審 LLM 失敗:', err.message);
        }
    }

    // ── ③ whatever didn't fit in this run is only counted, not touched.
    //      Anything written into the DB needs something that eventually looks back at
    //      it; logging the backlog is the cheapest way to keep that visible. ──
    const backlog = queue.length - willReview.length;
    if (dropped || cut || kept || backlog) {
        console.log(`[Archivist] 🌉 關係表體檢：露得出來的 ${totalLive} 條（含歸檔共 ${total}）→ 死指標摘 ${dropped} → 待複審 ${queue.length}（本輪判留 ${kept} / 斷 ${cut}，還剩 ${backlog} 條排隊）→ 共現還活的 ${alive.length} 條`);
    }
    if (dropped && !dryRun) {
        try {
            db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail) VALUES ('entity_bridges_review', NULL, ?)`)
                .run(JSON.stringify({ dead_pointers: dropped, reviewed: willReview.length, kept, cut, backlog, total, total_live: totalLive }));
        } catch (_) {}
    }
    return { total, totalLive, deadPointers: dropped, stale: queue.length, reviewed: willReview.length, kept, cut, backlog, alive: alive.length };
}


// ═══════════════════════════════════════════════════════
// v5.4: discoverTagRelations — 第三條建關係的路（標籤橋）
//
// 星座的 `tags` 是模型寫的「這個星座是什麼」。當某個 tag 正好是另一個星座的名字時，
// 那就是**這個星座自己認的關係**——而沒有任何東西讀它。
// 為什麼需要它：另外兩條路都會漏掉同一類結構——
//   · 共現路要求 shared >= 2。一個「作品與其出品方/平臺」式的對子，素材裡未必
//     有兩條同時提到兩者，於是永遠夠不到門檻。
//   · 語義兜底路的 category 白名單是 event/place/person，`consumed`/`project` 那側
//     進不了候選池。
//
// ⚠️ 它**繼承模型寫 tags 時的毛病**，所以候選詞要過跟別名連結器**同一套門**
//    （`_mentionWeight` / `_aliasAmbiguous` —— 同一個定義處，不另抄一份）。
//    真實資料上跑過一輪：19 條候選放行 12 / 擋掉 7，擋掉的正好包含一個錯標籤
//    （把一次跟某機構無關的事，標成了那個機構）——因為它只有兩個字，跟泛稱一個待遇。
//    **門比 prompt 有用：那條連 LLM 都沒走到。**
// ⚠️ 寫出來的關係要**蓋 last_reviewed 章**：標籤橋天然沒有共現碎片，
//    reviewEntityRelations 判枯的判據是「現在一條都不共享」——不蓋章的話，
//    下一輪剛建的橋就會被當枯橋重審然後斷掉，**等於白建**。
// ⚠️ 不直接寫庫，仍然交給 LLM 寫那一句話——它有權填 null（標籤打錯了就填 null）。
// ═══════════════════════════════════════════════════════

const TAG_RELATION_MAX_PER_RUN = 10;


async function discoverTagRelations({ dryRun = false, maxPerRun = TAG_RELATION_MAX_PER_RUN } = {}) {
    const db = getDb();
    const LIVE_STATUS = new Set(['active', 'seed']);

    const ents = db.prepare(`
        SELECT id, name, category, status, tags, aliases, related_entities
        FROM entity_profiles WHERE status IN ('active', 'seed')
          AND name NOT IN (${SKIP_PH})
    `).all(...SKIP_NAMES);
    if (ents.length === 0) return { discovered: 0 };

    const owners = _entityMentionOwners(db);
    const byName = new Map(), byAlias = new Map();
    for (const e of ents) {
        byName.set(e.name.toLowerCase().trim(), e);
        try {
            for (const a of JSON.parse(e.aliases || '[]')) {
                const k = String(a || '').toLowerCase().trim();
                if (k && !byAlias.has(k)) byAlias.set(k, e);
            }
        } catch (_) {}
    }

    // ── candidates: A's tag == B's name (exact) or B's alias (must pass the gates) ──
    const cands = [], blocked = [];
    for (const e of ents) {
        let tags = [];
        try { tags = JSON.parse(e.tags || '[]'); } catch (_) {}
        const have = new Set(_parseRelations(e).map(r => r.id));
        for (const raw of tags) {
            const t = String(raw || '').trim();
            if (!t) continue;
            const k = t.toLowerCase();
            const byExact = byName.get(k);
            const other = byExact || byAlias.get(k);
            if (!other || other.id === e.id) continue;
            if (!LIVE_STATUS.has(other.status)) continue;
            if (have.has(other.id)) continue;
            if (!byExact) {
                if (_mentionWeight(t) < AUTO_LINK_ALIAS_MIN_WEIGHT) { blocked.push(`${e.name}←「${t}」(太短)`); continue; }
                // ⚠️ 已知的過度保守：`_aliasAmbiguous` 問的是「這個詞跟*別的*實體的叫法
                //    互相包含嗎」。這裡 tag 已經解析到了 other，但守衛不知道 other 是
                //    "自己人"——所以當 other 自己另有一個短別名是它的子串時會誤判。
                //    實資料上沒咬到（19 條裡 0 條），代價也只是"少建一條真橋"，
                //    按「寧可少一條真的，不要多一條假的」先留著。要修的話是給它加一個
                //    ignoreIds 引數，把 other.id 一起忽略掉。
                if (_aliasAmbiguous(e.id, t, owners)) { blocked.push(`${e.name}←「${t}」(指代不明)`); continue; }
            }
            cands.push({ a: e, b: other, tag: t, exact: !!byExact });
        }
    }

    // one judgement per pair (A→B and B→A are the same question)
    const seen = new Set(), queue = [];
    for (const c of cands) {
        const key = `${Math.min(c.a.id, c.b.id)}-${Math.max(c.a.id, c.b.id)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(c);
    }

    if (blocked.length) {
        console.log(`[Archivist] 🏷️ 標籤橋擋在門外 ${blocked.length} 個（跟別名連結器同一套門）：[${blocked.slice(0, 5).join(' ')}]`);
    }
    if (queue.length === 0) return { discovered: 0, blocked: blocked.length };
    if (!_canCallLLM(1)) return { discovered: 0, pending: queue.length, blocked: blocked.length };

    const batch = queue.slice(0, maxPerRun);
    const sideFrags = db.prepare(`
        SELECT mf.source_date, mf.content FROM memory_fragments mf
        JOIN fragment_entities fe ON fe.fragment_id = mf.id AND fe.entity_id = ?
        ORDER BY COALESCE(NULLIF(mf.source_date, ''), mf.created_at) DESC LIMIT 2
    `);
    const fmtSide = (ent) => {
        const st = (ent.current_status || '').replace(/\n/g, ' / ').slice(0, 100);
        const fr = sideFrags.all(ent.id).map(f => `      · ${(f.content || '').slice(0, 70)}`).join('\n');
        return `「${ent.name}」(${ent.category})${st ? `\n    近況：${st}` : ''}${fr ? `\n    素材：\n${fr}` : ''}`;
    };
    const pairBlocks = batch.map((c, i) =>
        `[${i}] ${fmtSide(c.a)}\n    它的標籤裡寫著 →「${c.tag}」\n${fmtSide(c.b)}`
    ).join('\n\n');

    const prompt = `下面每一對星座，是**其中一個的標籤裡寫著另一個的名字**。標籤是自動打的，
可能打錯。請判斷這個標籤是不是真的指向某種關係，寫一句話說明。

⚠️ 關係必須是**能一句話驗證的事實**（同一個專案與其出品方、同一個人與其常住地、
同一件事與其發生場所）。寫不出一句能驗證的事實，就說明它其實沒關係 → 填 null。
⚠️ **寧可空著，不要編一句聽起來合理的。** 標籤打錯的情況真實存在（比如某家機構被
打上了"某次活動"的標籤，而那次活動其實不在那家機構辦的）——那種要填 null。

${pairBlocks}

只輸出JSON陣列: [{"pair":0,"relation":"一句話描述或null"}, ...]`;

    let items;
    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            WORLD_CONTEXT, null,
            { temperature: 0.2, maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_LLM_CONFIG_ID
        );
        agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
        const m = (raw?.reply || raw?.text || raw?.content || '').match(/\[[\s\S]*\]/);
        if (!m) return { discovered: 0, pending: queue.length - batch.length, blocked: blocked.length };
        items = JSON.parse(m[0]);
    } catch (e) {
        console.error('[Archivist] 標籤橋 LLM 失敗:', e.message);
        return { discovered: 0, blocked: blocked.length };
    }

    const stamp = new Date().toISOString().slice(0, 10);
    let discovered = 0;
    for (const item of items) {
        const c = batch[item.pair];
        if (!c) continue;
        if (!item.relation || item.relation === 'null') {
            console.log(`[Archivist] ⏭️ 標籤橋不成關係: ${c.a.name} --「${c.tag}」--> ${c.b.name}`);
            continue;
        }
        const rel = String(item.relation).slice(0, 60);
        if (dryRun) {
            console.log(`[Archivist] 🏷️ (dry) 標籤橋: ${c.a.name} ↔ ${c.b.name} — ${rel}`);
            discovered++;
            continue;
        }
        try {
            _writeEntityRelation(c.a, c.b, rel, 0, { reviewed: stamp });
            _writeEntityRelation(c.b, c.a, rel, 0, { reviewed: stamp });
            discovered++;
            console.log(`[Archivist] 🏷️ 標籤橋: ${c.a.name} ↔ ${c.b.name} — ${rel}`);
        } catch (e) {
            console.error('[Archivist] 標籤橋寫入失敗:', e.message);
        }
    }
    if (discovered > 0 && !dryRun) {
        try {
            db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail) VALUES ('entity_bridges_tag', NULL, ?)`)
                .run(JSON.stringify({ count: discovered, blocked: blocked.length, pending: queue.length - batch.length }));
        } catch (_) {}
    }
    return { discovered, blocked: blocked.length, pending: queue.length - batch.length };
}


async function discoverRelatedEntities() {
    const db = getDb();
    let discovered = 0;

    // Health-check the relation table before writing new bridges: dead pointers get
    // removed and quiet relations get re-judged (see reviewEntityRelations). It runs
    // first on purpose — otherwise "just removed" and "about to write" fight each other
    // within the same cycle.
    try {
        await reviewEntityRelations();
    } catch (e) {
        console.error('[Archivist] 關係表體檢失敗:', e.message);
    }

    // Tag bridges are an INDEPENDENT path, so they're called here — the co-occurrence
    // section below has several early returns (`pairs.length === 0`, `fresh.length === 0`,
    // LLM failure), and anything hung off its tail never runs on cycles where
    // co-occurrence comes up empty.
    try {
        const tagRes = await discoverTagRelations();
        discovered += (tagRes?.discovered || 0);
    } catch (e) {
        console.error('[Archivist] 標籤橋失敗:', e.message);
    }

    const pairs = db.prepare(`
        SELECT f1.entity_id AS a_id, f2.entity_id AS b_id, COUNT(*) AS shared
        FROM fragment_entities f1
        JOIN fragment_entities f2 ON f1.fragment_id = f2.fragment_id AND f1.entity_id < f2.entity_id
        JOIN entity_profiles ea ON ea.id = f1.entity_id AND ea.status = 'active' AND ea.name NOT IN (${SKIP_PH})
        JOIN entity_profiles eb ON eb.id = f2.entity_id AND eb.status = 'active' AND eb.name NOT IN (${SKIP_PH})
        GROUP BY f1.entity_id, f2.entity_id
        HAVING shared >= 2
        ORDER BY shared DESC
        LIMIT 30
    `).all(...SKIP_NAMES, ...SKIP_NAMES);

    // 語義關係檢測：零共享碎片但有日期重疊的實體對 → LLM 判斷
    // （某地之旅 vs 某景點 — 碎片內容不重疊但屬於同一旅行）
    if (pairs.length < 20 && _canCallLLM(2)) {
        const semanticPairs = db.prepare(`
            SELECT DISTINCT ea.id AS a_id, ea.name AS a_name, ea.category AS a_cat,
                   eb.id AS b_id, eb.name AS b_name, eb.category AS b_cat
            FROM entity_profiles ea
            JOIN entity_profiles eb ON ea.id < eb.id
            WHERE ea.status = 'active' AND eb.status = 'active'
              AND ea.name NOT IN (${SKIP_PH}) AND eb.name NOT IN (${SKIP_PH})
              AND ((ea.category IN ('event','place') AND eb.category IN ('event','place','person'))
                OR (eb.category IN ('event','place') AND ea.category IN ('event','place','person')))
            LIMIT 50
        `).all(...SKIP_NAMES, ...SKIP_NAMES);

        const alreadySeen = new Set(pairs.map(p => `${p.a_id}-${p.b_id}`));
        const semanticCandidates = [];

        for (const sp of semanticPairs) {
            if (alreadySeen.has(`${sp.a_id}-${sp.b_id}`)) continue;
            if (semanticCandidates.length >= 3) break;

            // Check date overlap
            const days = db.prepare(`
                SELECT DISTINCT substr(mf.source_date,1,10) as day FROM memory_fragments mf
                JOIN fragment_entities fe ON mf.id = fe.fragment_id
                WHERE fe.entity_id IN (?,?)
            `).all(sp.a_id, sp.b_id).map(r => r.day);

            if (days.length < 2) continue; // not enough temporal data
            const daySet = new Set(days);
            if (daySet.size >= 2) {
                semanticCandidates.push({ a: sp, days: [...daySet].slice(0,5).join(',') });
            }
        }

        for (const cand of semanticCandidates.slice(0, 2)) {
            const sp = cand.a;

            // ⚠️ 給它**證據**。原來這個 prompt 只給"兩個名字 + 日期交集"，一條素材都不給
            //    ——於是模型只能**編一句聽起來合理的**。判關係不給證據 = 讓它猜。
            const evi = db.prepare(`
                SELECT ep.name, mf.source_date, mf.content FROM (
                    SELECT fe.entity_id, mf.source_date, mf.content FROM fragment_entities fe
                    JOIN memory_fragments mf ON mf.id = fe.fragment_id
                    WHERE fe.entity_id IN (?, ?)
                    ORDER BY mf.source_date DESC LIMIT 6
                ) mf JOIN entity_profiles ep ON ep.id = mf.entity_id
            `).all(sp.a_id, sp.b_id);
            const evidence = evi.map(e => `  · [${String(e.source_date || '').slice(5)}][${e.name}] ${(e.content || '').slice(0, 90)}`).join('\n');

            const prompt = `記憶星系中有兩個星座，它們的時間線有交集（日期：${cand.days}），但記憶碎片互不重疊。

${sp.a_name} (${sp.a_cat}) ↔ ${sp.b_name} (${sp.b_cat})

它倆各自的近期素材（**這是給你判斷用的證據，不是讓你概括它**）：
${evidence || '  （沒有可用的素材）'}

⚠️ 判斷標準（關鍵）：**有沒有哪一件事，是同時涉及它倆的？**
· 「同一趟行程裡的兩個地點」「同一件事的當事人與其代理人」「同一場活動的場地與主辦方」→ 是同一件事 ✓
· 只是**日期湊巧重疊、各說各的** → 那不是關係，填 null

有關係嗎？一句話描述或填 null。只輸出JSON: {"related":true|false,"relation":"一句話關係描述"}`;

            try {
                const raw = await callLLM(
                    [{ role: 'user', parts: [{ text: prompt }] }],
                    null, null,
                    { temperature: 0.1, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } },
                    ARCHIVIST_LLM_CONFIG_ID
                );
                agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
                const jsonMatch = (raw?.reply || raw?.text || raw?.content || '').match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                const verdict = JSON.parse(jsonMatch[0]);
                if (verdict.related && verdict.relation && verdict.relation !== 'null') {
                    // 直接寫入 related_entities（不經過 LLM 批次呼叫——已有關係描述）
                    const aEnt = db.prepare('SELECT * FROM entity_profiles WHERE id = ?').get(sp.a_id);
                    const bEnt = db.prepare('SELECT * FROM entity_profiles WHERE id = ?').get(sp.b_id);
                    if (aEnt && bEnt) {
                        _writeEntityRelation(aEnt, bEnt, verdict.relation, 0);
                        _writeEntityRelation(bEnt, aEnt, verdict.relation, 0);
                        console.log(`[Archivist] 🔗 語義關係: ${sp.a_name} ↔ ${sp.b_name} — ${verdict.relation}`);
                        discovered++;
                    }
                }
            } catch (e) {
                console.error('[Archivist] 語義關係LLM失敗:', e.message);
            }
        }
    }

    if (pairs.length === 0) return { discovered };

    const getEnt = db.prepare('SELECT id, name, category, overview, related_entities FROM entity_profiles WHERE id = ?');
    // 找出還沒有關係描述的對
    const fresh = [];
    for (const p of pairs) {
        const a = getEnt.get(p.a_id), b = getEnt.get(p.b_id);
        if (!a || !b) continue;
        let aRel = [];
        try { aRel = JSON.parse(a.related_entities || '[]'); } catch (_) {}
        const existing = aRel.find(r => r.id === b.id);
        // 已有描述且共享數沒顯著增長 → 跳過
        if (existing && p.shared < (existing.shared_count || 0) * 1.5) continue;
        fresh.push({ a, b, shared: p.shared });
    }

    if (fresh.length === 0) return { discovered: 0 };
    if (!_canCallLLM(1)) return { discovered: 0 };

    const batch = fresh.slice(0, 10);
    // 給 LLM 每對附 2 條共享碎片做依據
    const pairBlocks = batch.map((p, i) => {
        const sharedFrags = db.prepare(`
            SELECT mf.content FROM memory_fragments mf
            JOIN fragment_entities f1 ON f1.fragment_id = mf.id AND f1.entity_id = ?
            JOIN fragment_entities f2 ON f2.fragment_id = mf.id AND f2.entity_id = ?
            LIMIT 2
        `).all(p.a.id, p.b.id);
        const evidence = sharedFrags.map(f => '  · ' + (f.content || '').slice(0, 100)).join('\n');
        return `[${i}] "${p.a.name}"(${p.a.category}) ↔ "${p.b.name}"(${p.b.category}) 共享${p.shared}條記憶:\n${evidence}`;
    }).join('\n\n');

    // 預檢：名字是子串關係的 pair（如"甲"是"甲乙"的子串）→ 加標記供 LLM 重點審查
    const suspiciousPairs = new Set();
    for (const p of batch) {
        const aName = p.a.name, bName = p.b.name;
        if (aName.length <= 3 && bName.length > aName.length && bName.includes(aName)) suspiciousPairs.add(batch.indexOf(p));
        if (bName.length <= 3 && aName.length > bName.length && aName.includes(bName)) suspiciousPairs.add(batch.indexOf(p));
    }

    const prompt = `以下實體對在 user 的記憶中共同出現。對每對，按順序做三件事：

**① 同名異物檢查**（警惕短名字是長名字的一部分，如"甲" vs "甲乙(某類店鋪)"不是一回事）。

**② ⚠️「同一件事」檢查（最關鍵的一步）**：這條共享碎片裡的**那件事**，是不是**同時涉及它倆**？
  · **是同一件事把兩者綁在一起** → 真關係 ✓
    例：同一趟行程的兩個地點、同一件事的當事人與其代理人、同一場活動的場地與主辦方
  · **只是一句話裡順口都提到了** → **那是一次共現，不是關係** → 填 null
    例：「在某個地方吃飯時提到某個人」「聊某個話題時扯到另一件事」——拿掉其中一個，
    這件事照樣成立，說明它只是被順口帶出來的
  **自檢一句話**：把這一個從這件事裡拿掉，這件事還成立嗎？成立 → 填 null。

**③ 都過了**，寫一句話關係描述（≤30字，**陳述事實**）。看不出實質關係填 null。

${pairBlocks}

只輸出JSON陣列: [{"pair":0,"verify":"ok|namesake|unrelated","relation":"一句話描述或null"}, ...]`;

    let items;
    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_LLM_CONFIG_ID
        );
        agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { discovered: 0 };
        items = JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('[Archivist] 關係發現 LLM 失敗:', e.message);
        return { discovered: 0 };
    }

    for (const item of items) {
        const p = batch[item.pair];
        if (!p) continue;

        // Skip namesake or unrelated verdicts
        if (item.verify === 'namesake' || item.verify === 'unrelated') {
            console.log(`[Archivist] ⏭️ 同名異物跳過: ${p.a.name} ↔ ${p.b.name} — ${item.verify}`);
            continue;
        }
        if (!item.relation || item.relation === 'null') continue;

        try {
            _writeEntityRelation(p.a, p.b, item.relation, p.shared);
            _writeEntityRelation(p.b, p.a, item.relation, p.shared);
            discovered++;
            console.log(`[Archivist] 🌉 實體關係: ${p.a.name} ↔ ${p.b.name} — ${item.relation}`);
        } catch (e) {
            console.error('[Archivist] 關係寫入失敗:', e.message);
        }
    }

    if (discovered > 0) {
        db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail) VALUES ('entity_bridges', NULL, ?)`)
            .run(JSON.stringify({ count: discovered }));
    }
    return { discovered };
}

module.exports = {
    _writeEntityRelation,
    _parseRelations,
    _writeRelations,
    _dropEntityRelation,
    RELATION_MAX_AGE_DAYS,
    RELATION_REVIEW_PER_RUN,
    reviewEntityRelations,
    TAG_RELATION_MAX_PER_RUN,
    discoverTagRelations,
    discoverRelatedEntities,
};
