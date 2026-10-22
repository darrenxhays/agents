import { atom, read } from 'claude-code'
import type { EngineInterface, Hook, RenderElement } from 'claude-code'

import type { Handoff, KeepWarm, Limit, OptionRow } from '../types'
import {
  barCells,
  center,
  clock,
  compactNow,
  heat,
  kilo,
  resetLabel,
  runs,
  toggleUsage,
  WINDOWS,
  writeHandoff,
} from './cache'
import type { Cell } from './cache'
import { PROJECT_AUTO_USE, setNumber, setOption, toggleConfig } from './options'
import type { Settings } from './settings'

// The values the band draws from. cache.ts and next-steps.tsx write them; a
// file reads only the atoms it declares itself.
const meter = atom({ plugin: 'helm', key: 'meter' } as const, null)
const cache = atom({ plugin: 'helm', key: 'cache' } as const, null)
const now = atom({ plugin: 'helm', key: 'now' } as const, 0)
const handoff = atom({ plugin: 'helm', key: 'handoff' } as const, { phase: 'idle' } as Handoff)
const keep = atom({ plugin: 'helm', key: 'keep' } as const, { count: 0, isRefreshing: false } as KeepWarm)
const limits = atom({ plugin: 'helm', key: 'limits' } as const, [] as Limit[])
const showUsage = atom({ plugin: 'helm', key: 'showUsage' } as const, false)
const showConfig = atom({ plugin: 'helm', key: 'showConfig' } as const, false)
const optionRows = atom({ plugin: 'helm', key: 'optionRows' } as const, [] as OptionRow[])
const optionNote = atom({ plugin: 'helm', key: 'optionNote' } as const, '')

type Band = Extract<Parameters<Hook<'ui.render'>>[1], { component: 'AbovePrompt' }>

