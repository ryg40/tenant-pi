import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { settingsMenu } from "../src/settings-menu.ts";

test("interactive settings show both groups, save valid values, and close without editing on Esc", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tenantext-menu-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const notices: string[] = [];
  const choices = ["Simplified English rules:", "off", "Decision-server calls:", "off", "Operations footer:", "off", "Maximum footer rows:", "OpenKnowledge health URL:", undefined];
  const input = ["7", "http://localhost/health"];
  let mainChanges = 0, footerChanges = 0;
  const ctx = { mode: "tui", ui: {
    async select(_title: string, options: string[]) {
      const next = choices.shift();
      return next === undefined ? undefined : options.find(o => o.startsWith(next)) ?? assert.fail(`missing ${next}`);
    },
    async input() { return input.shift(); },
    notify(text: string) { notices.push(text); },
  } } as unknown as ExtensionContext;
  try {
    await settingsMenu(ctx, { mainChanged: () => mainChanges++, footerChanged: () => footerChanges++ });
    const main = JSON.parse(readFileSync(join(dir, "tenantext/settings.json"), "utf8"));
    const footer = JSON.parse(readFileSync(join(dir, "ops-footer/settings.json"), "utf8"));
    assert.deepEqual(main, { rules: false, guard: true, decisions: false });
    assert.equal(footer.enabled, false);
    assert.equal(footer.maximumRows, 7);
    assert.equal(footer.healthUrls.OK, "http://localhost/health");
    assert.equal(mainChanges, 2);
    assert.equal(footerChanges, 3);
    assert.deepEqual(notices, []);
    assert.match(readFileSync(join(dir, "tenantext/settings.example.jsonc"), "utf8"), /\/\/ guard:/);
    assert.match(readFileSync(join(dir, "ops-footer/settings.example.jsonc"), "utf8"), /\/\/ maximumRows:/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bad values do not save or leak environment health URLs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tenantext-menu-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousUrl = process.env.OPS_FOOTER_OK_HEALTH_URL;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.OPS_FOOTER_OK_HEALTH_URL = "http://example.invalid/private";
  const choices = ["Health request timeout (ms):", "OpenViking health URL:", "Show healthy services:", "on", undefined];
  const inputs = ["99", "https://user:secret@example.invalid/health"];
  const notices: string[] = [];
  let changed = 0;
  try {
    await settingsMenu({ mode: "tui", ui: {
      select: async (_title: string, options: string[]) => { const next = choices.shift(); return next && options.find(o => o.startsWith(next)); },
      input: async () => inputs.shift(),
      notify: (text: string) => notices.push(text),
    } } as unknown as ExtensionContext, { mainChanged() { assert.fail(); }, footerChanged() { changed++; } });
    const saved = JSON.parse(readFileSync(join(dir, "ops-footer/settings.json"), "utf8"));
    assert.equal(changed, 1);
    assert.equal(saved.healthTimeoutMs, 2000);
    assert.deepEqual(saved.healthUrls, {});
    assert.equal(saved.showHealthyServices, true);
    assert.equal(notices.length, 2);
    assert.ok(!notices.join("\n").includes("secret"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousUrl === undefined) delete process.env.OPS_FOOTER_OK_HEALTH_URL; else process.env.OPS_FOOTER_OK_HEALTH_URL = previousUrl;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noninteractive settings command does not write files", async () => {
  let message = "";
  await settingsMenu({ mode: "rpc", ui: { notify: (text: string) => { message = text; } } } as unknown as ExtensionContext,
    { mainChanged() { assert.fail(); }, footerChanged() { assert.fail(); } });
  assert.match(message, /requires the TUI/);
});
