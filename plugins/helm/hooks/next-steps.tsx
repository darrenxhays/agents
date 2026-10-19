import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, EventName, Hook, On, ResolveInput, TurnStepResult } from 'claude-code'

import type { NextStep } from '../types'
import { forkRefreshed, resetKeepWarm } from './cache'
import { isOwnRow } from './options'
import type { Settings } from './settings'

type In<E extends EventName> = Parameters<Hook<E>>[1]

export const TOOL = 'mcp__helm__suggest'
const MAX_STEPS = 9

const steps = atom({ plugin: 'helm', key: 'steps' } as const, [])
const isShown = atom({ plugin: 'helm', key: 'isShown' } as const, false)
const selected = atom({ plugin: 'helm', key: 'selected' } as const, [])
const isExpanded = atom({ plugin: 'helm', key: 'isExpanded' } as const, false)
const generation = atom({ plugin: 'helm', key: 'generation' } as const, 0)
const toolUseId = atom({ plugin: 'helm', key: 'toolUseId' } as const, '')

const INSTRUCTIONS = `# Next steps (helm plugin)
When you finish a task the user gave you and are about to end your turn, call \`${TOOL}\` as your very last action with 2-5 concrete next steps the user is most likely to want, most likely first. The user sees them as numbered buttons in the conversation and starts one with a click or by typing its number.
- \`title\`: the button label, an imperative under 60 characters ("Run the unit tests").
- \`prompt\`: the complete, self-contained instruction you would want to receive to do that step: name the files, branches, PRs, work items and commands it involves, since it is sent as the user's next message.
Write your summary first, then call the tool; after it returns, end your turn with no further text. The buttons speak for themselves: don't mention or introduce them in your reply (no "I've added some next steps below"), and don't repeat the steps as a list.
Do not call it for a reply that only answers a question or chats, while you are waiting on the user to answer a question of yours, mid-task, or in a subagent.`

const TOOL_DESCRIPTION =
  'Shows the user 2-5 numbered next-step buttons in the conversation. Call it whenever you finish ' +
  'a task the user gave you, as the last action of the turn, after your summary; then end the ' +
  'turn with no further text. Never mention or introduce the buttons in your reply. Each step has a short imperative button title and the full, ' +
  'self-contained prompt sent as the user message when they pick it. Skip it for replies that ' +
  'only answer a question, while waiting on the user to answer you, mid-task, and in subagents.'

const FORK_PROMPT = `The user's helm plugin asks: based on the conversation so far, what are the 2-5 next steps the user is most likely to want now, most likely first?
Reply with only a JSON array, no prose and no code fence: [{"title": "...", "prompt": "..."}]
- title: an imperative button label under 60 characters.
- prompt: the complete, self-contained instruction to send as the user's next message, naming the files, branches, PRs, work items and commands involved.
If nothing sensible is left to do, reply [].`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_STEPS,
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Button label: an imperative under 60 characters.',
          },
          prompt: {
            type: 'string',
            description:
              'The full, self-contained instruction sent as the user message when this step is picked.',
          },
        },
        required: ['title', 'prompt'],
      },
    },
  },
  required: ['steps'],
}

function parseSteps(raw: unknown): NextStep[] {
  if (!Array.isArray(raw)) return []

  return raw
    .filter(
      (one): one is NextStep =>
        typeof one?.title === 'string' &&
        typeof one?.prompt === 'string' &&
        one.title.trim() !== '' &&
        one.prompt.trim() !== '',
    )
    .slice(0, MAX_STEPS)
    .map(one => ({ title: one.title.trim(), prompt: one.prompt.trim() }))
}

function parseJsonArray(text: string): unknown {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []

  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
}

function describeForModel(list: NextStep[]): string {
  const lines = list.map((step, i) => `${i + 1}. ${step.title}: ${step.prompt}`)

  return [
    `The user had these next steps on screen as numbered buttons (from your last ${TOOL} call).`,
    'If their message refers to a step by number, this is the step meant:',
    ...lines,
  ].join('\n')
}

function stepsText(chosen: NextStep[]): string {
  if (chosen.length === 1) return chosen[0]?.prompt ?? ''

  const numbered = chosen.map((step, i) => `${i + 1}. ${step.prompt}`)

  return ['Do these next steps in order:', ...numbered].join('\n\n')
}

