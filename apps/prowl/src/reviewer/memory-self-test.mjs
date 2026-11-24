// Shared review memory (src/reviewer/memory.mjs), run by src/self-test.mjs with its counting assert: the note itself,
// then two Prowls (two logins, two states) over one fake GitHub and one board, on Azure DevOps and on Jira. Nothing
// here reaches GitHub, a tracker or Claude Code.
import fs from 'node:fs';
import { loadConfig } from '../config.mjs';
import { buildNotes, byReview, handoverBlock, HANDOVER_LIMIT, noteBody, noteTrusted, parseHandover, priorFromNotes, prowlApproved, recall } from './memory.mjs';
import { planPublish } from './publish-plan.mjs';
import { createReviewer } from './reviewer.mjs';
import { createReview, postMarker } from './reviews.mjs';

const sha = c => String(c).repeat(40);
const banner = id => `\`\`\`text\nPR-Owl review rb-20261124-x-r1-0000-abcd\n\`\`\`\nBody.\n${postMarker(id)}`;
const finding = (id, pr, over = {}) => ({ id, pr, status: 'confirmed', severity: 'high', title: `Title ${id}`, axis: 'Correctness', location: { path: 'src/a.js', line: 3, startLine: null },
  problem: `Problem ${id}.`, fix: `Fix ${id}.`, detail: { quote: { language: 'js', code: 'const a = 1;' }, explanation: 'Why.', scenario: 'When.', fixDetail: 'How.', check: 'Test.', verification: 'Verified.' }, ...over });
const entry = (url, head, unverified = null) => ({ url, reviewedAt: head, summary: 'Adds a thing.', role: 'The producer.', related: [], conventions: [], coverage: { axes: ['Correctness'], clean: [], unverified }, earlierReviews: [] });

export async function run(assert, { appDir }) {
  note(assert);
  for (const board of ['ado', 'jira']) await twoProwls(assert, appDir, board);
}

// ---- The note: its size, its escapes, what is believed ----

