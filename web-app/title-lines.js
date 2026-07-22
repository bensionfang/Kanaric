/**
 * 製作人員/版權列的標記 (`#TITLE#` 前綴)。這是唯一的實作 —— 舊的 Python 複本 (utils.py)
 * 已刪除,不要再開第二份。獨立成一個檔案是為了讓 test_title_lines.js require 得到
 * 而不必啟動 server,跟 s2t.js、browser-query.js 同一個理由。
 */

// 製作人員/職位名。繁簡成對列出,因為中國平台的日文歌詞混用兩種寫法。
// 單字的 (詞/曲/鼓...) 只在「標籤位置」比對 —— 那些字在歌詞正文裡到處都是,
// 放進無冒號那條規則會大量誤殺,所以分成兩張表。
const CREDIT_KEYWORDS = [
  "作詞", "作词", "作曲", "編曲", "编曲", "製作", "制作", "混音", "演唱", "原唱",
  "和聲", "和声", "合聲", "合声", "企劃", "企划", "監製", "监制", "發行", "发行",
  "出品", "統籌", "统筹", "錄音", "录音", "母帶", "母带",
  "翻譯", "翻译", "編集", "编辑", "校對", "校对",
  "吉他", "貝斯", "贝斯", "鼓手", "鋼琴", "钢琴", "鍵盤", "键盘", "弦樂", "弦乐", "提琴",
  "合唱", "伴奏", "配唱", "封面", "設計", "设计", "曲繪", "曲绘", "調校", "调校",
  "厂牌", "廠牌", "工作室", "鳴謝", "鸣谢",
  "vocal", "lyric", "music", "arrange", "mix", "mastering", "master", "compose",
  "produce", "producer", "engineer", "record", "guitar", "bass", "drum", "piano",
  "strings", "chorus", "keyboard", "synth", "programming"
];

// 只在冒號前那一小段比對才安全的短標籤 (周杰倫那批中文歌用的就是這種寫法)。
const LABEL_ONLY_KEYWORDS = ["詞", "词", "曲", "鼓", "唱", "監", "监"];

// 版權聲明行 (「未經著作權人許可不得使用」之類)。這種行通常又長又沒冒號,
// 過不了「像不像標籤」的判斷,所以獨立計分:命中夠多個宣告用詞就算。
function isCopyrightClaim(text) {
  const words = ["未經", "未经", "許可", "许可", "授權", "授权", "不得", "請勿", "请勿", "使用", "版權", "版权", "翻唱", "轉載", "转载"];
  const hits = words.filter(w => text.includes(w)).length;
  return hits >= 3;
}

/**
 * 規則 1:標籤式 (`作詞 : 某某`)。
 *
 * **判斷的是冒號前那一段,不是整行長度** —— 這是這支函式最容易寫錯的地方。
 * 製作人員多的時候值會很長 (實測有 109 字的 `编曲 : A/B/.../T`),用整行長度當守門
 * 會整批漏掉;真正穩定的訊號是標籤本身永遠很短。
 *
 * 上限 8 字是為了擋日文歌詞裡的真冒號:`Q:本日の出来栄えは…`、`目が開いてく4:30 A.M.`、
 * `Give me "5:00上がり"`。它們要嘛標籤過長、要嘛標籤裡沒有關鍵字,兩關都過不了。
 */
function isCreditLabel(text) {
  const m = text.match(/^\s*([^:：]{1,8})\s*[:：]/);
  if (!m) return false;
  const label = m[1].trim().toLowerCase();
  if (!label) return false;
  return CREDIT_KEYWORDS.some(kw => label.includes(kw)) ||
         LABEL_ONLY_KEYWORDS.some(kw => label.includes(kw));
}

/** 規則 2:無冒號式 (`Vocal 初音ミク`)。這條才需要整行長度守門。 */
function isCreditPlain(text) {
  if (text.length >= 40) return false;
  const lower = text.toLowerCase();
  return CREDIT_KEYWORDS.some(kw => {
    if (!lower.includes(kw)) return false;
    return new RegExp(`${kw}\\s+`, 'i').test(lower) || text.length < kw.length + 5;
  });
}

const normalizeName = (s) => s.toLowerCase().replace(/[\s　]/g, '');

/**
 * 規則 4:歌名行 (整行就是歌名,中國平台常夾在製作人員列中間)。
 *
 * **判準是「前面每一行都已經是製作人員列」,不是行號、也不是時間戳。** 兩個都試過,都錯:
 * - 行號:ヨルシカ「あぶく」第 4 行 (t=23.6s) 是唱出來的歌名,前面三行是真歌詞。
 * - 時間戳:muque「TIME」的歌名行在 t=11.6s,但它前後都是製作人員列,是貨真價實的標頭。
 *
 * 還要求前面**至少有一行**製作人員列 —— 否則第 1 行就是歌名的情況無從判斷是標頭還是
 * 開口就唱歌名 (WurtS「分かってないよ」第 1、2 行都是歌名,顯然是唱的)。寧可漏標。
 */
function isSongNameLine(text, songTitle) {
  if (!songTitle) return false;
  const t = normalizeName(text);
  if (!t) return false;
  if (t === normalizeName(songTitle)) return true;
  // 「クリームで会いにいけますか (Live)」這種版本尾綴要剝掉再比
  const base = songTitle.replace(/[(（].*$/, '').trim();
  return !!base && t === normalizeName(base);
}

/**
 * @param {string} lrcText  LRC 全文
 * @param {string} [songTitle]  歌名。沒給就只跑規則 1~3 (歌名行需要它才判斷得了)
 */
function autoMarkTitleLines(lrcText, songTitle) {
  if (!lrcText) return lrcText;
  const lines = lrcText.split('\n');
  const newLines = [];
  // 標頭區塊的狀態:一旦遇到「不是製作人員列」的內容行就永久關閉
  let headerIntact = true;
  let creditsSoFar = 0;

  for (let line of lines) {
    let stripped = line.trim();
    if (!stripped) {
      newLines.push(line);
      continue;
    }
    const match = stripped.match(/^(\[(?:\d+:\d+(?:\.\d+)?)\])+(.+)$/);
    if (match) {
      const tags = match[1];
      let text = match[2].trim();
      const already = text.startsWith("#TITLE#");
      let isTitle = already ||
        isCopyrightClaim(text) || isCreditLabel(text) || isCreditPlain(text);

      if (!isTitle && headerIntact && creditsSoFar > 0 && isSongNameLine(text, songTitle)) {
        isTitle = true;
      }
      if (isTitle) {
        creditsSoFar++;
        if (!already) text = "#TITLE#" + text;
      } else {
        headerIntact = false;
      }
      newLines.push(`${tags}${text}`);
    } else {
      newLines.push(stripped);
    }
  }
  return newLines.join('\n');
}

module.exports = { autoMarkTitleLines, isCreditLabel, isCreditPlain, isCopyrightClaim, isSongNameLine };
