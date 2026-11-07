import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.PROWL_HOME || path.join(os.homedir(), '.prowl');
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const CONFIG_DIR = path.join(HOME, 'config'); // the user's copies of the skills' config files
export const CHECKS_PATH = path.join(CONFIG_DIR, 'checks.json'); // the user's own checks to run before Prowl pushes

export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Every setting and its default. CONFIG_PATH overrides these; the Config view (4) edits that file. NOTES documents
// each one: saveConfig writes it as a comment above the setting.
const DEFAULTS = {
  taskBoard: 'ado',
  ado: { org: '', boards: [] },
  jira: { site: '', email: '', boards: [], fields: { acceptanceCriteria: '', reproSteps: '' } },
  reviewer: { enabled: true },
  tags: { trigger: 'Ready for Review', inProgress: 'In Review', done: 'Reviewed' },
  tagMatchMaxTypos: 2,
  githubOwner: '',
  pollSeconds: 300,
  maxConcurrentReviews: 2,
  workDir: process.cwd(),
  claude: { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto', maxBudgetUsd: 0, maxTurns: 0 },
  reReviewScope: 'full',
  maxReviewRounds: 0,
  parkHumanOnly: false,
  reviewTimeoutMinutes: 0,
  reviewOwnPrs: false,
  approvals: true,
  allowMemoryWrites: true,
  caffeinate: false,
  logRetentionDays: 0,
  ticketContext: false,
  quickName: 'auto',
  quickLabels: true,
  builder: {
    enabled: false,
    tags: { start: 'Ready to Start', inProgress: 'In Development' },
    assignedToMe: true,
    maxConcurrent: 1,
    approvePlans: 'auto',
    base: {},
    branchTemplate: 'prowl/{id}-{slug}',
    quickBranchTemplate: 'prowl/{slug}',
    extraOwners: [],
    maxRepos: 6,
    model: '',
    effort: 'high',
    maxBudgetUsd: 50,
    maxTurns: 0,
    timeoutMinutes: 240,
    dailyBudgetUsd: 0,
    ticketBudgetUsd: 0,
    maxChangedLines: 3000,
    protectedPaths: ['.github/workflows/**'],
    protectedBranches: ['main', 'master', 'release/*'],
    draftPrs: false,
    requestReview: true,
    mcpAllow: [],
    notify: false,
    pickup: { drafts: true, branches: true, checks: true, conflicts: true },
    followUp: true,
    fixFrom: 'everyone',
    maxRounds: 3,
    waitForChecksMinutes: 30,
  },
  dryRun: false,
  autoUpdate: true,
  hoot: true,
};

// The comment above each setting in config.json, by dotted key: what it does, its options, and an example for lists.
const NOTES = {
  taskBoard: 'Where tickets are watched, for both sides: "ado" (Azure DevOps) or "jira" (Jira Cloud).',
  ado: 'Azure DevOps.',
  'ado.org': 'Organization URL, e.g. "https://dev.azure.com/your-org". Signed in with az login.',
  'ado.boards': 'Each team board to watch, e.g. [{ "project": "My Project", "team": "My Team" }].',
  jira: 'Jira Cloud.',
  'jira.site': 'Your Jira Cloud URL, e.g. "https://yourcompany.atlassian.net".',
  'jira.email': 'The email you sign in to Atlassian with. The API token is kept in your OS credential store (prowl --setup), never here.',
  'jira.boards': 'Each board to watch, by name or id, e.g. [{ "board": "My Team board" }].',
  'jira.fields': 'Custom field ids the Builder reads into ticket.md, e.g. "customfield_10042". "" leaves the section out.',
  reviewer: 'The Reviewer: reviews the PRs of tickets tagged for review.',
  'reviewer.enabled': 'The switch. Off: nothing new is claimed or started, and running reviews finish.',
  tags: 'The Reviewer\'s tags (labels on Jira).',
  'tags.trigger': 'Tickets carrying this get reviewed. The Builder sets it once its PRs open (see builder.requestReview).',
  'tags.inProgress': 'Set while a review runs.',
  'tags.done': 'Set when a review finishes. Re-add the trigger tag to ask for a re-review.',
  tagMatchMaxTypos: 'Typos still treated as the review trigger or build start tag. Case, spaces and punctuation are always ignored. 0 = exact.',
  githubOwner: 'GitHub org (or user) whose PRs are searched for the ticket key, and whose repos the Builder works in.',
  pollSeconds: 'How often the boards are checked and this file re-read, in seconds (30 or more).',
  maxConcurrentReviews: 'Reviews running at once. Extra tickets stay tagged until a slot frees.',
  workDir: 'Projects directory: sessions run here and load its CLAUDE.md. Missing repos are cloned here; worktrees go in its .prowl-worktrees folder.',
  claude: 'Review sessions (and build sessions, where the Builder leaves its own setting empty).',
  'claude.model': `Model: ${MODELS.map(m => `"${m}"`).join(', ')}, or any model id Claude Code accepts.`,
  'claude.effort': `Reasoning effort: ${EFFORTS.map(e => `"${e}"`).join(', ')}.`,
  'claude.permissionMode': '"auto" lets a safety classifier block risky actions. "bypassPermissions" lets sessions run anything: not recommended.',
  'claude.maxBudgetUsd': 'Spend cap per review in USD. A review that hits it fails and isn\'t retried. 0 = no cap.',
  'claude.maxTurns': 'Turn cap per review. 0 = no cap.',
  reReviewScope: '"full": a re-review reads each PR whole. "delta": only the commits since the last review, plus its open findings.',
  maxReviewRounds: 'Reviews per ticket before it is left, tagged, for a person. 0 = no cap.',
  parkHumanOnly: 'true: re-reviews park earlier findings only a person can fix outside the code: not re-posted, not counted in the verdict.',
  reviewTimeoutMinutes: 'Stop a review running longer than this. It fails and isn\'t retried. 0 = no limit.',
  reviewOwnPrs: 'true: review tickets with PRs you authored, as comment reviews (GitHub won\'t let you approve your own).',
  approvals: 'true: approve PRs with no blocking findings. false: comment that there are none and leave approving to a person.',
  allowMemoryWrites: 'true: sessions use Claude Code\'s auto-memory. false: they run with it off.',
  caffeinate: 'macOS: true keeps the Mac from idle-sleeping while a session runs.',
  logRetentionDays: 'Delete session logs older than this, and roll poller.log over past 5 MB. Reports are always kept. 0 = keep everything.',
  ticketContext: 'true: add the ticket\'s description (and Azure DevOps acceptance criteria) to each review\'s brief.',
  quickName: 'How a quick review or quick build without a ticket is named: "auto" (a short model call names it from the paste), "ask" (you type the name), or "number" (QUICK#n only).',
  quickLabels: 'true: a quick review labels its PRs In Review, then Reviewed, on GitHub, and re-reviews them once they are labelled Ready for Review. false: no labels; a quick review runs once.',
  builder: 'The Builder: builds tickets tagged to start, opens their PRs, then follows them through review. How it builds is in config/build.md.',
  'builder.enabled': 'The switch. Off: nothing new is claimed or started, and running sessions finish.',
  'builder.tags': 'The Builder\'s tags (labels on Jira). When its PRs open it sets tags.trigger.',
  'builder.tags.start': 'Tickets carrying this get built.',
  'builder.tags.inProgress': 'Set while the Builder works on a ticket, and while it needs you.',
  'builder.assignedToMe': 'true: only tickets assigned to you. false: any ticket with the start tag on your boards.',
  'builder.maxConcurrent': 'Tickets built at once, counted from the claim until their PRs open (Needs you included).',
  'builder.approvePlans': '"auto": Prowl approves a plan with no open questions. "ask": every plan waits for you in Needs you.',
  'builder.base': 'Base branch per repo: the first matching glob wins, a branch glob taking the highest version. Else the plan\'s base, else the default branch. e.g. { "my-org/web": "develop", "my-org/*": "release/*" }',
  'builder.branchTemplate': '{id} is the ticket (123, or PROJ-123), {slug} its title. A rebuild adds -2, -3, ...',
  'builder.quickBranchTemplate': 'Branch names for a quick build without a ticket: {slug} is its name. A clash adds -2, -3, ...',
  'builder.pickup': 'What the Builder picks up besides the ticket itself, when it claims one: work already started, and what that work needs fixed.',
  'builder.pickup.drafts': 'true: your draft PRs for the ticket are picked up and continued too. false: drafts are left alone.',
  'builder.pickup.branches': 'true: your pushed branches for the ticket with no PR yet (named with its number, or linked on the ticket) are continued, and a PR opened for them.',
  'builder.pickup.checks': "true: a picked-up PR's failing required checks start a fix round, with the job's log.",
  'builder.pickup.conflicts': 'true: a picked-up PR that conflicts with its base starts a fix round, which merges the base in (never a rebase).',
  'builder.extraOwners': 'GitHub owners besides githubOwner whose repos a session may ask for, e.g. ["my-other-org"].',
  'builder.maxRepos': 'Repos a ticket may use. A session asking for more goes to Needs you.',
  'builder.model': `Model for build sessions: ${MODELS.map(m => `"${m}"`).join(', ')}, or any model id. "" = claude.model.`,
  'builder.effort': `Reasoning effort for build sessions: ${EFFORTS.map(e => `"${e}"`).join(', ')}.`,
  'builder.maxBudgetUsd': 'Spend cap per session in USD (all its turns). It goes to Needs you. 0 = no cap.',
  'builder.maxTurns': 'Turn cap per session turn (the build, or one feedback round). 0 = no cap.',
  'builder.timeoutMinutes': 'Stop a session turn running longer than this. 0 = no limit.',
  'builder.dailyBudgetUsd': 'Spend cap on build sessions since local midnight, in USD. 0 = no cap.',
  'builder.ticketBudgetUsd': 'Spend cap on every build session for one ticket, in USD. 0 = no cap.',
  'builder.maxChangedLines': 'A push that changes more lines than this goes to Needs you.',
  'builder.protectedPaths': 'Globs: a push that changes one goes to Needs you, e.g. [".github/workflows/**", "infra/**"].',
  'builder.protectedBranches': 'Globs never pushed to, as well as each repo\'s default branch, e.g. ["main", "release/*"].',
  'builder.draftPrs': 'true: open PRs as drafts, which the Reviewer leaves alone until you mark them ready.',
  'builder.requestReview': 'true: set tags.trigger once the PRs open and after each feedback round. false: only builder.tags.inProgress comes off.',
  'builder.mcpAllow': 'MCP tools a build session may use, by name or * pattern. None by default. e.g. ["mcp__linear__get_issue", "mcp__sentry__*"].',
  'builder.notify': 'true: a desktop notification when PRs open, a ticket is ready to merge, or one needs you.',
  'builder.followUp': 'true: follow the PRs through review, fixing feedback in rounds.',
  'builder.fixFrom': 'Whose unresolved threads a round takes on: "prowl", "prowl+bots" or "everyone".',
  'builder.maxRounds': 'Feedback rounds per ticket; then it goes to Needs you.',
  'builder.waitForChecksMinutes': 'After a round\'s push, how long to wait for the required checks. 0 = don\'t wait.',
  dryRun: 'true: log what would be reviewed or built, without changing tags or starting sessions.',
  autoUpdate: 'true: install a newer Prowl release before launching.',
  hoot: 'true: Hoot the owl walks along the top of the screen and says what Prowl is doing. false: no owl, and the Boards and Needs you cards take the full width of his strip.',
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => {
  for (const [k, v] of Object.entries(over)) base[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return base;
};

export function loadConfig() {
  let saved = {};
  try {
    saved = parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Can't read ${CONFIG_PATH}: ${e.message}`);
  }
  const old = 'boards' in saved || 'org' in saved; // settings from before Jira support
  if (old) {
    saved.ado = { ...saved.ado, ...('org' in saved && { org: saved.org }), ...('boards' in saved && { boards: saved.boards }) };
    delete saved.org;
    delete saved.boards;
  }
  // Before 2.13.0 the Builder had its own done and reviewing tags; it now uses the Reviewer's trigger and in-progress tags.
  const ownTags = saved.builder?.tags && ('done' in saved.builder.tags || 'reviewing' in saved.builder.tags);
  if (ownTags) {
    delete saved.builder.tags.done;
    delete saved.builder.tags.reviewing;
  }
  // 2.14.0 removed builder.command: Prowl always builds with its own skill, shaped by build.md.
  const command = saved.builder && 'command' in saved.builder;
  if (command) delete saved.builder.command;
  const cfg = merge(structuredClone(DEFAULTS), saved);
  if (old || ownTags || command || !fs.existsSync(CONFIG_PATH)) saveConfig(cfg);
  return cfg;
}

/** Settings with a default that the saved config file doesn't have yet (added by an update), as dotted keys. */
export function newSettings() {
  let saved;
  try { saved = parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return []; }
  const missing = (def, have, at) => Object.entries(def).flatMap(([k, v]) => (!(k in have) ? [at + k]
    : isObj(v) && isObj(have[k]) ? missing(v, have[k], `${at}${k}.`) : []));
  return missing(DEFAULTS, saved, '');
}

/** `obj` as JSON, with each setting's NOTES entry as a // comment above it. */
function commented(obj, at = '', pad = '  ') {
  const lines = Object.entries(obj).map(([k, v]) => {
    const key = at + k;
    const val = isObj(v) && Object.keys(v).length ? commented(v, `${key}.`, `${pad}  `) : JSON.stringify(v, null, 2).replace(/\n/g, `\n${pad}`);
    return `${NOTES[key] ? `${pad}// ${NOTES[key]}\n` : ''}${pad}${JSON.stringify(k)}: ${val}`;
  });
  return `{\n${lines.join(',\n')}\n${pad.slice(2)}}`;
}

const CONFIG_HEADER = [
  '// Prowl settings. The Config view (4) edits this file, and so can you: Prowl re-reads it every poll interval.',
  "// Prowl rewrites it when a setting changes in Config, with these comments, so comments you add aren't kept.",
];
export const saveConfig = cfg => writeText(CONFIG_PATH, `${CONFIG_HEADER.join('\n')}\n${commented(cfg)}\n`);

/** JSON that may have line and block comments and trailing commas, as in config.json and checks.json. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      if (c === '}' || c === ']') out = out.replace(/,\s*$/, ''); // a trailing comma, e.g. after uncommenting one example
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

const CHECKS_TEMPLATE = `// Checks before push: commands the Builder runs in a repo's worktree before Prowl pushes its commits.
// Each key is a repo glob (owner/name, * wildcards); the first one that matches a repo is used, and a repo
// nothing matches gets no checks. "setup" runs first, then "run"; the first command that fails stops the push
// and gives the session one more turn with its output. Optional: "env" (extra environment variables) and
// "timeoutMinutes" per command (20 by default). Prowl never changes this file once you have edited it.
// To use an example, remove the // in front of its lines and change the glob to match your repos.
{
  // A linter, for JavaScript repos:
  // "my-org/web-*": {
  //   "setup": ["npm ci"],
  //   "run": ["npx eslint ."]
  // },

  // pytest, for Python repos:
  // "my-org/data-*": {
  //   "setup": ["python -m pip install -r requirements.txt"],
  //   "run": ["python -m pytest -q"],
  //   "env": { "PYTHONDONTWRITEBYTECODE": "1" },
  //   "timeoutMinutes": 30
  // }
}
`;

/** Writes checks.json with its commented examples when it is missing, or still the bare {} earlier versions wrote. */
export function seedChecks() {
  let cur = null;
  try { cur = fs.readFileSync(CHECKS_PATH, 'utf8'); } catch { /* missing */ }
  if (cur === null || cur.trim() === '{}') writeText(CHECKS_PATH, CHECKS_TEMPLATE);
}

/** checks.json, or {} when it is missing. Throws on a file that doesn't parse. */
export function readChecks() {
  try {
    return parseJsonc(fs.readFileSync(CHECKS_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${CHECKS_PATH} isn't valid JSON (${e.message})`);
  }
}

export const writeJson = (file, data, replacer) => writeText(file, JSON.stringify(data, replacer, 2));

/** Writes through a temp file and a rename, so a crash never leaves half a file. */
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  // On Windows, antivirus or the search indexer can hold the file open for a moment, and replacing it fails.
  for (let tries = 1; ; tries++) {
    try {
      return fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      if (tries === 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // up to 2s in all
    }
  }
}
