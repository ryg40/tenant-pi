// IAM: the provisioning plan and apply, the key rotation, the live check and the account id.
// Every IAM call goes through `client.send(name, input)`, so a test gives a fake client.
// An output line never holds a secret access key; only the key file does.

import { constants, mkdirSync, openSync, writeSync, closeSync, statSync, lstatSync, rmSync } from "node:fs";
import path from "node:path";
import { POLICY_NAME, TAGS, USER_PREFIX, renderPerson, renderService, userName, usage } from "./render.mjs";

const ACCOUNT = /^[0-9]{12}$/;

async function sdkClient(packageName, Client, config) {
  const sdk = await import(packageName);
  const client = new sdk[Client]({ maxAttempts: 2, ...config });
  return {
    send: (name, input) => client.send(new sdk[`${name}Command`](input)),
    destroy: () => client.destroy(),
  };
}

/** IAM is a global service; the SDK signs its calls for `us-east-1`. */
export const createIamClient = (profile) => sdkClient("@aws-sdk/client-iam", "IAMClient", { region: "us-east-1", profile });
export const createStsClient = (profile) => sdkClient("@aws-sdk/client-sts", "STSClient", { region: "us-east-1", profile });

export const missing = (error) => error?.name === "NoSuchEntityException" || error?.name === "NoSuchEntity";

/** The account id from `--account`, else from `sts get-caller-identity` with the admin profile. */
export async function resolveAccount(options, deps) {
  if (options.account !== undefined) {
    if (!ACCOUNT.test(options.account)) throw usage("--account must have 12 digits");
    return options.account;
  }
  if (!options.profile) return undefined;
  const sts = await deps.createSts(options.profile);
  try {
    const identity = await sts.send("GetCallerIdentity", {});
    if (!ACCOUNT.test(identity.Account ?? "")) throw new Error("account");
    return identity.Account;
  } finally {
    sts.destroy?.();
  }
}

/** IAM returns a policy document URL-encoded (RFC 3986). Parse both forms. */
export function parsePolicy(text) {
  if (typeof text !== "string") return null;
  for (const candidate of [text, safeDecode(text)]) {
    try { return JSON.parse(candidate); } catch { /* try the next form */ }
  }
  return null;
}

function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** Key order does not matter for IAM; compare with sorted keys. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export const samePolicy = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export function provisionPlan(rendered) {
  return [
    `create user ${rendered.userName} (no console access), unless it exists`,
    `put inline policy ${POLICY_NAME} (${rendered.size} characters), only when it differs`,
    `tag purpose=agentcore-memory actorId=${rendered.actorId}`,
    `create one access key, only when the user has none; write it once into a new key file (mode 0600)`,
  ];
}

