import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { applyPatterns, isEnabledByOverrides } from "../resources/inventory.ts";
import type { Check } from "./checks.ts";

interface WikiOptions {
	dir: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	home?: string;
	/** Tests can reject credential field access without reading real files. */
	readConfig?: (path: string) => unknown;
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };

function endpoint(value: unknown): { host: string; identity: string } | undefined {
	try {
		const url = new URL(text(value));
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		const host = url.hostname.toLowerCase().replace(/\.$/, "");
		return { host, identity: `${host}:${url.port || (url.protocol === "https:" ? "443" : "80")}` };
	} catch { return undefined; }
}

/** Read-only configuration warning, not a probe of credentials or service health. */
export function wikiEmbeddingChecks(options: WikiOptions): Check[] {
	const { dir, cwd, env } = options;
	const home = options.home ?? env.HOME ?? homedir();
	const read = options.readConfig ?? readJson;
	const projectDir = join(cwd, ".pi");
	const global = record(read(join(dir, "settings.json")));
	const project = record(read(join(projectDir, "settings.json")));
	const wiki: Record<string, string> = {};
	// Match the upstream nonempty-string merge. A blank or null project key does not erase a global key.
	for (const settings of [global, project]) {
		const section = record(settings["llm-wiki"]);
		for (const key of ["embeddingProvider", "embeddingBaseUrl", "embeddingModel"]) {
			const value = text(section[key]);
			if (value) wiki[key] = value;
		}
	}
	if (!wiki.embeddingProvider) return [];

	const target = endpoint(wiki.embeddingBaseUrl || env.OPENAI_BASE_URL || "https://api.openai.com");
	const model = wiki.embeddingModel || "text-embedding-3-small";
	const modelLabel = /^[a-zA-Z0-9_./:-]+$/.test(model) ? model : "unrecognized";
	const checks: Check[] = [{ id: "wiki_embeddings_on", status: "info",
		message: `Wiki embeddings are configured on. Model: ${modelLabel}; host: ${target?.host ?? "unrecognized"}.` }];
	const expand = (path: string, base: string) => resolve(base, path === "~" ? home : path.replace(/^~\//, `${home}/`));
	const endpoints: unknown[] = [env.OPENVIKING_URL, env.OPENVIKING_BASE_URL, env.OPENVIKING_MCP_URL];
	const paths = new Set([join(home, ".openviking", "ovcli.conf"), join(home, ".openviking", "ov.conf")]);
	for (const key of ["OPENVIKING_CLI_CONFIG_FILE", "OPENVIKING_CONFIG_FILE"]) {
		const path = text(env[key]);
		if (path) paths.add(expand(path, cwd));
	}
	// Do not use the OV credential resolver: only these two endpoint fields are needed.
	for (const path of paths) {
		const config = record(read(path));
		endpoints.push(config.url, record(record(config.embedding).dense).api_base);
	}
	const shared = target && endpoints.some(value => endpoint(value)?.identity === target.identity);

	// Use package declarations, not an old generation record. Project declarations replace the same source's filters.
	const packages = new Map<string, { entry: unknown; root: string }>();
	for (const [settings, base] of [[global, dir], [project, projectDir]] as const) {
		for (const entry of Array.isArray(settings.packages) ? settings.packages : []) {
			const source = text(typeof entry === "string" ? entry : record(entry).source);
			if (!source) continue;
			const root = /^(?:npm:|git:|https?:)/.test(source) ? source : expand(source, base);
			packages.set(root, { entry, root });
		}
	}
	const enabled = [...packages.values()].some(({ entry, root }) => {
		const name = /^(?:npm:|git:|https?:)/.test(root) ? root : text(record(read(join(root, "package.json"))).name);
		if (basename(root) !== "openviking-pi" && name !== "openviking-pi-extension" && !/^npm:openviking-pi-extension(?:@|$)/.test(name)) return false;
		const path = join(root, "index.ts");
		const filter = record(entry).extensions;
		if (Array.isArray(filter) && (!filter.length || !applyPatterns([path], strings(filter), root).has(path))) return false;
		return isEnabledByOverrides(path, strings(global.extensions), dir)
			&& isEnabledByOverrides(path, strings(project.extensions), projectDir);
	});
	if (shared || enabled) checks.push({ id: "wiki_embeddings_shared_endpoint", status: "warn",
		message: `${shared ? "Wiki embeddings share an OpenViking endpoint host and port." : "Wiki embeddings and the openviking module are enabled in the same profile."} Remove embeddingProvider, embeddingBaseUrl, embeddingModel, and embeddingApiKey or embeddingApiKeyEnv from llm-wiki in global and project settings. See docs/memory-modules.md#switch-wiki-embeddings-off.` });
	return checks;
}
