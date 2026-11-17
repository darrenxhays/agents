// Build and test before reviews: checks.json's steps run on each PR, in a worktree of its repo kept between reviews,
// before the review's session starts. A failed step is run again at the merge base, and the review is given the results.
import fs from 'node:fs';
import path from 'node:path';
import { matchChecks, reviewSteps, runSteps } from '../checks.mjs';
import * as git from '../git.mjs';
import * as github from '../github.mjs';

const label = pr => `${pr.repo}#${pr.number}`;

/** The PRs of `prs` that a review builds and tests, each with its checks.json entry: those whose repo's entry gives a step. */
export const checkPlan = (checks, prs) => prs.map(pr => ({ pr, spec: matchChecks(checks, pr.repo) })).filter(x => reviewSteps(x.spec).length);

/** A repo's checks worktree: one per repo, kept between reviews so a build reuses what the last one left. */
export const checksWorktree = (workDir, repo) => path.join(workDir, '.prowl-worktrees', 'review', repo.split('/')[1]);

/**
 * The steps to run again at the merge base: every step up to and including the last one that failed at the head,
 * whether it passed there or not. Any earlier step may build something a later one tests, and the worktree keeps the
 * head's build output.
 */
export function baseSteps(steps, results) {
  // By place, not by name: a checks.json entry can have two steps of one name (its own setup, and a review step called setup).
  return steps.slice(0, results.findLastIndex(r => r.status === 'failed') + 1);
}

/** A PR's checks files, next to the review's log: `prefix` is the log's path without its extension. */
export function checksFiles(prefix, pr) {
  const base = `${path.resolve(prefix)}.${pr.repo.split('/')[1]}-${pr.number}`; // absolute: a check reads PROWL_CHANGED_FILES from inside its worktree
  return { changed: `${base}.changed.txt`, log: `${base}.checks.log` };
}

/**
 * Builds and tests one PR at `head`: resolves { url, label, head, mergeBase, log, steps }, each failed step with
 * `atBase` ('passed', 'failed' or 'skipped') and, failing there too, `baseTail`. Rejects when the checks can't run:
 * a fork's PR (never built: the steps run its build scripts on this machine, as the user), a clone of another repo, a
 * head no longer on GitHub. `deps`, for the self-test: { git, serial, succeeds, addWorktree, prBase, clone, runSteps }.
 */
export async function prChecks(cfg, { pr, spec }, head, prefix, { signal, progress = () => {}, deps = {} } = {}) {
  const d = { git: git.git, serial: git.serial, succeeds: git.succeeds, addWorktree: git.addWorktree, prBase: github.prBase, clone: git.cloneFor, runSteps, ...deps };
  const { base, fork } = await d.prBase(pr);
  if (fork) throw new Error("its branch is in a fork, and Prowl doesn't run a fork's code");
  const clone = await d.clone(pr.repo, cfg.workDir, (repo, target) => progress(`Cloning ${repo} into ${target}`));
  const wt = checksWorktree(cfg.workDir, pr.repo);
  // Two reviews of the same repo take turns: the worktree is one per repo.
  return d.serial(wt, async () => {
    progress(`Fetching ${label(pr)} and ${base}`);
    await d.serial(clone, () => d.git(clone, 'fetch', 'origin', `pull/${pr.number}/head`, base));
    // Before the worktree is touched, so a kept worktree and its build output stay as they were.
    if (!(await d.succeeds(clone, 'cat-file', '-e', `${head}^{commit}`))) throw new Error(`the PR's head ${git.short(head)} isn't on GitHub any more (force-pushed since the review started)`);
    progress(`Checking out ${label(pr)} at ${git.short(head)} in ${wt}`);
    await d.addWorktree(clone, wt, head);
    const mergeBase = (await d.git(clone, 'merge-base', head, `origin/${base}`)).trim();
    const files = checksFiles(prefix, pr);
    fs.writeFileSync(files.changed, await d.git(clone, 'diff', '--name-only', mergeBase, head));
    fs.writeFileSync(files.log, `${label(pr)} at its head ${head} (merge base ${mergeBase}), in ${wt}\n`);
    const log = text => fs.appendFileSync(files.log, text);
    const steps = reviewSteps(spec);
    const env = { ...spec.env, PROWL_REPO: pr.repo, PROWL_PR: String(pr.number), PROWL_HEAD_SHA: head, PROWL_BASE_SHA: mergeBase, PROWL_CHANGED_FILES: files.changed };
    progress(`Running ${steps.map(([name]) => name).join(', ')} · output: ${files.log}`);
    const results = await d.runSteps(steps, wt, env, spec.timeoutMinutes || 20, signal, log);
    if (results.some(r => r.status === 'failed') && !signal?.aborted) {
      progress(`Checking out the merge base ${git.short(mergeBase)} to rerun the failed steps`);
      await d.addWorktree(clone, wt, mergeBase);
      log(`\nThe failed steps again, at the merge base ${mergeBase}\n`);
      const atBase = await d.runSteps(baseSteps(steps, results), wt, { ...env, PROWL_AT_BASE: '1' }, spec.timeoutMinutes || 20, signal, log);
      for (const r of results.filter(x => x.status === 'failed')) {
        const b = atBase[results.indexOf(r)]; // the same step, by its place
        // Nothing to run at the base (a project the PR adds): the failure is the PR's.
        r.atBase = !b ? 'skipped' : b.status === 'nothing' ? 'passed' : b.status;
        if (r.atBase === 'failed') r.baseTail = b.tail;
      }
    }
    return { url: pr.url, label: label(pr), head, mergeBase, log: files.log, steps: results };
  });
}

/** One PR's checks in a line, for the Log and Activity. */
export function checksLine(result) {
  if (result.error) return `${result.label}: checks couldn't run (${result.error})`;
  const one = s => (s.status === 'failed' ? `${s.name} failed${{ passed: ' (passes at the merge base)', failed: ' (fails at the merge base too)' }[s.atBase] || ''}`
    : s.status === 'nothing' ? `${s.name} nothing to run`
      : s.status === 'skipped' ? `${s.name} skipped (${s.after === 'stopped' ? 'stopped' : `${s.after} failed`})` : `${s.name} passed`);
  return `${result.label}: ${result.steps.map(one).join(', ')} · output: ${result.log}`;
}
