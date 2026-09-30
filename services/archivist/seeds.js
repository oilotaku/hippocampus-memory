// =================================================================
// services/archivist/seeds.js — 種子星座：重複種子合併、實體合併執行、種子畢業與修剪
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { sealField } = require('../memoryCrypto');
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

    // 泛指詞檢測：被 ≥2 個其他實體名包含的短名（「辦公室」⊂ 公司A+公司B）
    // 是類目詞不是具體實體，與它的包含關係不構成同一性。
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

    // ── v5.6 確定性別名合併：A.name ∈ B.aliases 或反之 → 零LLM直接合並 ──
    // 覆蓋跨文字系統（中文/拉丁/日文）的別名鏈路。
    // aliases 是之前 LLM 執行已認定的等價關係，確定性 100%，不需要再驗證。
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
            const reason = aInBAliases && bInAAliases ? '雙向別名' : (aInBAliases ? `"${a.name}"是"${b.name}"的別名` : `"${b.name}"是"${a.name}"的別名`);

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

            console.log(`[Archivist] 🔗 別名合併: "${loser.name}" → "${winner.name}" (${reason})`);
            aliasSuperseded.add(loser.id);
            aliasMerged++;

            a.fragment_count = winner.id === a.id ? Math.max(a.fragment_count, b.fragment_count) : a.fragment_count;
            b.fragment_count = winner.id === b.id ? Math.max(a.fragment_count, b.fragment_count) : b.fragment_count;
        }
    }
    if (aliasMerged > 0) return { merged: aliasMerged, reason: 'alias_deterministic' };

    // 候選對：同 category 且名字包含/bigram 相似
    const pairs = [];
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i], b = seeds[j];
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (a.category !== b.category) continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;
            // 候選對只由名字關係產生。共享碎片不是同一性證據——
            // 同一碎片提到兩隻貓/兩個人是跨實體多掛的 feature，那是
            // discoverRelatedEntities（關係橋）的領域。
            // 名字互相包含（處理「Alex」vs「Al」這類單字/暱稱，bigram 算不出）
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

    // 跨語言/縮寫候選：同類別、零文本重疊、但共享碎片 ≥1 →
    // LLM 判斷是否為同一實體的別稱（甲=甲的別稱, 乙=乙的別稱）
    const crossLangCandidates = [];
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i], b = seeds[j];
            if (a.category !== b.category) continue;
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (genericNames.has(a.id) || genericNames.has(b.id)) continue;
            const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
            // 跳過已有文本重疊的（已被上面的邏輯覆蓋）
            if (an.includes(bn) || bn.includes(an)) continue;
            const ga = _nameBigrams(a.name), gb = _nameBigrams(b.name);
            if (ga.size > 0 && gb.size > 0) {
                let overlap = 0;
                for (const g of ga) if (gb.has(g)) overlap++;
                if (overlap / Math.min(ga.size, gb.size) >= 0.5) continue; // 已有文本匹配
            }
            // 零文本重疊 + 同類別 → LLM 別稱判斷候選
            crossLangCandidates.push({ a, b });
        }
    }

    // ── v5.5 碎片重疊路徑: 共享碎片 ≥50% 直接合並（零 LLM）──
    // 覆蓋「甲 vs 乙」名字完全不同 + 「甲乙 vs 甲乙丙」跨category 情況
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
                console.log(`[Archivist] 🔗 碎片重疊合並: "${loser.name}" → "${winner.name}" (重疊${overlap}/${minFrags}=${Math.round(overlap/minFrags*100)}%)`);
                overlapMerged++;
            }
        }
    }
    if (overlapMerged > 0) return { merged: overlapMerged, reason: 'fragment_overlap' };

    // 每輪最多問 LLM 3 對（控制成本）
    let llmAliasChecked = 0;
    for (const cand of crossLangCandidates) {
        if (llmAliasChecked >= 3) break;
        if (!_canCallLLM(1)) break;

        const prompt = `記憶星系中有兩個同屬「${cand.a.category}」類別的星座，名字完全不同。請判斷它們是否指同一個實體（只是用了不同的名稱/別名/語言）。

A: ${cand.a.name} (${cand.a.category}, ${cand.a.fragment_count}條碎片)
B: ${cand.b.name} (${cand.b.category}, ${cand.b.fragment_count}條碎片)

它們是同一個實體嗎？只輸出JSON: {"same":true|false,"reason":"一句話"}`;

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
                pairs.push({ a: cand.a, b: cand.b, nameContained: false, reason: `LLM別名: ${verdict.reason}` });
                console.log(`[Archivist] 🔗 LLM別名檢測: ${cand.a.name} = ${cand.b.name} — ${verdict.reason}`);
            }
        } catch (e) {
            console.error('[Archivist] LLM別名檢測失敗:', e.message);
        }
    }

    // 時間線檢測：同類別事件/地點，碎片日期高度重疊 → LLM 判斷是否同一事件
    // （「某日展會」和「某日展會活動」名字重疊但共享碎片為零，需日期證據）
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
            if (a.category !== 'event' && a.category !== 'place') continue; // 只有事件/地點受益於時間證據
            if (typeof a.name !== 'string' || typeof b.name !== 'string') continue;
            if (alreadyPaired.has(`${a.id}-${b.id}`)) continue;
            if (!_canCallLLM(1)) break;

            const daysA = getFragDates.all(a.id).map(r => r.day);
            const daysB = getFragDates.all(b.id).map(r => r.day);
            const overlapDays = daysA.filter(d => daysB.includes(d));
            const unionDays = new Set([...daysA, ...daysB]).size;
            if (overlapDays.length === 0 || overlapDays.length / unionDays < 0.5) continue;
            // 日期重疊 ≥50% → 可能是同一事件的不同名字

            const prompt = `記憶星系中有兩個「${a.category}」星座，名字不同但碎片日期高度重疊（${overlapDays.length}/${unionDays}天重疊：${overlapDays.slice(0,3).join(',')}${overlapDays.length>3?'...':''}）。

A: ${a.name} (${a.fragment_count}條碎片)
B: ${b.name} (${b.fragment_count}條碎片)

它們是同一個實體嗎（只是起了不同的名字）？只輸出JSON: {"same":true|false,"reason":"一句話"}`;

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
                    pairs.push({ a, b, nameContained: false, reason: `時間重疊(${overlapDays.length}/${unionDays}天): ${verdict.reason}` });
                    console.log(`[Archivist] 🕐 時間線檢測: ${a.name} = ${b.name} — ${overlapDays.length}/${unionDays}天重疊`);
                }
            } catch (e) {
                console.error('[Archivist] 時間線檢測LLM失敗:', e.message);
            }
        }
    }

    if (pairs.length === 0) return { merged: 0 };

    const sharedCount = db.prepare(`
        SELECT COUNT(*) c FROM fragment_entities f1
        JOIN fragment_entities f2 ON f1.fragment_id = f2.fragment_id
        WHERE f1.entity_id = ? AND f2.entity_id = ?`);

    // 確定性快道：名字互相包含 且 共享碎片佔小方 ≥80%（≥3條）= 同一實體，不問 LLM。
    // LLM 會被矛盾的自動生成概述帶偏（「Alex」被寫成人、「Al」被寫成AI），而那矛盾正是要修的汙染。
    // 必須 nameContained——甲/乙 共享 100%（同一段寵物介紹多掛）但是兩隻貓，名字無關不走快道。
    const autoSame = [];
    const llmPairs = [];
    for (const p of pairs) {
        const shared = sharedCount.get(p.a.id, p.b.id).c;
        const minFc = Math.max(1, Math.min(p.a.fragment_count, p.b.fragment_count));
        if (p.nameContained && shared >= 3 && shared / minFc >= 0.8) autoSame.push(p);
        else llmPairs.push(p);
    }

    // 非鐵證候選不調 LLM（LLM 分不清「某地點/某商場」這類名字相似的不同實體，
    // 誤合併代價高且修復昂貴）→ 寫入待確認佇列，星圖上由 User 人工裁決。
    let proposed = 0;
    const hasProposal = db.prepare(`
        SELECT COUNT(*) c FROM ontology_changelog
        WHERE action = 'merge_proposal'
          AND json_extract(detail, '$.a_id') = ? AND json_extract(detail, '$.b_id') = ?
          AND status IN ('pending', 'rejected')`);
    const insProposal = db.prepare(`
        INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('merge_proposal', ?, ?, 'pending')`);
    for (const p of llmPairs) {
        // 同一對只提案一次；被拒過的不再提
        if (hasProposal.get(p.a.id, p.b.id).c > 0 || hasProposal.get(p.b.id, p.a.id).c > 0) continue;
        const shared = sharedCount.get(p.a.id, p.b.id).c;
        insProposal.run(`${p.a.name} ↔ ${p.b.name}`, JSON.stringify({
            a_id: p.a.id, a_name: p.a.name, a_fc: p.a.fragment_count,
            b_id: p.b.id, b_name: p.b.name, b_fc: p.b.fragment_count,
            reason: p.reason, shared,
        }));
        proposed++;
        console.log(`[Archivist] 🔍 合併提案入隊: "${p.a.name}" ↔ "${p.b.name}" (${p.reason}) — 待 User 確認`);
    }

    let merged = 0;
    const mergedIds = new Set(); // 防止鏈式合併同一實體兩次
    for (const p of autoSame) {
        const { a, b } = p;
        if (mergedIds.has(a.id) || mergedIds.has(b.id)) continue;
        // 碎片多者存活；同數則名字短者存活（通常更規範）
        const [survivor, victim] = (a.fragment_count > b.fragment_count ||
            (a.fragment_count === b.fragment_count && a.name.length <= b.name.length)) ? [a, b] : [b, a];
        if (executeEntityMerge(survivor.id, victim.id)) {
            mergedIds.add(victim.id);
            merged++;
        }
    }

    return { merged, proposed };
}


