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
  // backend 'steward': the Agent tab talks to Steward (agent/steward.cjs); 'ollama': the local loop
  // check: Claude checks each Steward turn in the Agent tab (agent/checker.cjs), on the Integrations key
  // transport: how the Agent tab, the phone and the automations talk to Steward: 'ag-ui' (his AG-UI host on 43122,
  // agui.cjs; the default since 2026-11-05, the operator: "use it") or 'responses' (his service, steward.cjs), the latter
  // only once chosen in Settings (transportChosen; see stewardTransport)
  agent: { host: 'http://localhost:11434', model: 'gpt-oss:20b', maxSteps: 12, backend: 'steward', transport: 'ag-ui', steward: { dir: '', port: 43120 }, check: false },
  // off: turned off explicitly (set() keeps it with enabled); with the token from the ground's .env
  // (TELEGRAM_STEWARDBOT_KEY) Telegram runs unless off
  telegram: { token: '', allowedChats: [], enabled: false, off: false },
  discord: { token: '', allowedUsers: [], enabled: false }, // his own bot (agent/discord.cjs); allowedUsers: paired user ids
  // his own account, linked as a device (agent/whatsapp.cjs); its keys live in userData\whatsapp-auth, not here.
  // selfChat: answer in his "Message yourself" chat; allowedChats: other numbers he approved
  whatsapp: { enabled: false, allowedChats: [], selfChat: true },
  terminal: { enabled: false, shell: null, alwaysAllow: [] },
  voice: { speakReplies: false, whisperModel: '' }, // '' = whisper.cpp's model, found beside it
  browser: { enabled: false, askEachAction: true }, // the agent's own browser window
  computer: { enabled: false, askEachAction: true, model: 'qwen3-vl:8b', maxSteps: 25 }, // screen, mouse and keyboard
  share: { enabled: false, writes: false, key: '' }, // the notes over MCP for Atlas/Manjuel
  atlas: { exe: '', ground: '', python: 'python', engine: true, trusted: false, all: false }, // Settings → Atlas & Manjuel, remembered
  // the Estate's repositories, each relative to the ground (or absolute): read by the door's worlds (door/index.cjs
  // worldsFor) and the Estate's versions (agent/workflows.cjs estateRepos). Today's layout is the default (Steward
  // ADR-0020); a ground laid out otherwise names its folders here
  estate: { atlas: 'atlas', jesster: 'worlds/jesster', steward: 'worlds/steward' },
  // archive: the archive digger's settings, retired 2026-11-05 (ADR-0010); a stored one is left unread
  // the Servers shelf (services.cjs): SecondBrain runs `ollama serve` only when this is on, with this environment
  // pinned over its own; OLLAMA_MODELS '' keeps the one SecondBrain was started with (his User variable).
  // The environment variable SECONDBRAIN_RUNS_OLLAMA, read when SecondBrain starts, overrides `enabled`: 1 turns it on,
  // 0 forces it off (the Servers shelf's toggle then shows it as set there). OLLAMA_NO_CLOUD=1 turns off Ollama's cloud
  // features; OLLAMA_HOST=127.0.0.1 keeps it on loopback.
  services: {
    ollama: {
      enabled: false,
      env: { OLLAMA_HOST: '127.0.0.1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_KEEP_ALIVE: '30m', OLLAMA_NO_CLOUD: '1', OLLAMA_MODELS: '' },
    },
  },
  // Claude, ChatGPT, Gemini: API keys (secrets, like the Telegram token), models, keep exchanges as notes
  integrations: { anthropic: { key: '', model: 'claude-opus-5-5' }, openai: { key: '', model: '' }, google: { key: '', model: '' }, capture: true },
};

// the secrets public() masks, as [section, ...path]
const SECRETS = [['telegram', 'token'], ['discord', 'token'], ['share', 'key'], ['integrations', 'anthropic', 'key'], ['integrations', 'openai', 'key'], ['integrations', 'google', 'key']];
// a mask, or a mask with a token pasted onto it: never a real secret, so never stored
const isMask = (v) => typeof v === 'string' && v.includes('•');

/** A section's patch without any secret that carries public()'s mask: the stored value is kept. */
function dropMasks(section, value) {
  if (!value || typeof value !== 'object' || !SECRETS.some((p) => p[0] === section)) return value;
  const out = JSON.parse(JSON.stringify(value));
  for (const p of SECRETS) {
    if (p[0] !== section) continue;
    let o = out;
    for (const k of p.slice(1, -1)) o = o && typeof o === 'object' ? o[k] : undefined;
    const last = p[p.length - 1];
    if (o && typeof o === 'object' && isMask(o[last])) delete o[last];
  }
  return out;
}

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
    value = dropMasks(section, value);
    // Telegram's on/off, when set, is remembered as his: off stays off even with the .env's token
    if (section === 'telegram' && value && typeof value.enabled === 'boolean') value = { ...value, off: !value.enabled };
    this.data[section] = section in DEFAULTS && typeof DEFAULTS[section] === 'object' && DEFAULTS[section]
      ? merge(this.data[section] || DEFAULTS[section], value)
      : value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.data[section];
  }

  /** What the page may see: everything but secrets, which show as set/unset. telegramEnv: the .env's token, shown by its last four only. */
  public({ telegramEnv = '' } = {}) {
    const d = JSON.parse(JSON.stringify(this.data));
    const tg = telegramEffective(d.telegram, telegramEnv);
    d.telegram.enabled = tg.enabled;
    d.telegram.fromEnv = tg.from === 'env' ? telegramEnv.slice(-4) : '';
    d.telegram.token = d.telegram.token ? '••••••' + d.telegram.token.slice(-4) : '';
    d.discord.token = d.discord.token ? '••••••' + d.discord.token.slice(-4) : '';
    d.share.key = d.share.key ? '••••' + d.share.key.slice(-4) : '';
    for (const p of ['anthropic', 'openai', 'google']) d.integrations[p].key = d.integrations[p].key ? '••••' + d.integrations[p].key.slice(-4) : '';
    return d;
  }
}

/**
 * Telegram as it runs: the token Settings holds, else the ground's .env's (envToken); enabled as set, and on
 * when the token comes from .env and it was never turned off. from: 'settings' | 'env' | ''.
 */
function telegramEffective(tg, envToken = '') {
  const t = tg || {};
  const from = t.token ? 'settings' : envToken ? 'env' : '';
  const enabled = from === 'env' ? !t.off : t.enabled === true;
  return { ...t, token: t.token || envToken || '', enabled, from };
}

/**
 * The transport Steward is reached on: 'ag-ui' unless the operator chose Responses in Settings (transportChosen). A
 * 'responses' saved before AG-UI became the default (2026-11-05) was the old default written back with the rest of
 * the section, not a choice, so it reads as 'ag-ui'.
 */
function stewardTransport(agent) {
  const a = agent || {};
  return a.transport === 'responses' && a.transportChosen ? 'responses' : 'ag-ui';
}

/**
 * The folder of the Estate's repository `name` ('atlas', 'jesster', 'steward') under `ground`: Settings' estate entry
 * (`layout`), relative to the ground or absolute, else today's default.
 */
function estateDir(ground, layout, name) {
  const rel = (layout && typeof layout[name] === 'string' && layout[name]) || DEFAULTS.estate[name];
  return path.isAbsolute(rel) ? rel : path.join(ground, rel);
}

module.exports = { Settings, DEFAULTS, merge, telegramEffective, stewardTransport, estateDir };
