import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';
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
