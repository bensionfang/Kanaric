/**
 * Electron 桌面殼:一鍵帶起整個系統
 * 1. 打包模式下把使用者資料 (DB/settings) 指向 %APPDATA%/Kanaric,
 *    並把 Python 工具與 C# 靈動島指向安裝目錄的 resources/。
 * 2. 在主進程內直接載入 server.js (Express + WebSocket + Python 子進程)。
 * 3. 開儀表板視窗 + 系統匣圖示,自動啟動靈動島,結束時收乾淨所有子進程。
 */
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let PORT = Number(process.env.PORT) || 5720;
const DEV_ROOT = path.join(__dirname, '..');

// 找可用 port:優先用偏好值 (5720),被占用就讓 OS 指派一個空閒的,
// 這樣別人電腦上就算 5720 被別的程式占著也能正常開起來。
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      // ponytail: close→listen 之間有極小 TOCTOU 窗口,單機桌面 app 可忽略
      const s2 = net.createServer();
      s2.listen(0, '127.0.0.1', () => {
        const p = s2.address().port;
        s2.close(() => resolve(p));
      });
    });
    srv.listen(preferred, '127.0.0.1', () => srv.close(() => resolve(preferred)));
  });
}

// --- 路徑注入 (必須在 require('./server.js') 之前) ---
if (app.isPackaged) {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  process.env.DB_PATH = path.join(dataDir, 'lyrics_data.db');
  process.env.LYRICS_DB_PATH = process.env.DB_PATH; // Python 端 (db.py)
  process.env.LYRICS_SETTINGS_PATH = path.join(dataDir, 'settings.json'); // Python 端 (search_fallback.py)
  process.env.PYTOOLS_EXE = path.join(process.resourcesPath, 'pytools', 'pytools.exe');
  process.env.ISLAND_EXE = path.join(process.resourcesPath, 'island', 'DynamicIslandUI.exe');

  // 首次啟動:生成預設 settings.json
  if (!fs.existsSync(process.env.LYRICS_SETTINGS_PATH)) {
    fs.writeFileSync(process.env.LYRICS_SETTINGS_PATH, JSON.stringify({
      font_size: 32, font_family: 'Noto Sans JP', custom_css_path: '', mini_mode: false,
      dynamic_color: true, sync_offset: 0, pin_window: true, show_furigana: true,
      hotkeys_enable: false, autoscroll: true, auto_lyrics_options: false,
      'hk-advance': 'ArrowLeft', 'hk-delay': 'ArrowRight',
      'hk-plain-prev': 'ArrowUp', 'hk-plain-next': 'ArrowDown',
      'hk-ab-loop': 'A', 'hk-ruby-edit': 'E', 'hk-lyrics-opt': 'L', 'hk-reload': 'R',
      'hk-island': 'D', 'hk-fullscreen': 'F',
      dynamic_island: false, island_lines: 2, media_source: 'auto'
    }, null, 4), 'utf8');
  }
}
// 開發模式 (npm run app) 不覆寫任何路徑,沿用專案根目錄的 DB 與 settings.json

let mainWindow = null;
let splashWindow = null;
let tray = null;
let islandProc = null;
let quitting = false;

const TRAY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgoCaoifn/nxhMfQMIaUAHGAYNHQNwhsUwNQAbINoAXIAiF1AlRdIuL1ACAHGrJsks7N9DAAAAAElFTkSuQmCC'
);

// 啟動畫面:server + Python monitor 起來要幾秒,這段空窗期本來就會乾等,
// 拿來放 icon 動畫。圖直接吃 TRAY_ICON,換 icon 檔時這裡自動跟著換。
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 260,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false
  });
  const html = `
    <style>
      html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
      body {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 18px; font-family: 'Outfit', 'Segoe UI', sans-serif; user-select: none;
      }
      img {
        width: 96px; height: 96px; image-rendering: auto;
        animation: pulse 1.6s ease-in-out infinite;
        filter: drop-shadow(0 6px 20px rgba(29, 185, 84, 0.35));
      }
      span {
        color: #fff; font-size: 20px; font-weight: 600; letter-spacing: 0.14em;
        opacity: 0; animation: fade 0.9s ease-out 0.25s forwards;
      }
      @keyframes pulse {
        0%, 100% { transform: scale(1); opacity: 0.85; }
        50%      { transform: scale(1.08); opacity: 1; }
      }
      @keyframes fade { to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        img { animation: none; }
        span { animation: none; opacity: 1; }
      }
    </style>
    <img src="${TRAY_ICON.toDataURL()}">
    <span>KANARIC</span>`;
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splashWindow.once('ready-to-show', () => splashWindow && splashWindow.show());
}

