#!/usr/bin/env node
// Prowl: polls Azure DevOps or Jira boards for tickets tagged for review and runs Claude Code's
// prowl-review skill on their open GitHub PRs. See README.md. Run it from your projects folder:
//   node /path/to/prowl.mjs [--setup] [--dry-run] [--once] [--self-test] [--watch <ticket>]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`prowl needs Node 18 or newer (this is ${process.version}).`);
  process.exit(1);
}
const args = new Set(process.argv.slice(2));
const watchKey = process.argv[process.argv.indexOf('--watch') + 1] || ''; // with --watch: the ticket to watch for Fix my PRs
if (args.has('--self-test')) {
  await import('./src/self-test.mjs');
  process.exit(0);
}
if (args.has('--setup')) {
  const { setup } = await import('./src/setup.mjs');
  process.exit(await setup(process.argv.slice(2)));
}

const { CHECKS_PATH, HOME, loadConfig, saveConfig, writeJson } = await import('./src/config.mjs');
const TRACKERS = { ado: await import('./src/ado.mjs'), jira: await import('./src/jira.mjs') };
const github = await import('./src/github.mjs');
const secrets = await import('./src/secrets.mjs');
const { norm, tagMatches } = await import('./src/match.mjs');
const rv = await import('./src/reviews.mjs');
const { isAlive } = await import('./src/proc.mjs');
const { createFixer } = await import('./src/fixes.mjs');
const update = await import('./src/update.mjs');

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url)); // this folder is also the plugin with prowl-review
const ONCE = args.has('--once');
const LOCK = path.join(HOME, 'lock');
let tui = null; // set once the TUI is up; until then (and with --once) logs go to stdout

const app = {
  cfg: loadConfig(),
  state: rv.loadState(),
  me: '',
  log: [],
  polling: false,
  paused: false,
  nextPoll: 0,
  lastPollEnd: 0,
  lastError: '',
  said: [], // what Hoot has to say: { text, mood, until }, oldest first
  tagVariants: {}, // board -> tags currently treated as the trigger tag
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
  running: () => app.state.runs.filter(r => r.status === 'running' || r.status === 'stopping'),
  finished: () => app.state.runs.filter(r => r.status !== 'running' && r.status !== 'stopping').sort((a, b) => b.endedAt - a.endedAt),
};

const lastByKey = new Map();
/** Logs to the Log view and poller.log. With a key, a message repeated for the same key is logged once (returns false). */
function log(level, msg, key) {
  if (key && lastByKey.get(key) === msg) return false;
  if (key) lastByKey.set(key, msg);
  const entry = { t: Date.now(), level, msg };
  app.log.push(entry);
  if (app.log.length > 500) app.log.shift();
  try { fs.appendFileSync(path.join(HOME, 'poller.log'), `${new Date(entry.t).toISOString()} ${level} ${msg}\n`); } catch { /* best effort */ }
  if (ONCE || !tui) console.log(`${level.padEnd(5)} ${msg}`);
  if (level === 'error') hoot(msg, 'error');
  return true;
}

/** Gives Hoot something to say. `mood`: 'cheer' or 'error' changes how he looks while he says it. */
function hoot(text, mood) {
  app.said.push({ text, mood });
  if (app.said.length > 6) app.said.splice(1, 1); // never fall far behind; keep what's showing
}

// Tags this app sets itself are matched exactly; only the trigger tag is matched loosely.
const ours = t => [app.cfg.tags.inProgress, app.cfg.tags.done].some(x => norm(x) === norm(t));
const isTrigger = t => !ours(t) && tagMatches(t, app.cfg.tags.trigger, app.cfg.tagMatchMaxTypos);

// Fix my PRs: plans fix rounds after reviews, and runs them from poll and tick.
const fixer = createFixer(app, { log, hoot, applyTag, appDir: PLUGIN_DIR, trackers: TRACKERS });

