import type { Register } from 'claude-code'

import { drawBand } from './band'
import {
  cachePromptSubmit,
  cacheSessionEnd,
  cacheSessionStart,
  cacheTurnComplete,
  cacheTurnStart,
  registerCache,
} from './cache'
import {
  registerNextSteps,
  stepsPromptSubmit,
  stepsSessionEnd,
  stepsSessionStart,
  stepsTurnComplete,
  stepsTurnStart,
} from './next-steps'
import { optionsSessionStart } from './options'
import { settings } from './settings'

// helm: the context and cache band (cache.ts), next steps (next-steps.tsx),
// the CONFIG panel (options.ts), and the one band above the prompt that draws
// them all (band.tsx).
//
// A plugin hooks each event once, so the events both halves need are hooked
// here: the cache's part, then next steps'.
export const register: Register = (on, options) => {
  const config = settings(options)

  registerCache(on)
  registerNextSteps(on, config)

  on('session.start', async ($, e, next) => {
    await cacheSessionStart($, e, config)
    await stepsSessionStart($, config)
    await optionsSessionStart($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await cacheSessionEnd($, e)
    await stepsSessionEnd($, e)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await cachePromptSubmit($, e)

    return next(await stepsPromptSubmit($, e, config))
  })

  on('turn.start', async ($, e, next) => {
    await cacheTurnStart($)
    stepsTurnStart(e)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await cacheTurnComplete($, e)
    const ended = await next(e)
    stepsTurnComplete($, e, config)

    return ended
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    return drawBand($, e, config, await next(e))
  })
}
