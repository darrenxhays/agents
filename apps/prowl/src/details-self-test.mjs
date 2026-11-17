// Part of node prowl.mjs --self-test: History's details view, over the headless TUI with fixture runs and log files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { cached, cacheKeys, dropCache, plain, readLines, readLog } from './details.mjs';
import { findingLinks, findingsFor, findingUrl, prLinks, readResult, webLink } from './reviewer/details.mjs';
import { checkResult } from './reviewer/result.mjs';
import { readActivity } from './sessions.mjs';
import { startTui } from './tui.mjs';

const SHA = 'a'.repeat(40);
const BATCH = 'rb-20261110-ab42-r1-1432-9f3a';
const A = 'https://github.com/acme/widgets/pull/12';
const B = 'https://github.com/acme/api/pull/7';
const prOf = url => { const m = /github\.com\/(.+)\/pull\/(\d+)/.exec(url); return { url, repo: m[1], number: Number(m[2]), title: `PR ${m[2]} title`, author: 'teammate' }; };
const finding = (id, over = {}) => ({ id, pr: A, status: id.startsWith('C-') ? 'still-present' : 'confirmed', severity: 'medium', title: `Title ${id}`, axis: 'Correctness', location: { path: 'src/a b.js', line: 88, startLine: null },
  problem: `Problem ${id}.`, fix: `Fix ${id}.`, detail: { quote: { language: 'js', code: 'const a = 1;' }, explanation: 'Why it breaks.', scenario: 'When.', fixDetail: 'How.', check: 'Test.', verification: 'Verified.' },
  ...(id.startsWith('C-') && { earlier: { by: 'prowl', author: 'octocat', url: `${A}#discussion_r100`, threadId: 'T1', commentId: 100, threadState: 'open', ref: 'rb-20261109-ab42-r1-0910-77aa F-02', raisedAt: null, statesItFully: null, parked: false },
    outcome: { commit: null, note: 'Still in the code.', answer: null, disputeHolds: null } }),
  ...over });
const prEntry = (url, over = {}) => ({ url, reviewedAt: SHA, summary: `Summary of ${url.split('/').at(-1)}.`, role: 'The producer.', related: [], conventions: ['CLAUDE.md'], coverage: { axes: ['Correctness'], clean: ['Security'], unverified: null }, earlierReviews: [], ...over });
const resultOf = (findings = [], prs = [prEntry(A), prEntry(B)]) => ({ version: 1, batchId: BATCH, batch: { goal: 'Deliver the retry queue.', mergeOrder: 'A first.', complete: 'Yes.' }, prs, findings, questions: [] });
const ev = e => `${JSON.stringify(e)}\n`;

