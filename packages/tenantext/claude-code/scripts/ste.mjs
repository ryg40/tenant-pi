#!/usr/bin/env node
// Backs the /ste command. Prints Markdown for the model to relay verbatim.
import { RULES_BLOCK, RULES_VERSION, estimateTokensFromText } from "./rules.mjs";
import { lastInjectionPath, loadSettings, readJson, saveSettings, settingsPath } from "./settings.mjs";

const [cmd = "status"] = process.argv.slice(2);
const settings = loadSettings();

function status() {
	const last = readJson(lastInjectionPath());
	const lines = [
		"| Item | Value |",
		"| --- | --- |",
		`| rules default | ${settings.rules ? "on" : "off"} |`,
		`| rule block | v${RULES_VERSION}, ~${estimateTokensFromText(RULES_BLOCK)} tokens, injected once per session and after /clear, resume, compaction |`,
		`| last hook run | ${last ? `${last.at}, source ${last.source}, ${last.injected ? "injected" : "skipped"}` : "none recorded"} |`,
		`| settings file | \`${settingsPath()}\` |`,
		"",
		"Context size by source: run the built-in `/context`. Cost: `/cost`.",
	];
	return lines.join("\n");
}

const HELP = [
	"| Command | Effect |",
	"| --- | --- |",
	"| /ste | Status |",
	"| /ste on, /ste off | Default for new sessions and for the next resume, /clear or compaction |",
	"| /ste rules | Print the rule block |",
	"| /ste help | This table |",
	"",
	"Rules already injected in this session stay in context until /clear.",
].join("\n");

switch (cmd) {
	case "status":
		console.log(status());
		break;
	case "on":
	case "off":
		saveSettings({ ...settings, rules: cmd === "on" });
		console.log(`tenantext rules default set to ${cmd}. Takes effect at the next session start, resume, /clear or compaction.`);
		break;
	case "rules":
		console.log(RULES_BLOCK);
		break;
	default:
		console.log(HELP);
}
