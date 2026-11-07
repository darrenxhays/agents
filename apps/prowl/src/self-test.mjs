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
import { changelog, hash, newer, syncConfigFiles } from './update.mjs';
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

// With every setting at its default, the prompt is byte for byte the golden copy (captured from 2.7.0; in 2.20.0 the
// prior findings moved to the skill, taken from the PRs' open Prowl threads on every review).
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
assert.ok(buildPrompt({ ...promptCases.reReview, parkHumanOnly: true }).includes('\n2. Park a prior finding'), 'numbered after the prior-finding step');
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
put(defs, 'extra.md', 'a1');
let notes = syncConfigFiles(defs, mine, synced, true);
assert.equal(get(mine, 'review.md'), 'r2', 'an unedited copy moves to the new default');
assert.equal(get(mine, 'extra.md'), 'a1', 'a new config file is copied in');
assert.deepEqual(notes.map(n => n.text), ['extra.md added to your config folder', "review.md updated to the new default (you hadn't edited it)"]);
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
// The axis catalog, folded into the skill: an unedited copy goes quietly, an edited one is kept as .old.
put(mine, 'review-axis-catalog.md', 'a1');
synced['review-axis-catalog.md'] = hash('a1');
assert.deepEqual(syncConfigFiles(defs, mine, synced, true), [], 'an unedited retired file goes quietly');
assert.ok(!fs.existsSync(path.join(mine, 'review-axis-catalog.md')) && !('review-axis-catalog.md' in synced));
put(mine, 'axis-catalog.md', 'my axes');
synced['axis-catalog.md'] = hash('a1');
notes = syncConfigFiles(defs, mine, synced, true);
assert.equal(get(mine, 'axis-catalog.md.old'), 'my axes', 'an edited retired file is kept as .old');
assert.ok(!fs.existsSync(path.join(mine, 'axis-catalog.md')) && !('axis-catalog.md' in synced));
assert.match(notes[0].text, /^axis-catalog\.md is no longer a config file.*What to look for in review\.md$/);
assert.deepEqual(syncConfigFiles(defs, mine, synced, true), [], 'announced once');
put(mine, 'work.md', 'my build rules');
synced['work.md'] = hash('w1');
notes = syncConfigFiles(defs, mine, synced, true);
assert.equal(get(mine, 'build.md'), 'my build rules', 'a renamed file keeps the edited copy');
assert.ok(!fs.existsSync(path.join(mine, 'work.md')) && !('work.md' in synced) && synced['build.md'] === hash('w1'));
assert.deepEqual(notes.map(n => n.text), ['work.md is now build.md']);
fs.rmSync(cfgTmp, { recursive: true });
// prowl-build's config defaults are synced into the same folder, so no file name may be in both skills' defaults.
const skillCfg = skill => fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', skill, 'config'));
assert.deepEqual(skillCfg('prowl-build').filter(f => skillCfg('prowl-review').includes(f)), [], 'config file names are unique across skills');
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
for (const [mood, busy] of [['idle', 0], ['poll', 0], ['review', 1], ['review', 3], ['review', 6], ['cheer', 0], ['sleep', 0], ['error', 0]]) {
  for (let i = 0; i < 200; i++) {
    const rows = owl.render(i % 2 ? 50 : 12, 7, mood, i % 3 ? '' : 'Done reviewing PRs for Slice 11 Documents in the client profile, marking as Reviewed', true, busy);
    assert.equal(rows.length, 7);
    for (const row of rows) assert.equal(row.reduce((n, [, text]) => n + text.length, 0), i % 2 ? 50 : 12, `${mood} row width`);
  }
}
// Hoot keeps to the left quarter, whatever he's doing, and what he does follows how much is running.
for (const [mood, busy, doing] of [['sleep', 0, 'sleep'], ['idle', 0, 'idle'], ['poll', 0, 'poll'], ['review', 1, 'read'], ['review', 2, 'juggle'], ['review', 4, 'juggle'], ['review', 5, 'type'], ['cheer', 0, 'cheer'], ['error', 0, 'error']]) {
  const hoot = createMascot();
  for (let i = 0; i < 300; i++) {
    const rows = hoot.render(120, 7, mood, '', true, busy);
    const at = hoot.at(120);
    assert.ok(at.x >= 0 && at.x + 7 + (doing === 'type' ? 8 : 0) <= at.zone && at.zone === 30, `${mood} ${busy}: in his quarter (x ${at.x})`);
    const owlCols = rows.slice(2, 6).flatMap(r => { let c = 0; return r.flatMap(([, t]) => [...t].map(ch => [c++, ch])); }).filter(([, ch]) => '(,)'.includes(ch)).map(([c]) => c);
    assert.ok(Math.max(...owlCols) < 30 + 1, `${mood}: drawn in his quarter`);
  }
  assert.equal(hoot.at(120).doing, doing, `${mood} with ${busy} running: ${doing}`);
}
// He stays on his spot whatever he's doing, and his ground ends where his patch does.
for (const [mood, busy] of [['idle', 0], ['poll', 0], ['review', 1], ['review', 3], ['cheer', 0], ['sleep', 0]]) {
  const hoot = createMascot();
  const spots = new Set();
  let rows;
  for (let i = 0; i < 200; i++) { rows = hoot.render(100, 7, mood, '', true, busy, 30); spots.add(hoot.at(100, 30).x); }
  assert.equal(spots.size, 1, `${mood} ${busy}: stays put`);
  const ground = rows[6].map(([, t]) => t).join('');
  assert.ok(ground.slice(0, 30).trim().length === 30 && !ground.slice(30).trim(), `${mood}: ground across his patch only`);
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
// A cd can fail: then the shell is where it was, for any command not joined to the cd by &&.
assert.deepEqual([fromHome(`cd ${wt}; rm -rf web`), fromHome(`sh -c 'cd ${wt}; rm -rf web'`), fromHome(`cd ${wt} && rm -rf web`), bash('cd sub; rm -rf build')],
  ['deny', 'deny', 'allow', 'allow'], 'after a cd that may have failed');
assert.deepEqual([fromHome(`cd ${wt}; out=$(rm -rf web 2>&1)`), fromHome(`cd ${wt}; sh -c 'rm -rf web'`), fromHome(`cd ${wt} &&\nprintf 'ok' > notes.txt`)],
  ['deny', 'deny', 'allow'], "nested checks too; a line break after && keeps the join");
// Brace expansion: each word it makes is a target. An alias is looked up wherever a failed cd may have left the shell.
assert.deepEqual([bash('rm -rf {dist,../../../etc/dist}'), bash('rm -rf {dist,build}'), bash('rm -rf x{1..3}'), bash("rm -rf '{dist,/etc/x}'"), bash('cp /etc/hosts{,.bak}'), bash('cp a{,.bak}')],
  ['deny', 'allow', 'deny', 'allow', 'deny', 'allow'], 'brace expansion, before cp picks its destination');
const chain = { pf: 'p --force', p: 'push', sh2: '!git pf origin', sh3: '!git -C web pf origin HEAD:main', ok: 'st', st: 'status', loop: 'loop' };
const viaChain = command => fenceDecision({ cwd: wt, tool_name: 'Bash', tool_input: { command } }, workEnv, n => chain[n] || '')?.hookSpecificOutput.permissionDecision || 'allow';
assert.deepEqual(['git pf origin HEAD:main', 'git sh2', 'git sh3', 'git ok', 'git loop'].map(viaChain), ['deny', 'deny', 'deny', 'allow', 'deny'], 'an alias that calls a pushing alias');
assert.deepEqual([bash('cp /etc/config{1..2}.json'), bash('env -S cp /etc/hosts{,.bak}'), bash('env -S cp /etc/config{1..2}.json')], ['deny', 'deny', 'deny'], "brace operands cp's destination may come from");
// An alias gets the call's arguments; a shell alias runs from the repository's top folder.
const deploy = { deploy: 'subtree --prefix=dist', cleanup: '!rm -rf dist' };
const viaRepo = (command, root) => fenceDecision({ cwd: path.join(wt, 'src'), tool_name: 'Bash', tool_input: { command } }, workEnv,
  Object.assign(n => deploy[n] || '', { root: () => root }))?.hookSpecificOutput.permissionDecision || 'allow';
assert.deepEqual([viaRepo('git deploy push origin gh-pages', wt), viaRepo('git deploy split', wt), viaRepo('git cleanup', wt), viaRepo('git cleanup', '')],
  ['deny', 'allow', 'allow', 'deny'], "an alias's arguments; a shell alias runs from the repository's top folder (unknown: denied)");
assert.equal(bash("git -c 'alias.deploy=subtree --prefix=dist' deploy push origin gh-pages"), 'deny', 'an alias the call sets itself with -c');
assert.equal(bash("git -c 'alias.release=deploy' -c 'alias.deploy=subtree --prefix=dist' release push origin gh-pages"), 'deny', 'and one that calls another it sets');
assert.equal(fenceDecision({ cwd: wt, tool_name: 'Bash', tool_input: { command: "git -c 'alias.go=!git deploy' -c 'alias.deploy=subtree --prefix=dist' go push origin x" } }, workEnv,
  Object.assign(() => '', { root: () => wt }))?.hookSpecificOutput.permissionDecision, 'deny', "even through a shell alias's git");
assert.deepEqual([bash('cp --target-directory=/etc "$TMPDIR/generated.json"'), bash('cp -t/etc "$TMPDIR/x"')], ['deny', 'deny'], "cp's -t folder beside a variable source");
const shipHere = (name, dir) => (name === 'ship' && dir === wt ? 'push --force' : '');
assert.equal(fenceDecision({ cwd: wt, tool_name: 'Bash', tool_input: { command: `cd ${other}; git ship origin HEAD:main` } }, workEnv, shipHere)?.hookSpecificOutput.permissionDecision, 'deny', 'an alias where a failed cd left the shell');
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
assert.equal(fill(template(outputMd, 'Quick review started'), { prs: '[api#5](u5), [web#7](u7)' }), "🦉 **PR-Owl** is reviewing [api#5](u5), [web#7](u7). Its review lands on each PR when it's done.", 'Quick review started');
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
const { loadConfig, parseJsonc, saveConfig, CONFIG_PATH } = await import('./config.mjs');
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
{
  // A quick review (n): the PRs typed in, reviewed together with no ticket, and no tag ever written.
  const { parsePrRefs } = await import('./github.mjs');
  assert.deepEqual(parsePrRefs(' https://github.com/octo-org/api/pull/5/files, octo-org/web#7\nOcto-Org/API#5 '),
    [{ repo: 'octo-org/api', number: 5 }, { repo: 'octo-org/web', number: 7 }], 'links and owner/repo#n, by spaces, commas or lines, each once');
  assert.match(parsePrRefs(''), /at least one PR/);
  assert.match(parsePrRefs('octo-org/api#5 #7'), /#7 isn't a PR/);
  assert.match(parsePrRefs('https://github.com/octo-org/api/issues/5'), /isn't a PR/);
  const states = { 1: 'open', 2: 'open', 3: 'merged' };
  const logs = [];
  const retags = [];
  const app = { cfg: { ...loadConfig(), githubOwner: 'octo-org', workDir: rvTmp, quickName: 'number', quickLabels: false }, me: '', on: true, sideOn() { return this.on; }, tracker: () => ({}), boards: () => [], dryRun: () => false };
  const gh = { me: async () => 'octocat', prByRef: async ({ number }) => prOf(number, { state: states[number] }), headSha: async pr => `sha${pr.number}`, cloneMissing: async () => [],
    reviewedSince: async () => true, isOpen: async () => true, postComment: async (pr, file) => comments.push([pr.number, JSON.parse(fs.readFileSync(file, 'utf8')).body]) };
  const comments = [];
  const side = createReviewer(app, { log: (level, msg) => { logs.push(msg); return true; }, forget() {}, hoot() {}, appDir, trackers: { ado: { retag: async (...a) => retags.push(a) } }, github: gh });
  side.state = { runs: [{ ticket: 'QUICK#4', quick: true, status: 'done', endedAt: 1, prs: [] }], failures: {} };
  let opts;
  side.startReview = (c, dir, o) => {
    opts = o;
    return { id: 'QUICK5-r1', tracker: null, ticket: o.ticket.key, title: o.ticket.title, prs: o.prs, reviewNo: 1, status: 'running', quick: o.quick, startedAt: Date.now(), marker: postMarker('QUICK5-r1'),
      reportPath: path.join(rvTmp, 'quick.md'), logPath: path.join(rvTmp, 'quick.ndjson') };
  };
  const run = await side.quickReview('octo-org/r1#1 octo-org/r2#2');
  assert.deepEqual([run.ticket, opts.prs.map(p => p.number), opts.quick, opts.heads[prOf(2).url]], ['QUICK#5', [1, 2], true, 'sha2'], 'both PRs, as one set, numbered after the last quick review');
  assert.equal(opts.ticket.title, 'Quick review: r1#1, r2#2');
  const links = `[r1#1](${prOf(1).url}), [r2#2](${prOf(2).url})`;
  assert.deepEqual(comments.map(([n, body]) => [n, body.includes(`is reviewing ${links}.`), body.endsWith('<!-- prowl-review QUICK5-r1 started -->')]), [[1, true, true], [2, true, true]],
    'Quick review started on each PR, linking the PRs reviewed together');
  await assert.rejects(side.quickReview('octo-org/r3#3'), /r3#3 is merged/, 'only open PRs');
  app.cfg.maxConcurrentReviews = 1;
  await assert.rejects(side.quickReview('octo-org/r1#1'), /Max parallel reviews/, 'it waits for a free slot like any review');
  {
    // Asked for twice while the first is still cloning: the first holds the slot and its number.
    side.state.runs = side.state.runs.filter(r => r !== run);
    let release;
    gh.cloneMissing = () => new Promise(r => { release = r; });
    const first = side.quickReview('octo-org/r1#1');
    await assert.rejects(side.quickReview('octo-org/r2#2'), /Max parallel reviews/, 'a quick review being prepared holds its slot');
    await new Promise(r => setTimeout(r, 0));
    app.on = false; // switched off while it clones
    release([]);
    await assert.rejects(first, /switched off before the review started/, 'nothing starts once the Reviewer is off');
    app.on = true;
    gh.cloneMissing = async () => [];
    app.cfg.maxConcurrentReviews = 2;
    const [a, b] = await Promise.all([side.quickReview('octo-org/r1#1'), side.quickReview('octo-org/r2#2')]);
    assert.deepEqual([a.ticket, b.ticket], ['QUICK#7', 'QUICK#8'], 'two at once get their own numbers (a start turned down once named used one too; a merged PR, before naming, none)');
    side.state.runs = side.state.runs.filter(r => r !== a && r !== b);
    side.state.runs.push(run);
    app.cfg.maxConcurrentReviews = 1;
  }
  {
    // A ticket's review being prepared holds its slot too, so a quick review can't start in the meantime.
    side.state.runs = side.state.runs.filter(r => r !== run);
    let release;
    gh.openPrs = () => new Promise(r => { release = r; });
    app.boards = () => [{ project: 'Shop', team: 'Web' }];
    app.tracker = () => ({ name: 'Azure DevOps', boardLabel: () => 'Shop / Web', findTickets: async () => ({ tickets: [{ key: 'AB#9', title: 't' }], variants: ['Ready for Review'] }) });
    const polling = side.poll();
    await new Promise(r => setTimeout(r, 0));
    await assert.rejects(side.quickReview('octo-org/r1#1'), /Max parallel reviews/, "a ticket's review being prepared holds its slot");
    release([]);
    await polling;
    // Once started, a review holds one slot, not two, while its Review started comments are posted.
    app.cfg.maxConcurrentReviews = 2;
    let posting = true;
    gh.postComment = () => (posting ? new Promise(() => {}) : Promise.resolve()); // the first review's comment hangs
    const announcing = side.quickReview('octo-org/r1#1');
    await new Promise(r => setTimeout(r, 10));
    posting = false;
    const second = await side.quickReview('octo-org/r2#2').catch(e => e);
    assert.ok(!(second instanceof Error), `a started review counts once (${second.message || ''})`);
    const started = side.state.runs.find(r => r.prs?.[0]?.number === 1 && r.quick && r !== run);
    announcing.catch(() => {}); // left hanging on purpose
    side.state.runs = side.state.runs.filter(r => r !== started && r !== second);
    gh.postComment = async () => {};
    app.cfg.maxConcurrentReviews = 1;
    side.state.runs.push(run);
    // History's approval flag clears with no boards or GitHub org set up: a quick review needs neither.
    const url = prOf(1).url;
    const flagged = { id: 'q9', ticket: 'QUICK#9', quick: true, status: 'done', endedAt: Date.now(), prs: [prOf(1)], approved: { [url]: 'sha1' }, awaitingHuman: [url] };
    side.state.runs.push(flagged);
    gh.humanApproved = async () => true;
    app.boards = () => [];
    await side.poll();
    assert.deepEqual(flagged.awaitingHuman, [], 'cleared without boards');
    side.state.runs = side.state.runs.filter(r => r !== flagged);
  }
  app.on = false;
  await assert.rejects(side.quickReview('octo-org/r1#1'), /Reviewer is off/);
  run._result = { subtype: 'error_during_execution', is_error: true, result: 'boom' };
  await side.finish(run);
  assert.deepEqual([run.status, run.pendingTag, retags, side.state.failures], ['failed', null, [], {}], 'a failed quick review: no tag written, no retry');
  assert.match(logs.at(-1), /Not retried; n reviews PRs again/);
  const prompt = buildPrompt({ ...run, contextPrs: [], leftOut: [] });
  assert.ok(prompt.includes('No ticket: this is a quick review') && !prompt.includes('- Ticket:'), 'the brief says there is no ticket');
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
const onFile = parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8'));
onFile.builder.enabled = true;
fs.writeFileSync(CONFIG_PATH, JSON.stringify(onFile));
offShell.tick();
assert.equal(b2.polls, 0, 'not before the poll interval');
clockNow += offApp.cfg.pollSeconds * 1000;
offShell.tick();
await new Promise(r => setTimeout(r, 0));
assert.deepEqual([r2.polls, b2.polls], [0, 1], 'the file is re-read with both sides off, and the Builder comes on');
saveConfig({ ...loadConfig(), reviewer: { enabled: true }, builder: { ...loadConfig().builder, enabled: false } });

{
  // Before 2.13.0 the Builder had its own done and reviewing tags: they're dropped, for the Reviewer's trigger and in-progress tags.
  const file = parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8'));
  file.builder.tags = { ...file.builder.tags, done: 'Ready for QA', reviewing: 'In QA' };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(file));
  assert.deepEqual(Object.keys(loadConfig().builder.tags), ['start', 'inProgress']);
  assert.ok(!('done' in parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8')).builder.tags), 'and the file is rewritten without them');
}
{
  // config.json carries a comment above each setting, and still loads; 2.14.0 dropped builder.command.
  const file = parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8'));
  file.builder.command = '/my-build';
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(file));
  assert.ok(!('command' in loadConfig().builder));
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  assert.ok(!text.includes('/my-build') && /\n    \/\/ Model: "claude-opus-5-5"/.test(text) && /\/\/ MCP tools a build session may use.*e\.g\. \["mcp__/.test(text), 'rewritten with comments');
  assert.deepEqual(parseJsonc(text), JSON.parse(JSON.stringify(loadConfig())), 'the commented file holds every setting');
  // checks.json: seeded with commented examples, which parse to no checks, and to a check once uncommented.
  const { CHECKS_PATH, readChecks, seedChecks } = await import('./config.mjs');
  fs.mkdirSync(path.dirname(CHECKS_PATH), { recursive: true });
  fs.writeFileSync(CHECKS_PATH, '{}');
  seedChecks();
  const tpl = fs.readFileSync(CHECKS_PATH, 'utf8');
  assert.ok(tpl.includes('npx eslint') && tpl.includes('pytest'), 'the bare {} gets the examples');
  assert.deepEqual(readChecks(), {});
  fs.writeFileSync(CHECKS_PATH, tpl.replace(/^  \/\/ ("my-org\/web-\*")/m, '  $1').replace(/^  \/\/   ("setup": \["npm ci"\],|"run": \["npx eslint \."\])/gm, '    $1').replace(/^  \/\/ (\},)$/m, '  $1'));
  assert.deepEqual(readChecks(), { 'my-org/web-*': { setup: ['npm ci'], run: ['npx eslint .'] } }, 'an uncommented example parses, trailing comma and all');
  seedChecks();
  assert.notEqual(fs.readFileSync(CHECKS_PATH, 'utf8'), tpl, 'an edited checks.json is never overwritten');
  fs.rmSync(CHECKS_PATH);
}

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
    needs: () => builderNeeds,
  }),
};
let builderNeeds = [{ id: 'n1', ticket: 'AB#124', kind: 'question', question: 'Keep the old cart format?', context: [], options: ['Yes', 'No'], recommended: 'Yes', createdAt: 9 }];
const toggled = [];
const asked = [];
const tui = startTui(tuiApp, {
  sides: tuiSides, pollNow() {}, togglePause() {}, saveConfig() {}, saveToken: () => '', quit() {},
  quickReview: async (text, opts) => { asked.push([text, opts]); return { ticket: 'QUICK#1', prs: [prOf(5), prOf(7)] }; },
  quickBuild: async (text, opts) => { asked.push(['build', text, opts]); return { key: 'BUILD#1' }; },
  answerOffer: async (offer, choice) => { asked.push(['offer', offer.side, choice]); return choice === 'tag' ? ['AB#9'] : null; },
  stopWait: wt => asked.push(['stopWait', wt.key]),
  toggleSide: n => { const now = !tuiApp.sideOn(n); tuiApp.cfg[n].enabled = now; delete tuiApp.override[n]; toggled.push([n, now]); return now; },
}, { headless: true });
const fits = (frame, what) => { for (const l of frame) assert.ok(l.length <= 80, `${what}: ${JSON.stringify(l)} is ${l.length} columns`); return frame.join('\n'); };
let frame = fits(tui.frame(80, 30), 'Reviewer');
assert.ok(/Reviewer · on/.test(frame) && /Builder · off/.test(frame), 'an off Builder with something waiting on you keeps its tab');
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
const builderConfig = fits(tui.frame(80, 200), 'Config from the Builder');
const builderBars = [...tui.ui.bars];
const order = ['Prowl', 'Upkeep and display', 'Boards', 'GitHub and projects', 'Build tags', 'Review tags', 'All sessions', 'Quick reviews and builds', 'Reviewer · Files', 'Reviewer · Sessions', 'Reviewer · Caps',
  'Reviewer · Verdicts and rounds', 'Builder · Files', 'Builder · Sessions', 'Builder · Caps', 'Builder · Repos', 'Builder · Branches', 'Builder · Pushes and PRs', 'Builder · Pick-up', 'Builder · Follow-up'];
const cardLines = builderConfig.split('\n');
const headings = cardLines.map(l => /^ {2}╭─ (.+?) ─*╮$/.exec(l.trimEnd())?.[1]).filter(Boolean);
assert.deepEqual(headings, order, 'every setting of the app, each category in its own card');
assert.equal(cardLines.filter(l => /^ {2}╰─*╯$/.test(l.trimEnd())).length, order.length, 'each card closed');
assert.ok(cardLines.filter(l => /^ {2}│ .*│$/.test(l.trimEnd())).every(l => l.trimEnd().length === 79), 'each row inside its card, its right edge lined up');
assert.ok(builderConfig.includes('Max parallel builds') && builderConfig.includes('Max parallel reviews'), "the Builder's settings show while it is off");
const tagRows = ['Build start tag', 'Build in-progress tag', 'Review trigger tag', 'Review in-progress tag', 'Review done tag'];
assert.ok(tagRows.every((t, i) => !i || builderConfig.indexOf(tagRows[i - 1]) < builderConfig.indexOf(t)) && !/Done tag|Reviewing tag/.test(builderConfig), 'one set of tags, in the order a ticket meets them');
tui.key('tab');
tui.key('4');
const body = (f, [nav, own] = tui.ui.bars) => { const lines = f.split('\n'); return lines.slice(0, lines.length - nav - own).join('\n').slice(f.indexOf('Saved to')).trimEnd(); }; // without the bars, which follow the side
const builderBody = body(builderConfig, builderBars);
assert.equal(body(fits(tui.frame(80, 200), 'Config from the Reviewer')), builderBody, 'the same Config on both sides');
builderNeeds = [];
frame = fits(tui.frame(80, 30), 'Builder off, nothing waiting');
assert.ok(/Reviewer · on/.test(frame) && !/Builder · /.test(frame) && !frame.includes('tab side'), 'the Builder has no tab while it is off');
tui.key('B');
assert.ok(fits(tui.frame(80, 30), 'B').includes('turn it on in Config'), 'B says how to turn it on');
tui.key('down');
tui.key('down');
tui.key('enter'); // the Builder's switch, in Config
frame = fits(tui.frame(80, 30), 'Builder on');
assert.ok(/Builder · on/.test(frame), 'switched on in Config, it gets its tab');
tui.key('B');
tui.key('e');
frame = fits(tui.frame(80, 30), 'Builder off again');
assert.ok(/Reviewer · on/.test(frame) && !/Builder · /.test(frame), 'switched off with nothing left, its tab goes and the Reviewer is in view');
tui.key('e');
assert.deepEqual(toggled, [['builder', true], ['builder', false], ['reviewer', false]], 'enter on a switch, and e for the side in view');
frame = fits(tui.frame(80, 30), 'both off');
assert.ok(/Reviewer · off/.test(frame) && frame.includes('Reviewer off'), 'both off');
tui.key('n');
assert.ok(fits(tui.frame(80, 30), 'n while off').includes('The Reviewer is off'), 'n needs the Reviewer on');
tuiApp.override = { builder: true };
assert.ok(fits(tui.frame(80, 30), 'override').includes('Builder · on'), '--builder-only overrides the switch for this launch');
tuiApp.override = { reviewer: true };
tui.key('R');
tui.key('n');
frame = fits(tui.frame(80, 30), 'n');
assert.ok(frame.includes('Quick review: PRs reviewed together') && frame.includes('Running'), 'n asks for the PRs, on the Running view');
for (const k of 'nope') tui.key(k);
tui.key('enter');
assert.ok(fits(tui.frame(80, 30), 'n, bad').includes("nope isn't a PR"), 'a word that is not a PR is named');
for (let i = 0; i < 4; i++) tui.key('backspace');
for (const k of `https://github.com/octo-org/api/pull/5 octo-org/web#${'7'.repeat(60)}`) tui.key(k);
fits(tui.frame(80, 30), 'n, long input');
for (let i = 0; i < 59; i++) tui.key('backspace');
tui.key('enter');
await new Promise(r => setTimeout(r, 0));
assert.deepEqual(asked, [['https://github.com/octo-org/api/pull/5 octo-org/web#7', { name: '' }]], 'submitted as one review');
assert.ok(fits(tui.frame(80, 30), 'n, sent').includes('Reviewing 2 PRs together as QUICK#1'));
{
  // A paste opens the side's quick box, filled in; a paste of only tickets on a board gets an offer, which pops up.
  asked.length = 0;
  tui.ui.flashUntil = 0;
  tui.paste('octo-org/api#5\nAB#9');
  assert.ok(tui.ui.edit?.prs && tui.ui.edit.value === 'octo-org/api#5 AB#9', 'a paste on the Reviewer: the quick review box, on one line');
  tui.key('esc');
  tuiApp.offers.push({ side: 'reviewer', tickets: [{ key: 'AB#9', title: 'Thing' }], polled: false, boards: ['Shop / Web'], text: 'AB#9' });
  frame = fits(tui.frame(80, 30), 'offer');
  assert.ok(frame.includes('1  Add Shop / Web to the boards and tag it') && frame.includes('2  Review it now as a quick review') && frame.includes('3  Cancel'), 'the offer, with its choices');
  assert.ok(frame.includes("on Shop / Web, which the Reviewer doesn't poll yet"), 'saying where the ticket is');
  tui.key('1');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual([asked, tuiApp.offers.length], [[['offer', 'reviewer', 'add']], 0], 'a number takes its choice, and the offer goes');
  tuiApp.offers.push({ side: 'builder', tickets: [{ key: 'AB#9', title: 'Thing' }], polled: true, boards: [], text: 'AB#9' }, { side: 'reviewer', tickets: [{ key: 'AB#8', title: 'Other' }], polled: true, boards: [], text: 'AB#8' });
  tui.key('n');
  assert.ok(!tui.ui.edit, 'while an offer shows, keys go to it');
  frame = fits(tui.frame(80, 30), 'builder offer');
  assert.ok(frame.includes("1  Tag it 'Ready to Start'") && frame.includes('2  Build it now as a quick build'), "the Builder's offer: its own tag");
  tui.key('down');
  tui.key('enter');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(asked.at(-1), ['offer', 'builder', 'build'], '↑↓ and enter');
  tui.key('esc');
  assert.deepEqual([tuiApp.offers.length, asked.length], [0, 2], 'esc cancels the next one');
  // n on the Builder: a quick build, after a one-line y/n.
  tuiApp.override = { reviewer: true, builder: true };
  tui.key('B');
  tui.key('1');
  tui.key('n');
  frame = fits(tui.frame(80, 40), 'quick build');
  assert.ok(tui.ui.edit?.build && frame.includes('Quick build') && frame.replace(/\s+/g, ' ').includes('whether the Builder is on or not'), 'n on the Builder: the quick build box');
  for (const k of 'Add a dark mode') tui.key(k);
  tui.key('enter');
  frame = fits(tui.frame(80, 30), 'confirm');
  assert.ok(frame.includes('Quick build "Add a dark mode", without a ticket?'), 'a one-line y/n first');
  tui.key('y');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(asked.at(-1), ['build', 'Add a dark mode', { name: '' }], 'then built');
  tui.paste('AB#123\nkeep it small');
  assert.ok(tui.ui.edit?.build && tui.ui.edit.value === 'AB#123\nkeep it small' && fits(tui.frame(80, 30), 'multi-line').includes('AB#123↵keep it small'), 'a paste on the Builder keeps its lines');
  tui.key('enter');
  assert.ok(fits(tui.frame(80, 30), 'ticket confirm').includes("Quick build AB#123, with your instructions, claiming it 'In Development'?"), 'what it will do, in one line');
  tui.key('n');
  // Quick names set to ask: a second box asks for the name.
  tuiApp.cfg.quickName = 'ask';
  tui.key('n');
  for (const k of 'Tidy logs') tui.key(k);
  tui.key('enter');
  tui.key('y');
  assert.ok(tui.ui.edit?.naming === 'build' && fits(tui.frame(80, 30), 'name').includes('Name this quick build'), 'ask: the name box');
  for (const k of 'Logging') tui.key(k);
  tui.key('enter');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(asked.at(-1), ['build', 'Tidy logs', { name: 'Logging' }], 'built with the name typed');
  tuiApp.cfg.quickName = 'auto';
  // A quick review waiting on its PRs, in Running: s stops the wait.
  tui.key('R');
  tui.key('1');
  tuiSides.reviewer.waits = () => [quickWait];
  const quickWait = { key: 'QUICK#3', title: 'Cart work', since: Date.now(), waitingOn: [prOf(5).url], letGo: {}, notes: ["octo-org/r6#6 is labelled 'In Review', but it is approved and only context: it doesn't hold the wait"] };
  frame = fits(tui.frame(80, 30), 'waits');
  assert.ok(/◷ QUICK#3 +Cart work +waiting on 1 PR/.test(frame), 'Running lists a waiting review: its mark, the count, labelled');
  assert.ok(frame.includes("Re-reviewed once r5#5 is labelled 'Ready for Review'") && frame.includes('approved and only context'), 'its Activity: the PRs waited on, and why one doesn\'t hold it');
  tui.key('s');
  assert.ok(fits(tui.frame(80, 30), 'stop wait').includes("Stop waiting on QUICK#3's PRs? Their labels stay as they are."));
  tui.key('y');
  assert.deepEqual(asked.at(-1), ['stopWait', 'QUICK#3'], 's stops the wait');
  tuiSides.reviewer.waits = () => [];
  tuiApp.override = { reviewer: true };
}

// ---- The two bars, the full list of keys (/), the mouse and hover, and Hoot's switch ----
// Text with each run of spaces squashed, since keycaps are padded: "[ / ][ all keys ]" reads "/ all keys".
const flat = l => l.replace(/\s+/g, ' ').trim();
// The bars' text, each run as one line: the navigation rows, then the screen's own.
const navLine = f => flat(f.split('\n').slice(-tui.ui.bars[0] - tui.ui.bars[1], -tui.ui.bars[1]).join(' '));
const keyLine = f => flat(f.split('\n').slice(-tui.ui.bars[1]).join(' '));
tui.ui.flashUntil = 0;
tui.key('1');
let frameText = fits(tui.frame(80, 30), 'bars, Reviewer Running');
assert.ok(navLine(frameText).includes('/ all keys') && navLine(frameText).includes('n quick review') && navLine(frameText).includes('← → views'), 'the top bar: moving around, and /');
assert.ok(keyLine(frameText).startsWith('▌Running') && keyLine(frameText).includes('nothing running') && !keyLine(frameText).includes('s stop'), "the bottom bar: the screen's keys, once it has something for them");
tui.key('2');
assert.ok(keyLine(tui.frame(80, 30).join('\n')).includes('enter report'), "History's keys");
tuiApp.override = { reviewer: true, builder: true };
builderNeeds = [{ id: 'n1', ticket: 'AB#124', kind: 'question', question: 'Keep the old cart format?', context: [], options: ['Yes', 'No'], recommended: 'Yes', createdAt: 9 }];
tui.key('B');
tui.key('2');
frameText = fits(tui.frame(80, 30), 'bars, Builder History');
assert.ok(['enter brief', 'o open PRs', 'a ticket', 'w follow'].every(k => keyLine(frameText).includes(k)) && !navLine(frameText).includes('quick review'), "the bars follow the view in sight: the Builder History's keys");
tui.key('/');
let keysList = fits(tui.frame(80, 80), 'all keys');
assert.ok(keysList.includes('Builder · History · this view') && keysList.includes('Builder · Needs you') && keysList.includes('Moving around') && keysList.includes('Mouse')
  && keysList.includes('Stop following the ticket') && !/Hoot|\(o,o\)/.test(keysList), 'the full list: this view first, the side\'s other views, the rest, with Hoot out of the way');
assert.ok(tui.frame(140, 40).some(l => l.length <= 140 && ['Moving around', 'The side in view', 'Typing', 'Mouse', 'Prowl'].some(h => l.indexOf(` ${h}`) > 60)), 'in two columns when wide');
tui.key('3');
assert.ok(!tui.ui.keys && fits(tui.frame(80, 30), 'a key closes the list').includes('Keep the old cart format?'), 'any other key closes the list and does its job');
tui.key('/');
tui.key('esc');
assert.equal(tui.ui.keys, null, 'esc closes it');
// The mouse: a view's tab, a row, the same row again, a side's tab, a key in the bar, the wheel.
tui.key('1');
let lines = tui.frame(80, 30);
const at = (text, from = 0) => { const y = lines.findIndex((l, i) => i >= from && l.includes(text)); return [lines[y].indexOf(text), y]; };
tui.mouse(...at(' 2 History'));
lines = tui.frame(80, 30);
assert.ok(lines.join('\n').includes('READY TO MERGE'), "a click on a view's tab opens it");
tui.ui.sel.builder[1] = 5;
tui.mouse(...at('AB#123'));
assert.equal(tui.ui.sel.builder[1], 0, 'a click on a row selects it');
tui.mouse(...at('Reviewer'));
assert.equal(tui.ui.side, 'reviewer', "a click on a side's tab switches to it");
lines = tui.frame(80, 30);
tui.mouse(...at('all keys'));
assert.ok(tui.ui.keys, "a click on a button's label presses its key");
lines = tui.frame(80, 30);
tui.mouse(lines.at(-1).indexOf('esc') + 1, lines.length - 1);
assert.equal(tui.ui.keys, null, 'and on its keycap: esc closes the list');
// Hover: what a click would do lights up. A button, keycap and label together; a row; a tab not selected; and the
// selected view's tab in a lighter shade of its side's.
const raw = () => tui.frame(80, 30, true);
lines = tui.frame(80, 30);
tui.hover(...at('all keys'));
let lit = raw().find(l => l.includes('all keys'));
assert.ok(lit.includes('48;5;252m') && lit.includes('48;5;240m'), 'a hovered button: its keycap and its label');
assert.ok(raw().filter(l => l.includes('48;5;252m')).length === 1, 'and nothing else');
tui.hover(...at(' 4 Config'));
assert.ok(raw().find(l => l.includes('4 Config')).includes('\x1b[1m\x1b[38;5;222m\x1b[48;5;237m'), 'a hovered tab, not selected: a ghost of its side\'s colour');
assert.ok(raw().find(l => l.includes('4 Config')).includes('48;5;222m 2 History'), "the selected view: the lighter shade of the Reviewer's amber");
// The Reviewer never waits on you: no Needs you tab, and 3, ← and → pass it by. The other numbers keep their meaning.
assert.ok(!lines.find(l => l.includes('4 Config')).includes('Needs you') && lines.find(l => l.includes('4 Config')).includes('5 Log'), "the Reviewer's tabs: no Needs you");
tui.key('3');
assert.equal(tui.ui.view.reviewer, 1, '3 does nothing on the Reviewer');
tui.key('right');
assert.equal(tui.ui.view.reviewer, 3, '→ from History goes to Config');
tui.key('left');
assert.equal(tui.ui.view.reviewer, 1, '← from Config back to History');
tui.key('B');
tui.key('2');
lines = tui.frame(80, 30);
assert.ok(raw().find(l => l.includes('4 Config')).includes('48;5;183m 2 History') && raw().find(l => l.includes('4 Config')).includes('3 Needs you') && raw().find(l => l.includes('Builder')).includes('48;5;141m'), "the Builder's: violet, its view lavender, and its Needs you");
tui.hover(...at('AB#123'));
assert.ok(raw().find(l => l.includes('AB#123')).startsWith('\x1b[48;5;236m'), 'a hovered row: a soft band');
tui.hover(0, 1);
assert.ok(!raw().some(l => l.includes('48;5;236m') && l.includes('AB#123')), 'moving off it clears it');
tui.key('R');
tui.key('4');
const cfgSel = tui.ui.sel.reviewer[3];
tui.mouse(0, 0, 65);
assert.equal(tui.ui.sel.reviewer[3], cfgSel + 1, 'the wheel moves the selection');
// A drag selects text, highlighted while the button is down, and copies it when let go, as in Claude Code.
const copied = [];
const tui3 = startTui(tuiApp, { sides: tuiSides, pollNow() {}, togglePause() {}, saveConfig() {}, saveToken: () => '', quit() {}, toggleSide: () => true },
  { headless: true, copy: t => copied.push(t) });
tui3.key('B');
tui3.key('2');
lines = tui3.frame(80, 30);
const [kx, ky] = at('AB#123');
const [px, py] = at('pull/7');
tui3.drag(kx, ky, px + 5, py);
assert.equal(copied.length, 1, 'let go: copied');
assert.ok(copied[0].startsWith('AB#123') && copied[0].endsWith('pull/7') && copied[0].includes('\n'), `the selection, across rows: ${JSON.stringify(copied[0])}`);
assert.ok(!copied[0].split('\n').some(l => l !== l.trimEnd()), 'without trailing spaces');
assert.ok(tui3.frame(80, 30).join('\n').includes('Copied'), 'it says so');
tui3.drag(5, 0, 5, 0);
assert.equal(copied.length, 1, 'a press and release in place is a click, not a copy');
// The bars stack, as a grid, when the window is too narrow for one row each; nothing is left out while there's room.
const navButtons = ['tab side', '← → views', 'n quick review', 'r poll', 'p pause', 'e on/off', '↑ ↓ select', '/ all keys', 'q quit'];
tui3.key('R');
tui3.key('1');
tui3.ui.flashUntil = 0; // the copy's message from above
tuiApp.override = { reviewer: true, builder: true };
for (const [W, rowsWanted] of [[160, 1], [80, 2], [50, 3], [44, 5]]) {
  const f = tui3.frame(W, 40);
  assert.ok(f.every(l => l.length <= W), `${W}: fits`);
  assert.equal(tui3.ui.bars[0], rowsWanted, `${W} columns: the navigation bar in ${rowsWanted} rows`);
  const nav = flat(f.slice(-tui3.ui.bars[0] - tui3.ui.bars[1], -tui3.ui.bars[1]).join(' '));
  assert.ok(navButtons.every(b => nav.includes(b)), `${W}: every button: ${nav}`);
  if (rowsWanted > 1) {
    // Where each button starts: its first keycap (the navigation bar's keycaps sit on colour 239).
    const starts = row => { let [c, prev] = [0, false]; return row.flatMap(([st, t]) => { const cap = st.includes('48;5;239m'); const at = cap && !prev ? [c] : []; [c, prev] = [c + t.length, cap]; return at; }); };
    const [first, second] = tui3.ui.frame.slice(-tui3.ui.bars[0] - tui3.ui.bars[1]).map(starts);
    assert.deepEqual(second, first.slice(0, second.length), `${W}: its columns line up`);
  }
}
tui3.frame(40, 14);
assert.ok(tui3.ui.bars[0] + tui3.ui.bars[1] <= 4, 'a small window: the least used buttons come off, so the bars take a third of it at most');
// Beside Hoot on a wide screen: the Boards card, then Needs you, each clickable.
assert.ok(!tui3.frame(80, 30).join('\n').includes('╭─ Boards'), '80 columns: no cards');
let wide = tui3.frame(110, 30).join('\n');
assert.ok(wide.includes('╭─ Boards') && !wide.includes('Needs you ·') && /Reviewer\s+on · next/.test(wide), '110: the Boards card');
lines = tui3.frame(150, 30);
wide = lines.join('\n');
assert.ok(wide.includes('╭─ Boards') && wide.includes('╭─ Needs you · 1') && wide.includes('⚑ AB#124 question') && lines.every(l => l.length <= 150), '150: both, Needs you with its count');
tui3.mouse(...at('AB#124 question'));
assert.deepEqual([tui3.ui.side, tui3.ui.view.builder], ['builder', 2], 'a click on what needs you opens it');
tui3.key('R');
builderNeeds = [];
assert.ok(tui3.frame(150, 30).join('\n').includes('✓ All clear'), 'nothing waiting: all clear');
// Needs you: each item is a form. The recommended option is picked; Other and Ask about this are typed in; Submit
// (enter) sends one of the three, never two together. A question its session marks "multiple" takes several picks.
const record = { uid: 'u9', key: 'AB#125', title: 'Names', status: 'needs-you', prs: [], updatedAt: 9, briefDir: '/b', sessionStarted: true };
const nameQ = { id: 'n9', recordId: 'u9', ticket: 'AB#125', kind: 'question', question: "How should the user's name be displayed?", context: [], createdAt: 9,
  options: ['first-name last-name', 'last-name, first-name', 'first-initial last-name'], recommended: 'first-name last-name',
  thread: [{ from: 'you', text: 'Where is it shown?' }, { from: 'session', text: 'The account menu and the order history.' }] };
builderNeeds = [nameQ];
const answered = [];
const discussed = [];
const tui5 = startTui(tuiApp, {
  sides: { ...tuiSides, builder: { ...tuiSides.builder, history: () => [record] } }, pollNow() {}, togglePause() {}, saveConfig() {}, saveToken: () => '', quit() {}, toggleSide: () => true,
  answer: (it, text) => { answered.push([it.id, text]); builderNeeds = builderNeeds.filter(x => x !== it); },
  discuss: (it, q) => { discussed.push([it.id, q]); return q === 'busy' ? 'Wait for the reply to your last question.' : ''; },
}, { headless: true });
tui5.key('B');
tui5.key('3');
const formText = () => tui5.frame(90, 34).join('\n');
let form = formText();
assert.ok(/\(•\) 1\. first-name last-name {2}Recommended/.test(form) && /\( \) 2\. last-name, first-name/.test(form) && /\( \) Other: type your own answer/.test(form)
  && /\? {2}Ask about this: type a question/.test(form) && form.includes(' Submit '), `the form, the recommended option picked:\n${form}`);
assert.ok(/You +Where is it shown\?/.test(form) && /Session +The account menu/.test(form), 'the talk so far, above it');
assert.ok(['space pick', 'enter submit', '[ ] item'].every(k => flat(form.split('\n').slice(-tui5.ui.bars[1]).join(' ')).includes(k)), 'its keys');
// Ask about this: typing there clears the pick; Submit sends the question alone, and the form stays for the answer.
tui5.key('down'); tui5.key('down'); tui5.key('down'); tui5.key('down'); // to Ask about this
assert.equal(tui5.ui.edit?.field, 'ask', 'on a row you type in, keys type');
for (const k of 'busy') tui5.key(k);
assert.ok(!/\(•\)/.test(formText().split('Ask about this')[0].split('Session')[1]), 'typing a question clears the pick');
tui5.key('enter');
assert.ok(formText().includes('Wait for the reply to your last question.') && !answered.length, "why it can't be asked yet, in the form; nothing answered");
for (let i = 0; i < 4; i++) tui5.key('backspace');
for (const k of 'Why not initials?') tui5.key(k);
tui5.key('enter');
assert.deepEqual([discussed.at(-1), answered.length], [['n9', 'Why not initials?'], 0], 'the question alone, never with an option');
assert.ok(/\? {2}Ask about this: /.test(formText()) && tui5.ui.edit?.field === 'ask' && tui5.ui.edit.value === '', 'asked: ready for another');
// Picking an option clears a question being typed; esc leaves the row for the top.
for (const k of 'half') tui5.key(k);
tui5.key('esc');
assert.equal(tui5.ui.edit, null, 'esc: back to the options');
tui5.key('down');
tui5.key(' ');
form = formText();
assert.ok(/\(•\) 2\. last-name, first-name/.test(form) && !/\(•\) 1\./.test(form) && form.includes('Ask about this: type a question'), 'one pick at a time, and the question cleared');
tui5.key('enter');
assert.deepEqual(answered.at(-1), ['n9', 'last-name, first-name'], 'enter submits the pick');
// Your own answer, by mouse: click Other, type, click Submit.
const plan = { id: 'p1', recordId: 'u9', ticket: 'AB#125', kind: 'plan', question: 'Approve the plan for AB#125?', context: ['/b/plan.md'], options: [], recommended: '', createdAt: 9 };
const browsers = { id: 'm1', recordId: 'u9', ticket: 'AB#125', kind: 'question', question: 'Which browsers must it support?', context: [], options: ['Chrome', 'Safari', 'Firefox'], recommended: ['Chrome', 'Safari'], multiple: true, createdAt: 9 };
builderNeeds = [plan, browsers];
let shown = tui5.frame(90, 34);
assert.ok(shown.some(l => /\(•\) Approve the plan {2}Recommended/.test(l)) && shown.some(l => /Send it back with a note: /.test(l)), "a plan's form");
const lineOf = text => { const y = shown.findIndex(l => l.includes(text)); return [shown[y].indexOf(text), y]; };
tui5.mouse(...lineOf('Send it back with a note'));
assert.equal(tui5.ui.edit?.field, 'other', 'a click on a row you type in: typing there');
for (const k of 'Split the migration') tui5.key(k);
shown = tui5.frame(90, 34);
assert.ok(shown.some(l => /\( \) Approve the plan/.test(l)), 'your own words clear the pick');
tui5.mouse(...lineOf('Submit'));
assert.deepEqual(answered.at(-1), ['p1', 'Split the migration'], 'Submit, clicked');
// Several picks, where its session allows: checkboxes, the recommended ones ticked, answered together.
shown = tui5.frame(90, 34);
assert.ok(shown.some(l => l.includes('Pick any that apply.')) && shown.some(l => /\[x\] 1\. Chrome/.test(l)) && shown.some(l => /\[x\] 2\. Safari/.test(l)) && shown.some(l => /\[ \] 3\. Firefox/.test(l)), 'checkboxes');
tui5.mouse(...lineOf('3. Firefox'));
tui5.mouse(...lineOf('1. Chrome'));
tui5.key('enter');
assert.deepEqual(answered.at(-1), ['m1', 'Safari; Firefox'], 'the ticked ones, together');
builderNeeds = [{ ...browsers, id: 'm2', recommended: '' }];
tui5.frame(90, 34);
tui5.key('enter');
assert.ok(formText().includes('Pick an option, write your own answer, or ask about it first.') && answered.at(-1)[0] === 'm1', 'nothing chosen: it says so');
builderNeeds = [];
// Hoot's switch: off, no owl, and the cards take the full width.
const ground = "_,_._'__._,_";
assert.ok(tui3.frame(80, 30).join('\n').includes(ground), 'Hoot, on');
tuiApp.cfg.hoot = false;
assert.ok(!tui3.frame(80, 30).join('\n').includes(ground), 'Hoot, off');
for (const W of [80, 150]) {
  const top = tui3.frame(W, 30).find(l => l.includes('╭─ Boards'));
  assert.ok(top && top.includes('╭─ Needs you') && top.startsWith('╭─ Boards') && top.endsWith('╮') && top.length === W, `Hoot off, ${W} columns: both cards, edge to edge`);
}
assert.ok(!tui3.frame(80, 26).join('\n').includes('╭─ Boards'), 'Hoot off, a short window: no cards, as with Hoot on');
tuiApp.cfg.hoot = true;

// ---- Fix my PRs removed: the first-launch migration ----
const { migrateFixes, needsMigration } = await import('./migrate.mjs');
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

await (await import('./quick-self-test.mjs')).run(assert, { appDir });
await (await import('./builder/self-test.mjs')).run(assert);

console.log(`self-test passed: ${count} asserts`);
