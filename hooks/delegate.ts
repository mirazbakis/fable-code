import type { On } from 'claude-code'

import type { Config, Engine } from './shared'
import { arg, bump, estTokens, logDelegation, placeInProject, short } from './shared'

type Provider = Config['delegateProvider']

type Answer = {
  isOk: boolean
  text: string
  provider: Provider
  model: string
  inputTokens: number
  outputTokens: number
  note?: string
}

const DELEGATE_SYSTEM = `You are a fast, precise assistant doing one delegated subtask for a senior coding agent.
Do exactly the task. Be concise: no preamble, no recap, no offers. Put code in fenced blocks with the language.
When the task is to write or change code, return complete, working code for the parts asked.
If the task cannot be done from what you were given, say what is missing in one line.`

const DIGEST_SYSTEM = `You summarize one source file for a coding agent that will not read it whole.
Output, in this order and as compact markdown:
1. Purpose: one or two sentences.
2. Outline: every top-level type, class, function, constant, or section with its line number (L123) and a few words each.
3. Key details: behaviour, side effects, invariants, and anything surprising, with line numbers.
4. If a focus is given: everything relevant to it, with exact line ranges to read.
Never invent lines. Keep it under about 400 words unless the file is very large.`

// ---- providers ----

async function viaClaude($: Engine, cfg: Config, system: string, prompt: string, maxTokens: number): Promise<Answer> {
  const r = await $.model.complete({ model: cfg.fastModel, system, prompt, maxTokens })
  return {
    isOk: r.isAnswered,
    text: r.isAnswered ? r.text : `The fast model gave no answer (${r.reason}).`,
    provider: 'claude',
    model: cfg.fastModel,
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
  }
}

async function viaGemini($: Engine, cfg: Config, system: string, prompt: string, maxTokens: number): Promise<Answer> {
  const res = await $.http.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.geminiApiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
      }),
    },
  )
  type GeminiReply = {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    error?: { message?: string }
  }
  let body: GeminiReply = {}
  try {
    body = JSON.parse(res.text) as GeminiReply
  } catch {
    /* not JSON */
  }
  const text = (body.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')
  return {
    isOk: res.ok && text !== '',
    text: res.ok && text !== '' ? text : `Gemini answered ${res.status}: ${short(body.error?.message ?? res.text, 200)}`,
    provider: 'gemini',
    model: cfg.geminiModel,
    inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
  }
}

async function viaOpenAI($: Engine, cfg: Config, system: string, prompt: string, maxTokens: number): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.openaiApiKey !== '') headers.authorization = `Bearer ${cfg.openaiApiKey}`
  const res = await $.http.fetch(`${cfg.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.openaiModel,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  })
  type OpenAIReply = {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    error?: { message?: string }
  }
  let body: OpenAIReply = {}
  try {
    body = JSON.parse(res.text) as OpenAIReply
  } catch {
    /* not JSON */
  }
  const text = body.choices?.[0]?.message?.content ?? ''
  return {
    isOk: res.ok && text !== '',
    text: res.ok && text !== '' ? text : `The endpoint answered ${res.status}: ${short(body.error?.message ?? res.text, 200)}`,
    provider: 'openai-compatible',
    model: cfg.openaiModel,
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  }
}

/** Runs on the chosen provider, and falls back to the fast Claude model if that fails. */
async function ask($: Engine, cfg: Config, provider: Provider, system: string, prompt: string, maxTokens: number) {
  if (provider === 'gemini' && cfg.geminiApiKey === '') {
    const a = await viaClaude($, cfg, system, prompt, maxTokens)
    return { ...a, note: 'No Gemini key is set, so the fast Claude model answered.' }
  }
  if (provider === 'claude') return viaClaude($, cfg, system, prompt, maxTokens)

  const attempt = provider === 'gemini' ? viaGemini($, cfg, system, prompt, maxTokens) : viaOpenAI($, cfg, system, prompt, maxTokens)
  const first = await attempt.catch(
    (err: unknown): Answer => ({
      isOk: false,
      text: `Request failed: ${short(String(err), 160)}`,
      provider,
      model: provider === 'gemini' ? cfg.geminiModel : cfg.openaiModel,
      inputTokens: 0,
      outputTokens: 0,
    }),
  )
  if (first.isOk) return first
  const fallback = await viaClaude($, cfg, system, prompt, maxTokens)
  return { ...fallback, note: `${provider} failed (${short(first.text, 140)}), so the fast Claude model answered.` }
}

// ---- file loading ----

const MAX_FILE = 400_000
const MAX_TOTAL = 900_000

const numbered = (text: string) =>
  text
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(5)}  ${line}`)
    .join('\n')

