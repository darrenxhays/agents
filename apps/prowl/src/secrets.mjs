import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { HOME } from './config.mjs';

// The Jira API token lives in the OS credential store, never in config.json: the macOS Keychain, a file
// encrypted with your Windows login (DPAPI), or the Linux Secret Service (secret-tool). JIRA_API_TOKEN
// overrides all of them, for machines with no credential store. The token never goes on a command line.
const SERVICE = 'prowl-jira';
const DPAPI_FILE = path.join(HOME, 'jira-token.dpapi');
const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const opts = input => ({ encoding: 'utf8', windowsHide: true, input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PROWL_SECRET_FILE: DPAPI_FILE } });

const STORE = {
  darwin: {
    name: 'the macOS Keychain',
    read: account => execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], opts()),
    // `security -i` reads the command from stdin, which keeps the token out of the process list.
    write: (account, token) => execFileSync('security', ['-i'], opts(`add-generic-password -U -s ${SERVICE} -a "${account}" -w "${token}"\n`)),
  },
  win32: {
    name: 'a file encrypted with your Windows login',
    read: () => execFileSync('powershell', [...PS, '[Net.NetworkCredential]::new("", (Get-Content -LiteralPath $env:PROWL_SECRET_FILE | ConvertTo-SecureString)).Password'], opts()),
    write: (account, token) => execFileSync('powershell', [...PS, '$t = [Console]::In.ReadToEnd().Trim(); New-Item -ItemType Directory -Force (Split-Path $env:PROWL_SECRET_FILE) | Out-Null; ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $env:PROWL_SECRET_FILE'], opts(token)),
  },
  linux: {
    name: 'the Secret Service keyring (secret-tool)',
    read: account => execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account], opts()),
    write: (account, token) => execFileSync('secret-tool', ['store', '--label=Prowl Jira API token', 'service', SERVICE, 'account', account], opts(token)),
  },
};
const store = STORE[process.platform] || STORE.linux;
export const storeName = store.name;

/** The saved Jira API token for `account`, or '' when none is saved. */
export function readToken(account) {
  if (process.env.JIRA_API_TOKEN) return process.env.JIRA_API_TOKEN.trim();
  try {
    return store.read(account).trim();
  } catch {
    return '';
  }
}

/** Saves the token; throws with what to do when this machine has no usable credential store. */
export function saveToken(account, token) {
  // Both end up inside a quoted command for `security -i`; Atlassian emails and tokens never contain these.
  if (/[\s"\\]/.test(account) || /[\s"\\]/.test(token)) throw new Error('the email or token contains spaces, quotes or backslashes');
  try {
    store.write(account, token);
  } catch (e) {
    const why = String(e.stderr || e.message).trim().split('\n')[0];
    throw new Error(`couldn't save it to ${store.name} (${why}). Set the JIRA_API_TOKEN environment variable instead.`);
  }
  if (readToken(account) !== token && !process.env.JIRA_API_TOKEN) throw new Error(`${store.name} didn't keep the token. Set the JIRA_API_TOKEN environment variable instead.`);
}
