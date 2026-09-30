// =================================================================
// services/archivist/emergent.js — 湧現地點／事件偵測與判據
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { WORLD_CONTEXT } = require('../worldContext');
const { USER } = require('../memoryConfig');
const { ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { agentState, _canCallLLM } = require('./runtime');
const { _nameBigrams, isTimePhraseName, isPeriodPhraseName } = require('./guards');


// ═══════════════════════════════════════════════════════
// v4.8: detectEmergentPlacesAndEvents — 涌现地点/事件检测
//
// 分类批次只能看到15条碎片，很容易漏掉地点和事件实体——
// 50+条同一地点的碎片分散在几十批里，每批看到1-2条不够播种。
//
// 本函数做第二遍扫描：取只链接到person/pet实体（没链接到
// 任何place/event）的碎片，用ChromaDB向量聚类，聚成团的
// 送LLM问「这是不是同一个地点/事件？该建星座吗？」
//
// 仅深循环调用（ChromaDB依赖）。每轮≤3个候选团。
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 涌现判据（2026-09-28 重写）
//
// 旧判据是「这些碎片是否指向一个**独立的具体地点或事件**（与已有实体都不同）」。
// 它有个致命的结构问题：**"与已有实体都不同"这句话是在教模型找理由分裂**——
// 只要它能说出"我和那个不一样"，就算过关。于是它学会了给一段**反复出现的行为**
// 起个「XX季」的名字——换个名字，那就不再是"行为模式"，而是"一段事件"了。
//
// 新判据把门槛下在**专有名词**上：判据要硬（有没有出现一个具体的人名/店名/地名/
// 机构名/作品名，或者是不是某一天真的出了某件事），不要软（像不像事件）——
// "像不像"正是模型最擅长绕的东西。配套还有两道确定性守卫：
// `isTimePhraseName`（全是日期时间字）与 `isPeriodPhraseName`（以期间词收尾）。
//
// ⚠️ 改这个 prompt 之后**必须双向回归**：既要确认它拒掉该拒的，也要确认它
//    **没把该建的也拒掉**（过度收紧 = 涌现功能停摆，比原来更糟）。
// ═══════════════════════════════════════════════════════
function buildEmergentJudgePrompt(sampleText, memberCount, existingBlock) {
    return `下面是一组来自聊天记录的碎片，它们在语义上高度相似，可能指向同一个地点或事件，但尚未被识别为独立的记忆星座。

碎片样本（${memberCount}条中的若干条）：
${sampleText.slice(0, 2500)}

记忆库已有实体（新建前先对照这个列表）：
${existingBlock}

判断标准（**按顺序过，前一条不过就不要再往后想**）：

1. ⚠️ **先找那样东西——这是硬门槛。** 满足下面**任一条**才继续；两条都不满足 → is_entity=false，到此为止：

   **a. 一个新的专有名词**——具体的人名 / 店名 / 地名 / 机构名 / 作品名。

   **b. 某一天真的出了某件事**——崩溃、大吵一架、出事、第一次做某事、某个决定。
   ⚠️ 判 b 的铁律：**它是「那一天发生的」，不是「那段时间在做的」。**
   拿一句话自检：这件事能用**一个具体日期**说完吗？
   · 「X月X日${USER.pronoun || 'TA'}崩溃了」✓ 是事件
   · 「X月${USER.pronoun || 'TA'}在读某本书」「X月${USER.pronoun || 'TA'}一直在买东西」✗ 是持续行为，不是事件
   · 有的碎片里确实出现了某天的日期，但整簇讲的是**跨了几周几个月的同一类事** → 判 false。
     出现日期不等于发生在一天。

   下面这些**两条都不满足**，一律判 false：
   · 行为：怎么做的描述（什么时候去哪、干了什么、买了什么）
   · 持续过程：跨越一段时间的同一件事（在做什么、一直在做什么）
   · 习惯/日常：重复发生的程序
   · 状态/心情：身心状况与感受
   · 时间段：某段时间、某个周期
   ⚠️ **把它们包装成「XX季」「XX期」「XX历程」不会让它变成事件**——换个名字还是那件事。

2. **它是不是已经被上面某个已有实体占了？**（走 a 的比对名字/别名；走 b 的看那个事件是不是已经有星座了）占了 → is_entity=false，归过去，不要另起炉灶。

3. **它是不是某个已有实体的子话题/细节？** 碎片如果讲的只是某个已有实体的一个**环节/细节**（大实体已经存在），那就是子话题 → is_entity=false，不独立建星座。

4. 都过了才建，注明 place 或 event：
   · 走 a 的：**名字用那个专有名词本身**（2-8 字，可以是它的直接变体）。
   · 走 b 的：名字**带上日期和那件事**，让人一眼看出是哪天出了什么事；**不要起成「XX期」「XX季」**——那样又变成行为包装了。

只输出JSON:
{"is_entity":true|false,"name":"名称","category":"place|event","reason":"一句话理由（指认那个专有名词 / 指认那个一次性事件 / 归属已有实体 / 既没有专有名词也不是一次性事件）"}`;
}


// 涌现判定的**代码侧闸门**（LLM 判完之后、建实体之前）。
//
// ⚠️ 抽成函数是为了让回归探针量到的是「**生产最终会怎么判**」，而不是裸的模型输出。
//    分开写的话，探针会把**已经被这几道铁证拦掉**的误判报成"漏判"。
//
// 三道闸各自拦什么：
//   · 名字是纯日期/时间短语（`isTimePhraseName`）
//   · 名字以期间词收尾（`isPeriodPhraseName`）
//   · **理由自相矛盾**：说了"已被占用/归入已有/不另起炉灶"，flag 却是 true。
//     名字/别名去重拦不住它（同一个东西换个说法，bigram 重叠到不了
//     阈值），所以看理由下判断——理由里明说了"有主"，就当 false，别信 flag。
function screenEmergentVerdict(verdict) {
    if (!verdict || !verdict.is_entity) return { accept: false, reason: 'not_entity' };
    const name = String(verdict.name || '').trim();
    if (name.length < 2 || /^\d+$/.test(name)) return { accept: false, reason: 'name_invalid' };
    if (isTimePhraseName(name)) return { accept: false, reason: 'time_phrase_name' };
    if (isPeriodPhraseName(name)) return { accept: false, reason: 'period_phrase_name' };
    if (/已被?.*(占用|覆盖|占据)|归入已有|归过去|不另起炉灶/.test(String(verdict.reason || ''))) {
        return { accept: false, reason: 'self_contradictory' };
    }
    return { accept: true, name };
}


async function detectEmergentPlacesAndEvents() {
    const db = getDb();
    const { searchMemoriesByVector } = require('../memory');

    // 取没链接到地点/事件的碎片（但已链接到person/pet）
    const orphanFrags = db.prepare(`
        SELECT DISTINCT mf.id, mf.content, mf.created_at
        FROM memory_fragments mf
        JOIN fragment_entities fe_person ON mf.id = fe_person.fragment_id
        JOIN entity_profiles ep_person ON fe_person.entity_id = ep_person.id
        WHERE ep_person.category IN ('person', 'pet')
          AND mf.status = 'active'
          AND mf.id NOT IN (
            SELECT DISTINCT fe2.fragment_id
            FROM fragment_entities fe2
            JOIN entity_profiles ep2 ON fe2.entity_id = ep2.id
            WHERE ep2.category IN ('place', 'event')
          )
        ORDER BY mf.created_at DESC
        LIMIT 200
    `).all();

    if (orphanFrags.length < 10) return { detected: 0 };

    // 用内容长度做粗聚类键：前30字提取关键词做L1分组
    // 再挑每组里最长的一条做种子，向量检索相似碎片
    const clusters = [];
    const used = new Set();

    for (const f of orphanFrags) {
        if (used.has(f.id)) continue;
        if (!_canCallLLM(1)) break;

        // 用碎片内容做向量检索，找相似碎片
        let similar;
        try {
            similar = await searchMemoriesByVector(f.content.slice(0, 300), 15);
        } catch (e) {
            console.error(`[Archivist] 涌现检测向量查询失败:`, e.message);
            continue;
        }

        // 过滤：只要未链接place/event的活跃碎片，相似度≥0.55
        const clusterIds = new Set();
        for (const h of (similar || [])) {
            if (h.similarity < 0.55) continue;
            const linked = db.prepare(`
                SELECT COUNT(*) as c FROM fragment_entities fe
                JOIN entity_profiles ep ON fe.entity_id = ep.id
                WHERE fe.fragment_id = ? AND ep.category IN ('place', 'event')
            `).get(h.id);
            if (linked.c > 0) continue; // 已有place/event链接，跳过
            clusterIds.add(h.id);
        }

        if (clusterIds.size < 4) continue; // 团太小，构不成一个实体

        // 标记已处理
        for (const cid of clusterIds) used.add(cid);
        clusters.push({ seed_frag_id: f.id, member_ids: [...clusterIds] });

        // 不设硬上限——_canCallLLM 是天然限流器。早期碎片里的地点会被最近的行为碎片挡住
    }

    if (clusters.length === 0) return { detected: 0 };

    let detected = 0;
    for (const cluster of clusters) {
        if (!_canCallLLM(1)) break;

        // 取团内碎片内容（最多8条做样本）
        const placeholders = cluster.member_ids.slice(0, 8).map(() => '?').join(',');
        const samples = db.prepare(`
            SELECT id, content, created_at FROM memory_fragments
            WHERE id IN (${placeholders}) ORDER BY created_at ASC
        `).all(...cluster.member_ids.slice(0, 8));

        const sampleText = samples.map(f => {
            const date = (f.created_at || '').slice(0, 10);
            return `[${date}] ${(f.content || '').slice(0, 200)}`;
        }).join('\n');

        // 已有实体索引——让 LLM 判断新话题是否归属已有实体，而非盲目新建
        const existingEnts = db.prepare(`
            SELECT name, category FROM entity_profiles
            WHERE status IN ('active','seed') AND category IN ('place','event','project','term')
            ORDER BY fragment_count DESC LIMIT 60
        `).all();
        const existingBlock = existingEnts.length > 0
            ? existingEnts.map(e => `· ${e.name}（${e.category}）`).join('\n')
            : '（暂无）';

        const prompt = buildEmergentJudgePrompt(sampleText, cluster.member_ids.length, existingBlock);

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT, null,
                { temperature: 0.2, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const verdict = JSON.parse(jsonMatch[0]);

            // 代码侧闸门（铁证走规则）——闸门定义在 screenEmergentVerdict()，
            // 生产和回归探针共用同一份，免得探针量到的是裸的模型输出。
            const screened = screenEmergentVerdict(verdict);
            if (!screened.accept) {
                if (verdict?.is_entity) {
                    console.log(`[Archivist] ⏭ 涌现判定被代码闸门拦下(${screened.reason}): "${verdict.name || ''}"`);
                }
                continue;
            }

            {
                const name = screened.name;

                let existing = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE LOWER(name) = LOWER(?)').get(name);
                if (!existing) {
                    const allEnts = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE status IN (\'active\',\'seed\')').all();
                    for (const e of allEnts) {
                        try {
                            const als = JSON.parse(e.aliases || '[]');
                            const nameLower = name.toLowerCase().trim();
                            if (als.some(a => { if (typeof a !== 'string') return false; const aL = a.toLowerCase().trim(); return aL === nameLower || aL.includes(nameLower) || nameLower.includes(aL); })) {
                                existing = e; break;
                            }
                        } catch (_) {}
                    }
                }
                if (!existing) {
                    existing = db.prepare(`SELECT id, name FROM entity_profiles WHERE status IN ('active','seed')
                        AND (LOWER(name) LIKE '%' || LOWER(?) || '%' OR LOWER(?) LIKE '%' || LOWER(name) || '%') LIMIT 1`).get(name, name);
                }
                if (!existing) {
                    const cands = db.prepare('SELECT id, name FROM entity_profiles WHERE status IN (\'active\',\'seed\')').all();
                    for (const c of cands) {
                        const aG = _nameBigrams(name), bG = _nameBigrams(c.name);
                        if (aG.size === 0 || bG.size === 0) continue;
                        let o = 0; for (const g of aG) if (bG.has(g)) o++;
                        if (o / Math.min(aG.size, bG.size) >= 0.6) { existing = c; break; }
                    }
                }
                if (existing) { console.log(`[Archivist] ⏭ 涌现种子去重跳过: "${name}" → 已有 "${existing.name}"`); continue; }

                const category = (verdict.category === 'event' || verdict.category === 'place')
                    ? verdict.category : 'term';
                const r = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases)
                    VALUES (?, ?, 'seed', ?)`).run(name, category, JSON.stringify([]));

                // 链接团内碎片到新种子
                const insertFe = db.prepare(`INSERT OR IGNORE INTO fragment_entities
                    (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.55, 'emergence')`);
                let linked = 0;
                for (const mid of cluster.member_ids.slice(0, 20)) {
                    const info = insertFe.run(mid, r.lastInsertRowid);
                    if (info.changes > 0) linked++;
                }
                db.prepare('UPDATE entity_profiles SET fragment_count = ? WHERE id = ?').run(linked, r.lastInsertRowid);

                console.log(`[Archivist] 🌟 涌现检测: ${name} (${category}) ← ${linked}碎片 (团${cluster.member_ids.length}条)`);
                detected++;

                // 写观星手记
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status)
                    VALUES ('emergent_constellation', ?, ?, 'done')`)
                    .run(category, JSON.stringify({ name, reason: verdict.reason, cluster_size: cluster.member_ids.length }));
            }
        } catch (e) {
            console.error('[Archivist] 涌现检测LLM失败:', e.message);
        }
    }

    return { detected };
}

module.exports = {
    buildEmergentJudgePrompt,
    screenEmergentVerdict,
    detectEmergentPlacesAndEvents,
};
