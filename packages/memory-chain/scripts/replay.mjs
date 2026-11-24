#!/usr/bin/env node
// The replay command of the memory chain (see `src/replay.mjs` and the README, part "The replay"):
//   node packages/memory-chain/scripts/replay.mjs --sample <file> [--out <file>]
import { main } from "../src/replay.mjs";

const code = await main(process.argv.slice(2));
// Wait for standard output to drain before the exit.
process.stdout.write("", () => process.exit(code));
