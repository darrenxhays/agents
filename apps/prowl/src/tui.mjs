import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR, CONFIG_PATH } from './config.mjs';
import { createMascot, wrap } from './mascot.mjs';
import { openExternal } from './proc.mjs';

const ST = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', title: '\x1b[1;38;5;220m', yellow: '\x1b[38;5;220m',
  green: '\x1b[38;5;114m', red: '\x1b[38;5;203m', orange: '\x1b[38;5;208m', link: '\x1b[4;38;5;75m', cyan: '\x1b[38;5;80m',
  grey: '\x1b[38;5;244m', tabOn: '\x1b[1;38;5;16;48;5;220m', tabOff: '\x1b[38;5;250m', cursor: '\x1b[7m',
};
const LEVEL = { ok: ST.green, info: ST.grey, warn: ST.yellow, error: ST.red };
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const TABS = ['Running', 'History', 'Config', 'Log'];

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const https = v => /^https:\/\/\S+$/.test(v) || 'must be an https:// URL';
const ADO = c => c.taskBoard === 'ado';
const JIRA = c => c.taskBoard === 'jira';
const opens = 'enter opens it. Updates never overwrite your edits.';
const FIELDS = [
  // The user's config files: enter opens one in its default app.
  { file: CONFIG_PATH, label: 'Settings file', help: `Every setting on this page, as JSON. ${opens}` },
  { file: path.join(CONFIG_DIR, 'review.md'), label: 'Review rules', help: `Reviewer stance, severity definitions, and the verdict each severity gives. Applies from the next review. ${opens}` },
  { file: path.join(CONFIG_DIR, 'axis-catalog.md'), label: 'Review checklists', help: `What reviewers check: the review axes and their checklists. Applies from the next review. ${opens}` },
  { file: path.join(CONFIG_DIR, 'output.md'), label: 'Output templates', help: `How everything posted on GitHub looks: banner, review body, comments, replies, approvals-off comment. Applies from the next review. ${opens}` },
  { key: 'taskBoard', label: 'Task board', type: 'enum', values: ['ado', 'jira'], names: { ado: 'Azure DevOps', jira: 'Jira' }, help: 'Where tickets are watched: Azure DevOps or Jira Cloud. enter switches. Each keeps its own boards.' },
  { key: 'ado.org', label: 'Azure DevOps org', type: 'text', when: ADO, help: 'Organization URL, e.g. https://dev.azure.com/your-org. Signed in with az login.', valid: https },
  { key: 'jira.site', label: 'Jira site', type: 'text', when: JIRA, help: 'Your Jira Cloud URL, e.g. https://yourcompany.atlassian.net.', valid: v => https(v) === true ? true : 'must be an https:// URL, e.g. https://yourcompany.atlassian.net' },
  { key: 'jira.email', label: 'Jira email', type: 'text', when: JIRA, help: 'The email you sign in to Atlassian with.', valid: v => /^[^\s@"\\]+@[^\s@"\\]+$/.test(v) || 'must be an email address' },
  { key: 'jira.token', label: 'Jira API token', type: 'secret', when: JIRA, help: 'Create one at id.atlassian.com > Security > API tokens. Kept in your OS credential store, never in the config file.' },
  'boards',
  // Jira calls tags labels: `jira` replaces the label and help shown when it is the task board.
  { key: 'tags.trigger', label: 'Trigger tag', type: 'text', help: 'Tickets carrying this tag, or a near-miss spelling of it, get reviewed.',
    jira: { label: 'Trigger label', help: 'Issues carrying this label, or a near-miss spelling of it, get reviewed.' } },
  { key: 'tags.inProgress', label: 'In-progress tag', type: 'text', help: 'Set when a review starts. Colour it yellow in board settings > Cards > Tag colors.',
    jira: { label: 'In-progress label', help: 'Set when a review starts. Spaces become dashes (In-Review).' } },
  { key: 'tags.done', label: 'Done tag', type: 'text', help: 'Set when a review finishes. Re-add the trigger tag to ask for a re-review.',
    jira: { label: 'Done label', help: 'Set when a review finishes. Spaces become dashes. Re-add the trigger label to ask for a re-review.' } },
  { key: 'tagMatchMaxTypos', label: 'Tag typo tolerance', type: 'int', min: 0, max: 3, help: 'Typos (wrong, missing, extra or swapped letters) still treated as the trigger tag. Case, spaces and punctuation are always ignored. 0 = exact.',
    jira: { label: 'Label typo tolerance', help: 'Typos (wrong, missing, extra or swapped letters) still treated as the trigger label. Case, spaces and punctuation are always ignored. 0 = exact.' } },
  { key: 'githubOwner', label: 'GitHub org', type: 'text', help: 'Open PRs whose title or description mentions the ticket (AB#123 or PROJ-123) are searched for here. Your own PRs are always skipped.' },
  { key: 'pollSeconds', label: 'Poll every (seconds)', type: 'int', min: 30, max: 86400, help: 'How often the boards are checked. r polls now.' },
  { key: 'maxConcurrentReviews', label: 'Max parallel reviews', type: 'int', min: 1, max: 10, help: "Extra tickets stay tagged until a slot frees, so a teammate's poller can take them." },
  { key: 'workDir', label: 'Projects Directory', type: 'text', help: 'Reviews run here and load its CLAUDE.md, e.g. your projects root. A PR repo not cloned here is cloned before its review.', valid: v => isDir(v) || 'folder not found' },
  { key: 'claude.model', label: 'Model', type: 'text', help: 'Model for review sessions.' },
  { key: 'claude.effort', label: 'Effort', type: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'], help: 'Reasoning effort for review sessions. enter cycles.' },
  { key: 'claude.permissionMode', label: 'Permission mode', type: 'enum', values: ['auto', 'bypassPermissions'], help: 'auto lets a safety classifier block risky actions. bypassPermissions lets reviews run anything: not recommended, reviews read text written by PR authors.' },
  { key: 'approvals', label: 'Approve PRs', type: 'bool', help: 'on: a PR with no blocking findings gets a GitHub approval. off: Prowl comments that it found no blocking issues, and a human approves (text in Output templates).' },
  { key: 'dryRun', label: 'Dry run', type: 'bool', help: 'Log what would be reviewed without changing tags or starting reviews.' },
  { key: 'autoUpdate', label: 'Auto-update', type: 'bool', help: 'Install a newer Prowl release before launching. It waits while reviews from an earlier launch are still running.' },
];

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
const pad2 = n => String(n).padStart(2, '0');
const clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
const dur = ms => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h}h${pad2(m)}m` : `${m}m${pad2(s % 60)}s`; };
const stamp = ms => { const d = new Date(ms); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const time = ms => new Date(ms).toTimeString().slice(0, 8);
const spin = () => SPIN[Math.floor(Date.now() / 100) % SPIN.length];
const cursor = on => (on ? [ST.yellow, ' ❯ '] : ['', '   ']);
const rule = W => [[ST.grey, '─'.repeat(W)]];
const getPath = (o, k) => k.split('.').reduce((v, p) => v?.[p], o);
const setPath = (o, k, val) => { const ps = k.split('.'); const last = ps.pop(); ps.reduce((v, p) => (v[p] ??= {}), o)[last] = val; };

/** A row is a list of [style, text, url?] segments; draw() clips it to `w` columns and pads the rest. */
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
  return out + ' '.repeat(w - used);
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
 * Full-screen terminal UI. `app` is read every frame; `actions` = { pollNow, togglePause, stop, saveConfig, saveToken, quit }.
 */
export function startTui(app, actions) {
  const out = process.stdout;
  const owl = createMascot();
  const ui = { tab: 0, sel: [0, 0, 0, 0], edit: null, confirm: null, flash: '', flashUntil: 0, notes: app.notes ? { scroll: 0 } : null };
  const flash = text => { ui.flash = text; ui.flashUntil = Date.now() + 4000; };
  const clampSel = (tab, n) => (ui.sel[tab] = Math.max(0, Math.min(ui.sel[tab], n - 1)));

  // Hoot sleeps unless something is happening: a poll, a running review, or something he has to say.
  function mood(said) {
    if (said?.mood) return said.mood;
    if (app.polling) return 'poll';
    if (app.running().length) return 'review';
    return said ? 'idle' : 'sleep';
  }

  function titleBar(W) {
    const left = [[ST.title, ' ◆ Prowl '], [ST.grey, `· ${app.tracker().name}${app.me ? ` · ${app.me}` : ''}`]];
    const status = app.polling ? [ST.yellow, `${spin()} checking boards`]
      : app.paused ? [ST.grey, '‖ paused']
        : [ST.grey, `next poll in ${clock(app.nextPoll - Date.now())}`];
    const right = [
      ...(app.dryRun() ? [[ST.tabOn, ' DRY RUN '], ['', ' ']] : []),
      ...(app.lastError ? [[ST.red, '● error, see Log  ']] : []),
      status, ['', ' '],
    ];
    return spread(left, right, W);
  }

  function tabBar() {
    const counts = [app.running().length, app.finished().length];
    const segs = [['', ' ']];
    TABS.forEach((t, i) => segs.push([i === ui.tab ? ST.tabOn : ST.tabOff, ` ${i + 1} ${t}${counts[i] != null ? ` (${counts[i]})` : ''} `], ['', ' ']));
    return segs;
  }

  function runningView(W, H) {
    const runs = app.running();
    if (!runs.length) {
      const n = app.boards().length;
      return [[], [[ST.grey, n
        ? `  No reviews running. Watching ${plural(n, 'board')} for '${app.cfg.tags.trigger}'.`
        : '  No boards configured yet: press 3 for Config, then a to add one.']]];
    }
    const sel = clampSel(0, runs.length);
    const rows = windowed(runs, sel, Math.min(runs.length, Math.max(3, Math.floor(H / 3)))).map(({ item: r, i }) => {
      const stopping = r.status === 'stopping';
      const left = [cursor(i === sel), [stopping ? ST.red : ST.yellow, `${stopping ? '■' : spin()} `], [ST.bold, `${r.ticket}  `]];
      const right = [[ST.grey, `  ${plural(r.prs.length, 'PR')} · ${r.reviewNo > 1 ? `re-review #${r.reviewNo}` : 'first review'} · ${dur(Date.now() - r.startedAt)} `]];
      const title = trunc(stopping ? `stopping… ${r.title}` : r.title, W - width(left) - width(right) - 1);
      return spread([...left, ['', title]], right, W);
    });
    const r = runs[sel];
    rows.push(rule(W), [[ST.bold, ` Activity · ${r.ticket}  `], [ST.grey, r.prs.map(p => `${p.repo.split('/')[1]}#${p.number}`).join('  ')]]);
    const acts = (r._activity || []).slice(-Math.max(1, H - rows.length));
    if (!acts.length) rows.push([[ST.grey, '  starting…']]);
    for (const a of acts) {
      if (a.error) rows.push([[ST.red, `  ${a.text}`]]);
      else if (a.sub) rows.push([[ST.grey, '    ↳ '], [ST.grey, a.text]]);
      else rows.push([[ST.cyan, '  • '], [a.said ? '' : ST.dim, a.text]]);
    }
    return rows;
  }

  function verdict(r) {
    if (r.status === 'failed') return [ST.red, 'FAILED'];
    if (r.status === 'stopped') return [ST.grey, 'STOPPED'];
    const v = String(r.summary?.verdict || 'NO VERDICT').toUpperCase();
    return [v.startsWith('BLOCK') ? ST.red : v.startsWith('REQUEST') ? ST.orange : v.startsWith('APPROVE') ? ST.green : ST.grey, v];
  }

  function details(r) {
    const label = t => [ST.grey, `  ${t.padEnd(8)}`];
    const rows = [];
    rows.push(r.status === 'done'
      ? [label('Report'), [ST.link, r.reportPath, pathToFileURL(r.reportPath).href]]
      : [label('Report'), [ST.grey, '(none)']]);
    rows.push([label('Ticket'), [ST.link, r.ticketUrl, r.ticketUrl]]);
    r.prs.slice(0, 4).forEach((p, i) => rows.push([label(i ? '' : 'PRs'), [ST.link, p.url, p.url], [ST.grey, `  ${p.title}`]]));
    if (r.prs.length > 4) rows.push([label(''), [ST.grey, `+${r.prs.length - 4} more (o opens all)`]]);
    const how = r.status === 'failed' ? [ST.red, `failed: ${r.error}`]
      : r.status === 'stopped' ? [ST.grey, 'stopped by you']
        : [ST.green, `done in ${dur(r.endedAt - r.startedAt)}${r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ''}`];
    rows.push([label('Status'), how, [ST.yellow, r.pendingTag != null ? '  · ticket tag update pending' : '']]);
    return rows;
  }

  function historyView(W, H) {
    const runs = app.finished();
    if (!runs.length) return [[], [[ST.grey, '  No finished reviews yet.']]];
    const sel = clampSel(1, runs.length);
    const detail = details(runs[sel]);
    const rows = windowed(runs, sel, Math.max(1, H - detail.length - 1)).map(({ item: r, i }) => {
      const s = r.summary || {};
      const [vs, vt] = verdict(r);
      const counts = r.status !== 'done' ? []
        : [['C', 'critical', ST.red], ['H', 'high', ST.orange], ['M', 'medium', ST.yellow], ['L', 'low', ST.grey], ['N', 'nit', ST.grey]]
          .map(([l, k, style]) => [Number(s[k]) > 0 ? style : ST.dim, `${l}${s[k] ?? '?'} `]);
      const head = [
        cursor(i === sel), [ST.grey, `${stamp(r.endedAt)}  `], [ST.bold, r.ticket.padEnd(11)], [vs, vt.padEnd(18)], ...counts,
        [ST.grey, `${r.reviewNo > 1 ? `· fixed ${s.fixed ?? '?'} · re-review #${r.reviewNo}` : ''}  `],
      ];
      return [...head, ['', trunc(r.title, W - width(head))]];
    });
    return [...rows, rule(W), ...detail];
  }

  const BOARD_HELP = {
    ado: ['"Project / Team": that team\'s board (its area paths) is polled.', 'Add a board as "Project / Team", e.g. My Project / My Team.'],
    jira: ['A Jira board, by name or id: its open issues are polled.', 'Add a Jira board by its name (e.g. My Team board) or its id (the number in its URL).'],
  };

  function configRows() {
    const [one, add] = BOARD_HELP[app.cfg.taskBoard];
    return FIELDS.filter(f => !f.when || f.when(app.cfg)).flatMap(f => (f !== 'boards' ? [JIRA(app.cfg) && f.jira ? { ...f, ...f.jira } : f] : [
      ...app.boards().map((b, i) => ({ board: i, label: `Board ${i + 1}`, help: `${one} enter edits · d deletes.` })),
      { addBoard: true, label: '+ Add board', help: add },
    ]));
  }

  function shown(f) {
    const c = app.cfg;
    if (f.board != null) return app.tracker().boardLabel(app.boards()[f.board]);
    if (f.addBoard) return '';
    if (f.type === 'secret') return app.hasToken() ? 'saved ••••••••' : 'not set: enter to add';
    if (f.type === 'bool') return getPath(c, f.key) ? 'on' : 'off';
    if (f.names) return f.names[getPath(c, f.key)] || String(getPath(c, f.key));
    return String(getPath(c, f.key));
  }

  function configView(W, H) {
    const fields = configRows();
    const sel = clampSel(2, fields.length);
    const rows = [[[ST.grey, '  Saved to '], [ST.link, CONFIG_PATH, pathToFileURL(CONFIG_PATH).href], [ST.grey, ' on every change. The next poll uses it.']], []];
    for (const { item: f, i } of windowed(fields, sel, Math.max(1, H - 6))) {
      const e = i === sel && ui.edit;
      const v = e && e.secret ? '•'.repeat(e.value.length) : e?.value;
      const value = e
        ? [[ST.yellow, v.slice(0, e.cursor)], [ST.cursor, v[e.cursor] || ' '], [ST.yellow, v.slice(e.cursor + 1)]]
        : f.file ? [[ST.link, f.file, pathToFileURL(f.file).href]] : [['', shown(f)]];
      rows.push([cursor(i === sel), [f.addBoard ? ST.green : ST.grey, f.label.padEnd(24)], ...value]);
    }
    rows.push([], ui.edit?.error ? [[ST.red, `  ${ui.edit.error}`]] : [[ST.grey, `  ${fields[sel].help}`]]);
    const variants = Object.entries(app.tagVariants).map(([p, v]) => `${p}: ${v.join(', ') || 'none yet'}`).join('  ·  ');
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

  const logView = (W, H) => app.log.slice(-H).map(l => [[ST.grey, `${time(l.t)} `], [LEVEL[l.level], `${l.level.padEnd(5)} `], ['', l.msg]]);

  function footer(W) {
    if (ui.notes) return [[ST.grey, ' ↑↓ scroll · any other key closes the Update Notes']];
    if (ui.confirm) return [[ST.title, ` ${ui.confirm.text} `], [ST.grey, ' y yes · n no']];
    if (ui.edit) return [[ST.grey, ' enter save · esc cancel · ←→ move']];
    if (Date.now() < ui.flashUntil) return [[ST.green, ` ${ui.flash}`]];
    const hints = [' ↑↓ select · s stop · o open all PRs · a open ticket', ' ↑↓ select · enter open report · o open all PRs · a open ticket', ' ↑↓ select · enter edit · a add board · d delete board', ''];
    return spread([[ST.grey, hints[ui.tab]]], [[ST.grey, '←→ views · r poll now · p pause · q quit ']], W);
  }

  function paint(advance) {
    const W = Math.max(40, (out.columns || 100) - 1);
    const H = Math.max(12, out.rows || 30);
    const rows = [titleBar(W)];
    if (H >= 26) {
      const said = app.speech();
      rows.push(...owl.render(W, 7, mood(said), said?.text || '', advance));
    }
    rows.push(tabBar(), rule(W));
    const bodyH = H - rows.length - 1;
    const body = (ui.notes ? notesView : [runningView, historyView, configView, logView][ui.tab])(W, bodyH).slice(0, bodyH);
    while (body.length < bodyH) body.push([]);
    rows.push(...body, footer(W));
    out.write(`\x1b[?2026h\x1b[H${rows.map(r => draw(r, W)).join('\r\n')}\x1b[?2026l`);
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
    if (index == null) ui.sel[2] = configRows().findIndex(f => f.addBoard);
    startEdit(index == null ? '' : app.tracker().boardLabel(boards[index]), v => {
      const b = parseBoard(v);
      if (typeof b === 'string') return b;
      if (index == null) boards.push(b);
      else boards[index] = b;
      saved('Board saved. r polls now.');
      return '';
    });
  }

  function configKey(k) {
    const f = configRows()[ui.sel[2]];
    const c = app.cfg;
    if (k === 'a') return editBoard(null);
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
    if (f.type === 'bool') { setPath(c, f.key, !cur); return saved(); }
    if (f.type === 'enum') { setPath(c, f.key, f.values[(f.values.indexOf(cur) + 1) % f.values.length]); return saved(); }
    return startEdit(String(cur), v => {
      if (!v) return 'Cannot be empty';
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

  function onKey(k) {
    if (k === 'ctrl-c') return actions.quit();
    if (ui.notes) {
      if (k === 'up' || k === 'down') ui.notes.scroll += k === 'up' ? -1 : 1;
      else ui.notes = null;
      return undefined;
    }
    if (ui.confirm) {
      const c = ui.confirm;
      if (['y', 'n', 'esc'].includes(k)) { ui.confirm = null; if (k === 'y') c.yes(); }
      return undefined;
    }
    if (ui.edit) return editKey(k);
    if (k.length === 1 && k >= '1' && k <= '4') { ui.tab = Number(k) - 1; return undefined; }
    if (k === 'tab' || k === 'right') { ui.tab = (ui.tab + 1) % TABS.length; return undefined; }
    if (k === 'left') { ui.tab = (ui.tab + TABS.length - 1) % TABS.length; return undefined; }
    if (k === 'up') { ui.sel[ui.tab] = Math.max(0, ui.sel[ui.tab] - 1); return undefined; }
    if (k === 'down') { ui.sel[ui.tab]++; return undefined; }
    if (k === 'q') {
      const n = app.running().length;
      if (!n) return actions.quit();
      ui.confirm = { text: `${plural(n, 'review')} still running. They keep going in the background and reappear next launch. Quit?`, yes: actions.quit };
      return undefined;
    }
    if (k === 'r') { actions.pollNow(); flash('Polling now.'); return undefined; }
    if (k === 'p') { actions.togglePause(); flash(app.paused ? 'Paused: running reviews carry on, no new ones start.' : 'Resumed.'); return undefined; }
    if (ui.tab === 2) return configKey(k);
    const r = (ui.tab === 0 ? app.running() : ui.tab === 1 ? app.finished() : [])[ui.sel[ui.tab]];
    if (!r) return undefined;
    if (k === 'o') r.prs.forEach(p => openExternal(p.url));
    else if (k === 'a') openExternal(r.ticketUrl);
    else if (k === 'enter' && ui.tab === 1 && r.status === 'done') openExternal(r.reportPath);
    else if (k === 's' && ui.tab === 0 && r.status === 'running') {
      ui.confirm = { text: `Stop the review of ${r.ticket}? Its '${app.cfg.tags.inProgress}' tag is removed; re-tag to run it again.`, yes: () => actions.stop(r) };
    }
    return undefined;
  }

  out.write('\x1b[?1049h\x1b[?25l'); // alternate screen, hidden cursor
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', data => { for (const k of keys(data)) onKey(k); paint(false); });
  out.on('resize', () => paint(false));
  const timer = setInterval(() => paint(true), 100);
  paint(true);

  return {
    restore() {
      clearInterval(timer);
      out.write('\x1b[?2026l\x1b[?25h\x1b[?1049l');
      try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ }
      process.stdin.pause();
    },
  };
}
