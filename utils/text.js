// =================================================================
// 文本處理工具函式
// =================================================================

const crypto = require('crypto');

// 思考鏈過濾：去掉LLM在輸出中"自言自語"的推理過程
// 應用於流式輸出的每個句子 + 主動訊息的後處理
const REASONING_PREFIX_CN = /^(?:讓我(?:想想|分析|思考|考慮|來看|整理|先說|確認|檢查|看看|來想|想一[想下])|我來(?:分析|看看|想想|思考|整理)|思考中|分析一下|考慮到|我在想|經過分析|我需要先|首先[，,]\s*)|^(?:让我(?:想想|分析|思考|考虑|来看|整理|先说|确认|检查|看看|来想|想一[想下])|我来(?:分析|看看|想想|思考|整理)|思考中|分析一下|考虑到|我在想|经过分析|我需要先|首先[，,]\s*)/;
const REASONING_PREFIX_EN = /^(?:Let me\s+(?:analyze|think|break\s*down|consider|figure\s*out|write|say|respond|reply|check|see|look|process)|I(?:\s|')ll\s+(?:think|analyze|check|see)|I need to\s|First[，,]\s|(?:Okay|OK)[，,]?\s*(?:so\s*)?(?:let(?:\s|')s\s+)?(?:think|analyze|see)?|Alright[，,]\s*(?:let(?:\s|')s\s+)?|So\s+(?:let me|I'll|we need)|Hmm[，,]\s*let me|Wait[，,]\s*let me)/i;
const REASONING_PREFIX = new RegExp(
    REASONING_PREFIX_CN.source + '|' + REASONING_PREFIX_EN.source,
    'i'
);
const NUMBERED_STEP = /^\d+[\.、)\s]\s*\S/;  // "1. xxx" or "1) xxx"

const filterThinkingProcess = (text) => {
    if (!text) return text;

    // 分段落處理：如果文本包含編號步驟 + 推理字首 → 嘗試提取最後一段乾淨內容
    const paragraphs = text.split(/\n{2,}/);
    if (paragraphs.length > 1 && REASONING_PREFIX.test(paragraphs[0])) {
        for (let i = paragraphs.length - 1; i >= 0; i--) {
            const p = paragraphs[i].trim();
            if (p && !NUMBERED_STEP.test(p) && !REASONING_PREFIX.test(p) && p.length >= 4) {
                // 找到最後一個非推理段落，返回它（丟棄前面的思考鏈）
                return p;
            }
        }
        return '';  // 所有段落都是推理
    }

    // 單段落：逐行過濾推理行
    let result = text
        // 去掉整行的推理字首開頭
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;  // 空行過濾
            if (NUMBERED_STEP.test(trimmed)) return false;  // 編號步驟
            if (REASONING_PREFIX.test(trimmed)) return false;  // 推理字首
            if (/^第[一二三四五六七八九十\d]+[步][：:]/.test(trimmed)) return false;  // "第X步：..."
            if (/^(?:Step\s*\d|Phase\s*\d)[：:]/i.test(trimmed)) return false;  // "Step 1:..."
            return true;
        })
        .join('\n')
        // 去掉括號/方括號內的元評論
        .replace(/\([^)]*(?:思考|分析|考慮|推理|檢查|確認)[^)]*\)|\([^)]*(?:思考|分析|考虑|推理|检查|确认)[^)]*\)/g, '')
        .replace(/\[[^\]]*(?:思考|分析|考慮|推理|檢查|確認)[^\]]*\]|\[[^\]]*(?:思考|分析|考虑|推理|检查|确认)[^\]]*\]/g, '')
        // 對話歷史的系統後設資料標記（stream.js 注入的 [系統 · ...] 標籤），禁止輸出
        .replace(/\[系統\s*·\s*[^\]]*\]|\[系统\s*·\s*[^\]]*\]/g, '')
        // Draco 從不主動使用【】括號，任何出現的【】內容都是 prompt 洩露
        .replace(/【[^】]*】/g, '')
        // 去掉"XXX：思考/分析..."格式的整行
        .split('\n')
        .filter(line => !/^.*(?:思考|分析|推理|考慮)[:：]\s*\S|^.*(?:思考|分析|推理|考虑)[:：]\s*\S/.test(line.trim()))
        .join('\n')
        // 去掉"我覺得需要..."、"我需要先..."行
        .split('\n')
        .filter(line => !/^(?:我覺得需要|我需要先|我應該先)|^(?:我觉得需要|我需要先|我应该先)/.test(line.trim()))
        .join('\n')
        // 規範化多餘空行
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return result;
};

