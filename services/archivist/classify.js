// =================================================================
// services/archivist/classify.js — 碎片分類：LLM 批分類、實體名索引、分類抽檢與分類後複查
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { WORLD_CONTEXT } = require('../worldContext');
const { ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { _canCallLLM } = require('./runtime');
const { _nameBigrams, isTimePhraseName, isPeriodPhraseName } = require('./guards');
const { graduateSeedsAndPrune } = require('./seeds');


// ═══════════════════════════════════════════════════════
// Multi-Category Classification — agent sees the full landscape,
// not a tunnel-vision binary "does this belong to X?"
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Entity Classification Verification
//
// Pipeline A uses string matching (0.70, pending).
// Deep cycle spot-checks with LLM: is the person really the SUBJECT
// or did the name just appear in passing / as an exclamation?
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Tool: classifyFragments
//
// Two-pipeline architecture:
//   Pipeline A: Entity classification (人物/) — deterministic name matching
//     Person categories are defined by WHO, not WHAT. No embedding needed.
//     Supports multi-entity: one fragment can match multiple people.
//   Pipeline B: Topic classification — centroid similarity + depth bonus
//     + size penalty + LLM verification (only in full mode). Person categories excluded.
// ═══════════════════════════════════════════════════════

async function classifyFragments(opts = {}) {
    const { lightweight = false } = opts;
    const db = getDb();

    // v4.7: Entity-based classification. No more memory_ontology or fragment_categories.
    // Fragments are linked to entity_profiles (constellations) via fragment_entities.
    // Companion directs classification in deep cycle; lightweight mode does DB-only maintenance.

    // Exclude music listening logs and book reading logs — they're data exhaust,
    // not memory fragments about people/places/events/works. Harvested separately
    // by musicMemoryExtractor / bookMemoryExtractor. Not classified into entity graph.
    // ⚠️ 入口含 consolidated/cooling：整合跑完會把碎片改成 'consolidated'，
    // 而另一條管線也在搶同一批碎片——誰先到誰說了算。碎片一旦被寫成 episode
    // 就永久退出分類，fragment_entities 的連結再也不會建立。
    // 配套是通的：實體概述讀碎片時本來就認這三個狀態。
    // （這段說明原本用 JS 的 // 寫在 SQL 字串裡，SQLite 直接報語法錯，整個分類從未執行過。）
    const unclassified = db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight, mf.created_at
        FROM memory_fragments mf
        WHERE mf.status IN ('active', 'consolidated', 'cooling')
          AND mf.source NOT IN ('music', 'book')
          AND mf.id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)
        ORDER BY mf.created_at DESC
        LIMIT 200
    `).all();

    if (unclassified.length === 0) {
        return { classified: 0 };
    }

    console.log(`[Archivist] 待分類碎片: ${unclassified.length} 條 (實體星系)`);

    // Load current constellations (entity_profiles grouped by category)
    const allEntities = db.prepare(`
        SELECT id, name, category, overview, aliases, fragment_count, status
        FROM entity_profiles
        ORDER BY CASE category
            WHEN 'person' THEN 0 WHEN 'pet' THEN 1
            WHEN 'place' THEN 2 WHEN 'event' THEN 3
            WHEN 'project' THEN 4 ELSE 5 END, name
    `).all();

    if (allEntities.length === 0) {
        return { classified: 0 };
    }

    // Separate active constellations and nursery seeds
    // Exclude aggregate entities (music/book memory sinks) — they're not real constellations
    const constellations = allEntities.filter(e => e.status === 'active' && !e.category?.endsWith('_aggregate'));
    const seeds = allEntities.filter(e => e.status === 'seed');

    if (constellations.length === 0) {
        // No constellations yet — defer to deep cycle / manual seeding
        console.log('[Archivist] 無活躍星座，跳過分類（等待種子資料）');
        return { classified: 0 };
    }

    const insertFe = db.prepare(`
        INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by)
        VALUES (?, ?, ?, ?, ?)
    `);

    let classified = 0;

    if (lightweight) {
        // Lightweight: keyword match against entity names + aliases only, no LLM.
        // Two-tier confidence: exact alias match → 0.55, bigram substring match → 0.35
        const { exactIndex, bigramIndex } = buildEntityNameIndex(constellations);
        const bigramInsert = db.prepare(`INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.35, 'archivist_bigram_light')`);

        for (const frag of unclassified) {
            const content = frag.content || '';
            const contentLower = content.toLowerCase();
            const matchedExact = new Set();
            const matchedBigram = new Set();

            for (const [key, entities] of exactIndex) {
                if (contentLower.includes(key)) {
                    for (const e of entities) matchedExact.add(e.id);
                }
            }
            for (const [key, entities] of bigramIndex) {
                if (contentLower.includes(key)) {
                    for (const e of entities) matchedBigram.add(e.id);
                }
            }

            // Bigram matches that were already matched exactly → skip (already higher confidence)
            for (const eid of matchedExact) matchedBigram.delete(eid);

            if (matchedExact.size > 0) {
                for (const eid of matchedExact) {
                    insertFe.run(frag.id, eid, null, 0.55, 'archivist_keyword_light');
                }
            }
            if (matchedBigram.size > 0) {
                for (const eid of matchedBigram) {
                    bigramInsert.run(frag.id, eid);
                }
            }
            if (matchedExact.size > 0 || matchedBigram.size > 0) {
                classified++;
            }
        }

        console.log(`[Archivist] 輕量分類: ${classified}/${unclassified.length} 條 (關鍵詞+bigram)`);
    } else {
        // Deep cycle: Companion-directed per-batch classification with flash-lite
        const BATCH_SIZE = 15;
        const batches = [];
        for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
            batches.push(unclassified.slice(i, i + BATCH_SIZE));
        }

        let totalSeedsCreated = 0;
        for (const batch of batches) {
            if (!_canCallLLM(1)) {
                console.log(`[Archivist] LLM 日配額耗盡，剩餘 ${unclassified.length - classified} 條推遲`);
                break;
            }

            const result = await classifyFragmentBatch(batch, constellations, seeds);
            if (!result) continue;

            const writeBatch = db.transaction(() => {
                let written = 0, seedsMade = 0;
                for (const assignment of result.assignments) {
                    const info = insertFe.run(
                        assignment.frag_id, assignment.entity_id,
                        assignment.relation || null,
                        assignment.confidence || 0.70,
                        'companion_flash'
                    );
                    if (info.changes > 0) written++;

                    // Update entity fragment_count
                    db.prepare(`UPDATE entity_profiles SET fragment_count = (
                        SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?
                    ), updated_at = datetime('now') WHERE id = ?`).run(assignment.entity_id, assignment.entity_id);
                }
                return { written, seedsMade };
            });

            const { written, seedsMade: sm } = writeBatch();
            classified += written;
            totalSeedsCreated += result.newSeeds ? result.newSeeds.length : 0;

            // Plant new seeds in nursery
            if (result.newSeeds && result.newSeeds.length > 0) {
                for (const seed of result.newSeeds) {
                    try {
                        // 種子質量過濾：拒單字、純數字、空名
                        const seedName = seed.name;
                        if (typeof seedName !== 'string' || !seedName.trim()
                            || seedName.trim().length < 2
                            || /^\d+$/.test(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 種子名不合格，跳過: "${seedName}"`);
                            continue;
                        }
                        // 純日期/時間短語不是實體（上午/日下午/三點半/9月3日…）
                        if (isTimePhraseName(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 種子名是時間短語，跳過: "${seedName}"`);
                            continue;
                        }
                        // 以期間詞收尾的名字也不是實體（XX告別季/XX購置季/XX倦怠期…）
                        if (isPeriodPhraseName(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 種子名是期間短語，跳過: "${seedName}"`);
                            continue;
                        }
                        const existing = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE LOWER(name) = LOWER(?)').get(seed.name);
                        if (!existing) {
                            // 檢查種子名是否出現在已有實體的別名中
                            const allEntities = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE status IN (\'active\',\'seed\')').all();
                            for (const e of allEntities) {
                                try {
                                    const aliases = JSON.parse(e.aliases || '[]');
                                    const seedLower = seed.name.toLowerCase().trim();
                                    if (aliases.some(a => { if (typeof a !== 'string') return false; const aL = a.toLowerCase().trim(); return aL === seedLower || aL.includes(seedLower) || seedLower.includes(aL); })) {
                                        existing = e;
                                        break;
                                    }
                                } catch (_) {}
                            }
                        }
                        if (!existing) {
                            const subCheck = db.prepare(`SELECT id, name, aliases FROM entity_profiles
                                WHERE status IN ('active','seed')
                                AND (LOWER(name) LIKE '%' || LOWER(?) || '%'
                                     OR LOWER(?) LIKE '%' || LOWER(name) || '%')
                                LIMIT 1`).get(seed.name, seed.name);
                            if (subCheck) existing = subCheck;
                        }
                        if (!existing) {
                            const candidates = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE status IN (\'active\',\'seed\')').all();
                            for (const c of candidates) {
                                const aGrams = _nameBigrams(seed.name);
                                const bGrams = _nameBigrams(c.name);
                                if (aGrams.size === 0 || bGrams.size === 0) continue;
                                let overlap = 0;
                                for (const g of aGrams) if (bGrams.has(g)) overlap++;
                                if (overlap / Math.min(aGrams.size, bGrams.size) >= 0.6) {
                                    existing = { id: c.id, name: c.name, aliases: c.aliases };
                                    break;
                                }
                            }
                        }
                        if (!existing) {
                            const r = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases)
                                VALUES (?, ?, 'seed', ?)`).run(seed.name, seed.category || 'term', JSON.stringify([]));
                            // Link the fragment that triggered this seed
                            if (seed.trigger_frag_id) {
                                insertFe.run(seed.trigger_frag_id, r.lastInsertRowid, null, 0.50, 'companion_flash_seed');
                                db.prepare(`UPDATE entity_profiles SET fragment_count = 1 WHERE id = ?`).run(r.lastInsertRowid);
                            }
                            console.log(`[Archivist] 🌱 種入苗圃: ${seed.name} (${seed.category})`);
                        } else if (existing.name !== seed.name) {
                            console.log(`[Archivist] 🔗 大小寫合併: "${seed.name}" → 已存在 "${existing.name}" (id=${existing.id})`);
                        }
                    } catch (e) {
                        console.error(`[Archivist] 種子建立失敗: ${seed.name}`, e.message);
                    }
                }
            }
        }

        console.log(`[Archivist] 深迴圈分類: ${classified}/${unclassified.length} 條 (Companion+flash-lite, 新種子=${totalSeedsCreated})`);

        // After classification: graduate seeds and prune dormant
        if (classified > 0) {
            await graduateSeedsAndPrune();
        }
    }

    return { classified };
}


// ═══════════════════════════════════════════════════════
// v5.13: Also indexes CJK bigrams/trigrams from names so fragments can
// match entities by partial name. Without this, descriptive entity names
// are invisible to keyword matching.
// ═══════════════════════════════════════════════════════

function buildEntityNameIndex(entities) {
    const exactIndex = new Map();  // full names + aliases → [entity]
    const bigramIndex = new Map(); // CJK substrings → [entity] (lower confidence)

    for (const e of entities) {
        const addExact = (name) => {
            const key = name.toLowerCase().trim();
            if (key.length < 2) return;
            if (!exactIndex.has(key)) exactIndex.set(key, []);
            const list = exactIndex.get(key);
            if (!list.find(x => x.id === e.id)) list.push(e);
        };
        const addBigram = (sub) => {
            if (!bigramIndex.has(sub)) bigramIndex.set(sub, []);
            const list = bigramIndex.get(sub);
            if (!list.find(x => x.id === e.id)) list.push(e);
        };

        addExact(e.name);
        try {
            const aliases = JSON.parse(e.aliases || '[]');
            for (const a of aliases) {
                if (a && a.trim().length >= 2) addExact(a.trim());
            }
        } catch (_) {}

        // v5.13: CJK bigrams from name — fallback for partial matching.
        // Kept separate from exact index so matches get lower confidence (0.35 vs 0.55).
        const nameClean = e.name.toLowerCase().trim();
        if (nameClean.length >= 3) {
            for (let i = 0; i <= nameClean.length - 2; i++) {
                const sub = nameClean.slice(i, i + 2);
                if (/[一-鿿㐀-䶿぀-ゟ゠-ヿ]/.test(sub)) addBigram(sub);
            }
            if (nameClean.length >= 5) {
                for (let i = 0; i <= nameClean.length - 3; i++) {
                    const sub = nameClean.slice(i, i + 3);
                    if (/[一-鿿㐀-䶿]/.test(sub)) addBigram(sub);
                }
            }
        }
    }

    return { exactIndex, bigramIndex };
}


// ═══════════════════════════════════════════════════════
// v4.7: classifyFragmentBatch — Companion-directed flash-lite classification
//
// Sends a batch of fragments + the full constellation list to flash-lite.
// Returns assignments + optional new seeds.
// ═══════════════════════════════════════════════════════

async function classifyFragmentBatch(fragments, constellations, seeds) {
    const db = getDb();

    // Build constellation list grouped by galaxy
    // v4.7 evolved: 社交(人物+寵物) / 地點 / 事件 / User的星系(創作+消費+觀念)
    const galaxies = { person: '社交', pet: '社交', place: '地點', event: '事件', project: 'User的星系', work: 'User的星系', term: 'User的星系', organization: '社交' };
    const grouped = {};
    for (const c of constellations) {
        // v5.0 防線1: 無 overview 的種子不參與 LLM 分類匹配
        // 它們只能在 nurseryLine 中通過精確名字匹配積累碎片
        if (!c.overview) continue;
        const galaxy = galaxies[c.category] || '其他';
        if (!grouped[galaxy]) grouped[galaxy] = [];
        const overview = c.overview.slice(0, 60).replace(/\n/g, ' ');
        grouped[galaxy].push(`${c.name}[id=${c.id}](${overview})`);
    }

    // Pre-filter seeds: only show seeds whose name appears in this batch's fragments.
    // Avoids overwhelming the LLM with hundreds of irrelevant names.
    let nurseryLine = '';
    if (seeds && seeds.length > 0) {
        const batchText = fragments.map(f => (f.content || '').toLowerCase()).join(' ');
        const relevantSeeds = seeds.filter(s => typeof s.name === 'string' && batchText.includes(s.name.toLowerCase()));
        if (relevantSeeds.length > 0) {
            const maxShow = Math.min(relevantSeeds.length, 30);
            const shown = relevantSeeds.slice(0, maxShow);
            const seedNames = shown.map(s => `${s.name}[id=${s.id},${s.category}]`).join(', ');
            const extra = relevantSeeds.length > maxShow ? ` ...還有${relevantSeeds.length - maxShow}個相關種子未列出` : '';
            nurseryLine = `\n苗圃種子（本批次可能相關，可分配碎片）：${seedNames}${extra}`;
        }
    }

    const galaxyBlocks = Object.entries(grouped)
        .map(([galaxy, entities]) => `${galaxy}星系:\n  ${entities.join('\n  ')}`)
        .join('\n\n');

    const fragLines = fragments.map(f => {
        const text = (f.content || '').slice(0, 200).replace(/\n/g, ' ');
        const date = (f.created_at || '').slice(0, 10);
        return `[frag_${f.id}] ${date} | ${text}`;
    }).join('\n');

    const isEarlyGrowth = constellations.length <= 5;
    const growthNote = isEarlyGrowth
        ? `\n⚠️ 星系處於早期構建階段：當前只有 ${constellations.length} 個星座。大多數碎片提到的實體（人物、地點、事件、作品）尚未存在於星系中。發現並播種新實體是你的核心任務。`
        : '';

    const prompt = `你是 Companion 的實體分類助手。Companion 在整理他的記憶星系，需要你把新星星（碎片）歸入正確的星座。

