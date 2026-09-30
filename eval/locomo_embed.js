// eval/locomo_embed.js — 以 Ollama bge-m3 批次嵌入所有輪次與題目，快取到 eval/cache/（變體 C／E 使用）
// 用法：node eval/locomo_embed.js
const fs = require('fs');
const path = require('path');
const { loadConversations } = require('./locomo_common');
const URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434') + '/api/embed';
const DIR = path.join(__dirname, 'cache');
fs.mkdirSync(DIR, { recursive: true });

async function embed(texts) {
    const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'bge-m3', input: texts }) });
    if (!r.ok) throw new Error('embed HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return (await r.json()).embeddings;
}
async function embedAll(texts, tag) {
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
        out.push(...await embed(texts.slice(i, i + 32)));
        if ((i / 32) % 5 === 0) console.log(`${tag} ${Math.min(i + 32, texts.length)}/${texts.length}`);
    }
    return out;
}
(async () => {
    const convs = loadConversations();
    for (const c of convs) {
        const f = path.join(DIR, `emb_${c.id}.json`);
        if (fs.existsSync(f)) { console.log('略過（已有快取）', c.id); continue; }
        const t0 = Date.now();
        const turns = await embedAll(c.turns.map(t => t.content), c.id + ' turns');
        const qs = await embedAll(c.qa.map(q => q.question), c.id + ' qa');
        // 以 Float32 的 base64 儲存，避免 JSON 過大
        const enc = (arr) => arr.map(v => Buffer.from(new Float32Array(v).buffer).toString('base64'));
        fs.writeFileSync(f, JSON.stringify({ turns: enc(turns), qa: enc(qs) }));
        console.log(`完成 ${c.id}，${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    console.log('ALL DONE');
})().catch(e => { console.error(e); process.exit(1); });
