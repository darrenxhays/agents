import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'context-cache',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const SUMMARY = { role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }
const PING = 'Cache keep-alive ping. Reply with only: ok'
const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The world beneath the plugin: a 200k window, a main-thread response of
// `tokens` (all but 2k read from cache), forks recorded, a draft of `draft`.
const world = (on: On, { tokens, draft = '' }: { tokens: number; draft?: string }) => {
  const forks: string[] = []
  const commands: string[] = []
  const pasted: string[] = []
  const compacts: string[] = []
  mock.store(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(1_000_000 + 2 * 3600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 18.5, resetsAt: new Date(1_000_000 + 3 * 24 * 3600_000).toISOString() },
      ],
    },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...zero, model: 'claude-opus-5-5', input_tokens: 2_000, cache_read_input_tokens: tokens - 2_000 },
    }
  })
  on('model.fork', (_$, e) => {
    forks.push(e.prompt === PING ? 'ping' : 'handoff')
    return {
      value: {
        isAnswered: true as const,
        text: e.prompt === PING ? 'ok' : '  Continue the work.  ',
        usage: { ...zero, cache_read_input_tokens: tokens - 1_000 },
      },
    }
  })
  on('command.run', (_$, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('prompt.fill', (_$, e) => {
    pasted.push(e.text)
    return { isFilled: true }
  })
  on('session.compact', (_$, e) => {
    compacts.push(e.trigger)
    return { messages: [SUMMARY], tokensBefore: tokens, tokensAfter: 8_000, usage: { ...zero, cache_read_input_tokens: tokens - 1_000 } }
  })

  return { forks, commands, pasted, compacts }
}

const respond = async ($: Engine) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
}

const START = { cwd: '/', surface: 'terminal' as const, isInteractive: true }
const FIVE_MIN = { cacheTtl: '5m', keepWarmCount: 3, handoffPercent: 50, leadSeconds: 120 }
const HANDOFF_MODE = { ...FIVE_MIN, idleAction: 'handoff' }

test('draws the bars and counts the cache down', { options: { ...FIVE_MIN, autoKeepWarm: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  world(on, { tokens: 100_000 })
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /CACHE --:--/ })).toBeDefined()
    await ui.unmount()
  }

  await respond($)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: '50%' })).toBeDefined()
    expect(await ui.find({ text: 'CACHE 05:00' })).toBeDefined()
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(61_000)
  const later = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await later.find({ text: 'CACHE 03:59' })).toBeDefined()
  await later.unmount()

  await clock.advance(5 * 60_000)
  const gone = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await gone.find({ text: 'CACHE EXPIRED' })).toBeDefined()
  await gone.unmount()
})

test('the button forks a handoff, clears and pastes it', { options: FIVE_MIN }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 20_000 })
  await $.session.start(START)
  await respond($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'handoff' })
  expect(w.forks).toEqual(['handoff'])
  expect(w.commands).toEqual(['clear'])
  expect(w.pasted).toEqual(['Continue the work.'])
  await ui.unmount()
})

test('handoff mode: keeps warm three times, then hands off', { options: HANDOFF_MODE }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 20_000 })
  await $.session.start(START)
  await respond($)

  // Nothing before the lead time (2 min before the 5 min expiry).
  await clock.advance(170_000)
  expect(w.forks).toEqual([])

  for (let n = 1; n <= 3; n++) {
    await clock.advance(11_000)
    expect(w.forks).toEqual(Array(n).fill('ping'))
    await clock.advance(170_000)
  }

  await clock.advance(11_000)
  expect(w.forks).toEqual(['ping', 'ping', 'ping', 'handoff'])
  expect(w.commands).toEqual(['clear'])
  expect(w.pasted).toEqual(['Continue the work.'])
})

test('handoff mode: past the threshold, hands off at the first expiry point', { options: HANDOFF_MODE }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 120_000 })
  await $.session.start(START)
  await respond($)

  await clock.advance(181_000)
  expect(w.forks).toEqual(['handoff'])
  expect(w.commands).toEqual(['clear'])
})

test('handoff mode: a draft in the prompt box blocks the auto-handoff', { options: HANDOFF_MODE }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 120_000, draft: 'half-typed thought' })
  await $.session.start(START)
  await respond($)

  await clock.advance(181_000)
  expect(w.forks).toEqual(['ping'])
  expect(w.commands).toEqual([])
})

test('the usage button toggles stacked 5-hour and weekly bars', { options: FIVE_MIN }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on, { tokens: 20_000 })
  await $.session.start(START)
  await respond($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /5-HOUR/ })).toBeUndefined()
    await ui.press({ key: 'usage' })
    expect(await ui.find({ text: /5-HOUR 42%/ })).toBeDefined()
    expect(await ui.find({ text: /WEEKLY 18.5%/ })).toBeDefined()
    await ui.press({ key: 'usage' })
    expect(await ui.find({ text: /WEEKLY/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('default: keeps warm three times, then compacts and stops', { options: FIVE_MIN }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 20_000, draft: 'a draft does not block compacting' })
  await $.session.start(START)
  await respond($)

  for (let n = 1; n <= 3; n++) {
    await clock.advance(181_000)
    expect(w.forks).toEqual(Array(n).fill('ping'))
  }
  await clock.advance(181_000)
  expect(w.compacts).toHaveLength(1)
  expect(w.commands).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /CACHE --:--/ })).toBeDefined()
  expect(await ui.find({ text: /CONTEXT 4%/ })).toBeDefined()
  await ui.unmount()

  // Nothing to keep warm until the next response writes the compacted cache.
  await clock.advance(20 * 60_000)
  expect(w.forks).toEqual(['ping', 'ping', 'ping'])
})

