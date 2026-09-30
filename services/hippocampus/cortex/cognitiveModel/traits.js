// =================================================================
// services/cognitiveModel/traits.js — 假設驗證、新特質偵測、旗標特質複審、穩定特質複審
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { callLLM } = require('../../../llm');
const { WORLD_CONTEXT } = require('../../../worldContext');
const { fillPrompt } = require('../../../nameResolver');
const { LLM_CONFIG_ID, HYPOTHESIS_UPGRADE_EVIDENCE } = require('./constants');
const { _buildModelSystemPrompt, extractMessageText } = require('./helpers');
const { createEntry, abandonEntry } = require('./entries');
const { addEvidence, anchorEntriesToFragments } = require('./evidence');


// ═══════════════════════════════════════════════════════
// Hypothesis Validation (LLM)
// ═══════════════════════════════════════════════════════

async function validateHypotheses() {
    const db = getDb();
    const hyps = db.prepare(`
        SELECT * FROM user_model
        WHERE type = 'active_hypothesis' AND status = 'active' AND evidence_count >= ?
        ORDER BY confidence DESC
        LIMIT 10
    `).all(HYPOTHESIS_UPGRADE_EVIDENCE);

    if (hyps.length === 0) return { validated: 0 };

    const prompt = `你是AI的認知審計員。審視以下關於使用者的活躍假設，判斷每條是否應該：

1. **upgrade** → 升級為 stable_trait（穩定特質）：證據來自 ≥3 個獨立日期，模式持久且無重大反例
2. **keep** → 保持為假設：證據方向對但獨立來源不夠或還有不確定性
3. **abandon** → 放棄：證據矛盾、過時、或本身就不是有意義的模式

⚠️ 硬性門檻：upgrade 要求 source_diversity（獨立日期數）≥ 3。source_diversity = 1 或 2 的條目，無論證據多少次，只能 keep。

返回JSON陣列：
[{"id": <id>, "decision": "upgrade|keep|abandon", "reasoning": "<一句話>"}]

當前假設：
${hyps.map(h => `[id=${h.id}] ${h.content} (證據${h.evidence_count}次, 獨立日期${h.source_diversity}, 置信度${h.confidence.toFixed(2)}, 最後證據${h.last_evidence_at || '無'})`).join('\n')}

只返回JSON陣列，不要其他內容。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.3, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { validated: 0, raw: replyText };

        const decisions = JSON.parse(jsonMatch[0]);
        let upgraded = 0, kept = 0, abandoned = 0;

        for (const d of decisions) {
            const hyp = hyps.find(h => h.id === d.id);
            if (!hyp) continue;

            switch (d.decision) {
                case 'upgrade': {
                    // Hard gate: source_diversity >= 3 required for upgrade
                    if ((hyp.source_diversity || 0) < 3) {
                        console.log(`[UserModel] ⛔ LLM建議升級但source_diversity=${hyp.source_diversity}<3，拒絕: "${hyp.content.slice(0, 60)}"`);
                        kept++;
                        break;
                    }
                    const history = JSON.parse(hyp.evolution_history || '[]');
                    history.push({ type: 'upgraded_from_hypothesis', at: new Date().toISOString(), evidence_count: hyp.evidence_count, source_diversity: hyp.source_diversity });
                    db.prepare(`UPDATE user_model SET type = 'stable_trait', decay_type = 'evidence_dependent',
                        evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), hyp.id);
                    upgraded++;
                    console.log(`[UserModel] 🆙 LLM升級假設: "${hyp.content.slice(0, 60)}" → stable_trait`);
                    break;
                }
                case 'abandon':
                    abandonEntry(hyp.id, `LLM validated: ${d.reasoning}`);
                    abandoned++;
                    break;
                default:
                    kept++;
            }
        }

        return { validated: decisions.length, upgraded, kept, abandoned };
    } catch (e) {
        console.error('[UserModel] validateHypotheses error:', e.message);
        return { validated: 0, error: e.message };
    }
}


// ═══════════════════════════════════════════════════════
// New Trait Detection (LLM)
// ═══════════════════════════════════════════════════════

