// Git for Prowl's own code: worktrees beside the user's clones, and pushes that are never forced. The user's
// checked-out branch, working tree and local branches are never touched.
import fs from 'node:fs';
import { run, runFull } from './proc.mjs';

export const git = (dir, ...args) => run('git', ['-C', dir, ...args]);
export const short = sha => String(sha || '').slice(0, 7);

/** The host of a git remote URL (https://host/…, ssh://user@host/…, user@host:…), lowercased; '' for a local path. */
export const hostOf = url => (/^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url) || /^(?:[^@/]*@)?([^/:]+):(?!\/)/.exec(url) || [])[1]?.toLowerCase() || '';

/** True when `url` (a git remote) is the GitHub repo `repo` (owner/name). */
export const sameRepo = (url, repo) => {
  const u = String(url).trim().replace(/\.git$/i, '').toLowerCase();
  return u.endsWith(`/${repo.toLowerCase()}`) || u.endsWith(`:${repo.toLowerCase()}`);
};

const locks = new Map(); // clone folder -> the promise of its last fetch or worktree change
/** Runs `fn` after every earlier call for the same clone has finished: git can't fetch or add worktrees in parallel. */
export function serial(clone, fn) {
  const next = (locks.get(clone) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(clone, next);
  return next;
}

/** True when `git -C dir <args>` exits 0. */
export const succeeds = async (dir, ...args) => (await runFull('git', ['-C', dir, ...args])).code === 0;

/**
 * A worktree of `clone` at `wt`, detached at `sha`: checking out a branch there would move the user's own local branch.
 * An existing worktree is reset to `sha`; one that no longer works is added again.
 */
export function addWorktree(clone, wt, sha) {
  return serial(clone, async () => {
    if (fs.existsSync(wt)) {
      try {
        await git(wt, 'checkout', '--force', '--detach', sha);
        await git(wt, 'clean', '-fd');
        return;
      } catch { /* not a working worktree any more: add it again */ }
      await git(clone, 'worktree', 'remove', '--force', wt).catch(() => {});
      fs.rmSync(wt, { recursive: true, force: true });
      await git(clone, 'worktree', 'prune');
    }
    await git(clone, 'worktree', 'add', '--detach', wt, sha);
  });
}

/** Removes a worktree Prowl made, and with `branch`, the local branch it made there (never one the user made). */
export function removeWorktree(clone, wt, branch = '') {
  return serial(clone, async () => {
    if (fs.existsSync(wt)) await git(clone, 'worktree', 'remove', '--force', wt).catch(() => fs.rmSync(wt, { recursive: true, force: true }));
    await git(clone, 'worktree', 'prune').catch(() => {});
    if (branch) await git(clone, 'branch', '-D', branch).catch(() => {});
  });
}

/** The commit `branch` is at on origin, or '' when origin has no such branch. */
export const remoteSha = async (dir, branch) => (await git(dir, 'ls-remote', 'origin', `refs/heads/${branch}`)).split(/\s/)[0] || '';

/** Fetches `branch` from origin and resolves with its commit. */
export const fetchBranch = (clone, branch) => serial(clone, async () => {
  await git(clone, 'fetch', 'origin', `refs/heads/${branch}`);
  return (await git(clone, 'rev-parse', 'FETCH_HEAD')).trim();
});

/**
 * Pushes commit `sha` (the one the guards checked) from `dir` to origin's `branch`. Never forced: a push that isn't a
 * fast-forward is rejected by git. And only that commit: whatever the clone's config says (a session can write it),
 * no tags or submodules go along.
 */
export const push = (dir, branch, sha) => git(dir, 'push', '--no-follow-tags', '--recurse-submodules=no', 'origin', `${sha}:refs/heads/${branch}`);

let readsAttrsFromCommit; // whether this git has --attr-source (2.40 and later)
/**
 * The git option that reads .gitattributes as they were at commit `sha`, for the guards' diffs: a session's own
 * `* -diff` would otherwise turn its files binary there, hiding their lines and anything in them. [] on a git too old for it.
 */
export async function attrSource(sha) {
  readsAttrsFromCommit ??= run('git', ['--version']).then(v => { const [, major, minor] = /(\d+)\.(\d+)/.exec(v) || []; return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 40); }, () => false);
  return (await readsAttrsFromCommit) ? [`--attr-source=${sha}`] : [];
}

/**
 * `git diff --numstat -z` of what the commits in from..HEAD change themselves, leaving out what a merge of the base
 * (`exclude`) brought in: each of their own commits, and each merge's own lines (its conflict resolutions). With no
 * merge in the range, from..HEAD as it is. `attrs`: attrSource()'s option, before each diff.
 */
export async function ownNumstat(dir, from, exclude, attrs = []) {
  const list = async kind => (await git(dir, 'rev-list', kind, `${from}..HEAD`, `^${exclude}`)).split('\n').filter(Boolean);
  const merges = await list('--merges');
  if (!merges.length) return git(dir, ...attrs, 'diff', '--numstat', '-z', `${from}..HEAD`);
  let out = '';
  for (const c of await list('--no-merges')) out += await git(dir, ...attrs, 'diff', '--numstat', '-z', `${c}^`, c);
  for (const m of merges) {
    const lines = {};
    let file = '';
    for (const line of (await git(dir, ...attrs, 'show', '--cc', '--format=', '-U0', m)).split('\n')) {
      const head = /^diff --cc (.+)$/.exec(line);
      if (head) { file = head[1]; continue; }
      if (!file || /^(\+\+\+|---) |^@@@/.test(line)) continue;
      if (/^[ +-]{2}/.test(line) && /[+-]/.test(line.slice(0, 2))) lines[file] = (lines[file] || 0) + 1;
    }
    for (const [f, n] of Object.entries(lines)) out += `${n}\t0\t${f}\0`;
  }
  return out;
}
