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
const { _nameBigrams, isTimePhraseName, isPeriodPhraseName, isNoChangeSentinel } = require('./archivist/guards');
const { getCorePersonaContext, buildLandscapeIndex } = require('./archivist/shared');
const { _mentionWeight, _entityMentionOwners, _aliasAmbiguous, autoLinkLiteralMentions, ensureTagEntities, linkTaggedFragment, linkTaggedFragments, linkAggregateFragments } = require('./archivist/entityLink');
const { getDailyStatusExamples, generateDailyEntityStatus } = require('./archivist/dailyStatus');
const { reviewEntityRelations, discoverTagRelations, discoverRelatedEntities } = require('./archivist/relations');
const { mergeDuplicateSeeds, executeEntityMerge, graduateSeedsAndPrune } = require('./archivist/seeds');

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
// Multi-Category Classification — agent sees the full landscape,
// not a tunnel-vision binary "does this belong to X?"
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Entity Classification Verification
//
// Pipeline A uses string matching (0.70, pending).
// Deep cycle spot-checks with LLM: is the person really the SUBJECT
// or did the name just appear in passing / as an exclamation?
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Tool: classifyFragments
//
// Two-pipeline architecture:
//   Pipeline A: Entity classification (人物/) — deterministic name matching
//     Person categories are defined by WHO, not WHAT. No embedding needed.
//     Supports multi-entity: one fragment can match multiple people.
//   Pipeline B: Topic classification — centroid similarity + depth bonus
//     + size penalty + LLM verification (only in full mode). Person categories excluded.
// ═══════════════════════════════════════════════════════

