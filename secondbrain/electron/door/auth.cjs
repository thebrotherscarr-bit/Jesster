/**
 * The door's scoped keys (N6), ported from atlas/line internal/auth and the
 * auth verbs in tools.go. Keys live in <world>/state/auth.json as hash and salt
 * only (an iterated HMAC-SHA256 under the domain atlas-auth-v1, the same KDF the
 * Go door verifies, so a key minted by either door verifies on both), with an
 * append-only audit line per create, revoke and scope. A plaintext key exists
 * once, in the answer that minted it. An empty store mints freely (the first
 * key is the operator's own hand); afterwards key management names a live key.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { struct, marshal, marshalLine, rfc3339, q, str } = require('./util.cjs');
const { regOf } = require('./registry.cjs');

const KEY_RE = /^atl_[0-9a-f]{32}$/;
const ITERS = 210000;
const DOMAIN = 'atlas-auth-v1';

const authPath = (home) => path.join(home, 'state', 'auth.json');
const auditPath = (home) => path.join(home, 'state', 'auth_audit.jsonl');

/**
 * HMAC-SHA256 keyed by the salt over the domain-bound key, iterated: auth.KDF.
 * The HMAC is written out (RFC 2104) with the padded key's hash states taken
 * once and copied per round, because a fresh createHmac per round costs four
 * seconds a derivation in Node; the bytes are the same (the golden stroke).
 */
function kdf(keyHex, saltHex, iters = ITERS) {
  let k = Buffer.from(saltHex, 'hex');
  if (k.length > 64) k = crypto.createHash('sha256').update(k).digest();
  const block = Buffer.alloc(64);
  k.copy(block);
  const inner = crypto.createHash('sha256').update(block.map((b) => b ^ 0x36));
  const outer = crypto.createHash('sha256').update(block.map((b) => b ^ 0x5c));
  const mac = (m) => outer.copy().update(inner.copy().update(m).digest()).digest();
  let sum = mac(Buffer.from(DOMAIN + keyHex));
  for (let i = 1; i < iters; i++) sum = mac(sum);
  return sum.toString('hex');
}

