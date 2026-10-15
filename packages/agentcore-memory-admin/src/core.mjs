// The registry functions of the core (packages/agentcore-memory-core): the id rule, the namespace
// builder, the registry validation, the scope of each identity and the person config. The core is the one
// source, so the IAM policies and the local checks of the core read the same namespace lists.
// This module adds what an owner tool needs and the core does not give: a refusal that names the field
// and the rule (a core failure is the static code `config`), and two registry rules of the script
// (a duplicate PIN, a project without a maintainer).
import * as core from "../../agentcore-memory-core/src/index.mjs";

export const namespaces = core.namespaces;

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const MEMORY_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
// IAM user names: letters, digits and `+=,.@_-`, 1 to 64 characters.
const IAM_USER = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN = /^XYZ[0-9]{4}$/;
const REMOTE = /^[^\s\x00-\x1f\x7f]{1,512}$/;

function fail(path, rule) {
  // The message names the field and the rule, never the value.
  const error = new Error(`registry: ${path} ${rule}`);
  error.code = "config";
  throw error;
}

function object(value, path, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, "is not a known field");
  for (const key of required) if (!(key in value)) fail(`${path}.${key}`, "is missing");
  return value;
}

function string(value, path, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(path, "has an invalid value");
  return value;
}

function list(value, path) {
  if (!Array.isArray(value)) fail(path, "must be a list");
  return value;
}

/** The id rule of the core; the refusal names `path`. */
export function validateId(value, path = "id") {
  try {
    return core.validateId(value);
  } catch {
    fail(path, "must match [a-z0-9][a-z0-9-]{0,63}");
  }
}

/** The field checks of the script, then the registry validation of the core. Returns the input. */
export function validateRegistry(value) {
  const registry = object(value, "registry", ["schemaVersion", "memory", "service", "people", "projects"]);
  if (registry.schemaVersion !== 1) fail("registry.schemaVersion", "must be 1");
  object(registry.memory, "memory", ["region", "memoryId"]);
  string(registry.memory.region, "memory.region", REGION);
  string(registry.memory.memoryId, "memory.memoryId", MEMORY_ID);
  object(registry.service, "service", ["submitUser", "workerReadUser"]);
  string(registry.service.submitUser, "service.submitUser", IAM_USER);
  string(registry.service.workerReadUser, "service.workerReadUser", IAM_USER);
  if (registry.service.submitUser === registry.service.workerReadUser) fail("service", "needs two different users");

  const people = new Map();
  list(registry.people, "people").forEach((person, index) => {
    const path = `people[${index}]`;
    object(person, path, ["actorId", "name", "email", "pin", "status"], ["actorId", "name", "email", "status"]);
    validateId(person.actorId, `${path}.actorId`);
    if (people.has(person.actorId)) fail(`${path}.actorId`, "is a duplicate");
    if (typeof person.name !== "string" || !person.name.trim() || person.name.length > 200) fail(`${path}.name`, "has an invalid value");
    string(person.email, `${path}.email`, EMAIL);
    if ("pin" in person) string(person.pin, `${path}.pin`, PIN);
    if (person.status !== "active" && person.status !== "offboarded") fail(`${path}.status`, "must be active or offboarded");
    people.set(person.actorId, person);
  });
  const pins = registry.people.filter((person) => person.pin).map((person) => person.pin);
  if (new Set(pins).size !== pins.length) fail("people", "has a duplicate pin");

  const projects = new Set();
  list(registry.projects, "projects").forEach((project, index) => {
    const path = `projects[${index}]`;
    object(project, path, ["projectId", "maintainers", "members", "remotes"], ["projectId", "maintainers", "members"]);
    validateId(project.projectId, `${path}.projectId`);
    if (projects.has(project.projectId)) fail(`${path}.projectId`, "is a duplicate");
    projects.add(project.projectId);
    for (const field of ["members", "maintainers"]) {
      const ids = list(project[field], `${path}.${field}`);
      ids.forEach((actorId, item) => {
        validateId(actorId, `${path}.${field}[${item}]`);
        if (!people.has(actorId)) fail(`${path}.${field}[${item}]`, "is not a person of the registry");
        if (people.get(actorId).status !== "active") fail(`${path}.${field}[${item}]`, "is not an active person");
      });
      if (new Set(ids).size !== ids.length) fail(`${path}.${field}`, "has a duplicate");
    }
    if (!project.maintainers.length) fail(`${path}.maintainers`, "needs at least one maintainer");
    project.maintainers.forEach((actorId, item) => {
      if (!project.members.includes(actorId)) fail(`${path}.maintainers[${item}]`, "is not a member of the project");
    });
    if ("remotes" in project) {
      list(project.remotes, `${path}.remotes`).forEach((remote, item) => string(remote, `${path}.remotes[${item}]`, REMOTE));
    }
  });
  try {
    core.validateRegistry(registry);
  } catch {
    fail("registry", "is refused by the registry validation of the core");
  }
  return registry;
}

function active(registry, actorId) {
  validateId(actorId, "actorId");
  const found = registry.people.find((item) => item.actorId === actorId);
  if (!found) fail("actorId", "is not a person of the registry");
  if (found.status !== "active") fail("actorId", "is not an active person");
}

/** The scope of a person, from the core. */
export function personScope(registry, actorId) {
  active(registry, actorId);
  return core.personScope(validateRegistry(registry), actorId);
}

export function submitScope(registry) {
  return core.submitScope(validateRegistry(registry));
}

export function workerScope(registry) {
  return core.workerScope(validateRegistry(registry));
}

/** The person config of the core, without `profile`, `ledgerPath` and `hostLabel`. */
export function renderPersonConfig(registry, actorId) {
  active(registry, actorId);
  return core.renderPersonConfig(validateRegistry(registry), actorId);
}
