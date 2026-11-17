// The shell command rules of the kit, shared by the Pi extension
// extensions/command-rules and the Claude Code hook pre-tool-use.mjs.
// A rule key is a glob: "*" matches any text. A key applies to each simple
// command of a command line, from its first word. A rule's optional match
// (a RegExp, or an object with the same test() method) replaces its glob.

const word = String.raw`(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+`;
const assignment = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:${word})?\s+`;
// Consume operands only for options that take one, never an arbitrary command word.
const sudoOperand = String.raw`(?:-[aCDghpRrTtuU]|--(?:auth-type|chdir|close-from|group|host|prompt|chroot|role|command-timeout|type|user|other-user))`;
const envOperand = String.raw`(?:-[uC]|--(?:unset|chdir))`;
const options = (operand) => String.raw`(?:${assignment}|${operand}\s+${word}\s+|(?!(?:${operand}|--)(?:\s|$))-[^\s"']*\s+)*(?:--\s+(?:${assignment})*)?`;
const prefix = String.raw`^(?:${assignment})*(?:sudo\s+${options(sudoOperand)}|env\s+${options(envOperand)})?(?![A-Za-z_][A-Za-z0-9_]*=)(?:[^\s"']*/)?`;
const approvalCommand = new RegExp(String.raw`${prefix}credsync\s+allow(?:\s|$)`);

/**
 * The shell words of one simple command: quotes and backslashes are removed, as the shell does. A backslash-newline
 * outside single quotes joins the lines, as the shell does. It is not a full shell parser: it expands no variable
 * and reads no command substitution.
 */
export function shellWords(command) {
	const words = [];
	let word = "";
	let open = false;
	let quote = "";
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = "";
			else word += c;
		} else if (quote === '"') {
			if (c === '"') quote = "";
			else if (c === "\\" && command[i + 1] === "\n") i++;
			else if (c === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) word += command[++i];
			else word += c;
		} else if (c === "\\" && command[i + 1] === "\n") {
			i++;
		} else if (c === "\\") {
			word += command[++i] ?? "";
			open = true;
		} else if (c === "'" || c === '"') {
			quote = c;
			open = true;
		} else if (/\s/.test(c)) {
			if (open) words.push(word);
			word = "";
			open = false;
		} else {
			word += c;
			open = true;
		}
	}
	if (open) words.push(word);
	return words;
}

const assignmentWord = /^[A-Za-z_][A-Za-z0-9_]*=/;
const sudoOperands = new Set(["-a", "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-u", "-U", "--auth-type", "--chdir",
	"--close-from", "--group", "--host", "--prompt", "--chroot", "--role", "--command-timeout", "--type", "--user", "--other-user"]);
const envOperands = new Set(["-u", "-C", "--unset", "--chdir"]);
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// The bounds of the parse: the prefixes of a command, the options before a service or an operation, the words
// of a shell before its script, and the shells inside shells.
const MAX_PREFIXES = 3;
const MAX_OPTIONS = 12;
const MAX_SHELL_WORDS = 16;
const MAX_DEPTH = 3;
const baseName = (word) => word.slice(word.lastIndexOf("/") + 1);

/** The words of the command after its assignments and its sudo or env prefixes with their options. */
function commandWords(words) {
	let i = 0;
	for (let prefixes = 0; prefixes <= MAX_PREFIXES; prefixes++) {
		while (i < words.length && assignmentWord.test(words[i])) i++;
		const name = baseName(words[i] ?? "");
		if (prefixes === MAX_PREFIXES || (name !== "sudo" && name !== "env")) break;
		const operands = name === "sudo" ? sudoOperands : envOperands;
		for (i++; i < words.length; i++) {
			const word = words[i];
			if (word === "--") {
				i++;
				break;
			}
			if (operands.has(word)) i++;
			else if (!word.startsWith("-") && !(name === "env" && assignmentWord.test(word))) break;
		}
	}
	return words.slice(i);
}

