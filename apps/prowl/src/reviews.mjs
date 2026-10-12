import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { HOME, writeJson } from './config.mjs';
import { frontMatter } from './match.mjs';
import { spawnCli, isAlive, killTree, processStart } from './proc.mjs';

export const REPORTS_DIR = path.join(HOME, 'reports');
const CONFIG_DIR = path.join(HOME, 'config'); // the user's overrides of prowl-review's config files
const LOGS_DIR = path.join(HOME, 'logs');
const STATE_PATH = path.join(HOME, 'state.json');
const exited = new Set(); // pids of reviews started by this process that have exited

export function loadState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { runs: [], failures: {} };
    throw new Error(`Can't read ${STATE_PATH}: ${e.message}`);
  }
  for (const run of state.runs) { // reviews from before Jira support were all Azure DevOps work items
    if (run.ticket) continue;
    Object.assign(run, { tracker: 'ado', ticket: `AB#${run.workItem}`, ticketUrl: run.adoUrl, ref: { org: run.org, project: run.project, id: run.workItem } });
    for (const k of ['workItem', 'adoUrl', 'org', 'project']) delete run[k];
  }
  for (const [k, n] of Object.entries(state.failures)) {
    if (/^\d+$/.test(k)) { state.failures[`AB#${k}`] = n; delete state.failures[k]; }
  }
  return state;
}

// Fields starting with _ are in-memory only (log position, parsed activity).
export const saveState = state => writeJson(STATE_PATH, state, (k, v) => (k.startsWith('_') ? undefined : v));

export function alive(run) {
  if (exited.has(run.pid) || !isAlive(run.pid)) return false;
  // A pid saved by an earlier launch can belong to another program by now: after a reboot or sign-out, and
  // sooner on Windows, which reuses pids quickly. It is still the review only if it started with the review.
  if (run._ours === undefined) {
    const started = run._spawned ? null : processStart(run.pid);
    run._ours = started === null || started < run.startedAt + 10_000; // unreadable: trust the pid
  }
  return run._ours;
}

/**
 * Starts a detached headless Claude Code session running prowl-review on the PRs. It outlives this
 * process; output goes to a log file this app tails, so a restart picks running reviews back up.
 */
export function startReview(cfg, pluginDir, { tracker, ticket, prs, prior }) {
  const reviewNo = (prior?.reviewNo || 0) + 1;
  const id = `${ticket.key.replace(/[^A-Za-z0-9-]/g, '')}-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '')}-r${reviewNo}`;
  for (const dir of [REPORTS_DIR, LOGS_DIR, CONFIG_DIR]) fs.mkdirSync(dir, { recursive: true });
  const run = {
    id, tracker, ticket: ticket.key, ticketUrl: ticket.url, ref: ticket.ref, title: ticket.title, prs, reviewNo, priorId: prior?.id || null,
    startedAt: Date.now(), status: 'running', pid: null, pendingTag: null, reviewedPrs: [],
    reportPath: path.join(REPORTS_DIR, `${id}.md`),
    logPath: path.join(LOGS_DIR, `${id}.ndjson`),
    promptPath: path.join(LOGS_DIR, `${id}.prompt.md`),
  };
  let priorReport = '';
  if (prior) {
    try { priorReport = fs.readFileSync(prior.reportPath, 'utf8'); } catch { priorReport = '(the previous report file is missing)'; }
  }
  fs.writeFileSync(run.promptPath, buildPrompt({ ...run, prior, priorReport }));

  const stdin = fs.openSync(run.promptPath, 'r');
  const log = fs.openSync(run.logPath, 'a');
  const child = spawnCli('claude', [
    '-p', '--plugin-dir', pluginDir, '--add-dir', REPORTS_DIR, '--add-dir', CONFIG_DIR,
    '--model', cfg.claude.model, '--effort', cfg.claude.effort, '--permission-mode', cfg.claude.permissionMode,
    '--output-format', 'stream-json', '--verbose',
  ], {
    cwd: cfg.workDir, detached: true, stdio: [stdin, log, log],
    // prowl-review runs its reviewers as background subagents and ends its turn while they work. `claude -p`
    // stops background tasks still running 10 minutes after the last turn, which kills a large batch's
    // reviewers before anything is posted. Each finished subagent starts a new turn, so this is the longest
    // stretch with no subagent finishing.
    // optimization-note: a hung background command (e.g. a test runner in watch mode) holds the review open
    // for up to this long after its report is written; Stop ends it sooner.
    env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(60 * 60_000) },
  });
  fs.closeSync(stdin);
  fs.closeSync(log);
  run.pid = child.pid;
  run._spawned = true;
  child.on('error', e => { run.spawnError = e.message; exited.add(child.pid); });
  child.on('exit', () => exited.add(child.pid));
  child.unref();
  return run;
}

export function stopReview(run) {
  run.status = 'stopping';
  if (alive(run)) killTree(run.pid);
}

/** Reads new output from a review's log into run._activity; returns its final `result` event once present. */
export function readActivity(run) {
  run._activity ??= [];
  run._offset ??= 0;
  run._partial ??= '';
  run._decoder ??= new StringDecoder('utf8');
  let size;
  try { size = fs.statSync(run.logPath).size; } catch { return run._result; }
  if (size > run._offset) {
    const buf = Buffer.alloc(size - run._offset);
    const fd = fs.openSync(run.logPath, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, run._offset); } finally { fs.closeSync(fd); }
    run._offset = size;
    run._lastOutputAt = Date.now();
    const lines = (run._partial + run._decoder.write(buf)).split('\n');
    run._partial = lines.pop();
    for (const line of lines) parseLine(run, line);
    if (run._activity.length > 400) run._activity.splice(0, run._activity.length - 400);
  }
  return run._result;
}

