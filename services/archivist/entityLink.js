// =================================================================
// services/archivist/entityLink.js — 碎片連實體：字面提及自動連結（別名三道門）、值標路由聚合星座
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { getTagRouting } = require('../tagRouting');
const { SKIP_NAMES } = require('../memoryConfig');
const { SKIP_PH } = require('./constants');


// ═══════════════════════════════════════════════════════
// Lightweight auto-link: literal entity name mentions → fragment_entities
// ================================================================
// Pure SQL LIKE match, zero LLM, zero ChromaDB.
// Seeds stuck at fc=2 need just ONE more fragment to cross graduation
// threshold. This finds literal mentions that keyword classification missed.
// Low confidence (0.40) = not LLM-verified. Deep cycle rematch upgrades to 0.60+.
// ═══════════════════════════════════════════════════════

const AUTO_LINK_CONFIDENCE = 0.40;

const AUTO_LINK_CLASSIFIER = 'auto_literal';

const AUTO_LINK_MAX_PER_ENTITY = 5;  // max new links per entity per run (prevent flooding)

// Aliases go through three gates before they're allowed to literal-match.
// Without them an alias list is a vacuum cleaner: LLM-written alias lists reliably
// contain generic words (a common noun for the user's profession, a district name,
// a topic word) that would each pull in dozens or hundreds of fragments.
const AUTO_LINK_ALIAS_MIN_WEIGHT = 3; // minimum "information weight" of an alias (CJK char 1, latin 0.5)

const AUTO_LINK_ALIAS_MAX_HITS = 8;   // more hits than this = a generic term, not a proper name


