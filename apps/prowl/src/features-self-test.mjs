// Part of node prowl.mjs --self-test: the checks for features added after 2.23.6, a section each.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME } from './config.mjs';
import { addWorktree, noHooks, noHooksEnv } from './git.mjs';
import { finalize } from './reviewer/reviews.mjs';
import { readActivity, sessionEnded } from './sessions.mjs';

const WIN = process.platform === 'win32';
const sh = (cwd, cmd, args, env) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

export async function run(assert, { appDir }) { // eslint-disable-line no-unused-vars
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-feat-'));
  const gitIn = (cwd, ...args) => { const r = sh(cwd, 'git', args); if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

  // ---- C-35: git hooks are off in every worktree Prowl makes ----
  {
    const dir = path.join(HOME, 'no-hooks');
    assert.equal(noHooks(), dir);
    fs.writeFileSync(path.join(dir, 'post-checkout'), '#!/bin/sh\n');
    noHooks();
    assert.deepEqual(fs.readdirSync(dir), [], 'a hook file placed in no-hooks is gone after the next call');
    assert.deepEqual(noHooksEnv({ GIT_CONFIG_COUNT: '2' }, '/x'), { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/x' });
    assert.deepEqual(noHooksEnv({}, '/x'), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/x' });
    if (!WIN) {
      // A symlink to a folder is refused, and what is behind the link is left alone.
      const behind = path.join(tmp, 'behind');
      fs.mkdirSync(behind);
      fs.writeFileSync(path.join(behind, 'keep'), 'x');
      fs.rmSync(dir, { recursive: true });
      fs.symlinkSync(behind, dir);
      assert.throws(() => noHooks(), /must be a folder of your own, not a link/);
      assert.ok(fs.existsSync(path.join(behind, 'keep')), 'the folder behind the link keeps its files');
      fs.unlinkSync(dir);
      // A repo whose clone has a relative core.hooksPath takes its hooks from the checked-out commit: none may run.
      const repo = path.join(tmp, 'hooked');
      const marker = path.join(tmp, 'hook-ran');
      fs.mkdirSync(path.join(repo, '.husky'), { recursive: true });
      gitIn(repo, 'init', '-q');
      gitIn(repo, 'config', 'user.email', 't@example.com');
      gitIn(repo, 'config', 'user.name', 'T');
      gitIn(repo, 'config', 'core.hooksPath', '.husky');
      for (const hook of ['post-checkout', 'post-index-change']) fs.writeFileSync(path.join(repo, '.husky', hook), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
      gitIn(repo, 'add', '-A');
      gitIn(repo, 'commit', '-q', '-m', 'hooks', '--no-verify');
      const sha = gitIn(repo, 'rev-parse', 'HEAD');
      fs.rmSync(marker, { force: true }); // the commit above ran post-index-change itself
      const wt = path.join(tmp, 'hooked-wt');
      await addWorktree(repo, wt, sha);
      assert.ok(fs.existsSync(path.join(wt, 'a.txt')) && !fs.existsSync(marker), 'a new worktree: no hook ran');
      await addWorktree(repo, wt, sha);
      assert.ok(!fs.existsSync(marker), 're-using the worktree: no hook ran');
      fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
      sh(wt, 'git', ['status'], noHooksEnv({}));
      assert.ok(!fs.existsSync(marker), 'git status with noHooksEnv() in the environment runs no post-index-change');
      sh(wt, 'git', ['status']);
      fs.writeFileSync(path.join(wt, 'a.txt'), 'changed again\n');
      sh(wt, 'git', ['add', 'a.txt']);
      assert.ok(fs.existsSync(marker), 'the check is real: without it the hook runs');
    }
  }

  // ---- C-09: a session working in the background isn't failed, and a finished one counts as done ----
  {
    const clean = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 2 };
    assert.equal(sessionEnded({ _result: clean }, () => true), false, 'a result event while the process runs is a turn, not the end');
    assert.ok(sessionEnded({}, () => false) && sessionEnded({ _result: clean }, () => false), 'ended once the process has exited');
    // A line that can't be handled never loses the result after it.
    const logPath = path.join(tmp, 'c09.ndjson');
    fs.writeFileSync(logPath, ['null', '[1]', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text' }, null, { type: 'text', text: 'hello' }] } }), JSON.stringify(clean), ''].join('\n'));
    const tailed = { logPath };
    assert.equal(readActivity(tailed)?.total_cost_usd, 2, 'the result is still read');
    assert.deepEqual(tailed._activity.map(a => [a.text, Boolean(a.error)]), [['null', true], ['[1]', true], ['hello', false]], 'a JSON value that is not an object is an error line; a part without text is skipped');
    // Settling: a clean final result and a report mean done, whatever ended the process.
    const reportPath = path.join(tmp, 'c09.md');
    fs.writeFileSync(reportPath, '---\nverdict: APPROVE\n---\n');
    const stopped = { status: 'stopping', reportPath, _result: clean, prs: [] };
    finalize(stopped);
    assert.equal(stopped.status, 'done', 'stopped after its report was written: done');
    const cappedRun = { status: 'stopping', capped: 'time cap 30 min', reportPath, _result: clean, prs: [] };
    finalize(cappedRun);
    assert.deepEqual([cappedRun.status, cappedRun.capped], ['done', null], 'the time cap ended a finished review: done, the cap cleared');
    const noReport = { status: 'stopping', capped: 'time cap 30 min', reportPath: path.join(tmp, 'none.md'), _result: clean };
    finalize(noReport);
    assert.deepEqual([noReport.status, noReport.error], ['failed', 'stopped: time cap 30 min'], 'without the report: as before');
    const byYou = { status: 'stopping', reportPath: path.join(tmp, 'none.md'), _result: clean };
    finalize(byYou);
    assert.equal(byYou.status, 'stopped');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}
