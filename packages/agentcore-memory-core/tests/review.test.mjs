import test from "node:test";
import assert from "node:assert/strict";
import { NOW, bruno, exactStore, makeCore, memoryLedger, origin, summary } from "./helpers.mjs";

const reviewer = { agent: "agentcore-memory", harness: "cli", session: "review-session" };
const proposalMetadata = {
  actorId: { stringValue: "chen" }, projectId: { stringValue: "example-site" }, agent: { stringValue: "example-agent" },
  harness: { stringValue: "pi" }, host: { stringValue: "chen-laptop" }, session: { stringValue: "session-example" },
  proposedAt: { stringValue: "2026-10-15T11:00:00.000Z" },
};
const chenProposal = summary("rec-chen", "/project/example-site/proposals/chen/", "Chen proposes a fact", { metadata: proposalMetadata });
const brunoProposal = summary("rec-bruno", "/project/example-site/proposals/bruno/", "Bruno proposes");
const flat = Object.fromEntries(Object.entries(proposalMetadata).map(([key, value]) => [key, value.stringValue]));

/** A list handler with pages: the first page holds the given records and a token when more pages follow. */
function pages(...lists) {
  return (input) => {
    const index = input.nextToken ? Number(input.nextToken.slice(5)) : 0;
    return { memoryRecordSummaries: lists[index] ?? [], ...(index + 1 < lists.length ? { nextToken: `page-${index + 1}` } : {}) };
  };
}

test("listProposals without an actor sends the prefix form; the live store answers it with no record", async () => {
  const { core, calls } = makeCore(bruno, { records: [chenProposal, brunoProposal] });
  assert.deepEqual(await core.listProposals({ projectId: "example-site" }), []);
  assert.deepEqual(calls.map((call) => call.input),
    [{ memoryId: "mem-EXAMPLE", namespace: "/project/example-site/proposals/", maxResults: 100 }]);
});

test("listProposals with an actor lists that one exact proposals namespace: the live form", async () => {
  const { core, calls } = makeCore(bruno, { records: [chenProposal, brunoProposal] });
  assert.deepEqual(await core.listProposals({ projectId: "example-site", actorId: "chen" }), [{
    memoryRecordId: "rec-chen", namespace: "/project/example-site/proposals/chen/", actorId: "chen", projectId: "example-site",
    text: "Chen proposes a fact", createdAt: NOW.toISOString(), metadata: flat,
  }]);
  assert.deepEqual(calls.map((call) => call.input),
    [{ memoryId: "mem-EXAMPLE", namespace: "/project/example-site/proposals/chen/", maxResults: 100 }]);
  await assert.rejects(core.listProposals({ projectId: "example-site", actorId: "*" }), { code: "config" });
});

test("listProposals with an actor reads 100 per page and keeps proposals of that actor in the project tree only", async () => {
  // The handler gives records that an exact list never returns, to test the defence of the core.
  const { core, calls } = makeCore(bruno, { handlers: { list: pages([
    chenProposal,
    brunoProposal,
    summary("rec-shared", "/project/example-site/shared/", "Already shared"),
    summary("rec-other", "/project/example-project/proposals/chen/", "Other project"),
    summary("rec-two", "/project/example-site/proposals/chen/", "Two namespaces",
      { namespaces: ["/project/example-site/proposals/chen/", "/project/example-site/shared/"] }),
    summary("rec-bad-actor", "/project/example-site/proposals/Chen/", "Bad actor id"),
    summary("rec-deep", "/project/example-site/proposals/chen/deeper/", "Deeper namespace"),
    { memoryRecordId: "rec-no-text", namespaces: ["/project/example-site/proposals/chen/"] },
  ], [summary("rec-chen-2", "/project/example-site/proposals/chen/", "Second page", { createdAt: "2026-10-14T00:00:00Z" })]) } });
  const proposals = await core.listProposals({ projectId: "example-site", actorId: "chen" });
  assert.deepEqual(calls.map((call) => call.input), [
    { memoryId: "mem-EXAMPLE", namespace: "/project/example-site/proposals/chen/", maxResults: 100 },
    { memoryId: "mem-EXAMPLE", namespace: "/project/example-site/proposals/chen/", maxResults: 100, nextToken: "page-1" },
  ]);
  assert.deepEqual(proposals.map((proposal) => proposal.memoryRecordId), ["rec-chen", "rec-chen-2"]);
  assert.equal(proposals[1].createdAt, "2026-10-14T00:00:00Z");
});

