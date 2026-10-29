// The fence around Prowl's unattended sessions (today the Builder's, kind 'work'): only Prowl's own code pushes, posts
// on GitHub or changes the tracker. Pure functions, covered by `node prowl.mjs --self-test`; hooks/fence-guard.mjs runs
// fenceDecision as a PreToolUse hook in fenced sessions only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Each fenced session kind, and the environment variable that holds the folders it may write in. */
export const KINDS = { work: 'PROWL_WORK_ROOTS' };

// git, then any global options (-C dir, -c x=y, -P, --git-dir=x or --git-dir x)
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|config-env)\s+\S+|-[a-zA-Z]+|--\S+))*\s+`;
const PUSH_CONFIG = String.raw`(?:remote\.\S+\.pushurl|url\.\S+\.(?:push)?insteadof)`;
const DENY = [
  [new RegExp(`${GIT}push\\b`), 'pushing: Prowl pushes the work itself once it has checked it'],
  [new RegExp(`${GIT}(?:send-pack|subtree\\s+push|lfs\\s+push)\\b`), 'pushing: Prowl pushes the work itself once it has checked it'],
  [new RegExp(`${GIT}remote\\s+(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\\b`), 'changing git remotes'],
  [new RegExp(String.raw`\bgit\b[^;&|\n]*?(?:\s-c\s*|\bconfig\b[^;&|\n]*?\s)${PUSH_CONFIG}`, 'i'), 'changing where a remote pushes'],
  [/\bgit\b[^;&|\n]*?(?:\s-c\s*|\bconfig\b[^;&|\n]*?\s)alias\.\S+?(?:=|\s+)[^;&|\n]*\b(?:push|send-pack)\b/i, 'a git alias that pushes'],
  [/\bgh\s+pr\s+(?:create|merge|review|comment|close|edit|ready|reopen|lock|unlock)\b/, 'changing a PR: Prowl opens PRs and posts replies itself'],
  [/\bgh\s+repo\s+(?:create|delete|edit|fork|rename|archive|unarchive|sync|set-default|deploy-key|autolink)\b/, 'changing a repository'],
  [/\bgh\s+issue\s+(?:create|close|comment|delete|edit|lock|pin|reopen|transfer|unlock|unpin|develop)\b/, 'changing an issue'],
  [/\baz\s+boards\s+(?:work-item\s+(?:create|update|delete|relation\s+(?:add|remove))|(?:area|iteration)\s+\S+\s+(?:create|update|delete|add|remove))\b/, 'a write to the tracker: Prowl tags the ticket itself'],
  [/\baz\s+devops\s+invoke\b[^;&|\n]*--http-method[\s=]+['"]?(?:POST|PUT|PATCH|DELETE)\b/i, 'a write to the tracker: Prowl tags the ticket itself'],
  [/\bacli\s+jira\s+\S+\s+(?:create|edit|delete|transition|assign|comment|link|clone|archive)\b/, 'a write to the tracker: Prowl tags the ticket itself'],
];
const WRITE_METHOD = /(?:^|\s)(?:-X|--method)[\s=]*['"]?(?:POST|PATCH|PUT|DELETE)\b/i;
const GET_METHOD = /(?:^|\s)(?:-X|--method)[\s=]*['"]?GET\b/i;
const FIELDS = /(?:^|\s)(?:-[fF]|--field|--raw-field|--input)(?:\s|=)/; // gh api sends fields as a POST unless told GET
// Git subcommands, which an alias can't shadow: anything else after `git` may be an alias, and is looked up.
const GIT_BUILTINS = new Set(('add am apply archive bisect blame branch bundle cat-file check-ignore checkout cherry cherry-pick clean clone commit config '
  + 'count-objects describe diff diff-files diff-index diff-tree difftool fetch for-each-ref format-patch fsck gc grep hash-object help init log '
  + 'ls-files ls-remote ls-tree merge merge-base merge-file mktree mv name-rev notes pull push range-diff read-tree rebase reflog remote repack '
  + 'replace reset restore rev-list rev-parse revert rm send-pack shortlog show show-branch show-ref sparse-checkout stash status submodule '
  + 'subtree switch symbolic-ref tag update-index update-ref var verify-commit version whatchanged worktree write-tree lfs').split(' '));

/** Why setting git config `key` to `value` changes how or where git pushes, or ''. */
function pushConfig(key, value) {
  if (new RegExp(`^${PUSH_CONFIG}$`, 'i').test(key)) return 'changing where a remote pushes';
  if (/^alias\./i.test(key) && /\b(?:push|send-pack)\b/.test(value)) return 'a git alias that pushes';
  return '';
}

/** Why `gh api …` (one command, up to the next ; && || | or line break) writes to GitHub, or ''. */
function apiWrite(cmd) {
  if (/\bgraphql\b/.test(cmd)) {
    // A query read from a file or built by the shell can't be checked, so it is treated as a mutation.
    if (/(?:^|\s)(?:-[fF]\s*|--(?:raw-)?field[\s=]+)['"]?query=@|(?:^|\s)--input\b/.test(cmd)) return 'a GraphQL query read from a file';
    if (/\$[\w{(]|`/.test(cmd.replace(/'[^']*'/g, "''"))) return 'a GraphQL query built by the shell';
    return /\bmutation\b/.test(cmd) ? 'a GraphQL mutation' : '';
  }
  if (WRITE_METHOD.test(cmd)) return 'a write to the GitHub API';
  if (FIELDS.test(cmd) && !GET_METHOD.test(cmd)) return 'a write to the GitHub API (fields without -X GET)';
  return '';
}

