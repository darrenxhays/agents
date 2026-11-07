// The Reviewer: polls the boards for tickets tagged for review and runs Claude Code's prowl-review skill on their open,
// non-draft GitHub PRs. src/shell.mjs drives poll() and tick(); the Builder never reads its state (state.json).
import path from 'node:path';
import { saveConfig, writeJson } from '../config.mjs';
import * as github from '../github.mjs';
import { createLabels, matching, refusal } from '../labels.mjs';
import { norm, tagMatches } from '../match.mjs';
import { acceptOffer, offerFor } from '../offers.mjs';
import { autoName, cleanName, notARef, parsePaste, ticketKey } from '../paste.mjs';
import { fill, outputTemplate } from '../templates.mjs';
import * as rv from './reviews.mjs';

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
  side.running = () => side.state.runs.filter(r => r.status === 'running' || r.status === 'stopping');
  side.finished = () => side.state.runs.filter(r => r.status !== 'running' && r.status !== 'stopping').sort((a, b) => b.endedAt - a.endedAt);
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

  // Tags this side sets itself are matched exactly; only the trigger tag is matched loosely.
  const ours = t => [cfg().tags.inProgress, cfg().tags.done].some(x => norm(x) === norm(t));
  const isTrigger = t => !ours(t) && tagMatches(t, cfg().tags.trigger, cfg().tagMatchMaxTypos);

  side.poll = async function poll() {
    side.lastError = '';
    const pruned = rv.tidyLogs(cfg().logRetentionDays, side.running()); // on launch, then once per poll
    if (pruned) log('info', `Deleted ${pruned} review log file${pruned > 1 ? 's' : ''} older than ${cfg().logRetentionDays} days`);
    app.me ||= await gh.me();
    await checkHumanApprovals(); // before the board checks: a quick review needs neither boards nor an org
    await checkWaits();
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
  };

  async function consider(tracker, ticket) {
    const c = cfg();
    const key = `ticket:${ticket.key}`;
    if (side.running().some(r => r.ticket === ticket.key)) return; // re-tagged mid-review: re-reviewed once this one ends
    if (busy() >= c.maxConcurrentReviews) {
      log('info', `${ticket.key}: waiting, ${c.maxConcurrentReviews} reviews already running`, key);
      return;
    }
    const free = hold();
    try {
      await prepareTicket(tracker, ticket, key, free);
    } finally {
      free();
    }
  }

  async function prepareTicket(tracker, ticket, key, free) {
    const { state } = side;
    const c = cfg();
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
    free(); // the run counts itself from here
    endWaits(ticket.key, 'its tagged review started');
    if (state.capped) delete state.capped[ticket.key]; // the cap was raised or turned off, or a new PR came in
    save();
    forget(key);
    hoot(toReview.length > 1 ? `Starting a batch review of ${toReview.length} PRs` : `Starting a review of ${toReview[0].title}`);
    log('ok', `${ticket.key}: ${prior ? `re-review #${run.reviewNo}` : 'review'} started on ${toReview.length} PR${toReview.length > 1 ? 's' : ''}${skipped}`);
    return announce(run);
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
      const spec = await named(c, { prs: paste.prs, tickets: paste.tickets }, tickets, prs, opts);
      return await startQuick(c, spec, prs, free);
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
    if (side.running().some(r => r.ticket === spec.key)) throw new Error(`${spec.key} is being reviewed already: try again once that review ends`);
    const drafts = prs.filter(p => p.draft && !p.gone);
    if (drafts.length) throw lasting(`${names(drafts)} ${drafts.length > 1 ? 'are drafts' : 'is a draft'}: mark ${drafts.length > 1 ? 'them' : 'it'} ready, then paste again`);
    const open = prs.filter(p => !p.gone && !p.unreadable);
    if (!open.length) throw lasting('none of its PRs is open');
    const done = side.state.runs.filter(r => r.ticket === spec.key && r.status === 'done').sort((a, b) => b.endedAt - a.endedAt);
    const prior = done[0];
    const covered = new Set(done.flatMap(r => [...r.prs, ...(r.contextPrs || [])].map(p => p.url)));
    const heads = Object.fromEntries(open.map(p => [p.url, p.headSha || '']));
    for (const p of open) if (!heads[p.url]) heads[p.url] = await gh.headSha(p).catch(() => '');
    const approved = open.filter(p => prior?.approved?.[p.url] && prior.approved[p.url] === heads[p.url]);
    let toReview = open.filter(p => !approved.includes(p));
    const leftOut = [];
    if (toReview.length && rv.roundCapped(c, prior)) {
      const fresh = toReview.filter(p => !covered.has(p.url));
      if (!fresh.length) throw lasting(`it has had ${prior.reviewNo} reviews, the round cap (Max review rounds)`);
      leftOut.push(...toReview.filter(p => !fresh.includes(p)));
      toReview = fresh;
    }
    if (!toReview.length) throw lasting(`every PR is already approved, with no new commits since review ${prior.reviewNo}`);
    const strip = pr => ({ url: pr.url, title: pr.title, number: pr.number, repo: pr.repo, author: pr.author, draft: false });
    const ticket = { key: spec.key, title: spec.title, url: spec.ticketUrl || '', ref: null };
    if (app.dryRun()) { log('info', `${spec.key}: would review ${toReview.map(p => p.url).join(' ')}`); return null; }
    try {
      const cloned = await gh.cloneMissing(toReview, c.workDir);
      if (cloned.length) log('info', `${spec.key}: cloned ${cloned.join(', ')} into ${c.workDir}`);
    } catch (e) {
      log('warn', `${spec.key}: ${e.message}; reviewing from GitHub without a local clone`);
    }
    if (!on()) throw new Error('the Reviewer was switched off before the review started');
    const run = (side.startReview || rv.startReview)(c, appDir, { tracker: null, ticket, prs: toReview.map(strip), approvedPrs: approved.map(strip), leftOut: prior ? leftOut.map(strip) : [], prior, me: app.me, heads, quick: true });
    Object.assign(run, { paste: spec.paste, ...(labelsOn() && { labels: true }) });
    side.state.runs.push(run);
    free(); // the run counts itself from here
    if (spec.fromWait) side.state.waits = side.waits().filter(x => x.key !== spec.key); // its own re-review: it waits again once this one ends
    else endWaits(spec.key, 'a new review of it started');
    save();
    if (run.labels) {
      // This review has these PRs' labels now: an older quick review's writes to them are dropped.
      labels.own('reviewer', run.id, [...toReview, ...approved].map(p => p.url));
      for (const p of toReview) labels.set('reviewer', run.id, p, c.tags.inProgress, [c.tags.trigger, c.tags.done], c.tagMatchMaxTypos);
      for (const p of approved) labels.set('reviewer', run.id, p, '', [c.tags.trigger], c.tagMatchMaxTypos); // context: Ready for Review comes off
    }
    hoot(toReview.length > 1 ? `Starting a quick review of ${toReview.length} PRs` : `Starting a quick review of ${toReview[0].title}`);
    log('ok', `${spec.key}: quick ${prior ? `re-review #${run.reviewNo}` : 'review'} started on ${names(toReview)}${approved.length ? ` (already approved, unchanged: ${names(approved)})` : ''}`);
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
    wt.waitingOn = [];
    if (!live.length) return endWait(wt, 'every PR is merged, closed or can no longer be read');
    if (wt.retry) return startAgain(wt, run, prs, 'retrying the review that failed');
    if (rv.roundCapped(c, run)) return endWait(wt, `it has had ${run.reviewNo} reviews, the round cap (Max review rounds)`);
    const approvedNow = p => run.approved?.[p.url] && run.approved[p.url] === p.headSha;
    const has = (p, tag, typos = 0) => matching(p.labels || [], tag, typos).length > 0;
    // Ready for Review counts only once Prowl's own labels on the PR have landed.
    const ready = p => has(p, c.tags.trigger, c.tagMatchMaxTypos) && !labels.pending(p.url);
    const notes = [];
    for (const p of live.filter(x => has(x, c.tags.inProgress) && approvedNow(x))) notes.push(`${p.repo}#${p.number} is labelled '${c.tags.inProgress}', but it is approved and only context: it doesn't hold the wait`);
    wt.notes = notes;
    const reviewing = live.filter(p => has(p, c.tags.inProgress) && !approvedNow(p));
    if (reviewing.length) {
      wt.waitingOn = reviewing.map(p => p.url);
      return log('info', `${wt.key}: waiting: ${names(reviewing)} ${reviewing.length > 1 ? 'are' : 'is'} labelled '${c.tags.inProgress}'`, key);
    }
    const waitedOn = live.filter(p => !run.approved?.[p.url]); // the PRs it didn't approve, and new ones
    let go;
    if (waitedOn.length) {
      wt.waitingOn = waitedOn.filter(p => !ready(p)).map(p => p.url);
      go = waitedOn.every(ready);
    } else {
      // Every PR approved: Ready for Review with new commits since the approval re-reviews; Ready for Review alone waits.
      wt.waitingOn = live.map(p => p.url);
      go = live.some(p => ready(p) && !approvedNow(p));
      if (!go && live.some(ready)) log('info', `${wt.key}: '${c.tags.trigger}' is on, but no PR has new commits since it was approved; still waiting`, key);
    }
    save();
    if (!go) return undefined;
    return startAgain(wt, run, prs, waitedOn.length ? `every PR it didn't approve is labelled '${c.tags.trigger}'` : `labelled '${c.tags.trigger}', with new commits`);
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

  /** The PR's labels after a quick review: `add` on each of `prs`, the Reviewer's other labels off. */
  function relabel(run, prs, add) {
    const { tags } = cfg();
    for (const p of prs) labels.set('reviewer', run.id, p, add, [tags.inProgress, tags.done, tags.trigger].filter(t => t !== add), cfg().tagMatchMaxTypos);
  }

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

  /**
   * Settles a review whose session ended, then moves the ticket's tag on. A quick review has no tags; with labels, it
   * labels its PRs Reviewed and waits on them, or retries once, or takes its labels off.
   */
  async function finish(run) {
    rv.finalize(run);
    const { tags } = cfg();
    const failures = run.quick ? (side.state.quickFailures ??= {}) : side.state.failures; // a quick review's apart from the ticket's
    const again = run.quick ? 'n reviews PRs again' : `re-tag '${tags.trigger}' to try again`;
    if (run.status === 'done') {
      const unchecked = await checkPosted(run).catch(() => run.prs.map(p => p.url)); // announce any PR posted since the last check
      if (run.marker) rv.failUnposted(run, await missingReviews(run, unchecked)); // reviews started before 2.12.0 have none
    }
    let retry = false;
    if (run.status === 'done') {
      delete failures[run.ticket];
      run.pendingTag = tags.done;
      const s = run.summary || {};
      log('ok', `${run.ticket}: review ${run.reviewNo} finished: ${s.verdict || 'no verdict'} (C${s.critical ?? '?'} H${s.high ?? '?'} M${s.medium ?? '?'} L${s.low ?? '?'} N${s.nit ?? '?'}) · ${run.reportPath}`);
      hoot(run.quick ? `Done with ${run.ticket}` : `Done reviewing PRs for ${run.title}, marking as '${tags.done}'`, 'cheer');
    } else if (run.status === 'failed') {
      failures[run.ticket] = (failures[run.ticket] || 0) + 1;
      retry = (!run.quick || run.labels) && rv.retryFailed(run, failures[run.ticket]); // one automatic retry, then wait for a human
      run.pendingTag = retry ? tags.trigger : '';
      const why = run.capped ? 'Not retried, as it hit a cap' : run.unposted?.length ? 'Not retried, as a retry would most likely be blocked too' : run.quick && !run.labels ? 'Not retried' : 'Not retrying again';
      const retried = run.quick ? 'Retrying it once, when a slot is free.' : `Re-tagged '${tags.trigger}' to retry once.`;
      log('error', `${run.ticket}: review failed: ${run.error}. ${retry ? retried : `${why}; ${again}.`}`);
    } else {
      run.pendingTag = '';
      log('warn', `${run.ticket}: review stopped. ${run.quick ? 'n reviews PRs again' : `Re-tag '${tags.trigger}' to run it again`}.`);
    }
    if (run.quick) {
      run.pendingTag = null;
      if (run.labels) settleLabels(run, retry);
    }
    save();
    if (run.pendingTag != null) await applyTag(run);
  }

  /** A quick review with labels, settled: Reviewed and a wait on its PRs, a wait to retry it, or its labels off. */
  function settleLabels(run, retry) {
    const { tags } = cfg();
    if (run.status !== 'done' && !retry) {
      relabel(run, run.prs, ''); // not retried, or stopped: In Review comes off
      return endWaits(run.ticket, run.status === 'stopped' ? 'its review was stopped' : 'its review failed');
    }
    if (run.status === 'done') relabel(run, run.prs, tags.done);
    side.state.waits = side.waits().filter(x => x.key !== run.ticket);
    side.waits().push({ key: run.ticket, title: run.title, ticketUrl: run.ticketUrl || '', paste: run.paste || { prs: run.prs.map(p => ({ repo: p.repo, number: p.number })), tickets: [] },
      runId: run.id, since: Date.now(), letGo: {}, retry, waitingOn: run.prs.filter(p => !run.approved?.[p.url]).map(p => p.url) });
    if (run.status === 'done') {
      const open = run.prs.filter(p => !run.approved?.[p.url]);
      log('info', `${run.ticket}: labelled '${tags.done}'; ${open.length ? `waiting for '${tags.trigger}' on ${names(open)}` : `every PR approved: waiting for '${tags.trigger}' with new commits`}`);
    }
    return undefined;
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
