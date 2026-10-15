// The purge of rejected records: the rejected namespaces of one project, or of one actor in it.
// The live store lists one exact namespace, so the purge of a project lists the rejected namespace of each
// person of the registry. The dry run lists; only `--apply` deletes, with the admin login. Any other namespace is refused.

import { namespaces, validateId } from "./core.mjs";
import { LAG_LINE, LIST_FORM, deleteRecords, goneLines, listNamespaces, namespaceLines, within } from "./records.mjs";

const FIRST_LINE = 80;

/** The rejected tree to purge. It comes from the namespace builder only. */
export function purgeNamespace(projectId, actorId) {
  validateId(projectId, "--project");
  if (actorId === undefined) return namespaces.rejectedOfProject(projectId);
  validateId(actorId, "--person");
  return namespaces.rejected(projectId, actorId);
}

/** The exact namespaces to list: the one of `--person`, or the one of each person of the registry, every status. */
export function purgeNamespaces(registry, projectId, actorId) {
  purgeNamespace(projectId, actorId);
  const actors = actorId === undefined ? registry.people.map((person) => person.actorId) : [actorId];
  return actors.map((actor) => namespaces.rejected(projectId, actor));
}

function summary(record, tree) {
  const actor = record.listed.startsWith(tree) ? record.listed.slice(tree.length).split("/")[0] || "?" : "?";
  const date = record.metadata?.rejectedAt?.stringValue
    ?? (record.createdAt ? new Date(record.createdAt).toISOString() : "?");
  const line = typeof record.text === "string" ? record.text.split("\n")[0].slice(0, FIRST_LINE) : "";
  return `  ${record.memoryRecordId} ${actor} ${date} ${line}`;
}

/** The records of the exact namespaces. A record that names a namespace outside the rejected tree stops the step. */
async function rejectedRecords(memory, registry, projectId, actorId) {
  const tree = purgeNamespace(projectId, actorId);
  const { records, counts } = await listNamespaces(memory, registry.memory.memoryId, purgeNamespaces(registry, projectId, actorId));
  const outside = records.filter((record) => !within(record, [tree]));
  return { tree, project: namespaces.rejectedOfProject(projectId), records, counts, outside };
}

export async function purgePlan(registry, projectId, actorId, memory = null) {
  const tree = purgeNamespace(projectId, actorId);
  const found = memory ? await rejectedRecords(memory, registry, projectId, actorId) : null;
  const lines = [`purge: ${tree}`, ...namespaceLines(purgeNamespaces(registry, projectId, actorId), found?.counts)];
  if (actorId === undefined) lines.push("an actor outside the registry is not listed; give --person <actorId> for that namespace");
  if (!found) {
    lines.push("records: not listed; give --profile <admin> to list them (read-only calls)");
  } else {
    lines.push(`records to delete: ${found.records.length - found.outside.length} (${LIST_FORM})`);
    lines.push("  id actor date first line");
    for (const record of found.records) if (!found.outside.includes(record)) lines.push(summary(record, found.project));
    if (found.outside.length) {
      lines.push(`apply refuses: ${found.outside.length} record(s) name a namespace outside ${tree}`);
      for (const record of found.outside) lines.push(`  ${record.memoryRecordId}`);
    }
    lines.push(LAG_LINE);
  }
  lines.push("apply: delete the records in batches of 100 with BatchDeleteMemoryRecords, with the admin login only");
  return lines;
}

export async function purgeApply(registry, projectId, actorId, memory) {
  const found = await rejectedRecords(memory, registry, projectId, actorId);
  if (found.outside.length) {
    throw new Error(`${found.outside.length} record(s) name a namespace outside ${found.tree}; nothing deleted`);
  }
  // Each delete names the exact namespace that returned the record.
  const records = found.records.map((record) => ({ ...record, namespace: record.listed }));
  const result = await deleteRecords(memory, registry.memory.memoryId, records);
  return [`deleted ${result.deleted} rejected record(s) of ${found.tree}`, ...goneLines(result)];
}
