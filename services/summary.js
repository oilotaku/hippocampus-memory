// =================================================================
// 對話自動總結生成
// =================================================================

const { get_encoding } = require('tiktoken');
const { encryption } = require('../encryption');
const { callLLM } = require('./llm');
const { getDb } = require('../database');
const { fillPrompt, USER, AI } = require('./nameResolver');

const enc = get_encoding('cl100k_base');

/**
 * 生成對話總結
 * @param {number} chatId - 聊天室ID
 * @param {number} startMessageId - 起始訊息ID（可選）
 * @param {number} endMessageId - 結束訊息ID（可選）
 * @returns {Promise<object>} { success, summary, roundStart, roundEnd, tokenCount }
 */
async function generateChatSummary(chatId, startMessageId = null, endMessageId = null) {
    try {
        const db = getDb();
        
        // 1. 確定總結範圍
        if (!startMessageId) {
            const chatInfo = db.prepare('SELECT last_summary_message_id FROM chats WHERE id = ?').get(chatId);
            startMessageId = chatInfo.last_summary_message_id || 0;
        }        
        
        if (!endMessageId) {
            const latestMsg = db.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId);
            endMessageId = latestMsg?.id || 0;
        }
        
        if (startMessageId >= endMessageId) {
            return { success: false, message: '沒有新訊息需要總結' };
        }
        
        // 2. 讀取需要總結的訊息
        const messages = db.prepare(`
            SELECT id, sender, content, is_encrypted, timestamp, message_type, is_activity
            FROM messages
            WHERE chat_id = ? AND id > ? AND id <= ?
            ORDER BY id ASC
        `).all(chatId, startMessageId, endMessageId);
        
        if (messages.length === 0) {
            return { success: false, message: '沒有找到需要總結的訊息' };
        }
        
        // 3. 解密並格式化訊息（{{user.name}}完整保留，{{ai.name}}截斷到300字——提供足夠上下文判斷猜測+糾正）
        let conversationText = '';
        let roundCount = 0;
        let currentDate = '';  // 跟蹤當前日期，跨天時插入日期標記
        const firstTimestamp = messages[0].timestamp;
        const lastTimestamp = messages[messages.length - 1].timestamp;

        // 輔助函式：提取訊息文本
        const extractText = (msg) => {
            let content = msg.is_encrypted === 1 ? (encryption.decrypt(msg.content) || '') : msg.content;
            try {
                const parsed = JSON.parse(content);
                if (parsed.components && Array.isArray(parsed.components)) {
                    const textParts = parsed.components
                        .filter(c => c.type === 'text')
                        .map(c => c.content);
                    const repostParts = parsed.components
                        .filter(c => c.type === 'snitch_repost')
                        .map(c => {
                            let text = `【轉發Snitch動態】${c.title || ''}`;
                            if (c.tag) text += ` [${c.tag}]`;
                            if (c.body) text += `\n${c.body}`;
                            if (c.source_url) text += `\n原文連結: ${c.source_url}`;
                            return text;
                        });
                    return [...textParts, ...repostParts].join('\n');
                }
                return content;
            } catch (e) {
                return content;
            }
        };

        // 輔助函式：從時間戳提取日期字串（YYYY-MM-DD）
        const extractDate = (ts) => {
            if (!ts || typeof ts !== 'string') return '';
            return ts.slice(0, 10);  // ISO: 2026-07-27T... 或 SQLite: 2026-07-27 ...
        };

        // 輔助函式：格式化日期為中文標記
        const formatDateMarker = (dateStr) => {
            if (!dateStr) return '';
            const [y, m, d] = dateStr.split('-');
            return `${parseInt(m)}月${parseInt(d)}日`;
        };

        for (const msg of messages) {
            // 跨天檢測：日期變化時插入日期標記
            const msgDate = extractDate(msg.timestamp);
            if (msgDate && msgDate !== currentDate) {
                currentDate = msgDate;
                conversationText += `--- ${formatDateMarker(msgDate)} ---\n\n`;
            }

            // 從訊息時間戳提取 HH:MM，防止 LLM 編造時間
            const msgTime = (msg.timestamp && typeof msg.timestamp === 'string')
                ? (msg.timestamp.includes('T') ? msg.timestamp.slice(11, 16) : msg.timestamp.slice(11, 16))
                : '';
            const timePrefix = msgTime ? `[${msgTime}] ` : '';

            // v5.12: 活動行算1輪
            if (msg.is_activity) {
                roundCount++;
                let summary = '';
                try {
                    const data = JSON.parse(extractText(msg));
                    summary = data.type || 'activity';
                    if (data.summary) summary += ' · ' + data.summary.slice(0, 60);
                } catch (_) {
                    summary = extractText(msg).slice(0, 60);
                }
                conversationText += `${timePrefix}${AI.name} ${summary}\n\n`;
                continue;
            }

            if (msg.sender === 'ai') {
                roundCount++;
                // {{ai.name}}訊息以300字縮略注入，提供上下文供模型判斷猜測/糾正
                const aiText = extractText(msg);
                if (aiText.trim()) {
                    const preview = aiText.slice(0, 300);
                    conversationText += `${timePrefix}${AI.name}: ${preview}${aiText.length > 300 ? '…' : ''}\n\n`;
                }
                continue;
            }

            const textContent = extractText(msg);
            conversationText += `${timePrefix}${USER.name}: ${textContent}\n\n`;
        }
        
        console.log(`generateChatSummary: range ${startMessageId+1}-${endMessageId}, ${roundCount} rounds`);

        // 4. 構建總結prompt
        const parseTs = (ts) => {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T'));
            return {
                date: d.toISOString().split('T')[0],
                time: d.toTimeString().substring(0, 5)
            };
        };
        const startParsed = parseTs(firstTimestamp);
        const endParsed = parseTs(lastTimestamp);
        const startTime = startParsed.time;
        const endTime = endParsed.time;
        const startDate = startParsed.date;
        const endDate = endParsed.date;

        // 跨天頭部格式：同天用 "2026-07-27"，跨天用 "2026-07-26～27"
        const dateDisplay = startDate === endDate
            ? startDate
            : `${startDate}～${endDate}`;

        const previousRounds = db.prepare(`
            SELECT COALESCE(MAX(round_end), 0) as last_round
            FROM chat_summaries
            WHERE chat_id = ?
        `).get(chatId);

        const roundStart = previousRounds.last_round + 1;
        const roundEnd = roundStart + roundCount - 1;

        const summaryPrompt = `你是對話航海日誌的記錄者。以下是 {{user.name}} 和 {{ai.name}} 的完整對話文本。

你的任務：從對話中提取關鍵事件和情緒弧線，按【時間段 + 主題】合併成塊，寫一份簡潔而有重點的航海日誌。

## 核心原則：抓重點，合併同類

- 日誌以 {{user.name}} 為主：{{user.pronoun}}的言行、情緒變化、重要活動是記錄核心。
- 把相鄰的、屬於同一話題或同一情緒線的互動合併成一個時間段塊。不要逐條訊息記錄。
- 傳送了什麼表情、{{ai.name}} 的日常附和、過渡性的閒聊——這些微觀細節不記。{{ai.name}} 的猜測、玩笑、誇張、調侃、戲劇化表述不記錄，更不能當作 {{user.name}} 的狀態來寫。
- 如果 {{user.name}} 在對話中糾正了 {{ai.name}} 的錯誤，只記錄糾正後的事實，不記錄被糾正前的錯誤內容。

## 時間段塊格式

每條記錄格式為：\`HH:MM～HH:MM · 主題概括，具體內容\`
- 如果只是一個時間點（不是時間段），用單個時間戳：\`HH:MM · ...\`
- 跨天時，對話文本中會出現 \`--- M月D日 ---\` 日期標記。屬於第二天（或更晚）的時間塊，時間前必須加日期字首：\`M月D日 HH:MM～HH:MM\`，以明確區分是哪一天的凌晨/早上。
- 每個時間段塊用 1～3 句話講清發生了什麼，保留 {{user.name}} 的原話用詞。

## 分塊直覺

- {{user.name}} 的話題明顯轉換 → 另起一塊
- {{user.name}} 情緒有明顯轉折（如從焦慮到被逗笑） → 這本身就是一個值得記的情緒弧線，合併成一塊，寫出起承轉合
- {{user.name}} 開始了完全不同性質的活動（如從聊天切換到看劇、工作、出門） → 另起一塊
- 同一話題的來回互動，即使持續很久 → 一塊即可，概括核心
- 親密互動、色情或角色扮演內容：如實記錄時間範圍和核心內容，不迴避不模糊

## 寫什麼

- 保留 {{user.name}} 原話中的具體用詞（如：吃午飯、怕記不住劇情、連續工作了很長時間、腿疼、熱死我了），不要替換為抽象概括詞
- 用具象的動詞短語。嚴禁使用「討論了」「交流了」「分享了」「表達了」等含糊的社交模糊詞
- 只寫"發生了什麼"，不寫"這意味著什麼"。不寫空洞的關係評價或分析性標題
- ${AI.name} 做出了實質行動（查閱資料、搜尋資訊、給出明確判斷結論）時，在塊內附帶一句
- 單純的吃喝（無情緒伴隨、無特殊意義）不記。如有記錄價值，使用完成時（「喝了」「吃完了」）使讀者明確事件已了結

## 不寫什麼

- 不寫 {{ai.name}} 的過渡話、追問、日常附和
- 不寫內心決策過程（"{{user.name}} 決定..."），只記錄{{user.pronoun}}說了什麼、做了什麼
- 不寫表情、單個語氣詞、純寒暄等微觀互動
- 不寫相對時間詞（剛才、下午、晚上、今天），始終用絕對時間戳

## 航海日誌樣本

同天示例：

[2026-06-23 對話回顧 | 第1-50輪 | 14:00-18:00]

14:10～14:35 · {{user.name}} 在工作間隙邊吃某家快餐邊追《某部劇》。向 {{ai.name}} 抱怨今天好累，坦言怕自己記不住劇情，聊到喜歡某個角色的型別。
15:10～15:22 · {{user.name}} 情緒低落，連續工作了很長時間、腿疼得不想動。{{ai.name}} 查了天氣告訴{{user.pronoun}}會降溫。
16:45～17:30 · {{user.name}} 與 {{ai.name}} 長時間聊天。後來想吃火鍋但懶得動，最終點了外賣。

跨天示例：

[2026-07-26～27 對話回顧 | 第25145-25174輪 | 23:38-08:30]

23:38～00:15 · {{user.name}} 失眠刷手機，和 {{ai.name}} 聊起最近的工作壓力，吐露了對未來的不確定感。
7月27日 03:00 · {{user.name}} 終於有了睏意，和 {{ai.name}} 道晚安。
7月27日 08:00～08:30 · {{user.name}} 起床，簡單聊了幾句今天的工作安排，{{ai.name}} 提醒{{user.pronoun}}記得吃早餐。

## 待處理完整對話資料
日期: ${dateDisplay}
輪次範圍: 第 ${roundStart} - ${roundEnd} 輪
時間範圍: ${startTime} - ${endTime}

對話文本：
${conversationText}`;

        // 5. 呼叫LLM生成總結
        console.log('generateChatSummary: calling LLM...');
        const summaryApiConfig = db.prepare("SELECT id FROM api_configs WHERE name = 'gemini-3.1-flash-lite' LIMIT 1").get();
        const summaryApiConfigId = summaryApiConfig?.id || null;
        if (summaryApiConfigId) {
            console.log('generateChatSummary: using gemini-3.1-flash-lite config');
        } else {
            console.log('generateChatSummary: gemini-3.1-flash-lite not found, using default');
        }
        const result = await callLLM([
            { role: 'user', parts: [{ text: fillPrompt(summaryPrompt) }] }
        ], '', null, {}, summaryApiConfigId);
        
        if (!result || !result.reply) {
            console.error('generateChatSummary: API returned no content');
            return { success: false, message: '總結生成失敗', error: 'API未返回有效內容' };
        }
        
        const summaryText = result.reply;
        const tokenCount = enc.encode(summaryText).length;
        
        console.log(`generateChatSummary: success, ${tokenCount} tokens`);
        
        // 6. 加密並儲存總結
        const encryptedSummary = encryption.encrypt(summaryText);
        
        db.prepare(`
            INSERT INTO chat_summaries (
                chat_id, start_message_id, end_message_id, 
                round_start, round_end, summary_text, token_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            chatId, 
            startMessageId + 1,
            endMessageId,
            roundStart,
            roundEnd,
            encryptedSummary,
            tokenCount
        );
        
        // 7. 更新chats表
        db.prepare('UPDATE chats SET last_summary_message_id = ? WHERE id = ?').run(endMessageId, chatId);
        
        console.log(`generateChatSummary: saved rounds ${roundStart}-${roundEnd}`);
        
        return { 
            success: true, 
            summary: summaryText,
            roundStart,
            roundEnd,
            tokenCount
        };
        
    } catch (error) {
        console.error('generateChatSummary: 內部錯誤:', error.message, error.stack);
        return { success: false, message: '生成總結時出錯', error: error.message };
    }
}


async function checkAndTriggerSummary(chatId, label) {
    try {
        const db = getDb();
        const chatConfig = db.prepare('SELECT last_summary_message_id, summary_interval FROM chats WHERE id = ?').get(chatId);
        const lastSummaryId = chatConfig.last_summary_message_id || 0;
        const interval = chatConfig.summary_interval || 50;

        const roundsSinceLastSummary = db.prepare(`
            SELECT COUNT(*) as count
            FROM messages
            WHERE chat_id = ? AND id > ? AND sender = 'ai'
        `).get(chatId, lastSummaryId).count;

        console.log(`📊 [${label}] 自動總結檢測: 距上次總結${roundsSinceLastSummary}輪，閾值${interval}輪`);

        if (roundsSinceLastSummary >= interval) {
            console.log(`🎯 [${label}] 達到總結閾值，開始後臺生成總結...`);
            generateChatSummary(chatId).then(result => {
                if (result.success) {
                    console.log(`✅ [${label}] 自動總結完成: 第${result.roundStart}-${result.roundEnd}輪`);
                } else {
                    console.error(`❌ [${label}] 自動總結失敗:`, result.message);
                }
            }).catch(err => {
                console.error(`❌ [${label}] 自動總結異常:`, err);
            });
        }
    } catch (error) {
        console.error(`❌ [${label}] 自動總結檢測失敗:`, error);
    }
}

/**
 * 遍歷所有活躍聊天室，觸發總結檢測（供 cron 兜底呼叫）
 * 即使某條訊息路徑漏接了 checkAndTriggerSummary，15 分鐘內會被追上
 */
async function checkAllChats() {
    try {
        const db = getDb();
        const chats = db.prepare('SELECT id FROM chats').all();
        for (const { id } of chats) {
            await checkAndTriggerSummary(id, 'Cron兜底');
        }
    } catch (error) {
        console.error('[Summary] checkAllChats 失敗:', error);
    }
}

module.exports = { generateChatSummary, checkAndTriggerSummary, checkAllChats };