// =================================================================
// services/archivist/tick.js — Agent 迴圈：啟停與狀態、事件驅動、tick 排程、深度整合、樹健康評估、園藝決策
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');
const { callLLM } = require('../llm');
const { SKIP_NAMES, USER, AI } = require('../memoryConfig');
const { runUserModelCycle, matchEvidenceFromFragments, processModelDecay, resolveExpiredStates, MIN_GAP_USER_MODEL } = require('../cognitiveModel');
const { SKIP_PH, ARCHIVIST_VERIFY_CONFIG_ID, TICK_INTERVAL_MS, USER_IDLE_DEEP_CYCLE_MS, ENTITY_DISCOVERY_MIN_FRAGS, INSIGHT_BATCH_MAX, MIN_GAP_CLASSIFY, MIN_GAP_INSIGHTS, MIN_GAP_ENTITY_OVERVIEWS, MIN_GAP_SKILLS, MIN_GAP_RELATIONSHIPS, MIN_GAP_EMERGENT, MIN_GAP_ENTITY_VERIFY, MIN_GAP_MUSIC_EXTRACT, MIN_GAP_BOOK_EXTRACT, MIN_GAP_AUTO_LINK, MIN_GAP_REMATCH, MIN_GAP_SEMANTIC_REMATCH, MIN_GAP_SEED_MERGE, MIN_GAP_RELATED_ENTITIES, MIN_GAP_EPISODE_AUDIT, MIN_FREE_MEMORY_MB, MEMORY_CHECK_GRACE_MB } = require('./constants');
const { archivistEvents, agentState, _checkMemoryGate, toolRegistry, getTool, _checkDailyLLMReset, _canCallLLM, _countRemainingLLM, runTask, _logGardenActivity, _taskKey, runTaskIfDue, _refreshWhisper } = require('./runtime');
const { autoLinkLiteralMentions, linkTaggedFragments, linkAggregateFragments } = require('./entityLink');
const { discoverRelatedEntities } = require('./relations');
const { mergeDuplicateSeeds, graduateSeedsAndPrune } = require('./seeds');
const { classifyFragments, spotCheckClassifications } = require('./classify');
const { rematchFragmentsForSeeds, semanticRematchForSeeds } = require('./rematch');
const { refreshIntuitionStopwords } = require('./intuitionStopwords');
const { auditNewEpisodes } = require('./episode');
const { detectEmergentPlacesAndEvents } = require('./emergent');
const { regenerateEntityOverviews } = require('./entityOverview');
const { scanContentForNewEntities } = require('./entityDiscovery');
const { extractFragmentInsights } = require('./insights');


async function start() {
    if (agentState.running) return;
    agentState.running = true;
    agentState.companionLastActive = Date.now();

    console.log('[Archivist Agent] 启动 — Agent 循环 (2min tick) + 事件驱动 + Companion 感知');

    // Listen for fragment events from Scribe — just set flags, don't cancel anything
    archivistEvents.on('fragments:written', (payload) => {
        onNewFragments(payload).catch(e =>
            console.error('[Archivist Agent] 事件处理异常:', e.stack || e.message));
    });

    // Start the agent loop
    scheduleTick();
    console.log('[Archivist Agent] 就绪');
}


function stop() {
    agentState.running = false;
    if (agentState.tickTimer) clearTimeout(agentState.tickTimer);
    archivistEvents.removeAllListeners('fragments:written');
    console.log('[Archivist Agent] 已停止');
}


function getStatus() {
    return {
        running: agentState.running,
        companionActive: agentState.companionActive,
        inTick: agentState.inTick,
        dailyLLMCalls: agentState.dailyLLMCalls,
        totalClassified: agentState.totalClassified,
        totalTasksRun: agentState.totalTasksRun,
        lastTick: agentState.tickTimer ? 'pending' : 'idle',
        tools: [...toolRegistry.keys()],
    };
}


// ═══════════════════════════════════════════════════════
// Event-Driven Path: Scribe 写完碎片 → 标记 flag
// ═══════════════════════════════════════════════════════

async function onNewFragments({ fragmentIds, sourceMsgIds }) {
    if (!fragmentIds || fragmentIds.length === 0) return;

    // Just set flags — Agent loop picks these up on next tick
    agentState.newFragmentsSinceLastTick += fragmentIds.length;

    // Trigger skills that match new fragments (lightweight, runs immediately)
    try {
        const { triggerSkills } = require('../skillManager');
        await triggerSkills({ newFragmentIds: fragmentIds });
    } catch (e) {
        // skillManager may not be loaded yet
    }

    // Throttled whisper invalidation
    try {
        const { onNewData } = require('../whisper');
        onNewData();
    } catch (_) {}

    // ── Event-driven consolidation: flash only (routine → deep cycle) ──
    try {
        maybeTriggerFlashConsolidation(fragmentIds, sourceMsgIds);
    } catch (_) {}
    // Extract insights from new fragments (fire-and-forget)
    extractFragmentInsights().catch(e =>
        console.error('[Archivist] insight 提取失败:', e.message));
}


