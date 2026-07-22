/**
 * iTunes 日文原名還原的「名字定案前先別抓歌詞」回歸測試 (server.js handleMediaUpdate)。
 *
 *   node test_itunes_resolving.js
 *
 * 還原查詢是非同步的:換歌後頭幾百毫秒 state 裡還是原始名字,幾秒後才變成日文原名。
 * 前端看到 title 變會當成換歌重抓歌詞,於是同一首歌用兩個鍵各抓一次 —— 第二次多半
 * 撞到來源限流變成「找不到歌詞」,把已經抓對的歌詞蓋掉 (要重新載入才好)。
 * 修法是查詢還在飛的時候回報 resolving=true,前端等它變 false 再抓。
 *
 * 這裡要守的是 resolving 的生命週期:一定要在有限時間內變回 false。
 * getResolvedMetadata 有三條 return (含假名早退、查到、例外),漏掉任何一條沒清掉
 * pending 佔位,那首歌就永遠等不到歌詞 —— 比原本的 bug 更慘。
 * 不需要網路:查不到 / 連不出去都會走到例外那條,一樣要清掉 pending。
 */
process.env.PORT = process.env.PORT || '5732';
// 失敗重試的冷卻縮短,測試才不用真的等 60 秒。**不能設成 0** —— 冷卻期間要能穩定回報
// resolving=false (先用原名放歌詞),設 0 就變成每次更新都重試、永遠不定案。
process.env.ITUNES_RETRY_MS = process.env.ITUNES_RETRY_MS || '400';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-itunes-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.DATA_DIR = TMP;
process.env.LYRICS_SETTINGS_PATH = path.join(TMP, 'settings.json');

require('./web-app/server.js');

let failed = 0;
const check = (ok, label, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};

const track = (title, artist) => ({
  title, artist, album: '', source: 'spotify', position: 1,
  duration: 233, is_playing: true, shuffle: false, repeat: 0,
});

// handleMediaUpdate 是就地改寫傳進去的物件,所以直接看物件就好 ——
// 不看 currentMediaState,那個會被真的 media monitor 每 0.1 秒蓋掉
function update(title, artist) {
  const st = track(title, artist);
  global.handleMediaUpdate(st);
  return st;
}

