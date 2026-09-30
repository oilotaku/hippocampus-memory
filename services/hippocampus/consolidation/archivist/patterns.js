// =================================================================
// services/archivist/patterns.js — 使用者行為模式：信心度與新鮮度、漂移偵測、維護與合併
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../../../database');
const { parseDbTime } = require('../../../../utils/time');
const { callLLM } = require('../../../llm');
const { USER } = require('../../../memoryConfig');
const { ARCHIVIST_LLM_CONFIG_ID } = require('./constants');
const { _canCallLLM } = require('./runtime');

const MIN_PATTERN_FRAGS = 3;        // 至少3條碎片才能形成一個 pattern

const PATTERN_LLM_BATCH = 30;       // 單次最多餵給 LLM 的碎片數

const PATTERN_MATCH_THRESHOLD = 0.35; // bigram 匹配已有 pattern 的閾值

const PATTERN_SUPERSEDED_THRESHOLD = 0.50; // 被取代的pattern匹配閾值需更高

const MIN_GAP_PATTERN_CLUSTER = 6 * 60 * 60 * 1000; // 6h 冷卻

const PATTERN_DORMANT_DAYS = 30;    // >30天無新觀察 → dormant

const PATTERN_ARCHIVE_DAYS = 180;   // >180天無新觀察 + conf<0.40 → archived

const PATTERN_CONTRADICT_THRESHOLD = 3; // 矛盾 ≥3 → 標記 needs_review

const PATTERN_MERGE_CANDIDATES = 3; // 攢夠3對合並候選 → LLM批次判斷

const PATTERN_MERGE_BIGRAM_OVERLAP = 0.45; // pattern間bigram重疊閾值 → 合併候選

const NEGATION_WORDS = /不|沒|不再|膩了|討厭|煩|噁心|不|没|不再|腻了|讨厌|烦|恶心/;


// 時態訊號——檢測偏好漂移（"以前X，現在Y"）
const TEMPORAL_PAST = /以前|曾經|原來|之前|本來|一直|從小|從前的|過去的|以前|曾经|原来|之前|本来|一直|从小|从前的|过去的/;

const TEMPORAL_SHIFT = /現在.*不了|現在.*不|不再|改了|變了|戒了|放棄|不.*以前|不.*原來|现在.*不了|现在.*不|不再|改了|变了|戒了|放弃|不.*以前|不.*原来/;

const TEMPORAL_COMPLETE = /已經.*不|完全不|再也不|已经.*不|完全不|再也不/;


// ── Confidence 公式（只升不降）──
function _calcPatternConfidence(evidenceCount, firstSeen, lastSeen) {
    if (!firstSeen || !lastSeen) return 0.15 + Math.min(0.40, evidenceCount * 0.04);
    const first = parseDbTime(firstSeen);
    const last = parseDbTime(lastSeen);
    const spanDays = Math.max(1, (last - first) / (1000 * 60 * 60 * 24));
    // 來源多樣性：從 source_fragment_ids 中統計不同日期的碎片數——呼叫方傳入
    return Math.min(0.90,
        0.15                                          // base
        + Math.min(0.40, evidenceCount * 0.04)         // 證據數：10條封頂
        + Math.min(0.25, spanDays / 365 * 0.25)        // 時間跨度：1年封頂
        - (evidenceCount >= 8 ? 0 : 0)                 // 預留超長期加成位
    );
}


