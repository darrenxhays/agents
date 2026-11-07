// The Builder: picks up tickets tagged Ready to Start, builds them in a fenced Claude Code session, then Prowl's own
// code checks, pushes and opens one PR per repo, tags the ticket Ready for Review and follows the PRs through review,
// fixing feedback in rounds. src/shell.mjs drives poll() and tick(); the Reviewer never reads its state (work.json, work/).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readChecks, writeJson } from '../config.mjs';
import { matchChecks, runChecks, TAIL } from '../checks.mjs';
import { actionable, appendAnswer, parkedUrls, pastAnswers, readAnswers, repliesToPost, stripParked, validateFeedback } from '../feedback.mjs';
import { addWorktree, fetchBranch, git, ownNumstat, push, remoteSha, removeWorktree, short, succeeds } from '../git.mjs';
import * as github from '../github.mjs';
import { branchRefusal, guardFailures, prRefusal } from '../guards.mjs';
import { createLabels, matching } from '../labels.mjs';
import { mentions } from '../match.mjs';
import { offerFor, acceptOffer } from '../offers.mjs';
import { autoName, cleanName, parsePaste, ticketKey } from '../paste.mjs';
import { killTree, notifyDesktop } from '../proc.mjs';
import { alive, capHit, readActivity } from '../sessions.mjs';
import { fill, outputTemplate } from '../templates.mjs';
import * as brief from './brief.mjs';
import { defaultBranchOf, ensureClone, ghClone, prepareRepo, remoteBranches, worktreeRoot } from './repos.mjs';
import * as rules from './rules.mjs';
import { startDiscussion, startTurn } from './session.mjs';

export const WORK_PATH = path.join(HOME, 'work.json');
export const WORK_DIR = path.join(HOME, 'work');
export const ANSWERS_PATH = path.join(WORK_DIR, 'answers.jsonl');

export function loadWork(file = WORK_PATH) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { records: [], needs: [], handedBack: {} };
    throw new Error(`Can't read ${file}: ${e.message}`);
  }
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const prName = pr => `${pr.repo}#${pr.number}`;
const folderId = key => String(key).replace(/[^A-Za-z0-9-]/g, '');

class NeedsYou extends Error {
  constructor(kind, message, fields = {}) { super(message); Object.assign(this, { kind, fields }); }
}
class Stopped extends Error {}

const DEFAULT_SESSION = { start: startTurn, discuss: startDiscussion, alive, kill: w => killTree(w.pid) };

/**
 * The Builder side. `deps`: { log(level, msg, key), forget(key), hoot(text, mood), appDir, trackers, labels (the label
 * queue both sides share), saveConfig(), and for the self-test: tracker (one module for every board), github, session
 * ({ start, alive, kill }), clone(repo, dir), notify, statePath, autoName }.
 */
