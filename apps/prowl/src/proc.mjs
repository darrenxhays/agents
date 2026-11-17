import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const WIN = process.platform === 'win32';
const QUIET = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };

/** `a` as one argument on a cmd.exe command line: in quotes when it is empty or has a space or a character cmd reads, a " inside it doubled. */
export const cmdArg = a => (a === '' || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

// On Windows, az and claude are often .cmd shims, which only start through a shell, so each argument is quoted for
// cmd.exe (cmdArg). Prompts go in through stdin, never as an argument. An .exe is started directly, its arguments
// as they are (gh's search terms and jq programs rely on that): a detached review started through cmd.exe can get
// a visible console window, and closing that window kills the review.
export function spawnCli(cmd, args, opts = {}) {
  const exe = WIN && windowsExe(cmd);
  const shell = WIN && !exe;
  return spawn(exe || cmd, shell ? args.map(cmdArg) : args, { shell, windowsHide: true, ...opts });
}

const exes = new Map();
/** The .exe that cmd.exe would run for `cmd`, or null when that is a .cmd shim or nothing (the shell reports it). */
function windowsExe(cmd) {
  if (!exes.has(cmd)) {
    let first;
    try { first = execFileSync('where', [cmd], QUIET).split(/\r?\n/).find(l => /\.(exe|com|cmd|bat)$/i.test(l)); } catch { /* not found */ }
    exes.set(cmd, /\.exe$/i.test(first || '') && fs.existsSync(first) ? first : null);
  }
  return exes.get(cmd);
}

/** Runs a CLI to completion and resolves with its stdout. `opts`: as runFull's. */
export async function run(cmd, args, opts) {
  const { code, out, err } = await runFull(cmd, args, opts);
  if (code === 0) return out;
  const why = (err || out).trim().split('\n')[0].slice(0, 240);
  throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${why}`);
}

/**
 * Runs a CLI to completion and resolves with its exit code, stdout and stderr, whatever the code. Nobody is there to
 * answer it: git fails rather than ask for a password on the terminal, under the UI, and a command still going after
 * `timeoutMs` (10 minutes) is stopped and rejects, so one stalled call can't hold a poll for good.
 */
export function runFull(cmd, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawnCli(cmd, args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(p.pid);
      reject(new Error(`${cmd} ${args.slice(0, 2).join(' ')} was stopped: no answer in ${Math.round(timeoutMs / 60_000) || 1} minutes`));
    }, timeoutMs);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `${cmd} is not installed or not on PATH` : e.message)); });
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    p.stdin.end();
  });
}

/** When process `pid` started, in ms since the epoch, or null if that can't be read. */
export function processStart(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    const out = WIN
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`], QUIET)
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { ...QUIET, env: { ...process.env, LC_ALL: 'C' } });
    const t = WIN ? Number(out.trim()) : Date.parse(out.trim());
    return out.trim() && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * The pid in lock file `file` while the Prowl that wrote it is still running, else 0. A lock left by a crash or a
 * power cut can hold a pid that another program has by now: it is that Prowl only if it started before the lock
 * was written.
 */
export function lockHolder(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!pid || pid === process.pid || !isAlive(pid)) return 0;
    const started = processStart(pid);
    return started === null || started < fs.statSync(file).mtimeMs + 10_000 ? pid : 0; // unreadable: trust the pid
  } catch {
    return 0; // no lock
  }
}

/** Stops a detached process and everything it started: asked to end (SIGTERM), or with `force` killed outright. */
export function killTree(pid, { force = false } = {}) {
  if (!pid) return;
  if (WIN) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig); // detached children lead their own process group
    if (force) try { process.kill(pid, sig); } catch { /* already gone */ }
  } catch {
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
}

const signal = (pid, sig) => {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } } // detached: its own process group
};

