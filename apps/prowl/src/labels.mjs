// GitHub labels mark board, GitHub and quick reviews, and the Builder's ticketless builds. Both sides use the
// queue in labels.json so their writes to a PR land in order. Neither side imports the other.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, writeJson } from './config.mjs';
import { norm, tagMatches } from './match.mjs';
import { sameLabel } from './names.mjs';

export const LABELS_PATH = path.join(HOME, 'labels.json');

/** The HTTP status in a gh api error ("… (HTTP 404)"), or 0. */
export const httpStatus = e => Number(/\(HTTP (\d{3})\)/.exec(e?.message || '')?.[1]) || 0;
/** True for a refusal that lasts: 403 (not a rate limit), 404 or 410. */
export const refusal = e => [404, 410].includes(httpStatus(e)) || (httpStatus(e) === 403 && !/rate limit|abuse/i.test(e.message));

/** The labels on a PR that `name` stands for: the same, ignoring case and punctuation, or within `typos` (0 = exact). */
export const matching = (labels, name, typos = 0) => labels.filter(l => norm(l) === norm(name) || (typos > 0 && tagMatches(l, name, typos)));

/**
 * The queue. `gh`: { prLabels(pr), addLabel(pr, name, color), removeLabel(pr, name) }; `log(side, level, msg, key)`.
 * Each write is { side, owner, url, repo, number, add, exact, old, loose, typos, keep, color }: `owner` the review or
 * build that asked (its id).
 */
export function createLabels({ gh, log, file = LABELS_PATH, now = Date.now }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  state.ops ??= [];
  state.owners ??= {}; // `${side} ${url}` -> the owner whose writes count there
  state.refused ??= {}; // `${owner} ${url}` -> why GitHub refuses it, for that owner
  state.landed ??= {}; // `${owner} ${url}` -> the label it last put on there
  const save = () => writeJson(file, state, (k, v) => (k.startsWith('_') ? undefined : v));
  let inFlight;

  const q = {
    /** `owner` takes the labels of `urls` on `side` over: an older owner's writes there are dropped. */
    own(side, owner, urls) {
      for (const url of urls) state.owners[`${side} ${url}`] = owner;
      save();
    },
    owner: (side, url) => state.owners[`${side} ${url}`] || '',
    /**
     * Queues a write (names.labelWrite): `add` ('' for none) after taking off the names in `exact` (Prowl's own labels:
     * the same but for case and outer spaces), in `old` (older names: by letters and digits) and in `loose` (the old
     * trigger name: within `typos`). A label that is exactly one of `keep` (Prowl's five) only comes off through `exact`.
     * Returns the queued write so a claim can check this attempt's _addState after drain, even if it reuses an owner.
     */
    set(side, owner, pr, { add = '', exact = [], old = [], loose = [], typos = 0, keep = [], color = '' }) {
      if (q.refused(owner, pr.url)) return;
      const names = list => list.filter(Boolean);
      const op = { side, owner, url: pr.url, repo: pr.repo, number: pr.number, add, exact: names(exact), old: names(old), loose: names(loose), typos, keep: names(keep), color, at: now() };
      state.ops.push(op);
      save();
      return op;
    },
    /** Once, at launch: each write queued before the labels had names of their own becomes `renamed(op)` (null leaves it). */
    rename(renamed) {
      let changed = false;
      state.ops = state.ops.map(o => { const n = renamed(o); if (!n) return o; changed = true; const { remove, ...rest } = o; return { ...rest, ...n }; });
      if (changed) save();
    },
    /** True for a queued write, optionally by owner or explicitly removing a current label. */
    pending: (url, owner = '', removes = '') => state.ops.some(o => o.url === url && (!owner || o.owner === owner)
      && (!removes || (!superseded(o) && !sameLabel(o.add, removes) && o.exact?.some(n => sameLabel(n, removes))))),
    /** Why GitHub refuses `owner`'s writes on `url`, or ''. */
    refused: (owner, url) => state.refused[`${owner} ${url}`] || '',
    /** Forgets a refusal: the PR can be read again. */
    clearRefusal(owner, url) { if (state.refused[`${owner} ${url}`]) { delete state.refused[`${owner} ${url}`]; save(); } },
    /** The label `owner` last put on `url` and that landed, or ''. */
    landed: (owner, url) => state.landed[`${owner} ${url}`] || '',
    /** Drops `owner`'s queued writes (on `urls`, or everywhere). */
    drop(owner, urls = null) {
      const before = state.ops.length;
      state.ops = state.ops.filter(o => o.owner !== owner || (urls && !urls.includes(o.url)));
      if (state.ops.length !== before) save();
    },
    /** Once a second: the first due write on each PR, one at a time. A write that fails waits a minute; the PR's later writes wait behind it. */
    tick() {
      if (inFlight) return inFlight;
      const heads = [];
      for (const o of state.ops) if (!heads.some(h => h.url === o.url)) heads.push(o);
      const due = heads.filter(o => now() >= (o._retryAt || 0));
      if (!due.length) return undefined;
      inFlight = (async () => {
        for (const o of due) await write(o);
      })().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    /** Waits for the current tick and runs all due writes, including claims queued during that tick. */
    async drain() {
      for (let tick = q.tick(); tick; tick = q.tick()) await tick;
    },
    state: () => state,
  };

  function superseded(o) {
    const owner = q.owner(o.side, o.url);
    return owner && owner !== o.owner;
  }

  async function write(o) {
    const done = () => { state.ops = state.ops.filter(x => x !== o); save(); };
    const pr = { url: o.url, repo: o.repo, number: o.number };
    if (superseded(o)) return done(); // a newer review or build has these labels now
    try {
      const on = await gh.prLabels(pr);
      const any = (list, same) => (list || []).some(same);
      const ours = l => any(o.keep, k => sameLabel(l, k)); // one of Prowl's five: never taken for an older name
      const off = on.filter(l => !(o.add && sameLabel(l, o.add)) && (any(o.exact, n => sameLabel(l, n))
        || (!ours(l) && (any([...(o.old || []), ...(o.remove || [])], n => norm(l) === norm(n)) || any(o.loose, n => tagMatches(l, n, o.typos))))));
      for (const l of off) await gh.removeLabel(pr, l); // one already gone counts as removed
      if (o.add) {
        if (!on.some(l => sameLabel(l, o.add))) {
          o._addState = 'sent'; // a transport error from here can mean the label still reached GitHub
          await gh.addLabel(pr, o.add, o.color || undefined);
          o._addState = 'landed';
        } else o._addState = 'present';
        state.landed[`${o.owner} ${o.url}`] = o.add;
      }
      done();
    } catch (e) {
      if (refusal(e)) {
        state.refused[`${o.owner} ${o.url}`] = `GitHub refuses it (${e.message.split('\n')[0]})`;
        state.ops = state.ops.filter(x => !(x.owner === o.owner && x.url === o.url));
        save();
        return log(o.side, 'warn', `${o.repo}#${o.number}: GitHub won't let Prowl change its labels (${e.message.split('\n')[0]}); left as they are for this ${o.side === 'builder' ? 'build' : 'review'}`);
      }
      o._retryAt = now() + 60_000;
      log(o.side, 'warn', `${o.repo}#${o.number}: couldn't change its labels yet (${e.message.split('\n')[0]}); retrying every minute`, `label:${o.url}`);
    }
    return undefined;
  }

  return q;
}
