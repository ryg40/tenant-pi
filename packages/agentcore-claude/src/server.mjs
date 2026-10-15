// The stdio MCP server of the AgentCore memory plugin: propose and the
// maintainer review tools. Every tool calls the core. The permission dialog of
// Claude Code shows the tool input and is the human confirmation; the confirm
// callback below only checks that the core is about to write that input.
// Standard output carries the protocol only. Logs are static lines on standard error.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { claudeOrigin, errorCode, killSwitch, loadCoreModule, memoryError, stderrLog } from "./shared.mjs";

export const SERVER_NAME = "agentcore-memory";
export const SERVER_VERSION = "0.1.0";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The `MemoryRecordId` shape of the service model: `mem-` and 36 to 46 more characters. */
const RECORD_ID = /^mem-[A-Za-z0-9_-]{36,46}$/;

const projectId = z.string().regex(ID).describe("A project id of your memory config, for example example-project.");
const memoryRecordId = z.string().regex(RECORD_ID).describe("The id of a proposal record, as memory_list_proposals shows it.");
const reason = z.string().trim().min(1).max(1000);
/**
 * Claude Code shows the permission prompt of a tool with this flag on every call, also in the
 * `acceptEdits`, `auto` and `bypassPermissions` modes; an allow rule does not skip it.
 * Every tool that writes to the store has it.
 */
export const REQUIRES_USER = { "anthropic/requiresUserInteraction": true };

