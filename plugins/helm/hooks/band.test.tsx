import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ConfigValue, On } from 'claude-code'

// What the two halves do together: one band, and what each tells the other.

const TOOL = 'mcp__helm__suggest'
const PING = 'Cache keep-alive ping. Reply with only: ok'

const STEPS = [
  { title: 'Run the unit tests', prompt: 'Run npm test and report failures.' },
  { title: 'Open a PR', prompt: 'Open a PR against main.' },
]

const BAND = {
  plugin: 'helm',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const COMMAND = {
  command: 'next-steps',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

// The conversation row whose card holds the live steps.
const card = (id: string) =>
  ({
    plugin: 'helm',
    component: 'ToolUse',
    requestId: id,
    surface: 'terminal',
    props: { tool_use_id: id, tool: TOOL, input: { steps: STEPS }, isRunning: false, isErrored: false, isInterrupted: false },
  }) as const

const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const START = { cwd: '/', surface: 'terminal' as const, isInteractive: true }
const FIVE_MIN = { cacheTtl: '5m', keepWarmCount: 3, handoffPercent: 50, leadSeconds: 120 }

// The engine beneath helm: a 200k window, a 20k response, forks answered
// (a ping with ok, a suggestion with STEPS), prompts and compactions recorded.
const world = (on: On) => {
  const forks: string[] = []
  const submitted: string[] = []
  const compacts: string[] = []
  mock.store(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  let owner = ''
  on('state.set', { plugin: 'helm', key: 'toolUseId' }, (_$, e, next) => {
    owner = String(e.value)
    return next(e)
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...zero, model: 'claude-opus-5-5', input_tokens: 2_000, cache_read_input_tokens: 18_000 },
    }
  })
  on('model.fork', (_$, e) => {
    const isPing = e.prompt === PING
    forks.push(isPing ? 'ping' : 'suggest')
    return {
      value: {
        isAnswered: true as const,
        text: isPing ? 'ok' : JSON.stringify(STEPS),
        usage: { ...zero, cache_read_input_tokens: 19_000 },
      },
    }
  })
  on('session.compact', (_$, e) => {
    compacts.push(e.trigger)
    return { messages: [{ role: 'user' as const, text: 'Summary.', toolUses: [] }], tokensBefore: 20_000, tokensAfter: 8_000, usage: zero }
  })

  return { forks, submitted, compacts, owner: () => owner }
}

const respond = async ($: Engine) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
}

test('the four buttons stay put, and next steps stay out of the band', { options: FIVE_MIN }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  await $.session.start(START)
  await respond($)
  await $.tool.call({ tool: TOOL, steps: STEPS })

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ text: /CONTEXT 10%/ })).toBeDefined()
  expect(await ui.find({ text: 'CACHE 05:00' })).toBeDefined()
  for (const [key, hotkey] of [['compact', 'c'], ['handoff', 'h'], ['usage', 'u'], ['config', 'g']]) {
    expect((await ui.find({ key }))?.props.hotkey).toBe(hotkey)
  }
  expect(await ui.find({ key: 'key-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('COMPACT and HANDOFF are greyed out, not pressable, until they can run', { options: FIVE_MIN }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  await $.session.start(START)

  const before = await $.ui.mount(BAND)
  expect(await before.find({ key: 'compact' })).toBeUndefined()
  expect(await before.find({ key: 'handoff' })).toBeUndefined()
  expect(await before.find({ type: 'Text', text: /\[ +COMPACT +\]/ })).toBeDefined()
  expect(await before.find({ type: 'Text', text: /\[ +HANDOFF +\]/ })).toBeDefined()
  expect(await before.find({ text: /after|when idle/ })).toBeUndefined()
  await before.unmount()

  const working = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true } })
  expect(await working.find({ key: 'handoff' })).toBeUndefined()
  expect(await working.find({ type: 'Text', text: /\[ +HANDOFF +\]/ })).toBeDefined()
  await working.unmount()

  await respond($)
  const after = await $.ui.mount(BAND)
  expect(await after.find({ key: 'compact' })).toBeDefined()
  expect(await after.find({ key: 'handoff' })).toBeDefined()
  await after.unmount()
})

test('CONFIG opens the helm options below the buttons and changes them in place', { options: FIVE_MIN }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  const sets: { key: string; value: unknown }[] = []
  const row = (key: string, label: string, kind: 'boolean' | 'choice' | 'number', value: ConfigValue, options?: string[]) => ({
    key: `helm.${key}`,
    label,
    kind,
    value,
    options,
    provider: { plugin: 'helm', tier: 'user' as const },
    isLocked: false,
  })
  on('config.list', () => ({
    value: [
      { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
      row('contextBand', 'Show the context and cache band', 'boolean', true),
      row('nextSteps', 'Suggest next steps', 'boolean', true),
      row('cacheTtl', 'Prompt cache TTL', 'choice', '5m', ['1h', '5m']),
      row('autoKeepWarm', 'Auto keep-warm', 'boolean', true),
      row('keepWarmCount', 'Keep-warm refreshes', 'number', 3),
    ],
  }))
  on('config.set', (_$, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  await $.session.start(START)
  await respond($)

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'usage' })
  await ui.press({ key: 'config' })
  expect(await ui.find({ text: /Suggest next steps/ })).toBeDefined()
  expect(await ui.find({ text: 'Theme' })).toBeUndefined()
  expect(await ui.find({ text: /Show the context and cache band/ })).toBeUndefined()
  expect(await ui.find({ text: 'CONTEXT AND CACHE' })).toBeDefined()
  expect(await ui.find({ text: 'NEXT STEPS' })).toBeDefined()
  expect(await ui.find({ text: 'OTHER' })).toBeUndefined()
  const labels = (await ui.findAll({ type: 'Text', text: /^ {2}\S/ })).map(found => found.text.trim())
  expect(labels).toEqual(['Auto keep-warm', 'Prompt cache TTL', 'Keep-warm refreshes', 'Suggest next steps'])
  expect(await ui.find({ text: /No usage windows/ })).toBeUndefined()

  await ui.press({ key: 'opt-nextSteps' })
  expect((await ui.find({ key: 'opt-nextSteps' }))?.props.label).toBe('○ off')
  await ui.select({ key: 'opt-cacheTtl', value: '1h' })
  await ui.input({ key: 'opt-keepWarmCount', text: 'many', kind: 'submit' })
  expect(await ui.find({ text: /not a number/ })).toBeDefined()
  await ui.input({ key: 'opt-keepWarmCount', text: '5', kind: 'submit' })
  expect(sets).toEqual([
    { key: 'helm.nextSteps', value: false },
    { key: 'helm.cacheTtl', value: '1h' },
    { key: 'helm.keepWarmCount', value: 5 },
  ])

  await ui.press({ key: 'config' })
  expect(await ui.find({ text: /Suggest next steps/ })).toBeUndefined()
  await ui.unmount()
})

