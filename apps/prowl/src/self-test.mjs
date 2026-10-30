// node prowl.mjs --self-test: checks the logic that decides which tickets and PRs get touched. prowl.mjs runs it in a
// throwaway PROWL_HOME. Each assert is counted, and the count printed.
import nodeAssert from 'node:assert/strict';
import { frontMatter, mentions, norm, swapTags, tagMatches } from './match.mjs';
import { addedLabel, adfText, claimEntry, label } from './jira.mjs';
import { htmlText } from './ado.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, HOME } from './config.mjs';
import { alive, awaitingHuman, buildPrompt, failUnposted, finalize, findingsOnly, isOwn, overdue, postMarker, REPORTS_DIR, retryFailed, reviewArgs, reviewEnv, roundCapped, tidyLogs } from './reviewer/reviews.mjs';
import { processStart } from './proc.mjs';
import { createMascot, wrap } from './mascot.mjs';
import { changelog, newer, syncConfigFiles } from './update.mjs';
import { DISALLOWED, fenceArgs, fenceDecision, fenceEnv, fenceSettings, lex, trackerHosts } from './fence.mjs';
import { checksState, detailsFromBodies, prThreads, reviewedIn, threadsFrom } from './github.mjs';
import { globRe, matchChecks, runChecks, runCommand } from './checks.mjs';
import { guardFailures, prRefusal, SECRET_PATTERNS } from './guards.mjs';
import { actionable, parkedUrls, pastAnswers, repliesToPost, stripParked, validateFeedback } from './feedback.mjs';
import { fill, outputTemplate, template } from './templates.mjs';

let count = 0;
// node:assert, counting each call.
const assert = new Proxy(nodeAssert, {
  apply(target, self, a) { count++; return Reflect.apply(target, self, a); },
  get(target, k) { const v = target[k]; return typeof v === 'function' ? (...a) => { count++; return v.apply(target, a); } : v; },
});
assert.ok(HOME !== path.join(os.homedir(), '.prowl'), 'the self-test never runs against your own ~/.prowl');

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
// Two copies of Prowl signed in as the same account: each claim's one-off label says whose write won. The later
// write only adds its own label, and when both writes removed the trigger at once, the last one wins for both.
const twin = [entry('alice', 'Ready-for-Review', 'In-Review prowl-claim-aa'), entry('alice', 'In-Review prowl-claim-aa', 'In-Review prowl-claim-aa prowl-claim-bb')];
assert.ok(addedLabel(claimEntry(twin, ['Ready-for-Review']), 'prowl-claim-aa') && !addedLabel(claimEntry(twin, ['Ready-for-Review']), 'prowl-claim-bb'));
const atOnce = [entry('alice', 'Ready-for-Review', 'In-Review prowl-claim-aa'), entry('alice', 'Ready-for-Review', 'In-Review prowl-claim-bb')];
assert.ok(addedLabel(claimEntry(atOnce, ['Ready-for-Review']), 'prowl-claim-bb') && !addedLabel(claimEntry(atOnce, ['Ready-for-Review']), 'prowl-claim-aa'));

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
// prowl-work's config defaults are synced into the same folder, so no file name may be in both skills' defaults.
const skillCfg = skill => fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', skill, 'config'));
assert.deepEqual(skillCfg('prowl-work').filter(f => skillCfg('prowl-review').includes(f)), [], 'config file names are unique across skills');
assert.ok(!fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'prowl-fix')), 'Fix my PRs is removed');

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

