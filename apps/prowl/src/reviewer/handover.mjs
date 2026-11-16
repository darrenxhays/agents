// What a prepared re-review is handed as files instead of in its prompt: the previous review's findings (each with
// its ledger key for this review) and the start of its result, a skeleton holding everything Prowl already knows.
// Whatever is the session's to decide holds a placeholder there, and the result check refuses one left in.
import fs from 'node:fs';
import path from 'node:path';
import { prepDir, prFolder } from './prep.mjs';
import { reviewIdOf, TODO } from './result.mjs';

const prOf = url => { const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url); return { url, repo: m?.[1] || 'unknown/unknown', number: Number(m?.[2]) || 0 }; };
const EMPTY = { commit: null, note: null, answer: null, disputeHolds: null };

/** The prior findings with their ledger keys for this review as `cid`: C-01, C-02, … in the order given. */
export const withKeys = list => list.map((g, i) => ({ ...g, cid: `C-${String(i + 1).padStart(2, '0')}` }));

/**
 * A prior finding as the skeleton starts it, under its key. On a PR under review (`covered`), what decides whether
 * the PR is cleared is the placeholder: its status, and whether it is parked now. On a left-out PR it is `deferred`,
 * complete as it is.
 */
export function startingEntry(g, covered) {
  const { id, ref, cid, ...rest } = g; // eslint-disable-line no-unused-vars
  if (!covered) return { id: cid, ...rest, status: 'deferred', outcome: rest.outcome || { ...EMPTY } };
  return { id: cid, ...rest, status: TODO, earlier: { ...rest.earlier, parked: TODO }, outcome: { ...EMPTY } };
}

/** The start of a review's result. `keyed`: withKeys(prior findings); `leftOut`: { url: why } for each PR the checker lists that this review doesn't cover. */
export function resultSkeleton(run, keyed, leftOut = {}) {
  const covered = new Set(run.prs.map(p => p.url));
  return {
    skeleton: `Prowl's starting point for this review's result, not a result. Your script loads it, removes this key, replaces every "${TODO}", fills what is empty and adds this run's findings, then writes the result to the result path.`,
    version: 1,
    batchId: run.batchId,
    batch: { goal: TODO, mergeOrder: TODO, complete: TODO },
    prs: run.resultPrs.map(url => ({ url, reviewedAt: TODO, summary: TODO, role: TODO, related: [], conventions: [],
      ...(covered.has(url) ? { coverage: { axes: [TODO], clean: [], unverified: TODO }, earlierReviews: TODO }
        : { coverage: { axes: [], clean: [], unverified: `Not reviewed: ${leftOut[url] || 'context only'}.` }, earlierReviews: [] }) })),
    findings: keyed.map(g => startingEntry(g, covered.has(g.pr))),
    questions: [],
  };
}

/**
 * Writes a re-review's files into its prep folder: priors.json (every prior finding, whole, with its `cid`), one
 * priors.json per PR for its verifiers, and result-skeleton.json. Returns { all, byPr: { url: file }, skeleton, keyed }.
 * Throws when the folder can't be written: the findings then go in the prompt.
 */
export function writeHandover(run, list, { leftOut = {} } = {}) {
  const dir = prepDir(run);
  const keyed = withKeys(list);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 1)); return file; };
  const all = write(path.join(dir, 'priors.json'), keyed);
  const byPr = {};
  for (const url of [...new Set(keyed.map(g => g.pr))]) byPr[url] = write(path.join(dir, prFolder(prOf(url)), 'priors.json'), keyed.filter(g => g.pr === url));
  const skeleton = write(path.join(dir, 'result-skeleton.json'), resultSkeleton(run, keyed, leftOut)); // never where Prowl reads results
  return { all, byPr, skeleton, keyed };
}

/**
 * Whether a finding is in a PR's Parked list now (`lines`: `- <title> (<ref>): <note> · <link>`): a line holds
 * `(<its ref>):` exactly, or, for a finding with a thread, the text after the line's last ` · ` is its thread link.
 * Matched whole, never by a part; a line in another form matches nothing, and the finding counts.
 */
export function inParked(lines, earlier) {
  const ref = String(earlier?.ref || '').trim();
  const link = earlier?.threadId || earlier?.commentId ? String(earlier.url || '').trim() : '';
  return (lines || []).some(line => (ref && line.includes(`(${ref}):`)) || (link && line.includes(' · ') && line.slice(line.lastIndexOf(' · ') + 3).trim() === link));
}

/**
 * Fills a skeleton with what the setup established: the commit checked out for each PR, each PR's blocking reviews
 * when every one was read whole, each prior finding's thread and whether it is parked now, and the carried-over
 * findings. What it couldn't establish stays a placeholder, for the session. No skeleton, or an unreadable one: nothing.
 */
