import { run } from './proc.mjs';
import { mentions } from './match.mjs';

let login = '';

/** The GitHub login of whoever runs the poller. Their own PRs are never picked up. */
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

/** True once `login` has submitted a review on the PR at or after `since` (ms). */
export async function reviewedSince(pr, login, since) {
  const out = await run('gh', ['api', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--paginate', '--jq', '.[] | [.user.login, .submitted_at] | @tsv']);
  return out.split('\n').some(line => {
    const [who, at] = line.split('\t');
    return who?.toLowerCase() === login.toLowerCase() && Date.parse(at) >= since;
  });
}
