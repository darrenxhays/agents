// The Builder's self-test, run by src/self-test.mjs with its counting assert. The trackers run against hand-written
// REST fakes (self-test-fixtures/), GitHub against an in-memory fake, sessions are scripted, and pushes land in local
// bare repos. Nothing here reaches a real tracker, GitHub or Claude Code.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ado from '../ado.mjs';
import * as jira from '../jira.mjs';
import { CHECKS_PATH, loadConfig } from '../config.mjs';
import { mentions } from '../match.mjs';
import * as brief from './brief.mjs';
import { createBuilder } from './builder.mjs';
import { ensureClone } from './repos.mjs';
import * as rules from './rules.mjs';
import { workArgs, workEnv } from './session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, '..', '..');
const fixture = name => fs.readFileSync(path.join(HERE, 'self-test-fixtures', name), 'utf8');
const read = file => fs.readFileSync(file, 'utf8');
const ME_ADO = 'octocat@example.invalid';
// Test commits: no identity, signing or hooks from the machine's own git config.
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Prowl Test', '-c', 'user.email=prowl@example.invalid', '-c', 'commit.gpgsign=false', ...a],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// ---- Fakes ----

const tagsOf = i => String(i.fields['System.Tags'] || '').split(';').map(t => t.trim()).filter(Boolean);

/** Azure DevOps REST, from self-test-fixtures/ado.json: work items whose tags and revisions change as Prowl writes. */
function adoServer() {
  const items = JSON.parse(fixture('ado.json'));
  const calls = [];
  const view = it => ({ id: it.id, rev: it.rev, fields: it.fields, relations: it.relations });
  const setTags = (it, tags) => {
    const old = it.fields['System.Tags'] || '';
    it.fields['System.Tags'] = tags.join('; ');
    it.rev++;
    it.updates.push({ rev: it.rev, fields: { 'System.Tags': { oldValue: old, newValue: it.fields['System.Tags'] } } });
  };
  async function fetch(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const p = decodeURIComponent(u.pathname);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(`${method} ${p}${body?.query ? ` ${body.query}` : ''}`);
    let m;
    if (p.endsWith('/_apis/work/teamsettings/teamfieldvalues')) return json({ field: { referenceName: 'System.AreaPath' }, values: [{ value: 'Shop', includeChildren: true }] });
    if (p === '/o/Shop/_apis/wit/tags') return json({ value: [...new Set(Object.values(items).flatMap(tagsOf))].map(name => ({ name })) });
    if (p === '/o/Shop/_apis/wit/wiql') {
      const tagged = [...body.query.matchAll(/CONTAINS '([^']+)'/g)].map(x => x[1]);
      const mine = body.query.includes('[System.AssignedTo] = @Me');
      return json({ workItems: Object.values(items).filter(i => tagsOf(i).some(t => tagged.includes(t)) && (!mine || i.fields['System.AssignedTo']?.uniqueName === ME_ADO)).map(i => ({ id: i.id })) });
    }
    if (/^\/o(?:\/Shop)?\/_apis\/wit\/workitems$/.test(p)) return json({ value: u.searchParams.get('ids').split(',').map(id => items[id] && view(items[id])) });
    if ((m = /^\/o(?:\/Shop)?\/_apis\/wit\/workitems\/(\d+)$/.exec(p))) {
      const it = items[m[1]];
      if (!it) return json({ message: `work item ${m[1]} not found` }, 404);
      if (method !== 'PATCH') return json(view(it));
      const [test, edit] = body;
      if (test.value !== it.rev) return json({ message: `The update is based on an outdated revision (${test.value})` }, 412);
      setTags(it, edit.value.split(';').map(t => t.trim()).filter(Boolean));
      return json(view(it));
    }
    if ((m = /^\/o\/Shop\/_apis\/wit\/workItems\/(\d+)\/comments$/.exec(p))) return json({ comments: items[m[1]].comments });
    if ((m = /^\/o\/Shop\/_apis\/wit\/workItems\/(\d+)\/updates$/.exec(p))) {
      const skip = Number(u.searchParams.get('$skip') || 0);
      return json({ value: items[m[1]].updates.slice(skip, skip + 200) });
    }
    return json({ message: `no fixture for ${method} ${p}` }, 404);
  }
  return { items, calls, fetch, tags: id => tagsOf(items[id]), setTags: (id, tags) => setTags(items[id], tags) };
}

/** Jira Cloud REST, from self-test-fixtures/jira.json: issues whose labels and changelogs change as Prowl writes. */
function jiraServer() {
  const issues = JSON.parse(fixture('jira.json'));
  const changelog = {};
  const calls = [];
  let rival = false; // another copy of Prowl, on the same account, claims first on the next label write
  const edit = (key, ops, who = 'Octo Cat') => {
    const labels = issues[key].fields.labels;
    const before = [...labels];
    for (const op of ops) {
      if (op.remove) labels.splice(0, labels.length, ...labels.filter(l => l !== op.remove));
      if (op.add && !labels.includes(op.add)) labels.push(op.add);
    }
    if (before.join(' ') !== labels.join(' ')) (changelog[key] ??= []).push({ author: { displayName: who }, items: [{ field: 'labels', fromString: before.join(' '), toString: labels.join(' ') }] });
  };
  async function fetch(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const p = u.pathname;
    const q = u.searchParams;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(`${method} ${p}${q.get('jql') ? ` ${q.get('jql')}` : ''}`);
    let m;
    if (p === '/rest/agile/1.0/board') return json({ values: [{ id: 7, name: 'Shop board' }] });
    if (p === '/rest/agile/1.0/board/7/issue') {
      const mine = q.get('jql').includes('assignee = currentUser()');
      const list = Object.values(issues).filter(i => i.fields.labels.length && (!mine || i.fields.assignee?.accountId === 'acct-me'));
      return json({ issues: list.map(i => ({ key: i.key, fields: { summary: i.fields.summary, labels: i.fields.labels, assignee: i.fields.assignee } })), total: list.length });
    }
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/changelog$/.exec(p))) {
      const all = changelog[m[1]] || [];
      const at = Number(q.get('startAt') || 0);
      return json({ total: all.length, values: all.slice(at, at + Number(q.get('maxResults') || 100)) });
    }
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/remotelink$/.exec(p))) return json(issues[m[1]].remote || []);
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(p))) {
      const it = issues[m[1]];
      if (!it) return json({ errorMessages: ['Issue does not exist'] }, 404);
      if (method === 'PUT') {
        const ops = body.update.labels;
        if (rival && ops.some(op => /^prowl-claim-/.test(op.add || ''))) {
          rival = false;
          edit(m[1], [{ remove: 'Ready-to-Start' }, { add: 'In-Development' }, { add: 'prowl-claim-rival' }]);
        }
        edit(m[1], ops);
        return new Response(null, { status: 204 });
      }
      const fields = Object.fromEntries((q.get('fields') || '').split(',').filter(Boolean).map(f => [f, it.fields[f] ?? null]));
      return json({ key: it.key, fields });
    }
    return json({ errorMessages: [`no fixture for ${method} ${p}`] }, 404);
  }
  return { issues, changelog, calls, fetch, rivalNext: () => { rival = true; }, labels: key => issues[key].fields.labels, edit };
}

/** GitHub, in memory: the PRs Prowl opens, their reviews, threads, checks and replies. Heads are read from the bare repos. */
function githubFake(bares) {
  const prs = [];
  const head = (repo, branch) => execFileSync('git', ['ls-remote', bares[repo], `refs/heads/${branch}`], { encoding: 'utf8' }).split(/\s/)[0];
  const find = pr => prs.find(p => p.url === pr.url || (p.repo === pr.repo && p.number === pr.number));
  const view = p => ({ url: p.url, title: p.title, number: p.number, repo: p.repo, author: p.author, draft: p.draft, state: p.state });
  return {
    prs,
    me: async () => 'octocat',
    openPrs: async (owner, key) => prs.filter(p => p.state === 'OPEN' && mentions(`${p.title} ${p.body}`, key)).map(view),
    prsMentioning: async (owner, key) => prs.filter(p => mentions(`${p.title} ${p.body}`, key)).map(view),
    createPr: async (repo, file) => {
      const d = JSON.parse(read(file));
      const number = prs.length + 1;
      const url = `https://github.com/${repo}/pull/${number}`;
      prs.push({ repo, number, url, title: d.title, body: d.body, head: d.head, base: d.base, draft: d.draft, state: 'OPEN', author: 'octocat', reviews: [], threads: [], checks: [], replies: [] });
      return { url, number };
    },
    prForBranch: async (repo, branch) => { const p = prs.find(x => x.repo === repo && x.head === branch && x.state === 'OPEN'); return p ? { url: p.url, number: p.number } : null; },
    editPr: async (pr, file) => { find(pr).body = JSON.parse(read(file)).body; },
    prFacts: async pr => {
      const p = find(pr);
      return { state: p.state, draft: p.draft, fork: false, headBranch: p.head, headSha: head(p.repo, p.head), base: p.base, defaultBranch: 'main', author: p.author, reviewDecision: '' };
    },
    prReviews: async pr => find(pr).reviews,
    prThreads: async pr => find(pr).threads,
    requiredChecks: async url => find({ url }).checks,
    detailsFromGitHub: async () => '',
    prCommentBodies: async pr => find(pr).replies.map(r => r.body),
    postReply: async (pr, commentId, file) => { find(pr).replies.push({ commentId, body: JSON.parse(read(file)).body }); return `${pr.url}#reply`; },
    failedLog: async () => 'Error: 1 test failed',
  };
}

/** A scripted session: `script(w, prompt)` does the turn's work and returns { result, cost, subtype }. */
function fakeSession(script) {
  const turns = [];
  return {
    turns,
    start(cfg, appDir, w, prompt, budget) {
      turns.push({ key: w.key, prompt, budget, resumed: Boolean(w.sessionStarted), sessionId: w.sessionId });
      Object.assign(w, { startedAt: Date.now(), logPath: path.join(w.briefDir, 'no-log.ndjson'), sessionStarted: true, pid: null });
      const out = script(w, prompt, turns.length) || {};
      fs.mkdirSync(w.briefDir, { recursive: true });
      if (out.result !== undefined) fs.writeFileSync(path.join(w.briefDir, 'result.json'), typeof out.result === 'string' ? out.result : JSON.stringify(out.result));
      w._result = { type: 'result', subtype: out.subtype || 'success', is_error: Boolean(out.subtype), total_cost_usd: out.cost ?? 1 };
    },
    alive: () => false,
    kill() {},
  };
}

