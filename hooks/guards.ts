import type { On } from 'claude-code'

import type { Config } from './shared'
import { TOOL, bump, estTokens, fmtK } from './shared'

/** Files Read handles as media or notebooks: never guarded by size. */
const MEDIA = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb|heic|tiff?)$/i

type Seen = { mtimeMs: number; size: number; nudged: boolean }

// What each conversation (main loop or a subagent) has read, by path and slice.
// A module variable on purpose: a reload, a compaction or a /clear should forget it.
let seen = new Map<string, Seen>()

/** Forgets every read seen, after a compaction or at the session's end. */
export function forgetReads() {
  seen = new Map()
}

export function registerGuards(on: On, cfg: Config) {
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const path = e.file_path
    const isSliced = e.offset !== undefined || e.limit !== undefined
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat === undefined || stat.kind !== 'file' || MEDIA.test(path)) return next(e)

    // 1. A whole-file read of a very large file: offer the cheaper routes first.
    const limitBytes = cfg.readGuardKb * 1024
    if (limitBytes > 0 && !isSliced && stat.size > limitBytes) {
      await bump($, { readsGuarded: 1, tokensSavedEst: Math.min(estTokens(stat.size), 25000) })
      return {
        deny:
          `fable-code: ${path} is ${fmtK(Math.round(stat.size / 1024))} KB (about ${fmtK(estTokens(stat.size))} tokens). ` +
          `Read a slice with offset and limit, search it with Grep or rg, or call ${TOOL('digest')} for a line-numbered summary. ` +
          'A Read with offset or limit set goes straight through.',
      }
    }

    // 2. A repeat of a read this conversation already holds, of a file unchanged since.
    const key = `${e.agentId ?? 'main'}|${path}|${e.offset ?? ''}|${e.limit ?? ''}`
    const before = seen.get(key)
    if (cfg.dedupeReads && before && before.mtimeMs === stat.mtimeMs && before.size === stat.size && !before.nudged) {
      seen.set(key, { ...before, nudged: true })
      await bump($, { readsDeduped: 1, tokensSavedEst: Math.min(estTokens(stat.size), 25000) })
      return {
        deny:
          `fable-code: ${path} has not changed since you read it earlier in this conversation, so its content is already in your context. ` +
          'Use that. If it is no longer in your context, call Read again and it will go through.',
      }
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      seen.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, nudged: false })
      if (seen.size > 2000) seen = new Map([...seen].slice(-1000))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A file that was written is a new file: forget earlier reads of it.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(String(e.tool))) {
      const path = (e as { file_path?: string; notebook_path?: string }).file_path ?? (e as { notebook_path?: string }).notebook_path
      if (path) for (const k of [...seen.keys()]) if (k.includes(`|${path}|`)) seen.delete(k)
    }
    return ran
 }).catch(($, e, next) => next(e))
}
