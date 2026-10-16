// Render IAM policy documents, the person config and the handoff note from the registry.
// The namespace lists come from the scope functions of the core only.

import { personScope, renderPersonConfig, submitScope, workerScope } from "./core.mjs";

export const POLICY_NAME = "agentcore-memory";
export const POLICY_LIMIT = 2048;
export const USER_PREFIX = "pi-memory-person-";
export const TAGS = (actorId) => [{ Key: "purpose", Value: "agentcore-memory" }, { Key: "actorId", Value: actorId }];
const KEY = "bedrock-agentcore:namespace";
const READ = ["bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:ListMemoryRecords"];
// An account id has 12 digits. A dry run without an account counts with a value of that length.
const ACCOUNT_LENGTH = 12;

export const userName = (actorId) => `${USER_PREFIX}${actorId}`;

export function memoryArn(region, account, memoryId) {
  return `arn:aws:bedrock-agentcore:${region}:${account}:memory/${memoryId}`;
}

const CONDITIONED = (patterns) => ({ "ForAllValues:StringLike": { [KEY]: [...patterns] }, Null: { [KEY]: "false" } });

/** One policy document from one scope: `Read`, `Write` (create) and `Move` (update) statements. No delete statement. */
export function policyDocument(scope, resource) {
  const statements = [];
  if (scope.read.length) {
    statements.push({ Sid: "Read", Effect: "Allow", Action: [...READ], Resource: resource,
      Condition: { StringLike: { [KEY]: [...scope.read] } } });
  }
  if (scope.write.length) {
    statements.push({ Sid: "Write", Effect: "Allow", Action: ["bedrock-agentcore:BatchCreateMemoryRecords"], Resource: resource,
      Condition: CONDITIONED(scope.write) });
  }
  if (scope.move.length) {
    statements.push({ Sid: "Move", Effect: "Allow", Action: ["bedrock-agentcore:BatchUpdateMemoryRecords"], Resource: resource,
      Condition: CONDITIONED(scope.move) });
  }
  return { Version: "2012-10-17", Statement: statements };
}

/** The characters that IAM counts: the JSON text without white space. */
export function policySize(document) {
  return JSON.stringify(document).replace(/\s/g, "").length;
}

/** The two forms of one policy: `real` for IAM and the count, `shown` for the output. */
function forms(registry, scopeOf, options) {
  const { region, memoryId } = registry.memory;
  const scope = scopeOf();
  const counted = policyDocument(scope, memoryArn(region, options.account ?? "0".repeat(ACCOUNT_LENGTH), memoryId));
  const real = options.account ? counted : null;
  const shown = policyDocument(scope, memoryArn(region, options.account && options.showValues ? options.account : "<account>",
    options.showValues ? memoryId : "<memoryId>"));
  return { scope, real, shown, size: policySize(counted) };
}

export function renderPerson(registry, actorId, options = {}) {
  const person = registry.people.find((item) => item.actorId === actorId);
  const policy = forms(registry, () => personScope(registry, actorId), options);
  const config = renderPersonConfig(registry, actorId);
  return {
    actorId, name: person.name, userName: userName(actorId), policyName: POLICY_NAME, ...policy,
    config, shownConfig: options.showValues ? config : { ...config, memoryId: "<memoryId>" },
    note: handoffNote(actorId, config),
  };
}

export function renderService(registry, kind, options = {}) {
  if (kind === "submit") {
    return { kind, userName: registry.service.submitUser, ...forms(registry, () => submitScope(registry), options) };
  }
  if (kind === "worker") return { kind, userName: registry.service.workerReadUser, ...forms(registry, () => workerScope(registry), options) };
  throw usage("--service must be submit or worker");
}

export function handoffNote(actorId, config) {
  const profile = userName(actorId);
  const maintainer = config.projects.some((project) => project.role === "maintainer");
  return [
    `Handoff for ${actorId}:`,
    `1. Store the access key in the AWS profile "${profile}" of ~/.aws/credentials (file mode 0600).`,
    `2. Save the person config as ~/.config/agentcore-memory/config.json. The config file of the provision apply has "profile": "${profile}"; a config from a dry run needs that line.`,
    ...(maintainer ? [`3. Add "ledgerPath" with a private file outside every repository for the review ledger.`] : []),
    `${maintainer ? 4 : 3}. Delete the Bitwarden Send message after the copy. The config file holds no key.`,
  ].join("\n");
}

export function usage(message) {
  const error = new Error(message);
  error.code = "usage";
  return error;
}
