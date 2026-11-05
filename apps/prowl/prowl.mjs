#!/usr/bin/env node
// Prowl: two sides on your Azure DevOps or Jira boards. The Reviewer runs Claude Code's prowl-review skill on the open
// GitHub PRs of tickets tagged for review; the Builder builds tickets tagged to start and opens their PRs. See README.md.
// Run it from your projects folder:
//   node /path/to/prowl.mjs [--setup] [--dry-run] [--once] [--self-test] [--reviewer-only | --builder-only]
//     [--work <ticket>] [--follow <ticket>] [--review <pr> [<pr>...]]
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`prowl needs Node 18 or newer (this is ${process.version}).`);
  process.exit(1);
}
const args = new Set(process.argv.slice(2));
const valueOf = flag => (args.has(flag) ? process.argv[process.argv.indexOf(flag) + 1] || '' : null);
if (args.has('--self-test')) {
  // Always in a throwaway PROWL_HOME, so the self-test never touches your own ~/.prowl.
  process.env.PROWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-home-'));
  try {
    await import('./src/self-test.mjs');
  } finally {
    fs.rmSync(process.env.PROWL_HOME, { recursive: true, force: true });
  }
  process.exit(0);
}
if (args.has('--setup')) {
  const { setup } = await import('./src/setup.mjs');
  process.exit(await setup(process.argv.slice(2)));
}
if (args.has('--watch')) {
  console.error('--watch was Fix my PRs, which 2.12.0 removed. To have the Builder follow a ticket\'s PRs through review, use: prowl --follow <ticket>');
  process.exit(1);
}
if (args.has('--reviewer-only') && args.has('--builder-only')) {
  console.error('Pick one of --reviewer-only and --builder-only.');
  process.exit(1);
}

const { HOME, loadConfig, saveConfig, seedChecks } = await import('./src/config.mjs');
const TRACKERS = { ado: await import('./src/ado.mjs'), jira: await import('./src/jira.mjs') };
const secrets = await import('./src/secrets.mjs');
const { isAlive } = await import('./src/proc.mjs');
const { createReviewer } = await import('./src/reviewer/reviewer.mjs');
const { saveState } = await import('./src/reviewer/reviews.mjs');
const { createBuilder } = await import('./src/builder/builder.mjs');
const { createShell } = await import('./src/shell.mjs');
const { migrateFixes, needsMigration } = await import('./src/migrate.mjs');
const update = await import('./src/update.mjs');
const { parsePrRefs } = await import('./src/github.mjs');

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url)); // this folder is also the plugin with prowl-review and prowl-build
const ONCE = args.has('--once');
const LOCK = path.join(HOME, 'lock');
const workKey = valueOf('--work');
const followKey = valueOf('--follow');
// --review takes every argument after it up to the next flag: PR links or owner/repo#12.
const afterReview = args.has('--review') ? process.argv.slice(process.argv.indexOf('--review') + 1) : null;
const nextFlag = afterReview?.findIndex(a => a.startsWith('--'));
const reviewRefs = afterReview && parsePrRefs(afterReview.slice(0, nextFlag < 0 ? undefined : nextFlag).join(' '));
if (typeof reviewRefs === 'string') {
  console.error(`--review: ${reviewRefs}. Give one or more PRs, e.g. prowl --review https://github.com/owner/repo/pull/12 owner/repo#13`);
  process.exit(1);
}
let tui = null; // set once the TUI is up; until then (and with --once) logs go to stdout

const app = {
  cfg: loadConfig(),
  me: '',
  log: [],
  said: [], // what Hoot has to say: { text, mood, until }, oldest first
  // --reviewer-only and --builder-only override the switches for this launch; e in the TUI clears a side's override.
  override: args.has('--reviewer-only') ? { reviewer: true, builder: false } : args.has('--builder-only') ? { reviewer: false, builder: true } : {},
  sideOn: name => app.override[name] ?? Boolean(app.cfg[name]?.enabled),
  tracker: () => TRACKERS[app.cfg.taskBoard] || TRACKERS.ado,
  boards: () => app.cfg[app.cfg.taskBoard]?.boards || [],
  hasToken() { // read from the credential store once per email, not on every frame
    const { email } = app.cfg.jira;
    if (app._tokenFor !== email) [app._tokenFor, app._hasToken] = [email, Boolean(email && secrets.readToken(email))];
    return app._hasToken;
  },
  /** What Hoot is saying now: each message shows for a few seconds, then the next one. */
  speech() {
    while (app.said.length && app.said[0].until && Date.now() > app.said[0].until) app.said.shift();
    const now = app.said[0];
    if (now && !now.until) now.until = Date.now() + (now.mood === 'error' ? 10_000 : 6_000);
    return now || null;
  },
  notes: null, // the Update Notes for this launch: see update.updateNotes
  dryRun: () => app.cfg.dryRun || args.has('--dry-run'),
};

