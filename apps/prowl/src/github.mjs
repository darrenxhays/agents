import fs from 'node:fs';
import path from 'node:path';
import { run, runFull } from './proc.mjs';
import { mentions } from './match.mjs';

let login = '';

/** The GitHub login of whoever runs the poller. Their own PRs are skipped unless Review my own PRs is on. */
export async function me() {
  return (login ||= (await run('gh', ['api', 'user', '--jq', '.login'])).trim());
}

/** Open PRs in `owner` whose title or body mentions the ticket key (AB#123 or PROJ-123). */
export async function openPrs(owner, key) {
  const out = await run('gh', ['search', 'prs', `"${key}"`, '--owner', owner, '--state', 'open', '--limit', '100',
    '--json', 'url,title,body,author,number,repository']);
  return JSON.parse(out)
    .filter(p => mentions(`${p.title} ${p.body}`, key)) // search is fuzzy; this keeps AB#123 from matching AB#1234
    .map(p => ({ url: p.url, title: p.title, number: p.number, repo: p.repository.nameWithOwner, author: p.author?.login || '' }));
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

/** True once `login` has submitted a review on the PR at or after `since` (ms). */
export async function reviewedSince(pr, login, since) {
  const out = await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--paginate', '--jq', '.[] | [.user.login, .submitted_at] | @tsv']);
  return out.split('\n').some(line => {
    const [who, at] = line.split('\t');
    return who?.toLowerCase() === login.toLowerCase() && Date.parse(at) >= since;
  });
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

// Fix my PRs: what a fix round reads from a PR, and the one thing it writes (a reply on a thread).
// postComment is the poller's Review started comment.

const THREADS = 'query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100){nodes{'
  + 'id isResolved path line first:comments(first:1){nodes{databaseId author{login __typename} body url}} last:comments(last:1){nodes{author{login} body}}}}}}}';

/** A PR's review threads from the GraphQL payload: the first comment (replies go to it) and the last (who spoke last). */
export const threadsFrom = payload => (payload?.data?.repository?.pullRequest?.reviewThreads?.nodes || []).map(t => {
  const [first, last] = [t.first?.nodes?.[0] || {}, t.last?.nodes?.[0] || {}];
  return {
    id: t.id, resolved: Boolean(t.isResolved), path: t.path || '', line: t.line ?? null, commentId: first.databaseId,
    author: first.author?.login || '', bot: first.author?.__typename === 'Bot', body: first.body || '', url: first.url || '',
    lastAuthor: last.author?.login || '', lastBody: last.body || '',
  };
});

/** The PR's review threads, resolved or not (the first 100). */
export async function prThreads(pr) {
  const [owner, repo] = pr.repo.split('/');
  return threadsFrom(JSON.parse(await run('gh', ['api', 'graphql', '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `n=${pr.number}`, '-f', `query=${THREADS}`])));
}

/** What a fix round needs to know about a PR before it touches it. */
export async function prFacts(pr) {
  const v = JSON.parse(await run('gh', ['pr', 'view', pr.url, '--json', 'state,isCrossRepository,headRefName,headRefOid,baseRefName,author,reviewDecision']));
  const defaultBranch = (await run('gh', ['repo', 'view', pr.repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).trim();
  return {
    state: v.state, fork: Boolean(v.isCrossRepository), headBranch: v.headRefName, headSha: v.headRefOid, base: v.baseRefName,
    defaultBranch, author: v.author?.login || '', reviewDecision: v.reviewDecision || '',
  };
}

const jsonLines = out => out.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

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

/** When the PR's latest review was submitted (ms; 0 if none), leaving out bare thread replies, which GitHub also files as reviews. */
export async function lastReviewAt(pr) {
  const out = await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--paginate', '--jq', '.[] | select(.body != "" or .state != "COMMENTED") | .submitted_at']);
  return Math.max(0, ...out.split('\n').filter(Boolean).map(Date.parse).filter(Number.isFinite));
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
