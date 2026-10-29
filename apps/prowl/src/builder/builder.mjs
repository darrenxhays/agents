// The Builder: picks up tickets tagged Ready to Start, builds them in a fenced Claude Code session, then Prowl's own
// code checks, pushes and opens one PR per repo, tags the ticket Ready for Review and follows the PRs through review,
// fixing feedback in rounds. src/shell.mjs drives poll() and tick(); the Reviewer never reads its state (work.json, work/).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHECKS_PATH, HOME, writeJson } from '../config.mjs';
import { matchChecks, runChecks, TAIL } from '../checks.mjs';
import { actionable, appendAnswer, parkedUrls, pastAnswers, readAnswers, repliesToPost, stripParked, validateFeedback } from '../feedback.mjs';
import { addWorktree, fetchBranch, git, push, remoteSha, removeWorktree, short, succeeds } from '../git.mjs';
import * as github from '../github.mjs';
import { branchRefusal, guardFailures, prRefusal } from '../guards.mjs';
import { mentions } from '../match.mjs';
import { killTree, notifyDesktop } from '../proc.mjs';
import { alive, capHit, readActivity } from '../sessions.mjs';
import { fill, outputTemplate } from '../templates.mjs';
import * as brief from './brief.mjs';
import { ensureClone, ghClone, prepareRepo, remoteBranches, worktreeRoot } from './repos.mjs';
import * as rules from './rules.mjs';
import { startTurn } from './session.mjs';

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

const DEFAULT_SESSION = { start: startTurn, alive, kill: w => killTree(w.pid) };

