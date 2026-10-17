// node prowl.mjs --self-test: checks the logic that decides which tickets and PRs get touched.
import assert from 'node:assert/strict';
import { frontMatter, mentions, norm, swapTags, tagMatches } from './match.mjs';
import { adfText, claimEntry, label } from './jira.mjs';
import { htmlText } from './ado.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './config.mjs';
import { alive, awaitingHuman, buildPrompt, finalize, findingsOnly, isOwn, overdue, REPORTS_DIR, retryFailed, reviewArgs, reviewEnv, roundCapped, tidyLogs } from './reviews.mjs';
import { processStart } from './proc.mjs';
import { createMascot, wrap } from './mascot.mjs';
import { changelog, newer, syncConfigFiles } from './update.mjs';
import { DISALLOWED, fenceDecision, fenceSettings } from './fence.mjs';
import { checksState, detailsFromBodies, threadsFrom } from './github.mjs';

const T = 'Ready for Review';
for (const t of ['Ready for Review', 'ready for review', 'Ready-For-Review', 'READY  FOR REVIEW', 'ReadyForReview', 'Ready for Reveiw', 'Redy for Review', 'Ready fro Reviw']) {
  assert.ok(tagMatches(t, T, 2), `should match: ${t}`);
}
for (const t of ['Ready for QA', 'In Review', 'Reviewed', 'Not Ready for Review', 'Review', 'Ready']) {
  assert.ok(!tagMatches(t, T, 2), `should not match: ${t}`);
}
assert.ok(!tagMatches('Ready for Reveiw', T, 0), 'typo tolerance 0 is exact');
assert.ok(tagMatches('ready-for-review', T, 0), 'case and punctuation never count as typos');

const trigger = t => tagMatches(t, T, 2);
const ours = t => ['inreview', 'reviewed'].includes(norm(t));
assert.deepEqual(swapTags(['API', 'ready for reveiw', 'UI'], t => trigger(t) || ours(t), 'In Review'), ['API', 'UI', 'In Review'], 'claim');
assert.deepEqual(swapTags(['Reviewed', 'Ready for Review'], t => trigger(t) || ours(t), 'In Review'), ['In Review'], 'claim a re-review');
assert.deepEqual(swapTags(['In Review', 'Ready for Review'], ours, 'Reviewed'), ['Ready for Review', 'Reviewed'], 'finish keeps a mid-review re-request');
assert.deepEqual(swapTags(['In Review'], ours, ''), [], 'stop clears the tag');
assert.deepEqual(swapTags(['In-Review', 'backend'], ours, ''), ['backend'], 'Jira labels: dashes for spaces');
assert.equal(label(' In  Review '), 'In-Review');
assert.ok(trigger('Ready-for-Review') && trigger('ReadyForReview'), 'Jira-style trigger labels');

assert.ok(mentions('Fixes AB#123.', 'AB#123'));
assert.ok(mentions('ab#123', 'AB#123'));
assert.ok(!mentions('AB#1234', 'AB#123'));
assert.ok(!mentions(null, 'AB#123'));
assert.ok(mentions('PROJ-12: add things', 'PROJ-12') && mentions('[proj-12] x', 'PROJ-12'));
assert.ok(!mentions('PROJ-123', 'PROJ-12') && !mentions('XPROJ-12', 'PROJ-12'));

// Jira has no conditional update: the claim goes to whoever's write removed the trigger label (the later write
// changes nothing, so it leaves no changelog entry).
const entry = (who, from, to) => ({ author: { accountId: who }, items: [{ field: 'labels', fromString: from, toString: to }] });
const log = [entry('alice', '', 'Ready-for-Review'), entry('bob', 'Ready-for-Review', 'In-Review'), entry('carol', 'In-Review', 'In-Review backend')];
assert.equal(claimEntry(log, ['Ready-for-Review']).author.accountId, 'bob');
assert.equal(claimEntry([entry('alice', 'x', 'x y')], ['Ready-for-Review']), null);

assert.deepEqual(frontMatter('---\nverdict: REQUEST CHANGES\nhigh: 2\nfixed: "3"\n---\n# x'), { verdict: 'REQUEST CHANGES', high: 2, fixed: '3' });
assert.equal(frontMatter('# no front matter'), null);

