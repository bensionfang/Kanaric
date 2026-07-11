/**
 * Electron 桌面殼:一鍵帶起整個系統
 * 1. 打包模式下把使用者資料 (DB/settings) 指向 %APPDATA%/FloatingLyrics,
 *    並把 Python 工具與 C# 靈動島指向安裝目錄的 resources/。
 * 2. 在主進程內直接載入 server.js (Express + WebSocket + Python 子進程)。
 * 3. 開儀表板視窗 + 系統匣圖示,自動啟動靈動島,結束時收乾淨所有子進程。
 */
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const PORT = process.env.PORT || 3000;
const DEV_ROOT = path.join(__dirname, '..');

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
      hotkeys_enable: false, autoscroll: true,
      'hk-advance': 'ArrowLeft', 'hk-delay': 'ArrowRight',
      'hk-plain-prev': 'ArrowUp', 'hk-plain-next': 'ArrowDown',
      dynamic_island: false, island_lines: 2
    }, null, 4), 'utf8');
  }
}
// 開發模式 (npm run app) 不覆寫任何路徑,沿用專案根目錄的 DB 與 settings.json

let mainWindow = null;
let tray = null;
let islandProc = null;
let quitting = false;

const TRAY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgoCaoifn/nxhMfQMIaUAHGAYNHQNwhsUwNQAbINoAXIAiF1AlRdIuL1ACAHGrJsks7N9DAAAAAElFTkSuQmCC'
);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    autoHideMenuBar: true,
    icon: TRAY_ICON
  });
  mainWindow.loadURL(`http://localhost:${PORT}`);

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
  islandProc = spawn(exe, [], { cwd: path.dirname(exe), stdio: 'ignore' });
  // 寫入 app.pid,讓網頁上的「啟動/關閉靈動島」按鈕能感知並控制這個進程
  try {
    fs.writeFileSync(path.join(process.env.DATA_DIR || DEV_ROOT, 'app.pid'), String(islandProc.pid));
  } catch (e) {}
  islandProc.on('exit', () => { islandProc = null; });
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
}

app.whenReady().then(() => {
  require('./server.js'); // 帶起 Express + WebSocket + media monitor

  tray = new Tray(TRAY_ICON);
  tray.setToolTip('Floating Lyrics');
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
  global.isShuttingDown = true; // 告訴 server.js 不要重生 media monitor
  if (global.monitorProcess) {
    try { global.monitorProcess.kill(); } catch (e) {}
  }
  if (islandProc) {
    try { islandProc.kill(); } catch (e) {}
  }
  try { fs.unlinkSync(path.join(process.env.DATA_DIR || DEV_ROOT, 'app.pid')); } catch (e) {}
});
