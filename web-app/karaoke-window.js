const COMPACT_WIDTH = 380;
const COMPACT_HEIGHT = 720;
const HANDLE_WIDTH = 48;
const HANDLE_HEIGHT = 160;

function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 4
    || Object.keys(raw).some((key) => !['x', 'y', 'width', 'height'].includes(key))) return null;
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every(Number.isSafeInteger)
    || width < 1 || width > 32768 || height < 1 || height > 32768) return null;
  return { x, y, width, height };
}

function normalizeStartOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !['compact', 'top', 'ownerWindowBounds'].includes(key))
    || typeof raw.compact !== 'boolean' || typeof raw.top !== 'boolean') return null;
  const ownerWindowBounds = raw.ownerWindowBounds === undefined ? null : normalizeBounds(raw.ownerWindowBounds);
  if (raw.ownerWindowBounds !== undefined && !ownerWindowBounds) return null;
  return { compact: raw.compact, top: raw.top, ...(ownerWindowBounds ? { ownerWindowBounds } : {}) };
}

function isTrustedWindowEvent(event, mainWindow, origin) {
  if (!mainWindow || event?.sender !== mainWindow.webContents) return false;
  try { return new URL(event.sender.getURL()).origin === origin; } catch { return false; }
}

function clampToWorkArea(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width, height,
  };
}

