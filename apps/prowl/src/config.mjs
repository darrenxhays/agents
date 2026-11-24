import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { norm } from './match.mjs';
import { fiveLabels, LABELS, migrateNames, REVIEW_LABEL, TAGS } from './names.mjs';

export const HOME = process.env.PROWL_HOME || path.join(os.homedir(), '.prowl');
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const CONFIG_DIR = path.join(HOME, 'config'); // the user's copies of the skills' config files
export const CHECKS_PATH = path.join(CONFIG_DIR, 'checks.json'); // the user's own checks: run before Prowl pushes, and before a review (reviewChecks)

export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The names the Agent tool takes for a subagent's model: each is the latest of its family. Never a full model id.
export const AGENT_MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
// …which Claude Code takes for a session's model too. How Config lists them, after the full IDs.
export const MODEL_SHORT_NAMES = { fable: 'fable (the latest Fable)', opus: 'opus (the latest Opus)', sonnet: 'sonnet (the latest Sonnet)', haiku: 'haiku (the latest Haiku)' };
// A model name typed in Config (Other…): other providers' names fit too (us.anthropic.claude-…-v1:0, claude-…@20251101, an ARN, claude-…[1m]).
export const MODEL_SHAPE = /^[\w.:@/[\]-]+$/;
export function modelValid(v) {
  if (!MODEL_SHAPE.test(v)) return `'${v}' isn't a model name: letters, digits and . - _ : @ / [ ] only`;
  if (/^(sonnet|opus|haiku|fable)-\d/.test(v)) return `A full model ID starts with claude-: did you mean claude-${v}?`;
  return true;
}

