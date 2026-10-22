const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const updater = require('./updater.cjs');
const fs = require('fs');
const { Vault, importFile, SUPPORTED } = require('./vaultfs.cjs');
const { Settings } = require('./settings.cjs');
const inbox = require('./inbox.cjs');
const { AgentService } = require('./agent/service.cjs');
const memory = require('./agent/memory.cjs');
const sched = require('./agent/schedules.cjs');

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
    await session.defaultSession.clearStorageData({
      origin: APP_ORIGIN,
      storages: ['serviceworkers', 'cachestorage'],
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

  mainWindow.loadURL(url).catch((err) => {
    console.error('[SecondBrain] Failed to load app window:', err);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
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
const PAGE_SECTIONS = ['inbox', 'agent', 'telegram', 'terminal', 'voice'];
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
const agentPlugins = [(a) => a.registry.add(memory.tools), (a) => a.registry.add(sched.tools(getSchedules))];
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
    // automations: check every 30s; missed runs catch up shortly after start
    schedulerTimer = setInterval(schedulerTick, 30000);
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
  stopLocalServer();
});
