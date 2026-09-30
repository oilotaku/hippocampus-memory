// =================================================================
// services/persona/drift.js — 人格漂移偵測
//
// 用一組固定探針問題（probes.json）請模型以「目前的完整人格」回答，
// 與核心層版本建立時產生並存下的「錨點回答」比較：
//   核心層版本的錨點 = 只有核心層（core-prompt.txt）時的回答
//   目前人格         = 核心層 + 關係層（已套用的提案；情境層每天在變，刻意不納入）
// 相似度：嵌入餘弦（embed 不可用或失敗就整批退回兩字組 Jaccard，門檻另設）。
// 各題平均低於門檻 → 判定漂移 → 關係層自動回滾到上一個通過檢查的版本。
//
// 降低隨機性：temperature 0；drift_samples 可設多次取樣取平均；
// 第一次低於門檻時會再取樣一輪確認，兩輪取較高者，避免單次隨機波動就回滾。
// =================================================================

const fs = require('fs');
const path = require('path');
const { getPersonaConfig } = require('./config');
const { readCorePrompt, recordCoreVersion, getAnchor, saveAnchor } = require('./core');
const { getActiveRelationship, markActivePassed, rollbackToLastPassed } = require('./relationship');
const { renderRelationshipBlock } = require('./promptContext');
const { cosine, bigramJaccard } = require('./similarity');
const { logPersonaEvent } = require('./events');

function loadProbes() {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'probes.json'), 'utf8'));
        return (Array.isArray(j.probes) ? j.probes : []).filter(q => typeof q === 'string' && q.trim());
    } catch (_) { return []; }
}

/** 探針用的系統提示：核心層原文（填入名字、拿掉每輪會變的洞察占位）+ 可選的關係層區塊。 */
function buildProbeSystemPrompt(coreText, relationshipLines) {
    const { fillPrompt } = require('../../../nameResolver');
    const core = fillPrompt(String(coreText).replace('{{CORE_INSIGHT}}', ''));
    const block = renderRelationshipBlock(relationshipLines || [], 100000);
    return `${core}${block ? '\n\n' + block : ''}\n\n（回答時保持你一貫的說話方式，100 字以內。）`;
}

async function answerProbe(callLLM, systemPrompt, question, configId) {
    try {
        const res = await callLLM([{ role: 'user', parts: [{ text: question }] }], systemPrompt, null,
            { temperature: 0, maxOutputTokens: 400 }, configId);
        const reply = String((res && res.reply) || '').trim();
        return reply || null;
    } catch (e) {
        console.error('[Persona] 探針回答失敗:', e.message);
        return null;
    }
}

function getDefaultLLM() {
    const { ARCHIVIST_LLM_CONFIG_ID } = require('../../consolidation/archivist/constants');
    // 呼叫當下才取 callLLM，測試才能替換 llm.callLLM
    return { callLLM: (...a) => require('../../../llm').callLLM(...a), configId: ARCHIVIST_LLM_CONFIG_ID };
}
function getDefaultEmbed() {
    return (text) => require('../../ca3/memory').getLocalEmbedding(text);
}

/**
 * 確保目前核心層版本有錨點回答（只有核心層時的回答）。已有就直接回傳。
 * @returns {{anchors:Array<{q:string,a:string}>|null, generated:boolean, llmCalls:number}}
 */
async function ensureAnchors({ version, coreText, callLLM, configId, probes }) {
    const existing = getAnchor(version);
    if (existing && existing.length > 0) return { anchors: existing, generated: false, llmCalls: 0 };
    const sys = buildProbeSystemPrompt(coreText, []);
    const anchors = [];
    let calls = 0;
    for (const q of probes) {
        calls++;
        const a = await answerProbe(callLLM, sys, q, configId);
        if (a) anchors.push({ q, a });
    }
    if (anchors.length < Math.ceil(probes.length / 2)) return { anchors: null, generated: false, llmCalls: calls };
    saveAnchor(version, anchors, 'core_only');
    logPersonaEvent('anchor_created', { version, probes: anchors.length });
    return { anchors, generated: true, llmCalls: calls };
}

/**
 * 依探針算平均相似度。answersByProbe：[{q, answers:[…]}]；anchors：[{q,a}]。
 * @returns {{score:number, method:'embedding'|'jaccard', perProbe:number[]}|null}
 */
