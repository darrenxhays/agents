// The Builder's repos: a clone of each in the Projects Directory (cloned if missing, otherwise fetched) and a detached
// worktree per ticket beside them. The user's checked-out branch, working tree and local branches are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { addWorktree, fetchBranch, git, sameRepo } from '../git.mjs';
import { run } from '../proc.mjs';

/** Where a ticket's worktrees go: <Projects Directory>/.prowl-worktrees/work-<id>. */
export const worktreeRoot = (cfg, w) => path.join(cfg.workDir, '.prowl-worktrees', `work-${w.id}${w.n > 1 ? `-${w.n}` : ''}`);

export const ghClone = (repo, target) => run('gh', ['repo', 'clone', repo, target]);

/** The clone of `repo` in the Projects Directory, cloned with `clone` if it is missing. Throws if the folder holds another repo. */
export async function ensureClone(cfg, repo, clone = ghClone) {
  const dir = path.join(cfg.workDir, repo.split('/')[1]);
  if (!fs.existsSync(dir)) await clone(repo, dir);
  const origin = (await git(dir, 'remote', 'get-url', 'origin')).trim();
  if (!sameRepo(origin, repo)) throw new Error(`${dir} is a clone of ${origin}, not ${repo}`);
  // Pushes go to every push URL, which a pushurl or pushInsteadOf can point somewhere else.
  const elsewhere = (await git(dir, 'remote', 'get-url', '--push', '--all', 'origin')).split('\n').map(u => u.trim()).filter(Boolean).find(u => !sameRepo(u, repo));
  if (elsewhere) throw new Error(`${dir} pushes to ${elsewhere}, not ${repo}`);
  return dir;
}

/** The branch origin's HEAD points at. */
export async function defaultBranchOf(clone) {
  const out = await git(clone, 'ls-remote', '--symref', 'origin', 'HEAD');
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out);
  if (!m) throw new Error(`couldn't read the default branch of ${clone}'s origin`);
  return m[1];
}

/** The branch names on origin. */
export async function remoteBranches(clone) {
  return (await git(clone, 'ls-remote', '--heads', 'origin')).split('\n').map(l => l.split('\t')[1]?.replace(/^refs\/heads\//, '')).filter(Boolean);
}

/** Clones or fetches `repo` and checks out a worktree for it at `wt`, detached at its default branch. */
export async function prepareRepo(cfg, repo, wt, clone) {
  const dir = await ensureClone(cfg, repo, clone);
  const defaultBranch = await defaultBranchOf(dir);
  const sha = await fetchBranch(dir, defaultBranch);
  await addWorktree(dir, wt, sha);
  return { repo, clone: dir, worktree: wt, defaultBranch };
}
