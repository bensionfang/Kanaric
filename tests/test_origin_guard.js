/**
 * 同源守門的回歸測試 (server.js 的 middleware)。
 *
 *   node test_origin_guard.js
 *
 * 自己帶起一份 server (獨立 port + 暫存 DB/settings),測完關掉。
 * 這道守門擋的是:使用者開著 Kanaric 時瀏覽任一網頁,那個網頁就能打這裡的 API ——
 * 跨站 POST /api/settings 改掉設定、/api/db-clear 砍掉聆聽紀錄,都不需要使用者做任何事。
 * 綁 127.0.0.1 擋不住這件事 (那擋的是別台機器),所以守門壞掉等於資料任人改,值得留測試。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5731;
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-test-'));

// [名稱, 路徑, headers, 預期狀態碼]
const CASES = [
  ['島 (非瀏覽器,兩個 header 都沒有)',    '/api/settings',   {},                                                200],
  ['後台自己 (同源 fetch)',               '/api/settings',   { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' }, 200],
  ['網址列直接開 (Sec-Fetch-Site: none)',  '/api/settings',   { 'Sec-Fetch-Site': 'none' },                      200],
  ['惡意網站 fetch (Origin 是別人)',       '/api/settings',   { Origin: 'https://evil.example' },                403],
  ['惡意網站 <script src> (只有 SFS)',     '/api/db-usage', { 'Sec-Fetch-Site': 'cross-site' },                403],
  ['同機另一個 port 的頁面 (same-site)',   '/api/db-usage', { 'Sec-Fetch-Site': 'same-site' },                 403],
  // 從別的頁面點連結進來 = 跨站的頂層導覽。擋掉只會讓使用者看到一行 JSON 錯誤,
  // 而放行不開洞:跨站 form POST 的 dest 也是 document,但方法是 POST (下一條)
  ['別的網站點連結進來 (頂層導覽 GET)',    '/',               { 'Sec-Fetch-Site': 'cross-site',
                                                               'Sec-Fetch-Dest': 'document' },                   200],
  // 內嵌不是導覽:惡意頁面把後台包進 iframe 一樣要擋掉
  ['惡意網站 iframe 內嵌',                 '/',               { 'Sec-Fetch-Site': 'cross-site',
                                                               'Sec-Fetch-Dest': 'iframe' },                     403],
];

const EVIL = 'https://evil.example';

async function waitForServer(deadlineMs = 20000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      await fetch(BASE + '/api/settings');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

async function run() {
  let failed = 0;
  const check = (ok, label, detail) => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  };

  for (const [name, route, headers, want] of CASES) {
    const r = await fetch(BASE + route, { headers });
    check(r.status === want, name, `${r.status} (expected ${want})`);
  }

  // 完整攻擊鏈第一步:跨站竄改設定。JSON 版本 (會觸發 preflight) 與
  // form 版本 (simple request,不觸發 preflight —— 光拿掉 cors() 擋不住這個) 都要試。
  for (const [label, contentType, body] of [
    ['JSON', 'application/json', JSON.stringify({ mobile_origin: EVIL })],
    ['form (無 preflight)', 'application/x-www-form-urlencoded', `mobile_origin=${EVIL}`],
  ]) {
    const r = await fetch(BASE + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': contentType, Origin: 'https://evil.example' },
      body,
    });
    check(r.status === 403, `攻擊鏈:跨站 POST 竄改設定 (${label})`, `${r.status} (expected 403)`);
  }

  // 放行頂層導覽的代價要釘住:跨站 <form> 送出去的 dest 也是 document,只有方法不同
  const formNav = await fetch(BASE + '/api/settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document',
    },
    body: `mobile_origin=${EVIL}`,
  });
  check(formNav.status === 403, '跨站 form 導覽 POST 仍被擋', `${formNav.status} (expected 403)`);

  const settings = await (await fetch(BASE + '/api/settings')).json();
  check(settings.mobile_origin !== EVIL, 'settings.json 未被竄改', JSON.stringify(settings.mobile_origin));

  // /api/db-clear 會刪資料且不可復原 —— 跨站呼叫等於任一網頁都能砍掉使用者的聆聽紀錄。
  // form 版本同樣是 simple request,不觸發 preflight。
  for (const [label, contentType, body] of [
    ['JSON', 'application/json', JSON.stringify({ target: 'history' })],
    ['form (無 preflight)', 'application/x-www-form-urlencoded', 'target=history'],
  ]) {
    const r = await fetch(BASE + '/api/db-clear', {
      method: 'POST',
      headers: { 'Content-Type': contentType, Origin: 'https://evil.example' },
      body,
    });
    check(r.status === 403, `跨站 POST 清除資料庫 (${label})`, `${r.status} (expected 403)`);
  }

  // 外部來源一律由設定 mobile_origin 明確指定 (預設空 = 關著)。
  // 沒設定時一個外部來源都不放行;設定了也只放行那一個,不是「Origin 等於 Host 就放行」
  // (那樣攻擊者把自己網域指到 127.0.0.1 就能繞過 —— DNS rebinding)。
  const MOBILE = 'https://mobile.example';
  const setMobileOrigin = (v) => fetch(BASE + '/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },   // 無 Origin = 非瀏覽器客戶端,放行
    body: JSON.stringify({ mobile_origin: v }),
  });

  const beforeSet = await fetch(BASE + '/api/settings', { headers: { Origin: MOBILE } });
  check(beforeSet.status === 403, '沒設定 mobile_origin 時外部來源被擋', `${beforeSet.status} (expected 403)`);

  // 使用者多半整條網址貼進來,要正規化成 scheme://host 才對得上瀏覽器送的 Origin
  await setMobileOrigin(`${MOBILE}/mobile/`);
  const afterSet = await fetch(BASE + '/api/settings', {
    headers: { Origin: MOBILE, 'Sec-Fetch-Site': 'same-origin' },
  });
  check(afterSet.status === 200, '設定後行動版來源放行 (帶路徑也要正規化)', `${afterSet.status} (expected 200)`);

  const otherOrigin = await fetch(BASE + '/api/settings', { headers: { Origin: 'https://evil.example' } });
  check(otherOrigin.status === 403, '設定 mobile_origin 後其他外部來源仍被擋', `${otherOrigin.status} (expected 403)`);

  // WebSocket 的 upgrade 不經過 express middleware,要另外擋 (否則惡意網頁能收播放狀態廣播)
  const WebSocket = require('ws');
  for (const [label, origin, wantOpen] of [
    ['靈動島 (無 Origin)', undefined, true],
    ['後台自己 (同源)', BASE, true],
    ['惡意網站', 'https://evil.example', false],
    ['行動版 (mobile_origin)', MOBILE, true],
  ]) {
    const opened = await new Promise((resolve) => {
      const ws = new WebSocket(BASE.replace('http', 'ws'), origin ? { origin } : {});
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    });
    check(opened === wantOpen, `WebSocket ${label}`, opened ? '連上' : '被拒');
  }

  // 清空要能即時關掉,不必重開 server (守門是每個請求現查那個變數)
  await setMobileOrigin('');
  const afterClear = await fetch(BASE + '/api/settings', { headers: { Origin: MOBILE } });
  check(afterClear.status === 403, '清掉 mobile_origin 後立刻失效', `${afterClear.status} (expected 403)`);

  return failed;
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', 'web-app'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(TMP, 'test.db'),
      DATA_DIR: TMP,
      LYRICS_SETTINGS_PATH: path.join(TMP, 'settings.json'),
    },
    stdio: 'ignore',
  });

  try {
    if (!(await waitForServer())) throw new Error('server 沒有起來');
    const failed = await run();
    console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('測試無法執行:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
    // 剛砍掉的 server 可能還握著 sqlite 檔案 handle,刪不掉就算了 —— 那是系統 temp
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
  }
})();
