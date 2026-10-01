// =================================================================
// LLM 呼叫統一介面卡 + Embedding + API使用統計
// =================================================================

const axios = require('axios');
const { ProxyAgent } = require('undici');
const { spawn } = require('child_process');
const path = require('path');
const { get_encoding } = require('tiktoken');
const { getDb } = require('../database');

// 共享代理連線池：複用 TCP+TLS 連線，避免每次請求重新握手
const proxyDispatcher = new ProxyAgent({
    uri: 'http://127.0.0.1:7890',
    connections: 8,
    headersTimeout: 120000,
    bodyTimeout: 300000,
    connectTimeout: 30000,
});
function getProxyDispatcher() { return proxyDispatcher; }

// 連線超時重試：代理/中轉偶爾抽風，給第二次機會
async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fetch(url, options);
        } catch (err) {
            const retryableCodes = ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
                                     'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
                                     'ECONNRESET', 'ECONNREFUSED'];
            const isRetryable = err.message?.includes('ConnectTimeout') ||
                              err.message?.includes('Timeout') ||
                              retryableCodes.includes(err.cause?.code);
            if (attempt < maxRetries && isRetryable) {
                const reasonMap = {
                    UND_ERR_SOCKET: '連線被重置',
                    UND_ERR_HEADERS_TIMEOUT: '響應頭超時',
                    UND_ERR_BODY_TIMEOUT: '響應體超時',
                    ECONNRESET: 'TLS握手被遠端重置',
                    ECONNREFUSED: '遠端拒絕連線',
                };
                const reason = reasonMap[err.cause?.code] || '連線超時';
                console.warn(`[fetch] ${reason}，${2 * (attempt + 1)}s後重試 (${attempt + 1}/${maxRetries})…`);
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                continue;
            }
            throw err;
        }
    }
}
const { encryption } = require('../encryption');
const { getShanghaiTime } = require('../utils/time');
const { assertSafeEndpoint, joinEndpointPath } = require('../utils/ssrf-guard');

const enc = get_encoding('cl100k_base');

