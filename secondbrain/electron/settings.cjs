/**
 * App settings, in <userData>\settings.json. One small JSON file; every
 * feature reads its section and nothing else. Secrets (a Telegram bot token)
 * live here too: in the user's own profile, never in the vault folder.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  vaultDir: null, // null: Documents\SecondBrain
  inbox: { clone: null, every: 5, reportOnUpdate: false, reportedBuild: 0 }, // minutes between pulls; report back after updates
  agent: { host: 'http://localhost:11434', model: 'gpt-oss:20b', maxSteps: 12 },
  telegram: { token: '', allowedChats: [], enabled: false },
  terminal: { enabled: false, shell: null, alwaysAllow: [] },
  voice: { speakReplies: false, whisperModel: '' }, // '' = whisper.cpp's model, found beside it
  browser: { enabled: false, askEachAction: true }, // the agent's own browser window
  computer: { enabled: false, askEachAction: true, model: 'qwen3-vl:8b', maxSteps: 25 }, // screen, mouse and keyboard
  share: { enabled: false, writes: false, key: '' }, // the notes over MCP for Atlas/Manjuel
  atlas: { exe: '', ground: '', python: 'python', engine: true, trusted: false, all: false }, // Settings → Atlas & Manjuel, remembered
  archive: { python: 'python', cli: '', model: '' }, // the archive digger: the notes kernel's cli.py ('' = beside the vault)
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v;
  }
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = merge(DEFAULTS, {});
    try {
      this.data = merge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      /* first run */
    }
    // the notes folder used to be remembered in vault.json
    if (!this.data.vaultDir) {
      try {
        this.data.vaultDir = JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8')).dir || null;
      } catch {
        /* none */
      }
    }
  }

  get(section) {
    return section ? this.data[section] : this.data;
  }

  set(section, value) {
    this.data[section] = section in DEFAULTS && typeof DEFAULTS[section] === 'object' && DEFAULTS[section]
      ? merge(this.data[section] || DEFAULTS[section], value)
      : value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.data[section];
  }

  /** What the page may see: everything but secrets, which show as set/unset. */
  public() {
    const d = JSON.parse(JSON.stringify(this.data));
    d.telegram.token = d.telegram.token ? '••••••' + d.telegram.token.slice(-4) : '';
    d.share.key = d.share.key ? '••••' + d.share.key.slice(-4) : '';
    return d;
  }
}

module.exports = { Settings, DEFAULTS, merge };