// ---- A small shell lexer: commands, their words, and where their output is redirected ----

/**
 * Splits a shell command line into commands (at ; & && || | and line breaks outside quotes). Each command is a list
 * of words ({ text, dynamic }: dynamic when it holds a $ or ` the shell expands) and redirections ({ op }). Heredoc
 * bodies are skipped. `subs` holds the commands inside $(…) and `…`, which run too.
 */
export function lex(text) {
  const cmds = [[]];
  const subs = [];
  const heredocs = []; // { delim, cmd } of heredocs whose bodies start at the next line break
  let wantDelim = false;
  let word = null;
  const w = () => (word ??= { text: '', dynamic: false });
  const end = () => {
    if (!word) return;
    cmds.at(-1).push(word);
    if (wantDelim) { heredocs.push({ delim: word.text, cmd: cmds.at(-1) }); wantDelim = false; }
    word = null;
  };
  const next = () => { end(); if (cmds.at(-1).length) cmds.push([]); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      w().text += text.slice(i + 1, j < 0 ? undefined : j);
      i = j < 0 ? text.length : j;
    } else if (c === '"') {
      w();
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && i + 1 < text.length) { word.text += text[++i]; continue; }
        if (text[i] === '$' || text[i] === '`') word.dynamic = true;
        if (text[i] === '$' && text[i + 1] === '(') { // "$(…)" runs too
          let depth = 0;
          const from = i;
          for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
          word.text += text.slice(from, i + 1);
          subs.push(text.slice(from + 2, i));
          continue;
        }
        if (text[i] === '`') { // and so does "`…`"
          const j = text.indexOf('`', i + 1);
          word.text += text.slice(i, j < 0 ? undefined : j + 1);
          subs.push(text.slice(i + 1, j < 0 ? undefined : j));
          i = j < 0 ? text.length : j;
          continue;
        }
        word.text += text[i];
      }
    } else if (c === '\\') {
      if (text[i + 1] === '\n') i++;
      else w().text += text[++i] ?? '';
    } else if (c === '$' && text[i + 1] === '(') {
      let depth = 0;
      const from = i;
      for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
      Object.assign(w(), { dynamic: true }).text += text.slice(from, i + 1);
      subs.push(text.slice(from + 2, i));
    } else if (c === '`') {
      const j = text.indexOf('`', i + 1);
      Object.assign(w(), { dynamic: true }).text += text.slice(i, j < 0 ? undefined : j + 1);
      subs.push(text.slice(i + 1, j < 0 ? undefined : j));
      i = j < 0 ? text.length : j;
    } else if (c === '$') {
      Object.assign(w(), { dynamic: true }).text += c;
    } else if (c === '#' && !word) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (c === '(' || c === ')') {
      // A subshell: ( cmd ) runs cmd, and a cd inside it ends with it. A marker command tells deniedCommand.
      next();
      cmds.at(-1).push({ group: c });
      cmds.push([]);
    } else if (c === '\n' || c === ';' || c === '|' || (c === '&' && text[i + 1] !== '>')) {
      next();
      if ((c === '&' || c === '|') && text[i + 1] === c) i++;
      for (const { delim, cmd } of c === '\n' ? heredocs.splice(0) : []) { // skip the body, up to the line holding only its delimiter
        const from = i + 1;
        let eol = text.indexOf('\n', i + 1);
        while (eol >= 0 && text.slice(i + 1, eol).replace(/^\t+/, '') !== delim) { i = eol; eol = text.indexOf('\n', i + 1); }
        (cmd.bodies ??= []).push(text.slice(from, i + 1)); // kept: a shell reading it runs it
        i = eol < 0 ? text.length : eol;
      }
    } else if (c === '>' || (c === '&' && text[i + 1] === '>')) {
      if (word && /^\d+$/.test(word.text) && !word.dynamic) word = null; // 2> : the descriptor, not a word
      else end();
      let op = c === '&' ? '&>' : '>';
      if (c === '&') i++;
      while (text[i + 1] === '>' || text[i + 1] === '|') op += text[++i];
      if (text[i + 1] === '&') { op += '&'; i++; }
      cmds.at(-1).push({ op });
    } else if (c === '<') {
      end();
      let op = '<';
      while (text[i + 1] === '<' || text[i + 1] === '&' || (op === '<<' && text[i + 1] === '-')) op += text[++i];
      cmds.at(-1).push({ op });
      wantDelim = op === '<<' || op === '<<-';
    } else if (/\s/.test(c)) {
      end();
    } else {
      w().text += c;
    }
  }
  end();
  return Object.assign(cmds.filter(cmd => cmd.length), { subs });
}

