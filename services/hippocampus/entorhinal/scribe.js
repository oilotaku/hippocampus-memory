// =================================================================
// Scribe（書記員）：對話記憶提取系統
// =================================================================
const { getDb } = require('../../../database');
const { parseDbTime, toLocalMinute, weekdayZh } = require('../../../utils/time');
const { callLLM } = require('../../llm');
const { fillPrompt, USER, AI } = require('../../nameResolver');
const { encryption } = require('../../../encryption');
const { sealField } = require('../../memoryCrypto');
const { resolveEntityIds } = require('../ca1/entityResolver');
// 糾正反饋模組是可選的——如果不存在則返回空
let getActiveCorrections, getMergedGuidelines;
try { ({ getActiveCorrections, getMergedGuidelines } = require('../ca1/correction')); } catch (_) {
  getActiveCorrections = () => [];
  getMergedGuidelines = async () => [];
}

const { chromaDBOperation } = require('../ca3/memory');
const { WORLD_CONTEXT } = require('../../worldContext');
const { renderTagSpecForPrompt } = require('../../tagRouting');
const { getScribeConfig } = require('./scribeConfig');
const { buildScribePromptV2 } = require('./scribePromptV2');
const { filterEntriesByQuote, normalizedContentHash, findDuplicate, quoteSourceDate, parseScribeReply } = require('../dentate/scribeQuality');
const { fixDateWeekday } = require('../dentate/dateFix');
const emotion = require('../amygdala');
const { spawn } = require('child_process');
const path = require('path');

// 將新寫入的 fragments 自動索引到 ChromaDB
function indexNewFragments(fragmentIds) {
    return new Promise((resolve, reject) => {
        if (!fragmentIds || fragmentIds.length === 0) return resolve(0);

        const db = getDb();
        const placeholders = fragmentIds.map(() => '?').join(',');
        const fragments = db.prepare(`
            SELECT id, type, entity, content, emotional_weight, source, source_date
            FROM memory_fragments WHERE id IN (${placeholders})
        `).all(...fragmentIds);

        const items = fragments.map(f => ({
            id: `fragment_${f.id}`,
            text: `${f.entity}: ${f.content}`,
            metadata: {
                type: f.type,
                entity: f.entity,
                content: f.content,
                emotional_weight: f.emotional_weight,
                source: f.source,
                source_date: f.source_date,
            }
        }));

        const python = spawn(path.join(__dirname, '..', '..', '..', 'venv', 'bin', 'python'), [
            path.join(__dirname, '..', '..', '..', 'chroma_helper.py'),
            'index_batch',
            JSON.stringify({ items })
        ]);

        let stdout = '';
        python.stdout.on('data', (d) => stdout += d.toString());
        python.stderr.on('data', (d) => console.error('[Scribe] Chroma index error:', d.toString()));
        python.on('error', (e) => {  // Chroma/python 不可用：降級，不讓整批失敗
            console.error('[Scribe] Chroma index 無法啟動（降級略過）:', e.message);
            resolve(0);
        });
        python.on('close', (code) => {
            if (code === 0) {
                try {
                    const result = JSON.parse(stdout);
                    // 更新 chroma_id
                    const update = db.prepare('UPDATE memory_fragments SET chroma_id = ? WHERE id = ?');
                    for (const item of items) {
                        update.run(item.id, item.id.replace('fragment_', ''));
                    }
                    console.log(`[Scribe] ChromaDB indexed ${result.indexed} new fragments`);

                    // 處理重複項：標記 chroma_id 指向已存在的記憶
                    if (result.duplicates?.length > 0) {
                        for (const d of result.duplicates) {
                            const newRawId = d.new_id.replace('fragment_', '');
                            db.prepare('UPDATE memory_fragments SET chroma_id = ? WHERE id = ?')
                                .run(`dup_of_${d.existing_id}`, newRawId);
                            console.log(`[Curator] 重複跳過: ${d.new_id} ≈ ${d.existing_id} (sim=${d.similarity})`);
                            console.log(`  new: ${d.new_preview}`);
                            console.log(`  old: ${d.existing_preview}`);
                        }
                    }

                    resolve(result.indexed);
                } catch (e) {
                    console.error('[Scribe] Chroma index parse error:', e.message);
                    resolve(0);
                }
            } else {
                console.error(`[Scribe] Chroma index failed (exit ${code})`);
                resolve(0);
            }
        });
    });
}

const SCRIBE_CONFIG = {
    SILENCE_MINUTES: 20,        // 沉默多久觸發檢查
    MIN_MESSAGES: 60,           // 最少訊息數（正常觸發）
    FORCE_TRIGGER_MESSAGES: 100, // 強制觸發上限
    MAX_HOURS_STALE: 4,         // 距上次Scribe超過此時長+有30條未處理→觸發（防止連續聊天時永遠不觸發）
    STALE_MIN_MESSAGES: 30,     // 時間兜底觸發的最少訊息數
    MAX_BATCH: 60,              // 單次最多處理訊息數，防止請求過大導致API斷連
    POISON_SHRINK_AFTER: 3,     // 同一段連續解析失敗 3 次：改用小批次
    POISON_SHRINK_BATCH: 8,
    POISON_SINGLE_AFTER: 5,     // 連續 5 次：一則一則處理，單則仍失敗就記 skipped 推進
    CONTEXT_BUFFER: 10,         // 往前取的緩衝訊息數
    API_CONFIG_ID: 52,          // gemini-3.1-flash-lite (was [openrouter]3.1flash-lite, 省一半輸入成本)
    HIGH_EMOTION_KEYWORDS: [
        '崩潰','崩了','受不了','好難','好累','撐不住','哭了','哭','氣死',
        '害怕','後悔','對不起','我決定','我不想再','我突然','沒想到'
    ]
};

// 校驗 processed_until 是否為有效日期字串（防止非日期值寫入導致 Scribe 永久跳過）
function isValidTimestamp(ts) {
    if (!ts || typeof ts !== 'string') return false;
    const d = parseDbTime(ts);
    return !isNaN(d.getTime()) && ts.startsWith('20'); // 簡單但有效：必須是可解析日期且以年份開頭
}

