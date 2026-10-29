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