async function loadFiles($: Engine, paths: string[]) {
  const parts: string[] = []
  const notes: string[] = []
  let total = 0
  for (const path of paths.slice(0, 12)) {
    const placed = await placeInProject($, path)
    if ('refused' in placed) {
      notes.push(placed.refused)
      continue
    }
    const text = await $.fs.read(placed.real).catch(() => undefined)
    if (typeof text !== 'string') {
      notes.push(`${path} could not be read as text.`)
      continue
    }
    const cut = text.length > MAX_FILE ? text.slice(0, MAX_FILE) : text
    if (total + cut.length > MAX_TOTAL) {
      notes.push(`${path} was left out: the delegation is already at its size limit.`)
      continue
    }
    total += cut.length
    parts.push(`<file path="${path}"${cut.length < text.length ? ' truncated="true"' : ''}>\n${numbered(cut)}\n</file>`)
  }
  return { block: parts.join('\n\n'), notes, chars: total }
}

// ---- hooks ----

export async function startDelegation($: Engine, cfg: Config) {
    const providers = ['claude', 'gemini', 'openai-compatible']
    await $.tool.register({
      name: 'delegate',
      isDeferred: false,
      description: `Hand a small, self-contained task to a fast, cheap model (${cfg.delegateProvider === 'claude' ? cfg.fastModel : cfg.delegateProvider}) and get its answer back. Good for: boilerplate and scaffolding, unit tests for a given function, regexes, data/fixture generation, docstrings and comments, commit messages, translating or reformatting text, explaining an error, and first drafts you will review. Not for: changes that need the wider codebase, security-sensitive logic, or anything you would not double-check. Pass the files it needs (project paths; secrets files are refused). Several delegate calls can run in parallel.`,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What to produce, with every constraint it needs.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Project files to include, up to 12.' },
          context: { type: 'string', description: 'Extra context: snippets, error text, conventions.' },
          provider: { type: 'string', enum: providers, description: 'Override the configured provider.' },
          maxTokens: { type: 'number', description: 'Reply cap, default 4000.' },
        },
        required: ['task'],
      },
    })
    await $.tool.register({
      name: 'digest',
      isDeferred: false,
      description:
        'Get a compact, line-numbered summary of a large file from a fast model instead of reading it whole: purpose, outline with line numbers, key details, and the exact ranges relevant to an optional focus. Then Read only the ranges you need with offset/limit. Use for files over a few hundred lines you need to understand but not edit wholesale.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'A file in the project.' },
          focus: { type: 'string', description: 'What you are looking for in it.' },
        },
        required: ['path'],
      },
    })

    // Subagent types that run on the fast model. Only tools this build has are named.
    const have = new Set((await $.tool.list()).map(t => t.name))
    const pick = (names: string[]) => names.filter(n => have.has(n))
    await $.agent
      .register({
        name: 'scout',
        description:
          'Fast, cheap read-only explorer on a small model. Use it to locate code, map how a feature is wired, or answer "where/how is X done" questions, then act on its report yourself. Launch several in parallel for independent questions.',
        prompt:
          'You are a read-only code scout. Find what was asked quickly and report back: exact file paths with line numbers, the relevant snippets (short), and how the pieces connect. Never modify files. Use Bash only for read-only commands (rg, ls, find, git log/show/grep, cat with head). Finish with a tight report, no preamble.',
        tools: pick(['Read', 'Grep', 'Glob', 'Bash', 'LS']),
        model: cfg.fastModel,
      })
      .catch(() => undefined)
    await $.agent
      .register({
        name: 'worker',
        description:
          'A mid-tier implementer for well-specified, mechanical edits across files (renames, applying a known pattern, adding tests to a spec, fixing lint). Give it the exact spec and acceptance check; review its diff after.',
        prompt:
          'You implement exactly the specification you are given, nothing more. Make the edits, run the acceptance check named in the task, and report: files changed, the check output, and anything you could not do. Do not refactor beyond the spec.',
        model: 'sonnet',
      })
      .catch(() => undefined)
}

