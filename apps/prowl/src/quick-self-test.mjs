// Quick reviews, their GitHub labels and the offer for a paste of tickets, run by src/self-test.mjs with its counting
// assert: the paste parser, the label queue, the board lookups on both trackers, and the Reviewer over fakes of
// GitHub and the board. Nothing here reaches GitHub, a tracker or Claude Code.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ado from './ado.mjs';
import * as jira from './jira.mjs';
import { loadConfig } from './config.mjs';
import { ownNumstat } from './git.mjs';
import { guardFailures } from './guards.mjs';
import { createLabels, httpStatus, matching, refusal } from './labels.mjs';
import { acceptOffer, offerFor, sameBoard } from './offers.mjs';
import { cleanName, notARef, parsePaste, ticketKey } from './paste.mjs';
import { createReviewer } from './reviewer/reviewer.mjs';
import { buildPrompt, postMarker } from './reviewer/reviews.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const httpError = (code, why = 'Not Found') => new Error(`gh api repos/x failed: gh: ${why} (HTTP ${code})`);
const tick = () => new Promise(r => setTimeout(r, 0));

export async function run(assert, { appDir }) {
  pasting(assert);
  await queue(assert);
  await numstat(assert);
  await boards(assert);
  await reviews(assert, appDir);
}

// ---- What a paste holds ----