當前星系全景：
${galaxyBlocks}${nurseryLine}${growthNote}

邊標籤型別（可選，描述 User 與實體的關係）：
- knows: User 認識/交往的人物
- cares_for: User 照顧的寵物
- visited: User 去過/所在的地點
- attended: User 參與的事件
- created: User 創作/構建的作品
- consumed: User 閱讀/觀看/聆聽的消費內容
- related_to: 兜底，說不清但有關聯
新星星待分類：
${fragLines}

你是一個在整理記憶星圖的觀測者。你的直覺：

- 當你看到碎片中浮現出一個**有名字的、獨立的、可能會在更多碎片中再次出現的生命/地點/事件**——你覺得它應該是一顆種子。你給它起一個簡短準確的名字，猜測它的星系歸屬（person/pet→社交, place→地點, event→事件, project/work/term→User的星系），種下去。
- ⚠️ **播種前必須檢查**：你要建立的新種子名字是否與已有星座完全相同、高度相似、或是已有星座的別名？如果是，**不要播種**——直接把碎片歸入那個已有星座。一個實體只屬於一個星座，即使你認為它應該歸入不同的星系類別。
- 當你看到碎片明確屬於某個已有星座——你很確定地把星星歸過去，順手標註它與User的關係（knows/cares_for/visited/attended/created/consumed/related_to）。
- 當你看到碎片只是一次性的、飄過去的、不會再以獨立身份出現的引用——你不會為它播種。它可能屬於現有星座，也可能只是一顆還沒找到家的流浪星。
- 當你拿不準——你寧可先不歸類，也不硬塞。