// 判斷是否需要走代理：國內站點直連，海外站點走 127.0.0.1:7890
const DOMESTIC_DOMAINS = ['api.deepseek.com', 'dashscope.aliyuncs.com', 'api.dzzi.ai'];
const DOMESTIC_IPS = ['162.14.124.108'];  // 國內中轉站IP，直連不走代理
function needsProxy(url) {
    if (url.includes('127.0.0.1') || url.includes('localhost') || url.includes('192.168')) return false;
    try {
        const host = new URL(url).hostname;
        if (host.endsWith('.cn')) return false;
        if (DOMESTIC_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return false;
        if (DOMESTIC_IPS.includes(host)) return false;
    } catch {}
    return true;
}

// =================================================================
// 本地 Embedding（通過 chroma_helper.py + fastembed，無需 API）
// =================================================================

async function getLocalEmbedding(text) {
    return new Promise((resolve, reject) => {
        const python = spawn(path.join(__dirname, '..', 'venv', 'bin', 'python'), [
            path.join(__dirname, '..', 'chroma_helper.py'),
            'embed',
            JSON.stringify({ text })
        ]);
        let stdout = '';
        python.stdout.on('data', (d) => stdout += d.toString());
        python.stderr.on('data', (d) => console.error('LocalEmbed Error:', d.toString()));
        python.on('close', (code) => {
            if (code === 0) {
                try {
                    const result = JSON.parse(stdout);
                    if (result.embedding) resolve(result.embedding);
                    else reject(new Error(result.error || 'No embedding'));
                } catch (e) { reject(e); }
            } else {
                reject(new Error(`Local embed exit ${code}`));
            }
        });
    });
}

// =================================================================
// Embedding 配置獲取
// =================================================================

function getEmbeddingAPIKey() {
    const db = getDb();
    const config = db.prepare(`
        SELECT api_key, model_name, provider, endpoint 
        FROM api_configs 
        WHERE (model_name LIKE '%embedding%' OR name LIKE '%embedding%')
        AND (provider = 'gemini' OR provider = 'openai_compatible')
        LIMIT 1
    `).get();
    
    if (config) {
        return {
            api_key: encryption.decrypt(config.api_key) || null,
            model_name: config.model_name,
            provider: config.provider,
            endpoint: config.endpoint
        };
    }
    
    return {
        api_key: process.env.GEMINI_API_KEY || process.env.API_KEY,
        model_name: 'gemini-embedding-001',
        provider: 'gemini',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta'
    };
}

// =================================================================
// Embedding 生成
// =================================================================

async function getEmbedding(text, embeddingConfig) {
    try {
        if (!embeddingConfig) {
            const db = getDb();
            const dbConfig = db.prepare(`
                SELECT * FROM api_configs 
                WHERE model_name LIKE '%embedding%' OR name LIKE '%embedding%'
                ORDER BY id DESC LIMIT 1
            `).get();
            
            if (dbConfig) {
                embeddingConfig = {
                    api_key: dbConfig.api_key ? (encryption.decrypt(dbConfig.api_key) || null) : process.env.GEMINI_API_KEY,
                    endpoint: dbConfig.endpoint,
                    model_name: dbConfig.model_name,
                    provider: dbConfig.provider || 'gemini'
                };
            } else {
                embeddingConfig = {
                    api_key: process.env.GEMINI_API_KEY,
                    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
                    model_name: 'gemini-embedding-001',
                    provider: 'gemini'
                };
            }
        }
        
        const apiKey = embeddingConfig.api_key;
        const modelName = embeddingConfig.model_name;
        const provider = embeddingConfig.provider || 'gemini';
        
        let requestUrl, requestBody, headers;
        
        // SSRF 防護：端點可由使用者存入 DB，連線前驗證（無法釘 IP，見 utils/ssrf-guard.js 殘餘風險說明）
        await assertSafeEndpoint(embeddingConfig.endpoint);
        
        if (provider === 'gemini') {
            requestUrl = joinEndpointPath(embeddingConfig.endpoint, `models/${modelName}:embedContent`, { key: apiKey });
            requestBody = {
                model: modelName,
                content: { parts: [{ text: text }] }
            };
            headers = { 'Content-Type': 'application/json' };
        } else {
            requestUrl = joinEndpointPath(embeddingConfig.endpoint, 'embeddings');
            requestBody = { input: text, model: modelName };
            headers = { 'Content-Type': 'application/json' };
            // 本機 Ollama 等無需認證的端點：api_key 留空（或佔位 none）時不送 Authorization
            if (apiKey && apiKey !== 'none') headers['Authorization'] = `Bearer ${apiKey}`;
        }
        
        const useProxy = needsProxy(requestUrl);
        const response = await fetchWithRetry(requestUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            redirect: 'manual',
            ...(useProxy ? { dispatcher: proxyDispatcher } : {})
        });

        if (response.status >= 300 && response.status < 400) {
            throw new Error('Embedding API 回應轉址（3xx），為防止 SSRF 已阻止');
        }
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Embedding API error (${response.status}): ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
        
        if (provider === 'gemini') {
            return data.embedding?.values || data.embedding;
        } else {
            return data.data[0].embedding;
        }
        
    } catch (error) {
        console.error('getEmbedding failed:', error);
        throw error;
    }
}

// =================================================================
// LLM 統一呼叫入口
// =================================================================

