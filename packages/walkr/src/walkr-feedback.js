#!/usr/bin/env node
import fs from "node:fs";
import { runFeedback } from "./feedback-cli.js";

const args = process.argv.slice(2);
const version = args[0] === "--here" ? args.slice(1) : args;
try {
  if (version.length === 1 && ["--version", "-v"].includes(version[0])) {
    console.log(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } else {
    await runFeedback(args);
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = [2, 3].includes(error.exitCode) ? error.exitCode : 1;
}
