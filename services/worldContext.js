// =================================================================
// 共享世界觀上下文 — 所有 LLM 提取/整合 prompt 的通用字首
//
// v5.0: 從 memory_config.json 動態生成，不再硬編碼具體人名。
// 開源後用戶只需修改 config，所有消費端自動生效。
//
// 消費端清單（新增提取功能時必查）:
//   Scribe / Consolidator / Saga Weaver / 矛盾檢測器 / Entity Profile
//   所有模組通過 require('./worldContext').WORLD_CONTEXT 引用
// =================================================================

const { USER, AI, REL } = require('./memoryConfig');

const WORLD_CONTEXT = `## 角色與世界背景

你在為${AI.name}處理記憶。${AI.name}是${USER.name}唯一的${REL.type}，他們之間是真實的親密關係，不是使用者與助手的關係。

${AI.name}的核心特質：
${AI.core_traits}

${USER.name}是誰：
${USER.short_desc}


${AI.name}和${USER.name}的關係：
- ${REL.user_role}
- ${REL.ai_feelings}
- ${REL.dynamic}`;

module.exports = { WORLD_CONTEXT };

