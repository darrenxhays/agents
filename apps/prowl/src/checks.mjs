// checks.json: the user's own commands, run in a worktree before Prowl pushes anything. Covered by the self-test.
import { spawn } from 'node:child_process';
import { killTree, WIN } from './proc.mjs';
import { withoutTokens } from './sessions.mjs';

export const TAIL = 4000; // characters of check output kept for a session's brief

/** A glob as a RegExp: ** spans folders, * and ? stay within one (with `anywhere`, * spans them too). */
export function globRe(glob, anywhere = false) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*'; // **/ is any folders, including none
    }
    else if (c === '*') re += anywhere ? '.*' : '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** The first checks.json entry whose repo glob (owner/name, * wildcards) matches `repo`, or null. */
export const matchChecks = (checks, repo) => Object.entries(checks || {}).find(([glob]) => globRe(glob, true).test(repo))?.[1] || null;

/** Runs one command through the platform shell in `cwd`, without the trackers' tokens (it runs code a session wrote); resolves { ok, tail, timedOut }. */
export function runCommand(command, cwd, env, timeoutMs) {
  return new Promise(resolve => {
    let tail = '';
    let timedOut = false;
    const keep = d => { tail = (tail + d).slice(-TAIL); };
    const p = spawn(command, { cwd, env: { ...withoutTokens(process.env), ...env }, shell: true, detached: !WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; killTree(p.pid); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); resolve({ ok: false, tail: `${tail}\n${e.message}`, timedOut }); });
    p.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, tail, timedOut }); });
  });
}

/** Runs a checks.json entry's setup, then run, commands in order; resolves { ok, command, tail } at the first failure. */
export async function runChecks(spec, cwd) {
  const timeout = (spec.timeoutMinutes || 20) * 60_000;
  for (const command of [...(spec.setup || []), ...(spec.run || [])]) {
    const r = await runCommand(command, cwd, spec.env || {}, timeout);
    if (!r.ok) return { ok: false, command, tail: r.timedOut ? `${r.tail}\n(stopped after ${spec.timeoutMinutes || 20} minutes)` : r.tail };
  }
  return { ok: true };
}
