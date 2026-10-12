// node prowl.mjs --self-test: checks the logic that decides which tickets and PRs get touched.
import assert from 'node:assert/strict';
import { frontMatter, mentions, norm, swapTags, tagMatches } from './match.mjs';
import { claimEntry, label } from './jira.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alive, buildPrompt, finalize } from './reviews.mjs';
import { processStart } from './proc.mjs';
import { createMascot, wrap } from './mascot.mjs';
import { changelog, newer, syncConfigFiles } from './update.mjs';

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
assert.ok(again.includes('This is a re-review') && again.includes('F-01 [HIGH] old finding') && again.includes('What was fixed: every prior finding'));

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

console.log('self-test passed');