assert.ok(newer('2.10.0', '2.9.9') && newer('3.0.0', '2.99.0') && newer('2.1.1', '2.1') && !newer('2.1.0', '2.1.0') && !newer('1.9.0', '2.0.0'));

const base = { ticket: 'AB#42', title: 'Thing', ticketUrl: 'https://dev.azure.com/o/p/_workitems/edit/42', reviewNo: 1, reportPath: '/r/AB42.md',
  prs: [{ url: 'https://github.com/o/a/pull/1' }, { url: 'https://github.com/o/b/pull/2' }] };
const first = buildPrompt(base);
assert.ok(first.startsWith('/prowl:prowl-review https://github.com/o/a/pull/1 https://github.com/o/b/pull/2\n'));
assert.ok(first.includes('/r/AB42.md') && first.includes('Ticket: AB#42 "Thing"') && first.includes('ticket: AB#42') && !first.includes('re-review'));
const again = buildPrompt({ ...base, reviewNo: 2, prior: { reviewNo: 1, endedAt: 0 }, priorReport: 'F-01 [HIGH] old finding' });
assert.ok(!first.includes('Approvals off') && buildPrompt({ ...base, approvals: false }).includes('Approvals off'));
const ctx = buildPrompt({ ...base, prs: base.prs.slice(1), contextPrs: base.prs.slice(0, 1) });
assert.ok(ctx.startsWith('/prowl:prowl-review https://github.com/o/b/pull/2 https://github.com/o/a/pull/1\n'), 'approved PRs go to the skill as context');
assert.ok(ctx.includes('## Already approved: context only\n\n') && ctx.includes('- https://github.com/o/a/pull/1') && !first.includes('Already approved'));
assert.ok(first.includes('approved: <each PR'));
assert.ok(again.includes('This is a re-review') && again.includes('F-01 [HIGH] old finding') && again.includes('What was fixed: every prior finding'));

