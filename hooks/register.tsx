import type { Register } from 'claude-code'

import { registerDelegation, startDelegation } from './delegate'
import { forgetReads, registerGuards } from './guards'
import { registerMemory, startMemory, syncState } from './memory'
import { registerPlaybook } from './playbook'
import { readConfig } from './shared'
import { registerUi, startUi } from './ui'

/**
 * fable-code: persistent memory, cheap-model delegation, context guards and a
 * control pane, for every Claude model. Each part registers its own hooks;
 * the session-wide ones live here, once each.
 */
export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  registerMemory(on, cfg)
  registerDelegation(on, cfg)
  registerGuards(on, cfg)
  registerPlaybook(on, cfg)
  registerUi(on, cfg)

  on('session.start', async ($, e, next) => {
    // Each part starts on its own, so one that fails leaves the others working.
    await Promise.all([
      startMemory($).catch(() => undefined),
      startDelegation($, cfg).catch(() => undefined),
      startUi($).catch(() => undefined),
    ])
    return next(e)
  })

  // After a compaction or a /clear, earlier reads are no longer in context.
  on('session.compact', async ($, e, next) => {
    forgetReads()
    const done = await next(e)
    await syncState($).catch(() => undefined)
    return done
 }).catch(($, e, next) => next(e))
  on('session.end', async ($, e, next) => {
    forgetReads()
    return next(e)
  })
}
