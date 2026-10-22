const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const updater = require('./updater.cjs');
const fs = require('fs');
const { Vault, importFile, SUPPORTED } = require('./vaultfs.cjs');
const { Settings } = require('./settings.cjs');
const inbox = require('./inbox.cjs');
const report = require('./report.cjs');
const atlas = require('./atlas.cjs');
const { AgentService } = require('./agent/service.cjs');
const memory = require('./agent/memory.cjs');
const sched = require('./agent/schedules.cjs');
const { McpClient } = require('./agent/mcp.cjs');
const { Telegram } = require('./agent/telegram.cjs');
const subagents = require('./agent/subagents.cjs');
const terminal = require('./agent/terminal.cjs');
const browser = require('./agent/browser.cjs');
const computer = require('./agent/computer.cjs');
const { ComputerRuntime } = require('./computer/desktop.cjs');

const isDev = process.env.NODE_ENV === 'development';
const distDir = path.join(__dirname, '..', 'dist');

// A stable origin is required for localStorage persistence. Chromium keys
// localStorage by full origin (including port), so an ephemeral port would
// give the app a brand-new, empty storage bucket on every launch.
const APP_PORT = Number(process.env.SECONDBRAIN_PORT) || 43110;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

let mainWindow = null;
let localServer = null;

/**
 * Serve the built app from a local http origin.
 *
 * This is deliberately not file:// -- the app talks to the local Ollama daemon
 * via fetch(), and a file:// page has an opaque "null" origin that browsers and
 * Electron reject under CORS. Serving over http keeps localStorage, the service
 * worker, and the Ollama calls all working from a packaged, offline binary.
 */
