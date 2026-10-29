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

/** Pushes HEAD of `dir` to origin's `branch`. Never forced: a push that isn't a fast-forward is rejected by git. */
export const push = (dir, branch) => git(dir, 'push', 'origin', `HEAD:refs/heads/${branch}`);