async function classifyFragments(opts = {}) {
    const { lightweight = false } = opts;
    const db = getDb();

    // v4.7: Entity-based classification. No more memory_ontology or fragment_categories.
    // Fragments are linked to entity_profiles (constellations) via fragment_entities.
    // Companion directs classification in deep cycle; lightweight mode does DB-only maintenance.

    // Exclude music listening logs and book reading logs — they're data exhaust,
    // not memory fragments about people/places/events/works. Harvested separately
    // by musicMemoryExtractor / bookMemoryExtractor. Not classified into entity graph.
    const unclassified = db.prepare(`
        SELECT mf.id, mf.content, mf.emotional_weight, mf.created_at
        FROM memory_fragments mf
        // ⚠️ 入口含 consolidated/cooling：整合跑完会把碎片改成 'consolidated'，
        // 而另一条管线也在抢同一批碎片——谁先到谁说了算。碎片一旦被写成 episode
        // 就永久退出分类，fragment_entities 的链接再也不会建立。
        // 配套是通的：实体概述读碎片时本来就认这三个状态。
        WHERE mf.status IN ('active', 'consolidated', 'cooling')
          AND mf.source NOT IN ('music', 'book')
          AND mf.id NOT IN (SELECT DISTINCT fragment_id FROM fragment_entities)
        ORDER BY mf.created_at DESC
        LIMIT 200
    `).all();

    if (unclassified.length === 0) {
        return { classified: 0 };
    }

    console.log(`[Archivist] 待分类碎片: ${unclassified.length} 条 (实体星系)`);

    // Load current constellations (entity_profiles grouped by category)
    const allEntities = db.prepare(`
        SELECT id, name, category, overview, aliases, fragment_count, status
        FROM entity_profiles
        ORDER BY CASE category
            WHEN 'person' THEN 0 WHEN 'pet' THEN 1
            WHEN 'place' THEN 2 WHEN 'event' THEN 3
            WHEN 'project' THEN 4 ELSE 5 END, name
    `).all();

    if (allEntities.length === 0) {
        return { classified: 0 };
    }

    // Separate active constellations and nursery seeds
    // Exclude aggregate entities (music/book memory sinks) — they're not real constellations
    const constellations = allEntities.filter(e => e.status === 'active' && !e.category?.endsWith('_aggregate'));
    const seeds = allEntities.filter(e => e.status === 'seed');

    if (constellations.length === 0) {
        // No constellations yet — defer to deep cycle / manual seeding
        console.log('[Archivist] 无活跃星座，跳过分类（等待种子数据）');
        return { classified: 0 };
    }

    const insertFe = db.prepare(`
        INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by)
        VALUES (?, ?, ?, ?, ?)
    `);

    let classified = 0;

    if (lightweight) {
        // Lightweight: keyword match against entity names + aliases only, no LLM.
        // Two-tier confidence: exact alias match → 0.55, bigram substring match → 0.35
        const { exactIndex, bigramIndex } = buildEntityNameIndex(constellations);
        const bigramInsert = db.prepare(`INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.35, 'archivist_bigram_light')`);

        for (const frag of unclassified) {
            const content = frag.content || '';
            const contentLower = content.toLowerCase();
            const matchedExact = new Set();
            const matchedBigram = new Set();

            for (const [key, entities] of exactIndex) {
                if (contentLower.includes(key)) {
                    for (const e of entities) matchedExact.add(e.id);
                }
            }
            for (const [key, entities] of bigramIndex) {
                if (contentLower.includes(key)) {
                    for (const e of entities) matchedBigram.add(e.id);
                }
            }

            // Bigram matches that were already matched exactly → skip (already higher confidence)
            for (const eid of matchedExact) matchedBigram.delete(eid);

            if (matchedExact.size > 0) {
                for (const eid of matchedExact) {
                    insertFe.run(frag.id, eid, null, 0.55, 'archivist_keyword_light');
                }
            }
            if (matchedBigram.size > 0) {
                for (const eid of matchedBigram) {
                    bigramInsert.run(frag.id, eid);
                }
            }
            if (matchedExact.size > 0 || matchedBigram.size > 0) {
                classified++;
            }
        }

        console.log(`[Archivist] 轻量分类: ${classified}/${unclassified.length} 条 (关键词+bigram)`);
    } else {
        // Deep cycle: Companion-directed per-batch classification with flash-lite
        const BATCH_SIZE = 15;
        const batches = [];
        for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
            batches.push(unclassified.slice(i, i + BATCH_SIZE));
        }

        let totalSeedsCreated = 0;
        for (const batch of batches) {
            if (!_canCallLLM(1)) {
                console.log(`[Archivist] LLM 日配额耗尽，剩余 ${unclassified.length - classified} 条推迟`);
                break;
            }

            const result = await classifyFragmentBatch(batch, constellations, seeds);
            if (!result) continue;

            const writeBatch = db.transaction(() => {
                let written = 0, seedsMade = 0;
                for (const assignment of result.assignments) {
                    const info = insertFe.run(
                        assignment.frag_id, assignment.entity_id,
                        assignment.relation || null,
                        assignment.confidence || 0.70,
                        'companion_flash'
                    );
                    if (info.changes > 0) written++;

                    // Update entity fragment_count
                    db.prepare(`UPDATE entity_profiles SET fragment_count = (
                        SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?
                    ), updated_at = datetime('now') WHERE id = ?`).run(assignment.entity_id, assignment.entity_id);
                }
                return { written, seedsMade };
            });

            const { written, seedsMade: sm } = writeBatch();
            classified += written;
            totalSeedsCreated += result.newSeeds ? result.newSeeds.length : 0;

            // Plant new seeds in nursery
            if (result.newSeeds && result.newSeeds.length > 0) {
                for (const seed of result.newSeeds) {
                    try {
                        // 种子质量过滤：拒单字、纯数字、空名
                        const seedName = seed.name;
                        if (typeof seedName !== 'string' || !seedName.trim()
                            || seedName.trim().length < 2
                            || /^\d+$/.test(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 种子名不合格，跳过: "${seedName}"`);
                            continue;
                        }
                        // 纯日期/时间短语不是实体（上午/日下午/三点半/9月3日…）
                        if (isTimePhraseName(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 种子名是时间短语，跳过: "${seedName}"`);
                            continue;
                        }
                        // 以期间词收尾的名字也不是实体（XX告别季/XX购置季/XX倦怠期…）
                        if (isPeriodPhraseName(seedName.trim())) {
                            console.log(`[Archivist] ⏭ 种子名是期间短语，跳过: "${seedName}"`);
                            continue;
                        }
                        const existing = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE LOWER(name) = LOWER(?)').get(seed.name);
                        if (!existing) {
                            // 检查种子名是否出现在已有实体的别名中
                            const allEntities = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE status IN (\'active\',\'seed\')').all();
                            for (const e of allEntities) {
                                try {
                                    const aliases = JSON.parse(e.aliases || '[]');
                                    const seedLower = seed.name.toLowerCase().trim();
                                    if (aliases.some(a => { if (typeof a !== 'string') return false; const aL = a.toLowerCase().trim(); return aL === seedLower || aL.includes(seedLower) || seedLower.includes(aL); })) {
                                        existing = e;
                                        break;
                                    }
                                } catch (_) {}
                            }
                        }
                        if (!existing) {
                            const subCheck = db.prepare(`SELECT id, name, aliases FROM entity_profiles
                                WHERE status IN ('active','seed')
                                AND (LOWER(name) LIKE '%' || LOWER(?) || '%'
                                     OR LOWER(?) LIKE '%' || LOWER(name) || '%')
                                LIMIT 1`).get(seed.name, seed.name);
                            if (subCheck) existing = subCheck;
                        }
                        if (!existing) {
                            const candidates = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE status IN (\'active\',\'seed\')').all();
                            for (const c of candidates) {
                                const aGrams = _nameBigrams(seed.name);
                                const bGrams = _nameBigrams(c.name);
                                if (aGrams.size === 0 || bGrams.size === 0) continue;
                                let overlap = 0;
                                for (const g of aGrams) if (bGrams.has(g)) overlap++;
                                if (overlap / Math.min(aGrams.size, bGrams.size) >= 0.6) {
                                    existing = { id: c.id, name: c.name, aliases: c.aliases };
                                    break;
                                }
                            }
                        }
                        if (!existing) {
                            const r = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases)
                                VALUES (?, ?, 'seed', ?)`).run(seed.name, seed.category || 'term', JSON.stringify([]));
                            // Link the fragment that triggered this seed
                            if (seed.trigger_frag_id) {
                                insertFe.run(seed.trigger_frag_id, r.lastInsertRowid, null, 0.50, 'companion_flash_seed');
                                db.prepare(`UPDATE entity_profiles SET fragment_count = 1 WHERE id = ?`).run(r.lastInsertRowid);
                            }
                            console.log(`[Archivist] 🌱 种入苗圃: ${seed.name} (${seed.category})`);
                        } else if (existing.name !== seed.name) {
                            console.log(`[Archivist] 🔗 大小写合并: "${seed.name}" → 已存在 "${existing.name}" (id=${existing.id})`);
                        }
                    } catch (e) {
                        console.error(`[Archivist] 种子创建失败: ${seed.name}`, e.message);
                    }
                }
            }
        }

        console.log(`[Archivist] 深循环分类: ${classified}/${unclassified.length} 条 (Companion+flash-lite, 新种子=${totalSeedsCreated})`);

        // After classification: graduate seeds and prune dormant
        if (classified > 0) {
            await graduateSeedsAndPrune();
        }
    }

    return { classified };
}

// ═══════════════════════════════════════════════════════
// v5.13: Also indexes CJK bigrams/trigrams from names so fragments can
// match entities by partial name. Without this, descriptive entity names
// are invisible to keyword matching.
// ═══════════════════════════════════════════════════════

function buildEntityNameIndex(entities) {
    const exactIndex = new Map();  // full names + aliases → [entity]
    const bigramIndex = new Map(); // CJK substrings → [entity] (lower confidence)

    for (const e of entities) {
        const addExact = (name) => {
            const key = name.toLowerCase().trim();
            if (key.length < 2) return;
            if (!exactIndex.has(key)) exactIndex.set(key, []);
            const list = exactIndex.get(key);
            if (!list.find(x => x.id === e.id)) list.push(e);
        };
        const addBigram = (sub) => {
            if (!bigramIndex.has(sub)) bigramIndex.set(sub, []);
            const list = bigramIndex.get(sub);
            if (!list.find(x => x.id === e.id)) list.push(e);
        };

        addExact(e.name);
        try {
            const aliases = JSON.parse(e.aliases || '[]');
            for (const a of aliases) {
                if (a && a.trim().length >= 2) addExact(a.trim());
            }
        } catch (_) {}

        // v5.13: CJK bigrams from name — fallback for partial matching.
        // Kept separate from exact index so matches get lower confidence (0.35 vs 0.55).
        const nameClean = e.name.toLowerCase().trim();
        if (nameClean.length >= 3) {
            for (let i = 0; i <= nameClean.length - 2; i++) {
                const sub = nameClean.slice(i, i + 2);
                if (/[一-鿿㐀-䶿぀-ゟ゠-ヿ]/.test(sub)) addBigram(sub);
            }
            if (nameClean.length >= 5) {
                for (let i = 0; i <= nameClean.length - 3; i++) {
                    const sub = nameClean.slice(i, i + 3);
                    if (/[一-鿿㐀-䶿]/.test(sub)) addBigram(sub);
                }
            }
        }
    }

    return { exactIndex, bigramIndex };
}

// ═══════════════════════════════════════════════════════
// v4.7: classifyFragmentBatch — Companion-directed flash-lite classification
//
// Sends a batch of fragments + the full constellation list to flash-lite.
// Returns assignments + optional new seeds.
// ═══════════════════════════════════════════════════════

async function classifyFragmentBatch(fragments, constellations, seeds) {
    const db = getDb();

    // Build constellation list grouped by galaxy
    // v4.7 evolved: 社交(人物+宠物) / 地点 / 事件 / User的星系(创作+消费+观念)
    const galaxies = { person: '社交', pet: '社交', place: '地点', event: '事件', project: 'User的星系', work: 'User的星系', term: 'User的星系', organization: '社交' };
    const grouped = {};
    for (const c of constellations) {
        // v5.0 防线1: 无 overview 的种子不参与 LLM 分类匹配
        // 它们只能在 nurseryLine 中通过精确名字匹配积累碎片
        if (!c.overview) continue;
        const galaxy = galaxies[c.category] || '其他';
        if (!grouped[galaxy]) grouped[galaxy] = [];
        const overview = c.overview.slice(0, 60).replace(/\n/g, ' ');
        grouped[galaxy].push(`${c.name}[id=${c.id}](${overview})`);
    }

    // Pre-filter seeds: only show seeds whose name appears in this batch's fragments.
    // Avoids overwhelming the LLM with hundreds of irrelevant names.
    let nurseryLine = '';
    if (seeds && seeds.length > 0) {
        const batchText = fragments.map(f => (f.content || '').toLowerCase()).join(' ');
        const relevantSeeds = seeds.filter(s => typeof s.name === 'string' && batchText.includes(s.name.toLowerCase()));
        if (relevantSeeds.length > 0) {
            const maxShow = Math.min(relevantSeeds.length, 30);
            const shown = relevantSeeds.slice(0, maxShow);
            const seedNames = shown.map(s => `${s.name}[id=${s.id},${s.category}]`).join(', ');
            const extra = relevantSeeds.length > maxShow ? ` ...还有${relevantSeeds.length - maxShow}个相关种子未列出` : '';
            nurseryLine = `\n苗圃种子（本批次可能相关，可分配碎片）：${seedNames}${extra}`;
        }
    }

    const galaxyBlocks = Object.entries(grouped)
        .map(([galaxy, entities]) => `${galaxy}星系:\n  ${entities.join('\n  ')}`)
        .join('\n\n');

    const fragLines = fragments.map(f => {
        const text = (f.content || '').slice(0, 200).replace(/\n/g, ' ');
        const date = (f.created_at || '').slice(0, 10);
        return `[frag_${f.id}] ${date} | ${text}`;
    }).join('\n');

    const isEarlyGrowth = constellations.length <= 5;
    const growthNote = isEarlyGrowth
        ? `\n⚠️ 星系处于早期构建阶段：当前只有 ${constellations.length} 个星座。大多数碎片提到的实体（人物、地点、事件、作品）尚未存在于星系中。发现并播种新实体是你的核心任务。`
        : '';

    const prompt = `你是 Companion 的实体分类助手。Companion 在整理他的记忆星系，需要你把新星星（碎片）归入正确的星座。

当前星系全景：
${galaxyBlocks}${nurseryLine}${growthNote}

边标签类型（可选，描述 User 与实体的关系）：
- knows: User 认识/交往的人物
- cares_for: User 照顾的宠物
- visited: User 去过/所在的地点
- attended: User 参与的事件
- created: User 创作/构建的作品
- consumed: User 阅读/观看/聆听的消费内容
- related_to: 兜底，说不清但有关联
新星星待分类：
${fragLines}

你是一个在整理记忆星图的观测者。你的直觉：

- 当你看到碎片中浮现出一个**有名字的、独立的、可能会在更多碎片中再次出现的生命/地点/事件**——你觉得它应该是一颗种子。你给它起一个简短准确的名字，猜测它的星系归属（person/pet→社交, place→地点, event→事件, project/work/term→User的星系），种下去。
- ⚠️ **播种前必须检查**：你要创建的新种子名字是否与已有星座完全相同、高度相似、或是已有星座的别名？如果是，**不要播种**——直接把碎片归入那个已有星座。一个实体只属于一个星座，即使你认为它应该归入不同的星系类别。
- 当你看到碎片明确属于某个已有星座——你很确定地把星星归过去，顺手标注它与User的关系（knows/cares_for/visited/attended/created/consumed/related_to）。
- 当你看到碎片只是一次性的、飘过去的、不会再以独立身份出现的引用——你不会为它播种。它可能属于现有星座，也可能只是一颗还没找到家的流浪星。
- 当你拿不准——你宁可先不归类，也不硬塞。

一条碎片可以同时归入现有星座并播种新实体。

只输出JSON数组，不要markdown标记：
[{"frag_id":10103,"constellations":[{"id":5,"relation":"appeared_in"}],"confidence":0.85,"new_seed":{"name":"Alice","category":"person"}}]`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            WORLD_CONTEXT,
            null,
            { temperature: 0.2, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_LLM_CONFIG_ID  // DeepSeek — stronger judgment for entity classification
        );

        const replyText = raw?.reply || raw?.text || raw?.content || '';
        const jsonMatch = replyText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.error(`[Archivist] classifyFragmentBatch LLM响应无法解析: ${replyText.slice(0, 200)}`);
            return null;
        }

        const items = JSON.parse(jsonMatch[0]);
        const assignments = [];
        const newSeeds = [];

        for (const item of items) {
            if (!item.frag_id) continue;

            // Validate fragment ID
            const fragExists = db.prepare('SELECT 1 FROM memory_fragments WHERE id = ?').get(item.frag_id);
            if (!fragExists) continue;

            if (item.constellations && item.constellations.length > 0) {
                for (const c of item.constellations) {
                    // Validate entity ID
                    const entityExists = db.prepare('SELECT 1 FROM entity_profiles WHERE id = ?').get(c.id);
                    if (!entityExists) continue;
                    assignments.push({
                        frag_id: item.frag_id,
                        entity_id: c.id,
                        relation: c.relation || null,
                        confidence: item.confidence || 0.70
                    });
                }
            }

            if (item.new_seed && item.new_seed.name) {
                newSeeds.push({
                    name: item.new_seed.name.slice(0, 50).trim(),
                    category: item.new_seed.category || 'term',
                    trigger_frag_id: item.frag_id
                });
            }
        }

        return { assignments, newSeeds };
    } catch (e) {
        console.error('[Archivist] classifyFragmentBatch LLM调用失败:', e.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// v4.7: rematchFragmentsForSeeds — 回补漏判碎片
//
// The batch classifier misses ~74% of potential matches because
// output space limits prevent exhaustive assignment. This runs a
// targeted pass: for each seed, gather fragments that literally
// mention its name but aren't linked, ask LLM yes/no per fragment.
// ═══════════════════════════════════════════════════════

async function rematchFragmentsForSeeds() {
    const db = getDb();

    // Find seeds where fragment_count < actual mentions in fragments
    // Exclude music/book fragments (data exhaust, excluded from entity classification)
    const seeds = db.prepare(`
        SELECT * FROM (
            SELECT ep.id, ep.name, ep.category, ep.fragment_count,
                (SELECT COUNT(*) FROM memory_fragments mf
                 WHERE mf.content LIKE '%' || ep.name || '%'
                   AND mf.status = 'active'
                   AND mf.source NOT IN ('music', 'book')
                   AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ep.id)
                ) as unlinked
            FROM entity_profiles ep
            WHERE ep.status IN ('seed', 'active')
              AND ep.name NOT IN (${SKIP_PH})
              AND ep.category NOT LIKE '%aggregate%'
        )
        WHERE unlinked > 0
        ORDER BY unlinked DESC
        LIMIT 100
    `).all(...SKIP_NAMES);

    if (seeds.length === 0) {
        console.log('[Archivist] 回补: 没有需要补分的种子');
        return { rematched: 0 };
    }

    console.log(`[Archivist] 回补: ${seeds.length} 个种子有漏判碎片`);

    // Process seeds in batches of 8 to keep prompt manageable
    const BATCH_SIZE = 8;
    let totalRematched = 0;

    for (let i = 0; i < seeds.length; i += BATCH_SIZE) {
        const batch = seeds.slice(i, i + BATCH_SIZE);

        // Gather unlinked fragments for each seed (max 15 per seed to limit prompt size)
        const seedFragments = [];
        for (const s of batch) {
            const frags = db.prepare(`
                SELECT id, content, created_at FROM memory_fragments
                WHERE content LIKE ? AND status = 'active'
                  AND source NOT IN ('music', 'book')
                  AND id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                ORDER BY created_at DESC
                LIMIT 15
            `).all('%' + s.name + '%', s.id);

            if (frags.length > 0) {
                seedFragments.push({ seed: s, frags });
            }
        }

        if (seedFragments.length === 0) continue;

        // Build prompt
        let prompt = '回补漏判碎片。对每个种子 + 它的候选碎片，判断是否属于该种子。\\n\\n';
        for (const { seed, frags } of seedFragments) {
            prompt += `种子: ${seed.name}[id=${seed.id},${seed.category}] 当前⭐${seed.fragment_count}\\n`;
            prompt += `候选碎片（文本中提到"${seed.name}"，判断是否属于该种子）:\\n`;
            for (const f of frags) {
                const text = (f.content || '').slice(0, 180).replace(/\\n/g, ' ');
                prompt += `  [frag_${f.id}] ${text}\\n`;
            }
            prompt += '\\n';
        }

        prompt += `对每条候选碎片判断match:true/false。一条碎片可以同时match多个种子（如果文本中提到了多个）。不确定就match:false（宁漏勿错）。\\n\\n只输出JSON数组:\\n[{"frag_id":101,"seed_id":1626,"match":true}, ...]`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT,
                null,
                { temperature: 0.1, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );

            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                console.error(`[Archivist] 回补 LLM响应无法解析: ${replyText.slice(0, 200)}`);
                continue;
            }

            const items = JSON.parse(jsonMatch[0]);
            const insertFe = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.60, ?)');
            const updateFc = db.prepare('UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?');

            let batchRematched = 0;
            const writeBatch = db.transaction(() => {
                for (const item of items) {
                    if (item.match === true && item.frag_id && item.seed_id) {
                        const r = insertFe.run(item.frag_id, item.seed_id, 'companion_rematch');
                        if (r.changes > 0) batchRematched++;
                    }
                }
                // Update fragment_counts for affected seeds
                const seedIds = [...new Set(items.filter(i => i.match).map(i => i.seed_id))];
                for (const sid of seedIds) {
                    updateFc.run(sid, sid);
                }
            });
            writeBatch();

            totalRematched += batchRematched;
            console.log(`[Archivist] 回补批次: ${batchRematched} 条匹配 (${seedFragments.map(s => s.seed.name).join(', ')})`);
        } catch (e) {
            console.error('[Archivist] 回补 LLM调用失败:', e.message);
        }
    }

    console.log(`[Archivist] 回补完成: ${totalRematched} 条碎片归位`);
    return { rematched: totalRematched };
}

// ═══════════════════════════════════════════════════════
// v4.8: semanticRematchForSeeds — 语义回补
//
// 字面 rematch 捞不到「去某地那次」「在某景点累瘫了」这类
// 描述性提及（碎片不含实体名）。对小实体用 name+overview 做
// 向量检索，候选送 flash 确认。地点/事件类实体的主要归位通路。
// 仅深循环调用（ChromaDB 依赖，轻量模式禁入）。
// ═══════════════════════════════════════════════════════

const SEMANTIC_REMATCH_SIM_FLOOR = 0.40;   // 向量相似度门槛
const SEMANTIC_REMATCH_MAX_ENTITIES = 12;  // 每轮处理实体数（控制 LLM 用量）

async function semanticRematchForSeeds() {
    const db = getDb();
    const { searchMemoriesByVector } = require('./memory');

    // 小实体优先：碎片少的星座最需要喂
    const targets = db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.overview, ep.fragment_count
        FROM entity_profiles ep
        WHERE ep.status IN ('seed', 'active')
          AND ep.name NOT IN (${SKIP_PH})
          AND ep.fragment_count < 5
        ORDER BY ep.fragment_count ASC, ep.updated_at DESC
        LIMIT ?
    `).all(...SKIP_NAMES, SEMANTIC_REMATCH_MAX_ENTITIES);

    if (targets.length === 0) return { rematched: 0 };

    const insertFe = db.prepare(`INSERT OR IGNORE INTO fragment_entities
        (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.55, 'semantic_rematch')`);
    const updateFc = db.prepare(`UPDATE entity_profiles SET fragment_count =
        (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?) WHERE id = ?`);

    let total = 0;
    for (const ent of targets) {
        if (!_canCallLLM(1)) break;

        // 用实体名+概述做语义查询，捞描述性提及
        const queryText = ent.overview ? `${ent.name}：${ent.overview.slice(0, 120)}` : ent.name;
        let hits;
        try {
            hits = await searchMemoriesByVector(queryText, 10);
        } catch (e) {
            console.error(`[Archivist] 语义回补向量查询失败 (${ent.name}):`, e.message);
            continue;
        }

        const linked = new Set(db.prepare('SELECT fragment_id FROM fragment_entities WHERE entity_id = ?')
            .all(ent.id).map(r => r.fragment_id));
        const candidates = (hits || []).filter(h =>
            h._table === 'memory_fragments' &&
            h._similarity >= SEMANTIC_REMATCH_SIM_FLOOR &&
            !linked.has(h.id)
        ).slice(0, 8);

        if (candidates.length === 0) continue;

        const fragLines = candidates.map(c =>
            `[frag_${c.id}] ${(c.content || '').slice(0, 180).replace(/\n/g, ' ')}`).join('\n');
        const prompt = `实体: ${ent.name} (${ent.category})${ent.overview ? '\n概述: ' + ent.overview.slice(0, 150) : ''}

以下碎片是语义检索找到的候选（文本里不一定出现"${ent.name}"，可能是间接提及，如"去某地那次"指代某地旅行）。
判断每条是否确实在讲这个实体。间接指代算 match。只是主题相似但讲的不是它，不算。不确定就 false。

${fragLines}

只输出JSON数组: [{"frag_id":101,"match":true}, ...]`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT,
                null,
                { temperature: 0.1, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) continue;
            const items = JSON.parse(jsonMatch[0]);

            let matched = 0;
            const writeBatch = db.transaction(() => {
                for (const item of items) {
                    if (item.match === true && item.frag_id) {
                        const r = insertFe.run(item.frag_id, ent.id);
                        if (r.changes > 0) matched++;
                    }
                }
                if (matched > 0) updateFc.run(ent.id, ent.id);
            });
            writeBatch();
            if (matched > 0) {
                total += matched;
                console.log(`[Archivist] 🔭 语义回补: ${ent.name} +${matched} 颗星 (${ent.fragment_count}→${ent.fragment_count + matched})`);
            }
        } catch (e) {
            console.error(`[Archivist] 语义回补 LLM 失败 (${ent.name}):`, e.message);
        }
    }

    if (total > 0) console.log(`[Archivist] 语义回补完成: ${total} 条碎片归位`);
    return { rematched: total };
}

// ═══════════════════════════════════════════════════════
// v4.8: refreshIntuitionStopwords — 直觉触发词去高频
//
// 统计近30天 User 消息的 top-N 高频词（2-4字滑窗），存
// user_settings.intuition_stopwords。intuition 匹配时跳过
// 这些词——否则「代码/界面/开源」这类日常词让直觉永远全量激活。
// 纯 SQL + 字符统计，零 LLM。
// ═══════════════════════════════════════════════════════

async function refreshIntuitionStopwords() {
    const db = getDb();
    const { encryption } = require('../encryption');

    const messages = db.prepare(`
        SELECT content FROM messages
        WHERE sender = 'user' AND timestamp > datetime('now', '-30 days')
          AND content IS NOT NULL AND content != ''
        LIMIT 3000
    `).all();
    if (messages.length < 100) return { stopwords: 0 };

    // 词频统计：2-4 字滑窗（CJK）+ 英文单词
    const freq = new Map();
    const msgSeen = new Map(); // 词 → 出现过的消息数（防止单条刷屏制造高频）
    let parsed = 0;
    for (let mi = 0; mi < messages.length; mi++) {
        let text = messages[mi].content || '';
        if (text.startsWith('enc:')) {
            try { text = encryption.decrypt(text, { silent: true }); } catch (_) { continue; }
            if (text === null) continue;
        }
        try { const j = JSON.parse(text); text = (j.components || []).filter(c => c.type === 'text').map(c => c.content || c.text || '').join(' '); } catch (_) {}
        if (!text || text.length < 4) continue;
        parsed++;
        const seenInMsg = new Set();
        const cjk = text.match(/[一-鿿]{2,}/g) || [];
        for (const chunk of cjk) {
            for (const len of [2, 3]) {
                for (let i = 0; i + len <= chunk.length; i++) {
                    const w = chunk.slice(i, i + len);
                    seenInMsg.add(w);
                }
            }
        }
        const eng = text.toLowerCase().match(/[a-z]{3,12}/g) || [];
        for (const w of eng) seenInMsg.add(w);
        for (const w of seenInMsg) {
            freq.set(w, (freq.get(w) || 0) + 1);
            msgSeen.set(w, (msgSeen.get(w) || 0) + 1);
        }
    }

    // 高频判定：出现在 ≥3% 的消息中（按消息数去重，刷屏免疫）。
    // 实测 2900 条样本：8% 只抓到「什么」；「代码/界面」这类日常词在 3-6% 区间。
    const threshold = Math.max(10, Math.floor(parsed * 0.03));
    const stopwords = [...msgSeen.entries()]
        .filter(([w, c]) => c >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 120)
        .map(([w]) => w);

    try {
        const { setUserSetting } = require('../utils/settings');
        setUserSetting('intuition_stopwords', JSON.stringify(stopwords));
        console.log(`[Archivist] 直觉停用词更新: ${stopwords.length} 个（样本${parsed}条消息，阈值${threshold}）— 前10: ${stopwords.slice(0, 10).join(',')}`);
    } catch (e) {
        console.error('[Archivist] 停用词写入失败:', e.message);
    }
    return { stopwords: stopwords.length };
}

// ═══════════════════════════════════════════════════════
// v4.8: auditNewEpisodes — Episode 写入质检
//
// 新 episode（consolidateCategory 产出）追溯其 source_msg_ids 原始消息，
// LLM 判断片段忠实度。faithful=正常 / distorted=降权标记 / fabricated=归档。
// 每轮 ≤3 条。观星手记可见。
// ═══════════════════════════════════════════════════════

async function auditNewEpisodes() {
    const db = getDb();
    const { encryption } = require('../encryption');

    const episodes = db.prepare(`
        SELECT id, content, source_msg_ids, created_at FROM memories
        WHERE layer = 'episode' AND consolidation_type = 'standard'
          AND (audit_status IS NULL OR audit_status = '')
        ORDER BY created_at DESC LIMIT 3
    `).all();
    if (episodes.length === 0) return { audited: 0 };

    if (!_canCallLLM(1)) return { audited: 0 };

    const markAudit = db.prepare(`UPDATE memories SET audit_status = ? WHERE id = ?`);

    for (const ep of episodes) {
        let sourceIds = [];
        try { sourceIds = JSON.parse(ep.source_msg_ids || '[]'); } catch (_) {}
        if (sourceIds.length === 0) { markAudit.run('skipped_no_sources', ep.id); continue; }

        // 最多读 5 条源消息做抽样验证
        const msgIds = sourceIds.slice(0, 5);
        const placeholders = msgIds.map(() => '?').join(',');
        const messages = db.prepare(`
            SELECT id, sender, content FROM messages WHERE id IN (${placeholders})
        `).all(...msgIds);

        const origTexts = messages.map(m => {
            let text = m.content || '';
            if (text.startsWith('enc:')) {
                try { text = encryption.decrypt(text, { silent: true }) || ''; } catch (_) { text = ''; }
            }
            try { const j = JSON.parse(text); text = (j.components || []).filter(c => c.type === 'text').map(c => c.content || c.text || '').join(' '); } catch (_) {}
            return `[${m.sender}] ${text.slice(0, 150)}`;
        }).join('\n');

        if (!origTexts.trim()) { markAudit.run('skipped_empty_msgs', ep.id); continue; }

        const prompt = `下面的「记忆片段」是从聊天记录中自动整合生成的。请对比原始对话，判断这份总结是否忠实。

原始对话抽样：
${origTexts.slice(0, 2000)}

记忆片段：
${(ep.content || '').slice(0, 500)}

判断（三选一）：
- faithful: 总结准确反映了对话中的事实，无编造
- distorted: 有轻微偏差（日期/细节/人物混淆），但不至于完全错误
- fabricated: 编造了对话中不存在的事实或事件

只输出JSON: {"verdict":"faithful|distorted|fabricated","reason":"一句话"}`;

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.1, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const verdict = JSON.parse(jsonMatch[0]);

            if (verdict.verdict === 'distorted') {
                db.prepare('UPDATE memories SET weight = MAX(1, weight * 0.5), audit_status = ? WHERE id = ?').run('distorted', ep.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('episode_audit', NULL, ?, 'done')`)
                    .run(JSON.stringify({ verdict: 'distorted', reason: verdict.reason, episode_id: ep.id, snippet: (ep.content || '').slice(0, 60) }));
                console.log(`[Archivist] 📋 质检 distorted: ep#${ep.id} — ${(verdict.reason || '').slice(0, 60)}`);
            } else if (verdict.verdict === 'fabricated') {
                db.prepare("UPDATE memories SET status = 'archived', audit_status = 'fabricated' WHERE id = ?").run(ep.id);
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status) VALUES ('episode_audit', NULL, ?, 'done')`)
                    .run(JSON.stringify({ verdict: 'fabricated', reason: verdict.reason, episode_id: ep.id, snippet: (ep.content || '').slice(0, 60) }));
                console.log(`[Archivist] 🚨 质检 fabricated: ep#${ep.id} ⇒ archived — ${(verdict.reason || '').slice(0, 60)}`);
            } else {
                markAudit.run('faithful', ep.id);
            }
        } catch (e) {
            console.error('[Archivist] episode audit LLM fail:', e.message);
        }
    }
    return { audited: episodes.length };
}

