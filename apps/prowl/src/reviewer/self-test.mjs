// Part of node prowl.mjs --self-test: a review's result, what Prowl posts from it, and how a review settles.
// GitHub is a fake throughout: nothing here reaches a real PR.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { parkedUrls } from '../feedback.mjs';
import { detailsFromBodies } from '../github.mjs';
import { outputTemplates, staleHeadings, template } from '../templates.mjs';
import { commentable, commentableLines, disposition, planPublish, reviewMarker, saidStillOpen, splitAt, withThreads } from './publish-plan.mjs';
import { attempt, publishReview, retryable, WAITS } from './publish.mjs';
import { cut, esc, fenceFor, fillTemplate, flat, LIMIT, reportMd } from './render.mjs';
import { checkResult, counts, eventFor, isCounted, isParked, notCarried, notChecked, NOT_FULLY, TODO, todoPaths, verdictLabels } from './result.mjs';
import { createReviewer } from './reviewer.mjs';
import { buildPrompt, checkerCommand, createReview, newBatchId, priorFindings } from './reviews.mjs';

const SHA = 'a'.repeat(40);
const BATCH = 'rb-20261110-ab42-r1-1432-9f3a';
const A = 'https://github.com/acme/widgets/pull/12';
const B = 'https://github.com/acme/api/pull/7';
const prOf = url => { const m = /github\.com\/(.+)\/pull\/(\d+)/.exec(url); return { url, repo: m[1], number: Number(m[2]), title: `PR ${m[2]}`, author: 'teammate' }; };

/** A finding of this run (F-) or an earlier one (C-), valid by default. */
const finding = (id, over = {}) => ({ id, pr: A, status: id.startsWith('C-') ? 'still-present' : 'confirmed', severity: 'medium', title: `Title ${id}`, axis: 'Correctness', location: { path: 'src/a.js', line: 3, startLine: null },
  problem: `Problem ${id}.`, fix: `Fix ${id}.`, detail: { quote: { language: 'js', code: 'const a = 1;' }, explanation: 'Why.', scenario: 'When.', fixDetail: 'How.', check: 'Test.', verification: 'Verified.' },
  ...(id.startsWith('C-') && { earlier: { by: 'prowl', author: 'octocat', url: `${A}#discussion_r${Number(id.slice(2)) * 100}`, threadId: `PRRT_${id}`, commentId: Number(id.slice(2)) * 100, threadState: 'open', ref: `rb-20261109-ab42-r1-0910-77aa F-${id.slice(2)}`, raisedAt: null, statesItFully: null, parked: false },
    outcome: { commit: null, note: 'Still in the code.', answer: null, disputeHolds: null } }),
  ...over });
const prEntry = (url, over = {}) => ({ url, reviewedAt: SHA, summary: 'Adds a thing.', role: 'The producer.', related: [], conventions: ['CLAUDE.md'], coverage: { axes: ['Correctness'], clean: ['Security'], unverified: null }, earlierReviews: [], ...over });
const resultOf = (findings = [], prs = [prEntry(A)]) => ({ version: 1, batchId: BATCH, batch: { goal: 'Deliver it.', mergeOrder: 'A first.', complete: 'Yes.' }, prs, findings, questions: [] });
const PATCH = '@@ -1,3 +1,4 @@\n one\n-two\n+two changed\n+three\n four\n@@ -20,2 +21,3 @@\n twenty\n+twenty-one\n\\ No newline at end of file';