function startLocalServer() {
  return new Promise((resolve, reject) => {
    if (localServer) {
      resolve(APP_ORIGIN + '/');
      return;
    }

    const server = express();
    // SecondBrain's notes over MCP, for Atlas and Manjuel (Settings → Share)
    server.post('/mcp', express.json({ limit: '2mb' }), (req, res) => serveMcp(req, res));
    server.use(express.static(distDir, { index: 'index.html' }));
    server.get('*', (req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });

    const httpServer = http.createServer(server);
    const handleError = (err) => {
      httpServer.removeListener('listening', handleListening);
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${APP_PORT} is already in use. Close the other program using it, ` +
              `or set SECONDBRAIN_PORT to a free port before launching.`
          )
        );
        return;
      }
      reject(err);
    };
    const handleListening = () => {
      httpServer.removeListener('error', handleError);
      localServer = httpServer;
      resolve(APP_ORIGIN + '/');
    };

    httpServer.once('error', handleError);
    httpServer.once('listening', handleListening);
    httpServer.listen(APP_PORT, '127.0.0.1');
  });
}

function stopLocalServer() {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
}

async function createWindow() {
  let url = 'http://localhost:3000';

  if (!isDev) {
    try {
      url = await startLocalServer();
    } catch (err) {
      console.error('[SecondBrain] Could not start local server:', err);
      dialog.showErrorBox(
        'SecondBrain could not start',
        `${err.message}\n\nNotes are stored per local origin, so the app cannot safely fall back to a different port.`
      );
      app.quit();
      return;
    }
  }

  // The desktop app always serves its assets from the local asar, so a
  // service-worker cache can only ever hold a stale copy after an update.
  // Clear the app shell cache (never localStorage, which holds the notes) so
  // a rebuilt .exe is visible on the very next launch. The PWA in a regular
  // browser keeps its own service worker -- this only affects Electron.
  try {
    // service workers only: Cache Storage also holds the downloaded speech
    // model, and the page drops the stale app-shell caches itself
    await session.defaultSession.clearStorageData({
      origin: APP_ORIGIN,
      storages: ['serviceworkers'],
    });
  } catch (err) {
    console.warn('[SecondBrain] Could not clear cached app shell:', err);
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'SecondBrain Local - Ollama GPT-OSS:20B',
    backgroundColor: '#09090b',
    icon: path.join(__dirname, '..', 'public', 'pwa-512x512.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    autoHideMenuBar: true,
  });

  // the microphone (voice input), for the app's own page only
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const own = (details.requestingUrl || '').startsWith(APP_ORIGIN) || isDev;
    callback(own && (permission === 'media' || permission === 'clipboard-sanitized-write'));
  });

  mainWindow.loadURL(url).catch((err) => {
    console.error('[SecondBrain] Failed to load app window:', err);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    agentBrowser?.close(); // the agent's browser goes with the app
  });

  // Handle external links safely
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
}

// Only the app's own page may ask about or start an update.
function fromApp(event) {
  try {
    return new URL(event.senderFrame.url).origin === APP_ORIGIN || isDev;
  } catch {
    return false;
  }
}

// ---- settings ------------------------------------------------------------
let settings = null;
function getSettings() {
  return settings || (settings = new Settings(app.getPath('userData')));
}

// ---- notes as files ----------------------------------------------------
// The notes folder (default Documents\SecondBrain) is remembered in the
// settings. Changes other programs make there are announced to the window,
// which reloads them.
let vault = null;
let watcher = null;
let changeTimer = null;

function vaultDir() {
  return getSettings().get('vaultDir') || path.join(app.getPath('documents'), 'SecondBrain');
}

function openVault(dir) {
  vault = new Vault(dir);
  if (watcher) watcher.close();
  try {
    watcher = fs.watch(dir, () => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        if (mainWindow) mainWindow.webContents.send('vault:changed');
      }, 400);
    });
  } catch {
    watcher = null;
  }
  return vault;
}

function getVault() {
  return vault || openVault(vaultDir());
}

function guard(event) {
  if (!fromApp(event)) throw new Error('not allowed');
}

ipcMain.handle('vault:info', (event) => {
  guard(event);
  return { dir: getVault().dir };
});
ipcMain.handle('vault:load', (event) => {
  guard(event);
  return getVault().load();
});
ipcMain.handle('vault:save', (event, note) => {
  guard(event);
  getVault().save(note);
  return true;
});
ipcMain.handle('vault:remove', (event, id) => {
  guard(event);
  getVault().remove(id);
  return true;
});
ipcMain.handle('vault:reveal', (event) => {
  guard(event);
  return shell.openPath(getVault().dir);
});
ipcMain.handle('vault:choose', async (event) => {
  guard(event);
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the folder SecondBrain keeps notes in',
    defaultPath: getVault().dir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { dir: getVault().dir, changed: false };
  getSettings().set('vaultDir', r.filePaths[0]);
  openVault(r.filePaths[0]);
  return { dir: vault.dir, changed: true };
});
// Documents from anywhere on the PC: the Windows file picker, or paths
// dropped on the window. Each becomes a note file in the vault.
ipcMain.handle('vault:import', async (event, dropped) => {
  guard(event);
  let files = Array.isArray(dropped) ? dropped.filter((p) => typeof p === 'string' && path.isAbsolute(p)) : [];
  if (!files.length) {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Import documents as notes',
      defaultPath: app.getPath('documents'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: SUPPORTED.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (r.canceled) return { imported: [], skipped: [] };
    files = r.filePaths;
  }
  const imported = [];
  const skipped = [];
  for (const f of files) {
    try {
      // an agentskills.io skill (SKILL.md) becomes a skill the agent can use
      if (path.basename(f).toLowerCase() === 'skill.md') {
        const skill = memory.fromSkillMd(fs.readFileSync(f, 'utf8'));
        if (skill) {
          getVault().save(skill);
          imported.push({ id: skill.id, title: `skill: ${skill.title}` });
          continue;
        }
      }
      const r = importFile(f);
      if (r.note) {
        getVault().save(r.note);
        imported.push({ id: r.note.id, title: r.note.title });
      } else {
        skipped.push({ file: f, why: r.why });
      }
    } catch (e) {
      skipped.push({ file: f, why: e.message });
    }
  }
  return { imported, skipped };
});

// ---- settings for the page (secrets masked) ------------------------------
const PAGE_SECTIONS = ['inbox', 'agent', 'telegram', 'terminal', 'voice', 'browser', 'computer'];
ipcMain.handle('settings:get', (event) => {
  guard(event);
  return getSettings().public();
});
ipcMain.handle('settings:set', (event, section, value) => {
  guard(event);
  if (!PAGE_SECTIONS.includes(section) || !value || typeof value !== 'object') throw new Error('not a setting');
  // a masked token coming back from the page means "unchanged"
  if (section === 'telegram' && typeof value.token === 'string' && value.token.startsWith('••••')) delete value.token;
  getSettings().set(section, value);
  for (const fn of settingsListeners) fn(section);
  return getSettings().public();
});
const settingsListeners = [];

// ---- inbox: notes from the private bridge repo ---------------------------
let inboxState = { last: null, error: null, running: false };
let inboxTimer = null;

async function syncInbox() {
  const clone = getSettings().get('inbox').clone;
  if (!clone || inboxState.running) return inboxState;
  inboxState = { ...inboxState, running: true };
  try {
    const r = await inbox.sync(clone, getVault());
    inboxState = { last: r, error: null, running: false };
    if (r.filed.length && mainWindow) mainWindow.webContents.send('vault:changed');
  } catch (e) {
    inboxState = { ...inboxState, error: e.message, running: false };
  }
  if (mainWindow) mainWindow.webContents.send('inbox:status', inboxStatus());
  return inboxState;
}

function inboxStatus() {
  const s = getSettings().get('inbox');
  return { clone: s.clone, every: s.every, ...inboxState };
}

function scheduleInbox() {
  clearInterval(inboxTimer);
  const s = getSettings().get('inbox');
  if (s.clone) inboxTimer = setInterval(syncInbox, Math.max(1, Number(s.every) || 5) * 60000);
}
settingsListeners.push((section) => section === 'inbox' && scheduleInbox());

ipcMain.handle('inbox:status', (event) => {
  guard(event);
  return inboxStatus();
});
ipcMain.handle('inbox:sync', async (event) => {
  guard(event);
  await syncInbox();
  return inboxStatus();
});
ipcMain.handle('inbox:connect', async (event) => {
  guard(event);
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Where should the secondbrain-bridge folder go? (an existing clone works too)',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return inboxStatus();
  const { dir } = await inbox.connect(r.filePaths[0]);
  getSettings().set('inbox', { clone: dir });
  scheduleInbox();
  await syncInbox();
  return inboxStatus();
});
// ---- report back: a status note pushed to the bridge's outbox -------------
async function sendReport(note) {
  const st = getSettings().get();
  if (!st.inbox.clone) throw new Error('connect the inbox first');
  getAgent(); // its plugins start the MCP servers
  if (!getMcp().status().length && Object.keys(getMcp().readConfig()).length) await connectMcp().catch(() => {});
  let ollama = { ok: false, error: '', models: [] };
  try {
    const r = await fetch(`${String(st.agent.host).replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
    ollama = { ok: r.ok, error: r.ok ? '' : `HTTP ${r.status}`, models: r.ok ? (await r.json()).models || [] : [] };
  } catch (e) {
    ollama.error = e.message;
  }
  let notes = null;
  try {
    notes = getVault().load().length;
  } catch {
    /* counted as ? */
  }
  const info = updater.buildInfo();
  const text = report.scrub(
    report.build({ build: info, settings: st, inbox: inboxStatus(), mcp: getMcp().status(), ollama, notes, note }),
    [st.telegram.token, st.share.key]
  );
  const r = await report.push(st.inbox.clone, text, { buildNo: info.build });
  getSettings().set('inbox', { reportedBuild: info.build });
  return { ...r, text };
}
ipcMain.handle('report:send', async (event, note) => {
  guard(event);
  return sendReport(typeof note === 'string' ? note : '');
});

ipcMain.handle('inbox:disconnect', (event) => {
  guard(event);
  getSettings().set('inbox', { clone: null });
  scheduleInbox();
  return inboxStatus();
});

// ---- the agent -----------------------------------------------------------
let agent = null;
function getAgent() {
  if (!agent) {
    agent = new AgentService({
      getVault,
      getModel: () => getSettings().get('agent'),
      emit: (channel, payload) => mainWindow && mainWindow.webContents.send(channel, payload),
      extras: (opts) => Promise.all(agentExtras.map((fn) => fn(opts))).then((xs) => xs.flat()),
    });
    for (const fn of agentPlugins) fn(agent);
  }
  return agent;
}
// later features add tools (agentPlugins) and system prompt parts (agentExtras)
const agentPlugins = [
  (a) => a.registry.add(memory.tools),
  (a) => a.registry.add(sched.tools(getSchedules)),
  () => connectMcp().catch((e) => console.error("[SecondBrain] mcp:", e)),
  (a) => a.registry.add(subagents.tools(getAgent)),
  () => applyTerminal(),
  () => applyBrowser(),
  () => applyComputer(),
];

// terminal access: the tool exists only while the user has it switched on
function applyTerminal() {
  const a = getAgent();
  a.registry.remove('terminal_');
  if (getSettings().get('terminal').enabled) a.registry.add(terminal.tools(() => getSettings().get('terminal')));
}
// browser control: its own window, tools only while switched on
let agentBrowser = null;
const getBrowser = () => (agentBrowser ||= new browser.AgentBrowser(require('electron')));
function applyBrowser() {
  const a = getAgent();
  a.registry.remove('browser_');
  const cfg = () => getSettings().get('browser');
  if (cfg().enabled) a.registry.add(browser.tools(getBrowser, cfg));
  else agentBrowser?.close();
}
// computer use: screen, mouse and keyboard through a vision model
let computerRuntime = null;
const getComputer = () =>
  (computerRuntime ||= new ComputerRuntime(require('electron'), {
    getConfig: () => getSettings().get('computer'),
    getHost: () => getSettings().get('agent').host,
    getMainWindow: () => mainWindow,
  }));
function applyComputer() {
  const a = getAgent();
  a.registry.remove('computer_');
  a.registry.remove('screen_');
  const cfg = () => getSettings().get('computer');
  if (cfg().enabled) a.registry.add(computer.tools(getComputer, cfg));
  else computerRuntime?.stop();
}

// the Ollama models that can see (Ollama lists "vision" among a model's capabilities)
ipcMain.handle('computer:models', async (event) => {
  guard(event);
  const host = String(getSettings().get('agent').host || 'http://localhost:11434').replace(/\/+$/, '');
  const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
  const { models = [] } = await r.json();
  return models
    .filter((m) => (Array.isArray(m.capabilities) ? m.capabilities.includes('vision') : /vl\b|-vl|vision|llava|gemma3|qwen3\.5|minicpm-v|moondream/i.test(m.name)))
    .map((m) => m.name);
});

const agentExtras = [() => memory.extras(getVault())];

ipcMain.handle('agent:send', (event, text, sessionId, model) => {
  guard(event);
  if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to send');
  if (model && typeof model === 'object') {
    const { host, model: name } = model;
    if (typeof host === 'string' && typeof name === 'string') getSettings().set('agent', { host, model: name });
  }
  const id = sessionId || require('./agent/agent.cjs').newSessionId();
  getAgent().ask({ text, sessionId: id, source: 'app' });
  return { sessionId: id };
});
ipcMain.handle('agent:sessions', (event) => {
  guard(event);
  return getAgent().list();
});
ipcMain.handle('agent:open', (event, id) => {
  guard(event);
  return getAgent().open(id);
});
ipcMain.handle('agent:stop', (event, id) => {
  guard(event);
  getAgent().stop(id);
  return true;
});
ipcMain.handle('agent:approve', (event, id, allow, always) => {
  guard(event);
  return getAgent().answerApproval(id, allow, always);
});
ipcMain.handle('agent:tools', (event) => {
  guard(event);
  return getAgent().registry.schemas().map((t) => ({ name: t.function.name, description: t.function.description }));
});

// ---- scheduled automations ------------------------------------------------
let schedules = null;
function getSchedules() {
  return schedules || (schedules = new sched.Schedules(getVault));
}
// other features register ways to deliver a result (Telegram)
const deliverers = {};
let schedulerTimer = null;
let schedulerBusy = false;

async function schedulerTick() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    for (const s of getSchedules().due()) {
      await sched.runSchedule(s, { schedules: getSchedules(), agent: getAgent(), vault: getVault(), deliverers });
      if (mainWindow) mainWindow.webContents.send('vault:changed');
    }
  } catch (e) {
    console.error('[SecondBrain] scheduler:', e);
  } finally {
    schedulerBusy = false;
  }
}

function schedulesView() {
  return getSchedules().all().map((s) => ({ ...s, whenLabel: sched.describeWhen(s.when) }));
}

ipcMain.handle('schedules:list', (event) => {
  guard(event);
  return schedulesView();
});
ipcMain.handle('schedules:add', (event, spec) => {
  guard(event);
  getSchedules().add(spec || {});
  return schedulesView();
});
ipcMain.handle('schedules:update', (event, id, patch) => {
  guard(event);
  const allowed = {};
  if (patch && typeof patch.enabled === 'boolean') allowed.enabled = patch.enabled;
  getSchedules().update(id, allowed);
  return schedulesView();
});
ipcMain.handle('schedules:remove', (event, id) => {
  guard(event);
  getSchedules().remove(id);
  return schedulesView();
});
ipcMain.handle('schedules:run', async (event, id) => {
  guard(event);
  const s = getSchedules().all().find((x) => x.id === id);
  if (!s) throw new Error('no such schedule');
  const r = await sched.runSchedule(s, { schedules: getSchedules(), agent: getAgent(), vault: getVault(), deliverers });
  if (mainWindow) mainWindow.webContents.send('vault:changed');
  return { note: r.id, ok: r.ok, schedules: schedulesView() };
});

// ---- MCP client: other tool servers' tools ---------------------------------
let mcp = null;
function getMcp() {
  return mcp || (mcp = new McpClient(getVault));
}
async function connectMcp() {
  const tools = await getMcp().connect();
  const a = getAgent();
  a.registry.remove('mcp__');
  a.registry.add(tools);
  return getMcp().status();
}

ipcMain.handle('mcp:get', (event) => {
  guard(event);
  return { config: getMcp().rawConfig(), file: getMcp().file(), status: getMcp().status() };
});
ipcMain.handle('mcp:save', async (event, text) => {
  guard(event);
  getMcp().writeConfig(String(text));
  return { config: getMcp().rawConfig(), file: getMcp().file(), status: await connectMcp() };
});
ipcMain.handle('mcp:reconnect', async (event) => {
  guard(event);
  return { config: getMcp().rawConfig(), file: getMcp().file(), status: await connectMcp() };
});

// ---- Telegram ----------------------------------------------------------------
let telegram = null;
function getTelegram() {
  if (!telegram) {
    telegram = new Telegram({
      getConfig: () => getSettings().get('telegram'),
      agent: getAgent(),
      onState: (st) => mainWindow && mainWindow.webContents.send('telegram:state', st),
      // tests point this at a fake Bot API; normally Telegram's own
      apiBase: process.env.SECONDBRAIN_TELEGRAM_API || undefined,
      transcribe: (buf, mime) => (telegramTranscriber ? telegramTranscriber(buf, mime) : Promise.reject(new Error('voice is not set up'))),
    });
  }
  return telegram;
}
// the voice feature provides speech-to-text for voice notes
let telegramTranscriber = null;
deliverers.telegram = (text) => getTelegram().broadcast(text);

async function restartTelegram() {
  getTelegram().stop();
  return getTelegram().start();
}
settingsListeners.push((section) => section === 'telegram' && restartTelegram());
settingsListeners.push((section) => section === 'terminal' && agent && applyTerminal());
settingsListeners.push((section) => section === 'browser' && agent && applyBrowser());
settingsListeners.push((section) => section === 'computer' && agent && applyComputer());

ipcMain.handle('telegram:state', (event) => {
  guard(event);
  return getTelegram().state();
});
ipcMain.handle('telegram:pair', (event, chatId, allow) => {
  guard(event);
  const cfg = getSettings().get('telegram');
  const id = String(chatId);
  const chats = new Set((cfg.allowedChats || []).map(String));
  if (allow) chats.add(id);
  else chats.delete(id);
  getSettings().set('telegram', { allowedChats: [...chats] });
  getTelegram().approvePairing(id);
  return getTelegram().state();
});
ipcMain.handle('telegram:test', async (event) => {
  guard(event);
  await getTelegram().broadcast('SecondBrain is connected to this chat.');
  return true;
});

// ---- voice: Telegram voice notes are transcribed by the page (Whisper) ----------
const voiceJobs = new Map();
telegramTranscriber = (buf, mime) =>
  new Promise((resolve, reject) => {
    if (!mainWindow) return reject(new Error('the SecondBrain window is closed'));
    const id = require('crypto').randomBytes(6).toString('hex');
    const timer = setTimeout(() => {
      voiceJobs.delete(id);
      reject(new Error('transcription timed out'));
    }, 300000);
    voiceJobs.set(id, { resolve, reject, timer });
    mainWindow.webContents.send('voice:transcribe', { id, bytes: buf.toString('base64'), mime });
  });
ipcMain.handle('voice:result', (event, id, text, error) => {
  guard(event);
  const job = voiceJobs.get(id);
  if (!job) return false;
  voiceJobs.delete(id);
  clearTimeout(job.timer);
  if (error) job.reject(new Error(error));
  else job.resolve(String(text || ''));
  return true;
});

// ---- the Atlas bridge ---------------------------------------------------------
// SecondBrain → Atlas: atlas-mcp in the MCP client. Atlas/Manjuel → SecondBrain:
// POST /mcp on this app's loopback origin, with a bearer key.
async function serveMcp(req, res) {
  const share = getSettings().get('share');
  if (!share.enabled) return res.status(404).json({ error: 'sharing is off (SecondBrain → Settings → Share with Atlas)' });
  const host = String(req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return res.status(421).json({ error: 'loopback only' });
  if (!atlas.keyOk(req.headers.authorization, share.key)) return res.status(401).json({ error: 'a bearer key is required' });
  try {
    const ctx = { vault: getVault(), source: 'atlas', touched: () => mainWindow && mainWindow.webContents.send('vault:changed') };
    const out = await atlas.handleMcp(req.body, { registry: getAgent().registry, ctx, writes: Boolean(share.writes) });
    if (out === null) return res.status(202).end();
    res.json(out);
  } catch (e) {
    res.status(500).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: e.message } });
  }
}