/** The words a command writes to: its redirections' targets, and the paths tee, cp, mv and rm write or remove. */
function writeTargets(cmd) {
  const targets = [];
  const words = [];
  for (let i = 0; i < cmd.length; i++) {
    const t = cmd[i];
    if (!t.op) { words.push(t); continue; }
    const target = cmd[i + 1]?.op ? null : cmd[i + 1];
    if (target) i++;
    if (!target || t.op.startsWith('<')) continue; // input, or a heredoc
    if (t.op.endsWith('&') && /^(?:\d+|-)$/.test(target.text)) continue; // 2>&1: a descriptor, not a file
    targets.push({ ...target, redirect: true }); // the shell opens it, where the shell is (not env -C's folder)
  }
  let at = 0;
  const lead = ['sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{'];
  // Each wrapper's options, and those of them that take a value (env -u NAME, sudo -u user). env -S runs its value.
  const wrappers = { sudo: /^-[ughpCDRTU]$/, env: /^(?:-[uCS]|--(?:unset|chdir|split-string))$/, command: null, builtin: null, exec: /^-a$/, nohup: null, time: /^-[of]$/ };
  let split = null;
  let chdir = null; // env -C dir: where the command runs
  while (at < words.length && (/^\w+=/.test(words[at].text) || lead.includes(words[at].text))) {
    const wrapper = words[at++].text;
    if (!Object.hasOwn(wrappers, wrapper)) continue;
    while (at < words.length && /^-/.test(words[at].text)) { // command -- rm, env -i rm, env -u NAME rm
      if (/^(?:-S|--split-string)$/.test(words[at].text)) split = words[at + 1];
      if (wrapper === 'env' && /^(?:-C|--chdir)$/.test(words[at].text)) chdir = words[at + 1];
      if (wrapper === 'env' && words[at].text.startsWith('--chdir=')) chdir = { ...words[at], text: words[at].text.slice(8) };
      at += wrappers[wrapper]?.test(words[at].text) ? 2 : 1;
    }
  }
  if (split) {
    // env -S 'rm -rf' x: the split string and the words after it make one command line.
    const quote = x => (x.dynamic ? `"${x.text.replace(/["\\]/g, '\\$&')}"` : `'${x.text.replace(/'/g, "'\\''")}'`);
    return { name: '', words, args: [], chdir, split: [split.text, ...words.slice(at).map(quote)].join(' '), targets: targets.filter(Boolean) };
  }
  const name = path.basename(words[at]?.text || '');
  const args = words.slice(at + 1);
  const operands = args.filter(a => a.dynamic || !a.text.startsWith('-') || a.text === '-');
  const dirFlag = args.findIndex(a => a.text === '-t' || a.text.startsWith('--target-directory'));
  if (name === 'tee' || name === 'rm' || name === 'rmdir' || name === 'unlink') targets.push(...operands);
  else if (name === 'mv') targets.push(...operands); // a move also removes its sources
  else if (name === 'cp' && dirFlag >= 0) targets.push(args[dirFlag].text.includes('=') ? { ...args[dirFlag], text: args[dirFlag].text.split('=')[1] } : args[dirFlag + 1]);
  else if (name === 'cp' && operands.length > 1) targets.push(operands.at(-1));
  return { name, words, args, chdir, split: '', targets: targets.filter(Boolean) };
}