function pasting(assert) {
  const a = parsePaste('Please look at https://github.com/octo-org/api/pull/5/files, (octo-org/web#7) and AB#123.\nAlso https://dev.azure.com/o/Shop/_workitems/edit/124 and AB#123 again: covid-19', 'ado');
  assert.deepEqual(a.prs, [{ repo: 'octo-org/api', number: 5 }, { repo: 'octo-org/web', number: 7 }], 'PR links and owner/repo#n, each once, brackets and punctuation aside');
  assert.deepEqual(a.tickets, ['AB#123', 'AB#124'], 'Azure DevOps: AB#n and work item links, each once');
  assert.equal(a.rest, 'Please look at and\nAlso and again: covid-19', 'the rest is the text, lines kept');
  const j = parsePaste('PROJ-12 https://example.atlassian.net/browse/proj-13 fix the covid-19 page, not AB#5', 'jira');
  assert.deepEqual(j.tickets, ['PROJ-12', 'PROJ-13'], 'Jira: keys in capitals and browse links');
  assert.match(j.rest, /covid-19/, 'a lowercase word with a dash and a number is text, not a key');
  assert.match(j.rest, /AB#5/, "the other tracker's keys are text");
  assert.deepEqual([ticketKey('ab#9', 'ado'), ticketKey('AB#9', 'jira'), ticketKey('PROJ-1', 'ado')], ['AB#9', '', ''], 'keys for the task board only');
  assert.equal(notARef('  nope, octo-org/x#1'), 'nope', 'the first word a quick review can\'t take');
  assert.deepEqual([cleanName('"Save carts."\nmore'), cleanName(`x${'y'.repeat(80)}`).length, cleanName('\u0007')], ['Save carts', 60, ''], 'a name: one line, no quotes, at most 60 characters');
  assert.deepEqual(parsePaste('', 'ado'), { prs: [], tickets: [], rest: '' });
}

// ---- The label queue both sides share ----

async function queue(assert) {
  assert.deepEqual([httpStatus(httpError(404)), httpStatus(new Error('boom'))], [404, 0]);
  assert.ok([404, 410].every(c => refusal(httpError(c))) && refusal(httpError(403, 'Resource not accessible by integration')), '403, 404 and 410 last');
  assert.ok(!refusal(httpError(403, 'API rate limit exceeded for user')) && !refusal(httpError(502, 'Bad Gateway')), 'a rate limit and a 5xx pass');
  assert.deepEqual(matching(['ready-for-review', 'Reviewed', 'bug'], 'Ready for Review', 2), ['ready-for-review'], 'labels match tags loosely');
  assert.deepEqual(matching(['Ready for Reveiw'], 'Ready for Review', 0), [], '…and exactly with no typos allowed');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-labels-'));
  const on = { 'o/r#1': ['bug', 'Ready-for-review'], 'o/r#2': [], 'o/r#3': [] };
  const calls = [];
  let fail = {};
  let now = 1000;
  const gh = {
    prLabels: async pr => { if (fail[pr.number]) throw fail[pr.number](); return [...on[`${pr.repo}#${pr.number}`]]; },
    addLabel: async (pr, name) => { calls.push(['add', pr.number, name]); on[`${pr.repo}#${pr.number}`].push(name); },
    removeLabel: async (pr, name) => { calls.push(['remove', pr.number, name]); on[`${pr.repo}#${pr.number}`] = on[`${pr.repo}#${pr.number}`].filter(l => l !== name); },
  };
  const logs = [];
  const file = path.join(dir, 'labels.json');
  const q = createLabels({ gh, log: (side, level, msg) => logs.push([side, level, msg]), file, now: () => now });
  const pr = n => ({ url: `https://github.com/o/r/pull/${n}`, repo: 'o/r', number: n });
  q.set('reviewer', 'run1', pr(1), 'In Review', ['Ready for Review', 'Reviewed'], 2);
  q.set('reviewer', 'run1', pr(1), 'Reviewed', ['In Review', 'Ready for Review'], 2);
  assert.ok(q.pending(pr(1).url) && q.pending(pr(1).url, 'run1') && !q.pending(pr(1).url, 'run2'), 'queued');
  await q.drain();
  assert.deepEqual(calls, [['remove', 1, 'Ready-for-review'], ['add', 1, 'In Review'], ['remove', 1, 'In Review'], ['add', 1, 'Reviewed']], 'in the order asked, a loose match taken off');
  assert.deepEqual([on['o/r#1'], q.landed('run1', pr(1).url), q.pending(pr(1).url)], [['bug', 'Reviewed'], 'Reviewed', false], 'landed');
  // A transient failure waits a minute, and the PR's later writes wait behind it; other PRs go on.
  calls.length = 0;
  fail = { 2: () => httpError(502, 'Bad Gateway') };
  q.set('builder', 'w1', pr(2), 'In Development', ['Ready for Review']);
  q.set('builder', 'w1', pr(2), 'Ready for Review', ['In Development']);
  q.set('builder', 'w1', pr(3), 'In Development', ['Ready for Review']);
  await q.tick();
  assert.deepEqual([calls, q.pending(pr(2).url)], [[['add', 3, 'In Development']], true], 'a failing PR waits; the next PR goes on');
  assert.ok(logs.some(([s, l, m]) => s === 'builder' && /couldn't change its labels yet .*retrying every minute/.test(m)), 'logged on the side that asked');
  fail = {};
  await q.tick();
  assert.equal(calls.length, 1, 'not before the minute is up');
  now += 61_000;
  await q.drain();
  assert.deepEqual(on['o/r#2'], ['Ready for Review'], 'then retried, in order');
  // A newer owner of a PR's labels: the older owner's writes there are dropped.
  q.set('reviewer', 'old', pr(3), 'Reviewed', ['In Review']);
  q.own('reviewer', 'new', [pr(3).url]);
  q.set('reviewer', 'new', pr(3), 'In Review', ['Reviewed']);
  calls.length = 0;
  await q.drain();
  assert.deepEqual(calls, [['add', 3, 'In Review']], "a newer quick review owns the PR's labels");
  assert.equal(q.owner('builder', pr(3).url), '', "the Reviewer's owner of a PR's labels is the Reviewer's only: the Builder's writes there go on");
  // GitHub refuses: for that PR, for that owner, named in the Log; a rate limit is only for now.
  fail = { 1: () => httpError(403, 'Resource not accessible by integration') };
  q.set('reviewer', 'run1', pr(1), 'In Review', ['Reviewed']);
  q.set('reviewer', 'run1', pr(1), 'Reviewed', ['In Review']);
  await q.drain();
  assert.ok(q.refused('run1', pr(1).url) && !q.pending(pr(1).url), 'a refusal drops its writes there');
  assert.ok(logs.some(([, , m]) => /o\/r#1: GitHub won't let Prowl change its labels/.test(m)), 'and is named in the Log');
  q.set('reviewer', 'run1', pr(1), 'In Review', []);
  assert.ok(!q.pending(pr(1).url), 'and later writes of that review there are not queued');
  q.clearRefusal('run1', pr(1).url);
  fail = { 1: () => httpError(403, 'API rate limit exceeded') };
  q.set('reviewer', 'run1', pr(1), 'In Review', []);
  await q.tick();
  assert.ok(q.pending(pr(1).url) && !q.refused('run1', pr(1).url), 'a rate-limited 403 is retried');
  q.drop('run1');
  assert.ok(!q.pending(pr(1).url), 'drop: an owner\'s writes go');
  // A label already gone counts as removed.
  fail = {};
  gh.removeLabel = async () => {}; // as github.removeLabel does with a 404
  q.set('reviewer', 'run9', pr(2), '', ['Ready for Review']);
  await q.drain();
  assert.ok(!q.pending(pr(2).url), 'already removed: done');
  // Only the trigger label is taken off within the typo tolerance: the labels Prowl sets itself are matched exactly.
  on['o/r#2'] = ['Reviewer', 'In Preview', 'Ready for Reveiw', 'reviewed'];
  calls.length = 0;
  gh.removeLabel = async (p, name) => { calls.push(['remove', p.number, name]); on[`${p.repo}#${p.number}`] = on[`${p.repo}#${p.number}`].filter(l => l !== name); };
  q.set('reviewer', 'run9', pr(2), 'In Review', ['Ready for Review', 'Reviewed'], 2, ['Ready for Review']);
  await q.drain();
  assert.deepEqual([calls, on['o/r#2']], [[['remove', 2, 'Ready for Reveiw'], ['remove', 2, 'reviewed'], ['add', 2, 'In Review']], ['Reviewer', 'In Preview', 'In Review']], "a label that only looks like one of Prowl's own stays");
  on['o/r#2'] = ['Ready for Reveiw'];
  q.state().ops.push({ side: 'reviewer', owner: 'run9', url: pr(2).url, repo: 'o/r', number: 2, add: '', remove: ['Ready for Review'], typos: 2, at: now });
  await q.drain();
  assert.deepEqual(on['o/r#2'], ['Ready for Reveiw'], 'a write queued before 2.23.5 names no loose label: exact');
  assert.ok(createLabels({ gh, log() {}, file }).state().owners[`reviewer ${pr(3).url}`] === 'new', 'kept in labels.json across launches');
  fs.rmSync(dir, { recursive: true });
}

// ---- Only a session's own changes count, with the base merged in ----

async function numstat(assert) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-numstat-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'start');
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\n');
  g('commit', '-q', '-am', 'mine');
  const head = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n2\n');
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'big.txt'), `${'x\n'.repeat(500)}`);
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  g('add', '-A');
  g('commit', '-q', '-m', "the base's own work");
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'feature');
  try { g('merge', '-q', base); } catch { /* the conflict, resolved next */ }
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO and 2\n');
  g('commit', '-q', '-am', 'merge the base in');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'more of mine');
  const all = g('diff', '--numstat', `${head}..HEAD`);
  assert.match(all, /500\t0\tbig\.txt/, "the plain diff counts the base's 500 lines");
  const own = await ownNumstat(dir, head, base);
  const failed = guardFailures({ base: head, head: g('rev-parse', 'HEAD'), ancestor: true, remote: '', expected: '', numstat: own, diff: '' }, { maxChangedLines: 50, protectedPaths: ['.github/workflows/**'] });
  assert.deepEqual(failed, [], "with the base merged in, only the session's own changes count: not the base's lines, nor its workflow file");
  assert.match(own, /b\.txt/, 'its own commits');
  assert.match(own, /a\.txt/, "and the merge's conflict resolution");
  assert.equal(await ownNumstat(dir, g('rev-parse', 'HEAD~1'), base), g('diff', '--numstat', '-z', 'HEAD~1..HEAD'), 'no merge in the range: the plain diff');
  fs.rmSync(dir, { recursive: true });
}

