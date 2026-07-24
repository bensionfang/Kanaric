/**
 * 「標記無歌詞」的回歸測試。
 *
 *   node test_no_lyrics.js
 *
 * 守的事:標記後 /api/lyrics/fetch 直接回空、不會再從快取吐出被標記那首的歌詞;
 * 取消標記後恢復正常;標記時會把現有(錯的)快取清掉。
 */
const PORT = process.env.PORT || '5761';
process.env.PORT = PORT;

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-nolyr-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.DATA_DIR = TMP;
process.env.LYRICS_SETTINGS_PATH = path.join(TMP, 'settings.json');
require('./web-app/server.js');

const BASE = `http://localhost:${PORT}`;
let failed = 0;
const check = (ok, label, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ': ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = '沒歌詞的冷門歌', A = '某歌手';
const save = () => fetch(`${BASE}/api/lyrics/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: T, artist: A, lyrics: '[00:01.00]這是撞名抓到的錯歌詞' }) }).then(r => r.json());
const mark = (marked) => fetch(`${BASE}/api/lyrics/no-lyrics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: T, artist: A, marked }) }).then(r => r.json());
const state = () => fetch(`${BASE}/api/lyrics/no-lyrics?` + new URLSearchParams({ title: T, artist: A })).then(r => r.json());
const fetchLyrics = () => fetch(`${BASE}/api/lyrics/fetch?` + new URLSearchParams({ title: T, artist: A })).then(r => r.json());

async function run() {
  for (let i = 0; i < 50; i++) { try { await state(); break; } catch (e) { await sleep(100); } }

  await save();
  let f = await fetchLyrics();
  check(!!f.lyrics && f.source === 'cache', '未標記:快取歌詞照常吐出', JSON.stringify(f).slice(0, 60));

  const m = await mark(true);
  check(m.success && m.marked, '標記成功');
  check((await state()).marked === true, '狀態查詢回報已標記');

  f = await fetchLyrics();
  check(f.lyrics === '' && f.source === 'no_lyrics', '標記後 fetch 回空、不再吐錯歌詞', JSON.stringify(f));

  // 標記時應已清掉快取;即使再 save 一次(模擬又被寫回),fetch 仍被擋
  await save();
  f = await fetchLyrics();
  check(f.lyrics === '' && f.source === 'no_lyrics', '標記狀態下 fetch 一律回空(擋在最前)', JSON.stringify(f));

  await mark(false);
  check((await state()).marked === false, '取消標記後狀態回復');
  f = await fetchLyrics();
  check(!!f.lyrics && f.source === 'cache', '取消後又能吐出快取歌詞');

  const bad = await fetch(`${BASE}/api/lyrics/no-lyrics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: T }) });
  check(bad.status === 400, '缺參數回 400');

  console.log(failed ? `\n${failed} FAILED` : '\nall pass');
  process.exit(failed ? 1 : 0);
}
run();