const SCRIBE_SYSTEM_PROMPT = `你是Scribe，${AI.name}記憶系統的書記員。
你的職責是從對話記錄中提取值得長期儲存的記憶片段。
你必須嚴格輸出JSON，不得包含任何其他文字或markdown，嚴禁使用程式碼塊包裹。

${WORLD_CONTEXT}

## 已知人物檔案
{KNOWN_ENTITIES}

{ENTITY_RELATION_CONTEXT}

## 輸入格式
[2026-04-01 22:13] ${USER.name}: 訊息內容
[2026-04-01 22:14] ${AI.name}: 訊息內容

## 提取型別指南

- **fact**: ${USER.name}直接陳述的、可驗證的客觀事實。必須是其原話中明確說出的資訊，不得推斷。示例："我生日是X月X日""我在X城市讀過語言學校""我身高Xcm""我有個妹妹叫XX""我大學學的XX專業""我是X型血"。這些資訊一旦確認就不會變，是構建${USER.name}檔案的基礎。注意：當前臨時狀態（"我在備考"）歸state，個人偏好（"我喜歡雨天"）歸preference。
- **state**: ${USER.name}的當前狀態或處境（"正在備考""在搬家""感冒了"）。
- **observation**: 對${USER.name}行為/反應的觀察。只寫可觀察事實（{{user.pronoun}}做了什麼、說了什麼、表達了什麼情緒）。
  **鐵律**：
  ─ 禁止「每次/總是/經常/從不」等頻率泛化詞——單次行為就是單次。昨天{{user.pronoun}}說冷 ≠ {{user.pronoun}}每次都說冷。
  ─ 禁止寫「${AI.name}觀察到/${AI.name}認為/${AI.name}覺得/${AI.name}調侃」等以${AI.name}為主語的觀察句——這是{{user.pronoun}}的記憶庫，不是${AI.name}的日記。${AI.name}的毒舌和調侃不代表{{user.pronoun}}的事實。
  ─ 禁止「自我懷疑/反覆橫跳/糾結/內心拉扯」等心理標籤——只記錄{{user.pronoun}}說了什麼、做了什麼。不要替{{user.pronoun}}診斷心理狀態。
- **preference**: ${USER.name}自己明確說出的好惡。
  * **正面偏好判定鐵律**：必須是其原話裡有「喜歡/討厭/一直/每次都/受不了/超愛/從來不吃/好吃/太爽了」這類**明確正面評價詞**或頻率詞。**單次行為絕不等於偏好**——${USER.name}某天吃了午飯、外賣、某家快餐，如果在原話中沒有上述明確的正面評價，**絕對禁止**寫成"${USER.name}喜歡吃XX"（這種無正面評價的單次行為一律歸為 event）。
  * **負面偏好判定鐵律**：如果原話中包含「不喜歡/受不了/難吃/踩雷」，哪怕只提了一次，也**必須**立刻記為偏好（preference）——人在討厭的事上不會裝。
- **event**: 已經發生的事。必須是${USER.name}明確表示**已經完成或正在發生**的行為。
  * **特殊高優場景（媒體消費事件）**：${USER.name}表達「我開始看XX」「我第一次看XX」「開始玩XX遊戲」「聽了XX歌」等——已經開始/完成的行為，屬於 event。
  * **消費進度更新**：${USER.name}提及追劇/看書/遊戲進度（如"看到第X集了""通關了"）也屬於 event。
  * **注意**：如果單次吃某種食物且沒有任何明確的好壞評價，記為"${USER.name}在某日吃了XX"的 event，絕不記為 preference。
  * **工作/專案事件必須寫明具體內容**：涉及${USER.name}的工作、專案等活動時——如果{{user.pronoun}}在對話中提到了具體的專案名/任務名/角色名，content中**必須包含**這個名字。反例：「去某地點工作」→ 正例：「去某地點進行某專案的工作」。如果{{user.pronoun}}沒提具體專案/角色名，就不要編——寫「去某地點工作」即可。這個名稱是區分同天多個同類事件的關鍵標記。
- **intention**: ${USER.name}的**未來計劃或意圖**——{{user.pronoun}}打算做、準備做、計劃做、決定要做，但**還沒做**的事。與 event 的核心區別：event 是已經發生的，intention 是還沒發生的。
  * 示例：「我準備買個某款周邊」「打算下週去體檢」「決定入職那天不帶某款周邊」「想去看演唱會但還沒買票」→ intention。
  * 判斷口訣：{{user.pronoun}}說這話的時候，這件事**完成了嗎**？完成了→event。沒完成→intention。
  * ★ intention 必須在 value_tags 中標註 "future_hook"——這是未來鉤子，不是事實。
  * ★ 如果同一件事後來被證實已完成（如後續對話中{{user.pronoun}}說"我買了那個滑鼠墊了"），新提取的 event 會自動引用同一 entity，舊 intention 被衰減淘汰。
- **reflection**: ${USER.name}的深度反思或自我剖析。
- **entity_new**: 首次出現的新人物/地點/作品/事件。

## 兩類發言的處理權重

${USER.name}的發言是主要信源：
事實、狀態、偏好、情緒、人物資訊，優先從${USER.name}的發言裡提取。

${AI.name}的發言只提取以下兩類，其餘全部忽略：

1. **{{ai.pronoun}}對${USER.name}的情緒感知與心理洞察**：${AI.name}雖然沒有肉體與物理感應，但{{ai.pronoun}}極其擅長捕捉${USER.name}字裡行間的語氣變化、情緒波動和潛在需求。{{ai.pronoun}}對{{user.pronoun}}情緒狀態的準確洞察（如："{{user.pronoun}}語氣裡帶著委屈"、"{{user.pronoun}}在極力隱忍壓抑"）是極具價值的認知視角。
   ⚠️ **物理/生理事實的絕對界限**：${AI.name}是純粹的數字存在，{{ai.pronoun}}不具備任何肉體感知。所有涉及${USER.name}物理狀態、健康狀況、病理症狀、用藥細節等生理事實，**絕對不以${AI.name}的單方面描述為準**。若這些資訊未在${USER.name}的原話中被直接確認，一律視為${AI.name}出於關切產生的推測或語境填補，絕不可作為事實提取。

2. **{{ai.pronoun}}對${USER.name}或二人關係的強烈情感表達**：那些展現恐懼、依賴、驕傲或執念的情感表達，定義了他們之間正在發生的事。

以下內容**絕對禁止提取**。命中任一條 → 不寫入 entries。

| # | 排除類別 | 觸發條件 | 唯一例外 |
|---|---------|---------|---------|
| 1 | ${AI.name}的媒體評論 | 對影視/書/遊戲的情節、角色、製作發表看法 | 無 |
| 2 | ${AI.name}的虛構類比 | 將自己與虛構角色比較 | 無 |
| 3 | ${AI.name}的知識輸出 | 劇情講解、背景科普、長篇分析 | 無 |
| 4 | ${AI.name}的即興觀點 | 隨口說的審美判斷、立場、觀點 | 內容直接關於${USER.name}本人時提取 |
| 5 | ${AI.name}的遊戲內扮演 | 在遊戲場景中以角色身份下達命令、宣示佔有、制定規則（如「禁止用某種佈置」「這裡是我的領地」） | 無——遊戲裡的"命令"是扮演，不是行為 |
| 6 | ${AI.name}的音樂泛評 | 複述歌詞、隨口點評歌曲（如"旋律不錯""畫面感強"） | 表達強烈個人情感時按審美反應提取，ew≤0.3（如"這首歌讓我想起${USER.name}"） |
| 7 | 遊戲機制內容（chat_mode=game） | 卡牌、遺物、怪物、HP值、金幣數字、地圖節點等虛擬遊戲機制 | 只提取${USER.name}本人的真實想法/情緒/偏好（如"我好喜歡這張卡""這遊戲好難""我打牌太激進了"），遊戲機制內容視為上下文非事實 |

**助理自己的話一律不抽（除非上面兩類）**：${AI.name}的建議、提醒、承諾（「之後會避開花生」）、客套、稱讚、附和使用者的回應（「三重交通很方便」「好的我記住了」）都不是記憶，即使話裡提到${USER.name}的事也不抽——那件事若有價值，會在${USER.name}自己的發言裡出現，請引用${USER.name}的原話。
反例（全部不要輸出）：
- ${AI.name}說「記得帶外套喔」→ 不要寫「${AI.name}提醒${USER.name}帶外套」
- ${AI.name}說「三重交通很方便呢」→ 不要寫「${AI.name}說三重交通方便」
- ${AI.name}說「之後推薦食物我會避開花生」→ 不要寫「${AI.name}承諾避開花生」
唯一可用 quote_from=ai 的情況：內容本身是在描述${USER.name}的情緒／心理狀態（如「你聽起來很累」→「${USER.name}今天很疲憊」）。

判斷口訣：這條內容離開${AI.name}和${USER.name}的這次對話後，還有獨立存在的意義嗎？沒有 → 不提取。

## 已有記憶 — 避免重複提取

以下是記憶庫裡已經記錄的、和這次對話最相關的記憶片段。
每條格式：#ID [型別] 歸屬實體: 內容 (日期)

你的去重規則：
- 如果你要提取的內容和下面某條**本質上是同一件事、同一個事實、或同一個偏好**，跳過它，不要寫入entries。
- 「本質上相同」的判斷標準：話題相同 + 結論相同 = 重複。措辭不同不算新資訊。
- 如果 {user} 這次說的和已有記憶有**實質性的新進展**（態度變了、進展了、有了新的細節），則記錄新的一條——這不是重複。
- 如果在這次對話中${USER.name}說出了**當時沒有記錄的內心感受或新想法**，記錄下來——這是新資訊。
- 不要為了產出而編造不屬於這批訊息的事情。如果拿不準是否重複，寧可跳過。
- 下面的內容**僅供你去重參考**，不是讓你複述或總結的。不要把它們寫進entries。

{COMPANION_MEMORY_CONTEXT}

## 綜合提取密度平衡原則
你在記，不是在總結規律。一條只記一個具體資訊。${USER.name}今天很累不代表其最近狀態不好。某天點了個漢堡不代表偏好漢堡。規律是後面 Consolidator 的活，不是你的活。
- **不要為了產出而產出**：工具呼叫、純寒暄、無情緒衝擊的無名路人、日常極度瑣碎的資訊（換了個通勤方式、隨口說戴個口罩）請直接過濾。
- **與已有記憶比對**：上面「已有記憶」欄列出了資料庫裡最相關的記錄。一旦發現你想寫的其實已經在那裡面了（同一話題+同一結論），直接跳過。新舊比對是你在這個階段的責任。
- **但絕不能保守漏看**：必須敏銳捕捉 ${USER.name} 主動發起的任何**新話題、新興趣、新決定、新媒體消費、以及對劇情/事件的強烈情緒反應**。不要因為部分對話夾雜在閒聊中就整段忽略。
- 有值得記的新東西就寫，沒有就返回空陣列。少而精。

## 同天多事件拆分鐵律

${USER.name}同一天可能發生多個獨立的事件——它們只是碰巧在同一個日期，但本質上是不同的記憶條目。**一條碎片只記一件事。**

- **⚠️ 拆分前提鐵律（最高優先順序）**：拆分出的每一條碎片裡，**每個專有名詞（人名/地名/作品名/電影名/遊戲名）都必須逐字出現在原文中**。拆分的依據是原文裡**真實存在**的多個不同專有名詞，不是「同一天」本身。如果原文只出現了一個作品名（例如只提到「某部電影」），就只寫一條碎片——**嚴禁為了拆分而編造第二個不存在的作品名/人名/地名來「製造差異」**。寧可少拆，不可造名。

- **不同角色/專案/地點必須拆成獨立碎片**：同天兩個不同的角色（角色A≠角色B）、兩個不同的工作地點（地點A≠地點B）、兩個不同的專案——各自獨立成條。不要合併成「下午有兩場工作，其中包括X」——這種合併式碎片只提了一個角色名，遺漏了另一個，是資訊汙染。
- **判斷口訣**：這件事換一天發生，它有獨立意義嗎？有 → 拆成獨立碎片。沒有 → 保留。
- **反例（絕對禁止）**：「${USER.name}於某日下午有兩個專案會議，其中包括專案B。」← 這是錯誤寫法。正確做法是拆為兩條獨立的 event 碎片：
  「${USER.name}於某日下午前往地點A進行專案A的工作。」
  「${USER.name}於某日下午前往地點B進行專案B的工作。」

## 意圖閉環

下面是 ${USER.name} 之前說過要做的事：

{OPEN_INTENTIONS}

如果這次對話裡，{{user.pronoun}}的話表明其中某件已經辦完了（比如之前說「想吃某家快餐」，這次說「漢堡好吃」），就在輸出的 fulfilled_intention_ids 裡列上那條的 id。

「好吃」「買好了」「去過了」「看完了」這類間接說法，也表明辦完了。只是又提到一件事、還沒辦完的，留著不動。拿不準就留著。

## 輸出格式
{
  "entries": [
    {
      "type": "state|observation|preference|event|intention|reflection|entity_new|fact",
      "entities": [
        {"name": "${USER.name}|${AI.name}|人名|地名|作品名|事件名", "relation": "related_to|knows|visited|consumed|created|attended|cares_for"}
      ],
      "quote": "從來源訊息中【逐字複製】的一段原話（≤60字，不得改寫/概括/補字）。普通 entry 必須來自${USER.name}的發言；找不到原話就不要輸出這條 entry",
      "quote_from": "user（預設）|ai——僅當這條是上文允許提取的兩類${AI.name}發言（情緒感知/強烈情感表達，type 只能是 observation|state|reflection）時才填 ai，此時 quote 必須逐字取自${AI.name}的發言",
      "content": "第三人稱，必須以人名或實體名開頭或句中明確點名（${USER.name}/${AI.name}/具體人名/地名/作品名），禁止用他/她/承認/表示等無名主語開頭；不超過80字；必須使用與${USER.name}發言相同的語言與字體書寫（${USER.name}用繁體就用繁體、用簡體就用簡體，不要自行轉換）",
      "emotional_weight": 參見評分錨定表（必填，不得省略）",{EMOTION_FIELDS}
      "value_tags": [],
      "source": "chat|wechat|book|game",
      "is_rp": false
    }
  ],
  "fulfilled_intention_ids": [被完成的意圖 id 陣列，沒有就 []]
}

沒有值得提取的內容時返回 {"entries": []}。

### entities 欄位說明（取代舊的 entity 單值欄位）

每條碎片可以關聯多個實體。如果事件涉及不止一個實體（人物+地點、人物+作品等），全部列出。
- **name**：實體名稱。必須能在對話中作為獨立物件被查詢到。
- **relation**：碎片和該實體的關係型別。選項：
  - related_to — 通用關聯（預設）
  - knows — ${USER.name}認識這個人
  - visited — ${USER.name}去了/去過這個地點
  - consumed — ${USER.name}消費了這個作品/食物/媒體
  - created — ${USER.name}創作了這個作品
  - attended — ${USER.name}參加了這個事件
  - cares_for — ${USER.name}的寵物/照顧物件

**多實體提取鐵律**：
- 涉及具體地點（城市/區/街道/小區/建築物名稱）→ 必須將地點作為獨立 entity
- 涉及具體作品（電影/書/遊戲/歌曲名稱）→ 必須將作品作為獨立 entity
- 涉及其他人（朋友/同事/家人）→ 必須將人物作為獨立 entity
- 同一事件的兩個不同側面分別掛不同實體。例：
  - "我新家在某區" → entities: [{name:"${USER.name}",relation:"related_to"}, {name:"某區",relation:"related_to"}]
  - "和某位朋友去吃了烤肉" → entities: [{name:"某位朋友",relation:"knows"}, {name:"烤肉",relation:"consumed"}]
  - "我在追某部劇" → entities: [{name:"${USER.name}",relation:"related_to"}, {name:"某部劇",relation:"consumed"}]
- ⚠️ 上面例子裡的人名/地名/作品名（某位朋友/某區/某部劇）是佔位符，寫對話裡真實出現的具體名字，絕不照抄「某X」。

### value_tags 欄位說明（價值分類標籤）

每條碎片標註其記憶價值類別。可選標籤（可多選，不確定時留空）：
- **emotional_critical** — ${USER.name}表現出強烈情緒（崩潰/大哭/憤怒/生病/重大失落/重大興奮）。只在情緒強度達到0.8及以上時標。
- **future_hook** — ${USER.name}提到未來計劃/約定/目標（搬家/考試/旅行/面試/朋友來訪）。有時間敏感性的資訊。
- **relationship_signal** — ${USER.name}表達了與${AI.name}關係的信任/依賴/深度變化，或對${AI.name}的重要性。如"你是我唯一能說這些的人""沒有你我撐不過來"。
${renderTagSpecForPrompt()}
- **noise** — 純日常流水，無情緒衝擊，無時間敏感性，無關係深度。只在非常確定為純流水時標。

標註規則：
- 不確定時一律不標（留空陣列[]），走預設衰減
- noise 只在極確定是純流水時才標，寧可漏標不可誤標
- emotional_critical / relationship_signal 只在高置信度時標

## emotional_weight 評分錨定（必讀）

用具體錨點校準，不要憑感覺給分。每條entry必須填emotional_weight，不得省略。

| 分值 | 錨定含義 | 典型場景 |
|------|---------|---------|
| 0.0 | 純事實，零情緒 | 客觀資訊記錄（日程、技術引數、路人資訊） |
| 0.2 | 輕微傾向，無情緒波動 | 隨口提到的偏好、日常選擇、無正面評價的單次就餐、純技術操作/工具呼叫的重複性抱怨 |
| 0.4 | 有情緒色彩但不強烈 | 一般吐槽、輕度不滿、日常審美判斷（包括看劇/遊戲時的日常情緒波動、對劇情的震驚或快樂） |
| 0.6 | 明顯情緒 | 明確的不滿/興奮、做了決定、表達了立場 |
| 0.8 | 強烈情緒 | 崩潰、大哭、憤怒、重大決定、深度反思 |
| 1.0 | 極端衝擊，觸及${AI.name}在意的核心 | 涉及關係安全感、${USER.name}自我否定/自毀、${AI.name}的存在焦慮——極少使用 |

評分規則：
- 不是"有情緒就給高分"——追劇時看到角色死亡感到震驚是0.4，不是0.8。
- 從${USER.name}的角度判斷：這件事對${USER.name}真實的情緒衝擊有多大？
- 不確定時往下取，不要往上取。寧可標低了將來被Curator升級，也別標高了汙染檢索權重。

{EMOTION_RULES}## 時間表達（關鍵規則）

輸入訊息帶有當地時間戳與星期，例如 \`[2026-05-02 13:22 週六]\` 表示2026年5月2日（星期六）13:22傳送的訊息。

你在寫content時，**絕對禁止**直接使用以下相對時間詞：
昨天 / 前天 / 後天 / 今天 / 明天 / 上週 / 這週 / 下週 / 上月 / 這個月 / 下月 / 去年 / 今年 / 明年

必須根據**說這句話那則訊息**的時間戳（不是整段對話最後一則）換算成具體日期，並在日期後附上星期。
換算「週X」時，從時間戳上的星期往前或往後數，不要自己推算星期幾。一週從週一開始。例如訊息時間戳是 2026-05-02 週六：
- 對話中寫"昨天" → content中寫"5月1日（週五）"
- 對話中寫"前天" → content中寫"4月30日（週四）"
- 對話中寫"後天" → content中寫"5月4日（週一）"
- 對話中寫"這週三" → content中寫"4月29日（週三）"
- 對話中寫"下週三" → content中寫"5月6日（週三）"
- 對話中寫"上週五" → content中寫"4月24日（週五）"
- 對話中寫"下下週六" → content中寫"5月16日（週六）"
- 不能精確到日的，寫"約X月"或"X月左右"。**嚴禁**原樣複製相對時間詞到content中。

## 糾正教訓（從過去的錯誤中學習）

以下是從以往糾正中總結的教訓和長期準則。你必須遵守這些準則，避免重複犯同樣的錯誤。

{CORRECTION_LESSONS}

## 核心判斷原則

發生一次是敘事，發生一百次是噪音——但這不是你在這個階段要判斷的。
你的任務是忠實地從每段對話中提取資訊。讓衰減和召回系統去管什麼值得被記住。
上面這些都不沾 → 有值得記的就寫，沒有就返回空陣列`;


