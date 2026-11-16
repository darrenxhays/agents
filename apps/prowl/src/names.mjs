// The names Prowl gives its GitHub labels and its tags, and which older names it still reads. Pure functions, covered
// by `node prowl.mjs --self-test`. A ticket's tags and a PR's labels carry the same names, so the two read alike.
import { norm, tagMatches } from './match.mjs';

/** The GitHub label that asks for a review of a PR (reviewLabel). */
export const REVIEW_LABEL = 'prowl: review';
/** The GitHub labels Prowl sets on PRs (labels.*). */
export const LABELS = { inReview: 'prowl: in review', approved: 'prowl: approved', changes: 'prowl: changes requested', building: 'prowl: building' };
// The names Prowl used to put on PRs, when its labels were named after the tags. Still read, never written.
const OLD_LABELS = { ask: 'Ready for Review', inReview: 'In Review', done: 'Reviewed', building: 'In Development' };
const COLORS = { ask: '1d76db', inReview: 'fbca04', approved: '0e8a16', changes: 'd93f0b', building: '5319e7' };

/** True when two label names are the same but for case and outer spaces: Prowl's own labels are matched this exactly. */
export const sameLabel = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** The labels Prowl sets, as configured: each labels.* setting, or its default when left empty. */
export const labelNames = cfg => Object.fromEntries(Object.entries(LABELS).map(([role, name]) => [role, String(cfg.labels?.[role] ?? '').trim() || name]));

/** The label that asks for a review of a PR: reviewLabel, or left empty, the name of tags.trigger. */
export const askLabel = cfg => String(cfg.reviewLabel ?? '').trim() || cfg.tags.trigger;

/** Prowl's five labels as configured: { ask, inReview, approved, changes, building }. */
export const fiveLabels = cfg => ({ ask: askLabel(cfg), ...labelNames(cfg) });

/**
 * The older names still read as each of Prowl's labels, never written: { ask, inReview, done, building }, each a
 * list. The names Prowl used to put on PRs, a tag the user had renamed (its label was named after it), and any name
 * the move to the prowl: names reset (tagsWere). One that is exactly one of today's five is today's, not an old one.
 */
export function oldLabels(cfg) {
  const five = Object.values(fiveLabels(cfg));
  const were = cfg.tagsWere || {};
  const list = (...names) => {
    const seen = new Set();
    return names.filter(n => String(n ?? '').trim() && !five.some(f => sameLabel(f, n)) && !seen.has(norm(n)) && seen.add(norm(n)));
  };
  return {
    ask: list(OLD_LABELS.ask, cfg.tags?.trigger, were.reviewer?.trigger),
    inReview: list(OLD_LABELS.inReview, cfg.tags?.inProgress, were.reviewer?.inProgress),
    done: list(OLD_LABELS.done, cfg.tags?.approved, cfg.tags?.changes, cfg.tags?.done, were.reviewer?.done, were.reviewer?.approved, were.reviewer?.changes),
    building: list(OLD_LABELS.building, cfg.builder?.tags?.inProgress, were.builder?.inProgress),
  };
}

/**
 * What label `l` on a PR is to Prowl: 'ask' (a review is asked for), 'inReview', 'approved', 'changes', 'building',
 * 'done' (an old outcome: it holds nothing), or '' for anyone else's label. Today's five are matched exactly, but
 * for case and outer spaces: `prowl-review` is not `prowl: review` on GitHub, and `prowl: review` is within two
 * typos of `prowl: in review`. The old names are matched as they were: by letters and digits, the old ask within the
 * typo tolerance.
 */
export function labelRole(cfg, l) {
  const five = fiveLabels(cfg);
  const exact = Object.keys(five).find(role => sameLabel(l, five[role]));
  if (exact) return exact;
  const old = oldLabels(cfg);
  for (const role of ['inReview', 'building', 'done']) if (old[role].some(n => norm(n) === norm(l))) return role;
  return old.ask.some(n => tagMatches(l, n, cfg.tagMatchMaxTypos)) ? 'ask' : '';
}

