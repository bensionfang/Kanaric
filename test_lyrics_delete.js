/**
 * 單首歌詞刪除 (/api/lyrics/delete) 的回歸測試。
 *
 *   node test_lyrics_delete.js
 *
 * 守兩件事:
 *  1. 刪除只打中指定那一首,別首的快取不受牽連 (WHERE artist+title 有生效)。
 *  2. 冪等:刪不存在的回 deleted:0、不報錯。
 * 全程走 API,不碰 DB schema 時序 —— 用 /api/lyrics/save 建列、/api/songs 驗結果。
 */
const PORT = process.env.PORT || '5741';
process.env.PORT = PORT;

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-del-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.DATA_DIR = TMP;
process.env.LYRICS_SETTINGS_PATH = path.join(TMP, 'settings.json');

require('./web-app/server.js');

const BASE = `http://localhost:${PORT}`;
let failed = 0;
const check = (ok, label, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const save = (title, artist) => fetch(`${BASE}/api/lyrics/save`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title, artist, lyrics: '[00:01.00]test line' })
}).then(r => r.json());

const del = (title, artist) => fetch(`${BASE}/api/lyrics/delete`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title, artist })
}).then(r => r.json());

const songs = () => fetch(`${BASE}/api/songs`).then(r => r.json());
const has = (list, title, artist) => list.some(s => s.title === title && s.artist === artist);

async function run() {
  // 等 server 起來 + 建表
  for (let i = 0; i < 50; i++) {
    try { await songs(); break; } catch (e) { await sleep(100); }
  }

  await save('目標歌', '歌手A');
  await save('無辜歌', '歌手B');
  let list = await songs();
  check(has(list, '目標歌', '歌手A') && has(list, '無辜歌', '歌手B'), '兩首都建好');

  const r1 = await del('目標歌', '歌手A');
  check(r1.success && r1.deleted === 1, '刪目標回 deleted:1', JSON.stringify(r1));

  list = await songs();
  check(!has(list, '目標歌', '歌手A'), '目標歌已消失');
  check(has(list, '無辜歌', '歌手B'), '無辜歌還在 (WHERE 有效)');

  const r2 = await del('目標歌', '歌手A');
  check(r2.success && r2.deleted === 0, '重複刪冪等回 deleted:0', JSON.stringify(r2));

  const r3 = await fetch(`${BASE}/api/lyrics/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '缺歌手' })
  });
  check(r3.status === 400, '缺參數回 400');

  console.log(failed ? `\n${failed} FAILED` : '\nall pass');
  process.exit(failed ? 1 : 0);
}

run();
