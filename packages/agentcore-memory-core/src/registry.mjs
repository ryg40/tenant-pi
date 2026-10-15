// The registry: the one place that decides the namespace scope of each identity. No scope holds a delete.
// The IAM renderer of the registry script and the local checks read the same functions.
import { failure } from "./errors.mjs";
import { validateId } from "./ids.mjs";

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const MEMORY_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
// An IAM user name: https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateUser.html
const IAM_USER = /^[\w+=,.@-]{1,64}$/;
const PIN = /^XYZ\d{4}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const STATUS = new Set(["active", "offboarded"]);

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() !== "";
const only = (value, fields) => plainObject(value) && Object.keys(value).every((key) => fields.includes(key));

function ids(value) {
  if (!Array.isArray(value)) throw failure("config");
  const list = value.map(validateId);
  if (new Set(list).size !== list.length) throw failure("config");
  return list;
}

export function validateRegistry(value) {
  if (!only(value, ["schemaVersion", "memory", "service", "people", "projects"]) || value.schemaVersion !== 1
      || !only(value.memory, ["region", "memoryId"]) || !REGION.test(value.memory.region ?? "")
      || typeof value.memory.memoryId !== "string" || !MEMORY_ID.test(value.memory.memoryId)
      || !only(value.service, ["submitUser", "workerReadUser"])
      || !IAM_USER.test(value.service.submitUser ?? "") || !IAM_USER.test(value.service.workerReadUser ?? "")
      || value.service.submitUser === value.service.workerReadUser
      || !Array.isArray(value.people) || !Array.isArray(value.projects)) {
    throw failure("config");
  }
  const people = value.people.map((person) => {
    if (!only(person, ["actorId", "name", "email", "pin", "status"]) || !text(person.name)
        || typeof person.email !== "string" || !EMAIL.test(person.email)
        || (person.pin !== undefined && (typeof person.pin !== "string" || !PIN.test(person.pin)))
        || !STATUS.has(person.status)) {
      throw failure("config");
    }
    return { ...person, actorId: validateId(person.actorId) };
  });
  const active = new Set(people.filter((person) => person.status === "active").map((person) => person.actorId));
  if (new Set(people.map((person) => person.actorId)).size !== people.length) throw failure("config");
  const projects = value.projects.map((project) => {
    if (!only(project, ["projectId", "maintainers", "members", "remotes"])
        || (project.remotes !== undefined && (!Array.isArray(project.remotes) || !project.remotes.every(text)))) {
      throw failure("config");
    }
    const members = ids(project.members);
    const maintainers = ids(project.maintainers);
    // Every member exists and is active; every maintainer is a member.
    if (members.some((actorId) => !active.has(actorId)) || maintainers.some((actorId) => !members.includes(actorId))) {
      throw failure("config");
    }
    const copy = { projectId: validateId(project.projectId), maintainers, members };
    if (project.remotes) copy.remotes = [...project.remotes];
    return copy;
  });
  if (new Set(projects.map((project) => project.projectId)).size !== projects.length) throw failure("config");
  return { schemaVersion: 1, memory: { ...value.memory }, service: { ...value.service }, people, projects };
}

function activePerson(registry, actorId) {
  const person = registry.people.find((item) => item.actorId === validateId(actorId));
  if (!person || person.status !== "active") throw failure("config");
  return person;
}

const unique = (list) => [...new Set(list)];

export function personScope(input, actorId) {
  const registry = validateRegistry(input);
  activePerson(registry, actorId);
  const read = ["/shared/*", `/actor/${actorId}/*`];
  const write = [];
  const move = [];
  for (const project of registry.projects) {
    if (!project.members.includes(actorId)) continue;
    const p = project.projectId;
    read.push(`/project/${p}/shared/*`, `/project/${p}/proposals/${actorId}/*`);
    write.push(`/project/${p}/proposals/${actorId}/*`);
    if (project.maintainers.includes(actorId)) {
      // The review scope: list every proposal and rejected record of the project, move between its three trees.
      read.push(`/project/${p}/proposals/*`, `/project/${p}/rejected/*`);
      move.push(`/project/${p}/proposals/*`, `/project/${p}/shared/*`, `/project/${p}/rejected/*`);
    }
  }
  return { read: unique(read), write: unique(write), move: unique(move) };
}

export function submitScope(input) {
  validateRegistry(input);
  return { read: ["/shared/*", "/actor/*"], write: ["/shared/*", "/actor/*"], move: ["/shared/*", "/actor/*"] };
}

export function workerScope(input) {
  validateRegistry(input);
  return { read: ["/shared/*", "/project/*/shared/*"], write: [], move: [] };
}

export function renderPersonConfig(input, actorId) {
  const registry = validateRegistry(input);
  activePerson(registry, actorId);
  const projects = registry.projects.filter((project) => project.members.includes(actorId)).map((project) => {
    const membership = { projectId: project.projectId, role: project.maintainers.includes(actorId) ? "maintainer" : "member" };
    if (project.remotes?.length) membership.remotes = [...project.remotes];
    return membership;
  });
  return { schemaVersion: 1, memoryId: registry.memory.memoryId, region: registry.memory.region, actorId, projects };
}
