// prowl --setup [--task-board ado|jira]: picks the task board, signs in to everything Prowl uses (GitHub,
// Azure DevOps or Jira, Claude Code) and adds a first board. Safe to re-run: it keeps what already works.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, loadConfig, saveConfig } from './config.mjs';
import { run, spawnCli } from './proc.mjs';
import { readToken, saveToken, storeName } from './secrets.mjs';

const B = s => `\x1b[1m${s}\x1b[0m`;
const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = s => console.log(`\n\x1b[1;33m${s}\x1b[0m`);

let pending = ''; // input typed or piped ahead of the current question
/** Reads one line from the terminal. `hidden` echoes nothing (for the API token). */
function readLine(hidden = false) {
  return new Promise(resolve => {
    const tty = process.stdin.isTTY;
    let line = '';
    let skip = 0; // the rest of an escape sequence (arrow keys) to ignore
    const onEnd = () => { console.log('\nSetup needs a terminal to answer questions: run prowl --setup in one.'); process.exit(1); };
    const done = rest => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      if (tty) process.stdin.setRawMode(false);
      pending = rest;
      process.stdout.write('\n');
      resolve(line.trim());
    };
    const onData = chunk => {
      const chars = [...(pending + chunk)];
      pending = '';
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (skip) { skip--; continue; }
        if (ch === '\u0003') { if (tty) process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') return done(chars.slice(i + (ch === '\r' && chars[i + 1] === '\n' ? 2 : 1)).join(''));
        if (ch === '\x1b') skip = 2;
        else if (ch === '\x7f' || ch === '\b') { if (line) { line = line.slice(0, -1); if (!hidden && tty) process.stdout.write('\b \b'); } }
        else if (ch >= ' ') { line += ch; if (!hidden && tty) process.stdout.write(ch); }
      }
      return undefined;
    };
    if (tty) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
    if (pending) onData('');
  });
}

async function ask(question, def = '', { hidden = false, optional = false, valid } = {}) {
  for (;;) {
    process.stdout.write(`  ${question}${def ? ` [${def}]` : ''}: `);
    const answer = (await readLine(hidden)) || def;
    if (!answer && optional) return '';
    const err = !answer ? 'needed' : valid ? valid(answer) : true;
    if (err === true) return answer;
    bad(err);
  }
}

/** Runs an interactive command (a sign-in) in this terminal; resolves with its exit code. */
const interactive = (cmd, args) => new Promise(resolve => {
  const p = spawnCli(cmd, args, { stdio: 'inherit' });
  p.on('error', () => resolve(127));
  p.on('exit', code => resolve(code ?? 1));
});

const works = async (cmd, args) => { try { return await run(cmd, args); } catch { return null; } };

async function github(cfg) {
  step('GitHub');
  if (await works('gh', ['--version']) === null) { bad('the GitHub CLI (gh) is not installed: run the installer, or get it from https://cli.github.com'); return false; }
  if (await works('gh', ['auth', 'status']) === null) await interactive('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']);
  const login = (await works('gh', ['api', 'user', '--jq', '.login']))?.trim();
  if (!login) { bad('not signed in to GitHub: run gh auth login'); return false; }
  ok(`signed in as ${login}. Reviews post from this account; your own PRs are skipped unless you turn on Review my own PRs (Config, 3).`);
  const orgs = (await works('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login']))?.split('\n').filter(Boolean) || [];
  const owners = [...orgs, login];
  owners.forEach((o, i) => console.log(`    ${i + 1} = ${o}${o === login ? ' (your own repos)' : ''}`));
  const pick = await ask('GitHub org whose PRs get reviewed: its number, or type a name', cfg.githubOwner || (orgs.length === 1 ? '1' : ''));
  cfg.githubOwner = owners[Number(pick) - 1] || pick;
  return true;
}

async function azureDevOps(cfg) {
  step('Azure DevOps');
  const ado = await import('./ado.mjs');
  cfg.ado.org = (await ask('Organization URL', cfg.ado.org, { valid: v => /^https:\/\/\S+$/.test(v) || 'must be an https:// URL' })).replace(/\/+$/, '');
  if (await works('az', ['--version']) === null) { bad('the Azure CLI (az) is not installed: run the installer, or see https://aka.ms/installazurecli'); return false; }
  for (let attempt = 0; ; attempt++) {
    try {
      ok(`signed in to ${cfg.ado.org} as ${await ado.whoAmI(cfg)}`);
      return true;
    } catch (e) {
      if (attempt) { bad(e.message); return false; }
      const tenant = await ado.tenantOf(cfg.ado.org).catch(() => '');
      console.log('  Signing in to Azure (a browser window opens)...');
      await interactive('az', ['login', '--allow-no-subscriptions', ...(tenant ? ['--tenant', tenant] : [])]);
    }
  }
}