// Information weight: three latin letters carry about as much as one CJK character,
// so don't cut on raw character count. A 3-letter given name scores 2 (rejected);
// a 4-CJK-character title scores 4 (allowed).
function _mentionWeight(s) {
    let w = 0;
    for (const ch of String(s)) {
        if (/[぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(ch)) w += 1;
        else if (/\s/.test(ch)) continue;
        else w += 0.5;
    }
    return w;
}


// Every name and alias in the library (lowercased) → the set of entities that own it.
// Used to decide whether an alias is ambiguous.
function _entityMentionOwners(db) {
    const rows = db.prepare(`SELECT id, name, aliases FROM entity_profiles WHERE status IN ('seed','active')`).all();
    const owners = new Map();
    const put = (k, id) => {
        const s = String(k || '').toLowerCase().trim();
        if (s.length < 2) return;
        if (!owners.has(s)) owners.set(s, new Set());
        owners.get(s).add(id);
    };
    for (const r of rows) {
        put(r.name, r.id);
        try { for (const a of JSON.parse(r.aliases || '[]')) put(a, r.id); } catch (_) {}
    }
    return owners;
}


// Is this alias mutually contained with some *other* entity's name/alias?
// e.g. a district alias inside another entity's "district + venue" name → ambiguous
// reference, unusable. Containment within its own entity's callings doesn't count.
function _aliasAmbiguous(entId, alias, owners) {
    const key = String(alias).toLowerCase().trim();
    for (const [k, ids] of owners) {
        if (k === key) continue;
        if (k.includes(key) || key.includes(k)) {
            for (const id of ids) if (id !== entId) return true;
        }
    }
    return false;
}


function autoLinkLiteralMentions({ dryRun = false } = {}) {
    const db = getDb();

    // Find fragments that literally contain an entity name but aren't linked yet
    // Exclude music/book (data exhaust) and SKIP_NAMES (User/Companion handled separately)
    const seeds = db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.aliases, ep.fragment_count
        FROM entity_profiles ep
        WHERE ep.status IN ('seed', 'active')
          AND ep.name NOT IN (${SKIP_PH})
          AND ep.category NOT LIKE '%aggregate%'
          AND length(ep.name) >= 2
        ORDER BY ep.fragment_count ASC
    `).all(...SKIP_NAMES);

    if (seeds.length === 0) return { linked: 0 };

    // Match terms = the name (as before) + aliases that pass the gates.
    // An alias exists for exactly one reason: "another way of calling the same thing".
    // If the linker only ever looks at `name`, every alias is dead weight — the
    // library says "call it X or Y" and the linker only ever matches X.
    const owners = _entityMentionOwners(db);
    const countHits = db.prepare(`
        SELECT COUNT(*) n FROM memory_fragments mf
        WHERE mf.content LIKE ? AND mf.status = 'active'
          AND mf.source NOT IN ('music', 'book')
          AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
    `);
    const rejected = { short: [], ambiguous: [], magnet: [] };
    const candidates = [];
    for (const s of seeds) {
        const terms = [s.name];
        let aliases = [];
        try { aliases = JSON.parse(s.aliases || '[]'); } catch (_) {}
        for (const raw of aliases) {
            const t = String(raw || '').trim();
            if (!t || t.toLowerCase() === s.name.toLowerCase()) continue;
            if (_mentionWeight(t) < AUTO_LINK_ALIAS_MIN_WEIGHT) { rejected.short.push(`${s.name}←${t}`); continue; }
            if (_aliasAmbiguous(s.id, t, owners)) { rejected.ambiguous.push(`${s.name}←${t}`); continue; }
            const hits = countHits.get('%' + t + '%', s.id).n;
            if (hits === 0) continue;
            if (hits > AUTO_LINK_ALIAS_MAX_HITS) { rejected.magnet.push(`${s.name}←${t}(${hits})`); continue; }
            terms.push(t);
        }
        candidates.push({ id: s.id, name: s.name, terms });
    }

    let totalLinked = 0, aliasLinked = 0;
    const insertFe = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, ?, ?)');
    const updateFc = db.prepare('UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?');
    const findFrags = db.prepare(`
        SELECT mf.id FROM memory_fragments mf
        WHERE mf.content LIKE ? AND mf.status = 'active'
          AND mf.source NOT IN ('music', 'book')
          AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
        ORDER BY mf.id DESC
        LIMIT ?
    `);

    const writeAll = db.transaction(() => {
        for (const s of candidates) {
            // Name and aliases share one budget — otherwise an entity gets 5 more
            // links for free just by having aliases.
            let budget = AUTO_LINK_MAX_PER_ENTITY;
            let touched = false;
            for (let ti = 0; ti < s.terms.length && budget > 0; ti++) {
                const frags = findFrags.all('%' + s.terms[ti] + '%', s.id, budget);
                if (frags.length === 0) continue;
                touched = true;
                for (const f of frags) {
                    if (dryRun) {
                        totalLinked++; budget--; if (ti > 0) aliasLinked++;
                        console.log(`[Archivist] 🔗 (dry) ${ti > 0 ? `alias「${s.terms[ti]}」` : 'name'} → ${s.name}: fragment #${f.id}`);
                        continue;
                    }
                    const r = insertFe.run(f.id, s.id, AUTO_LINK_CONFIDENCE, AUTO_LINK_CLASSIFIER);
                    if (r.changes > 0) { totalLinked++; budget--; if (ti > 0) aliasLinked++; }
                }
            }
            if (touched && !dryRun) updateFc.run(s.id, s.id);
        }
    });

    try {
        writeAll();
    } catch (e) {
        console.error('[Archivist] autoLinkLiteralMentions 写入失败:', e.message);
        return { linked: 0, error: e.message };
    }

    if (totalLinked > 0) {
        console.log(`[Archivist] 🔗 字面自动链接: ${totalLinked} 条 (${AUTO_LINK_CONFIDENCE} conf, 零LLM；其中靠别名 ${aliasLinked} 条)`);
    }
    if (rejected.magnet.length || rejected.ambiguous.length) {
        // Log what was turned away — otherwise nobody can tell how many aliases are dead weight.
        console.log(`[Archivist] 🧲 别名挡在门外：泛称 ${rejected.magnet.length} 个 [${rejected.magnet.slice(0, 5).join(' ')}] · 指代不明 ${rejected.ambiguous.length} 个 [${rejected.ambiguous.slice(0, 5).join(' ')}] · 太短 ${rejected.short.length} 个`);
    }
    return { linked: totalLinked, aliasLinked };
}