export async function run(assert, { appDir }) { // eslint-disable-line no-unused-vars
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-details-'));
  try {
    // ---- The files the details read ----
    {
      for (let i = 0; i < 9; i++) { fs.writeFileSync(path.join(tmp, `c${i}.txt`), `v${i}`); cached(path.join(tmp, `c${i}.txt`), 'text', f => fs.readFileSync(f, 'utf8')); }
      assert.deepEqual([cacheKeys().length, cacheKeys().some(k => k.endsWith('c0.txt')), cacheKeys().at(-1).endsWith('c8.txt')], [8, false, true], 'nine files read: the first is dropped');
      let parses = 0;
      const one = path.join(tmp, 'c8.txt');
      cached(one, 'text', () => { parses++; return 'x'; });
      assert.equal(parses, 0, 'kept until its size or modified time changes');
      fs.writeFileSync(one, 'longer now');
      assert.deepEqual([cached(one, 'text', () => { parses++; return 'y'; }), parses, cached(path.join(tmp, 'nope'), 'text', () => 1)], ['y', 1, null]);
      const big = path.join(tmp, 'big.bin');
      fs.writeFileSync(big, '');
      fs.truncateSync(big, 70 * 1024 * 1024);
      cached(big, 'text', () => 'big');
      assert.deepEqual(cacheKeys(), [`text:${big}`], 'a 70 MB entry is kept while it is the latest');
      cached(one, 'text', () => 'z');
      assert.deepEqual(cacheKeys(), [`text:${one}`]);
      dropCache();
      assert.deepEqual(cacheKeys(), []);
      const txt = path.join(tmp, 'grow.txt');
      fs.writeFileSync(txt, 'one\n\ttwo \x1b[31mred\x1b[0m\n\n\n');
      const first = readLines(txt, { grows: true, now: 1000 });
      assert.deepEqual(first.map(l => l.line), ['one', '  two red'], 'tabs to two spaces, escapes removed, trailing blank lines dropped');
      fs.appendFileSync(txt, 'three\n');
      assert.equal(readLines(txt, { grows: true, now: 2000 }).length, 2, 'looked at again at most every 2 seconds');
      const later = readLines(txt, { grows: true, now: 4000 });
      assert.ok(later.at(-1).line === 'three' && later[0] === first[0], 'a file that grows is read on, its earlier lines the same objects');
      assert.equal(readLines(path.join(tmp, 'nope.txt')), null);
    }

    // ---- A session log ----
    const logPath = path.join(tmp, 'logs', 'AB42-1.ndjson');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const lines = [
      ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the PRs to retry.\nSecond line.' }, { type: 'tool_use', name: 'Bash', input: { command: 'gh pr diff 12', description: 'Read the diff' } }] } }),
      ev({ type: 'user', message: { content: [{ type: 'tool_result', content: Array.from({ length: 45 }, (_, i) => `out ${i + 1}`).join('\n') }] } }),
      'plain stderr \x1b[31mline\x1b[0m\n',
      ev({ type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/retry.js' } }] } }),
      ev({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'No such file' }, { type: 'image' }] }] } }),
      '[1, 2]\n',
    ];
    fs.writeFileSync(logPath, lines.join(''));
    const log = readLog(logPath);
    assert.deepEqual(log.entries.map(e => [e.kind, e.sub, e.text]), [['said', false, 'Reading the PRs to retry.'], ['tool', false, 'Bash Read the diff'], ['output', false, 'out 1'], ['error', false, 'plain stderr line'],
      ['tool', true, 'Read /x/retry.js'], ['output', false, 'No such file'], ['error', false, '[1, 2]']]);
    assert.ok(log.entries[1].full === 'Bash\n  command: gh pr diff 12\n  description: Read the diff' && log.entries[2].full.endsWith('out 40\n… 5 more lines') && log.entries[5].full === 'No such file\n[image]' && log.entries[5].error && log.entries[0].full.includes('Second line.'));
    const viaRunning = { logPath };
    readActivity(viaRunning);
    assert.deepEqual(log.entries.filter(e => e.kind !== 'output').map(e => e.text), viaRunning._activity.map(a => plain(a.text)), 'the Activity lines match what Running shows for the same log');
    const firstEntry = log.entries[0];
    fs.appendFileSync(logPath, ev({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 3.41, duration_ms: 842000 }) + '{"type":"assistant","message":{"content":[{"type":"text","text":"cut');
    const again = readLog(logPath, { now: Date.now() });
    assert.ok(again === log && again.entries[0] === firstEntry && again.results === 1 && again.result.total_cost_usd === 3.41 && again.entries.length === 7, 'read on from where it stopped: the same value object, the same entries');
    assert.equal(readLog(logPath, { now: Date.now() + 5000 }).entries.length, 8, 'a last line with no line break waits for the log to stop growing for a second');
    fs.writeFileSync(logPath, lines.join('') + ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Now retry the queue.' }] } }) + ev({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 3.41, duration_ms: 842000 }));
    dropCache(); // the fixture was rewritten, not appended to
    assert.equal(readLog(path.join(tmp, 'gone.ndjson')), null);

    // ---- The result's helpers ----
    const result = resultOf([finding('F-01', { severity: 'critical' }), finding('F-03', { severity: 'high' }), finding('C-02', { severity: 'high', pr: B }), finding('F-04', { status: 'refuted', outcome: { note: 'guarded' } }),
      finding('C-05', { status: 'fixed', outcome: { commit: 'abc1234', note: null, answer: null, disputeHolds: null } }), finding('F-06', { severity: 'low' })]);
    assert.deepEqual(checkResult(result, { batchId: BATCH, prUrls: [A, B] }), [], 'the fixture is a valid result');
    assert.deepEqual(findingsFor(result).map(f => f.id), ['F-01', 'F-03', 'C-02', 'F-06', 'F-04', 'C-05'], 'what counts first, each group most severe first');
    assert.deepEqual([findingsFor(result, { status: 1, severity: 2 }).map(f => f.id), findingsFor(result, { status: 2 }).map(f => f.id), findingsFor(result, { status: 3 }).map(f => f.id)], [['F-01', 'F-03', 'C-02'], ['C-05'], ['F-04']]);
    assert.equal(findingUrl(result.findings[0], result), `https://github.com/acme/widgets/blob/${SHA}/src/a%20b.js#L88`);
    assert.deepEqual([findingUrl({ ...result.findings[0], location: { path: 'x.js', line: 9, startLine: 4 } }, result).split('#')[1], findingUrl({ ...result.findings[0], location: null }, result), findingUrl({ ...result.findings[0], pr: 'file:///etc/passwd' }, result),
      webLink('file:///etc/passwd'), webLink('https://x.invalid/a b'), webLink(A)], ['L4-L9', '', '', '', '', A]);
    const published = { [`comment:${A}:F-01`]: `${A}#discussion_r1`, [`resolve:${A}:F-01`]: 'resolved', [`review:${A}`]: `${A}#pullrequestreview-9`, [`part2:${A}`]: `${A}#issuecomment-5` };
    assert.deepEqual([findingLinks(result.findings[0], published), prLinks(A, published).map(l => l.what)], [[{ what: 'comment', url: `${A}#discussion_r1` }, { what: 'resolve', url: '' }], ['review', 'details part 2']]);
    const bad = path.join(tmp, 'bad.result.json');
    fs.writeFileSync(bad, '{}');
    assert.deepEqual([readResult(bad).state, readResult(path.join(tmp, 'none.json')).state, readResult('').state], ['invalid', 'missing', 'missing']);

    // ---- The view ----
    const cfg = loadConfig();
    const opened = [];
    const reports = path.join(tmp, 'reports');
    fs.mkdirSync(reports, { recursive: true });
    const mkRun = (n, over = {}) => {
      const id = `AB42-${n}`;
      const r = { id, tracker: 'ado', ref: { id: 42 }, ticket: 'AB#42', title: 'Carts: retry failed payments', ticketUrl: 'https://dev.azure.com/o/Shop/_workitems/edit/42', status: 'done', startedAt: 1_700_000_000_000 + n * 3_600_000, endedAt: 1_700_000_000_000 + n * 3_600_000 + 842_000,
        reviewNo: n, prs: [prOf(A), prOf(B)], contextPrs: [], approved: { [B]: SHA }, awaitingHuman: [B], reviewedHeads: { [A]: SHA, [B]: SHA }, costUsd: 3.41, summary: { verdict: 'REQUEST CHANGES', critical: 1, high: 2, medium: 0, low: 1, nit: 0 },
        reportPath: path.join(reports, `${id}.md`), logPath, promptPath: path.join(tmp, 'logs', `${id}.prompt.md`), resultMode: 1, resultPath: path.join(reports, `${id}.result.json`), published, ...over };
      fs.writeFileSync(r.reportPath, '# report\n');
      fs.writeFileSync(r.promptPath, 'Review these PRs.\nThe prompt line two.\n');
      if (r.resultPath && !over.noResult) fs.writeFileSync(r.resultPath, JSON.stringify(result));
      return r;
    };
    const tuiOver = ({ reviewer = {}, builder = {}, cfgOver = {} } = {}) => {
      const app = { cfg: { ...cfg, ...cfgOver }, me: 'octocat', log: [], notes: null, override: {}, sideOn: n => app.override[n] ?? Boolean(app.cfg[n]?.enabled),
        tracker: () => ({ name: 'Azure DevOps', boardLabel: b => `${b.project} / ${b.team}` }), boards: () => [{ project: 'Shop', team: 'Web' }], dryRun: () => false, hasToken: () => false, speech: () => null, offers: [] };
      const mk = extra => ({ paused: false, polling: false, nextPoll: Date.now() + 60_000, lastError: '', running: () => [], needs: () => [], finished: () => [], history: () => [], waits: () => [], preparing: () => [], state: { runs: [] }, tagVariants: {}, stopText: () => 'Stop it?', ...extra });
      const calls = [];
      const tui = startTui(app, { sides: { reviewer: mk(reviewer), builder: mk(builder) }, pollNow() {}, togglePause() {}, saveConfig() {}, saveToken: () => '', quit() {}, stop: (...a) => calls.push(['stop', ...a]),
        quickReview: async () => { calls.push(['quickReview']); return null; }, toggleSide: () => true }, { headless: true, open: t => opened.push(t) });
      return { tui, app, calls, text: (w = 110, h = 26) => tui.frame(w, h).join('\n'), det: () => tui.ui.det[tui.ui.side] };
    };
    const type = (t, text) => { for (const ch of text) t.tui.key(ch); t.tui.key('enter'); };
    const flashOf = t => (Date.now() < t.tui.ui.flashUntil ? t.tui.ui.flash : '');

    const r1 = mkRun(1, { summary: { verdict: 'BLOCK' } });
    const r2 = mkRun(2);
    const r3 = mkRun(3, { status: 'failed', error: 'spend cap', reviewNo: 3 });
    const runs = [r1, r2, r3];
    let finished = [r3, r2, r1]; // newest first
    let running = [];
    const side = { finished: () => finished, running: () => running, state: { runs } };
    let t = tuiOver({ reviewer: side });
    t.tui.key('2');
    t.tui.key('down'); // r2
    t.text();
    t.tui.key('x');
    assert.deepEqual(opened.splice(0), [r2.reportPath], 'x in the list opens the report');
    t.tui.key('enter');
    let f = t.text(110, 46);
    assert.ok(f.includes('❮ back') && /AB#42\s+REQUEST CHANGES\s+Carts: retry failed payments/.test(f) && f.includes('[ review 2 of 3 ]'), f);
    assert.ok(/Summary\s+PRs \(2\)\s+Findings \(6\)\s+Session/.test(f) && f.includes(`Report   ${r2.reportPath}`) && f.includes('Review   re-review #2') && /Chain\s+r1 · r2 · r3 failed|Chain\s+r1 · r2 · r3/.test(f), f);
    assert.ok(f.includes('Goal     Deliver the retry queue.') && f.includes('Earlier  2 earlier findings: 1 still-present, 1 fixed') && f.includes('  Files') && /❯ Result\s+\S+AB42-2\.result\.json/.test(f), f);
    assert.ok(/AB#42, details|History, details/.test(f) && !/←\s+→\s+views/.test(f) && !/p\s+pause/.test(f), 'the bars: the details\' keys, and no p pause or ← → views');
    for (const want of ['PRs', 'Findings', 'Session', 'Summary']) { t.tui.key('right'); t.text(); assert.equal(['Summary', 'PRs', 'Findings', 'Session'][t.det().tab], want); }
    // Files: Prompt opens its text; the Session choice switches tab.
    t.tui.key('down'); t.tui.key('down');
    t.tui.key('enter');
    f = t.text();
    assert.ok(f.includes('The prompt line two.') && /Summary › Prompt/.test(f) && f.includes('esc back'), f);
    t.tui.key('x');
    assert.deepEqual(opened.splice(0), [r2.promptPath], 'x opens the file in front outside Prowl');
    t.tui.key('esc');
    t.tui.key('up');
    t.tui.key('enter');
    assert.equal(t.det().tab, 3, 'the Session file choice switches to the Session tab');
    // Session: Activity lines, then in full.
    f = t.text();
    assert.ok(f.includes('$3.41 · 14m02s') && f.includes('• Reading the PRs to retry.') && f.includes('• Bash Read the diff') && f.includes('↳ Read /x/retry.js') && f.includes('plain stderr line') && !f.includes('out 1'), f);
    assert.ok(t.tui.frame(110, 26, true).some(l => l.includes('\x1b[38;5;203m  plain stderr line')), 'a non-JSON line shows in red');
    t.tui.key('l');
    f = t.text(110, 80);
    assert.ok(flashOf(t).startsWith('The session in full') && f.includes('▸ Bash') && f.includes('command: gh pr diff 12') && f.includes('out 40') && f.includes('… 5 more lines') && !f.includes('out 41') && f.includes('Second line.'), f);
    t.tui.key('l');
    // Search in a session.
    t.tui.key('f');
    assert.ok(t.text().includes('Text to find in what is in front, then enter; n and N go to the next and previous match.'));
    type(t, 'retry');
    f = t.text();
    assert.ok(/retry\s+1 of 3 matches · n N next and previous · esc clears/.test(f), f);
    t.tui.key('n'); t.text(); t.tui.key('n'); t.text(); t.tui.key('n');
    assert.ok(/retry\s+1 of 3 matches/.test(t.text()), 'n moves on and wraps');
    t.tui.key('N');
    assert.ok(/retry\s+3 of 3 matches/.test(t.text()), 'N goes back');
    t.tui.key('esc');
    assert.ok(t.det() && !t.det().find && !t.text().includes('matches'), 'esc clears the search first');
    t.tui.key('p');
    assert.ok(t.text().includes('The prompt line two.'), 'p opens the prompt');
    t.tui.key('esc');
    // PRs, a PR's window, and text split across a label and a link.
    t.tui.key('left'); t.tui.key('left');
    f = t.text();
    assert.ok(/❯\s+widgets#12\s+critical · 3\s+PR 12 title/.test(f) && /api#7\s+high · 1/.test(f) && f.includes('Summary  Summary of 12.') && f.includes('Role     The producer.'), f);
    t.tui.key('enter');
    f = t.text(110, 50);
    assert.ok(f.includes(`PR       ${A}`) && f.includes('Reviewed at aaaaaaa') && f.includes('Axes     Correctness') && f.includes('Clean    Security') && f.includes('Rules    CLAUDE.md') && /GitHub\s+review\s+\S+#pullrequestreview-9/.test(f)
      && /details part 2\s+\S+#issuecomment-5/.test(f) && f.includes('Findings on this PR (5)'), f);
    t.tui.key('f');
    type(t, `pr        ${A}`.replace(/\s+/g, ' ').slice(0, 2)); // "pr"
    t.tui.key('esc');
    t.tui.key('f');
    type(t, 'at aaaaaaa');
    assert.ok(/1 of 1 match · /.test(t.text(110, 50)));
    t.tui.key('esc');
    t.tui.key('esc');
    assert.equal(t.det().stack.length, 0, 'esc closes the window');
    t.tui.key('down');
    t.tui.key('enter');
    f = t.text(110, 50);
    assert.ok(/Approved\s+at aaaaaaa · Prowl's stamp only: a person's approval is still needed/.test(f), f);
    t.tui.key('o');
    assert.deepEqual(opened.splice(0), [B], 'o opens the PR in front');
    t.tui.key('esc');
    // Findings: filters, a finding in full, and its neighbours.
    t.tui.key('right');
    f = t.text();
    assert.ok(/Showing all · any severity · 6 of 6 findings\s+s status · v severity/.test(f) && /❯\s+F-01\s+critical\s+confirmed\s+widgets#12\s+Title F-01/.test(f) && f.includes('Where    src/a b.js:88') && f.includes('Problem  Problem F-01.'), f);
    t.tui.key('s');
    assert.ok(flashOf(t) === 'Findings: counted.' && /Showing counted · any severity · 4 of 6 findings/.test(t.text()));
    t.tui.key('v'); t.tui.key('v');
    assert.ok(/Showing counted · high or worse · 3 of 6 findings/.test(t.text()), t.text());
    t.tui.key('enter');
    f = t.text(110, 50);
    assert.ok(/F-01\s+CRITICAL\s+confirmed\s+· Correctness\s+· counts toward the verdict/.test(f) && f.includes('Title F-01') && f.includes('Where    src/a b.js:88  · o opens it at the reviewed commit') && f.includes('Why      Why it breaks.')
      && f.includes('const a = 1;') && /GitHub\s+comment\s+\S+#discussion_r1/.test(f) && /resolve\s*$/m.test(f) && /1 of 3 · ← → esc back/.test(f), f);
    t.tui.key('o');
    assert.deepEqual(opened.splice(0), [`https://github.com/acme/widgets/blob/${SHA}/src/a%20b.js#L88`]);
    t.tui.key('right');
    assert.ok(t.text(110, 50).includes('Title F-03') && /2 of 3 · ← →/.test(t.text(110, 50)), 'right goes to the next one within the filters');
    // The result rewritten without it: the window keeps it, as it was.
    fs.writeFileSync(r2.resultPath, JSON.stringify(resultOf(result.findings.filter(x => x.id !== 'F-03'))));
    fs.utimesSync(r2.resultPath, new Date(), new Date(Date.now() + 5000));
    f = t.text(110, 50);
    assert.ok(f.includes("As it was when opened: the review result, or the filters, don't list it now.") && f.includes('Title F-03'), f);
    fs.writeFileSync(r2.resultPath, JSON.stringify(result));
    fs.utimesSync(r2.resultPath, new Date(), new Date(Date.now() + 9000));
    t.tui.key('esc');
    // The chain.
    t.tui.key(']');
    f = t.text();
    assert.ok(t.det().key === r3.id && t.det().tab === 2 && t.det().status === 1 && f.includes('[ review 3 of 3 ]') && /AB#42\s+FAILED/.test(f), '] shows the next review, keeps the tab and the filters');
    t.tui.key(']');
    assert.equal(flashOf(t), "This is AB#42's latest review.");
    t.tui.key('['); t.tui.key('['); t.tui.key('[');
    assert.deepEqual([t.det().key, flashOf(t)], [r1.id, "This is AB#42's first review."]);
    // Keys left to Prowl, and back to the list with the same row selected.
    t.tui.key('n');
    assert.ok(t.tui.ui.edit?.prs, 'n with no search is the usual quick review');
    t.tui.key('esc');
    t.tui.key('2'); // the quick review box opens over Running: back to History, where the details still are
    assert.ok(t.det() && t.text().includes('❮ back'), 'switching view and coming back finds them still open');
    t.tui.key('esc');
    assert.deepEqual([t.det(), t.tui.ui.sel.reviewer[1]], [null, 1], 'esc returns to the list with the same row selected');
    assert.deepEqual(cacheKeys(), [], 'closing the details frees the files they read');

    // A result that isn't one; a log that is gone; a getter that throws.
    fs.writeFileSync(r1.resultPath, 'not json');
    const noLog = mkRun(4, { logPath: path.join(tmp, 'logs', 'deleted.ndjson'), noResult: true, resultPath: path.join(reports, 'AB42-4.result.json') });
    const old = mkRun(5, { resultMode: undefined, resultPath: undefined });
    finished = [old, noLog, r1];
    t = tuiOver({ reviewer: { finished: () => finished, state: { runs: finished } }, cfgOver: { logRetentionDays: 30 } });
    t.tui.key('2'); t.tui.key('down'); t.tui.key('down');
    t.tui.key('enter'); t.tui.key('right'); t.tui.key('right');
    assert.ok(t.text().replace(/\s+/g, ' ').includes(`Its review result isn't a valid review result (${r1.resultPath}), so its findings can't be shown: x opens its report.`), t.text());
    t.tui.key('esc');
    t.tui.key('up');
    t.tui.key('enter'); t.tui.key('left');
    assert.ok(t.text().replace(/\s+/g, ' ').includes('The session log gone: Keep logs deletes session logs after 30 days. The report and findings are kept.'), t.text());
    t.tui.key('left');
    assert.ok(t.text().replace(/\s+/g, ' ').includes(`Its review result is missing (${noLog.resultPath}).`));
    t.tui.key('esc');
    t.tui.key('up');
    t.tui.key('enter'); t.tui.key('right'); t.tui.key('right');
    assert.ok(t.text().replace(/\s+/g, ' ').includes('This review has no review result, as it ran before Prowl kept findings as data: x opens its report, which has them.'));
    t.tui.key('esc');
    Object.defineProperty(old, 'promptPath', { get() { throw new Error('boom'); }, configurable: true }); // read only by the details
    t.tui.key('enter');
    f = t.text();
    assert.ok(t.det() === null && flashOf(t) === "Can't show those details: boom" && f.includes('History'), 'a getter that throws closes them');
    Object.defineProperty(old, 'promptPath', { value: '', writable: true });
    // A result URL that isn't a web link is shown as text, and o refuses it.
    fs.writeFileSync(r1.resultPath, JSON.stringify(resultOf([finding('F-01', { pr: A })], [prEntry(A, { related: [{ url: 'file:///etc/passwd', shares: 'x' }] }), prEntry(B)])));
    fs.utimesSync(r1.resultPath, new Date(), new Date(Date.now() + 20000));
    t.tui.key('down'); t.tui.key('down');
    t.tui.key('enter'); t.tui.key('right'); t.tui.key('enter');
    assert.ok(t.text(110, 50).includes('Related  file:///etc/passwd') && !t.tui.frame(110, 50, true).join('\n').includes('\x1b]8;;file:///etc/passwd'), 'shown as text, never a link');

    // A live run: opened from Running, it moves to History with its row; gone from both, the details close.
    const liveRun = mkRun(7, { status: 'running', endedAt: undefined, summary: undefined, noResult: true, ticket: 'AB#77' });
    running = [liveRun];
    finished = [];
    t = tuiOver({ reviewer: { finished: () => finished, running: () => running, state: { runs: [liveRun] } } });
    t.text();
    t.tui.key('enter');
    f = t.text();
    assert.ok(/AB#77\s+REVIEWING/.test(f) && f.includes('(when it finishes)') && /Status\s+reviewing · for /.test(f), f);
    t.tui.key('right'); t.tui.key('right');
    assert.ok(t.text().replace(/\s+/g, ' ').includes("It's still running: its findings show here once its session writes its review result."));
    t.tui.key('s');
    assert.ok(t.tui.ui.confirm, 's stops it, exactly as on its row (it asks first)');
    t.tui.key('n');
    Object.assign(liveRun, { status: 'done', endedAt: Date.now(), summary: { verdict: 'APPROVE' } });
    running = [];
    finished = [liveRun];
    f = t.text();
    assert.deepEqual([t.tui.ui.view.reviewer, t.det()?.tab, flashOf(t)], [1, 2, 'AB#77 is in History now (APPROVE): its details moved with it.']);
    finished = [];
    t.text();
    assert.equal(t.det(), null, 'gone from both lists: the details close');
    // A wait row has no session yet.
    t = tuiOver({ reviewer: { waits: () => [{ key: 'QUICK#9', title: 'w', since: 1, waitingOn: [] }] } });
    t.text();
    t.tui.key('enter');
    assert.equal(flashOf(t), 'It has no session yet: its details open once its review runs.');

    // A build: Summary, PRs, Turns; a turn's session and prompt; the current turn of a running build.
    const briefDir = path.join(tmp, 'brief');
    fs.mkdirSync(briefDir);
    fs.writeFileSync(path.join(briefDir, 'ticket.md'), '# The ticket\n');
    fs.writeFileSync(path.join(briefDir, 'plan.md'), '# The plan\n');
    fs.writeFileSync(path.join(briefDir, 'feedback-2.md'), 'round two\n');
    const t1log = path.join(tmp, 'logs', 'work-1.t1.ndjson');
    fs.writeFileSync(t1log, ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Opened acme/widgets#12 and wrote result.json.' }] } }));
    fs.writeFileSync(t1log.replace('.ndjson', '.prompt.md'), 'Build the thing.\n');
    const t2log = path.join(tmp, 'logs', 'work-1.t2.ndjson');
    fs.writeFileSync(t2log, ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on round one.' }] } }));
    const work = { uid: 'u1', key: 'AB#123', title: 'Build it', url: 'https://dev.azure.com/o/Shop/_workitems/edit/123', status: 'active', step: 'session', turnKind: 'round', rounds: 1, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_900_000, briefDir,
      plan: path.join(briefDir, 'plan.md'), prs: [{ ...prOf(A), state: 'open' }], repos: [{ repo: 'acme/widgets', branch: 'feat/x', worktree: briefDir, pr: prOf(A) }],
      turns: [{ n: 1, startedAt: 1_700_000_000_000, endedAt: 1_700_000_760_000, kind: 'build', logPath: t1log, costUsd: 2.1 }, { n: 2, startedAt: 1_700_000_800_000, kind: 'round', logPath: t2log, costUsd: 0 }], costUsd: 2.1 };
    let active = [work];
    t = tuiOver({ builder: { running: () => active, history: () => [work] }, cfgOver: { builder: { ...cfg.builder, enabled: true } } });
    t.tui.key('B');
    t.text();
    t.tui.key('x');
    assert.deepEqual(opened.splice(0), [briefDir]);
    t.tui.key('enter');
    f = t.text(120, 40);
    assert.ok(/AB#123\s+SESSION RUNNING/.test(f) && /Summary\s+PRs \(1\)\s+Turns \(2\)/.test(f) && f.includes("Turns    2 turns · 1 feedback round · the Turns tab has each one's session") && /Brief\s+\S+ticket\.md/.test(f) && /Plan\s+\S+plan\.md/.test(f) && /Round 2 feedback\s+\S+feedback-2\.md/.test(f), f);
    t.tui.key('right');
    f = t.text(120, 40);
    assert.ok(/❯\s+widgets#12\s+open\s+PR 12 title/.test(f) && /Worktree\s+\S+brief/.test(f), f);
    t.tui.key('right');
    f = t.text(120, 40);
    assert.ok(/❯\s+turn 1\s+\S+ \S+\s+\$2\.10\s+12m40s\s+build/.test(f) && /turn 2\s+\S+ \S+\s+running now\s+round/.test(f) && f.includes('Said     Opened acme/widgets#12 and wrote result.json.'), f);
    t.tui.key('f');
    type(t, 't2');
    assert.ok(/• turn 2/.test(t.text(120, 40)) && !/• turn 1/.test(t.text(120, 40)) && t.det().sel.turns === 1, 'matching rows carry •, and the first match is selected');
    t.tui.key('esc');
    t.tui.key('up');
    t.tui.key('p');
    assert.ok(t.text(120, 40).includes('Build the thing.'), "p on a turn opens that turn's prompt");
    t.tui.key('esc');
    t.tui.key('enter');
    assert.ok(t.text(120, 40).includes('• Opened acme/widgets#12 and wrote result.json.') && /Turns › turn 1/.test(t.text(120, 40)));
    t.tui.key('esc');
    t.tui.key('down');
    t.tui.key('enter');
    t.text(120, 40);
    fs.appendFileSync(t2log, ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'The newest line of the live turn.' }] } }));
    assert.ok(t.text(120, 40).includes('The newest line of the live turn.'), "the current turn's window follows");
    Object.assign(work, { status: 'following', step: null });
    active = [];
    t.text(120, 40);
    assert.deepEqual([t.tui.ui.view.builder, Boolean(t.det())], [1, true], 'no longer active: its details are found in History');
  } finally {
    dropCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