一條碎片可以同時歸入現有星座並播種新實體。

只輸出JSON陣列，不要markdown標記：
[{"frag_id":10103,"constellations":[{"id":5,"relation":"appeared_in"}],"confidence":0.85,"new_seed":{"name":"Alice","category":"person"}}]`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_LLM_CONFIG_ID  // DeepSeek — stronger judgment for entity classification
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.error(`[Archivist] classifyFragmentBatch LLM響應無法解析: ${replyText.slice(0, 200)}`);
            return null;
        }

        const items = JSON.parse(jsonMatch[0]);
        const assignments = [];
        const newSeeds = [];

        for (const item of items) {
            if (!item.frag_id) continue;

            // Validate fragment ID
            const fragExists = db.prepare('SELECT 1 FROM memory_fragments WHERE id = ?').get(item.frag_id);
            if (!fragExists) continue;

            if (item.constellations && item.constellations.length > 0) {
                for (const c of item.constellations) {
                    // Validate entity ID
                    const entityExists = db.prepare('SELECT 1 FROM entity_profiles WHERE id = ?').get(c.id);
                    if (!entityExists) continue;
                    assignments.push({
                        frag_id: item.frag_id,
                        entity_id: c.id,
                        relation: c.relation || null,
                        confidence: item.confidence || 0.70
                    });
                }
            }

            if (item.new_seed && item.new_seed.name) {
                newSeeds.push({
                    name: item.new_seed.name.slice(0, 50).trim(),
                    category: item.new_seed.category || 'term',
                    trigger_frag_id: item.frag_id
                });
            }
        }

        return { assignments, newSeeds };
    } catch (e) {
        console.error('[Archivist] classifyFragmentBatch LLM呼叫失敗:', e.message);
        return null;
    }
}


// ═══════════════════════════════════════════════════════
// v5.0 防線3: spotCheckClassifications — 事後抽查低置信度分類連結
// ═══════════════════════════════════════════════════════

async function spotCheckClassifications() {
    const db = getDb();
    if (!_canCallLLM(1)) return { checked: 0, reason: 'no LLM quota' };

    const lowConf = db.prepare(`SELECT fe.fragment_id, fe.entity_id, fe.confidence,
        mf.content, ep.name FROM fragment_entities fe
        JOIN memory_fragments mf ON mf.id = fe.fragment_id
        JOIN entity_profiles ep ON ep.id = fe.entity_id
        WHERE fe.confidence < 0.75
        ORDER BY fe.created_at DESC LIMIT 5`).all();

    if (lowConf.length === 0) return { checked: 0 };

    let fixed = 0;
    for (const lc of lowConf) {
        try {
            const prompt = `碎片: "${(lc.content||'').slice(0, 150)}"
