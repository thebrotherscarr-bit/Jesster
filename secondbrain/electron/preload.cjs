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
    report: (note) => ipcRenderer.invoke('report:send', note || ''),
    onStatus: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('inbox:status', fn);
      return () => ipcRenderer.removeListener('inbox:status', fn);
    },
  },
  agent: {
    send: (text, sessionId, model) => ipcRenderer.invoke('agent:send', text, sessionId || null, model || null),
    sessions: () => ipcRenderer.invoke('agent:sessions'),
    open: (id) => ipcRenderer.invoke('agent:open', id),
    stop: (id) => ipcRenderer.invoke('agent:stop', id),
    approve: (id, allow, always) => ipcRenderer.invoke('agent:approve', id, allow, Boolean(always)),
    tools: () => ipcRenderer.invoke('agent:tools'),
    onEvent: (cb) => {
      const fn = (_e, ev) => cb(ev);
      ipcRenderer.on('agent:event', fn);
      return () => ipcRenderer.removeListener('agent:event', fn);
    },
    onApproval: (cb) => {
      const fn = (_e, req) => cb(req);
      ipcRenderer.on('agent:approval', fn);
      return () => ipcRenderer.removeListener('agent:approval', fn);
    },
  },
  schedules: {
    list: () => ipcRenderer.invoke('schedules:list'),
    add: (spec) => ipcRenderer.invoke('schedules:add', spec),
    update: (id, patch) => ipcRenderer.invoke('schedules:update', id, patch),
    remove: (id) => ipcRenderer.invoke('schedules:remove', id),
    run: (id) => ipcRenderer.invoke('schedules:run', id),
  },
  mcp: {
    get: () => ipcRenderer.invoke('mcp:get'),
    save: (text) => ipcRenderer.invoke('mcp:save', text),
    reconnect: () => ipcRenderer.invoke('mcp:reconnect'),
  },
  telegram: {
    state: () => ipcRenderer.invoke('telegram:state'),
    pair: (chatId, allow) => ipcRenderer.invoke('telegram:pair', chatId, allow),
    test: () => ipcRenderer.invoke('telegram:test'),
    onState: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('telegram:state', fn);
      return () => ipcRenderer.removeListener('telegram:state', fn);
    },
  },
  voice: {
    onTranscribe: (cb) => {
      const fn = (_e, job) => cb(job);
      ipcRenderer.on('voice:transcribe', fn);
      return () => ipcRenderer.removeListener('voice:transcribe', fn);
    },
    result: (id, text, error) => ipcRenderer.invoke('voice:result', id, text || '', error || null),
  },
  share: {
    get: (reveal) => ipcRenderer.invoke('share:get', Boolean(reveal)),
    set: (patch) => ipcRenderer.invoke('share:set', patch),
  },
  atlas: {
    connect: (opts) => ipcRenderer.invoke('atlas:connect', opts),
  },
  computer: {
    models: () => ipcRenderer.invoke('computer:models'),
  },
  pick: (kind, title) => ipcRenderer.invoke('dialog:pick', kind, title),
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