test("listProposals follows nextToken for at most 10 pages and logs one static line when it stops", async () => {
  const { core, calls, logs } = makeCore(bruno, { handlers: { list: (input) => ({
    memoryRecordSummaries: [summary(`rec-${input.nextToken ?? "first"}`, "/project/example-site/proposals/chen/", "x")],
    nextToken: "page-again",
  }) } });
  const proposals = await core.listProposals({ projectId: "example-site", actorId: "chen" });
  assert.equal(calls.length, 10);
  assert.equal(proposals.length, 10);
  assert.deepEqual(logs, ["AgentCore Memory: proposal list stopped after 10 pages"]);
});

test("the exact store of the tests reads 100 records per page", async () => {
  const many = Array.from({ length: 150 }, (_, index) => summary(`rec-${index}`, "/project/example-site/proposals/chen/", "x"));
  const { core, calls } = makeCore(bruno, { records: many });
  assert.equal((await core.listProposals({ projectId: "example-site", actorId: "chen" })).length, 150);
  assert.deepEqual(calls.map((call) => call.input.nextToken), [undefined, "page-100"]);
});

test("a failed list maps to a static code", async () => {
  const denied = makeCore(bruno, { handlers: { list: () => {
    throw Object.assign(new Error("CANARY_SECRET"), { name: "AccessDeniedException" });
  } } });
  await assert.rejects(denied.core.listProposals({ projectId: "example-site", actorId: "chen" }),
    (error) => error.code === "aws_denied" && !error.message.includes("CANARY"));
});

