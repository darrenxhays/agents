#!/usr/bin/env node
// PreToolUse hook for Prowl's fenced sessions, registered per session with --settings (never in the plugin's own hooks,
// so review sessions don't load it). Reads the tool call as JSON on stdin; denies pushes, GitHub and tracker writes,
// MCP tools outside the allow list and writes outside the session's folders. Does nothing outside a fenced session.
import { execFileSync } from 'node:child_process';
import { fenceDecision } from '../src/fence.mjs';

/** The user's git alias `name`, as git would expand it in `cwd`, or ''. */
const alias = (name, cwd) => {
  try {
    return execFileSync('git', ['-C', cwd || '.', 'config', '--get', `alias.${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    return '';
  }
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  let call = null;
  try { call = JSON.parse(input); } catch { /* not a tool call: allow */ }
  const decision = fenceDecision(call, process.env, alias);
  if (decision) process.stdout.write(JSON.stringify(decision));
});
