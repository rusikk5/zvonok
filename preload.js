'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  minimize:  () => ipcRenderer.send('win:minimize'),
  maximize:  () => ipcRenderer.send('win:maximize'),
  close:     () => ipcRenderer.send('win:close'),
  dragStart: (sx, sy) => ipcRenderer.send('win:drag-start', sx, sy),
  dragMove:  (sx, sy) => ipcRenderer.send('win:drag-move',  sx, sy),
  dragEnd:   ()       => ipcRenderer.send('win:drag-end'),
  getScreenSources: () => ipcRenderer.invoke('screen:sources'),
  selectScreen:     (id) => ipcRenderer.invoke('screen:select', id),
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', (_e, version) => cb(version)),
  installUpdate: () => ipcRenderer.send('update:install'),
  checkUpdate:   () => ipcRenderer.invoke('update:check'),
});
