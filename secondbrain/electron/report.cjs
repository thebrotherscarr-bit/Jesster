/**
 * Report back: a short status note pushed to the private bridge repo's
 * outbox/ folder, so Claude (working from the other side) can see how the
 * app on this PC is doing without screenshots.
 *
 * Only when the user presses the button (or, if they switch it on, once
 * after each update). Pushed with the user's own git login. It holds the
 * build, what is switched on and connected, tool counts and errors; never
 * keys or tokens, and the home folder shows as ~.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, isClone } = require('./inbox.cjs');

const FILE = 'outbox/status.md';

/** Remove anything secret-looking, and the user's home path. */
function scrub(text, secrets = []) {
  let s = String(text);
  for (const k of secrets.filter((x) => x && x.length >= 6)) s = s.split(k).join('[hidden]');
  const home = os.homedir();
  if (home && home.length > 3) s = s.split(home).join('~');
  return s
    .replace(/\b(bot)?\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[hidden]') // telegram tokens
    .replace(/\b(gh[pousr]_|github_pat_|sk-|xox[bp]-)[A-Za-z0-9_-]{10,}/g, '[hidden]')
    .replace(/\b[a-f0-9]{40,}\b/gi, '[hidden]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[hidden]');
}

const yes = (b) => (b ? 'on' : 'off');

/** The note, from what the app knows. */
function build(info) {
  const { build: b, settings: st, inbox, mcp = [], ollama, notes, note } = info;
  const lines = [
    '---',
    `title: ${JSON.stringify(`SecondBrain status · build ${b.build}`)}`,
    'tags: ["report"]',
    '---',
    `# SecondBrain status · build ${b.build}`,
    '',
    `- When: ${new Date().toISOString()}`,
    `- Build: ${b.build} (${b.commit || 'dev'}) · ${os.platform()} ${os.release()} · Electron ${process.versions.electron || '-'}`,
    `- Notes in the vault: ${notes ?? '?'}`,
    `- Inbox: ${inbox.clone ? `every ${inbox.every} min · ${inbox.running ? 'syncing right now' : inbox.error ? `last sync failed: ${inbox.error}` : inbox.last ? `last sync ${inbox.last.at}, filed ${inbox.last.filed.length}` : 'not synced yet'}` : 'not connected'}`,
    '',
    '## Model',
    `- Ollama ${st.agent.host}: ${ollama.ok ? 'answering' : `NOT answering (${ollama.error})`}`,
    `- Chat model: ${st.agent.model}${ollama.ok && !ollama.models.some((m) => m.name === st.agent.model) ? ' (NOT in Ollama)' : ''}`,
    `- Vision model: ${st.computer.model}${ollama.ok && !ollama.models.some((m) => m.name === st.computer.model) ? ' (NOT in Ollama)' : ''}`,
    ...(ollama.ok ? [`- Ollama has: ${ollama.models.map((m) => `${m.name}${m.capabilities?.includes('vision') ? ' (sees)' : ''}`).join(', ') || 'nothing'}`] : []),
    '',
    '## Switched on',
    `- Terminal ${yes(st.terminal.enabled)} · Browser ${yes(st.browser.enabled)}${st.browser.enabled ? ` (ask each: ${yes(st.browser.askEachAction !== false)})` : ''} · Computer use ${yes(st.computer.enabled)}${st.computer.enabled ? ` (ask each: ${yes(st.computer.askEachAction !== false)})` : ''}`,
    `- Telegram ${yes(st.telegram.enabled)}${st.telegram.token ? '' : ' (no bot token)'} · paired chats: ${(st.telegram.allowedChats || []).length}`,
    `- Voice replies ${yes(st.voice.speakReplies)} · Whisper ${st.voice.whisperModel}`,
    `- Share with Atlas & Manjuel ${yes(st.share.enabled)}${st.share.enabled ? ` (writes ${yes(st.share.writes)})` : ''}`,
    '',
    '## MCP servers',
    ...(mcp.length
      ? mcp.map((s) => `- ${s.name}: ${s.status}${s.status === 'connected' ? ` · ${s.offered ?? s.tools.length} of ${s.tools.length} tools offered` : ''}${s.trusted ? ' · trusted' : ''}${s.error ? ` · error: ${s.error.slice(0, 300)}` : ''}`)
      : ['- none']),
  ];
  if (note && String(note).trim()) lines.push('', '## Note from the user', '', String(note).trim().slice(0, 4000));
  return `${lines.join('\n')}\n`;
}

/** Write the note into the clone, commit it, push it. */
async function push(clone, text, { buildNo }) {
  if (!isClone(clone)) throw new Error('connect the inbox first (Settings → Inbox)');
  await git(['pull', '--rebase', '--quiet'], clone);
  const file = path.join(clone, FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const add = await git(['add', FILE], clone);
  if (!add.ok) throw new Error(`git add failed: ${add.err}`);
  // a commit needs a name; use one only if the user's git has none
  const who = (await git(['config', 'user.email'], clone)).out ? [] : ['-c', 'user.name=SecondBrain', '-c', 'user.email=secondbrain@localhost'];
  const commit = await git([...who, 'commit', '--quiet', '-m', `report: build ${buildNo}`], clone);
  if (!commit.ok && !/nothing to commit/.test(`${commit.out} ${commit.err}`)) throw new Error(`git commit failed: ${commit.err || commit.out}`);
  let r = await git(['push', '--quiet'], clone, 120000);
  if (!r.ok) {
    // someone pushed meanwhile: take theirs, then ours on top
    await git(['pull', '--rebase', '--quiet'], clone);
    r = await git(['push', '--quiet'], clone, 120000);
  }
  if (!r.ok) throw new Error(`git push failed: ${r.err}`);
  return { file: FILE, at: new Date().toISOString() };
}

module.exports = { build, push, scrub, FILE };
