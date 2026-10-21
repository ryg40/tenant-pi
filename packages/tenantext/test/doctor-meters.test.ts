import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexMeter } from "../extensions/codex-accounts/reader.ts";
import { runChecks } from "../extensions/doctor/checks.ts";

test("the doctor reads the meters through their readers: Codex token file states and a Copilot meter that is off", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "doctor-meters-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "codex-accounts"), { recursive: true });
	writeFileSync(join(dir, "empty.json"), JSON.stringify({ tokens: {} }));
	writeFileSync(join(dir, "broken.json"), "{");
	writeFileSync(join(dir, "good.json"), JSON.stringify({ access_token: "a-token", account_id: "an-account" }));
	writeFileSync(join(dir, "codex-accounts", "settings.json"), JSON.stringify({ accounts: [
		{ provider: "openai-codex", label: "Codex 1", tokenFile: join(dir, "good.json") },
		{ provider: "openai-codex-2", label: "Codex 2", tokenFile: join(dir, "absent.json") },
		{ provider: "openai-codex-3", label: "Codex 3", tokenFile: join(dir, "empty.json") },
		{ provider: "openai-codex-4", label: "Codex 4", tokenFile: join(dir, "broken.json") },
	] }));
	assert.deepEqual(readCodexMeter(dir).tokenFiles.map(f => f.state), ["ok", "missing", "no login", "unreadable"]);
	const checks = await runChecks({ dir, env: { HOME: dir, TENANTEXT_COPILOT_USAGE: "off", TENANTEXT_ANTHROPIC_USAGE: "off" }, which: async () => true, readClaudeFile: () => undefined });
	const messages = (id: string) => checks.filter(c => c.id === id).map(c => c.message);
	assert.deepEqual(messages("codex-token-files"), [
		`Codex token files not found: openai-codex-2 (${join(dir, "absent.json")}). Those meters stay hidden.`,
		`Codex token files unreadable or expired: openai-codex-4 (${join(dir, "broken.json")}). Those meters show an error until the login owner refreshes the file.`,
	]);
	assert.match(messages("codex-no-login")[0], /openai-codex-3/);
	assert.deepEqual(messages("codex"), ["Codex meter: openai-codex (token file), openai-codex-3 (token file), openai-codex-4 (token file)."]);
	assert.deepEqual(messages("copilot"), [`Copilot meter is off in ${join(dir, "copilot-usage", "settings.json")}.`]);
	assert.equal(checks.find(c => c.id === "anthropic")!.status, "info");
});
