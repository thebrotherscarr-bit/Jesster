/**
 * The phone's conversations with Steward (the operator, 2026-11-04: "so we know like 'this is the pc' and 'this is the
 * phone'"): every exchange from a phone channel, kept as it happened, for the Phone view.
 *
 *   - log(file): one JSONL line per thing said or asked (the user's text, Steward's reply, a card, its answer), the
 *     newest CAP lines kept; read newest-first, listed by conversation (channel + chat).
 *   - chatSessions(file, channel): which Steward session each chat continues, kept in a small JSON file so a restart
 *     carries on the same conversation (Telegram's map was in memory only).
 *
 * The shape is the channel's, not Telegram's: { channel: 'telegram' | 'whatsapp' | 'discord', chatId, title }, so the
 * others plug in the same way. Only Telegram writes here today.
 */
const fs = require('fs');
const path = require('path');

const CAP = 5000;
const CHANNELS = ['telegram', 'whatsapp', 'discord'];
const LABELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', discord: 'Discord' };

/** The capped log. `onAppend(entry)` is told of each line written (the window's live update). */
function log(file, { cap = CAP, onAppend = () => {} } = {}) {
  let count = null; // lines on disk, counted once
  const lines = () => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const entries = () =>
    lines()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  function append(entry) {
    const e = { at: new Date().toISOString(), ...entry, chatId: String(entry.chatId) };
    if (!CHANNELS.includes(e.channel)) throw new Error(`not a phone channel: ${e.channel}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (count === null) count = lines().length;
    fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
    count += 1;
    if (count > cap) {
      const kept = lines().slice(-cap);
      fs.writeFileSync(file, kept.map((l) => `${l}\n`).join(''));
      count = kept.length;
    }
    try {
      onAppend(e);
    } catch {
      /* the line is kept whether or not the window heard of it */
    }
    return e;
  }
  /** One conversation's lines, newest first (at most `limit`). */
  function read(channel, chatId, limit = 500) {
    const id = String(chatId);
    return entries()
      .filter((e) => e.channel === channel && e.chatId === id)
      .reverse()
      .slice(0, limit);
  }
  /** Every conversation, the most recent first: its title (the latest one given), when it last moved and its last line. */
  function list() {
    const by = new Map();
    for (const e of entries()) {
      const key = `${e.channel}:${e.chatId}`;
      const c = by.get(key) || { channel: e.channel, chatId: e.chatId, title: '', at: e.at, last: '', count: 0 };
      if (e.title) c.title = e.title;
      c.at = e.at;
      if (e.text) c.last = String(e.text).slice(0, 120);
      c.count += 1;
      by.delete(key); // re-inserted, so the map's order is the order each conversation last moved
      by.set(key, c);
    }
    // Lines written in the same millisecond share a time: the stable sort then keeps file order, latest first.
    return [...by.values()].reverse().map((c) => ({ ...c, label: `${LABELS[c.channel]} · ${c.title || c.chatId}` })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  return { append, read, list, file };
}

/** chat id -> Steward session id for one channel, kept across restarts; the Map methods Telegram uses. */
function chatSessions(file, channel) {
  const readAll = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (all) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  };
  const key = (chatId) => `${channel}:${chatId}`;
  return {
    get: (chatId) => readAll()[key(chatId)],
    has: (chatId) => key(chatId) in readAll(),
    set(chatId, sessionId) {
      const all = readAll();
      all[key(chatId)] = sessionId;
      write(all);
      return this;
    },
    delete(chatId) {
      const all = readAll();
      const had = key(chatId) in all;
      delete all[key(chatId)];
      write(all);
      return had;
    },
  };
}

module.exports = { log, chatSessions, CAP, CHANNELS, LABELS };
