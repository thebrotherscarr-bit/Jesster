// The computer-use panel's only door: show the state, send Allow / Deny / Stop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  onState: (cb) => ipcRenderer.on('computer:state', (_e, s) => cb(s)),
  answer: (value) => ipcRenderer.send('computer:answer', value),
});
