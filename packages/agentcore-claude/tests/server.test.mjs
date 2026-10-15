import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHandlers, REQUIRES_USER, TOOLS } from "../src/server.mjs";
import { CORE_URL } from "../src/shared.mjs";
import { CONFIG, CREATED_ID, PROPOSAL_ID, fakeCoreModule } from "./fake-core.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
const origin = { agent: "claude-code", harness: "claude-code", session: "session-example" };
const TOOL_NAMES = ["memory_propose", "memory_list_proposals", "memory_show_proposal", "memory_approve", "memory_reject"];

/** A JSON-RPC client over the stdio of a spawned server. */
function startClient(t, mode = "ok") {
	const child = spawn(process.execPath, [fixture, mode], {
		env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: "session-example" }, stdio: ["pipe", "pipe", "pipe"],
	});
	const stdout = [];
	let stderr = "";
	const waiting = new Map();
	createInterface({ input: child.stdout }).on("line", (line) => {
		stdout.push(line);
		const message = JSON.parse(line);
		waiting.get(message.id)?.(message);
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	t.after(() => child.kill());
	let next = 1;
	return {
		request(method, params) {
			const id = next++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 5000);
				waiting.set(id, (message) => {
					clearTimeout(timer);
					resolve(message);
				});
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			});
		},
		notify(method) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
		},
		async close() {
			const exit = new Promise((resolve) => child.on("exit", resolve));
			child.stdin.end();
			return exit;
		},
		stdout,
		stderr: () => stderr,
	};
}

async function initialize(client) {
	const answer = await client.request("initialize", {
		protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0.0.0" },
	});
	client.notify("notifications/initialized");
	return answer;
}

function text(result) {
	return result.content.map((item) => item.text).join("");
}

test("initialize and tools/list over stdio show the five tools", async (t) => {
	const client = startClient(t);
	const init = await initialize(client);
	assert.equal(init.result.serverInfo.name, "agentcore-memory");
	assert.ok(init.result.capabilities.tools);
	const list = await client.request("tools/list", {});
	const tools = list.result.tools;
	assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
	const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	assert.deepEqual(byName.memory_propose.inputSchema.required, ["text"]);
	assert.deepEqual(Object.keys(byName.memory_propose.inputSchema.properties).sort(), ["projectId", "text"]);
	assert.deepEqual(byName.memory_reject.inputSchema.required.sort(), ["actorId", "memoryRecordId", "projectId", "reason"]);
	assert.deepEqual(byName.memory_approve.inputSchema.required.sort(), ["actorId", "memoryRecordId", "projectId"]);
	assert.deepEqual(byName.memory_list_proposals.inputSchema.required.sort(), ["actorId", "projectId"]);
	assert.deepEqual(byName.memory_show_proposal.inputSchema.required.sort(), ["actorId", "memoryRecordId", "projectId"]);
	assert.match(byName.memory_propose.description, /show the user the exact text and the target project/);
	for (const name of ["memory_approve", "memory_reject"]) {
		assert.match(byName[name].description, /moves the record/, name);
		assert.match(byName[name].description, /Nothing is (copied or )?deleted/, name);
	}
	for (const name of ["memory_propose", "memory_approve", "memory_reject"]) {
		assert.equal(byName[name]._meta?.["anthropic/requiresUserInteraction"], true, name);
	}
	for (const name of ["memory_list_proposals", "memory_show_proposal"]) {
		assert.equal(byName[name]._meta?.["anthropic/requiresUserInteraction"], undefined, name);
	}
	assert.equal(await client.close(), 0);
	for (const line of client.stdout) assert.equal(JSON.parse(line).jsonrpc, "2.0");
	assert.equal(client.stderr(), "agentcore-memory mcp: started\n");
});

test("memory_propose over stdio returns the record id", async (t) => {
	const client = startClient(t);
	await initialize(client);
	const answer = await client.request("tools/call", {
		name: "memory_propose", arguments: { text: "The example project uses Node 24.", projectId: "example-project" },
	});
	assert.equal(answer.result.isError, undefined);
	assert.deepEqual(JSON.parse(text(answer.result)), {
		memoryRecordId: CREATED_ID, namespace: "/project/example-project/proposals/chen/", projectId: "example-project",
	});
	const resolved = await client.request("tools/call", { name: "memory_propose", arguments: { text: "A fact without a project." } });
	assert.equal(JSON.parse(text(resolved.result)).projectId, "example-project");
	await client.close();
});

