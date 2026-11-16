// Part of node prowl.mjs --self-test: the checks for features added after 2.23.6, a section each.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, HOME, loadConfig, newSettings, takeNameNotes } from './config.mjs';
import { killChecks, reviewSteps, runChecks, runCommand, runSteps } from './checks.mjs';
import { addWorktree, noHooks, noHooksEnv } from './git.mjs';
import { branchHadPr, fromOwnBranch, otherKeys, prForBranch, titleNamesOnly } from './github.mjs';
import { ticketsFrom } from './ado.mjs';
import { createLabels } from './labels.mjs';
import { norm, tagMatches } from './match.mjs';
import { askLabel, labelNames, labelRole, labelWrite, migrateNames, outcomeTag, pendingTag, renamedWrite, reviewTags, sameLabel, splitDone, tagReader, wasRole } from './names.mjs';
import { label as jiraLabel } from './jira.mjs';
import { builderTags, gateDecision, workState } from './builder/rules.mjs';
import { baseSteps, checkPlan, checksLine, prChecks } from './reviewer/checks.mjs';
import { createReviewer } from './reviewer/reviewer.mjs';
import { MODELS } from './config.mjs';
import { agentModel, buildPrompt, CHECKS_SLOT, createReview, fenced, fillChecks, fillPrep, finalize, PREP_SLOT, reviewArgs, reviewRoles, rolesWarning } from './reviewer/reviews.mjs';
import { readActivity, sessionEnded } from './sessions.mjs';
import { startTui } from './tui.mjs';

const WIN = process.platform === 'win32';
const sh = (cwd, cmd, args, env) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