// Every setting and its default. CONFIG_PATH overrides these; the Config view (4) edits that file. NOTES documents
// each one: saveConfig writes it as a comment above the setting.
const DEFAULTS = {
  taskBoard: 'ado',
  ado: { org: '', boards: [] },
  jira: { site: '', email: '', boards: [], fields: { acceptanceCriteria: '', reproSteps: '' } },
  reviewer: { enabled: true },
  tags: { ...TAGS.reviewer },
  tagMatchMaxTypos: 2,
  githubOwner: '',
  pollSeconds: 300,
  maxConcurrentReviews: 2,
  workDir: process.cwd(),
  claude: { model: 'claude-opus-5-5', effort: 'xhigh', orchestratorModel: '', orchestratorEffort: '', verifierModel: 'sonnet', verifierEffort: 'medium', permissionMode: 'auto', maxBudgetUsd: 0, maxTurns: 0 },
  reReviewScope: 'full',
  smallReReviewLines: 50,
  smallReReviewModel: 'sonnet',
  smallReReviewEffort: '',
  maxReviewRounds: 0,
  parkHumanOnly: false,
  reviewTimeoutMinutes: 0,
  reviewOwnPrs: false,
  approvals: true,
  requestChanges: true,
  allowMemoryWrites: true,
  caffeinate: false,
  logRetentionDays: 0,
  ticketContext: false,
  reviewPrep: true,
  reviewChecks: false,
  quickName: 'auto',
  githubReviews: true,
  quickLabels: true,
  reviewLabel: REVIEW_LABEL,
  labels: { ...LABELS },
  builder: {
    enabled: false,
    tags: { ...TAGS.builder },
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
  notifyVia: 'auto',
  mouse: true,
  namesVersion: 2,
  tagsWere: {},
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
  tags: 'The Reviewer\'s tags (labels on Jira, written without colons and with dashes for spaces: prowl-in-review). The same names as its GitHub labels.',
  'tags.trigger': 'Tickets carrying this get reviewed. The Builder sets it once its PRs open (see builder.requestReview).',
  'tags.inProgress': 'Set while a review runs.',
  'tags.approved': 'Set when a review finishes with every PR approved.',
  'tags.changes': 'Set when a review finishes with a PR not approved. Re-add the trigger tag to ask for a re-review.',
  tagMatchMaxTypos: 'Typos still treated as the review trigger or build start tag. Case, spaces and punctuation are always ignored. 0 = exact.',
  githubOwner: 'GitHub org (or user) whose PRs are searched for the ticket key, and whose repos the Builder works in.',
  pollSeconds: 'How often Prowl checks the boards and searches GitHub for the Review label, in seconds (30 or more).',
  maxConcurrentReviews: 'Reviews running at once. Extra tickets stay tagged until a slot frees.',
  workDir: 'Projects directory: sessions run here and load its CLAUDE.md. Missing repos are cloned here; worktrees go in its .prowl-worktrees folder.',
  claude: 'Review sessions (and build sessions, where the Builder leaves its own setting empty).',
  'claude.model': `The reviewers' model (and the review session's own, unless claude.orchestratorModel is set): ${MODELS.map(m => `"${m}"`).join(', ')}, a short name for the latest of a family ("fable", "opus", "sonnet", "haiku"), or any model id Claude Code accepts.`,
  'claude.effort': `The reviewers' reasoning effort (and the review session's own, unless claude.orchestratorEffort is set): ${EFFORTS.map(e => `"${e}"`).join(', ')}.`,
  'claude.orchestratorModel': 'Model for the review session itself, which orchestrates; its reviewers are still launched on claude.model. "" = claude.model. With one set, claude.model must be "sonnet", "opus", "haiku", "fable" or one of the full ids listed for it.',
  'claude.orchestratorEffort': 'Reasoning effort for the review session itself; its reviewers are launched at claude.effort. "" = claude.effort.',
  'claude.verifierModel': 'Model for the subagents that check each finding: "sonnet", "opus", "haiku" or "fable" (short names only, not a full model id). "" = none passed (Claude Code\'s default for subagents).',
  'claude.verifierEffort': 'Reasoning effort for those subagents: "low", "medium", "high", "xhigh", "max". "" = none passed.',
  'claude.permissionMode': '"auto" lets a safety classifier block risky actions. "bypassPermissions" lets sessions run anything: not recommended.',
  'claude.maxBudgetUsd': 'Spend cap per review in USD. A review that hits it fails and isn\'t retried. 0 = no cap.',
  'claude.maxTurns': 'Turn cap per review. 0 = no cap.',
  reReviewScope: '"full": a re-review reads each PR whole. "delta": only the commits since the last review, plus its open findings.',
  smallReReviewLines: 'Delta re-reviews: a PR whose commits since the last review change at most this many lines gets its reviewer on smallReReviewModel. 0 = off.',
  smallReReviewModel: 'That reviewer\'s model: "sonnet", "opus", "haiku" or "fable" (short names only).',
  smallReReviewEffort: 'That reviewer\'s reasoning effort: "low", "medium", "high", "xhigh", "max". "" = the other reviewers\' effort.',
  maxReviewRounds: "Reviews per ticket, by anyone's Prowl, before it is left, tagged, for a person. 0 = no cap.",
  parkHumanOnly: 'true: earlier findings only a person can settle outside the code are parked: no reply, not counted in the verdict. A thread a person answered is parked either way.',
  reviewTimeoutMinutes: 'Stop a review running longer than this, counted from when its session starts. It fails and isn\'t retried. 0 = no limit.',
  reviewOwnPrs: 'true: review tickets with PRs you authored, as comment reviews (GitHub won\'t let you approve your own).',
  approvals: 'true: approve PRs with no blocking findings. false: comment that there are none and leave approving to a person.',
  requestChanges: 'true: a PR with blocking findings gets a Request changes review. false: the same review as a comment, which does not block merging.',
  allowMemoryWrites: 'true: sessions use Claude Code\'s auto-memory. false: they run with it off.',
  caffeinate: 'macOS: true keeps the Mac from idle-sleeping while a session runs.',
  logRetentionDays: 'Delete session logs older than this, and roll poller.log over past 5 MB. Reports are always kept. 0 = keep everything.',
  ticketContext: 'true: add the ticket\'s description (and Azure DevOps acceptance criteria) to each review\'s brief.',
  reviewPrep: 'true: Prowl checks each PR out in a worktree and writes its diff, facts and comments to files before a review\'s session starts. false: the session fetches everything itself.',
  reviewChecks: "true: build and test each PR with checks.json before its review, and give the review the results. A fork's PR is never built.",
  quickName: 'How a quick review or quick build without a ticket is named: "auto" (a short model call names it from the paste), "ask" (you type the name), or "number" (QUICK#n only).',
  githubReviews: 'Poll for PRs carrying the Review label and label board reviews independently of quickLabels.',
  quickLabels: "true: a quick review labels its PRs 'prowl: in review', then 'prowl: approved' or 'prowl: changes requested', and re-reviews once every PR it didn't approve is labelled 'prowl: review'. false: no labels; a quick review runs once.",
  reviewLabel: 'The GitHub label that asks for a review of a PR. GitHub reviews poll for this exact name. Quick reviews use it for re-reviews and ticketless builds set it at hand-off. "" = the name of tags.trigger.',
  labels: 'The GitHub labels Prowl sets on PRs. githubReviews governs polled and board reviews, quickLabels governs manual quick reviews. Matched exactly, ignoring case.',
  'labels.inReview': 'A review of the PR is running.',
  'labels.approved': 'Its review ended with nothing blocking the PR.',
  'labels.changes': 'Its review ended with a finding that blocks the PR.',
  'labels.building': 'A quick build without a ticket is working on the PR.',
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
  'builder.model': `Model for build sessions: ${MODELS.map(m => `"${m}"`).join(', ')}, a short name for the latest of a family ("fable", "opus", "sonnet", "haiku"), or any model id. "" = claude.model.`,
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
  'builder.requestReview': 'When PRs open and after each feedback round, set tags.trigger on the ticket. For a ticketless build, set reviewLabel on its PRs if quickLabels is on. Turning this off only clears the build marker.',
  'builder.mcpAllow': 'MCP tools a build session may use, by name or * pattern. None by default. e.g. ["mcp__linear__get_issue", "mcp__sentry__*"].',
  'builder.notify': 'true: a notification (sent as notifyVia says) when PRs open, a ticket is ready to merge, or one needs you.',
  'builder.followUp': 'true: follow the PRs through review, fixing feedback in rounds.',
  'builder.fixFrom': 'Whose unresolved threads a round takes on: "prowl", "prowl+bots" or "everyone".',
  'builder.maxRounds': 'Feedback rounds per ticket; then it goes to Needs you.',
  'builder.waitForChecksMinutes': 'After a round\'s push, how long to wait for the required checks. 0 = don\'t wait.',
  dryRun: 'true: log what would be reviewed or built, without changing tags or starting sessions.',
  autoUpdate: 'true: install a newer Prowl release before launching.',
  notifyVia: 'How notifications reach you: "auto" (a desktop notification where one works, else the terminal bell), "desktop" or "bell". Whether any are sent is builder.notify.',
  mouse: 'true: Prowl takes clicks, the wheel and drags (a drag copies the text). false: the mouse is left to your terminal, for its own selection and scrolling.',
  hoot: 'true: Hoot the owl sits at the top of the screen and says what Prowl is doing. false: no owl, and the Boards and Needs you cards take the full width of his strip.',
  namesVersion: 'Set by Prowl once config.json has the prowl: tag names. Leave it.',
  tagsWere: 'Tag names the move to the prowl: names reset because they read the same as another tag. Still read on tickets, never written.',
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => {
  for (const [k, v] of Object.entries(over)) base[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return base;
};

// What a setting's value has to be, going by its default: a typo in config.json is named, not run with.
const KINDS = { number: 'a number', string: 'text in quotes', boolean: 'true or false', array: 'a list ([ ... ])', object: 'a section ({ ... })' };
const kind = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
/** What is wrong with `cfg`'s values, each as '<dotted key> must be <what>'. */
const mistakes = (def, cfg, at = '') => Object.entries(def).flatMap(([k, v]) => (kind(cfg[k]) !== kind(v) ? [`${at}${k} must be ${KINDS[kind(v)]}`]
  : isObj(v) ? mistakes(v, cfg[k], `${at}${k}.`) : []));

// config.json as this process last read or wrote it (its modified time and size), so a change made elsewhere shows.
let known = '';
const stamp = () => { try { const s = fs.statSync(CONFIG_PATH); return `${s.mtimeMs} ${s.size}`; } catch { return ''; } };
/** True when config.json has changed since this process last read or wrote it: edited by hand, or by prowl --setup. */
export const configChanged = () => stamp() !== known;

const nameNotes = []; // what the move to the prowl: tag names changed, for the Log of the launch that made it
/** The Log's lines for a config this launch moved to the prowl: tag names, once ([] otherwise). */
export const takeNameNotes = () => nameNotes.splice(0);

/** The settings: config.json over the defaults. Throws, naming the setting, when the file can't be read or a value can't be used. */
export function loadConfig(warn = () => {}) {
  let saved = {};
  known = stamp(); // before the read: a file that doesn't load is tried again only once it changes
  try {
    saved = parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Can't read ${CONFIG_PATH}: ${e.message}`);
  }
  if (!isObj(saved)) throw new Error(`Can't use ${CONFIG_PATH}: it must hold the settings in { ... }`);
  const old = 'boards' in saved || 'org' in saved; // settings from before Jira support
  if (old) {
    saved.ado = { ...saved.ado, ...('org' in saved && { org: saved.org }), ...('boards' in saved && { boards: saved.boards }) };
    delete saved.org;
    delete saved.boards;
  }
  // Before 2.13.0 the Builder had its own done and reviewing tags; it now uses the Reviewer's trigger and in-progress tags.
  const ownTags = isObj(saved.builder?.tags) && ('done' in saved.builder.tags || 'reviewing' in saved.builder.tags);
  if (ownTags) {
    delete saved.builder.tags.done;
    delete saved.builder.tags.reviewing;
  }
  // The tags took the labels' prowl: names, and the Reviewer's one done tag became two: a saved config moves once.
  const exists = fs.existsSync(CONFIG_PATH);
  const moved = exists && !(saved.namesVersion >= 2);
  const notes = exists ? migrateNames(saved) : [];
  if (notes.length) nameNotes.push('config.json moved to the new tag names:', ...notes);
  // 2.14.0 removed builder.command: Prowl always builds with its own skill, shaped by build.md.
  const command = isObj(saved.builder) && 'command' in saved.builder;
  if (command) delete saved.builder.command;
  const cfg = merge(structuredClone(DEFAULTS), saved);
  const wrong = mistakes(DEFAULTS, cfg);
  if (!wrong.length && !['ado', 'jira'].includes(cfg.taskBoard)) wrong.push('taskBoard must be "ado" or "jira"');
  if (!wrong.length && cfg.pollSeconds < 30) wrong.push('pollSeconds must be 30 or more');
  if (wrong.length) throw new Error(`Can't use ${CONFIG_PATH}: ${wrong.join('; ')}`);
  const checkNames = (group, names, normalize) => {
    const seen = new Map();
    for (const [key, name] of Object.entries(names)) {
      const value = normalize(name);
      const other = seen.get(value);
      if (other && !(group === 'tags' && [other, key].every(k => ['approved', 'changes'].includes(k)))) {
        const pathOf = k => group === 'labels' && k === 'ask' ? 'reviewLabel' : `${group}.${k}`;
        warn(`config.json: '${pathOf(key)}' reads the same as '${pathOf(other)}' ('${name}')`);
      } else seen.set(value, key);
    }
  };
  checkNames('tags', cfg.tags, norm);
  checkNames('builder.tags', cfg.builder.tags, norm);
  checkNames('labels', fiveLabels(cfg), name => name.trim().toLowerCase());
  if (old || ownTags || command || moved || !fs.existsSync(CONFIG_PATH)) saveConfig(cfg);
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
  '// Prowl settings. The Config view (4) edits this file, and so can you: Prowl re-reads it when it changes.',
  "// Prowl rewrites it when a setting changes in Config, with these comments, so comments you add aren't kept.",
];
export function saveConfig(cfg) {
  writeText(CONFIG_PATH, `${CONFIG_HEADER.join('\n')}\n${commented(cfg)}\n`);
  known = stamp();
}

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

const CHECKS_TEMPLATE = `// Checks: commands Prowl runs in a worktree of a repo. The Builder runs them before Prowl pushes its commits; with
// Build and test before reviews on, the Reviewer runs them on each PR before its review and gives the review the results.
// Each key is a repo glob (owner/name, * wildcards); the first one that matches a repo is used, and a repo
// nothing matches gets no checks.
//   "setup": commands run first, for both.
//   "run": the Builder's checks before a push. The first command that fails stops the push and gives the session
//     one more turn with its output. A review runs them too, as one step named "checks", unless there is a "review".
//   "review": named steps for a review, each a list of commands, run in the order written (build, test, lint, or
//     any names). A failed setup or build step skips the steps after it; a failed step is run again at the PR's
//     merge base. false: the repo is checked before a push, never built for a review. A fork's PR is never built.
//   "env": extra environment variables. "timeoutMinutes": per command (20 by default).
// Every command also gets PROWL_NOTHING_TO_RUN_FILE: a command that finds nothing of its kind to do creates that
// file and exits 0 ([ -n "$PROWL_NOTHING_TO_RUN_FILE" ] && : > "$PROWL_NOTHING_TO_RUN_FILE"; exit 0). A review's
// commands get PROWL_REPO, PROWL_PR, PROWL_HEAD_SHA, PROWL_BASE_SHA (the merge base), PROWL_CHANGED_FILES (a file
// listing the PR's changed files, one per line) and, in the rerun at the merge base, PROWL_AT_BASE=1.
// Prowl never changes this file once you have edited it.
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
  // },

  // Named steps for reviews; the Builder still runs "run" before a push:
  // "my-org/service-*": {
  //   "setup": ["npm install"],
  //   "review": { "build": ["npm run build"], "test": ["npm test -- --ci"], "lint": ["npx eslint ."] },
  //   "run": ["npm test"],
  //   "env": { "CI": "1" }
  // },

  // Checked before a push, never built for a review:
  // "my-org/*": { "run": ["make test"], "review": false }
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
