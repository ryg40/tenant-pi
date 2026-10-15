// Offboarding: the records of the person, then the access keys, the inline policy and the user,
// in that order; then the registry file. The dry run lists; only `--apply` deletes.

import { namespaces, validateId, validateRegistry } from "./core.mjs";
import { POLICY_NAME, userName } from "./render.mjs";
import { accessKeys, inlinePolicyNames, missing } from "./iam.mjs";
import { deleteRecords, listRecords, within } from "./records.mjs";

/** The namespaces of one person: own actor namespace, own proposals and own rejected records of every project of the registry. */
export function offboardNamespaces(registry, actorId) {
  return [namespaces.actor(actorId), ...registry.projects.flatMap((project) => [
    namespaces.proposals(project.projectId, actorId), namespaces.rejected(project.projectId, actorId)])];
}

/** The registry after the step: status `offboarded`, and the person leaves every member and maintainer list. */
export function offboardRegistry(registry, actorId) {
  for (const project of registry.projects) {
    if (project.maintainers.length === 1 && project.maintainers[0] === actorId) {
      throw new Error(`${actorId} is the last maintainer of ${project.projectId}; name another maintainer first`);
    }
  }
  const next = structuredClone(registry);
  next.people.find((person) => person.actorId === actorId).status = "offboarded";
  for (const project of next.projects) {
    project.members = project.members.filter((id) => id !== actorId);
    project.maintainers = project.maintainers.filter((id) => id !== actorId);
  }
  return validateRegistry(next);
}

function person(registry, actorId) {
  validateId(actorId, "--person");
  const found = registry.people.find((item) => item.actorId === actorId);
  if (!found) throw new Error("--person is not a person of the registry");
  return found;
}

/** The records to delete and the records to keep: a record that also names another namespace stays. */
async function personRecords(memory, registry, actorId) {
  const prefixes = offboardNamespaces(registry, actorId);
  const found = new Map();
  for (const namespace of prefixes) {
    for (const record of await listRecords(memory, registry.memory.memoryId, namespace)) {
      found.set(record.memoryRecordId, { ...record, listed: namespace });
    }
  }
  const remove = [], keep = [];
  for (const record of found.values()) {
    if (within(record, prefixes)) remove.push({ ...record, namespace: record.namespaces[0] });
    else keep.push(record);
  }
  return { remove, keep };
}

/** IAM items that this tool never creates. Their presence stops the apply before any delete. */
async function foreignItems(iam, user) {
  const found = [];
  const checks = [
    ["ListAttachedUserPolicies", "AttachedPolicies", "an attached managed policy"],
    ["ListGroupsForUser", "Groups", "a group"],
    ["ListMFADevices", "MFADevices", "an MFA device"],
    ["ListSigningCertificates", "Certificates", "a signing certificate"],
    ["ListSSHPublicKeys", "SSHPublicKeys", "an SSH public key"],
    ["ListServiceSpecificCredentials", "ServiceSpecificCredentials", "a service-specific credential"],
  ];
  for (const [name, field, label] of checks) {
    if ((await iam.send(name, { UserName: user }))[field]?.length) found.push(label);
  }
  try {
    await iam.send("GetLoginProfile", { UserName: user });
    found.push("console access");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const others = (await inlinePolicyNames(iam, user)).filter((name) => name !== POLICY_NAME);
  if (others.length) found.push("another inline policy");
  return found;
}

async function userState(iam, user) {
  try {
    await iam.send("GetUser", { UserName: user });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  return { keys: await accessKeys(iam, user), policies: await inlinePolicyNames(iam, user) };
}

/** The dry run. Without clients it lists from the registry only and makes no AWS call. */
export async function offboardPlan(registry, actorId, clients = null) {
  const subject = person(registry, actorId);
  const user = userName(actorId);
  const lines = [`person: ${actorId} (status ${subject.status})`, "namespaces of the person:"];
  for (const namespace of offboardNamespaces(registry, actorId)) lines.push(`  ${namespace}`);
  if (clients) {
    const { remove, keep } = await personRecords(clients.memory, registry, actorId);
    lines.push(`records to delete: ${remove.length} (request field namespace, prefix form)`);
    for (const record of remove) lines.push(`  ${record.memoryRecordId} ${record.namespaces.join(",")}`);
    if (keep.length) {
      lines.push(`records kept, because they also name another namespace: ${keep.length}`);
      for (const record of keep) lines.push(`  ${record.memoryRecordId}`);
    }
    const state = await userState(clients.iam, user);
    if (!state) lines.push(`iam user ${user}: absent`);
    else {
      lines.push(`iam user ${user}: ${state.keys.length} access key(s), inline policies: ${state.policies.join(",") || "none"}`);
      const foreign = await foreignItems(clients.iam, user);
      if (foreign.length) lines.push(`apply refuses: the user has ${foreign.join(", ")}`);
    }
  } else {
    lines.push("records: not listed; give --profile <admin> to list them (read-only calls)");
    lines.push(`iam user ${user}: keys and policies listed with --profile <admin>`);
  }
  offboardRegistry(registry, actorId);
  lines.push("apply order: delete the records in batches of 100, then the access keys, "
    + `the inline policy ${POLICY_NAME} and the user; then set the status offboarded `
    + "and remove the person from every member and maintainer list of the registry file");
  return lines;
}

/** The apply step. A refusal happens before the first delete. */
export async function offboardApply(registry, actorId, clients) {
  person(registry, actorId);
  const next = offboardRegistry(registry, actorId);
  const user = userName(actorId);
  const state = await userState(clients.iam, user);
  if (state) {
    const foreign = await foreignItems(clients.iam, user);
    if (foreign.length) throw new Error(`user ${user} has ${foreign.join(", ")}; remove it by hand first`);
  }
  const done = [];
  const { remove, keep } = await personRecords(clients.memory, registry, actorId);
  done.push(`deleted ${await deleteRecords(clients.memory, registry.memory.memoryId, remove)} record(s)`);
  if (keep.length) done.push(`kept ${keep.length} record(s) that also name another namespace`);
  if (state) {
    for (const key of state.keys) await clients.iam.send("DeleteAccessKey", { UserName: user, AccessKeyId: key.AccessKeyId });
    done.push(`deleted ${state.keys.length} access key(s)`);
    if (state.policies.includes(POLICY_NAME)) {
      await clients.iam.send("DeleteUserPolicy", { UserName: user, PolicyName: POLICY_NAME });
      done.push(`deleted inline policy ${POLICY_NAME}`);
    }
    await clients.iam.send("DeleteUser", { UserName: user });
    done.push(`deleted user ${user}`);
  } else {
    done.push(`user ${user} was absent`);
  }
  return { done, registry: next };
}
