'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
contextBridge.exposeInMainWorld('pet', {
  assetsDir: path.resolve(__dirname, '..', '..', 'assets').replace(/\\/g, '/'),
  send: (ch, payload) => ipcRenderer.send(ch, payload),
  invoke: (ch, payload) => ipcRenderer.invoke(ch, payload),
  on: (ch, fn) => { const h = (e, p) => fn(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); },
});
