---
description: Show this profile's AGENTS.md instructions
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" instructions $ARGUMENTS`

The block above is the output of OptChat's `/optchat:instructions` command. Show it to the user as it is, without commentary.
Then offer to edit the AGENTS.md file it names; change it only with the user's words.
