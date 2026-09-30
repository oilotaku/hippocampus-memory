// =================================================================
// Memory Constellations — 記憶管線冒煙測試
// 驗證：碎片寫入 → 向量化 → FTS5 → 檢索 → 衰減
// 用法: node tests/smoke_memory.js
// =================================================================

require('dotenv').config();
const { initDatabase } = require('../database');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (e) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`    ${e.message}`);
        failed++;
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (e) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`    ${e.message}`);
        failed++;
    }
}

async function main() {
    console.log('🧪 Memory Constellations — 記憶管線冒煙測試\n');

    initDatabase();
    const { getDb } = require('../database');
    const db = getDb();

    // ── 1. 記憶表存在 ──
    console.log('── 1. 資料庫 ──');
    const tables = ['memory_fragments', 'memory_fragments_fts', 'memories', 'memories_fts',
                    'entity_profiles', 'fragment_entities', 'entity_timeline',
                    'user_model', 'memory_sagas', 'ontology_changelog'];
    for (const t of tables) {
        test(`表 ${t}`, () => {
            const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
            if (!r) throw new Error('缺失');
        });
    }

    // ── 2. 碎片 CRUD ──
    console.log('\n── 2. 碎片 ──');
    let fragId = null;
    test('寫入碎片', () => {
        // W3：比照產品寫入點經 sealField（MEMORY_ENCRYPTION=on 時存密文）
        const { sealField } = require('../services/memoryCrypto');
        const r = db.prepare(`INSERT INTO memory_fragments
            (type, entity, content, emotional_weight, source, source_date, status, created_at)
            VALUES ('event', 'Test', ?, 0.6, 'chat', '2026-01-01', 'active', datetime('now'))`)
            .run(sealField('memory_fragments', 'content', '冒煙測試碎片——驗證記憶管線。'));
        fragId = r.lastInsertRowid;
        if (!fragId) throw new Error('寫入失敗');
    });
    test('FTS5 索引同步', () => {
        // 索引側是 splitCJK 展開的兩字組形態，查整串「冒煙測試」永遠查不到。
        // 這裡必須按 librarian 的方式查：切成兩字組再 OR。
        // W3：MEMORY_ENCRYPTION=on 時內容欄是盲索引（HMAC token），查詢也要經 fragmentsMatchQuery 轉成盲 token。
        const { toQueryTokens } = require('../utils/cjkTokenize');
        const matchStr = require('../services/memoryCrypto').fragmentsMatchQuery(toQueryTokens('冒煙測試'));
        const r = db.prepare('SELECT COUNT(*) c FROM memory_fragments_fts WHERE memory_fragments_fts MATCH ?').get(matchStr);
        if (r.c === 0) throw new Error('FTS5 未索引（兩字組檢索無命中）');
    });
    test('清理測試碎片', () => {
        db.prepare('DELETE FROM memory_fragments WHERE id = ?').run(fragId);
    });

    // ── 3. 實體星系 ──
    console.log('\n── 3. 實體星系 ──');
    // entity_profiles 不在建表時播種——實體是管線（Scribe / Entity Resolver）跑出來的。
    // 所以這裡自己造兩個，驗證「能寫」以及「碎片↔實體 能掛上」，而不是斷言存在預置資料。
    let coreEntityId = null;
    let starFragId = null;
    test('entity_profiles 可寫入核心實體', () => {
        const { USER, AI } = require('../services/memoryConfig');
        const ins = db.prepare("INSERT OR IGNORE INTO entity_profiles (name, category, aliases, tags) VALUES (?, 'person', '[]', '[]')");
        ins.run(USER.name);
        ins.run(AI.name);
        const u = db.prepare('SELECT id FROM entity_profiles WHERE name = ?').get(USER.name);
        if (!u) throw new Error('核心實體寫入失敗');
        coreEntityId = u.id;
    });
    test('fragment_entities 可寫入', () => {
        // entity_id 必須用真實存在的 id——寫死數字會被外部索引鍵拒掉
        const f = db.prepare(`INSERT INTO memory_fragments
            (type, entity, content, source, source_date, status)
            VALUES ('event', 'Test', '星系關聯冒煙碎片', 'chat', '2026-01-01', 'active')`).run();
        starFragId = f.lastInsertRowid;
        db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by) VALUES (?, ?, 0.60, ?)')
            .run(starFragId, coreEntityId, 'smoke_test');
        const n = db.prepare('SELECT COUNT(*) c FROM fragment_entities WHERE fragment_id = ?').get(starFragId).c;
        if (n === 0) throw new Error('碎片↔實體關聯未寫入');
    });
    test('清理星系測試資料', () => {
        if (starFragId) {
            db.prepare('DELETE FROM fragment_entities WHERE fragment_id = ?').run(starFragId);
            db.prepare('DELETE FROM memory_fragments WHERE id = ?').run(starFragId);
        }
    });

    // ── 4. User Model ──
    console.log('\n── 4. User Model ──');
    test('processModelDecay 不拋異常', () => {
        const { processModelDecay } = require('../services/cognitiveModel');
        const r = processModelDecay();
        if (!r || typeof r.resolved !== 'number') throw new Error('返回異常');
    });
    test('resolveExpiredStates 不拋異常', () => {
        const { resolveExpiredStates } = require('../services/cognitiveModel');
        const r = resolveExpiredStates();
        if (typeof r !== 'number') throw new Error('返回異常');
    });

    // ── 5. 配置 ──
    console.log('\n── 5. 配置 ──');
    test('memory_config.json 可讀', () => {
        const { USER, AI, config } = require('../services/memoryConfig');
        if (!USER.name || !AI.name) throw new Error('USER/AI 缺失');
    });
    test('source_routing 配置載入', () => {
        // 新克隆的倉庫只有 memory_config.example.json（真配置在 .gitignore 裡），
        // memoryConfig 會自動回退到 example——所以這裡也照同樣的回退來查。
        let raw;
        try {
            raw = require('../memory_config.json');
        } catch (_) {
            raw = require('../memory_config.example.json');
        }
        if (!raw.source_routing || typeof raw.source_routing !== 'object') throw new Error('source_routing 缺失或格式錯誤');
    });

    // ── 6. 工具登錄檔 ──
    // 只加載 + 校驗宣告，不執行 handler（handler 會寫庫）。
    // 這一層此前完全沒有覆蓋：工具檔案裡一個 require 解析不到，
    // 冒煙測試照樣全綠，而線上每一次工具呼叫都會崩。
    console.log('\n── 6. 工具登錄檔 ──');
    await asyncTest('載入 services/tools/index.js', async () => {
        const tools = require('../services/tools/index.js');
        const { getUserSetting } = require('../utils/settings');
        const { functionDeclarations } = await tools.getEnabledTools({ getUserSetting });

        if (!functionDeclarations.length) throw new Error('沒有任何啟用的工具');

        for (const d of functionDeclarations) {
            if (!d.name) throw new Error('工具缺 name');
            if (!d.description) throw new Error(`${d.name} 缺 description`);
            if (!d.parameters) throw new Error(`${d.name} 缺 parameters`);
        }
        console.log(`      已註冊: ${functionDeclarations.map(d => d.name).join(', ')}`);
    });

    await asyncTest('每個工具都暴露了可呼叫的 handler', () => {
        // 直接 require 工具模組，逐個校驗形狀——不真調 handler（會寫庫）
        const toolList = [
            ...require('../services/tools/memoryTools'),
            require('../services/tools/manageUserState'),
        ];
        if (!toolList.length) throw new Error('工具清單為空');
        for (const t of toolList) {
            if (!t.name) throw new Error('工具缺 name');
            if (typeof t.getFunctionDeclaration !== 'function') throw new Error(`${t.name} 缺 getFunctionDeclaration`);
            if (typeof t.handler !== 'function') throw new Error(`${t.name} 缺 handler`);
        }
        console.log(`      已註冊: ${toolList.map(t => t.name).join(', ')}`);
    });

    // ── 7. ChromaDB ──
    console.log('\n── 7. ChromaDB ──');
    await asyncTest('ChromaDB heartbeat', async () => {
        const { chromaDBOperation } = require('../services/memory');
        const r = await chromaDBOperation('heartbeat');
        if (!r) throw new Error('ChromaDB 無響應');
    });

    // ── 結果 ──
    console.log(`\n══════════════════`);
    console.log(`通過: ${passed}  失敗: ${failed}`);
    if (failed === 0) {
        console.log('🎉 記憶管線就緒！');
    } else {
        console.log('⚠️  有測試失敗。');
        process.exit(1);
    }
    process.exit(0);
}

main().catch(e => {
    console.error('💥 測試中斷:', e.message);
    process.exit(1);
});
