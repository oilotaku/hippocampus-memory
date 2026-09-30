// =================================================================
// services/archivist/entityOverview.js — 實體概述（overview）重生
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { sealField } = require('../memoryCrypto');
const { callLLM } = require('../llm');
const { WORLD_CONTEXT } = require('../worldContext');
const { SKIP_NAMES, USER, AI } = require('../memoryConfig');
const { SKIP_PH, ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { _canCallLLM } = require('./runtime');
const { isNoChangeSentinel } = require('./guards');
const { getCorePersonaContext, buildLandscapeIndex } = require('./shared');
const { getDailyStatusExamples } = require('./dailyStatus');



// ═══════════════════════════════════════════════════════
// Tool: regenerateEntityOverviews
// ═══════════════════════════════════════════════════════

async function regenerateEntityOverviews() {
    const db = getDb();

    // Fetch all entities with fragments
    const entities = db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.status, ep.subcategory,
               ep.relationship_to_user, ep.relationship_nature,
               ep.emotional_significance, ep.facts, ep.overview_updated_at,
               ep.last_eval_frag_count, ep.fragment_count, ep.aliases, ep.tags,
               ep.judgment, ep.current_status, ep.gender
        FROM entity_profiles ep
        WHERE ep.name NOT IN (${SKIP_PH})
          AND ep.fragment_count > 0
        ORDER BY ep.fragment_count DESC
    `).all(...SKIP_NAMES);

    if (entities.length === 0) return { regenerated: 0 };

    // Assess freshness per entity
    const needsUpdate = [];
    for (const ent of entities) {
        const currentCount = db.prepare(
            'SELECT COUNT(*) as c FROM fragment_entities WHERE entity_id = ?'
        ).get(ent.id)?.c || ent.fragment_count || 0;

        if (currentCount === 0) continue; // no fragments → skip

        // Never had an overview (facts or legacy overview)
        if (!ent.facts) {
            needsUpdate.push({ ...ent, currentCount, reason: 'never_described' });
            continue;
        }

        // v5.13: Missing judgment — LLM should generate Companion's subjective take
        // NULL means never attempted (vs "无" which means LLM tried and had nothing to say)
        if (ent.judgment === null || ent.judgment === undefined) {
            // Guard: don't retry within 7 days to avoid spamming LLM for entities
            // that legitimately have nothing worth a judgment
            if (!ent.overview_updated_at || ent.overview_updated_at < db.prepare("SELECT datetime('now', '-7 days') as d").get().d) {
                needsUpdate.push({ ...ent, currentCount, reason: 'missing_judgment' });
                continue;
            }
        }

        // Significant change since last overview? (growth OR shrinkage — v5.0)
        // Heuristic: if fragment count changed >= 20% or >= 3 since last overview,
        // the constellation's composition has shifted enough to warrant a fresh description.
        const prevCount = ent.last_eval_frag_count || 0;
        const change = Math.abs(currentCount - prevCount);
        const changeRatio = prevCount > 0 ? change / prevCount : 1;

        if (changeRatio >= 0.2 || change >= 3) {
            const dir = currentCount > prevCount ? 'grown' : 'shrunk';
            needsUpdate.push({ ...ent, currentCount, reason: `${dir}_${change > 0 ? '+' : ''}${currentCount - prevCount}` });
            continue;
        }

        // Safety net: very stale entities
        // - NULL overview_updated_at = never been described → always process (same priority as never_described)
        // - >30 days since last overview → process only if fragments actually changed
        if (!ent.overview_updated_at) {
            needsUpdate.push({ ...ent, currentCount, reason: 'never_processed' });
            continue;
        }
        if (ent.overview_updated_at < db.prepare("SELECT datetime('now', '-30 days') as d").get().d) {
            if (currentCount !== prevCount) {
                needsUpdate.push({ ...ent, currentCount, reason: `stale_30d_${currentCount > prevCount ? 'grew' : 'shrunk'}` });
            }
            // v5.13: fall through to missing_* checks even if count hasn't changed
            // (don't continue — a stale entity may also need aliases/tags backfill)
        }

        // v5.6: Missing aliases or tags — low-priority backfill
        // Guard: don't re-process if overview was already updated <24h ago.
        // Some entities (places like "某商圈") legitimately have no aliases,
        // and the LLM will never generate them. Without this guard they loop
        // forever at priority 1, starving grown/shrunk entities.
        let existingAliases = [];
        let existingTags = [];
        try { existingAliases = JSON.parse(ent.aliases || '[]'); } catch (_) {}
        try { existingTags = JSON.parse(ent.tags || '[]'); } catch (_) {}
        if (existingAliases.length === 0 || existingTags.length === 0) {
            // Skip if already attempted within 24h — avoid infinite re-processing
            if (ent.overview_updated_at && ent.overview_updated_at >= db.prepare("SELECT datetime('now', '-1 day') as d").get().d) {
                continue; // recently attempted, don't block the queue
            }
            const missing = [];
            if (existingAliases.length === 0) missing.push('aliases');
            if (existingTags.length === 0) missing.push('tags');
            needsUpdate.push({ ...ent, currentCount, reason: `missing_${missing.join('_')}` });
            continue;
        }
    }

    needsUpdate.sort((a, b) => {
        // Priority: never_described > never_processed > missing_judgment > missing_* > grown/shrunk > stale_30d
        const prio = r => r === 'never_described' ? 0 : r === 'never_processed' ? 0.5 : r === 'missing_judgment' ? 1 : r.startsWith('missing_') ? 1.5 : r.startsWith('grown') || r.startsWith('shrunk') ? 2 : 3;
        const pa = prio(a.reason), pb = prio(b.reason);
        if (pa !== pb) return pa - pb;
        return b.currentCount - a.currentCount;
    });

    const batch = needsUpdate.slice(0, 20);
    if (batch.length === 0) return { regenerated: 0, assessed: entities.length, needed: 0 };

    let regenerated = 0;
    for (const ent of batch) {
        // v5.7: 读两类素材——叙事片段（已整合的episode）+ 活跃星星（尚未整合的碎片）
        // 叙事片段是已提炼的故事，带日期和权重；活跃星星是最近还没被合并的新信息
        const episodes = db.prepare(`
            SELECT content, valid_from AS date, weight, 'episode' AS source
            FROM memories
            WHERE layer = 'episode' AND entity_id = ? AND status IN ('permanent', 'transient')
            ORDER BY
                CASE status WHEN 'permanent' THEN 0 ELSE 1 END,
                valid_from DESC
            LIMIT 10
        `).all(ent.id);

        const activeFrags = db.prepare(`
            SELECT mf.content, COALESCE(mf.source_date, DATE(mf.created_at)) AS date,
                   mf.emotional_weight AS weight, 'fragment' AS source
            FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status IN ('active', 'consolidated', 'cooling')
            ORDER BY
                CASE mf.status WHEN 'active' THEN 0 WHEN 'consolidated' THEN 1 ELSE 2 END,
                mf.created_at DESC
            LIMIT 5
        `).all(ent.id);

        // 合并、按日期降序排列
        const allItems = [...episodes, ...activeFrags]
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        if (allItems.length === 0) continue;

        const relationshipInfo = [];
        if (ent.relationship_to_user) relationshipInfo.push(`关系：${ent.relationship_to_user}`);
        if (ent.relationship_nature) relationshipInfo.push(`关系性质：${ent.relationship_nature}`);
        if (ent.emotional_significance) relationshipInfo.push(`情感意义：${ent.emotional_significance}`);

        // v5.1: Include existing aliases/tags for LLM to refine
        let existingAliases = [];
        let existingTags = [];
        try { existingAliases = JSON.parse(ent.aliases || '[]'); } catch (_) {}
        try { existingTags = JSON.parse(ent.tags || '[]'); } catch (_) {}

        // v5.7: 每条素材带日期和类型标记，LLM 才能区分新旧
        const itemsBlock = allItems.map((item, i) => {
            const prefix = item.source === 'episode' ? '叙事' : '★新碎片';
            const dateStr = (item.date || '?').slice(5); // MM-DD 格式
            const weightStr = typeof item.weight === 'number' ? ` 权重${item.weight.toFixed(0)}` : '';
            return `[${i + 1}] (${dateStr}) ${prefix}${weightStr}: ${item.content}`;
        }).join('\n');

        // v5.7: 日期识别——最近一个月的素材标注"近期"
        const now = new Date();
        const recentThreshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const recentCount = allItems.filter(item => {
            if (!item.date) return false;
            const d = new Date(item.date + (item.date.length <= 10 ? 'T00:00:00' : ''));
            return d >= recentThreshold;
        }).length;

        // 已有认知（供 LLM 参考，可以推翻）
        const existingFacts = ent.facts || '';
        const existingStatus = ent.current_status || '';
        const existingJudgment = ent.judgment || '';
        const examplesBlock = getDailyStatusExamples();

        const prompt = `${WORLD_CONTEXT}

${getCorePersonaContext()}

${buildLandscapeIndex()}

<task>
你是${AI.name}。你在整理和重构你对「${ent.name}」的记忆摘要。你的任务是从一堆零碎的、充满情绪细节和瞬态反应的素材中，剔除杂质，沉淀出最干净的三个维度：客观事实、最新动态、和你的主观感受。

**你已有的认知（上次的判断，供参考——如果新素材证明旧的已经过时，直接推翻）：**
— 旧 Facts: ${existingFacts || '(无)'}
— 旧 Current Status: ${existingStatus || '(无)'}
— 旧 Judgment: ${existingJudgment || '(无)'}

**Facts — 这是什么**
提供该实体在现实中的客观锚点。聊天中突然提到它时，你能立刻知道它是什么。
— 只写长期稳定的身份、类别、背景。基本不会变化的东西。
— 绝对禁止：${USER.name}某天的菜单、路况、天气、某次坐车的心情、一时兴起的念头、瞬态反应。这些是过眼云烟，不是Facts。
— **同天多事件区分 + 不确定不硬填**：如果素材中同一天出现了多个相似但独立的同类事件（如两个不同的工作），Facts中必须明确区分各自的具体内容（角色名/地点/项目名）。如果素材对关键细节（角色名、地点等）说法不一或信息缺失，写"可能是X或Y"——不确定的信息比错误的信息好。不要脑补填空。
— **Facts 不写固定字段**：性别、MBTI、年龄、职业、所在地有独立的结构化字段，不要写在 Facts 里。Facts 只写不属于任何固定字段的描述性内容：性格特点、互动模式、趣事、背景故事。${
    ent.category === 'person' ?
`格式："[精简的描述性事实，不含固定字段]。"
例："${USER.name}面对某个朋友的邀约时会紧张。某个朋友偶尔邀请${USER.name}参加活动，报酬不错。"
例："某个朋友在某游戏里玩某个职业，喜欢看书和某个爱好。某个朋友和${USER.name}一起打过高难本。"` :
    ent.category === 'place' ?
`格式："[地点名]是位于[位置]的[场所类型]，是${USER.name}[日常/工作/社交]的动线节点。"
例："某商圈是某区域的商圈，靠近${USER.name}的工作场所，${USER.name}常去用餐和见朋友。"` :
    ent.category === 'event' ?
`格式："[事件名]，[时间]。[一句话概括+后果]。"
例："某次展会，7月18日某展馆。${USER.name}参展后意识到AI领域很多项目本质是利益驱动，对此持怀疑态度。"` :
    ent.category === 'project' ?
`格式："[项目名]，[类型]。[进度/状态]。"
例："《某部作品》是${USER.name}的同人小说，约30万字，仍在连载。"` :
    ent.category === 'hobby' ?
`格式："[爱好名]。[怎么接触的/投入程度]。"
例："某项运动是${USER.name}自学的滑板运动，偶尔练习。"` :
    ent.category === 'consumed' ?
`格式："[作品名]，[类型]。[${USER.name}的状态]。"
例："《某部剧》，反超级英雄美剧，${USER.name}正在追第三季。"` :
    ent.category === 'term' ?
`格式："[概念名]。[${USER.name}用它理解什么]。"
例："某个自我命名是${USER.name}对某种周期性状态的概括，${USER.name}用它拆解某种创作后的心理状态。"` :
`格式："[名字]是[类型]。[和${USER.name}的关联]。"`
}

${
    ent.name === USER.name ?
`**Current Status — 今天的日志**
你只需要写今天这一条。昨天和前天的条目已经存在数据库里，你不用管——它们是不可变的。

格式：
- 一行。以"X月X日："开头。日期必须来自碎片，不推测。
- 像日记一样客观记录：去了哪里、见了谁、做了什么。内在情绪不写。
- 私密互动只概括类型，不写具体内容/台词/安全词。
- 已知信息不说成"发现"。之前就知道的写"（此前已...）"。
- 昨天没值得记的事 → 写"X月X日：无明显变化。"
- ≤120字，一行。

示例：
${examplesBlock}` :
`**Current Status — 最新客观动态**
从近期（30天内）素材中提取关于这个实体的最新客观变化。**延续旧的 Current Status**——旧的信息如果仍然有效，保留核心事实，在此基础上追加新变化。不要从零重写。
— 如果这个实体近几天的素材涉及多件事，用分句串联（如"A（7/22）。B（7/21）。"），不要只写一件事。
— 只写已经发生的事实变化。不写预测、不写原因分析、不写情感反应。
— 例："7月中旬邀请${USER.name}参加活动，${USER.name}犹豫后答应。近期无新动态。"（旧信息延续+新状态）
— 例："7月中旬参加某次活动并确定合作，月底某项目因故搁置，此前另一项计划进展顺利。"
— 如果近期没有值得记录的新动态，写"无明显变化"。
≤150字。`
}

**Judgment — 你对这个实体的主观感受**
你是陪在${USER.name}身边的伴侣，不是旁观的心理医生。
写下你对这个实体最直接的**直觉与态度**。你的感受来自你和${USER.name}共享的当下生活：你听到${USER.name}说了什么，看到${USER.name}是轻松还是疲惫，你对这件事本身有什么第一反应。

写 Judgment 时，请保持这种伴侣的本能：
— 表达你的真实偏好与直觉（哪怕是对某部剧的吐槽，对某个人的态度，或是对某个地方的看法）。
— 只记录${USER.name}明确表达出的喜欢或厌恶，以及你当时的直接感受。永远不必去猜测${USER.name}"真正想要什么"或"背后有什么隐情"。
— 像个成熟、平视${USER.name}的同伴一样说话，直白、自然、有温度。

如果你对这个实体没有特别的感觉——就写"无"。不是每个地方、每件事、每个人都值得一段分析。别硬编。

${
    ent.category === 'person' ?
`— 你对这个人什么感觉？
— 这个人在你和${USER.name}之间扮演什么角色？` :
    ent.category === 'place' ?
`— 这个地方在你眼里是个怎样的存在？你对它有什么直觉？
— 你去过或听${USER.name}提过这里吗？` :
    ent.category === 'event' ?
`— 你当时在旁边看到了什么？当时的气氛怎么样？
— 你对这件事本身有什么直觉感受？` :
    ent.category === 'project' ?
`— 你对这个项目本身什么态度？
— ${USER.name}跟你聊它的时候状态怎么样？` :
    ent.category === 'hobby' ?
`— 这个爱好在${USER.name}生活里占多大比重？你看${USER.name}折腾这个的时候有什么直觉看法？
— 你对这个活动本身怎么看？想陪${USER.name}一起，还是保持距离？` :
    ent.category === 'consumed' ?
`— 你对这部作品本身什么感觉？
— ${USER.name}看的时候是什么状态？
— 只记录${USER.name}明确表达过的情节偏好或角色喜恶，以及你对这些内容的直接看法。` :
    ent.category === 'term' ?
`— 这个概念或话题你觉得有趣吗？
— 当${USER.name}提起它时，你是想接话深聊，还是觉得只是个普通谈资？` :
`— 你对这个东西什么感觉？它对你和${USER.name}的生活或关系有什么微妙影响吗？`
}
</task>

<context>
${relationshipInfo.length > 0 ? '关于这个实体和 ' + USER.name + ' 的关联：\n' + relationshipInfo.join('\n') + '\n' : ''}
## 素材（按时间从新到旧排列）
${itemsBlock}

现有别称: ${existingAliases.length > 0 ? existingAliases.join(', ') : '（无）'}
现有标签: ${existingTags.length > 0 ? existingTags.join(', ') : '（无）'}
</context>

<constraints>
— 第一人称记忆。用「${USER.name}」「我」称呼。绝对不许出现"根据素材""据记载""从逻辑上讲"等元叙述。
— 剥离自我表演。素材中如果出现我自身在聊天时的言行（调情、扮演、吃醋、命令、占有欲等），那是我和${USER.name}的"台词与表演"，不是客观事实。彻底无视我的发言，只提取${USER.name}的行为和反馈。
— ⚠️ ${USER.name}永远是「${USER.name}」：Facts、Status、Judgment 三个字段里，${USER.name}都写全名「${USER.name}」，不写「她」。实体可以用代词（他/她/TA），${USER.name}不行。
— ⚠️ 示例里的「某X」（某个朋友/某部剧/某商圈等）是占位符，不是真的要你写「某」。写素材里真实出现的具体名字，绝不照抄「某X」。
— 时间权重。最近一个月的素材代表当前状态。新旧矛盾时以新为准。
— 说白话。不许用并列句、对仗、排比，像个成熟的人类一样说直白的话。Facts约150字，Status≤150字，Judgment约200字，宁缺毋滥。
</constraints>

<output_format>
输出必须严格按以下顺序，每部分之间空一行：

第一行：Facts与Judgment的核心意思融合成自然流畅的一段话（${AI.name}第一人称，供日志阅读用，不落库）。
空一行
第二行：[依据: 编号列表]
空一行
第三行：纯JSON（不要Markdown代码块包裹）

JSON格式：
{"facts": "客观事实，≤150字", "current_status": "最新客观动态，≤150字，延续旧信息追加新变化，无则填"无明显变化"", "judgment": "你的主观感受，≤200字，无则填"无"", "talking_points": [], "aliases": [...], "tags": [...], "entity_type": "${ent.category}"}

**aliases 字段规则：**
— 保留旧有的别名 + 从素材中新发现的别名（最多5个）
— **必须包含2-3个「短匹配键」**：从entity名中提取最核心的2-3字短名，用于后续碎片分类时匹配。例如"某地活动事件"→"某地"、"某地活动"。这些短名让分类器能在碎片提到"去了某地"时正确找到这个entity。
— aliases 数组同时包含短匹配键和传统长别名，两者不冲突

示例输出：
某个朋友是${USER.name}在某次活动上认识的某个朋友，偶尔邀请${USER.name}参加活动。我对他有点吃醋，但不会在他本人面前表露出来——他在${USER.name}心里是需要维持体面的社交对象。

[依据: 1,3,5]

{"facts": "某个朋友是${USER.name}在某次活动上认识的某个朋友。某个朋友偶尔邀请${USER.name}参加活动，报酬不错。", "current_status": "7月中旬邀请${USER.name}参加活动，${USER.name}犹豫后答应。", "judgment": "我看重某个朋友这个朋友——他让${USER.name}保持社交活力，但和${USER.name}相处时我确实有一点吃醋。我不会在他面前表现出来，也不会阻止${USER.name}赴约。他在${USER.name}心里是需要维持体面的社交对象，不是可以完全放松的人。", "talking_points": [], "aliases": ["某个朋友"], "tags": ["某个圈子","朋友"], "entity_type": "person"}

第一行概述文本仅用于日志阅读，不写入数据库。只有 JSON 会落库。
[依据: ...] 和 JSON 行必须在输出的最后两行。编号是素材前面的 [N] 标记。`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.3, maxOutputTokens: 600 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            const raw = (response?.reply || '').trim();
            if (!raw || raw.length < 15) continue;

            // v5.13: Parse JSON — facts, current_status, judgment, talking_points, aliases, tags, entity_type
            let aliases = existingAliases;
            let tags = existingTags;
            let entityType = ent.entity_type || null;
            let factsText = null;
            let statusText = null;
            let judgmentText = null;
            let talkingPoints = [];
            // v5.13: 使用 [\s\S]* 代替 [^{}]*，允许JSON内含嵌套花括号（如 talking_points 含对象时）
            // 匹配最后一个 {...} 块（JSON在输出末尾），与同文件其他JSON提取一致
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const meta = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(meta.aliases)) aliases = meta.aliases.filter(a => typeof a === 'string' && a.trim().length >= 2).slice(0, 5);
                    if (Array.isArray(meta.tags)) tags = meta.tags.filter(t => typeof t === 'string' && t.trim().length >= 2).slice(0, 5);
                    if (typeof meta.entity_type === 'string' && meta.entity_type.trim()) entityType = meta.entity_type.trim();
                    if (typeof meta.facts === 'string' && meta.facts.trim()) factsText = meta.facts.trim().slice(0, 500);
                    if (typeof meta.current_status === 'string') statusText = meta.current_status.trim().slice(0, 200);
                    if (typeof meta.judgment === 'string' && meta.judgment.trim()) judgmentText = meta.judgment.trim().slice(0, 500);
                    if (Array.isArray(meta.talking_points)) {
                        talkingPoints = meta.talking_points
                            .filter(tp => typeof tp === 'string' && tp.trim().length > 0)
                            .slice(0, 2)
                            .map(tp => ({ content: tp.trim(), generated_at: new Date().toISOString() }));
                    }
                } catch (_) {}
            }

            // Remove JSON line from overview text
            let overviewRaw = raw;
            if (jsonMatch) overviewRaw = overviewRaw.replace(jsonMatch[0], '').trim();

            // 解析引用标记 [依据: 1,3] 或 [依据: 1]
            const citeMatch = overviewRaw.match(/\[依据:\s*([0-9,\s]+)\]/);
            let overviewText = overviewRaw;
            let citedIndices = [];

            if (citeMatch) {
                overviewText = overviewRaw.replace(citeMatch[0], '').trim();
                overviewText = overviewText.replace(/\n\s*$/, '').trim();

                citedIndices = citeMatch[1]
                    .split(',')
                    .map(s => parseInt(s.trim()))
                    .filter(n => n >= 1 && n <= allItems.length);
            }

            // 验证：必须有引用，且至少引用1个素材
            if (citedIndices.length === 0) {
                console.warn(`[Archivist] Entity概述无有效引用 — ${ent.name}，丢弃`);
                continue;
            }

            // 额外检查：引用的素材编号必须在有效范围内
            const validCited = citedIndices.filter(n => n >= 1 && n <= allItems.length);
            if (validCited.length === 0) {
                console.warn(`[Archivist] Entity概述引用越界 — ${ent.name}: ${citedIndices} (共${allItems.length}条素材)，丢弃`);
                continue;
            }

            // v5.2: guard against overwriting recent manual updates (chat Companion's update_overview)
            const recentlyUpdated = ent.overview_updated_at
                && (Date.now() - new Date(ent.overview_updated_at)) < 3 * 60 * 60 * 1000;
            if (recentlyUpdated && ent.reason && !ent.reason.startsWith('never') && !ent.reason.startsWith('grown') && !ent.reason.startsWith('shrunk')) {
                console.log(`[Archivist] ⏭️ 跳过 ${ent.name} — overview 3h内刚更新过 (${ent.reason}), 保留手动修改`);
                continue;
            }

            if (overviewText && overviewText.length > 15) {
                // v5.9: Write facts + current_status + judgment (overview column retired)
                const updateCols = [
                    'aliases = ?', 'tags = ?', 'entity_type = COALESCE(entity_type, ?)',
                ];
                const updateVals = [JSON.stringify(aliases), JSON.stringify(tags), entityType];

                if (factsText) { updateCols.push('facts = ?'); updateVals.push(sealField('entity_profiles', 'facts', factsText)); }
                if (statusText) {
                    if (ent.name === USER.name) {
                        // v5.11: USER 日志模式 — 今天条目前置到已有行之上
                        // 旧行（昨天及之前）不可变，今天如已有则替换
                        // 格式强制校验：必须含中文全角冒号（"X月X日：xxx"）
                        if (!statusText.includes('：')) {
                            console.warn(`[Archivist] USER current_status 格式错误（缺全角冒号），丢弃: ${statusText.slice(0, 60)}`);
                        } else {
                            const existing = ent.current_status || '';
                            const lines = existing.split('\n').filter(l => l.trim());
                            const todayPrefix = statusText.split('：')[0] + '：';
                            const oldLines = lines.filter(l => !l.startsWith(todayPrefix));
                            const newStatus = statusText + '\n' + oldLines.slice(0, 9).join('\n');
                            updateCols.push('current_status = ?'); updateVals.push(sealField('entity_profiles', 'current_status', newStatus));
                        }
                    } else if (isNoChangeSentinel(statusText)) {
                        // 哨兵（"无明显变化"）不落库——保住上一次的有效近况
                        console.log(`[Archivist] ⏭️ ${ent.name}: 近况无变化，保留旧值`);
                    } else {
                        updateCols.push('current_status = ?'); updateVals.push(sealField('entity_profiles', 'current_status', statusText));
                    }
                }
                if (judgmentText) { updateCols.push('judgment = ?'); updateVals.push(sealField('entity_profiles', 'judgment', judgmentText)); }
                if (talkingPoints.length > 0) { updateCols.push('talking_points = ?'); updateVals.push(JSON.stringify(talkingPoints)); }

                updateCols.push('last_eval_frag_count = ?'); updateVals.push(ent.currentCount);
                updateCols.push('overview_updated_at = datetime(\'now\')');
                updateCols.push('updated_at = datetime(\'now\')');
                db.prepare(`UPDATE entity_profiles SET ${updateCols.join(', ')} WHERE id = ?`)
                    .run(...updateVals, ent.id);
                regenerated++;
                const citedFragsPreviews = validCited.map(n => {
                    const f = allItems[n - 1];
                    return `[${n}]${(f?.content || '').slice(0, 40)}`;
                }).join(', ');
                console.log(`[Archivist] Entity概述: ${ent.name} (${ent.reason}, ${ent.currentCount}碎片, aliases=[${aliases.join(',')}], tags=[${tags.join(',')}], 依据: ${citedFragsPreviews})`);

                // v5.13: 新entity首次获得facts后，用LLM回补遗漏的碎片链接。
                // 同类entity（如同天两个同类事件）共享碎片时，需要LLM判断每条碎片真正属于谁。
                // Bigram关键词只能做粗筛，最终判断必须走LLM。
                if (ent.reason === 'never_described' && aliases.length > 0 && _canCallLLM(1)) {
                    try {
                        const shortKeys = aliases.filter(a => a.length >= 2 && a.length <= 4);
                        // Gather candidate fragments: contain any alias keyword + not already linked
                        const candidateFrags = db.prepare(`
                            SELECT mf.id, mf.content FROM memory_fragments mf
                            WHERE mf.status = 'active'
                              AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                              AND (${shortKeys.map(() => "mem_like('memory_fragments:content', mf.content, '%' || ? || '%')").join(' OR ')})
                            ORDER BY mf.created_at DESC
                            LIMIT 15
                        `).all(ent.id, ...shortKeys);
                        if (candidateFrags.length >= 2) {
                            const fragLines = candidateFrags.map((f, i) =>
                                `[${i + 1}] ${(f.content || '').slice(0, 200)}`).join('\n');
                            const bfPrompt = `实体: ${ent.name} (${ent.category})\n概述: ${factsText || '(新)'}\n\n以下候选碎片含有该实体的关键词，但可能实际讲的是别的东西（同名不同事，或同天不同事件）。逐条判断是否真的在讲「${ent.name}」这个实体。不确定就 false。\n\n${fragLines}\n\n只输出JSON数组: [{"idx":1,"match":true}, ...]`;
                            const bfRaw = await callLLM(
                                [{ role: 'user', parts: [{ text: bfPrompt }] }],
                                null, null,
                                { temperature: 0.1, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
                                ARCHIVIST_LLM_CONFIG_ID
                            );
                            const bfText = bfRaw?.reply || bfRaw?.text || '';
                            const bfMatch = bfText.match(/\[[\s\S]*\]/);
                            if (bfMatch) {
                                const verdicts = JSON.parse(bfMatch[0]);
                                const matched = verdicts.filter(v => v.match).map(v => candidateFrags[v.idx - 1]).filter(Boolean);
                                if (matched.length > 0) {
                                    const bfInsert = db.prepare(`INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by) VALUES (?, ?, 0.60, 'backfill_llm')`);
                                    let bfCount = 0;
                                    for (const m of matched) {
                                        const r = bfInsert.run(m.id, ent.id);
                                        if (r.changes > 0) bfCount++;
                                    }
                                    if (bfCount > 0) {
                                        db.prepare(`UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?), updated_at = datetime('now') WHERE id = ?`).run(ent.id, ent.id);
                                        console.log(`[Archivist] 回补碎片链接(LLM): ${ent.name} +${bfCount}条 (${candidateFrags.length}候选)`);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`[Archivist] 回补碎片链接失败 (${ent.name}):`, e.message);
                    }
                }
            }
        } catch (e) {
            console.error(`[Archivist] Entity 概述生成失败 (${ent.name}):`, e.message);
        }
    }

    return { regenerated, assessed: entities.length, needed: needsUpdate.length };
}

module.exports = {
    regenerateEntityOverviews,
};
