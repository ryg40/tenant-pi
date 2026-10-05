import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";

test("Node child loader resolves gateway aliases with slash and thinking suffix", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tenantext-loader-"));
	const oldUrl = process.env.TENANTEXT_LITELLM_BASE_URL;
	const oldKey = process.env.TENANTEXT_LITELLM_API_KEY;
	process.env.TENANTEXT_LITELLM_BASE_URL = "https://gateway.invalid/v1";
	process.env.TENANTEXT_LITELLM_API_KEY = "fixture-only";
	try {
		const loader = new DefaultResourceLoader({
			cwd: dir, agentDir: dir, settingsManager: SettingsManager.create(dir, dir),
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../extensions/codex-accounts/index.ts", import.meta.url))],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		for (const entry of loaded.runtime.pendingProviderRegistrations) runtime.registerProvider(entry.name, entry.config);
		const resolved = resolveCliModel({ cliModel: "litellm-codex/codex-auto/luna:xhigh", modelRuntime: runtime });
		assert.equal(resolved.error, undefined);
		assert.equal(resolved.model?.id, "codex-auto/luna");
		assert.equal(resolved.thinkingLevel, "xhigh");
	} finally {
		if (oldUrl === undefined) delete process.env.TENANTEXT_LITELLM_BASE_URL;
		else process.env.TENANTEXT_LITELLM_BASE_URL = oldUrl;
		if (oldKey === undefined) delete process.env.TENANTEXT_LITELLM_API_KEY;
		else process.env.TENANTEXT_LITELLM_API_KEY = oldKey;
		await rm(dir, { recursive: true, force: true });
	}
});
