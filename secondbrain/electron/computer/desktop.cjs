/**
 * The desktop side of computer use: screenshots of the main screen, the
 * small always-on-top panel (what is happening, Allow / Deny / Stop), a ring
 * on the screen where a click will land, the Ctrl+Alt+Q stop key, and real
 * input. The panel never takes keyboard focus, so typing goes where the
 * vision model clicked. SecondBrain's own window is minimized while a task
 * runs and comes back after.
 */
const fs = require('fs');
const path = require('path');
const { runTask, lookOnce } = require('../agent/computer.cjs');
const { inputDriver } = require('./input.cjs');

const SHOT_WIDTH = 1280;
const STOP_KEY = 'CommandOrControl+Alt+Q';
const PANEL = { width: 380, height: 150, margin: 14 };

// For tests: SECONDBRAIN_INPUT_LOG records what would be done instead of doing it.
class RecordingInput {
  constructor(file) {
    this.file = file;
  }
  async rec(o) {
    fs.appendFileSync(this.file, `${JSON.stringify(o)}\n`);
  }
  click(x, y, o) {
    return this.rec({ do: 'click', x, y, ...o });
  }
  scroll(x, y, n) {
    return this.rec({ do: 'scroll', x, y, n });
  }
  key(keys) {
    return this.rec({ do: 'key', keys });
  }
  type(text) {
    return this.rec({ do: 'type', text });
  }
  close() {}
}

const RING = `data:text/html,${encodeURIComponent('<html><body style="margin:0;background:transparent"><svg width="56" height="56"><circle cx="28" cy="28" r="22" fill="none" stroke="#ef4444" stroke-width="4"/><circle cx="28" cy="28" r="3" fill="#ef4444"/></svg></body></html>')}`;

class ComputerRuntime {
  constructor(electron, { getConfig, getHost, getMainWindow }) {
    this.e = electron;
    this.getConfig = getConfig;
    this.getHost = getHost;
    this.getMainWindow = getMainWindow;
    this.running = null;
    this.panel = null;
    this.ring = null;
    this.answer = null;
    this.state = {};
    electron.ipcMain.on('computer:answer', (event, value) => {
      if (!this.panel || event.sender !== this.panel.webContents) return;
      if (value === 'stop') this.running?.abort();
      const a = this.answer;
      this.answer = null;
      a?.(value === 'allow');
    });
  }

  display() {
    return this.e.screen.getPrimaryDisplay();
  }

  /** 0-1000 screenshot position → a point on the screen (DIP). */
  point(x, y) {
    const b = this.display().bounds;
    return { x: Math.round(b.x + (x / 1000) * b.width), y: Math.round(b.y + (y / 1000) * b.height) };
  }

  /** A DIP point → what the input driver takes (physical pixels). */
  physical(p) {
    if (process.platform === 'win32' && this.e.screen.dipToScreenPoint) return this.e.screen.dipToScreenPoint(p);
    const s = this.display().scaleFactor || 1;
    return { x: Math.round(p.x * s), y: Math.round(p.y * s) };
  }

