'use strict';
const { clipboard, contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('node:url');
contextBridge.exposeInMainWorld('pet', {
  assetsDir: path.resolve(__dirname, '..', '..', 'assets').replace(/\\/g, '/'),
  send: (ch, payload) => ipcRenderer.send(ch, payload),
  invoke: (ch, payload) => ipcRenderer.invoke(ch, payload),
  on: (ch, fn) => { const h = (e, p) => fn(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); },
});

// 面板与 Agent 架构窗口共用同一套只读项目状态读取器；其他窗口不暴露。
// 页面地址可能带 hash/查询，用前缀匹配而不是全等。
const isAppPage = (file) => process.isMainFrame
  && window.location.href.startsWith(pathToFileURL(path.resolve(__dirname, '..', 'renderer', file)).href);
if (isAppPage('panel.html') || isAppPage('agentmap.html')) {
  const { readProjectStatus } = require('./project-status');
  contextBridge.exposeInMainWorld('projectPanel', {
    read: readProjectStatus,
    copyReference(id) {
      if (typeof id !== 'string' || !/^[TE]-[a-z0-9-]{1,48}$/i.test(id)) return false;
      clipboard.writeText(id);
      return true;
    },
  });
}
