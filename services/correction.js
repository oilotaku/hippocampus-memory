// =================================================================
// Correction（糾正閉環）：使用者糾正 → 教訓 → Scribe 注入
// =================================================================
// 兩條閉環共用 correction_log 表：
//   ① correct_memory 工具 → processChatCorrection → 定位錯源、修記憶、記賬
//   ② recordCorrection 攢到 MERGE_THRESHOLD → mergeGuidelines → 長期準則 → Scribe 注入
//
// ⚠️ correction_log.status 只表示「合併生命週期」（active → merged）。
//    「這條糾正是否已做過級聯降權」是另一件事，必須另開列記賬——
//    把兩件事塞進同一個 status 會讓兩邊互相掐死（一方處理完就把行移出 active，
//    另一方永遠攢不到閾值）。見 README 的架構說明。

const { getDb } = require('../database');
const { sealField } = require('./memoryCrypto');
const { callLLM } = require('./llm');
const { chromaDBOperation } = require('./memory');
const { fillPrompt, USER } = require('./nameResolver');

const CORRECTION_CONFIG = {
    // 歸因判斷用哪個模型配置：字串=按名稱查，數字=按 id 查，null=用 is_default=1 的配置。
    // 新庫沒有內建的 api_configs id，留 null 即可（跑 scripts/setup_llm.js 建預設配置）。
    API_CONFIG_ID: null,
    ACTIVE_LIMIT: 5,        // Scribe 注入最近 N 條活躍教訓
    MERGE_THRESHOLD: 10,    // 累積 N 條 → 合併為長期準則
};

// 寫入一條糾正
function recordCorrection({ targetType, targetId, wrongSummary, correctSummary, source = 'manual', chatMessageId = null }) {
    const db = getDb();
    const insert = db.prepare(`
        INSERT INTO correction_log (target_type, target_id, wrong_summary, correct_summary, source, chat_message_id, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
    `);
    const info = insert.run(targetType, targetId || null, wrongSummary, correctSummary, source, chatMessageId);
    console.log(`[Correction] 記錄糾正 #${info.lastInsertRowid}: ${wrongSummary.slice(0, 50)} → ${correctSummary.slice(0, 50)}`);

    // 觀星手記可見化：聊天自動糾正寫入 changelog（手動刪除已有自己的可見路徑）
    if (source === 'chat_correction') {
        try {
            db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('memory_correction', NULL, ?, 'done')`)
                .run(JSON.stringify({
                    wrong: (wrongSummary || '').slice(0, 80),
                    correct: (correctSummary || '').slice(0, 80),
                    target: targetType,
                }));
        } catch (e) { /* changelog 失敗不影響糾正主流程 */ }
    }

    // 如果被糾正的記憶在 memories 表中，降權
    if (targetType === 'memory' && targetId) {
        db.prepare("UPDATE memories SET weight = MAX(1, weight * 0.3), updated_at = datetime('now') WHERE id = ?").run(targetId);
        console.log(`[Correction] 記憶 #${targetId} 已降權 ×0.3`);
    }
    if (targetType === 'fragment' && targetId) {
        // 聊天修正路徑已先把來源設為 cooling（回覆也告知使用者「已標記為降溫」），
        // 這裡不可再蓋回 consolidated；其餘呼叫端維持原行為。
        db.prepare("UPDATE memory_fragments SET status = 'consolidated' WHERE id = ? AND status != 'cooling'").run(targetId);
        console.log(`[Correction] 碎片 #${targetId} 已標記 consolidated（cooling 者保留）`);
    }

    // 檢查是否需要合併
    const activeCount = db.prepare("SELECT COUNT(*) as c FROM correction_log WHERE status='active'").get();
    if (activeCount.c >= CORRECTION_CONFIG.MERGE_THRESHOLD) {
        console.log(`[Correction] 活躍糾正已達 ${activeCount.c} 條，觸發合併...`);
        // 非同步合併，不阻塞請求
        mergeGuidelines().catch(e => console.error('[Correction] 合併失敗:', e.message));
    }

    return info.lastInsertRowid;
}

// 獲取最近活躍糾正教訓（供 Scribe 注入）
function getActiveCorrections(limit = CORRECTION_CONFIG.ACTIVE_LIMIT) {
    const db = getDb();
    const rows = db.prepare(`
        SELECT wrong_summary, correct_summary FROM correction_log
        WHERE status = 'active'
        ORDER BY created_at DESC LIMIT ?
    `).all(limit);

    if (!rows.length) return null;

    return rows.map(r =>
        `- 錯誤：${r.wrong_summary} → 正確：${r.correct_summary}`
    ).join('\n');
}

// 合併活躍糾正為長期準則
async function mergeGuidelines() {
    const db = getDb();
    const rows = db.prepare("SELECT id, wrong_summary, correct_summary FROM correction_log WHERE status='active'").all();
    if (rows.length < CORRECTION_CONFIG.MERGE_THRESHOLD) return null;

    const itemsText = rows.map(r => `- wrong: ${r.wrong_summary}\n  correct: ${r.correct_summary}`).join('\n');

    const systemPrompt = `你是編輯準則合併器。將多條糾正教訓歸納為3-5條"長期編輯準則"，每條一句話（不超過40字），去重合並同類項。

輸出JSON：{"guidelines": ["準則1", "準則2", ...]}`;

    let guidelines = [];
    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: `請合併以下糾正教訓為編輯準則：\n\n${itemsText}` }] }],
            systemPrompt,
            null,
            { temperature: 0.3, maxOutputTokens: 1000 },
            CORRECTION_CONFIG.API_CONFIG_ID
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);
        guidelines = result.guidelines || [];
    } catch (e) {
        console.error('[Correction] LLM合併失敗，使用原文:', e.message);
        guidelines = rows.map(r => `${r.wrong_summary} → ${r.correct_summary}`);
    }

    // 寫入 user_settings
    const { setUserSetting } = require('../utils/settings');
    await setUserSetting('scribe_guidelines', JSON.stringify({
        guidelines,
        merged_at: new Date().toISOString(),
        merged_from: rows.length
    }));

    // 標記已合併：只標「送進 LLM 的那批 id」，LLM 呼叫期間新進的修正保持 active
    const mark = db.prepare("UPDATE correction_log SET status='merged' WHERE status='active' AND id = ?");
    db.transaction((ids) => { for (const id of ids) mark.run(id); })(rows.map(r => r.id));

    console.log(`[Correction] 合併完成：${rows.length}條 → ${guidelines.length}條長期準則`);
    return guidelines;
}