test("memory_reject without a reason is refused over stdio", async (t) => {
	const client = startClient(t);
	await initialize(client);
	const target = { projectId: "example-site", actorId: "bruno", memoryRecordId: PROPOSAL_ID };
	for (const args of [target, { ...target, reason: "   " }]) {
		const answer = await client.request("tools/call", { name: "memory_reject", arguments: args });
		assert.equal(answer.result?.isError ?? Boolean(answer.error), true, JSON.stringify(args));
	}
	const done = await client.request("tools/call", {
		name: "memory_reject", arguments: { ...target, reason: "duplicate of an existing record" },
	});
	assert.deepEqual(JSON.parse(text(done.result)), { memoryRecordId: PROPOSAL_ID,
		sourceNamespace: "/project/example-site/proposals/bruno/", targetNamespace: "/project/example-site/rejected/bruno/" });
	await client.close();
});

test("the review tools without the proposer are refused over stdio before the core", async (t) => {
	const client = startClient(t);
	await initialize(client);
	const calls = [
		["memory_list_proposals", { projectId: "example-site" }],
		["memory_show_proposal", { projectId: "example-site", memoryRecordId: PROPOSAL_ID }],
		["memory_approve", { projectId: "example-site", memoryRecordId: PROPOSAL_ID }],
		["memory_reject", { projectId: "example-site", memoryRecordId: PROPOSAL_ID, reason: "duplicate" }],
		["memory_show_proposal", { projectId: "example-site", actorId: "Bruno", memoryRecordId: PROPOSAL_ID }],
	];
	for (const [name, args] of calls) {
		const answer = await client.request("tools/call", { name, arguments: args });
		assert.equal(answer.result?.isError ?? Boolean(answer.error), true, `${name} ${JSON.stringify(args)}`);
	}
	const shown = await client.request("tools/call", {
		name: "memory_show_proposal", arguments: { projectId: "example-site", actorId: "bruno", memoryRecordId: PROPOSAL_ID },
	});
	assert.equal(JSON.parse(text(shown.result)).namespace, "/project/example-site/proposals/bruno/");
	await client.close();
	assert.doesNotMatch(client.stderr(), /refused/);
});

test("a core error over stdio gives the static code only", async (t) => {
	const client = startClient(t, "throw");
	await initialize(client);
	const answer = await client.request("tools/call", { name: "memory_propose", arguments: { text: "CANARY-input-text" } });
	assert.equal(answer.result.isError, true);
	assert.equal(text(answer.result), "failed");
	await client.close();
	assert.doesNotMatch(client.stdout.join("\n"), /CANARY-server-text/);
	assert.doesNotMatch(client.stderr(), /CANARY/);
	assert.match(client.stderr(), /^agentcore-memory mcp: memory_propose refused \(failed\)$/m);
});

function handlers(options = {}, env = {}) {
	const logs = [];
	const module = fakeCoreModule(options);
	const h = createHandlers({ env, cwd: "/tmp/example-project", loadCore: async () => module, log: (line) => logs.push(line), origin });
	return { h, module, logs };
}

test("propose sends the origin of Claude Code and confirms the tool input only", async () => {
	const { h, module } = handlers();
	const ok = await h.call("memory_propose", { text: "A durable fact.", projectId: "example-site" });
	assert.equal(ok.isError, undefined);
	assert.deepEqual(module.calls.find((call) => call.method === "propose").input,
		{ text: "A durable fact.", projectId: "example-site", origin });

	const changed = handlers({ previewOf: (preview) => ({ ...preview, text: "Another text." }) });
	assert.deepEqual(await changed.h.call("memory_propose", { text: "A durable fact." }), { content: [{ type: "text", text: "not_confirmed" }], isError: true });
	const moved = handlers({ previewOf: (preview) => ({ ...preview, projectId: "example-site" }) });
	assert.equal(text(await moved.h.call("memory_propose", { text: "A durable fact." })), "not_confirmed");
	const action = handlers({ previewOf: (preview) => ({ ...preview, action: "approve" }) });
	assert.equal(text(await action.h.call("memory_propose", { text: "A durable fact." })), "not_confirmed");
});

test("propose refuses without a project and returns the static code of the core", async () => {
	const none = handlers({ resolution: { projectId: null, role: null, source: "none" } });
	assert.equal(text(await none.h.call("memory_propose", { text: "A fact." })), "project_none");
	assert.equal(none.module.calls.some((call) => call.method === "propose"), false);
	const envOutside = handlers({ resolution: { projectId: null, role: null, source: "env", reason: "env_not_member" } });
	assert.equal(text(await envOutside.h.call("memory_propose", { text: "A fact." })), "not_member");
	const outside = handlers();
	assert.equal(text(await outside.h.call("memory_propose", { text: "A fact.", projectId: "other-project" })), "not_member");
	assert.deepEqual(outside.logs, ["memory_propose refused (not_member)"]);
});