// With every setting at its default, the prompt is byte for byte what 2.7.0 sent (fixtures captured from 2.7.0).
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'self-test-fixtures');
const fixture = name => fs.readFileSync(path.join(FIX, name), 'utf8');
const promptCases = JSON.parse(fixture('prompt-cases.json'));
for (const c of Object.values(promptCases)) if (c.priorReport) c.priorReport = fixture(c.priorReport);
for (const [name, c] of Object.entries(promptCases)) assert.equal(buildPrompt(c), fixture(`${name}.prompt.md`), `golden prompt: ${name}`);
// ...and the review session gets 2.7.0's arguments.
const claude = { model: 'm', effort: 'xhigh', permissionMode: 'auto', maxBudgetUsd: 0, maxTurns: 0 };
assert.deepEqual(reviewArgs({ claude }, '/plugin'), ['-p', '--plugin-dir', '/plugin', '--add-dir', REPORTS_DIR, '--add-dir', CONFIG_DIR,
  '--model', 'm', '--effort', 'xhigh', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose'], 'golden spawn arguments');

// Delta re-reviews: the commits since the last review, and only the last report's front matter and findings.
const priorRun = { ...promptCases.reReview.prior, reviewedHeads: { [base.prs[0].url]: 'aaa111', [base.prs[1].url]: 'bbb222' } };
const delta = buildPrompt({ ...promptCases.reReview, prior: priorRun, reReviewScope: 'delta',
  prs: [...base.prs, { url: 'https://github.com/o/d/pull/4' }], heads: { [base.prs[0].url]: 'aaa111', [base.prs[1].url]: 'ccc333' } });
assert.ok(delta.includes(`- ${base.prs[1].url}: bbb222..ccc333`), 'names the last reviewed commit and the head');
assert.ok(delta.includes(`- ${base.prs[0].url}: no new commits since aaa111`) && delta.includes('- https://github.com/o/d/pull/4: not reviewed at a known commit before; review it in full'));
assert.ok(delta.includes('gh pr diff <PR> --name-only'), 'base-branch merges: findings only in files the PR changes');
assert.ok(delta.includes('<previous-findings>\n---\nticket: AB#42') && delta.includes('F-02 [MEDIUM] Missing CI pipeline') && delta.includes('## Still open from the previous review'));
assert.ok(!delta.includes('<previous-report>') && !delta.includes('## Pull requests') && !delta.includes('Refuted: race on save') && !delta.includes('## Summary'), 'only the findings');
assert.equal(buildPrompt({ ...promptCases.reReview, reReviewScope: 'delta' }), fixture('reReview.prompt.md'), 'no reviewedHeads (a 2.7.0 review): full scope');
assert.equal(findingsOnly('no sections here'), 'no sections here');
assert.equal(findingsOnly('## Issues found\n```py\n# not a heading\n```\n### o/a#1\n- F-01\n## Not posted\n- x\n'), '## Issues found\n```py\n# not a heading\n```\n### o/a#1\n- F-01\n');

// Round cap: a ticket's next review would go past Max review rounds.
assert.ok(!roundCapped({ maxReviewRounds: 0 }, { reviewNo: 9 }), 'no cap');
assert.ok(!roundCapped({ maxReviewRounds: 3 }, undefined) && !roundCapped({ maxReviewRounds: 3 }, { reviewNo: 2 }), 'review 3 of 3 runs');
assert.ok(roundCapped({ maxReviewRounds: 3 }, { reviewNo: 3 }) && roundCapped({ maxReviewRounds: 1 }, { reviewNo: 1 }));

// Park human-only findings: the brief's extra step, only when on (and only on a re-review).
const parks = c => buildPrompt({ ...c, parkHumanOnly: true }).includes('Classify it Parked');
assert.ok(parks(promptCases.reReview) && parks({ ...promptCases.reReview, prior: priorRun, reReviewScope: 'delta' }) && !parks(promptCases.first));
assert.ok(buildPrompt({ ...promptCases.reReview, parkHumanOnly: true }).includes('\n5. Park a prior finding'), 'numbered after the four prior-finding steps');
assert.ok(!buildPrompt(promptCases.reReview).includes('Parked'), 'off by default');

// Memory: by default the session's environment is 2.7.0's; off sets Claude Code's switch for auto-memory.
assert.deepEqual(reviewEnv({ allowMemoryWrites: true }, { PATH: '/bin' }), { PATH: '/bin', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '3600000' }, 'golden environment');
assert.equal(reviewEnv({ allowMemoryWrites: false }, {}).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');

// Log retention: old review logs go, except a running review's; poller.log rolls over past 5 MB; reports stay.
const logHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-'));
const logDir = path.join(logHome, 'logs');
fs.mkdirSync(logDir);
fs.mkdirSync(path.join(logHome, 'reports'));
const old = (file, days = 40) => { fs.writeFileSync(file, 'x'); const t = new Date(Date.now() - days * 86_400_000); fs.utimesSync(file, t, t); };
for (const f of ['AB1-r1.ndjson', 'AB1-r1.prompt.md', 'AB2-r1.ndjson', 'AB2-r10.ndjson']) old(path.join(logDir, f));
old(path.join(logDir, 'AB3-r1.ndjson'), 2);
old(path.join(logHome, 'reports', 'AB1-r1.md'));
fs.writeFileSync(path.join(logHome, 'poller.log'), Buffer.alloc(5 * 1024 * 1024 + 1));
fs.writeFileSync(path.join(logHome, 'poller.log.1'), 'older');
assert.equal(tidyLogs(0, [], logHome), 0, 'off by default');
assert.equal(fs.readdirSync(logDir).length, 5);
assert.equal(tidyLogs(30, [{ id: 'AB2-r1' }], logHome), 3);
assert.deepEqual(fs.readdirSync(logDir).sort(), ['AB2-r1.ndjson', 'AB3-r1.ndjson'], "spares the running review's files and recent ones");
assert.ok(fs.existsSync(path.join(logHome, 'reports', 'AB1-r1.md')), 'reports are never pruned');
assert.ok(!fs.existsSync(path.join(logHome, 'poller.log')) && fs.statSync(path.join(logHome, 'poller.log.1')).size > 5 * 1024 * 1024, 'poller.log rolled over');
fs.rmSync(logHome, { recursive: true });

// Ticket text: a ## Ticket section after the context lines, only when there is some, trimmed to about 6 KB.
const withTicket = buildPrompt({ ...promptCases.approvalsOff, ticketText: 'Users can save.\n- Given a user' });
assert.ok(withTicket.includes('Approvals off') && withTicket.indexOf('## Ticket') > withTicket.indexOf('Approvals off'));
assert.ok(withTicket.includes('<ticket-text>\nUsers can save.\n- Given a user\n</ticket-text>') && !buildPrompt(promptCases.first).includes('## Ticket'));
const long = buildPrompt({ ...promptCases.first, ticketText: 'x'.repeat(9000) });
assert.ok(long.includes(`${'x'.repeat(6000)}\n(trimmed)\n</ticket-text>`) && !long.includes('x'.repeat(6001)));
assert.equal(htmlText('<div>Save &amp; load</div><ul><li>a&nbsp;b</li><li>&lt;c&gt; &#X2713; &#99999999;</li></ul><p>Done</p>'), 'Save & load\n\n- a b\n- <c> ✓ &#99999999;\nDone');
assert.equal(adfText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { text: '@Ann' } }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }] }).trim(), 'Hi @Ann\n\n- one');

