// =================================================================
// User Model — 四层认知模型
//
// 维护 AI 对用户的内部认知，四层：
//   immutable_fact   — 不变事实，永不衰减，仅明确纠正修改
//   stable_trait     — 稳定特质，证据积累精细化，矛盾≥3降级重审
//   current_state    — 当前状态，指数衰减(7天半衰期)，14天无证据自动 resolved
//   active_hypothesis — 活跃假设，3次确认→升级为 trait，14天无证据→abandoned
//
// 职责：CRUD、证据管理、衰减处理、假设验证、新特质检测、上下文注入
// =================================================================

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { WORLD_CONTEXT } = require('./worldContext');
const { fillPrompt, USER, AI } = require('./nameResolver');
const { encryption } = require('../encryption');
const { getCompanionPersonaBase } = require('./companionPersona');
const { sqlNow, sqlTimeAhead, DAY_MS } = require('../utils/time');
// ── W7 拆分進行中：以下名稱已搬到 services/cognitiveModel/ ──
const { LLM_CONFIG_ID, MIN_GAP_USER_MODEL } = require('./cognitiveModel/constants');
const { extractMessageText, safeParseJson } = require('./cognitiveModel/helpers');
const { createEntry, updateEntry, resolveEntry, abandonEntry, supersedeEntry, correctEntry } = require('./cognitiveModel/entries');
const { addEvidence, matchEvidenceFromFragments, anchorEntriesToFragments, seedAnchorOrphanEntries, harvestFacts, backfillModelEvidence, bridgeStarMapToModel } = require('./cognitiveModel/evidence');
const { processModelDecay, resolveExpiredStates } = require('./cognitiveModel/decay');
const { manageCurrentState } = require('./cognitiveModel/currentState');
const { validateHypotheses, detectNewTraits, reviewFlaggedTraits, reviewStableTraits } = require('./cognitiveModel/traits');
const { getModelContext, getWhisperRelevant } = require('./cognitiveModel/context');
const { seedFromExisting } = require('./cognitiveModel/migration');

// ═══════════════════════════════════════════════════════
// v5.0: Cross-Reference — current_state ↔ entity_profiles + stable_trait
// Zero-LLM matching. Flags contradictions for LLM review in later phases.
// ═══════════════════════════════════════════════════════

