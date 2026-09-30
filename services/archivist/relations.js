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
// v4.8: discoverRelatedEntities — 实体关系发现
//
// 共享碎片 ≥2 的实体对 → LLM 写一句关系描述 → 双方
// related_entities。星图桥线 + 聊天 entity context 共用。
// ═══════════════════════════════════════════════════════

// 写实体关系到双方 related_entities（新增或更新）
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
        if (dryRun) { dropped++; console.log(`[Archivist] ✂️ (dry) 断桥（对端${d.peerStatus}）: ${d.ent.name} ↔ ${d.rel.name}`); continue; }
        if (_dropEntityRelation(d.ent.id, d.rel.id)) dropped++;
        console.log(`[Archivist] ✂️ 断桥（对端${d.peerStatus}）: ${d.ent.name} ↔ ${d.rel.name} — 「${(d.rel.relation || '').slice(0, 30)}」`);
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
            return `【${ent.name}】(${ent.category})\n    近况：${st}\n    最近素材：\n${frags || '      （无）'}`;
        };

        const prompt = `有两个"记忆星座"，它们之间记着一条关系。请复审这条关系**现在还成不成立**。

${fmtSide(a)}

${fmtSide(b)}

记录的关系：「${q.rel.relation}」（当初共享 ${q.rel.shared_count || 0} 条记忆，最近一次共现：${q.days != null ? q.days + ' 天前' : '已经没有共现'}）

⚠️ 判据只有一条：**如果这两个星座从此不再关联，会影响其中一方「近况」的更新吗？**
  · **会影响** → 留着（同一位房东与住处、同一个项目的两个环节、天天在一起的人）
  · **不影响** → 断掉（某天顺路去过一次的地方、某句话里顺口提到的两只猫、一次性的活动参与）
    ——那类关系记在过去就够了，不需要一直挂在星座上

只输出JSON: {"keep":true|false,"why":"十个字以内"}`;

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
                console.log(`[Archivist] 🌉 复审判留${dryRun ? '(dry)' : ''}: ${a.name} ↔ ${b.name} — ${v.why || ''}`);
            } else {
                if (!dryRun) { _dropEntityRelation(a.id, b.id); _dropEntityRelation(b.id, a.id); }
                cut++;
                console.log(`[Archivist] ✂️ 断桥（复审）${dryRun ? '(dry)' : ''}: ${a.name} ↔ ${b.name} — ${v.why || ''}（原关系：「${(q.rel.relation || '').slice(0, 30)}」）`);
            }
        } catch (err) {
            console.error('[Archivist] 关系复审 LLM 失败:', err.message);
        }
    }

    // ── ③ whatever didn't fit in this run is only counted, not touched.
    //      Anything written into the DB needs something that eventually looks back at
    //      it; logging the backlog is the cheapest way to keep that visible. ──
    const backlog = queue.length - willReview.length;
    if (dropped || cut || kept || backlog) {
        console.log(`[Archivist] 🌉 关系表体检：露得出来的 ${totalLive} 条（含归档共 ${total}）→ 死指针摘 ${dropped} → 待复审 ${queue.length}（本轮判留 ${kept} / 断 ${cut}，还剩 ${backlog} 条排队）→ 共现还活的 ${alive.length} 条`);
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
// v5.4: discoverTagRelations — 第三条建关系的路（标签桥）
//
// 星座的 `tags` 是模型写的「这个星座是什么」。当某个 tag 正好是另一个星座的名字时，
// 那就是**这个星座自己认的关系**——而没有任何东西读它。
// 为什么需要它：另外两条路都会漏掉同一类结构——
//   · 共现路要求 shared >= 2。一个「作品与其出品方/平台」式的对子，素材里未必
//     有两条同时提到两者，于是永远够不到门槛。
//   · 语义兜底路的 category 白名单是 event/place/person，`consumed`/`project` 那侧
//     进不了候选池。
//
// ⚠️ 它**继承模型写 tags 时的毛病**，所以候选词要过跟别名链接器**同一套门**
//    （`_mentionWeight` / `_aliasAmbiguous` —— 同一个定义处，不另抄一份）。
//    真实数据上跑过一轮：19 条候选放行 12 / 挡掉 7，挡掉的正好包含一个错标签
//    （把一次跟某机构无关的事，标成了那个机构）——因为它只有两个字，跟泛称一个待遇。
//    **门比 prompt 有用：那条连 LLM 都没走到。**
// ⚠️ 写出来的关系要**盖 last_reviewed 章**：标签桥天然没有共现碎片，
//    reviewEntityRelations 判枯的判据是「现在一条都不共享」——不盖章的话，
//    下一轮刚建的桥就会被当枯桥重审然后断掉，**等于白建**。
// ⚠️ 不直接写库，仍然交给 LLM 写那一句话——它有权填 null（标签打错了就填 null）。
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
                // ⚠️ 已知的过度保守：`_aliasAmbiguous` 问的是「这个词跟*别的*实体的叫法
                //    互相包含吗」。这里 tag 已经解析到了 other，但守卫不知道 other 是
                //    "自己人"——所以当 other 自己另有一个短别名是它的子串时会误判。
                //    实数据上没咬到（19 条里 0 条），代价也只是"少建一条真桥"，
                //    按「宁可少一条真的，不要多一条假的」先留着。要修的话是给它加一个
                //    ignoreIds 参数，把 other.id 一起忽略掉。
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
        console.log(`[Archivist] 🏷️ 标签桥挡在门外 ${blocked.length} 个（跟别名链接器同一套门）：[${blocked.slice(0, 5).join(' ')}]`);
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
        return `「${ent.name}」(${ent.category})${st ? `\n    近况：${st}` : ''}${fr ? `\n    素材：\n${fr}` : ''}`;
    };
    const pairBlocks = batch.map((c, i) =>
        `[${i}] ${fmtSide(c.a)}\n    它的标签里写着 →「${c.tag}」\n${fmtSide(c.b)}`
    ).join('\n\n');

    const prompt = `下面每一对星座，是**其中一个的标签里写着另一个的名字**。标签是自动打的，
可能打错。请判断这个标签是不是真的指向某种关系，写一句话说明。

⚠️ 关系必须是**能一句话验证的事实**（同一个项目与其出品方、同一个人与其常住地、
同一件事与其发生场所）。写不出一句能验证的事实，就说明它其实没关系 → 填 null。
⚠️ **宁可空着，不要编一句听起来合理的。** 标签打错的情况真实存在（比如某家机构被
打上了"某次活动"的标签，而那次活动其实不在那家机构办的）——那种要填 null。

${pairBlocks}

只输出JSON数组: [{"pair":0,"relation":"一句话描述或null"}, ...]`;

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
        console.error('[Archivist] 标签桥 LLM 失败:', e.message);
        return { discovered: 0, blocked: blocked.length };
    }

    const stamp = new Date().toISOString().slice(0, 10);
    let discovered = 0;
    for (const item of items) {
        const c = batch[item.pair];
        if (!c) continue;
        if (!item.relation || item.relation === 'null') {
            console.log(`[Archivist] ⏭️ 标签桥不成关系: ${c.a.name} --「${c.tag}」--> ${c.b.name}`);
            continue;
        }
        const rel = String(item.relation).slice(0, 60);
        if (dryRun) {
            console.log(`[Archivist] 🏷️ (dry) 标签桥: ${c.a.name} ↔ ${c.b.name} — ${rel}`);
            discovered++;
            continue;
        }
        try {
            _writeEntityRelation(c.a, c.b, rel, 0, { reviewed: stamp });
            _writeEntityRelation(c.b, c.a, rel, 0, { reviewed: stamp });
            discovered++;
            console.log(`[Archivist] 🏷️ 标签桥: ${c.a.name} ↔ ${c.b.name} — ${rel}`);
        } catch (e) {
            console.error('[Archivist] 标签桥写入失败:', e.message);
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
        console.error('[Archivist] 关系表体检失败:', e.message);
    }

    // Tag bridges are an INDEPENDENT path, so they're called here — the co-occurrence
    // section below has several early returns (`pairs.length === 0`, `fresh.length === 0`,
    // LLM failure), and anything hung off its tail never runs on cycles where
    // co-occurrence comes up empty.
    try {
        const tagRes = await discoverTagRelations();
        discovered += (tagRes?.discovered || 0);
    } catch (e) {
        console.error('[Archivist] 标签桥失败:', e.message);
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

    // 语义关系检测：零共享碎片但有日期重叠的实体对 → LLM 判断
    // （某地之旅 vs 某景点 — 碎片内容不重叠但属于同一旅行）
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
        `).all();

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

            // ⚠️ 给它**证据**。原来这个 prompt 只给"两个名字 + 日期交集"，一条素材都不给
            //    ——于是模型只能**编一句听起来合理的**。判关系不给证据 = 让它猜。
            const evi = db.prepare(`
                SELECT ep.name, mf.source_date, mf.content FROM (
                    SELECT fe.entity_id, mf.source_date, mf.content FROM fragment_entities fe
                    JOIN memory_fragments mf ON mf.id = fe.fragment_id
                    WHERE fe.entity_id IN (?, ?)
                    ORDER BY mf.source_date DESC LIMIT 6
                ) mf JOIN entity_profiles ep ON ep.id = mf.entity_id
            `).all(sp.a_id, sp.b_id);
            const evidence = evi.map(e => `  · [${String(e.source_date || '').slice(5)}][${e.name}] ${(e.content || '').slice(0, 90)}`).join('\n');

            const prompt = `记忆星系中有两个星座，它们的时间线有交集（日期：${cand.days}），但记忆碎片互不重叠。

${sp.a_name} (${sp.a_cat}) ↔ ${sp.b_name} (${sp.b_cat})

它俩各自的近期素材（**这是给你判断用的证据，不是让你概括它**）：
${evidence || '  （没有可用的素材）'}

⚠️ 判断标准（关键）：**有没有哪一件事，是同时涉及它俩的？**
· 「同一趟行程里的两个地点」「同一件事的当事人与其代理人」「同一场活动的场地与主办方」→ 是同一件事 ✓
· 只是**日期凑巧重叠、各说各的** → 那不是关系，填 null

有关系吗？一句话描述或填 null。只输出JSON: {"related":true|false,"relation":"一句话关系描述"}`;

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
                    // 直接写入 related_entities（不经过 LLM 批量调用——已有关系描述）
                    const aEnt = db.prepare('SELECT * FROM entity_profiles WHERE id = ?').get(sp.a_id);
                    const bEnt = db.prepare('SELECT * FROM entity_profiles WHERE id = ?').get(sp.b_id);
                    if (aEnt && bEnt) {
                        _writeEntityRelation(aEnt, bEnt, verdict.relation, 0);
                        _writeEntityRelation(bEnt, aEnt, verdict.relation, 0);
                        console.log(`[Archivist] 🔗 语义关系: ${sp.a_name} ↔ ${sp.b_name} — ${verdict.relation}`);
                        discovered++;
                    }
                }
            } catch (e) {
                console.error('[Archivist] 语义关系LLM失败:', e.message);
            }
        }
    }

    if (pairs.length === 0) return { discovered };

    const getEnt = db.prepare('SELECT id, name, category, overview, related_entities FROM entity_profiles WHERE id = ?');
    // 找出还没有关系描述的对
    const fresh = [];
    for (const p of pairs) {
        const a = getEnt.get(p.a_id), b = getEnt.get(p.b_id);
        if (!a || !b) continue;
        let aRel = [];
        try { aRel = JSON.parse(a.related_entities || '[]'); } catch (_) {}
        const existing = aRel.find(r => r.id === b.id);
        // 已有描述且共享数没显著增长 → 跳过
        if (existing && p.shared < (existing.shared_count || 0) * 1.5) continue;
        fresh.push({ a, b, shared: p.shared });
    }

    if (fresh.length === 0) return { discovered: 0 };
    if (!_canCallLLM(1)) return { discovered: 0 };

    const batch = fresh.slice(0, 10);
    // 给 LLM 每对附 2 条共享碎片做依据
    const pairBlocks = batch.map((p, i) => {
        const sharedFrags = db.prepare(`
            SELECT mf.content FROM memory_fragments mf
            JOIN fragment_entities f1 ON f1.fragment_id = mf.id AND f1.entity_id = ?
            JOIN fragment_entities f2 ON f2.fragment_id = mf.id AND f2.entity_id = ?
            LIMIT 2
        `).all(p.a.id, p.b.id);
        const evidence = sharedFrags.map(f => '  · ' + (f.content || '').slice(0, 100)).join('\n');
        return `[${i}] "${p.a.name}"(${p.a.category}) ↔ "${p.b.name}"(${p.b.category}) 共享${p.shared}条记忆:\n${evidence}`;
    }).join('\n\n');

    // 预检：名字是子串关系的 pair（如"甲"是"甲乙"的子串）→ 加标记供 LLM 重点审查
    const suspiciousPairs = new Set();
    for (const p of batch) {
        const aName = p.a.name, bName = p.b.name;
        if (aName.length <= 3 && bName.length > aName.length && bName.includes(aName)) suspiciousPairs.add(batch.indexOf(p));
        if (bName.length <= 3 && aName.length > bName.length && aName.includes(bName)) suspiciousPairs.add(batch.indexOf(p));
    }

    const prompt = `以下实体对在 user 的记忆中共同出现。对每对，按顺序做三件事：

**① 同名异物检查**（警惕短名字是长名字的一部分，如"甲" vs "甲乙(某类店铺)"不是一回事）。

**② ⚠️「同一件事」检查（最关键的一步）**：这条共享碎片里的**那件事**，是不是**同时涉及它俩**？
  · **是同一件事把两者绑在一起** → 真关系 ✓
    例：同一趟行程的两个地点、同一件事的当事人与其代理人、同一场活动的场地与主办方
  · **只是一句话里顺口都提到了** → **那是一次共现，不是关系** → 填 null
    例：「在某个地方吃饭时提到某个人」「聊某个话题时扯到另一件事」——拿掉其中一个，
    这件事照样成立，说明它只是被顺口带出来的
  **自检一句话**：把这一个从这件事里拿掉，这件事还成立吗？成立 → 填 null。

**③ 都过了**，写一句话关系描述（≤30字，**陈述事实**）。看不出实质关系填 null。

${pairBlocks}

只输出JSON数组: [{"pair":0,"verify":"ok|namesake|unrelated","relation":"一句话描述或null"}, ...]`;

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
        console.error('[Archivist] 关系发现 LLM 失败:', e.message);
        return { discovered: 0 };
    }

    for (const item of items) {
        const p = batch[item.pair];
        if (!p) continue;

        // Skip namesake or unrelated verdicts
        if (item.verify === 'namesake' || item.verify === 'unrelated') {
            console.log(`[Archivist] ⏭️ 同名异物跳过: ${p.a.name} ↔ ${p.b.name} — ${item.verify}`);
            continue;
        }
        if (!item.relation || item.relation === 'null') continue;

        try {
            _writeEntityRelation(p.a, p.b, item.relation, p.shared);
            _writeEntityRelation(p.b, p.a, item.relation, p.shared);
            discovered++;
            console.log(`[Archivist] 🌉 实体关系: ${p.a.name} ↔ ${p.b.name} — ${item.relation}`);
        } catch (e) {
            console.error('[Archivist] 关系写入失败:', e.message);
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