// ── Freshness 衰減係數（用於注入排序，不影響 confidence）──
function _freshnessDecay(lastSeen) {
    if (!lastSeen) return 0.10;
    const daysSince = Math.max(0, (Date.now() - parseDbTime(lastSeen).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince <= 7) return 1.00;
    if (daysSince <= 30) return 0.85;
    if (daysSince <= 90) return 0.60;
    if (daysSince <= 180) return 0.30;
    return 0.10;
}


// ── 時態漂移檢測：碎片是否在"推翻"舊pattern ──
function _detectDrift(fragContent) {
    const hasPast = TEMPORAL_PAST.test(fragContent);
    const hasShift = TEMPORAL_SHIFT.test(fragContent) || TEMPORAL_COMPLETE.test(fragContent);
    return hasPast && hasShift;
}


// ── Bigram 分詞 ──
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


// ── Freshness-based狀態重新整理（每2min）──
function refreshPatternStates() {
    const db = getDb();
    const allPatterns = db.prepare("SELECT * FROM user_patterns WHERE status IN ('active','dormant','superseded')").all();
    let changed = 0, dormantCount = 0, archivedCount = 0;

    for (const p of allPatterns) {
        try {
            const daysSince = p.last_seen
                ? Math.max(0, (Date.now() - parseDbTime(p.last_seen).getTime()) / (1000 * 60 * 60 * 24))
                : 999;
            const conf = p.confidence || 0.15;

            let newStatus = p.status;
            if (p.status === 'active' && daysSince > PATTERN_DORMANT_DAYS) {
                newStatus = 'dormant';
                dormantCount++;
            } else if (p.status === 'dormant' && daysSince <= PATTERN_DORMANT_DAYS) {
                newStatus = 'active'; // 復活——最近有新匹配
            } else if (p.status === 'dormant' && daysSince > PATTERN_ARCHIVE_DAYS && conf < 0.40) {
                newStatus = 'archived';
                archivedCount++;
            } else if (p.status === 'superseded' && daysSince > PATTERN_DORMANT_DAYS) {
                // superseded保持本身狀態（不轉dormant），只等強訊號復活
            }

            if (newStatus !== p.status) {
                db.prepare("UPDATE user_patterns SET status=?, updated_at=datetime('now') WHERE id=?")
                    .run(newStatus, p.id);
                changed++;
            }
        } catch (_) {}
    }
    if (changed > 0) console.log(`[Archivist] 📊 模式狀態重新整理: ${changed}條變化 (dormant:${dormantCount} archived:${archivedCount})`);
    return { changed, dormant: dormantCount, archived: archivedCount };
}


// ── v5.9: maintainPatterns — 每6h，bigram匹配碎片到全部非archived pattern，含復活+漂移檢測 ──
async function maintainPatterns() {
    const db = getDb();

    // 1. 獲取最近 observation + preference 碎片
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
            // 矛盾檢測
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

            // 漂移檢測：碎片有時態訊號 → 舊pattern標記superseded
            const isDrift = _detectDrift(frag.content);
            if (isDrift && bestMatch.status !== 'superseded') {
                db.prepare(`UPDATE user_patterns SET status='superseded', last_seen=?,
                    updated_at=datetime('now') WHERE id=?`).run(frag.source_date, bestMatch.id);
                supersededCount++;
                // 碎片不進舊pattern的證據鏈——它將是新pattern的種子
                continue;
            }

            // 正常匹配：追加證據（superseded被高閾值匹配也應復活）
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

            // 跨pattern去重候選
            for (const other of existingPatterns) {
                if (other.id <= bestMatch.id) continue; // 每對只檢一次
                if (other.status === 'archived') continue;
                const overlap = _bigramOverlap(bestMatch.content, other.content);
                if (overlap >= PATTERN_MERGE_BIGRAM_OVERLAP) {
                    mergeCandidates.push({ patternA_id: bestMatch.id, patternB_id: other.id, overlap });
                }
            }
        }
    }

    // 3. 跨pattern合併（攢夠閾值 → LLM批次判斷）
    if (mergeCandidates.length >= PATTERN_MERGE_CANDIDATES && _canCallLLM(1)) {
        await _mergePatterns(db, mergeCandidates);
    }

    if (matchedCount > 0) console.log(`[Archivist] 📊 模式維護: ${matchedCount}條匹配 (復活${revivedCount} 取代${supersededCount})`);
    return { matched: matchedCount, revived: revivedCount, superseded: supersededCount };
}


// ── LLM 批次判斷跨pattern合併 ──
async function _mergePatterns(db, candidates) {
    // 去重取唯一 pair
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
        const key = [c.patternA_id, c.patternB_id].sort().join('-');
        if (!seen.has(key)) { seen.add(key); unique.push(c); }
    }
    if (unique.length < 2) return;

    // 載入pattern內容
    const allIds = [...new Set(unique.flatMap(c => [c.patternA_id, c.patternB_id]))];
    const patternMap = new Map();
    db.prepare(`SELECT id, content, evidence_count, first_seen, last_seen, source_fragment_ids FROM user_patterns WHERE id IN (${allIds.map(()=>'?').join(',')})`).all(...allIds)
        .forEach(p => patternMap.set(p.id, p));

    const prompt = `判斷每對行為模式是否在描述同一個底層特質。是 → merge=true。不是 → merge=false。

${unique.map((c, i) => {
    const a = patternMap.get(c.patternA_id), b = patternMap.get(c.patternB_id);
    return `[${i+1}] A:"${a?.content}" B:"${b?.content}"`;
}).join('\n')}

輸出JSON陣列：[{"pair":1,"merge":true},{"pair":2,"merge":false}]`;

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
            // 取證據多的為主
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
            console.log(`[Archivist] 🔗 模式合併: #${main.id}←#${sub.id} "${main.content.slice(0,40)}"`);
        }
    } catch (e) {
        console.warn('[Archivist] _mergePatterns 失敗:', e.message);
    }
}


// ── 保留舊 clusterObservations 作為 maintainPatterns 的別名，相容現有 dispatch ──
async function clusterObservations() {
    const result = await maintainPatterns();
    return { matched: result.matched ?? result.clustered ?? 0, newPatterns: 0 };
}

module.exports = {
    MIN_PATTERN_FRAGS,
    PATTERN_LLM_BATCH,
    PATTERN_MATCH_THRESHOLD,
    PATTERN_SUPERSEDED_THRESHOLD,
    MIN_GAP_PATTERN_CLUSTER,
    PATTERN_DORMANT_DAYS,
    PATTERN_ARCHIVE_DAYS,
    PATTERN_CONTRADICT_THRESHOLD,
    PATTERN_MERGE_CANDIDATES,
    PATTERN_MERGE_BIGRAM_OVERLAP,
    NEGATION_WORDS,
    TEMPORAL_PAST,
    TEMPORAL_SHIFT,
    TEMPORAL_COMPLETE,
    _calcPatternConfidence,
    _freshnessDecay,
    _detectDrift,
    _tokenize,
    _bigramOverlap,
    refreshPatternStates,
    maintainPatterns,
    _mergePatterns,
    clusterObservations,
};
