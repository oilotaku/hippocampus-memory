// =================================================================
// services/tagRouting.js — 「可路由的值標」的唯一定義
//
// 有些記憶值得單獨成一顆星座，而不是等著分類器去認領——比如"兩人之間的親密互動"、
// "身體上的客觀狀況"。這些走**程式碼路由**：Scribe 提取時打一個值標，程式碼在碎片
// **入庫那一刻**直接建鏈。
//
// 為什麼必須入庫即建、不能等分類管線：分類入口要求 `status='active'`，而整合
// （Consolidator）會把跑過的碎片改成 `consolidated`——兩條管線搶同一批碎片，誰先到
// 誰說了算。碎片一旦被寫成 episode 就永久退出分類，連結再也不會建立。
// 實測：consolidated 的碎片裡有一千多條沒有任何星座連結，而先被整合的恰恰是
// "一條完整的故事"。（`linkTaggedFragment` 的註釋裡有更細的賬。）
//
// ── 使用者怎麼用 ────────────────────────────────────────────────
// 在 memory_config.json 裡挑要哪幾個，值是想給這顆星座起的名字：
//
//     "tag_routing": { "intimacy": "親密時刻", "health": "健康" }
//
// 不填 = 一顆都不建（預設）。可選的標、預設名字、以及它們本來放在哪個星系，
// 見下面這張表——**這是唯一的可選項清單**，想知道"能開哪幾顆"看這裡。
//
// ── 加一個新標的步驟 ──────────────────────────────────────────
// ① 在這張表裡加一條（tag / label / desc / exclude / category / galaxy）
// ② 跑 `scripts/probes/probe_tag_routing.js` 驗證**兩個方向**：
//    該標的標了沒（別漏）、不該標的標了沒（別寬）——prompt 裡的措辭改動
//    單跑一次看不出差別，必須重複跑。
// ③ Scribe 的 value_tags 說明段是從這張表生成的，不用另外改 prompt。
// =================================================================

const ROUTABLE_TAGS = [
    {
        tag: 'intimacy',
        label: '親密',
        category: 'intimacy_aggregate',
        galaxy: '親密',
        color: '#ff7ba8',
        defaultName: '親密時刻',
        desc: '這條碎片**來自一次親密互動本身**：兩人之間的情慾交流、身體與慾望的袒露、親密過程中的對話與反應。',
        exclude: '只標"互動本身"。**不標**事後對它的復盤分析、日常的依賴表達、單純提到身體不適或健康問題（那些走各自的路）。',
    },
    {
        tag: 'health',
        label: '健康',
        category: 'health_aggregate',
        galaxy: '社交',
        color: '#ff9966',
        defaultName: '健康',
        desc: '這條碎片講的是**身體本身的客觀狀況**：症狀、診斷、就醫、用藥、體檢結果、身體勞損與皮膚問題。',
        exclude: '只標"身體本身"。**不標**情緒起伏（那是 emotional_critical 的事）、不標對身材的主觀焦慮、不標"今天吃了什麼"這類日常飲食記錄。',
    },
];

// 讀 memory_config.json 的 tag_routing，返回 [{ tag, name, category, galaxy }]。
// 只認表裡有的標——配置裡寫了表外的標會被忽略（Scribe 根本吐不出那個標，
// 路由它等於建一顆永遠不長的空星座）。
function getTagRouting() {
    let routing = {};
    try {
        routing = require('./memoryConfig').config.tag_routing || {};
    } catch (_) { return []; }
    if (typeof routing !== 'object' || Array.isArray(routing)) return [];

    const out = [];
    for (const def of ROUTABLE_TAGS) {
        const name = routing[def.tag];
        if (typeof name !== 'string' || !name.trim()) continue;
        out.push({ tag: def.tag, name: name.trim(), category: def.category, galaxy: def.galaxy, label: def.label });
    }
    return out;
}

// 給 prompt 用的說明段（Scribe 的 value_tags 那一節直接從這兒拼）。
//
// ⚠️ 只在**已經配置了**的標才寫進 prompt：沒配的標讓模型吐出來也沒地方去，
// 只會白佔注意力、還可能擠掉別的標籤的判斷。
function renderTagSpecForPrompt() {
    const active = new Set(getTagRouting().map(d => d.tag));
    const rows = ROUTABLE_TAGS.filter(def => active.has(def.tag));
    if (rows.length === 0) return '';
    return rows.map(def =>
        `- **${def.tag}** — ${def.desc}\n` +
        `  ⚠️ ${def.exclude}\n` +
        `  標了就意味著這條會**單獨進一顆星座**（系統按標直連），所以**寧可漏標不可誤標**。`
    ).join('\n');
}

module.exports = { ROUTABLE_TAGS, getTagRouting, renderTagSpecForPrompt };
