/**
 * 中文譯文的合併。譯文**不能存進 `cache`**,只能在注音之後才併進廣播內容 —— 因為
 * `s2t.js` 的簡轉繁與 `furigana_inject.process_lrc` 的注音,兩個 kana gate 都是
 * 「整份有沒有假名」而不是逐行:混進去的中文譯文會 (a) 不被轉繁 (b) 被 fugashi
 * 標上一堆亂七八糟的音讀。
 *
 * 譯文以 `#TRANS#` 前綴插在對應歌詞行的後面,沿用 `#TITLE#` 的既有慣例:前端與靈動島
 * 各用一行判斷就能認出來,不必依賴「時間戳差 < 0.05s」那種啟發式。
 *
 * 獨立成一個檔案是為了讓 test_translations.js require 得到而不必啟動 server,
 * 跟 s2t.js、browser-query.js、title-lines.js 同一個理由。
 */
const { toTraditional } = require('./s2t');

const LINE_RE = /^((?:\[\d+:\d+(?:\.\d+)?\])+)(.+)$/;

/**
 * 與 cn_music.normalize_line 必須產生**完全相同**的字串,否則譯文永遠對不上、
 * 而且是靜默失效。Python 的 `\w` 對 str 是 Unicode 感知的 (假名漢字都算 word char),
 * JS 的 `\w` 只有 [A-Za-z0-9_],所以這裡要用 \p{L}\p{N}\p{M} 明寫。
 * 回歸測試 test_translations.js 有一組跨語言對照案例。
 */
function normalizeLine(text) {
  return (text || '').replace(/[^\p{L}\p{N}\p{M}_]+/gu, '');
}

/**
 * 注音後的歌詞是 `<ruby>漢字<rt>かな</rt></ruby>` 這種 HTML,要還原回原文才比對得到
 * 譯文的 key。**`<rt>` 的內容必須整塊刪掉**,只脫標籤的話「夢<rt>ゆめ</rt>」會變成
 * 「夢ゆめ」,跟原文對不上。
 */
function stripRuby(html) {
  return (html || '').replace(/<rt[^>]*>.*?<\/rt>/g, '').replace(/<[^>]+>/g, '');
}

/**
 * 把譯文併進注音後的 LRC。
 * @param {string} lrcHtml   injectFurigana 的輸出
 * @param {object} transMap  {正規化後的日文行: 譯文}。空物件 = 查過但沒有翻譯
 * @returns {string} 原字串 (沒有任何譯文可併時逐字不變) 或插入 #TRANS# 行後的新字串
 */
function mergeTranslations(lrcHtml, transMap) {
  if (!lrcHtml || !transMap || !Object.keys(transMap).length) return lrcHtml;

  const lines = lrcHtml.split('\n');
  const out = [];
  let inserted = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = line.trim().match(LINE_RE);
    if (!m) continue;
    const text = m[2].trim();
    // 製作人員列與已經插好的譯文行都不再處理
    if (text.startsWith('#TITLE#') || text.startsWith('#TRANS#')) continue;
    // 下一行已經是這句的譯文就跳過 —— 沒有這道檢查,同一份輸入合併兩次會插出兩行
    const next = (lines[i + 1] || '').trim().match(LINE_RE);
    if (next && next[2].trim().startsWith('#TRANS#')) continue;

    const hit = transMap[normalizeLine(stripRuby(text))];
    if (!hit) continue;
    // 譯文是簡體 (三家中國平台都是),轉繁在合併時做而不是寫入時 —— 這樣改版前
    // 存進 lyrics_translations 的舊資料也會一起變繁體,同 cache 那四個讀取點的理由。
    out.push(`${m[1]}#TRANS#${toTraditional(hit)}`);
    inserted++;
  }
  return inserted ? out.join('\n') : lrcHtml;
}

module.exports = { mergeTranslations, normalizeLine, stripRuby };
