#!/usr/bin/env node
// The stdio MCP server `agentcore-memory` of the AgentCore memory plugin.
// Claude Code starts it from `.mcp.json`. Standard output is the protocol only.
import { startServer } from "../src/server.mjs";

const { stop } = await startServer();
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => { void stop().finally(() => process.exit(0)); });
}
process.stdin.on("end", () => { void stop().finally(() => process.exit(0)); });