// Run caps: passed only when set; a capped review fails with the cap named and isn't retried.
const capped = reviewArgs({ claude: { ...claude, maxBudgetUsd: 50, maxTurns: 200 } }, '/plugin');
assert.deepEqual(capped.slice(capped.indexOf('--max-budget-usd'), -3), ['--max-budget-usd', '50', '--max-turns', '200']);
const overBudget = { status: 'running', reportPath: '/nowhere.md', caps: { maxBudgetUsd: 50 }, _result: { subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 50.4 } };
finalize(overBudget);
assert.equal(overBudget.status, 'failed');
assert.equal(overBudget.error, 'stopped: spend cap $50');
assert.equal(retryFailed(overBudget, 1), false, 'a capped review is not retried');
assert.equal(retryFailed({ status: 'failed' }, 1), true, 'any other failure is retried once');
assert.equal(retryFailed({ status: 'failed' }, 2), false);
const overTime = { status: 'stopping', capped: 'time cap 90 min', reportPath: '/nowhere.md' };
finalize(overTime);
assert.equal(overTime.status, 'failed', 'stopped by the time limit, not by you');
assert.equal(overTime.error, 'stopped: time cap 90 min');
const byYou = { status: 'stopping', reportPath: '/nowhere.md' };
finalize(byYou);
assert.equal(byYou.status, 'stopped');
const longRun = { status: 'running', startedAt: Date.now() - 91 * 60_000 };
assert.ok(overdue(longRun, { reviewTimeoutMinutes: 90 }) && !overdue(longRun, { reviewTimeoutMinutes: 0 }) && !overdue(longRun, { reviewTimeoutMinutes: 120 }));
assert.ok(!overdue({ ...longRun, status: 'stopping' }, { reviewTimeoutMinutes: 90 }), 'already stopping');

// A session that ends cleanly but never wrote its report did not review anything: it must fail, not tag Reviewed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-'));
const clean = { subtype: 'success', is_error: false, result: 'Seven reviewers are running.' };
const lost = { status: 'running', reportPath: path.join(dir, 'missing.md'), _result: clean,
  _activity: [{ text: 'Background tasks still running 10m after the last turn (...); stopping them.', error: true }] };