function note(assert) {
  const [A, B, C] = ['https://github.com/acme/web/pull/1', 'https://github.com/acme/web/pull/2', 'https://github.com/acme/secret/pull/3'];
  const long = 'x'.repeat(900);
  const findings = Array.from({ length: 200 }, (_, i) => finding(`F-${String(i + 1).padStart(3, '0')}`, i % 2 ? B : A, { title: i ? `Title ${i}` : 'Ends --> it <script>alert(1)</script>', detail: { explanation: long } }));
  const run = { id: 'AB7-r1', batchId: 'rb-20261124-ab7-r1-0000-abcd', ticket: 'AB#7', reviewNo: 1, endedAt: 5, me: 'alice', prs: [{ url: A }], resultPrs: [A, B], published: { [`review:${A}`]: `${A}#pullrequestreview-1` },
    approved: { [B]: sha('b') }, approvedBy: { [B]: 'AB7-r0' }, reviewedHeads: { [A]: sha('a') }, approvals: true };
  const result = { batchId: run.batchId, prs: [entry(A, sha('a'), `couldn't   run\nthe tests ${'y'.repeat(3000)}`), entry(B, sha('b'))], findings };
  const made = buildNotes(run, result, [A, B]);
  assert.deepEqual(Object.keys(made), [A], 'one note per PR the review posted on');
  const block = handoverBlock(made[A]);
  const back = parseHandover(noteBody('finished', made[A]));
  assert.ok(block.length <= HANDOVER_LIMIT && back, `a note with 200 long findings fits as posted (${block.length})`);
  assert.equal(back.findings.length + back.cut + back.cutOther, 200, 'what did not fit is counted, per PR');
  assert.ok(back.cut > 0 && back.cutOther > 0 && back.findings.every(f => f.detail == null), 'every write-up went before a whole finding did');
  assert.deepEqual([block.slice(0, -3).includes('-->'), block.includes('<script'), back.findings[0].title], [false, false, 'Ends --> it <script>alert(1)</script>'], 'text that would end the comment or open a tag round-trips');
  assert.deepEqual([back.approver, back.unverified[0].text.length, /\s\s/.test(back.unverified[0].text)], [{ [B]: 'AB7-r0' }, 2000, false], 'a carried approval names its review; what could not be checked is clipped');
  const small = buildNotes(run, { ...result, findings: findings.slice(0, 4) }, [A])[A];
  assert.deepEqual(small.findings.map(f => f.pr), [A, A, B, B], "this PR's findings first, then those on PRs the review didn't post on");
  assert.ok(small.findings[0].detail && small.cut === undefined, 'a note that fits is left whole');
  const across = buildNotes({ ...run, resultPrs: [A, B, C] }, { ...result, prs: [...result.prs, entry(C, sha('c'))], findings: [finding('F-1', A), finding('F-2', C, { title: 'Private' })] }, [A])[A];
  assert.deepEqual([across.findings.map(f => f.pr), handoverBlock(across).includes('Private')], [[A], false], "a finding on another repo's PR never travels to this repo's note");
  const body = noteBody('finished', small);
  assert.ok(body.endsWith('<!-- prowl-review AB7-r1 started -->'), "it ends with the started marker, so the comment is still Prowl's own");
  assert.equal(parseHandover(body.replace(/\n/g, '\r\n')).run, 'AB7-r1', 'CRLF line ends parse');
  assert.deepEqual([parseHandover(body.replace('prowl-handover v1', 'prowl-handover v2')), parseHandover('<!-- prowl-handover v1\n{"run":1}\n-->'), parseHandover('<!-- prowl-handover v1\nnot json\n-->')], [null, null, null], "another version's note, or one that isn't { run, pr, no }, is left unread");
  const damaged = over => parseHandover(noteBody('finished', { ...small, ...over }));
  assert.deepEqual([damaged({ prs: 'x' }), damaged({ at: undefined }), damaged({ findings: [{ pr: A }] }), damaged({ approved: [] })], [null, null, null, null], 'a damaged note is left unread, never half-used');
  assert.deepEqual(byReview([{ run: 'a', by: 'x', no: 1, at: 9 }, { run: 'b', by: 'y', no: 2, at: 1 }, { run: 'a', by: 'X', no: 1, at: 9 }]).map(g => g.length), [1, 2], 'grouped by review, the later number first whatever the clocks say');

  const reviews = [{ user: 'alice', state: 'APPROVED', at: 't1', body: banner('AB7-r1'), commit: sha('a'), assoc: 'MEMBER' }];
  const outsider = [{ ...reviews[0], assoc: 'CONTRIBUTOR' }];
  assert.deepEqual([noteTrusted(small, 'alice', outsider), prowlApproved(outsider, sha('a')), prowlApproved(outsider, sha('a'), { me: 'Alice' })], [false, false, true], "a review by someone outside the repo is never a teammate's PR-Owl; your own always is yours");
  assert.deepEqual([noteTrusted(small, 'alice', reviews), noteTrusted(small, 'mallory', reviews), noteTrusted(small, 'alice', reviews, ['Alice']), noteTrusted(small, 'alice', [{ ...reviews[0], body: 'lgtm' }])],
    [true, false, false, false], "believed only from who posted that review, and never from a PR's author");
  const stamp = { user: 'alice', state: 'COMMENTED', at: 't2', body: banner('AB7-r2'), commit: sha('a'), assoc: 'COLLABORATOR' };
  assert.deepEqual([prowlApproved(reviews, sha('a')), prowlApproved(reviews, sha('c')), prowlApproved([{ ...reviews[0], state: 'DISMISSED' }], sha('a')), prowlApproved([...reviews, { ...stamp, state: 'CHANGES_REQUESTED' }], sha('a'))],
    [true, false, false, false], "approved only by PR-Owl's latest review, at that commit, while it stands");
  assert.deepEqual([prowlApproved([stamp], sha('a')), prowlApproved([stamp], sha('a'), { marker: postMarker('AB7-r2') }), prowlApproved([stamp], sha('a'), { marker: postMarker('AB7-r2'), author: 'alice' })],
    [false, true, false], "a stamp counts only as the very review recorded, and never the PR author's own");
  assert.equal(prowlApproved([{ ...stamp, body: `${stamp.body.replace(postMarker('AB7-r2'), '')}<!-- prowl-verdict changes -->\n\n${postMarker('AB7-r2')}` }], sha('a'), { marker: postMarker('AB7-r2') }), false, 'a comment review with blocking findings is never a stamp');
  const two = { ...small, prs: [A, B], heads: { [A]: sha('a'), [B]: sha('b'), [C]: sha('c') }, approved: {}, findings: [] };
  assert.deepEqual([Object.keys(priorFromNotes([two]).reviewedHeads), Object.keys(priorFromNotes([{ ...two, cut: 1 }]).reviewedHeads)], [[A], []], "a delta starts only where the PR's own note is at hand, whole; a PR it only read in another repo, whose findings didn't travel, is read in full");
  const D = 'https://github.com/acme/web/pull/4';
  assert.deepEqual([Object.keys(priorFromNotes([{ ...two, heads: { [D]: sha('d') } }]).reviewedHeads), Object.keys(priorFromNotes([{ ...two, heads: { [D]: sha('d') }, cutOther: 1 }]).reviewedHeads)], [[D], []], 'one in the same repo keeps its commit, unless its findings had to be left out');
  const huge = buildNotes({ ...run, prs: Array.from({ length: 3000 }, (_, i) => ({ url: `https://github.com/acme/web/pull/${i + 1}` })) }, { ...result, findings: [] }, [A]);
  assert.deepEqual(Object.keys(huge), [], "a note whose links alone don't fit isn't posted");
}

