import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { FableDelegation, FableStats } from '../types'

export const PLUGIN = 'fable-code'
export const PANE = 'fable-code'
export const TOOL = (name: string) => `mcp__${PLUGIN}__${name}`

export type Engine = EngineInterface

/** The userConfig values, typed, with defaults for anything unset. */
export type Config = {
  delegateProvider: 'claude' | 'gemini' | 'openai-compatible'
  fastModel: string
  geminiApiKey: string
  geminiModel: string
  openaiBaseUrl: string
  openaiApiKey: string
  openaiModel: string
  autoMemory: boolean
  readGuardKb: number
  dedupeReads: boolean
  showBand: boolean
}

const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export function readConfig(options: PluginOptions | undefined): Config {
  const o = options ?? {}
  const provider = str(o.delegateProvider, 'claude')

  return {
    delegateProvider:
      provider === 'gemini' || provider === 'openai-compatible' ? provider : 'claude',
    fastModel: str(o.fastModel, 'haiku'),
    geminiApiKey: str(o.geminiApiKey, ''),
    geminiModel: str(o.geminiModel, 'gemini-2.5-flash'),
    openaiBaseUrl: str(o.openaiBaseUrl, 'http://localhost:11434/v1').replace(/\/+$/, ''),
    openaiApiKey: str(o.openaiApiKey, ''),
    openaiModel: str(o.openaiModel, 'qwen2.5-coder:7b'),
    autoMemory: bool(o.autoMemory, true),
    readGuardKb: Math.max(0, num(o.readGuardKb, 120)),
    dedupeReads: bool(o.dedupeReads, true),
    showBand: bool(o.showBand, true),
  }
}

// ---- session state (survives hot reloads; drawn by the band and the pane) ----

export const EMPTY_STATS: FableStats = {
  readsGuarded: 0,
  readsDeduped: 0,
  delegations: 0,
  digests: 0,
  memoriesSaved: 0,
  tokensSavedEst: 0,
}

const statsAtom = atom({ plugin: 'fable-code', key: 'stats' } as const, EMPTY_STATS, {
  shape: 'stats-1',
})
const delegationsAtom = atom({ plugin: 'fable-code', key: 'delegations' } as const, [], {
  shape: 'delegations-1',
})

export async function bump($: Engine, change: Partial<FableStats>) {
  await update($, statsAtom, s => {
    const next: FableStats = { ...EMPTY_STATS, ...(s ?? {}) }
    for (const [k, v] of Object.entries(change) as [keyof FableStats, number][]) {
      next[k] = Math.round((next[k] ?? 0) + v)
    }
    return next
  })

  // Lifetime totals, kept across sessions.
  const life = { ...EMPTY_STATS, ...((await $.store.get('stats:lifetime')) as FableStats | undefined) }
  for (const [k, v] of Object.entries(change) as [keyof FableStats, number][]) {
    life[k] = Math.round((life[k] ?? 0) + v)
  }
  await $.store.set('stats:lifetime', life)
}

export async function logDelegation($: Engine, d: FableDelegation) {
  await update($, delegationsAtom, list => [...(list ?? []), d].slice(-40))
}

// ---- small helpers ----

/** A tool argument from a plugin tool's loose input. */
export function arg(e: unknown, name: string): unknown {
  const rec = e as Record<string, unknown>
  if (rec[name] !== undefined) return rec[name]
  const input = rec.input as Record<string, unknown> | undefined
  return input?.[name]
}

export const estTokens = (chars: number) => Math.round(chars / 4)

export const short = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`)

export function newId(now: number) {
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `${now.toString(36).slice(-5)}${rand}`
}

/** Files never read into a delegation or digest, whatever the provider. */
const SECRET_FILE =
  /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keychain|mobileprovision|p8)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i

/**
 * Resolves a path the model named and keeps it inside the session's project.
 * Answers the real path, or a reason it is refused.
 */
export async function placeInProject($: Engine, path: string): Promise<{ real: string } | { refused: string }> {
  if (SECRET_FILE.test(path)) return { refused: `${path} looks like a secrets file and is never sent to a model.` }
  const rootStat = await $.fs.stat(await $.session.root(), { resolve: true }).catch(() => undefined)
  const root = rootStat?.realPath
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath
  if (root === undefined || real === undefined) return { refused: `${path} was not found.` }
  const sep = root.includes('\\') ? '\\' : '/'
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return { refused: `${path} is outside the project, so it stays out of delegated work.` }
  }
  if (SECRET_FILE.test(real)) return { refused: `${path} looks like a secrets file and is never sent to a model.` }
  if (stat?.kind !== 'file') return { refused: `${path} is not a file.` }
  return { real }
}
