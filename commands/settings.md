---
description: Show this profile's OptChat settings, or change one
argument-hint: "[key value]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" settings $ARGUMENTS`

The block above is the output of OptChat's `/optchat:settings` command. Show it to the user as it is, without commentary.