export function fillSkeleton(file, prep) {
  let sk;
  try { sk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!sk || typeof sk !== 'object' || !('skeleton' in sk) || !prep) return false;
  const c = prep.comments || {};
  for (const p of prep.prs || []) {
    const entry = (sk.prs || []).find(e => e.url === p.url);
    if (!entry) continue;
    if (entry.reviewedAt === TODO && p.worktree && !p.error && /^[0-9a-f]{40}$/.test(p.head)) entry.reviewedAt = p.head;
    if (entry.earlierReviews === TODO && p.role === 'review' && c.blocking?.[p.url]) entry.earlierReviews = c.blocking[p.url].map(r => ({ url: r.url, findings: [...r.findings] }));
  }
  for (const f of sk.findings || []) {
    const state = c.state?.[f.pr];
    if (!state || !f.earlier || f.status === 'deferred') continue;
    const own = state.threads.find(t => t.ref && t.ref === String(f.earlier.ref || '').trim()); // by its own marker
    if (own) Object.assign(f.earlier, { threadId: own.id, commentId: own.commentId, threadState: own.state });
    else { const named = f.earlier.threadId && state.threads.find(t => t.id === f.earlier.threadId); if (named) f.earlier.threadState = named.state; }
    if (f.earlier.parked === TODO) f.earlier.parked = inParked(state.parked, f.earlier);
  }
  for (const carried of Object.values(c.carried || {})) {
    try {
      for (const f of JSON.parse(fs.readFileSync(carried.file, 'utf8'))) {
        if (sk.findings.some(x => x.id === f.id || (x.pr === f.pr && String(x.earlier?.ref || '').trim() === f.earlier.ref))) continue;
        sk.findings.push(f);
      }
    } catch { /* a carried file that can't be read costs nothing else */ }
  }
  fs.writeFileSync(file, JSON.stringify(sk, null, 1));
  return true;
}

/**
 * The prompt's index of the prior findings, in place of the findings as JSON: what the files hold, then one line per
 * finding inside <previous-findings>. `keyed`: withKeys(); `files`: { all, byPr }.
 */
export function findingsIndex(keyed, files) {
  const cell = v => String(v ?? '').replace(/\s+/g, ' ').trim().replace(/</g, '&lt;');
  const perPr = Object.entries(files.byPr).map(([url, file]) => `${url}: \`${file}\``).join('; ');
  return {
    intro: `the previous review's findings in Prowl's context, one entry per finding still on the PRs. They are in files, not in this prompt: \`${files.all}\` has every one whole, as JSON (its key for this review as \`cid\`, its batch id and id as \`ref\`, status, severity, title, axis, location, problem, fix, detail, \`crossPr\`, \`consumer\` and \`outcome\` when it has them, and \`earlier\`), and each PR's are in a file of its own (${perPr}). Below is one line per finding: key | PR | status then | severity | thread | ref | title. Use each finding's \`cid\` as its ledger key (the skill's Step 5), give a verifier its PR's file by path instead of copying findings into its prompt, and read a finding's entry in the file when you need more than its line`,
    lines: ['<previous-findings>', ...keyed.map(g => `- ${g.cid} | ${cell(g.pr)} | ${cell(g.status)} | ${cell(g.severity)} | thread ${cell(g.earlier?.threadState || 'none')}${g.earlier?.parked ? ', parked' : ''} | ${cell(g.ref)} | ${cell(g.title)}`), '</previous-findings>'],
  };
}

/**
 * A result with Prowl's own reading of each PR's blocking reviews merged in, so an approval or a dismissal is never
 * judged on the session's list alone. `blocking`: { prUrl: [{ url, findings }] } for PRs whose blocking reviews were
 * all read whole; `partial`: { prUrl: { read, unread } } for PRs with one that wasn't. Every review Prowl read whole
 * is in earlierReviews with at least the findings Prowl read (matched by the review's id, not the URL's text); every
 * one it couldn't read in full is there marked `unread: true`. A PR whose comments Prowl didn't read keeps its list.
 */
export function withBlocking(result, blocking = {}, partial = {}) {
  if (!result || (!Object.keys(blocking || {}).length && !Object.keys(partial || {}).length)) return result;
  const out = structuredClone(result);
  for (const p of out.prs || []) {
    const read = blocking?.[p.url] || partial?.[p.url]?.read;
    const unread = partial?.[p.url]?.unread || [];
    if (!read && !unread.length) continue;
    if (!Array.isArray(p.earlierReviews)) p.earlierReviews = [];
    const entryFor = url => p.earlierReviews.find(e => reviewIdOf(e?.url, p.url) && reviewIdOf(e.url, p.url) === reviewIdOf(url, p.url));
    for (const r of read || []) {
      const e = entryFor(r.url);
      if (!e) { p.earlierReviews.push({ url: r.url, findings: [...r.findings] }); continue; }
      const has = new Set((e.findings || []).map(x => String(x).trim()));
      e.findings = [...(e.findings || []), ...r.findings.filter(x => !has.has(x))];
    }
    for (const url of unread) {
      const e = entryFor(url);
      if (e) e.unread = true;
      else p.earlierReviews.push({ url, findings: [], unread: true });
    }
  }
  return out;
}
