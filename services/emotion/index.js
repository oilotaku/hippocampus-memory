// 情緒引擎（G2）：八維情緒、三種時間與時段、個人化 OU 基準、轉折歸因、週年日、情緒褪色
const config = require('./config');
const scoring = require('./scoring');
const time = require('./time');
const ou = require('./ou');
const store = require('./store');
const queries = require('./queries');
const fading = require('./fading');
const prompt = require('./prompt');

module.exports = {
    ...config, ...scoring, ...time, ...ou, ...store, ...queries, ...fading,
    prompt,
};