export async function run(assert, { appDir }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-result-'));
  const outputMd = fs.readFileSync(path.join(appDir, 'skills', 'prowl-review', 'config', 'output.md'), 'utf8');
  const reviewMd = fs.readFileSync(path.join(appDir, 'skills', 'prowl-review', 'config', 'review.md'), 'utf8');
  const templates = outputTemplates(null, outputMd);
  const labels = verdictLabels(reviewMd);

  // ---- The checker ----
  {
    const good = resultOf([finding('F-01'), finding('C-02')]);
    assert.deepEqual(checkResult(good, { batchId: BATCH, prUrls: [A] }), [], 'a good result');
    assert.deepEqual(checkResult(JSON.stringify(good)), [], "the file's text too");
    assert.match(checkResult('{ not json')[0], /^it isn't valid JSON: /);
    assert.deepEqual(checkResult('[]'), ['it must be a JSON object']);
    assert.deepEqual(checkResult({ ...good, version: 2, batchId: 7 }), ['version must be 1 (it is 2)'], 'an unknown version: that one problem alone');
    const one = (change, opts) => { const r = structuredClone(good); change(r); return checkResult(r, opts); };
    const expect = (change, re, opts) => { const out = one(change, opts); assert.ok(out.length >= 1 && out.some(l => re.test(l)), `${re}: ${JSON.stringify(out)}`); };
    expect(r => { r.batchId = 'x'; }, /^batchId: /);
    expect(() => {}, /^batchId: must be the batch id Prowl gave/, { batchId: 'rb-20261110-other' });
    expect(r => { delete r.batch.goal; }, /^batch\.goal: /);
    expect(r => { r.prs[0].reviewedAt = 'abc'; }, /^prs\[0\]\.reviewedAt: /);
    expect(r => { r.prs[0].reviewedAt = null; }, /^prs\[0\]\.reviewedAt: may be null only/);
    assert.deepEqual(one(r => { r.prs[0].reviewedAt = null; r.prs[0].coverage.unverified = "couldn't be read"; r.findings = []; }), [], 'null with the reason');
    expect(r => { r.prs[0].coverage.axes = [' ']; }, /^prs\[0\]\.coverage\.axes: /);
    expect(r => { r.prs[0].earlierReviews = [{ url: 'u', findings: ['nope'] }]; }, /earlierReviews\[0\]\.findings/);
    expect(r => { r.prs.push(prEntry(A)); }, /is listed twice/);
    expect(() => {}, /isn't one of the PRs the checker lists/, { prUrls: [B] });
    expect(() => {}, new RegExp(`${B} has no entry: every PR the checker lists needs one`), { prUrls: [A, B] });
    expect(r => { r.findings[0].status = 'fixed'; }, /^findings\[0\] \(F-01\)\.status: /);
    expect(r => { r.findings[1].status = 'confirmed'; }, /^findings\[1\] \(C-02\)\.status: /);
    expect(r => { delete r.findings[1].earlier; }, /findings\[1\] \(C-02\)\.earlier: is required/);
    expect(r => { Object.assign(r.findings[1], { status: 'answered' }); }, /outcome\.answer: /);
    expect(r => { r.findings.push(finding('F-01')); }, /F-01 is used twice/);
    assert.deepEqual(checkResult(resultOf([finding('F-01'), finding('F-01', { pr: B })], [prEntry(A), prEntry(B)])), [], 'the same id on two PRs is fine');
    expect(r => { r.findings[0].severity = 'huge'; }, /severity/);
    expect(r => { r.findings[0].problem = ' '; }, /problem: can't be blank/);
    assert.deepEqual(one(r => { Object.assign(r.findings[0], { status: 'refuted', problem: '', fix: '', outcome: { note: 'The caller checks it.' } }); }), [], 'a refuted finding may leave them empty');
    expect(r => { delete r.findings[0].location; }, /location: is required/);
    expect(r => { r.findings[0].location = { path: 'a', line: 3, startLine: 9 }; }, /startLine/);
    expect(r => { r.findings[0].status = 'addressed-elsewhere'; r.findings[0].outcome = { note: 'x' }; }, /crossPr: is required/);
    expect(r => { r.findings[0].earlier = { ...r.findings[1].earlier }; }, /an earlier PR-Owl finding is a C-<n> entry/);
    expect(r => { r.findings[0].earlier = { by: 'someone-else', threadState: 'open' }; }, /statesItFully/);
    expect(r => { r.findings.push(finding('C-03', { earlier: r.findings[1].earlier })); }, /merge them into one/);
    expect(r => { r.findings[1].earlier.commentId = null; }, /commentId: is required with a threadId/);
    expect(r => { r.findings[1].status = 'fixed'; }, /outcome\.commit/);
    expect(r => { r.findings[1].outcome.note = ''; }, /outcome\.note: is required/);
    const outside = finding('C-09', { pr: B, status: 'deferred' });
    assert.deepEqual(checkResult(resultOf([outside])), [], 'a deferred finding may name a PR outside prs');
    assert.match(checkResult(resultOf([outside]), { prUrls: [A] })[0], /isn't one of the PRs the checker lists/);
    assert.match(checkResult(resultOf([finding('F-01', { pr: B })]))[0], /has no entry in prs/);
    // Prowl's skeleton never passes as a result.
    assert.deepEqual(checkResult({ ...good, skeleton: 'x' }), ["skeleton: this is still Prowl's skeleton: remove the skeleton key once every part is filled in"]);
    const half = structuredClone(good);
    half.batch.goal = TODO;
    half.findings[1].status = TODO;
    assert.deepEqual(checkResult(half), [`batch.goal, findings[1].status: still "${TODO}" from Prowl's skeleton: set each`]);
    assert.deepEqual(todoPaths({ a: [TODO, { b: TODO }] }), ['a[0]', 'a[1].b']);
    // The command a session runs: read-only, and it creates nothing.
    const file = path.join(tmp, 'x.result.json');
    fs.writeFileSync(file, JSON.stringify(good));
    const home = path.join(tmp, 'no-home');
    const cli = (...args) => spawnSync(process.execPath, [path.join(appDir, 'prowl.mjs'), '--check-result', ...args], { encoding: 'utf8', env: { ...process.env, PROWL_HOME: home } });
    let r = cli(file, '--batch', BATCH, '--prs', A);
    assert.deepEqual([r.stdout.trim(), r.status, fs.existsSync(home)], ['ok', 0, false], 'ok, exit 0, and not even the Prowl home folder is created');
    r = cli(file, '--prs', `${A},${B}`);
    assert.ok(r.status === 1 && r.stdout.includes('has no entry'), 'one line per problem, exit 1');
    assert.match(cli().stdout, /--check-result needs a file/);
    assert.match(cli(path.join(tmp, 'missing.json')).stdout, /^can't read /);
    assert.equal(checkerCommand('C:\\app', 'C:\\home\\reports\\x.result.json', BATCH, [A, B], 'C:\\Program Files\\node.exe'),
      `"C:/Program Files/node.exe" "C:/app/prowl.mjs" --check-result "C:/home/reports/x.result.json" --batch ${BATCH} --prs "${A},${B}"`);
    assert.match(newBatchId('PROJ-123', 2, new Date('2026-11-10T14:32:00Z')), /^rb-20261110-proj123-r2-1432-[0-9a-f]{4}$/);
    assert.match(newBatchId('QUICK#3', 1), /^rb-\d{8}-quick3-r1-\d{4}-[0-9a-f]{4}$/);
  }

  // ---- Counting, the verdict and the event ----
  {
    const needs = finding('C-01', { status: 'needs-person', outcome: { note: 'Create the pipeline.' } });
    const parkedBefore = { ...needs, earlier: { ...needs.earlier, parked: true } };
    assert.deepEqual([isParked(needs), isParked(needs, { parkHumanOnly: true }), isParked(parkedBefore), isCounted(needs), isCounted(needs, { parkHumanOnly: true })], [false, true, true, true, false]);
    const answered = finding('C-02', { status: 'answered', outcome: { answer: 'https://github.com/acme/widgets/pull/12#discussion_r9' } });
    const unver = finding('C-03', { status: 'unverifiable', outcome: { note: 'x' } });
    assert.deepEqual([isParked(answered), isCounted(answered), isParked(unver), isParked({ ...unver, earlier: { ...unver.earlier, parked: true } })], [true, false, false, true]);
    const mix = resultOf([finding('F-01', { severity: 'high' }), finding('F-02', { severity: 'low' }), finding('C-04'), needs, answered, finding('C-05', { status: 'fixed', outcome: { commit: 'abc1234' } }), finding('C-06', { status: 'deferred' })]);
    assert.deepEqual(counts(mix, [A]), { critical: 0, high: 1, medium: 2, low: 1, nit: 0, fixed: 1, stillOpen: 2 }, 'deferred and parked are left out');
    assert.deepEqual(counts(mix, [A], { parkHumanOnly: true }).medium, 1);
    assert.deepEqual(counts(mix, []), { critical: 0, high: 0, medium: 0, low: 0, nit: 0, fixed: 0, stillOpen: 0 }, 'a PR not reviewed counts nothing');
    assert.deepEqual(labels, { critical: 'BLOCK', high: 'REQUEST CHANGES', medium: 'REQUEST CHANGES', low: 'APPROVE WITH NITS', nit: 'APPROVE WITH NITS', none: 'APPROVE' }, "the shipped review.md's table");
    assert.deepEqual(verdictLabels('intro\n\n| Sev | Verdict |\n|---|---|\n| Critical or High | STOP |\n| no findings | SHIP |\n\n## Later').critical, 'STOP');
    assert.equal(verdictLabels('| Sev | Verdict |\n|---|---|\n| no findings | SHIP |').none, 'SHIP', 'an edited table, moved elsewhere');
    assert.equal(verdictLabels('| Highest verified severity on this PR | Verdict | `event` in formal mode | `event` in comment mode |\n|---|---|---|---|\n| Critical | BLOCK | `REQUEST_CHANGES` | `COMMENT` |\n| Low or Nit only | NITS | `APPROVE` | `COMMENT` |').low, 'NITS', 'an old four-column table');
    assert.equal(verdictLabels('no table').high, 'REQUEST CHANGES');
    for (const severity of ['critical', 'high', 'medium']) {
      assert.deepEqual(eventFor({ severity }), { event: 'REQUEST_CHANGES', noBlocking: false, approval: null });
      assert.deepEqual(eventFor({ severity, own: true }), { event: 'COMMENT', noBlocking: false, approval: null });
    }
    for (const severity of ['low', 'nit', '']) {
      assert.deepEqual(eventFor({ severity }), { event: 'APPROVE', noBlocking: false, approval: 'approved' }, 'approvals on, nothing blocking: APPROVE whatever the labels say');
      assert.deepEqual(eventFor({ severity, approvals: false }), { event: 'COMMENT', noBlocking: true, approval: 'awaiting-human' });
      assert.deepEqual(eventFor({ severity, own: true, approvals: true }), { event: 'COMMENT', noBlocking: false, approval: 'awaiting-human' }, 'your own PR: never the No blocking issues block');
    }
  }

  const baseRun = (over = {}) => ({ id: 'AB42-20261110T143200-r1', ticket: 'AB#42', ticketUrl: 'https://dev.azure.com/o/p/_workitems/edit/42', title: 'Thing', reviewNo: 1, me: 'octocat', approvals: true, parkHumanOnly: false,
    prs: [prOf(A)], startedAt: Date.parse('2026-11-10T14:32:00Z'), logPath: path.join(tmp, 'AB42-r1.ndjson'), reportPath: path.join(tmp, 'AB42-r1.md'), published: {}, ...over });
  const info = (over = {}) => ({ state: 'open', title: 'Add retries', author: 'teammate', head: SHA, files: commentable([{ filename: 'src/a.js', patch: PATCH }]), threads: [], ...over });
  const plan = (result, runOver = {}, prsInfo = { [A]: info() }) => planPublish(result, { run: baseRun(runOver), templates, labels, prs: prsInfo });
  const reviewOp = rec => rec.ops.find(o => o.kind === 'review');

  // ---- Not fully reviewed: an approval is withheld ----
  {
    const clean = plan(resultOf([])).prs[0];
    assert.deepEqual([clean.event, clean.approval, clean.verdict, clean.withheld], ['APPROVE', 'approved', 'APPROVE', '']);
    const withheld = (result, runOver) => plan(result, runOver).prs[0];
    let rec = withheld(resultOf([], [prEntry(A, { coverage: { axes: ['Correctness'], clean: [], unverified: 'The reviewer failed twice.' } })]));
    assert.deepEqual([rec.event, rec.approval, rec.verdict, rec.withheld], ['COMMENT', null, NOT_FULLY, "something wasn't checked"]);
    assert.ok(reviewOp(rec).payload.body.includes(NOT_FULLY) && reviewOp(rec).payload.body.includes('**Not checked:** The reviewer failed twice.'), 'the banner says so and the body names what');
    rec = withheld(resultOf([finding('F-01', { status: 'unverifiable', severity: 'nit', outcome: { note: 'needs runtime' } })]));
    assert.deepEqual([rec.event, rec.notChecked], ['COMMENT', ["F-01 Title F-01 couldn't be verified"]], 'an unverifiable finding of any severity');
    assert.equal(withheld(resultOf([], [prEntry(A, { coverage: { axes: [], clean: [], unverified: null } })])).notChecked[0], 'no review axis was covered');
    assert.match(withheld(resultOf([finding('C-01', { status: 'deferred' })])).notChecked[0], /was left for a later review/);
    assert.deepEqual(notChecked(resultOf([finding('C-01', { status: 'deferred', pr: B })], [prEntry(A), prEntry(B)]), A), [], 'a deferred finding on a left-out PR changes nothing here');
    const ref = 'rb-20261109-ab42-r1-0910-77aa F-01';
    rec = withheld(resultOf([]), { priorRefs: { [A]: [ref] } });
    assert.deepEqual([rec.event, rec.notCarried, rec.withheld], ['COMMENT', [ref], '1 earlier finding not carried over']);
    assert.deepEqual(notCarried(resultOf([finding('C-01')]), A, [ref]), [], 'carried by a C- entry on the same PR');
    assert.deepEqual(notCarried(resultOf([finding('C-01', { pr: B })], [prEntry(A), prEntry(B)]), A, [ref]), [ref], 'carried on another PR: owed');
    assert.deepEqual(notCarried(resultOf([finding('F-01', { earlier: { by: 'someone-else', ref } })]), A, [ref]), [ref], 'an F- entry carrying the ref does not count');
    assert.deepEqual(notCarried(resultOf([], [prEntry(A, { earlierReviews: [{ url: `${A}#pullrequestreview-1`, findings: [ref] }] })]), A), [ref], "a blocking review's finding with no entry");
    rec = withheld(resultOf([finding('F-01', { severity: 'high' })], [prEntry(A, { coverage: { axes: ['x'], clean: [], unverified: 'hole' } })]));
    assert.deepEqual([rec.event, rec.verdict], ['REQUEST_CHANGES', 'REQUEST CHANGES'], 'a request for changes is unaffected, and keeps its label');
    rec = withheld(resultOf([], [prEntry(A, { coverage: { axes: ['x'], clean: [], unverified: 'hole' } })]), { approvals: false });
    assert.ok(rec.approval === null && !reviewOp(rec).payload.body.includes('No blocking issues'), 'approvals off: no stamp either');
    const stamped = plan(resultOf([]), { approvals: false }).prs[0];
    assert.ok(stamped.event === 'COMMENT' && stamped.approval === 'awaiting-human' && reviewOp(stamped).payload.body.includes('No blocking issues found'));
    const own = plan(resultOf([]), { prs: [{ ...prOf(A), author: 'OctoCat' }] }).prs[0];
    assert.ok(own.event === 'COMMENT' && own.approval === 'awaiting-human' && !reviewOp(own).payload.body.includes('No blocking issues'), 'your own PR: a comment, the verdict in the banner, no such block');
    // Not reviewed at all.
    assert.equal(plan(resultOf([]), {}, { [A]: info({ state: 'merged' }) }).prs[0].skip, 'merged');
    assert.equal(plan(resultOf([], [prEntry(A, { reviewedAt: null, coverage: { axes: [], clean: [], unverified: 'unreadable' } })])).prs[0].skip, 'not reviewed: no head commit');
    assert.equal(plan(resultOf([], [prEntry(B)]), { prs: [prOf(A)] }).prs[0].skip, 'not in this review');
    const batch = plan(resultOf([finding('F-01', { severity: 'low' })], [prEntry(A, { coverage: { axes: ['x'], clean: [], unverified: 'hole' } })]));
    assert.deepEqual([batch.verdict, batch.counts.low, plan(resultOf([]), {}, { [A]: info({ state: 'closed' }) }).verdict], [NOT_FULLY, 1, 'n/a']);
  }

  // ---- From a finding to GitHub: every row of the table ----
  {
    const files = commentable([{ filename: 'src/a.js', patch: PATCH }, { filename: 'bin.dat' }, { filename: 'new/name.js', patch: '@@ -0,0 +1,2 @@\n+a\n+b' }]);
    assert.deepEqual([...commentableLines(PATCH).entries()], [[1, 0], [2, 0], [3, 0], [4, 0], [21, 1], [22, 1]], 'added and context lines, per hunk; deleted lines and the no-newline note take none');
    assert.deepEqual([files.get('bin.dat').size, files.get('new/name.js').get(2)], [0, 0], 'a binary file has no line; a renamed file is under its new name');
    const d = (f, over = {}) => disposition(f, { files, reviewedAt: SHA, ...over });
    assert.deepEqual(d(finding('F-01')).anchor, { path: 'src/a.js', line: 3 }, 'confirmed, on a line that can take a comment: inline');
    assert.equal(d(finding('F-01', { location: { path: 'src/a.js', line: 9 } })).anchor, null, 'not in the diff: the body');
    assert.deepEqual(d(finding('F-01', { location: { path: 'src/a.js', line: 3, startLine: 2 } })).anchor, { path: 'src/a.js', line: 3, startLine: 2 }, 'a multi-line comment within one hunk');
    assert.deepEqual(d(finding('F-01', { location: { path: 'src/a.js', line: 21, startLine: 3 } })).anchor, { path: 'src/a.js', line: 21 }, 'across hunks: its line alone');
    const theirs = (over = {}) => finding('F-01', { earlier: { by: 'someone-else', author: 'lead', url: `${A}#discussion_r5`, threadId: 'T5', commentId: 5, threadState: 'open', statesItFully: true, ...over } });
    assert.deepEqual([d(theirs()).link, d(theirs()).reply, d(theirs()).anchor], [{ kind: 'already raised' }, null, null], 'someone else said it fully, thread open: no new comment');
    for (const over of [{ threadState: 'resolved' }, { threadState: 'outdated' }, { statesItFully: false }]) {
      const x = d(theirs(over));
      assert.deepEqual([x.reply, x.reopen, x.link], ['still-present', over.threadState === 'resolved', { kind: 'already raised', reply: true }], `someone else's thread, ${JSON.stringify(over)}`);
    }
    const noThread = d(theirs({ threadId: null, commentId: null, threadState: 'none', statesItFully: false }));
    assert.deepEqual([noThread.anchor, noThread.alsoRaised], [{ path: 'src/a.js', line: 3 }, true], 'raised only in a summary, and understated: inline, with Also raised by');
    const mine = (state, thread = true) => finding('F-01', { earlier: { by: 'prowl', url: 'u', threadId: thread ? 'T1' : null, commentId: thread ? 1 : null, threadState: state, ref: 'rb-20261109-x F-01' } });
    assert.deepEqual([d(mine('resolved')).reply, d(mine('resolved')).reopen, d(mine('open')).reply, d(mine('open')).link, d(mine('none', false)).link], ['still-present', true, null, { kind: 'still open' }, { kind: 'still open' }]);
    const still = finding('C-01');
    assert.deepEqual([d(still).reply, d(still).reopen, d(still).link], ['still-open', false, { kind: 'still open' }]);
    const said = { lastBody: `🦉 Still open as of ${SHA.slice(0, 7)}: x\n<!-- prowl-review ${BATCH} C-01 -->` };
    said.lastProwlBody = said.lastBody;
    assert.ok(saidStillOpen(said, SHA) && !saidStillOpen({ ...said, lastBody: 'I disagree' }, SHA) && !saidStillOpen({ lastBody: `Verified fixed in ${SHA.slice(0, 7)} <!-- prowl-review x -->`, lastProwlBody: `Verified fixed in ${SHA.slice(0, 7)} <!-- prowl-review x -->` }, SHA));
    assert.equal(d(still, { threads: { 'PRRT_C-01': said } }).reply, null, 'already says still open at this head: no new reply');
    const resolved = finding('C-01', { earlier: { ...still.earlier, threadState: 'resolved' } });
    assert.deepEqual([d(resolved).reply, d(resolved).reopen], ['still-open', true], 'still present, its thread resolved: reopened');
    assert.equal(d(finding('C-01', { earlier: { ...still.earlier, threadState: 'outdated' } })).reopen, false, 'an outdated thread is never reopened');
    const fixed = finding('C-01', { status: 'fixed', outcome: { commit: 'abc1234' } });
    assert.deepEqual([d(fixed).reply, d(fixed).resolve, d({ ...fixed, earlier: { ...fixed.earlier, threadState: 'resolved' } }).reply], ['fixed', true, null]);
    const gone = finding('C-01', { status: 'no-longer-applies', outcome: { note: 'x', disputeHolds: true } });
    assert.deepEqual([d(gone).reply, d(gone).resolve, d(gone).state], ['no-longer-applies', true, true]);
    for (const status of ['answered', 'deferred']) assert.deepEqual([d(finding('C-01', { status })).reply, d(finding('C-01', { status })).link], [null, null], `${status}: nothing on the thread`);
    assert.ok(d(finding('F-01', { status: 'refuted' })).state && !d(finding('F-01', { status: 'disputed' })).state && !d(finding('F-01', { status: 'unverifiable' })).state);
    // The thread's state is GitHub's, and a thread from another PR is dropped.
    const res = resultOf([finding('C-01'), finding('C-02', { earlier: { ...finding('C-02').earlier, threadId: 'PRRT_other', commentId: 999 } })]);
    const now = withThreads(res, A, [{ id: 'PRRT_C-01', commentId: 100, resolved: true, outdated: false }]);
    assert.deepEqual([now.findings[0].earlier.threadState, now.findings[1].earlier], ['resolved', { ...res.findings[1].earlier, threadId: null, commentId: null, threadState: 'none' }]);
    assert.equal(withThreads(res, A, null), res, "threads that couldn't be read: the session's values stand");
    assert.equal(withThreads(resultOf([finding('C-01', { earlier: { ...still.earlier, threadId: null } })]), A, [{ id: 'T9', commentId: 100, resolved: false, outdated: true }]).findings[0].earlier.threadId, 'T9', 'matched by its comment, which supplies the thread');
  }

  // ---- Rendering ----
  {
    assert.equal(esc('a <b> `x <y>` <!-- c'), 'a &lt;b> `x <y>` &lt;!-- c', '< escaped outside code spans, kept inside');
    assert.equal(flat('a\n`b` -- c | d'), 'a b - c / d');
    assert.equal(fenceFor('a ```` b'), '`````');
    assert.equal(fillTemplate('a <x>\n\n<y>\n\nb <unknown>', { x: '1', y: '' }), 'a 1\n\nb <unknown>', 'a line of only empty placeholders is dropped, with the blank line it would leave doubled');
    assert.ok(cut('a\n```js\nconst x = 1;\nconst y = 2;\n```\n', 18).endsWith("```\n(trimmed: over GitHub's 65,536-character limit)"), 'a cut inside a code fence closes the fence');
    assert.deepEqual(staleHeadings(outputMd), [], "the shipped output.md has every template");
    const edited = outputMd.replace('<finding lines>\n\n<details block>\n```', '<finding lines>\n```').replace('- **[<SEVERITY>]** <title> · <where>', '* <SEVERITY> <title> at <where>');
    const t2 = outputTemplates(edited, outputMd);
    assert.deepEqual(t2.fellBack, ['Review body'], 'a heading missing a placeholder falls back, and is listed');
    assert.ok(t2.get('Finding line').startsWith('* <SEVERITY>') && t2.get('Review body') === template(outputMd, 'Review body'), 'an edited template that has what Prowl needs is used');
    assert.ok(staleHeadings('## Review banner\n```\n<verdict> <batch-id>\n```\n').includes('Details finding') && !staleHeadings('## Review banner\n```\n<verdict> <batch-id>\n```\n').includes('Review banner'));
    // A review of someone else's PR with one Medium finding on a changed line.
    const rec = plan(resultOf([finding('F-01', { title: 'Loop <never> ends', problem: 'It loops on `a < b` and <script>.' })])).prs[0];
    const op = reviewOp(rec);
    assert.deepEqual([rec.event, op.payload.commit_id, op.payload.comments.length, op.payload.comments[0].line, rec.ops.length], ['REQUEST_CHANGES', SHA, 1, 3, 1]);
    assert.ok(op.payload.comments[0].body.startsWith('🦉 **PR-Owl Review** · It loops on `a < b` and &lt;script>.\n\n**Fix:** Fix F-01.') && op.payload.comments[0].body.endsWith(`\n<!-- prowl-review ${BATCH} F-01 -->`));
    const { body } = op.payload;
    assert.ok(body.startsWith('```text\n╭─ PR-OWL') && body.includes('REQUEST CHANGES') && body.includes(BATCH) && body.includes('**Summary:** Adds a thing.') && body.includes('- **[MEDIUM]** Loop &lt;never> ends · `src/a.js:3`'));
    assert.ok(body.endsWith(reviewMarker('AB42-20261110T143200-r1')), 'the review marker last');
    const details = detailsFromBodies([{ body, at: '2026-11-10T15:00:00Z' }], [], 'widgets-12');
    assert.ok(details.startsWith('# PR-Owl Review: acme/widgets#12 — Add retries') && details.includes('### F-01 [MEDIUM] Loop &lt;never> ends') && details.includes('- **Where:** `src/a.js:3` (inline comment)') && details.includes('for [AB#42](https://dev.azure.com/o/p/_workitems/edit/42)'), "the Builder's details reader recognises the body");
    assert.ok(details.includes('```js\nconst a = 1;\n```') && details.includes('**Checked and found clean:**\n- Security') && details.includes('**Could not verify:**\nnothing') && !details.includes('- **Cross-PR:**'), 'the cross-PR line is dropped when there is none');
    assert.ok(!reviewOp(plan(resultOf([])).prs[0]).payload.body.includes('<details>') && reviewOp(plan(resultOf([])).prs[0]).payload.body.includes('No issues found.'), 'no findings and nothing parked: no details block');
    // Only parked findings: a details file holding the Parked list, whose links the Builder's reader finds.
    const answered = finding('C-02', { status: 'answered', outcome: { answer: `${A}#discussion_r999`, note: null } });
    const parkedBody = reviewOp(plan(resultOf([answered])).prs[0]).payload.body;
    const parkedFile = detailsFromBodies([{ body: parkedBody, at: '2026-11-10T15:00:00Z' }], [], 'widgets-12');
    assert.ok(parkedFile.includes(`## Parked\n\n- Title C-02 (rb-20261109-ab42-r1-0910-77aa F-02): answered: ${A}#discussion_r999 · ${A}#discussion_r200`) && parkedBody.includes('No issues found.'));
    assert.deepEqual(parkedUrls(parkedFile).at(-1), `${A}#discussion_r200`);
    assert.equal(plan(resultOf([answered])).prs[0].ops.length, 1, 'an answered finding gets no reply, reopen or resolve');
    // Not in the diff; someone else's; a cross-PR finding; a consumer.
    const lines = reviewOp(plan(resultOf([
      finding('F-01', { location: { path: 'src/a.js', line: 99 } }), finding('F-02', { location: null, severity: 'low' }),
      finding('F-03', { crossPr: { counterpart: B, fixBelongsTo: A, why: 'They share the date format.' }, consumer: { repo: 'acme/billing', path: 'src/y.ts' } }),
      finding('F-04', { earlier: { by: 'someone-else', author: 'lead', url: `${A}#discussion_r5`, threadId: 'T5', commentId: 5, threadState: 'open', statesItFully: true } })]),
    {}, { [A]: info({ threads: [{ id: 'T5', commentId: 5, resolved: false, outdated: false }] }) }).prs[0]).payload;
    assert.ok(lines.body.includes('· `src/a.js:99` (not in the diff)') && lines.body.includes('· no single place (not in the diff)') && lines.body.includes(`· \`src/a.js:3\` with ${B}; consumer outside the batch: acme/billing \`src/y.ts\``) && lines.body.includes(`· already raised: ${A}#discussion_r5`));
    assert.ok(lines.comments.length === 1 && lines.comments[0].body.includes(`Goes with ${B}: They share the date format.`) && lines.comments[0].body.includes('Consumer outside the batch: acme/billing `src/y.ts`.'));
    const unread = reviewOp(plan(resultOf([finding('F-01')]), {}, { [A]: info({ files: null }) }).prs[0]).payload;
    assert.ok(unread.comments.length === 0 && unread.body.includes("(changed files couldn't be read)"));
    const refused = reviewOp(plan(resultOf([finding('F-01'), finding('F-02', { location: { path: 'src/a.js', line: 99 } })]), { publishFallback: { [A]: 'body' } }).prs[0]).payload;
    assert.ok(refused.comments.length === 0 && refused.event === 'REQUEST_CHANGES' && refused.commit_id === SHA && refused.body.includes('`src/a.js:3` (inline comments refused by GitHub)') && refused.body.includes('`src/a.js:99` (not in the diff)'), 'the refused marker only for a finding that could have gone inline');
    const moved = plan(resultOf([finding('F-01')]), { publishFallback: { [A]: 'head' } }).prs[0];
    assert.deepEqual([reviewOp(moved).payload.commit_id, moved.event], [undefined, 'REQUEST_CHANGES']);
    assert.deepEqual([plan(resultOf([]), { publishFallback: { [A]: 'head' } }).prs[0].event, plan(resultOf([]), { publishFallback: { [A]: 'head' } }).prs[0].approval], ['COMMENT', null], 'on a head nobody verified: no approval');
    // Replies and their order: replies (most severe first), then reopen and resolve, then the review.
    const threads = [{ id: 'PRRT_C-01', commentId: 100, resolved: true, outdated: false }, { id: 'PRRT_C-02', commentId: 200, resolved: false, outdated: false }];
    const ordered = plan(resultOf([finding('C-02', { status: 'fixed', severity: 'low', outcome: { commit: 'abc1234def' } }), finding('C-01', { severity: 'high' })]), {}, { [A]: info({ threads }) }).prs[0];
    assert.deepEqual(ordered.ops.map(o => o.key), [`reply:${A}:C-01`, `reply:${A}:C-02`, `reopen:${A}:C-01`, `resolve:${A}:C-02`, `review:${A}`]);
    assert.ok(ordered.ops[0].body.startsWith(`🦉 **PR-Owl Review** · Still open as of ${SHA.slice(0, 7)}: Still in the code.`) && ordered.ops[1].body.startsWith('🦉 **PR-Owl Review** · Verified fixed in abc1234\n'));
    assert.ok(reviewOp(ordered).payload.body.includes(`still open: ${A}#discussion_r100`) && detailsFromBodies([{ body: reviewOp(ordered).payload.body, at: '' }], [], 'widgets-12').includes('### C-01 [HIGH] Title C-01 (rb-20261109-ab42-r1-0910-77aa F-01)'));
    // A quick review under a name has no ticket.
    assert.ok(reviewOp(plan(resultOf([finding('F-01')]), { ticket: 'QUICK#3', ticketUrl: '' }).prs[0]).payload.body.includes(', for no ticket'));
  }

  // ---- The 65,536-character limit: part 2 ----
  {
    const big = n => resultOf(Array.from({ length: n }, (_, i) => finding(`F-${String(i + 1).padStart(2, '0')}`, { location: { path: 'src/a.js', line: 99 }, detail: { ...finding('F-01').detail, explanation: `Explanation ${i + 1}. ${'x'.repeat(3000)}` } })));
    const result = big(30);
    let rec = plan(result).prs[0];
    assert.deepEqual(rec.ops.map(o => o.kind), ['part2', 'review'], 'part 2 comes before the review');
    const [p2, rev] = rec.ops;
    assert.ok(rev.payload.body.length <= LIMIT && p2.body.length <= LIMIT && p2.body.endsWith('<!-- prowl-review AB42-20261110T143200-r1 part2 -->') && rev.payload.body.includes('_The details file continues in [part 2](), a comment on this PR._'));
    const link = `${A}#issuecomment-55`;
    const pinned = plan(result, { published: { [`part2:${A}`]: link }, split: { [A]: rec.split } }).prs[0];
    assert.equal(reviewOp(pinned).payload.body, rev.payload.body.replace('[part 2]()', `[part 2](${link})`), 'replanned once part 2 exists: only the link changes');
    const joined = detailsFromBodies([{ body: reviewOp(pinned).payload.body, at: '2026-11-10T15:00:00Z' }], [{ body: p2.body }], 'widgets-12');
    for (let i = 1; i <= 30; i++) assert.equal(joined.split(`### F-${String(i).padStart(2, '0')} [MEDIUM]`).length, 2, `the Builder's joiner gets finding ${i} once across both parts`);
    assert.ok(joined.includes('## Coverage'));
    // A resume finds the split by its anchor, whatever the body says by then; with the anchor lost, by the saved line.
    const lost = plan(result, { published: { [`part2:${A}`]: link }, split: { [A]: { ...rec.split, anchor: { text: 'no such line', nth: 0 } } } }).prs[0];
    assert.ok(lost.anchorLost && !pinned.anchorLost && reviewOp(lost).payload.body === reviewOp(pinned).payload.body);
    assert.equal(splitAt(['# a', 'x', '```', '## not a heading', '```', '## b', 'y'], 40), 5, 'the last heading that fits, never one inside a fence');
    // Too long even for two parts: the write-ups are shortened, and Coverage is kept.
    rec = plan(big(60)).prs[0];
    const both = detailsFromBodies([{ body: reviewOp(rec).payload.body.replace('[part 2]()', `[part 2](${link})`), at: '' }], [{ body: rec.ops[0].body }], 'widgets-12');
    assert.ok(rec.split.cap === 1500 && both.includes("(trimmed: over GitHub's 65,536-character limit)") && both.includes('## Coverage') && both.includes('### F-60 [MEDIUM]') && reviewOp(rec).payload.body.length <= LIMIT && rec.ops[0].body.length <= LIMIT, `cap ${rec.split.cap}`);
  }

  // ---- The publisher, against a fake gh ----
  const fakeGh = (over = {}) => {
    const g = { calls: [], reviews: [], replies: [], comments: [], threads: {}, state: {}, head: {}, fail: {},
      me: async () => 'octocat',
      prNow: async pr => ({ state: g.state[pr.url] || 'open', head: g.head[pr.url] || SHA, base: 'b'.repeat(40), title: `Title of ${pr.number}`, author: 'teammate' }),
      prFiles: async () => [{ filename: 'src/a.js', patch: PATCH }],
      compareFiles: async () => { g.calls.push('compare'); return [{ filename: 'src/a.js', patch: PATCH }]; },
      reviewThreads: async pr => g.threads[pr.url] || [],
      writtenSince: async pr => ({ reviews: g.reviews.filter(r => r.pr === pr.url), comments: g.replies.filter(r => r.pr === pr.url), issueComments: g.comments.filter(r => r.pr === pr.url) }),
      createReview: async (pr, file) => {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        g.calls.push(`review ${pr.number} ${payload.event}`);
        const fail = g.fail.review?.(pr, payload);
        if (fail) throw fail;
        const r = { pr: pr.url, id: g.reviews.length + 1, url: `${pr.url}#pullrequestreview-${g.reviews.length + 1}`, state: g.comeBack || { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[payload.event], body: payload.body, payload };
        g.reviews.push(r);
        return { id: r.id, url: r.url, state: r.state };
      },
      reviewComments: async (pr, id) => g.reviews.find(r => r.id === id).payload.comments.map((c, i) => ({ body: c.body, url: `${pr.url}#discussion_r${id}0${i}` })),
      replyOn: async (pr, commentId, file) => {
        g.calls.push(`reply ${commentId}`);
        const fail = g.fail.reply?.(commentId);
        if (fail) throw fail;
        const r = { pr: pr.url, inReplyTo: commentId, body: JSON.parse(fs.readFileSync(file, 'utf8')).body, url: `${pr.url}#discussion_r${commentId}9${g.replies.length}` };
        g.replies.push(r);
        return r.url;
      },
      commentOn: async (pr, file) => { g.calls.push('part2'); const c = { pr: pr.url, body: JSON.parse(fs.readFileSync(file, 'utf8')).body, url: `${pr.url}#issuecomment-${g.comments.length + 1}` }; g.comments.push(c); return c.url; },
      setThreadResolved: async (id, resolved) => { g.calls.push(`${resolved ? 'resolve' : 'reopen'} ${id}`); const fail = g.fail.thread?.(id); if (fail) throw fail; },
      ...over };
    return g;
  };
  const ghError = (status, message = 'Validation Failed') => Object.assign(new Error(message), { status, gh: true });
  const publish = async (run, result, gh, extra = {}) => {
    const logs = [];
    const waits = [];
    const outcome = await publishReview(run, result, { gh, log: (level, msg) => logs.push(`${level} ${msg}`), hoot() {}, save() {}, templates, labels, sleep: async ms => { waits.push(ms); }, ...extra });
    return { outcome, logs, waits };
  };
  {
    assert.ok(retryable(ghError(undefined, 'network')) && retryable(ghError(502)) && retryable(ghError(403, 'You have exceeded a secondary rate limit')) && retryable(ghError(400, 'Something went wrong while executing your query')));
    assert.ok(!retryable(ghError(422)) && !retryable(ghError(403, 'Resource not accessible')) && !retryable(new Error('ENOSPC: the file could not be written')), "Prowl's own failures aren't retried");
    // The full order, on two PRs.
    const threads = [{ id: 'PRRT_C-01', commentId: 100, resolved: true, outdated: false }, { id: 'PRRT_C-02', commentId: 200, resolved: false, outdated: false }];
    const two = resultOf([finding('C-02', { status: 'fixed', severity: 'low', outcome: { commit: 'abc1234def' } }), finding('C-01', { severity: 'high' }), finding('F-01', { pr: B, severity: 'nit' })], [prEntry(A), prEntry(B)]);
    let gh = fakeGh();
    gh.threads[A] = threads;
    let run = baseRun({ prs: [prOf(A), prOf(B)] });
    let { logs } = await publish(run, two, gh);
    assert.deepEqual(gh.calls, ['reply 100', 'reply 200', 'reopen PRRT_C-01', 'resolve PRRT_C-02', 'review 12 REQUEST_CHANGES', 'review 7 APPROVE']);
    assert.deepEqual([run.reviewedPrs, run.approved, run.published[`reopen:${A}:C-01`], run.published[`comment:${B}:F-01`]], [[A, B], { [B]: SHA }, 'reopened', `${B}#discussion_r200`]);
    assert.ok(gh.reviews[0].body.includes(`still open: ${A}#discussion_r100`), "an earlier finding still present links its thread");
    assert.ok(logs.includes(`ok AB#42: review posted on acme/widgets#12`) && logs.includes('ok AB#42: review posted on acme/api#7'));
    // Publishing again repeats nothing.
    gh.calls.length = 0;
    await publish(run, two, gh);
    assert.deepEqual(gh.calls, [], 'everything is done already');
    // Failing part-way, then resuming: nothing twice. A write that landed although the save was lost is found by its marker.
    gh = fakeGh();
    gh.threads[A] = threads;
    gh.fail.thread = () => ghError(undefined, 'socket hang up');
    run = baseRun({ prs: [prOf(A), prOf(B)] });
    let got = await publish(run, two, gh);
    assert.deepEqual([got.waits, Object.keys(run.publishErrors), gh.calls.filter(c => c.startsWith('review'))], [WAITS, [A], ['review 7 APPROVE']], 'backoff 1 s, 4 s, 16 s, then that PR fails while the other still publishes');
    assert.equal(WAITS.join(), '1000,4000,16000');
    gh.fail = {};
    delete run.publishErrors[A];
    delete run.published[`reply:${A}:C-02`]; // as after a crash between the call and the save
    gh.calls.length = 0;
    await publish(run, two, gh);
    assert.deepEqual(gh.calls, ['reopen PRRT_C-01', 'resolve PRRT_C-02', 'review 12 REQUEST_CHANGES'], 'the resume posts no reply twice');
    assert.equal(run.published[`reply:${A}:C-02`], gh.replies[1].url, 'the reply already on the PR is found by its marker');
    // A write that landed although its call failed is taken as done, never made twice.
    gh = fakeGh();
    let tries = 0;
    gh.createReview = async (pr, file) => {
      tries++;
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      gh.reviews.push({ pr: pr.url, id: 1, url: `${pr.url}#pullrequestreview-1`, state: 'CHANGES_REQUESTED', body: payload.body, payload });
      throw ghError(502, 'Bad Gateway');
    };
    run = baseRun();
    await publish(run, resultOf([finding('F-01')]), gh);
    assert.deepEqual([tries, run.published[`review:${A}`], run.reviewedPrs], [1, `${A}#pullrequestreview-1`, [A]]);
    // A refused resolve is logged, not fatal.
    gh = fakeGh();
    gh.threads[A] = threads;
    gh.fail.thread = id => (id === 'PRRT_C-02' ? ghError(403, 'Resource not accessible by integration') : null);
    run = baseRun();
    got = await publish(run, resultOf([finding('C-02', { status: 'fixed', outcome: { commit: 'abc1234' } })]), gh);
    assert.ok(got.logs.some(l => l.includes('GitHub refused to resolve the thread of C-02 on acme/widgets#12 (Resource not accessible by integration); the review goes on without it')) && run.published[`review:${A}`] && run.publishRefused[`resolve:${A}:C-02`]);
    // 422 with inline comments: the findings move into the body; rejected again with the head moved: the latest commit, no approval.
    gh = fakeGh();
    let rejections = 0;
    gh.fail.review = (pr, payload) => (payload.comments.length || (rejections++ === 0 && payload.commit_id) ? ghError(422, 'Unprocessable Entity: line must be part of the diff') : null);
    run = baseRun();
    got = await publish(run, resultOf([finding('F-01', { severity: 'low' })]), gh);
    assert.deepEqual(gh.calls, ['review 12 APPROVE', 'review 12 APPROVE', 'review 12 APPROVE'].slice(0, 2).concat(), 'first with its inline comment, then with every finding in the body');
    assert.deepEqual([Object.keys(run.publishErrors).length, run.publishFallback[A]], [1, undefined], 'rejected again on the same head: the PR fails, and its fallback stage is cleared');
    assert.match(run.publishErrors[A], /^GitHub rejected the review, so none of its findings are on the PR \(.*\); they are in the report$/);
    gh = fakeGh();
    gh.fail.review = (pr, payload) => (payload.commit_id ? ghError(422, 'commit_id is not part of the pull request') : null);
    run = baseRun();
    gh.prNow = async () => ({ state: 'open', head: gh.moved ? 'c'.repeat(40) : SHA, base: 'b'.repeat(40), title: 'T', author: 'teammate' });
    const origReview = gh.createReview;
    gh.createReview = async (pr, file) => { gh.moved = true; return origReview(pr, file); };
    got = await publish(run, resultOf([finding('F-01', { severity: 'low' })]), gh);
    assert.deepEqual([gh.calls, run.publishFallback[A], run.approved, gh.reviews[0].payload.commit_id, gh.reviews[0].payload.comments.length], [['review 12 APPROVE', 'review 12 APPROVE', 'review 12 COMMENT'], 'head', {}, undefined, 0], '422, body fallback, then head fallback: posted, no approval recorded');
    assert.ok(got.logs.some(l => l.includes('trying again with its inline comments in the review body')) && got.logs.some(l => l.includes('its head has moved, so trying again on the latest commit, with no approval')) && got.logs.some(l => l.endsWith('review posted on acme/widgets#12, with its findings in the body')));
    // Asked as APPROVE, came back COMMENTED: no approval is recorded.
    gh = fakeGh();
    gh.comeBack = 'COMMENTED';
    run = baseRun();
    got = await publish(run, resultOf([]), gh);
    assert.ok(got.logs.some(l => l.includes('the review on acme/widgets#12 came back as COMMENTED, not APPROVED; no approval is recorded for it')) && !run.approved[A] && run.reviewedPrs.length === 1);
    // A PR the result can't publish; a PR merged meanwhile; the head moved since it was reviewed.
    gh = fakeGh();
    gh.state[B] = 'merged';
    run = baseRun({ prs: [prOf(A), prOf(B)] });
    got = await publish(run, resultOf([], [prEntry(A, { reviewedAt: null, coverage: { axes: [], clean: [], unverified: 'GitHub returned 404' } }), prEntry(B)]), gh);
    assert.deepEqual([gh.calls, run.unreviewed, got.outcome.prs.map(r => r.skip)], [[], { [A]: "the review session couldn't read it: GitHub returned 404" }, ['not reviewed: no head commit', 'merged']]);
    const before = got.logs.filter(l => l.includes('nothing is posted on acme/widgets#12')).length;
    got = await publish(run, resultOf([], [prEntry(B)]), gh);
    assert.deepEqual([before, got.logs.filter(l => l.includes('nothing is posted on')).length, run.unreviewed[A]], [1, 0, 'the review result has no entry for it'], "it isn't logged twice");
    gh = fakeGh();
    gh.head[A] = 'd'.repeat(40);
    run = baseRun();
    got = await publish(run, resultOf([finding('F-01')]), gh);
    assert.ok(gh.calls.includes('compare') && gh.reviews[0].payload.commit_id === SHA && got.logs.some(l => l.includes('has new commits since it was reviewed at aaaaaaa; its review goes on the commit it verified')));
    // The guardrail: a stray write by the session is named, once.
    gh = fakeGh();
    gh.replies.push({ pr: A, inReplyTo: null, body: `a comment the session made <!-- prowl-review ${BATCH} F-09 -->`, url: `${A}#discussion_r777` });
    run = baseRun();
    got = await publish(run, resultOf([]), gh);
    assert.ok(got.logs.some(l => l === `warn AB#42: the session wrote to acme/widgets#12 itself, though it is told not to: ${A}#discussion_r777`) && run.guardChecked);
    // attempt(): the look for a landed write that itself fails stops the operation.
    await assert.rejects(attempt(async () => { throw ghError(502); }, { sleep: async () => {}, landed: async () => { throw new Error('offline'); } }), e => e.unknown === true);
    // A withheld approval logs why; the templates that fell back are named.
    gh = fakeGh();
    run = baseRun();
    got = await publish(run, resultOf([], [prEntry(A, { coverage: { axes: ['x'], clean: [], unverified: 'hole' } })]), gh, { templates: outputTemplates('# mine\n', outputMd) });
    assert.ok(got.logs.some(l => l.includes("acme/widgets#12 gets no approval: something wasn't checked (its review says what)")) && got.logs.some(l => /your output\.md lacks Review banner, .* so those use the default's templates/.test(l)));
  }

  // ---- A thread a person answered is parked (and what else is) ----
  {
    const answered = finding('C-02', { status: 'answered', outcome: { answer: `${A}#discussion_r999` } });
    assert.match(checkResult(resultOf([finding('F-01', { status: 'answered', outcome: { answer: `${A}#discussion_r999` } })]))[0], /status: must be one of confirmed/, 'answered is for an earlier finding only');
    assert.match(checkResult(resultOf([{ ...answered, outcome: { answer: 'declined in chat' } }]))[0], /outcome\.answer: must be the link to the person's answer on GitHub/);
    for (const parkHumanOnly of [true, false]) {
      const rec = plan(resultOf([answered]), { parkHumanOnly }).prs[0];
      assert.deepEqual([rec.event, rec.severity, rec.ops.map(o => o.kind)], ['APPROVE', '', ['review']], `answered is parked with Park human-only findings ${parkHumanOnly ? 'on' : 'off'}: no reply, and with nothing else counted the PR is approved`);
    }
    const needs = finding('C-03', { status: 'needs-person', outcome: { note: 'Create the CI pipeline.' } });
    assert.deepEqual([plan(resultOf([needs])).prs[0].event, plan(resultOf([needs]), { parkHumanOnly: true }).prs[0].event, plan(resultOf([{ ...needs, earlier: { ...needs.earlier, parked: true } }])).prs[0].event], ['REQUEST_CHANGES', 'APPROVE', 'APPROVE'],
      'needs-person counts with the setting off, is parked with it on, and stays parked when it was parked before');
    const unver = finding('C-04', { status: 'unverifiable', outcome: { note: 'needs the staging data' } });
    assert.deepEqual([plan(resultOf([unver])).prs[0].withheld, plan(resultOf([{ ...unver, earlier: { ...unver.earlier, parked: true } }])).prs[0].event], ["something wasn't checked", 'APPROVE'], "unverifiable withholds the approval, unless it was parked before");
    // The Parked line: the note without the line's own title, ref and link.
    const noisy = { ...needs, earlier: { ...needs.earlier, parked: true }, outcome: { note: `Title C-03 (rb-20261109-ab42-r1-0910-77aa F-03): create the CI pipeline · ${A}#discussion_r300` } };
    const file = detailsFromBodies([{ body: reviewOp(plan(resultOf([noisy, answered])).prs[0]).payload.body, at: '' }], [], 'widgets-12');
    assert.ok(file.includes(`- Title C-03 (rb-20261109-ab42-r1-0910-77aa F-03): create the CI pipeline · ${A}#discussion_r300\n- Title C-02 (rb-20261109-ab42-r1-0910-77aa F-02): answered: ${A}#discussion_r999 · ${A}#discussion_r200`), file.slice(file.indexOf('## Parked'), file.indexOf('## Coverage')));
    assert.deepEqual(parkedUrls(file).filter(u => /r(200|300)$/.test(u)), [`${A}#discussion_r300`, `${A}#discussion_r200`], "the Builder's reader finds the parked threads");
    assert.ok(fs.readFileSync(path.join(appDir, 'skills', 'prowl-review', 'references', 'verifier-instructions.md'), 'utf8').includes('- **ANSWERED** — it still happens at head'));
  }

  // ---- The report ----
  {
    const result = resultOf([finding('F-01', { severity: 'high' }), finding('C-02', { status: 'fixed', outcome: { commit: 'abc1234def' } }), finding('C-03', { status: 'answered', outcome: { answer: `${A}#discussion_r9` } }),
      finding('F-04', { status: 'refuted', outcome: { note: 'The caller checks it.' } }), finding('F-05', { pr: B, severity: 'critical' })], [prEntry(A), prEntry(B)]);
    const run = baseRun({ published: { [`review:${A}`]: `${A}#pullrequestreview-1`, [`comment:${A}:F-01`]: `${A}#discussion_r11` } });
    const p = planPublish(result, { run, templates, labels, prs: { [A]: info() } });
    const md = reportMd(result, run, p, { [A]: { title: 'Add retries', author: 'teammate' } });
    assert.ok(md.startsWith('---\nticket: AB#42\nreview: 1\nverdict: REQUEST CHANGES\ncritical: 0\nhigh: 1\nmedium: 0\nlow: 0\nnit: 0\nfixed: 1\nstillOpen: 0\n---\n\n# PR-Owl review 1: [AB#42](https://dev.azure.com/o/p/_workitems/edit/42) Thing\n'), md.slice(0, 200));
    assert.ok(md.includes(`| [acme/widgets#12](${A}) | Add retries | @teammate | REQUEST CHANGES | [review](${A}#pullrequestreview-1) |`) && md.includes(`- **[HIGH] F-01 Title F-01** · \`src/a.js:3\` · [comment](${A}#discussion_r11)`));
    assert.ok(md.includes('- C-02 Title C-02 (rb-20261109-ab42-r1-0910-77aa F-02) · fixed in abc1234') && md.includes(`- Parked: C-03 [MEDIUM] Title C-03 (rb-20261109-ab42-r1-0910-77aa F-03) on acme/widgets#12 · [thread](${A}#discussion_r300) · answer: ${A}#discussion_r9`));
    assert.ok(md.includes('- refuted: F-04 Title F-04 on acme/widgets#12 (`src/a.js:3`): The caller checks it.') && md.includes('F-05 Title F-05** · `src/a.js:3` (not reviewed; not counted)'), 'a PR not in the review: its findings are in the report, not counted');
    assert.ok(reportMd(resultOf([]), baseRun(), planPublish(resultOf([]), { run: baseRun(), templates, labels, prs: {} })).includes('## Issues found\n\nNo issues found.\n\n## What was fixed\n\nNo earlier findings.'));
  }

  // ---- Settling a review that wrote a result ----
  {
    const settle = async (result, { gh = fakeGh(), runOver = {}, failures = {} } = {}) => {
      const cfg = { ...loadConfig(), githubOwner: 'acme', workDir: tmp };
      const seen = { retags: [], logs: [] };
      const tracker = { name: 'Azure DevOps', retag: async (c, ref, drop, add) => { seen.retags.push(add); } };
      const app = { cfg, me: 'octocat', sideOn: () => true, tracker: () => tracker, boards: () => [], dryRun: () => false };
      const side = createReviewer(app, { log: (level, msg) => { seen.logs.push(`${level} ${msg}`); return true; }, forget() {}, hoot() {}, appDir, trackers: { ado: tracker }, github: gh, labels: { own() {}, set() {}, refused: () => '', pending: () => false } });
      const id = `AB42-settle-${Math.random().toString(36).slice(2, 8)}`;
      const run = { ...baseRun({ id, logPath: path.join(tmp, `${id}.ndjson`), reportPath: path.join(tmp, `${id}.md`) }), tracker: 'ado', ref: { id: 42 }, status: 'running', pid: null, resultMode: 1, batchId: BATCH, resultPath: path.join(tmp, `${id}.result.json`), resultPrs: [A],
        _result: { subtype: 'success', is_error: false, total_cost_usd: 1 }, ...runOver };
      if (result !== undefined) fs.writeFileSync(run.resultPath, typeof result === 'string' ? result : JSON.stringify(result));
      side.state = { runs: [run], failures };
      await side.finish(run);
      return { run, seen, gh, side };
    };
    let s = await settle(resultOf([finding('F-01')]));
    assert.deepEqual([s.run.status, s.run.phase, s.run.summary.verdict, s.run.summary.medium, s.run.blocked, s.seen.retags], ['done', undefined, 'REQUEST CHANGES', 1, [A], ['prowl: changes requested']]);
    assert.ok(fs.readFileSync(s.run.reportPath, 'utf8').includes(`[comment](${A}#discussion_r100)`), 'the report is written again with the links');
    s = await settle(resultOf([]));
    assert.deepEqual([s.run.status, s.run.approved, s.seen.retags], ['done', { [A]: SHA }, ['prowl: approved']]);
    // An invalid result: nothing posted, failed, and retried once.
    s = await settle({ version: 1 });
    assert.ok(s.run.status === 'failed' && /^its review result has \d+ problems, so nothing was posted: .* \(.*\.result\.json\)$/.test(s.run.error) && !s.gh.calls.length && s.seen.retags[0] === 'prowl: review', s.run.error);
    s = await settle(undefined);
    assert.match(s.run.error, /the session ended without writing its review result/);
    // Publishing fails for the PR: the report exists all the same, the review fails, and it isn't retried.
    const refusing = fakeGh();
    refusing.fail.review = () => ghError(403, 'Resource not accessible by integration');
    s = await settle(resultOf([finding('F-01', { location: { path: 'src/a.js', line: 99 } })]), { gh: refusing });
    assert.ok(s.run.status === 'failed' && s.run.unposted[0] === A && s.run.error.startsWith('no review posted on acme/widgets#12 (acme/widgets#12: GitHub rejected the review') && s.run.error.endsWith(`the review result is in ${s.run.resultPath}`), s.run.error);
    assert.ok(fs.readFileSync(s.run.reportPath, 'utf8').includes('F-01 Title F-01') && s.seen.retags[0] === '' && s.seen.logs.some(l => l.includes('Not retried (review not posted): the Log says what GitHub refused. A re-tagged review runs again from the start')));
    // Left half-posted by an earlier launch: the next tick carries on, and nothing is posted twice.
    const gh = fakeGh();
    gh.threads[A] = [{ id: 'PRRT_C-01', commentId: 100, resolved: false, outdated: false }];
    const resumed = resultOf([finding('C-01')]);
    gh.replies.push({ pr: A, inReplyTo: 100, body: `Still open\n<!-- prowl-review ${BATCH} C-01 -->`, url: `${A}#discussion_r1009` });
    s = await settle(resumed, { gh, runOver: { phase: 'publishing', status: 'running', _result: undefined, endedAt: 5 } });
    assert.deepEqual([s.run.status, gh.calls, s.run.published[`reply:${A}:C-01`]], ['done', ['review 12 REQUEST_CHANGES'], `${A}#discussion_r1009`]);
    // Stop is refused while its review is being posted; the time cap doesn't stop it either.
    s.run.status = 'running';
    s.run.phase = 'publishing';
    s.side.stop(s.run);
    assert.ok(s.run.status === 'running' && s.seen.logs.some(l => l.includes("can't be stopped part-way")));
  }

  // ---- Re-reviews: the previous findings come from the previous result ----
  {
    const prior = { id: 'AB42-r1', reviewNo: 1, endedAt: 1, me: 'octocat', parkHumanOnly: false, resultPath: path.join(tmp, 'prior.result.json'),
      published: { [`comment:${A}:F-01`]: `${A}#discussion_r4001`, [`review:${A}`]: `${A}#pullrequestreview-9`, [`reply:${A}:F-03`]: `${A}#discussion_r4003`, [`reopen:${A}:C-05`]: 'reopened' } };
    const earlier = finding('C-05', { earlier: { ...finding('C-05').earlier, threadState: 'resolved' } });
    const result = resultOf([finding('F-01'), finding('F-02', { location: null }), finding('F-03', { earlier: { by: 'someone-else', author: 'lead', url: `${A}#discussion_r50`, threadId: 'T50', commentId: 50, threadState: 'resolved', statesItFully: false } }),
      finding('F-04', { status: 'refuted', outcome: { note: 'x' } }), earlier, finding('C-06', { status: 'fixed', outcome: { commit: 'abc1234' } }), finding('C-07', { status: 'answered', outcome: { answer: `${A}#discussion_r9` } }), finding('F-08', { pr: B })], [prEntry(A), prEntry(B)]);
    const given = priorFindings(prior, result, [A]);
    assert.deepEqual(given.map(g => g.id), ['F-01', 'F-02', 'F-03', 'C-05', 'C-07'], 'only live findings, on PRs this review may name');
    assert.deepEqual(given[0].earlier, { by: 'prowl', author: 'octocat', url: `${A}#discussion_r4001`, threadId: null, commentId: 4001, threadState: 'open', ref: `${BATCH} F-01`, raisedAt: SHA, statesItFully: null, parked: false }, 'earlier built from what was published');
    assert.deepEqual([given[1].earlier.url, given[1].earlier.threadState, given[2].earlier.threadId, given[2].earlier.commentId, given[2].earlier.url], [`${A}#pullrequestreview-9`, 'none', 'T50', 50, `${A}#discussion_r4003`]);
    assert.deepEqual([given[3].ref, given[3].earlier.threadState, given[4].earlier.parked], ['rb-20261109-ab42-r1-0910-77aa F-05', 'open', true], 'a carried finding keeps its original ref; a reopened thread is open; an answered one was parked');
    const owed = { ref: 'rb-20261101-old F-09', id: 'C-09', pr: A, status: 'still-present', title: 'Owed' };
    assert.deepEqual(priorFindings({ ...prior, owed: [owed, { ...owed, pr: B }] }, result, [A]).at(-1), owed, 'what the previous review owed is given again, on PRs still in this review');
    // createReview: the run records what it was given; the prompt carries it as JSON, and what couldn't be checked as a hint.
    fs.writeFileSync(prior.resultPath, JSON.stringify(resultOf([finding('F-01', { title: 'a <b> ``` c' })], [prEntry(A, { coverage: { axes: ['x'], clean: [], unverified: 'The consumer search failed.' } })])));
    const base = loadConfig();
    const run = createReview(base, { tracker: 'ado', ticket: { key: 'AB#42', title: 'Thing', url: 'u', ref: null }, prs: [prOf(A)], prior, me: 'octocat', appDir });
    assert.deepEqual([run.resultMode, run.resultPrs, run.priorRefs, run.parkHumanOnly, path.basename(run.resultPath)], [1, [A], { [A]: [`${BATCH} F-01`] }, false, `${run.id}.result.json`]);
    assert.match(run.batchId, /^rb-\d{8}-ab42-r2-\d{4}-[0-9a-f]{4}$/);
    const prompt = fs.readFileSync(run.promptPath, 'utf8');
    assert.ok(prompt.includes(`- The batch id: \`${run.batchId}\`.`) && prompt.includes(`- The result path: ${run.resultPath}`) && prompt.includes(`--check-result "${run.resultPath.replace(/\\/g, '/')}" --batch ${run.batchId} --prs "${A}"`));
    assert.ok(prompt.includes('(as JSON, with each `<` written `\\u003c`)') && prompt.includes('"title": "a \\u003cb> ``` c"') && prompt.includes('<previous-findings>\n````json\n') && !/<b>/.test(prompt));
    assert.ok(prompt.includes(`<previous-unverified>\n- ${A}: The consumer search failed.\n</previous-unverified>`));
    // A ref a result leaves out is withheld and owed; carried in a later round, it is cleared.
    const round2 = resultOf([]);
    const rec = plan(round2, { priorRefs: run.priorRefs }).prs[0];
    assert.deepEqual([rec.event, rec.notCarried], ['COMMENT', [`${BATCH} F-01`]]);
    assert.deepEqual(run.priorGiven.filter(g => notCarried(round2, g.pr, [g.ref]).length).map(g => g.ref), [`${BATCH} F-01`], 'owed');
    const round3 = resultOf([finding('C-01', { status: 'fixed', outcome: { commit: 'abc1234' }, earlier: { ...finding('C-01').earlier, ref: `${BATCH} F-01` } })]);
    assert.deepEqual([plan(round3, { priorRefs: run.priorRefs }).prs[0].event, run.priorGiven.filter(g => notCarried(round3, g.pr, [g.ref]).length)], ['APPROVE', []]);
  }

  // ---- The vocabulary rule: what a session reads names no action on GitHub ----
  {
    const ACTION = /\b(post(s|ed|ing)?|repl(y|ies|ied|ying)|resolv(e|es|ing)|reopen\w*|approv(e|es|ed|ing|al|als)|request(s|ed)? changes|dismiss\w*|publish\w*)\b/i;
    for (const ok of ['resolved', 'unresolved', 'postpone']) assert.ok(!ACTION.test(ok), `${ok} passes`);
    for (const no of ['post it', 'a reply', 'resolve the thread', 'reopened', 'approval', 'request changes', 'dismissed', 'published']) assert.ok(ACTION.test(no), `${no} is an action`);
    const offending = (name, text) => text.split('\n').map((l, i) => (ACTION.test(l) ? `${name}:${i + 1}: ${l.trim().slice(0, 120)}` : '')).filter(Boolean);
    const skill = path.join(appDir, 'skills', 'prowl-review');
    const texts = [['SKILL.md', fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8')],
      ...fs.readdirSync(path.join(skill, 'references')).filter(f => f.endsWith('.md')).map(f => [f, fs.readFileSync(path.join(skill, 'references', f), 'utf8')]),
      ['review.md', reviewMd.slice(0, reviewMd.indexOf('## Verdict (Prowl)'))]];
    assert.ok(reviewMd.includes('## Verdict (Prowl)\n\nRead by Prowl only'));
    // Generated prompts, with their data blocks (other people's text) taken out.
    const FIX = path.join(appDir, 'src', 'self-test-fixtures');
    const cases = JSON.parse(fs.readFileSync(path.join(FIX, 'prompt-cases.json'), 'utf8'));
    const strip = text => text.replace(/<(ticket-text|previous-findings|previous-unverified|check-output)[\s\S]*?<\/\1>/g, '');
    for (const [name, c] of Object.entries(cases)) {
      const full = { ...c, priorReport: c.priorReport ? fs.readFileSync(path.join(FIX, c.priorReport), 'utf8') : '', ticketText: 'Please approve and post this.', verifierModel: 'sonnet', reviewers: { model: 'opus', effort: 'high' }, checking: true };
      texts.push([`prompt ${name}`, strip(buildPrompt(full))]);
      if (c.prior) texts.push([`prompt ${name} (delta)`, strip(buildPrompt({ ...full, prior: { ...c.prior, reviewedHeads: Object.fromEntries(c.prs.map(p => [p.url, 'aaa'])) }, reReviewScope: 'delta', heads: Object.fromEntries(c.prs.map(p => [p.url, 'bbb'])), smallReReview: { lines: 50, model: 'sonnet' },
        leftOut: [{ url: B }], priorFindings: [{ ref: 'r F-1', title: 'post' }], priorUnverified: { [A]: 'the reply' } }))]);
    }
    texts.push(['prompt quick', strip(buildPrompt({ ...cases.first, quick: true, ticketUrl: '', prior: { reviewNo: 1, endedAt: 1 }, priorFindings: [] }))]);
    assert.deepEqual(texts.flatMap(([name, text]) => offending(name, text)), [], 'the skill, its references, review.md before Verdict (Prowl) and the prompts name no action on GitHub');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}
