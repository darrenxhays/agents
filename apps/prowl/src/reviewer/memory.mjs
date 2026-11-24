// Shared review memory: a finished review leaves a hand-over note on each PR it posted on (hidden in its own Review
// started comment), and the next review of the ticket carries on from the newest notes, whoever's Prowl runs it.
// Not src/reviewer/handover.mjs, which is the files a prepared re-review is handed.
import { postMarker, priorFindings, sameCommit } from './reviews.mjs';
import { isProwlReview } from './result.mjs';
import { CHANGES_MARKER } from '../feedback.mjs';

export const HANDOVER_VERSION = 1;
export const HANDOVER_LIMIT = 48_000; // the block as posted; a GitHub comment holds 65,536 characters
const UNVERIFIED_LIMIT = 2_000;
const NOTE_RE = /<!-- prowl-handover v(\d+)\r?\n([^\r\n]+)\r?\n-->/; // CRLF too: a comment edited in the browser comes back with them

/** A note as its hidden block: one line of JSON, with `--` and `<` escaped so no finding's text can end the comment or open a tag. */
export const handoverBlock = data => `<!-- prowl-handover v${HANDOVER_VERSION}\n${JSON.stringify(data).replace(/--/g, '-\\u002d').replace(/</g, '\\u003c')}\n-->`;

/** The note in a comment's body, or null: none, another version's, or not { run, pr, no }. */
export function parseHandover(body) {
  const m = NOTE_RE.exec(String(body || ''));
  if (!m || Number(m[1]) !== HANDOVER_VERSION) return null;
  try {
    const d = JSON.parse(m[2]);
    return d && typeof d === 'object' && typeof d.run === 'string' && typeof d.pr === 'string' && Number.isFinite(d.no) && wellFormed(d) ? d : null;
  } catch { return null; }
}

/** True when every field of a note that a later review reads has the shape it is read in: a damaged note is left unread, never half-used. */
function wellFormed(d) {
  const texts = v => Array.isArray(v) && v.every(x => typeof x === 'string');
  const map = v => v != null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');
  return Number.isFinite(d.at) && typeof d.ticket === 'string' && typeof d.by === 'string' && texts(d.prs) && texts(d.reviewed) && texts(d.awaiting)
    && map(d.approved) && map(d.approver) && map(d.heads) && map(d.unreviewed)
    && Array.isArray(d.findings) && d.findings.every(f => f && typeof f === 'object' && typeof f.pr === 'string' && typeof f.ref === 'string')
    && Array.isArray(d.unverified) && d.unverified.every(u => u && typeof u.url === 'string' && typeof u.text === 'string');
}

/**
 * Cuts a note to HANDOVER_LIMIT: first the write-up (`detail`) of other PRs' findings, largest first, then this PR's;
 * then whole findings from the end (other PRs' are last), counted in `cutOther` and `cut`; then what couldn't be checked.
 */
function fit(note) {
  const over = () => handoverBlock(note).length > HANDOVER_LIMIT;
  const other = f => f.pr !== note.pr;
  const largest = list => list.filter(f => f.detail != null).sort((a, b) => JSON.stringify(b.detail).length - JSON.stringify(a.detail).length)[0];
  while (over()) {
    const big = largest(note.findings.filter(other)) || largest(note.findings);
    if (big) delete big.detail;
    else if (note.findings.length) {
      const gone = note.findings.pop();
      if (other(gone)) note.cutOther = (note.cutOther || 0) + 1;
      else note.cut = (note.cut || 0) + 1;
    } else if (note.unverified.length) note.unverified.pop();
    else if (note.reviewed.length > note.prs.length) note.reviewed = [...note.prs]; // a ticket with very many PRs: this review's alone
    else return null; // its links and commits alone don't fit: no note
  }
  return note;
}

/**
 * The notes of a finished, published review: { prUrl: note } for each PR it posted a review on. `result`: its review
 * result; `reviewed`: every PR URL the ticket's reviews have covered so far, this one's included. Findings on a PR
 * the review didn't post on go in every note in that PR's own repo, so they outlive whichever PR merges first. Never
 * in another repo's: a note is hidden from the page, not from whoever can read the PR, and repos differ in who can.
 */
