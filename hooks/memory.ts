import { atom, update } from 'claude-code'
import type { On } from 'claude-code'

import type { FableMemory, FableScope } from '../types'
import type { Config, Engine } from './shared'
import { arg, bump, logDelegation, newId, short } from './shared'

const memoriesAtom = atom({ plugin: 'fable-code', key: 'memories' } as const, [], { shape: 'memories-1' })

const MAX_PROJECT = 250
const MAX_GLOBAL = 120
const MAX_JOURNAL = 30

export type JournalEntry = { at: number; prompt: string; outcome: string }

// ---- storage: one list per project root, one global list, one journal per project ----

const projectKey = async ($: Engine) => `mem:project:${await $.session.root()}`
const journalKey = async ($: Engine) => `journal:${await $.session.root()}`

async function loadList($: Engine, key: string): Promise<FableMemory[]> {
  const v = await $.store.get(key)
  return Array.isArray(v) ? (v as FableMemory[]) : []
}

export async function loadAll($: Engine): Promise<FableMemory[]> {
  const [project, global] = await Promise.all([loadList($, await projectKey($)), loadList($, 'mem:global')])
  return [...project, ...global]
}

async function saveScope($: Engine, scope: FableScope, list: FableMemory[]) {
  const max = scope === 'project' ? MAX_PROJECT : MAX_GLOBAL
  let kept = list
  if (kept.length > max) {
    // Evict automatic memories first, least used and oldest first.
    const rank = (m: FableMemory) => (m.source === 'auto' ? 0 : 1) * 1e6 + m.hits * 1e3 - (Date.now() - m.createdAt) / 864e5
    const order = [...kept].sort((a, b) => rank(a) - rank(b))
    const drop = new Set(order.slice(0, kept.length - max).map(m => m.id))
    kept = kept.filter(m => !drop.has(m.id))
  }
  await $.store.set(scope === 'project' ? await projectKey($) : 'mem:global', kept)
}

/** Copies what the store holds into session state, for the pane and the band. */
export async function syncState($: Engine) {
  const all = await loadAll($)
  await update($, memoriesAtom, () => all)
}

// ---- search ----

const STOP = new Set(
  'the a an and or of to in on for with is are was be it this that as at by from use uses using when how what not'.split(' '),
)
const words = (t: string) =>
  t
    .toLowerCase()
    .split(/[^a-z0-9_.\-/]+/)
    .filter(w => w.length > 2 && !STOP.has(w))

function similarity(a: string, b: string) {
  const A = new Set(words(a))
  const B = new Set(words(b))
  if (A.size === 0 || B.size === 0) return 0
  let both = 0
  for (const w of A) if (B.has(w)) both++
  return both / (A.size + B.size - both)
}

export function search(all: FableMemory[], query: string, limit: number) {
  const q = words(query)
  if (q.length === 0) return [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  const scored = all.map(m => {
    const body = words(m.text)
    const tags = m.tags.map(t => t.toLowerCase())
    let score = 0
    for (const w of q) {
      if (tags.includes(w)) score += 3
      if (body.includes(w)) score += 2
      else if (body.some(b => b.startsWith(w) || w.startsWith(b))) score += 1
    }
    if (score > 0) score += Math.min(m.hits, 5) * 0.1
    return { m, score }
  })
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.m)
}

// ---- writes ----

export async function addMemory(
  $: Engine,
  input: { text: string; scope?: FableScope; tags?: string[]; source: FableMemory['source'] },
): Promise<{ memory?: FableMemory; duplicateOf?: FableMemory }> {
  const scope: FableScope = input.scope === 'global' ? 'global' : 'project'
  const text = input.text.trim().slice(0, 1200)
  const key = scope === 'project' ? await projectKey($) : 'mem:global'
  const list = await loadList($, key)
  const duplicateOf = list.find(m => similarity(m.text, text) >= 0.75)
  if (duplicateOf) return { duplicateOf }

  const now = await $.clock.now()
  const memory: FableMemory = {
    id: newId(now),
    text,
    tags: (input.tags ?? []).map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 8),
    scope,
    source: input.source,
    createdAt: now,
    hits: 0,
  }
  await saveScope($, scope, [...list, memory])
  await syncState($)
  await bump($, { memoriesSaved: 1 })
  return { memory }
}