export function createBuilder(app, deps) {
  const { log, hoot, appDir } = deps;
  const gh = deps.github || github;
  const session = deps.session || DEFAULT_SESSION;
  const clone = deps.clone || ghClone;
  const notify = deps.notify || notifyDesktop;
  const statePath = deps.statePath || WORK_PATH;
  const workDir = path.join(path.dirname(statePath), 'work');
  const answersPath = path.join(workDir, 'answers.jsonl');
  const side = { name: 'builder', label: 'Builder', state: loadWork(statePath), paused: false, polling: false, nextPoll: 0, lastError: '' };
  side.state.records ??= [];
  side.state.needs ??= [];
  side.state.handedBack ??= {};
  const cfg = () => app.cfg;
  const b = () => app.cfg.builder;
  const on = () => app.sideOn('builder');
  const save = () => writeJson(statePath, side.state, (k, v) => (k.startsWith('_') ? undefined : v));
  const records = () => side.state.records;
  const trackerOf = w => deps.tracker || deps.trackers[w?.tracker || cfg().taskBoard];
  const tags = () => rules.builderTags(cfg());
  const isOwn = p => Boolean(app.me && p.author?.toLowerCase() === app.me.toLowerCase());
  const notifyIf = (title, text) => { if (b().notify) notify(title, text); };
  const labels = deps.labels || createLabels({ gh, log: (sd, ...a) => log(...a), file: path.join(path.dirname(statePath), 'labels.json') });
  const pickup = () => ({ drafts: true, branches: true, checks: true, conflicts: true, ...(b().pickup || {}) });
  // A quick build without a ticket marks its cycle with labels on its PRs; every other build with its ticket's tags.
  const byLabels = w => w?.markers === 'labels';

  const current = key => records().find(r => r.key === key && !['done', 'stopped', 'ended'].includes(r.status));
  // Tickets being built, from the claim until their PRs open, Needs you included: the ones Max parallel builds counts.
  // A quick build is outside the limit.
  const building = () => records().filter(r => ['active', 'needs-you'].includes(r.status) && !r.prsOpenedAt && r.claimedAt && !r.quick);
  let claiming = 0; // claims awaiting the tracker, which hold a slot too
  const slotsUsed = (but = null) => building().filter(r => r !== but).length + claiming;
  side.running = () => records().filter(r => r.status === 'active');
  side.history = () => [...records()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  side.needs = () => side.state.needs;
  side.alive = () => records().some(r => (r.step === 'session' && session.alive(r)) || (r.discussion && session.alive(r.discussion)));
  const itemsOf = w => side.state.needs.filter(n => n.recordId === w.uid);

  function newRecord(ticket, source) {
    const n = records().filter(r => r.key === ticket.key).length + 1;
    const w = {
      uid: randomUUID(), key: ticket.key, tracker: cfg().taskBoard, ref: ticket.ref, title: ticket.title, url: ticket.url, id: folderId(ticket.key), n,
      source, status: 'active', step: null, createdAt: Date.now(), updatedAt: Date.now(), claimedAt: null, costUsd: 0, turns: [], repos: [], prs: [],
      rounds: 0, sessionId: null, sessionStarted: false, sessionCostUsd: 0, collected: { answers: [], ready: [], unavailable: [] },
    };
    w.briefDir = path.join(workDir, n > 1 ? `${w.id}-${n}` : w.id);
    records().push(w);
    return w;
  }

  const touch = w => { w.updatedAt = Date.now(); save(); };

  /** Puts a Needs-you item up for `w`. The ticket keeps In Development. */
  function raise(w, kind, question, fields = {}) {
    const item = rules.needItem(kind, { key: w.key, question, ...fields });
    item.recordId = w.uid;
    item.retry = fields.retry || null;
    side.state.needs.push(item);
    Object.assign(w, { status: 'needs-you', step: null });
    touch(w);
    log('warn', `${w.key}: needs you: ${question}`);
    hoot(`${w.key} needs you: ${question}`, 'error');
    notifyIf(`Prowl: ${w.key} needs you`, question);
    return item;
  }

  /** Runs one async step of `w`, one at a time. NeedsYou goes to Needs you; anything else is retried in a minute. */
  function step(w, fn) {
    w._busy = true;
    const p = fn(w).catch(e => {
      if (e instanceof Stopped) return stopNow(w);
      if (e instanceof NeedsYou) return raise(w, e.kind, e.message, e.fields);
      // Before its first session a ticket is retried three times, then left to you instead of holding a slot quietly.
      if (!w.sessionStarted && w.turnKind !== 'round') {
        w.preFailures = (w.preFailures || 0) + 1;
        if (w.preFailures >= 3) return raise(w, 'failed', `Prowl couldn't get ${w.key} ready to build: ${e.message}`, { retry: w.step });
      }
      w._retryAt = Date.now() + 60_000;
      log('error', `${w.key}: ${e.message}; retrying in a minute`, `work:${w.uid}`);
      return undefined;
    }).finally(() => { w._busy = false; });
    (side._inflight ??= new Set()).add(p);
    p.finally(() => side._inflight.delete(p));
    return p;
  }

  const checkStop = w => { if (w.stopRequested) throw new Stopped(); };

  // ---- Picking up a ticket ----

  side.poll = async function poll() {
    side.lastError = '';
    app.me ||= await gh.me();
    const tracker = trackerOf();
    const boards = app.boards();
    if (!boards.length) {
      log('warn', `No ${tracker.name} boards configured: add one in Config (4).`, 'boards');
      return;
    }
    if (!cfg().githubOwner) {
      log('warn', 'No GitHub org configured: set it in Config (4).', 'boards');
      return;
    }
    const { isStart } = tags();
    const seen = new Set();
    for (const board of boards) {
      const where = tracker.boardLabel(board);
      let tickets;
      try {
        ({ tickets } = await tracker.findTickets(cfg(), board, isStart, { assignedToMe: b().assignedToMe }));
      } catch (e) {
        side.lastError = e.message;
        log('error', `${where}: ${e.message}`, `board:${where}`);
        continue;
      }
      for (const ticket of tickets) {
        if (seen.has(ticket.key) || current(ticket.key)) continue;
        seen.add(ticket.key);
        await consider(tracker, ticket).catch(e => log('error', `${ticket.key}: ${e.message}`, `pick:${ticket.key}`));
      }
    }
    await follow();
  };

  async function consider(tracker, ticket) {
    const key = `pick:${ticket.key}`;
    const back = side.state.handedBack[ticket.key];
    if (back) {
      // Handed back: not reclaimed until someone takes the start tag off and puts it back on.
      const now = ticket.rev ?? (await tracker.readItem(cfg(), ticket.ref)).rev;
      if (!(await tracker.tagsChangedSince(cfg(), ticket.ref, back.rev, now, tags().isStart))) {
        log('info', `${ticket.key}: handed back to you; re-tag '${b().tags.start}' to build it again`, key);
        return;
      }
      delete side.state.handedBack[ticket.key];
      save();
    }
    if (slotsUsed() >= b().maxConcurrent) {
      log('info', `${ticket.key}: waiting, ${b().maxConcurrent} ticket${b().maxConcurrent > 1 ? 's are' : ' is'} already being built`, key);
      return;
    }
    if (app.dryRun()) {
      log('info', `${ticket.key}: would build "${ticket.title}"`, key);
      return;
    }
    if (!on() || side.paused) return;
    const w = await claim(ticket, 'tag');
    if (w) await step(w, survey);
  }

  /** Claims `ticket` (start tag → In Development); the loser backs off. Resolves with its record, or null. */
  async function claim(ticket, source, w = null) {
    const tracker = trackerOf(w);
    const { owned } = tags();
    claiming++;
    try {
      await tracker.claim(cfg(), ticket, owned, b().tags.inProgress);
    } catch (e) {
      if (e.lost) {
        log('warn', `${ticket.key}: not claimed (changed or claimed by someone else): ${e.message}`, `pick:${ticket.key}`);
        if (w) Object.assign(w, { status: 'ended', step: null, note: `not claimed: ${e.message}` });
        return null;
      }
      w ||= newRecord(ticket, source);
      Object.assign(w, { claimedAt: Date.now(), ticket });
      unsure(w, ticket, e, 'adopt');
      return null;
    } finally {
      claiming--;
    }
    w ||= newRecord(ticket, source);
    Object.assign(w, { claimedAt: Date.now(), step: 'adopt', status: 'active' });
    touch(w);
    deps.forget?.(`pick:${ticket.key}`);
    if (!on()) {
      Object.assign(w, { status: 'ended', step: null, note: 'the Builder was switched off as it claimed this ticket' });
      await release(w, ticket);
      return null;
    }
    log('ok', `${w.key}: claimed, marked '${b().tags.inProgress}'`);
    hoot(`Picking up ${w.title}, marking as '${b().tags.inProgress}'`);
    return w;
  }

  /**
   * A claim that failed with `e`, but not because someone else won (`e.lost`): its write may have reached the tracker
   * (the check after it failed, say), so the ticket may be ours, or a rival's. A person judges it in Needs you, so it
   * is neither stranded In Development nor built twice; enter goes on with `retry`.
   */
  function unsure(w, ticket, e, retry) {
    w.unsureOf = retry; // what enter goes on with, through reclaim()
    const item = raise(w, 'conflict', `Prowl couldn't confirm its claim on ${ticket.key} (${e.message}). If no one else is working on it, enter goes on (claiming it again if it isn't '${b().tags.inProgress}'); s ends it and leaves the tags as they are.`, { retry: 'reclaim' });
    item.keepTags = true; // the In Development there may be someone else's
    save();
  }

  /** enter on an unconfirmed claim: the ticket In Development is taken as ours; one that isn't is claimed again. */
  async function reclaim(w) {
    const ticket = await trackerOf(w).readItem(cfg(), w.ref);
    const held = tags().has(ticket.tags, b().tags.inProgress);
    const then = w.unsureOf;
    w.unsureOf = null;
    if (then === 'round') {
      w.roundClaimed = held; // not held: round() claims it as usual
      return next(w, 'round');
    }
    if (held) return next(w, 'adopt');
    w.ticket = ticket;
    const claimed = await claim(ticket, w.source, w);
    touch(w);
    return claimed ? survey(claimed) : undefined;
  }

  /** Switched off as it claimed `ticket`: puts back what the claim took off. */
  async function release(w, ticket) {
    touch(w);
    const hadStart = (ticket.tags || []).some(tags().isStart);
    if (await retagSoon(w, hadStart ? b().tags.start : '')) log('info', `${w.key}: the Builder was switched off as it claimed this ticket; its tags are back as they were`);
  }

  /**
   * In Development → the done tag (Ready for Review), the Reviewer's trigger; never takes the reviewing tag off.
   * With builder.requestReview off, In Development just comes off.
   * A retry after a try that may have landed (its answer lost) leaves the ticket as it is if that try shows: In
   * Development gone (when it was there), or the done or reviewing tag on (when it wasn't), as a review may have
   * claimed it since. Resolves with the time of the first try, from which feedback counts.
   */
  async function handOff(w, prs = w.prs) {
    if (byLabels(w)) {
      labelPrs(w, prs, b().requestReview ? cfg().tags.trigger : '');
      return Date.now();
    }
    const { isStart, has } = tags();
    const tracker = trackerOf(w);
    const item = await tracker.readItem(cfg(), w.ref);
    const now = item.tags;
    // Without In Development to go by, the history says whether the done tag went on since (a review may have come and gone).
    const ask = b().requestReview;
    const landed = w.handOff && (w.handOff.held ? !has(now, b().tags.inProgress)
      : !ask || has(now, cfg().tags.trigger) || has(now, cfg().tags.inProgress) || (await tracker.tagAddedSince(cfg(), w.ref, w.handOff.rev, t => has([t], cfg().tags.trigger))));
    if (landed) log('info', `${w.key}: its handoff to review already went through`);
    else {
      checkStop(w); // s while the ticket was read: no handoff
      w.handOff ??= { at: Date.now(), held: has(now, b().tags.inProgress), rev: item.rev };
      touch(w);
      await trackerOf(w).retag(cfg(), w.ref, t => isStart(t) || has([t], b().tags.inProgress) || (ask && has([t], cfg().tags.trigger)), ask ? cfg().tags.trigger : '');
    }
    const { at } = w.handOff;
    w.handOff = null;
    touch(w);
    return at;
  }

  const marked = w => `${byLabels(w) ? 'its PRs ' : ''}${b().requestReview ? `marked '${cfg().tags.trigger}'` : `'${b().tags.inProgress}' removed`}`;

  /**
   * A ticketless build's markers: `add` ('' for none) on each of `prs`, the Builder's other label off. The Builder's
   * labels are In Development and Ready for Review; it never touches In Review or Reviewed.
   */
  function labelPrs(w, prs, add) {
    const mine = [b().tags.inProgress, cfg().tags.trigger];
    labels.own('builder', w.uid, prs.map(p => p.url));
    for (const p of prs) labels.set('builder', w.uid, p, add, mine.filter(t => t !== add), cfg().tagMatchMaxTypos);
  }

  /** Why a ticketless build's round waits (a PR labelled In Review or Ready for Review, or a label write still queued), or ''. */
  async function labelHold(w, prs = w.prs) {
    const { inProgress: reviewing, trigger } = cfg().tags;
    for (const p of prs) {
      if (labels.pending(p.url)) return `${prName(p)} has a label change still queued`;
      const on = await gh.prLabels(p);
      const hit = [reviewing, trigger].find(t => matching(on, t, t === trigger ? cfg().tagMatchMaxTypos : 0).length);
      if (hit) return `${prName(p)} is labelled '${hit}'`;
    }
    return '';
  }

  /** Sets the tags Prowl owns on `w`'s ticket to `add` ('' for none); while the tracker fails, again each minute. Resolves true once done. */
  async function retagSoon(w, add) {
    const newer = current(w.key);
    if (w.step === 'retag' && newer && newer !== w) {
      // Since claimed again, by a newer run: its tags are its own now.
      Object.assign(w, { step: null, retagTo: undefined });
      touch(w);
      return true;
    }
    try {
      if (byLabels(w)) labelPrs(w, w.prs || [], ''); // the queue retries a write that fails
      else await trackerOf(w).retag(cfg(), w.ref, tags().owned, add);
    } catch (e) {
      Object.assign(w, { step: 'retag', retagTo: add, _retryAt: Date.now() + 60_000 });
      touch(w);
      log('error', `${w.key}: couldn't change its tags (${e.message}); retrying in a minute`, `work:${w.uid}`);
      return false;
    }
    if (w.step === 'retag') {
      Object.assign(w, { step: null, retagTo: undefined });
      touch(w);
      log('ok', `${w.key}: its tags are set now`);
    }
    return true;
  }

  /**
   * Adopts the ticket's open, non-draft PRs of yours when it has some; otherwise reads it to build it. Following by hand
   * (--follow, w) claims nothing: a round claims the ticket when it starts, and a review asked for or under way is left be.
   */
  async function adoptOrRead(w) {
    app.me ||= await gh.me(); // --follow and --work can run before the first poll
    const mine = (await gh.openPrs(cfg().githubOwner, w.key)).filter(p => !p.draft && isOwn(p));
    if (!mine.length) {
      if (w.source === 'follow') {
        Object.assign(w, { status: 'ended', step: null, note: 'no open PRs of yours to follow' });
        touch(w);
        return log('warn', `${w.key}: has no open, ready PRs of yours to follow`);
      }
      w.step = 'read';
      touch(w);
      return read(w);
    }
    Object.assign(w, { prs: mine.map(p => ({ repo: p.repo, number: p.number, url: p.url, title: p.title })), prsOpenedAt: Date.now(), lastActivityAt: 0, adopted: true });
    log('ok', `${w.key}: following its PRs ${mine.map(prName).join(', ')} instead of building it`);
    // Followed by hand while a review is asked for or under way: that review finishes first, as in follow().
    const reviewing = !w.claimedAt && [cfg().tags.trigger, cfg().tags.inProgress].some(t => tags().has(w.ticket?.tags || [], t));
    const due = reviewing ? [] : await dueFeedback(w);
    // Waiting for a review, its feedback so far is still to come (lastActivityAt 0). A round straight after a claim holds it already.
    Object.assign(w, { roundPrs: due, lastActivityAt: due.length || reviewing ? 0 : Date.now(), roundClaimed: due.length > 0 && Boolean(w.claimedAt), step: due.length ? 'round' : reviewing ? null : 'end-round', status: due.length || !reviewing ? 'active' : 'following' });
    touch(w);
    return undefined;
  }

  // ---- Picking up work at any stage ----

  const ticketTexts = data => [data.description, data.acceptanceCriteria, data.reproSteps, ...data.comments.map(c => c.text),
    ...[data.parent, ...data.children, ...data.related].filter(Boolean).map(i => i.description), ...data.links.map(l => l.url)];
  const prRef = p => ({ repo: p.repo, number: p.number, url: p.url, title: p.title });

  /**
   * What has been done on `w` already, per repo: its open PRs (drafts too, with Pick up drafts) and its pushed
   * branches with your commits and no PR (Pick up branches), and what each PR needs fixed: feedback, failing
   * required checks, conflicts. Then: nothing found builds it; something to fix starts a fix round, then a finish
   * session; nothing to fix, a finish session. Your PRs and branches are continued; anyone else's, and forks, are context.
   * Following by hand (--follow, w) only follows (adoptOrRead).
   */
  async function survey(w) {
    app.me ||= await gh.me(); // --work can run before the first poll
    if (w.source === 'follow') return adoptOrRead(w);
    const pk = pickup();
    const found = { prs: [], branches: [], context: [], listed: [] };
    const tracker = byLabels(w) ? null : trackerOf(w);
    const data = w.ref ? await tracker.workItem(cfg(), w.ref) : null;
    // The ticket's open PRs, or the PRs a quick build was given.
    const open = [];
    if (w.scope) for (const ref of w.scope) { const pr = await gh.prByRef(ref); if (pr.state === 'open') open.push(pr); }
    else if (w.ref) open.push(...await gh.openPrs(cfg().githubOwner, w.key));
    for (const p of open) {
      if (p.draft && !pk.drafts) continue; // Pick up drafts off: left alone, as before
      const facts = await gh.prFacts(p);
      if (facts.state !== 'OPEN') continue;
      const entry = { ...prRef(p), branch: facts.headBranch, head: facts.headSha, base: facts.base, draft: facts.draft, defaultBranch: facts.defaultBranch, mergeable: facts.mergeable,
        stat: { files: facts.files || 0, additions: facts.additions || 0, deletions: facts.deletions || 0 } };
      const why = prRefusal(facts, p, app.me, b().protectedBranches, { drafts: pk.drafts });
      if (why) {
        found.context.push({ ...entry, why });
        log('info', `${w.key}: ${why}; it is context only`);
      } else if (found.prs.some(x => x.repo === entry.repo)) {
        found.context.push({ ...entry, why: 'another of your PRs in the same repo is continued' });
        log('info', `${w.key}: ${prName(entry)} is context only: Prowl continues one branch per repo`);
      } else found.prs.push(entry);
    }
    if (pk.conflicts && found.prs.some(p => p.mergeable === 'UNKNOWN')) {
      w._retryAt = Date.now() + cfg().pollSeconds * 1000;
      const unknown = found.prs.filter(p => p.mergeable === 'UNKNOWN');
      return log('info', `${w.key}: GitHub is still working out whether ${unknown.map(prName).join(', ')} conflict${unknown.length > 1 ? '' : 's'}; looking again next poll`, `work:${w.uid}`);
    }
    if (pk.branches && data && !w.scope) await surveyBranches(w, data, found); // given PRs: those are the scope
    w.survey = found;
    if (!found.prs.length && !found.branches.length) {
      if (found.context.length) log('info', `${w.key}: nothing of yours to continue; building it`);
      w.step = 'read';
      touch(w);
      return read(w);
    }
    // What each of your PRs needs fixed first.
    const fix = {};
    for (const p of found.prs) {
      const reasons = [];
      const [reviews, threads] = await Promise.all([gh.prReviews(p), gh.prThreads(p)]);
      if (rules.feedbackDue({ reviews, threads }, 0, b().fixFrom)) reasons.push('feedback');
      let failing = [];
      if (pk.checks) {
        failing = (await gh.requiredChecks(p.url).catch(() => [])).filter(c => ['fail', 'cancel'].includes(c.bucket));
        if (failing.length) reasons.push('failing checks');
      }
      if (pk.conflicts && p.mergeable === 'CONFLICTING') reasons.push(`conflicts with ${p.base}`);
      if (reasons.length) fix[p.url] = { reasons, failing: failing.map(c => ({ name: c.name, link: c.link || '' })), conflict: p.mergeable === 'CONFLICTING' && pk.conflicts };
    }
    const work = [...found.prs.map(prName), ...found.branches.map(x => `${x.repo} ${x.branch}`)].join(', ');
    Object.assign(w, { prs: found.prs.map(prRef), adopted: true, lastActivityAt: 0 });
    if (byLabels(w) && found.prs.length) labelPrs(w, found.prs, b().tags.inProgress);
    if (Object.keys(fix).length) {
      log('ok', `${w.key}: picking up ${work}; a fix round first (${Object.entries(fix).map(([url, f]) => `${prName(found.prs.find(x => x.url === url))}: ${f.reasons.join(', ')}`).join('; ')})`);
      Object.assign(w, { pickupFix: fix, finishAfterRound: true, roundPrs: found.prs.filter(p => fix[p.url]).map(prRef), roundClaimed: Boolean(w.claimedAt) || byLabels(w), step: 'round', status: 'active' });
    } else {
      log('ok', `${w.key}: picking up ${work}; nothing to fix, so a session finishes it`);
      Object.assign(w, { step: 'finish', status: 'active' });
    }
    touch(w);
    return undefined;
  }

  /**
   * Your pushed branches for the ticket with no PR, in the repos it names (or its PRs are in): named with its number,
   * or linked on the ticket. Only branches with commits of yours ahead of the base count; only GitHub ones are
   * continued, and a linked branch Prowl can't place is listed for the session.
   */
  async function surveyBranches(w, data, found) {
    const owner = cfg().githubOwner;
    const mentioning = await gh.prsMentioning(owner, w.key).catch(() => []);
    const repos = rules.repoCandidates(ticketTexts(data), mentioning.map(p => p.repo)).filter(r => rules.ownerAllowed(r, cfg()));
    const lists = {};
    for (const repo of repos) lists[repo] = await gh.repoBranches(repo).catch(e => { log('warn', `${w.key}: couldn't list ${repo}'s branches (${e.message})`); return []; });
    const want = repos.flatMap(repo => lists[repo].filter(n => rules.branchForTicket(n, w.key)).map(branch => ({ repo, branch })));
    // Linked on the ticket: Azure DevOps' GitHub branch links name a connection id, not the repo.
    if (data.github) {
      for (const { id, branch } of data.github.branches) {
        const viaPr = [...new Set(data.github.prs.filter(x => x.id === id).map(x => mentioning.find(m => m.number === x.number)?.repo).filter(Boolean))];
        const inRepos = viaPr.length === 1 ? viaPr : repos.filter(r => lists[r].includes(branch));
        if (inRepos.length) want.push(...inRepos.map(repo => ({ repo, branch })));
        else found.listed.push({ branch, why: "linked on the ticket, but Prowl can't tell which repo it is in" });
      }
      for (const x of data.otherBranches || []) found.listed.push({ branch: x.branch, why: 'linked on the ticket; not on GitHub, so Prowl only lists it' });
    } else if (trackerOf(w).linkedBranches) {
      for (const x of await trackerOf(w).linkedBranches(cfg(), w.ref)) {
        if (x.repo && rules.ownerAllowed(x.repo, cfg())) want.push({ repo: x.repo, branch: x.branch });
        else found.listed.push({ branch: x.branch, repo: x.repo, why: x.repo ? "linked on the ticket, in a repo Prowl can't work in" : 'linked on the ticket; not on GitHub, so Prowl only lists it' });
      }
    }
    const taken = new Set([...found.prs, ...found.context].map(p => `${p.repo} ${p.branch}`.toLowerCase()));
    for (const { repo, branch } of want) {
      const id = `${repo} ${branch}`.toLowerCase();
      if (taken.has(id)) continue;
      taken.add(id);
      if (await gh.branchHadPr(repo, branch)) continue; // it has (or had) a PR: not a branch with no PR
      const base = await gh.defaultBranch(repo);
      if (branch === base) continue;
      const vs = await gh.branchVsBase(repo, base, branch);
      if (!vs?.ahead) continue;
      const entry = { repo, branch, head: vs.head, base, defaultBranch: base, stat: { files: vs.files, additions: vs.additions, deletions: vs.deletions } };
      const theirs = !vs.authors.some(a => a && a.toLowerCase() === app.me.toLowerCase());
      const why = theirs ? `${repo} ${branch} has no commits of yours ahead of ${base}` : branchRefusal(branch, base, b().protectedBranches) && `${repo}'s ${branchRefusal(branch, base, b().protectedBranches)}`;
      if (why) {
        found.context.push({ ...entry, why });
        log('info', `${w.key}: ${why}; it is context only`);
      } else if (found.prs.some(x => x.repo === repo) || found.branches.some(x => x.repo === repo)) {
        found.context.push({ ...entry, why: 'another of your branches in the same repo is continued' });
      } else found.branches.push(entry);
    }
  }

  /**
   * The finish session: each PR and branch picked up checked out at its head (each must still be where the survey
   * found it), the ticket's other repos as for a build, and a brief to finish what is left.
   */
  async function finish(w) {
    checkStop(w);
    const s = w.survey || { prs: [], branches: [], context: [], listed: [] };
    fs.mkdirSync(w.briefDir, { recursive: true });
    let candidates = [];
    if (w.ref) {
      const data = await trackerOf(w).workItem(cfg(), w.ref);
      w.title = data.title || w.title;
      const prs = await gh.prsMentioning(cfg().githubOwner, w.key).catch(() => []);
      fs.writeFileSync(path.join(w.briefDir, 'ticket.md'), brief.ticketMd(data, { prs, trackerName: trackerOf(w).name }));
      candidates = rules.repoCandidates(ticketTexts(data), prs.map(p => p.repo));
    } else {
      fs.writeFileSync(path.join(w.briefDir, 'quick.md'), brief.quickMd(w));
      candidates = quickRepos(w.instructions);
    }
    const repos = [];
    const existing = [];
    for (const e of [...s.prs, ...s.branches]) {
      checkStop(w);
      const dir = await ensureClone(cfg(), e.repo, clone);
      const head = await fetchBranch(dir, e.branch);
      if (head !== e.head) {
        // Moved since the survey (someone pushed): look at it again, rather than build on what the survey didn't see.
        log('info', `${w.key}: ${e.repo} ${e.branch} moved since Prowl looked (${short(e.head)} → ${short(head)}); looking again`);
        Object.assign(w, { step: 'adopt', survey: null });
        touch(w);
        return undefined;
      }
      const baseSha = await fetchBranch(dir, e.base).catch(() => '');
      const worktree = path.join(worktreeRoot(cfg(), w), e.repo.split('/')[1]);
      await addWorktree(dir, worktree, head);
      repos.push({ repo: e.repo, clone: dir, worktree, defaultBranch: e.defaultBranch || await defaultBranchOf(dir), branch: e.branch, base: e.base, baseSha, mergeBase: baseSha,
        continued: { head, draft: Boolean(e.draft) }, ...(e.url && { pr: { url: e.url, number: e.number, repo: e.repo, title: e.title } }) });
      existing.push({ repo: e.repo, branch: e.branch, head, base: e.base, draft: e.draft, pr: e.url || '', stat: e.stat, worktree });
    }
    const unavailable = [];
    for (const repo of candidates.filter(r => !repos.some(x => x.repo.toLowerCase() === r.toLowerCase()))) {
      if (!rules.ownerAllowed(repo, cfg())) unavailable.push({ repo, why: "it isn't under the GitHub org or Other owners" });
      else if (repos.length >= b().maxRepos) unavailable.push({ repo, why: `over Max repos per ticket (${b().maxRepos})` });
      else {
        try {
          repos.push(await prepareRepo(cfg(), repo, path.join(worktreeRoot(cfg(), w), repo.split('/')[1]), clone));
        } catch (e) {
          unavailable.push({ repo, why: `Prowl couldn't check it out (${e.message.split('\n')[0]})` });
        }
      }
    }
    const answers = pastAnswers(readAnswers(answersPath), [w.title, w.instructions || ''].join('\n'), repos.map(r => r.repo));
    if (answers.length) fs.writeFileSync(path.join(w.briefDir, 'answers.md'), brief.answersMd(answers));
    Object.assign(w, {
      repos, sessionId: randomUUID(), sessionStarted: false, sessionCostUsd: 0, turnKind: 'finish', step: 'turn',
      prompt: brief.finishPrompt({ briefDir: w.briefDir, ticket: w, repos, existing, listed: s.listed, context: s.context, unavailable, answers: answers.length > 0, instructions: w.ref ? w.instructions || '' : '' }), // without a ticket, they are in quick.md
    });
    touch(w);
    log('info', `${w.key}: checked out ${existing.map(e => `${e.repo} ${e.branch}`).join(', ')} to finish`);
    return undefined;
  }

  /**
   * The repos a quick build's text names: GitHub links and repo: lines, owner/name, and a bare word that is a clone of
   * <GitHub org>/<word> in the Projects Directory already.
   */
  function quickRepos(text) {
    const found = rules.repoCandidates([text]);
    for (const m of String(text || '').matchAll(/(?<![\w./:-])([\w.-]+\/[\w.-]+)(?![\w/-])/g)) if (rules.ownerAllowed(m[1], cfg())) found.push(m[1]);
    for (const word of String(text || '').split(/[\s,;:()"'`]+/)) {
      if (/^[\w.-]{2,}$/.test(word) && cfg().githubOwner && fs.existsSync(path.join(cfg().workDir, word, '.git'))) found.push(`${cfg().githubOwner}/${word}`);
    }
    const seen = new Set();
    return found.filter(r => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
  }

  // ---- Reading the ticket and starting the session ----

  async function read(w) {
    if (!w.ref) return readQuick(w);
    const tracker = trackerOf(w);
    const data = await tracker.workItem(cfg(), w.ref);
    w.title = data.title || w.title;
    const prs = await gh.prsMentioning(cfg().githubOwner, w.key).catch(() => []);
    const candidates = rules.repoCandidates(ticketTexts(data), prs.map(p => p.repo));
    fs.mkdirSync(w.briefDir, { recursive: true });
    fs.writeFileSync(path.join(w.briefDir, 'ticket.md'), brief.ticketMd(data, { prs, trackerName: tracker.name }));
    return prepareBuild(w, candidates, [data.title, data.description, data.acceptanceCriteria].join('\n'));
  }

  /** A quick build without a ticket: quick.md from the user's text, and the repos it names (or none: the session asks). */
  async function readQuick(w) {
    fs.mkdirSync(w.briefDir, { recursive: true });
    fs.writeFileSync(path.join(w.briefDir, 'quick.md'), brief.quickMd(w));
    return prepareBuild(w, quickRepos(w.instructions), [w.title, w.instructions].join('\n'));
  }

  /** Checks out `candidates` for a build, and briefs its session. `about`: the text past answers are matched on. */
  async function prepareBuild(w, candidates, about) {
    const unavailable = [];
    const repos = [];
    for (const repo of candidates) {
      if (!rules.ownerAllowed(repo, cfg())) unavailable.push({ repo, why: "it isn't under the GitHub org or Other owners" });
      else if (repos.length >= b().maxRepos) unavailable.push({ repo, why: `over Max repos per ticket (${b().maxRepos})` });
      else {
        try {
          repos.push(await prepareRepo(cfg(), repo, path.join(worktreeRoot(cfg(), w), repo.split('/')[1]), clone));
        } catch (e) {
          unavailable.push({ repo, why: `Prowl couldn't check it out (${e.message.split('\n')[0]})` });
        }
      }
    }
    const answers = pastAnswers(readAnswers(answersPath), about, repos.map(r => r.repo));
    if (answers.length) fs.writeFileSync(path.join(w.briefDir, 'answers.md'), brief.answersMd(answers));
    Object.assign(w, {
      repos, sessionId: randomUUID(), sessionStarted: false, sessionCostUsd: 0, turnKind: 'build', step: 'turn',
      prompt: brief.buildPrompt({ briefDir: w.briefDir, ticket: w, repos, unavailable, answers: answers.length > 0, instructions: w.ref ? w.instructions || '' : '' }),
    });
    touch(w);
    log('info', `${w.key}: ${w.ref ? 'read the ticket' : 'read what to build'}; ${repos.length ? `checked out ${repos.map(r => r.repo).join(', ')}` : 'no repo found yet'}`);
  }

  /**
   * What `w`'s next turn may spend: what's left of the tightest cap, the session's, the ticket's and the day's
   * ({ budget }, 0 = no cap); or why it may not run ({ why }), and whether that's only for now ({ why, wait }).
   */
  function room(w) {
    const c = b();
    const spent = rules.ticketSpend(records(), w.key);
    const today = rules.daySpend(records());
    if (rules.spendLevel(spent, c.ticketBudgetUsd) === 'over') return { why: `Spend cap per ticket reached ($${c.ticketBudgetUsd}): no more sessions for ${w.key}.` };
    if (rules.spendLevel(today, c.dailyBudgetUsd) === 'over') return { why: `Spend cap per day reached ($${c.dailyBudgetUsd}): no more sessions today.` };
    if (c.maxBudgetUsd > 0 && c.maxBudgetUsd - (w.sessionCostUsd || 0) <= 0) return { why: `The session for ${w.key} reached its spend cap ($${c.maxBudgetUsd}).` };
    // Turns still running may yet spend what they were given: the day's cap holds that back, and this turn waits for it.
    const running = records().filter(r => r !== w && r.status === 'active' && ['session', 'settle'].includes(r.step)).reduce((n, r) => n + (r.turnBudgetUsd || 0), 0);
    if (c.dailyBudgetUsd > 0 && running > 0 && today + running >= c.dailyBudgetUsd) return { wait: true, why: `the turns running now may spend the rest of today's cap ($${c.dailyBudgetUsd})` };
    const left = [[c.maxBudgetUsd, w.sessionCostUsd || 0], [c.ticketBudgetUsd, spent], [c.dailyBudgetUsd, today + running]].filter(([cap]) => cap > 0).map(([cap, used]) => cap - used);
    return { budget: left.length ? Math.min(...left) : 0 };
  }

  /** Starts the next turn of `w`'s session, unless a cap holds it. */
  async function turn(w) {
    checkStop(w);
    const { why, wait, budget } = room(w);
    if (wait) {
      w._retryAt = Date.now() + 60_000;
      return log('info', `${w.key}: waiting: ${why}`, `work:${w.uid}`);
    }
    if (why) throw new NeedsYou('cap', why, { retry: 'turn' });
    w.turnBudgetUsd = budget;
    session.start(cfg(), appDir, w, w.prompt, budget);
    w.turns.push({ startedAt: w.startedAt, kind: w.turnKind, logPath: w.logPath, costUsd: 0 });
    w.step = 'session';
    touch(w);
    log('ok', `${w.key}: ${w.turnKind === 'round' ? `feedback round ${w.rounds}` : 'build'} session turn ${w.turns.length} started`);
  }

  /** Settles a turn whose session has ended: cost and caps, then what its result.json asks for. */
  async function settle(w) {
    const r = w._result;
    const cost = r?.total_cost_usd || 0;
    const t = w.turns.at(-1);
    if (t && t.endedAt == null) { // once per turn, even if this step runs again after a restart
      Object.assign(t, { endedAt: Date.now(), costUsd: cost });
      w.costUsd = (w.costUsd || 0) + cost;
      w.sessionCostUsd = (w.sessionCostUsd || 0) + cost;
    }
    touch(w);
    checkStop(w);
    const capped = w.capped || capHit(r, { maxBudgetUsd: w.turnBudgetUsd || b().maxBudgetUsd, maxTurns: b().maxTurns });
    if (capped) throw new NeedsYou('cap', `The session for ${w.key} stopped: ${capped}. It isn't retried.`, { retry: 'continue' });
    const file = path.join(w.briefDir, 'result.json');
    const result = readJson(file);
    const why = w.spawnError || (!result ? (fs.existsSync(file) ? 'it is not valid JSON' : 'it wrote no result.json')
      : w.turnKind === 'round' ? validateFeedback(result) : rules.validateBuild(result, w.briefDir));
    if (why) {
      if (w.invalidAsked) throw new NeedsYou('failed', `The session for ${w.key} ended without a usable result twice: ${why}.`, { retry: 'continue' });
      w.invalidAsked = true;
      log('warn', `${w.key}: the session's result is unusable (${why}); asking it once more`);
      return next(w, 'turn', brief.resume.invalid(why));
    }
    w.invalidAsked = false;
    w.result = result;
    if (result.summary) w.summary = result.summary;
    return w.turnKind === 'round' ? settleRound(w, result) : settleBuild(w, result);
  }

  function next(w, stepName, prompt) {
    Object.assign(w, { step: stepName, status: 'active', _retryAt: 0, ...(prompt != null && { prompt }) });
    touch(w);
  }

  function settleBuild(w, r) {
    if (r.plan) w.plan = path.resolve(w.briefDir, r.plan);
    if (r.investigation) w.investigation = path.resolve(w.briefDir, r.investigation);
    if (r.status === 'needs-repos') { w.requested = r.repos; return next(w, 'repos'); }
    if (r.status === 'question') {
      const q = r.question;
      return raise(w, 'question', q.question, { qid: q.id, options: q.options || [], recommended: q.default || '', multiple: q.multiple, context: q.context || [] });
    }
    if (r.status === 'blocked') return raise(w, 'blocked', `The session is blocked: ${r.reason}`, { qid: 'blocked' });
    if (r.status === 'needs-approval') {
      w.changes = r.changes || [];
      const open = r.openQuestions || [];
      for (const q of open) raise(w, 'question', q.question, { qid: q.id, options: q.options || [], recommended: q.default || '', multiple: q.multiple, blocked: 'the plan waits for your answer' });
      if (open.length) return undefined;
      if (b().approvePlans === 'ask') return raise(w, 'plan', `Approve the plan for ${w.key}? enter with nothing typed approves it; a typed note sends it back.`, { context: [w.plan] });
      return next(w, 'approve');
    }
    return next(w, 'publish'); // done
  }

  // ---- More repos, approval and branches ----

  async function repos(w) {
    const pending = [];
    for (const { repo, why } of w.requested || []) {
      if (w.repos.some(r => r.repo.toLowerCase() === repo.toLowerCase())) { w.collected.ready.push(w.repos.find(r => r.repo.toLowerCase() === repo.toLowerCase())); continue; }
      if (!rules.ownerAllowed(repo, cfg()) || w.repos.length >= b().maxRepos) {
        const over = rules.ownerAllowed(repo, cfg()) ? `it would go over Max repos per ticket (${b().maxRepos})` : "it isn't under the GitHub org or Other owners";
        pending.push({ repo, question: `The session for ${w.key} asks for ${repo}${why ? ` (${why})` : ''}, but ${over}. What should it do instead?` });
        continue;
      }
      try {
        const r = await prepareRepo(cfg(), repo, path.join(worktreeRoot(cfg(), w), repo.split('/')[1]), clone);
        w.repos.push(r);
        w.collected.ready.push(r);
      } catch (e) {
        w.collected.unavailable.push({ repo, why: `Prowl couldn't check it out (${e.message.split('\n')[0]})` });
      }
    }
    w.requested = [];
    for (const p of pending) raise(w, 'repos', p.question, { repo: p.repo });
    if (!pending.length) resumeWithCollected(w);
    else touch(w);
  }

  /** Resumes the session with everything collected from Needs you: repos, then answers. */
  function resumeWithCollected(w) {
    const { ready = [], unavailable = [], answers = [] } = w.collected;
    const parts = [];
    if (ready.length || unavailable.length) parts.push(brief.resume.repos(ready, unavailable));
    if (answers.length) parts.push(brief.resume.answers(answers));
    w.collected = { answers: [], ready: [], unavailable: [] };
    next(w, 'turn', parts.join('\n\n') || brief.resume.continue(''));
  }

  /** Whether `sha` is a commit Prowl pushed for some ticket, so a rebuild may step past the branch it is on. */
  const pushedByProwl = sha => records().some(r => r.repos?.some(x => x.pushedSha === sha));

  async function approve(w) {
    checkStop(w);
    const wanted = w.changes?.length ? w.changes : w.repos.map(r => ({ repo: r.repo }));
    const branches = [];
    for (const change of wanted) {
      const rec = w.repos.find(r => r.repo.toLowerCase() === change.repo.toLowerCase());
      if (!rec) throw new NeedsYou('conflict', `The plan changes ${change.repo}, which isn't checked out for ${w.key}.`, { retry: 'approve' });
      if (rec.continued) { branches.push(rec); continue; } // your branch, continued where it is
      if (rec.branch && (await git(rec.worktree, 'symbolic-ref', '--short', 'HEAD').catch(() => '')).trim() === rec.branch) { branches.push(rec); continue; }
      const remote = await remoteBranches(rec.clone);
      const pick = rules.pickBase(b().base, rec.repo, { planBase: change.base, remote, defaultBranch: rec.defaultBranch });
      if (pick.error) throw new NeedsYou('conflict', `${w.key}: ${pick.error}.`, { retry: 'approve' });
      const baseSha = await fetchBranch(rec.clone, pick.base);
      let branch = '';
      for (let n = 1; !branch; n++) {
        const name = w.ref ? rules.branchName(b().branchTemplate, w.key, w.title, n) : rules.branchName(b().quickBranchTemplate || 'prowl/{slug}', '', w.title, n);
        if (await succeeds(rec.clone, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`)) continue; // a kept local branch: never touched
        const there = remote.includes(name) ? await remoteSha(rec.clone, name) : '';
        if (there && pushedByProwl(there)) continue;
        if (there) throw new NeedsYou('conflict', `${rec.repo} already has a branch ${name} on its remote, with commits Prowl didn't make.`, { retry: 'approve' });
        branch = name;
      }
      const refused = branchRefusal(branch, rec.defaultBranch, b().protectedBranches);
      if (refused) throw new NeedsYou('guard', `Prowl won't build on ${rec.repo}'s ${refused}: change Branch names.`, { retry: 'approve' });
      await git(rec.worktree, 'checkout', '--force', '-b', branch, baseSha);
      Object.assign(rec, { base: pick.base, baseSha, branch });
      branches.push(rec);
      touch(w);
    }
    log('ok', `${w.key}: plan approved; building on ${branches.map(r => `${r.repo} ${r.branch} (from ${r.base})`).join(', ')}`);
    next(w, 'turn', brief.resume.approve(branches));
  }

  // ---- Checks, guards and publishing ----

  /** Runs checks.json and the guards on each repo; throws or resumes the session on a failure. Resolves true when all pass. */
  async function checkAll(w, recs, { base, expected, onBranch }) {
    const failures = [];
    let checks;
    try {
      checks = readChecks();
    } catch (e) {
      throw new NeedsYou('checks', `${e.message}. Fix it (Config, Checks before push), then enter checks again.`, { retry: w.step }); // never push unchecked: enter runs this step again
    }
    for (const rec of recs) {
      const spec = matchChecks(checks, rec.repo);
      if (spec) {
        const res = await runChecks(spec, rec.worktree);
        if (!res.ok) failures.push({ repo: rec.repo, command: res.command, output: res.tail });
      }
    }
    if (failures.length) {
      w.checkFails = (w.checkFails || 0) + 1;
      if (w.checkFails > 1) throw new NeedsYou('checks', `Checks still fail for ${w.key} after one more turn: ${failures.map(f => `${f.repo}: ${f.command}`).join('; ')}.`, { retry: 'continue' });
      log('warn', `${w.key}: ${failures.map(f => `${f.repo}: \`${f.command}\` failed`).join('; ')}; one more session turn`);
      next(w, 'turn', brief.resume.checksFailed(failures.map(f => ({ ...f, output: String(f.output).slice(-TAIL) }))));
      return false;
    }
    for (const rec of recs) {
      const head = (await git(rec.worktree, 'rev-parse', 'HEAD')).trim();
      const failed = guardFailures({
        base: base(rec), head, remote: await remoteSha(rec.worktree, rec.branch), expected: expected(rec),
        ancestor: await succeeds(rec.worktree, 'merge-base', '--is-ancestor', base(rec), 'HEAD'),
        onBranch: (typeof onBranch === 'function' ? onBranch(rec) : onBranch) ? (await git(rec.worktree, 'symbolic-ref', '--short', 'HEAD').catch(() => '')).trim() === rec.branch : true,
        // With the base merged in, only the session's own changes count: not what the merge brought from the base.
        numstat: rec.mergeBase ? await ownNumstat(rec.worktree, base(rec), rec.mergeBase)
          : await git(rec.worktree, 'diff', '--numstat', '-z', `${base(rec)}..HEAD`), // -z: paths unquoted
        // Every commit pushed, not just the end state, and what a merge adds itself (--cc: a conflict's resolution).
        diff: await git(rec.worktree, 'log', '-p', '--cc', '-U0', '--format=', `${base(rec)}..HEAD`, ...(rec.mergeBase ? [`^${rec.mergeBase}`] : [])),
      }, b());
      if (failed[0]?.kind === 'moved') return { moved: `${rec.repo}: ${failed[0].text}` };
      if (failed.length) throw new NeedsYou('guard', `Prowl didn't push ${w.key} to ${rec.repo}: ${failed.map(x => x.text).join('; ')}.`, { retry: 'continue' });
    }
    return true;
  }

  /**
   * Checks, pushes and opens the PRs, then hands off. A branch picked up (`continued`) is pushed on top of the head the
   * survey found, which it must still be at; a PR picked up gets no new PR, a branch picked up gets one opened, and a
   * draft picked up is marked ready unless Open PRs as drafts is on. A finish session with nothing to add (complete)
   * only hands off.
   */
  async function publish(w) {
    checkStop(w);
    const committed = r => (w.result?.commits || []).some(c => c.repo.toLowerCase() === r.repo.toLowerCase());
    const recs = w.repos.filter(r => r.branch && (committed(r) || r.continued));
    if (!recs.some(committed) && !(w.result?.status === 'complete' && recs.length)) {
      throw new NeedsYou('failed', `The session for ${w.key} said it was done, but none of its commits are on Prowl's branches.`, { retry: 'continue' });
    }
    const todo = recs.filter(r => !r.handedOver);
    const pushing = todo.filter(committed);
    const ok = await checkAll(w, pushing, { base: r => (r.continued ? r.continued.head : r.baseSha), expected: r => r.pushedSha || (r.continued ? r.continued.head : ''), onBranch: r => !r.continued });
    if (ok === false) return undefined;
    if (ok.moved) throw new NeedsYou('conflict', `Prowl didn't push ${w.key}: ${ok.moved}.`, { retry: 'publish' });
    for (const rec of pushing) {
      checkStop(w);
      const refused = branchRefusal(rec.branch, rec.defaultBranch, b().protectedBranches);
      if (refused) throw new NeedsYou('guard', `Prowl won't push to ${rec.repo}'s ${refused}.`, { retry: 'publish' });
      const head = (await git(rec.worktree, 'rev-parse', 'HEAD')).trim();
      if (rec.pushedSha !== head) {
        await ensureClone(cfg(), rec.repo, clone); // its push URL still leads to the repo
        await push(rec.worktree, rec.branch); // never forced
        rec.pushedSha = head;
        touch(w);
        log('ok', `${w.key}: pushed ${short(head)} to ${rec.repo} ${rec.branch}`);
      }
    }
    for (const rec of todo) {
      checkStop(w);
      if (!rec.pr) {
        const spec = (w.result?.prs || []).find(p => p.repo.toLowerCase() === rec.repo.toLowerCase()) || {};
        const title = !w.ref ? spec.title || w.title : mentions(spec.title, w.key) ? spec.title : `${w.key}: ${spec.title || w.title}`;
        const file = path.join(w.briefDir, `pr-${rec.repo.split('/')[1]}.json`);
        writeJson(file, { title, head: rec.branch, base: rec.base, body: spec.body || (w.ref ? w.key : ''), draft: Boolean(b().draftPrs) });
        // A retry first looks for the PR an earlier create opened before its answer was lost.
        const opened = await gh.prForBranch(rec.repo, rec.branch);
        if (!opened) checkStop(w);
        rec.pr = { ...(opened || (await gh.createPr(rec.repo, file))), repo: rec.repo, title };
        Object.assign(rec, { prBody: spec.body || (w.ref ? w.key : ''), opened: true });
        touch(w);
        log('ok', `${w.key}: opened ${rec.pr.url}`);
      }
      if (rec.continued?.draft && !b().draftPrs && !rec.readied) {
        await gh.markReady(rec.pr);
        rec.readied = true;
        log('ok', `${w.key}: marked ${prName(rec.pr)} ready for review`);
      }
      rec.handedOver = true;
      touch(w);
    }
    // The PRs Prowl opened list the others; a PR you opened keeps its description.
    if (recs.length > 1 && recs.some(r => r.opened) && !w.linked) {
      for (const rec of recs.filter(r => r.opened)) {
        checkStop(w); // before each PR write
        const others = recs.filter(r => r !== rec).map(r => `- ${r.pr.url}`);
        const file = path.join(w.briefDir, `pr-${rec.repo.split('/')[1]}.json`);
        writeJson(file, { body: `${rec.prBody}\n\n---\n\nThe other PRs for ${w.key}:\n\n${others.join('\n')}`.trimStart() });
        await gh.editPr(rec.pr, file);
      }
      w.linked = true;
      touch(w);
    }
    checkStop(w);
    const prs = recs.map(r => ({ repo: r.repo, number: r.pr.number, url: r.pr.url, title: r.pr.title }));
    const handedOff = await handOff(w, prs); // feedback from then on counts, even when a retry finishes the handoff later
    Object.assign(w, {
      prs, prsOpenedAt: Date.now(), lastActivityAt: handedOff, lastPushAt: Date.now(),
      status: b().followUp ? 'following' : 'done', step: null, checkFails: 0, ...(!b().followUp && { endedAt: Date.now(), note: 'PRs opened' }),
    });
    touch(w);
    log('ok', `${w.key}: ${w.prs.length} PR${w.prs.length > 1 ? 's' : ''} open, ${marked(w)}`);
    hoot(recs.some(r => r.opened) ? `Opened ${w.prs.length > 1 ? `${w.prs.length} PRs` : 'a PR'} for ${w.title}` : `Handed ${w.title} on for review`, 'cheer');
    notifyIf(`Prowl: PRs open for ${w.key}`, w.title);
    await tidy(w, w.repos);
    return undefined;
  }

  /**
   * Removes `w`'s build worktrees, and the branches Prowl made there unless they hold commits that were never pushed.
   * A round's worktrees (`rounds`) are detached at a PR's head and made no branch, so no branch is ever deleted for them.
   */
  async function tidy(w, recs, rounds = []) {
    for (const p of rounds) await removeWorktree(p.clone, p.worktree).catch(() => {});
    for (const rec of recs) {
      if (rec.continued) { await removeWorktree(rec.clone, rec.worktree).catch(() => {}); continue; } // detached at your branch: no branch of Prowl's
      let keep = false;
      if (rec.branch && fs.existsSync(rec.worktree)) {
        const head = (await git(rec.worktree, 'rev-parse', 'HEAD').catch(() => '')).trim();
        keep = Boolean(head) && head !== rec.baseSha && head !== rec.pushedSha;
      }
      await removeWorktree(rec.clone, rec.worktree, rec.branch && !keep ? rec.branch : '').catch(() => {});
      if (keep) log('info', `${w.key}: kept the branch ${rec.branch} in ${rec.clone}: its commits were never pushed`);
    }
  }

  // ---- Following the PRs ----

  /** The followed PRs with feedback newer than the last push or round (none without `feedback`). Merged and closed PRs stop being followed. */
  async function dueFeedback(w, feedback = true) {
    const due = [];
    for (const pr of [...w.prs]) {
      const facts = await gh.prFacts(pr);
      if (facts.state !== 'OPEN') {
        w.prs = w.prs.filter(p => p.url !== pr.url);
        log('info', `${w.key}: ${prName(pr)} is ${facts.state.toLowerCase()}; no longer following it`);
        continue;
      }
      if (!feedback || prRefusal(facts, pr, app.me, b().protectedBranches, { drafts: pickup().drafts })) continue; // others' PRs and forks (and drafts, unless picked up) get no round
      const [reviews, threads] = await Promise.all([gh.prReviews(pr), gh.prThreads(pr)]);
      if (rules.feedbackDue({ reviews, threads }, w.lastActivityAt || 0, b().fixFrom)) due.push(pr);
    }
    return due;
  }

  /** Once per poll: rounds for followed tickets with new feedback, merged PRs, and Ready to merge. */
  async function follow() {
    for (const w of records().filter(r => r.status === 'following' && !r.step && !r._busy)) {
      if (!b().followUp) continue;
      try {
        // A review asked for or under way finishes first, and so does work someone else claimed (In Development).
        // (Tags compare without case or punctuation, so Jira's Ready-for-Review matches.) Without a ticket: its PRs' labels.
        const held = byLabels(w) ? [] : (await trackerOf(w).readItem(cfg(), w.ref)).tags;
        const waiting = byLabels(w) ? Boolean(await labelHold(w)) : [cfg().tags.trigger, cfg().tags.inProgress, b().tags.inProgress].some(t => tags().has(held, t));
        const due = await dueFeedback(w, !waiting); // waiting, it still notices merged and closed PRs
        if (w.status !== 'following' || w.step) continue; // stopped following (t) while this looked
        if (!w.prs.length) {
          Object.assign(w, { status: 'done', endedAt: Date.now(), note: 'its PRs are merged or closed' });
          touch(w);
          log('ok', `${w.key}: its PRs are merged or closed; Prowl stops following it`);
          continue;
        }
        if (due.length && app.dryRun()) {
          log('info', `${w.key}: would start a feedback round on ${due.map(prName).join(', ')} (dry run)`, `follow:${w.uid}`);
          continue;
        }
        if (due.length) {
          w.roundPrs = due;
          w.step = 'round';
          touch(w);
          continue;
        }
        await readiness(w);
      } catch (e) {
        log('warn', `${w.key}: couldn't check its PRs (${e.message})`, `follow:${w.uid}`);
      }
    }
  }

  async function readiness(w) {
    const prs = [];
    for (const pr of w.prs) {
      const [reviews, threads, checks] = await Promise.all([gh.prReviews(pr), gh.prThreads(pr), gh.requiredChecks(pr.url)]);
      prs.push({ reviews, threads, checks });
    }
    const ready = rules.mergeReady(prs, w.lastPushAt || 0);
    if (ready && !w.ready) {
      w.ready = true;
      touch(w);
      log('ok', `${w.key}: ready to merge: approved, no open threads, checks green`);
      hoot(`${w.title} is ready to merge`, 'cheer');
      notifyIf('Prowl: ready to merge', `${w.key} ${w.title}`);
    } else if (!ready && w.ready) {
      w.ready = false;
      touch(w);
    }
  }

  /** Starts a feedback round: claims the ticket again, checks out each PR at its head, and briefs a fresh session. */
  async function round(w) {
    checkStop(w);
    const tracker = trackerOf(w);
    const back = why => {
      Object.assign(w, { step: null, status: 'following' });
      touch(w);
      return log('warn', `${w.key}: round not started, ${why}`);
    };
    if (!w.roundClaimed && byLabels(w)) {
      const held = await labelHold(w, w.roundPrs || w.prs);
      if (held) return back(held);
      if (!on() && !w.finishAfterRound) return back('the Builder is off');
      labelPrs(w, w.roundPrs || w.prs, b().tags.inProgress);
      w.roundClaimed = true;
      touch(w);
    }
    if (!w.roundClaimed) {
      const ticket = await tracker.readItem(cfg(), w.ref);
      // Read again now: a review or someone else's claim since follow() looked waits for its turn.
      const waiting = [cfg().tags.trigger, cfg().tags.inProgress, b().tags.inProgress].find(t => tags().has(ticket.tags, t));
      if (waiting) return back(`the ticket carries '${waiting}' now`);
      try {
        await tracker.claim(cfg(), ticket, tags().owned, b().tags.inProgress);
      } catch (e) {
        if (e.lost) return back(`the ticket changed or someone else claimed it (${e.message})`);
        return unsure(w, ticket, e, 'round');
      }
      if (!on()) {
        Object.assign(w, { status: 'following', step: null });
        return release(w, ticket);
      }
      w.roundClaimed = true; // ours until the round ends: a retry of this step doesn't claim it again
      touch(w);
    }
    Object.assign(w, { status: 'active', claimedRoundAt: Date.now() });
    if (w.rounds >= b().maxRounds) throw new NeedsYou('cap', `Feedback rounds per ticket reached (${b().maxRounds}) for ${w.key}: fix the rest yourself, or raise the cap.`, { retry: 'round' });
    if (rules.spendLevel(rules.ticketSpend(records(), w.key), b().ticketBudgetUsd) === 'over') throw new NeedsYou('cap', `Spend cap per ticket reached ($${b().ticketBudgetUsd}) for ${w.key}.`, { retry: 'round' });
    const n = w.rounds + 1; // counted once the round is ready to start, so a retry doesn't count it twice
    const prs = [];
    const answersText = [];
    const collectedAt = Date.now(); // feedback after this is the next round's
    // Which PRs are due, read again now (a retry can come minutes after follow() looked): the round ends with every PR's feedback collected.
    // At pick-up, a PR's failing checks and conflicts are due too.
    w.roundPrs = await dueFeedback(w);
    for (const p of w.prs) if (w.pickupFix?.[p.url] && !w.roundPrs.some(x => x.url === p.url)) w.roundPrs.push(p);
    for (const pr of w.roundPrs) {
      const facts = await gh.prFacts(pr);
      if (facts.state !== 'OPEN' || prRefusal(facts, pr, app.me, b().protectedBranches, { drafts: pickup().drafts })) continue;
      const dir = await ensureClone(cfg(), pr.repo, clone);
      const sha = await fetchBranch(dir, facts.headBranch);
      // The base too: a session may merge it in (never rebase), and what that brings doesn't count against Max lines per push.
      const baseSha = await fetchBranch(dir, facts.base).catch(() => '');
      const worktree = path.join(worktreeRoot(cfg(), w), `${pr.repo.split('/')[1]}-${pr.number}`);
      await addWorktree(dir, worktree, sha);
      const fix = w.pickupFix?.[pr.url];
      const failing = [];
      for (const c of fix?.failing || []) failing.push({ ...c, log: await gh.failedLog(c.link).catch(() => '') });
      const details = await gh.detailsFromGitHub(pr).catch(() => '');
      const threads = actionable(await gh.prThreads(pr), b().fixFrom, parkedUrls(details));
      const reviews = (await gh.prReviews(pr)).filter(r => r.state === 'CHANGES_REQUESTED' && (Date.parse(r.at) || 0) > (w.lastActivityAt || 0));
      answersText.push(details, ...threads.map(t => t.body), ...reviews.map(r => r.body));
      prs.push({ pr, repo: pr.repo, number: pr.number, url: pr.url, title: pr.title, branch: facts.headBranch, headSha: sha, worktree, clone: dir, details: stripParked(details), reviews, threads,
        defaultBranch: facts.defaultBranch, mergeBase: baseSha, failing, ...(fix?.conflict && baseSha && { conflict: { base: facts.base, baseSha } }) });
    }
    if (!prs.length) {
      Object.assign(w, { status: w.finishAfterRound ? 'active' : 'following', step: 'end-round', roundClaimed: false });
      touch(w);
      return undefined;
    }
    const answers = pastAnswers(readAnswers(answersPath), answersText.join('\n'), prs.map(p => p.repo));
    fs.mkdirSync(w.briefDir, { recursive: true });
    const feedbackPath = path.join(w.briefDir, `feedback-${n}.md`);
    fs.writeFileSync(feedbackPath, brief.feedbackMd({ ticket: w, round: n, maxRounds: b().maxRounds, prs, answers }));
    w.rounds = n;
    w.round = {
      n, startedAt: Date.now(), collectedAt, feedbackPath,
      prs: prs.map(p => ({ repo: p.repo, number: p.number, url: p.url, title: p.title, branch: p.branch, headSha: p.headSha, worktree: p.worktree, clone: p.clone,
        defaultBranch: p.defaultBranch, mergeBase: p.mergeBase, threads: p.threads.map(t => ({ id: t.id, commentId: t.commentId, url: t.url })) })),
    };
    Object.assign(w, { sessionId: randomUUID(), sessionStarted: false, sessionCostUsd: 0, turnKind: 'round', checkFails: 0, ciFails: 0, invalidAsked: false, roundClaimed: false });
    log('ok', `${w.key}: feedback round ${w.rounds} on ${prs.map(p => prName(p)).join(', ')}`);
    return next(w, 'turn', brief.feedbackPrompt({ briefDir: w.briefDir, feedbackPath }));
  }

  function settleRound(w, r) {
    const questions = r.questions || [];
    if (questions.length) {
      questions.forEach((q, i) => raise(w, 'question', q.text, {
        qid: `Q${i + 1}`, context: String(q.context || '').split('\n').filter(Boolean), options: q.options || [], recommended: q.recommended || '', multiple: q.multiple, searched: q.searched,
        blocked: `feedback round ${w.rounds} waits for your answer`,
      }));
      return undefined;
    }
    if (r.status === 'blocked' && !(r.commits || []).length && !r.items.some(it => it.action === 'dispute')) {
      return raise(w, 'blocked', `Feedback round ${w.rounds} on ${w.key} is blocked: ${r.summary || 'no reason given'}`, { qid: 'blocked' });
    }
    return next(w, 'push-round');
  }

  const forPr = (it, p) => [p.url, `${p.repo}#${p.number}`].some(x => String(it.pr || '').toLowerCase() === x.toLowerCase());

  /** Checks, guards, pushes and replies for a round. A branch that moved since the round started drops the round. */
  async function pushRound(w) {
    checkStop(w);
    // Its feedback stays due (lastActivityAt as it was): the next round starts from the new head.
    const drop = async why => {
      if (byLabels(w)) labelPrs(w, w.round.prs, '');
      else await trackerOf(w).retag(cfg(), w.ref, tags().owned, '');
      await tidy(w, [], w.round.prs);
      Object.assign(w, { status: 'following', step: null, round: null, roundPrs: [] });
      touch(w);
      return log('warn', `${w.key}: round ${w.rounds} dropped, nothing pushed: ${why}`);
    };
    const changed = [];
    for (const p of w.round.prs) {
      if ((await git(p.worktree, 'rev-parse', 'HEAD')).trim() !== (p.pushedSha || p.headSha)) changed.push(p);
      else {
        // No commit here, but a dispute written against a head that has since moved is stale too.
        const remote = await remoteSha(p.worktree, p.branch);
        if (remote !== (p.pushedSha || p.headSha)) return drop(`${p.repo}: the remote branch ${remote ? `moved to ${short(remote)}` : 'was deleted'} since ${short(p.pushedSha || p.headSha)}`);
      }
    }
    if (changed.length) {
      const ok = await checkAll(w, changed, { base: p => p.headSha, expected: p => p.pushedSha || p.headSha, onBranch: false });
      if (ok === false) return undefined;
      if (ok.moved) return drop(ok.moved);
      for (const p of changed) {
        checkStop(w);
        const refused = branchRefusal(p.branch, p.defaultBranch, b().protectedBranches);
        if (refused) throw new NeedsYou('guard', `Prowl won't push to ${p.repo}'s ${refused}.`);
        const head = (await git(p.worktree, 'rev-parse', 'HEAD')).trim();
        try {
          await ensureClone(cfg(), p.repo, clone); // its push URL still leads to the repo
        } catch (e) {
          throw new NeedsYou('guard', `Prowl didn't push ${w.key} to ${prName(p)}: ${e.message}.`, { retry: 'push-round' });
        }
        try {
          await push(p.worktree, p.branch); // never forced
        } catch (e) {
          const now = await remoteSha(p.worktree, p.branch).catch(() => null);
          if (now === null || now === (p.pushedSha || p.headSha)) throw e; // not a moved branch: retried in a minute
          return drop(`the push to ${prName(p)} was rejected (${e.message.split('\n')[0]})`);
        }
        p.pushedSha = head;
        w.lastPushAt = Date.now();
        const surveyed = w.survey?.prs.find(x => x.url === p.url);
        if (surveyed) surveyed.head = head; // the finish session that follows a pick-up's round starts from here
        touch(w);
        log('ok', `${w.key}: pushed ${short(head)} to ${prName(p)}`);
      }
    }
    // One reply per thread fixed (once pushed) or disputed, each marked so a restart never posts it twice. Never resolved.
    const tpl = heading => outputTemplate(appDir, heading);
    for (const p of w.round.prs) {
      const items = (w.result.items || []).filter(it => forPr(it, p) || (w.round.prs.length === 1 && !it.pr));
      // The round in each marker is record.round, so following a ticket again never matches an old reply, nor one of Fix my PRs (r1).
      const round = `${w.n}.${w.rounds}`;
      const todo = items.length ? repliesToPost({ ticket: w.key, round, items, threads: p.threads, pushed: p.pushedSha }, await gh.prCommentBodies(p)) : [];
      for (const r of todo) {
        checkStop(w);
        const body = `${fill(tpl(r.what === 'fixed' ? 'Fix reply' : 'Dispute reply'), { 'comment prefix': tpl('Comment prefix'), sha: short(p.pushedSha), note: r.note })}\n${r.marker}`;
        const file = path.join(w.briefDir, `reply-${r.thread.replace(/[^\w-]/g, '')}.json`);
        writeJson(file, { body });
        await gh.postReply(p, r.commentId, file);
      }
    }
    const pushed = w.round.prs.some(p => p.pushedSha);
    if (pushed && b().waitForChecksMinutes > 0) {
      Object.assign(w, { step: 'ci', ciSince: Date.now() });
      touch(w);
      return undefined;
    }
    return next(w, 'end-round');
  }

  /** About once a minute after a round's push: the required checks. Green (or the wait running out) ends the round. */
  async function ci(w) {
    w._retryAt = Date.now() + 60_000;
    const failing = [];
    let pending = false;
    for (const p of w.round.prs.filter(x => x.pushedSha)) {
      const checks = await gh.requiredChecks(p.url);
      const state = github.checksState(checks);
      if (state === 'failing') failing.push({ p, bad: checks.filter(c => ['fail', 'cancel'].includes(c.bucket)) });
      else if (state === 'pending' || (!checks.length && Date.now() - w.lastPushAt < 10 * 60_000)) pending = true;
    }
    if (failing.length) {
      w.ciFails = (w.ciFails || 0) + 1;
      if (w.ciFails > 1) throw new NeedsYou('checks', `Required checks still fail on ${failing.map(f => prName(f.p)).join(', ')} after one more turn.`, { retry: 'ci' });
      const out = [];
      for (const f of failing) out.push({ repo: prName(f.p), command: f.bad.map(c => `${c.name} (${c.link || 'no link'})`).join(', '), output: await gh.failedLog(f.bad[0]?.link) });
      log('warn', `${w.key}: required checks failed on ${failing.map(f => prName(f.p)).join(', ')}; one more session turn`);
      return next(w, 'turn', brief.resume.checksFailed(out));
    }
    if (pending && Date.now() - w.ciSince < b().waitForChecksMinutes * 60_000) return undefined;
    return next(w, 'end-round');
  }

  /** Ends a round (or an adoption): back to the done tag, and the round's worktrees go. */
  async function endRound(w) {
    checkStop(w);
    if (w.finishAfterRound) {
      // A pick-up's fix round: a finish session comes next, and hands off once it is done.
      if (w.round) await tidy(w, [], w.round.prs);
      Object.assign(w, { finishAfterRound: false, pickupFix: null, round: null, roundPrs: [], roundClaimed: false, lastActivityAt: w.round?.collectedAt || Date.now() });
      log('ok', `${w.key}: fix round ${w.rounds} done; a session finishes the rest`);
      return next(w, 'finish');
    }
    const handedOff = await handOff(w);
    if (w.round) await tidy(w, [], w.round.prs);
    // Feedback since the round collected its own (posted during its session or CI wait, say), or since the handoff, is still due.
    Object.assign(w, { status: 'following', step: null, lastActivityAt: w.round?.collectedAt || handedOff, round: null, roundPrs: [] });
    touch(w);
    log('ok', `${w.key}: ${marked(w)}${w.rounds ? ` after feedback round ${w.rounds}` : ''}; following its PRs`);
  }

  // ---- Stopping, and Needs you ----

  /** Stops `w` where it is: removes In Development (unless `untag` is false) and its worktrees, and records the cost. */
  async function stopNow(w, why = 'stopped by you', untag = true) {
    if (w.step === 'session' && session.alive(w)) session.kill(w);
    if (w.discussion) { session.kill(w.discussion); delete w.discussion; }
    side.state.needs = side.state.needs.filter(n => n.recordId !== w.uid);
    Object.assign(w, { status: 'stopped', step: null, stopRequested: false, endedAt: Date.now(), note: why });
    touch(w);
    const untagged = untag && (await retagSoon(w, ''));
    await tidy(w, (w.repos || []).filter(r => !r.pr || r.continued), w.round?.prs || []).catch(() => {});
    log('warn', `${w.key}: ${why}${untagged ? `; '${b().tags.inProgress}' removed` : ''}`);
  }

  /** s on a running ticket: it stops before its next push, PR, tag or turn. */
  side.stop = w => {
    w.stopRequested = true;
    if (w.step === 'session' && session.alive(w)) session.kill(w);
    touch(w);
    if (!w._busy && w.step !== 'session') stopNow(w);
  };

  /** enter in Needs you: answers a question, approves a plan (empty) or sends it back, or retries. */
  side.answer = (item, text) => {
    const w = records().find(r => r.uid === item.recordId);
    side.state.needs = side.state.needs.filter(n => n.id !== item.id);
    if (!w) return save();
    if (item.kind === 'question' || item.kind === 'blocked') {
      w.collected.answers.push({ id: item.qid || 'Q1', answer: text || (item.kind === 'blocked' ? 'go on as you think best' : `use your default${item.recommended ? ` (${item.recommended})` : ''}`) });
      if (text) appendAnswer(answersPath, { ticket: w.key, repos: (w.turnKind === 'round' ? w.round?.prs : w.repos || [])?.map(r => r.repo) || [], question: item.question, answer: text });
    } else if (item.kind === 'repos') {
      w.collected.unavailable.push({ repo: item.repo, why: text || "not available; do without it" });
    } else if (item.kind === 'plan') {
      if (!text) next(w, 'approve');
      else next(w, 'turn', brief.resume.planFeedback(text));
      return undefined;
    } else {
      // A cap, check, guard, conflict or failure: retry the step that stopped, or the session with a note.
      w.invalidAsked = false;
      w.checkFails = 0;
      w.ciFails = 0;
      w.preFailures = 0;
      if (!item.retry || item.retry === 'continue') next(w, 'turn', brief.resume.continue(text));
      else next(w, item.retry);
      if (item.retry === 'ci') { w.ciSince = Date.now(); touch(w); } // checks again, with the wait from now
      return undefined;
    }
    if (!itemsOf(w).length) resumeWithCollected(w);
    else save();
    return undefined;
  };

  /**
   * ? in Needs you: asks the session that raised `item` about it first, as often as you like before answering. A turn
   * of the same session without editing tools, held to the same caps; its reply joins the item's thread, and the
   * session remembers the talk when your answer comes. Returns why it can't be asked now, or ''.
   */
  side.discuss = (item, question) => {
    const w = records().find(r => r.uid === item.recordId);
    if (!w || !side.state.needs.includes(item)) return 'That has been dealt with already.';
    if (!w.sessionStarted || !w.sessionId) return 'No session has run for this yet, so there is no one to ask.';
    if (w.discussion) return 'Wait for the reply to your last question.';
    if (w.step === 'session' || w._busy) return 'Its session is running: ask once it stops.';
    const { why } = room(w);
    if (why) return `It can't be asked now: ${why}`;
    item.thread = [...(item.thread || []), { from: 'you', text: question, at: Date.now() }];
    try {
      w.discussion = Object.assign(session.discuss(cfg(), appDir, w, brief.resume.asks(item.question, question), room(w).budget), { itemId: item.id });
    } catch (e) {
      item.thread.pop();
      return `Couldn't ask it: ${e.message}`;
    }
    touch(w);
    log('info', `${w.key}: asked its session: ${question}`);
    return '';
  };

  /** Once a discussion turn has ended: its reply into the item's thread, and its cost onto the ticket's. */
  function hearBack(w) {
    const d = w.discussion;
    readActivity(d);
    if (!d._result && session.alive(d)) return;
    readActivity(d);
    const r = d._result;
    const cost = r?.total_cost_usd || 0;
    w.turns.push({ startedAt: d.startedAt, endedAt: Date.now(), kind: 'ask', logPath: d.logPath, costUsd: cost });
    w.costUsd = (w.costUsd || 0) + cost;
    w.sessionCostUsd = (w.sessionCostUsd || 0) + cost;
    const reply = String(r?.result || '').trim() || (r ? `(no reply: the session ended with ${r.subtype || 'an error'})` : '(no reply: the session ended without one; its log has more)');
    const item = side.state.needs.find(n => n.id === d.itemId);
    if (item) item.thread = [...(item.thread || []), { from: 'session', text: reply, at: Date.now() }];
    delete w.discussion;
    touch(w);
    log('ok', `${w.key}: its session replied`);
    hoot(`${w.key}'s session answered your question`);
  }

  /** s in Needs you: skips a question (the session uses its default), or ends the work and removes the tag. */
  side.skip = item => {
    if (['question', 'repos'].includes(item.kind)) return side.answer(item, '');
    const w = records().find(r => r.uid === item.recordId);
    if (!w) { side.state.needs = side.state.needs.filter(n => n.id !== item.id); return save(); }
    return stopNow(w, 'ended by you', !item.keepTags);
  };

  /** t in Needs you: hands the ticket back with its start tag; not reclaimed until someone re-tags it. */
  side.handBack = async item => {
    const w = records().find(r => r.uid === item.recordId);
    if (!w) return;
    const rev = await trackerOf(w).retag(cfg(), w.ref, tags().owned, b().tags.start);
    side.state.handedBack[w.key] = { rev, at: Date.now() };
    await stopNow(w, `handed back to you with '${b().tags.start}'`, false);
  };

  /** t in History: stops following a ticket's PRs. */
  side.stopFollowing = w => {
    if (w.step || w._busy) return side.stop(w); // a round queued or under way: stopped like any other work
    Object.assign(w, { status: 'done', endedAt: Date.now(), note: 'you stopped following it' });
    touch(w);
    log('info', `${w.key}: no longer following its PRs`);
  };

  /** prowl --work <key>: builds a ticket without its start tag. prowl --follow <key>, or w in History: adopts its PRs. */
  side.enqueue = async (key, source) => {
    const ticket = await trackerOf().lookup(cfg(), key);
    if (current(ticket.key)) throw new Error(`${ticket.key} is already ${current(ticket.key).status === 'following' ? 'being followed' : 'being built'}`);
    const w = newRecord(ticket, source);
    Object.assign(w, { step: 'claim', ticket });
    touch(w);
    return w;
  };

  /**
   * A quick build (n or a paste in the Builder, or prowl --build): it starts at once, whether the Builder is on or not,
   * and outside Max parallel builds. What's pasted decides it. A ticket (and any text, as your instructions): picked up
   * at whatever stage it is, without its start tag, claimed In Development, its tags driving the cycle. PRs: those PRs;
   * one ticket among what they mention makes it that ticket's build, otherwise it runs on its PRs' labels. Text only: a
   * build without a ticket, named per Quick names, on labels. `opts`: { as (a ticket or a name), name (typed, for ask),
   * oneShot (prowl --once: an offer is only logged), offered (the offer was turned down) }. Resolves with the record,
   * { offer } when a paste of only a ticket gets one first, or null on a dry run.
   */
  side.quickBuild = async function quickBuild(text, opts = {}) {
    const c = cfg();
    const paste = parsePaste(text, c.taskBoard);
    const instructions = paste.rest;
    if (paste.tickets.length > 1) throw new Error(`one ticket per quick build: ${paste.tickets.join(', ')}`);
    if (paste.tickets.length && paste.prs.length) throw new Error('paste a ticket or PRs, not both');
    if (!paste.tickets.length && !paste.prs.length && !instructions) throw new Error('Paste a ticket, PRs, or what to build');
    app.me ||= await gh.me();
    const tracker = trackerOf();
    let ticket = null;
    let scope = null;
    if (paste.tickets.length) {
      ticket = await tracker.lookup(c, paste.tickets[0]);
      if (!instructions && !opts.offered) {
        const offer = await offerFor(app, tracker, [ticket], b().tags.inProgress);
        if (offer && !opts.oneShot) return { offer: { ...offer, side: 'builder', text, as: opts.as || '' } };
        if (offer) log('info', `${ticket.key}: ${offer.polled ? `could be tagged '${b().tags.start}' instead` : `could be tagged '${b().tags.start}', with ${offer.boards.join(', ')} added to the boards`}; building now, as asked`);
      }
    } else if (paste.prs.length) {
      const prs = [];
      for (const ref of paste.prs) {
        const pr = await gh.prByRef(ref).catch(e => { throw new Error(`couldn't read ${ref.repo}#${ref.number} (${e.message})`); });
        if (pr.state !== 'open') throw new Error(`${pr.repo}#${pr.number} is ${pr.state}`);
        prs.push(pr);
      }
      scope = prs.map(prRef);
      const mentioned = [...new Set(prs.flatMap(p => parsePaste(`${p.title}\n${p.body || ''}`, c.taskBoard).tickets))];
      if (mentioned.length === 1) ticket = await tracker.lookup(c, mentioned[0]).catch(() => null);
    }
    const asKey = opts.as && ticketKey(opts.as, c.taskBoard);
    if (asKey) ticket = await tracker.lookup(c, asKey);
    if (ticket && current(ticket.key)) throw new Error(`${ticket.key} is already ${current(ticket.key).status === 'following' ? 'being followed' : 'being built'}`);
    let w;
    if (ticket) {
      if (app.dryRun()) { log('info', `${ticket.key}: would quick-build it (dry run)`); return null; }
      w = newRecord(ticket, 'quick');
      Object.assign(w, { quick: true, markers: 'tags', step: 'claim', ticket, instructions, scope });
    } else {
      let name = cleanName((!asKey && opts.as) || opts.name);
      if (!name && c.quickName === 'auto') name = await (deps.autoName || autoName)(c, [text, ...(scope || []).map(p => `${prName(p)}: ${p.title}`)].join('\n')).catch(() => '');
      const n = Math.max(0, ...records().filter(r => /^BUILD#\d+$/.test(r.key)).map(r => Number(r.key.split('#')[1]))) + 1;
      const key = `BUILD#${n}`;
      const title = name || (scope ? `Quick build: ${scope.map(prName).join(', ')}` : instructions.split('\n')[0].slice(0, 60));
      if (app.dryRun()) { log('info', `${key}: would quick-build "${title}" (dry run)`); return null; }
      w = newRecord({ key, title, url: '', ref: null }, 'quick');
      Object.assign(w, { quick: true, markers: 'labels', instructions, scope, step: scope ? 'adopt' : 'read', claimedAt: Date.now() });
    }
    touch(w);
    log('ok', `${w.key}: quick build of ${scope ? scope.map(prName).join(', ') : ticket ? `"${w.title}"` : `"${w.title}", without a ticket`}`);
    hoot(`Quick build: ${w.title}`);
    return w;
  };

  /**
   * An answer to an offer from quickBuild(): 'tag' (tag the ticket to start, adding its board with 'add'), 'build' (a
   * quick build now) or 'cancel'.
   */
  side.answerOffer = async function answerOffer(offer, choice) {
    if (choice === 'build') return side.quickBuild(offer.text, { as: offer.as, offered: true });
    if (choice !== 'tag' && choice !== 'add') return null;
    return acceptOffer(app, trackerOf(), offer, {
      tag: b().tags.start, busyTag: b().tags.inProgress, isTag: tags().isStart, addBoards: choice === 'add', log,
      saveConfig: () => deps.saveConfig?.(),
    });
  };

  async function claimQueued(w) {
    if (app.dryRun()) {
      Object.assign(w, { status: 'ended', step: null, endedAt: Date.now(), note: 'dry run' });
      touch(w);
      return log('info', `${w.key}: would ${w.source === 'follow' ? 'follow its PRs' : `build "${w.title}"`} (dry run)`);
    }
    const ticket = await trackerOf(w).readItem(cfg(), w.ref);
    if (tags().has(ticket.tags, b().tags.inProgress)) {
      // Someone (another copy of Prowl, say) is working on it now.
      Object.assign(w, { status: 'ended', step: null, endedAt: Date.now(), note: `it is '${b().tags.inProgress}' already` });
      touch(w);
      return log('warn', `${w.key}: not ${w.source === 'follow' ? 'followed' : 'built'}: it is '${b().tags.inProgress}' already, so someone is working on it`);
    }
    if (w.source === 'follow') {
      w.ticket = ticket;
      return adoptOrRead(w);
    }
    if (!w.quick && slotsUsed(w) >= b().maxConcurrent) { // a quick build starts at once
      w._retryAt = Date.now() + 30_000;
      log('info', `${w.key}: waiting, ${b().maxConcurrent} already being built`, `pick:${w.key}`);
      return undefined;
    }
    const claimed = await claim(ticket, w.source, w);
    touch(w);
    if (claimed) return survey(claimed);
    return undefined;
  }

  // ---- Driven by the shell ----

  const STEPS = { claim: claimQueued, adopt: survey, finish, read, turn, settle, repos, approve, publish, round, 'push-round': pushRound, ci, 'end-round': endRound,
    retag: w => retagSoon(w, w.retagTo), reclaim };

  /** Once a second, on or off: tails sessions, settles ended turns, runs due steps. Claims and turns wait while off or paused. */
  side.tick = function tick() {
    for (const w of records()) {
      if (w.discussion) { hearBack(w); continue; } // nothing else of a ticket moves while you're asking its session something
      if (w._busy || Date.now() < (w._retryAt || 0) || !w.step) continue;
      if (w.step === 'session') {
        readActivity(w);
        if (w._result || !session.alive(w)) {
          readActivity(w);
          w.step = 'settle';
          step(w, settle);
        } else if (b().timeoutMinutes > 0 && Date.now() - w.startedAt > b().timeoutMinutes * 60_000 && !w.capped) {
          w.capped = `time cap ${b().timeoutMinutes} min`;
          session.kill(w);
          save();
        }
        continue;
      }
      // A quick build starts at once, on or off, until its PRs are open; its rounds wait like any other.
      if (['claim', 'reclaim', 'turn', 'round'].includes(w.step) && (!on() || side.paused) && !(w.quick && !w.prsOpenedAt)) continue;
      // In dry run, saved work that would spend, push, post or tag waits; a queued claim ends itself.
      if (['reclaim', 'turn', 'round', 'publish', 'push-round', 'end-round', 'retag'].includes(w.step) && app.dryRun()) continue;
      if (w.stopRequested) { step(w, async x => stopNow(x)); continue; }
      step(w, STEPS[w.step]);
    }
  };

  /** Resolves once no step is running. */
  side.idle = async () => { while (side._inflight?.size) await Promise.all([...side._inflight]); };

  /** Runs due steps until nothing more moves without waiting (a session, a retry, Needs you): for --once and the self-test. */
  side.drain = async (max = 100) => {
    const snapshot = () => JSON.stringify(records().map(r => [r.uid, r.step, r.status, r._retryAt > Date.now()]));
    for (let i = 0; i < max; i++) {
      const before = snapshot();
      side.tick();
      await side.idle();
      if (snapshot() === before) return;
    }
  };

  return side;
}