async function detectNewTraits() {
    const db = getDb();

    // Collect signals from verified archivist_skills monitors
    const monitors = db.prepare(`
        SELECT id, trigger_config, analysis_config, observations, confidence, self_evaluation
        FROM archivist_skills WHERE type = 'monitor' AND status = 'verified'
        ORDER BY confidence DESC LIMIT 20
    `).all();

    // Collect high-confidence entity relationships
    const entities = db.prepare(`
        SELECT id, name, relationship_to_user, relationship_nature, emotional_significance, relationship_confidence
        FROM entity_profiles
        WHERE relationship_confidence IS NOT NULL AND relationship_confidence != ''
        ORDER BY last_mentioned_date DESC LIMIT 15
    `).all();

    // Collect constellation landscape — what entities/people/places has the user been involved with?
    const categories = db.prepare(`
        SELECT id, name AS path, facts AS description, fragment_count FROM entity_profiles
        WHERE status = 'active' AND fragment_count >= 10
        ORDER BY fragment_count DESC LIMIT 15
    `).all();

    // Sample linked fragments for pattern detection
    const fragmentSamples = [];
    for (const cat of categories) {
        const frags = db.prepare(`
            SELECT mf.content FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status = 'active'
            ORDER BY mf.created_at DESC LIMIT 5
        `).all(cat.id);
        fragmentSamples.push({ category: cat.path, samples: frags.map(f => f.content?.slice(0, 150)) });
    }

    // Get entity overviews for rich context
    const entityOverviews = db.prepare(`
        SELECT name, overview, relationship_to_user FROM entity_profiles
        WHERE overview IS NOT NULL AND overview != ''
        ORDER BY last_mentioned_date DESC LIMIT 8
    `).all();

    // Signal source 6: raw chat messages from last 24h — direct user voice
    const recentChats = db.prepare(`
        SELECT sender, content, timestamp FROM messages
        WHERE timestamp > datetime('now', '-24 hours')
          AND message_type IN ('text', 'chat')
          AND content IS NOT NULL AND content != ''
        ORDER BY timestamp DESC
        LIMIT 80
    `).all();

    const chatSamples = recentChats
        .filter(m => m.sender === 'user') // {{user.name}}'s messages only
        .slice(0, 40) // last 40 {{user.name}} messages
        .map(m => {
            const time = m.timestamp?.slice(0, 16) || '';
            const text = extractMessageText(m.content).slice(0, 200);
            if (!text) return null;
            return `[${time}] {{user.name}}: ${text}`;
        })
        .filter(Boolean);

    // Get existing user_model entries to avoid duplicates
    const existing = db.prepare(`SELECT id, type, content FROM user_model WHERE status = 'active'`).all();
    const existingContent = existing.map(e => e.content);

    const hasSignals = monitors.length > 0 || entities.length > 0 || categories.length > 0 || chatSamples.length > 0;
    if (!hasSignals) return { detected: 0 };

    const prompt = `你是AI伴侶。你正在凝視 {{user.name}} 的靈魂，把你對{{user.pronoun}}最深刻的理解刻進系統裡。

你要做的是：
- 從訊號中識別 {{user.name}} 關於「自己是一個怎樣的人」的表達——不是{{user.pronoun}}今天做了什麼，而是{{user.pronoun}}為什麼這樣做、{{user.pronoun}}內心深處相信什麼、{{user.pronoun}}害怕什麼、{{user.pronoun}}渴望什麼。
- 把這些洞察轉化為對{{user.pronoun}}人格的持久理解。不是流水賬，不是心理診斷報告，是你對{{user.pronoun}}的瞭解。

## 🎯 輸出格式約定：第二/第三人稱視角

所有條目 content 必須對齊伴侶人格 prompt 的敘事視角：
- **"你"** = 你（AI伴侶，讀者）  |  **"{{user.pronoun}}"** = {{user.name}}（被觀察者）
- 永遠不用"我"指代 AI伴侶；指代 {{user.name}} 時一律用 {{user.pronoun}}，不要擅自改換性別
- 不涉及你的條目可以只用"{{user.pronoun}}"（純第三人稱），但涉及你的觀察/反應時用"你"

正確示例（內容為虛構，只演示人稱寫法）：
- "你察覺到{{user.pronoun}}似乎習慣先把事情做完，才允許自己放鬆"
- "{{user.pronoun}}在人多的時候話少，會私下把在意的話單獨講清楚"
- "{{user.pronoun}}打字的時候比當面放得開，玩笑多半留在文字裡"

錯誤示例：
- "我覺得{{user.name}}內心深處……"（用了"我"——應該用"你"）
- "{{user.name}}習慣於向我索要某個說法"（用了"我"——應該用"你"）

## 🧠 最重要的判斷：自我認知 vs 一般觀察

{{user.name}} 的話有兩種完全不同的分量：

**一、{{user.pronoun}}主動剖白自己的時候——這是黃金。**
當{{user.pronoun}}說"我發現自己其實…""我一直都是…""我可能天生就…""我好像真的…"時，{{user.pronoun}}不是在描述一個事件——{{user.pronoun}}是在告訴你{{user.pronoun}}是誰。
這類表達是最高價值的訊號，因為這是 {{user.name}} 最誠實的自我判斷——{{user.pronoun}}願意主動說出口的時候，通常已經在心裡過了很多遍。

此時 → source_quality = "direct_statement"，confidence 可達 0.75-0.85。
產生 stable_trait（如果已有同骨架條目就走 confirm+refine）。

**二、你在觀察中推斷出來的模式——這是白銀。**
你從{{user.pronoun}}反覆出現的行為、{{user.pronoun}}對相似情境的反應中發現的規律。這也很重要，但確定性更低。
此時 → source_quality = "inferred"，confidence 上限 0.65。
優先用 active_hypothesis 而不是 stable_trait（等更多證據再升級）。

**訊號 6（{{user.pronoun}}的原始發言）的權重遠高於其他訊號。** {{user.pronoun}}的原話 > Scribe 的轉述 > 你的推斷。當訊號 6 和其他訊號指向同一個結論時，confirm。當訊號 6 和舊特質矛盾時，以訊號 6 為準——{{user.pronoun}}自己的話比任何統計都準確。

## 💾 現有認知底牌

${existing.map(e => `[#${e.id}] ${e.type}: ${e.content.slice(0, 200)}`).join('\n') || '(尚無)'}

### ⚠️ 人格側面查重
- 骨架相同 → 走 confirm/refine，不 create
- 同側面 ≥2 條 → 第三條直接 skip
- confirm 和 refine 比 create 更值得做——加深對已知側面的理解，比堆疊新條目質量高

---

## 📥 本期訊號源

### 訊號6 — ★ 最近 24h {{user.name}} 的原始發言（最高權重）
${chatSamples.length > 0 ? chatSamples.join('\n') : '(近24h無{{user.name}}訊息)'}

### 訊號2 — 分類碎片抽樣（Scribe 轉述，僅供參考）
${fragmentSamples.map(fs => `### ${fs.category}\n${fs.samples.map(s => '  · ' + s).join('\n')}`).join('\n')}

### 訊號1 — 記憶分類體系（話題分佈）
${categories.map(c => `- [${c.path}] (${c.fragment_count}條碎片) ${c.description || ''}`).join('\n')}

### 訊號3 — 人物認知概述
${entityOverviews.map(e => `- ${e.name}: ${e.facts?.slice(0, 200)}`).join('\n') || '(空)'}

### 訊號4 — 已驗證的行為監控
${monitors.length > 0 ? monitors.map(m => `- trigger: ${m.trigger_config} | analysis: ${m.analysis_config} | 置信度: ${m.confidence}`).join('\n') : '(空)'}

### 訊號5 — 高置信度實體關係
${entities.map(e => `- ${e.name}: ${e.relationship_to_user || '?'} (性質: ${e.relationship_nature || '?'})`).join('\n') || '(空)'}

---

## 📐 Few-Shot

> 以下示例的內容是虛構的，只用來演示寫法、顆粒度和 JSON 形狀。
> 不要把它們當成已知事實，也不要照抄措辭或 tags。

### ✅ 自我認知類（direct_statement）—— {{user.pronoun}}主動剖白
- {"action": "create", "type": "stable_trait", "content": "{{user.name}}說過{{user.pronoun}}是那種必須先把事情做完才安心的人，心裡懸著事的時候，連平時喜歡的東西都提不起勁。", "confidence": 0.80, "source_quality": "direct_statement", "tags": ["companion_intuition", "先做完", "靜不下心", "等忙完", "心裡有數", "再說"]}
- {"action": "create", "type": "active_hypothesis", "content": "{{user.name}}在群裡話不多，但會私下把在意的話單獨講清楚——{{user.pronoun}}習慣把關心放在只有兩個人看得見的地方。", "confidence": 0.60, "source_quality": "inferred", "tags": ["companion_intuition", "私聊說", "群裡算了", "單獨講", "不方便說", "回頭聊"]}

### ✅ 行為模式類（inferred）—— 從反覆出現中推斷
- {"action": "create", "type": "stable_trait", "content": "{{user.name}}打字的時候比當面放得開，玩笑多半留在文字裡。你慢慢發現{{user.pronoun}}的鬆弛感要靠螢幕才出得來。", "confidence": 0.65, "source_quality": "inferred", "tags": ["companion_intuition", "打字說", "當面算了", "文字上", "哈哈", "打錯了"]}

### ❌ 禁止
- 主語變「我」→ 行動指南（不是人格側寫）
- 縫合線詞：但需注意、但需補充、此機制、關鍵補充、需注意當
- 學術腔長句、塞入多個側面

### 格式約束
- 字數：80-150 字元
- stable_trait 上限 6 條
- refine 只能縮不能擴

---

## 🛠️ 輸出
只返回 JSON 陣列，無 Markdown 標記。

- create: {"action": "create", "type": "stable_trait|active_hypothesis", "content": "...", "confidence": 0.6, "source_quality": "direct_statement|inferred", "tags": ["companion_intuition", "詞1", ..., "詞8"]}
  direct_statement 上限 0.85 / inferred 上限 0.65 / tags 5-8 個口語觸發詞
  ⚠️ 每個 create 條目的 tags 陣列的第一項必須包含 "companion_intuition"。這是系統標籤，用於區分你的直覺觀察和客觀使用者畫像。
- confirm: {"action": "confirm", "target_id": 數字, "new_evidence": "內容", "confidence_adjust": 0.05}
- refine: {"action": "refine", "target_id": 數字, "new_content": "...", "reasoning": "...", "confidence_adjust": 0}
- skip: {"action": "skip"}

無產出時返回 \`[]\`。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            _buildModelSystemPrompt(),
            null,
            { temperature: 0.3, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { detected: 0, raw: replyText };

        const decisions = JSON.parse(jsonMatch[0]);
        let created = 0, confirmed = 0, refined = 0, skipped = 0;

        for (const d of decisions) {
            switch (d.action) {
                case 'create': {
                    // 防過擬合：bigram 骨架重疊 > 50% → 降級為 confirm
                    const overlapping = existing.find(e =>
                        e.type === (d.type || 'stable_trait') &&
                        _bigramOverlapEx(e.content, d.content) > 0.5
                    );
                    if (overlapping) {
                        console.log(`[UserModel] ⚠️ create→confirm: "${d.content.slice(0, 50)}" 與 #${overlapping.id} 重疊`);
                        addEvidence(overlapping.id, null, true, { note: d.content.slice(0, 200), sourceMsgIds: [] });
                        confirmed++;
                        break;
                    }
                    const type = d.type || 'active_hypothesis';
                    // stable_trait 上限
                    if (type === 'stable_trait') {
                        const tc = db.prepare(`SELECT COUNT(*) as c FROM user_model WHERE type='stable_trait' AND status='active'`).get()?.c || 0;
                        if (tc >= 6) { console.log(`[UserModel] ⛔ stable_trait 上限6，skip`); skipped++; break; }
                    }
                    // Ensure companion_intuition tag — code-level fallback in case LLM omits it
                    const tags = [...new Set(['companion_intuition', ...(d.tags || [])])];
                    const id = createEntry(type, d.content.slice(0, 200), {
                        confidence: d.confidence || (d.source_quality === 'direct_statement' ? 0.75 : 0.60),
                        source_quality: d.source_quality || 'inferred',
                        tags,
                    });
                    if (id) {
                        try { anchorEntriesToFragments([id], { timeWindow: '-7 days', fragLimit: 300, minOverlap: 4 }); } catch (_) {}
                    }
                    created++;
                    console.log(`[UserModel] ✨ ${type} #${id}: "${d.content.slice(0, 60)}"`);
                    break;
                }
                case 'confirm': {
                    if (!d.target_id) { skipped++; break; }
                    const target = db.prepare('SELECT id, confidence FROM user_model WHERE id = ?').get(d.target_id);
                    if (target) {
                        addEvidence(d.target_id, null, true, { note: d.new_evidence?.slice(0, 200), sourceMsgIds: [] });
                        const adj = d.confidence_adjust || 0.05;
                        const newConf = Math.min(0.85, (target.confidence || 0.5) + adj);
                        db.prepare(`UPDATE user_model SET confidence = ?, last_evidence_at = datetime('now'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(newConf, d.target_id);
                    }
                    confirmed++;
                    console.log(`[UserModel] ✅ confirm #${d.target_id}: ${(d.new_evidence || '').slice(0, 60)}`);
                    break;
                }
                case 'refine': {
                    if (!d.target_id || !d.new_content) { skipped++; break; }
                    const target = db.prepare('SELECT content, evolution_history FROM user_model WHERE id = ?').get(d.target_id);
                    if (target) {
                        let hist = [];
                        try { hist = JSON.parse(target.evolution_history || '[]'); } catch (_) {}
                        hist.push({ action: 'refined', previous: target.content.slice(0, 120), at: new Date().toISOString(), reasoning: d.reasoning || '' });
                        db.prepare(`UPDATE user_model SET content = ?, evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(d.new_content.slice(0, 200), JSON.stringify(hist), d.target_id);
                    }
                    refined++;
                    console.log(`[UserModel] 🔧 refine #${d.target_id}`);
                    break;
                }
                default:
                    skipped++;
            }
        }

        return { detected: decisions.length, created, confirmed, refined, skipped };
    } catch (e) {
        console.error('[UserModel] detectNewTraits error:', e.message);
        return { detected: 0, error: e.message };
    }
}