/**
 * The index of the first word from `start` that `wanted` accepts after a run of at most MAX_OPTIONS options, else
 * -1. Each option can take one operand: a word that is not an option stands only right after an option.
 */
function afterOptions(words, start, wanted) {
	let options = 0;
	for (let j = start; j < words.length; j++) {
		if (wanted(words[j])) return j;
		if (words[j].startsWith("-")) {
			if (++options > MAX_OPTIONS) return -1;
		} else if (j === start || !words[j - 1].startsWith("-")) {
			return -1;
		}
	}
	return -1;
}

/** The script of `sh -c SCRIPT` (also bash, zsh, dash, ksh and joined flags such as -lc), else undefined. */
function shellScript(words) {
	let script = false;
	for (let i = 1; i < words.length && i <= MAX_SHELL_WORDS; i++) {
		const word = words[i];
		if (word === "--") return script ? words[i + 1] : undefined;
		if (/^[-+][oO]$/.test(word)) i++; // -o NAME and +O NAME take an operand
		else if (/^-[A-Za-z]+$/.test(word)) script ||= word.includes("c");
		else if (!/^(?:\+[A-Za-z]+|--[A-Za-z-]+)$/.test(word)) return script ? word : undefined;
	}
	return undefined;
}

/** True when the command reads a Secrets Manager secret value with the AWS CLI, directly or in a shell -c script. */
function readsSecretValue(command, depth = 0) {
	const words = commandWords(shellWords(command));
	const name = baseName(words[0] ?? "");
	if (name === "aws") {
		const service = afterOptions(words, 1, (word) => word.toLowerCase() === "secretsmanager");
		return service >= 0 && afterOptions(words, service + 1, (word) => /^(?:batch-)?get-secret-value$/i.test(word)) >= 0;
	}
	if (shells.has(name) && depth < MAX_DEPTH) {
		const script = shellScript(words);
		return script !== undefined && splitCommands(script).some((one) => readsSecretValue(one, depth + 1));
	}
	return false;
}

// A matcher with the test() method of a RegExp, for the rule table.
const secretValueRead = { test: (command) => readsSecretValue(command) };

export const COMMAND_RULES = {
	"find / *": {
		action: "deny",
		reason: "Use rg instead of find",
	},
	"*credsync allow*": {
		match: approvalCommand,
		action: "deny",
		reason: "Only the owner approves credsync projects, in an owner terminal",
	},
	// A bare env or printenv prints every secret of the environment.
	env: {
		action: "deny",
		reason: "Print no secret: read one value with printenv NAME",
	},
	printenv: {
		action: "deny",
		reason: "Print no secret: read one value with printenv NAME",
	},
	// A direct read of a Secrets Manager secret value with the AWS CLI: global options with quoted operands, sudo
	// and env prefixes, and the script of sh -c or bash -c. The rule applies with or without an AWS row of the kit:
	// the table is the same in each profile. The aws-core hook of Claude Code also covers SDK calls.
	"aws secretsmanager get-secret-value *": {
		match: secretValueRead,
		action: "deny",
		reason: "Print no secret: a direct read of a Secrets Manager secret value is denied; see the aws-secrets-manager skill for a reference that resolves at run time",
	},
};

/**
 * The simple commands of a command line, split outside quotes at ; & | and line ends. A backslash-newline outside
 * single quotes joins the lines first, as the shell does. A line end inside quotes stays, so the script of sh -c
 * keeps its own lines and continuations.
 */
export function splitCommands(line) {
	const parts = [];
	let part = "";
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "\\" && quote !== "'" && line[i + 1] === "\n") {
			i++;
		} else if (c === "\\" && quote !== "'") {
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
	return parts.map((p) => p.trim().replace(/[^\S\n]+/g, " ")).filter(Boolean);
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
		const pattern = rule.match ?? globToRegExp(glob);
		if (commands.some((command) => pattern.test(command))) return rule.reason;
	}
	return undefined;
}
