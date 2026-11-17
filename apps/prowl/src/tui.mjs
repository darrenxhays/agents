import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_PATH } from './config.mjs';
import { dropCache, readLines, readLog } from './details.mjs';
import { CONFIG_FIELDS, JIRA } from './fields.mjs';
import { askLabel, labelNames } from './names.mjs';
import { label as jiraLabel } from './jira.mjs';
import { cleanName, notARef, parsePaste } from './paste.mjs';
import { createMascot, wrap } from './mascot.mjs';
import { shortstat } from './github.mjs';
import { copyText, openExternal } from './proc.mjs';
import { findingLinks, findingsFor, findingUrl, prLinks, readResult, SEVERITY_FILTERS, STATUS_FILTERS, webLink } from './reviewer/details.mjs';
import { isCounted, isParked, SEVERITIES } from './reviewer/result.mjs';
import { awaitingHuman, isOwn } from './reviewer/reviews.mjs';
import { spendText } from './builder/rules.mjs';
import { bar as spendBar, breakdown, modelEffort, RANGES, rangeName, spendIn, summarize } from './stats.mjs';

const ST = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', title: '\x1b[1;38;5;220m', yellow: '\x1b[38;5;220m',
  green: '\x1b[38;5;114m', red: '\x1b[38;5;203m', orange: '\x1b[38;5;208m', link: '\x1b[4;38;5;75m', cyan: '\x1b[38;5;80m',
  grey: '\x1b[38;5;244m', tabOn: '\x1b[1;38;5;16;48;5;220m', tabOff: '\x1b[38;5;250m', cursor: '\x1b[7m',
};
const LEVEL = { ok: ST.green, info: ST.grey, warn: ST.yellow, error: ST.red };
const fg = n => `\x1b[38;5;${n}m`;
const bg = n => `\x1b[48;5;${n}m`;
const DARK = `${ST.bold}${fg(16)}`; // dark text, on a coloured tab or keycap
/**
 * Each side's colour, in shades: the side's tab and its keycaps in `base`, the selected view's tab and a hovered keycap
 * in `light`, and `ghost` for a tab under the pointer that isn't selected. The Reviewer amber, the Builder violet.
 */
const shades = (base, light) => ({
  fg: fg(base), tab: `${DARK}${bg(base)}`, view: `${DARK}${bg(light)}`, ghost: `${ST.bold}${fg(light)}${bg(237)}`,
  key: `${DARK}${bg(base)}`, keyHover: `${DARK}${bg(light)}`,
});
const ACCENT = { reviewer: shades(220, 222), builder: shades(141, 183) };
// The two bars along the bottom: navigation on top, the darker, and the screen's own keys below, keycaps in the side's colour.
const NAV = { bg: bg(234), text: fg(247), cap: `${ST.bold}${fg(253)}${bg(239)}`, capHover: `${DARK}${bg(252)}`, labelHover: `${ST.bold}${fg(231)}${bg(240)}` };
const KEYBAR = { bg: bg(237), text: fg(253), labelHover: `${ST.bold}${fg(231)}${bg(242)}` };
// What the pointer is over: a list or settings row, any other clickable thing (unless it says how), and a link.
const HOVER = { row: bg(236), seg: `${ST.bold}${bg(238)}`, link: `\x1b[1;4;38;5;117m` };
// Config's sections, each in its own colour; the Reviewer's and the Builder's in their sides' colours.
const SECTION = {
  Prowl: '\x1b[38;5;117m', 'Upkeep and display': '\x1b[38;5;117m',
  Boards: '\x1b[38;5;114m', 'Jira fields': '\x1b[38;5;114m', 'GitHub and projects': '\x1b[38;5;114m',
  'Build tags': '\x1b[38;5;211m', 'Review tags': '\x1b[38;5;211m', 'Build labels': '\x1b[38;5;211m', 'Review labels': '\x1b[38;5;211m',
  'All sessions': '\x1b[38;5;80m', 'Quick reviews and builds': '\x1b[38;5;80m',
};
const sectionColor = s => (s.startsWith('Reviewer') ? ACCENT.reviewer.fg : s.startsWith('Builder') ? ACCENT.builder.fg : SECTION[s] || ST.grey);
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SIDES = ['reviewer', 'builder'];
const NAMES = { reviewer: 'Reviewer', builder: 'Builder' };
const TABS = ['Running', 'History', 'Needs you', 'Config', 'Log', 'Stats'];
const [RUNNING, HISTORY, NEEDS, CONFIG, LOG, STATS] = [0, 1, 2, 3, 4, 5]; // eslint-disable-line no-unused-vars

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
const ago = ms => { const m = Math.floor((Date.now() - ms) / 60_000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
/** `segs` cut to exactly `n` columns: an ellipsis where they're cut short, spaces where they run out. */
const clip = (segs, n) => {
  const out = [];
  let used = 0;
  for (const [style, raw, ...rest] of segs) {
    const text = clean(raw);
    if (used >= n) break;
    const part = text.length > n - used ? `${text.slice(0, Math.max(0, n - used - 1))}…` : text;
    out.push([style, part, ...rest]);
    used += part.length;
  }
  return [...out, ['', ' '.repeat(Math.max(0, n - used))]];
};
// Hoot's strip: his patch of ground, his speech box beside him, then cards on a wide enough screen.
const STRIP = { talkMin: 34, talkMax: 44, cardMin: 30, cardMax: 60, border: '\x1b[38;5;239m' };
const spin = () => SPIN[Math.floor(Date.now() / 100) % SPIN.length];
const rule = W => [[ST.grey, '─'.repeat(W)]];
const getPath = (o, k) => k.split('.').reduce((v, p) => v?.[p], o);
const setPath = (o, k, val) => { const ps = k.split('.'); const last = ps.pop(); ps.reduce((v, p) => (v[p] ??= {}), o)[last] = val; };

/**
 * A row is a list of [style, text, url?, onClick?, hoverStyle?] segments; draw() clips it to `w` columns and pads the
 * rest, in `row.bg` when set (a bar's background). `row.hit` is what a click elsewhere on the row does.
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

/**
 * `row` with the pointer at column `x`: what a click there would do, lit up. A button (its segments sharing one onClick)
 * in its hover style, a link brighter, a row with a click of its own in a soft band across the screen.
 */
function hovered(row, x) {
  let at = 0;
  const seg = row.find(s => (at += clean(s[1]).length) > x);
  const keep = segs => Object.assign(segs, { bg: row.bg, hit: row.hit, footer: row.footer, pane: row.pane, main: row.main, menu: row.menu });
  if (seg?.[3]) return keep(row.map(s => (s[3] === seg[3] ? [s[4] || `${s[0]}${HOVER.seg}`, ...s.slice(1)] : s)));
  if (seg?.[2]) return keep(row.map(s => (s === seg ? [HOVER.link, ...s.slice(1)] : s)));
  if (row.hit) return Object.assign(keep(row.map(s => [`${HOVER.row}${s[0]}`, ...s.slice(1)])), { bg: HOVER.row });
  return row;
}

/**
 * A row of segments wrapped to `w` columns at spaces, every line after the first indented by `hang`. A word longer
 * than a line is cut across lines, spaces that would start a wrapped line are dropped, and each wrapped piece keeps
 * its segment's style, link and click.
 */
export function wrapSegs(segs, w, hang = 0) {
  if (hang >= w) hang = 0;
  const lines = [[]];
  let used = 0;
  let fresh = false; // a wrapped line with nothing on it yet
  const newLine = () => { lines.push(hang ? [['', ' '.repeat(hang)]] : []); used = hang; fresh = true; };
  const put = (seg, text) => {
    const last = lines.at(-1).at(-1);
    if (last?.src === seg) last[1] += text;
    else lines.at(-1).push(Object.assign([seg[0], text, ...seg.slice(2)], { src: seg }));
    used += text.length; fresh = false;
  };
  for (const seg of segs) {
    for (let t of clean(seg[1]).match(/\s+|\S+/g) || []) {
      if (/^\s/.test(t)) { if (fresh) continue; if (used + t.length > w) newLine(); else put(seg, t); continue; }
      while (t) {
        if (used + t.length <= w) { put(seg, t); break; }
        if (!fresh && used > 0) { newLine(); continue; }
        const n = Math.max(1, w - used);
        put(seg, t.slice(0, n)); t = t.slice(n);
        if (t) newLine();
      }
    }
  }
  return lines;
}

// A branch or a commit as a link to GitHub. The repo's web address is the PR's own URL up to /pull/<n>, so GitHub
// Enterprise hosts work; with no usable PR URL, or a value that isn't a branch or a hash, it is plain text.
const repoWeb = p => /^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(String(p?.url ?? ''))?.[1] || '';
/** A branch: its bare name links into the PR's repo, `owner/repo:branch` into the fork; `deleted fork:branch` is text. */
export const branchSeg = (p, branch, style = '') => {
  const [, fork, name] = /^([^:]*):(.*)$/.exec(String(branch)) || [null, '', String(branch)];
  const host = /^https:\/\/[^/\s]+/.exec(repoWeb(p))?.[0];
  const web = !fork ? repoWeb(p) : host && /^[\w.-]+\/[\w.-]+$/.test(fork) ? `${host}/${fork}` : '';
  return web ? [ST.link, String(branch), `${web}/tree/${name.split('/').map(encodeURIComponent).join('/')}`] : [style, String(branch)];
};
/** A commit, shown as its first 7 characters: a link only when the value is 7 to 40 hex characters. */
export const shaSeg = (p, sha, style = '') => (repoWeb(p) && /^[0-9a-f]{7,40}$/i.test(String(sha))
  ? [ST.link, String(sha).slice(0, 7), `${repoWeb(p)}/commit/${sha}`] : [style, String(sha).slice(0, 7)]);

/** The terminal progress report (OSC 9;4) for a state: a full bar for error and warning, none otherwise. */
export const progressSeq = state => `\x1b]9;4;${state};${state === 2 || state === 4 ? 100 : 0}\x07`;

/** List rows around the selection, so the selected row always stays visible. */
function windowed(list, sel, h) {
  const start = Math.max(0, Math.min(sel - Math.floor(h / 2), list.length - h));
  return list.slice(start, start + h).map((item, k) => ({ item, i: start + k }));
}

/**
 * Input as it arrived, split into what can be read now and the tail to hold until more comes: a paste whose end
 * hasn't arrived, or an escape sequence cut short (a mouse report or an arrow key split across two reads, which
 * would otherwise be read as esc and the keys after it).
 */
export function holdBack(data) {
  const open = data.lastIndexOf('\x1b[200~');
  const at = open >= 0 && data.indexOf('\x1b[201~', open) < 0 ? open : /\x1b(\[[<0-9;]*|O)?$/.exec(data)?.index ?? data.length;
  return [data.slice(0, at), data.slice(at)];
}

/**
 * What to read when a held-back tail has waited its 50 ms with nothing following: [data, skip]. A lone ESC is the esc
 * key. Anything longer is an unfinished key or mouse sequence: it is dropped (ESC [ 5 read as keys would press 5 and
 * switch views), and `skip` says to skip the rest of it when it arrives (restOf).
 */
export const timedOut = held => (held === '\x1b' ? [held, false] : ['', true]);
/** `chunk` without the end of a sequence whose start was dropped (timedOut). */
export const restOf = chunk => skipRest(chunk)[0];
/**
 * The same, for an end that may itself arrive in pieces: [what is left to read, whether more of it is still to
 * come]. A chunk of only digits, ; and < is all part of it, and its final letter (or ~) hasn't arrived yet.
 */
export function skipRest(chunk) {
  const end = /^[<0-9;]*[A-Za-z~]/.exec(chunk);
  if (end) return [chunk.slice(end[0].length), false];
  return /^[<0-9;]+$/.test(chunk) ? ['', true] : [chunk, false];
}

/** The keys, pastes and mouse events in `data`, as onKey, onPaste and onMouse take them. */
export function* keys(data) {
  const paste = /\x1b\[200~([\s\S]*?)\x1b\[201~/g; // bracketed paste: the text pasted, in one piece
  let at = 0;
  for (let m; (m = paste.exec(data));) {
    yield* keyPresses(data.slice(at, m.index));
    yield { paste: m[1] };
    at = m.index + m[0].length;
  }
  yield* keyPresses(data.slice(at));
}

function* keyPresses(data) {
  const NAMED = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down',
    '\x1bOC': 'right', '\x1bOD': 'left', '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete',
    '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1bOH': 'home', '\x1bOF': 'end',
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
 * toggleSide(side), stop(side, item), answer(item, text), discuss(item, question) (why it can't be asked, or ''), skip(item), handBack(item), follow(record), stopFollowing(record),
 * quickReview(text, opts), quickBuild(text, opts) (each resolving with the run or record, { offer }, or null), answerOffer(offer,
 * choice), stopWait(wait), saveConfig, saveToken, quit }. `io` = { out, stdin, headless }
 * (headless: no raw mode, mouse or timers, for the self-test), copy(text). Returns { restore, key(k), mouse(x, y, button), drag(x0, y0, x1, y1), frame() }.
 */
export function startTui(app, actions, io = {}) {
  const out = io.out || process.stdout;
  const openIt = target => (io.open || openExternal)(target); // io.open: the self-test's opener
  const stdin = io.stdin || process.stdin;
  const owl = createMascot();
  const { sides } = actions;
  const ui = {
    side: 'reviewer', view: { reviewer: 0, builder: 0 }, sel: { reviewer: TABS.map(() => 0), builder: TABS.map(() => 0) },
    edit: null, confirm: null, flash: '', flashUntil: 0, notes: app.notes ? { scroll: 0 } : null,
    keys: null, // the full list of keys, while open (/): { scroll }
    hover: null, // where the pointer is: { x, y }
    frame: [], // the rows last drawn, for mouse clicks
    text: [], // …and their text, for copying a selection
    drag: null, // a mouse selection while the left button is down: { x0, y0, x1, y1, moved }
    offers: app.offers || (app.offers = []), // offers waiting to pop up, oldest first; the first shows when nothing else is open
    offerAt: 0, // the choice under the cursor in the offer showing
    panes: new Map(), // the scrolling panes, by id: { at, ops, top, room, total, follow, focus, painted, owner }
    front: null, // the pane the scroll keys go to, as the last frame painted it: { id, arrows, sig }
    bodyH: 0, // the rows the view had in the last frame
    statsRange: 1, // Stats' time frame, an index into RANGES: it starts on 30 days
    det: { reviewer: null, builder: null }, // the details open on each side, over History's or Running's list
    menu: null, // a setting's values listed under its row, while open: { key, label, options: [{ value, label, current } | { other, label }], at }
    picked: { reviewer: null, builder: null }, // the selected Running row, by id (and ticket): re-found each frame, so rows coming and going don't shift the selection
  };
  const acc = (name = ui.side) => ACCENT[name];
  const cursor = on => (on ? [acc().fg, ' ❯ '] : ['', '   ']);
  const onClick = (row, hit) => Object.assign(row, { hit });
  // A click on a list's row selects it; a click on the row already selected does what enter does.
  const pick = (tab, i) => () => { if (sel()[tab] === i) onKey('enter'); else { sel()[tab] = i; ui.picked[ui.side] = null; } };
  const flash = text => { ui.flash = text; ui.flashUntil = Date.now() + 4000; };
  const side = () => sides[ui.side];
  const view = () => ui.view[ui.side];
  const sel = () => ui.sel[ui.side];
  const clampSel = (tab, n) => (sel()[tab] = Math.max(0, Math.min(sel()[tab], n - 1)));
  const isOn = name => app.sideOn(name);
  // The Reviewer never waits on you, so it has no Needs you view; the numbers keep their meaning (Config is 4 on both).
  const hasView = i => !(ui.side === 'reviewer' && i === NEEDS);
  // The Builder's tab shows once it is on, and while it still has sessions running or items waiting on you.
  const visible = name => name === 'reviewer' || isOn(name) || live(name).length > 0 || needs(name).length > 0;
  const reviewer = sides.reviewer;
  const builder = sides.builder;

  // Running sessions, per side.
  const live = name => (name === 'reviewer' ? reviewer.running() : builder.running());
  // While a frame is drawn, the finished reviews are read once and each ticket's latest is looked up, not searched
  // for: History runs to thousands of reviews, and reading it again for every row took most of a frame.
  let drawn = null; // what the frame being drawn has read so far
  const once = (key, read) => (drawn ? (drawn[key] ??= read()) : read());
  const finished = () => once('finished', () => reviewer.finished()); // newest first
  /** Each ticket's latest finished review (`any`), and its latest one that is done (`done`). */
  const latest = () => once('latest', () => {
    const [any, done] = [new Map(), new Map()];
    for (const r of finished()) {
      if (!any.has(r.ticket)) any.set(r.ticket, r);
      if (r.status === 'done' && !done.has(r.ticket)) done.set(r.ticket, r);
    }
    return { any, done };
  });
  // The Reviewer's finished reviews and, from before 2.12.0, Fix my PRs' fixes, newest first.
  const reviewHistory = () => once('history', () => [...finished(), ...(reviewer.state.fixes || []).filter(f => !['fixing', 'stopping'].includes(f.status))]
    .sort((a, b) => (b.endedAt || b.startedAt || b.createdAt) - (a.endedAt || a.startedAt || a.createdAt)));
  const history = name => (name === 'reviewer' ? reviewHistory() : builder.history());
  const needs = name => sides[name].needs();
  const allLive = () => SIDES.reduce((n, s) => n + live(s).length, 0);
  // The reviews being set up before their sessions start: Running rows too, and they count as running.
  const settingUp = () => reviewer.preparing?.() || [];
  const liveCount = name => live(name).length + (name === 'reviewer' ? settingUp().length : 0);

  // Hoot sleeps unless something is happening: a poll, a running session, or something he has to say.
  /**
   * Prowl's state for the terminal's tab and taskbar icon (OSC 9;4, the progress report): 2 error (red) when a side
   * that is on has a poll error or something in Needs you is a stop rather than a question, 4 warning (yellow) when
   * anything else needs you, 3 busy while a session runs, else 0.
   */
  function progressState() {
    const waiting = SIDES.flatMap(name => sides[name].needs());
    if (SIDES.some(name => isOn(name) && sides[name].lastError) || waiting.some(x => !['question', 'plan', 'repos', 'blocked'].includes(x.kind))) return 2;
    if (waiting.length) return 4;
    return allLive() ? 3 : 0;
  }

  /**
   * The terminal's title: short, with what matters first, since a narrow tab cuts it from the right. `Prowl` (with
   * ⚑n when n Needs-you items wait), then what is running per side, or with nothing running: off, poll error, paused or idle.
   */
  function titleText() {
    const waiting = SIDES.reduce((n, name) => n + sides[name].needs().length, 0);
    const parts = [`Prowl${waiting ? ` ⚑${waiting}` : ''}`];
    const [reviews, builds] = [live('reviewer'), live('builder')]; // a review being set up doesn't count as running
    if (reviews.length) parts.push(reviews.length === 1 ? `reviewing ${reviews[0].ticket}` : `${reviews.length} reviews`);
    if (builds.length) parts.push(builds.length === 1 ? `${builds[0].turnKind === 'round' ? 'fixing' : 'building'} ${builds[0].key}` : `${builds.length} builds`);
    if (parts.length === 1) {
      const on = SIDES.filter(isOn);
      parts.push(!on.length ? 'off' : on.some(name => sides[name].lastError) ? 'poll error' : on.every(name => sides[name].paused) ? 'paused' : 'idle');
    }
    return parts.join(' · ').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); // a ticket key or quick name comes from elsewhere
  }
  const mouseOn = () => app.cfg.mouse !== false;

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
    const [n, k] = [liveCount(name), needs(name).length];
    const full = `${NAMES[name]} · ${isOn(name) ? 'on' : 'off'}${n ? ` · ▶ ${n}` : ''}${k ? ` · ⚑ ${k}` : ''}`;
    const mid = `${NAMES[name]} ${isOn(name) ? 'on' : 'off'}${n ? ` ▶${n}` : ''}${k ? ` ⚑${k}` : ''}`;
    const tiny = `${NAMES[name][0]}${isOn(name) ? '' : ' off'}${n ? ` ▶${n}` : ''}${k ? ` ⚑${k}` : ''}`;
    return [full, mid, tiny].find(l => l.length + 2 <= room) || tiny;
  }

  function sideBar(W) {
    const shown = SIDES.filter(visible);
    const room = Math.floor((W - 2) / shown.length);
    const segs = [['', ' ']];
    for (const name of shown) {
      const style = name === ui.side ? acc(name).tab : acc(name).fg;
      segs.push([style, ` ${sideLabel(name, room)} `, undefined, () => { ui.side = name; }, name === ui.side ? style : acc(name).ghost], ['', ' ']);
    }
    return segs;
  }

  function tabBar() {
    const counts = [liveCount(ui.side), history(ui.side).length, needs(ui.side).length];
    const segs = [['', ' ']];
    TABS.forEach((t, i) => hasView(i) && segs.push([i === view() ? acc().view : ST.tabOff, ` ${i + 1} ${t}${counts[i] != null ? ` (${counts[i]})` : ''} `, undefined,
      () => { ui.view[ui.side] = i; }, i === view() ? acc().view : acc().ghost], ['', ' ']));
    return segs;
  }

  // ---- Panes: a block of text given fewer rows than it needs, wrapped and scrolled the same way everywhere ----

  const keyIds = new WeakMap(); // a stable key for an entry object (a Log line, an Activity line)
  let nextKey = 0;
  const keyOf = o => { if (!keyIds.has(o)) keyIds.set(o, ++nextKey); return keyIds.get(o); };
  const wrapCache = new WeakMap(); // src -> { w, hang, lines }: an entry that never changes is wrapped once per width
  const linesOf = (b, w) => {
    if (b.wrap === false) return [b.segs];
    const hit = b.src && wrapCache.get(b.src);
    if (hit && hit.w === w && hit.hang === (b.hang || 0)) return hit.lines;
    const lines = wrapSegs(b.segs, w, b.hang || 0);
    if (b.src) wrapCache.set(b.src, { w, hang: b.hang || 0, lines });
    return lines;
  };
  /** Where a pane is, for its status row. */
  const whereText = st => (st.follow && st.at === null ? `latest ${st.room} of ${st.total} lines · PgUp to scroll back`
    : `lines ${st.top + 1}–${Math.min(st.total, st.top + st.room)} of ${st.total} · ${st.follow ? 'End: latest' : 'PgUp PgDn to scroll'}`);
  /** The view (and what is open over it) a frame was painted for: a pane painted for another is not scrolled. */
  const frontSig = () => `${ui.side}:${view()}:${ui.notes ? 'notes' : ui.keys ? 'keys' : ui.menu ? 'menu' : offerOpen() ? 'offer' : ''}:${ui.det[ui.side]?.view === view() ? 'details' : ''}`;

  /**
   * `blocks` ([{ key, segs, hang, wrap, src, hit }]) in at most `h` rows of `w` columns. `follow`: starts at its latest
   * lines and stays there as lines arrive, until scrolled back. Its place is remembered as the block at its top and
   * the line within it, so new lines, lines trimmed from the start and a resize don't move it. `focus` (a block key):
   * when it changes, the pane scrolls just enough to show that block (`reveal`: at once). `status`: a grey row saying
   * where it is, when the lines don't all fit (`statusTop`: as its first row). `owner`: a different one starts the
   * pane afresh. `front`: the scroll keys go to this pane (`arrows`: ↑ ↓ too).
   */
  function pane(id, blocks, w, h, { follow = false, focus, focusLine, reveal = false, status = true, statusTop = false, main = false, owner, front = false, arrows = false } = {}) {
    let st = ui.panes.get(id);
    if (!st || st.owner !== owner) { st = { at: null, ops: [], top: 0, room: h, total: 0, follow, focus: undefined, painted: false, owner }; ui.panes.set(id, st); }
    if (front) ui.front = { id, arrows, sig: frontSig() };
    const lines = [];
    for (const b of blocks) linesOf(b, w).forEach((row, l) => lines.push({ row, key: b.key, l, hit: b.hit }));
    const total = lines.length;
    const where = status && total > h && h > 1;
    const room = Math.max(1, where ? h - 1 : h);
    const last = Math.max(0, total - room);
    const clamp = n => Math.max(0, Math.min(last, n));
    let top = follow ? last : 0;
    if (st.at) {
      const first = lines.findIndex(x => x.key === st.at.key);
      top = first < 0 ? 0 : first + Math.min(st.at.l, lines.filter(x => x.key === st.at.key).length - 1);
    }
    top = clamp(top);
    const page = Math.max(1, room - 1);
    for (const op of st.ops) top = clamp(top + ({ up: -1, down: 1, pageup: -page, pagedown: page, home: -Infinity, end: Infinity }[op] ?? op));
    st.ops = [];
    if (focus !== undefined && ((focus !== st.focus && st.painted) || reveal)) {
      const first = lines.findIndex(x => x.key === focus);
      if (first >= 0) {
        const end = first + lines.filter(x => x.key === focus).length - 1;
        // `focusLine`: the wrapped line of that block to show (a search match far down a long paragraph); else the whole block.
        const [from, to] = focusLine != null ? [Math.min(end, first + focusLine), Math.min(end, first + focusLine)] : [first, end];
        if (from < top) top = from;
        else if (to >= top + room) top = clamp(Math.min(from, to - room + 1));
      }
    }
    Object.assign(st, { at: (follow ? top >= last : top === 0) ? null : { key: lines[top].key, l: top - lines.findIndex(x => x.key === lines[top].key) },
      top, room, total, follow, focus, painted: true });
    const tagged = row => Object.assign(row, { pane: id, main: Boolean(main) });
    const out = lines.slice(top, top + room).map(x => (x.hit ? Object.assign(tagged(x.row), { hit: x.hit }) : tagged(x.row)));
    if (where) out[statusTop ? 'unshift' : 'push'](tagged([[ST.grey, `  ${whereText(st)}`]]));
    return out;
  }
  /** Queues a scroll on a pane, applied at its next paint: a scroll key's name, or a number of lines. */
  const scrollPane = (id, k) => { ui.panes.get(id)?.ops.push(k); };
  const SCROLL_KEYS = ['pageup', 'pagedown', 'home', 'end'];

  const rowId = r => (r._wait ? `wait:${r.key}` : r.id || r.uid || r.key);
  /** Running's selection: the remembered row where it is now (a review's own row, once it replaces its preparing row), until ↑ ↓ or a click moves it. */
  /** Where the remembered Running row is in `list` now (a review's own row, once it has replaced its preparing row), or -1. */
  function pickedAt(list) {
    const want = ui.picked[ui.side];
    if (!want) return -1;
    const i = list.findIndex(r => rowId(r) === want.id);
    return i < 0 && String(want.id).startsWith('preparing:') ? list.findIndex(r => !r._wait && r.ticket === want.ticket) : i;
  }
  function selectRunning(list) {
    const i = pickedAt(list);
    if (i >= 0) sel()[RUNNING] = i;
    const at = clampSel(RUNNING, list.length);
    ui.picked[ui.side] = { id: rowId(list[at]), ticket: list[at].ticket };
    return at;
  }

  /** A list above, a rule, and a pane of details below: the list keeps up to half the view, the details get what they need of the rest. */
  function withDetails(count, listRows, blocks, W, H, id, owner) {
    const need = blocks.reduce((n, b) => n + linesOf(b, W).length, 0);
    const avail = Math.max(1, H - 1 - Math.min(count, Math.max(1, Math.floor(H / 2))));
    const h = Math.max(Math.min(3, avail), Math.min(need, avail));
    return [...listRows(Math.max(1, H - 1 - h)), rule(W), ...pane(id, blocks, W, h, { owner, front: true })];
  }

  /**
   * A session's Activity under the Running list: its heading (`head`, with where the pane is at its right end when it
   * doesn't all fit), a grey row per PR with a known size (at most 3), then a following pane of its lines, keyed by
   * session and start time so a Builder ticket's next turn starts a fresh one.
   */
  function activity(rows, r, H, W, head) {
    const base = r._activityBase || 0; // lines trimmed from the start: a line's key holds while old lines go
    const blocks = (r._activity || []).map((a, i) => ({ key: base + i, src: a, ...(a.error ? { segs: [[ST.red, `  ${a.text}`]], hang: 2 }
      : a.sub ? { segs: [[ST.grey, '    ↳ '], [ST.grey, a.text]], hang: 6 } : { segs: [[ST.cyan, '  • '], [a.said ? '' : ST.dim, a.text]], hang: 4 }) }));
    const sized = (r.prs || []).filter(p => r.stats?.[p.url]);
    const room = Math.max(0, Math.min(3, H - rows.length - 3)); // never so many that Activity has no row left
    const shownPrs = sized.length > room ? sized.slice(0, Math.max(0, room - 1)) : sized;
    const sizes = room ? [...shownPrs.map(p => { const st = r.stats[p.url]; return [['', '  '], [ST.link, prName(p), p.url], [ST.grey, `  ${shortstat(st)}${st.commits ? ` · ${plural(st.commits, 'commit')}` : ''}`]]; }),
      ...(sized.length > shownPrs.length ? [[[ST.grey, `  and ${plural(sized.length - shownPrs.length, 'more PR')} · the Log has the total`]]] : [])] : [];
    const id = `act:${r.id || r.uid || r.key}:${r.startedAt || r.sessionStartedAt || ''}`;
    const body = blocks.length ? pane(id, blocks, W, Math.max(1, H - rows.length - 2 - sizes.length), { follow: true, status: false, front: true }) : [[[ST.grey, '  starting…']]];
    const st = ui.panes.get(id);
    const where = blocks.length && st.total > st.room ? [[ST.grey, `${whereText(st)} `]] : [];
    return [...rows, rule(W), where.length ? spread(clip(head, Math.max(10, W - width(where) - 1)), where, W) : head, ...sizes, ...body];
  }

  function runningView(W, H) {
    if (ui.edit?.prs) return prsInput(W);
    if (ui.edit?.build) return buildInput(W);
    if (ui.edit?.naming) return nameInput(W);
    if (detOf()?.view === RUNNING) { const open = detailsView(W, H); if (open) return open; }
    if (ui.side === 'builder') return builderRunning(W, H);
    const runs = runningRows();
    if (!runs.length) {
      const n = app.boards().length;
      return [[], [[ST.grey, !isOn('reviewer') ? '  The Reviewer is off: e turns it on.'
        : n ? `  No reviews running. Watching ${plural(n, 'board')} for '${app.cfg.tags.trigger}'.`
          : '  No boards configured yet: press 4 for Config, then a to add one.']]];
    }
    const at = selectRunning(runs);
    const rows = windowed(runs, at, Math.min(runs.length, Math.max(3, Math.floor(H / 3)))).map(({ item: r, i }) => {
      if (r._wait) {
        const n = r.waitingOn?.length || 0;
        const left = [cursor(i === at), [ST.cyan, '◷ '], [ST.bold, `${r.key}  `]];
        const right = [[ST.grey, `  ${r.retry ? 'to retry, when a slot frees' : `waiting on ${plural(n, 'PR')}`} · ${dur(Date.now() - r.since)} `]];
        return onClick(spread([...left, ['', trunc(r.title, W - width(left) - width(right) - 1)]], right, W), pick(RUNNING, i));
      }
      const stopping = r.status === 'stopping';
      const left = [cursor(i === at), [stopping ? ST.red : acc().fg, `${stopping ? '■' : spin()} `], [ST.bold, `${r.ticket}  `]];
      const right = [[ST.grey, r.status === 'preparing' ? `  ${plural(r.prs.length, 'PR')} · preparing${r.quick ? ' · quick' : ''} · ${dur(Date.now() - r.startedAt)} ` : `  ${plural(r.prs.length, 'PR')} · ${r.phase === 'checks' ? 'building and testing' : r.phase === 'publishing' ? 'posting its review' : r.reviewNo > 1 ? `re-review #${r.reviewNo}` : 'first review'} · ${dur(Date.now() - r.startedAt)} `]];
      const title = trunc(stopping ? `stopping… ${r.title}` : r.title, W - width(left) - width(right) - 1);
      return onClick(spread([...left, ['', title]], right, W), pick(RUNNING, i));
    });
    const r = runs[at];
    if (r._wait) {
      const prs = (r.waitingOn || []).map(u => /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(u)).filter(Boolean).map(m => `${m[1]}#${m[2]}`);
      rows.push(rule(W), [[ST.bold, ` Activity · ${r.key}  `], [ST.grey, 'waiting on its PRs']],
        [[ST.cyan, '  • '], ['', r.retry ? 'Its review failed: it is retried once, as soon as a slot frees.'
          : prs.length ? `Re-reviewed once ${prs.join(', ')} ${prs.length > 1 ? 'are' : 'is'} labelled '${askLabel(app.cfg)}' (s stops waiting; labels stay as they are).` : 'Checked each poll.']],
        ...Object.entries(r.letGo || {}).map(([u, why]) => [[ST.grey, `  • ${u.split('/').slice(-3).join('/')}: let go, ${why}`]]),
        ...(r.notes || []).map(n => [[ST.grey, `  • ${n}`]]));
      return rows;
    }
    return activity(rows, r, H, W, [[ST.bold, ` Activity · ${r.ticket}  `], [ST.grey, prsOf(r).map(prName).join('  ')]]);
  }

  // The Reviewer's Running list: its reviews, those being set up, then the quick reviews waiting on their PRs.
  const runningRows = () => [...live('reviewer'), ...settingUp(), ...(reviewer.waits?.() || []).map(wt => Object.assign(wt, { _wait: true }))];

  // Where a Builder ticket stands, in a word or two.
  const STEP_NAMES = { claim: 'claiming', adopt: 'looking for work started', finish: 'checking out its work', read: 'reading the ticket', turn: 'starting a turn', session: 'session running', settle: 'reading the result',
    repos: 'checking out repos', approve: 'approving the plan', publish: 'checking and publishing', round: 'starting a round', 'push-round': 'pushing the round', ci: 'waiting for CI', 'end-round': 'retagging' };
  function workStatus(w) {
    if (w.status === 'needs-you') return [ST.yellow, 'NEEDS YOU'];
    if (w.status === 'active') return [ST.yellow, w.turnKind === 'round' ? `ROUND ${w.rounds}` : w.turnKind === 'finish' ? 'FINISHING' : 'BUILDING'];
    if (w.status === 'following') return w.ready ? [ST.green, 'READY TO MERGE'] : [ST.cyan, w.rounds ? `FOLLOWING · r${w.rounds}` : 'PRS OPEN'];
    if (w.status === 'stopped') return [ST.grey, 'STOPPED'];
    if (w.status === 'done') return [ST.green, w.prs?.length ? 'DONE' : 'ENDED'];
    return [ST.grey, 'ENDED'];
  }

  /** The quick review's input: PRs and tickets to review together. */
  function prsInput(W) {
    const labelled = app.cfg.quickLabels !== false;
    const about = `Paste PR links (https://github.com/owner/repo/pull/12), owner/repo#12 or tickets, separated by spaces or commas. A ticket stands for its open, ready PRs. Prowl reviews them together as one set, the way it reviews a ticket's PRs, and posts a review on each; no tag is written.${labelled ? ` It labels them '${labelNames(app.cfg).inReview}', then '${labelNames(app.cfg).approved}' or '${labelNames(app.cfg).changes}', and re-reviews once they are labelled '${askLabel(app.cfg)}'.` : ''}`;
    return [[], [[ST.bold, '  Quick review: PRs reviewed together']], [],
      [[ST.grey, '  PRs  '], ...editSegs(W - 8)], [],
      ...wrap(about, W - 4, 4).map(l => [[ST.grey, `  ${l}`]]),
      ...(ui.edit.error ? [[], [[ST.red, `  ${ui.edit.error}`]]] : [])];
  }

  /** The quick build's input: a ticket, PRs, or what to build. */
  function buildInput(W) {
    const about = `It starts at once, whether the Builder is on or not. Paste a ticket (with any instructions of your own), PR links, or what to build in your own words. A ticket is picked up where it stands and claimed '${app.cfg.builder.tags.inProgress}'. PRs are worked on as they are; with no ticket, on their GitHub labels. Text alone builds without a ticket, on branches named ${app.cfg.builder.quickBranchTemplate || 'prowl/{slug}'}.`;
    return [[], [[ST.bold, '  Quick build']], [],
      [[ST.grey, '  What  '], ...editSegs(W - 9)], [],
      ...wrap(about, W - 4, 4).map(l => [[ST.grey, `  ${l}`]]),
      ...(ui.edit.error ? [[], [[ST.red, `  ${ui.edit.error}`]]] : [])];
  }

  /** The name box, with Quick names set to ask. */
  function nameInput(W) {
    return [[], [[ST.bold, `  Name this quick ${ui.edit.naming}`]], [], [[ST.grey, '  Name  '], ...editSegs(W - 9)], [],
      [[ST.grey, '  A few words, shown in Running and History. Empty: numbered only.']], ...(ui.edit.error ? [[], [[ST.red, `  ${ui.edit.error}`]]] : [])];
  }

  // ---- The offer: a paste of only tickets, before a quick review or build ----

  const offerOpen = () => ui.offers.length > 0 && !ui.edit && !ui.confirm && !ui.notes && !ui.keys && !ui.menu && !(view() === NEEDS && needs(ui.side).length);
  function offerChoices(o) {
    const it = o.tickets.length > 1 ? 'them' : 'it';
    const tag = o.side === 'builder' ? app.cfg.builder.tags.start : app.cfg.tags.trigger;
    return [
      o.polled ? ['tag', `Tag ${it} '${tag}'`] : ['add', `Add ${o.boards.join(', ')} to the boards and tag ${it}`],
      o.side === 'builder' ? ['build', 'Build it now as a quick build'] : ['review', 'Review it now as a quick review'],
      ['cancel', 'Cancel'],
    ];
  }
  function offerView(W) {
    const o = ui.offers[0];
    const names = o.tickets.map(t => `${t.key} "${t.title}"`).join(', ');
    const where = o.polled ? `on ${o.tickets.length > 1 ? 'boards' : 'a board'} the ${NAMES[o.side]} polls` : `on ${o.boards.join(', ')}, which the ${NAMES[o.side]} doesn't poll yet`;
    const why = o.side === 'builder' ? `Tagged '${app.cfg.builder.tags.start}', the Builder picks ${o.tickets.length > 1 ? 'them' : 'it'} up from the board like any ticket.`
      : `Tagged '${app.cfg.tags.trigger}', the Reviewer reviews ${o.tickets.length > 1 ? 'them' : 'it'} from the board like any ticket, and re-reviews on the next tag.`;
    const choices = offerChoices(o);
    ui.offerAt = Math.max(0, Math.min(ui.offerAt, choices.length - 1));
    return [[], [[`${ST.bold}${acc(o.side).fg}`, `  ${o.side === 'builder' ? 'Quick build' : 'Quick review'} of ${o.tickets.length > 1 ? 'tickets' : 'a ticket'} ${where}`]], [],
      ...wrap(`${names}. ${why}`, W - 4, 4).map(l => [['', `  ${l}`]]), [],
      ...choices.map(([k, label], i) => onClick([cursor(i === ui.offerAt), [i === ui.offerAt ? ST.bold : '', `${i + 1}  ${label}`]], () => chooseOffer(i)))];
  }
  function chooseOffer(i) {
    const o = ui.offers.shift();
    const [choice] = offerChoices(o)[i] || ['cancel'];
    ui.offerAt = 0;
    if (choice === 'cancel') return flash('Cancelled.');
    actions.answerOffer(o, choice).then(
      r => flash(r?.offer ? '' : choice === 'review' || choice === 'build' ? started(r, o.side) : r?.length ? `Tagged ${r.join(', ')}.` : 'Nothing tagged: the Log says why.'),
      e => flash(`Couldn't do that: ${e.message}`));
    return undefined;
  }
  const started = (r, name) => (!r ? 'Dry run: the Log says what would happen.'
    : name === 'builder' ? `Quick build ${r.key} started.` : `Reviewing ${plural(r.prs.length, 'PR')} together as ${r.ticket}.`);
  function offerKey(k) {
    const n = offerChoices(ui.offers[0]).length;
    if (k === 'up' || k === 'down') ui.offerAt = (ui.offerAt + (k === 'up' ? n - 1 : 1)) % n;
    else if (k === 'enter' || k === ' ') chooseOffer(ui.offerAt);
    else if (k === 'esc') chooseOffer(n - 1);
    else if (k.length === 1 && k >= '1' && k <= String(n)) chooseOffer(Number(k) - 1);
    return undefined;
  }

  function builderRunning(W, H) {
    const items = live('builder');
    if (!items.length) {
      const n = app.boards().length;
      return [[], [[ST.grey, !isOn('builder') ? '  The Builder is off: e turns it on (Config, 4, has its settings).'
        : n ? `  Nothing being built. Watching ${plural(n, 'board')} for '${app.cfg.builder.tags.start}'${app.cfg.builder.assignedToMe ? ' on tickets assigned to you' : ''}.`
          : '  No boards configured yet: press 4 for Config, then a to add one.']]];
    }
    const at = selectRunning(items);
    const rows = windowed(items, at, Math.min(items.length, Math.max(3, Math.floor(H / 3)))).map(({ item: w, i }) => {
      const left = [cursor(i === at), [w.stopRequested ? ST.red : acc().fg, `${w.stopRequested ? '■' : spin()} `], [ST.bold, `${w.key}  `], ...(w.quick ? [[ST.cyan, 'quick  ']] : [])];
      const right = [[ST.grey, `  ${w.stopRequested ? 'stopping' : STEP_NAMES[w.step] || 'waiting'} · ${plural(w.turns?.length || 0, 'turn')} · ${spendText(w)} · ${dur(Date.now() - (w.claimedRoundAt || w.claimedAt || w.createdAt))} `]];
      return onClick(spread([...left, ['', trunc(w.title, W - width(left) - width(right) - 1)]], right, W), pick(RUNNING, i));
    });
    const w = items[at];
    return activity(rows, w, H, W, [[ST.bold, ` Activity · ${w.key}  `], [ST.grey, (w.turnKind === 'round' ? w.round?.prs || [] : w.repos || []).map(r => r.repo.split('/')[1]).join('  ')]]);
  }

  function verdict(r) {
    if (r.status === 'failed') return [ST.red, 'FAILED'];
    if (r.status === 'stopped') return [ST.grey, 'STOPPED'];
    const v = String(r.summary?.verdict || 'NO VERDICT').toUpperCase();
    return [v.startsWith('BLOCK') ? ST.red : v.startsWith('REQUEST') ? ST.orange : v.startsWith('APPROVE') ? ST.green : ST.grey, v];
  }

  // PRs given Prowl's stamp with Approve PRs off or on your own PR, flagged on the ticket's latest review until it is reviewed again.
  const waiting = r => (latest().done.get(r.ticket) === r ? awaitingHuman(r, app.cfg.approvals) : []);
  // The review's PRs, plus earlier-approved ones it carried over that still await a human; an old fix's one PR.
  const prsOf = r => (r.pr ? [r.pr] : [...r.prs, ...(r.contextPrs || []).filter(p => waiting(r).includes(p.url))]);

  /** Where an old Fix my PRs fix ended, for History. */
  function fixStatus(f) {
    const sha = f.pushedSha ? ` ${f.pushedSha.slice(0, 7)}` : '';
    if (f.status === 'done') return [ST.green, f.pushedSha ? `pushed${sha}${f.checks ? ` · ${f.checks}` : ''}` : `replied on ${plural(f.replies?.length || 0, 'thread')}`];
    if (f.status === 'failed') return [ST.red, `failed: ${f.error}`];
    return [ST.grey, `${f.status}${f.note ? `: ${f.note}` : ''}`];
  }

  const label = (t, w = 8) => [ST.grey, `  ${t.padEnd(w)}`];

  function fixDetails(f, lw = 8) {
    return [
      f.briefDir ? [label('Brief', lw), [ST.link, f.briefDir, pathToFileURL(f.briefDir).href]] : [label('Brief', lw), [ST.grey, '(none)']],
      [label('Ticket', lw), [ST.link, f.ticketUrl || '', f.ticketUrl]],
      [label('PR', lw), [ST.link, f.pr.url, f.pr.url], [ST.grey, `  ${f.pr.title || ''}`]],
      [label('Status', lw), fixStatus(f), [ST.grey, `${f.costUsd ? `  · $${f.costUsd.toFixed(2)}` : ''}  · Fix my PRs, removed in 2.12.0`]],
    ];
  }

  function details(r, lw = 8) {
    const flagged = waiting(r);
    const prs = prsOf(r);
    const rows = [];
    rows.push(r.status === 'done'
      ? [label('Report', lw), [ST.link, r.reportPath, pathToFileURL(r.reportPath).href]]
      : [label('Report', lw), [ST.grey, '(none)']]);
    rows.push(r.quick ? [label('Ticket', lw), [ST.grey, '(none: a quick review)']] : [label('Ticket', lw), [ST.link, r.ticketUrl, r.ticketUrl]]);
    prs.slice(0, 4).forEach((p, i) => rows.push([label(i ? '' : 'PRs', lw), [ST.link, p.url, p.url],
      ...(flagged.includes(p.url) ? [[ST.yellow, isOwn(p, app.me) ? "  ⚑ needs a teammate's approval" : '  ⚑ needs your approval']] : []), [ST.grey, `  ${p.title}`]]));
    if (prs.length > 4) rows.push([label('', lw), [ST.grey, `+${prs.length - 4} more (o opens all)`]]);
    const how = r.status === 'failed' ? [ST.red, `failed: ${r.error}`]
      : r.status === 'stopped' ? [ST.grey, 'stopped by you']
        : [ST.green, `done in ${dur(r.endedAt - r.startedAt)}${r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ''}`];
    // What it ran on: the reviewers' model and effort, then the verifiers' and the orchestrator's where they have their own.
    const also = (name, x) => (x && (x.model || x.effort) ? ` · ${name} ${[x.model, x.effort && `${x.effort} effort`].filter(Boolean).join(' · ')}` : '');
    const ranOn = modelEffort(r) ? ` · ${modelEffort(r)}${also('verifiers', r.verifiers)}${also('orchestrator', r.orchestrator)}` : '';
    rows.push([label('Status', lw), how, [ST.grey, ranOn], [ST.yellow, r.pendingTag != null ? '  · ticket tag update pending' : '']]);
    const split = breakdown([r]);
    if (split) rows.push([label('Models', lw), [ST.grey, split]]);
    return rows;
  }

  function workDetails(w, lw = 8) {
    const prs = w.prs?.length ? w.prs : (w.repos || []).filter(r => r.pr).map(r => r.pr);
    const rows = [
      [label('Brief', lw), [ST.link, w.briefDir, pathToFileURL(w.briefDir).href]],
      [label('Ticket', lw), [ST.link, w.url || '', w.url]],
      ...prs.slice(0, 4).map((p, i) => [label(i ? '' : 'PRs', lw), [ST.link, p.url, p.url], [ST.grey, `  ${p.title || ''}`]]),
      ...(w.plan ? [[label('Plan', lw), [ST.link, w.plan, pathToFileURL(w.plan).href]]] : []),
    ];
    const turns = w.turns || [];
    const ranOn = [...new Set(turns.filter(t => t.model).map(t => modelEffort(t)))].join(', ') || (turns.length ? 'model not recorded' : '');
    rows.push([label('Status', lw), workStatus(w), [ST.grey, `  · ${spendText(w)}${ranOn ? ` · ${ranOn}` : ''}${w.note ? ` · ${w.note}` : ''}${w.summary ? ` · ${w.summary}` : ''}`]]);
    const split = breakdown(turns.map(t => ({ ...t, costUsd: t.costUnknown ? 0 : t.costUsd })));
    if (split) rows.push([label('Models', lw), [ST.grey, split]]);
    return rows;
  }

  // ---- Details: everything Prowl kept about a review or a build, in tabs, over History's or Running's list ----
  // Each side keeps its own (ui.det[side]): { key, ticket, view, tab, sel: {}, stack: [], status, severity, full,
  // find, findAt }. A row's key is its id (a review; `preparing:<ticket>` while it is set up) or its uid (a build).
  // What they show comes from files Prowl doesn't control, so every paint and key runs inside a try.

  const MARK = `${fg(16)}${bg(229)}`; // a search match: dark text on pale yellow
  const MARK_AT = `${ST.bold}${fg(16)}${bg(226)}`; // …and the one under the cursor
  const SEV_STYLE = { critical: ST.red, high: ST.orange, medium: ST.yellow, low: ST.grey, nit: ST.grey };
  const lab9 = t => [ST.grey, `  ${t.padEnd(9)}`];
  const fileLink = f => [ST.link, f, pathToFileURL(f).href];
  const when = ms => new Date(ms).toLocaleString();
  const detOf = (name = ui.side) => ui.det[name];
  const keepDays = () => (app.cfg.logRetentionDays > 0 ? `: Keep logs deletes session logs after ${plural(app.cfg.logRetentionDays, 'day')}` : '');

  /** Where the details' row is now: { item, where: RUNNING | HISTORY }, or null when it is gone from both lists. */
  function detFind(det, name = ui.side) {
    if (name === 'builder') {
      const w = builder.history().find(x => x.uid === det.key);
      return w ? { item: w, where: live('builder').some(x => x.uid === w.uid) ? RUNNING : HISTORY } : null;
    }
    let r = [...reviewer.running(), ...settingUp()].find(x => x.id === det.key);
    if (!r && String(det.key).startsWith('preparing:')) { // its session started: the review's own row has taken its place
      r = reviewer.running().find(x => x.ticket === det.ticket);
      if (r) det.key = r.id;
    }
    if (r) return { item: r, where: RUNNING };
    r = (name === ui.side ? history('reviewer') : [...reviewer.finished(), ...(reviewer.state.fixes || [])]).find(x => x.id === det.key);
    return r ? { item: r, where: HISTORY } : null;
  }

  function closeDetails(name = ui.side) {
    ui.det[name] = null;
    for (const id of [...ui.panes.keys()]) if (id.startsWith(`det:${name}:`)) ui.panes.delete(id);
    if (!ui.det.reviewer && !ui.det.builder) dropCache(); // a session log can be large
  }

  function openDetails(item) {
    if (item._wait) return flash('It has no session yet: its details open once its review runs.');
    ui.det[ui.side] = { key: item.id || item.uid, ticket: item.ticket || item.key, view: view(), tab: 0, sel: {}, stack: [], status: 0, severity: 0, full: false, find: '', findAt: -1 };
    return undefined;
  }

  /** Each frame: the details follow their row from Running to History and back, and close when it is gone from both. */
  function syncDetails() {
    for (const name of SIDES) {
      const det = ui.det[name];
      if (!det) continue;
      let at;
      try { at = detFind(det, name); } catch { at = null; }
      if (!at) { closeDetails(name); continue; }
      if (at.where === det.view) continue;
      const looking = ui.side === name && ui.view[name] === det.view;
      det.view = at.where;
      if (!looking) continue; // on another view: they are there when you next go to that one
      ui.view[name] = at.where;
      const status = name === 'builder' ? workStatus(at.item)[1] : verdict(at.item)[1];
      flash(at.where === HISTORY ? `${det.ticket} is in History now (${status}): its details moved with it.` : `${det.ticket} is running again: its details are in Running now.`);
    }
  }

  const kindOf = it => (ui.side === 'builder' ? 'build' : it.pr ? 'fix' : it.status === 'preparing' ? 'setup' : 'review');
  const tabsOf = it => ({ build: ['Summary', 'PRs', 'Turns'], fix: ['Summary', ...(it.logPath ? ['Session'] : [])], setup: ['Summary'], review: ['Summary', 'PRs', 'Findings', 'Session'] }[kindOf(it)]);
  const isLive = det => det.view === RUNNING;
  const parkOpts = it => ({ parkHumanOnly: it.parkHumanOnly });
  /** A review's result, or why there is none: { state: 'ok' | 'invalid' | 'missing' | 'none', result }. */
  const resultOf = (it, det) => (it.resultMode && it.resultPath ? readResult(it.resultPath, { live: isLive(det) }) : { state: 'none', result: null });
  function noFindings(it, det, res) {
    if (it.status === 'preparing') return 'Its review is being set up: findings show here once it has run.';
    if (isLive(det)) return "It's still running: its findings show here once its session writes its review result.";
    if (res.state === 'none') return 'This review has no review result, as it ran before Prowl kept findings as data: x opens its report, which has them.';
    if (res.state === 'invalid') return `Its review result isn't a valid review result (${it.resultPath}), so its findings can't be shown: x opens its report.`;
    if (['failed', 'stopped'].includes(it.status)) return 'It ended before writing a review result.';
    return `Its review result is missing (${it.resultPath}).`;
  }

  /** The reviews of a ticket, finished or running, oldest first. */
  const chainOf = it => [...reviewer.state.runs.filter(r => !r.pr)].filter(r => r.ticket === it.ticket).sort((a, b) => a.startedAt - b.startedAt);
  function chainStep(det, it, by) {
    const chain = chainOf(it);
    const to = chain[chain.findIndex(r => r.id === it.id) + by];
    if (!to) return flash(`This is ${it.ticket}'s ${by < 0 ? 'first' : 'latest'} review.`);
    return showReview(det, to);
  }
  /** Another review of the same ticket, on the same tab with the same filters. */
  function showReview(det, to) {
    Object.assign(det, { key: to.id, stack: [], find: '', findAt: -1, sel: {} });
    const at = detFind(det);
    if (at && at.where !== det.view) { det.view = at.where; ui.view[ui.side] = at.where; }
    return undefined;
  }

  // A screen is a document (blocks in a scrolling pane; with choices, ↑ ↓ move between them and enter opens the
  // chosen one) or a list (a row per item, and under a rule the selected item's preview in its own pane).
  function docOf(id, opts = {}) {
    const blocks = [];
    const choices = [];
    const doc = {
      kind: 'doc', id, blocks, choices, ...opts,
      row(name, segs, hang = 11) { blocks.push({ key: blocks.length, segs: [lab9(name), ...segs], hang }); return doc; },
      /** Multi-line text keeps its line breaks, the label on the first line only. */
      text(name, text, style = '') { String(text ?? '').split('\n').forEach((l, i) => doc.row(i ? '' : name, [[style, l]])); return doc; },
      line(segs, hang = 2) { blocks.push({ key: blocks.length, segs, hang }); return doc; },
      blank() { blocks.push({ key: blocks.length, segs: [] }); return doc; },
      choice(segs, open, hang = 3) { blocks.push({ key: blocks.length, segs, hang, choice: choices.length }); choices.push(open); return doc; },
    };
    return doc;
  }
  const para = (id, text) => docOf(id).blank().line([[ST.grey, `  ${text}`]]);
  const linkSegs = (u, text = u) => (webLink(u) ? [[ST.link, text, u]] : [['', String(text ?? '')]]); // a session's URL is a link only when it is a plain https one

  /** A text file in a window: its lines, wrapped. x opens it outside Prowl. */
  function fileScreen(win) {
    const lines = readLines(win.path, { grows: Boolean(win.grows) });
    if (!lines) return Object.assign(para(`file:${win.path}`, `${win.label === 'Prompt' ? 'The prompt is gone' : `${win.path}: gone`}${keepDays()}.`), { file: win.path });
    const doc = docOf(`file:${win.path}`, { file: win.path });
    doc.blocks.push(...lines.map((l, i) => ({ key: i, src: l, segs: [['', `  ${l.line}`]], hang: 2 })));
    return doc;
  }

  /** The Files choices of a Summary: a label column, then the path as a link. One that isn't there says why and can't be opened. */
  function filesInto(doc, det, files) {
    const shown = files.filter(f => f.path);
    if (!shown.length) return doc;
    const w = Math.max(14, ...shown.map(f => f.label.length + 2));
    doc.blank().line([[ST.bold, '  Files']]);
    for (const f of shown) {
      const there = f.tab != null || fs.existsSync(f.path);
      doc.choice([[there ? '' : ST.grey, f.label.padEnd(w)], ...(there ? [fileLink(f.path)] : [[ST.grey, `${f.path}: ${isLive(det) ? 'not written yet' : `gone${keepDays()}`}`]])],
        !there ? null : f.tab != null ? () => { det.tab = f.tab; det.find = ''; } : () => det.stack.push({ type: 'file', label: f.label, path: f.path, grows: f.grows }));
    }
    return doc;
  }

  function reviewSummary(det, it) {
    const doc = docOf('summary');
    const kind = kindOf(it);
    if (kind === 'fix') { for (const segs of fixDetails(it, 9)) doc.blocks.push({ key: doc.blocks.length, segs, hang: 11 }); }
    else if (isLive(det)) {
      doc.row('Report', [[ST.grey, '(when it finishes)']]);
      doc.row('Ticket', it.quick ? [[ST.grey, '(none: a quick review)']] : [[ST.link, it.ticketUrl, it.ticketUrl]]);
      it.prs.forEach((p, i) => doc.row(i ? '' : 'PRs', [[ST.link, p.url, p.url], [ST.grey, `  ${p.title || ''}`]]));
      doc.row('Status', [[ST.yellow, `${liveStatus(it).toLowerCase()} · for ${dur(Date.now() - it.startedAt)}`]]);
    } else for (const segs of details(it, 9)) doc.blocks.push({ key: doc.blocks.length, segs, hang: 11 });
    doc.blank().row('Started', [['', when(it.startedAt || it.createdAt)]]);
    if (!isLive(det) && it.endedAt) doc.row('Ended', [['', when(it.endedAt)]]);
    if (kind !== 'fix') {
      doc.row('Review', [['', it.reviewNo > 1 ? `re-review #${it.reviewNo}` : 'first review']]);
      const chain = chainOf(it);
      if (chain.length > 1) {
        const twice = r => chain.filter(x => x.reviewNo === r.reviewNo).length > 1 && r.status !== 'done';
        doc.row('Chain', [...chain.flatMap((r, i) => [...(i ? [[ST.grey, ' · ']] : []), r.id === it.id ? [ST.bold, `r${r.reviewNo}${twice(r) ? ` ${r.status}` : ''}`]
          : [ST.link, `r${r.reviewNo}${twice(r) ? ` ${r.status}` : ''}`, undefined, () => showReview(det, r)]]), [ST.grey, '   [ ] the review before or after']]);
      }
      const res = kind === 'review' ? resultOf(it, det) : null;
      if (res?.result) {
        const b = res.result.batch || {};
        if (b.goal) doc.text('Goal', b.goal);
        if (b.mergeOrder) doc.text('Merge', b.mergeOrder);
        if (b.complete) doc.text('Complete', b.complete);
        const earlier = (res.result.findings || []).filter(f => String(f.id).startsWith('C-'));
        if (earlier.length) {
          const by = {};
          for (const f of earlier) by[f.status] = (by[f.status] || 0) + 1;
          doc.row('Earlier', [['', `${plural(earlier.length, 'earlier finding')}: ${Object.entries(by).map(([s, n]) => `${n} ${s}`).join(', ')}`]]);
        }
        for (const q of res.result.questions || []) doc.text('Question', typeof q === 'string' ? q : q?.question || q?.text || JSON.stringify(q), ST.yellow);
      } else if (res) doc.row('Findings', [[ST.grey, noFindings(it, det, res)]]);
    }
    const prep = it.prep?.dir ? [['Comments', path.join(it.prep.dir, 'existing-comments.md')], ['Earlier reviews', path.join(it.prep.dir, 'prior-findings.md')],
      ...(it.prep.prs || []).filter(p => p.facts).map(p => [`Facts ${prName(p)}`, p.facts])] : [];
    return filesInto(doc, det, [...(it.resultMode ? [{ label: 'Result', path: it.resultPath }] : []), ...(it.logPath && tabsOf(it).includes('Session') ? [{ label: 'Session', path: it.logPath, tab: tabsOf(it).indexOf('Session') }] : []),
      { label: 'Prompt', path: it.promptPath }, ...prep.map(([label, p]) => ({ label, path: p }))]);
  }

  function buildSummary(det, w) {
    const doc = docOf('summary');
    for (const segs of workDetails(w, 9)) doc.blocks.push({ key: doc.blocks.length, segs, hang: 11 });
    doc.blank().row('Started', [['', when(w.createdAt)]]);
    if (!isLive(det)) doc.row('Ended', [['', when(w.updatedAt || w.createdAt)]]);
    const turns = w.turns || [];
    doc.row('Turns', [['', `${plural(turns.length, 'turn')} · ${plural(w.rounds || 0, 'feedback round')} · the Turns tab has each one's session`]]);
    const dir = w.briefDir || '';
    const there = name => (dir && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : '');
    let rounds = [];
    try { rounds = fs.readdirSync(dir).map(f => /^feedback-(\d+)\.md$/.exec(f)).filter(Boolean).sort((a, b) => a[1] - b[1]); } catch { /* no brief folder */ }
    return filesInto(doc, det, [{ label: 'Brief', path: there('ticket.md') || there('quick.md') }, { label: 'Investigation', path: there('investigation.md') }, { label: 'Plan', path: w.plan && fs.existsSync(w.plan) ? w.plan : there('plan.md') },
      { label: 'Result', path: there('result.json') }, ...rounds.map(m => ({ label: `Round ${Number(m[1])} feedback`, path: path.join(dir, m[0]) }))]);
  }

  /** What a review recorded about a PR without a result: the commit reviewed, and the approval. */
  function runFacts(doc, it, url) {
    const head = it.reviewedHeads?.[url];
    doc.row('Reviewed', head ? [['', 'at '], shaSeg({ url }, head)] : [[ST.grey, 'not reviewed: no head commit']]);
    if (it.approved?.[url]) doc.row('Approved', [[ST.green, 'at '], shaSeg({ url }, it.approved[url], ST.green), ...((it.awaitingHuman || []).includes(url) ? [[ST.yellow, " · Prowl's stamp only: a person's approval is still needed"]] : [])]);
  }
  /** A PR's Checks section: what Prowl built and tested before the review, each step's outcome, and the output as a file to open. */
  function checksInto(doc, det, it, url) {
    const c = (it.checks || []).find(x => x.url === url);
    if (!c) return;
    doc.blank().line([[ST.bold, '  Checks']]);
    if (c.error) { doc.row('Ran', [[ST.red, `couldn't run: ${c.error}`]]); return; }
    doc.row('Ran', [['', 'at '], shaSeg({ url }, c.head), [ST.grey, ', merge base '], shaSeg({ url }, c.mergeBase, ST.grey)]);
    for (const s of c.steps || []) {
      const [style, text] = s.status === 'failed' ? [ST.red, `failed${{ passed: ' (passes at the merge base)', failed: ' (fails at the merge base too)' }[s.atBase] || ''}`]
        : s.status === 'nothing' ? [ST.grey, 'nothing to run'] : s.status === 'skipped' ? [ST.grey, `skipped (${s.after === 'stopped' ? 'stopped' : `${s.after} failed`})`] : [ST.green, 'passed'];
      doc.row('', [['', `${String(s.name).padEnd(10)} `], [style, text], ...(s.status === 'failed' && s.command ? [[ST.grey, `  ${s.command}`]] : [])]);
    }
    if (c.log) {
      const there = fs.existsSync(c.log);
      doc.choice([[there ? '' : ST.grey, 'Output'.padEnd(11)], ...(there ? [fileLink(c.log)] : [[ST.grey, `${c.log}: gone${keepDays()}`]])], there ? () => det.stack.push({ type: 'file', label: 'Checks output', path: c.log }) : null);
    }
  }
  const prTitle = (it, url) => [...(it.prs || []), ...(it.contextPrs || []), ...(it.leftOut || [])].find(p => p.url === url)?.title || '';
  const leftOutWhy = (it, entry) => {
    const said = /^Not reviewed: (.*?)\.?$/.exec(String(entry?.coverage?.unverified || ''))?.[1];
    if (said) return said;
    if ((it.contextPrs || []).some(p => p.url === entry?.url)) return 'context only, unchanged since an earlier review cleared it';
    return (it.leftOut || []).some(p => p.url === entry?.url) ? 'a draft now, or past the round cap' : '';
  };
  const nameOf = url => { const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(String(url)); return m ? `${m[1]}#${m[2]}` : String(url); };
  const findingText = f => [f.id, f.severity, f.status, f.title, f.problem, f.fix, f.location?.path, f.pr].filter(Boolean).join(' ');

  function reviewPrs(det, it) {
    const res = resultOf(it, det);
    const urls = res.result?.prs?.length ? res.result.prs.map(p => p.url) : [...it.prs, ...(it.contextPrs || [])].map(p => p.url);
    const reviewed = new Set(it.prs.map(p => p.url));
    const items = urls.map(url => {
      const entry = res.result?.prs.find(p => p.url === url);
      const counted = res.result ? (res.result.findings || []).filter(f => f.pr === url && isCounted(f, parkOpts(it))) : [];
      const worst = SEVERITIES.find(s => counted.some(f => f.severity === s));
      const verdictSeg = !res.result ? [] : [worst ? [SEV_STYLE[worst], `${worst} · ${counted.length}`.padEnd(18)] : [ST.green, 'none counted'.padEnd(18)]];
      const title = prTitle(it, url);
      return {
        segs: [webLink(url) ? [ST.link, nameOf(url).padEnd(14), url] : ['', nameOf(url).padEnd(14)], ['', ' '], ...verdictSeg, ['', title]], text: [url, title, entry?.summary].filter(Boolean).join(' '), url,
        open: () => det.stack.push({ type: 'pr', url }),
        preview: () => {
          const doc = docOf('preview');
          if (res.result && !reviewed.has(url)) doc.row('Skipped', [[ST.grey, `left out of this review: ${leftOutWhy(it, entry) || 'not part of it'}`]]);
          if (entry?.summary) doc.text('Summary', entry.summary);
          if (entry?.role) doc.text('Role', entry.role);
          if (!entry) doc.line([[ST.grey, `  ${res.result ? 'Not in the review result.' : noFindings(it, det, res)}`]]);
          return doc.blocks;
        },
      };
    });
    return { kind: 'list', id: 'prs', items, empty: 'No PRs.' };
  }

  function prWindow(det, it, win) {
    const res = resultOf(it, det);
    const entry = res.result?.prs.find(p => p.url === win.url);
    const doc = docOf(`pr:${win.url}`, { pr: win.url });
    doc.row('PR', [...linkSegs(win.url), [ST.grey, `  ${prTitle(it, win.url)}`]]);
    if (it.branches?.[win.url]) doc.row('Branch', [branchSeg({ url: win.url }, it.branches[win.url])]);
    if (!entry) { runFacts(doc, it, win.url); checksInto(doc, det, it, win.url); }
    else {
      if (entry.summary) doc.text('Summary', entry.summary);
      if (entry.role) doc.text('Role', entry.role);
      doc.row('Reviewed', entry.reviewedAt ? [['', 'at '], shaSeg({ url: win.url }, entry.reviewedAt)] : [[ST.grey, 'not reviewed: no head commit']]);
      if (entry.coverage?.axes?.length) doc.row('Axes', [['', entry.coverage.axes.join(', ')]]);
      for (const c of entry.coverage?.clean || []) doc.text('Clean', c);
      if (String(entry.coverage?.unverified || '').trim()) doc.text('Gaps', entry.coverage.unverified, ST.yellow);
      (entry.related || []).forEach((x, i) => doc.row(i ? '' : 'Related', [...linkSegs(x?.url), [ST.grey, `  ${x?.shares || ''}`]]));
      (entry.earlierReviews || []).forEach((x, i) => doc.row(i ? '' : 'Earlier', [...linkSegs(x?.url), [ST.grey, `  ${plural((x?.findings || []).length, 'finding')}${x?.unread ? ' · not read in full' : ''}`]]));
      if (entry.conventions?.length) doc.row('Rules', [['', entry.conventions.join(', ')]]);
      prLinks(win.url, it.published).forEach((l, i) => doc.row(i ? '' : 'GitHub', [['', `${l.what}  `], ...(l.url ? [[ST.link, l.url, l.url]] : [])]));
      if (it.approved?.[win.url]) doc.row('Approved', [[ST.green, 'at '], shaSeg({ url: win.url }, it.approved[win.url], ST.green), ...((it.awaitingHuman || []).includes(win.url) ? [[ST.yellow, " · Prowl's stamp only: a person's approval is still needed"]] : [])]);
      checksInto(doc, det, it, win.url);
      const on = findingsFor(res.result, {}, parkOpts(it)).filter(f => f.pr === win.url);
      doc.blank().line([[ST.bold, `  Findings on this PR (${on.length})`]]);
      for (const f of on) doc.choice([[ST.bold, `${f.id}  `], [SEV_STYLE[f.severity] || '', `${f.severity}  `], [ST.grey, `${f.status}  `], ['', f.title]], () => det.stack.push({ type: 'finding', pr: f.pr, id: f.id, from: 'pr' }));
    }
    return doc;
  }

  const statusStyle = (f, it) => (isCounted(f, parkOpts(it)) ? SEV_STYLE[f.severity] || '' : ['fixed', 'answered', 'no-longer-applies'].includes(f.status) && !isParked(f, parkOpts(it)) ? ST.green
    : isParked(f, parkOpts(it)) || f.status === 'deferred' ? ST.cyan : ST.grey);
  const filterStep = (det, which) => () => {
    const list = which === 'status' ? STATUS_FILTERS : SEVERITY_FILTERS;
    det[which] = (det[which] + 1) % list.length;
    det.sel.findings = 0;
    flash(`Findings: ${list[det[which]]}.`);
  };

  function reviewFindings(det, it) {
    const res = resultOf(it, det);
    if (!res.result) return para('findings', noFindings(it, det, res));
    const all = res.result.findings || [];
    const list = findingsFor(res.result, det, parkOpts(it));
    const many = (res.result.prs || []).length > 1;
    const head = [[[ST.grey, '  Showing '], [ST.bold, STATUS_FILTERS[det.status], undefined, filterStep(det, 'status')], [ST.grey, ' · '], [ST.bold, SEVERITY_FILTERS[det.severity], undefined, filterStep(det, 'severity')],
      [ST.grey, ` · ${list.length} of ${plural(all.length, 'finding')}   s status · v severity`]]];
    const items = list.map(f => ({
      segs: [[ST.bold, String(f.id).padEnd(6)], [SEV_STYLE[f.severity] || '', String(f.severity).padEnd(10)], [statusStyle(f, it), (isParked(f, parkOpts(it)) ? `${f.status} · parked` : String(f.status)).padEnd(20)],
        ...(many ? [[ST.grey, nameOf(f.pr).padEnd(14)]] : []), ['', f.title]],
      text: findingText(f), finding: f,
      open: () => det.stack.push({ type: 'finding', pr: f.pr, id: f.id, from: 'tab' }),
      preview: () => docOf('preview').row('Where', [['', f.location?.path ? `${f.location.path}${f.location.line ? `:${f.location.line}` : ''}` : 'no single place']]).text('Problem', f.problem).text('Fix', f.fix).blocks,
    }));
    return { kind: 'list', id: 'findings', head, items, empty: all.length ? 'No finding matches these filters: s and v change them.' : 'The review found nothing.' };
  }

  /** The findings a finding's window steps through: the Findings tab with its filters, or one PR's. */
  const siblings = (det, it, win, result) => (win.from === 'pr' ? findingsFor(result, {}, parkOpts(it)).filter(f => f.pr === win.pr) : findingsFor(result, det, parkOpts(it)));

  function findingWindow(det, it, win) {
    const res = resultOf(it, det);
    const list = res.result ? siblings(det, it, win, res.result) : [];
    const now = list.find(f => f.pr === win.pr && f.id === win.id);
    if (now) win.was = now; // the window holds the finding's PR and id, not a copy: a result rewritten while it is open updates it
    const f = now || win.was;
    const doc = docOf(`finding:${win.pr}:${win.id}`, { finding: f, result: res.result, pr: f?.pr });
    if (!f) return doc.blank().line([[ST.grey, "  The review result doesn't list this finding now."]]);
    win.at = now ? [list.indexOf(now) + 1, list.length] : null;
    if (!now) doc.line([[ST.yellow, "  As it was when opened: the review result, or the filters, don't list it now."]]).blank();
    const o = parkOpts(it);
    doc.line([[ST.bold, `  ${f.id}  `], [`${ST.bold}${SEV_STYLE[f.severity] || ''}`, String(f.severity).toUpperCase()], [statusStyle(f, it), `  ${f.status}`], [ST.grey, `${f.axis ? `  · ${f.axis}` : ''}  · ${isCounted(f, o) ? 'counts toward the verdict' : isParked(f, o) ? 'parked' : "doesn't count toward the verdict"}`]]);
    doc.line([[ST.bold, `  ${f.title}`]]).blank();
    doc.row('PR', linkSegs(f.pr));
    const at = findingUrl(f, res.result);
    const where = f.location?.path ? `${f.location.path}${f.location.line ? `:${f.location.startLine && f.location.startLine < f.location.line ? `${f.location.startLine}-` : ''}${f.location.line}` : ''}` : 'no single place';
    doc.row('Where', [at ? [ST.link, where, at] : ['', where], ...(at ? [[ST.grey, '  · o opens it at the reviewed commit']] : [])]);
    doc.text('Problem', f.problem).text('Fix', f.fix).blank();
    const d = f.detail || {};
    for (const [name, v] of [['Why', d.explanation], ['Scenario', d.scenario], ['Steps', d.fixDetail], ['Check', d.check], ['Verified', d.verification]]) if (String(v || '').trim()) doc.text(name, v);
    if (d.quote?.code) { doc.row('Code', [[ST.grey, d.quote.language || '']]); for (const l of String(d.quote.code).split('\n')) doc.line([[ST.dim, `      ${l}`]], 6); }
    if (f.crossPr) doc.row('Cross-PR', [['', `with ${f.crossPr.counterpart || 'another PR'}; the fix belongs in ${f.crossPr.fixBelongsTo || f.pr}`], [ST.grey, f.crossPr.why ? `  ${f.crossPr.why}` : '']]);
    if (f.consumer) doc.row('Consumer', [['', `outside the batch: ${f.consumer.repo || ''} ${f.consumer.path || ''}`]]);
    if (f.earlier) {
      const e = f.earlier;
      doc.row('Earlier', [['', `${e.by === 'prowl' ? 'PR-Owl' : e.author || 'someone else'}${e.ref ? `, ${e.ref}` : ''} · thread ${e.threadState || 'none'}${e.parked ? ' · parked' : ''}  `], ...(webLink(e.url) ? [[ST.link, e.url, e.url]] : [])]);
    }
    if (f.outcome && (f.outcome.commit || f.outcome.note || f.outcome.answer || f.outcome.disputeHolds != null)) {
      const out = f.outcome;
      doc.row('Outcome', [['', [out.commit && `in ${String(out.commit).slice(0, 7)}`, out.note, out.disputeHolds != null && `the dispute ${out.disputeHolds ? 'holds' : "doesn't hold"}`].filter(Boolean).join(' · ')],
        ...(out.answer ? [['', '  '], ...linkSegs(out.answer)] : [])]);
    }
    findingLinks(f, it.published).forEach((l, i) => doc.row(i ? '' : 'GitHub', [['', `${l.what}  `], ...(l.url ? [[ST.link, l.url, l.url]] : [])]));
    return doc;
  }

  const entryBlocks = new WeakMap(); // a log entry -> its blocks, as Activity lines and in full
  /** A session's log as a document: the lines Running's Activity shows, or (l) the session in full. */
  function sessionScreen(det, it, logPath, id, live, review = true) {
    const scr = docOf(id, { session: true, log: logPath, follow: live });
    if (!logPath) return Object.assign(para(id, 'No session log was kept for this one.'), { session: true });
    const log = readLog(logPath);
    if (!log) {
      return Object.assign(para(id, live ? "The session hasn't started yet: its lines show here as it runs."
        : `The session log gone${keepDays()}.${review ? ' The report and findings are kept.' : ''}`), { session: true, log: logPath, follow: live });
    }
    if (log.result) {
      const r = log.result;
      scr.line([[ST.grey, `  ${[r.subtype && r.subtype !== 'success' ? r.subtype : '', `$${Number(r.total_cost_usd || 0).toFixed(2)}`, log.results === 1 && r.duration_ms ? dur(r.duration_ms) : '', log.results > 1 ? `${log.results} turns` : ''].filter(Boolean).join(' · ')}`]]);
    }
    for (const e of log.entries) {
      let made = entryBlocks.get(e);
      if (!made) {
        const lite = e.kind === 'output' ? null : { src: e, ...(e.kind === 'error' ? { segs: [[ST.red, `  ${e.text}`]], hang: 2 }
          : e.sub ? { segs: [[ST.grey, '    ↳ '], [ST.grey, e.text]], hang: 6 } : { segs: [[ST.cyan, '  • '], [e.kind === 'said' ? '' : ST.dim, e.text]], hang: 4 }) };
        const lines = String(e.full).split('\n');
        const style = e.kind === 'error' || e.error ? ST.red : e.kind === 'said' ? '' : e.kind === 'tool' ? ST.dim : ST.grey;
        const full = [...lines.map((l, i) => ({ src: {}, segs: e.kind === 'tool' && i === 0 ? [[ST.cyan, e.sub ? '    ▸ ' : '  ▸ '], [ST.bold, l]] : [[style, `${e.sub ? '      ' : '    '}${l}`]], hang: e.sub ? 6 : 4 })),
          ...(e.kind === 'said' || e.kind === 'output' ? [{ src: {}, segs: [] }] : [])];
        made = { lite, full };
        entryBlocks.set(e, made);
      }
      if (det.full) scr.blocks.push(...made.full);
      else if (made.lite) scr.blocks.push(made.lite);
    }
    scr.blocks.forEach((b, i) => { b.key = i; });
    if (!log.entries.length) scr.line([[ST.grey, '  starting…']]);
    return scr;
  }

  function buildPrs(det, w) {
    const prs = w.prs?.length ? w.prs : (w.repos || []).filter(r => r.pr).map(r => r.pr);
    const facts = p => {
      const repo = (w.repos || []).find(r => r.pr?.url === p.url || r.repo === p.repo);
      const doc = docOf(`pr:${p.url}`, { pr: p.url });
      doc.row('PR', [[ST.link, p.url, p.url]]).row('Title', [['', p.title || '']]);
      const branch = repo?.branch || w.branches?.[p.url] || p.branch; // the repo's branch, else the PR's own (one it picked up, or only follows)
      const pushed = w.lastPushed?.[p.url] || repo?.pushedSha; // the last commit Prowl pushed to it, whichever turn pushed it
      if (branch) doc.row('Branch', [branchSeg(p, branch), ...(pushed ? [[ST.grey, '  · pushed '], shaSeg(p, pushed)] : [])]);
      else if (pushed) doc.row('Pushed', [shaSeg(p, pushed)]);
      if (repo?.worktree) doc.row('Worktree', [fileLink(repo.worktree)]);
      return doc;
    };
    const items = prs.map(p => ({ segs: [[ST.link, prName(p).padEnd(14), p.url], [p.state && p.state !== 'open' ? ST.grey : ST.green, String(p.state || 'open').toLowerCase().padEnd(8)], ['', p.title || '']],
      text: [p.url, p.title].filter(Boolean).join(' '), url: p.url, open: () => det.stack.push({ type: 'buildPr', url: p.url }), preview: () => facts(p).blocks, facts: () => facts(p) }));
    return { kind: 'list', id: 'prs', items, empty: 'No PRs yet.' };
  }

  const turnPrompt = t => (t.logPath ? t.logPath.replace(/\.ndjson$/, '.prompt.md') : '');
  function buildTurns(det, w) {
    const turns = w.turns || [];
    const items = turns.map((t, i) => {
      const n = t.n || i + 1;
      const running = isLive(det) && i === turns.length - 1 && !t.endedAt && w.step === 'session';
      const gone = t.logPath && !fs.existsSync(t.logPath);
      const cost = running ? '' : t.costUnknown ? 'cost not reported' : `$${Number(t.costUsd || 0).toFixed(2)}`;
      const model = running ? 'running now' : t.model ? `${t.model}${t.effort ? ` · ${t.effort} effort` : ''}` : t.costUsd || t.costUnknown ? '' : 'not recorded';
      return {
        segs: [[ST.bold, `turn ${n}`.padEnd(9)], [ST.grey, `${stamp(t.startedAt)}  `], ['', cost.padEnd(18)], [ST.grey, (t.endedAt ? dur(t.endedAt - t.startedAt) : '').padEnd(10)], [running ? ST.yellow : ST.grey, model.padEnd(32)], ['', t.kind || ''],
          ...(gone ? [[ST.grey, ' · log gone']] : [])],
        text: [`t${n}`, t.model, t.effort, t.kind].filter(Boolean).join(' '), turn: t,
        open: () => det.stack.push({ type: 'turn', n }),
        preview: () => {
          const doc = docOf('preview');
          doc.row('Session', t.logPath ? (gone ? [[ST.grey, `${t.logPath}: gone${keepDays()}`]] : [fileLink(t.logPath)]) : [[ST.grey, 'No session log was kept for this one.']]);
          const said = !gone && t.logPath ? (readLog(t.logPath)?.entries || []).filter(e => e.kind === 'said' && !e.sub).at(-1) : null;
          if (said) doc.row('Said', [['', said.text]]);
          return doc.blocks;
        },
      };
    });
    return { kind: 'list', id: 'turns', items, empty: 'No turns yet.' };
  }

  /** The screen in front: the window on top of the stack, else the tab's. */
  function frontScreen(det, it) {
    const win = det.stack.at(-1);
    const build = kindOf(it) === 'build';
    if (win?.type === 'file') return fileScreen(win);
    if (win?.type === 'pr') return prWindow(det, it, win);
    if (win?.type === 'finding') return findingWindow(det, it, win);
    if (win?.type === 'buildPr') return buildPrs(det, it).items.find(x => x.url === win.url)?.facts() || para('pr', 'That PR is gone.');
    if (win?.type === 'turn') {
      const t = (it.turns || []).find((x, i) => (x.n || i + 1) === win.n);
      const last = (it.turns || []).at(-1) === t;
      return Object.assign(sessionScreen(det, it, t?.logPath, `turn:${win.n}`, isLive(det) && last && !t?.endedAt, false), { prompt: t ? turnPrompt(t) : '' });
    }
    const tab = tabsOf(it)[det.tab];
    if (tab === 'Summary') return build ? buildSummary(det, it) : reviewSummary(det, it);
    if (tab === 'PRs') return build ? buildPrs(det, it) : reviewPrs(det, it);
    if (tab === 'Findings') return reviewFindings(det, it);
    if (tab === 'Turns') return buildTurns(det, it);
    return Object.assign(sessionScreen(det, it, it.logPath, 'session', isLive(det), true), { prompt: it.promptPath });
  }
  const winName = win => (win.type === 'file' ? win.label : win.type === 'pr' || win.type === 'buildPr' ? nameOf(win.url) : win.type === 'finding' ? win.id : `turn ${win.n}`);
  const liveStatus = it => (ui.side === 'builder' ? (it.stopRequested ? 'STOPPING' : (STEP_NAMES[it.step] || 'waiting').toUpperCase())
    : it.status === 'preparing' ? 'BEING SET UP' : it.status === 'stopping' ? 'STOPPING' : it.phase === 'checks' ? 'BUILDING AND TESTING' : it.phase === 'publishing' ? 'POSTING ITS REVIEW' : 'REVIEWING');

  /** `blocks` with every match of `find` highlighted, the one at `current` brighter: { blocks, matches: [block key] }. Matching spans the pieces of one row. */
  function markBlocks(det, scr, find, current) {
    const [first, last] = [scr.blocks[0], scr.blocks.at(-1)];
    const memo = det._marks;
    if (memo && memo.id === scr.id && memo.find === find && memo.current === current && memo.n === scr.blocks.length && memo.first === first?.src && memo.last === last?.src && (first?.src || !scr.blocks.length)) return memo.out;
    const needle = find.toLowerCase();
    const matches = [];
    const blocks = scr.blocks.map(b => {
      const text = b.segs.map(s => clean(s[1])).join('').toLowerCase();
      const spans = [];
      for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) spans.push([i, i + needle.length, matches.push(b.key) - 1]);
      if (!spans.length) return b;
      const segs = [];
      let at = 0;
      for (const s of b.segs) {
        const t = clean(s[1]);
        let from = 0;
        for (const [a, z, n] of spans) {
          const [x, y] = [Math.max(a - at, from), Math.min(z - at, t.length)];
          if (y <= x) continue;
          if (x > from) segs.push([s[0], t.slice(from, x), ...s.slice(2)]);
          segs.push([n === current ? MARK_AT : MARK, t.slice(x, y), ...s.slice(2)]);
          from = y;
        }
        if (from < t.length) segs.push([s[0], t.slice(from), ...s.slice(2)]);
        at += t.length;
      }
      return { ...b, segs, src: undefined };
    });
    const out = { blocks, matches };
    det._marks = { id: scr.id, find, current, n: scr.blocks.length, first: first?.src, last: last?.src, out };
    return out;
  }

  /** The details' rows, or null when they can't be shown (they close, and the list behind shows). */
  function detailsView(W, H) {
    const det = detOf();
    try {
      const at = detFind(det);
      if (!at) { closeDetails(); return null; }
      const it = at.item;
      const tabs = tabsOf(it);
      det.tab = Math.min(det.tab, tabs.length - 1);
      const scr = frontScreen(det, it);
      const build = kindOf(it) === 'build';
      // Row 1: back, the ticket, the status, the title, and the chain of the ticket's reviews.
      const [stStyle, stText] = isLive(det) ? [ST.yellow, liveStatus(it)] : build ? workStatus(it) : it.pr ? fixStatus(it) : verdict(it);
      const chain = build || it.pr ? [] : chainOf(it);
      const right = chain.length > 1 ? [[ST.grey, '‹ ', undefined, () => chainStep(det, it, -1)], ['', `[ review ${chain.findIndex(r => r.id === it.id) + 1} of ${chain.length} ]`], [ST.grey, ' › ', undefined, () => chainStep(det, it, 1)]] : [];
      const ticketUrl = build ? it.url : it.ticketUrl;
      const left = [[acc().key, ' ❮ back ', undefined, () => onKey('esc'), acc().keyHover], ['', '  '], [ST.bold, det.ticket, ticketUrl || undefined], ['', '  '], [`${ST.bold}${stStyle}`, String(stText).toUpperCase()], ['', '  ']];
      const out = [spread([...left, ['', trunc(it.title, Math.max(0, W - width(left) - width(right) - 1))]], right, W)];
      // Row 2: the tabs.
      const counts = { PRs: build ? (it.prs?.length ?? 0) : (resultOf(it, det).result?.prs?.length ?? it.prs?.length ?? 0), Findings: resultOf(it, det).result?.findings?.length, Turns: it.turns?.length };
      out.push(tabs.flatMap((name, i) => [[i === det.tab ? `${ST.bold}${acc().fg}` : ST.grey, `  ${name}${counts[name] != null && !(name === 'Findings' && build) ? ` (${counts[name]})` : ''} `, undefined, () => { Object.assign(det, { tab: i, stack: [], find: '', findAt: -1 }); }]]));
      // Row 3, while a window is open: where it is, and how to get back.
      if (det.stack.length) {
        const crumbs = [[ST.grey, `  ${tabs[det.tab]}`, undefined, () => { det.stack = []; det.find = ''; }], ...det.stack.flatMap((win, i) => [[ST.grey, ' › '],
          i === det.stack.length - 1 ? [ST.bold, winName(win)] : [ST.grey, winName(win), undefined, () => { det.stack.length = i + 1; det.find = ''; }]])];
        const win = det.stack.at(-1);
        out.push(spread(crumbs, [[ST.grey, `${win.type === 'finding' && win.at && win.at[1] > 1 ? `${win.at[0]} of ${win.at[1]} · ← → ` : ''}esc back `]], W));
      }
      // The body: a document, or a list with the selected item's preview.
      const find = det.find;
      let body;
      let counted = null; // [the match in front (1-based, 0 for none), how many]
      const id = `det:${ui.side}:${scr.id}`;
      const searchRow = () => (ui.edit?.find ? [[[ST.grey, '  Find  '], ...editSegs(W - 10)]]
        : find ? [[['', '  '], [MARK, ` ${find} `], [ST.grey, counted[1] ? `  ${counted[0] || '-'} of ${counted[1] === 1 ? '1 match' : `${counted[1]} matches`} · n N next and previous · esc clears` : '  no match · esc clears']]] : []);
      const bodyH = () => Math.max(1, H - out.length - 1 - (ui.edit?.find || find ? 1 : 0));
      if (scr.kind === 'doc') {
        const chosen = scr.choices.length ? Math.max(0, Math.min(det.sel[scr.id] ?? 0, scr.choices.length - 1)) : -1;
        if (chosen >= 0) det.sel[scr.id] = chosen;
        const withChoices = scr.choices.length ? { ...scr, blocks: scr.blocks.map(b => (b.choice == null ? b : { ...b, segs: [b.choice === chosen ? [acc().fg, ' ❯ '] : ['', '   '], ...b.segs],
          hit: () => { if (det.sel[scr.id] === b.choice) scr.choices[b.choice]?.(); else det.sel[scr.id] = b.choice; } })) } : scr;
        const marked = find ? markBlocks(det, withChoices, find, det.findAt) : { blocks: withChoices.blocks, matches: [] };
        det._matches = marked.matches.length;
        if (find && det.findAt >= marked.matches.length) det.findAt = marked.matches.length - 1;
        counted = [det.findAt + 1, marked.matches.length];
        const focus = find && det.findAt >= 0 ? `m${det.findAt}:${marked.matches[det.findAt]}` : chosen >= 0 ? `c${chosen}` : undefined;
        const focusKey = find && det.findAt >= 0 ? marked.matches[det.findAt] : chosen >= 0 ? scr.blocks.find(b => b.choice === chosen)?.key : undefined;
        // The pane is told which block to keep in view; a new match or choice scrolls to it.
        const st = ui.panes.get(id);
        const reveal = Boolean(st) && st.wants !== focus && focus !== undefined;
        // The wrapped line the match in front is on, within its block.
        const hit = find && det.findAt >= 0 ? marked.blocks.find(b => b.key === focusKey) : null;
        const focusLine = hit ? Math.max(0, linesOf(hit, W).findIndex(l => l.some(seg => seg[0] === MARK_AT))) : undefined;
        body = pane(id, marked.blocks, W, bodyH(), { follow: Boolean(scr.follow) && !find, front: true, arrows: !scr.choices.length, focus: focusKey, focusLine, reveal });
        ui.panes.get(id).wants = focus;
      } else {
        const items = scr.items;
        const sel = Math.max(0, Math.min(det.sel[scr.id] ?? 0, items.length - 1));
        det.sel[scr.id] = sel;
        const hits = find ? items.map((x, i) => (x.text.toLowerCase().includes(find.toLowerCase()) ? i : -1)).filter(i => i >= 0) : [];
        det._matches = hits.length;
        counted = [hits.indexOf(sel) + 1, hits.length];
        const head = scr.head || [];
        if (!items.length) body = [...head, [], [[ST.grey, `  ${scr.empty}`]]];
        else {
          const rowsOf = h => windowed(items, sel, h).map(({ item: x, i }) => onClick([cursor(i === sel), [ST.yellow, hits.includes(i) ? '• ' : '  '], ...x.segs], () => { if (det.sel[scr.id] === i) x.open?.(); else det.sel[scr.id] = i; }));
          const blocks = items[sel].preview().map((b, k) => ({ ...b, key: k }));
          body = [...head, ...withDetails(items.length, rowsOf, blocks, W, bodyH() - head.length, `${id}:preview`, `${scr.id}:${sel}`)];
        }
      }
      out.push(...searchRow(), rule(W), ...body);
      det.screen = scr.kind === 'doc' ? (scr.session ? 'session' : scr.choices.length ? 'choices' : 'doc') : scr.id;
      return out;
    } catch (e) {
      closeDetails();
      flash(`Can't show those details: ${e.message}`);
      return null;
    }
  }

  /** A key while the details are open. True when it was theirs (used up, even when it failed); false leaves it to Prowl. */
  function detailKey(k, det) {
    if (['tab', 'R', 'B', 'q', 'e', 'r', '/', 'ctrl-c'].includes(k) || (k.length === 1 && k >= '1' && k <= '9') || (k === 'n' && !det.find)) return false;
    try {
      const at = detFind(det);
      if (!at) { closeDetails(); return true; }
      const it = at.item;
      const scr = frontScreen(det, it);
      const win = det.stack.at(-1);
      const id = `det:${ui.side}:${scr.id}`;
      const clearFind = () => { det.find = ''; det.findAt = -1; };
      if (k === 'esc') { if (det.find) clearFind(); else if (det.stack.length) det.stack.pop(); else closeDetails(); return true; }
      if (k === 'left' || k === 'right') {
        const by = k === 'right' ? 1 : -1;
        if (win?.type === 'finding') {
          const list = siblings(det, it, win, resultOf(it, det).result);
          const i = list.findIndex(f => f.pr === win.pr && f.id === win.id);
          if (list.length) { const to = list[(Math.max(i, 0) + by + list.length) % list.length]; Object.assign(win, { pr: to.pr, id: to.id, was: to }); clearFind(); }
        } else if (!win) { const n = tabsOf(it).length; det.tab = (det.tab + by + n) % n; clearFind(); }
        return true;
      }
      const items = scr.kind === 'list' ? scr.items : null;
      if (k === 'up' || k === 'down') {
        const by = k === 'down' ? 1 : -1;
        if (items) det.sel[scr.id] = Math.max(0, Math.min((det.sel[scr.id] ?? 0) + by, items.length - 1));
        else if (scr.choices.length) det.sel[scr.id] = Math.max(0, Math.min((det.sel[scr.id] ?? 0) + by, scr.choices.length - 1));
        else scrollPane(id, k);
        return true;
      }
      if (SCROLL_KEYS.includes(k)) { scrollPane(items ? `${id}:preview` : id, k); return true; }
      if (k === 'enter') {
        const open = items ? items[det.sel[scr.id] ?? 0]?.open : scr.choices[det.sel[scr.id] ?? 0];
        if (open) { open(); clearFind(); }
        return true;
      }
      if (k === 'f') {
        startEdit(det.find, v => { det.find = v.trim(); det.findAt = det.find ? 0 : -1; if (det.find && items) nextMatch(det, scr, 0); return ''; });
        ui.edit.find = true;
        return true;
      }
      if ((k === 'n' || k === 'N') && det.find) { nextMatch(det, scr, k === 'n' ? 1 : -1); return true; }
      if (scr.id === 'findings' && items && (k === 's' || k === 'v')) { filterStep(det, k === 's' ? 'status' : 'severity')(); return true; }
      if (k === 's') { if (isLive(det)) (ui.side === 'builder' ? builderKey : reviewerKey)('s', it); return true; }
      if (k === 'l' && scr.session) { det.full = !det.full; clearFind(); flash(det.full ? 'The session in full: what was said, and each tool with its input and output.' : 'The session as Activity lines.'); return true; }
      if (k === 'p') {
        const turn = items && scr.id === 'turns' ? items[det.sel.turns ?? 0]?.turn : null;
        const file = turn ? turnPrompt(turn) : scr.prompt ?? (kindOf(it) === 'build' ? '' : it.promptPath);
        if (file) { det.stack.push({ type: 'file', label: 'Prompt', path: file }); clearFind(); }
        return true;
      }
      if (k === '[' || k === ']') { if (kindOf(it) === 'review') chainStep(det, it, k === '[' ? -1 : 1); return true; }
      const prs = kindOf(it) === 'build' ? (it.prs?.length ? it.prs : (it.repos || []).filter(r => r.pr).map(r => r.pr)) : prsOf(it);
      if (k === 'o') {
        const target = scr.finding ? findingUrl(scr.finding, scr.result) || scr.finding.pr : scr.pr || (items && ['prs'].includes(scr.id) ? items[det.sel[scr.id] ?? 0]?.url : '');
        if (!target) prs.forEach(p => openIt(p.url));
        else if (webLink(target)) openIt(target);
        else flash("That isn't a web link, so Prowl won't open it.");
        return true;
      }
      if (k === 'x') {
        const target = scr.file || (scr.session && scr.log && fs.existsSync(scr.log) ? scr.log : '')
          || (kindOf(it) === 'build' ? (it.plan && fs.existsSync(it.plan) ? it.plan : it.briefDir) : it.status === 'done' && it.reportPath ? it.reportPath : it.pr ? it.briefDir : '');
        if (target) openIt(target); else flash('Nothing to open outside Prowl here.');
        return true;
      }
      if (k === 'a') { const url = kindOf(it) === 'build' ? it.url : it.ticketUrl; if (url) openIt(url); return true; }
      return true; // every other key is the details' while they are open: nothing behind them acts
    } catch (e) {
      closeDetails();
      flash(`Can't show those details: ${e.message}`);
      return true;
    }
  }

  /** The next (or previous) match: in a document, the match in front; in a list, the next matching item from the selected one on. */
  function nextMatch(det, scr, by) {
    if (scr.kind === 'list') {
      const hits = scr.items.map((x, i) => (x.text.toLowerCase().includes(det.find.toLowerCase()) ? i : -1)).filter(i => i >= 0);
      if (!hits.length) return;
      const sel = det.sel[scr.id] ?? 0;
      const to = by === 0 ? hits.find(i => i >= sel) ?? hits[0] : by > 0 ? hits.find(i => i > sel) ?? hits[0] : [...hits].reverse().find(i => i < sel) ?? hits.at(-1);
      det.sel[scr.id] = to;
      return;
    }
    const n = det._matches || 0;
    if (n) det.findAt = (Math.max(det.findAt, by > 0 ? -1 : 0) + by + n) % n;
  }

  /** The keys bar while the details are open: the keys that apply to the screen in front. */
  function detailKeys(det) {
    const s = det.screen;
    const live = isLive(det);
    return [...(s === 'findings' ? [['s', 'status'], ['v', 'severity']] : []), ...(s === 'doc' || s === 'session' ? [] : [['enter', 'open']]), ...(s === 'session' ? [['l', det.full ? 'activity' : 'in full']] : []),
      ...(ui.side === 'reviewer' || s === 'session' || s === 'turns' ? [['p', 'prompt']] : []), ['f', 'find'], ...(det.find ? [['n N', 'matches']] : []),
      ...(ui.side === 'reviewer' ? [['[ ]', 'reviews']] : []), ['o', 'GitHub'], ['x', 'open outside'], ['a', 'ticket'], ...(live && s !== 'findings' ? [['s', 'stop']] : []), ['esc', 'back']];
  }

  function historyView(W, H) {
    if (detOf()?.view === HISTORY) { const open = detailsView(W, H); if (open) return open; }
    const runs = history(ui.side);
    if (!runs.length) return [[], [[ST.grey, ui.side === 'builder' ? '  Nothing built yet.' : '  No finished reviews yet.']]];
    const at = clampSel(HISTORY, runs.length);
    const it = runs[at];
    const detail = ui.side === 'builder' ? workDetails(it) : it.pr ? fixDetails(it) : details(it);
    const list = h => windowed(runs, at, h).map(({ item: r, i }) => {
      if (ui.side === 'builder') {
        const prs = r.prs?.length || 0;
        const head = [cursor(i === at), [ST.grey, `${stamp(r.updatedAt || r.createdAt)}  `], [ST.bold, r.key.padEnd(11)], [workStatus(r)[0], workStatus(r)[1].padEnd(18)],
          [ST.grey, `${r.quick ? 'quick · ' : ''}${prs ? `${plural(prs, 'PR')} · ` : ''}${spendText(r)}  `]];
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
        [ST.grey, `${r.reviewNo > 1 || Number(s.fixed) > 0 ? `· fixed ${s.fixed ?? '?'} ` : ''}${r.reviewNo > 1 ? `· re-review #${r.reviewNo}` : ''}  `],
        ...(waiting(r).length ? [[ST.yellow, `⚑ ${plural(waiting(r).length, 'PR')} to approve  `]] : []),
        ...(reviewer.state.capped?.[r.ticket] && latest().any.get(r.ticket) === r ? [[ST.yellow, '⚑ round cap reached  ']] : []),
      ];
      return onClick([...head, ['', trunc(r.title, W - width(head))]], pick(HISTORY, i));
    });
    // The details wrap under their value column, in a pane of their own: a new selection starts at its top.
    return withDetails(runs.length, list, detail.map((segs, k) => ({ key: k, segs, hang: 10 })), W, H, 'details', `${ui.side}:${it.id || it.uid || at}`);
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
    if (f.type === 'enum' && !f.values.includes(getPath(c, f.key))) return `${getPath(c, f.key)} (not in the list)`; // typed by hand
    if (f.names) return f.names[getPath(c, f.key)] || String(getPath(c, f.key));
    // On Jira a tag is a label, written without colons and with dashes for spaces: shown beside the saved name.
    if (f.tag && JIRA(c) && jiraLabel(String(getPath(c, f.key))) !== String(getPath(c, f.key))) return `${getPath(c, f.key)}  (written ${jiraLabel(String(getPath(c, f.key)))})`;
    return String(getPath(c, f.key));
  }

  // ---- Needs you: each item is a form. Pick an option (several, where its session allows), answer in your own
  // words, or ask its session about it, then Submit (enter). Only one of the three goes at a time. ----
  const forms = new Map(); // item id → { cursor, picks, other, ask, error }
  const FIRST = { plan: 'Approve the plan', blocked: 'Go on as it thinks best', repos: 'Do without it' };
  const OWN = { plan: 'Send it back with a note', question: 'Other', blocked: 'Other', repos: 'Something else' };
  const HINT = { other: 'type your own answer', ask: 'type a question for its session' };

  /** The rows of `it`'s form: its choices, then the rows you type in, then Submit. */
  function formRows(it) {
    const recs = [it.recommended].flat().filter(Boolean);
    const choices = it.options.length ? it.options.map(o => ({ label: o, answer: o, rec: recs.includes(o) }))
      : [{ label: FIRST[it.kind] || (it.kind !== 'question' ? 'Retry' : recs.length ? `Use its default: ${recs.join('; ')}` : 'Let the session decide'), answer: '', rec: true }];
    const own = it.options.length || it.kind !== 'question' ? OWN[it.kind] || 'Retry with a note' : 'Your answer';
    const asked = builder.history().find(w => w.uid === it.recordId)?.sessionStarted;
    if (it.gate) return [...choices.map((c, i) => ({ type: 'choice', i, ...c })), { type: 'submit' }]; // a quick build's question before it starts: only its options are answers
    return [...choices.map((c, i) => ({ type: 'choice', i, ...c })), { type: 'text', field: 'other', label: own },
      ...(asked ? [{ type: 'text', field: 'ask', label: 'Ask about this' }] : []), { type: 'submit' }];
  }

  /** `it`'s form, made the first time with the recommended choice picked and the cursor on it. */
  function formOf(it) {
    if (!forms.has(it.id)) {
      const rec = formRows(it).filter(r => r.type === 'choice' && r.rec).slice(0, it.multiple ? Infinity : 1);
      forms.set(it.id, { cursor: rec[0]?.i ?? 0, picks: new Set(rec.map(r => r.i)), other: '', ask: '', error: '' });
    }
    return forms.get(it.id);
  }
  const currentItem = () => (view() === NEEDS ? needs(ui.side)[Math.min(sel()[NEEDS], needs(ui.side).length - 1)] : undefined);

  /** Picks choice `i` (or unticks it, where several may be picked); your own answer and your question clear. */
  function pickChoice(it, f, i) {
    Object.assign(f, { other: '', ask: '', error: '' });
    if (!it.multiple) f.picks = new Set([i]);
    else if (f.picks.has(i)) f.picks.delete(i);
    else f.picks.add(i);
  }
  /** Text typed in `field`: once there's some, the picks and the other text row clear. */
  function setText(f, field, value) {
    Object.assign(f, { [field]: value, error: '' });
    if (value.trim()) { f.picks.clear(); f[field === 'ask' ? 'other' : 'ask'] = ''; }
  }

  /** Typing follows the form's cursor: on a row you type in, keys type; anywhere else they're keys. */
  function focusForm(it) {
    const f = formOf(it);
    const row = formRows(it)[f.cursor];
    if (row?.type !== 'text') { if (ui.edit?.form) ui.edit = null; return; }
    if (ui.edit?.form && ui.edit.field === row.field && ui.edit.item === it.id) return;
    ui.edit = { value: f[row.field], cursor: f[row.field].length, error: '', form: true, field: row.field, item: it.id, commit: () => submitForm(it) };
  }
  function formMove(dir) {
    const it = currentItem();
    if (!it) return;
    const f = formOf(it);
    f.cursor = dir === 'top' ? 0 : Math.max(0, Math.min(formRows(it).length - 1, f.cursor + (dir === 'up' ? -1 : 1)));
    f.error = '';
    focusForm(it);
  }

  /** Submit: your question to its session, or else your own answer, or else what you picked. Returns why not, or ''. */
  function submitForm(it) {
    const f = formOf(it);
    if (f.ask.trim()) {
      const why = actions.discuss(it, f.ask.trim());
      if (why) return (f.error = why);
      setText(f, 'ask', '');
      flash("Asked: its reply shows under the question. Ask again, or answer when you're ready.");
      return '';
    }
    const picked = formRows(it).filter(r => r.type === 'choice' && f.picks.has(r.i));
    if (!f.other.trim() && !picked.length) return (f.error = 'Pick an option, write your own answer, or ask about it first.');
    const text = f.other.trim() || picked.map(r => r.answer).join('; ');
    const refused = actions.answer(it, text);
    if (typeof refused === 'string' && refused) return (f.error = refused);
    forms.delete(it.id);
    if (ui.edit?.form) ui.edit = null;
    flash(it.kind === 'plan' ? (text ? 'Sent back with your note.' : 'Plan approved: the session builds it now.')
      : ['question', 'repos', 'blocked'].includes(it.kind) ? 'Answered: the session picks up from here.' : 'Retrying.');
    return '';
  }

  /** What only you can answer or decide: the Builder's questions, plans and stops, each a form. */
  function needsView(W, H) {
    const items = needs(ui.side);
    if (!items.length) {
      return [[], [[ST.grey, isOn('builder') ? '  Nothing needs you. The Builder\'s questions, plans waiting for approval and stops show up here.'
        : '  The Builder is off (e turns it on). Its questions and stops show up here.']]];
    }
    for (const id of forms.keys()) if (!items.some(x => x.id === id)) forms.delete(id); // answered or gone
    const at = clampSel(NEEDS, items.length);
    const it = items[at];
    const f = formOf(it);
    const form = formRows(it);
    if (form[f.cursor]?.type === 'text' && !(ui.edit?.form && ui.edit.item === it.id)) f.cursor = 0; // back from elsewhere: not mid-typing
    const lab = t => [ST.grey, `  ${t.padEnd(9)}`];
    const asking = builder.history().find(w => w.uid === it.recordId)?.discussion;
    // Above the form, one pane: the ticket, the question with its context, and the talk with its session. Nothing is cut.
    const above = [
      [lab('Ticket'), [ST.bold, it.ticket], ...(it.pr ? [['', '  '], [ST.link, it.pr, it.pr]] : [])],
      [lab(['question', 'plan', 'repos', 'blocked'].includes(it.kind) ? 'Question' : 'Stopped'), [ST.bold, it.question]],
      ...it.context.map(c => [lab(''), [ST.grey, c]]),
      ...(it.blocked ? [[lab('Blocked'), [ST.grey, it.blocked]]] : []),
      ...(it.searched ? [[lab('Searched'), [ST.grey, it.searched]]] : []),
    ];
    // The form: a radio button for each choice (a checkbox where several may be picked), the rows you type in, Submit.
    const box = on => (it.multiple ? (on ? '[x]' : '[ ]') : (on ? '(•)' : '( )'));
    const formLines = form.map((r, idx) => {
      const lead = f.cursor === idx ? [`${ST.bold}${acc().fg}`, '  ❯ '] : ['', '    '];
      if (r.type === 'submit') {
        return [lead, [f.cursor === idx ? acc().keyHover : acc().key, ' Submit ', undefined, () => { f.cursor = idx; submitForm(it); }, acc().keyHover], [ST.grey, '  enter']];
      }
      if (r.type === 'choice') {
        const on = f.picks.has(r.i);
        // A long label wraps under itself, every row of it picking the choice.
        const head = [lead, [on ? `${ST.bold}${acc().fg}` : ST.grey, box(on)], [ST.grey, it.options.length ? ` ${r.i + 1}. ` : ' ']];
        return wrapSegs([...head, [on ? ST.bold : '', r.label], ...(r.rec ? [[ST.green, '  Recommended']] : [])], W - 1, width(head))
          .map(row => onClick(row, () => { f.cursor = idx; pickChoice(it, f, r.i); focusForm(it); }));
      }
      const typing = ui.edit?.form && ui.edit.item === it.id && ui.edit.field === r.field;
      const filled = f[r.field].trim();
      const head = [lead, [filled ? `${ST.bold}${acc().fg}` : ST.grey, r.field === 'ask' ? ' ? ' : box(Boolean(filled))], ['', ` ${r.label}: `]];
      const room = W - width(head) - 2;
      return onClick([...head, ...(typing ? editSegs(room) : filled ? [['', trunc(f[r.field], room)]] : [[ST.grey, HINT[r.field]]])], () => { f.cursor = idx; f.error = ''; focusForm(it); });
    });
    const form2 = [[], ...(it.multiple ? [[lab(''), [ST.grey, 'Pick any that apply.']]] : []), ...formLines.flatMap(r => (Array.isArray(r[0]?.[0]) ? r : [r])), ...(f.error ? [[['', '    '], [ST.red, trunc(f.error, W - 6)]]] : [])];
    // What you've asked its session about it, and its replies.
    const talk = (it.thread || []).flatMap(m => [[], [m.from === 'you' ? [`${ST.bold}${acc().fg}`, '  You      '] : [`${ST.bold}${ST.cyan}`, '  Session  '], ['', m.text]]]);
    if (asking?.itemId === it.id) talk.push([], [lab(''), [ST.cyan, `${spin()} its session is thinking`], [ST.grey, asking._activity?.length ? `: ${asking._activity.at(-1).text}` : '…']]);
    const blocks = [...above, ...talk].map((segs, k) => ({ key: k, segs, hang: 11 }));
    // The form stays whole below the pane; a view too short for it plus two pane rows cuts the form from its end.
    const need = blocks.reduce((n, b) => n + linesOf(b, W).length, 0);
    const paneH = Math.max(2, Math.min(need, H - 2 - form2.length));
    const before = ui.panes.get('needs');
    const said = (it.thread || []).length;
    if (before?.owner === it.id && before.talk !== undefined && said > before.talk) scrollPane('needs', 'end'); // a reply came: show it
    const top = pane('needs', blocks, W, paneH, { owner: it.id, front: true });
    ui.panes.get('needs').talk = said;
    const rows = windowed(items, at, Math.max(1, H - 1 - top.length - form2.length)).map(({ item: x, i }) => {
      const head = [cursor(i === at), [ST.grey, `${stamp(x.createdAt)}  `], [ST.bold, x.ticket.padEnd(11)], [['question', 'plan', 'repos'].includes(x.kind) ? ST.yellow : ST.red, x.kind.padEnd(10)]];
      return onClick([...head, ['', trunc(x.question, W - width(head))]], () => { sel()[NEEDS] = i; });
    });
    return [...rows, rule(W), ...top, ...form2];
  }

  /** The text being typed, with its cursor, scrolled to keep the cursor within `room` columns. */
  function editSegs(room = Infinity) {
    const e = ui.edit;
    const from = Math.max(0, e.cursor - room + 1);
    const v = (e.secret ? '•'.repeat(e.value.length) : e.value.replace(/\n/g, '↵')).slice(from);
    const at = e.cursor - from;
    return [[ST.yellow, v.slice(0, at)], [ST.cursor, v[at] || ' '], [ST.yellow, v.slice(at + 1)]];
  }

  function configView(W, H) {
    const fields = configRows();
    if (ui.menu) sel()[CONFIG] = Math.max(0, fields.findIndex(f => f.key === ui.menu.key)); // its row stays the selected one
    const at = clampSel(CONFIG, fields.length);
    const rows = [[[ST.grey, '  Saved to '], [ST.link, CONFIG_PATH, pathToFileURL(CONFIG_PATH).href], [ST.grey, ' on every change. The next poll uses it.']], []];
    // Under the cards, a pane: the selected setting's help (or a failed edit's error), wrapped, then the trigger's variants.
    const variants = Object.entries(reviewer.tagVariants || {}).map(([p, v]) => `${p}: ${v.join(', ') || 'none yet'}`).join('  ·  ');
    const help = [{ key: 'help', hang: 2, segs: ui.edit?.error ? [[ST.red, `  ${ui.edit.error}`]] : [[sectionColor(fields[at].section), `  ${fields[at].section} ▏ `], [ST.grey, fields[at].help]] },
      ...(variants ? [{ key: 'variants', hang: 2, segs: [[ST.grey, `  ${JIRA(app.cfg) ? 'Labels' : 'Tags'} treated as the trigger: `], ['', variants]] }] : [])];
    const helpH = Math.min(help.reduce((n, b) => n + linesOf(b, W).length, 0), Math.max(3, Math.floor(H / 3)));
    // Each section is a card, in its own colour: a rounded box with its heading in the top edge, a blank row between
    // cards. The window counts the edges and gaps as rows.
    // A setting's values, listed under its row while its menu is open. The list belongs to its setting by key: when
    // the setting is gone from the page (Task board switched, say), it closes.
    const menuAt = ui.menu ? fields.findIndex(f => f.key === ui.menu.key) : -1;
    if (ui.menu && menuAt < 0) ui.menu = null;
    const lines = fields.flatMap((f, i) => [
      ...(f.section !== fields[i - 1]?.section ? [...(i ? [{ gap: true }] : []), { top: f.section }] : []),
      { f, i },
      ...(i === menuAt ? ui.menu.options.map((opt, n) => ({ opt, n, f })) : []),
      ...(f.section !== fields[i + 1]?.section ? [{ bottom: f.section }] : []),
    ]);
    const inner = W - 5; // between '  │ ' and '│'
    // The window is centred on the option under the cursor while a menu is open, else on the setting's row.
    const centre = ui.menu ? lines.findIndex(l => l.opt && l.n === ui.menu.at) : lines.findIndex(l => l.i === at);
    for (const { item: { f, i, top, bottom, gap, opt, n } } of windowed(lines, centre, Math.max(1, H - 3 - helpH))) {
      if (gap) { rows.push([]); continue; }
      if (opt) {
        // Under the value column; on a narrow terminal, as far left as still shows the longest option whole.
        const longest = Math.max(...ui.menu.options.map(o => o.label.length)) + 4; // its cursor and its tick
        const indent = Math.max(2, Math.min(2 + LABEL_W, inner - 1 - longest));
        const on = n === ui.menu.at;
        const body = [['', ' '.repeat(indent)], on ? [acc().fg, '❯ '] : ['', '  '], [opt.other ? ST.grey : on ? ST.bold : '', opt.label], ...(opt.current ? [[ST.green, ' ✓']] : [])];
        const c = sectionColor(f.section);
        const padded = clip(body, inner - 1);
        rows.push(Object.assign([[c, '  │ '], ...padded, ['', ' '.repeat(Math.max(0, inner - 1 - width(padded)))], [c, '│']], { hit: () => menuChoose(n), menu: true }));
        continue;
      }
      if (top || bottom) {
        const c = sectionColor(top || bottom);
        rows.push(top ? [[c, '  ╭─'], [`${ST.bold}${c}`, ` ${top} `], [c, `${'─'.repeat(Math.max(0, W - top.length - 8))}╮`]] : [[c, `  ╰${'─'.repeat(W - 5)}╯`]]);
        continue;
      }
      const c = sectionColor(f.section);
      const value = i === at && ui.edit ? editSegs(Math.max(1, inner - LABEL_W - 3))
        : f.file ? [[ST.link, f.file, pathToFileURL(f.file).href]] : [[f.switch ? (isOn(f.switch) ? ST.green : ST.grey) : '', shown(f)]];
      const on = i === at;
      const body = [on ? [acc().fg, '❯ '] : ['', '  '], [f.addBoard ? ST.green : on ? ST.bold : ST.grey, f.label.padEnd(LABEL_W)], ...value];
      rows.push(onClick([[c, '  │ '], ...clip(body, inner - 1), [c, '│']], pick(CONFIG, i)));
    }
    rows.push([], ...pane('help', help, W, helpH, { owner: `${at}:${ui.edit?.error || ''}`, front: true }));
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

  /** Stats: what the side's reviews or builds cost in a time frame, in one scrolling pane. */
  function statsView(W, H) {
    const days = RANGES[ui.statsRange];
    const now = Date.now();
    const build = ui.side === 'builder';
    const [one, many] = build ? ['build', 'builds'] : ['review', 'reviews'];
    const s = summarize(side().spend?.() || [], { days, now });
    const other = spendIn(sides[build ? 'reviewer' : 'builder'].spend?.() || [], { days, now });
    const money = n => `$${n.toFixed(2)}`;
    const blocks = [];
    const add = (segs, hang = 2, wrapIt = true) => blocks.push({ key: blocks.length, segs, hang, wrap: wrapIt });
    const head = text => { add([]); add([[ST.bold, ` ${text} `], [ST.grey, '─'.repeat(Math.max(0, W - text.length - 3))]], 0, false); };
    add([[ST.bold, ` Spend · ${NAMES[ui.side]} · ${rangeName(days)}`], [ST.grey, ' · t changes it']]);
    add([[ST.bold, `  ${money(s.total)}`], ['', ` on ${s.count} ${s.count === 1 ? one : many}`], ...(s.count ? [[ST.grey, ` · ${money(s.avgCost)} a ${one} on average${s.avgMs != null ? `, ${dur(s.avgMs)}` : ''}`]] : []),
      ...(s.failedCost > 0 ? [[ST.orange, ` · ${money(s.failedCost)} on failed or stopped ${many}`]] : []), [ST.grey, ` · ${build ? 'Reviewer' : 'Builder'} ${money(other)} in the same time`]]);
    if (!s.buckets.length) { add([]); add([[ST.grey, `  Nothing spent in ${days ? `the ${rangeName(days)}` : 'the history kept'}. t changes the time frame.`]]); }
    else {
      const barW = Math.max(6, Math.min(40, W - 48));
      const table = (rowsOf, nameW) => {
        const max = Math.max(...rowsOf.map(r => r.cost));
        for (const r of rowsOf) add([[ST.grey, `  ${r.name.padEnd(nameW)} `], [acc().fg, (spendBar(r.cost, max, barW) || '·').padEnd(barW + 1)], ['', money(r.cost).padStart(9)], [ST.grey, `  ${r.note}`]], 2, false);
      };
      head(`SPEND PER ${s.buckets[0].label.startsWith('wk') ? 'WEEK' : 'DAY'}`);
      table(s.buckets.map(b => ({ name: b.label, cost: b.cost, note: b.n ? `${b.n} ${build ? (b.n === 1 ? 'turn' : 'turns') : b.n === 1 ? one : many}` : '' })), 9);
      const named = list => list.map(x => ({ name: x.name, cost: x.cost, note: `${x.pct}%` }));
      head('SPEND PER MODEL');
      table(named(s.models), Math.max(12, ...s.models.map(x => x.name.length)));
      head(`SPEND PER ${one.toUpperCase()} EFFORT`);
      table(named(s.efforts), Math.max(12, ...s.efforts.map(x => x.name.length)));
      const top = (title, list, row) => {
        head(title);
        if (!list.length) add([[ST.grey, '  none']]);
        list.forEach((x, i) => { const [figure, ticket, url, what, title2] = row(x); add([[ST.grey, `  ${String(i + 1).padEnd(3)}`], [ST.bold, figure.padStart(9)], ['', '  '], [ST.link, ticket.padEnd(11), url || undefined], [ST.grey, `${what}  `], ['', title2 || '']], 2, false); });
      };
      top(`TOP ${many.toUpperCase()} BY COST`, s.topCost, x => [money(x.cost), x.entry.ticket, x.entry.ticketUrl, `${x.entry.label}${x.timed ? ` · ${dur(x.ms)}` : ''}`, x.entry.title]);
      top(`TOP ${many.toUpperCase()} BY TIME`, s.topTime, x => [dur(x.ms), x.entry.ticket, x.entry.ticketUrl, `${x.entry.label} · ${money(x.cost)}`, x.entry.title]);
      top(`TOP TICKETS BY TOTAL COST, EVERY ${one.toUpperCase()} TOGETHER`, s.topTickets, x => [money(x.cost), x.ticket, x.ticketUrl, `${x.n} ${x.n === 1 ? one : many}${x.ms ? ` · ${dur(x.ms)}` : ''}`, x.title]);
    }
    add([]);
    add([[ST.grey, build
      ? "  Builds count in the time frame their latest turn ended in, with only their spend inside it: a build's turns before the time frame aren't counted in it; spend per day, model and effort counts each session on the day it ended. Costs are Claude Code's list-price estimates. A turn whose cost wasn't reported counts as $0."
      : "  Reviews count in the time frame they ended in, with only their spend inside it; spend per day, model and effort counts each session on the day it ended. Costs are Claude Code's list-price estimates. A review that ran before Prowl recorded effort has none, and has its model only while its session log is kept (Keep logs)."]]);
    return pane(`stats:${ui.side}`, blocks, W, H, { owner: days, front: true, arrows: true, main: true });
  }

  const logLines = () => app.log.filter(l => l.side === ui.side || l.side === 'prowl');
  /** The Log: one following pane over the whole view, each entry wrapped under its message, its status row on top. */
  const logView = (W, H) => pane(`log:${ui.side}`, logLines().map(l => ({ key: keyOf(l), src: l, hang: 15, segs: [[ST.grey, `${time(l.t)} `], [LEVEL[l.level], `${l.level.padEnd(5)} `], ['', l.msg]] })),
    W, H, { follow: true, statusTop: true, main: true, front: true, arrows: true });

  // Keys, as [key, short label (the bar), what it does (the full list)]. Each view's, most useful first, then the rest.
  const CONFIG_KEYS = [['enter', 'edit', 'Edit the setting, list its values to pick one, flip its switch, or open its file'], ['a', 'add board', 'Add a board to watch'], ['d', 'delete board', 'Delete the selected board']];
  const DETAIL_KEYS = [['↑ ↓', 'select', 'Select in a list; choose in a document with choices; else scroll a line'], ['enter', 'open', 'Open the selected or chosen item'],
    ['← →', 'tabs', "The previous or next tab; in a finding's window, the previous or next finding"], ['esc', 'back', 'Clear the search, else close the window, else back to the list'],
    ['s', 'status', 'On the Findings list: the status filter. Elsewhere, when opened from Running: stop it (asks first)'], ['v', 'severity', 'On the Findings list: the severity filter'],
    ['l', 'in full', 'A session: Activity lines, or the full text'], ['p', 'prompt', "The prompt the session was given (a turn's on the Turns list or in its window)"],
    ['f', 'find', 'Find text in what is in front; n and N go to the next and previous match'], ['[ ]', 'reviews', "The ticket's review before or after this one"],
    ['o', 'GitHub', 'Open on GitHub: the finding at the reviewed commit, the PR in front or selected, else all its PRs'],
    ['x', 'outside', "Open outside Prowl: the file in front, the session's log, else the report, the plan or the brief folder"], ['a', 'ticket', 'Open its ticket']];
  const STATS_KEYS = [['t', 'time frame', 'Step the time frame: the last 7, 30 or 90 days, or all time'], ['PgUp PgDn', 'scroll', 'Scroll a page'], ['↑ ↓', 'line', 'Scroll a line']];
  const LOG_KEYS = [['PgUp PgDn', 'scroll', 'Scroll the Log a page'], ['↑ ↓', 'line', 'Scroll the Log a line'], ['Home End', 'first / latest', 'The first line kept / back to the latest']];
  const VIEW_KEYS = {
    reviewer: [
      [['enter', 'details', 'Open everything Prowl kept about it, in tabs: its summary, PRs, findings and session'], ['s', 'stop', "Stop the selected review (its in-progress tag comes off, so re-tag the ticket to run it again), or stop a quick review waiting on its PRs (◷; its labels stay as they are)"], ['o', 'open PRs', 'Open its PRs in the browser'], ['a', 'ticket', 'Open its ticket in the browser']],
      [['enter', 'details', 'Open everything Prowl kept about it, in tabs: its summary, PRs, findings and session'], ['x', 'report', "Open the review's report outside Prowl"], ['v', 'review again', "Review the selected review's PRs again, as a quick review under the same ticket or name (asks first; no tags change)"], ['o', 'open PRs', 'Open its PRs in the browser'], ['a', 'ticket', 'Open its ticket in the browser']],
      [], CONFIG_KEYS, LOG_KEYS, STATS_KEYS,
    ],
    builder: [
      [['enter', 'details', 'Open everything Prowl kept about it, in tabs: its summary, PRs, PRs and turns'], ['x', 'brief', "Open the ticket's brief folder"], ['s', 'stop', 'Stop the selected build before its next push, PR, tag or turn'], ['o', 'open PRs', 'Open its PRs in the browser'], ['a', 'ticket', 'Open its ticket in the browser']],
      [['enter', 'details', 'Open everything Prowl kept about it, in tabs: its summary, PRs, PRs and turns'], ['x', 'plan', "Open the ticket's plan outside Prowl, or its brief folder when it has none"], ['o', 'open PRs', 'Open its PRs in the browser'], ['a', 'ticket', 'Open its ticket in the browser'],
        ['w', 'follow', "Follow the ticket's PRs through review (not a quick build without a ticket)"], ['t', 'unfollow', "Stop following the ticket's PRs"]],
      [['space', 'pick', 'Pick the option under the cursor (or untick it, where several may be picked)'],
        ['enter', 'submit', 'Submit what you picked, your own answer, or your question for its session: one at a time'],
        ['[ ]', 'item', 'The previous or next item in Needs you'], ['s', 'skip', 'Skip the question (the session uses its default), or end the work'],
        ['t', 'hand back', 'Hand the ticket back with its start tag; Prowl leaves it until someone re-tags it'], ['o', 'open', 'Open the PR or the ticket in the browser']],
      CONFIG_KEYS, LOG_KEYS, STATS_KEYS,
    ],
  };
  const NEW_REVIEW = ['n', 'quick review', 'On the Reviewer: a quick review of the PRs or tickets you paste, reviewed together as one set. Pasting there opens it too'];
  const NEW_BUILD = ['n', 'quick build', 'On the Builder: a quick build of a ticket, PRs, or what you describe; it starts at once. Pasting there opens it too'];
  const KEY_GROUPS = [
    ['Moving around', [['tab', 'side', 'Switch between the Reviewer and the Builder; R and B go straight to one'],
      ['←→', 'views', 'The previous or next view; 1–6 go straight to Running, History, Needs you, Config, Log or Stats'],
      ['↑↓', 'select', 'Move the selection; scroll this list and the Update Notes'],
      ['PgUp PgDn', 'page', "Scroll a page of the text in view: Activity, details, a setting's help, the Log"], ['Home End', 'ends', 'Its first line / back to its latest']]],
    ['The side in view', [['e', 'on/off', 'Turn the side in view on or off, at once'], ['r', 'poll', 'Poll the side in view now'],
      ['p', 'pause', 'Pause the side in view: running sessions carry on, nothing new starts'], NEW_REVIEW, NEW_BUILD]],
    ['Typing', [['enter', 'save', 'Save the edit, or send the answer'], ['esc', 'cancel', 'Cancel it'], ['←→', 'move', 'Move the cursor; home and end jump to either end']]],
    ['Offers', [['1–3', 'choose', 'A paste of only tickets on a board pops up an offer first: tag them, add their board and tag them, or go ahead quickly'], ['↑↓ enter', 'choose', 'Move to a choice and take it'], ['esc', 'cancel', 'Cancel']]],
    ['Mouse', [['click', '', 'A side, view or row picks it; the selected row again does what enter does; a link opens; a key in the bar presses it'],
      ['scroll', '', 'Scrolls the text under the pointer; elsewhere moves the selection'], ['drag', '', 'Select text; it is copied to the clipboard when you let go']]],
    ['Prowl', [['/', 'all keys', 'Show or hide this list'], ['esc', 'close', 'Close this list, or answer no'],
      ['q', 'quit', 'Quit both sides; running sessions keep going and reappear on the next launch'], ['ctrl-c', 'quit now', 'Quit at once, without asking']]],
  ];
  const PRESS = { '←': 'left', '→': 'right', '↑': 'up', '↓': 'down', space: ' ', PgUp: 'pageup', PgDn: 'pagedown', Home: 'home', End: 'end' };
  const pressable = k => (k.length === 1 || ['enter', 'tab', 'esc', 'left', 'right', 'up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(k) ? () => onKey(k) : undefined);
  // The view's own keys, while it has something selected for them to act on.
  const viewKeys = () => {
    const list = [live, history, needs, null, logLines, null][view()];
    return list && !list(ui.side).length ? [] : VIEW_KEYS[ui.side][view()];
  };
  const EMPTY = ['nothing running', 'nothing here yet', 'nothing needs you', '', 'newest at the bottom', ''];

  /** A bar: every segment on its background, its hover style too. */
  function bar(segs, t) {
    return Object.assign(segs.map(([style, text, url, hit, hover]) => [t.bg + (style || t.text), text, url, hit, hover && t.bg + hover]), { bg: t.bg, footer: true });
  }
  /**
   * A button: its keycaps ('← →' is two, each pressing its own key) and its label, which lights up and presses with a
   * keycap when there's one. Clicking one does what the key does.
   */
  function button([keys, label], t) {
    const [cap, capHover] = t === NAV ? [NAV.cap, NAV.capHover] : [acc().key, acc().keyHover];
    const caps = keys.split(' ').map(k => [cap, ` ${k} `, undefined, pressable(PRESS[k] || k), capHover]);
    const one = caps.length === 1 ? caps[0][3] : undefined;
    return [...caps, [t.text, ` ${label} `, undefined, one, one && t.labelHover], ['', ' ']];
  }
  const tag = text => [[`${ST.bold}${acc().fg}`, ' ▌'], [`${ST.bold}${acc().fg}`, `${text}  `]];

  /**
   * Buttons across `W` columns. On one row when they fit, `right` (the last ones) at its right end. Else stacked as a
   * grid in as few rows as fit, as many buttons on each, with its columns lined up. `lead` starts the first row and the
   * others line up under its first button.
   */
  function stack(list, t, W, lead = [['', ' ']], right = []) {
    const btns = [...list, ...right].map(b => button(b, t));
    const room = W - width(lead);
    if (btns.reduce((n, b) => n + width(b), 0) < room) {
      const left = [...lead, ...btns.slice(0, list.length).flat()];
      const rt = btns.slice(list.length).flat();
      return [rt.length ? spread(left, rt, W) : left];
    }
    for (let rows = 2; ; rows++) {
      const cols = Math.ceil(btns.length / rows);
      const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...btns.filter((b, i) => i % cols === c).map(width)));
      if (cols === 1 || colW.reduce((a, b) => a + b, 0) <= room) {
        return Array.from({ length: Math.ceil(btns.length / cols) }, (_, r) => [...(r ? [['', ' '.repeat(width(lead))]] : lead),
          ...btns.slice(r * cols, (r + 1) * cols).flatMap((b, c) => [...b, ['', ' '.repeat(colW[c] - width(b))]])]);
      }
    }
  }

  /**
   * The bars along the bottom: navigation on top, and the screen's own keys below, each stacking onto more rows when
   * the window is too narrow for one. A message, a question or typing takes them over while it lasts.
   */
  function footer(W, H) {
    const say = (style, text) => [[style, ` ${text}`]];
    const keys = (name, list) => stack(list, KEYBAR, W, tag(name));
    let nav;
    let own;
    if (ui.notes) [nav, own] = [[say(NAV.text, 'Update Notes: ↑↓ and PgUp PgDn scroll them, and any other key or a click closes them.')], keys('Update Notes', [['↑ ↓', 'scroll'], ['PgUp PgDn', 'page'], ['esc', 'close']])];
    else if (offerOpen()) [nav, own] = [[say(NAV.text, 'Choose what to do with the pasted ticket: a number, or ↑↓ and enter.')], keys('Offer', [['1 2 3', 'choose'], ['↑ ↓', 'move'], ['enter', 'take it'], ['esc', 'cancel']])];
    else if (ui.confirm) {
      const answers = ui.confirm.key ? [[ui.confirm.key, 'quit'], ['n', 'stay']] : [['y', 'yes'], ['n', 'no']];
      [nav, own] = [[say(`${ST.bold}${ST.yellow}`, ui.confirm.text)], keys('Confirm', answers)];
    } else if (ui.edit) {
      const about = ui.edit.prs ? 'Quick review: paste PR links, owner/repo#12 or tickets, then enter.' : ui.edit.build ? 'Quick build: paste a ticket, PRs, or what to build, then enter.'
        : ui.edit.find ? 'Text to find in what is in front, then enter; n and N go to the next and previous match.'
        : ui.edit.naming ? 'Type a name, then enter.' : ui.edit.secret ? 'Paste the token, then enter.'
        : ui.edit.form ? (ui.edit.field === 'ask' ? 'Ask about this: your question goes to its session, which replies under the question.' : 'Your own answer: type it, then enter to submit.')
          : 'Type, then enter to save.';
      [nav, own] = [[say(NAV.text, about)], keys('Typing', ui.edit.form ? [['enter', 'submit'], ['↑ ↓', 'move'], ['esc', 'back'], ['← →', 'cursor']]
        : [['enter', ui.edit.prs ? 'review' : ui.edit.build ? 'build' : ui.edit.naming ? 'name' : ui.edit.find ? 'find' : 'save'], ['esc', 'cancel'], ['← →', 'move']])];
    } else if (ui.menu) [nav, own] = [[say(NAV.text, `${ui.menu.label}: choose a value, then enter.`)], keys('Options', [['↑ ↓', 'choose'], ['enter', 'pick'], ['esc', 'cancel']])];
    else if (ui.keys) [nav, own] = [[say(NAV.text, 'All keys: any other key closes this list and does its job.')], keys('Keys', [['↑ ↓', 'scroll'], ['PgUp PgDn', 'page'], ['/', 'close'], ['esc', 'close']])];
    else {
      const det = detOf()?.view === view() ? detOf() : null; // the details are in front: their keys, and p and ← → are theirs
      const list = det ? detailKeys(det) : viewKeys();
      own = list.length ? keys(det ? `${TABS[view()]}, details` : TABS[view()], list) : [[...tag(TABS[view()]), [fg(245), EMPTY[view()] || 'no keys here']]];
      // Every button that fits in a third of the screen's rows; on a small one, the least used come off first.
      let moves = [...(SIDES.filter(visible).length > 1 ? [['tab', 'side']] : []), ...(det ? [] : [['← →', 'views']]), ui.side === 'reviewer' ? NEW_REVIEW : NEW_BUILD,
        ['r', 'poll'], ...(det ? [] : [['p', 'pause']]), ['e', 'on/off'], ['↑ ↓', 'select']];
      for (;;) {
        nav = stack(moves, NAV, W, [['', ' ']], [['/', 'all keys'], ['q', 'quit']]);
        if (nav.length + own.length <= Math.max(2, Math.floor(H / 3)) || !moves.length) break;
        moves = moves.slice(0, -1);
      }
    }
    if (Date.now() < ui.flashUntil && !ui.notes && !ui.confirm && !ui.edit && !ui.menu && !offerOpen()) nav = [say(`${ST.bold}${ST.green}`, ui.flash), ...nav.slice(1).map(() => [])];
    ui.bars = [nav.length, own.length];
    return [...nav.map(r => bar(r, NAV)), ...own.map(r => bar(r, KEYBAR))];
  }

  // ---- Beside Hoot, on a wide screen: the boards at a glance, and what needs you ----
  /** A card: a rounded box `w` wide and 7 rows tall, its title in the top edge, and up to 5 lines of segments. */
  function card(w, title, titleStyle, lines) {
    const shown = lines.length > 5 ? [...lines.slice(0, 4), [[ST.grey, `+${lines.length - 4} more`]]] : lines;
    return [
      [[STRIP.border, '╭─'], [titleStyle, ` ${title} `], [STRIP.border, `${'─'.repeat(Math.max(0, w - 5 - clean(title).length))}╮`]],
      ...Array.from({ length: 5 }, (_, i) => [[STRIP.border, '│ '], ...clip(shown[i] || [], w - 4), [STRIP.border, ' │']]),
      [[STRIP.border, `╰${'─'.repeat(w - 2)}╯`]],
    ];
  }
  /** A card's line that does `go` when clicked, lighting up under the pointer like any button. */
  const goes = (segs, go) => segs.map(([style, text]) => [style, text, undefined, go]);
  const show = (name, v, at) => () => {
    if (!visible(name)) return flash(`The ${NAMES[name]} is off: turn it on in Config (4).`);
    ui.side = name;
    ui.view[name] = v;
    if (at != null) ui.sel[name][v] = at;
    return undefined;
  };

  /** Boards: each side on, off, paused or checking, and its next poll; the boards and tags watched; the last poll. */
  function boardsCard(w) {
    const state = name => {
      const s = sides[name];
      if (!isOn(name)) return [[ST.grey, 'off']];
      if (s.polling) return [[ST.yellow, `${spin()} checking now`]];
      if (s.paused) return [[ST.grey, '‖ paused']];
      return [[s.lastError ? ST.red : ST.green, s.lastError ? '● error' : 'on'], [ST.grey, ` · next ${clock(s.nextPoll - Date.now())}`]];
    };
    const last = Math.max(0, ...SIDES.map(n => sides[n].lastPoll || 0));
    const label = text => [ST.grey, text.padEnd(9)];
    return card(w, 'Boards', `${ST.bold}${fg(117)}`, [
      ...SIDES.map(name => goes([[`${ST.bold}${acc(name).fg}`, NAMES[name].padEnd(9)], ...state(name)], show(name, RUNNING))),
      [label('Boards'), ['', app.boards().map(b => app.tracker().boardLabel(b)).join(', ') || 'none yet: Config (4)']],
      [label(JIRA(app.cfg) ? 'Labels' : 'Tags'), ['', [app.cfg.tags.trigger, ...(isOn('builder') ? [app.cfg.builder.tags.start] : [])].join(' · ')]],
      [label('Polled'), ['', last ? time(last) : 'not yet'], ...(app.dryRun() ? [[ST.yellow, ' · dry run']] : [])],
    ]);
  }

  /** Needs you: the Builder's questions and stops, PRs waiting on a person's approval, round caps, and errors. */
  function needsCard(w) {
    const flag = (who, what, go, extra = []) => goes([[ST.yellow, '⚑ '], [ST.bold, `${who} `], ['', what], ...extra], go);
    const items = [
      ...needs('builder').map((n, i) => flag(n.ticket, n.kind, show('builder', NEEDS, i), [[ST.grey, ` · ${ago(n.createdAt)}`]])),
      ...history('reviewer').flatMap((r, i) => (r.pr || !waiting(r).length ? [] : [flag(r.ticket, `${plural(waiting(r).length, 'PR')} to approve`, show('reviewer', HISTORY, i))])),
      ...Object.keys(reviewer.state.capped || {}).map(t => flag(t, 'round cap reached', show('reviewer', HISTORY, history('reviewer').findIndex(r => r.ticket === t)))),
      ...SIDES.filter(n => sides[n].lastError).map(n => goes([[ST.red, '● '], ['', `${NAMES[n]}: ${sides[n].lastError}`]], show(n, LOG))),
    ];
    return items.length ? card(w, `Needs you · ${items.length}`, `${ST.bold}${ST.yellow}`, items)
      : card(w, 'Needs you', `${ST.bold}${ST.green}`, [[[ST.green, '✓ All clear'], [ST.grey, ': nothing waiting on you']]]);
  }

  /**
   * Hoot's strip, `W` wide: his patch (a quarter of it), his speech box, and as many cards as fit to the right, each
   * 30 to 60 columns, flush right.
   */
  function strip(W, advance, said) {
    const cards = [boardsCard, needsCard];
    const patch = Math.max(15, Math.floor(W / 4));
    let n = cards.length;
    while (n && W - patch - n * (STRIP.cardMin + 1) < STRIP.talkMin) n--;
    const talk = n ? Math.min(STRIP.talkMax, W - patch - n * (STRIP.cardMin + 1)) : W - patch;
    const hoot = owl.render(patch + talk, 7, mood(said), said?.text || '', advance, allLive(), patch);
    if (!n) return hoot;
    const cw = Math.min(STRIP.cardMax, Math.floor((W - patch - talk) / n) - 1);
    const shown = cards.slice(0, n).map(c => c(cw));
    const gap = ['', ' '.repeat(W - patch - talk - n * (cw + 1))];
    return hoot.map((r, i) => [...r, gap, ...shown.flatMap(c => [['', ' '], ...c[i]])]);
  }

  /** The cards alone, with Hoot off: as many as fit at 30 columns or more, sharing the full width `W`. */
  function cardsRow(W) {
    const cards = [boardsCard, needsCard];
    const n = Math.max(1, Math.min(cards.length, Math.floor((W + 1) / (STRIP.cardMin + 1))));
    const cw = Math.floor((W - (n - 1)) / n);
    const shown = cards.slice(0, n).map((c, k) => c(k < n - 1 ? cw : W - (n - 1) * (cw + 1)));
    return shown[0].map((_, i) => shown.flatMap((c, k) => [...(k ? [['', ' ']] : []), ...c[i]]));
  }

  /** The full list of keys (/): this view's first, then the side's other views, then the rest, in columns when there's room. */
  function keysView(W, H) {
    const head = (text, style, note = '') => [[style, ` ${text}`], [ST.grey, note]];
    const groups = [...(detOf()?.view === view() ? [[`${NAMES[ui.side]} · ${TABS[view()]}, details`, DETAIL_KEYS, ' · open now']] : []),
      [`${NAMES[ui.side]} · ${TABS[view()]}`, VIEW_KEYS[ui.side][view()], ' · this view'],
      ...TABS.map((t, i) => [`${NAMES[ui.side]} · ${t}`, VIEW_KEYS[ui.side][i]]).filter((g, i) => i !== view()),
      ...KEY_GROUPS.filter(([name]) => name !== 'Mouse' || mouseOn())].filter(([, list]) => list.length);
    const cols = W >= 120 ? 2 : 1;
    const colW = Math.floor((W - (cols - 1) * 2) / cols);
    const shared = KEY_GROUPS.length - (mouseOn() ? 0 : 1);
    const blocks = groups.map(([title, list, note], g) => [
      head(title, `${ST.bold}${g < groups.length - shared ? acc().fg : ST.reset}`, note),
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
    return rows.slice(ui.keys.scroll);
  }

  function rows(advance, W, H) {
    drawn = {};
    try { return frameRows(advance, W, H); } finally { drawn = null; }
  }

  function frameRows(advance, W, H) {
    if (!visible(ui.side)) ui.side = 'reviewer'; // the Builder was switched off with nothing left to show
    syncDetails();
    if (!hasView(view())) ui.view[ui.side] = RUNNING;
    if (ui.edit?.form && currentItem()?.id !== ui.edit.item) ui.edit = null; // left Needs you, or the item went
    const out = [titleBar(W)];
    const said = app.speech(); // read with Hoot off too, so what he'd have said doesn't pile up
    if (H >= 27 && !ui.keys) out.push(...(app.cfg.hoot !== false ? strip(W, advance, said) : cardsRow(W)));
    out.push(sideBar(W), tabBar(), rule(W));
    const bars = footer(W, H);
    const bodyH = H - out.length - bars.length;
    ui.bodyH = bodyH;
    ui.front = null;
    ui.sig = frontSig();
    const body = (ui.notes ? notesView : ui.keys ? keysView : offerOpen() ? offerView : [runningView, historyView, needsView, configView, logView, statsView][view()])(W, bodyH).slice(0, bodyH);
    while (body.length < bodyH) body.push([]);
    out.push(...body, ...bars);
    ui.frame = out;
    ui.text = out.map(r => r.map(seg => clean(seg[1])).join('').slice(0, W));
    if (!mouseOn()) return out;
    if (!ui.drag?.moved) return ui.hover ? out.map((r, y) => (y === ui.hover.y ? hovered(r, ui.hover.x) : r)) : out;
    const { ys, xs, ye, xe } = span(ui.drag);
    return out.map((r, y) => (y < ys || y > ye ? r : highlight(r, y === ys ? xs : 0, y === ye ? xe + 1 : W)));
  }

  const size = () => [Math.max(40, (out.columns || 100) - 1), Math.max(12, out.rows || 30)];
  let painted = 0;
  // Only where OSC 9;4 means progress: Windows Terminal (which WSL passes on) and ConEmu. Some terminals read OSC 9 as a notification.
  const showsProgress = Boolean(process.env.WT_SESSION) || process.env.ConEmuANSI === 'ON';
  let progress = 0; // the state last written
  let mouseSent = false; // whether the terminal was last asked for mouse reports
  let titleSent = null; // the title last written
  function paint(advance) {
    painted = Date.now();
    const [W, H] = size();
    const state = showsProgress ? progressState() : 0;
    if (state !== progress) { progress = state; out.write(progressSeq(state)); }
    // The mouse follows its setting as it changes, in Config or in the file; the title is written when it changes.
    if (mouseOn() !== mouseSent) { mouseSent = mouseOn(); out.write(mouseSent ? '\x1b[?1003h\x1b[?1006h' : '\x1b[?1006l\x1b[?1003l'); if (!mouseSent) { ui.hover = null; ui.drag = null; } }
    const title = titleText();
    if (title !== titleSent) { titleSent = title; out.write(`\x1b]0;${title}\x07`); }
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

  // app.cfg is read when an edit is saved, not when it starts: config.json is re-read while you type, into a new object.
  function editBoard(index) {
    if (index == null) sel()[CONFIG] = configRows().findIndex(f => f.addBoard);
    startEdit(index == null ? '' : app.tracker().boardLabel(app.boards()[index]), v => {
      const b = parseBoard(v);
      if (typeof b === 'string') return b;
      const boards = app.boards();
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

  /** What a start resolved with: an offer pops up; a run or record is flashed. */
  const landed = name => r => { if (r?.offer) ui.offers.push(r.offer); else flash(started(r, name)); };

  /** Quick names set to ask, with no single ticket to name it: a second box asks for the name, then `go(name)`. */
  function maybeName(kind, needed, go) {
    if (app.cfg.quickName !== 'ask' || !needed) { go(''); return; }
    startEdit('', v => { go(cleanName(v)); return ''; });
    ui.edit.naming = kind;
  }

  /** n on the Reviewer (or a paste there): a quick review of the PRs and tickets pasted, reviewed together. */
  function newReview(value = '') {
    if (!isOn('reviewer')) return flash('The Reviewer is off: e turns it on.');
    ui.side = 'reviewer';
    ui.view.reviewer = RUNNING;
    startEdit(value.replace(/\s+/g, ' ').trim(), v => {
      const paste = parsePaste(v, app.cfg.taskBoard);
      if (paste.rest) return `${notARef(paste.rest)} isn't a PR or a ticket: paste PR links, owner/repo#12 or ticket keys`;
      if (!paste.prs.length && !paste.tickets.length) return 'Paste at least one PR or ticket';
      // Named after its ticket when there is exactly one; ask names the rest.
      ui.edit = null;
      maybeName('review', paste.tickets.length !== 1, name => {
        actions.quickReview(v, { name }).then(landed('reviewer'), e => flash(`Couldn't start the review: ${e.message}`));
      });
      return '';
    });
    ui.edit.prs = true;
    return undefined;
  }

  /** n on the Builder (or a paste there): a quick build of a ticket, PRs, or what you describe, after a y/n. */
  function newBuild(value = '') {
    ui.side = 'builder';
    ui.view.builder = RUNNING;
    startEdit(value.trim(), v => {
      const paste = parsePaste(v, app.cfg.taskBoard);
      if (paste.tickets.length > 1) return `One ticket per quick build: ${paste.tickets.join(', ')}`;
      if (paste.tickets.length && paste.prs.length) return 'Paste a ticket or PRs, not both';
      if (!paste.tickets.length && !paste.prs.length && !paste.rest) return 'Paste a ticket, PRs, or what to build';
      const what = paste.tickets.length ? `${paste.tickets[0]}${paste.rest ? ', with your instructions' : ''}, claiming it '${app.cfg.builder.tags.inProgress}'`
        : paste.prs.length ? `on ${plural(paste.prs.length, 'PR')}` : `"${trunc(paste.rest.split('\n')[0], 36)}", without a ticket`;
      ui.confirm = { text: `Quick build ${what}?`, yes: () => maybeName('build', !paste.tickets.length, name => {
        actions.quickBuild(v, { name }).then(landed('builder'), e => flash(`Couldn't start the build: ${e.message}`));
      }) };
      return '';
    });
    ui.edit.build = true;
    return undefined;
  }

  /** A paste: into the box being typed in, or, with none open, a quick review or quick build of it on the side in view. */
  function onPaste(text) {
    if (ui.edit) {
      const e = ui.edit;
      const t = e.build ? text.replace(/\r\n?/g, '\n') : text.replace(/\s+/g, ' ');
      e.value = e.value.slice(0, e.cursor) + t + e.value.slice(e.cursor);
      e.cursor += t.length;
      const it = e.form && currentItem();
      if (it) setText(formOf(it), e.field, e.value); // pasting is typing: Submit sends the form's text, not the box's
      return undefined;
    }
    if (ui.notes || ui.confirm || ui.keys || ui.menu || offerOpen()) return undefined;
    return ui.side === 'builder' ? newBuild(text) : newReview(text);
  }

  function configKey(k) {
    const f = configRows()[sel()[CONFIG]];
    if (k === 'a') return editBoard(null);
    if (f.switch) return k === 'enter' ? toggleSide(f.switch) : undefined;
    if (f.file) return k === 'enter' ? openIt(f.file) : undefined;
    if (k === 'd' && f.board != null) {
      ui.confirm = { text: `Remove board ${app.tracker().boardLabel(app.boards()[f.board])}?`, yes: () => { app.boards().splice(f.board, 1); saved('Board removed.'); } };
      return undefined;
    }
    if (k !== 'enter') return undefined;
    if (f.addBoard) return editBoard(null);
    if (f.board != null) return editBoard(f.board);
    if (f.type === 'secret') {
      if (!app.cfg.jira.email) return flash('Fill in the Jira email first.');
      return startEdit('', v => {
        if (!v) return 'Paste the token, or esc to keep the saved one';
        const err = actions.saveToken(v);
        if (err) return err;
        flash('Token saved. r polls now.');
        return '';
      }, true);
    }
    if (f.type === 'list') return openIt(CONFIG_PATH);
    if (f.type === 'bool') { setPath(app.cfg, f.key, !getPath(app.cfg, f.key)); return saved(); }
    if (f.type === 'enum') return openMenu(f);
    return typeValue(f);
  }

  /** The box on a setting's row, with its value in it: a text or number setting, or a model typed through Other…. */
  function typeValue(f) {
    return startEdit(String(getPath(app.cfg, f.key) ?? ''), v => {
      if (!v && !f.empty) return 'Cannot be empty';
      if (f.type === 'int') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < f.min || n > f.max) return `Enter a whole number from ${f.min} to ${f.max}`;
        setPath(app.cfg, f.key, n);
      } else {
        const ok = f.valid ? f.valid(v, app.cfg) : true;
        if (ok !== true) return ok;
        setPath(app.cfg, f.key, v);
      }
      saved();
      return '';
    });
  }

  /** Lists a setting's values under its row, the one set now ticked and under the cursor. One typed by hand that the list lacks is listed too. */
  function openMenu(f) {
    const cur = getPath(app.cfg, f.key);
    const options = f.values.map(value => ({ value, label: f.names?.[value] ?? (value === '' ? f.emptyShows || '(none)' : String(value)), current: value === cur }));
    if (!f.values.includes(cur)) options.push({ value: cur, label: `${cur} (not in the list)`, current: true });
    if (f.other) options.push({ other: true, label: 'Other… (type it)' });
    ui.menu = { key: f.key, label: f.label, options, at: Math.max(0, options.findIndex(o => o.current)) };
    return undefined;
  }

  /** Picks option `n` of the open menu: saved at once into the config as it is now, unless it is the value already set. Other… opens the box. */
  function menuChoose(n) {
    const m = ui.menu;
    if (!m) return undefined; // a second pick in one read: the list has closed
    ui.menu = null;
    const f = configRows().find(x => x.key === m.key);
    const o = m.options[n];
    if (!f || !o) return undefined;
    if (o.other) return typeValue(f);
    if (getPath(app.cfg, f.key) === o.value) return undefined; // the value set now, in the config as it is now (the file may have changed while the list was open)
    setPath(app.cfg, f.key, o.value);
    return saved();
  }

  /** A key while a menu is open: ↑ ↓ move (round at the ends), Home End jump, enter picks, esc closes. Every other key is ignored. */
  function menuKey(k) {
    const m = ui.menu;
    const n = m.options.length;
    if (k === 'up' || k === 'down') m.at = (m.at + (k === 'up' ? n - 1 : 1)) % n;
    else if (k === 'home') m.at = 0;
    else if (k === 'end') m.at = n - 1;
    else if (k === 'enter') menuChoose(m.at);
    else if (k === 'esc') ui.menu = null;
    return undefined;
  }

  function needsKey(k) {
    const it = currentItem();
    if (!it) return undefined;
    const f = formOf(it);
    const row = formRows(it)[f.cursor];
    if (k === ' ') { if (row?.type === 'choice') pickChoice(it, f, row.i); else if (row?.type === 'submit') submitForm(it); }
    else if (k === 'enter') submitForm(it);
    else if (k === '[' || k === ']') {
      sel()[NEEDS] = Math.max(0, Math.min(needs(ui.side).length - 1, sel()[NEEDS] + (k === ']' ? 1 : -1)));
      focusForm(currentItem());
    } else if (k === 'o') openIt(it.pr || builder.history().find(w => w.uid === it.recordId)?.url || '');
    else if (k === 's' && it.gate) { // a quick build's question before it started: s cancels it
      ui.confirm = { text: `Cancel the quick build of ${it.ticket}? Nothing has been claimed or started.`, yes: () => { actions.skip(it); flash('Quick build cancelled.'); } };
    } else if (k === 't' && it.gate) flash("Nothing to hand back: the quick build hasn't claimed it.");
    else if (k === 's') {
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
    else if (k === 'enter') { const err = e.commit(e.value.trim()); if (err) e.error = err; else if (ui.edit === e) ui.edit = null; } // a commit may open the next box
    else if (k === 'backspace') { if (e.cursor) { e.value = e.value.slice(0, e.cursor - 1) + e.value.slice(e.cursor); e.cursor--; } }
    else if (k === 'delete') e.value = e.value.slice(0, e.cursor) + e.value.slice(e.cursor + 1);
    else if (k === 'left') e.cursor = Math.max(0, e.cursor - 1);
    else if (k === 'right') e.cursor = Math.min(e.value.length, e.cursor + 1);
    else if (k === 'home') e.cursor = 0;
    else if (k === 'end') e.cursor = e.value.length;
    else if (k.length === 1 && k >= ' ') { e.value = e.value.slice(0, e.cursor) + k + e.value.slice(e.cursor); e.cursor++; }
  }

  function reviewerKey(k, r) {
    if (r._wait) {
      if (k === 's') ui.confirm = { text: `Stop waiting on ${r.key}'s PRs? Their labels stay as they are.`, yes: () => { actions.stopWait(r); flash(`${r.key} no longer waits on its PRs.`); } };
      else if (k === 'a' && r.ticketUrl) openIt(r.ticketUrl);
      else if (k === 'enter') openDetails(r);
      return undefined;
    }
    if (k === 'o') prsOf(r).forEach(p => openIt(p.url));
    else if (k === 'a' && r.ticketUrl) openIt(r.ticketUrl);
    else if (k === 'enter') openDetails(r);
    else if (k === 'x' && view() === HISTORY && r.pr) openIt(r.briefDir || r.pr.url);
    else if (k === 'x' && view() === HISTORY && r.status === 'done') openIt(r.reportPath);
    else if (k === 'v' && view() === HISTORY && !r.pr && r.prs?.length) { // not a row of the old fix feature
      const n = r.prs.length + (r.contextPrs?.length || 0);
      ui.confirm = { text: `Review ${r.ticket} again? A quick review of the same ${plural(n, 'PR')} starts under ${r.ticket}; no tags change.`, yes: () => {
        flash(`Re-review of ${r.ticket}: looking up its PRs. The Log says how it goes.`);
        actions.reReview(r).catch(e => flash(`Couldn't start the review: ${e.message}`));
      } };
    }
    else if (k === 's' && view() === RUNNING && r.phase === 'publishing') flash(`${r.ticket}: its review is being posted and can't be stopped part-way.`);
    else if (k === 's' && view() === RUNNING && (r.status === 'running' || r.status === 'preparing')) {
      ui.confirm = { text: reviewer.stopText(r), yes: () => actions.stop('reviewer', r) };
    }
  }

  function builderKey(k, w) {
    const prs = w.prs?.length ? w.prs : (w.repos || []).filter(r => r.pr).map(r => r.pr);
    if (k === 'o') prs.forEach(p => openIt(p.url));
    else if (k === 'a' && w.url) openIt(w.url);
    else if (k === 'enter') openDetails(w);
    else if (k === 'x') openIt(view() === HISTORY && w.plan && fs.existsSync(w.plan) ? w.plan : w.briefDir);
    else if (k === 's' && view() === RUNNING) {
      const yours = (w.repos || []).find(r => r.continued);
      ui.confirm = { text: `Stop ${w.key}? It stops before its next push, PR, tag or turn, and '${app.cfg.builder.tags.inProgress}' comes off.${yours ? ` Any commits the session made on your branch ${yours.branch} and didn't push are kept on a local prowl/kept-… branch.` : ''}`, yes: () => actions.stop('builder', w) };
    } else if (k === 'w' && view() === HISTORY) {
      if (!w.ref) return flash(`${w.key} has no ticket to follow.`);
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
    // The Update Notes and the key list scroll by a number of their own: a line, a page (the body less one row), or to an end.
    const moved = { up: -1, down: 1, pageup: -Math.max(1, ui.bodyH - 1), pagedown: Math.max(1, ui.bodyH - 1), home: -Infinity, end: Infinity }[k];
    if (ui.notes) {
      if (moved !== undefined) ui.notes.scroll = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, ui.notes.scroll + moved));
      else ui.notes = null;
      return undefined;
    }
    if (offerOpen()) return offerKey(k);
    if (ui.confirm) {
      const c = ui.confirm;
      const yes = c.key || 'y';
      if ([yes, 'n', 'esc'].includes(k)) { ui.confirm = null; if (k === yes) c.yes(); }
      return undefined;
    }
    if (ui.edit?.form) {
      // Typing in one of a Needs-you form's rows: ↑↓ move on, esc goes back to the top, enter submits.
      const e = ui.edit;
      if (k === 'up' || k === 'down' || k === 'esc') return formMove(k === 'esc' ? 'top' : k);
      editKey(k);
      const it = currentItem();
      if (it && k !== 'enter') setText(formOf(it), e.field, e.value);
      if (it) focusForm(it);
      return undefined;
    }
    if (ui.edit) return editKey(k);
    if (ui.menu) return menuKey(k);
    if (ui.keys) {
      if (moved !== undefined) { ui.keys.scroll = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, ui.keys.scroll + moved)); return undefined; }
      ui.keys = null;
      if (k === '/' || k === 'esc') return undefined; // anything else closes the list and does its job
    }
    // The details, when they are open in this view, take their keys before Prowl's own (p is the prompt there, not pause).
    const det = detOf();
    if (det && det.view === view() && detailKey(k, det)) return undefined;
    if (k === '/') { ui.keys = { scroll: 0 }; return undefined; }
    if (k === 'tab' || k === 'R' || k === 'B') {
      const to = k === 'R' ? 'reviewer' : k === 'B' || ui.side === 'reviewer' ? 'builder' : 'reviewer';
      if (visible(to)) ui.side = to;
      else if (k === 'B') flash('The Builder is off: turn it on in Config (4).');
      return undefined;
    }
    if (k.length === 1 && k >= '1' && k <= String(TABS.length)) { if (hasView(Number(k) - 1)) ui.view[ui.side] = Number(k) - 1; return undefined; }
    if (k === 'right' || k === 'left') {
      const by = k === 'right' ? 1 : TABS.length - 1;
      do ui.view[ui.side] = (view() + by) % TABS.length; while (!hasView(view()));
      return undefined;
    }
    // The scroll keys go to the pane in front, as the last frame painted it; ↑ ↓ too where nothing can be selected (the Log).
    if (ui.front?.sig === frontSig() && (SCROLL_KEYS.includes(k) || (ui.front.arrows && (k === 'up' || k === 'down')))) { scrollPane(ui.front.id, k); return undefined; }
    if (SCROLL_KEYS.includes(k)) return undefined;
    if ((k === 'up' || k === 'down') && currentItem()) return formMove(k); // Needs you: through the form
    if ((k === 'up' || k === 'down') && view() === RUNNING && ui.picked[ui.side]) {
      // From where the remembered row is now: rows that came or went since the last frame don't shift the move.
      const now = pickedAt(ui.side === 'reviewer' ? runningRows() : live(ui.side));
      if (now >= 0) sel()[RUNNING] = now;
    }
    if (k === 'up' || k === 'down') ui.picked[ui.side] = null; // the selection moves: Running remembers the new row
    if (k === 'up') { sel()[view()] = Math.max(0, sel()[view()] - 1); return undefined; }
    if (k === 'down') { sel()[view()]++; return undefined; }
    if (k === 'q') {
      const [n, setup] = [allLive(), settingUp().length];
      if (!n && !setup) return actions.quit();
      const text = [setup && `${plural(setup, 'review')} being set up: quit now and no session starts for them; a tagged ticket stays tagged for the next launch.`,
        n && `${plural(n, 'session')} still running. They keep going in the background and reappear next launch.`].filter(Boolean).join(' ');
      ui.confirm = { text: `${text} Press q again to quit.`, key: 'q', yes: actions.quit };
      return undefined;
    }
    if (k === 'e') return toggleSide();
    if (k === 'n') return ui.side === 'builder' ? newBuild() : newReview();
    if (k === 'r') { actions.pollNow(ui.side); flash(isOn(ui.side) ? `Polling the ${NAMES[ui.side]} now.` : `The ${NAMES[ui.side]} is off: e turns it on.`); return undefined; }
    if (k === 'p') { actions.togglePause(ui.side); flash(side().paused ? `${NAMES[ui.side]} paused: running sessions carry on, nothing new starts.` : 'Resumed.'); return undefined; }
    if (view() === STATS) { if (k === 't') ui.statsRange = (ui.statsRange + 1) % RANGES.length; return undefined; }
    if (view() === CONFIG) return configKey(k);
    if (view() === NEEDS) return needsKey(k);
    const list = view() === RUNNING ? (ui.side === 'reviewer' ? runningRows() : live(ui.side)) : view() === HISTORY ? history(ui.side) : [];
    // In Running the selected row is the remembered one: rows that came or went since the last frame don't shift what a key acts on.
    const r = view() === RUNNING && ui.picked[ui.side] ? list[pickedAt(list)] : list[sel()[view()]];
    if (!r) return undefined;
    return ui.side === 'reviewer' ? reviewerKey(k, r) : builderKey(k, r);
  }

  /**
   * A mouse event. The wheel moves like ↑↓, and the pointer lights up what's clickable under it (hovered). With the
   * left button, a press and release in place is a click (what's under it, hitAt), and a drag selects text,
   * highlighted, which is copied to the clipboard when the button is let go.
   */
  function onMouse({ mouse: b, x, y, release }) {
    if (!mouseOn()) { ui.hover = null; ui.drag = null; return undefined; } // the mouse is the terminal's: a report still in flight is dropped
    if (b & 64) { // the wheel: 3 lines a notch of the pane under the pointer (in the Log, anywhere); elsewhere it moves the selection
      if (release || ui.edit) return undefined;
      if (ui.menu) return menuKey(b & 1 ? 'down' : 'up');
      const same = ui.sig === frontSig() && !ui.confirm; // the frame is still what's on screen
      const id = same ? ui.frame[y]?.pane || (ui.front?.arrows ? ui.front.id : null) : null;
      if (id) { scrollPane(id, b & 1 ? 3 : -3); return undefined; }
      const over = ui.notes || ui.keys; // the Update Notes and the key list scroll 3 lines a notch too
      if (over) { over.scroll = Math.max(0, over.scroll + (b & 1 ? 3 : -3)); return undefined; }
      return onKey(b & 1 ? 'down' : 'up');
    }
    ui.hover = { x, y };
    if (b & 32) { // moved: with the left button down, a drag
      if ((b & 3) === 0 && ui.drag) Object.assign(ui.drag, { x1: x, y1: y, moved: ui.drag.moved || x !== ui.drag.x0 || y !== ui.drag.y0 });
      return undefined;
    }
    if ((b & 3) !== 0) return undefined; // the left button only
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
    for (const [style, raw, url, hit, hover] of row) {
      const text = clean(raw);
      const [a, b] = [Math.max(0, Math.min(text.length, from - at)), Math.max(0, Math.min(text.length, to - at))];
      for (const [part, st] of [[text.slice(0, a), style], [text.slice(a, b), `${style}${ST.cursor}`], [text.slice(b), style]]) if (part) segs.push([st, part, url, hit, hover]);
      at += text.length;
    }
    return Object.assign(segs, { bg: row.bg, hit: row.hit, footer: row.footer, pane: row.pane, main: row.main, menu: row.menu });
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
    const row = ui.frame[y];
    if (ui.edit && !ui.edit.form && !row?.footer) return undefined; // while typing, only the bar's buttons (a form's rows too)
    if (ui.notes) { ui.notes = null; return undefined; }
    if (!row || (ui.confirm && !row.footer)) return undefined;
    if (ui.menu && !row.menu && !row.footer) { ui.menu = null; return undefined; } // a click elsewhere closes the list, nothing changed
    return hitAt(row, x)?.();
  }
  const input = k => (typeof k === 'object' ? (k.paste != null ? onPaste(k.paste) : onMouse(k)) : onKey(k));

  if (io.headless) {
    return {
      restore() {},
      key(k) { onKey(k); },
      /** A bracketed paste of `text`. */
      paste(text) { onPaste(text); },
      /** A click (button 0) or wheel turn (64 up, 65 down) at column `x`, row `y` of the last frame, from 0. */
      mouse(x, y, button = 0) { onMouse({ mouse: button, x, y, release: false }); if (button < 64) onMouse({ mouse: button, x, y, release: true }); },
      /** The pointer moved to (x, y), no button down. */
      hover(x, y) { onMouse({ mouse: 35, x, y, release: false }); },
      /** A drag with the left button from (x0, y0) to (x1, y1), let go there. */
      drag(x0, y0, x1, y1) { for (const [m, x, y, release] of [[0, x0, y0, false], [32, x1, y1, false], [0, x1, y1, true]]) onMouse({ mouse: m, x, y, release }); },
      /** The frame as plain text lines, at `W` by `H` columns and rows. */
      /** The state the terminal's tab would show (0, 2, 3 or 4), and the sequence that says so. */
      progress: () => progressState(),
      /** The terminal's title, as it would be written. */
      titleText: () => titleText(),
      frame(W = 80, H = 30, ansi = false) { return rows(false, W, H).map(r => (ansi ? draw(r, W) : draw(r, W).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x1b]*\x1b\\/g, ''))); },
      ui,
    };
  }
  // Save the tab title and set it, alternate screen, hidden cursor, and the mouse reported: clicks, drags, the wheel
  // and the pointer moving, for hover (any-motion tracking, SGR encoding).
  out.write('\x1b[22;0t\x1b[?1049h\x1b[?25l\x1b[?2004h'); // …and bracketed paste; paint() sets the title and asks for the mouse
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  let held = ''; // the start of a paste or of an escape sequence whose end hasn't arrived yet
  let lone; // the timer that reads a held escape as it is: esc alone is the key, with nothing to follow
  let skip = false; // the start of a sequence was dropped: its end is skipped when it arrives
  let skipSince = 0;
  const read = (chunk, asIs = false) => {
    clearTimeout(lone);
    // For a second at most: after that what arrives is typing, not the end of a sequence dropped long ago.
    if (skip && chunk) { if (Date.now() - skipSince < 1000) [chunk, skip] = skipRest(chunk); else skip = false; }
    let [data, rest] = asIs ? [held, ''] : holdBack(held + chunk);
    if (asIs) { [data, skip] = timedOut(held); skipSince = Date.now(); }
    held = rest;
    if (held && !held.startsWith('\x1b[200~')) lone = setTimeout(() => read('', true), 50);
    let moved = true; // only the pointer moving: repainted at most every 30ms, so a quick sweep can't flood the terminal
    for (const k of keys(data)) { input(k); if (!(k.mouse & 32)) moved = false; }
    if (!moved || Date.now() - painted > 30) paint(false);
  };
  stdin.on('data', chunk => read(chunk));
  out.on('resize', () => paint(false));
  const timer = setInterval(() => paint(true), 100);
  paint(true);

  return {
    restore() {
      clearInterval(timer);
      clearTimeout(lone);
      if (progress) out.write(progressSeq(0));
      // Its own title cleared first, then the saved one restored: a terminal without a title stack falls back to its default.
      out.write('\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?2026l\x1b[?25h\x1b[?1049l\x1b]0;\x07\x1b[23;0t');
      try { stdin.setRawMode(false); } catch { /* not a TTY any more */ }
      stdin.pause();
    },
  };
}
