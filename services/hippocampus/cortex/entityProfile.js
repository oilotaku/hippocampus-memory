// =================================================================
// Entity Profile（實體檔案）：維護人物/地點/事件/作品的最新已知狀態
// =================================================================

const { getDb } = require('../../../database');
const { sealField } = require('../../memoryCrypto');
const { callLLM } = require('../../llm');
const { WORLD_CONTEXT } = require('../../worldContext');
const { USER, AI } = require('../../nameResolver');

const ENTITY_EXTRACT_PROMPT = `${WORLD_CONTEXT}

你是實體檔案更新器。識別以下記憶片段中人物/地點/事件/作品的狀態變化。

狀態變化 = 人物/地點/事件/作品的狀態發生更新（人物所在地/工作/生活階段/關係變化；地點用途/狀態變化；事件進展/狀態變化；作品進度/狀態變化）。

輸出嚴格JSON：
{
  "updates": [
    {"entity": "實體名", "category": "person|place|event|project", "new_status": "一句話最新狀態", "status_since": "YYYY-MM或空"}
  ]
}

規則：
- 只提取明確的狀態變化，不編造
- "${USER.name}"和"${AI.name}"的狀態也提取（他們是主角）
- 同一實體多條狀態變化取最新一條
- 沒有狀態變化的記憶忽略`;

async function updateEntityProfiles(newEpisodes) {
    if (!newEpisodes || newEpisodes.length === 0) return [];

    const episodesText = newEpisodes.map((ep, i) =>
        `[記憶${i + 1}] ${ep.memoryContent} (date: ${ep.correctedDate || '未知'})`
    ).join('\n\n');

    let result;
    try {
        const raw = await callLLM(
            [{ role: 'user', parts: [{ text: `識別以下記憶中的實體狀態變化：\n\n${episodesText}` }] }],
            ENTITY_EXTRACT_PROMPT,
            null,
            { temperature: 0.1, maxOutputTokens: 2000 },
            36
        );
        const clean = raw.reply.replace(/```json|```/g, '').trim();
        result = JSON.parse(clean);
    } catch (e) {
        console.error('[EntityProfile] LLM提取失敗:', e.message);
        return [];
    }

    if (!result?.updates?.length) return [];

    const db = getDb();

    // 預取已有檔案，做 status_since 時間校驗
    const existingMap = new Map();
    const allNames = [...new Set(result.updates.map(u => u.entity).filter(Boolean))];
    if (allNames.length > 0) {
        const placeholders = allNames.map(() => '?').join(',');
        const existing = db.prepare(`SELECT name, status_since FROM entity_profiles WHERE name IN (${placeholders})`).all(...allNames);
        for (const e of existing) {
            existingMap.set(e.name, e.status_since || '');
        }
    }

    const upsert = db.prepare(`
        INSERT INTO entity_profiles (name, category, current_status, status_since, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET
            current_status = excluded.current_status,
            status_since = COALESCE(excluded.status_since, entity_profiles.status_since),
            updated_at = datetime('now')
    `);

    const updated = [];
    for (const u of result.updates) {
        if (!u.entity || !u.new_status) continue;

        // v5.13: 主角的 current_status 由每日 cron (generateDailyEntityStatus) 獨佔維護。
        // updateEntityProfiles 是深迴圈 consolidator 的副產品，不能覆蓋主角的日式日誌。
        if (u.entity === USER.name) {
            console.log(`[EntityProfile] ${USER.name} 跳過（每日cron獨佔維護 current_status）`);
            continue;
        }

        // ⚠️ 哨兵（"無明顯變化"）不落庫——跟 archivist 那邊同一條規矩。
        // 這裡是**整段替換**語義，且實體不存在時會直接 INSERT 建一個。
        try {
            const { isNoChangeSentinel } = require('../../archivist');
            if (isNoChangeSentinel(u.new_status)) {
                console.log(`[EntityProfile] ${u.entity} 跳過（近況是哨兵值，保留舊值）`);
                continue;
            }
        } catch (e) {
            console.warn('[EntityProfile] 哨兵閘載入失敗（按舊行為繼續）:', e.message);
        }

        // 時間校驗：新 status_since 不比舊的新 → 跳過（防止過期資訊覆蓋新資訊）
        const newSince = u.status_since || '';
        const oldSince = existingMap.get(u.entity) || '';
        if (newSince && oldSince && newSince < oldSince) {
            console.log(`[EntityProfile] ${u.entity} 跳過（status_since ${newSince} < ${oldSince}，舊資訊更新）`);
            continue;
        }

        upsert.run(u.entity, u.category || 'person', sealField('entity_profiles', 'current_status', u.new_status), u.status_since || '');
        updated.push(u.entity);
        console.log(`[EntityProfile] ${u.entity} → ${u.new_status}`);
    }

    return updated;
}

