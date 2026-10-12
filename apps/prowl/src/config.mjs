import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.PROWL_HOME || path.join(os.homedir(), '.prowl');
export const CONFIG_PATH = path.join(HOME, 'config.json');

// Every setting and its default. CONFIG_PATH overrides these; the Config view (3) edits that file.
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
  claude: { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' },
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
