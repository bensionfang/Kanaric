// 中國的歌詞站 (網易/QQ/酷狗) 回來的是簡體,存進快取前轉繁體。
// **日文歌詞絕對不能過這個轉換** —— 日文漢字有一半跟簡體同形,會被改掉 (声→聲、学校→學校),
// 所以整份有假名就原封不動。這跟 furigana_inject.process_lrc 的「無假名就不注音」是同一條規則。
// 單獨一個檔案 (而非留在 server.js) 只是為了讓 test_s2t.js 能直接 require,不用把整台 server 帶起來。
const OpenCC = require('opencc-js');

const convert = OpenCC.Converter({ from: 'cn', to: 'tw' });

function toTraditional(text) {
  return /[぀-ヿ]/.test(text) ? text : convert(text);
}

module.exports = { toTraditional };