/** A bare repo for `repo` (owner/name) with one commit on main, and any `branches` off it. */
function makeRemote(root, repo, branches = []) {
  const bare = path.join(root, 'remotes', `${repo}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  const seed = path.join(root, 'seed', repo);
  execFileSync('git', ['clone', '-q', bare, seed], { stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Start');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  for (const b of branches) git(seed, 'push', '-q', 'origin', `HEAD:refs/heads/${b}`);
  return bare;
}

/** Commits `files` ({ path: text }) in a worktree; resolves with the new commit. */
function commit(dir, files, message) {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * A Builder over the fakes, in its own folders. `board`: 'ado' or 'jira'. Resolves with { b, app, server, gh, session,
 * logs, bares, cfg, root, poll() (one poll, then every step that follows) }.
 */
function harness(board, script, { cfgOver = {}, trackerWrap = t => t } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-builder-')));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  const bares = { 'octo-org/web': makeRemote(root, 'octo-org/web', ['release/1.9', 'release/1.10']), 'octo-org/api': makeRemote(root, 'octo-org/api') };
  const server = board === 'ado' ? adoServer() : jiraServer();
  globalThis.fetch = server.fetch;
  const cfg = loadConfig();
  Object.assign(cfg, {
    taskBoard: board, githubOwner: 'octo-org', workDir: projects,
    ado: { org: 'https://dev.azure.com/o', boards: [{ project: 'Shop', team: 'Web' }] },
    jira: { site: 'https://example.atlassian.net', email: ME_ADO, boards: [{ board: 'Shop board' }], fields: { acceptanceCriteria: 'customfield_10042', reproSteps: '' } },
  });
  Object.assign(cfg.builder, { enabled: true, waitForChecksMinutes: 0 }, cfgOver);
  const logs = [];
  const app = { cfg, me: 'octocat', on: true, sideOn(n) { return n === 'builder' ? this.on : false; }, tracker: () => (board === 'ado' ? ado : jira), boards: () => cfg[board].boards, dryRun: () => false };
  const gh = githubFake(bares);
  const session = fakeSession(script);
  const trackers = { ado, jira };
  const b = createBuilder(app, {
    log: (level, msg) => { logs.push(`${level} ${msg}`); return true; }, forget() {}, hoot() {}, appDir: APP_DIR, trackers,
    tracker: trackerWrap(board === 'ado' ? ado : jira), github: gh, session, notify() {},
    clone: (repo, target) => new Promise((ok, fail) => { try { execFileSync('git', ['clone', '-q', bares[repo], target], { stdio: 'ignore' }); ok(); } catch (e) { fail(e); } }),
    statePath: path.join(root, 'work.json'),
  });
  const poll = async () => { await b.poll(); await b.drain(); };
  return { b, app, server, gh, session, logs, bares, cfg, root, projects, poll, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const remoteHas = (bare, branch) => execFileSync('git', ['ls-remote', bare, `refs/heads/${branch}`], { encoding: 'utf8' }).trim() !== '';
const remoteFile = (bare, branch, file) => execFileSync('git', ['--git-dir', bare, 'show', `${branch}:${file}`], { encoding: 'utf8' });
const worktreeOf = (w, repo) => w.repos.find(r => r.repo === repo).worktree;

/** The session most builds use: investigate (asking for octo-org/api), plan both repos, then commit in both. */
const twoRepoBuild = (overrides = {}) => (w, prompt) => {
  if (prompt.startsWith('/prowl:prowl-work ')) {
    fs.writeFileSync(path.join(w.briefDir, 'investigation.md'), '# Investigation\n');
    return { result: { status: 'needs-repos', repos: [{ repo: 'octo-org/api', why: 'the API stores carts' }], investigation: 'investigation.md' } };
  }
  if (prompt.startsWith('repos ready:')) {
    fs.writeFileSync(path.join(w.briefDir, 'plan.md'), '# Plan\n');
    return { result: { status: 'needs-approval', plan: 'plan.md', changes: [{ repo: 'octo-org/web' }, { repo: 'octo-org/api' }], openQuestions: overrides.questions || [] } };
  }
  if (prompt.startsWith('answers:') || prompt.startsWith('plan feedback:')) return { result: { status: 'needs-approval', plan: 'plan.md', changes: [{ repo: 'octo-org/web' }, { repo: 'octo-org/api' }], openQuestions: [] } };
  if (prompt.startsWith('approve') || prompt.startsWith('checks failed:') || prompt.startsWith('continue:')) {
    const files = overrides.files || { web: { 'src/cart.js': 'export const save = cart => cart;\n' }, api: { 'src/carts.js': 'export const store = () => {};\n' } };
    const again = prompt.startsWith('approve') ? '' : `// turn ${w.turns.length}\n`; // a later turn commits on top
    const commits = [['octo-org/web', files.web], ['octo-org/api', files.api]]
      .map(([repo, f]) => ({ repo, sha: commit(worktreeOf(w, repo), Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v + again])), `${w.key}: save carts`) }));
    return { result: { status: 'done', commits, prs: commits.map(c => ({ repo: c.repo, title: `${w.key}: Save the cart (${c.repo.split('/')[1]})`, body: `Saves carts.\n\n${w.key}` })),
      checks: commits.map(c => ({ repo: c.repo, command: 'npm test', result: 'pass' })), summary: 'Carts are saved.' } };
  }
  return { result: 'unexpected prompt' };
};

export async function run(assert) {
  const realFetch = globalThis.fetch;
  const envBefore = { ...process.env };
  // Prowl's own git calls in these tests use no global git config (no hooks, no signing) and no tracker token from this machine.
  const emptyGitConfig = path.join(os.tmpdir(), `prowl-empty-gitconfig-${process.pid}`);
  fs.writeFileSync(emptyGitConfig, '');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1', JIRA_API_TOKEN: 'test-token' });
  ado.primeToken('https://dev.azure.com/o', 'test-token');
  jira.claimWait.ms = 0;
  try {
    await pure(assert);
    await trackersTests(assert);
    await builds(assert);
    await feedback(assert);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
    Object.assign(process.env, envBefore);
    fs.rmSync(emptyGitConfig, { force: true });
    jira.claimWait.ms = 2000;
  }
}

// ---- Pure rules: repos, bases, branches, the result contract, caps, follow-up ----

