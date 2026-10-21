/**
 * The inbox: notes Claude (or anyone with access) writes into the private
 * secondbrain-bridge repository's inbox/ folder land in the vault.
 *
 * The app keeps a local clone and pulls it with the user's own git (their
 * credentials, nothing stored here). Each inbox note is filed into the vault
 * once; if it changes upstream it is filed again. What was filed, and at
 * which content hash, is remembered in <vault>/.secondbrain/inbox.json.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseFile } = require('./vaultfs.cjs');

const REPO = 'https://github.com/thebrotherscarr-bit/secondbrain-bridge.git';
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function git(args, cwd, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() })
    );
  });
}

function isClone(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, '.git'));
}

/** Clone the bridge repo into `parent` (or use the clone already there). */
async function connect(parent, repo = REPO) {
  const dir = path.basename(parent).toLowerCase() === 'secondbrain-bridge' && isClone(parent)
    ? parent
    : path.join(parent, 'secondbrain-bridge');
  if (isClone(dir)) return { dir, cloned: false };
  const r = await git(['clone', repo, dir], parent, 300000);
  if (!r.ok) throw new Error(`git clone failed: ${r.err}`);
  return { dir, cloned: true };
}

function ledgerFile(vault) {
  return path.join(vault.dir, '.secondbrain', 'inbox.json');
}

function readLedger(vault) {
  try {
    return JSON.parse(fs.readFileSync(ledgerFile(vault), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Pull, then file every new or changed inbox note into the vault.
 * `pull: false` skips git (for tests and for an offline sync).
 */
async function sync(clone, vault, { pull = true } = {}) {
  if (!isClone(clone)) throw new Error(`no bridge clone at ${clone}`);
  let pulled = null;
  if (pull) {
    const r = await git(['pull', '--ff-only', '--quiet'], clone);
    pulled = r.ok ? 'ok' : r.err;
  }
  const dir = path.join(clone, 'inbox');
  const ledger = readLedger(vault);
  const filed = [];
  const skipped = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      if (ledger[name] === hash) continue;
      const base = name.slice(0, -3).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '') || 'inbox-note';
      const note = parseFile(raw, ID.test(base) ? base : `inbox-${crypto.randomBytes(3).toString('hex')}`, Date.now());
      if (!note.tags.includes('inbox')) note.tags = [...note.tags, 'inbox'];
      try {
        vault.save(note);
        ledger[name] = hash;
        filed.push({ id: note.id, title: note.title });
      } catch (e) {
        skipped.push({ file: name, why: e.message });
      }
    }
  }
  fs.mkdirSync(path.dirname(ledgerFile(vault)), { recursive: true });
  fs.writeFileSync(ledgerFile(vault), JSON.stringify(ledger, null, 2));
  return { pulled, filed, skipped, at: new Date().toISOString() };
}

module.exports = { connect, sync, isClone, git, REPO };
