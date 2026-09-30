// =================================================================
// 冥想盆：記憶檢索系統（硬觸發 + 向量檢索 + ChromaDB操作）
// =================================================================

const { getDb } = require('../database');
const { encryption } = require('../encryption');

// ChromaDB 常駐服務地址（Docker 部署時通過環境變數 CHROMA_URL 指向 chroma 容器）
const CHROMA_URL = process.env.CHROMA_URL || 'http://127.0.0.1:7707';

// =================================================================
// ChromaDB 操作（HTTP 呼叫 chroma_service.py 常駐服務）
// =================================================================

async function chromaDBOperation(action, data) {
    const resp = await fetch(`${CHROMA_URL}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);
    return result;
}

// =================================================================
// 多 Collection 批次查詢（供 Librarian 雙路召回）
// =================================================================
async function queryMultiCollections(queries) {
    if (!queries || queries.length === 0) return [];
    const result = await chromaDBOperation('query_multi', { queries });
    return result.results || [];
}

// =================================================================
// 硬觸發檢索：檢查使用者訊息是否包含記憶庫中的標籤
// =================================================================

function searchMemoriesByHardTrigger(userMessage) {
    if (!userMessage) return [];

    try {
        const db = getDb();
        const allMemories = db.prepare(`
            SELECT id, content, tags, status, valid_from, valid_to
            FROM memories
            WHERE tags IS NOT NULL AND tags != '[]'
              AND status IN ('permanent', 'ongoing')
        `).all();

        const matchedMemories = [];
        const today = new Date().toISOString().split('T')[0];

        for (const memory of allMemories) {
            let tags = [];
            try { tags = JSON.parse(memory.tags); } catch (e) { continue; }

            const isMatch = tags.some(tag => userMessage.includes(tag));

            if (isMatch) {
                if (memory.valid_from && memory.valid_from > today) continue;

                try {
                    const dec = encryption.decrypt(memory.content);
                    if (dec === null) { console.error(`Memory ID ${memory.id} decryption failed，已跳過`); continue; }
                    memory.content = dec;
                    matchedMemories.push(memory);
                } catch (err) {
                    console.error(`Memory ID ${memory.id} decryption failed`, err);
                }
            }
        }
        return matchedMemories;
    } catch (error) {
        console.error('searchMemoriesByHardTrigger error:', error);
        return [];
    }
}

// =================================================================
// 本地 Embedding（HTTP 呼叫 chroma_service）
// =================================================================

async function getLocalEmbedding(text) {
    const resp = await fetch(`${CHROMA_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
    });
    const result = await resp.json();
    if (result.embedding) return result.embedding;
    throw new Error(result.error || 'No embedding in response');
}

// =================================================================
// 向量檢索：本地 embedding + ChromaDB 查詢
// =================================================================

async function searchMemoriesByVector(query, nResults = 3) {
    try {
        // 1. 本地生成 query embedding
        const queryEmbedding = await getLocalEmbedding(query);
        console.log('searchMemoriesByVector: query="' + query.substring(0, 60) + '" dim:', queryEmbedding?.length);

        if (!queryEmbedding || queryEmbedding.length === 0) {
            console.log('searchMemoriesByVector: embedding generation failed');
            return [];
        }

        // 2. HTTP 呼叫 chroma_service 查詢
        const pythonResult = await chromaDBOperation('query', {
            embedding: queryEmbedding,
            n_results: nResults,
            query_text: query,
            min_similarity: 0.20,
        });

        const db = getDb();

        // 3. 計算每個結果的相似度（1 - distance）
        const resultIds = pythonResult.ids[0] || [];
        const resultDistances = pythonResult.distances?.[0] || [];
        console.log(`searchMemoriesByVector: ChromaDB returned ${resultIds.length} results, similarities: [${resultDistances.map(d => (1-d).toFixed(3)).join(', ')}]`);
        const idToSimilarity = {};
        for (let i = 0; i < resultIds.length; i++) {
            idToSimilarity[resultIds[i]] = 1 - resultDistances[i];
        }

        // v5.3: 重新啟用 episode（memories 表）向量檢索
        // v5.0 退役是因為舊 episode 來自廢棄知識樹。v5.3 consolidateCategory
        // 改為從 entity_profiles 星座產出，新 episode 質量可靠且已重新索引 ChromaDB
        const fragmentIds = [];
        const memoryIds = [];

        for (const id of resultIds) {
            if (id.startsWith('fragment_')) fragmentIds.push(id.replace('fragment_', ''));
            else if (id.startsWith('memory_')) memoryIds.push(id.replace('memory_', ''));
        }

        if (resultIds.length === 0) return [];

        const results = [];

        // 查 memory_fragments 表（只返回 active，consolidated 不走向量路徑）
        if (fragmentIds.length > 0) {
            const placeholders = fragmentIds.map(() => '?').join(',');
            const fragments = db.prepare(`SELECT * FROM memory_fragments WHERE id IN (${placeholders}) AND status = 'active'`).all(...fragmentIds);
            const staleCount = fragmentIds.length - fragments.length;
            if (staleCount > 0) {
                console.log(`searchMemoriesByVector: 過濾 ${staleCount} 條已合併/非活躍碎片 (ChromaDB stale entries)`);
            }
            for (const f of fragments) {
                const chromaId = `fragment_${f.id}`;
                results.push({ _table: 'fragments', _similarity: idToSimilarity[chromaId] || 0, ...f });
            }
        }

        // 查 memories 表（只返回 episode + permanent，舊冥想盆歷史條目不納入）
        if (memoryIds.length > 0) {
            const placeholders = memoryIds.map(() => '?').join(',');
            const episodes = db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND layer = 'episode' AND status = 'permanent'`).all(...memoryIds);
            for (const m of episodes) {
                try { m.content = encryption.decryptForDisplay(m.content); } catch (_) {}
                try { m.title = encryption.decryptForDisplay(m.title); } catch (_) {}
                const chromaId = `memory_${m.id}`;
                results.push({ _table: 'memories', _similarity: idToSimilarity[chromaId] || 0, ...m });
            }
        }

        // 按相似度降序
        results.sort((a, b) => (b._similarity || 0) - (a._similarity || 0));

        return results;

    } catch (error) {
        console.error('searchMemoriesByVector error:', error.message);
        return [];
    }
}

// ChromaDB 陳舊條目清理：刪除 status != 'active' 但仍殘留在 ChromaDB 的碎片嵌入
async function cleanupStaleChromaEntries() {
    const db = getDb();
    // Find fragments with status != 'active' that likely still have ChromaDB entries
    const stale = db.prepare(`
        SELECT id, chroma_id FROM memory_fragments
        WHERE status != 'active' AND chroma_id IS NOT NULL
        LIMIT 50
    `).all();

    if (stale.length === 0) return { cleaned: 0 };

    let cleaned = 0;
    for (const s of stale) {
        try {
            await chromaDBOperation('delete', { id: `fragment_${s.id}` });
            db.prepare('UPDATE memory_fragments SET chroma_id = NULL WHERE id = ?').run(s.id);
            cleaned++;
        } catch (_) { /* non-fatal */ }
    }

    if (cleaned > 0) {
        console.log(`[Memory] ChromaDB 陳舊清理: ${cleaned}/${stale.length} 條`);
    }
    return { cleaned, scanned: stale.length };
}

module.exports = {
    chromaDBOperation,
    queryMultiCollections,
    searchMemoriesByHardTrigger,
    searchMemoriesByVector,
    cleanupStaleChromaEntries,
    getLocalEmbedding
};