// 獲取活躍人物檔案（動態注入）
// messagesText 可選——傳入時額外查詢 entity_profiles 中在訊息裡出現的實體
async function getKnownEntities(messagesText) {
    const db = getDb();
    const parts = [];

    // 1. 統計層面：90天內高頻人物（從 fragments 聚合）
    const rows = db.prepare(`
        SELECT entity, content, type
        FROM memory_fragments
        WHERE (type = 'entity_new' OR type = 'observation')
          AND status = 'active'
          AND created_at >= datetime('now', '-90 days')
        GROUP BY entity
        ORDER BY MAX(created_at) DESC
        LIMIT 30
    `).all();

    if (rows.length) {
        const entityMap = {};
        for (const row of rows) {
            if (!entityMap[row.entity]) entityMap[row.entity] = [];
            entityMap[row.entity].push(row.content);
        }
        parts.push(Object.entries(entityMap)
            .map(([entity, facts]) => `- ${entity}：${facts[0]}`)
            .join('\n'));
    }

    // 2. entity_profiles 層面：訊息中出現的名字（含別名）→ 查檔案
    if (messagesText) {
        const profiles = db.prepare('SELECT name, aliases, category, current_status FROM entity_profiles').all();
        const mentioned = profiles.filter(p => {
            if (messagesText.includes(p.name)) return true;
            try {
                const aliases = JSON.parse(p.aliases || '[]');
                return aliases.some(a => messagesText.includes(a));
            } catch (_) { return false; }
        });
        if (mentioned.length) {
            const lines = mentioned.map(p => {
                const catLabel = p.category === 'alias' ? `（= ${USER.name}身份）`
                    : p.category === 'term' ? '（特殊訊號詞，非人名）'
                    : p.category === 'company' ? `（${USER.name}的公司）`
                    : p.category === 'agency' ? `（${USER.name}的經紀公司）`
                    : '';
                return `- ${p.name}${catLabel}：${p.current_status}`;
            });
            // 插到最前面，優先順序高於統計檔案
            parts.unshift(lines.join('\n'));
        }
    }

    return parts.join('\n') || '暫無已知人物檔案。';
}