// 獲取長期準則（供 Scribe 注入）
async function getMergedGuidelines() {
    const { getUserSetting } = require('../utils/settings');
    const setting = await getUserSetting('scribe_guidelines');
    if (!setting?.value) return null;

    try {
        const parsed = JSON.parse(setting.value);
        if (parsed.guidelines?.length) {
            return parsed.guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n');
        }
    } catch (_) {}
    return null;
}

// =================================================================
// 聊天修正：{{ai.name}} 調 correct_memory 工具 → 小模型定位源記憶 → 執行修正
// =================================================================

async function createCoreFragment(content, chatId) {
    const db = getDb();
    const info = db.prepare(`
        INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_msg_ids, layer, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        'correction',
        USER.name,
        sealField('memory_fragments', 'content', content),
        0.7,
        'chat_correction',
        '[]',
        'event',
        'active'
    );
    const fragId = info.lastInsertRowid;
    console.log(`[Correction] 寫入修正 fragment #${fragId}`);

    try {
        await chromaDBOperation('index_batch', {
            items: [{
                id: `fragment_${fragId}`,
                text: `${USER.name}: ${content}`,
                metadata: { type: 'correction', entity: USER.name, content, source: 'chat_correction', fragment_id: fragId }
            }]
        });
        console.log(`[Correction] ChromaDB indexed: fragment_${fragId}`);
    } catch (e) {
        console.error(`[Correction] ChromaDB 索引失敗 fragment_${fragId}:`, e.message);
    }

    return fragId;
}

async function judgeCorrectionSource(wrongStatement, correction, candidates) {
    const candLines = candidates.map((c, i) =>
        `[${i}] id=${c.id} source_table=${c.source_table}\n內容: ${c.content}`
    ).join('\n\n');

    // 只有模板串過 fillPrompt；下面拼進去的是使用者/記憶原文，不能再走 fillPrompt
    // （原文裡出現 {user} 之類的字面量會被誤替換）。
    const systemPrompt = fillPrompt(`你是記憶修正判斷器。給定：
1. 一條錯誤陳述（{{ai.name}}說的話）
2. 正確的版本（{{user.name}}的糾正）
3. 若干候選記憶條目

判斷：錯誤陳述是否來源於某條候選記憶？
- 如果是 → 指出是哪條（id），並生成修正後的內容（保持原記憶的第三人稱風格）
- 如果不是 → 標記為 hallucination

輸出嚴格JSON：{"matched": true/false, "memory_id": null或數字, "source_table": "fragment"或"memory"或null, "corrected_content": "修正後的記憶內容（第三人稱）", "explanation": "簡短中文判斷理由"}`);

    const userPrompt = `錯誤陳述：「${wrongStatement}」
正確版本：「${correction}」

候選記憶：
${candLines || '（無候選記憶）'}`;

    let reply;
    try {
        const res = await callLLM(
            [{ role: 'user', parts: [{ text: userPrompt }] }],
            systemPrompt,
            null,
            { temperature: 0.2, maxOutputTokens: 1024 },
            CORRECTION_CONFIG.API_CONFIG_ID
        );
        reply = res.reply;
    } catch (e) {
        console.error('[Correction] 歸因判斷呼叫失敗:', e.message);
        return { matched: false, memory_id: null, source_table: null, corrected_content: correction, explanation: 'LLM呼叫失敗，按幻聽處理' };
    }

    try {
        const json = JSON.parse(reply.replace(/```json\s*|\s*```/g, '').trim());
        return {
            matched: Boolean(json.matched),
            memory_id: json.memory_id || null,
            source_table: json.source_table || null,
            corrected_content: json.corrected_content || correction,
            explanation: json.explanation || ''
        };
    } catch (e) {
        console.error('[Correction] JSON解析失敗:', reply.slice(0, 200));
        return { matched: false, memory_id: null, source_table: null, corrected_content: correction, explanation: '解析失敗，按幻聽處理' };
    }
}

// 解析呼叫端指定的記憶：memoryType 明確指定 'episode'|'memory'（memories 表）或 'fragment'（碎片表）；
// memoryId 也可帶前綴（'memory_5'、'episode_5'、'fragment_12'，與 Chroma id 同格式）。
// 未指定型別時：兩表都有該 id 就兩筆都列為候選（由 LLM 依內容判斷，並以 source_table 回報），
// 只有一表有就取那一筆。
function resolveMemoryRefs(db, memoryId, memoryType) {
    let id = memoryId;
    let type = memoryType || null;
    if (typeof id === 'string') {
        const m = id.trim().match(/^(memory|episode|fragment)_(\d+)$/i);
        if (m) { type = type || m[1].toLowerCase(); id = m[2]; }
        else if (/^\d+$/.test(id.trim())) id = id.trim();
    }
    id = Number(id);
    if (!Number.isInteger(id) || id <= 0) return [];
    if (type === 'episode') type = 'memory';
    const getMem = () => db.prepare("SELECT id, content, 'memory' AS source_table FROM memories WHERE id = ?").get(id);
    const getFrag = () => db.prepare("SELECT id, content, 'fragment' AS source_table FROM memory_fragments WHERE id = ?").get(id);
    if (type === 'memory') return [getMem()].filter(Boolean);
    if (type === 'fragment') return [getFrag()].filter(Boolean);
    return [getMem(), getFrag()].filter(Boolean);
}

async function processChatCorrection({ wrongStatement, correction, memoryId, memoryType, chatId }) {
    // 引數護欄：缺引數時直接把話說回去。否則下面的 wrongStatement.slice 會拋
    // TypeError，工具結果喂不回上下文，表現為{{ai.name}}「說完就沉默」。
    if (!wrongStatement || !correction) {
        return { success: false, formatted: '需要同時給出 wrong_statement（說錯的那句）和 correction（正確版本）。' };
    }

    const db = getDb();
    const candidates = [];

    // 1. 收集候選記憶
    // 1a. 傳了 memoryId → 查 DB
    if (memoryId) {
        candidates.push(...resolveMemoryRefs(db, memoryId, memoryType));
    }

    // 1b. 工作記憶池
    try {
        const { getRecentFragments } = require('./workingMemory');
        const recent = getRecentFragments();
        const seen = new Set(candidates.map(c => `${c.source_table}-${c.id}`));
        for (const r of recent) {
            const key = `${r.source_table}-${r.id}`;
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push({ id: r.id, content: r.content, source_table: r.source_table });
            }
        }
        console.log(`[Correction] 工作記憶池候選: ${recent.length} 條`);
    } catch (e) {
        console.error('[Correction] 工作記憶池查詢失敗:', e.message);
    }

    // 1c. 向量搜尋補位
    try {
        const { searchMemoriesByVector } = require('./memory');
        const vecResults = await searchMemoriesByVector(wrongStatement, 5);
        const seen = new Set(candidates.map(c => `${c.source_table}-${c.id}`));
        for (const v of vecResults) {
            const sourceTable = v._table === 'fragments' ? 'fragment' : 'memory';
            const key = `${sourceTable}-${v.id}`;
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push({ id: v.id, content: v.content || v.title, source_table: sourceTable });
            }
        }
        console.log(`[Correction] 向量搜尋候選: ${vecResults.length} 條`);
    } catch (e) {
        console.error('[Correction] 向量搜尋失敗:', e.message);
    }

    console.log(`[Correction] 候選記憶共 ${candidates.length} 條（wrong="${wrongStatement.slice(0, 60)}", correction="${correction.slice(0, 60)}"）`);

    // 2. 純幻覺：無候選
    if (candidates.length === 0) {
        console.log('[Correction] 無候選記憶 → 純幻覺');
        const fragId = await createCoreFragment(correction, chatId);
        recordCorrection({ targetType: 'hallucination', targetId: null, wrongSummary: wrongStatement, correctSummary: correction, source: 'chat_correction', chatMessageId: chatId });
        return {
            success: true,
            formatted: `記憶庫裡沒有找到相關的記憶——你剛才說的「${wrongStatement.slice(0, 50)}」很可能是你自己編造或混淆的。我已將正確版本存為新記憶 #${fragId}。`
        };
    }

    // 3. 小模型判斷
    const judgment = await judgeCorrectionSource(wrongStatement, correction, candidates);
    console.log(`[Correction] 判斷結果: matched=${judgment.matched} id=${judgment.memory_id} ${judgment.explanation}`);

    // 只接受候選清單內的 id：LLM 編造或指向不存在的 id 一律走幻聽路徑。
    // source_table 有給就必須與候選吻合；沒給則以 id 唯一比對候選（撞號無法判定 → 幻聽）。
    let matchedCand = null;
    if (judgment.matched && judgment.memory_id) {
        const same = candidates.filter(c => String(c.id) === String(judgment.memory_id));
        if (judgment.source_table === 'memory' || judgment.source_table === 'fragment') {
            matchedCand = same.find(c => c.source_table === judgment.source_table) || null;
        } else if (same.length === 1) {
            matchedCand = same[0];
        }
        if (!matchedCand) console.warn(`[Correction] LLM 回傳的 memory_id=${judgment.memory_id}(${judgment.source_table}) 不在候選清單內，按幻聽處理`);
    }

    if (matchedCand) {
        const sourceTable = matchedCand.source_table;
        judgment.memory_id = matchedCand.id;
        if (sourceTable === 'fragment') {
            db.prepare(`UPDATE memory_fragments SET status = 'cooling', lifecycle_updated_at = datetime('now') WHERE id = ?`).run(judgment.memory_id);
        } else {
            db.prepare(`UPDATE memories SET layer = 'cooling' WHERE id = ?`).run(judgment.memory_id);
        }
        console.log(`[Correction] 標記 ${sourceTable}[${judgment.memory_id}] 為 cooling`);

        const fragId = await createCoreFragment(judgment.corrected_content, chatId);
        recordCorrection({ targetType: sourceTable, targetId: judgment.memory_id, wrongSummary: wrongStatement, correctSummary: correction, source: 'chat_correction', chatMessageId: chatId });

        return {
            success: true,
            formatted: `記憶修正完成。找到了你說錯的來源——記憶 #${judgment.memory_id}（${judgment.explanation || '內容有誤'}）。已將那條記憶標記為降溫，並寫入了修正後的新記憶 #${fragId}。`
        };
    }

    // 未命中 → 幻聽
    const fragId = await createCoreFragment(judgment.corrected_content || correction, chatId);
    recordCorrection({ targetType: 'hallucination', targetId: null, wrongSummary: wrongStatement, correctSummary: correction, source: 'chat_correction', chatMessageId: chatId });

    return {
        success: true,
        formatted: `記憶庫中有 ${candidates.length} 條可能相關的記憶，但經過比對，你剛才說的似乎是自己編造或混淆的（${judgment.explanation || '找不到確切的來源記憶'}）。我已將正確版本存為新記憶 #${fragId}。`
    };
}

module.exports = { recordCorrection, getActiveCorrections, mergeGuidelines, getMergedGuidelines, processChatCorrection };