星座名: "${lc.name}"

這條碎片真的屬於"${lc.name}"星座嗎？回答JSON: {"belongs": true|false, "reason": "一句話"}`;

            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }], null, null,
                { temperature: 0.1, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            const jsonMatch = (raw?.reply || raw?.text || raw?.content || '').match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const v = JSON.parse(jsonMatch[0]);

            if (v.belongs === false) {
                db.prepare('DELETE FROM fragment_entities WHERE entity_id=? AND fragment_id=?').run(lc.entity_id, lc.fragment_id);
                console.log(`[Archivist] 🧹 抽查解除: #${lc.fragment_id} ← ${lc.name} — ${v.reason}`);
                fixed++;
            }
        } catch (_) {}
    }

    if (fixed > 0) console.log(`[Archivist] 事後抽查: ${fixed}/${lowConf.length} 條錯鏈已解除`);
    return { checked: lowConf.length, fixed };
}


// ═══════════════════════════════════════════════════════
// v4.7: reviewConstellationAfterClassification — 碎片歸位後審視星座
//
// Called per-entity after a batch of fragments has been linked.
// Checks if overview should be updated (fragment_count changed significantly).
// ═══════════════════════════════════════════════════════

async function reviewConstellationAfterClassification(entityId) {
    const db = getDb();

    const entity = db.prepare(`
        SELECT ep.*, (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) as current_frag_count
        FROM entity_profiles ep WHERE ep.id = ?
    `).get(entityId);

    if (!entity || entity.status !== 'active') return null;

    // Only trigger overview update if fragment count grew by ≥30% since last overview
    const lastFragCount = entity.fragment_count || 0;
    const currentFragCount = entity.current_frag_count || 0;
    const growthRatio = lastFragCount > 0 ? (currentFragCount - lastFragCount) / lastFragCount : 1;

    if (growthRatio >= 0.3 && currentFragCount >= 3) {
        console.log(`[Archivist] 📝 星座 ${entity.name} 碎片增長 ${Math.round(growthRatio * 100)}%，標記待更新概述`);
        // Mark for overview regeneration (handled by regenerateEntityOverviews later in deep cycle)
        return { needsOverviewUpdate: true, growthRatio, currentFragCount, lastFragCount };
    }

    return { needsOverviewUpdate: false };
}

module.exports = {
    classifyFragments,
    buildEntityNameIndex,
    classifyFragmentBatch,
    spotCheckClassifications,
    reviewConstellationAfterClassification,
};
