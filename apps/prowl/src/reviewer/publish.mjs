// Posts a review on GitHub from its result: the reads, the calls in the planner's order, retries, the fallbacks
// when GitHub rejects a review, and what is recorded on the run so a restart finishes without posting anything twice.
import path from 'node:path';
import { writeJson } from '../config.mjs';
import { commentable, planPublish } from './publish-plan.mjs';
import { prName, short } from './render.mjs';

export const WAITS = [1000, 4000, 16_000]; // before each retry; a rate limit waits a minute
const rateLimited = e => e.status === 429 || ([400, 403].includes(e.status) && /rate limit|abuse|secondary/i.test(e.message));
/** True for a failed GitHub call worth trying again: a network failure, a 5xx, a rate limit, or a GraphQL hiccup. Prowl's own failures aren't. */
export const retryable = e => Boolean(e?.gh) && (e.status === undefined || e.status >= 500 || rateLimited(e) || /something went wrong|timed out|timeout/i.test(e.message));

/**
 * Runs `call`, retrying a retryable failure up to three times. `landed` (for a write): looks, before each retry and
 * once more before giving up, for the write on the PR: one that landed although its call failed is taken as done,
 * never made twice. If that look itself fails, the error stands: no second write while the first one's outcome is unknown.
 */
export async function attempt(call, { sleep, landed = null } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (!retryable(e)) throw e;
      if (landed) {
        const found = await landed().catch(() => { throw Object.assign(e, { unknown: true }); });
        if (found) return found;
      }
      if (i >= WAITS.length) throw e;
      await sleep(rateLimited(e) ? 60_000 : WAITS[i]);
    }
  }
}

const EXPECTED = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };

/** Where `op`'s write is among what the login wrote on the PR (`w`: writtenSince()), by its marker: its URL (a review: { id, url, state }), or null. */
function landedIn(op, w) {
  if (!w) return null;
  if (op.kind === 'reply') return w.comments.find(c => c.inReplyTo && String(c.body).includes(op.marker))?.url || null;
  if (op.kind === 'part2') return w.issueComments.find(c => String(c.body).includes(op.marker))?.url || null;
  if (op.kind === 'review') { const r = w.reviews.find(x => String(x.body).includes(op.marker)); return r ? { id: r.id, url: r.url, state: r.state } : null; }
  return null;
}

/**
 * Posts `result` for `run`. `deps`: { gh, log(level, msg), hoot(text, mood), save(), templates, labels, sleep(ms) }. Resolves with the final plan (planPublish()), and { info }: each PR as read. What it did is on
 * the run: published, publishRefused, publishErrors, publishFallback, unreviewed, reviewedPrs, approved, awaitingHuman, split.
 */
