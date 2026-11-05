import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

export const WIN = process.platform === 'win32';
const QUIET = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };

// On Windows, az and claude are often .cmd shims, which only start through a shell. Arguments passed
// here are fixed flags, paths and config values, never free text: prompts go in through stdin.
// An .exe is started directly: a detached review started through cmd.exe can get a visible console
// window, and closing that window kills the review.
export function spawnCli(cmd, args, opts = {}) {
  const exe = WIN && windowsExe(cmd);
  const shell = WIN && !exe;
  const argv = shell ? args.map(a => (/[\s"&|<>^()]/.test(a) ? `"${a}"` : a)) : args;
  return spawn(exe || cmd, argv, { shell, windowsHide: true, ...opts });
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

/** Runs a CLI to completion and resolves with its stdout. */
export async function run(cmd, args) {
  const { code, out, err } = await runFull(cmd, args);
  if (code === 0) return out;
  const why = (err || out).trim().split('\n')[0].slice(0, 240);
  throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${why}`);
}

/** Runs a CLI to completion and resolves with its exit code, stdout and stderr, whatever the code. */
export function runFull(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawnCli(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => reject(new Error(e.code === 'ENOENT' ? `${cmd} is not installed or not on PATH` : e.message)));
    p.on('close', code => resolve({ code, out, err }));
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

/** Stops a detached review and everything it started. */
export function killTree(pid) {
  if (!pid) return;
  if (WIN) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // detached children lead their own process group
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
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

/** Shows a desktop notification, best effort: any failure is ignored. `title` and `text` may come from other people. */
export function notifyDesktop(title, text) {
  const tidy = s => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  const [t, b] = [tidy(title), tidy(text)];
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    const as = s => `"${s.replace(/[\\"]/g, '\\$&')}"`; // an AppleScript string
    [cmd, args] = ['osascript', ['-e', `display notification ${as(b)} with title ${as(t)}`]];
  } else if (WIN) {
    const ps = s => `'${s.replace(/'/g, "''")}'`; // a PowerShell string
    const script = '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;'
      + '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);'
      + `$n = $x.GetElementsByTagName('text'); $n.Item(0).AppendChild($x.CreateTextNode(${ps(t)})) > $null; $n.Item(1).AppendChild($x.CreateTextNode(${ps(b)})) > $null;`
      + "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))";
    // Encoded, so nothing in the text is parsed by a shell on the way in.
    [cmd, args] = ['powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
  } else {
    [cmd, args] = ['notify-send', ['--', t, b]]; // -- so a title starting with - isn't read as an option
  }
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

const sh = s => `'${String(s).replace(/'/g, "'\\''")}'`; // a POSIX shell word
const applescript = s => `"${s.replace(/[\\"]/g, '\\$&')}"`;

/**
 * Runs `argv` in `cwd` in a new tab of the terminal Prowl runs in: tmux (a window), iTerm2, Terminal, WezTerm or
 * Windows Terminal. Elsewhere on macOS, in a new Terminal window. Resolves true once started, or false when it
 * couldn't be (no supported terminal, or the terminal refused); the caller then shows the command to run.
 */
export function openInTerminal(cwd, argv, env = process.env) {
  const line = `cd ${sh(cwd)} && ${argv.map(sh).join(' ')}`;
  const term = env.TERM_PROGRAM;
  let cmd;
  let args;
  if (env.TMUX) [cmd, args] = ['tmux', ['new-window', '-c', cwd, line]];
  else if (WIN && env.WT_SESSION) [cmd, args] = ['wt', ['-w', '0', 'nt', '-d', cwd, 'cmd', '/k', ...argv]];
  else if (term === 'WezTerm') [cmd, args] = ['wezterm', ['cli', 'spawn', '--cwd', cwd, '--', ...argv]];
  else if (process.platform === 'darwin') {
    const script = term === 'iTerm.app'
      ? ['tell application "iTerm2"', 'tell current window', 'set t to (create tab with default profile)', `tell current session of t to write text ${applescript(line)}`, 'end tell', 'end tell']
      : term === 'Apple_Terminal'
        // A new tab is a ⌘T keystroke, which needs Accessibility access for System Events; without it, a new window.
        ? ['tell application "Terminal" to activate', 'try', 'tell application "System Events" to keystroke "t" using command down', 'delay 0.3',
          `tell application "Terminal" to do script ${applescript(line)} in selected tab of front window`, 'on error',
          `tell application "Terminal" to do script ${applescript(line)}`, 'end try']
        : [`tell application "Terminal" to do script ${applescript(line)}`, 'tell application "Terminal" to activate'];
    [cmd, args] = ['osascript', script.flatMap(l => ['-e', l])];
  } else return Promise.resolve(false);
  return new Promise(resolve => {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => resolve(false)).on('exit', code => resolve(code === 0)).unref();
  });
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
