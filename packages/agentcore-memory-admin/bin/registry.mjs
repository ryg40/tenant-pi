#!/usr/bin/env node
// The registry script of the shared AgentCore Memory. See ../README.md.
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
