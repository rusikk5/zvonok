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
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', (_e, version) => cb(version)),
  installUpdate: () => ipcRenderer.send('update:install'),
  checkUpdate:   () => ipcRenderer.invoke('update:check'),
  onScreenSources: (cb) => ipcRenderer.on('screen:sources', (_e, sources) => cb(sources)),
  pickScreen:      (id) => ipcRenderer.send('screen:pick', id),
  cancelScreen:    ()   => ipcRenderer.send('screen:cancel'),
});
