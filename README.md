# omp-claude-view

Claude Code's look for pi / [oh-my-pi](https://github.com/can1357/oh-my-pi).

https://github.com/user-attachments/assets/7676a89b-6859-48df-ac08-c51995cb9ff5

The plugin only changes how the TUI draws things. Sessions, models, tools and the context sent to the model stay the same. Press `Ctrl+O` to see the full tool cards.

## Install

```sh
pi install npm:omp-claude-view
```

Restart after installing; remove the package to turn it off.

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
- The `ask` form drops omp's box for Claude Code's question layout: a dim rule, numbered choices (`❯ 1. red`, the chosen one green with `✔`), `Type something.` for free text, and `Enter to select · ↑/↓ to navigate · Esc to cancel`.
- `/settings` opens a Claude Code-style config screen (Status, Config, Usage, Stats) with search; omp's own settings screen stays one keypress away.

## Colors follow your Claude Code theme

The plugin ships `claude-dark` and `claude-light` themes with Claude Code's colors. If your Claude Code uses a custom theme (`"theme": "custom:<name>"` in `~/.claude/settings.json`, defined in `~/.claude/themes/<name>.json`), its overrides are applied as well. That includes accent, prompt rules, message background, diff colors, error/success/warning and the menu highlight. Restart omp after you change the Claude Code theme.

`CLAUDE_CONFIG_DIR` is honored when set.

## Settings it sets

At runtime only (nothing is written to your config): the two themes, the composer shape, a custom status line, hidden thinking blocks, and transcript presenters. Turning the plugin off restores your own settings.

## License

MIT
