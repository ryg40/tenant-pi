import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { mountFrameZoom, normalizeZoom, ZOOM_LEVELS, ZOOM_KEY } from "../src/frame-zoom.js";
import { readReceipt, RECEIPT_LIMITS } from "../src/double-chat-receipt.js";

function fixture() {
  const dom = new JSDOM(`<h3 id="host"></h3><div id="stage"><iframe id="frame" sandbox="" srcdoc="<p>candidate</p>"></iframe></div>`, { url: "http://127.0.0.1:1" });
  const doc = dom.window.document;
  return { dom, doc, stage: doc.getElementById("stage"), host: doc.getElementById("host"), frame: doc.getElementById("frame") };
}

test("zoom steps between 25% and 100%, returns to 100%, and never changes the frame document", () => {
  const f = fixture(), before = f.frame.outerHTML;
  const zoom = mountFrameZoom({ document: f.doc, stage: f.stage, host: f.host, name: "t", label: "left candidate", storage: f.dom.window.localStorage });
  const [out, reset, into, full] = f.host.querySelectorAll("button");
  assert.equal(zoom.level, 1);
  assert.equal(f.stage.style.getPropertyValue("--zoom"), "1");
  assert.equal(into.disabled, true, "100% is the largest level");
  out.click();
  assert.equal(zoom.level, 0.75);
  assert.equal(reset.textContent, "75%");
  full.click();
  assert.equal(zoom.level, ZOOM_LEVELS[0]);
  assert.equal(f.stage.dataset.zoom, "25%");
  assert.equal(out.disabled, true);
  assert.equal(full.disabled, true);
  into.click();
  assert.equal(zoom.level, 0.33);
  reset.click();
  assert.equal(zoom.level, 1);
  assert.equal(reset.getAttribute("aria-pressed"), "true");
  assert.equal(f.frame.outerHTML, before, "the candidate frame keeps its markup and source");
  assert.equal(f.dom.window.localStorage.getItem(ZOOM_KEY + "t"), "1");
  zoom.close();
  assert.equal(f.host.querySelector(".zoom-control"), null);
});

test("zoom restores a saved level and ignores an unknown one", () => {
  const f = fixture();
  f.dom.window.localStorage.setItem(ZOOM_KEY + "a", "0.5");
  f.dom.window.localStorage.setItem(ZOOM_KEY + "b", "7");
  assert.equal(mountFrameZoom({ document: f.doc, stage: f.stage, host: f.host, name: "a", label: "x", storage: f.dom.window.localStorage }).level, 0.5);
  assert.equal(mountFrameZoom({ document: f.doc, stage: f.stage, host: f.host, name: "b", label: "x", storage: f.dom.window.localStorage }).level, 1);
  for (const bad of [null, undefined, "", "0", "2", "abc"]) assert.equal(normalizeZoom(bad), 1);
  // Blocked storage must not stop the control.
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const zoom = mountFrameZoom({ document: f.doc, stage: f.stage, host: f.host, name: "c", label: "x", storage: blocked });
  zoom.set(0.5);
  assert.equal(zoom.level, 0.5);
});

test("a receipt is found when an earlier chat entry is larger than a packet", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walkr-receipt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  // A real Pi profile saves a system prompt of more than 256 KiB before the packet.
  const branch = [
    { type: "custom", id: "a1", parentId: null, customType: "attempt" },
    { type: "message", id: "b2", parentId: "a1", message: { role: "system", content: "s".repeat(RECEIPT_LIMITS.lineBytes + 20000) } },
    { type: "custom_message", id: "c3", parentId: "b2", content: "packet" },
  ];
  const lines = [{ type: "session", version: 3, id: "sid" }, ...branch];
  await fs.writeFile(file, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const options = { signal: new AbortController().signal, check() {} };
  assert.equal(await readReceipt({ origin: { sessionFile: file, sessionId: "sid" } }, branch, 2, options), true);
  // A changed packet is still refused.
  const changed = structuredClone(branch); changed[2].content = "other";
  assert.equal(await readReceipt({ origin: { sessionFile: file, sessionId: "sid" } }, changed, 2, options), false);
  // An entry above the entry limit is refused, as before.
  const huge = [{ type: "session", version: 3, id: "sid" }, { type: "custom", id: "a1", parentId: null, data: "x".repeat(RECEIPT_LIMITS.entryBytes) }];
  await fs.writeFile(file, huge.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await assert.rejects(readReceipt({ origin: { sessionFile: file, sessionId: "sid" } }, [huge[1]], 0, options), /receipt/);
});