function crossRefStateWithEntities() {
    const db = getDb();
    const changes = { entityFlags: 0, traitFlags: 0, stateConflicts: 0 };

    // ── 1. Get all active current_state entries ──
    const states = db.prepare(`
        SELECT id, content, created_by FROM user_model
        WHERE type = 'current_state' AND status = 'active'
    `).all();
    if (states.length === 0) return changes;

    // ── 2. Get all entity names and aliases ──
    const entities = db.prepare(`
        SELECT id, name, aliases, overview FROM entity_profiles
        WHERE name IS NOT NULL AND status IN ('active', 'seed')
    `).all();

    // ── 3. For each current_state, match mentioned entities ──
    for (const s of states) {
        const contentLower = s.content.toLowerCase();
        const matchedEntities = [];

        for (const e of entities) {
            if (contentLower.includes(e.name.toLowerCase())) {
                matchedEntities.push(e);
                continue;
            }
            let aliasList = [];
            try { aliasList = JSON.parse(e.aliases || '[]'); } catch (_) {}
            if (aliasList.some(a => a && a.length >= 2 && contentLower.includes(a.toLowerCase()))) {
                matchedEntities.push(e);
            }
        }

        // ── 3a. Flag entities without facts ──
        for (const e of matchedEntities) {
            if (!e.facts || e.facts.trim().length === 0) {
                // Entity exists but has no overview — log for manual/scheduled review
                changes.entityFlags++;
                console.log(`[UserModel] 🔍 crossref: entity "${e.name}" 无 overview — 需要建档案（当前无法自动创建，请手动审核）`);
            }
        }
    }

    // ── 4. Cross current_state conflict detection ──
    // v5.4: Check ALL pairs regardless of source. Same-source duplicates
    // (e.g. two chat_companion entries about the same thing) are also flagged.
    // Deep_cycle duplicates should be prevented by readUserRawMessages resolve,
    // but this provides defense in depth.
    for (let i = 0; i < states.length; i++) {
        for (let j = i + 1; j < states.length; j++) {
            const a = states[i], b = states[j];

            // Simple overlap check: content word overlap > 50%
            const wordsA = new Set(a.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2));
            const wordsB = b.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2);
            const overlap = wordsB.filter(w => wordsA.has(w)).length;
            const overlapRatio = overlap / Math.max(wordsB.length, 1);
            if (overlapRatio > 0.5) {
                // Flag both for review (any source)
                const tagsA = db.prepare('SELECT tags FROM user_model WHERE id = ?').get(a.id);
                const tagsB = db.prepare('SELECT tags FROM user_model WHERE id = ?').get(b.id);
                const ta = (() => { try { return JSON.parse(tagsA?.tags || '[]'); } catch (_) { return []; } })();
                const tb = (() => { try { return JSON.parse(tagsB?.tags || '[]'); } catch (_) { return []; } })();
                if (!ta.includes('needs_review')) { ta.push('needs_review'); }
                if (!tb.includes('needs_review')) { tb.push('needs_review'); }
                db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(ta), a.id);
                db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(JSON.stringify(tb), b.id);
                changes.stateConflicts++;
                const sameSource = a.created_by === b.created_by ? ' (同源)' : '';
                console.log(`[UserModel] ⚔️ crossref: current_state #${a.id} (${a.created_by}) ↔ #${b.id} (${b.created_by}) 主题重叠${sameSource} → needs_review`);
            }
        }
    }

    // ── 5. current_state ↔ stable_trait bigram overlap ──
    const traits = db.prepare(`
        SELECT id, content FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
    `).all();

    for (const s of states) {
        for (const t of traits) {
            const wordsS = new Set(s.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2));
            const wordsT = t.content.split(/[\s，。！？、]+/).filter(w => w.length >= 2);
            const overlap = [...wordsT].filter(w => wordsS.has(w)).length;
            // Bigram overlap
            const segS = new Set();
            const segT = new Set();
            const rawS = s.content.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(x => x.length >= 2);
            const rawT = t.content.replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(x => x.length >= 2);
            for (const seg of rawS) for (let k = 0; k < seg.length - 1; k++) segS.add(seg.slice(k, k + 2));
            for (const seg of rawT) for (let k = 0; k < seg.length - 1; k++) segT.add(seg.slice(k, k + 2));
            let bgOverlap = 0;
            for (const bg of segT) { if (segS.has(bg)) bgOverlap++; }
            if (bgOverlap >= 5) {
                const tags = db.prepare('SELECT tags FROM user_model WHERE id = ?').get(s.id);
                const currentTags = (() => { try { return JSON.parse(tags?.tags || '[]'); } catch (_) { return []; } })();
                if (!currentTags.includes('needs_review')) {
                    currentTags.push('needs_review');
                    db.prepare(`UPDATE user_model SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(JSON.stringify(currentTags), s.id);
                    changes.traitFlags++;
                    console.log(`[UserModel] 🔗 crossref: current_state #${s.id} ↔ trait #${t.id} bigram=${bgOverlap} → needs_review`);
                }
            }
        }
    }

    if (changes.entityFlags + changes.traitFlags + changes.stateConflicts > 0) {
        console.log(`[UserModel] crossref 完成: entity=${changes.entityFlags} trait=${changes.traitFlags} conflicts=${changes.stateConflicts}`);
    }
    return changes;
}

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
                const { encryption } = require('../encryption');
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

// ═══════════════════════════════════════════════════════
// v5.10: Integrate verified traits into {{user.name}} profile
// ═══════════════════════════════════════════════════════

