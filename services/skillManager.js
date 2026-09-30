// =================================================================
// Skill Manager — Archivist 自我進化技能系統
//
// Skill 是 Archivist 創造的個性化分析工具，儲存在 archivist_skills 表。
// 生命週期：hypothesis → 追蹤觀察 → 自評估 → 升級 (monitor) 或變性 (lesson)
//
// 兩種方向：
//   - 對使用者的認知：行為模式、情緒規律
//   - 對記憶系統質量：分類糾錯、圖譜健康
//
// 建立門檻：機械篩選（≥3 獨立資料點）+ LLM 判斷（是否是模式）
// =================================================================

const { getDb } = require('../database');
const { callLLM } = require('./llm');
const { WORLD_CONTEXT } = require('./worldContext');
const { USER, AI } = require('./nameResolver');

const SKILL_LLM_CONFIG = 38;  // flash model, cheap — skill evaluation
const SKILL_CREATE_MIN_OBSERVATIONS = 3;   // 至少3個數據點才建立
const SKILL_EVAL_MIN_OBSERVATIONS = 5;      // 至少5個觀察才自評估
const SKILL_INITIAL_CONFIDENCE = 0.25;      // 初始置信度

// ═══════════════════════════════════════════════════════
// Skill Creation — 機械篩選 + LLM 判斷
// ═══════════════════════════════════════════════════════

/**
 * @param {Object} params
 * @param {'user'|'system'} params.domain — 對使用者的認知 or 對記憶系統質量
 * @param {string} params.sourcePattern — 觸發建立的模式描述
 * @param {string[]} params.entityIds — 涉及的 entity IDs
 * @param {Object} params.triggerConfig — { type: 'keyword'|'entity'|'schedule'|'threshold', config: {...} }
 * @param {Object} params.analysisConfig — { type: 'llm'|'sql'|'statistical', prompt?: string, query?: string }
 * @returns {number|null} skill id or null if not created
 */
async function createSkill(params) {
    const db = getDb();
    const { domain, sourcePattern, entityIds = [], triggerConfig = {}, analysisConfig = {} } = params;

    // Mechanical filter: do we have enough evidence?
    if (!sourcePattern || sourcePattern.length < 10) {
        console.log('[SkillManager] 建立跳過: 模式描述不足');
        return null;
    }

    // Check for duplicate: similar source_pattern already has an active skill?
    const existing = db.prepare(
        "SELECT id FROM archivist_skills WHERE source_pattern = ? AND status IN ('active','verified') LIMIT 1"
    ).get(sourcePattern);
    if (existing) {
        console.log(`[SkillManager] 建立跳過: 已有相似技能 #${existing.id}`);
        return null;
    }

    // LLM judgment: is this a real pattern or coincidence?
    const isPattern = await _judgePattern(domain, sourcePattern);
    if (!isPattern) {
        console.log('[SkillManager] LLM判斷: 非顯著模式，不建立 skill');
        return null;
    }

    const info = db.prepare(`
        INSERT INTO archivist_skills (type, trigger_config, analysis_config, entity_ids, source_pattern, confidence, status)
        VALUES ('hypothesis', ?, ?, ?, ?, ?, 'active')
    `).run(
        JSON.stringify(triggerConfig),
        JSON.stringify(analysisConfig),
        JSON.stringify(entityIds),
        sourcePattern,
        SKILL_INITIAL_CONFIDENCE
    );

    const skillId = info.lastInsertRowid;
    console.log(`[SkillManager] 建立 hypothesis skill #${skillId}: ${sourcePattern.substring(0, 80)}...`);
    return skillId;
}