function shareView(reveal = false) {
  const s = getSettings().get('share');
  return {
    enabled: Boolean(s.enabled),
    writes: Boolean(s.writes),
    url: `${APP_ORIGIN}/mcp`,
    key: reveal ? s.key : s.key ? `••••${s.key.slice(-4)}` : '',
  };
}

ipcMain.handle('share:get', (event, reveal) => {
  guard(event);
  return shareView(Boolean(reveal));
});
ipcMain.handle('share:set', (event, patch) => {
  guard(event);
  const s = getSettings().get('share');
  const next = {};
  if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch && typeof patch.writes === 'boolean') next.writes = patch.writes;
  if ((next.enabled && !s.key) || (patch && patch.rotate)) next.key = require('crypto').randomBytes(24).toString('hex');
  getSettings().set('share', next);
  return shareView(Boolean(patch && patch.rotate));
});
ipcMain.handle('dialog:pick', async (event, kind, title) => {
  guard(event);
  const r = await dialog.showOpenDialog(mainWindow, {
    title: String(title || 'Choose'),
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
    filters: kind === 'exe' ? [{ name: 'Programs', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }] : undefined,
  });
  return r.canceled ? null : r.filePaths[0] || null;
});
ipcMain.handle('atlas:connect', async (event, opts) => {
  guard(event);
  const entry = atlas.atlasServer(opts || {});
  getMcp().writeConfig(atlas.withAtlas(getMcp().rawConfig(), entry));
  return { config: getMcp().rawConfig(), file: getMcp().file(), status: await connectMcp() };
});

