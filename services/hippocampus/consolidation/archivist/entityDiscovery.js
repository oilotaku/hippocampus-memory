// =================================================================
// services/archivist/entityDiscovery.js — 新實體內容掃描與人物關係推斷（entity_profiles）
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { callLLM } = require('../../../llm');
const { WORLD_CONTEXT } = require('../../../worldContext');
const { SKIP_NAMES } = require('../../../memoryConfig');
const { ARCHIVIST_LLM_CONFIG_ID, ENTITY_DISCOVERY_MIN_FRAGS } = require('./constants');


// ═══════════════════════════════════════════════════════
// Helper: scanContentForNewEntities
//
// Scans fragment content text for potential person names
// that aren't already in entity_profiles. This catches
// entities that Scribe didn't extract into mf.entity but
// that appear in the content body (e.g. 某暱稱 mentioned in
// a fragment where entity='User').
// ═══════════════════════════════════════════════════════

const CONTENT_ENTITY_MIN_OCCURRENCES = 3;

const CONTENT_ENTITY_MAX_CHECK = 15;

const CONTENT_SCAN_FRAG_LIMIT = 500;


const COMMON_WORD_STOPLIST = new Set([
    '自己','我們','他們','你們','她們','它們','什麼','怎麼','為什麼',
    '不知道','沒有','可以','不可以','一個','這個','那個','哪個','這些','那些',
    '就是','因為','所以','雖然','但是','如果','已經','還是','或者','不過',
    '而且','然後','現在','以前','以後','可能','應該','覺得','知道','看見',
    '聽到','以為','開始','繼續','終於','最後','之後','之前','這樣','那樣',
    '一點','一些','這種','那種','另外','所有','大概','當然','突然','一起',
    '一個人','每個人','沒辦法','無所謂','有時候','越來越','是不是','能不能',
    '會不會','第一次','大部分','大家好','還可以','差不多','最重要','所有人',
    '很多人','每一天','今天','明天','昨天','今年','去年','上午','下午','晚上',
    '早上','中午','週末','有人','沒人','別人','某人','任何人','對方','雙方',
    '本人','當事人','告訴你','對不起','親愛的','請問你','你好嗎',
    // Common false positives from fragment content (book/music context)
    '在讀','的回應','喜歡了','專輯','的批註','的聊天','在微信','發了一',
    '他對','她說','我對','我說','你說','他說','她說','你說',
    '回覆了','收到了','看到了','聽到了','想到了','感覺到',
    '這首歌','那首歌','這首歌','那本書','這本書','這篇文章',
    '很喜歡','不喜歡','非常好','還不錯','差不多','有意思',
    '沒什麼','有什麼','沒什麼','是什麼','為什麼','怎麼辦',
    '對不起','謝謝你','沒關係','不好意思','不客氣',
    '我覺得','我認為','我發現','我意識到','我注意到',
    '這件事','那件事','這種事','那種事','什麼時候',
    '在哪裡','在哪裡','怎麼辦','怎麼樣','為什麼',
    // Book/reading context noise
    '寫過一','寫了一','翻譯了',
    '閱讀了','讀了一','這本書','那本書','那一本',
    '一本關於','一部關於','一個關於','是關於',
    '第一章','第二章','第三章','第四章','第五章',
    'http','https','www','com','html', '我们', '他们', '你们', '她们', '它们', '什么', '怎么', '为什么', '没有', '一个', '这个', '那个', '哪个', '这些', '因为', '虽然', '已经', '还是', '不过', '然后', '现在', '以后', '应该', '觉得', '看见', '听到', '以为', '开始', '继续', '终于', '最后', '之后', '这样', '那样', '一点', '这种', '那种', '当然', '一个人', '每个人', '没办法', '无所谓', '有时候', '越来越', '会不会', '还可以', '周末', '没人', '别人', '对方', '双方', '当事人', '告诉你', '对不起', '亲爱的', '请问你', '你好吗', '在读', '的回应', '喜欢了', '专辑', '的批注', '发了一', '他对', '她说', '我对', '我说', '你说', '他说', '回复了', '听到了', '感觉到', '这首歌', '那本书', '这本书', '这篇文章', '很喜欢', '不喜欢', '还不错', '没什么', '有什么', '是什么', '怎么办', '谢谢你', '没关系', '不客气', '我觉得', '我认为', '我发现', '我意识到', '这件事', '这种事', '那种事', '什么时候', '在哪里', '怎么样', '写过一', '写了一', '翻译了', '阅读了', '读了一', '一本关于', '一部关于', '一个关于', '是关于',
    // Japanese stopwords (generic particles/words)
    'なん','です','ます','した','いる','こと','それ',
    'この','あの','どの','こう','そう','いう','なる',
]);