// The session fence (kind 'work'): pushes, GitHub and tracker writes, MCP tools outside the allow list and writes
// outside the session's folders are denied; commits, reads and the temp folder are not.
const fenceHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-')));
const [wt, briefDir] = [path.join(fenceHome, 'wt'), path.join(fenceHome, 'brief')];
fs.mkdirSync(wt);
fs.mkdirSync(briefDir);
const workEnv = fenceEnv('work', [wt, briefDir], ['mcp__docs__search', 'mcp__notes__*'], trackerHosts('https://example.atlassian.net'));
assert.deepEqual(Object.keys(workEnv).sort(), ['PROWL_MCP_ALLOW', 'PROWL_SESSION', 'PROWL_TRACKER_HOSTS', 'PROWL_WORK_ROOTS']);
assert.throws(() => fenceEnv('fix', [wt]), /no fence/, 'the fence is keyed by session kind');
const aliases = { p: 'push --force-with-lease', sync: '!git fetch && git push', st: 'status' };
const decide = (call, env = workEnv) => fenceDecision({ cwd: wt, ...call }, env, name => aliases[name] || '')?.hookSpecificOutput.permissionDecision || 'allow';
const bash = command => decide({ tool_name: 'Bash', tool_input: { command } });
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
// Every other way to push, or to change where a push goes.
for (const c of ['git send-pack origin main', 'git subtree push --prefix lib origin main', 'git subtree --prefix=lib push origin x', 'git lfs push origin main', 'git p', 'git -C sub sync',
  'git config alias.up push', "git config --global alias.ship '!git push origin'", 'git -c alias.x=push x', 'git config remote.origin.pushurl https://example.invalid/r.git',
  'git config url.https://example.invalid/.insteadOf https://github.com/', 'git -c url.git@example.invalid:.pushInsteadOf=https://github.com/ push2']) {
  assert.equal(bash(c), 'deny', `denies a push path: ${c}`);
}
assert.equal(bash('git st'), 'allow', "an alias that doesn't push");
// An alias is looked up where git runs, so in the folder -C names.
const other = path.join(fenceHome, 'other-repo');
const aliasIn = (name, dir) => (name === 'ship' && dir === other ? 'push --force' : '');
const inDir = command => fenceDecision({ cwd: wt, tool_name: 'Bash', tool_input: { command } }, workEnv, aliasIn)?.hookSpecificOutput.permissionDecision || 'allow';
assert.deepEqual([inDir(`git -C ${other} ship`), inDir('git ship'), inDir(`env git -C ${other} ship`)], ['deny', 'allow', 'deny'], "a pushing alias in -C's repo");
assert.deepEqual([inDir('cd "$REPO_DIR" && git ship origin HEAD:main'), inDir('cd "$REPO_DIR" && git status')], ['deny', 'allow'], "an alias in a folder the fence can't read");
assert.equal(inDir(`env -C ${other} git ship`), 'deny', "an alias where env -C runs git");
assert.deepEqual([inDir('git -C "$REPO_DIR" ship origin HEAD:main'), inDir(`git --git-dir=${other}/.git ship`), inDir('git -C "$REPO_DIR" status')], ['deny', 'deny', 'allow'], "an alias in a repo the fence can't read");
assert.equal(bash(`git -C ${wt} -P push --force origin HEAD:main`), 'deny', 'a push after a short global option');
assert.deepEqual([bash(`git -C "${wt}/My App" push --force origin HEAD:main`), bash(`git -C "${wt}/My App" remote set-url origin x`)], ['deny', 'deny'], 'after a quoted path with a space');
for (const c of ["git -c 'alias.ship=push --force' ship origin HEAD:main", "git config 'alias.ship' 'push --force'", 'git -c "remote.origin.pushurl=https://example.invalid/r.git" fetch',
  "git config set 'alias.ship' 'push --force'; git ship origin HEAD:main", "git config --global --add 'alias.ship' '!git push'"]) {
  assert.equal(bash(c), 'deny', `denies quoted push config: ${c}`);
}
// A shell reading a heredoc runs it; a subshell's cd ends with it.
assert.deepEqual([bash("bash <<'SH'\nrm -rf /etc/other\nSH"), bash("cat <<'SH'\nrm -rf /etc/other\nSH")], ['deny', 'allow'], 'a heredoc script');
const fromHome = command => fenceDecision({ cwd: os.homedir(), tool_name: 'Bash', tool_input: { command } }, workEnv, () => '')?.hookSpecificOutput.permissionDecision || 'allow';
assert.deepEqual([fromHome(`(cd ${wt} && npm test); rm -rf build`), fromHome(`cd ${wt} && rm -rf build`)], ['deny', 'allow'], "a subshell's cd doesn't move the shell");
assert.deepEqual([bash('cd /etc && out=$(rm -rf dist 2>&1)'), fromHome(`cd ${wt} && out=$(rm -rf dist)`)], ['deny', 'allow'], 'a $(…) runs where its command does');
// curl and wget writes to GitHub's API, and GraphQL the fence can't read; reads are allowed.
for (const c of ['curl -X POST https://api.github.com/repos/o/r/issues -d @body.json', 'curl -sS -XPATCH https://api.github.com/repos/o/r/pulls/1 --data "{}"',
  'curl -H "Authorization: bearer x" https://api.github.com/graphql -d \'{"query":"query{viewer{login}}"}\'', 'wget --method=DELETE https://api.github.com/repos/o/r/git/refs/heads/b',
  'wget --post-file=q.json https://api.github.com/graphql', 'gh api graphql -f query=@mutation.graphql', 'gh api graphql --input q.json',
  'gh api graphql -f query="$(cat q.graphql)"', 'Q=$(cat m); gh api graphql -f query="$Q"', 'curl --config request.conf https://api.github.com/graphql',
  'curl -K req.conf', 'export CURL_HOME=.; curl https://api.github.com/graphql', 'wget -e post_data=x https://api.github.com/graphql',
  'curl -sK request.conf https://api.github.com/graphql', 'curl -sd @q.json https://api.github.com/graphql', 'curl -sXPOST https://api.github.com/repos/o/r/issues',
  'curl -X POST --url=https://api.github.com/repos/o/r/issues/1/comments -d \'{"body":"done"}\'', 'curl -X POST --url="$API_URL" -d x', 'curl -X POST --json @issue.json "https://api.${DOMAIN}/repos/o/r/issues"']) {
  assert.equal(bash(c), 'deny', `denies a GitHub write: ${c}`);
}
for (const c of ['curl https://api.github.com/repos/o/r/pulls/1', 'curl -s -X GET https://api.github.com/repos/o/r', 'wget -qO- https://api.github.com/repos/o/r',
  'wget -e robots=off -qO- https://api.github.com/repos/o/r', 'curl -fsSL https://api.github.com/repos/o/r', 'curl -D - -k https://api.github.com/repos/o/r',
  "gh api graphql -F owner=o -f query='query($owner:String!){repositoryOwner(login:$owner){id}}'"]) {
  assert.equal(bash(c), 'allow', `allows a GitHub read: ${c}`);
}
// Shell writes to either tracker, with reads allowed.
for (const c of ['curl -X PATCH https://dev.azure.com/o/Shop/_apis/wit/workitems/1 -d @p.json', 'curl -d "{}" https://o.visualstudio.com/_apis/wit/workitems/1',
  'curl -X PUT https://example.atlassian.net/rest/api/3/issue/PROJ-123 --json \'{"update":{}}\'', 'wget --post-data=x https://other.atlassian.net/rest/api/3/issue',
  'az boards work-item update --id 1 --fields System.Tags=x', 'az devops invoke --area wit --http-method PATCH', 'az devops invoke --area wit --http-method=PATCH --in-file p.json',
  'acli jira workitem edit --key PROJ-123']) {
  assert.equal(bash(c), 'deny', `denies a tracker write: ${c}`);
}
for (const c of ['curl https://dev.azure.com/o/Shop/_apis/wit/workitems/1', 'curl -s https://example.atlassian.net/rest/api/3/issue/PROJ-123', 'az boards work-item show --id 1']) {
  assert.equal(bash(c), 'allow', `allows a tracker read: ${c}`);
}
// Writes outside the session's folders through a redirect, tee, cp, mv or rm; the temp folder is fine.
// (The test's own folders are in the temp folder, which sessions may write in, so "outside" is the home folder or /etc here.)
for (const c of ['echo x > /etc/x', 'echo x >> ~/outside.txt', 'ls | tee /etc/listing', `cp a ${path.join(os.homedir(), 'b')}`, 'mv notes.md ~/notes.md', 'rm -rf ~',
  'rm -rf /', 'echo $(echo x > /etc/y)', 'sh -c "echo > /etc/z"', 'echo x > $SOMEWHERE/out', 'cd / && rm -rf other', 'echo x > "$HOME/.bashrc"',
  "bash -lc 'rm -f /etc/notes.txt'", 'zsh -ec "echo > /etc/z"', `printf '%s' "$(rm -f /etc/notes.txt)"`, 'echo "`rm -f /etc/notes.txt`"', '(rm -rf /etc/other)', 'true && (cd / && rm -rf other)',
  'if rm -rf /etc/other; then echo cleaned; fi', 'while true; do rm -f /etc/x; done', '{ rm -rf /etc/other; }', 'if cd /etc; then rm -rf build; fi',
  'command -- rm -rf /etc/other', 'env -i rm -f /etc/x', 'cd -- /etc && rm -rf build', 'cd "$SOMEWHERE" && rm -rf build', 'env -u NODE_OPTIONS rm -rf /etc/other',
  "env -S 'rm -rf /etc/other'", "env -S 'rm -rf' /etc/other", 'env -C /etc rm -rf build', 'env --chdir=/etc rm -rf build', 'env -C/etc rm -rf build',
  "env -S'rm -rf' /etc/other", 'mv --target-directory=/etc config.json', 'cp -t/etc config.json', 'cp --target-directory /etc a', 'mv -t /etc a',
  'cp -vt /etc config.json', 'cp -vt/etc config.json', '/usr/bin/env rm -f /etc/config.json', '/usr/bin/sudo rm -f /etc/x',
  `TMPDIR=/etc bash -c 'rm -f "$TMPDIR/config.json"'`, 'export HOME=/etc; rm -f ~/x', 'sudo --user root rm -f /etc/config.json', 'sudo -D /etc rm -f x', 'sudo --chdir=/etc rm -f x', 'sudo -D/etc rm -f x',
  'cat > README.md <<EOF\nClean with `rm -rf /etc/cache` or $(rm -rf /etc/other).\nEOF']) {
  assert.equal(bash(c), 'deny', `denies a write outside: ${c}`);
}
for (const c of ['echo x > notes.md', `echo x > ${path.join(briefDir, 'result.json')}`, 'cp a b', 'rm -rf build', 'mv a.js b.js', 'npm test 2>&1 | tee test.log',
  `echo x > ${path.join(os.tmpdir(), 'prowl-scratch.txt')}`, '(cd sub && rm -rf build)', "cat > README.md <<'EOF'\nClean with `rm -rf /etc/cache`.\nEOF",
  "cat > NOTES.md <<EOF\nIt's done; don't \\`rm -rf /etc\\`.\nEOF", 'cd "$TMPDIR" && rm -rf scratch', 'cd -P sub && rm -rf build', 'echo x > "$TMPDIR/x"', 'ls 2>&1 >/dev/null', "cat > notes.md <<'EOF'\nfoo > /etc/passwd\nEOF"]) {
  assert.equal(bash(c), 'allow', `allows a write inside: ${c}`);
}
assert.equal(lex("a 'b; c' | d").length, 2, 'quotes keep ; and | inside one word');
// MCP tools: denied unless the allow list names them.
assert.equal(decide({ tool_name: 'mcp__tracker__update_issue', tool_input: {} }), 'deny', 'an MCP tool not in the allow list');
assert.equal(decide({ tool_name: 'mcp__docs__search', tool_input: {} }), 'allow', 'an MCP tool the allow list names');
assert.equal(decide({ tool_name: 'mcp__notes__read', tool_input: {} }), 'allow', 'an MCP tool matching a * pattern');
assert.equal(decide({ tool_name: 'mcp__docs__search', tool_input: {} }, fenceEnv('work', [wt])), 'deny', 'no allow list: no MCP tools');
assert.deepEqual(fenceArgs([]).slice(-2), ['mcp__*', '--strict-mcp-config'], 'no MCP servers unless some are allowed');
assert.ok(!fenceArgs(['mcp__docs__search']).includes('--strict-mcp-config') && fenceArgs([]).includes('Bash(git send-pack *)'));
const write = (tool, file) => decide({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } });
assert.equal(write('Edit', path.join(wt, 'src', 'new', 'a.js')), 'allow', 'a new file in the worktree');
assert.equal(write('Write', path.join(briefDir, 'result.json')), 'allow');
assert.equal(write('Write', path.join(fenceHome, 'elsewhere.txt')), 'deny');
assert.equal(write('Edit', path.join(wt, '..', 'escape.txt')), 'deny', 'no .. out of the worktree');
assert.equal(write('NotebookEdit', '/etc/x.ipynb'), 'deny');
let linked = true;
try { fs.symlinkSync(fenceHome, path.join(wt, 'link'), 'junction'); } catch { linked = false; } // Windows may not allow links
if (linked) assert.equal(write('Write', path.join(wt, 'link', 'out.txt')), 'deny', 'no symlink out of the worktree');
assert.equal(fenceDecision({ tool_name: 'Bash', tool_input: { command: 'git push' } }, {}), null, 'review sessions are untouched');
assert.equal(fenceDecision({ tool_name: 'Bash', tool_input: { command: 'git push' } }, { PROWL_SESSION: 'fix' }), null, "2.11.3's fix kind is gone");
assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }), 'allow', 'reads are allowed');
assert.ok(DISALLOWED.includes('Bash(git push *)') && DISALLOWED.includes('Bash(gh pr create *)'));
assert.match(fenceSettings('/app', '/bin/node').hooks.PreToolUse[0].hooks[0].command, /^"\/bin\/node" "\/app\/hooks\/fence-guard\.mjs"$/);
assert.ok(new RegExp(fenceSettings('/app').hooks.PreToolUse[0].matcher).test('mcp__tracker__update_issue'), 'the hook sees MCP tools');
// ...and the hook itself, run as Claude Code runs it.
const hook = (call, env) => spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'fence-guard.mjs')],
  { input: JSON.stringify(call), env: { ...process.env, PROWL_SESSION: '', ...env }, encoding: 'utf8' });