// 定案 = resolving 變 false。給 6 秒 (iTunes 查詢自帶 3 秒 timeout)
async function waitResolved(title, artist, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = update(title, artist);
    if (!st.resolving) return st;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

(async () => {
  // 1. 無假名標題 (Spotify 把日文譯成中文漢字的情況) 會真的去查 iTunes
  const first = update('打上花火', 'DAOKO');
  check(first.resolving === true, '第一次回報:查詢還沒回來,resolving=true');

  const settled = await waitResolved('打上花火', 'DAOKO');
  check(!!settled, '無假名標題:查詢結束後 resolving 變回 false');

  // 2. 已含假名 = 不用還原,早退那條也必須清掉 pending
  const kana = await waitResolved('打上花火', 'DAOKO・米津玄師');
  check(!!kana, '含假名標題:早退路徑也會解除 resolving');

  // 3. 名字定案後就穩定,不會再變 (變了前端就會多抓一次歌詞)
  if (settled) {
    const again = update('打上花火', 'DAOKO');
    check(
      again.title === settled.title && again.artist === settled.artist && !again.resolving,
      '定案後名字不再變動',
      `${again.artist} - ${again.title}`
    );
  }

  // 4. 瀏覽器來源:影片標題與頻道名進場就洗乾淨 (鍵是 (artist, title),不洗就會跟
  //    音樂 app 聽的同一首分裂成兩筆)。這是 handleMediaUpdate 的第一步,在 iTunes 還原之前。
  const yt = {
    title: 'ダンス・デカダンス／Chevon 【Lyric Video】', artist: 'Chevon-シェボン',
    album: '', source: 'chrome.exe', position: 1, duration: 233, is_playing: true,
  };
  global.handleMediaUpdate(yt);
  check(yt.title === 'ダンス・デカダンス', '瀏覽器來源:影片標題進場就洗乾淨', yt.title);
  check(yt.original_title === 'ダンス・デカダンス／Chevon 【Lyric Video】',
    '瀏覽器來源:原始標題留在 original_title');

  // 音樂 app 的標題一個字都不准動 (Live/Remix 版本資訊必須留著)
  const sp = { ...track('Lemon (Live)', '米津玄師'), source: 'Spotify.exe' };
  global.handleMediaUpdate(sp);
  check(sp.title === 'Lemon (Live)', '音樂 app 來源:標題不去噪', sp.title);

  // 5. 沒有播放來源時不能卡在 resolving
  const empty = { title: '', artist: '', is_playing: false };
  global.handleMediaUpdate(empty);
  check(empty.resolving === false, '無播放來源:resolving=false');

  // 5b. 歌手名可不可信。iTunes JP 會把西洋歌手音譯成片假名 (Coldplay → コールドプレイ),
  //     而片假名也算假名 —— 舊版「結果含假名就收」會把整批西洋歌改名寫進快取鍵與排行榜。
  //     這裡用假的 iTunes 回應釘住三條判準,不打網路。
  const savedFetch = global.fetch;
  const canned = {
    // 原名純 ASCII + 結果純片假名 + 曲風不是 J-* → 音譯,不准採用
    'Yellow Coldplay':        ['コールドプレイ', 'Yellow', 'オルタナティブ'],
    // 原名帶 CJK = 被翻譯過,結果一定是還原 (曲風是「ロック」不是 J-Pop,照樣要收)
    'Aoi 魚韻':               ['サカナクション', 'Aoi', 'ロック'],
    // 結果帶平假名 → 音譯不可能長這樣
    'Puppet natori':          ['なとり', 'Puppet', 'J-Pop'],
    // 純片假名 + 純 ASCII 原名,跟 Coldplay 同形 —— 只有曲風分得開
    'Epilogue RETRORIRON':    ['レトロリロン', 'ワンタイムエピローグ', 'J-Pop'],
    // 羅馬字歌名很容易搜到翻唱版,カラオケ 整筆丟掉 (歌名歌手都有假名,別的閘門攔不住)
    'Haru Dorobou Yorushika': ['歌っちゃ王', '春泥棒', 'カラオケ'],
  };
  global.fetch = (url, opts) => {
    const u = String(url);
    if (!u.includes('itunes.apple.com')) return savedFetch(url, opts);
    const term = decodeURIComponent((u.match(/term=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
    const c = canned[term];
    const results = c ? [{
      artistName: c[0], trackName: c[1], primaryGenreName: c[2],
      trackTimeMillis: 100000,   // 跟 track() 的 233 秒差很遠,確保不是靠時長過關
    }] : [];
    return Promise.resolve({ json: () => Promise.resolve({ results }) });
  };

  for (const [title, artist, wantArtist, wantTitle, label] of [
    ['Yellow', 'Coldplay', 'Coldplay', 'Yellow', '西洋歌手的片假名音譯不採用'],
    ['Aoi', '魚韻', 'サカナクション', 'Aoi', '原名帶 CJK:片假名結果照收'],
    ['Puppet', 'natori', 'なとり', 'Puppet', '結果帶平假名:採用'],
    ['Epilogue', 'RETRORIRON', 'レトロリロン', 'ワンタイムエピローグ', '純片假名 + J-Pop:採用'],
    ['Haru Dorobou', 'Yorushika', 'Yorushika', 'Haru Dorobou', 'カラオケ 翻唱整筆丟掉'],
  ]) {
    const st = await waitResolved(title, artist);
    check(st && st.artist === wantArtist && st.title === wantTitle,
      `歌手還原 / ${label}`, st && `${st.artist} - ${st.title}`);
  }
  global.fetch = savedFetch;

  // 6. 查詢失敗是暫時的,冷卻後要能重試。
  //    失敗與「查過了,確定不用還原」如果混為一談,一次 3 秒逾時就會讓那首歌在整個
  //    process 生命週期都不再嘗試還原,期間抓的歌詞用未還原的名字寫進 cache 與
  //    listening_history,永久分裂成兩筆 (實測 TUYU / ツユ 各存了四首同樣的歌)。
    //    ITUNES_RETRY_MS 在檔頭縮短成 400ms,不必真的等 60 秒。
  const realFetch = global.fetch;
  let attempts = 0;
  global.fetch = (url, opts) => {
    if (String(url).includes('itunes.apple.com')) {
      attempts++;
      return Promise.reject(new Error('模擬逾時'));
    }
    return realFetch(url, opts);
  };

  const failedOnce = await waitResolved('Some Translated Title', 'SomeArtist');
  check(!!failedOnce, '查詢失敗:resolving 仍然會變回 false (不能讓使用者一直等)');
  check(failedOnce && failedOnce.title === 'Some Translated Title',
    '查詢失敗:先用原名放歌詞', failedOnce && failedOnce.title);
  const afterFirst = attempts;
  check(afterFirst >= 1, '查詢失敗:確實有打過 iTunes', `${afterFirst} 次`);

  // 冷卻期間不能一直重打 —— 媒體監控每 0.1 秒就更新一次,不擋就是請求風暴
  update('Some Translated Title', 'SomeArtist');
  update('Some Translated Title', 'SomeArtist');
  check(attempts === afterFirst, '冷卻期間不重試 (避免請求風暴)', `仍然 ${attempts} 次`);

  // 冷卻過後要能再試一次,而不是把一次逾時當成永久結論
  await new Promise((r) => setTimeout(r, 500));
  update('Some Translated Title', 'SomeArtist');
  check(attempts > afterFirst, '冷卻過後會重試', `${afterFirst} -> ${attempts} 次`);

  global.fetch = realFetch;

  console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
})();