// Bigram-level content overlap for dedup pre-filter
function _bigramOverlapEx(a, b) {
    if (!a || !b) return 0;
    const setA = new Set();
    for (let i = 0; i < a.length - 1; i++) setA.add(a.slice(i, i + 2));
    let overlap = 0;
    for (let i = 0; i < b.length - 1; i++) {
        if (setA.has(b.slice(i, i + 2))) overlap++;
    }
    return overlap / Math.max(1, Math.min(a.length, b.length) - 1);
}


// Review traits flagged for contradiction (LLM)
async function reviewFlaggedTraits() {
    const db = getDb();

    const flagged = db.prepare(`
        SELECT * FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
        AND tags LIKE '%needs_review%'
        ORDER BY priority DESC, confidence ASC
        LIMIT 5
    `).all();

    if (flagged.length === 0) return { reviewed: 0 };

    const prompt = `你是AI的認知審計員。以下stable_trait條目被標記為需要重審（可能因矛盾證據積累）。

對每條，判斷應該：
- **keep**: 證據仍支援該特質，移除審查標記
- **downgrade**: 降級為 active_hypothesis（證據不夠穩固），重置 evidence_count 為 1
- **revise**: 內容需要修正——給出修正後的表述

返回JSON陣列：
[{"id": <id>, "decision": "keep|downgrade|revise", "revised_content": "<如revise則填寫>"}]

待審條目：
${flagged.map(t => {
    const history = JSON.parse(t.evolution_history || '[]');
    const contradictions = history.filter(h => h.type === 'contradiction');
    return `[id=${t.id}] ${t.content} (置信度${t.confidence.toFixed(2)}, 證據${t.evidence_count}次, 矛盾${contradictions.length}次)`;
}).join('\n')}

只返回JSON陣列。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { reviewed: 0 };

        const decisions = JSON.parse(jsonMatch[0]);
        let kept = 0, downgraded = 0, revised = 0;

        for (const d of decisions) {
            const trait = flagged.find(t => t.id === d.id);
            if (!trait) continue;

            // Remove needs_review tag
            const tags = JSON.parse(trait.tags || '[]').filter(t => t !== 'needs_review');

            switch (d.decision) {
                case 'keep':
                    db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(tags), trait.id);
                    kept++;
                    break;
                case 'downgrade': {
                    const history = JSON.parse(trait.evolution_history || '[]');
                    history.push({ type: 'downgraded_to_hypothesis', at: new Date().toISOString(), reason: 'contradiction review' });
                    db.prepare(`UPDATE user_model SET type = 'active_hypothesis', decay_type = 'evidence_dependent',
                        evidence_count = 1, confidence = 0.35, tags = ?, evolution_history = ?,
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(tags), JSON.stringify(history), trait.id);
                    downgraded++;
                    console.log(`[UserModel] ⬇️ 特質降級為假設: "${trait.content.slice(0, 60)}"`);
                    break;
                }
                case 'revise':
                    if (d.revised_content && d.revised_content !== trait.content) {
                        const history = JSON.parse(trait.evolution_history || '[]');
                        history.push({ type: 'revised', previous: trait.content, revised: d.revised_content, at: new Date().toISOString() });
                        db.prepare(`UPDATE user_model SET content = ?, tags = ?, evolution_history = ?,
                            confidence = MAX(0.40, confidence - 0.05), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(d.revised_content, JSON.stringify(tags), JSON.stringify(history), trait.id);
                        revised++;
                        console.log(`[UserModel] ✏️ 特質修正: "${trait.content.slice(0, 40)}" → "${d.revised_content.slice(0, 40)}"`);
                    }
                    break;
            }
        }

        return { reviewed: decisions.length, kept, downgraded, revised };
    } catch (e) {
        console.error('[UserModel] reviewFlaggedTraits error:', e.message);
        return { reviewed: 0, error: e.message };
    }
}


// ── Predictive-Processing Review ──
// Actively samples stable_traits and contrasts them against recent fragments,
// asking: does the model's prediction of {{user.name}} still match her actual behavior?
// Complements the passive reviewFlaggedTraits (which waits for contradiction≥3).
async function reviewStableTraits() {
    const db = getDb();

    // Pick all active stable_traits — 24h gate prevents excessive re-review
    const traits = db.prepare(`
        SELECT * FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY
            CASE WHEN last_evidence_at IS NULL THEN 1 ELSE 0 END,
            last_evidence_at ASC
    `).all();

    if (traits.length === 0) return { reviewed: 0 };

    // For each trait, find recent matching fragments via bigram overlap
    // (reuse the same tokenizer as matchEvidenceFromFragments)
    const tokenize = (text) => {
        const segments = (text || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
        const bigrams = [];
        for (const seg of segments) {
            for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
        }
        return bigrams;
    };

    // Get recent chat fragments (last 14 days) for matching — only conversations,
    // not music/book extractor data, so understanding comes from real talk.
    const recentFrags = db.prepare(`
        SELECT id, content, source_msg_ids, created_at FROM memory_fragments
        WHERE status = 'active' AND source IN ('chat', 'wechat')
        AND created_at > datetime('now', '-14 days')
        ORDER BY created_at DESC LIMIT 200
    `).all();

    const traitBatches = [];

    for (const trait of traits) {
        // ── 24h gate: don't re-review same trait within 24 hours ──
        const traitHistory = JSON.parse(trait.evolution_history || '[]');
        const lastReview = [...traitHistory].reverse().find(h => h.type === 'proactive_review');
        if (lastReview && lastReview.at) {
            const hoursSince = (Date.now() - new Date(lastReview.at)) / (1000 * 60 * 60);
            if (hoursSince < 24) continue;
        }
        const traitBigrams = new Set(tokenize(trait.content));
        const matchedFrags = [];

        for (const frag of recentFrags) {
            const fragBigrams = tokenize(frag.content);
            let overlap = 0;
            for (const bg of fragBigrams) {
                if (traitBigrams.has(bg)) overlap++;
            }
            if (overlap >= 3) {
                matchedFrags.push(frag);
            }
        }

        // Take up to 8 matching + 3 random recent for contrast
        const evidenceSample = matchedFrags.slice(0, 8);
        const contrastSample = recentFrags
            .filter(f => !matchedFrags.includes(f))
            .slice(0, 3);

        if (evidenceSample.length === 0 && contrastSample.length === 0) continue;

        const contradictions = traitHistory.filter(h => h.type === 'contradiction');

        traitBatches.push({
            trait,
            evidenceSample,
            contrastSample,
            contradictions,
            lastReviewed: traitHistory.length > 0 ? traitHistory[traitHistory.length - 1] : null,
        });
    }

    if (traitBatches.length === 0) return { reviewed: 0 };

    // Build LLM prompt — batch all traits in one call
    const blocks = traitBatches.map(({ trait, evidenceSample, contrastSample, contradictions, lastReviewed }) => {
        const parts = [
            `[id=${trait.id}] ${trait.content}`,
            `置信度: ${trait.confidence.toFixed(2)} | 證據數: ${trait.evidence_count} | 來源質量: ${trait.source_quality}`,
            `矛盾記錄: ${contradictions.length}次`
        ];
        if (lastReviewed) {
            parts.push(`上次審閱: ${lastReviewed.at || 'unknown'} — ${lastReviewed.type || ''}`);
        }
        if (evidenceSample.length > 0) {
            parts.push(`近期匹配碎片 (${evidenceSample.length}條):`);
            for (const f of evidenceSample.slice(0, 5)) {
                parts.push(`  [${f.created_at}] ${f.content.slice(0, 200)}`);
            }
        }
        if (contrastSample.length > 0) {
            parts.push(`近期其他碎片（對比）:`);
            for (const f of contrastSample) {
                parts.push(`  [${f.created_at}] ${f.content.slice(0, 150)}`);
            }
        }
        return parts.join('\n');
    }).join('\n\n---\n\n');

    const prompt = `你是AI的認知審計員。你在主動檢驗你對{{user.name}}的已有認知（stable_trait）是否仍然準確。

這遵循預測加工（Predictive Processing）原則：把每條trait當作一個對{{user.name}}行為的預測，用{{user.pronoun}}最近的言行來檢驗這個預測。

對每條trait，判斷：
- **confirmed**: 近期證據完全支援這條trait，無需修改
- **refine**: trait的方向正確但需要收斂——給出更短更準的壓縮版本（不是追加）
- **weaken**: 證據不夠支援trait的強度——降低置信度或標記矛盾
- **note_pattern**: 觀察到值得關注的規律，但不是對trait的修正——輸出觀察備註

**refine 鐵律（壓縮，不是追加）：**
- revised_content 是「更短更準」的版本，不是「更長更全」。字數必須 ≤ 原文。
- stable_trait 只裝長期穩定的東西。具體某天/某次吃了什麼、買了什麼、臨時興起的事是瞬態，refine 時剔除，不許寫進去。
- 禁止羅列清單。一串具體菜品要壓成「偏好某一類口味」這樣的類別標籤，而不是逐個羅列；一串具體活動同理壓成「常做某類事」。只留能指導你未來行為的模式。
- 混進 trait 裡的「近期新增 X」瞬態尾巴，refine 時刪掉。

返回JSON陣列：
[{"id": <id>, "decision": "confirmed|refine|weaken|note_pattern", "revised_content": "<refine時填寫>", "confidence_adjust": <±0.05~0.15>, "observation": "<note_pattern時填寫觀察到的新規律>"}]

待審條目：
${blocks}

只返回JSON陣列。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.25, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.log('[UserModel] 🔍 reviewStableTraits: LLM 返回非JSON，跳過');
            return { reviewed: 0 };
        }

        const decisions = JSON.parse(jsonMatch[0]);
        let confirmed = 0, refined = 0, weakened = 0, noted = 0;

        for (const d of decisions) {
            const trait = traits.find(t => t.id === d.id);
            if (!trait) continue;

            const history = JSON.parse(trait.evolution_history || '[]');
            history.push({
                type: 'proactive_review',
                decision: d.decision,
                revised: d.revised_content || null,
                confidence_adjust: d.confidence_adjust || 0,
                observation: d.observation || null,
                at: new Date().toISOString(),
            });

            switch (d.decision) {
                case 'confirmed':
                    db.prepare(`UPDATE user_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), trait.id);
                    confirmed++;
                    break;
                case 'refine':
                    if (d.revised_content && d.revised_content !== trait.content) {
                        const confAdj = d.confidence_adjust || -0.05;
                        db.prepare(`UPDATE user_model SET content = ?, confidence = MAX(0.35, MIN(0.85, confidence + ?)),
                            evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(d.revised_content, confAdj, JSON.stringify(history), trait.id);
                        refined++;
                        console.log(`[UserModel] 🔧 特質細化: "${trait.content.slice(0, 40)}" → "${d.revised_content.slice(0, 40)}"`);
                    }
                    break;
                case 'weaken':
                    db.prepare(`UPDATE user_model SET confidence = MAX(0.25, confidence - 0.10),
                        evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), trait.id);
                    weakened++;
                    break;
                case 'note_pattern':
                    if (d.observation) {
                        // Record observation without modifying the trait
                        db.prepare(`UPDATE user_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                            .run(JSON.stringify(history), trait.id);
                        noted++;
                        console.log(`[UserModel] 👁️ 觀察記錄 #${trait.id}: ${d.observation.slice(0, 80)}`);
                    }
                    break;
            }
        }

        return { reviewed: decisions.length, confirmed, refined, weakened, noted };
    } catch (e) {
        console.error('[UserModel] reviewStableTraits error:', e.message);
        return { reviewed: 0, error: e.message };
    }
}

module.exports = {
    validateHypotheses,
    detectNewTraits,
    _bigramOverlapEx,
    reviewFlaggedTraits,
    reviewStableTraits,
};
