// A review's result: the JSON file a review session writes to say what it found, PR by PR, and how each finding
// relates to what is already on the PR. The session only describes; Prowl checks the file here, then decides and
// posts everything itself (publish-plan.mjs, publish.mjs). No imports: `prowl --check-result` loads only this file.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit']; // most severe first
/** What Prowl's result skeleton holds where the session has still to decide: a result with one left in is refused. */
export const TODO = '<prowl-todo>';

const NEW_STATUSES = ['confirmed', 'refuted', 'addressed-elsewhere', 'withdrawn', 'disputed', 'unverifiable'];
const PRIOR_STATUSES = ['fixed', 'still-present', 'answered', 'no-longer-applies', 'unverifiable', 'needs-person', 'deferred'];
const NEEDS_NOTE = ['refuted', 'addressed-elsewhere', 'withdrawn', 'disputed', 'unverifiable', 'still-present', 'no-longer-applies', 'needs-person'];
const REF = /^rb-\d{8}-\S+ [FC]-\d+$/;

const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string';
const filled = v => isStr(v) && v.trim() !== '';
const strOrNull = v => v == null || isStr(v);
const posInt = v => Number.isInteger(v) && v > 0;

/** Where the placeholder is still in `value`, as paths (batch.goal, findings[2].status). */
export function todoPaths(value, at = '') {
  if (value === TODO) return [at];
  if (Array.isArray(value)) return value.flatMap((v, i) => todoPaths(v, `${at}[${i}]`));
  if (isObj(value)) return Object.entries(value).flatMap(([k, v]) => todoPaths(v, at ? `${at}.${k}` : k));
  return [];
}

/**
 * What is wrong with a review result, a plain sentence per problem ('<where>: <what>'); [] when it is valid. `json`:
 * the parsed object, or the file's text. `batchId`: the batch id Prowl gave. `prUrls`: the PRs the result must have
 * an entry for, no more and no fewer. Unknown extra fields are allowed everywhere.
 */
