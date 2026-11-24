#!/usr/bin/env node
import fs from "node:fs";
import { runCompare } from "./compare-cli.js";
import { retiredLine } from "./retired.js";
import { installSkills } from "./setup.js";

// The command `walkr`: the setup of the skills and the compatibility form `walkr compare`. The Core commands of
// this name (open, poll, status, connect, disconnect, claim-wake) are retired.
const version = () => JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `Walkr ${version()}

Walkr keeps one mode: Compare. Core, Double, Coinflip, Trainer and the shared GUI are retired (CHANGELOG.md).

  walkr compare ...         The same as walkr-compare ... (walkr-compare --help)
  walkr setup               Install the two Walkr skills and the project Pi prompts
  walkr setup --global      Install the skills for your user; Pi prompts need the explicit API
  walkr --version           Print the version

Setup removes the skills and the prompts of the retired modes that an earlier setup wrote and that are unchanged.
For a dry run and an explicit Pi profile, use installSkills in src/setup.js; see docs/modes.md.
Everything runs on this computer, or with the key remote of the artifacts config file on that SSH host
(walkr-compare --help). No account, no cloud, no database.
`;

const argv = process.argv.slice(2);
try {
  if (argv.length === 0 || ["--help", "-h", "help"].includes(argv[0])
      || argv[0] === "setup" && argv.slice(1).some((arg) => ["--help", "-h", "help"].includes(arg))) {
    process.stdout.write(HELP);
  } else if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(version());
  } else if (argv[0] === "compare") {
    await runCompare(argv.slice(1));
  } else if (argv[0] === "setup") {
    const isGlobal = argv.includes("--global") || argv.includes("-g");
    installSkills(process.cwd(), { global: isGlobal }).forEach((line) => console.log(line));
  } else {
    // A file, a URL or a Core command of an older version: the Core review is retired.
    console.error(retiredLine("The Core review of walkr"));
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = [2, 3].includes(error.exitCode) ? error.exitCode : 1;
}
