#!/usr/bin/env node
// The on-demand memory search for Claude Code (and any shell): one query in, one block of at most
// 1,600 characters out. It works from any folder. Exit 0 also when stores or the decider are down;
// exit 2 only for a wrong call. The options go first; `--` ends them, and the query is the rest.
//   node scripts/search.mjs [--json] [--no-personal-wiki] [--pi-agent-dir <dir>] -- '<query>'
// The error text is fixed: it never repeats an argument, which can hold private text or a key.
import { formatBlock, formatJson, runSearch } from "../src/ondemand.mjs";
import { resolveAgentDir } from "../src/stores-ondemand.mjs";

const USAGE = "usage: search.mjs [--json] [--no-personal-wiki] [--pi-agent-dir <dir> | --pi-agent-dir=<dir>] -- '<query>'";

export function parseArgs(argv) {
	const options = { json: false, personalWiki: true, piAgentDir: "", query: "" };
	const words = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--no-personal-wiki") options.personalWiki = false;
		else if (arg === "--pi-agent-dir" || arg.startsWith("--pi-agent-dir=")) {
			// The equals form takes any path; the two-word form refuses a value that looks like an option.
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[(index += 1)];
			if (!value || (!arg.includes("=") && value.startsWith("--"))) return { error: "--pi-agent-dir needs a folder" };
			options.piAgentDir = value;
		} else if (arg === "--") words.push(...argv.slice(index + 1)), (index = argv.length);
		else if (arg.startsWith("--")) return { error: "unknown option" };
		else words.push(arg);
	}
	options.query = words.join(" ").trim();
	if (!options.query) return { error: "no query" };
	return { options };
}

async function main() {
	const { options, error } = parseArgs(process.argv.slice(2));
	if (error) {
		process.stderr.write(`${error}\n${USAGE}\n`);
		return 2;
	}
	const agentDir = resolveAgentDir({ flag: options.piAgentDir, env: process.env });
	const result = await runSearch({ query: options.query, env: process.env, cwd: process.cwd(), agentDir, personalWiki: options.personalWiki });
	const text = options.json ? JSON.stringify(formatJson(result)) : formatBlock(result);
	await new Promise((resolve) => process.stdout.write(`${text}\n`, resolve));
	return 0;
}

main().then((code) => process.exit(code), () => {
	// A failure outside the stores and the decider: say so and exit 0, so a caller never stops on it.
	process.stdout.write("Memory search: failed.\n", () => process.exit(0));
});
