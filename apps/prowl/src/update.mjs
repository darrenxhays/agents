import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