const denied = hook({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: wt }, workEnv);
assert.equal(denied.status, 0);
assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'git push' } }, {}).stdout, '', 'not a fenced session: no output');
fs.rmSync(fenceHome, { recursive: true });

// Feedback rounds read a PR's threads, and a details file from a PR-Owl review posted by someone else's Prowl.
const fbFixture = name => fixture(path.join('feedback', name));
const threads = threadsFrom(JSON.parse(fbFixture('threads.json')));
assert.equal(threads.length, 6);
assert.deepEqual(threads[1], { id: 'PRRT_bot1', resolved: false, path: 'src/load.js', line: 7, commentId: 1002, author: 'copilot-pull-request-reviewer', bot: true,
  body: 'Consider handling a null response here.', url: 'https://github.com/octo-org/api/pull/12#discussion_r1002', lastAuthor: 'copilot-pull-request-reviewer', lastBody: 'Consider handling a null response here.', lastAt: '' });
assert.ok(threads[3].resolved && !threads[2].bot);
const reviewBody = fbFixture('review-body.md');
const details = detailsFromBodies([{ body: 'LGTM', at: '2026-10-16T12:00:00Z' }, { body: reviewBody, at: '2026-10-16T10:00:00Z' }], [{ body: 'thanks' }, { body: fbFixture('part2.md') }], 'api-12');
assert.ok(details.startsWith('# PR-Owl Review: octo-org/api#12') && details.includes('```js\nsave(a); save(b);\n```') && details.includes('## Parked'), 'the fenced details file, inner fences kept');
assert.ok(details.endsWith('- Correctness & Logic') && !details.includes('Continued in part 2'), 'joined with part 2');
assert.equal(detailsFromBodies([{ body: reviewBody, at: '2026-10-16T10:00:00Z' }], [], 'api-1'), '', 'another PR: none');
assert.equal(detailsFromBodies([{ body: '<summary>prowl-review-x-api-12.md</summary> no fence', at: '' }], [], 'api-12'), '', 'unparseable: none');
assert.equal(detailsFromBodies([{ body: reviewBody, at: '' }], [], 'api-12').includes('Coverage'), false, 'part 1 alone when there is no part 2');
assert.equal(checksState([]), 'green', 'no required checks');
assert.equal(checksState([{ bucket: 'pass' }, { bucket: 'skipping' }]), 'green');
assert.equal(checksState([{ bucket: 'pass' }, { bucket: 'pending' }]), 'pending');
assert.equal(checksState([{ bucket: 'pending' }, { bucket: 'fail' }]), 'failing');

// The details-file copy for Fix my PRs is gone: no setting adds it to the review prompt.
assert.ok(!buildPrompt({ ...promptCases.first, detailsDir: '/home/.prowl/reports/AB42-r1' }).includes("Also copy each PR's details file"));

// A review that didn't post its review fails. GitHub files thread replies as empty COMMENT reviews, so only a review
// carrying the run's marker counts; with no marker (a review started before 2.12.0), any review counts.
const marker = postMarker('AB42-20261029T1000-r1');
assert.equal(marker, '<!-- prowl-review AB42-20261029T1000-r1 review -->');
const since = Date.parse('2026-10-29T10:00:00Z');
const rows = [{ user: 'octocat', at: '2026-10-29T10:05:00Z', body: '' }, { user: 'octocat', at: '2026-10-29T10:06:00Z', body: '' },
  { user: 'teammate', at: '2026-10-29T10:07:00Z', body: `x\n${marker}` }, { user: 'octocat', at: '2026-10-29T09:00:00Z', body: `old\n${marker}` }];
