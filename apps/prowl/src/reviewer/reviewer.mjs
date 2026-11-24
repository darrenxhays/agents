// The Reviewer polls GitHub for labelled PRs and the boards for tagged tickets, and runs prowl-review on their ready PRs.
// src/shell.mjs drives poll() and tick(); the Builder never reads its state (state.json).
import fs from 'node:fs';
import path from 'node:path';
import { CHECKS_PATH, CONFIG_DIR, readChecks, saveConfig, writeJson } from '../config.mjs';
import * as github from '../github.mjs';
import { createLabels, refusal } from '../labels.mjs';
import { askLabel, labelNames, labelsOf, labelWrite, outcomeTag, pendingTag, reviewTags, sameLabel, tagReader } from '../names.mjs';
import { acceptOffer, offerFor } from '../offers.mjs';
import { autoName, cleanName, notARef, parsePaste, ticketKey } from '../paste.mjs';
import { frontMatter, mentionedKeys, mentions } from '../match.mjs';
import { fill, loadOutputTemplates, outputTemplate } from '../templates.mjs';
import * as rv from './reviews.mjs';
import { checkPlan, checksLine, prChecks } from './checks.mjs';
import { backfillUsage } from '../stats.mjs';
import { fillSkeleton } from './handover.mjs';
import { approverIn, buildNotes, noteBody, prowlApproved, recall } from './memory.mjs';
import { prepareReview, removePrep, sweepWorktrees } from './prep.mjs';
import { planPublish } from './publish-plan.mjs';
import { publishReview } from './publish.mjs';
import { prName, reportMd } from './render.mjs';
import { approvable, checkResult, notCarried, verdictLabels } from './result.mjs';

/** Group PRs by their resolved ticket key or, without one, by the Builder's list of sibling PRs. */
export function labelGroups(prs, ticketByUrl) {
  const groups = [];
  for (const pr of prs) {
    const ticket = ticketByUrl.get(pr.url) || '';
    const list = /^The other PRs for [^\r\n]+:\r?\n(?:[ \t]*\r?\n)*((?:- https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+[ \t]*(?:\r?\n|$))+)/im.exec(pr.body || '');
    const linked = new Set(list ? list[1].match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi) : []);
    const urls = new Set([pr.url, ...linked].map(u => u.toLowerCase()));
    const matches = groups.filter(g => ticket ? g.ticket === ticket : !g.ticket && [...g.urls].some(u => urls.has(u)));
    const group = matches.shift() || { ticket, prs: [], linked: new Set(), urls: new Set() };
    if (!groups.includes(group)) groups.push(group);
    for (const other of matches) {
      group.prs.push(...other.prs);
      for (const u of other.linked) group.linked.add(u);
      for (const u of other.urls) group.urls.add(u);
      groups.splice(groups.indexOf(other), 1);
    }
    group.prs.push(pr);
    for (const u of urls) group.urls.add(u);
    for (const u of linked) group.linked.add(u);
  }
  return groups.map(({ ticket, prs, linked }) => ({ ticket, prs, linked: [...linked].filter(u => !prs.some(p => u.toLowerCase() === p.url.toLowerCase())) }));
}

/** The first claim in the current request, in an oldest-first timeline. */
export function labelClaim(events, cfg) {
  const ask = askLabel(cfg);
  const { inReview } = labelNames(cfg);
  let claim = null;
  for (const e of events) {
    if ((e.event === 'labeled' && sameLabel(e.label, ask)) || (e.event === 'unlabeled' && sameLabel(e.label, inReview))) claim = null;
    else if (!claim && e.event === 'labeled' && sameLabel(e.label, inReview)) claim = e;
  }
  return claim;
}

/**
 * The Reviewer side. `deps`: { log(level, msg, key), forget(key), hoot(text, mood), appDir, trackers, github, labels (the
 * label queue both sides share), saveConfig(), autoName (for the self-test) }. The shell reads `paused`, `polling`,
 * `nextPoll` and `lastError`, and calls poll() and tick().
 */