// 合併執行（事務）：自動快道與人工確認 API 共用。返回 true=成功。
// 合併時要跟著存活者走的關係列。敗者會被標 status='merged'，而 merged 行沒有任何
// 查詢會再讀，留在那兒等於永久丟失；這三列也不參與 overview 重生成，不會自己長回來。
const MERGE_CARRY_COLS = ['relationship_to_user', 'relationship_nature', 'emotional_significance'];


function executeEntityMerge(survivorId, victimId) {
    const db = getDb();
    const survivor = db.prepare(`SELECT id, name, aliases, ${MERGE_CARRY_COLS.join(', ')} FROM entity_profiles WHERE id = ?`).get(survivorId);
    const victim = db.prepare(`SELECT id, name, ${MERGE_CARRY_COLS.join(', ')} FROM entity_profiles WHERE id = ?`).get(victimId);
    if (!survivor || !victim) return false;
    try {
        const doMerge = db.transaction(() => {
            // 遷移碎片連結（重複的由 UNIQUE 約束 + OR IGNORE 吸收）
            const victimLinks = db.prepare('SELECT fragment_id, relation, confidence, classified_by FROM fragment_entities WHERE entity_id = ?').all(victim.id);
            const ins = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, ?, ?, ?)');
            for (const l of victimLinks) ins.run(l.fragment_id, survivor.id, l.relation, l.confidence, l.classified_by);
            db.prepare('DELETE FROM fragment_entities WHERE entity_id = ?').run(victim.id);
            // 敗者名字進存活者 aliases（Set 順帶去重，敗者名和已有的重複項一起收掉）
            let aliases = [];
            try { aliases = JSON.parse(survivor.aliases || '[]'); } catch (_) {}
            aliases = [...new Set([...aliases, victim.name])];
            // 存活者缺哪列關係就用敗者的補上（已有的不覆蓋——存活者按碎片數勝出，通常更全）
            const relCols = [], relVals = [];
            for (const col of MERGE_CARRY_COLS) {
                if (!survivor[col] && victim[col]) { relCols.push(`${col} = ?`); relVals.push(victim[col]); }
            }
            // facts 置空強制重新生成——兩邊概述可能互相矛盾（如把人寫成貓），不能留舊的。
            // ⚠️ 置空的是 facts 不是 overview：v5.9 起 overview 列已退役，寫入側重寫的是 facts，
            // 置空 overview 等於寫進一個沒人再讀、也不會被重建的列。
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
        console.log(`[Archivist] 🔗 種子合併: "${victim.name}" → "${survivor.name}"`);
        return true;
    } catch (e) {
        console.error(`[Archivist] 種子合併失敗 (${victim.name}→${survivor.name}):`, e.message);
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

    // ── v5.0 防線2: 晉升前 LLM 驗證 + 生成 overview ──
    if (graduates.length > 0 && _canCallLLM(2)) {
        let promoted = 0;
        for (const g of graduates) {
            try {
                const frags = db.prepare(`SELECT mf.id, mf.content FROM memory_fragments mf
                    JOIN fragment_entities fe ON fe.fragment_id = mf.id
                    WHERE fe.entity_id = ? ORDER BY mf.id LIMIT 10`).all(g.id);

                if (frags.length < 3) continue;

                const prompt = `星座"${g.name}"(${g.category}) 當前掛載了這些碎片：
${frags.map((f,i) => `[${i}] ${f.content.slice(0, 150).replace(/\n/g, ' ')}`).join('\n')}

先判斷：這些碎片真的都在講同一個"${g.name}"嗎？有沒有明顯不屬於這個星座的？
如果確實屬於同一個星座，為它寫一句 overview（≤100字，Companion 第一人稱）。

輸出JSON: {"valid": true|false, "wrong_indices": [], "overview": "一句話概述或null"}`;

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
                            console.log(`[Archivist] 🧹 移除錯鏈碎片 #${frags[idx].id} ← ${g.name}`);
                        }
                    }
                }

                // Verify remaining count still meets threshold
                const remaining = db.prepare('SELECT COUNT(*) as c FROM fragment_entities WHERE entity_id=?').get(g.id)?.c || 0;
                if (!verdict.valid || remaining < 3) {
                    console.log(`[Archivist] ⏭️ 種子"${g.name}"驗證未通過 — valid=${verdict.valid}, remaining=${remaining}`);
                    continue;
                }

                // Promote with overview
                const overview = (verdict.overview || '').trim();
                if (overview) {
                    db.prepare(`UPDATE entity_profiles SET status='active', overview=?, overview_updated_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(sealField('entity_profiles', 'overview', overview), g.id);
                } else {
                    db.prepare(`UPDATE entity_profiles SET status='active', updated_at=datetime('now') WHERE id=?`).run(g.id);
                }
                db.prepare(`INSERT INTO entity_timeline (entity_id, fragment_id, action, detail) VALUES (?, NULL, 'graduated', ?)`).run(g.id, `v5.0驗證畢業(${remaining}碎片/${g.distinct_days}天) → ${g.category}星座`);
                // Also write to ontology_changelog so 觀星手記 frontend can display it
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
                    VALUES ('emergent_constellation', ?, ?, 0.80, 'completed')`)
                    .run(g.name, JSON.stringify({name: g.name, category: g.category, reason: overview || `種子畢業: ${g.name}`, fragment_count: remaining}));
                console.log(`[Archivist] 🎓 驗證畢業: ${g.name} → ${g.category}星座 (${remaining}碎片, overview=${overview.length}字)`);
                promoted++;
            } catch (e) {
                console.error(`[Archivist] 種子驗證失敗 ${g.name}:`, e.message);
            }
        }
        console.log(`[Archivist] 苗圃畢業: ${promoted}/${graduates.length} 個通過驗證`);
    } else if (graduates.length > 0) {
        console.log(`[Archivist] ⏭️ 苗圃畢業跳過: ${graduates.length} 個候選但 LLM 配額不足`);
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
            console.log(`[Archivist] 🥀 苗圃枯萎: ${p.name} (14天內未攢夠碎片)`);
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
                console.log(`[Archivist] 🔄 星座復活: ${r.name}`);
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