function createKaraokeWindowController({ mainWindow, screen, createHandleWindow }) {
  let original = null;
  let expanded = null;
  let collapsed = false;
  let handleWindow = null;

  function closeHandle() {
    const handle = handleWindow;
    handleWindow = null;
    if (handle && !handle.isDestroyed?.()) handle.close();
  }

  function displayFor(bounds) {
    const displays = screen.getAllDisplays();
    const display = screen.getDisplayMatching(bounds);
    return displays.includes(display) ? display
      : displays.find((item) => item.id !== undefined && item.id === display?.id) || displays[0];
  }

  function finish() {
    if (!original) {
      try {
        closeHandle();
        mainWindow.show();
        return { ok: true };
      } catch { return { ok: false, error: 'window-restore-failed' }; }
    }
    const saved = original;
    original = null;
    expanded = null;
    collapsed = false;
    try {
      closeHandle();
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setMinimumSize(...saved.minimum);
      const originalDisplayStillExists = screen.getAllDisplays().some((item) => item === saved.display
        || (saved.display?.id !== undefined && item.id === saved.display.id));
      const display = originalDisplayStillExists ? saved.display : displayFor(saved.bounds);
      const area = display?.workArea || display?.bounds;
      mainWindow.setBounds(!originalDisplayStillExists && area
        ? clampToWorkArea(saved.bounds, area) : saved.bounds);
      if (saved.maximized) mainWindow.maximize();
      mainWindow.show();
      return { ok: true };
    } catch {
      try { closeHandle(); } catch {}
      try { mainWindow.show(); } catch {}
      return { ok: false, error: 'window-restore-failed' };
    }
  }

  function start(rawOptions) {
    const options = normalizeStartOptions(rawOptions);
    if (!options) return { ok: false, error: 'invalid-options' };
    if (original) return { ok: true };
    try {
      const maximized = mainWindow.isMaximized();
      original = {
        bounds: maximized && mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds(),
        minimum: mainWindow.getMinimumSize(),
        maximized,
      };
      original.display = displayFor(original.bounds);
      if (options.compact) {
        const display = displayFor(options.ownerWindowBounds || mainWindow.getBounds());
        const area = display?.workArea || display?.bounds;
        if (!area) throw new Error('display-unavailable');
        const width = Math.min(COMPACT_WIDTH, area.width);
        const height = Math.min(COMPACT_HEIGHT, area.height);
        if (maximized) mainWindow.unmaximize();
        mainWindow.setMinimumSize(1, 1);
        mainWindow.setBounds({
          x: area.x + area.width - width,
          y: area.y + Math.floor((area.height - height) / 2),
          width, height,
        });
        expanded = mainWindow.getBounds();
      }
      if (options.top) mainWindow.setAlwaysOnTop(true, 'screen-saver');
      return { ok: true };
    } catch {
      finish();
      return { ok: false, error: 'window-start-failed' };
    }
  }

  function startCollapsed(rawOptions) {
    const options = normalizeStartOptions(rawOptions);
    if (!options || !options.compact) return { ok: false, error: 'invalid-options' };
    if (original) return { ok: true };
    try {
      const maximized = mainWindow.isMaximized();
      original = {
        bounds: maximized && mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds(),
        minimum: mainWindow.getMinimumSize(),
        maximized,
      };
      original.display = displayFor(original.bounds);

      // Hide before changing bounds so the 380x720 controller never flashes.
      mainWindow.hide();
      const display = displayFor(options.ownerWindowBounds || mainWindow.getBounds());
      const area = display?.workArea || display?.bounds;
      if (!area) throw new Error('display-unavailable');
      const width = Math.min(COMPACT_WIDTH, area.width);
      const height = Math.min(COMPACT_HEIGHT, area.height);
      if (maximized) mainWindow.unmaximize();
      mainWindow.setMinimumSize(1, 1);
      mainWindow.setBounds({
        x: area.x + area.width - width,
        y: area.y + Math.floor((area.height - height) / 2),
        width, height,
      });
      expanded = mainWindow.getBounds();
      if (options.top) mainWindow.setAlwaysOnTop(true, 'screen-saver');

      if (typeof createHandleWindow !== 'function') throw new Error('handle-unavailable');
      const handle = createHandleWindow({
        x: area.x + area.width - HANDLE_WIDTH,
        y: area.y + Math.floor((area.height - HANDLE_HEIGHT) / 2),
        width: HANDLE_WIDTH,
        height: HANDLE_HEIGHT,
      });
      if (!handle) throw new Error('handle-unavailable');
      handleWindow = handle;
      collapsed = true;
      handle.show();
      return { ok: true };
    } catch {
      const restored = finish();
      if (!restored.ok) {
        try { mainWindow.show(); } catch {}
      }
      return { ok: false, error: 'window-start-failed' };
    }
  }

  function collapse() {
    if (!original || !expanded) return { ok: false, error: 'not-compact' };
    if (collapsed) return { ok: true };
    try {
      expanded = mainWindow.getBounds();
      const display = displayFor(expanded);
      const area = display?.workArea || display?.bounds;
      if (!area) {
        mainWindow.show();
        return { ok: false, error: 'display-unavailable' };
      }
      if (typeof createHandleWindow !== 'function') {
        mainWindow.show();
        return { ok: false, error: 'handle-unavailable' };
      }
      handleWindow = createHandleWindow({
        x: area.x + area.width - HANDLE_WIDTH,
        y: area.y + Math.floor((area.height - HANDLE_HEIGHT) / 2),
        width: HANDLE_WIDTH,
        height: HANDLE_HEIGHT,
      });
      if (!handleWindow) return { ok: false, error: 'handle-unavailable' };
      mainWindow.hide();
      collapsed = true;
      handleWindow.show();
      return { ok: true };
    } catch {
      collapsed = false;
      mainWindow.show();
      closeHandle();
      return { ok: false, error: 'window-collapse-failed' };
    }
  }

  function expand() {
    if (!original || !collapsed) return { ok: true };
    try {
      const display = displayFor(expanded);
      const area = display?.workArea || display?.bounds;
      mainWindow.setBounds(area ? clampToWorkArea(expanded, area) : expanded);
      collapsed = false;
      mainWindow.show();
      closeHandle();
      return { ok: true };
    } catch {
      collapsed = false;
      try { closeHandle(); } catch {}
      try { mainWindow.show(); } catch {}
      return { ok: false, error: 'window-expand-failed' };
    }
  }

  return {
    start,
    startCollapsed,
    expand,
    collapse,
    finish,
  };
}

