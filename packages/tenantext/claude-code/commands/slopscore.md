---
description: slopscore — spend by model, role and tool from pi and Claude Code traces, weighted by model tier
argument-hint: "[--days N] [--pi|--claude] [--cwd PATH] | pr [--base REF] [--no-spend] [--json] [--add-trailers [--yes] [--force]] | okf [--repo PATH] [--json]"
allowed-tools: Bash(node:*)
---

Print the report below exactly as it is. Add nothing before or after it.

!`node --experimental-strip-types --no-warnings "${CLAUDE_PLUGIN_ROOT}/../slopscore/src/cli.ts" $ARGUMENTS`
