// Detached headless Claude Code sessions, for both sides: each outlives this process and writes stream-json to a log
// file Prowl tails, so a restart picks running sessions back up.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { isAlive, keepAwake, processStart } from './proc.mjs';

const exited = new Set(); // pids of sessions started by this process that have exited

/** True while the session for `run` (anything with pid and startedAt) is still running. */
export function alive(run) {
  if (exited.has(run.pid) || !isAlive(run.pid)) return false;
  // A pid saved by an earlier launch can belong to another program by now: after a reboot or sign-out, and
  // sooner on Windows, which reuses pids quickly. It is still the session only if it started with the session.
  if (run._ours === undefined) {
    const started = run._spawned ? null : processStart(run.pid);
    run._ours = started === null || started < run.startedAt + 10_000; // unreadable: trust the pid
  }
  return run._ours;
}

/** Follows a detached session this process spawned for `run`, so alive() knows when it exits. */
export function track(run, child, cfg) {
  exited.delete(child.pid); // the system hands pids out again, Windows quickly: this one is running now
  run.pid = child.pid;
  run._spawned = true;
  if (cfg.caffeinate) keepAwake(child.pid); // a sleeping Mac stalls the session's streams and stretches it out
  child.on('error', e => { run.spawnError = e.message; exited.add(child.pid); });
  child.on('exit', () => exited.add(child.pid));
  child.unref();
}

const TRACKER_TOKENS = ['JIRA_API_TOKEN', 'AZURE_DEVOPS_EXT_PAT', 'SYSTEM_ACCESSTOKEN'];
/** `env` without the trackers' tokens: only Prowl's own code signs in to the tracker, never a session or a command it wrote. */
export const withoutTokens = env => Object.fromEntries(Object.entries(env).filter(([k]) => !TRACKER_TOKENS.includes(k)));

/** The environment for a session: Prowl's own, without the trackers' tokens. */
export const sessionEnv = (cfg, env = process.env) => ({
  ...withoutTokens(env),
  // prowl-review runs its reviewers as background subagents and ends its turn while they work. `claude -p`
  // stops background tasks still running 10 minutes after the last turn, which kills a large batch's
  // reviewers before anything is posted. Each finished subagent starts a new turn, so this is the longest
  // stretch with no subagent finishing.
  // optimization-note: a hung background command (e.g. a test runner in watch mode) holds the session open
  // for up to this long after its work is done; Stop ends it sooner.
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(60 * 60_000),
  // Headless sessions otherwise add their outcome to the project's memory index, which loads into every later session.
  ...(cfg.allowMemoryWrites === false && { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }),
});

/** The cap a session's final `result` event says it hit ('spend cap $50'), or null. */
export const capHit = (result, { maxBudgetUsd, maxTurns } = {}) =>
  ({ error_max_budget_usd: `spend cap $${maxBudgetUsd}`, error_max_turns: `turn cap ${maxTurns}` }[result?.subtype] || null);

/** Forgets what readActivity() read, before a new session writes to a new log. */
export const resetActivity = run => { for (const k of ['_activity', '_offset', '_partial', '_decoder', '_result', '_ours']) delete run[k]; };

/**
 * True once the session for `run` has ended: its process has exited. A `result` event while it runs is only a turn's:
 * a session with background subagents ends its turn while they work, and starts a new one as each finishes.
 */
export const sessionEnded = (run, isAlive = alive) => !isAlive(run);

/**
 * Reads new output from a session's log into run._activity; returns the latest turn's `result` event once there is
 * one. When the process has exited, that is the session's final result: its cost is the session's total.
 */
export function readActivity(run) {
  run._activity ??= [];
  run._offset ??= 0;
  run._partial ??= '';
  run._decoder ??= new StringDecoder('utf8');
  let size;
  try { size = fs.statSync(run.logPath).size; } catch { return run._result; }
  if (size > run._offset) {
    const buf = Buffer.alloc(size - run._offset);
    const fd = fs.openSync(run.logPath, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, run._offset); } finally { fs.closeSync(fd); }
    run._offset = size;
    run._lastOutputAt = Date.now();
    const lines = (run._partial + run._decoder.write(buf)).split('\n');
    run._partial = lines.pop();
    for (const line of lines) parseLine(run, line);
    if (run._activity.length > 400) run._activity.splice(0, run._activity.length - 400);
  }
  return run._result;
}

function parseLine(run, line) {
  if (!line.trim()) return;
  // One line that can't be parsed or handled is shown as an error, and the lines after it are still read: the
  // offset has moved already, so an exception here would lose the rest, a `result` event included.
  try {
    const e = JSON.parse(line);
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('not an event');
    const sub = Boolean(e.parent_tool_use_id);
    if (e.type === 'assistant') {
      for (const c of e.message?.content || []) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use') run._activity.push({ sub, text: describeTool(c) });
        else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) run._activity.push({ sub, said: true, text: c.text.trim().split('\n')[0] });
      }
    }
    if (e.type === 'result') run._result = e;
  } catch {
    run._activity.push({ text: line, error: true }); // stderr shares the log
  }
}

const describeTool = ({ name, input = {} }) =>
  `${name} ${input.description || input.command || input.skill || input.file_path || input.pattern || input.url || input.prompt || ''}`
    .replace(/\s+/g, ' ').trim();
