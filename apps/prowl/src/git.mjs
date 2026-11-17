// Git for Prowl's own code: worktrees beside the user's clones, and pushes that are never forced. The user's
// checked-out branch, working tree and local branches are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.mjs';
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

/**
 * The user's clone of `repo` (owner/name) in `workDir`, cloned first when it is missing (`onClone(repo, target)` is
 * told before). Throws when that folder is a clone of another repo. For reading: the Builder's ensureClone() also
 * checks where the clone pushes.
 */
export async function cloneFor(repo, workDir, onClone = () => {}) {
  const target = path.join(workDir, repo.split('/')[1]);
  if (!fs.existsSync(target)) {
    onClone(repo, target);
    await run('gh', ['repo', 'clone', repo, target], { timeoutMs: 3_600_000 }); // a big repo on a slow line: an hour, not the usual 10 minutes
  }
  const origin = (await git(target, 'remote', 'get-url', 'origin')).trim();
  if (!sameRepo(origin, repo)) throw new Error(`${target} is a clone of ${origin}, not ${repo}`);
  return target;
}

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
 * The empty folder git is pointed at for hooks (<Prowl home>/no-hooks), so a repo's hook scripts never run because
 * Prowl checked a commit out: with a relative core.hooksPath (husky's .husky), git would take them from the commit
 * itself. Made, checked and emptied on every call: anything in it would run as a hook. An empty folder works on
 * Windows too, where /dev/null doesn't.
 */
export function noHooks(folder = path.join(HOME, 'no-hooks')) {
  const dir = path.resolve(folder); // absolute: git resolves a relative core.hooksPath inside the worktree, where a PR could plant hooks
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new Error(`${dir} must be a folder of your own, not a link or someone else's`);
  if (st.mode & 0o022) fs.chmodSync(dir, 0o700);
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  if (fs.readdirSync(dir).length) throw new Error(`${dir} must be empty (git would run what is in it as hooks), and couldn't be emptied`);
  return dir;
}

/** The git option, for right after -C <dir>, that turns hooks off for one command. */
export const hooksOff = () => ['-c', `core.hooksPath=${noHooks()}`];

/** Environment that turns git hooks off for every git command a review session runs. */
export function noHooksEnv(env = process.env, dir = noHooks()) {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT, 10) > 0 ? Number.parseInt(env.GIT_CONFIG_COUNT, 10) : 0;
  const out = { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${n}`]: dir };
  // An inherited GIT_CONFIG_PARAMETERS (what `git -c` sets) outranks the counted variables: when it is there, the
  // override is appended to it too, single-quoted as git writes it, so the last word on core.hooksPath is Prowl's.
  if (env.GIT_CONFIG_PARAMETERS) out.GIT_CONFIG_PARAMETERS = `${env.GIT_CONFIG_PARAMETERS} '${`core.hooksPath=${dir}`.replace(/'/g, "'\\''")}'`;
  return out;
}

/**
 * A worktree of `clone` at `wt`, detached at `sha`: checking out a branch there would move the user's own local branch.
 * An existing worktree is reset to `sha`; one that no longer works is added again. Git hooks are off throughout.
 */
export function addWorktree(clone, wt, sha) {
  return serial(clone, async () => {
    const quiet = hooksOff(); // before anything is touched: no worktree is made if hooks can't be turned off
    if (fs.existsSync(wt)) {
      try {
        await git(wt, ...quiet, 'checkout', '--force', '--detach', sha);
        await git(wt, ...quiet, 'clean', '-fd');
        return;
      } catch { /* not a working worktree any more: add it again */ }
      await git(clone, 'worktree', 'remove', '--force', wt).catch(() => {});
      fs.rmSync(wt, { recursive: true, force: true });
      await git(clone, 'worktree', 'prune');
    }
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await git(clone, ...quiet, 'worktree', 'add', '--detach', wt, sha);
  });
}

/** Removes a worktree Prowl made, and with `branch`, the local branch it made there (never one the user made). */
export function removeWorktree(clone, wt, branch = '') {
  return serial(clone, async () => {
    if (!fs.existsSync(clone)) return fs.rmSync(wt, { recursive: true, force: true }); // the clone is gone: only the folder is left to delete
    if (fs.existsSync(wt)) await git(clone, 'worktree', 'remove', '--force', wt).catch(() => fs.rmSync(wt, { recursive: true, force: true }));
    await git(clone, 'worktree', 'prune').catch(() => {});
    if (branch) await git(clone, 'branch', '-D', branch).catch(() => {});
  });
}

/**
 * Fetches `refs` from origin into `clone`, as one fetch. The refs go after `--`, so a branch name starting with a dash
 * is a ref, never an option, and each is named in full (refs/pull/7/head, +refs/heads/main:refs/remotes/origin/main).
 */
export const fetchRefs = (clone, refs, { timeoutMs = 300_000 } = {}) => serial(clone, () => run('git', ['-C', clone, 'fetch', 'origin', '--', ...refs], { timeoutMs }));

/** True when commit `a` is `b` or one of its ancestors, in `dir`. */
export const isAncestor = (dir, a, b) => succeeds(dir, 'merge-base', '--is-ancestor', a, b);

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