const lastByKey = new Map();
/**
 * Logs to the side's Log view and poller.log, which names the side ('reviewer', 'builder', or 'prowl' for both).
 * With a key, a message repeated for the same key is logged once (returns false).
 */
function log(side, level, msg, key) {
  const k = key && `${side}:${key}`;
  if (k && lastByKey.get(k) === msg) return false;
  if (k) lastByKey.set(k, msg);
  const entry = { t: Date.now(), side, level, msg };
  app.log.push(entry);
  if (app.log.length > 1000) app.log.shift();
  try { fs.appendFileSync(path.join(HOME, 'poller.log'), `${new Date(entry.t).toISOString()} ${level} [${side}] ${msg}\n`); } catch { /* best effort */ }
  if (ONCE || !tui) console.log(`${level.padEnd(5)} [${side}] ${msg}`);
  if (level === 'error') hoot(msg, 'error');
  return true;
}
const forget = (side, key) => lastByKey.delete(`${side}:${key}`);
app.forget = forget;

/** Gives Hoot something to say. `mood`: 'cheer' or 'error' changes how he looks while he says it. */
function hoot(text, mood) {
  app.said.push({ text, mood });
  if (app.said.length > 6) app.said.splice(1, 1); // never fall far behind; keep what's showing
}
app.hoot = hoot;

const sideDeps = name => ({ log: (...a) => log(name, ...a), forget: key => forget(name, key), hoot, appDir: PLUGIN_DIR, trackers: TRACKERS });
const reviewer = createReviewer(app, sideDeps('reviewer'));
const builder = createBuilder(app, sideDeps('builder'));
const sides = [reviewer, builder];
const shell = createShell(app, sides, { log, reload: () => { app.cfg = loadConfig(); } });

// One instance per user: two would both finish the same sessions.
try {
  const pid = Number(fs.readFileSync(LOCK, 'utf8'));
  if (pid && pid !== process.pid && isAlive(pid)) {
    console.error(`prowl is already running (pid ${pid}).`);
    process.exit(1);
  }
} catch { /* no lock */ }

// Updates run before taking the lock, which the installer checks. A session still running from an earlier launch
// reads the skills' files as it goes, so the update waits for a launch with none running.
if (app.cfg.autoUpdate && !process.env.PROWL_UPDATED) {
  const version = await update.availableUpdate(PLUGIN_DIR);
  if (version && sides.some(s => s.alive())) {
    log('prowl', 'info', `Prowl ${version} is available. It installs on the first launch with no session running.`);
    hoot(`Prowl ${version} is out. I'll update once the running sessions finish and you start me again.`);
  } else if (version) {
    console.log(`Updating Prowl to ${version}...`);
    if (update.installUpdate()) {
      const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, PROWL_UPDATED: '1' } });
      process.exit(r.status ?? 1);
    }
    console.error(`The update failed; starting Prowl ${update.localVersion(PLUGIN_DIR)}.`);
  }
}
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch { /* gone */ } });

// Fix my PRs was removed in 2.12.0: stop its sessions and move its settings aside, once.
let migrated = [];
if (needsMigration(app.cfg, reviewer.state)) {
  try {
    migrated = await migrateFixes(app.cfg, reviewer.state, { saveConfig, saveState });
  } catch (e) {
    log('prowl', 'error', `Couldn't finish removing Fix my PRs (${e.message}); Prowl tries again next launch`);
  }
}