// ═══════════════════════════════════════════════════════
// v4.8: detectEmergentPlacesAndEvents — 涌现地点/事件检测
//
// 分类批次只能看到15条碎片，很容易漏掉地点和事件实体——
// 50+条同一地点的碎片分散在几十批里，每批看到1-2条不够播种。
//
// 本函数做第二遍扫描：取只链接到person/pet实体（没链接到
// 任何place/event）的碎片，用ChromaDB向量聚类，聚成团的
// 送LLM问「这是不是同一个地点/事件？该建星座吗？」
//
// 仅深循环调用（ChromaDB依赖）。每轮≤3个候选团。
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 涌现判据（2026-09-28 重写）
//
// 旧判据是「这些碎片是否指向一个**独立的具体地点或事件**（与已有实体都不同）」。
// 它有个致命的结构问题：**"与已有实体都不同"这句话是在教模型找理由分裂**——
// 只要它能说出"我和那个不一样"，就算过关。于是它学会了给一段**反复出现的行为**
// 起个「XX季」的名字——换个名字，那就不再是"行为模式"，而是"一段事件"了。
//
// 新判据把门槛下在**专有名词**上：判据要硬（有没有出现一个具体的人名/店名/地名/
// 机构名/作品名，或者是不是某一天真的出了某件事），不要软（像不像事件）——
// "像不像"正是模型最擅长绕的东西。配套还有两道确定性守卫：
// `isTimePhraseName`（全是日期时间字）与 `isPeriodPhraseName`（以期间词收尾）。
//
// ⚠️ 改这个 prompt 之后**必须双向回归**：既要确认它拒掉该拒的，也要确认它
//    **没把该建的也拒掉**（过度收紧 = 涌现功能停摆，比原来更糟）。
// ═══════════════════════════════════════════════════════
function buildEmergentJudgePrompt(sampleText, memberCount, existingBlock) {
    return `下面是一组来自聊天记录的碎片，它们在语义上高度相似，可能指向同一个地点或事件，但尚未被识别为独立的记忆星座。

碎片样本（${memberCount}条中的若干条）：
${sampleText.slice(0, 2500)}

记忆库已有实体（新建前先对照这个列表）：
${existingBlock}

判断标准（**按顺序过，前一条不过就不要再往后想**）：

1. ⚠️ **先找那样东西——这是硬门槛。** 满足下面**任一条**才继续；两条都不满足 → is_entity=false，到此为止：

   **a. 一个新的专有名词**——具体的人名 / 店名 / 地名 / 机构名 / 作品名。

   **b. 某一天真的出了某件事**——崩溃、大吵一架、出事、第一次做某事、某个决定。
   ⚠️ 判 b 的铁律：**它是「那一天发生的」，不是「那段时间在做的」。**
   拿一句话自检：这件事能用**一个具体日期**说完吗？
   · 「X月X日${USER.pronoun || 'TA'}崩溃了」✓ 是事件
   · 「X月${USER.pronoun || 'TA'}在读某本书」「X月${USER.pronoun || 'TA'}一直在买东西」✗ 是持续行为，不是事件
   · 有的碎片里确实出现了某天的日期，但整簇讲的是**跨了几周几个月的同一类事** → 判 false。
     出现日期不等于发生在一天。

   下面这些**两条都不满足**，一律判 false：
   · 行为：怎么做的描述（什么时候去哪、干了什么、买了什么）
   · 持续过程：跨越一段时间的同一件事（在做什么、一直在做什么）
   · 习惯/日常：重复发生的程序
   · 状态/心情：身心状况与感受
   · 时间段：某段时间、某个周期
   ⚠️ **把它们包装成「XX季」「XX期」「XX历程」不会让它变成事件**——换个名字还是那件事。

2. **它是不是已经被上面某个已有实体占了？**（走 a 的比对名字/别名；走 b 的看那个事件是不是已经有星座了）占了 → is_entity=false，归过去，不要另起炉灶。

3. **它是不是某个已有实体的子话题/细节？** 碎片如果讲的只是某个已有实体的一个**环节/细节**（大实体已经存在），那就是子话题 → is_entity=false，不独立建星座。

4. 都过了才建，注明 place 或 event：
   · 走 a 的：**名字用那个专有名词本身**（2-8 字，可以是它的直接变体）。
   · 走 b 的：名字**带上日期和那件事**，让人一眼看出是哪天出了什么事；**不要起成「XX期」「XX季」**——那样又变成行为包装了。

只输出JSON:
{"is_entity":true|false,"name":"名称","category":"place|event","reason":"一句话理由（指认那个专有名词 / 指认那个一次性事件 / 归属已有实体 / 既没有专有名词也不是一次性事件）"}`;
}

