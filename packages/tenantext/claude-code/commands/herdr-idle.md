---
description: Turn the herdr-idle startup check (the handoff assessment at session start) on or off for Pi and Claude Code, or show its state
argument-hint: "[on|off|status]"
allowed-tools: Bash(node:*)
---

Print the block below exactly as it is. Add nothing before or after it.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/herdr-idle.mjs" $ARGUMENTS`
