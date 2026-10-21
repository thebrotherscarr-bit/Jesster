// The one door between the sandboxed page and the desktop shell: which build
// this is and updating it, settings, the inbox, and the notes folder on disk.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('secondbrainDesktop', {
  version: () => ipcRenderer.invoke('desktop:version'),
  checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  applyUpdate: () => ipcRenderer.invoke('desktop:apply-update'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (section, value) => ipcRenderer.invoke('settings:set', section, value),
  },
  inbox: {
    status: () => ipcRenderer.invoke('inbox:status'),
    sync: () => ipcRenderer.invoke('inbox:sync'),
    connect: () => ipcRenderer.invoke('inbox:connect'),
    disconnect: () => ipcRenderer.invoke('inbox:disconnect'),
    onStatus: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('inbox:status', fn);
      return () => ipcRenderer.removeListener('inbox:status', fn);
    },
  },
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