/** `p` as an absolute path, or '' when it depends on something the shell expands (or on a cwd the fence lost: null). */
function resolvePath(word, cwd) {
  let p = word.text;
  if (word.dynamic) {
    p = p.replace(/\$\{?(TMPDIR|TMP|TEMP|HOME)\}?(?![\w])/g, (m, v) => (v === 'HOME' ? os.homedir() : os.tmpdir()));
    if (/[$`]/.test(p)) return '';
  }
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (cwd == null && !path.isAbsolute(p)) return '';
  return path.resolve(cwd, p);
}

// ---- Web writes: curl, wget and PowerShell ----

const URLS = /\b(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})(?::\d+)?(\/[^\s'"]*)?/gi;
// A write method, or data to send: short flags may be combined (-sd, -sXPOST), and their case matters (-D, -f and -t read).
const CURL_WRITE = [/(?:^|\s)(?:-[a-zA-Z]*X\s*|--request[\s=]+)['"]?(?:POST|PUT|PATCH|DELETE)\b/i, /(?:^|\s)-[a-zA-Z]*[dFT]|(?:^|\s)--(?:data[\w-]*|form[\w-]*|upload-file|json)(?:[\s=]|$)/];
const WGET_WRITE = /(?:^|\s)--(?:method[\s=]+['"]?(?:POST|PUT|PATCH|DELETE)\b|post-data|post-file|body-data|body-file)/i;
// Options a config file adds, which can make any call a write: curl's -K, and wget's --config, or a -e that sets them.
const UNREAD_CONFIG = { curl: /(?:^|\s)(?:-[a-zA-Z]*K|--config\b)/, wget: /(?:^|\s)--config\b|(?:^|\s)(?:-e|--execute)[\s=]*['"]?(?:method|post|body|header|input|config)/i };
const CONFIG_ENV = /\b(?:CURL_HOME|XDG_CONFIG_HOME|WGETRC)\b/; // where curl and wget look for their config files
const PS_WRITE = /-Method\s+['"]?(?:Post|Put|Patch|Delete)\b|-Body\b|-InFile\b/i;

/** True when `host` is GitHub's API (api.github.com, or GitHub Enterprise's /api/) and `route` the path after it. */
const isGitHub = (host, route) => /(^|\.)api\.github\.com$/i.test(host) || (/github/i.test(host) && /^\/api\//i.test(route || ''));
const hostIn = (host, list) => list.some(h => {
  const want = String(h).toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (!want) return false;
  return want.startsWith('*.') ? host.toLowerCase().endsWith(want.slice(1)) : host.toLowerCase() === want;
});

/**
 * Why a curl, wget or PowerShell web call writes to GitHub or the tracker, or ''. Reads (GETs) are allowed. `text` is
 * the whole command line, where an earlier command may have pointed curl or wget at another config file.
 */
function webWrite(cmd, trackerHosts, text) {
  const raw = cmd.map(t => t.op || t.text).join(' ');
  const tool = /(?:^|[\s/])(curl|wget)(?:\.exe)?\s/i.exec(` ${raw} `)?.[1]?.toLowerCase() || (/\b(?:Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b/i.test(raw) ? 'ps' : '');
  if (!tool) return '';
  if (tool !== 'ps' && (UNREAD_CONFIG[tool].test(raw) || CONFIG_ENV.test(text))) return `${tool} options from a config file the fence can't read`;
  const writes = tool === 'curl' ? CURL_WRITE.some(re => re.test(raw)) : tool === 'wget' ? WGET_WRITE.test(raw) : PS_WRITE.test(raw);
  if (!writes) return '';
  const urls = cmd.filter(t => !t.op && !t.text.startsWith('-'));
  for (const u of cmd.filter(t => !t.op)) { // options too: --url=https://…
    for (const [, host, route] of u.text.matchAll(URLS)) {
      if (isGitHub(host, route)) return 'a write to the GitHub API: Prowl posts on GitHub itself';
      if (hostIn(host, trackerHosts)) return 'a write to the tracker: Prowl tags the ticket itself';
    }
  }
  if (urls.some(u => u.dynamic && /^\$|^https?:\/\/\$/.test(u.text)) || cmd.some(t => t.dynamic && /^--url=(?:https?:\/\/)?\$/.test(t.text))) return "a web write to an address the fence can't read";
  return '';
}

/**
 * Why a shell command is fenced off, or '' to allow it. `ctx`: { cwd, roots (the folders it may write in), trackerHosts,
 * alias(name) (the user's git alias of that name, or '') }.
 */
export function deniedCommand(command, ctx = {}) {
  const text = String(command || '');
  for (const [re, why] of DENY) if (re.test(text)) return why;
  // A mutation's query can span lines, so a graphql call is judged whole; anything else per command.
  for (const cmd of /\bgh\s+api\b/.test(text) ? [text, ...text.split(/&&|\|\||[;|\n]/)] : []) {
    const why = /\bgh\s+api\b/.test(cmd) && apiWrite(cmd);
    if (why) return why;
  }
  const roots = (ctx.roots || []).filter(Boolean);
  const writable = [...roots, os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])];
  let cwd = ctx.cwd === null ? null : ctx.cwd || process.cwd(); // null: lost (cd to a dir the fence can't read)
  const cmds = lex(text);
  for (const sub of cmds.subs) {
    const why = deniedCommand(sub, { ...ctx, cwd });
    if (why) return why;
  }
  const outer = []; // the cwd outside each ( … ) we're in
  for (const cmd of cmds) {
    if (cmd[0]?.group) {
      if (cmd[0].group === '(') outer.push(cwd);
      else if (outer.length) cwd = outer.pop();
      continue;
    }
    const web = webWrite(cmd, ctx.trackerHosts || [], text);
    if (web) return web;
    const { name, words, args, chdir, split, targets } = writeTargets(cmd);
    const here = chdir ? resolvePath(chdir, cwd) || null : cwd; // where this one command runs
    if (split) { // env -S 'rm -rf x': the value is the command
      const why = deniedCommand(split, { ...ctx, cwd: here });
      if (why) return why;
    }
    const dashC = ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name) ? args.findIndex(x => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x.text)) : -1; // -c, -lc, -ec
    if (dashC >= 0 && args[dashC + 1]) {
      const why = deniedCommand(args[dashC + 1].text, { ...ctx, cwd: here });
      if (why) return why;
    }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name) && dashC < 0) {
      for (const body of cmd.bodies || []) { // bash <<'SH' … SH: the heredoc is the script
        const why = deniedCommand(body, { ...ctx, cwd: here });
        if (why) return why;
      }
    }
    if (name === 'git') {
      let i = 0; // in git's own words, after env, command and the like
      let dir = here; // the alias is looked up where git runs: -C moves it
      while (args[i] && /^-/.test(args[i].text)) {
        if (args[i].text === '-C' && args[i + 1]) dir = resolvePath(args[i + 1], dir) || dir;
        if (args[i].text === '-c' && args[i + 1]) { // -c 'alias.x=push …', -c remote.origin.pushurl=…
          const why = pushConfig(args[i + 1].text.split('=')[0], args[i + 1].text.split('=').slice(1).join('='));
          if (why) return why;
        }
        i += /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|exec-path|config-env))$/.test(args[i].text) ? 2 : 1;
      }
      const sub = args[i]?.text;
      const then = args[i + 1]?.text;
      // The same as DENY, for options the regexes can't step over (a quoted -C "My App", say).
      if (sub === 'push' || sub === 'send-pack' || (['subtree', 'lfs'].includes(sub) && then === 'push')) return 'pushing: Prowl pushes the work itself once it has checked it';
      if (sub === 'remote' && /^(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/.test(then || '')) return 'changing git remotes';
      if (sub === 'config') { // git config [set|add …] [options] key [value]
        const rest = args.slice(i + 1).filter(a => !a.text.startsWith('-')).map(a => a.text);
        const k = rest.findIndex(t => /^(?:alias|remote|url)\./i.test(t));
        const why = k >= 0 && pushConfig(rest[k], rest.slice(k + 1).join(' '));
        if (why) return why;
      }
      if (sub && ctx.alias && !GIT_BUILTINS.has(sub)) {
        if (dir == null) return `the git command '${sub}', which may be an alias, in a folder the fence can't read`;
        if (/\b(?:push|send-pack)\b/.test(ctx.alias(sub, dir) || '')) return `the git alias '${sub}', which pushes`;
      }
    }
    if (!roots.length) continue;
    for (const t of targets) {
      if (/^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(t.text)) continue;
      const file = resolvePath(t, t.redirect ? cwd : here);
      if (!file) return `writing to ${t.text}, a path the fence can't resolve`;
      if (!insideRoots(file, writable)) return `writing outside the session's folders (${file})`;
    }
    if (name === 'cd') { // after if, then and the like too; cd -- dir, cd -P dir; a dir it can't read leaves the cwd unknown
      const dir = args.find(a => a.dynamic || !/^-/.test(a.text));
      cwd = dir ? resolvePath(dir, cwd) || null : os.homedir();
    }
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

