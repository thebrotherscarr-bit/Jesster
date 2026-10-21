// CI: unpack the release zip with the app's own unzip and compare every file
// with what was zipped. Usage: node electron/unzip.check.cjs <zip> <folder>
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const load = Module._load;
Module._load = (req, ...rest) => (req === 'electron' ? { app: {} } : load(req, ...rest));
const { unzip } = require('./updater.cjs');

const [zip, folder] = process.argv.slice(2);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-check-'));
const n = unzip(zip, out);
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.push(path.relative(base, p));
  }
  return acc;
}
const want = walk(folder);
const top = path.join(out, path.basename(folder));
let bad = 0;
for (const rel of want) {
  const got = path.join(top, rel);
  if (!fs.existsSync(got) || hash(got) !== hash(path.join(folder, rel))) {
    console.log(`MISMATCH ${rel}`);
    bad++;
  }
}
console.log(`unzip check: ${n} files unpacked, ${want.length} compared, ${bad} mismatched`);
process.exit(bad || n !== want.length ? 1 : 0);