function parseLine(run, line) {
  if (!line.trim()) return;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    run._activity.push({ text: line, error: true }); // stderr shares the log
    return;
  }
  const sub = Boolean(e.parent_tool_use_id);
  if (e.type === 'assistant') {
    for (const c of e.message?.content || []) {
      if (c.type === 'tool_use') run._activity.push({ sub, text: describeTool(c) });
      else if (c.type === 'text' && c.text.trim()) run._activity.push({ sub, said: true, text: c.text.trim().split('\n')[0] });
    }
  }
  if (e.type === 'result') run._result = e;
}

const describeTool = ({ name, input = {} }) =>
  `${name} ${input.description || input.command || input.skill || input.file_path || input.pattern || input.url || input.prompt || ''}`
    .replace(/\s+/g, ' ').trim();

/** Settles a review whose session has ended: status, cost, summary, and a fallback report if the agent wrote none. */
export function finalize(run) {
  const result = run._result;
  run.endedAt = Date.now();
  run.costUsd = result?.total_cost_usd ?? null;
  const ok = result?.subtype === 'success' && !result.is_error;
  const stderr = run._activity?.filter(a => a.error).at(-1)?.text;
  if (run.status === 'stopping') {
    run.status = 'stopped';
  } else if (ok && fs.existsSync(run.reportPath)) {
    run.status = 'done';
    run.summary = frontMatter(fs.readFileSync(run.reportPath, 'utf8'));
  } else {
    // A clean exit without the report is a failure too: the session can end "successfully" before prowl-review
    // has posted anything (e.g. its background reviewers were stopped).
    run.status = 'failed';
    run.error = run.spawnError
      || (ok && `the session ended without writing its report: ${(stderr || String(result.result || '')).slice(0, 300)}`)
      || (result && `${result.subtype}: ${String(result.result || '').slice(0, 300)}`)
      || stderr
      || 'the session ended without a result; see its log';
  }
}

/** The prompt (the agent's brief): the PR list for prowl-review, the ticket, the re-review brief and the report spec. */
export function buildPrompt({ ticket, title, ticketUrl, prs, reviewNo, reportPath, prior, priorReport }) {
  const lines = [
    `/prowl:prowl-review ${prs.map(p => p.url).join(' ')}`,
    '',
    '## Context from Prowl, the review poller',
    '',
    `- Ticket: ${ticket} "${title}" (${ticketUrl})`,
    `- This is review ${reviewNo} of this ticket${prior ? ', a RE-REVIEW' : ''}.`,
    '- It started automatically because the ticket was tagged for review. Nobody is watching this session: never stop to ask a question; make the reasonable call and note it in the report.',
  ];
  if (prior) lines.push('', ...reReviewBrief(prior, priorReport));
  lines.push('', ...reportSpec(ticket, reviewNo, reportPath, Boolean(prior)));
  return `${lines.join('\n')}\n`;
}

const reReviewBrief = (prior, report) => [
  '## This is a re-review',
  '',
  `The previous review (review ${prior.reviewNo}, finished ${new Date(prior.endedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC) produced the report below. The ticket has been tagged for review again, so the authors believe they have addressed it. On top of the normal prowl-review steps:`,
  '',
  '1. Add every finding from the previous report to the ledger as a prior finding. Re-verify each one against the current head of its PR and classify it as Fixed (cite the commit), Still open, or No longer applicable (code removed, PR merged or closed). These go through verifiers like any other finding.',
  '2. Do not post duplicates of prior findings. Reply on the existing comment thread instead, starting with the comment prefix from the signature config: "<prefix>Verified fixed in <sha>" and then resolve the thread (`gh api graphql`, resolveReviewThread), or "<prefix>Still open as of <sha>: <one line why>". The Step 8 re-run guard treats still-open prior findings as already posted.',
  '3. Post new inline comments only for findings that are new since the previous review.',
  "4. Each PR's verdict counts still-open prior findings as well as new ones.",
  '',
  '<previous-report>',
  report.trim(),
  '</previous-report>',
];

const reportSpec = (id, n, file, again) => [
  '## Report file (required, final step)',
  '',
  `After posting, write the review report to this exact path: ${file}`,
  '',
  'Start it with this front matter, filled in (counts are verified findings: new plus still-open prior ones):',
  '',
  '---',
  `ticket: ${id}`,
  `review: ${n}`,
  'verdict: <worst PR verdict, named as in the review config>',
  'critical: <n>',
  'high: <n>',
  'medium: <n>',
  'low: <n>',
  'nit: <n>',
  `fixed: <prior findings verified fixed${again ? '' : '; 0 on a first review'}>`,
  `stillOpen: <prior findings still open${again ? '' : '; 0 on a first review'}>`,
  '---',
  '',
  'Then these sections:',
  '1. Summary: the goal of the work, the batch verdict and the merge order, in a few sentences.',
  '2. Pull requests: a table of PR (link), title, author, verdict and posted review (link).',
  '3. Issues found: per PR, every verified finding with severity, title, file:line, a link to its posted comment (or to the review when it is in the review body; for a point someone else raised first, a link to their comment and to the reply, if any), the problem, the failure scenario and the suggested fix.',
  again
    ? '4. What was fixed: every prior finding verified fixed, with the fixing commit and a link to its comment thread.'
    : '4. What was fixed: write "First review, nothing to compare yet."',
  again
    ? '5. Still open from the previous review: each one with a link to its comment thread.'
    : '5. Still open from the previous review: write "First review."',
  '6. Not posted: refuted, disputed and unverifiable findings, one line each with the reason.',
  '',
  'Every link must be a full https:// URL.',
];