function load(home) {
  let text;
  try {
    text = fs.readFileSync(authPath(home), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { keys: [] };
    throw e;
  }
  const s = JSON.parse(text);
  return { keys: Array.isArray(s.keys) ? s.keys : [] };
}

function shape(k) {
  return struct({ id: k.id, name: k.name, hash: k.hash ?? '', salt: k.salt ?? '', tenants: k.tenants ?? null, created: k.created ?? '', revoked: k.revoked || undefined });
}

function save(home, s) {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const tmp = authPath(home) + '.tmp';
  fs.writeFileSync(tmp, marshal(struct({ keys: s.keys.length ? s.keys.map(shape) : null }), '  ') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, authPath(home));
}

function audit(home, action, kid, tenant, by) {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.appendFileSync(auditPath(home), marshalLine({ ts: rfc3339(), action, key_id: kid, tenant, by }) + '\n');
}

function empty(home) {
  let s;
  try {
    s = load(home);
  } catch {
    return true;
  }
  return !s.keys.some((k) => !k.revoked);
}

function create(home, name, tenants, by) {
  if (!name) throw new Error('auth needs a name for the key — unnamed keys are not minted');
  const key = 'atl_' + crypto.randomBytes(16).toString('hex');
  const kid = crypto.randomBytes(4).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = kdf(key, salt);
  const s = load(home);
  const rec = { id: 'k-' + kid, name, hash, salt, tenants: [...tenants], created: rfc3339() };
  s.keys.push(rec);
  save(home, s);
  try {
    audit(home, 'create', rec.id, tenants.join(','), by);
  } catch {
    /* the Go door ignores a failed audit on create */
  }
  return [key, rec];
}

function verify(home, key) {
  if (!KEY_RE.test(key)) throw new Error('refused: not a key');
  const s = load(home);
  for (const k of s.keys) {
    if (k.revoked) continue;
    let hash;
    try {
      hash = kdf(key, k.salt);
    } catch {
      continue;
    }
    const a = Buffer.from(hash);
    const b = Buffer.from(String(k.hash));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return k;
  }
  throw new Error('refused: unknown or revoked key');
}

function list(home) {
  let s;
  try {
    s = load(home);
  } catch {
    return [];
  }
  return s.keys.filter((k) => !k.revoked).map((k) => ({ ...k, hash: '', salt: '' }));
}

function revoke(home, id, by) {
  const s = load(home);
  for (const k of s.keys) {
    if (k.id === id && !k.revoked) {
      k.revoked = rfc3339();
      save(home, s);
      audit(home, 'revoke', id, (k.tenants || []).join(','), by);
      return;
    }
  }
  throw new Error(`refused: no live key ${q(id)}`);
}

function scope(home, id, tenants, by) {
  if (!tenants.length) throw new Error('refused: a key carries at least one tenant -- to carry none, revoke it');
  const s = load(home);
  for (const k of s.keys) {
    if (k.id !== id || k.revoked) continue;
    k.tenants = [...tenants];
    save(home, s);
    audit(home, 'scope', id, tenants.join(','), by);
    return { ...k, hash: '', salt: '' };
  }
  throw new Error(`refused: no live key ${q(id)}`);
}

// ---- the tools --------------------------------------------------------------------------

function authTenants(args) {
  return str(args, 'tenants')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Re-proof: on a non-empty store the caller names a live key, like sudo. */
function authExisting(t, args) {
  if (empty(t.home)) return;
  try {
    verify(t.home, str(args, 'key').trim());
  } catch {
    throw new Error('refused: key management names a live key — possession re-proved, like sudo');
  }
}

async function toolAuthCreate(t, args) {
  const name = str(args, 'name');
  authExisting(t, args);
  let tenants = authTenants(args);
  if (!tenants.length) tenants = [t.name];
  const [key, rec] = create(t.home, name.trim(), tenants, 'mcp');
  return `MINTED ${rec.id} for ${q(rec.name)} on ${q(t.name)} — copy it now, it never shows again\n${key}`;
}

async function toolAuthList(t) {
  const keys = list(t.home);
  if (!keys.length) return 'no live keys — the gate stands open (bootstrap)';
  let b = `KEYS on ${q(t.name)} — ${keys.length} live:\n`;
  for (const k of keys) b += `  ${k.id} ${q(k.name)} · tenants [${(k.tenants || []).join(',')}] · minted ${k.created}\n`;
  return b;
}

async function toolAuthRevoke(t, args) {
  const id = str(args, 'id').trim();
  if (!id) throw new Error('auth_key_revoke needs an id — see auth_key_list');
  authExisting(t, args);
  revoke(t.home, id, 'mcp');
  return `REVOKED ${id} on ${q(t.name)} — folded, kept for audit`;
}

async function toolAuthScope(t, args) {
  const id = str(args, 'id').trim();
  if (!id) throw new Error('auth_key_scope needs an id — see auth_key_list');
  const tenants = authTenants(args);
  if (!tenants.length) throw new Error('auth_key_scope needs the tenants the key is to carry, e.g. research,atlas');
  const reg = regOf(args);
  for (const name of tenants) {
    if (!reg || !reg.tenants.has(name)) throw new Error(`refused: ${q(name)} is not a carried tenant -- a key carries only grounds this door carries`);
  }
  authExisting(t, args);
  const rec = scope(t.home, id, tenants, 'mcp');
  return `SCOPED ${rec.id} ${q(rec.name)} on ${q(t.name)} — it carries [${rec.tenants.join(',')}] now; the move is in the audit line`;
}

async function toolAuthVerify(t, args) {
  const rec = verify(t.home, str(args, 'key').trim());
  return `VERIFIED ${rec.id} on ${q(t.name)} · tenants [${(rec.tenants || []).join(',')}]`;
}

const authTools = [
  { name: 'auth_key_create', writes: true, secrets: ['key'], description: 'mint a scoped API key; plaintext returns once (N6)', args: ['name', 'tenants?', 'key?', 'project?'], fn: toolAuthCreate },
  { name: 'auth_key_list', writes: false, description: 'list live keys with hashes withheld (N6)', args: ['project?'], fn: toolAuthList },
  { name: 'auth_key_revoke', writes: true, secrets: ['key'], description: 'fold a key: flagged, kept for audit (N6)', args: ['id', 'key?', 'project?'], fn: toolAuthRevoke },
  {
    name: 'auth_key_scope',
    writes: true,
    secrets: ['key'],
    description: 'set which carried tenants a live key carries, the list replaced whole; possession re-proved like create and revoke, and the move audited (N6)',
    args: ['id', 'tenants', 'key?', 'project?'],
    fn: toolAuthScope,
  },
  { name: 'auth_verify', writes: false, secrets: ['key'], description: 'check a key against a tenant store; the login door (N6)', args: ['key', 'project?'], fn: toolAuthVerify },
];

module.exports = { authTools, kdf, create, verify, list, revoke, scope, empty, KEY_RE, ITERS, DOMAIN };
