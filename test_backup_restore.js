/**
 * 備份 / 還原的回歸測試。
 *
 *   node test_backup_restore.js
 *
 * 守三件事:
 *  1. 備份真的帶得走「不可重建」的那一類資料 (word_corrections 這種使用者親手打的東西)。
 *     備份存在的唯一理由就是它們;漏了等於備份沒用。
 *  2. 還原之前會先驗證檔案。隨便一個 .db (或根本不是 db) 都不該蓋掉現有資料 ——
 *     還原是不可逆的,守門壞掉會直接毀掉使用者的資料。
 *  3. settings.json 跟著備份走,而 secrets.json (LLM API key) 絕對不跟。
 *     備份檔會被隨手複製、傳送,key 混進去就是外洩。
 *
 * 還原成功那條路徑會 db.close() 並換掉 DB 檔,之後這支 server 就不能用了,所以
 * 「成功還原」放在最後一項驗。
 */
const PORT = process.env.PORT || '5734';
process.env.PORT = PORT;

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-backup-'));
const SETTINGS = path.join(TMP, 'settings.json');
const DB = path.join(TMP, 'test.db');
process.env.DB_PATH = DB;
process.env.DATA_DIR = TMP;
process.env.LYRICS_SETTINGS_PATH = SETTINGS;
fs.writeFileSync(SETTINGS, JSON.stringify({ font_size: 41, track_history: true }), 'utf8');

const sqlite3 = require('./web-app/node_modules/sqlite3');
require('./web-app/server.js');

const BASE = `http://localhost:${PORT}`;
let failed = 0;
const check = (ok, label, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + '/api/settings'); return true; } catch { await sleep(200); }
  }
  return false;
}

// 直接開一條連線驗真實內容,不透過 server 的 API —— API 壞掉也要看得出來
const openRO = (file) => new Promise((resolve, reject) => {
  const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => (e ? reject(e) : resolve(d)));
});
const get = (d, sql) => new Promise((resolve, reject) =>
  d.get(sql, [], (e, row) => (e ? reject(e) : resolve(row))));
const run = (d, sql) => new Promise((resolve, reject) =>
  d.run(sql, [], (e) => (e ? reject(e) : resolve())));

async function waitForTables() {
  for (let i = 0; i < 100; i++) {
    try {
      const d = await openRO(DB);
      await get(d, 'SELECT COUNT(*) AS n FROM word_corrections');
      d.close();
      return true;
    } catch { await sleep(100); }
  }
  return false;
}

async function run_() {
  // ── 準備:塞一筆「不可重建」的資料 + 一筆可重建的 ──
  const w = new sqlite3.Database(DB);
  await run(w, `INSERT OR REPLACE INTO word_corrections VALUES ('テスト','曲','私','わたし')`);
  await run(w, `INSERT OR REPLACE INTO cache VALUES ('テスト','曲','[00:01.00]歌詞')`);
  await new Promise((r) => w.close(r));

  // ── 1. 備份 ──
  const backupPath = path.join(TMP, 'backup.db');
  const res = await fetch(BASE + '/api/backup');
  check(res.ok, '備份端點回 200', String(res.status));
  const disp = res.headers.get('content-disposition') || '';
  check(/Kanaric-backup-\d{4}-\d{2}-\d{2}\.db/.test(disp), '備份檔名帶日期', disp);
  fs.writeFileSync(backupPath, Buffer.from(await res.arrayBuffer()));
  check(fs.statSync(backupPath).size > 0, '備份檔不是空的');

  const b = await openRO(backupPath);
  const wc = await get(b, `SELECT hira FROM word_corrections WHERE word='私'`);
  check(wc && wc.hira === 'わたし', '備份帶走了手改的假名 (不可重建的資料)', wc && wc.hira);
  const cached = await get(b, `SELECT COUNT(*) AS n FROM cache`);
  check(cached.n === 1, '備份帶走了歌詞快取', String(cached.n));
  const metaApp = await get(b, `SELECT value FROM _backup_meta WHERE key='app'`);
  check(metaApp && metaApp.value === 'Kanaric', '備份帶了識別用的 meta');
  const metaSettings = await get(b, `SELECT value FROM _backup_meta WHERE key='settings'`);
  check(metaSettings && JSON.parse(metaSettings.value).font_size === 41, 'settings.json 有一起進備份');
  check(!/api|key|secret/i.test(metaSettings.value), '備份的 settings 裡沒有 key 欄位');
  b.close();

  // secrets.json 是獨立檔案,備份是單一 .db —— 結構上就帶不到,這裡確認它真的沒被塞進去
  const raw = fs.readFileSync(backupPath, 'utf8').replace(/\0/g, '');
  check(!raw.includes('llm_api_key'), 'API key 沒有出現在備份檔內容裡');

  // ── 2. 還原的守門 ──
  const post = (body) => fetch(BASE + '/api/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body
  });

  let r = await post(Buffer.from('this is not a database at all'));
  check(r.status === 400, '亂七八糟的檔案被拒 (400)', String(r.status));

  // 合法 sqlite 檔但不是 Kanaric 備份 —— 這條最容易被漏掉,而它會直接蓋掉使用者資料
  const stranger = path.join(TMP, 'stranger.db');
  const s = new sqlite3.Database(stranger);
  await run(s, 'CREATE TABLE hello (x TEXT)');
  await new Promise((rr) => s.close(rr));
  r = await post(fs.readFileSync(stranger));
  check(r.status === 400, '別的 sqlite 資料庫被拒 (400)', String(r.status));

  r = await post(Buffer.alloc(0));
  check(r.status === 400, '空 body 被拒 (400)', String(r.status));

  // 被拒的請求不准動到現有資料
  const d2 = await openRO(DB);
  const still = await get(d2, `SELECT COUNT(*) AS n FROM word_corrections`);
  d2.close();
  check(still.n === 1, '被拒的還原沒有動到現有資料', String(still.n));

  // ── 3. 真的還原 (放最後:成功之後 db 連線就關了) ──
  // 先把現有資料改掉,還原後應該變回備份當下的樣子
  const w2 = new sqlite3.Database(DB);
  await run(w2, `DELETE FROM word_corrections`);
  await new Promise((rr) => w2.close(rr));
  fs.writeFileSync(SETTINGS, JSON.stringify({ font_size: 99 }), 'utf8');

  r = await post(fs.readFileSync(backupPath));
  const body = await r.json();
  check(r.ok && body.success, '還原成功', JSON.stringify(body));
  check(!!body.rescue, '還原前有留下救援檔', body.rescue);
  check(fs.existsSync(path.join(TMP, body.rescue || 'x')), '救援檔真的存在');

  await sleep(300);
  const d3 = await openRO(DB);
  const back = await get(d3, `SELECT hira FROM word_corrections WHERE word='私'`);
  d3.close();
  check(back && back.hira === 'わたし', '還原把手改的假名帶回來了', back && back.hira);
  const restoredSettings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  check(restoredSettings.font_size === 41, '還原也把 settings.json 還原了', String(restoredSettings.font_size));
}

(async () => {
  try {
    if (!(await waitForServer())) throw new Error('server 沒有起來');
    if (!(await waitForTables())) throw new Error('資料表沒有建起來');
    await run_();
  } catch (e) {
    console.error('測試無法執行:', e.message);
    failed++;
  }
  console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
})();
