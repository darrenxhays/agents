import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventName, Hook, ModelUsage, On, StreamNext } from 'claude-code'

import type { Cache, Handoff, KeepWarm, Limit, Meter } from '../types'
import type { Settings } from './settings'

type In<E extends EventName> = Parameters<Hook<E>>[1]

const meter = atom({ plugin: 'helm', key: 'meter' } as const, null)
const cache = atom({ plugin: 'helm', key: 'cache' } as const, null)
const now = atom({ plugin: 'helm', key: 'now' } as const, 0)
const handoff = atom({ plugin: 'helm', key: 'handoff' } as const, { phase: 'idle' } as Handoff)
const keep = atom({ plugin: 'helm', key: 'keep' } as const, { count: 0, isRefreshing: false } as KeepWarm)
const busy = atom({ plugin: 'helm', key: 'busy' } as const, false)
const limits = atom({ plugin: 'helm', key: 'limits' } as const, [] as Limit[])
const showUsage = atom({ plugin: 'helm', key: 'showUsage' } as const, false)
const showConfig = atom({ plugin: 'helm', key: 'showConfig' } as const, false)

const HANDOFF_PROMPT = `Write a handoff prompt that a fresh Claude Code session (with none of this conversation's context) will receive as its first message, so it can continue this work seamlessly.

Include, concisely:
- The overall goal and what the user ultimately wants
- What has been done so far, and the current state (branch, files created or changed, with paths)
- Key decisions, constraints and user preferences established in this session, with the reasons
- Anything tried that did not work, so it is not repeated
- Open questions and known issues
- The concrete next steps, in order

Write it in the second person, addressed to the next session. Output only the handoff prompt itself: no preamble, no closing remarks, no code fences around the whole thing.`

const PING_PROMPT = 'Cache keep-alive ping. Reply with only: ok'

// ── colors ──────────────────────────────────────────────────────────────────

type Rgb = [number, number, number]
type Stop = [number, Rgb]

// Context heat: green while roomy, through yellow and orange, to red near full.
const HEAT: Stop[] = [
  [0, [46, 160, 67]],
  [45, [63, 185, 80]],
  [65, [210, 153, 34]],
  [82, [219, 109, 40]],
  [95, [248, 81, 73]],
  [100, [218, 54, 51]],
]

// Cache life: cyan to violet while fresh.
const FRESH: Stop[] = [
  [0, [57, 211, 242]],
  [100, [163, 113, 247]],
]

const TRACK = '#1f242c'
const TRACK_TEXT = '#c9d1d9'

