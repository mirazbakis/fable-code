import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { FableStats } from '../types'
import { forgetMemory } from './memory'
import type { Config, Engine } from './shared'
import { EMPTY_STATS, PANE, fmtK, short } from './shared'

// The same session values shared.ts and memory.ts write; each module names the ones it reads.
const statsAtom = atom({ plugin: 'fable-code', key: 'stats' } as const, EMPTY_STATS, { shape: 'stats-1' })
const memoriesAtom = atom({ plugin: 'fable-code', key: 'memories' } as const, [], { shape: 'memories-1' })
const delegationsAtom = atom({ plugin: 'fable-code', key: 'delegations' } as const, [], { shape: 'delegations-1' })
const bandHiddenAtom = atom({ plugin: 'fable-code', key: 'isBandHidden' } as const, false)

const openPane = ($: Engine) => $.ui.open({ id: PANE, title: 'fable-code' })

export async function startUi($: Engine) {
  await $.command.register({ name: 'fable', description: 'Open the fable-code pane: memory, delegations, savings' })
}

export function registerUi(on: On, cfg: Config) {
  on('command.run', { command: 'fable' }, async $ => {
    await update($, bandHiddenAtom, () => false)
    await openPane($)
    const s: FableStats = { ...EMPTY_STATS, ...((await $.store.get('stats:lifetime')) as FableStats | undefined) }
    return {
      text: `fable-code pane opened. Lifetime: ${s.delegations} delegations, ${s.digests} digests, ${s.readsGuarded + s.readsDeduped} reads saved, about ${fmtK(s.tokensSavedEst)} tokens saved.`,
    }
  })

  // ---- the band above the prompt ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.showBand || e.props.hasSurvey || (await read($, bandHiddenAtom))) return next(e)
    const [stats, memories] = await Promise.all([read($, statsAtom), read($, memoriesAtom)])
    const s = stats ?? EMPTY_STATS
    const isQuiet = memories.length === 0 && s.delegations + s.digests + s.readsGuarded + s.readsDeduped === 0
    if (isQuiet) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const bits = [
      `${memories.length} memories`,
      s.delegations + s.digests > 0 ? `${s.delegations + s.digests} delegated` : '',
      s.readsGuarded + s.readsDeduped > 0 ? `${s.readsGuarded + s.readsDeduped} reads saved` : '',
      s.tokensSavedEst > 0 ? `~${fmtK(s.tokensSavedEst)} tokens saved` : '',
    ].filter(Boolean)
    return (
      <Box>
        <Text dimColor>fable-code · {bits.join(' · ')} </Text>
        <Button key="open" plain label="open" onPress={() => void openPane($)} />
        <Text dimColor> </Text>
        <Button key="hide" plain label="hide" onPress={() => update($, bandHiddenAtom, () => true)} />
      </Box>
    )
  })

  // ---- the pane ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [stats, memories, delegations] = await Promise.all([
      read($, statsAtom),
      read($, memoriesAtom),
      read($, delegationsAtom),
    ])
    const s = stats ?? EMPTY_STATS
    const width = Math.max(30, (e.props.bodyColumns ?? 60) - 2)
    const project = [...memories].filter(m => m.scope === 'project').sort((a, b) => b.createdAt - a.createdAt)
    const global = [...memories].filter(m => m.scope === 'global').sort((a, b) => b.createdAt - a.createdAt)
    const recent = [...delegations].reverse().slice(0, 12)
    const provider = cfg.delegateProvider === 'claude' ? `claude/${cfg.fastModel}` : cfg.delegateProvider

    const row = (m: (typeof memories)[number]) => (
      <Box key={`m-${m.id}`}>
        <Button key={`forget-${m.id}`} plain label="✕" onPress={() => void forgetMemory($, m.id)} />
        <Text dimColor={m.source === 'auto'}> {short(m.text, width - 4)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold>This session</Text>
        <Text>
          {s.delegations} delegations · {s.digests} digests · {s.readsGuarded} large reads stopped · {s.readsDeduped} repeat reads skipped
        </Text>
        <Text dimColor>About {fmtK(s.tokensSavedEst)} tokens kept out of the main model (estimate). Delegating to {provider}.</Text>
        <Text> </Text>

        <Text bold>Project memory ({project.length})</Text>
        {project.length === 0 && <Text dimColor>Nothing yet. The model saves facts as it learns them; /remember adds one.</Text>}
        {project.slice(0, 40).map(row)}
        {project.length > 40 && <Text dimColor>…and {project.length - 40} more (/recall to search).</Text>}
        <Text> </Text>

        <Text bold>Global memory ({global.length})</Text>
        {global.length === 0 && <Text dimColor>None.</Text>}
        {global.slice(0, 20).map(row)}
        <Text> </Text>

        <Text bold>Recent delegations</Text>
        {recent.length === 0 && <Text dimColor>None yet.</Text>}
        {recent.map(d => (
          <Text dimColor={!d.isOk}>
            {d.isOk ? '✓' : '✗'} {d.kind} · {d.model} · {(d.ms / 1000).toFixed(1)}s · {fmtK(d.inputTokens)}→{fmtK(d.outputTokens)} · {short(d.task, Math.max(10, width - 40))}
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>Settings: /config, then fable-code. Commands: /remember, /recall.</Text>
      </Box>
    )
  })
}
