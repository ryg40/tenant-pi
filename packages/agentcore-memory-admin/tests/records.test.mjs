import test from "node:test";
import assert from "node:assert/strict";
import { deleteRecords, listNamespaces, listRecords, namespaceLines } from "../src/records.mjs";
import { fakeMemory, record } from "./fakes.mjs";

const RECORDS = [
  record("mem-chen-1", "/project/example-site/rejected/chen/"),
  record("mem-chen-2", "/project/example-site/rejected/chen/"),
  record("mem-chen-3", "/project/example-site/rejected/chen/"),
  record("mem-bruno", "/project/example-site/rejected/bruno/"),
  record("mem-two", "/project/example-site/rejected/bruno/", "two", {
    namespaces: ["/project/example-site/rejected/bruno/", "/project/example-site/rejected/chen/"] }),
];

test("a list of a tree prefix returns no record, as on the live store", async () => {
  const memory = fakeMemory(RECORDS);
  assert.deepEqual(await listRecords(memory, "mem-EXAMPLE", "/project/example-site/rejected/"), []);
  assert.deepEqual(await listRecords(memory, "mem-EXAMPLE", "/project/example-site/"), []);
  assert.deepEqual(await listRecords(memory, "mem-EXAMPLE", "/project/example-site/rejected/chen"), []);
});

test("a list of an exact namespace returns its records over several pages", async () => {
  const memory = fakeMemory(RECORDS);
  const found = await listRecords(memory, "mem-EXAMPLE", "/project/example-site/rejected/chen/");
  assert.deepEqual(found.map((item) => item.memoryRecordId), ["mem-chen-1", "mem-chen-2", "mem-chen-3", "mem-two"]);
  assert.equal(memory.calls.length, 2, "the fake pages by two");
  assert.ok(memory.calls.every((call) => call.input.namespace === "/project/example-site/rejected/chen/"));
});

test("listNamespaces counts each list and gives each record once, with the first namespace that returned it", async () => {
  const memory = fakeMemory(RECORDS);
  const { records, counts } = await listNamespaces(memory, "mem-EXAMPLE",
    ["/project/example-site/rejected/bruno/", "/project/example-site/rejected/chen/", "/project/example-site/rejected/dana/"]);
  assert.deepEqual(counts.map(({ count }) => count), [2, 4, 0]);
  assert.deepEqual(records.map((item) => [item.memoryRecordId, item.listed]), [
    ["mem-bruno", "/project/example-site/rejected/bruno/"], ["mem-two", "/project/example-site/rejected/bruno/"],
    ["mem-chen-1", "/project/example-site/rejected/chen/"], ["mem-chen-2", "/project/example-site/rejected/chen/"],
    ["mem-chen-3", "/project/example-site/rejected/chen/"]]);
  assert.deepEqual(namespaceLines(["/a/"], [{ namespace: "/a/", count: 2 }]), ["namespaces listed (exact form):", "  /a/ 2 record(s)"]);
  assert.deepEqual(namespaceLines(["/a/"]), ["namespaces to list (exact form):", "  /a/"]);
});

test("deleteRecords counts a gone record (error code 404) as done and stops on any other failed record", async () => {
  const many = Array.from({ length: 101 }, (_, n) => record(`mem-${n}`, "/actor/dana/"));
  let memory = fakeMemory(many);
  const ghost = { memoryRecordId: "mem-ghost", namespace: "/actor/dana/" };
  const all = [...many.map((item) => ({ memoryRecordId: item.memoryRecordId, namespace: "/actor/dana/" })), ghost];
  assert.deepEqual(await deleteRecords(memory, "mem-EXAMPLE", all), { deleted: 101, gone: 1 });
  assert.deepEqual(memory.store, []);
  memory = fakeMemory(many, { failures: { "mem-100": { errorCode: 429, errorMessage: "slow down" } } });
  const reordered = [ghost, ...all.slice(0, 101)];
  await assert.rejects(deleteRecords(memory, "mem-EXAMPLE", reordered),
    { message: "1 record delete(s) failed after 100 deleted and 1 gone already; run the step again\n  mem-100: error code 429: slow down" });
  assert.deepEqual(memory.store.map((item) => item.memoryRecordId), ["mem-100"], "only the failed record stays");
});
