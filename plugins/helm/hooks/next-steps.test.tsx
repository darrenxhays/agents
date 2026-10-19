import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__helm__suggest'

const STEPS = [
  { title: 'Run the unit tests', prompt: 'Run npm test and report failures.' },
  { title: 'Open a PR', prompt: 'Open a PR against main.' },
]

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  outputStyle: null,
  tools: [TOOL],
  traits: [],
} as const

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const COMMAND = {
  command: 'next-steps',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

const BAND = {
  plugin: 'helm',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 29 },
    view: {},
  },
} as const

function row(id: string) {
  return {
    plugin: 'helm',
    component: 'ToolUse',
    requestId: id,
    props: {
      tool_use_id: id,
      tool: TOOL,
      input: { steps: STEPS },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  } as const
}

function output(text: string) {
  return {
    plugin: 'helm',
    component: 'CommandOutput',
    props: { command: 'next-steps', args: '', text, isErrored: false },
  } as const
}

function engineBand(on: On, hasToast = true) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  if (hasToast) on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('state.set', { plugin: 'helm', key: 'toolUseId' }, ($, e, next) => {
    owner = String(e.value)
    return next(e)
  })
}

// The tool row that owns the live steps, as the plugin last wrote it.
let owner = ''

function prompt(on: On, draft: string) {
  const submitted: string[] = []
  const fills: string[] = []
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true, text: e.text }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  return { submitted, fills }
}

// Suggests STEPS as the model does and answers the id of the row that owns them.
async function suggest($: Engine): Promise<string> {
  const ran = await $.tool.call({ tool: TOOL, steps: STEPS })
  expect(ran.deny).toBeUndefined()

  return owner
}

test('the suggestion row draws the live list in place of the JSON; a press runs the step', async ($, on) => {
  engineBand(on)
  const box = prompt(on, '')
  const id = await suggest($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...row(id), surface })
    expect((await ui.find({ key: 'step-1' }))?.text).toContain('Run the unit tests')
    expect((await ui.find({ key: 'step-1' }))?.text).toContain(' 1 ')
    expect(await ui.find({ type: 'Text', text: /Run npm test/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /"prompt"/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...row(id), surface: 'terminal' })
  await ui.press({ key: 'step-2' })
  expect(box.submitted).toEqual(['Open a PR against main.'])
  expect(await ui.find({ key: 'step-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Next steps offered/ })).toBeDefined()
  await ui.unmount()
})

test('the result line under the row is hidden', async ($, on) => {
  engineBand(on)
  const id = await suggest($)

  const ui = await $.ui.mount({
    plugin: 'helm',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: TOOL, output: 'Shown to the user as 2 numbered buttons.', isErrored: false },
  })
  expect(await ui.find({ type: 'Text', text: /Shown to the user/ })).toBeUndefined()
  await ui.unmount()
})

test('the step after the steps are shown ends the turn without asking the model', async ($, on) => {
  engineBand(on)
  const asked: number[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    asked.push(e.index)
    return { turnId: e.turnId, index: e.index, answer: 'again', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  const step = async (index: number) => {
    const it = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1 })
    let at = await it.next()
    while (at.done !== true) at = await it.next()

    return at.value
  }

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await suggest($)
  expect((await step(1)).answer).toBe('')
  expect(asked).toEqual([])

  await $.turn.start({ text: 'and now?', turnId: 't2' })
  expect((await step(0)).answer).toBe('again')
  expect(asked).toEqual([0])
})

test('show full prompts expands each step', async ($, on) => {
  engineBand(on)
  const id = await suggest($)

  const ui = await $.ui.mount({ ...row(id), surface: 'terminal' })
  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: 'Open a PR against main.' })).toBeDefined()
  expect((await ui.find({ key: 'details' }))?.text).toContain('hide prompts')
  await ui.unmount()
})

test('a typed draft is added to the picked step and cleared', async ($, on) => {
  engineBand(on)
  const box = prompt(on, '  skip the e2e suite ')
  const id = await suggest($)

  const ui = await $.ui.mount({ ...row(id), surface: 'terminal' })
  await ui.press({ key: 'step-1' })

  expect(box.fills).toEqual([''])
  expect(box.submitted).toEqual([
    'Run npm test and report failures.\n\nAdditional instructions: skip the e2e suite',
  ])
  await ui.unmount()
})

test('ticking two steps runs them together, in order, with the note', async ($, on) => {
  engineBand(on)
  const box = prompt(on, 'skip the slow tests')
  const id = await suggest($)

  const ui = await $.ui.mount({ ...row(id), surface: 'terminal' })
  expect(await ui.find({ key: 'run-selected' })).toBeUndefined()

  await ui.press({ key: 'toggle-2' })
  await ui.press({ key: 'toggle-1' })
  expect((await ui.find({ key: 'toggle-1' }))?.text).toContain('●')
  expect((await ui.find({ key: 'run-selected' }))?.text).toContain('Run 2 selected')

  await ui.press({ key: 'run-selected' })
  expect(box.submitted).toEqual([
    'Do these next steps in order:\n\n' +
      '1. Run npm test and report failures.\n\n' +
      '2. Open a PR against main.\n\n' +
      'Additional instructions: skip the slow tests',
  ])
  await ui.unmount()
})

