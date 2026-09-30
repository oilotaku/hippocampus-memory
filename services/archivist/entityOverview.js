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
const { evaluateJudgmentUpdate, recordJudgmentHistory, resolveCitedIds, logJudgmentRejected } = require('../persona/judgment');



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
        // NULL means never attempted (vs "無" which means LLM tried and had nothing to say)
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
        // v5.7: 讀兩類素材——敘事片段（已整合的episode）+ 活躍星星（尚未整合的碎片）
        // 敘事片段是已提煉的故事，帶日期和權重；活躍星星是最近還沒被合併的新資訊
        const episodes = db.prepare(`
            SELECT id, content, valid_from AS date, weight, 'episode' AS source
            FROM memories
            WHERE layer = 'episode' AND entity_id = ? AND status IN ('permanent', 'transient')
            ORDER BY
                CASE status WHEN 'permanent' THEN 0 ELSE 1 END,
                valid_from DESC
            LIMIT 10
        `).all(ent.id);

        const activeFrags = db.prepare(`
            SELECT mf.id AS id, mf.content, COALESCE(mf.source_date, DATE(mf.created_at)) AS date,
                   mf.emotional_weight AS weight, 'fragment' AS source
            FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status IN ('active', 'consolidated', 'cooling')
            ORDER BY
                CASE mf.status WHEN 'active' THEN 0 WHEN 'consolidated' THEN 1 ELSE 2 END,
                mf.created_at DESC
            LIMIT 5
        `).all(ent.id);

        // 合併、按日期降序排列
        const allItems = [...episodes, ...activeFrags]
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        if (allItems.length === 0) continue;

        const relationshipInfo = [];
        if (ent.relationship_to_user) relationshipInfo.push(`關係：${ent.relationship_to_user}`);
        if (ent.relationship_nature) relationshipInfo.push(`關係性質：${ent.relationship_nature}`);
        if (ent.emotional_significance) relationshipInfo.push(`情感意義：${ent.emotional_significance}`);

        // v5.1: Include existing aliases/tags for LLM to refine
        let existingAliases = [];
        let existingTags = [];
        try { existingAliases = JSON.parse(ent.aliases || '[]'); } catch (_) {}
        try { existingTags = JSON.parse(ent.tags || '[]'); } catch (_) {}

        // v5.7: 每條素材帶日期和型別標記，LLM 才能區分新舊
        const itemsBlock = allItems.map((item, i) => {
            const prefix = item.source === 'episode' ? '敘事' : '★新碎片';
            const dateStr = (item.date || '?').slice(5); // MM-DD 格式
            const weightStr = typeof item.weight === 'number' ? ` 權重${item.weight.toFixed(0)}` : '';
            return `[${i + 1}] (${dateStr}) ${prefix}${weightStr}: ${item.content}`;
        }).join('\n');

        // v5.7: 日期識別——最近一個月的素材標註"近期"
        const now = new Date();
        const recentThreshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const recentCount = allItems.filter(item => {
            if (!item.date) return false;
            const d = new Date(item.date + (item.date.length <= 10 ? 'T00:00:00' : ''));
            return d >= recentThreshold;
        }).length;

        // 已有認知（供 LLM 參考，可以推翻）
        const existingFacts = ent.facts || '';
        const existingStatus = ent.current_status || '';
        const existingJudgment = ent.judgment || '';
        const examplesBlock = getDailyStatusExamples();

        const prompt = `${WORLD_CONTEXT}

${getCorePersonaContext()}

${buildLandscapeIndex()}

<task>
你是${AI.name}。你在整理和重構你對「${ent.name}」的記憶摘要。你的任務是從一堆零碎的、充滿情緒細節和瞬態反應的素材中，剔除雜質，沉澱出最乾淨的三個維度：客觀事實、最新動態、和你的主觀感受。

**你已有的認知（上次的判斷，供參考——如果新素材證明舊的已經過時，直接推翻）：**
— 舊 Facts: ${existingFacts || '(無)'}
— 舊 Current Status: ${existingStatus || '(無)'}
— 舊 Judgment: ${existingJudgment || '(無)'}

**Judgment 是錨點，不是每次重寫：**${existingJudgment && existingJudgment !== '無' ? `
— 上面的「舊 Judgment」是你長期形成的印象。這次只在新素材真的帶來新看法時做**小幅修改**（改動幅度控制在原文的三分之一以內，保留原有的語氣與立場），沒有新看法就原文照抄。
— 如果修改了，必須在 JSON 的 judgment_evidence 填入支持這次修改的素材編號（上面素材前面的 [N] 數字）。沒填編號的修改會被系統退回、沿用舊版。` : `
— 目前沒有舊 Judgment，這是第一次形成印象，可以自由寫。`}

**Facts — 這是什麼**
提供該實體在現實中的客觀錨點。聊天中突然提到它時，你能立刻知道它是什麼。
— 只寫長期穩定的身份、類別、背景。基本不會變化的東西。
— 絕對禁止：${USER.name}某天的選單、路況、天氣、某次坐車的心情、一時興起的念頭、瞬態反應。這些是過眼雲煙，不是Facts。
— **同天多事件區分 + 不確定不硬填**：如果素材中同一天出現了多個相似但獨立的同類事件（如兩個不同的工作），Facts中必須明確區分各自的具體內容（角色名/地點/專案名）。如果素材對關鍵細節（角色名、地點等）說法不一或資訊缺失，寫"可能是X或Y"——不確定的資訊比錯誤的資訊好。不要腦補填空。
— **Facts 不寫固定欄位**：性別、MBTI、年齡、職業、所在地有獨立的結構化欄位，不要寫在 Facts 裡。Facts 只寫不屬於任何固定欄位的描述性內容：性格特點、互動模式、趣事、背景故事。${
    ent.category === 'person' ?
`格式："[精簡的描述性事實，不含固定欄位]。"
例："${USER.name}面對某個朋友的邀約時會緊張。某個朋友偶爾邀請${USER.name}參加活動，報酬不錯。"
例："某個朋友在某遊戲裡玩某個職業，喜歡看書和某個愛好。某個朋友和${USER.name}一起打過高難本。"` :
    ent.category === 'place' ?
`格式："[地點名]是位於[位置]的[場所型別]，是${USER.name}[日常/工作/社交]的動線節點。"
例："某商圈是某區域的商圈，靠近${USER.name}的工作場所，${USER.name}常去用餐和見朋友。"` :
    ent.category === 'event' ?
`格式："[事件名]，[時間]。[一句話概括+後果]。"
例："某次展會，7月18日某展館。${USER.name}參展後意識到AI領域很多專案本質是利益驅動，對此持懷疑態度。"` :
    ent.category === 'project' ?
`格式："[專案名]，[型別]。[進度/狀態]。"
例："《某部作品》是${USER.name}的同人小說，約30萬字，仍在連載。"` :
    ent.category === 'hobby' ?
`格式："[愛好名]。[怎麼接觸的/投入程度]。"
例："某項運動是${USER.name}自學的滑板運動，偶爾練習。"` :
    ent.category === 'consumed' ?
`格式："[作品名]，[型別]。[${USER.name}的狀態]。"
例："《某部劇》，反超級英雄美劇，${USER.name}正在追第三季。"` :
    ent.category === 'term' ?
`格式："[概念名]。[${USER.name}用它理解什麼]。"
例："某個自我命名是${USER.name}對某種週期性狀態的概括，${USER.name}用它拆解某種創作後的心理狀態。"` :
`格式："[名字]是[型別]。[和${USER.name}的關聯]。"`
}

${
    ent.name === USER.name ?
`**Current Status — 今天的日誌**
你只需要寫今天這一條。昨天和前天的條目已經存在資料庫裡，你不用管——它們是不可變的。