export async function forgetMemory($: Engine, id: string): Promise<FableMemory | undefined> {
  for (const scope of ['project', 'global'] as const) {
    const key = scope === 'project' ? await projectKey($) : 'mem:global'
    const list = await loadList($, key)
    const found = list.find(m => m.id === id)
    if (found) {
      await $.store.set(key, list.filter(m => m.id !== id))
      await syncState($)
      return found
    }
  }
  return undefined
}

async function markHits($: Engine, hits: FableMemory[]) {
  if (hits.length === 0) return
  const ids = new Set(hits.map(m => m.id))
  for (const scope of ['project', 'global'] as const) {
    const key = scope === 'project' ? await projectKey($) : 'mem:global'
    const list = await loadList($, key)
    if (list.some(m => ids.has(m.id))) {
      await $.store.set(key, list.map(m => (ids.has(m.id) ? { ...m, hits: m.hits + 1 } : m)))
    }
  }
}

// ---- journal: what each turn asked and how it ended, per project ----

export async function loadJournal($: Engine): Promise<JournalEntry[]> {
  const v = await $.store.get(await journalKey($))
  return Array.isArray(v) ? (v as JournalEntry[]) : []
}

async function addJournal($: Engine, entry: JournalEntry) {
  const list = await loadJournal($)
  await $.store.set(await journalKey($), [...list, entry].slice(-MAX_JOURNAL))
}

// ---- automatic memory ----

const AUTO_SYSTEM = `You maintain long-term memory for a coding agent working in one project.
From the exchange below, pick out at most 3 durable facts worth remembering in FUTURE sessions:
project conventions, architecture decisions, build/test/run commands, file locations, gotchas that cost time,
and the person's stated preferences. Skip anything temporary, obvious, already listed, or specific to this one task.
Reply with a JSON array of short strings (each under 200 characters), and nothing else. Reply [] when nothing qualifies.`

async function extractMemories($: Engine, cfg: Config, prompt: string, answer: string) {
  const existing = (await loadList($, await projectKey($))).slice(-40).map(m => `- ${m.text}`).join('\n')
  const started = await $.clock.now()
  const r = await $.model.complete({
    model: cfg.fastModel,
    system: AUTO_SYSTEM,
    prompt: `Already remembered:\n${existing || '(nothing yet)'}\n\nThe person asked:\n${prompt.slice(0, 4000)}\n\nThe agent's final answer:\n${answer.slice(0, 8000)}`,
    maxTokens: 400,
    effort: 'low',
  })
  await logDelegation($, {
    at: started,
    kind: 'auto-memory',
    provider: 'claude',
    model: cfg.fastModel,
    task: short(prompt, 80),
    ms: (await $.clock.now()) - started,
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    isOk: r.isAnswered,
  })
  if (!r.isAnswered) return
  const match = r.text.match(/\[[\s\S]*\]/)
  if (!match) return
  let facts: unknown
  try {
    facts = JSON.parse(match[0])
  } catch {
    return
  }
  if (!Array.isArray(facts)) return
  for (const fact of facts.slice(0, 3)) {
    if (typeof fact === 'string' && fact.trim().length > 8) {
      await addMemory($, { text: fact, source: 'auto', tags: ['auto'] })
    }
  }
}

// ---- hooks ----