function registerKaraokeWindowIpc({ ipcMain, mainWindow, screen, origin, BrowserWindow, preloadPath }) {
  let handle = null;
  const controller = createKaraokeWindowController({ mainWindow, screen, createHandleWindow: BrowserWindow && ((bounds) => {
    const nextHandle = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, show: false, autoHideMenuBar: true, backgroundColor: '#00000000',
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    handle = nextHandle;
    try {
      let ready = false;
      let pendingShow = false;
      const nativeShow = nextHandle.show.bind(nextHandle);
      nextHandle.show = () => {
        pendingShow = true;
        if (ready && !nextHandle.isDestroyed?.()) {
          pendingShow = false;
          nativeShow();
        }
      };
      nextHandle.setAlwaysOnTop(true, 'screen-saver');
      const loading = nextHandle.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><style>
      html,body{margin:0;width:100%;height:100%;background:transparent}
      button{width:100%;height:100%;border:1px solid #6ee7b7;border-right:0;border-radius:10px 0 0 10px;
        background:#152124;color:#e6f7f2;font:700 18px sans-serif;cursor:pointer}
      button:hover,button:focus-visible{background:#24413d;outline:2px solid white;outline-offset:-4px}
    </style><button aria-label="展開卡拉 OK 控台" title="展開卡拉 OK 控台" onmouseenter="window.karaokeWindow.handleExpand()" onclick="window.karaokeWindow.handleExpand()">K</button></html>`));
      const restoreMainWindow = () => {
        const result = controller.expand();
        if (result.ok) {
          try { mainWindow.webContents.send('karaoke-window:handle-expanded'); } catch {}
        }
        return result;
      };
      const failLoad = () => {
        pendingShow = false;
        if (handle === nextHandle) restoreMainWindow();
      };
      Promise.resolve(loading).then(() => {
        if (handle !== nextHandle || nextHandle.isDestroyed?.()) return;
        let loadedURL;
        try { loadedURL = nextHandle.webContents?.getURL?.(); } catch { failLoad(); return; }
        if (typeof loadedURL === 'string' && (!loadedURL || loadedURL === 'about:blank')) {
          failLoad();
          return;
        }
        ready = true;
        if (pendingShow) {
          pendingShow = false;
          nativeShow();
        }
      }).catch(failLoad);
      nextHandle.on('closed', () => {
        if (handle !== nextHandle) return;
        handle = null;
        restoreMainWindow();
      });
      return nextHandle;
    } catch (error) {
      handle = null;
      if (!nextHandle.isDestroyed?.()) nextHandle.close();
      throw error;
    }
  }) });
  ipcMain.handle('karaoke-window:handle-expand', (event) => {
    if (!handle || event.sender !== handle.webContents) return { ok: false, error: 'forbidden' };
    const result = controller.expand();
    if (result.ok) mainWindow.webContents.send('karaoke-window:handle-expanded');
    return result;
  });
  const actions = {
    start: (options) => controller.start(options),
    'start-collapsed': (options) => controller.startCollapsed(options),
    expand: () => controller.expand(),
    collapse: () => controller.collapse(),
    finish: () => controller.finish(),
    minimize: () => { mainWindow.minimize(); return { ok: true }; },
    maximize: () => {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      return { ok: true };
    },
    close: () => { mainWindow.close(); return { ok: true }; },
  };
  for (const [name, action] of Object.entries(actions)) {
    ipcMain.handle(`karaoke-window:${name}`, (event, options) =>
      isTrustedWindowEvent(event, mainWindow, origin)
        ? action(options) : { ok: false, error: 'forbidden' });
  }
  return controller;
}

module.exports = { createKaraokeWindowController, normalizeStartOptions, isTrustedWindowEvent, registerKaraokeWindowIpc };
