// eval/locomo_e2e.js — LoCoMo 第二階段：單組對話完整流程（Scribe 抽取 → 記憶組裝 → 生成 → 評分）
// 用法（Windows cmd，需先設 LLM_ENDPOINT_ALLOWLIST=http://127.0.0.1:11434、LLM_REQUEST_TIMEOUT_MS=1500000）：
//   node eval/locomo_e2e.js extract <對話索引>            # 階段一：逐批 Scribe 抽取，DB 存於 %TEMP%\locomo-e2e-<id>.db
//   node eval/locomo_e2e.js qa <對話索引> <名稱> [--vector] [--limit N] [--shift]
//        # 階段二：對每題組裝記憶、生成答案、評分；--vector 加 bge-m3 向量通道；--shift 把碎片 created_at 平移到「現在」
//   node eval/locomo_e2e.js longctx <對話索引> <名稱> [--limit N]
//        # 對照組：不經記憶系統，整段對話直接放進系統提示詞作答，評分方式與 qa 相同
//   環境變數 E2E_MODEL（預設 qwen3-8b-zh-8k）
//            E2E_LLM_BASE（預設 http://127.0.0.1:11434/v1；接 eval/claude_shim.py 時設 http://127.0.0.1:18765/v1）
//            E2E_TAG（資料庫與抽取檔名的標籤，讓不同模型的抽取結果並存；預設空）
//            E2E_SCRIBE_PROMPT（legacy|v2：抽取用的 Scribe 提示詞版本）、E2E_SCRIBE_MAX_OUTPUT_TOKENS（抽取輸出上限）
//   extract 結束時把證據召回率（非無解題的證據輪次被已存記憶涵蓋的比例）寫進 e2e_<對話>_extract.json 的 recall。
//   嵌入（--vector）固定走本機 Ollama 的 bge-m3。
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODE = process.argv[2];
const IDX = parseInt(process.argv[3], 10);
const args = process.argv.slice(4);
const flag = (n) => args.includes(n);
const optv = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MODEL = process.env.E2E_MODEL || 'qwen3-8b-zh-8k';
const OLLAMA = 'http://127.0.0.1:11434';
const LLM_BASE = (process.env.E2E_LLM_BASE || OLLAMA + '/v1').replace(/\/+$/, '');
const TAG = process.env.E2E_TAG ? '_' + process.env.E2E_TAG : '';
const { loadConversations } = require('./locomo_common');
const conv = loadConversations()[IDX];
const DB = path.join(os.tmpdir(), `locomo-e2e-${conv.id}${TAG}.db`);
const OUT = path.join(__dirname, 'results');
fs.mkdirSync(OUT, { recursive: true });
process.env.DB_PATH = DB;
process.env.MEMORY_ENCRYPTION = process.env.MEMORY_ENCRYPTION || 'on';
process.env.SANCTUARY_ENCRYPTION_KEY = '0'.repeat(64);
process.env.LLM_ENDPOINT_ALLOWLIST = process.env.LLM_ENDPOINT_ALLOWLIST || [...new Set([OLLAMA, new URL(LLM_BASE).origin])].join(',');
process.env.LLM_REQUEST_TIMEOUT_MS = process.env.LLM_REQUEST_TIMEOUT_MS || '1500000';

// 把使用者／助理名稱設成兩位說話者（memory_config.json 已被 .gitignore；結束時刪除）
const CFG = path.join(__dirname, '..', 'memory_config.json');
const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'memory_config.example.json'), 'utf8'));
example.user.name = conv.speaker_a; example.ai.name = conv.speaker_b;
// E2E_RECALL_VERIFY=1：開啟 CA1 比對器（recall.verify），作答前核對問題細節與取回記憶
if (process.env.E2E_RECALL_VERIFY === '1') example.recall = { ...(example.recall || {}), verify: true };
fs.writeFileSync(CFG, JSON.stringify(example));
process.on('exit', () => { try { fs.unlinkSync(CFG); } catch (_) {} });