// ── Event-driven consolidation helpers (moved from scribe.js) ──

const FLASH_MIN_COUNT = 4;

const FLASH_EW_THRESHOLD = 0.85;

const FLASH_SPIKE_THRESHOLD = 0.92;


function maybeTriggerFlashConsolidation(newFragmentIds, sourceMsgIds) {
    if (!newFragmentIds || newFragmentIds.length < FLASH_MIN_COUNT) return;

    const db = getDb();
    const placeholders = newFragmentIds.map(() => '?').join(',');

    const highEW = db.prepare(`
        SELECT id, content, emotional_weight, source_msg_ids FROM memory_fragments
        WHERE id IN (${placeholders}) AND emotional_weight >= ?
        ORDER BY emotional_weight DESC
    `).all(...newFragmentIds, FLASH_EW_THRESHOLD);

    if (highEW.length < FLASH_MIN_COUNT) return;

    const hasSpike = highEW.some(f => f.emotional_weight >= FLASH_SPIKE_THRESHOLD);
    if (!hasSpike) return;

    const spike = highEW.find(f => f.emotional_weight >= FLASH_SPIKE_THRESHOLD);
    console.log(`[Archivist] Flash触发条件满足：${highEW.length}条高EW碎片(≥${FLASH_EW_THRESHOLD})，尖峰=${spike.emotional_weight.toFixed(2)}`);

    const { consolidateFlash } = require('../consolidator');
    const msgIds = (() => {
        try { return JSON.parse(sourceMsgIds || '[]'); } catch (_) { return []; }
    })();
    consolidateFlash(highEW, msgIds).then(result => {
        if (result.flashed) {
            console.log(`[Archivist] Flash整合成功：episode #${result.memoryId}`);
        } else {
            console.log(`[Archivist] Flash整合未执行：${result.reason || 'unknown'}`);
        }
    }).catch(err => {
        console.error('[Archivist] Flash整合异常:', err.message);
    });
}


// ═══════════════════════════════════════════════════════
// Agent Tick — 主循环
// ═══════════════════════════════════════════════════════

function scheduleTick() {
    if (!agentState.running) return;
    agentState.tickTimer = setTimeout(async () => {
        if (!agentState.running) return;
        try {
            await agentTick();
        } catch (e) {
            console.error('[Archivist Agent] Tick 异常:', e.stack || e.message);
        }
        scheduleTick();
    }, TICK_INTERVAL_MS);
}


function getLastUserMessageTime() {
    const db = getDb();
    const row = db.prepare("SELECT timestamp FROM messages WHERE sender = 'user' ORDER BY id DESC LIMIT 1").get();
    return row ? new Date(row.timestamp).getTime() : 0;
}


