// The one door between the sandboxed page and the desktop shell: the page
// can ask which build it is, whether a newer one exists, and to install it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('secondbrainDesktop', {
  version: () => ipcRenderer.invoke('desktop:version'),
  checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  applyUpdate: () => ipcRenderer.invoke('desktop:apply-update'),
});