test('CONFIG shows the pragmatic-engineer switch and writes this project override to settings.local.json', { options: FIVE_MIN }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  const sets: { key: string; value: unknown }[] = []
  const files: Partial<Record<string, string>> = {
    '/proj/.claude/settings.local.json': JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1' } }),
  }
  on('config.list', () => ({
    value: [
      {
        key: 'darrenxhays@agents.auto_use',
        label: 'Use pragmatic-engineer automatically',
        kind: 'boolean',
        value: false,
        provider: { plugin: 'darrenxhays', tier: 'user' as const },
        isLocked: false,
      },
    ],
  }))
  on('config.set', (_$, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  const local = () => JSON.parse(files['/proj/.claude/settings.local.json'] ?? '')
  await $.session.start(START)
  await respond($)

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'config' })
  expect(await ui.find({ text: 'USE PRAGMATIC-ENGINEER AUTOMATICALLY' })).toBeDefined()
  const labels = (await ui.findAll({ type: 'Text', text: /^ {2}\S/ })).map(found => found.text.trim())
  expect(labels).toEqual(['All projects', 'This project'])

  await ui.press({ key: 'opt-auto_use' })
  expect(sets).toEqual([{ key: 'darrenxhays@agents.auto_use', value: true }])

  await ui.select({ key: 'opt-autoUseHere', value: 'on' })
  expect(local()).toEqual({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1', PRAGMATIC_ENGINEER_AUTO_USE: 'true' } })
  await ui.select({ key: 'opt-autoUseHere', value: 'off' })
  expect(local().env.PRAGMATIC_ENGINEER_AUTO_USE).toBe('false')
  await ui.select({ key: 'opt-autoUseHere', value: 'default' })
  expect(local()).toEqual({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1' } })

  // Reopened, the panel reads the file again.
  await ui.select({ key: 'opt-autoUseHere', value: 'on' })
  await ui.press({ key: 'config' })
  await ui.press({ key: 'config' })
  expect((await ui.find({ key: 'opt-autoUseHere' }))?.props.value).toBe('on')

  // A settings.local.json that isn't JSON is left alone.
  files['/proj/.claude/settings.local.json'] = '{ broken'
  await ui.press({ key: 'config' })
  await ui.press({ key: 'config' })
  expect(await ui.find({ text: /unreadable \(locked\)/ })).toBeDefined()
  expect(files['/proj/.claude/settings.local.json']).toBe('{ broken')
  await ui.unmount()
})

test('picking a step resets the keep-warm budget, as a typed prompt does', { options: { ...FIVE_MIN, keepWarmCount: 1 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await $.session.start(START)
  await respond($)

  await clock.advance(181_000)
  expect(w.forks).toEqual(['ping'])

  await $.tool.call({ tool: TOOL, steps: STEPS })
  const ui = await $.ui.mount(card(w.owner()))
  await ui.press({ key: 'step-1' })
  expect(w.submitted).toEqual(['Run npm test and report failures.'])
  await ui.unmount()

  // With the budget spent this would compact; reset, it pings again.
  await clock.advance(181_000)
  expect(w.forks).toEqual(['ping', 'ping'])
  expect(w.compacts).toEqual([])
})

test('/next-steps suggest refreshes the cache countdown, since its fork reads the cache', { options: { ...FIVE_MIN, autoKeepWarm: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await $.session.start(START)
  await respond($)

  await clock.advance(120_000)
  const before = await $.ui.mount(BAND)
  expect(await before.find({ text: 'CACHE 03:00' })).toBeDefined()
  await before.unmount()

  await $.command.run({ ...COMMAND, args: 'suggest' })
  expect(w.forks).toEqual(['suggest'])
  const after = await $.ui.mount(BAND)
  expect(await after.find({ text: 'CACHE 05:00' })).toBeDefined()
  await after.unmount()
})

test('contextBand off: nothing of helm above the prompt', { options: { ...FIVE_MIN, contextBand: false } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  await $.session.start(START)
  await respond($)

  const quiet = await $.ui.mount(BAND)
  expect(await quiet.find({ text: /CONTEXT/ })).toBeUndefined()
  expect(await quiet.find({ key: 'compact' })).toBeUndefined()
  expect(await quiet.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await quiet.unmount()
})