async function inlinePolicy(iam, user) {
  try {
    const result = await iam.send("GetUserPolicy", { UserName: user, PolicyName: POLICY_NAME });
    return parsePolicy(result.PolicyDocument);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function userExists(iam, user) {
  try {
    await iam.send("GetUser", { UserName: user });
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function listAll(iam, name, input, field) {
  const items = [];
  let Marker;
  do {
    const page = await iam.send(name, { ...input, ...(Marker ? { Marker } : {}) });
    items.push(...(page[field] ?? []));
    Marker = page.IsTruncated ? page.Marker : undefined;
  } while (Marker);
  return items;
}

export const accessKeys = (iam, user) => listAll(iam, "ListAccessKeys", { UserName: user }, "AccessKeyMetadata");
export const inlinePolicyNames = (iam, user) => listAll(iam, "ListUserPolicies", { UserName: user }, "PolicyNames");
export const attachedPolicies = (iam, user) => listAll(iam, "ListAttachedUserPolicies", { UserName: user }, "AttachedPolicies");

/** The private key directory. It is outside the repository and is not a symbolic link. */
export function keyDirectory(dir, repositoryRoot) {
  const resolved = path.resolve(dir);
  if (resolved === repositoryRoot || resolved.startsWith(repositoryRoot + path.sep)) {
    throw usage("--key-dir must be outside the repository");
  }
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (lstatSync(resolved).isSymbolicLink() || !statSync(resolved).isDirectory()) throw usage("--key-dir must be a directory");
  return resolved;
}

/** Open a new file with mode 0600. An existing file is never overwritten; a second file of the same second gets a suffix. */
function reserve(dir, base, extension) {
  for (let n = 1; n <= 100; n += 1) {
    const file = path.join(dir, `${base}${n === 1 ? "" : `-${n}`}${extension}`);
    try {
      return { file, fd: openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("no free file name in the key directory");
}

export function writePrivateFile(dir, base, extension, text) {
  const { file, fd } = reserve(dir, base, extension);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return file;
}

function credentialsText(profile, key) {
  return `[${profile}]\naws_access_key_id = ${key.AccessKeyId}\naws_secret_access_key = ${key.SecretAccessKey}\n`;
}

function stamp(now) {
  return now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The key file is open before the key exists, so a file error cannot lose a new key. */
async function writeKey(iam, user, deps, keyDir) {
  const { file, fd } = reserve(keyDir, `${user}-${stamp(deps.now)}`, ".credentials");
  let created = false;
  try {
    const result = await iam.send("CreateAccessKey", { UserName: user });
    created = true;
    writeSync(fd, credentialsText(user, result.AccessKey));
    return { file, accessKeyId: result.AccessKey.AccessKeyId };
  } finally {
    closeSync(fd);
    // The reserved file stays empty when IAM made no key; remove only that file.
    if (!created) rmSync(file, { force: true });
  }
}

/** Create or update the user of one person. Idempotent: an existing user gets only the differences. */
export async function provisionApply(rendered, iam, deps, keyDir) {
  const user = rendered.userName;
  const done = [];
  if (await userExists(iam, user)) {
    done.push(`user ${user} exists`);
  } else {
    await iam.send("CreateUser", { UserName: user });
    done.push(`created user ${user}`);
  }
  const others = (await inlinePolicyNames(iam, user)).filter((name) => name !== POLICY_NAME);
  if (others.length) throw new Error(`user ${user} has another inline policy; remove it by hand first`);
  const current = await inlinePolicy(iam, user);
  if (current && samePolicy(current, rendered.real)) {
    done.push(`inline policy ${POLICY_NAME} is current`);
  } else {
    await iam.send("PutUserPolicy", { UserName: user, PolicyName: POLICY_NAME, PolicyDocument: JSON.stringify(rendered.real) });
    done.push(`${current ? "updated" : "put"} inline policy ${POLICY_NAME}`);
  }
  const tags = await listAll(iam, "ListUserTags", { UserName: user }, "Tags");
  if (TAGS(rendered.actorId).every((tag) => tags.some((item) => item.Key === tag.Key && item.Value === tag.Value))) {
    done.push("tags purpose and actorId are current");
  } else {
    await iam.send("TagUser", { UserName: user, Tags: TAGS(rendered.actorId) });
    done.push("tagged purpose and actorId");
  }
  const keys = await accessKeys(iam, user);
  if (keys.length) {
    done.push(`user has ${keys.length} access key(s); no new key`);
  } else {
    const key = await writeKey(iam, user, deps, keyDir);
    done.push(`created one access key; key file ${key.file}`);
    // The handoff sends the key and the config together; the config names the profile, never the key.
    const config = writePrivateFile(keyDir, `${user}-${stamp(deps.now)}`, ".config.json",
      `${JSON.stringify({ ...rendered.config, profile: user }, null, 2)}\n`);
    done.push(`person config file ${config}`);
  }
  return done;
}

export function rotatePlan(rendered) {
  return [
    `list the access keys of ${rendered.userName}; refuse when it has two`,
    "create the second access key; write it once into a new key file (mode 0600)",
    "print the command that deletes the first key after the handoff",
  ];
}

export async function rotateApply(rendered, iam, deps, keyDir, profile) {
  const user = rendered.userName;
  const keys = await accessKeys(iam, user);
  if (keys.length !== 1) throw new Error(`user ${user} has ${keys.length} access keys; rotation needs exactly one`);
  const key = await writeKey(iam, user, deps, keyDir);
  return [
    `created the second access key; key file ${key.file}`,
    "after the handoff, delete the first key:",
    `aws iam delete-access-key --user-name ${user} --access-key-id ${keys[0].AccessKeyId} --profile ${profile}`,
  ];
}

/** Read-only IAM calls: the live users, their inline policies and keys against the registry. */
export async function checkLive(registry, iam, options) {
  const lines = [];
  const differ = (text) => lines.push(`differs: ${text}`);
  const known = new Set();
  for (const person of registry.people) {
    const user = userName(person.actorId);
    known.add(user);
    const exists = await userExists(iam, user);
    if (person.status === "offboarded") {
      if (exists) differ(`${user} exists, but ${person.actorId} is offboarded`);
      continue;
    }
    if (!exists) { differ(`${user} is missing`); continue; }
    const rendered = renderPerson(registry, person.actorId, options);
    const names = await inlinePolicyNames(iam, user);
    if (names.some((name) => name !== POLICY_NAME)) differ(`${user} has another inline policy`);
    const current = await inlinePolicy(iam, user);
    if (!current) differ(`${user} has no inline policy ${POLICY_NAME}`);
    else if (!samePolicy(current, rendered.real)) differ(`${user} inline policy ${POLICY_NAME} is not the rendered policy`);
    if ((await attachedPolicies(iam, user)).length) differ(`${user} has an attached managed policy`);
    const keys = await accessKeys(iam, user);
    if (keys.length !== 1) differ(`${user} has ${keys.length} access keys`);
    const tags = await listAll(iam, "ListUserTags", { UserName: user }, "Tags");
    for (const tag of TAGS(person.actorId)) {
      if (!tags.some((item) => item.Key === tag.Key && item.Value === tag.Value)) differ(`${user} lacks the tag ${tag.Key}`);
    }
    try {
      await iam.send("GetLoginProfile", { UserName: user });
      differ(`${user} has console access`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  for (const user of await listAll(iam, "ListUsers", {}, "Users")) {
    if (user.UserName?.startsWith(USER_PREFIX) && !known.has(user.UserName)) differ(`${user.UserName} is not in the registry`);
  }
  for (const kind of ["submit", "worker"]) {
    const rendered = renderService(registry, kind, options);
    const label = options.showValues ? rendered.userName : `<${kind} user>`;
    const managed = (await attachedPolicies(iam, rendered.userName)).filter((item) => !item.PolicyArn?.startsWith("arn:aws:iam::aws:"));
    if (managed.length !== 1) { differ(`${label} has ${managed.length} customer managed policies`); continue; }
    const current = await defaultVersion(iam, managed[0].PolicyArn);
    if (!samePolicy(current.document, rendered.real)) differ(`${label} policy is not the rendered ${kind} policy`);
  }
  lines.push(lines.length ? `${lines.length} difference(s)` : "no difference");
  return lines;
}

/** The default version of a customer managed policy: its id, document and the version count. */
export async function defaultVersion(iam, arn) {
  const policy = await iam.send("GetPolicy", { PolicyArn: arn });
  const versionId = policy.Policy?.DefaultVersionId;
  const version = await iam.send("GetPolicyVersion", { PolicyArn: arn, VersionId: versionId });
  const versions = await listAll(iam, "ListPolicyVersions", { PolicyArn: arn }, "Versions");
  return { versionId, document: parsePolicy(version.PolicyVersion?.Document), count: versions.length };
}
