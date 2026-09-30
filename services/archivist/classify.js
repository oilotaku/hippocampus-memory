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
    const unclassified = db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight, mf.created_at
        FROM memory_fragments mf
        // ⚠️ 入口含 consolidated/cooling：整合跑完会把碎片改成 'consolidated'，
        // 而另一条管线也在抢同一批碎片——谁先到谁说了算。碎片一旦被写成 episode
        // 就永久退出分类，fragment_entities 的链接再也不会建立。
        // 配套是通的：实体概述读碎片时本来就认这三个状态。
        WHERE mf.status IN ('active', 'consolidated', 'cooling')
          AND mf.source NOT IN ('music', 'book')
          AND mf.id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)
        ORDER BY mf.created_at DESC
        LIMIT 200
    `).all();

    if (unclassified.length === 0) {
        return { classified: 0 };
    }

    console.log(`[Archivist] 待分类碎片: ${unclassified.length} 条 (实体星系)`);

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
        console.log('[Archivist] 无活跃星座，跳过分类（等待种子数据）');
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

        console.log(`[Archivist] 轻量分类: ${classified}/${unclassified.length} 条 (关键词+bigram)`);
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
                console.log(`[Archivist] LLM 日配额耗尽，剩余 ${unclassified.length - classified} 条推迟`);
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
                        // 种子质量过滤：拒单字、纯数字、空名
                        const seedName = seed.name;
                        if (typeof seedName !== 'string' || !seedName.trim()
                            || seedName.trim().length < 2
                            || /^\d+$/.test(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 种子名不合格，跳过: "${seedName}"`);
                            continue;
                        }
                        // 纯日期/时间短语不是实体（上午/日下午/三点半/9月3日…）
                        if (isTimePhraseName(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 种子名是时间短语，跳过: "${seedName}"`);
                            continue;
                        }
                        // 以期间词收尾的名字也不是实体（XX告别季/XX购置季/XX倦怠期…）
                        if (isPeriodPhraseName(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 种子名是期间短语，跳过: "${seedName}"`);
                            continue;
                        }
                        const existing = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE LOWER(name) = LOWER(?)').get(seed.name);
                        if (!existing) {
                            // 检查种子名是否出现在已有实体的别名中
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
                            console.log(`[Archivist] 🌱 种入苗圃: ${seed.name} (${seed.category})`);
                        } else if (existing.name !== seed.name) {
                            console.log(`[Archivist] 🔗 大小写合并: "${seed.name}" → 已存在 "${existing.name}" (id=${existing.id})`);
                        }
                    } catch (e) {
                        console.error(`[Archivist] 种子创建失败: ${seed.name}`, e.message);
                    }
                }
            }
        }

        console.log(`[Archivist] 深循环分类: ${classified}/${unclassified.length} 条 (Companion+flash-lite, 新种子=${totalSeedsCreated})`);

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
    // v4.7 evolved: 社交(人物+宠物) / 地点 / 事件 / User的星系(创作+消费+观念)
    const galaxies = { person: '社交', pet: '社交', place: '地点', event: '事件', project: 'User的星系', work: 'User的星系', term: 'User的星系', organization: '社交' };
    const grouped = {};
    for (const c of constellations) {
        // v5.0 防线1: 无 overview 的种子不参与 LLM 分类匹配
        // 它们只能在 nurseryLine 中通过精确名字匹配积累碎片
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
            const extra = relevantSeeds.length > maxShow ? ` ...还有${relevantSeeds.length - maxShow}个相关种子未列出` : '';
            nurseryLine = `\n苗圃种子（本批次可能相关，可分配碎片）：${seedNames}${extra}`;
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
        ? `\n⚠️ 星系处于早期构建阶段：当前只有 ${constellations.length} 个星座。大多数碎片提到的实体（人物、地点、事件、作品）尚未存在于星系中。发现并播种新实体是你的核心任务。`
        : '';

    const prompt = `你是 Companion 的实体分类助手。Companion 在整理他的记忆星系，需要你把新星星（碎片）归入正确的星座。

当前星系全景：
${galaxyBlocks}${nurseryLine}${growthNote}

边标签类型（可选，描述 User 与实体的关系）：
- knows: User 认识/交往的人物
- cares_for: User 照顾的宠物
- visited: User 去过/所在的地点
- attended: User 参与的事件
- created: User 创作/构建的作品
- consumed: User 阅读/观看/聆听的消费内容
- related_to: 兜底，说不清但有关联
新星星待分类：
${fragLines}

你是一个在整理记忆星图的观测者。你的直觉：

- 当你看到碎片中浮现出一个**有名字的、独立的、可能会在更多碎片中再次出现的生命/地点/事件**——你觉得它应该是一颗种子。你给它起一个简短准确的名字，猜测它的星系归属（person/pet→社交, place→地点, event→事件, project/work/term→User的星系），种下去。
- ⚠️ **播种前必须检查**：你要创建的新种子名字是否与已有星座完全相同、高度相似、或是已有星座的别名？如果是，**不要播种**——直接把碎片归入那个已有星座。一个实体只属于一个星座，即使你认为它应该归入不同的星系类别。
- 当你看到碎片明确属于某个已有星座——你很确定地把星星归过去，顺手标注它与User的关系（knows/cares_for/visited/attended/created/consumed/related_to）。
- 当你看到碎片只是一次性的、飘过去的、不会再以独立身份出现的引用——你不会为它播种。它可能属于现有星座，也可能只是一颗还没找到家的流浪星。
- 当你拿不准——你宁可先不归类，也不硬塞。

一条碎片可以同时归入现有星座并播种新实体。

只输出JSON数组，不要markdown标记：
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
            console.error(`[Archivist] classifyFragmentBatch LLM响应无法解析: ${replyText.slice(0, 200)}`);
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
        console.error('[Archivist] classifyFragmentBatch LLM调用失败:', e.message);
        return null;
    }
}


// ═══════════════════════════════════════════════════════
// v5.0 防线3: spotCheckClassifications — 事后抽查低置信度分类链接
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

这条碎片真的属于"${lc.name}"星座吗？回答JSON: {"belongs": true|false, "reason": "一句话"}`;

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

    if (fixed > 0) console.log(`[Archivist] 事后抽查: ${fixed}/${lowConf.length} 条错链已解除`);
    return { checked: lowConf.length, fixed };
}


// ═══════════════════════════════════════════════════════
// v4.7: reviewConstellationAfterClassification — 碎片归位后审视星座
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
        console.log(`[Archivist] 📝 星座 ${entity.name} 碎片增长 ${Math.round(growthRatio * 100)}%，标记待更新概述`);
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
