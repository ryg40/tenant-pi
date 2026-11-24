#!/usr/bin/env node
import fs from "node:fs";
import { runCompare } from "./compare-cli.js";

const args = process.argv.slice(2);
// --version stays on this computer in each mode, also after --here.
const version = args[0] === "--here" ? args.slice(1) : args;
try {
  if (version.length === 1 && ["--version", "-v"].includes(version[0])) {
    console.log(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } else {
    await runCompare(args);
  }
} catch (error) {
  console.error(error.message || String(error));
  // 2: refused input or an unknown session; 3: remote mode did not reach the host (src/compare-remote.js).
  process.exitCode = [2, 3].includes(error.exitCode) ? error.exitCode : 1;
}
