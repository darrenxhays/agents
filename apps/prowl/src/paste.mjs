// What a paste holds, for quick reviews and quick builds alike: PRs, tickets, and the rest (a quick build's
// instructions). And a quick review's or quick build's name. Shared by both sides; neither imports the other.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCli } from './proc.mjs';

// A PR link (https://github.com/owner/repo/pull/12, with any tail) or owner/repo#12.
const PR = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\/pull\/|#)(\d+)(?:[/?#].*)?$/i;
// A work item: AB#123, or its link (…/_workitems/edit/123). An issue: PROJ-123 (in capitals, so ordinary words with a
// dash and a number aren't taken for one), or its link (…/browse/PROJ-123).
const TICKETS = {
  ado: [[/^AB#(\d+)$/i, m => `AB#${m[1]}`], [/^https?:\/\/\S+\/_workitems\/edit\/(\d+)(?:[/?#].*)?$/i, m => `AB#${m[1]}`]],
  jira: [[/^([A-Z][A-Z0-9_]+-\d+)$/, m => m[1]], [/^https?:\/\/\S+\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)(?:[/?#].*)?$/, m => m[1].toUpperCase()]],
};

/** A ticket key in `word` for the task board (`taskBoard`: 'ado' or 'jira'), or ''. */
export function ticketKey(word, taskBoard) {
  for (const [re, key] of TICKETS[taskBoard] || []) {
    const m = re.exec(String(word).trim());
    if (m) return key(m);
  }
  return '';
}

/**
 * A paste split into { prs: [{ repo, number }], tickets: [key], rest }: each PR and ticket once, in order, and `rest` the
 * text left once they're taken out (lines kept). Words are separated by spaces, commas or lines; a word's surrounding
 * brackets and trailing full stop or colon don't count.
 */
export function parsePaste(text, taskBoard) {
  const prs = [];
  const tickets = [];
  const rest = String(text ?? '').replace(/[^\s,]+/g, raw => {
    const word = raw.replace(/^[(<[]+/, '').replace(/[)\]>.:;!?]+$/, '');
    const pr = PR.exec(word);
    if (pr) {
      if (!prs.some(r => r.repo.toLowerCase() === pr[1].toLowerCase() && r.number === Number(pr[2]))) prs.push({ repo: pr[1], number: Number(pr[2]) });
      return '';
    }
    const key = ticketKey(word, taskBoard);
    if (key) {
      if (!tickets.includes(key)) tickets.push(key);
      return '';
    }
    return raw;
  });
  // Each line's words, without the commas left alone where a PR or ticket was taken out.
  const lines = rest.split('\n').map(l => l.split(/\s+/).filter(w => w && !/^,+$/.test(w)).join(' ').replace(/,$/, ''));
  return { prs, tickets, rest: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** The first word of `rest` that a quick review can't take, for its error: quick reviews take PRs and tickets only. */
export const notARef = rest => String(rest).split(/[\s,]+/).find(Boolean) || '';

/**
 * A short name for a quick review or build, from what it works on (`about`: the paste, PR titles): one call to a small
 * model. '' when it can't be had, and the caller falls back to its number.
 */
export async function autoName(cfg, about, { model = 'claude-haiku-5-5', timeoutMs = 60_000 } = {}) {
  const prompt = [
    'Name this piece of work in 3 to 6 plain words, as a title someone would scan in a list. Reply with the name only: no quotes, no full stop.',
    '',
    '<work>',
    String(about).slice(0, 4000),
    '</work>',
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prowl-name-'));
  try {
    const out = await new Promise(resolve => {
      const p = spawnCli('claude', ['-p', '--model', model, '--max-turns', '1', '--output-format', 'text', '--tools', ''], { cwd: dir, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
      let text = '';
      const timer = setTimeout(() => { p.kill(); resolve(''); }, timeoutMs);
      p.stdout.on('data', d => (text += d));
      p.on('error', () => { clearTimeout(timer); resolve(''); });
      p.on('close', code => { clearTimeout(timer); resolve(code === 0 ? text : ''); });
      p.stdin.end(prompt);
    });
    return cleanName(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A name as typed or as a model gave it: one line, no quotes or control characters, at most 60 characters. */
export const cleanName = s => String(s || '').split('\n').map(l => l.trim()).find(Boolean)?.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^["'`*]+|["'`*.]+$/g, '').trim().slice(0, 60) || '';
