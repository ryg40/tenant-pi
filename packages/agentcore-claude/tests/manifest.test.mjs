import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";

test("hooks.json holds one UserPromptSubmit hook and nothing else", () => {
	const { hooks } = json("hooks/hooks.json");
	assert.deepEqual(Object.keys(hooks), ["UserPromptSubmit"]);
	assert.equal(hooks.UserPromptSubmit.length, 1);
	const [group] = hooks.UserPromptSubmit;
	assert.equal(group.matcher, "");
	assert.equal(group.hooks.length, 1);
	const [hook] = group.hooks;
	assert.equal(hook.type, "command");
	assert.equal(hook.command, `node "${PLUGIN_ROOT}/scripts/recall.mjs"`);
	assert.equal(hook.timeout, 15);
	assert.ok(existsSync(join(root, "scripts/recall.mjs")));
});

test(".mcp.json names one stdio server and plugin.json points at it", () => {
	const { mcpServers } = json(".mcp.json");
	assert.deepEqual(mcpServers, { "agentcore-memory": { command: "node", args: [`${PLUGIN_ROOT}/servers/memory-mcp.mjs`] } });
	assert.ok(existsSync(join(root, "servers/memory-mcp.mjs")));
	const plugin = json(".claude-plugin/plugin.json");
	assert.equal(plugin.name, "agentcore-memory");
	assert.equal(plugin.mcpServers, "./.mcp.json");
	assert.equal(plugin.hooks, undefined, "hooks/hooks.json loads by default");
});

test("the plugin ships no permission rule, no settings and no other hook event", () => {
	const files = readdirSync(root, { recursive: true }).filter((name) => !String(name).startsWith("node_modules"));
	assert.equal(files.some((name) => /(^|\/)settings(\.local)?\.json$/.test(String(name))), false);
	for (const name of files.filter((file) => String(file).endsWith(".json"))) {
		const text = readFileSync(join(root, String(name)), "utf8");
		assert.doesNotMatch(text, /"permissions"|"allow"\s*:/, String(name));
	}
});

test("the package pins exact versions and the lock agrees", () => {
	const pkg = json("package.json");
	const lock = json("package-lock.json");
	assert.deepEqual(pkg.dependencies, { "@modelcontextprotocol/server": "2.3.1", zod: "4.6.7" });
	assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
	assert.equal(lock.packages["node_modules/@modelcontextprotocol/server"].version, "2.3.1");
	assert.equal(lock.packages["node_modules/zod"].version, "4.6.7");
	assert.equal(pkg.engines.node, ">=24.0.0 <25");
});
