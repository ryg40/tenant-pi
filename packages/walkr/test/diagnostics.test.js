import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpRoot } from "./tmp-root.js";
import { recordError } from "../src/diagnostics.js";

test("private diagnostics stay bounded and cannot turn a log failure into a server failure", (t) => {
  const root = fs.mkdtempSync(path.join(tmpRoot, "walkr-diagnostics-"));
  const previous = process.env.HUMAN_REVIEW_STATE_DIR;
  process.env.HUMAN_REVIEW_STATE_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.HUMAN_REVIEW_STATE_DIR;
    else process.env.HUMAN_REVIEW_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, "errors.log");
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 65), { mode: 0o644 });
  recordError("WR-123456789abc", "request", new Error("private cause"));
  assert.ok(fs.statSync(file).size <= 1024 * 1024);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const entry = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(entry.code, "WR-123456789abc");
  assert.match(entry.detail, /private cause/);

  const original = fs.readFileSync(file);
  const open = t.mock.method(fs, "openSync", () => { throw Object.assign(new Error("disk unavailable"), { code: "EIO" }); });
  assert.doesNotThrow(() => recordError("WR-abcdef123456", "request", new Error("another cause")));
  open.mock.restore();
  assert.deepEqual(fs.readFileSync(file), original);
});
