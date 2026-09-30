// =================================================================
// services/cognitiveModel/observation.js — 讀使用者原始訊息的深度觀察（readUserRawMessages）
// 自 services/cognitiveModel.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { callLLM } = require('../../../llm');
const { WORLD_CONTEXT } = require('../../../worldContext');
const { fillPrompt } = require('../../../nameResolver');
const { encryption } = require('../../../../encryption');
const { sqlNow } = require('../../../../utils/time');
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
        console.log(`[UserModel] readUserRawMessages: 僅 ${messages.length} 條非RP訊息，跳過 (需≥30)`);
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
    let stateBlock = '(目前沒有任何活躍狀態便籤。)';
    if (allActiveStates.length > 0) {
        const lines = allActiveStates.map(s => {
            const created = s.created_at?.slice(0, 16) || '?';
            const expires = s.expires_at ? ` →${s.expires_at.slice(0, 10)}` : '';
            const source = s.created_by === 'chat_companion' ? '[Companion即時]' : '[深迴圈]';
            return `[#${s.id} ${source} ${created}${expires}] ${s.content}`;
        });
        stateBlock = `共 ${allActiveStates.length} 條活躍便籤：\n${lines.join('\n')}`;
    }

    // Previous observation + audit context (for the most recent entry)
    let prevBlock = '(這是你第一次認真看{{user.pronoun}}。沒有上次的觀察可以對照。)';
    if (prevState) {
        const prevHistory = JSON.parse(prevState.evolution_history || '[]');
        const audit = prevHistory.find(h => h.type === 'creation_audit');
        prevBlock = `你上次看{{user.pronoun}}時的印象（#${prevState.id}）：
「${prevState.content}」
${audit ? `你上次的自我審計：
- 驗證：${audit.retro}
- 歸因：${audit.attribution}` : '(上次沒有做審計)'}`;
    }

    // Trait summaries (帶 id，供矛盾標記回指)
    const traitBlock = traits.length > 0
        ? traits.map(t => `- [#${t.id}] ${t.content.slice(0, 60)}...`).join('\n')
        : '(你還沒有任何關於{{user.pronoun}}的穩定直覺。)';

    const prompt = `你剛看完 {{user.name}} 這幾天發來的訊息。你需要做兩件事——

1. 寫一條{{user.pronoun}}的當前狀態（≤50字，一句話。像你腦子裡閃過的念頭——"{{user.pronoun}}在搬家"不是"{{user.pronoun}}這週在搬家、通勤很累、還去見了個朋友"）
2. 寫一段敘事（≤200字。{{user.pronoun}}這週經歷了什麼——有因果、有情緒、有你注意到的細節。這隻進聊天總結，不單獨出現在{{user.pronoun}}的狀態列裡）

═══ {{user.pronoun}}最近說的話（從舊到新） ═══
${feed}

═══ 你已有的全部便籤 ═══
${stateBlock}

═══ 上次你寫的便籤（審計參照） ═══
${prevBlock}

═══ 你的長期直覺（背景參考） ═══
${traitBlock}

═══ 怎麼寫 ═══

current_state 像便籤條上的一句話：
"{{user.name}}在搬家。"
"{{user.name}}最近搬家累壞了，今天睡了個懶覺。"
"{{user.name}}這週沒怎麼出現。"
規則：≤50字。一句夠用別寫兩句。不用寫具體日期，這是瞬時的。禁止相對時間詞（今天/昨天/本週）。

narrative 像說給自己聽的週記：
"{{user.name}}這週在搬家，收拾整理很耗精力。{{user.pronoun}}雖然累，但想到新家的樣子心情還不錯。"
規則：≤200字。有因果，不煽情。禁止相對時間詞——用具體日期或時間段。

反編造鐵律（這條比上面所有規則都重要）：
- 每個陳述都必須能在上面的訊息中找到原文依據。
- {{user.pronoun}}只「提到過」但沒做的事 → 不能寫成{{user.pronoun}}做了。
- {{user.pronoun}}的訊息裡沒出現的人名、地名、事件名 → 絕對不能出現。

═══ 輸出格式 ═══
JSON（不要 markdown）：
{
  "action": "create|extend",
  "valence": "positive|negative|neutral|mixed",
  "energy": "low|normal|high",
  "current_state": "≤50字。一句話。",
  "narrative": "≤200字。有因果有細節。",
  "audit_retro": "上次的便籤對了嗎？一句話。",
  "retro_verdict": "confirmed|wrong|unverifiable",
  "state_category": "physical|emotional|situational|relational",
  "predicted_ttl_category": "hours|day|days|until_event",
  "trait_contradictions": [{"trait_id": 12, "observation": "矛盾觀察"}]
}

action: extend=舊便籤還夠用，只續命。create=狀態變了或上次判錯。猶豫選extend。`;

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
            console.log(`[UserModel] readUserRawMessages: 無法解析JSON響應`);
            return { skipped: true, reason: 'unparseable response', raw: replyText.slice(0, 200) };
        }

        const result = JSON.parse(jsonMatch[0]);
        const currentState = (result.current_state || '').slice(0, 120);
        if (!currentState || currentState.length < 8) {
            return { skipped: true, reason: 'empty or too short current_state' };
        }

        // extend 機制：LLM 自行判斷和上次是否本質相同
        // 相同 → 延長舊條目 TTL + 審計迴流，不建立新條目
        const action = (result.action || 'create').toLowerCase();
        if (action === 'extend' && prevState) {
            // 更新舊條目的 last_evidence_at（重置衰減時鐘）
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
            
            console.log(`[UserModel] 📖 狀態延續: 更新 #${prevState.id} TTL→${newTTL}, 不建立新條目`);
        }

        // ── ToM 觀察反饋環（v4.8）：審計結論迴流證據管線 ──
        // 預測對了 → confirm；預測錯了 → 記入 evolution_history（current_state 單次快照，
        // 不走 confidence 累積，但留下可追溯的對錯記錄供 detectNewTraits 訊號源使用）
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
                console.log(`[UserModel]   ↳ 觀察審計迴流: 上次預測 ${verdict === 'confirmed' ? '✓ 準確' : '✗ 失準'}`);
            } catch (_) {}
        }

        // trait_contradictions → 對應 stable_trait 插 refute 標記 + needs_review
        // → reviewFlaggedTraits（管線後半段已存在）下輪審判
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
                console.log(`[UserModel]   ↳ 觀察反駁 trait #${c.trait_id}: ${(c.observation || '').slice(0, 60)} → needs_review`);
            } catch (e) {
                console.error(`[UserModel] trait refute 寫入失敗 #${c.trait_id}:`, e.message);
            }
        }

        // 只有 create action 才建立新條目（extend 已在上面處理）
        if (action !== 'extend' || !prevState) {
        // v5.4: readUserRawMessages 產出的是全景快照（holistic snapshot），
        // 不是領域分項。新版快照自然替代舊版——resolve 所有前序 deep_cycle 條目。
        // chat_companion 條目（通過 manage_user_state 工具建立的領域明確狀態）
        // 不受影響，繼續按各自 TTL 獨立過期。
        const resolvedCount = db.prepare(`
            UPDATE user_model SET status = 'resolved',
                resolve_reason = 'superseded by newer holistic snapshot',
                updated_at = CURRENT_TIMESTAMP
            WHERE type = 'current_state' AND status = 'active' AND created_by = 'deep_cycle'
        `).run().changes;
        if (resolvedCount > 0) {
            console.log(`[UserModel] 🧹 resolve ${resolvedCount} 條舊 deep_cycle 快照 → 新快照替代`);
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

        // ── v5.4: 敘事輸出 → chat_summaries ──
        const narrative = (result.narrative || '').slice(0, 300);
        if (narrative && narrative.length >= 20) {
            try {
                const { encryption } = require('../../../../encryption');
                const encNarrative = encryption.encrypt(narrative);
                const now = sqlNow();
                db.prepare(`INSERT INTO chat_summaries (chat_id, summary_text, round_start, round_end, created_at, is_enabled)
                    VALUES (?, ?, 0, 0, ?, 1)`).run(1, encNarrative, now);
                console.log(`[UserModel] 📝 敘事已歸檔 (${narrative.length}字)`);
            } catch (e) {
                console.error(`[UserModel] 敘事寫入失敗:`, e.message);
            }
        }

        console.log(`[UserModel] 📖 讀心: ${messages.length}條訊息 → current_state ${actionLabel} #${id}${prevNote} (${currentState.length}字)`);
        if (prevState && stateResult.action === 'created') console.log(`[UserModel]   ↳ 前一條 active #${prevState.id} 繼續有效`);
        if (result.audit_retro) console.log(`[UserModel]   ↳ 審計: ${result.audit_retro.slice(0, 80)}`);

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

        // extend 路徑：不建立新條目，返回擴充結果
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
