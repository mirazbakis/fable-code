import type { On } from 'claude-code'

import type { FableMemory } from '../types'
import { loadAll, loadJournal } from './memory'
import type { Config } from './shared'
import { TOOL, short } from './shared'

const MAX_MEMORIES_IN_PROMPT = 40

function playbook(cfg: Config, model: string, tools: readonly string[]) {
  const has = (name: string) => tools.includes(TOOL(name))
  const isSmallModel = /haiku/i.test(model)
  const lines: string[] = ['# fable-code', '']

  lines.push('Work fast and spend context carefully:')
  lines.push('- Batch independent tool calls in one message so they run in parallel: reads, searches, scouts, delegations.')
  lines.push('- Search before reading (Grep/rg, Glob). Read big files in slices with offset/limit, never whole when a slice will do.')
  if (has('digest')) lines.push(`- For a large file you need to understand but not rewrite, call ${TOOL('digest')} first, then read only the ranges it points to.`)
  lines.push('- Do not re-read a file you already read unless it changed.')
  lines.push('- Keep tool output small: pass quiet flags, pipe long output through head/tail/grep.')
  lines.push('')

  if (!isSmallModel || cfg.delegateProvider !== 'claude') {
    lines.push('Delegate to save your own context and time:')
    if (has('delegate')) {
      lines.push(`- ${TOOL('delegate')} hands a small self-contained task to a cheaper model (${cfg.delegateProvider === 'claude' ? cfg.fastModel : cfg.delegateProvider}): boilerplate, tests for a given function, regexes, fixtures, docstrings, commit messages, explaining an error. Review what comes back before using it.`)
    }
    lines.push('- The fable-code:scout agent type explores the codebase on a small model and reports paths and line numbers. Launch several in parallel for independent questions instead of reading widely yourself.')
    lines.push('- The fable-code:worker agent type applies a precise, mechanical spec across files. Give it the acceptance check and review its diff.')
    lines.push('- Keep for yourself: design, debugging, security-sensitive code, and anything that needs the whole picture.')
    lines.push('')
  }

  if (has('remember')) {
    lines.push('Memory across sessions:')
    lines.push(`- Call ${TOOL('recall')} before exploring something the project or the person may have covered before.`)
    lines.push(`- Call ${TOOL('remember')} when you learn something a future session would otherwise rediscover: conventions, decisions, commands, gotchas, and preferences the person states. One fact per call. Do not save secrets.`)
    lines.push(`- When a memory below turns out to be wrong, fix it with ${TOOL('forget')} and a new remember.`)
  }
  return lines.join('\n')
}

function memoryBlock(memories: FableMemory[]) {
  if (memories.length === 0) return ''
  const rank = (m: FableMemory) => (m.source === 'auto' ? 0 : 2) + Math.min(m.hits, 10) * 0.3 + m.createdAt / 1e13
  const top = [...memories].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_MEMORIES_IN_PROMPT)
  const fmt = (m: FableMemory) => `- [${m.id}] ${m.text}`
  const project = top.filter(m => m.scope === 'project').map(fmt)
  const global = top.filter(m => m.scope === 'global').map(fmt)
  const parts = ['## Remembered (fable-code memory)']
  if (project.length) parts.push('This project:', ...project)
  if (global.length) parts.push('Everywhere:', ...global)
  if (memories.length > top.length) parts.push(`(${memories.length - top.length} more: use recall.)`)
  return parts.join('\n')
}

export function registerPlaybook(on: On, cfg: Config) {
  on('prompt.compose', async ($, e, next) => {
    const base = await next(e)
    const [memories, journal] = await Promise.all([loadAll($), loadJournal($)])
    const recent = journal.slice(-6)
    const text = [
      playbook(cfg, e.model, e.tools),
      memoryBlock(memories),
      recent.length
        ? ['## Recent work in this project (oldest first)', ...recent.map(j => `- ${new Date(j.at).toISOString().slice(0, 10)}: asked "${short(j.prompt, 140)}" → ${short(j.outcome, 200)}`)].join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    return { sections: [...base.sections, { id: 'fable-code:playbook', text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))
}
