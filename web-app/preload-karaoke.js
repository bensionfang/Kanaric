const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('karaokeWindow', {
  start: (options) => ipcRenderer.invoke('karaoke-window:start', options),
  startCollapsed: (options) => ipcRenderer.invoke('karaoke-window:start-collapsed', options),
  expand: () => ipcRenderer.invoke('karaoke-window:expand'),
  collapse: () => ipcRenderer.invoke('karaoke-window:collapse'),
  finish: () => ipcRenderer.invoke('karaoke-window:finish'),
  minimize: () => ipcRenderer.invoke('karaoke-window:minimize'),
  maximize: () => ipcRenderer.invoke('karaoke-window:maximize'),
  close: () => ipcRenderer.invoke('karaoke-window:close'),
  handleExpand: () => ipcRenderer.invoke('karaoke-window:handle-expand'),
  onHandleExpanded: (callback) => ipcRenderer.on('karaoke-window:handle-expanded', () => callback()),
});