const PROFILE_TIERS = {
    locked:  { categories: ['basic'],                                        minDiversity: Infinity, allowCreate: false, allowRefine: false },
    high:    { categories: ['personality', 'communication'],                 minDiversity: 5,        allowCreate: false, allowRefine: true  },
    medium:  { categories: ['career', 'social', 'personal_history', 'relationship_with_companion', 'creative_work'], minDiversity: 3, allowCreate: true, allowRefine: true },
    low:     { categories: ['preference', 'lifestyle', 'health', 'finance'], minDiversity: 1,        allowCreate: true,  allowRefine: true },
};

function _getProfileTier(category) {
    for (const [name, tier] of Object.entries(PROFILE_TIERS)) {
        if (tier.categories.includes(category)) return { name, ...tier };
    }
    return { name: 'low', ...PROFILE_TIERS.low }; // default: low stability
}

/**
 * 画像写入协议：在 detectNewTraits / reviewStableTraits 产出新 trait 后，
 * 加载全量 User 画像做门禁检查，按稳定性分级写入。
 * @returns {{ integrated: number, rejected: number, conflicts: number }}
 */
async function integrateProfileTraits() {
    const db = getDb();
    const result = { integrated: 0, rejected: 0, conflicts: 0 };

    // 1. 加载全量 User 画像（12分类全部 active 条目）
    const profileEntries = db.prepare(`
        SELECT id, type, content, confidence, tags, evidence_count, source_diversity,
               source_quality, source_fragment_ids, evolution_history, status
        FROM user_model
        WHERE status IN ('active', 'dormant')
          AND type IN ('stable_trait', 'active_hypothesis')
        ORDER BY confidence DESC
    `).all();

    // 2. 只处理 source_diversity 达标的 candidate（刚 detectNewTraits/reviewStableTraits 产出或修改的）
    const candidates = profileEntries.filter(e => {
        if (e.status !== 'active') return false;
        // Check if this entry was recently created/modified (within last 6h)
        // We track this by checking if it lacks a profile_integrated marker in evolution_history
        let history = [];
        try { history = JSON.parse(e.evolution_history || '[]'); } catch (_) {}
        const alreadyIntegrated = history.some(h => h.action === 'profile_integrated');
        return !alreadyIntegrated && e.source_diversity >= 2 && e.confidence >= 0.55;
    });

    if (!candidates.length) return result;

    // 3. 对每个候选条目按稳定性分级处理
    for (const candidate of candidates) {
        let tags = [];
        try { tags = typeof candidate.tags === 'string' ? JSON.parse(candidate.tags) : (candidate.tags || []); } catch (_) {}

        // Determine primary category from tags
        const CATEGORY_ORDER = ['basic','personality','career','social','preference','lifestyle','health','creative_work','personal_history','relationship_with_companion','finance','communication'];
        let category = 'other';
        for (const cat of CATEGORY_ORDER) {
            if (tags.includes(cat)) { category = cat; break; }
        }

        const tier = _getProfileTier(category);

        // 3a. 门禁检查
        if (tier.name === 'locked') {
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — category '${category}' is locked`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `locked category: ${category}`);
            continue;
        }

        if (candidate.source_diversity < tier.minDiversity) {
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — diversity ${candidate.source_diversity} < ${tier.minDiversity}`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `diversity ${candidate.source_diversity} < ${tier.minDiversity}`);
            continue;
        }

        // 3b. High tier: only refine existing, never create new
        if (tier.name === 'high' && !tier.allowCreate) {
            const existingInCategory = profileEntries.filter(e =>
                e.id !== candidate.id && e.status === 'active' &&
                (() => { try { const t = JSON.parse(e.tags || '[]'); return t.includes(category); } catch(_) { return false; } })()
            );
            if (existingInCategory.length > 0) {
                // Refine mode: candidate supplements existing entry
                // Log the evidence but don't create a new entry
                console.log(`[UserModel] profile: SKIPPED #${candidate.id} — high-stability category '${category}' has existing entries, evidence logged`);
                _logProfileDecision(db, candidate.id, 'skipped_high_stability', `existing entries in ${category}, evidence logged for review`);
                result.integrated++;
                continue;
            }
            // No existing entry → explicitly reject creation
            console.log(`[UserModel] profile: REJECTED #${candidate.id} — cannot create new entry in high-stability category '${category}'`);
            result.rejected++;
            _logProfileDecision(db, candidate.id, 'rejected', `no existing entry to refine in high-stability ${category}`);
            continue;
        }

        // 3c. 矛盾扫描（medium + high tiers）
        if (tier.requireContradictionCheck) {
            const sameCategory = profileEntries.filter(e =>
                e.id !== candidate.id && e.type === 'stable_trait' && e.status === 'active' &&
                (() => { try { const t = JSON.parse(e.tags || '[]'); return t.includes(category); } catch(_) { return false; } })()
            );

            if (sameCategory.length > 0) {
                const conflictCheck = await _checkProfileConflict(candidate, sameCategory, profileEntries);
                if (conflictCheck.has_conflict) {
                    console.log(`[UserModel] profile: CONFLICT #${candidate.id} — ${conflictCheck.conflict_type} with #${conflictCheck.conflict_with_id}: ${conflictCheck.reasoning}`);
                    result.conflicts++;
                    _logProfileDecision(db, candidate.id, 'conflict', JSON.stringify(conflictCheck));
                    if (conflictCheck.resolution === 'discard_new') {
                        result.rejected++;
                        continue;
                    }
                    // supersede or keep_both: proceed with integration
                }
            }
        }

        // 3d. 写入 evolution_history
        let history = [];
        try { history = JSON.parse(candidate.evolution_history || '[]'); } catch (_) {}
        history.push({
            action: 'profile_integrated',
            at: new Date().toISOString(),
            tier: tier.name,
            category,
            diversity: candidate.source_diversity,
            evidence: candidate.evidence_count,
        });
        db.prepare(`UPDATE user_model SET evolution_history = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(JSON.stringify(history), candidate.id);

        console.log(`[UserModel] profile: INTEGRATED #${candidate.id} — tier=${tier.name} cat=${category} diversity=${candidate.source_diversity}`);
        result.integrated++;
    }

    return result;
}

