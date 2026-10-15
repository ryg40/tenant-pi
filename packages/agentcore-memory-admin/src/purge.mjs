// The purge of rejected records: the rejected tree of one project, or of one actor in it.
// The dry run lists; only `--apply` deletes, with the admin login. Any other namespace is refused.

import { namespaces, validateId } from "./core.mjs";
import { deleteRecords, listRecords, within } from "./records.mjs";

const FIRST_LINE = 80;

/** The rejected tree to purge. It comes from the namespace builder only. */
export function purgeNamespace(projectId, actorId) {
  validateId(projectId, "--project");
  if (actorId === undefined) return namespaces.rejectedOfProject(projectId);
  validateId(actorId, "--person");
  return namespaces.rejected(projectId, actorId);
}

function summary(record, tree) {
  const namespace = record.namespaces[0] ?? "";
  const actor = namespace.startsWith(tree) ? namespace.slice(tree.length).split("/")[0] || "?" : "?";
  const date = record.metadata?.rejectedAt?.stringValue
    ?? (record.createdAt ? new Date(record.createdAt).toISOString() : "?");
  const line = typeof record.text === "string" ? record.text.split("\n")[0].slice(0, FIRST_LINE) : "";
  return `  ${record.memoryRecordId} ${actor} ${date} ${line}`;
}

/** The records of the tree. A record that names a namespace outside the rejected tree stops the step. */
async function rejectedRecords(memory, registry, projectId, actorId) {
  const tree = purgeNamespace(projectId, actorId);
  const listed = await listRecords(memory, registry.memory.memoryId, tree);
  const outside = listed.filter((record) => !within(record, [tree]));
  return { tree, project: namespaces.rejectedOfProject(projectId), listed, outside };
}

export async function purgePlan(registry, projectId, actorId, memory = null) {
  const tree = purgeNamespace(projectId, actorId);
  const lines = [`purge: ${tree}`];
  if (!memory) {
    lines.push("records: not listed; give --profile <admin> to list them (read-only calls)");
  } else {
    const found = await rejectedRecords(memory, registry, projectId, actorId);
    lines.push(`records to delete: ${found.listed.length - found.outside.length} (request field namespace, prefix form)`);
    lines.push("  id actor date first line");
    for (const record of found.listed) if (!found.outside.includes(record)) lines.push(summary(record, found.project));
    if (found.outside.length) {
      lines.push(`apply refuses: ${found.outside.length} record(s) name a namespace outside ${tree}`);
      for (const record of found.outside) lines.push(`  ${record.memoryRecordId}`);
    }
  }
  lines.push("apply: delete the records in batches of 100 with BatchDeleteMemoryRecords, with the admin login only");
  return lines;
}

export async function purgeApply(registry, projectId, actorId, memory) {
  const found = await rejectedRecords(memory, registry, projectId, actorId);
  if (found.outside.length) {
    throw new Error(`${found.outside.length} record(s) name a namespace outside ${found.tree}; nothing deleted`);
  }
  const records = found.listed.map((record) => ({ ...record, namespace: record.namespaces[0] }));
  return [`deleted ${await deleteRecords(memory, registry.memory.memoryId, records)} rejected record(s) of ${found.tree}`];
}