// The band above the prompt, top to bottom:
// - the context bar, with the cache countdown at its right end;
// - COMPACT, HANDOFF, USAGE and CONFIG, always in the same place;
// - the 5-hour and weekly usage bars while USAGE is open, or helm's options
//   while CONFIG is;
// - the last keep-warm, compact or handoff note.
// Next steps are drawn in the conversation, in their own card. Whatever other
// plugins draw above the prompt follows below.
export async function drawBand($: EngineInterface, e: Band, config: Settings, below: RenderElement): Promise<RenderElement> {
  const fill = await read($, meter)
  if (!config.isBandShown || fill === null) {
    return below
  }

  const { Box, Button, Text } = $.ui.resolve(e)
  const width = Math.max(24, e.props.bodyColumns - 1)
  const held = await read($, cache)
  const at = await read($, now)
  const job = await read($, handoff)
  const warm = await read($, keep)
  const isUsageOpen = await read($, showUsage)
  const isConfigOpen = await read($, showConfig)
  const windows = isUsageOpen ? await read($, limits) : []
  const tick = Math.floor(at / 1000)
  const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[tick % 10]
  const isWriting = job.phase === 'writing'
  const writingText = isWriting
    ? `${spinner} ${job.isAuto ? 'AUTO-' : ''}${job.action === 'compact' ? 'COMPACTING' : 'HANDOFF'}…`
    : ''

  const draw = (cells: Cell[]) => (
    <Text>
      {runs(cells).map(r => (
        <Text color={r.fg} backgroundColor={r.bg} bold={r.bold}>
          {r.ch}
        </Text>
      ))}
    </Text>
  )

  // Context bar, with the cache countdown right-aligned inside it.
  const ttlMs = config.ttlMs
  const pct = fill?.percent
  const contextLabel =
    fill === null
      ? ''
      : pct === undefined
        ? `◆ CONTEXT – / ${kilo(fill.window)} · waiting for first response`
        : `◆ CONTEXT ${pct}% · ${kilo(fill.tokens ?? 0)} / ${kilo(fill.window)}`
  const left = held === null ? 0 : held.lastAt + ttlMs - Math.max(at, held.lastAt)
  const isWarm = held !== null && left > 0
  const fraction = isWarm ? left / ttlMs : 0
  const cacheRight = {
    text: held === null ? 'CACHE --:--' : isWarm ? `CACHE ${clock(left)}` : 'CACHE EXPIRED',
    fg: !isWarm ? '#f85149' : fraction < 0.05 ? '#f85149' : fraction < 0.2 ? '#d29922' : '#39d3f2',
  }

  const isFree = !e.props.isWorking && !isWriting
  const canHandoff = isFree && held !== null
  const canCompact = isFree && (held !== null || fill?.tokens !== undefined)

  // COMPACT, HANDOFF, USAGE and CONFIG: four buttons that never change place.
  const quarter = Math.floor((width - 3) / 4)
  const last = width - 3 - 3 * quarter
  const label = (text: string, cols: number) => center(text, Math.max(text.length, cols - 4))
  // A button that can't be pressed yet: the same chrome and width, greyed out.
  const greyed = (text: string, cols: number) => (
    <Box width={cols} justifyContent="center">
      <Text dimColor>{`[ ${label(text, cols)} ]`}</Text>
    </Box>
  )
  const buttons = (
    <Box flexDirection="row" width={width} columnGap={1} marginTop={1}>
      {isWriting ? (
        <Box width={2 * quarter + 1} justifyContent="center">
          <Text color="claude" bold>
            {writingText} {spinner}
          </Text>
        </Box>
      ) : (
        [
          canCompact ? (
            <Button key="compact" label={label('COMPACT', quarter)} hotkey="c" variant="secondary" onPress={() => void compactNow($, false)} />
          ) : (
            greyed('COMPACT', quarter)
          ),
          canHandoff ? (
            <Button key="handoff" label={label('HANDOFF', quarter)} hotkey="h" variant="primary" onPress={() => void writeHandoff($, false)} />
          ) : (
            greyed('HANDOFF', quarter)
          ),
        ]
      )}
      <Button key="usage" label={label(isUsageOpen ? 'USAGE ▴' : 'USAGE ▾', quarter)} hotkey="u" variant="secondary" onPress={() => void toggleUsage($)} />
      <Button key="config" label={label(isConfigOpen ? 'CONFIG ▴' : 'CONFIG ▾', last)} hotkey="g" variant="secondary" onPress={() => void toggleConfig($)} />
    </Box>
  )

  return (
    // The engine's own node may sit under no Box with a width, so what follows
    // goes beside helm's rows, not inside them.
    <Box flexDirection="column">
      <Box flexDirection="column" width={width}>
        {draw(
            barCells({
              width,
              fraction: (pct ?? 0) / 100,
              color: heat,
              label: contextLabel,
              sweep: isWarm ? tick * 2 : undefined,
              right: cacheRight,
            }),
          )}
        {buttons}

        {isUsageOpen &&
          (windows.length === 0 ? (
            <Box marginTop={1}><Text dimColor>No usage windows reported yet (they appear on a subscription after the first response).</Text></Box>
          ) : (
            <Box flexDirection="column" width={width} marginTop={1} rowGap={1}>
              {windows.map(w => {
                const known = WINDOWS[w.kind]
                const name = known?.name ?? w.kind.replace(/_/g, ' ').toUpperCase()
                const resetMs = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)
                const nowMs = at > 0 ? at : resetMs
                const pace =
                  known !== undefined && !Number.isNaN(resetMs)
                    ? 1 - Math.min(1, Math.max(0, (resetMs - nowMs) / known.ms))
                    : undefined
                const usage = `${w.kind === 'seven_day' ? '▣' : '◷'} ${name} ${w.percentUsed}%${resetLabel(w.resetsAt, w.kind === 'seven_day')}`

                return draw(barCells({ width, fraction: w.percentUsed / 100, color: heat, label: usage, marker: pace }))
              })}
            </Box>
          ))}

        {isConfigOpen && (await drawOptions($, e, width))}

        {job.phase === 'failed' && (
          <Text color="error" wrap="truncate-end">
            ✗ {job.action} failed: {job.reason}
          </Text>
        )}
        {warm.note !== undefined && job.phase !== 'failed' && (
          <Text dimColor italic wrap="truncate-end">
            {warm.note}
          </Text>
        )}

      </Box>
      {below}
    </Box>
  )
}

