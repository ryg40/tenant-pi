// The registry command line. `main` takes the arguments and the injectable parts and returns the
// exit code: 0 done, 1 refused or failed, 2 usage. A dry run is the default; without `--profile`
// no command creates an AWS client.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { validateRegistry } from "./core.mjs";
import { POLICY_LIMIT, renderPerson, renderService, usage } from "./render.mjs";
import {
  checkLive, createIamClient, createStsClient, keyDirectory, provisionApply, provisionPlan, resolveAccount, rotateApply, rotatePlan,
} from "./iam.mjs";
import { createMemoryClient } from "./records.mjs";
import { offboardApply, offboardPlan } from "./offboard.mjs";
import { migrateApply, migratePlan } from "./migrate.mjs";
import { purgeApply, purgePlan } from "./purge.mjs";

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const COMMANDS = new Set(["render", "provision", "rotate", "offboard", "purge", "migrate", "check"]);
const APPLY = new Set(["provision", "rotate", "offboard", "purge", "migrate"]);
const OPTIONS = {
  registry: { type: "string" }, person: { type: "string" }, service: { type: "string" }, owner: { type: "string" },
  project: { type: "string" },
  apply: { type: "boolean" }, profile: { type: "string" }, account: { type: "string" }, "show-values": { type: "boolean" },
  "key-dir": { type: "string" }, "smoke-record-id": { type: "string" }, "old-namespace": { type: "string", multiple: true },
  help: { type: "boolean" },
};
export const HELP = `usage: registry.mjs <command> --registry <file> [options]
commands:
  render --person <actorId> | --service submit|worker
  provision --person <actorId>    rotate --person <actorId>    offboard --person <actorId>
  purge --project <projectId> [--person <actorId>]
  migrate --owner <actorId> [--old-namespace <namespace>]... [--smoke-record-id <id>]
  check --profile <admin>
options:
  --apply --profile <admin>   run the apply step (provision, rotate, offboard, purge, migrate)
  --profile <admin>           read-only lists in a dry run; the account id from STS
  --account <12 digits>       the account id of the memory ARN
  --show-values               print the memory id, the account id and the service user names
  --key-dir <dir>             the private key directory (default ~/.local/state/agentcore-memory-admin/keys)
  --old-namespace <namespace> migrate: one more exact namespace below /owner/<actorId>/ to move; repeat it for each path
A dry run is the default. It prints the plan and changes nothing.`;

