// Fake AWS clients and helpers of the tests. No test needs a credential or a network.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/cli.mjs";

export const EXAMPLE = path.resolve(import.meta.dirname, "../registry.example.json");
export const example = () => JSON.parse(readFileSync(EXAMPLE, "utf8"));
export const ACCOUNT = "111122223333";
export const SECRET = "canary-canary-canary-canary";

function notFound() {
  const error = new Error("not found: request data");
  error.name = "NoSuchEntityException";
  return error;
}

/** An in-memory IAM with users, inline policies, keys, tags and customer managed policies. */
export function fakeIam(state = {}) {
  const users = state.users ?? new Map();
  const managed = state.managed ?? new Map();
  const calls = [];
  let keyNumber = 0;
  const user = (name) => {
    if (!users.has(name)) throw notFound();
    return users.get(name);
  };
  const send = async (name, input) => {
    calls.push({ name, input });
    switch (name) {
      case "GetUser": user(input.UserName); return { User: { UserName: input.UserName } };
      case "CreateUser":
        users.set(input.UserName, { policies: new Map(), keys: [], tags: [], attached: [], login: false });
        return { User: { UserName: input.UserName } };
      case "ListUsers": return { Users: [...users.keys()].map((UserName) => ({ UserName })) };
      case "GetUserPolicy": {
        const document = user(input.UserName).policies.get(input.PolicyName);
        if (!document) throw notFound();
        return { PolicyDocument: encodeURIComponent(document) };
      }
      case "PutUserPolicy": user(input.UserName).policies.set(input.PolicyName, input.PolicyDocument); return {};
      case "DeleteUserPolicy": user(input.UserName).policies.delete(input.PolicyName); return {};
      case "ListUserPolicies": return { PolicyNames: [...user(input.UserName).policies.keys()] };
      case "ListAttachedUserPolicies": return { AttachedPolicies: user(input.UserName).attached };
      case "TagUser": {
        const target = user(input.UserName);
        for (const tag of input.Tags) target.tags = [...target.tags.filter((item) => item.Key !== tag.Key), tag];
        return {};
      }
      case "ListUserTags": return { Tags: user(input.UserName).tags };
      case "ListAccessKeys": return { AccessKeyMetadata: user(input.UserName).keys.map((AccessKeyId) => ({ AccessKeyId })) };
      case "CreateAccessKey": {
        const AccessKeyId = `EXAMPLEKEYID${++keyNumber}`;
        user(input.UserName).keys.push(AccessKeyId);
        return { AccessKey: { UserName: input.UserName, AccessKeyId, Status: "Active", SecretAccessKey: SECRET } };
      }
      case "DeleteAccessKey": {
        const target = user(input.UserName);
        target.keys = target.keys.filter((id) => id !== input.AccessKeyId);
        return {};
      }
      case "GetLoginProfile": if (!user(input.UserName).login) throw notFound(); return {};
      case "ListGroupsForUser": user(input.UserName); return { Groups: [] };
      case "ListMFADevices": user(input.UserName); return { MFADevices: [] };
      case "ListSigningCertificates": user(input.UserName); return { Certificates: [] };
      case "ListSSHPublicKeys": user(input.UserName); return { SSHPublicKeys: [] };
      case "ListServiceSpecificCredentials": user(input.UserName); return { ServiceSpecificCredentials: [] };
      case "DeleteUser": {
        const target = user(input.UserName);
        if (target.keys.length || target.policies.size) throw Object.assign(new Error("conflict"), { name: "DeleteConflictException" });
        users.delete(input.UserName);
        return {};
      }
      case "GetPolicy": return { Policy: { DefaultVersionId: managed.get(input.PolicyArn).versions.find((v) => v.default).id } };
      case "GetPolicyVersion":
        return { PolicyVersion: { Document: encodeURIComponent(managed.get(input.PolicyArn).versions.find((v) => v.id === input.VersionId).document) } };
      case "ListPolicyVersions": return { Versions: managed.get(input.PolicyArn).versions.map((v) => ({ VersionId: v.id })) };
      case "CreatePolicyVersion": {
        const policy = managed.get(input.PolicyArn);
        if (input.SetAsDefault) policy.versions.forEach((v) => { v.default = false; });
        policy.versions.push({ id: `v${policy.versions.length + 1}`, document: input.PolicyDocument, default: Boolean(input.SetAsDefault) });
        return {};
      }
      case "DeletePolicyVersion": {
        const policy = managed.get(input.PolicyArn);
        policy.versions = policy.versions.filter((v) => v.id !== input.VersionId || v.default);
        return {};
      }
      default: throw new Error(`fake IAM has no ${name}`);
    }
  };
  return { send, destroy: () => calls.push({ name: "destroy" }), calls, users, managed };
}

