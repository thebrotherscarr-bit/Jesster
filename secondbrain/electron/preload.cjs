// The one door between the sandboxed page and the desktop shell: which build
// this is and updating it, and the notes folder on disk.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('secondbrainDesktop', {
  version: () => ipcRenderer.invoke('desktop:version'),
  checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  applyUpdate: () => ipcRenderer.invoke('desktop:apply-update'),
  vault: {
    info: () => ipcRenderer.invoke('vault:info'),
    load: () => ipcRenderer.invoke('vault:load'),
    save: (note) => ipcRenderer.invoke('vault:save', note),
    remove: (id) => ipcRenderer.invoke('vault:remove', id),
    reveal: () => ipcRenderer.invoke('vault:reveal'),
    choose: () => ipcRenderer.invoke('vault:choose'),
    importFiles: (paths) => ipcRenderer.invoke('vault:import', paths || null),
    // a dropped File's path on disk (Electron no longer puts it on File)
    pathForFile: (file) => webUtils.getPathForFile(file),
    onChanged: (cb) => {
      const fn = () => cb();
      ipcRenderer.on('vault:changed', fn);
      return () => ipcRenderer.removeListener('vault:changed', fn);
    },
  },
});
