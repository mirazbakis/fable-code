import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/work/app'

/** The engine beneath the plugin: a project root, a file system of sizes, and the session's registrations. */
function world(on: On, files: Record<string, { size: number; mtimeMs: number }> = {}) {
  mock.store(on)
  mock.clock(on, { now: 1_700_000_000_000 })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__fable-code__${(e as { name: string }).name}` } }))
  on('command.register', (_, e) => ({ value: { command: (e as { name: string }).name } }))
  on('agent.register', (_, e) => ({ value: { agent: `fable-code:${(e as { name: string }).name}` } }))
  on('tool.list', () => ({
    value: [
      { name: 'Read', description: 'Read a file', mcp: false },
      { name: 'Bash', description: 'Run a command', mcp: false },
    ],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.stat', (_, e) => {
    const path = (e as { path: string }).path
    if (path === ROOT) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: ROOT } }
    const f = files[path]
    if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { value: { kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: false, realPath: path } }
  })
  on('tool.call', () => ({ result: { type: 'text', file: { content: 'x' } } }))
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const

test('remember then recall finds the fact', async ($, on) => {
  world(on)
  await $.session.start(START)

  const saved = await $.tool.call({
    tool: 'mcp__fable-code__remember',
    text: 'Run the iOS tests with make test-ios, never xcodebuild directly.',
    tags: ['tests', 'ios'],
  })
  expect(String(saved.result)).toMatch(/Saved project memory/)

  const again = await $.tool.call({
    tool: 'mcp__fable-code__remember',
    text: 'Run the iOS tests with make test-ios, never xcodebuild directly!',
  })
  expect(String(again.result)).toMatch(/Already remembered/)

  const found = await $.tool.call({ tool: 'mcp__fable-code__recall', query: 'ios tests' })
  expect(String(found.result)).toMatch(/make test-ios/)

  const none = await $.tool.call({ tool: 'mcp__fable-code__recall', query: 'kubernetes' })
  expect(String(none.result)).toMatch(/No memories match/)
})

test('a whole read of a huge file is stopped, a sliced one goes through', async ($, on) => {
  world(on, { [`${ROOT}/big.json`]: { size: 900 * 1024, mtimeMs: 1 } })
  await $.session.start(START)

  const whole = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/big.json` })
  expect(whole.deny).toMatch(/digest/)

  const slice = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/big.json`, offset: 1, limit: 100 })
  expect(slice.deny).toBeUndefined()
})

test('a repeat read of an unchanged file is skipped once, then allowed', async ($, on) => {
  world(on, { [`${ROOT}/a.ts`]: { size: 2000, mtimeMs: 5 } })
  await $.session.start(START)

  const first = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.ts` })
  expect(first.deny).toBeUndefined()
  const second = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.ts` })
  expect(second.deny).toMatch(/has not changed/)
  const third = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.ts` })
  expect(third.deny).toBeUndefined()
})

test('the pane lists memories on every surface', async ($, on) => {
  world(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__fable-code__remember', text: 'The API base URL lives in Config.swift.' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'fable-code',
      surface,
      component: 'Pane',
      requestId: 'fable-code',
      props: {
        title: 'fable-code',
        isFocused: false,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /Config\.swift/ }))?.text).toMatch(/Config\.swift/)
    expect((await ui.find({ type: 'Text', text: /Project memory \(1\)/ }))?.text).toBe('Project memory (1)')
    await ui.unmount()
  }
})
