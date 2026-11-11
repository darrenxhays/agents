// A Builder session: `claude -p` in the Projects Directory (so its CLAUDE.md loads), fenced as kind 'work', with one
// session id resumed at each step. Each turn is its own detached process with its own log.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, HOME, writeJson } from '../config.mjs';
import { fenceArgs, fenceEnv, fenceSettings, trackerHosts } from '../fence.mjs';
import { spawnCli } from '../proc.mjs';
import { resetActivity, sessionEnv, track } from '../sessions.mjs';

export const LOGS_DIR = path.join(HOME, 'logs');

/** The folders a session may write in: its worktrees and its brief folder. */
export const rootsOf = w => [...(w.turnKind === 'round' ? (w.round?.prs || []) : (w.repos || [])).map(r => r.worktree), w.briefDir].filter(Boolean);

/**
 * The `claude` arguments for a turn. `budget` is what is left of the tightest spend cap (0 = no cap). `readOnly`, for
 * your questions in Needs you: no editing tools, on top of the fence.
 */
export function workArgs(cfg, appDir, w, settingsPath, budget, readOnly = false) {
  const b = cfg.builder;
  const fence = fenceArgs(b.mcpAllow);
  if (readOnly) fence.splice(fence.indexOf('--disallowedTools') + 1, 0, 'Edit', 'Write', 'NotebookEdit');
  return [
    '-p', '--plugin-dir', appDir, ...rootsOf(w).flatMap(d => ['--add-dir', d]), '--add-dir', CONFIG_DIR,
    '--model', b.model || cfg.claude.model, '--effort', b.effort, '--permission-mode', cfg.claude.permissionMode,
    ...(w.sessionStarted ? ['--resume', w.sessionId] : ['--session-id', w.sessionId]),
    ...(budget > 0 ? ['--max-budget-usd', String(Math.max(0.01, Math.round(budget * 100) / 100))] : []),
    ...(b.maxTurns > 0 ? ['--max-turns', String(b.maxTurns)] : []),
    ...fence,
    '--settings', settingsPath,
    '--output-format', 'stream-json', '--verbose',
  ];
}

// What a push to GitHub starts with. In a session's environment each is rewritten, for pushes only, to an address git can't reach.
const PUSH_PREFIXES = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'];

/**
 * Git config, passed in the environment, that makes every push to GitHub from the session's process tree go nowhere:
 * a second layer under the fence's hook, for a push it can't see (a script, an interpreter, a build tool). Fetches
 * are untouched, and Prowl's own push runs in Prowl's environment, not this one.
 */
function noPushEnv(env) {
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  const out = { GIT_CONFIG_COUNT: String(n + PUSH_PREFIXES.length) };
  PUSH_PREFIXES.forEach((prefix, i) => Object.assign(out, { [`GIT_CONFIG_KEY_${n + i}`]: 'url.prowl-fence-no-push://session/.pushInsteadOf', [`GIT_CONFIG_VALUE_${n + i}`]: prefix }));
  return out;
}

/** The environment for a turn: a session's (no tracker token in it), fenced as kind 'work', and unable to push to GitHub. */
export function workEnv(cfg, w, env = process.env) {
  return {
    ...sessionEnv(cfg, env),
    ...fenceEnv('work', rootsOf(w), cfg.builder.mcpAllow, trackerHosts(cfg.taskBoard === 'jira' ? cfg.jira.site : '')),
    ...noPushEnv(env),
    PROWL_BRIEF_DIR: w.briefDir, PROWL_UNATTENDED: '1',
  };
}

/** Runs `claude` for `w`'s session with `prompt` as a detached process logging to `${base}.ndjson`; returns the child. */
function spawnTurn(cfg, appDir, w, prompt, budget, base, readOnly) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const settingsPath = `${base}.settings.json`; // beside the log, not in the brief folder: the session can write there
  writeJson(settingsPath, fenceSettings(appDir));
  fs.writeFileSync(`${base}.prompt.md`, prompt);
  const stdin = fs.openSync(`${base}.prompt.md`, 'r');
  const out = fs.openSync(`${base}.ndjson`, 'a');
  const child = spawnCli('claude', workArgs(cfg, appDir, w, settingsPath, budget, readOnly), {
    cwd: cfg.workDir, detached: true, stdio: [stdin, out, out], env: workEnv(cfg, w),
  });
  fs.closeSync(stdin);
  fs.closeSync(out);
  return child;
}

/** Starts a turn of `w`'s session with `prompt`: a new detached process, tailed through its log. */
export function startTurn(cfg, appDir, w, prompt, budget) {
  const n = (w.turns?.length || 0) + 1;
  const base = path.join(LOGS_DIR, `work-${w.id}-${w.n || 1}.t${n}`);
  fs.rmSync(path.join(w.briefDir, 'result.json'), { force: true }); // each turn writes it afresh
  const child = spawnTurn(cfg, appDir, w, prompt, budget, base, false);
  resetActivity(w);
  Object.assign(w, { logPath: `${base}.ndjson`, startedAt: Date.now(), spawnError: null, capped: null, sessionStarted: true });
  track(w, child, cfg);
}

/**
 * Asks `w`'s session something for you while it waits in Needs you: a turn of the same session, without editing tools,
 * so it remembers the talk when your answer comes. Returns the run ({ logPath, startedAt, pid }), tailed like a turn.
 */
export function startDiscussion(cfg, appDir, w, prompt, budget) {
  const run = { logPath: '', startedAt: Date.now() };
  const base = path.join(LOGS_DIR, `work-${w.id}-${w.n || 1}.ask-${run.startedAt}`);
  run.logPath = `${base}.ndjson`;
  track(run, spawnTurn(cfg, appDir, w, prompt, budget, base, true), cfg);
  return run;
}