// English capitalized common words — high noise for Latin name extraction
const EN_STOPLIST = new Set([
    'The','This','That','These','Those','There','Their','They',
    'With','From','When','Where','Which','While','What','Who',
    'Have','Has','Had','Been','Were','Would','Could','Should',
    'About','After','Again','Also','And','Are','But','Can',
    'Did','Does','Done','Each','Even','Every','For','Get',
    'Here','How','Into','Just','Like','Make','Many','More',
    'Much','Must','Not','Now','Only','Other','Over','Part',
    'Same','Said','Some','Such','Take','Than','Then','Very',
    'Was','Way','Well','Were','Will','Your','You',
    'Chapter','Page','Part','Book','Note','Line','Read',
    'She','Her','Him','His','Its',
    // Book/music context Latin noise
    'Love','Soundtrack','Original','Remix','Original','Sound',
    'Mix','Version','Night','Song','Album','Music','Dance',
    'Never','More','Your','Signs','Pursuing','True','Self',
    'Persona','Room','One','Own','Women','Fiction','Life',
    'Time','World','Man','Men','Day','End','New','Old',
    'First','Last','Long','Little','Great','Good','Bad',
    'Right','Left','High','Low','Big','Small','Back',
    'Still','Always','Never','Ever','Something','Nothing',
    'Everything','Anything','Things','Thing','People',
]);