async function callLLM(geminiMessages, systemPrompt, tools = null, generationConfig = {}, apiConfigId = null) {
    const db = getDb();
    
    let apiConfig;
    if (apiConfigId) {
        // 支援按名稱或ID查詢：字串名稱 → 按name查，數字 → 按id查
        if (isNaN(apiConfigId)) {
            apiConfig = db.prepare('SELECT * FROM api_configs WHERE name = ?').get(apiConfigId);
        } else {
            apiConfig = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(apiConfigId);
        }
    } else {
        apiConfig = db.prepare('SELECT * FROM api_configs WHERE is_default = 1').get();
    }
    
    // 記憶管線各模組寫死了專屬配置 id（如 52/36/38）；開源部署通常只有一條預設配置
    //（scripts/setup_llm.js 建立），找不到專屬配置時回落到預設，與 OSS_SETUP.md 的說明一致。
    if (!apiConfig && apiConfigId) {
        apiConfig = db.prepare('SELECT * FROM api_configs WHERE is_default = 1').get();
        if (apiConfig) console.warn(`callLLM: 找不到配置 ${apiConfigId}，回落到預設配置 ${apiConfig.name}`);
    }

    if (!apiConfig) {
        throw new Error('未找到有效的API配置');
    }

    let decryptedApiKey = apiConfig.api_key;
    if (apiConfig.api_key && apiConfig.api_key.startsWith('enc:')) {
        try {
            decryptedApiKey = encryption.decrypt(apiConfig.api_key);
            if (decryptedApiKey === null) throw new Error('decrypt returned null');
        } catch (e) {
            console.error('API Key decryption failed:', e);
            throw new Error('API Key 解密失敗，請重新配置連線');
        }
    }
    apiConfig.api_key = decryptedApiKey;
    
    console.log(`callLLM: using ${apiConfig.name} (${apiConfig.provider})`);
    
    if (apiConfig.provider === 'gemini') {
        return await callGeminiAPI(geminiMessages, systemPrompt, tools, generationConfig, apiConfig);
    } else if (apiConfig.provider === 'openai_compatible') {
        return await callOpenAICompatibleAPI(geminiMessages, systemPrompt, tools, generationConfig, apiConfig);
    } else {
        throw new Error(`Unsupported provider: ${apiConfig.provider}`);
    }
}

// =================================================================
// Gemini 官方 API
// =================================================================

