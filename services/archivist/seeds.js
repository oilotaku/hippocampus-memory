// =================================================================
// services/archivist/seeds.js — 種子星座：重複種子合併、實體合併執行、種子畢業與修剪
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { WORLD_CONTEXT } = require('../worldContext');
const { SKIP_NAMES } = require('../memoryConfig');
const { SKIP_PH, ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { agentState, _canCallLLM } = require('./runtime');
const { _nameBigrams } = require('./guards');



async function mergeDuplicateSeeds() {
    const db = getDb();

    const seeds = db.prepare(`
        SELECT id, name, category, fragment_count, aliases, overview
        FROM entity_profiles
        WHERE status IN ('seed', 'active') AND name NOT IN (${SKIP_PH})
          AND category NOT LIKE '%aggregate%'
    `).all(...SKIP_NAMES);

    // 泛指词检测：被 ≥2 个其他实体名包含的短名（「办公室」⊂ 公司A+公司B）
    // 是类目词不是具体实体，与它的包含关系不构成同一性。
    const genericNames = new Set();
    for (const s of seeds) {
        if (typeof s.name !== 'string') continue;
        const sn = s.name.toLowerCase();
        let containers = 0;
        for (const o of seeds) {
            if (typeof o.name !== 'string') continue;
            if (o.id !== s.id && o.name.toLowerCase().includes(sn)) containers++;
        }
        if (containers >= 2) genericNames.add(s.id);
    }

    // ── v5.6 确定性别名合并：A.name ∈ B.aliases 或反之 → 零LLM直接合并 ──
    // 覆盖跨文字系统（中文/拉丁/日文）的别名链路。
    // aliases 是之前 LLM 运行已认定的等价关系，确定性 100%，不需要再验证。
    let aliasMerged = 0;
    const aliasSuperseded = new Set();
    for (let i = 0; i < seeds.length; i++) {
        if (aliasSuperseded.has(seeds[i].id)) continue;
        for (let j = i + 1; j < seeds.length; j++) {
            if (aliasSuperseded.has(seeds[j].id)) continue;
            const a = seeds[i], b = seeds[j];
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;

            let aAliases = [], bAliases = [];
            try { aAliases = JSON.parse(a.aliases || '[]'); } catch (_) {}
            try { bAliases = JSON.parse(b.aliases || '[]'); } catch (_) {}

            const aNameLower = a.name.toLowerCase().trim();
            const bNameLower = b.name.toLowerCase().trim();

            const aInBAliases = bAliases.some(x => typeof x === 'string' && x.toLowerCase().trim() === aNameLower);
            const bInAAliases = aAliases.some(x => typeof x === 'string' && x.toLowerCase().trim() === bNameLower);

            if (!aInBAliases && !bInAAliases) continue;

            const [winner, loser] = a.fragment_count >= b.fragment_count ? [a, b] : [b, a];
            const reason = aInBAliases && bInAAliases ? '双向别名' : (aInBAliases ? `"${a.name}"是"${b.name}"的别名` : `"${b.name}"是"${a.name}"的别名`);

            db.prepare(`UPDATE OR IGNORE fragment_entities SET entity_id = ? WHERE entity_id = ?`)
                .run(winner.id, loser.id);
            db.prepare(`DELETE FROM fragment_entities WHERE entity_id = ?`).run(loser.id);

            const wAliases = (() => { try { return JSON.parse(winner.aliases || '[]'); } catch (_) { return []; } })();
            const lAliases = (() => { try { return JSON.parse(loser.aliases || '[]'); } catch (_) { return []; } })();
            const wTags = (() => { try { return JSON.parse(winner.tags || '[]'); } catch (_) { return []; } })();
            const lTags = (() => { try { return JSON.parse(loser.tags || '[]'); } catch (_) { return []; } })();
            let mergedAliases = [...new Set([...wAliases, ...lAliases, loser.name])];
            mergedAliases = mergedAliases.filter(a => typeof a === 'string' && a.toLowerCase().trim() !== winner.name.toLowerCase().trim());
            mergedAliases = mergedAliases.slice(0, 8);
            const mergedTags = [...new Set([...wTags, ...lTags])].slice(0, 8);

            db.prepare(`UPDATE entity_profiles SET aliases=?, tags=?, fragment_count=(SELECT COUNT(*) FROM fragment_entities WHERE entity_id=?), updated_at=datetime('now') WHERE id=?`)
                .run(JSON.stringify(mergedAliases), JSON.stringify(mergedTags), winner.id, winner.id);
            db.prepare(`UPDATE entity_profiles SET status='superseded', updated_at=datetime('now') WHERE id=?`).run(loser.id);

            console.log(`[Archivist] 🔗 别名合并: "${loser.name}" → "${winner.name}" (${reason})`);
            aliasSuperseded.add(loser.id);
            aliasMerged++;

            a.fragment_count = winner.id === a.id ? Math.max(a.fragment_count, b.fragment_count) : a.fragment_count;
            b.fragment_count = winner.id === b.id ? Math.max(a.fragment_count, b.fragment_count) : b.fragment_count;
        }
    }
    if (aliasMerged > 0) return { merged: aliasMerged, reason: 'alias_deterministic' };

    // 候选对：同 category 且名字包含/bigram 相似
    const pairs = [];
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i], b = seeds[j];
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (a.category !== b.category) continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;
            // 候选对只由名字关系产生。共享碎片不是同一性证据——
            // 同一碎片提到两只猫/两个人是跨实体多挂的 feature，那是
            // discoverRelatedEntities（关系桥）的领域。
            // 名字互相包含（处理「Alex」vs「Al」这类单字/昵称，bigram 算不出）
            const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
            if (an.includes(bn) || bn.includes(an)) { pairs.push({ a, b, nameContained: true, reason: '名字包含' }); continue; }
            const ga = _nameBigrams(a.name), gb = _nameBigrams(b.name);
            if (ga.size === 0 || gb.size === 0) continue;
            let overlap = 0;
            for (const g of ga) if (gb.has(g)) overlap++;
            const ratio = overlap / Math.min(ga.size, gb.size);
            if (ratio >= 0.5) pairs.push({ a, b, nameContained: false, reason: `名字相似${(ratio * 100).toFixed(0)}%` });
        }
    }

    // 跨语言/缩写候选：同类别、零文本重叠、但共享碎片 ≥1 →
    // LLM 判断是否为同一实体的别称（甲=甲的别称, 乙=乙的别称）
    const crossLangCandidates = [];
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i], b = seeds[j];
            if (a.category !== b.category) continue;
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;
            const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
            // 跳过已有文本重叠的（已被上面的逻辑覆盖）
            if (an.includes(bn) || bn.includes(an)) continue;
            const ga = _nameBigrams(a.name), gb = _nameBigrams(b.name);
            if (ga.size > 0 && gb.size > 0) {
                let overlap = 0;
                for (const g of ga) if (gb.has(g)) overlap++;
                if (overlap / Math.min(ga.size, gb.size) >= 0.5) continue; // 已有文本匹配
            }
            // 零文本重叠 + 同类别 → LLM 别称判断候选
            crossLangCandidates.push({ a, b });
        }
    }

    // ── v5.5 碎片重叠路径: 共享碎片 ≥50% 直接合并（零 LLM）──
    // 覆盖「甲 vs 乙」名字完全不同 + 「甲乙 vs 甲乙丙」跨category 情况
    let overlapMerged = 0;
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i], b = seeds[j];
            const crossCategory = a.category !== b.category;
            const overlapThreshold = crossCategory ? 0.75 : 0.5;
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;
            // Skip pairs already caught by name similarity (same-category only)
            if (!crossCategory) {
                const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
                if (an.includes(bn) || bn.includes(an)) continue;
                const ga = _nameBigrams(a.name), gb = _nameBigrams(b.name);
                if (ga.size > 0 && gb.size > 0) {
                    let nOverlap = 0;
                    for (const g of ga) if (gb.has(g)) nOverlap++;
                    if (nOverlap / Math.min(ga.size, gb.size) >= 0.5) continue;
                }
            }

            const overlap = db.prepare(`
                SELECT COUNT(*) as c FROM fragment_entities fe1
                JOIN fragment_entities fe2 ON fe1.fragment_id = fe2.fragment_id
                WHERE fe1.entity_id = ? AND fe2.entity_id = ?
            `).get(a.id, b.id)?.c || 0;

            const minFrags = Math.min(a.fragment_count, b.fragment_count);
            if (minFrags > 0 && overlap / minFrags >= overlapThreshold) {
                const [winner, loser] = a.fragment_count >= b.fragment_count ? [a, b] : [b, a];
                db.prepare(`UPDATE OR IGNORE fragment_entities SET entity_id = ? WHERE entity_id = ?`)
                    .run(winner.id, loser.id);
                db.prepare(`DELETE FROM fragment_entities WHERE entity_id = ?`).run(loser.id);
                const wAliases = (() => { try { return JSON.parse(winner.aliases || '[]'); } catch(_) { return []; } })();
                const lAliases = (() => { try { return JSON.parse(loser.aliases || '[]'); } catch(_) { return []; } })();
                const wTags = (() => { try { return JSON.parse(winner.tags || '[]'); } catch(_) { return []; } })();
                const lTags = (() => { try { return JSON.parse(loser.tags || '[]'); } catch(_) { return []; } })();
                let mergedAliases = [...new Set([...wAliases, ...lAliases])];
                if (crossCategory && loser.name && !mergedAliases.some(a => a.toLowerCase().trim() === loser.name.toLowerCase().trim())) {
                    mergedAliases.unshift(loser.name);
                }
                mergedAliases = mergedAliases.slice(0, 8);
                const mergedTags = [...new Set([...wTags, ...lTags])].slice(0, 8);
                db.prepare(`UPDATE entity_profiles SET aliases=?, tags=?, fragment_count=(SELECT COUNT(*) FROM fragment_entities WHERE entity_id=?), updated_at=datetime('now') WHERE id=?`)
                    .run(JSON.stringify(mergedAliases), JSON.stringify(mergedTags), winner.id, winner.id);
                db.prepare(`UPDATE entity_profiles SET status='superseded', updated_at=datetime('now') WHERE id=?`).run(loser.id);
                console.log(`[Archivist] 🔗 碎片重叠合并: "${loser.name}" → "${winner.name}" (重叠${overlap}/${minFrags}=${Math.round(overlap/minFrags*100)}%)`);
                overlapMerged++;
            }
        }
    }
    if (overlapMerged > 0) return { merged: overlapMerged, reason: 'fragment_overlap' };

    // 每轮最多问 LLM 3 对（控制成本）
    let llmAliasChecked = 0;
    for (const cand of crossLangCandidates) {
        if (llmAliasChecked >= 3) break;
        if (!_canCallLLM(1)) break;

        const prompt = `记忆星系中有两个同属「${cand.a.category}」类别的星座，名字完全不同。请判断它们是否指同一个实体（只是用了不同的名称/别名/语言）。

A: ${cand.a.name} (${cand.a.category}, ${cand.a.fragment_count}条碎片)
B: ${cand.b.name} (${cand.b.category}, ${cand.b.fragment_count}条碎片)

它们是同一个实体吗？只输出JSON: {"same":true|false,"reason":"一句话"}`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT, null,
                { temperature: 0.1, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            llmAliasChecked++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const verdict = JSON.parse(jsonMatch[0]);
            if (verdict.same) {
                pairs.push({ a: cand.a, b: cand.b, nameContained: false, reason: `LLM别名: ${verdict.reason}` });
                console.log(`[Archivist] 🔗 LLM别名检测: ${cand.a.name} = ${cand.b.name} — ${verdict.reason}`);
            }
        } catch (e) {
            console.error('[Archivist] LLM别名检测失败:', e.message);
        }
    }

    // 时间线检测：同类别事件/地点，碎片日期高度重叠 → LLM 判断是否同一事件
    // （「某日展会」和「某日展会活动」名字重叠但共享碎片为零，需日期证据）
    const getFragDates = db.prepare(`
        SELECT DISTINCT substr(mf.source_date,1,10) as day
        FROM memory_fragments mf
        JOIN fragment_entities fe ON mf.id = fe.fragment_id
        WHERE fe.entity_id = ?
        ORDER BY day
    `);
    const alreadyPaired = new Set();
    for (const p of pairs) { alreadyPaired.add(`${p.a.id}-${p.b.id}`); alreadyPaired.add(`${p.b.id}-${p.a.id}`); }

    let timeChecked = 0;
    for (let i = 0; i < seeds.length && timeChecked < 2; i++) {
        for (let j = i + 1; j < seeds.length && timeChecked < 2; j++) {
            const a = seeds[i], b = seeds[j];
            if (a.category !== b.category) continue;
            if (a.category !== 'event' && a.category !== 'place') continue; // 只有事件/地点受益于时间证据
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (alreadyPaired.has(`${a.id}-${b.id}`)) continue;
            if (!_canCallLLM(1)) break;

            const daysA = getFragDates.all(a.id).map(r => r.day);
            const daysB = getFragDates.all(b.id).map(r => r.day);
            const overlapDays = daysA.filter(d => daysB.includes(d));
            const unionDays = new Set([...daysA, ...daysB]).size;
            if (overlapDays.length === 0 || overlapDays.length / unionDays < 0.5) continue;
            // 日期重叠 ≥50% → 可能是同一事件的不同名字

            const prompt = `记忆星系中有两个「${a.category}」星座，名字不同但碎片日期高度重叠（${overlapDays.length}/${unionDays}天重叠：${overlapDays.slice(0,3).join(',')}${overlapDays.length>3?'...':''}）。

A: ${a.name} (${a.fragment_count}条碎片)
B: ${b.name} (${b.fragment_count}条碎片)

它们是同一个实体吗（只是起了不同的名字）？只输出JSON: {"same":true|false,"reason":"一句话"}`;

            try {
                const raw = await callLLM(
                    [{ role: 'user', parts: [{ text: prompt }] }],
                    WORLD_CONTEXT, null,
                    { temperature: 0.1, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } },
                    ARCHIVIST_LLM_CONFIG_ID
                );
                agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
                timeChecked++;
                const replyText = raw?.reply || raw?.text || raw?.content || '';
                const jsonMatch = replyText.match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                const verdict = JSON.parse(jsonMatch[0]);
                if (verdict.same) {
                    pairs.push({ a, b, nameContained: false, reason: `时间重叠(${overlapDays.length}/${unionDays}天): ${verdict.reason}` });
                    console.log(`[Archivist] 🕐 时间线检测: ${a.name} = ${b.name} — ${overlapDays.length}/${unionDays}天重叠`);
                }
            } catch (e) {
                console.error('[Archivist] 时间线检测LLM失败:', e.message);
            }
        }
    }

    if (pairs.length === 0) return { merged: 0 };

    const sharedCount = db.prepare(`
        SELECT COUNT(*) c FROM fragment_entities f1
        JOIN fragment_entities f2 ON f1.fragment_id = f2.fragment_id
        WHERE f1.entity_id = ? AND f2.entity_id = ?`);

    // 确定性快道：名字互相包含 且 共享碎片占小方 ≥80%（≥3条）= 同一实体，不问 LLM。
    // LLM 会被矛盾的自动生成概述带偏（「Alex」被写成人、「Al」被写成AI），而那矛盾正是要修的污染。
    // 必须 nameContained——甲/乙 共享 100%（同一段宠物介绍多挂）但是两只猫，名字无关不走快道。
    const autoSame = [];
    const llmPairs = [];
    for (const p of pairs) {
        const shared = sharedCount.get(p.a.id, p.b.id).c;
        const minFc = Math.max(1, Math.min(p.a.fragment_count, p.b.fragment_count));
        if (p.nameContained && shared >= 3 && shared / minFc >= 0.8) autoSame.push(p);
        else llmPairs.push(p);
    }

    // 非铁证候选不调 LLM（LLM 分不清「某地点/某商场」这类名字相似的不同实体，
    // 误合并代价高且修复昂贵）→ 写入待确认队列，星图上由 User 人工裁决。
    let proposed = 0;
    const hasProposal = db.prepare(`
        SELECT COUNT(*) c FROM ontology_changelog
        WHERE action = 'merge_proposal'
          AND json_extract(detail, '$.a_id') = ? AND json_extract(detail, '$.b_id') = ?
          AND status IN ('pending', 'rejected')`);
    const insProposal = db.prepare(`
        INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('merge_proposal', ?, ?, 'pending')`);
    for (const p of llmPairs) {
        // 同一对只提案一次；被拒过的不再提
        if (hasProposal.get(p.a.id, p.b.id).c > 0 || hasProposal.get(p.b.id, p.a.id).c > 0) continue;
        const shared = sharedCount.get(p.a.id, p.b.id).c;
        insProposal.run(`${p.a.name} ↔ ${p.b.name}`, JSON.stringify({
            a_id: p.a.id, a_name: p.a.name, a_fc: p.a.fragment_count,
            b_id: p.b.id, b_name: p.b.name, b_fc: p.b.fragment_count,
            reason: p.reason, shared,
        }));
        proposed++;
        console.log(`[Archivist] 🔍 合并提案入队: "${p.a.name}" ↔ "${p.b.name}" (${p.reason}) — 待 User 确认`);
    }

    let merged = 0;
    const mergedIds = new Set(); // 防止链式合并同一实体两次
    for (const p of autoSame) {
        const { a, b } = p;
        if (mergedIds.has(a.id) || mergedIds.has(b.id)) continue;
        // 碎片多者存活；同数则名字短者存活（通常更规范）
        const [survivor, victim] = (a.fragment_count > b.fragment_count ||
            (a.fragment_count === b.fragment_count && a.name.length <= b.name.length)) ? [a, b] : [b, a];
        if (executeEntityMerge(survivor.id, victim.id)) {
            mergedIds.add(victim.id);
            merged++;
        }
    }

    return { merged, proposed };
}


