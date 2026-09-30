// 由 qwen3-8b-zh-8k 建立 16k 脈絡變體（同權重、同模板；只改 num_ctx）——只用 HTTP API，不碰 ollama CLI
(async () => {
    const r = await fetch('http://127.0.0.1:11434/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3-8b-zh-16k', from: 'qwen3-8b-zh-8k', parameters: { num_ctx: 16384 }, stream: false }) });
    console.log(r.status, await r.text());
})();