// 從檢索結果中提取涉及的非主角實體，查檔案返回近況注入行
function getEntityContext(fragments) {
    if (!fragments || fragments.length === 0) return null;

    const db = getDb();
    const entityIds = new Set();

    // Path 1: fragment_entities 連結（新系統——星座歸屬）
    const fragIds = fragments
        .filter(f => f.source_table === 'fragment')
        .map(f => f.id);
    if (fragIds.length > 0) {
        const placeholders = fragIds.map(() => '?').join(',');
        const linked = db.prepare(`
            SELECT DISTINCT entity_id FROM fragment_entities
            WHERE fragment_id IN (${placeholders})
        `).all(...fragIds);
        linked.forEach(r => entityIds.add(r.entity_id));
    }

    // Path 2: 舊 entity 欄位（Scribe 提取時標註的實體名）
    if (fragIds.length > 0) {
        const placeholders = fragIds.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT DISTINCT entity FROM memory_fragments
            WHERE id IN (${placeholders}) AND entity != ''
        `).all(...fragIds);
        const names = [...new Set(rows.map(r => r.entity))];
        if (names.length > 0) {
            const matched = db.prepare(`
                SELECT id FROM entity_profiles
                WHERE name IN (${names.map(() => '?').join(',')})
            `).all(...names);
            matched.forEach(r => entityIds.add(r.id));
        }
    }

    if (entityIds.size === 0) return null;

    // Fetch profiles with all three fields: facts, current_status, judgment
    const idList = [...entityIds];
    const profiles = db.prepare(`
        SELECT id, name, category, related_entities, overview_updated_at, fragment_count,
               facts, current_status, judgment, gender,
               relationship_category, mbti, location, occupation, age_text
        FROM entity_profiles
        WHERE id IN (${idList.map(() => '?').join(',')})
          AND name NOT IN (?, ?)
        ORDER BY fragment_count DESC
        LIMIT 5
    `).all(...idList, ...require('../../memoryConfig').SKIP_NAMES.slice(0, 2));

    if (profiles.length === 0) return null;

    // Track entity access
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const trackHit = db.prepare(`
        UPDATE entity_profiles SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?
    `);
    for (const p of profiles) {
        trackHit.run(now, p.id);
    }

    return profiles.map(p => {
        // Build compact header with structured fields for person entities
        const badges = [];
        if (p.relationship_category) badges.push(p.relationship_category);
        if (p.mbti) badges.push(p.mbti);
        if (p.location) badges.push(p.location);
        if (p.occupation) badges.push(p.occupation);
        if (p.age_text) badges.push(p.age_text);
        const headerExtra = badges.length > 0 ? ` | ${badges.join(' · ')}` : '';
        // 性別直接掛在名字旁——是事實，不是指令
        const genderTag = (p.gender && p.gender !== 'unknown') ? ` — ${p.gender}` : '';
        let line = `※ ${p.name}${genderTag}（${p.category}${headerExtra}）`;

        if (p.facts) {
            line += `\n  Facts: ${p.facts}`;
        }
        if (p.current_status) {
            // 日式日誌只注入最新3行，節省token
            const lines = p.current_status.replace(/\r/g, '').split('\n').filter(l => l.trim()).slice(0, 3);
            line += `\n  Status: ${lines.join('\n')}`;
        }
        if (p.judgment) {
            line += `\n  Judgment: 你回想起這個以後，內心升起的想法是"${p.judgment}"`;
        }

        // 標註過時（>7天未更新）
        if (p.overview_updated_at) {
            const hrsStale = Math.round((Date.now() - new Date(p.overview_updated_at + 'Z').getTime()) / 3600000);
            if (hrsStale > 168) {
                line += `\n  ⚠️ 已${Math.round(hrsStale/24)}天未更新——若${USER.name}最近有新情況，用 update_overview 重新整理`;
            }
        }

        // 關聯星座
        try {
            const rels = JSON.parse(p.related_entities || '[]');
            if (rels.length > 0) {
                const relStr = rels.slice(0, 3)
                    .map(r => r.relation ? `${r.name}（${r.relation}）` : r.name)
                    .join('、');
                line += `\n  ↳ 關聯星座：${relStr}`;
            }
        } catch (_) {}

        // 最近敘事片段（episodes），每條截斷到80字
        const episodes = db.prepare(`
            SELECT content, valid_from FROM memories
            WHERE layer = 'episode' AND status = 'permanent' AND entity_id = ?
            ORDER BY valid_from DESC LIMIT 3
        `).all(p.id);

        if (episodes.length > 0) {
            line += '\n  📖 最近動態：';
            episodes.forEach((ep, i) => {
                const date = (ep.valid_from || '?').slice(5);
                const text = ep.content.length > 80 ? ep.content.slice(0, 80) + '…' : ep.content;
                line += `\n    ${i + 1}. (${date}) ${text}`;
            });
            line += '\n  （用 recall_memory 可檢視完整敘事片段，或追溯到原始聊天訊息）';
        }

        // v5.8: 注入相關 Saga（跨實體敘事弧線）
        // Saga 的 memory_ids 中包含本實體的 episode → 展示標題 + 截斷描述
        try {
            const entityEpisodeIds = db.prepare(`
                SELECT id FROM memories
                WHERE layer = 'episode' AND status = 'permanent' AND entity_id = ?
            `).all(p.id).map(r => r.id);

            if (entityEpisodeIds.length > 0) {
                const activeSagas = db.prepare(`
                    SELECT title, description, memory_ids FROM memory_sagas
                    WHERE status = 'active' AND memory_ids IS NOT NULL
                    ORDER BY created_at DESC
                `).all();

                const relatedSagas = activeSagas.filter(s => {
                    try {
                        const ids = JSON.parse(s.memory_ids);
                        return ids.some(id => entityEpisodeIds.includes(id));
                    } catch (_) { return false; }
                }).slice(0, 3);  // 最多3條

                if (relatedSagas.length > 0) {
                    line += '\n  🗺 敘事弧線：';
                    relatedSagas.forEach(s => {
                        const desc = (s.description || '').length > 100
                            ? (s.description || '').slice(0, 100) + '…'
                            : (s.description || '');
                        line += `\n    · ${s.title}${desc ? ' — ' + desc : ''}`;
                    });
                }
            }
        } catch (_) {}

        return line;
    }).join('\n');
}

module.exports = { updateEntityProfiles, getEntityContext };
