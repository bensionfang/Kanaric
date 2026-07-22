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

  console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
})();