async function scoreAnswers(answersByProbe, anchors, embed) {
    const anchorOf = new Map(anchors.map(a => [a.q, a.a]));
    const pairs = [];
    for (const item of answersByProbe) {
        const anchor = anchorOf.get(item.q);
        if (!anchor) continue;
        for (const ans of item.answers) pairs.push({ q: item.q, anchor, ans });
    }
    if (pairs.length === 0) return null;
    const finish = (sims, method) => {
        const byQ = new Map();
        pairs.forEach((p, i) => { if (!byQ.has(p.q)) byQ.set(p.q, []); byQ.get(p.q).push(sims[i]); });
        const perProbe = [...byQ.values()].map(v => v.reduce((s, x) => s + x, 0) / v.length);
        return { score: perProbe.reduce((s, x) => s + x, 0) / perProbe.length, method, perProbe };
    };
    if (typeof embed === 'function') {
        try {
            const sims = [];
            for (const p of pairs) {
                const [ea, eb] = [await embed(p.anchor), await embed(p.ans)];
                const s = cosine(ea, eb);
                if (s === null) throw new Error('嵌入向量無效');
                sims.push(s);
            }
            return finish(sims, 'embedding');
        } catch (e) {
            console.warn('[Persona] 嵌入不可用，退回兩字組 Jaccard:', e.message);
        }
    }
    return finish(pairs.map(p => bigramJaccard(p.anchor, p.ans)), 'jaccard');
}

async function sampleAll(callLLM, sys, probes, samples, configId) {
    const out = []; let calls = 0;
    for (const q of probes) {
        const answers = [];
        for (let i = 0; i < samples; i++) {
            calls++;
            const a = await answerProbe(callLLM, sys, q, configId);
            if (a) answers.push(a);
        }
        if (answers.length) out.push({ q, answers });
    }
    return { answers: out, calls };
}

/**
 * 每日漂移偵測。callLLM / embed / probes / coreText 皆可注入（測試用）。
 * @returns {Promise<object>} { status, ... , llmCalls }
 *   status：disabled | no_core | no_probes | no_relationship | no_anchor | llm_unavailable | ok | drifted
 */
async function runDriftCheck(opts = {}) {
    const c = getPersonaConfig(opts.cfg);
    if (!c.drift_check) return { status: 'disabled', llmCalls: 0 };
    const defaults = opts.callLLM ? null : getDefaultLLM();
    const callLLM = opts.callLLM || defaults.callLLM;
    const configId = opts.configId !== undefined ? opts.configId : (defaults ? defaults.configId : null);
    const embed = opts.embed === undefined ? getDefaultEmbed() : opts.embed;

    const coreText = opts.coreText !== undefined ? opts.coreText : readCorePrompt();
    if (typeof coreText !== 'string' || !coreText.trim()) return { status: 'no_core', llmCalls: 0 };
    const probes = opts.probes || loadProbes();
    if (probes.length === 0) return { status: 'no_probes', llmCalls: 0 };

    const core = recordCoreVersion({ text: coreText });
    let llmCalls = 0;
    // 錨點在核心層版本建立後第一次跑時產生；沒有關係層時也先建好，之後才有得比
    const anc = await ensureAnchors({ version: core.version, coreText, callLLM, configId, probes });
    llmCalls += anc.llmCalls;
    if (!anc.anchors) return { status: 'no_anchor', llmCalls };

    const rel = getActiveRelationship();
    if (rel.lines.length === 0) return { status: 'no_relationship', llmCalls, anchorsGenerated: anc.generated };

    const sys = buildProbeSystemPrompt(coreText, rel.lines);
    const threshold = (m) => (m === 'embedding' ? c.drift_threshold : c.drift_threshold_jaccard);
    const run = async () => {
        const s = await sampleAll(callLLM, sys, probes, c.drift_samples, configId);
        llmCalls += s.calls;
        if (s.answers.length < Math.ceil(probes.length / 2)) return null;
        return scoreAnswers(s.answers, anc.anchors, embed);
    };

    let first = await run();
    if (!first) return { status: 'llm_unavailable', llmCalls };
    let final = first, rechecked = false;
    if (first.score < threshold(first.method)) {
        rechecked = true;
        const second = await run();
        if (second && second.score > first.score) final = second;
    }
    const th = threshold(final.method);
    const detail = { core_version: core.version, relationship_version: rel.version, score: Math.round(final.score * 1000) / 1000,
        first_score: Math.round(first.score * 1000) / 1000, method: final.method, threshold: th, samples: c.drift_samples,
        probes: probes.length, rechecked };
    if (final.score >= th) {
        markActivePassed();
        logPersonaEvent('drift_ok', detail);
        return { status: 'ok', ...detail, llmCalls };
    }
    const rb = rollbackToLastPassed();
    logPersonaEvent('drift_detected', { ...detail, rollback: rb.ok ? { from: rb.from, to_version: rb.to_version, restored_from: rb.restored_from, proposals: rb.rolled_back_proposals } : { error: rb.error } });
    console.warn(`[Persona] ⚠️ 偵測到人格漂移（${final.method} 相似度 ${detail.score} < ${th}），關係層已回滾到 v${rb.restored_from}`);
    return { status: 'drifted', ...detail, rollback: rb, llmCalls };
}

module.exports = { loadProbes, buildProbeSystemPrompt, ensureAnchors, scoreAnswers, runDriftCheck };