assert.equal(reviewedIn(rows, 'octocat', since, marker), false, 'two empty replies, a teammate\'s marked review and an earlier one: not posted');
assert.equal(reviewedIn(rows, 'octocat', since), true, 'without a marker, any review since counts');
assert.equal(reviewedIn([...rows, { user: 'OctoCat', at: '2026-10-29T10:30:00Z', body: `🦉 verdict\n${marker}` }], 'octocat', since, marker), true, 'the marked review, any case');
assert.equal(reviewedIn([...rows, { user: 'octocat', at: '2026-10-29T10:30:00Z', body: 'a review without it' }], 'octocat', since, marker), 'unmarked', 'counts, with a warning');
const withMarker = buildPrompt({ ...promptCases.first, marker });
assert.ok(withMarker.includes(`- End the body of each review you post with this line: ${marker}\n`) && !buildPrompt(promptCases.first).includes('End the body'));
assert.equal(withMarker.replace(`- End the body of each review you post with this line: ${marker}\n`, ''), fixture('first.prompt.md'), 'the marker line is the only change');
const posted = { status: 'done', prs: [{ url: 'https://github.com/o/a/pull/1', repo: 'o/a', number: 1 }], logPath: '/logs/AB42-r1.ndjson' };
failUnposted(posted, []);
assert.equal(posted.status, 'done', 'every review posted: still done');
const unposted = { ...posted, status: 'done' };
failUnposted(unposted, unposted.prs);
assert.equal(unposted.status, 'failed');
assert.match(unposted.error, /^no review posted on o\/a#1; .*\/logs\/AB42-r1\.ndjson/);
assert.equal(retryFailed(unposted, 1), false, 'not retried: a retry would most likely be blocked again');

// Round planning: which threads a round takes on, by Fix comments from.
const parked = parkedUrls(details);
assert.deepEqual(parked, ['https://github.com/octo-org/api/pull/12#discussion_r1005']);
const ids = (from, p = []) => actionable(threads, from, p).map(t => t.id);
assert.deepEqual(ids('prowl'), ['PRRT_owl1', 'PRRT_parked1'], "Prowl's own threads; never resolved ones, nor one Prowl answered last");
assert.deepEqual(ids('prowl+bots'), ['PRRT_owl1', 'PRRT_bot1', 'PRRT_parked1']);
assert.deepEqual(ids('everyone', parked), ['PRRT_owl1', 'PRRT_bot1', 'PRRT_person1'], 'everyone, less the parked finding');
assert.ok(!stripParked(details).includes('## Parked') && stripParked(details).includes('### F-01'));
// Refusals: only the user's own PR, never a draft, a fork or a protected branch.
const facts = { author: 'octocat', fork: false, headBranch: 'feature/save', defaultBranch: 'develop' };
const pr12 = { url: 'https://github.com/octo-org/api/pull/12', repo: 'octo-org/api', number: 12, title: 'Add saving', author: 'octocat' };
assert.equal(prRefusal(facts, pr12, 'OctoCat', ['main', 'release/*']), '');
assert.match(prRefusal({ ...facts, author: 'lead' }, pr12, 'octocat', []), /isn't yours/);
assert.match(prRefusal({ ...facts, fork: true }, pr12, 'octocat', []), /fork/);
assert.match(prRefusal({ ...facts, draft: true }, pr12, 'octocat', []), /draft/);
assert.match(prRefusal({ ...facts, headBranch: 'develop' }, pr12, 'octocat', []), /default branch/);
assert.match(prRefusal({ ...facts, headBranch: 'release/2.1' }, pr12, 'octocat', ['release/*']), /Branches never pushed/);
assert.ok(globRe('.github/workflows/**').test('.github/workflows/ci.yml') && globRe('**/secrets.json').test('secrets.json') && globRe('**/secrets.json').test('a/b/secrets.json'));
assert.ok(!globRe('**/secrets.json').test('mysecrets.json') && !globRe('release/*').test('release/a/b'));

// Past answers: the same repos, shared keywords only.
const answersLog = [{ ts: '2026-09-01T10:00:00Z', ticket: 'AB#7', repo: 'octo-org/api', question: 'Should save await the first write before the second?', answer: 'Yes, always await.' },
  { ts: '2026-09-02T10:00:00Z', ticket: 'AB#8', repos: ['octo-org/web'], question: 'Should save await the first write?', answer: 'n/a' },
  { ts: '2026-09-03T10:00:00Z', ticket: 'AB#9', repos: ['octo-org/api'], question: 'Which colour is the button?', answer: 'Blue.' }];
const past = pastAnswers(answersLog, `${details} ${threads.map(t => t.body).join(' ')}`, ['octo-org/api']);
assert.deepEqual(past.map(a => a.ticket), ['AB#7'], 'same repo, shared keywords only');
assert.deepEqual(pastAnswers(answersLog, 'save await first write', ['octo-org/web']).map(a => a.ticket), ['AB#8'], "a Builder answer's repos list");

// A feedback round's result.json: every status, and what makes one invalid (an ask without a searched line is asked once more).
const fixedResult = JSON.parse(fbFixture('result-fixed.json'));
assert.equal(validateFeedback(fixedResult), '');
assert.equal(validateFeedback(JSON.parse(fbFixture('result-partial.json'))), '');
assert.match(validateFeedback(JSON.parse(fbFixture('result-blocked.json'))), /has no searched line/);
assert.match(validateFeedback({ ...fixedResult, status: 'done' }), /status/);
assert.match(validateFeedback({ ...fixedResult, items: [{ action: 'fixit' }] }), /no action/);
assert.match(validateFeedback({ ...fixedResult, items: [{ thread: 'x', action: 'parked' }] }), /no action/, "the action is park");
assert.match(validateFeedback({ ...fixedResult, items: [{ thread: 'x', action: 'ask' }], questions: [] }), /ask item has no question/);
assert.match(validateFeedback({ ...fixedResult, commits: [{ pr: 'octo-org/api#12', sha: 'not a sha' }] }), /commit/);
assert.match(validateFeedback([]), /not a JSON object/);

// Replies: one per thread fixed (once pushed) or disputed, and none already posted, by its marker.
const roundThreads = actionable(threads, 'everyone', parked).map(t => ({ id: t.id, commentId: t.commentId }));
const toPost = repliesToPost({ ticket: 'AB#42', round: 2, items: fixedResult.items, threads: roundThreads, pushed: '3f2a1c9d0e' }, []);
assert.deepEqual(toPost.map(r => [r.thread, r.what, r.commentId]), [['PRRT_owl1', 'fixed', 1001], ['PRRT_bot1', 'fixed', 1002], ['PRRT_person1', 'disputed', 1003]]);
assert.equal(toPost[0].marker, '<!-- prowl-fix AB#42 r2 PRRT_owl1 fixed -->');
assert.deepEqual(repliesToPost({ ticket: 'AB#42', round: 2, items: fixedResult.items, threads: roundThreads, pushed: 'x' }, [`Fixed in 3f2a1c9\n${toPost[0].marker}`, `x\n${toPost[2].marker}`]).map(r => r.thread), ['PRRT_bot1'], 'a restart posts nothing twice');
assert.deepEqual(repliesToPost({ ticket: 'AB#42', round: 2, items: fixedResult.items, threads: roundThreads, pushed: null }, []).map(r => r.what), ['disputed'], "nothing pushed: no 'fixed' replies");
assert.equal(repliesToPost({ ticket: 'AB#42', round: 2, items: [fixedResult.items[0], { ...fixedResult.items[0], finding: 'F-02' }], threads: roundThreads, pushed: 'x' }, []).length, 1, 'two items on one thread: one reply');
assert.match(validateFeedback({ status: 'fixed', items: [], questions: [null] }), /questions must be a list of objects/, 'a null question: unusable, not a crash');
assert.match(validateFeedback({ status: 'fixed', items: [{ thread: 'T1', action: 'dispute', note: { text: 'x' } }] }), /note must be text/, "a note that isn't text is never posted");
const outputMd = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'prowl-review', 'config', 'output.md'), 'utf8');
assert.equal(fill(template(outputMd, 'Fix reply'), { 'comment prefix': template(outputMd, 'Comment prefix'), sha: '3f2a1c9', note: 'save() awaits.' }), '🦉 **PR-Owl Review** · Fixed in 3f2a1c9: save() awaits.');
const started = fill(template(outputMd, 'Review started'), { ticket: 'AB#42', 'ticket link': 'https://dev.azure.com/o/p/_workitems/edit/42' });
assert.equal(started, "🦉 **PR-Owl** is reviewing this PR for [AB#42](https://dev.azure.com/o/p/_workitems/edit/42). Its review lands here when it's done.", 'Review started');
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(outputTemplate(appDir, 'Review started'), "the user's template, or the default's when their output.md predates it");
assert.equal(outputTemplate(appDir, 'No such section'), '');
assert.equal(template('# x\n\n## Fix reply\n\nno fence\n\n## Next\n```\nnot this\n```\n', 'Fix reply'), null, 'a section without a template');
assert.equal(template('', 'Fix reply'), null);
// Prowl never resolves a thread: the only GraphQL its own code sends is the threads query.
for (const f of ['github.mjs', 'fence.mjs', 'feedback.mjs', 'git.mjs', path.join('builder', 'builder.mjs'), path.join('reviewer', 'reviewer.mjs')]) {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), f), 'utf8');
  assert.ok(!/resolveReviewThread|mutation\s*[({]/.test(src), `${f} builds no GraphQL mutation`);
}

// Checks before push: the first matching repo glob, setup then run, the output tail, and the timeout.
const checksCfg = JSON.parse(fbFixture('checks.json'));
assert.deepEqual(matchChecks(checksCfg, 'octo-org/web').run, ['make test'], 'first match wins');
assert.equal(matchChecks(checksCfg, 'OCTO-ORG/api').timeoutMinutes, 1, 'owner/* wildcard, any case');
assert.ok(matchChecks(checksCfg, 'other/thing').run[0].includes('boom'));
assert.equal(matchChecks({}, 'octo-org/api'), null, 'nothing matches: no checks');
const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-'));
assert.deepEqual(await runChecks(matchChecks(checksCfg, 'octo-org/api'), checkDir), { ok: true }, 'setup ran before run, in the worktree');
const failedCheck = await runChecks(matchChecks(checksCfg, 'other/x'), checkDir);
assert.ok(!failedCheck.ok && failedCheck.tail.includes('lint ok') && failedCheck.tail.includes('boom'), 'a failure keeps the output tail');
const slow = await runCommand('node -e "setTimeout(() => {}, 10000)"', checkDir, {}, 300);
assert.ok(!slow.ok && slow.timedOut, 'a check past its timeout is stopped');
fs.rmSync(checkDir, { recursive: true });

// Guards before a push.
const okGuard = { base: 'aaa1111', head: 'bbb2222', ancestor: true, remote: 'aaa1111', numstat: '10\t2\tsrc/save.js\n-\t-\tlogo.png\n', diff: '+++ b/src/save.js\n+await save(a);\n' };
const limits = { maxChangedLines: 1000, protectedPaths: ['.github/workflows/**'] };
assert.deepEqual(guardFailures(okGuard, limits), []);
assert.deepEqual(guardFailures({ ...okGuard, remote: 'ccc3333' }, limits).map(g => g.kind), ['moved'], 'the remote moved: drop the round');
assert.deepEqual(guardFailures({ ...okGuard, remote: '', expected: '' }, limits), [], 'a new branch: nothing on the remote yet');
assert.match(guardFailures({ ...okGuard, remote: 'ccc3333', expected: '' }, limits)[0].text, /already exists/, 'a branch someone else pushed first');
assert.match(guardFailures({ ...okGuard, onBranch: false }, limits)[0].text, /Prowl's branch/);
assert.match(guardFailures({ ...okGuard, ancestor: false }, limits)[0].text, /history was rewritten/);
assert.match(guardFailures({ ...okGuard, head: 'aaa1111' }, limits)[0].text, /no new commit/);
assert.match(guardFailures({ ...okGuard, numstat: '900\t200\tsrc/big.js' }, limits)[0].text, /1100 lines/);
assert.match(guardFailures({ ...okGuard, numstat: '1\t0\t.github/workflows/ci.yml' }, limits)[0].text, /\.github\/workflows\/ci\.yml/);
assert.match(guardFailures({ ...okGuard, numstat: '1\t0\t{src => .github/workflows}/ci.yml' }, limits)[0].text, /Paths that need a person/, 'a rename into a protected path');
// The Builder's numstat -z: paths unquoted (git quotes é without it), and a rename as its two paths.
assert.match(guardFailures({ ...okGuard, numstat: '1\t0\t.github/workflows/deploy-é.yml\0' }, limits)[0]?.text || '', /deploy-é\.yml/, 'numstat -z: a path git would quote');
assert.match(guardFailures({ ...okGuard, numstat: '0\t0\t\0ci.yml\0.github/workflows/ci.yml\0' }, limits)[0]?.text || '', /Paths that need a person/, 'numstat -z: a rename');
assert.deepEqual(guardFailures({ ...okGuard, numstat: '3\t1\tsrc/a.js\0' }, limits), [], 'numstat -z: a plain change');
assert.match(guardFailures({ ...okGuard, diff: `++const t = 'ghp_${'a'.repeat(36)}';\n` }, limits)[0]?.text || '', /a GitHub token/, "a merge's own line (--cc)");
assert.match(guardFailures({ ...okGuard, diff: '++DB_PASSWORD=s3cretvalue\n' }, limits)[0]?.text || '', /password or secret/, 'without its two markers, for anchored patterns');
const { hostOf } = await import('./git.mjs');
assert.deepEqual(['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@example.invalid/o/r.git', '/srv/o/r.git'].map(hostOf), ['github.com', 'github.com', 'example.invalid', '']);
for (const [line, what] of [['-----BEGIN RSA PRIVATE KEY-----', 'a private key'], ['key = "AKIAABCDEFGHIJKLMNOP"', 'an AWS access key'],
  [`token: ghp_${'a'.repeat(36)}`, 'a GitHub token'], ['password = "hunter22"', 'a password or secret'], ['DB_PASSWORD=s3cretvalue', 'a password or secret']]) {
  assert.match(guardFailures({ ...okGuard, diff: `+${line}\n` }, limits)[0].text, new RegExp(what), `secret scan: ${what}`);
}
for (const line of ['password = getPassword()', 'const secret = process.env.SECRET', 'PASSWORD=${DB_PASSWORD}', '-password = "removed"']) {
  assert.deepEqual(guardFailures({ ...okGuard, diff: `+${line}\n`.replace('+-', '-') }, limits), [], `not a secret: ${line}`);
}
assert.ok(SECRET_PATTERNS.length >= 10);

// ---- Drafts: the Reviewer treats them as if they weren't there ----
const { loadConfig, saveConfig, CONFIG_PATH } = await import('./config.mjs');
const { createReviewer } = await import('./reviewer/reviewer.mjs');
const rvTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-'));
const prOf = (n, extra = {}) => ({ url: `https://github.com/octo-org/r${n}/pull/${n}`, title: `PR ${n}`, number: n, repo: `octo-org/r${n}`, author: 'teammate', draft: false, ...extra });
/** A Reviewer with fake GitHub and board: `open` are the ticket's open PRs; resolves with what it claimed, started and logged. */
async function reviewOnce(open, { runs = [], cfgOver = {}, me = 'octocat', switchOffAt = '', retagFails = 0 } = {}) {
  const cfg = { ...loadConfig(), githubOwner: 'octo-org', workDir: rvTmp, ...cfgOver };
  const seen = { claims: [], retags: [], started: [], logs: [] };
  const ticket = { key: 'AB#42', title: 'Thing', url: 'https://dev.azure.com/o/Shop/_workitems/edit/42', tags: ['Ready for Review'], rev: 3, ref: { org: 'https://dev.azure.com/o', project: 'Shop', id: 42 } };
  const app = { cfg, me, on: true, sideOn() { return this.on; }, tracker: () => tracker, boards: () => [{ project: 'Shop', team: 'Web' }], dryRun: () => false };
  const tracker = {
    name: 'Azure DevOps', boardLabel: b => `${b.project} / ${b.team}`,
    findTickets: async () => ({ tickets: [ticket], variants: ['Ready for Review'] }),
    claim: async (c, t, drop, add) => { seen.claims.push(add); if (switchOffAt === 'claim') app.on = false; },
    retag: async (c, ref, drop, add) => { if (retagFails-- > 0) throw new Error('503 Service Unavailable'); seen.retags.push(add); },
    ticketText: async () => '',
  };
  const gh = { me: async () => me, openPrs: async () => open, headSha: async pr => `sha${pr.number}`, cloneMissing: async () => [], postComment: async () => '', humanApproved: async () => false };
  const side = createReviewer(app, { log: (level, msg) => { seen.logs.push(msg); return true; }, forget() {}, hoot() {}, appDir, trackers: { ado: tracker }, github: gh });
  side.state = { runs: structuredClone(runs), failures: {} };
  side.startReview = (c, dir, opts) => {
    seen.started.push(opts);
    const run = { id: `AB42-r${(opts.prior?.reviewNo || 0) + 1}`, ticket: 'AB#42', prs: opts.prs, reviewNo: (opts.prior?.reviewNo || 0) + 1, status: 'running', startedAt: Date.now(), logPath: path.join(rvTmp, 'x.ndjson'), ticketUrl: ticket.url };
    opts.prompt = buildPrompt({ ...run, title: 'Thing', reportPath: '/r/x.md', contextPrs: opts.approvedPrs, leftOut: opts.leftOut, prior: opts.prior, priorReport: 'F-01 [HIGH] old' });
    return run;
  };
  await side.poll();
  seen.side = side;
  return seen;
}
const doneRun = (prs, extra = {}) => ({ ticket: 'AB#42', status: 'done', reviewNo: 1, endedAt: 1, prs, contextPrs: [], approved: {}, reviewedHeads: Object.fromEntries(prs.map(p => [p.url, `old${p.number}`])), reportPath: '/nowhere.md', ...extra });
let seen = await reviewOnce([prOf(1), prOf(2, { draft: true })]);
assert.deepEqual(seen.started[0].prs.map(p => p.number), [1], 'a mixed ticket: only the ready PR is reviewed');
assert.ok(!seen.started[0].approvedPrs.length && !seen.started[0].leftOut.length, 'the draft is not context');
assert.ok(!seen.logs.some(l => l.includes('r2') || l.includes('#2')), 'the draft is not named in the Log');
seen = await reviewOnce([prOf(2, { draft: true }), prOf(3, { draft: true })]);
assert.deepEqual([seen.claims, seen.started], [[], []], 'all drafts: waits, tagged and unclaimed');
assert.match(seen.logs.at(-1), /no open, ready PR mentions AB#42 yet/);
seen = await reviewOnce([prOf(1), prOf(4, { draft: true, author: 'octocat' })]);
assert.equal(seen.started.length, 1, 'your own draft no longer makes the ticket yours');
seen = await reviewOnce([prOf(1), prOf(2, { draft: true })], { runs: [doneRun([prOf(1), prOf(2)])] });
assert.deepEqual(seen.started[0].leftOut.map(p => p.number), [2], 'back to draft: left out, its findings untouched');
const leftPrompt = seen.started[0].prompt;
assert.ok(leftPrompt.includes('## Left out of this review') && leftPrompt.includes(`- ${prOf(2).url}`) && !leftPrompt.split('\n')[0].includes(prOf(2).url));
assert.ok(leftPrompt.includes("without re-verifying, replying on or resolving them"));
seen = await reviewOnce([prOf(1), prOf(3)], { runs: [doneRun([prOf(1)])], cfgOver: { maxReviewRounds: 1 } });
assert.deepEqual(seen.started[0].prs.map(p => p.number), [3], 'ready again past the cap: the PR no review covered gets its first review');
assert.deepEqual(seen.started[0].leftOut.map(p => p.number), [1]);
seen = await reviewOnce([prOf(1)], { runs: [doneRun([prOf(1)])], cfgOver: { maxReviewRounds: 1 } });
assert.deepEqual(seen.claims, [], 'every PR covered, at the cap: left for a person');
seen = await reviewOnce([prOf(1), prOf(2)], { runs: [doneRun([prOf(1)], { leftOut: [prOf(2)], approved: {} })] });
assert.deepEqual(seen.started[0].prs.map(p => p.number), [1, 2], 'marked ready again: a re-tag reviews it');
seen = await reviewOnce([prOf(1)], { switchOffAt: 'claim' });
assert.deepEqual([seen.claims, seen.retags, seen.started], [['In Review'], ['Ready for Review'], []], 'switched off as it claimed: the trigger tag is put back');
seen = await reviewOnce([prOf(1)], { switchOffAt: 'claim', retagFails: 1 });
assert.deepEqual([seen.retags, seen.side.state.releases.length], [[], 1], "a release the tracker refused is kept");
seen.side.state.releases[0]._tagRetryAt = 0;
seen.side.tick();
await new Promise(r => setTimeout(r, 0));
seen.side.tick();
assert.deepEqual([seen.retags, seen.side.state.releases.length], [['Ready for Review'], 0], 'and retried until the trigger tag is back'); 
{
  // Settled at launch (or by --once) before any poll has read your GitHub login: the posted review is still found.
  const report = path.join(rvTmp, 'report.md');
  fs.writeFileSync(report, '---\nverdict: approve\n---\n');
  const app = { cfg: { ...loadConfig(), githubOwner: 'octo-org' }, me: '', sideOn: () => true, tracker: () => ({}), boards: () => [], dryRun: () => false };
  const gh = { me: async () => 'octocat', reviewedSince: async (pr, me) => me === 'octocat', isOpen: async () => true };
  const side = createReviewer(app, { log: () => true, forget() {}, hoot() {}, appDir, trackers: {}, github: gh });
  const run = { id: 'AB42-r1', ticket: 'AB#42', status: 'running', reviewNo: 1, prs: [prOf(1)], startedAt: 1, marker: postMarker('AB42-r1'), reportPath: report, _result: { subtype: 'success', is_error: false, total_cost_usd: 1 } };
  side.state = { runs: [run], failures: {} };
  await side.finish(run);
  assert.deepEqual([run.status, app.me], ['done', 'octocat'], 'a settle before the first poll reads your login first');
}
fs.rmSync(rvTmp, { recursive: true });

// prThreads reads every page of a PR's review threads (READY TO MERGE needs them all), through a fake gh on PATH.
if (process.platform !== 'win32') {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-gh-'));
  const page = (id, next) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: Boolean(next), endCursor: next },
    nodes: [{ id, isResolved: false, path: 'a.js', line: 1, first: { nodes: [{ databaseId: 1, author: { login: 'lead' }, body: 'x', url: 'u' }] }, last: { nodes: [] } }] } } } } });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$*" in *after=c1*) echo '${page('T2', null)}';; *) echo '${page('T1', 'c1')}';; esac\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  try {
    assert.deepEqual((await prThreads({ repo: 'octo-org/web', number: 1 })).map(t => t.id), ['T1', 'T2'], 'every page of review threads');
  } finally {
    process.env.PATH = before;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

// ---- The two sides: neither imports the other; the shell keeps one's errors from the other ----
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const importsOf = dir => fs.readdirSync(path.join(srcDir, dir)).filter(f => f.endsWith('.mjs')).flatMap(f => [...fs.readFileSync(path.join(srcDir, dir, f), 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map(m => m[1]));
assert.ok(!importsOf('reviewer').some(i => i.includes('builder')), "the Reviewer doesn't import the Builder");
assert.ok(!importsOf('builder').some(i => i.includes('reviewer')), "the Builder doesn't import the Reviewer");
const { createShell } = await import('./shell.mjs');
const fakeSide = (name, fail) => ({ name, polls: 0, ticks: 0, paused: false, polling: false, nextPoll: 0, lastError: '',
  async poll() { this.polls++; if (fail) throw new Error(`${name} broke`); }, tick() { this.ticks++; if (fail) throw new Error(`${name} tick broke`); } });
let clockNow = 1_000_000;
const shellLogs = [];
const shellApp = { cfg: loadConfig(), sideOn: n => Boolean(shellApp.cfg[n]?.enabled) };
const [r1, b1] = [fakeSide('reviewer', true), fakeSide('builder', false)];
shellApp.cfg.builder.enabled = true;
const shell = createShell(shellApp, [r1, b1], { log: (s, level, msg) => { shellLogs.push([s, level, msg]); return true; }, reload: () => {}, now: () => clockNow });
shell.tick();
await new Promise(r => setTimeout(r, 0));
assert.deepEqual([r1.polls, b1.polls, r1.ticks, b1.ticks], [1, 1, 1, 1], "one side's error doesn't stop the other");
assert.ok(shellLogs.some(([s, level, msg]) => s === 'reviewer' && level === 'error' && msg === 'reviewer broke'), 'logged on its own side');
assert.ok(r1.lastError && !b1.lastError);
// Both off: idle, and it says so; a switch turned on in config.json is picked up at the next poll interval.
saveConfig({ ...loadConfig(), reviewer: { enabled: false }, builder: { ...loadConfig().builder, enabled: false } });
const offApp = { cfg: loadConfig(), sideOn: n => Boolean(offApp.cfg[n]?.enabled) };
const [r2, b2] = [fakeSide('reviewer'), fakeSide('builder')];
const offLogs = [];
const offShell = createShell(offApp, [r2, b2], { log: (s, level, msg) => { offLogs.push(msg); return true; }, reload: () => { offApp.cfg = loadConfig(); }, now: () => clockNow });
offShell.tick();
assert.deepEqual([r2.polls, b2.polls], [0, 0], 'both off: nothing polls');
assert.ok(offLogs.some(m => /Both sides are off/.test(m)));
const onFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
onFile.builder.enabled = true;
fs.writeFileSync(CONFIG_PATH, JSON.stringify(onFile));
offShell.tick();
assert.equal(b2.polls, 0, 'not before the poll interval');
clockNow += offApp.cfg.pollSeconds * 1000;
offShell.tick();
await new Promise(r => setTimeout(r, 0));
assert.deepEqual([r2.polls, b2.polls], [0, 1], 'the file is re-read with both sides off, and the Builder comes on');
saveConfig({ ...loadConfig(), reviewer: { enabled: true }, builder: { ...loadConfig().builder, enabled: false } });

// ---- The TUI: two tabs at 80 columns, and each switch from the keyboard ----
const { startTui } = await import('./tui.mjs');
const tuiApp = {
  cfg: loadConfig(), me: 'octocat', log: [], notes: null, override: {}, sideOn: n => tuiApp.override[n] ?? Boolean(tuiApp.cfg[n]?.enabled),
  tracker: () => ({ name: 'Azure DevOps', boardLabel: b => `${b.project} / ${b.team}` }), boards: () => [{ project: 'Shop', team: 'Web' }], dryRun: () => false, hasToken: () => false, speech: () => null,
};
const mkSide = (extra) => ({ paused: false, polling: false, nextPoll: Date.now() + 60_000, lastError: '', running: () => [], needs: () => [], ...extra });
const tuiSides = {
  reviewer: mkSide({ state: { runs: [], fixes: [{ id: 'f1', kind: 'Fix my PRs', ticket: 'PROJ-123', tracker: 'jira', ref: { site: 'https://example.atlassian.net', key: 'PROJ-123' }, title: 'Old fix', pr: prOf(5), round: 1, status: 'stopped', note: 'Fix my PRs was removed', endedAt: 5, replies: [] }] }, finished: () => [], tagVariants: {} }),
  builder: mkSide({
    history: () => [{ uid: 'u1', key: 'AB#123', title: 'Add saving to the shop', status: 'following', prs: [prOf(6), prOf(7)], costUsd: 4.2, updatedAt: 9, briefDir: '/b', url: 'https://dev.azure.com/o/Shop/_workitems/edit/123', ready: true }],
    needs: () => [{ id: 'n1', ticket: 'AB#124', kind: 'question', question: 'Keep the old cart format?', context: [], options: ['Yes', 'No'], recommended: 'Yes', createdAt: 9 }],
  }),
};
const toggled = [];
const tui = startTui(tuiApp, {
  sides: tuiSides, pollNow() {}, togglePause() {}, saveConfig() {}, saveToken: () => '', quit() {},
  toggleSide: n => { const now = !tuiApp.sideOn(n); tuiApp.cfg[n].enabled = now; delete tuiApp.override[n]; toggled.push([n, now]); return now; },
}, { headless: true });
const fits = (frame, what) => { for (const l of frame) assert.ok(l.length <= 80, `${what}: ${JSON.stringify(l)} is ${l.length} columns`); return frame.join('\n'); };
let frame = fits(tui.frame(80, 30), 'Reviewer');
assert.ok(/Reviewer · on/.test(frame) && /Builder · off/.test(frame), 'both tabs, each with its switch');
tui.key('2');
frame = fits(tui.frame(80, 30), 'Reviewer History');
assert.ok(frame.includes('FIX MY PRS') && frame.includes('PROJ-123'), "past fixes stay readable in the Reviewer's History");
tui.key('tab');
assert.ok(fits(tui.frame(80, 30), 'Builder Running').includes('The Builder is off'), 'each side keeps its own view');
tui.key('2');
frame = fits(tui.frame(80, 30), 'Builder');
assert.ok(frame.includes('READY TO MERGE') && frame.includes('AB#123'), "the Builder's History");
assert.ok(/Builder · off · ⚑ 1/.test(frame), 'the Needs-you count on its tab');
tui.key('4');
frame = fits(tui.frame(80, 30), 'Builder Config, off');
assert.ok(!frame.includes('Max parallel builds') && frame.includes('own settings show here once it is on'), "the Builder's rows are hidden while it's off");
tui.key('e');
frame = fits(tui.frame(80, 60), 'Builder Config, on');
assert.ok(frame.includes('Max parallel builds') && /BUILDER/.test(frame) && /SHARED/.test(frame));
assert.ok(frame.indexOf('Builder ') < frame.indexOf('SHARED') && frame.indexOf('SHARED') < frame.indexOf('Max parallel builds'), 'the switch, then Shared, then its own');
tui.key('e');
tui.key('R');
tui.key('e');
assert.deepEqual(toggled, [['builder', true], ['builder', false], ['reviewer', false]], 'e toggles the side in view');
frame = fits(tui.frame(80, 30), 'both off');
assert.ok(/Reviewer · off/.test(frame) && /Builder · off/.test(frame) && frame.includes('Reviewer off'), 'both off');
tuiApp.override = { builder: true };
assert.ok(fits(tui.frame(80, 30), 'override').includes('Builder · on'), '--builder-only overrides the switch for this launch');

// ---- Fix my PRs removed: the first-launch migration ----
const { migrateFixes, needsMigration } = await import('./migrate.mjs');
const { hash } = await import('./update.mjs');
const migHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-'));
fs.mkdirSync(path.join(migHome, 'config'));
const migWt = path.join(migHome, 'projects', '.prowl-worktrees', 'api-12');
fs.mkdirSync(migWt, { recursive: true });
const jiraRef = { site: 'https://example.atlassian.net', key: 'PROJ-123' };
const migState = () => ({ runs: [], failures: {}, loops: { 'PROJ-123': {} }, needs: [{ id: 'x' }],
  fixes: [{ id: 'fix-1', ticket: 'PROJ-123', tracker: 'jira', ref: structuredClone(jiraRef), pr: { repo: 'octo-org/api', number: 12, url: 'https://github.com/octo-org/api/pull/12' }, status: 'fixing', pid: 4242, worktree: migWt, pushedSha: null },
    { id: 'fix-0', ticket: 'PROJ-123', tracker: 'jira', ref: structuredClone(jiraRef), pr: { repo: 'octo-org/api', number: 12 }, status: 'done', pushedSha: 'abc1234' }] });
const migCfg = () => ({ workDir: path.join(migHome, 'projects'), fix: { enabled: true, from: 'prowl', mcpAllow: ['mcp__docs__search'], maxRounds: 2 } });
const removed = [];
const deps = (stopped, saved) => ({ home: migHome, saveConfig: c => saved.push(structuredClone(c)), saveState: () => {}, isRunning: f => f.pid === 4242, stop: async () => stopped,
  remove: async (clone, wt) => { removed.push([clone, wt]); fs.rmSync(wt, { recursive: true, force: true }); } });
// An exit that can't be confirmed: the fix keeps its status, pid and worktree, and the next launch tries again.
let st = migState();
let mc = migCfg();
let saved = [];
await migrateFixes(mc, st, deps(false, saved));
assert.deepEqual([st.fixes[0].status, st.fixes[0].pid, fs.existsSync(migWt)], ['fixing', 4242, true], 'unconfirmed exit: kept for the next launch');
assert.ok(needsMigration(mc, st, migHome), 'and the migration runs again');
st = migState();
st.fixes[0].status = 'stopped'; // 2.11.3's take-over: signalled, and marked stopped at once
await migrateFixes(migCfg(), st, deps(false, []));
assert.ok(fs.existsSync(migWt), 'taken over but still running: its worktree stays');
st = migState();
st.fixes[1].worktree = migWt; // an older, finished fix on the same PR, with the same worktree path
await migrateFixes(migCfg(), st, deps(false, []));
assert.ok(fs.existsSync(migWt), "an older record doesn't remove a live session's worktree");
// Confirmed: marked stopped, nothing pushed, its worktree removed; the settings moved to the backup.
st = migState();
mc = migCfg();
saved = [];
fs.writeFileSync(path.join(migHome, 'config', 'fix.md'), 'default rules');
fs.writeFileSync(path.join(migHome, 'seen.json'), JSON.stringify({ version: '2.11.3', defaults: { 'fix.md': hash('default rules'), 'review.md': 'h' } }));
const migNotes = await migrateFixes(mc, st, deps(true, saved));
assert.deepEqual([st.fixes[0].status, st.fixes[0].pushedSha], ['stopped', null], 'a running fix stopped, with nothing pushed');
assert.ok(!fs.existsSync(migWt) && removed.some(([, wt]) => wt === migWt), 'its worktree removed');
assert.deepEqual(st.fixes[0].ref, jiraRef, 'a Jira ref survives');
assert.ok(st.fixes.every(f => f.kind === 'Fix my PRs') && !st.loops && !st.needs, 'past fixes kept for History; loops and Needs you items gone');
assert.ok(!('fix' in mc) && !('fix' in saved.at(-1)), 'the fix.* settings left config.json');
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(migHome, 'config.fix-backup.json'), 'utf8')).fix.mcpAllow, ['mcp__docs__search'], 'and are in config.fix-backup.json, fix.mcpAllow included');
assert.ok(!fs.existsSync(path.join(migHome, 'config', 'fix.md')), 'an unedited fix.md is deleted');
assert.ok(!('fix.md' in JSON.parse(fs.readFileSync(path.join(migHome, 'seen.json'), 'utf8')).defaults));
assert.ok(migNotes.some(n => /Stopped 1 Fix my PRs session/.test(n.text)) && migNotes.some(n => /config\.fix-backup\.json/.test(n.text)), 'the Update Notes say what happened');
assert.ok(!needsMigration(mc, st, migHome), 'done: nothing left to migrate');
// An edited fix.md is kept.
fs.writeFileSync(path.join(migHome, 'config', 'fix.md'), 'my own rules');
fs.writeFileSync(path.join(migHome, 'seen.json'), JSON.stringify({ defaults: { 'fix.md': hash('default rules') } }));
assert.ok((await migrateFixes({ workDir: migHome }, { runs: [] }, deps(true, []))).some(n => /edited fix\.md/.test(n.text)) && fs.existsSync(path.join(migHome, 'config', 'fix.md')));
fs.rmSync(migHome, { recursive: true });

await (await import('./builder/self-test.mjs')).run(assert);

console.log(`self-test passed: ${count} asserts`);