const hex = (c: Rgb) => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`

const mix = (stops: Stop[], at: number): Rgb => {
  const p = Math.min(100, Math.max(0, at))
  let i = 0
  while (i < stops.length - 2 && p > stops[i + 1]![0]) i++
  const [p0, c0] = stops[i]!
  const [p1, c1] = stops[i + 1]!
  const t = p1 === p0 ? 0 : Math.min(1, Math.max(0, (p - p0) / (p1 - p0)))

  return [0, 1, 2].map(k => c0[k]! + (c1[k]! - c0[k]!) * t) as Rgb
}

const lighten = (c: Rgb, by: number): Rgb => c.map(v => v + (255 - v) * by) as Rgb

// ── formatting ──────────────────────────────────────────────────────────────

export const kilo = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000))

  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const timeOfDay = (ms: number) => {
  const d = new Date(ms)
  const h = d.getHours()

  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

export const center = (text: string, width: number) => {
  const pad = Math.max(0, width - text.length)

  return ' '.repeat(Math.floor(pad / 2)) + text + ' '.repeat(Math.ceil(pad / 2))
}

// ── bars ────────────────────────────────────────────────────────────────────

export type Cell = { ch: string; fg?: string; bg?: string; bold?: boolean }

type BarSpec = {
  width: number
  fraction: number
  color: (at: number) => Rgb
  label: string
  track?: string
  sweep?: number
  marker?: number
  right?: { text: string; fg: string }
}

const PARTIALS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// One full-width bar: a gradient fill with sub-cell precision at its edge, an
// optional shimmer sweeping the fill, an optional marker, the label inside.
export const barCells = ({ width, fraction, color, label, track = TRACK, sweep, marker, right }: BarSpec): Cell[] => {
  const exact = Math.min(1, Math.max(0, fraction)) * width
  const full = Math.min(width, Math.floor(exact))
  const eighths = Math.floor((exact - full) * 8)
  const glowAt = sweep === undefined || full === 0 ? -99 : sweep % (full + 10)
  const cells: Cell[] = []
  for (let i = 0; i < width; i++) {
    const base = color(((i + 0.5) / width) * 100)
    if (i < full) {
      const glow = Math.max(0, 1 - Math.abs(i - glowAt) / 2.5) * 0.45
      cells.push({ ch: ' ', bg: hex(lighten(base, glow)) })
    } else if (i === full && eighths > 0) {
      cells.push({ ch: PARTIALS[eighths]!, fg: hex(base), bg: track })
    } else {
      cells.push({ ch: ' ', bg: track })
    }
  }
  if (marker !== undefined) {
    const at = Math.min(width - 1, Math.max(0, Math.round(marker * width)))
    cells[at] = { ch: '┃', fg: at < full ? '#ffffff' : '#8b949e', bg: cells[at]!.bg }
  }
  const text = label.length > width - 2 ? `${label.slice(0, width - 3)}…` : label
  const start = 1
  for (let k = 0; k < text.length; k++) {
    const cell = cells[start + k]!
    cells[start + k] = { ch: text[k]!, bg: cell.bg, fg: start + k < full ? '#ffffff' : TRACK_TEXT, bold: true }
  }
  if (right !== undefined) {
    const from = width - 1 - right.text.length
    for (let k = 0; k < right.text.length && from + k > start + text.length; k++) {
      const cell = cells[from + k]!
      cells[from + k] = { ch: right.text[k]!, bg: cell.bg, fg: from + k < full ? '#ffffff' : right.fg, bold: true }
    }
  }

  return cells
}

// Neighbouring cells with the same style become one run.
export const runs = (cells: Cell[]) => {
  const out: Cell[] = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last && last.fg === c.fg && last.bg === c.bg && last.bold === c.bold) last.ch += c.ch
    else out.push({ ...c })
  }

  return out
}

export const heat = (at: number) => mix(HEAT, at)

export const WINDOWS: Record<string, { name: string; ms: number }> = {
  five_hour: { name: '5-HOUR', ms: 5 * 3600_000 },
  seven_day: { name: 'WEEKLY', ms: 7 * 24 * 3600_000 },
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const resetLabel = (iso: string | undefined, isWeek: boolean) => {
  if (iso === undefined) return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''

  return ` · resets ${isWeek ? `${DAYS[new Date(ms).getDay()]} ` : ''}${timeOfDay(ms)}`
}

async function refreshLimits($: EngineInterface) {
  const { rateLimits } = await $.session.usage()
  await update($, limits, () => rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })))
}

export async function toggleUsage($: EngineInterface) {
  const isOpening = !(await read($, showUsage))
  await update($, showUsage, () => isOpening)
  if (isOpening) {
    // One panel at a time under the buttons.
    await update($, showConfig, () => false)
    const at = await $.clock.now()
    await update($, now, () => at)
    await refreshLimits($)
  }
}

// ── actions ─────────────────────────────────────────────────────────────────

export async function writeHandoff($: EngineInterface, isAuto: boolean) {
  await update($, handoff, () => ({ phase: 'writing' as const, action: 'handoff' as const, isAuto }))
  try {
    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!reply.isAnswered) {
      await update($, handoff, () => ({ phase: 'failed' as const, action: 'handoff' as const, reason: reply.reason }))
      $.ui.toast(`Handoff failed: ${reply.reason}`)
      return
    }
    const text = reply.text.trim()
    const at = await $.clock.now()
    await $.store.set('lastHandoff', { at, text })
    await $.command.run({ command: 'clear' })
    const filled = await $.prompt.fill({ text })
    await update($, handoff, () => ({ phase: 'idle' as const }))
    const how = isAuto ? 'Auto-handoff' : 'Handoff'
    const note = filled.isFilled
      ? `${how} at ${timeOfDay(at)} — review the prompt, then press Enter`
      : `${how} at ${timeOfDay(at)} — the prompt box refused it (${filled.refusal ?? 'unknown'}); text saved in the mod's store`
    await update($, keep, () => ({ count: 0, isRefreshing: false, note }))
    $.ui.toast(note)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await update($, handoff, () => ({ phase: 'failed' as const, action: 'handoff' as const, reason }))
    $.ui.toast(`Handoff failed: ${reason}`)
  }
}

