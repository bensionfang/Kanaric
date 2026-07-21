// 靈動島的橋:renderer 只送「按下 / 放開 / 單擊 / 設定變了」,視窗移動與尺寸由主進程處理
const { contextBridge, ipcRenderer } = require('electron');

// 名字不能叫 island:頁面裡有 <div id="island">,瀏覽器的具名元素會占用 window.island,
// 讓「不在 Electron 裡就降級」的判斷失效
contextBridge.exposeInMainWorld('islandBridge', {
  dragStart: () => ipcRenderer.send('island:drag-start'),
  dragEnd: () => ipcRenderer.send('island:drag-end'),
  toggleDock: () => ipcRenderer.send('island:toggle-dock'),
  resize: (size) => ipcRenderer.send('island:resize', size),
  onDocked: (cb) => ipcRenderer.on('island:docked', (_e, docked) => cb(docked))
});
