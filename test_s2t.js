// 簡繁轉換守門:中文轉繁、日文原封不動 (實作在 web-app/s2t.js)
const assert = require('assert');
const { toTraditional } = require('./web-app/s2t');

assert.strictEqual(toTraditional('我们的爱情像风筝断了线'), '我們的愛情像風箏斷了線');
const ja = '[00:01.00]君の声が聞こえる 実は学校の後ろ';
assert.strictEqual(toTraditional(ja), ja);   // 声/学 不可以被改成 聲/學
assert.strictEqual(toTraditional('[00:01.00]別問我為什麼'), '[00:01.00]別問我為什麼');  // 已是繁體不變

// 日文歌詞:本體不准動,但網易給的簡體製作人員列 (已標 #TITLE#) 要轉繁
const jaCredit = '[00:00.000]#TITLE#作词 : ASAKURA\n[00:12.00]君の声が聞こえる 実は学校の後ろ';
assert.strictEqual(
  toTraditional(jaCredit),
  '[00:00.000]#TITLE#作詞 : ASAKURA\n[00:12.00]君の声が聞こえる 実は学校の後ろ'
);

console.log('OK');