async function agentTick() {
    if (agentState.inTick) return;
    agentState.inTick = true;
    agentState.tickLLMCalls = 0;
    const tickStart = Date.now();

    _checkDailyLLMReset();

    const newFragCount = agentState.newFragmentsSinceLastTick;
    agentState.newFragmentsSinceLastTick = 0;

    try {
        // 0. User activity check — detect new messages, determine mode
        const lastUserTime = getLastUserMessageTime();
        if (lastUserTime > agentState.lastUserMessageTime) {
            // User sent new messages — reset for next idle period
            agentState.deepCycleSinceLastUserMsg = false;
            agentState.lastUserMessageTime = lastUserTime;
        }

        const userIdleMs = Date.now() - lastUserTime;
        const shouldDeepCycle = userIdleMs >= USER_IDLE_DEEP_CYCLE_MS
                             && !agentState.deepCycleSinceLastUserMsg;

        // 1. Assess tree health
        const health = await assessTreeHealth();

        if (newFragCount > 0 || health.unclassified > 0) {
            const mode = shouldDeepCycle ? '🌙深度整合' : '☀️轻量';
            console.log(`[Archivist Agent] Tick [${mode}] 新碎片=${newFragCount} 未分类=${health.unclassified} user空闲=${Math.round(userIdleMs/60000)}min`);
        }

        // 2. Bootstrap (zero-state only) — ensure seed constellations exist
        if (health.categoryCount === 0) {
            console.log('[Archivist] 零状态：创建种子星座 (User + Companion)');
            const db = getDb();
            const { USER, AI } = require('../memoryConfig');
            db.prepare(`INSERT OR IGNORE INTO entity_profiles (name, category, status) VALUES (?, 'person', 'active')`).run(USER.name);
            db.prepare(`INSERT OR IGNORE INTO entity_profiles (name, category, status) VALUES (?, 'person', 'active')`).run(AI.name);
            if (agentState.treeChanged) _refreshWhisper();
            agentState.inTick = false;
            return;
        }

        // ═══════════════════════════════════════
        // LIGHTWEIGHT TASKS — always run, zero ChromaDB + zero LLM
        // ═══════════════════════════════════════

        // 3. Classification (lightweight: keyword match, zero LLM)
        if (health.unclassified >= 5) {
            await runTaskIfDue('classify', () => classifyFragments({ lightweight: !shouldDeepCycle }), MIN_GAP_CLASSIFY);
        }

        // 4. Music & Book extraction (DB-only, ChromaDB indexing deferred to deep cycle)
        await runTaskIfDue('musicExtract', async () => {
            try {
                const { extractMusicFragments } = require('../musicMemoryExtractor');
                const result = await extractMusicFragments({ skipChromaDB: !shouldDeepCycle });
                if (result.extracted > 0) agentState.treeChanged = true;
                return result;
            } catch (_) { return null; }
        }, MIN_GAP_MUSIC_EXTRACT);

        await runTaskIfDue('bookExtract', async () => {
            try {
                const { extractBookFragments } = require('../bookMemoryExtractor');
                const result = await extractBookFragments({ skipChromaDB: !shouldDeepCycle });
                if (result.extracted > 0) agentState.treeChanged = true;
                return result;
            } catch (_) { return null; }
        }, MIN_GAP_BOOK_EXTRACT);

        // 5d. Lightweight evidence matching — zero LLM + zero ChromaDB
        // Matches new fragments against user_model entries via keyword overlap
        if (newFragCount > 0) {
            try {
                matchEvidenceFromFragments();
                // harvestFacts v4.8 退役：User 客观事实走 entity_profiles 档案，不再产 immutable_fact
                // harvestFacts();
            } catch (e) {
                console.error('[Archivist] 轻量模型维护失败:', e.message);
            }
        }

        // 5e. User Model decay — pure math, zero LLM, zero ChromaDB
        // TTL expiry / hypothesis abandon / trait contradiction flagging / dormant marking
        // These are timer-based state transitions that must run regardless of deep cycle.
        // (v4.9 regression: these were locked inside runUserModelCycle → deep cycle,
        //  causing current_state TTL to never fire when User is active.)
        await runTaskIfDue('processUserDecay', () => {
            try {
                const result = processModelDecay();
                if (result && (result.resolved > 0 || result.abandoned > 0 || result.flagged > 0 || result.dormant > 0)) {
                    // Only log when something actually happened
                }
                return result;
            } catch (e) {
                console.error('[Archivist] processModelDecay 失败:', e.message);
                return null;
            }
        }, 2 * 60 * 1000);  // every 2 min (every tick)

        await runTaskIfDue('resolveExpiredStates', () => {
            try {
                return resolveExpiredStates();
            } catch (e) {
                console.error('[Archivist] resolveExpiredStates 失败:', e.message);
                return null;
            }
        }, 5 * 60 * 1000);  // every 5 min (fallback for >14d states, doesn't need frequent runs)

        // 5f. Auto-link literal entity mentions — pure SQL LIKE, zero LLM
        // Seeds stuck at fc=2 need just one more link to cross graduation threshold.
        // Low confidence (0.40) — deep cycle rematch upgrades to 0.60+.
        await runTaskIfDue('autoLink', () => {
            try {
                return autoLinkLiteralMentions();
            } catch (e) {
                console.error('[Archivist] autoLinkLiteralMentions 失败:', e.message);
                return null;
            }
        }, MIN_GAP_AUTO_LINK);

        // 5g. Aggregate linker — route music/book fragments to aggregate entities
        // These fragments are excluded from star map classification, but still need
        // a home. Linked to aggregate entities (音乐/共读) in 爱好 galaxy.
        await runTaskIfDue('aggregateLink', () => {
            try {
                // 按值标路由的那几颗也跟着补链（正常情况下提取时已经链好了，
                // 这里兜住"星座后建/当初写库失败"的尾巴以及存量）
                linkTaggedFragments(db);
                return linkAggregateFragments();
            } catch (e) {
                console.error('[Archivist] aggregateLink 失败:', e.message);
                return null;
            }
        }, MIN_GAP_AUTO_LINK);

        // 5h. Zero-fragment cleanup — entities created >7d ago that never got fragments
        const CLEANUP_ZEROFRAG_MS = 12 * 60 * 60 * 1000;
        await runTaskIfDue('zeroFragCleanup', () => {
            try {
                const db = getDb();
                const cleaned = db.prepare(`
                    UPDATE entity_profiles SET status = 'superseded', updated_at = datetime('now')
                    WHERE status = 'active'
                      AND fragment_count = 0
                      AND name NOT IN (${SKIP_PH})
                      AND created_at < datetime('now', '-7 days')
                `).run(...SKIP_NAMES);
                if (cleaned.changes > 0) {
                    console.log(`[Archivist] 🧹 零碎片清理: ${cleaned.changes} 个实体标记 superseded`);
                }
                return { cleaned: cleaned.changes };
            } catch (e) {
                console.error('[Archivist] zeroFragCleanup 失败:', e.message);
                return null;
            }
        }, CLEANUP_ZEROFRAG_MS);

        // 5i. Entity overview regeneration — NOT gated behind deep cycle.
        // Stale overviews degrade entity context quality in every chat.
        // Each entity costs one cheap LLM call; 30min cooldown prevents abuse.
        await runTaskIfDue('entity_overviews', async () => {
            if (health.staleEntityOverviews > 0) {
                console.log(`[Archivist] 📝 轻量概述更新: ${health.staleEntityOverviews} 个实体概述需更新`);
                return regenerateEntityOverviews();
            }
            return { skipped: true, reason: 'no stale overviews' };
        }, MIN_GAP_ENTITY_OVERVIEWS);

        // ═══════════════════════════════════════
        // DEEP CYCLE TASKS — LLM-heavy, only when User idle > 1h
        // ═══════════════════════════════════════

        if (shouldDeepCycle) {
            // Memory gate
            if (!_checkMemoryGate(MIN_FREE_MEMORY_MB, '深度整合周期')) {
                agentState.inTick = false;
                return;
            }

            console.log('[Archivist Agent] 🦉 进入深度整合周期');

            // ── Phase 0: Decide what to do ──
            const llmAvailable = _countRemainingLLM();
            const gardenPlan = await decideGardenAction(health, llmAvailable);

            // ── Phase 1: Execute tasks in decided order ──
            // Dispatch table: task name → { fn, cooldown, condition }
            const MAX_CLASSIFY_ROUNDS = 5;
            const LLM_RESERVE_PER_ROUND = 20;
            const db = getDb();

            const dispatch = {
                classify: async () => {
                    let classifyRounds = 0;
                    while (classifyRounds < MAX_CLASSIFY_ROUNDS && _canCallLLM(LLM_RESERVE_PER_ROUND + 25)) {
                        const rem = db.prepare(`SELECT COUNT(*) as c FROM memory_fragments WHERE status = 'active' AND id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)`).get()?.c || 0;
                        if (rem < 1) break;  // 即使1条也跑LLM分类(碎片少时LLM调用也小)
                        if (!_checkMemoryGate(MEMORY_CHECK_GRACE_MB, `分类第${classifyRounds + 1}轮`)) break;
                        const result = await runTask('classify', () => classifyFragments({ lightweight: false }));
                        if (!result || result.classified === 0) break;
                        classifyRounds++;
                    }
                    if (classifyRounds > 0) {
                        console.log(`[Archivist Agent] 分类循环: ${classifyRounds} 轮`);
                        agentState.lastClassify = Date.now();
                    }
                    // Post-classify: spot-check low-confidence links
                    await spotCheckClassifications();
                    return { classified: classifyRounds };
                },

                rematch:         async () => runTaskIfDue('rematch', rematchFragmentsForSeeds, MIN_GAP_REMATCH),
                semanticRematch: async () => runTaskIfDue('semanticRematch', semanticRematchForSeeds, MIN_GAP_SEMANTIC_REMATCH),
                seedMerge:       async () => runTaskIfDue('seedMerge', mergeDuplicateSeeds, MIN_GAP_SEED_MERGE),
                graduate:        async () => graduateSeedsAndPrune(),
                emergence:       async () => runTaskIfDue('emergentDetection', detectEmergentPlacesAndEvents, MIN_GAP_EMERGENT),
                entityRelations: async () => runTaskIfDue('relatedEntities', discoverRelatedEntities, MIN_GAP_RELATED_ENTITIES),

                entityOverviews: async () => {
                    if (health.staleEntityOverviews > 0)
                        return runTaskIfDue('entity_overviews', regenerateEntityOverviews, MIN_GAP_ENTITY_OVERVIEWS);
                    return { skipped: true, reason: 'no stale overviews' };
                },
                entityScan:      async () => runTaskIfDue('entityScan', scanContentForNewEntities, MIN_GAP_ENTITY_VERIFY),
                insights:        async () => {
                    if (health.needsInsight >= 10)
                        return runTaskIfDue('insights', () => extractFragmentInsights(INSIGHT_BATCH_MAX), MIN_GAP_INSIGHTS);
                    return { skipped: true, reason: `needsInsight=${health.needsInsight}` };
                },
                episodeAudit:    async () => runTaskIfDue('episodeAudit', auditNewEpisodes, MIN_GAP_EPISODE_AUDIT),
                userModel:      async () => runTaskIfDue('userModel', runUserModelCycle, MIN_GAP_USER_MODEL),
                stop:            async () => 'stop',
            };

            // ── User Model always runs (not optional — core cognitive maintenance) ──
            await dispatch.userModel();

            for (const taskName of gardenPlan) {
                if (taskName === 'stop') break;
                const handler = dispatch[taskName];
                if (!handler) continue;
                if (!_canCallLLM(1) && taskName !== 'classify') {
                    console.log(`[Archivist] 🌿 跳过 ${taskName}: LLM配额耗尽 (已用${agentState.tickLLMCalls})`);
                    continue;
                }
                const taskStart = Date.now();
                console.log(`[Archivist] 🌿 ▶ ${taskName}...`);
                try {
                    const result = await handler();
                    const elapsed = Date.now() - taskStart;
                    // Write to ontology_changelog so 观星手记 can display
                    _logGardenActivity(taskName, result);
                    if (result) {
                        const summary = typeof result === 'object'
                            ? Object.entries(result).filter(([,v]) => v !== 0 && v !== false && v !== null && v !== undefined)
                                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0,60) : v}`).join(' ')
                            : result;
                        console.log(`[Archivist] 🌿 ✓ ${taskName} (${(elapsed/1000).toFixed(1)}s): ${summary || 'done'}`);
                    } else {
                        console.log(`[Archivist] 🌿 ○ ${taskName} (${(elapsed/1000).toFixed(1)}s): 跳过(冷却中或无待处理项)`);
                    }
                } catch (e) {
                    console.error(`[Archivist] 🌿 ✗ ${taskName}:`, e.stack || e.message);
                }
            }

            // Always write a deep cycle summary to 观星手记
            try {
                const db2 = getDb();
                const unclassifiedNow = db2.prepare(`SELECT COUNT(*) as c FROM memory_fragments WHERE status='active' AND id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)`).get()?.c || 0;
                const seedsNow = db2.prepare(`SELECT COUNT(*) as c FROM entity_profiles WHERE status='seed'`).get()?.c || 0;
                db2.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, confidence, status)
                    VALUES ('deep_cycle', ?, ?, 0.80, 'completed')`)
                    .run('深循环完成', JSON.stringify({
                        llm_calls: agentState.tickLLMCalls,
                        unclassified_remaining: unclassifiedNow,
                        seeds_remaining: seedsNow,
                    }));
            } catch (_) {}

            console.log(`[Archivist] 🌿 园艺完成 (LLM: ${agentState.tickLLMCalls}次)`);

            // ── Phase 2: Always-run maintenance (zero LLM) ──
            // Intuition stopwords refresh
            await runTaskIfDue('intuitionStopwords', refreshIntuitionStopwords, MIN_GAP_RELATED_ENTITIES);

            // Skills pattern discovery
            await runTaskIfDue('skills', async () => {
                try {
                    const skm = require('../skillManager');
                    const scan = await skm.scanForPatterns();
                    const evalRes = await skm.evaluateSkills();
                    return { scanned: scan ? 'done' : 'none', evaluated: evalRes ? 'done' : 'none' };
                } catch (_) { return null; }
            }, MIN_GAP_SKILLS);

            // Tool-based relationship discovery (separate from entityRelations)
            await runTaskIfDue('relationships', () => {
                const tool = getTool('discover_relationships');
                return tool ? tool.handler({ includeReEval: true }) : { discovered: 0 };
            }, MIN_GAP_RELATIONSHIPS);

            // ChromaDB stale cleanup
            try {
                const { cleanupStaleChromaEntries } = require('../memory');
                await cleanupStaleChromaEntries();
            } catch (_) {}

            // Cognitive fusion
            try {
                const { fuseCorrections } = require('../cognitiveEvolution');
                await fuseCorrections();
            } catch (_) {}

            // Mark deep cycle as done for this idle period
            agentState.deepCycleSinceLastUserMsg = true;
            console.log('[Archivist Agent] 🦉 深度整合周期完成');
        }

        // 17. Whisper refresh — after any tree change
        if (agentState.treeChanged) {
            _refreshWhisper();
        }

    } finally {
        agentState.inTick = false;
        const elapsed = Date.now() - tickStart;
        if (elapsed > 30000) {
            console.log(`[Archivist Agent] ⚠️ Tick 耗时 ${(elapsed/1000).toFixed(0)}s (LLM: ${agentState.tickLLMCalls})`);
        }
    }
}


