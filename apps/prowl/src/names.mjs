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
  // A context PR's write: only the review request comes off. Its outcome label is its own, and stays.
  const askOnly = !op.add && (op.remove || []).length > 0 && (op.remove || []).every(n => labelRole(cfg, n) === 'ask');
  const w = askOnly ? labelWrite(cfg, '', ['ask'], ['ask']) : !op.add ? labelWrite(cfg, '', reviewer ? ['inReview', 'approved', 'changes'] : ['building', 'ask'], reviewer ? ['inReview', 'done'] : ['building', 'ask'])
    : reviewer ? labelWrite(cfg, add, ['inReview', 'approved', 'changes', ...(role === 'inReview' ? ['ask'] : [])], ['inReview', 'done', ...(role === 'inReview' ? ['ask'] : [])])
      : labelWrite(cfg, add, ['building', 'ask', 'approved', 'changes'], ['building', 'ask']);
  return { ...w, old: [...new Set([...w.old, ...(op.remove || []).filter(n => !(op.loose || []).includes(n))])] };
}

// ---- Tags ----

/** The tags' defaults: the same names as the GitHub labels, so a ticket on the board and a PR on GitHub read alike. */
export const TAGS = {
  reviewer: { trigger: REVIEW_LABEL, inProgress: LABELS.inReview, approved: LABELS.approved, changes: LABELS.changes },
  builder: { start: 'prowl: build', inProgress: LABELS.building },
};
/** The tags' defaults before they took the labels' names. Still read on tickets, never written. */
export const OLD = {
  reviewer: { trigger: 'Ready for Review', inProgress: 'In Review', done: 'Reviewed' },
  builder: { start: 'Ready to Start', inProgress: 'In Development' },
};

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

/**
 * Moves a saved config (as read, before the defaults are merged in) to the prowl: tag names, once: a tag still at
 * its old default is deleted, so the new default applies; one the user renamed stays (a renamed done tag for both
 * outcomes), unless it now reads the same as another tag of its own side, which is reset and recorded in tagsWere.
 * Returns the Log's lines for what moved ([] for a config that had no saved tags, or was moved before).
 */
export function migrateNames(saved) {
  if (saved.namesVersion >= 2) return [];
  const notes = [];
  const fresh = !saved.tags && !saved.builder?.tags;
  const move = (tags, old, defaults, side) => {
    if (!tags || typeof tags !== 'object') return;
    for (const [role, was] of Object.entries(old)) {
      if (!(role in tags) || norm(tags[role]) !== norm(was)) continue;
      const to = role === 'done' ? `${defaults.approved}' or '${defaults.changes}` : defaults[role];
      notes.push(`${side}'s tag '${tags[role]}' is now '${to}'`);
      delete tags[role];
    }
  };
  move(saved.tags, OLD.reviewer, TAGS.reviewer, 'Reviewer');
  move(saved.builder?.tags, OLD.builder, TAGS.builder, 'Builder');
  splitDone(saved); // a renamed done tag: kept for both outcomes
  // A renamed tag that now reads the same as another tag of its own side can't stay: Prowl couldn't tell them apart.
  const clash = (tags, defaults, side, key) => {
    if (!tags || typeof tags !== 'object') return;
    const now = () => ({ ...defaults, ...tags });
    // Again after each reset: a name put back to its default can read the same as one that was fine until then.
    for (let again = true; again;) {
      again = false;
      for (const role of Object.keys(defaults)) {
        if (!(role in tags)) continue;
        const twin = Object.keys(defaults).find(other => other !== role && norm(now()[other]) === norm(tags[role]) && !(['approved', 'changes'].includes(role) && ['approved', 'changes'].includes(other)));
        if (!twin) continue;
        ((saved.tagsWere ??= {})[key] ??= {})[role] = tags[role];
        notes.push(`${side}'s tag '${tags[role]}' read the same as another of its tags, so it is now '${defaults[role]}'`);
        delete tags[role];
        again = true;
      }
    }
  };
  clash(saved.tags, TAGS.reviewer, 'Reviewer', 'reviewer');
  clash(saved.builder?.tags, TAGS.builder, 'Builder', 'builder');
  saved.namesVersion = 2;
  return fresh ? [] : notes;
}

