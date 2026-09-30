// =================================================================
// 智慧上下文構建 + 健康資料簡報
// =================================================================

const fs = require('fs');
const { searchMemoriesByHardTrigger } = require('./memory');
const { getUserSetting } = require('../utils/settings');
const { fillPrompt, USER, AI } = require('./nameResolver');
const { getTriggeredIntuition } = require('./intuition');
const { getMemoryTokenBudget, estimateTokens, takeWithinBudget, splitEntityBlocks } = require('./memoryBudget');
const { toTraditionalChars } = require('../utils/zhNormalize');

// =================================================================
// 健康資料簡報生成器
// =================================================================

function generateHealthSummary(fullHealthStatus) {
    try {
        // 健康資料檔可能是簡體或繁體：逐字簡轉繁後再比對（一對一，不改長度），下方標籤一律用繁體寫法
        const lines = toTraditionalChars(fullHealthStatus).split('\n');

        // 1. 睡眠時間段
        //    檔案格式：'   時間段：04-01 01:45 → 04-01 08:24'
        //    舊正則只匹配 HH:MM → HH:MM，遇到日期字首會失敗
        const sleepTimeLine = lines.find(l => l.includes('時間段：'));
        let sleepTime = '未知';
        if (sleepTimeLine) {
            const timeMatch = sleepTimeLine.match(/(\d{2}-\d{2} \d{2}:\d{2}) → (\d{2}-\d{2} \d{2}:\d{2})/);
            if (timeMatch) {
                sleepTime = `${timeMatch[1]}入睡 → ${timeMatch[2]}醒來`;
            }
        }

        // 2. 睡眠總時長 + 效率
        const sleepLine = lines.find(l => l.includes('總時長：'));
        const sleepMatch = sleepLine ? sleepLine.match(/(\d+) 分鐘 \(([\d.]+) 小時\)/) : null;
        const sleepHours = sleepMatch ? sleepMatch[2] : '未知';

        const efficiencyLine = lines.find(l => l.includes('睡眠效率：'));
        const efficiency = efficiencyLine ? efficiencyLine.match(/(\d+)%/)?.[1] : '未知';

        // 3. 靜息心率（帶趨勢）
        const restingHRLine = lines.find(l => l.includes('靜息心率：') && l.includes('bpm') && l.includes('基線'));
        let restingHRDisplay = '未知';
        if (restingHRLine) {
            const hrMatch = restingHRLine.match(/靜息心率：(\d+) bpm.*基線：(\d+) bpm/);
            if (hrMatch) {
                const current = parseInt(hrMatch[1]);
                const baseline = parseInt(hrMatch[2]);
                const diff = current - baseline;
                const trend = diff > 2 ? '↑' : diff < -2 ? '↓' : '→';
                restingHRDisplay = `${current}${trend}`;
            } else {
                const simpleMatch = restingHRLine.match(/靜息心率：(\d+) bpm/);
                restingHRDisplay = simpleMatch ? simpleMatch[1] : '未知';
            }
        }

        // 4. HRV
        //    檔案格式：'   HRV：35.359 ms (深睡HRV：36.141 ms)'
        //    舊過濾條件 !l.includes('深睡HRV') 會把這行也排除掉，因為它同時包含兩者
        //    改為 trimStart().startsWith('HRV：') 精確匹配行首
        const hrvLine = lines.find(l => l.trimStart().startsWith('HRV：'));
        const hrv = hrvLine ? hrvLine.match(/HRV：([\d.]+) ms/)?.[1] : '未知';

        // 5. 步數（前日活動資料）
        const stepsLine = lines.find(l => l.includes('步數：') && l.includes('步'));
        let stepsInfo = '步數未知';
        if (stepsLine) {
            const stepsMatch = stepsLine.match(/步數：(\d+) 步/);
            if (stepsMatch) stepsInfo = `活動步數${stepsMatch[1]}步`;
        }

        // 異常判斷
        const isLowHRV      = !isNaN(parseFloat(hrv))        && parseFloat(hrv)        < 25;
        const isShortSleep  = !isNaN(parseFloat(sleepHours)) && parseFloat(sleepHours) < 6;
        const isPoorEff     = !isNaN(parseFloat(efficiency))  && parseFloat(efficiency) < 85;
        const isPoorSleep   = isShortSleep || isPoorEff;

        let summary = fillPrompt(`【{user}健康資料（可穿戴裝置日均，非即時）】`);
        if (isLowHRV || isPoorSleep) {
            const issues = [];
            if (isShortSleep) issues.push(`睡眠不足（${sleepHours}h）`);
            if (isPoorEff)    issues.push(`睡眠效率偏低（${efficiency}%）`);
            if (isLowHRV)     issues.push(`HRV偏低（${hrv}ms）`);
            summary += `狀態需關注 - ${issues.join('，')}。`;
        } else {
            summary += `狀態正常。`;
        }

        // 注意：靜息心率是可穿戴裝置當天的昨日均值，不是當下即時心率
        summary += `\n昨晚${sleepTime}，共${sleepHours}h（效率${efficiency}%）；` +
                   `靜息心率${restingHRDisplay}bpm（昨日均值，非當下即時）；` +
                   `HRV ${hrv}ms；${stepsInfo}（前日）。`;

        return summary;
    } catch (error) {
        console.error('generateHealthSummary failed:', error);
        return USER.name + '健康資料讀取中...';
    }
}

