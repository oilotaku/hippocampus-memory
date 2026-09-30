// 診斷：以 Scribe 第一批的實際請求測 Ollama 速度（串流，量首 token 延遲與生成速率）
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(__dirname + '/results/scribe_prompt_dump.json', 'utf8'));
(async () => {
    const body = { model: 'qwen3-8b-zh-8k', stream: true, temperature: 0.3, max_tokens: Number(process.env.MAXTOK || 1500),
        messages: [{ role: 'system', content: d.system }, { role: 'user', content: d.msgs[0].parts[0].text }], stream_options: { include_usage: true } };
    const t0 = Date.now(); let first = 0, n = 0, usage = null, text = '';
    const r = await fetch('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) { if (!l.startsWith('data: ') || l.includes('[DONE]')) continue; const j = JSON.parse(l.slice(6));
            if (j.usage) usage = j.usage; const c = j.choices?.[0]?.delta?.content; if (c) { if (!first) first = Date.now() - t0; n++; text += c; } }
    }
    const tot = Date.now() - t0;
    console.log(JSON.stringify({ first_token_s: first / 1000, total_s: tot / 1000, chunks: n, gen_tok_per_s: n / ((tot - first) / 1000), usage }));
    console.log(text.slice(0, 600));
})();
