// checks.json: the user's own commands, run in a worktree: by the Builder before Prowl pushes anything, and by the
// Reviewer before a review (Build and test before reviews). Covered by the self-test.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export const STOP_GRACE_MS = 10_000; // how long a stopped command has to end before it is killed outright
const running = new Set(); // pids of check commands still running

/** Kills every check command still running, outright: on quit, so a build left running can't collide with the same checks run again. */
export function killChecks() {
  for (const pid of running) killTree(pid, { force: true });
}

/**
 * Runs one command through the platform shell in `cwd`, without the trackers' tokens (it runs code a session or a PR's
 * author wrote); resolves { ok, nothing, tail, timedOut }. `signal` stops it: asked to end, then killed after
 * `graceMs`. `log(text)` gets its whole output as it comes. A command that finds nothing of its kind to do creates the
 * file PROWL_NOTHING_TO_RUN_FILE names and exits 0: `nothing`. A file, not an exit code, so no tool's own exit code
 * can pass for it.
 */
export function runCommand(command, cwd, env, timeoutMs, { signal, log, graceMs = STOP_GRACE_MS } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ ok: false, tail: '(stopped)' });
    const nothingFile = path.join(os.tmpdir(), `prowl-nothing-${process.pid}-${randomUUID()}`);
    let tail = '';
    let timedOut = false;
    let stopped = false;
    let killer;
    const keep = d => { tail = (tail + d).slice(-TAIL); log?.(String(d)); };
    const p = spawn(command, { cwd, env: { ...withoutTokens(process.env), ...env, PROWL_NOTHING_TO_RUN_FILE: nothingFile }, shell: true, detached: !WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(p.pid);
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    let asked = false;
    const stop = () => {
      if (asked) return; // a timeout, then Stop: one request and one escalation timer, never a second that outlives the cleanup
      asked = true;
      killTree(p.pid);
      if (!WIN) killer = setTimeout(() => killTree(p.pid, { force: true }), graceMs); // taskkill /F is outright already
    };
    const onAbort = () => { stopped = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = r => {
      clearTimeout(timer);
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      running.delete(p.pid);
      // The shell has exited: a child that ignored the stop with its output redirected holds none of our pipes, and
      // would otherwise keep running in the worktree.
      if (stopped || timedOut) killTree(p.pid, { force: true });
      // The command wrote this path: it is a file when it means "nothing to run", and whatever else is there is only removed.
      let nothing = false;
      try { nothing = r.ok && fs.statSync(nothingFile).isFile(); } catch { /* not created */ }
      try { fs.rmSync(nothingFile, { force: true, recursive: true }); } catch { /* left in the temp folder */ }
      resolve({ ...r, nothing, timedOut });
    };
    p.on('error', e => done({ ok: false, tail: `${tail}\n${e.message}` }));
    p.on('close', code => done({ ok: code === 0 && !timedOut && !stopped, tail: stopped ? `${tail}\n(stopped)` : tail }));
    return undefined;
  });
}

/** Runs a checks.json entry's setup, then run, commands in order; resolves { ok, command, tail } at the first failure. Nothing to run is a pass. */
export async function runChecks(spec, cwd) {
  const timeout = (spec.timeoutMinutes || 20) * 60_000;
  for (const command of [...(spec.setup || []), ...(spec.run || [])]) {
    const r = await runCommand(command, cwd, spec.env || {}, timeout);
    if (!r.ok) return { ok: false, command, tail: r.timedOut ? `${r.tail}\n(stopped after ${spec.timeoutMinutes || 20} minutes)` : r.tail };
  }
  return { ok: true };
}

/**
 * The steps a review runs for a checks.json entry, as ordered [name, commands] pairs: its `review` block's named
 * steps, or its `run` commands as one step named "checks"; `setup` first, as its own step, only when something else
 * runs. `"review": false` keeps the repo out of reviews' checks.
 */
export function reviewSteps(spec) {
  if (!spec || spec.review === false) return [];
  const own = spec.review && typeof spec.review === 'object' ? Object.entries(spec.review) : [['checks', spec.run]];
  const steps = own.filter(([, commands]) => Array.isArray(commands) && commands.length);
  return steps.length && spec.setup?.length ? [['setup', spec.setup], ...steps] : steps;
}

/**
 * Runs `steps` ([name, commands] pairs) in order in `cwd`; resolves a result per step: { name, status: 'passed' |
 * 'nothing' | 'failed' | 'skipped', command?, tail?, after? }. A step ends at its first failing command. A failed
 * step named setup or build skips every step after it; any other doesn't. `log(text)` gets every command and all its output.
 */
export async function runSteps(steps, cwd, env, timeoutMinutes = 20, signal = undefined, log = () => {}) {
  const results = [];
  let gate = '';
  let atLineStart = true;
  const write = text => { if (text) { log(text); atLineStart = text.endsWith('\n'); } };
  const line = text => write(`${atLineStart ? '' : '\n'}${text}\n`);
  for (const [name, commands] of steps) {
    if (signal?.aborted || gate) {
      const after = signal?.aborted ? 'stopped' : gate;
      results.push({ name, status: 'skipped', after });
      line(`\n[${name}] skipped (${after === 'stopped' ? 'stopped' : `${after} failed`})`);
      continue;
    }
    let status = 'nothing';
    let failed = null;
    for (const command of commands) {
      line(`\n[${name}] $ ${command}`);
      const r = await runCommand(command, cwd, env, timeoutMinutes * 60_000, { signal, log: write });
      if (signal?.aborted) { status = 'skipped'; line(`[${name}] skipped (stopped)`); break; }
      if (!r.ok) {
        failed = { command, tail: r.timedOut ? `${r.tail}\n(stopped after ${timeoutMinutes} minutes)` : r.tail };
        line(`[${name}] ${r.timedOut ? `stopped after ${timeoutMinutes} minutes` : 'failed'}`);
        break;
      }
      if (!r.nothing) status = 'passed';
      line(`[${name}] ${r.nothing ? 'nothing to run' : 'passed'}`);
    }
    if (status === 'skipped') results.push({ name, status, after: 'stopped' });
    else if (failed) {
      results.push({ name, status: 'failed', ...failed });
      if (name === 'setup' || name === 'build') gate = name;
    } else results.push({ name, status });
  }
  return results;
}