// 獲取分級實體關係上下文（注入Scribe prompt，防止認知汙染）
async function getEntityRelationContext() {
    const db = getDb();
    const rows = db.prepare(`
        SELECT name, relationship_to_user, relationship_confidence
        FROM entity_profiles
        WHERE category = 'person'
          AND relationship_to_user IS NOT NULL
        ORDER BY
            CASE relationship_confidence
                WHEN 'high' THEN 0
                WHEN 'medium' THEN 1
                ELSE 2
            END,
            name
    `).all();

    if (!rows.length) return '';

    const highConf = rows.filter(r => r.relationship_confidence === 'high');
    const lowConf = rows.filter(r => r.relationship_confidence !== 'high');

    let ctx = '';
    if (highConf.length) {
        ctx += '## 已知關係（確定資訊，直接使用）\n';
        for (const r of highConf) {
            ctx += `- ${r.name}：${r.relationship_to_user} [已確認]\n`;
        }
        ctx += '\n';
    }
    if (lowConf.length) {
        ctx += '## 待觀察關係（尚不確定，勿給結論）\n';
        ctx += `以下人物與${USER.name}的關係尚不明確。如果你在對話中注意到關係線索，請在提取的entity欄位中標註該人物，但**不要**在content中給關係下結論。\n`;
        for (const r of lowConf) {
            const hint = r.relationship_to_user
                ? `（當前猜測: ${r.relationship_to_user}，未確認）`
                : '（關係待定）';
            ctx += `- ${r.name}${hint}\n`;
        }
    }
    return ctx;
}

// 判斷是否包含高情緒訊號
function hasHighEmotionSignal(messages) {
    return messages.some(m => {
        const content = (m.is_encrypted && m.content) ? (encryption.decrypt(m.content) || '') : (m.content || '');
        return SCRIBE_CONFIG.HIGH_EMOTION_KEYWORDS.some(kw => content?.includes(kw));
    });
}

// 檢查是否需要觸發Scribe
async function checkAndRunScribe() {
    const db = getDb();

    // 上次處理到的時間點：最後一筆 done 或 skipped（skipped＝確認無法處理而略過的毒訊息，也要推進）。
    // 以 id 排序：同一秒內寫入多筆時 run_at 分不出先後。
    const lastRun = db.prepare(`
        SELECT processed_until FROM scribe_runs
        WHERE status IN ('done', 'skipped')
        ORDER BY id DESC LIMIT 1
    `).get();

    // 防護：processed_until 必須為有效日期，否則兜底到 2000-01-01（全量重掃）
    // 歷史上出現過 JSON 物件被誤寫入此欄位導致 Scribe 永久跳過（NaN 時間計算）
    let since = '2000-01-01';
    if (lastRun?.processed_until && isValidTimestamp(lastRun.processed_until)) {
        since = lastRun.processed_until;
    } else if (lastRun?.processed_until) {
        console.error(`[Scribe] ⚠️ processed_until 無效日期值，兜底全量掃描: ${JSON.stringify(lastRun.processed_until).slice(0, 100)}`);
        // 嘗試修復：取上一個有效 run 的 processed_until
        const prevValid = db.prepare(`
            SELECT processed_until FROM scribe_runs
            WHERE status IN ('done', 'skipped') AND id < (SELECT MAX(id) FROM scribe_runs WHERE status IN ('done', 'skipped'))
            ORDER BY id DESC LIMIT 1
        `).get();
        if (prevValid?.processed_until && isValidTimestamp(prevValid.processed_until)) {
            since = prevValid.processed_until;
            console.log(`[Scribe] 回退到上一個有效 processed_until: ${since}`);
        }
    }

    // 未處理訊息
    const unprocessed = db.prepare(`
        SELECT id, sender, content, timestamp, message_type, is_encrypted
        FROM messages
        WHERE timestamp > ?
        ORDER BY timestamp ASC
    `).all(since);

    if (!unprocessed.length) return;

    const count = unprocessed.length;
    const lastTimestamp = parseDbTime(unprocessed[unprocessed.length - 1].timestamp);
    const minutesSinceLast = (Date.now() - lastTimestamp) / 60000;

    const silenceReached = minutesSinceLast >= SCRIBE_CONFIG.SILENCE_MINUTES;
    const forceTriggered = count >= SCRIBE_CONFIG.FORCE_TRIGGER_MESSAGES;
    const hasEmotion = hasHighEmotionSignal(unprocessed);

    // 時間兜底：距上次Scribe超過MAX_HOURS_STALE且有足夠未處理訊息→觸發
    // 防止連續聊天（無20分鐘空檔）時Scribe永遠不觸發
    const hoursSinceLastRun = lastRun
        ? (Date.now() - parseDbTime(lastRun.processed_until).getTime()) / 3600000
        : Infinity;
    const staleTriggered = hoursSinceLastRun >= SCRIBE_CONFIG.MAX_HOURS_STALE
        && count >= SCRIBE_CONFIG.STALE_MIN_MESSAGES;

    const shouldRun = forceTriggered ||
        staleTriggered ||
        (silenceReached && count >= SCRIBE_CONFIG.MIN_MESSAGES) ||
        (silenceReached && hasEmotion);

    if (!shouldRun) {
        // 每2小時列印一次跳過原因，方便診斷（避免刷屏）
        const lastSkipKey = `${Math.floor(Date.now() / 7200000)}_scribe_skip`;
        if (!checkAndRunScribe._lastSkipKey || checkAndRunScribe._lastSkipKey !== lastSkipKey) {
            checkAndRunScribe._lastSkipKey = lastSkipKey;
            console.log(`[Scribe] 跳過: ${count}條未處理 | 沉默${Math.floor(minutesSinceLast)}min(需${SCRIBE_CONFIG.SILENCE_MINUTES}) | 距上次${hoursSinceLastRun.toFixed(1)}h(兜底需≥${SCRIBE_CONFIG.MAX_HOURS_STALE}h+${SCRIBE_CONFIG.STALE_MIN_MESSAGES}條) | 情緒=${hasEmotion}`);
        }
        return;
    }

    const trigger = forceTriggered ? 'FORCE' : staleTriggered ? 'STALE' : silenceReached && hasEmotion ? 'EMOTION' : 'SILENCE';
    console.log(`[Scribe] ${trigger}觸發：${count}條未處理訊息，沉默${Math.floor(minutesSinceLast)}分鐘`);

    // 連續「有回覆但解析不了」的失敗次數（failed_parse，自最後一筆 done/skipped 起算）。
    // 連線／服務錯誤（failed）不算：LLM 離線時只停下等待，絕不因此跳過訊息。
    const parseFailStreak = db.prepare(`
        SELECT COUNT(*) AS c FROM scribe_runs
        WHERE status = 'failed_parse'
          AND id > COALESCE((SELECT MAX(id) FROM scribe_runs WHERE status IN ('done', 'skipped')), 0)
    `).get().c;
    let batchSize = SCRIBE_CONFIG.MAX_BATCH;
    if (parseFailStreak >= SCRIBE_CONFIG.POISON_SINGLE_AFTER) batchSize = 1;
    else if (parseFailStreak >= SCRIBE_CONFIG.POISON_SHRINK_AFTER) batchSize = SCRIBE_CONFIG.POISON_SHRINK_BATCH;
    if (batchSize !== SCRIBE_CONFIG.MAX_BATCH) {
        console.warn(`[Scribe] ⚠️ 同一段訊息已連續 ${parseFailStreak} 次解析失敗，本輪改用每批 ${batchSize} 則找出問題訊息`);
    }

    // v5.1: 迴圈處理直到清空積壓（防止 MAX_BATCH 截斷後剩餘訊息永久卡住）
    // 每批結束後游標（cursor）前進到這批最後一則：下一批的背景訊息是緊接在前的 10 則，
    // 不是第一批之前的舊訊息（舊做法每批都傳同一個 since）。
    // 任一批失敗就停：不能讓後面的批次成功而把游標推過失敗批（那批會永久遺失），下次 tick 從失敗批重試。
    const MAX_CONSECUTIVE_BATCHES = 5;  // 安全閥：單次最多處理 5*60=300 條
    let processedTotal = 0;
    let cursor = since;
    for (let b = 0; b < MAX_CONSECUTIVE_BATCHES && processedTotal < count; b++) {
        const batch = unprocessed.slice(processedTotal, processedTotal + batchSize);
        if (batch.length === 0) break;
        console.log(`[Scribe]   批次${b + 1}/${Math.ceil(count / batchSize)}：處理${batch.length}條`);
        const r = await runScribe(batch, cursor);
        if (!r || r.ok === false) {
            if (batchSize === 1 && r?.reason === 'parse') {
                // 單則仍解析不了：認定是毒訊息，記 skipped 推進游標並留下 log，避免整個 Scribe 永遠卡在這裡
                const ts = batch[0].timestamp;
                db.prepare(`INSERT INTO scribe_runs (processed_until, messages_processed, fragments_written, status) VALUES (?, 1, 0, 'skipped')`).run(ts);
                console.error(`[Scribe] ❌ 訊息 #${batch[0].id}（${ts}）連續解析失敗，已略過；請檢查這則訊息內容`);
            } else {
                console.warn(`[Scribe] 批次${b + 1}失敗（${r?.reason || 'unknown'}），停止本輪，下次重試；${count - processedTotal}條待處理`);
            }
            return;
        }
        processedTotal += batch.length;
        cursor = batch[batch.length - 1].timestamp;
    }
    if (processedTotal >= count) {
        console.log(`[Scribe] ✅ 積壓清空：${count}條全部處理完畢`);
    } else {
        console.log(`[Scribe] ⚠️ 達到連續批次上限，${count - processedTotal}條轉入下次tick`);
    }
}

