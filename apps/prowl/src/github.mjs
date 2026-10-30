import fs from 'node:fs';
import path from 'node:path';
import { run, runFull } from './proc.mjs';
import { mentions } from './match.mjs';

let login = '';
const jsonLines = out => out.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

/** The GitHub login of whoever runs the poller. Their own PRs are skipped unless Review my own PRs is on. */
export async function me() {
  return (login ||= (await run('gh', ['api', 'user', '--jq', '.login'])).trim());
}

/** Open PRs in `owner` whose title or body mentions the ticket key (AB#123 or PROJ-123), drafts marked `draft`. */
export const openPrs = (owner, key) => prsMentioning(owner, key, 'open');

/** PRs in `owner` whose title or body mentions the ticket key; `state` 'open', 'closed' or '' for both. */
export async function prsMentioning(owner, key, state = '') {
  const out = await run('gh', ['search', 'prs', `"${key}"`, '--owner', owner, ...(state ? ['--state', state] : []), '--limit', '100',
    '--json', 'url,title,body,author,number,repository,isDraft,state']);
  return JSON.parse(out)
    .filter(p => mentions(`${p.title} ${p.body}`, key)) // search is fuzzy; this keeps AB#123 from matching AB#1234
    .map(p => ({ url: p.url, title: p.title, number: p.number, repo: p.repository.nameWithOwner, author: p.author?.login || '', draft: Boolean(p.isDraft), state: p.state || '' }));
}

/**
 * The PRs in typed text: PR links (https://github.com/owner/repo/pull/12) or owner/repo#12, separated by spaces or
 * commas, each once, as [{ repo, number }]. A message naming what's wrong when there are none, or one isn't a PR.
 */
export function parsePrRefs(text) {
  const words = String(text).split(/[\s,]+/).filter(Boolean);
  if (!words.length) return 'Enter at least one PR';
  const refs = [];
  for (const w of words) {
    const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\/pull\/|#)(\d+)(?:[/?#].*)?$/i.exec(w);
    if (!m) return `${w} isn't a PR: use a PR link or owner/repo#12`;
    if (!refs.some(r => r.repo.toLowerCase() === m[1].toLowerCase() && r.number === Number(m[2]))) refs.push({ repo: m[1], number: Number(m[2]) });
  }
  return refs;
}

/** A PR by repo and number, in openPrs()'s shape, with its state: 'open', 'closed' or 'merged'. */
export async function prByRef({ repo, number }) {
  const p = JSON.parse(await run('gh', ['api', `repos/${repo}/pulls/${number}`, '--jq',
    '{url: .html_url, title, number, repo: .base.repo.full_name, author: .user.login, draft, state, merged: (.merged_at != null)}']));
  return { url: p.url, title: p.title, number: p.number, repo: p.repo, author: p.author || '', draft: Boolean(p.draft), state: p.merged ? 'merged' : p.state };
}

/** The commit at the head of the PR now. */
export async function headSha(pr) {
  return (await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}`, '--jq', '.head.sha'])).trim();
}

/**
 * True once the PR needs no approval from you: someone approved the commit Prowl stamped or the head now, or it
 * was merged or closed. Prowl itself never approves with Approve PRs off or on your own PR, so any approval is a human's.
 */
export async function humanApproved(url, sha) {
  const pr = JSON.parse(await run('gh', ['pr', 'view', url, '--json', 'state,headRefOid,reviews']));
  return pr.state !== 'OPEN' || pr.reviews.some(r => r.state === 'APPROVED' && [sha, pr.headRefOid].includes(r.commit?.oid));
}

/**
 * Whether `login` submitted a review on the PR at or after `since` (ms), from its reviews ([{ user, at, body }]). With a
 * `marker`, only a review whose body carries it is true: GitHub also files each thread reply as an empty COMMENT
 * review, which must not count. A non-empty review without the marker is 'unmarked': it counts, with a warning. An
 * empty `marker` (a review started before 2.12.0) counts any review.
 */
export function reviewedIn(rows, login, since, marker = '') {
  const mine = rows.filter(r => r.user?.toLowerCase() === login.toLowerCase() && Date.parse(r.at) >= since);
  if (!marker) return mine.length > 0;
  if (mine.some(r => String(r.body || '').includes(marker))) return true;
  return mine.some(r => String(r.body || '').trim()) ? 'unmarked' : false;
}

/** reviewedIn() for the PR's reviews on GitHub. */
export async function reviewedSince(pr, login, since, marker = '') {
  const rows = jsonLines(await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--paginate', '--jq', '.[] | {user: .user.login, at: .submitted_at, body}']));
  return reviewedIn(rows, login, since, marker);
}

/** True while the PR is open (not merged or closed). */
export async function isOpen(pr) {
  return (await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}`, '--jq', '.state'])).trim() === 'open';
}

