// The Builder's decisions: repos, bases, branch names, the result contract, caps, follow-up and Ready to merge. Pure
// functions, covered by `node prowl.mjs --self-test`.
import path from 'node:path';
import fs from 'node:fs';
import { globRe } from '../checks.mjs';
import { actionable, questionShape } from '../feedback.mjs';
import { checksState } from '../github.mjs';
import { norm, tagMatches } from '../match.mjs';

/**
 * The Builder's tag matchers: the start tag loosely (with the typo tolerance), the ones it sets itself exactly. Its
 * done tag is the Reviewer's trigger tag, and a ticket the Reviewer has claimed carries the Reviewer's in-progress tag.
 */
export function builderTags(cfg) {
  const { start, inProgress } = cfg.builder.tags;
  const { trigger: done, inProgress: reviewing } = cfg.tags;
  const ours = t => [inProgress, done, reviewing].some(x => norm(x) === norm(t));
  const isStart = t => !ours(t) && tagMatches(t, start, cfg.tagMatchMaxTypos);
  return { isStart, ours, owned: t => isStart(t) || ours(t), has: (tags, tag) => tags.some(t => norm(t) === norm(tag)) };
}

/** A branch-name slug of a ticket title: lowercase words joined by dashes, at most 40 characters. */
export function slug(title) {
  const words = String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let out = '';
  for (const word of words) {
    if (out && out.length + word.length + 1 > 40) break;
    out = out ? `${out}-${word}` : word.slice(0, 40);
  }
  return out || 'work';
}

/** The ticket's id in a branch name: an Azure DevOps work item's number, a Jira key as it is. */
export const branchId = key => String(key).replace(/^AB#/i, '');

/** builder.branchTemplate filled in; the nth try (from 2) gets -n on the end, so a kept branch is never touched. */
export function branchName(templ, key, title, n = 1) {
  const name = String(templ || 'prowl/{id}-{slug}').replace(/\{id\}/g, branchId(key)).replace(/\{slug\}/g, slug(title))
    .replace(/[^\w./-]+/g, '-').replace(/\/{2,}/g, '/').replace(/^[-/.]+|[-/.]+$/g, '');
  return n > 1 ? `${name}-${n}` : name;
}

/** Compares branch names as versions: release/1.10 sorts after release/1.9. */
export function versionCompare(a, b) {
  const parts = s => String(s).split(/(\d+)/).filter(Boolean);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1;
    const [m, n] = [/^\d+$/.test(x[i]), /^\d+$/.test(y[i])];
    const c = m && n ? Number(x[i]) - Number(y[i]) : x[i].localeCompare(y[i]);
    if (c) return c;
  }
  return 0;
}

/**
 * The base branch for a repo: the first builder.base rule whose repo glob matches (a branch, or a branch glob, which
 * takes the highest version-sorted match on the remote); without one, the plan's base if the remote has it; otherwise
 * the default branch. { base } or { error }.
 */
export function pickBase(rules, repo, { planBase = '', remote = [], defaultBranch }) {
  const rule = Object.entries(rules || {}).find(([glob]) => globRe(glob, true).test(repo))?.[1];
  if (rule) {
    if (!/[*?]/.test(rule)) return remote.includes(rule) ? { base: rule } : { error: `the base rule for ${repo} names ${rule}, which isn't on its remote` };
    const hits = remote.filter(b => globRe(rule).test(b)).sort(versionCompare);
    return hits.length ? { base: hits.at(-1) } : { error: `no branch on ${repo}'s remote matches the base rule ${rule}` };
  }
  if (planBase && remote.includes(planBase)) return { base: planBase };
  return { base: defaultBranch };
}

// github.com/<this>/… is a GitHub page, not an owner.
const NOT_OWNERS = new Set('about apps collections enterprise explore features issues login marketplace new notifications orgs pricing pulls search settings sponsors topics users'.split(' '));