test("the kill switch and a missing config refuse every tool", async () => {
	const off = handlers({}, { AGENTCORE_MEMORY_DISABLE: "1" });
	for (const name of TOOL_NAMES) {
		assert.equal(text(await off.h.call(name, { projectId: "example-site", actorId: "bruno", memoryRecordId: PROPOSAL_ID, text: "x", reason: "r" })),
			"disabled");
	}
	assert.deepEqual(off.module.calls, []);
	const empty = handlers({ config: null });
	assert.equal(text(await empty.h.call("memory_list_proposals", { projectId: "example-site", actorId: "bruno" })), "config");
	const broken = createHandlers({ env: {}, loadCore: async () => { throw new Error("CANARY no core"); }, log: () => {}, origin });
	assert.equal(text(await broken.call("memory_list_proposals", { projectId: "example-site", actorId: "bruno" })), "failed");
});

test("the review tools call the core with the proposer and the reviewer origin", async () => {
	const { h, module } = handlers();
	const target = { projectId: "example-site", actorId: "bruno", memoryRecordId: PROPOSAL_ID };
	const list = JSON.parse(text(await h.call("memory_list_proposals", { projectId: "example-site", actorId: "bruno" })));
	assert.equal(list.proposals[0].memoryRecordId, PROPOSAL_ID);
	assert.deepEqual(module.calls.find((call) => call.method === "listProposals").input, { projectId: "example-site", actorId: "bruno" });
	assert.deepEqual(JSON.parse(text(await h.call("memory_list_proposals", { projectId: "example-site", actorId: "dana" }))), { proposals: [] });
	assert.equal(text(await h.call("memory_list_proposals", { projectId: "example-project", actorId: "bruno" })), "not_maintainer");
	const shown = JSON.parse(text(await h.call("memory_show_proposal", target)));
	assert.deepEqual([shown.actorId, shown.namespace], ["bruno", "/project/example-site/proposals/bruno/"]);
	assert.deepEqual(module.calls.find((call) => call.method === "showProposal").input, target);
	assert.equal(text(await h.call("memory_show_proposal", { ...target, memoryRecordId: CREATED_ID })), "proposal_missing");
	assert.equal(text(await h.call("memory_show_proposal", { ...target, actorId: "dana" })), "proposal_missing");
	const approved = JSON.parse(text(await h.call("memory_approve", target)));
	assert.deepEqual(approved, { memoryRecordId: PROPOSAL_ID,
		sourceNamespace: "/project/example-site/proposals/bruno/", targetNamespace: "/project/example-site/shared/" });
	assert.deepEqual(module.calls.find((call) => call.method === "approve").input,
		{ ...target, reason: undefined, reviewer: origin });
	assert.equal(text(await h.call("memory_approve", { ...target, actorId: "dana" })), "proposal_missing");
	const rejected = await h.call("memory_reject", { ...target, reason: "duplicate" });
	assert.equal(rejected.isError, undefined);
	assert.deepEqual(module.calls.find((call) => call.method === "reject").input,
		{ ...target, reason: "duplicate", reviewer: origin });
	assert.equal(text(await h.call("memory_reject", { ...target, actorId: "dana", reason: "duplicate" })), "proposal_missing");
	assert.equal(text(await h.call("memory_reject", { ...target, reason: " " })), "not_confirmed");
	// The handler never sends the prefix form, also when a client skips the input schema.
	const before = module.calls.length;
	assert.equal(text(await h.call("memory_list_proposals", { projectId: "example-site" })), "config");
	assert.equal(module.calls.slice(before).some((call) => call.method === "listProposals"), false);
});

test("approve and reject confirm the project, the proposer, the record and the reason of the tool input", async () => {
	const target = { projectId: "example-site", actorId: "bruno", memoryRecordId: PROPOSAL_ID };
	const otherRecord = handlers({ previewOf: (preview) => ({ ...preview, proposal: { ...preview.proposal, memoryRecordId: CREATED_ID } }) });
	assert.equal(text(await otherRecord.h.call("memory_approve", target)), "not_confirmed");
	const otherProposer = handlers({ previewOf: (preview) => ({ ...preview, proposal: { ...preview.proposal, actorId: "dana" } }) });
	assert.equal(text(await otherProposer.h.call("memory_approve", target)), "not_confirmed");
	assert.equal(text(await otherProposer.h.call("memory_reject", { ...target, reason: "r" })), "not_confirmed");
	const otherProject = handlers({ previewOf: (preview) => ({ ...preview, projectId: "example-project" }) });
	assert.equal(text(await otherProject.h.call("memory_reject", { ...target, reason: "r" })), "not_confirmed");
	const otherReason = handlers({ previewOf: (preview) => ({ ...preview, reason: "another reason" }) });
	assert.equal(text(await otherReason.h.call("memory_reject", { ...target, reason: "r" })), "not_confirmed");
	const otherAction = handlers({ previewOf: (preview) => ({ ...preview, action: "reject" }) });
	assert.equal(text(await otherAction.h.call("memory_approve", target)), "not_confirmed");
});