/** Clones each PR's repo into `dir` unless a folder of that name is already there. Resolves with the repos cloned. */
export async function cloneMissing(prs, dir) {
  const cloned = [];
  for (const repo of new Set(prs.map(p => p.repo))) {
    const target = path.join(dir, repo.split('/')[1]);
    if (fs.existsSync(target)) continue;
    await run('gh', ['repo', 'clone', repo, target]);
    cloned.push(repo);
  }
  return cloned;
}

// What the Builder reads from a PR, and what it writes (a PR, a reply on a thread). postComment is the Reviewer's
// Review started comment.

const THREADS = 'query($owner:String!,$repo:String!,$n:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{'
  + 'id isResolved path line first:comments(first:1){nodes{databaseId author{login __typename} body url}} last:comments(last:1){nodes{author{login} body createdAt}}}}}}}';

/** A PR's review threads from the GraphQL payload: the first comment (replies go to it) and the last (who spoke last). */
export const threadsFrom = payload => (payload?.data?.repository?.pullRequest?.reviewThreads?.nodes || []).map(t => {
  const [first, last] = [t.first?.nodes?.[0] || {}, t.last?.nodes?.[0] || {}];
  return {
    id: t.id, resolved: Boolean(t.isResolved), path: t.path || '', line: t.line ?? null, commentId: first.databaseId,
    author: first.author?.login || '', bot: first.author?.__typename === 'Bot', body: first.body || '', url: first.url || '',
    lastAuthor: last.author?.login || '', lastBody: last.body || '', lastAt: last.createdAt || '',
  };
});

