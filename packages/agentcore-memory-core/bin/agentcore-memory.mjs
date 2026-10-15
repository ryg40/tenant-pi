#!/usr/bin/env node
// The review CLI. See `node bin/agentcore-memory.mjs --help`.
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