/** The role `t` had, when it is a name the move reset (`were`: that side's tagsWere), limited to `roles` if given; else ''. */
export function wasRole(were, tags, t, ...roles) {
  const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  if (!were || !String(t ?? '').trim() || Object.values(tags).some(x => same(x, t))) return '';
  return Object.keys(were).find(r => (!roles.length || roles.includes(r)) && same(were[r], t)) || '';
}

/**
 * wasRole() for a Jira label: there a tag is on issues as a label, so a reset name is known in the spellings Prowl has
 * written it in too (a dash for each run of spaces, with its colons dropped, or kept as older versions did). One of
 * today's tags in either spelling still comes first.
 */
function wasJiraRole(were, tags, t) {
  const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const spellings = s => { const dashed = String(s ?? '').trim().replace(/\s+/g, '-'); return [s, dashed, dashed.replace(/:/g, '')]; };
  if (!were || !String(t ?? '').trim() || Object.values(tags).some(x => spellings(x).some(v => same(v, t)))) return '';
  return Object.keys(were).find(r => spellings(were[r]).some(v => same(v, t))) || '';
}

/**
 * How Prowl reads a ticket's tags: { role(t), exactRole(t), has(tags, tag) }. A role is '<side>.<role>':
 * reviewer.trigger, .inProgress, .approved, .changes, .done (the old Reviewed); builder.start, .inProgress. A tag that
 * reads (letters and digits) as any of Prowl's names, today's or an old one, on either side, has that name's role and
 * no other; only then is the typo tolerance tried, for the trigger and the start tag alone. `has(tags, tag)`: true
 * when `tags` holds one with the role `tag` has, old names included.
 */
export function tagReader(cfg) {
  const r = reviewTags(cfg);
  const bt = cfg.builder?.tags || {};
  const today = { 'reviewer.trigger': r.trigger, 'reviewer.inProgress': r.inProgress, 'reviewer.approved': r.approved, 'reviewer.changes': r.changes, 'builder.start': bt.start, 'builder.inProgress': bt.inProgress };
  const old = { 'reviewer.trigger': OLD.reviewer.trigger, 'reviewer.inProgress': OLD.reviewer.inProgress, 'reviewer.done': OLD.reviewer.done, 'builder.start': OLD.builder.start, 'builder.inProgress': OLD.builder.inProgress };
  const exactRole = t => {
    // A name the move reset reads the same as one of today's tags: matched to the letter, and first.
    const read = cfg.taskBoard === 'jira' ? wasJiraRole : wasRole; // only Jira respells a tag
    const was = read(cfg.tagsWere?.reviewer, r, t);
    if (was) return `reviewer.${was}`;
    const built = read(cfg.tagsWere?.builder, bt, t);
    if (built) return `builder.${built}`;
    const n = norm(t);
    return Object.keys(today).find(k => today[k] && norm(today[k]) === n) || Object.keys(old).find(k => norm(old[k]) === n) || '';
  };
  const near = (t, ...names) => names.some(name => name && tagMatches(t, name, cfg.tagMatchMaxTypos));
  const role = t => exactRole(t) || (near(t, r.trigger, OLD.reviewer.trigger) ? 'reviewer.trigger' : near(t, bt.start, OLD.builder.start) ? 'builder.start' : '');
  const has = (tags, tag) => { const want = exactRole(tag); return (tags || []).some(t => (want ? exactRole(t) === want : norm(t) === norm(tag))); };
  return { role, exactRole, has };
}

/**
 * A tag write left pending by the Prowl from before the update, under today's name for its role: the old in-progress
 * names become today's, the old Reviewed `outcome` (that run's outcome tag), the old trigger tags.trigger. One of
 * today's tags, an empty one and any other name are left as they are.
 */
export function pendingTag(cfg, tag, outcome = '') {
  if (!tag) return tag;
  const r = reviewTags(cfg);
  const bt = cfg.builder?.tags || {};
  if ([...Object.values(r), ...Object.values(bt)].some(x => x === tag)) return tag;
  return { 'reviewer.trigger': r.trigger, 'reviewer.inProgress': r.inProgress, 'reviewer.done': outcome || tag, 'reviewer.approved': r.approved, 'reviewer.changes': r.changes,
    'builder.start': bt.start, 'builder.inProgress': bt.inProgress }[tagReader(cfg).exactRole(tag)] || tag;
}
