const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createKaraokeWindowController, normalizeStartOptions, isTrustedWindowEvent, registerKaraokeWindowIpc } = require('../web-app/karaoke-window.js');

const packagedFiles = require('../web-app/package.json').build.files;
assert.ok(packagedFiles.includes('karaoke-window.js') && packagedFiles.includes('preload-karaoke.js'),
  '打包版必須包含主進程 controller 與 preload bridge');
const electronSource = fs.readFileSync(require.resolve('../web-app/electron.js'), 'utf8');
const mainWindowSource = electronSource.match(/mainWindow = new BrowserWindow\(\{[\s\S]*?\n  \}\);/)?.[0] || '';
assert.match(mainWindowSource, /frame:\s*false/, '主視窗必須是無框，卡拉 OK 才能移除原生標題列按鈕');
assert.doesNotMatch(mainWindowSource, /titleBarOverlay/, '主視窗無框後不得保留原生標題列覆蓋');
const headerSource = fs.readFileSync(require.resolve('../web-app/views/header.ejs'), 'utf8');
assert.match(headerSource, /id="window-controls"/, '非卡拉 OK 頁要有可達的自製視窗控制');

const right = { bounds: { x: 1920, y: 0, width: 1600, height: 900 }, workArea: { x: 1920, y: 0, width: 1600, height: 860 } };
const left = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };

function fakeWindow({ maximized = false, initialBounds = { x: 2100, y: 40, width: 1280, height: 840 } } = {}) {
  let bounds = { ...initialBounds };
  let minimum = [800, 600];
  let isMaximized = maximized;
  let hidden = false;
  let closed = false;
  const topCalls = [];
  return {
    getBounds: () => ({ ...bounds }), setBounds: (next) => { bounds = { ...next }; },
    getMinimumSize: () => [...minimum], setMinimumSize: (w, h) => { minimum = [w, h]; },
    isMaximized: () => isMaximized, unmaximize: () => { isMaximized = false; },
    maximize: () => { isMaximized = true; },
    minimize: () => { hidden = true; }, close: () => { closed = true; }, isClosed: () => closed,
    hide: () => { hidden = true; }, show: () => { hidden = false; }, isHidden: () => hidden,
    setAlwaysOnTop: (...args) => topCalls.push(args),
    topCalls, minimum: () => minimum,
  };
}

const screen = {
  getDisplayMatching: (bounds) => bounds.x < 0 ? left : right,
  getAllDisplays: () => [left, right],
};

assert.deepEqual(normalizeStartOptions({ compact: true, top: true, ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 } }),
  { compact: true, top: true, ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 } });
assert.equal(normalizeStartOptions({ compact: 1, top: true }), null);
assert.equal(normalizeStartOptions({ compact: true, top: true, ownerWindowBounds: { x: 0, y: 0, width: 0, height: 1080 } }), null);

const contents = { getURL: () => 'http://localhost:5720/karaoke' };
assert.equal(isTrustedWindowEvent({ sender: contents }, { webContents: contents }, 'http://localhost:5720'), true);
assert.equal(isTrustedWindowEvent({ sender: { getURL: () => 'http://localhost:5720/karaoke' } }, { webContents: contents }, 'http://localhost:5720'), false);
assert.equal(isTrustedWindowEvent({ sender: contents }, { webContents: contents }, 'http://localhost:5721'), false);

let bridge;
const channels = [];
vm.runInNewContext(fs.readFileSync(require.resolve('../web-app/preload-karaoke.js'), 'utf8'), {
  require: (name) => {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'karaokeWindow'); bridge = value; } },
      ipcRenderer: { invoke: (channel, payload) => { channels.push([channel, payload]); return Promise.resolve({ ok: true }); } },
    };
  },
});
assert.deepEqual(Object.keys(bridge), [
  'start', 'startCollapsed', 'expand', 'collapse', 'finish',
  'minimize', 'maximize', 'close', 'handleExpand', 'onHandleExpanded',
]);
void bridge.start({ compact: true, top: false });
void bridge.startCollapsed({ compact: true, top: true });
void bridge.finish();
void bridge.minimize();
void bridge.maximize();
void bridge.close();
assert.deepEqual(channels.map(([channel]) => channel), [
  'karaoke-window:start', 'karaoke-window:start-collapsed', 'karaoke-window:finish',
  'karaoke-window:minimize', 'karaoke-window:maximize', 'karaoke-window:close',
]);