  async capture() {
    const d = this.display();
    const hide = [this.panel, this.ring].filter((w) => w && !w.isDestroyed() && w.isVisible());
    for (const w of hide) w.hide();
    if (hide.length) await new Promise((r) => setTimeout(r, 150));
    try {
      const full = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
      const sources = await this.e.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full });
      const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
      if (!src || src.thumbnail.isEmpty()) throw new Error('could not take a screenshot');
      let img = src.thumbnail;
      if (img.getSize().width > SHOT_WIDTH) img = img.resize({ width: SHOT_WIDTH, quality: 'good' });
      const size = img.getSize();
      return { image: img.toJPEG(80).toString('base64'), width: size.width, height: size.height };
    } finally {
      for (const w of hide) if (!w.isDestroyed()) w.showInactive();
    }
  }

  openPanel(task) {
    const { BrowserWindow } = this.e;
    const wa = this.display().workArea;
    this.panel = new BrowserWindow({
      width: PANEL.width,
      height: PANEL.height,
      x: wa.x + wa.width - PANEL.width - PANEL.margin,
      y: wa.y + wa.height - PANEL.height - PANEL.margin,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'panel-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.panel.setAlwaysOnTop(true, 'screen-saver');
    this.panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.panel.webContents.on('will-navigate', (e) => e.preventDefault());
    this.panel.loadFile(path.join(__dirname, 'panel.html')).then(() => this.show({}));
    this.panel.once('ready-to-show', () => this.panel?.showInactive());
    this.state = { task };
  }

  show(patch) {
    this.state = { ...this.state, ...patch };
    if (this.panel && !this.panel.isDestroyed()) this.panel.webContents.send('computer:state', this.state);
  }

  /** Keep the panel away from where the action lands. */
  dodge(p) {
    if (!this.panel || this.panel.isDestroyed()) return;
    const b = this.panel.getBounds();
    const pad = 30;
    if (p.x < b.x - pad || p.x > b.x + b.width + pad || p.y < b.y - pad || p.y > b.y + b.height + pad) return;
    const wa = this.display().workArea;
    const top = b.y > wa.y + wa.height / 2;
    this.panel.setBounds({ ...b, y: top ? wa.y + PANEL.margin : wa.y + wa.height - PANEL.height - PANEL.margin });
  }

  showRing(p) {
    const { BrowserWindow } = this.e;
    if (!this.ring || this.ring.isDestroyed()) {
      this.ring = new BrowserWindow({
        width: 56, height: 56, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true,
        alwaysOnTop: true, show: false, hasShadow: false, webPreferences: { sandbox: true, contextIsolation: true },
      });
      this.ring.setIgnoreMouseEvents(true);
      this.ring.setAlwaysOnTop(true, 'screen-saver');
      this.ring.loadURL(RING);
    }
    this.ring.setBounds({ x: p.x - 28, y: p.y - 28, width: 56, height: 56 });
    this.ring.showInactive();
  }

  hideRing() {
    if (this.ring && !this.ring.isDestroyed()) this.ring.hide();
  }

  closeWindows() {
    for (const w of [this.panel, this.ring]) if (w && !w.isDestroyed()) w.destroy();
    this.panel = null;
    this.ring = null;
  }

  async run(task, ctx) {
    if (this.running) throw new Error('a computer task is already running');
    const cfg = this.getConfig();
    const stop = new AbortController();
    this.running = stop;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, stop.signal]) : stop.signal;
    signal.addEventListener('abort', () => {
      const a = this.answer;
      this.answer = null;
      a?.(false);
    });
    const input = process.env.SECONDBRAIN_INPUT_LOG ? new RecordingInput(process.env.SECONDBRAIN_INPUT_LOG) : inputDriver();
    const main = this.getMainWindow();
    const wasVisible = main && !main.isDestroyed() && main.isVisible() && !main.isMinimized();
    this.e.globalShortcut.register(STOP_KEY, () => stop.abort());
    const inApp = !ctx.source || ctx.source === 'app';
    try {
      if (wasVisible) main.minimize();
      this.openPanel(task);
      await new Promise((r) => setTimeout(r, 400));
      const desk = {
        capture: () => this.capture(),
        status: (text) => this.show({ text, asking: false }),
        ask: async (name, a, summary) => {
          const p = a.x != null ? this.point(a.x, a.y) : null;
          if (p) {
            this.dodge(p);
            this.showRing(p);
          }
          try {
            if (cfg.askEachAction === false) {
              this.show({ text: summary, asking: false });
              await new Promise((r) => setTimeout(r, 500));
              return true;
            }
            if (!inApp) {
              this.show({ text: `${summary}\n\nWaiting for your OK in ${ctx.source}…`, asking: false });
              return await ctx.approve(`computer_${name}`, a, summary);
            }
            this.show({ text: summary, asking: true });
            return await new Promise((resolve) => (this.answer = resolve));
          } finally {
            this.hideRing();
            this.show({ asking: false });
          }
        },
        act: async (name, a) => {
          const p = a.x != null ? this.physical(this.point(a.x, a.y)) : null;
          if (name === 'click') await input.click(p.x, p.y, { button: a.button === 'right' ? 'right' : 'left', double: Boolean(a.double) });
          else if (name === 'scroll') await input.scroll(p.x, p.y, (a.direction === 'up' ? 1 : -1) * Math.max(1, Math.min(Number(a.amount) || 3, 10)));
          else if (name === 'type') await input.type(String(a.text ?? ''));
          else if (name === 'key') await input.key(String(a.keys || ''));
        },
      };
      return await runTask({ task, host: this.getHost(), model: cfg.model || 'qwen3-vl:8b', desk, signal, maxSteps: cfg.maxSteps || 25 });
    } finally {
      this.e.globalShortcut.unregister(STOP_KEY);
      input.close();
      this.closeWindows();
      if (wasVisible && !main.isDestroyed()) main.restore();
      this.running = null;
    }
  }

  async look(question, ctx) {
    const { image } = await this.capture();
    return lookOnce({ question, host: this.getHost(), model: this.getConfig().model || 'qwen3-vl:8b', image, signal: ctx.signal });
  }

  stop() {
    this.running?.abort();
  }
}

module.exports = { ComputerRuntime };
