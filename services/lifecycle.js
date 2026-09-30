// =================================================================
// 生命週期引擎 — 記憶的新陳代謝
//
// 每個記憶物件都有完整的生命週期：出生 → 成熟 → 衰減 → 退休
// 每天凌晨執行一次，負責碎片GC、episode衰減、實體提取、糾正反饋
// =================================================================

const { getDb } = require('../database');
const { sealField } = require('./memoryCrypto');
const { chromaDBOperation } = require('./memory');
const { callLLM } = require('./llm');
const { USER, AI } = require('./nameResolver');
const { sqlNow, sqlDaysAgo } = require('../utils/time');
const { getRecallConfig } = require('./recallGate');

const CONFIG = {
    FRAGMENT_COOLING_DAYS: 14,     // 14天無人訪問 → 冷卻
    FRAGMENT_FROZEN_DAYS: 30,      // 冷卻後30天 → 凍結（從ChromaDB刪除向量）
    FRAGMENT_TOMBSTONE_DAYS: 90,   // 凍結後90天 → 墓碑（清空內容，僅留證據鏈）
    EPISODE_MATURE_MONTHS: 6,      // 6個月未觸達 → 成熟（權重減半）
    EPISODE_ARCHIVE_MONTHS: 12,    // 12個月 → 歸檔
    MIN_FRAGS_FOR_ENTITY: 2,       // 實體最少碎片數才提取
    CORRECTION_DAYS_LOOKBACK: 7,   // 糾正反饋追溯天數
    LLM_API_NAME: '[書庫]DS',
    LLM_API_NAME_SIMPLIFIED: '[书库]DS',  // 舊資料庫存的是簡體渠道名（migration 108 會轉成繁體，讀取端兩者都接受）
};

// =================================================================
// Fragment GC: 推動碎片走完整生命週期
// =================================================================

async function runFragmentGC() {
    const db = getDb();
    const now = sqlNow();
    const stats = { cooled: 0, resurrected: 0, frozen: 0, tombstoned: 0 };

    // G1：read_count 原本同時是 novelty 的懲罰與這裡的續命，角色相反。recall.gate 開啟時，
    // 「被讀過」改看 cited_count（真的被引用）或近期 last_accessed_at（被注入也會更新它，
    // 但只算 14 天內，不再是「曾被讀過一次就永遠免疫」）；關閉時維持 read_count。
    const gateOn = getRecallConfig().gate;

    // 1. 活躍 → 冷卻：14天以上沒人看過
    const coolingCutoff = sqlDaysAgo(CONFIG.FRAGMENT_COOLING_DAYS);
    const toCool = db.prepare(`
        SELECT id, chroma_id FROM memory_fragments
        WHERE status = 'active'
          AND ${gateOn ? `COALESCE(cited_count, 0) = 0
          AND (last_accessed_at IS NULL OR last_accessed_at < ?)` : 'read_count = 0'}
          AND created_at < ?
    `).all(...(gateOn ? [coolingCutoff, coolingCutoff] : [coolingCutoff]));

    for (const f of toCool) {
        db.prepare(`UPDATE memory_fragments SET status = 'cooling', lifecycle_updated_at = ? WHERE id = ?`)
            .run(now, f.id);
    }
    stats.cooled = toCool.length;

    // 2. 復活：冷卻期被訪問過的 → 重回活躍
    const resurrected = db.prepare(`
        SELECT id FROM memory_fragments
        WHERE status = 'cooling'
          AND ${gateOn ? `(COALESCE(cited_count, 0) > 0
               OR (last_accessed_at IS NOT NULL AND lifecycle_updated_at IS NOT NULL AND last_accessed_at > lifecycle_updated_at))` : 'read_count > 0'}
    `).all();

    for (const f of resurrected) {
        db.prepare(`UPDATE memory_fragments SET status = 'active', lifecycle_updated_at = ? WHERE id = ?`)
            .run(now, f.id);
    }
    stats.resurrected = resurrected.length;

    // 3. 冷卻 → 凍結：冷卻30天以上 → 刪除ChromaDB向量
    const frozenCutoff = sqlDaysAgo(CONFIG.FRAGMENT_FROZEN_DAYS);
    const toFreeze = db.prepare(`
        SELECT id, chroma_id FROM memory_fragments
        WHERE status = 'cooling'
          AND lifecycle_updated_at IS NOT NULL
          AND lifecycle_updated_at < ?
    `).all(frozenCutoff);

    for (const f of toFreeze) {
        // 從 ChromaDB 刪除向量（fire-and-forget，不阻塞）
        if (f.chroma_id && !f.chroma_id.startsWith('dup_of_')) {
            chromaDBOperation('delete', { id: f.chroma_id }).catch(e =>
                console.error(`[Lifecycle] ChromaDB刪除失敗 frag#${f.id}:`, e.message)
            );
        }
        db.prepare(`UPDATE memory_fragments SET status = 'frozen', lifecycle_updated_at = ? WHERE id = ?`)
            .run(now, f.id);
    }
    stats.frozen = toFreeze.length;

    // 4. 凍結 → 墓碑：凍結90天 → 清空內容，僅保留證據鏈
    const tombstoneCutoff = sqlDaysAgo(CONFIG.FRAGMENT_TOMBSTONE_DAYS);
    const toTombstone = db.prepare(`
        SELECT id FROM memory_fragments
        WHERE status = 'frozen'
          AND lifecycle_updated_at IS NOT NULL
          AND lifecycle_updated_at < ?
    `).all(tombstoneCutoff);

    for (const f of toTombstone) {
        db.prepare(`UPDATE memory_fragments SET status = 'tombstone', content = ?, lifecycle_updated_at = ? WHERE id = ?`)
            .run(sealField('memory_fragments', 'content', '[expired]'), now, f.id);
    }
    stats.tombstoned = toTombstone.length;

    if (stats.cooled + stats.resurrected + stats.frozen + stats.tombstoned > 0) {
        console.log(`[Lifecycle] Fragment GC: cooled=${stats.cooled} back=${stats.resurrected} frozen=${stats.frozen} tomb=${stats.tombstoned}`);
    }

    return stats;
}

