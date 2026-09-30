// =================================================================
// services/archivist/emergent.js — 湧現地點／事件偵測與判據
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { callLLM } = require('../../../llm');
const { WORLD_CONTEXT } = require('../../../worldContext');
const { USER } = require('../../../memoryConfig');
const { ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { agentState, _canCallLLM } = require('./runtime');
const { _nameBigrams, isTimePhraseName, isPeriodPhraseName } = require('./guards');


// ═══════════════════════════════════════════════════════
// v4.8: detectEmergentPlacesAndEvents — 湧現地點/事件檢測
//
// 分類批次只能看到15條碎片，很容易漏掉地點和事件實體——
// 50+條同一地點的碎片分散在幾十批裡，每批看到1-2條不夠播種。
//
// 本函式做第二遍掃描：取只連結到person/pet實體（沒連結到
// 任何place/event）的碎片，用ChromaDB向量聚類，聚成團的
// 送LLM問「這是不是同一個地點/事件？該建星座嗎？」
//
// 僅深迴圈呼叫（ChromaDB依賴）。每輪≤3個候選團。
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 湧現判據（2026-09-28 重寫）
//
// 舊判據是「這些碎片是否指向一個**獨立的具體地點或事件**（與已有實體都不同）」。
// 它有個致命的結構問題：**"與已有實體都不同"這句話是在教模型找理由分裂**——
// 只要它能說出"我和那個不一樣"，就算過關。於是它學會了給一段**反覆出現的行為**
// 起個「XX季」的名字——換個名字，那就不再是"行為模式"，而是"一段事件"了。
//
// 新判據把門檻下在**專有名詞**上：判據要硬（有沒有出現一個具體的人名/店名/地名/
// 機構名/作品名，或者是不是某一天真的出了某件事），不要軟（像不像事件）——
// "像不像"正是模型最擅長繞的東西。配套還有兩道確定性守衛：
// `isTimePhraseName`（全是日期時間字）與 `isPeriodPhraseName`（以期間詞收尾）。
//
// ⚠️ 改這個 prompt 之後**必須雙向迴歸**：既要確認它拒掉該拒的，也要確認它
//    **沒把該建的也拒掉**（過度收緊 = 湧現功能停擺，比原來更糟）。
// ═══════════════════════════════════════════════════════
function buildEmergentJudgePrompt(sampleText, memberCount, existingBlock) {
    return `下面是一組來自聊天記錄的碎片，它們在語義上高度相似，可能指向同一個地點或事件，但尚未被識別為獨立的記憶星座。

碎片樣本（${memberCount}條中的若干條）：
${sampleText.slice(0, 2500)}

記憶庫已有實體（新建前先對照這個列表）：
${existingBlock}

判斷標準（**按順序過，前一條不過就不要再往後想**）：

1. ⚠️ **先找那樣東西——這是硬門檻。** 滿足下面**任一條**才繼續；兩條都不滿足 → is_entity=false，到此為止：

   **a. 一個新的專有名詞**——具體的人名 / 店名 / 地名 / 機構名 / 作品名。

   **b. 某一天真的出了某件事**——崩潰、大吵一架、出事、第一次做某事、某個決定。
   ⚠️ 判 b 的鐵律：**它是「那一天發生的」，不是「那段時間在做的」。**
   拿一句話自檢：這件事能用**一個具體日期**說完嗎？
   · 「X月X日${USER.pronoun || 'TA'}崩潰了」✓ 是事件
   · 「X月${USER.pronoun || 'TA'}在讀某本書」「X月${USER.pronoun || 'TA'}一直在買東西」✗ 是持續行為，不是事件
   · 有的碎片裡確實出現了某天的日期，但整簇講的是**跨了幾週幾個月的同一類事** → 判 false。
     出現日期不等於發生在一天。

   下面這些**兩條都不滿足**，一律判 false：
   · 行為：怎麼做的描述（什麼時候去哪、幹了什麼、買了什麼）
   · 持續過程：跨越一段時間的同一件事（在做什麼、一直在做什麼）
   · 習慣/日常：重複發生的程式
   · 狀態/心情：身心狀況與感受
   · 時間段：某段時間、某個週期
   ⚠️ **把它們包裝成「XX季」「XX期」「XX歷程」不會讓它變成事件**——換個名字還是那件事。

2. **它是不是已經被上面某個已有實體佔了？**（走 a 的比對名字/別名；走 b 的看那個事件是不是已經有星座了）佔了 → is_entity=false，歸過去，不要另起爐灶。

3. **它是不是某個已有實體的子話題/細節？** 碎片如果講的只是某個已有實體的一個**環節/細節**（大實體已經存在），那就是子話題 → is_entity=false，不獨立建星座。

4. 都過了才建，註明 place 或 event：
   · 走 a 的：**名字用那個專有名詞本身**（2-8 字，可以是它的直接變體）。
   · 走 b 的：名字**帶上日期和那件事**，讓人一眼看出是哪天出了什麼事；**不要起成「XX期」「XX季」**——那樣又變成行為包裝了。

只輸出JSON:
{"is_entity":true|false,"name":"名稱","category":"place|event","reason":"一句話理由（指認那個專有名詞 / 指認那個一次性事件 / 歸屬已有實體 / 既沒有專有名詞也不是一次性事件）"}`;
}


// 湧現判定的**程式碼側閘門**（LLM 判完之後、建實體之前）。
//
// ⚠️ 抽成函式是為了讓迴歸探針量到的是「**生產最終會怎麼判**」，而不是裸的模型輸出。
//    分開寫的話，探針會把**已經被這幾道鐵證攔掉**的誤判報成"漏判"。
//
// 三道閘各自攔什麼：
//   · 名字是純日期/時間短語（`isTimePhraseName`）
//   · 名字以期間詞收尾（`isPeriodPhraseName`）
//   · **理由自相矛盾**：說了"已被佔用/歸入已有/不另起爐灶"，flag 卻是 true。
//     名字/別名去重攔不住它（同一個東西換個說法，bigram 重疊到不了
//     閾值），所以看理由下判斷——理由裡明說了"有主"，就當 false，別信 flag。
function screenEmergentVerdict(verdict) {
    if (!verdict || !verdict.is_entity) return { accept: false, reason: 'not_entity' };
    const name = String(verdict.name || '').trim();
    if (name.length < 2 || /^\d+$/.test(name)) return { accept: false, reason: 'name_invalid' };
    if (isTimePhraseName(name)) return { accept: false, reason: 'time_phrase_name' };
    if (isPeriodPhraseName(name)) return { accept: false, reason: 'period_phrase_name' };
    if (/已被?.*(佔用|覆蓋|佔據)|歸入已有|歸過去|不另起爐灶|已被?.*(占用|覆盖|占据)|归入已有|归过去|不另起炉灶/.test(String(verdict.reason || ''))) {
        return { accept: false, reason: 'self_contradictory' };
    }
    return { accept: true, name };
}


async function detectEmergentPlacesAndEvents() {
    const db = getDb();
    const { searchMemoriesByVector } = require('../../ca3/memory');

    // 取沒連結到地點/事件的碎片（但已連結到person/pet）
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

    // 用內容長度做粗聚類鍵：前30字提取關鍵詞做L1分組
    // 再挑每組裡最長的一條做種子，向量檢索相似碎片
    const clusters = [];
    const used = new Set();

    for (const f of orphanFrags) {
        if (used.has(f.id)) continue;
        if (!_canCallLLM(1)) break;

        // 用碎片內容做向量檢索，找相似碎片
        let similar;
        try {
            similar = await searchMemoriesByVector(f.content.slice(0, 300), 15);
        } catch (e) {
            console.error(`[Archivist] 湧現檢測向量查詢失敗:`, e.message);
            continue;
        }

        // 過濾：只要未連結place/event的活躍碎片，相似度≥0.55
        const clusterIds = new Set();
        for (const h of (similar || [])) {
            if (h.similarity < 0.55) continue;
            const linked = db.prepare(`
                SELECT COUNT(*) as c FROM fragment_entities fe
                JOIN entity_profiles ep ON fe.entity_id = ep.id
                WHERE fe.fragment_id = ? AND ep.category IN ('place', 'event')
            `).get(h.id);
            if (linked.c > 0) continue; // 已有place/event連結，跳過
            clusterIds.add(h.id);
        }

        if (clusterIds.size < 4) continue; // 團太小，構不成一個實體

        // 標記已處理
        for (const cid of clusterIds) used.add(cid);
        clusters.push({ seed_frag_id: f.id, member_ids: [...clusterIds] });

        // 不設硬上限——_canCallLLM 是天然限流器。早期碎片裡的地點會被最近的行為碎片擋住
    }

    if (clusters.length === 0) return { detected: 0 };

    let detected = 0;
    for (const cluster of clusters) {
        if (!_canCallLLM(1)) break;

        // 取團內碎片內容（最多8條做樣本）
        const placeholders = cluster.member_ids.slice(0, 8).map(() => '?').join(',');
        const samples = db.prepare(`
            SELECT id, content, created_at FROM memory_fragments
            WHERE id IN (${placeholders}) ORDER BY created_at ASC
        `).all(...cluster.member_ids.slice(0, 8));

        const sampleText = samples.map(f => {
            const date = (f.created_at || '').slice(0, 10);
            return `[${date}] ${(f.content || '').slice(0, 200)}`;
        }).join('\n');

        // 已有實體索引——讓 LLM 判斷新話題是否歸屬已有實體，而非盲目新建
        const existingEnts = db.prepare(`
            SELECT name, category FROM entity_profiles
            WHERE status IN ('active','seed') AND category IN ('place','event','project','term')
            ORDER BY fragment_count DESC LIMIT 60
        `).all();
        const existingBlock = existingEnts.length > 0
            ? existingEnts.map(e => `· ${e.name}（${e.category}）`).join('\n')
            : '（暫無）';

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

            // 程式碼側閘門（鐵證走規則）——閘門定義在 screenEmergentVerdict()，
            // 生產和迴歸探針共用同一份，免得探針量到的是裸的模型輸出。
            const screened = screenEmergentVerdict(verdict);
            if (!screened.accept) {
                if (verdict?.is_entity) {
                    console.log(`[Archivist] ⏭ 湧現判定被程式碼閘門攔下(${screened.reason}): "${verdict.name || ''}"`);
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
                if (existing) { console.log(`[Archivist] ⏭ 湧現種子去重跳過: "${name}" → 已有 "${existing.name}"`); continue; }

                const category = (verdict.category === 'event' || verdict.category === 'place')
                    ? verdict.category : 'term';
                const r = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases)
                    VALUES (?, ?, 'seed', ?)`).run(name, category, JSON.stringify([]));

                // 連結團內碎片到新種子
                const insertFe = db.prepare(`INSERT OR IGNORE INTO fragment_entities
                    (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.55, 'emergence')`);
                let linked = 0;
                for (const mid of cluster.member_ids.slice(0, 20)) {
                    const info = insertFe.run(mid, r.lastInsertRowid);
                    if (info.changes > 0) linked++;
                }
                db.prepare('UPDATE entity_profiles SET fragment_count = ? WHERE id = ?').run(linked, r.lastInsertRowid);

                console.log(`[Archivist] 🌟 湧現檢測: ${name} (${category}) ← ${linked}碎片 (團${cluster.member_ids.length}條)`);
                detected++;

                // 寫觀星手記
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status)
                    VALUES ('emergent_constellation', ?, ?, 'done')`)
                    .run(category, JSON.stringify({ name, reason: verdict.reason, cluster_size: cluster.member_ids.length }));
            }
        } catch (e) {
            console.error('[Archivist] 湧現檢測LLM失敗:', e.message);
        }
    }

    return { detected };
}

module.exports = {
    buildEmergentJudgePrompt,
    screenEmergentVerdict,
    detectEmergentPlacesAndEvents,
};