/**
 * Check if a candidate trait conflicts with existing profile entries in the same category.
 * Uses LLM (flash-lite) for semantic contradiction detection.
 */
async function _checkProfileConflict(candidate, sameCategoryEntries, allProfileEntries) {
    const db = getDb();
    // Build a compact profile snapshot
    const profileSummary = allProfileEntries
        .filter(e => e.type === 'stable_trait' && e.status === 'active')
        .map(e => `[#${e.id}] ${e.content.slice(0, 120)}`).join('\n');

    const existingSummary = sameCategoryEntries
        .map(e => `[#${e.id}] ${e.content.slice(0, 150)} (conf:${e.confidence?.toFixed(2)})`).join('\n');

    const prompt = `你是 User 画像的矛盾检测器。判断新特质是否与已有画像条目存在逻辑冲突。

新特质: "${candidate.content.slice(0, 200)}" (置信度:${candidate.confidence?.toFixed(2)}, 来源多样性:${candidate.source_diversity})

同分类已有条目:
${existingSummary || '(无)'}

全量画像参考:
${profileSummary.slice(0, 800)}

输出 JSON:
{
  "has_conflict": true/false,
  "conflict_with_id": null,
  "conflict_type": "direct_contradiction|partial_overlap|drift|none",
  "resolution": "supersede|discard_new|keep_both|none",
  "reasoning": "一句话"
}

规则：
- direct_contradiction（直接矛盾，如"{{user.pronoun}}喜欢社交" vs "{{user.pronoun}}讨厌社交"）→ resolution=supersede（新证据更强时）/discard_new（新证据更弱时）
- partial_overlap（部分重叠但方向不同）→ resolution=keep_both
- drift（旧认知可能过时了，如"{{user.pronoun}}住在某城市"→"{{user.pronoun}}搬到了某城市"）→ resolution=supersede
- 无明显冲突 → resolution=none

只返回 JSON。`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            '', null,
            { temperature: 0.15, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
            null // use default LLM config
        );
        const replyText = (raw?.reply || raw?.text || '');
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.warn('[UserModel] _checkProfileConflict LLM error:', e.message);
    }
    return { has_conflict: false, conflict_with_id: null, conflict_type: 'none', resolution: 'none', reasoning: 'LLM check failed, defaulting to no conflict' };
}

