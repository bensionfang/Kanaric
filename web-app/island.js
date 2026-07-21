/**
 * 靈動島 (Electron 視窗版)
 *
 * 島是 app 的一個 frameless 透明置頂視窗,不是獨立程式 —— app 結束它就跟著消失,
 * 設定與歌詞跟網頁共用同一份來源 (views/island.ejs 直接接 server 的 WebSocket 廣播)。
 *
 * 拖曳刻意不用 -webkit-app-region: drag (沒有拖曳結束事件,做不了吸附判定),
 * 也不用「每次 mousemove 送一次 IPC」(跨進程,60Hz 下容易掉幀)。
 * 改成:renderer 只在按下/放開各送一次 IPC,移動期間由主進程自己讀游標
 * (screen.getCursorScreenPoint) 並 setBounds —— 全程在主進程,沒有 per-frame IPC。
 */
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

// 視窗要比島本體寬:貼齊頂端時左右的「外擴角」畫在這段透明邊裡
const EDGE = 24;
const BASE_WIDTH = 420;   // 開窗時的起始尺寸,之後由頁面量到的內容尺寸接手
const BASE_HEIGHT = 64;
const MIN_WIDTH = 220;
const MIN_HEIGHT = 36;
const DOCK_THRESHOLD = 12;   // 視窗頂端離工作區頂端多近就算吸附
const DRAG_HZ = 120;         // 游標取樣頻率,高於螢幕更新率才不會是動畫瓶頸

let win = null;
let dragTimer = null;
let dockAnim = null;
let serverPort = 5720;

function settings() {
  try { return global.readSettings ? global.readSettings() : {}; } catch (e) { return {}; }
}

// 只是開窗時的起始尺寸。真正的寬高由頁面量完內容回報 (island:resize) —— 行數、字體大小、
// 假名開關都會影響實際高度,在這裡用公式猜一定會錯。
function windowSize(s) {
  const scale = Math.max(0.6, Math.min(1.6, (Number(s.font_size) || 32) / 32));
  return {
    width: Math.round(BASE_WIDTH * scale) + EDGE * 2,
    height: Math.round(BASE_HEIGHT * scale)
  };
}

// 還原位置時要防呆:上次那台螢幕可能已經拔掉了,拉回最近螢幕的工作區內
function clampToScreen(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const wa = display.workArea;
  return {
    x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - width)),
    y: Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - height))
  };
}

function openIsland(port) {
  if (port) serverPort = port;
  if (win) { win.show(); return win; }

  const s = settings();
  const { width, height } = windowSize(s);
  const { workArea } = screen.getPrimaryDisplay();
  const wantX = s.island_x !== undefined ? s.island_x : workArea.x + (workArea.width - width) / 2;
  const wantY = s.island_y !== undefined ? s.island_y : workArea.y;
  const { x, y } = clampToScreen(wantX, wantY, width, height);

  win = new BrowserWindow({
    width, height, x, y,
    frame: false,
    transparent: true,
    resizable: false,        // transparent 視窗改尺寸會閃,尺寸只在設定變更時由程式調
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-island.js') }
  });
  // 'screen-saver' 這一層才蓋得過全螢幕播放的影片
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL(`http://127.0.0.1:${serverPort}/island`);
  win.once('ready-to-show', () => {
    if (!win) return;
    win.show();
    win.webContents.send('island:docked', s.island_docked !== false);
  });
  win.on('closed', () => { stopDrag(); win = null; });
  return win;
}

function closeIsland() {
  if (win) win.destroy();   // close 事件沒人攔,destroy 比較直接;closed 會清掉 win
  win = null;
  stopDrag();
}

function isIslandOpen() { return !!win; }


function stopDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
}

function savePosition(docked) {
  if (!win || !global.updateSettings) return;
  const b = win.getBounds();
  try {
    global.updateSettings({ island_x: b.x, island_y: b.y, island_docked: !!docked });
  } catch (e) {}
}

// 吸附/脫離都用同一段:把視窗 y 用 easing 推到目標,同時告訴 renderer 切圓角
function animateY(targetY, ms = 260, done) {
  if (!win) return;
  clearInterval(dockAnim);
  const startY = win.getBounds().y;
  const startAt = Date.now();
  dockAnim = setInterval(() => {
    if (!win) return clearInterval(dockAnim);
    const t = Math.min(1, (Date.now() - startAt) / ms);
    const ease = 1 - Math.pow(1 - t, 4);   // easeOutQuart,跟舊的 C# 島同一條曲線
    const b = win.getBounds();
    win.setBounds({ ...b, y: Math.round(startY + (targetY - startY) * ease) });
    if (t >= 1) { clearInterval(dockAnim); if (done) done(); }
  }, 8);
}

ipcMain.on('island:drag-start', () => {
  if (!win || settings().island_locked) return;
  clearInterval(dockAnim);
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const offX = cursor.x - b.x;
  const offY = cursor.y - b.y;
  let wasDocked = true;

  stopDrag();
  dragTimer = setInterval(() => {
    if (!win) return stopDrag();
    const c = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    win.setBounds({ x: c.x - offX, y: c.y - offY, width: bounds.width, height: bounds.height });
    // 往下拖離吸附區的瞬間就恢復圓角,不等放開 (舊島的手感)
    const top = screen.getDisplayNearestPoint(c).workArea.y;
    const docked = (c.y - offY) - top < DOCK_THRESHOLD;
    if (docked !== wasDocked) {
      wasDocked = docked;
      win.webContents.send('island:docked', docked);
    }
  }, Math.round(1000 / DRAG_HZ));
});

ipcMain.on('island:drag-end', () => {
  stopDrag();
  if (!win) return;
  const b = win.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const docked = b.y - workArea.y < DOCK_THRESHOLD;
  win.webContents.send('island:docked', docked);
  if (docked) animateY(workArea.y, 220, () => savePosition(true));
  else savePosition(false);
});

// 單擊 = 在「貼齊頂端」與「浮在下面一點」之間切換
ipcMain.on('island:toggle-dock', () => {
  if (!win || settings().island_locked) return;
  const b = win.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const docked = b.y - workArea.y < DOCK_THRESHOLD;
  win.webContents.send('island:docked', !docked);
  animateY(docked ? workArea.y + 28 : workArea.y, 260, () => savePosition(!docked));
});

// 頁面量完內容要多大就回報,視窗跟著縮放 —— 島才會「貼著歌詞」而不是一個固定的大黑框。
// 寬度以中心點為錨 (視窗置中時看起來就是兩邊一起收);寬高各留 8px 死區,免得逐句抖動。
// 高度也吃頁面量到的值:ruby 有沒有顯示、一行還兩行、字體大小,全部自動貼合,不用維護對照表。
ipcMain.on('island:resize', (_e, size) => {
  if (!win || !size) return;
  const b = win.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const width = Math.max(MIN_WIDTH, Math.min(Math.round(size.width) + EDGE * 2, wa.width));
  const height = size.height ? Math.max(MIN_HEIGHT, Math.round(size.height)) : b.height;
  if (Math.abs(width - b.width) < 8 && Math.abs(height - b.height) < 8) return;
  const centerX = b.x + b.width / 2;
  const x = Math.round(Math.min(Math.max(centerX - width / 2, wa.x), wa.x + wa.width - width));
  // 吸附狀態下高度變化不能把島往下推,上緣要一直貼著工作區頂端
  const y = b.y - wa.y < DOCK_THRESHOLD ? wa.y : b.y;
  win.setBounds({ x, y, width, height });
});

module.exports = { openIsland, closeIsland, isIslandOpen };