export async function startMemory($: Engine) {
  await $.tool.register({
      name: 'remember',
      isDeferred: false,
      description:
        'Save a durable fact to fable-code memory so future sessions start knowing it. Use for project conventions, decisions, commands, gotchas, and the person\'s preferences. One fact per call, written to stand alone. scope "global" is for facts true across every project.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact, one or two sentences.' },
          scope: { type: 'string', enum: ['project', 'global'], description: 'Default project.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'A few keywords for recall.' },
        },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'recall',
      isDeferred: false,
      description:
        'Search fable-code memory (this project and global) before exploring the codebase or asking the person something they may have said before. Returns matching facts with their ids.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords: a file, feature, command, or topic.' },
          limit: { type: 'number', description: 'Default 8.' },
        },
        required: ['query'],
      },
    })
    await $.tool.register({
      name: 'forget',
      description: 'Delete a fable-code memory by id, when it is wrong or stale. Ids come from recall.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    })
    await $.command.register({ name: 'remember', description: 'Save a fact to fable-code memory', argumentHint: '<fact>' })
    await $.command.register({ name: 'recall', description: 'Search fable-code memory', argumentHint: '<keywords>' })
    await syncState($)
}

export function registerMemory(on: On, cfg: Config) {
  let lastPrompt = ''

  on('tool.call', { tool: 'mcp__fable-code__remember' }, async ($, e) => {
    const text = String(arg(e, 'text') ?? '').trim()
    if (text === '') return { deny: 'remember needs a non-empty text.' }
    const tagsRaw = arg(e, 'tags')
    const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String) : []
    const scope = arg(e, 'scope') === 'global' ? 'global' : 'project'
    const { memory, duplicateOf } = await addMemory($, { text, tags, scope, source: 'model' })
    return {
      result: duplicateOf
        ? `Already remembered as ${duplicateOf.id}: ${duplicateOf.text}`
        : `Saved ${memory?.scope} memory ${memory?.id}.`,
    }
  })

  on('tool.call', { tool: 'mcp__fable-code__recall' }, async ($, e) => {
    const query = String(arg(e, 'query') ?? '')
    const limit = Math.min(30, Math.max(1, Number(arg(e, 'limit') ?? 8) || 8))
    const hits = search(await loadAll($), query, limit)
    await markHits($, hits)
    return {
      result:
        hits.length === 0
          ? `No memories match "${query}".`
          : hits.map(m => `[${m.id}] (${m.scope}${m.tags.length ? `; ${m.tags.join(', ')}` : ''}) ${m.text}`).join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__fable-code__forget' }, async ($, e) => {
    const id = String(arg(e, 'id') ?? '')
    const gone = await forgetMemory($, id)
    return { result: gone ? `Forgot ${id}: ${gone.text}` : `No memory has the id ${id}.` }
  })

  on('command.run', { command: 'remember' }, async ($, e) => {
    const text = String((e as { args?: unknown }).args ?? '').trim()
    if (text === '') return { text: 'Usage: /remember <fact>' }
    const { memory, duplicateOf } = await addMemory($, { text, source: 'person' })
    return { text: duplicateOf ? `Already remembered: ${duplicateOf.text}` : `Remembered (${memory?.id}).` }
  })

  on('command.run', { command: 'recall' }, async ($, e) => {
    const query = String((e as { args?: unknown }).args ?? '')
    const hits = search(await loadAll($), query, 15)
    return {
      text: hits.length === 0 ? 'No memories match.' : hits.map(m => `[${m.id}] ${m.text}`).join('\n'),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true) lastPrompt = e.text
    return next(e)
 }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted || lastPrompt === '') return done

    const prompt = lastPrompt
    const answer = e.answer
    const now = await $.clock.now()
    await addJournal($, { at: now, prompt: short(prompt, 220), outcome: short(answer, 320) })

    // Learn in the background so the next prompt never waits on it.
    if (cfg.autoMemory && answer.length > 400) {
      $.clock.after(50, () => {
        void extractMemories($, cfg, prompt, answer).catch(() => undefined)
      })
    }
    return done
  })
}
