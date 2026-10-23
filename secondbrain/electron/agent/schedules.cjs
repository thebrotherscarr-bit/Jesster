/**
 * Scheduled automations: a prompt the agent runs on a schedule, with the
 * answer filed as a note (and, once Telegram is set up, sent there).
 *
 * Kept in <vault>/.secondbrain/schedules.json so they travel with the notes.
 * "when" is plain text:
 *   daily 08:30          weekdays 08:30        weekly mon 09:00
 *   every 3h             every 30m             once 2026-10-23 09:00
 * A run missed while the app was closed happens once when it next opens.
 * Nobody is there to approve risky tools during a scheduled run, so they
 * are refused.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parse a "when" string; throws with the accepted forms on nonsense. */
function parseWhen(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let m;
  const hm = (s) => {
    const x = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!x || +x[1] > 23 || +x[2] > 59) throw new Error(`bad time "${s}" (use HH:MM, 24-hour)`);
    return `${x[1].padStart(2, '0')}:${x[2]}`;
  };
  if ((m = /^daily (\S+)$/.exec(t))) return { type: 'daily', time: hm(m[1]) };
  if ((m = /^weekdays (\S+)$/.exec(t))) return { type: 'weekdays', time: hm(m[1]) };
  if ((m = /^weekly (\w{3})\w* (\S+)$/.exec(t)) && DAYS.includes(m[1])) return { type: 'weekly', day: m[1], time: hm(m[2]) };
  if ((m = /^every (\d+) ?(m|min|minutes?|h|hours?)$/.exec(t))) {
    const minutes = m[2].startsWith('h') ? +m[1] * 60 : +m[1];
    if (minutes < 5) throw new Error('every: at least 5 minutes');
    return { type: 'every', minutes };
  }
  if ((m = /^once (\d{4}-\d\d-\d\d)[ t](\d{1,2}:\d{2})$/.exec(t))) {
    const at = new Date(`${m[1]}T${hm(m[2])}:00`);
    if (Number.isNaN(at.getTime())) throw new Error('bad date');
    return { type: 'once', at: at.getTime() };
  }
  throw new Error('when must look like: "daily 08:30", "weekdays 08:30", "weekly mon 09:00", "every 3h", "every 30m" or "once 2026-10-23 09:00"');
}

function describeWhen(w) {
  if (w.type === 'daily') return `daily at ${w.time}`;
  if (w.type === 'weekdays') return `weekdays at ${w.time}`;
  if (w.type === 'weekly') return `every ${w.day} at ${w.time}`;
  if (w.type === 'every') return w.minutes % 60 ? `every ${w.minutes} min` : `every ${w.minutes / 60} h`;
  return `once at ${new Date(w.at).toLocaleString()}`;
}

/** The first run strictly after `from` (ms), or null when there is none. */
function nextRun(w, from) {
  if (w.type === 'once') return w.at > from ? w.at : null;
  if (w.type === 'every') return from + w.minutes * 60000;
  const [h, mi] = w.time.split(':').map(Number);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(h, mi);
  for (let i = 0; i < 8; i++) {
    const ok =
      w.type === 'daily' ||
      (w.type === 'weekdays' && d.getDay() >= 1 && d.getDay() <= 5) ||
      (w.type === 'weekly' && DAYS[d.getDay()] === w.day);
    if (ok && d.getTime() > from) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, mi, 0, 0);
  }
  return null;
}

class Schedules {
  constructor(getVault) {
    this.getVault = getVault;
  }

  file() {
    return path.join(this.getVault().dir, '.secondbrain', 'schedules.json');
  }

  all() {
    try {
      return JSON.parse(fs.readFileSync(this.file(), 'utf8'));
    } catch {
      return [];
    }
  }