// 涌现判定的**代码侧闸门**（LLM 判完之后、建实体之前）。
//
// ⚠️ 抽成函数是为了让回归探针量到的是「**生产最终会怎么判**」，而不是裸的模型输出。
//    分开写的话，探针会把**已经被这几道铁证拦掉**的误判报成"漏判"。
//
// 三道闸各自拦什么：
//   · 名字是纯日期/时间短语（`isTimePhraseName`）
//   · 名字以期间词收尾（`isPeriodPhraseName`）
//   · **理由自相矛盾**：说了"已被占用/归入已有/不另起炉灶"，flag 却是 true。
//     名字/别名去重拦不住它（同一个东西换个说法，bigram 重叠到不了
//     阈值），所以看理由下判断——理由里明说了"有主"，就当 false，别信 flag。
function screenEmergentVerdict(verdict) {
    if (!verdict || !verdict.is_entity) return { accept: false, reason: 'not_entity' };
    const name = String(verdict.name || '').trim();
    if (name.length < 2 || /^\d+$/.test(name)) return { accept: false, reason: 'name_invalid' };
    if (isTimePhraseName(name)) return { accept: false, reason: 'time_phrase_name' };
    if (isPeriodPhraseName(name)) return { accept: false, reason: 'period_phrase_name' };
    if (/已被?.*(占用|覆盖|占据)|归入已有|归过去|不另起炉灶/.test(String(verdict.reason || ''))) {
        return { accept: false, reason: 'self_contradictory' };
    }
    return { accept: true, name };
}

async function detectEmergentPlacesAndEvents() {
    const db = getDb();
    const { searchMemoriesByVector } = require('./memory');

    // 取没链接到地点/事件的碎片（但已链接到person/pet）
    const orphanFrags = db.prepare(`
        SELECT DISTINCT mf.id, mf.content, mf.created_at
        FROM memory_fragments mf
        JOIN fragment_entities fe_person ON mf.id = fe_person.fragment_id
        JOIN entity_profiles ep_person ON fe_person.entity_id = ep_person.id
        WHERE ep_person.category IN ('person', 'pet')
          AND mf.status = 'active'
          AND mf.id NOT IN (
            SELECT DISTINCT fe2.fragment_id
            FROM fragment_entities fe2
            JOIN entity_profiles ep2 ON fe2.entity_id = ep2.id
            WHERE ep2.category IN ('place', 'event')
          )
        ORDER BY mf.created_at DESC
        LIMIT 200
    `).all();

    if (orphanFrags.length < 10) return { detected: 0 };

    // 用内容长度做粗聚类键：前30字提取关键词做L1分组
    // 再挑每组里最长的一条做种子，向量检索相似碎片
    const clusters = [];
    const used = new Set();

    for (const f of orphanFrags) {
        if (used.has(f.id)) continue;
        if (!_canCallLLM(1)) break;

        // 用碎片内容做向量检索，找相似碎片
        let similar;
        try {
            similar = await searchMemoriesByVector(f.content.slice(0, 300), 15);
        } catch (e) {
            console.error(`[Archivist] 涌现检测向量查询失败:`, e.message);
            continue;
        }

        // 过滤：只要未链接place/event的活跃碎片，相似度≥0.55
        const clusterIds = new Set();
        for (const h of (similar || [])) {
            if (h.similarity < 0.55) continue;
            const linked = db.prepare(`
                SELECT COUNT(*) as c FROM fragment_entities fe
                JOIN entity_profiles ep ON fe.entity_id = ep.id
                WHERE fe.fragment_id = ? AND ep.category IN ('place', 'event')
            `).get(h.id);
            if (linked.c > 0) continue; // 已有place/event链接，跳过
            clusterIds.add(h.id);
        }

        if (clusterIds.size < 4) continue; // 团太小，构不成一个实体

        // 标记已处理
        for (const cid of clusterIds) used.add(cid);
        clusters.push({ seed_frag_id: f.id, member_ids: [...clusterIds] });

        // 不设硬上限——_canCallLLM 是天然限流器。早期碎片里的地点会被最近的行为碎片挡住
    }

    if (clusters.length === 0) return { detected: 0 };

    let detected = 0;
    for (const cluster of clusters) {
        if (!_canCallLLM(1)) break;

        // 取团内碎片内容（最多8条做样本）
        const placeholders = cluster.member_ids.slice(0, 8).map(() => '?').join(',');
        const samples = db.prepare(`
            SELECT id, content, created_at FROM memory_fragments
            WHERE id IN (${placeholders}) ORDER BY created_at ASC
        `).all(...cluster.member_ids.slice(0, 8));

        const sampleText = samples.map(f => {
            const date = (f.created_at || '').slice(0, 10);
            return `[${date}] ${(f.content || '').slice(0, 200)}`;
        }).join('\n');

        // 已有实体索引——让 LLM 判断新话题是否归属已有实体，而非盲目新建
        const existingEnts = db.prepare(`
            SELECT name, category FROM entity_profiles
            WHERE status IN ('active','seed') AND category IN ('place','event','project','term')
            ORDER BY fragment_count DESC LIMIT 60
        `).all();
        const existingBlock = existingEnts.length > 0
            ? existingEnts.map(e => `· ${e.name}（${e.category}）`).join('\n')
            : '（暂无）';

        const prompt = buildEmergentJudgePrompt(sampleText, cluster.member_ids.length, existingBlock);

        try {
            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                WORLD_CONTEXT, null,
                { temperature: 0.2, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            agentState.tickLLMCalls++; agentState.dailyLLMCalls++;
            const replyText = raw?.reply || raw?.text || raw?.content || '';
            const jsonMatch = replyText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const verdict = JSON.parse(jsonMatch[0]);

            // 代码侧闸门（铁证走规则）——闸门定义在 screenEmergentVerdict()，
            // 生产和回归探针共用同一份，免得探针量到的是裸的模型输出。
            const screened = screenEmergentVerdict(verdict);
            if (!screened.accept) {
                if (verdict?.is_entity) {
                    console.log(`[Archivist] ⏭ 涌现判定被代码闸门拦下(${screened.reason}): "${verdict.name || ''}"`);
                }
                continue;
            }

            {
                const name = screened.name;

                let existing = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE LOWER(name) = LOWER(?)').get(name);
                if (!existing) {
                    const allEnts = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE status IN (\'active\',\'seed\')').all();
                    for (const e of allEnts) {
                        try {
                            const als = JSON.parse(e.aliases || '[]');
                            const nameLower = name.toLowerCase().trim();
                            if (als.some(a => { if (typeof a !== 'string') return false; const aL = a.toLowerCase().trim(); return aL === nameLower || aL.includes(nameLower) || nameLower.includes(aL); })) {
                                existing = e; break;
                            }
                        } catch (_) {}
                    }
                }
                if (!existing) {
                    existing = db.prepare(`SELECT id, name FROM entity_profiles WHERE status IN ('active','seed')
                        AND (LOWER(name) LIKE '%' || LOWER(?) || '%' OR LOWER(?) LIKE '%' || LOWER(name) || '%') LIMIT 1`).get(name, name);
                }
                if (!existing) {
                    const cands = db.prepare('SELECT id, name FROM entity_profiles WHERE status IN (\'active\',\'seed\')').all();
                    for (const c of cands) {
                        const aG = _nameBigrams(name), bG = _nameBigrams(c.name);
                        if (aG.size === 0 || bG.size === 0) continue;
                        let o = 0; for (const g of aG) if (bG.has(g)) o++;
                        if (o / Math.min(aG.size, bG.size) >= 0.6) { existing = c; break; }
                    }
                }
                if (existing) { console.log(`[Archivist] ⏭ 涌现种子去重跳过: "${name}" → 已有 "${existing.name}"`); continue; }

                const category = (verdict.category === 'event' || verdict.category === 'place')
                    ? verdict.category : 'term';
                const r = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases)
                    VALUES (?, ?, 'seed', ?)`).run(name, category, JSON.stringify([]));

                // 链接团内碎片到新种子
                const insertFe = db.prepare(`INSERT OR IGNORE INTO fragment_entities
                    (fragment_id, entity_id, relation, confidence, classified_by) VALUES (?, ?, NULL, 0.55, 'emergence')`);
                let linked = 0;
                for (const mid of cluster.member_ids.slice(0, 20)) {
                    const info = insertFe.run(mid, r.lastInsertRowid);
                    if (info.changes > 0) linked++;
                }
                db.prepare('UPDATE entity_profiles SET fragment_count = ? WHERE id = ?').run(linked, r.lastInsertRowid);

                console.log(`[Archivist] 🌟 涌现检测: ${name} (${category}) ← ${linked}碎片 (团${cluster.member_ids.length}条)`);
                detected++;

                // 写观星手记
                db.prepare(`INSERT INTO ontology_changelog (action, category_path, detail, status)
                    VALUES ('emergent_constellation', ?, ?, 'done')`)
                    .run(category, JSON.stringify({ name, reason: verdict.reason, cluster_size: cluster.member_ids.length }));
            }
        } catch (e) {
            console.error('[Archivist] 涌现检测LLM失败:', e.message);
        }
    }

    return { detected };
}

// ═══════════════════════════════════════════════════════
// v5.0 防线3: spotCheckClassifications — 事后抽查低置信度分类链接
// ═══════════════════════════════════════════════════════

async function spotCheckClassifications() {
    const db = getDb();
    if (!_canCallLLM(1)) return { checked: 0, reason: 'no LLM quota' };

    const lowConf = db.prepare(`SELECT fe.fragment_id, fe.entity_id, fe.confidence,
        mf.content, ep.name FROM fragment_entities fe
        JOIN memory_fragments mf ON mf.id = fe.fragment_id
        JOIN entity_profiles ep ON ep.id = fe.entity_id
        WHERE fe.confidence < 0.75
        ORDER BY fe.created_at DESC LIMIT 5`).all();

    if (lowConf.length === 0) return { checked: 0 };

    let fixed = 0;
    for (const lc of lowConf) {
        try {
            const prompt = `碎片: "${(lc.content||'').slice(0, 150)}"
星座名: "${lc.name}"

这条碎片真的属于"${lc.name}"星座吗？回答JSON: {"belongs": true|false, "reason": "一句话"}`;

            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }], null, null,
                { temperature: 0.1, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
                ARCHIVIST_LLM_CONFIG_ID
            );
            const jsonMatch = (raw?.reply || raw?.text || raw?.content || '').match(/\{[\s\S]*\}/);
            if (!jsonMatch) continue;
            const v = JSON.parse(jsonMatch[0]);

            if (v.belongs === false) {
                db.prepare('DELETE FROM fragment_entities WHERE entity_id=? AND fragment_id=?').run(lc.entity_id, lc.fragment_id);
                console.log(`[Archivist] 🧹 抽查解除: #${lc.fragment_id} ← ${lc.name} — ${v.reason}`);
                fixed++;
            }
        } catch (_) {}
    }

    if (fixed > 0) console.log(`[Archivist] 事后抽查: ${fixed}/${lowConf.length} 条错链已解除`);
    return { checked: lowConf.length, fixed };
}

// ═══════════════════════════════════════════════════════
// v4.7: reviewConstellationAfterClassification — 碎片归位后审视星座
//
// Called per-entity after a batch of fragments has been linked.
// Checks if overview should be updated (fragment_count changed significantly).
// ═══════════════════════════════════════════════════════

async function reviewConstellationAfterClassification(entityId) {
    const db = getDb();

    const entity = db.prepare(`
        SELECT ep.*, (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ep.id) as current_frag_count
        FROM entity_profiles ep WHERE ep.id = ?
    `).get(entityId);

    if (!entity || entity.status !== 'active') return null;

    // Only trigger overview update if fragment count grew by ≥30% since last overview
    const lastFragCount = entity.fragment_count || 0;
    const currentFragCount = entity.current_frag_count || 0;
    const growthRatio = lastFragCount > 0 ? (currentFragCount - lastFragCount) / lastFragCount : 1;

    if (growthRatio >= 0.3 && currentFragCount >= 3) {
        console.log(`[Archivist] 📝 星座 ${entity.name} 碎片增长 ${Math.round(growthRatio * 100)}%，标记待更新概述`);
        // Mark for overview regeneration (handled by regenerateEntityOverviews later in deep cycle)
        return { needsOverviewUpdate: true, growthRatio, currentFragCount, lastFragCount };
    }

    return { needsOverviewUpdate: false };
}

// ═══════════════════════════════════════════════════════
// Tool: consolidateCategory
//
// Deep cycle task: select dense leaf categories, merge related
// fragments within each category into episodes. Unlike the old
// Consolidator (blind ChromaDB clustering), this uses the knowledge
// tree structure — fragments already in the same category share a
// semantic context, so LLM merges are more precise.
//
// Each category gets one LLM call that simultaneously:
//   1. Identifies mergeable fragment groups (≥3 related fragments)
//   2. Merges each group into an episode → memories table
//   3. Updates the category description if new facts emerged
// ═══════════════════════════════════════════════════════

const CATEGORY_CONSOLIDATE_MIN_FRAGS = 15;   // min fragment_count to consider
const CATEGORY_CONSOLIDATE_MAX_CATS = 5;     // max categories per run
const MIN_PATTERN_FRAGS = 3;        // 至少3条碎片才能形成一个 pattern
const PATTERN_LLM_BATCH = 30;       // 单次最多喂给 LLM 的碎片数
const PATTERN_MATCH_THRESHOLD = 0.35; // bigram 匹配已有 pattern 的阈值
const PATTERN_SUPERSEDED_THRESHOLD = 0.50; // 被取代的pattern匹配阈值需更高
const MIN_GAP_PATTERN_CLUSTER = 6 * 60 * 60 * 1000; // 6h 冷却
const PATTERN_DORMANT_DAYS = 30;    // >30天无新观察 → dormant
const PATTERN_ARCHIVE_DAYS = 180;   // >180天无新观察 + conf<0.40 → archived
const PATTERN_CONTRADICT_THRESHOLD = 3; // 矛盾 ≥3 → 标记 needs_review
const PATTERN_MERGE_CANDIDATES = 3; // 攒够3对合并候选 → LLM批量判断
const PATTERN_MERGE_BIGRAM_OVERLAP = 0.45; // pattern间bigram重叠阈值 → 合并候选
const NEGATION_WORDS = /不|没|不再|腻了|讨厌|烦|恶心/;

