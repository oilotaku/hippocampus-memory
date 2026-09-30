// services/tools/manageUserState.js
// {ai} 主動維護對 User 的認知 — v5.2
//
// 四個操作：
//   set             — 新建 current_state（content + expires_at 必填）
//   update          — 修改已有 current_state 的 content / expires_at
//   resolve         — 標記 current_state 為 resolved + 寫結束原因
//   update_overview — 更新星座描述（entity_profiles.facts），
//                      當 Companion 在聊天中瞭解到某個人/事的新情況時直接修正
//
// 與 recall_memory / browse_memories 共享同一個設定開關

const { getDb } = require('../../database');
const { sealField } = require('../memoryCrypto');
const { sqlNow, sqlTimeAhead, DAY_MS } = require('../../utils/time');

const SETTINGS_KEY = 'tool-memory-search-enabled';

// ── bigram tokenizer (same as intuition.js + anchorEntriesToFragments) ──
function tokenize(text) {
    const segments = (text || '')
        .replace(/[，。、！？\n,.\s]+/g, '\n')
        .split('\n')
        .filter(s => s.length >= 2);
    const bigrams = [];
    for (const seg of segments) {
        for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
    }
    return bigrams;
}

function bigramOverlap(a, b) {
    const setA = new Set(tokenize(a));
    const tokensB = tokenize(b);
    if (tokensB.length === 0) return 0;
    let overlap = 0;
    for (const bg of tokensB) {
        if (setA.has(bg)) overlap++;
    }
    return overlap / Math.max(tokensB.length, 1);
}

