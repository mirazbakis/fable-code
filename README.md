# fable-code

A Claude Code mod that makes agentic coding faster, cheaper and less forgetful, on every Claude model: Fable, Opus, Sonnet and Haiku.

- **Persistent memory.** The model saves durable facts about your project (conventions, commands, decisions, gotchas, your preferences) and every new session starts knowing them. A rolling journal of recent work rides along too.
- **Cheap-model delegation.** Small, self-contained jobs (boilerplate, tests for a function, regexes, fixtures, docstrings, commit messages) go to a fast model: Claude Haiku through your own session, Google Gemini, or any OpenAI-compatible endpoint such as OpenRouter, Ollama or LM Studio.
- **File digests.** Instead of reading a 3,000-line file whole, the model gets a line-numbered summary from the fast model and then reads only the ranges it needs.
- **Fast subagents.** A read-only `scout` on the fast model maps the codebase in parallel, and a `worker` on Sonnet applies mechanical, well-specified edits.
- **Context guards.** Whole-file reads of huge files are stopped with a cheaper route offered, and repeat reads of unchanged files are skipped once.
- **A control pane.** `/fable` shows your memories (forget any with one click), recent delegations with their timing and token counts, and an estimate of the tokens kept out of the main model.

## Install

At the prompt of a terminal session:

```
/plugin install fable-code --marketplace mirazbakis/fable-code
```

From a shell:

```bash
claude plugin install fable-code --marketplace mirazbakis/fable-code
```

In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `mirazbakis/fable-code`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope. The mod is active right away.

## Use

It works on its own once installed. The model sees a short playbook in its system prompt and these tools:

| Tool | What it does |
| --- | --- |
| `remember` | Saves one durable fact, for this project or globally |
| `recall` | Searches memory before exploring or asking |
| `forget` | Deletes a wrong or stale memory |
| `delegate` | Sends a small task, with any project files it needs, to the fast model |
| `digest` | Summarizes a large file with line numbers |

And these agent types: `fable-code:scout` and `fable-code:worker`.

Commands for you:

| Command | What it does |
| --- | --- |
| `/fable` | Opens the pane: memory, delegations, savings |
| `/remember <fact>` | Saves a fact yourself |
| `/recall <keywords>` | Searches memory |

## Configure

Open `/config` and find the fable-code rows.

| Setting | Default | Meaning |
| --- | --- | --- |
| Delegation provider | `claude` | `claude`, `gemini` or `openai-compatible` |
| Fast Claude model | `haiku` | Used for delegation on `claude`, for automatic memory, the scout, and as the fallback |
| Gemini API key | empty | Kept in secure storage |
| Gemini model | `gemini-2.5-flash` | |
| OpenAI-compatible base URL | `http://localhost:11434/v1` | A local Ollama server by default |
| OpenAI-compatible API key | empty | Kept in secure storage; leave empty for a local server |
| OpenAI-compatible model | `qwen2.5-coder:7b` | |
| Automatic memory | on | After substantial turns, the fast model picks out up to three facts worth keeping |
| Large read guard (KB) | `120` | `0` turns it off |
| Skip repeated reads | on | |
| Show the status band | on | |

If the chosen provider fails or has no key, the fast Claude model answers instead and the result says so.

## Privacy

- Memory and the journal are stored locally in Claude Code's plugin store on your machine.
- `delegate` and `digest` send the files and text you or the model pass them to the provider you chose. With `claude` that is your own Claude session. With `gemini` or `openai-compatible` it is that third party.
- Only files inside the session's project are sent. Files that look like secrets (`.env`, keys, certificates, credential files) are always refused.
- Automatic memory always uses the fast Claude model, never a third party.

## How it works

fable-code is a Claude Code mod: one TypeScript hooks module the engine loads, with no build step and no dependencies.

| File | Part |
| --- | --- |
| `hooks/memory.ts` | Memory store, search, journal, automatic extraction, memory tools and commands |
| `hooks/delegate.ts` | Providers, the `delegate` and `digest` tools, the subagent types |
| `hooks/guards.ts` | Large-read and repeat-read guards |
| `hooks/playbook.ts` | The system prompt section with the playbook, memories and recent work |
| `hooks/ui.tsx` | The band above the prompt, the pane and `/fable` |
| `hooks/register.tsx` | Wires the parts together |

The playbook is added as a session-scoped system prompt section, so it never breaks the shared prompt cache. Memories saved mid-session reach the prompt at the next new conversation or compaction, and the model already has them in context until then.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
claude --plugin-dir .
```

## License

MIT