test("the review tools with the real core list the one exact namespace of the proposer and move the record", async () => {
	const core = await import(CORE_URL.href);
	const source = "/project/example-site/proposals/bruno/";
	const record = { memoryRecordId: PROPOSAL_ID, namespaces: [source], content: { text: "The example site builds with one command." },
		metadata: { actorId: { stringValue: "bruno" }, projectId: { stringValue: "example-site" } } };
	const requests = [];
	// Like the live store: the namespace of a list is an exact match. No AWS call.
	const client = {
		list: async (input) => {
			requests.push(["list", input.namespace]);
			return { memoryRecordSummaries: record.namespaces.includes(input.namespace) ? [record] : [] };
		},
		batchUpdate: async (input) => {
			requests.push(["batchUpdate", input.records[0].sourceNamespaces[0]]);
			record.namespaces = input.records[0].namespaces;
			return { successfulRecords: [{ memoryRecordId: PROPOSAL_ID, status: "SUCCEEDED" }], failedRecords: [] };
		},
		destroy: () => {},
	};
	const lines = [];
	const ledger = { append: async (entry) => { lines.push(entry); }, entriesFor: async () => [] };
	const h = createHandlers({ env: { AGENTCORE_MEMORY_CONFIG: JSON.stringify(CONFIG) }, log: () => {}, origin, loadCore: async () => ({
		...core, createCore: (config, deps) => core.createCore(config, { ...deps, createClient: async () => client, ledger }),
	}) });
	const target = { projectId: "example-site", actorId: "bruno", memoryRecordId: PROPOSAL_ID };
	const list = JSON.parse(text(await h.call("memory_list_proposals", { projectId: "example-site", actorId: "bruno" })));
	assert.deepEqual(list.proposals.map((item) => [item.memoryRecordId, item.namespace]), [[PROPOSAL_ID, source]]);
	assert.equal(JSON.parse(text(await h.call("memory_show_proposal", target))).actorId, "bruno");
	assert.equal(text(await h.call("memory_show_proposal", { ...target, actorId: "dana" })), "proposal_missing");
	const approved = JSON.parse(text(await h.call("memory_approve", target)));
	assert.deepEqual(approved, { memoryRecordId: PROPOSAL_ID, sourceNamespace: source, targetNamespace: "/project/example-site/shared/" });
	assert.deepEqual(lines.map((line) => [line.action, line.sourceNamespace]), [["approve", source], ["approve-done", source]]);
	assert.equal(text(await h.call("memory_reject", { ...target, reason: "duplicate" })), "proposal_missing");
	assert.deepEqual(requests, [["list", source], ["list", source], ["list", "/project/example-site/proposals/dana/"],
		["list", source], ["batchUpdate", source], ["list", source]]);
	await h.close();
});

test("the tool table marks every write tool and validates the ids", () => {
	assert.deepEqual(Object.keys(TOOLS), TOOL_NAMES);
	assert.deepEqual(REQUIRES_USER, { "anthropic/requiresUserInteraction": true });
	const schema = TOOLS.memory_show_proposal.inputSchema;
	const good = { projectId: "example-site", actorId: "bruno", memoryRecordId: PROPOSAL_ID };
	assert.equal(schema.safeParse(good).success, true);
	for (const bad of [{ ...good, projectId: "Example" }, { ...good, projectId: "example-*" },
		{ ...good, memoryRecordId: "mem-short" }, { ...good, memoryRecordId: `${PROPOSAL_ID}/x` },
		{ projectId: "example-site", memoryRecordId: PROPOSAL_ID }, { ...good, actorId: "Bruno" }, { ...good, actorId: "*" },
		{ ...good, actorId: "bruno/" }, { ...good, actorId: "" }]) {
		assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad));
	}
	for (const name of ["memory_list_proposals", "memory_approve", "memory_reject"]) {
		assert.equal(TOOLS[name].inputSchema.safeParse({ projectId: "example-site", memoryRecordId: PROPOSAL_ID, reason: "r" }).success, false, name);
	}
});
