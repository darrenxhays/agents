#!/usr/bin/env node
// PreToolUse hook for Prowl's fix sessions, registered per session with --settings (never in the plugin's own hooks,
// so review sessions don't load it). Reads the tool call as JSON on stdin; denies pushes, GitHub writes and edits
// outside the PR's worktree. Does nothing unless PROWL_SESSION=fix.
import { fenceDecision } from '../src/fence.mjs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  let call = null;
  try { call = JSON.parse(input); } catch { /* not a tool call: allow */ }
  const decision = fenceDecision(call);
  if (decision) process.stdout.write(JSON.stringify(decision));
});
