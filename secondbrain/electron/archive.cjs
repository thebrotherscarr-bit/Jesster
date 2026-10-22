/**
 * The archive digger, driven from the app (Settings → Archive).
 *
 * The digging and distilling live in the notes kernel (notes/plugins/archive.py),
 * so Manjuel, Steward and Claude can run them too. The app starts the kernel as
 *
 *   python <notes/cli.py> --vault <this vault> rpc
 *
 * and calls archive.sources, archive.dig, archive.distill, archive.write and
 * archive.status over JSON-RPC on stdio. Distilling is a loop of short steps
 * the kernel saves after each, so Pause just stops asking and Stop ends the
 * kernel mid-step; either way the next Distill resumes where it left off.
 *
 * The kernel is found in the setting `archive.cli`, else beside the vault the
 * way a Manjuel ground lays it out: <ground>/worlds/notes is the vault and
 * <ground>/worlds/jesster/notes/cli.py the kernel.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const STEPS_PER_CALL = 1;

/** The kernel's cli.py: the setting, else worlds/jesster beside worlds/notes. */
function findCli(setting, vaultDir) {
  if (setting) return fs.existsSync(setting) ? setting : null;
  if (!vaultDir) return null;
  const guess = path.join(path.dirname(vaultDir), 'jesster', 'notes', 'cli.py');
  return fs.existsSync(guess) ? guess : null;
}

/** One kernel process, JSON-RPC 2.0 a line at a time. */
class KernelRpc {
  constructor({ python = 'python', cli, vaultDir, spawnFn = spawn }) {
    this.child = spawnFn(python, [cli, '--vault', vaultDir, 'rpc'], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    this.pending = new Map();
    this.next = 1;
    this.buf = '';
    this.err = '';
    this.closed = false;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', (d) => (this.err = (this.err + d).slice(-2000)));
    const fail = (e) => this.onClose(e);
    this.child.on('error', fail);
    this.child.on('close', (code) => fail(new Error(`the notes kernel stopped (exit ${code})${this.err ? ': ' + this.err.trim().split('\n').pop() : ''}`)));
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message);
        e.reason = msg.error.data && msg.error.data.reason;
        p.reject(e);
      } else p.resolve(msg.result);
    }
  }

  onClose(e) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('the notes kernel is not running'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  close() {
    if (this.closed) return;
    this.onClose(new Error('stopped'));
    try {
      this.child.kill();
    } catch {
      /* gone already */
    }
  }
}

/**
 * The digger as the panel sees it: one job at a time (dig, distill or write),
 * its progress, and pause/stop for distilling.
 */
class ArchiveRunner {
  constructor({ config, onState = () => {}, onNotes = () => {}, spawnFn }) {
    this.config = config; // () => { python, cli, vaultDir, model }
    this.onState = onState;
    this.onNotes = onNotes;
    this.spawnFn = spawnFn;
    this.kernel = null;
    this.state = { job: null, pausing: false, status: null, error: null, last: null };
  }

  emit(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
    return this.state;
  }

  rpc() {
    if (this.kernel && !this.kernel.closed) return this.kernel;
    const c = this.config();
    const cli = findCli(c.cli, c.vaultDir);
    if (!cli) throw new Error(c.cli ? `no notes kernel at ${c.cli}` : 'the notes kernel (notes/cli.py) was not found beside this vault: choose it in Settings → Archive');
    this.kernel = new KernelRpc({ python: c.python || 'python', cli, vaultDir: c.vaultDir, spawnFn: this.spawnFn });
    return this.kernel;
  }

  async call(method, params) {
    return this.rpc().call(method, params);
  }

  async status() {
    try {
      const s = await this.call('archive.status');
      return this.emit({ status: s, error: null }).status;
    } catch (e) {
      this.emit({ error: e.message });
      throw e;
    }
  }

  async sources(change) {
    const r = await this.call('archive.sources', change || {});
    await this.status();
    return r.sources;
  }

  async run(job, fn) {
    if (this.state.job) throw new Error(`already ${this.state.job}`);
    this.emit({ job, pausing: false, error: null });
    try {
      const out = await fn();
      this.emit({ last: { job, at: new Date().toISOString(), out } });
      return out;
    } catch (e) {
      if (e.message !== 'stopped') this.emit({ error: e.message });
      throw e;
    } finally {
      this.emit({ job: null, pausing: false });
      await this.status().catch(() => {});
    }
  }

  dig() {
    return this.run('digging', async () => {
      const r = await this.call('archive.dig');
      this.onNotes();
      return r;
    });
  }

  distill({ restart = false } = {}) {
    return this.run('distilling', async () => {
      const model = this.config().model || undefined;
      let p = await this.call('archive.distill', { steps: STEPS_PER_CALL, restart, model });
      this.emit({ status: { ...(this.state.status || {}), distill: p } });
      while (!p.finished && p.steps > 0 && !this.state.pausing) {
        p = await this.call('archive.distill', { steps: STEPS_PER_CALL, model });
        this.emit({ status: { ...(this.state.status || {}), distill: p } });
      }
      return p;
    });
  }

  write() {
    return this.run('writing', async () => {
      const r = await this.call('archive.write');
      this.onNotes();
      return r;
    });
  }

  /** Finish the step in hand, then stop asking. */
  pause() {
    if (this.state.job === 'distilling') this.emit({ pausing: true });
  }

  /** End the kernel now; the step in hand is lost, and redone next time. */
  stop() {
    if (this.kernel) this.kernel.close();
    this.kernel = null;
  }
}

/** The IPC the Archive settings section uses. */
function register({ ipcMain, guard, getSettings, vaultDir, send }) {
  const runner = new ArchiveRunner({
    config: () => ({ ...getSettings().get('archive'), vaultDir: vaultDir() }),
    onState: (s) => send('archive:state', s),
    onNotes: () => send('vault:changed'),
  });
  const view = () => {
    const a = getSettings().get('archive');
    return { ...a, found: findCli(a.cli, vaultDir()), state: runner.state };
  };
  const handle = (name, fn) =>
    ipcMain.handle(name, (event, ...args) => {
      guard(event);
      return fn(...args);
    });
  handle('archive:get', () => view());
  handle('archive:set', (patch) => {
    const next = {};
    for (const k of ['python', 'cli', 'model']) if (patch && typeof patch[k] === 'string') next[k] = patch[k].trim();
    getSettings().set('archive', next);
    runner.stop(); // the next call starts the kernel with the new settings
    return view();
  });
  handle('archive:status', () => runner.status());
  handle('archive:sources', (change) => runner.sources(change && { add: change.add || undefined, remove: change.remove || undefined }));
  handle('archive:dig', () => runner.dig());
  handle('archive:distill', (opts) => runner.distill({ restart: Boolean(opts && opts.restart) }));
  handle('archive:write', () => runner.write());
  handle('archive:pause', () => runner.pause());
  handle('archive:stop', () => runner.stop());
  return runner;
}

module.exports = { findCli, KernelRpc, ArchiveRunner, register };