export async function run(assert, { appDir }) { // eslint-disable-line no-unused-vars
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-feat-'));
  fs.rmSync(CONFIG_PATH, { force: true }); // these checks run on the defaults: the older tests pin the tags to their old names
  loadConfig();
  takeNameNotes();
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
    const cfg = { ...loadConfig(), githubOwner: 'octo-org', workDir: tmp, taskBoard: board, reviewPrep: false, ...cfgOver }; // C-32's tests turn the setup on, with a stubbed prepare
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
    const labels = deps.labels || { own() {}, set: (...a) => labelCalls.push(a), refused: () => '', pending: () => false };
    const side = createReviewer(app, { log: (level, msg, key) => { if (key && byKey.get(key) === msg) return false; if (key) byKey.set(key, msg); seen.logs.push(msg); if (level === 'warn' || level === 'error') seen.warns.push(msg); return true; }, forget: key => byKey.delete(key), hoot() {}, appDir, trackers: { ado: tracker, jira: tracker }, github: gh, labels, autoName: async () => 'Named', ...deps });
    side.state = { runs: structuredClone(runs), failures: {} };
    let n = 0;
    const fake = (c, opts) => ({ id: `AB42-${++n}`, tracker: opts.tracker, ref: opts.ticket.ref, ticket: opts.ticket.key, title: opts.ticket.title, ticketUrl: opts.ticket.url, prs: opts.prs, contextPrs: opts.approvedPrs || [], reviewNo: (opts.prior?.reviewNo || 0) + 1, priorId: opts.prior?.id || null,
      status: 'running', startedAt: Date.now(), pid: null, logPath: path.join(tmp, `fake-${n}.ndjson`), reportPath: path.join(tmp, `fake-${n}.md`), reviewedHeads: opts.heads || {}, approved: Object.fromEntries((opts.approvedPrs || []).filter(p => opts.prior?.approved?.[p.url]).map(p => [p.url, opts.prior.approved[p.url]])), ...(opts.quick && { quick: true }), ...(opts.checking && { phase: 'checks' }) });
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
    assert.ok(slotted.includes(`\n\n${CHECKS_SLOT}\n`));
    assert.equal(fillChecks(slotted, []), buildPrompt(first), 'no results: the prompt is as without the slot');
    const results = [{ url: 'https://github.com/o/a/pull/1', label: 'o/a#1', head, mergeBase: mb, log: '/l/1.checks.log',
      steps: [{ name: 'build', status: 'passed' }, { name: 'test', status: 'failed', command: 'echo $& $1', tail: 'tail $1 $&', atBase: 'failed', baseTail: 'base tail' }, { name: 'lint', status: 'nothing' }] },
    { url: 'https://github.com/o/b/pull/2', label: 'o/b#2', error: 'its branch is in a fork' },
    { url: 'https://github.com/o/c/pull/3', label: 'o/c#3', head, mergeBase: mb, log: '/l/3.checks.log', steps: [{ name: 'build', status: 'failed', command: 'make', tail: '  ', atBase: 'passed' }, { name: 'test', status: 'skipped', after: 'build' }] }];
    const filled = fillChecks(slotted, results);
    assert.ok(filled.includes('## Build and test results') && !filled.includes(CHECKS_SLOT) && filled.indexOf('## Build and test results') > filled.indexOf('- The checker command'));
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

  // ---- C-18: a quick review doesn't start on PRs another review has ----
  {
    const two = [prOf(1), prOf(2, { title: 'unrelated' })];
    let h = reviewerOver({ open: two, cfgOver: { quickName: 'number', maxConcurrentReviews: 5, quickLabels: false } });
    await h.side.poll(); // the tagged review of AB#42 runs on r1#1
    assert.deepEqual(h.side.state.runs.map(r => r.prs.map(p => p.number)), [[1]]);
    await assert.rejects(h.side.quickReview('octo-org/r1#1'), { message: 'Quick review: octo-org/r1#1 is under review in AB#42; start it again once that one ends' });
    await assert.rejects(h.side.quickReview('octo-org/r1#1 octo-org/r2#2'), /octo-org\/r1#1 is under review in AB#42/, 'one held PR is enough');
    h.side.state.runs[0].contextPrs = [prOf(2)];
    assert.equal((await h.side.quickReview('octo-org/r2#2')).ticket, 'QUICK#1', "an overlap with a running review's context PR starts");
    // Two quick reviews of the same PR started together: exactly one run.
    let release;
    const hold = new Promise(r => { release = r; });
    h = reviewerOver({ open: two, cfgOver: { quickName: 'auto', maxConcurrentReviews: 5, quickLabels: false }, deps: { autoName: async () => { await hold; return 'Named'; } } });
    const a = h.side.quickReview('octo-org/r2#2');
    await sleep(5);
    await assert.rejects(h.side.quickReview('octo-org/r2#2'), { message: 'Quick review: octo-org/r2#2 is already being set up for a review; start it again once that one ends' });
    release();
    await a;
    assert.equal(h.side.state.runs.length, 1);
    // A review that starts on the PR while the first is being named: the second check refuses it.
    let release2;
    const hold2 = new Promise(r => { release2 = r; });
    h = reviewerOver({ open: two, cfgOver: { quickName: 'auto', maxConcurrentReviews: 5, quickLabels: false }, deps: { autoName: async () => { await hold2; return 'Named'; } } });
    const b = h.side.quickReview('octo-org/r2#2');
    await sleep(5);
    h.side.state.runs.push({ id: 'x', ticket: 'PROJ-9', status: 'running', prs: [prOf(2)], pid: null, phase: 'checks', _building: hold2 });
    release2();
    await assert.rejects(b, /octo-org\/r2#2 is under review in PROJ-9/);
    // A wait whose PR is under another review isn't ended: it logs once and tries again each poll.
    h = reviewerOver({ open: [prOf(1, { labels: ['Ready for Review'] })], tickets: [], cfgOver: { quickName: 'number', maxConcurrentReviews: 5 } });
    h.side.state.runs.push({ id: 'q1', ticket: 'QUICK#1', quick: true, status: 'done', endedAt: 1, reviewNo: 1, prs: [prOf(1)], approved: {}, reportPath: '/nowhere.md' },
      { id: 'other', ticket: 'PROJ-9', status: 'running', prs: [prOf(1)], pid: null, phase: 'checks', _building: hold2 });
    h.side.waits().push({ key: 'QUICK#1', title: 't', ticketUrl: '', paste: { prs: [{ repo: 'octo-org/r1', number: 1 }], tickets: [] }, runId: 'q1', since: 1, letGo: {} });
    await h.side.poll();
    await h.side.poll();
    assert.equal(h.seen.logs.filter(l => l.includes("QUICK#1: couldn't start its re-review (Quick review: octo-org/r1#1 is under review in PROJ-9")).length, 1, 'logged once');
    assert.equal(h.side.waits().length, 1, 'still waiting');
    h.side.state.runs.find(r => r.id === 'other').status = 'done';
    await h.side.poll();
    assert.ok(h.side.state.runs.some(r => r.ticket === 'QUICK#1' && r.status === 'running'), 'and starts on the poll after that review ends');
  }

  /** A headless TUI over fake sides: { tui, app, sides, calls (what the actions were asked), text(w, h) (a frame as one string) }. */
  function tuiOver({ reviewer = {}, builder = {}, cfgOver = {}, actions = {}, io = {} } = {}) {
    const app = { cfg: { ...loadConfig(), ...cfgOver }, me: 'octocat', log: [], notes: null, override: {}, sideOn: n => app.override[n] ?? Boolean(app.cfg[n]?.enabled),
      tracker: () => ({ name: 'Azure DevOps', boardLabel: b => `${b.project} / ${b.team}` }), boards: () => [{ project: 'Shop', team: 'Web' }], dryRun: () => false, hasToken: () => false, speech: () => null, offers: [] };
    const mk = extra => ({ paused: false, polling: false, nextPoll: Date.now() + 60_000, lastError: '', running: () => [], needs: () => [], finished: () => [], history: () => [], waits: () => [], preparing: () => [], state: { runs: [] }, tagVariants: {}, stopText: r => `Stop the review of ${r.ticket}?`, ...extra });
    const sides = { reviewer: mk(reviewer), builder: mk(builder) };
    const calls = [];
    const act = name => async (...a) => { calls.push([name, ...a]); return null; };
    const tui = startTui(app, { sides, pollNow() {}, togglePause() {}, saveConfig: () => calls.push(['saveConfig']), saveToken: () => '', quit: () => calls.push(['quit']), stop: (...a) => calls.push(['stop', ...a]),
      quickReview: act('quickReview'), quickBuild: act('quickBuild'), reReview: act('reReview'), answerOffer: act('answerOffer'), stopWait: wt => calls.push(['stopWait', wt.key]), toggleSide: () => true,
      answer: act('answer'), discuss: act('discuss'), skip: act('skip'), handBack: act('handBack'), follow: act('follow'), stopFollowing: act('stopFollowing'), ...actions }, { headless: true, ...io });
    return { tui, app, sides, calls, text: (w = 100, h = 30) => tui.frame(w, h).join('\n') };
  }

  // ---- C-20: v in History reviews the PRs again ----
  {
    const past = (over = {}) => ({ id: 'AB42-r1', tracker: 'ado', ref: { id: 42 }, ticket: 'AB#42', title: 'Saved title', ticketUrl: 'https://dev.azure.com/o/Shop/_workitems/edit/42', status: 'done', endedAt: 5, reviewNo: 1,
      prs: [prOf(1), prOf(2)], contextPrs: [], approved: {}, reportPath: '/nowhere.md', ...over });
    let h = reviewerOver({ open: [prOf(1), prOf(2)], tickets: [], runs: [past()], cfgOver: { quickLabels: false }, trackerOver: { lookup: async (c, key) => ({ key, title: 'Fresh title' }) } });
    let run = await h.side.reReview(h.side.state.runs[0]);
    assert.deepEqual([run.ticket, run.quick, run.reviewNo, run.priorId, run.ref, run.title], ['AB#42', true, 2, 'AB42-r1', null, 'Fresh title'], "a quick re-review under the saved key, the first review as its prior, the ticket's title read again");
    fs.writeFileSync(run.reportPath, '---\nverdict: APPROVE\n---\n');
    run._result = { subtype: 'success', is_error: false };
    await h.side.finish(run);
    assert.deepEqual([run.status, h.seen.retags, h.seen.claims], ['done', [], []], 'finishing it writes no tag');
    // A QUICK#2 keeps its number, and the next pasted quick review still becomes QUICK#3.
    h = reviewerOver({ open: [prOf(1), prOf(2, { title: 'other' })], tickets: [], runs: [past({ id: 'q2', ticket: 'QUICK#2', title: 'Named', ticketUrl: '', prs: [prOf(1)], quick: true })], cfgOver: { quickLabels: false, quickName: 'number', maxConcurrentReviews: 5 }, trackerOver: { lookup: async () => { throw new Error('not a ticket'); } } });
    run = await h.side.reReview(h.side.state.runs[0]);
    assert.deepEqual([run.ticket, run.reviewNo, run.title], ['QUICK#2', 2, 'Named']);
    assert.equal((await h.side.quickReview('octo-org/r2#2')).ticket, 'QUICK#3');
    // One PR merged since: left out, with the Log line. All merged: refused.
    h = reviewerOver({ open: [prOf(1), prOf(2, { state: 'merged' })], tickets: [], runs: [past()], cfgOver: { quickLabels: false } });
    run = await h.side.reReview(h.side.state.runs[0]);
    assert.ok(run.prs.length === 1 && h.seen.logs.includes('AB#42: octo-org/r2#2 is merged; left out'));
    h = reviewerOver({ open: [prOf(1, { state: 'merged' }), prOf(2, { state: 'closed' })], tickets: [], runs: [past()] });
    await assert.rejects(h.side.reReview(h.side.state.runs[0]), /none of its PRs is open/);
    h = reviewerOver({ open: [prOf(1), prOf(2)], tickets: [], runs: [past()], cfgOver: { maxReviewRounds: 1 } });
    await assert.rejects(h.side.reReview(h.side.state.runs[0]), /it has had 1 reviews, the round cap \(Max review rounds\)/);
    h = reviewerOver({ open: [prOf(1), prOf(2)], tickets: [], runs: [past(), { id: 'now', ticket: 'AB#42', status: 'running', prs: [], pid: null }] });
    await assert.rejects(h.side.reReview(h.side.state.runs[0]), /AB#42 is being reviewed already/);
    // The TUI: v asks first; no starts nothing; a wait row or a row of the old fix feature takes no v.
    const done = past({ contextPrs: [prOf(3)] });
    const fix = { id: 'f1', kind: 'Fix my PRs', ticket: 'PROJ-1', title: 'Old fix', pr: prOf(5), status: 'stopped', endedAt: 4, replies: [] };
    const t = tuiOver({ reviewer: { finished: () => [done], state: { runs: [done], fixes: [fix] }, waits: () => [{ key: 'QUICK#9', title: 'w', since: 1 }] } });
    t.tui.key('2');
    assert.ok(t.text().includes('AB#42'));
    t.tui.key('v');
    assert.ok(t.text(160).includes('Review AB#42 again? A quick review of the same 3 PRs starts under AB#42; no tags change.'));
    t.tui.key('n');
    assert.deepEqual(t.calls, [], 'no starts nothing');
    t.tui.key('v');
    t.tui.key('y');
    assert.deepEqual(t.calls.map(c => [c[0], c[1].id]), [['reReview', 'AB42-r1']]);
    t.tui.key('down');
    t.tui.key('v');
    t.tui.key('y');
    assert.equal(t.calls.length, 1, 'a row of the old fix feature takes no v');
    t.tui.key('1');
    t.tui.key('v');
    t.tui.key('y');
    assert.equal(t.calls.length, 1, 'nor does a wait row in Running');
  }

  // ---- C-40: the Builder doesn't take a fork's same-named branch PR as its own ----
  {
    const fork = { number: 9, html_url: 'https://github.com/acme/widgets/pull/9', head: { repo: { full_name: 'acme/widgets-fork' } } };
    const own = { number: 4, html_url: 'https://github.com/acme/widgets/pull/4', head: { repo: { full_name: 'Acme/Widgets' } } };
    const gone = { number: 5, html_url: 'https://github.com/acme/widgets/pull/5', head: { repo: null } };
    assert.deepEqual(fromOwnBranch([fork, own, gone], 'acme/widgets').map(p => p.number), [4]);
    const asked = [];
    const exec = list => async (cmd, args) => { asked.push(args[1]); return list.map(p => JSON.stringify(p)).join('\n'); };
    assert.equal(await prForBranch('acme/widgets', 'prowl/123-x', exec([fork])), null, "only the fork's PR: none of its own");
    assert.deepEqual(await prForBranch('acme/widgets', 'prowl/123-x', exec([fork, own])), { url: own.html_url, number: 4 });
    assert.deepEqual([await branchHadPr('acme/widgets', 'prowl/123-x', exec([fork, gone])), await branchHadPr('acme/widgets', 'prowl/123-x', exec([own]))], [false, true]);
    assert.ok(asked[0] === 'repos/acme/widgets/pulls?state=open&head=acme:prowl%2F123-x' && asked.at(-1).includes('state=all'));
  }

  // ---- C-14: GitHub labels with their own prowl: names, and each PR's outcome ----
  {
    const cfg = loadConfig();
    assert.ok(sameLabel('Prowl: Review ', 'prowl: review') && !sameLabel('prowl-review', 'prowl: review'));
    assert.deepEqual([cfg.reviewLabel, cfg.labels], ['prowl: review', { inReview: 'prowl: in review', approved: 'prowl: approved', changes: 'prowl: changes requested', building: 'prowl: building' }]);
    assert.equal(labelNames({ ...cfg, labels: { ...cfg.labels, approved: '' } }).approved, 'prowl: approved', 'a labels.* value left empty takes its default');
    assert.equal(askLabel({ ...cfg, reviewLabel: '' }), cfg.tags.trigger, 'an empty review label: the trigger tag\'s name');
    assert.deepEqual(['prowl: review', 'Prowl: In Review', 'prowl-review', 'prowl in review', 'Ready for Reveiw', 'In-Review', 'Reviewed', 'In Development', 'Approved', 'prowl: approved', 'prowl: changes requested', 'prowl: building'].map(l => labelRole(cfg, l)),
      ['ask', 'inReview', '', '', 'ask', 'inReview', 'done', 'building', '', 'approved', 'changes', 'building'], "today's five exactly; the old names as they were; a team's own label is nobody's");
    // The queue: exact for Prowl's own, the old names as before.
    const on = { 1: ['In Review', 'Ready for Review', 'bug'], 2: ['prowl-review', 'Approved'], 3: [] };
    const created = [];
    const ghLabels = { prLabels: async pr => [...on[pr.number]], addLabel: async (pr, name, color) => { created.push([name, color]); on[pr.number].push(name); },
      removeLabel: async (pr, name) => { on[pr.number] = on[pr.number].filter(l => l !== name); } };
    const file = path.join(tmp, 'labels-c14.json');
    const pr = n => ({ url: `https://github.com/o/r/pull/${n}`, repo: 'o/r', number: n });
    let q = createLabels({ gh: ghLabels, log() {}, file });
    const start = labelWrite(cfg, 'prowl: in review', ['ask', 'approved', 'changes'], ['ask', 'inReview', 'done']);
    q.set('reviewer', 'r1', pr(1), start);
    q.set('reviewer', 'r1', pr(2), start);
    await q.drain();
    assert.deepEqual([on[1], on[2]], [['bug', 'prowl: in review'], ['prowl-review', 'Approved', 'prowl: in review']], 'a start write leaves exactly the in-review label; prowl-review and a team\'s Approved stay');
    assert.deepEqual(created[0], ['prowl: in review', 'fbca04'], 'created in its own colour');
    // A write queued under an old name lands under the new one.
    fs.writeFileSync(file, JSON.stringify({ ops: [{ side: 'reviewer', owner: 'old', url: pr(3).url, repo: 'o/r', number: 3, add: 'In Review', remove: ['Ready for Review', 'Reviewed'], typos: 2, loose: ['Ready for Review'], at: 1 },
      { side: 'reviewer', owner: 'old', url: pr(3).url, repo: 'o/r', number: 3, add: 'Reviewed', remove: ['In Review', 'Ready for Review'], typos: 2, loose: ['Ready for Review'], at: 2 }] }));
    q = createLabels({ gh: ghLabels, log() {}, file });
    q.rename(op => renamedWrite(cfg, op, 'prowl: approved'));
    assert.deepEqual(q.state().ops.map(o => o.add), ['prowl: in review', 'prowl: approved']);
    await q.drain();
    assert.deepEqual(on[3], ['prowl: approved'], 'the old in-progress name lands as the in-review label, the old done name as the outcome');
    assert.equal(renamedWrite(cfg, { exact: [] }), null, "a write in today's form is left");
    // The Reviewer: a quick review of two PRs, one approved in the report.
    const prLabels = { 1: [], 2: [] };
    const fakeGh = { prLabels: async p => [...prLabels[p.number]], addLabel: async (p, name) => { prLabels[p.number].push(name); }, removeLabel: async (p, name) => { prLabels[p.number] = prLabels[p.number].filter(l => l !== name); } };
    const queue = createLabels({ gh: fakeGh, log() {}, file: path.join(tmp, 'labels-c14b.json') });
    const two = [prOf(1), prOf(2)];
    const h = reviewerOver({ open: two, tickets: [], cfgOver: { quickName: 'number', maxConcurrentReviews: 5 }, deps: { labels: queue }, ghOver: { prByRef: async ref => ({ ...two[ref.number - 1], labels: [...prLabels[ref.number]] }) } });
    let run = await h.side.quickReview('octo-org/r1#1 octo-org/r2#2');
    await queue.drain();
    assert.deepEqual([prLabels[1], prLabels[2]], [['prowl: in review'], ['prowl: in review']]);
    prLabels[2].push('prowl: review'); // asked for again while the review runs
    const done = async r => {
      fs.writeFileSync(r.reportPath, `---\nverdict: REQUEST CHANGES\napproved: ${two[0].url}@sha1\n---\n`);
      r._result = { subtype: 'success', is_error: false };
      await h.side.finish(r);
      await queue.drain();
    };
    await done(run);
    assert.deepEqual([prLabels[1], prLabels[2]], [['prowl: approved'], ['prowl: review', 'prowl: changes requested']], 'each PR labelled with how it went; a review label put on meanwhile is still on');
    assert.equal(h.side.waits().length, 1, 'a wait exists on the second');
    await h.side.poll();
    assert.equal(h.side.state.runs.filter(r => r.status === 'running').length, 1, 'and the next poll re-reviews');
    run = h.side.state.runs.find(r => r.status === 'running');
    await queue.drain();
    assert.deepEqual(prLabels[2], ['prowl: in review'], 'the re-review uses the ask up');
    await done(run);
    for (const [label, starts] of [['prowl: in review', false], ['prowl-review', false], ['Ready for Review', true]]) {
      prLabels[2] = ['prowl: changes requested', label];
      const before = h.side.state.runs.length;
      await h.side.poll();
      assert.equal(h.side.state.runs.length > before, starts, `labelled '${label}': ${starts ? 'the re-review starts' : 'no re-review'}`);
    }
  }

  // ---- C-16: the Reviewer's done tag says how the review went ----
  {
    const tags = reviewTags(loadConfig());
    const [a, b] = [prOf(1), prOf(2)];
    assert.deepEqual([tags.approved, tags.changes], ['prowl: approved', 'prowl: changes requested']);
    assert.equal(outcomeTag({ prs: [a, b], approved: { [a.url]: 'x', [b.url]: 'y' } }, tags), 'prowl: approved');
    assert.equal(outcomeTag({ prs: [a, b], approved: { [a.url]: 'x' } }, tags), 'prowl: changes requested', 'one PR not approved');
    assert.equal(outcomeTag({ prs: [], approved: {} }, tags), 'prowl: changes requested', 'no PRs');
    assert.deepEqual([true, false].map(all => outcomeTag({ prs: [a], approved: all ? { [a.url]: 'x' } : {} }, { approved: 'QA Done', changes: 'QA Done' })), ['QA Done', 'QA Done']);
    const split = saved => { splitDone(saved); return saved.tags; };
    assert.deepEqual(split({ tags: { done: 'Reviewed' } }), {}, "still Reviewed: dropped, so the defaults apply");
    assert.deepEqual(split({ tags: { done: 'QA Done' } }), { approved: 'QA Done', changes: 'QA Done' }, 'renamed: kept for both outcomes');
    assert.deepEqual(split({ tags: { done: 'QA Done', approved: 'Good' } }), { approved: 'Good', changes: 'QA Done' });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ tags: { done: 'QA Done' } }));
    assert.deepEqual([loadConfig().tags.approved, loadConfig().tags.changes, 'done' in loadConfig().tags, /"done"/.test(fs.readFileSync(CONFIG_PATH, 'utf8'))], ['QA Done', 'QA Done', false, false], 'a saved config moves once, and is written back');
    restoreConfig();
    assert.deepEqual(['prowl: approved', 'prowl: changes requested'].map(jiraLabel), ['prowl-approved', 'prowl-changes-requested'], 'the Jira form');
    // The Reviewer: the tag written says how the review went; Reviewed is still taken off, and never written.
    for (const [approves, tag] of [[2, 'prowl: approved'], [1, 'prowl: changes requested']]) {
      const h = reviewerOver({ open: [a, b] });
      let dropped = null;
      h.tracker.claim = async (c, t, drop, add) => { dropped = ['Reviewed', 'prowl: approved', 'prowl: changes requested', 'backend'].filter(drop); h.seen.claims.push(add); };
      await h.side.poll();
      assert.deepEqual(dropped, ['Reviewed', 'prowl: approved', 'prowl: changes requested'], 'a claim takes the outcome tags and Reviewed off');
      const run = h.side.state.runs[0];
      fs.writeFileSync(run.reportPath, `---\nverdict: X\napproved: ${[a, b].slice(0, approves).map(p => `${p.url}@s`).join(' ')}\n---\n`);
      run._result = { subtype: 'success', is_error: false };
      await h.side.finish(run);
      assert.deepEqual(h.seen.retags, [tag], `${approves} of 2 approved: ${tag}`);
    }
    // A write left pending under Reviewed by a Prowl from before the update: its outcome tag.
    const h = reviewerOver({ open: [], tickets: [] });
    h.side.state.runs.push({ id: 'old', tracker: 'ado', ref: { id: 1 }, ticket: 'AB#1', status: 'done', endedAt: 1, prs: [a], approved: { [a.url]: 's' }, pendingTag: 'Reviewed' });
    h.side.tick();
    await sleep(5);
    assert.deepEqual(h.seen.retags, ['prowl: approved']);
    // The Builder's start tag is never one of the Reviewer's outcome tags, however close it is named.
    const base = loadConfig();
    const near = builderTags({ ...base, tags: { ...base.tags, changes: 'Ready to Starts' } });
    assert.ok(!near.isStart('Ready to Starts') && near.isStart('Ready to Start') && !builderTags(base).isStart('Reviewed') && !builderTags(base).ours('prowl: changes requested'), "refused as the start tag, and not the Builder's to remove");
  }

  // ---- C-15: tags carry the labels' names ----
  {
    assert.deepEqual(['prowl: in review', 'prowl: changes requested', 'In Review', 'QA: done'].map(jiraLabel), ['prowl-in-review', 'prowl-changes-requested', 'In-Review', 'QA-done']);
    const cfg = loadConfig();
    assert.deepEqual([cfg.tags, cfg.builder.tags, cfg.namesVersion], [{ trigger: 'prowl: review', inProgress: 'prowl: in review', approved: 'prowl: approved', changes: 'prowl: changes requested' }, { start: 'prowl: build', inProgress: 'prowl: building' }, 2]);
    assert.deepEqual([cfg.tags.trigger, cfg.tags.inProgress, cfg.tags.approved, cfg.tags.changes, cfg.builder.tags.inProgress], [cfg.reviewLabel, cfg.labels.inReview, cfg.labels.approved, cfg.labels.changes, cfg.labels.building], 'the same strings as the labels');
    // The move of a saved config.
    let saved = { tags: { trigger: 'Ready for Review', inProgress: 'in-review', done: 'Reviewed' } };
    let notes = migrateNames(saved);
    assert.deepEqual([saved, notes.length], [{ tags: {}, namesVersion: 2 }, 3], 'tags still at their old defaults are dropped, so the new ones apply');
    assert.ok(notes.includes("Reviewer's tag 'Ready for Review' is now 'prowl: review'") && notes.includes("Reviewer's tag 'Reviewed' is now 'prowl: approved' or 'prowl: changes requested'"));
    assert.deepEqual(migrateNames(saved), [], 'run twice: nothing more');
    saved = { tags: { trigger: 'Review me' } };
    assert.deepEqual([migrateNames(saved), saved.tags], [[], { trigger: 'Review me' }], 'a renamed tag stays as named');
    saved = { tags: { done: 'QA Done' } };
    migrateNames(saved);
    assert.deepEqual(saved.tags, { approved: 'QA Done', changes: 'QA Done' }, 'a renamed done tag is kept for both outcomes');
    saved = { tags: { inProgress: 'Prowl Review' }, builder: { tags: { start: 'Ready to Start' } } };
    notes = migrateNames(saved);
    assert.deepEqual([saved.tags, saved.tagsWere, saved.builder.tags], [{}, { reviewer: { inProgress: 'Prowl Review' } }, {}], 'a clash with another tag of its side: reset, and recorded');
    assert.ok(notes.includes("Reviewer's tag 'Prowl Review' read the same as another of its tags, so it is now 'prowl: in review'") && notes.includes("Builder's tag 'Ready to Start' is now 'prowl: build'"));
    assert.deepEqual(migrateNames({}), [], 'no saved tags: no notes');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ tags: { trigger: 'Ready for Review', inProgress: 'In Review', done: 'Reviewed' }, builder: { tags: { start: 'Ready to Start', inProgress: 'Dev' } } }));
    const moved = loadConfig();
    assert.deepEqual([moved.tags.trigger, moved.builder.tags, moved.namesVersion], ['prowl: review', { start: 'prowl: build', inProgress: 'Dev' }, 2]);
    const lines = takeNameNotes();
    assert.ok(lines[0] === 'config.json moved to the new tag names:' && lines.length === 5 && !takeNameNotes().length, 'the Log lines, once');
    loadConfig();
    assert.deepEqual(takeNameNotes(), [], 'the file was written back: not moved again');
    restoreConfig();
    // The matchers, with the defaults.
    const { role, has } = tagReader(cfg);
    const isTrigger = t => role(t) === 'reviewer.trigger';
    assert.deepEqual(['prowl: review', 'Prowl-Review', 'prowl: reveiw', 'Ready for Review', 'prowl: in review', 'In Review', 'prowl: approved', 'Reviewed', 'prowl: build'].map(isTrigger), [true, true, true, true, false, false, false, false, false]);
    const { isStart, ours, mine } = builderTags(cfg);
    assert.deepEqual(['prowl: build', 'Ready to Start', 'prowl: building', 'In Development', 'prowl: review'].map(isStart), [true, true, false, false, false]);
    assert.ok(ours('In Review') && ours('prowl-in-review') && mine('In Development') && has(['web', 'In-Review'], cfg.tags.inProgress) && has(['Ready for Review'], cfg.tags.trigger) && !has(['Reviewed'], cfg.tags.trigger));
    assert.deepEqual([wasRole({ inProgress: 'Prowl Review' }, cfg.tags, 'prowl review'), wasRole({ inProgress: 'Prowl Review' }, cfg.tags, 'prowl: review')], ['inProgress', '']);
    const withWere = tagReader({ ...cfg, tagsWere: { reviewer: { inProgress: 'Prowl Review' } } });
    assert.deepEqual([withWere.role('Prowl Review'), withWere.role('prowl: review')], ['reviewer.inProgress', 'reviewer.trigger'], 'a reset name is a review running; the trigger spelled as today is a request for one');
    assert.deepEqual(['In Review', 'Reviewed', 'In Development', 'Ready for Review', 'prowl: in review', '', 'Other'].map(t => pendingTag(cfg, t, 'prowl: approved')),
      ['prowl: in review', 'prowl: approved', 'prowl: building', 'prowl: review', 'prowl: in review', '', 'Other'], 'a pending tag write goes under today\'s name for its role');
    // The Reviewer: a ticket tagged the old way is claimed under the new name, the old one taken off; one in review the old way isn't.
    let h = reviewerOver({ open: [prOf(1)] });
    h.ticket.tags = ['Ready for Review', 'backend'];
    let claim = null;
    h.tracker.claim = async (c, t, drop, add) => { claim = { off: ['Ready for Review', 'Ready-for-Review', 'In Review', 'Reviewed', 'backend'].filter(drop), add }; };
    await h.side.poll();
    assert.deepEqual(claim, { off: ['Ready for Review', 'Ready-for-Review', 'In Review', 'Reviewed'], add: 'prowl: in review' });
    assert.equal(jiraLabel(claim.add), 'prowl-in-review', 'on Jira the label is written prowl-in-review');
    h = reviewerOver({ open: [prOf(1)] });
    h.ticket.tags = ['prowl: review', 'In Review'];
    await h.side.poll();
    assert.ok(!h.seen.claims.length && h.seen.logs.some(l => l.includes("while it is 'In Review'")), 'carrying the old in-progress tag: under a review, not claimed');
    // Config: no two tags of one side may read the same; on Jira a tag row shows the form it is written in.
    const t = tuiOver({ cfgOver: { taskBoard: 'jira' } });
    t.tui.key('4');
    let frame = '';
    for (let i = 0; i < 60 && !frame.includes('(written prowl-in-review)'); i++) { t.tui.key('down'); frame = t.text(120, 40); }
    assert.ok(frame.includes('(written prowl-in-review)'), 'the Jira form beside the saved name');
  }

  // ---- C-21: a quick build reads the state of its work before it starts ----
  {
    const d = (state, mine, followUp, instructions, canAsk, extra = {}) => gateDecision({ state, mine, followUp, instructions, canAsk, ...extra }).act;
    // Every row of the table: [state, mine, follow, instructions] -> in the TUI, with --once.
    for (const [state, mine, follow, ins, tui, once] of [
      ['', 1, true, false, 'build', 'build'], ['building', 1, true, false, 'refuse', 'refuse'],
      ['running', 1, true, false, 'follow', 'follow'], ['running', 1, true, true, 'ask', 'refuse'], ['running', 0, true, false, 'refuse', 'refuse'], ['running', 0, true, true, 'refuse', 'refuse'],
      ['running', 1, false, true, 'ask', 'refuse'], ['running', 1, false, false, 'refuse', 'refuse'],
      ['pending', 1, true, false, 'ask', 'follow'], ['pending', 1, true, true, 'ask', 'refuse'], ['pending', 0, true, false, 'ask', 'refuse'], ['pending', 1, false, false, 'ask', 'refuse']]) {
      assert.deepEqual([d(state, mine, follow, ins, true), d(state, mine, follow, ins, false)], [tui, once], `gate: ${state || 'none'}, mine ${mine}, follow ${follow}, instructions ${ins}`);
    }
    assert.equal(d('pending', 1, true, false, true, { answer: 'now', asked: 'pending' }), 'build', 'build now, asked about the pending review that is still pending');
    assert.equal(d('running', 1, true, false, true, { answer: 'now', asked: 'pending' }), 'ask', 'the review has started since: asked again');
    assert.equal(d('running', 1, false, false, true, { answer: 'now', asked: 'pending' }), 'refuse');
    assert.equal(d('running', 0, true, false, true, { answer: 'now', asked: 'pending' }), 'refuse');
    assert.equal(d('', 1, true, false, true, { answer: 'wait' }), 'build', 'the review ended meanwhile: the build starts');
    const again = gateDecision({ state: 'pending', mine: 0, followUp: true, instructions: false, canAsk: true, answer: 'wait' });
    assert.deepEqual([again.act, again.can], ['ask', false], 'wait, with no PR of yours left: asked again, with one option');
    assert.equal(d('pending', 1, true, false, true, { answer: 'now' }), 'build', 'no recorded state counts as asked about pending');
    const cfg = loadConfig();
    const st = x => workState(x, cfg)?.state || 'none';
    assert.deepEqual([st(['backend', 'prowl: in review']), st(['In Review']), st(['prowl-in-review']), st(['prowl: review']), st(['Ready for Review']), st(['prowl: approved', 'prowl: changes requested', 'Reviewed']), st(['prowl: building', 'prowl: review'])],
      ['running', 'running', 'running', 'pending', 'pending', 'none', 'building']);
    assert.equal(workState(['web', 'In Review'], cfg).why, "it carries 'In Review': a review is running", 'the tag as it is on the ticket');
    const rows = (...labels) => [{ name: 'acme/web#90', labels }];
    assert.deepEqual([st(rows('prowl: review', 'In Review')), st(rows('prowl-review', 'prowl in review', 'prowl: approved', 'prowl: changes requested')), st(rows('prowl: building'))], ['running', 'none', 'building'], 'labels are matched exactly; running wins');
    assert.equal(workState([{ name: 'acme/web#90', labels: ['prowl: review'] }, { name: 'acme/api#4', labels: ['prowl: review'] }], cfg).why, "acme/web#90, acme/api#4 are labelled 'prowl: review': a review is pending");
    // Needs you: a gate question takes only its options; s cancels the build, and there is nothing to hand back.
    const gateItem = { id: 'g1', recordId: 'u1', ticket: 'AB#123', kind: 'question', question: 'A review is pending. Wait for it, or build now?', context: [], options: ['Wait for the review, then address its feedback', 'Build now: the review request comes off the ticket until the build hands them on again'],
      recommended: 'Wait for the review, then address its feedback', createdAt: 1, gate: { wait: 'Wait for the review, then address its feedback', now: 'Build now: the review request comes off the ticket until the build hands them on again', state: 'pending' } };
    const t = tuiOver({ builder: { needs: () => [gateItem], history: () => [{ uid: 'u1', key: 'AB#123', title: 'T', status: 'needs-you', sessionStarted: true }] }, cfgOver: { builder: { ...cfg.builder, enabled: true } } });
    t.tui.key('B');
    t.tui.key('3');
    const frame = t.text(140, 30);
    assert.ok(frame.includes('Wait for the review, then address its feedback') && frame.includes('Recommended') && !frame.includes('Your answer') && !frame.includes('Ask about this'), 'only its options are answers');
    t.tui.key('s');
    assert.ok(t.text(140, 30).includes('Cancel the quick build of AB#123?'));
    t.tui.key('y');
    assert.deepEqual(t.calls.map(c => c[0]), ['skip']);
    t.tui.key('enter');
    assert.deepEqual(t.calls.at(-1).slice(0, 1).concat(t.calls.at(-1)[2]), ['answer', 'Wait for the review, then address its feedback'], 'enter submits the recommended option');
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

  // ---- C-32: Prowl sets a review up before its session starts ----
  {
    const prepOf = (run, over = {}) => ({ dir: path.join(tmp, `${run.id}.prep`), comments: { unread: [], index: {} },
      prs: run.prs.map(p => ({ url: p.url, repo: p.repo, number: p.number, role: 'review', head: 'sha1', worktree: '/wt', error: '', viewError: '', ...over })) });
    const prepped = ({ prepare, cfgOver = {}, deps = {}, trackerOver = {}, ...rest } = {}) => {
      const [order, removed] = [[], []];
      const h = reviewerOver({ open: [prOf(1)], ...rest, cfgOver: { reviewPrep: true, ...cfgOver },
        trackerOver: { claim: async (c, t, drop, add) => { order.push('claim'); h.seen.claims.push(add); }, ...trackerOver },
        deps: { prepareReview: async (c, dir, run, opts) => { order.push('prepare'); opts.progress('Fetching octo-org/r1#1 and main'); return prepare ? prepare(run, h, opts) : prepOf(run); },
          removePrep: async prep => { if (!prep || prep.dropped) return; prep.dropped = true; removed.push(prep.dir); }, sweepWorktrees: async () => [], ...deps } });
      const { createReview: create, launchReview: launch } = h.side;
      h.side.createReview = (...a) => { order.push('create'); return create(...a); };
      h.side.launchReview = (...a) => { order.push('launch'); return launch(...a); };
      return { ...h, order, removed };
    };
    // Created, prepared, claimed, launched, in that order.
    let h = prepped();
    await h.side.poll();
    let run = h.side.state.runs[0];
    assert.deepEqual(h.order, ['create', 'prepare', 'claim', 'launch']);
    assert.deepEqual([h.seen.started[0].prepping, Boolean(run.prep), typeof run.setupMs, run._activity[0].text, h.side.preparing().length], [true, true, 'number', 'Fetching octo-org/r1#1 and main', 0],
      "its setup's steps stay at the top of its Activity");
    // Its session ending removes the worktrees, once.
    await h.side.finish(run);
    await h.side.finish(run).catch(() => {});
    assert.equal(h.removed.length, 1, 'removed once, however often it is settled');

    // A gap is a Log warning, and a head force-pushed away is followed.
    h = prepped({ prepare: r => prepOf(r, { worktree: '', error: 'no clone', viewError: 'HTTP 502', replaced: 'sha1', head: 'newhead' }) });
    await h.side.poll();
    run = h.side.state.runs[0];
    assert.ok(h.seen.logs.includes('AB#42: no worktree for octo-org/r1#1 (no clone); the session reads it from GitHub') && h.seen.logs.includes("AB#42: couldn't read octo-org/r1#1 on GitHub (HTTP 502); the session reads its facts itself"), h.seen.logs.join('\n'));
    assert.equal(run.reviewedHeads[prOf(1).url], 'newhead', 'the new head is the one reviewed');
    h = prepped({ prepare: r => ({ ...prepOf(r), comments: { unread: [prOf(1).url], index: {} } }) });
    await h.side.poll();
    assert.ok(h.seen.logs.includes(`AB#42: couldn't read the comments on ${prOf(1).url}; the session fetches them itself`));

    // Switched off during the setup: no claim, no session, worktrees removed, the ticket still tagged.
    h = prepped({ prepare: (r, hh) => { hh.app.on = false; return prepOf(r); } });
    await h.side.poll();
    assert.deepEqual([h.order, h.seen.claims, h.seen.retags, h.removed.length, h.side.state.runs.length, h.side.preparing().length], [['create', 'prepare'], [], [], 1, 0, 0]);

    // s during the setup: no claim, the trigger tag removed, the Log line.
    let stand;
    const stopping = (r, hh) => {
      [stand] = hh.side.preparing();
      assert.deepEqual([stand.status, stand.id, stand.prs.length, stand._activity[0].text], ['preparing', 'preparing:AB#42', 1, 'Fetching octo-org/r1#1 and main']);
      assert.equal(hh.side.stopText(stand), "Stop the review of AB#42 while it is being set up? Its setup ends first (a clone or a fetch can't be interrupted), then no session starts. Its 'prowl: review' tag is removed; re-tag to run it again.");
      hh.side.stop(stand);
      hh.side.stop(stand);
      return prepOf(r);
    };
    h = prepped({ prepare: stopping });
    await h.side.poll();
    assert.deepEqual([h.order, h.seen.claims, h.seen.retags, h.removed.length, h.side.state.runs.length], [['create', 'prepare'], [], [''], 1, 0]);
    for (const line of ['AB#42: stopping the review once its setup ends; no session will start', 'AB#42: already stopping, once its setup ends', "AB#42: review stopped during its setup. Re-tag 'prowl: review' to run it again."]) assert.ok(h.seen.logs.includes(line), `${line}\n${h.seen.logs.join('\n')}`);
    h = prepped({ prepare: stopping, trackerOver: { retag: async () => { throw new Error('HTTP 500'); } } });
    await h.side.poll();
    assert.ok(h.seen.logs.includes("AB#42: review stopped during its setup, but taking 'prowl: review' off failed (HTTP 500); remove it by hand, or the next poll starts it again"));

    // s confirmed after the launch stops the running review; after it ended, nothing is stopped.
    h = prepped({ prepare: (r, hh) => { [stand] = hh.side.preparing(); return prepOf(r); } });
    await h.side.poll();
    run = h.side.state.runs[0];
    h.side.stop(stand);
    assert.notEqual(run.status, 'running', 'the running review is the one stopped');
    h.side.state.runs = [];
    h.side.stop(stand);
    assert.ok(h.seen.logs.includes('AB#42: not stopped: it had already ended'));

    // The claim lost after the setup: the worktrees go, no session.
    h = prepped({ trackerOver: { claim: async () => { throw Object.assign(new Error('rev moved'), { lost: true }); } } });
    await h.side.poll();
    assert.deepEqual([h.order, h.removed.length, h.side.state.runs.length, h.side.preparing().length], [['create', 'prepare'], 1, 0, 0]);
    assert.ok(h.seen.logs.some(l => l.startsWith('AB#42: not claimed (changed or claimed by someone else)')));

    // A setup past its limit: the session sets itself up, and what the setup makes later is removed.
    h = prepped({ deps: { prepLimitMs: 20 }, prepare: async r => { await sleep(120); return prepOf(r); } });
    await h.side.poll();
    run = h.side.state.runs[0];
    assert.deepEqual([h.order, run.prep, h.removed.length], [['create', 'prepare', 'claim', 'launch'], undefined, 0]);
    assert.ok(h.seen.logs.includes("AB#42: couldn't prepare its PRs (it took over 10 minutes); the review session sets itself up"));
    await sleep(200);
    assert.equal(h.removed.length, 1, 'whatever the abandoned setup checked out is removed when it finishes');

    // Turned off: launched as before. A dry run prepares nothing.
    h = prepped({ cfgOver: { reviewPrep: false } });
    await h.side.poll();
    assert.deepEqual([h.order, h.seen.started[0].prepping, h.side.state.runs.length], [['claim'], undefined, 1]);
    h = prepped({ dry: true });
    await h.side.poll();
    assert.deepEqual([h.order, h.side.state.runs.length], [[], 0]);

    // A quick review stopped during its setup: nothing reviewed, no label touched.
    h = prepped({ tickets: [], cfgOver: { quickLabels: true }, prepare: (r, hh) => { [stand] = hh.side.preparing(); assert.ok(stand.quick && hh.side.stopText(stand).startsWith(`Stop the quick review ${stand.ticket} while it is being set up?`)); hh.side.stop(stand); return prepOf(r); } });
    const refused = await h.side.quickReview(prOf(1).url).then(() => null, e => e);
    assert.ok(refused?.lasting && h.seen.logs.includes(`${stand.ticket}: review stopped during its setup; nothing was reviewed`) && h.removed.length === 1 && !h.labelCalls.length && !h.side.state.runs.length, `${refused?.message}\n${h.seen.logs.join('\n')}`);
    h = prepped({ tickets: [] });
    run = await h.side.quickReview(prOf(1).url);
    assert.deepEqual([h.order, Boolean(run.prep), h.side.preparing().length], [['create', 'prepare', 'launch'], true, 0]);

    // The prompt's slot: after the context list, before the ticket; gone when nothing was prepared.
    const first = promptCases.first;
    const slotted = buildPrompt({ ...first, prepping: true, ticketText: 'The ticket.' });
    assert.ok(slotted.includes(`\n\n${PREP_SLOT}\n\n`) && slotted.indexOf(PREP_SLOT) < slotted.indexOf('The ticket.') && !buildPrompt(first).includes(PREP_SLOT));
    assert.equal(fillPrep(slotted, null), buildPrompt({ ...first, ticketText: 'The ticket.' }), 'nothing prepared: the prompt is as without the setup');
    const re = promptCases.reReview;
    const [u1, u2] = re.prs.map(x => x.url);
    const delta = { ...re, prior: { ...re.prior, reviewedHeads: { [u1]: 'a', [u2]: 'b' } }, reReviewScope: 'delta', heads: { [u1]: 'a', [u2]: 'c' } };
    assert.ok(buildPrompt({ ...delta, prepping: true }).includes("For each PR whose line under *Prepared by Prowl* has *Since the previous review*") && !buildPrompt(delta).includes('*Since the previous review*'));
    assert.deepEqual(reviewArgs({ claude: { model: 'm', effort: '', permissionMode: 'auto', maxBudgetUsd: 0, maxTurns: 0 } }, '/plugin', null, ['/prep']).filter((a, i, all) => all[i - 1] === '--add-dir').at(-1), '/prep');
    assert.equal(loadConfig().reviewPrep, true);

    // Running: a row for a review being set up, s on it, and quitting.
    const standIn = { id: 'preparing:AB#42', ticket: 'AB#42', title: 'Thing', prs: [prOf(1), prOf(2)], status: 'preparing', startedAt: Date.now() - 65_000, _activity: [{ text: 'Fetching octo-org/r1#1 and main' }] };
    const t = tuiOver({ reviewer: { preparing: () => [standIn], stopText: () => 'Stop the review of AB#42 while it is being set up?' } });
    assert.ok(/AB#42\s+Thing\s+2 PRs · preparing · 1m/.test(t.text(120)) && t.text(120).includes('Fetching octo-org/r1#1 and main'), t.text(120));
    assert.ok(tuiOver({ reviewer: { preparing: () => [{ ...standIn, quick: true }] } }).text(120).includes('2 PRs · preparing · quick · '));
    t.tui.key('s');
    assert.ok(t.text(120).includes('Stop the review of AB#42 while it is being set up?'));
    t.tui.key('y');
    assert.deepEqual(t.calls.find(c => c[0] === 'stop')?.slice(1), ['reviewer', standIn]);
    t.tui.key('q');
    assert.ok(t.text(160, 40).replace(/\s+/g, ' ').includes('1 review being set up: quit now and no session starts for them; a tagged ticket stays tagged for the next launch. Press q again to quit.'), t.text(160, 40));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}