export function buildNotes(run, result, reviewed) {
  const posted = run.prs.map(p => p.url).filter(url => run.published?.[`review:${url}`]);
  const findings = priorFindings(run, result, run.resultPrs || run.prs.map(p => p.url));
  const unverified = (result.prs || []).map(p => ({ url: p.url, text: String(p.coverage?.unverified || '').replace(/\s+/g, ' ').trim().slice(0, UNVERIFIED_LIMIT) }))
    .filter(u => u.text && run.prs.some(p => p.url === u.url));
  const approved = run.approved || {};
  const notes = {};
  const repoOf = url => prOf(url).repo.toLowerCase();
  for (const pr of posted) {
    const here = url => repoOf(url) === repoOf(pr);
    const note = fit({
      run: run.id, batch: run.batchId, ticket: run.ticket, no: run.reviewNo, at: run.endedAt || Date.now(), by: run.me || '', pr,
      prs: run.prs.map(p => p.url), unreviewed: run.unreviewed || {}, approved,
      approver: Object.fromEntries(Object.keys(approved).map(url => [url, approverOf(run, url)])),
      awaiting: run.awaitingHuman || [], heads: run.reviewedHeads || {}, reviewed: [...reviewed],
      approvals: run.approvals !== false, parkHumanOnly: Boolean(run.parkHumanOnly),
      findings: structuredClone([...findings.filter(f => f.pr === pr), ...findings.filter(f => !posted.includes(f.pr) && here(f.pr))]), unverified: [...unverified.filter(u => u.url === pr), ...unverified.filter(u => u.url !== pr && here(u.url))],
    });
    if (note) notes[pr] = note;
  }
  return notes;
}

/** The id of the review that gave `run`'s approval of the PR at `url`: its own, or the earlier one it carried it from. */
export const approverOf = (run, url) => ((run.prs || []).some(p => p.url === url) ? run.id : run.approvedBy?.[url] || run.id);

/** approverOf() for a run from before approvals recorded their review: back along its previous runs (`runs`) to the last that reviewed the PR. */
export function approverIn(runs, run, url) {
  const seen = new Set(); // run ids are not always unique: never walk in a circle
  for (let r = run; r && !seen.has(r); r = runs.find(x => x.id === r.priorId && x.ticket === run.ticket && !seen.has(x))) {
    seen.add(r);
    if (r.approvedBy?.[url] || (r.prs || []).some(p => p.url === url)) return approverOf(r, url);
  }
  return run.id;
}

/** The body of the comment that holds a note: the finished line, the note, and the started marker, so it is still recognised as Prowl's own. */
export const noteBody = (line, note) => `${line}\n\n${handoverBlock(note)}\n<!-- prowl-review ${note.run} started -->`;

// Later review: by number first (the times are two machines' clocks), by time between two with one number.
export const newer = (a, b) => (a.no || 0) - (b.no || 0) || (a.at || 0) - (b.at || 0);

/** Notes grouped by the review that wrote them, latest first. Keyed by author too: a run id alone isn't unique across Prowls. */
export function byReview(notes) {
  const groups = new Map();
  const key = n => `${String(n.by || '').toLowerCase()} ${n.run}`;
  for (const n of notes) groups.set(key(n), [...(groups.get(key(n)) || []), n]);
  return [...groups.values()].sort((a, b) => newer(b[0], a[0]));
}

const same = (a, b) => Boolean(a) && String(a).toLowerCase() === String(b || '').toLowerCase();
// Who GitHub says may speak for a repo (a review's author_association): anyone can post a comment review on a public
// repo, banner and marker included, so an outsider's is never taken for a teammate's Prowl.
const member = r => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(r?.assoc);

/**
 * Whether a note is believed. `user`: whose comment holds it; `reviews`: that PR's; `authors`: of every open PR of the
 * ticket. Its writer must have posted that run's PR-Owl review on the same PR, and be the author of none of the
 * ticket's PRs: a note speaks for every PR of its ticket, and anyone can post a comment review on their own PR. And
 * that review must be by an owner, member or collaborator of the repo.
 */
export const noteTrusted = (note, user, reviews, authors = []) => Boolean(user) && ![authors].flat().some(a => same(user, a))
  && (reviews || []).some(r => same(r.user, user) && member(r) && isProwlReview(r.body) && String(r.body).includes(postMarker(note.run)));

