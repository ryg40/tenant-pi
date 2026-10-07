import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyFixes, runChecks } from "../extensions/doctor/checks.ts";
import { wikiEmbeddingChecks } from "../extensions/doctor/wiki.ts";

const wiki = { embeddingProvider: "openai-compatible", embeddingBaseUrl: "http://192.0.2.10:8080/v1", embeddingModel: "example-embed" };
const warning = (checks: ReturnType<typeof wikiEmbeddingChecks>) => checks.find(c => c.id === "wiki_embeddings_shared_endpoint");

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "doctor-wiki-"));
	const dir = join(home, "agent"), cwd = join(home, "project");
	const env: NodeJS.ProcessEnv = { HOME: home };
	const put = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
	put(join(dir, "settings.json"), { "llm-wiki": wiki });
	const run = () => wikiEmbeddingChecks({ dir, cwd, env });
	return { home, dir, cwd, env, put, run, close: () => rmSync(home, { recursive: true, force: true }) };
}

test("wiki diagnostic catches the shared embedding listener, not just the OV server", () => {
	const f = fixture();
	try {
		f.put(join(f.home, ".openviking", "ovcli.conf"), { url: "http://192.0.2.20:1933" });
		f.put(join(f.home, ".openviking", "ov.conf"), { embedding: { dense: { api_base: "http://192.0.2.10:8080/other-prefix" } } });
		const checks = f.run();
		assert.equal(warning(checks)?.status, "warn");
		assert.match(warning(checks)!.message, /embeddingProvider, embeddingBaseUrl, embeddingModel, and embeddingApiKey or embeddingApiKeyEnv/);
		assert.match(warning(checks)!.message, /docs\/memory-modules\.md#switch-wiki-embeddings-off/);
		assert.deepEqual(checks[0], { id: "wiki_embeddings_on", status: "info", message: "Wiki embeddings are configured on. Model: example-embed; host: 192.0.2.10." });
	} finally { f.close(); }
});

test("wiki diagnostic checks every readable endpoint and environment path without a network probe", () => {
	for (const source of ["OPENVIKING_URL", "OPENVIKING_BASE_URL", "OPENVIKING_MCP_URL", "OPENVIKING_CLI_CONFIG_FILE", "OPENVIKING_CONFIG_FILE", "ovcli.conf", "ov.conf"]) {
		const f = fixture();
		try {
			if (source.endsWith("_FILE")) {
				f.env[source] = "~/custom.conf";
				f.put(join(f.home, "custom.conf"), source === "OPENVIKING_CONFIG_FILE" ? { embedding: { dense: { api_base: wiki.embeddingBaseUrl } } } : { url: wiki.embeddingBaseUrl });
			} else if (source.endsWith(".conf")) f.put(join(f.home, ".openviking", source), { url: wiki.embeddingBaseUrl });
			else f.env[source] = wiki.embeddingBaseUrl;
			assert.equal(warning(f.run())?.status, "warn", source);
		} finally { f.close(); }
	}
});

test("wiki endpoint equality uses normalized host and effective port, never path or credentials", () => {
	for (const [base, ov, match] of [
		["https://EXAMPLE.INVALID/v1", "https://example.invalid:443/mcp", true],
		["http://example.invalid:443/v1", "https://example.invalid/mcp", true],
		["http://example.invalid/v1", "https://example.invalid", false],
		[wiki.embeddingBaseUrl, "http://192.0.2.10:8081", false],
		[wiki.embeddingBaseUrl, "http://192.0.2.20:8080", false],
		["not a URL", wiki.embeddingBaseUrl, false],
		[wiki.embeddingBaseUrl, "not a URL", false],
		["file:///example", "file:///example", false],
	] as const) {
		const f = fixture();
		try {
			f.put(join(f.dir, "settings.json"), { "llm-wiki": { ...wiki, embeddingBaseUrl: base } });
			f.env.OPENVIKING_URL = ov;
			assert.equal(Boolean(warning(f.run())), match, `${base} / ${ov}`);
		} finally { f.close(); }
	}
});

test("wiki module warning follows package filters and project overrides", () => {
	const f = fixture();
	try {
		const source = join(f.home, "kit", "packages", "openviking-pi");
		f.put(join(source, "package.json"), { name: "openviking-pi-extension" });
		const global = { "llm-wiki": wiki, packages: [{ source, extensions: ["index.ts"] }] };
		f.put(join(f.dir, "settings.json"), global);
		assert.equal(warning(f.run())?.status, "warn");
		assert.match(warning(f.run())!.message, /same profile/);
		f.put(join(f.cwd, ".pi", "settings.json"), { packages: [{ source, extensions: [] }] });
		assert.equal(warning(f.run()), undefined);
		f.put(join(f.cwd, ".pi", "settings.json"), { packages: [{ source, extensions: ["!index.ts"] }] });
		assert.equal(warning(f.run()), undefined);
		f.put(join(f.cwd, ".pi", "settings.json"), { packages: [{ source, extensions: ["index.ts"] }] });
		assert.equal(warning(f.run())?.status, "warn");
		f.put(join(f.cwd, ".pi", "settings.json"), { extensions: [`-${source}/index.ts`] });
		assert.equal(warning(f.run()), undefined);
		f.put(join(f.dir, "settings.json"), { "llm-wiki": wiki });
		f.put(join(f.cwd, ".pi", "settings.json"), {});
		assert.equal(warning(f.run()), undefined);
		f.env.OPENVIKING_URL = wiki.embeddingBaseUrl;
		assert.equal(warning(f.run())?.status, "warn");
	} finally { f.close(); }
});

test("wiki project nonempty keys override global keys; blank and null keys do not erase them", () => {
	const f = fixture();
	try {
		f.env.OPENVIKING_URL = wiki.embeddingBaseUrl;
		f.put(join(f.cwd, ".pi", "settings.json"), { "llm-wiki": { embeddingBaseUrl: "https://independent.example.invalid", embeddingModel: "project-model" } });
		assert.equal(warning(f.run()), undefined);
		assert.match(f.run()[0].message, /project-model; host: independent.example.invalid/);
		f.put(join(f.cwd, ".pi", "settings.json"), { "llm-wiki": { embeddingProvider: null, embeddingBaseUrl: "  " } });
		assert.equal(warning(f.run())?.status, "warn");
		f.put(join(f.dir, "settings.json"), {});
		assert.deepEqual(f.run(), []);
		f.put(join(f.cwd, ".pi", "settings.json"), { "llm-wiki": wiki });
		assert.equal(warning(f.run())?.status, "warn");
	} finally { f.close(); }
});

test("wiki embeddings off is silent despite ambient endpoints, keys, models and the module", () => {
	const f = fixture();
	try {
		f.env.OPENAI_API_KEY = "credential-canary";
		f.env.OPENAI_BASE_URL = wiki.embeddingBaseUrl;
		f.env.OPENVIKING_URL = wiki.embeddingBaseUrl;
		for (const embeddingProvider of [undefined, null, "", "  ", false, {}]) {
			f.put(join(f.dir, "settings.json"), { "llm-wiki": { ...wiki, embeddingProvider }, packages: ["npm:openviking-pi-extension"] });
			assert.deepEqual(f.run(), []);
		}
	} finally { f.close(); }
});

test("wiki diagnostics ignore malformed or missing OV files and use upstream display defaults", () => {
	const f = fixture();
	try {
		f.put(join(f.dir, "settings.json"), { "llm-wiki": { embeddingProvider: "openai" } });
		f.put(join(f.home, ".openviking", "ovcli.conf"), []);
		writeFileSync(join(f.home, ".openviking", "ov.conf"), "invalid json");
		assert.match(f.run()[0].message, /text-embedding-3-small; host: api.openai.com/);
		assert.equal(warning(f.run()), undefined);
		f.env.OPENAI_BASE_URL = "http://192.0.2.10:8080";
		f.env.OPENVIKING_URL = wiki.embeddingBaseUrl;
		assert.equal(warning(f.run())?.status, "warn");
	} finally { f.close(); }
});

test("wiki diagnostics never access credential fields or environment values, and redact URL components", () => {
	const secret = "credential-canary";
	const forbidden = () => { throw new Error("credential access"); };
	const section = { ...wiki, embeddingBaseUrl: `http://user:${secret}@192.0.2.10:8080/${secret}?key=${secret}#${secret}` };
	Object.defineProperties(section, { embeddingApiKey: { get: forbidden }, embeddingApiKeyEnv: { get: forbidden } });
	const dense = { api_base: wiki.embeddingBaseUrl };
	Object.defineProperty(dense, "api_key", { get: forbidden });
	const ov = { embedding: { dense } };
	Object.defineProperty(ov, "api_key", { get: forbidden });
	const env: NodeJS.ProcessEnv = { HOME: "/example" };
	for (const name of ["OPENAI_API_KEY", "OPENVIKING_API_KEY", "OPENVIKING_BEARER_TOKEN"]) Object.defineProperty(env, name, { get: forbidden });
	const checks = wikiEmbeddingChecks({ dir: "/example/agent", cwd: "/example/project", env,
		readConfig: path => path === "/example/agent/settings.json" ? { "llm-wiki": section } : path.endsWith("ov.conf") ? ov : {} });
	assert.equal(warning(checks)?.status, "warn");
	assert.ok(!JSON.stringify(checks).includes(secret));
	assert.ok(!JSON.stringify(checks).includes("user:"));
	assert.ok(checks.every(c => !c.fix));
});

test("runChecks includes wiki diagnostics and leaves files and vector stores unchanged", async () => {
	const f = fixture();
	try {
		f.env.OPENVIKING_URL = wiki.embeddingBaseUrl;
		f.put(join(f.cwd, ".llm-wiki", "meta", "embeddings.json"), { retained: true });
		const snapshot = (root: string): unknown => Object.fromEntries(readdirSync(root).sort().map(name => {
			const path = join(root, name);
			return [name, statSync(path).isDirectory() ? snapshot(path) : readFileSync(path, "utf8")];
		}));
		const before = snapshot(f.home);
		const checks = await runChecks({ dir: f.dir, cwd: f.cwd, env: f.env, which: async () => true,
			readCredential: () => undefined, readClaudeFile: () => undefined,
			fetcher: async () => { throw new Error("unexpected network request"); } });
		assert.equal(warning(checks)?.status, "warn");
		assert.deepEqual(applyFixes(checks.filter(c => c.id.startsWith("wiki_embeddings_"))), { applied: [], failed: [] });
		assert.deepEqual(snapshot(f.home), before);
	} finally { f.close(); }
});