async function poll() {
  app.polling = true;
  app.lastError = '';
  try {
    try { app.cfg = loadConfig(); } catch (e) { log('error', `${e.message} (keeping the previous config)`, 'config'); }
    const pruned = rv.tidyLogs(app.cfg.logRetentionDays, [...app.running(), ...fixer.running()]); // on launch, then once per poll
    if (pruned) log('info', `Deleted ${pruned} review log file${pruned > 1 ? 's' : ''} older than ${app.cfg.logRetentionDays} days`);
    app.me ||= await github.me();
    const tracker = app.tracker();
    const boards = app.boards();
    if (!boards.length) {
      if (log('warn', `No ${tracker.name} boards configured: add one in Config (4).`, 'boards')) hoot(`I have no ${tracker.name} boards to watch yet. Add one in Config (4).`);
      return undefined;
    }
    if (!app.cfg.githubOwner) {
      if (log('warn', 'No GitHub org configured: set it in Config (4).', 'boards')) hoot('I need a GitHub org to search for PRs. Set it in Config (4).');
      return undefined;
    }
    hoot(`Checking ${boards.length > 1 ? 'the boards' : 'the board'} for new review tasks...`);
    const seen = new Set();
    let allRead = true;
    for (const board of boards) {
      const where = tracker.boardLabel(board);
      try {
        const { tickets, variants } = await tracker.findTickets(app.cfg, board, isTrigger);
        app.tagVariants[where] = variants;
        if (!variants.length) log('info', `${where}: no ticket is tagged like '${app.cfg.tags.trigger}'`, `tags:${where}`);
        for (const ticket of tickets) {
          if (seen.has(ticket.key)) continue;
          seen.add(ticket.key);
          await consider(tracker, ticket);
        }
      } catch (e) {
        allRead = false;
        app.lastError = e.message;
        log('error', `${where}: ${e.message}`, `board:${where}`);
      }
    }
    // A ticket at the round cap that is no longer tagged for review has been taken over: its flag clears.
    const untagged = allRead ? Object.keys(app.state.capped || {}).filter(t => !seen.has(t)) : [];
    for (const t of untagged) delete app.state.capped[t];
    if (untagged.length) rv.saveState(app.state);
    await checkHumanApprovals();
    await fixer.poll();
  } catch (e) {
    app.lastError = e.message;
    log('error', e.message, 'poll');
  } finally {
    app.polling = false;
    app.lastPollEnd = Date.now();
    app.nextPoll = Date.now() + app.cfg.pollSeconds * 1000;
  }
  return undefined;
}

