import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { mountFrameZoom, normalizeZoom, ZOOM_LEVELS, ZOOM_KEY } from "../src/frame-zoom.js";

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
