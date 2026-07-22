// 中文譯文合併 (#TRANS#) 的回歸測試。
// 最關鍵的一條是 normalizeLine 必須與 cn_music.normalize_line 產生完全相同的字串 ——
// 對不上的話譯文永遠不會出現,而且是靜默失效 (沒有錯誤、沒有 log)。
const assert = require('assert');
const { mergeTranslations, normalizeLine, stripRuby } = require('./web-app/translations');

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      預期 ${JSON.stringify(want)}\n      實際 ${JSON.stringify(got)}`); }
}

// --- normalizeLine:與 Python 端的對照 ---
// 這幾組的期望值是拿 venv 的 cn_music.normalize_line 實際跑出來的
check('正規化 / 去標點空白', normalizeLine('夢ならば、どれほど よかったでしょう'), '夢ならばどれほどよかったでしょう');
check('正規化 / 保留英數', normalizeLine('Lemon (Unnatural 主題曲)'), 'LemonUnnatural主題曲');
check('正規化 / 全形空白', normalizeLine('沈むように　溶けてゆくように'), '沈むように溶けてゆくように');
check('正規化 / 純標點變空', normalizeLine('//'), '');
check('正規化 / 空輸入', normalizeLine(''), '');

// --- stripRuby:注音後的 HTML 要還原得回原文 ---
check('還原 / rt 內容整塊刪掉',
  stripRuby("<ruby class='editable-ruby'>夢<rt>ゆめ</rt></ruby>ならば"), '夢ならば');
check('還原 / 多顆 ruby',
  stripRuby("<ruby>噛<rt>か</rt></ruby>み<ruby>締<rt>し</rt></ruby>め"), '噛み締め');
check('還原 / 沒有 ruby 就原樣', stripRuby('ただの歌詞'), 'ただの歌詞');

// --- mergeTranslations ---
const TRANS = { '夢ならば': '如果是梦', '未だにあなたのことを夢にみる': '至今仍梦见你' };

const lrc = [
  "[00:00.00]#TITLE#作词 : 米津玄師",
  "[00:20.00]<ruby class='editable-ruby'>夢<rt>ゆめ</rt></ruby>ならば",
  "[00:24.00]どれほどよかったでしょう",
].join('\n');
const merged = mergeTranslations(lrc, TRANS).split('\n');

check('合併 / 插在對應行後面', merged[2], '[00:20.00]#TRANS#如果是夢');
check('合併 / 時間戳與原行相同', merged[2].startsWith('[00:20.00]'), true);
check('合併 / 原歌詞行不動', merged[1], lrc.split('\n')[1]);
check('合併 / 沒有譯文的行不插', merged[3], '[00:24.00]どれほどよかったでしょう');
check('合併 / 總行數 = 原本 + 命中數', merged.length, 4);

// 譯文要走簡轉繁 (三家中國平台給的都是簡體)
check('合併 / 譯文有轉繁體', merged[2].includes('如果是夢'), true);

// #TITLE# 行不能被插譯文 (製作人員列的「譯文」是 // 這種佔位)
check('合併 / #TITLE# 行跳過',
  mergeTranslations('[00:00.00]#TITLE#作词 : 甲', { '作词甲': '词：甲' }), '[00:00.00]#TITLE#作词 : 甲');

// 沒有資料時必須逐字不變 —— 關掉翻譯的使用者不能因為這條路徑而看到任何差異
check('合併 / 空 map 逐字不變', mergeTranslations(lrc, {}), lrc);
check('合併 / null map 逐字不變', mergeTranslations(lrc, null), lrc);
check('合併 / 全部沒命中就逐字不變', mergeTranslations(lrc, { 'まったく別の行': 'x' }), lrc);

// 重複合併不能疊加 (rebroadcast 會再跑一次)
const twice = mergeTranslations(mergeTranslations(lrc, TRANS), TRANS);
check('合併 / 重複呼叫不疊加', twice, mergeTranslations(lrc, TRANS));

// 多個時間標籤合併的行 (LRC 允許 [t1][t2]歌詞)
check('合併 / 多重時間標籤原樣保留',
  mergeTranslations('[00:20.00][01:20.00]夢ならば', TRANS).split('\n')[1],
  '[00:20.00][01:20.00]#TRANS#如果是夢');

console.log(`\n${fail === 0 ? '全部通過' : `${fail} 項失敗`} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
