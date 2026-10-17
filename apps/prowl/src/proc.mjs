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
