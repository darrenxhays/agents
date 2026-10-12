// Tag and text matching. Pure functions, covered by `node prowl.mjs --self-test`.

/** Lowercase letters and digits only, so case, spaces and punctuation never matter. */
export const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Edit distance where swapping two neighbouring letters counts as one typo ("reveiw" vs "review"). */
export function typos(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** True when `tag` is `wanted`, ignoring case/spacing/punctuation, with at most `maxTypos` typos (fewer for short tags). */
export function tagMatches(tag, wanted, maxTypos) {
  const a = norm(tag);
  const b = norm(wanted);
  if (a === b) return true;
  const allowed = Math.min(maxTypos, Math.floor(b.length / 5)); // "Ready for Review" allows 2, "Review" allows 1
  return allowed > 0 && Math.abs(a.length - b.length) <= allowed && typos(a, b) <= allowed;
}

/** `tags` with every tag `drop` accepts removed, and `add` (when non-empty) appended once. */
export function swapTags(tags, drop, add) {
  const kept = tags.filter(t => !drop(t) && (!add || norm(t) !== norm(add)));
  return add ? [...kept, add] : kept;
}

/** True when `text` mentions the ticket key exactly: AB#123 does not match AB#1234, PROJ-12 not XPROJ-12. */
export const mentions = (text, key) =>
  new RegExp(`(?<![a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, 'i').test(text || '');

/** Flat `key: value` front matter at the top of a markdown file (numbers parsed), or null. */
export function frontMatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md || '');
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]] = /^\d+$/.test(kv[2]) ? Number(kv[2]) : kv[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}