finalize(lost);
assert.equal(lost.status, 'failed');
assert.match(lost.error, /without writing its report: Background tasks still running/);
const good = { status: 'running', reportPath: path.join(dir, 'AB42.md'), _result: clean };
fs.writeFileSync(good.reportPath, '---\nverdict: APPROVE\nhigh: 0\n---\n# Report\n');
finalize(good);
assert.equal(good.status, 'done');
assert.deepEqual(good.summary, { verdict: 'APPROVE', high: 0 });
// The PRs a review approved, and at which commit, are kept so the next re-review can leave them out.
const pa = 'https://github.com/o/a/pull/1';
const withApprovals = { status: 'running', reportPath: good.reportPath, _result: clean, prs: [{ url: pa }], approved: { 'https://github.com/o/c/pull/3': 'c0ffee' } };
fs.writeFileSync(good.reportPath, `---\nverdict: APPROVE\napproved: ${pa}@abc123 https://github.com/o/zz/pull/9@def junk\n---\n`);
finalize(withApprovals);
assert.deepEqual(withApprovals.approved, { 'https://github.com/o/c/pull/3': 'c0ffee', [pa]: 'abc123' }, 'carried + this review, nothing else');
assert.equal(withApprovals.awaitingHuman, undefined, 'approvals on: Prowl approved them itself');
// With Approve PRs off, the PRs given Prowl's stamp still need a human's approval; carried ones keep their flag.
const stampOnly = { ...withApprovals, status: 'running', approvals: false, approved: {}, awaitingHuman: ['https://github.com/o/c/pull/3'] };
finalize(stampOnly);
assert.deepEqual(awaitingHuman(stampOnly, true), ['https://github.com/o/c/pull/3', pa]);
assert.deepEqual(awaitingHuman({ approved: { [pa]: 'abc' } }, false), [pa], 'older reviews follow the current setting');
// Your own PR can't get Prowl's approval even with Approve PRs on, so it waits on a teammate's.
const selfReview = { ...withApprovals, status: 'running', approvals: true, approved: {}, awaitingHuman: undefined, me: 'Me', prs: [{ url: pa, author: 'me' }] };
finalize(selfReview);
assert.deepEqual(selfReview.awaitingHuman, [pa]);
assert.ok(isOwn({ author: 'ME' }, 'me') && !isOwn({ author: 'me' }, '') && !isOwn(undefined, 'me'));
assert.deepEqual(awaitingHuman({ approved: { [pa]: 'abc' } }, true), []);
fs.rmSync(dir, { recursive: true });

assert.deepEqual(changelog('# Notes\nintro\n\n## 2.3.0 (today)\n- One\n  wraps\n- Two\n\n## 2.2.0\n- Old\n'),
  [{ version: '2.3.0', items: ['One wraps', 'Two'] }, { version: '2.2.0', items: ['Old'] }]);

// The user's config files: seeded, upgraded only when unedited, and an old signature.md moved into output.md.
const cfgTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-'));
const [defs, mine] = [path.join(cfgTmp, 'defaults'), path.join(cfgTmp, 'mine')];
fs.mkdirSync(defs);
const put = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
const get = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
put(defs, 'review.md', 'r1');
put(defs, 'output.md', '# Output\n\n## Review banner\n\nbanner\n\n## Comment prefix\n\nprefix $&\n\n## Inline comment\n\ninline\n');
const synced = {};
assert.deepEqual(syncConfigFiles(defs, mine, synced, false), [], 'a fresh install is seeded quietly');
assert.equal(get(mine, 'review.md'), 'r1');
put(defs, 'review.md', 'r2');
put(defs, 'review-axis-catalog.md', 'a1');
let notes = syncConfigFiles(defs, mine, synced, true);
assert.equal(get(mine, 'review.md'), 'r2', 'an unedited copy moves to the new default');
assert.equal(get(mine, 'review-axis-catalog.md'), 'a1', 'a new config file is copied in');
assert.deepEqual(notes.map(n => n.text), ['review-axis-catalog.md added to your config folder', "review.md updated to the new default (you hadn't edited it)"]);
put(mine, 'review.md', 'my rules');
put(defs, 'review.md', 'r3');
notes = syncConfigFiles(defs, mine, synced, true);
assert.equal(get(mine, 'review.md'), 'my rules', 'an edited copy is never overwritten');
assert.equal(notes.length, 1);
assert.match(notes[0].text, /default review\.md changed/);
assert.equal(notes[0].path, path.join(defs, 'review.md'));
assert.deepEqual(syncConfigFiles(defs, mine, synced, true), [], 'each change is announced once');
fs.rmSync(path.join(mine, 'output.md'));
put(mine, 'signature.md', '# Signature\n\n## Review banner\n\nmy banner\n\n## Comment prefix\n\nmy prefix\n');
notes = syncConfigFiles(defs, mine, synced, true);
assert.equal(get(mine, 'output.md'), '# Output\n\n## Review banner\n\nmy banner\n\n## Comment prefix\n\nmy prefix\n\n## Inline comment\n\ninline\n');
assert.ok(fs.existsSync(path.join(mine, 'signature.md.old')) && !fs.existsSync(path.join(mine, 'signature.md')));
assert.deepEqual(notes.map(n => n.path), [path.join(mine, 'output.md')], 'the migration is announced, not as an edited copy');
fs.rmSync(path.join(mine, 'review-axis-catalog.md'));
put(mine, 'axis-catalog.md', 'my axes');
synced['axis-catalog.md'] = synced['review-axis-catalog.md'];
delete synced['review-axis-catalog.md'];
notes = syncConfigFiles(defs, mine, synced, true);
assert.equal(get(mine, 'review-axis-catalog.md'), 'my axes', 'a renamed file keeps the edited copy');
assert.ok(!fs.existsSync(path.join(mine, 'axis-catalog.md')) && !('axis-catalog.md' in synced));
assert.deepEqual(notes.map(n => n.text), ['axis-catalog.md is now review-axis-catalog.md']);
fs.rmSync(cfgTmp, { recursive: true });
// prowl-fix's config defaults are synced into the same folder, so no file name may be in both skills' defaults.
const skillCfg = skill => fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', skill, 'config'));
assert.deepEqual(skillCfg('prowl-fix').filter(f => skillCfg('prowl-review').includes(f)), [], 'config file names are unique across skills');