function withNote(text: string, note: string): string {
  return note === '' ? text : `${text}\n\nAdditional instructions: ${note}`
}

function isEnabledRow(row: ConfigRow, name: string): boolean {
  return row.key.endsWith('.nextSteps') && isOwnRow(row, name)
}

async function setEnabled($: EngineInterface, value: boolean): Promise<string | undefined> {
  const row = (await $.config.list()).find(one => isEnabledRow(one, $.plugin.name))
  if (row === undefined) return 'its setting is not in /config'

  return (await $.config.set({ key: row.key, value })).deny
}

async function show($: EngineInterface, list: NextStep[], ownerId: string): Promise<number> {
  const set = await update($, generation, now => now + 1)
  await update($, toolUseId, () => ownerId)
  await update($, steps, () => list)
  await update($, selected, () => [])
  await update($, isExpanded, () => false)
  await update($, isShown, () => true)

  return set
}

async function hide($: EngineInterface): Promise<void> {
  await update($, isShown, () => false)
  await update($, selected, () => [])
}

async function suggestFromConversation($: EngineInterface): Promise<{ text: string; count: number }> {
  $.ui.status('helm: suggesting next steps…')
  try {
    const startedAt = await $.clock.now()
    const reply = await $.model.fork({ prompt: FORK_PROMPT })
    if (reply.isAnswered || reply.reason === 'empty-reply') {
      await forkRefreshed($, startedAt, reply.usage)
    }
    if (!reply.isAnswered) {
      const text =
        reply.reason === 'nothing-to-fork'
          ? 'There is no finished turn to suggest next steps from yet.'
          : `The model gave no next steps (${reply.reason}).`

      return { text, count: 0 }
    }

    const list = parseSteps(parseJsonArray(reply.text))
    if (list.length === 0) return { text: 'The model found no next steps to suggest.', count: 0 }

    const set = await show($, list, '')

    return { text: setText(set, list.length), count: list.length }
  } finally {
    $.ui.status(undefined)
  }
}

async function pick($: EngineInterface, chosen: NextStep[], isFill: boolean): Promise<void> {
  const { text } = await $.prompt.read()

  if (isFill) {
    const draft = text.trimEnd()
    const body = stepsText(chosen)
    await $.prompt.fill({ text: draft === '' ? body : `${draft}\n\n${body}`, mode: 'replace' })
    await update($, selected, () => [])

    return
  }

  const note = text.trim()
  if (note !== '') {
    await $.prompt.fill({ text: '', mode: 'replace' })
  }
  await hide($)
  await $.prompt.submit({ text: withNote(stepsText(chosen), note), asUser: true })
  await resetKeepWarm($)
}

function setText(set: number, count: number): string {
  return `Next steps (set ${set}): ${count} suggestions, click one below.`
}

function setOf(text: string): number | undefined {
  const found = /\(set (\d+)\)/.exec(text)?.[1]

  return found === undefined ? undefined : Number(found)
}

async function toggle($: EngineInterface, i: number): Promise<void> {
  await update($, selected, now =>
    now.includes(i) ? now.filter(one => one !== i) : [...now, i].sort((a, b) => a - b),
  )
}

type StepsView = {
  list: NextStep[]
  picked: number[]
  isFull: boolean
  isFill: boolean
}

// Theme keys, so the chips follow the person's light or dark theme.
const CHIP_COLORS = ['claude', 'suggestion', 'success', 'warning', 'merged', 'ide', 'planMode', 'autoAccept', 'permission']

function chipColor(i: number): string {
  return CHIP_COLORS[i % CHIP_COLORS.length] ?? 'claude'
}

