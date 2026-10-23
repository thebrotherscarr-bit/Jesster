/**
 * Terminal access for the agent. Off until the user turns it on in Settings.
 * Every command is shown to the user exactly and runs only after Allow (in
 * the window, or with the Telegram buttons); scheduled runs are always
 * refused. Commands that look destructive are flagged on the approval card.
 * Each command has a time limit; on timeout the whole process tree is
 * stopped. Output is captured (the tail, if long) with the exit code.
 */
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT = 120;

const DANGER = [
  [/\brm\s+(-\w*r\w*f|-\w*f\w*r)\b|\brm\s+-rf?\b/i, 'deletes files recursively'],
  [/\b(Remove-Item|del|rd|rmdir|erase)\b[^\n]*(-Recurse|\/s\b)/i, 'deletes folders recursively'],
  [/\b(format|mkfs|diskpart|fdisk)\b/i, 'touches disks or partitions'],
  [/\b(shutdown|Restart-Computer|Stop-Computer|reboot)\b/i, 'shuts down or restarts the PC'],
  [/\b(reg\s+delete|Remove-ItemProperty)\b/i, 'edits the registry'],
  [/\bgit\s+(push\s+[^\n]*--force|reset\s+--hard|clean\s+-\w*f)/i, 'rewrites or discards git work'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sh|bash|iex|Invoke-Expression)\b/i, 'runs a script from the internet'],
  [/\b(Set-ExecutionPolicy|bcdedit|takeown|icacls)\b/i, 'changes system security settings'],
];

function warnings(command) {
  return DANGER.filter(([re]) => re.test(command)).map(([, why]) => why);
}

function shellFor(cfgShell) {
  if (cfgShell) return { cmd: cfgShell, args: (c) => (/powershell|pwsh/i.test(cfgShell) ? ['-NoProfile', '-NonInteractive', '-Command', c] : ['-c', c]) };
  if (process.platform === 'win32') return { cmd: 'powershell.exe', args: (c) => ['-NoProfile', '-NonInteractive', '-Command', c] };
  return { cmd: '/bin/bash', args: (c) => ['-lc', c] };
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** Run one command; resolves { code, output, timedOut }. */
function run(command, { cwd, timeout = DEFAULT_TIMEOUT, shell } = {}) {
  const sh = shellFor(shell);
  return new Promise((resolve) => {
    const child = spawn(sh.cmd, sh.args(command), {
      cwd: cwd || os.homedir(),
      windowsHide: true,
      detached: process.platform !== 'win32', // its own process group, so the tree can be stopped
      env: process.env,
    });
    let out = '';
    const add = (d) => {
      out += d;
      if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, Math.min(Number(timeout) || DEFAULT_TIMEOUT, 1800)) * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: e.message, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = String(out);
      resolve({
        code: timedOut ? null : code,
        output: text.length > MAX_OUTPUT ? `…(${text.length - MAX_OUTPUT} earlier characters cut)\n${text.slice(-MAX_OUTPUT)}` : text,
        timedOut,
      });
    });
  });
}

function tools(getConfig) {
  return [
    {
      name: 'terminal_run',
      description: `Run a command in ${process.platform === 'win32' ? 'PowerShell' : 'bash'} on the user's PC. The user sees the exact command and must approve it. Returns the exit code and output. Prefer read-only commands; explain what a command will do before running anything that changes things.`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'working folder (default: home)' },
          timeout_s: { type: 'integer', description: `seconds before it is stopped (default ${DEFAULT_TIMEOUT}, max 1800)` },
        },
        required: ['command'],
      },
      risky: true,
      describe: ({ command, cwd }) => {
        const w = warnings(String(command || ''));
        return `${w.length ? `⚠ This ${w.join(', ')}.\n\n` : ''}${cwd ? `in ${cwd}\n` : ''}${command}`;
      },
      run: async ({ command, cwd, timeout_s }) => {
        const cfg = getConfig();
        if (!cfg.enabled) throw new Error('terminal access is off (Settings → Terminal)');
        if (!command || !String(command).trim()) throw new Error('no command');
        const r = await run(String(command), { cwd, timeout: timeout_s, shell: cfg.shell });
        return `${r.timedOut ? 'TIMED OUT (stopped)' : `exit code ${r.code}`}\n${r.output || '(no output)'}`;
      },
    },
  ];
}

module.exports = { tools, run, warnings };
