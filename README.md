# omp-claude-view

Claude Code's look for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`).

VIDEO_URL

The plugin only changes how omp draws things. Sessions, models, tools and the context sent to the model stay the same. Press `Ctrl+O` to see omp's full tool cards.

## Install

```sh
omp plugin install omp-claude-view
```

or straight from GitHub:

```sh
omp plugin install github:Galkurta/omp-claude-view
```

Restart omp. To turn it off: `omp plugin disable omp-claude-view`.

Requires omp (tested on v18.19). The plugin uses omp's own extension API and components, so it does not load in upstream `pi`.

## What changes

**Transcript**
- Tool calls as `● Tool(arg)` with the result under `⎿  …`, paths relative to the working folder.
- Consecutive reads and searches fold into one line: `Read 2 files, searched for 1 pattern (ctrl+o to expand)`.
- Edits show a red/green diff with the changed words highlighted. Writes show the first 10 lines.
- Failed commands read `Error: Exit code N` with the output below. Denied or interrupted calls read `Interrupted · What should omp do instead?`.
- Agents: `Initializing…`, the last 3 sub-tool calls, then `Done (N tool uses · 12.3k tokens · 8s)`. Parallel agents form one tree (`Running 3 Scout agents…`). Background agents read `Backgrounded agent` / `3 background agents launched`.
- `!command` shows as `! command` with its output below.
- Your prompt is one tinted `❯ text` row. Replies start with `●`; thinking collapses to `✻ Thinking…`.

**Prompt and footer**
- The prompt sits between two rules at the bottom of the screen, with a dim `Try "…"` placeholder.
- A paste collapses to `[Pasted text #1 +16 lines]` inline (images: `[Image #1]`) instead of a card strip.
- The spinner is `✻ Verb… (12s · ↓ 1.2k tokens)` with Claude Code's verbs, and each turn ends with `✻ Worked for 12s`.
- The footer shows folder, model, effort and context, plus the permission mode line: `⏵⏵ bypass permissions on` (yolo), `⏵⏵ accept edits on` (write) or `⏸ plan mode on`. It updates as soon as the approval mode changes.

**Dialogs and screens**
- Permission dialog: `Bash command`, the command, `Do you want to proceed?`, `❯ 1. Yes`. The waiting tool row reads `Waiting for permission…`.
- `/settings` opens a Claude Code-style config screen (Status, Config, Usage, Stats) with search; omp's own settings screen stays one keypress away.

## Colors follow your Claude Code theme

The plugin ships `claude-dark` and `claude-light` themes with Claude Code's colors. If your Claude Code uses a custom theme (`"theme": "custom:<name>"` in `~/.claude/settings.json`, defined in `~/.claude/themes/<name>.json`), its overrides are applied as well. That includes accent, prompt rules, message background, diff colors, error/success/warning and the menu highlight. Restart omp after you change the Claude Code theme.

`CLAUDE_CONFIG_DIR` is honored when set.

## Settings it sets

At runtime only (nothing is written to your config): the two themes, the composer shape, a custom status line, hidden thinking blocks, and transcript presenters. Turning the plugin off restores your own settings.

## License

MIT
