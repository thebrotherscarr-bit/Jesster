/**
 * Real mouse and keyboard input for computer use, with nothing to install.
 *
 * Windows: one PowerShell process, kept open while a task runs, compiles a
 * small SendInput helper once and then takes one command per line. It is
 * DPI-aware, so positions are physical screen pixels.
 * Linux: xdotool, if present.
 */
const { spawn, execFileSync } = require('child_process');

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, super: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  printscreen: 0x2c, capslock: 0x14, menu: 0x5d,
};
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i;

/** "ctrl+shift+t" → Windows virtual-key codes, in press order. */
function vkCodes(keys) {
  return String(keys)
    .toLowerCase()
    .replace(/\s+/g, '')
    .split('+')
    .filter(Boolean)
    .map((k) => {
      if (k.startsWith('arrow')) k = k.slice(5);
      if (VK[k] != null) return VK[k];
      if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
      throw new Error(`unknown key "${k}"`);
    });
}

const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class SbInput {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  static uint Send(INPUT i) { return SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static uint Mouse(uint flags, int data) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); return Send(i); }
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5D; }
  static uint KeyEv(ushort vk, bool up) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = (up ? 2u : 0u) | (Extended(vk) ? 1u : 0u); return Send(i); }
  public static void Init() { SetProcessDPIAware(); }
  public static string Pos() { POINT p; GetCursorPos(out p); return p.X + " " + p.Y; }
  public static uint Click(int x, int y, int button, int count) {
    SetCursorPos(x, y); Thread.Sleep(40);
    uint down = button == 2 ? 0x8u : 0x2u, up = button == 2 ? 0x10u : 0x4u, sent = 0;
    for (int n = 0; n < count; n++) { sent += Mouse(down, 0); Thread.Sleep(20); sent += Mouse(up, 0); Thread.Sleep(60); }
    return sent;
  }
  public static uint Scroll(int x, int y, int notches) { SetCursorPos(x, y); Thread.Sleep(40); return Mouse(0x800, notches * 120); }
  public static uint Combo(int[] vks) {
    uint sent = 0;
    foreach (int v in vks) { sent += KeyEv((ushort)v, false); Thread.Sleep(15); }
    for (int n = vks.Length - 1; n >= 0; n--) { sent += KeyEv((ushort)vks[n], true); Thread.Sleep(15); }
    return sent;
  }
  public static uint Text(string s) {
    uint sent = 0;
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { sent += Combo(new int[] { 0x0D }); continue; }
      INPUT d = new INPUT(); d.type = 1; d.u.ki.wScan = c; d.u.ki.dwFlags = 4;
      INPUT u = new INPUT(); u.type = 1; u.u.ki.wScan = c; u.u.ki.dwFlags = 6;
      sent += Send(d); sent += Send(u); Thread.Sleep(8);
    }
    return sent;
  }
}`;

const LOOP = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CSHARP}
'@
[SbInput]::Init()
[Console]::Out.WriteLine('ready')
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($l -eq $null -or $l -eq 'quit') { break }
  try {
    $p = $l.Split(' ')
    $r = switch ($p[0]) {
      'click'  { [SbInput]::Click([int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4]) }
      'scroll' { [SbInput]::Scroll([int]$p[1], [int]$p[2], [int]$p[3]) }
      'combo'  { [SbInput]::Combo([int[]]($p[1].Split(','))) }
      'text'   { [SbInput]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
      'pos'    { [SbInput]::Pos() }
      default  { throw "unknown command $($p[0])" }
    }
    [Console]::Out.WriteLine("ok $r")
  } catch {
    [Console]::Out.WriteLine('err ' + $_.Exception.Message)
  }
}
`;

class WindowsInput {
  constructor() {
    this.proc = null;
    this.queue = [];
    this.buf = '';
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    const encoded = Buffer.from(LOOP, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    this.proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`the input helper did not start. ${err}`)), 30000);
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (d) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (line === 'ready') {
            clearTimeout(t);
            resolve();
          } else if (line) this.queue.shift()?.(line);
        }
      });
      this.proc.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`the input helper stopped (${code}). ${err}`));
        for (const w of this.queue.splice(0)) w(`err the input helper stopped. ${err}`);
        this.ready = null;
        this.proc = null;
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  async send(line) {
    await this.start();
    const reply = await new Promise((resolve) => {
      this.queue.push(resolve);
      this.proc.stdin.write(`${line}\n`);
    });
    if (reply.startsWith('err')) throw new Error(reply.slice(4));
    const out = reply.slice(3);
    // SendInput reports 0 when Windows blocked the input (e.g. a UAC prompt or the lock screen is up)
    if (/^(click|scroll|combo|text)/.test(line) && out.trim() === '0') throw new Error('Windows did not accept the input (an admin window, UAC prompt or the lock screen may be in front)');
    return out;
  }

  click(x, y, { button = 'left', double = false } = {}) {
    return this.send(`click ${Math.round(x)} ${Math.round(y)} ${button === 'right' ? 2 : 1} ${double ? 2 : 1}`);
  }

  scroll(x, y, notches) {
    return this.send(`scroll ${Math.round(x)} ${Math.round(y)} ${Math.round(notches)}`);
  }

  key(keys) {
    return this.send(`combo ${vkCodes(keys).join(',')}`);
  }

  type(text) {
    return this.send(`text ${Buffer.from(String(text), 'utf8').toString('base64')}`);
  }

  pos() {
    return this.send('pos');
  }

  close() {
    if (this.proc) {
      try {
        this.proc.stdin.write('quit\n');
        this.proc.stdin.end();
      } catch {
        /* gone */
      }
      const p = this.proc;
      setTimeout(() => p.kill(), 2000).unref?.();
    }
    this.proc = null;
    this.ready = null;
  }
}

const XKEYS = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', win: 'super', meta: 'super', super: 'super', cmd: 'super', enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', insert: 'Insert', space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', printscreen: 'Print', capslock: 'Caps_Lock', menu: 'Menu' };

class XdotoolInput {
  run(...a) {
    execFileSync('xdotool', a, { stdio: 'ignore' });
  }
  async click(x, y, { button = 'left', double = false } = {}) {
    this.run('mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '--repeat', double ? '2' : '1', button === 'right' ? '3' : '1');
  }
  async scroll(x, y, notches) {
    this.run('mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '--repeat', String(Math.abs(notches)), notches > 0 ? '4' : '5');
  }
  async key(keys) {
    const k = String(keys).toLowerCase().replace(/\s+/g, '').split('+').map((p) => XKEYS[p.replace(/^arrow/, '')] || (/^f\d+$/.test(p) ? p.toUpperCase() : p));
    this.run('key', k.join('+'));
  }
  async type(text) {
    this.run('type', '--delay', '8', '--', String(text));
  }
  close() {}
}

function inputDriver() {
  if (process.platform === 'win32') return new WindowsInput();
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' });
    return new XdotoolInput();
  } catch {
    throw new Error('computer use needs Windows (or xdotool on Linux)');
  }
}

module.exports = { inputDriver, vkCodes, WindowsInput, LOOP };
