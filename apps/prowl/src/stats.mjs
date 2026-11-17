// What reviews and builds cost: what is recorded per session (its model, its effort, its cost per model), and the
// numbers the Stats view shows. Pure, except readLogUsage, which reads a session's log.
import fs from 'node:fs';

/** The time frames Stats steps through, in days (0: all time). It starts on 30. */
export const RANGES = [7, 30, 90, 0];
export const rangeName = days => (days ? `last ${days} days` : 'all time');

/** A session's cost per model, from its last `result` event's modelUsage: { model: cost }, only finite costs above 0; null when there are none. */
export function modelCosts(result) {
  const out = {};
  for (const [model, u] of Object.entries(result?.modelUsage && typeof result.modelUsage === 'object' ? result.modelUsage : {})) {
    const cost = Number(u?.costUSD);
    if (Number.isFinite(cost) && cost > 0) out[model] = cost;
  }
  return Object.keys(out).length ? out : null;
}

/** What a session ran on, for a Status row: `model · effort effort`, `model · effort not recorded`, `model not recorded` when neither is known and it cost something, else ''. */
export const modelEffort = ({ model, effort, costUsd } = {}) => (model ? `${model} · ${effort ? `${effort} effort` : 'effort not recorded'}` : costUsd ? 'model not recorded' : '');

/** `models` scaled so they add up to `cost` (a session can spend a little after its cost is recorded). */
export function scaledModels(models, cost) {
  const sum = Object.values(models || {}).reduce((n, c) => n + c, 0);
  if (!sum) return {};
  const by = Number.isFinite(cost) && cost > 0 ? cost / sum : 1;
  return Object.fromEntries(Object.entries(models).map(([m, c]) => [m, c * by]));
}

/** Adds a part's cost to `into`, per model: its models scaled to its cost, or the whole under `not recorded` when it has none. */
export function addModels(into, models, cost) {
  const scaled = scaledModels(models, cost);
  if (!Object.keys(scaled).length) { if (cost > 0) into['not recorded'] = (into['not recorded'] || 0) + cost; return into; }
  for (const [m, c] of Object.entries(scaled)) into[m] = (into[m] || 0) + c;
  return into;
}

/** A Models row: each model and its cost, dearest first (`a $8.36 · b $1.88`), or '' when the costs span one model or none. `parts`: [{ models, costUsd }]. */
export function breakdown(parts) {
  const by = {};
  for (const p of parts) addModels(by, p.models, partCost(p));
  delete by['not recorded'];
  const list = Object.entries(by).sort((a, b) => b[1] - a[1]);
  return list.length > 1 ? list.map(([m, c]) => `${m} $${c.toFixed(2)}`).join(' · ') : '';
}

/** A part's cost: its recorded cost, or with none, the sum of its models. */
const partCost = p => (Number.isFinite(p.costUsd) && p.costUsd != null ? p.costUsd : Object.values(p.models || {}).reduce((n, c) => n + c, 0));

/**
 * The model and the cost per model a session's log holds: the model from its system/init event (near the start), the
 * costs from its last result event (near the end). Reads the two ends of the file, 64 KB first and four times more
 * while an event isn't found, 4 MB at most. { model, models } (each null when the log has none); null when the file is gone.
 */
export function readLogUsage(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const chunk = (from, len) => {
    const buf = Buffer.alloc(Math.max(0, Math.min(len, size - from)));
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
    return buf.toString('utf8');
  };
  const events = text => text.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && typeof e === 'object');
  let model = null;
  let result = null;
  for (let len = 64 * 1024; ; len *= 4) {
    model ??= events(chunk(0, len)).find(e => e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string')?.model ?? null;
    result ??= events(chunk(Math.max(0, size - len), len)).filter(e => e.type === 'result').at(-1) ?? null;
    if ((model && result) || len >= size || len >= 4 * 1024 * 1024) break;
  }
  return { model, models: modelCosts(result) };
}

/**
 * Once, for reviews finished before Prowl recorded these: each run with a log and no `models` field gets its model
 * and cost per model from its log. `models` is set to null when the log has none, so it is read once only. Returns
 * how many were read (the caller saves when any were).
 */
export function backfillUsage(runs, read = readLogUsage) {
  let n = 0;
  for (const r of runs) {
    if (!r.logPath || 'models' in r || !r.endedAt) continue;
    const got = read(r.logPath);
    r.models = got?.models ?? null;
    if (got?.model && !r.model) r.model = got.model;
    n++;
  }
  return n;
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
/** A bar for `value` against `max`, `width` columns at most, drawn in eighths of a column: at least one eighth for any value above 0, '' for 0. */
export function bar(value, max, width) {
  if (!(value > 0) || !(max > 0)) return '';
  const eighths = Math.max(1, Math.round((value / max) * width * 8));
  return '█'.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
}

const pad2 = n => String(n).padStart(2, '0');
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const weekStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)); // Monday
/** When a time frame of `days` begins: today and the days - 1 before it, from local midnight. -Infinity for all time. */
export function frameStart(days, now = Date.now()) {
  if (!days) return -Infinity;
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
}