// =================================================================
// Episode 衰減: permanent → mature → archived
// =================================================================

async function runEpisodeDecay() {
    const db = getDb();
    const now = sqlNow();
    const stats = { matured: 0, archived: 0 };

    // permanent → mature: 6個月（標準）/ 12個月（flash）
    const matureCutoff = sqlDaysAgo((CONFIG.EPISODE_MATURE_MONTHS) * 30);
    const matureFlashCutoff = sqlDaysAgo(CONFIG.EPISODE_MATURE_MONTHS * 2 * 30);

    // 標準 episode
    const toMatureStandard = db.prepare(`
        SELECT id FROM memories
        WHERE status = 'permanent'
          AND (consolidation_type IS NULL OR consolidation_type != 'flash')
          AND (last_accessed_at IS NULL OR last_accessed_at < ?)
          AND (updated_at IS NULL OR updated_at < ?)
    `).all(matureCutoff, matureCutoff);

    // Flash episode：衰減減半
    const toMatureFlash = db.prepare(`
        SELECT id FROM memories
        WHERE status = 'permanent'
          AND consolidation_type = 'flash'
          AND (last_accessed_at IS NULL OR last_accessed_at < ?)
          AND (updated_at IS NULL OR updated_at < ?)
    `).all(matureFlashCutoff, matureFlashCutoff);

    const toMature = [...toMatureStandard, ...toMatureFlash];

    // 「權重減半」用 2.0 做浮點除法（INTEGER 欄位遇到非整數會保留 REAL，correction 的 ×0.3 也是如此）；
    // 原本 weight / 2 是 SQLite 整數除法，5 會變 2 而不是 2.5。
    for (const m of toMature) {
        db.prepare(`
            UPDATE memories SET status = 'mature', weight = MAX(1, weight / 2.0), updated_at = ?
            WHERE id = ?
        `).run(now, m.id);
    }
    stats.matured = toMature.length;

    // mature → archived: 12個月（標準）/ 24個月（flash）
    const archiveCutoff = sqlDaysAgo((CONFIG.EPISODE_ARCHIVE_MONTHS) * 30);
    const archiveFlashCutoff = sqlDaysAgo(CONFIG.EPISODE_ARCHIVE_MONTHS * 2 * 30);

    const toArchiveStandard = db.prepare(`
        SELECT id FROM memories
        WHERE status = 'mature'
          AND (consolidation_type IS NULL OR consolidation_type != 'flash')
          AND updated_at < ?
    `).all(archiveCutoff);

    const toArchiveFlash = db.prepare(`
        SELECT id FROM memories
        WHERE status = 'mature'
          AND consolidation_type = 'flash'
          AND updated_at < ?
    `).all(archiveFlashCutoff);

    const toArchive = [...toArchiveStandard, ...toArchiveFlash];

    for (const m of toArchive) {
        db.prepare(`UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`)
            .run(now, m.id);
    }
    stats.archived = toArchive.length;

    if (stats.matured + stats.archived > 0) {
        console.log(`[Lifecycle] Episode decay: matured=${stats.matured} archived=${stats.archived}`);
    }

    return stats;
}

