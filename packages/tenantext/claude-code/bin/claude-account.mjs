#!/usr/bin/env node
/**
 * claude-account: log in two Claude accounts and switch the live login of Claude Code between them.
 * See packages/tenantext/docs/claude-accounts.md. It prints no token, and no email unless `status --email` asks.
 */
import { AccountError, adopt, login, status, use } from "../scripts/claude-accounts.mjs";

const HELP = `Usage: claude-account <command> [slot]

  adopt <slot>      Save the live Claude login into the slot and mark it active.
  login <slot>      Run "claude auth login" in the slot folder. The live login is not touched.
  use <slot>        Save the live login back to its slot, then make the slot the live login.
  status [--email]  Show the slots, the active one, the plan and the token state.
  help              Show this help.

Slots: 1, 2. A running Claude Code session can keep the old login until it reads the file again.`;

const when = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const [command = "status", ...args] = process.argv.slice(2);
try {
	if (command === "adopt" && args.length === 1) {
		const { slot } = adopt(args[0]);
		console.log(`The live login is saved in slot ${slot}. Slot ${slot} is active.`);
	} else if (command === "login" && args.length === 1) {
		const { slot, status: code } = login(args[0]);
		if (code === 0) console.log(`Slot ${slot} has a login. Switch to it with: claude-account use ${slot}`);
		else { console.error(`claude auth login ended with exit ${code}. Slot ${slot} may have no login.`); process.exitCode = code || 1; }
	} else if (command === "use" && args.length === 1) {
		const { slot, changed } = use(args[0]);
		console.log(changed ? `Slot ${slot} is the live login now. Start a new Claude Code session to use it.` : `Slot ${slot} is already the live login. Its saved copy is up to date.`);
	} else if (command === "status" && (args.length === 0 || (args.length === 1 && args[0] === "--email"))) {
		const report = status({ email: args[0] === "--email" });
		if (!report.store) console.log("No account store. Start with: claude-account adopt 1");
		for (const s of report.slots) {
			const token = s.token === "none" ? "no token" : `token ${s.token}${s.expiresAt ? ` (expires ${when(s.expiresAt)})` : ""}`;
			console.log(`slot ${s.slot}${s.active ? " (active)" : ""}: ${s.login ? `login, plan ${s.plan ?? "unknown"}, ${token}` : "no login"}${s.email ? `, ${s.email}` : ""}`);
		}
		if (!report.liveSaved) console.log("The live login is saved in no slot. Save it with: claude-account adopt <slot>");
	} else if ((command === "help" || command === "--help") && !args.length) {
		console.log(HELP);
	} else {
		console.error(HELP);
		process.exitCode = 2;
	}
} catch (error) {
	console.error(error instanceof AccountError ? error.message : `claude-account failed: ${error?.code ?? "error"}. Nothing more was changed.`);
	process.exitCode = 2;
}
