// =================================================================
// openai-compat.js - Gemini ↔ OpenAI 格式轉換層
// 當使用反代（OpenAI相容端點）時，自動轉換請求和響應格式
// =================================================================

/**
 * 判斷是否為 OpenAI 相容端點（反代）
 * 空端點或含 googleapis.com → Gemini 原生
 * 其他 → OpenAI 相容
 */
function isOpenAICompat(endpoint) {
    if (!endpoint || endpoint.trim() === '') return false;
    if (endpoint.includes('googleapis.com')) return false;
    return true;
}

/**
 * 構建 OpenAI 相容的請求 URL 和 Headers
 */
function buildOpenAIRequestMeta(endpoint, apiKey) {
    let baseUrl = endpoint.replace(/\/+$/, '');
    return {
        url: `${baseUrl}/chat/completions`,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        }
    };
}

/**
 * 將 Gemini 格式的 parts 轉換為 OpenAI 格式的 content
 * 處理文本、圖片（inline_data → image_url）、檔案
 */
function convertPartsToContent(parts) {
    if (!parts || parts.length === 0) return '';

    // 如果只有一個純文本 part，直接返回字串
    if (parts.length === 1 && parts[0].text) {
        return parts[0].text;
    }

    // 多個 parts 或含有非文本內容 → 返回陣列
    const content = [];
    for (const part of parts) {
        if (part.text) {
            content.push({ type: 'text', text: part.text });
            } else if (part.inline_data) {
                const dataUri = `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
                content.push({
                    type: 'image_url',
                    image_url: { url: dataUri }
                });
        } else if (part.functionCall) {
            // functionCall 在 parts 裡不轉 content，跳過
            continue;
        } else if (part.functionResponse) {
            // functionResponse 也跳過，單獨處理
            continue;
        }
    }

    // 如果最終只有一個文本，簡化為字串
    if (content.length === 1 && content[0].type === 'text') {
        return content[0].text;
    }

    return content;
}

/**
 * 將 Gemini contents 陣列轉換為 OpenAI messages 陣列
 * 同時處理 systemInstruction
 */
function convertContentsToMessages(contents, systemInstruction) {
    const messages = [];

    // 系統提示
    if (systemInstruction?.parts?.[0]?.text) {
        messages.push({
            role: 'system',
            content: systemInstruction.parts[0].text
        });
    }

    for (const item of contents) {
        const role = item.role === 'model' ? 'assistant' : 'user';

        // 檢查是否包含 functionCall（model 的工具呼叫）
        const functionCalls = item.parts?.filter(p => p.functionCall) || [];
        if (functionCalls.length > 0) {
            // 先處理文本部分
            const textParts = item.parts.filter(p => p.text);
            const textContent = textParts.map(p => p.text).join('');

            // 構建 assistant 訊息 + tool_calls
            const toolCalls = functionCalls.map((fc, idx) => ({
                id: `call_${Date.now()}_${idx}`,
                type: 'function',
                function: {
                    name: fc.functionCall.name,
                    arguments: JSON.stringify(fc.functionCall.args || {})
                },
                ...(fc.functionCall.thought_signature && { thought_signature: fc.functionCall.thought_signature })
            }));

            messages.push({
                role: 'assistant',
                content: textContent || null,
                tool_calls: toolCalls
            });
            continue;
        }

        // 檢查是否包含 functionResponse（工具結果）
        const functionResponses = item.parts?.filter(p => p.functionResponse) || [];
        if (functionResponses.length > 0) {
            // 找到上一條 assistant 訊息中對應的 tool_call_id
            const lastAssistantMsg = [...messages].reverse().find(
                m => m.role === 'assistant' && m.tool_calls
            );

            for (let i = 0; i < functionResponses.length; i++) {
                const fr = functionResponses[i];
                // 匹配 tool_call_id：按名字找，或按索引
                let toolCallId = `call_fallback_${i}`;
                if (lastAssistantMsg?.tool_calls) {
                    const match = lastAssistantMsg.tool_calls.find(
                        tc => tc.function.name === fr.functionResponse.name
                    );
                    if (match) toolCallId = match.id;
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCallId,
                    content: JSON.stringify(fr.functionResponse.response || {})
                });
            }
            continue;
        }

        // 普通訊息
        const convertedContent = convertPartsToContent(item.parts);
        messages.push({
            role,
            content: convertedContent
        });
            }

            return messages;
        }

/**
 * 將 Gemini functionDeclarations 轉換為 OpenAI tools 格式
 */
function convertToolsToOpenAI(geminiTools) {
    if (!geminiTools) return undefined;

    const declarations = geminiTools.functionDeclarations || [];
    if (declarations.length === 0) return undefined;

    return declarations.map(fd => ({
        type: 'function',
        function: {
            name: fd.name,
            description: fd.description || '',
            parameters: convertGeminiSchema(fd.parameters)
        }
    }));
}

/**
 * 遞迴轉換 Gemini schema（大寫 TYPE）→ OpenAI schema（小寫 type）
 */
function convertGeminiSchema(schema) {
    if (!schema) return {};

    const result = {};
    if (schema.type) {
        result.type = schema.type.toLowerCase();
    }
    if (schema.description) {
        result.description = schema.description;
    }
    if (schema.properties) {
        result.properties = {};
        for (const [key, val] of Object.entries(schema.properties)) {
            result.properties[key] = convertGeminiSchema(val);
        }
    }
    if (schema.required) {
        result.required = schema.required;
    }
    if (schema.items) {
        result.items = convertGeminiSchema(schema.items);
    }
    if (schema.enum) {
        result.enum = schema.enum;
    }
    return result;
}

/**
 * 構建完整的 OpenAI 相容請求體
 */
function buildOpenAIRequestBody(geminiRequestBody, modelName) {
    const body = {
        model: modelName,
        stream: true,
        messages: convertContentsToMessages(
            geminiRequestBody.contents,
            geminiRequestBody.systemInstruction
        )
    };

    // 生成引數
    const gc = geminiRequestBody.generationConfig;
    if (gc) {
        if (gc.maxOutputTokens) body.max_tokens = gc.maxOutputTokens;
        if (gc.temperature !== undefined) body.temperature = gc.temperature;
        if (gc.topP !== undefined) body.top_p = gc.topP;
        // topK 在 OpenAI 格式中不支援，忽略
    }

    // 工具
    if (geminiRequestBody.tools?.[0]) {
        const openaiTools = convertToolsToOpenAI(geminiRequestBody.tools[0]);
        if (openaiTools && openaiTools.length > 0) {
            body.tools = openaiTools;
        }
    }
    // 安全設定（Gemini預設過濾會攔截生理期/健康等正常對話，必須傳BLOCK_NONE）
    if (geminiRequestBody.safetySettings && geminiRequestBody.safetySettings.length > 0) {
        body.safety_settings = geminiRequestBody.safetySettings;
    }
    // GLM/DeepSeek/Gemini 停用thinking，避免消耗額外token
    // Gemini thinking 會吃掉輸出預算導致空回覆/截斷（即使3.x也未修復）
    const modelLower = (modelName || '').toLowerCase();
    if (modelLower.includes('glm') || modelLower.includes('deepseek') || modelLower.includes('gemini')) {
        body.thinking = { type: "disabled" };
    }
    return body;
}

// =================================================================
// SSE 響應解析：OpenAI 流式格式 → 統一內部格式
// =================================================================

/**
 * 解析 OpenAI SSE 的一行資料
 * 返回: { type: 'text'|'tool_call'|'tool_call_delta'|'done'|null, ... }
 * 
 * OpenAI 的 tool_calls 是增量傳送的：
 *   第一個 chunk: tool_calls[0] = { id, function: { name, arguments: "" } }
 *   後續 chunks: tool_calls[0] = { function: { arguments: "..." } }  (增量拼接)
 *   finish_reason: "tool_calls" 表示所有工具呼叫完成
 */
function parseOpenAISSEChunk(jsonStr) {
    if (jsonStr === '[DONE]') {
        return { type: 'done' };
    }

    try {
        const data = JSON.parse(jsonStr);
        const choice = data.choices?.[0];
        if (!choice) return null;

        // 檢查結束原因
        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
            return { type: 'tool_calls_complete' };
        }
        if (choice.finish_reason === 'stop') {
            return { type: 'done' };
        }
        // Gemini 安全過濾器攔截（即使設了BLOCK_NONE也可能觸發，尤其在OpenAI相容路徑丟失safety_settings時）
        if (choice.finish_reason === 'error' || choice.native_finish_reason === 'SAFETY') {
            return { type: 'safety_block', native_reason: choice.native_finish_reason || 'ERROR' };
        }

        const delta = choice.delta;
        if (!delta) return null;

        // 文本內容
        if (delta.content) {
            return { type: 'text', text: delta.content };
        }

        // 工具呼叫（增量）
        if (delta.tool_calls && delta.tool_calls.length > 0) {
            return {
                type: 'tool_call_delta',
                tool_calls: delta.tool_calls.map(tc => ({
                    index: tc.index,
                    id: tc.id || null,
                    name: tc.function?.name || null,
                    arguments_delta: tc.function?.arguments || '',
                    thought_signature: tc.thought_signature || null
                }))
            };
        }

        return null;
    } catch (e) {
        return null;
    }
}

/**
 * 工具呼叫累積器
 * OpenAI 流式中 tool_calls 是增量傳送的，需要累積完整的呼叫資訊
 */
class ToolCallAccumulator {
    constructor() {
        // { [index]: { id, name, arguments } }
        this.calls = {};
    }

    /**
     * 處理一個增量 delta
     */
    feed(toolCallDeltas) {
        for (const delta of toolCallDeltas) {
            const idx = delta.index;
            if (!this.calls[idx]) {
                this.calls[idx] = { id: '', name: '', arguments: '', thought_signature: null };
            }
            if (delta.id) this.calls[idx].id = delta.id;
            if (delta.name) this.calls[idx].name = delta.name;
            if (delta.thought_signature) this.calls[idx].thought_signature = delta.thought_signature;
            this.calls[idx].arguments += delta.arguments_delta;
        }
    }

    /**
     * 獲取所有完整的工具呼叫
     * 返回: [{ id, name, args }]
     */
    getCompletedCalls() {
        const results = [];
        for (const idx of Object.keys(this.calls).sort((a, b) => a - b)) {
            const call = this.calls[idx];
            let args = {};
            try {
                args = JSON.parse(call.arguments);
            } catch (e) {
                console.error(`⚠️ [OpenAI相容] 工具引數解析失敗:`, call.arguments);
            }
            results.push({
                id: call.id,
                name: call.name,
                args: args,
                thought_signature: call.thought_signature || null
            });
        }
        return results;
    }

    /**
     * 重置累積器（新一輪工具呼叫時）
     */
    reset() {
        this.calls = {};
    }
}

/**
 * 構建工具呼叫結果的 messages（用於下一輪請求）
 * @param {Array} toolCalls - [{ id, name, args }] 從 accumulator 獲取
 * @param {Array} toolResults - 對應的執行結果
 * @param {string|null} textBeforeTools - 工具呼叫前的文本（如果有）
 */
function buildToolResultMessages(toolCalls, toolResults, textBeforeTools) {
    const messages = [];

    // assistant 訊息：包含 tool_calls
    const assistantMsg = {
        role: 'assistant',
        content: textBeforeTools || null,
        tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args)
            }
        }))
    };
    messages.push(assistantMsg);

    // tool 訊息：每個工具呼叫一條
    for (let i = 0; i < toolCalls.length; i++) {
        messages.push({
            role: 'tool',
            tool_call_id: toolCalls[i].id,
            content: JSON.stringify(toolResults[i] || {})
        });
    }

    return messages;
}

module.exports = {
    isOpenAICompat,
    buildOpenAIRequestMeta,
    buildOpenAIRequestBody,
    convertContentsToMessages,
    convertToolsToOpenAI,
    parseOpenAISSEChunk,
    ToolCallAccumulator,
    buildToolResultMessages
};