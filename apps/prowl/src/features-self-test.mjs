// Part of node prowl.mjs --self-test: the checks for features added after 2.23.6, a section each.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, HOME, loadConfig, newSettings } from './config.mjs';
import { addWorktree, noHooks, noHooksEnv } from './git.mjs';
import { MODELS } from './config.mjs';
import { agentModel, buildPrompt, createReview, finalize, reviewArgs, reviewRoles, rolesWarning } from './reviewer/reviews.mjs';
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
