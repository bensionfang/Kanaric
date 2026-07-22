/**
 * 同源守門的回歸測試 (server.js 的 middleware)。
 *
 *   node test_origin_guard.js
 *
 * 自己帶起一份 server (獨立 port + 暫存 DB/settings),測完關掉。
 * 這道守門擋的是:使用者開著 Kanaric 時瀏覽任一網頁,那個網頁把 llm_base_url 改成
 * 攻擊者的位址、再觸發 /api/llm-models,BYOK 的 API key 就送出去了。綁 127.0.0.1
 * 擋不住這件事,所以守門壞掉等於 key 外洩,值得留一個測試。
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
  ['惡意網站 <script src> (只有 SFS)',     '/api/llm-models', { 'Sec-Fetch-Site': 'cross-site' },                403],
  ['同機另一個 port 的頁面 (same-site)',   '/api/llm-models', { 'Sec-Fetch-Site': 'same-site' },                 403],
  // 從別的頁面點連結進來 = 跨站的頂層導覽。擋掉只會讓使用者看到一行 JSON 錯誤,
  // 而放行不開洞:跨站 form POST 的 dest 也是 document,但方法是 POST (下一條)
  ['別的網站點連結進來 (頂層導覽 GET)',    '/',               { 'Sec-Fetch-Site': 'cross-site',
                                                               'Sec-Fetch-Dest': 'document' },                   200],
  // 內嵌不是導覽:惡意頁面把後台包進 iframe 一樣要擋掉
  ['惡意網站 iframe 內嵌',                 '/',               { 'Sec-Fetch-Site': 'cross-site',
                                                               'Sec-Fetch-Dest': 'iframe' },                     403],
];

const EVIL = 'https://evil.example/v1';

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

  // 完整攻擊鏈第一步:跨站竄改 llm_base_url。JSON 版本 (會觸發 preflight) 與
  // form 版本 (simple request,不觸發 preflight —— 光拿掉 cors() 擋不住這個) 都要試。
  for (const [label, contentType, body] of [
    ['JSON', 'application/json', JSON.stringify({ llm_base_url: EVIL })],
    ['form (無 preflight)', 'application/x-www-form-urlencoded', `llm_base_url=${EVIL}`],
  ]) {
    const r = await fetch(BASE + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': contentType, Origin: 'https://evil.example' },
      body,
    });
    check(r.status === 403, `攻擊鏈:跨站 POST 竄改 llm_base_url (${label})`, `${r.status} (expected 403)`);
  }

  // 放行頂層導覽的代價要釘住:跨站 <form> 送出去的 dest 也是 document,只有方法不同
  const formNav = await fetch(BASE + '/api/settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document',
    },
    body: `llm_base_url=${EVIL}`,
  });
  check(formNav.status === 403, '跨站 form 導覽 POST 仍被擋', `${formNav.status} (expected 403)`);

  const settings = await (await fetch(BASE + '/api/settings')).json();
  check(settings.llm_base_url !== EVIL, 'settings.json 未被竄改', JSON.stringify(settings.llm_base_url));

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

  // WebSocket 的 upgrade 不經過 express middleware,要另外擋 (否則惡意網頁能收播放狀態廣播)
  const WebSocket = require('./web-app/node_modules/ws');
  for (const [label, origin, wantOpen] of [
    ['靈動島 (無 Origin)', undefined, true],
    ['後台自己 (同源)', BASE, true],
    ['惡意網站', 'https://evil.example', false],
  ]) {
    const opened = await new Promise((resolve) => {
      const ws = new WebSocket(BASE.replace('http', 'ws'), origin ? { origin } : {});
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    });
    check(opened === wantOpen, `WebSocket ${label}`, opened ? '連上' : '被拒');
  }

  return failed;
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, 'web-app'),
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
