import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

test("suite exposes nine stable individual resources", () => {
  const manifest = readJson("package.json");
  assert.equal(manifest.version, "1.0.0");
  assert.deepEqual(manifest.pi.extensions, [
    "./extensions/tenantext/index.ts",
    "./extensions/slopscore/index.ts",
    "./extensions/codex-accounts/index.ts",
    "./extensions/context-meter/index.ts",
    "./extensions/ops-footer/index.ts",
    "./extensions/copilot-usage/index.ts",
    "./extensions/anthropic-usage/index.ts",
    "./extensions/doctor/index.ts",
    "./extensions/resources/index.ts",
  ]);
  for (const resource of manifest.pi.extensions) {
    assert.ok(existsSync(fileURLToPath(new URL(resource, root))), resource);
  }
  const lock = readJson("package-lock.json");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.ok(manifest.files.includes("extensions"), "individual resources retain shared modules");
});