/** True when MCP tool `name` matches the allow list (tool names, or patterns with * wildcards). */
export const mcpAllowed = (name, allow = []) => allow.some(a => new RegExp(`^${String(a).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name));

/**
 * The PreToolUse decision for a tool call in a fenced session: a deny output, or null to allow it. `call` is the
 * hook's stdin JSON; `env` its environment; `alias` looks up a git alias. Outside a fenced session (PROWL_SESSION
 * isn't a kind in KINDS) everything is allowed.
 */
export function fenceDecision(call, env = process.env, alias = null) {
  const kind = env.PROWL_SESSION;
  if (!Object.hasOwn(KINDS, kind || '')) return null;
  const input = call?.tool_input || {};
  const roots = String(env[KINDS[kind]] || '').split(path.delimiter).filter(Boolean);
  const tool = String(call?.tool_name || '');
  let why = '';
  if (tool.startsWith('mcp__')) {
    let allow = [];
    try { allow = JSON.parse(env.PROWL_MCP_ALLOW || '[]'); } catch { /* none */ }
    if (!mcpAllowed(tool, allow)) why = `the MCP tool ${tool}, which isn't in the allow list`;
  } else if (['Bash', 'PowerShell'].includes(tool)) {
    why = deniedCommand(input.command, { cwd: call.cwd, roots, trackerHosts: String(env.PROWL_TRACKER_HOSTS || '').split(',').filter(Boolean), alias });
  } else if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) {
    const file = input.file_path || input.notebook_path;
    if (file && !insideRoots(file, roots)) why = `writing outside the session's folders (${roots.join(', ')})`;
  }
  return why ? {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Prowl's unattended sessions don't allow ${why}.` },
  } : null;
}

/** The trackers' hosts a fenced session may read from but never write to; `site` is the configured Jira site, if any. */
export const trackerHosts = site => ['dev.azure.com', '*.visualstudio.com', '*.atlassian.net', ...(site ? [site] : [])];

/** What the fence hook reads from a fenced session's environment. */
export const fenceEnv = (kind, roots, mcpAllow = [], hosts = trackerHosts()) => {
  if (!KINDS[kind]) throw new Error(`no fence for session kind ${kind}`);
  return { PROWL_SESSION: kind, [KINDS[kind]]: roots.join(path.delimiter), PROWL_MCP_ALLOW: JSON.stringify(mcpAllow), PROWL_TRACKER_HOSTS: hosts.join(',') };
};

/** The same Bash denials as --disallowedTools patterns: a second layer under the hook. */
export const DISALLOWED = [
  'git push', 'git send-pack', 'git subtree push', 'git lfs push', 'git remote add', 'git remote remove', 'git remote rm', 'git remote rename', 'git remote set-url',
  ...['create', 'merge', 'review', 'comment', 'close', 'edit', 'ready', 'reopen'].map(c => `gh pr ${c}`),
  ...['create', 'delete', 'edit', 'fork', 'rename', 'archive'].map(c => `gh repo ${c}`),
  ...['create', 'close', 'comment', 'delete', 'edit', 'reopen', 'transfer'].map(c => `gh issue ${c}`),
  ...['create', 'update', 'delete'].map(c => `az boards work-item ${c}`),
].map(c => `Bash(${c} *)`);

/**
 * The `claude` arguments that fence a session: the denials again as --disallowedTools, and no MCP servers at all
 * unless some of their tools are allowed (the hook then denies every other MCP tool).
 */
export const fenceArgs = (mcpAllow = []) => [
  '--disallowedTools', ...DISALLOWED, ...(mcpAllow.length ? [] : ['mcp__*']),
  ...(mcpAllow.length ? [] : ['--strict-mcp-config']),
];

/** The --settings file for a fenced session: registers hooks/fence-guard.mjs, with absolute paths. */
export function fenceSettings(appDir, node = process.execPath) {
  // Forward slashes and double quotes work in both the POSIX shell and cmd.exe that hooks run through.
  const q = p => `"${p.replace(/\\/g, '/')}"`;
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell|Edit|Write|NotebookEdit|mcp__.*', hooks: [{ type: 'command', command: `${q(node)} ${q(path.join(appDir, 'hooks', 'fence-guard.mjs'))}` }] }],
    },
  };
}