async function scanContentForNewEntities() {
    const db = getDb();

    const knownNames = new Set(SKIP_NAMES);
    const profiles = db.prepare("SELECT name, aliases FROM entity_profiles").all();
    for (const p of profiles) {
        knownNames.add(p.name);
        if (p.aliases) {
            try {
                const aliases = JSON.parse(p.aliases);
                for (const a of aliases) knownNames.add(a);
            } catch (_) {}
        }
    }

    const fragments = db.prepare(`
        SELECT id, content FROM memory_fragments
        WHERE status = 'active' AND content != ''
        ORDER BY id DESC LIMIT ?
    `).all(CONTENT_SCAN_FRAG_LIMIT);

    // Separate candidate pools: CJK/kana (low noise) vs Latin (high noise)
    const CJK_KANA_RE = /[一-鿿]{2,6}|[぀-ゟ]{2,6}|[゠-ヿ]{2,6}/g;
    const LATIN_RE = /[A-Z][a-z]{2,20}/g;
    const cjkCounts = new Map();
    const latinCounts = new Map();

    for (const f of fragments) {
        const text = f.content;

        let m;
        while ((m = CJK_KANA_RE.exec(text)) !== null) {
            if (knownNames.has(m[0])) continue;
            if (COMMON_WORD_STOPLIST.has(m[0])) continue;
            const ex = cjkCounts.get(m[0]);
            if (ex) { ex.count++; }
            else { cjkCounts.set(m[0], { count: 1 }); }
        }

        while ((m = LATIN_RE.exec(text)) !== null) {
            if (knownNames.has(m[0])) continue;
            if (EN_STOPLIST.has(m[0])) continue;
            const ex = latinCounts.get(m[0]);
            if (ex) { ex.count++; }
            else { latinCounts.set(m[0], { count: 1 }); }
        }
    }

    // CJK/kana: min 3 occurrences
    const cjkSorted = [...cjkCounts.entries()]
        .filter(([_, v]) => v.count >= CONTENT_ENTITY_MIN_OCCURRENCES)
        .sort((a, b) => b[1].count - a[1].count);

    // Latin: min 5 occurrences (higher bar due to noise), fill remaining slots
    const latinSorted = [...latinCounts.entries()]
        .filter(([_, v]) => v.count >= 5)
        .sort((a, b) => b[1].count - a[1].count);

    // Prioritize CJK/kana, then top up with Latin
    const cjkSlots = Math.min(cjkSorted.length, CONTENT_ENTITY_MAX_CHECK);
    const latinSlots = Math.min(latinSorted.length, CONTENT_ENTITY_MAX_CHECK - cjkSlots);
    const sorted = [
        ...cjkSorted.slice(0, cjkSlots),
        ...latinSorted.slice(0, latinSlots)
    ];

    if (sorted.length === 0) return [];

    const candidatesForLLM = [];
    for (const [name, info] of sorted) {
        const contextFrags = db.prepare(`
            SELECT content FROM memory_fragments
            WHERE status = 'active' AND mem_like('memory_fragments:content', content, ?)
            ORDER BY id DESC LIMIT 5
        `).all(`%${name}%`);

        candidatesForLLM.push({
            name,
            count: info.count,
            contexts: contextFrags.map(f => f.content.substring(0, 200))
        });
    }

    const contextText = candidatesForLLM.map((c, i) =>
        `[${i + 1}] "${c.name}" (出現 ${c.count} 次)\n${c.contexts.map(ctx => `   - ...${ctx}...`).join('\n')}`
    ).join('\n\n');

    const prompt = `你是實體識別器。以下是User記憶碎片中出現頻率較高的未知詞彙。請判斷每個屬於什麼實體型別。

${contextText}

只輸出JSON陣列，每個元素：
{"name":"候選詞","category":"person|pet|place|event|project|work|term|organization|none","likely_gender":"male/female/unknown"}

判斷標準：
- **person**: 真實人物——中文名、英文名、日文名、網名、藝名、圈名、遊戲ID
- **place**: 具體地點——城市、景點、場館、店鋪名（不是「家裡」「公司」等泛稱）
- **event**: 可命名的事件或經歷——旅行、聚會、專案節點（不是單次對話）
- **project**: User參與創作或開發的作品/專案——程式碼專案、同人、cos、影片系列
- **term**: 抽象概念/專有名詞——但不屬於以上任何一類（如「某作品」「某概念」等）
- **none**: 普通詞彙、公司名、品牌名、文學虛構角色、不確定的
- 只輸出JSON陣列，不要markdown包裹`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.1, maxOutputTokens: 500 },
            ARCHIVIST_LLM_CONFIG_ID
        );

        let text = (response?.reply || '').replace(/```json|```/g, '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
            console.log('[Archivist] 內容實體掃描: LLM返回非JSON陣列，跳過');
            return [];
        }

        const results = JSON.parse(match[0]);
        const allCounts = new Map([...cjkCounts, ...latinCounts]);
        const newEntities = results
            .filter(r => r.category && r.category !== 'none')
            .map(r => ({
                name: r.name,
                fragCount: allCounts.get(r.name)?.count || CONTENT_ENTITY_MIN_OCCURRENCES,
                isNew: true,
                isReEval: false,
                entityProfileId: null,
                discoveryMethod: 'content_scan',
                category: r.category || 'person'
            }));

        if (newEntities.length > 0) {
            console.log(`[Archivist] 內容實體掃描: 發現 ${newEntities.length} 個候選 — ${newEntities.map(e => e.name + '(' + e.fragCount + ')').join(', ')}`);
        }

        return newEntities;
    } catch (e) {
        console.error('[Archivist] 內容實體掃描失敗:', e.message);
        return [];
    }
}


// ═══════════════════════════════════════════════════════
// Tool: discoverEntityRelationships
// ═══════════════════════════════════════════════════════