// A pid saved by an earlier launch is the review only if its process started with the review (not a reused pid).
const born = Date.now() - process.uptime() * 1000;
assert.ok(Math.abs(processStart(process.pid) - born) < 3000, 'reads a process start time');
assert.equal(alive({ pid: process.pid, startedAt: born }), true, "the review's own process");
assert.equal(alive({ pid: process.pid, startedAt: born - 86_400_000 }), false, 'a pid reused after the review died');

assert.deepEqual(wrap('Starting reviews for Slice 6 reminders, marking as In Review', 24, 3), ['Starting reviews for', 'Slice 6 reminders,', 'marking as In Review']);
assert.deepEqual(wrap('one two three four five six seven eight nine ten', 10, 2), ['one two', 'three fou…']);
assert.deepEqual(wrap('anything', 5, 3), [], 'no room: no speech box');

const owl = createMascot(() => 0.42);
for (const mood of ['idle', 'poll', 'review', 'cheer', 'sleep', 'error']) {
  for (let i = 0; i < 200; i++) {
    const rows = owl.render(i % 2 ? 50 : 12, 7, mood, i % 3 ? '' : 'Done reviewing PRs for Slice 11 Documents in the client profile, marking as Reviewed');
    assert.equal(rows.length, 7);
    for (const row of rows) assert.equal(row.reduce((n, [, text]) => n + text.length, 0), i % 2 ? 50 : 12, `${mood} row width`);
  }
}

// The fix-session fence: pushes, GitHub writes and edits outside the worktree are denied; commits and reads are not.
const fenceHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-')));
const [wt, briefDir] = [path.join(fenceHome, 'wt'), path.join(fenceHome, 'brief')];
fs.mkdirSync(wt);
fs.mkdirSync(briefDir);
const fenceEnv = { PROWL_SESSION: 'fix', PROWL_FIX_ROOTS: [wt, briefDir].join(path.delimiter) };
const bash = command => fenceDecision({ tool_name: 'Bash', tool_input: { command } }, fenceEnv)?.hookSpecificOutput.permissionDecision || 'allow';
for (const c of ['git push', 'git push origin HEAD:feature', 'cd x && git -C /tmp/r push -u origin b', 'git --no-pager push', 'git remote set-url origin x',
  'gh pr create --fill', 'gh pr merge 3', 'gh pr review --approve', 'gh pr comment 1 -b hi', 'gh api -X POST repos/o/r/issues/1/comments -f body=x',
  'gh api --method=PATCH repos/o/r/pulls/1', 'gh api repos/o/r/issues/1/comments -f body=hi', "gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:\"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='\nmutation($id:ID!) {\n x }'", 'gh repo delete o/r --yes', 'gh issue comment 4 -b x', 'echo ok; gh api -XDELETE repos/o/r/git/refs/heads/b']) {
  assert.equal(bash(c), 'deny', `denies: ${c}`);
}
for (const c of ['git commit -m "AB#1: fix"', 'git status && git diff HEAD~1', 'git log --oneline | head', 'npm test', 'gh pr view 3 --json title', 'gh pr diff 3',
  'gh api repos/o/r/pulls/1/comments', 'gh api -X GET search/issues -f q=x', "gh api graphql -f query='query { viewer { login } }'", 'git remote -v', 'echo "git pushes are Prowl\'s job"']) {
  assert.equal(bash(c), 'allow', `allows: ${c}`);
}
const write = (tool, file) => fenceDecision({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } }, fenceEnv) ? 'deny' : 'allow';
assert.equal(write('Edit', path.join(wt, 'src', 'new', 'a.js')), 'allow', 'a new file in the worktree');
assert.equal(write('Write', path.join(briefDir, 'result.json')), 'allow');
assert.equal(write('Write', path.join(fenceHome, 'elsewhere.txt')), 'deny');
assert.equal(write('Edit', path.join(wt, '..', 'escape.txt')), 'deny', 'no .. out of the worktree');
assert.equal(write('NotebookEdit', '/etc/x.ipynb'), 'deny');
let linked = true;
try { fs.symlinkSync(fenceHome, path.join(wt, 'link'), 'junction'); } catch { linked = false; } // Windows may not allow links
if (linked) assert.equal(write('Write', path.join(wt, 'link', 'out.txt')), 'deny', 'no symlink out of the worktree');
assert.equal(fenceDecision({ tool_name: 'Bash', tool_input: { command: 'git push' } }, {}), null, 'review sessions are untouched');
assert.equal(fenceDecision({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }, fenceEnv), null, 'reads are allowed');
assert.ok(DISALLOWED.includes('Bash(git push *)') && DISALLOWED.includes('Bash(gh pr create *)'));
assert.match(fenceSettings('/app', '/bin/node').hooks.PreToolUse[0].hooks[0].command, /^"\/bin\/node" "\/app\/hooks\/fix-guard\.mjs"$/);
// ...and the hook itself, run as Claude Code runs it.
const hook = (call, env) => spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'fix-guard.mjs')],
  { input: JSON.stringify(call), env: { ...process.env, PROWL_SESSION: '', ...env }, encoding: 'utf8' });
