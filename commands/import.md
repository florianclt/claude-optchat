---
description: Import history from Claude Code, its memories, Codex, Pi / OMP, or a ChatGPT export into this profile
argument-hint: "[scan|plan|start|status|pause|resume|discard] [--source claude|claude-memory|codex|pi|chatgpt] [--path P] [--project P] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--mode append|rebuild]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" import $ARGUMENTS`

The block above is the output of OptChat's `/optchat:import` command. Show it to the user as it is, without commentary.
Then guide the import, one step at a time, running each step as `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" import <step> <flags>` with the Bash tool:
1. With no source chosen yet, ask which source to import (Claude Code, Claude Code memories, Codex, Pi / OMP, or a ChatGPT export with its path), then run `scan --source <source>`.
2. Ask which of the listed projects to import (any number of `--project` flags, or all), and whether to limit by start date (`--after`, `--before`). If the profile already has messages, ask whether to append (default) or `--mode rebuild`.
3. Run `plan` with those flags and show the preview. Run `start` with the same flags only once the user confirms.
4. The import runs in the background; `status` follows it, `pause`, `resume` and `discard` manage it.
