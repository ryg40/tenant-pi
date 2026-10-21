import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

// `pi.extensions` is the one load list of the package; the kit manifest names one component for each entry.
test("suite exposes each extension as an individual resource", () => {
  const manifest = readJson("package.json");
  assert.equal(new Set(manifest.pi.extensions).size, manifest.pi.extensions.length);
  for (const resource of manifest.pi.extensions) {
    assert.match(resource, /^\.\/extensions\/[a-z0-9-]+\/index\.ts$/);
    assert.ok(existsSync(fileURLToPath(new URL(resource, root))), resource);
  }
  const lock = readJson("package-lock.json");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.ok(manifest.files.includes("extensions"), "individual resources retain shared modules");
});