/** The PR's review threads, resolved or not: every page of them, as READY TO MERGE needs all. */
export async function prThreads(pr) {
  const [owner, repo] = pr.repo.split('/');
  const threads = [];
  let after = null;
  do {
    const page = JSON.parse(await run('gh', ['api', 'graphql', '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `n=${pr.number}`, ...(after ? ['-f', `after=${after}`] : []), '-f', `query=${THREADS}`]));
    threads.push(...threadsFrom(page));
    const info = page?.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
    after = info?.hasNextPage ? info.endCursor : null;
  } while (after);
  return threads;
}

/** What the Builder needs to know about a PR before it touches it. */
export async function prFacts(pr) {
  const v = JSON.parse(await run('gh', ['pr', 'view', pr.url, '--json', 'state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,author,reviewDecision']));
  return {
    state: v.state, draft: Boolean(v.isDraft), fork: Boolean(v.isCrossRepository), headBranch: v.headRefName, headSha: v.headRefOid, base: v.baseRefName,
    defaultBranch: await defaultBranch(pr.repo), author: v.author?.login || '', reviewDecision: v.reviewDecision || '',
  };
}

/**
 * The details file of the latest PR-Owl review of PR `<repo name>-<n>` that has one, from review bodies ([{ body, at }]) and
 * conversation comments ([{ body }]): the collapsed block whose summary names prowl-review-…-<repo>-<n>.md,
 * joined with its part 2 comment when there is one. '' when there is none or it can't be parsed.
 */
export function detailsFromBodies(reviews, comments, name) {
  const file = new RegExp(`<summary>[^<]*(prowl-review-[^<\\s]*-${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md)[^<]*</summary>`, 'i');
  const block = body => {
    const m = file.exec(body || '');
    if (!m) return null;
    const after = body.slice(m.index + m[0].length);
    const open = /^[ \t]*(`{3,}|~{3,})[^\n]*\n/m.exec(after);
    if (!open) return null;
    const rest = after.slice(open.index + open[0].length);
    const close = new RegExp(`^[ \\t]*${open[1]}[ \\t]*$`, 'm').exec(rest);
    return { file: m[1], text: (close ? rest.slice(0, close.index) : rest).trim(), part2: /part 2/i.test(m[0]) };
  };
  const latest = reviews.map(r => ({ ...r, d: block(r.body) })).filter(r => r.d && !r.d.part2).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!latest) return '';
  const part2 = comments.map(c => block(c.body)).find(d => d?.part2 && d.file === latest.d.file);
  return part2 ? `${latest.d.text}\n\n${part2.text}` : latest.d.text;
}

/** The details file from the PR's latest PR-Owl review on GitHub, for a ticket reviewed by someone else's Prowl. */
export async function detailsFromGitHub(pr) {
  const reviews = jsonLines(await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--paginate', '--jq', '.[] | {body, at: .submitted_at}']));
  const comments = jsonLines(await run('gh', ['api', `repos/${pr.repo}/issues/${pr.number}/comments`, '--paginate', '--jq', '.[] | {body}']));
  return detailsFromBodies(reviews, comments, `${pr.repo.split('/')[1]}-${pr.number}`);
}

/** The PR's reviews, leaving out bare thread replies (which GitHub also files as reviews): [{ user, state, at, body }]. */
export async function prReviews(pr) {
  return jsonLines(await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--paginate', '--jq', '.[] | select(.body != "" or .state != "COMMENTED") | {user: .user.login, state, at: .submitted_at, body}']));
}

/** The default branch of `repo` (owner/name). */
export async function defaultBranch(repo) {
  return (await run('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).trim();
}

/** Opens a PR; `file` holds { title, head, base, body, draft }. Resolves with { url, number }. */
export async function createPr(repo, file) {
  const [url, number] = (await run('gh', ['api', '-X', 'POST', `repos/${repo}/pulls`, '--input', file, '--jq', '[.html_url, .number] | @tsv'])).trim().split('\t');
  return { url, number: Number(number) };
}

/** The open PR from `branch` in `repo` (owner/name), as { url, number }, or null: one a create made before its answer was lost. */
export async function prForBranch(repo, branch) {
  const out = (await run('gh', ['api', `repos/${repo}/pulls?state=open&head=${repo.split('/')[0]}:${encodeURIComponent(branch)}`, '--jq', '.[0] | [.html_url, .number] | @tsv'])).trim();
  const [url, number] = out.split('\t');
  return url ? { url, number: Number(number) } : null;
}

/** Replaces a PR's body with the one in `file` ({ body }). */
export async function editPr(pr, file) {
  await run('gh', ['api', '-X', 'PATCH', `repos/${pr.repo}/pulls/${pr.number}`, '--input', file, '--jq', '.number']);
}

/** The bodies of every review comment on the PR (thread comments and replies). */
export async function prCommentBodies(pr) {
  return jsonLines(await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}/comments`, '--paginate', '--jq', '.[] | {body}'])).map(c => c.body || '');
}

/** Replies on the review thread whose first comment is `commentId`; the body is read from `bodyFile` ({ "body": … }). */
export async function postReply(pr, commentId, bodyFile) {
  return (await run('gh', ['api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/comments/${commentId}/replies`, '--input', bodyFile, '--jq', '.html_url'])).trim();
}

/** Posts a conversation comment on the PR; the body is read from `bodyFile` ({ "body": … }). Resolves with its URL. */
export async function postComment(pr, bodyFile) {
  return (await run('gh', ['api', '-X', 'POST', `repos/${pr.repo}/issues/${pr.number}/comments`, '--input', bodyFile, '--jq', '.html_url'])).trim();
}

/** 'green', 'failing' or 'pending' for a PR's required checks ([{ name, bucket }]); no required checks is green. */
export function checksState(checks) {
  if (checks.some(c => ['fail', 'cancel'].includes(c.bucket))) return 'failing';
  return checks.every(c => ['pass', 'skipping'].includes(c.bucket)) ? 'green' : 'pending';
}

/** The PR's required checks: [{ name, bucket, link }]. */
export async function requiredChecks(url) {
  // gh exits 1 when a check failed and 8 while some are pending, with the JSON still on stdout.
  const { code, out, err } = await runFull('gh', ['pr', 'checks', url, '--required', '--json', 'name,bucket,link']);
  if (out.trim().startsWith('[')) return JSON.parse(out);
  if (/no (required )?checks reported/i.test(err)) return [];
  throw new Error(`gh pr checks failed (${code}): ${(err || out).trim().split('\n')[0].slice(0, 240)}`);
}

/** The tail of a failed GitHub Actions run's log, from a check's link ('' for other CI). */
export async function failedLog(link, max = 4000) {
  const m = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/.exec(link || '');
  if (!m) return '';
  const out = await run('gh', ['run', 'view', m[2], '--repo', m[1], '--log-failed']).catch(() => '');
  return out.slice(-max);
}
