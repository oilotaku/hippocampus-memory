'use strict';
// =================================================================
// services/hippocampus/dentate/encode.js — 齒狀迴：Scribe 抽取結果的寫入流程（型態分離）
// =================================================================
// 內嗅皮質（entorhinal/scribe.js）只負責把對話交給模型抽取；抽取結果寫進記憶前的
// 驗證、正規化、分離與寫入都在這裡，依序：
//   1. 原話佐證（quote 必須是來源訊息的逐字子串）與助理閒聊過濾
//   2. 日期與星期一致性校正（scribe.fix_dates）
//   3. 向量去重（ChromaDB，迴環過濾）＋本地確定性去重（同實體、近似重複 → 證據累加）
//   4. 寫入碎片，附上情緒與時間欄位（杏仁核）、標籤路由、實體連結
// 寫入之後的索引、指代消解、情緒基準更新、意圖閉環與游標仍由 Scribe 調度。
const { toLocalMinute, parseDbTime } = require('../../../utils/time');
const { USER } = require('../../nameResolver');
const { sealField } = require('../../memoryCrypto');
const { chromaDBOperation } = require('../ca3/memory');
const { getScribeConfig } = require('../entorhinal/scribeConfig');
const { filterEntriesByQuote, normalizedContentHash, findDuplicate, quoteSourceDate } = require('./scribeQuality');
const { fixDateWeekday } = require('./dateFix');
const emotion = require('../amygdala');

// 校驗 processed_until 是否為有效日期字串（防止非日期值寫入導致 Scribe 永久跳過）
function isValidTimestamp(ts) {
    if (!ts || typeof ts !== 'string') return false;
    const d = parseDbTime(ts);
    return !isNaN(d.getTime()) && ts.startsWith('20'); // 簡單但有效：必須是可解析日期且以年份開頭
}

/**
 * 把一批抽取結果寫進記憶。
 * result   parseScribeReply 的結果（{ entries, ... }）；entries 會被過濾與校正（原地修改）
 * ctx      { messages（本批、已濾掉 cinema）, buffer（背景訊息）, modeInfo（batchChatMode）, dec（訊息解密） }
 * 回傳     { written, newFragmentIds, sourceMsgIds, duplicates, evidenceMerged,
 *            quoteDropped, quoteDroppedByType, aiChitchatDropped, aiChitchatDroppedByType }
 */