export async function publishReview(run, result, deps) {
  const { gh, log, save, templates, labels } = deps;
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const hoot = deps.hoot || (() => {});
  for (const k of ['published', 'publishRefused', 'publishErrors', 'publishFallback', 'unreviewed', 'split', 'approved']) run[k] ??= {};
  run.reviewedPrs ??= [];
  const file = path.join(path.dirname(run.logPath), `${run.id}.publish.json`);
  const login = run.me || await gh.me();
  const fail = (pr, why) => {
    run.publishErrors[pr.url] = why;
    delete run.publishFallback[pr.url]; // a later attempt starts afresh
    save();
    log('error', `${run.ticket}: couldn't post the review on ${prName(pr.url)}: ${why}`);
  };
  if (templates.fellBack?.length) log('info', `${run.ticket}: your output.md lacks ${templates.fellBack.join(', ')} (or a placeholder they need), so those use the default's templates`);

  // ---- Reads, once per PR, before any write ----
  const info = {};
  const written = {};
  for (const pr of run.prs) {
    if (run.publishErrors[pr.url]) continue;
    const entry = (result.prs || []).find(p => p.url === pr.url);
    try {
      const now = await attempt(() => gh.prNow(pr), { sleep });
      info[pr.url] = { state: now.state, title: now.title, author: now.author, head: now.head, files: null, threads: null };
      if (now.state !== 'open') continue;
      if (!entry || !entry.reviewedAt) {
        const why = !entry ? 'the review result has no entry for it' : `the review session couldn't read it: ${String(entry.coverage?.unverified || '').trim()}`;
        if (!run.unreviewed[pr.url]) log('warn', `${run.ticket}: nothing is posted on ${prName(pr.url)}: ${why}; a new review is needed for it`);
        run.unreviewed[pr.url] = why;
        continue;
      }
      const moved = now.head !== entry.reviewedAt;
      if (moved) log('info', `${run.ticket}: ${prName(pr.url)} has new commits since it was reviewed at ${short(entry.reviewedAt)}; its review goes on the commit it verified`);
      try {
        // The lines of the commit that was verified, not of whatever the branch holds now.
        info[pr.url].files = commentable(await attempt(() => (moved ? gh.compareFiles(pr.repo, now.base, entry.reviewedAt) : gh.prFiles(pr)), { sleep }));
      } catch (e) {
        log('warn', `${run.ticket}: couldn't read the changed files of ${prName(pr.url)} (${e.message}); its findings go in the review body`);
      }
      info[pr.url].threads = await attempt(() => gh.reviewThreads(pr), { sleep });
      written[pr.url] = await attempt(() => gh.writtenSince(pr, login, run.startedAt), { sleep });
    } catch (e) {
      fail(pr, e.message);
    }
  }

  // ---- The guardrail, once per run, before the first write: the session is told to write nothing itself ----
  if (!run.guardChecked) {
    const ours = new Set(Object.values(run.published));
    for (const pr of run.prs) {
      const w = written[pr.url];
      if (!w) continue;
      const stray = [...w.reviews, ...w.comments, ...w.issueComments].filter(x => String(x.body).includes(result.batchId) && !ours.has(x.url)).map(x => x.url);
      if (stray.length) log('warn', `${run.ticket}: the session wrote to ${prName(pr.url)} itself, though it is told not to: ${stray.join(', ')}`);
    }
    run.guardChecked = true;
  }
  save();

  const ctx = () => ({ run, templates, labels, prs: info });
  const done = key => key in run.published || key in run.publishRefused;
  const warnedLost = new Set();

  /** Records a review that is on the PR: its URL, that the PR is reviewed, and its approval, together. */
  async function recordReview(pr, rec, op, posted) {
    run.published[op.key] = posted.url;
    if (!run.reviewedPrs.includes(pr.url)) run.reviewedPrs.push(pr.url);
    const expected = EXPECTED[rec.event];
    if (posted.state && posted.state !== expected) log('warn', `${run.ticket}: the review on ${prName(pr.url)} came back as ${posted.state}, not ${expected}; no approval is recorded for it`);
    else if (rec.approval) {
      run.approved[pr.url] = rec.reviewedAt;
      if (rec.approval === 'awaiting-human' && !(run.awaitingHuman ??= []).includes(pr.url)) run.awaitingHuman.push(pr.url);
    }
    save();
    log('ok', `${run.ticket}: review posted on ${prName(pr.url)}${rec.fallback ? ', with its findings in the body' : ''}`);
    hoot(`Done reviewing ${info[pr.url]?.title || pr.title || prName(pr.url)}`, 'cheer');
    if (rec.withheld) log('warn', `${run.ticket}: ${prName(pr.url)} gets no approval: ${rec.withheld} (its review says what)`);
    // The inline comments' own links, for the report and for the next review to find each finding by.
    try {
      for (const c of await attempt(() => gh.reviewComments(pr, posted.id), { sleep })) {
        const id = new RegExp(`<!-- prowl-review ${result.batchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([FC]-\\d+) -->`).exec(c.body || '')?.[1];
        if (id) run.published[`comment:${pr.url}:${id}`] = c.url;
      }
    } catch (e) {
      log('warn', `${run.ticket}: couldn't read back the inline comments on ${prName(pr.url)} (${e.message}); the report links the review instead`);
    }
    save();
  }

  async function perform(pr, rec, op) {
    const again = async () => landedIn(op, await gh.writtenSince(pr, login, run.startedAt));
    // A crash between a call and the save: what is on the PR already is never posted again.
    const there = landedIn(op, written[pr.url]);
    if (op.kind === 'reply' || op.kind === 'part2') {
      try {
        writeJson(file, { body: op.body });
        run.published[op.key] = there || await attempt(() => (op.kind === 'reply' ? gh.replyOn(pr, op.commentId, file) : gh.commentOn(pr, file)), { sleep, landed: again });
        if (op.kind === 'part2') run.split[pr.url] = rec.split; // pinned: a resume finds the same split, whatever the body says by then
        return save();
      } catch (e) {
        if (op.kind === 'part2' || retryable(e) || !e.gh) return fail(pr, e.message);
        run.publishRefused[op.key] = e.message;
        save();
        return log('warn', `${run.ticket}: GitHub refused to reply on the thread of ${op.id} on ${prName(pr.url)} (${e.message}); the review goes on without it`);
      }
    }
    if (op.kind === 'reopen' || op.kind === 'resolve') {
      try {
        await attempt(() => gh.setThreadResolved(op.threadId, op.kind === 'resolve'), { sleep });
        run.published[op.key] = op.kind === 'resolve' ? 'resolved' : 'reopened';
        return save();
      } catch (e) {
        if (retryable(e) || !e.gh) return fail(pr, e.message);
        run.publishRefused[op.key] = e.message;
        save();
        return log('warn', `${run.ticket}: GitHub refused to ${op.kind} the thread of ${op.id} on ${prName(pr.url)} (${e.message}); the review goes on without it`);
      }
    }
    // The review.
    if (rec.anchorLost && !warnedLost.has(pr.url)) {
      warnedLost.add(pr.url);
      log('warn', `${run.ticket}: couldn't find where part 2 of the details file on ${prName(pr.url)} starts, so part 1 ends at the line it ended at before; a finding may be in both parts or in neither`);
    }
    if (there) return recordReview(pr, rec, op, there);
    try {
      writeJson(file, op.payload);
      return await recordReview(pr, rec, op, await attempt(() => gh.createReview(pr, file), { sleep, landed: again }));
    } catch (e) {
      if (retryable(e) || !e.gh) return fail(pr, e.message);
      const stage = run.publishFallback[pr.url];
      if (e.status === 422 && op.inline > 0 && !stage) {
        run.publishFallback[pr.url] = 'body';
        save();
        return log('warn', `${run.ticket}: GitHub rejected the review on ${prName(pr.url)} (${e.message}); trying again with its inline comments in the review body`);
      }
      const head = stage === 'head' ? rec.reviewedAt : await attempt(() => gh.prNow(pr), { sleep }).then(n => n.head, () => rec.reviewedAt);
      if (head !== rec.reviewedAt) {
        run.publishFallback[pr.url] = 'head';
        save();
        return log('warn', `${run.ticket}: GitHub rejected the review on ${prName(pr.url)} (${e.message}); its head has moved, so trying again on the latest commit, with no approval`);
      }
      return fail(pr, `GitHub rejected the review, so none of its findings are on the PR (${e.message}); they are in the report`);
    }
  }

  // ---- The calls, in the planner's order; the plan is made again before each one, so later posts link earlier ones ----
  for (let guard = 0; guard < 10_000; guard++) {
    const plan = planPublish(result, ctx());
    let next = null;
    for (const rec of plan.prs) {
      if (rec.skip || run.publishErrors[rec.url] || !info[rec.url]) continue;
      const op = rec.ops.find(o => !done(o.key));
      if (op) { next = { rec, op, pr: run.prs.find(p => p.url === rec.url) }; break; }
    }
    if (!next) return { ...plan, info };
    await perform(next.pr, next.rec, next.op);
  }
  throw new Error('the publish plan never settled');
}