ipcMain.handle('desktop:version', (event) => (fromApp(event) ? updater.buildInfo() : null));
ipcMain.handle('desktop:check-update', (event) => {
  if (!fromApp(event)) throw new Error('not allowed');
  return updater.check();
});
ipcMain.handle('desktop:apply-update', (event) => {
  if (!fromApp(event)) throw new Error('not allowed');
  return updater.apply();
});

app.setAppUserModelId('com.secondbrain.local');

// A second launch must focus the existing window instead of opening a second
// server (and a second localStorage bucket) on the same fixed port.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    scheduleInbox();
    setTimeout(syncInbox, 3000);
    // first start of a new build: report back, if the user asked for that
    setTimeout(() => {
      const ib = getSettings().get('inbox');
      const b = updater.buildInfo().build;
      if (ib.reportOnUpdate && ib.clone && b && b !== ib.reportedBuild) sendReport('(sent automatically after the update)').catch((e) => console.error('[SecondBrain] report:', e.message));
    }, 45000);
    // automations: check every 30s; missed runs catch up shortly after start
    schedulerTimer = setInterval(schedulerTick, 30000);
    setTimeout(() => getTelegram().start(), 2000);
    setTimeout(schedulerTick, 15000);
    // downloads from past updates (the hand-over cannot delete its own exe)
    const asar = process.noAsar;
    process.noAsar = true; // an old build's app.asar is a file to delete
    try {
      const tmp = app.getPath('temp');
      for (const name of fs.readdirSync(tmp)) {
        const p = path.join(tmp, name);
        if (name.startsWith('secondbrain-update-') && Date.now() - fs.statSync(p).mtimeMs > 3600000) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      }
    } catch {
      /* best effort */
    } finally {
      process.noAsar = asar;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  stopLocalServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (mcp) mcp.stopAll();
  if (telegram) telegram.stop();
  stopLocalServer();
});