async function pure(assert) {
  assert.equal(rules.branchName('prowl/{id}-{slug}', 'AB#123', 'Save the cart between visits!'), 'prowl/123-save-the-cart-between-visits', "an Azure DevOps work item's number");
  assert.equal(rules.branchName('prowl/{id}-{slug}', 'PROJ-123', 'Save the cart', 2), 'prowl/PROJ-123-save-the-cart-2', 'a Jira key as typed; a rebuild gets -2');
  assert.ok(rules.slug('A very long title that goes on and on well past forty characters').length <= 40);
  const remote = ['main', 'develop', 'release/1.9', 'release/1.10', 'release/1.2'];
  assert.deepEqual(rules.pickBase({ 'octo-org/web': 'release/*' }, 'octo-org/web', { remote, defaultBranch: 'main' }), { base: 'release/1.10' }, 'a branch glob takes the highest version');
  assert.deepEqual(rules.pickBase({ 'octo-org/*': 'develop', 'octo-org/web': 'release/*' }, 'octo-org/web', { remote, defaultBranch: 'main' }), { base: 'develop' }, 'the first rule that matches wins');
  assert.match(rules.pickBase({ 'octo-org/web': 'trunk' }, 'octo-org/web', { remote, defaultBranch: 'main' }).error, /isn't on its remote/);
  assert.deepEqual(rules.pickBase({}, 'octo-org/web', { planBase: 'develop', remote, defaultBranch: 'main' }), { base: 'develop' }, "no rule: the plan's base, if the remote has it");
  assert.deepEqual(rules.pickBase({}, 'octo-org/web', { planBase: 'gone', remote, defaultBranch: 'main' }), { base: 'main' }, 'otherwise the default branch');
  assert.deepEqual(rules.repoCandidates(['See https://github.com/octo-org/web/pull/4 and https://github.com/orgs/octo-org/teams', 'repo: octo-org/api\n- repo: `octo-org/jobs`'], ['octo-org/WEB', 'other-org/lib']),
    ['octo-org/web', 'octo-org/api', 'octo-org/jobs', 'other-org/lib'], "the ticket's links and repo: lines, then the PRs' repos, each once");
  const ownCfg = { githubOwner: 'octo-org', builder: { extraOwners: ['octo-labs'] } };
  assert.ok(rules.ownerAllowed('octo-org/web', ownCfg) && rules.ownerAllowed('Octo-Labs/x', ownCfg) && !rules.ownerAllowed('other-org/lib', ownCfg));
  const tagCfg = { tagMatchMaxTypos: 2, builder: { tags: { start: 'Ready to Start', inProgress: 'In Development', done: 'Ready for Review', reviewing: 'In Review' } } };
  const t = rules.builderTags(tagCfg);
  assert.ok(t.isStart('ready-to-start') && t.isStart('Redy to Start') && t.isStart('Ready-to-Start') && !t.isStart('In Development'), 'the start tag, loosely');
  assert.ok(t.ours('In-Development') && !t.ours('In Developmnt'), 'its own tags, exactly');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-test-'));
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan');
  const ok = { status: 'done', commits: [{ repo: 'octo-org/web', sha: 'abc1234' }], prs: [{ repo: 'octo-org/web', title: 'AB#1: x', body: '' }], checks: [] };
  assert.equal(rules.validateBuild(ok, dir), '');
  assert.equal(rules.validateBuild({ status: 'needs-approval', plan: 'plan.md', changes: [{ repo: 'octo-org/web' }], openQuestions: [] }, dir), '');
  assert.equal(rules.validateBuild({ status: 'needs-repos', repos: [{ repo: 'octo-org/api', why: 'x' }] }, dir), '');
  assert.equal(rules.validateBuild({ status: 'question', question: { id: 'Q1', question: 'Which?' } }, dir), '');
  assert.equal(rules.validateBuild({ status: 'blocked', reason: 'no access' }, dir), '');
  for (const [r, why] of [[{ status: 'finished' }, /status/], [{ status: 'needs-repos', repos: [] }, /no repos/], [{ status: 'needs-approval', plan: 'missing.md' }, /isn't in the brief folder/],
    [{ ...ok, commits: [] }, /no commits/], [{ ...ok, commits: [{ repo: 'octo-org/web', sha: 'zzz' }] }, /not a commit sha/], [{ ...ok, prs: [] }, /no PR title/],
    [{ ...ok, commits: [{ repo: 'web', sha: 'abc1234' }] }, /owner\/name/], [{ status: 'blocked' }, /reason/], [{ status: 'question', question: {} }, /a question needs/], [[], /not a JSON object/]]) {
    assert.match(rules.validateBuild(r, dir), why, `invalid: ${JSON.stringify(r).slice(0, 60)}`);
  }
  fs.rmSync(dir, { recursive: true });

  const since = Date.parse('2026-10-29T10:00:00Z');
  const thread = (at, extra = {}) => ({ id: 'T1', resolved: false, body: 'Handle empty carts', lastBody: 'Handle empty carts', lastAt: at, bot: false, ...extra });
  assert.equal(rules.feedbackDue({ reviews: [{ user: 'lead', state: 'CHANGES_REQUESTED', at: '2026-10-29T11:00:00Z' }] }, since, 'everyone'), 'lead requested changes');
  assert.equal(rules.feedbackDue({ reviews: [{ state: 'CHANGES_REQUESTED', at: '2026-10-29T09:00:00Z' }] }, since, 'everyone'), '', 'older than the last push: no round');
  assert.equal(rules.feedbackDue({ threads: [thread('2026-10-29T11:00:00Z')] }, since, 'everyone'), '1 unresolved thread');
  assert.equal(rules.feedbackDue({ threads: [thread('2026-10-29T11:00:00Z')] }, since, 'prowl'), '', "Fix comments from Prowl: someone else's thread isn't feedback");
  assert.equal(rules.feedbackDue({ threads: [thread('2026-10-29T11:00:00Z', { lastBody: 'Fixed\n<!-- prowl-fix AB#1 r1 T1 fixed -->' })] }, since, 'everyone'), '', 'Prowl replied last');
  const approved = { reviews: [{ state: 'CHANGES_REQUESTED', at: '2026-10-29T09:00:00Z' }, { state: 'COMMENTED', at: '2026-10-29T12:00:00Z' }, { state: 'APPROVED', at: '2026-10-29T11:00:00Z' }], threads: [], checks: [{ bucket: 'pass' }] };
  const now = Date.parse('2026-10-29T12:00:00Z');
  assert.ok(rules.mergeReady([approved], since, now), 'approved, no threads, checks green');
  assert.ok(!rules.mergeReady([{ ...approved, threads: [thread('x')] }], since, now) && !rules.mergeReady([{ ...approved, checks: [{ bucket: 'pending' }] }], since, now));
  assert.ok(!rules.mergeReady([{ ...approved, checks: [] }], now - 5 * 60_000, now), 'no required checks 5 minutes after a push: CI not started yet');
  assert.ok(rules.mergeReady([{ ...approved, checks: [] }], now - 11 * 60_000, now), 'after 10 minutes: a repo that requires none');
  assert.ok(!rules.mergeReady([{ ...approved, reviews: [...approved.reviews, { state: 'CHANGES_REQUESTED', at: '2026-10-29T11:30:00Z' }] }], since, now), "the latest review isn't an approval");
  const recs = [{ key: 'AB#1', costUsd: 3, turns: [{ startedAt: Date.now(), costUsd: 3 }] }, { key: 'AB#1', costUsd: 2, turns: [{ startedAt: 0, costUsd: 2 }] }, { key: 'AB#2', costUsd: 1, turns: [{ startedAt: Date.now(), costUsd: 1 }] }];
  assert.deepEqual([rules.ticketSpend(recs, 'AB#1'), rules.daySpend(recs)], [5, 4], 'every run on the ticket; sessions since midnight');
  assert.deepEqual([rules.spendLevel(6, 10), rules.spendLevel(7, 10), rules.spendLevel(10, 10), rules.spendLevel(1e6, 0)], ['', 'warn', 'over', '']);
  for (const kind of ['question', 'plan', 'repos', 'blocked', 'cap', 'checks', 'guard', 'conflict', 'failed']) {
    const item = rules.needItem(kind, { key: 'AB#1', question: `${kind}?`, context: ['a', 'b', 'c', 'd'] });
    assert.ok(item.id.startsWith('AB#1:') && item.kind === kind && item.context.length === 3 && Array.isArray(item.options));
  }

  // The brief: the prompts and the resume messages, in the result contract's words.
  const bp = brief.buildPrompt({ command: '', briefDir: '/w/AB123', ticket: { key: 'AB#123', title: 'Save', url: 'https://dev.azure.com/o/Shop/_workitems/edit/123' },
    repos: [{ repo: 'octo-org/web', worktree: '/p/.prowl-worktrees/work-AB123/web', defaultBranch: 'main' }], unavailable: [{ repo: 'other-org/lib', why: "it isn't under the GitHub org" }] });
  assert.ok(bp.startsWith(`/prowl:prowl-work ${path.join('/w/AB123', 'ticket.md')}\n`) && bp.includes('octo-org/web: /p/.prowl-worktrees/work-AB123/web (detached at main') && bp.includes('other-org/lib: it isn'));
  assert.ok(brief.buildPrompt({ command: '/my-build', briefDir: '/w', ticket: { key: 'AB#1', title: '', url: '' }, repos: [] }).startsWith('/my-build '), 'builder.command replaces the skill');
  assert.equal(brief.resume.repos([{ repo: 'octo-org/api', worktree: '/wt/api' }], [{ repo: 'other-org/lib', why: 'not allowed' }]), 'repos ready:\nocto-org/api: /wt/api\n\nrepos not available:\nother-org/lib: not allowed');
  assert.ok(brief.resume.approve([{ repo: 'octo-org/web', branch: 'prowl/1-x' }]).startsWith('approve\nocto-org/web: prowl/1-x\n'));
  assert.equal(brief.resume.answers([{ id: 'Q1', answer: 'Yes' }, { id: 'blocked', answer: 'Use the sandbox' }]), 'answers:\nQ1: Yes\nblocked: Use the sandbox');
  assert.equal(brief.resume.planFeedback('Split it in two'), 'plan feedback: Split it in two');
  assert.equal(brief.resume.checksFailed([{ repo: 'octo-org/web', command: 'npm test', output: 'boom\n' }]), 'checks failed:\nocto-org/web: npm test\n\nboom');
  assert.match(brief.resume.invalid('status must be one of …'), /^result\.json invalid: status must be/);
  assert.equal(brief.resume.continue('go on'), 'continue: go on');
  const fb = brief.feedbackMd({ ticket: { key: 'AB#123', title: 'Save', url: 'u' }, round: 2, maxRounds: 3, prs: [{ pr: { repo: 'octo-org/web', number: 4, url: 'https://github.com/octo-org/web/pull/4', title: 'Save' },
    branch: 'prowl/123-save', headSha: 'abc1234', worktree: '/wt/web-4', details: '# Details', reviews: [{ user: 'lead', at: '2026-10-29T11:00:00Z', body: 'Please handle empty carts.' }],
    threads: [{ id: 'PRRT_1', author: 'lead', path: 'src/cart.js', line: 3, url: 'https://github.com/octo-org/web/pull/4#discussion_r1', body: 'Empty carts?\n<!-- prowl-review rb F-01 -->', lastBody: 'Empty carts?\n<!-- prowl-review rb F-01 -->' }] }] });
  assert.ok(fb.includes('## octo-org/web#4: Save') && fb.includes('detached at its head, abc1234') && fb.includes('#### Thread PRRT_1') && fb.includes('> Please handle empty carts.') && !fb.includes('<!-- prowl-review'));
  assert.ok(brief.feedbackPrompt({ briefDir: '/w', feedbackPath: '/w/feedback-1.md' }).startsWith('/prowl:prowl-work feedback /w/feedback-1.md\n'));

  // The session's arguments and environment: one session id, resumed; fenced as kind 'work'; never a tracker token.
  const scfg = { ...loadConfig(), workDir: '/p', taskBoard: 'jira', jira: { site: 'https://example.atlassian.net' } };
  const w = { id: 'AB123', briefDir: '/w/AB123', sessionId: 'uuid-1', sessionStarted: false, turnKind: 'build', repos: [{ worktree: '/wt/web' }, { worktree: '/wt/api' }] };
  const args = workArgs(scfg, '/app', w, '/w/AB123/settings.json', 12.5);
  assert.deepEqual(args.slice(0, 9), ['-p', '--plugin-dir', '/app', '--add-dir', '/wt/web', '--add-dir', '/wt/api', '--add-dir', '/w/AB123']);
  assert.ok(args.includes('--session-id') && !args.includes('--resume') && args[args.indexOf('--max-budget-usd') + 1] === '12.5' && args[args.indexOf('--model') + 1] === scfg.claude.model);
  assert.ok(args.includes('--strict-mcp-config') && args.includes('mcp__*') && args[args.indexOf('--settings') + 1] === '/w/AB123/settings.json' && args.at(-1) === '--verbose');
  assert.ok(workArgs({ ...scfg, builder: { ...scfg.builder, model: 'build-model', mcpAllow: ['mcp__docs__*'] } }, '/app', { ...w, sessionStarted: true }, '/s', 0).join(' ').includes('--model build-model --effort high'));
  assert.ok(!workArgs({ ...scfg, builder: { ...scfg.builder, mcpAllow: ['mcp__docs__*'] } }, '/app', w, '/s', 0).includes('--strict-mcp-config'), 'some MCP tools allowed: the servers load');
  assert.ok(workArgs(scfg, '/app', { ...w, sessionStarted: true }, '/s', 0).includes('--resume'));
  const env = workEnv(scfg, w, { PATH: '/bin', JIRA_API_TOKEN: 'secret', AZURE_DEVOPS_EXT_PAT: 'secret' });
  assert.equal(env.PROWL_SESSION, 'work');
  assert.equal(env.PROWL_WORK_ROOTS, ['/wt/web', '/wt/api', '/w/AB123'].join(path.delimiter));
  assert.ok(env.PROWL_BRIEF_DIR === '/w/AB123' && env.PROWL_UNATTENDED === '1' && env.PROWL_TRACKER_HOSTS.includes('https://example.atlassian.net'));
  assert.ok(!('JIRA_API_TOKEN' in env) && !('AZURE_DEVOPS_EXT_PAT' in env), 'never a tracker token');
}

// ---- The trackers' board access, through the REST fakes ----

async function trackersTests(assert) {
  const cfg = { ...loadConfig(), ado: { org: 'https://dev.azure.com/o', boards: [] }, jira: { site: 'https://example.atlassian.net', email: ME_ADO, boards: [], fields: { acceptanceCriteria: 'customfield_10042', reproSteps: '' } } };
  const isStart = rules.builderTags(cfg).isStart;
  const owned = rules.builderTags(cfg).owned;
  const a = adoServer();
  globalThis.fetch = a.fetch;
  assert.equal(ado.name, 'Azure DevOps');
  assert.equal(ado.boardLabel({ project: 'Shop', team: 'Web' }), 'Shop / Web');
  let found = await ado.findTickets(cfg, { project: 'Shop', team: 'Web' }, isStart, { assignedToMe: true });
  assert.deepEqual(found.tickets.map(t => t.key), ['AB#123'], 'assigned to me only');
  assert.ok(a.calls.some(c => c.includes('[System.AssignedTo] = @Me')));
  found = await ado.findTickets(cfg, { project: 'Shop', team: 'Web' }, isStart);
  assert.deepEqual(found.tickets.map(t => t.key).sort(), ['AB#123', 'AB#126'], 'without it, everyone\'s');
  const t123 = found.tickets.find(t => t.key === 'AB#123');
  assert.equal(t123.assignee, 'Octo Cat');
  await ado.claim(cfg, t123, owned, 'In Development');
  assert.deepEqual(a.tags(123), ['Web', 'In Development'], 'the claim swaps the start tag');
  await assert.rejects(ado.claim(cfg, t123, owned, 'In Development'), /outdated revision/, 'the loser backs off: its revision is stale');
  const rev = await ado.retag(cfg, t123.ref, owned, 'Ready to Start');
  assert.equal(rev, a.items[123].rev, 'retag resolves with the new revision');
  assert.equal(await ado.tagsChangedSince(cfg, t123.ref, rev, a.items[123].rev, isStart), false, 'nobody re-tagged it');
  a.setTags(123, ['Web']);
  a.setTags(123, ['Web', 'Ready to Start']);
  assert.equal(await ado.tagsChangedSince(cfg, t123.ref, rev, a.items[123].rev, isStart), true, 'the start tag taken off and put back');
  for (const key of ['AB#123', '123', 'ab#123']) assert.equal((await ado.lookup(cfg, key)).key, 'AB#123', `lookup ${key}`);
  await assert.rejects(ado.lookup(cfg, 'PROJ-123'), /use AB#123/);
  const item = await ado.readItem(cfg, t123.ref);
  assert.ok(item.rev === a.items[123].rev && item.tags.includes('Ready to Start') && item.url === 'https://dev.azure.com/o/Shop/_workitems/edit/123');
  globalThis.fetch = adoServer().fetch; // the ticket as the fixture has it, before the claims above
  const adoData = await ado.workItem(cfg, t123.ref);
  assert.equal(brief.ticketMd(adoData, { prs: [{ url: 'https://github.com/octo-org/web/pull/1', title: 'Old attempt', state: 'CLOSED', author: 'teammate' }], trackerName: ado.name }), fixture('ticket-ado.md'), 'ticket.md: Azure DevOps');

  const j = jiraServer();
  globalThis.fetch = j.fetch;
  assert.equal(jira.name, 'Jira');
  assert.equal(jira.boardLabel({ board: 'Shop board' }), 'Shop board');
  found = await jira.findTickets(cfg, { board: 'Shop board' }, isStart, { assignedToMe: true });
  assert.deepEqual(found.tickets.map(t => t.key), ['PROJ-123'], 'assigned to me only');
  assert.ok(j.calls.some(c => c.includes('AND assignee = currentUser()')));
  assert.deepEqual((await jira.findTickets(cfg, { board: 'Shop board' }, isStart)).tickets.map(t => t.key), ['PROJ-123', 'PROJ-126']);
  const p123 = found.tickets[0];
  await jira.claim(cfg, p123, owned, 'In Development');
  assert.deepEqual(j.labels('PROJ-123'), ['web', 'In-Development'], 'labels are hyphenated; the one-off claim label is gone again');
  j.edit('PROJ-123', [{ remove: 'In-Development' }, { add: 'Ready-to-Start' }]);
  j.rivalNext();
  await assert.rejects(jira.claim(cfg, { ...p123, tags: ['Ready-to-Start', 'web'] }, owned, 'In Development'), /another copy of Prowl/, 'the loser backs off');
  const jrev = await jira.retag(cfg, p123.ref, owned, 'Ready to Start');
  assert.equal(jrev, j.changelog['PROJ-123'].length, "retag resolves with the changelog's length");
  assert.equal(await jira.tagsChangedSince(cfg, p123.ref, jrev, jrev, isStart), false);
  j.edit('PROJ-123', [{ remove: 'Ready-to-Start' }]);
  j.edit('PROJ-123', [{ add: 'Ready-to-Start' }]);
  assert.equal(await jira.tagsChangedSince(cfg, p123.ref, jrev, j.changelog['PROJ-123'].length, isStart), true, 'the start label taken off and put back');
  assert.equal((await jira.lookup(cfg, 'PROJ-123')).key, 'PROJ-123');
  await assert.rejects(jira.lookup(cfg, 'AB#123'), /use PROJ-123/);
  assert.equal((await jira.readItem(cfg, p123.ref)).rev, j.changelog['PROJ-123'].length);
  globalThis.fetch = jiraServer().fetch;
  const jiraData = await jira.workItem(cfg, p123.ref);
  assert.equal(brief.ticketMd(jiraData, { prs: [], trackerName: jira.name }), fixture('ticket-jira.md'), 'ticket.md: Jira');
  assert.equal((await jira.workItem({ ...cfg, jira: { ...cfg.jira, fields: { acceptanceCriteria: '', reproSteps: '' } } }, p123.ref)).acceptanceCriteria, null, 'no custom field set: no section');
}

// ---- Builds, start to PRs ----

async function builds(assert) {
  // A two-repo build on Azure DevOps: needs-repos, an approved plan, two commits, two linked ready PRs, pushed.
  let h = harness('ado', twoRepoBuild());
  fs.mkdirSync(path.dirname(CHECKS_PATH), { recursive: true });
  fs.writeFileSync(CHECKS_PATH, JSON.stringify({ 'octo-org/*': { run: ['node -e "process.exit(0)"'] } }));
  await h.poll();
  let w = h.b.history().find(r => r.key === 'AB#123');
  assert.ok(w, 'claimed AB#123, assigned to me');
  assert.ok(!h.b.history().some(r => r.key === 'AB#126'), "not someone else's ticket");
  assert.deepEqual(h.session.turns.map(t => t.prompt.split('\n')[0].split(' ')[0]), ['/prowl:prowl-work', 'repos', 'approve'], 'investigate, more repos, approve');
  assert.ok(h.session.turns.slice(1).every(t => t.resumed && t.sessionId === h.session.turns[0].sessionId), 'one session id, resumed at each step');
  assert.ok(read(path.join(w.briefDir, 'ticket.md')).startsWith('# AB#123: Save the cart between visits'), 'ticket.md in the brief folder');
  const branch = 'prowl/123-save-the-cart-between-visits';
  assert.ok(h.session.turns[2].prompt.includes(`octo-org/web: ${branch}`) && h.session.turns[2].prompt.includes(`octo-org/api: ${branch}`));
  assert.ok(remoteHas(h.bares['octo-org/web'], branch) && remoteHas(h.bares['octo-org/api'], branch), 'both branches pushed');
  assert.equal(remoteFile(h.bares['octo-org/api'], branch, 'src/carts.js'), 'export const store = () => {};\n');
  assert.equal(h.gh.prs.length, 2);
  assert.ok(h.gh.prs.every(p => p.title.includes('AB#123') && !p.draft && p.base === 'main' && p.head === branch), 'one ready PR per repo, the key in its title');
  assert.ok(h.gh.prs[0].body.includes(h.gh.prs[1].url) && h.gh.prs[1].body.includes(h.gh.prs[0].url), 'each body links the other');
  assert.deepEqual(h.server.tags(123), ['Web', 'Ready for Review'], 'retagged: In Development swapped for the done tag');
  assert.equal(h.server.items[123].fields['System.State'], 'Active', "the ticket's state is never changed");
  assert.equal(w.status, 'following');
  assert.ok(!fs.existsSync(w.repos[0].worktree) && fs.existsSync(w.briefDir), 'worktrees removed, brief folder kept');
  assert.equal(git(path.join(h.projects, 'web'), 'branch', '--list', 'prowl/*'), '', 'its pushed branches removed from your clone');
  assert.equal(git(path.join(h.projects, 'web'), 'symbolic-ref', '--short', 'HEAD'), 'main', 'your checked-out branch untouched');
  // A rebuild of the same ticket (its PRs closed) steps past the branch it pushed before.
  for (const p of h.gh.prs) p.state = 'CLOSED';
  h.server.setTags(123, ['Web', 'Ready to Start']);
  h.b.history().find(r => r.key === 'AB#123').status = 'done';
  await h.poll();
  const again = h.b.history().find(r => r.key === 'AB#123' && r.n === 2);
  assert.ok(again && remoteHas(h.bares['octo-org/web'], `${branch}-2`), 'a rebuild uses -2');
  h.done();

  // Concurrency, open questions in Needs you, and the answer resuming the same session.
  h = harness('ado', twoRepoBuild({ questions: [{ id: 'Q1', question: 'Keep carts for guests?', options: ['Yes', 'No'], default: 'No' }] }));
  h.server.items[126].fields['System.AssignedTo'] = { uniqueName: ME_ADO };
  await h.poll();
  assert.equal(h.b.history().filter(r => r.claimedAt).length, 1, 'Max parallel builds (1): one ticket at a time, Needs you included');
  assert.ok(h.logs.some(l => /waiting, 1 ticket is already being built/.test(l)));
  const q = h.b.needs()[0];
  assert.ok(q && q.kind === 'question' && q.qid === 'Q1' && q.options.join() === 'Yes,No' && q.recommended === 'No', 'an open question is a Needs-you item');
  w = h.b.history().find(r => r.uid === q.recordId);
  assert.equal(w.status, 'needs-you');
  assert.ok(h.server.tags(w.ref.id).includes('In Development'), 'the ticket keeps In Development');
  h.b.answer(q, 'No, signed-in shoppers only');
  await h.b.drain();
  assert.ok(h.session.turns.some(t => t.prompt === 'answers:\nQ1: No, signed-in shoppers only'), 'answers: resumes the session');
  assert.equal(w.status, 'following', 'then built and published');
  assert.ok(read(path.join(h.root, 'work', 'answers.jsonl')).includes('Keep carts for guests?'), 'the answer kept for later sessions');
  h.done();

  // Checks, then guards, before any push: one more turn after a failing check, then Needs you; nothing pushed.
  h = harness('ado', twoRepoBuild());
  fs.writeFileSync(CHECKS_PATH, JSON.stringify({ 'octo-org/web': { run: ['node -e "process.exit(3)"'] } }));
  await h.poll();
  assert.ok(h.session.turns.some(t => t.prompt.startsWith('checks failed:\nocto-org/web: node -e')), 'a failing check gets one more turn with its output');
  assert.equal(h.b.needs()[0]?.kind, 'checks', 'a second failure goes to Needs you');
  assert.ok(!remoteHas(h.bares['octo-org/web'], branch) && !remoteHas(h.bares['octo-org/api'], branch), 'nothing is pushed until every repo passes');
  h.done();
  fs.writeFileSync(CHECKS_PATH, '{}');
  h = harness('ado', twoRepoBuild({ files: { web: { '.github/workflows/ci.yml': 'on: push\n' }, api: { 'src/carts.js': 'x\n' } } }));
  await h.poll();
  assert.equal(h.b.needs()[0]?.kind, 'guard');
  assert.match(h.b.needs()[0].question, /Paths that need a person/);
  assert.ok(!remoteHas(h.bares['octo-org/api'], branch), 'a guard on one repo stops the push of every repo');
  // enter retries; s ends the work and takes the tag off.
  w = h.b.history()[0];
  await h.b.skip(h.b.needs()[0]);
  assert.equal(w.status, 'stopped');
  assert.deepEqual(h.server.tags(123), ['Web'], 'In Development removed');
  h.done();

  // An unusable result.json is asked for once more, then goes to Needs you; a cap goes straight there.
  h = harness('ado', () => ({ result: '{ not json' }));
  await h.poll();
  assert.ok(h.session.turns[1]?.prompt.startsWith('result.json invalid: it is not valid JSON'), 'asked once more');
  assert.equal(h.b.needs()[0]?.kind, 'failed');
  assert.equal(h.session.turns.length, 2, 'and not again');
  h.done();
  h = harness('ado', () => ({ result: { status: 'blocked', reason: 'x' }, subtype: 'error_max_budget_usd', cost: 50 }));
  await h.poll();
  assert.deepEqual([h.b.needs()[0]?.kind, h.session.turns.length], ['cap', 1], "a session that hits its cap isn't retried");
  assert.match(h.b.needs()[0].question, /spend cap \$50/);
  h.done();
  h = harness('ado', twoRepoBuild(), { cfgOver: { ticketBudgetUsd: 2 } });
  await h.poll();
  assert.deepEqual([h.b.needs()[0]?.kind, h.session.turns.length], ['cap', 2], 'the per-ticket cap counts every run on the ticket');
  h.done();
  h = harness('ado', twoRepoBuild(), { cfgOver: { maxBudgetUsd: 1.5 } });
  await h.poll();
  assert.equal(h.session.turns[0].budget, 1.5);
  assert.equal(h.session.turns[1].budget, 0.5, "each turn gets what's left of the session's cap");
  h.done();
  h = harness('ado', twoRepoBuild(), { cfgOver: { maxBudgetUsd: 50, ticketBudgetUsd: 10, dailyBudgetUsd: 9.5 } });
  await h.poll();
  assert.deepEqual(h.session.turns.slice(0, 2).map(t => t.budget), [9.5, 8.5], "a turn gets what's left of the tightest cap: the ticket's or the day's too");
  h.done();
  // A question Needs you can't show is an unusable result.
  h = harness('ado', () => ({ result: { status: 'question', question: { id: 'Q1', question: 'Choose?', options: 'Yes' } } }));
  await h.poll();
  assert.ok(h.session.turns[1]?.prompt.startsWith("result.json invalid: the question's options must be a list of text"));
  assert.equal(h.b.needs()[0]?.kind, 'failed');
  h.done();

  // Dry run: --work and --follow claim and start nothing.
  h = harness('ado', twoRepoBuild());
  h.app.dryRun = () => true;
  await h.b.enqueue('AB#123', 'manual');
  await h.b.drain();
  assert.deepEqual([h.b.history()[0].status, h.session.turns.length, h.server.tags(123)], ['ended', 0, ['Ready to Start', 'Web']], 'dry run: --work claims nothing');
  assert.ok(h.logs.some(l => /would build/.test(l)));
  h.done();

  // A PR whose create went through but whose answer was lost is found on the retry, not opened twice.
  h = harness('ado', twoRepoBuild());
  const create = h.gh.createPr;
  let lost = true;
  h.gh.createPr = async (...a) => { const pr = await create(...a); if (lost) { lost = false; throw new Error('connection reset'); } return pr; };
  await h.poll();
  w = h.b.history()[0];
  w._retryAt = 0;
  await h.b.drain();
  assert.deepEqual([h.gh.prs.length, w.status, w.prs.length], [2, 'following', 2], 'the earlier PR is used');
  h.done();
  // s while that lookup waits on GitHub: no PR is opened after it.
  h = harness('ado', twoRepoBuild());
  h.gh.prForBranch = async () => { h.b.stop(h.b.history()[0]); return null; };
  await h.poll();
  assert.deepEqual([h.gh.prs.length, h.b.history()[0].status], [0, 'stopped'], 'stopped before the PR');
  h.done();

  // Turns still running hold back what they may spend from the day's cap.
  h = harness('ado', twoRepoBuild(), { cfgOver: { dailyBudgetUsd: 10 } });
  const other = { uid: 'other', key: 'AB#999', status: 'active', step: 'session', turnBudgetUsd: 9, turns: [], _busy: true };
  h.b.state.records.push(other);
  await h.poll();
  assert.equal(h.session.turns[0]?.budget, 1, "a turn gets the day's cap less what running turns may spend");
  h.done();
  h = harness('ado', twoRepoBuild(), { cfgOver: { dailyBudgetUsd: 10 } });
  h.b.state.records.push({ ...other, turnBudgetUsd: 10 });
  await h.poll();
  assert.ok(!h.session.turns.length && h.logs.some(l => /turns running now may spend the rest of today's cap/.test(l)), 'none left: it waits');
  h.done();

  // Validation: an entry that isn't an object, or a plan that isn't a path, is an unusable result, not a crash.
  assert.match(rules.validateBuild({ status: 'needs-approval', plan: 'plan.md', openQuestions: [null] }, '/'), /openQuestions must be a list of objects/);
  assert.match(rules.validateBuild({ status: 'needs-approval', plan: {}, openQuestions: [] }, '/'), /plan must be text/);
  assert.match(rules.validateBuild({ status: 'needs-repos', repos: [{ repo: ['octo-org/api'] }] }, '/'), /isn't a repo/);

  // A claim that failed, but not to someone else (its check failed after the write, say), waits in Needs you.
  h = harness('ado', twoRepoBuild(), { trackerWrap: t => ({ ...t, claim: async (...a) => { await t.claim(...a); throw new Error('ADO GET /x: 502 Bad Gateway'); } }) });
  await h.poll();
  assert.deepEqual([h.b.needs()[0]?.kind, h.session.turns.length], ['conflict', 0], "an unconfirmed claim: you judge it");
  assert.match(h.b.needs()[0].question, /couldn't confirm its claim on AB#123/);
  assert.equal(h.b.history().length, 1, 'kept in a record, holding its slot');
  h.b.answer(h.b.needs()[0], '');
  await h.b.drain();
  assert.equal(h.b.history()[0].status, 'following', 'enter: In Development, so taken as ours, and built');
  h.done();
  // …one whose write never reached the tracker is claimed again on enter; s leaves the tags as they are.
  let claimCalls = 0;
  h = harness('ado', twoRepoBuild(), { trackerWrap: t => ({ ...t, claim: async (...a) => { if (claimCalls++ === 0) throw new Error('ADO PATCH /x: 503 Service Unavailable'); return t.claim(...a); } }) });
  await h.poll();
  assert.deepEqual(h.server.tags(123), ['Ready to Start', 'Web'], 'nothing written');
  h.b.answer(h.b.needs()[0], '');
  await h.b.drain();
  assert.deepEqual([claimCalls, h.b.history()[0].status, h.server.tags(123)], [2, 'following', ['Web', 'Ready for Review']], 'claimed on enter, then built');
  h.done();
  h = harness('ado', twoRepoBuild(), { trackerWrap: t => ({ ...t, claim: async (...a) => { await t.claim(...a); throw new Error('ADO GET /x: 502 Bad Gateway'); } }) });
  await h.poll();
  await h.b.skip(h.b.needs()[0]);
  assert.deepEqual([h.b.history()[0].status, h.server.tags(123)], ['stopped', ['Web', 'In Development']], "s: the In Development, maybe someone else's, stays");
  h.done();

  // A handoff that landed but whose answer was lost: its retry leaves a review that claimed the ticket since alone.
  let lose = true;
  let firstTry = 0;
  h = harness('ado', twoRepoBuild(), { trackerWrap: t => ({ ...t, retag: async (cfg, ref, drop, add) => {
    const rev = await t.retag(cfg, ref, drop, add);
    if (add === 'Ready for Review' && lose) { lose = false; firstTry = Date.now(); throw new Error('ADO GET /x: 502 Bad Gateway'); }
    return rev;
  } }) });
  await h.poll();
  h.server.setTags(123, ['Web', 'In Review']); // a teammate's Reviewer claims it
  await new Promise(r => setTimeout(r, 5)); // the retry comes later
  h.b.history()[0]._retryAt = 0;
  await h.b.drain();
  assert.deepEqual([h.b.history()[0].status, h.server.tags(123)], ['following', ['Web', 'In Review']], 'the review keeps its claim');
  assert.ok(h.b.history()[0].lastActivityAt <= firstTry, 'feedback counts from the first try, not the retry');
  h.done();
  // Adoptions whose handoff landed but whose answer was lost, and a review that came and went before the retry.
  const pr9 = () => ({ repo: 'octo-org/web', number: 9, url: 'https://github.com/octo-org/web/pull/9', title: 'AB#123: Save the cart', body: '', head: 'feature/cart', base: 'main', draft: false, state: 'OPEN', author: 'octocat', reviews: [], threads: [], checks: [], replies: [] });
  for (const source of ['manual', 'follow']) {
    let drop1 = true;
    h = harness('ado', twoRepoBuild(), { trackerWrap: t => ({ ...t, retag: async (...a) => { const rev = await t.retag(...a); if (a[3] === 'Ready for Review' && drop1) { drop1 = false; throw new Error('ADO GET /x: 502 Bad Gateway'); } return rev; } }) });
    h.gh.prs.push(pr9());
    git(path.join(h.root, 'seed', 'octo-org/web'), 'push', '-q', 'origin', 'HEAD:refs/heads/feature/cart');
    if (source === 'follow') h.server.setTags(123, ['Web']);
    await h.b.enqueue('AB#123', source);
    await h.b.drain();
    await new Promise(r => setTimeout(r, 5)); // the review comes after the handoff's first try
    h.gh.prs[0].reviews.push({ user: 'lead', state: 'CHANGES_REQUESTED', at: new Date().toISOString(), body: 'Handle empty carts, please.' });
    h.server.setTags(123, ['Web', 'Reviewed']); // the review ran, and finished
    await new Promise(r => setTimeout(r, 5));
    h.b.history()[0]._retryAt = 0;
    await h.b.drain();
    assert.deepEqual(h.server.tags(123), ['Web', 'Reviewed'], `${source}: the handoff isn't repeated after the review it started`);
    await h.poll();
    assert.equal(h.b.history()[0].rounds, 1, `${source}: and that review's feedback still gets its round`);
    h.done();
  }

  // s while the handoff reads the ticket: no Ready for Review.
  h = harness('ado', twoRepoBuild(), { trackerWrap: t => ({ ...t, readItem: async (...a) => { const item = await t.readItem(...a); if (h.stopOnRead) { h.stopOnRead = false; h.b.stop(h.b.history()[0]); } return item; } }) });
  h.gh.prForBranch = async (...a) => { h.stopOnRead = true; return null; }; // from the PRs on, the next read is the handoff's
  await h.poll();
  assert.deepEqual([h.b.history()[0].status, h.server.tags(123).includes('Ready for Review')], ['stopped', false], 'stopped before the handoff');
  h.done();

  // An adoption's handoff (no In Development to swap) that failed outright is tried again.
  let refuse = true;
  h = harness('ado', twoRepoBuild(), { trackerWrap: t => ({ ...t, retag: async (...a) => { if (a[3] === 'Ready for Review' && refuse) { refuse = false; throw new Error('ADO PATCH /x: 503 Service Unavailable'); } return t.retag(...a); } }) });
  h.gh.prs.push({ repo: 'octo-org/web', number: 9, url: 'https://github.com/octo-org/web/pull/9', title: 'AB#123: Save the cart', body: '', head: 'feature/cart', base: 'main', draft: false, state: 'OPEN', author: 'octocat', reviews: [], threads: [], checks: [], replies: [] });
  h.server.setTags(123, ['Web']);
  await h.b.enqueue('AB#123', 'follow');
  await h.b.drain();
  h.b.history()[0]._retryAt = 0;
  await h.b.drain();
  assert.deepEqual(h.server.tags(123), ['Web', 'Ready for Review'], 'handed off on the retry');
  h.done();

  // A merge whose conflict resolution adds a secret: the merge's own lines are scanned too.
  h = harness('ado', (w, prompt) => {
    if (!prompt.startsWith('approve')) return twoRepoBuild()(w, prompt);
    const rec = w.repos.find(r => r.repo === 'octo-org/web');
    const start = git(rec.worktree, 'rev-parse', 'HEAD');
    commit(rec.worktree, { 'src/a.js': 'one\n' }, 'one');
    git(rec.worktree, 'checkout', '-q', '--detach', start);
    const other = commit(rec.worktree, { 'src/a.js': 'two\n' }, 'two');
    git(rec.worktree, 'checkout', '-q', rec.branch);
    try { git(rec.worktree, 'merge', '-q', other); } catch { /* the conflict */ }
    fs.writeFileSync(path.join(rec.worktree, 'src/a.js'), 'DB_PASSWORD=s3cretvalue\n');
    git(rec.worktree, 'add', '-A');
    git(rec.worktree, 'commit', '-q', '-m', 'Merge');
    const commits = [{ repo: 'octo-org/web', sha: git(rec.worktree, 'rev-parse', 'HEAD') },
      { repo: 'octo-org/api', sha: commit(worktreeOf(w, 'octo-org/api'), { 'src/carts.js': 'x\n' }, 'api') }];
    return { result: { status: 'done', commits, prs: commits.map(c => ({ repo: c.repo, title: `${w.key}: Merge` })), checks: [] } };
  });
  await h.poll();
  assert.match(h.b.needs()[0]?.question || '', /password or secret/, "a secret only in a merge's resolution");
  assert.ok(!remoteHas(h.bares['octo-org/web'], branch), 'nothing pushed');
  h.done();

  // A secret in any commit pushed stops the push, even when a later commit takes it out again.
  h = harness('ado', (w, prompt) => {
    if (!prompt.startsWith('approve')) return twoRepoBuild()(w, prompt);
    const commits = ['octo-org/web', 'octo-org/api'].map(repo => {
      const wt = worktreeOf(w, repo);
      commit(wt, { 'src/config.js': `export const token = 'ghp_${'a'.repeat(36)}';\n` }, `${w.key}: config`);
      return { repo, sha: commit(wt, { 'src/config.js': 'export const token = process.env.TOKEN;\n' }, `${w.key}: read the token from the environment`) };
    });
    return { result: { status: 'done', commits, prs: commits.map(c => ({ repo: c.repo, title: `${w.key}: Config` })), checks: [] } };
  });
  await h.poll();
  assert.match(h.b.needs()[0]?.question || '', /a GitHub token/, 'a secret in an earlier commit');
  assert.ok(!remoteHas(h.bares['octo-org/web'], branch), 'nothing pushed');
  h.done();

  // Dry run, switched on while a session ran: its result waits; nothing is pushed, opened or tagged.
  h = harness('ado', (w, prompt) => { if (prompt.startsWith('approve')) h.app.dryRun = () => true; return twoRepoBuild()(w, prompt); });
  await h.poll();
  assert.deepEqual([h.b.history()[0].step, h.gh.prs.length, remoteHas(h.bares['octo-org/web'], branch)], ['publish', 0, false], 'dry run: publishing waits');
  h.done();

  // --work on a ticket someone is working on already (In Development) builds nothing.
  h = harness('ado', twoRepoBuild());
  h.server.setTags(123, ['Web', 'In Development']);
  await h.b.enqueue('AB#123', 'manual');
  await h.b.drain();
  assert.deepEqual([h.b.history()[0].status, h.session.turns.length, h.server.tags(123)], ['ended', 0, ['Web', 'In Development']], "--work leaves another's claim alone");
  h.done();

  // Stopped while the tracker is down: In Development comes off once the tracker answers again.
  let down = false;
  h = harness('ado', twoRepoBuild(), { cfgOver: { approvePlans: 'ask' }, trackerWrap: t => ({ ...t, retag: async (...a) => { if (down) throw new Error('503 Service Unavailable'); return t.retag(...a); } }) });
  await h.poll();
  down = true;
  await h.b.skip(h.b.needs()[0]);
  w = h.b.history()[0];
  assert.deepEqual([w.status, w.step, h.server.tags(123).includes('In Development')], ['stopped', 'retag', true], 'the untag waits for the tracker');
  down = false;
  w._retryAt = 0;
  await h.b.drain();
  assert.deepEqual([w.step, h.server.tags(123)], [null, ['Web']], 'and then In Development is removed');
  h.done();
  // …unless the ticket was claimed again since: then its tags are the newer run's.
  down = false;
  h = harness('ado', twoRepoBuild(), { cfgOver: { approvePlans: 'ask' }, trackerWrap: t => ({ ...t, retag: async (...a) => { if (down) throw new Error('503 Service Unavailable'); return t.retag(...a); } }) });
  await h.poll();
  down = true;
  await h.b.skip(h.b.needs()[0]);
  down = false;
  h.server.setTags(123, ['Web', 'Ready to Start']);
  await h.poll();
  w = h.b.history().find(r => r.status === 'stopped');
  assert.equal(h.b.history().length, 2, 'claimed again by a new run');
  w._retryAt = 0;
  await h.b.drain();
  assert.deepEqual([w.step, h.server.tags(123).includes('In Development')], [null, true], "the old retry leaves the new run's tags alone");
  h.done();

  // A clone whose push URL leads somewhere else isn't used.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-builder-')));
  const bare = makeRemote(root, 'octo-org/web');
  execFileSync('git', ['clone', '-q', bare, path.join(root, 'web')], { stdio: 'ignore' });
  git(path.join(root, 'web'), 'config', 'remote.origin.pushurl', bare);
  git(path.join(root, 'web'), 'config', '--add', 'remote.origin.pushurl', 'https://example.invalid/someone/web.git');
  await assert.rejects(ensureClone({ workDir: root }, 'octo-org/web'), /pushes to https:\/\/example\.invalid\/someone\/web\.git, not octo-org\/web/, 'every push URL is checked');
  git(path.join(root, 'web'), 'config', '--unset-all', 'remote.origin.pushurl');
  git(path.join(root, 'web'), 'config', 'remote.origin.pushurl', 'ssh://git@example.invalid/octo-org/web.git');
  await assert.rejects(ensureClone({ workDir: root }, 'octo-org/web'), /pushes to ssh:/, 'the same name on another host');
  fs.rmSync(root, { recursive: true, force: true });

  // Plans with Approve plans set to ask: enter with nothing approves; a note sends it back.
  h = harness('ado', twoRepoBuild(), { cfgOver: { approvePlans: 'ask' } });
  await h.poll();
  let plan = h.b.needs()[0];
  assert.equal(plan?.kind, 'plan');
  h.b.answer(plan, 'Keep the API change behind a flag');
  await h.b.drain();
  assert.ok(h.session.turns.some(t => t.prompt === 'plan feedback: Keep the API change behind a flag'));
  plan = h.b.needs()[0];
  h.b.answer(plan, '');
  await h.b.drain();
  assert.equal(h.b.history()[0].status, 'following', 'approved, built and published');
  h.done();

  // Switched off as it claimed: the start tag goes back on, and nothing is built.
  h = harness('ado', twoRepoBuild(), { trackerWrap: t => ({ ...t, claim: async (...a) => { await t.claim(...a); h.app.on = false; } }) });
  await h.poll();
  assert.deepEqual([h.server.tags(123), h.session.turns.length], [['Web', 'Ready to Start'], 0], 'the claim released');
  h.done();

  // Handed back (t): not reclaimed until someone takes the start tag off and puts it back.
  h = harness('ado', twoRepoBuild(), { cfgOver: { approvePlans: 'ask' } });
  await h.poll();
  await h.b.handBack(h.b.needs()[0]);
  assert.deepEqual(h.server.tags(123), ['Web', 'Ready to Start'], 'handed back with the start tag');
  await h.poll();
  assert.equal(h.b.history().filter(r => r.key === 'AB#123').length, 1, 'other edits: not reclaimed');
  assert.ok(h.logs.some(l => /handed back to you/.test(l)));
  h.server.setTags(123, ['Web']);
  h.server.setTags(123, ['Web', 'Ready to Start']);
  await h.poll();
  assert.equal(h.b.history().filter(r => r.key === 'AB#123').length, 2, 're-tagged: built again');
  h.done();

  // --work: AB#123 or 123 on Azure DevOps, PROJ-123 on Jira (where labels are hyphenated), without the start tag.
  h = harness('ado', twoRepoBuild());
  h.server.setTags(123, ['Web']);
  await h.b.enqueue('AB#123', 'manual');
  await h.b.drain();
  assert.equal(h.b.history()[0].status, 'following', '--work AB#123');
  await assert.rejects(h.b.enqueue('AB#123', 'manual'), /already being followed/);
  h.done();
  h = harness('jira', (w, prompt) => {
    if (prompt.startsWith('/prowl:prowl-work ')) {
      fs.writeFileSync(path.join(w.briefDir, 'plan.md'), '# Plan\n');
      return { result: { status: 'needs-approval', plan: 'plan.md', changes: [{ repo: 'octo-org/web' }], openQuestions: [] } };
    }
    const sha = commit(worktreeOf(w, 'octo-org/web'), { 'src/cart.js': 'x\n' }, `${w.key}: save carts`);
    return { result: { status: 'done', commits: [{ repo: 'octo-org/web', sha }], prs: [{ repo: 'octo-org/web', title: 'Save the cart', body: 'Saves carts.' }], checks: [] } };
  }, { cfgOver: { base: { 'octo-org/web': 'release/*' }, draftPrs: true } });
  h.server.edit('PROJ-123', [{ remove: 'Ready-to-Start' }]);
  await h.b.enqueue('PROJ-123', 'manual');
  await h.b.drain();
  w = h.b.history()[0];
  assert.equal(w.status, 'following', '--work PROJ-123');
  assert.ok(remoteHas(h.bares['octo-org/web'], 'prowl/PROJ-123-save-the-cart-between-visits'), 'its branch, with the key as typed');
  assert.deepEqual([h.gh.prs[0].base, h.gh.prs[0].draft, h.gh.prs[0].title], ['release/1.10', true, 'PROJ-123: Save the cart'], 'the base rule, Open drafts, and the key put in the title');
  assert.deepEqual(h.server.labels('PROJ-123'), ['web', 'Ready-for-Review'], 'Jira: the done label hyphenated');
  await assert.rejects(h.b.enqueue('AB#9', 'manual'), /use PROJ-123/);
  h.done();
}

// ---- Following the PRs through review ----

async function feedback(assert) {
  const roundScript = (moved = null) => (w, prompt) => {
    if (w.turnKind !== 'round') return twoRepoBuild()(w, prompt);
    const p = w.round.prs[0];
    const again = (prompt.startsWith('/prowl:prowl-work feedback ') ? '' : `// turn ${w.turns.length}\n`) + (w.n > 1 ? `// record ${w.n}\n` : ''); // a later turn or record commits on top
    const sha = commit(p.worktree, { 'src/cart.js': `export const save = cart => (cart.length ? cart : null);\n${again}` }, `${w.key}: handle empty carts`);
    if (moved) moved(p);
    return { result: { status: 'fixed', summary: 'Empty carts are not saved.', commits: [{ pr: `${p.repo}#${p.number}`, sha }], checks: [],
      items: [{ pr: `${p.repo}#${p.number}`, thread: 'PRRT_1', finding: '', action: 'fix', note: 'save() skips an empty cart now.' },
        { pr: `${p.repo}#${p.number}`, thread: 'PRRT_2', finding: '', action: 'dispute', note: 'cart.js:1 already returns early.' }], questions: [] } };
  };
  const later = () => new Date(Date.now() + 60_000).toISOString();
  const addFeedback = (h, url) => {
    const pr = h.gh.prs.find(p => p.url === url);
    pr.reviews.push({ user: 'lead', state: 'CHANGES_REQUESTED', at: later(), body: 'Handle empty carts, please.' });
    pr.threads.push({ id: 'PRRT_1', resolved: false, path: 'src/cart.js', line: 1, commentId: 11, author: 'lead', bot: false, body: 'What about an empty cart?', url: `${url}#discussion_r11`, lastAuthor: 'lead', lastBody: 'What about an empty cart?', lastAt: later() },
      { id: 'PRRT_2', resolved: false, path: 'src/cart.js', line: 1, commentId: 12, author: 'lead', bot: false, body: 'Return early?', url: `${url}#discussion_r12`, lastAuthor: 'lead', lastBody: 'Return early?', lastAt: later() });
    return pr;
  };

  let h = harness('ado', roundScript());
  await h.poll();
  const w = h.b.history()[0];
  const web = h.gh.prs.find(p => p.repo === 'octo-org/web');
  addFeedback(h, web.url);
  await h.poll();
  assert.equal(w.rounds, 0, 'waits while the ticket carries the done tag: the review finishes first');
  h.server.setTags(123, ['Web', 'In Review']);
  await h.poll();
  assert.equal(w.rounds, 0, '…or the reviewing tag');
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.equal(w.rounds, 1, 'feedback newer than the last push: a round');
  const roundTurn = h.session.turns.at(-1);
  assert.ok(roundTurn.prompt.startsWith('/prowl:prowl-work feedback ') && !roundTurn.resumed, 'a fresh session');
  assert.ok(read(w.round ? w.round.feedbackPath : path.join(w.briefDir, 'feedback-1.md')).includes('Handle empty carts, please.'), 'briefed with the reviews requesting changes');
  assert.equal(remoteFile(h.bares['octo-org/web'], web.head, 'src/cart.js'), 'export const save = cart => (cart.length ? cart : null);\n', "pushed to the PR's branch");
  assert.deepEqual(web.replies.map(r => [r.commentId, /prowl-fix AB#123 r1\.1 PRRT_\d (fixed|disputed)/.exec(r.body)?.[1]]), [[11, 'fixed'], [12, 'disputed']], 'one reply per thread fixed or disputed');
  assert.ok(web.replies[0].body.includes('save() skips an empty cart now.') && web.threads.every(t => !t.resolved), 'never resolved');
  assert.deepEqual(h.server.tags(123), ['Web', 'Reviewed', 'Ready for Review'], 'back to the done tag');
  await h.poll();
  assert.equal(w.rounds, 1, 'the same feedback: no second round');
  // Ready to merge: every PR's latest review approves, no thread open, required checks green.
  for (const pr of h.gh.prs) {
    pr.reviews.push({ user: 'lead', state: 'APPROVED', at: later(), body: '' });
    for (const t of pr.threads) t.resolved = true;
    pr.checks = [{ name: 'build', bucket: 'pass' }];
  }
  await h.poll();
  assert.equal(w.ready, true, 'READY TO MERGE');
  web.state = 'MERGED';
  h.gh.prs.find(p => p.repo === 'octo-org/api').state = 'CLOSED';
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.equal(w.status, 'done', 'its PRs merged or closed: no longer followed');
  h.done();

  // A branch that moved since the round started drops the round, with nothing pushed.
  let theirs = '';
  h = harness('ado', roundScript(p => {
    const other = path.join(h.root, 'other');
    execFileSync('git', ['clone', '-q', '-b', p.branch, h.bares[p.repo], other], { stdio: 'ignore' });
    theirs = commit(other, { 'NOTES.md': 'mine\n' }, 'A teammate pushes');
    git(other, 'push', '-q', 'origin', `HEAD:${p.branch}`);
  }));
  await h.poll();
  addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.equal(execFileSync('git', ['ls-remote', h.bares['octo-org/web'], `refs/heads/${h.gh.prs[0].head}`], { encoding: 'utf8' }).split(/\s/)[0], theirs, 'nothing pushed over it');
  assert.deepEqual([h.gh.prs[0].replies.length, h.server.tags(123)], [0, ['Web', 'Reviewed']], 'no replies; In Development off again');
  assert.ok(h.logs.some(l => /round 1 dropped, nothing pushed/.test(l)));
  h.done();

  // Adopting: a ticket that already has your open, ready PRs is followed instead of built.
  h = harness('ado', roundScript());
  h.gh.prs.push({ repo: 'octo-org/web', number: 9, url: 'https://github.com/octo-org/web/pull/9', title: 'AB#123: Save the cart', body: '', head: 'feature/cart', base: 'main', draft: false, state: 'OPEN', author: 'octocat', reviews: [], threads: [], checks: [], replies: [] });
  git(path.join(h.root, 'seed', 'octo-org/web'), 'push', '-q', 'origin', 'HEAD:refs/heads/feature/cart');
  await h.poll();
  let a = h.b.history()[0];
  assert.deepEqual([a.adopted, h.session.turns.length, h.server.tags(123)], [true, 0, ['Web', 'Ready for Review']], 'no feedback yet: just the done tag');
  h.done();
  h = harness('ado', roundScript());
  h.gh.prs.push({ repo: 'octo-org/web', number: 9, url: 'https://github.com/octo-org/web/pull/9', title: 'AB#123: Save the cart', body: '', head: 'feature/cart', base: 'main', draft: false, state: 'OPEN', author: 'octocat', reviews: [], threads: [], checks: [], replies: [] });
  git(path.join(h.root, 'seed', 'octo-org/web'), 'push', '-q', 'origin', 'HEAD:refs/heads/feature/cart');
  // Your own clone, with your own local branch of the PR's name, ahead of the remote and not checked out.
  const mine = path.join(h.projects, 'web');
  execFileSync('git', ['clone', '-q', h.bares['octo-org/web'], mine], { stdio: 'ignore' });
  git(mine, 'checkout', '-q', '-b', 'feature/cart', 'origin/feature/cart');
  const myTip = commit(mine, { 'WIP.md': 'not pushed\n' }, 'My own work in progress');
  git(mine, 'checkout', '-q', 'main');
  addFeedback(h, 'https://github.com/octo-org/web/pull/9');
  await h.poll();
  a = h.b.history()[0];
  assert.deepEqual([a.rounds, h.gh.prs[0].replies.length], [1, 2], 'with feedback: a round at once');
  assert.deepEqual([git(mine, 'symbolic-ref', '--short', 'HEAD'), git(mine, 'rev-parse', 'feature/cart')], ['main', myTip], 'your local branch of that name, ahead of the remote, untouched');
  assert.equal(git(mine, 'worktree', 'list').split('\n').length, 1, "the round's worktree is gone");
  h.done();
  h = harness('ado', roundScript());
  h.gh.prs.push({ repo: 'octo-org/web', number: 9, url: 'https://github.com/octo-org/web/pull/9', title: 'AB#123: Save the cart', body: '', head: 'feature/cart', base: 'main', draft: true, state: 'OPEN', author: 'octocat', reviews: [], threads: [], checks: [], replies: [] });
  await h.poll();
  assert.ok(!h.b.history()[0].adopted && h.gh.prs.length === 3, 'a draft is not adopted: the ticket is built');
  h.done();

  // --follow (or w in History) claims nothing, and leaves a review asked for or under way alone, even with feedback waiting.
  h = harness('ado', roundScript());
  h.gh.prs.push({ repo: 'octo-org/web', number: 9, url: 'https://github.com/octo-org/web/pull/9', title: 'AB#123: Save the cart', body: '', head: 'feature/cart', base: 'main', draft: false, state: 'OPEN', author: 'octocat', reviews: [], threads: [], checks: [], replies: [] });
  git(path.join(h.root, 'seed', 'octo-org/web'), 'push', '-q', 'origin', 'HEAD:refs/heads/feature/cart');
  const early = addFeedback(h, 'https://github.com/octo-org/web/pull/9');
  for (const x of [...early.reviews, ...early.threads]) x.at = x.lastAt = new Date(Date.now() - 3_600_000).toISOString(); // posted before the follow
  h.server.setTags(123, ['Web', 'In Review']);
  h.app.me = ''; // before the first poll has read your login
  await h.b.enqueue('AB#123', 'follow');
  await h.b.drain();
  assert.deepEqual([h.b.history()[0].status, h.b.history()[0].rounds, h.server.tags(123)], ['following', 0, ['Web', 'In Review']], 'following, no round, tags untouched');
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.equal(h.b.history()[0].rounds, 1, 'the review over, the feedback from before the follow gets its round');
  h.done();

  // A round re-reads the ticket before claiming it: a review asked for since follow() looked goes first.
  let reads = 0;
  h = harness('ado', roundScript(), { trackerWrap: t => ({ ...t, readItem: async (...a) => { if (h.flip && ++reads === 2) h.server.setTags(123, ['Web', 'Reviewed', 'In Review']); return t.readItem(...a); } }) });
  await h.poll();
  addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  h.flip = true;
  await h.poll();
  assert.deepEqual([h.b.history()[0].rounds, h.server.tags(123)], [0, ['Web', 'Reviewed', 'In Review']], 'no round, no claim');
  assert.ok(h.logs.some(l => /round not started, the ticket carries 'In Review' now/.test(l)));
  // Dry run: a saved round waits; t on a ticket with a round queued stops it instead.
  h.server.setTags(123, ['Web', 'Reviewed']);
  const fw = h.b.history()[0];
  Object.assign(fw, { step: 'round', roundPrs: [h.gh.prs[0]] });
  h.app.dryRun = () => true;
  await h.b.drain();
  assert.deepEqual([fw.rounds, fw.step], [0, 'round'], 'dry run: a saved round waits');
  h.app.dryRun = () => false;
  h.b.stopFollowing(fw);
  await h.b.drain();
  assert.deepEqual([fw.rounds, fw.status, h.session.turns.filter(t => t.prompt.startsWith('/prowl:prowl-work feedback')).length], [0, 'stopped', 0], 'stop following: the queued round never runs');
  h.done();

  // A round that only disputes is dropped too when the branch moved: its replies would answer an old head.
  h = harness('ado', (w, prompt) => {
    if (w.turnKind !== 'round') return twoRepoBuild()(w, prompt);
    const p = w.round.prs[0];
    const other = path.join(h.root, 'other');
    execFileSync('git', ['clone', '-q', '-b', p.branch, h.bares[p.repo], other], { stdio: 'ignore' });
    commit(other, { 'NOTES.md': 'mine\n' }, 'A teammate pushes');
    git(other, 'push', '-q', 'origin', `HEAD:${p.branch}`);
    return { result: { status: 'fixed', summary: '', commits: [], checks: [], questions: [],
      items: [{ pr: `${p.repo}#${p.number}`, thread: 'PRRT_2', finding: '', action: 'dispute', note: 'cart.js:1 already returns early.' }] } };
  });
  await h.poll();
  addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.deepEqual([h.gh.prs[0].replies.length, h.server.tags(123)], [0, ['Web', 'Reviewed']], 'a dispute-only round on a moved branch: no replies');
  assert.ok(h.logs.some(l => /round 1 dropped, nothing pushed: octo-org\/web: the remote branch moved/.test(l)));
  h.done();

  // Switched off as a round claimed the ticket: its tags go back, and the round waits until the Builder is on again.
  let claims = 0;
  h = harness('ado', roundScript(), { trackerWrap: t => ({ ...t, claim: async (...a) => { await t.claim(...a); if (++claims === 2) h.app.on = false; } }) });
  await h.poll();
  addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.deepEqual([h.b.history()[0].rounds, h.b.history()[0].status, h.server.tags(123)], [0, 'following', ['Web', 'Reviewed']], 'the round claim released');
  h.app.on = true;
  await h.poll();
  assert.equal(h.b.history()[0].rounds, 1, 'on again: the round starts');
  h.done();

  // Required checks after a round's push: one more turn when they fail, then Needs you.
  h = harness('ado', roundScript(), { cfgOver: { waitForChecksMinutes: 30 } });
  await h.poll();
  addFeedback(h, h.gh.prs[0].url).checks = [{ name: 'build', bucket: 'fail', link: '' }];
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.ok(h.session.turns.some(t => t.prompt.startsWith('checks failed:\nocto-org/web#1: build')), 'failing required checks: one more turn, with the log');
  assert.deepEqual([h.b.needs()[0]?.kind, h.gh.prs[0].replies.length], ['checks', 2], 'failing again: Needs you, and no reply posted twice');
  const repairs = () => h.session.turns.filter(t => t.prompt.startsWith('checks failed:')).length;
  h.b.answer(h.b.needs()[0], '');
  await h.b.drain();
  assert.deepEqual([repairs(), h.b.needs()[0]?.kind, h.server.tags(123).includes('In Development')], [2, 'checks', true], 'enter checks again, with one more turn; never Ready for Review while they fail');
  h.done();

  // A round whose preparation fails after its claim keeps the claim: the retry goes on with it.
  h = harness('ado', roundScript());
  await h.poll();
  addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  const facts = h.gh.prFacts;
  let failed = false;
  h.gh.prFacts = async pr => { const x = h.b.history()[0]; if (x.step === 'round' && x.roundClaimed && !failed) { failed = true; throw new Error('502 Bad Gateway'); } return facts(pr); };
  await h.poll();
  assert.deepEqual([failed, h.b.history()[0].rounds], [true, 0]);
  addFeedback(h, h.gh.prs.find(p => p.repo === 'octo-org/api').url); // while the retry waits
  h.b.history()[0]._retryAt = 0;
  await h.b.drain();
  assert.equal(h.b.history()[0].rounds, 1, 'the retry starts the round');
  assert.ok(read(path.join(h.b.history()[0].briefDir, 'feedback-1.md')).includes('## octo-org/api#2'), 'with the feedback that came in meanwhile');
  h.done();

  // A reply Fix my PRs posted (2.11.3's marker, r1) doesn't stand in for the Builder's.
  h = harness('ado', roundScript());
  await h.poll();
  const legacy = addFeedback(h, h.gh.prs[0].url);
  legacy.replies.push({ commentId: 11, body: 'Fixed in abc1234\n<!-- prowl-fix AB#123 r1 PRRT_1 fixed -->' });
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.equal(legacy.replies.length, 3, 'both replies posted');
  h.done();

  // Feedback posted while a round runs is the next round's, not lost when the round ends.
  h = harness('ado', roundScript(() => {
    h.gh.prs.find(p => p.repo === 'octo-org/api').reviews.push({ user: 'lead', state: 'CHANGES_REQUESTED', at: new Date().toISOString(), body: 'And the API, please.' });
  }));
  await h.poll();
  const first = addFeedback(h, h.gh.prs.find(p => p.repo === 'octo-org/web').url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.equal(h.b.history()[0].rounds, 1);
  for (const t of first.threads) t.resolved = true; // the first round's feedback, settled
  first.reviews.length = 0;
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.equal(h.b.history()[0].rounds, 2, 'a second round for the feedback posted during the first');
  h.done();

  // A push URL changed after the round started: nothing pushed there.
  h = harness('ado', roundScript(p => git(p.clone, 'config', 'remote.origin.pushurl', 'https://example.invalid/someone/web.git')));
  await h.poll();
  addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  const before = execFileSync('git', ['ls-remote', h.bares['octo-org/web'], `refs/heads/${h.gh.prs[0].head}`], { encoding: 'utf8' });
  await h.poll();
  assert.equal(execFileSync('git', ['ls-remote', h.bares['octo-org/web'], `refs/heads/${h.gh.prs[0].head}`], { encoding: 'utf8' }), before, 'not pushed');
  assert.ok(h.logs.some(l => /pushes to https:\/\/example\.invalid\/someone\/web\.git/.test(l)) && !h.gh.prs[0].replies.length);
  assert.deepEqual([h.b.needs()[0]?.kind, h.server.tags(123).includes('In Development')], ['guard', true], 'Needs you, keeping In Development');
  h.done();

  // A push that fails for another reason (the server refuses it once) is retried, not dropped.
  h = harness('ado', roundScript(p => {
    const hook = path.join(h.bares[p.repo], 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nif [ -f "$GIT_DIR/fail-once" ]; then rm "$GIT_DIR/fail-once"; echo "try again later" >&2; exit 1; fi\n', { mode: 0o755 });
    fs.writeFileSync(path.join(h.bares[p.repo], 'fail-once'), '');
  }));
  await h.poll();
  addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  const rw = h.b.history()[0];
  assert.deepEqual([rw.step, rw.status, h.gh.prs[0].replies.length], ['push-round', 'active', 0], 'waits to retry');
  assert.ok(h.logs.some(l => /try again later/.test(l)), 'the refused push');
  rw._retryAt = 0;
  await h.b.drain();
  assert.deepEqual([h.gh.prs[0].replies.length, h.server.tags(123)], [2, ['Web', 'Reviewed', 'Ready for Review']], 'then pushed and replied');
  h.done();

  // Merged while the ticket still says Ready for Review: no longer followed.
  h = harness('ado', roundScript());
  await h.poll();
  for (const p of h.gh.prs) p.state = 'MERGED';
  await h.poll();
  assert.equal(h.b.history()[0].status, 'done', 'merged PRs are noticed while waiting for a review');
  h.done();

  // Followed again later, in a new record: its replies carry their own markers, so none is taken for an old one.
  h = harness('ado', roundScript());
  await h.poll();
  const again1 = addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  h.b.stopFollowing(h.b.history()[0]);
  again1.reviews.push({ user: 'lead', state: 'CHANGES_REQUESTED', at: later(), body: 'Not quite.' });
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.b.enqueue('AB#123', 'follow');
  await h.b.drain();
  assert.equal(again1.replies.length, 4, 'a second set of replies');
  assert.ok(again1.replies.slice(2).every(r => / r2\.1 /.test(r.body)), 'marked with the record');
  h.done();

  // The same on Jira: a two-repo build, a round another copy of Prowl claims first, then the round once it's done.
  h = harness('jira', roundScript());
  await h.poll();
  const jw = h.b.history()[0];
  assert.deepEqual([jw.key, h.gh.prs.length, h.server.labels('PROJ-123')], ['PROJ-123', 2, ['web', 'Ready-for-Review']], 'Jira: two linked PRs, the done label on');
  assert.ok(h.gh.prs[0].body.includes(h.gh.prs[1].url) && remoteHas(h.bares['octo-org/api'], 'prowl/PROJ-123-save-the-cart-between-visits'), 'Jira: pushed and linked');
  const jWeb = h.gh.prs.find(p => p.repo === 'octo-org/web');
  addFeedback(h, jWeb.url);
  h.server.edit('PROJ-123', [{ remove: 'Ready-for-Review' }, { add: 'Reviewed' }]);
  h.server.rivalNext();
  await h.poll();
  assert.deepEqual([jw.rounds, jw.status, h.session.turns.filter(t => t.prompt.startsWith('/prowl:prowl-work feedback')).length], [0, 'following', 0], 'Jira: the round claim lost, nothing started');
  assert.ok(h.logs.some(l => /round not started.*another copy of Prowl/.test(l)));
  await h.poll();
  assert.equal(jw.rounds, 0, "Jira: waits while someone else's In-Development is on");
  h.server.edit('PROJ-123', [{ remove: 'In-Development' }, { remove: 'prowl-claim-rival' }]);
  await h.poll();
  assert.deepEqual([jw.rounds, jWeb.replies.length, h.server.labels('PROJ-123')], [1, 2, ['web', 'Reviewed', 'Ready-for-Review']], 'Jira: then the round, its replies, and the done label');
  h.done();

  // The round cap: a ticket past Rounds per ticket goes to Needs you, keeping In Development.
  h = harness('ado', roundScript(), { cfgOver: { maxRounds: 1 } });
  await h.poll();
  addFeedback(h, h.gh.prs[0].url);
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  const pr = h.gh.prs[0];
  pr.reviews.push({ user: 'lead', state: 'CHANGES_REQUESTED', at: new Date(Date.now() + 120_000).toISOString(), body: 'Still not right.' });
  h.server.setTags(123, ['Web', 'Reviewed']);
  await h.poll();
  assert.equal(h.b.needs()[0]?.kind, 'cap');
  assert.ok(h.server.tags(123).includes('In Development'), 'keeping In Development');
  h.done();
}