// After any compaction of the main conversation the old cache entry is dead
// and the compacted one is written by the next request: no countdown until then.
async function afterCompact($: EngineInterface, tokensAfter: number | undefined, note: string) {
  await update($, cache, () => null)
  await update($, meter, m =>
    m === null
      ? m
      : tokensAfter === undefined
        ? { window: m.window }
        : { window: m.window, tokens: tokensAfter, percent: Math.round((tokensAfter / m.window) * 100) },
  )
  await update($, keep, () => ({ count: 0, isRefreshing: false, note }))
}

const compactNote = (isAuto: boolean, at: number, before?: number, after?: number, read?: number) => {
  const how = isAuto ? 'Auto-compact' : 'Compacted'
  const size = before !== undefined && after !== undefined ? `: ${kilo(before)} → ${kilo(after)}` : ''
  const cached = read === undefined ? '' : ` (read ${kilo(read)} from cache)`

  return `${how} at ${timeOfDay(at)}${size}${cached} — cache starts on your next prompt`
}

export async function compactNow($: EngineInterface, isAuto: boolean) {
  await update($, handoff, () => ({ phase: 'writing' as const, action: 'compact' as const, isAuto }))
  try {
    const result = await $.session.compact()
    if (result.skip !== undefined) {
      await update($, handoff, () => ({ phase: 'failed' as const, action: 'compact' as const, reason: result.skip }))
      $.ui.toast(`Compact skipped: ${result.skip}`)
      return
    }
    const at = await $.clock.now()
    const note = compactNote(isAuto, at, result.tokensBefore, result.tokensAfter, result.usage?.cache_read_input_tokens)
    await afterCompact($, result.tokensAfter, note)
    await update($, handoff, () => ({ phase: 'idle' as const }))
    $.ui.toast(note)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await update($, handoff, () => ({ phase: 'failed' as const, action: 'compact' as const, reason }))
    $.ui.toast(`Compact failed: ${reason}`)
  }
}

// A fork over the conversation (a keep-warm ping, a next-steps suggestion)
// reads the main thread's cache, so its TTL counts again from when it started.
export async function forkRefreshed($: EngineInterface, startedAt: number, usage: ModelUsage) {
  await update($, cache, () => ({
    lastAt: startedAt,
    readTokens: usage.cache_read_input_tokens,
    writeTokens: usage.cache_creation_input_tokens,
  }))
  await update($, now, () => startedAt)
}

async function keepWarm($: EngineInterface) {
  await update($, keep, k => ({ ...k, isRefreshing: true }))
  const startedAt = await $.clock.now()
  const reply = await $.model.fork({ prompt: PING_PROMPT })
  if (!reply.isAnswered && reply.reason !== 'empty-reply') {
    await update($, keep, k => ({ ...k, isRefreshing: false, note: `Keep-warm failed (${reply.reason})` }))
    return
  }
  const usage = reply.usage
  const fill = await read($, meter)
  await forkRefreshed($, startedAt, usage)
  await update($, keep, k => ({
    count: k.count + 1,
    isRefreshing: false,
    lastRead: usage.cache_read_input_tokens,
    lastContext: fill?.tokens,
    note: `Keep-warm ${k.count + 1} at ${timeOfDay(startedAt)}: read ${kilo(usage.cache_read_input_tokens)} from cache`,
  }))
}

let isActing = false
let attemptedFor = -1
// When a resume last seeded the countdown, so a /resume's own end step,
// arriving after it, does not wipe it.
let seededAt = -1

type Seed = { lastAt?: number; tokens?: number }

