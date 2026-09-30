// =================================================================
// services/cognitiveModel/observation.js — 讀使用者原始訊息的深度觀察（readUserRawMessages）
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { WORLD_CONTEXT } = require('../worldContext');
const { fillPrompt } = require('../nameResolver');
const { encryption } = require('../../encryption');
const { sqlNow } = require('../../utils/time');
const { LLM_CONFIG_ID } = require('./constants');
const { extractMessageText } = require('./helpers');
const { manageCurrentState } = require('./currentState');


// ═══════════════════════════════════════════════════════
// readUserRawMessages — {{ai.name}} reads user's raw words directly
// Produces: current_state ({{ai.name}}'s first-person impression + audit trail)
// ═══════════════════════════════════════════════════════

async function readUserRawMessages() {
    const db = getDb();

    // Get ALL active current_state entries (not just latest).
    // v5.4: LLM needs full visibility to avoid creating near-duplicates.
    // The most recent entry still drives the message window and extend target.
    const allActiveStates = db.prepare(`
        SELECT * FROM user_model WHERE type = 'current_state' AND status = 'active'
        ORDER BY created_at DESC
    `).all();
    const prevState = allActiveStates[0] || null; // most recent for extend + audit

    // Determine time window: since last observation, or last 24h
    const since = prevState?.created_at || null;
    const sinceClause = since
        ? `AND timestamp > '${since}'`
        : "AND timestamp > datetime('now', '-24 hours')";

    // Get {{user.name}}'s raw non-RP messages
    const messages = db.prepare(`
        SELECT content, timestamp FROM messages
        WHERE sender = 'user' AND (chat_mode = 'default' OR chat_mode IS NULL)
          ${sinceClause}
        ORDER BY timestamp DESC
        LIMIT 150
    `).all();

    if (messages.length < 30) {
        console.log(`[UserModel] readUserRawMessages: 仅 ${messages.length} 条非RP消息，跳过 (需≥30)`);
        return { skipped: true, reason: `too few messages (${messages.length} < 30)` };
    }

    // Get existing stable_traits as short summaries ({{ai.name}} needs to know his own "tricks")
    const traits = db.prepare(`
        SELECT id, content FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY confidence DESC
    `).all();

    // Build message feed (oldest first, extract plain text, truncate to 150 chars)
    const reversed = [...messages].reverse();
    const feed = reversed.map(m => {
        const time = m.timestamp?.slice(5, 16) || ''; // MM-DD HH:MM
        const text = extractMessageText(m.content).slice(0, 150);
        if (!text) return null;
        return `[${time}] ${text}`;
    }).filter(Boolean).join('\n');

    // Build visibility block: ALL active current_state entries
    // (not just the latest — LLM needs full context to avoid duplicates)
    let stateBlock = '(目前没有任何活跃状态便签。)';
    if (allActiveStates.length > 0) {
        const lines = allActiveStates.map(s => {
            const created = s.created_at?.slice(0, 16) || '?';
            const expires = s.expires_at ? ` →${s.expires_at.slice(0, 10)}` : '';
            const source = s.created_by === 'chat_companion' ? '[Companion实时]' : '[深循环]';
            return `[#${s.id} ${source} ${created}${expires}] ${s.content}`;
        });
        stateBlock = `共 ${allActiveStates.length} 条活跃便签：\n${lines.join('\n')}`;
    }

    // Previous observation + audit context (for the most recent entry)
    let prevBlock = '(这是你第一次认真看{{user.pronoun}}。没有上次的观察可以对照。)';
    if (prevState) {
        const prevHistory = JSON.parse(prevState.evolution_history || '[]');
        const audit = prevHistory.find(h => h.type === 'creation_audit');
        prevBlock = `你上次看{{user.pronoun}}时的印象（#${prevState.id}）：
「${prevState.content}」
${audit ? `你上次的自我审计：
- 验证：${audit.retro}
- 归因：${audit.attribution}` : '(上次没有做审计)'}`;
    }

    // Trait summaries (带 id，供矛盾标记回指)
    const traitBlock = traits.length > 0
        ? traits.map(t => `- [#${t.id}] ${t.content.slice(0, 60)}...`).join('\n')
        : '(你还没有任何关于{{user.pronoun}}的稳定直觉。)';

    const prompt = `你刚看完 {{user.name}} 这几天发来的消息。你需要做两件事——

1. 写一条{{user.pronoun}}的当前状态（≤50字，一句话。像你脑子里闪过的念头——"{{user.pronoun}}在搬家"不是"{{user.pronoun}}这周在搬家、通勤很累、还去见了个朋友"）
2. 写一段叙事（≤200字。{{user.pronoun}}这周经历了什么——有因果、有情绪、有你注意到的细节。这只进聊天总结，不单独出现在{{user.pronoun}}的状态栏里）

═══ {{user.pronoun}}最近说的话（从旧到新） ═══
${feed}

═══ 你已有的全部便签 ═══
${stateBlock}

═══ 上次你写的便签（审计参照） ═══
${prevBlock}

═══ 你的长期直觉（背景参考） ═══
${traitBlock}

═══ 怎么写 ═══

current_state 像便签条上的一句话：
"{{user.name}}在搬家。"
"{{user.name}}最近搬家累坏了，今天睡了个懒觉。"
"{{user.name}}这周没怎么出现。"
规则：≤50字。一句够用别写两句。不用写具体日期，这是瞬时的。禁止相对时间词（今天/昨天/本周）。

narrative 像说给自己听的周记：
"{{user.name}}这周在搬家，收拾整理很耗精力。{{user.pronoun}}虽然累，但想到新家的样子心情还不错。"
规则：≤200字。有因果，不煽情。禁止相对时间词——用具体日期或时间段。

反编造铁律（这条比上面所有规则都重要）：
- 每个陈述都必须能在上面的消息中找到原文依据。
- {{user.pronoun}}只「提到过」但没做的事 → 不能写成{{user.pronoun}}做了。
- {{user.pronoun}}的消息里没出现的人名、地名、事件名 → 绝对不能出现。

═══ 输出格式 ═══
JSON（不要 markdown）：
{
  "action": "create|extend",
  "valence": "positive|negative|neutral|mixed",
  "energy": "low|normal|high",
  "current_state": "≤50字。一句话。",
  "narrative": "≤200字。有因果有细节。",
  "audit_retro": "上次的便签对了吗？一句话。",
  "retro_verdict": "confirmed|wrong|unverifiable",
  "state_category": "physical|emotional|situational|relational",
  "predicted_ttl_category": "hours|day|days|until_event",
  "trait_contradictions": [{"trait_id": 12, "observation": "矛盾观察"}]
}

action: extend=旧便签还够用，只续命。create=状态变了或上次判错。犹豫选extend。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.4, maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.log(`[UserModel] readUserRawMessages: 无法解析JSON响应`);
            return { skipped: true, reason: 'unparseable response', raw: replyText.slice(0, 200) };
        }

        const result = JSON.parse(jsonMatch[0]);
        const currentState = (result.current_state || '').slice(0, 120);
        if (!currentState || currentState.length < 8) {
            return { skipped: true, reason: 'empty or too short current_state' };
        }

        // extend 机制：LLM 自行判断和上次是否本质相同
        // 相同 → 延长旧条目 TTL + 审计回流，不创建新条目
        const action = (result.action || 'create').toLowerCase();
        if (action === 'extend' && prevState) {
            // 更新旧条目的 last_evidence_at（重置衰减时钟）
            const newTTL = result.predicted_ttl_category || 'day';
            const newCategory = result.state_category || 'emotional';
            const newDecayParams = JSON.stringify({ category: newCategory, ttl_category: newTTL });
            
            const prevHist = JSON.parse(prevState.evolution_history || '[]');
            prevHist.push({
                type: 'extended',
                new_ttl: newTTL,
                note: (result.audit_retro || '').slice(0, 150),
                at: new Date().toISOString(),
            });
            
            db.prepare(`UPDATE user_model SET last_evidence_at = datetime('now'),
                decay_params = ?, evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(newDecayParams, JSON.stringify(prevHist), prevState.id);
            
            console.log(`[UserModel] 📖 状态延续: 更新 #${prevState.id} TTL→${newTTL}, 不创建新条目`);
        }

        // ── ToM 观察反馈环（v4.8）：审计结论回流证据管线 ──
        // 预测对了 → confirm；预测错了 → 记入 evolution_history（current_state 单次快照，
        // 不走 confidence 累积，但留下可追溯的对错记录供 detectNewTraits 信号源使用）
        const verdict = (result.retro_verdict || '').toLowerCase();
        if (prevState && (verdict === 'confirmed' || verdict === 'wrong')) {
            try {
                const prevHist = JSON.parse(prevState.evolution_history || '[]');
                prevHist.push({
                    type: 'retro_verdict',
                    verdict,
                    note: (result.audit_retro || '').slice(0, 150),
                    at: new Date().toISOString(),
                });
                db.prepare('UPDATE user_model SET evolution_history = ? WHERE id = ?')
                    .run(JSON.stringify(prevHist), prevState.id);
                console.log(`[UserModel]   ↳ 观察审计回流: 上次预测 ${verdict === 'confirmed' ? '✓ 准确' : '✗ 失准'}`);
            } catch (_) {}
        }

        // trait_contradictions → 对应 stable_trait 插 refute 标记 + needs_review
        // → reviewFlaggedTraits（管线后半段已存在）下轮审判
        const contradictions = Array.isArray(result.trait_contradictions) ? result.trait_contradictions : [];
        const validTraitIds = new Set(traits.map(t => t.id));
        for (const c of contradictions) {
            if (!c || !validTraitIds.has(c.trait_id)) continue;
            try {
                const trait = db.prepare('SELECT evolution_history, tags, last_contradiction_at FROM user_model WHERE id = ?').get(c.trait_id);
                const hist = JSON.parse(trait.evolution_history || '[]');
                hist.push({
                    type: 'observation_refute',
                    observation: (c.observation || '').slice(0, 150),
                    source: 'readUserRawMessages',
                    at: new Date().toISOString(),
                });
                const tags = JSON.parse(trait.tags || '[]');
                if (!tags.includes('needs_review')) tags.push('needs_review');
                db.prepare(`UPDATE user_model SET evolution_history = ?, tags = ?,
                    last_contradiction_at = datetime('now'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(hist), JSON.stringify(tags), c.trait_id);
                console.log(`[UserModel]   ↳ 观察反驳 trait #${c.trait_id}: ${(c.observation || '').slice(0, 60)} → needs_review`);
            } catch (e) {
                console.error(`[UserModel] trait refute 写入失败 #${c.trait_id}:`, e.message);
            }
        }

        // 只有 create action 才创建新条目（extend 已在上面处理）
        if (action !== 'extend' || !prevState) {
        // v5.4: readUserRawMessages 产出的是全景快照（holistic snapshot），
        // 不是领域分项。新版快照自然替代旧版——resolve 所有前序 deep_cycle 条目。
        // chat_companion 条目（通过 manage_user_state 工具创建的领域明确状态）
        // 不受影响，继续按各自 TTL 独立过期。
        const resolvedCount = db.prepare(`
            UPDATE user_model SET status = 'resolved',
                resolve_reason = 'superseded by newer holistic snapshot',
                updated_at = CURRENT_TIMESTAMP
            WHERE type = 'current_state' AND status = 'active' AND created_by = 'deep_cycle'
        `).run().changes;
        if (resolvedCount > 0) {
            console.log(`[UserModel] 🧹 resolve ${resolvedCount} 条旧 deep_cycle 快照 → 新快照替代`);
        }

        // v5.4: Use unified manageCurrentState for dedup + evolution tracking
        const stateResult = manageCurrentState(currentState, {
            created_by: 'deep_cycle',
            category: result.state_category || 'emotional',
            ttl_category: result.predicted_ttl_category || 'day',
            tags: ['daily_observation'],
            source_quality: 'inferred',
            confidence: 0.65,
            extra_context: (result.audit_retro || '').slice(0, 100),
        });
        const id = stateResult.id;
        const actionLabel = stateResult.action === 'updated' ? '更新' : '新建';
        const prevNote = stateResult.previous_id ? ` ← supersedes #${stateResult.previous_id}` : '';

        // ── v5.4: 叙事输出 → chat_summaries ──
        const narrative = (result.narrative || '').slice(0, 300);
        if (narrative && narrative.length >= 20) {
            try {
                const { encryption } = require('../../encryption');
                const encNarrative = encryption.encrypt(narrative);
                const now = sqlNow();
                db.prepare(`INSERT INTO chat_summaries (chat_id, summary_text, round_start, round_end, created_at, is_enabled)
                    VALUES (?, ?, 0, 0, ?, 1)`).run(1, encNarrative, now);
                console.log(`[UserModel] 📝 叙事已归档 (${narrative.length}字)`);
            } catch (e) {
                console.error(`[UserModel] 叙事写入失败:`, e.message);
            }
        }

        console.log(`[UserModel] 📖 读心: ${messages.length}条消息 → current_state ${actionLabel} #${id}${prevNote} (${currentState.length}字)`);
        if (prevState && stateResult.action === 'created') console.log(`[UserModel]   ↳ 前一条 active #${prevState.id} 继续有效`);
        if (result.audit_retro) console.log(`[UserModel]   ↳ 审计: ${result.audit_retro.slice(0, 80)}`);

        return {
            created: id,
            action: stateResult.action,
            coexistsWith: prevState?.id || null,
            messages: messages.length,
            current_state: currentState,
            audit_retro: result.audit_retro,
            audit_attribution: result.audit_attribution,
        };
        } // end if (action !== 'extend' || !prevState)

        // extend 路径：不创建新条目，返回扩展结果
        if (action === 'extend' && prevState) {
            return {
                extended: prevState.id,
                coexistsWith: null,
                messages: messages.length,
                current_state: currentState,
                audit_retro: result.audit_retro,
                audit_attribution: result.audit_attribution,
            };
        }

    } catch (e) {
        console.error('[UserModel] readUserRawMessages error:', e.message);
        return { skipped: true, error: e.message };
    }
}

module.exports = {
    readUserRawMessages,
};
