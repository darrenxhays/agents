// The first launch of 2.12.0, which removed Fix my PRs: stops any fix session still running (pushing nothing), removes
// the worktrees made for fixes, moves the fix.* settings to config.fix-backup.json, deletes config/fix.md if it was
// never edited, and keeps past fixes in the Reviewer's History. Runs again on the next launch until every fix session
// is confirmed stopped. Nothing is pushed, replied or tagged.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, writeJson } from './config.mjs';
import { removeWorktree } from './git.mjs';
import { stopProcess } from './proc.mjs';
import { alive } from './sessions.mjs';
import { hash } from './update.mjs';

const ENDED = ['done', 'skipped', 'dropped', 'failed', 'stopped'];
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const seenOf = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8')); } catch { return null; } };

/** True when there is anything of Fix my PRs left to migrate. fix.md counts until the migration has looked at it once. */
export const needsMigration = (cfg, state, home = HOME) => 'fix' in cfg || Boolean(state.loops || state.needs)
  || (state.fixes || []).some(f => !ENDED.includes(f.status) || (f.worktree && fs.existsSync(f.worktree)))
  || (fs.existsSync(path.join(home, 'config', 'fix.md')) && Boolean(seenOf(home)?.defaults?.['fix.md']));

/**
 * Migrates what Fix my PRs left behind. `deps`: { saveConfig, saveState, stop(pid) (resolves true once it has exited),
 * isRunning(fix), remove(clone, worktree), home }. Resolves with the Update Notes' lines: [{ text, path }].
 */
export async function migrateFixes(cfg, state, deps) {
  const { saveConfig, saveState, stop = stopProcess, isRunning = alive, remove = removeWorktree, home = HOME } = deps;
  const configDir = path.join(home, 'config');
  const notes = [];
  let stopped = 0;
  let kept = 0;
  const live = new Set(); // sessions whose exit isn't confirmed: their worktrees stay
  for (const fix of state.fixes || []) {
    // Ended ones too: 2.11.3 marked a fix taken over as stopped as soon as it signalled it, before it had exited.
    if (fix.pid && isRunning(fix)) {
      if (!(await stop(fix.pid))) { kept++; live.add(fix); continue; } // not confirmed: keep its status, pid and worktree, and try again next launch
      stopped++;
    }
    if (ENDED.includes(fix.status)) continue;
    Object.assign(fix, { status: 'stopped', note: 'Fix my PRs was removed in 2.12.0; nothing was pushed', endedAt: fix.endedAt || Date.now() });
  }
  const liveWorktrees = new Set([...live].map(f => f.worktree)); // an older record can share a running one's path
  for (const fix of (state.fixes || []).filter(f => f.worktree && ENDED.includes(f.status) && !live.has(f) && !liveWorktrees.has(f.worktree))) {
    if (!fs.existsSync(fix.worktree)) continue;
    await remove(path.join(cfg.workDir, fix.pr.repo.split('/')[1]), fix.worktree).catch(() => fs.rmSync(fix.worktree, { recursive: true, force: true }));
  }
  for (const f of state.fixes || []) f.kind = 'Fix my PRs'; // still shown in the Reviewer's History
  delete state.loops;
  delete state.needs;
  saveState(state);
  if (stopped) notes.push({ text: `Stopped ${stopped} Fix my PRs session${stopped > 1 ? 's' : ''} that ${stopped > 1 ? 'were' : 'was'} still running. Nothing was pushed, replied or tagged, and ${stopped > 1 ? 'their worktrees were' : 'its worktree was'} removed.`, path: path.join(home, 'state.json') });
  if (kept) notes.push({ text: `Couldn't confirm that ${kept} Fix my PRs session${kept > 1 ? 's' : ''} stopped. Prowl tries again on the next launch; nothing is pushed in the meantime.`, path: path.join(home, 'state.json') });

  if ('fix' in cfg) {
    const backup = path.join(home, 'config.fix-backup.json');
    writeJson(backup, { savedAt: new Date().toISOString(), fix: cfg.fix });
    delete cfg.fix;
    saveConfig(cfg);
    notes.push({ text: "Fix my PRs was removed: the Builder (the new Builder tab) now opens PRs and works through their review feedback. Your fix.* settings, Fix comments from and MCP tools included, were moved to config.fix-backup.json. The Builder's settings don't carry them over: set them in the Builder's Config.", path: backup });
  }
  const fixMd = path.join(configDir, 'fix.md');
  const text = read(fixMd);
  if (text !== null) {
    const seen = seenOf(home);
    if (seen?.defaults?.['fix.md'] === hash(text)) {
      fs.rmSync(fixMd);
      notes.push({ text: 'fix.md (Fix rules) was deleted: you had never edited it, and nothing reads it now.', path: configDir });
    } else {
      notes.push({ text: "Your edited fix.md (Fix rules) was kept, but nothing reads it now. The Builder's rules are in build.md: move what you need there.", path: fixMd });
    }
    if (seen?.defaults) {
      delete seen.defaults['fix.md'];
      writeJson(path.join(home, 'seen.json'), seen);
    }
  }
  return notes;
}
