// The shell command rules of the kit, shared by the Pi extension
// extensions/command-rules and the Claude Code hook pre-tool-use.mjs.
// A rule key is a glob: "*" matches any text. A key applies to each simple
// command of a command line, from its first word.

export const COMMAND_RULES = {
	"find / *": {
		action: "deny",
		reason: "Use rg instead of find",
	},
};

/** The simple commands of a command line, split outside quotes at ; & | and line ends. */
export function splitCommands(line) {
	const parts = [];
	let part = "";
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "\\" && quote !== "'") {
			part += c + (line[++i] ?? "");
		} else if (quote) {
			if (c === quote) quote = "";
			part += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			part += c;
		} else if (";&|\n".includes(c)) {
			parts.push(part);
			part = "";
		} else {
			part += c;
		}
	}
	parts.push(part);
	return parts.map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean);
}

function globToRegExp(glob) {
	const body = glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${body}$`, "s");
}

/** The reason of the first deny rule that a command line matches, else undefined. */
export function denyReason(line, rules = COMMAND_RULES) {
	const commands = splitCommands(line);
	for (const [glob, rule] of Object.entries(rules)) {
		if (rule.action !== "deny") continue;
		const pattern = globToRegExp(glob);
		if (commands.some((command) => pattern.test(command))) return rule.reason;
	}
	return undefined;
}