const win = fakeWindow({ maximized: true });
const controller = createKaraokeWindowController({ mainWindow: win, screen });
assert.deepEqual(controller.start({ compact: true, top: true, ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 } }), { ok: true });
assert.deepEqual(win.getBounds(), { x: -380, y: 160, width: 380, height: 720 });
assert.deepEqual(win.minimum(), [1, 1]);
assert.deepEqual(win.topCalls.at(-1), [true, 'screen-saver']);
assert.deepEqual(controller.finish(), { ok: true });
assert.deepEqual(win.getBounds(), { x: 2100, y: 40, width: 1280, height: 840 });
assert.deepEqual(win.minimum(), [800, 600]);
assert.equal(win.isMaximized(), true);
assert.deepEqual(win.topCalls.at(-1), [false]);
assert.deepEqual(controller.finish(), { ok: true });

const fallback = fakeWindow();
const fallbackController = createKaraokeWindowController({ mainWindow: fallback, screen });
assert.deepEqual(fallbackController.start({ compact: true, top: false }), { ok: true });
assert.deepEqual(fallback.getBounds(), { x: 3140, y: 70, width: 380, height: 720 });
assert.equal(fallback.topCalls.some(([value]) => value === true), false);
assert.deepEqual(fallbackController.finish(), { ok: true });

let displays = [left, right];
const shiftingScreen = {
  getDisplayMatching: (bounds) => bounds.x < 0 && displays.includes(left) ? left : right,
  getAllDisplays: () => displays,
};
const moved = fakeWindow({ initialBounds: { x: -1800, y: 40, width: 1280, height: 840 } });
const movedController = createKaraokeWindowController({ mainWindow: moved, screen: shiftingScreen });
assert.deepEqual(movedController.start({ compact: true, top: true, ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 } }), { ok: true });
displays = [right];
assert.deepEqual(movedController.finish(), { ok: true });
assert.deepEqual(moved.getBounds(), { x: 1920, y: 20, width: 1280, height: 840 },
  '原螢幕消失時，還原 bounds 必須夾回現存工作區');

// ===== Task 7: native 48x160 handle lifecycle =====
const handleWindow = fakeWindow();
const nativeHandles = [];
const handleController = createKaraokeWindowController({
  mainWindow: handleWindow, screen,
  createHandleWindow: (bounds) => {
    const handle = { bounds, shown: false, closed: false,
      show() { this.shown = true; }, close() { this.closed = true; }, isDestroyed() { return this.closed; } };
    nativeHandles.push(handle);
    return handle;
  },
});
assert.deepEqual(handleController.start({ compact: true, top: false }), { ok: true });
assert.deepEqual(handleController.collapse(), { ok: true }, 'compact controller 要能收合主視窗');
assert.deepEqual(nativeHandles[0].bounds, { x: 3472, y: 350, width: 48, height: 160 },
  '把手必須是真正 on-screen 48x160 且貼 workArea 右緣');
assert.equal(handleWindow.isHidden(), true, '收合時主控台必須隱藏，不能縮成可操作的視窗');
assert.deepEqual(handleController.collapse(), { ok: true }, '重複收合要冪等');
assert.deepEqual(handleController.expand(), { ok: true }, '把手展開要還原原控台 bounds');
assert.deepEqual(handleWindow.getBounds(), { x: 3140, y: 70, width: 380, height: 720 });
assert.equal(handleWindow.isHidden(), false);
assert.equal(nativeHandles[0].closed, true);
assert.deepEqual(handleController.expand(), { ok: true }, '重複展開要冪等');
assert.deepEqual(handleController.collapse(), { ok: true });
assert.deepEqual(handleController.finish(), { ok: true });
assert.deepEqual(handleWindow.getBounds(), { x: 2100, y: 40, width: 1280, height: 840 });
assert.deepEqual(handleController.finish(), { ok: true }, 'finish 重複呼叫要冪等');
assert.equal(handleWindow.topCalls.some(([value]) => value === true), false,
  'always-on-top 關閉時不得設置頂');

// ===== Task 5: atomic first-song collapse =====
const atomicEvents = [];
const atomicWindow = fakeWindow();
const atomicHide = atomicWindow.hide;
const atomicSetBounds = atomicWindow.setBounds;
atomicWindow.hide = () => { atomicEvents.push('hide'); atomicHide(); };
atomicWindow.setBounds = (next) => { atomicEvents.push(`set-bounds-${next.width}x${next.height}`); atomicSetBounds(next); };
const atomicHandle = {
  shown: false, closed: false,
  show() { atomicEvents.push('handle-show'); this.shown = true; },
  close() { this.closed = true; },
  isDestroyed() { return this.closed; },
};
const atomicController = createKaraokeWindowController({
  mainWindow: atomicWindow, screen,
  createHandleWindow: (bounds) => { atomicEvents.push(['handle-create', bounds]); return atomicHandle; },
});
assert.deepEqual(atomicController.startCollapsed({ compact: true, top: false }), { ok: true },
  '首唱要由單一 atomic startCollapsed 建立把手');