async function callGeminiAPI(geminiMessages, systemPrompt, tools, generationConfig, apiConfig) {
    const requestBody = {
        contents: geminiMessages,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
            temperature: generationConfig.temperature ?? 1.0,
            maxOutputTokens: generationConfig.maxOutputTokens ?? 8192,
            ...generationConfig
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };
    
    if (tools && apiConfig.supports_tools) {
        requestBody.tools = [{ functionDeclarations: tools.functionDeclarations }];
    }

    const modelToUse = apiConfig.model_name_override || apiConfig.model_name;

    // Gemini 2.5 / flash-lite thinking token 會計入 maxOutputTokens 預算導致截斷或空返回
    // flash-lite 小模型長 prompt 下 thinking 可能吃光整筆預算 → 0 輸出 token
    if (!requestBody.generationConfig.thinkingConfig) {
        if (modelToUse.includes('2.5') || modelToUse.includes('flash-lite')) {
            requestBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
    }

    let baseUrl = apiConfig.endpoint;
    if (!baseUrl || baseUrl.trim() === '') {
        baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/';
    }
    if (!baseUrl.endsWith('/')) baseUrl += '/';
    await assertSafeEndpoint(baseUrl);
    const url = `${baseUrl}${modelToUse}:generateContent?key=${apiConfig.api_key}`;
    
    const safeUrlLog = url.replace(/key=([^&]+)/, 'key=******');
    console.log(`callGeminiAPI: ${safeUrlLog}`);

    let response;
    try {
        response = await axios.post(url, requestBody, { maxRedirects: 0, proxy: needsProxy(url) ? { host: '127.0.0.1', port: 7890, protocol: 'http' } : false });
    } catch (error) {
        console.error('callGeminiAPI error:', JSON.stringify(error.response?.data, null, 2));
        throw error;
    }
    
    const candidate = response.data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let reply = '';
    const functionCalls = [];

    for (const part of parts) {
        if (part.text) reply += part.text;
        if (part.functionCall) {
            functionCalls.push({
                name: part.functionCall.name,
                args: part.functionCall.args,
                originalPart: part
            });
        }
    }

    const usage = {
        inputTokens: response.data?.usageMetadata?.promptTokenCount || 0,
        outputTokens: response.data?.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: response.data?.usageMetadata?.totalTokenCount || 0
    };

    // 診斷空返回：文本為空但有 output tokens → thinking 吃掉預算
    if (!reply && !functionCalls.length && usage.outputTokens > 0) {
        console.warn(`[Gemini] ⚠️ 空文本但消耗${usage.outputTokens} output tokens → thinking 吃掉預算 | finishReason=${candidate?.finishReason} | safetyRatings=${JSON.stringify(candidate?.safetyRatings)}`);
    }

    return {
        reply: reply.trim(),
        functionCalls: functionCalls.length > 0 ? functionCalls : null,
        usage,
        finishReason: normalizeFinishReason(candidate?.finishReason),
    };
}

// 兩條路徑的結束原因統一成 'length'（輸出被上限截斷）／'stop'／其他小寫字串／null（不明）。
// 呼叫端（如 Scribe）據此判斷 JSON 是否被截斷，不必猜。
function normalizeFinishReason(r) {
    if (r == null || r === '') return null;
    const s = String(r).toLowerCase();
    if (s === 'max_tokens' || s === 'length') return 'length';
    if (s === 'stop' || s === 'end_turn') return 'stop';
    return s;
}

// =================================================================
// OpenAI 相容 API（反向代理）
// =================================================================

// 請求超時：環境變數 LLM_REQUEST_TIMEOUT_MS 優先；本機端點（如 Ollama，CPU 推論 + 首次載入模型
// 很容易超過 30 秒）預設 5 分鐘；其餘維持 30 秒。
function getRequestTimeoutMs(url) {
    const envMs = parseInt(process.env.LLM_REQUEST_TIMEOUT_MS, 10);
    if (Number.isFinite(envMs) && envMs > 0) return envMs;
    try {
        const host = new URL(url).hostname;
        if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return 300000;
    } catch (_) {}
    return 30000;
}

async function callOpenAICompatibleAPI(geminiMessages, systemPrompt, tools, generationConfig, apiConfig) {
    await assertSafeEndpoint(apiConfig.endpoint);
    let url = apiConfig.endpoint;
    if (!url.endsWith('/')) url += '/';
    if (!url.includes('chat/completions')) {
        url += 'chat/completions';
    }

    console.log(`callOpenAICompatibleAPI: ${url}`);

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    
    for (const msg of geminiMessages) {
        const role = msg.role === 'model' ? 'assistant' : 'user';
        
        const toolCalls = msg.parts?.filter(p => p.functionCall);
        const toolResults = msg.parts?.filter(p => p.functionResponse);
        
        if (toolCalls && toolCalls.length > 0) {
            const textPart = msg.parts.find(p => p.text);
            messages.push({
                role: 'assistant',
                content: textPart?.text || null,
                tool_calls: toolCalls.map((p, i) => ({
                    id: `call_${i}`,
                    type: 'function',
                    function: {
                        name: p.functionCall.name,
                        arguments: JSON.stringify(p.functionCall.args)
                    }
                }))
            });
        } else if (toolResults && toolResults.length > 0) {
            for (let i = 0; i < toolResults.length; i++) {
                const p = toolResults[i];
                messages.push({
                    role: 'tool',
                    tool_call_id: p.functionResponse.id || `call_${i}`,
                    content: JSON.stringify(p.functionResponse.response)
                });
            }
        } else {
            const hasImages = msg.parts?.some(p => p.inline_data);
            if (hasImages) {
                const content = [];
                for (const part of msg.parts) {
                    if (part.text) content.push({ type: 'text', text: part.text });
                    else if (part.inline_data) {
                        content.push({
                            type: 'image_url',
                            image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` }
                        });
                    }
                }
                messages.push({ role, content });
            } else {
                let content = '';
                for (const part of msg.parts) {
                    if (part.text) content += part.text;
                }
                if (content) messages.push({ role, content });
            }
        }
    }
    
    const requestBody = {
        model: apiConfig.model_name,
        messages: messages,
        // ?? 而不是 ||：temperature 0（確定性輸出）是合法值，不能被換成預設
        temperature: generationConfig.temperature ?? 0.7,
        max_tokens: generationConfig.maxOutputTokens ?? 4000,
    };
    // 停用thinking：DeepSeek/Gemini/Flash模型預設thinking會吃掉輸出預算
    // 尤其低max_tokens場景(如proactive contact 500 token)會導致0輸出
    const modelLower = apiConfig.model_name?.toLowerCase() || '';
    if (modelLower.includes('deepseek') || modelLower.includes('gemini') || modelLower.includes('flash')) {
        requestBody.thinking = { type: "disabled" };
    }

    // OpenRouter Flex 模式：便宜但可能排隊
    if (url.includes('openrouter.ai')) {
        requestBody.service_tier = 'flex';
    }
    
    if (tools && apiConfig.supports_tools && tools.functionDeclarations) {
        requestBody.tools = tools.functionDeclarations.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
            }
        }));
    }
    
    const axiosConfig = {
        headers: {
            // 本機 Ollama 等無需認證的端點：api_key 為空或 'none' 時不送 Authorization
            ...((apiConfig.api_key && apiConfig.api_key !== 'none') ? { 'Authorization': `Bearer ${apiConfig.api_key}` } : {}),
            'Content-Type': 'application/json'
        },
        proxy: needsProxy(url) ? { host: '127.0.0.1', port: 7890, protocol: 'http' } : false,
        maxRedirects: 0,
        timeout: getRequestTimeoutMs(url)
    };

    let response;
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            response = await axios.post(url, requestBody, axiosConfig);
            break;
        } catch (err) {
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ||
                            err.message?.includes('aborted') ||
                            err.message?.includes('ConnectTimeout') || err.message?.includes('Timeout');
            if (attempt < maxRetries && isTimeout) {
                console.warn(`[axios] 連線超時，${2 * (attempt + 1)}s後重試 (${attempt + 1}/${maxRetries})…`);
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                continue;
            }
            const apiErrDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : '無響應體';
            console.error('callOpenAICompatibleAPI error:', err.message, '| 響應:', apiErrDetail);
            throw err;
        }
    }
    
    const choice = response.data.choices?.[0];

    const finishReason = choice?.finish_reason;
    if (finishReason === 'length') {
        console.warn(`[llm] ⚠️ API返回finish_reason=length（輸出被截斷），model=${apiConfig.model_name}，max_tokens=${requestBody.max_tokens}`);
    }

    let reply = choice?.message?.content || '';

    // DeepSeek thinking模式fallback：content為空時讀reasoning_content
    if (!reply && choice?.message?.reasoning_content) {
        reply = choice.message.reasoning_content;
    }

    let functionCalls = null;
    
    if (choice?.message?.tool_calls) {
        functionCalls = choice.message.tool_calls.map(tc => ({
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments)
        }));
    }
    
    return {
        reply: reply ? reply.trim() : '',
        functionCalls,
        usage: {
            inputTokens: response.data?.usage?.prompt_tokens || 0,
            outputTokens: response.data?.usage?.completion_tokens || 0,
            totalTokens: response.data?.usage?.total_tokens || 0
        },
        finishReason: normalizeFinishReason(finishReason),
    };
}

// =================================================================
// API 使用統計記錄
// =================================================================

const recordApiUsage = (chatId, inputTokens, outputTokens, modelName, requestType = 'message') => {
    try {
        const db = getDb();
        const totalTokens = inputTokens + outputTokens;
        const stmt = db.prepare(`
            INSERT INTO api_usage_stats 
            (timestamp, api_calls, input_tokens, output_tokens, total_tokens, model_name, chat_id, request_type)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(getShanghaiTime(), inputTokens, outputTokens, totalTokens, modelName, chatId, requestType);
        console.log(`recordApiUsage: ${requestType}, ${inputTokens}+${outputTokens}=${totalTokens} tokens`);
    } catch (error) {
        console.error('recordApiUsage failed:', error);
    }
};

// =================================================================
// 匯出 tiktoken encoder（供其他模組使用）
// =================================================================

function getEncoder() {
    return enc;
}

module.exports = {
    callLLM,
    callGeminiAPI,
    callOpenAICompatibleAPI,
    getEmbedding,
    getEmbeddingAPIKey,
    getLocalEmbedding,
    recordApiUsage,
    getEncoder,
    fetchWithRetry,
    getProxyDispatcher,
    needsProxy
};