function closeSplash() {
  if (splashWindow) {
    splashWindow.destroy();
    splashWindow = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    autoHideMenuBar: true,
    icon: TRAY_ICON,
    show: false, // 等頁面畫好才顯示,啟動畫面在這之前頂著
    // 無標題列,系統按鈕直接疊在頁面上 (height 要跟 CSS .win-drag 一致)
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 36 }
  });
  mainWindow.loadURL(`http://localhost:${PORT}`);

  // did-fail-load 重試時 ready-to-show 不會再觸發,所以用 did-finish-load;
  // 保險起見再壓一個 8 秒 timeout,server 真的起不來也不會卡在啟動畫面
  const reveal = () => {
    if (!mainWindow || mainWindow.isVisible()) return;
    closeSplash();
    mainWindow.show();
  };
  mainWindow.webContents.on('did-finish-load', reveal);
  setTimeout(reveal, 8000);

  // server.listen 是非同步的,若視窗搶先載入失敗就稍後重試
  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => mainWindow && mainWindow.loadURL(`http://localhost:${PORT}`), 500);
  });

  // 關視窗 = 縮到系統匣,不結束 app
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function launchIsland() {
  const exe = process.env.ISLAND_EXE ||
    path.join(DEV_ROOT, 'DynamicIslandUI', 'bin', 'Release', 'net8.0-windows', 'DynamicIslandUI.exe');
  if (!fs.existsSync(exe)) {
    console.warn('DynamicIslandUI.exe not found, skip:', exe);
    return;
  }
  // 把實際使用的 port 傳給靈動島 (它用來連 WebSocket 與呼叫 API)
  islandProc = spawn(exe, [String(PORT)], { cwd: path.dirname(exe), stdio: 'ignore' });
  // 寫入 app.pid,讓網頁上的「啟動/關閉靈動島」按鈕能感知並控制這個進程
  try {
    fs.writeFileSync(path.join(process.env.DATA_DIR || DEV_ROOT, 'app.pid'), String(islandProc.pid));
  } catch (e) {}
  islandProc.on('exit', () => { islandProc = null; });
}

function showWindow() {
  if (mainWindow) {
    closeSplash(); // 啟動途中就點系統匣的話,別讓啟動畫面壓在視窗上面
    mainWindow.show();
    mainWindow.focus();
  }
}

app.whenReady().then(async () => {
  createSplash(); // 在 server 起來前就先亮出來

  // 先確定實際 port,再帶起 server (server.js 讀 process.env.PORT)
  PORT = await findFreePort(PORT);
  process.env.PORT = String(PORT);
  require('./server.js'); // 帶起 Express + WebSocket + media monitor

  tray = new Tray(TRAY_ICON);
  tray.setToolTip('Kanaric');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟儀表板', click: showWindow },
    { label: '重啟靈動島', click: () => { if (islandProc) islandProc.kill(); setTimeout(launchIsland, 500); } },
    { type: 'separator' },
    { label: '結束', click: () => app.quit() }
  ]));
  tray.on('double-click', showWindow);

  createWindow();

  let settings = {};
  try {
    const settingsPath = process.env.LYRICS_SETTINGS_PATH || path.join(DEV_ROOT, 'settings.json');
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {}
  
  if (settings.dynamic_island) {
    launchIsland();
  }
});

app.on('second-instance', showWindow);

// 有系統匣,所有視窗關閉時不結束
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  closeSplash();
  global.isShuttingDown = true; // 告訴 server.js 不要重生 media monitor
  if (global.monitorProcess) {
    try { global.monitorProcess.kill(); } catch (e) {}
  }
  if (islandProc) {
    try { islandProc.kill(); } catch (e) {}
  }
  // 網頁按鈕開的靈動島是 detached 進程,electron 沒有 handle,只能靠 app.pid 收掉
  const pidFile = path.join(process.env.DATA_DIR || DEV_ROOT, 'app.pid');
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid) process.kill(pid);
  } catch (e) {}
  try { fs.unlinkSync(pidFile); } catch (e) {}
});