// The live list, drawn in the suggestion's own transcript row (or a /next-steps
// output row): a framed card with a colored chip per step, a toggle to combine
// steps, and the footer. Prompts stay hidden until "show prompts".
function drawSteps($: EngineInterface, e: ResolveInput, view: StepsView) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const { list, picked, isFull, isFill } = view
  const chosen = list.filter((_, i) => picked.includes(i))
  const hint = isFill ? 'click to edit in the prompt · ○ to combine' : 'click to run · ○ to combine'
  const runLabel = isFill ? `▶ Put ${chosen.length} in prompt` : `▶ Run ${chosen.length} selected`

  return (
    <Box flexDirection="column" width="100%" borderStyle="round" borderColor="claude" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold color="claude">
          ✦ Next steps
        </Text>
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      </Box>
      {list.map((step, i) => {
        const isPicked = picked.includes(i)
        const color = chipColor(i)

        return (
          <Box key={`row-${i + 1}`} flexDirection="column" marginBottom={isFull ? 1 : 0}>
            <Box flexDirection="row">
              <Button
                key={`toggle-${i + 1}`}
                plain
                dimColor={!isPicked}
                label={isPicked ? '●' : '○'}
                onPress={() => toggle($, i)}
              />
              <Text> </Text>
              <Button key={`step-${i + 1}`} plain label={step.title} onPress={() => pick($, [step], isFill)}>
                <Text backgroundColor={color} color="inverseText" bold>
                  {` ${i + 1} `}
                </Text>
                {'  '}
                <Text bold color={isPicked ? color : undefined}>
                  {step.title}
                </Text>
              </Button>
            </Box>
            {isFull && <Text>{step.prompt}</Text>}
          </Box>
        )
      })}
      <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
        {chosen.length > 0 ? (
          <Button key="run-selected" variant="primary" label={runLabel} onPress={() => pick($, chosen, isFill)} />
        ) : (
          <Text dimColor wrap="truncate-end">
            type a note first to send it with the step
          </Text>
        )}
        <Box flexDirection="row">
          <Button
            key="details"
            plain
            dimColor
            label={isFull ? 'hide prompts' : 'show prompts'}
            onPress={() => update($, isExpanded, now => !now)}
          />
          <Text dimColor> · </Text>
          <Button key="dismiss" plain dimColor role="dismiss" label="dismiss" onPress={() => hide($)} />
        </Box>
      </Box>
    </Box>
  )
}

// A suggestion that is no longer live: its titles, dim, so the transcript
// still says what was offered.
function drawSummary($: EngineInterface, e: ResolveInput, list: NextStep[]) {
  const { Box, Text } = $.ui.resolve(e)

  return (
    <Box flexDirection="column">
      <Text dimColor>✦ Next steps offered</Text>
      {list.map((step, i) => (
        <Text dimColor>
          {`  ${i + 1}  `}
          {step.title}
        </Text>
      ))}
    </Box>
  )
}

// What the main loop's current turn did, for autoFallback. Module variables:
// a reload mid-turn only skips that one turn's fallback.
let changesInTurn = 0
let isSuggestedInTurn = false

// Next steps' part of the events the cache hooks too: register.tsx runs these
// after the cache's part.
export async function stepsSessionStart($: EngineInterface, config: Settings) {
  if (!config.isNextSteps) {
    await hide($)
  }
  await $.tool.register({
    name: 'suggest',
    description: TOOL_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isDeferred: false,
  })
  await $.command.register({
    name: 'next-steps',
    description: 'Show the last next steps, ask for new ones (suggest), or turn them on/off (also in /config)',
    argumentHint: '[suggest|on|off]',
  })
}

export async function stepsSessionEnd($: EngineInterface, e: In<'session.end'>) {
  if (e.reason === 'clear') {
    await hide($)
    await update($, steps, () => [])
  }
}

export function stepsTurnStart(e: In<'turn.start'>) {
  if (e.agentId === undefined) {
    changesInTurn = 0
    isSuggestedInTurn = false
  }
}

// The step after the steps went on screen, answered without asking the model:
// asked, it ends with an empty reply, the engine nudges it for visible output,
// and it writes its summary a second time.
export function stepsTurnStep(e: In<'turn.step'>): TurnStepResult | undefined {
  if (e.agentId !== undefined || !isSuggestedInTurn) return undefined

  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
}

// After the turn ends: a turn that changed things without suggesting asks the
// model for steps, when autoFallback is on.
export function stepsTurnComplete($: EngineInterface, e: In<'turn.complete'>, config: Settings) {
  const isMissed =
    config.isNextSteps &&
    config.hasAutoFallback &&
    e.agentId === undefined &&
    e.reason === 'answer' &&
    !isSuggestedInTurn &&
    changesInTurn > 0

  if (isMissed) {
    $.clock.after(0, () => {
      void suggestFromConversation($).then(found => {
        if (found.count > 0) $.ui.toast('helm: new next steps ready (/next-steps shows them)')
      })
    })
  }
}