// ═══════════════════════════════════════════════════════
// Tree Health Assessment — Agent 的"眼睛"
// ═══════════════════════════════════════════════════════

async function assessTreeHealth() {
    const db = getDb();

    // v4.7: categoryCount = active entity_profiles (constellations), not memory_ontology
    const categoryCount = (db.prepare("SELECT COUNT(*) as c FROM entity_profiles WHERE status = 'active'").get()?.c || 0);

    // Unclassified fragments — those not yet in fragment_entities
    // Music/book fragments are intentionally excluded: they're data exhaust
    // (listening/reading logs), not memory fragments about people/places/events.
    // They're harvested by musicMemoryExtractor/bookMemoryExtractor separately.
    const unclassified = db.prepare(`
        SELECT COUNT(*) as c FROM memory_fragments
        WHERE status = 'active'
          AND source NOT IN ('music', 'book')
          AND id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)
    `).get()?.c || 0;

    // Unclassified by source type
    const unclassifiedBySource = db.prepare(`
        SELECT source, COUNT(*) as c FROM memory_fragments
        WHERE status = 'active'
          AND id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)
        GROUP BY source ORDER BY c DESC
    `).all();

    // Fragments needing insights
    const needsInsight = db.prepare(`
        SELECT COUNT(*) as c FROM memory_fragments
        WHERE insight IS NULL AND status = 'active'
          AND content IS NOT NULL AND mem_len('memory_fragments:content', content) > 10
    `).get()?.c || 0;

    // Entity overviews needing update
    const staleEntityOverviews = _countStaleEntityOverviews(db);

    // Missing relationships (entities without relationship_to_user, with enough fragments)
    const missingRelations = db.prepare(`
        SELECT COUNT(*) as c FROM entity_profiles ep
        WHERE ep.category = 'person'
          AND ep.name NOT IN (${SKIP_PH})
          AND (ep.relationship_to_user IS NULL OR ep.relationship_to_user = '')
          AND (SELECT COUNT(*) FROM memory_fragments WHERE entity_id = ep.id AND status = 'active') >= ?
    `).get(...SKIP_NAMES, ENTITY_DISCOVERY_MIN_FRAGS)?.c || 0;

    // Stale relationships (low-confidence or 30-day-old high-confidence)
    const staleRelations = db.prepare(`
        SELECT COUNT(*) as c FROM entity_profiles ep
        WHERE ep.category = 'person'
          AND ep.name NOT IN (${SKIP_PH})
          AND (
            (ep.relationship_confidence IN ('low', 'medium') AND (ep.last_evaluated_at IS NULL OR ep.last_evaluated_at < datetime('now', '-1 day')))
            OR (ep.relationship_confidence = 'high' AND ep.last_evaluated_at < datetime('now', '-30 days'))
          )
          AND (SELECT COUNT(*) FROM memory_fragments WHERE entity_id = ep.id AND status = 'active') >= 3
    `).get(...SKIP_NAMES)?.c || 0;

    // Pending high-confidence proposals
    const pendingProposals = db.prepare(`
        SELECT COUNT(*) as c FROM ontology_changelog
        WHERE confidence >= 0.85 AND status = 'pending'
    `).get()?.c || 0;

    return {
        categoryCount,
        unclassified,
        unclassifiedBySource: unclassifiedBySource || [],
        needsInsight,
        staleEntityOverviews,
        missingRelations,
        staleRelations,
        pendingProposals,
    };
}


