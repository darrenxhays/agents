import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.PROWL_HOME || path.join(os.homedir(), '.prowl');
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const CONFIG_DIR = path.join(HOME, 'config'); // the user's copies of prowl-review's config files
export const CHECKS_PATH = path.join(CONFIG_DIR, 'checks.json'); // the user's own checks to run before a fix is pushed

// Every setting and its default. CONFIG_PATH overrides these; the Config view (4) edits that file.
const DEFAULTS = {
  taskBoard: 'ado', // 'ado' (Azure DevOps) or 'jira' (Jira Cloud): where tickets are watched
  ado: {
    org: '', // https://dev.azure.com/<your-org>
    boards: [], // [{ "project": "My Project", "team": "My Team" }]: each team's board (area paths) is polled
  },
  jira: {
    site: '', // https://<company>.atlassian.net
    email: '', // your Atlassian account; its API token is kept in the OS credential store (prowl --setup)
    boards: [], // [{ "board": "My Team board" }]: a board name or id
  },
  tags: { trigger: 'Ready for Review', inProgress: 'In Review', done: 'Reviewed' },
  tagMatchMaxTypos: 2,
  githubOwner: '', // GitHub org whose PRs get reviewed
  pollSeconds: 300,
  maxConcurrentReviews: 2,
  workDir: process.cwd(),
  claude: {
    model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto',
    maxBudgetUsd: 0, // spend cap per review in USD (--max-budget-usd); 0 = no cap
    maxTurns: 0, // turn cap per review (--max-turns); 0 = no cap
  },
  reReviewScope: 'full', // 'full': a re-review reads each PR whole; 'delta': only the commits since the last review, plus its open findings
  maxReviewRounds: 0, // reviews per ticket before it is left for a person: not claimed, flagged in History; 0 = no cap
  parkHumanOnly: false, // re-reviews park prior findings only a person can fix outside the code: not re-posted, not counted in the verdict
  reviewTimeoutMinutes: 0, // stop a review running longer than this; 0 = no limit. A review stopped by a cap fails and isn't retried
  reviewOwnPrs: false, // review tickets with PRs you authored; your own PRs get a comment review, as GitHub won't let you approve them
  approvals: true, // approve PRs with no blocking findings; off: comment that there are none and leave approving to a human
  allowMemoryWrites: true, // off: review sessions run with Claude Code's auto-memory off, so they don't add to your memory files
  caffeinate: false, // macOS: keep the Mac from idle-sleeping while a review runs (caffeinate -i)
  logRetentionDays: 0, // delete review logs older than this, and roll poller.log over past 5 MB; 0 = keep everything. Reports are always kept
  ticketContext: false, // add the ticket's description (and Azure DevOps acceptance criteria) to the review prompt
  // Fix my PRs: after a review asks for changes on your own PRs, a capped Claude Code session per PR fixes them in a
  // worktree; Prowl's code then runs your checks, pushes, replies on the threads it addressed, waits for CI and re-tags.
  fix: {
    enabled: false, // the switch; every other fix setting applies only while it is on
    from: 'everyone', // whose unresolved threads get fixed: 'prowl' (Prowl's own), 'prowl+bots', 'everyone'
    maxRounds: 3, // fix rounds per ticket; then it goes to Needs you
    maxBudgetUsd: 25, // spend cap per fix session in USD (--max-budget-usd); 0 = no cap
    maxTurns: 0, // turn cap per fix session (--max-turns); 0 = no cap
    timeoutMinutes: 60, // stop a fix session running longer than this; 0 = no limit
    ticketBudgetUsd: 0, // reviews plus fixes per ticket since its loop started; 0 = no cap
    dailyBudgetUsd: 0, // fix sessions since local midnight; 0 = no cap
    waitForChecksMinutes: 30, // wait this long for a PR's required checks after a push before re-tagging; 0 = re-tag at once
    maxChangedLines: 1000, // a round that changes more lines than this isn't pushed
    protectedPaths: ['.github/workflows/**'], // globs: a round that changes one isn't pushed
    protectedBranches: ['main', 'master', 'release/*'], // globs never pushed to, as well as each repo's default branch
    maxConcurrent: 1, // fix sessions at once, apart from maxConcurrentReviews
    model: '', // model for fix sessions; '' = claude.model
    effort: 'medium', // reasoning effort for fix sessions
    notify: false, // desktop notification when a ticket is ready to merge or needs you
  },
  dryRun: false,
  autoUpdate: true, // install a newer released version before launching
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => {
  for (const [k, v] of Object.entries(over)) base[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return base;
};

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Can't read ${CONFIG_PATH}: ${e.message}`);
  }
  const old = 'boards' in saved || 'org' in saved; // settings from before Jira support
  if (old) {
    saved.ado = { ...saved.ado, ...('org' in saved && { org: saved.org }), ...('boards' in saved && { boards: saved.boards }) };
    delete saved.org;
    delete saved.boards;
  }
  const cfg = merge(structuredClone(DEFAULTS), saved);
  if (old || !fs.existsSync(CONFIG_PATH)) saveConfig(cfg);
  return cfg;
}

/** Settings with a default that the saved config file doesn't have yet (added by an update), as dotted keys. */
export function newSettings() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return []; }
  const missing = (def, have, at) => Object.entries(def).flatMap(([k, v]) => (!(k in have) ? [at + k]
    : isObj(v) && isObj(have[k]) ? missing(v, have[k], `${at}${k}.`) : []));
  return missing(DEFAULTS, saved, '');
}

export const saveConfig = cfg => writeJson(CONFIG_PATH, cfg);

/** Writes through a temp file and a rename, so a crash never leaves half a file. */
export function writeJson(file, data, replacer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, replacer, 2));
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
