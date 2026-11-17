// What the details view reads from a review's result: the findings as a filtered list, and the links to what a
// finding or a PR has on GitHub. The result is a session's text, not Prowl's: nothing here trusts it beyond its shape.
import fs from 'node:fs';
import { cached } from '../details.mjs';
import { bySeverity, checkResult, isCounted, isParked, SEVERITIES } from './result.mjs';

/**
 * A review's result for the details view: { state: 'ok' | 'invalid' | 'missing', result }. Kept until the file
 * changes (looked at every 2 seconds while `live`, when a session may be writing it).
 */
export function readResult(file, { live = false } = {}) {
  if (!file) return { state: 'missing', result: null };
  const value = cached(file, 'result', f => {
    try {
      const text = fs.readFileSync(f, 'utf8');
      return checkResult(text).length ? { state: 'invalid', result: null } : { state: 'ok', result: JSON.parse(text) };
    } catch {
      return { state: 'invalid', result: null };
    }
  }, { every: live ? 2000 : 0 });
  return value || { state: 'missing', result: null };
}

export const STATUS_FILTERS = ['all', 'counted', 'fixed or answered', 'dropped', 'parked', 'deferred'];
export const SEVERITY_FILTERS = ['any severity', 'critical', 'high or worse', 'medium or worse', 'low or worse'];
const DONE = ['fixed', 'answered', 'no-longer-applies'];
const DROPPED = ['refuted', 'addressed-elsewhere', 'withdrawn', 'disputed', 'unverifiable'];

/**
 * The findings of `result` the filters let through (`status`, `severity`: indexes into the two lists), those that
 * count toward the verdict first, then the rest, each group most severe first. `opts`: { parkHumanOnly }, as the review ran.
 */
export function findingsFor(result, { status = 0, severity = 0 } = {}, opts = {}) {
  const counted = f => isCounted(f, opts);
  const parked = f => isParked(f, opts);
  const byStatus = [() => true, counted, f => DONE.includes(f.status) && !parked(f), f => DROPPED.includes(f.status) && !parked(f), parked, f => f.status === 'deferred'][status] || (() => true);
  const worst = severity ? SEVERITIES.slice(0, severity) : SEVERITIES;
  const list = (result?.findings || []).filter(f => byStatus(f) && worst.includes(f.severity));
  const sorted = fs2 => bySeverity(fs2);
  return [...sorted(list.filter(counted)), ...sorted(list.filter(f => !counted(f)))];
}

/** A URL from a result, shown as a link and opened only when it is a plain https one. */
export const webLink = u => (typeof u === 'string' && /^https:\/\/\S+$/.test(u) ? u : '');

/**
 * Where a finding is, on GitHub at the commit its PR was reviewed at: <repo>/blob/<sha>/<path>#L<line> (or
 * #L<start>-L<line>). '' when it has no path, its PR no reviewed commit, or the PR's URL isn't a GitHub pull URL.
 */
export function findingUrl(finding, result) {
  const m = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/pull\/\d+$/.exec(String(finding?.pr || ''));
  const sha = (result?.prs || []).find(p => p.url === finding?.pr)?.reviewedAt;
  const loc = finding?.location;
  if (!m || !loc?.path || !/^[0-9a-f]{7,40}$/.test(String(sha || ''))) return '';
  const line = Number.isInteger(loc.line) && loc.line > 0 ? (Number.isInteger(loc.startLine) && loc.startLine > 0 && loc.startLine < loc.line ? `#L${loc.startLine}-L${loc.line}` : `#L${loc.line}`) : '';
  return `${m[1]}/blob/${sha}/${String(loc.path).split('/').map(encodeURIComponent).join('/')}${line}`;
}

/** What Prowl posted for a finding: [{ what: 'comment' | 'reply' | 'reopen' | 'resolve', url }], url '' when publishing recorded none. */
export const findingLinks = (finding, published = {}) => ['comment', 'reply', 'reopen', 'resolve']
  .filter(what => published?.[`${what}:${finding.pr}:${finding.id}`]).map(what => ({ what, url: webLink(published[`${what}:${finding.pr}:${finding.id}`]) }));

/** What Prowl posted on a PR: its review, and the second part of its details file. */
export const prLinks = (prUrl, published = {}) => [['review', 'review'], ['part2', 'details part 2']]
  .filter(([k]) => published?.[`${k}:${prUrl}`]).map(([k, what]) => ({ what, url: webLink(published[`${k}:${prUrl}`]) }));
