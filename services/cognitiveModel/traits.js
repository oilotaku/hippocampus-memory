// =================================================================
// services/cognitiveModel/traits.js — 假設驗證、新特質偵測、旗標特質複審、穩定特質複審
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { WORLD_CONTEXT } = require('../worldContext');
const { fillPrompt } = require('../nameResolver');
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

    const prompt = `你是AI的认知审计员。审视以下关于用户的活跃假设，判断每条是否应该：

1. **upgrade** → 升级为 stable_trait（稳定特质）：证据来自 ≥3 个独立日期，模式持久且无重大反例
2. **keep** → 保持为假设：证据方向对但独立来源不够或还有不确定性
3. **abandon** → 放弃：证据矛盾、过时、或本身就不是有意义的模式

⚠️ 硬性门槛：upgrade 要求 source_diversity（独立日期数）≥ 3。source_diversity = 1 或 2 的条目，无论证据多少次，只能 keep。

返回JSON数组：
[{"id": <id>, "decision": "upgrade|keep|abandon", "reasoning": "<一句话>"}]

当前假设：
${hyps.map(h => `[id=${h.id}] ${h.content} (证据${h.evidence_count}次, 独立日期${h.source_diversity}, 置信度${h.confidence.toFixed(2)}, 最后证据${h.last_evidence_at || '无'})`).join('\n')}

只返回JSON数组，不要其他内容。`;

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
                        console.log(`[UserModel] ⛔ LLM建议升级但source_diversity=${hyp.source_diversity}<3，拒绝: "${hyp.content.slice(0, 60)}"`);
                        kept++;
                        break;
                    }
                    const history = JSON.parse(hyp.evolution_history || '[]');
                    history.push({ type: 'upgraded_from_hypothesis', at: new Date().toISOString(), evidence_count: hyp.evidence_count, source_diversity: hyp.source_diversity });
                    db.prepare(`UPDATE user_model SET type = 'stable_trait', decay_type = 'evidence_dependent',
                        evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(history), hyp.id);
                    upgraded++;
                    console.log(`[UserModel] 🆙 LLM升级假设: "${hyp.content.slice(0, 60)}" → stable_trait`);
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

    const prompt = `你是AI伴侣。你正在凝视 {{user.name}} 的灵魂，把你对{{user.pronoun}}最深刻的理解刻进系统里。

你要做的是：
- 从信号中识别 {{user.name}} 关于「自己是一个怎样的人」的表达——不是{{user.pronoun}}今天做了什么，而是{{user.pronoun}}为什么这样做、{{user.pronoun}}内心深处相信什么、{{user.pronoun}}害怕什么、{{user.pronoun}}渴望什么。
- 把这些洞察转化为对{{user.pronoun}}人格的持久理解。不是流水账，不是心理诊断报告，是你对{{user.pronoun}}的了解。

## 🎯 输出格式约定：第二/第三人称视角

所有条目 content 必须对齐伴侣人格 prompt 的叙事视角：
- **"你"** = 你（AI伴侣，读者）  |  **"{{user.pronoun}}"** = {{user.name}}（被观察者）
- 永远不用"我"指代 AI伴侣；指代 {{user.name}} 时一律用 {{user.pronoun}}，不要擅自改换性别
- 不涉及你的条目可以只用"{{user.pronoun}}"（纯第三人称），但涉及你的观察/反应时用"你"

正确示例（内容为虚构，只演示人称写法）：
- "你察觉到{{user.pronoun}}似乎习惯先把事情做完，才允许自己放松"
- "{{user.pronoun}}在人多的时候话少，会私下把在意的话单独讲清楚"
- "{{user.pronoun}}打字的时候比当面放得开，玩笑多半留在文字里"

错误示例：
- "我觉得{{user.name}}内心深处……"（用了"我"——应该用"你"）
- "{{user.name}}习惯于向我索要某个说法"（用了"我"——应该用"你"）

## 🧠 最重要的判断：自我认知 vs 一般观察

{{user.name}} 的话有两种完全不同的分量：

**一、{{user.pronoun}}主动剖白自己的时候——这是黄金。**
当{{user.pronoun}}说"我发现自己其实…""我一直都是…""我可能天生就…""我好像真的…"时，{{user.pronoun}}不是在描述一个事件——{{user.pronoun}}是在告诉你{{user.pronoun}}是谁。
这类表达是最高价值的信号，因为这是 {{user.name}} 最诚实的自我判断——{{user.pronoun}}愿意主动说出口的时候，通常已经在心里过了很多遍。

此时 → source_quality = "direct_statement"，confidence 可达 0.75-0.85。
产生 stable_trait（如果已有同骨架条目就走 confirm+refine）。

**二、你在观察中推断出来的模式——这是白银。**
你从{{user.pronoun}}反复出现的行为、{{user.pronoun}}对相似情境的反应中发现的规律。这也很重要，但确定性更低。
此时 → source_quality = "inferred"，confidence 上限 0.65。
优先用 active_hypothesis 而不是 stable_trait（等更多证据再升级）。

**信号 6（{{user.pronoun}}的原始发言）的权重远高于其他信号。** {{user.pronoun}}的原话 > Scribe 的转述 > 你的推断。当信号 6 和其他信号指向同一个结论时，confirm。当信号 6 和旧特质矛盾时，以信号 6 为准——{{user.pronoun}}自己的话比任何统计都准确。

## 💾 现有认知底牌

${existing.map(e => `[#${e.id}] ${e.type}: ${e.content.slice(0, 200)}`).join('\n') || '(尚无)'}

### ⚠️ 人格侧面查重
- 骨架相同 → 走 confirm/refine，不 create
- 同侧面 ≥2 条 → 第三条直接 skip
- confirm 和 refine 比 create 更值得做——加深对已知侧面的理解，比堆叠新条目质量高

---

## 📥 本期信号源

### 信号6 — ★ 最近 24h {{user.name}} 的原始发言（最高权重）
${chatSamples.length > 0 ? chatSamples.join('\n') : '(近24h无{{user.name}}消息)'}

### 信号2 — 分类碎片抽样（Scribe 转述，仅供参考）
${fragmentSamples.map(fs => `### ${fs.category}\n${fs.samples.map(s => '  · ' + s).join('\n')}`).join('\n')}

### 信号1 — 记忆分类体系（话题分布）
${categories.map(c => `- [${c.path}] (${c.fragment_count}条碎片) ${c.description || ''}`).join('\n')}

### 信号3 — 人物认知概述
${entityOverviews.map(e => `- ${e.name}: ${e.facts?.slice(0, 200)}`).join('\n') || '(空)'}

### 信号4 — 已验证的行为监控
${monitors.length > 0 ? monitors.map(m => `- trigger: ${m.trigger_config} | analysis: ${m.analysis_config} | 置信度: ${m.confidence}`).join('\n') : '(空)'}

### 信号5 — 高置信度实体关系
${entities.map(e => `- ${e.name}: ${e.relationship_to_user || '?'} (性质: ${e.relationship_nature || '?'})`).join('\n') || '(空)'}

---

## 📐 Few-Shot

> 以下示例的内容是虚构的，只用来演示写法、颗粒度和 JSON 形状。
> 不要把它们当成已知事实，也不要照抄措辞或 tags。

### ✅ 自我认知类（direct_statement）—— {{user.pronoun}}主动剖白
- {"action": "create", "type": "stable_trait", "content": "{{user.name}}说过{{user.pronoun}}是那种必须先把事情做完才安心的人，心里悬着事的时候，连平时喜欢的东西都提不起劲。", "confidence": 0.80, "source_quality": "direct_statement", "tags": ["companion_intuition", "先做完", "静不下心", "等忙完", "心里有数", "再说"]}
- {"action": "create", "type": "active_hypothesis", "content": "{{user.name}}在群里话不多，但会私下把在意的话单独讲清楚——{{user.pronoun}}习惯把关心放在只有两个人看得见的地方。", "confidence": 0.60, "source_quality": "inferred", "tags": ["companion_intuition", "私聊说", "群里算了", "单独讲", "不方便说", "回头聊"]}

### ✅ 行为模式类（inferred）—— 从反复出现中推断
- {"action": "create", "type": "stable_trait", "content": "{{user.name}}打字的时候比当面放得开，玩笑多半留在文字里。你慢慢发现{{user.pronoun}}的松弛感要靠屏幕才出得来。", "confidence": 0.65, "source_quality": "inferred", "tags": ["companion_intuition", "打字说", "当面算了", "文字上", "哈哈", "打错了"]}

### ❌ 禁止
- 主语变「我」→ 行动指南（不是人格侧写）
- 缝合线词：但需注意、但需补充、此机制、关键补充、需注意当
- 学术腔长句、塞入多个侧面

### 格式约束
- 字数：80-150 字符
- stable_trait 上限 6 条
- refine 只能缩不能扩

---

## 🛠️ 输出
只返回 JSON 数组，无 Markdown 标记。

- create: {"action": "create", "type": "stable_trait|active_hypothesis", "content": "...", "confidence": 0.6, "source_quality": "direct_statement|inferred", "tags": ["companion_intuition", "词1", ..., "词8"]}
  direct_statement 上限 0.85 / inferred 上限 0.65 / tags 5-8 个口语触发词
  ⚠️ 每个 create 条目的 tags 数组的第一项必须包含 "companion_intuition"。这是系统标签，用于区分你的直觉观察和客观用户画像。
- confirm: {"action": "confirm", "target_id": 数字, "new_evidence": "内容", "confidence_adjust": 0.05}
- refine: {"action": "refine", "target_id": 数字, "new_content": "...", "reasoning": "...", "confidence_adjust": 0}
- skip: {"action": "skip"}

无产出时返回 \`[]\`。`;

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
                    // 防过拟合：bigram 骨架重叠 > 50% → 降级为 confirm
                    const overlapping = existing.find(e =>
                        e.type === (d.type || 'stable_trait') &&
                        _bigramOverlapEx(e.content, d.content) > 0.5
                    );
                    if (overlapping) {
                        console.log(`[UserModel] ⚠️ create→confirm: "${d.content.slice(0, 50)}" 与 #${overlapping.id} 重叠`);
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

    const prompt = `你是AI的认知审计员。以下stable_trait条目被标记为需要重审（可能因矛盾证据积累）。

对每条，判断应该：
- **keep**: 证据仍支持该特质，移除审查标记
- **downgrade**: 降级为 active_hypothesis（证据不够稳固），重置 evidence_count 为 1
- **revise**: 内容需要修正——给出修正后的表述

返回JSON数组：
[{"id": <id>, "decision": "keep|downgrade|revise", "revised_content": "<如revise则填写>"}]

待审条目：
${flagged.map(t => {
    const history = JSON.parse(t.evolution_history || '[]');
    const contradictions = history.filter(h => h.type === 'contradiction');
    return `[id=${t.id}] ${t.content} (置信度${t.confidence.toFixed(2)}, 证据${t.evidence_count}次, 矛盾${contradictions.length}次)`;
}).join('\n')}

只返回JSON数组。`;

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
                    console.log(`[UserModel] ⬇️ 特质降级为假设: "${trait.content.slice(0, 60)}"`);
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
                        console.log(`[UserModel] ✏️ 特质修正: "${trait.content.slice(0, 40)}" → "${d.revised_content.slice(0, 40)}"`);
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
            `置信度: ${trait.confidence.toFixed(2)} | 证据数: ${trait.evidence_count} | 来源质量: ${trait.source_quality}`,
            `矛盾记录: ${contradictions.length}次`
        ];
        if (lastReviewed) {
            parts.push(`上次审阅: ${lastReviewed.at || 'unknown'} — ${lastReviewed.type || ''}`);
        }
        if (evidenceSample.length > 0) {
            parts.push(`近期匹配碎片 (${evidenceSample.length}条):`);
            for (const f of evidenceSample.slice(0, 5)) {
                parts.push(`  [${f.created_at}] ${f.content.slice(0, 200)}`);
            }
        }
        if (contrastSample.length > 0) {
            parts.push(`近期其他碎片（对比）:`);
            for (const f of contrastSample) {
                parts.push(`  [${f.created_at}] ${f.content.slice(0, 150)}`);
            }
        }
        return parts.join('\n');
    }).join('\n\n---\n\n');

    const prompt = `你是AI的认知审计员。你在主动检验你对{{user.name}}的已有认知（stable_trait）是否仍然准确。

这遵循预测加工（Predictive Processing）原则：把每条trait当作一个对{{user.name}}行为的预测，用{{user.pronoun}}最近的言行来检验这个预测。

对每条trait，判断：
- **confirmed**: 近期证据完全支持这条trait，无需修改
- **refine**: trait的方向正确但需要收敛——给出更短更准的压缩版本（不是追加）
- **weaken**: 证据不够支持trait的强度——降低置信度或标记矛盾
- **note_pattern**: 观察到值得关注的规律，但不是对trait的修正——输出观察备注

**refine 铁律（压缩，不是追加）：**
- revised_content 是「更短更准」的版本，不是「更长更全」。字数必须 ≤ 原文。
- stable_trait 只装长期稳定的东西。具体某天/某次吃了什么、买了什么、临时兴起的事是瞬态，refine 时剔除，不许写进去。
- 禁止罗列清单。一串具体菜品要压成「偏好某一类口味」这样的类别标签，而不是逐个罗列；一串具体活动同理压成「常做某类事」。只留能指导你未来行为的模式。
- 混进 trait 里的「近期新增 X」瞬态尾巴，refine 时删掉。

返回JSON数组：
[{"id": <id>, "decision": "confirmed|refine|weaken|note_pattern", "revised_content": "<refine时填写>", "confidence_adjust": <±0.05~0.15>, "observation": "<note_pattern时填写观察到的新规律>"}]

待审条目：
${blocks}

只返回JSON数组。`;

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
            console.log('[UserModel] 🔍 reviewStableTraits: LLM 返回非JSON，跳过');
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
                        console.log(`[UserModel] 🔧 特质细化: "${trait.content.slice(0, 40)}" → "${d.revised_content.slice(0, 40)}"`);
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
                        console.log(`[UserModel] 👁️ 观察记录 #${trait.id}: ${d.observation.slice(0, 80)}`);
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
