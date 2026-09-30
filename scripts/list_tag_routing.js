// scripts/list_tag_routing.js
//
// 列出「可以單獨成一顆星座的那些值標」——給裝的人、或者幫著裝的 AI 看的。
//
// 用途：給一個新使用者配置時，先跑這個，看到有哪幾類可選，再問使用者要不要。
//   $ node scripts/list_tag_routing.js
//   當前已配置：親密(親密時刻)、健康(健康)
//   可選項：
//     intimacy  親密      預設名字「親密時刻」  星系：親密
//                這條碎片來自一次親密互動本身……
//     health    健康      預設名字「健康」      星系：社交
//                這條碎片講的是身體本身的客觀狀況……
//
// 配置寫在 memory_config.json 的 tag_routing：
//   "tag_routing": { "intimacy": "親密時刻", "health": "健康" }
// 不填 = 一顆都不建。

require('dotenv').config();
const { ROUTABLE_TAGS, getTagRouting } = require('../services/tagRouting');

const active = new Map(getTagRouting().map(d => [d.tag, d.name]));

console.log('\n可單獨成星座的值標（tag_routing）\n' + '─'.repeat(60));
for (const def of ROUTABLE_TAGS) {
    const on = active.get(def.tag);
    console.log(`${on ? '●' : '○'} ${def.tag.padEnd(10)} ${def.label}    預設名字「${def.defaultName}」    星系：${def.galaxy}${on ? `    ← 已啟用，叫「${on}」` : ''}`);
    console.log(`    ${def.desc}`);
    console.log(`    ⚠️ ${def.exclude}`);
    console.log('');
}
console.log('─'.repeat(60));
console.log(`當前已啟用 ${active.size} 個${active.size ? '：' + [...active.values()].join('、') : '（memory_config.json 的 tag_routing 是空的）'}`);
console.log('要在配置裡加，就把 tag 寫在 tag_routing 裡，值是你想給它的名字。');
console.log('加完需要重啟服務，並且歷史碎片要跑一次補鏈（深迴圈的 aggregateLink 任務會自動做）。\n');