const llm = require('../services/llm');
// E2E_SCRIBE_PROMPT=legacy|v2：抽取用哪一版 Scribe 提示詞（未設定時依 memory_config 的 scribe.prompt，預設 v2）
const { getScribeConfig, setScribeConfigOverride } = require('../services/hippocampus/entorhinal/scribeConfig');
// E2E_SCRIBE_MAX_OUTPUT_TOKENS：抽取輸出上限（搭配轉接器 SHIM_ENFORCE_MAX_TOKENS=1 重現正式環境的截斷）
if (process.env.E2E_SCRIBE_PROMPT || process.env.E2E_SCRIBE_MAX_OUTPUT_TOKENS) {
    const o = {};
    if (process.env.E2E_SCRIBE_PROMPT) o.prompt = process.env.E2E_SCRIBE_PROMPT;
    if (process.env.E2E_SCRIBE_MAX_OUTPUT_TOKENS) o.max_output_tokens = Number(process.env.E2E_SCRIBE_MAX_OUTPUT_TOKENS);
    setScribeConfigOverride(o);
}
const memory = require('../services/memory');
memory.chromaDBOperation = async () => { throw new Error('Chroma 未啟動（評測刻意降級）'); };
const { initDatabase, getDb } = require('../database');
initDatabase();
const db = getDb();
// 評測用設定每次都重設成本次的端點與模型（同一個 DB 可能先抽取、後以別的模型作答）
db.prepare('UPDATE api_configs SET is_default = 0').run();   // 與 scripts/setup_llm.js 相同：新庫預設有 Gemini 配置，要先取消
db.prepare("DELETE FROM api_configs WHERE name = '評測 LLM'").run();
db.prepare(`INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
            VALUES ('評測 LLM', 'openai_compatible', ?, 'none', ?, 1, 1)`).run(LLM_BASE, MODEL);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── 訊息時間：session 時間 + 每輪 10 秒（讓 Scribe 緩衝區的排序穩定）──
