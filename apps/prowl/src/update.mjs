import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_DIR, CONFIG_PATH, HOME, loadConfig, newSettings, saveConfig, writeJson } from './config.mjs';

// Releases are version bumps in .claude-plugin/plugin.json on main; the installer there does the update.
const RAW = 'https://raw.githubusercontent.com/darrenxhays/agents/main/apps/prowl';

/** True when version a (x.y.z) is higher than b. */
export function newer(a, b) {
  const [x, y] = [a, b].map(v => String(v).split('.').map(n => parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export const localVersion = appDir => JSON.parse(fs.readFileSync(path.join(appDir, '.claude-plugin', 'plugin.json'), 'utf8')).version;

/** The released version when it is newer than this copy, else ''. Offline or any other failure just means no update. */
export async function availableUpdate(appDir) {
  try {
    const res = await fetch(`${RAW}/.claude-plugin/plugin.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return '';
    const { version } = await res.json();
    return newer(version, localVersion(appDir)) ? version : '';
  } catch {
    return '';
  }
}

/** Runs the released installer in update mode in this terminal; true when it succeeded. */
export function installUpdate() {
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `& ([scriptblock]::Create((Invoke-RestMethod ${RAW}/install.ps1))) -Update`], { stdio: 'inherit' })
    : spawnSync('sh', ['-c', `script=$(curl -fsSL --retry 3 ${RAW}/install.sh) && sh -c "$script" install --update`], { stdio: 'inherit' });
  return r.status === 0;
}

const SEEN_PATH = path.join(HOME, 'seen.json'); // the version last launched, and the defaults the user's config files match
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
// Config files renamed by a release: the user's copy, edited or not, moves to the new name.
const RENAMED = { 'axis-catalog.md': 'review-axis-catalog.md' };
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/** CHANGELOG.md's entries, [{ version, items }]: a `## x.y.z` heading, then `- ` items (an item may wrap onto more lines). */
export const changelog = text => text.split(/^## /m).slice(1).map(entry => {
  const [head, ...lines] = entry.split('\n');
  const items = [];
  for (const l of lines.map(x => x.trim())) {
    if (l.startsWith('- ')) items.push(l.slice(2));
    else if (l && items.length) items[items.length - 1] += ` ${l}`;
  }
  return { version: head.trim().split(/\s+/)[0], items };
});

/** The `## heading` section of a markdown file, up to the next `## ` heading, or null. */
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end).trimEnd();
}

/**
 * Keeps the user's copies of the review config (userDir) in step with the shipped defaults (defaultDir): copies in any
 * that are missing, moves a pre-2.3 signature.md into output.md, moves renamed files to their new names, and replaces a copy the user never edited when its
 * default changes. An edited copy is never touched. `synced` maps each file to the hash of the default it was last
 * synced with, and is updated in place. `announce` notes files new to the folder (not on a fresh install).
 * Returns what changed: [{ text, path }].
 */
export function syncConfigFiles(defaultDir, userDir, synced, announce) {
  fs.mkdirSync(userDir, { recursive: true });
  const notes = [];
  const signature = path.join(userDir, 'signature.md');
  const output = path.join(userDir, 'output.md');
  const old = read(signature);
  if (old !== null && read(output) === null) {
    const def = read(path.join(defaultDir, 'output.md'));
    let text = def;
    for (const h of ['Review banner', 'Comment prefix']) {
      const [mine, theirs] = [section(old, h), section(def, h)];
      if (mine && theirs) text = text.replace(theirs, () => mine);
    }
    fs.writeFileSync(output, text);
    fs.renameSync(signature, `${signature}.old`);
    synced['output.md'] = hash(def);
    notes.push({ text: 'Your signature.md is now part of output.md, which templates everything Prowl posts. The old file is kept as signature.md.old.', path: output });
  }
  for (const [from, to] of Object.entries(RENAMED)) {
    const [old, now] = [path.join(userDir, from), path.join(userDir, to)];
    if (!fs.existsSync(old) || fs.existsSync(now)) continue;
    fs.renameSync(old, now);
    if (from in synced) synced[to] = synced[from];
    delete synced[from];
    notes.push({ text: `${from} is now ${to}`, path: now });
  }
  for (const name of fs.readdirSync(defaultDir).filter(f => f.endsWith('.md')).sort()) {
    const def = read(path.join(defaultDir, name));
    const h = hash(def);
    const mine = path.join(userDir, name);
    const cur = read(mine);
    if (cur === null) {
      fs.writeFileSync(mine, def);
      if (announce && !(name in synced)) notes.push({ text: `${name} added to your config folder`, path: mine });
    } else if (synced[name] !== h && hash(cur) !== h) {
      if (hash(cur) === synced[name]) {
        fs.writeFileSync(mine, def);
        notes.push({ text: `${name} updated to the new default (you hadn't edited it)`, path: mine });
      } else {
        const why = name in synced ? `The default ${name} changed. Your edited copy was kept` : `Your ${name} differs from this version's default and was kept`;
        notes.push({ text: `${why}: compare it with the new default`, path: path.join(defaultDir, name) });
      }
    }
    synced[name] = h;
  }
  return notes;
}

/**
 * Once per launch, after any update: syncs the user's config files and returns the Update Notes, or null when there
 * is nothing new: { version, versions: [{ version, items }] (changelog entries since the last launch), files: [{ text, path }] }.
 */
export function updateNotes(appDir) {
  let seen = null;
  try { seen = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')); } catch { /* a fresh install, or an update from before 2.3.0 */ }
  // Before 2.3.0 there was no seen.json: a poller.log means Prowl has run before, so this launch follows an update.
  const fresh = !seen && !fs.existsSync(path.join(HOME, 'poller.log'));
  const version = localVersion(appDir);
  const synced = seen?.defaults || {};
  // Both skills' defaults share one folder, so their file names must differ.
  const files = ['prowl-review', 'prowl-fix'].flatMap(skill => syncConfigFiles(path.join(appDir, 'skills', skill, 'config'), CONFIG_DIR, synced, !fresh));
  const added = fresh ? [] : newSettings();
  if (added.length) {
    saveConfig(loadConfig()); // writes the new settings with their defaults, so they are announced once
    files.push({ text: `New setting${added.length > 1 ? 's' : ''}: ${added.join(', ')}. Change ${added.length > 1 ? 'them' : 'it'} in Config (4)`, path: CONFIG_PATH });
  }
  const versions = fresh ? [] : changelog(read(path.join(appDir, 'CHANGELOG.md')) || '')
    .filter(e => newer(e.version, seen?.version || '0') && !newer(e.version, version));
  writeJson(SEEN_PATH, { version, defaults: synced });
  return versions.length || files.length ? { version, versions, files } : null;
}

/** The Update Notes as plain text, for --once. */
export const notesText = n => [
  `Update Notes · Prowl ${n.version}`,
  ...n.versions.flatMap(v => ['', v.version, ...v.items.map(i => `  • ${i}`)]),
  ...(n.files.length ? ['', 'Your config', ...n.files.flatMap(f => [`  • ${f.text}`, `    ${f.path}`])] : []),
].join('\n');