// ═══════════════════════════════════════════════════════
// Aggregate linker: route music/book fragments to their aggregate entities
// ================================================================
// Music/book fragments are excluded from star map classification
// (they're data exhaust, not memory about people/places/events).
// Instead of leaving them unlinked, route them to aggregate entities
// (音乐 / 共读) so they have a home and can be searched.
// Pure SQL, zero LLM, zero ChromaDB.
// ═══════════════════════════════════════════════════════

const AGGREGATE_MAP = (() => {
    try {
        const cfg = require('../../memory_config.json');
        const routing = cfg.source_routing || {};
        // Validate: must be object with string→string mappings
        if (typeof routing === 'object' && !Array.isArray(routing)) {
            const map = {};
            for (const [src, name] of Object.entries(routing)) {
                if (typeof src === 'string' && typeof name === 'string' && src !== '_comment') {
                    map[src] = name;
                }
            }
            return map;
        }
    } catch (_) {}
    return {};
})();


// ── 按值标路由的聚合星座（2026-09-28 做成配置驱动）────────────────
//
// ⚠️ 这类星座的形状（一个"行为/状态类别"）**正是涌现判据要拒的那一类**。它们能成立，
//    是因为走的是**代码路由**：Scribe 提取时打一个值标，代码按标直连——
//    **不是涌现检测 LLM 拍脑袋起的名字**。两者别混，看到它们别当漏网之鱼删了。
//
// 有哪些标、各自默认叫什么名字、放哪个星系：**唯一定义在 services/tagRouting.js**。
// 用户要哪几颗、叫什么，写在 memory_config.json 的 `tag_routing` 里。
//
// ⚠️ **为什么必须"入库即建链"、不能等分类管线：** 分类管线的入口要求
//    `status = 'active'`，而整合（Consolidator）把跑过的碎片改成 `consolidated`——
//    两条管线抢同一批碎片，谁先到谁说了算。实测（2026-09-28）：consolidated 的碎片
//    2030 条里 **1078 条没有任何星座链接**（active 里只有 33 条）。也就是说**碎片一旦
//    被写成 episode 就永久退出分类管线**，而先被整合的恰恰是"一条完整的故事"。
//    链接只能在写入那一刻就打——`services/scribe.js` 的插入循环里调 linkTaggedFragment。

function ensureTagEntity(db, def) {
    const e = db.prepare(`SELECT id FROM entity_profiles WHERE name = ?`).get(def.name);
    if (e) return e.id;
    // ⚠️ 不给短词别名：聚合星座的 aliases 会被 autoLinkLiteralMentions 之外的路径读到，
    //    而给一个像「亲密」「身体」这样的短词，`LIKE '%身体%'` 会把全库相关描述都吸进来
    //    （同「日晚」那次：一个词性的实体名吸了 198 条碎片）。名字本身够用了。
    const r = db.prepare(`
        INSERT INTO entity_profiles (name, category, status, tags)
        VALUES (?, ?, 'active', ?)
    `).run(def.name, def.category, JSON.stringify([def.label || def.tag, 'aggregate']));
    console.log(`[Archivist] 💠 建聚合星座「${def.name}」(${def.tag}, id=${r.lastInsertRowid})`);
    return r.lastInsertRowid;
}


// 建齐配置里声明的那几颗（启动时/补漏时调，幂等）
function ensureTagEntities(db) {
    const out = {};
    for (const def of getTagRouting()) {
        try { out[def.tag] = ensureTagEntity(db, def); }
        catch (e) { console.warn(`[Archivist] 建「${def.name}」失败: ${e.message}`); }
    }
    return out;
}