  write(list) {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(list, null, 2));
  }

  add({ name, prompt, when, deliver = ['note'] }, now = Date.now()) {
    if (!name || !prompt) throw new Error('a schedule needs a name and a prompt');
    const w = parseWhen(when);
    const s = {
      id: crypto.randomBytes(4).toString('hex'),
      name: String(name).slice(0, 80),
      prompt: String(prompt),
      when: w,
      whenText: String(when),
      deliver: deliver.filter((d) => ['note', 'telegram'].includes(d)),
      enabled: true,
      created: now,
      lastRun: null,
      lastResult: null,
      next: nextRun(w, now),
    };
    this.write([...this.all(), s]);
    return s;
  }

  update(id, patch) {
    const list = this.all();
    const s = list.find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
    if (!s) throw new Error(`no schedule "${id}"`);
    Object.assign(s, patch);
    if ('enabled' in patch && patch.enabled && !s.next) s.next = nextRun(s.when, Date.now());
    this.write(list);
    return s;
  }

  remove(id) {
    const list = this.all();
    const keep = list.filter((x) => x.id !== id && x.name.toLowerCase() !== String(id).toLowerCase());
    if (keep.length === list.length) throw new Error(`no schedule "${id}"`);
    this.write(keep);
  }

  /** Schedules due at `now` (including ones missed while the app was closed). */
  due(now = Date.now()) {
    return this.all().filter((s) => s.enabled && s.next && s.next <= now);
  }
}

/** Run one schedule through the agent and file the result. */
async function runSchedule(s, { schedules, agent, vault, deliverers = {}, now = Date.now() }) {
  // claim it first, so a slow run is not started twice
  schedules.update(s.id, { next: nextRun(s.when, now), running: true });
  let answer;
  let ok = true;
  try {
    const r = await agent.ask({
      text: s.prompt,
      source: 'schedule',
      approve: async () => false, // nobody is watching: risky tools are refused
      save: false,
    });
    answer = r.answer;
    ok = !r.error;
  } catch (e) {
    answer = `Failed: ${e.message}`;
    ok = false;
  }
  const date = new Date(now);
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const id = `automation-${s.id}-${stamp}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
  if (s.deliver.includes('note')) {
    vault.save({
      id,
      title: `${s.name} — ${date.toLocaleString()}`,
      content: `> Automation **${s.name}** (${describeWhen(s.when)})\n> Prompt: ${s.prompt}\n\n${answer}`,
      tags: ['automation'],
      category: 'inbox',
      isPinned: false,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const d of s.deliver) {
    if (d !== 'note' && deliverers[d]) {
      try {
        await deliverers[d](`${s.name}\n\n${answer}`);
      } catch {
        /* a failed delivery is visible in lastResult below */
      }
    }
  }
  schedules.update(s.id, { running: false, lastRun: now, lastResult: ok ? 'ok' : answer.slice(0, 200) });
  if (s.when.type === 'once') schedules.update(s.id, { enabled: false, next: null });
  return { id, answer, ok };
}

function tools(getSchedules) {
  return [
    {
      name: 'schedule_create',
      description:
        'Schedule a prompt for yourself to run automatically; the answer is filed as a note. when: "daily 08:30", "weekdays 08:30", "weekly mon 09:00", "every 3h", "every 30m" or "once 2026-10-23 09:00". deliver: ["note"] and/or "telegram".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string', description: 'what to do each time, written as an instruction to yourself' },
          when: { type: 'string' },
          deliver: { type: 'array', items: { type: 'string', enum: ['note', 'telegram'] } },
        },
        required: ['name', 'prompt', 'when'],
      },
      run: (a) => {
        const s = getSchedules().add(a);
        return { created: s.name, id: s.id, when: describeWhen(s.when), next: new Date(s.next).toString() };
      },
    },
    {
      name: 'schedule_list',
      description: 'List scheduled automations.',
      parameters: { type: 'object', properties: {} },
      run: () =>
        getSchedules().all().map((s) => ({
          id: s.id, name: s.name, when: describeWhen(s.when), enabled: s.enabled, prompt: s.prompt,
          next: s.next ? new Date(s.next).toString() : null, lastRun: s.lastRun ? new Date(s.lastRun).toString() : null, lastResult: s.lastResult,
        })),
    },
    {
      name: 'schedule_remove',
      description: 'Delete a scheduled automation (by id or name).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: ({ id }) => {
        getSchedules().remove(id);
        return { removed: id };
      },
    },
    {
      name: 'schedule_set_enabled',
      description: 'Pause or resume a scheduled automation (by id or name).',
      parameters: { type: 'object', properties: { id: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['id', 'enabled'] },
      run: ({ id, enabled }) => {
        const s = getSchedules().update(id, { enabled });
        return { name: s.name, enabled: s.enabled };
      },
    },
  ];
}

module.exports = { Schedules, parseWhen, describeWhen, nextRun, runSchedule, tools };
