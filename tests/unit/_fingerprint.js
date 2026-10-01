// W7 拆分安全網共用工具：把「一段情境跑完之後的可觀察結果」（回傳值、LLM 呼叫、
// console 輸出、資料庫終態）正規化成可比對的 JSON 指紋。
//
// 用途：services/archivist.js、services/cognitiveModel.js 拆成目錄模組（純搬移）前後，
// 同一段情境的指紋必須完全相同。指紋檔放在 tests/unit/fixtures/，
// 以 `set W7_RECORD=1&& node --test tests/unit/<檔名>` 重新錄製（只在確定行為本來就該變時才做）。
//
// 正規化只抹掉「與程式碼位置或執行當下時間有關」的部分：
//   - 日期時間字串 → <T>／<D>、時分 → <HM>、「N月N日」→ <MD>
//   - 浮點數四捨五入到小數兩位（衰減類計算與經過秒數有關）
//   - console 內的 stack trace 行（含檔案路徑與行號）刪掉
//   - `Cannot find module '<相對路徑>'` 只留最後一段（拆分後相對路徑寫法不同、指向同一檔案）
//   - console 訊息內的數字 → N（耗時、閒置分鐘數等）
// 檔名以 _ 開頭且不含 .test.，node --test 不會把它當測試檔。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');

const RE_DATETIME = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g;
const RE_DATE = /\d{4}-\d{2}-\d{2}/g;
const RE_MD = /\d{1,2}月\d{1,2}日/g;

function normStr(s) {
    return s
        .replace(/Cannot find module '([^']*)'/g, (_, p) => `Cannot find module '${p.split('/').pop()}'`)
        .replace(RE_DATETIME, '<T>')
        .replace(RE_DATE, '<D>')
        .replace(/\b\d{2}-\d{2} \d{2}:\d{2}\b/g, '<T>')
        // archivist/relations.js 的證據行用 source_date.slice(5) 寫成「[MM-DD]」；播種日期相對於今天，
        // 不正規化的話指紋只在錄製當天成立（2026-10-01 起每天失敗）
        .replace(/\[\d{2}-\d{2}\]/g, '[<MD>]')
        .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<HM>')
        .replace(RE_MD, '<MD>');
}

function normValue(v) {
    if (v === null || v === undefined) return v === undefined ? '<undefined>' : null;
    if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 100) / 100;
    if (typeof v === 'string') return normStr(v);
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'function') return '<function>';
    if (Array.isArray(v)) return v.map(normValue);
    if (v instanceof Error) return { error: normLog(v.message) };
    if (typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = normValue(v[k]);
        return o;
    }
    return String(v);
}

function normLog(s) {
    return normStr(String(s))
        .split('\n')
        .filter(l => !/^\s+at /.test(l) && !/^Require stack:/.test(l) && !/^- .*\.js$/.test(l))
        .join('\n')
        .replace(/\d+(\.\d+)?/g, 'N');
}

function hash(s) {
    return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

// 攔下 console 輸出（改存進陣列），回傳還原函式
function captureConsole(logs) {
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const fmt = (a) => a.map(x => (x && x.stack) ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    console.log = (...a) => logs.push('L ' + normLog(fmt(a)));
    console.info = (...a) => logs.push('I ' + normLog(fmt(a)));
    console.warn = (...a) => logs.push('W ' + normLog(fmt(a)));
    console.error = (...a) => logs.push('E ' + normLog(fmt(a)));
    return () => Object.assign(console, orig);
}

// LLM 呼叫紀錄：每筆只留 config id、prompt 雜湊與開頭預覽（prompt 內日期已正規化）
function llmRecord(args) {
    const [messages, system, , genCfg, cfgId] = args;
    const text = normStr(JSON.stringify(messages) + '\n' + String(system || ''));
    return { cfg: cfgId ?? null, gen: normValue(genCfg || {}), h: hash(text), head: normStr(JSON.stringify(messages)).slice(0, 60) };
}

function dumpTables(db, tables) {
    const out = {};
    for (const t of tables) {
        try {
            out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(normValue);
        } catch (e) {
            out[t] = { error: e.message };
        }
    }
    return out;
}

// 比對或錄製指紋
function checkFingerprint(name, actual) {
    const file = path.join(__dirname, 'fixtures', name + '.json');
    const json = JSON.stringify(actual, null, 1);
    if (process.env.W7_RECORD === '1') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, json + '\n');
        return;
    }
    const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 分段比對，失敗訊息比較好讀
    for (const k of Object.keys(expected)) {
        assert.deepEqual(JSON.parse(JSON.stringify(actual[k] ?? null)), expected[k], `指紋段落「${k}」不一致`);
    }
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), '指紋段落清單不一致');
}

module.exports = { normStr, normValue, normLog, captureConsole, llmRecord, dumpTables, checkFingerprint, hash };
