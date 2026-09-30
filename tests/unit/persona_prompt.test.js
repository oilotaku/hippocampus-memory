'use strict';
// G3 接回聊天 prompt：只取 confidence ≥ 0.7、最多 5 行、受獨立小預算限制、簡繁並存去重。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanupDb, quiet } = require('./_helpers');
const { seedTrait, seedQualifiedTrait } = require('./_persona_helpers');

const dbPath = setupEnv('persona-prompt');
let restore, db, persona;
const clearTraits = () => { db.prepare('DELETE FROM user_model').run(); };
const bodyLines = (block) => block.split('\n').filter(l => l.startsWith('- '));

before(() => {
    restore = quiet();
    require('../../database').initDatabase();
    db = require('../../database').getDb();
    persona = require('../../services/persona');
});
after(() => { restore(); cleanupDb(dbPath); });

test('沒有任何特質與關係層 → 空字串（不注入空區塊）', () => {
    assert.equal(persona.buildRelationshipContext(), '');
});

test('只取 confidence ≥ 0.7 的 stable_trait；低信心、非 stable_trait、非 active 都不進', () => {
    clearTraits();
    seedTrait(db, { content: '高信心特質', confidence: 0.9 });
    seedTrait(db, { content: '剛好門檻特質', confidence: 0.7 });
    seedTrait(db, { content: '低信心特質', confidence: 0.69 });
    seedTrait(db, { content: '已放棄特質', confidence: 0.95, status: 'abandoned' });
    db.prepare("INSERT INTO user_model (type, content, confidence) VALUES ('active_hypothesis', '只是假設', 0.95)").run();
    const block = persona.buildRelationshipContext();
    assert.match(block, /^<relationship_context>/);
    assert.match(block, /<\/relationship_context>$/);
    assert.deepEqual(bodyLines(block), ['- 高信心特質', '- 剛好門檻特質']);
});

test('最多 5 行，依信心高低取前 5', () => {
    clearTraits();
    for (let i = 0; i < 8; i++) seedTrait(db, { content: `特質${i}`, confidence: 0.99 - i * 0.02 });
    const lines = bodyLines(persona.buildRelationshipContext());
    assert.equal(lines.length, 5);
    assert.deepEqual(lines, ['- 特質0', '- 特質1', '- 特質2', '- 特質3', '- 特質4']);
    // 可設定
    assert.equal(bodyLines(persona.buildRelationshipContext({ cfg: { persona: { max_prompt_lines: 2 } } })).length, 2);
    assert.equal(persona.buildRelationshipContext({ cfg: { persona: { max_prompt_lines: 0 } } }), '');
});

test('獨立 token 預算：超出時整行丟棄，不切斷單行，且排序在前的優先', () => {
    clearTraits();
    seedTrait(db, { content: '短甲', confidence: 0.95 });
    seedTrait(db, { content: '長'.repeat(200), confidence: 0.9 });
    seedTrait(db, { content: '短乙', confidence: 0.85 });
    const block = persona.buildRelationshipContext({ cfg: { persona: { prompt_token_budget: 60 } } });
    // 200 字 ≈ 50 token 放不下 → 在它那裡停止（不為了塞更多而跳過排序較前的），且沒有半截的長行
    assert.deepEqual(bodyLines(block), ['- 短甲']);
    assert.ok(!block.includes('長長長'));
    // 預算小到連標頭都放不下 → 不注入
    assert.equal(persona.buildRelationshipContext({ cfg: { persona: { prompt_token_budget: 5 } } }), '');
    // 預設 300 token：整段大小不超過預算
    clearTraits();
    for (let i = 0; i < 5; i++) seedTrait(db, { content: `${'字'.repeat(60)}${i}`, confidence: 0.9 });
    const big = persona.buildRelationshipContext();
    assert.ok(Math.ceil(big.length / 4) <= 300, `估算 ${Math.ceil(big.length / 4)} token`);
});

test('關係層（已套用）排在特質前面，並與特質去重；簡繁並存視為同一行', () => {
    clearTraits();
    const id = seedQualifiedTrait(db, '喜歡安靜的咖啡館', 0.9);
    persona.generateProposals({ cfg: { persona: { auto_apply: false } } });
    persona.applyProposal(persona.listProposals({ status: 'pending' })[0].id);
    seedTrait(db, { content: '喜欢安静的咖啡馆', confidence: 0.99 });      // 簡體重複
    seedTrait(db, { content: '很怕冷', confidence: 0.8 });
    const lines = bodyLines(persona.buildRelationshipContext());
    assert.deepEqual(lines, ['- 喜歡安靜的咖啡館', '- 很怕冷']);
    assert.ok(id > 0);
});

test('情境層只取未過期的 current_state', () => {
    db.prepare('DELETE FROM user_model').run();
    db.prepare("INSERT INTO user_model (type, content, confidence, expires_at) VALUES ('current_state', '這週趕報告', 0.9, datetime('now', '+2 days'))").run();
    db.prepare("INSERT INTO user_model (type, content, confidence, expires_at) VALUES ('current_state', '已過期的狀態', 0.9, datetime('now', '-2 days'))").run();
    db.prepare("INSERT INTO user_model (type, content, confidence, expires_at) VALUES ('current_state', '沒有期限的狀態', 0.9, NULL)").run();
    const s = persona.getSituationalLayer();
    assert.ok(s.includes('這週趕報告') && s.includes('沒有期限的狀態'));
    assert.ok(!s.includes('已過期的狀態'));
});