async function discoverEntityRelationships(options = {}) {
    const db = getDb();
    const includeReEval = options.includeReEval || false;

    // SKIP_NAMES from memoryConfig — already imported at module top

    // Candidates with missing relationships — only if new fragments since last eval
    const missingRelations = db.prepare(`
        SELECT ep.id, ep.name, COUNT(mf.id) as frag_count,
               ep.last_hypothesis, ep.last_eval_frag_count
        FROM entity_profiles ep
        JOIN memory_fragments mf ON mf.entity_id = ep.id
        WHERE ep.category = 'person'
          AND (ep.relationship_to_user IS NULL OR ep.relationship_to_user = '')
          AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
          AND mf.status = 'active'
        GROUP BY ep.id
        HAVING frag_count >= ?
           AND (ep.last_eval_frag_count IS NULL
                OR ep.last_eval_frag_count = 0
                OR frag_count >= ep.last_eval_frag_count + 3)
        ORDER BY frag_count DESC
    `).all(...SKIP_NAMES, ENTITY_DISCOVERY_MIN_FRAGS);

    // Candidates without entity_profiles
    const unknownEntities = db.prepare(`
        SELECT mf.entity, COUNT(*) as cnt
        FROM memory_fragments mf
        WHERE mf.entity != ''
          AND mf.entity NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
          AND mf.entity NOT IN (SELECT name FROM entity_profiles)
          AND mf.entity NOT IN (SELECT COALESCE(value, '') FROM entity_profiles, json_each(aliases))
          AND mf.status = 'active'
        GROUP BY mf.entity
        HAVING cnt >= ?
        ORDER BY cnt DESC
    `).all(...SKIP_NAMES, ENTITY_DISCOVERY_MIN_FRAGS);

    const candidates = [];

    for (const mr of missingRelations) {
        candidates.push({ entityProfileId: mr.id, name: mr.name, fragCount: mr.frag_count,
            isNew: false, isReEval: false,
            lastHypothesis: mr.last_hypothesis, lastEvalFragCount: mr.last_eval_frag_count || 0 });
    }

    for (const ue of unknownEntities) {
        candidates.push({ entityProfileId: null, name: ue.entity, fragCount: ue.cnt, isNew: true, isReEval: false });
    }

    // Content-scanned entities (discovered from fragment content, not mf.entity column)
    const contentEntities = await scanContentForNewEntities();
    for (const ce of contentEntities) {
        if (!candidates.find(c => c.name === ce.name)) {
            candidates.push(ce);
        }
    }

    // Re-evaluation candidates
    if (includeReEval) {
        const lowConfCandidates = db.prepare(`
            SELECT ep.id, ep.name, COUNT(mf.id) as frag_count
            FROM entity_profiles ep
            JOIN memory_fragments mf ON mf.entity_id = ep.id
            WHERE ep.category = 'person'
              AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
              AND ep.relationship_confidence IN ('low', 'medium')
              AND (ep.last_evaluated_at IS NULL OR ep.last_evaluated_at < datetime('now', '-1 day'))
              AND mf.status = 'active'
              AND mf.created_at > COALESCE(ep.last_evaluated_at, '1970-01-01')
            GROUP BY ep.id
            HAVING COUNT(mf.id) >= 3
            ORDER BY frag_count DESC
        `).all(...SKIP_NAMES);

        const staleCandidates = db.prepare(`
            SELECT ep.id, ep.name, COUNT(mf.id) as frag_count
            FROM entity_profiles ep
            JOIN memory_fragments mf ON mf.entity_id = ep.id
            WHERE ep.category = 'person'
              AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
              AND ep.relationship_confidence = 'high'
              AND ep.last_evaluated_at < datetime('now', '-30 days')
              AND mf.status = 'active'
              AND mf.created_at > ep.last_evaluated_at
            GROUP BY ep.id
            HAVING COUNT(mf.id) >= 5
            ORDER BY frag_count DESC
        `).all(...SKIP_NAMES);

        for (const lc of lowConfCandidates) {
            if (!candidates.find(c => c.entityProfileId === lc.id)) {
                candidates.push({ entityProfileId: lc.id, name: lc.name, fragCount: lc.frag_count, isNew: false, isReEval: true });
            }
        }
        for (const sc of staleCandidates) {
            if (!candidates.find(c => c.entityProfileId === sc.id)) {
                candidates.push({ entityProfileId: sc.id, name: sc.name, fragCount: sc.frag_count, isNew: false, isReEval: true });
            }
        }

        if (lowConfCandidates.length > 0 || staleCandidates.length > 0) {
            console.log(`[Archivist] 重評估候選: ${lowConfCandidates.length} 低置信度 + ${staleCandidates.length} 過期`);
        }
    }

    if (candidates.length === 0) {
        return { discovered: 0 };
    }

    console.log(`[Archivist] 實體關係發現: ${candidates.length} 個候選人 (${candidates.map(c => c.name + '(' + c.fragCount + ')' + (c.isReEval ? '[R]' : '')).join(', ')})`);

    let discovered = 0;

    for (const cand of candidates) {
        try {
            let fragments;
            if (cand.discoveryMethod === 'content_scan') {
                fragments = db.prepare(`
                    SELECT id, content, source_date FROM memory_fragments
                    WHERE status = 'active' AND mem_like('memory_fragments:content', content, ?)
                    ORDER BY source_date
                `).all(`%${cand.name}%`);
            } else if (cand.isNew) {
                fragments = db.prepare(`
                    SELECT id, content, source_date FROM memory_fragments
                    WHERE entity = ? AND status = 'active' ORDER BY source_date
                `).all(cand.name);
            } else {
                fragments = db.prepare(`
                    SELECT mf.id, mf.content, mf.source_date FROM memory_fragments mf
                    WHERE mf.entity_id = ? AND mf.status = 'active' ORDER BY mf.source_date
                `).all(cand.entityProfileId);
            }

            if (fragments.length < ENTITY_DISCOVERY_MIN_FRAGS) continue;

            const uniqueContents = [...new Set(fragments.map(f => (f.content || '').trim()))];
            const fragmentTexts = uniqueContents.slice(0, 30)
                .map((c, i) => `[${i + 1}] ${c}`)
                .join('\n\n');

            const firstDate = fragments[0]?.source_date || '';
            const lastDate = fragments[fragments.length - 1]?.source_date || '';

            // Cognitive context from evolution layer
            const { buildCognitiveContext } = require('../../../cognitiveEvolution');
            const cogCtx = buildCognitiveContext(cand.entityProfileId || 0, cand.name, null);
            if (cogCtx.correctionCount > 0 || cogCtx.ruleCount > 0) {
                console.log(`[Archivist] 認知上下文: ${cogCtx.correctionCount} 條糾錯 + ${cogCtx.ruleCount} 條規則`);
            }

            // Progressive re-eval context
            let priorContext = '';
            if (cand.lastHypothesis) {
                const newFragCount = fragments.length - (cand.lastEvalFragCount || 0);
                priorContext = `\n## 上次評估的推斷\n上次評估時（${cand.lastEvalFragCount} 條碎片），系統推斷「${cand.name}」可能是 **${cand.lastHypothesis}**，但置信度不足以確定。\n此後新增了 ${Math.max(0, newFragCount)} 條碎片。請結合新舊證據重新判斷。\n`;
            }

            const prompt = `${WORLD_CONTEXT}

你是人物關係檔案員。閱讀以下與「${cand.name}」有關的所有記憶碎片，判斷這個人和User是什麼關係。${priorContext}
注意：Scribe提取的碎片是第三人稱轉述。原始對話中的"我媽""媽媽說"可能被轉寫為"${cand.name}為User做了..."。你需要從碎片描述的**互動模式**來推斷關係性質。

## 關係判斷的線索（按優先順序從高到低）：
1. **互動頻率和內容** — 天天做飯帶飯 → 同居親人/伴侶/室友。偶爾見面評價作品 → 朋友/同行/前輩。涉及金錢/法律糾紛 → 前任/商業夥伴。
2. **情感色彩** — 關愛照顧 → 長輩/親人。好感/約會 → 戀愛物件。吐槽/矛盾 → 朋友/前任。
3. **語言線索** — "分手""前任""在一起""結束與X的關係""BE"→前任戀人或已結束的親密關係。"官宣"→公開的戀愛關係。
4. **排除法** — 如果互動完全圍繞日常生活起居（做飯、帶飯、同住）→ 家人（而非戀人）。如果互動完全圍繞創作評價、藝術討論 → 很可能是創作者同行或前輩（而非家人）。

${cogCtx.rulesSection}
${cogCtx.correctionsSection}
## 碎片原文（共 ${fragments.length} 條，時間跨度 ${firstDate} ~ ${lastDate}）

${fragmentTexts}

## 任務

輸出一個JSON物件，不要markdown包裹：

{"name":"${cand.name}","relationship":"對User而言這個人是誰","relationship_nature":"close/conflicted/complex/distant/dependent","emotional_significance":"這個人在User生活中的情感意義","time_context":"時間背景和最近聯絡狀態","confidence":"high/medium/low","entity_type":"real_person/public_figure/fictional_character/unknown","suggested_category_path":"推薦的知識樹路徑"}

欄位說明：
- entity_type: 這個人的型別
  * "real_person" — User生活中真實認識、有互動的人（朋友/家人/同事/前任等）
  * "public_figure" — 真實存在但User不認識的名人（歌手/演員/作家/網紅等）
  * "fictional_character" — 書/遊戲/影視裡的虛構角色
  * "unknown" — 資訊不足以判斷
- suggested_category_path: 推薦一個分類標籤路徑（扁平標籤，如 "重要的人/某個朋友"、"音樂/某歌手"、"虛構角色/某作品角色"）。路徑僅作為分類建議，不再建立層級節點。

如果碎片資訊不足以確定關係（比如只知道這個人出現過但互動模式不明顯），confidence設low，relationship寫"不確定"。不要強行判斷。`;

            const response = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.3, maxOutputTokens: 500 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            let text = (response?.reply || '').replace(/```json|```/g, '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                console.error(`[Archivist] 關係發現 ${cand.name}: LLM返回非JSON`);
                continue;
            }

            const rel = JSON.parse(match[0]);
            const relText = rel.relationship || '';
            const relNature = rel.relationship_nature || '';
            const relEmo = rel.emotional_significance || '';
            const relTime = rel.time_context || '';
            const relConf = rel.confidence || 'medium';
            const entityType = rel.entity_type || 'unknown';

            const existingRel = db.prepare(
                'SELECT relationship_to_user, relationship_confidence FROM entity_profiles WHERE id = ?'
            ).get(cand.entityProfileId);

            // Oscillation guard
            if (existingRel && existingRel.relationship_to_user && existingRel.relationship_to_user !== '') {
                const changeCount = db.prepare(
                    'SELECT COUNT(*) as c FROM cognitive_corrections WHERE entity_id = ?'
                ).get(cand.entityProfileId);
                if (changeCount.c >= 3 && existingRel.relationship_to_user !== relText) {
                    console.warn(`[Archivist] ⚠️ 關係振盪: ${cand.name} 已被修改 ${changeCount.c} 次，跳過本次變更`);
                    console.warn(`  當前: ${existingRel.relationship_to_user} → 擬變更: ${relText}`);
                    db.prepare("UPDATE entity_profiles SET last_evaluated_at = datetime('now') WHERE id = ?")
                        .run(cand.entityProfileId);
                    // Set entity_id on fragments (no knowledge tree nodes)
                    if (cand.entityProfileId) {
                        for (const frag of fragments) {
                            db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                                .run(cand.entityProfileId, frag.id);
                        }
                    }
                    continue;
                }
            }

            // Low confidence: save hypothesis for progressive re-eval, don't commit relationship yet
            if (relConf === 'low' || relText === '不確定' || relText === '不确定' || relText === '') {
                console.log(`[Archivist] 關係發現 ${cand.name}: 資訊不足 (confidence=${relConf})，儲存假設待重評估`);
                if (cand.isNew) {
                    const info = db.prepare(`
                        INSERT INTO entity_profiles (name, category, entity_type, first_mentioned_date, last_mentioned_date)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(cand.name, cand.category || 'person', entityType, firstDate, lastDate);
                    cand.entityProfileId = info.lastInsertRowid;
                    db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE entity = ? AND entity_id IS NULL')
                        .run(cand.entityProfileId, cand.name);
                }
                if (cand.entityProfileId) {
                    // Save the hypothesis even though we're not confident — enables progressive re-eval
                    const hypothesis = relText !== '不確定' && relText !== '不确定' && relText !== '' ? relText : null;
                    db.prepare(`UPDATE entity_profiles
                        SET last_hypothesis = ?,
                            last_eval_frag_count = ?,
                            last_evaluated_at = datetime('now')
                        WHERE id = ?`)
                        .run(hypothesis, fragments.length, cand.entityProfileId);
                }
                // Set entity_id on fragments (no knowledge tree nodes)
                if (cand.entityProfileId) {
                    for (const frag of fragments) {
                        db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                            .run(cand.entityProfileId, frag.id);
                    }
                }
                continue;
            }

            // Correction detection
            if (existingRel && existingRel.relationship_to_user && existingRel.relationship_to_user !== '' &&
                existingRel.relationship_to_user !== relText && relConf === 'high') {

                const { logCorrection, analyzeMispattern } = require('../../../cognitiveEvolution');
                const oldLabel = existingRel.relationship_to_user;
                const mispattern = await analyzeMispattern(cand.name, oldLabel, relText, fragments);
                const evidence = fragments.slice(0, 3)
                    .map(f => (f.content || '').substring(0, 120))
                    .join(' | ');

                await logCorrection(
                    cand.entityProfileId, cand.name,
                    oldLabel, relText,
                    mispattern, evidence,
                    fragments.length
                );
                console.log(`[Archivist] 糾錯: ${cand.name} — "${oldLabel}" → "${relText}" (mispattern: ${mispattern})`);
            }

            if (cand.isNew) {
                const info = db.prepare(`
                    INSERT INTO entity_profiles (name, category, entity_type, relationship_to_user, relationship_nature, emotional_significance, relationship_confidence, last_eval_frag_count, last_evaluated_at, first_mentioned_date, last_mentioned_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
                `).run(cand.name, cand.category || 'person', entityType, relText, relNature, relEmo, relConf, fragments.length, firstDate, lastDate);
                cand.entityProfileId = info.lastInsertRowid;
                db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE entity = ? AND entity_id IS NULL')
                    .run(cand.entityProfileId, cand.name);
                console.log(`[Archivist] 建立 entity_profile: ${cand.name} (id=${cand.entityProfileId}) — ${relText} [confidence=${relConf}]`);
            } else {
                db.prepare(`
                    UPDATE entity_profiles
                    SET relationship_to_user = ?, relationship_nature = ?, emotional_significance = ?,
                        relationship_confidence = ?, last_hypothesis = NULL,
                        entity_type = COALESCE(entity_type, ?),
                        last_eval_frag_count = ?, last_evaluated_at = datetime('now'),
                        first_mentioned_date = COALESCE(first_mentioned_date, ?), last_mentioned_date = ?, updated_at = datetime('now')
                    WHERE id = ?
                `).run(relText, relNature, relEmo, relConf, entityType, fragments.length, firstDate, lastDate, cand.entityProfileId);
                console.log(`[Archivist] 更新 entity_profile: ${cand.name} — ${relText} [confidence=${relConf}]`);
            }

            // Set entity_id on fragments (no knowledge tree nodes)
            if (cand.entityProfileId) {
                for (const frag of fragments) {
                    db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                        .run(cand.entityProfileId, frag.id);
                }
            }
            discovered++;
        } catch (e) {
            console.error(`[Archivist] 關係發現 ${cand.name} 失敗:`, e.message);
        }
    }

    return { discovered };
}

module.exports = {
    CONTENT_ENTITY_MIN_OCCURRENCES,
    CONTENT_ENTITY_MAX_CHECK,
    CONTENT_SCAN_FRAG_LIMIT,
    COMMON_WORD_STOPLIST,
    EN_STOPLIST,
    scanContentForNewEntities,
    discoverEntityRelationships,
};