export function checkResult(json, { batchId = '', prUrls = null } = {}) {
  let r = json;
  if (isStr(json)) {
    try { r = JSON.parse(json); } catch (e) { return [`it isn't valid JSON: ${e.message}`]; }
  }
  if (!isObj(r)) return ['it must be a JSON object'];
  if (r.version !== 1) return [`version must be 1 (it is ${JSON.stringify(r.version)})`];
  // Prowl's skeleton, or a part of it left unfilled, never passes as a result.
  const unfinished = [];
  if ('skeleton' in r) unfinished.push("skeleton: this is still Prowl's skeleton: remove the skeleton key once every part is filled in");
  const todo = todoPaths({ ...r, skeleton: undefined });
  if (todo.length) unfinished.push(`${todo.slice(0, 8).join(', ')}${todo.length > 8 ? ` and ${todo.length - 8} more` : ''}: still "${TODO}" from Prowl's skeleton: set ${todo.length > 1 ? 'each' : 'it'}`);
  if (unfinished.length) return unfinished;

  const out = [];
  const bad = (where, what) => out.push(`${where}: ${what}`);
  if (!isStr(r.batchId) || !/^rb-\d{8}-\S+$/.test(r.batchId)) bad('batchId', 'must be a batch id (rb-<yyyymmdd>-…)');
  else if (batchId && r.batchId !== batchId) bad('batchId', `must be the batch id Prowl gave, ${batchId}`);
  if (!isObj(r.batch)) bad('batch', 'must be an object with goal, mergeOrder and complete');
  else for (const k of ['goal', 'mergeOrder', 'complete']) if (!isStr(r.batch[k])) bad(`batch.${k}`, 'must be text');
  if ('questions' in r && !Array.isArray(r.questions)) bad('questions', 'must be a list');

  const prs = Array.isArray(r.prs) ? r.prs : [];
  if (!Array.isArray(r.prs)) bad('prs', 'must be a list');
  const seen = new Set();
  prs.forEach((p, i) => {
    const at = `prs[${i}]`;
    if (!isObj(p)) return bad(at, 'must be an object');
    if (!filled(p.url)) bad(`${at}.url`, 'must be the PR URL');
    else if (seen.has(p.url)) bad(`${at}.url`, `${p.url} is listed twice`);
    else if (prUrls && !prUrls.includes(p.url)) bad(`${at}.url`, `${p.url} isn't one of the PRs the checker lists`);
    if (filled(p.url)) seen.add(p.url);
    const cov = isObj(p.coverage) ? p.coverage : null;
    if (p.reviewedAt === null) {
      if (!filled(cov?.unverified)) bad(`${at}.reviewedAt`, "may be null only for a PR that couldn't be read, with coverage.unverified saying why");
    } else if (!isStr(p.reviewedAt) || !/^[0-9a-f]{40}$/.test(p.reviewedAt)) bad(`${at}.reviewedAt`, 'must be the full 40-character lower-case head SHA the verifiers checked, or null');
    for (const k of ['summary', 'role']) if (!isStr(p[k])) bad(`${at}.${k}`, 'must be text');
    if (!Array.isArray(p.related)) bad(`${at}.related`, 'must be a list');
    else p.related.forEach((x, j) => { if (!isObj(x) || !filled(x.url) || !isStr(x.shares)) bad(`${at}.related[${j}]`, 'needs a url and shares, as text'); });
    if (!cov) bad(`${at}.coverage`, 'must be an object with axes, clean and unverified');
    else {
      for (const k of ['axes', 'clean']) if (!Array.isArray(cov[k]) || !cov[k].every(filled)) bad(`${at}.coverage.${k}`, 'must be a list of names');
      if (!strOrNull(cov.unverified)) bad(`${at}.coverage.unverified`, 'must be text or null');
    }
    if (!Array.isArray(p.earlierReviews)) bad(`${at}.earlierReviews`, 'must be a list');
    else {
      p.earlierReviews.forEach((x, j) => {
        if (!isObj(x) || !filled(x.url)) return bad(`${at}.earlierReviews[${j}]`, "needs the review's url");
        if (!Array.isArray(x.findings) || !x.findings.every(f => isStr(f) && REF.test(f.trim()))) bad(`${at}.earlierReviews[${j}].findings`, 'must be a list of refs, each "<batch-id> <F-id>"');
        return undefined;
      });
    }
    if ('conventions' in p && !(Array.isArray(p.conventions) && p.conventions.every(isStr))) bad(`${at}.conventions`, 'must be a list of paths');
    return undefined;
  });
  for (const url of prUrls || []) if (!seen.has(url)) bad('prs', `${url} has no entry: every PR the checker lists needs one`);

  if (!Array.isArray(r.findings)) bad('findings', 'must be a list');
  const ids = new Set();
  const refs = new Set();
  (Array.isArray(r.findings) ? r.findings : []).forEach((f, i) => {
    if (!isObj(f)) return bad(`findings[${i}]`, 'must be an object');
    const kind = isStr(f.id) ? /^([FC])-\d+$/.exec(f.id)?.[1] : '';
    const at = `findings[${i}]${isStr(f.id) ? ` (${f.id})` : ''}`;
    if (!kind) bad(`${at}.id`, 'must be F-<n> (found by this run) or C-<n> (an earlier PR-Owl finding)');
    const statuses = kind === 'C' ? PRIOR_STATUSES : NEW_STATUSES;
    const known = !kind || statuses.includes(f.status);
    if (kind && !known) bad(`${at}.status`, `must be one of ${statuses.join(', ')} for ${kind === 'C' ? 'an earlier finding (C-)' : "this run's finding (F-)"}`);
    if (!filled(f.pr)) bad(`${at}.pr`, 'must be the PR URL');
    else {
      // A deferred finding (on a PR left out of the review) may name a PR outside prs, unless the checker lists the PRs.
      if (prUrls && !prUrls.includes(f.pr)) bad(`${at}.pr`, `${f.pr} isn't one of the PRs the checker lists`);
      else if (f.status !== 'deferred' && !seen.has(f.pr)) bad(`${at}.pr`, `${f.pr} has no entry in prs`);
      if (kind) { const k = `${f.pr} ${f.id}`; if (ids.has(k)) bad(`${at}.id`, `${f.id} is used twice on ${f.pr}`); ids.add(k); }
    }
    if (!SEVERITIES.includes(f.severity)) bad(`${at}.severity`, `must be one of ${SEVERITIES.join(', ')}`);
    if (!filled(f.title)) bad(`${at}.title`, 'must be text');
    for (const k of ['axis', 'problem', 'fix']) if (!isStr(f[k])) bad(`${at}.${k}`, 'must be text');
    if (['confirmed', 'still-present', 'needs-person'].includes(f.status)) for (const k of ['problem', 'fix']) if (isStr(f[k]) && !f[k].trim()) bad(`${at}.${k}`, `can't be blank for a ${f.status} finding`);
    if (!('location' in f)) bad(`${at}.location`, 'is required: null when the finding has no single place');
    else if (f.location !== null) {
      const l = f.location;
      if (!isObj(l) || !filled(l.path)) bad(`${at}.location`, 'must be null, or an object with a path');
      else {
        if (l.line != null && !posInt(l.line)) bad(`${at}.location.line`, 'must be a line number');
        if (l.startLine != null && (!posInt(l.startLine) || !posInt(l.line) || l.startLine > l.line)) bad(`${at}.location.startLine`, 'must be null, or a line number no greater than line');
      }
    }
    if (!isObj(f.detail)) bad(`${at}.detail`, 'must be an object');
    else {
      for (const k of ['explanation', 'scenario', 'fixDetail', 'check', 'verification']) if (f.detail[k] != null && !isStr(f.detail[k])) bad(`${at}.detail.${k}`, 'must be text');
      const q = f.detail.quote;
      if (q != null && !(isObj(q) && isStr(q.code) && (q.language == null || isStr(q.language)))) bad(`${at}.detail.quote`, 'must be null, or { code, language }');
    }
    if (f.crossPr != null && !(isObj(f.crossPr) && filled(f.crossPr.counterpart) && isStr(f.crossPr.fixBelongsTo) && isStr(f.crossPr.why))) bad(`${at}.crossPr`, 'needs counterpart, fixBelongsTo and why');
    if (f.status === 'addressed-elsewhere' && f.crossPr == null) bad(`${at}.crossPr`, 'is required for addressed-elsewhere: it names the PR that handles it');
    if (f.consumer != null && !(isObj(f.consumer) && filled(f.consumer.repo) && filled(f.consumer.path))) bad(`${at}.consumer`, 'needs a repo and a path');
    const e = f.earlier;
    if (e != null) {
      if (!isObj(e) || !['prowl', 'someone-else'].includes(e.by)) bad(`${at}.earlier.by`, 'must be prowl or someone-else');
      else {
        if (!['open', 'resolved', 'outdated', 'none'].includes(e.threadState)) bad(`${at}.earlier.threadState`, 'must be open, resolved, outdated or none');
        for (const k of ['author', 'url', 'threadId', 'raisedAt']) if (!strOrNull(e[k])) bad(`${at}.earlier.${k}`, 'must be text or null');
        if (e.commentId != null && !posInt(e.commentId)) bad(`${at}.earlier.commentId`, "must be the thread's first comment's databaseId, or null");
        if (e.threadId && e.commentId == null) bad(`${at}.earlier.commentId`, 'is required with a threadId');
        if (e.threadId && e.threadState === 'none') bad(`${at}.earlier.threadState`, "can't be none with a threadId");
        if (e.by === 'prowl') {
          if (kind === 'F') bad(`${at}.earlier.by`, 'an earlier PR-Owl finding is a C-<n> entry, not an F-<n> one');
          if (!isStr(e.ref) || !REF.test(e.ref.trim())) bad(`${at}.earlier.ref`, 'must be "<batch-id> <F-id>"');
          else if (filled(f.pr)) { const k = `${f.pr} ${e.ref.trim()}`; if (refs.has(k)) bad(`${at}.earlier.ref`, `${e.ref.trim()} is carried by two entries on ${f.pr}: merge them into one`); refs.add(k); }
        } else if (typeof e.statesItFully !== 'boolean') bad(`${at}.earlier.statesItFully`, 'must be true or false');
        if (e.parked != null && typeof e.parked !== 'boolean') bad(`${at}.earlier.parked`, 'must be true or false');
      }
    }
    if (kind === 'C' && !(isObj(e) && e.by === 'prowl')) bad(`${at}.earlier`, 'is required for an earlier finding, with by: "prowl"');
    const o = f.outcome;
    if (o != null && !isObj(o)) bad(`${at}.outcome`, 'must be an object');
    else if (o) {
      for (const k of ['commit', 'note', 'answer']) if (o[k] != null && !isStr(o[k])) bad(`${at}.outcome.${k}`, 'must be text');
      if (o.disputeHolds != null && typeof o.disputeHolds !== 'boolean') bad(`${at}.outcome.disputeHolds`, 'must be true or false');
    }
    if (known) {
      if (f.status === 'fixed' && !/^[0-9a-f]{7,40}$/i.test(String(o?.commit ?? ''))) bad(`${at}.outcome.commit`, "must be the fixing commit's SHA for a fixed finding");
      if (f.status === 'answered' && !String(o?.answer ?? '').startsWith('https://github.com/')) bad(`${at}.outcome.answer`, "must be the link to the person's answer on GitHub");
      if (NEEDS_NOTE.includes(f.status) && !filled(o?.note)) bad(`${at}.outcome.note`, `is required for a ${f.status} finding: one line saying why`);
    }
    return undefined;
  });
  return out;
}