// =================================================================
// 實體提取：從活躍碎片直接提取實體狀態（不依賴Consolidator）
// =================================================================

const ENTITY_EXTRACTION_SYSTEM = `你是實體狀態提取器。給出關於同一個實體的碎片列表，提取這個實體當前的最新狀態。

輸出嚴格JSON：
{
  "current_status": "一句話描述實體的最新狀態（如'已從某國家回國，在某城市寫小說'、'家裡茶葉：某茶、某茶、某茶，某茶已喝完'）",
  "no_change": false
}

規則：
- 只記錄最新狀態，不保留歷史
- 如果碎片沒有描述實體狀態的實際變化，設 no_change=true
- 優先記錄實體屬性變化（位置、職業、狀態、擁有物）
- 不要編造碎片中沒有的資訊`;

async function runEntityExtraction() {
    const db = getDb();
    const stats = { extracted: 0, skipped: 0, unchanged: 0 };

    // 拿到最近7天的活躍碎片，按實體分組
    const cutoffDate = sqlDaysAgo(7);
    const frags = db.prepare(`
        SELECT id, entity, content, type, emotional_weight, source_date
        FROM memory_fragments
        WHERE status IN ('active', 'cooling')
          AND entity IS NOT NULL
          AND entity != ''
          AND created_at >= ?
        ORDER BY entity, created_at DESC
    `).all(cutoffDate);

    // 按 entity 分組
    const groups = {};
    for (const f of frags) {
        if (!groups[f.entity]) groups[f.entity] = [];
        if (groups[f.entity].length < 15) groups[f.entity].push(f); // 每組最多15條
    }

    const apiConfig = db.prepare(`SELECT id FROM api_configs WHERE name IN (?, ?) ORDER BY (name = ?) DESC LIMIT 1`)
        .get(CONFIG.LLM_API_NAME, CONFIG.LLM_API_NAME_SIMPLIFIED, CONFIG.LLM_API_NAME);
    if (!apiConfig) {
        console.warn('[Lifecycle] 實體提取：未找到LLM渠道，跳過');
        return stats;
    }

    for (const [entity, fragList] of Object.entries(groups)) {
        if (fragList.length < CONFIG.MIN_FRAGS_FOR_ENTITY) {
            stats.skipped++;
            continue;
        }

        try {
            // 查已有檔案
            const existing = db.prepare('SELECT current_status FROM entity_profiles WHERE name = ?').get(entity);

            const fragText = fragList.map(f =>
                `[${f.source_date || '?'}] ${f.content}`
            ).join('\n');

            const currentHint = existing
                ? `\n該實體當前已知狀態：${existing.current_status}\n請判斷碎片中是否有需要更新的新資訊。`
                : '';

            const raw = await callLLM(
                [{ role: 'user', parts: [{ text: `實體：${entity}\n\n碎片列表：\n${fragText}${currentHint}` }] }],
                ENTITY_EXTRACTION_SYSTEM,
                null,
                { temperature: 0.2, maxOutputTokens: 300 },
                apiConfig.id
            );

            const clean = (raw.reply || '').replace(/```json\n?|```/g, '').trim();
            const result = JSON.parse(clean);

            if (result.no_change) {
                stats.unchanged++;
                continue;
            }

            if (result.current_status) {
                // v5.13: 主角的 current_status 由每日 cron (generateDailyEntityStatus) 獨佔維護。
                // Lifecycle 的實體狀態提取不覆蓋主角的日式日誌。
                if (entity === USER.name) {
                    stats.unchanged++;
                    continue;
                }
                // ⚠️ 哨兵（"無明顯變化"）不落庫：這裡是**整段替換**語義，實體不存在時
                // 還會直接 INSERT 建一個。懶載入避免把整個 archivist 拖進來。
                try {
                    const { isNoChangeSentinel } = require('./archivist');
                    if (isNoChangeSentinel(result.current_status)) {
                        stats.unchanged++;
                        continue;
                    }
                } catch (e) {
                    console.warn('[Lifecycle] 哨兵閘載入失敗（按舊行為繼續）:', e.message);
                }
                const now = sqlNow();
                const sourceFragIds = JSON.stringify(fragList.map(f => f.id));

                db.prepare(`
                    INSERT INTO entity_profiles (name, category, current_status, status_since, source_fragment_ids, updated_at)
                    VALUES (?, 'person', ?, date('now'), ?, ?)
                    ON CONFLICT(name) DO UPDATE SET
                        current_status = excluded.current_status,
                        status_since = date('now'),
                        source_fragment_ids = excluded.source_fragment_ids,
                        updated_at = excluded.updated_at
                `).run(entity, sealField('entity_profiles', 'current_status', result.current_status), sourceFragIds, now);

                console.log(`[Lifecycle] 實體更新: ${entity} → ${result.current_status.slice(0, 60)}`);
                stats.extracted++;
            }
        } catch (e) {
            if (e instanceof SyntaxError) {
                // JSON解析失敗，跳過
            } else {
                console.error(`[Lifecycle] 實體提取失敗 ${entity}:`, e.message);
            }
        }
    }

    return stats;
}

