// Detached headless Claude Code sessions, for both sides: each outlives this process and writes stream-json to a log
// file Prowl tails, so a restart picks running sessions back up.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { isAlive, keepAwake, processStart } from './proc.mjs';

const exited = new Set(); // pids of sessions started by this process that have exited

/** True while the session for `run` (anything with pid and startedAt) is still running. */
export function alive(run, now = Date.now()) {
  if (exited.has(run.pid) || !isAlive(run.pid)) return false;
  // A pid saved by an earlier launch can belong to another program by now: after a reboot or sign-out, and
  // sooner on Windows, which reuses pids quickly. It is still the session only if it started with the session.
  if (run._ours === undefined) {
    const started = run._spawned ? null : processStart(run.pid);
    // Against when the session was launched: a prepared review's session starts minutes after the review itself.
    run._ours = started === null || started < (run.launchedAt ?? run.startedAt) + 10_000; // unreadable: trust the pid
    [run._startTime, run._startCheckedAt] = [started, now];
  } else if (run._ours && !run._spawned && run._result && run._startTime != null && now - run._startCheckedAt >= 30_000) {
    // A session from an earlier launch that has written a result may exit any time, and another program can take
    // its pid: looked at again at most every 30 seconds. A start time that has moved is another process's.
    run._startCheckedAt = now;
    const started = processStart(run.pid);
    if (started !== null && Math.abs(started - run._startTime) > 60_000) run._ours = false;
  }
  return run._ours;
}

/** Follows a detached session this process spawned for `run`, so alive() knows when it exits. */
export function track(run, child, cfg) {
  exited.delete(child.pid); // the system hands pids out again, Windows quickly: this one is running now
  run.pid = child.pid;
  run.launchedAt = Date.now();
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
export const resetActivity = run => { for (const k of ['_activity', '_offset', '_partial', '_decoder', '_result', '_ours', '_resultLast', '_tasks', '_lastOutputAt', '_activityBase']) delete run[k]; };

/**
 * True once the session for `run` has ended: its process has exited. A `result` event while it runs is only a turn's:
 * a session with background subagents ends its turn while they work, and starts a new one as each finishes.
 */
export const sessionEnded = (run, isAlive = alive) => !isAlive(run);

/** How many Activity lines a session keeps: Running scrolls back through them. */
export const ACTIVITY_LINES = 2000;
/**
 * Drops a session's oldest Activity lines past ACTIVITY_LINES, adding their count to run._activityBase: a line's key
 * is _activityBase + its index, so a scrolled-back Activity holds still while old lines go.
 */
export function trimActivity(run) {
  const over = (run._activity?.length || 0) - ACTIVITY_LINES;
  if (over <= 0) return;
  run._activity.splice(0, over);
  run._activityBase = (run._activityBase || 0) + over;
}

/**
 * True when a session's work is done and nothing it started can start another turn: the last event in its log is a
 * turn's clean `result`, none of its background tasks is running, and its log has been quiet for IDLE_DONE_MS (which
 * covers the turn a finished subagent's report starts right after a result). What keeps such a process up is a
 * wake-up it scheduled while its subagents ran, up to an hour away, which would find nothing left to do.
 */
export const IDLE_DONE_MS = 60_000;
export const idleDone = (run, now = Date.now()) => Boolean(run._resultLast && run._result?.subtype === 'success' && !run._result.is_error
  && !run._tasks?.size && now - (run._lastOutputAt ?? now) >= IDLE_DONE_MS);

/**
 * Reads new output from a session's log into run._activity; returns the latest turn's `result` event once there is
 * one. When the process has exited, that is the session's final result: its cost is the session's total.
 */
export function readActivity(run) {
  run._activity ??= [];
  const firstRead = run._offset === undefined;
  run._offset ??= 0;
  run._partial ??= '';
  run._decoder ??= new StringDecoder('utf8');
  let size;
  let written;
  try { ({ size, mtimeMs: written } = fs.statSync(run.logPath)); } catch { return run._result; }
  if (size > run._offset) {
    const buf = Buffer.alloc(size - run._offset);
    const fd = fs.openSync(run.logPath, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, run._offset); } finally { fs.closeSync(fd); }
    run._offset = size;
    // A log this process reads for the first time (at launch, or under --once) has been quiet since it was last
    // written, not since now: a session that went idle before then is done at once.
    run._lastOutputAt = firstRead ? Math.min(written, Date.now()) : Date.now();
    const lines = (run._partial + run._decoder.write(buf)).split('\n');
    run._partial = lines.pop();
    for (const line of lines) parseLine(run, line);
    trimActivity(run);
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
    run._resultLast = e.type === 'result';
    if (e.type === 'system') { // the session's background tasks (subagents and commands) still running
      if (e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks)) run._tasks = new Set(e.tasks.map(t => t?.task_id).filter(Boolean));
      else if (e.subtype === 'task_started' && e.task_id) (run._tasks ??= new Set()).add(e.task_id);
      else if (e.subtype === 'task_notification' && e.task_id) run._tasks?.delete(e.task_id);
    }
    // Once a done review's session has been asked to end, the result it settles on is frozen: stopping it may write
    // another. A later launch reading the log again stops taking results after the one it settled on.
    if (e.type === 'result' && !run._settled && !run._pastSettled) {
      run._result = e;
      if (run.settledOn && e.uuid === run.settledOn) run._pastSettled = true;
    }
  } catch {
    run._activity.push({ text: line, error: true }); // stderr shares the log
  }
}

const describeTool = ({ name, input = {} }) =>
  `${name} ${input.description || input.command || input.skill || input.file_path || input.pattern || input.url || input.prompt || ''}`
    .replace(/\s+/g, ' ').trim();
