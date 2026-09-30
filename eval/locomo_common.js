// eval/locomo_common.js — LoCoMo 資料載入與共用工具（評測用，不含產品邏輯）
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data', 'locomo', 'locomo10.json');
const MON = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

// "1:56 pm on 8 May, 2023" → "2023-05-08 13:56:00"（視為 UTC，DB 的無時區時間即 UTC）
function parseSessionTime(s) {
    const m = /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i.exec(s || '');
    if (!m) return null;
    let h = parseInt(m[1], 10) % 12; if (m[3].toLowerCase() === 'pm') h += 12;
    const mo = MON[m[5].toLowerCase()];
    const p = (n) => String(n).padStart(2, '0');
    return `${m[6]}-${p(mo)}-${p(parseInt(m[4], 10))} ${p(h)}:${m[2]}:00`;
}

function loadConversations() {
    const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    return raw.map((c, idx) => {
        const conv = c.conversation;
        const sessions = Object.keys(conv).filter(k => /^session_\d+$/.test(k))
            .map(k => parseInt(k.slice(8), 10)).sort((a, b) => a - b);
        const turns = [];
        for (const n of sessions) {
            const time = parseSessionTime(conv[`session_${n}_date_time`]);
            const arr = conv[`session_${n}`] || [];
            arr.forEach((t, i) => {
                let text = t.text || '';
                if (t.blip_caption) text += ` (shared an image: ${t.blip_caption})`;
                turns.push({ dia_id: t.dia_id, speaker: t.speaker, text, session: n, time, seq: turns.length,
                    content: `${t.speaker}: ${text}` });
            });
        }
        const diaSet = new Set(turns.map(t => t.dia_id));
        const qa = c.qa.map((q, qi) => {
            const ev = [...new Set([...(q.evidence || []).join(' ').matchAll(/D:?(\d+):(\d+)/g)].map(m => `D${m[1]}:${m[2]}`))];
            return { qi, question: q.question, answer: q.answer == null ? null : String(q.answer),
                adversarial: q.adversarial_answer || null, category: q.category,
                evidence: ev.filter(e => diaSet.has(e)), evidence_missing: ev.filter(e => !diaSet.has(e)) };
        });
        return { idx, id: c.sample_id, speaker_a: conv.speaker_a, speaker_b: conv.speaker_b, turns, qa };
    });
}

function sqlTime(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }
// 把整組時間軸平移，使最後一個 session 落在「現在」之前 1 天（保留相對間隔）
function shiftTimes(turns) {
    const ts = turns.map(t => Date.parse(t.time.replace(' ', 'T') + 'Z'));
    const shift = Date.now() - 86400000 - Math.max(...ts);
    turns.forEach((t, i) => { t.time_shifted = sqlTime(new Date(ts[i] + shift)); });
}

module.exports = { loadConversations, parseSessionTime, shiftTimes };
