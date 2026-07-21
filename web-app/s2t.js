// 中國的歌詞站 (網易/QQ/酷狗) 回來的是簡體,存進快取前轉繁體。
// **日文歌詞絕對不能過這個轉換** —— 日文漢字有一半跟簡體同形,會被改掉 (声→聲、学校→學校),
// 所以整份有假名就原封不動。這跟 furigana_inject.process_lrc 的「無假名就不注音」是同一條規則。
// 單獨一個檔案 (而非留在 server.js) 只是為了讓 test_s2t.js 能直接 require,不用把整台 server 帶起來。
const OpenCC = require('opencc-js');

const convert = OpenCC.Converter({ from: 'cn', to: 'tw' });

function toTraditional(text) {
  if (!/[぀-ヿ]/.test(text)) return convert(text);
  // 日文歌詞:歌詞本體不准動,但網易連日文歌都給簡體的製作人員列 (作词 : … / 编曲 : …)。
  // 那些列在寫入時已被 autoMarkTitleLines() 標上 #TITLE#,只轉這些列。
  // ponytail: 名字裡剛好有簡繁同形字的話會一起被轉 (學/實),製作人員列上罕見,真遇到再改成只轉冒號前的標籤。
  return text.split('\n').map((line) => (line.includes('#TITLE#') ? convert(line) : line)).join('\n');
}

module.exports = { toTraditional };
