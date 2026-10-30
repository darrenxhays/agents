// The Reviewer: polls the boards for tickets tagged for review and runs Claude Code's prowl-review skill on their open,
// non-draft GitHub PRs. src/shell.mjs drives poll() and tick(); the Builder never reads its state (state.json).
import path from 'node:path';
import { writeJson } from '../config.mjs';
import * as github from '../github.mjs';
import { norm, tagMatches } from '../match.mjs';
import { fill, outputTemplate } from '../templates.mjs';
import * as rv from './reviews.mjs';

/**
 * The Reviewer side. `deps`: { log(level, msg, key), forget(key), hoot(text, mood), appDir, trackers, github }. The shell reads
 * `paused`, `polling`, `nextPoll` and `lastError`, and calls poll() and tick().
 */
export function createReviewer(app, { log, forget, hoot, appDir, trackers, github: gh = github }) {
  const side = {
    name: 'reviewer', label: 'Reviewer', state: rv.loadState(), tagVariants: {}, paused: false, polling: false, nextPoll: 0, lastError: '',
  };
  const cfg = () => app.cfg;
  const on = () => app.sideOn('reviewer');
  const save = () => rv.saveState(side.state);
  side.running = () => side.state.runs.filter(r => r.status === 'running' || r.status === 'stopping');
  side.finished = () => side.state.runs.filter(r => r.status !== 'running' && r.status !== 'stopping').sort((a, b) => b.endedAt - a.endedAt);
  side.needs = () => []; // nothing waits on you: a review either runs, or leaves its ticket tagged for a person
  side.alive = () => side.running().some(rv.alive);

  // Tags this side sets itself are matched exactly; only the trigger tag is matched loosely.
  const ours = t => [cfg().tags.inProgress, cfg().tags.done].some(x => norm(x) === norm(t));
  const isTrigger = t => !ours(t) && tagMatches(t, cfg().tags.trigger, cfg().tagMatchMaxTypos);

  side.poll = async function poll() {
    side.lastError = '';
    const pruned = rv.tidyLogs(cfg().logRetentionDays, side.running()); // on launch, then once per poll
    if (pruned) log('info', `Deleted ${pruned} review log file${pruned > 1 ? 's' : ''} older than ${cfg().logRetentionDays} days`);
    app.me ||= await gh.me();
    const tracker = app.tracker();
    const boards = app.boards();
    if (!boards.length) {
      if (log('warn', `No ${tracker.name} boards configured: add one in Config (4).`, 'boards')) hoot(`I have no ${tracker.name} boards to watch yet. Add one in Config (4).`);
      return;
    }
    if (!cfg().githubOwner) {
      if (log('warn', 'No GitHub org configured: set it in Config (4).', 'boards')) hoot('I need a GitHub org to search for PRs. Set it in Config (4).');
      return;
    }
    hoot(`Checking ${boards.length > 1 ? 'the boards' : 'the board'} for new review tasks...`);
    const seen = new Set();
    let allRead = true;
    for (const board of boards) {
      const where = tracker.boardLabel(board);
      try {
        const { tickets, variants } = await tracker.findTickets(cfg(), board, isTrigger);
        side.tagVariants[where] = variants;
        if (!variants.length) log('info', `${where}: no ticket is tagged like '${cfg().tags.trigger}'`, `tags:${where}`);
        for (const ticket of tickets) {
          if (seen.has(ticket.key)) continue;
          seen.add(ticket.key);
          await consider(tracker, ticket);
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
    await checkHumanApprovals();
  };

  async function consider(tracker, ticket) {
    const { state } = side;
    const c = cfg();
    const key = `ticket:${ticket.key}`;
    if (side.running().some(r => r.ticket === ticket.key)) return; // re-tagged mid-review: re-reviewed once this one ends
    if (side.running().length >= c.maxConcurrentReviews) {
      log('info', `${ticket.key}: waiting, ${c.maxConcurrentReviews} reviews already running`, key);
      return;
    }
    // Drafts are treated as if they weren't there: a draft often waits on the ticket's other PRs.
    const open = await gh.openPrs(c.githubOwner, ticket.key);
    const prs = open.filter(p => !p.draft);
    if (!prs.length) return log('info', `${ticket.key}: tagged, but no open${open.length ? ', ready' : ''} PR mentions ${ticket.key} yet`, key);
    const mine = prs.filter(p => rv.isOwn(p, app.me));
    if (mine.length && !c.reviewOwnPrs) {
      // Skip the whole ticket, not just your PRs: prowl-review reviews a ticket's PRs as one set.
      return log('info', `${ticket.key}: skipped, ${mine.map(p => `${p.repo}#${p.number}`).join(', ')} ${mine.length > 1 ? 'are' : 'is'} yours; leaving it for a teammate`, key);
    }
    const done = state.runs.filter(r => r.ticket === ticket.key && r.status === 'done').sort((a, b) => b.endedAt - a.endedAt);
    const prior = done[0];
    const covered = new Set(done.flatMap(r => [...r.prs, ...(r.contextPrs || [])].map(p => p.url))); // PRs an earlier review covered
    const heads = {}; // PR URL -> its head commit now ('' if unreadable)
    for (const pr of prs) heads[pr.url] = await gh.headSha(pr).catch(() => '');
    // A re-review leaves out the PRs the last review approved that have no new commits since; they stay as context.
    const approved = prs.filter(pr => prior?.approved?.[pr.url] && prior.approved[pr.url] === heads[pr.url]);
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
    const skipped = approved.length ? ` (already approved, unchanged: ${approved.map(p => `${p.repo}#${p.number}`).join(', ')})` : '';
    if (app.dryRun()) return log('info', `${ticket.key}: would review ${toReview.map(p => p.url).join(' ') || 'nothing'}${skipped}`, key);
    if (!on()) return undefined; // switched off while this poll ran

    try {
      // Nothing to re-review: straight to done, in one write a teammate's poller can't race.
      await tracker.claim(c, ticket, t => isTrigger(t) || ours(t), toReview.length ? c.tags.inProgress : c.tags.done);
    } catch (e) {
      return log('warn', `${ticket.key}: not claimed (changed or claimed by someone else): ${e.message}`, key);
    }
    // Puts the trigger tag back. One the tracker refuses is kept in state.releases, which tick() retries each minute.
    const release = async () => {
      const r = { tracker: c.taskBoard, ticket: ticket.key, ref: ticket.ref, id: `claim-${ticket.key}`, pendingTag: c.tags.trigger };
      await applyTag(r);
      if (r.pendingTag != null) { (state.releases ??= []).push(r); save(); }
    };
    if (!toReview.length) {
      hoot(`Every PR for ${ticket.title} is already approved, marking as '${c.tags.done}'`, 'cheer');
      return log('ok', `${ticket.key}: every PR is already approved and unchanged since; nothing to re-review`);
    }
    if (!on()) {
      log('info', `${ticket.key}: the Reviewer was switched off as it claimed this ticket; putting '${c.tags.trigger}' back`);
      return release();
    }
    hoot(`Starting reviews for ${ticket.title}, marking as '${c.tags.inProgress}'`);
    try {
      const cloned = await gh.cloneMissing(toReview, c.workDir);
      if (cloned.length) log('info', `${ticket.key}: cloned ${cloned.join(', ')} into ${c.workDir}`);
    } catch (e) {
      log('warn', `${ticket.key}: ${e.message}; reviewing from GitHub without a local clone`);
    }
    let ticketText = '';
    if (c.ticketContext) {
      try {
        ticketText = await tracker.ticketText(c, ticket);
      } catch (e) {
        log('warn', `${ticket.key}: couldn't read the ticket's text (${e.message}); reviewing without it`);
      }
    }
    if (!on()) {
      log('info', `${ticket.key}: the Reviewer was switched off before the review started; putting '${c.tags.trigger}' back`);
      return release();
    }
    let run;
    try {
      if (prior && c.reReviewScope === 'delta' && !prior.reviewedHeads) log('info', `${ticket.key}: re-reviewing in full, as the last review is from before Prowl recorded the commits it reviewed`, `scope:${ticket.key}`);
      run = (side.startReview || rv.startReview)(c, appDir, { tracker: c.taskBoard, ticket, prs: toReview, approvedPrs: approved, leftOut: prior ? leftOut : [], prior, me: app.me, heads, ticketText });
    } catch (e) {
      log('error', `${ticket.key}: could not start the review: ${e.message}`);
      return release();
    }
    state.runs.push(run);
    if (state.capped) delete state.capped[ticket.key]; // the cap was raised or turned off, or a new PR came in
    save();
    forget(key);
    hoot(toReview.length > 1 ? `Starting a batch review of ${toReview.length} PRs` : `Starting a review of ${toReview[0].title}`);
    log('ok', `${ticket.key}: ${prior ? `re-review #${run.reviewNo}` : 'review'} started on ${toReview.length} PR${toReview.length > 1 ? 's' : ''}${skipped}`);
    return announce(run);
  }

  /**
   * A quick review of `refs` ([{ repo, number }]), asked for in the TUI (n): reviewed together as one set, with no
   * ticket and no tags. Resolves with the run, or null on a dry run; rejects when it can't start.
   */
  side.reviewPrs = async function reviewPrs(refs) {
    const c = cfg();
    if (!on()) throw new Error('the Reviewer is off');
    if (side.running().length >= c.maxConcurrentReviews) throw new Error(`${c.maxConcurrentReviews} reviews are already running (Max parallel reviews)`);
    app.me ||= await gh.me();
    const prs = [];
    for (const ref of refs) {
      const pr = await gh.prByRef(ref).catch(e => { throw new Error(`couldn't read ${ref.repo}#${ref.number} (${e.message})`); });
      if (pr.state !== 'open') throw new Error(`${pr.repo}#${pr.number} is ${pr.state}`);
      prs.push(pr);
    }
    const names = prs.map(p => `${p.repo.split('/')[1]}#${p.number}`).join(', ');
    // QUICK-1, -2, …: keeps each quick review its own entry in History.
    const n = 1 + Math.max(0, ...side.state.runs.filter(r => r.quick).map(r => Number(r.ticket.split('-').pop()) || 0));
    const ticket = { key: `QUICK-${n}`, title: `Quick review: ${names}`, url: '', ref: null };
    if (app.dryRun()) { log('info', `${ticket.key}: would review ${prs.map(p => p.url).join(' ')}`); return null; }
    try {
      const cloned = await gh.cloneMissing(prs, c.workDir);
      if (cloned.length) log('info', `${ticket.key}: cloned ${cloned.join(', ')} into ${c.workDir}`);
    } catch (e) {
      log('warn', `${ticket.key}: ${e.message}; reviewing from GitHub without a local clone`);
    }
    const heads = {};
    for (const pr of prs) heads[pr.url] = await gh.headSha(pr).catch(() => '');
    const run = (side.startReview || rv.startReview)(c, appDir, { tracker: null, ticket, prs, me: app.me, heads, quick: true });
    side.state.runs.push(run);
    save();
    hoot(prs.length > 1 ? `Starting a quick review of ${prs.length} PRs` : `Starting a quick review of ${prs[0].title}`);
    log('ok', `${ticket.key}: quick review started on ${names}`);
    await announce(run);
    return run;
  };

  /**
   * Posts the Review started comment (output.md) on each PR under review, so people can see Prowl has it. A quick
   * review has no ticket to link to: it posts Quick review started, which links the PRs instead.
   */
  async function announce(run) {
    const text = run.quick
      ? fill(outputTemplate(appDir, 'Quick review started'), { prs: run.prs.map(p => `[${p.repo.split('/')[1]}#${p.number}](${p.url})`).join(', ') })
      : fill(outputTemplate(appDir, 'Review started'), { ticket: run.ticket, 'ticket link': run.ticketUrl });
    // The prowl-review marker keeps prowl-review from counting it as someone else's comment.
    const body = `${text}\n<!-- prowl-review ${run.id} started -->`;
    const file = path.join(path.dirname(run.logPath), `${run.id}.started.json`);
    writeJson(file, { body });
    for (const pr of run.prs) {
      try {
        await gh.postComment(pr, file);
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

  /** Settles a review whose session ended, then moves the ticket's tag on. A quick review has no ticket, nor tags. */
  async function finish(run) {
    rv.finalize(run);
    const { tags } = cfg();
    const failures = run.quick ? {} : side.state.failures;
    const again = run.quick ? 'n reviews PRs again' : `re-tag '${tags.trigger}' to try again`;
    if (run.status === 'done') {
      const unchecked = await checkPosted(run).catch(() => run.prs.map(p => p.url)); // announce any PR posted since the last check
      if (run.marker) rv.failUnposted(run, await missingReviews(run, unchecked)); // reviews started before 2.12.0 have none
    }
    if (run.status === 'done') {
      delete failures[run.ticket];
      run.pendingTag = tags.done;
      const s = run.summary || {};
      log('ok', `${run.ticket}: review ${run.reviewNo} finished: ${s.verdict || 'no verdict'} (C${s.critical ?? '?'} H${s.high ?? '?'} M${s.medium ?? '?'} L${s.low ?? '?'} N${s.nit ?? '?'}) · ${run.reportPath}`);
      hoot(run.quick ? `Done with ${run.ticket}` : `Done reviewing PRs for ${run.title}, marking as '${tags.done}'`, 'cheer');
    } else if (run.status === 'failed') {
      failures[run.ticket] = (failures[run.ticket] || 0) + 1;
      const retry = !run.quick && rv.retryFailed(run, failures[run.ticket]); // one automatic retry, then wait for a human to re-tag
      run.pendingTag = retry ? tags.trigger : '';
      const why = run.capped ? 'Not retried, as it hit a cap' : run.unposted?.length ? 'Not retried, as a retry would most likely be blocked too' : run.quick ? 'Not retried' : 'Not retrying again';
      log('error', `${run.ticket}: review failed: ${run.error}. ${retry ? `Re-tagged '${tags.trigger}' to retry once.` : `${why}; ${again}.`}`);
    } else {
      run.pendingTag = '';
      log('warn', `${run.ticket}: review stopped. ${run.quick ? 'n reviews PRs again' : `Re-tag '${tags.trigger}' to run it again`}.`);
    }
    if (run.quick) run.pendingTag = null;
    save();
    if (run.pendingTag != null) await applyTag(run);
  }

  /** Writes run.pendingTag to the ticket (replacing the tags this side owns); retried every minute until it lands. */
  async function applyTag(run) {
    run._tagging = true;
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
  side.tick = function tick() {
    for (const run of side.running()) {
      if (run._finishing) continue;
      rv.readActivity(run);
      if (run._result || !rv.alive(run)) {
        rv.readActivity(run); // pick up the last lines written before exit
        run._finishing = true;
        finish(run).catch(e => log('error', `${run.ticket}: ${e.message}`));
      } else if (rv.overdue(run, cfg())) {
        stopOverdue(run);
      } else if (app.me && !run._checking && Date.now() - (run._checkedAt || 0) > 60_000) {
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
    for (const run of side.running()) {
      rv.readActivity(run);
      if (run._result || !rv.alive(run)) await finish(run);
      else if (rv.overdue(run, cfg())) stopOverdue(run); // settled by the next launch, once it has exited
    }
  };

  side.stop = run => {
    rv.stopReview(run);
    save();
    log('warn', `${run.ticket}: stopping the review`);
  };

  side.finish = finish; // for the self-test
  return side;
}