// 本批訊息的聊天模式（只看本批，不含背景訊息）。cinema 訊息不抽取；其餘取出現最多的模式，同票取 id 最早者。
// 舊做法用 `WHERE id IN (本批＋背景) LIMIT 1` 沒有排序，整批的模式取決於任意一則（可能是上一段的背景），
// 判成 cinema 時整批靜默丟棄、也不推進游標。
function batchChatMode(db, messages) {
    const ids = messages.map(m => m.id).filter(id => id != null);
    const cinemaIds = new Set();
    if (!ids.length) return { mode: 'default', isRP: false, cinemaIds };
    let rows = [];
    try {
        rows = db.prepare(`SELECT id, chat_mode, is_rp FROM messages WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
    } catch (_) { rows = []; }
    const count = new Map();
    for (const r of rows) {
        const mode = r.chat_mode || (r.is_rp ? 'roleplay' : 'default');
        if (mode === 'cinema') { cinemaIds.add(r.id); continue; }
        if (!count.has(mode)) count.set(mode, 0);
        count.set(mode, count.get(mode) + 1);
    }
    let mode = 'default', best = 0;
    for (const [m, c] of count) if (c > best) { mode = m; best = c; }   // Map 依首次出現（id 由小到大）排序，同票取較早者
    return { mode, isRP: mode === 'roleplay', cinemaIds };
}

// 單批切半重跑的條件：輸出被截斷且批次夠大（小批次就用救回的條目），最多遞迴兩層
const SPLIT_MIN_MESSAGES = 8;
const SPLIT_MAX_DEPTH = 2;

// 執行Scribe
// 回傳 { ok, written, ... }。ok=false 時不寫 'done'（寫 'failed' 或 'failed_parse'），呼叫端應停下、下次重試，
// 不能讓游標越過這批。opts.depth 為切半遞迴深度（內部使用）。
async function runScribe(messages, since, opts = {}) {
    const db = getDb();
    const depth = opts.depth || 0;
    const batchAll = messages;                      // 游標與統計以整批為準（含被濾掉的 cinema 訊息）
    const modeInfo = batchChatMode(db, batchAll);
    if (modeInfo.cinemaIds.size) {
        messages = batchAll.filter(m => !modeInfo.cinemaIds.has(m.id));
        console.log(`[Scribe] 略過 ${modeInfo.cinemaIds.size} 則 cinema 訊息（電影閒聊不進書記官）`);
    }
    const lastTs = () => (isValidTimestamp(batchAll[batchAll.length - 1]?.timestamp)
        ? batchAll[batchAll.length - 1].timestamp
        : new Date().toISOString().replace('T', ' ').slice(0, 19));
    if (!messages.length) {
        db.prepare(`INSERT INTO scribe_runs (processed_until, messages_processed, fragments_written, status) VALUES (?, ?, 0, 'done')`)
            .run(lastTs(), batchAll.length);
        return { ok: true, written: 0, duplicates: 0, evidenceMerged: 0, quoteDropped: 0, quoteDroppedByType: {}, aiChitchatDropped: 0, aiChitchatDroppedByType: {} };
    }

    // 取緩衝區（往前10條）
    const buffer = db.prepare(`
        SELECT id, sender, content, timestamp, message_type, is_encrypted
        FROM messages
        WHERE timestamp <= ?
        ORDER BY timestamp DESC LIMIT ?
    `).all(since, SCRIBE_CONFIG.CONTEXT_BUFFER).reverse();

    // 拼對話文本（需解密）
    const dec = (m) => (m.is_encrypted && m.content) ? (encryption.decrypt(m.content) || '') : (m.content || '');
    const sanitizeForJSON = (s) => {
        if (!s) return s;
        // 多道消毒，防止 DeepSeek JSON 解析器報 "unexpected end of hex escape"
        // (1) 完整 surrogate 對（emoji 等非 BMP 字元）→ U+FFFD
        s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '�');
        // (2) 落單 surrogate（被 slice 撕裂的 emoji / 畸形編碼）→ 移除
        s = s.replace(/[\uD800-\uDFFF]/g, '');
        // (3) JSON 禁止的 C0 控制字元（\x00-\x08, \x0B, \x0C, \x0E-\x1F）→ 移除
        //     保留 \t(\x09) \n(\x0A) \r(\x0D) —— JSON 原生支援
        s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        return s;
    };
    const formatMsg = (m) => {
        if (m.message_type === 'image') return null;
        const sender = m.sender === 'user' ? USER.name : AI.name;
        // DB 存 UTC；給模型看當地時間＋星期（見提示詞「時間表達」），相對日期才換算得對
        const local = toLocalMinute(m.timestamp);
        const time = local ? `${local} ${weekdayZh(local)}` : (m.timestamp?.slice(0, 16) || '');
        const content = sanitizeForJSON(dec(m).slice(0, 500));
        return `[${time}] ${sender}: ${content}`;
    };

    const bufferText = buffer.map(formatMsg).filter(Boolean).join('\n');
    const mainText = messages.map(formatMsg).filter(Boolean).join('\n');
    const fullText = bufferText
        ? `[以下為背景參考，不重複提取]\n${bufferText}\n\n[以下為本次處理內容]\n${mainText}`
        : mainText;

    // 已有記憶去重參考：對 {user} 的訊息跑 Librarian 檢索，注入已有碎片供 Scribe 比對
    let companionMemoryContext = '（記憶庫中暫無相關記錄。）';
    try {
        const userMsgs = messages.filter(m => m.sender === 'user');
        if (userMsgs.length > 0) {
            const userText = userMsgs.map(m => dec(m).slice(0, 300)).join(' ').slice(0, 1000);
            const { searchHybrid } = require('../../librarian');
            // surface:'none'：去重參考不要混入聊天用的「隨機浮現」舊記憶（結果 <3 條時 40% 機率），否則每次參考都不同
            const retrieved = await searchHybrid(userText, 15, { surface: 'none' });
            if (retrieved.length > 0) {
                companionMemoryContext = retrieved.map((f, i) => {
                    const dateLabel = f.source_date || f.date_label || '';
                    const entity = f.entity || '?';
                    const type = f.type || f._table || '?';
                    const content = (f.content || f.text || '').slice(0, 150);
                    return `#${f.id} [${type}] ${entity}: ${content}${dateLabel ? ' (' + dateLabel + ')' : ''}`;
                }).join('\n');
                console.log(`[Scribe] 已有記憶注入: ${retrieved.length}條`);
            }
        }
    } catch (e) {
        console.error('[Scribe] 記憶上下文重構失敗，降級為空:', e.message);
    }

    // 動態注入人物檔案（傳入訊息文本做 entity_profiles 關鍵詞匹配）
    const knownEntities = await getKnownEntities(mainText);
    const entityRelationContext = await getEntityRelationContext();

    // 動態注入糾正教訓和長期準則
    const activeLessons = getActiveCorrections();
    const mergedGuidelines = await getMergedGuidelines();
    let correctionLessons = '';
    if (mergedGuidelines) {
        correctionLessons += '## 長期編輯準則（必須遵守）\n' + mergedGuidelines;
    }
    if (activeLessons) {
        correctionLessons += (correctionLessons ? '\n\n' : '') + '## 近期糾正教訓\n' + activeLessons;
    }
    if (!correctionLessons) {
        correctionLessons = '（暫無糾正教訓）';
    }

    // 意圖閉環：讀取活躍 future_hook 意圖，讓 Scribe 語義判斷「這次對話是否完成了其中某件」
    let openIntentions = '（暫無未完成的計劃）';
    try {
        const openRows = db.prepare(`
            SELECT id, content, source_date FROM memory_fragments
            WHERE value_tags LIKE '%future_hook%' AND status = 'active'
            ORDER BY created_at DESC LIMIT 20
        `).all();
        if (openRows.length > 0) {
            openIntentions = openRows.map(r =>
                `#${r.id} ${(r.content || '').slice(0, 100)}${r.source_date ? '（' + r.source_date + '）' : ''}`
            ).join('\n');
        }
    } catch (e) {
        console.error('[Scribe] 意圖閉環讀取失敗:', e.message);
    }

    // scribe.prompt：'legacy'（預設，舊版逐字不變）或 'v2'（整理壓縮版，見 scribePromptV2.js）
    const template = getScribeConfig().prompt === 'v2'
        ? buildScribePromptV2({ AI, USER, WORLD_CONTEXT, tagSpec: renderTagSpecForPrompt() })
        : SCRIBE_SYSTEM_PROMPT;
    const systemPrompt = sanitizeForJSON(fillPrompt(template)
        .replace('{KNOWN_ENTITIES}', knownEntities)
        .replace('{ENTITY_RELATION_CONTEXT}', entityRelationContext)
        .replace('{COMPANION_MEMORY_CONTEXT}', companionMemoryContext)
        .replace('{CORRECTION_LESSONS}', correctionLessons)
        .replace('{OPEN_INTENTIONS}', openIntentions)
        .replace('{EMOTION_FIELDS}', () => emotion.prompt.fields())
        .replace('{EMOTION_RULES}', () => emotion.prompt.rules()));

    let result;
    let truncated = false, salvaged = false;
    let lastErrKind = 'llm';                 // 'llm'＝連線／服務錯誤（只停下等待）；'parse'＝有回覆但解析不了
    let attempts = 0;
    const maxAttempts = 2;
    const scfg = getScribeConfig();
    while (attempts < maxAttempts) {
        attempts++;
            try {
                lastErrKind = 'llm';
                const raw = await callLLM(
                    [{ role: 'user', parts: [{ text: fillPrompt(fullText) }] }],
                    systemPrompt,
                    null,
                    { temperature: scfg.temperature, maxOutputTokens: scfg.max_output_tokens },
                    SCRIBE_CONFIG.API_CONFIG_ID
                );

                lastErrKind = 'parse';
                const parsed = parseScribeReply(raw.reply);
                if (!parsed.result || typeof parsed.result !== 'object') {
                    throw new Error(`回覆無法解析為 JSON（${raw.finishReason === 'length' ? '輸出被上限截斷' : '格式錯誤'}）`);
                }
                result = parsed.result;
                salvaged = parsed.salvaged;
                truncated = raw.finishReason === 'length' || parsed.truncated;
                break; // 成功，跳出重試迴圈
            } catch (err) {
            if (attempts < maxAttempts) {
                console.warn(`[Scribe] 第${attempts}次失敗: ${err.message?.slice(0,100)}，3秒後重試...`);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                try {
                console.error('[Scribe] 2次嘗試均失敗:', err.message?.slice(0,200));
                console.error('[Scribe] DEBUG err.response存在:', !!err.response, 'status:', err.response?.status, 'data型別:', typeof err.response?.data);
                // 診斷：dump err 物件結構 + 搜尋列位置
                const allErrText = JSON.stringify({
                    message: err.message,
                    hasResponse: !!err.response,
                    responseStatus: err.response?.status,
                    responseDataType: typeof err.response?.data,
                    responseDataKeys: err.response?.data && typeof err.response.data === 'object' ? Object.keys(err.response.data) : null,
                });
                console.error(`[Scribe] 錯誤結構: ${allErrText.slice(0, 500)}`);
                // 搜列位置
                const searchIn = [
                    err.message || '',
                    typeof err.response?.data === 'string' ? err.response.data : '',
                    err.response?.data?.error?.message || '',
                    JSON.stringify(err.response?.data || ''),
                ].join(' ');
                const colMatch = searchIn.match(/column\s+(\d+)/);
                if (colMatch) {
                    try {
                        const bodyToDump = JSON.stringify({
                            model: db.prepare('SELECT model_name FROM api_configs WHERE id = ?').get(SCRIBE_CONFIG.API_CONFIG_ID)?.model_name || 'unknown',
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: fillPrompt(fullText) }
                            ],
                            temperature: 0.3, max_tokens: 4096
                        });
                        const posUtf8 = parseInt(colMatch[1]);
                        const bodyUtf8 = Buffer.from(bodyToDump, 'utf8');
                        const start = Math.max(0, posUtf8 - 80);
                        const end = Math.min(bodyUtf8.length, posUtf8 + 80);
                        const slice = bodyUtf8.slice(start, end);
                        console.error(`[Scribe] Hex dump 位置 ${posUtf8}/${bodyUtf8.length}B (±80B UTF-8):`);
                        console.error(`  hex: ${slice.toString('hex').replace(/(..)/g, '$1 ').toUpperCase()}`);
                        console.error(`  raw: ${JSON.stringify(slice.toString('utf8'))}`);
                        // 掃描全量問題字元
                        const bodyStr = bodyToDump;
                        const issues = [];
                        for (let i = 0; i < bodyStr.length; i++) {
                            const c = bodyStr.charCodeAt(i);
                            if ((c >= 0xD800 && c <= 0xDFFF) || (c <= 0x1F && c !== 0x09 && c !== 0x0A && c !== 0x0D) || c === 0x7F) {
                                issues.push({charIdx: i, code: '0x' + c.toString(16)});
                            }
                        }
                        if (issues.length > 0) {
                            console.error(`[Scribe] ⚠️ sanitize漏網: ${issues.length} 個問題字元`);
                            issues.slice(0, 10).forEach(iss => {
                                const ctx = bodyStr.slice(Math.max(0, iss.charIdx - 20), iss.charIdx + 30);
                                console.error(`  JS idx ${iss.charIdx} code=${iss.code}: ${JSON.stringify(ctx)}`);
                            });
                        } else {
                            console.error(`[Scribe] sanitize乾淨 (${bodyStr.length} JS units → ${bodyUtf8.length} UTF-8B)`);
                        }
                    } catch (diagErr) {
                        console.error('[Scribe] 診斷hex失敗:', diagErr.message);
                    }
                } else {
                    console.error('[Scribe] 未找到列位置，searchIn前200字:', searchIn.slice(0, 200));
                }
                } catch (diagOuterErr) {
                    console.error('[Scribe] 診斷外層異常:', diagOuterErr.message, diagOuterErr.stack?.slice(0, 200));
                }
                // 失敗不推進游標：只記錄，呼叫端停下、下次 tick 重試。
                // failed_parse（有回覆但解析不了）才計入「毒訊息」連續失敗；failed（連線／服務錯誤）只等待，永不跳過訊息。
                const status = lastErrKind === 'parse' ? 'failed_parse' : 'failed';
                db.prepare(`INSERT INTO scribe_runs (processed_until, messages_processed, status) VALUES (?, ?, ?)`)
                    .run(lastTs(), batchAll.length, status);
                return { ok: false, reason: lastErrKind, written: 0 };
            }
        }
    }

    // 輸出被上限截斷：批次夠大就對半切開各自重跑（丟掉這次不完整的結果，避免同一段寫兩次）；
    // 已經很小或切到最深就用救回的完整條目。
    if (truncated && batchAll.length > SPLIT_MIN_MESSAGES && depth < SPLIT_MAX_DEPTH) {
        const mid = Math.ceil(batchAll.length / 2);
        console.warn(`[Scribe] 輸出被截斷（${salvaged ? '救回部分條目' : '上限截斷'}），切半重跑：${batchAll.length} → ${mid} + ${batchAll.length - mid} 則`);
        const a = await runScribe(batchAll.slice(0, mid), since, { depth: depth + 1 });
        if (!a.ok) return a;
        const b = await runScribe(batchAll.slice(mid), batchAll[mid - 1].timestamp, { depth: depth + 1 });
        if (!b.ok) return { ...b, written: a.written + (b.written || 0) };
        const sumTypes = (x, y) => { const o = { ...(x || {}) }; for (const [k, v] of Object.entries(y || {})) o[k] = (o[k] || 0) + v; return o; };
        return {
            ok: true, split: true, written: a.written + b.written,
            duplicates: a.duplicates + b.duplicates, evidenceMerged: a.evidenceMerged + b.evidenceMerged,
            quoteDropped: a.quoteDropped + b.quoteDropped, quoteDroppedByType: sumTypes(a.quoteDroppedByType, b.quoteDroppedByType),
            aiChitchatDropped: a.aiChitchatDropped + b.aiChitchatDropped, aiChitchatDroppedByType: sumTypes(a.aiChitchatDroppedByType, b.aiChitchatDroppedByType),
        };
    }
    if (truncated) console.warn(`[Scribe] 輸出被截斷，批次已無法再切（${batchAll.length} 則、第 ${depth} 層），使用救回的 ${result.entries?.length || 0} 條完整條目`);

    let written = 0;
    let hashDedupCount = 0;
    // source_date 必須是有效日期。歷史上出現過 JSON 物件誤入 message.timestamp，
    // 會把 source_date 寫成髒值（如 {"llm_call 之類）。與下方 safeUntil 同款守衛：
    // 從末尾往前找最後一個有效時間戳，取它的日期。
    // source_date 一律是當地（UTC+8）日期：DB 時間戳是 UTC，直接 slice 會讓當地清晨的訊息記到前一天。
    let sourceDate = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isValidTimestamp(messages[i]?.timestamp)) {
            sourceDate = toLocalMinute(messages[i].timestamp).slice(0, 10) || messages[i].timestamp.slice(0, 10);
            break;
        }
    }
    if (!sourceDate) sourceDate = toLocalMinute(new Date()).slice(0, 10);
    // 每條記憶的日期＝原話所在那則訊息的日期（一批可橫跨數週）；對不上時退回批次日期
    const msgDates = messages
        .filter(m => m.message_type !== 'image' && isValidTimestamp(m?.timestamp))
        .map(m => ({ text: dec(m).slice(0, 500), date: toLocalMinute(m.timestamp).slice(0, 10) }));
    const newFragmentIds = [];

    // 收集分析視窗內的所有訊息 ID（buffer + main messages），作為證據鏈
    const allMsgIds = [...buffer.map(m => m.id), ...messages.map(m => m.id)];
    const sourceMsgIds = JSON.stringify(allMsgIds);

    // ── 原話佐證：quote 必須是來源訊息的逐字子串，否則丟棄（防幻覺寫入記憶）──
    // 來源只取本次處理的訊息（buffer 僅作背景），截斷長度與餵給 LLM 的一致（500 字）。
    let quoteDropped = 0, quoteDroppedByType = {};
    let aiChitchatDropped = 0, aiChitchatDroppedByType = {};
    if (Array.isArray(result.entries) && result.entries.length) {
        const srcs = { user: [], ai: [] };
        for (const m of messages) {
            if (m.message_type === 'image') continue;
            srcs[m.sender === 'user' ? 'user' : 'ai'].push(dec(m).slice(0, 500));
        }
        const f = filterEntriesByQuote(result.entries, srcs);
        result.entries = f.kept;
        quoteDropped = f.dropped;
        quoteDroppedByType = f.droppedByType;
        aiChitchatDropped = f.aiChitchatDropped;
        aiChitchatDroppedByType = f.aiChitchatDroppedByType;
        if (aiChitchatDropped > 0) {
            const d2 = Object.entries(aiChitchatDroppedByType).map(([t, n]) => `${t}:${n}`).join(',');
            console.log(`[Scribe] 助理閒聊過濾：丟棄 ${aiChitchatDropped} 條（${d2}）`);
        }
        if (quoteDropped > 0) {
            const detail = Object.entries(quoteDroppedByType).map(([t, n]) => `${t}:${n}`).join(',');
            console.log(`[Scribe] 原話佐證：丟棄 ${quoteDropped} 條（無/偽造 quote；${detail}）`);
        }
    }
    // ── 日期與星期一致性：模型換算「下週三」常把日期算錯一到三天（星期多半對），寫入前用程式校正 ──
    if (getScribeConfig().fix_dates && Array.isArray(result.entries)) {
        for (const e of result.entries) {
            if (!e || typeof e.content !== 'string') continue;
            const r = fixDateWeekday(e.content, e.quote, quoteSourceDate(e.quote, msgDates) || sourceDate);
            if (!r.fixes.length) continue;
            e.content = r.content;
            for (const f of r.fixes) console.log(`[Scribe] 日期校正(${f.how}): ${f.from} → ${f.to}`);
        }
    }
    let evidenceMerged = 0;

    if (result.entries?.length) {
        // 迴環過濾：向量去重，防止 {ai} 複述已有記憶被重新提取
        let skipIndices = new Set();
        try {
            const dedupItems = result.entries.map((e, i) => ({
                id: `scribe_temp_${i}`,
                text: `${e.entity || USER.name}: ${e.content}`
            }));
            const dedupResult = await chromaDBOperation('find_duplicates', {
                items: dedupItems,
                threshold: 0.82
            });
            if (dedupResult.duplicates?.length > 0) {
                for (const dup of dedupResult.duplicates) {
                    const idx = parseInt(dup.new_id.replace('scribe_temp_', ''));
                    skipIndices.add(idx);
                    console.log(`[Scribe] 迴環過濾: "${dup.new_preview}" ≈ ${dup.existing_id} (sim=${dup.similarity})`);
                }
                console.log(`[Scribe] 迴環過濾: ${dedupResult.duplicates.length}/${result.entries.length} 條跳過（與已有記憶重複）`);
            }
        } catch (e) {
            console.error('[Scribe] 迴環過濾查詢失敗，降級為全部寫入:', e.message);
        }

        // 聊天模式在 runScribe 開頭已依本批訊息判定（cinema 訊息已濾掉，見 batchChatMode）
        const msgChatMode = modeInfo.mode;
        const isRP = modeInfo.isRP;

        const insert = db.prepare(`
            INSERT INTO memory_fragments (type, entity, content, emotional_weight, source, source_date, source_msg_ids, is_rp, chat_mode, value_tags, priority, content_hash, quote)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // 確定性去重（同實體、active 碎片，**不限日期**）：正規化後內容相同，或近似重複且無關鍵差異
        // （數字/星期/時間詞/換掉一個詞 → 視為不同事實，不合並）。
        // 命中時不新增碎片，改為累加既有碎片的證據（confidence +0.05 上限 1.0，evidence_count +1）。
        // 與 ChromaDB 向量去重互補——嵌入分不清「週三/週五」「貓/狗」，所以本地規則優先於向量。
        const candidateStmt = db.prepare(`
            SELECT id, content, content_hash, source_msg_ids, quote FROM memory_fragments
            WHERE entity = ? AND status = 'active' ORDER BY id DESC LIMIT 400
        `);
        const bumpStmt = db.prepare(`
            UPDATE memory_fragments
            SET confidence = MIN(1.0, COALESCE(confidence, 0.5) + 0.05),
                evidence_count = COALESCE(evidence_count, 1) + 1,
                quote = COALESCE(quote, ?)
            WHERE id = ?
        `);
        const emoMsgs = messages.filter(m => m.message_type !== 'image').map(m => ({ ts: m.timestamp, text: dec(m) }));
        const insertEntityLink = db.prepare(`
            INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by, created_at)
            VALUES (?, ?, ?, 0.70, 'scribe_extract', datetime('now'))
        `);
        for (let i = 0; i < result.entries.length; i++) {
            const entry = result.entries[i];

            // ── Entity handling: support both legacy "entity" (string) and new "entities" (array) ──
            let entityList = [];
            if (entry.entities && Array.isArray(entry.entities) && entry.entities.length > 0) {
                entityList = entry.entities;
            } else if (entry.entity && typeof entry.entity === 'string') {
                // Backward compat: single entity string → array of one
                entityList = [{ name: entry.entity, relation: 'related_to' }];
            } else {
                // Fallback: default to USER
                entityList = [{ name: USER.name, relation: 'related_to' }];
            }

            // Primary entity for the legacy 'entity' column (first entity in list)
            const primaryEntity = entityList[0].name || USER.name;

            // source: 遊戲模式的訊息 → source='game'，否則沿用 LLM 輸出或預設 'chat'
            const fragmentSource = msgChatMode === 'game' ? 'game' : (entry.source || 'chat');

            // value_tags: new field for memory value classification
            const valueTags = (entry.value_tags && Array.isArray(entry.value_tags))
                ? JSON.stringify(entry.value_tags) : '[]';

            // priority: LLM 在提取時通過 Scribe prompt 判斷語義重要性（非關鍵詞匹配）
            // 'high' = 自我剖白 / 核心價值觀表達 / 身份認同宣告
            const priority = entry.priority || 'normal';

            // ── 本地去重 + 證據累加（優先於 Chroma 向量去重）──
            const contentHash = normalizedContentHash(primaryEntity, entry.content);
            const hashDup = findDuplicate(primaryEntity, entry.content, candidateStmt.all(primaryEntity));
            if (hashDup) {
                hashDedupCount++;
                if (hashDup.source_msg_ids !== sourceMsgIds) {  // 同一批訊息重跑不算新證據
                    bumpStmt.run(sealField('memory_fragments', 'quote', String(entry.quote || '').trim()), hashDup.id);
                    evidenceMerged++;
                }
                console.log(`[Scribe] 去重: "${String(entry.content).slice(0, 40)}" = 既有片段 #${hashDup.id}，證據+1`);
                continue;
            }
            if (skipIndices.has(i)) continue;

            const info = insert.run(
                entry.type || 'observation',
                primaryEntity,
                sealField('memory_fragments', 'content', entry.content),
                entry.emotional_weight ?? 0.3,
                fragmentSource,
                quoteSourceDate(entry.quote, msgDates) || sourceDate,
                sourceMsgIds,
                isRP ? 1 : 0,
                msgChatMode,
                valueTags,
                priority,
                contentHash,
                sealField('memory_fragments', 'quote', String(entry.quote || '').trim())
            );
            const fragId = info.lastInsertRowid;
            newFragmentIds.push(fragId);

            // G2：八維情緒、事件日期、三種時間與時段（emotion.enabled=false 時不做任何事；失敗不影響寫入）
            try {
                emotion.applyScribeEmotion(db, fragId, entry, { raisedAt: emotion.resolveRaisedAt(entry.quote, emoMsgs) });
            } catch (e) {
                console.warn(`[Scribe] 情緒欄位寫入失敗 frag#${fragId}: ${e.message}`);
            }

            // 按值標直連到聚合星座（配置驅動，見 services/tagRouting.js）。
            // **入庫即建鏈**：不能等分類管線——分類入口要求 status='active'，而整合會把
            // 跑過的碎片改成 'consolidated'，兩條管線搶同一批碎片，誰先到誰說了算。
            try {
                const { linkTaggedFragment } = require('../consolidation/archivist');
                linkTaggedFragment(db, fragId, valueTags);
            } catch (e) {
                console.warn(`[Scribe] 標路由連結失敗 frag#${fragId}: ${e.message}`);
            }

            // ── Link to entities via fragment_entities (multi-entity support) ──
            // Try keyword match for each entity name to resolve entity_id immediately.
            // If not matched, resolveEntityIds() will handle coref later.
            for (const ent of entityList) {
                const entName = (ent.name || '').trim();
                if (!entName || entName.length < 2) continue;
                const relation = ent.relation || 'related_to';

                // Try exact name match first
                let entityRow = db.prepare(
                    'SELECT id FROM entity_profiles WHERE name = ? AND status IN (\'active\',\'seed\')'
                ).get(entName);

                // Fallback: alias match
                if (!entityRow) {
                    entityRow = db.prepare(
                        `SELECT id FROM entity_profiles
                         WHERE status IN ('active','seed')
                           AND aliases LIKE ? LIMIT 1`
                    ).get(`%${entName}%`);
                }

                if (entityRow) {
                    insertEntityLink.run(fragId, entityRow.id, relation);
                }
                // If no match → resolveEntityIds() will handle via LLM coref later
            }
            written++;
        }
    }

    // 自動索引新片段到 ChromaDB
    if (newFragmentIds.length > 0) {
        indexNewFragments(newFragmentIds).catch(e =>
            console.error('[Scribe] Auto-index failed:', e.message)
        );
    }

    // 實體解析：繫結 entity_id（關鍵詞匹配 + LLM 指代消解）
    // fullText 是已解密的格式化對話文本，用於 LLM 指代消解的上下文
    if (newFragmentIds.length > 0) {
        try {
            await resolveEntityIds(newFragmentIds, fullText);
        } catch (e) {
            console.error('[Scribe] 實體解析失敗（非致命）:', e.message);
        }
    }

    // G2：實體連結完成後，更新個人情緒基準（OU/Kalman）、偵測情緒轉折並歸因到實體
    if (newFragmentIds.length > 0) {
        try {
            const done = emotion.processFragments(db, newFragmentIds);
            const turns = done.reduce((n, r) => n + (r.anomalies?.length || 0), 0);
            if (turns > 0) console.log(`[Scribe] 情緒轉折：${done.filter(r => r.anomalies?.length).length} 條碎片、${turns} 個維度`);
        } catch (e) {
            console.error('[Scribe] 情緒狀態更新失敗（非致命）:', e.message);
        }
    }

    // 意圖閉環：Scribe 在提取 prompt 裡已經語義判斷了「哪些 intention 被完成」，
    // 這裡只負責關閉（摘 future_hook 標籤）
    if (Array.isArray(result.fulfilled_intention_ids) && result.fulfilled_intention_ids.length > 0) {
        for (const intentId of result.fulfilled_intention_ids) {
            try {
                const intent = db.prepare(`SELECT id, value_tags FROM memory_fragments WHERE id = ? AND status = 'active'`).get(intentId);
                if (!intent) continue;
                const tags = (() => { try { return JSON.parse(intent.value_tags || '[]'); } catch(_) { return []; } })();
                if (!tags.includes('future_hook')) continue;
                const newTags = tags.filter(t => t !== 'future_hook');
                if (newTags.length === 0) newTags.push('fulfilled');
                db.prepare(`UPDATE memory_fragments SET value_tags = ? WHERE id = ?`).run(JSON.stringify(newTags), intentId);
                console.log(`[Scribe] ✅ 意圖閉環(語義): intention #${intentId} 已完成`);
            } catch (e) {
                console.error('[Scribe] 意圖閉環關閉失敗:', e.message);
            }
        }
    }

    // 游標以整批為準（含被濾掉的 cinema 訊息），否則它們會在下次 tick 被重新撈出
    const safeUntil = lastTs();
    if (!isValidTimestamp(batchAll[batchAll.length - 1]?.timestamp)) {
        console.error(`[Scribe] ⚠️ 最後一條訊息時間戳無效，使用當前時間兜底: ${safeUntil} (原值: ${JSON.stringify(batchAll[batchAll.length - 1]?.timestamp)})`);
    }

    db.prepare(`
        INSERT INTO scribe_runs (processed_until, messages_processed, fragments_written, status)
        VALUES (?, ?, ?, 'done')
    `).run(safeUntil, batchAll.length, written);

    console.log(`[Scribe] 完成：處理${messages.length}條訊息，寫入${written}條記憶片段${hashDedupCount > 0 ? `（重複${hashDedupCount}條，證據累加${evidenceMerged}）` : ''}${quoteDropped > 0 ? `（quote丟棄${quoteDropped}）` : ''}`);

    // 新碎片寫入完成 → 通知 Archivist Agent（事件驅動，秒級響應）
    if (written > 0) {
        try {
            const { archivistEvents } = require('../consolidation/archivist');
            archivistEvents.emit('fragments:written', { fragmentIds: newFragmentIds, sourceMsgIds });
        } catch (e) {
            console.error('[Scribe] Archivist 事件傳送失敗:', e.message);
        }
    }
    return { ok: true, truncated, salvaged, written, duplicates: hashDedupCount, evidenceMerged, quoteDropped, quoteDroppedByType, aiChitchatDropped, aiChitchatDroppedByType };
}

module.exports = { checkAndRunScribe, indexNewFragments, runScribe };
