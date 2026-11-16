// What Prowl posts on GitHub for a review, worked out from its result: per PR, the replies on earlier threads, the
// threads to reopen and resolve, the review with its inline comments, and the details file. Pure: publish.mjs makes
// the calls, and runs planPublish() again before each one, so later posts can link what earlier ones produced.
import { cut, esc, fenceFor, fillTemplate, flat, LIMIT, place, prName, short, stateNote, TRIMMED } from './render.mjs';
import { approvable, bySeverity, counts, eventFor, findingsOn, isCounted, isParked, notCarried, notChecked, NOT_FULLY, SEVERITIES, supersededTally, worst } from './result.mjs';

/** The right-side lines of a file's patch that can take a comment (added and context lines), each with its hunk's index. */
export function commentableLines(patch) {
  const lines = new Map();
  let right = 0;
  let hunk = -1;
  for (const l of String(patch || '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { right = Number(h[1]); hunk++; continue; }
    if (hunk < 0 || l.startsWith('\\') || l.startsWith('-')) continue;
    if (l.startsWith('+') || l.startsWith(' ')) { lines.set(right, hunk); right++; }
  }
  return lines;
}

/** A PR's changed files ([{ filename, patch }]) as path -> commentable lines. A binary or too-large file has no patch, so no line. */
export const commentable = files => new Map((files || []).map(f => [f.filename, commentableLines(f.patch)]));
const hunkOf = (files, path, line) => files?.get(path)?.get(line);

/** The run's review marker, which ends every review body; and the markers of a finding's comment or reply, and of a part 2 comment. */
export const reviewMarker = runId => `<!-- prowl-review ${runId} review -->`;
export const findingMarker = (batchId, id) => `<!-- prowl-review ${batchId} ${id} -->`;
export const part2Marker = runId => `<!-- prowl-review ${runId} part2 -->`;

/** True when Prowl's latest reply on `thread` already says the finding is still open at this head: nothing new to say. */
export function saidStillOpen(thread, reviewedAt) {
  const last = thread?.lastBody || '';
  return Boolean(last && thread.lastProwlBody === last && /<!-- prowl-review /.test(last) && last.includes(short(reviewedAt)) && !/verified fixed|no longer applies/i.test(last));
}

/**
 * `result` with each finding's `earlier` on `prUrl` set from the PR's threads as GitHub has them now (`threads`:
 * [{ id, commentId, resolved, outdated }]): the thread's state is GitHub's, never the session's, and a thread that
 * isn't among that PR's is cleared, so nothing is ever planned on another PR's thread. null threads (unreadable): as given.
 */
export function withThreads(result, prUrl, threads) {
  if (!threads) return result;
  return { ...result, findings: (result.findings || []).map(f => {
    const e = f.earlier;
    if (f.pr !== prUrl || !e || (!e.threadId && !e.commentId)) return f;
    const t = threads.find(x => e.threadId && x.id === e.threadId) || threads.find(x => e.commentId && x.commentId === e.commentId);
    if (!t) return { ...f, earlier: { ...e, threadId: null, commentId: null, threadState: 'none' } };
    return { ...f, earlier: { ...e, threadId: t.id, commentId: t.commentId, threadState: t.resolved ? 'resolved' : t.outdated ? 'outdated' : 'open' } };
  }) };
}

/** What one finding on an open, reviewed PR comes to on GitHub. `files`: the PR's commentable lines; `threads`: by id. */
export function disposition(f, { files, threads = {}, reviewedAt, parkHumanOnly = false }) {
  const e = f.earlier;
  const thread = Boolean(e?.threadId && e.commentId);
  const d = { counted: isCounted(f, { parkHumanOnly }), parked: isParked(f, { parkHumanOnly }), anchor: null, reply: null, reopen: false, resolve: false, link: null, alsoRaised: false, state: false };
  const inline = () => {
    const { path, line, startLine } = f.location || {};
    const hunk = path && line ? hunkOf(files, path, line) : undefined;
    if (hunk !== undefined) d.anchor = { path, line, ...(startLine && startLine < line && hunkOf(files, path, startLine) === hunk && { startLine }) };
  };
  const stillPresent = kind => { d.reply = 'still-present'; d.reopen = e.threadState === 'resolved'; d.link = { kind, reply: true }; };
  if (f.status === 'confirmed') {
    if (e?.by === 'someone-else') {
      if (e.statesItFully && ['open', 'none'].includes(e.threadState)) d.link = { kind: 'already raised' };
      else if (thread) stillPresent('already raised');
      else { inline(); d.alsoRaised = true; }
    } else if (e?.by === 'prowl') {
      if (thread && e.threadState !== 'open') stillPresent('still open'); else d.link = { kind: 'still open' };
    } else inline();
  } else if (d.counted) { // still present, or needing a person and not parked
    if (thread && !saidStillOpen(threads[e.threadId] ?? threads[e.url], reviewedAt)) d.reply = 'still-open';
    d.reopen = thread && e.threadState === 'resolved';
    d.link = { kind: 'still open' };
  } else if (f.status === 'fixed' || f.status === 'no-longer-applies') {
    if (thread && e.threadState !== 'resolved') Object.assign(d, { reply: f.status, resolve: true });
    d.state = f.status === 'no-longer-applies' && Boolean(f.outcome?.disputeHolds);
  } else if (['refuted', 'addressed-elsewhere', 'withdrawn'].includes(f.status)) d.state = true;
  return d;
}

const NOT_INLINE = { diff: 'not in the diff', unread: "changed files couldn't be read", refused: 'inline comments refused by GitHub' };

/** Where the split of a details file falls: the last ## or ### heading (outside a fence) that fits `budget`, else the last line break that does. */
export function splitAt(lines, budget) {
  let size = 0;
  let fence = '';
  let heading = 0;
  let any = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && size <= budget) { any = i; if (!fence && /^#{2,3} /.test(lines[i])) heading = i; }
    size += lines[i].length + 1;
    const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (m && !fence) fence = m[1];
    else if (m && lines[i].trim().startsWith(fence) && !lines[i].trim().slice(fence.length).trim()) fence = '';
    if (size > budget) break;
  }
  return heading || any || 1;
}

/** The index of the (nth+1)th line of `lines` equal to `text`, or -1: where a pinned split's part 2 starts. */
const anchorAt = (lines, { text, nth }) => { let seen = 0; return lines.findIndex(l => l === text && seen++ === nth); };

/**
 * Everything to post for a review, and what it comes to. `ctx`:
 *   run: the review ({ id, ticket, ticketUrl, me, approvals, parkHumanOnly, prs, priorRefs, published, publishFallback, split }),
 *   templates: outputTemplates() (get(heading)), labels: verdictLabels(),
 *   prs: { [url]: { state ('open' | 'merged' | 'closed'), title, author, files (commentable(), or null when they
 *     couldn't be read), threads ([{ id, commentId, resolved, outdated, lastBody, lastProwlBody }], or null) } },
 * Returns { prs: [record], reviewed: [urls], verdict, counts }. A record: { url, reviewedAt, severity, verdict, event,
 * approval, withheld, notChecked, notCarried, skip, fallback, anchorLost, split, ops }. An op: { key, kind, … }.
 */
export function planPublish(given, ctx) {
  const { run, templates, labels } = ctx;
  const T = h => templates.get(h);
  const opts = { parkHumanOnly: run.parkHumanOnly };
  const pub = run.published || {};
  const prefix = T('Comment prefix').trim();
  let result = given;
  for (const p of run.prs) result = withThreads(result, p.url, ctx.prs[p.url]?.threads);
  const records = [];
  for (const p of run.prs) {
    const info = ctx.prs[p.url] || {};
    const entry = (result.prs || []).find(x => x.url === p.url);
    const rec = { url: p.url, reviewedAt: entry?.reviewedAt || null, severity: '', verdict: 'n/a', event: null, approval: null, withheld: '', notChecked: [], notCarried: [], supersedes: [], supersedesCarried: {},
      skip: '', fallback: run.publishFallback?.[p.url] || '', anchorLost: false, split: null, ops: [] };
    records.push(rec);
    rec.skip = !entry ? 'not in this review' : !entry.reviewedAt ? 'not reviewed: no head commit' : info.state && info.state !== 'open' ? info.state : '';
    if (rec.skip) continue;
    const mine = findingsOn(result, p.url);
    const threadsById = Object.fromEntries((info.threads || []).map(t => [t.id, t]));
    const files = rec.fallback ? null : info.files; // GitHub refused the inline comments: every finding goes in the body
    const why = rec.fallback ? NOT_INLINE.refused : info.files ? NOT_INLINE.diff : NOT_INLINE.unread;
    const ds = new Map(mine.map(f => [f, disposition(f, { files, threads: threadsById, reviewedAt: entry.reviewedAt, ...opts })]));
    // A finding that could have gone inline says GitHub refused; one that never could keeps "not in the diff".
    const whyNot = f => (rec.fallback && disposition(f, { files: info.files, threads: threadsById, reviewedAt: entry.reviewedAt, ...opts }).anchor ? NOT_INLINE.refused : rec.fallback ? (info.files ? NOT_INLINE.diff : NOT_INLINE.unread) : why);
    rec.severity = worst(mine, opts);
    rec.notChecked = notChecked(result, p.url, opts);
    rec.notCarried = notCarried(result, p.url, run.priorRefs?.[p.url] || []);
    const own = Boolean(run.me && String(p.author || info.author || '').toLowerCase() === run.me.toLowerCase());
    const base = eventFor({ severity: rec.severity, own, approvals: run.approvals !== false });
    const withheld = Boolean(base.approval) && (rec.notChecked.length > 0 || rec.notCarried.length > 0);
    rec.withheld = !withheld ? '' : [rec.notChecked.length && "something wasn't checked", rec.notCarried.length && `${rec.notCarried.length} earlier finding${rec.notCarried.length > 1 ? 's' : ''} not carried over`].filter(Boolean).join(', and ');
    rec.event = base.event === 'APPROVE' && (withheld || rec.fallback === 'head') ? 'COMMENT' : base.event;
    rec.approval = withheld || rec.fallback === 'head' ? null : base.approval;
    rec.verdict = withheld ? NOT_FULLY : labels[rec.severity || 'none'];
    // The earlier PR-Owl reviews this one supersedes: only when it approves the PR, or gives it Prowl's stamp.
    if (rec.approval) {
      const tally = supersededTally(result, p.url);
      rec.supersedes = tally.map(t => t.url);
      rec.supersedesCarried = Object.fromEntries(tally.map(t => [t.url, t.refs]));
    }
    const noBlocking = base.noBlocking && !withheld && rec.fallback !== 'head';

    const sha = short(entry.reviewedAt);
    const loc = f => place(f.location);
    const linkOf = (f, d) => (d.link?.reply && pub[`reply:${p.url}:${f.id}`]) || f.earlier?.url || '';
    const counted = bySeverity(mine.filter(f => ds.get(f).counted));
    const parked = mine.filter(f => ds.get(f).parked);

    // ---- 1. Thread replies, most severe first; 2. reopen and resolve ----
    for (const f of bySeverity(mine)) {
      const d = ds.get(f);
      if (!d.reply) continue;
      const e = f.earlier;
      const vars = { 'comment prefix': prefix, sha: d.reply === 'fixed' ? short(f.outcome?.commit) : sha, problem: esc(f.problem), fix: esc(f.fix), note: esc(flat(f.outcome?.note)),
        moved: d.reply === 'still-present' && e.threadState === 'outdated' && loc(f) ? `, now at \`${loc(f)}\`` : '' };
      const heading = { 'still-present': 'Reply: still present', 'still-open': 'Reply: still open', fixed: 'Reply: verified fixed', 'no-longer-applies': 'Reply: no longer applies' }[d.reply];
      rec.ops.push({ key: `reply:${p.url}:${f.id}`, kind: 'reply', id: f.id, commentId: e.commentId, marker: findingMarker(result.batchId, f.id), body: `${fillTemplate(T(heading), vars)}\n${findingMarker(result.batchId, f.id)}` });
    }
    for (const f of bySeverity(mine)) {
      const d = ds.get(f);
      if (d.reopen) rec.ops.push({ key: `reopen:${p.url}:${f.id}`, kind: 'reopen', id: f.id, threadId: f.earlier.threadId });
      if (d.resolve) rec.ops.push({ key: `resolve:${p.url}:${f.id}`, kind: 'resolve', id: f.id, threadId: f.earlier.threadId });
    }

    // ---- The review: inline comments, the body, and the details file ----
    const consumer = f => (f.consumer ? `; consumer outside the batch: ${f.consumer.repo} \`${f.consumer.path}\`` : '');
    const whereLine = f => {
      const d = ds.get(f);
      if (d.anchor) return `\`${loc(f)}\`${f.crossPr ? ` with ${f.crossPr.counterpart}` : ''}${consumer(f)}`;
      if (d.link) return `${d.link.kind}: ${linkOf(f, d) || 'no link'}${consumer(f)}`;
      const also = d.alsoRaised ? `; also raised by @${f.earlier.author || 'someone'}: ${f.earlier.url || 'no link'}` : '';
      return `${loc(f) ? `\`${loc(f)}\` (${whyNot(f)})` : `no single place (${whyNot(f)})`}${also}${consumer(f)}`;
    };
    const whereDetail = f => {
      const d = ds.get(f);
      const at = loc(f) ? `\`${loc(f)}\`` : 'no single place';
      if (d.anchor) return `${at} (inline comment)`;
      if (d.link) return d.link.kind === 'still open' ? `${at} (still open: ${linkOf(f, d) || 'no link'})` : `${at} (already raised by @${f.earlier.author || 'someone'}: ${linkOf(f, d) || 'no link'})`;
      return `${at} (${whyNot(f)})`;
    };
    const comments = counted.filter(f => ds.get(f).anchor).map(f => {
      const d = ds.get(f);
      const extra = [d.alsoRaised && fillTemplate(T('Also raised by'), { author: f.earlier.author || 'someone', link: f.earlier.url || '' }),
        f.crossPr && fillTemplate(T('Cross-PR note'), { counterpart: f.crossPr.counterpart, why: esc(flat(f.crossPr.why)) }),
        f.consumer && `Consumer outside the batch: ${f.consumer.repo} \`${f.consumer.path}\`.`].filter(Boolean);
      const body = [fillTemplate(T('Inline comment'), { 'comment prefix': prefix, problem: esc(f.problem), fix: esc(f.fix) }), ...extra].join('\n\n');
      return { path: d.anchor.path, line: d.anchor.line, side: 'RIGHT', ...(d.anchor.startLine && { start_line: d.anchor.startLine, start_side: 'RIGHT' }), body: `${body}\n${findingMarker(result.batchId, f.id)}` };
    });

    const share = part => Math.floor(LIMIT * part);
    const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
    const findingLine = f => fillTemplate(T('Finding line'), { SEVERITY: f.severity.toUpperCase(), title: esc(flat(f.title)), where: whereLine(f) });
    let findingLines = counted.map(findingLine);
    if (findingLines.join('\n').length > share(0.4)) {
      let kept = 0;
      let size = 0;
      while (kept < findingLines.length && size + findingLines[kept].length + 1 <= share(0.4)) size += findingLines[kept++].length + 1;
      findingLines = [...findingLines.slice(0, kept), `- …and ${findingLines.length - kept} more: see the details file.`];
    }
    const lines = [findingLines.length ? findingLines.join('\n') : 'No issues found.',
      rec.notChecked.length && clip(`**Not checked:** ${rec.notChecked.map(x => esc(flat(x))).join('; ')}.`, share(0.05)),
      rec.notCarried.length && clip(`**Not carried over:** ${rec.notCarried.join(', ')}: earlier PR-Owl findings this review doesn't account for.`, share(0.05))].filter(Boolean).join('\n\n');

    const name = `prowl-review-${result.batchId}-${prName(p.url).split('/')[1].replace('#', '-')}.md`;
    const ticket = run.ticketUrl ? `[${run.ticket}](${run.ticketUrl})` : /^QUICK#\d+$/.test(run.ticket || '') || !run.ticket ? 'no ticket' : run.ticket;
    const detailsFile = cap => {
      const field = (text, fallback) => { const t = String(text ?? '').trim(); return t ? cut(esc(t), cap) : fallback; };
      const one = f => {
        const q = f.detail?.quote;
        const code = q?.code ? (c => `${fenceFor(c)}${q.language || ''}\n${c}\n${fenceFor(c)}`)(cap != null && q.code.length > cap ? `${q.code.slice(0, cap)}\n${TRIMMED}` : q.code) : '(not quoted)';
        const cross = [f.crossPr && `- **Cross-PR:** with ${f.crossPr.counterpart}; the fix belongs in ${f.crossPr.fixBelongsTo || p.url}: ${esc(flat(f.crossPr.why))}`,
          f.consumer && `- **Consumer:** outside the batch, ${f.consumer.repo} \`${f.consumer.path}\``].filter(Boolean).join('\n');
        return fillTemplate(T('Details finding'), { id: f.id, SEVERITY: f.severity.toUpperCase(), title: esc(flat(f.title)), ref: String(f.id).startsWith('C-') && f.earlier?.ref ? ` (${f.earlier.ref.trim()})` : '',
          where: whereDetail(f), axis: esc(f.axis) || 'not given', 'cross-pr': cross, code, explanation: field(f.detail?.explanation, esc(f.problem)), scenario: field(f.detail?.scenario, 'not given'),
          'fix detail': field(f.detail?.fixDetail, esc(f.fix)), check: field(f.detail?.check, 'not given'), verification: field(f.detail?.verification, 'not given') });
      };
      const parkedLine = f => {
        const title = esc(flat(f.title));
        const ref = f.earlier?.ref?.trim() || f.id;
        const url = f.earlier?.url || '';
        let note = f.outcome?.answer ? `answered: ${f.outcome.answer}` : flat(f.outcome?.note);
        // A note that repeats the line's own title, ref and link is stripped down to the note.
        for (const own of [title, flat(f.title), `(${ref})`, ref, url]) if (own) note = note.split(own).join('');
        note = esc(note.replace(/^[\s:·,;-]+|[\s:·,;-]+$/g, '').replace(/\s+/g, ' ')) || 'only a person can resolve it';
        return fillTemplate(T('Parked line'), { title, ref, note, link: url });
      };
      const list = fs => (fs.length ? fs.map(one).join('\n\n') : 'None.');
      return fillTemplate(T('Details file'), {
        repo: prName(p.url).split('#')[0], n: String(p.number ?? prName(p.url).split('#')[1]), 'PR title': esc(flat(info.title || p.title || '')), 'PR link': p.url, 'head sha': entry.reviewedAt, 'short sha': sha,
        verdict: rec.verdict, 'batch-id': result.batchId, ticket, goal: esc(flat(result.batch?.goal)), role: esc(flat(entry.role)), 'merge order': esc(flat(result.batch?.mergeOrder)),
        related: entry.related?.length ? entry.related.map(x => `\n  - ${x.url} — ${esc(flat(x.shares))}`).join('') : 'none', conventions: entry.conventions?.length ? entry.conventions.join(', ') : 'none found',
        findings: list(counted.filter(f => !String(f.id).startsWith('C-'))), 'still open': list(counted.filter(f => String(f.id).startsWith('C-'))),
        'parked section': parked.length ? fillTemplate(T('Details parked'), { 'parked lines': parked.map(parkedLine).join('\n') }) : '',
        axes: entry.coverage?.axes?.length ? entry.coverage.axes.map(a => `- ${esc(a)}`).join('\n') : 'none', clean: entry.coverage?.clean?.length ? entry.coverage.clean.map(a => `- ${esc(a)}`).join('\n') : 'none',
        unverified: esc(String(entry.coverage?.unverified ?? '').trim()) || 'nothing',
      });
    };

    const banner = fillTemplate(T('Review banner'), { verdict: rec.verdict, 'batch-id': result.batchId });
    // The hidden note: what this review's verifiers found not to be defects, for a later review to read first. Never moved to part 2.
    const note = stateNote(bySeverity(mine.filter(f => ds.get(f).state)));
    const bodyWith = block => [banner, noBlocking && T('No blocking issues (approvals off)'), fillTemplate(T('Review body'), { summary: clip(esc(flat(entry.summary)), share(0.05)), 'finding lines': lines, 'details block': block }),
      note, reviewMarker(run.id)].filter(Boolean).join('\n\n');
    const block = (heading, text, fence) => fillTemplate(T(heading), { 'details file name': name, 'details fence': fence, 'details file': text });
    const part2Body = (text, fence) => `${block('Details part 2', text, fence)}\n${part2Marker(run.id)}`;
    const part2Url = pub[`part2:${p.url}`] || '';
    const continued = () => fillTemplate(T('Details continued'), { 'part 2 link': part2Url });
    let body;
    let part2 = null;
    if (!counted.length && !parked.length) body = bodyWith(''); // nothing to detail: no details file at all
    else {
      const pinned = run.split?.[p.url];
      const reserve = 200 + comments.length * 60; // the part 2 link, and what the where-texts grow by if GitHub refuses the inline comments
      const tryCap = cap => {
        const file = detailsFile(cap);
        const fence = fenceFor(file);
        const whole = bodyWith(block('Details block', file, fence));
        if (!pinned && whole.length <= LIMIT) return { body: whole };
        const all = file.split('\n');
        const empty = bodyWith(`${block('Details block', '', fence)}\n\n${fillTemplate(T('Details continued'), { 'part 2 link': '' })}`).length;
        let at = pinned ? anchorAt(all, pinned.anchor) : splitAt(all, LIMIT - empty - reserve);
        const lost = pinned && at < 0;
        if (lost) at = Math.min(pinned.line, all.length - 1);
        const [one, two] = [all.slice(0, at).join('\n').trimEnd(), all.slice(at).join('\n').trim()];
        const first = two.split('\n').find(l => l.trim()) || '';
        const anchor = { text: first, nth: all.slice(0, at + all.slice(at).findIndex(l => l === first)).filter(l => l === first).length };
        return { body: bodyWith(`${block('Details block', one, fence)}\n\n${continued()}`), part2: part2Body(two, fence), split: { line: at, anchor, cap }, lost, fits: one.length <= LIMIT - empty - reserve && part2Body(two, fence).length <= LIMIT, fence, one, two, empty };
      };
      let made;
      for (const cap of pinned ? [pinned.cap ?? null] : [null, 4000, 1500, 600, 200]) {
        made = tryCap(cap);
        if (!made.part2 || made.fits) break;
      }
      if (made.part2 && !made.fits) { // still too long: each part is trimmed at its end
        const room = Math.max(0, LIMIT - made.empty - reserve - TRIMMED.length - 1);
        const one = made.one.length > room ? `${made.one.slice(0, room).trimEnd()}\n${TRIMMED}` : made.one;
        const over = part2Body(made.two, made.fence).length - LIMIT;
        const two = over > 0 ? `${made.two.slice(0, Math.max(0, made.two.length - over - TRIMMED.length - 1)).trimEnd()}\n${TRIMMED}` : made.two;
        made = { ...made, body: bodyWith(`${block('Details block', one, made.fence)}\n\n${continued()}`), part2: part2Body(two, made.fence) };
      }
      ({ body } = made);
      if (made.part2) {
        part2 = made.part2;
        rec.split = made.split;
        rec.anchorLost = Boolean(made.lost);
        rec.ops.push({ key: `part2:${p.url}`, kind: 'part2', marker: part2Marker(run.id), body: part2 });
      }
    }
    rec.ops.push({ key: `review:${p.url}`, kind: 'review', marker: reviewMarker(run.id), inline: comments.length,
      payload: { ...(rec.fallback !== 'head' && { commit_id: entry.reviewedAt }), event: rec.event, body, comments } });
  }
  const reviewed = records.filter(r => !r.skip).map(r => r.url);
  const n = counts(result, reviewed, opts);
  const top = SEVERITIES.find(s => n[s] > 0) || '';
  const verdict = !reviewed.length ? 'n/a' : approvable(top) && records.some(r => !r.skip && r.withheld) ? NOT_FULLY : labels[top || 'none'];
  return { prs: records, reviewed, verdict, counts: n, result };
}