/**
 * The Builder side. `deps`: { log(level, msg, key), forget(key), hoot(text, mood), appDir, trackers, and for the
 * self-test: tracker (one module for every board), github, session ({ start, alive, kill }), clone(repo, dir), notify, statePath }.
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

  const current = key => records().find(r => r.key === key && !['done', 'stopped', 'ended'].includes(r.status));
  // Tickets being built, from the claim until their PRs open, Needs you included: the ones Max parallel builds counts.
  const building = () => records().filter(r => ['active', 'needs-you'].includes(r.status) && !r.prsOpenedAt && r.claimedAt);
  side.running = () => records().filter(r => r.status === 'active');
  side.history = () => [...records()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  side.needs = () => side.state.needs;
  side.alive = () => records().some(r => r.step === 'session' && session.alive(r));
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
    if (building().length >= b().maxConcurrent) {
      log('info', `${ticket.key}: waiting, ${b().maxConcurrent} ticket${b().maxConcurrent > 1 ? 's are' : ' is'} already being built`, key);
      return;
    }
    if (app.dryRun()) {
      log('info', `${ticket.key}: would build "${ticket.title}"`, key);
      return;
    }
    if (!on() || side.paused) return;
    const w = await claim(ticket, 'tag');
    if (w) await step(w, adoptOrRead);
  }

  /** Claims `ticket` (start tag → In Development); the loser backs off. Resolves with its record, or null. */
  async function claim(ticket, source, w = null) {
    const tracker = trackerOf(w);
    const { owned, isStart } = tags();
    try {
      await tracker.claim(cfg(), ticket, owned, b().tags.inProgress);
    } catch (e) {
      log('warn', `${ticket.key}: not claimed (changed or claimed by someone else): ${e.message}`, `pick:${ticket.key}`);
      if (w) Object.assign(w, { status: 'ended', step: null, note: `not claimed: ${e.message}` });
      return null;
    }
    w ||= newRecord(ticket, source);
    Object.assign(w, { claimedAt: Date.now(), step: 'adopt', status: 'active' });
    touch(w);
    deps.forget?.(`pick:${ticket.key}`);
    if (!on()) {
      // Switched off as it claimed: put back what the claim took off.
      const hadStart = (ticket.tags || []).some(isStart);
      await tracker.retag(cfg(), w.ref, owned, hadStart ? b().tags.start : '').catch(e => log('error', `${w.key}: couldn't put its tags back (${e.message})`));
      Object.assign(w, { status: 'ended', step: null, note: 'the Builder was switched off as it claimed this ticket' });
      touch(w);
      log('info', `${w.key}: the Builder was switched off as it claimed this ticket; its tags are back as they were`);
      return null;
    }
    log('ok', `${w.key}: claimed, marked '${b().tags.inProgress}'`);
    hoot(`Picking up ${w.title}, marking as '${b().tags.inProgress}'`);
    return w;
  }

  /**
   * Adopts the ticket's open, non-draft PRs of yours when it has some; otherwise reads it to build it. Following by hand
   * (--follow, w) claims nothing: a round claims the ticket when it starts, and a review asked for or under way is left be.
   */
  async function adoptOrRead(w) {
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
    const due = await dueFeedback(w);
    const reviewing = !w.claimedAt && [b().tags.done, b().tags.reviewing].some(t => tags().has(w.ticket?.tags || [], t));
    Object.assign(w, { roundPrs: due, lastActivityAt: due.length ? 0 : Date.now(), step: due.length ? 'round' : reviewing ? null : 'end-round', status: due.length || !reviewing ? 'active' : 'following' });
    touch(w);
    return undefined;
  }

  // ---- Reading the ticket and starting the session ----

  async function read(w) {
    const tracker = trackerOf(w);
    const data = await tracker.workItem(cfg(), w.ref);
    w.title = data.title || w.title;
    const prs = await gh.prsMentioning(cfg().githubOwner, w.key).catch(() => []);
    const texts = [data.description, data.acceptanceCriteria, data.reproSteps, ...data.comments.map(c => c.text),
      ...[data.parent, ...data.children, ...data.related].filter(Boolean).map(i => i.description), ...data.links.map(l => l.url)];
    const candidates = rules.repoCandidates(texts, prs.map(p => p.repo));
    fs.mkdirSync(w.briefDir, { recursive: true });
    fs.writeFileSync(path.join(w.briefDir, 'ticket.md'), brief.ticketMd(data, { prs, trackerName: tracker.name }));
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
    const answers = pastAnswers(readAnswers(answersPath), [data.title, data.description, data.acceptanceCriteria].join('\n'), repos.map(r => r.repo));
    if (answers.length) fs.writeFileSync(path.join(w.briefDir, 'answers.md'), brief.answersMd(answers));
    Object.assign(w, {
      repos, sessionId: randomUUID(), sessionStarted: false, sessionCostUsd: 0, turnKind: 'build', step: 'turn',
      prompt: brief.buildPrompt({ command: b().command, briefDir: w.briefDir, ticket: w, repos, unavailable, answers: answers.length > 0 }),
    });
    touch(w);
    log('info', `${w.key}: read the ticket; ${repos.length ? `checked out ${repos.map(r => r.repo).join(', ')}` : 'no repo found yet'}`);
  }

  /** Starts the next turn of `w`'s session, unless a cap holds it. */
  async function turn(w) {
    checkStop(w);
    const c = b();
    const spent = rules.ticketSpend(records(), w.key);
    if (rules.spendLevel(spent, c.ticketBudgetUsd) === 'over') throw new NeedsYou('cap', `Spend cap per ticket reached ($${c.ticketBudgetUsd}): no more sessions for ${w.key}.`, { retry: 'turn' });
    if (rules.spendLevel(rules.daySpend(records()), c.dailyBudgetUsd) === 'over') throw new NeedsYou('cap', `Spend cap per day reached ($${c.dailyBudgetUsd}): no more sessions today.`, { retry: 'turn' });
    const budget = c.maxBudgetUsd > 0 ? c.maxBudgetUsd - (w.sessionCostUsd || 0) : 0;
    if (c.maxBudgetUsd > 0 && budget <= 0) throw new NeedsYou('cap', `The session for ${w.key} reached its spend cap ($${c.maxBudgetUsd}).`, { retry: 'turn' });
    w._budget = budget;
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
    const capped = w.capped || capHit(r, { maxBudgetUsd: b().maxBudgetUsd, maxTurns: b().maxTurns });
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
      return raise(w, 'question', q.question, { qid: q.id, options: q.options || [], recommended: q.default || '', context: q.context || [] });
    }
    if (r.status === 'blocked') return raise(w, 'blocked', `The session is blocked: ${r.reason}`, { qid: 'blocked' });
    if (r.status === 'needs-approval') {
      w.changes = r.changes || [];
      const open = r.openQuestions || [];
      for (const q of open) raise(w, 'question', q.question, { qid: q.id, options: q.options || [], recommended: q.default || '', blocked: 'the plan waits for your answer' });
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
      if (rec.branch && (await git(rec.worktree, 'symbolic-ref', '--short', 'HEAD').catch(() => '')).trim() === rec.branch) { branches.push(rec); continue; }
      const remote = await remoteBranches(rec.clone);
      const pick = rules.pickBase(b().base, rec.repo, { planBase: change.base, remote, defaultBranch: rec.defaultBranch });
      if (pick.error) throw new NeedsYou('conflict', `${w.key}: ${pick.error}.`, { retry: 'approve' });
      const baseSha = await fetchBranch(rec.clone, pick.base);
      let branch = '';
      for (let n = 1; !branch; n++) {
        const name = rules.branchName(b().branchTemplate, w.key, w.title, n);
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
    for (const rec of recs) {
      const spec = matchChecks(readJson(CHECKS_PATH), rec.repo);
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
        onBranch: onBranch ? (await git(rec.worktree, 'symbolic-ref', '--short', 'HEAD').catch(() => '')).trim() === rec.branch : true,
        numstat: await git(rec.worktree, 'diff', '--numstat', `${base(rec)}..HEAD`),
        diff: await git(rec.worktree, 'diff', '-U0', `${base(rec)}..HEAD`),
      }, b());
      if (failed[0]?.kind === 'moved') return { moved: `${rec.repo}: ${failed[0].text}` };
      if (failed.length) throw new NeedsYou('guard', `Prowl didn't push ${w.key} to ${rec.repo}: ${failed.map(x => x.text).join('; ')}.`, { retry: 'continue' });
    }
    return true;
  }

  async function publish(w) {
    checkStop(w);
    const recs = w.repos.filter(r => r.branch && (w.result?.commits || []).some(c => c.repo.toLowerCase() === r.repo.toLowerCase()));
    if (!recs.length) throw new NeedsYou('failed', `The session for ${w.key} said it was done, but none of its commits are on Prowl's branches.`, { retry: 'continue' });
    const ok = await checkAll(w, recs.filter(r => !r.pr), { base: r => r.baseSha, expected: r => r.pushedSha || '', onBranch: true });
    if (ok === false) return undefined;
    if (ok.moved) throw new NeedsYou('conflict', `Prowl didn't push ${w.key}: ${ok.moved}.`, { retry: 'publish' });
    for (const rec of recs.filter(r => !r.pr)) {
      checkStop(w);
      const refused = branchRefusal(rec.branch, rec.defaultBranch, b().protectedBranches);
      if (refused) throw new NeedsYou('guard', `Prowl won't push to ${rec.repo}'s ${refused}.`, { retry: 'publish' });
      const head = (await git(rec.worktree, 'rev-parse', 'HEAD')).trim();
      if (rec.pushedSha !== head) {
        await push(rec.worktree, rec.branch); // never forced
        rec.pushedSha = head;
        touch(w);
        log('ok', `${w.key}: pushed ${short(head)} to ${rec.repo} ${rec.branch}`);
      }
    }
    for (const rec of recs.filter(r => !r.pr)) {
      checkStop(w);
      const spec = (w.result.prs || []).find(p => p.repo.toLowerCase() === rec.repo.toLowerCase()) || {};
      const title = mentions(spec.title, w.key) ? spec.title : `${w.key}: ${spec.title || w.title}`;
      const file = path.join(w.briefDir, `pr-${rec.repo.split('/')[1]}.json`);
      writeJson(file, { title, head: rec.branch, base: rec.base, body: spec.body || '', draft: Boolean(b().draftPrs) });
      rec.pr = { ...(await gh.createPr(rec.repo, file)), repo: rec.repo, title };
      rec.prBody = spec.body || '';
      touch(w);
      log('ok', `${w.key}: opened ${rec.pr.url}`);
    }
    if (recs.length > 1 && !w.linked) {
      for (const rec of recs) {
        const others = recs.filter(r => r !== rec).map(r => `- ${r.pr.url}`);
        const file = path.join(w.briefDir, `pr-${rec.repo.split('/')[1]}.json`);
        writeJson(file, { body: `${rec.prBody}\n\n---\n\nThe other PRs for ${w.key}:\n\n${others.join('\n')}`.trimStart() });
        await gh.editPr(rec.pr, file);
      }
      w.linked = true;
      touch(w);
    }
    checkStop(w);
    await trackerOf(w).retag(cfg(), w.ref, tags().owned, b().tags.done);
    Object.assign(w, {
      prs: recs.map(r => ({ repo: r.repo, number: r.pr.number, url: r.pr.url, title: r.pr.title })), prsOpenedAt: Date.now(), lastActivityAt: Date.now(), lastPushAt: Date.now(),
      status: b().followUp ? 'following' : 'done', step: null, checkFails: 0, ...(!b().followUp && { endedAt: Date.now(), note: 'PRs opened' }),
    });
    touch(w);
    log('ok', `${w.key}: ${w.prs.length} PR${w.prs.length > 1 ? 's' : ''} open, marked '${b().tags.done}'`);
    hoot(`Opened ${w.prs.length > 1 ? `${w.prs.length} PRs` : 'a PR'} for ${w.title}`, 'cheer');
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

  /** The followed PRs with feedback newer than the last push or round. Merged and closed PRs stop being followed. */
  async function dueFeedback(w) {
    const due = [];
    for (const pr of [...w.prs]) {
      const facts = await gh.prFacts(pr);
      if (facts.state !== 'OPEN') {
        w.prs = w.prs.filter(p => p.url !== pr.url);
        log('info', `${w.key}: ${prName(pr)} is ${facts.state.toLowerCase()}; no longer following it`);
        continue;
      }
      if (prRefusal(facts, pr, app.me, b().protectedBranches)) continue; // drafts, others' PRs and forks get no round
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
        const item = await trackerOf(w).readItem(cfg(), w.ref);
        // A review asked for or under way finishes first. (Tags compare without case or punctuation, so Jira's Ready-for-Review matches.)
        const waiting = [b().tags.done, b().tags.reviewing].some(t => tags().has(item.tags, t));
        const due = waiting ? [] : await dueFeedback(w);
        if (!w.prs.length) {
          Object.assign(w, { status: 'done', endedAt: Date.now(), note: 'its PRs are merged or closed' });
          touch(w);
          log('ok', `${w.key}: its PRs are merged or closed; Prowl stops following it`);
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
    const ticket = await tracker.readItem(cfg(), w.ref);
    try {
      await tracker.claim(cfg(), ticket, tags().owned, b().tags.inProgress);
    } catch (e) {
      Object.assign(w, { step: null, status: 'following' });
      touch(w);
      return log('warn', `${w.key}: round not started, the ticket changed or someone else claimed it (${e.message})`);
    }
    Object.assign(w, { status: 'active', claimedRoundAt: Date.now() });
    if (w.rounds >= b().maxRounds) throw new NeedsYou('cap', `Feedback rounds per ticket reached (${b().maxRounds}) for ${w.key}: fix the rest yourself, or raise the cap.`, { retry: 'round' });
    if (rules.spendLevel(rules.ticketSpend(records(), w.key), b().ticketBudgetUsd) === 'over') throw new NeedsYou('cap', `Spend cap per ticket reached ($${b().ticketBudgetUsd}) for ${w.key}.`, { retry: 'round' });
    const n = w.rounds + 1; // counted once the round is ready to start, so a retry doesn't count it twice
    const prs = [];
    const answersText = [];
    for (const pr of w.roundPrs || []) {
      const facts = await gh.prFacts(pr);
      if (facts.state !== 'OPEN' || prRefusal(facts, pr, app.me, b().protectedBranches)) continue;
      const dir = await ensureClone(cfg(), pr.repo, clone);
      const sha = await fetchBranch(dir, facts.headBranch);
      const worktree = path.join(worktreeRoot(cfg(), w), `${pr.repo.split('/')[1]}-${pr.number}`);
      await addWorktree(dir, worktree, sha);
      const details = await gh.detailsFromGitHub(pr).catch(() => '');
      const threads = actionable(await gh.prThreads(pr), b().fixFrom, parkedUrls(details));
      const reviews = (await gh.prReviews(pr)).filter(r => r.state === 'CHANGES_REQUESTED' && (Date.parse(r.at) || 0) > (w.lastActivityAt || 0));
      answersText.push(details, ...threads.map(t => t.body), ...reviews.map(r => r.body));
      prs.push({ pr, repo: pr.repo, number: pr.number, url: pr.url, title: pr.title, branch: facts.headBranch, headSha: sha, worktree, clone: dir, details: stripParked(details), reviews, threads,
        defaultBranch: facts.defaultBranch });
    }
    if (!prs.length) {
      Object.assign(w, { status: 'following', step: 'end-round' });
      touch(w);
      return undefined;
    }
    const answers = pastAnswers(readAnswers(answersPath), answersText.join('\n'), prs.map(p => p.repo));
    fs.mkdirSync(w.briefDir, { recursive: true });
    const feedbackPath = path.join(w.briefDir, `feedback-${n}.md`);
    fs.writeFileSync(feedbackPath, brief.feedbackMd({ ticket: w, round: n, maxRounds: b().maxRounds, prs, answers }));
    w.rounds = n;
    w.round = {
      n, startedAt: Date.now(), feedbackPath,
      prs: prs.map(p => ({ repo: p.repo, number: p.number, url: p.url, title: p.title, branch: p.branch, headSha: p.headSha, worktree: p.worktree, clone: p.clone,
        defaultBranch: p.defaultBranch, threads: p.threads.map(t => ({ id: t.id, commentId: t.commentId, url: t.url })) })),
    };
    Object.assign(w, { sessionId: randomUUID(), sessionStarted: false, sessionCostUsd: 0, turnKind: 'round', checkFails: 0, ciFails: 0, invalidAsked: false });
    log('ok', `${w.key}: feedback round ${w.rounds} on ${prs.map(p => prName(p)).join(', ')}`);
    return next(w, 'turn', brief.feedbackPrompt({ briefDir: w.briefDir, feedbackPath }));
  }

  function settleRound(w, r) {
    const questions = r.questions || [];
    if (questions.length) {
      questions.forEach((q, i) => raise(w, 'question', q.text, {
        qid: `Q${i + 1}`, context: String(q.context || '').split('\n').filter(Boolean), options: q.options || [], recommended: q.recommended || '', searched: q.searched,
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
    const changed = [];
    for (const p of w.round.prs) if ((await git(p.worktree, 'rev-parse', 'HEAD')).trim() !== (p.pushedSha || p.headSha)) changed.push(p);
    if (changed.length) {
      const ok = await checkAll(w, changed, { base: p => p.headSha, expected: p => p.pushedSha || p.headSha, onBranch: false });
      if (ok === false) return undefined;
      if (ok.moved) {
        await trackerOf(w).retag(cfg(), w.ref, tags().owned, '');
        await tidy(w, [], w.round.prs);
        Object.assign(w, { status: 'following', step: null, lastActivityAt: Date.now() });
        touch(w);
        return log('warn', `${w.key}: round ${w.rounds} dropped, nothing pushed: ${ok.moved}`);
      }
      for (const p of changed) {
        checkStop(w);
        const refused = branchRefusal(p.branch, p.defaultBranch, b().protectedBranches);
        if (refused) throw new NeedsYou('guard', `Prowl won't push to ${p.repo}'s ${refused}.`);
        const head = (await git(p.worktree, 'rev-parse', 'HEAD')).trim();
        try {
          await push(p.worktree, p.branch); // never forced
        } catch (e) {
          await trackerOf(w).retag(cfg(), w.ref, tags().owned, '');
          Object.assign(w, { status: 'following', step: null, lastActivityAt: Date.now() });
          touch(w);
          return log('warn', `${w.key}: the push to ${prName(p)} was rejected (${e.message}); round ${w.rounds} dropped`);
        }
        p.pushedSha = head;
        w.lastPushAt = Date.now();
        touch(w);
        log('ok', `${w.key}: pushed ${short(head)} to ${prName(p)}`);
      }
    }
    // One reply per thread fixed (once pushed) or disputed, each marked so a restart never posts it twice. Never resolved.
    const tpl = heading => outputTemplate(appDir, heading);
    for (const p of w.round.prs) {
      const items = (w.result.items || []).filter(it => forPr(it, p) || (w.round.prs.length === 1 && !it.pr));
      const todo = items.length ? repliesToPost({ ticket: w.key, round: w.rounds, items, threads: p.threads, pushed: p.pushedSha }, await gh.prCommentBodies(p)) : [];
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
      if (w.ciFails > 1) throw new NeedsYou('checks', `Required checks still fail on ${failing.map(f => prName(f.p)).join(', ')} after one more turn.`, { retry: 'end-round' });
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
    await trackerOf(w).retag(cfg(), w.ref, tags().owned, b().tags.done);
    if (w.round) await tidy(w, [], w.round.prs);
    Object.assign(w, { status: 'following', step: null, lastActivityAt: Date.now(), round: null, roundPrs: [] });
    touch(w);
    log('ok', `${w.key}: marked '${b().tags.done}'${w.rounds ? ` after feedback round ${w.rounds}` : ''}; following its PRs`);
  }

  // ---- Stopping, and Needs you ----

  /** Stops `w` where it is: removes In Development (unless `untag` is false) and its worktrees, and records the cost. */
  async function stopNow(w, why = 'stopped by you', untag = true) {
    if (w.step === 'session' && session.alive(w)) session.kill(w);
    side.state.needs = side.state.needs.filter(n => n.recordId !== w.uid);
    Object.assign(w, { status: 'stopped', step: null, stopRequested: false, endedAt: Date.now(), note: why });
    touch(w);
    if (untag) await trackerOf(w).retag(cfg(), w.ref, tags().owned, '').catch(e => log('error', `${w.key}: couldn't take '${b().tags.inProgress}' off (${e.message})`));
    await tidy(w, (w.repos || []).filter(r => !r.pr), w.round?.prs || []).catch(() => {});
    log('warn', `${w.key}: ${why}${untag ? `; '${b().tags.inProgress}' removed` : ''}`);
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
      return undefined;
    }
    if (!itemsOf(w).length) resumeWithCollected(w);
    else save();
    return undefined;
  };

  /** s in Needs you: skips a question (the session uses its default), or ends the work and removes the tag. */
  side.skip = item => {
    if (['question', 'repos'].includes(item.kind)) return side.answer(item, '');
    const w = records().find(r => r.uid === item.recordId);
    if (!w) { side.state.needs = side.state.needs.filter(n => n.id !== item.id); return save(); }
    return stopNow(w, 'ended by you');
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

  async function claimQueued(w) {
    const ticket = await trackerOf(w).readItem(cfg(), w.ref);
    if (w.source === 'follow') {
      w.ticket = ticket;
      return adoptOrRead(w);
    }
    if (building().filter(r => r !== w).length >= b().maxConcurrent) {
      w._retryAt = Date.now() + 30_000;
      log('info', `${w.key}: waiting, ${b().maxConcurrent} already being built`, `pick:${w.key}`);
      return undefined;
    }
    const claimed = await claim(ticket, w.source, w);
    touch(w);
    if (claimed) return adoptOrRead(claimed);
    return undefined;
  }

  // ---- Driven by the shell ----

  const STEPS = { claim: claimQueued, adopt: adoptOrRead, read, turn, settle, repos, approve, publish, round, 'push-round': pushRound, ci, 'end-round': endRound };

  /** Once a second, on or off: tails sessions, settles ended turns, runs due steps. Claims and turns wait while off or paused. */
  side.tick = function tick() {
    for (const w of records()) {
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
      if (['claim', 'turn', 'round'].includes(w.step) && (!on() || side.paused)) continue;
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