test('default: past the threshold, compacts at the first expiry point', { options: FIVE_MIN }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 120_000 })
  await $.session.start(START)
  await respond($)

  await clock.advance(181_000)
  expect(w.forks).toEqual([])
  expect(w.compacts).toHaveLength(1)
})

test('the COMPACT button compacts and resets the countdown', { options: FIVE_MIN }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 20_000 })
  await $.session.start(START)
  await respond($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: 'CACHE 05:00' })).toBeDefined()
  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(1)
  expect(await ui.find({ text: /CACHE --:--/ })).toBeDefined()
  await ui.unmount()
})

test('a /compact typed by the person also stops keep-warm', { options: FIVE_MIN }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 20_000 })
  await $.session.start(START)
  await respond($)

  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await clock.advance(20 * 60_000)
  expect(w.forks).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /CACHE --:--/ })).toBeDefined()
  await ui.unmount()
})

test('a resume counts down from the resumed transcript\'s last response', { options: { ...FIVE_MIN, autoKeepWarm: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  world(on, { tokens: 20_000 })
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60, context_tokens: 80_000 })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: 'CACHE 04:00' })).toBeDefined()
  expect(await ui.find({ text: /CONTEXT 40%/ })).toBeDefined()
  await ui.unmount()
})

test('a resume past the TTL shows the cache expired', { options: { ...FIVE_MIN, autoKeepWarm: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on, { tokens: 20_000 })
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 3_600, context_tokens: 80_000 })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: 'CACHE EXPIRED' })).toBeDefined()
  await ui.unmount()
})

test('a /resume drops the old conversation\'s countdown and keep-warm', { options: FIVE_MIN }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 20_000 })
  on('session.end', (_$, e) => ({ sessionId: 's1', reason: e.reason }))
  await $.session.start(START)
  await respond($)

  await $.session.end({ reason: 'resume' } as never)
  await clock.advance(20 * 60_000)
  expect(w.forks).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /CACHE --:--/ })).toBeDefined()
  await ui.unmount()
})

test('a resumed countdown does not keep warm until a response confirms it', { options: FIVE_MIN }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { tokens: 20_000 })
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60, context_tokens: 20_000 })

  // Into the lead window of the estimated expiry: no ping.
  await clock.advance(130_000)
  expect(w.forks).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /keep-warm starts after your next prompt/ })).toBeDefined()
  await ui.unmount()

  // A real response confirms the cache; keep-warm resumes from it.
  await respond($)
  await clock.advance(181_000)
  expect(w.forks).toEqual(['ping'])
})

// A transcript whose last main-thread response was written `ago` ms before
// 1_000_000, answered over `tokens`.
const transcript = (ago: number, tokens: number) =>
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(1_000_000 - ago).toISOString(),
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 2_000, cache_read_input_tokens: tokens - 2_000, cache_creation_input_tokens: 0 } },
    }),
    JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: new Date(1_000_000).toISOString(), message: { usage: zero } }),
  ].join('\n')

test('a resume keeps its fill when the engine reports none yet', { options: { ...FIVE_MIN, autoKeepWarm: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on, { tokens: 20_000 })
  on('classic.SessionStart', () => ({}))
  on('session.measure', () => ({ changed: [] }))
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60, context_tokens: 80_000 })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [] } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /CONTEXT 40%/ })).toBeDefined()
  expect(await ui.find({ text: 'CACHE 04:00' })).toBeDefined()
  await ui.unmount()
})

test('a resume without timing reads it from the transcript', { options: { ...FIVE_MIN, autoKeepWarm: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on, { tokens: 20_000 })
  on('classic.SessionStart', () => ({}))
  on('fs.read', () => ({ value: transcript(90_000, 60_000) }))
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', transcript_path: '/home/me/.claude/projects/-/s1.jsonl' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /CONTEXT 30%/ })).toBeDefined()
  expect(await ui.find({ text: 'CACHE 03:30' })).toBeDefined()
  await ui.unmount()
})

test('a /resume ending after the new seed keeps it', { options: { ...FIVE_MIN, autoKeepWarm: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on, { tokens: 20_000 })
  on('classic.SessionStart', () => ({}))
  on('session.end', (_$, e) => ({ sessionId: 's1', reason: e.reason }))
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60, context_tokens: 80_000 })
  await $.session.end({ reason: 'resume' } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: 'CACHE 04:00' })).toBeDefined()
  await ui.unmount()
})

test('a resume whose hook ran before the mod loaded seeds from the transcript at start', { options: { ...FIVE_MIN, autoKeepWarm: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on, { tokens: 20_000 })
  const paths: string[] = []
  on('fs.read', (_$, e) => {
    paths.push(e.path)
    return { value: transcript(30_000, 100_000) }
  })
  await $.session.start(START)

  expect(paths[0]).toBe('/home/me/.claude/projects/-/s1.jsonl')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /CONTEXT 50%/ })).toBeDefined()
  expect(await ui.find({ text: 'CACHE 04:30' })).toBeDefined()
  await ui.unmount()
})
