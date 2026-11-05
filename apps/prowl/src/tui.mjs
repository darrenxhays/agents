import { pathToFileURL } from 'node:url';
import { CONFIG_PATH } from './config.mjs';
import { CONFIG_FIELDS, JIRA } from './fields.mjs';
import { parsePrRefs } from './github.mjs';
import { createMascot, wrap } from './mascot.mjs';
import { copyText, openExternal } from './proc.mjs';
import { awaitingHuman, isOwn } from './reviewer/reviews.mjs';

const ST = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', title: '\x1b[1;38;5;220m', yellow: '\x1b[38;5;220m',
  green: '\x1b[38;5;114m', red: '\x1b[38;5;203m', orange: '\x1b[38;5;208m', link: '\x1b[4;38;5;75m', cyan: '\x1b[38;5;80m',
  grey: '\x1b[38;5;244m', tabOn: '\x1b[1;38;5;16;48;5;220m', tabOff: '\x1b[38;5;250m', cursor: '\x1b[7m',
};
const LEVEL = { ok: ST.green, info: ST.grey, warn: ST.yellow, error: ST.red };
// Each side's colour: its tab, the selected view's tab, the cursor and its keys. The Reviewer amber, the Builder violet.
const ACCENT = {
  reviewer: { fg: '\x1b[38;5;220m', tab: '\x1b[1;38;5;16;48;5;220m' },
  builder: { fg: '\x1b[38;5;141m', tab: '\x1b[1;38;5;16;48;5;141m' },
};
// The keys bar along the bottom: its background, its text, and the line between a view's keys and the rest.
const BAR = { bg: '\x1b[48;5;236m', text: '\x1b[38;5;252m', sep: '\x1b[38;5;240m' };
// Config's sections, each in its own colour; the Reviewer's and the Builder's in their sides' colours.
const SECTION = { Prowl: '\x1b[38;5;117m', 'Boards and repos': '\x1b[38;5;114m', Tags: '\x1b[38;5;211m', Labels: '\x1b[38;5;211m', 'All sessions': '\x1b[38;5;80m' };
const sectionColor = s => (s.startsWith('Reviewer') ? ACCENT.reviewer.fg : s.startsWith('Builder') ? ACCENT.builder.fg : SECTION[s] || ST.grey);
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SIDES = ['reviewer', 'builder'];
const NAMES = { reviewer: 'Reviewer', builder: 'Builder' };
const TABS = ['Running', 'History', 'Needs you', 'Config', 'Log'];
const [RUNNING, HISTORY, NEEDS, CONFIG] = [0, 1, 2, 3];

const LABEL_W = Math.max(...CONFIG_FIELDS.map(f => f.label?.length || 0)) + 2; // the Config view's label column

// Control characters (ESC included) are stripped from everything shown: titles, PR text and agent output
// come from other people, and raw escape sequences would let them drive this terminal. Wide characters
// become ? so column maths stays right.
const clean = s => String(s ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  .replace(/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\ud800-\udbff][\udc00-\udfff]/g, '?');
const width = segs => segs.reduce((n, s) => n + clean(s[1]).length, 0);
const trunc = (s, n) => { s = clean(s); return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s; };
const spread = (left, right, W) => [...left, ['', ' '.repeat(Math.max(1, W - width(left) - width(right)))], ...right];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const prName = p => `${p.repo.split('/')[1]}#${p.number}`;
const pad2 = n => String(n).padStart(2, '0');
const clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
const dur = ms => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h}h${pad2(m)}m` : `${m}m${pad2(s % 60)}s`; };
const stamp = ms => { const d = new Date(ms); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const time = ms => new Date(ms).toTimeString().slice(0, 8);
const spin = () => SPIN[Math.floor(Date.now() / 100) % SPIN.length];
const rule = W => [[ST.grey, '─'.repeat(W)]];
const getPath = (o, k) => k.split('.').reduce((v, p) => v?.[p], o);
const setPath = (o, k, val) => { const ps = k.split('.'); const last = ps.pop(); ps.reduce((v, p) => (v[p] ??= {}), o)[last] = val; };

/**
 * A row is a list of [style, text, url?, onClick?] segments; draw() clips it to `w` columns and pads the rest, in
 * `row.bg` when set (a bar's background). `row.hit` is what a click elsewhere on the row does.
 */
function draw(row, w) {
  let out = '';
  let used = 0;
  for (const [style, raw, url] of row) {
    if (used >= w) break;
    const text = clean(raw).slice(0, w - used);
    if (!text) continue;
    used += text.length;
    out += style + (url ? `\x1b]8;;${clean(url)}\x1b\\${text}\x1b]8;;\x1b\\` : text) + ST.reset;
  }
  return out + (row.bg ? `${row.bg}${' '.repeat(w - used)}${ST.reset}` : ' '.repeat(w - used));
}

/** What a click at column `x` of `row` does: its segment's onClick, else opening its segment's link, else the row's. */
function hitAt(row, x) {
  let at = 0;
  for (const [, raw, url, onClick] of row) {
    at += clean(raw).length;
    if (x < at) return onClick || (url ? () => openExternal(url) : row.hit);
  }
  return row.hit;
}

/** List rows around the selection, so the selected row always stays visible. */
function windowed(list, sel, h) {
  const start = Math.max(0, Math.min(sel - Math.floor(h / 2), list.length - h));
  return list.slice(start, start + h).map((item, k) => ({ item, i: start + k }));
}

function* keys(data) {
  const NAMED = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down',
    '\x1bOC': 'right', '\x1bOD': 'left', '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete',
  };
  for (let i = 0; i < data.length;) {
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i)); // SGR mouse: button;column;row, M pressed, m released
    if (mouse) {
      yield { mouse: Number(mouse[1]), x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, release: mouse[4] === 'm' };
      i += mouse[0].length;
      continue;
    }
    const seq = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(data.slice(i));
    if (seq) {
      yield NAMED[seq[0]] || 'unknown';
      i += seq[0].length;
      continue;
    }
    const ch = String.fromCodePoint(data.codePointAt(i));
    i += ch.length;
    yield { '\r': 'enter', '\n': 'enter', '\x1b': 'esc', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace', '\x03': 'ctrl-c', '\x01': 'home', '\x05': 'end' }[ch] || ch;
  }
}

/**
 * Full-screen terminal UI: a tab for each side (Reviewer and Builder), each with Running, History, Needs you, Config
 * and Log. `app` is read every frame. `actions` = { sides: { reviewer, builder }, pollNow(side), togglePause(side),
 * toggleSide(side), stop(side, item), answer(item, text), skip(item), handBack(item), follow(record), stopFollowing(record),
 * reviewPrs(refs) (a quick review), saveConfig, saveToken, quit }. `io` = { out, stdin, headless }
 * (headless: no raw mode, mouse or timers, for the self-test), copy(text). Returns { restore, key(k), mouse(x, y, button), drag(x0, y0, x1, y1), frame() }.
 */
export function startTui(app, actions, io = {}) {
  const out = io.out || process.stdout;
  const stdin = io.stdin || process.stdin;
  const owl = createMascot();
  const { sides } = actions;
  const ui = {
    side: 'reviewer', view: { reviewer: 0, builder: 0 }, sel: { reviewer: TABS.map(() => 0), builder: TABS.map(() => 0) },
    edit: null, confirm: null, flash: '', flashUntil: 0, notes: app.notes ? { scroll: 0 } : null,
    keys: null, // the full list of keys, while open (/): { scroll }
    frame: [], // the rows last drawn, for mouse clicks
    text: [], // …and their text, for copying a selection
    drag: null, // a mouse selection while the left button is down: { x0, y0, x1, y1, moved }
  };
  const acc = (name = ui.side) => ACCENT[name];
  const cursor = on => (on ? [acc().fg, ' ❯ '] : ['', '   ']);
  const onClick = (row, hit) => Object.assign(row, { hit });
  // A click on a list's row selects it; a click on the row already selected does what enter does.
  const pick = (tab, i) => () => { if (sel()[tab] === i) onKey('enter'); else sel()[tab] = i; };
  const flash = text => { ui.flash = text; ui.flashUntil = Date.now() + 4000; };
  const side = () => sides[ui.side];
  const view = () => ui.view[ui.side];
  const sel = () => ui.sel[ui.side];
  const clampSel = (tab, n) => (sel()[tab] = Math.max(0, Math.min(sel()[tab], n - 1)));
  const isOn = name => app.sideOn(name);
  // The Builder's tab shows once it is on, and while it still has sessions running or items waiting on you.
  const visible = name => name === 'reviewer' || isOn(name) || live(name).length > 0 || needs(name).length > 0;
  const reviewer = sides.reviewer;
  const builder = sides.builder;

  // Running sessions, per side.
  const live = name => (name === 'reviewer' ? reviewer.running() : builder.running());
  // The Reviewer's finished reviews and, from before 2.12.0, Fix my PRs' fixes, newest first.
  const reviewHistory = () => [...reviewer.finished(), ...(reviewer.state.fixes || []).filter(f => !['fixing', 'stopping'].includes(f.status))]
    .sort((a, b) => (b.endedAt || b.startedAt || b.createdAt) - (a.endedAt || a.startedAt || a.createdAt));
  const history = name => (name === 'reviewer' ? reviewHistory() : builder.history());
  const needs = name => sides[name].needs();
  const allLive = () => SIDES.reduce((n, s) => n + live(s).length, 0);

  // Hoot sleeps unless something is happening: a poll, a running session, or something he has to say.
  function mood(said) {
    if (said?.mood) return said.mood;
    if (SIDES.some(s => sides[s].polling)) return 'poll';
    if (allLive()) return 'review';
    return said ? 'idle' : 'sleep';
  }

  function titleBar(W) {
    const s = side();
    const left = [[ST.title, ' ◆ Prowl '], [ST.grey, `· ${app.tracker().name}${app.me ? ` · ${app.me}` : ''}`]];
    const status = !isOn(ui.side) ? [ST.grey, `${NAMES[ui.side]} off`]
      : s.polling ? [ST.yellow, `${spin()} checking boards`]
        : s.paused ? [ST.grey, '‖ paused']
          : [ST.grey, `next poll in ${clock(s.nextPoll - Date.now())}`];
    const right = [
      ...(app.dryRun() ? [[ST.tabOn, ' DRY RUN '], ['', ' ']] : []),
      ...(s.lastError ? [[ST.red, '● error, see Log  ']] : []),
      status, ['', ' '],
    ];
    return spread(left, right, W);
  }

  /** A side's tab label, from the fullest that fits `room` columns down to its initial. */
  function sideLabel(name, room) {
    const [n, k] = [live(name).length, needs(name).length];
    const full = `${NAMES[name]} · ${isOn(name) ? 'on' : 'off'}${n ? ` · ▶ ${n}` : ''}${k ? ` · ⚑ ${k}` : ''}`;
    const mid = `${NAMES[name]} ${isOn(name) ? 'on' : 'off'}${n ? ` ▶${n}` : ''}${k ? ` ⚑${k}` : ''}`;
    const tiny = `${NAMES[name][0]}${isOn(name) ? '' : ' off'}${n ? ` ▶${n}` : ''}${k ? ` ⚑${k}` : ''}`;
    return [full, mid, tiny].find(l => l.length + 2 <= room) || tiny;
  }

  function sideBar(W) {
    const shown = SIDES.filter(visible);
    const room = Math.floor((W - 2) / shown.length);
    const segs = [['', ' ']];
    for (const name of shown) segs.push([name === ui.side ? acc(name).tab : acc(name).fg, ` ${sideLabel(name, room)} `, undefined, () => { ui.side = name; }], ['', ' ']);
    return segs;
  }

  function tabBar() {
    const counts = [live(ui.side).length, history(ui.side).length, needs(ui.side).length];
    const segs = [['', ' ']];
    TABS.forEach((t, i) => segs.push([i === view() ? acc().tab : ST.tabOff, ` ${i + 1} ${t}${counts[i] != null ? ` (${counts[i]})` : ''} `, undefined, () => { ui.view[ui.side] = i; }], ['', ' ']));
    return segs;
  }

  function activity(rows, r, H) {
    const acts = (r._activity || []).slice(-Math.max(1, H - rows.length));
    if (!acts.length) rows.push([[ST.grey, '  starting…']]);
    for (const a of acts) {
      if (a.error) rows.push([[ST.red, `  ${a.text}`]]);
      else if (a.sub) rows.push([[ST.grey, '    ↳ '], [ST.grey, a.text]]);
      else rows.push([[ST.cyan, '  • '], [a.said ? '' : ST.dim, a.text]]);
    }
    return rows;
  }

  function runningView(W, H) {
    if (ui.edit?.prs) return prsInput(W);
    if (ui.side === 'builder') return builderRunning(W, H);
    const runs = live('reviewer');
    if (!runs.length) {
      const n = app.boards().length;
      return [[], [[ST.grey, !isOn('reviewer') ? '  The Reviewer is off: e turns it on.'
        : n ? `  No reviews running. Watching ${plural(n, 'board')} for '${app.cfg.tags.trigger}'.`
          : '  No boards configured yet: press 4 for Config, then a to add one.']]];
    }
    const at = clampSel(RUNNING, runs.length);
    const rows = windowed(runs, at, Math.min(runs.length, Math.max(3, Math.floor(H / 3)))).map(({ item: r, i }) => {
      const stopping = r.status === 'stopping';
      const left = [cursor(i === at), [stopping ? ST.red : acc().fg, `${stopping ? '■' : spin()} `], [ST.bold, `${r.ticket}  `]];
      const right = [[ST.grey, `  ${plural(r.prs.length, 'PR')} · ${r.reviewNo > 1 ? `re-review #${r.reviewNo}` : 'first review'} · ${dur(Date.now() - r.startedAt)} `]];
      const title = trunc(stopping ? `stopping… ${r.title}` : r.title, W - width(left) - width(right) - 1);
      return onClick(spread([...left, ['', title]], right, W), pick(RUNNING, i));
    });
    const r = runs[at];
    rows.push(rule(W), [[ST.bold, ` Activity · ${r.ticket}  `], [ST.grey, prsOf(r).map(prName).join('  ')]]);
    return activity(rows, r, H);
  }

  // Where a Builder ticket stands, in a word or two.
  const STEP_NAMES = { claim: 'claiming', adopt: 'looking for its PRs', read: 'reading the ticket', turn: 'starting a turn', session: 'session running', settle: 'reading the result',
    repos: 'checking out repos', approve: 'approving the plan', publish: 'checking and publishing', round: 'starting a round', 'push-round': 'pushing the round', ci: 'waiting for CI', 'end-round': 'retagging' };
  function workStatus(w) {
    if (w.status === 'needs-you') return [ST.yellow, 'NEEDS YOU'];
    if (w.status === 'active') return [ST.yellow, w.turnKind === 'round' ? `ROUND ${w.rounds}` : 'BUILDING'];
    if (w.status === 'following') return w.ready ? [ST.green, 'READY TO MERGE'] : [ST.cyan, w.rounds ? `FOLLOWING · r${w.rounds}` : 'PRS OPEN'];
    if (w.status === 'stopped') return [ST.grey, 'STOPPED'];
    if (w.status === 'done') return [ST.green, w.prs?.length ? 'DONE' : 'ENDED'];
    return [ST.grey, 'ENDED'];
  }

  /** The quick review's input: PRs to review together, without a ticket. */
  function prsInput(W) {
    const about = "Paste PR links (https://github.com/owner/repo/pull/12) or owner/repo#12, separated by spaces or commas. Prowl reviews them together as one set, the way it reviews a ticket's PRs, and posts a review on each. No ticket or tag is involved.";
    return [[], [[ST.bold, '  Quick review: PRs reviewed together, without a ticket']], [],
      [[ST.grey, '  PRs  '], ...editSegs(W - 8)], [],
      ...wrap(about, W - 4, 4).map(l => [[ST.grey, `  ${l}`]]),
      ...(ui.edit.error ? [[], [[ST.red, `  ${ui.edit.error}`]]] : [])];
  }

  function builderRunning(W, H) {
    const items = live('builder');
    if (!items.length) {
      const n = app.boards().length;
      return [[], [[ST.grey, !isOn('builder') ? '  The Builder is off: e turns it on (Config, 4, has its settings).'
        : n ? `  Nothing being built. Watching ${plural(n, 'board')} for '${app.cfg.builder.tags.start}'${app.cfg.builder.assignedToMe ? ' on tickets assigned to you' : ''}.`
          : '  No boards configured yet: press 4 for Config, then a to add one.']]];
    }
    const at = clampSel(RUNNING, items.length);
    const rows = windowed(items, at, Math.min(items.length, Math.max(3, Math.floor(H / 3)))).map(({ item: w, i }) => {
      const left = [cursor(i === at), [w.stopRequested ? ST.red : acc().fg, `${w.stopRequested ? '■' : spin()} `], [ST.bold, `${w.key}  `]];
      const right = [[ST.grey, `  ${w.stopRequested ? 'stopping' : STEP_NAMES[w.step] || 'waiting'} · ${plural(w.turns?.length || 0, 'turn')} · $${(w.costUsd || 0).toFixed(2)} · ${dur(Date.now() - (w.claimedRoundAt || w.claimedAt || w.createdAt))} `]];
      return onClick(spread([...left, ['', trunc(w.title, W - width(left) - width(right) - 1)]], right, W), pick(RUNNING, i));
    });
    const w = items[at];
    rows.push(rule(W), [[ST.bold, ` Activity · ${w.key}  `], [ST.grey, (w.turnKind === 'round' ? w.round?.prs || [] : w.repos || []).map(r => r.repo.split('/')[1]).join('  ')]]);
    return activity(rows, w, H);
  }

  function verdict(r) {
    if (r.status === 'failed') return [ST.red, 'FAILED'];
    if (r.status === 'stopped') return [ST.grey, 'STOPPED'];
    const v = String(r.summary?.verdict || 'NO VERDICT').toUpperCase();
    return [v.startsWith('BLOCK') ? ST.red : v.startsWith('REQUEST') ? ST.orange : v.startsWith('APPROVE') ? ST.green : ST.grey, v];
  }

  // PRs given Prowl's stamp with Approve PRs off or on your own PR, flagged on the ticket's latest review until it is reviewed again.
  const waiting = r => (reviewer.finished().find(x => x.ticket === r.ticket && x.status === 'done') === r ? awaitingHuman(r, app.cfg.approvals) : []);
  // The review's PRs, plus earlier-approved ones it carried over that still await a human; an old fix's one PR.
  const prsOf = r => (r.pr ? [r.pr] : [...r.prs, ...(r.contextPrs || []).filter(p => waiting(r).includes(p.url))]);

  /** Where an old Fix my PRs fix ended, for History. */
  function fixStatus(f) {
    const sha = f.pushedSha ? ` ${f.pushedSha.slice(0, 7)}` : '';
    if (f.status === 'done') return [ST.green, f.pushedSha ? `pushed${sha}${f.checks ? ` · ${f.checks}` : ''}` : `replied on ${plural(f.replies?.length || 0, 'thread')}`];
    if (f.status === 'failed') return [ST.red, `failed: ${f.error}`];
    return [ST.grey, `${f.status}${f.note ? `: ${f.note}` : ''}`];
  }

  const label = t => [ST.grey, `  ${t.padEnd(8)}`];

  function fixDetails(f) {
    return [
      f.briefDir ? [label('Brief'), [ST.link, f.briefDir, pathToFileURL(f.briefDir).href]] : [label('Brief'), [ST.grey, '(none)']],
      [label('Ticket'), [ST.link, f.ticketUrl || '', f.ticketUrl]],
      [label('PR'), [ST.link, f.pr.url, f.pr.url], [ST.grey, `  ${f.pr.title || ''}`]],
      [label('Status'), fixStatus(f), [ST.grey, `${f.costUsd ? `  · $${f.costUsd.toFixed(2)}` : ''}  · Fix my PRs, removed in 2.12.0`]],
    ];
  }

  function details(r) {
    const flagged = waiting(r);
    const prs = prsOf(r);
    const rows = [];
    rows.push(r.status === 'done'
      ? [label('Report'), [ST.link, r.reportPath, pathToFileURL(r.reportPath).href]]
      : [label('Report'), [ST.grey, '(none)']]);
    rows.push(r.quick ? [label('Ticket'), [ST.grey, '(none: a quick review)']] : [label('Ticket'), [ST.link, r.ticketUrl, r.ticketUrl]]);
    prs.slice(0, 4).forEach((p, i) => rows.push([label(i ? '' : 'PRs'), [ST.link, p.url, p.url],
      ...(flagged.includes(p.url) ? [[ST.yellow, isOwn(p, app.me) ? "  ⚑ needs a teammate's approval" : '  ⚑ needs your approval']] : []), [ST.grey, `  ${p.title}`]]));
    if (prs.length > 4) rows.push([label(''), [ST.grey, `+${prs.length - 4} more (o opens all)`]]);
    const how = r.status === 'failed' ? [ST.red, `failed: ${r.error}`]
      : r.status === 'stopped' ? [ST.grey, 'stopped by you']
        : [ST.green, `done in ${dur(r.endedAt - r.startedAt)}${r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ''}`];
    rows.push([label('Status'), how, [ST.yellow, r.pendingTag != null ? '  · ticket tag update pending' : '']]);
    return rows;
  }

  function workDetails(w) {
    const prs = w.prs?.length ? w.prs : (w.repos || []).filter(r => r.pr).map(r => r.pr);
    const rows = [
      [label('Brief'), [ST.link, w.briefDir, pathToFileURL(w.briefDir).href]],
      [label('Ticket'), [ST.link, w.url || '', w.url]],
      ...prs.slice(0, 4).map((p, i) => [label(i ? '' : 'PRs'), [ST.link, p.url, p.url], [ST.grey, `  ${p.title || ''}`]]),
      ...(w.plan ? [[label('Plan'), [ST.link, w.plan, pathToFileURL(w.plan).href]]] : []),
    ];
    rows.push([label('Status'), workStatus(w), [ST.grey, `  · $${(w.costUsd || 0).toFixed(2)}${w.note ? ` · ${w.note}` : ''}${w.summary ? ` · ${w.summary}` : ''}`]]);
    return rows;
  }

  function historyView(W, H) {
    const runs = history(ui.side);
    if (!runs.length) return [[], [[ST.grey, ui.side === 'builder' ? '  Nothing built yet.' : '  No finished reviews yet.']]];
    const at = clampSel(HISTORY, runs.length);
    const it = runs[at];
    const detail = ui.side === 'builder' ? workDetails(it) : it.pr ? fixDetails(it) : details(it);
    const rows = windowed(runs, at, Math.max(1, H - detail.length - 1)).map(({ item: r, i }) => {
      if (ui.side === 'builder') {
        const prs = r.prs?.length || 0;
        const head = [cursor(i === at), [ST.grey, `${stamp(r.updatedAt || r.createdAt)}  `], [ST.bold, r.key.padEnd(11)], [workStatus(r)[0], workStatus(r)[1].padEnd(18)],
          [ST.grey, `${prs ? `${plural(prs, 'PR')} · ` : ''}$${(r.costUsd || 0).toFixed(2)}  `]];
        return onClick([...head, ['', trunc(r.title, W - width(head))]], pick(HISTORY, i));
      }
      if (r.pr) {
        const head = [cursor(i === at), [ST.grey, `${stamp(r.endedAt || r.startedAt || r.createdAt)}  `], [ST.bold, r.ticket.padEnd(11)],
          [ST.cyan, `FIX MY PRS r${r.round}`.padEnd(18)], [ST.grey, `${prName(r.pr)} · `], fixStatus(r), ['', '  ']];
        return onClick([...head, ['', trunc(r.title, W - width(head))]], pick(HISTORY, i));
      }
      const s = r.summary || {};
      const [vs, vt] = verdict(r);
      const counts = r.status !== 'done' ? []
        : [['C', 'critical', ST.red], ['H', 'high', ST.orange], ['M', 'medium', ST.yellow], ['L', 'low', ST.grey], ['N', 'nit', ST.grey]]
          .map(([l, k, style]) => [Number(s[k]) > 0 ? style : ST.dim, `${l}${s[k] ?? '?'} `]);
      const head = [
        cursor(i === at), [ST.grey, `${stamp(r.endedAt)}  `], [ST.bold, r.ticket.padEnd(11)], [vs, vt.padEnd(18)], ...counts,
        [ST.grey, `${r.reviewNo > 1 ? `· fixed ${s.fixed ?? '?'} · re-review #${r.reviewNo}` : ''}  `],
        ...(waiting(r).length ? [[ST.yellow, `⚑ ${plural(waiting(r).length, 'PR')} to approve  `]] : []),
        ...(reviewer.state.capped?.[r.ticket] && reviewer.finished().find(x => x.ticket === r.ticket) === r ? [[ST.yellow, '⚑ round cap reached  ']] : []),
      ];
      return onClick([...head, ['', trunc(r.title, W - width(head))]], pick(HISTORY, i));
    });
    return [...rows, rule(W), ...detail];
  }

  const BOARD_HELP = {
    ado: ['"Project / Team": that team\'s board (its area paths) is polled.', 'Add a board as "Project / Team", e.g. My Project / My Team.'],
    jira: ['A Jira board, by name or id: its open issues are polled.', 'Add a Jira board by its name (e.g. My Team board) or its id (the number in its URL).'],
  };

  /** The Config view's selectable rows, the same on both sides, each with the `section` heading it sits under. */
  function configRows() {
    const [one, add] = BOARD_HELP[app.cfg.taskBoard];
    let section = '';
    return CONFIG_FIELDS.filter(f => !f.when || f.when(app.cfg)).flatMap(f => {
      f = JIRA(app.cfg) && f.jira ? { ...f, ...f.jira } : f;
      if (f.heading) { section = f.heading; return []; }
      return (f !== 'boards' ? [f] : [
        ...app.boards().map((b, i) => ({ board: i, label: `Board ${i + 1}`, help: `${one} enter edits · d deletes.` })),
        { addBoard: true, label: '+ Add board', help: add },
      ]).map(r => ({ ...r, section }));
    });
  }

  function shown(f) {
    const c = app.cfg;
    if (f.switch) return isOn(f.switch) ? `on${app.override?.[f.switch] != null ? ' (this launch)' : ''}` : 'off';
    if (f.board != null) return app.tracker().boardLabel(app.boards()[f.board]);
    if (f.addBoard) return '';
    if (f.type === 'secret') return app.hasToken() ? 'saved ••••••••' : 'not set: enter to add';
    if (f.type === 'bool') return getPath(c, f.key) ? 'on' : 'off';
    if (f.type === 'list') { const v = getPath(c, f.key); return Array.isArray(v) ? plural(v.length, 'pattern') : plural(Object.keys(v || {}).length, 'rule'); }
    if (f.empty && !getPath(c, f.key)) return f.emptyShows || '(none)';
    if (f.names) return f.names[getPath(c, f.key)] || String(getPath(c, f.key));
    return String(getPath(c, f.key));
  }

  /** What only you can answer or decide: the Builder's questions, plans and stops. The Reviewer's stays empty. */
  function needsView(W, H) {
    const items = needs(ui.side);
    if (!items.length) {
      return [[], [[ST.grey, ui.side === 'reviewer'
        ? '  The Reviewer never waits on you: a ticket it can\'t review stays tagged for a person, and History says why.'
        : isOn('builder') ? '  Nothing needs you. The Builder\'s questions, plans waiting for approval and stops show up here.'
          : '  The Builder is off (e turns it on). Its questions and stops show up here.']]];
    }
    const at = clampSel(NEEDS, items.length);
    const it = items[at];
    const lab = t => [ST.grey, `  ${t.padEnd(9)}`];
    const detail = [
      [lab('Ticket'), [ST.bold, it.ticket], ...(it.pr ? [['', '  '], [ST.link, it.pr, it.pr]] : [])],
      ...wrap(clean(it.question), W - 12, 4).map((l, i) => [lab(i ? '' : ['question', 'plan', 'repos', 'blocked'].includes(it.kind) ? 'Question' : 'Stopped'), ['', l]]),
      ...it.context.map(c => [lab(''), [ST.grey, trunc(c, W - 12)]]),
      ...it.options.map((o, i) => [lab(i ? '' : 'Options'), [ST.yellow, `${i + 1}. `], ['', trunc(o, W - 30)], [ST.green, o === it.recommended ? '  (recommended)' : '']]),
      ...(it.blocked ? [[lab('Blocked'), [ST.grey, trunc(it.blocked, W - 12)]]] : []),
      ...(it.searched ? [[lab('Searched'), [ST.grey, trunc(it.searched, W - 12)]]] : []),
    ];
    if (ui.edit) detail.push([], [lab(it.kind === 'plan' ? 'Note' : 'Answer'), ...editSegs()]);
    const rows = windowed(items, at, Math.max(1, H - detail.length - 1)).map(({ item: x, i }) => {
      const head = [cursor(i === at), [ST.grey, `${stamp(x.createdAt)}  `], [ST.bold, x.ticket.padEnd(11)], [['question', 'plan', 'repos'].includes(x.kind) ? ST.yellow : ST.red, x.kind.padEnd(10)]];
      return onClick([...head, ['', trunc(x.question, W - width(head))]], pick(NEEDS, i));
    });
    return [...rows, rule(W), ...detail];
  }

  /** The text being typed, with its cursor, scrolled to keep the cursor within `room` columns. */
  function editSegs(room = Infinity) {
    const e = ui.edit;
    const from = Math.max(0, e.cursor - room + 1);
    const v = (e.secret ? '•'.repeat(e.value.length) : e.value).slice(from);
    const at = e.cursor - from;
    return [[ST.yellow, v.slice(0, at)], [ST.cursor, v[at] || ' '], [ST.yellow, v.slice(at + 1)]];
  }

  function configView(W, H) {
    const fields = configRows();
    const at = clampSel(CONFIG, fields.length);
    const rows = [[[ST.grey, '  Saved to '], [ST.link, CONFIG_PATH, pathToFileURL(CONFIG_PATH).href], [ST.grey, ' on every change. The next poll uses it.']], []];
    // Each section's heading goes above its first row, after a blank line, and the window counts them as rows.
    const lines = fields.flatMap((f, i) => [...(f.section !== fields[i - 1]?.section ? [...(i ? [{}] : []), { heading: f.section }] : []), { f, i }]);
    // Each section in its own colour: a heading with a rule, and a bar down the left of its rows.
    for (const { item: { f, i, heading } } of windowed(lines, lines.findIndex(l => l.i === at), Math.max(1, H - 6))) {
      if (!f) {
        const c = sectionColor(heading || '');
        rows.push(heading ? [[`${ST.bold}${c}`, ` ▍ ${heading.toUpperCase()} `], [`${ST.dim}${c}`, '─'.repeat(Math.max(0, W - heading.length - 5))]] : []);
        continue;
      }
      const value = i === at && ui.edit ? editSegs()
        : f.file ? [[ST.link, f.file, pathToFileURL(f.file).href]] : [[f.switch ? (isOn(f.switch) ? ST.green : ST.grey) : '', shown(f)]];
      const on = i === at;
      rows.push(onClick([[sectionColor(f.section), ' ▏'], on ? [acc().fg, '❯ '] : ['', '  '],
        [f.addBoard ? ST.green : on ? ST.bold : ST.grey, f.label.padEnd(LABEL_W)], ...value], pick(CONFIG, i)));
    }
    rows.push([], ui.edit?.error ? [[ST.red, `  ${ui.edit.error}`]] : [[sectionColor(fields[at].section), '  ▏ '], [ST.grey, fields[at].help]]);
    const variants = Object.entries(reviewer.tagVariants || {}).map(([p, v]) => `${p}: ${v.join(', ') || 'none yet'}`).join('  ·  ');
    if (variants) rows.push([[ST.grey, `  ${JIRA(app.cfg) ? 'Labels' : 'Tags'} treated as the trigger: `], ['', variants]]);
    return rows;
  }

  /** The Update Notes, shown over the views on the first launch after an update until a key closes them. */
  function notesView(W, H) {
    const n = app.notes;
    const rows = [[[ST.title, ' Update Notes '], [ST.grey, ` · Prowl ${n.version}`]]];
    const bullet = text => wrap(clean(text), W - 6, Infinity).map((l, i) => [[ST.yellow, i ? '    ' : '  • '], ['', l]]);
    for (const v of n.versions) rows.push([], [[ST.bold, `  ${v.version}`]], ...v.items.flatMap(bullet));
    if (n.files.length) {
      rows.push([], [[ST.bold, '  Your config']]);
      for (const f of n.files) rows.push(...bullet(f.text), [['', '    '], [ST.link, f.path, pathToFileURL(f.path).href]]);
    }
    ui.notes.scroll = Math.max(0, Math.min(ui.notes.scroll, rows.length - H));
    return rows.slice(ui.notes.scroll);
  }

  const logView = (W, H) => app.log.filter(l => l.side === ui.side || l.side === 'prowl').slice(-H)
    .map(l => [[ST.grey, `${time(l.t)} `], [LEVEL[l.level], `${l.level.padEnd(5)} `], ['', l.msg]]);

  // Keys, as [key, short label (the bar), what it does (the full list)]. Each view's, most useful first, then the rest.
  const CONFIG_KEYS = [['enter', 'edit', 'Edit the setting, flip its switch, or open its file'], ['a', 'add board', 'Add a board to watch'], ['d', 'delete board', 'Delete the selected board']];
  const VIEW_KEYS = {
    reviewer: [
      [['s', 'stop', "Stop the selected review; its in-progress tag comes off, so re-tag the ticket to run it again"], ['o', 'open PRs', 'Open its PRs in the browser'], ['a', 'ticket', 'Open its ticket in the browser']],
      [['enter', 'report', "Open the review's report"], ['o', 'open PRs', 'Open its PRs in the browser'], ['a', 'ticket', 'Open its ticket in the browser']],
      [], CONFIG_KEYS, [],
    ],
    builder: [
      [['enter', 'brief', "Open the ticket's brief folder"], ['s', 'stop', 'Stop the selected build before its next push, PR, tag or turn'], ['o', 'open PRs', 'Open its PRs in the browser'], ['a', 'ticket', 'Open its ticket in the browser']],
      [['enter', 'brief', "Open the ticket's brief folder"], ['o', 'open PRs', 'Open its PRs in the browser'], ['a', 'ticket', 'Open its ticket in the browser'],
        ['w', 'follow', "Follow the ticket's PRs through review"], ['t', 'unfollow', "Stop following the ticket's PRs"]],
      [['enter', 'answer', 'Answer the question, approve the plan (empty) or send it back with a note, or retry'], ['s', 'skip', 'Skip the question (the session uses its default), or end the work'],
        ['t', 'hand back', 'Hand the ticket back with its start tag; Prowl leaves it until someone re-tags it'], ['o', 'open', 'Open the PR or the ticket in the browser']],
      CONFIG_KEYS, [],
    ],
  };
  const NEW_REVIEW = ['n', 'quick review', 'Quick review: PRs reviewed together as one set, without a ticket (on the Reviewer)'];
  const KEY_GROUPS = [
    ['Moving around', [['tab', 'side', 'Switch between the Reviewer and the Builder; R and B go straight to one'],
      ['←→', 'views', 'The previous or next view; 1–5 go straight to Running, History, Needs you, Config or Log'],
      ['↑↓', 'select', 'Move the selection; scroll this list and the Update Notes']]],
    ['The side in view', [['e', 'on/off', 'Turn the side in view on or off, at once'], ['r', 'poll', 'Poll the side in view now'],
      ['p', 'pause', 'Pause the side in view: running sessions carry on, nothing new starts'], NEW_REVIEW]],
    ['Typing', [['enter', 'save', 'Save the edit, or send the answer'], ['esc', 'cancel', 'Cancel it'], ['←→', 'move', 'Move the cursor; home and end jump to either end']]],
    ['Mouse', [['click', '', 'A side, view or row picks it; the selected row again does what enter does; a link opens; a key in the bar presses it'],
      ['scroll', '', 'Moves the selection, or scrolls']]],
    ['Prowl', [['/', 'all keys', 'Show or hide this list'], ['esc', 'close', 'Close this list, or answer no'],
      ['q', 'quit', 'Quit both sides; running sessions keep going and reappear on the next launch'], ['ctrl-c', 'quit now', 'Quit at once, without asking']]],
  ];
  const pressable = k => (k.length === 1 || ['enter', 'tab', 'esc'].includes(k) ? () => onKey(k) : undefined);
  // The view's own keys, while it has something selected for them to act on.
  const viewKeys = () => {
    const list = [live, history, needs][view()];
    return list && !list(ui.side).length ? [] : VIEW_KEYS[ui.side][view()];
  };

  /** The keys bar: the view's keys, then the most useful of the rest that fit, and / for the full list, in their own colours. */
  function bar(segs) {
    return Object.assign(segs.map(([style, text, url, hit]) => [BAR.bg + (style || BAR.text), text, url, hit]), { bg: BAR.bg, footer: true });
  }
  const chip = ([k, label]) => [[`${ST.bold}${acc().fg}`, ` ${k}`, undefined, pressable(k)], [BAR.text, ` ${label} `, undefined, pressable(k)]];
  const chips = (list, room) => {
    const out = [];
    for (const c of list) { const segs = chip(c); if (width(out) + width(segs) <= room) out.push(...segs); }
    return out;
  };

  function footer(W) {
    if (ui.notes) return bar([[BAR.text, ' ↑↓ scroll · any other key or a click closes the Update Notes']]);
    if (ui.confirm) return bar([[`${ST.bold}${ST.yellow}`, ` ${ui.confirm.text} `], ...(ui.confirm.key ? [] : chip(['y', 'yes'])), ...chip(['n', ui.confirm.key ? 'stay' : 'no'])]);
    if (ui.edit) return bar([...chip(['enter', ui.edit.prs ? 'review' : 'save']), ...chip(['esc', 'cancel']), ...chip(['←→', 'move'])]);
    if (Date.now() < ui.flashUntil) return bar([[ST.green, ` ${ui.flash}`]]);
    if (ui.keys) return bar(spread([...chip(['↑↓', 'scroll']), ...chip(['/', 'close']), ...chip(['esc', 'close'])], [[BAR.text, 'any other key closes this and does its job ']], W));
    const more = chip(['/', 'all keys']);
    const own = chips(viewKeys(), W - width(more) - 3);
    const rest = chips([...(ui.side === 'reviewer' ? [NEW_REVIEW] : []), ...(SIDES.filter(visible).length > 1 ? [['tab', 'side']] : []),
      ['←→', 'views'], ['r', 'poll'], ['p', 'pause'], ['e', 'on/off'], ['q', 'quit']], W - width(more) - width(own) - (own.length ? 3 : 1));
    return bar(spread([...own, ...(own.length && rest.length ? [[BAR.sep, ' │']] : []), ...rest], more, W));
  }

  /** The full list of keys (/): this view's first, then the side's other views, then the rest, in columns when there's room. */
  function keysView(W, H) {
    const head = (text, style, note = '') => [[style, ` ${text}`], [ST.grey, note]];
    const groups = [[`${NAMES[ui.side]} · ${TABS[view()]}`, VIEW_KEYS[ui.side][view()], ' · this view'],
      ...TABS.map((t, i) => [`${NAMES[ui.side]} · ${t}`, VIEW_KEYS[ui.side][i]]).filter((g, i) => i !== view()),
      ...KEY_GROUPS].filter(([, list]) => list.length);
    const cols = W >= 120 ? 2 : 1;
    const colW = Math.floor((W - (cols - 1) * 2) / cols);
    const blocks = groups.map(([title, list, note], g) => [
      head(title, `${ST.bold}${g < groups.length - KEY_GROUPS.length ? acc().fg : ST.reset}`, note),
      ...list.flatMap(([k, , text]) => wrap(text, colW - 13, 3).map((l, n) => [['', '   '], [`${ST.bold}${acc().fg}`, (n ? '' : k).padEnd(10)], ['', l]])),
      [],
    ]);
    // Whole sections to each column, the first filled to about half.
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const columns = [[]];
    for (const b of blocks) {
      if (cols > 1 && columns.length < cols && columns.at(-1).length && columns.at(-1).length + b.length / 2 > total / cols) columns.push([]);
      columns.at(-1).push(...b);
    }
    const lines = Array.from({ length: Math.max(...columns.map(c => c.length)) }, (_, r) => columns.flatMap((c, n) => {
      const row = c[r] || [];
      return n < columns.length - 1 ? [...row, ['', ' '.repeat(Math.max(0, colW - width(row) + 2))]] : row;
    }));
    const rows = [[[`${ST.bold}${acc().fg}`, ' Keys'], [ST.grey, ` · ${NAMES[ui.side]}, ${TABS[view()]}`]], rule(W), ...lines];
    ui.keys.scroll = Math.max(0, Math.min(ui.keys.scroll, rows.length - H));
    return rows.slice(ui.keys.scroll).map(r => onClick(r, () => { ui.keys = null; }));
  }

  function rows(advance, W, H) {
    if (!visible(ui.side)) ui.side = 'reviewer'; // the Builder was switched off with nothing left to show
    const out = [titleBar(W)];
    const said = app.speech(); // read with Hoot off too, so what he'd have said doesn't pile up
    if (H >= 27 && app.cfg.hoot !== false && !ui.keys) out.push(...owl.render(W, 7, mood(said), said?.text || '', advance));
    out.push(sideBar(W), tabBar(), rule(W));
    const bodyH = H - out.length - 1;
    const body = (ui.notes ? notesView : ui.keys ? keysView : [runningView, historyView, needsView, configView, logView][view()])(W, bodyH).slice(0, bodyH);
    while (body.length < bodyH) body.push([]);
    out.push(...body, footer(W));
    ui.frame = out;
    ui.text = out.map(r => r.map(seg => clean(seg[1])).join('').slice(0, W));
    if (!ui.drag?.moved) return out;
    const { ys, xs, ye, xe } = span(ui.drag);
    return out.map((r, y) => (y < ys || y > ye ? r : highlight(r, y === ys ? xs : 0, y === ye ? xe + 1 : W)));
  }

  const size = () => [Math.max(40, (out.columns || 100) - 1), Math.max(12, out.rows || 30)];
  function paint(advance) {
    const [W, H] = size();
    out.write(`\x1b[?2026h\x1b[H${rows(advance, W, H).map(r => draw(r, W)).join('\r\n')}\x1b[?2026l`);
  }

  const startEdit = (value, commit, secret = false) => { ui.edit = { value, cursor: value.length, commit, error: '', secret }; };
  const saved = msg => { actions.saveConfig(); flash(msg || 'Saved. The next poll uses it (r polls now).'); };

  /** Parses a board as typed in Config: "Project / Team" for Azure DevOps, a name or id for Jira. */
  function parseBoard(v) {
    if (app.cfg.taskBoard === 'jira') return v ? { board: v } : 'Type the board name or id';
    const cut = v.indexOf('/');
    const project = v.slice(0, cut).trim();
    const team = v.slice(cut + 1).trim();
    return cut < 0 || !project || !team ? 'Write it as Project / Team, e.g. My Project / My Team' : { project, team };
  }

  function editBoard(index) {
    const boards = app.boards();
    if (index == null) sel()[CONFIG] = configRows().findIndex(f => f.addBoard);
    startEdit(index == null ? '' : app.tracker().boardLabel(boards[index]), v => {
      const b = parseBoard(v);
      if (typeof b === 'string') return b;
      if (index == null) boards.push(b);
      else boards[index] = b;
      saved('Board saved. r polls now.');
      return '';
    });
  }

  function toggleSide(name = ui.side) {
    const now = actions.toggleSide(name);
    flash(now ? `${NAMES[name]} on: it picks up work from the next poll.${name === 'builder' ? ' Its tab is up top (tab or B).' : ''}`
      : `${NAMES[name]} off: nothing new is claimed or started; running sessions finish.`);
  }

  /** n, from anywhere: a quick review of the PRs typed in, reviewed together without a ticket. */
  function newReview() {
    if (!isOn('reviewer')) return flash('The Reviewer is off: e turns it on.');
    ui.side = 'reviewer';
    ui.view.reviewer = RUNNING;
    startEdit('', v => {
      const refs = parsePrRefs(v);
      if (typeof refs === 'string') return refs;
      actions.reviewPrs(refs).then(
        run => flash(run ? `Reviewing ${plural(run.prs.length, 'PR')} together as ${run.ticket}.` : 'Dry run: the Log says what would be reviewed.'),
        e => flash(`Couldn't start the review: ${e.message}`));
      return '';
    });
    ui.edit.prs = true;
    return undefined;
  }

  function configKey(k) {
    const f = configRows()[sel()[CONFIG]];
    const c = app.cfg;
    if (k === 'a') return editBoard(null);
    if (f.switch) return k === 'enter' ? toggleSide(f.switch) : undefined;
    if (f.file) return k === 'enter' ? openExternal(f.file) : undefined;
    if (k === 'd' && f.board != null) {
      const boards = app.boards();
      ui.confirm = { text: `Remove board ${app.tracker().boardLabel(boards[f.board])}?`, yes: () => { boards.splice(f.board, 1); saved('Board removed.'); } };
      return undefined;
    }
    if (k !== 'enter') return undefined;
    if (f.addBoard) return editBoard(null);
    if (f.board != null) return editBoard(f.board);
    if (f.type === 'secret') {
      if (!c.jira.email) return flash('Fill in the Jira email first.');
      return startEdit('', v => {
        if (!v) return 'Paste the token, or esc to keep the saved one';
        const err = actions.saveToken(v);
        if (err) return err;
        flash('Token saved. r polls now.');
        return '';
      }, true);
    }
    const cur = getPath(c, f.key);
    if (f.type === 'list') return openExternal(CONFIG_PATH);
    if (f.type === 'bool') { setPath(c, f.key, !cur); return saved(); }
    if (f.type === 'enum') { setPath(c, f.key, f.values[(f.values.indexOf(cur) + 1) % f.values.length]); return saved(); }
    return startEdit(String(cur ?? ''), v => {
      if (!v && !f.empty) return 'Cannot be empty';
      if (f.type === 'int') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < f.min || n > f.max) return `Enter a whole number from ${f.min} to ${f.max}`;
        setPath(c, f.key, n);
      } else {
        const ok = f.valid ? f.valid(v) : true;
        if (ok !== true) return ok;
        setPath(c, f.key, v);
      }
      saved();
      return '';
    });
  }

  function needsKey(k) {
    const it = needs(ui.side)[sel()[NEEDS]];
    if (!it) return undefined;
    if (k === 'o') openExternal(it.pr || builder.history().find(w => w.uid === it.recordId)?.url || '');
    else if (k === 'enter') {
      startEdit('', v => {
        const n = Number(v);
        const text = Number.isInteger(n) && it.options[n - 1] ? it.options[n - 1] : v;
        actions.answer(it, text);
        flash(it.kind === 'plan' ? (text ? 'Sent back with your note.' : 'Plan approved: the session builds it now.')
          : ['question', 'repos', 'blocked'].includes(it.kind) ? 'Answered: the session picks up from here.' : 'Retrying.');
        return '';
      });
    } else if (k === 's') {
      ui.confirm = ['question', 'repos'].includes(it.kind) ? null
        : { text: `End the work on ${it.ticket} and take its '${app.cfg.builder.tags.inProgress}' tag off?`, yes: () => { actions.skip(it); flash('Ended.'); } };
      if (!ui.confirm) { actions.skip(it); flash('Skipped: the session uses its default.'); }
    } else if (k === 't') {
      ui.confirm = { text: `Hand ${it.ticket} back with '${app.cfg.builder.tags.start}'? Prowl leaves it until someone re-tags it.`, yes: () => actions.handBack(it) };
    }
    return undefined;
  }

  function editKey(k) {
    const e = ui.edit;
    if (k === 'esc') ui.edit = null;
    else if (k === 'enter') { const err = e.commit(e.value.trim()); if (err) e.error = err; else ui.edit = null; }
    else if (k === 'backspace') { if (e.cursor) { e.value = e.value.slice(0, e.cursor - 1) + e.value.slice(e.cursor); e.cursor--; } }
    else if (k === 'delete') e.value = e.value.slice(0, e.cursor) + e.value.slice(e.cursor + 1);
    else if (k === 'left') e.cursor = Math.max(0, e.cursor - 1);
    else if (k === 'right') e.cursor = Math.min(e.value.length, e.cursor + 1);
    else if (k === 'home') e.cursor = 0;
    else if (k === 'end') e.cursor = e.value.length;
    else if (k.length === 1 && k >= ' ') { e.value = e.value.slice(0, e.cursor) + k + e.value.slice(e.cursor); e.cursor++; }
  }

  function reviewerKey(k, r) {
    if (k === 'o') prsOf(r).forEach(p => openExternal(p.url));
    else if (k === 'a' && r.ticketUrl) openExternal(r.ticketUrl);
    else if (k === 'enter' && view() === HISTORY && r.pr) openExternal(r.briefDir || r.pr.url);
    else if (k === 'enter' && view() === HISTORY && r.status === 'done') openExternal(r.reportPath);
    else if (k === 's' && view() === RUNNING && r.status === 'running') {
      ui.confirm = { text: r.quick ? `Stop the quick review ${r.ticket}?` : `Stop the review of ${r.ticket}? Its '${app.cfg.tags.inProgress}' tag is removed; re-tag to run it again.`, yes: () => actions.stop('reviewer', r) };
    }
  }

  function builderKey(k, w) {
    const prs = w.prs?.length ? w.prs : (w.repos || []).filter(r => r.pr).map(r => r.pr);
    if (k === 'o') prs.forEach(p => openExternal(p.url));
    else if (k === 'a' && w.url) openExternal(w.url);
    else if (k === 'enter') openExternal(w.briefDir);
    else if (k === 's' && view() === RUNNING) {
      ui.confirm = { text: `Stop ${w.key}? It stops before its next push, PR, tag or turn, and '${app.cfg.builder.tags.inProgress}' comes off.`, yes: () => actions.stop('builder', w) };
    } else if (k === 'w' && view() === HISTORY) {
      if (!isOn('builder')) return flash('w follows a ticket\'s PRs with the Builder: turn it on first (e).');
      actions.follow(w).then(() => flash(`Following ${w.key}'s PRs.`), e => flash(`Couldn't follow ${w.key}: ${e.message}`));
    } else if (k === 't' && view() === HISTORY && w.status === 'following') {
      actions.stopFollowing(w);
      flash(`Stopped following ${w.key}.`);
    }
    return undefined;
  }

  function onKey(k) {
    if (k === 'ctrl-c') return actions.quit();
    if (ui.notes) {
      if (k === 'up' || k === 'down') ui.notes.scroll += k === 'up' ? -1 : 1;
      else ui.notes = null;
      return undefined;
    }
    if (ui.confirm) {
      const c = ui.confirm;
      const yes = c.key || 'y';
      if ([yes, 'n', 'esc'].includes(k)) { ui.confirm = null; if (k === yes) c.yes(); }
      return undefined;
    }
    if (ui.edit) return editKey(k);
    if (ui.keys) {
      if (k === 'up' || k === 'down') { ui.keys.scroll += k === 'up' ? -1 : 1; return undefined; }
      ui.keys = null;
      if (k === '/' || k === 'esc') return undefined; // anything else closes the list and does its job
    } else if (k === '/') { ui.keys = { scroll: 0 }; return undefined; }
    if (k === 'tab' || k === 'R' || k === 'B') {
      const to = k === 'R' ? 'reviewer' : k === 'B' || ui.side === 'reviewer' ? 'builder' : 'reviewer';
      if (visible(to)) ui.side = to;
      else if (k === 'B') flash('The Builder is off: turn it on in Config (4).');
      return undefined;
    }
    if (k.length === 1 && k >= '1' && k <= String(TABS.length)) { ui.view[ui.side] = Number(k) - 1; return undefined; }
    if (k === 'right') { ui.view[ui.side] = (view() + 1) % TABS.length; return undefined; }
    if (k === 'left') { ui.view[ui.side] = (view() + TABS.length - 1) % TABS.length; return undefined; }
    if (k === 'up') { sel()[view()] = Math.max(0, sel()[view()] - 1); return undefined; }
    if (k === 'down') { sel()[view()]++; return undefined; }
    if (k === 'q') {
      const n = allLive();
      if (!n) return actions.quit();
      ui.confirm = { text: `${plural(n, 'session')} still running. They keep going in the background and reappear next launch. Press q again to quit.`, key: 'q', yes: actions.quit };
      return undefined;
    }
    if (k === 'e') return toggleSide();
    if (k === 'n') return newReview();
    if (k === 'r') { actions.pollNow(ui.side); flash(isOn(ui.side) ? `Polling the ${NAMES[ui.side]} now.` : `The ${NAMES[ui.side]} is off: e turns it on.`); return undefined; }
    if (k === 'p') { actions.togglePause(ui.side); flash(side().paused ? `${NAMES[ui.side]} paused: running sessions carry on, nothing new starts.` : 'Resumed.'); return undefined; }
    if (view() === CONFIG) return configKey(k);
    if (view() === NEEDS) return needsKey(k);
    const r = (view() === RUNNING ? live(ui.side) : view() === HISTORY ? history(ui.side) : [])[sel()[view()]];
    if (!r) return undefined;
    return ui.side === 'reviewer' ? reviewerKey(k, r) : builderKey(k, r);
  }

  /** A mouse event: the wheel moves like ↑↓, and a left click does what's under it (hitAt). */
  /**
   * A mouse event. The wheel moves like ↑↓. With the left button, a press and release in place is a click (what's
   * under it, hitAt), and a drag selects text, highlighted, which is copied to the clipboard when the button is let go.
   */
  function onMouse({ mouse: b, x, y, release }) {
    if (b & 64) return release ? undefined : onKey(b & 1 ? 'down' : 'up');
    if ((b & 3) !== 0) return undefined; // the left button only
    if (b & 32) { // moved with the button down
      if (ui.drag) Object.assign(ui.drag, { x1: x, y1: y, moved: ui.drag.moved || x !== ui.drag.x0 || y !== ui.drag.y0 });
      return undefined;
    }
    if (!release) { ui.drag = { x0: x, y0: y, x1: x, y1: y, moved: false }; return undefined; }
    const d = ui.drag;
    ui.drag = null;
    if (d?.moved) return copySelection(d);
    return click(x, y);
  }

  /** A drag's start and end in reading order: rows ys to ye, from column xs on the first to xe on the last. */
  function span(d) {
    const fwd = d.y0 < d.y1 || (d.y0 === d.y1 && d.x0 <= d.x1);
    const [ys, xs, ye, xe] = fwd ? [d.y0, d.x0, d.y1, d.x1] : [d.y1, d.x1, d.y0, d.x0];
    return { ys, xs, ye, xe };
  }

  /** `row` with columns from..to-1 in reverse video, as a terminal shows a selection. */
  function highlight(row, from, to) {
    const segs = [];
    let at = 0;
    for (const [style, raw, url, hit] of row) {
      const text = clean(raw);
      const [a, b] = [Math.max(0, Math.min(text.length, from - at)), Math.max(0, Math.min(text.length, to - at))];
      for (const [part, st] of [[text.slice(0, a), style], [text.slice(a, b), `${style}${ST.cursor}`], [text.slice(b), style]]) if (part) segs.push([st, part, url, hit]);
      at += text.length;
    }
    return Object.assign(segs, { bg: row.bg, hit: row.hit, footer: row.footer });
  }

  /** Copies the text a drag selected, as Claude Code does: each row's text, without its trailing spaces. */
  function copySelection(d) {
    const { ys, xs, ye, xe } = span(d);
    const text = ui.text.slice(ys, ye + 1).map((l, i) => l.slice(i ? 0 : xs, ys + i === ye ? xe + 1 : undefined).trimEnd()).join('\n').trim();
    if (!text) return undefined;
    if (!io.headless) out.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`); // OSC 52: the terminal's own clipboard, over SSH too
    (io.copy || copyText)(text);
    flash(`Copied ${plural(text.length, 'character')} to the clipboard.`);
    return undefined;
  }

  function click(x, y) {
    if (ui.edit) return undefined; // not while typing
    const row = ui.frame[y];
    if (ui.notes) { ui.notes = null; return undefined; }
    if (!row || (ui.confirm && !row.footer)) return undefined;
    return hitAt(row, x)?.();
  }
  const input = k => (typeof k === 'object' ? onMouse(k) : onKey(k));

  if (io.headless) {
    return {
      restore() {},
      key(k) { onKey(k); },
      /** A click (button 0) or wheel turn (64 up, 65 down) at column `x`, row `y` of the last frame, from 0. */
      mouse(x, y, button = 0) { onMouse({ mouse: button, x, y, release: false }); if (button < 64) onMouse({ mouse: button, x, y, release: true }); },
      /** A drag with the left button from (x0, y0) to (x1, y1), let go there. */
      drag(x0, y0, x1, y1) { for (const [m, x, y, release] of [[0, x0, y0, false], [32, x1, y1, false], [0, x1, y1, true]]) onMouse({ mouse: m, x, y, release }); },
      /** The frame as plain text lines, at `W` by `H` columns and rows. */
      frame(W = 80, H = 30) { return rows(false, W, H).map(r => draw(r, W).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x1b]*\x1b\\/g, '')); },
      ui,
    };
  }
  // Save the tab title and set it, alternate screen, hidden cursor, and the mouse reported: clicks, drags and the wheel (SGR encoding).
  out.write('\x1b[22;0t\x1b]0;Prowl\x07\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h');
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  stdin.on('data', data => { for (const k of keys(data)) input(k); paint(false); });
  out.on('resize', () => paint(false));
  const timer = setInterval(() => paint(true), 100);
  paint(true);

  return {
    restore() {
      clearInterval(timer);
      out.write('\x1b[?1006l\x1b[?1002l\x1b[?2026l\x1b[?25h\x1b[?1049l\x1b[23;0t'); // …and restore the tab title
      try { stdin.setRawMode(false); } catch { /* not a TTY any more */ }
      stdin.pause();
    },
  };
}
