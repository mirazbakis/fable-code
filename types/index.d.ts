export type FableScope = 'project' | 'global'

export type FableMemory = {
  id: string
  text: string
  tags: string[]
  scope: FableScope
  source: 'model' | 'person' | 'auto'
  createdAt: number
  hits: number
}

export type FableStats = {
  readsGuarded: number
  readsDeduped: number
  delegations: number
  digests: number
  memoriesSaved: number
  tokensSavedEst: number
}

export type FableDelegation = {
  at: number
  kind: 'delegate' | 'digest' | 'auto-memory'
  provider: string
  model: string
  task: string
  ms: number
  inputTokens: number
  outputTokens: number
  isOk: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'fable-code': {
      stats: Shaped<FableStats>
      memories: Shaped<FableMemory[]>
      delegations: Shaped<FableDelegation[]>
      isBandHidden: boolean
    }
  }
}