/** An in-memory memory store. `ListMemoryRecords` answers with the records of the exact namespace only, as the
 * live store does (`exactStore` of the core tests is the model): a list of a tree prefix gets no record. It pages by two.
 * `lagging` holds records that the list index still returns but that the store no longer holds, as after a delete on the
 * live store. A delete or a move of a record that the store does not hold fails with `errorCode` 404. `failures` maps a
 * record id to the `errorCode` and `errorMessage` of a failed delete or move. The message texts of the fake are not the live texts. */
export function fakeMemory(records = [], { lagging = [], failures = {} } = {}) {
  const store = records.map((record) => structuredClone(record));
  const index = lagging.map((record) => structuredClone(record));
  const calls = [];
  const outcome = (memoryRecordId, apply) => {
    if (failures[memoryRecordId]) return { memoryRecordId, status: "FAILED", ...failures[memoryRecordId] };
    const record = store.find((entry) => entry.memoryRecordId === memoryRecordId);
    if (!record) return { memoryRecordId, status: "FAILED", errorCode: 404, errorMessage: "fake: the memory record does not exist" };
    apply(record);
    return { memoryRecordId, status: "SUCCEEDED" };
  };
  const answer = (results) => ({ successfulRecords: results.filter((item) => item.status === "SUCCEEDED"),
    failedRecords: results.filter((item) => item.status === "FAILED") });
  const send = async (name, input) => {
    calls.push({ name, input });
    if (name === "ListMemoryRecords") {
      const matches = [...store, ...index].filter((record) => record.namespaces.includes(input.namespace));
      const start = Number(input.nextToken ?? 0);
      return { memoryRecordSummaries: matches.slice(start, start + 2).map((record) => ({ ...record, content: { text: record.text } })),
        nextToken: start + 2 < matches.length ? String(start + 2) : undefined };
    }
    if (name === "BatchDeleteMemoryRecords") {
      return answer(input.records.map((item) => outcome(item.memoryRecordId, (record) => store.splice(store.indexOf(record), 1))));
    }
    if (name === "BatchUpdateMemoryRecords") {
      return answer(input.records.map((item) => outcome(item.memoryRecordId, (record) => {
        record.namespaces = item.namespaces;
        record.metadata = item.metadata;
      })));
    }
    throw new Error(`fake memory has no ${name}`);
  };
  return { send, destroy: () => calls.push({ name: "destroy" }), calls, store };
}

export const record = (memoryRecordId, namespace, text = `text of ${memoryRecordId}`, extra = {}) =>
  ({ memoryRecordId, namespaces: [namespace], text, createdAt: "2026-01-02T03:04:05.000Z", metadata: {}, ...extra });

/** Factories that fail the test when a command creates any AWS client. */
export const blocked = () => {
  const fail = () => { throw new Error("blocked: no AWS client may be created"); };
  return { createIam: fail, createSts: fail, createMemory: fail };
};

/** Run the command line with fakes; collect the output. `files` replaces the registry reads and writes. */
export async function run(argv, overrides = {}) {
  const out = [], err = [];
  const written = [];
  const deps = {
    ...blocked(),
    out: (line) => out.push(line), err: (line) => err.push(line),
    now: () => new Date("2026-02-03T04:05:06.000Z"),
    repositoryRoot: path.resolve(import.meta.dirname, "../../.."),
    keyDir: mkdtempSync(path.join(tmpdir(), "agentcore-admin-keys-")),
    readRegistry: (file) => readFileSync(file, "utf8"),
    writeRegistry: (file, registry) => written.push({ file, registry }),
    ...overrides,
  };
  const code = await main(argv, deps);
  return { code, out: out.join("\n"), err: err.join("\n"), written, deps };
}

/** A registry file outside the repository with real-looking values, for the apply tests. */
export function privateRegistry(change = (value) => value) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentcore-admin-registry-"));
  const file = path.join(dir, "registry.json");
  const value = change({ ...example(), memory: { region: "us-east-1", memoryId: "mem-PRIVATE01" } });
  return { file, value, read: () => JSON.stringify(value) };
}