// ---- Counting, the verdict and the event ----

/** Parked: answered; needing a person (with Park human-only findings on, or parked before); or unverifiable and parked before. */
export const isParked = (f, { parkHumanOnly = false } = {}) => (f.status === 'answered' ? true
  : f.status === 'needs-person' ? Boolean(parkHumanOnly || f.earlier?.parked)
    : f.status === 'unverifiable' && Boolean(f.earlier?.parked));

/** Counted toward the verdict: confirmed, still present, or needing a person and not parked. */
export const isCounted = (f, opts = {}) => f.status === 'confirmed' || f.status === 'still-present' || (f.status === 'needs-person' && !isParked(f, opts));

/** Low, nit or nothing: a PR with no worse counted finding can be approved. */
export const approvable = severity => !severity || severity === 'low' || severity === 'nit';

/** The highest severity among `findings`' counted ones, or '' for none. */
export const worst = (findings, opts = {}) => SEVERITIES.find(s => findings.some(f => f.severity === s && isCounted(f, opts))) || '';

/** Most severe first, in the order given within a severity. */
export const bySeverity = findings => [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

const DEFAULT_LABELS = { critical: 'BLOCK', high: 'REQUEST CHANGES', medium: 'REQUEST CHANGES', low: 'APPROVE WITH NITS', nit: 'APPROVE WITH NITS', none: 'APPROVE' };
/**
 * The verdict label for each severity (and `none`), from a review.md: the first markdown table whose second column
 * is headed Verdict, wherever it sits, each row's first cell searched for the severity names. A row that can't be
 * read keeps its default.
 */
export function verdictLabels(reviewMd) {
  const labels = { ...DEFAULT_LABELS };
  const rows = String(reviewMd || '').split(/\r?\n/).map(l => l.trim());
  const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const head = rows.findIndex((l, i) => l.startsWith('|') && /^verdict$/i.test(cells(l)[1] || '') && /^\|?[\s:|-]+\|?$/.test(rows[i + 1] || ''));
  if (head < 0) return labels;
  for (let i = head + 2; i < rows.length && rows[i].startsWith('|'); i++) {
    const [first, label] = cells(rows[i]);
    if (!label) continue;
    for (const s of SEVERITIES) if (new RegExp(`\\b${s}\\b`, 'i').test(first)) labels[s] = label;
    if (/\bnone\b|\bno findings\b/i.test(first)) labels.none = label;
  }
  return labels;
}

export const NOT_FULLY = 'NOT FULLY REVIEWED';

/** The PR's review as GitHub takes it, from its highest counted severity. `own`: your own PR; `approvals`: Approve PRs. */
export function eventFor({ severity, own = false, approvals = true }) {
  const ok = approvable(severity);
  if (own) return { event: 'COMMENT', noBlocking: false, approval: ok ? 'awaiting-human' : null };
  if (!ok) return { event: 'REQUEST_CHANGES', noBlocking: false, approval: null };
  return approvals ? { event: 'APPROVE', noBlocking: false, approval: 'approved' } : { event: 'COMMENT', noBlocking: true, approval: 'awaiting-human' };
}

const trimmed = s => String(s ?? '').trim();
/** The findings of `result` on `prUrl`. */
export const findingsOn = (result, prUrl) => (result.findings || []).filter(f => f.pr === prUrl);

/**
 * Why a reviewed PR isn't fully reviewed, as reasons: its coverage.unverified text, each unverifiable finding that
 * isn't parked, each deferred finding on it, and no review axis covered. Any one withholds the approval.
 */
export function notChecked(result, prUrl, opts = {}) {
  const pr = (result.prs || []).find(p => p.url === prUrl);
  const reasons = [];
  for (const r of pr?.earlierReviews || []) if (r?.unread) reasons.push(`an earlier PR-Owl review couldn't be read in full (${r.url}): check its findings yourself, dismiss it on GitHub, then review again`);
  if (trimmed(pr?.coverage?.unverified)) reasons.push(trimmed(pr.coverage.unverified));
  for (const f of findingsOn(result, prUrl)) {
    if (f.status === 'unverifiable' && !isParked(f, opts)) reasons.push(`${f.id} ${f.title} couldn't be verified`);
    if (f.status === 'deferred') reasons.push(`${f.id} ${f.title} was left for a later review`);
  }
  if (!(pr?.coverage?.axes || []).some(a => trimmed(a))) reasons.push('no review axis was covered');
  return reasons;
}

/**
 * The refs the result owes on `prUrl`: every ref Prowl gave the session for that PR (`given`), and every ref its
 * earlierReviews list, that no C- finding on the same PR with earlier.by "prowl" carries as its earlier.ref.
 */
export function notCarried(result, prUrl, given = []) {
  const pr = (result.prs || []).find(p => p.url === prUrl);
  const carried = new Set(findingsOn(result, prUrl).filter(f => String(f.id).startsWith('C-') && f.earlier?.by === 'prowl').map(f => trimmed(f.earlier.ref)));
  const wanted = [...given, ...(pr?.earlierReviews || []).flatMap(r => r?.findings || [])].map(trimmed).filter(Boolean);
  return [...new Set(wanted)].filter(ref => !carried.has(ref));
}

/**
 * The report's front matter numbers: counted findings on the reviewed PRs (`reviewed`: their URLs) by severity,
 * `fixed` (findings verified fixed) and `stillOpen` (counted earlier findings).
 */
export function counts(result, reviewed, opts = {}) {
  const on = (result.findings || []).filter(f => reviewed.includes(f.pr));
  const c = Object.fromEntries(SEVERITIES.map(s => [s, on.filter(f => f.severity === s && isCounted(f, opts)).length]));
  return { ...c, fixed: on.filter(f => f.status === 'fixed').length, stillOpen: on.filter(f => String(f.id).startsWith('C-') && isCounted(f, opts)).length };
}

// ---- Earlier PR-Owl reviews, as they are on a PR ----

const BANNER_RE = /^\s*(?:`{3,10}|~{3,10})[^\n]*\n(?:(?![ \t]*(?:`{3}|~{3}))[^\n]*\n)*?(?![ \t]*(?:`{3}|~{3}))[^\n]*\brb-\d{8}-/;
/**
 * True for a review body PR-Owl wrote: it opens with the review banner's fence, with an rb-<8 digits>- batch id
 * inside that first fenced block (only its first 4000 characters are searched), and it carries a prowl-review (or
 * older review-batch) marker. A person quoting a whole review inside a longer fence doesn't match.
 */
export const isProwlReview = body => BANNER_RE.test(String(body || '').slice(0, 4000)) && /<!-- (prowl-review|review-batch) /.test(String(body || ''));

/**
 * The findings earlier PR-Owl reviews checked and found not to be defects, from the hidden notes in their bodies:
 * [{ line, url }], a `refuted: <where> | <title> | <why>` line each. `reviews`: [{ body, url }]. A block quoted in a
 * body that isn't a PR-Owl review is ignored. They are leads for a later review, never verdicts.
 */
export function refutedLines(reviews) {
  const out = [];
  for (const r of reviews || []) {
    if (!isProwlReview(r.body)) continue;
    for (const m of String(r.body).matchAll(/<!-- prowl-state\r?\n([\s\S]*?)-->/g)) {
      for (const line of m[1].split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('refuted:'))) out.push({ line, url: r.url || '' });
    }
  }
  return out;
}