test("showProposal with the actor lists the one exact proposals namespace and finds the proposal or null", async () => {
  const { core, calls } = makeCore(bruno, { records: [chenProposal, brunoProposal] });
  const shown = await core.showProposal({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen" });
  assert.deepEqual([shown.text, shown.namespace], ["Chen proposes a fact", "/project/example-site/proposals/chen/"]);
  assert.deepEqual(calls.map((call) => call.input.namespace), ["/project/example-site/proposals/chen/"]);
  assert.equal(await core.showProposal({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-absent" }), null);
  // The record exists, but in the namespace of another proposer: the exact list does not return it.
  assert.equal(await core.showProposal({ projectId: "example-site", actorId: "bruno", memoryRecordId: "rec-chen" }), null);
});

test("show, approve and reject without an actor refuse before any call: the prefix form never reaches the store", async () => {
  const { core, calls } = makeCore(bruno, { records: [chenProposal] });
  let asked = 0;
  const confirm = async () => { asked += 1; return true; };
  for (const actorId of [undefined, "", "*", "Chen", "chen/"]) {
    await assert.rejects(core.showProposal({ projectId: "example-site", actorId, memoryRecordId: "rec-chen" }), { code: "config" });
    await assert.rejects(core.approve({ projectId: "example-site", actorId, memoryRecordId: "rec-chen", reviewer }, confirm),
      { code: "config" });
    await assert.rejects(core.reject({ projectId: "example-site", actorId, memoryRecordId: "rec-chen", reason: "x", reviewer },
      confirm), { code: "config" });
  }
  assert.deepEqual([calls, asked], [[], 0]);
});

test("show, approve and reject find a proposal that only the exact list returns: the live defect", async () => {
  // The live defect: the prefix list returned no record, so the record id alone ended with proposal_missing.
  const store = { records: [chenProposal] };
  const { core, calls } = makeCore(bruno, { handlers: { list: exactStore(() => store.records), batchUpdate: (input) => {
    const [record] = input.records;
    store.records = store.records.map((item) => item.memoryRecordId === record.memoryRecordId
      ? { ...item, namespaces: record.namespaces } : item);
    return { successfulRecords: [{ memoryRecordId: record.memoryRecordId, status: "SUCCEEDED" }], failedRecords: [] };
  } } });
  assert.deepEqual(await core.listProposals({ projectId: "example-site" }), []);
  assert.equal((await core.showProposal({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen" })).actorId, "chen");
  const result = await core.approve({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen", reviewer },
    async () => true);
  assert.equal(result.targetNamespace, "/project/example-site/shared/");
  await assert.rejects(core.reject({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen", reason: "late", reviewer },
    async () => true), { code: "proposal_missing" });
  assert.deepEqual(calls.filter((call) => call.method === "list").map((call) => call.input.namespace), [
    "/project/example-site/proposals/", "/project/example-site/proposals/chen/", "/project/example-site/proposals/chen/",
    "/project/example-site/proposals/chen/"]);
});

test("approve journals, moves the record to the project shared namespace with one BatchUpdateMemoryRecords, journals", async () => {
  const ledger = memoryLedger();
  const previews = [];
  const { core, calls } = makeCore(bruno, { ledger, records: [chenProposal, brunoProposal] });
  const result = await core.approve({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen", reason: "Useful",
    reviewer }, async (preview) => { previews.push(preview); assert.equal(ledger.lines.length, 0); return true; });
  assert.deepEqual(result, { memoryRecordId: "rec-chen", sourceNamespace: "/project/example-site/proposals/chen/",
    targetNamespace: "/project/example-site/shared/" });
  assert.equal(previews[0].action, "approve");
  assert.equal(previews[0].targetNamespace, "/project/example-site/shared/");
  assert.equal(previews[0].reason, "Useful");
  assert.equal(previews[0].proposal.memoryRecordId, "rec-chen");
  assert.equal(previews[0].proposal.namespace, "/project/example-site/proposals/chen/");
  assert.deepEqual(calls.map((call) => call.method), ["list", "batchUpdate"]);
  assert.equal(calls[0].input.namespace, "/project/example-site/proposals/chen/");
  const expected = { ...Object.fromEntries(Object.entries(proposalMetadata).map(([key, value]) => [key, value.stringValue])),
    approvedBy: "bruno", approvedAt: NOW.toISOString() };
  assert.deepEqual(calls[1].input, { memoryId: "mem-EXAMPLE", records: [{
    memoryRecordId: "rec-chen", timestamp: NOW, sourceNamespaces: ["/project/example-site/proposals/chen/"],
    namespaces: ["/project/example-site/shared/"],
    metadata: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, { stringValue: value }])),
  }] });
  assert.equal("content" in calls[1].input.records[0], false);
  assert.deepEqual(ledger.lines.map((line) => line.action), ["approve", "approve-done"]);
  assert.deepEqual(ledger.lines[0], {
    at: NOW.toISOString(), action: "approve", maintainer: "bruno", projectId: "example-site", proposalRecordId: "rec-chen",
    actorId: "chen", text: "Chen proposes a fact", metadata: flat, reason: "Useful",
    sourceNamespace: "/project/example-site/proposals/chen/", targetNamespace: "/project/example-site/shared/",
  });
  assert.deepEqual(ledger.lines[1].metadata, expected);
  assert.equal(ledger.lines[1].sourceNamespace, "/project/example-site/proposals/chen/");
});

test("approve sets the actor and the project from the namespace and drops metadata keys that propose does not write", async () => {
  const forged = summary("rec-forged", "/project/example-site/proposals/chen/", "Forged keys", { metadata: {
    ...proposalMetadata, actorId: { stringValue: "alice" }, approvedBy: { stringValue: "alice" },
    rejectedBy: { stringValue: "alice" }, extra: { stringValue: "steer" }, number: { numberValue: 3 },
  } });
  const { core, calls } = makeCore(bruno, { records: [forged] });
  await core.approve({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-forged", reviewer }, async () => true);
  const metadata = calls[1].input.records[0].metadata;
  assert.deepEqual(Object.keys(metadata).sort(), ["actorId", "agent", "approvedAt", "approvedBy", "harness", "host",
    "projectId", "proposedAt", "session"]);
  assert.equal(metadata.actorId.stringValue, "chen");
  assert.equal(metadata.approvedBy.stringValue, "bruno");
});

test("reject moves the record to the rejected namespace of its actor; the reason stays in the ledger", async () => {
  const ledger = memoryLedger();
  const { core, calls } = makeCore(bruno, { ledger, records: [chenProposal, brunoProposal] });
  const previews = [];
  const result = await core.reject({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen",
    reason: "Duplicate of an existing record", reviewer }, async (preview) => { previews.push(preview); return true; });
  assert.deepEqual(result, { memoryRecordId: "rec-chen", sourceNamespace: "/project/example-site/proposals/chen/",
    targetNamespace: "/project/example-site/rejected/chen/" });
  assert.equal(previews[0].targetNamespace, "/project/example-site/rejected/chen/");
  assert.equal(previews[0].proposal.namespace, "/project/example-site/proposals/chen/");
  assert.equal(calls[0].input.namespace, "/project/example-site/proposals/chen/");
  const record = calls[1].input.records[0];
  assert.deepEqual(record.namespaces, ["/project/example-site/rejected/chen/"]);
  assert.deepEqual(record.sourceNamespaces, ["/project/example-site/proposals/chen/"]);
  assert.equal(record.metadata.rejectedBy.stringValue, "bruno");
  assert.equal(record.metadata.rejectedAt.stringValue, NOW.toISOString());
  assert.ok(!JSON.stringify(calls[1].input).includes("Duplicate"));
  assert.deepEqual(ledger.lines.map((line) => [line.action, line.reason, line.sourceNamespace]), [
    ["reject", "Duplicate of an existing record", "/project/example-site/proposals/chen/"],
    ["reject-done", "Duplicate of an existing record", "/project/example-site/proposals/chen/"]]);
  await assert.rejects(core.reject({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen", reason: " ", reviewer },
    async () => true), { code: "text_empty" });
});

test("approve refuses proposal_missing and proposal_outside_project before the question", async () => {
  const outside = summary("rec-two", "/project/example-site/proposals/chen/", "x",
    { namespaces: ["/project/example-site/proposals/chen/", "/project/example-site/shared/"] });
  const { core, calls } = makeCore(bruno, { records: [chenProposal, outside] });
  let asked = 0;
  const confirm = async () => { asked += 1; return true; };
  await assert.rejects(core.approve({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-absent", reviewer }, confirm),
    { code: "proposal_missing" });
  // A wrong proposer: the exact list of that proposer does not hold the record.
  await assert.rejects(core.approve({ projectId: "example-site", actorId: "bruno", memoryRecordId: "rec-chen", reviewer }, confirm),
    { code: "proposal_missing" });
  await assert.rejects(core.approve({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-two", reviewer }, confirm),
    { code: "proposal_outside_project" });
  await assert.rejects(core.reject({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-two", reason: "x", reviewer },
    confirm), { code: "proposal_outside_project" });
  await assert.rejects(core.approve({ projectId: "example-project", actorId: "chen", memoryRecordId: "rec-chen", reviewer }, confirm),
    { code: "not_maintainer" });
  assert.equal(asked, 0);
  assert.ok(calls.every((call) => call.method === "list"));
});

test("no move without confirmation; a failed move keeps only the intent line; a second approve finds no proposal", async () => {
  const ledger = memoryLedger();
  let listed = [chenProposal];
  let fail = true;
  const { core, calls, logs } = makeCore(bruno, { ledger, handlers: {
    list: exactStore(() => listed),
    batchUpdate: (input) => {
      if (fail) throw Object.assign(new Error("CANARY_SECRET"), { name: "AccessDeniedException" });
      return { successfulRecords: [{ memoryRecordId: input.records[0].memoryRecordId, status: "SUCCEEDED" }], failedRecords: [] };
    },
  } });
  const input = { projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen", reviewer };
  await assert.rejects(core.approve(input, async () => false), { code: "not_confirmed" });
  assert.deepEqual(ledger.lines, []);
  await assert.rejects(core.approve(input, async () => true), (error) => error.code === "aws_denied" && !/CANARY/.test(error.message));
  assert.deepEqual(ledger.lines.map((line) => line.action), ["approve"]);
  fail = false;
  await core.approve(input, async () => true);
  assert.deepEqual(logs, ["AgentCore Memory: an earlier move of this record has no end line in the ledger"]);
  assert.deepEqual(ledger.lines.map((line) => line.action), ["approve", "approve", "approve-done"]);
  listed = [];
  await assert.rejects(core.approve(input, async () => true), { code: "proposal_missing" });
  assert.equal(calls.filter((call) => call.method === "batchUpdate").length, 2);
});

test("a move counts as done only when the id is in successfulRecords", async () => {
  for (const answer of [
    { successfulRecords: [], failedRecords: [{ memoryRecordId: "rec-chen", status: "FAILED" }] },
    { successfulRecords: [{ memoryRecordId: "rec-other", status: "SUCCEEDED" }], failedRecords: [] },
    {},
  ]) {
    const ledger = memoryLedger();
    const { core } = makeCore(bruno, { ledger, records: [chenProposal], handlers: { batchUpdate: () => answer } });
    await assert.rejects(core.approve({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen", reviewer },
      async () => true), { code: "aws_failed" });
    assert.deepEqual(ledger.lines.map((line) => line.action), ["approve"]);
  }
});

test("a ledger that refuses the intent line stops the move; a failed end line is logged after the move", async () => {
  const broken = { append: async () => { throw new Error("CANARY_SECRET"); }, entriesFor: async () => [] };
  const stopped = makeCore(bruno, { ledger: broken, records: [chenProposal] });
  const input = { projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen", reviewer };
  await assert.rejects(stopped.core.approve(input, async () => true), { code: "ledger" });
  assert.ok(stopped.calls.every((call) => call.method === "list"));

  let appended = 0;
  const half = { append: async () => { appended += 1; if (appended > 1) throw new Error("CANARY_SECRET"); }, entriesFor: async () => [] };
  const moved = makeCore(bruno, { ledger: half, records: [chenProposal] });
  const result = await moved.core.approve(input, async () => true);
  assert.equal(result.targetNamespace, "/project/example-site/shared/");
  assert.deepEqual(moved.logs, ["AgentCore Memory: the move is done; the ledger end line failed"]);

  const unreadable = { append: async () => {}, entriesFor: async () => { throw new Error("CANARY_SECRET"); } };
  const refused = makeCore(bruno, { ledger: unreadable, records: [chenProposal] });
  let asked = false;
  await assert.rejects(refused.core.approve(input, async () => { asked = true; return true; }), { code: "ledger" });
  assert.equal(asked, false);
});

test("a reviewer origin is checked and the proposer origin is unused by review", async () => {
  const { core } = makeCore(bruno, { records: [chenProposal] });
  await assert.rejects(core.approve({ projectId: "example-site", actorId: "chen", memoryRecordId: "rec-chen",
    reviewer: { ...origin, harness: "x" } }, async () => true), { code: "config" });
});