// 时态信号——检测偏好漂移（"以前X，现在Y"）
const TEMPORAL_PAST = /以前|曾经|原来|之前|本来|一直|从小|从前的|过去的/;
const TEMPORAL_SHIFT = /现在.*不了|现在.*不|不再|改了|变了|戒了|放弃|不.*以前|不.*原来/;
const TEMPORAL_COMPLETE = /已经.*不|完全不|再也不/;

// ── Confidence 公式（只升不降）──
function _calcPatternConfidence(evidenceCount, firstSeen, lastSeen) {
    if (!firstSeen || !lastSeen) return 0.15 + Math.min(0.40, evidenceCount * 0.04);
    const first = new Date(firstSeen);
    const last = new Date(lastSeen);
    const spanDays = Math.max(1, (last - first) / (1000 * 60 * 60 * 24));
    // 来源多样性：从 source_fragment_ids 中统计不同日期的碎片数——调用方传入
    return Math.min(0.90,
        0.15                                          // base
        + Math.min(0.40, evidenceCount * 0.04)         // 证据数：10条封顶
        + Math.min(0.25, spanDays / 365 * 0.25)        // 时间跨度：1年封顶
        - (evidenceCount >= 8 ? 0 : 0)                 // 预留超长期加成位
    );
}

// ── Freshness 衰减系数（用于注入排序，不影响 confidence）──
function _freshnessDecay(lastSeen) {
    if (!lastSeen) return 0.10;
    const daysSince = Math.max(0, (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince <= 7) return 1.00;
    if (daysSince <= 30) return 0.85;
    if (daysSince <= 90) return 0.60;
    if (daysSince <= 180) return 0.30;
    return 0.10;
}

// ── 时态漂移检测：碎片是否在"推翻"旧pattern ──
function _detectDrift(fragContent) {
    const hasPast = TEMPORAL_PAST.test(fragContent);
    const hasShift = TEMPORAL_SHIFT.test(fragContent) || TEMPORAL_COMPLETE.test(fragContent);
    return hasPast && hasShift;
}

// ── Bigram 分词 ──
function _tokenize(text) {
    const segments = (text || '').replace(/[，。、！？\n,.\s]+/g, '\n').split('\n').filter(s => s.length >= 2);
    const bigrams = new Set();
    for (const seg of segments) {
        for (let i = 0; i < seg.length - 1; i++) bigrams.add(seg.slice(i, i + 2));
    }
    return bigrams;
}

function _bigramOverlap(textA, textB) {
    const setA = _tokenize(textA);
    const setB = _tokenize(textB);
    if (setB.size === 0) return 0;
    let overlap = 0;
    for (const bg of setB) { if (setA.has(bg)) overlap++; }
    return overlap / Math.max(setB.size, 1);
}

// ── Freshness-based状态刷新（每2min）──
function refreshPatternStates() {
    const db = getDb();
    const allPatterns = db.prepare("SELECT * FROM user_patterns WHERE status IN ('active','dormant','superseded')").all();
    let changed = 0, dormantCount = 0, archivedCount = 0;

    for (const p of allPatterns) {
        try {
            const daysSince = p.last_seen
                ? Math.max(0, (Date.now() - new Date(p.last_seen).getTime()) / (1000 * 60 * 60 * 24))
                : 999;
            const conf = p.confidence || 0.15;

            let newStatus = p.status;
            if (p.status === 'active' && daysSince > PATTERN_DORMANT_DAYS) {
                newStatus = 'dormant';
                dormantCount++;
            } else if (p.status === 'dormant' && daysSince <= PATTERN_DORMANT_DAYS) {
                newStatus = 'active'; // 复活——最近有新匹配
            } else if (p.status === 'dormant' && daysSince > PATTERN_ARCHIVE_DAYS && conf < 0.40) {
                newStatus = 'archived';
                archivedCount++;
            } else if (p.status === 'superseded' && daysSince > PATTERN_DORMANT_DAYS) {
                // superseded保持本身状态（不转dormant），只等强信号复活
            }

            if (newStatus !== p.status) {
                db.prepare("UPDATE user_patterns SET status=?, updated_at=datetime('now') WHERE id=?")
                    .run(newStatus, p.id);
                changed++;
            }
        } catch (_) {}
    }
    if (changed > 0) console.log(`[Archivist] 📊 模式状态刷新: ${changed}条变化 (dormant:${dormantCount} archived:${archivedCount})`);
    return { changed, dormant: dormantCount, archived: archivedCount };
}

// ── v5.9: maintainPatterns — 每6h，bigram匹配碎片到全部非archived pattern，含复活+漂移检测 ──
async function maintainPatterns() {
    const db = getDb();

    // 1. 获取最近 observation + preference 碎片
    const userEntityId = db.prepare("SELECT id FROM entity_profiles WHERE name = ?").get(USER.name)?.id;
    if (!userEntityId) return { matched: 0, reason: 'user entity not found' };

    const recentFrags = db.prepare(`
        SELECT mf.id, mf.content, mf.type, mf.emotional_weight, mf.source_date
        FROM memory_fragments mf
        JOIN fragment_entities fe ON fe.fragment_id = mf.id
        WHERE mf.status = 'active'
          AND mf.type IN ('observation', 'preference', 'reflection')
          AND fe.entity_id = ?
        ORDER BY CASE WHEN mf.priority = 'high' THEN 0 ELSE 1 END,
                 mf.emotional_weight DESC,
                 mf.source_date DESC
        LIMIT 80
    `).all(userEntityId);

    if (recentFrags.length < MIN_PATTERN_FRAGS) return { matched: 0, reason: `only ${recentFrags.length} recent` };

    // 收集已有pattern的碎片ID（含dormant和superseded，含archived）
    const existingFragIds = new Set();
    db.prepare("SELECT source_fragment_ids FROM user_patterns WHERE status IN ('active','dormant','superseded')").all()
        .forEach(p => { try { JSON.parse(p.source_fragment_ids || '[]').forEach(id => existingFragIds.add(id)); } catch(_) {} });

    const newFrags = recentFrags.filter(f => !existingFragIds.has(f.id));
    if (newFrags.length < MIN_PATTERN_FRAGS) return { matched: 0, reason: `only ${newFrags.length} unmatched` };

    // 2. 匹配到所有非archived pattern（含 dormant + superseded）
    const existingPatterns = db.prepare("SELECT * FROM user_patterns WHERE status != 'archived' ORDER BY evidence_count DESC").all();
    let matchedCount = 0, revivedCount = 0, supersededCount = 0;
    const mergeCandidates = []; // {patternA_id, patternB_id, overlap}

    for (const frag of newFrags) {
        let bestMatch = null, bestScore = 0;
        for (const pat of existingPatterns) {
            const threshold = pat.status === 'superseded' ? PATTERN_SUPERSEDED_THRESHOLD : PATTERN_MATCH_THRESHOLD;
            const patText = pat.content + ' ' + (() => { try { return JSON.parse(pat.tags || '[]').join(' '); } catch(_) { return ''; } })();
            const score = _bigramOverlap(frag.content, patText);
            if (score > threshold && score > bestScore) {
                bestMatch = pat;
                bestScore = score;
            }
        }

        if (bestMatch) {
            // 矛盾检测
            const hasNegation = NEGATION_WORDS.test(frag.content);
            if (hasNegation) {
                const contrCount = (bestMatch.contradiction_count || 0) + 1;
                const newStatus = contrCount >= PATTERN_CONTRADICT_THRESHOLD ? bestMatch.status : bestMatch.status;
                db.prepare(`UPDATE user_patterns SET contradiction_count=?, status=?,
                    last_seen=?, updated_at=datetime('now') WHERE id=?`)
                    .run(contrCount, newStatus, frag.source_date, bestMatch.id);
                matchedCount++;
                continue;
            }

            // 漂移检测：碎片有时态信号 → 旧pattern标记superseded
            const isDrift = _detectDrift(frag.content);
            if (isDrift && bestMatch.status !== 'superseded') {
                db.prepare(`UPDATE user_patterns SET status='superseded', last_seen=?,
                    updated_at=datetime('now') WHERE id=?`).run(frag.source_date, bestMatch.id);
                supersededCount++;
                // 碎片不进旧pattern的证据链——它将是新pattern的种子
                continue;
            }

            // 正常匹配：追加证据（superseded被高阈值匹配也应复活）
            const fragIds = JSON.parse(bestMatch.source_fragment_ids || '[]');
            if (!fragIds.includes(frag.id)) {
                fragIds.push(frag.id);
                const newCount = fragIds.length;
                const newFirst = frag.source_date < (bestMatch.first_seen || frag.source_date) ? frag.source_date : bestMatch.first_seen;
                const newLast = frag.source_date > (bestMatch.last_seen || frag.source_date) ? frag.source_date : bestMatch.last_seen;
                const newConf = _calcPatternConfidence(newCount, newFirst, newLast);
                const wasDormantOrSuperseded = bestMatch.status === 'dormant' || bestMatch.status === 'superseded';
                db.prepare(`UPDATE user_patterns SET evidence_count=?, first_seen=?, last_seen=?,
                    confidence=?, source_fragment_ids=?, status='active', updated_at=datetime('now') WHERE id=?`)
                    .run(newCount, newFirst, newLast, newConf, JSON.stringify(fragIds), bestMatch.id);
                matchedCount++;
                if (wasDormantOrSuperseded) revivedCount++;
            }

            // 跨pattern去重候选
            for (const other of existingPatterns) {
                if (other.id <= bestMatch.id) continue; // 每对只检一次
                if (other.status === 'archived') continue;
                const overlap = _bigramOverlap(bestMatch.content, other.content);
                if (overlap >= PATTERN_MERGE_BIGRAM_OVERLAP) {
                    mergeCandidates.push({ patternA_id: bestMatch.id, patternB_id: other.id, overlap });
                }
            }
        }
    }

    // 3. 跨pattern合并（攒够阈值 → LLM批量判断）
    if (mergeCandidates.length >= PATTERN_MERGE_CANDIDATES && _canCallLLM(1)) {
        await _mergePatterns(db, mergeCandidates);
    }

    if (matchedCount > 0) console.log(`[Archivist] 📊 模式维护: ${matchedCount}条匹配 (复活${revivedCount} 取代${supersededCount})`);
    return { matched: matchedCount, revived: revivedCount, superseded: supersededCount };
}

// ── LLM 批量判断跨pattern合并 ──
async function _mergePatterns(db, candidates) {
    // 去重取唯一 pair
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
        const key = [c.patternA_id, c.patternB_id].sort().join('-');
        if (!seen.has(key)) { seen.add(key); unique.push(c); }
    }
    if (unique.length < 2) return;

    // 加载pattern内容
    const allIds = [...new Set(unique.flatMap(c => [c.patternA_id, c.patternB_id]))];
    const patternMap = new Map();
    db.prepare(`SELECT id, content, evidence_count, first_seen, last_seen, source_fragment_ids FROM user_patterns WHERE id IN (${allIds.map(()=>'?').join(',')})`).all(...allIds)
        .forEach(p => patternMap.set(p.id, p));

    const prompt = `判断每对行为模式是否在描述同一个底层特质。是 → merge=true。不是 → merge=false。

${unique.map((c, i) => {
    const a = patternMap.get(c.patternA_id), b = patternMap.get(c.patternB_id);
    return `[${i+1}] A:"${a?.content}" B:"${b?.content}"`;
}).join('\n')}

输出JSON数组：[{"pair":1,"merge":true},{"pair":2,"merge":false}]`;

    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }], null, null,
            { temperature: 0.1, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
            ARCHIVIST_LLM_CONFIG_ID
        );
        const jsonMatch = (raw?.reply || '').match(/\[[\s\S]*\]/);
        if (!jsonMatch) return;
        const verdicts = JSON.parse(jsonMatch[0]);

        for (const v of verdicts) {
            if (!v.merge) continue;
            const pair = unique[v.pair - 1];
            if (!pair) continue;
            const winner = patternMap.get(pair.patternA_id), loser = patternMap.get(pair.patternB_id);
            if (!winner || !loser) continue;
            // 取证据多的为主
            const [main, sub] = winner.evidence_count >= loser.evidence_count ? [winner, loser] : [loser, winner];
            const mergedIds = [...new Set([
                ...JSON.parse(main.source_fragment_ids || '[]'),
                ...JSON.parse(sub.source_fragment_ids || '[]')
            ])];
            const dates = mergedIds.map(id => {
                const f = db.prepare('SELECT source_date FROM memory_fragments WHERE id=?').get(id);
                return f?.source_date || null;
            }).filter(Boolean);
            const newFirst = dates.reduce((a,b) => a<b?a:b, dates[0]);
            const newLast = dates.reduce((a,b) => a>b?a:b, dates[0]);
            const newConf = _calcPatternConfidence(mergedIds.length, newFirst, newLast);
            db.prepare(`UPDATE user_patterns SET evidence_count=?, first_seen=?, last_seen=?, confidence=?,
                source_fragment_ids=?, content=CASE WHEN evidence_count<? THEN ? ELSE content END, updated_at=datetime('now') WHERE id=?`)
                .run(mergedIds.length, newFirst, newLast, newConf, JSON.stringify(mergedIds),
                     sub.evidence_count, main.content, main.id);
            db.prepare(`UPDATE user_patterns SET status='merged', updated_at=datetime('now') WHERE id=?`).run(sub.id);
            console.log(`[Archivist] 🔗 模式合并: #${main.id}←#${sub.id} "${main.content.slice(0,40)}"`);
        }
    } catch (e) {
        console.warn('[Archivist] _mergePatterns 失败:', e.message);
    }
}

