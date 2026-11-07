// GitHub labels on PRs: the markers of a quick review's or a ticketless build's cycle (In Review, Reviewed, Ready for
// Review, In Development), named after the tags. Both sides write them through one queue, kept in labels.json, so
// writes to a PR land in the order they were asked for, whichever side asked. Neither side imports the other.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, writeJson } from './config.mjs';
import { norm, tagMatches } from './match.mjs';

export const LABELS_PATH = path.join(HOME, 'labels.json');

/** The HTTP status in a gh api error ("… (HTTP 404)"), or 0. */
export const httpStatus = e => Number(/\(HTTP (\d{3})\)/.exec(e?.message || '')?.[1]) || 0;
/** True for a refusal that lasts: 403 (not a rate limit), 404 or 410. */
export const refusal = e => [404, 410].includes(httpStatus(e)) || (httpStatus(e) === 403 && !/rate limit|abuse/i.test(e.message));

/** The labels on a PR that `name` stands for: the same, ignoring case and punctuation, or within `typos` (0 = exact). */
export const matching = (labels, name, typos = 0) => labels.filter(l => norm(l) === norm(name) || (typos > 0 && tagMatches(l, name, typos)));

/**
 * The queue. `gh`: { prLabels(pr), addLabel(pr, name), removeLabel(pr, name) }; `log(side, level, msg, key)`. Each write
 * is { side, owner, url, repo, number, add, remove: [names], typos }: `owner` the review or build that asked (its id).
 */
export function createLabels({ gh, log, file = LABELS_PATH, now = Date.now }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  state.ops ??= [];
  state.owners ??= {}; // `${side} ${url}` -> the owner whose writes count there
  state.refused ??= {}; // `${owner} ${url}` -> why GitHub refuses it, for that owner
  state.landed ??= {}; // `${owner} ${url}` -> the label it last put on there
  const save = () => writeJson(file, state, (k, v) => (k.startsWith('_') ? undefined : v));
  let busy = false;

  const q = {
    /** `owner` takes the labels of `urls` on `side` over: an older owner's writes there are dropped. */
    own(side, owner, urls) {
      for (const url of urls) state.owners[`${side} ${url}`] = owner;
      save();
    },
    owner: (side, url) => state.owners[`${side} ${url}`] || '',
    /** Queues a write: `add` ('' for none) after taking off each of `remove`. */
    set(side, owner, pr, add, remove, typos = 0) {
      if (q.refused(owner, pr.url)) return;
      state.ops.push({ side, owner, url: pr.url, repo: pr.repo, number: pr.number, add: add || '', remove: remove.filter(Boolean), typos, at: now() });
      save();
    },
    /** True while a write to `url` is queued (by `owner`, or by anyone). */
    pending: (url, owner = '') => state.ops.some(o => o.url === url && (!owner || o.owner === owner)),
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
      if (busy) return undefined;
      const heads = [];
      for (const o of state.ops) if (!heads.some(h => h.url === o.url)) heads.push(o);
      const due = heads.filter(o => now() >= (o._retryAt || 0));
      if (!due.length) return undefined;
      busy = true;
      return (async () => {
        for (const o of due) await write(o);
      })().finally(() => { busy = false; });
    },
    /** Runs every write that's due until none is: for --once and the self-test. */
    async drain() {
      for (let i = 0; i < 50 && state.ops.some(o => now() >= (o._retryAt || 0)); i++) await q.tick();
    },
    state: () => state,
  };

  async function write(o) {
    const done = () => { state.ops = state.ops.filter(x => x !== o); save(); };
    const pr = { url: o.url, repo: o.repo, number: o.number };
    if (q.owner(o.side, o.url) && q.owner(o.side, o.url) !== o.owner) return done(); // a newer review or build has these labels now
    try {
      const on = await gh.prLabels(pr);
      const off = [...new Set(o.remove.flatMap(name => matching(on, name, o.typos)))]
        .filter(l => !(o.add && norm(l) === norm(o.add)));
      for (const l of off) await gh.removeLabel(pr, l); // one already gone counts as removed
      if (o.add && !matching(on, o.add).length) await gh.addLabel(pr, o.add);
      if (o.add) state.landed[`${o.owner} ${o.url}`] = o.add;
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