// A prompt that retires the live steps: the prompt to hand on, with the steps
// as context when the person typed it, so "do 2" means the step on screen.
export async function stepsPromptSubmit(
  $: EngineInterface,
  e: In<'prompt.submit'>,
  config: Settings,
): Promise<In<'prompt.submit'>> {
  if (!config.isNextSteps || e.command !== undefined || e.isMeta === true || !(await read($, isShown))) {
    return e
  }

  const origin = e.origin
  const isOurs = origin?.kind === 'plugin' && origin.name === $.plugin.name
  const isTyped =
    origin?.kind === 'composer' || origin?.kind === 'bridge' || origin?.kind === 'sdk'

  if (!isOurs && !isTyped) {
    return e
  }

  await hide($)
  if (isOurs) {
    return e
  }

  const list = await read($, steps)

  return { ...e, context: [...(e.context ?? []), describeForModel(list)] }
}

// The events only next steps hook.
export function registerNextSteps(on: On, config: Settings) {
  const { isNextSteps: isEnabled, isFillOnPick } = config

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isSkipped =
      !e.tools.includes(TOOL) ||
      e.traits.includes('bare') ||
      e.traits.includes('print') ||
      e.traits.includes('teammate')

    if (isSkipped || !isEnabled) {
      return composed
    }

    return {
      sections: [
        ...composed.sections,
        { id: 'helm:next-steps', text: INSTRUCTIONS, scope: 'session' },
      ],
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { result: 'Next steps are shown for the main conversation only; nothing was shown.' }
    }
    if (!isEnabled) {
      return { result: 'The user has turned next-step suggestions off; nothing was shown.' }
    }

    const list = parseSteps(e.steps)
    if (list.length === 0) {
      return { deny: 'Give at least one step, each with a non-empty title and prompt.' }
    }

    isSuggestedInTurn = true
    await show($, list, e.tool_use_id)

    return {
      result: `Shown to the user as ${list.length} numbered buttons. End your turn now with no further text.`,
    }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const isChange = ran.deny === undefined && ran.isError !== true && ran.isReadOnly !== true

    if (e.agentId === undefined && e.tool !== TOOL && isChange) {
      changesInTurn += 1
    }

    return ran
  })

  on('command.run', { command: 'next-steps' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'on' || arg === 'off') {
      const deny = await setEnabled($, arg === 'on')
      if (deny !== undefined) {
        return { text: `Could not turn next-step suggestions ${arg}: ${deny}` }
      }
      if (arg === 'off') {
        await hide($)
      }

      return { text: `Next-step suggestions are ${arg}. Also under /config: "Suggest next steps".` }
    }
    if (!isEnabled) {
      return { text: 'Next-step suggestions are off. /next-steps on (or /config) turns them on.' }
    }
    if (arg === 'suggest') {
      return { text: (await suggestFromConversation($)).text }
    }

    const list = await read($, steps)
    if (list.length === 0) {
      return { text: 'No next steps yet in this session. /next-steps suggest asks for some.' }
    }

    const set = await show($, list, '')

    return { text: setText(set, list.length) }
  })

  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    const input = e.props.input as { steps?: unknown } | null | undefined
    const list = parseSteps(input?.steps)
    if (list.length === 0 || e.props.isErrored) {
      return next(e)
    }

    const shown = await read($, isShown)
    const owner = await read($, toolUseId)
    const picked = await read($, selected)
    const isFull = await read($, isExpanded)

    if (!isEnabled || !shown || owner !== e.props.tool_use_id) {
      return drawSummary($, e, list)
    }

    return drawSteps($, e, { list, picked, isFull, isFill: isFillOnPick })
  })

  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'next-steps' } }, async ($, e, next) => {
    const set = setOf(e.props.text)
    if (set === undefined || e.props.isErrored) {
      return next(e)
    }

    const shown = await read($, isShown)
    const current = await read($, generation)
    const owner = await read($, toolUseId)
    const list = await read($, steps)
    const picked = await read($, selected)
    const isFull = await read($, isExpanded)

    if (!isEnabled || !shown || set !== current || owner !== '' || list.length === 0) {
      return next(e)
    }

    return drawSteps($, e, { list, picked, isFull, isFill: isFillOnPick })
  })
}
