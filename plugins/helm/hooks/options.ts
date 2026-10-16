import { atom, read, update } from 'claude-code'
import type { ConfigRow, ConfigValue, EngineInterface } from 'claude-code'

import type { OptionRow } from '../types'

// The CONFIG panel: helm's /config rows, read when it opens and changed in
// place. A change reloads the module with the new options; the panel stays
// open across it, and session.start reads the rows again.
const showConfig = atom({ plugin: 'helm', key: 'showConfig' } as const, false)
const showUsage = atom({ plugin: 'helm', key: 'showUsage' } as const, false)
const optionRows = atom({ plugin: 'helm', key: 'optionRows' } as const, [] as OptionRow[])
const optionNote = atom({ plugin: 'helm', key: 'optionNote' } as const, '')

// A row of this plugin's: `helm.<field>`, or `helm@<marketplace>.<field>`.
export function isOwnRow(row: ConfigRow, name: string): boolean {
  return row.provider.plugin === name || row.key.startsWith(`${name}.`) || row.key.startsWith(`${name}@`)
}

// Turning the band off would hide the panel that turns it back on, so that
// one is left to /config.
const isPanelRow = (row: ConfigRow) => !row.key.endsWith('.contextBand')

export async function loadOptions($: EngineInterface) {
  const name = $.plugin.name
  const rows = (await $.config.list()).filter(row => isOwnRow(row, name) && isPanelRow(row))
  await update($, optionRows, () =>
    rows.map(row => ({
      key: row.key,
      label: row.label,
      kind: row.kind,
      value: row.value,
      choices: row.options,
      isLocked: row.isLocked,
    })),
  )
}

export async function toggleConfig($: EngineInterface) {
  const isOpening = !(await read($, showConfig))
  await update($, showConfig, () => isOpening)
  await update($, optionNote, () => '')
  if (isOpening) {
    // One panel at a time under the buttons.
    await update($, showUsage, () => false)
    await loadOptions($)
  }
}

// At each load: a change from the panel reloaded the module, so read the
// rows again while it is open.
export async function optionsSessionStart($: EngineInterface) {
  if (await read($, showConfig)) {
    await loadOptions($)
  }
}

export async function setOption($: EngineInterface, key: string, value: ConfigValue) {
  const { deny } = await $.config.set({ key, value })
  await update($, optionNote, () => (deny === undefined ? '' : `✗ ${deny}`))
  if (deny === undefined) {
    await update($, optionRows, rows => rows.map(row => (row.key === key ? { ...row, value } : row)))
  }
}

// A number typed into the panel, or a note saying why it was not taken.
export async function setNumber($: EngineInterface, key: string, text: string) {
  const value = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(value)) {
    await update($, optionNote, () => `✗ "${text}" is not a number`)
    return
  }
  await setOption($, key, value)
}