function msgTs(t) {
    const d = new Date(t.time.replace(' ', 'T') + 'Z');
    // 同一 session 內的第幾輪
    const same = conv.turns.filter(x => x.session === t.session);
    d.setUTCSeconds(d.getUTCSeconds() + 10 * same.indexOf(t));
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

// 碎片 → 來源輪次（quote 在批次內輪次文字中逐字比對；source_msg_ids 涵蓋緩衝區＋批次）。extract 與 qa 共用。
function mapFragments(idToDia) {
    const turnByDia = new Map(conv.turns.map(t => [t.dia_id, t]));
    const nz = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const frags = db.prepare('SELECT id, entity, content, quote, source_msg_ids, source_date FROM memory_fragments WHERE status = ?').all('active');
    const fragDia = new Map(); const covered = new Set(); let unmapped = 0;
    for (const f of frags) {
        let ids = []; try { ids = JSON.parse(f.source_msg_ids || '[]'); } catch (_) {}
        const q = nz(f.quote);
        const hit = q ? ids.map(i => idToDia[i]).filter(d => d && nz(turnByDia.get(d).text).includes(q)) : [];
        if (!hit.length) unmapped++;
        fragDia.set(f.id, hit);
        hit.forEach(d => covered.add(d));
    }
    return { frags, fragDia, covered, unmapped };
}

// 證據召回率（不需跑問答）：非無解題的證據輪次，有多少被至少一條已存記憶的 quote 涵蓋。
// turn＝證據輪次層級；question_any＝至少一個證據輪次被涵蓋的題目比例；question_all＝全部證據都被涵蓋的題目比例。
function evidenceRecall(covered) {
    const qs = conv.qa.filter(q => q.category !== 5 && q.evidence && q.evidence.length);
    const ev = new Set(qs.flatMap(q => q.evidence));
    const hitEv = [...ev].filter(d => covered.has(d)).length;
    return {
        questions: qs.length, evidence_turns: ev.size, evidence_turns_covered: hitEv,
        turn: ev.size ? hitEv / ev.size : null,
        question_any: qs.length ? qs.filter(q => q.evidence.some(e => covered.has(e))).length / qs.length : null,
        question_all: qs.length ? qs.filter(q => q.evidence.every(e => covered.has(e))).length / qs.length : null,
    };
}

async function extract() {
    const realCall = llm.callLLM; const calls = [];
    llm.callLLM = async (...a) => { if (process.env.E2E_DUMP) { fs.writeFileSync(path.join(OUT, 'scribe_prompt_dump.json'), JSON.stringify({ msgs: a[0], system: a[1], gen: a[3] })); log('已傾印第一個 Scribe 請求'); process.exit(0); } const t0 = Date.now(); try { const r = await realCall(...a); calls.push({ ms: Date.now() - t0, reply: r.reply, usage: r.usage }); return r; } catch (e) { calls.push({ ms: Date.now() - t0, error: e.message }); throw e; } };

    const { runScribe } = require('../services/hippocampus/entorhinal/scribe');   // 必須在包裝 callLLM 之後才 require（scribe 載入時就解構 callLLM）
    if (db.prepare('SELECT COUNT(*) c FROM messages').get().c > 0) throw new Error('DB 已有訊息；請刪除 ' + DB + ' 後重跑');
    const chatId = Number(db.prepare("INSERT INTO chats (name) VALUES ('locomo')").run().lastInsertRowid);
    const insMsg = db.prepare(`INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted, message_type) VALUES (?, ?, ?, ?, 0, 'text')`);
    const msgs = conv.turns.map(t => {
        const ts = msgTs(t);
        const id = Number(insMsg.run(chatId, t.speaker === conv.speaker_a ? 'user' : 'ai', t.text, ts).lastInsertRowid);
        return { id, sender: t.speaker === conv.speaker_a ? 'user' : 'ai', content: t.text, timestamp: ts, message_type: 'text', is_encrypted: 0, dia_id: t.dia_id };
    });
    const idToDia = Object.fromEntries(msgs.map(m => [m.id, m.dia_id]));
    const BATCH = parseInt(process.env.E2E_BATCH || '60', 10);   // 預設 60＝產品 SCRIBE_CONFIG.MAX_BATCH
    const batches = [];
    let since = '2000-01-01';
    const T0 = Date.now();
    for (let i = 0; i < msgs.length; i += BATCH) {
        const batch = msgs.slice(i, i + BATCH);
        const before = db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c;
        const nCalls = calls.length; const t0 = Date.now();
        let r = null, err = null;
        try { r = await runScribe(batch, since); } catch (e) { err = e.message; }
        const ms = Date.now() - t0;
        const after = db.prepare('SELECT COUNT(*) c FROM memory_fragments').get().c;
        let proposed = null;
        try { proposed = JSON.parse((calls[calls.length - 1]?.reply || '').replace(/```json|```/g, '').trim()).entries?.length ?? null; } catch (_) {}
        const rec = { batch: batches.length + 1, first: batch[0].dia_id, last: batch[batch.length - 1].dia_id, msgs: batch.length, ms,
            llm_calls: calls.length - nCalls, proposed, written: r?.written ?? 0,
            ok: r ? r.ok !== false : false, truncated: !!r?.truncated, split: !!r?.split, added_rows: after - before, duplicates: r?.duplicates ?? 0,
            quoteDropped: r?.quoteDropped ?? 0, quoteDroppedByType: r?.quoteDroppedByType || {},
            aiChitchatDropped: r?.aiChitchatDropped ?? 0, aiChitchatDroppedByType: r?.aiChitchatDroppedByType || {}, error: err,
            prompt_tokens: calls[calls.length - 1]?.usage ?? null };
        batches.push(rec);
        log(`批次 ${rec.batch}/${Math.ceil(msgs.length / BATCH)}  ${(ms / 1000).toFixed(0)}s  提出 ${proposed}  寫入 ${rec.written}  quote丟 ${rec.quoteDropped}  閒聊丟 ${rec.aiChitchatDropped} ${err ? 'ERR ' + err : ''}`);
        since = batch[batch.length - 1].timestamp;
        fs.writeFileSync(path.join(OUT, `e2e_${conv.id}${TAG}_extract.json`), JSON.stringify({ conv: conv.id, batches, total_ms: Date.now() - T0, idToDia }, null, 1));
    }
    const m = mapFragments(idToDia);
    const recall = evidenceRecall(m.covered);
    log(`碎片 ${m.frags.length} 條；涵蓋輪次 ${m.covered.size}/${conv.turns.length}；證據召回 ${(recall.turn * 100).toFixed(1)}%（題目任一證據 ${(recall.question_any * 100).toFixed(1)}%）`);
    fs.writeFileSync(path.join(OUT, `e2e_${conv.id}${TAG}_extract.json`), JSON.stringify({ conv: conv.id, scribe_prompt: getScribeConfig().prompt, batches, total_ms: Date.now() - T0, idToDia,
        n_frags: m.frags.length, covered: [...m.covered], unmapped: m.unmapped, recall, done: true }, null, 1));
    log('抽取完成', ((Date.now() - T0) / 60000).toFixed(1), '分鐘');
}

// ── 評分工具 ──
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
// 中文沒有空白分詞，F1 以單字為單位；英文照 LoCoMo 慣例以詞為單位
const norm = (s) => { const t = String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '); return CJK.test(t) ? [...t.replace(/\s+/g, '')] : t.replace(/\b(a|an|the)\b/g, ' ').split(/\s+/).filter(Boolean); };
function f1(pred, gold) {
    const p = norm(pred), g = norm(gold);
    if (!p.length || !g.length) return p.length === g.length ? 1 : 0;
    const cnt = new Map(); g.forEach(t => cnt.set(t, (cnt.get(t) || 0) + 1));
    let same = 0; p.forEach(t => { if ((cnt.get(t) || 0) > 0) { same++; cnt.set(t, cnt.get(t) - 1); } });
    if (!same) return 0;
    const pr = same / p.length, rc = same / g.length; return 2 * pr * rc / (pr + rc);
}
const REFUSAL = /未提及|沒有提到|沒提到|無法確定|無法得知|不知道|不清楚|not mentioned|not specified|no information|not stated|not provided|don't know|do not know|unknown|cannot be determined|not available|isn't mentioned|is not mentioned/i;
const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

const sysAns = (question, source = 'memory notes') => CJK.test(question)
    ? `你根據提供的${source === 'memory notes' ? '記憶筆記' : '對話紀錄'}回答關於對話中人物的問題，只能使用其中的內容。用繁體中文簡短作答（最多 30 字），不要解釋。若其中沒有答案，只回答：未提及`
    : `You answer questions about a person's conversations using ONLY the ${source} provided. Reply with a short answer (at most 15 words), in English, no explanation. If the ${source} do not contain the answer, reply exactly: Not mentioned`;
const SYS_JUDGE_ALL = 'You are a strict but fair grader. Given a question, a gold answer and a model answer, reply with exactly one word: CORRECT if the model answer is semantically equivalent to the gold answer (different date formats or wording of the same fact count as CORRECT; extra harmless detail is fine; a missing or wrong key fact is WRONG), otherwise WRONG.';

// 作答／評分可以固定走另一個端點（E2E_ANSWER_BASE/MODEL、E2E_JUDGE_BASE/MODEL），
// 比較不同抽取模型時只讓「抽取」這一個變因不同。未設定時沿用產品 LLM 設定（callLLM）。
const ROLE = {
    answer: { base: process.env.E2E_ANSWER_BASE, model: process.env.E2E_ANSWER_MODEL || MODEL },
    judge: { base: process.env.E2E_JUDGE_BASE || process.env.E2E_ANSWER_BASE, model: process.env.E2E_JUDGE_MODEL || process.env.E2E_ANSWER_MODEL || MODEL },
};
async function ask(system, user, maxTok, role = 'answer') {
    const cfg = ROLE[role];
    if (cfg.base) {
        const r = await fetch(cfg.base.replace(/\/+$/, '') + '/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: cfg.model, temperature: 0, max_tokens: maxTok, stream: false,
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
            signal: AbortSignal.timeout(900000),
        });
        if (!r.ok) throw new Error(`${role} 端點 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        return stripThink((await r.json()).choices?.[0]?.message?.content);
    }
    const r = await llm.callLLM([{ role: 'user', parts: [{ text: user }] }], system, null, { temperature: 0, maxOutputTokens: maxTok });
    return stripThink(r.reply);
}

// 對照組：整段對話直接放進系統提示詞（不經記憶系統），評分方式與 qa() 相同
async function longctx() {
    const name = optv('--name', args[0] && !args[0].startsWith('--') ? args[0] : 'longctx');
    const limit = parseInt(optv('--limit', '0'), 10);
    const zh = CJK.test(conv.qa[0]?.question || '');
    const transcript = conv.turns.map(t => `[${t.dia_id} ${t.time}] ${t.speaker}: ${t.text}`).join('\n');
    const system = sysAns(conv.qa[0]?.question || '', 'conversation transcript') + (zh ? '\n\n以下是完整對話紀錄：\n' : '\n\nFull conversation transcript:\n') + transcript;
    const results = []; const T0 = Date.now();
    const outFile = path.join(OUT, `e2e_${conv.id}${TAG}_${name}.json`);
    const qas = limit ? conv.qa.slice(0, limit) : conv.qa;
    for (const q of qas) {
        const rec = { qi: q.qi, cat: q.category, question: q.question, gold: q.category === 5 ? null : q.answer, adversarial: q.adversarial, evidence: q.evidence };
        try {
            const t0 = Date.now();
            rec.answer = await ask(system, `Question: ${q.question}\nShort answer:`, 100);
            rec.gen_ms = Date.now() - t0;
            await scoreInto(rec, q);
        } catch (e) { rec.error = e.message; rec.judge = 'ERROR'; rec.f1 = 0; }
        results.push(rec);
        if (results.length % 5 === 0 || results.length === qas.length) {
            fs.writeFileSync(outFile, JSON.stringify({ conv: conv.id, name, mode: 'longctx', transcript_chars: transcript.length, results, ms: Date.now() - T0 }, null, 1));
            log(`長上下文 ${results.length}/${qas.length}  正確 ${results.filter(r => r.judge === 'CORRECT').length}`);
        }
    }
}

async function scoreInto(rec, q) {
    const refused = REFUSAL.test(rec.answer);
    if (q.category === 5) {
        rec.f1 = refused ? 1 : 0; rec.judge = refused ? 'CORRECT' : 'WRONG'; rec.judge_method = 'refusal-rule';
    } else {
        rec.f1 = f1(rec.answer, q.answer);
        const j = await ask(SYS_JUDGE_ALL, `Question: ${q.question}\nGold answer: ${q.answer}\nModel answer: ${rec.answer}\nVerdict:`, 10, 'judge');
        rec.judge = /^\W*CORRECT/i.test(j) ? 'CORRECT' : 'WRONG'; rec.judge_method = 'llm';
    }
}

async function qa() {
    const name = optv('--name', args[0] && !args[0].startsWith('--') ? args[0] : 'run');
    const limit = parseInt(optv('--limit', '0'), 10);
    const { buildGatedMemory, resetPipelineState } = require('../services/hippocampus/ca3/recallPipeline');
    const ext = JSON.parse(fs.readFileSync(path.join(OUT, `e2e_${conv.id}${TAG}_extract.json`), 'utf8'));
    const idToDia = ext.idToDia;
    const turnByDia = new Map(conv.turns.map(t => [t.dia_id, t]));

    const { frags, fragDia, covered, unmapped } = mapFragments(idToDia);
    log(`碎片 ${frags.length} 條；涵蓋輪次 ${covered.size}/${conv.turns.length}；無法對應來源輪次 ${unmapped}`);

    if (flag('--shift')) {   // 碎片 created_at 平移到「現在」（最後一個 session ≈ 昨天）
        const ts = conv.turns.map(t => Date.parse(t.time.replace(' ', 'T') + 'Z'));
        const sh = Date.now() - 86400000 - Math.max(...ts);
        const up = db.prepare('UPDATE memory_fragments SET created_at = ? WHERE id = ?');
        for (const f of frags) {
            const ds = fragDia.get(f.id); const t = ds.length ? turnByDia.get(ds[0]) : null;
            if (t) up.run(new Date(Date.parse(t.time.replace(' ', 'T') + 'Z') + sh).toISOString().slice(0, 19).replace('T', ' '), f.id);
        }
    }

    if (flag('--vector')) {   // 碎片以 bge-m3 嵌入，替身取代 searchMemoriesByVector
        const texts = frags.map(f => `${f.entity}: ${f.content}`);
        const embs = [];
        for (let i = 0; i < texts.length; i += 32) {
            const r = await fetch(OLLAMA + '/api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'bge-m3', input: texts.slice(i, i + 32) }) });
            embs.push(...(await r.json()).embeddings);
        }
        const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map(x => x / n); };
        const E = embs.map(unit);
        memory.searchMemoriesByVector = async (query, n) => {
            const r = await fetch(OLLAMA + '/api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'bge-m3', input: [query] }) });
            const q = unit((await r.json()).embeddings[0]);
            const sims = E.map((v, i) => [v.reduce((s, x, k) => s + x * q[k], 0), i]).filter(x => x[0] >= 0.20).sort((a, b) => b[0] - a[0]).slice(0, n);
            if (!sims.length) return [];
            const rows = db.prepare(`SELECT * FROM memory_fragments WHERE id IN (${sims.map(() => '?').join(',')}) AND status = 'active'`).all(...sims.map(x => frags[x[1]].id));
            const by = new Map(rows.map(r => [r.id, r]));
            return sims.map(([s, i]) => ({ _table: 'fragments', _similarity: s, ...by.get(frags[i].id) })).filter(x => x.id);
        };
        log('已啟用 bge-m3 向量通道');
    }


    const results = [];
    const outFile = path.join(OUT, `e2e_${conv.id}${TAG}_${name}.json`);
    const qas = limit ? conv.qa.slice(0, limit) : conv.qa;
    const T0 = Date.now();
    for (const q of qas) {
        const rec = { qi: q.qi, cat: q.category, question: q.question, gold: q.category === 5 ? null : q.answer, adversarial: q.adversarial, evidence: q.evidence };
        try {
            resetPipelineState();   // 每題獨立：清掉「話題延續」狀態
            let t0 = Date.now();
            const g = await buildGatedMemory(q.question, {});
            rec.recall_ms = Date.now() - t0;
            rec.retrieve = g.decision?.retrieve; rec.gate_reason = g.decision?.reason;
            rec.check = g.check ? { verdict: g.check.verdict, mismatches: g.check.mismatches, ms: g.check.ms } : null;
            rec.injected_ids = g.injected.filter(x => x.source_table === 'fragment').map(x => x.id);
            const dias = new Set(rec.injected_ids.flatMap(id => fragDia.get(id) || []));
            rec.retrieved_dia = [...dias];
            const memText = g.parts.join('\n');
            rec.memory_chars = memText.length;
            rec.memory = memText.slice(0, 6000);
            t0 = Date.now();
            rec.answer = await ask(sysAns(q.question), `${memText || '(no memory retrieved)'}\n\nQuestion: ${q.question}\nShort answer:`, 100);
            rec.gen_ms = Date.now() - t0;
            await scoreInto(rec, q);
            const ev = q.evidence;
            rec.ev_extracted = ev.length ? ev.every(e => covered.has(e)) : null;
            rec.ev_extracted_any = ev.length ? ev.some(e => covered.has(e)) : null;
            rec.ev_retrieved_any = ev.length ? ev.some(e => dias.has(e)) : null;
        } catch (e) { rec.error = e.message; rec.judge = 'ERROR'; rec.f1 = 0; }
        results.push(rec);
        if (results.length % 5 === 0 || results.length === qas.length) {
            fs.writeFileSync(outFile, JSON.stringify({ conv: conv.id, name, options: args, covered: [...covered], n_frags: frags.length, unmapped, results, ms: Date.now() - T0 }, null, 1));
            log(`QA ${results.length}/${qas.length}  正確 ${results.filter(r => r.judge === 'CORRECT').length}`);
        }
    }
    log('QA 完成', ((Date.now() - T0) / 60000).toFixed(1), '分鐘');
}

(MODE === 'extract' ? extract() : MODE === 'qa' ? qa() : MODE === 'longctx' ? longctx() : Promise.reject(new Error('mode: extract|qa|longctx')))
    .then(() => process.exit(0)).catch(e => { console.error('失敗:', e); process.exit(1); });