const denied = hook({ tool_name: 'Bash', tool_input: { command: 'git push' } }, fenceEnv);
assert.equal(denied.status, 0);
assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'git push' } }, {}).stdout, '', 'not a fix session: no output');
fs.rmSync(fenceHome, { recursive: true });

// Fix rounds read a PR's threads, and a details file from a PR-Owl review posted by someone else's Prowl.
const fixFixture = name => fixture(path.join('fix', name));
const threads = threadsFrom(JSON.parse(fixFixture('threads.json')));
assert.equal(threads.length, 6);
assert.deepEqual(threads[1], { id: 'PRRT_bot1', resolved: false, path: 'src/load.js', line: 7, commentId: 1002, author: 'copilot-pull-request-reviewer', bot: true,
  body: 'Consider handling a null response here.', url: 'https://github.com/acme/api/pull/12#discussion_r1002', lastAuthor: 'copilot-pull-request-reviewer', lastBody: 'Consider handling a null response here.' });
assert.ok(threads[3].resolved && !threads[2].bot);
const reviewBody = fixFixture('review-body.md');
const details = detailsFromBodies([{ body: 'LGTM', at: '2026-10-16T12:00:00Z' }, { body: reviewBody, at: '2026-10-16T10:00:00Z' }], [{ body: 'thanks' }, { body: fixFixture('part2.md') }], 'api-12');
assert.ok(details.startsWith('# PR-Owl Review: acme/api#12') && details.includes('```js\nsave(a); save(b);\n```') && details.includes('## Parked'), 'the fenced details file, inner fences kept');
assert.ok(details.endsWith('- Correctness & Logic') && !details.includes('Continued in part 2'), 'joined with part 2');
assert.equal(detailsFromBodies([{ body: reviewBody, at: '2026-10-16T10:00:00Z' }], [], 'api-1'), '', 'another PR: none');
assert.equal(detailsFromBodies([{ body: '<summary>prowl-review-x-api-12.md</summary> no fence', at: '' }], [], 'api-12'), '', 'unparseable: none');
assert.equal(detailsFromBodies([{ body: reviewBody, at: '' }], [], 'api-12').includes('Coverage'), false, 'part 1 alone when there is no part 2');
assert.equal(checksState([]), 'green', 'no required checks');
assert.equal(checksState([{ bucket: 'pass' }, { bucket: 'skipping' }]), 'green');
assert.equal(checksState([{ bucket: 'pass' }, { bucket: 'pending' }]), 'pending');
assert.equal(checksState([{ bucket: 'pending' }, { bucket: 'fail' }]), 'failing');

console.log('self-test passed');
