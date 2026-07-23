/**
 * Electron 桌面殼:一鍵帶起整個系統
 * 1. 打包模式下把使用者資料 (DB/settings) 指向 %APPDATA%/Kanaric,
 *    並把 Python 工具指向安裝目錄的 resources/。
 * 2. 在主進程內直接載入 server.js (Express + WebSocket + Python 子進程)。
 * 3. 開儀表板視窗 + 系統匣圖示 + 靈動島視窗 (island.js),結束時收乾淨所有子進程。
 */
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

// app.quit() 是非同步的:光呼叫它,後面的 whenReady 還是會跑,第二個實例會先起一份 server
// 與 media monitor 佔用另一個 port,再自己崩掉。要 app.exit() 立刻收工。
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
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

  // 首次啟動:生成預設 settings.json
  if (!fs.existsSync(process.env.LYRICS_SETTINGS_PATH)) {
    fs.writeFileSync(process.env.LYRICS_SETTINGS_PATH, JSON.stringify({
      font_size: 32, sync_offset: 0, show_furigana: true, katakana_ruby: false,
      autoscroll: true, auto_lyrics_options: false,
      'hk-advance': 'ArrowLeft', 'hk-delay': 'ArrowRight',
      'hk-plain-prev': 'ArrowUp', 'hk-plain-next': 'ArrowDown',
      'hk-ab-loop': 'A', 'hk-ruby-edit': 'E', 'hk-lyrics-opt': 'L', 'hk-reload': 'R',
      'hk-island': 'D', 'hk-fullscreen': 'F',
      dynamic_island: false, island_lines: 2, island_opacity: 1, island_locked: false,
      media_source: 'auto'
    }, null, 4), 'utf8');
  }
}
// 開發模式 (npm run app) 不覆寫任何路徑,沿用專案根目錄的 DB 與 settings.json

let mainWindow = null;
let splashWindow = null;
let tray = null;
let quitting = false;
let updatePending = null;   // 已下載完、等下次結束才安裝的新版號

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
    minWidth: 800,  // = Spotify 桌面最小外框;窄於 1100 stats grid 走 @media 塌單欄
    minHeight: 600,
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

  // 右上角 X = 直接結束整個 app (不做縮系統匣的兩段式關閉)。app.quit() 會觸發 before-quit
  // 的收尾 (kill media monitor、關靈動島)。quitting 旗標防止 quit 過程中重入。
  mainWindow.on('close', () => {
    if (!quitting) app.quit();
  });
}

// 靈動島是這個 app 的一個視窗 (web-app/island.js),不再是獨立的 C# 進程。
// server.js 的 /api/island/* 只轉呼叫這三個 global,所以網頁按鈕與系統匣走同一條路。
function wireIsland() {
  const island = require('./island.js');
  global.openIsland = () => island.openIsland(PORT);
  global.closeIsland = island.closeIsland;
  global.isIslandOpen = island.isIslandOpen;
  global.resetIslandPosition = island.resetIslandPosition;
}

// 系統匣選單會長出「安裝更新」那一項,所以要能重建,不能只在啟動時組一次
function refreshTrayMenu() {
  if (!tray) return;
  const items = [
    { label: '開啟儀表板', click: showWindow },
    { label: '顯示/隱藏靈動島', click: () => (global.isIslandOpen() ? global.closeIsland() : global.openIsland()) },
  ];
  if (updatePending) {
    items.push({ type: 'separator' });
    items.push({ label: `安裝更新 v${updatePending} 並重新啟動`, click: () => global.quitAndInstallUpdate && global.quitAndInstallUpdate() });
  }
  items.push({ type: 'separator' });
  items.push({ label: '結束', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
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

  wireIsland();

  tray = new Tray(TRAY_ICON);
  tray.setToolTip('Kanaric');
  refreshTrayMenu();
  tray.on('double-click', showWindow);

  createWindow();

  let settings = {};
  try {
    const settingsPath = process.env.LYRICS_SETTINGS_PATH || path.join(DEV_ROOT, 'settings.json');
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {}
  
  if (settings.dynamic_island) {
    global.openIsland();
  }

  setupAutoUpdate();
});

// 還原備份會關掉 server 的 db 連線,之後這支進程只能重開。掛成 global 讓 /api/restore 呼叫,
// 純 node 模式沒有主進程 → 那支路由自己會改成請使用者手動重啟。
global.relaunchApp = () => {
  quitting = true;
  app.relaunch();
  app.exit(0);
};

// 自動更新。網頁那支 /api/update-check 保留不動 —— 它是 `npm start` 純 node 模式唯一的
// 更新提示管道,而且只會叫使用者自己去下載。打包版由這裡接手真的把新版裝起來。
// 未簽章不影響下載與安裝,只是安裝那一刻 SmartScreen 會再出現一次,屬預期。
function setupAutoUpdate() {
  if (!app.isPackaged) return;   // dev 模式沒有 latest.yml 可比,跑了只會噴錯
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }

  // 網頁端沒有 WebSocket client (只輪詢 /api/current-media),所以狀態掛在 global 上
  // 讓 /api/update-check 一起回報,不為了一則通知在網頁多開一條連線
  global.autoUpdateEnabled = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => console.error('自動更新失敗:', e && e.message));
  autoUpdater.on('update-downloaded', (info) => {
    // 不強制立刻重開打斷正在聽歌的人:預設下次結束 app 時自動裝,想現在裝就從系統匣或網頁點
    updatePending = (info && info.version) || null;
    global.updateReadyVersion = updatePending;
    refreshTrayMenu();
  });

  // 只在啟動時查一次。app 常駐系統匣不代表要一直輪詢 —— 更新晚一次開機才知道完全可接受
  autoUpdater.checkForUpdates().catch(() => {});

  global.quitAndInstallUpdate = () => {
    quitting = true;
    autoUpdater.quitAndInstall();
  };
}

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
  // 靈動島現在是本 app 的視窗,跟著 app 一起結束,不需要額外收尾
});
