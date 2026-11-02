import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { denyReason } from "../../claude-code/scripts/command-rules.mjs";

/** Blocks a bash call that matches a deny rule. The Claude Code plugin applies the same rules. */
export default function commandRules(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const reason = denyReason(String(event.input?.command ?? ""));
		return reason ? { block: true, reason } : undefined;
	});
}