/** The repos (owner/name) a ticket names: its GitHub links and `repo: owner/name` lines, then `prRepos`, each once. */
export function repoCandidates(texts, prRepos = []) {
  const found = [];
  for (const text of [texts].flat()) {
    for (const m of String(text || '').matchAll(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/gi)) {
      if (!NOT_OWNERS.has(m[1].toLowerCase())) found.push(`${m[1]}/${m[2].replace(/\.git$/i, '')}`);
    }
    for (const m of String(text || '').matchAll(/^[ \t>*-]*repo:[ \t]*`?([\w.-]+\/[\w.-]+?)`?[ \t]*$/gim)) found.push(m[1]);
  }
  found.push(...prRepos);
  const seen = new Set();
  return found.filter(r => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
}

/** True when a session may work in `repo`: it is under githubOwner or one of builder.extraOwners. */
export const ownerAllowed = (repo, cfg) => [cfg.githubOwner, ...(cfg.builder.extraOwners || [])].filter(Boolean)
  .some(o => repo.toLowerCase().startsWith(`${o.toLowerCase()}/`));

const STATUSES = ['needs-repos', 'needs-approval', 'question', 'done', 'blocked'];
const REPO = /^[\w.-]+\/[\w.-]+$/;
const isList = v => v == null || Array.isArray(v);

/** Why a build turn's result.json (in `briefDir`) is unusable, or '' when it is valid. */
export function validateBuild(r, briefDir) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'it is not a JSON object';
  if (!STATUSES.includes(r.status)) return `status must be one of ${STATUSES.join(', ')}`;
  for (const k of ['repos', 'changes', 'openQuestions', 'commits', 'prs', 'checks']) if (!isList(r[k]) || r[k]?.some(x => !x || typeof x !== 'object')) return `${k} must be a list of objects`;
  const badRepo = [...(r.repos || []), ...(r.changes || []), ...(r.commits || []), ...(r.prs || []), ...(r.checks || [])].find(x => !(typeof x.repo === 'string' && REPO.test(x.repo)));
  if (badRepo) return `"${badRepo?.repo || ''}" isn't a repo, as owner/name`;
  const notText = ['plan', 'investigation', 'summary', 'reason'].find(k => r[k] != null && typeof r[k] !== 'string');
  if (notText) return `${notText} must be text`;
  const fields = [...(r.repos || []).map(x => [x, 'why']), ...(r.changes || []).map(x => [x, 'base']), ...(r.commits || []).map(x => [x, 'sha']),
    ...(r.prs || []).flatMap(x => [[x, 'title'], [x, 'body']])].find(([x, k]) => x[k] != null && typeof x[k] !== 'string');
  if (fields) return `${fields[0].repo}'s ${fields[1]} must be text`;
  if (r.status === 'needs-repos' && !r.repos?.length) return 'needs-repos lists no repos';
  if (r.status === 'needs-approval') {
    if (!r.plan || !fs.existsSync(path.resolve(briefDir, r.plan))) return `the plan file ${r.plan || '(none)'} isn't in the brief folder`;
    const q = (r.openQuestions || []).find(x => !x?.id || !String(x?.question || '').trim());
    if (q) return 'each open question needs an id and a question';
    const shape = (r.openQuestions || []).map(x => questionShape(x, 'default')).find(Boolean);
    if (shape) return `an open question's ${shape}`;
  }
  if (r.status === 'question') {
    if (!r.question || typeof r.question !== 'object') return 'a question needs an id and a question';
    if (!r.question?.id || !String(r.question?.question || '').trim()) return 'a question needs an id and a question';
    const shape = questionShape(r.question, 'default');
    if (shape) return `the question's ${shape}`;
  }
  if (r.status === 'blocked' && !String(r.reason || '').trim()) return 'blocked needs a reason';
  if (r.status === 'done') {
    if (!r.commits?.length) return 'done lists no commits';
    const c = r.commits.find(x => !/^[0-9a-f]{7,40}$/i.test(x.sha || ''));
    if (c) return `the commit for ${c.repo} is not a commit sha`;
    const noPr = r.commits.find(x => !(r.prs || []).some(p => p.repo === x.repo && String(p.title || '').trim()));
    if (noPr) return `${noPr.repo} has commits but no PR title`;
  }
  return '';
}

/** A Needs-you item. `kind`: question, plan, repos, blocked, cap, checks, guard, conflict or failed. */
export const needItem = (kind, { key, question, qid = '', repo = '', pr = '', context = [], options = [], recommended = '', searched = '', blocked = '' }, now = Date.now()) => ({
  id: `${key}:${now.toString(36)}:${Math.random().toString(36).slice(2, 6)}`,
  ticket: key, kind, question, qid, repo, pr, context: [context].flat().filter(Boolean).slice(0, 3), options, recommended, searched, blocked, createdAt: now,
});

/** Every Builder session on ticket `key`, in USD. */
export const ticketSpend = (records, key) => records.filter(r => r.key === key).reduce((n, r) => n + (r.costUsd || 0), 0);

/** Builder sessions since local midnight, in USD. */
export const daySpend = (records, now = Date.now()) => {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  return records.flatMap(r => r.turns || []).filter(t => (t.startedAt || 0) >= midnight).reduce((n, t) => n + (t.costUsd || 0), 0);
};

/** 'over' at a cap, 'warn' from 70% of it, else ''. No cap (0) is never either. */
export const spendLevel = (spent, cap) => (!(cap > 0) ? '' : spent >= cap ? 'over' : spent >= cap * 0.7 ? 'warn' : '');

const at = s => Date.parse(s) || 0;

/**
 * Why a followed PR needs a round, or '': a review requesting changes, or an unresolved thread from whoever `fixFrom`
 * covers, newer than `since` (the Builder's last push or round). `reviews` and `threads` as github.mjs reads them.
 */
export function feedbackDue({ reviews = [], threads = [] }, since, fixFrom) {
  const asked = reviews.filter(r => r.state === 'CHANGES_REQUESTED' && at(r.at) > since);
  if (asked.length) return `${asked.at(-1).user || 'a reviewer'} requested changes`;
  const open = actionable(threads, fixFrom).filter(t => at(t.lastAt) > since);
  return open.length ? `${open.length} unresolved thread${open.length > 1 ? 's' : ''}` : '';
}

/**
 * True when every PR is ready to merge: its latest review approves it, no thread is open, and its required checks
 * are green. No required checks within 10 minutes of a push means CI hasn't started yet; after that, a repo that
 * requires none. `prs`: [{ reviews, threads, checks }].
 */
export function mergeReady(prs, lastPushAt, now = Date.now()) {
  return prs.length > 0 && prs.every(p => {
    const latest = p.reviews.filter(r => r.state !== 'COMMENTED').sort((a, b) => at(a.at) - at(b.at)).at(-1);
    if (latest?.state !== 'APPROVED' || p.threads.some(t => !t.resolved)) return false;
    return p.checks.length ? checksState(p.checks) === 'green' : now - lastPushAt >= 10 * 60_000;
  });
}
