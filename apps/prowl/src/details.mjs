// What the details view reads, for both sides: files Prowl doesn't control (a session's log, a prompt, a result a
// session wrote), parsed once and kept until they change. Closing the details frees them (dropCache).
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { describeTool } from './sessions.mjs';

const MAX_FILES = 8;
const MAX_BYTES = 64 * 1024 * 1024;
const cache = new Map(); // "<kind>:<file>" -> { size, mtimeMs, value, lookedAt, … }, least recently used first

/** Marks `key` as just used, then drops the least recently used past 8 files or 64 MB. The one just read is always kept. */
function keep(key, hit) {
  cache.delete(key);
  cache.set(key, hit);
  const total = () => [...cache.values()].reduce((n, h) => n + (h.size || 0), 0);
  while (cache.size > 1 && (cache.size > MAX_FILES || total() > MAX_BYTES)) cache.delete(cache.keys().next().value);
  return hit.value;
}

/**
 * A file's parsed value (`parse(file)`), kept until its size or modified time changes. `every`: ms between looks, for
 * a file being written. null when the file is gone.
 */
export function cached(file, kind, parse, { every = 0, now = Date.now() } = {}) {
  const key = `${kind}:${file}`;
  const hit = cache.get(key);
  if (hit && every && now - hit.lookedAt < every) return keep(key, hit);
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(key); return null; }
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { hit.lookedAt = now; return keep(key, hit); }
  return keep(key, { size: st.size, mtimeMs: st.mtimeMs, value: parse(file), lookedAt: now });
}
/** Frees every file the details read. */
export const dropCache = () => cache.clear();
/** The files kept now, least recently used first (for the self-test). */
export const cacheKeys = () => [...cache.keys()];

// Terminal escape sequences (CSI, OSC, and a lone ESC with one character): never shown, so a file can't drive the terminal.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]?/g;
export const plain = text => String(text ?? '').replace(ESCAPES, '').replace(/\t/g, '  ');

/** Reads `file` from byte `from` to its end, as a string and the new offset. */
function readFrom(file, from, decoder) {
  const size = fs.statSync(file).size;
  if (size <= from) return ['', from];
  const buf = Buffer.alloc(size - from);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  return [decoder.write(buf), size];
}

/**
 * A text file as { line } objects (tabs to two spaces, escape sequences removed), looked at again at most every 2
 * seconds. `grows`: a file that only grows is read on from where the last read stopped, and its earlier lines keep
 * their objects (so their wrapping is kept). Trailing blank lines are dropped. null when the file is gone.
 */
export function readLines(file, { grows = false, now = Date.now() } = {}) {
  const key = `lines:${file}`;
  let hit = cache.get(key);
  if (hit && now - hit.lookedAt < 2000) return keep(key, hit);
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(key); return null; }
  if (!hit || !grows || st.size < hit.size) hit = { size: 0, mtimeMs: 0, offset: 0, partial: '', decoder: new StringDecoder('utf8'), all: [], value: [] };
  if (st.size !== hit.size || st.mtimeMs !== hit.mtimeMs) {
    const [text, offset] = readFrom(file, hit.offset, hit.decoder);
    const parts = (hit.partial + text).split('\n');
    const had = hit.partial ? hit.all.pop() : null; // the last line was cut short: it goes on
    hit.partial = parts.at(-1);
    parts.forEach((p, i) => { if (i < parts.length - 1 || p) hit.all.push(i === 0 && had ? Object.assign(had, { line: plain(p.replace(/\r$/, '')) }) : { line: plain(p.replace(/\r$/, '')) }); });
    Object.assign(hit, { size: st.size, mtimeMs: st.mtimeMs, offset });
    let end = hit.all.length;
    while (end > 0 && !hit.all[end - 1].line.trim()) end--;
    hit.value = hit.all.slice(0, end);
  }
  hit.lookedAt = now;
  return keep(key, hit);
}

const OUTPUT_LINES = 40;
/** A tool's output as text: its text parts joined, a placeholder for any other part, cut to its first 40 lines. */
function outputText(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(p => (typeof p === 'string' ? p : p?.type === 'text' ? String(p.text ?? '') : `[${p?.type || 'part'}]`)).join('\n') : content == null ? '' : JSON.stringify(content);
  const lines = plain(text).replace(/\s+$/, '').split('\n');
  if (!lines.join('').trim()) return '(no output)';
  return lines.length > OUTPUT_LINES ? [...lines.slice(0, OUTPUT_LINES), `… ${lines.length - OUTPUT_LINES} more lines`].join('\n') : lines.join('\n');
}
/** A tool call in full: its name, then a line per input field (strings as they are, anything else as JSON). */
const toolFull = c => [c.name, ...Object.entries(c.input && typeof c.input === 'object' ? c.input : {}).map(([k, v]) => `  ${k}: ${plain(typeof v === 'string' ? v : JSON.stringify(v))}`)].join('\n');

/** The entries one log line holds. `log`: where its result events are counted. */
function entriesOf(line, log) {
  let e;
  try { e = JSON.parse(line); } catch { e = null; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [{ kind: 'error', sub: false, text: plain(line), full: plain(line), error: true }]; // stderr shares the log
  const sub = Boolean(e.parent_tool_use_id);
  const out = [];
  const content = Array.isArray(e.message?.content) ? e.message.content : [];
  if (e.type === 'assistant') {
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use') out.push({ kind: 'tool', sub, text: describeTool(c), full: toolFull(c) });
      else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push({ kind: 'said', sub, text: c.text.trim().split('\n')[0], full: plain(c.text.trim()) });
    }
  } else if (e.type === 'user') {
    for (const c of content) {
      if (c?.type !== 'tool_result') continue;
      const full = outputText(c.content);
      out.push({ kind: 'output', sub, text: full.split('\n')[0], full, ...(c.is_error && { error: true }) });
    }
  } else if (e.type === 'result') {
    log.result = e;
    log.results++;
  }
  return out;
}

/**
 * A session log (Claude Code's stream-json, with stderr mixed in) as { entries, result, results }: read on from where
 * the last read stopped as the log grows, afresh if it shrank. An entry is { kind: 'tool' | 'said' | 'output' |
 * 'error', sub, text (the Activity line), full (the whole), error? }. `result` is the last result event, `results` how
 * many there were. A last line with no line break counts at once when it parses as JSON; otherwise it waits for its
 * line break, or for the log to stop growing for a second. null when the file is gone. The same value object comes
 * back each time, and earlier entries keep their objects.
 */
export function readLog(file, { now = Date.now() } = {}) {
  const key = `log:${file}`;
  let hit = cache.get(key);
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(key); return null; }
  if (!hit || st.size < hit.offset) hit = { size: 0, offset: 0, partial: '', decoder: new StringDecoder('utf8'), grewAt: now, value: { entries: [], result: null, results: 0 } };
  const log = hit.value;
  if (st.size > hit.offset) {
    const [text, offset] = readFrom(file, hit.offset, hit.decoder);
    const lines = (hit.partial + text).split('\n');
    hit.partial = lines.pop();
    for (const line of lines) if (line.trim()) log.entries.push(...entriesOf(line, log));
    Object.assign(hit, { size: st.size, offset, grewAt: now });
  }
  if (hit.partial.trim()) {
    let whole = false;
    try { whole = typeof JSON.parse(hit.partial) === 'object'; } catch { /* not finished, or not JSON */ }
    if (whole || now - hit.grewAt >= 1000) { log.entries.push(...entriesOf(hit.partial, log)); hit.partial = ''; }
  }
  return keep(key, hit);
}
