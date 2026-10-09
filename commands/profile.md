---
description: List OptChat profiles, or switch to (creating if needed) a profile, or turn OptChat off for this session
argument-hint: "[name|off]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" profile $ARGUMENTS`

The block above is the output of OptChat's `/optchat:profile` command. Show it to the user as it is, without commentary.