/** Resolves true once `pid` has exited, or false after `ms`. */
async function gone(pid, ms) {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

/**
 * Stops a detached session and everything it started, and resolves true only once it has exited: SIGTERM, up to
 * `waitMs` to exit, then SIGKILL and as long again (taskkill /F on Windows).
 */
export async function stopProcess(pid, waitMs = 5000) {
  if (!isAlive(pid)) return true;
  if (WIN) {
    await new Promise(r => spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', r).on('exit', r));
    return gone(pid, waitMs);
  }
  signal(pid, 'SIGTERM');
  if (await gone(pid, waitMs)) return true;
  signal(pid, 'SIGKILL');
  return gone(pid, waitMs);
}

/** macOS: keeps the Mac from idle-sleeping until process `pid` exits; caffeinate exits with it. Elsewhere it does nothing. */
export function keepAwake(pid) {
  if (process.platform !== 'darwin' || !pid) return;
  spawn('caffeinate', ['-i', '-w', String(pid)], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/** Opens a URL or file with the OS default handler. */
export function openExternal(target) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [target]]
      : WIN ? ['rundll32', ['url.dll,FileProtocolHandler', target]] // no cmd.exe, so & in URLs is safe
        : ['xdg-open', [target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

const TOAST_SHOW = "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))";

/** True inside WSL: Windows' notifications are reached through powershell.exe there. */
export const WSL = (() => {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')); } catch { return false; }
})();

/** True when `cmd` is on PATH. */
function onPath(cmd, env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some(dir => { try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true; } catch { return false; } });
}

/**
 * How a desktop notification is sent on this machine: 'osascript' (macOS), 'powershell' (Windows, and WSL through
 * interop when powershell.exe is on PATH), 'notify-send' (other Linux, when it is on PATH and the session has a
 * desktop to talk to), or null where there is none.
 */
export function desktopRoute({ platform = process.platform, wsl = WSL, has = onPath, env = process.env } = {}) {
  if (platform === 'darwin') return 'osascript';
  if (platform === 'win32') return 'powershell';
  if (wsl) return has('powershell.exe') ? 'powershell' : null;
  return has('notify-send') && (env.DISPLAY || env.WAYLAND_DISPLAY || env.DBUS_SESSION_BUS_ADDRESS) ? 'notify-send' : null;
}

/** Where a notification goes: 'bell', 'desktop', or null (Notify via is desktop and this machine has no route). */
export const notifyChannel = (via, route) => (via === 'bell' ? 'bell' : route ? 'desktop' : via === 'desktop' ? null : 'bell');

/** The terminal bell, when stdout is a terminal: the terminal shows it its own way (a sound, a flashing tab or taskbar icon). */
export function ringBell(out = process.stdout) {
  if (out.isTTY) out.write('\x07');
}

const notifyState = { failed: false }; // a desktop notification failed once in this launch: `auto` goes to the bell from then on
/**
 * A notification, best effort, sent as Notify via says (`via`: 'auto', 'desktop' or 'bell'; anything else is auto).
 * auto: a desktop notification where one works, else the bell; if one fails once (the command can't start, or exits
 * non-zero), the bell rings for that one and for every later auto notification in this launch. `deps`, for the
 * self-test: { route, wsl, spawn, bell, state }. Title and text are tidied: control characters to spaces, 200 characters each.
 */
export function notify(title, text, via = 'auto', deps = {}) {
  const d = { route: desktopRoute(), wsl: WSL, spawn, bell: ringBell, state: notifyState, ...deps };
  const mode = ['auto', 'desktop', 'bell'].includes(via) ? via : 'auto';
  const channel = notifyChannel(mode, mode === 'auto' && d.state.failed ? null : d.route);
  if (channel === 'bell') return d.bell();
  if (!channel) return undefined;
  const tidy = s => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  const [t, b] = [tidy(title), tidy(text)];
  let cmd;
  let args;
  if (d.route === 'osascript') {
    const as = s => `"${s.replace(/[\\"]/g, '\\$&')}"`; // an AppleScript string
    [cmd, args] = ['osascript', ['-e', `display notification ${as(b)} with title ${as(t)}`]];
  } else if (d.route === 'powershell') {
    const ps = s => `'${s.replace(/'/g, "''")}'`; // a PowerShell string
    const script = '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;'
      + '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);'
      + `$n = $x.GetElementsByTagName('text'); $n.Item(0).AppendChild($x.CreateTextNode(${ps(t)})) > $null; $n.Item(1).AppendChild($x.CreateTextNode(${ps(b)})) > $null;`
      + TOAST_SHOW;
    // Encoded, so nothing in the text is parsed by a shell on the way in. From WSL, Windows' own powershell.exe, through interop.
    [cmd, args] = [d.wsl ? 'powershell.exe' : 'powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
  } else {
    [cmd, args] = ['notify-send', ['--', t, b]]; // -- so a title starting with - isn't read as an option
  }
  let told = false;
  const failed = () => { // once per notification: under auto, the bell stands in, now and for the rest of this launch
    if (told || mode !== 'auto') return;
    told = true;
    d.state.failed = true;
    d.bell();
  };
  try {
    const child = d.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', failed);
    child.on('exit', code => { if (code) failed(); });
    child.unref?.();
  } catch { failed(); }
  return undefined;
}

/**
 * Puts `text` on the system clipboard, best effort: pbcopy on macOS, wl-copy or xclip on Linux. Elsewhere (and over
 * SSH) the TUI's OSC 52 sequence does it, in terminals that allow it.
 */
export function copyText(text) {
  const [cmd, args] = process.platform === 'darwin' ? ['pbcopy', []]
    : process.env.WAYLAND_DISPLAY ? ['wl-copy', []]
      : process.env.DISPLAY && !WIN ? ['xclip', ['-selection', 'clipboard']] : [];
  if (!cmd) return;
  const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.stdin.end(text);
}