// 合并执行（事务）：自动快道与人工确认 API 共用。返回 true=成功。
// 合并时要跟着存活者走的关系列。败者会被标 status='merged'，而 merged 行没有任何
// 查询会再读，留在那儿等于永久丢失；这三列也不参与 overview 重生成，不会自己长回来。
const MERGE_CARRY_COLS = ['relationship_to_user', 'relationship_nature', 'emotional_significance'];


function executeEntityMerge(survivorId, victimId) {
    const db = getDb();
    const survivor = db.prepare(`SELECT id, name, aliases, ${MERGE_CARRY_COLS.join(', ')} FROM entity_profiles WHERE id = ?`).get(survivorId);
    const victim = db.prepare(`SELECT id, name, ${MERGE_CARRY_COLS.join(', ')} FROM entity_profiles WHERE id = ?`).get(victimId);
    if (!survivor || !victim) return false;
    try {
        const doMerge = db.transaction(() => {
            // 迁移碎片链接（重复的由 UNIQUE 约束 + OR IGNORE 吸收）
            const victimLinks = db.prepare('SELECT fragment_id, relation, confidence, classified_by FROM fragment_entities WHERE entity_id = ?').all(victim.id);
            const ins = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, ?, ?, ?)');
            for (const l of victimLinks) ins.run(l.fragment_id, survivor.id, l.relation, l.confidence, l.classified_by);
            db.prepare('DELETE FROM fragment_entities WHERE entity_id = ?').run(victim.id);
            // 败者名字进存活者 aliases（Set 顺带去重，败者名和已有的重复项一起收掉）
            let aliases = [];
            try { aliases = JSON.parse(survivor.aliases || '[]'); } catch (_) {}
            aliases = [...new Set([...aliases, victim.name])];
            // 存活者缺哪列关系就用败者的补上（已有的不覆盖——存活者按碎片数胜出，通常更全）
            const relCols = [], relVals = [];
            for (const col of MERGE_CARRY_COLS) {
                if (!survivor[col] && victim[col]) { relCols.push(`${col} = ?`); relVals.push(victim[col]); }
            }
            // facts 置空强制重新生成——两边概述可能互相矛盾（如把人写成猫），不能留旧的。
            // ⚠️ 置空的是 facts 不是 overview：v5.9 起 overview 列已退役，写入侧重写的是 facts，
            // 置空 overview 等于写进一个没人再读、也不会被重建的列。
            const setCols = ['aliases = ?', 'facts = NULL', ...relCols,
                'fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?)',
                "updated_at = datetime('now')"];
            db.prepare(`UPDATE entity_profiles SET ${setCols.join(', ')} WHERE id = ?`)
                .run(JSON.stringify(aliases), ...relVals, survivor.id, survivor.id);
            db.prepare(`UPDATE entity_profiles SET status = 'merged', updated_at = datetime('now') WHERE id = ?`).run(victim.id);
            db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('seed_merge', ?, ?, 'done')`)
                .run(survivor.name, JSON.stringify({ victim: victim.name, survivor: survivor.name, migrated: victimLinks.length }));
        });
        doMerge();
        console.log(`[Archivist] 🔗 种子合并: "${victim.name}" → "${survivor.name}"`);
        return true;
    } catch (e) {
        console.error(`[Archivist] 种子合并失败 (${victim.name}→${survivor.name}):`, e.message);
        return false;
    }
}


// ═══════════════════════════════════════════════════════
// v4.7: graduateSeedsAndPrune — 苗圃升格 + 枯萎清理
//
// Called after each deep cycle classification round.
// - Seeds with ≥3 linked fragments → graduate to active
// - Seeds older than 14 days with <3 fragments → prune
// - Active entities with 0 new fragments in 30 days → dormant
// ═══════════════════════════════════════════════════════

async function graduateSeedsAndPrune() {
    const db = getDb();

    // Graduate: seeds with ≥3 fragments spanning ≥1 distinct date
    const graduates = db.prepare(`
        SELECT ep.id, ep.name, ep.category,
            (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) as fc,
            (SELECT COUNT(DISTINCT date(mf.created_at))
             FROM fragment_entities fe JOIN memory_fragments mf ON mf.id = fe.fragment_id
             WHERE fe.entity_id = ep.id) as distinct_days
        FROM entity_profiles ep
        WHERE ep.status = 'seed'
          AND (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) >= 3
          AND (SELECT COUNT(DISTINCT date(mf.created_at))
               FROM fragment_entities fe JOIN memory_fragments mf ON mf.id = fe.fragment_id
               WHERE fe.entity_id = ep.id) >= 1
    `).all();

    // ── v5.0 防线2: 晋升前 LLM 验证 + 生成 overview ──
    if (graduates.length > 0 && _canCallLLM(2)) {
        let promoted = 0;
        for (const g of graduates) {
            try {
                const frags = db.prepare(`SELECT mf.id, mf.content FROM memory_fragments mf
                    JOIN fragment_entities fe ON fe.fragment_id = mf.id
                    WHERE fe.entity_id = ? ORDER BY mf.id LIMIT 10`).all(g.id);

                if (frags.length < 3) continue;

                const prompt = `星座"${g.name}"(${g.category}) 当前挂载了这些碎片：
${frags.map((f,i) => `[${i}] ${f.content.slice(0, 150).replace(/\n/g, ' ')}`).join('\n')}

先判断：这些碎片真的都在讲同一个"${g.name}"吗？有没有明显不属于这个星座的？
如果确实属于同一个星座，为它写一句 overview（≤100字，Companion 第一人称）。

输出JSON: {"valid": true|false, "wrong_indices": [], "overview": "一句话概述或null"}`;

                const raw = await callLLM(
                    [{ role: 'user', parts: [{ text: prompt }] }],
                    null, null,
                    { temperature: 0.2, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
                    ARCHIVIST_LLM_CONFIG_ID
                );
                const replyText = (raw?.reply || raw?.text || raw?.content || '');
                const jsonMatch = replyText.match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                const verdict = JSON.parse(jsonMatch[0]);

                // Remove wrong fragments
                if (verdict.wrong_indices && verdict.wrong_indices.length > 0) {
                    for (const idx of verdict.wrong_indices) {
                        if (frags[idx]) {
                            db.prepare('DELETE FROM fragment_entities WHERE entity_id=? AND fragment_id=?').run(g.id, frags[idx].id);
                            console.log(`[Archivist] 🧹 移除错链碎片 #${frags[idx].id} ← ${g.name}`);
                        }
                    }
                }

                // Verify remaining count still meets threshold
                const remaining = db.prepare('SELECT COUNT(*) as c FROM fragment_entities WHERE entity_id=?').get(g.id)?.c || 0;
                if (!verdict.valid || remaining < 3) {
                    console.log(`[Archivist] ⏭️ 种子"${g.name}"验证未通过 — valid=${verdict.valid}, remaining=${remaining}`);
                    continue;
                }

                // Promote with overview
                const overview = (verdict.overview || '').trim();
                if (overview) {
                    db.prepare(`UPDATE entity_profiles SET status='active', overview=?, overview_updated_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(overview, g.id);
                } else {
                    db.prepare(`UPDATE entity_profiles SET status='active', updated_at=datetime('now') WHERE id=?`).run(g.id);
                }
                db.prepare(`INSERT INTO entity_timeline (entity_id, fragment_id, action, detail) VALUES (?, NULL, 'graduated', ?)`).run(g.id, `v5.0验证毕业(${remaining}碎片/${g.distinct_days}天) → ${g.category}星座`);
                // Also write to ontology_changelog so 观星手记 frontend can display it
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
                    VALUES ('emergent_constellation', ?, ?, 0.80, 'completed')`)
                    .run(g.name, JSON.stringify({name: g.name, category: g.category, reason: overview || `种子毕业: ${g.name}`, fragment_count: remaining}));
                console.log(`[Archivist] 🎓 验证毕业: ${g.name} → ${g.category}星座 (${remaining}碎片, overview=${overview.length}字)`);
                promoted++;
            } catch (e) {
                console.error(`[Archivist] 种子验证失败 ${g.name}:`, e.message);
            }
        }
        console.log(`[Archivist] 苗圃毕业: ${promoted}/${graduates.length} 个通过验证`);
    } else if (graduates.length > 0) {
        console.log(`[Archivist] ⏭️ 苗圃毕业跳过: ${graduates.length} 个候选但 LLM 配额不足`);
    }

    // Prune: seeds older than 14 days with <3 fragments
    const pruned = db.prepare(`
        SELECT ep.id, ep.name FROM entity_profiles ep
        WHERE ep.status = 'seed'
          AND ep.created_at < datetime('now', '-14 days')
          AND (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) < 3
    `).all();

    if (pruned.length > 0) {
        const pruneIds = pruned.map(p => p.id);
        const pruneBatch = db.transaction(() => {
            // Unlink fragments
            db.prepare(`DELETE FROM fragment_entities WHERE entity_id IN (${pruneIds.map(() => '?').join(',')})`).run(...pruneIds);
            // Delete seeds
            db.prepare(`DELETE FROM entity_profiles WHERE id IN (${pruneIds.map(() => '?').join(',')})`).run(...pruneIds);
        });
        pruneBatch();
        for (const p of pruned) {
            console.log(`[Archivist] 🥀 苗圃枯萎: ${p.name} (14天内未攒够碎片)`);
        }
    }

    // Dormant: active entities with no new fragments in 30 days
    const dormant = db.prepare(`
        SELECT ep.id, ep.name FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND ep.name NOT IN (${SKIP_PH})
          AND ep.updated_at < datetime('now', '-30 days')
          AND (SELECT MAX(fe.created_at) FROM fragment_entities fe WHERE fe.entity_id = ep.id) < datetime('now', '-30 days')
    `).all(...SKIP_NAMES);

    if (dormant.length > 0) {
        const dorm = db.prepare(`UPDATE entity_profiles SET status = 'dormant', updated_at = datetime('now') WHERE id = ?`);
        const dormBatch = db.transaction(() => {
            for (const d of dormant) {
                dorm.run(d.id);
                console.log(`[Archivist] 💤 星座休眠: ${d.name}`);
            }
        });
        dormBatch();
    }

    // Reactivate: dormant entities with new fragments
    const revived = db.prepare(`
        SELECT ep.id, ep.name FROM entity_profiles ep
        WHERE ep.status = 'dormant'
          AND EXISTS (SELECT 1 FROM fragment_entities fe WHERE fe.entity_id = ep.id AND fe.created_at > ep.updated_at)
    `).all();

    if (revived.length > 0) {
        const revive = db.prepare(`UPDATE entity_profiles SET status = 'active', updated_at = datetime('now') WHERE id = ?`);
        const reviveBatch = db.transaction(() => {
            for (const r of revived) {
                revive.run(r.id);
                console.log(`[Archivist] 🔄 星座复活: ${r.name}`);
            }
        });
        reviveBatch();
    }

    return { graduates: graduates.length, pruned: pruned.length, dormant: dormant.length, revived: revived.length };
}

module.exports = {
    mergeDuplicateSeeds,
    MERGE_CARRY_COLS,
    executeEntityMerge,
    graduateSeedsAndPrune,
};