// ---- The board a ticket is on, and the offer, on both trackers ----

async function boards(assert) {
  const realFetch = globalThis.fetch;
  const org = 'https://dev.azure.com/o';
  ado.primeToken(org, 'test-token');
  const teamPaths = { Web: [{ value: 'Shop\\Web', includeChildren: true }], Shop: [{ value: 'Shop', includeChildren: true }], Exact: [{ value: 'Shop\\Web\\Cart', includeChildren: false }], Other: null };
  const adoItems = {
    7: { id: 7, rev: 3, fields: { 'System.Title': 'Cart page', 'System.Tags': 'UI', 'System.State': 'Active', 'System.AreaPath': 'Shop\\Web\\Cart\\Mobile', 'System.TeamProject': 'Shop' } },
    8: { id: 8, rev: 1, fields: { 'System.Title': 'Done thing', 'System.Tags': '', 'System.State': 'Closed', 'System.AreaPath': 'Shop', 'System.TeamProject': 'Shop' } },
    9: { id: 9, rev: 1, fields: { 'System.Title': 'Being reviewed', 'System.Tags': 'In Review', 'System.State': 'Active', 'System.AreaPath': 'Shop', 'System.TeamProject': 'Shop' } },
    10: { id: 10, rev: 1, fields: { 'System.Title': 'Elsewhere', 'System.Tags': '', 'System.State': 'New', 'System.AreaPath': 'Billing', 'System.TeamProject': 'Shop' } },
  };
  const writes = [];
  globalThis.fetch = async (url, opts = {}) => {
    const p = decodeURIComponent(new URL(url).pathname);
    let m;
    if (p === '/o/_apis/projects/Shop/teams') return json({ value: Object.keys(teamPaths).map(name => ({ name })) });
    if ((m = /^\/o\/Shop\/([^/]+)\/_apis\/work\/teamsettings\/teamfieldvalues$/.exec(p))) {
      return teamPaths[m[1]] ? json({ field: { referenceName: 'System.AreaPath' }, values: teamPaths[m[1]] }) : json({ field: { referenceName: 'Custom.Team' }, values: [{ value: 'x' }] });
    }
    if ((m = /^\/o(?:\/Shop)?\/_apis\/wit\/workitems\/(\d+)$/.exec(p))) {
      const it = adoItems[m[1]];
      if (opts.method === 'PATCH') {
        const [test, edit] = JSON.parse(opts.body);
        if (test.value !== it.rev) return json({ message: 'outdated revision' }, 412);
        it.fields['System.Tags'] = edit.value;
        it.rev++;
        writes.push([it.id, edit.value]);
      }
      return json(it);
    }
    return json({ message: `no fixture for ${p}` }, 404);
  };
  const adoCfg = { ...loadConfig(), taskBoard: 'ado', ado: { org, boards: [{ project: 'Shop', team: 'Shop' }] } };
  const ticket = async id => ado.lookup(adoCfg, `AB#${id}`);
  const t7 = await ticket(7);
  assert.deepEqual([t7.closed, t7.area, (await ticket(8)).closed], [false, 'Shop\\Web\\Cart\\Mobile', true], 'Azure DevOps: a work item\'s state and area path');
  assert.deepEqual(await ado.boardOf(adoCfg, t7), { project: 'Shop', team: 'Web' }, 'the nearest team board: the longest area path that takes it in (not one without its children)');
  assert.equal(await ado.boardOf(adoCfg, await ticket(10)), null, 'no team takes it in: no board');
  const app = { cfg: adoCfg, boards: () => adoCfg.ado.boards, dryRun: () => false };
  let o = await offerFor(app, ado, [t7], 'In Review');
  assert.deepEqual([o.polled, o.boards, o.tickets[0].board], [false, ['Shop / Web'], { project: 'Shop', team: 'Web' }], 'on a board the side does not poll');
  adoCfg.ado.boards.push({ project: 'shop', team: 'WEB' });
  assert.equal((await offerFor(app, ado, [t7], 'In Review')).polled, true, 'boards compare without case');
  adoCfg.ado.boards.pop();
  for (const [id, why] of [[8, 'closed'], [9, 'In Review'], [10, 'no board']]) assert.equal(await offerFor(app, ado, [await ticket(id)], 'In Review'), null, `no offer: ${why}`);
  assert.equal(await offerFor(app, ado, [t7, await ticket(8)], 'In Review'), null, 'no offer when any of the tickets is not one for it');
  // Accepting: read again; boards added once, after the reads; tagged with the revision check.
  const logs = [];
  let saved = 0;
  const accept = (offer, extra = {}) => acceptOffer(app, ado, offer, { tag: 'Ready for Review', busyTag: 'In Review', isTag: t => /ready ?for ?review/i.test(t), addBoards: true, log: (l, m) => logs.push(m), saveConfig: () => saved++, ...extra });
  app.dryRun = () => true;
  assert.deepEqual([await accept(o), saved, writes.length], [[], 0, 0], 'a dry run only logs');
  assert.ok(logs.some(l => /would add Shop \/ Web/.test(l)) && logs.some(l => /would tag it 'Ready for Review'/.test(l)));
  app.dryRun = () => false;
  assert.deepEqual(await accept(o), ['AB#7'], 'tagged');
  assert.deepEqual([writes.at(-1), saved, adoCfg.ado.boards.length], [[7, 'UI; Ready for Review'], 1, 2], 'its board added, config written once');
  assert.deepEqual([await accept(o), writes.length, saved], [[], 1, 1], 'already tagged: not tagged again, and its board already there');
  assert.ok(logs.some(l => /already tagged 'Ready for Review'; not tagged again/.test(l)));
  adoCfg.ado.boards.pop();
  adoItems[7].fields['System.Tags'] = 'In Review';
  assert.deepEqual([await accept(o), saved], [[], 1], 'In Review since: left alone, and no board added');
  assert.ok(logs.some(l => /AB#7: left alone: it is 'In Review' now/.test(l)));
  adoItems[7].fields['System.State'] = 'Done';
  adoItems[7].fields['System.Tags'] = '';
  await accept(o);
  assert.ok(logs.some(l => /AB#7: left alone: it is closed now/.test(l)) && adoCfg.ado.boards.length === 1, 'closed since: left alone');
  adoItems[7].fields['System.State'] = 'Active';
  const rivalAdo = { ...ado, readItem: async (...a) => { const t = await ado.readItem(...a); adoItems[7].rev++; return t; } }; // someone writes after the read
  assert.deepEqual(await acceptOffer(app, rivalAdo, o, { tag: 'Ready for Review', busyTag: 'In Review', isTag: () => false, addBoards: false, log: (l, m) => logs.push(m), saveConfig() {} }), [], 'the revision check holds');
  assert.ok(logs.some(l => /AB#7: not tagged: it changed meanwhile/.test(l)));
  // config.json re-read while the tickets are read again (a new app.cfg): the board goes into the config that is saved.
  const reread = { cfg: adoCfg, boards: () => reread.cfg.ado.boards, dryRun: () => false };
  const rereading = { ...ado, readItem: async (...a) => { const t = await ado.readItem(...a); reread.cfg = structuredClone(reread.cfg); return t; }, claim: async () => {} };
  await acceptOffer(reread, rereading, o, { tag: 'Ready for Review', busyTag: 'In Review', isTag: () => false, addBoards: true, log() {}, saveConfig() {} });
  assert.deepEqual(reread.cfg.ado.boards.at(-1), { project: 'Shop', team: 'Web' }, 'a board is added to the config in use when it is saved, not the one read before the tickets were');

  // Jira: the board holding the issue, of its project's boards; a name that repeats is named by its id.
  const jiraIssues = { 'SHOP-1': { labels: ['ui'], status: 'indeterminate' }, 'SHOP-2': { labels: [], status: 'done' }, 'SHOP-3': { labels: [], status: 'new' } };
  const onBoard = { 7: ['SHOP-9'], 8: ['SHOP-1'], 9: ['SHOP-3'] };
  const jiraBoards = [{ id: 7, name: 'Shop board' }, { id: 8, name: 'Cart board' }, { id: 9, name: 'Shop board' }];
  globalThis.fetch = async url => {
    const u = new URL(url);
    const p = u.pathname;
    let m;
    if (p === '/rest/agile/1.0/board') return json({ values: u.searchParams.get('projectKeyOrId') === 'SHOP' ? jiraBoards : [] });
    if ((m = /^\/rest\/agile\/1\.0\/board\/(\d+)\/issue$/.exec(p))) {
      const key = /key = (\S+)/.exec(u.searchParams.get('jql'))[1];
      return json({ issues: onBoard[m[1]].includes(key) ? [{ key }] : [], total: 0 });
    }
    if ((m = /^\/rest\/api\/3\/issue\/(SHOP-\d+)\/changelog$/.exec(p))) return json({ total: 2, values: [] });
    if ((m = /^\/rest\/api\/3\/issue\/(SHOP-\d+)$/.exec(p))) {
      const it = jiraIssues[m[1]];
      return json({ id: '100', key: m[1], fields: { summary: m[1], labels: it.labels, status: { statusCategory: { key: it.status } } } });
    }
    if (p === '/rest/dev-status/latest/issue/detail') {
      return json({ detail: [{ branches: [{ name: 'feature/SHOP-1-x', url: 'https://github.com/octo-org/web/tree/feature/SHOP-1-x', repository: { url: 'https://github.com/octo-org/web' } },
        { name: 'SHOP-1-elsewhere', url: 'https://gitlab.example/x', repository: { url: 'https://gitlab.example/team/x' } }] }] });
    }
    return json({ errorMessages: [`no fixture for ${p}`] }, 404);
  };
  process.env.JIRA_API_TOKEN = 'test-token';
  const jiraCfg = { ...loadConfig(), taskBoard: 'jira', jira: { site: 'https://example.atlassian.net', email: 'me@example.invalid', boards: [{ board: 'Cart board' }], fields: {} } };
  const j1 = await jira.lookup(jiraCfg, 'SHOP-1');
  assert.deepEqual([j1.closed, (await jira.lookup(jiraCfg, 'SHOP-2')).closed], [false, true], "Jira: an issue's status category");
  assert.deepEqual(await jira.boardOf(jiraCfg, j1), { board: 'Cart board' }, 'the board holding the issue');
  assert.deepEqual(await jira.boardOf(jiraCfg, await jira.lookup(jiraCfg, 'SHOP-3')), { board: '9' }, 'by id when another board has its name');
  const japp = { cfg: jiraCfg, boards: () => jiraCfg.jira.boards, dryRun: () => false };
  assert.equal((await offerFor(japp, jira, [j1], 'In Review')).polled, true, 'on a polled board');
  // A board the config watches is named as config.json names it, and wins over an earlier board that holds the issue too.
  jiraCfg.jira.boards = [{ board: '8' }];
  assert.deepEqual(await jira.boardOf(jiraCfg, j1), { board: '8' }, 'a board watched by its id is named by its id');
  assert.equal((await offerFor(japp, jira, [j1], 'In Review')).polled, true, 'so the offer sees it as polled, and does not add it again by name');
  jiraCfg.jira.boards = [{ board: 'cart board' }];
  onBoard[7].push('SHOP-1');
  assert.deepEqual(await jira.boardOf(jiraCfg, j1), { board: 'cart board' }, 'on two boards: the watched one, not the first');
  onBoard[7].pop();
  jiraCfg.jira.boards = [{ board: 'Cart board' }];
  assert.equal(await offerFor(japp, jira, [await jira.lookup(jiraCfg, 'SHOP-2')], 'In Review'), null, 'closed: no offer');
  assert.ok(sameBoard({ board: 'cart Board' }, { board: 'Cart board' }) && !sameBoard({ board: '8' }, { board: 'Cart board' }), 'Jira boards by name, without case');
  assert.deepEqual(await jira.linkedBranches(jiraCfg, { key: 'SHOP-1' }), [
    { branch: 'feature/SHOP-1-x', repo: 'octo-org/web', url: 'https://github.com/octo-org/web/tree/feature/SHOP-1-x' },
    { branch: 'SHOP-1-elsewhere', repo: '', url: 'https://gitlab.example/x' }], "dev info's branches: GitHub ones with their repo, another host's without");
  globalThis.fetch = async () => json({ errorMessages: ['nope'] }, 404);
  assert.deepEqual(await jira.linkedBranches(jiraCfg, { key: 'SHOP-1' }), [], 'no dev info: none, and names are matched instead');
  // Azure DevOps' GitHub links: the connection id, then the branch or PR, split on the first %2F in any case.
  assert.deepEqual(ado.githubLinks(['vstfs:///GitHub/Branch/c0ffee-1%2Ffeature%2F12345-cart', 'vstfs:///GitHub/PullRequest/c0ffee-1%2f77', 'vstfs:///Git/Commit/x%2Fy', 'vstfs:///GitHub/Branch/nope']),
    { branches: [{ id: 'c0ffee-1', branch: 'feature/12345-cart' }], prs: [{ id: 'c0ffee-1', number: 77 }] }, 'GitHub branch and PR links');
  // A board with more open labelled issues than Prowl reads says how many it left unread.
  const reads = [];
  globalThis.fetch = async url => {
    const at = Number(new URL(url).searchParams.get('startAt'));
    reads.push(at);
    return json({ total: 2350, issues: Array.from({ length: 100 }, (x, i) => ({ key: `SHOP-${at + i}`, fields: { summary: 's', labels: at + i === 1999 ? ['Ready-for-Review'] : ['ui'] } })) });
  };
  const big = await jira.findTickets(jiraCfg, { board: '7' }, t => t === 'Ready-for-Review');
  assert.deepEqual([big.tickets.map(t => t.key), big.unread, reads.length], [['SHOP-1999'], 350, 20], 'Jira: the first 2000 are read, and the rest counted');
  globalThis.fetch = async url => json({ total: 150, issues: Array.from({ length: Number(new URL(url).searchParams.get('startAt')) ? 50 : 100 }, (x, i) => ({ key: `SHOP-${i}`, fields: { labels: ['ui'] } })) });
  assert.equal((await jira.findTickets(jiraCfg, { board: '7' }, () => false)).unread, 0, 'a board read whole: none unread');
  globalThis.fetch = realFetch;
}

// ---- Quick reviews: pastes, names, labels and waits ----

/** GitHub, in memory, for the Reviewer: PRs by number, each with its ticket, head, labels and state. */
function reviewerGitHub() {
  const prs = {};
  const add = (n, extra = {}) => (prs[n] = { url: `https://github.com/octo-org/r${n}/pull/${n}`, title: `PR ${n}`, number: n, repo: `octo-org/r${n}`, author: 'teammate', draft: false, state: 'open', headSha: `sha${n}`, labels: [], ticket: '', ...extra });
  const of = pr => prs[pr.number];
  return {
    prs, add,
    me: async () => 'octocat',
    prByRef: async ({ number }) => {
      const p = prs[number];
      if (!p || p.gone) throw httpError(404);
      if (p.flaky) throw httpError(502, 'Bad Gateway');
      return { url: p.url, title: p.title, number: p.number, repo: p.repo, author: p.author, draft: p.draft, state: p.state, headSha: p.headSha, labels: [...p.labels] };
    },
    openPrs: async (owner, key) => Object.values(prs).filter(p => p.ticket === key && p.state === 'open').map(p => ({ url: p.url, title: p.title, number: p.number, repo: p.repo, author: p.author, draft: p.draft })),
    headSha: async pr => of(pr).headSha,
    cloneMissing: async () => [],
    postComment: async () => '',
    reviewedSince: async () => true,
    isOpen: async pr => of(pr).state === 'open',
    humanApproved: async () => false,
    prLabels: async pr => { if (of(pr).noLabels) throw httpError(403, 'Resource not accessible by integration'); return [...of(pr).labels]; },
    addLabel: async (pr, name) => { of(pr).labels.push(name); },
    removeLabel: async (pr, name) => { of(pr).labels = of(pr).labels.filter(l => l !== name); },
  };
}

async function reviews(assert, appDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-quick-'));
  const gh = reviewerGitHub();
  const tickets = {
    'AB#42': { key: 'AB#42', title: 'Save carts', url: 'https://dev.azure.com/o/Shop/_workitems/edit/42', tags: ['Web'], closed: false, area: 'Shop', rev: 1, ref: { org: 'https://dev.azure.com/o', project: 'Shop', id: 42 } },
    'AB#43': { key: 'AB#43', title: 'Closed one', url: 'u43', tags: [], closed: true, ref: { id: 43 } },
  };
  const tracker = {
    name: 'Azure DevOps', boardLabel: b => `${b.project} / ${b.team}`,
    lookup: async (c, key) => { if (!tickets[key]) throw new Error('not found'); return structuredClone(tickets[key]); },
    readItem: async (c, ref) => structuredClone(Object.values(tickets).find(t => t.ref.id === ref.id)),
    boardOf: async (c, t) => (t.key === 'AB#42' ? { project: 'Shop', team: 'Web' } : null),
    claim: async (c, t, drop, add) => { tagged.push([t.key, add]); },
    findTickets: async () => ({ tickets: [], variants: [] }),
  };
  const tagged = [];
  const logs = [];
  const cfg = { ...loadConfig(), githubOwner: 'octo-org', workDir: tmp, quickName: 'number', maxConcurrentReviews: 3, maxReviewRounds: 0 };
  const app = { cfg, me: '', on: true, sideOn() { return this.on; }, tracker: () => tracker, boards: () => [{ project: 'Shop', team: 'Web' }], dryRun: () => false };
  const labels = createLabels({ gh, log: (s, l, m) => logs.push(m), file: path.join(tmp, 'labels.json') });
  const names = [];
  const side = createReviewer(app, {
    log: (level, msg) => { logs.push(msg); return true; }, forget() {}, hoot() {}, appDir, trackers: { ado: tracker }, github: gh, labels,
    autoName: async (c, about) => { names.push(about); return 'Cart saving work'; }, saveConfig() {},
  });
  side.state = { runs: [], failures: {} };
  const started = [];
  side.startReview = (c, dir, o) => {
    const id = `${o.ticket.key.replace(/[^A-Za-z0-9-]/g, '')}-r${(o.prior?.reviewNo || 0) + 1}-${started.length}`;
    const run = { id, tracker: null, ticket: o.ticket.key, ticketUrl: o.ticket.url, title: o.ticket.title, prs: o.prs, contextPrs: o.approvedPrs, leftOut: o.leftOut, reviewNo: (o.prior?.reviewNo || 0) + 1,
      status: 'running', quick: o.quick, startedAt: Date.now(), marker: postMarker(id), approved: Object.fromEntries((o.approvedPrs || []).map(p => [p.url, o.prior.approved[p.url]])),
      reportPath: path.join(tmp, `${id}.md`), logPath: path.join(tmp, `${id}.ndjson`), endedAt: 0 };
    started.push({ ...o, run });
    return run;
  };
  /** Ends `run` as done, approving `approve` (PR numbers) at their heads now. */
  const finishDone = async (run, approve = []) => {
    fs.writeFileSync(run.reportPath, `---\nverdict: approve\napproved: ${approve.map(n => `${gh.prs[n].url}@${gh.prs[n].headSha}`).join(' ')}\n---\n`);
    run._result = { subtype: 'success', is_error: false, total_cost_usd: 1 };
    await side.finish(run);
    run.endedAt = Date.now();
  };
  const finishFailed = async (run, extra = {}) => { Object.assign(run, extra); run._result = { subtype: 'error_during_execution', is_error: true, result: 'boom' }; await side.finish(run); };
  const poll = async () => { await labels.drain(); await side.poll(); await labels.drain(); };
  const only = what => side.waits().filter(w => w.key === what);

  // A paste that isn't PRs or tickets stays an error; free text has no place in a quick review.
  await assert.rejects(side.quickReview('please review AB#42'), /please isn't a PR or a ticket/, 'free text stays an error');
  await assert.rejects(side.quickReview(''), /at least one PR or ticket/);
  await assert.rejects(side.quickReview('AB#99'), /couldn't read AB#99/, 'a ticket that can\'t be read');

  // A paste of only a ticket on a board, with labels on: an offer first, not a review.
  gh.add(1, { ticket: 'AB#42' });
  gh.add(2, { ticket: 'AB#42' });
  gh.add(3, { ticket: 'AB#42', draft: true });
  let r = await side.quickReview('AB#42');
  assert.deepEqual([Boolean(r.offer), r.offer?.polled, r.offer?.side, started.length], [true, true, 'reviewer', 0], 'an offer pops up, and nothing starts');
  await assert.rejects(side.quickReview('AB#43'), /no open, ready PR mentions AB#43 yet/, 'a closed ticket gets no offer: its quick review goes ahead (and has no PRs here)');
  // Turned down (Review it now): the quick review goes ahead, under the ticket's key and title.
  r = await side.answerOffer(r.offer, 'review');
  assert.deepEqual([r.ticket, r.title, started[0].prs.map(p => p.number), started[0].quick], ['AB#42', 'Save carts', [1, 2], true], "one ticket: its open, ready PRs, under its key and title");
  assert.ok(buildPrompt({ ...r, prior: null, contextPrs: [], leftOut: [] }).includes('- Ticket: AB#42 "Save carts" (https://dev.azure.com/o/Shop/_workitems/edit/42). This is a quick review'), 'its brief names the ticket');
  await labels.drain();
  assert.deepEqual([gh.prs[1].labels, gh.prs[2].labels, gh.prs[3].labels], [['In Review'], ['In Review'], []], 'labelled In Review as it starts; the draft is left out');
  assert.deepEqual(tagged, [], 'no tag written on the ticket');
  // Done, approving #1: Reviewed on both, and it waits on #2, the PR it didn't approve.
  await finishDone(r, [1]);
  await labels.drain();
  assert.deepEqual([gh.prs[1].labels, gh.prs[2].labels], [['Reviewed'], ['Reviewed']], 'labelled Reviewed when done');
  assert.deepEqual(only('AB#42').map(w => w.waitingOn), [[gh.prs[2].url]], 'waiting on the PR it did not approve');
  assert.ok(logs.some(l => /AB#42: labelled 'Reviewed'; waiting for 'Ready for Review' on r2#2/.test(l)));
  // A Ready for Review label counts only after Prowl's own Reviewed label has landed.
  labels.set('reviewer', r.id, gh.prs[2], 'Reviewed', ['Ready for Review']);
  gh.prs[2].labels = ['Ready-for-review'];
  await side.poll();
  assert.equal(started.length, 1, 'Ready for Review before our Reviewed lands: not counted');
  await labels.drain();
  gh.prs[2].labels.push('Ready for Reveiw'); // loose: a typo still counts
  // A PR labelled In Review holds the wait (another Prowl, say), unless it is approved and only context.
  gh.prs[1].labels = ['In Review'];
  await side.poll();
  assert.equal(started.length, 2, 'every PR it did not approve labelled Ready for Review: re-reviewed; the approved one in review only context');
  assert.match(only('AB#42')[0]?.notes?.[0] || logs.find(l => /approved and only context/.test(l)) || 'its note: approved and only context', /approved and only context/);
  r = started[1].run;
  assert.deepEqual([r.ticket, r.reviewNo, started[1].prs.map(p => p.number), started[1].approvedPrs.map(p => p.number)], ['AB#42', 2, [2], [1]], 'the same key, review 2, the approved PR as context');
  await labels.drain();
  assert.deepEqual([gh.prs[1].labels, gh.prs[2].labels], [['In Review'], ['In Review']], 'context: Ready for Review taken off (none here); the PR under review labelled In Review');
  // New PRs on a pasted ticket join; with every PR approved, Ready for Review alone keeps it waiting.
  await finishDone(r, [2]);
  gh.prs[1].labels = ['Reviewed'];
  await labels.drain();
  gh.add(4, { ticket: 'AB#42' });
  gh.prs[4].labels = ['Ready for Review'];
  await side.poll();
  assert.deepEqual(started.at(-1).prs.map(p => p.number), [4], 'a new PR on the ticket joins: reviewed, the approved ones context');
  await finishDone(started.at(-1).run, [4]);
  await labels.drain();
  gh.prs[2].labels.push('Ready for Review');
  await side.poll();
  assert.equal(started.length, 3, 'every PR approved: Ready for Review alone keeps it waiting');
  assert.ok(logs.some(l => /no PR has new commits since it was approved; still waiting/.test(l)));
  gh.prs[2].headSha = 'sha2b';
  await side.poll();
  assert.deepEqual(started.at(-1).prs.map(p => p.number), [2], 'Ready for Review and new commits since the approval: re-reviewed');
  // A failed re-review is retried once (apart from the ticket's tagged-review failures), then its labels come off.
  await finishFailed(started.at(-1).run);
  assert.deepEqual([side.state.quickFailures['AB#42'], side.state.failures['AB#42'], only('AB#42')[0]?.retry], [1, undefined, true], 'one retry, counted apart');
  assert.ok(logs.some(l => /Retrying it once, when a slot is free/.test(l)));
  await side.poll();
  assert.equal(started.length, 5, 'retried at the next poll, without waiting for labels');
  await finishFailed(started.at(-1).run);
  await labels.drain();
  assert.deepEqual([only('AB#42').length, gh.prs[2].labels], [0, []], 'not retried again: the wait ends and In Review comes off');
  assert.ok(logs.some(l => /AB#42: review failed: .*Not retrying again/.test(l)));

  // Several PRs and no ticket: QUICK#n, named per Quick names. auto: a short model call; the paste's text and titles.
  for (const n of [5, 6]) gh.add(n);
  cfg.quickName = 'auto';
  r = await side.quickReview('octo-org/r5#5 https://github.com/octo-org/r6/pull/6');
  assert.deepEqual([r.ticket, r.title], ['QUICK#1', 'Cart saving work'], 'auto: named by the model');
  assert.ok(names[0].includes('octo-org/r5#5: PR 5'), 'from the PRs');
  cfg.quickName = 'ask';
  await finishDone(r, []);
  r = await side.quickReview('octo-org/r5#5', { name: '  My own name ' });
  assert.deepEqual([r.ticket, r.title], ['QUICK#2', 'My own name'], 'ask: the name typed');
  assert.equal(only('QUICK#1').length, 1, 'another quick review on the same PRs is its own; the older wait carries on');
  await labels.drain();
  assert.equal(labels.owner('reviewer', gh.prs[5].url), r.id, "but the newer one owns the PRs' labels");
  await finishFailed(r, { status: 'stopping' });
  r = await side.quickReview('octo-org/r6#6', { as: 'AB#42' });
  assert.equal(r.ticket, 'AB#42', 'as: a ticket runs under its key');
  await finishDone(r, []);
  cfg.quickName = 'number';
  r = await side.quickReview('octo-org/r5#5', { as: 'Named here' });
  assert.deepEqual([r.ticket, r.title], ['QUICK#3', 'Named here'], 'as: a name');
  await finishDone(r, []);
  // The wait ends: every PR merged, closed or unreadable; at the round cap; or a lasting start failure.
  gh.prs[5].state = 'merged';
  await poll();
  assert.equal(only('QUICK#3').length, 0, 'every PR merged: the wait ends');
  assert.ok(logs.some(l => /QUICK#3: no longer waiting on its PRs: every PR is merged, closed or can no longer be read/.test(l)));
  gh.prs[5].state = 'open';
  for (const n of [7, 8]) gh.add(n);
  r = await side.quickReview('octo-org/r7#7 octo-org/r8#8');
  await finishDone(r, []);
  await labels.drain();
  gh.prs[8].gone = true; // a pasted PR GitHub won't show any more: let go, and it doesn't hold the wait
  gh.prs[7].labels = ['Ready for Review'];
  await poll();
  assert.deepEqual(started.at(-1).prs.map(p => p.number), [7], "a pasted PR that can't be read doesn't hold the wait");
  assert.ok(logs.some(l => /r8#8 no longer holds the wait: .*HTTP 404/.test(l)), 'named in the Log');
  const wait7 = only(started.at(-1).run.ticket);
  await finishDone(started.at(-1).run, []);
  await labels.drain();
  gh.prs[8].gone = false;
  await poll();
  assert.ok(!only(started.at(-1).run.ticket)[0]?.letGo?.[gh.prs[8].url], 'once it can be read again, it holds the wait again');
  assert.ok(wait7);
  gh.prs[7].draft = true;
  gh.prs[7].labels = ['Ready for Review'];
  gh.prs[8].labels = ['Ready for Review'];
  await side.poll();
  assert.equal(only(started.at(-1).run.ticket).length, 0, 'a lasting start failure ends the wait');
  assert.ok(logs.some(l => /its re-review can't start: r7#7 is a draft/.test(l)), 'the Log names the drafts');
  // Labels GitHub refuses on a PR: let go for this review, named in the Log.
  gh.add(9);
  gh.add(10);
  r = await side.quickReview('octo-org/r9#9 octo-org/r10#10');
  gh.prs[10].noLabels = true;
  await finishDone(r, []);
  await poll();
  gh.prs[9].labels.push('Ready for Review');
  await side.poll();
  assert.deepEqual(started.at(-1).prs.map(p => p.number), [9, 10], "a PR whose labels GitHub refuses no longer holds the wait: the other one's label starts the re-review, of both");
  assert.ok(logs.some(l => /r10#10: GitHub won't let Prowl change its labels/.test(l)) && logs.some(l => /r10#10 no longer holds the wait: GitHub refuses it/.test(l)), 'named in the Log');
  await finishDone(started.at(-1).run, []);
  await labels.drain();
  // The round cap ends a wait; so does a new review of the same ticket; a slot is waited for; a dry run only logs.
  cfg.maxReviewRounds = 2;
  gh.prs[9].labels = ['Ready for Review'];
  gh.prs[10].noLabels = false;
  await labels.drain();
  await side.poll();
  assert.ok(logs.some(l => /QUICK#\d+: no longer waiting on its PRs: it has had 2 reviews, the round cap/.test(l)), 'the round cap ends a wait');
  cfg.maxReviewRounds = 0;
  gh.add(11);
  r = await side.quickReview('octo-org/r11#11');
  await finishDone(r, []);
  await labels.drain();
  gh.prs[11].labels = ['Ready for Review'];
  cfg.maxConcurrentReviews = 0;
  await side.poll();
  assert.ok(logs.some(l => /ready for its re-review, waiting for a slot/.test(l)), 'it waits for a slot');
  cfg.maxConcurrentReviews = 3;
  app.dryRun = () => true;
  const before = started.length;
  await side.poll();
  assert.ok(started.length === before && logs.some(l => /would re-review it/.test(l)), 'a dry run only logs');
  app.dryRun = () => false;
  side.stopWait(only(r.ticket)[0]);
  assert.equal(only(r.ticket).length, 0, 's stops the wait');
  assert.ok(logs.some(l => /stopped by you; its labels stay as they are/.test(l)));
  // Labels off: today's quick review: no labels, no wait, never retried.
  cfg.quickLabels = false;
  gh.add(12);
  r = await side.quickReview('octo-org/r12#12');
  await finishFailed(r);
  await labels.drain();
  assert.deepEqual([gh.prs[12].labels, only('QUICK#' + r.ticket.split('#')[1]).length], [[], 0], 'labels off: none written, no wait');
  assert.ok(logs.some(l => /Not retried; n reviews PRs again/.test(l)), 'and not retried');
  assert.equal((await side.quickReview('AB#42')).offer, undefined, 'labels off: no offer for a ticket');
  cfg.quickLabels = true;
  // A one-shot run (--once): the offer is logged, and the quick review goes ahead.
  side.state.runs = side.state.runs.filter(x => x.status !== 'running');
  r = await side.quickReview('AB#42', { oneShot: true });
  assert.ok(r.ticket === 'AB#42' && logs.some(l => /AB#42: could be tagged 'Ready for Review' instead; reviewing now, as asked/.test(l)), 'one-shot: logged, and reviewed');
  await assert.rejects(side.quickReview('octo-org/r12#12', { as: 'AB#42' }), /AB#42 is being reviewed already/, 'one review of a key at a time');
  await finishDone(r, []);
  // A paste with a PR gets no offer.
  r = await side.quickReview('AB#42 octo-org/r12#12');
  assert.equal(r.offer, undefined, 'a paste with a PR: no offer');
  // Tag it: the offer tags the ticket for review, with the tracker's concurrency check.
  const offered = (await side.quickReview('AB#42', { name: 'Typed name' })).offer;
  assert.equal(offered.name, 'Typed name', 'the offer keeps the name typed (Quick names: ask), for Review it now');
  assert.deepEqual(await side.answerOffer(offered, 'tag'), ['AB#42'], 'Tag it');
  assert.deepEqual(tagged.at(-1), ['AB#42', 'Ready for Review'], 'tagged with the review trigger');
  // A tagged review of the ticket starting ends its quick review's wait.
  side.state.runs = side.state.runs.filter(x => x.status !== 'running'); // a review running for it would hold the tagged one back
  side.state.runs.push({ id: 'held', ticket: 'AB#42', status: 'done', quick: true, endedAt: Date.now(), prs: [], approved: {}, reviewNo: 1, reportPath: '/nowhere.md' });
  gh.prs[1].labels = ['In Review']; // the wait holds: someone is reviewing it
  side.waits().push({ key: 'AB#42', title: 't', paste: { prs: [], tickets: ['AB#42'] }, runId: 'held', since: 1, letGo: {} });
  tracker.findTickets = async () => ({ tickets: [{ ...tickets['AB#42'], tags: ['Ready for Review'] }], variants: ['Ready for Review'] });
  await side.poll();
  assert.ok(logs.some(l => /AB#42: no longer waiting on its PRs: its tagged review started/.test(l)) && !only('AB#42').length, "the ticket's tagged review starting ends its quick review's wait");
  fs.rmSync(tmp, { recursive: true, force: true });
}