test('clickAction fill puts the step after the draft and keeps the list', { options: { clickAction: 'fill' } }, async ($, on) => {
  engineBand(on)
  const box = prompt(on, 'first, pull main')
  const id = await suggest($)

  const ui = await $.ui.mount({ ...row(id), surface: 'terminal' })
  await ui.press({ key: 'step-1' })

  expect(box.submitted).toEqual([])
  expect(box.fills).toEqual(['first, pull main\n\nRun npm test and report failures.'])
  expect(await ui.find({ key: 'step-2' })).toBeDefined()
  await ui.unmount()
})

test('the band leaves the steps to the conversation', async ($, on) => {
  engineBand(on)
  await suggest($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'key-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('a typed prompt retires the list and tells the model what the numbers meant', async ($, on) => {
  engineBand(on)
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)
    return { text: e.text }
  })
  const id = await suggest($)

  await $.prompt.submit({
    text: 'do 1 and 2 but skip the slow tests',
    origin: { kind: 'composer' },
    wait: false,
  })

  expect(contexts[0]?.[0]).toContain('2. Open a PR: Open a PR against main.')
  const ui = await $.ui.mount({ ...row(id), surface: 'terminal' })
  expect(await ui.find({ key: 'step-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /2 {2}Open a PR/ })).toBeDefined()
  await ui.unmount()
})

test("/next-steps suggest draws a fork's steps in its own output row", async ($, on) => {
  engineBand(on)
  mock.clock(on)
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: 'Sure:\n[{"title": "Bump the version", "prompt": "Bump version to 0.4.0 in plugin.json."}]',
      usage: USAGE,
    },
  }))
  const id = await suggest($)

  const ran = await $.command.run({ ...COMMAND, args: 'suggest' })
  expect(ran.text).toMatch(/^Next steps \(set \d+\): 1 suggestions/)

  const out = await $.ui.mount({ ...output(ran.text ?? ''), surface: 'terminal' })
  expect((await out.find({ key: 'step-1' }))?.text).toContain('Bump the version')
  await out.unmount()

  const old = await $.ui.mount({ ...row(id), surface: 'terminal' })
  expect(await old.find({ key: 'step-1' })).toBeUndefined()
  await old.unmount()
})

test('/next-steps shows the last steps again in its output row', async ($, on) => {
  engineBand(on)
  await suggest($)

  const ran = await $.command.run({ ...COMMAND, args: '' })
  const out = await $.ui.mount({ ...output(ran.text ?? ''), surface: 'terminal' })
  expect((await out.find({ key: 'step-2' }))?.text).toContain('Open a PR')
  await out.unmount()
})

test('autoFallback suggests after a turn that changed things without suggesting', { options: { autoFallback: true } }, async ($, on) => {
  engineBand(on, false)
  const clock = mock.clock(on)
  const toasts: string[] = []
  let forks = 0
  on('ui.toast', ($, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('model.fork', () => {
    forks += 1
    return { value: { isAnswered: true, text: JSON.stringify(STEPS), usage: USAGE } }
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))

  const turn = { answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as const

  await $.turn.start({ text: 'what does this do?', turnId: 't1' })
  await $.turn.complete({ ...turn, turnId: 't1' })
  await clock.settle()
  expect(forks).toBe(0)

  await $.turn.start({ text: 'fix it', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ ...turn, turnId: 't2' })
  await clock.settle()
  expect(forks).toBe(1)
  expect(toasts.some(text => text.includes('/next-steps'))).toBe(true)

  const shown = await $.command.run({ ...COMMAND, args: '' })
  expect(shown.text).toContain('2 suggestions')

  await $.turn.start({ text: 'fix more', turnId: 't3' })
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'b', new_string: 'c' })
  await $.tool.call({ tool: TOOL, steps: STEPS })
  await $.turn.complete({ ...turn, turnId: 't3' })
  await clock.settle()
  expect(forks).toBe(1)
})

test('/next-steps off writes the /config row', async ($, on) => {
  engineBand(on)
  const sets: { key: string; value: unknown }[] = []
  on('config.list', () => ({
    value: [
      {
        key: 'helm.nextSteps',
        label: 'Suggest next steps',
        kind: 'boolean',
        value: true,
        provider: { plugin: 'helm', tier: 'user' },
        isLocked: false,
      },
    ],
  }))
  on('config.set', ($, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })

  const ran = await $.command.run({ ...COMMAND, args: 'off' })
  expect(ran.text).toContain('are off')
  expect(sets).toEqual([{ key: 'helm.nextSteps', value: false }])
})

test('/clear forgets the steps', async ($, on) => {
  engineBand(on)
  on('session.end', () => ({ sessionId: 's1' }))
  await suggest($)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const ran = await $.command.run({ ...COMMAND, args: '' })
  expect(ran.text).toContain('No next steps yet')
})

test('the system prompt carries the instructions while enabled', async ($, on) => {
  engineBand(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))

  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.map(s => s.id)).toEqual(['intro', 'helm:next-steps'])
})

test('turned off in config: no instructions, no list, no strip', { options: { nextSteps: false } }, async ($, on) => {
  engineBand(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))

  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.map(s => s.id)).toEqual(['intro'])

  const ran = await $.tool.call({ tool: TOOL, steps: STEPS })
  expect(ran.text ?? JSON.stringify(ran.result)).toContain('turned next-step suggestions off')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'key-1' })).toBeUndefined()
  await ui.unmount()
})