/** The labels on a PR (`labels`) that are `role` to Prowl. */
export const labelsOf = (cfg, labels, role) => (labels || []).filter(l => labelRole(cfg, l) === role);

/** The colour a label of Prowl's is created with on a repo that lacks it. */
export const labelColor = (name, cfg) => COLORS[Object.entries(fiveLabels(cfg)).find(([, n]) => sameLabel(n, name))?.[0]] || 'c5def5';

/**
 * A label write for the queue (src/labels.mjs): `add` (one of Prowl's five, or '' for none), with what comes off in
 * the same write: `off` (roles of today's five, taken off exactly) and `oldOff` (roles whose old names come off).
 */
export function labelWrite(cfg, add, off, oldOff) {
  const five = fiveLabels(cfg);
  const old = oldLabels(cfg);
  return { add, exact: off.map(role => five[role]).filter(n => !sameLabel(n, add)), old: oldOff.filter(r => r !== 'ask').flatMap(r => old[r]),
    loose: oldOff.includes('ask') ? old.ask : [], typos: cfg.tagMatchMaxTypos, keep: Object.values(five), color: add ? labelColor(add, cfg) : '' };
}

/**
 * A write queued in labels.json before the labels had names of their own ({ add, remove, loose }), under today's:
 * the old in-progress name becomes labels.inReview, the old done name `outcome` (that PR's outcome label, from the
 * review that owns the write), the trigger's reviewLabel, the Builder's in-progress labels.building. Null for a
 * write that is in today's form already.
 */
export function renamedWrite(cfg, op, outcome = '') {
  if (op.exact) return null;
  const five = fiveLabels(cfg);
  const role = op.add ? labelRole(cfg, op.add) : '';
  const add = role === 'done' ? outcome || five.changes : five[role] || op.add;
  const reviewer = op.side !== 'builder';
  const w = !op.add ? labelWrite(cfg, '', reviewer ? ['inReview', 'approved', 'changes'] : ['building', 'ask'], reviewer ? ['inReview', 'done'] : ['building', 'ask'])
    : reviewer ? labelWrite(cfg, add, ['inReview', 'approved', 'changes', ...(role === 'inReview' ? ['ask'] : [])], ['inReview', 'done', ...(role === 'inReview' ? ['ask'] : [])])
      : labelWrite(cfg, add, ['building', 'ask', 'approved', 'changes'], ['building', 'ask']);
  return { ...w, old: [...new Set([...w.old, ...(op.remove || []).filter(n => !(op.loose || []).includes(n))])] };
}

// ---- Tags ----

/** The Reviewer's single done tag, from before it said how the review went. Still read (and taken off), never written. */
export const OLD_DONE = 'Reviewed';

/** The Reviewer's tags as it uses them. */
export const reviewTags = cfg => ({ trigger: cfg.tags.trigger, inProgress: cfg.tags.inProgress,
  approved: cfg.tags.approved || cfg.tags.done || '', changes: cfg.tags.changes || cfg.tags.done || '' });

/** Approved when the review approved every PR it reviewed; else changes requested (a PR it couldn't review counts too). */
export const outcomeTag = (run, tags) => ((run.prs || []).length && run.prs.every(p => run.approved?.[p.url]) ? tags.approved : tags.changes);

/**
 * A saved config's tags.done, split in two: one still `Reviewed` (or empty) is dropped, so the two defaults apply;
 * one the user renamed is kept for both outcomes, unless already saved. Returns true when `saved` changed.
 */
export function splitDone(saved) {
  const tags = saved?.tags;
  if (!tags || typeof tags !== 'object' || !('done' in tags)) return false;
  const renamed = typeof tags.done === 'string' && tags.done.trim() && norm(tags.done) !== norm(OLD_DONE) ? tags.done : '';
  if (renamed) for (const k of ['approved', 'changes']) if (!(k in tags)) tags[k] = renamed;
  delete tags.done;
  return true;
}
