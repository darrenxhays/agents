// output.md's templates: the Reviewer's Review started comment, and the Builder's replies and commit messages.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';

/** The first fenced block under `## heading` in an output.md, or null. */
export function template(md, heading) {
  const lines = String(md || '').split(/\r?\n/);
  let i = lines.indexOf(`## ${heading}`);
  if (i < 0) return null;
  while (++i < lines.length && !lines[i].startsWith('## ')) {
    const open = /^(`{3,}|~{3,})/.exec(lines[i]);
    if (!open) continue;
    const end = lines.findIndex((l, j) => j > i && l.startsWith(open[1]) && !l.slice(open[1].length).trim());
    return lines.slice(i + 1, end < 0 ? undefined : end).join('\n');
  }
  return null;
}

/** The template under `## heading` in the user's output.md, or in the default's when the user's copy doesn't have it yet. */
export function outputTemplate(appDir, heading) {
  return [path.join(CONFIG_DIR, 'output.md'), path.join(appDir, 'skills', 'prowl-review', 'config', 'output.md')]
    .map(f => { try { return template(fs.readFileSync(f, 'utf8'), heading); } catch { return null; } }).find(t => t != null) ?? '';
}

/** `text` with each <name> filled in from `vars`; names it doesn't know are left as they are. */
export const fill = (text, vars) => text.replace(/<([a-z][\w #/-]*)>/gi, (m, k) => vars[k] ?? m);

/**
 * The hidden marker on each reply Prowl posts on a review thread, so a restart never posts it twice. prowl-review
 * reads replies carrying it as the author's fix or dispute, not as a new finding.
 */
export const replyMarker = (ticket, round, thread, what) => `<!-- prowl-fix ${ticket} r${round} ${thread} ${what} -->`;

// What Prowl fills in itself when it posts a review: each heading of output.md it renders, the placeholders its
// template must contain, and the fixed text it must keep (a line the Builder, or a later review, finds things by).
export const NEEDED = {
  'Review banner': { has: ['verdict', 'batch-id'] },
  'Comment prefix': { has: [] },
  'Review body': { has: ['summary', 'finding lines', 'details block'] },
  'Finding line': { has: ['SEVERITY', 'title', 'where'] },
  'Details block': { has: ['details file name', 'details fence', 'details file'], keeps: t => /<summary>[^\n]*<details file name>[^\n]*<\/summary>/.test(t) },
  'Details continued': { has: ['part 2 link'] },
  'Details part 2': { has: ['details file name', 'details fence', 'details file'], keeps: t => /<summary>[^\n]*<details file name>[^\n]*part 2[^\n]*<\/summary>/.test(t) },
  'Details file': { has: ['findings', 'still open', 'parked section'] },
  'Details finding': { has: ['id', 'SEVERITY', 'title', 'ref'], keeps: t => t.split('\n').includes('### <id> [<SEVERITY>] <title><ref>') },
  'Details parked': { has: ['parked lines'], keeps: t => t.split('\n').includes('## Parked') },
  'Parked line': { has: ['title', 'ref', 'link'] },
  'No blocking issues (approvals off)': { has: [] },
  'Inline comment': { has: ['comment prefix', 'problem', 'fix'] },
  'Also raised by': { has: ['author', 'link'] },
  'Cross-PR note': { has: ['counterpart'] },
  'Reply: still present': { has: ['comment prefix', 'sha', 'problem', 'fix'] },
  'Reply: verified fixed': { has: ['comment prefix', 'sha'] },
  'Reply: still open': { has: ['comment prefix', 'sha', 'note'] },
  'Reply: no longer applies': { has: ['comment prefix', 'sha', 'note'] },
};

/** True when `text` (a template, or null) can be used for `heading`: it has every placeholder Prowl needs and the fixed text. */
const usable = (heading, text) => text != null && NEEDED[heading].has.every(name => text.includes(`<${name}>`)) && (NEEDED[heading].keeps?.(text) ?? true);

/** The headings of the user's output.md that fall back to the default's templates: missing, or lacking a placeholder or fixed text. */
export const staleHeadings = userMd => Object.keys(NEEDED).filter(h => !usable(h, template(userMd, h)));

/**
 * The templates Prowl renders a review with: for each heading the user's, when it can be used, else the default's.
 * { get(heading), fellBack: [headings that use the default's] }. With no user copy, the default's throughout.
 */
export function outputTemplates(userMd, defaultMd) {
  const fellBack = userMd == null ? [] : staleHeadings(userMd);
  const get = heading => ((userMd != null && !fellBack.includes(heading) ? template(userMd, heading) : null) ?? template(defaultMd, heading) ?? '');
  return { get, fellBack };
}

/** outputTemplates() for the user's output.md, if any, over the one that ships with the app. */
export function loadOutputTemplates(appDir) {
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  return outputTemplates(read(path.join(CONFIG_DIR, 'output.md')), read(path.join(appDir, 'skills', 'prowl-review', 'config', 'output.md')) || '');
}
