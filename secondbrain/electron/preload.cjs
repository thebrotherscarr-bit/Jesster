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
    // a card answered anywhere (here, the Approvals shelf, a message typed while it waited): it leaves every view
    onAnswered: (cb) => {
      const fn = (_e, done) => cb(done);
      ipcRenderer.on('agent:approval-done', fn);
      return () => ipcRenderer.removeListener('agent:approval-done', fn);
    },
    // a conversation started from outside (agent_send over MCP): the window opens it
    onShow: (cb) => {
      const fn = (_e, id) => cb(id);
      ipcRenderer.on('agent:show', fn);
      return () => ipcRenderer.removeListener('agent:show', fn);
    },
  },
  // Steward's button: the pieces he runs on, and what he works with
  steward: {
    status: () => ipcRenderer.invoke('steward:status'),
    uses: () => ipcRenderer.invoke('steward:uses'),
    control: (piece, action) => ipcRenderer.invoke('steward:control', piece, action),
  },
  // the Servers shelf: every server Steward needs, its state, Start/Stop/Restart and its log
  services: {
    list: () => ipcRenderer.invoke('services:list'),
    control: (id, action) => ipcRenderer.invoke('services:control', id, action),
    log: (id, lines) => ipcRenderer.invoke('services:log', id, lines),
  },
  // the Approvals shelf: every open card of both planes (answered with agent.approve and door.call, as ever),
  // the standing Always allow entries and their Reset, and Steward's tool policy (read only)
  approvals: {
    list: () => ipcRenderer.invoke('approvals:list'),
    always: () => ipcRenderer.invoke('approvals:always'),
    reset: (key) => ipcRenderer.invoke('approvals:reset', typeof key === 'string' ? key : null),
    policy: () => ipcRenderer.invoke('approvals:policy'),
    // the answered cards, newest first (at most 200)
    history: (limit) => ipcRenderer.invoke('approvals:history', limit),
  },
  // the Agent tab's console (console.cjs): Steward's evals, runs, skills and memory, read only, from his folder
  stewardConsole: {
    evals: () => ipcRenderer.invoke('console:evals'),
    runs: () => ipcRenderer.invoke('console:runs'),
    skills: () => ipcRenderer.invoke('console:skills'),
    memory: () => ipcRenderer.invoke('console:memory'),
    memoryRead: (p) => ipcRenderer.invoke('console:memory-read', String(p || '')),
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
    local: (samples) => ipcRenderer.invoke('voice:local', samples),
    where: () => ipcRenderer.invoke('voice:where'),
  },
  share: {
    get: (reveal) => ipcRenderer.invoke('share:get', Boolean(reveal)),
    set: (patch) => ipcRenderer.invoke('share:set', patch),
  },
  atlas: {
    connect: (opts) => ipcRenderer.invoke('atlas:connect', opts),
    open: () => ipcRenderer.invoke('atlas:open'),
  },
  integrations: {
    get: () => ipcRenderer.invoke('integrations:get'),
    set: (provider, patch) => ipcRenderer.invoke('integrations:set', provider, patch),
    models: (provider) => ipcRenderer.invoke('integrations:models', provider),
    chat: (id, req) => ipcRenderer.invoke('integrations:chat', id, req),
    stop: (id) => ipcRenderer.invoke('integrations:stop', id),
    connectApp: (app) => ipcRenderer.invoke('integrations:connect-app', app),
    onChunk: (cb) => {
      const fn = (_e, c) => cb(c);
      ipcRenderer.on('integrations:chunk', fn);
      return () => ipcRenderer.removeListener('integrations:chunk', fn);
    },
  },
  archive: {
    get: () => ipcRenderer.invoke('archive:get'),
    set: (patch) => ipcRenderer.invoke('archive:set', patch),
    status: () => ipcRenderer.invoke('archive:status'),
    sources: (change) => ipcRenderer.invoke('archive:sources', change || {}),
    dig: () => ipcRenderer.invoke('archive:dig'),
    distill: (opts) => ipcRenderer.invoke('archive:distill', opts || {}),
    write: () => ipcRenderer.invoke('archive:write'),
    pause: () => ipcRenderer.invoke('archive:pause'),
    stop: () => ipcRenderer.invoke('archive:stop'),
    onState: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('archive:state', fn);
      return () => ipcRenderer.removeListener('archive:state', fn);
    },
  },
  computer: {
    models: () => ipcRenderer.invoke('computer:models'),
  },
  // the GitHub shelf: the door's git and hold tools, as the operator
  door: {
    call: (name, args) => ipcRenderer.invoke('door:call', name, args || {}),
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