export const TOOLS = {
	memory_propose: {
		title: "Propose a record to the shared project memory",
		description: [
			"Propose one durable fact to the shared AgentCore project memory.",
			"Before you call this tool, show the user the exact text and the target project, and ask the user to confirm.",
			"Call it only after the user says yes. Claude Code then shows a permission dialog with the same input.",
			"The record goes to the proposals namespace of the user for the project. A maintainer of the project reviews it.",
			"Without projectId, the project comes from the working directory. Never put a secret, a key or personal data in the text.",
			"The text has at most 16,000 characters.",
		].join(" "),
		inputSchema: z.object({
			text: z.string().describe("The exact text of the record, as the user confirmed it."),
			projectId: projectId.optional(),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		_meta: REQUIRES_USER,
	},
	memory_list_proposals: {
		title: "List the proposals of a project",
		description: "Maintainer review: list the pending proposals of one project, with text, author and date. Read only.",
		inputSchema: z.object({ projectId }),
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	memory_show_proposal: {
		title: "Show one proposal",
		description: "Maintainer review: show one pending proposal of a project by its record id. Read only.",
		inputSchema: z.object({ projectId, memoryRecordId }),
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	memory_approve: {
		title: "Approve a proposal",
		description: [
			"Maintainer review: approve one proposal of a project.",
			"The core moves the record from the proposals namespace to the shared namespace of the project. Nothing is copied or deleted.",
			"Before you call this tool, show the user the proposal text, the project and the record id, and ask the user to confirm.",
			"Every member's agent recalls an approved record.",
		].join(" "),
		inputSchema: z.object({ projectId, memoryRecordId, reason: reason.optional() }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		_meta: REQUIRES_USER,
	},
	memory_reject: {
		title: "Reject a proposal",
		description: [
			"Maintainer review: reject one proposal of a project. A reason is required; it stays in the private ledger.",
			"The core moves the record to the rejected namespace of its author in the project. Nothing is deleted. Recall never reads a rejected record.",
			"Before you call this tool, show the user the proposal text, the project, the record id and the reason, and ask the user to confirm.",
		].join(" "),
		inputSchema: z.object({ projectId, memoryRecordId, reason }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		_meta: REQUIRES_USER,
	},
};

function same(a, b) {
	return typeof a === "string" && typeof b === "string" && a.trim() === b.trim();
}

/** The confirm callback of propose: true only for the text and the project of the tool input. */
export function confirmPropose(expected) {
	return async (preview) => Boolean(preview) && preview.action === "propose"
		&& preview.projectId === expected.projectId && same(preview.text, expected.text);
}

/** The confirm callback of approve and reject: true only for the action, project, record and reason of the tool input. */
export function confirmReview(action, expected) {
	return async (preview) => Boolean(preview) && preview.action === action
		&& preview.projectId === expected.projectId
		&& preview.proposal?.memoryRecordId === expected.memoryRecordId
		&& (preview.reason === undefined || preview.reason === expected.reason);
}

function ok(value) {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function refused(code) {
	return { content: [{ type: "text", text: code }], isError: true };
}

/**
 * The tool handlers, without the protocol. The tests call them with a fake core.
 * @param {{env?: Record<string, string|undefined>, cwd?: string, loadCore?: () => Promise<any>,
 *   log?: (line: string) => void, origin?: {agent: string, harness: string, session: string}}} deps
 */
export function createHandlers(deps = {}) {
	const env = deps.env ?? process.env;
	const cwd = deps.cwd ?? process.cwd();
	const log = deps.log ?? stderrLog("agentcore-memory mcp");
	const origin = deps.origin ?? claudeOrigin(env);
	let corePromise = null;

	async function core() {
		if (killSwitch(env)) throw memoryError("disabled");
		corePromise ??= (async () => {
			const module = await (deps.loadCore ?? loadCoreModule)();
			const config = module.loadConfig(env);
			if (!config) throw memoryError("config");
			return module.createCore(config, { log });
		})();
		try {
			return await corePromise;
		} catch (error) {
			corePromise = null;
			throw error;
		}
	}

	async function targetProject(core, projectId) {
		if (projectId) return projectId;
		const resolution = await core.resolveProject({ cwd, env });
		if (resolution.projectId) return resolution.projectId;
		throw memoryError(resolution.reason === "env_not_member" ? "not_member" : "project_none");
	}

	const handlers = {
		async memory_propose({ text, projectId }) {
			const memory = await core();
			const target = await targetProject(memory, projectId);
			const result = await memory.propose({ text, projectId: target, origin }, confirmPropose({ text, projectId: target }));
			return { memoryRecordId: result.memoryRecordId, namespace: result.namespace, projectId: target };
		},
		async memory_list_proposals({ projectId }) {
			return { proposals: await (await core()).listProposals({ projectId }) };
		},
		async memory_show_proposal({ projectId, memoryRecordId }) {
			const proposal = await (await core()).showProposal({ projectId, memoryRecordId });
			if (!proposal) throw memoryError("proposal_missing");
			return proposal;
		},
		async memory_approve({ projectId, memoryRecordId, reason }) {
			const input = { projectId, memoryRecordId, reason, reviewer: origin };
			return (await core()).approve(input, confirmReview("approve", input));
		},
		async memory_reject({ projectId, memoryRecordId, reason }) {
			if (typeof reason !== "string" || !reason.trim()) throw memoryError("not_confirmed");
			const input = { projectId, memoryRecordId, reason, reviewer: origin };
			return (await core()).reject(input, confirmReview("reject", input));
		},
	};

	async function call(name, args) {
		try {
			return ok(await handlers[name](args));
		} catch (error) {
			const code = errorCode(error);
			log(`${name} refused (${code})`);
			return refused(code);
		}
	}

	async function close() {
		const pending = corePromise;
		corePromise = null;
		if (pending) await pending.then((memory) => memory.close()).catch(() => {});
	}

	return { call, close };
}

/** One MCP server with the five tools. */
export function createMemoryServer(deps = {}) {
	const handlers = createHandlers(deps);
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
	for (const [name, tool] of Object.entries(TOOLS)) {
		server.registerTool(name, tool, (args) => handlers.call(name, args));
	}
	return { server, close: handlers.close };
}

/** Serve on the stdio of this process until the client closes it. */
export async function startServer(deps = {}) {
	const log = deps.log ?? stderrLog("agentcore-memory mcp");
	const { server, close } = createMemoryServer({ ...deps, log });
	const transport = new StdioServerTransport(deps.stdin, deps.stdout);
	let closing = false;
	const stop = async () => {
		if (closing) return;
		closing = true;
		await close();
		await server.close().catch(() => {});
	};
	transport.onclose = () => { void stop(); };
	await server.connect(transport);
	log("started");
	return { server, stop };
}