/**
 * True while PR-Owl's latest review on a PR (`reviews`, oldest first) approves commit `sha`: state APPROVED, or a
 * COMMENTED review carrying `marker` (the stamp of the very review recorded as approving, with Approve PRs off) that
 * `author`, the PR's, didn't write. A dismissed approval doesn't count, nor an older one under a newer PR-Owl review.
 * Only reviews by `me` (this Prowl's login) or by an owner, member or collaborator of the repo are PR-Owl's here.
 */
export function prowlApproved(reviews, sha, { marker = '', author = '', me = '' } = {}) {
  const last = (reviews || []).filter(r => r.at && isProwlReview(r.body) && (same(r.user, me) || member(r))).pop();
  if (!last || !sameCommit(last.commit, sha)) return false;
  return last.state === 'APPROVED' || (last.state === 'COMMENTED' && Boolean(marker) && String(last.body).includes(marker) && !String(last.body).includes(CHANGES_MARKER) && !same(last.user, author));
}

const prOf = url => { const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url); return { url, repo: m?.[1] || 'unknown/unknown', number: Number(m?.[2]) || 0 }; };

/**
 * A previous review built from the notes one review left (`notes`), in the shape of a finished run from state, with
 * `shared: true` and its findings in `handover: { findings, unverified, cut }` in place of a result file. Each note
 * was cut to size on its own: of two copies of a finding the one with its `detail` is kept, and what is missing
 * overall is every note's `cut` plus the smallest `cutOther` (what one note cut of the other PRs' another may hold).
 */
export function priorFromNotes(notes) {
  const [n] = notes;
  const merged = k => Object.assign({}, ...notes.map(x => x[k] || {}));
  const findings = new Map();
  for (const f of notes.flatMap(x => x.findings || [])) {
    const key = `${f.pr} ${f.ref}`;
    if (!findings.has(key) || (findings.get(key).detail == null && f.detail != null)) findings.set(key, f);
  }
  const unverified = new Map(notes.flatMap(x => x.unverified || []).map(u => [`${u.url} ${u.text}`, u]));
  // A delta starts only where every finding is at hand: a PR the review posted on whose own note is missing here, or
  // whose note had to leave findings out, is read in full once it changes (an approved one too: it can hold minor findings).
  const [approved, whole] = [merged('approved'), new Set(notes.filter(x => !x.cut).map(x => x.pr))];
  // A PR the review only read: its findings travel in the notes of its own repo, unless one had to leave some out.
  const repoOf = url => prOf(url).repo.toLowerCase();
  const carried = url => !(n.prs || []).includes(url) && notes.some(x => !x.cutOther && repoOf(x.pr) === repoOf(url));
  const heads = Object.fromEntries(Object.entries(merged('heads')).filter(([url]) => whole.has(url) || carried(url)));
  return {
    id: n.run, batchId: n.batch, ticket: n.ticket, reviewNo: n.no, endedAt: n.at, me: n.by, status: 'done', shared: true,
    prs: (n.prs || []).map(prOf), contextPrs: [], reviewed: [...new Set(notes.flatMap(x => x.reviewed || []))],
    unreviewed: merged('unreviewed'), approved, approvedBy: merged('approver'), awaitingHuman: [...new Set(notes.flatMap(x => x.awaiting || []))],
    reviewedHeads: heads, approvals: n.approvals !== false, parkHumanOnly: Boolean(n.parkHumanOnly),
    handover: {
      findings: [...findings.values()].map(f => ({ ...f, detail: f.detail ?? {} })), unverified: [...unverified.values()],
      cut: notes.reduce((sum, x) => sum + (x.cut || 0), 0) + Math.min(...notes.map(x => x.cutOther || 0)),
    },
  };
}

/**
 * What a review being planned carries on from: { prior, reviewed, alsoApproved }. `prior`: the ticket's latest
 * finished review, this Prowl's own (`own`, from state) or a newer one built from a teammate's notes, as a copy with
 * each approval PR-Owl's latest review on the PR no longer gives taken out. `reviewed`: the PR URLs earlier reviews
 * covered. `alsoApproved`: { prUrl: head } for the PRs to cover that PR-Owl's latest review approves as they are now,
 * though `prior` doesn't say so.
 *
 * `ticket`: true when `key` is a real ticket (notes are read only then: a name two people gave their quick reviews
 * isn't one ticket). `cover`: the PRs the review would cover ([{ url, repo, number, author }]) and `heads` theirs;
 * `known`: the ticket's other open PRs already at hand; `lookup()`: resolves the rest, for a review of only some of
 * them. `runs`: every run in state. `gh`: { allReviews, issueComments }.
 */
