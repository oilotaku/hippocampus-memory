// =================================================================
// services/persona/core.js — 核心層（身分、價值觀、說話風格）
//
// 來源只有手寫的 core-prompt.txt，程式不會改它。這裡只做「版本紀錄」：
// 內容雜湊有變就遞增版本，留下歷史；漂移偵測的錨點回答掛在版本上。
// {{CORE_INSIGHT}}（deep cycle 產出、每輪會變）留在原文裡一起雜湊，不影響——
// 因為雜湊的是檔案原文，不是填入洞察後的結果。
// =================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../../database');
const { logPersonaEvent } = require('./events');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** 讀 core-prompt.txt：先找工作目錄（chat 的 buildSmartContext 也是讀這個），再找專案根目錄。 */
function readCorePrompt() {
    for (const p of [path.resolve(process.cwd(), 'core-prompt.txt'), path.join(REPO_ROOT, 'core-prompt.txt')]) {
        try { return fs.readFileSync(p, 'utf8'); } catch (_) { /* 換下一個 */ }
    }
    return null;
}

const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function getLatestCoreVersion() {
    return getDb().prepare('SELECT * FROM persona_core_versions ORDER BY version DESC LIMIT 1').get() || null;
}

/**
 * 記錄核心層版本。內容雜湊與最新版本相同 → 不動；不同（或還沒有任何版本）→ 版本 +1。
 * text 可注入（測試用）；沒有 core-prompt.txt 時回傳 null（不記錄）。
 * @returns {{version:number, hash:string, changed:boolean}|null}
 */
function recordCoreVersion({ text } = {}) {
    const raw = text === undefined ? readCorePrompt() : text;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const hash = hashOf(raw);
    const db = getDb();
    const latest = getLatestCoreVersion();
    if (latest && latest.content_hash === hash) return { version: latest.version, hash, changed: false };
    const version = latest ? latest.version + 1 : 1;
    db.prepare('INSERT INTO persona_core_versions (version, content_hash, char_count) VALUES (?, ?, ?)')
        .run(version, hash, raw.length);
    logPersonaEvent('core_version', { version, hash: hash.slice(0, 12), chars: raw.length, previous: latest ? latest.version : null });
    console.log(`[Persona] 核心層版本 v${version}（${latest ? '內容已變更' : '首次記錄'}，${raw.length} 字）`);
    return { version, hash, changed: true };
}

function getCoreHistory() {
    return getDb().prepare(
        'SELECT id, version, content_hash, char_count, anchor_method, (anchor_answers IS NOT NULL) AS has_anchor, created_at FROM persona_core_versions ORDER BY version DESC'
    ).all().map(r => ({ ...r, has_anchor: !!r.has_anchor }));
}

function saveAnchor(version, answers, method) {
    getDb().prepare('UPDATE persona_core_versions SET anchor_answers = ?, anchor_method = ? WHERE version = ?')
        .run(JSON.stringify(answers), method || null, version);
}

function getAnchor(version) {
    const row = getDb().prepare('SELECT anchor_answers FROM persona_core_versions WHERE version = ?').get(version);
    if (!row || !row.anchor_answers) return null;
    try { const a = JSON.parse(row.anchor_answers); return Array.isArray(a) ? a : null; } catch (_) { return null; }
}

module.exports = { readCorePrompt, recordCoreVersion, getLatestCoreVersion, getCoreHistory, saveAnchor, getAnchor, hashOf };
