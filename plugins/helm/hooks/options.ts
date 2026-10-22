import { atom, read, update } from 'claude-code'
import type { ConfigRow, ConfigValue, EngineInterface } from 'claude-code'

import type { OptionRow } from '../types'

// The CONFIG panel: helm's /config rows, read when it opens and changed in
// place. A change reloads the module with the new options; the panel stays
// open across it, and session.start reads the rows again.
//
// With the darrenxhays plugin enabled, it also shows that plugin's
// pragmatic-engineer switch for all projects, and this project's override:
// PRAGMATIC_ENGINEER_AUTO_USE in .claude/settings.local.json's env, which its
// session-start hook reads. Claude Code reads plugin options from user
// settings only, so the override can't be a plugin option. It also shows that
// plugin's switch for using the message skill automatically.
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

const isAutoUseRow = (row: ConfigRow) => isOwnRow(row, 'darrenxhays') && row.key.endsWith('.auto_use')
const isMessageRow = (row: ConfigRow) => isOwnRow(row, 'darrenxhays') && row.key.endsWith('.message_auto_use')

// The panel's own row for this project's override; not a /config key.
export const PROJECT_AUTO_USE = 'project.autoUseHere'
const VARIABLE = 'PRAGMATIC_ENGINEER_AUTO_USE'
const PROJECT_CHOICES = ['default', 'on', 'off']

async function localSettingsPath($: EngineInterface) {
  return `${await $.session.root()}/.claude/settings.local.json`
}

// The file's settings; {} when there is none. Rejects on a file that isn't
// a JSON object, so it is never written over.
async function readLocalSettings($: EngineInterface, path: string): Promise<Record<string, unknown>> {
  if (!(await $.fs.exists(path))) {
    return {}
  }
  const parsed: unknown = JSON.parse(String(await $.fs.read(path)))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a JSON object')
  }

  return parsed as Record<string, unknown>
}

const envOf = (settings: Record<string, unknown>): Record<string, unknown> =>
  typeof settings.env === 'object' && settings.env !== null ? (settings.env as Record<string, unknown>) : {}

const choiceOf = (value: unknown) => (value === 'true' ? 'on' : value === 'false' ? 'off' : 'default')

export async function loadOptions($: EngineInterface) {
  const name = $.plugin.name
  const all = await $.config.list()
  const rows: OptionRow[] = all
    .filter(row => isOwnRow(row, name) && isPanelRow(row))
    .map(row => ({
      key: row.key,
      label: row.label,
      kind: row.kind,
      value: row.value,
      choices: row.options,
      isLocked: row.isLocked,
    }))
  const autoUse = all.find(isAutoUseRow)
  if (autoUse !== undefined) {
    const here = await readLocalSettings($, await localSettingsPath($)).then(
      settings => choiceOf(envOf(settings)[VARIABLE]),
      () => undefined,
    )
    rows.push(
      { key: autoUse.key, label: 'All projects', kind: autoUse.kind, value: autoUse.value, isLocked: autoUse.isLocked },
      // An unreadable settings.local.json is shown, not edited.
      here === undefined
        ? { key: PROJECT_AUTO_USE, label: 'This project', kind: 'text', value: 'settings.local.json unreadable', isLocked: true }
        : { key: PROJECT_AUTO_USE, label: 'This project', kind: 'choice', value: here, choices: PROJECT_CHOICES, isLocked: false },
    )
  }
  const message = all.find(isMessageRow)
  if (message !== undefined) {
    rows.push({ key: message.key, label: 'All projects', kind: message.kind, value: message.value, isLocked: message.isLocked })
  }
  await update($, optionRows, () => rows)
}

// Writes this project's override into .claude/settings.local.json, keeping
// everything else there; `default` removes it. Returns why it couldn't.
async function setProjectAutoUse($: EngineInterface, choice: string): Promise<string | undefined> {
  const path = await localSettingsPath($)
  try {
    const settings = await readLocalSettings($, path)
    const { env: _, ...rest } = settings
    const { [VARIABLE]: _old, ...env } = envOf(settings)
    const next = choice === 'default' ? env : { ...env, [VARIABLE]: choice === 'on' ? 'true' : 'false' }
    await $.fs.write(path, `${JSON.stringify(Object.keys(next).length > 0 ? { ...rest, env: next } : rest, null, 2)}\n`)

    return undefined
  } catch (error) {
    return `${path}: ${(error as Error).message}`
  }
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
  const deny = key === PROJECT_AUTO_USE ? await setProjectAutoUse($, String(value)) : (await $.config.set({ key, value })).deny
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
