// The guards Prowl's own code runs before it pushes anything a session committed. Pure functions, covered by the self-test.
import { globRe } from './checks.mjs';

const short = sha => String(sha || '').slice(0, 7);

/** Each path in a `git diff --numstat` line, both sides of a rename. */
function numstatPaths(file) {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(file);
  if (brace) return [brace[1] + brace[2] + brace[4], brace[1] + brace[3] + brace[4]].map(p => p.replace(/\/\//g, '/'));
  return file.includes(' => ') ? file.split(' => ') : [file];
}

/**
 * The rows of `git diff --numstat`: [{ add, del, paths }]. With -z (what the Builder runs) paths come as they are,
 * never quoted, and a rename as its two paths; without it, as the self-test writes them, a rename is old => new.
 */
function numstatRows(numstat) {
  const text = String(numstat);
  if (!text.includes('\0')) {
    return text.split('\n').filter(Boolean).map(row => {
      const [add, del, ...rest] = row.split('\t');
      return { add, del, paths: numstatPaths(rest.join('\t')) };
    });
  }
  const parts = text.split('\0');
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [add, del, ...rest] = parts[i].split('\t');
    const file = rest.join('\t');
    rows.push({ add, del, paths: file ? [file] : [parts[++i], parts[++i]].filter(Boolean) });
  }
  return rows;
}

// Secrets that must never be pushed. One list, so it is easy to extend.
export const SECRET_PATTERNS = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, 'a GitLab token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/, 'an API secret key'],
  [/\b[rs]k_live_[0-9A-Za-z]{20,}\b/, 'a Stripe key'],
  [/\b(?:password|passwd|pwd|secret|client_secret|api_?key)\s*[:=]\s*["'][^"'\s$]{6,}["']/i, 'a password or secret with a literal value'],
  [/^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET)[A-Z0-9_]*=[^\s"'$]{6,}\s*$/, 'a password or secret with a literal value'],
];

/**
 * What stops a push: [{ kind, text }]. `moved` (the remote branch isn't at `expected`, the commit Prowl last saw
 * there, or '' for a branch that doesn't exist yet) drops the push; any other failure goes to Needs you.
 * `ancestor`: `base` is an ancestor of HEAD. `onBranch`: HEAD is the tip of the branch being pushed. `numstat` (-z)
 * covers everything from `base`, and `diff` (-U0) each commit since it, so a secret a later commit removes still counts.
 */
export function guardFailures({ base, head, ancestor, onBranch = true, remote, expected = base, numstat, diff }, { maxChangedLines, protectedPaths = [] }) {
  const out = [];
  if ((remote || '') !== (expected || '')) {
    const now = remote ? `moved to ${short(remote)}` : 'was deleted';
    return [{ kind: 'moved', text: expected ? `the remote branch ${now} since ${short(expected)}` : `the remote branch already exists, at ${short(remote)}` }];
  }
  if (!ancestor || head === base) out.push({ kind: 'guard', text: head === base ? 'there is no new commit to push' : `the commits don't sit on top of ${short(base)} (history was rewritten)` });
  if (!onBranch) out.push({ kind: 'guard', text: "the commits aren't on Prowl's branch" });
  let lines = 0;
  const files = [];
  for (const { add, del, paths } of numstatRows(numstat)) {
    lines += (Number(add) || 0) + (Number(del) || 0); // binary files show "-"
    files.push(...paths);
  }
  if (lines > maxChangedLines) out.push({ kind: 'guard', text: `it changes ${lines} lines, over Max lines changed (${maxChangedLines})` });
  const hit = files.filter(f => protectedPaths.some(g => globRe(g).test(f)));
  if (hit.length) out.push({ kind: 'guard', text: `it changes ${hit.slice(0, 3).join(', ')}, which match Paths that need a person` });
  // Added lines: "+…", or in a merge's combined diff (--cc) "++…" or " +…", without the markers. "+++ b/file" is a header.
  const added = String(diff).split('\n').filter(l => /^[+ ]?\+/.test(l) && !/^\+\+\+ (?:[ab]\/|\/dev\/null)/.test(l)).map(l => l.replace(/^(?:\+\+|[ +]\+|\+)/, ''));
  const secrets = [...new Set(added.flatMap(l => SECRET_PATTERNS.filter(([re]) => re.test(l)).map(([, what]) => what)))];
  if (secrets.length) out.push({ kind: 'guard', text: `its added lines look like they hold ${secrets.join(' and ')}` });
  return out;
}

/** Why Prowl won't push to `branch`, or '': never a repo's default branch, nor one matching Branches never pushed. */
export function branchRefusal(branch, defaultBranch, protectedBranches = []) {
  if (branch === defaultBranch) return `${branch} is the repo's default branch`;
  if (protectedBranches.some(g => globRe(g).test(branch))) return `${branch} matches Branches never pushed`;
  return '';
}

/**
 * Why Prowl won't work on a PR, or '': it must be the user's, not from a fork, and not on a protected branch; nor a
 * draft, unless `drafts` (Pick up drafts).
 */
export function prRefusal(facts, pr, me, protectedBranches = [], { drafts = false } = {}) {
  const name = `${pr.repo}#${pr.number}`;
  const author = facts.author || pr.author || '';
  if (!me || author.toLowerCase() !== me.toLowerCase()) return `${name} isn't yours, so Prowl won't push to it`;
  if (facts.draft && !drafts) return `${name} is a draft`;
  if (facts.fork) return `${name} comes from a fork, so Prowl won't push to it`;
  const why = branchRefusal(facts.headBranch, facts.defaultBranch, protectedBranches);
  return why ? `${name}'s branch ${why}` : '';
}
