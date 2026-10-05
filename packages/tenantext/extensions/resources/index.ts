import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBCOMMANDS, runResources } from "./menu.ts";

/** `/resources`: list Pi extensions, MCP servers, skills and prompts, set each one on or off, and keep profiles. */
export default function resources(pi: ExtensionAPI) {
	pi.registerCommand("resources", {
		description: "Turn Pi extensions, MCP servers, skills and prompt templates on or off, and save or apply profiles",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c }));
			return items.length ? items : null;
		},
		// Project scope is shown and never written.
		handler: (args, ctx) => runResources(args, ctx, { dirs: { agentDir: getAgentDir(), projectDir: join(ctx.cwd, CONFIG_DIR_NAME) }, writeProject: false }),
	});
}