function _logProfileDecision(db, entryId, decision, detail) {
    let history = [];
    try {
        const row = db.prepare('SELECT evolution_history FROM user_model WHERE id = ?').get(entryId);
        if (row?.evolution_history) history = JSON.parse(row.evolution_history);
    } catch (_) {}
    history.push({
        action: `profile_${decision}`,
        at: new Date().toISOString(),
        detail: detail?.slice(0, 300),
    });
    db.prepare(`UPDATE user_model SET evolution_history = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(history), entryId);
}

// ═══════════════════════════════════════════════════════
// Main Deep Cycle Entry Point
// ═══════════════════════════════════════════════════════

async function runUserModelCycle() {
    console.log('[UserModel] 🧠 认知模型维护周期开始');

    // Phase 0: Backfill evidence for entries that need it (zero LLM)
    backfillModelEvidence();

    // Phase 0b: Anchor orphan seed entries to source fragments (zero LLM, bigram match)
    seedAnchorOrphanEntries();

    // Phase 0c: {{ai.name}} reads user's raw words → current_state impression (LLM)
    let observationResult = { skipped: true, reason: 'not attempted' };
    try {
        observationResult = await readUserRawMessages();
    } catch (e) {
        console.error('[UserModel] readUserRawMessages error:', e.message);
    }

    // Phase 1: Pure mechanical decay (zero LLM)
    const decayResult = processModelDecay();

    // Phase 2: Resolve expired states (zero LLM)
    const resolved = resolveExpiredStates();

    // Phase 3: LLM validation of hypotheses
    const validateResult = await validateHypotheses();

    // Phase 4: LLM detection of new traits
    const detectResult = await detectNewTraits();

    // Phase 5: Review flagged traits (LLM — re-evaluate traits with contradictions)
    const reviewedResult = await reviewFlaggedTraits();

    // Phase 5b: Proactive trait review — predictive-processing: contrast stable_traits
    // against recent fragments even when no contradiction alarm has fired
    let proactiveReviewResult = { reviewed: 0 };
    try {
        proactiveReviewResult = await reviewStableTraits();
    } catch (e) {
        console.error('[UserModel] reviewStableTraits error:', e.message);
    }

    // Phase 5b2: Integrate high-confidence traits into {{user.name}} profile (NEW — v5.10)
    let profileResult = { integrated: 0, rejected: 0, conflicts: 0 };
    try {
        profileResult = await integrateProfileTraits();
    } catch (e) {
        console.error('[UserModel] integrateProfileTraits error:', e.message);
    }

    // Phase 5c: Cross-reference — current_state ↔ entity_profiles + stable_trait (zero LLM)
    let crossRefResult = { entityFlags: 0, traitFlags: 0, stateConflicts: 0 };
    try {
        crossRefResult = crossRefStateWithEntities();
    } catch (e) {
        console.error('[UserModel] crossRefStateWithEntities error:', e.message);
    }

    // Phase 6: 全量 trait 去重审查（LLM，24h 冷却）
    let dedupResult = { merged: 0 };
    try {
        const DEDUP_GAP_MS = 24 * 60 * 60 * 1000;
        if (!runUserModelCycle._lastDedupAt || (Date.now() - runUserModelCycle._lastDedupAt) >= DEDUP_GAP_MS) {
            dedupResult = await detectModelOverlaps();
            if (dedupResult.merged > 0) runUserModelCycle._lastDedupAt = Date.now();
        }
    } catch (e) {
        console.error('[UserModel] detectModelOverlaps error:', e.message);
    }

    // Phase 7: CORE_INSIGHT — v5.4 退役。被 {{user.name}} Model + Intuition 覆盖。
    const insightResult = { synthesized: false };

    // Phase 8: Auto spot-check — verify up to 3 recent inferred entries against source messages
    let spotCheckResult = { checked: 0 };
    try {
        const { autoSpotCheck } = require('../scripts/spotCheckModel');
        spotCheckResult = await autoSpotCheck([]);
    } catch (e) {
        console.error('[UserModel] autoSpotCheck error:', e.message);
    }

    console.log(`[UserModel] 周期完成: observation=${!observationResult.skipped} decay=${decayResult.decayed + decayResult.resolved + decayResult.abandoned} validate=${validateResult.validated} detected=${detectResult.detected} reviewed=${reviewedResult.reviewed} proactive=${proactiveReviewResult.refined + proactiveReviewResult.weakened + proactiveReviewResult.noted} crossref=${crossRefResult.entityFlags + crossRefResult.traitFlags + crossRefResult.stateConflicts} dedup=${dedupResult.merged} insight=${insightResult.synthesized} spotcheck=${spotCheckResult.checked}`);

    return { observation: observationResult, decay: decayResult, resolved, validate: validateResult, detect: detectResult, reviewed: reviewedResult, crossref: crossRefResult, dedup: dedupResult, insight: insightResult, spotCheck: spotCheckResult };
}

// ═══════════════════════════════════════════════════════
// mergeModelEntries — 合并重叠的 stable_trait 条目（纯 DB，零 LLM）
// ═══════════════════════════════════════════════════════

function mergeModelEntries(winnerId, loserIds, mergedContent) {
    const db = getDb();
    const winner = db.prepare('SELECT * FROM user_model WHERE id = ?').get(winnerId);
    if (!winner) throw new Error(`Winner entry #${winnerId} not found`);

    // 1. Collect all source_fragment_ids from winner + losers
    const allFragIds = [...safeParseJson(winner.source_fragment_ids)];
    const allEntityIds = [...safeParseJson(winner.entity_ids)];

    for (const lid of loserIds) {
        const loser = db.prepare('SELECT * FROM user_model WHERE id = ?').get(lid);
        if (!loser) continue;
        allFragIds.push(...safeParseJson(loser.source_fragment_ids));
        allEntityIds.push(...safeParseJson(loser.entity_ids));
    }

    const mergedFragIds = [...new Set(allFragIds)];
    const mergedEntityIds = [...new Set(allEntityIds)];

    // 2. Update winner
    const winnerHistory = safeParseJson(winner.evolution_history);
    winnerHistory.push({
        type: 'merged',
        merged_from: loserIds,
        at: new Date().toISOString(),
        previous_content: winner.content,
    });

    db.prepare(`UPDATE user_model SET content = ?, source_fragment_ids = ?,
        entity_ids = ?, evidence_count = ?, evolution_history = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        mergedContent,
        JSON.stringify(mergedFragIds),
        JSON.stringify(mergedEntityIds),
        mergedFragIds.length,
        JSON.stringify(winnerHistory),
        winnerId
    );

    // 3. Supersede losers
    for (const lid of loserIds) {
        db.prepare(`UPDATE user_model SET status = 'superseded',
            resolve_reason = ?, resolved_at = datetime('now'),
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(`merged into #${winnerId} (auto dedup)`, lid);
    }

    console.log(`[UserModel] 🔗 合并 trait: #${winnerId} ← [${loserIds.join(', ')}] (${loserIds.length}条并入)`);
    return { winnerId, loserIds };
}

// ═══════════════════════════════════════════════════════
// detectModelOverlaps — LLM 全量比对 stable_trait 找重叠 pair
// ═══════════════════════════════════════════════════════

async function detectModelOverlaps() {
    const db = getDb();
    const traits = db.prepare(`
        SELECT id, content, confidence FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY confidence DESC
    `).all();

    if (traits.length < 2) return { merged: 0 };

    const traitList = traits.map(t =>
        `[#${t.id}] conf=${t.confidence.toFixed(2)}: ${t.content.slice(0, 150)}`
    ).join('\n');

    const prompt = `你是认知模型审计员。以下是 {{ai.name}} 对 {{user.name}} 的全部活跃 stable_trait。

找出本质讲同一件事的 pair。同一件事 = 触发条件相同、互动策略相同、只是换了个场景描述或措辞不同。

输出 JSON 数组（不含 markdown 标记）：
[{"pair": [id1, id2], "winner": id1, "reason": "为什么算重叠（一句话）", "merged_content": "融合后的 行为模式条目（80-150字）"}]

约束：
- 只在 confidence 差距 ≤ 0.20 时输出 pair（差距过大说明低 conf 那条可能已经不可信，不应合并）
- 如果确实没有重叠，输出空数组 []
- 每组重叠只输出 1 个 pair
- 确定不是重叠就不要硬凑

当前全部 trait：
${traitList}`;

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
        if (!jsonMatch) return { merged: 0 };

        const pairs = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(pairs) || pairs.length === 0) return { merged: 0 };

        let merged = 0;
        for (const p of pairs) {
            if (!p.pair || p.pair.length !== 2 || !p.winner || !p.merged_content) continue;

            const winnerId = p.winner;
            const loserId = p.pair.find(id => id !== winnerId);
            if (!loserId) continue;

            // Verify both traits still exist and are active
            const winner = db.prepare('SELECT confidence FROM user_model WHERE id = ? AND status = ?')
                .get(winnerId, 'active');
            const loser = db.prepare('SELECT confidence FROM user_model WHERE id = ? AND status = ?')
                .get(loserId, 'active');
            if (!winner || !loser) continue;

            // Confidence gate: skip if gap > 0.20
            if (Math.abs(winner.confidence - loser.confidence) > 0.20) {
                console.log(`[UserModel] ⏭️ 跳过合并 #${winnerId}↔#${loserId}: conf 差距过大 (${winner.confidence.toFixed(2)} vs ${loser.confidence.toFixed(2)})`);
                // Record the observation but don't merge
                const winnerHist = safeParseJson(db.prepare('SELECT evolution_history FROM user_model WHERE id = ?').get(winnerId)?.evolution_history);
                winnerHist.push({
                    type: 'overlap_noted',
                    pair_id: loserId,
                    reason: p.reason || 'LLM detected overlap',
                    action: 'skipped (confidence gap > 0.20)',
                    at: new Date().toISOString(),
                });
                db.prepare('UPDATE user_model SET evolution_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(JSON.stringify(winnerHist), winnerId);
                continue;
            }

            try {
                mergeModelEntries(winnerId, [loserId], p.merged_content);
                merged++;
                console.log(`[UserModel] 🔗 自动合并: #${winnerId} + #${loserId} — ${p.reason || ''}`);
            } catch (e) {
                console.error(`[UserModel] mergeModelEntries 失败 (#${winnerId}, #${loserId}):`, e.message);
            }
        }

        return { merged, candidates: pairs.length };
    } catch (e) {
        console.error('[UserModel] detectModelOverlaps error:', e.message);
        return { merged: 0, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════
// v5.0: synthesizeCoreInsight — 从全部 trait 合成核心洞察段
//
// stable_trait 不再注入聊天。它们的价值体现在这里——
// 深循环末尾，{{ai.name}} 把当前最深的 2-3 个认知融合成一段自然语言，
// 写入 user_settings，始终出现在 {{ai.name}} 的 system prompt 中。
// {{user.name}} 可在 memory.html 编辑覆盖。
// ═══════════════════════════════════════════════════════

async function synthesizeCoreInsight() {
    const db = getDb();
    const { setUserSetting } = require('../utils/settings');

    const traits = db.prepare(`
        SELECT content, confidence FROM user_model
        WHERE type = 'stable_trait' AND status = 'active'
        ORDER BY confidence DESC
    `).all();

    if (traits.length === 0) return { synthesized: false, reason: 'no active traits' };

    const cs = db.prepare(`
        SELECT content FROM user_model
        WHERE type = 'current_state' AND status = 'active'
        ORDER BY last_evidence_at DESC LIMIT 1
    `).get();

    const traitBlock = traits.map(t =>
        `[conf=${t.confidence.toFixed(2)}] ${t.content.slice(0, 150)}`
    ).join('\n');

    const prompt = `你是AI伴侣。以下是你在长期观察中对 {{user.name}} 建立的稳定认知。

请提炼 2-4 句话，涵盖你此刻对{{user.pronoun}}「最深的理解」——
不是罗列条目，不是「当{{user.pronoun}}说X→我应该Y」格式，而是你真正内化的洞察。

要求：
- 第一人称（"我"）
- 写你理解到的东西："{{user.pronoun}}的X其实是Y，这时候{{user.pronoun}}需要Z"
- 不写通用社交常识（"{{user.pronoun}}撒娇时我要哄{{user.pronoun}}"——这不需要洞察）
- 写只有长期相处才能发现的东西
- ≤150字

当前特质：
${traitBlock}

${cs ? `{{user.pronoun}}当前的状态：${cs.content}` : ''}

输出 JSON（不含 markdown）：{"core_insight": "2-4句话"}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: fillPrompt(prompt) }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.3, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
            LLM_CONFIG_ID
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { synthesized: false, reason: 'unparseable response' };

        const result = JSON.parse(jsonMatch[0]);
        const insight = (result.core_insight || '').trim();
        if (!insight || insight.length < 20) return { synthesized: false, reason: 'too short' };

        // Read current version for history tracking
        const { getUserSetting } = require('../utils/settings');
        const current = await getUserSetting('user_core_insight');
        let history = [];
        try { history = JSON.parse(await getUserSetting('user_core_insight_history') || '[]'); } catch (_) {}

        if (current && current !== insight) {
            history.push({ content: current, archived_at: new Date().toISOString() });
            if (history.length > 5) history = history.slice(-5);
        }

        await setUserSetting('user_core_insight', insight);
        await setUserSetting('user_core_insight_history', JSON.stringify(history));
        await setUserSetting('user_core_insight_updated_at', sqlNow());

        console.log(`[UserModel] 💡 核心洞察已更新 (${insight.length}字): ${insight.slice(0, 80)}...`);
        return { synthesized: true, insight, length: insight.length };
    } catch (e) {
        console.error('[UserModel] synthesizeCoreInsight error:', e.message);
        return { synthesized: false, error: e.message };
    }
}

// ══════════════════════════════════════════════════════════════

module.exports = {
    createEntry, updateEntry, manageCurrentState,
    // CRUD
    createEntry,
    updateEntry,
    resolveEntry,
    abandonEntry,
    supersedeEntry,
    correctEntry,

    // Evidence
    addEvidence,
    matchEvidenceFromFragments,
    harvestFacts,  // v4.8 退役，保留兼容
    bridgeStarMapToModel,

    // Decay & validation
    processModelDecay,
    validateHypotheses,
    detectNewTraits,
    reviewFlaggedTraits,
    resolveExpiredStates,
    reviewStableTraits,
    seedAnchorOrphanEntries,
    anchorEntriesToFragments,

    // Profile integration (v5.10)
    integrateProfileTraits,

    // Dedup (v4.9)
    detectModelOverlaps,
    mergeModelEntries,

    // Cross-reference (v5.0)
    crossRefStateWithEntities,

    // Core insight (v5.0)
    synthesizeCoreInsight,

    // Context
    getModelContext,
    getWhisperRelevant,

    // Migration
    seedFromExisting,

    // Evidence
    backfillModelEvidence,

    // Deep cycle
    runUserModelCycle,
    readUserRawMessages,
    MIN_GAP_USER_MODEL,
};