async function consider(tracker, ticket) {
  const { cfg, state } = app;
  const key = `ticket:${ticket.key}`;
  if (app.running().some(r => r.ticket === ticket.key)) return; // re-tagged mid-review: re-reviewed once this one ends
  if (fixer.busy(ticket.key)) return log('info', `${ticket.key}: waiting, Prowl is fixing its PRs`, key);
  if (app.running().length >= cfg.maxConcurrentReviews) {
    log('info', `${ticket.key}: waiting, ${cfg.maxConcurrentReviews} reviews already running`, key);
    return;
  }
  const prs = await github.openPrs(cfg.githubOwner, ticket.key);
  if (!prs.length) return log('info', `${ticket.key}: tagged, but no open PR mentions ${ticket.key} yet`, key);
  const mine = prs.filter(p => p.author.toLowerCase() === app.me.toLowerCase());
  if (mine.length && !cfg.reviewOwnPrs) {
    // Skip the whole ticket, not just your PRs: prowl-review reviews a ticket's PRs as one set.
    return log('info', `${ticket.key}: skipped, ${mine.map(p => `${p.repo}#${p.number}`).join(', ')} ${mine.length > 1 ? 'are' : 'is'} yours; leaving it for a teammate`, key);
  }
  const prior = state.runs.filter(r => r.ticket === ticket.key && r.status === 'done').sort((a, b) => b.endedAt - a.endedAt)[0];
  const heads = {}; // PR URL -> its head commit now ('' if unreadable)
  for (const pr of prs) heads[pr.url] = await github.headSha(pr).catch(() => '');
  // A re-review leaves out the PRs the last review approved that have no new commits since; they stay as context.
  const approved = prs.filter(pr => prior?.approved?.[pr.url] && prior.approved[pr.url] === heads[pr.url]);
  const toReview = prs.filter(p => !approved.includes(p));
  if (toReview.length && rv.roundCapped(cfg, prior)) {
    // Left tagged and unclaimed for a person to take over. state.capped lets other tools see it; History flags it.
    if (state.capped?.[ticket.key] !== prior.reviewNo) {
      (state.capped ??= {})[ticket.key] = prior.reviewNo;
      rv.saveState(state);
    }
    return log('warn', `${ticket.key}: not reviewed: it has had ${prior.reviewNo} reviews, the round cap (Max review rounds); leaving it for a person`, key);
  }
  const skipped = approved.length ? ` (already approved, unchanged: ${approved.map(p => `${p.repo}#${p.number}`).join(', ')})` : '';
  if (app.dryRun()) return log('info', `${ticket.key}: would review ${toReview.map(p => p.url).join(' ') || 'nothing'}${skipped}`, key);

  try {
    // Nothing to re-review: straight to done, in one write a teammate's poller can't race.
    await tracker.claim(cfg, ticket, t => isTrigger(t) || ours(t), toReview.length ? cfg.tags.inProgress : cfg.tags.done);
  } catch (e) {
    return log('warn', `${ticket.key}: not claimed (changed or claimed by someone else): ${e.message}`, key);
  }
  if (!toReview.length) {
    hoot(`Every PR for ${ticket.title} is already approved, marking as '${cfg.tags.done}'`, 'cheer');
    return log('ok', `${ticket.key}: every PR is already approved and unchanged since; nothing to re-review`);
  }
  hoot(`Starting reviews for ${ticket.title}, marking as '${cfg.tags.inProgress}'`);
  try {
    const cloned = await github.cloneMissing(prs, cfg.workDir);
    if (cloned.length) log('info', `${ticket.key}: cloned ${cloned.join(', ')} into ${cfg.workDir}`);
  } catch (e) {
    log('warn', `${ticket.key}: ${e.message}; reviewing from GitHub without a local clone`);
  }
  let ticketText = '';
  if (cfg.ticketContext) {
    try {
      ticketText = await tracker.ticketText(cfg, ticket);
    } catch (e) {
      log('warn', `${ticket.key}: couldn't read the ticket's text (${e.message}); reviewing without it`);
    }
  }
  let run;
  try {
    if (prior && cfg.reReviewScope === 'delta' && !prior.reviewedHeads) log('info', `${ticket.key}: re-reviewing in full, as the last review is from before Prowl recorded the commits it reviewed`, `scope:${ticket.key}`);
    run = rv.startReview(cfg, PLUGIN_DIR, { tracker: cfg.taskBoard, ticket, prs: toReview, approvedPrs: approved, prior, me: app.me, heads, ticketText });
  } catch (e) {
    log('error', `${ticket.key}: could not start the review: ${e.message}`);
    return applyTag({ tracker: cfg.taskBoard, ticket: ticket.key, ref: ticket.ref, id: `claim-${ticket.key}`, pendingTag: cfg.tags.trigger });
  }
  state.runs.push(run);
  if (state.capped) delete state.capped[ticket.key]; // the cap was raised or turned off
  rv.saveState(state);
  lastByKey.delete(key);
  hoot(toReview.length > 1 ? `Starting a batch review of ${toReview.length} PRs` : `Starting a review of ${toReview[0].title}`);
  return log('ok', `${ticket.key}: ${prior ? `re-review #${run.reviewNo}` : 'review'} started on ${toReview.length} PR${toReview.length > 1 ? 's' : ''}${skipped}`);
}

/** Clears History's ⚑ flag on each PR a human has approved since Prowl gave it its stamp (Approve PRs off, or your own PR). */
async function checkHumanApprovals() {
  const latest = new Map(); // the flag shows on each ticket's latest review only
  for (const r of app.finished()) if (r.status === 'done' && !latest.has(r.ticket)) latest.set(r.ticket, r);
  for (const run of latest.values()) {
    for (const url of rv.awaitingHuman(run, app.cfg.approvals)) {
      try {
        if (!(await github.humanApproved(url, run.approved[url]))) continue;
      } catch (e) {
        log('warn', `${run.ticket}: couldn't check ${url} for a human approval (${e.message})`, `human:${url}`);
        continue;
      }
      run.awaitingHuman = rv.awaitingHuman(run, app.cfg.approvals).filter(u => u !== url);
      rv.saveState(app.state);
      log('ok', `${run.ticket}: ${url} is approved (or merged or closed); its flag is cleared`);
    }
  }
}

/** Announces each PR whose review has been posted since the run started (checked about once a minute). */
async function checkPosted(run) {
  run._checkedAt = Date.now();
  run.reviewedPrs ??= [];
  for (const pr of run.prs) {
    if (run.reviewedPrs.includes(pr.url)) continue;
    try {
      if (!(await github.reviewedSince(pr, app.me, run.startedAt))) continue;
    } catch (e) {
      log('warn', `${run.ticket}: couldn't check ${pr.repo}#${pr.number} for a posted review (${e.message})`, `posted:${run.id}`);
      continue;
    }
    run.reviewedPrs.push(pr.url);
    rv.saveState(app.state);
    hoot(`Done reviewing ${pr.title}`, 'cheer');
  }
}

/** Settles a review whose session ended, then moves the ticket's tag on. */
async function finish(run) {
  rv.finalize(run);
  const { tags } = app.cfg;
  const failures = app.state.failures;
  if (run.status === 'done') {
    await checkPosted(run).catch(() => {}); // announce any PR posted since the last check
    delete failures[run.ticket];
    run.pendingTag = tags.done;
    const s = run.summary || {};
    log('ok', `${run.ticket}: review ${run.reviewNo} finished: ${s.verdict || 'no verdict'} (C${s.critical ?? '?'} H${s.high ?? '?'} M${s.medium ?? '?'} L${s.low ?? '?'} N${s.nit ?? '?'}) · ${run.reportPath}`);
    hoot(`Done reviewing PRs for ${run.title}, marking as '${tags.done}'`, 'cheer');
  } else if (run.status === 'failed') {
    failures[run.ticket] = (failures[run.ticket] || 0) + 1;
    const retry = rv.retryFailed(run, failures[run.ticket]); // one automatic retry, then wait for a human to re-tag
    run.pendingTag = retry ? tags.trigger : '';
    const why = run.capped ? 'Not retried, as it hit a cap' : 'Not retrying again';
    log('error', `${run.ticket}: review failed: ${run.error}. ${retry ? `Re-tagged '${tags.trigger}' to retry once.` : `${why}; re-tag '${tags.trigger}' to try again.`}`);
  } else {
    run.pendingTag = '';
    log('warn', `${run.ticket}: review stopped. Re-tag '${tags.trigger}' to run it again.`);
  }
  rv.saveState(app.state);
  await applyTag(run);
}

/** Writes run.pendingTag to the ticket (replacing the tags this app owns); retried every minute until it lands. */
async function applyTag(run) {
  run._tagging = true;
  try {
    await TRACKERS[run.tracker].retag(app.cfg, run.ref, ours, run.pendingTag);
    run.pendingTag = null;
    rv.saveState(app.state);
    if (run.status === 'done') fixer.afterReview(run); // once its done tag has landed
  } catch (e) {
    run._tagRetryAt = Date.now() + 60_000;
    log('error', `${run.ticket}: couldn't update the ticket's tags yet (${e.message}); retrying every minute`, `tag:${run.id}`);
  } finally {
    run._tagging = false;
  }
}

/** Stops a review that has run past the Review time limit. It then fails with the cap named, and isn't retried. */
function stopOverdue(run) {
  run.capped = `time cap ${app.cfg.reviewTimeoutMinutes} min`;
  rv.stopReview(run);
  rv.saveState(app.state);
  log('warn', `${run.ticket}: stopping the review: it ran past the ${app.cfg.reviewTimeoutMinutes}-minute time limit`);
}

/** Once a second: tail running reviews, settle finished ones, retry tag writes, poll when due. */
function tick() {
  for (const run of app.running()) {
    if (run._finishing) continue;
    rv.readActivity(run);
    if (run._result || !rv.alive(run)) {
      rv.readActivity(run); // pick up the last lines written before exit
      run._finishing = true;
      finish(run).catch(e => log('error', `${run.ticket}: ${e.message}`));
    } else if (rv.overdue(run, app.cfg)) {
      stopOverdue(run);
    } else if (app.me && !run._checking && Date.now() - (run._checkedAt || 0) > 60_000) {
      run._checking = true;
      checkPosted(run).finally(() => { run._checking = false; });
    }
  }
  fixer.tick();
  for (const run of [...app.state.runs, ...Object.values(app.state.loops || {})]) { // a fix loop re-tags its ticket too
    const ended = run.status !== 'running' && run.status !== 'stopping';
    if (ended && run.pendingTag != null && !run._tagging && Date.now() >= (run._tagRetryAt || 0)) applyTag(run);
  }
  if (!app.paused && !app.polling && Date.now() >= app.nextPoll) poll();
}

// One instance per user: two would both finish the same reviews.
try {
  const pid = Number(fs.readFileSync(LOCK, 'utf8'));
  if (pid && pid !== process.pid && isAlive(pid)) {
    console.error(`prowl is already running (pid ${pid}).`);
    process.exit(1);
  }
} catch { /* no lock */ }

// Updates run before taking the lock, which the installer checks. A review still running from an earlier launch
// reads the skill's files as it goes, so the update waits for a launch with none running.
if (app.cfg.autoUpdate && !process.env.PROWL_UPDATED) {
  const version = await update.availableUpdate(PLUGIN_DIR);
  if (version && app.running().some(rv.alive)) {
    log('info', `Prowl ${version} is available. It installs on the first launch with no review running.`);
    hoot(`Prowl ${version} is out. I'll update once the running reviews finish and you start me again.`);
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

if (args.has('--watch')) {
  // Fix my PRs only: rounds then also start for this ticket's reviews done by anyone. w in History does the same.
  if (!app.cfg.fix.enabled) {
    console.error('--watch is for Fix my PRs: turn it on in Config (4) first.');
    process.exit(1);
  }
  try {
    const t = await app.tracker().lookup(app.cfg, watchKey);
    fixer.watch({ ticket: t.key, tracker: app.cfg.taskBoard, ref: t.ref, title: t.title, ticketUrl: t.url });
    console.log(`Watching ${t.key} "${t.title}" for Fix my PRs.`);
  } catch (e) {
    console.error(`Couldn't watch ${watchKey || '(no ticket given)'}: ${e.message}`);
    process.exit(1);
  }
}

try {
  app.notes = update.updateNotes(PLUGIN_DIR); // shown once, on the first launch after an update
} catch (e) {
  log('warn', `Couldn't bring your config files in ${path.join(HOME, 'config')} up to date: ${e.message}`);
}

if (ONCE) {
  if (app.notes) console.log(`${update.notesText(app.notes)}\n`);
  for (const run of app.running()) {
    rv.readActivity(run);
    if (run._result || !rv.alive(run)) await finish(run);
    else if (rv.overdue(run, app.cfg)) stopOverdue(run); // settled by the next launch, once it has exited
  }
  await poll();
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
const { startTui } = await import('./src/tui.mjs');
tui = startTui(app, {
  pollNow: () => { app.nextPoll = 0; },
  togglePause: () => { app.paused = !app.paused; },
  stop: run => {
    if (run.pr) return fixer.stop(run); // a fix session
    rv.stopReview(run);
    rv.saveState(app.state);
    return log('warn', `${run.ticket}: stopping the review`);
  },
  watch: run => (fixer.watch({ ticket: run.ticket, tracker: run.tracker, ref: run.ref, title: run.title, ticketUrl: run.ticketUrl })),
  answer: (item, text) => fixer.answer(item, text),
  skip: item => fixer.skip(item),
  takeOver: ticket => fixer.takeOver(ticket),
  fixing: () => fixer.running(),
  saveConfig: () => {
    saveConfig(app.cfg);
    if (app.cfg.fix.enabled && !fs.existsSync(CHECKS_PATH)) writeJson(CHECKS_PATH, {}); // the Checks before push file to fill in
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
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, e => { tui?.restore(); tui = null; console.error(e); process.exit(1); });
}
ticker = setInterval(tick, 1000);
tick();
