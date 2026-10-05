// Shell entry point for the tenantext doctor: `npm run doctor` checks, `npm run doctor -- --fix` writes the detected settings.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFixes, formatChecks, runChecks } from "../extensions/doctor/checks.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = await runChecks({ repo });
const { applied, failed } = process.argv.includes("--fix") ? applyFixes(checks) : { applied: [], failed: [] };
console.log(formatChecks(checks, applied));
if (failed.length) console.log(`Failed: ${failed.join(", ")}.`);
process.exitCode = checks.some(c => c.status === "fail") || failed.length ? 1 : 0;
