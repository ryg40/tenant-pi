// The one-time migration of the old owner namespace: delete the live-check test records and the
// smoke record, move each other record of `/owner/<a>/` to `/actor/<a>/` with
// `BatchUpdateMemoryRecords`, then narrow the two customer managed policies of the service
// identities. The dry run lists; only `--apply` writes.

import { namespaces, validateId } from "./core.mjs";
import { renderService, usage } from "./render.mjs";
import { attachedPolicies, defaultVersion, samePolicy } from "./iam.mjs";
import { deleteRecords, listRecords, moveRecords, within } from "./records.mjs";

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
// IAM keeps at most five versions of a managed policy.
const VERSION_LIMIT = 5;

export function migrationNamespaces(ownerId) {
  validateId(ownerId, "--owner");
  return {
    tests: ["/shared/livecheck/", `/owner/${ownerId}/livecheck/`],
    old: `/owner/${ownerId}/`,
    target: namespaces.actor(ownerId),
  };
}

const moved = (namespace, ns) => ns.target + namespace.slice(ns.old.length);

function owner(registry, ownerId) {
  const ns = migrationNamespaces(ownerId);
  const found = registry.people.find((person) => person.actorId === ownerId);
  if (!found || found.status !== "active") throw new Error("--owner must be an active person of the registry");
  return ns;
}

/** The namespace patterns of the conditions of a policy document, for a short difference line. */
function patterns(document) {
  const found = new Set();
  for (const statement of document?.Statement ?? []) {
    for (const block of Object.values(statement.Condition ?? {})) {
      const values = block?.["bedrock-agentcore:namespace"];
      if (Array.isArray(values)) values.forEach((value) => found.add(value));
      else if (typeof values === "string" && values !== "false") found.add(values);
    }
  }
  return [...found];
}

async function records(memory, registry, ns, smokeRecordId) {
  const memoryId = registry.memory.memoryId;
  const tests = new Map();
  for (const prefix of ns.tests) {
    for (const record of await listRecords(memory, memoryId, prefix)) {
      if (within(record, ns.tests)) tests.set(record.memoryRecordId, record);
    }
  }
  let smoke = null;
  if (smokeRecordId) {
    smoke = (await listRecords(memory, memoryId, namespaces.global())).find((record) => record.memoryRecordId === smokeRecordId) ?? null;
    if (smoke && !within(smoke, [namespaces.global()])) throw new Error("--smoke-record-id names a record outside /shared/");
  }
  const old = await listRecords(memory, memoryId, ns.old);
  const move = [], keep = [];
  for (const record of old) {
    if (tests.has(record.memoryRecordId)) continue;
    // A record has one namespace; a move names one source and one target.
    if (record.namespaces.length === 1 && within(record, [ns.old])) move.push(record);
    else keep.push(record);
  }
  return { tests: [...tests.values()], smoke, move, keep, listed: old.length };
}

async function servicePolicies(iam, registry, options) {
  const result = [];
  for (const [kind, label] of [["worker", "read identity"], ["submit", "submit identity"]]) {
    const rendered = renderService(registry, kind, options);
    const managed = (await attachedPolicies(iam, rendered.userName)).filter((item) => !item.PolicyArn?.startsWith("arn:aws:iam::aws:"));
    if (managed.length !== 1) throw new Error(`the ${label} has ${managed.length} customer managed policies; the migration needs one`);
    const current = await defaultVersion(iam, managed[0].PolicyArn);
    result.push({ kind, label, rendered, arn: managed[0].PolicyArn, current });
  }
  return result;
}

const recordLine = (record) => `  ${record.memoryRecordId} ${record.namespaces.join(",")}`;

