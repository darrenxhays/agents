import type { PluginOptions } from 'claude-code'

import type { Action } from '../types'

// The plugin's userConfig, read once at load.
export type Settings = {
  isBandShown: boolean
  ttlMs: number
  isAuto: boolean
  keepWarmCount: number
  handoffPercent: number
  leadMs: number
  idleAction: Action
  isNextSteps: boolean
  isFillOnPick: boolean
  hasAutoFallback: boolean
}

export function settings(options: PluginOptions): Settings {
  const ttlMs = options.cacheTtl === '5m' ? 5 * 60_000 : 60 * 60_000

  return {
    isBandShown: options.contextBand !== false,
    ttlMs,
    isAuto: options.autoKeepWarm !== false,
    keepWarmCount: typeof options.keepWarmCount === 'number' ? options.keepWarmCount : 3,
    handoffPercent: typeof options.handoffPercent === 'number' ? options.handoffPercent : 50,
    // At least 5 seconds, so a once-a-second tick cannot step over the window
    // (0 or less would never act at all); at most half the TTL.
    leadMs: Math.min(ttlMs / 2, Math.max(5, typeof options.leadSeconds === 'number' ? options.leadSeconds : 120) * 1000),
    idleAction: options.idleAction === 'handoff' ? 'handoff' : 'compact',
    isNextSteps: options.nextSteps !== false,
    isFillOnPick: options.clickAction === 'fill',
    hasAutoFallback: options.autoFallback === true,
  }
}