export function registerDelegation(on: On, cfg: Config) {
  on('tool.call', { tool: 'mcp__fable-code__delegate' }, async ($, e) => {
    const task = String(arg(e, 'task') ?? '').trim()
    if (task === '') return { deny: 'delegate needs a task.' }
    const filesRaw = arg(e, 'files')
    const files = Array.isArray(filesRaw) ? filesRaw.map(String) : []
    const context = String(arg(e, 'context') ?? '')
    const want = arg(e, 'provider')
    const provider: Provider = want === 'gemini' || want === 'openai-compatible' || want === 'claude' ? want : cfg.delegateProvider
    const maxTokens = Math.min(32000, Math.max(256, Number(arg(e, 'maxTokens') ?? 4000) || 4000))

    const loaded = await loadFiles($, files)
    const prompt = [
      `<task>\n${task}\n</task>`,
      context ? `<context>\n${context.slice(0, 200_000)}\n</context>` : '',
      loaded.block,
    ]
      .filter(Boolean)
      .join('\n\n')

    const started = await $.clock.now()
    const answer = await ask($, cfg, provider, DELEGATE_SYSTEM, prompt, maxTokens)
    const ms = (await $.clock.now()) - started
    await logDelegation($, {
      at: started,
      kind: 'delegate',
      provider: answer.provider,
      model: answer.model,
      task: short(task, 90),
      ms,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      isOk: answer.isOk,
    })
    // What the main model did not have to read or write itself.
    await bump($, { delegations: 1, tokensSavedEst: answer.isOk ? estTokens(loaded.chars) + answer.outputTokens : 0 })

    const header = [`[${answer.provider}/${answer.model}, ${(ms / 1000).toFixed(1)}s]`, answer.note, ...loaded.notes]
      .filter(Boolean)
      .join(' ')
    return { result: `${header}\n\n${answer.text}\n\n(Delegated output: review it before relying on it.)` }
  })

  on('tool.call', { tool: 'mcp__fable-code__digest' }, async ($, e) => {
    const path = String(arg(e, 'path') ?? '').trim()
    const focus = String(arg(e, 'focus') ?? '').trim()
    if (path === '') return { deny: 'digest needs a path.' }
    const loaded = await loadFiles($, [path])
    if (loaded.block === '') return { deny: loaded.notes.join(' ') || `${path} could not be read.` }

    const started = await $.clock.now()
    const answer = await ask(
      $,
      cfg,
      cfg.delegateProvider,
      DIGEST_SYSTEM,
      `${focus ? `<focus>${focus}</focus>\n\n` : ''}${loaded.block}`,
      3000,
    )
    const ms = (await $.clock.now()) - started
    await logDelegation($, {
      at: started,
      kind: 'digest',
      provider: answer.provider,
      model: answer.model,
      task: short(`${path}${focus ? ` (${focus})` : ''}`, 90),
      ms,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      isOk: answer.isOk,
    })
    if (!answer.isOk) return { deny: `digest failed: ${short(answer.text, 200)}. Read the file in slices instead.` }
    await bump($, { digests: 1, tokensSavedEst: Math.max(0, estTokens(loaded.chars) - estTokens(answer.text.length)) })
    return {
      result: `Digest of ${path} by ${answer.provider}/${answer.model}${answer.note ? ` (${answer.note})` : ''}. Line numbers are the file's own; Read with offset/limit for exact text before editing.\n\n${answer.text}`,
    }
  })
}