async function jiraCloud(cfg) {
  step('Jira Cloud');
  const jira = await import('./jira.mjs');
  console.log(`  Your Jira site is the address you open Jira at. ${B('https://start.atlassian.com')} lists your sites.`);
  cfg.jira.site = (await ask('Jira site', cfg.jira.site || 'https://yourcompany.atlassian.net', {
    valid: v => (/^https:\/\/\S+$/.test(v) && !v.includes('yourcompany')) || 'your Jira URL, e.g. https://acme.atlassian.net',
  })).replace(/\/+$/, '');
  const gitEmail = (await works('git', ['config', 'user.email']))?.trim();
  cfg.jira.email = await ask('Atlassian account email', cfg.jira.email || gitEmail, { valid: v => /^[^\s@"\\]+@[^\s@"\\]+$/.test(v) || 'must be an email address' });
  for (let saved = Boolean(readToken(cfg.jira.email)); ;) {
    if (saved) {
      try {
        jira.forgetToken();
        ok(`signed in to ${cfg.jira.site} as ${await jira.whoAmI(cfg)}`);
        return true;
      } catch (e) {
        bad(e.message);
      }
    }
    console.log(`  Create an API token at ${B('https://id.atlassian.com/manage-profile/security/api-tokens')}, then paste it here.`);
    console.log(`  It is kept in ${storeName}, never in the config file. Nothing shows while you paste.`);
    const token = await ask('API token (enter alone skips Jira for now)', '', { hidden: true, optional: true });
    if (!token) return false;
    try {
      saveToken(cfg.jira.email, token);
      saved = true;
    } catch (e) {
      bad(e.message);
      return false;
    }
  }
}

async function claude() {
  step('Claude Code');
  const status = await works('claude', ['auth', 'status', '--json']);
  if (status === null && await works('claude', ['--version']) === null) { bad('Claude Code is not installed: run the installer, or see https://claude.com/claude-code'); return false; }
  let signedIn = false;
  try { signedIn = JSON.parse(status).loggedIn; } catch { /* older Claude Code: no JSON status */ }
  if (!signedIn) await interactive('claude', ['auth', 'login']);
  try { signedIn = JSON.parse(await works('claude', ['auth', 'status', '--json'])).loggedIn; } catch { /* unknown */ }
  if (signedIn) ok('signed in'); else bad('not signed in: run claude auth login');
  return signedIn;
}

async function firstBoard(cfg) {
  const name = cfg.taskBoard;
  const tracker = await import(name === 'jira' ? './jira.mjs' : './ado.mjs');
  const boards = cfg[name].boards;
  step('Boards');
  if (boards.length) {
    ok(`watching ${boards.map(tracker.boardLabel).join(', ')}. Add more in Config (4).`);
    return;
  }
  for (;;) {
    const v = await ask(name === 'jira' ? 'Jira board to watch: its name or id (enter alone skips)' : 'Board to watch, as Project / Team (enter alone skips)', '', { optional: true });
    if (!v) return;
    const cut = v.indexOf('/');
    const board = name === 'jira' ? { board: v.trim() } : { project: v.slice(0, cut).trim(), team: v.slice(cut + 1).trim() };
    if (name === 'ado' && (cut < 0 || !board.project || !board.team)) { bad('write it as Project / Team, e.g. My Project / My Team'); continue; }
    try {
      await tracker.findTickets(cfg, board, () => false);
      boards.push(board);
      ok(`found ${tracker.boardLabel(board)}`);
      return;
    } catch (e) {
      bad(e.message);
    }
  }
}

export async function setup(argv) {
  const cfg = loadConfig();
  console.log(`${B('Prowl setup')}: signs you in and saves your settings to ${CONFIG_PATH}.`);
  const preset = argv[argv.indexOf('--task-board') + 1];
  step('Task board');
  cfg.taskBoard = ['ado', 'jira'].includes(preset) ? preset
    : (await ask('Where are your tickets? 1 = Azure DevOps, 2 = Jira', cfg.taskBoard === 'jira' ? '2' : '1', { valid: v => ['1', '2'].includes(v) || 'type 1 or 2' })) === '2' ? 'jira' : 'ado';
  ok(cfg.taskBoard === 'jira' ? 'Jira' : 'Azure DevOps');

  const results = [await github(cfg), cfg.taskBoard === 'jira' ? await jiraCloud(cfg) : await azureDevOps(cfg), await claude()];
  saveConfig(cfg);
  if (results[1]) await firstBoard(cfg);

  step('Projects Directory');
  const projects = path.join(os.homedir(), 'projects');
  const def = cfg.workDir !== process.cwd() || !fs.existsSync(projects) ? cfg.workDir : projects;
  cfg.workDir = path.resolve(await ask('Folder reviews run in (its CLAUDE.md is loaded; missing PR repos are cloned here)', def, { valid: v => fs.existsSync(v) || 'folder not found' }));
  saveConfig(cfg);

  console.log(results.every(Boolean)
    ? `\n${B('All set.')} Start Prowl with: ${B('prowl')}  (try ${B('prowl --dry-run')} first: it only logs what it would review)`
    : `\n${B('Some steps need attention')} (marked ✗ above). Fix them and run ${B('prowl --setup')} again.`);
  return results.every(Boolean) ? 0 : 1;
}