function _countStaleEntityOverviews(db) {
    const entities = db.prepare(`
        SELECT ep.id, ep.name, ep.overview, ep.overview_updated_at,
               ep.last_eval_frag_count, ep.aliases, ep.tags
        FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND ep.name NOT IN (${SKIP_PH})
    `).all(...SKIP_NAMES);

    const thirtyDaysAgo = db.prepare("SELECT datetime('now', '-30 days') as d").get().d;

    let count = 0;
    for (const ent of entities) {
        const currentCount = db.prepare(
            "SELECT COUNT(*) as c FROM fragment_entities WHERE entity_id = ?"
        ).get(ent.id)?.c || 0;

        if (currentCount === 0) continue;

        // 1. 从未有过概述
        if (!ent.overview) { count++; continue; }

        // 2. 碎片数变化 ≥20% 或 ≥3
        const prevCount = ent.last_eval_frag_count || 0;
        const growth = currentCount - prevCount;
        if ((prevCount > 0 && Math.abs(growth) / prevCount >= 0.2) || Math.abs(growth) >= 3) {
            count++; continue;
        }

        // 3. 超过30天未更新概述
        if (!ent.overview_updated_at || ent.overview_updated_at < thirtyDaysAgo) {
            count++; continue;
        }

        // 4. 缺少别名或标签（低优先级回填）
        let existingAliases = [];
        let existingTags = [];
        try { existingAliases = JSON.parse(ent.aliases || '[]'); } catch (_) {}
        try { existingTags = JSON.parse(ent.tags || '[]'); } catch (_) {}
        if (existingAliases.length === 0 || existingTags.length === 0) {
            if (ent.overview_updated_at && ent.overview_updated_at >= db.prepare("SELECT datetime('now', '-1 day') as d").get().d) {
                continue;
            }
            count++; continue;
        }
    }
    return count;
}