async function encodeEntries(db, result, { messages, buffer, modeInfo, dec }) {
    let written = 0;
    let hashDedupCount = 0;
    // source_date 必須是有效日期。歷史上出現過 JSON 物件誤入 message.timestamp，
    // 會把 source_date 寫成髒值（如 {"llm_call 之類）。與 Scribe 游標 safeUntil 同款守衛：
    // 從末尾往前找最後一個有效時間戳，取它的日期。
    // source_date 一律是當地（UTC+8）日期：DB 時間戳是 UTC，直接 slice 會讓當地清晨的訊息記到前一天。
    let sourceDate = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isValidTimestamp(messages[i]?.timestamp)) {
            sourceDate = toLocalMinute(messages[i].timestamp).slice(0, 10) || messages[i].timestamp.slice(0, 10);
            break;
        }
    }
    if (!sourceDate) sourceDate = toLocalMinute(new Date()).slice(0, 10);
    // 每條記憶的日期＝原話所在那則訊息的日期（一批可橫跨數週）；對不上時退回批次日期
    const msgDates = messages
        .filter(m => m.message_type !== 'image' && isValidTimestamp(m?.timestamp))
        .map(m => ({ text: dec(m).slice(0, 500), date: toLocalMinute(m.timestamp).slice(0, 10) }));
    const newFragmentIds = [];

    // 收集分析視窗內的所有訊息 ID（buffer + main messages），作為證據鏈
    const allMsgIds = [...buffer.map(m => m.id), ...messages.map(m => m.id)];
    const sourceMsgIds = JSON.stringify(allMsgIds);

    // ── 原話佐證：quote 必須是來源訊息的逐字子串，否則丟棄（防幻覺寫入記憶）──
    // 來源只取本次處理的訊息（buffer 僅作背景），截斷長度與餵給 LLM 的一致（500 字）。
    let quoteDropped = 0, quoteDroppedByType = {};
    let aiChitchatDropped = 0, aiChitchatDroppedByType = {};
    if (Array.isArray(result.entries) && result.entries.length) {
        const srcs = { user: [], ai: [] };
        for (const m of messages) {
            if (m.message_type === 'image') continue;
            srcs[m.sender === 'user' ? 'user' : 'ai'].push(dec(m).slice(0, 500));
        }
        const f = filterEntriesByQuote(result.entries, srcs);
        result.entries = f.kept;
        quoteDropped = f.dropped;
        quoteDroppedByType = f.droppedByType;
        aiChitchatDropped = f.aiChitchatDropped;
        aiChitchatDroppedByType = f.aiChitchatDroppedByType;
        if (aiChitchatDropped > 0) {
            const d2 = Object.entries(aiChitchatDroppedByType).map(([t, n]) => `${t}:${n}`).join(',');
            console.log(`[Scribe] 助理閒聊過濾：丟棄 ${aiChitchatDropped} 條（${d2}）`);
        }
        if (quoteDropped > 0) {
            const detail = Object.entries(quoteDroppedByType).map(([t, n]) => `${t}:${n}`).join(',');
            console.log(`[Scribe] 原話佐證：丟棄 ${quoteDropped} 條（無/偽造 quote；${detail}）`);
        }
    }
    // ── 日期與星期一致性：模型換算「下週三」常把日期算錯一到三天（星期多半對），寫入前用程式校正 ──
    if (getScribeConfig().fix_dates && Array.isArray(result.entries)) {
        for (const e of result.entries) {
            if (!e || typeof e.content !== 'string') continue;
            const r = fixDateWeekday(e.content, e.quote, quoteSourceDate(e.quote, msgDates) || sourceDate);
            if (!r.fixes.length) continue;
            e.content = r.content;
            for (const f of r.fixes) console.log(`[Scribe] 日期校正(${f.how}): ${f.from} → ${f.to}`);
        }
    }
    let evidenceMerged = 0;

    if (result.entries?.length) {
        // 迴環過濾：向量去重，防止 {ai} 複述已有記憶被重新提取
        let skipIndices = new Set();
        try {
            const dedupItems = result.entries.map((e, i) => ({
                id: `scribe_temp_${i}`,
                text: `${e.entity || USER.name}: ${e.content}`
            }));
            const dedupResult = await chromaDBOperation('find_duplicates', {
                items: dedupItems,
                threshold: 0.82
            });
            if (dedupResult.duplicates?.length > 0) {
                for (const dup of dedupResult.duplicates) {
                    const idx = parseInt(dup.new_id.replace('scribe_temp_', ''));
                    skipIndices.add(idx);
                    console.log(`[Scribe] 迴環過濾: "${dup.new_preview}" ≈ ${dup.existing_id} (sim=${dup.similarity})`);
                }
                console.log(`[Scribe] 迴環過濾: ${dedupResult.duplicates.length}/${result.entries.length} 條跳過（與已有記憶重複）`);
            }
        } catch (e) {
            console.error('[Scribe] 迴環過濾查詢失敗，降級為全部寫入:', e.message);
        }

        // 聊天模式在 runScribe 開頭已依本批訊息判定（cinema 訊息已濾掉，見 batchChatMode）
        const msgChatMode = modeInfo.mode;
        const isRP = modeInfo.isRP;

        const insert = db.prepare(`
            INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_date, source_msg_ids, is_rp, chat_mode, value_tags, priority, content_hash, quote)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // 確定性去重（同實體、active 碎片，**不限日期**）：正規化後內容相同，或近似重複且無關鍵差異
        // （數字/星期/時間詞/換掉一個詞 → 視為不同事實，不合並）。
        // 命中時不新增碎片，改為累加既有碎片的證據（confidence +0.05 上限 1.0，evidence_count +1）。
        // 與 ChromaDB 向量去重互補——嵌入分不清「週三/週五」「貓/狗」，所以本地規則優先於向量。
        const candidateStmt = db.prepare(`
            SELECT id, content, content_hash, source_msg_ids, quote FROM memory_fragments
            WHERE entity = ? AND status = 'active' ORDER BY id DESC LIMIT 400
        `);
        const bumpStmt = db.prepare(`
            UPDATE memory_fragments
            SET confidence = MIN(1.0, COALESCE(confidence, 0.5) + 0.05),
                evidence_count = COALESCE(evidence_count, 1) + 1,
                quote = COALESCE(quote, ?)
            WHERE id = ?
        `);
        const emoMsgs = messages.filter(m => m.message_type !== 'image').map(m => ({ ts: m.timestamp, text: dec(m) }));
        const insertEntityLink = db.prepare(`
            INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by, created_at)
            VALUES (?, ?, ?, 0.70, 'scribe_extract', datetime('now'))
        `);
        for (let i = 0; i < result.entries.length; i++) {
            const entry = result.entries[i];

            // ── Entity handling: support both legacy "entity" (string) and new "entities" (array) ──
            let entityList = [];
            if (entry.entities && Array.isArray(entry.entities) && entry.entities.length > 0) {
                entityList = entry.entities;
            } else if (entry.entity && typeof entry.entity === 'string') {
                // Backward compat: single entity string → array of one
                entityList = [{ name: entry.entity, relation: 'related_to' }];
            } else {
                // Fallback: default to USER
                entityList = [{ name: USER.name, relation: 'related_to' }];
            }

            // Primary entity for the legacy 'entity' column (first entity in list)
            const primaryEntity = entityList[0].name || USER.name;

            // source: 遊戲模式的訊息 → source='game'，否則沿用 LLM 輸出或預設 'chat'
            const fragmentSource = msgChatMode === 'game' ? 'game' : (entry.source || 'chat');

            // value_tags: new field for memory value classification
            const valueTags = (entry.value_tags && Array.isArray(entry.value_tags))
                ? JSON.stringify(entry.value_tags) : '[]';

            // priority: LLM 在提取時通過 Scribe prompt 判斷語義重要性（非關鍵詞匹配）
            // 'high' = 自我剖白 / 核心價值觀表達 / 身份認同宣告
            const priority = entry.priority || 'normal';

            // ── 本地去重 + 證據累加（優先於 Chroma 向量去重）──
            const contentHash = normalizedContentHash(primaryEntity, entry.content);
            const hashDup = findDuplicate(primaryEntity, entry.content, candidateStmt.all(primaryEntity));
            if (hashDup) {
                hashDedupCount++;
                if (hashDup.source_msg_ids !== sourceMsgIds) {  // 同一批訊息重跑不算新證據
                    bumpStmt.run(sealField('memory_fragments', 'quote', String(entry.quote || '').trim()), hashDup.id);
                    evidenceMerged++;
                }
                console.log(`[Scribe] 去重: "${String(entry.content).slice(0, 40)}" = 既有片段 #${hashDup.id}，證據+1`);
                continue;
            }
            if (skipIndices.has(i)) continue;

            const info = insert.run(
                entry.type || 'observation',
                primaryEntity,
                sealField('memory_fragments', 'content', entry.content),
                entry.emotional_weight ?? 0.3,
                fragmentSource,
                quoteSourceDate(entry.quote, msgDates) || sourceDate,
                sourceMsgIds,
                isRP ? 1 : 0,
                msgChatMode,
                valueTags,
                priority,
                contentHash,
                sealField('memory_fragments', 'quote', String(entry.quote || '').trim())
            );
            const fragId = info.lastInsertRowid;
            newFragmentIds.push(fragId);

            // G2：八維情緒、事件日期、三種時間與時段（emotion.enabled=false 時不做任何事；失敗不影響寫入）
            try {
                emotion.applyScribeEmotion(db, fragId, entry, { raisedAt: emotion.resolveRaisedAt(entry.quote, emoMsgs) });
            } catch (e) {
                console.warn(`[Scribe] 情緒欄位寫入失敗 frag#${fragId}: ${e.message}`);
            }

            // 按值標直連到聚合星座（配置驅動，見 services/tagRouting.js）。
            // **入庫即建鏈**：不能等分類管線——分類入口要求 status='active'，而整合會把
            // 跑過的碎片改成 'consolidated'，兩條管線搶同一批碎片，誰先到誰說了算。
            try {
                const { linkTaggedFragment } = require('../consolidation/archivist');
                linkTaggedFragment(db, fragId, valueTags);
            } catch (e) {
                console.warn(`[Scribe] 標路由連結失敗 frag#${fragId}: ${e.message}`);
            }

            // ── Link to entities via fragment_entities (multi-entity support) ──
            // Try keyword match for each entity name to resolve entity_id immediately.
            // If not matched, resolveEntityIds() will handle coref later.
            for (const ent of entityList) {
                const entName = (ent.name || '').trim();
                if (!entName || entName.length < 2) continue;
                const relation = ent.relation || 'related_to';

                // Try exact name match first
                let entityRow = db.prepare(
                    'SELECT id FROM entity_profiles WHERE name = ? AND status IN (\'active\',\'seed\')'
                ).get(entName);

                // Fallback: alias match
                if (!entityRow) {
                    entityRow = db.prepare(
                        `SELECT id FROM entity_profiles
                         WHERE status IN ('active','seed')
                           AND aliases LIKE ? LIMIT 1`
                    ).get(`%${entName}%`);
                }

                if (entityRow) {
                    insertEntityLink.run(fragId, entityRow.id, relation);
                }
                // If no match → resolveEntityIds() will handle via LLM coref later
            }
            written++;
        }
    }
    return {
        written, newFragmentIds, sourceMsgIds, duplicates: hashDedupCount, evidenceMerged,
        quoteDropped, quoteDroppedByType, aiChitchatDropped, aiChitchatDroppedByType,
    };
}

module.exports = { encodeEntries, isValidTimestamp };
