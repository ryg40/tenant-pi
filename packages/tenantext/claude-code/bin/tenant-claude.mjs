#!/usr/bin/env node
import { claudeExecutable, launchArgs, modeAction, MODE_HELP } from "../scripts/permission-profile.mjs";

const LAUNCHER_HELP = `${MODE_HELP}\nLaunch: tenant-claude launch [Claude arguments...]\nHelp: tenant-claude help\nPermission, settings, session-routing and known native command tokens are reserved, even after --.\nUse ordinary claude for exact command words as values or administration.\nUse separate short flags or full long flags. Single-dash values with attached content are refused.`;

const [action = "mode", ...args] = process.argv.slice(2);
try {
	if (action === "mode") {
		console.log(modeAction(args));
	} else if (action === "launch") {
		const argv = launchArgs(args);
		const executable = claudeExecutable();
		// Replace this process: preserve Claude's terminal, signals and exit status.
		process.execve(executable, [executable, ...argv], process.env);
	} else if ((action === "help" || action === "--help") && !args.length) {
		console.log(LAUNCHER_HELP);
	} else {
		throw new Error(LAUNCHER_HELP);
	}
} catch (error) {
	console.error(error.code ? "Claude launch failed; no alternate mode was attempted." : error.message);
	process.exitCode = 2;
}
