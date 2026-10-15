// Shared fakes of the tests. No AWS credential, no network, no Git process.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore } from "../src/index.mjs";

export const chen = {
  schemaVersion: 1, memoryId: "mem-EXAMPLE", region: "us-east-1", actorId: "chen", topK: 5,
  projects: [
    { projectId: "example-project", role: "member", remotes: ["https://git.example.com/example/example-project.git"] },
    { projectId: "example-site", role: "member", remotes: ["git@git.example.com:example/example-site.git"] },
  ],
  hostLabel: "chen-laptop",
};

export const bruno = {
  schemaVersion: 1, memoryId: "mem-EXAMPLE", region: "us-east-1", actorId: "bruno",
  projects: [
    { projectId: "example-project", role: "member" },
    { projectId: "example-site", role: "maintainer", remotes: ["git@git.example.com:example/example-site.git"] },
  ],
  hostLabel: "bruno-desk",
};

export const origin = { agent: "example-agent", harness: "pi", session: "session-example" };
export const NOW = new Date("2026-10-15T12:00:00.000Z");

/** A temporary directory below TMPDIR. The tests never delete: the TMPDIR of the run holds them. */
export const scratch = (name) => mkdtempSync(join(tmpdir(), `agentcore-memory-${name}-`));

/**
 * A list handler like the live store: the request field `namespace` is an exact match, so a list on a tree
 * prefix such as `/project/{p}/proposals/` returns no record. `maxResults` records per page, with `nextToken`.
 * `records` is an array or a function that gives the array at each call.
 */
export function exactStore(records) {
  return (input) => {
    const all = (typeof records === "function" ? records() : records)
      .filter((record) => Array.isArray(record.namespaces) && record.namespaces.includes(input.namespace));
    const start = input.nextToken ? Number(input.nextToken.slice(5)) : 0;
    const end = start + input.maxResults;
    return { memoryRecordSummaries: all.slice(start, end), ...(end < all.length ? { nextToken: `page-${end}` } : {}) };
  };
}

/** A fake client that records each call. `handlers` replace a method. Without a list handler, `list` is `exactStore(records)`. */
export function fakeClient(handlers = {}, records = []) {
  const calls = [];
  const client = {};
  const list = exactStore(records);
  for (const method of ["retrieve", "list", "batchCreate", "batchUpdate"]) {
    client[method] = async (input, options) => {
      calls.push({ method, input, options });
      if (handlers[method]) return handlers[method](input, options);
      if (method === "list") return list(input);
      if (method === "retrieve") return { memoryRecordSummaries: [] };
      if (method === "batchCreate") {
        return { successfulRecords: input.records.map((record, index) => ({
          memoryRecordId: `mem-record-${index + 1}`, status: "SUCCEEDED", requestIdentifier: record.requestIdentifier,
        })), failedRecords: [] };
      }
      return { successfulRecords: input.records.map((record) => ({ memoryRecordId: record.memoryRecordId, status: "SUCCEEDED" })),
        failedRecords: [] };
    };
  }
  client.destroy = () => calls.push({ method: "destroy" });
  return { client, calls };
}

/** An in-memory ledger with the contract of `ReviewLedger`. */
export function memoryLedger(initial = []) {
  const lines = [...initial];
  return {
    lines,
    append: async (entry) => { lines.push(JSON.parse(JSON.stringify(entry))); },
    entriesFor: async (id) => lines.filter((entry) => entry.proposalRecordId === id),
  };
}

export function makeCore(config, { handlers, records, remote = null, ledger, log } = {}) {
  const fake = fakeClient(handlers, records);
  const logs = [];
  const core = createCore(config, {
    createClient: async () => fake.client, gitRemote: async () => remote, ledger: ledger ?? memoryLedger(),
    now: () => NOW, hostname: () => "host-not-used", log: log ?? ((line) => logs.push(line)),
  });
  return { core, calls: fake.calls, logs };
}

export const summary = (memoryRecordId, namespace, text, extra = {}) => ({
  memoryRecordId, namespaces: [namespace], content: { text }, createdAt: NOW, ...extra,
});