// =================================================================
// 極簡版Context構建 (v3.2 - 天氣快取 + 日曆快取)
// =================================================================

async function buildSmartContext(userMessage, healthStatus, skipVectorMemory = false) {
    let estimatedTokens = 0;

    // === 穩定部分 ===
    let corePrompt = fs.readFileSync('core-prompt.txt', 'utf8');

    // v5.0: 核心洞察段 — deep cycle 產出，{{user.name}} 可編輯，始終在 system prompt 中
    const coreInsight = (await getUserSetting('user_core_insight')) || '';
    corePrompt = corePrompt.replace('{{CORE_INSIGHT}}', coreInsight || '（你正在學習理解{{user.pronoun}}——長期觀察中的認知將逐漸在這裡形成。）');

    estimatedTokens += Math.ceil(corePrompt.length / 4);

    // === 動態部分 ===
    const dynamicParts = [];

    // 記憶區塊（硬觸發 + Librarian + 實體檔案）共用一份 token 預算，依序先到先得，
    // 超出時整條丟棄（不切斷單條記憶）。見 services/memoryBudget.js。
    let memoryBudgetLeft = getMemoryTokenBudget();

    // 硬觸發記憶
    if (userMessage && !skipVectorMemory) {
        let hardMatches = searchMemoriesByHardTrigger(userMessage);
        {
            const r = takeWithinBudget(hardMatches, memoryBudgetLeft, m => estimateTokens(m.content) + 8);
            if (r.dropped > 0) console.log(`buildSmartContext: hard trigger 超出記憶預算，丟棄 ${r.dropped} 條`);
            memoryBudgetLeft -= r.used;
            hardMatches = r.kept;
        }
        if (hardMatches.length > 0) {
            dynamicParts.push('<relevant_memories>');
            dynamicParts.push('Thinking Process: 檢測到關鍵詞，已從冥想盆調取相關記憶：');
            hardMatches.forEach((mem) => {
                let tags = [];
                try { tags = JSON.parse(mem.tags); } catch(e){}
                const hitTag = tags.find(t => userMessage.includes(t)) || 'unknown';
                dynamicParts.push(`※ 相關記憶 #${mem.id}`);
                dynamicParts.push(`${mem.content}`);
                dynamicParts.push('');
                estimatedTokens += Math.ceil(mem.content.length / 4);
            });
            dynamicParts.push('</relevant_memories>');
            // 更新記憶最後訪問時間（供生命週期衰減使用）
            try {
                const db = require('../database').getDb();
                const touch = db.prepare("UPDATE memories SET last_accessed_at = datetime('now') WHERE id = ?");
                hardMatches.forEach(m => { try { touch.run(m.id); } catch (_) {} });
            } catch (_) {}
            console.log(`buildSmartContext: hard trigger injected ${hardMatches.length} memories`);
        }
    }

    // Librarian：混合檢索（FTS5 + 向量語義）
    if (userMessage && !skipVectorMemory) {
        try {
            const { searchHybrid, formatHybridContext } = require('./librarian');
            const { getEntityContext } = require('./entityProfile');
            let libFragments = await searchHybrid(userMessage, 8);
            {
                // 每條另加約 10 token 的標題行（許可權/編號/天數）
                const r = takeWithinBudget(libFragments, memoryBudgetLeft, f => estimateTokens(f.content) + 10);
                if (r.dropped > 0) console.log(`buildSmartContext: librarian 超出記憶預算，丟棄 ${r.dropped} 條`);
                memoryBudgetLeft -= r.used;
                libFragments = r.kept;
            }
            const libText = formatHybridContext(libFragments);
            if (libText) {
                dynamicParts.push(`<memory_context>
[已儲存記憶庫 — 以下是你自己的記憶，不是${USER.name}剛說的新資訊]

每條記憶標註了「引用許可權」和「距今時間」：

【可引用】→ 確定的事實，可以直接引用
【需謹慎】→ 用"我印象裡""好像是……"開頭，留糾正空間
【僅聯想】→ 僅供你自己聯想參考，不要當作確定事實告訴${USER.name}。如果想提，說"我好像突然想起……但不太確定"

時間感覺：
- 15天以內 → "最近"
- 1-3個月 → "之前"或"有一陣了"
- 超過3個月 → 別表現出剛發生的感覺

關於糾正：如果${USER.name}說"不對"或"不是那次"，接受${USER.pronoun}的糾正，不要搬出記憶庫辯解——記憶庫本來就是碎片化的，${USER.pronoun}比你清楚。
${libText}
</memory_context>`);
                estimatedTokens += Math.ceil(libText.length / 4);
                console.log(`buildSmartContext: hybrid librarian injected ${libFragments.length} fragments`);

                // 話題工作記憶池：注入後將 top fragments 加入工作記憶
                try {
                  const { updatePool } = require('./workingMemory');
                  updatePool(libFragments);
                } catch (e) {
                  console.error('WorkingMemory updatePool failed:', e.message);
                }

                // 實體檔案：如果檢索命中涉及已知實體，補充最新近況
                try {
                    let entityCtx = getEntityContext(libFragments);
                    if (entityCtx) {
                        const r = takeWithinBudget(splitEntityBlocks(entityCtx), memoryBudgetLeft, b => estimateTokens(b));
                        if (r.dropped > 0) console.log(`buildSmartContext: entity 超出記憶預算，丟棄 ${r.dropped} 份檔案`);
                        memoryBudgetLeft -= r.used;
                        entityCtx = r.kept.join('\n');
                    }
                    if (entityCtx) {
                        dynamicParts.push(`<entity_context>\n以下是記憶中涉及人物的最新近況（來自${AI.name}的記憶檔案）：\n${entityCtx}\n</entity_context>`);
                        estimatedTokens += Math.ceil(entityCtx.length / 4);
                    }
                } catch (_) {}
            }
        } catch (e) {
            console.error('Librarian注入失敗:', e.message);
        }
    }

    // Saga 不再通過長沉默全量注入。
    // Sagas 現在通過 getEntityContext() 按實體關聯注入 ——
    // 當 Companion 在對話中遇到某個星座實體時，自動展示相關的敘事弧線。

    // User Intuition — context-triggered cognitive intuition
    // Keyword-first matching: only injects traits/hypotheses whose tags match the conversation.
    // immutable_facts and current_state are always included (token cost is minimal).
    // Returns { text, signals } — signals forwarded to Jiwen for parameter tuning.
    try {
        const intuitionResult = getTriggeredIntuition(userMessage, 500);
        if (intuitionResult && intuitionResult.text) {
            dynamicParts.push(intuitionResult.text);
            estimatedTokens += Math.ceil(intuitionResult.text.length / 1.5);
        }
        // Forward triggered signals to Jiwen
        if (intuitionResult && intuitionResult.signals && intuitionResult.signals.length > 0) {
            try {
                const stateService = require('./state');
                stateService.processIntuitionSignals(intuitionResult.signals);
            } catch (e) {
                console.error('Intuition→Jiwen signal bridge failed:', e.message);
            }
        }
    } catch (e) {
        console.error('UserIntuition injection failed:', e.message);
    }

    // 人格關係層（G3）：已套用的關係層 + confidence ≥ 0.7 的穩定特質，最多 5 行，獨立小預算
    try {
        const relCtx = require('./persona').buildRelationshipContext();
        if (relCtx) { dynamicParts.push(relCtx); estimatedTokens += Math.ceil(relCtx.length / 4); }
    } catch (e) { console.error('人格關係層注入失敗:', e.message); }

    // 健康簡報
    const healthSummary = generateHealthSummary(healthStatus);
    dynamicParts.push(`<health_status>\n${healthSummary}\n</health_status>`);
    estimatedTokens += Math.ceil(healthSummary.length / 4);

    // 天氣快取（由 proactive.js 或 cron.js 寫入，此處只讀）
    // LLM 看到時間戳後可自行判斷是否需要調工具獲取更新資料
    try {
        const weatherCacheSetting = await getUserSetting('weather_cache');
        if (weatherCacheSetting?.value && weatherCacheSetting.value !== 'null') {
            const wCache = JSON.parse(weatherCacheSetting.value);
            if (wCache.summary && wCache.updated_at) {
                const updatedAt = new Date(wCache.updated_at).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
                const weatherText = `獲取於${updatedAt}\n${wCache.summary}`;
                dynamicParts.push(`<weather_info>\n${weatherText}\n</weather_info>`);
                estimatedTokens += Math.ceil(weatherText.length / 4);
            }
        }
    } catch(e) { /* 忽略 */ }

    // 日曆快取（今天+明天）
    try {
        const calCacheSetting = await getUserSetting('calendar_cache');
        if (calCacheSetting?.value && calCacheSetting.value !== 'null') {
            const cache = JSON.parse(calCacheSetting.value);
            const calText = `${cache.today}\n${cache.tomorrow}`;
            dynamicParts.push(`<calendar_schedule>\n${calText}\n</calendar_schedule>`);
            estimatedTokens += Math.ceil(calText.length / 4);
        }
    } catch(e) { /* 忽略 */ }

    // 行動日誌注入：最近自主行為記錄（按 tick 分組，一個 tick = 一輪）
    try {
        const db = require('../database').getDb();
        const BEHAVIORAL_TYPES = ['contact','read_book','browse_snitch','post_snitch','observation_only','search','people_watch','play_radio'];
        // 拉最近 20 條，按 tick_id 分組後取最後 5 個 tick
        const logs = db.prepare(`
            SELECT tick_id, decision_type, intent, observation, reason, timestamp
            FROM companion_inner_log
            WHERE decision_type IN (${BEHAVIORAL_TYPES.map(() => '?').join(',')})
            ORDER BY id DESC LIMIT 20
        `).all(...BEHAVIORAL_TYPES);
        if (logs.length > 0) {
            const TYPE_LABELS = {
                browse_snitch: '刷Snitch', read_book: '讀書',
                search: '搜尋', contact: '主動開口', observation_only: '觀察',
                people_watch: '人類觀察', play_radio: '推歌', post_snitch: '發動態',
            };

            // 按 tick_id 分組（先反轉 → 最早在前 → Map 保留時間順序）
            // 每組保留 action 標籤 + 關鍵內容（搜尋反思/動態正文/觀察念頭）
            const tickMap = new Map();
            const logsAsc = [...logs].reverse();
            for (const l of logsAsc) {
                const tid = l.tick_id || `_notick_${l.timestamp}`;
                if (!tickMap.has(tid)) {
                    tickMap.set(tid, { timestamp: l.timestamp, entries: [] });
                }
                const group = tickMap.get(tid);
                // 每種動作只取第一個（去重）
                if (!group.entries.some(e => e.type === l.decision_type)) {
                    const label = TYPE_LABELS[l.decision_type] || l.decision_type;
                    let detail = '';
                    if (l.decision_type === 'search') {
                        detail = l.intent ? `搜${l.intent}` : '';
                        if (l.observation) detail += ` → ${l.observation.slice(0, 120)}`;
                    } else if (l.decision_type === 'observation_only' && l.observation) {
                        detail = l.observation.slice(0, 100);
                    } else if (l.decision_type === 'post_snitch' && l.observation) {
                        detail = l.observation.slice(0, 100);
                    } else if (l.decision_type === 'play_radio' && l.intent) {
                        detail = l.intent; // 歌名 — 歌手
                    } else if (l.decision_type === 'people_watch' && l.observation) {
                        detail = l.observation.slice(0, 100);
                    } else if (l.reason) {
                        detail = l.reason.slice(0, 80);
                    }
                    group.entries.push({ type: l.decision_type, label, detail });
                }
                if (l.timestamp > group.timestamp) group.timestamp = l.timestamp;
            }

            // 取最後 5 個 tick
            const tickGroups = [...tickMap.entries()].slice(-5);

            const lines = tickGroups.map(([tid, group]) => {
                const time = new Date(group.timestamp).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
                const actionLabels = group.entries.map(e => e.label);
                const header = `[${time}] ${actionLabels.join(' → ')}`;
                const details = group.entries
                    .filter(e => e.detail)
                    .map(e => `  ${e.label}：${e.detail}`);
                return [header, ...details].join('\n');
            });
            const logText = `你最近的活動記錄（同一輪 = 同一段，縮排內容是每步的具體資訊）:\n${lines.join('\n')}`;
            dynamicParts.push(`<recent_activity>\n${logText}\n</recent_activity>`);
            estimatedTokens += Math.ceil(logText.length / 4);
        }
    } catch(e) { console.error('行動日誌注入失敗:', e.message); }

    return {
        stableContext: corePrompt,
        dynamicContext: dynamicParts.join('\n'),
        tokenCount: estimatedTokens
    };
}

module.exports = { generateHealthSummary, buildSmartContext };