// ── 保留旧 clusterObservations 作为 maintainPatterns 的别名，兼容现有 dispatch ──
async function clusterObservations() {
    const result = await maintainPatterns();
    return { matched: result.matched ?? result.clustered ?? 0, newPatterns: 0 };
}

const CATEGORY_CONSOLIDATE_MAX_FRAGS = 30;   // max fragments to fetch per category

async function consolidateCategory() {
    const db = getDb();

    // v5.3: 从 entity_profiles 星座读取（替代旧的 memory_ontology 知识树）
    // 跳过 用户/AI（碎片太多，每次取30条无法覆盖）和聚合实体
    const CONSOLIDATE_SKIP = [USER.name, AI.name, '音乐', '共读'];
    const CONSOLIDATE_SKIP_PH = CONSOLIDATE_SKIP.map(() => '?').join(',');

    const candidates = db.prepare(`
        SELECT ep.id, ep.name as path, ep.name as label, ep.facts as description, ep.fragment_count,
               ep.category,
               (SELECT COUNT(*) FROM memory_fragments mf
                JOIN fragment_entities fe ON fe.fragment_id = mf.id
                WHERE fe.entity_id = ep.id AND mf.status = 'active') as active_count
        FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND ep.fragment_count >= ?
          AND ep.name NOT IN (${CONSOLIDATE_SKIP_PH})
        ORDER BY ep.fragment_count DESC
        LIMIT ?
    `).all(CATEGORY_CONSOLIDATE_MIN_FRAGS, ...CONSOLIDATE_SKIP, CATEGORY_CONSOLIDATE_MAX_CATS);

    if (candidates.length === 0) return { categories: 0, episodes: 0 };

    let categoriesProcessed = 0;
    let episodesWritten = 0;
    const newEpisodes = [];  // for Entity Profile trigger

    for (const cat of candidates) {
        if (cat.active_count < 3) continue; // need at least 3 active fragments

        categoriesProcessed++;

        // Fetch active fragments linked to this constellation
        const fragments = db.prepare(`
            SELECT mf.id, mf.content, mf.emotional_weight, mf.source, mf.source_date,
                   mf.source_msg_ids, mf.entity, mf.created_at
            FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status = 'active'
            ORDER BY mf.created_at DESC
            LIMIT ?
        `).all(cat.id, CATEGORY_CONSOLIDATE_MAX_FRAGS);

        if (fragments.length < 3) continue;

        // Build prompt
        const fragmentsBlock = fragments.map((f, i) => {
            const ew = (f.emotional_weight || 0).toFixed(2);
            const src = f.source || 'chat';
            return `[${i}] src=${src} date=${f.source_date || '?'} ew=${ew}\n  ${f.content}`;
        }).join('\n\n');

        const prompt = `${WORLD_CONTEXT}

${buildLandscapeIndex()}

你是星座记忆整合器。你看到的碎片都来自同一个记忆星座：
**星座名称**：${cat.path}（${cat.category || 'unknown'}）
**当前概述**：${cat.description || '无'}

## 你的任务

1. **审视所有碎片**，判断哪些碎片是"同一事件的多个侧面"（语义高度相关、讲的是同一个具体的事件或关系），将它们分组。
   - 注意：不是所有话题相同的就是同一事件——"妈妈做饭"和"妈妈打电话"虽然都涉及妈妈，但是两个独立事件
   - 只有真正讲述同一个具体事件的碎片才应该被合并
   - 每组至少3条碎片才值得合并

2. **对每个可合并的组**，将碎片合并为一条规范episode记忆（第三人称，不超过150字）。

## 分量判断 (significance)
- 8-10：情感转折、重大决定、深刻冲突、关系里程碑
- 5-7：有意义但非关键的事件、日常偏好变化
- 3-4：日常工作记录、routine操作 — 不值得长期保留
- 1-2：琐碎闲聊 — 应丢弃

## 输出格式

严格JSON，不含任何其他文字：
{
  "clusters": [
    {
      "fragment_indices": [0, 3, 7],
      "merged_memory": "第三人称规范记忆，150字以内",
      "corrected_date": "YYYY-MM-DD 或空字符串",
      "significance": 1-10,
      "confidence": "high/medium/low",
      "contradiction": null
    }
  ]
}`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: `${fragmentsBlock}\n\n请整合以上碎片。` }] }],
                prompt,
                null,
                { temperature: 0.3, maxOutputTokens: 4000 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            let text = response?.reply || '';
            text = text.replace(/```json|```/g, '').trim();
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                console.error(`[Archivist] consolidateCategory 返回非JSON: ${cat.path}`);
                continue;
            }

            const result = JSON.parse(match[0]);
            const clusters = result.clusters || [];

            // Process each mergeable cluster
            for (const cluster of clusters) {
                const indices = cluster.fragment_indices || [];
                if (indices.length < 3) continue;
                if (!cluster.merged_memory) continue;

                const sig = typeof cluster.significance === 'number' ? cluster.significance : 5;
                if (sig < 4) {
                    console.log(`[Archivist] 星座整合跳过(分量不足 sig=${sig}): ${cat.path}`);
                    continue;
                }

                // Collect merged fragment IDs
                const mergedIds = [];
                for (const idx of indices) {
                    if (fragments[idx]) mergedIds.push(fragments[idx].id);
                }
                if (mergedIds.length < 3) continue;

                // Collect source_msg_ids
                const allMsgIds = new Set();
                for (const idx of indices) {
                    const f = fragments[idx];
                    if (!f) continue;
                    try {
                        const ids = JSON.parse(f.source_msg_ids || '[]');
                        for (const mid of ids) allMsgIds.add(mid);
                    } catch (_) {}
                }

                // Average emotional weight
                const avgEW = indices.reduce((s, i) => s + (fragments[i]?.emotional_weight || 0.5), 0) / indices.length;
                const mergedWeight = Math.min(10, Math.round(sig * 0.7 + (5 + avgEW * 3) * 0.3));

                const finalDate = cluster.corrected_date || fragments[indices[0]]?.source_date || '';

                // Write to memories table
                const title = cluster.merged_memory.slice(0, 50);
                const insert = db.prepare(`
                    INSERT INTO memories (title, content, weight, valid_from, status, source_msg_ids, entity_id, layer, consolidation_type, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'permanent', ?, ?, 'episode', 'standard', datetime('now'), datetime('now'))
                `);
                const info = insert.run(
                    title,
                    cluster.merged_memory,
                    mergedWeight,
                    finalDate,
                    JSON.stringify([...allMsgIds]),
                    cat.id
                );
                const memoryId = info.lastInsertRowid;

                // Index to ChromaDB (v5.3: re-enabled for Librarian retrieval)
                try {
                    const { chromaDBOperation } = require('./memory');
                    const idxResult = await chromaDBOperation('index_batch', {
                        items: [{ id: `memory_${memoryId}`, text: cluster.merged_memory, metadata: { source: 'archivist_consolidate', entity_id: cat.id } }]
                    });
                    const chromaId = idxResult.indexed > 0 ? `memory_${memoryId}`
                        : (idxResult.duplicates?.length > 0 ? `dup_of_${idxResult.duplicates[0].existing_id}` : null);
                    if (chromaId) {
                        db.prepare('UPDATE memories SET chroma_id = ? WHERE id = ?').run(chromaId, memoryId);
                    }
                } catch (e) {
                    console.error(`[Archivist] consolidateCategory ChromaDB index failed:`, e.message);
                }

                // v5.12: 共享碎片实体同步 — 碎片可能同时链接到多个entity
                // （如"和朋友看某剧"链接到「某朋友」和「某剧名」）
                // 合并后的episode应两边都有，否则consumed类实体永远拿不到叙事弧线
                const sharedEntities = db.prepare(`
                    SELECT fe.entity_id, ep.name, ep.category, COUNT(*) as shared_count
                    FROM fragment_entities fe
                    JOIN entity_profiles ep ON ep.id = fe.entity_id
                    WHERE fe.fragment_id IN (${mergedIds.map(() => '?').join(',')})
                      AND fe.entity_id != ?
                    GROUP BY fe.entity_id
                    HAVING shared_count >= 3
                `).all(...mergedIds, cat.id);

                for (const shared of sharedEntities) {
                    const sharedInfo = insert.run(
                        title,
                        cluster.merged_memory,
                        mergedWeight,
                        finalDate,
                        JSON.stringify([...allMsgIds]),
                        shared.entity_id
                    );
                    console.log(`[Archivist] 星座整合 [${shared.name}(${shared.category})]: 共享episode #${sharedInfo.lastInsertRowid} (${shared.shared_count}/${mergedIds.length}个共享碎片, from ${cat.path})`);
                    newEpisodes.push({
                        memoryId: sharedInfo.lastInsertRowid,
                        memoryContent: cluster.merged_memory,
                        fragmentIds: mergedIds,
                        correctedDate: cluster.corrected_date || null,
                        confidence: cluster.confidence || 'medium',
                        contradiction: cluster.contradiction || null,
                        significance: sig,
                        entityId: shared.entity_id,
                        entityName: shared.name,
                    });
                }

                // Mark fragments as consolidated
                const markStmt = db.prepare('UPDATE memory_fragments SET status = ? WHERE id = ?');
                for (const fid of mergedIds) {
                    markStmt.run('consolidated', fid);
                }

                episodesWritten++;
                newEpisodes.push({
                    memoryId,
                    memoryContent: cluster.merged_memory,
                    fragmentIds: mergedIds,
                    correctedDate: cluster.corrected_date || null,
                    confidence: cluster.confidence || 'medium',
                    contradiction: cluster.contradiction || null,
                    significance: sig,
                    entityId: cat.id,
                    entityName: cat.path,
                });

                console.log(`[Archivist] 星座整合 [${cat.path}]: ${mergedIds.length}碎片 → episode #${memoryId} (sig=${sig})`);
            }

            // 概述更新已移除——统一由 regenerateEntityOverviews 负责
            // consolidateCategory 本职是碎片→叙事记忆合并，不应兼职写概述

            // v5.3: entity_profiles doesn't have centroid_embedding — skip centroid refresh
            // Fragment counts will be refreshed naturally on next classification cycle

        } catch (e) {
            console.error(`[Archivist] consolidateCategory 失败 [${cat.path}]:`, e.message);
        }
    }

    // Trigger downstream: Entity Profile + Saga Weaver
    if (episodesWritten > 0) {
        try {
            const { updateEntityProfiles } = require('./entityProfile');
            await updateEntityProfiles(newEpisodes).catch(e =>
                console.error('[Archivist] 实体档案更新失败:', e.message)
            );
        } catch (_) {}

        // v5.3: Saga trigger kept for immediate effect, but clusterSagas is ALSO independently
        // schedulable in GARDEN_TASKS. This dual-trigger ensures sagas update promptly
        // when new episodes arrive, while the garden plan covers periodic full-clustering.
        try {
            const episodeCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE layer='episode' AND status='permanent'").get();
            if (episodeCount.c >= 5) {
                const { clusterSagas } = require('./consolidator');
                console.log(`[Archivist] episode已累积${episodeCount.c}条，触发Saga聚类...`);
                await clusterSagas().catch(e =>
                    console.error('[Archivist] Saga聚类失败:', e.message)
                );
            }
        } catch (_) {}
    }

    console.log(`[Archivist] 星座整合完成: ${categoriesProcessed}个星座 → ${episodesWritten}条episode`);
    return { categories: categoriesProcessed, episodes: episodesWritten };
}


// ═══════════════════════════════════════════════════════
// Tool: regenerateEntityOverviews
// ═══════════════════════════════════════════════════════