export const defaultDeps = () => ({
  createIam: createIamClient, createSts: createStsClient, createMemory: createMemoryClient,
  out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`),
  now: () => new Date(), repositoryRoot: REPOSITORY_ROOT,
  keyDir: path.join(homedir(), ".local/state/agentcore-memory-admin/keys"),
  readRegistry: (file) => readFileSync(file, "utf8"),
  writeRegistry: (file, registry) => {
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: statSync(file).mode & 0o777, flag: "wx" });
    renameSync(temporary, file);
  },
});

function loadRegistry(file, deps) {
  let value;
  try {
    value = JSON.parse(deps.readRegistry(file));
  } catch {
    throw new Error("registry: the file is missing or is not JSON");
  }
  return validateRegistry(value);
}

function inside(file, root) {
  const resolved = path.resolve(file);
  return resolved === root || resolved.startsWith(root + path.sep);
}

const pretty = (value) => JSON.stringify(value, null, 2);

function personLines(rendered) {
  return [
    `person: ${rendered.actorId} (${rendered.name})`,
    `iam user: ${rendered.userName}`,
    `inline policy: ${rendered.policyName}`,
    `policy characters without white space: ${rendered.size} of ${POLICY_LIMIT}`,
    "policy:", pretty(rendered.shown),
    "person config:", pretty(rendered.shownConfig),
    "handoff note:", rendered.note,
  ];
}

function checkLimit(rendered) {
  if (rendered.size > POLICY_LIMIT) {
    throw new Error(`the policy has ${rendered.size} characters; IAM allows ${POLICY_LIMIT} for the inline policies of one user`);
  }
}

async function run(command, values, deps, clients) {
  const out = deps.out;
  if (!values.registry) throw usage("--registry <file> is required");
  const registry = loadRegistry(values.registry, deps);
  const apply = Boolean(values.apply);
  if (apply && !APPLY.has(command)) throw usage(`${command} is not an apply command`);
  if (apply && !values.profile) throw usage("--apply needs --profile <admin>; the apply step runs with the admin login only");
  if (apply && (inside(values.registry, deps.repositoryRoot) || registry.memory.memoryId === "mem-EXAMPLE")) {
    throw new Error("--apply refuses the example registry; use the private registry outside the repository");
  }
  if (command === "check" && !values.profile) throw usage("check needs --profile <admin>");
  // Only a command that compares or writes a policy needs the account id. A plan makes no AWS call, also with --profile.
  const needsAccount = ["render", "migrate", "check"].includes(command) || (apply && command === "provision");
  const stsProfile = needsAccount ? values.profile : undefined;
  const options = { showValues: Boolean(values["show-values"]), smokeRecordId: values["smoke-record-id"], profile: values.profile,
    oldNamespaces: values["old-namespace"] ?? [] };
  options.account = await resolveAccount({ account: values.account, profile: stsProfile }, { createSts: clients.sts });
  const iam = () => clients.iam(values.profile);
  const memory = () => clients.memory(values.profile, registry.memory.region);

  if (command === "render") {
    if (Boolean(values.person) === Boolean(values.service)) throw usage("render needs --person <actorId> or --service submit|worker");
    if (values.person) {
      const rendered = renderPerson(registry, values.person, options);
      personLines(rendered).forEach((line) => out(line));
      checkLimit(rendered);
    } else {
      const rendered = renderService(registry, values.service, options);
      out(`service: ${rendered.kind}`);
      out(`iam user: ${options.showValues ? rendered.userName : `<${rendered.kind} user>`}`);
      out(`policy characters without white space: ${rendered.size}`);
      out("policy:");
      out(pretty(rendered.shown));
    }
  } else if (command === "provision" || command === "rotate") {
    if (!values.person) throw usage(`${command} needs --person <actorId>`);
    const rendered = renderPerson(registry, values.person, options);
    checkLimit(rendered);
    if (!apply) {
      out(`${command} plan for ${rendered.actorId}:`);
      (command === "provision" ? provisionPlan(rendered) : rotatePlan(rendered)).forEach((line, index) => out(`${index + 1}. ${line}`));
      if (command === "provision") personLines(rendered).forEach((line) => out(line));
    } else {
      if (command === "provision" && !options.account) throw new Error("the account id is unknown");
      const keyDir = keyDirectory(values["key-dir"] ?? deps.keyDir, deps.repositoryRoot);
      const lines = command === "provision"
        ? await provisionApply(rendered, await iam(), deps, keyDir)
        : await rotateApply(rendered, await iam(), deps, keyDir, values.profile);
      lines.forEach((line) => out(line));
    }
  } else if (command === "offboard") {
    if (!values.person) throw usage("offboard needs --person <actorId>");
    if (!apply) {
      const live = values.profile ? { iam: await iam(), memory: await memory() } : null;
      (await offboardPlan(registry, values.person, live)).forEach((line) => out(line));
    } else {
      const result = await offboardApply(registry, values.person, { iam: await iam(), memory: await memory() });
      result.done.forEach((line) => out(line));
      deps.writeRegistry(values.registry, result.registry);
      out(`registry: ${values.person} is offboarded and left every project list`);
    }
  } else if (command === "purge") {
    if (!values.project) throw usage("purge needs --project <projectId>");
    if (!apply) (await purgePlan(registry, values.project, values.person, values.profile ? await memory() : null)).forEach((line) => out(line));
    else (await purgeApply(registry, values.project, values.person, await memory())).forEach((line) => out(line));
  } else if (command === "migrate") {
    if (!values.owner) throw usage("migrate needs --owner <actorId>");
    if (!apply) {
      const live = values.profile ? { iam: await iam(), memory: await memory() } : null;
      (await migratePlan(registry, values.owner, options, live)).forEach((line) => out(line));
    } else {
      (await migrateApply(registry, values.owner, options, { iam: await iam(), memory: await memory() }, deps.now)).forEach((line) => out(line));
    }
  } else {
    const lines = await checkLive(registry, await iam(), options);
    lines.forEach((line) => out(line));
    if (lines.at(-1) !== "no difference") return 1;
  }
  const readOnly = values.profile && command !== "provision" && command !== "rotate";
  out(apply ? "apply: done" : readOnly ? "dry run: read-only AWS calls only; nothing changed" : "dry run: no AWS call; nothing changed");
  return 0;
}

export async function main(argv, deps = defaultDeps()) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch {
    deps.err("error: unknown or incomplete option");
    deps.err(HELP);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  if (parsed.values.help || !command) { deps.out(HELP); return command || parsed.values.help ? 0 : 2; }
  if (!COMMANDS.has(command) || rest.length) { deps.err(`error: unknown command`); deps.err(HELP); return 2; }

  const opened = [];
  const once = (factory) => {
    const cache = new Map();
    return async (...args) => {
      const key = JSON.stringify(args);
      if (!cache.has(key)) cache.set(key, Promise.resolve(factory(...args)).then((client) => { opened.push(client); return client; }));
      return cache.get(key);
    };
  };
  const clients = { iam: once(deps.createIam), sts: once(deps.createSts), memory: once(deps.createMemory) };
  try {
    return await run(command, parsed.values, deps, clients);
  } catch (error) {
    if (error?.code === "usage") { deps.err(`error: ${error.message}`); return 2; }
    // An SDK error can carry request data or credential details: print its class name only.
    deps.err(error?.name && error.name !== "Error" ? `error: aws or system call failed: ${error.name}` : `error: ${error?.message}`);
    return 1;
  } finally {
    for (const client of opened) client?.destroy?.();
  }
}
