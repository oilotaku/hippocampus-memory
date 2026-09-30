// =================================================================
// Archivist Agent — 记忆认知核心
//
// 自主节律：Agent 循环 (2min tick) + 事件驱动 + Companion 感知
// 职责：分类碎片、维护知识树、发现关系、提取洞察
// 类比：养一棵树 — 浇水(分类)/修剪(拆分)/除草(纠错)/观察(主题发现)
//
// 数据源：聊天消息（经 ingest API 写入）
// 所有数据源的碎片统一走分类管道 → 知识树
// =================================================================

const os = require('os');
const EventEmitter = require('events');
const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { chromaDBOperation } = require('./memory');
const { WORLD_CONTEXT } = require('./worldContext');
const { getTagRouting } = require('./tagRouting');
const { SKIP_NAMES, USER, AI } = require('./memoryConfig');
const { runUserModelCycle, matchEvidenceFromFragments, harvestFacts, processModelDecay, resolveExpiredStates, MIN_GAP_USER_MODEL } = require('./cognitiveModel');
// ── W7 拆分進行中：以下名稱已搬到 services/archivist/ ──
const { SKIP_PH, ARCHIVIST_LLM_CONFIG_ID, ARCHIVIST_VERIFY_CONFIG_ID, TICK_INTERVAL_MS, USER_IDLE_DEEP_CYCLE_MS, ENTITY_DISCOVERY_MIN_FRAGS, INSIGHT_BATCH_MAX, MIN_GAP_CLASSIFY, MIN_GAP_INSIGHTS, MIN_GAP_ENTITY_OVERVIEWS, MIN_GAP_SKILLS, MIN_GAP_RELATIONSHIPS, MIN_GAP_EMERGENT, MIN_GAP_ENTITY_VERIFY, MIN_GAP_MUSIC_EXTRACT, MIN_GAP_BOOK_EXTRACT, MIN_GAP_AUTO_LINK, MIN_GAP_REMATCH, MIN_GAP_SEMANTIC_REMATCH, MIN_GAP_SEED_MERGE, MIN_GAP_RELATED_ENTITIES, MIN_GAP_EPISODE_AUDIT, MIN_FREE_MEMORY_MB, MEMORY_CHECK_GRACE_MB } = require('./archivist/constants');
const { archivistEvents, agentState, _checkMemoryGate, toolRegistry, registerTool, getTool, listTools, isCompanionActive, setCompanionActive, _checkDailyLLMReset, _canCallLLM, _countRemainingLLM, runTask, _logGardenActivity, _taskKey, runTaskIfDue, _refreshWhisper } = require('./archivist/runtime');
const { isTimePhraseName, isPeriodPhraseName, isNoChangeSentinel } = require('./archivist/guards');
const { _mentionWeight, _entityMentionOwners, _aliasAmbiguous, autoLinkLiteralMentions, ensureTagEntities, linkTaggedFragment, linkTaggedFragments, linkAggregateFragments } = require('./archivist/entityLink');
const { generateDailyEntityStatus } = require('./archivist/dailyStatus');
const { reviewEntityRelations, discoverTagRelations, discoverRelatedEntities } = require('./archivist/relations');
const { mergeDuplicateSeeds, executeEntityMerge, graduateSeedsAndPrune } = require('./archivist/seeds');
const { classifyFragments, classifyFragmentBatch, spotCheckClassifications, reviewConstellationAfterClassification } = require('./archivist/classify');
const { rematchFragmentsForSeeds, semanticRematchForSeeds } = require('./archivist/rematch');
const { refreshIntuitionStopwords } = require('./archivist/intuitionStopwords');
const { auditNewEpisodes, consolidateCategory } = require('./archivist/episode');
const { buildEmergentJudgePrompt, screenEmergentVerdict, detectEmergentPlacesAndEvents } = require('./archivist/emergent');
const { MIN_GAP_PATTERN_CLUSTER, maintainPatterns, clusterObservations } = require('./archivist/patterns');
const { regenerateEntityOverviews } = require('./archivist/entityOverview');

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
        const { triggerSkills } = require('./skillManager');
        await triggerSkills({ newFragmentIds: fragmentIds });
    } catch (e) {
        // skillManager may not be loaded yet
    }

    // Throttled whisper invalidation
    try {
        const { onNewData } = require('./whisper');
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

    const { consolidateFlash } = require('./consolidator');
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
            const { USER, AI } = require('./memoryConfig');
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
                const { extractMusicFragments } = require('./musicMemoryExtractor');
                const result = await extractMusicFragments({ skipChromaDB: !shouldDeepCycle });
                if (result.extracted > 0) agentState.treeChanged = true;
                return result;
            } catch (_) { return null; }
        }, MIN_GAP_MUSIC_EXTRACT);

        await runTaskIfDue('bookExtract', async () => {
            try {
                const { extractBookFragments } = require('./bookMemoryExtractor');
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
                    const skm = require('./skillManager');
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
                const { cleanupStaleChromaEntries } = require('./memory');
                await cleanupStaleChromaEntries();
            } catch (_) {}

            // Cognitive fusion
            try {
                const { fuseCorrections } = require('./cognitiveEvolution');
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
          AND content IS NOT NULL AND length(content) > 10
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
// Helper: scanContentForNewEntities
//
// Scans fragment content text for potential person names
// that aren't already in entity_profiles. This catches
// entities that Scribe didn't extract into mf.entity but
// that appear in the content body (e.g. 某昵称 mentioned in
// a fragment where entity='User').
// ═══════════════════════════════════════════════════════

const CONTENT_ENTITY_MIN_OCCURRENCES = 3;
const CONTENT_ENTITY_MAX_CHECK = 15;
const CONTENT_SCAN_FRAG_LIMIT = 500;

const COMMON_WORD_STOPLIST = new Set([
    '自己','我们','他们','你们','她们','它们','什么','怎么','为什么',
    '不知道','没有','可以','不可以','一个','这个','那个','哪个','这些','那些',
    '就是','因为','所以','虽然','但是','如果','已经','还是','或者','不过',
    '而且','然后','现在','以前','以后','可能','应该','觉得','知道','看见',
    '听到','以为','开始','继续','终于','最后','之后','之前','这样','那样',
    '一点','一些','这种','那种','另外','所有','大概','当然','突然','一起',
    '一个人','每个人','没办法','无所谓','有时候','越来越','是不是','能不能',
    '会不会','第一次','大部分','大家好','还可以','差不多','最重要','所有人',
    '很多人','每一天','今天','明天','昨天','今年','去年','上午','下午','晚上',
    '早上','中午','周末','有人','没人','别人','某人','任何人','对方','双方',
    '本人','当事人','告诉你','对不起','亲爱的','请问你','你好吗',
    // Common false positives from fragment content (book/music context)
    '在读','的回应','喜欢了','专辑','的批注','的聊天','在微信','发了一',
    '他对','她说','我对','我说','你说','他说','她说','你说',
    '回复了','收到了','看到了','听到了','想到了','感觉到',
    '这首歌','那首歌','这首歌','那本书','这本书','这篇文章',
    '很喜欢','不喜欢','非常好','还不错','差不多','有意思',
    '没什么','有什么','没什么','是什么','为什么','怎么办',
    '对不起','谢谢你','没关系','不好意思','不客气',
    '我觉得','我认为','我发现','我意识到','我注意到',
    '这件事','那件事','这种事','那种事','什么时候',
    '在哪里','在哪里','怎么办','怎么样','为什么',
    // Book/reading context noise
    '写过一','写了一','翻译了',
    '阅读了','读了一','这本书','那本书','那一本',
    '一本关于','一部关于','一个关于','是关于',
    '第一章','第二章','第三章','第四章','第五章',
    'http','https','www','com','html',
    // Japanese stopwords (generic particles/words)
    'なん','です','ます','した','いる','こと','それ',
    'この','あの','どの','こう','そう','いう','なる',
]);

// English capitalized common words — high noise for Latin name extraction
const EN_STOPLIST = new Set([
    'The','This','That','These','Those','There','Their','They',
    'With','From','When','Where','Which','While','What','Who',
    'Have','Has','Had','Been','Were','Would','Could','Should',
    'About','After','Again','Also','And','Are','But','Can',
    'Did','Does','Done','Each','Even','Every','For','Get',
    'Here','How','Into','Just','Like','Make','Many','More',
    'Much','Must','Not','Now','Only','Other','Over','Part',
    'Same','Said','Some','Such','Take','Than','Then','Very',
    'Was','Way','Well','Were','Will','Your','You',
    'Chapter','Page','Part','Book','Note','Line','Read',
    'She','Her','Him','His','Its',
    // Book/music context Latin noise
    'Love','Soundtrack','Original','Remix','Original','Sound',
    'Mix','Version','Night','Song','Album','Music','Dance',
    'Never','More','Your','Signs','Pursuing','True','Self',
    'Persona','Room','One','Own','Women','Fiction','Life',
    'Time','World','Man','Men','Day','End','New','Old',
    'First','Last','Long','Little','Great','Good','Bad',
    'Right','Left','High','Low','Big','Small','Back',
    'Still','Always','Never','Ever','Something','Nothing',
    'Everything','Anything','Things','Thing','People',
]);

async function scanContentForNewEntities() {
    const db = getDb();

    const knownNames = new Set(SKIP_NAMES);
    const profiles = db.prepare("SELECT name, aliases FROM entity_profiles").all();
    for (const p of profiles) {
        knownNames.add(p.name);
        if (p.aliases) {
            try {
                const aliases = JSON.parse(p.aliases);
                for (const a of aliases) knownNames.add(a);
            } catch (_) {}
        }
    }

    const fragments = db.prepare(`
        SELECT id, content FROM memory_fragments
        WHERE status = 'active' AND content != ''
        ORDER BY id DESC LIMIT ?
    `).all(CONTENT_SCAN_FRAG_LIMIT);

    // Separate candidate pools: CJK/kana (low noise) vs Latin (high noise)
    const CJK_KANA_RE = /[一-鿿]{2,6}|[぀-ゟ]{2,6}|[゠-ヿ]{2,6}/g;
    const LATIN_RE = /[A-Z][a-z]{2,20}/g;
    const cjkCounts = new Map();
    const latinCounts = new Map();

    for (const f of fragments) {
        const text = f.content;

        let m;
        while ((m = CJK_KANA_RE.exec(text)) !== null) {
            if (knownNames.has(m[0])) continue;
            if (COMMON_WORD_STOPLIST.has(m[0])) continue;
            const ex = cjkCounts.get(m[0]);
            if (ex) { ex.count++; }
            else { cjkCounts.set(m[0], { count: 1 }); }
        }

        while ((m = LATIN_RE.exec(text)) !== null) {
            if (knownNames.has(m[0])) continue;
            if (EN_STOPLIST.has(m[0])) continue;
            const ex = latinCounts.get(m[0]);
            if (ex) { ex.count++; }
            else { latinCounts.set(m[0], { count: 1 }); }
        }
    }

    // CJK/kana: min 3 occurrences
    const cjkSorted = [...cjkCounts.entries()]
        .filter(([_, v]) => v.count >= CONTENT_ENTITY_MIN_OCCURRENCES)
        .sort((a, b) => b[1].count - a[1].count);

    // Latin: min 5 occurrences (higher bar due to noise), fill remaining slots
    const latinSorted = [...latinCounts.entries()]
        .filter(([_, v]) => v.count >= 5)
        .sort((a, b) => b[1].count - a[1].count);

    // Prioritize CJK/kana, then top up with Latin
    const cjkSlots = Math.min(cjkSorted.length, CONTENT_ENTITY_MAX_CHECK);
    const latinSlots = Math.min(latinSorted.length, CONTENT_ENTITY_MAX_CHECK - cjkSlots);
    const sorted = [
        ...cjkSorted.slice(0, cjkSlots),
        ...latinSorted.slice(0, latinSlots)
    ];

    if (sorted.length === 0) return [];

    const candidatesForLLM = [];
    for (const [name, info] of sorted) {
        const contextFrags = db.prepare(`
            SELECT content FROM memory_fragments
            WHERE status = 'active' AND content LIKE ?
            ORDER BY id DESC LIMIT 5
        `).all(`%${name}%`);

        candidatesForLLM.push({
            name,
            count: info.count,
            contexts: contextFrags.map(f => f.content.substring(0, 200))
        });
    }

    const contextText = candidatesForLLM.map((c, i) =>
        `[${i + 1}] "${c.name}" (出现 ${c.count} 次)\n${c.contexts.map(ctx => `   - ...${ctx}...`).join('\n')}`
    ).join('\n\n');

    const prompt = `你是实体识别器。以下是User记忆碎片中出现频率较高的未知词汇。请判断每个属于什么实体类型。

${contextText}

只输出JSON数组，每个元素：
{"name":"候选词","category":"person|pet|place|event|project|work|term|organization|none","likely_gender":"male/female/unknown"}

判断标准：
- **person**: 真实人物——中文名、英文名、日文名、网名、艺名、圈名、游戏ID
- **place**: 具体地点——城市、景点、场馆、店铺名（不是「家里」「公司」等泛称）
- **event**: 可命名的事件或经历——旅行、聚会、项目节点（不是单次对话）
- **project**: User参与创作或开发的作品/项目——代码项目、同人、cos、视频系列
- **term**: 抽象概念/专有名词——但不属于以上任何一类（如「某作品」「某概念」等）
- **none**: 普通词汇、公司名、品牌名、文学虚构角色、不确定的
- 只输出JSON数组，不要markdown包裹`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.1, maxOutputTokens: 500 },
            ARCHIVIST_LLM_CONFIG_ID
        );

        let text = (response?.reply || '').replace(/```json|```/g, '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
            console.log('[Archivist] 内容实体扫描: LLM返回非JSON数组，跳过');
            return [];
        }

        const results = JSON.parse(match[0]);
        const allCounts = new Map([...cjkCounts, ...latinCounts]);
        const newEntities = results
            .filter(r => r.category && r.category !== 'none')
            .map(r => ({
                name: r.name,
                fragCount: allCounts.get(r.name)?.count || CONTENT_ENTITY_MIN_OCCURRENCES,
                isNew: true,
                isReEval: false,
                entityProfileId: null,
                discoveryMethod: 'content_scan',
                category: r.category || 'person'
            }));

        if (newEntities.length > 0) {
            console.log(`[Archivist] 内容实体扫描: 发现 ${newEntities.length} 个候选 — ${newEntities.map(e => e.name + '(' + e.fragCount + ')').join(', ')}`);
        }

        return newEntities;
    } catch (e) {
        console.error('[Archivist] 内容实体扫描失败:', e.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════
// Tool: discoverEntityRelationships
// ═══════════════════════════════════════════════════════

async function discoverEntityRelationships(options = {}) {
    const db = getDb();
    const includeReEval = options.includeReEval || false;

    // SKIP_NAMES from memoryConfig — already imported at module top

    // Candidates with missing relationships — only if new fragments since last eval
    const missingRelations = db.prepare(`
        SELECT ep.id, ep.name, COUNT(mf.id) as frag_count,
               ep.last_hypothesis, ep.last_eval_frag_count
        FROM entity_profiles ep
        JOIN memory_fragments mf ON mf.entity_id = ep.id
        WHERE ep.category = 'person'
          AND (ep.relationship_to_user IS NULL OR ep.relationship_to_user = '')
          AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
          AND mf.status = 'active'
        GROUP BY ep.id
        HAVING frag_count >= ?
           AND (ep.last_eval_frag_count IS NULL
                OR ep.last_eval_frag_count = 0
                OR frag_count >= ep.last_eval_frag_count + 3)
        ORDER BY frag_count DESC
    `).all(...SKIP_NAMES, ENTITY_DISCOVERY_MIN_FRAGS);

    // Candidates without entity_profiles
    const unknownEntities = db.prepare(`
        SELECT mf.entity, COUNT(*) as cnt
        FROM memory_fragments mf
        WHERE mf.entity != ''
          AND mf.entity NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
          AND mf.entity NOT IN (SELECT name FROM entity_profiles)
          AND mf.entity NOT IN (SELECT COALESCE(value, '') FROM entity_profiles, json_each(aliases))
          AND mf.status = 'active'
        GROUP BY mf.entity
        HAVING cnt >= ?
        ORDER BY cnt DESC
    `).all(...SKIP_NAMES, ENTITY_DISCOVERY_MIN_FRAGS);

    const candidates = [];

    for (const mr of missingRelations) {
        candidates.push({ entityProfileId: mr.id, name: mr.name, fragCount: mr.frag_count,
            isNew: false, isReEval: false,
            lastHypothesis: mr.last_hypothesis, lastEvalFragCount: mr.last_eval_frag_count || 0 });
    }

    for (const ue of unknownEntities) {
        candidates.push({ entityProfileId: null, name: ue.entity, fragCount: ue.cnt, isNew: true, isReEval: false });
    }

    // Content-scanned entities (discovered from fragment content, not mf.entity column)
    const contentEntities = await scanContentForNewEntities();
    for (const ce of contentEntities) {
        if (!candidates.find(c => c.name === ce.name)) {
            candidates.push(ce);
        }
    }

    // Re-evaluation candidates
    if (includeReEval) {
        const lowConfCandidates = db.prepare(`
            SELECT ep.id, ep.name, COUNT(mf.id) as frag_count
            FROM entity_profiles ep
            JOIN memory_fragments mf ON mf.entity_id = ep.id
            WHERE ep.category = 'person'
              AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
              AND ep.relationship_confidence IN ('low', 'medium')
              AND (ep.last_evaluated_at IS NULL OR ep.last_evaluated_at < datetime('now', '-1 day'))
              AND mf.status = 'active'
              AND mf.created_at > COALESCE(ep.last_evaluated_at, '1970-01-01')
            GROUP BY ep.id
            HAVING COUNT(mf.id) >= 3
            ORDER BY frag_count DESC
        `).all(...SKIP_NAMES);

        const staleCandidates = db.prepare(`
            SELECT ep.id, ep.name, COUNT(mf.id) as frag_count
            FROM entity_profiles ep
            JOIN memory_fragments mf ON mf.entity_id = ep.id
            WHERE ep.category = 'person'
              AND ep.name NOT IN (${SKIP_NAMES.map(() => '?').join(',')})
              AND ep.relationship_confidence = 'high'
              AND ep.last_evaluated_at < datetime('now', '-30 days')
              AND mf.status = 'active'
              AND mf.created_at > ep.last_evaluated_at
            GROUP BY ep.id
            HAVING COUNT(mf.id) >= 5
            ORDER BY frag_count DESC
        `).all(...SKIP_NAMES);

        for (const lc of lowConfCandidates) {
            if (!candidates.find(c => c.entityProfileId === lc.id)) {
                candidates.push({ entityProfileId: lc.id, name: lc.name, fragCount: lc.frag_count, isNew: false, isReEval: true });
            }
        }
        for (const sc of staleCandidates) {
            if (!candidates.find(c => c.entityProfileId === sc.id)) {
                candidates.push({ entityProfileId: sc.id, name: sc.name, fragCount: sc.frag_count, isNew: false, isReEval: true });
            }
        }

        if (lowConfCandidates.length > 0 || staleCandidates.length > 0) {
            console.log(`[Archivist] 重评估候选: ${lowConfCandidates.length} 低置信度 + ${staleCandidates.length} 过期`);
        }
    }

    if (candidates.length === 0) {
        return { discovered: 0 };
    }

    console.log(`[Archivist] 实体关系发现: ${candidates.length} 个候选人 (${candidates.map(c => c.name + '(' + c.fragCount + ')' + (c.isReEval ? '[R]' : '')).join(', ')})`);

    let discovered = 0;

    for (const cand of candidates) {
        try {
            let fragments;
            if (cand.discoveryMethod === 'content_scan') {
                fragments = db.prepare(`
                    SELECT id, content, source_date FROM memory_fragments
                    WHERE status = 'active' AND content LIKE ?
                    ORDER BY source_date
                `).all(`%${cand.name}%`);
            } else if (cand.isNew) {
                fragments = db.prepare(`
                    SELECT id, content, source_date FROM memory_fragments
                    WHERE entity = ? AND status = 'active' ORDER BY source_date
                `).all(cand.name);
            } else {
                fragments = db.prepare(`
                    SELECT mf.id, mf.content, mf.source_date FROM memory_fragments mf
                    WHERE mf.entity_id = ? AND mf.status = 'active' ORDER BY mf.source_date
                `).all(cand.entityProfileId);
            }

            if (fragments.length < ENTITY_DISCOVERY_MIN_FRAGS) continue;

            const uniqueContents = [...new Set(fragments.map(f => (f.content || '').trim()))];
            const fragmentTexts = uniqueContents.slice(0, 30)
                .map((c, i) => `[${i + 1}] ${c}`)
                .join('\n\n');

            const firstDate = fragments[0]?.source_date || '';
            const lastDate = fragments[fragments.length - 1]?.source_date || '';

            // Cognitive context from evolution layer
            const { buildCognitiveContext } = require('./cognitiveEvolution');
            const cogCtx = buildCognitiveContext(cand.entityProfileId || 0, cand.name, null);
            if (cogCtx.correctionCount > 0 || cogCtx.ruleCount > 0) {
                console.log(`[Archivist] 认知上下文: ${cogCtx.correctionCount} 条纠错 + ${cogCtx.ruleCount} 条规则`);
            }

            // Progressive re-eval context
            let priorContext = '';
            if (cand.lastHypothesis) {
                const newFragCount = fragments.length - (cand.lastEvalFragCount || 0);
                priorContext = `\n## 上次评估的推断\n上次评估时（${cand.lastEvalFragCount} 条碎片），系统推断「${cand.name}」可能是 **${cand.lastHypothesis}**，但置信度不足以确定。\n此后新增了 ${Math.max(0, newFragCount)} 条碎片。请结合新旧证据重新判断。\n`;
            }

            const prompt = `${WORLD_CONTEXT}

你是人物关系档案员。阅读以下与「${cand.name}」有关的所有记忆碎片，判断这个人和User是什么关系。${priorContext}
注意：Scribe提取的碎片是第三人称转述。原始对话中的"我妈""妈妈说"可能被转写为"${cand.name}为User做了..."。你需要从碎片描述的**互动模式**来推断关系性质。

## 关系判断的线索（按优先级从高到低）：
1. **互动频率和内容** — 天天做饭带饭 → 同居亲人/伴侣/室友。偶尔见面评价作品 → 朋友/同行/前辈。涉及金钱/法律纠纷 → 前任/商业伙伴。
2. **情感色彩** — 关爱照顾 → 长辈/亲人。好感/约会 → 恋爱对象。吐槽/矛盾 → 朋友/前任。
3. **语言线索** — "分手""前任""在一起""结束与X的关系""BE"→前任恋人或已结束的亲密关系。"官宣"→公开的恋爱关系。
4. **排除法** — 如果互动完全围绕日常生活起居（做饭、带饭、同住）→ 家人（而非恋人）。如果互动完全围绕创作评价、艺术讨论 → 很可能是创作者同行或前辈（而非家人）。

${cogCtx.rulesSection}
${cogCtx.correctionsSection}
## 碎片原文（共 ${fragments.length} 条，时间跨度 ${firstDate} ~ ${lastDate}）

${fragmentTexts}

## 任务

输出一个JSON对象，不要markdown包裹：

{"name":"${cand.name}","relationship":"对User而言这个人是谁","relationship_nature":"close/conflicted/complex/distant/dependent","emotional_significance":"这个人在User生活中的情感意义","time_context":"时间背景和最近联系状态","confidence":"high/medium/low","entity_type":"real_person/public_figure/fictional_character/unknown","suggested_category_path":"推荐的知识树路径"}

字段说明：
- entity_type: 这个人的类型
  * "real_person" — User生活中真实认识、有互动的人（朋友/家人/同事/前任等）
  * "public_figure" — 真实存在但User不认识的名人（歌手/演员/作家/网红等）
  * "fictional_character" — 书/游戏/影视里的虚构角色
  * "unknown" — 信息不足以判断
- suggested_category_path: 推荐一个分类标签路径（扁平标签，如 "重要的人/某个朋友"、"音乐/某歌手"、"虚构角色/某作品角色"）。路径仅作为分类建议，不再创建层级节点。

如果碎片信息不足以确定关系（比如只知道这个人出现过但互动模式不明显），confidence设low，relationship写"不确定"。不要强行判断。`;

            const response = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.3, maxOutputTokens: 500 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            let text = (response?.reply || '').replace(/```json|```/g, '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                console.error(`[Archivist] 关系发现 ${cand.name}: LLM返回非JSON`);
                continue;
            }

            const rel = JSON.parse(match[0]);
            const relText = rel.relationship || '';
            const relNature = rel.relationship_nature || '';
            const relEmo = rel.emotional_significance || '';
            const relTime = rel.time_context || '';
            const relConf = rel.confidence || 'medium';
            const entityType = rel.entity_type || 'unknown';

            const existingRel = db.prepare(
                'SELECT relationship_to_user, relationship_confidence FROM entity_profiles WHERE id = ?'
            ).get(cand.entityProfileId);

            // Oscillation guard
            if (existingRel && existingRel.relationship_to_user && existingRel.relationship_to_user !== '') {
                const changeCount = db.prepare(
                    'SELECT COUNT(*) as c FROM cognitive_corrections WHERE entity_id = ?'
                ).get(cand.entityProfileId);
                if (changeCount.c >= 3 && existingRel.relationship_to_user !== relText) {
                    console.warn(`[Archivist] ⚠️ 关系振荡: ${cand.name} 已被修改 ${changeCount.c} 次，跳过本次变更`);
                    console.warn(`  当前: ${existingRel.relationship_to_user} → 拟变更: ${relText}`);
                    db.prepare("UPDATE entity_profiles SET last_evaluated_at = datetime('now') WHERE id = ?")
                        .run(cand.entityProfileId);
                    // Set entity_id on fragments (no knowledge tree nodes)
                    if (cand.entityProfileId) {
                        for (const frag of fragments) {
                            db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                                .run(cand.entityProfileId, frag.id);
                        }
                    }
                    continue;
                }
            }

            // Low confidence: save hypothesis for progressive re-eval, don't commit relationship yet
            if (relConf === 'low' || relText === '不确定' || relText === '') {
                console.log(`[Archivist] 关系发现 ${cand.name}: 信息不足 (confidence=${relConf})，保存假设待重评估`);
                if (cand.isNew) {
                    const info = db.prepare(`
                        INSERT INTO entity_profiles (name, category, entity_type, first_mentioned_date, last_mentioned_date)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(cand.name, cand.category || 'person', entityType, firstDate, lastDate);
                    cand.entityProfileId = info.lastInsertRowid;
                    db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE entity = ? AND entity_id IS NULL')
                        .run(cand.entityProfileId, cand.name);
                }
                if (cand.entityProfileId) {
                    // Save the hypothesis even though we're not confident — enables progressive re-eval
                    const hypothesis = relText !== '不确定' && relText !== '' ? relText : null;
                    db.prepare(`UPDATE entity_profiles
                        SET last_hypothesis = ?,
                            last_eval_frag_count = ?,
                            last_evaluated_at = datetime('now')
                        WHERE id = ?`)
                        .run(hypothesis, fragments.length, cand.entityProfileId);
                }
                // Set entity_id on fragments (no knowledge tree nodes)
                if (cand.entityProfileId) {
                    for (const frag of fragments) {
                        db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                            .run(cand.entityProfileId, frag.id);
                    }
                }
                continue;
            }

            // Correction detection
            if (existingRel && existingRel.relationship_to_user && existingRel.relationship_to_user !== '' &&
                existingRel.relationship_to_user !== relText && relConf === 'high') {

                const { logCorrection, analyzeMispattern } = require('./cognitiveEvolution');
                const oldLabel = existingRel.relationship_to_user;
                const mispattern = await analyzeMispattern(cand.name, oldLabel, relText, fragments);
                const evidence = fragments.slice(0, 3)
                    .map(f => (f.content || '').substring(0, 120))
                    .join(' | ');

                await logCorrection(
                    cand.entityProfileId, cand.name,
                    oldLabel, relText,
                    mispattern, evidence,
                    fragments.length
                );
                console.log(`[Archivist] 纠错: ${cand.name} — "${oldLabel}" → "${relText}" (mispattern: ${mispattern})`);
            }

            if (cand.isNew) {
                const info = db.prepare(`
                    INSERT INTO entity_profiles (name, category, entity_type, relationship_to_user, relationship_nature, emotional_significance, relationship_confidence, last_eval_frag_count, last_evaluated_at, first_mentioned_date, last_mentioned_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
                `).run(cand.name, cand.category || 'person', entityType, relText, relNature, relEmo, relConf, fragments.length, firstDate, lastDate);
                cand.entityProfileId = info.lastInsertRowid;
                db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE entity = ? AND entity_id IS NULL')
                    .run(cand.entityProfileId, cand.name);
                console.log(`[Archivist] 创建 entity_profile: ${cand.name} (id=${cand.entityProfileId}) — ${relText} [confidence=${relConf}]`);
            } else {
                db.prepare(`
                    UPDATE entity_profiles
                    SET relationship_to_user = ?, relationship_nature = ?, emotional_significance = ?,
                        relationship_confidence = ?, last_hypothesis = NULL,
                        entity_type = COALESCE(entity_type, ?),
                        last_eval_frag_count = ?, last_evaluated_at = datetime('now'),
                        first_mentioned_date = COALESCE(first_mentioned_date, ?), last_mentioned_date = ?, updated_at = datetime('now')
                    WHERE id = ?
                `).run(relText, relNature, relEmo, relConf, entityType, fragments.length, firstDate, lastDate, cand.entityProfileId);
                console.log(`[Archivist] 更新 entity_profile: ${cand.name} — ${relText} [confidence=${relConf}]`);
            }

            // Set entity_id on fragments (no knowledge tree nodes)
            if (cand.entityProfileId) {
                for (const frag of fragments) {
                    db.prepare('UPDATE memory_fragments SET entity_id = ? WHERE id = ? AND entity_id IS NULL')
                        .run(cand.entityProfileId, frag.id);
                }
            }
            discovered++;
        } catch (e) {
            console.error(`[Archivist] 关系发现 ${cand.name} 失败:`, e.message);
        }
    }

    return { discovered };
}

// ═══════════════════════════════════════════════════════
// Tool: extractFragmentInsights
// ═══════════════════════════════════════════════════════

async function extractFragmentInsights(batchSize = INSIGHT_BATCH_MAX) {
    const db = getDb();

    const fragments = db.prepare(`
        SELECT mf.id, mf.content, mf.entity_id, mf.entity
        FROM memory_fragments mf
        WHERE mf.insight IS NULL
          AND mf.status = 'active'
          AND mf.content IS NOT NULL
          AND length(mf.content) > 10
        ORDER BY mf.created_at DESC
        LIMIT ?
    `).all(batchSize);

    if (fragments.length === 0) return { extracted: 0 };

    const entityIds = [...new Set(fragments.filter(f => f.entity_id).map(f => f.entity_id))];
    const entityMap = new Map();
    if (entityIds.length > 0) {
        const profiles = db.prepare(`
            SELECT id, name, relationship_to_user, emotional_significance
            FROM entity_profiles WHERE id IN (${entityIds.map(() => '?').join(',')})
        `).all(...entityIds);
        for (const p of profiles) entityMap.set(p.id, p);
    }

    let entityContext = '';
    for (const [id, ep] of entityMap) {
        if (ep.relationship_to_user) {
            entityContext += `- ${ep.name}: ${ep.relationship_to_user}`;
            if (ep.emotional_significance) entityContext += ` (${ep.emotional_significance})`;
            entityContext += '\n';
        }
    }

    const fragmentList = fragments.map((f, i) => {
        const ep = f.entity_id ? entityMap.get(f.entity_id) : null;
        const entityNote = ep && ep.relationship_to_user
            ? ` [已知关系: ${ep.name} — ${ep.relationship_to_user}]`
            : (f.entity ? ` [涉及: ${f.entity}]` : '');
        return `[${i}] ${f.content}${entityNote}`;
    }).join('\n\n');

    const prompt = `${WORLD_CONTEXT}
${entityContext ? '## 人物关系参考\n' + entityContext + '\n' : ''}
你是User的个人认知提取器。阅读以下记忆碎片，提取每条碎片**揭示了User的什么个人特质/价值观/行为模式/情感倾向**。

## 碎片

${fragmentList}

## 任务

对每条碎片，用第三人称一句话概括它揭示了User的什么（性格侧面 / 情感模式 / 价值取向 / 行为规律）。
- 如果碎片只是纯事实记录（如"今天吃了大餐"）没有揭示个人特质，输出 null
- 不要重复碎片内容本身，要提取它**暗示的更深层的东西**
- 句子要有温度，像是在理解一个人而不是分析数据

## 输出格式

只输出一个JSON数组，不要markdown包裹（下面内容是虚构的，只演示格式）：
[{"index":0,"insight":"User在疲惫时会用一个固定的小习惯给自己缓冲，那对User而言是恢复的方式"},{"index":2,"insight":"User对某类事物有一套自己的取舍标准，平时很少明说但一直在按它选","dimension":"emotional"},{"index":3,"insight":null}]`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.2, maxOutputTokens: Math.max(800, batchSize * 50) },
            ARCHIVIST_VERIFY_CONFIG_ID
        );

        let text = (response?.reply || '').replace(/```json|```/g, '').trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
            console.error('[Archivist] insight 提取: LLM返回非JSON数组');
            return { extracted: 0 };
        }

        const results = JSON.parse(match[0]);
        const updateStmt = db.prepare('UPDATE memory_fragments SET insight = ? WHERE id = ?');

        let extracted = 0;
        for (const r of results) {
            if (r.insight && r.insight !== 'null' && fragments[r.index]) {
                updateStmt.run(r.insight, fragments[r.index].id);
                extracted++;
            }
        }

        console.log(`[Archivist] insight 提取: ${extracted}/${fragments.length} 条`);
        return { extracted };
    } catch (e) {
        console.error('[Archivist] insight 提取失败:', e.message);
        return { extracted: 0 };
    }
}

// ═══════════════════════════════════════════════════════
// Tool Registration — called after module loads
// ═══════════════════════════════════════════════════════

function registerAllTools() {
    registerTool('classify_fragments', classifyFragments,
        '未分类碎片自动分类（质心相似度 + LLM校验）');
    registerTool('discover_relationships', discoverEntityRelationships,
        '从碎片中推断人物与User的关系，创建/更新 entity_profiles');
    registerTool('extract_insights', extractFragmentInsights,
        '提取碎片揭示的User个人特质/价值观/行为模式');
    registerTool('detect_emergent_places_events', detectEmergentPlacesAndEvents,
        '涌现地点/事件检测：聚类未链接place/event的碎片，补漏掉的星座');
    registerTool('regenerate_entity_overviews', regenerateEntityOverviews,
        '为实体生成 Companion 视角的叙事概述');
    registerTool('maintain_patterns', maintainPatterns,
        '维护已有行为模式——bigram匹配新碎片、追加证据、刷新freshness、检测漂移',
        'bigram', 'zero', 'zero', { cooldown: MIN_GAP_PATTERN_CLUSTER },
        '轻量维护已有行为模式（零LLM+零ChromaDB）');
    registerTool('cluster_observations', clusterObservations,
        '行为模式聚类（maintainPatterns别名，兼容旧调度）',
        'bigram', 'zero', 'zero', { cooldown: MIN_GAP_PATTERN_CLUSTER },
        '行为模式维护和聚类');
    registerTool('consolidate_category', consolidateCategory,
        '按类别合并高密度碎片的碎片为episode，更新描述和质心');
}

// Register on load (once only — require() may re-enter via entityResolver circular imports)
if (!global.__archivistToolsRegistered) {
    global.__archivistToolsRegistered = true;
    registerAllTools();
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

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

module.exports = {
    // 按值标路由的聚合星座（测试/脚本要用）
    ensureTagEntities,
    linkTaggedFragment,
    linkTaggedFragments,
    // 守卫规则（导出供回归测试复用；改名单/哨兵词表时先看 archivistGuards.test.js）
    isTimePhraseName,
    isPeriodPhraseName,
    isNoChangeSentinel,
    // 涌现判据（导出供回归探针复用，别另抄一份会走样的）
    buildEmergentJudgePrompt,
    screenEmergentVerdict,
    // 别名的三道门（字面链接器用它决定哪些别名敢拿去 LIKE 匹配）。
    // 导出供回归测试复用——改判据时先看 archivistGuards.test.js 的第 4 节。
    _mentionWeight,
    _aliasAmbiguous,
    _entityMentionOwners,
    // 关系表体检 + 标签桥（导出供一次性清理脚本 + 探针复用）
    reviewEntityRelations,
    discoverTagRelations,
    // Agent lifecycle
    start,
    stop,
    getStatus,
    setCompanionActive,
    isCompanionActive,
    archivistEvents,

    // Tool registry
    registerTool,
    getTool,
    listTools,

    // Individual tools (direct access)
    classifyFragments,
    classifyFragmentBatch,
    rematchFragmentsForSeeds,
    semanticRematchForSeeds,
    mergeDuplicateSeeds,
    executeEntityMerge,
    discoverRelatedEntities,
    detectEmergentPlacesAndEvents,
    refreshIntuitionStopwords,
    // 仅供独立脚本（classifyBacklog/growFromScratch）逐轮重置 tick 预算，服务进程不要调
    resetTickBudget: () => { agentState.tickLLMCalls = 0; },
    graduateSeedsAndPrune,

    // User behavior patterns (v5.10)
    maintainPatterns,
    clusterObservations,
    spotCheckClassifications,
    reviewConstellationAfterClassification,
    discoverEntityRelationships,
    extractFragmentInsights,
    regenerateEntityOverviews,
    consolidateCategory,
    scanContentForNewEntities,

    // 每日主角状态（cron 调用；entityProfile/lifecycle 靠「跳过主角」避让，别改成
    // 只在这儿写——两处都写会互相漂移）
    generateDailyEntityStatus,
};