assert.ok(atomicEvents.indexOf('hide') >= 0, '收合前必須先隱藏主控台');
assert.ok(atomicEvents.indexOf('hide') < atomicEvents.findIndex((event) => String(event).startsWith('set-bounds-')),
  '主控台必須在任何緊湊 bounds 變化前隱藏');
assert.equal(atomicWindow.isHidden(), true, 'atomic startCollapsed 成功後主控台維持隱藏');
assert.equal(atomicHandle.shown, true, '把手建立成功後才顯示');
assert.equal(atomicEvents.at(-1), 'handle-show', '把手必須是最後才顯示');
assert.deepEqual(atomicController.finish(), { ok: true });

const failedStartWindow = fakeWindow();
const failedStartController = createKaraokeWindowController({
  mainWindow: failedStartWindow, screen, createHandleWindow: () => null,
});
assert.deepEqual(failedStartController.startCollapsed({ compact: true, top: false }),
  { ok: false, error: 'window-start-failed' },
  '把手建立失敗要回報 start failure');
assert.equal(failedStartWindow.isHidden(), false, 'start failure 不得留下隱藏主控台');
assert.deepEqual(failedStartWindow.getBounds(), { x: 2100, y: 40, width: 1280, height: 840 },
  'start failure 要還原原始 bounds');

const handlers = new Map();
const ipcWindow = fakeWindow();
ipcWindow.webContents = contents;
const createdHandles = [];
class FakeHandle {
  constructor(options) {
    this.options = options;
    this.webContents = {};
    this.listeners = {};
    createdHandles.push(this);
  }
  setAlwaysOnTop() {}
  loadURL(url) { this.url = url; }
  show() {}
  on(event, listener) { this.listeners[event] = listener; }
  close() { this.closed = true; this.listeners.closed?.(); }
  isDestroyed() { return !!this.closed; }
}
contents.send = () => {};
registerKaraokeWindowIpc({
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  mainWindow: ipcWindow,
  screen,
  origin: 'http://localhost:5720',
  BrowserWindow: FakeHandle,
  preloadPath: 'preload-karaoke.js',
});
for (const channel of new Set(channels.map(([name]) => name))) {
  assert.equal(handlers.has(channel), true, `preload IPC channel 必須有對應 handler: ${channel}`);
}
assert.deepEqual(handlers.get('karaoke-window:start')({ sender: {} }, { compact: true, top: true }),
  { ok: false, error: 'forbidden' });
assert.deepEqual(handlers.get('karaoke-window:start')({ sender: contents }, { compact: true, top: false }), { ok: true });
assert.deepEqual(ipcWindow.getBounds(), { x: 3140, y: 70, width: 380, height: 720 });
assert.deepEqual(handlers.get('karaoke-window:collapse')({ sender: contents }), { ok: true });
assert.equal(ipcWindow.isHidden(), true);
assert.equal(createdHandles[0].options.frame, false);
assert.equal(createdHandles[0].options.show, false);
assert.equal(decodeURIComponent(createdHandles[0].url).includes('karaoke-stage'), false,
  '原生把手不能包含可操作的控台');
