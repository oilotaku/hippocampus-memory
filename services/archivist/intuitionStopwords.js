// =================================================================
// services/archivist/intuitionStopwords.js — 直覺觸發詞去高頻（intuition_stopwords）
// 自 services/archivist.js 拆出（W7 純搬移：只剪貼、補 require/exports，程式本體未改）。
// =================================================================

const { getDb } = require('../../database');


// ═══════════════════════════════════════════════════════
// v4.8: refreshIntuitionStopwords — 直觉触发词去高频
//
// 统计近30天 User 消息的 top-N 高频词（2-4字滑窗），存
// user_settings.intuition_stopwords。intuition 匹配时跳过
// 这些词——否则「代码/界面/开源」这类日常词让直觉永远全量激活。
// 纯 SQL + 字符统计，零 LLM。
// ═══════════════════════════════════════════════════════

async function refreshIntuitionStopwords() {
    const db = getDb();
    const { encryption } = require('../../encryption');

    const messages = db.prepare(`
        SELECT content FROM messages
        WHERE sender = 'user' AND timestamp > datetime('now', '-30 days')
          AND content IS NOT NULL AND content != ''
        LIMIT 3000
    `).all();
    if (messages.length < 100) return { stopwords: 0 };

    // 词频统计：2-4 字滑窗（CJK）+ 英文单词
    const freq = new Map();
    const msgSeen = new Map(); // 词 → 出现过的消息数（防止单条刷屏制造高频）
    let parsed = 0;
    for (let mi = 0; mi < messages.length; mi++) {
        let text = messages[mi].content || '';
        if (text.startsWith('enc:')) {
            try { text = encryption.decrypt(text, { silent: true }); } catch (_) { continue; }
            if (text === null) continue;
        }
        try { const j = JSON.parse(text); text = (j.components || []).filter(c => c.type === 'text').map(c => c.content || c.text || '').join(' '); } catch (_) {}
        if (!text || text.length < 4) continue;
        parsed++;
        const seenInMsg = new Set();
        const cjk = text.match(/[一-鿿]{2,}/g) || [];
        for (const chunk of cjk) {
            for (const len of [2, 3]) {
                for (let i = 0; i + len <= chunk.length; i++) {
                    const w = chunk.slice(i, i + len);
                    seenInMsg.add(w);
                }
            }
        }
        const eng = text.toLowerCase().match(/[a-z]{3,12}/g) || [];
        for (const w of eng) seenInMsg.add(w);
        for (const w of seenInMsg) {
            freq.set(w, (freq.get(w) || 0) + 1);
            msgSeen.set(w, (msgSeen.get(w) || 0) + 1);
        }
    }

    // 高频判定：出现在 ≥3% 的消息中（按消息数去重，刷屏免疫）。
    // 实测 2900 条样本：8% 只抓到「什么」；「代码/界面」这类日常词在 3-6% 区间。
    const threshold = Math.max(10, Math.floor(parsed * 0.03));
    const stopwords = [...msgSeen.entries()]
        .filter(([w, c]) => c >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 120)
        .map(([w]) => w);

    try {
        const { setUserSetting } = require('../../utils/settings');
        setUserSetting('intuition_stopwords', JSON.stringify(stopwords));
        console.log(`[Archivist] 直觉停用词更新: ${stopwords.length} 个（样本${parsed}条消息，阈值${threshold}）— 前10: ${stopwords.slice(0, 10).join(',')}`);
    } catch (e) {
        console.error('[Archivist] 停用词写入失败:', e.message);
    }
    return { stopwords: stopwords.length };
}

module.exports = {
    refreshIntuitionStopwords,
};