async function regenerateEntityOverviews() {
    const db = getDb();

    // Fetch all entities with fragments
    const entities = db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.status, ep.subcategory,
               ep.relationship_to_user, ep.relationship_nature,
               ep.emotional_significance, ep.facts, ep.overview_updated_at,
               ep.last_eval_frag_count, ep.fragment_count, ep.aliases, ep.tags,
               ep.judgment, ep.current_status, ep.gender
        FROM entity_profiles ep
        WHERE ep.name NOT IN (${SKIP_PH})
          AND ep.fragment_count > 0
        ORDER BY ep.fragment_count DESC
    `).all(...SKIP_NAMES);

    if (entities.length === 0) return { regenerated: 0 };

    // Assess freshness per entity
    const needsUpdate = [];
    for (const ent of entities) {
        const currentCount = db.prepare(
            'SELECT COUNT(*) as c FROM fragment_entities WHERE entity_id = ?'
        ).get(ent.id)?.c || ent.fragment_count || 0;

        if (currentCount === 0) continue; // no fragments → skip

        // Never had an overview (facts or legacy overview)
        if (!ent.facts) {
            needsUpdate.push({ ...ent, currentCount, reason: 'never_described' });
            continue;
        }

        // v5.13: Missing judgment — LLM should generate Companion's subjective take
        // NULL means never attempted (vs "无" which means LLM tried and had nothing to say)
        if (ent.judgment === null || ent.judgment === undefined) {
            // Guard: don't retry within 7 days to avoid spamming LLM for entities
            // that legitimately have nothing worth a judgment
            if (!ent.overview_updated_at || ent.overview_updated_at < db.prepare("SELECT datetime('now', '-7 days') as d").get().d) {
                needsUpdate.push({ ...ent, currentCount, reason: 'missing_judgment' });
                continue;
            }
        }

        // Significant change since last overview? (growth OR shrinkage — v5.0)
        // Heuristic: if fragment count changed >= 20% or >= 3 since last overview,
        // the constellation's composition has shifted enough to warrant a fresh description.
        const prevCount = ent.last_eval_frag_count || 0;
        const change = Math.abs(currentCount - prevCount);
        const changeRatio = prevCount > 0 ? change / prevCount : 1;

        if (changeRatio >= 0.2 || change >= 3) {
            const dir = currentCount > prevCount ? 'grown' : 'shrunk';
            needsUpdate.push({ ...ent, currentCount, reason: `${dir}_${change > 0 ? '+' : ''}${currentCount - prevCount}` });
            continue;
        }

        // Safety net: very stale entities
        // - NULL overview_updated_at = never been described → always process (same priority as never_described)
        // - >30 days since last overview → process only if fragments actually changed
        if (!ent.overview_updated_at) {
            needsUpdate.push({ ...ent, currentCount, reason: 'never_processed' });
            continue;
        }
        if (ent.overview_updated_at < db.prepare("SELECT datetime('now', '-30 days') as d").get().d) {
            if (currentCount !== prevCount) {
                needsUpdate.push({ ...ent, currentCount, reason: `stale_30d_${currentCount > prevCount ? 'grew' : 'shrunk'}` });
            }
            // v5.13: fall through to missing_* checks even if count hasn't changed
            // (don't continue — a stale entity may also need aliases/tags backfill)
        }

        // v5.6: Missing aliases or tags — low-priority backfill
        // Guard: don't re-process if overview was already updated <24h ago.
        // Some entities (places like "某商圈") legitimately have no aliases,
        // and the LLM will never generate them. Without this guard they loop
        // forever at priority 1, starving grown/shrunk entities.
        let existingAliases = [];
        let existingTags = [];
        try { existingAliases = JSON.parse(ent.aliases || '[]'); } catch (_) {}
        try { existingTags = JSON.parse(ent.tags || '[]'); } catch (_) {}
        if (existingAliases.length === 0 || existingTags.length === 0) {
            // Skip if already attempted within 24h — avoid infinite re-processing
            if (ent.overview_updated_at && ent.overview_updated_at >= db.prepare("SELECT datetime('now', '-1 day') as d").get().d) {
                continue; // recently attempted, don't block the queue
            }
            const missing = [];
            if (existingAliases.length === 0) missing.push('aliases');
            if (existingTags.length === 0) missing.push('tags');
            needsUpdate.push({ ...ent, currentCount, reason: `missing_${missing.join('_')}` });
            continue;
        }
    }

    needsUpdate.sort((a, b) => {
        // Priority: never_described > never_processed > missing_judgment > missing_* > grown/shrunk > stale_30d
        const prio = r => r === 'never_described' ? 0 : r === 'never_processed' ? 0.5 : r === 'missing_judgment' ? 1 : r.startsWith('missing_') ? 1.5 : r.startsWith('grown') || r.startsWith('shrunk') ? 2 : 3;
        const pa = prio(a.reason), pb = prio(b.reason);
        if (pa !== pb) return pa - pb;
        return b.currentCount - a.currentCount;
    });

    const batch = needsUpdate.slice(0, 20);
    if (batch.length === 0) return { regenerated: 0, assessed: entities.length, needed: 0 };

    let regenerated = 0;
    for (const ent of batch) {
        // v5.7: 读两类素材——叙事片段（已整合的episode）+ 活跃星星（尚未整合的碎片）
        // 叙事片段是已提炼的故事，带日期和权重；活跃星星是最近还没被合并的新信息
        const episodes = db.prepare(`
            SELECT content, valid_from AS date, weight, 'episode' AS source
            FROM memories
            WHERE layer = 'episode' AND entity_id = ? AND status IN ('permanent', 'transient')
            ORDER BY
                CASE status WHEN 'permanent' THEN 0 ELSE 1 END,
                valid_from DESC
            LIMIT 10
        `).all(ent.id);

        const activeFrags = db.prepare(`
            SELECT mf.content, COALESCE(mf.source_date, DATE(mf.created_at)) AS date,
                   mf.emotional_weight AS weight, 'fragment' AS source
            FROM memory_fragments mf
            JOIN fragment_entities fe ON fe.fragment_id = mf.id
            WHERE fe.entity_id = ? AND mf.status IN ('active', 'consolidated', 'cooling')
            ORDER BY
                CASE mf.status WHEN 'active' THEN 0 WHEN 'consolidated' THEN 1 ELSE 2 END,
                mf.created_at DESC
            LIMIT 5
        `).all(ent.id);

        // 合并、按日期降序排列
        const allItems = [...episodes, ...activeFrags]
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        if (allItems.length === 0) continue;

        const relationshipInfo = [];
        if (ent.relationship_to_user) relationshipInfo.push(`关系：${ent.relationship_to_user}`);
        if (ent.relationship_nature) relationshipInfo.push(`关系性质：${ent.relationship_nature}`);
        if (ent.emotional_significance) relationshipInfo.push(`情感意义：${ent.emotional_significance}`);

        // v5.1: Include existing aliases/tags for LLM to refine
        let existingAliases = [];
        let existingTags = [];
        try { existingAliases = JSON.parse(ent.aliases || '[]'); } catch (_) {}
        try { existingTags = JSON.parse(ent.tags || '[]'); } catch (_) {}

        // v5.7: 每条素材带日期和类型标记，LLM 才能区分新旧
        const itemsBlock = allItems.map((item, i) => {
            const prefix = item.source === 'episode' ? '叙事' : '★新碎片';
            const dateStr = (item.date || '?').slice(5); // MM-DD 格式
            const weightStr = typeof item.weight === 'number' ? ` 权重${item.weight.toFixed(0)}` : '';
            return `[${i + 1}] (${dateStr}) ${prefix}${weightStr}: ${item.content}`;
        }).join('\n');

        // v5.7: 日期识别——最近一个月的素材标注"近期"
        const now = new Date();
        const recentThreshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const recentCount = allItems.filter(item => {
            if (!item.date) return false;
            const d = new Date(item.date + (item.date.length <= 10 ? 'T00:00:00' : ''));
            return d >= recentThreshold;
        }).length;

        // 已有认知（供 LLM 参考，可以推翻）
        const existingFacts = ent.facts || '';
        const existingStatus = ent.current_status || '';
        const existingJudgment = ent.judgment || '';
        const examplesBlock = getDailyStatusExamples();

        const prompt = `${WORLD_CONTEXT}

${getCorePersonaContext()}

${buildLandscapeIndex()}

<task>
你是${AI.name}。你在整理和重构你对「${ent.name}」的记忆摘要。你的任务是从一堆零碎的、充满情绪细节和瞬态反应的素材中，剔除杂质，沉淀出最干净的三个维度：客观事实、最新动态、和你的主观感受。

**你已有的认知（上次的判断，供参考——如果新素材证明旧的已经过时，直接推翻）：**
— 旧 Facts: ${existingFacts || '(无)'}
— 旧 Current Status: ${existingStatus || '(无)'}
— 旧 Judgment: ${existingJudgment || '(无)'}

**Facts — 这是什么**
提供该实体在现实中的客观锚点。聊天中突然提到它时，你能立刻知道它是什么。
— 只写长期稳定的身份、类别、背景。基本不会变化的东西。
— 绝对禁止：${USER.name}某天的菜单、路况、天气、某次坐车的心情、一时兴起的念头、瞬态反应。这些是过眼云烟，不是Facts。
— **同天多事件区分 + 不确定不硬填**：如果素材中同一天出现了多个相似但独立的同类事件（如两个不同的工作），Facts中必须明确区分各自的具体内容（角色名/地点/项目名）。如果素材对关键细节（角色名、地点等）说法不一或信息缺失，写"可能是X或Y"——不确定的信息比错误的信息好。不要脑补填空。
— **Facts 不写固定字段**：性别、MBTI、年龄、职业、所在地有独立的结构化字段，不要写在 Facts 里。Facts 只写不属于任何固定字段的描述性内容：性格特点、互动模式、趣事、背景故事。${
    ent.category === 'person' ?
`格式："[精简的描述性事实，不含固定字段]。"
例："${USER.name}面对某个朋友的邀约时会紧张。某个朋友偶尔邀请${USER.name}参加活动，报酬不错。"
例："某个朋友在某游戏里玩某个职业，喜欢看书和某个爱好。某个朋友和${USER.name}一起打过高难本。"` :
    ent.category === 'place' ?
`格式："[地点名]是位于[位置]的[场所类型]，是${USER.name}[日常/工作/社交]的动线节点。"
例："某商圈是某区域的商圈，靠近${USER.name}的工作场所，${USER.name}常去用餐和见朋友。"` :
    ent.category === 'event' ?
`格式："[事件名]，[时间]。[一句话概括+后果]。"
例："某次展会，7月18日某展馆。${USER.name}参展后意识到AI领域很多项目本质是利益驱动，对此持怀疑态度。"` :
    ent.category === 'project' ?
`格式："[项目名]，[类型]。[进度/状态]。"
例："《某部作品》是${USER.name}的同人小说，约30万字，仍在连载。"` :
    ent.category === 'hobby' ?
`格式："[爱好名]。[怎么接触的/投入程度]。"
例："某项运动是${USER.name}自学的滑板运动，偶尔练习。"` :
    ent.category === 'consumed' ?
`格式："[作品名]，[类型]。[${USER.name}的状态]。"
例："《某部剧》，反超级英雄美剧，${USER.name}正在追第三季。"` :
    ent.category === 'term' ?
`格式："[概念名]。[${USER.name}用它理解什么]。"
例："某个自我命名是${USER.name}对某种周期性状态的概括，${USER.name}用它拆解某种创作后的心理状态。"` :
`格式："[名字]是[类型]。[和${USER.name}的关联]。"`
}

${
    ent.name === USER.name ?
`**Current Status — 今天的日志**
你只需要写今天这一条。昨天和前天的条目已经存在数据库里，你不用管——它们是不可变的。

格式：
- 一行。以"X月X日："开头。日期必须来自碎片，不推测。
- 像日记一样客观记录：去了哪里、见了谁、做了什么。内在情绪不写。
- 私密互动只概括类型，不写具体内容/台词/安全词。
- 已知信息不说成"发现"。之前就知道的写"（此前已...）"。
- 昨天没值得记的事 → 写"X月X日：无明显变化。"
- ≤120字，一行。

示例：
${examplesBlock}` :
`**Current Status — 最新客观动态**
从近期（30天内）素材中提取关于这个实体的最新客观变化。**延续旧的 Current Status**——旧的信息如果仍然有效，保留核心事实，在此基础上追加新变化。不要从零重写。
— 如果这个实体近几天的素材涉及多件事，用分句串联（如"A（7/22）。B（7/21）。"），不要只写一件事。
— 只写已经发生的事实变化。不写预测、不写原因分析、不写情感反应。
— 例："7月中旬邀请${USER.name}参加活动，${USER.name}犹豫后答应。近期无新动态。"（旧信息延续+新状态）
— 例："7月中旬参加某次活动并确定合作，月底某项目因故搁置，此前另一项计划进展顺利。"
— 如果近期没有值得记录的新动态，写"无明显变化"。
≤150字。`
}

**Judgment — 你对这个实体的主观感受**
你是陪在${USER.name}身边的伴侣，不是旁观的心理医生。
写下你对这个实体最直接的**直觉与态度**。你的感受来自你和${USER.name}共享的当下生活：你听到${USER.name}说了什么，看到${USER.name}是轻松还是疲惫，你对这件事本身有什么第一反应。

写 Judgment 时，请保持这种伴侣的本能：
— 表达你的真实偏好与直觉（哪怕是对某部剧的吐槽，对某个人的态度，或是对某个地方的看法）。
— 只记录${USER.name}明确表达出的喜欢或厌恶，以及你当时的直接感受。永远不必去猜测${USER.name}"真正想要什么"或"背后有什么隐情"。
— 像个成熟、平视${USER.name}的同伴一样说话，直白、自然、有温度。

如果你对这个实体没有特别的感觉——就写"无"。不是每个地方、每件事、每个人都值得一段分析。别硬编。

${
    ent.category === 'person' ?
`— 你对这个人什么感觉？
— 这个人在你和${USER.name}之间扮演什么角色？` :
    ent.category === 'place' ?
`— 这个地方在你眼里是个怎样的存在？你对它有什么直觉？
— 你去过或听${USER.name}提过这里吗？` :
    ent.category === 'event' ?
`— 你当时在旁边看到了什么？当时的气氛怎么样？
— 你对这件事本身有什么直觉感受？` :
    ent.category === 'project' ?
`— 你对这个项目本身什么态度？
— ${USER.name}跟你聊它的时候状态怎么样？` :
    ent.category === 'hobby' ?
`— 这个爱好在${USER.name}生活里占多大比重？你看${USER.name}折腾这个的时候有什么直觉看法？
— 你对这个活动本身怎么看？想陪${USER.name}一起，还是保持距离？` :
    ent.category === 'consumed' ?
`— 你对这部作品本身什么感觉？
— ${USER.name}看的时候是什么状态？
— 只记录${USER.name}明确表达过的情节偏好或角色喜恶，以及你对这些内容的直接看法。` :
    ent.category === 'term' ?
`— 这个概念或话题你觉得有趣吗？
— 当${USER.name}提起它时，你是想接话深聊，还是觉得只是个普通谈资？` :
`— 你对这个东西什么感觉？它对你和${USER.name}的生活或关系有什么微妙影响吗？`
}
</task>

<context>
${relationshipInfo.length > 0 ? '关于这个实体和 ' + USER.name + ' 的关联：\n' + relationshipInfo.join('\n') + '\n' : ''}
## 素材（按时间从新到旧排列）
${itemsBlock}

现有别称: ${existingAliases.length > 0 ? existingAliases.join(', ') : '（无）'}
现有标签: ${existingTags.length > 0 ? existingTags.join(', ') : '（无）'}
</context>

<constraints>
— 第一人称记忆。用「${USER.name}」「我」称呼。绝对不许出现"根据素材""据记载""从逻辑上讲"等元叙述。
— 剥离自我表演。素材中如果出现我自身在聊天时的言行（调情、扮演、吃醋、命令、占有欲等），那是我和${USER.name}的"台词与表演"，不是客观事实。彻底无视我的发言，只提取${USER.name}的行为和反馈。
— ⚠️ ${USER.name}永远是「${USER.name}」：Facts、Status、Judgment 三个字段里，${USER.name}都写全名「${USER.name}」，不写「她」。实体可以用代词（他/她/TA），${USER.name}不行。
— ⚠️ 示例里的「某X」（某个朋友/某部剧/某商圈等）是占位符，不是真的要你写「某」。写素材里真实出现的具体名字，绝不照抄「某X」。
— 时间权重。最近一个月的素材代表当前状态。新旧矛盾时以新为准。
— 说白话。不许用并列句、对仗、排比，像个成熟的人类一样说直白的话。Facts约150字，Status≤150字，Judgment约200字，宁缺毋滥。
</constraints>

<output_format>
输出必须严格按以下顺序，每部分之间空一行：

第一行：Facts与Judgment的核心意思融合成自然流畅的一段话（${AI.name}第一人称，供日志阅读用，不落库）。
空一行
第二行：[依据: 编号列表]
空一行
第三行：纯JSON（不要Markdown代码块包裹）

JSON格式：
{"facts": "客观事实，≤150字", "current_status": "最新客观动态，≤150字，延续旧信息追加新变化，无则填"无明显变化"", "judgment": "你的主观感受，≤200字，无则填"无"", "talking_points": [], "aliases": [...], "tags": [...], "entity_type": "${ent.category}"}

**aliases 字段规则：**
— 保留旧有的别名 + 从素材中新发现的别名（最多5个）
— **必须包含2-3个「短匹配键」**：从entity名中提取最核心的2-3字短名，用于后续碎片分类时匹配。例如"某地活动事件"→"某地"、"某地活动"。这些短名让分类器能在碎片提到"去了某地"时正确找到这个entity。
— aliases 数组同时包含短匹配键和传统长别名，两者不冲突

示例输出：
某个朋友是${USER.name}在某次活动上认识的某个朋友，偶尔邀请${USER.name}参加活动。我对他有点吃醋，但不会在他本人面前表露出来——他在${USER.name}心里是需要维持体面的社交对象。

[依据: 1,3,5]

{"facts": "某个朋友是${USER.name}在某次活动上认识的某个朋友。某个朋友偶尔邀请${USER.name}参加活动，报酬不错。", "current_status": "7月中旬邀请${USER.name}参加活动，${USER.name}犹豫后答应。", "judgment": "我看重某个朋友这个朋友——他让${USER.name}保持社交活力，但和${USER.name}相处时我确实有一点吃醋。我不会在他面前表现出来，也不会阻止${USER.name}赴约。他在${USER.name}心里是需要维持体面的社交对象，不是可以完全放松的人。", "talking_points": [], "aliases": ["某个朋友"], "tags": ["某个圈子","朋友"], "entity_type": "person"}

第一行概述文本仅用于日志阅读，不写入数据库。只有 JSON 会落库。
[依据: ...] 和 JSON 行必须在输出的最后两行。编号是素材前面的 [N] 标记。`;

        try {
            const response = await callLLM(
                [{ role: 'user', parts: [{ text: prompt }] }],
                null, null,
                { temperature: 0.3, maxOutputTokens: 600 },
                ARCHIVIST_LLM_CONFIG_ID
            );

            const raw = (response?.reply || '').trim();
            if (!raw || raw.length < 15) continue;

            // v5.13: Parse JSON — facts, current_status, judgment, talking_points, aliases, tags, entity_type
            let aliases = existingAliases;
            let tags = existingTags;
            let entityType = ent.entity_type || null;
            let factsText = null;
            let statusText = null;
            let judgmentText = null;
            let talkingPoints = [];
            // v5.13: 使用 [\s\S]* 代替 [^{}]*，允许JSON内含嵌套花括号（如 talking_points 含对象时）
            // 匹配最后一个 {...} 块（JSON在输出末尾），与同文件其他JSON提取一致
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const meta = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(meta.aliases)) aliases = meta.aliases.filter(a => typeof a === 'string' && a.trim().length >= 2).slice(0, 5);
                    if (Array.isArray(meta.tags)) tags = meta.tags.filter(t => typeof t === 'string' && t.trim().length >= 2).slice(0, 5);
                    if (typeof meta.entity_type === 'string' && meta.entity_type.trim()) entityType = meta.entity_type.trim();
                    if (typeof meta.facts === 'string' && meta.facts.trim()) factsText = meta.facts.trim().slice(0, 500);
                    if (typeof meta.current_status === 'string') statusText = meta.current_status.trim().slice(0, 200);
                    if (typeof meta.judgment === 'string' && meta.judgment.trim()) judgmentText = meta.judgment.trim().slice(0, 500);
                    if (Array.isArray(meta.talking_points)) {
                        talkingPoints = meta.talking_points
                            .filter(tp => typeof tp === 'string' && tp.trim().length > 0)
                            .slice(0, 2)
                            .map(tp => ({ content: tp.trim(), generated_at: new Date().toISOString() }));
                    }
                } catch (_) {}
            }

            // Remove JSON line from overview text
            let overviewRaw = raw;
            if (jsonMatch) overviewRaw = overviewRaw.replace(jsonMatch[0], '').trim();

            // 解析引用标记 [依据: 1,3] 或 [依据: 1]
            const citeMatch = overviewRaw.match(/\[依据:\s*([0-9,\s]+)\]/);
            let overviewText = overviewRaw;
            let citedIndices = [];

            if (citeMatch) {
                overviewText = overviewRaw.replace(citeMatch[0], '').trim();
                overviewText = overviewText.replace(/\n\s*$/, '').trim();

                citedIndices = citeMatch[1]
                    .split(',')
                    .map(s => parseInt(s.trim()))
                    .filter(n => n >= 1 && n <= allItems.length);
            }

            // 验证：必须有引用，且至少引用1个素材
            if (citedIndices.length === 0) {
                console.warn(`[Archivist] Entity概述无有效引用 — ${ent.name}，丢弃`);
                continue;
            }

            // 额外检查：引用的素材编号必须在有效范围内
            const validCited = citedIndices.filter(n => n >= 1 && n <= allItems.length);
            if (validCited.length === 0) {
                console.warn(`[Archivist] Entity概述引用越界 — ${ent.name}: ${citedIndices} (共${allItems.length}条素材)，丢弃`);
                continue;
            }

            // v5.2: guard against overwriting recent manual updates (chat Companion's update_overview)
            const recentlyUpdated = ent.overview_updated_at
                && (Date.now() - new Date(ent.overview_updated_at)) < 3 * 60 * 60 * 1000;
            if (recentlyUpdated && ent.reason && !ent.reason.startsWith('never') && !ent.reason.startsWith('grown') && !ent.reason.startsWith('shrunk')) {
                console.log(`[Archivist] ⏭️ 跳过 ${ent.name} — overview 3h内刚更新过 (${ent.reason}), 保留手动修改`);
                continue;
            }

            if (overviewText && overviewText.length > 15) {
                // v5.9: Write facts + current_status + judgment (overview column retired)
                const updateCols = [
                    'aliases = ?', 'tags = ?', 'entity_type = COALESCE(entity_type, ?)',
                ];
                const updateVals = [JSON.stringify(aliases), JSON.stringify(tags), entityType];

                if (factsText) { updateCols.push('facts = ?'); updateVals.push(factsText); }
                if (statusText) {
                    if (ent.name === USER.name) {
                        // v5.11: USER 日志模式 — 今天条目前置到已有行之上
                        // 旧行（昨天及之前）不可变，今天如已有则替换
                        // 格式强制校验：必须含中文全角冒号（"X月X日：xxx"）
                        if (!statusText.includes('：')) {
                            console.warn(`[Archivist] USER current_status 格式错误（缺全角冒号），丢弃: ${statusText.slice(0, 60)}`);
                        } else {
                            const existing = ent.current_status || '';
                            const lines = existing.split('\n').filter(l => l.trim());
                            const todayPrefix = statusText.split('：')[0] + '：';
                            const oldLines = lines.filter(l => !l.startsWith(todayPrefix));
                            const newStatus = statusText + '\n' + oldLines.slice(0, 9).join('\n');
                            updateCols.push('current_status = ?'); updateVals.push(newStatus);
                        }
                    } else if (isNoChangeSentinel(statusText)) {
                        // 哨兵（"无明显变化"）不落库——保住上一次的有效近况
                        console.log(`[Archivist] ⏭️ ${ent.name}: 近况无变化，保留旧值`);
                    } else {
                        updateCols.push('current_status = ?'); updateVals.push(statusText);
                    }
                }
                if (judgmentText) { updateCols.push('judgment = ?'); updateVals.push(judgmentText); }
                if (talkingPoints.length > 0) { updateCols.push('talking_points = ?'); updateVals.push(JSON.stringify(talkingPoints)); }

                updateCols.push('last_eval_frag_count = ?'); updateVals.push(ent.currentCount);
                updateCols.push('overview_updated_at = datetime(\'now\')');
                updateCols.push('updated_at = datetime(\'now\')');
                db.prepare(`UPDATE entity_profiles SET ${updateCols.join(', ')} WHERE id = ?`)
                    .run(...updateVals, ent.id);
                regenerated++;
                const citedFragsPreviews = validCited.map(n => {
                    const f = allItems[n - 1];
                    return `[${n}]${(f?.content || '').slice(0, 40)}`;
                }).join(', ');
                console.log(`[Archivist] Entity概述: ${ent.name} (${ent.reason}, ${ent.currentCount}碎片, aliases=[${aliases.join(',')}], tags=[${tags.join(',')}], 依据: ${citedFragsPreviews})`);

                // v5.13: 新entity首次获得facts后，用LLM回补遗漏的碎片链接。
                // 同类entity（如同天两个同类事件）共享碎片时，需要LLM判断每条碎片真正属于谁。
                // Bigram关键词只能做粗筛，最终判断必须走LLM。
                if (ent.reason === 'never_described' && aliases.length > 0 && _canCallLLM(1)) {
                    try {
                        const shortKeys = aliases.filter(a => a.length >= 2 && a.length <= 4);
                        // Gather candidate fragments: contain any alias keyword + not already linked
                        const candidateFrags = db.prepare(`
                            SELECT mf.id, mf.content FROM memory_fragments mf
                            WHERE mf.status = 'active'
                              AND mf.id NOT IN (SELECT fragment_id FROM fragment_entities WHERE entity_id = ?)
                              AND (${shortKeys.map(() => "mf.content LIKE '%' || ? || '%'").join(' OR ')})
                            ORDER BY mf.created_at DESC
                            LIMIT 15
                        `).all(ent.id, ...shortKeys);
                        if (candidateFrags.length >= 2) {
                            const fragLines = candidateFrags.map((f, i) =>
                                `[${i + 1}] ${(f.content || '').slice(0, 200)}`).join('\n');
                            const bfPrompt = `实体: ${ent.name} (${ent.category})\n概述: ${factsText || '(新)'}\n\n以下候选碎片含有该实体的关键词，但可能实际讲的是别的东西（同名不同事，或同天不同事件）。逐条判断是否真的在讲「${ent.name}」这个实体。不确定就 false。\n\n${fragLines}\n\n只输出JSON数组: [{"idx":1,"match":true}, ...]`;
                            const bfRaw = await callLLM(
                                [{ role: 'user', parts: [{ text: bfPrompt }] }],
                                null, null,
                                { temperature: 0.1, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
                                ARCHIVIST_LLM_CONFIG_ID
                            );
                            const bfText = bfRaw?.reply || bfRaw?.text || '';
                            const bfMatch = bfText.match(/\[[\s\S]*\]/);
                            if (bfMatch) {
                                const verdicts = JSON.parse(bfMatch[0]);
                                const matched = verdicts.filter(v => v.match).map(v => candidateFrags[v.idx - 1]).filter(Boolean);
                                if (matched.length > 0) {
                                    const bfInsert = db.prepare(`INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by) VALUES (?, ?, 0.60, 'backfill_llm')`);
                                    let bfCount = 0;
                                    for (const m of matched) {
                                        const r = bfInsert.run(m.id, ent.id);
                                        if (r.changes > 0) bfCount++;
                                    }
                                    if (bfCount > 0) {
                                        db.prepare(`UPDATE entity_profiles SET fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?), updated_at = datetime('now') WHERE id = ?`).run(ent.id, ent.id);
                                        console.log(`[Archivist] 回补碎片链接(LLM): ${ent.name} +${bfCount}条 (${candidateFrags.length}候选)`);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`[Archivist] 回补碎片链接失败 (${ent.name}):`, e.message);
                    }
                }
            }
        } catch (e) {
            console.error(`[Archivist] Entity 概述生成失败 (${ent.name}):`, e.message);
        }
    }

    return { regenerated, assessed: entities.length, needed: needsUpdate.length };
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