assert.deepEqual(handlers.get('karaoke-window:handle-expand')({ sender: contents }), { ok: false, error: 'forbidden' });
assert.deepEqual(handlers.get('karaoke-window:handle-expand')({ sender: createdHandles[0].webContents }), { ok: true });
assert.equal(ipcWindow.isHidden(), false);
assert.deepEqual(handlers.get('karaoke-window:finish')({ sender: contents }), { ok: true });
assert.deepEqual(ipcWindow.getBounds(), { x: 2100, y: 40, width: 1280, height: 840 });
assert.deepEqual(handlers.get('karaoke-window:start')({ sender: contents }, { compact: true, top: false }), { ok: true });
assert.deepEqual(handlers.get('karaoke-window:collapse')({ sender: contents }), { ok: true });
createdHandles.at(-1).close();
assert.equal(ipcWindow.isHidden(), false, '把手意外關閉時不能留下隱藏的主控台');
assert.deepEqual(handlers.get('karaoke-window:finish')({ sender: contents }), { ok: true });
assert.deepEqual(handlers.get('karaoke-window:minimize')({ sender: {} }), { ok: false, error: 'forbidden' });
assert.deepEqual(handlers.get('karaoke-window:minimize')({ sender: contents }), { ok: true });
assert.equal(ipcWindow.isHidden(), true, '自製最小化控制要由同源 IPC 執行');
assert.deepEqual(handlers.get('karaoke-window:maximize')({ sender: contents }), { ok: true });
assert.equal(ipcWindow.isMaximized(), true, '自製最大化控制要由同源 IPC 執行');
assert.deepEqual(handlers.get('karaoke-window:close')({ sender: contents }), { ok: true });
assert.equal(ipcWindow.isClosed(), true, '自製關閉控制要由同源 IPC 執行');

;(async () => {
  const readyContents = { getURL: () => 'http://localhost:5720/karaoke', send() {} };
  const readyWindow = fakeWindow();
  readyWindow.webContents = readyContents;
  const readyHandlers = new Map();
  const loadSettlers = [];
  const readyHandles = [];
  class DeferredHandle extends FakeHandle {
    constructor(options) {
      super(options);
      this.showCalls = 0;
      readyHandles.push(this);
    }
    loadURL(url) {
      this.url = url;
      return new Promise((resolve, reject) => loadSettlers.push({ resolve, reject }));
    }
    show() { this.showCalls += 1; }
  }
  registerKaraokeWindowIpc({
    ipcMain: { handle: (name, handler) => readyHandlers.set(name, handler) },
    mainWindow: readyWindow,
    screen,
    origin: 'http://localhost:5720',
    BrowserWindow: DeferredHandle,
    preloadPath: 'preload-karaoke.js',
  });
  assert.deepEqual(readyHandlers.get('karaoke-window:start-collapsed')({ sender: readyContents }, {
    compact: true, top: false,
  }), { ok: true });
  assert.equal(readyHandles[0].showCalls, 0, 'handle load 完成前不得顯示把手');
  loadSettlers[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(readyHandles[0].showCalls, 1, 'handle load 完成後才顯示把手');

  const failedWindow = fakeWindow();
  failedWindow.webContents = readyContents;
  const failedHandlers = new Map();
  const failedHandles = [];
  class FailedHandle extends DeferredHandle {
    constructor(options) {
      super(options);
      failedHandles.push(this);
    }
  }
  registerKaraokeWindowIpc({
    ipcMain: { handle: (name, handler) => failedHandlers.set(name, handler) },
    mainWindow: failedWindow,
    screen,
    origin: 'http://localhost:5720',
    BrowserWindow: FailedHandle,
    preloadPath: 'preload-karaoke.js',
  });
  assert.deepEqual(failedHandlers.get('karaoke-window:start-collapsed')({ sender: readyContents }, {
    compact: true, top: false,
  }), { ok: true });
  const failedSettler = loadSettlers[1];
  assert.equal(failedHandles[0].showCalls, 0, '失敗中的 handle 不得先閃現');
  failedSettler.reject(new Error('handle-load-failed'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(failedHandles[0].showCalls, 0, 'load failure 不得顯示把手');
  assert.equal(failedWindow.isHidden(), false, 'load failure 必須恢復可操作主窗');

  const blankWindow = fakeWindow();
  blankWindow.webContents = readyContents;
  const blankHandlers = new Map();
  const blankHandles = [];
  class BlankHandle extends FakeHandle {
    constructor(options) {
      super(options);
      this.webContents = { getURL: () => 'about:blank' };
      this.showCalls = 0;
      blankHandles.push(this);
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    show() { this.showCalls += 1; }
  }
  registerKaraokeWindowIpc({
    ipcMain: { handle: (name, handler) => blankHandlers.set(name, handler) },
    mainWindow: blankWindow,
    screen,
    origin: 'http://localhost:5720',
    BrowserWindow: BlankHandle,
    preloadPath: 'preload-karaoke.js',
  });
  assert.deepEqual(blankHandlers.get('karaoke-window:start-collapsed')({ sender: readyContents }, {
    compact: true, top: false,
  }), { ok: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(blankHandles[0].showCalls, 0, 'blank handle 不得顯示');
  assert.equal(blankWindow.isHidden(), false, 'blank handle 必須恢復可操作主窗');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

console.log('test_karaoke_window: OK');