/** What a side spent in a time frame: the cost of every part that ended in it. */
export function spendIn(entries, { days, now = Date.now() } = {}) {
  const from = frameStart(days, now);
  return entries.reduce((n, e) => n + e.parts.filter(p => p.at >= from && p.at <= now).reduce((m, p) => m + partCost(p), 0), 0);
}

/**
 * The numbers Stats shows for `entries` ([{ ticket, title, ticketUrl, label, at, failed, parts: [{ at, ms, costUsd,
 * models, model, effort }] }]) in a time frame of `days` (0: all time) ending `now`. Spend per day, per model and per
 * effort come from the parts that ended in the time frame; counts, averages and the top lists from the entries that
 * ended in it, each counting only its own parts inside it. Returns { total, count, avgCost, avgMs (null when none
 * was timed), failedCost, buckets: [{ label, cost, n }] (newest first), models and efforts: [{ name, cost, pct }]
 * (dearest first), topCost and topTime: [{ entry, cost, ms }], topTickets: [{ ticket, title, ticketUrl, cost, n, ms }] }.
 */
export function summarize(entries, { days = 30, now = Date.now(), top = 5 } = {}) {
  const from = frameStart(days, now);
  const inFrame = p => p.at >= from && p.at <= now;
  const parts = entries.flatMap(e => e.parts.filter(inFrame));
  const total = parts.reduce((n, p) => n + partCost(p), 0);

  // Buckets: days for a time frame up to 31 days, weeks beyond and for all time, from the first spend to today.
  const weekly = !days || days > 31;
  const startOf = weekly ? weekStart : dayStart;
  const buckets = [];
  const first = parts.length ? Math.min(...parts.map(p => p.at)) : null;
  if (first != null) {
    const oldest = startOf(new Date(first)).getTime();
    // Stepped by calendar date, snapping to the day's or week's start each time: a daylight-saving change never shifts later buckets.
    for (let cur = startOf(new Date(now)); cur.getTime() >= oldest; cur = startOf(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - (weekly ? 7 : 1)))) {
      const end = startOf(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + (weekly ? 7 : 1))).getTime();
      const own = parts.filter(p => p.at >= cur.getTime() && p.at < end);
      buckets.push({ label: weekly ? `wk ${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}` : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][cur.getDay()]} ${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}`,
        at: cur.getTime(), cost: own.reduce((n, p) => n + partCost(p), 0), n: own.length });
    }
  }
  const shares = by => Object.entries(by).map(([name, cost]) => ({ name, cost, pct: total > 0 ? Math.round((cost / total) * 100) : 0 })).sort((a, b) => b.cost - a.cost);
  const byModel = {};
  const byEffort = {};
  for (const p of parts) {
    addModels(byModel, p.models, partCost(p));
    if (partCost(p) > 0) byEffort[p.effort || 'not recorded'] = (byEffort[p.effort || 'not recorded'] || 0) + partCost(p);
  }

  const mine = entries.filter(e => e.at >= from && e.at <= now).map(e => {
    const own = e.parts.filter(inFrame);
    const timed = own.length > 0 && own.every(p => Number.isFinite(p.ms));
    return { entry: e, cost: own.reduce((n, p) => n + partCost(p), 0), ms: own.reduce((n, p) => n + (Number.isFinite(p.ms) ? p.ms : 0), 0), timed };
  });
  const timed = mine.filter(x => x.timed);
  const tickets = new Map();
  for (const x of mine) {
    const t = tickets.get(x.entry.ticket) || { ticket: x.entry.ticket, title: x.entry.title, ticketUrl: x.entry.ticketUrl, cost: 0, n: 0, ms: 0 };
    tickets.set(x.entry.ticket, { ...t, cost: t.cost + x.cost, n: t.n + 1, ms: t.ms + x.ms });
  }
  return {
    total, count: mine.length,
    avgCost: mine.length ? mine.reduce((n, x) => n + x.cost, 0) / mine.length : 0,
    avgMs: timed.length ? timed.reduce((n, x) => n + x.ms, 0) / timed.length : null,
    failedCost: mine.filter(x => x.entry.failed).reduce((n, x) => n + x.cost, 0),
    buckets, models: shares(byModel), efforts: shares(byEffort),
    topCost: mine.filter(x => x.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, top),
    topTime: timed.sort((a, b) => b.ms - a.ms).slice(0, top),
    topTickets: [...tickets.values()].filter(t => t.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, top),
  };
}