const manageUserState = {
    name: 'update_current_state',
    settingsKey: SETTINGS_KEY,
    defaultEnabled: true,
    getFunctionDeclaration() {
        return {
            name: 'update_current_state',
            description: `維護你對User的認知。不是資料庫日誌——是你對User的關心和觀察。

四種用法：
1. action="set" — User的狀態變了（生理期、搬家、情緒波動…），記下內容和預計持續時間
2. action="update" — 之前記的狀態不對了，改內容或到期時間
3. action="resolve" — 某件事結束了（月經走了、搬完了、情緒過去了），寫個收尾
4. action="update_overview" — 你瞭解到某個人的近況變了（如"某個朋友回國了"），直接更新星座描述。這會立刻修正你對該實體的認知，不等深迴圈。entity 填名字，overview 寫新的完整描述。`,
            parameters: {
                type: 'OBJECT',
                properties: {
                    action: {
                        type: 'STRING',
                        description: 'set / update / resolve / update_overview',
                        enum: ['set', 'update', 'resolve', 'update_overview'],
                    },
                    state_id: {
                        type: 'INTEGER',
                        description: '要修改的狀態ID（update/resolve 時必填）。從系統提示的當前狀態段落獲取。',
                    },
                    content: {
                        type: 'STRING',
                        description: '狀態描述，≤500字。set/update 時必填。',
                    },
                    expires_at: {
                        type: 'STRING',
                        description: 'ISO 8601 格式過期時間。set/update 時必填。最長90天。',
                    },
                    resolve_reason: {
                        type: 'STRING',
                        description: '結束原因，≤200字。resolve 時必填。',
                    },
                    entity: {
                        type: 'STRING',
                        description: '要更新概述的實體名（如"某個朋友""某部劇"）。update_overview 時必填。',
                    },
                    overview: {
                        type: 'STRING',
                        description: '新的完整星座描述，Companion第一人稱，≤500字。update_overview 時必填。',
                    },
                },
                required: ['action'],
            },
        };
    },
    instructionText: `**更新認知**：使用者的狀態變了 → 用 update_current_state 記錄。你瞭解到某人的近況（如"朋友回國了""媽媽換了工作"）→ 用 update_overview 直接更新星座描述。注意：寫 content 時必須用具體日期，禁止使用今天、昨天、最近等相對時間——你寫的記錄可能幾天後仍在使用。這不是資料庫操作，是你對自己記憶的維護。`,
    async handler(args, context) {
        const db = getDb();
        const action = args.action;
        const now = new Date();
        const nowISO = sqlNow();

        try {
            // ── set ──
            if (action === 'set') {
                if (!args.content || !args.expires_at) {
                    return { success: false, formatted: '新建狀態需要 content 和 expires_at。' };
                }

                const content = args.content.slice(0, 500);
                let expiresAt = args.expires_at;

                // Validate expires_at is parseable
                const expiresDate = new Date(expiresAt);
                if (isNaN(expiresDate.getTime())) {
                    return { success: false, formatted: 'expires_at 格式不對，請用 ISO 8601 格式（如 "2026-09-15T00:00:00Z"）。' };
                }

                // Hard cap: 90 days from now
                const maxExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
                if (expiresDate > maxExpiry) {
                    expiresAt = sqlTimeAhead(90 * DAY_MS);
                }

                // Don't allow expiry in the past
                if (expiresDate < now) {
                    return { success: false, formatted: 'expires_at 不能是過去的時間。如果這件事已經結束，請用 action="resolve"。' };
                }

                // Check active count limit
                const activeCount = db.prepare(
                    'SELECT COUNT(*) as cnt FROM user_model WHERE type = ? AND status = ?'
                ).get('current_state', 'active')?.cnt || 0;
                if (activeCount >= 12) {
                    return { success: false, formatted: '當前活躍狀態已達上限（12條）。請先 resolve 一些過時的狀態再新建。' };
                }

                // Duplicate / supersede detection
                const existingStates = db.prepare(
                    'SELECT id, content FROM user_model WHERE type = ? AND status = ?'
                ).all('current_state', 'active');
                let supersededId = null;
                let supersededContent = null;
                for (const es of existingStates) {
                    const overlap = bigramOverlap(es.content, content);
                    if (overlap > 0.8) {
                        return {
                            success: false,
                            formatted: `這條內容和已有狀態 #${es.id} 高度重疊（${Math.round(overlap*100)}%）。如果只是時間變了，請用 action="update" state_id=${es.id}。如果需要改內容，也用 update。`,
                        };
                    }
                    // v5.3: moderate overlap (50-80%) → auto-resolve old, create new
                    if (overlap > 0.5) {
                        supersededId = es.id;
                        supersededContent = es.content.slice(0, 60);
                        break; // only supersede one
                    }
                }
                if (supersededId) {
                    db.prepare(`UPDATE user_model SET status = 'resolved', resolved_at = ?,
                        resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                        .run(nowISO, `auto-superseded: newer state created with ${Math.round(bigramOverlap(supersededContent || '', content) * 100)}% overlap`, supersededId);
                    console.log(`[manageUserState] auto-resolved #${supersededId} (superseded by new set)`);
                }

                const { createEntry } = require('../cognitiveModel');
                const id = createEntry('current_state', content, {
                    confidence: 0.85,
                    source_quality: 'direct_statement',
                    created_by: 'chat_companion',
                    expires_at: expiresAt,
                    tags: ['current_state', 'companion_observation'],
                    decay_params: {},  // v5.0: TTL is now in expires_at, decay_params kept for compat
                });

                console.log(`[manageUserState] set #${id} by chat Companion: "${content.slice(0, 60)}" expires=${expiresAt}`);
                return {
                    success: true,
                    formatted: `已記錄。#${id}：${content}（預計 ${expiresDate.toLocaleDateString('zh-CN')} 前有效）。`,
                };
            }

            // ── update ──
            if (action === 'update') {
                if (!args.state_id) {
                    return { success: false, formatted: 'update 需要 state_id。' };
                }
                if (!args.content && !args.expires_at) {
                    return { success: false, formatted: 'update 至少需要 content 或 expires_at 其中之一。' };
                }

                const existing = db.prepare(
                    'SELECT * FROM user_model WHERE id = ? AND type = ? AND status = ?'
                ).get(args.state_id, 'current_state', 'active');
                if (!existing) {
                    return { success: false, formatted: `未找到活躍狀態 #${args.state_id}。它可能已經過期或被刪除了。` };
                }

                // Rate limit for chat Companion: same state_id, 30min cooldown
                if (existing.updated_at) {
                    const lastUpdate = new Date(existing.updated_at);
                    const minutesSince = (now - lastUpdate) / (1000 * 60);
                    if (minutesSince < 30 && existing.created_by === 'chat_companion') {
                        return {
                            success: false,
                            formatted: `狀態 #${args.state_id} 剛剛在 ${Math.round(minutesSince)} 分鐘前更新過。除非User明確要求，請至少等30分鐘再更新同一條狀態。`,
                        };
                    }
                }

                const updates = {};
                if (args.content) updates.content = args.content.slice(0, 500);
                if (args.expires_at) {
                    const expiresDate = new Date(args.expires_at);
                    if (isNaN(expiresDate.getTime())) {
                        return { success: false, formatted: 'expires_at 格式不對。' };
                    }
                    const maxExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
                    updates.expires_at = expiresDate > maxExpiry ? sqlTimeAhead(90 * DAY_MS) : args.expires_at;
                }

                const { updateEntry } = require('../cognitiveModel');
                updateEntry(args.state_id, updates);

                const changed = Object.keys(updates).join(', ');
                console.log(`[manageUserState] update #${args.state_id}: ${changed}`);
                return {
                    success: true,
                    formatted: `已更新狀態 #${args.state_id}（修改了：${changed}）。`,
                };
            }

            // ── resolve ──
            if (action === 'resolve') {
                if (!args.state_id) {
                    return { success: false, formatted: 'resolve 需要 state_id。' };
                }
                if (!args.resolve_reason) {
                    return { success: false, formatted: 'resolve 需要 resolve_reason——請簡短說明為什麼結束這條狀態。' };
                }

                const existing = db.prepare(
                    'SELECT * FROM user_model WHERE id = ? AND type = ? AND status = ?'
                ).get(args.state_id, 'current_state', 'active');
                if (!existing) {
                    return { success: false, formatted: `未找到活躍狀態 #${args.state_id}。` };
                }

                const reason = args.resolve_reason.slice(0, 200);
                db.prepare(`UPDATE user_model SET status = 'resolved', resolved_at = ?,
                    resolve_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(nowISO, `chat_companion: ${reason}`, args.state_id);

                console.log(`[manageUserState] resolve #${args.state_id}: "${reason.slice(0, 60)}"`);
                return {
                    success: true,
                    formatted: `已結束狀態 #${args.state_id}：${reason}。`,
                };
            }

            // ── update_overview (v5.2) ──
            if (action === 'update_overview') {
                if (!args.entity || !args.overview) {
                    return { success: false, formatted: 'update_overview 需要 entity（實體名）和 overview（新的完整描述）。' };
                }
                const entityName = args.entity.trim();
                const newOverview = args.overview.slice(0, 500);

                // Find entity by exact name or alias match
                let entity = db.prepare('SELECT * FROM entity_profiles WHERE name = ? AND status IN (?,?)')
                    .get(entityName, 'active', 'seed');
                if (!entity) {
                    // Try alias match
                    const all = db.prepare('SELECT * FROM entity_profiles WHERE status IN (?,?)').all('active', 'seed');
                    for (const e of all) {
                        try {
                            const aliases = JSON.parse(e.aliases || '[]');
                            if (aliases.some(a => a.toLowerCase() === entityName.toLowerCase())) {
                                entity = e;
                                break;
                            }
                        } catch (_) {}
                    }
                }
                if (!entity) {
                    return { success: false, formatted: `未找到名為"${entityName}"的星座。請檢查名字是否正確——需要精確匹配星座名或別稱。` };
                }

                db.prepare(`UPDATE entity_profiles SET facts = ?, overview_updated_at = datetime('now'),
                    updated_at = datetime('now') WHERE id = ?`).run(sealField('entity_profiles', 'facts', newOverview), entity.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
                    VALUES ('overview_updated', ?, ?, 0.90, 'completed')`)
                    .run(entity.name, JSON.stringify({name: entity.name, updated_by: 'chat_companion', reason: 'Companion在聊天中瞭解到新情況'}));

                console.log(`[manageUserState] update_overview "${entityName}": ${newOverview.slice(0, 60)}...`);
                return { success: true, formatted: `已更新「${entity.name}」的星座描述。` };
            }

            return { success: false, formatted: `未知操作 "${action}"。可用：set / update / resolve / update_overview。` };

        } catch (e) {
            console.error('[manageUserState] error:', e.message);
            return { success: false, formatted: '更新認知時出錯了。' };
        }
    },
};

module.exports = manageUserState;