try {
  app.notes = update.updateNotes(PLUGIN_DIR); // shown once, on the first launch after an update
} catch (e) {
  log('prowl', 'warn', `Couldn't bring your config files in ${path.join(HOME, 'config')} up to date: ${e.message}`);
}
try { seedChecks(); } catch { /* the Config view seeds it again */ }
if (migrated.length) app.notes = { version: update.localVersion(PLUGIN_DIR), versions: [], files: [], ...app.notes, files: [...(app.notes?.files || []), ...migrated] };

// prowl --work <key> builds a ticket without its start tag; prowl --follow <key> adopts its PRs. Both need the Builder.
for (const [key, source] of [[workKey, 'manual'], [followKey, 'follow']]) {
  if (key == null) continue;
  if (!app.sideOn('builder')) app.override.builder = true;
  try {
    const w = await builder.enqueue(key, source);
    console.log(`${source === 'follow' ? 'Following' : 'Building'} ${w.key} "${w.title}" with the Builder.`);
  } catch (e) {
    console.error(`Couldn't ${source === 'follow' ? 'follow' : 'build'} ${key || '(no ticket given)'}: ${e.message}`);
    process.exit(1);
  }
}

// prowl --review <pr>... starts a quick review of the PRs, together and without a ticket. It needs the Reviewer.
if (reviewRefs) {
  if (!app.sideOn('reviewer')) app.override.reviewer = true;
  try {
    await reviewer.settle(); // reviews that ended since the last launch free their slots first
    const run = await reviewer.reviewPrs(reviewRefs);
    console.log(run ? `Reviewing ${run.prs.map(p => p.url).join(' ')} together as ${run.ticket}.` : 'Dry run: logged what would be reviewed.');
  } catch (e) {
    console.error(`Couldn't start the quick review: ${e.message}`);
    process.exit(1);
  }
}

if (ONCE) {
  if (app.notes) console.log(`${update.notesText(app.notes)}\n`);
  if (app.sideOn('reviewer')) await reviewer.settle();
  await shell.pollOnce();
  await builder.drain(); // the Builder's due steps; sessions it starts keep running in the background
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('prowl needs an interactive terminal (on Windows: Windows Terminal, or winpty in Git Bash). Use --once for a single non-interactive poll.');
  process.exit(1);
}

let ticker;
function quit(code = 0) {
  clearInterval(ticker);
  tui?.restore();
  process.exit(code);
}
const byName = { reviewer, builder };
const { startTui } = await import('./src/tui.mjs');
tui = startTui(app, {
  sides: byName,
  pollNow: name => { byName[name].nextPoll = 0; },
  togglePause: name => { byName[name].paused = !byName[name].paused; },
  toggleSide: name => {
    const now = !app.sideOn(name);
    app.cfg[name].enabled = now;
    delete app.override[name];
    saveConfig(app.cfg);
    if (now) byName[name].nextPoll = 0;
    return now;
  },
  stop: (name, item) => byName[name].stop(item),
  answer: (item, text) => builder.answer(item, text),
  skip: item => builder.skip(item),
  handBack: item => builder.handBack(item).catch(e => log('builder', 'error', `${item.ticket}: couldn't hand it back (${e.message})`)),
  follow: w => builder.enqueue(w.key, 'follow'),
  stopFollowing: w => builder.stopFollowing(w),
  reviewPrs: refs => reviewer.reviewPrs(refs).catch(e => {
    log('reviewer', 'error', `Couldn't start the quick review: ${e.message}`);
    throw e;
  }),
  saveConfig: () => {
    saveConfig(app.cfg);
    seedChecks(); // the Checks before push file to fill in, with examples; never overwritten once edited
  },
  saveToken: token => {
    try { secrets.saveToken(app.cfg.jira.email, token); } catch (e) { return e.message; }
    app._tokenFor = null;
    TRACKERS.jira.forgetToken();
    return '';
  },
  quit: () => quit(0),
});
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => quit(0));
process.on('uncaughtException', e => { tui?.restore(); tui = null; console.error(e); process.exit(1); });
process.on('unhandledRejection', e => log('prowl', 'error', `unhandled: ${e?.stack || e}`));
ticker = setInterval(shell.tick, 1000);
shell.tick();