// ═══════════════════════════════════════════════════════
// Legacy API Compatibility
// ═══════════════════════════════════════════════════════

// Agent loop is the primary entry (replaces the old cron-based runArchivist)
// For backwards compat, also accepts being called without arguments
// ═══════════════════════════════════════════════════════
// Merge Executor — consolidate overlapping categories
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Auto-merge overlapping categories (zero LLM, pure SQL)
// Detects when a small category is mostly contained in a larger one
// and auto-merges without LLM confirmation.
// ═══════════════════════════════════════════════════════

// Extract keywords from a category path for overlap safety check
// ═══════════════════════════════════════════════════════
// decideGardenAction — 深循环决策：flash-lite 看全景 → 决定任务优先级
// ================================================================
// 替代固定任务序列。不替代 runTaskIfDue 的冷却机制——决策只排顺序，
// 冷却仍然由 runTaskIfDue 强制执行。
// ═══════════════════════════════════════════════════════

const GARDEN_DECISION_COOLDOWN = 10 * 60 * 1000; // 10min 冷却


const GARDEN_TASKS = {
    classify:        { desc: '碎片分类(LLM批分类)', llm: true,  gapKey: 'MIN_GAP_CLASSIFY' },
    rematch:         { desc: '字面回补(LIKE→LLM确认)', llm: true,  gapKey: 'MIN_GAP_REMATCH' },
    semanticRematch: { desc: '语义回补(ChromaDB+LLM)', llm: true,  gapKey: 'MIN_GAP_SEMANTIC_REMATCH' },
    seedMerge:       { desc: '种子合并(LLM别名检测)', llm: true,  gapKey: 'MIN_GAP_SEED_MERGE' },
    graduate:        { desc: '种子毕业(LLM验证)', llm: true,  gapKey: null },
    emergence:       { desc: '涌现检测(聚类+LLM)', llm: true,  gapKey: 'MIN_GAP_EMERGENT' },
    entityRelations: { desc: '实体关系发现(LLM)', llm: true,  gapKey: 'MIN_GAP_RELATED_ENTITIES' },
    entityOverviews: { desc: '实体概述更新(LLM)', llm: true,  gapKey: 'MIN_GAP_ENTITY_OVERVIEWS' },
    episodeAudit:    { desc: 'Episode质检(LLM)', llm: true,  gapKey: 'MIN_GAP_EPISODE_AUDIT' },
    insights:        { desc: '碎片洞察提取(LLM)', llm: true,  gapKey: 'MIN_GAP_INSIGHTS' },
    entityScan:      { desc: '新实体扫描(LLM)', llm: true,  gapKey: 'MIN_GAP_ENTITY_VERIFY' },
    userModel:      { desc: 'User Model认知维护', llm: true,  gapKey: 'MIN_GAP_USER_MODEL' },
    stop:            { desc: '本轮无事可做，停止', llm: false, gapKey: null },
};