/** The dry run. Without clients it lists from the registry only and makes no AWS call. */
export async function migratePlan(registry, ownerId, options, clients = null) {
  const ns = owner(registry, ownerId);
  if (options.smokeRecordId !== undefined && !RECORD_ID.test(options.smokeRecordId)) throw usage("--smoke-record-id has an invalid value");
  const lines = [`owner: ${ownerId}`, `test namespaces: ${ns.tests.join(", ")}`, `move: ${ns.old} to ${ns.target}`];
  if (clients) {
    const found = await records(clients.memory, registry, ns, options.smokeRecordId);
    lines.push(`list form: request field namespace with the prefix ${ns.old}; ${found.listed} record(s) listed`);
    lines.push(`test records to delete: ${found.tests.length}`, ...found.tests.map(recordLine));
    if (options.smokeRecordId) lines.push(`smoke record: ${found.smoke ? recordLine(found.smoke).trim() : "not found in /shared/"}`);
    lines.push(`records to move: ${found.move.length}`,
      ...found.move.map((record) => `${recordLine(record)} -> ${record.namespaces.map((n) => moved(n, ns)).join(",")}`));
    if (found.keep.length) lines.push(`records kept, because they name another or a second namespace: ${found.keep.length}`, ...found.keep.map(recordLine));
  } else {
    lines.push("records: not listed; give --profile <admin> to list them (read-only calls)");
    if (options.smokeRecordId) lines.push(`smoke record: ${options.smokeRecordId}, looked up in /shared/ with --profile <admin>`);
  }
  const policies = clients ? await servicePolicies(clients.iam, registry, options) : null;
  for (const [kind, label] of [["worker", "read identity"], ["submit", "submit identity"]]) {
    const rendered = renderService(registry, kind, options);
    lines.push(`${label} policy: target namespaces ${patterns(rendered.shown).join(", ")}`);
    const live = policies?.find((item) => item.kind === kind);
    if (live) {
      lines.push(`  current namespaces ${patterns(live.current.document).join(", ") || "none"}; `
        + `${live.current.count} version(s); ${samePolicy(live.current.document, rendered.real ?? {}) ? "no change" : "new default version"}`);
      if (live.current.count >= VERSION_LIMIT) lines.push("  apply refuses: the policy has five versions; delete an old version first");
    } else {
      lines.push("  current policy: read with --profile <admin>");
    }
    lines.push(`  target policy: ${JSON.stringify(rendered.shown)}`);
  }
  lines.push("apply order: delete the test records and the smoke record; move each other record "
    + `to ${ns.target} with BatchUpdateMemoryRecords (sourceNamespaces the old namespace, metadata actorId, `
    + "harness migration, proposedAt); then create a new default version of each policy and delete the old version");
  return lines;
}

function metadata(ownerId, record, now) {
  const createdAt = record.createdAt ? new Date(record.createdAt) : null;
  const proposedAt = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : now();
  return { actorId: { stringValue: ownerId }, harness: { stringValue: "migration" },
    proposedAt: { stringValue: proposedAt.toISOString() } };
}

/** The apply step. Every refusal happens before the first write. */
export async function migrateApply(registry, ownerId, options, clients, now) {
  const ns = owner(registry, ownerId);
  const memoryId = registry.memory.memoryId;
  const policies = await servicePolicies(clients.iam, registry, options);
  for (const policy of policies) {
    if (!policy.rendered.real) throw new Error("the account id is unknown");
    if (policy.current.count >= VERSION_LIMIT && !samePolicy(policy.current.document, policy.rendered.real)) {
      throw new Error(`the ${policy.label} policy has five versions; delete an old version first`);
    }
  }
  const found = await records(clients.memory, registry, ns, options.smokeRecordId);
  const done = [];
  const tests = [...found.tests, ...(found.smoke ? [found.smoke] : [])].map((record) => ({ ...record, namespace: record.namespaces[0] }));
  done.push(`deleted ${await deleteRecords(clients.memory, memoryId, tests)} test record(s)`);

  // A move keeps the record id. A record that a stopped run moved is no longer under the old prefix.
  const moves = found.move.map((record) => ({ memoryRecordId: record.memoryRecordId, timestamp: now(),
    sourceNamespaces: [record.namespaces[0]], namespaces: [moved(record.namespaces[0], ns)], metadata: metadata(ownerId, record, now) }));
  done.push(`moved ${await moveRecords(clients.memory, memoryId, moves)} record(s) from ${ns.old} to ${ns.target}`);
  if (found.keep.length) done.push(`kept ${found.keep.length} record(s) that name another or a second namespace`);

  for (const policy of policies) {
    if (samePolicy(policy.current.document, policy.rendered.real)) { done.push(`${policy.label} policy is current`); continue; }
    await clients.iam.send("CreatePolicyVersion", { PolicyArn: policy.arn, PolicyDocument: JSON.stringify(policy.rendered.real),
      SetAsDefault: true });
    await clients.iam.send("DeletePolicyVersion", { PolicyArn: policy.arn, VersionId: policy.current.versionId });
    done.push(`${policy.label} policy: new default version; deleted the old version`);
  }
  return done;
}