// 句子分割
function splitIntoSentences(text) {
    const sentences = [];
    const lines = text.split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;

        let current = '';
        let inQuote = false;
        let zhDepth = 0;  // {zh: ...} 塊深度 — 內部標點不切句

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            current += ch;

            // 追蹤 {zh: ...} 塊，內部標點忽略；塊結束時切句
            if (ch === '{' && /^\{zh\s*:/i.test(line.substring(i))) {
                zhDepth++;
            } else if (ch === '}' && zhDepth > 0) {
                zhDepth--;
                if (zhDepth === 0) {
                    // {zh:...} 塊結束 → 切句
                    sentences.push(current);
                    current = '';
                    continue;
                }
            }

            if (ch === '“' || ch === '「' || ch === '『') inQuote = true;
            if (ch === '”' || ch === '」' || ch === '』') inQuote = false;

            if (inQuote || zhDepth > 0) continue;

            if (/[。！？?!;；]/.test(ch)) {
                while (i + 1 < line.length && /[！？!?]/.test(line[i + 1])) {
                    i++;
                    current += line[i];
                }
                while (i + 1 < line.length && /[”」』""'']/.test(line[i + 1])) {
                    i++;
                    current += line[i];
                    inQuote = false;
                }
                const next = line[i + 1];
                if (next && /[，,]/.test(next)) continue;

                // 如果後面緊跟 {zh: ...} 塊，不切 — 它屬於當前句子
                const rest = line.substring(i + 1).trimStart();
                if (/^\{zh\s*:/i.test(rest)) continue;

                sentences.push(current);
                current = '';
            }
        }

        if (current.trim()) sentences.push(current);
    }

    const merged = [];
    for (const s of sentences) {
        if (merged.length > 0 && /^[\*_`~\s“”''「」【】（）]+$/.test(s.trim())) {
            merged[merged.length - 1] += s;
        } else {
            merged.push(s);
        }
    }
    return merged.length > 0 ? merged : [text];
}

// 重新整理文本緩衝區
// onSentence: 可選回撥，每句生成後呼叫，用於SSE廣播到其他Tab
function flushTextBuffer(textBuffer, res, components, onSentence) {
    let text = textBuffer.trim();
    if (!text) return;

    text = text.replace(/<meta[^>]*>[\s\S]*?<\/meta>/gi, '').trim();

    try {
        const parsed = JSON.parse(text);
        if (parsed.components && Array.isArray(parsed.components)) {
            const extracted = parsed.components
                .filter(c => c.type === 'text' && c.content)
                .map(c => c.content)
                .join('\n\n');
            if (extracted) {
                text = extracted;
                console.warn('[flushTextBuffer] AI輸出了JSON格式，已自動提取文本內容');
            } else {
                return;
            }
        }
    } catch (e) {
        // 正常情況：不是JSON，繼續處理
    }

    if (!text) return;

    const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p && !/^[""】）\s]*$/.test(p));

    // 收集所有句子，段落間保留空行以便filterThinkingProcess識別段落結構
    const paraTexts = paragraphs.map(p =>
        splitIntoSentences(p).join('\n')
    );
    const fullText = paraTexts.join('\n\n');

    // 過濾思考鏈：以整個buffer為上下文判斷是否有推理洩露
    const cleanedText = filterThinkingProcess(fullText);

    // 如果過濾後為空，說明整段都是推理——全部丟棄
    if (!cleanedText) {
        console.log('[flushTextBuffer] 整段被思考鏈過濾丟棄');
        return;
    }

    // 重新切句後傳送（清洗後的文本可能丟了標點/行邊界，再切一次保證正確）
    const cleanParagraphs = cleanedText.split(/\n\n+/).map(p => p.trim()).filter(p => p);
    cleanParagraphs.forEach(paragraph => {
        splitIntoSentences(paragraph).forEach(sentence => {
            res.write(`data: ${JSON.stringify({ type: 'sentence', text: sentence })}\n\n`);
            components.push({ type: 'text', content: sentence });
            if (onSentence) {
                try { onSentence(sentence); } catch {}
            }
        });
    });
}

// 碎片內容確定性雜湊（規範化後 SHA256）—— 用於記憶碎片級硬去重。
//
// 規範化策略（刻意保守，避免誤合併）：
//   - 去全部空白（含全形空格 　），"Alice 搬家" 與 "Alice搬家" 同雜湊
//   - 小寫（英文實體名大小寫無關）
//   - 保留標點——只有「除空白外完全一致」才算重複，語義近但標點不同不會誤合併
//
// entity 參與雜湊：同一句話關於不同實體不應被合併。
function hashFragmentContent(entity, content) {
    const SEP = ' '; // NUL 分隔符：不被 \s 剝除，避免 "A"+"BC" 與 "AB"+"C" 碰撞
    const normalized = `${entity || ''}${SEP}${content || ''}`
        .replace(/[\s　]+/g, '')
        .toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = { filterThinkingProcess, splitIntoSentences, flushTextBuffer, hashFragmentContent };