// 把一条碎片按它的值标链到对应星座。**Scribe 写完碎片立刻调**（不等分类、不等整合）。
function linkTaggedFragment(db, fragmentId, valueTags) {
    const defs = getTagRouting();
    if (defs.length === 0) return 0;
    const tags = Array.isArray(valueTags) ? valueTags : [];
    let linked = 0;
    for (const def of defs) {
        if (!tags.includes(def.tag)) continue;
        try {
            const eid = ensureTagEntity(db, def);
            const r = db.prepare(`
                INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by)
                VALUES (?, ?, 0.85, 'tag_routing')
            `).run(fragmentId, eid);
            if (r.changes > 0) linked++;
        } catch (e) {
            console.warn(`[Archivist] 标路由链接失败 frag#${fragmentId} (${def.tag}): ${e.message}`);
        }
    }
    return linked;
}


// 补漏：把历史上打过这些标、但还没链上的碎片补上（星座是后建的、或当初写库失败）。
// 与 linkAggregateFragments 同一个位置被调用。**不看 status** —— consolidated 的也要补，
// 否则"入库即建"上线之前的存量永远进不来。
function linkTaggedFragments(db) {
    const defs = getTagRouting();
    if (defs.length === 0) return { linked: 0 };
    let total = 0;
    for (const def of defs) {
        try {
            const eid = ensureTagEntity(db, def);
            const rows = db.prepare(`
                SELECT mf.id FROM memory_fragments mf
                WHERE mf.value_tags LIKE ?
                  AND mf.status IN ('active', 'consolidated', 'cooling')
                  AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                LIMIT 200
            `).all(`%"${def.tag}"%`, eid);
            const ins = db.prepare(`INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by) VALUES (?, ?, 0.85, 'tag_routing')`);
            let n = 0;
            for (const r of rows) if (ins.run(r.id, eid).changes > 0) n++;
            if (n > 0) {
                db.prepare(`UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?`).run(eid, eid);
                console.log(`[Archivist] 💠 ${def.name} 补链: ${n} 条`);
            }
            total += n;
        } catch (e) {
            console.warn(`[Archivist] 标路由补链失败 (${def.tag}):`, e.message);
        }
    }
    return { linked: total };
}


function linkAggregateFragments() {
    const db = getDb();
    let totalLinked = 0;

    const insertFe = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by) VALUES (?, ?, 0.60, ?)');
    const updateFc = db.prepare('UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?');

    const writeAll = db.transaction(() => {
        for (const [source, entityName] of Object.entries(AGGREGATE_MAP)) {
            const entity = db.prepare("SELECT id FROM entity_profiles WHERE name = ? AND status = 'active'").get(entityName);
            if (!entity) continue;

            const frags = db.prepare(`
                SELECT mf.id FROM memory_fragments mf
                WHERE mf.source = ? AND mf.status = 'active'
                  AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                LIMIT 50
            `).all(source, entity.id);

            for (const f of frags) {
                const r = insertFe.run(f.id, entity.id, 'aggregate_link');
                if (r.changes > 0) totalLinked++;
            }

            if (frags.length > 0) updateFc.run(entity.id, entity.id);
        }
    });

    try {
        writeAll();
    } catch (e) {
        console.error('[Archivist] linkAggregateFragments 写入失败:', e.message);
        return { linked: 0, error: e.message };
    }

    if (totalLinked > 0) {
        console.log(`[Archivist] 📦 聚合归位: ${totalLinked} 条 music/book 碎片`);
    }
    return { linked: totalLinked };
}

module.exports = {
    AUTO_LINK_CONFIDENCE,
    AUTO_LINK_CLASSIFIER,
    AUTO_LINK_MAX_PER_ENTITY,
    AUTO_LINK_ALIAS_MIN_WEIGHT,
    AUTO_LINK_ALIAS_MAX_HITS,
    _mentionWeight,
    _entityMentionOwners,
    _aliasAmbiguous,
    autoLinkLiteralMentions,
    AGGREGATE_MAP,
    ensureTagEntity,
    ensureTagEntities,
    linkTaggedFragment,
    linkTaggedFragments,
    linkAggregateFragments,
};