// The CONFIG panel's sections, one per part of helm, each listing its fields
// in the order drawn (after its on/off switches). A field not listed here goes
// under "Other".
const SECTIONS = [
  {
    title: 'Context and cache',
    fields: ['cacheTtl', 'autoKeepWarm', 'keepWarmCount', 'leadSeconds', 'idleAction', 'handoffPercent'],
  },
  { title: 'Next steps', fields: ['nextSteps', 'clickAction', 'autoFallback'] },
  // The darrenxhays plugin's switches: pragmatic-engineer with this project's override of it, and message.
  { title: 'Use pragmatic-engineer automatically', fields: ['auto_use', 'autoUseHere'] },
  { title: 'Use message automatically', fields: ['message_auto_use'] },
]

const fieldOf = (row: OptionRow) => row.key.slice(row.key.lastIndexOf('.') + 1)

// The CONFIG panel: helm's /config rows (and darrenxhays', see
// options.ts) under a heading for each part, each with its label and its control. A change reloads helm with the new value.
async function drawOptions($: EngineInterface, e: Band, width: number) {
  const ui = $.ui.resolve(e)
  const { Box, Button, Text } = ui
  // Mobile draws no fields: its choice and number rows are shown, set in /config.
  const fields = 'Input' in ui && 'Select' in ui ? { Input: ui.Input, Select: ui.Select } : undefined
  const rows = await read($, optionRows)
  const note = await read($, optionNote)
  const labelWidth = Math.min(Math.floor(width / 2), Math.max(0, ...rows.map(row => row.label.length)) + 4)

  const control = (row: OptionRow) => {
    const field = fieldOf(row)
    if (row.isLocked) {
      return <Text dimColor>{`${String(row.value)} (locked)`}</Text>
    }
    if (row.kind === 'boolean') {
      return (
        <Button key={`opt-${field}`} plain label={row.value === true ? '● on' : '○ off'} onPress={() => void setOption($, row.key, row.value !== true)} />
      )
    }
    if (fields === undefined) {
      const where = row.key === PROJECT_AUTO_USE ? 'in the terminal' : 'in /config'
      return <Text dimColor>{`${String(row.value)} (set ${where})`}</Text>
    }
    const { Input, Select } = fields
    if (row.kind === 'choice' && row.choices !== undefined && row.choices.length > 0) {
      return (
        <Select
          key={`opt-${field}`}
          options={row.choices.map(value => ({ value }))}
          value={String(row.value)}
          onSelect={(value: string) => void setOption($, row.key, value)}
        />
      )
    }

    return (
      <Input
        key={`opt-${field}`}
        value={String(row.value)}
        submitLabel="set"
        onSubmit={(value: string) => void (row.kind === 'number' ? setNumber($, row.key, value) : setOption($, row.key, value))}
      />
    )
  }

  const listed = SECTIONS.flatMap(section => section.fields)
  // In each section the on/off switches come first, the rest below them.
  const switchesFirst = (list: OptionRow[]) => [
    ...list.filter(row => row.kind === 'boolean'),
    ...list.filter(row => row.kind !== 'boolean'),
  ]
  const sections = [
    ...SECTIONS.map(section => ({
      title: section.title,
      rows: switchesFirst(section.fields.flatMap(field => rows.filter(row => fieldOf(row) === field))),
    })),
    { title: 'Other', rows: switchesFirst(rows.filter(row => !listed.includes(fieldOf(row)))) },
  ].filter(section => section.rows.length > 0)

  return (
    <Box flexDirection="column" width={width} marginTop={1} rowGap={1}>
      {rows.length === 0 ? (
        <Text dimColor>helm's options aren't in /config in this session.</Text>
      ) : (
        sections.map(section => (
          <Box flexDirection="column" width={width}>
            <Text bold color="claude">
              {section.title.toUpperCase()}
            </Text>
            {section.rows.map(row => (
              <Box flexDirection="row" width={width}>
                <Box width={labelWidth} flexShrink={0}>
                  <Text wrap="truncate-end">{`  ${row.label}`}</Text>
                </Box>
                {control(row)}
              </Box>
            ))}
          </Box>
        ))
      )}
      {note !== '' && (
        <Text color="error" wrap="truncate-end">
          {note}
        </Text>
      )}
    </Box>
  )
}
