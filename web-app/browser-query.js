// 瀏覽器/影片來源 (YouTube 之類) 的歌名去噪。播放器給的是影片標題,直接拿去搜歌詞
// 對嚴格比對的來源 (Lrclib) 會全數落空。只影響搜尋字串 —— 顯示、快取鍵、聆聽紀錄都仍用原始標題。
// 單獨一個檔案 (而非留在 server.js) 是為了讓 test_search_query.js 能 require,不用把整台 server 帶起來。

// ponytail: 手動鏡射 media_monitor.py 的 MUSIC_APPS (兩份 4 個字串);那邊改了這邊要跟
const MUSIC_APPS = ['spotify', 'applemusic', 'itunes', 'zunemusic'];
function isMusicAppSource(source) {
  if (!source) return true; // 未知來源當音樂 app,不去噪也不套瀏覽器那幾道限制 (保守)
  const s = source.toLowerCase();
  return MUSIC_APPS.some(a => s.includes(a));
}

// 只剝含明確噪音關鍵字的整塊括號,不拆 Artist - Song
const _NOISE_KW = /(mv|pv|official|music\s*video|lyric[s]?|audio|hd|4k|full|live|cover|feat\.?|カラオケ|歌ってみた|フル|字幕)/i;
// 無括號的尾綴噪音 (「アイドル Official Music Video」這種)。剝到不再變動為止,一次只咬一段。
const _NOISE_TAIL = /[\s\-–—|]*(official\s*(music\s*)?(video|audio)|music\s*video|lyric[s]?\s*video|full\s*ver\.?|mv|pv|中文字幕|中日字幕|中日歌詞|動態歌詞|动态歌词|歌詞付き|歌ってみた)\s*$/i;

function cleanBrowserQuery(title, artist) {
  let t = (title || '')
    .replace(/[【［(\[（][^】］)\]）]*[】］)\]）]/g, (m) => _NOISE_KW.test(m) ? '' : m)
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 「アイドル」/『…』/【擱淺 Step Aside】括起來的才是歌名,外面那串是頻道名與宣傳詞
  // (YOASOBI「アイドル」 Official …、周杰倫 Jay Chou【擱淺 Step Aside】-Official Music Video)。
  // 【MV】這種含噪音關鍵字的整塊上面已經剝掉了,走到這裡的【】就是歌名。
  const quoted = t.match(/[「『【]([^」』】]{1,60})[」』】]/);
  if (quoted) t = quoted[1].trim();

  let prev;
  do { prev = t; t = t.replace(_NOISE_TAIL, '').trim(); } while (t !== prev && t);

  const norm = (s) => s.replace(/[\s\-_.]/g, '').toLowerCase();

  // 「歌名／歌手」尾綴。只有尾段真的就是歌手時才剝 —— 歌名本身含 / 的 (「A/B」) 不能砍
  const slash = t.match(/^(.+?)\s*[／/]\s*([^／/]{1,30})$/);
  if (slash && artist) {
    const tail = norm(slash[2]), a0 = norm(artist);
    if (tail && a0 && (tail.includes(a0) || a0.includes(tail))) t = slash[1].trim();
  }

  // 「歌手 - 歌名」前綴 (YouTube 最常見的形狀:ヨルシカ - 春泥棒)。前綴真的是歌手時才剝:
  // 不剝的話快取鍵就是「ヨルシカ - 春泥棒」,跟同一首歌從 Spotify 聽到的「春泥棒」分裂成
  // 兩筆,排行榜與統計跟著拆開 —— 正是這整套去噪要避免的事。
  // 判準與上面的 ／歌手 同一條 (正規化後互相包含),對不上就原樣留著,所以歌名本身帶
  // 連字號的 (怪獣の花唄 - replica -) 不受影響。
  const dash = t.match(/^(.{1,40}?)\s+[-–—]\s+(.+)$/);
  if (dash && artist) {
    const head = norm(dash[1]), a0 = norm(artist);
    if (head && a0 && (head.includes(a0) || a0.includes(head))) t = dash[2].trim();
  }

  const a = (artist || '')
    .replace(/\s*-\s*Topic\s*$/i, '')
    .replace(/\s*VEVO\s*$/i, '')
    .replace(/\s*Official\s*$/i, '')
    .trim();
  return { title: t || title, artist: a || artist };
}

module.exports = { cleanBrowserQuery, isMusicAppSource, MUSIC_APPS };
