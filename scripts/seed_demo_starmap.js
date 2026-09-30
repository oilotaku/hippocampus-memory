// 4D 星圖示範資料：在「指定的暫存 DB」塞數個星系、約 50 顆星、不同 created_at、幾條橋、幾顆冷卻／凍結。
// 用法：DB_PATH=<暫存 db 路徑> node scripts/seed_demo_starmap.js
// 只做示範／截圖驗證，絕不對正式資料庫執行（未設定 DB_PATH 會直接拒絕）。
require('dotenv').config();
if (!process.env.DB_PATH) { console.error('拒絕執行：請明確設定 DB_PATH 指向暫存資料庫'); process.exit(2); }
const { initDatabase, getDb } = require('../database');
const { sealField } = require('../services/memoryCrypto');

initDatabase();
const db = getDb();

const DAY = 86400000;
const now = Date.now();
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// [名稱, category, [碎片內容...]]
const ENTITIES = [
    ['小雨', 'person', ['一起去看了海邊的日落', '她說最喜歡下雨天的咖啡店', '生日那天送了她一本手帳', '深夜聊到彼此的夢想', '她推薦了一部很好看的電影', '今天她心情不太好', '約好下週一起爬山']],
    ['阿翔', 'person', ['大學時代的室友，現在在新竹工作', '一起熬夜趕過期末報告', '他結婚了，請我當伴郎', '今年夏天約了一起衝浪']],
    ['麻糬', 'pet', ['麻糬第一次學會握手', '半夜跳上床踩我的臉', '帶麻糬去打預防針，一路發抖', '麻糬最愛的零食是雞肉乾', '今天在窗邊曬太陽睡了一下午', '換了新的貓砂盆，牠不太接受']],
    ['淡水老街', 'place', ['傍晚在河邊吃阿給', '小時候常跟爸媽來這裡', '夕陽真的很漂亮', '漁人碼頭拍了很多照片']],
    ['京都', 'place', ['清水寺的楓葉紅得像火', '在鴨川邊發呆一下午', '住的町家有榻榻米的味道', '抹茶冰淇淋排了四十分鐘', '伏見稻荷的鳥居走不完', '錯過末班車，走了一小時回旅館']],
    ['台東', 'place', ['池上的稻浪一望無際', '在都蘭看海到天黑']],
    ['畢業旅行', 'event', ['全班在墾丁包了民宿', '半夜偷偷跑去沙灘', '拍了一張所有人都閉眼的合照', '回程遊覽車上大家都睡著了']],
    ['轉職面試', 'event', ['投了十幾家公司', '第一次線上面試緊張到忘詞', '拿到 offer 的那天請自己吃大餐', '決定接受新工作']],
    ['夏季馬拉松', 'event', ['報名了十公里組', '長跑訓練第三週膝蓋有點痛', '完賽了！成績比預期好']],
    ['記憶星圖專案', 'project', ['開始設計星座的資料結構', '把星圖改成 3D 立體的想法', '寫完了時間軸的原型', '修好了排版會亂跳的問題', '測試加密之後的效能']],
    ['小說《海的盡頭》', 'work', ['第一章寫了三個版本', '角色設定：一個會聽見海聲的少女', '卡在結局，想不到好的收法', '重讀初稿，發現節奏太慢']],
    ['手沖咖啡', 'hobby', ['買了第一支手沖壺', '衣索比亞豆有莓果香氣', '研磨度調粗一格之後變好喝', '認識了一間很棒的烘豆店']],
    ['爵士樂', 'hobby', ['Bill Evans 的專輯循環了一整週', '第一次去現場聽爵士', '想學鋼琴即興']],
    ['羽球', 'hobby', ['每週三固定打球', '學會了殺球的發力方式', '換了新拍子手感很不錯']],
];
const BRIDGES = [['小雨', '阿翔', 3], ['小雨', '麻糬', 3], ['京都', '淡水老街', 2], ['京都', '台東', 3], ['手沖咖啡', '爵士樂', 3], ['夏季馬拉松', '畢業旅行', 2], ['記憶星圖專案', '小說《海的盡頭》', 3], ['小雨', '京都', 3], ['小雨', '手沖咖啡', 2], ['阿翔', '畢業旅行', 4], ['麻糬', '小雨', 2], ['京都', '小說《海的盡頭》', 2], ['記憶星圖專案', '轉職面試', 2], ['夏季馬拉松', '羽球', 3], ['淡水老街', '小雨', 2], ['爵士樂', '手沖咖啡', 1]];

const insEnt = db.prepare(`INSERT INTO entity_profiles (name, category, facts, status, fragment_count, related_entities, aliases, tags, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, '[]', '[]', '[]', ?, ?)`);
const insFrag = db.prepare(`INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_date, status, created_at, read_count, last_accessed_at)
    VALUES (?, ?, ?, ?, 'chat', ?, ?, ?, ?, ?)`);
const insLink = db.prepare('INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, confidence, classified_by, relation) VALUES (?, ?, 0.8, ?, ?)');

let seed = 20260930;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const ids = {};
let total = 0;
db.transaction(() => {
    ENTITIES.forEach(([name, cat, frags], ei) => {
        const start = now - (110 - ei * 5) * DAY;
        const r = insEnt.run(name, cat, name + ' 的記憶檔案', frags.length, iso(start), iso(now));
        ids[name] = Number(r.lastInsertRowid);
        frags.forEach((text, i) => {
            const created = start + i * (2 + rnd() * 9) * DAY + rnd() * DAY;
            const age = (now - created) / DAY;
            // 舊的、沒被回憶過的變冷卻／凍結；最近的維持 active
            let status = 'active';
            if (age > 85 && rnd() < 0.75) status = 'frozen';
            else if (age > 45 && rnd() < 0.6) status = 'cooling';
            const recalled = status === 'active' && rnd() < 0.6;
            const lastAcc = recalled ? iso(now - rnd() * 6 * DAY) : (rnd() < 0.5 ? iso(created + rnd() * 5 * DAY) : null);
            const f = insFrag.run('event', name, sealField('memory_fragments', 'content', text), +(0.3 + rnd() * 0.6).toFixed(2),
                iso(created).slice(0, 10), status, iso(created), recalled ? 1 + Math.floor(rnd() * 8) : 0, lastAcc);
            insLink.run(f.lastInsertRowid, ids[name], 'seed_demo', null);
            total++;
        });
    });
    const rel = {};
    for (const [a, b, w] of BRIDGES) {
        (rel[a] = rel[a] || []).push({ id: ids[b], relation: '相關', shared_count: w });
        (rel[b] = rel[b] || []).push({ id: ids[a], relation: '相關', shared_count: w });
    }
    for (const [name, list] of Object.entries(rel)) db.prepare('UPDATE entity_profiles SET related_entities = ? WHERE id = ?').run(JSON.stringify(list), ids[name]);
})();
console.log(`[seed] 已寫入 ${ENTITIES.length} 個星座、${total} 顆星、${BRIDGES.length} 條橋 → ${process.env.DB_PATH}`);
