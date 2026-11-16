// Text helpers for what Prowl posts from a review's result, and the review's report. Pure. The result's text was
// written by a session about other people's code: it is escaped and fenced here so it can't break out of where it goes.
import { bySeverity, counts, isCounted, isParked, SEVERITIES } from './result.mjs';

export const LIMIT = 65_536; // GitHub's cap on a review body or a comment, in characters
export const TRIMMED = "(trimmed: over GitHub's 65,536-character limit)";
export const short = sha => String(sha || '').slice(0, 7);
export const prName = url => { const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(String(url || '')); return m ? `${m[1]}#${m[2]}` : String(url || ''); };

/** `text` with every < outside a code span turned into &lt;, so it can't open an HTML tag or comment on GitHub. */
export function esc(text) {
  return String(text ?? '').split(/(`+[\s\S]*?`+)/).map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;'))).join('');
}

/** `text` on one line, for a note: no line breaks or backticks, runs of hyphens cut to one, | turned into /. */
export const flat = text => String(text ?? '').replace(/\s+/g, ' ').replace(/`/g, '').replace(/-{2,}/g, '-').replace(/\|/g, '/').trim();

/** A fence no run of backticks in `text` can end: one longer than the longest, at least `min`. */
export const fenceFor = (text, min = 3) => '`'.repeat(Math.max(min, ...(String(text).match(/`+/g) || []).map(r => r.length + 1)));

/**
 * A template filled in: each <name> in `vars` is replaced, names it doesn't know are left as they are. A line that
 * holds only placeholders which are all known and all came out empty is dropped, along with a blank line the drop
 * would leave doubled.
 */
export function fillTemplate(tpl, vars) {
  const PH = /<([a-z][\w #/-]*)>/gi;
  const out = [];
  let skipBlank = false;
  for (const line of String(tpl ?? '').split('\n')) {
    const names = [...line.matchAll(PH)].map(m => m[1]);
    const only = names.length && !line.replace(PH, '').trim();
    if (only && names.every(n => n in vars && !String(vars[n] ?? '').trim())) {
      skipBlank = out.length > 0 && out.at(-1).trim() === '';
      continue;
    }
    if (skipBlank && !line.trim()) { skipBlank = false; continue; }
    skipBlank = false;
    out.push(line.replace(PH, (m, k) => (k in vars ? String(vars[k] ?? '') : m)));
  }
  return out.join('\n');
}

/** `text` cut to `cap` characters with the trimmed note; a cut inside a code fence closes the fence. */
export function cut(text, cap) {
  const t = String(text ?? '');
  if (cap == null || t.length <= cap) return t;
  let kept = t.slice(0, cap).trimEnd();
  let open = '';
  for (const line of kept.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (!open) open = m[1];
    else if (line.trim().startsWith(open) && !line.trim().slice(open.length).trim()) open = '';
  }
  if (open) kept += `\n${open}`;
  return `${kept}\n${TRIMMED}`;
}

/** A part of the hidden note, as plain one-line text that can't end the HTML comment it sits in or split its line. */
const notePart = text => String(text ?? '').replace(/\s+/g, ' ').replace(/`/g, '').replace(/-{2,}/g, '-').replace(/\|/g, '/').replace(/<!|>/g, '').trim();

/**
 * The hidden note that ends a review body: the findings its verifiers checked and found not to be defects (`findings`,
 * most severe first), a `refuted: <where> | <title> | <why>` line each, so a later review of the PR, from anyone's
 * Prowl, reads them before raising the same thing again. '' with nothing to list. Capped at `max` characters: lines
 * are kept in order until the cap, and the comment is always closed.
 */
export function stateNote(findings, max = Math.floor(LIMIT * 0.15)) {
  const lines = findings.map(f => {
    const why = f.status === 'addressed-elsewhere' && f.crossPr ? `handled in ${f.crossPr.counterpart}: ${f.outcome?.note || f.crossPr.why}` : f.outcome?.note || f.problem;
    return `refuted: ${notePart(place(f.location)) || 'no single place'} | ${notePart(f.title)} | ${notePart(why)}`;
  });
  const [open, close] = ['<!-- prowl-state', '-->'];
  let size = open.length + close.length + 1;
  const kept = [];
  for (const l of lines) {
    if (size + l.length + 1 > max) break;
    kept.push(l);
    size += l.length + 1;
  }
  return kept.length ? [open, ...kept, close].join('\n') : '';
}

/** `path:line` for a finding's location, or '' when it has no single place. */
export const place = loc => (loc?.path ? `${loc.path}${loc.line ? `:${loc.line}` : ''}` : '');

const sev = f => String(f.severity || '').toUpperCase();
const link = (text, url) => (url ? `[${text}](${url})` : '');
const row = cells => `| ${cells.map(c => String(c ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ')).join(' | ')} |`;

/**
 * A review's report, written by Prowl from the result. `run`: the review (ticket, title, reviewNo, published, …);
 * `plan`: planPublish()'s outcome, for each PR's verdict, skip reason and review link; `info`: each PR's title and
 * author from GitHub, by URL. The front matter is what History and Stats read.
 */
export function reportMd(result, run, plan, info = {}) {
  const pub = run.published || {};
  const opts = { parkHumanOnly: run.parkHumanOnly };
  const recs = Object.fromEntries(plan.prs.map(r => [r.url, r]));
  const reviewed = plan.reviewed;
  const n = counts(result, reviewed, opts);
  const all = result.findings || [];
  const noted = f => (reviewed.includes(f.pr) ? '' : recs[f.pr]?.skip === 'merged' || recs[f.pr]?.skip === 'closed' ? ' (merged before the review was posted; not counted)' : ' (not reviewed; not counted)');
  const findingLink = f => pub[`comment:${f.pr}:${f.id}`] || pub[`reply:${f.pr}:${f.id}`] || f.earlier?.url || pub[`review:${f.pr}`] || '';
  const ref = f => (String(f.id).startsWith('C-') && f.earlier?.ref ? ` (${f.earlier.ref.trim()})` : '');
  const lines = ['---', `ticket: ${run.ticket}`, `review: ${run.reviewNo}`, `verdict: ${plan.verdict}`, ...SEVERITIES.map(s => `${s}: ${n[s]}`), `fixed: ${n.fixed}`, `stillOpen: ${n.stillOpen}`, '---', '',
    `# PR-Owl review ${run.reviewNo}: ${run.ticketUrl ? `[${run.ticket}](${run.ticketUrl})` : run.ticket} ${esc(run.title || '')}`.trimEnd(), '',
    '## Summary', '', esc(result.batch?.goal || ''), '',
    `- **Batch verdict:** ${plan.verdict}`, `- **Merge order:** ${esc(result.batch?.mergeOrder || '')}`, `- **Complete:** ${esc(result.batch?.complete || '')}`, `- **Batch:** ${result.batchId}`, '',
    '## Pull requests', '', row(['PR', 'Title', 'Author', 'Verdict', 'Review']), '|---|---|---|---|---|'];
  const urls = [...new Set([...plan.prs.map(r => r.url), ...(result.prs || []).map(p => p.url)])];
  for (const url of urls) {
    const r = recs[url];
    const review = pub[`review:${url}`] ? link('review', pub[`review:${url}`]) : r?.skip || (run.publishErrors?.[url] ? 'not posted' : run.unreviewed?.[url] ? 'not posted' : 'not posted');
    lines.push(row([link(prName(url), url), esc(info[url]?.title || ''), info[url]?.author ? `@${info[url].author}` : '', reviewed.includes(url) ? r.verdict : 'n/a', review]));
  }
  // Issues found: this run's findings that count, and earlier ones still present, per PR.
  lines.push('', '## Issues found', '');
  const issues = bySeverity(all.filter(f => isCounted(f, opts)));
  if (!issues.length && !plan.prs.some(r => r.notChecked?.length || r.notCarried?.length)) lines.push('No issues found.');
  for (const url of urls) {
    const mine = issues.filter(f => f.pr === url);
    const r = recs[url];
    if (!mine.length && !r?.notChecked?.length && !r?.notCarried?.length) continue;
    lines.push(`### ${prName(url)}`, '');
    for (const f of mine) {
      const first = f.earlier?.by === 'someone-else' ? ` · raised first by @${f.earlier.author || 'someone'}: ${f.earlier.url || 'no link'}${pub[`reply:${f.pr}:${f.id}`] ? `, reply: ${pub[`reply:${f.pr}:${f.id}`]}` : ''}` : '';
      lines.push(`- **[${sev(f)}] ${f.id} ${esc(f.title)}**${ref(f)}${place(f.location) ? ` · \`${place(f.location)}\`` : ''}${findingLink(f) ? ` · ${link('comment', findingLink(f))}` : ''}${first}${noted(f)}`,
        `  - Problem: ${esc(flat(f.detail?.explanation || f.problem))}`,
        ...(f.detail?.scenario ? [`  - Failure scenario: ${esc(flat(f.detail.scenario))}`] : []),
        `  - Fix: ${esc(flat(f.detail?.fixDetail || f.fix))}`,
        ...(f.crossPr ? [`  - Cross-PR: with ${f.crossPr.counterpart}; the fix belongs in ${f.crossPr.fixBelongsTo || f.pr}: ${esc(flat(f.crossPr.why))}`] : []),
        ...(f.consumer ? [`  - Consumer outside the batch: ${f.consumer.repo} \`${f.consumer.path}\``] : []));
    }
    if (r?.notChecked?.length) lines.push('', `**Not checked:** ${r.notChecked.map(x => esc(flat(x))).join('; ')}.`);
    if (r?.notCarried?.length) lines.push('', `**Not carried over:** ${r.notCarried.join(', ')}: earlier PR-Owl findings this review doesn't account for.`);
    lines.push('');
  }
  const prior = all.filter(f => String(f.id).startsWith('C-'));
  lines.push('', '## What was fixed', '');
  const fixed = prior.filter(f => f.status === 'fixed');
  if (!fixed.length) lines.push(prior.length ? 'Nothing.' : 'No earlier findings.');
  for (const f of fixed) lines.push(`- ${f.id} ${esc(f.title)}${ref(f)} · fixed in ${short(f.outcome?.commit)}${f.earlier?.url ? ` · ${link('thread', f.earlier.url)}` : ''}${noted(f)}`);
  lines.push('', '## Still open from the previous review', '');
  const open = prior.filter(f => isCounted(f, opts) || isParked(f, opts) || f.status === 'deferred');
  if (!open.length) lines.push(prior.length ? 'Nothing.' : 'No earlier findings.');
  for (const f of bySeverity(open)) {
    const kind = f.status === 'deferred' ? 'Deferred' : isParked(f, opts) ? 'Parked' : 'Still open';
    lines.push(`- ${kind}: ${f.id} [${sev(f)}] ${esc(f.title)}${ref(f)} on ${prName(f.pr)}${f.earlier?.url ? ` · ${link('thread', f.earlier.url)}` : ''}${f.outcome?.answer ? ` · answer: ${f.outcome.answer}` : ''}${f.outcome?.note ? ` · ${esc(flat(f.outcome.note))}` : ''}${noted(f)}`);
  }
  const gone = prior.filter(f => f.status === 'no-longer-applies');
  if (gone.length) {
    lines.push('', '### No longer applies', '');
    for (const f of gone) lines.push(`- ${f.id} ${esc(f.title)}${ref(f)} on ${prName(f.pr)}${f.earlier?.url ? ` · ${link('thread', f.earlier.url)}` : ''}: ${esc(flat(f.outcome?.note))}`);
  }
  lines.push('', '## Not posted', '');
  const not = all.filter(f => ['refuted', 'addressed-elsewhere', 'withdrawn', 'disputed'].includes(f.status) || (f.status === 'unverifiable' && !isParked(f, opts)));
  if (!not.length) lines.push('Nothing.');
  for (const f of not) lines.push(`- ${f.status}: ${f.id} ${esc(f.title)} on ${prName(f.pr)}${place(f.location) ? ` (\`${place(f.location)}\`)` : ''}: ${esc(flat(f.outcome?.note))}`);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