export function createReviewer(app, deps) {
  const { log, forget, hoot, appDir, trackers, github: gh = github } = deps;
  const labels = deps.labels || createLabels({ gh, log: (s, ...a) => log(...a) });
  const side = {
    name: 'reviewer', label: 'Reviewer', state: rv.loadState(), tagVariants: {}, paused: false, polling: false, nextPoll: 0, lastError: '',
  };
  const cfg = () => app.cfg;
  const on = () => app.sideOn('reviewer');
  const save = () => rv.saveState(side.state);
  // A review still being settled (its posting, dismissals and tag not all done) counts as running whatever its status
  // says, so a launch that finds one saved part-way picks it up again.
  const unsettled = r => r.status === 'running' || r.status === 'stopping' || r.phase === 'publishing';
  side.running = () => side.state.runs.filter(unsettled);
  side.finished = () => side.state.runs.filter(r => !unsettled(r)).sort((a, b) => b.endedAt - a.endedAt);
  // Reviews finished before Prowl recorded what a session ran on: read once from their logs, at launch.
  try { if (backfillUsage(side.state.runs.filter(r => !r.pr && r.status !== 'running' && r.status !== 'stopping'), deps.readLogUsage)) rv.saveState(side.state); } catch { /* Stats shows them as not recorded */ }
  /** What Stats shows, one entry per finished review that has an end time. */
  side.spend = () => side.finished().filter(r => !r.pr && r.status !== 'skipped' && r.endedAt).map(r => ({ ticket: r.ticket, title: r.title, ticketUrl: r.ticketUrl || '', label: `${r.reviewNo > 1 ? `re-review #${r.reviewNo}` : 'first review'}${r.quick ? ' · quick' : r.source === 'github' ? ' · GitHub review' : ''}`,
    at: r.endedAt, costUsd: r.costUsd, failed: ['failed', 'stopped'].includes(r.status), parts: [{ at: r.endedAt, ms: r.endedAt - r.startedAt, costUsd: r.costUsd, models: r.models, model: r.model, effort: r.effort }] }));
  side.needs = () => []; // nothing waits on you: a review either runs, or leaves its ticket tagged for a person
  side.alive = () => side.running().some(rv.alive);
  // Reviews still being prepared (a ticket's, or a quick review) hold a slot from the moment they're admitted; a quick
  // review its number too.
  let starting = 0;
  let lastQuick = 0;
  const busy = () => side.running().length + starting;
  /** Holds a slot; the function it returns frees it, once, when the run is recorded or its start is given up. */
  const hold = () => {
    starting++;
    let held = true;
    return () => { if (held) { held = false; starting--; } };
  };

  // Reviews being set up, with the PRs they have: a tagged ticket's from the moment its PRs are known, a quick
  // review's from the moment it is admitted, each until its run is recorded. And the PRs of quick reviews still being
  // looked up or named. Two reviews must never run on one PR at once and post over each other.
  const settingUp = new Map(); // a key of its own -> { ticket, prs }
  const naming = new Set(); // PR URLs
  /** One review at a time owns a ticket key, including starts still checking their PRs. */
  const keyHeld = (key, except) => side.running().some(r => r.ticket === key) || [...settingUp].some(([mark, r]) => mark !== except && r.ticket === key);
  /** Only previously reviewed PRs count toward the round cap. */
  const coveredBy = done => new Set(done.flatMap(r => [...[...r.prs, ...(r.contextPrs || []).filter(p => !r.relatedUrls?.includes(p.url))].map(p => p.url), ...(r.reviewedBefore || [])]));
  /** True for a key that is a tracker's ticket (Azure DevOps or Jira) with its link known: not a quick review's name, nor a PR standing in for one. */
  const isTicket = (key, url) => Boolean(url) && ['ado', 'jira'].some(board => ticketKey(key, board) === key); // either board's: a review outlives a change of Task board

  /**
   * What a review of `key` carries on from: { prior, reviewed, alsoApproved } (recall(), in memory.mjs). `cover`: the
   * PRs it would cover, `heads` theirs; `known`: the ticket's other open PRs at hand; `partial`: the review covers
   * only some of the ticket's PRs, so the others are looked up first.
   */
  function carryOn(c, key, ticketUrl, cover, heads, known, partial) {
    const done = side.state.runs.filter(r => r.ticket === key && r.status === 'done').sort((a, b) => b.endedAt - a.endedAt);
    const ticket = isTicket(key, ticketUrl);
    return recall({ gh, log, me: app.me, key, ticket, own: done[0], runs: side.state.runs, covered: coveredBy(done), cover, heads, known,
      lookup: ticket && partial ? () => gh.openPrs(c.githubOwner, key) : null });
  }

  /** Why a quick review of `ready` can't start, or ''. `reserved`: also count PRs another quick review is naming. */
  function heldBy(ready, reserved, except) {
    const left = [...ready];
    const parts = [];
    const take = (has, what) => {
      const held = left.filter(p => has(p.url));
      if (!held.length) return;
      for (const p of held) left.splice(left.indexOf(p), 1);
      parts.push(`${held.map(p => `${p.repo}#${p.number}`).join(', ')} ${held.length > 1 ? 'are' : 'is'} ${what}`);
    };
    for (const r of [...side.running(), ...settingUp.values()]) {
      if (r !== settingUp.get(except)) take(u => (r.prs || []).some(q => q.url === u), `under review in ${r.ticket}`); // its context PRs don't count
    }
    if (reserved) take(u => naming.has(u), 'already being set up for a review');
    return parts.length ? `Quick review: ${parts.join('; ')}; start it again once ${parts.length > 1 ? 'they end' : 'that one ends'}` : '';
  }

  // Tags this side sets itself are matched exactly; only the trigger tag is matched loosely. The old names (Ready for
  // Review, In Review, Reviewed) are still read, and taken off with the new, but never written.
  const tagsNow = () => reviewTags(cfg());
  const roleOf = t => tagReader(cfg()).role(t);
  const ours = t => ['reviewer.inProgress', 'reviewer.approved', 'reviewer.changes', 'reviewer.done'].includes(roleOf(t));
  const isTrigger = t => roleOf(t) === 'reviewer.trigger';
  const inReview = t => roleOf(t) === 'reviewer.inProgress';

  // ---- Build and test before reviews: a review's checks phase, run here before its session starts ----

  /** The PRs of `prs` to build and test before their review (Build and test before reviews, and a checks.json entry with a step). */
  function checksFor(prs) {
    if (!cfg().reviewChecks) return [];
    try {
      return checkPlan((deps.readChecks || readChecks)(), prs);
    } catch (e) { // a checks.json that doesn't parse: the review runs without checks
      log('warn', `${e.message}: reviews start without building and testing their PRs until ${CHECKS_PATH} is fixed`, 'checks-file');
      return [];
    }
  }

  /**
   * Starts a review of `opts.prs`: straight to its session, or, when its PRs are to be built and tested first, as a
   * run in its checks phase (no session yet), which runChecks() takes on once the run is recorded.
   */
  function begin(c, opts) {
    if (!checksFor(opts.prs).length) return (side.startReview || rv.startReview)(c, appDir, opts);
    return (side.createReview || rv.createReview)(c, { ...opts, appDir, checking: true });
  }
  const note = (run, text) => { (run._activity ??= []).push({ text }); };

  /**
   * A review's checks phase: builds and tests its PRs one at a time, in this process, then starts its session with
   * the results. The plan is read again now, so the setting turned off while a review waits just starts its session.
   * Stopped (by you, or the time cap), no session starts: tick() settles the review once the running check has ended.
   */
  function runChecks(run) {
    if (run._building) return run._building;
    run._abort = new AbortController();
    let capTimer;
    // The time cap counts the checks, and must hold with no once-a-second tick too (--once): the limit is read
    // again when the timer fires, as it can be raised or turned off meanwhile.
    const armCap = () => {
      const minutes = cfg().reviewTimeoutMinutes;
      if (!(minutes > 0)) return;
      capTimer = setTimeout(() => {
        if (run.phase !== 'checks' || run.status !== 'running') return;
        if (rv.overdue(run, cfg())) stopOverdue(run);
        else armCap();
      }, Math.max(0, rv.timedFrom(run) + minutes * 60_000 - Date.now()) + 1);
    };
    run._building = (async () => {
      if (rv.overdue(run, cfg())) return stopOverdue(run); // restored after its time ran out: no check runs
      armCap();
      const c = cfg();
      const results = [];
      for (const item of checksFor(run.prs)) {
        if (run.status !== 'running') break;
        const { pr } = item;
        const name = `${pr.repo}#${pr.number}`;
        note(run, `Building and testing ${name}`);
        let r;
        try {
          const head = run.reviewedHeads?.[pr.url] || await gh.headSha(pr);
          r = await (deps.prChecks || prChecks)(c, item, head, run.logPath.replace(/\.ndjson$/, ''), { signal: run._abort.signal, progress: text => note(run, text) });
        } catch (e) {
          r = { url: pr.url, label: name, error: e.message };
        }
        results.push(r);
        const line = `${run.ticket}: ${checksLine(r)}`;
        log(r.error ? 'warn' : 'info', line);
        note(run, line);
      }
      if (run.status !== 'running') return undefined; // stopped: no session starts
      run.checks = results;
      note(run, 'Checks done: starting the review session');
      try {
        (side.launchReview || rv.launchReview)(cfg(), appDir, run);
        log('info', `${run.ticket}: checks done; review session started`);
      } catch (e) {
        delete run.phase;
        run.spawnError = `could not start the review: ${e.message}`; // fails, and is retried once, like any failed start
      }
      save();
      return undefined;
    })().catch(e => { delete run.phase; run.spawnError = `could not start the review: ${e.message}`; })
      .finally(() => { clearTimeout(capTimer); run._building = null; });
    return run._building;
  }

  // ---- Prowl sets a review up before its session starts (Prepare PRs before reviews) ----

  const preparing = new Map(); // ticket key -> its stand-in, a Running row while the review is being set up
  /** The reviews being set up: each a stand-in for Running, { id: 'preparing:<key>', ticket, title, prs, status: 'preparing', startedAt, _activity }. */
  side.preparing = () => [...preparing.values()];
  const prepping = () => cfg().reviewPrep !== false;

  /** Removes what a review's setup checked out (its worktrees; the prepared files stay). A failure is only a warning. */
  async function dropPrep(run) {
    try {
      await (deps.removePrep || removePrep)(run.prep);
    } catch (e) {
      log('warn', `${run.ticket}: couldn't remove its worktrees (${e.message})`);
    }
  }

  /**
   * Creates a review and does its setup, with a stand-in in Running meanwhile: its PRs checked out in worktrees, and
   * their facts, diffs and comments written to files. A board ticket is claimed after setup. GitHub PR claims
   * are already saved, and releaseClaims gives them back after a quit. The whole setup has a
   * 10-minute limit (a step can't be interrupted): past it the session sets itself up, and whatever the abandoned
   * setup checks out later is removed as soon as it finishes. `stand`: its Running row (standFor). Resolves { run, stand }.
   */
  async function setUp(c, opts, prior, stand) {
    const run = (side.createReview || rv.createReview)(c, { ...opts, appDir, prepping: true, checking: checksFor(opts.prs).length > 0 });
    stand._run = run;
    let timer;
    const work = Promise.resolve().then(() => (deps.prepareReview || prepareReview)(c, appDir, run, { prior, progress: text => note(stand, text) }));
    const prep = await Promise.race([work.catch(() => null), new Promise(r => { timer = setTimeout(() => r(undefined), deps.prepLimitMs ?? 10 * 60_000); })]);
    clearTimeout(timer);
    run.setupMs = Date.now() - run.startedAt; // the time cap doesn't count Prowl's own setup
    if (prep === undefined) {
      log('warn', `${run.ticket}: couldn't prepare its PRs (it took over 10 minutes); the review session sets itself up`);
      work.then(late => (deps.removePrep || removePrep)(late)).catch(() => {});
      return { run, stand };
    }
    if (!prep) return { run, stand };
    run.prep = prep;
    if (run.skeletonPath) { try { fillSkeleton(run.skeletonPath, prep); } catch { /* the skeleton keeps its placeholders, for the session */ } }
    const name = p => `${p.repo}#${p.number}`;
    for (const p of prep.prs) if (p.replaced && p.role === 'review') run.reviewedHeads[p.url] = p.head; // force-pushed since the review started: the new head is the one reviewed
    const bare = prep.prs.filter(p => !p.worktree);
    if (bare.length) log('warn', `${run.ticket}: no worktree for ${bare.map(p => `${name(p)} (${p.error})`).join(', ')}; the session reads ${bare.length > 1 ? 'them' : 'it'} from GitHub`);
    const blind = prep.prs.filter(p => p.viewError);
    if (blind.length) log('warn', `${run.ticket}: couldn't read ${blind.map(name).join(', ')} on GitHub (${blind[0].viewError}); the session reads ${blind.length > 1 ? 'their' : 'its'} facts itself`);
    if (prep.comments?.unread?.length) log('warn', `${run.ticket}: couldn't read the comments on ${prep.comments.unread.join(', ')}; the session fetches them itself`);
    return { run, stand };
  }

  /** The session of a review that was set up: started now, or after its checks. */
  function launchPrepared(c, run) {
    if (run.phase !== 'checks') (side.launchReview || rv.launchReview)(c, appDir, run);
  }

  /**
   * A review's Running row from the moment the Reviewer decides to review, before it clones anything: held in memory
   * only, replaced by the review's own row when its session starts. Each PR's size is read from GitHub meanwhile
   * (all at once; one that can't be read is left out).
   */
  function standFor(ticket, prs, quick = false, others = []) {
    const stand = { id: `preparing:${ticket.key}`, ticket: ticket.key, ticketUrl: ticket.url || '', title: ticket.title, prs, status: 'preparing', startedAt: Date.now(), stats: {}, branches: {}, _activity: [], ...(quick && { quick: true }) };
    // Each PR's size, and the branch of every PR the review covers (`others`: carried as context, or left out), for its
    // details' links. One that can't be read is left out, and never holds the review up.
    stand._sizes = Promise.allSettled([...prs.map(async p => { stand.stats[p.url] = await gh.prStats(p); }), // a GitHub stand-in without these (the self-test) reads none
      ...[...prs, ...others].map(async p => { const b = await gh.headBranch(p); if (b) stand.branches[p.url] = b; })]);
    preparing.set(ticket.key, stand);
    return stand;
  }

  /** Clones the repos a review's PRs need, with a line in its Activity for each step. A clone that fails is not fatal: the review goes on from GitHub. */
  async function cloneFor(c, stand, prs) {
    const t0 = Date.now();
    try {
      const cloned = await gh.cloneMissing(prs, c.workDir, (repo, target) => note(stand, `Cloning ${repo} into ${target}`));
      if (!cloned.length) return;
      note(stand, `Cloned ${cloned.join(', ')} into ${c.workDir} in ${Math.round((Date.now() - t0) / 1000)}s`);
      log('info', `${stand.ticket}: cloned ${cloned.join(', ')} into ${c.workDir}`);
    } catch (e) {
      note(stand, `Couldn't clone: ${e.message}`);
      log('warn', `${stand.ticket}: ${e.message}; reviewing from GitHub without a local clone`);
    }
  }

  /**
   * A review's row takes its stand-in's place: the setup's lines stay at the top of its Activity, and its PRs' sizes
   * go with it (the same object, so a size that arrives later still shows). The review waits at most 10 seconds for
   * the sizes (sizesIn, before anything is claimed or launched); ones that arrive after that are logged once.
   */
  async function sizesIn(stand) {
    const waited = Date.now() - stand.startedAt;
    await Promise.race([stand._sizes.then(() => { stand._sized = true; }), new Promise(r => setTimeout(r, Math.max(0, (deps.sizeWaitMs ?? 10_000) - waited)))]);
  }
  function takeOver(run, stand) {
    stand._run = run; // with or without a setup: a Stop confirmed after the launch stops this review
    const all = Boolean(stand._sized);
    run._activity = [...stand._activity, ...(run._activity || [])];
    run.stats = stand.stats;
    run.branches = stand.branches;
    const had = Object.keys(run.stats).length;
    if (!all) {
      stand._sizes.then(() => {
        if (Object.keys(run.stats).length === had) return;
        save();
        log('info', `${run.ticket}: its PR${run.prs.length > 1 ? 's are' : ' is'} ${rv.sizeTotal(run.prs, run.stats)}`);
      });
    }
  }

  /** On quit: every checks phase is aborted; a run left in its checks phase has them run again from the start next launch. */
  side.abortChecks = () => { for (const run of side.running()) run._abort?.abort(); };

  /** --once: waits for the checks a poll started to finish and their sessions to start, and settles a review stopped during them. */
  side.checksDone = async function checksDone() {
    for (;;) {
      const building = side.running().filter(r => r._building);
      if (!building.length) break;
      await Promise.all(building.map(r => r._building));
    }
    for (const run of side.running().filter(r => r.phase === 'checks' && r.status === 'stopping')) await finish(run);
  };

  side.poll = async function poll() {
    side.lastError = '';
    const pruned = rv.tidyLogs(cfg().logRetentionDays, side.running()); // on launch, then once per poll
    if (pruned) log('info', `Deleted ${pruned} review log file${pruned > 1 ? 's' : ''} older than ${cfg().logRetentionDays} days`);
    app.me ||= await gh.me();
    const permissions = new Map();
    if (githubOn() && !app.dryRun()) await releaseClaims(permissions);
    await checkHumanApprovals(); // before the board checks: a quick review needs neither boards nor an org
    await checkWaits();
    if (githubOn()) await checkLabeled(permissions);
    const tracker = app.tracker();
    const boards = app.boards();
    if (!cfg().githubOwner.trim() && (cfg().githubReviews || boards.length)) {
      if (log('warn', 'No GitHub org configured: set it in Config (4).', 'github-org')) hoot('I need a GitHub org to search for PRs. Set it in Config (4).');
      return;
    }
    forget('github-org');
    if (!boards.length) {
      if (githubOn()) {
        const msg = `Watching GitHub only: checking ${cfg().githubOwner} for '${askLabel(cfg())}'.`;
        if (log('info', msg, 'github-only')) hoot(msg);
      } else if (log('warn', `No ${tracker.name} boards configured: add one in Config (4).`, 'boards')) hoot(`I have no ${tracker.name} boards to watch yet. Add one in Config (4).`);
      return;
    }
    forget('github-only');
    hoot(`Checking ${boards.length > 1 ? 'the boards' : 'the board'} for new review tasks...`);
    const seen = new Set();
    let allRead = true;
    for (const board of boards) {
      const where = tracker.boardLabel(board);
      try {
        const { tickets, variants, unread } = await tracker.findTickets(cfg(), board, isTrigger);
        side.tagVariants[where] = variants;
        if (unread) log('warn', `${where}: only its first 2000 open labelled issues are read, and it has ${unread} more: a ticket tagged among those isn't seen`, `unread:${where}`);
        if (!variants.length) log('info', `${where}: no ticket is tagged like '${cfg().tags.trigger}'`, `tags:${where}`);
        for (const ticket of tickets) {
          if (seen.has(ticket.key)) continue;
          seen.add(ticket.key);
          await consider(tracker, ticket, permissions);
        }
      } catch (e) {
        allRead = false;
        side.lastError = e.message;
        log('error', `${where}: ${e.message}`, `board:${where}`);
      }
    }
    // A ticket at the round cap that is no longer tagged for review has been taken over: its flag clears.
    const untagged = allRead ? Object.keys(side.state.capped || {}).filter(t => !seen.has(t)) : [];
    for (const t of untagged) delete side.state.capped[t];
    if (untagged.length) save();
  };

  async function consider(tracker, ticket, permissions) {
    const c = cfg();
    const key = `ticket:${ticket.key}`;
    if (keyHeld(ticket.key)) return; // re-tagged mid-review: re-reviewed once this one ends
    // ...and so is a ticket someone else's Prowl is reviewing: claiming it now would review its PRs twice at once.
    const busyTag = (ticket.tags || []).find(inReview);
    if (busyTag) {
      log('info', `${ticket.key}: tagged '${c.tags.trigger}' while it is '${busyTag}'; reviewed once that review ends (if none is running, take '${busyTag}' off)`, key);
      return;
    }
    if (busy() >= c.maxConcurrentReviews) {
      log('info', `${ticket.key}: waiting, ${c.maxConcurrentReviews} reviews already running`, key);
      return;
    }
    // The board search can be a few seconds behind the ticket: read as it is now, one that no longer carries the
    // trigger tag is someone else's (claimed, or moved on), and is left out quietly.
    const free = hold(); // held from before the read: a quick review admitted meanwhile can't take the last slot too
    const mark = {}; // what this ticket holds in settingUp
    settingUp.set(mark, { ticket: ticket.key, prs: [] });
    try {
      ticket = await tracker.current(c, ticket);
      if (!(ticket.tags || []).some(isTrigger)) return;
      await prepareTicket(tracker, ticket, key, free, mark, permissions);
    } finally {
      free();
      settingUp.delete(mark);
    }
  }

  async function prepareTicket(tracker, ticket, key, free, mark, permissions) {
    const { state } = side;
    const c = cfg();
    // Drafts are treated as if they weren't there: a draft often waits on the ticket's other PRs.
    // A tagged review takes only the PRs whose title names the ticket, and no other: one that mentions it only in its
    // description, or names several tickets, is left out. Everything below sees the ticket's own PRs alone.
    const found = await gh.openPrs(c.githubOwner, ticket.key);
    const open = found.filter(p => github.titleNamesOnly(p.title, ticket.key));
    const others = found.filter(p => !p.draft && !open.includes(p));
    if (others.length) log('info', `${ticket.key}: left out ${others.map(p => `${p.repo}#${p.number}`).join(', ')}: only a PR whose title names ${ticket.key}, and no other ticket, is reviewed with it`, `${key}:left-out`);
    const prs = open.filter(p => !p.draft);
    if (!prs.length) return log('info', `${ticket.key}: tagged, but no open, ready PR names ${ticket.key}, and no other ticket, in its title yet`, key);
    settingUp.set(mark, { ticket: ticket.key, prs }); // a quick review of any of these waits for this one
    const mine = prs.filter(p => rv.isOwn(p, app.me));
    if (mine.length && !c.reviewOwnPrs) {
      // Skip the whole ticket, not just your PRs: prowl-review reviews a ticket's PRs as one set.
      return log('info', `${ticket.key}: skipped, ${mine.map(p => `${p.repo}#${p.number}`).join(', ')} ${mine.length > 1 ? 'are' : 'is'} yours; leaving it for a teammate`, key);
    }
    const heads = {}; // PR URL -> its head commit now ('' if unreadable)
    for (const pr of prs) heads[pr.url] = await gh.headSha(pr).catch(() => '');
    // The ticket's last review, this Prowl's or a teammate's (from its hand-over notes), and the PRs earlier reviews covered.
    const { prior, reviewed: covered, alsoApproved } = await carryOn(c, ticket.key, ticket.url, prs, heads, found, false);
    // A re-review leaves out the PRs the last review approved that have no new commits since; they stay as context.
    const approved = prs.filter(pr => heads[pr.url] && [prior?.approved?.[pr.url], alsoApproved[pr.url]].includes(heads[pr.url]));
    let toReview = prs.filter(p => !approved.includes(p));
    // An earlier-reviewed PR turned back into a draft keeps its findings untouched (the prompt names it, so it isn't re-checked).
    const leftOut = open.filter(p => p.draft && covered.has(p.url));
    if (toReview.length && rv.roundCapped(c, prior)) {
      const fresh = toReview.filter(p => !covered.has(p.url));
      if (!fresh.length) {
        // Left tagged and unclaimed for a person to take over. state.capped lets other tools see it; History flags it.
        if (state.capped?.[ticket.key] !== prior.reviewNo) {
          (state.capped ??= {})[ticket.key] = prior.reviewNo;
          save();
        }
        return log('warn', `${ticket.key}: not reviewed: it has had ${prior.reviewNo} reviews, the round cap (Max review rounds); leaving it for a person`, key);
      }
      // A PR no earlier review covered (a draft marked ready, say) gets its first review, even past the cap.
      leftOut.push(...toReview.filter(p => !fresh.includes(p)));
      toReview = fresh;
    }
    if (heldBy(toReview, true, mark)) return log('info', `${ticket.key}: waiting for another review of its PRs (${names(toReview)}) to finish`, key);
    settingUp.get(mark).prs = toReview; // the approved, unchanged ones are only context
    const skipped = approved.length ? ` (already approved, unchanged: ${approved.map(p => `${p.repo}#${p.number}`).join(', ')})` : '';
    if (app.dryRun()) return log('info', `${ticket.key}: would review ${toReview.map(p => p.url).join(' ') || 'nothing'}${skipped}`, key);
    if (!on()) return undefined; // switched off while this poll ran
    const blockedByPr = async () => {
      const label = labelNames(c).inReview;
      for (const pr of toReview) {
        if (labels.pending(pr.url, '', label)) continue; // a previous run's settlement can still be queued in --once
        try {
          if (!hasLabel(await gh.prByRef(pr), label)) continue;
          log('info', `${ticket.key}: waiting for the review of ${pr.url} labelled '${label}' (if no review is running, take '${label}' off)`, key);
        } catch (e) {
          log('warn', `${ticket.key}: couldn't check the labels on ${pr.url} (${e.message}); leaving the ticket tagged`, key);
        }
        return true;
      }
      return false;
    };
    if (cfg().githubReviews && await blockedByPr()) return;

    // Everything slow comes before the claim, so nothing is awaited between the claim and the session's start: a
    // quit or crash while a repo clones then leaves the ticket tagged, not In Review with no review running.
    let ticketText = '';
    const stand = toReview.length ? standFor(ticket, toReview, false, [...approved, ...(prior ? leftOut : [])]) : null; // Running lists it from here
    try {
    if (stand) {
      await cloneFor(c, stand, toReview);
      if (c.ticketContext) {
        note(stand, `Reading ${ticket.key}`);
        try {
          ticketText = await tracker.ticketText(c, ticket);
        } catch (e) {
          log('warn', `${ticket.key}: couldn't read the ticket's text (${e.message}); reviewing without it`);
        }
      }
      if (!on()) return undefined; // switched off meanwhile: nothing is claimed yet
    }
    // Prowl's own setup comes before the claim too: a quit or crash during it leaves the ticket tagged, with nothing to give back.
    const opts = { tracker: c.taskBoard, ticket, prs: toReview, approvedPrs: approved, leftOut: prior ? leftOut : [], prior, me: app.me, heads, ticketText, alsoApproved, reviewedBefore: prior?.shared ? [...covered] : null };
    let set = null;
    if (stand && prepping()) {
      try {
        set = await setUp(c, opts, prior, stand);
      } catch (e) {
        return log('error', `${ticket.key}: could not start the review: ${e.message}`);
      }
    }
    if (stand && (stand.stopped || !on())) {
      if (set) await dropPrep(set.run);
      if (!stand.stopped) return undefined; // switched off during the setup: nothing claimed, the ticket stays tagged for the next poll
      // Nothing was claimed, so there is no in-progress tag to remove: the trigger tag comes off, or the next poll would start it again.
      try {
        await tracker.retag(c, ticket.ref, isTrigger, '');
        return log('warn', `${ticket.key}: review stopped during its setup. Re-tag '${c.tags.trigger}' to run it again.`);
      } catch (e) {
        return log('error', `${ticket.key}: review stopped during its setup, but taking '${c.tags.trigger}' off failed (${e.message}); remove it by hand, or the next poll starts it again`);
      }
    }
    /** The setup's worktrees go when the review doesn't start after all. */
    const unset = async () => { if (set) await dropPrep(set.run); };
    if (stand) await sizesIn(stand); // before the claim: nothing is awaited between the session's start and its run being saved
    const boardLabels = [];
    const labelNotes = {};
    const checkedLabels = cfg().githubReviews;
    if (checkedLabels) {
      for (const pr of [...toReview, ...approved, ...leftOut.filter(p => !p.draft)]) {
        try {
          if (await mayLabel(pr, permissions)) { boardLabels.push(pr); continue; }
          labelNotes[pr.url] = accessReason(pr);
        } catch (e) {
          labelNotes[pr.url] = `Couldn't check label access on ${pr.repo} (${e.message})`;
        }
        log('warn', `${ticket.key}: ${labelNotes[pr.url]}; the ticket's tags carry the review`, `board-label:${pr.url}`);
      }
      if (cfg().githubReviews && await blockedByPr()) return unset();
    }
    const to = toReview.length ? c.tags.inProgress : tagsNow().approved; // nothing to re-review: straight to approved, in one write a teammate's poller can't race
    try {
      await tracker.claim(c, ticket, t => isTrigger(t) || ours(t), to);
    } catch (e) {
      await unset();
      if (e.lost) return log('warn', `${ticket.key}: not claimed (changed or claimed by someone else): ${e.message}`, key);
      // Any other failure may have come after the write landed: the ticket may carry the tag with nobody reviewing it.
      return log('error', `${ticket.key}: the claim failed (${e.message}) and may still have reached the ticket: if it is '${to}' now, put '${c.tags.trigger}' back`, key);
    }
    // Puts the trigger tag back. One the tracker refuses is kept in state.releases, which tick() retries each minute.
    const release = async (to2 = c.tags.trigger) => {
      const r = { tracker: c.taskBoard, ticket: ticket.key, ref: ticket.ref, id: `claim-${ticket.key}`, pendingTag: to2 };
      await applyTag(r);
      if (r.pendingTag != null) { (state.releases ??= []).push(r); save(); }
    };
    if (!toReview.length) {
      if (cfg().githubReviews && boardLabels.length) queueStartLabels(c, `board-${ticket.key}-${Date.now()}`, [], boardLabels);
      hoot(`Every PR for ${ticket.title} is already approved, marking as '${to}'`, 'cheer');
      return log('ok', `${ticket.key}: every PR is already approved and unchanged since; nothing to re-review`);
    }
    if (!on()) {
      log('info', `${ticket.key}: the Reviewer was switched off as it claimed this ticket; putting '${c.tags.trigger}' back`);
      await unset();
      return release();
    }
    if (stand?.stopped) { // Stop was confirmed while the claim was on its way: no session starts, and the claim's tag comes off
      log('warn', `${ticket.key}: review stopped during its setup. Re-tag '${c.tags.trigger}' to run it again.`);
      await unset();
      return release('');
    }
    if (cfg().githubReviews && !checkedLabels) {
      log('info', `${ticket.key}: GitHub reviews switched on during the ticket claim; checking its PRs next poll`);
      await unset();
      return release();
    }
    hoot(`Starting reviews for ${ticket.title}, marking as '${c.tags.inProgress}'`);
    let run;
    try {
      if (prior && c.reReviewScope === 'delta' && !prior.reviewedHeads) log('info', `${ticket.key}: re-reviewing in full, as the last review is from before Prowl recorded the commits it reviewed`, `scope:${ticket.key}`);
      if (set) { ({ run } = set); launchPrepared(c, run); } else run = begin(c, opts);
      takeOver(run, stand);
    } catch (e) {
      log('error', `${ticket.key}: could not start the review: ${e.message}`);
      await unset();
      return release();
    }
    state.runs.push(run);
    if (cfg().githubReviews) {
      run.labels = true;
      run.labelNotes = labelNotes;
      queueStartLabels(c, run.id, boardLabels.filter(p => toReview.includes(p)), boardLabels.filter(p => !toReview.includes(p)));
    }
    preparing.delete(ticket.key);
    if (run.rolesNote) log('warn', rv.rolesWarning(run), 'roles');
    free(); // the run counts itself from here
    endWaits(ticket.key, 'its tagged review started');
    if (state.capped) delete state.capped[ticket.key]; // the cap was raised or turned off, or a new PR came in
    save();
    forget(key);
    const checking = run.phase === 'checks';
    hoot(checking ? `Building and testing the PRs for ${ticket.title} before reviewing them` : toReview.length > 1 ? `Starting a batch review of ${toReview.length} PRs` : `Starting a review of ${toReview[0].title}`);
    log('ok', `${ticket.key}: ${prior ? `re-review #${run.reviewNo}` : 'review'} started on ${toReview.length} PR${toReview.length > 1 ? 's' : ''}${rv.sizeNote(toReview, run.stats)}${skipped}${checking ? ', building and testing first' : ''}`);
    if (checking) runChecks(run);
    return announce(run);
    } finally {
      preparing.delete(ticket.key); // whichever way it went, its stand-in goes
    }
  }

  // ---- GitHub reviews: the Review label asks, the in-review label claims ----

  /** Recheck before each claim in case the poll was paused or switched off during a read. */
  const githubOn = () => on() && !side.paused && cfg().githubReviews && cfg().githubOwner.trim();
  /** The live request and claim use the same exact label match as the search. */
  const hasLabel = (pr, name) => pr.labels?.some(l => sameLabel(l, name));
  /** The permission check's reason also appears in History for the skipped PR. */
  const accessReason = pr => `Labelling ${pr.repo} needs triage or write access`;
  /** GraphQL reports missing PRs and repositories without an HTTP error status. */
  const lastingRefusal = e => refusal(e) || /Could not resolve to a (PullRequest|Repository)/i.test(e.message);
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  /** Cache access per repo for the whole poll, including any board reviews that follow. */
  function mayLabel(pr, permissions) {
    const repo = pr.repo.toLowerCase();
    if (!permissions.has(repo)) permissions.set(repo, gh.canLabel(pr.repo).catch(e => {
      if (lastingRefusal(e)) return false;
      throw e;
    }));
    return permissions.get(repo);
  }

  /** Reviewed PRs change owners. Context PRs use up their request after any pending outcome. */
  function queueStartLabels(c, owner, reviewed, context) {
    labels.own('reviewer', owner, reviewed.map(p => p.url));
    for (const p of reviewed) labels.set('reviewer', owner, p, labelWrite(c, labelNames(c).inReview, ['ask', 'approved', 'changes'], ['ask', 'inReview', 'done']));
    for (const p of context) {
      if (side.running().some(r => r.prs?.some(q => q.url === p.url))) continue;
      const previous = labels.owner('reviewer', p.url);
      const contextOwner = previous && labels.pending(p.url, previous) ? previous : owner;
      if (contextOwner !== previous) labels.own('reviewer', contextOwner, [p.url]);
      labels.set('reviewer', contextOwner, p, labelWrite(c, '', ['ask'], ['ask']));
    }
  }

  /** A stable queue owner lets later requests reuse the same PR's claim records. */
  const claimOwner = url => `claim-${url}`;

  /** At launch, leave interrupted claims to releaseClaims before any queued add can run. */
  side.dropQueuedClaims = () => {
    for (const url of Object.keys(side.state.labelClaims || {})) labels.drop(claimOwner(url), [url]);
  };

  /** Once settled or lost, a claim needs no further release checks. */
  function forgetClaim(url) {
    delete side.state.labelClaims[url];
    save();
  }

  /** Hand the settlement to the durable label queue before forgetting the claim. */
  function settleClaim(pr, claim, role) {
    const c = cfg();
    const add = role === 'ask' ? askLabel(c) : role === 'approved' ? labelNames(c).approved : '';
    const write = role === 'withdrawn' ? labelWrite(c, '', [], [])
      : labelWrite(c, add, ['ask', 'inReview', 'approved', 'changes'], ['ask', 'inReview', 'done']);
    write.exact.push(claim.label); // a label renamed after the claim still comes off
    const owner = claimOwner(pr.url);
    labels.own('reviewer', owner, [pr.url]);
    labels.set('reviewer', owner, pr, write);
    forgetClaim(pr.url); // the durable queue now owns the settlement
  }

  /** Release orphaned claims only while the latest in-review event can still be attributed to this start. */
  async function releaseClaims(permissions) {
    for (const [url, claim] of Object.entries(side.state.labelClaims || {})) {
      if (!githubOn() || app.dryRun()) break;
      const pr = { url, repo: claim.repo, number: claim.number };
      if (heldBy([pr], true) || labels.pending(url)) continue;
      try {
        const live = await gh.prByRef(pr);
        if (live.state !== 'open' || !hasLabel(live, claim.label)) { forgetClaim(url); continue; }
        const last = (await gh.labelEvents(pr)).findLast(e => e.event === 'labeled' && sameLabel(e.label, claim.label));
        if (!last) { // allow 30 minutes for the timeline to catch up before abandoning an unverifiable claim
          if (Date.now() - claim.at > 30 * 60_000) {
            log('warn', `${url}: no timeline event for its claim after 30 minutes; leaving the labels alone`);
            forgetClaim(url);
          }
          continue;
        }
        // Without a saved event time, allow five minutes of clock skew but leave later claims by the same login alone.
        if (!sameLabel(last.actor, app.me) || (claim.seen ? last.at !== claim.seen : Math.abs(Date.parse(last.at) - claim.at) > 5 * 60_000)) {
          forgetClaim(url);
          continue;
        }
        if (!(await mayLabel(pr, permissions))) { log('warn', accessReason(pr)); forgetClaim(url); continue; }
        if (heldBy([pr], true) || labels.pending(url)) continue;
        if (githubOn() && !app.dryRun()) settleClaim(pr, claim, 'ask');
      } catch (e) {
        log('warn', `${url}: couldn't release its label claim (${e.message})`, `release:${url}`);
        if (lastingRefusal(e)) forgetClaim(url);
      }
    }
  }

  /** One History row per request: true retries the permission check, 'refused' waits for a fresh request. */
  function noteNoAccess(pr, key, refused = '', requestEvent = null) {
    const error = refused || accessReason(pr);
    log('warn', `${pr.url}: not reviewed. ${error}`, `access:${pr.url}`);
    if (app.dryRun() || side.state.noAccess?.[pr.url]) return;
    const at = Date.now();
    (side.state.noAccess ??= {})[pr.url] = refused ? 'refused' : true;
    side.state.runs.push({ id: `skip-${pr.repo}#${pr.number}-${at}`, ticket: key, title: pr.title, source: 'github', status: 'skipped',
      startedAt: at, endedAt: at, prs: [pr], error, ...(requestEvent && { requestEvent }) });
    save();
  }

  /** Forget a resolved denial so a new request can claim the PR or record its own refusal. */
  function clearNoAccess(url) {
    if (!side.state.noAccess?.[url] || app.dryRun()) return;
    labels.clearRefusal(claimOwner(url), url);
    delete side.state.noAccess[url];
    forget(`access:${url}`);
    save();
  }

  /** A later Review-label event also detects requests removed and renewed between two polls. */
  async function requestRenewed(pr, c) {
    const skipped = side.state.runs.findLast(r => r.status === 'skipped' && r.prs[0].url === pr.url);
    const latest = (await gh.labelEvents(pr)).findLast(e => e.event === 'labeled' && sameLabel(e.label, askLabel(c)));
    if (!latest || !skipped) return false;
    return skipped.requestEvent ? (latest.id || latest.at) !== skipped.requestEvent : Date.parse(latest.at) > skipped.endedAt;
  }

  /** Leave a claimed PR alone even if it still carries the Review label. */
  function alreadyLabeled(pr, c) {
    const label = labelNames(c).inReview;
    if (!hasLabel(pr, label)) return false;
    log('info', `${pr.url}: already labelled '${label}', leaving it alone`, `in-review:${pr.url}`);
    return true;
  }

  /** Resolve each key once for grouping. Keep a lone key on a tracker outage so its review retains the ticket's history. */
  async function groupTickets(c, prs) {
    const tickets = new Map();
    const ticketByUrl = new Map();
    for (const pr of prs) {
      const keys = mentionedKeys(`${pr.title}\n${pr.body || ''}`, c.taskBoard);
      for (const key of keys) {
        if (tickets.has(key)) continue;
        try {
          const ticket = await app.tracker().lookup(c, key);
          tickets.set(key, ticket);
          if (ticket) tickets.set(ticket.key, ticket);
        } catch (e) {
          tickets.set(key, e.status === 404 ? null : undefined);
          if (e.status !== 404) log('warn', `${key}: couldn't read the ticket (${e.message}); reviewing its labelled PRs without it`, `lookup:${key}`);
        }
      }
      const found = keys.filter(key => tickets.get(key));
      const possible = found.length ? [...new Set(found.map(key => tickets.get(key).key))] : keys.filter(key => tickets.get(key) !== null);
      if (possible.length === 1) ticketByUrl.set(pr.url, possible[0]);
      else {
        const boardKey = found.find(k => github.titleNamesOnly(pr.title, k) && tickets.get(k).tags?.some(t => isTrigger(t) || inReview(t)));
        if (boardKey) ticketByUrl.set(pr.url, tickets.get(boardKey).key);
      }
    }
    return { groups: labelGroups(prs, ticketByUrl), tickets };
  }

  /** Search once and pass only ready, unclaimed PRs outside quick-review waits to the group checks. */
  async function checkLabeled(permissions) {
    const c = cfg();
    let result;
    try {
      result = await gh.labeledPrs(c.githubOwner, askLabel(c));
      forget('github-search');
    } catch (e) {
      return log('warn', `Couldn't search GitHub for '${askLabel(c)}' (${e.message}); trying again next poll`, 'github-search');
    }
    if (result.capped) log('warn', 'GitHub returned 1000 PRs. Some labelled PRs may be missing.', 'github-limit');
    else forget('github-limit');
    const asked = new Set(result.prs.map(p => p.url));
    if (!result.capped) {
      clearDeferredLinks(url => !asked.has(url));
      for (const url of Object.keys(side.state.noAccess || {})) if (!asked.has(url)) clearNoAccess(url);
    }
    const waits = side.waits();
    const waited = new Set(waits.flatMap(w => {
      if (w._covered) return w._covered;
      const run = side.state.runs.find(r => r.id === w.runId);
      const previous = [...(run?.prs || []), ...(run?.contextPrs || [])];
      return [...(w.waitingOn || []), ...previous.map(p => p.url),
        ...(w.paste?.prs || []).map(p => `https://github.com/${p.repo}/pull/${p.number}`)].filter(u => !w.letGo?.[u]);
    }));
    const candidates = result.prs.filter(p => {
      if (p.draft || waited.has(p.url) || heldBy([p], true) || labels.pending(p.url) || side.state.labelClaims?.[p.url]) return false;
      if (waits.some(w => !w._covered && !w.letGo?.[p.url] && w.paste?.tickets?.some(key => mentions(`${p.title} ${p.body || ''}`, key)))) return false;
      return !alreadyLabeled(p, c);
    });
    if (busy() >= c.maxConcurrentReviews) return;
    const { groups, tickets } = await groupTickets(c, candidates);
    for (const group of groups) {
      if (!githubOn()) break;
      try {
        await considerLabeled(c, group, permissions, tickets);
      } catch (e) {
        log('warn', `${names(group.prs)}: GitHub review couldn't start (${e.message})`, `github:${group.prs[0].url}`);
      }
    }
  }

  function clearDeferredLinks(remove) {
    const deferred = side.state.deferredLinks;
    if (deferred?.some(remove) && !app.dryRun()) {
      side.state.deferredLinks = deferred.filter(url => !remove(url));
      save();
    }
  }

  /** Add only the in-review label until the timeline shows which login claimed this request first. */
  async function claimLabeled(c, pr, key) {
    const claim = { at: Date.now(), label: labelNames(c).inReview, repo: pr.repo, number: pr.number };
    (side.state.labelClaims ??= {})[pr.url] = claim; // a quit after the write must leave enough to release it
    save();
    const owner = claimOwner(pr.url);
    labels.own('reviewer', owner, [pr.url]);
    labels.clearRefusal(owner, pr.url); // a previous request's refusal cannot block a fresh claim
    const write = labels.set('reviewer', owner, pr, labelWrite(c, claim.label, [], []));
    await labels.drain();
    const refused = labels.refused(owner, pr.url);
    if (refused) {
      const latest = (await gh.labelEvents(pr).catch(() => [])).findLast(e => e.event === 'labeled' && sameLabel(e.label, askLabel(c)));
      noteNoAccess(pr, key, refused, latest?.id || latest?.at);
      forgetClaim(pr.url);
      return false;
    }
    if (write?._addState === 'present') {
      forgetClaim(pr.url);
      log('info', `${pr.url}: already labelled '${claim.label}', leaving it alone`, `in-review:${pr.url}`);
      return false;
    }
    if (write?._addState !== 'landed') {
      labels.drop(owner, [pr.url]); // a later retry must first check the request again
      log('warn', `${pr.url}: its claim did not finish; checking again next poll`, `claim:${pr.url}`);
      if (write?._addState !== 'sent') forgetClaim(pr.url); // a sent but unconfirmed claim still needs the release check
      return false;
    }
    forget(`claim:${pr.url}`);
    for (let i = 0; i < 3; i++) {
      const event = labelClaim(await gh.labelEvents(pr).catch(() => []), c);
      if (event) {
        if (!sameLabel(event.actor, app.me)) {
          forgetClaim(pr.url);
          log('info', `${pr.url}: @${event.actor} claimed it first; leaving it for their review`);
          return false;
        }
        claim.seen = event.at;
        save();
        break;
      }
      if (i < 2) await sleep(2000);
    }
    const live = await gh.prByRef(pr);
    if (!hasLabel(live, claim.label)) { forgetClaim(pr.url); return false; }
    const requested = live.state === 'open' && hasLabel(live, askLabel(c));
    if (!requested || live.draft) {
      settleClaim(pr, claim, 'withdrawn');
      if (!requested) clearDeferredLinks(url => url === pr.url);
      return false;
    }
    return live;
  }

  /** Reuse a prior ticketless run's key so retries and re-reviews share its history. */
  function githubKey(prs) {
    const prior = side.state.runs.findLast(r => r.source === 'github' && r.status !== 'skipped' && !r.githubTicket && prs.some(p => r.prs.some(q => p.url === q.url)));
    return prior?.ticket || `${prs[0].repo}#${prs[0].number}`;
  }

  function leaveToBoard(prs, ticket) {
    const tag = ticket?.tags?.find(t => isTrigger(t) || inReview(t));
    if (!tag) return prs;
    const covered = prs.filter(p => github.titleNamesOnly(p.title, ticket.key));
    if (covered.length) log('info', `${ticket.key}: tagged '${tag}'; leaving ${names(covered)} to the board review. Take '${tag}' off if no review is running.`, `board-review:${ticket.key}`);
    return prs.filter(p => !covered.includes(p));
  }

  /** Reserve the group while checking its live requests, then start a review only for claims this login won. */
  async function considerLabeled(c, group, permissions, tickets) {
    const { prs } = group;
    if (heldBy(prs, true)) return;
    if (!c.reviewOwnPrs && prs.some(p => rv.isOwn(p, app.me))) {
      return log('info', `${names(prs)}: a PR is yours; leaving the GitHub review for a teammate`, `own:${prs[0].url}`);
    }
    if (busy() >= c.maxConcurrentReviews) return;
    const key = group.ticket || githubKey(prs);
    if (keyHeld(key)) return;
    const free = hold();
    const mark = {}; // reserve these PRs while checking live labels and settling claims
    settingUp.set(mark, { ticket: key, prs });
    const won = [];
    let settle = 'ask';
    try {
      const ticket = tickets.get(group.ticket);
      let open = [];
      const context = [];
      for (const pr of leaveToBoard(prs, ticket)) {
        const allowed = await mayLabel(pr, permissions);
        if (allowed && side.state.noAccess?.[pr.url] !== 'refused') clearNoAccess(pr.url);
        let live;
        try { live = await gh.prByRef(pr); }
        catch (e) {
          if (!allowed && lastingRefusal(e)) { noteNoAccess(pr, key); context.push(pr); continue; }
          throw e;
        }
        if (!hasLabel(live, askLabel(c)) || live.state !== 'open') {
          clearNoAccess(pr.url);
          clearDeferredLinks(url => url === pr.url);
          continue;
        }
        if (live.draft || alreadyLabeled(live, c)) continue;
        if (side.state.noAccess?.[pr.url] === 'refused') {
          if (!await requestRenewed(pr, c) || app.dryRun()) { context.push(live); continue; }
          clearNoAccess(pr.url);
        }
        if (!allowed) { noteNoAccess(pr, key); context.push(live); }
        else open.push(live);
      }
      if (!open.length || !githubOn()) return;
      const links = group.linked.map(url => ({ url, ...github.parsePrRefs(url)[0] }));
      const contextRefs = [...links];
      if (group.ticket) {
        try { contextRefs.push(...await gh.openPrs(c.githubOwner, key)); }
        catch (e) { log('warn', `${key}: couldn't look up its other PRs (${e.message}); reviewing the labelled PRs`); }
      }
      const seen = new Set([...open, ...context].map(p => p.url.toLowerCase()));
      let missingLink = false;
      for (const ref of contextRefs) {
        if (ref.draft || seen.has(ref.url.toLowerCase())) continue;
        seen.add(ref.url.toLowerCase());
        const live = await gh.prByRef(ref).catch(e => {
          log('warn', `${key}: couldn't read context PR ${ref.url} (${e.message})`, `context:${ref.url}`);
          return null;
        });
        if (live?.state === 'open' && !live.draft) {
          if (!hasLabel(live, askLabel(c))) context.push(live);
          if (!group.ticket) missingLink = true;
        }
      }
      // Another group may have spent minutes in setup since these tickets were read for grouping.
      const titleKeys = new Set(open.flatMap(p => mentionedKeys(p.title, c.taskBoard).filter(k => github.titleNamesOnly(p.title, k))));
      for (const k of titleKeys) {
        if (tickets.get(k) === null) continue; // a technical term such as SHA-256
        try { open = leaveToBoard(open, await app.tracker().lookup(c, k)); }
        catch (e) { log('warn', `${k}: couldn't recheck the ticket's tags (${e.message})`, `lookup:${k}`); }
      }
      if (!open.length) return;
      if (app.dryRun()) return log('info', `${key}: would start a GitHub review of ${names(open)} (dry run)`);
      if (missingLink && !open.some(p => side.state.deferredLinks?.includes(p.url))) {
        (side.state.deferredLinks ??= []).push(...open.map(p => p.url));
        save();
        return log('info', `${key}: waiting one poll for the linked PRs to be labelled`);
      }
      const runKey = group.ticket || githubKey(open);
      if (keyHeld(runKey, mark) || heldBy(open, true, mark)) return;
      settingUp.set(mark, { ticket: runKey, prs: open });
      for (const pr of open) {
        if (!githubOn() || app.dryRun()) break;
        const live = await claimLabeled(c, pr, group.ticket || githubKey([pr]));
        if (live) {
          clearNoAccess(pr.url);
          won.push(live);
        } else if (side.state.noAccess?.[pr.url]) context.push(pr);
      }
      if (!won.length || !githubOn() || app.dryRun()) return;
      let ticketText = '';
      if (ticket && c.ticketContext) {
        try { ticketText = await app.tracker().ticketText(c, ticket); }
        catch (e) { log('warn', `${key}: couldn't read the ticket's text (${e.message}); reviewing without it`); }
      }
      const ready = [];
      for (const pr of won) {
        const live = await gh.prByRef(pr);
        const claim = side.state.labelClaims[pr.url];
        const requested = live.state === 'open' && hasLabel(live, askLabel(c));
        if (!hasLabel(live, claim.label)) forgetClaim(pr.url);
        else if (!requested || live.draft) settleClaim(pr, claim, 'withdrawn');
        else ready.push(live);
        if (!requested) clearDeferredLinks(url => url === pr.url);
      }
      if (!ready.length || !githubOn() || app.dryRun()) return;
      const wonKey = group.ticket || githubKey(ready);
      if (wonKey !== runKey && keyHeld(wonKey, mark)) return;
      settingUp.set(mark, { ticket: wonKey, prs: ready });
      const title = ticket?.title || (ready.length === 1 ? ready[0].title : `${ready.length} PRs: ${ready[0].title}`);
      const run = await startReady(c, { source: 'github', githubTicket: group.ticket, key: wonKey, title, ticketUrl: ticket?.url, ticketText, contextPrs: context }, ready, free);
      if (run) {
        clearDeferredLinks(url => group.prs.some(p => p.url === url));
        settle = '';
        const capped = won.filter(p => side.state.labelClaims[p.url]);
        if (capped.length) log('warn', `${key}: ${names(capped)} reached the round cap. Label again after raising the cap.`);
      }
    } catch (e) {
      if (e.lasting) {
        settle = '';
        log('warn', `${key}: ${e.message}. Label the PR again to request another review.`);
      } else throw e;
    } finally {
      for (const pr of won) {
        const claim = side.state.labelClaims[pr.url];
        if (claim) settleClaim(pr, claim, settle);
      }
      settingUp.delete(mark);
      free();
    }
  }

  // ---- Quick reviews: a paste of PRs and tickets, reviewed together ----

  const names = prs => prs.map(p => `${p.repo.split('/')[1]}#${p.number}`).join(', ');
  const lasting = msg => Object.assign(new Error(msg), { lasting: true }); // a start that won't go better by waiting
  const labelsOn = () => cfg().quickLabels !== false;
  side.waits = () => (side.state.waits ??= []);

  /**
   * A quick review of a paste (`n`, or prowl --review): its PRs (links or owner/repo#12) and the open, ready PRs of
   * its tickets, reviewed together as one set, with no tag ever written. Exactly one ticket runs under its key (its
   * earlier reviews count); otherwise it is QUICK#n, named per Quick names. `opts`: { as (a ticket or a name), name
   * (typed, for ask), oneShot (prowl --once: an offer is only logged), offered (the offer was turned down) }.
   * Resolves with the run, { offer } when a paste of only tickets gets one first, or null on a dry run; rejects when
   * it can't start.
   */
  side.quickReview = async function quickReview(text, opts = {}) {
    const c = cfg();
    const paste = parsePaste(text, c.taskBoard);
    if (paste.rest) throw new Error(`${notARef(paste.rest)} isn't a PR or a ticket: paste PR links, owner/repo#12 or ticket keys`);
    if (!paste.prs.length && !paste.tickets.length) throw new Error('Paste at least one PR or ticket');
    if (!on()) throw new Error('the Reviewer is off');
    if (busy() >= c.maxConcurrentReviews) throw new Error(`${c.maxConcurrentReviews} reviews are already running (Max parallel reviews)`);
    const free = hold();
    const reserved = [];
    try {
      app.me ||= await gh.me();
      const tracker = app.tracker();
      const tickets = [];
      for (const key of paste.tickets) tickets.push(await tracker.lookup(c, key).catch(e => { throw new Error(`couldn't read ${key} (${e.message})`); }));
      if (labelsOn() && !paste.prs.length && !opts.offered) {
        const offer = await offerFor(app, tracker, tickets, c.tags.inProgress);
        if (offer && !opts.oneShot) return { offer: { ...offer, side: 'reviewer', text, as: opts.as || '', name: opts.name || '' } };
        if (offer) log('info', `${tickets.map(t => t.key).join(', ')}: ${offer.polled ? `could be tagged '${c.tags.trigger}' instead` : `could be tagged '${c.tags.trigger}', with ${offer.boards.join(', ')} added to the boards`}; reviewing now, as asked`);
      }
      const prs = await resolve({ prs: paste.prs, tickets: paste.tickets }, { fresh: true });
      const held = heldBy(readyOf(prs), true);
      if (held) throw new Error(held);
      for (const p of readyOf(prs)) { naming.add(p.url); reserved.push(p.url); } // naming can take up to a minute
      const spec = await named(c, { prs: paste.prs, tickets: paste.tickets }, tickets, prs, opts);
      return await startQuick(c, spec, prs, free);
    } finally {
      free();
      for (const u of reserved) naming.delete(u);
    }
  };

  /**
   * v in History: reviews a finished review's PRs again, as a quick review under the same ticket or name, as saved.
   * Its reviewed and approved-unchanged PRs are read again; one merged or closed since is left out. No tag is written and nothing is
   * claimed; its earlier done reviews under the same key make it a re-review. Rejects when it can't start.
   */
  side.reReview = async function reReview(past) {
    const c = cfg();
    if (!on()) throw new Error('the Reviewer is off');
    if (busy() >= c.maxConcurrentReviews) throw new Error(`${c.maxConcurrentReviews} reviews are already running (Max parallel reviews)`);
    const free = hold();
    try {
      app.me ||= await gh.me();
      const paste = { prs: [...past.prs, ...(past.contextPrs || []).filter(p => !past.relatedUrls?.includes(p.url))].map(p => ({ repo: p.repo, number: p.number })), tickets: [] };
      const prs = await resolve(paste);
      for (const p of prs.filter(x => x.gone)) log('info', `${past.ticket}: ${p.repo}#${p.number} is ${p.state}; left out`);
      // The key is reused as saved, never parsed again (a QUICK#n stays that one). A ticket of the task board set
      // now gets its title read again; if that fails, the saved title is used.
      let { title } = past;
      const key = ticketKey(past.ticket, c.taskBoard);
      if (key) title = await app.tracker().lookup(c, key).then(t => t.title || title, () => title);
      return await startQuick(c, { key: past.ticket, title, ticketUrl: past.ticketUrl || '', paste }, prs, free);
    } finally {
      free();
    }
  };

  /**
   * An answer to an offer from quickReview(): 'tag' (tag the tickets for review, adding their boards with `add`),
   * 'review' (a quick review now) or 'cancel'. Resolves with what quickReview() does, or the keys tagged.
   */
  side.answerOffer = async function answerOffer(offer, choice) {
    if (choice === 'review') return side.quickReview(offer.text, { as: offer.as, name: offer.name, offered: true });
    if (choice !== 'tag' && choice !== 'add') return null;
    const c = cfg();
    return acceptOffer(app, app.tracker(), offer, {
      tag: c.tags.trigger, busyTag: c.tags.inProgress, isTag: isTrigger, addBoards: choice === 'add', log,
      saveConfig: () => (deps.saveConfig ? deps.saveConfig() : saveConfig(app.cfg)),
    });
  };

  /** The PRs of a paste that a review would cover: open, readable, not drafts. */
  const readyOf = prs => prs.filter(p => !p.gone && !p.unreadable && !p.draft);

  /** The key and title a quick review runs under: a ticket's (one pasted, or named with as), or QUICK#n and a name. */
  async function named(c, paste, tickets, prs, { as = '', name = '' }) {
    const key = as && ticketKey(as, c.taskBoard);
    const ticket = key ? await app.tracker().lookup(c, key) : !as && tickets.length === 1 ? tickets[0] : null;
    if (ticket) return { key: ticket.key, title: ticket.title, ticketUrl: ticket.url, paste };
    // QUICK#1, #2, …: # keeps it from ever being a Jira key (PROJ-1) or matching an Azure DevOps one (AB#1).
    lastQuick = Math.max(lastQuick, ...side.state.runs.filter(r => /^QUICK#\d+$/.test(r.ticket)).map(r => Number(r.ticket.split('#').pop()) || 0)) + 1;
    const quickKey = `QUICK#${lastQuick}`;
    let title = cleanName(as || name);
    if (!title && c.quickName === 'auto') title = await (deps.autoName || autoName)(c, [text(paste), ...prs.map(p => `${p.repo}#${p.number}: ${p.title}`)].join('\n')).catch(() => '');
    return { key: quickKey, title: title || `Quick review: ${names(prs)}`, ticketUrl: '', paste };
  }
  const text = paste => [...paste.prs.map(r => `${r.repo}#${r.number}`), ...paste.tickets].join(' ');

  /**
   * The PRs a paste stands for now, each read from GitHub (state, draft, head, labels): its PRs, and its tickets' open
   * PRs that aren't drafts. `fresh` (a new paste): a PR that isn't open, or can't be read, is an error. Otherwise (a
   * wait, reading it again) each comes back with `gone` (merged or closed) or `unreadable` (GitHub refuses it), and
   * only a lookup that may go better next poll is an error.
   */
  async function resolve(paste, { fresh = false } = {}) {
    const c = cfg();
    const out = [];
    const add = pr => { if (!out.some(p => p.url === pr.url)) out.push(pr); };
    const read = async ref => {
      try {
        return await gh.prByRef(ref);
      } catch (e) {
        if (fresh) throw new Error(`couldn't read ${ref.repo}#${ref.number} (${e.message})`);
        if (refusal(e)) return { ...ref, url: ref.url || `https://github.com/${ref.repo}/pull/${ref.number}`, unreadable: e.message.split('\n')[0] };
        throw e;
      }
    };
    for (const ref of paste.prs) {
      const pr = await read(ref);
      if (fresh && pr.state !== 'open') throw new Error(`${pr.repo}#${pr.number} is ${pr.state}`);
      add(pr.state && pr.state !== 'open' ? { ...pr, gone: true } : pr);
    }
    for (const key of paste.tickets) {
      const open = (await gh.openPrs(c.githubOwner, key)).filter(p => !p.draft);
      if (fresh && !open.length && !paste.prs.length) throw new Error(`no open, ready PR mentions ${key} yet`);
      for (const p of open) {
        const pr = await read(p);
        if (!pr.draft) add(pr.state && pr.state !== 'open' ? { ...pr, gone: true } : pr);
      }
    }
    return out;
  }

  /**
   * Starts the quick review `spec` ({ key, title, ticketUrl, paste }) of `prs` (read by resolve()): the PRs its last
   * review approved with no new commits since are context, and the round cap holds as for a ticket. A draft is a start
   * that won't go better by waiting. With Quick reviews: GitHub labels on, its PRs are labelled In Review.
   */
  async function startQuick(c, spec, prs, free) {
    // One review of a key at a time: a tagged review of the ticket, or an earlier quick one, finishes first.
    if (keyHeld(spec.key)) throw new Error(`${spec.key} is being reviewed already: try again once that review ends`);
    const drafts = prs.filter(p => p.draft && !p.gone);
    if (drafts.length) throw lasting(`${names(drafts)} ${drafts.length > 1 ? 'are drafts' : 'is a draft'}: mark ${drafts.length > 1 ? 'them' : 'it'} ready, then paste again`);
    const open = prs.filter(p => !p.gone && !p.unreadable);
    if (!open.length) throw lasting('none of its PRs is open');
    // Again, just before the session starts: another review may have started on one of them meanwhile. It may end, so
    // this start is one that can go better by waiting.
    const held = heldBy(open, false);
    if (held) throw new Error(held);
    const mark = {};
    settingUp.set(mark, { ticket: spec.key, prs: open });
    try {
      return await startReady(c, spec, open, free);
    } finally {
      settingUp.delete(mark);
    }
  }

  /** Start a reserved quick or GitHub review after applying prior approvals and the round cap. */
  async function startReady(c, spec, open, free) {
    const githubReview = spec.source === 'github';
    const active = githubReview ? () => githubOn() && !app.dryRun() : on;
    const heads = {};
    for (const pr of open) heads[pr.url] = githubReview ? pr.headSha : pr.headSha || await gh.headSha(pr).catch(() => '');
    const { prior, reviewed: covered, alsoApproved } = await carryOn(c, spec.key, spec.ticketUrl, open, heads, spec.contextPrs || [], true);
    const approved = [];
    for (const pr of open) {
      const head = heads[pr.url];
      if (githubReview && !active()) throw new Error('GitHub reviews are paused or switched off');
      if (head && [prior?.approved?.[pr.url], alsoApproved[pr.url]].includes(head)) {
        approved.push(pr);
        if (githubReview) {
          settleClaim(pr, side.state.labelClaims[pr.url], 'approved');
          await labels.drain();
        }
      }
    }
    let toReview = open.filter(p => !approved.includes(p));
    const leftOut = [];
    if (toReview.length && rv.roundCapped(c, prior)) {
      const fresh = toReview.filter(p => !covered.has(p.url));
      if (!fresh.length) throw lasting(`it has had ${prior.reviewNo} reviews, the round cap (Max review rounds)`);
      leftOut.push(...toReview.filter(p => !fresh.includes(p)));
      toReview = fresh;
    }
    if (!toReview.length) throw lasting(`every PR is already approved, with no new commits since ${prior ? `review ${prior.reviewNo}` : "PR-Owl's last review"}`);
    const strip = pr => ({ url: pr.url, title: pr.title, number: pr.number, repo: pr.repo, author: pr.author, draft: false });
    const ticket = { key: spec.key, title: spec.title, url: spec.ticketUrl || '', ref: null };
    if (app.dryRun()) { log('info', `${spec.key}: would review ${toReview.map(p => p.url).join(' ')}`); return null; }
    const related = spec.contextPrs || [];
    const stand = standFor(ticket, toReview.map(strip), !githubReview, [...related, ...approved, ...leftOut].map(strip));
    if (githubReview) stand.source = 'github';
    let run;
    try {
      await cloneFor(c, stand, [...toReview, ...related]);
      const cleared = related.filter(p => p.headSha && prior?.approved?.[p.url] === p.headSha);
      for (const p of cleared) heads[p.url] = p.headSha;
      const opts = { tracker: null, ticket, prs: toReview.map(strip), approvedPrs: [...approved, ...cleared].map(strip), leftOut: leftOut.map(strip),
        prior, me: app.me, heads, quick: !githubReview, source: spec.source, relatedPrs: related.filter(p => !cleared.includes(p)).map(strip), ticketText: spec.ticketText, alsoApproved, reviewedBefore: prior?.shared ? [...covered] : null };
      const set = !stand.stopped && active() && prepping() ? await setUp(c, opts, prior, stand) : null;
      try {
        const checkStart = () => {
          if (stand.stopped) {
            log('warn', `${spec.key}: review stopped during its setup; nothing was reviewed`);
            throw lasting('it was stopped while it was being set up');
          }
          if (!active()) throw new Error(githubReview ? 'GitHub reviews are paused or switched off' : 'the Reviewer was switched off before the review started');
          if (githubReview && busy() > cfg().maxConcurrentReviews) throw new Error('no free review slot');
        };
        checkStart();
        await sizesIn(stand);
        checkStart();
        if (set) { ({ run } = set); launchPrepared(c, run); } else run = begin(c, opts);
        takeOver(run, stand);
      } catch (e) {
        if (set) await dropPrep(set.run);
        throw e;
      }
    } finally {
      preparing.delete(spec.key);
    }
    if (githubReview) Object.assign(run, { source: 'github', githubTicket: spec.githubTicket, labels: true, relatedUrls: related.map(p => p.url) });
    else Object.assign(run, { paste: spec.paste, ...(labelsOn() && { labels: true }) });
    side.state.runs.push(run);
    if (run.rolesNote) log('warn', rv.rolesWarning(run), 'roles');
    free(); // the run counts itself from here
    if (spec.fromWait) side.state.waits = side.waits().filter(x => x.key !== spec.key); // its own re-review: it waits again once this one ends
    else if (!githubReview) endWaits(spec.key, 'a new review of it started');
    if (githubReview) for (const pr of toReview) delete side.state.labelClaims[pr.url];
    save();
    if (run.labels) queueStartLabels(c, run.id, toReview, githubReview ? [] : approved);
    const kind = githubReview ? 'GitHub' : 'quick';
    const checking = run.phase === 'checks';
    hoot(checking ? `Building and testing the PRs for ${spec.title} before reviewing them` : toReview.length > 1 ? `Starting a ${kind} review of ${toReview.length} PRs` : `Starting a ${kind} review of ${toReview[0].title}`);
    log('ok', `${spec.key}: ${kind} ${prior ? `re-review #${run.reviewNo}` : 'review'} started on ${names(toReview)}${rv.sizeNote(run.prs, run.stats)}${approved.length ? ` (already approved, unchanged: ${names(approved)})` : ''}${checking ? ', building and testing first' : ''}`);
    if (checking) runChecks(run);
    await announce(run);
    return run;
  }

  // ---- Waiting on a quick review's PRs (Quick reviews: GitHub labels) ----

  /** Ends the waits of `key`: its labels stay as they are. */
  function endWaits(key, why) {
    for (const wt of side.waits().filter(x => x.key === key)) endWait(wt, why);
  }
  function endWait(wt, why) {
    side.state.waits = side.waits().filter(x => x !== wt);
    save();
    log('info', `${wt.key}: no longer waiting on its PRs: ${why}`);
  }

  /** s on a waiting review in Running: it stops waiting; its labels stay as they are. */
  side.stopWait = wt => endWait(wt, 'stopped by you; its labels stay as they are');

  /** Once a poll: each wait reads its paste again, and starts the re-review once its PRs are labelled for it. */
  async function checkWaits() {
    for (const wt of [...side.waits()]) {
      try {
        await checkWait(wt);
      } catch (e) {
        log('warn', `${wt.key}: couldn't check its PRs (${e.message}); trying again next poll`, `wait:${wt.key}`);
      }
    }
  }

  async function checkWait(wt) {
    const c = cfg();
    const run = side.state.runs.find(r => r.id === wt.runId);
    if (!run) return endWait(wt, 'its last review is gone');
    if (!labelsOn()) return endWait(wt, 'Quick reviews: GitHub labels is off');
    const key = `wait:${wt.key}`;
    delete wt._covered; // a failed lookup falls back to the last run for this poll
    const prs = await resolve(wt.paste);
    // A PR GitHub refuses (to read, or to label for this review) is let go, until it can be read again.
    wt.letGo ??= {};
    for (const p of prs) {
      const why = p.unreadable || labels.refused(run.id, p.url);
      if (why && !wt.letGo[p.url]) log('warn', `${wt.key}: ${p.repo}#${p.number} no longer holds the wait: ${why}`);
      if (why) wt.letGo[p.url] = why;
      else delete wt.letGo[p.url];
    }
    const live = prs.filter(p => !p.gone && !wt.letGo[p.url]);
    wt._covered = live.map(p => p.url);
    wt.waitingOn = [];
    if (!live.length) return endWait(wt, 'every PR is merged, closed or can no longer be read');
    if (wt.retry) return startAgain(wt, run, prs, 'retrying the review that failed');
    if (rv.roundCapped(c, run)) return endWait(wt, `it has had ${run.reviewNo} reviews, the round cap (Max review rounds)`);
    const approvedNow = p => run.approved?.[p.url] && run.approved[p.url] === p.headSha;
    const ask = askLabel(c);
    // Under another review: the in-review label, or the old name for it. Asked for: the review label, or the old
    // trigger name, and only once Prowl's own labels on the PR have landed.
    const underReview = p => labelsOf(c, p.labels, 'inReview')[0] || '';
    const ready = p => labelsOf(c, p.labels, 'ask').length > 0 && !labels.pending(p.url);
    // Whether PR-Owl's approval of `p` still stands on GitHub; one whose reviews can't be read keeps what is recorded.
    const stands = async p => {
      try { return prowlApproved(await gh.allReviews(p), p.headSha, { marker: rv.postMarker(approverIn(side.state.runs, run, p.url)), me: app.me }); } catch { return true; }
    };
    const notes = [];
    const taken = []; // labelled in review, and approved here, but no longer on GitHub: a teammate's review has it
    for (const p of live.filter(x => underReview(x) && approvedNow(x))) if (!(await stands(p))) taken.push(p);
    for (const p of live.filter(x => underReview(x) && approvedNow(x) && !taken.includes(x))) notes.push(`${p.repo}#${p.number} is labelled '${underReview(p)}', but it is approved and only context: it doesn't hold the wait`);
    wt.notes = notes;
    const reviewing = live.filter(p => underReview(p) && (!approvedNow(p) || taken.includes(p)));
    if (reviewing.length) {
      wt.waitingOn = reviewing.map(p => p.url);
      return log('info', `${wt.key}: waiting: ${names(reviewing)} ${reviewing.length > 1 ? 'are' : 'is'} labelled '${underReview(reviewing[0])}'`, key);
    }
    const waitedOn = live.filter(p => !run.approved?.[p.url]); // the PRs it didn't approve, and new ones
    let go;
    let dismissed = false;
    if (waitedOn.length) {
      wt.waitingOn = waitedOn.filter(p => !ready(p)).map(p => p.url);
      go = waitedOn.every(ready);
    } else {
      // Every PR approved: Ready for Review with new commits since the approval re-reviews; Ready for Review alone waits.
      wt.waitingOn = live.map(p => p.url);
      go = live.some(p => ready(p) && !approvedNow(p));
      // Asked for again with no new commits: it goes ahead only when PR-Owl's approval no longer stands on GitHub (dismissed, say).
      for (const p of go ? [] : live.filter(x => ready(x) && !underReview(x))) { // one a teammate's review has is theirs
        if (await stands(p)) continue;
        dismissed = true;
        go = true;
        break;
      }
      if (!go && live.some(ready)) log('info', `${wt.key}: '${ask}' is on, but no PR has new commits since it was approved; still waiting`, key);
    }
    save();
    if (!go) return undefined;
    return startAgain(wt, run, prs, waitedOn.length ? `every PR it didn't approve is labelled '${ask}'` : dismissed ? `labelled '${ask}', and PR-Owl's approval no longer stands on GitHub` : `labelled '${ask}', with new commits`);
  }

  /** The re-review of a wait, once a slot is free. A start that can't go better by waiting ends the wait, naming why. */
  async function startAgain(wt, run, prs, why) {
    const c = cfg();
    const key = `wait:${wt.key}`;
    if (busy() >= c.maxConcurrentReviews) return log('info', `${wt.key}: ready for its re-review, waiting for a slot (${c.maxConcurrentReviews} reviews running)`, key);
    if (app.dryRun()) return log('info', `${wt.key}: would re-review it: ${why} (dry run)`, key);
    const free = hold();
    try {
      log('info', `${wt.key}: ${why}; re-reviewing`);
      await startQuick(c, { key: wt.key, title: wt.title, ticketUrl: wt.ticketUrl, paste: wt.paste, fromWait: true }, prs, free);
    } catch (e) {
      if (e.lasting) return endWait(wt, `its re-review can't start: ${e.message}`);
      log('warn', `${wt.key}: couldn't start its re-review (${e.message}); trying again next poll`, key);
    } finally {
      free();
    }
    return undefined;
  }

  /** The label that says how a review of the PR at `url` went: approved, or changes requested. */
  // A review Prowl posted itself (result mode) knows more: a PR it couldn't read, or didn't review in full with nothing
  // blocking found, gets neither label.
  const outcomeLabel = (run, url) => (run.approved?.[url] ? labelNames(cfg()).approved : !run.resultMode || run.blocked?.includes(url) ? labelNames(cfg()).changes : '');
  side.outcomeLabel = outcomeLabel;
  /** History includes both denied access at setup and refusals arriving later in the queue. */
  side.labelNotes = run => [...(run.prs || []), ...(run.contextPrs || []), ...(run.leftOut || [])].flatMap(pr => {
    const why = run.labelNotes?.[pr.url] || (run.labels && labels.refused(run.id, pr.url));
    return why ? [`${pr.repo}#${pr.number}: ${why}`] : [];
  });

  /**
   * The PRs' labels after a quick review: each PR's outcome (`outcome`), or none, with the in-review label, the
   * other outcome and the old names off. The review label is left: one on the PR now was put there while the review
   * ran, to ask for another.
   */
  function relabel(run, prs, outcome) {
    for (const p of prs) labels.set('reviewer', run.id, p, labelWrite(cfg(), outcome ? outcomeLabel(run, p.url) : '', ['inReview', 'approved', 'changes'], ['inReview', 'done']));
  }

  /**
   * Posts the started comment from output.md on each reviewed PR. Quick reviews and reviews without a ticket URL
   * use the PR-links template so edited ticket templates never need rewriting.
   */
  async function announce(run) {
    const text = run.quick || !run.ticketUrl
      ? fill(outputTemplate(appDir, 'Quick review started'), { prs: run.prs.map(p => `[${p.repo.split('/')[1]}#${p.number}](${p.url})`).join(', ') })
      : fill(outputTemplate(appDir, 'Review started'), { ticket: run.ticket, 'ticket link': run.ticketUrl });
    // The prowl-review marker keeps prowl-review from counting it as someone else's comment.
    const body = `${text}\n<!-- prowl-review ${run.id} started -->`;
    const file = path.join(path.dirname(run.logPath), `${run.id}.started.json`);
    writeJson(file, { body });
    for (const pr of run.prs) {
      try {
        const url = await gh.postComment(pr, file);
        if (/#issuecomment-\d+$/.test(String(url))) { (run.startedComments ??= {})[pr.url] = url; save(); } // the comment its hand-over note goes in
      } catch (e) {
        log('warn', `${run.ticket}: couldn't post the review-started comment on ${pr.repo}#${pr.number} (${e.message})`);
      }
    }
  }

  /** Clears History's ⚑ flag on each PR a human has approved since Prowl gave it its stamp (Approve PRs off, or your own PR). */
  async function checkHumanApprovals() {
    const latest = new Map(); // the flag shows on each ticket's latest review only
    for (const r of side.finished()) if (r.status === 'done' && !latest.has(r.ticket)) latest.set(r.ticket, r);
    for (const run of latest.values()) {
      for (const url of rv.awaitingHuman(run, cfg().approvals)) {
        try {
          if (!(await gh.humanApproved(url, run.approved[url]))) continue;
        } catch (e) {
          log('warn', `${run.ticket}: couldn't check ${url} for a human approval (${e.message})`, `human:${url}`);
          continue;
        }
        run.awaitingHuman = rv.awaitingHuman(run, cfg().approvals).filter(u => u !== url);
        save();
        log('ok', `${run.ticket}: ${url} is approved (or merged or closed); its flag is cleared`);
      }
    }
  }

  /**
   * Announces each PR whose review has been posted since the run started (checked about once a minute). Resolves with
   * the URLs it couldn't check.
   */
  async function checkPosted(run) {
    run._checkedAt = Date.now();
    run.reviewedPrs ??= [];
    const unchecked = [];
    for (const pr of run.prs) {
      if (run.reviewedPrs.includes(pr.url)) continue;
      let got;
      try {
        got = await gh.reviewedSince(pr, (app.me ||= await gh.me()), run.startedAt, run.marker || ''); // settle can run before the first poll
      } catch (e) {
        unchecked.push(pr.url);
        log('warn', `${run.ticket}: couldn't check ${pr.repo}#${pr.number} for a posted review (${e.message})`, `posted:${run.id}`);
        continue;
      }
      if (!got) continue;
      if (got === 'unmarked') log('warn', `${run.ticket}: the review on ${pr.repo}#${pr.number} doesn't end with Prowl's marker; counting it as posted`);
      run.reviewedPrs.push(pr.url);
      save();
      hoot(`Done reviewing ${pr.title}`, 'cheer');
    }
    return unchecked;
  }

  /** The PRs of a finished review that are still open and have no review from it. A failed lookup doesn't count. */
  async function missingReviews(run, unchecked) {
    const missing = [];
    for (const pr of run.prs.filter(p => !run.reviewedPrs.includes(p.url) && !unchecked.includes(p.url))) {
      try {
        if (await gh.isOpen(pr)) missing.push(pr); // merged or closed mid-run: nothing to post on
      } catch (e) {
        log('warn', `${run.ticket}: couldn't check whether ${pr.repo}#${pr.number} is still open (${e.message})`);
      }
    }
    return missing;
  }

  /**
   * Publish the result and settle its markers: tags for board reviews, PR labels for enabled reviews.
   * GitHub retries use the Review label; a labelled quick review retries through its wait.
   */
  async function finish(run) {
    // A review left half-posted by an earlier launch: its session was settled then, and its posting carries on.
    const resumed = run.phase === 'publishing';
    if (run.prep && !run.prep.dropped) { await dropPrep(run); save(); } // its worktrees go as soon as its session has ended; the prepared files stay
    if (!resumed) rv.finalize(run);
    const { tags } = cfg();
    const failures = run.quick ? (side.state.quickFailures ??= {}) : side.state.failures; // a quick review's apart from the ticket's
    const githubReview = run.source === 'github';
    const kind = githubReview ? 'GitHub review' : 'review';
    const again = githubReview ? `label the PR again with '${askLabel(cfg())}'` : run.quick ? 'n reviews PRs again' : `re-tag '${tags.trigger}' to try again`;
    if (run.resultMode && (resumed || run.status === 'done')) await settleResult(run);
    if (run.resultMode && run.status === 'done') {
      await dismissSuperseded(run); // before the tags and labels are written; never on a failed or stopped review
      await handOver(run).catch(e => log('warn', `${run.ticket}: couldn't leave its hand-over notes (${e.message})`));
    } else if (run.status === 'done') { // a review from before results: its session posted its reviews itself
      const unchecked = await checkPosted(run).catch(() => run.prs.map(p => p.url)); // announce any PR posted since the last check
      if (run.marker) rv.failUnposted(run, await missingReviews(run, unchecked)); // reviews started before 2.12.0 have none
    }
    let retry = false;
    if (run.status === 'done') {
      delete failures[run.ticket];
      run.pendingTag = outcomeTag(run, tagsNow());
      const s = run.summary || {};
      log('ok', `${run.ticket}: ${kind} ${run.reviewNo} finished: ${s.verdict || 'no verdict'} (C${s.critical ?? '?'} H${s.high ?? '?'} M${s.medium ?? '?'} L${s.low ?? '?'} N${s.nit ?? '?'}) · ${run.reportPath}`);
      hoot(githubReview ? `Finished the GitHub review of ${run.title}` : run.quick ? `Done with ${run.ticket}` : `Done reviewing PRs for ${run.title}, marking as '${run.pendingTag}'`, 'cheer');
    } else if (run.status === 'failed') {
      failures[run.ticket] = (failures[run.ticket] || 0) + 1;
      retry = (!run.quick || run.labels) && rv.retryFailed(run, failures[run.ticket]); // one automatic retry, then wait for a human
      run.pendingTag = retry ? tags.trigger : '';
      const why = run.capped ? 'Not retried, as it hit a cap'
        : run.unposted?.length && run.resultMode ? `Not retried (review not posted): the Log says what GitHub refused. A ${githubReview ? 're-labelled' : 're-tagged'} review runs again from the start`
        : run.unposted?.length ? 'Not retried, as a retry would most likely be blocked too' : run.quick && !run.labels ? 'Not retried' : 'Not retrying again';
      const retried = githubReview ? `Labelling its PRs '${askLabel(cfg())}' for one retry.` : run.quick ? 'Retrying it once, when a slot is free.' : `Re-tagged '${tags.trigger}' to retry once.`;
      log('error', `${run.ticket}: ${kind} failed: ${run.error}. ${retry ? retried : `${why}; ${again}.`}`);
    } else {
      run.pendingTag = '';
      log('warn', `${run.ticket}: ${kind} stopped. ${run.quick ? again : again[0].toUpperCase() + again.slice(1)}.`);
    }
    if (run.quick || githubReview) run.pendingTag = null;
    if (run.labels) settleLabels(run, retry);
    delete run.phase; // settled: from here its tag is pending in the saved state, and applyTag retries it
    save();
    if (run.pendingTag != null) await applyTag(run);
  }

  /**
   * Leaves a finished, published review's hand-over notes: on each PR it posted a review on, its Review started
   * comment is edited to say it finished and to hold the note (a new comment, when that one was never posted). Only
   * for a review of a ticket. One try per PR: a failure is a warning, and the review is still done.
   */
  async function handOver(run) {
    if (run.handedOver || !isTicket(run.ticket, run.ticketUrl)) return;
    const result = rv.readResult(run);
    if (!result) { run.handedOver = true; return save(); }
    run.handingOver ??= []; // the PRs tried so far: a quit part-way carries on with the rest, and tries none twice
    const done = side.state.runs.filter(r => r.ticket === run.ticket && r.status === 'done');
    const notes = buildNotes(run, result, coveredBy([...new Set([...done, run])]));
    const line = fill(outputTemplate(appDir, 'Review finished'), { n: String(run.reviewNo), ticket: run.ticket, 'ticket link': run.ticketUrl });
    const file = path.join(path.dirname(run.logPath), `${run.id}.handover.json`);
    for (const pr of run.prs.filter(p => run.published?.[`review:${p.url}`] && !notes[p.url])) log('warn', `${run.ticket}: no hand-over note on ${prName(pr.url)}: the ticket has too many PRs for one to fit`);
    for (const pr of run.prs.filter(p => notes[p.url] && !run.handingOver.includes(p.url))) {
      run.handingOver.push(pr.url);
      save();
      try {
        writeJson(file, { body: noteBody(line, notes[pr.url]) });
        const id = /#issuecomment-(\d+)$/.exec(run.startedComments?.[pr.url] || '')?.[1];
        if (id) await gh.editComment(pr, id, file);
        else await gh.postComment(pr, file);
      } catch (e) {
        log('warn', `${run.ticket}: couldn't leave its hand-over note on ${prName(pr.url)} (${e.message}); a teammate's Prowl reviews it next without it`);
      }
    }
    run.handedOver = true;
    delete run.handingOver;
    save();
  }

  /**
   * Dismisses the earlier PR-Owl reviews this review supersedes: on each PR it approved, those still requesting
   * changes whose findings it accounts for, and (with a real approval) your own earlier ones. Checked against GitHub
   * as it is now: a dismissal can't be undone. Nothing here fails the review. A review already dismissed no longer
   * requests changes, so a restart repeats nothing.
   */
  async function dismissSuperseded(run) {
    for (const pr of run.prs) {
      const listed = (run.supersedes || []).filter(u => u.startsWith(`${pr.url}#`));
      if (!listed.length && !run.approved?.[pr.url]) continue;
      const name = prName(pr.url);
      const many = listed.length > 1;
      let reviews;
      let head;
      try {
        [reviews, head] = [await gh.allReviews(pr), await gh.headSha(pr)];
      } catch (e) {
        if (listed.length || run.published?.[`review:${pr.url}`]) log('warn', `${run.ticket}: couldn't read the reviews on ${name} to dismiss superseded ones (${e.message})`);
        continue;
      }
      const why = rv.dismissBlocker(run, pr, reviews, head);
      if (why) {
        if (listed.length) log('warn', `${run.ticket}: left the earlier PR-Owl review${many ? 's' : ''} its report says it supersedes on ${name} as ${many ? 'they were' : 'it was'}: ${why}`);
        continue;
      }
      const { go, kept } = rv.reviewsToDismiss(run, pr, reviews);
      if (kept) log('warn', `${run.ticket}: left ${kept < listed.length ? `${kept} of ` : ''}the earlier PR-Owl review${many ? 's' : ''} its report says it supersedes on ${name} as ${kept > 1 ? 'they were' : 'it was'}: it isn't a PR-Owl review still requesting changes from before this one`);
      for (const r of go) {
        try {
          const file = path.join(path.dirname(run.logPath), `${run.id}.dismiss.json`);
          writeJson(file, { message: r.message, event: 'DISMISS' });
          await gh.dismissReview(pr, r.id, file);
          log('ok', `${run.ticket}: dismissed @${r.user}'s earlier PR-Owl review on ${name}, which this review supersedes`);
        } catch (e) {
          log('warn', `${run.ticket}: couldn't dismiss @${r.user}'s earlier PR-Owl review on ${name} (${e.message}); it was left as it was`);
        }
      }
    }
  }

  /**
   * Settles a review that wrote a result: the result is checked, the report written from it, everything posted by
   * Prowl itself, and the report written again with the links. While it posts, the run stays running in its
   * publishing phase, so a restart carries on where it stopped and nothing is posted twice. An invalid result fails
   * the review with nothing on GitHub; a PR left without its review fails it too, and that isn't retried.
   */
  async function settleResult(run) {
    Object.assign(run, { status: 'running', phase: 'publishing' });
    save();
    const failed = error => Object.assign(run, { status: 'failed', error });
    let result;
    try {
      const text = fs.readFileSync(run.resultPath, 'utf8');
      const problems = checkResult(text, { batchId: run.batchId, prUrls: run.resultPrs });
      if (problems.length) failed(`its review result has ${problems.length} problem${problems.length > 1 ? 's' : ''}, so nothing was posted: ${problems.slice(0, 5).join('; ')} (${run.resultPath})`);
      else result = rv.heldResult(run, JSON.parse(text)); // with Prowl's own reading of each PR's blocking reviews
    } catch (e) {
      failed(`its review result has 1 problem, so nothing was posted: can't read it: ${e.message} (${run.resultPath})`);
    }
    if (result) {
      try {
        const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
        const templates = loadOutputTemplates(appDir);
        const labels = verdictLabels(read(path.join(CONFIG_DIR, 'review.md')) ?? read(path.join(appDir, 'skills', 'prowl-review', 'config', 'review.md')));
        const info = Object.fromEntries([...run.prs, ...(run.contextPrs || []), ...(run.leftOut || [])].map(p => [p.url, { title: p.title || '', author: p.author || '' }]));
        const write = plan => fs.writeFileSync(run.reportPath, reportMd(result, run, plan, { ...info, ...Object.fromEntries(Object.entries(plan.info || {}).map(([url, x]) => [url, { title: x.title || info[url]?.title || '', author: x.author || info[url]?.author || '' }])) }));
        // Before anything is posted (no links yet), so a report exists even if posting fails.
        if (!fs.existsSync(run.reportPath)) write(planPublish(result, { run, templates, labels, prs: {} }));
        // What the session was given and its result doesn't carry is owed: given again next round.
        run.owed = (run.priorGiven || []).filter(g => notCarried(result, g.pr, [g.ref]).length);
        const plan = await (deps.publishReview || publishReview)(run, result, { gh, log, hoot, save, templates, labels });
        write(plan);
        run.summary = frontMatter(fs.readFileSync(run.reportPath, 'utf8'));
        run.blocked = plan.prs.filter(r => run.published?.[`review:${r.url}`] && !approvable(r.severity)).map(r => r.url);
        // Every open PR under review must have its review: a PR merged or closed meanwhile has nothing to post on.
        const missing = plan.prs.filter(r => !run.published?.[`review:${r.url}`] && !['merged', 'closed'].includes(r.skip));
        if (missing.length) {
          run.unposted = missing.map(r => r.url);
          failed(`no review posted on ${missing.map(r => prName(r.url)).join(', ')} (${missing.map(r => `${prName(r.url)}: ${run.publishErrors?.[r.url] || run.unreviewed?.[r.url] || r.skip || 'it was never posted'}`).join('; ')}); the review result is in ${run.resultPath}`);
        } else run.status = 'done';
      } catch (e) {
        failed(`couldn't write or publish its review: ${e.message}`);
      }
    }
    // Still saved as publishing: finish() ends the phase once the dismissals are made and the tag or labels are set, so
    // a quit before then is picked up again at the next launch (nothing is posted or dismissed twice).
  }

  /** Set PR outcomes or release their labels. A GitHub retry restores the ask; only quick reviews create waits. */
  function settleLabels(run, retry) {
    if (!run.quick) {
      const c = cfg();
      for (const pr of run.prs) {
        if (run.labelNotes?.[pr.url]) continue;
        const done = run.status === 'done';
        const add = done ? outcomeLabel(run, pr.url) : run.source === 'github' && retry ? askLabel(c) : '';
        const clearAsk = !done && run.source !== 'github'; // a fresh request made during a GitHub review survives it
        const off = ['inReview', 'approved', 'changes', ...(clearAsk ? ['ask'] : [])];
        labels.set('reviewer', run.id, pr, labelWrite(c, add, off, clearAsk ? ['ask', 'inReview', 'done'] : ['inReview', 'done']));
      }
      return;
    }
    if (run.status !== 'done' && !retry) {
      relabel(run, run.prs, false); // not retried, or stopped: the in-review label comes off
      return endWaits(run.ticket, run.status === 'stopped' ? 'its review was stopped' : 'its review failed');
    }
    if (run.status === 'done') relabel(run, run.prs, true);
    side.state.waits = side.waits().filter(x => x.key !== run.ticket);
    side.waits().push({ key: run.ticket, title: run.title, ticketUrl: run.ticketUrl || '', paste: run.paste || { prs: run.prs.map(p => ({ repo: p.repo, number: p.number })), tickets: [] },
      runId: run.id, since: Date.now(), letGo: {}, retry, waitingOn: run.prs.filter(p => !run.approved?.[p.url]).map(p => p.url) });
    if (run.status === 'done') {
      const open = run.prs.filter(p => !run.approved?.[p.url]);
      log('info', `${run.ticket}: its PRs are labelled with how the review went; ${open.length ? `waiting for '${askLabel(cfg())}' on ${names(open)}` : `every PR approved: waiting for '${askLabel(cfg())}' with new commits`}`);
    }
    return undefined;
  }

  /** Writes run.pendingTag to the ticket (replacing the tags this side owns); retried every minute until it lands. */
  async function applyTag(run) {
    run._tagging = true;
    // A write left pending by the Prowl from before the update goes under today's name for its role.
    run.pendingTag = pendingTag(cfg(), run.pendingTag, outcomeTag(run, tagsNow()));
    try {
      await trackers[run.tracker].retag(cfg(), run.ref, ours, run.pendingTag);
      run.pendingTag = null;
      save();
    } catch (e) {
      run._tagRetryAt = Date.now() + 60_000;
      log('error', `${run.ticket}: couldn't update the ticket's tags yet (${e.message}); retrying every minute`, `tag:${run.id}`);
    } finally {
      run._tagging = false;
    }
  }

  /** Stops a review that has run past the Review time limit. It then fails with the cap named, and isn't retried. */
  function stopOverdue(run) {
    run.capped = `time cap ${cfg().reviewTimeoutMinutes} min`;
    rv.stopReview(run);
    save();
    log('warn', `${run.ticket}: stopping the review: it ran past the ${cfg().reviewTimeoutMinutes}-minute time limit`);
  }

  /** Once a second, on or off: tail running reviews, settle finished ones, retry tag writes. */
  /** A review that is done, with a session that hasn't exited (a wake-up it scheduled is pending): the session is ended rather than waited for. */
  function endIdleSession(run) {
    if (!(deps.endIdle || rv.endIdle)(run)) return;
    save();
    log('info', `${run.ticket}: the review is done but its session hasn't exited (a wake-up it scheduled is pending); ending the session`);
  }

  let swept = false;
  /** Once, at launch: worktree folders no running review owns (left by a crash, or a quit during a setup) are removed. */
  const sweep = () => {
    if (swept) return;
    swept = true;
    (deps.sweepWorktrees || sweepWorktrees)(cfg().workDir, side.running().map(r => r.id)).catch(() => {});
  };

  side.tick = function tick() {
    sweep();
    for (const run of side.running()) {
      if (run._finishing) continue;
      if (run.phase === 'publishing') { // left half-posted by an earlier launch: its posting carries on, and nothing is posted twice
        run._finishing = true;
        finish(run).catch(e => log('error', `${run.ticket}: ${e.message}`));
        continue;
      }
      if (run.phase === 'checks') { // no session yet, so no process to have exited: its checks run in this process
        if (run.status === 'running') {
          if (rv.overdue(run, cfg())) stopOverdue(run);
          else if (!run._building) runChecks(run); // left in its checks phase by an earlier launch: they run again, from the start
        } else if (!run._building) { // stopped, and the running check has really ended
          run._finishing = true;
          finish(run).catch(e => log('error', `${run.ticket}: ${e.message}`));
        }
        continue;
      }
      rv.readActivity(run);
      if (rv.sessionEnded(run)) { // its process has exited: a `result` event alone is only a turn's
        rv.readActivity(run); // pick up the last lines written before exit
        run._finishing = true;
        finish(run).catch(e => log('error', `${run.ticket}: ${e.message}`));
      } else if (run._settled || run.settledOn || rv.doneIdle(run)) {
        endIdleSession(run); // done, so never failed by the time cap for idling
      } else if (rv.overdue(run, cfg())) {
        stopOverdue(run);
      } else if (!run.resultMode && app.me && !run._checking && Date.now() - (run._checkedAt || 0) > 60_000) { // a review from before results posts its own reviews
        run._checking = true;
        checkPosted(run).finally(() => { run._checking = false; });
      }
    }
    for (const run of [...side.state.runs, ...(side.state.releases || [])]) {
      const ended = run.status !== 'running' && run.status !== 'stopping';
      if (ended && run.pendingTag != null && !run._tagging && Date.now() >= (run._tagRetryAt || 0)) applyTag(run);
    }
    if (side.state.releases?.some(r => r.pendingTag == null)) {
      side.state.releases = side.state.releases.filter(r => r.pendingTag != null);
      save();
    }
  };

  /** --once: settles reviews whose sessions have ended before the poll. */
  side.settle = async function settle() {
    sweep();
    for (const run of side.running()) {
      if (run.phase === 'publishing') { await finish(run); continue; }
      if (run.phase === 'checks') { // its checks run again from the start; checksDone() waits for them
        if (run.status === 'running') runChecks(run);
        else if (!run._building) await finish(run);
        continue;
      }
      rv.readActivity(run);
      if (rv.sessionEnded(run)) { rv.readActivity(run); await finish(run); }
      else if (run.settledOn || rv.doneIdle(run)) endIdleSession(run); // asked now; settled by the next launch, once it has exited
      else if (rv.overdue(run, cfg())) stopOverdue(run); // settled by the next launch, once it has exited
    }
  };

  /** The question s asks before stopping `run`: a review that has written its report counts as done all the same. */
  side.stopText = run => {
    const githubReview = run.source === 'github';
    const again = 'Label its PRs again to request another review.';
    if (run.status === 'preparing') {
      if (githubReview) return `Stop the GitHub review of ${run.ticket} while it is being set up? Its setup ends first, then no session starts. ${again}`;
      return run.quick ? `Stop the quick review ${run.ticket} while it is being set up? Its setup ends first (a clone or a fetch can't be interrupted), then no session starts.`
        : `Stop the review of ${run.ticket} while it is being set up? Its setup ends first (a clone or a fetch can't be interrupted), then no session starts. Its '${cfg().tags.trigger}' tag is removed; re-tag to run it again.`;
    }
    const done = rv.reportWritten(run);
    const wrote = run.resultMode ? 'review result, so it counts as done: Prowl posts it' : 'report, so it counts as done';
    if (githubReview || run.quick) {
      const review = githubReview ? 'GitHub review of' : 'quick review';
      const result = done ? ` It has written its ${wrote}${githubReview || labelsOn() ? ' and its PRs are labelled as usual' : ''}.` : '';
      return `Stop the ${review} ${run.ticket}?${result}${githubReview ? ` ${again}` : ''}`;
    }
    return done ? `Stop the review of ${run.ticket}? It has written its ${wrote} and it is tagged as usual.`
      : `Stop the review of ${run.ticket}? Its '${cfg().tags.inProgress}' tag is removed; re-tag to run it again.`;
  };

  side.stop = run => {
    if (run.status === 'preparing') { // a review being set up: its setup ends first (a clone or a fetch can't be interrupted), then no session starts
      if (preparing.get(run.ticket) === run) {
        if (run.stopped) return log('info', `${run.ticket}: already stopping, once its setup ends`);
        run.stopped = true;
        return log('warn', `${run.ticket}: stopping the review once its setup ends; no session will start`);
      }
      const started = side.running().find(r => r === run._run); // its session had started by the time this was confirmed
      if (!started) return log('info', `${run.ticket}: not stopped: it had already ended`);
      return side.stop(started);
    }
    if (run.phase === 'publishing') return log('warn', `${run.ticket}: its review is being posted on GitHub and can't be stopped part-way`);
    rv.stopReview(run);
    save();
    log('warn', `${run.ticket}: stopping the review`);
  };

  side.finish = finish; // for the self-test
  return side;
}
