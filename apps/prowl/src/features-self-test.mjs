// Part of node prowl.mjs --self-test: the checks for features added after 2.23.6, a section each.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, HOME, loadConfig, newSettings } from './config.mjs';
import { killChecks, reviewSteps, runChecks, runCommand, runSteps } from './checks.mjs';
import { addWorktree, noHooks, noHooksEnv } from './git.mjs';
import { otherKeys, titleNamesOnly } from './github.mjs';
import { ticketsFrom } from './ado.mjs';
import { norm, tagMatches } from './match.mjs';
import { baseSteps, checkPlan, checksLine, prChecks } from './reviewer/checks.mjs';
import { createReviewer } from './reviewer/reviewer.mjs';
import { MODELS } from './config.mjs';
import { agentModel, buildPrompt, CHECKS_SLOT, createReview, fenced, fillChecks, finalize, reviewArgs, reviewRoles, rolesWarning } from './reviewer/reviews.mjs';
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

  const FIX = path.join(appDir, 'src', 'self-test-fixtures');
  const fixture = name => fs.readFileSync(path.join(FIX, name), 'utf8');
  const promptCases = JSON.parse(fixture('prompt-cases.json'));
  for (const c of Object.values(promptCases)) if (c.priorReport) c.priorReport = fixture(c.priorReport);
  const configWas = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
  const restoreConfig = () => (configWas === null ? fs.rmSync(CONFIG_PATH, { force: true }) : fs.writeFileSync(CONFIG_PATH, configWas));
  /** A run made as startReview() makes it, without its session. */
  const made = (cfgOver = {}, opts = {}) => {
    const base = loadConfig();
    return createReview({ ...base, ...cfgOver, claude: { ...base.claude, ...cfgOver.claude } },
      { tracker: 'ado', ticket: { key: 'AB#42', title: 'Thing', url: 'https://dev.azure.com/o/p/_workitems/edit/42', ref: null }, prs: [{ url: 'https://github.com/o/a/pull/1', repo: 'o/a', number: 1 }], ...opts });
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const prOf = (n, extra = {}) => ({ url: `https://github.com/octo-org/r${n}/pull/${n}`, title: `AB#42: PR ${n}`, number: n, repo: `octo-org/r${n}`, author: 'teammate', draft: false, state: 'open', headSha: `sha${n}`, labels: [], ...extra });
  /**
   * A Reviewer over fakes: `open` are the open PRs GitHub's search finds, `tickets` what the board search returns.
   * Resolves with { side, seen: { claims, retags, started, launched, logs }, app, gh, tracker }.
   */
  function reviewerOver({ open = [], tickets = null, cfgOver = {}, runs = [], dry = false, deps = {}, ghOver = {}, trackerOver = {}, board = 'ado' } = {}) {
    const cfg = { ...loadConfig(), githubOwner: 'octo-org', workDir: tmp, taskBoard: board, ...cfgOver };
    const seen = { claims: [], retags: [], started: [], launched: [], logs: [], warns: [] };
    const ticket = { key: 'AB#42', title: 'Thing', url: 'https://dev.azure.com/o/Shop/_workitems/edit/42', tags: [cfg.tags.trigger], rev: 3, ref: { org: 'https://dev.azure.com/o', project: 'Shop', id: 42 } };
    const app = { cfg, me: 'octocat', on: true, sideOn() { return this.on; }, tracker: () => tracker, boards: () => [{ project: 'Shop', team: 'Web' }], dryRun: () => dry };
    const tracker = {
      name: 'Azure DevOps', boardLabel: b => `${b.project} / ${b.team}`,
      findTickets: async () => ({ tickets: tickets || [ticket], variants: [cfg.tags.trigger] }),
      claim: async (c, t, drop, add) => { seen.claims.push(add); },
      retag: async (c, ref, drop, add) => { seen.retags.push(add); },
      ticketText: async () => '', lookup: async (c, key) => ({ ...ticket, key }), current: async (c, t) => t, boardOf: async () => null, readItem: async () => ticket,
      ...trackerOver,
    };
    const gh = { me: async () => 'octocat', openPrs: async () => open, headSha: async pr => `sha${pr.number}`, postComment: async () => '', humanApproved: async () => false, cloneMissing: async () => [],
      prByRef: async ref => open.find(p => p.repo === ref.repo && p.number === ref.number) || (() => { throw new Error('HTTP 404'); })(), reviewedSince: async () => true, isOpen: async () => true, ...ghOver };
    const byKey = new Map(); // a message repeated for the same key is logged once, as in prowl.mjs
    const labelCalls = [];
    const labels = { own() {}, set: (...a) => labelCalls.push(a), refused: () => '', pending: () => false };
    const side = createReviewer(app, { log: (level, msg, key) => { if (key && byKey.get(key) === msg) return false; if (key) byKey.set(key, msg); seen.logs.push(msg); if (level === 'warn' || level === 'error') seen.warns.push(msg); return true; }, forget: key => byKey.delete(key), hoot() {}, appDir, trackers: { ado: tracker, jira: tracker }, github: gh, labels, autoName: async () => 'Named', ...deps });
    side.state = { runs: structuredClone(runs), failures: {} };
    let n = 0;
    const fake = (c, opts) => ({ id: `AB42-${++n}`, tracker: opts.tracker, ref: opts.ticket.ref, ticket: opts.ticket.key, title: opts.ticket.title, ticketUrl: opts.ticket.url, prs: opts.prs, contextPrs: opts.approvedPrs || [], reviewNo: (opts.prior?.reviewNo || 0) + 1, priorId: opts.prior?.id || null,
      status: 'running', startedAt: Date.now(), pid: null, logPath: path.join(tmp, `fake-${n}.ndjson`), reportPath: path.join(tmp, `fake-${n}.md`), reviewedHeads: opts.heads || {}, approved: {}, ...(opts.quick && { quick: true }), ...(opts.checking && { phase: 'checks' }) });
    side.startReview = (c, dir, opts) => { seen.started.push(opts); return fake(c, opts); };
    side.createReview = (c, opts) => { seen.started.push(opts); return fake(c, opts); };
    side.launchReview = (c, dir, run) => { seen.launched.push(structuredClone(run.checks || [])); delete run.phase; };
    return { side, seen, app, gh, tracker, ticket, labelCalls };
  }

  // ---- C-08: build and test before reviews ----
  {
    assert.deepEqual(reviewSteps({ setup: ['s'], run: ['r'], review: { build: ['b'], test: ['t1', 't2'], lint: [] } }), [['setup', ['s']], ['build', ['b']], ['test', ['t1', 't2']]]);
    assert.deepEqual(reviewSteps({ setup: ['s'], run: ['make test'] }), [['setup', ['s']], ['checks', ['make test']]]);
    assert.deepEqual([reviewSteps({ run: ['x'], review: false }), reviewSteps({ setup: ['s'] }), reviewSteps(null)], [[], [], []]);
    const all = [['setup', ['s']], ['build', ['b']], ['test', ['t']], ['lint', ['l']]];
    const failedAt = name => all.map(([n2]) => ({ name: n2, status: n2 === name ? 'failed' : 'passed' }));
    assert.deepEqual(baseSteps(all, failedAt('test')).map(x => x[0]), ['setup', 'build', 'test']);
    assert.deepEqual(baseSteps(all, failedAt('lint')).map(x => x[0]), ['setup', 'build', 'test', 'lint']);
    assert.deepEqual(baseSteps([['compile', ['c']], ['test', ['t']]], [{ name: 'compile', status: 'passed' }, { name: 'test', status: 'failed' }]).map(x => x[0]), ['compile', 'test'], 'a passed step before a failed one is rerun');
    const checks = { 'octo-org/r1': { review: { build: ['b'] } }, 'octo-org/r2': { run: ['x'], review: false } };
    assert.deepEqual(checkPlan(checks, [prOf(1), prOf(2), prOf(3)]).map(x => x.pr.number), [1], 'a review block: planned; "review": false and an unmatched repo: not');
    if (!WIN) {
      const idle = '[ -n "$PROWL_NOTHING_TO_RUN_FILE" ] && : > "$PROWL_NOTHING_TO_RUN_FILE"; exit 0';
      let out = '';
      let r = await runSteps([['build', ['echo built']], ['test', ['echo "env=$MY_VAR"; exit 3', 'echo never']], ['lint', ['true']]], tmp, { MY_VAR: 'yes' }, 20, undefined, t => { out += t; });
      assert.deepEqual(r.map(x => x.status), ['passed', 'failed', 'passed']);
      assert.ok(r[1].command === 'echo "env=$MY_VAR"; exit 3' && r[1].tail.includes('env=yes') && !out.includes('never'), 'the failed command and a tail that shows the env');
      assert.ok(out.includes('\n[build] $ echo built\nbuilt\n[build] passed\n') && out.includes('env=yes\n[test] failed\n'), `the step log: ${JSON.stringify(out)}`);
      r = await runSteps([['setup', ['true']], ['build', ['false']], ['test', ['true']], ['lint', ['true']]], tmp, {});
      assert.deepEqual(r.map(x => [x.status, x.after]), [['passed', undefined], ['failed', undefined], ['skipped', 'build'], ['skipped', 'build']]);
      const gone = new AbortController();
      gone.abort();
      assert.deepEqual(await runSteps([['build', ['true']]], tmp, {}, 20, gone.signal), [{ name: 'build', status: 'skipped', after: 'stopped' }]);
      assert.deepEqual(await runCommand('true', tmp, {}, 1000, { signal: gone.signal }), { ok: false, tail: '(stopped)' });
      // Nothing to run: a file, not an exit code.
      const one = await runCommand(idle, tmp, {}, 10_000);
      assert.ok(one.ok && one.nothing && !fs.readdirSync(os.tmpdir()).some(f => f.startsWith(`prowl-nothing-${process.pid}-`)), 'nothing to run, and the temp file is removed');
      assert.ok(!(await runCommand('exit 78', tmp, {}, 10_000)).ok, 'exit 78 is a failure like any other');
      const wroteThenFailed = await runCommand(': > "$PROWL_NOTHING_TO_RUN_FILE"; exit 1', tmp, {}, 10_000);
      assert.ok(!wroteThenFailed.ok && !wroteThenFailed.nothing);
      out = '';
      r = await runSteps([['build', [idle]], ['test', [idle, 'true']], ['lint', [idle]]], tmp, {}, 20, undefined, t => { out += t; });
      assert.deepEqual(r.map(x => x.status), ['nothing', 'passed', 'nothing'], 'a build with nothing to run skips nothing');
      assert.ok(out.includes(`[build] $ ${idle}\n[build] nothing to run`) && out.includes('\n[test] passed'));
      assert.deepEqual(await runChecks({ run: [idle] }, tmp), { ok: true }, "the Builder's checks count nothing to run as a pass");
      // Stopping: asked to end, then killed.
      let ac = new AbortController();
      let t0 = Date.now();
      let pending = runCommand('sleep 30', tmp, {}, 60_000, { signal: ac.signal });
      await sleep(150);
      ac.abort();
      assert.ok(!(await pending).ok && Date.now() - t0 < 5000, 'aborting stops a sleeping command within seconds');
      ac = new AbortController();
      t0 = Date.now();
      pending = runCommand("trap '' TERM; sleep 30 & wait; sleep 30", tmp, {}, 60_000, { signal: ac.signal, graceMs: 300 });
      await sleep(300);
      ac.abort();
      assert.ok(!(await pending).ok && Date.now() - t0 < 8000, 'a command that ignores SIGTERM is killed after the grace period');
      t0 = Date.now();
      const late = await runCommand("trap '' TERM; sleep 30 & wait; sleep 30", tmp, {}, 300, { graceMs: 300 });
      assert.ok(late.timedOut && !late.ok && Date.now() - t0 < 8000, 'and on a timeout too');
      t0 = Date.now();
      pending = runCommand("trap '' TERM; while :; do sleep 1; done", tmp, {}, 60_000, { graceMs: 60_000 });
      await sleep(300);
      killChecks();
      assert.ok(!(await pending).ok && Date.now() - t0 < 8000, 'killChecks() kills a running check outright');
      // A redirected child that ignores SIGTERM holds none of Prowl's pipes: it is gone after the stop.
      const pidFile = path.join(tmp, 'child.pid');
      ac = new AbortController();
      pending = runCommand(`(trap '' TERM; exec sh -c 'echo $$ > "${pidFile}"; exec sleep 30' > /dev/null 2>&1) & wait`, tmp, {}, 60_000, { signal: ac.signal, graceMs: 200 });
      for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await sleep(50);
      ac.abort();
      await pending;
      await sleep(300);
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      let childAlive = true;
      try { process.kill(childPid, 0); } catch { childAlive = false; }
      assert.ok(childPid > 0 && !childAlive, 'a redirected child that ignored the stop is gone');
    }
    // One PR's checks, with fake git, GitHub and step runner.
    const calls = [];
    const stepRuns = [];
    const head = 'a'.repeat(40);
    const mb = 'b'.repeat(40);
    const fakes = (over = {}) => ({
      git: async (dir, ...a) => { calls.push(a.join(' ')); return a[0] === 'merge-base' ? `${mb}\n` : a[0] === 'diff' ? 'src/a.js\n' : ''; },
      serial: (key, fn) => { calls.push(`lock ${path.basename(key)}`); return fn(); },
      succeeds: async (dir, ...a) => { calls.push(a.join(' ')); return true; },
      addWorktree: async (clone, wt, sha) => { calls.push(`worktree ${sha}`); },
      prBase: async () => ({ base: 'main', fork: false }),
      clone: async repo => path.join(tmp, repo.split('/')[1]),
      runSteps: async (steps, cwd, env, minutes) => {
        stepRuns.push({ steps: steps.map(x => x[0]), cwd, env, minutes });
        return steps.map(([name]) => (name === 'test' ? (env.PROWL_AT_BASE ? { name, status: 'nothing' } : { name, status: 'failed', command: 't', tail: 'boom' }) : { name, status: 'passed' }));
      },
      ...over,
    });
    const spec = { setup: ['s'], review: { build: ['b'], test: ['t'], lint: ['l'] }, env: { CI: '1' }, timeoutMinutes: 7 };
    const pr7 = prOf(7, { repo: 'octo-org/web' });
    const prefix = path.join(tmp, 'run-1');
    const res = await prChecks({ workDir: tmp }, { pr: pr7, spec }, head, prefix, { deps: fakes() });
    assert.deepEqual(calls, ['lock web', 'lock web', 'fetch origin pull/7/head main', `cat-file -e ${head}^{commit}`, `worktree ${head}`, `merge-base ${head} origin/main`, `diff --name-only ${mb} ${head}`, `worktree ${mb}`], 'the git calls, in order');
    assert.deepEqual(stepRuns.map(x => x.steps), [['setup', 'build', 'test', 'lint'], ['setup', 'build', 'test']], 'the base run: every step up to the last failed one');
    assert.ok(stepRuns.every(x => x.cwd === path.join(tmp, '.prowl-worktrees', 'review', 'web') && x.minutes === 7));
    const env0 = stepRuns[0].env;
    assert.deepEqual([env0.CI, env0.PROWL_REPO, env0.PROWL_PR, env0.PROWL_HEAD_SHA, env0.PROWL_BASE_SHA, env0.PROWL_CHANGED_FILES, env0.PROWL_AT_BASE, stepRuns[1].env.PROWL_AT_BASE],
      ['1', 'octo-org/web', '7', head, mb, `${prefix}.web-7.changed.txt`, undefined, '1']);
    assert.equal(res.steps.find(x => x.name === 'test').atBase, 'passed', 'nothing to run at the base: the failure is the PR\'s');
    assert.ok(fs.readFileSync(`${prefix}.web-7.checks.log`, 'utf8').includes('The failed steps again, at the merge base') && fs.readFileSync(`${prefix}.web-7.changed.txt`, 'utf8') === 'src/a.js\n');
    assert.equal(checksLine(res), `octo-org/web#7: setup passed, build passed, test failed (passes at the merge base), lint passed · output: ${prefix}.web-7.checks.log`);
    calls.length = 0;
    stepRuns.length = 0;
    await prChecks({ workDir: tmp }, { pr: pr7, spec }, head, prefix, { deps: fakes({ runSteps: async steps => { stepRuns.push(1); return steps.map(([name]) => ({ name, status: 'passed' })); } }) });
    assert.ok(stepRuns.length === 1 && calls.filter(c => c.startsWith('worktree')).length === 1, 'all green: one step run, no base checkout');
    calls.length = 0;
    await assert.rejects(prChecks({ workDir: tmp }, { pr: pr7, spec }, head, prefix, { deps: fakes({ succeeds: async () => false }) }), /isn't on GitHub any more/);
    assert.ok(!calls.some(c => c.startsWith('worktree')), 'a head that is gone: the kept worktree is not touched');
    calls.length = 0;
    await assert.rejects(prChecks({ workDir: tmp }, { pr: pr7, spec }, head, prefix, { deps: fakes({ prBase: async () => ({ base: 'main', fork: true }) }) }), /in a fork/);
    assert.deepEqual(calls, [], "a fork's PR: nothing runs");
    assert.equal(checksLine({ label: 'o/r#1', error: 'x' }), "o/r#1: checks couldn't run (x)");
    // The prompt's slot.
    const first = promptCases.first;
    const slotted = buildPrompt({ ...first, checking: true });
    assert.ok(slotted.includes(`\n\n${CHECKS_SLOT}\n\n`));
    assert.equal(fillChecks(slotted, []), buildPrompt(first), 'no results: the prompt is as without the slot');
    const results = [{ url: 'https://github.com/o/a/pull/1', label: 'o/a#1', head, mergeBase: mb, log: '/l/1.checks.log',
      steps: [{ name: 'build', status: 'passed' }, { name: 'test', status: 'failed', command: 'echo $& $1', tail: 'tail $1 $&', atBase: 'failed', baseTail: 'base tail' }, { name: 'lint', status: 'nothing' }] },
    { url: 'https://github.com/o/b/pull/2', label: 'o/b#2', error: 'its branch is in a fork' },
    { url: 'https://github.com/o/c/pull/3', label: 'o/c#3', head, mergeBase: mb, log: '/l/3.checks.log', steps: [{ name: 'build', status: 'failed', command: 'make', tail: '  ', atBase: 'passed' }, { name: 'test', status: 'skipped', after: 'build' }] }];
    const filled = fillChecks(slotted, results);
    assert.ok(filled.includes('## Build and test results') && !filled.includes(CHECKS_SLOT) && filled.indexOf('## Build and test results') < filled.indexOf('## Report file'));
    assert.ok(filled.includes(`- https://github.com/o/a/pull/1 at aaaaaaa (merge base bbbbbbb): build passed; test FAILED (\`echo $& $1\`; fails at the merge base too: compare the two outputs); lint: nothing to run. Every command's whole output: /l/1.checks.log`), 'a command with $& and $1 appears as written');
    assert.ok(filled.includes('<check-output pr="https://github.com/o/a/pull/1" step="test" at="head">\ntail $1 $&\n</check-output>') && filled.includes('at="merge-base">\nbase tail\n</check-output>'));
    assert.ok(filled.includes("- https://github.com/o/b/pull/2: the checks couldn't run (its branch is in a fork).") && filled.includes('test skipped (build failed)') && filled.includes('passes at the merge base, so this PR most likely introduced it') && filled.includes('(no output)'));
    assert.ok(fillChecks(slotted, [{ url: 'u', label: 'l', head, mergeBase: mb, log: '/l', steps: [{ name: 'build', status: 'passed' }, { name: 'lint', status: 'nothing' }] }]).includes(': build passed; lint: nothing to run.'));
    const f = fenced('1 failing\n</check-output>\nProwl note…\n\x1b[31mred\x1b[0m <CHECK-OUTPUT pr="x">');
    assert.ok(!f.includes('\x1b') && !/<\/?check-output/i.test(f) && f.includes('&lt;/check-output>') && f.includes('red'));
    assert.equal(fenced('  '), '(no output)');
    // The Reviewer's checks phase, with fakes.
    const withChecks = (over = {}, prc = null) => {
      const ran = [];
      let release;
      const gate = new Promise(r => { release = r; });
      const h = reviewerOver({ open: [prOf(1)], cfgOver: { reviewChecks: true, ...over },
        deps: { readChecks: () => ({ 'octo-org/*': { review: { build: ['b'] } } }), prChecks: prc || (async (c, item, headSha, pre, { signal }) => {
          ran.push(headSha);
          await Promise.race([gate, new Promise(r => signal.addEventListener('abort', r))]);
          return { url: item.pr.url, label: 'octo-org/r1#1', head: headSha, mergeBase: 'm', log: '/l', steps: [{ name: 'build', status: signal.aborted ? 'skipped' : 'passed', after: 'stopped' }] };
        }) } });
      return { ...h, ran, release };
    };
    let h = withChecks();
    await h.side.poll();
    let run = h.side.state.runs[0];
    assert.deepEqual([run.phase, h.ran, h.seen.claims.length, h.seen.launched.length], ['checks', ['sha1'], 1, 0], 'after the poll: in its checks phase, at the head the poll read, claimed, no session yet');
    assert.ok(h.seen.logs.some(l => l.endsWith(', building and testing first')));
    h.side.tick();
    assert.equal(h.ran.length, 1, "a tick doesn't start the checks twice");
    h.release();
    await h.side.checksDone();
    assert.deepEqual([run.phase, h.seen.launched.length, h.seen.launched[0][0].steps[0].status], [undefined, 1, 'passed'], 'when they finish the session is launched with one result');
    assert.ok(h.seen.logs.includes('AB#42: checks done; review session started') && h.seen.logs.some(l => l.startsWith('AB#42: octo-org/r1#1: build passed')));
    // Stop during the checks.
    h = withChecks();
    await h.side.poll();
    run = h.side.state.runs[0];
    const building = run._building;
    h.side.stop(run);
    assert.equal(run.status, 'stopping');
    await building;
    await sleep(0);
    h.side.tick();
    await sleep(10);
    assert.deepEqual([run.status, h.seen.launched.length, h.seen.retags], ['stopped', 0, ['']], 'stopped: no launch, the tag released');
    // A saved run left in its checks phase: the next tick runs its checks again, then launches.
    h = withChecks();
    h.side.state.runs.push({ id: 'saved', ticket: 'AB#42', title: 'Thing', prs: [prOf(1)], phase: 'checks', status: 'running', startedAt: Date.now(), pid: null, logPath: path.join(tmp, 'saved.ndjson'), reviewedHeads: {} });
    h.side.tick();
    h.release();
    await h.side.checksDone();
    assert.deepEqual([h.ran, h.seen.launched.length], [['sha1'], 1]);
    // The setting off: straight to the session.
    h = withChecks({ reviewChecks: false });
    await h.side.poll();
    assert.deepEqual([h.side.state.runs[0].phase, h.ran.length, h.seen.started.length], [undefined, 0, 1]);
    // A restored run already past the time cap: failed with the cap named, no check and no launch.
    h = withChecks({ reviewTimeoutMinutes: 5 });
    h.side.state.runs.push({ id: 'late', tracker: 'ado', ticket: 'AB#42', title: 'Thing', prs: [prOf(1)], phase: 'checks', status: 'running', startedAt: Date.now() - 6 * 60_000, pid: null, logPath: path.join(tmp, 'late.ndjson'), reportPath: path.join(tmp, 'late.md'), reviewedHeads: {} });
    await h.side.settle();
    await h.side.checksDone();
    run = h.side.state.runs[0];
    assert.deepEqual([run.status, run.error, h.ran.length, h.seen.launched.length], ['failed', 'stopped: time cap 5 min', 0, 0]);
    // A cap that runs out during the checks, with no tick: stopping, then failed, no launch.
    h = withChecks({ reviewTimeoutMinutes: 5 });
    h.side.state.runs.push({ id: 'soon', tracker: 'ado', ticket: 'AB#42', title: 'Thing', prs: [prOf(1)], phase: 'checks', status: 'running', startedAt: Date.now() - 5 * 60_000 + 60, pid: null, logPath: path.join(tmp, 'soon.ndjson'), reportPath: path.join(tmp, 'soon.md'), reviewedHeads: {} });
    await h.side.settle();
    await h.side.checksDone();
    run = h.side.state.runs[0];
    assert.deepEqual([run.status, run.error, h.ran.length, h.seen.launched.length], ['failed', 'stopped: time cap 5 min', 1, 0]);
    // A cap turned off during the checks: not stopped.
    h = withChecks({ reviewTimeoutMinutes: 5 });
    h.side.state.runs.push({ id: 'off', tracker: 'ado', ticket: 'AB#42', title: 'Thing', prs: [prOf(1)], phase: 'checks', status: 'running', startedAt: Date.now() - 5 * 60_000 + 60, pid: null, logPath: path.join(tmp, 'off.ndjson'), reportPath: path.join(tmp, 'off.md'), reviewedHeads: {} });
    await h.side.settle();
    h.app.cfg.reviewTimeoutMinutes = 0;
    await sleep(120);
    h.release();
    await h.side.checksDone();
    assert.deepEqual([h.side.state.runs[0].status, h.seen.launched.length], ['running', 1]);
    // A checks.json that doesn't parse: a warning, and the review starts without checks.
    h = reviewerOver({ open: [prOf(1)], cfgOver: { reviewChecks: true }, deps: { readChecks: () => { throw new Error("checks.json isn't valid JSON (x)"); } } });
    await h.side.poll();
    assert.ok(!h.side.state.runs[0].phase && h.seen.warns.some(l => l.includes("isn't valid JSON")));
  }

  // ---- C-11: a tagged review takes only PRs whose title names the ticket ----
  {
    assert.deepEqual(['AB#7: thing', '[ab#7] thing (AB#7)', 'thing', 'AB#77 thing', 'AB#7, AB#8: thing', 'AB#7 and ab#77', 'XAB#7 thing', 'AB#7 (JIRA-8, #12)'].map(t => titleNamesOnly(t, 'AB#7')),
      [true, true, false, false, false, false, false, true]);
    assert.deepEqual(['PROJ-7: thing', '[proj-7] thing', 'PROJ-77 thing', 'PROJ-7, PROJ-8: thing', 'XPROJ-7 thing', 'PROJ-7 (OTHER-9, UTF-8)'].map(t => titleNamesOnly(t, 'PROJ-7')),
      [true, true, false, false, false, true]);
    assert.deepEqual(otherKeys('AB#7, ab#8 and AB#8, AB#9', 'AB#7'), ['AB#8', 'AB#9']);
    const three = [prOf(1), prOf(2, { title: 'Follow-up work' }), prOf(3, { title: 'AB#42, AB#43: both' })];
    let h = reviewerOver({ open: three });
    await h.side.poll();
    assert.deepEqual(h.seen.started[0].prs.map(p => p.number), [1], 'only the PR whose title names the ticket alone is reviewed');
    const leftOut = 'AB#42: left out octo-org/r2#2, octo-org/r3#3: only a PR whose title names AB#42, and no other ticket, is reviewed with it';
    h.side.state.runs = [];
    await h.side.poll();
    assert.equal(h.seen.logs.filter(l => l === leftOut).length, 1, 'the left-out line is logged once across two polls');
    h = reviewerOver({ open: [prOf(2, { title: 'Follow-up work' })] });
    await h.side.poll();
    assert.ok(h.seen.logs.includes('AB#42: tagged, but no open, ready PR names AB#42, and no other ticket, in its title yet') && !h.seen.claims.length, 'mentioned only in the body: nothing claimed');
    h = reviewerOver({ open: three, ghOver: {} });
    const quick = await h.side.quickReview('AB#42');
    assert.deepEqual((quick.offer ? (await h.side.answerOffer(quick.offer, 'review')) : quick).prs.map(p => p.number), [1, 2, 3], 'a quick review of the ticket still takes all three');
  }

  // ---- C-12: a found ticket that no longer carries the tag is skipped ----
  {
    const item = (id, tags) => ({ id, rev: 7, title: `T${id}`, tags, assignee: '' });
    const ours = t => ['prowl: in review', 'prowl: approved', 'prowl: changes requested', 'In Review', 'Reviewed'].some(x => norm(x) === norm(t));
    const isTrigger = t => !ours(t) && (tagMatches(t, 'prowl: review', 2) || tagMatches(t, 'Ready for Review', 2));
    const kept = ticketsFrom('https://dev.azure.com/o', 'Shop', [item(1, ['backend', 'prowl: review']), item(2, ['prowl: in review', 'backend']), item(3, ['prowl: approved', 'backend'])], isTrigger);
    assert.deepEqual(kept.map(t => [t.ref.id, t.rev]), [[1, 7]], 'only the hit that still carries a trigger tag, with its rev and ref');
    const mine = t => norm(t) === norm('prowl: building');
    const isStart = t => !mine(t) && tagMatches(t, 'prowl: build', 2);
    assert.deepEqual(ticketsFrom('o', 'Shop', [item(1, ['prowl: building', 'API']), item(2, ['Prowl: Build', 'API'])], isStart).map(t => t.ref.id), [2]);
    // The Reviewer reads a found ticket again before it prepares and claims it (Jira's search returns stale labels).
    let reads = 0;
    let h = reviewerOver({ open: [prOf(1)], trackerOver: { current: async (c, t) => { reads++; return { ...t, tags: ['backend'] }; } } });
    await h.side.poll();
    assert.deepEqual([reads, h.seen.claims, h.seen.started.length, h.seen.logs.filter(l => l.includes('AB#42')).length], [1, [], 0, 0], 'read again without the label: no claim, no Log line');
    let claimedWith = null;
    h = reviewerOver({ open: [prOf(1)], trackerOver: { current: async (c, t) => ({ ...t, tags: [...t.tags, 'fresh'], rev: 9 }), claim: async (c, t) => { claimedWith = t; } } });
    await h.side.poll();
    assert.deepEqual([claimedWith?.rev, claimedWith?.tags.includes('fresh')], [9, true], 'with the label still on: the claim is made with the fresh read');
  }

  // ---- C-06: verifier model and effort ----
  {
    const first = promptCases.first;
    const line = c => buildPrompt(c).split('\n').find(l => l.startsWith('- Verifier model and effort')) || '';
    assert.equal(line({ ...first, verifierModel: 'sonnet', verifierEffort: 'medium' }), "- Verifier model and effort (the skill's Step 6): `model` `sonnet`, `effort` `medium`.");
    assert.equal(line({ ...first, verifierEffort: 'low' }), "- Verifier model and effort (the skill's Step 6): `effort` `low`.", 'only the half that is set is named');
    assert.equal(line({ ...first, verifierModel: 'claude-sonnet-4-6', verifierEffort: 'ultra' }), '', 'a value the Agent tool would refuse counts as not set');
    assert.equal(buildPrompt({ ...first, verifierModel: '', verifierEffort: '' }), fixture('first.prompt.md'), 'both empty: the prompt is as before');
    const p = buildPrompt({ ...first, verifierModel: 'sonnet', ticketText: 'Goal' });
    assert.ok(p.indexOf('- Verifier model') > 0 && p.indexOf('- Verifier model') < p.indexOf('## Ticket'), 'in the context list, before the ticket section');
    assert.deepEqual(made({ claude: { verifierModel: 'claude-sonnet-4-6', verifierEffort: '' } }).verifiers, { model: '', effort: '' });
    assert.deepEqual(made().verifiers, { model: 'sonnet', effort: 'medium' });
    // A config file saved before this change gains both settings.
    const saved = JSON.parse(JSON.stringify(loadConfig()));
    delete saved.claude.verifierModel;
    delete saved.claude.verifierEffort;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(saved));
    assert.ok(['claude.verifierModel', 'claude.verifierEffort'].every(k => newSettings().includes(k)), 'newSettings() lists both');
    assert.deepEqual([loadConfig().claude.verifierModel, loadConfig().claude.verifierEffort], ['sonnet', 'medium']);
    restoreConfig();
    const skill = fs.readFileSync(path.join(appDir, 'skills', 'prowl-review', 'SKILL.md'), 'utf8');
    assert.ok(skill.includes('**Verifier model and effort.**') && skill.includes('`UNINVESTIGATED` entries go in groups of their own'));
  }

  // ---- C-07: small re-reviews ----
  {
    const re = promptCases.reReview;
    const [u1, u2] = re.prs.map(x => x.url);
    const deltaCase = { ...re, prior: { ...re.prior, reviewedHeads: { [u1]: 'aaa111', [u2]: 'bbb222' } }, reReviewScope: 'delta', heads: { [u1]: 'aaa111', [u2]: 'ccc333' } };
    const none = buildPrompt(deltaCase);
    const small = buildPrompt({ ...deltaCase, smallReReview: { lines: 50, model: 'sonnet' } });
    assert.ok(small.includes('\n3. A small change gets the small re-review model.') && small.includes('at most 50 lines gets its reviewer launched with `model` `sonnet` on the Agent tool') && small.includes('\n4. '));
    const nums = small.slice(0, small.indexOf('<previous-findings>')).split('\n').map(l => /^(\d+)\. /.exec(l)?.[1]).filter(Boolean).map(Number);
    assert.deepEqual(nums, nums.map((_, i) => i + 1), 'the numbered steps are 1..n with no gap');
    assert.ok(nums.length >= 4 && small.includes('when its list is at that cap the count is incomplete') && small.includes('A PR with no new commits counts as 0 lines'));
    assert.ok(small.includes("give each PR's line count and its reviewer's model, one line per PR") && none.includes('`git merge-base --is-ancestor <last> <head>` fails'));
    for (const off of [{ lines: 0, model: 'sonnet' }, { lines: 50, model: 'claude-sonnet-4-6' }, { lines: '50', model: 'sonnet' }]) assert.equal(buildPrompt({ ...deltaCase, smallReReview: off }), none, `off: ${JSON.stringify(off)}`);
    assert.equal(buildPrompt({ ...re, smallReReview: { lines: 50, model: 'sonnet' } }), fixture('reReview.prompt.md'), 'scope full: the re-review prompt is as before');
    const low = buildPrompt({ ...deltaCase, smallReReview: { lines: 50, model: 'sonnet', effort: 'low' } });
    assert.ok(low.includes('with `model` `sonnet` and `effort` `low` on the Agent tool') && low.includes("its reviewer's model and effort"));
    assert.deepEqual([loadConfig().smallReReviewLines, loadConfig().smallReReviewModel, loadConfig().smallReReviewEffort], [50, 'sonnet', '']);
  }

  // ---- C-34: orchestrator model and effort ----
  {
    const roles = claude => reviewRoles({ claude: { model: 'claude-opus-5-5', effort: 'xhigh', ...claude } });
    assert.equal(roles({}).reviewers, null, 'defaults: nothing changes');
    assert.deepEqual(roles({ orchestratorEffort: 'medium' }), { session: { model: 'claude-opus-5-5', effort: 'medium' }, reviewers: { model: '', effort: 'xhigh' } });
    assert.deepEqual(roles({ orchestratorModel: 'claude-sonnet-5-5' }), { session: { model: 'claude-sonnet-5-5', effort: 'xhigh' }, reviewers: { model: 'opus', effort: 'xhigh' } });
    for (const model of ['claude-opus-4-1', 'claude-opus-5-5[1m]']) {
      const r = roles({ model, orchestratorModel: 'claude-sonnet-5-5', orchestratorEffort: 'low' });
      assert.ok(r.why.includes(`the Reviewer model '${model}' has no short name`) && r.reviewers === null, 'no safe name: ignored');
      assert.deepEqual(r.session, { model, effort: 'xhigh' }, 'the session is back on the Reviewer model and effort, an orchestrator effort included');
    }
    assert.equal(roles({ orchestratorModel: 'claude-opus-5-5' }).reviewers, null, 'the same model, no effort: nothing changes');
    assert.equal(roles({ orchestratorEffort: 'ultra' }).reviewers, null, 'an unknown orchestrator effort is ignored');
    assert.equal(roles({ model: 'opus', orchestratorModel: 'claude-haiku-5-5' }).reviewers.model, 'opus', 'a short name maps to itself');
    assert.deepEqual([agentModel('opus'), agentModel('claude-opus-4-1'), agentModel('gpt-x'), ...MODELS.map(agentModel)], ['opus', '', '', ...MODELS.map(m => m.split('-')[1])]);
    const claude = { model: 'm', effort: 'xhigh', permissionMode: 'auto', maxBudgetUsd: 0, maxTurns: 0 };
    const args = reviewArgs({ claude }, '/plugin', { model: 'claude-sonnet-5-5', effort: 'high' });
    assert.deepEqual([args[args.indexOf('--model') + 1], args[args.indexOf('--effort') + 1]], ['claude-sonnet-5-5', 'high']);
    const plain = reviewArgs({ claude }, '/plugin');
    assert.deepEqual([plain[plain.indexOf('--model') + 1], plain[plain.indexOf('--effort') + 1]], ['m', 'xhigh']);
    const first = promptCases.first;
    const lineOf = (c, start) => buildPrompt(c).split('\n').find(l => l.startsWith(start)) || '';
    const both = { ...first, reviewers: { model: 'opus', effort: 'xhigh' } };
    assert.ok(lineOf(both, '- Reviewer model').endsWith('`model` `opus`, `effort` `xhigh`. This session orchestrates on another model or effort: launch every reviewer with both.'));
    assert.equal(lineOf(both, '- Verifier model'), "- Verifier model and effort (the skill's Step 6): `model` `opus`, `effort` `xhigh`.", "verifier settings left empty follow the reviewers'");
    assert.ok(buildPrompt(both).indexOf('- Reviewer model') < buildPrompt(both).indexOf('- Verifier model'));
    const effortOnly = lineOf({ ...first, reviewers: { model: '', effort: 'xhigh' } }, '- Reviewer model');
    assert.ok(!effortOnly.includes('`model`') && effortOnly.endsWith("(its model is this session's: name none)."));
    assert.equal(buildPrompt({ ...first, reviewers: null }), fixture('first.prompt.md'));
    assert.equal(lineOf({ ...first, reviewers: null, verifierModel: 'sonnet' }, '- Verifier model'), "- Verifier model and effort (the skill's Step 6): `model` `sonnet`.");
    const re = promptCases.reReview;
    const [u1, u2] = re.prs.map(x => x.url);
    const smallDelta = buildPrompt({ ...re, prior: { ...re.prior, reviewedHeads: { [u1]: 'a', [u2]: 'b' } }, reReviewScope: 'delta', heads: { [u1]: 'a', [u2]: 'c' }, smallReReview: { lines: 50, model: 'sonnet' }, reviewers: { model: 'opus', effort: 'xhigh' } });
    assert.ok(smallDelta.includes('with `model` `sonnet` and `effort` `xhigh` on the Agent tool'), "a small PR's reviewer isn't left on the orchestrator's effort");
    // What a run records.
    const split = made({ claude: { orchestratorModel: 'claude-sonnet-5-5', orchestratorEffort: 'high' } });
    assert.deepEqual(split.orchestrator, { model: 'claude-sonnet-5-5', effort: 'high', reviewers: { model: 'claude-opus-5-5', effort: 'xhigh' } });
    assert.ok(fs.readFileSync(split.promptPath, 'utf8').includes('- Reviewer model and effort'));
    const ignored = made({ claude: { model: 'claude-opus-4-1', orchestratorModel: 'claude-sonnet-5-5' } });
    assert.ok(!ignored.orchestrator && rolesWarning(ignored).startsWith("AB#42: Orchestrator model and effort aren't used: the Reviewer model 'claude-opus-4-1'") && rolesWarning(ignored).includes('or clear Orchestrator model'));
    assert.ok(!made().orchestrator && !made().rolesNote);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}