const GAP_VALUE_MAP = {};
GAP_VALUE_MAP.MIN_GAP_CLASSIFY = MIN_GAP_CLASSIFY;
GAP_VALUE_MAP.MIN_GAP_REMATCH = MIN_GAP_REMATCH;
GAP_VALUE_MAP.MIN_GAP_SEMANTIC_REMATCH = MIN_GAP_SEMANTIC_REMATCH;
GAP_VALUE_MAP.MIN_GAP_SEED_MERGE = MIN_GAP_SEED_MERGE;
GAP_VALUE_MAP.MIN_GAP_EMERGENT = MIN_GAP_EMERGENT;
GAP_VALUE_MAP.MIN_GAP_RELATED_ENTITIES = MIN_GAP_RELATED_ENTITIES;
GAP_VALUE_MAP.MIN_GAP_ENTITY_OVERVIEWS = MIN_GAP_ENTITY_OVERVIEWS;
GAP_VALUE_MAP.MIN_GAP_EPISODE_AUDIT = MIN_GAP_EPISODE_AUDIT;
GAP_VALUE_MAP.MIN_GAP_INSIGHTS = MIN_GAP_INSIGHTS;
GAP_VALUE_MAP.MIN_GAP_ENTITY_VERIFY = MIN_GAP_ENTITY_VERIFY;
GAP_VALUE_MAP.MIN_GAP_USER_MODEL = MIN_GAP_USER_MODEL;