// The last main-thread response in a transcript: when it was written and the
// input it was answered over. Nothing when the file is missing or too big.
async function lastResponse($: EngineInterface, path: string): Promise<Seed> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return {}
  }
  const lines = text.split('\n')
  for (const line of lines.reverse()) {
    if (!line.includes('"type":"assistant"')) continue
    try {
      const row = JSON.parse(line)
      const u = row.message?.usage
      if (row.isSidechain || row.message?.model === '<synthetic>' || !u || typeof row.timestamp !== 'string') continue
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      return { lastAt: Date.parse(row.timestamp), tokens }
    } catch {
      continue
    }
  }
  return {}
}

// Where Claude Code keeps this session's transcript: its config folder
// (CLAUDE_CONFIG_DIR, else ~/.claude), by project and session id.
async function transcriptPath($: EngineInterface, cwd: string): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
  if (config === undefined) return undefined
  const id = await $.session.id()
  return `${config}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
}

// Count down from a resumed transcript's last response. Only an estimate until
// a response of this session confirms the cache (see autopilot).
async function seedResume($: EngineInterface, lastAt: number, tokens: number | undefined) {
  const at = await $.clock.now()
  seededAt = at
  await update($, cache, () => ({ lastAt, readTokens: 0, writeTokens: 0, isEstimate: true }))
  await update($, now, () => at)
  await update($, keep, () => ({
    count: 0,
    isRefreshing: false,
    note: 'Resumed: cache time estimated from the last response — keep-warm starts after your next prompt',
  }))
  if (tokens === undefined) return
  const window = (await read($, meter))?.window ?? (await $.session.usage()).context.window
  await update($, meter, () => ({ tokens, window, percent: Math.round((tokens / window) * 100) }))
}

// A reading with no fill yet (a resume before its first response) keeps the
// fill already shown instead of blanking it.
function keepFill(m: Meter | null, c: Meter): Meter {
  const tokens = c.tokens ?? m?.tokens
  if (tokens === undefined) return { window: c.window }
  return { tokens, window: c.window, percent: c.tokens !== undefined && c.percent !== undefined ? c.percent : Math.round((tokens / c.window) * 100) }
}

// Near expiry while idle: refresh, or hand off once refreshes run out or the
// context is past the threshold. Never with a draft typed or agents at work.
async function autopilot($: EngineInterface, at: number, plan: Settings) {
  if (!plan.isAuto || isActing) return
  const held = await read($, cache)
  if (held === null || held.lastAt === attemptedFor) return
  // A resumed countdown is only an estimate: the rebuilt request may not match
  // the cached one, and a ping would then pay the whole write. Wait for a reply.
  if (held.isEstimate) return
  const left = held.lastAt + plan.ttlMs - at
  if (left > plan.leadMs || left <= 0) return
  if (await read($, busy)) return
  if ((await read($, handoff)).phase === 'writing') return
  attemptedFor = held.lastAt
  isActing = true
  try {
    const counted = await read($, keep)
    const pct = (await read($, meter))?.percent ?? 0
    const agents = (await $.agent.list()).filter(a => ['pending', 'running', 'waiting'].includes(a.status))
    const draft = (await $.prompt.read()).text.trim()
    const wantsAction = pct >= plan.handoffPercent || counted.count >= plan.keepWarmCount
    // Compacting leaves the prompt box and agents alone; a handoff clears both.
    const canAct = plan.idleAction === 'compact' || (agents.length === 0 && draft === '')
    if (wantsAction && canAct) {
      if (plan.idleAction === 'compact') await compactNow($, true)
      else await writeHandoff($, true)
    } else if (counted.count < plan.keepWarmCount) {
      await keepWarm($)
    } else {
      const why = draft !== '' ? 'a draft is in the prompt box' : 'agents are still running'
      await update($, keep, k => ({ ...k, note: `Letting the cache expire: ${why}, so no auto-handoff` }))
    }
  } finally {
    isActing = false
  }
}

// ── hooks ───────────────────────────────────────────────────────────────────

// The cache's part of the events next steps hook too: register.tsx runs these
// first, then hands on.
export async function cacheSessionStart($: EngineInterface, e: In<'session.start'>, plan: Settings) {
  const usage = await $.session.usage()
  const { context } = usage
  await update($, meter, m => keepFill(m, context))
  await update($, now, () => 0)
  await update($, busy, () => false)
  await update($, handoff, () => ({ phase: 'idle' as const }))
  await update($, limits, () => usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })))

  // A resumed conversation, should its resume hook have run before this
  // module loaded: read the timing from its transcript.
  if ((await read($, cache)) === null && (await read($, meter))?.tokens === undefined) {
    try {
      const path = await transcriptPath($, e.cwd)
      const found = path === undefined ? {} : await lastResponse($, path)
      if (found.lastAt !== undefined) await seedResume($, found.lastAt, found.tokens)
    } catch {
      // No transcript to read: the bar waits for the first response.
    }
  }

  $.clock.every(1000, async () => {
    const at = await $.clock.now()
    const held = await read($, cache)
    const job = await read($, handoff)
    if ((held !== null && at - held.lastAt <= plan.ttlMs + 1000) || job.phase === 'writing') {
      await update($, now, () => at)
    }
    await autopilot($, at, plan)
  })
}

// A prompt the person typed resets the keep-warm budget.
export async function cachePromptSubmit($: EngineInterface, e: In<'prompt.submit'>) {
  if (e.origin.kind === 'composer') {
    await resetKeepWarm($)
  }
}

// So does a next step they picked, which helm submits itself: a plugin's own
// prompt.submit hook does not see the prompts it submits.
export async function resetKeepWarm($: EngineInterface) {
  await update($, keep, () => ({ count: 0, isRefreshing: false }))
}

export async function cacheTurnStart($: EngineInterface) {
  await update($, busy, () => true)
}

export async function cacheTurnComplete($: EngineInterface, e: In<'turn.complete'>) {
  if (e.agentId === undefined) {
    await update($, busy, () => false)
  }
}

// /clear and /resume both leave this conversation; nothing of its cache
// carries over to the next one.
export async function cacheSessionEnd($: EngineInterface, e: In<'session.end'>) {
  const isJustSeeded = e.reason === 'resume' && (await $.clock.now()) - seededAt < 5000
  if ((e.reason === 'clear' || e.reason === 'resume') && !isJustSeeded) {
    await update($, cache, () => null)
    await update($, meter, m => (m === null ? m : { window: m.window }))
    await update($, keep, () => ({ count: 0, isRefreshing: false }))
  }
}

// Every main-thread response refreshes the cache entry and the context fill;
// the TTL counts from when the request started.
export async function* cacheTurnStep($: EngineInterface, e: In<'turn.step'>, next: StreamNext<'turn.step'>) {
  const startedAt = await $.clock.now()
  const result = yield* next(e)
  if (e.agentId === undefined && result.usage !== null) {
    const u = result.usage
    await update($, cache, () => ({
      lastAt: startedAt,
      readTokens: u.cache_read_input_tokens,
      writeTokens: u.cache_creation_input_tokens,
    }))
    const endedAt = await $.clock.now()
    await update($, now, () => endedAt)
    const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    await update($, meter, m =>
      m === null ? m : { ...m, tokens, percent: Math.round((tokens / m.window) * 100) },
    )
  }

  return result
}

// The events only the cache hooks.
export function registerCache(on: On) {
  on('session.measure', async ($, e, next) => {
    await update($, meter, m => keepFill(m, e.context))
    await update($, limits, () => e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })))

    return next(e)
  })

  // Any compaction of the main conversation (/compact, auto, ours) resets the
  // cache countdown until the next response.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      const at = await $.clock.now()
      const note = compactNote(
        e.trigger === 'auto',
        at,
        result.tokensBefore,
        result.tokensAfter,
        result.usage?.cache_read_input_tokens,
      )
      await afterCompact($, result.tokensAfter, note)
    }

    return result
  })

  // A resumed (or forked) transcript's cache lives on server-side: count down
  // from its last response, so a warm cache shows its real time left.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume' || e.source === 'fork') {
      const at = await $.clock.now()
      let lastAt = e.seconds_since_last_response === undefined ? undefined : at - e.seconds_since_last_response * 1000
      let tokens = e.context_tokens
      if (lastAt === undefined || tokens === undefined) {
        const found = await lastResponse($, e.transcript_path)
        lastAt ??= found.lastAt
        tokens ??= found.tokens
      }
      if (lastAt !== undefined) await seedResume($, lastAt, tokens)
    }

    return next(e)
  })

}
