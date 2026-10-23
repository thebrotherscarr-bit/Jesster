/**
 * The door's shared helpers, ported from atlas/line (Go): the spawn contract
 * (tools/spawn.go), the walls (gitstate.go dial/envFileSays/truthy), receipts,
 * and JSON written the way Go's encoding/json writes it, so an answer read off
 * this door reads the same as one read off atlas-mcp.exe.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn: spawnChild } = require('child_process');

// ---- JSON as Go writes it -----------------------------------------------------
//
// Go sorts a map's keys and keeps a struct's fields in declaration order. A
// plain object here is a map; one made with struct() keeps its order. Go also
// escapes <, > and & (and U+2028/U+2029) unless told not to (projectsJSON).

const STRUCTS = new WeakSet();

/** An object whose keys keep their order when written, like a Go struct. */
function struct(obj) {
  STRUCTS.add(obj);
  return obj;
}

function goValue(v) {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(goValue);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const keys = STRUCTS.has(v) ? Object.keys(v) : Object.keys(v).sort();
    const out = {};
    for (const k of keys) {
      if (STRUCTS.has(v) && v[k] === undefined) continue; // omitempty, as the struct declared it
      out[k] = goValue(v[k]);
    }
    return out;
  }
  return v;
}

function htmlEscape(s) {
  return s.replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** json.MarshalIndent(v, "", indent); escapeHTML false is SetEscapeHTML(false). */
function marshal(v, indent = ' ', escapeHTML = true) {
  const s = JSON.stringify(goValue(v), null, indent || undefined);
  return escapeHTML ? htmlEscape(s) : s;
}

/** json.Marshal(v): one line. */
function marshalLine(v) {
  return htmlEscape(JSON.stringify(goValue(v)));
}

/** Go's %q for an ordinary string. */
function q(s) {
  return JSON.stringify(String(s ?? ''));
}

// ---- receipts and text -----------------------------------------------------------

function sha256Bytes(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

function sha256File(p) {
  try {
    return sha256Bytes(fs.readFileSync(p));
  } catch {
    return '';
  }
}

function runeLen(s) {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
}

function truncateRunes(s, n) {
  const r = Array.from(s);
  return r.length <= n ? s : r.slice(0, n).join('');
}

function firstLines(s, n) {
  return String(s).replace(/[\r\n]+$/, '').split('\n').slice(0, n).join('\n');
}

/** RFC3339 in UTC, to the second, as Go's time.RFC3339 prints a UTC time. */
function rfc3339(d = new Date()) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Read a file as Go's os.ReadFile then string(b) would, or null. */
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function isMissing(err) {
  return err && err.code === 'ENOENT';
}

/** proofs.go readable: a missing file is a sentence, not a stack trace. */
function readable(err) {
  if (isMissing(err)) return 'never run in this world';
  return `unreadable: ${err && err.message ? err.message : err}`;
}

// ---- the walls ----------------------------------------------------------------------
//
// gitstate.go dial: one dial looked up, a boolean back; no value is ever returned,
// logged or printed (RULE 7). The process environment first, then the world's
// .env and the one a level up, with the MANJUEL_ and CHAINKIT_ spellings.

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
}

function envFileSays(file, name) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (line.startsWith('export ')) line = line.slice('export '.length);
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    if (key !== `MANJUEL_${name}` && key !== `CHAINKIT_${name}`) continue;
    if (truthy(line.slice(i + 1).trim().replace(/^["']+|["']+$/g, ''))) return true;
  }
  return false;
}

function dial(home, name, env = process.env) {
  for (const k of [`MANJUEL_${name}`, `CHAINKIT_${name}`]) if (truthy(env[k])) return true;
  for (const dir of [home, path.dirname(home)]) if (envFileSays(path.join(dir, '.env'), name)) return true;
  return false;
}

// ---- the spawn contract ---------------------------------------------------------
//
// stdin closed, bounded (120 s unless chosen), both streams kept, a timeout said
// by name. Resolves; never rejects.

const SPAWN_DEFAULT_TIMEOUT = 120000;

function spawn(name, args, opts = {}) {
  const timeout = opts.timeout > 0 ? opts.timeout : SPAWN_DEFAULT_TIMEOUT;
  return new Promise((resolve) => {
    let child;
    const env = opts.env && opts.env.length ? { ...process.env, ...envPairs(opts.env) } : process.env;
    try {
      child = spawnChild(name, args, { cwd: opts.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ stdout: '', stderr: '', combined: '', err: e, timedOut: false });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* gone */
      }
    }, timeout);
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    let spawnErr = null;
    child.on('error', (e) => {
      spawnErr = e;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      let combined = stdout;
      if (stderr) {
        if (combined && !combined.endsWith('\n')) combined += '\n';
        combined += stderr;
      }
      let e = null;
      if (spawnErr) e = new Error(spawnErr.code === 'ENOENT' ? `exec: ${q(name)}: executable file not found in %PATH%` : spawnErr.message);
      else if (code !== 0) e = new Error(signal ? `signal: ${signal}` : `exit status ${code}`);
      if (timedOut) e = new Error(`REFUSED — ${name} did not finish inside ${Math.floor(timeout / 1000)}s. Nothing is claimed.`);
      resolve({ stdout, stderr, combined, err: e, timedOut });
    });
  });
}

function envPairs(list) {
  const out = {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/** git can never stop for a human this process cannot show to anyone. */
function gitEnv() {
  return ['GIT_TERMINAL_PROMPT=0', 'GIT_PAGER=cat'];
}

// ---- arguments ---------------------------------------------------------------------

/**
 * Go's filepath.IsAbs: on Windows a path is absolute only with a volume
 * ("C:\x", "\\server\share"); "/x" is joined onto the root, as the door does.
 */
function goIsAbs(p, platform = process.platform) {
  p = String(p || '');
  if (platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return p.startsWith('/');
}

/** str(args, key): the string, or '' for anything that is not one. */
function str(args, key) {
  const v = args ? args[key] : undefined;
  return typeof v === 'string' ? v : '';
}

/** Go's `switch n := args[key].(type) { case float64 / int }`: a number, else 0. */
function num(args, key) {
  const v = args ? args[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

module.exports = {
  struct,
  marshal,
  marshalLine,
  q,
  sha256Bytes,
  sha256File,
  runeLen,
  truncateRunes,
  firstLines,
  rfc3339,
  readText,
  isMissing,
  readable,
  truthy,
  envFileSays,
  dial,
  spawn,
  gitEnv,
  goIsAbs,
  str,
  num,
  SPAWN_DEFAULT_TIMEOUT,
};
