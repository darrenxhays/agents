export type Meter = { tokens?: number; window: number; percent?: number }
// isEstimate: timed from a resumed transcript's last response, not yet
// confirmed by a response of this session.
export type Cache = { lastAt: number; readTokens: number; writeTokens: number; isEstimate?: boolean }
export type Action = 'handoff' | 'compact'
export type Handoff =
  | { phase: 'idle' }
  | { phase: 'writing'; action: Action; isAuto: boolean }
  | { phase: 'failed'; action: Action; reason: string }
export type KeepWarm = {
  count: number
  isRefreshing: boolean
  lastRead?: number
  lastContext?: number
  note?: string
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type NextStep = { title: string; prompt: string }

// One of helm's /config rows, as the CONFIG panel draws it.
export type OptionRow = {
  key: string
  label: string
  kind: 'boolean' | 'choice' | 'text' | 'number'
  value: boolean | string | number | readonly string[]
  choices?: readonly string[]
  isLocked: boolean
}

declare module 'claude-code' {
  interface PluginState {
    helm: {
      // Context and cache.
      meter: Meter | null
      cache: Cache | null
      now: number
      handoff: Handoff
      keep: KeepWarm
      busy: boolean
      limits: Limit[]
      showUsage: boolean
      // The CONFIG panel.
      showConfig: boolean
      optionRows: OptionRow[]
      optionNote: string
      // Next steps.
      steps: NextStep[]
      isShown: boolean
      selected: number[]
      isExpanded: boolean
      generation: number
      toolUseId: string
    }
  }
}