// ---- Two Prowls on one board ----

async function twoProwls(assert, appDir, board) {
  const key = n => (board === 'ado' ? `AB#${n}` : `PROJ-${n}`);
  const hub = { prs: {}, comments: {}, reviews: {}, ids: 0, noteReads: 0, verdicts: {}, failSearch: false, failEdit: false };
  const addPr = (n, ticket, author = 'dev') => {
    const url = `https://github.com/acme/r${n}/pull/${n}`;
    hub.prs[url] = { url, title: `${ticket}: PR ${n}`, number: n, repo: `acme/r${n}`, author, draft: false, state: 'open', headSha: sha('a'), labels: [] };
    hub.comments[url] = [];
    hub.reviews[url] = [];
    return url;
  };
  const shape = p => ({ url: p.url, title: p.title, number: p.number, repo: p.repo, author: p.author, draft: p.draft, state: p.state, headSha: p.headSha, labels: [...p.labels] });
  const urlOf = pr => pr.url || `https://github.com/${pr.repo}/pull/${pr.number}`;
  const as = login => ({
    me: async () => login,
    openPrs: async (owner, k) => { if (hub.failSearch) throw new Error('search is down'); return Object.values(hub.prs).filter(p => p.state === 'open' && p.title.startsWith(`${k}:`)).map(shape); },
    prByRef: async ref => shape(hub.prs[urlOf(ref)]),
    headSha: async pr => hub.prs[pr.url].headSha,
    cloneMissing: async () => [], isOpen: async () => true, humanApproved: async () => false,
    prStats: async () => ({ files: 1, additions: 1, deletions: 0, commits: 1 }), headBranch: async () => 'work',
    postComment: async (pr, file) => {
      const id = ++hub.ids;
      hub.comments[pr.url].push({ id, user: login, body: JSON.parse(fs.readFileSync(file, 'utf8')).body, url: `${pr.url}#issuecomment-${id}` });
      return `${pr.url}#issuecomment-${id}`;
    },
    editComment: async (pr, id, file) => {
      if (hub.failEdit) throw new Error('Resource not accessible (HTTP 403)');
      hub.comments[pr.url].find(c => String(c.id) === String(id)).body = JSON.parse(fs.readFileSync(file, 'utf8')).body;
    },
    issueComments: async pr => { hub.noteReads++; return structuredClone(hub.comments[pr.url]); },
    allReviews: async pr => structuredClone(hub.reviews[pr.url]),
  });
  const tickets = {};
  const trigger = loadConfig().tags.trigger;
  const tag = n => { tickets[key(n)] = { key: key(n), ref: key(n), title: `Work ${n}`, url: `https://tracker.invalid/${n}`, tags: [trigger] }; };
  const tracker = {
    name: 'Board', boardLabel: () => 'Team', ticketText: async () => '',
    findTickets: async (c, b, isTrigger) => ({ tickets: Object.values(tickets).filter(t => t.tags.some(isTrigger)).map(t => structuredClone(t)), variants: [trigger] }),
    current: async (c, t) => structuredClone(tickets[t.key]), lookup: async (c, k) => structuredClone(tickets[k]),
    claim: async (c, t, drop, add) => { tickets[t.key].tags = [add]; }, retag: async (c, ref, drop, add) => { tickets[ref].tags = add ? [add] : []; },
  };
  /** One person's Prowl: its own login, state and Log. A review's session never runs; finish() ends it with a result. */
  const prowl = login => {
    const cfg = { ...loadConfig(), taskBoard: board, githubOwner: 'acme', workDir: fs.mkdtempSync(`${process.env.PROWL_HOME || '/tmp'}/memory-`), githubReviews: false, quickLabels: false, reviewPrep: false,
      reviewChecks: false, ticketContext: false, maxConcurrentReviews: 10, maxReviewRounds: 0, reReviewScope: 'delta', quickName: 'number' };
    const logs = [];
    const gh = as(login);
    const app = { cfg, me: '', sideOn: () => true, tracker: () => tracker, boards: () => [{}], dryRun: () => false };
    const side = createReviewer(app, { github: gh, log: (level, msg) => { logs.push(msg); return true; }, forget() {}, hoot() {}, appDir, trackers: { ado: tracker, jira: tracker }, sizeWaitMs: 0,
      labels: { own() {}, set() {}, refused: () => '', pending: () => false, owner: () => '', drain: async () => {} },
      // Posts each PR's review as hub.verdicts says: 'approve', or changes requested.
      publishReview: async (rn, result, d) => {
        for (const pr of rn.prs) {
          const [id, ok, head] = [++hub.ids, hub.verdicts[pr.url] === 'approve', hub.prs[pr.url].headSha];
          hub.reviews[pr.url].push({ id, user: login, state: ok ? 'APPROVED' : 'CHANGES_REQUESTED', at: new Date().toISOString(), body: banner(rn.id), commit: head, assoc: 'MEMBER', url: `${pr.url}#pullrequestreview-${id}` });
          (rn.published ??= {})[`review:${pr.url}`] = `${pr.url}#pullrequestreview-${id}`;
          if (ok) rn.approved[pr.url] = head;
        }
        return { ...planPublish(result, { run: rn, templates: d.templates, labels: d.labels, prs: {} }), info: {} };
      } });
    side.state = { runs: [], failures: {} };
    side.startReview = (c, dir, opts) => createReview(c, { ...opts, appDir: dir });
    const finish = async (rn, verdicts, findings = [], unverified = {}) => {
      hub.verdicts = verdicts;
      fs.writeFileSync(rn.resultPath, JSON.stringify({ version: 1, batchId: rn.batchId, batch: { goal: 'Deliver it.', mergeOrder: 'Any.', complete: 'Yes.' },
        prs: rn.resultPrs.map(u => entry(u, hub.prs[u].headSha, unverified[u] || null)), findings, questions: [] }));
      rn._result = { subtype: 'success', is_error: false, total_cost_usd: 1 };
      await side.finish(rn);
    };
    return { side, cfg, logs, gh, finish, last: () => side.state.runs.at(-1) };
  };
  const [alice, bob] = [prowl('alice'), prowl('bob')];
  const on = `on ${board}`;

  // 1. Alice's Prowl finishes review 1: each PR's started comment now holds the finished line, the note and the marker.
  tag(1);
  const [p1, p2] = [addPr(1, key(1), 'dev1'), addPr(2, key(1), 'dev2')];
  await alice.side.poll();
  const a1 = alice.last();
  assert.deepEqual([a1.reviewNo, a1.prs.map(p => p.url), Object.keys(a1.startedComments || {})], [1, [p1, p2], [p1, p2]], `Alice's review 1 starts, and keeps its started comments' links ${on}`);
  await alice.finish(a1, { [p1]: 'approve' }, [finding('F-01', p2, { title: 'Cart total wrong' })], { [p2]: "couldn't run the tests" });
  const notes = [p1, p2].map(u => hub.comments[u]);
  assert.deepEqual(notes.map(c => c.length), [1, 1], 'the started comment is edited, not joined by another');
  assert.ok(notes.every(([c]) => c.body.startsWith(`🦉 **PR-Owl** finished review 1 of this PR for [${key(1)}](https://tracker.invalid/1).`) && c.body.endsWith(`<!-- prowl-review ${a1.id} started -->`)), `the finished line links the ticket ${on}`);
  const [n1, n2] = notes.map(([c]) => parseHandover(c.body));
  assert.deepEqual([n1.ticket, n1.no, n1.by, n1.approved, n1.findings.length, n2.findings.map(f => f.title), n2.unverified, n2.reviewed], [key(1), 1, 'alice', { [p1]: sha('a') }, 0, ['Cart total wrong'], [{ url: p2, text: "couldn't run the tests" }], [p1, p2]]);
  assert.deepEqual([a1.status, a1.handedOver, tickets[key(1)].tags], ['done', true, [alice.cfg.tags.changes]]);

  // 2. Bob's Prowl, with empty state, carries on: review 2, the approved PR as context, the delta from the note's heads.
  hub.prs[p2].headSha = sha('c');
  tickets[key(1)].tags = [trigger];
  await bob.side.poll();
  const b2 = bob.last();
  assert.deepEqual([b2.reviewNo, b2.prs.map(p => p.url), b2.contextPrs.map(p => p.url), b2.priorId, b2.approved, b2.approvedBy, b2.reviewedBefore], [2, [p2], [p1], a1.id, { [p1]: sha('a') }, { [p1]: a1.id }, [p1, p2]], `Bob's Prowl takes the next number and leaves the approved PR out ${on}`);
  const brief = fs.readFileSync(b2.promptPath, 'utf8');
  assert.ok(brief.includes("run by @alice's Prowl, whose hand-over note on the PRs is where what follows comes from") && brief.includes('Cart total wrong') && brief.includes(`- ${p2}: ${sha('a')}..${sha('c')}`) && brief.includes("couldn't run the tests"),
    "the brief names her Prowl, and carries her open findings, the commits since, and what she couldn't check");
  assert.deepEqual(b2.priorGiven.map(g => g.ref), [`${a1.batchId} F-01`]);
  assert.ok(bob.logs.some(l => l === `${key(1)}: its last review (review 1) was run by @alice's Prowl; carrying on from the hand-over note it left on the PRs`));

  // 9. Bob's review leaves its own note (with the finding it still owed), and Max review rounds counts both Prowls' reviews.
  await bob.finish(b2, {}, [finding('F-01', p2, { title: 'Another one' })]);
  const nb = hub.comments[p2].map(c => parseHandover(c.body)).find(n => n?.run === b2.id);
  assert.deepEqual([nb.no, nb.by, nb.findings.map(f => f.ref).sort(), nb.approver, nb.reviewed], [2, 'bob', [`${a1.batchId} F-01`, `${b2.batchId} F-01`].sort(), { [p1]: a1.id }, [p2, p1]], 'the next note carries what was owed, and who approved what');
  alice.cfg.maxReviewRounds = 2;
  tickets[key(1)].tags = [trigger];
  await alice.side.poll();
  assert.ok(alice.last() === a1 && alice.logs.some(l => l.includes(`${key(1)}: not reviewed: it has had 2 reviews, the round cap`)), `the cap counts a teammate's review ${on}`);
  alice.cfg.maxReviewRounds = 0;

  // 3. A note pasted by someone who didn't post that review, or left by a PR's author, is ignored.
  const ask = (who, extra = {}) => recall({ gh: as(who), log() {}, me: who, key: key(1), ticket: true, own: undefined, runs: [], covered: [], cover: [shape(hub.prs[p2])], heads: { [p2]: sha('c') }, known: [shape(hub.prs[p1])], ...extra });
  assert.equal((await ask('carol')).prior.id, b2.id, "a third Prowl reads the latest review's note");
  const real = hub.comments[p2];
  hub.comments[p2] = real.map(c => ({ ...c, user: 'mallory' }));
  assert.equal((await ask('carol')).prior?.id, a1.id, 'a note in a comment by someone else is ignored: the earlier, believed review stands');
  hub.comments[p2] = real;
  hub.prs[p1].author = 'bob';
  assert.equal((await ask('carol')).prior?.id, a1.id, "a note by the author of one of the ticket's open PRs is ignored");
  hub.prs[p1].author = 'dev1';

  // 4. Alice's approval is dismissed on GitHub: the PR is reviewed again, on another Prowl and on her own.
  tag(3);
  const p3 = addPr(3, key(3));
  await alice.side.poll();
  const a3 = alice.last();
  await alice.finish(a3, { [p3]: 'approve' });
  assert.deepEqual([a3.approved, tickets[key(3)].tags], [{ [p3]: sha('a') }, [alice.cfg.tags.approved]]);
  const seen = { key: key(3), cover: [shape(hub.prs[p3])], heads: { [p3]: sha('a') }, known: [] };
  assert.deepEqual((await ask('bob', seen)).prior.approved, { [p3]: sha('a') }, 'approved in the note, and still on GitHub');
  hub.reviews[p3][0].state = 'DISMISSED';
  const after = (await ask('bob', seen)).prior;
  assert.deepEqual([after.approved, after.reviewedHeads], [{}, {}], "dismissed: a teammate's Prowl reviews it again, in full (no delta from the commit it was approved at)");
  const noComments = await recall({ gh: { ...as('bob'), issueComments: async () => { throw new Error('down'); } }, log() {}, me: 'bob', ticket: true, own: { ...a3 }, runs: [], covered: [], ...seen });
  assert.deepEqual(noComments.prior.approved, {}, "comments that can't be read don't hide what the reviews say");
  tickets[key(3)].tags = [trigger];
  await alice.side.poll();
  assert.deepEqual([alice.last().reviewNo, alice.last().prs.map(p => p.url), a3.approved], [2, [p3], { [p3]: sha('a') }], 'and so does her own, with her finished review left as it was');
  assert.ok(alice.logs.some(l => l.includes(`${p3} was approved by review 1, but PR-Owl's latest review on it no longer approves that commit; it is reviewed again`)));

  // 5 and 6. No note at all (a teammate on an older Prowl): approved on GitHub is left out; a later request for changes isn't.
  tag(4);
  const p4 = addPr(4, key(4));
  hub.reviews[p4].push({ id: ++hub.ids, user: 'olduser', state: 'APPROVED', at: 't1', body: banner('old-r1'), assoc: 'MEMBER', commit: sha('a'), url: `${p4}#pullrequestreview-1` });
  const runsBefore = bob.side.state.runs.length;
  await bob.side.poll();
  assert.ok(bob.side.state.runs.length === runsBefore && bob.logs.some(l => l === `${key(4)}: every PR is already approved and unchanged since; nothing to re-review`), `approved by PR-Owl at its head, with no note: left out ${on}`);
  hub.reviews[p4].push({ id: ++hub.ids, user: 'olduser', state: 'CHANGES_REQUESTED', at: 't2', body: banner('old-r2'), assoc: 'MEMBER', commit: sha('a'), url: `${p4}#pullrequestreview-2` });
  tickets[key(4)].tags = [trigger];
  await bob.side.poll();
  assert.deepEqual([bob.last().ticket, bob.last().reviewNo, bob.last().prs.map(p => p.url)], [key(4), 1, [p4]], 'a newer PR-Owl review requesting changes: reviewed again');

  // 10. A quick review under a name is not a ticket: no note is read or written, and an approved PR is still left out.
  const [p5, p6] = [addPr(5, 'none'), addPr(6, 'none')];
  hub.reviews[p5].push({ id: ++hub.ids, user: 'alice', state: 'APPROVED', at: 't1', body: banner('x-r1'), assoc: 'MEMBER', commit: sha('a'), url: `${p5}#pullrequestreview-1` });
  const reads = hub.noteReads;
  await assert.rejects(bob.side.quickReview('acme/r5#5', { as: 'Some name' }), /every PR is already approved, with no new commits since PR-Owl's last review/);
  const q = await bob.side.quickReview('acme/r5#5 acme/r6#6', { as: 'Some name' });
  assert.deepEqual([/^QUICK#\d+$/.test(q.ticket), q.prs.map(p => p.url), q.contextPrs.map(p => p.url), q.approved], [true, [p6], [p5], { [p5]: sha('a') }]);
  await bob.finish(q, {});
  assert.deepEqual([hub.noteReads, hub.comments[p6].length, parseHandover(hub.comments[p6][0].body), q.handedOver], [reads, 1, null, undefined], 'no note read, none written');

  // A quick review waiting on its approved PR: labelled again with no new commits, it goes ahead only once the approval is dismissed.
  bob.cfg.quickLabels = true;
  const p9 = addPr(9, 'none');
  const w1 = await bob.side.quickReview('acme/r9#9', { as: 'Waited on' });
  await bob.finish(w1, { [p9]: 'approve' });
  hub.prs[p9].labels = [bob.cfg.reviewLabel || 'prowl: review'];
  await bob.side.poll();
  assert.ok(bob.last() === w1 && bob.logs.some(l => l.includes('no PR has new commits since it was approved; still waiting')), 'approved and unchanged: the label alone waits');
  hub.reviews[p9].at(-1).state = 'DISMISSED';
  await bob.side.poll();
  assert.deepEqual([bob.last().ticket, bob.last().reviewNo, bob.last().prs.map(p => p.url)], [w1.ticket, 2, [p9]], `the approval dismissed on GitHub: the labelled PR is reviewed again ${on}`);
  bob.cfg.quickLabels = false;

  // 11. A review of only some of a ticket's PRs whose look-up of the others fails reads no note, and says so once.
  tag(7);
  const p7 = addPr(7, key(7));
  await alice.side.poll();
  await alice.finish(alice.last(), {}, [finding('F-01', p7)]);
  assert.ok(parseHandover(hub.comments[p7][0].body));
  hub.failSearch = true;
  const partial = await bob.side.quickReview('acme/r7#7', { as: key(7) });
  hub.failSearch = false;
  assert.deepEqual([partial.ticket, partial.reviewNo, partial.priorGiven], [key(7), 1, []], "this Prowl's own state is what it goes by");
  assert.equal(bob.logs.filter(l => l === `${key(7)}: couldn't look up its other PRs (search is down), so no hand-over note is read this time; going by this Prowl's own reviews`).length, 1);

  // 12. Editing the comment fails: a warning, the review is still done, and it isn't tried again.
  tag(8);
  const p8 = addPr(8, key(8));
  await alice.side.poll();
  const a8 = alice.last();
  hub.failEdit = true;
  await alice.finish(a8, { [p8]: 'approve' });
  hub.failEdit = false;
  assert.ok(alice.logs.some(l => l === `${key(8)}: couldn't leave its hand-over note on acme/r8#8 (Resource not accessible (HTTP 403)); a teammate's Prowl reviews it next without it`));
  assert.deepEqual([a8.status, a8.handedOver, alice.side.state.failures[key(8)], parseHandover(hub.comments[p8][0].body)], ['done', true, undefined, null]);
  await alice.side.finish(a8);
  assert.equal(parseHandover(hub.comments[p8][0].body), null, 'settled again, it leaves no note a second time');
}
