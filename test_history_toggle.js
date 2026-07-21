/**
 * 聆聽紀錄開關 (track_history) 與資料清除的回歸測試。
 *
 *   node test_history_toggle.js
 *
 * 守兩件事:
 *  1. 開關關掉就真的不寫 listening_history —— 這是隱私功能,漏寫入等於功能沒生效。
 *     直接呼叫 global.logListen 而不是等 handleMediaUpdate 的 30 秒計時器,測試才跑得動。
 *  2. 清除功能的白名單:word_corrections 這類使用者親手打的資料絕對不能被清掉。
 *     清除是不可逆的,這條界線壞掉會直接毀掉使用者的心血。
 */
const PORT = process.env.PORT || '5733';
process.env.PORT = PORT;

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-history-'));
const SETTINGS = path.join(TMP, 'settings.json');
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.DATA_DIR = TMP;
process.env.LYRICS_SETTINGS_PATH = SETTINGS;

const sqlite3 = require('./web-app/node_modules/sqlite3');
require('./web-app/server.js');

const BASE = `http://localhost:${PORT}`;
let failed = 0;
const check = (ok, label, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};

const setTrackHistory = (v) => fs.writeFileSync(SETTINGS, JSON.stringify({ track_history: v }), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 另開一條唯讀連線,不靠 server 的 API 來驗 —— API 壞掉也要看得出真實筆數
let probe;
const count = (table) => new Promise((resolve, reject) => {
  probe.get(`SELECT COUNT(*) AS n FROM ${table}`, [], (e, row) => (e ? reject(e) : resolve(row.n)));
});

const play = (title) => global.logListen({ artist: 'テスト', title, album: null, duration: 200 });

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + '/api/settings'); return true; } catch { await sleep(200); }
  }
  return false;
}

async function waitForTables() {
  for (let i = 0; i < 100; i++) {
    try { await count('listening_history'); await count('word_corrections'); return true; }
    catch { await sleep(100); }
  }
  return false;
}

async function run() {
  // 1. 預設 (設定檔沒這個鍵) = 會記錄
  fs.writeFileSync(SETTINGS, '{}', 'utf8');
  play('預設就記錄');
  await sleep(300);
  check(await count('listening_history') === 1, '預設 (未設定) 會寫入聆聽紀錄');

  // 2. 關掉 = 不寫
  setTrackHistory(false);
  play('關掉後不該記錄');
  await sleep(300);
  check(await count('listening_history') === 1, '關掉後不再寫入');

  // 3. 開回來 = 又會寫 (確認不是單向鎖死)
  setTrackHistory(true);
  play('開回來要記錄');
  await sleep(300);
  check(await count('listening_history') === 2, '開回來後恢復寫入');

  // 4. 清除聆聽紀錄:歸零,但使用者手動資料必須完好
  await new Promise((r) => probe.run(
    "INSERT OR REPLACE INTO word_corrections VALUES ('テスト', '曲', '私', 'わたし')", r));
  await new Promise((r) => probe.run("INSERT OR REPLACE INTO cache VALUES ('テスト', '曲', '[00:01.00]歌詞')", r));

  let r = await fetch(BASE + '/api/db-clear', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'history' }),
  });
  check(r.ok && await count('listening_history') === 0, '清除聆聽紀錄:歸零');
  check(await count('word_corrections') === 1, '清除聆聽紀錄:使用者手改的假名還在');
  check(await count('cache') === 1, '清除聆聽紀錄:歌詞快取沒被波及');

  // 5. 清除歌詞快取:快取沒了,手動資料仍在
  r = await fetch(BASE + '/api/db-clear', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'lyrics' }),
  });
  check(r.ok && await count('cache') === 0, '清除歌詞快取:快取歸零');
  check(await count('word_corrections') === 1, '清除歌詞快取:使用者手改的假名還在');

  // 6. 不在白名單的 target 一律擋掉,不能被拿來砍任意表
  play('留一筆給下面驗');
  await sleep(300);
  for (const bad of ['word_corrections', 'bogus', '']) {
    const rr = await fetch(BASE + '/api/db-clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: bad }),
    });
    check(rr.status === 400, `非白名單 target 被拒 (${bad || '空字串'})`, String(rr.status));
  }
  check(await count('word_corrections') === 1, '被拒的請求沒有動到任何資料');

  // 7. 用量端點的數字要跟真實筆數一致
  const usage = await (await fetch(BASE + '/api/db-usage')).json();
  check(usage.history.rows === await count('listening_history'), '/api/db-usage 聆聽紀錄筆數正確',
    `${usage.history.rows}`);
  check(usage.manual.rows >= 1, '/api/db-usage 有算到手動修正', `${usage.manual.rows}`);
  check(usage.file > 0, '/api/db-usage 有回報檔案大小', `${usage.file}`);
}

(async () => {
  try {
    if (!(await waitForServer())) throw new Error('server 沒有起來');
    probe = new sqlite3.Database(process.env.DB_PATH);
    // /api/settings 一通不代表建表跑完 —— express 開始 listen 與 db 建表是兩條並行的路。
    // 機器忙的時候第一筆 play() 會撞上 "no such table: listening_history",測試就偶發炸掉。
    if (!(await waitForTables())) throw new Error('資料表沒有建起來');
    await run();
  } catch (e) {
    console.error('測試無法執行:', e.message);
    failed++;
  }
  console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
})();
