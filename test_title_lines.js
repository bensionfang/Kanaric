// 製作人員/版權列標記 (#TITLE#) 的回歸測試。
// 案例全部取自實際快取 (lyrics_data.db,393 首) 撈出來的真實歌詞行 ——
// 該標的那批是舊版漏標的,不該標的那批是「有冒號但其實是歌詞」的誤殺候選。
const assert = require('assert');
const { autoMarkTitleLines } = require('./web-app/title-lines');

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      預期 ${want} / 實際 ${got}`); }
}

// 包成一行 LRC 再丟進去,回來看有沒有 #TITLE#
function marked(text) {
  const out = autoMarkTitleLines(`[00:01.00]${text}`);
  return out.includes('#TITLE#');
}

// --- 該標成 #TITLE# 的 ---
const SHOULD_MARK = [
  // 值很長的製作人員列:舊版的 text.length < 40 把整批擋掉了 (實測 97/109 字)
  ['長列表-作词', '作词 : 杨一/Z./晚秋/柒柒/燯二/天真/大彬子/小7/不吃菜包子/沉寂/猫鱼ai/bangbangaa/爱唱歌的蜗牛/辣条/Bella02/美味汉堡包/一根辣条/李娇/玛丽莲左手/萧斯卡尔'],
  ['長列表-编曲', '编曲 : 芝芝香/Mike/晚安/alma/96分，差4你就满分了/小蛋挞/某不知名高达驾驶员/石马勇次郎/山崎小水/心/白白白白白Maple/特别/曹航/一虎/乱步出真理/迪迦./鼬/aaa暴躁老妈/隋小轩/elma'],
  ['短標籤-作曲', '作曲 : ツミキ/みきまりあ'],
  // 單字標籤:舊版關鍵字表只有雙字詞,裸的 词/曲/鼓 完全沒收
  ['單字-词', '词：周杰伦'],
  ['單字-曲', '曲：周杰伦'],
  ['單字-鼓', '鼓：陈柏州'],
  ['單字-词多人', '词：古小力/黄淩嘉'],
  // 異體字:表裡只有「和声」,周杰倫那批用的是「合声」
  ['異體-合声', '合声：周杰伦'],
  ['異體-合声编写', '合声编写：周杰伦'],
  // 無冒號式 (規則 2) 不能因為這次改動壞掉
  ['無冒號-Vocal', 'Vocal 初音ミク'],
  // 版權聲明 (獨立計分,命中 3 個宣告用詞)
  ['版權聲明', '未經著作權人許可不得使用或翻唱'],
];

// --- 不該標的:全是真歌詞,只是剛好有冒號 ---
const SHOULD_NOT_MARK = [
  ['對白-Q', 'Q:本日の出来栄えはどうでしたか'],
  ['對白-A', 'A:まずまずでした'],
  ['對白-Q長', 'Q:果たして私に意義はあるのですか'],
  ['對白-A長', 'A:まずまずですが、明日も私と生きてくれるのなら'],
  ['時刻-引號', 'Give me "5:00上がり"'],
  ['時刻-25:00', '25:00 さらに'],
  ['比例-16:9', '16:9の端を切り取った理由は'],
  ['時刻-句中', '目が開いてく4:30 A.M.'],
  // 一般歌詞,含單字關鍵字但不在標籤位置 —— LABEL_ONLY_KEYWORDS 最容易誤殺的地方
  ['正文含曲', 'この曲が終わる前に'],
  ['正文含詞', '言葉にできない詞を'],
  ['正文含鼓', '鼓動が聞こえる'],
];

for (const [name, text] of SHOULD_MARK) check(`該標 / ${name}`, marked(text), true);
for (const [name, text] of SHOULD_NOT_MARK) check(`不該標 / ${name}`, marked(text), false);

// 結構本身不能被破壞:時間標籤要原樣保留,空行要留著
const src = '[00:01.00]作词 : 甲\n\n[00:02.00]普通歌詞';
const out = autoMarkTitleLines(src);
check('保留時間標籤', out.includes('[00:01.00]#TITLE#作词 : 甲'), true);
check('保留空行', out.split('\n').length === 3, true);
check('不重複加前綴', autoMarkTitleLines(out) === out, true);

// --- 規則 4:歌名行。案例全部是實際快取裡的真實排版 ---
// 判準是「前面每一行都已經是製作人員列」。行號與時間戳都試過、都錯,理由見 title-lines.js。
const nameCase = (name, lrc, songTitle, wantMarkedLine) => {
  const out = autoMarkTitleLines(lrc, songTitle).split('\n');
  check(name, out[wantMarkedLine.idx].includes('#TITLE#'), wantMarkedLine.want);
};

// 該標:歌名夾在製作人員列中間 (Chevon「薄明光線」的真實排版)
nameCase('歌名 / 夾在製作人員列中間',
  '[00:00.00]作词 : 谷絹 茉優\n[00:00.30]作曲 : Chevon\n[00:00.60]薄明光線\n[00:26.30]酷い孤独の中',
  '薄明光線', { idx: 2, want: true });

// 該標:時間戳晚到 11.6s 也算 —— muque「TIME」,證明時間戳門檻是錯的訊號
nameCase('歌名 / t=11.6s 仍在標頭區塊',
  '[00:00.00]作词 : ASAKURA\n[00:01.00]作曲 : takachi\n[00:11.60]TIME\n[00:11.70]Music ： takachi\n[00:12.20]君を写す',
  'TIME', { idx: 2, want: true });

// 不該標:前面是真歌詞 —— ヨルシカ「あぶく」第 4 行是唱出來的
nameCase('歌名 / 前面是真歌詞就不標',
  '[00:11.80]あぁどうしようもないほどに\n[00:14.40]私に蠢く獣\n[00:18.30]水面浮かんでは消える\n[00:23.60]あぶく',
  'あぶく', { idx: 3, want: false });

// 不該標:第 1 行就是歌名,前面沒有製作人員列 —— WurtS「分かってないよ」開口就唱歌名
nameCase('歌名 / 第一行無從判斷就不標',
  '[00:03.20]分かってないよ\n[00:09.60]分かってないよ\n[00:25.40]随分前にさ',
  '分かってないよ', { idx: 0, want: false });
nameCase('歌名 / 第二行同樣不標(不連鎖)',
  '[00:03.20]分かってないよ\n[00:09.60]分かってないよ\n[00:25.40]随分前にさ',
  '分かってないよ', { idx: 1, want: false });

// 版本尾綴要剝掉再比 (「… (Live)」的歌詞裡寫的是本名)
nameCase('歌名 / 剝掉 (Live) 尾綴',
  '[00:00.00]作词 : 甲\n[00:00.50]グラスとラムレーズン\n[00:20.00]歌詞',
  'グラスとラムレーズン (Live)', { idx: 1, want: true });

// 沒給歌名時規則 4 整條跳過,不能誤傷
nameCase('歌名 / 未提供歌名則跳過',
  '[00:00.00]作词 : 甲\n[00:00.50]某某\n[00:20.00]歌詞',
  undefined, { idx: 1, want: false });

console.log(`\n${fail === 0 ? '全部通過' : `${fail} 項失敗`} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