export async function recall({ gh, log, me, key, ticket = false, own, runs = [], covered, cover, heads = {}, known = [], lookup = null }) {
  const reviewed = new Set(covered);
  const alsoApproved = {};
  let prior = own && { ...own, approved: { ...own.approved }, reviewedHeads: own.reviewedHeads && { ...own.reviewedHeads }, // a copy: a finished run in state is never changed
    approvedBy: Object.fromEntries(Object.keys(own.approved || {}).map(url => [url, approverIn(runs, own, url)])) };
  const all = new Map([...cover, ...known].map(p => [p.url, p]));
  let notes = ticket;
  if (notes && lookup) {
    try {
      for (const p of await lookup()) if (!all.has(p.url)) all.set(p.url, p);
    } catch (e) {
      notes = false; // the other PRs' authors are unknown, so a note can't be told from an author's
      log('warn', `${key}: couldn't look up its other PRs (${e.message}), so no hand-over note is read this time; going by this Prowl's own reviews`, `memory-lookup:${key}`);
    }
  }
  const read = {}; // PR URL -> { reviews, comments }
  const wanted = notes ? [...all.values()] : cover;
  for (const pr of wanted) {
    try {
      read[pr.url] = { reviews: await gh.allReviews(pr), comments: [] };
    } catch { continue; } // this PR keeps what was recorded
    if (notes) read[pr.url].comments = await gh.issueComments(pr).catch(() => []); // unread: no note from it, and its reviews still count
  }
  if (wanted.length && !Object.keys(read).length) {
    log('warn', `${key}: couldn't read its PRs' reviews on GitHub; going by this Prowl's own reviews`, `memory-read:${key}`);
    return { prior, reviewed, alsoApproved };
  }

  if (notes) {
    const mine = new Set(runs.filter(r => r.ticket === key).map(r => r.id));
    const found = [];
    for (const [url, { comments }] of Object.entries(read)) {
      for (const c of comments) {
        const n = parseHandover(c.body);
        if (!n || n.ticket !== key || n.pr !== url || !same(n.by, c.user) || (mine.has(n.run) && same(n.by, me))) continue;
        found.push({ ...n, user: c.user });
      }
    }
    const authors = [...all.values()].map(p => p.author).filter(Boolean);
    const ownMark = own && { no: own.reviewNo, at: own.endedAt };
    for (const group of byReview(found)) {
      if (ownMark && newer(ownMark, group[0]) >= 0) break; // this Prowl's own last review is not older
      const trusted = group.filter(n => noteTrusted(n, n.user, read[n.pr].reviews, authors));
      if (!trusted.length) continue;
      prior = priorFromNotes(trusted);
      for (const url of [...prior.reviewed, ...prior.prs.map(p => p.url)]) reviewed.add(url);
      log('info', `${key}: its last review (review ${prior.reviewNo}) was run by @${prior.me}'s Prowl; carrying on from the hand-over note it left on the PRs`, `memory:${key}:${prior.id}`);
      break;
    }
  }

  // A recorded approval stands only while PR-Owl's latest review on the PR still gives it at that commit.
  for (const [url, sha] of Object.entries(prior?.approved || {})) {
    if (!read[url]) continue; // not read here: it keeps what was recorded
    if (prowlApproved(read[url].reviews, sha, { marker: postMarker(prior.approvedBy?.[url] || prior.id), author: prior.shared ? all.get(url)?.author : '', me })) continue;
    delete prior.approved[url];
    if (prior.reviewedHeads) delete prior.reviewedHeads[url]; // no delta from the commit it was approved at: it is read in full
    if (prior.awaitingHuman) prior.awaitingHuman = prior.awaitingHuman.filter(u => u !== url);
    log('info', `${key}: ${url} was approved by review ${prior.reviewNo}, but PR-Owl's latest review on it no longer approves that commit; it is reviewed again`, `memory-approval:${url}:${sha}`);
  }
  for (const pr of cover) {
    const head = heads[pr.url];
    if (head && read[pr.url] && prior?.approved?.[pr.url] !== head && prowlApproved(read[pr.url].reviews, head, { me })) alsoApproved[pr.url] = head;
  }
  return { prior, reviewed, alsoApproved };
}