async function decideGardenAction(health, llmAvailable) {
    const db = getDb();
    const now = Date.now();

    // Build task cooldown summary
    const taskStatus = {};
    for (const [name, info] of Object.entries(GARDEN_TASKS)) {
        const key = _taskKey(name);
        const lastRun = agentState[key] || 0;
        const gapMs = info.gapKey ? (GAP_VALUE_MAP[info.gapKey] || 0) : 0;
        const remainingSec = lastRun ? Math.max(0, Math.round((gapMs - (now - lastRun)) / 1000)) : 0;
        taskStatus[name] = { desc: info.desc, llm: info.llm, ready: remainingSec === 0, cooldownRemaining: remainingSec };
    }

    // Detailed snapshot
    const seedsAtRisk = db.prepare(`SELECT COUNT(*) as c FROM entity_profiles WHERE status = 'seed' AND fragment_count = 2`).get()?.c || 0;
    const seedsReady = db.prepare(`SELECT COUNT(*) as c FROM entity_profiles WHERE status = 'seed' AND fragment_count >= 3`).get()?.c || 0;
    const recentSeeds = db.prepare(`SELECT name, category, fragment_count FROM entity_profiles WHERE status = 'seed' AND fragment_count >= 2 ORDER BY fragment_count DESC LIMIT 10`).all();

    // v5.5: 过时overview详情
    const staleEntities = db.prepare(`
        SELECT ep.id, ep.name, ep.category,
               (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) as fc,
               ep.last_eval_frag_count,
               ROUND(CAST(julianday('now') - julianday(COALESCE(ep.overview_updated_at, ep.created_at)) AS REAL)) as days_stale
        FROM entity_profiles ep
        WHERE ep.status = 'active' AND ep.fragment_count >= 3
          AND ep.name NOT IN (${SKIP_PH})
          AND (ep.overview_updated_at IS NULL
               OR ep.overview_updated_at < datetime('now', '-1 day'))
          AND (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) > COALESCE(ep.last_eval_frag_count, 0)
        ORDER BY days_stale DESC
        LIMIT 8
    `).all(...SKIP_NAMES);

    // Fast path: nothing to do
    const hasWork = health.unclassified >= 5 || seedsReady > 0 || seedsAtRisk > 5
        || health.needsInsight >= 10 || health.staleEntityOverviews > 0;
    if (!hasWork && !taskStatus.userModel?.ready) {
        console.log('[Archivist] 🌿 花园无需打理');
        return ['stop'];
    }
    if (llmAvailable < 3) {
        console.log(`[Archivist] 🌿 LLM配额不足(${llmAvailable})，仅跑分类`);
        return ['classify', 'stop'];
    }

    const prompt = `你是AI伴侣的园艺助手。看一眼记忆花园状态，决定本轮做什么。

═══ 花园现状 ═══
未分类碎片: ${health.unclassified} | 活跃星座: ${health.categoryCount}
fc=2种子(差1条可毕业): ${seedsAtRisk}颗 | fc≥3种子(已可毕业): ${seedsReady}颗
需洞察碎片: ${health.needsInsight} | 需更新概述: ${health.staleEntityOverviews}
${staleEntities.length > 0 ? '═══ 过时概述 ═══\n' + staleEntities.map(s => `  ${s.name}(${s.category}): ${s.fc}碎片, 上次更新${s.days_stale}天前`).join('\n') + '\n' : ''}
可用LLM配额: ${llmAvailable}

═══ 种子详情 ═══
${recentSeeds.length > 0 ? recentSeeds.map(s => `  ${s.name}(${s.category}) fc=${s.fragment_count}`).join('\n') : '  (无高风险种子)'}

═══ 任务冷却 ═══
${Object.entries(taskStatus).filter(([n]) => n !== 'stop').map(([n, s]) => `  ${n}: ${s.ready ? '✅就绪' : '⏳' + s.cooldownRemaining + 's'} — ${s.desc}`).join('\n')}

═══ 规则 ═══
- fc=2种子多→优先rematch/classify攒碎片→然后graduate
- 积压多→优先classify
- 都没急事→选stop
- 一次2-4个任务即可
- 冷却中的任务选了也会被跳过

输出JSON: {"tasks":["task1","task2"],"reasoning":"一句话"}`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.1, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_VERIFY_CONFIG_ID
        );
        agentState.dailyLLMCalls++;
        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { console.log('[Archivist] 🌿 决策解析失败，默认顺序'); return ['classify', 'rematch', 'graduate', 'stop']; }
        const decision = JSON.parse(jsonMatch[0]);
        console.log(`[Archivist] 🌿 园艺决策: ${(decision.tasks || []).join(' → ')} — ${decision.reasoning || ''}`);
        return decision.tasks || ['stop'];
    } catch (e) {
        console.error('[Archivist] 🌿 决策调用失败:', e.message);
        return ['classify', 'rematch', 'graduate', 'stop'];
    }
}

module.exports = {
    start,
    stop,
    getStatus,
    onNewFragments,
    FLASH_MIN_COUNT,
    FLASH_EW_THRESHOLD,
    FLASH_SPIKE_THRESHOLD,
    maybeTriggerFlashConsolidation,
    scheduleTick,
    getLastUserMessageTime,
    agentTick,
    assessTreeHealth,
    _countStaleEntityOverviews,
    GARDEN_DECISION_COOLDOWN,
    GARDEN_TASKS,
    GAP_VALUE_MAP,
    decideGardenAction,
};
