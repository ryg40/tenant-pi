import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { runChecks } from "../extensions/doctor/checks.ts";

test("doctor resolves local package paths and flags different Tenantext copies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tenantext-doctor-"));
  const repo = join(dir, "repo");
  const copy = join(dir, "extensions", "tenantext");
  mkdirSync(repo, { recursive: true }); mkdirSync(copy, { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"tenantext"}');
  writeFileSync(join(copy, "package.json"), '{"name":"tenantext"}');
  const packages = [relative(dir, repo), relative(dir, copy)];
  const check = async () => runChecks({ dir, repo, env: { HOME: dir }, which: async () => true, readCredential: () => undefined });
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages }));
    const duplicated = await check();
    assert.equal(duplicated.filter(c => c.id === "pi-package").length, 1);
    assert.equal(duplicated.find(c => c.id === "pi-package")?.status, "ok");
    assert.equal(duplicated.find(c => c.id === "pi-package-duplicates")?.status, "warn");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [packages[0]] }));
    const single = await check();
    assert.equal(single.filter(c => c.id === "pi-package").length, 1);
    assert.ok(!single.some(c => c.id === "pi-package-duplicates"));
    assert.ok(!single.find(c => c.id === "pi-package")?.message.includes("another checkout"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
