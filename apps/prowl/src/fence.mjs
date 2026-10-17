// The fence around fix sessions: only Prowl's own code pushes, posts on GitHub or tags. Pure functions, covered by
// `node prowl.mjs --self-test`; hooks/fix-guard.mjs runs fenceDecision as a PreToolUse hook in fix sessions only.
import fs from 'node:fs';
import path from 'node:path';

const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--\S+))*\s+`; // git, then any global options (-C dir, --git-dir=x)
const DENY = [
  [new RegExp(`${GIT}push\\b`), 'pushing: Prowl pushes the fix itself once it has checked it'],
  [new RegExp(`${GIT}remote\\s+(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\\b`), 'changing git remotes'],
  [/\bgh\s+pr\s+(?:create|merge|review|comment|close|edit|ready|reopen|lock|unlock)\b/, 'changing a PR: Prowl posts the replies itself'],
  [/\bgh\s+repo\s+(?:create|delete|edit|fork|rename|archive|unarchive|sync|set-default|deploy-key|autolink)\b/, 'changing a repository'],
  [/\bgh\s+issue\s+(?:create|close|comment|delete|edit|lock|pin|reopen|transfer|unlock|unpin|develop)\b/, 'changing an issue'],
];
const WRITE_METHOD = /(?:^|\s)(?:-X|--method)[\s=]*['"]?(?:POST|PATCH|PUT|DELETE)\b/i;
const GET_METHOD = /(?:^|\s)(?:-X|--method)[\s=]*['"]?GET\b/i;
const FIELDS = /(?:^|\s)(?:-[fF]|--field|--raw-field|--input)(?:\s|=)/; // gh api sends fields as a POST unless told GET

/** Why `gh api …` (one command, up to the next ; && || | or line break) writes to GitHub, or ''. */
function apiWrite(cmd) {
  if (/\bgraphql\b/.test(cmd)) return /\bmutation\b/.test(cmd) ? 'a GraphQL mutation' : ''; // queries are POSTs too
  if (WRITE_METHOD.test(cmd)) return 'a write to the GitHub API';
  if (FIELDS.test(cmd) && !GET_METHOD.test(cmd)) return 'a write to the GitHub API (fields without -X GET)';
  return '';
}

/** Why a shell command is fenced off in a fix session, or '' to allow it. */
export function deniedCommand(command) {
  const text = String(command || '');
  for (const [re, why] of DENY) if (re.test(text)) return why;
  // A mutation's query can span lines, so a graphql call is judged whole; anything else per command.
  for (const cmd of /\bgh\s+api\b/.test(text) ? [text, ...text.split(/&&|\|\||[;|\n]/)] : []) {
    const why = /\bgh\s+api\b/.test(cmd) && apiWrite(cmd);
    if (why) return why;
  }
  return '';
}

/** The real path of `p`, even when it doesn't exist yet: its nearest existing folder's real path, plus the rest. */
function realish(p) {
  let rest = '';
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    try { return path.join(fs.realpathSync(at), rest); } catch { /* not there yet */ }
    if (path.dirname(at) === at) return path.resolve(p);
    rest = path.join(path.basename(at), rest);
  }
}

/** True when `file` is inside one of `roots`, comparing real paths (so a symlink can't lead out). */
export function insideRoots(file, roots) {
  const norm = p => (process.platform === 'win32' ? realish(p).toLowerCase() : realish(p));
  const f = norm(file);
  return roots.filter(Boolean).some(root => {
    const rel = path.relative(norm(root), f);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * The PreToolUse decision for a tool call in a fix session: a deny output, or null to allow it. `call` is the hook's
 * stdin JSON; `env` its environment. Outside a fix session (PROWL_SESSION isn't 'fix') everything is allowed.
 */
export function fenceDecision(call, env = process.env) {
  if (env.PROWL_SESSION !== 'fix') return null;
  const input = call?.tool_input || {};
  let why = '';
  if (['Bash', 'PowerShell'].includes(call?.tool_name)) why = deniedCommand(input.command);
  else if (['Edit', 'Write', 'NotebookEdit'].includes(call?.tool_name)) {
    const file = input.file_path || input.notebook_path;
    const roots = String(env.PROWL_FIX_ROOTS || '').split(path.delimiter);
    if (file && !insideRoots(file, roots)) why = `writing outside the PR's worktree and the brief folder (${roots.filter(Boolean).join(', ')})`;
  }
  return why ? {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Prowl's fix sessions don't allow ${why}.` },
  } : null;
}

/** The same Bash denials as --disallowedTools patterns: a second layer under the hook. */
export const DISALLOWED = [
  'git push', 'git remote add', 'git remote remove', 'git remote rm', 'git remote rename', 'git remote set-url',
  ...['create', 'merge', 'review', 'comment', 'close', 'edit', 'ready', 'reopen'].map(c => `gh pr ${c}`),
  ...['create', 'delete', 'edit', 'fork', 'rename', 'archive'].map(c => `gh repo ${c}`),
  ...['create', 'close', 'comment', 'delete', 'edit', 'reopen', 'transfer'].map(c => `gh issue ${c}`),
].map(c => `Bash(${c} *)`);

/** The --settings file for a fix session: registers hooks/fix-guard.mjs, with absolute paths. */
export function fenceSettings(appDir, node = process.execPath) {
  // Forward slashes and double quotes work in both the POSIX shell and cmd.exe that hooks run through.
  const q = p => `"${p.replace(/\\/g, '/')}"`;
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell|Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: `${q(node)} ${q(path.join(appDir, 'hooks', 'fix-guard.mjs'))}` }] }],
    },
  };
}