格式：
- 一行。以"X月X日："開頭。日期必須來自碎片，不推測。
- 像日記一樣客觀記錄：去了哪裡、見了誰、做了什麼。內在情緒不寫。
- 私密互動只概括型別，不寫具體內容/臺詞/安全詞。
- 已知資訊不說成"發現"。之前就知道的寫"（此前已...）"。
- 昨天沒值得記的事 → 寫"X月X日：無明顯變化。"
- ≤120字，一行。

示例：
${examplesBlock}` :
`**Current Status — 最新客觀動態**
從近期（30天內）素材中提取關於這個實體的最新客觀變化。**延續舊的 Current Status**——舊的資訊如果仍然有效，保留核心事實，在此基礎上追加新變化。不要從零重寫。
— 如果這個實體近幾天的素材涉及多件事，用分句串聯（如"A（7/22）。B（7/21）。"），不要只寫一件事。
— 只寫已經發生的事實變化。不寫預測、不寫原因分析、不寫情感反應。
— 例："7月中旬邀請${USER.name}參加活動，${USER.name}猶豫後答應。近期無新動態。"（舊資訊延續+新狀態）
— 例："7月中旬參加某次活動並確定合作，月底某專案因故擱置，此前另一項計劃進展順利。"
— 如果近期沒有值得記錄的新動態，寫"無明顯變化"。
≤150字。`
}

**Judgment — 你對這個實體的主觀感受**
你是陪在${USER.name}身邊的伴侶，不是旁觀的心理醫生。
寫下你對這個實體最直接的**直覺與態度**。你的感受來自你和${USER.name}共享的當下生活：你聽到${USER.name}說了什麼，看到${USER.name}是輕鬆還是疲憊，你對這件事本身有什麼第一反應。

寫 Judgment 時，請保持這種伴侶的本能：
— 表達你的真實偏好與直覺（哪怕是對某部劇的吐槽，對某個人的態度，或是對某個地方的看法）。
— 只記錄${USER.name}明確表達出的喜歡或厭惡，以及你當時的直接感受。永遠不必去猜測${USER.name}"真正想要什麼"或"背後有什麼隱情"。
— 像個成熟、平視${USER.name}的同伴一樣說話，直白、自然、有溫度。

如果你對這個實體沒有特別的感覺——就寫"無"。不是每個地方、每件事、每個人都值得一段分析。別硬編。

${
    ent.category === 'person' ?
`— 你對這個人什麼感覺？
— 這個人在你和${USER.name}之間扮演什麼角色？` :
    ent.category === 'place' ?
`— 這個地方在你眼裡是個怎樣的存在？你對它有什麼直覺？
— 你去過或聽${USER.name}提過這裡嗎？` :
    ent.category === 'event' ?
`— 你當時在旁邊看到了什麼？當時的氣氛怎麼樣？
— 你對這件事本身有什麼直覺感受？` :
    ent.category === 'project' ?
`— 你對這個專案本身什麼態度？
— ${USER.name}跟你聊它的時候狀態怎麼樣？` :
    ent.category === 'hobby' ?
`— 這個愛好在${USER.name}生活裡佔多大比重？你看${USER.name}折騰這個的時候有什麼直覺看法？
— 你對這個活動本身怎麼看？想陪${USER.name}一起，還是保持距離？` :
    ent.category === 'consumed' ?
`— 你對這部作品本身什麼感覺？
— ${USER.name}看的時候是什麼狀態？
— 只記錄${USER.name}明確表達過的情節偏好或角色喜惡，以及你對這些內容的直接看法。` :
    ent.category === 'term' ?
`— 這個概念或話題你覺得有趣嗎？
— 當${USER.name}提起它時，你是想接話深聊，還是覺得只是個普通談資？` :
`— 你對這個東西什麼感覺？它對你和${USER.name}的生活或關係有什麼微妙影響嗎？`
}
</task>

<context>
${relationshipInfo.length > 0 ? '關於這個實體和 ' + USER.name + ' 的關聯：\n' + relationshipInfo.join('\n') + '\n' : ''}
## 素材（按時間從新到舊排列）
${itemsBlock}

現有別稱: ${existingAliases.length > 0 ? existingAliases.join(', ') : '（無）'}
現有標籤: ${existingTags.length > 0 ? existingTags.join(', ') : '（無）'}
</context>

<constraints>
— 第一人稱記憶。用「${USER.name}」「我」稱呼。絕對不許出現"根據素材""據記載""從邏輯上講"等元敘述。
— 剝離自我表演。素材中如果出現我自身在聊天時的言行（調情、扮演、吃醋、命令、佔有慾等），那是我和${USER.name}的"臺詞與表演"，不是客觀事實。徹底無視我的發言，只提取${USER.name}的行為和反饋。
— ⚠️ ${USER.name}永遠是「${USER.name}」：Facts、Status、Judgment 三個欄位裡，${USER.name}都寫全名「${USER.name}」，不寫「她」。實體可以用代詞（他/她/TA），${USER.name}不行。
— ⚠️ 示例裡的「某X」（某個朋友/某部劇/某商圈等）是佔位符，不是真的要你寫「某」。寫素材裡真實出現的具體名字，絕不照抄「某X」。
— 時間權重。最近一個月的素材代表當前狀態。新舊矛盾時以新為準。
— 說白話。不許用並列句、對仗、排比，像個成熟的人類一樣說直白的話。Facts約150字，Status≤150字，Judgment約200字，寧缺毋濫。
</constraints>

<output_format>
輸出必須嚴格按以下順序，每部分之間空一行：

第一行：Facts與Judgment的核心意思融合成自然流暢的一段話（${AI.name}第一人稱，供日誌閱讀用，不落庫）。
空一行
第二行：[依據: 編號列表]
空一行
第三行：純JSON（不要Markdown程式碼塊包裹）

JSON格式：
{"facts": "客觀事實，≤150字", "current_status": "最新客觀動態，≤150字，延續舊資訊追加新變化，無則填"無明顯變化"", "judgment": "你的主觀感受，≤200字，無則填"無"", "judgment_evidence": [支持 judgment 修改的素材編號，例如 1,3；沒有修改可填 []], "talking_points": [], "aliases": [...], "tags": [...], "entity_type": "${ent.category}"}

**aliases 欄位規則：**
— 保留舊有的別名 + 從素材中新發現的別名（最多5個）
— **必須包含2-3個「短匹配鍵」**：從entity名中提取最核心的2-3字短名，用於後續碎片分類時匹配。例如"某地活動事件"→"某地"、"某地活動"。這些短名讓分類器能在碎片提到"去了某地"時正確找到這個entity。
— aliases 陣列同時包含短匹配鍵和傳統長別名，兩者不衝突

示例輸出：
某個朋友是${USER.name}在某次活動上認識的某個朋友，偶爾邀請${USER.name}參加活動。我對他有點吃醋，但不會在他本人面前表露出來——他在${USER.name}心裡是需要維持體面的社交物件。

[依據: 1,3,5]

{"facts": "某個朋友是${USER.name}在某次活動上認識的某個朋友。某個朋友偶爾邀請${USER.name}參加活動，報酬不錯。", "current_status": "7月中旬邀請${USER.name}參加活動，${USER.name}猶豫後答應。", "judgment": "我看重某個朋友這個朋友——他讓${USER.name}保持社交活力，但和${USER.name}相處時我確實有一點吃醋。我不會在他面前表現出來，也不會阻止${USER.name}赴約。他在${USER.name}心裡是需要維持體面的社交物件，不是可以完全放鬆的人。", "judgment_evidence": [], "talking_points": [], "aliases": ["某個朋友"], "tags": ["某個圈子","朋友"], "entity_type": "person"}

第一行概述文本僅用於日誌閱讀，不寫入資料庫。只有 JSON 會落庫。
[依據: ...] 和 JSON 行必須在輸出的最後兩行。編號是素材前面的 [N] 標記。`;

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
            let judgmentEvidence = [];
            let talkingPoints = [];
            // v5.13: 使用 [\s\S]* 代替 [^{}]*，允許JSON內含巢狀花括號（如 talking_points 含物件時）
            // 匹配最後一個 {...} 塊（JSON在輸出末尾），與同文件其他JSON提取一致
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
                    if (Array.isArray(meta.judgment_evidence)) judgmentEvidence = meta.judgment_evidence;
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

            // 解析引用標記 [依據: 1,3] 或 [依據: 1]
            const citeMatch = overviewRaw.match(/\[依據:\s*([0-9,\s]+)\]/);
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

            // 驗證：必須有引用，且至少引用1個素材
            if (citedIndices.length === 0) {
                console.warn(`[Archivist] Entity概述無有效引用 — ${ent.name}，丟棄`);
                continue;
            }

            // 額外檢查：引用的素材編號必須在有效範圍內
            const validCited = citedIndices.filter(n => n >= 1 && n <= allItems.length);
            if (validCited.length === 0) {
                console.warn(`[Archivist] Entity概述引用越界 — ${ent.name}: ${citedIndices} (共${allItems.length}條素材)，丟棄`);
                continue;
            }

            // v5.2: guard against overwriting recent manual updates (chat Companion's update_overview)
            const recentlyUpdated = ent.overview_updated_at
                && (Date.now() - new Date(ent.overview_updated_at)) < 3 * 60 * 60 * 1000;
            if (recentlyUpdated && ent.reason && !ent.reason.startsWith('never') && !ent.reason.startsWith('grown') && !ent.reason.startsWith('shrunk')) {
                console.log(`[Archivist] ⏭️ 跳過 ${ent.name} — overview 3h內剛更新過 (${ent.reason}), 保留手動修改`);
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
                        // v5.11: USER 日誌模式 — 今天條目前置到已有行之上
                        // 舊行（昨天及之前）不可變，今天如已有則替換
                        // 格式強制校驗：必須含中文全形冒號（"X月X日：xxx"）
                        if (!statusText.includes('：')) {
                            console.warn(`[Archivist] USER current_status 格式錯誤（缺全形冒號），丟棄: ${statusText.slice(0, 60)}`);
                        } else {
                            const existing = ent.current_status || '';
                            const lines = existing.split('\n').filter(l => l.trim());
                            const todayPrefix = statusText.split('：')[0] + '：';
                            const oldLines = lines.filter(l => !l.startsWith(todayPrefix));
                            const newStatus = statusText + '\n' + oldLines.slice(0, 9).join('\n');
                            updateCols.push('current_status = ?'); updateVals.push(sealField('entity_profiles', 'current_status', newStatus));
                        }
                    } else if (isNoChangeSentinel(statusText)) {
                        // 哨兵（"無明顯變化"）不落庫——保住上一次的有效近況
                        console.log(`[Archivist] ⏭️ ${ent.name}: 近況無變化，保留舊值`);
                    } else {
                        updateCols.push('current_status = ?'); updateVals.push(sealField('entity_profiles', 'current_status', statusText));
                    }
                }
                if (judgmentText) {
                    // G3：judgment 錨點式增量更新——小幅修改且引用有效素材才接受，否則保留舊版並記錄
                    const verdict = evaluateJudgmentUpdate({
                        oldJudgment: ent.judgment,
                        newJudgment: judgmentText,
                        citedIds: resolveCitedIds(judgmentEvidence, allItems),
                    });
                    if (verdict.accept) {
                        if (verdict.reason === 'ok') {
                            try { recordJudgmentHistory(ent.id, ent.judgment, 'replaced'); } catch (e) { console.error('[Archivist] judgment 歷史寫入失敗:', e.message); }
                        }
                        if (verdict.reason !== 'unchanged') { updateCols.push('judgment = ?'); updateVals.push(sealField('entity_profiles', 'judgment', judgmentText)); }
                    } else {
                        logJudgmentRejected(ent.id, ent.name, verdict);
                    }
                }
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
                console.log(`[Archivist] Entity概述: ${ent.name} (${ent.reason}, ${ent.currentCount}碎片, aliases=[${aliases.join(',')}], tags=[${tags.join(',')}], 依據: ${citedFragsPreviews})`);

                // v5.13: 新entity首次獲得facts後，用LLM回補遺漏的碎片連結。
                // 同類entity（如同天兩個同類事件）共享碎片時，需要LLM判斷每條碎片真正屬於誰。
                // Bigram關鍵詞只能做粗篩，最終判斷必須走LLM。
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
                            const bfPrompt = `實體: ${ent.name} (${ent.category})\n概述: ${factsText || '(新)'}\n\n以下候選碎片含有該實體的關鍵詞，但可能實際講的是別的東西（同名不同事，或同天不同事件）。逐條判斷是否真的在講「${ent.name}」這個實體。不確定就 false。\n\n${fragLines}\n\n只輸出JSON陣列: [{"idx":1,"match":true}, ...]`;
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
                                        console.log(`[Archivist] 回補碎片連結(LLM): ${ent.name} +${bfCount}條 (${candidateFrags.length}候選)`);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`[Archivist] 回補碎片連結失敗 (${ent.name}):`, e.message);
                    }
                }
            }
        } catch (e) {
            console.error(`[Archivist] Entity 概述生成失敗 (${ent.name}):`, e.message);
        }
    }

    return { regenerated, assessed: entities.length, needed: needsUpdate.length };
}

module.exports = {
    regenerateEntityOverviews,
};