// =================================================================
// 糾正反饋：{user}刪除記憶 → 查同類碎片降權
// =================================================================

async function runCorrectionFeedback() {
    const db = getDb();
    const stats = { processed: 0, cascaded: 0 };

    // 拿到最近7天內新增的糾正記錄
    const cutoffDate = sqlDaysAgo(CONFIG.CORRECTION_DAYS_LOOKBACK);
    const corrections = db.prepare(`
        SELECT * FROM correction_log
        WHERE status = 'active'
          AND created_at >= ?
        ORDER BY created_at DESC
    `).all(cutoffDate);

    for (const c of corrections) {
        try {
            // 降權同類碎片：找到與被糾正記憶內容相近的活躍碎片
            if (c.target_type === 'memory' && c.target_id) {
                // 查被刪記憶的碎片來源
                const deletedMemory = db.prepare('SELECT source_msg_ids FROM memories WHERE id = ?').get(c.target_id);
                let sourceIds = [];
                try { sourceIds = JSON.parse(deletedMemory?.source_msg_ids || '[]'); } catch {}

                if (sourceIds.length > 0) {
                    // 找到同源碎片 → 降權
                    const placeholders = sourceIds.map(() => '?').join(',');
                    const relatedFrags = db.prepare(`
                        SELECT id, emotional_weight FROM memory_fragments
                        WHERE status = 'active'
                          AND id IN (${placeholders})
                    `).all(...sourceIds);

                    for (const f of relatedFrags) {
                        const newEW = Math.max(0.1, (f.emotional_weight || 0.5) * 0.5);
                        db.prepare(`UPDATE memory_fragments SET emotional_weight = ? WHERE id = ?`)
                            .run(newEW, f.id);
                        stats.cascaded++;
                    }
                }
            }

            db.prepare(`UPDATE correction_log SET status = 'applied' WHERE id = ?`).run(c.id);
            stats.processed++;
        } catch (e) {
            console.error(`[Lifecycle] 糾正處理失敗 #${c.id}:`, e.message);
        }
    }

    if (stats.processed > 0) {
        console.log(`[Lifecycle] Correction feedback: ${stats.processed} processed, ${stats.cascaded} frags demoted`);
    }

    return stats;
}

// =================================================================
// 主入口：每日cron呼叫
// =================================================================

async function runLifecycleMaintenance() {
    console.log('[Lifecycle] 每日維護開始...');
    const db = getDb();

    // 確保 migration 已跑（lifecycle_updated_at 列）
    ensureLifecycleMigration(db);

    // 1. Fragment GC — 每天
    const gcStats = await runFragmentGC();

    // 2. Episode 衰減 — 每天
    const decayStats = await runEpisodeDecay();

    // 3. 實體提取 — 每週一次（週日）
    const isSunday = new Date().getDay() === 0;
    let entityStats = null;
    if (isSunday) {
        entityStats = await runEntityExtraction();
    }

    // 4. 糾正反饋 — 每週一次（週日）
    let correctionStats = null;
    if (isSunday) {
        correctionStats = await runCorrectionFeedback();
    }

    // 5. Memory Weight 重算 — 每天
    const weightStats = recalculateMemoryWeights();

    console.log(`[Lifecycle] 完成: GC(${gcStats.cooled}c/${gcStats.frozen}f) decay(${decayStats.matured}m/${decayStats.archived}a) weight(${weightStats.memoriesUpdated})` +
        (entityStats ? ` entities(${entityStats.extracted})` : '') +
        (correctionStats ? ` corrections(${correctionStats.processed})` : ''));

    return { gcStats, decayStats, entityStats, correctionStats, weightStats };
}

