const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../vaultfs.cjs');
const { Schedules, parseWhen, nextRun, runSchedule, describeWhen } = require('./schedules.cjs');

const at = (s) => new Date(s).getTime(); // local time

test('when: the accepted forms, and a clear error otherwise', () => {
  assert.deepEqual(parseWhen('Daily 8:30'), { type: 'daily', time: '08:30' });
  assert.deepEqual(parseWhen('weekdays 17:00'), { type: 'weekdays', time: '17:00' });
  assert.deepEqual(parseWhen('weekly Monday 09:00'), { type: 'weekly', day: 'mon', time: '09:00' });
  assert.deepEqual(parseWhen('every 3h'), { type: 'every', minutes: 180 });
  assert.deepEqual(parseWhen('every 30 minutes'), { type: 'every', minutes: 30 });
  assert.equal(parseWhen('once 2026-10-23 09:00').type, 'once');
  assert.throws(() => parseWhen('every 2m'), /at least 5 minutes/);
  assert.throws(() => parseWhen('daily 25:00'), /bad time/);
  assert.throws(() => parseWhen('sometimes'), /must look like/);
  assert.equal(describeWhen(parseWhen('every 2h')), 'every 2 h');
});

test('next run times', () => {
  const wed0800 = at('2026-10-21T08:00:00'); // a Wednesday
  assert.equal(nextRun(parseWhen('daily 08:30'), wed0800), at('2026-10-21T08:30:00'));
  assert.equal(nextRun(parseWhen('daily 07:30'), wed0800), at('2026-10-22T07:30:00'));
  const fri1800 = at('2026-10-23T18:00:00');
  assert.equal(nextRun(parseWhen('weekdays 08:30'), fri1800), at('2026-10-26T08:30:00'), 'skips the weekend');
  assert.equal(nextRun(parseWhen('weekly mon 09:00'), wed0800), at('2026-10-26T09:00:00'));
  assert.equal(nextRun(parseWhen('every 3h'), wed0800), wed0800 + 3 * 3600000);
  assert.equal(nextRun(parseWhen('once 2026-10-21 07:00'), wed0800), null, 'a past one-off never runs');
});

test('a run files a note, refuses risky tools, reschedules; missed runs catch up; one-offs end', async () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')));
  const schedules = new Schedules(() => vault);
  const t0 = at('2026-10-21T08:00:00');
  const s = schedules.add({ name: 'Morning digest', prompt: 'summarize my todo', when: 'daily 08:30', deliver: ['note', 'telegram'] }, t0);
  assert.equal(schedules.due(t0).length, 0);
  // the app was closed at 08:30; it opens at 10:00 the same day: one catch-up run
  const t1 = at('2026-10-21T10:00:00');
  assert.deepEqual(schedules.due(t1).map((x) => x.id), [s.id]);
  let approved = null;
  let sent = null;
  const agent = {
    ask: async ({ text, source, approve, save }) => {
      approved = await approve('terminal_run', {}, 'rm -rf');
      assert.equal(source, 'schedule');
      assert.equal(save, false);
      return { answer: `digest for: ${text}` };
    },
  };
  const r = await runSchedule(schedules.due(t1)[0], { schedules, agent, vault, now: t1, deliverers: { telegram: async (m) => (sent = m) } });
  assert.equal(approved, false, 'risky tools are refused unattended');
  assert.match(sent, /Morning digest\n\ndigest for: summarize my todo/);
  const note = vault.load().find((n) => n.id === r.id);
  assert.ok(note.tags.includes('automation'));
  assert.match(note.content, /digest for: summarize my todo/);
  const after = schedules.all()[0];
  assert.equal(after.lastResult, 'ok');
  assert.equal(after.next, at('2026-10-22T08:30:00'));
  assert.equal(schedules.due(t1).length, 0, 'no second run the same day');

  const once = schedules.add({ name: 'Reminder', prompt: 'x', when: 'once 2026-10-21 11:00' }, t1);
  await runSchedule(once, { schedules, agent, vault, now: at('2026-10-21T11:00:00') });
  assert.equal(schedules.all().find((x) => x.id === once.id).enabled, false);

  schedules.update('morning digest', { enabled: false });
  assert.equal(schedules.due(at('2026-10-30T09:00:00')).length, 0, 'paused schedules do not run');
  schedules.remove(s.id);
  assert.equal(schedules.all().length, 1);
});