async function _judgePattern(domain, sourcePattern) {
    const domainLabel = domain === 'system' ? '記憶系統分類質量' : '{user}的行為/情緒模式';

    const prompt = `你是認知模式分析器。Archivist 觀察到一個潛在模式，需要你判斷這是真正的規律還是隨機巧合。

## 領域
${domainLabel}

## 觀察到的模式
${sourcePattern}

## 判斷標準
- 如果這個模式描述的是隨時間重複出現的規律，且至少出現了2-3次，可能是真模式
- 如果描述的是單一的、孤立的觀察，或兩個事件之間沒有因果/統計關聯，則是巧合
- 保守判斷：不確定時傾向於認為不是模式

只輸出一個JSON：
{"is_pattern": true/false, "reason": "一句話理由（20字以內）"}`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.1, maxOutputTokens: 100 },
            SKILL_LLM_CONFIG
        );

        let text = (response?.reply || '').replace(/```json|```/g, '').trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return false;
        const result = JSON.parse(match[0]);
        console.log(`[SkillManager] 模式判斷: ${result.is_pattern} — ${result.reason}`);
        return result.is_pattern === true;
    } catch (e) {
        console.error('[SkillManager] 模式判斷失敗:', e.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════
// Skill Trigger — 檢查條件是否滿足，執行分析
// ═══════════════════════════════════════════════════════

/**
 * Trigger all active skills whose trigger conditions match recent events
 * @param {Object} context — { newFragmentIds?: number[], entityId?: number, sourceDate?: string }
 * @returns {number} number of skills triggered
 */
async function triggerSkills(context = {}) {
    const db = getDb();
    const skills = db.prepare(
        "SELECT * FROM archivist_skills WHERE status = 'active' AND type IN ('hypothesis','monitor') ORDER BY last_triggered_at ASC NULLS FIRST"
    ).all();

    if (skills.length === 0) return 0;

    let triggered = 0;
    for (const skill of skills) {
        try {
            const triggerConfig = JSON.parse(skill.trigger_config || '{}');
            const shouldTrigger = _matchTrigger(triggerConfig, context, skill);

            if (!shouldTrigger) continue;

            const observation = await _runAnalysis(skill, context);
            if (observation) {
                _recordObservation(skill.id, observation);
                db.prepare("UPDATE archivist_skills SET last_triggered_at = datetime('now') WHERE id = ?").run(skill.id);
                triggered++;
            }
        } catch (e) {
            console.error(`[SkillManager] skill #${skill.id} 觸發失敗:`, e.message);
        }
    }

    if (triggered > 0) {
        console.log(`[SkillManager] 觸發了 ${triggered}/${skills.length} 個 skill`);
    }
    return triggered;
}

function _matchTrigger(config, context, skill) {
    if (!config || !config.type) return false;

    switch (config.type) {
        case 'keyword':
            // Trigger when new fragments contain specific keywords
            if (!context.newFragmentIds || context.newFragmentIds.length === 0) return false;
            const keywords = config.keywords || [];
            if (keywords.length === 0) return false;
            // Check if any new fragment matches keywords
            const db = getDb();
            const placeholders = context.newFragmentIds.map(() => '?').join(',');
            const frags = db.prepare(`
                SELECT content FROM memory_fragments WHERE id IN (${placeholders})
            `).all(...context.newFragmentIds);
            return frags.some(f => keywords.some(kw => (f.content || '').toLowerCase().includes(kw.toLowerCase())));

        case 'entity':
            // Trigger when specific entity gets new fragments
            if (!config.entity_id || !context.entityId) return false;
            return config.entity_id === context.entityId;

        case 'schedule':
            // Trigger on schedule (checked via last_triggered_at)
            if (!config.interval_hours) return false;
            if (!skill.last_triggered_at) return true;
            const hoursSince = (Date.now() - new Date(skill.last_triggered_at + 'Z').getTime()) / 3600000;
            return hoursSince >= config.interval_hours;

        case 'threshold':
            // Trigger when some metric exceeds threshold
            // config.metric: 'entity_frag_count' | 'category_density' | 'correction_count'
            // config.value: threshold value
            return _checkThresholdTrigger(config);

        default:
            return false;
    }
}

function _checkThresholdTrigger(config) {
    const db = getDb();
    switch (config.metric) {
        case 'entity_frag_count':
            if (!config.entity_id) return false;
            const fragCount = db.prepare(
                'SELECT COUNT(*) as c FROM memory_fragments WHERE entity_id = ? AND status = ?'
            ).get(config.entity_id, 'active');
            return (fragCount?.c || 0) >= (config.value || 10);

        case 'correction_count':
            const corrCount = db.prepare(
                "SELECT COUNT(*) as c FROM cognitive_corrections WHERE status = 'active'"
            ).get();
            return (corrCount?.c || 0) >= (config.value || 5);

        default:
            return false;
    }
}

async function _runAnalysis(skill, context) {
    const analysisConfig = JSON.parse(skill.analysis_config || '{}');
    const db = getDb();

    switch (analysisConfig.type) {
        case 'llm': {
            // LLM-based analysis: run the prompt from analysisConfig
            const prompt = analysisConfig.prompt || '分析以下觀察資料，輸出一句話的觀察結論。';
            const data = await _gatherAnalysisData(skill, context, analysisConfig);
            if (!data) return null;

            try {
                const response = await callLLM(
                    [{ role: 'user', parts: [{ text: `${prompt}\n\n資料：\n${data}` }] }],
                    WORLD_CONTEXT,
                    null,
                    { temperature: 0.2, maxOutputTokens: 200 },
                    SKILL_LLM_CONFIG
                );
                return (response?.reply || '').trim();
            } catch (e) {
                console.error(`[SkillManager] LLM分析 skill #${skill.id} 失敗:`, e.message);
                return null;
            }
        }

        case 'sql': {
            // SQL-based analysis: run the query from analysisConfig
            try {
                const query = analysisConfig.query;
                if (!query) return null;
                const rows = db.prepare(query).all();
                return JSON.stringify(rows);
            } catch (e) {
                console.error(`[SkillManager] SQL分析 skill #${skill.id} 失敗:`, e.message);
                return null;
            }
        }

        case 'statistical': {
            // Simple statistical check
            const data = await _gatherAnalysisData(skill, context, analysisConfig);
            return data ? `統計觀察: ${data}` : null;
        }

        default:
            return null;
    }
}

async function _gatherAnalysisData(skill, context, analysisConfig) {
    const db = getDb();
    const entityIds = JSON.parse(skill.entity_ids || '[]');

    // Gather recent fragments for involved entities
    if (entityIds.length > 0) {
        const fragments = db.prepare(`
            SELECT mf.content, mf.created_at, mf.emotional_weight
            FROM memory_fragments mf
            WHERE mf.entity_id IN (${entityIds.map(() => '?').join(',')})
              AND mf.status = 'active'
            ORDER BY mf.created_at DESC
            LIMIT 20
        `).all(...entityIds);

        if (fragments.length === 0) return null;
        return fragments.map(f =>
            `[${f.created_at?.substring(0, 10) || '?'}] ew=${f.emotional_weight} ${(f.content || '').substring(0, 150)}`
        ).join('\n');
    }

    // Gather recent fragments from context
    if (context.newFragmentIds && context.newFragmentIds.length > 0) {
        const placeholders = context.newFragmentIds.map(() => '?').join(',');
        const fragments = db.prepare(`
            SELECT content, created_at, emotional_weight
            FROM memory_fragments WHERE id IN (${placeholders})
        `).all(...context.newFragmentIds);

        if (fragments.length === 0) return null;
        return fragments.map(f =>
            `[${f.created_at?.substring(0, 10) || '?'}] ew=${f.emotional_weight} ${(f.content || '').substring(0, 150)}`
        ).join('\n');
    }

    return null;
}

function _recordObservation(skillId, observation) {
    const db = getDb();
    const skill = db.prepare('SELECT observations FROM archivist_skills WHERE id = ?').get(skillId);
    if (!skill) return;

    const observations = JSON.parse(skill.observations || '[]');
    observations.push({
        timestamp: new Date().toISOString(),
        content: observation,
    });

    // Keep last 50 observations max
    const trimmed = observations.slice(-50);

    db.prepare('UPDATE archivist_skills SET observations = ? WHERE id = ?')
        .run(JSON.stringify(trimmed), skillId);

    console.log(`[SkillManager] skill #${skillId} 觀察記錄: ${observation.substring(0, 80)}...`);
}

// ═══════════════════════════════════════════════════════
// Skill Evaluation — 自評估：升級、變性、或繼續觀察
// ═══════════════════════════════════════════════════════

/**
 * Evaluate all skills that have enough observations
 * @returns {{ evaluated: number, upgraded: number, falsified: number }}
 */
async function evaluateSkills() {
    const db = getDb();
    const skills = db.prepare(`
        SELECT * FROM archivist_skills
        WHERE status = 'active'
          AND type = 'hypothesis'
          AND observations != '[]'
        ORDER BY last_evaluated_at ASC NULLS FIRST
    `).all();

    let evaluated = 0, upgraded = 0, falsified = 0;

    for (const skill of skills) {
        const observations = JSON.parse(skill.observations || '[]');
        if (observations.length < SKILL_EVAL_MIN_OBSERVATIONS) continue;

        try {
            const result = await _selfEvaluate(skill, observations);
            if (!result) continue;

            evaluated++;

            if (result.verdict === 'verified' && result.confidence >= 0.6) {
                // Upgrade to monitor
                db.prepare(`
                    UPDATE archivist_skills
                    SET type = 'monitor', confidence = ?, self_evaluation = ?,
                        status = 'verified', last_evaluated_at = datetime('now')
                    WHERE id = ?
                `).run(result.confidence, JSON.stringify(result), skill.id);
                console.log(`[SkillManager] skill #${skill.id} 升級為 monitor: ${skill.source_pattern?.substring(0, 60)}...`);
                upgraded++;
            } else if (result.verdict === 'falsified') {
                // Transform to lesson
                db.prepare(`
                    UPDATE archivist_skills
                    SET type = 'lesson', confidence = 0.1, self_evaluation = ?,
                        status = 'falsified', last_evaluated_at = datetime('now')
                    WHERE id = ?
                `).run(JSON.stringify(result), skill.id);
                console.log(`[SkillManager] skill #${skill.id} 變性為 lesson: ${result.reason?.substring(0, 60)}...`);

                // Falsified lesson feeds into cognitive correction
                _feedLessonToCorrection(skill, result).catch(e =>
                    console.error('[SkillManager] lesson 轉 correction 失敗:', e.message));

                falsified++;
            } else {
                // Still uncertain, update timestamps
                db.prepare(`
                    UPDATE archivist_skills
                    SET last_evaluated_at = datetime('now'), self_evaluation = ?
                    WHERE id = ?
                `).run(JSON.stringify(result), skill.id);
                console.log(`[SkillManager] skill #${skill.id} 繼續觀察 (${observations.length} obs)`);
            }
        } catch (e) {
            console.error(`[SkillManager] skill #${skill.id} 評估失敗:`, e.message);
        }
    }

    if (evaluated > 0) {
        console.log(`[SkillManager] 評估了 ${evaluated} 個 skill (${upgraded} 升級, ${falsified} 變性)`);
    }
    return { evaluated, upgraded, falsified };
}

async function _selfEvaluate(skill, observations) {
    const obsText = observations.slice(-10).map((o, i) =>
        `${i + 1}. [${o.timestamp?.substring(0, 10) || '?'}] ${o.content}`
    ).join('\n');

    const prompt = `你是認知 skill 的自我評估器。一個 hypothesis skill 已經積累了 ${observations.length} 次觀察，你需要判斷它是否成立。

## Skill 描述
${skill.source_pattern || '未記錄'}

## 觀察記錄
${obsText}

## 判斷標準
- 如果觀察一致地支援原始假設（≥60% 觀察與假設一致），且沒有明顯的反例 → verified
- 如果大部分觀察與假設相悖，或模式從未真正出現 → falsified
- 如果資料還不足以判斷，證據混雜 → uncertain
- 保守判斷：不確定時選 uncertain

只輸出一個JSON：
{"verdict":"verified|falsified|uncertain","confidence":0.0-1.0,"reason":"一句話理由（30字以內）","evidence_summary":"關鍵證據概述（50字以內）"}`;

    try {
        const response = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            null, null,
            { temperature: 0.1, maxOutputTokens: 250 },
            SKILL_LLM_CONFIG
        );

        let text = (response?.reply || '').replace(/```json|```/g, '').trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        return JSON.parse(match[0]);
    } catch (e) {
        console.error('[SkillManager] 自評估 LLM 失敗:', e.message);
        return null;
    }
}

/**
 * Feed a falsified lesson into the cognitive correction system
 */
async function _feedLessonToCorrection(skill, evalResult) {
    try {
        const { logCorrection } = require('./cognitiveEvolution');
        const entityIds = JSON.parse(skill.entity_ids || '[]');

        if (entityIds.length === 0) return;

        const db = getDb();
        const entity = db.prepare('SELECT id, name FROM entity_profiles WHERE id = ?').get(entityIds[0]);
        if (!entity) return;

        await logCorrection(
            entity.id,
            entity.name,
            `SKILL_HYPOTHESIS: ${skill.source_pattern?.substring(0, 40)}`,
            `FALSIFIED: ${evalResult.reason?.substring(0, 60)}`,
            evalResult.evidence_summary || 'skill 觀察資料不支援原始假設',
            evalResult.evidence_summary || '',
            0
        );
        console.log(`[SkillManager] lesson #${skill.id} → cognitive correction (entity: ${entity.name})`);
    } catch (e) {
        console.error('[SkillManager] lesson 轉 correction 失敗:', e.message);
    }
}

// ═══════════════════════════════════════════════════════
// Skill Scanning — 主動掃描是否有值得建立 skill 的模式
// ═══════════════════════════════════════════════════════

/**
 * Scan recent fragments for patterns worth investigating as skills
 * Called during deep work cycle
 */
async function scanForPatterns() {
    const db = getDb();

    // 1. Check for entities with fragment growth but low confidence
    const entities = db.prepare(`
        SELECT ep.id, ep.name, ep.relationship_confidence, ep.relationship_to_user,
               COUNT(mf.id) as frag_count
        FROM entity_profiles ep
        JOIN memory_fragments mf ON mf.entity_id = ep.id
        WHERE ep.category = 'person'
          AND ep.name NOT IN ('${USER.name}', '${AI.name}')
          AND ep.relationship_confidence IN ('low', 'medium')
          AND mf.status = 'active'
        GROUP BY ep.id
        HAVING COUNT(mf.id) >= 10
        ORDER BY frag_count DESC
    `).all();

    for (const ent of entities) {
        // Check if we already have a skill tracking this entity's relationship ambiguity
        const existing = db.prepare(`
            SELECT id FROM archivist_skills
            WHERE entity_ids LIKE ? AND status = 'active' AND type = 'hypothesis'
        `).get(`%${ent.id}%`);
        if (existing) continue;

        // Pattern: this entity keeps appearing but relationship stays uncertain
        // → create a skill to monitor for relationship signals
        const sourcePattern = `${ent.name} 頻繁出現在{user}的生活中（${ent.frag_count} 條碎片），但關係仍不確定（當前：${ent.relationship_to_user || '未知'}，confidence: ${ent.relationship_confidence || 'low'}）`;

        await createSkill({
            domain: 'user',
            sourcePattern,
            entityIds: [ent.id],
            triggerConfig: {
                type: 'entity',
                entity_id: ent.id,
            },
            analysisConfig: {
                type: 'llm',
                prompt: `分析以下與 ${ent.name} 相關的最新碎片，判斷是否有足夠資訊確定TA與{user}的關係。如果有新線索，描述關係的可能方向。如果仍不確定，說明為什麼資訊不足。`,
            },
        });
    }

    // 2. Check for emotional patterns — clusters of high-EW fragments
    const highEWClusters = db.prepare(`
        SELECT source_date, COUNT(*) as cnt, AVG(emotional_weight) as avg_ew
        FROM memory_fragments
        WHERE emotional_weight >= 0.6
          AND status = 'active'
          AND source_date IS NOT NULL
        GROUP BY source_date
        HAVING cnt >= 3
        ORDER BY source_date DESC
        LIMIT 5
    `).all();

    for (const cluster of highEWClusters) {
        const existing = db.prepare(
            "SELECT id FROM archivist_skills WHERE source_pattern LIKE ? AND status = 'active'"
        ).get(`%${cluster.source_date}%高情緒%`);
        if (existing) continue;

        const sourcePattern = `${cluster.source_date} 當天出現了 ${cluster.cnt} 條高情緒碎片（avg ew=${cluster.avg_ew.toFixed(2)}），可能存在情緒觸發事件`;

        await createSkill({
            domain: 'user',
            sourcePattern,
            entityIds: [],
            triggerConfig: {
                type: 'keyword',
                keywords: [],  // Generic, triggered manually
            },
            analysisConfig: {
                type: 'statistical',
            },
        });
    }

    return { scanned: entities.length + highEWClusters.length };
}

// ═══════════════════════════════════════════════════════
// Public API: Get active monitor insights (for whisper)
// ═══════════════════════════════════════════════════════

function getActiveInsights() {
    const db = getDb();
    const skills = db.prepare(`
        SELECT * FROM archivist_skills
        WHERE status = 'active'
          AND type IN ('hypothesis','monitor')
          AND confidence >= 0.2
        ORDER BY confidence DESC, last_evaluated_at DESC
        LIMIT 10
    `).all();

    return skills.map(s => ({
        id: s.id,
        type: s.type,
        sourcePattern: s.source_pattern,
        confidence: s.confidence,
        entityIds: JSON.parse(s.entity_ids || '[]'),
        observations: JSON.parse(s.observations || '[]').slice(-5),
        lastEvaluated: s.last_evaluated_at,
        lastTriggered: s.last_triggered_at,
    }));
}

/**
 * Get verified monitors — high confidence, well-tested skills
 * These are the most reliable insights for whisper injection
 */
function getVerifiedMonitors() {
    const db = getDb();
    const skills = db.prepare(`
        SELECT * FROM archivist_skills
        WHERE type = 'monitor' AND status = 'verified' AND confidence >= 0.6
        ORDER BY confidence DESC
    `).all();

    return skills.map(s => ({
        id: s.id,
        sourcePattern: s.source_pattern,
        confidence: s.confidence,
        entityIds: JSON.parse(s.entity_ids || '[]'),
        observations: JSON.parse(s.observations || '[]').slice(-3),
    }));
}

module.exports = {
    createSkill,
    triggerSkills,
    evaluateSkills,
    scanForPatterns,
    getActiveInsights,
    getVerifiedMonitors,
};
