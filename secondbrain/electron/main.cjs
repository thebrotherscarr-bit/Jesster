const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const updater = require('./updater.cjs');
const fs = require('fs');
const { Vault, importFile, SUPPORTED } = require('./vaultfs.cjs');

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

// ---- notes as files ----------------------------------------------------
// The notes folder (default Documents\SecondBrain) is remembered in
// <userData>\vault.json. Changes other programs make there are announced
// to the window, which reloads them.
let vault = null;
let watcher = null;
let changeTimer = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'vault.json');
}

function vaultDir() {
  try {
    const dir = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).dir;
    if (dir) return dir;
  } catch {
    /* first run */
  }
  return path.join(app.getPath('documents'), 'SecondBrain');
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
  fs.writeFileSync(settingsFile(), JSON.stringify({ dir: r.filePaths[0] }, null, 2));
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