// =================================================================
// Migration: 確保 lifecycle_updated_at 列存在
// =================================================================

function ensureLifecycleMigration(db) {
    try {
        const cols = db.prepare('PRAGMA table_info(memory_fragments)').all();
        if (!cols.find(c => c.name === 'lifecycle_updated_at')) {
            db.exec(`ALTER TABLE memory_fragments ADD COLUMN lifecycle_updated_at DATETIME`);
            // 現有碎片按建立時間初始化
            db.exec(`UPDATE memory_fragments SET lifecycle_updated_at = created_at WHERE lifecycle_updated_at IS NULL`);
            console.log('[Lifecycle] migration: lifecycle_updated_at column added');
        }
        // 確保 memories 表有 last_accessed_at
        const memCols = db.prepare('PRAGMA table_info(memories)').all();
        if (!memCols.find(c => c.name === 'last_accessed_at')) {
            db.exec(`ALTER TABLE memories ADD COLUMN last_accessed_at DATETIME`);
        }
    } catch (e) {
        console.error('[Lifecycle] migration error:', e.message);
    }
}

// 注入追蹤：記錄本輪對話注入了哪些記憶（供糾正反饋使用）
function trackMemoryInjection(chatId, messageId, memoryIds, fragmentIds) {
    try {
        const db = getDb();
        const record = JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            memory_ids: memoryIds || [],
            fragment_ids: fragmentIds || [],
            injected_at: sqlNow(),
        });
        // 存到 message 的 metadata 或單獨表。簡便做法：存到 correction_log 邊上的一個輕量表
        // 這裡先不做獨立的 injection 表，避免複雜化。需要時再建。
        // 當下只記錄到日誌，下一次迭代可以用上。
        console.log(`[Lifecycle] Injection tracked: chat=${chatId} msg=${messageId} mems=${(memoryIds||[]).length} frags=${(fragmentIds||[]).length}`);
    } catch (e) {
        // 非關鍵路徑，靜默失敗
    }
}

// =================================================================
// Memory Weight 衰減 — 每天重算 memories 和 memory_fragments 權重
// =================================================================

function recalculateMemoryWeights() {
    const db = getDb();

    // memories: 時間衰減 (-0.5/30天) + 訪問加成 (7天內+2, 30天內+1), clamp[2,8]
    // 註：以目前公式輸入最高只到 5+2=7，上限 8 實際碰不到；它是保護性 clamp
    //（日後調高基準或加成時不會超出 weight 的合法範圍），刻意保留、不改公式。
    const memResult = db.prepare(`
        UPDATE memories SET weight = CASE
            WHEN 5
                + CASE WHEN last_accessed_at > datetime('now', '-7 days') THEN 2
                       WHEN last_accessed_at > datetime('now', '-30 days') THEN 1
                       ELSE 0 END
                - CAST((julianday('now') - julianday(COALESCE(created_at, datetime('now')))) / 30.0 AS INTEGER) * 0.5
                < 2 THEN 2
            WHEN 5
                + CASE WHEN last_accessed_at > datetime('now', '-7 days') THEN 2
                       WHEN last_accessed_at > datetime('now', '-30 days') THEN 1
                       ELSE 0 END
                - CAST((julianday('now') - julianday(COALESCE(created_at, datetime('now')))) / 30.0 AS INTEGER) * 0.5
                > 8 THEN 8
            ELSE CAST(5
                + CASE WHEN last_accessed_at > datetime('now', '-7 days') THEN 2
                       WHEN last_accessed_at > datetime('now', '-30 days') THEN 1
                       ELSE 0 END
                - CAST((julianday('now') - julianday(COALESCE(created_at, datetime('now')))) / 30.0 AS INTEGER) * 0.5 AS INTEGER)
        END
        WHERE status IN ('permanent', 'ongoing')
    `).run();

    if (memResult.changes > 0) {
        console.log(`[Lifecycle] ⚖️ Memories Weight重算: ${memResult.changes}條`);
    }
    return { memoriesUpdated: memResult.changes };
}

module.exports = { runLifecycleMaintenance, runFragmentGC, runEpisodeDecay, runEntityExtraction, runCorrectionFeedback, trackMemoryInjection, recalculateMemoryWeights };
