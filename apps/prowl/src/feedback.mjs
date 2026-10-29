// Review feedback on the user's PRs: which threads a round takes on, Parked findings, the user's past answers, and
// whether a feedback round's result.json is usable. Pure functions, covered by the self-test.
import fs from 'node:fs';
import { replyMarker } from './templates.mjs';

/** The comment-thread URLs listed in a details file's *Parked* section: those findings are left to a person. */
export function parkedUrls(details) {
  const m = /^## Parked[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(details || '');
  return m ? m[1].match(/https:\/\/\S+?(?=[)\s>]|$)/g) || [] : [];
}

/** A details file without its *Parked* section: those findings are left to a person. */
export const stripParked = details => String(details || '').replace(/^## Parked[ \t]*\n[\s\S]*?(?=^## |(?![\s\S]))/m, '');

/**
 * The unresolved threads a round takes on: from whoever `from` covers ('prowl', 'prowl+bots' or 'everyone'), not
 * parked, and not answered by Prowl last (its fix or dispute waits for the next review, or a person, to answer it).
 */
export function actionable(threads, from, parked = []) {
  const covers = t => from === 'everyone' || /<!-- prowl-review /.test(t.body + t.lastBody) || (from === 'prowl+bots' && t.bot);
  return threads.filter(t => !t.resolved && covers(t) && !parked.includes(t.url) && !/<!-- prowl-fix /.test(t.lastBody));
}

const STOP = new Set('this that with from have will would should could there their what when which into your about only also than then them they been were does done make made just need needs here some more most such each other after before while where these those because'.split(' '));
const words = text => new Set(String(text).toLowerCase().match(/[a-z][a-z0-9_]{3,}/g)?.filter(w => !STOP.has(w)) || []);

/** The user's past answers in any of `repos` that share at least two keywords with `text`, best first. */
export function pastAnswers(answers, text, repos, max = 5) {
  const have = words(text);
  const inRepo = a => [a.repo, ...(a.repos || [])].some(r => [repos].flat().includes(r));
  return answers.filter(inRepo)
    .map(a => ({ a, score: [...words(a.question)].filter(w => have.has(w)).length }))
    .filter(x => x.score >= 2).sort((x, y) => y.score - x.score).slice(0, max).map(x => x.a);
}

/** The user's past answers, from an answers.jsonl. */
export function readAnswers(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(l => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}

export const appendAnswer = (file, entry) => fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);

const ACTIONS = ['fix', 'dispute', 'ask', 'park'];

/** Why a feedback round's result.json is unusable, or '' when it is valid. */
export function validateFeedback(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'it is not a JSON object';
  if (!['fixed', 'partial', 'blocked'].includes(r.status)) return 'status must be fixed, partial or blocked';
  if (!Array.isArray(r.items)) return 'items must be a list';
  const bad = r.items.find(it => !ACTIONS.includes(it?.action));
  if (bad) return `item ${bad?.thread || bad?.finding || '?'} has no action (fix, dispute, ask or park)`;
  if (r.commits != null && !Array.isArray(r.commits)) return 'commits must be a list';
  const c = (r.commits || []).find(x => !/^[0-9a-f]{7,40}$/i.test(x?.sha || ''));
  if (c) return `the commit for ${c?.pr || c?.repo || '?'} is not a commit sha`;
  if (r.questions != null && !Array.isArray(r.questions)) return 'questions must be a list';
  const qs = r.questions || [];
  const q = qs.find(x => !String(x?.text || '').trim() || !String(x?.searched || '').trim());
  if (q) return `the question "${String(q?.text || '').slice(0, 80)}" has no ${q?.text ? 'searched line' : 'text'}`;
  if (r.items.some(it => it.action === 'ask') && !qs.length) return 'an ask item has no question';
  return '';
}

/**
 * The replies a round still has to post on PR `pr`: one per thread from its brief that the session fixed (once
 * pushed) or disputed, leaving out any whose marker is already in `posted` (the PR's comment bodies).
 * `threads`: the round's threads for this PR, [{ id, commentId }]. [{ thread, commentId, what, note, marker }]
 */
export function repliesToPost({ ticket, round, items = [], threads = [], pushed }, posted) {
  const known = new Map(threads.map(t => [t.id, t]));
  return items
    .filter(it => known.has(it.thread) && (it.action === 'dispute' || (it.action === 'fix' && pushed)))
    .map(it => {
      const what = it.action === 'fix' ? 'fixed' : 'disputed';
      return { thread: it.thread, commentId: known.get(it.thread).commentId, what, note: it.note || '', marker: replyMarker(ticket, round, it.thread, what) };
    })
    .filter(r => !posted.some(b => b.includes(r.marker)));
}
