// The namespace and identifier rules of the AgentCore memory explorer that this app started from.
// Keep the parser strict: a guessed roster could grant the wrong read scope.
import { readFileSync } from 'node:fs';
import { SourceError } from './model.mjs';

const fail = () => { throw new SourceError('config', 'The AgentCore scope configuration is invalid.', 503); };
function validateId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) fail();
  return value;
}
const namespaces = {
  global: () => '/shared/',
  actor: (actor) => `/actor/${validateId(actor)}/`,
  projectShared: (project) => `/project/${validateId(project)}/shared/`,
  proposals: (project, actor) => `/project/${validateId(project)}/proposals/${validateId(actor)}/`,
  proposalsOfProject: (project) => `/project/${validateId(project)}/proposals/`,
  rejected: (project, actor) => `/project/${validateId(project)}/rejected/${validateId(actor)}/`,
  rejectedOfProject: (project) => `/project/${validateId(project)}/rejected/`,
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, required, optional = []) {
  if (!object(value) || required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) fail();
}
function list(value) { if (!Array.isArray(value)) fail(); return value; }
function ids(value) {
  const result = list(value).map(validateId);
  if (new Set(result).size !== result.length) fail();
  return result;
}

// Stage files use mappings, lists, and scalar values. Refuse YAML features that
// this reader cannot interpret, rather than silently changing their meaning.
export function parseStageYaml(text) {
  function comment(line) {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && quote === '"') { i++; continue; }
        if (c === quote) {
          if (quote === "'" && line[i + 1] === "'") i++;
          else quote = '';
        }
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
    }
    if (quote) fail();
    return line.trimEnd();
  }
  function scalar(raw) {
    if (raw === '[]') return [];
    if (raw === '{}') return {};
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1);
      // IDs are the only nonempty flow-list values in the stage schema.
      return inner.split(',').map((part) => scalar(part.trim()));
    }
    if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch { fail(); } }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (/^-?(0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
    // A plain value is a name, or a namespace path such as a strategy namespace.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw) && !/^\/(?:[A-Za-z0-9_{}-]+\/)+$/.test(raw)) fail();
    return raw;
  }
  const lines = text.split(/\r?\n/).map(comment).filter((line) => line.trim() !== '').map((line) => {
    if (line.includes('\t')) fail();
    return { indent: line.length - line.trimStart().length, value: line.trimStart() };
  });
  let at = 0;
  function entry(target, raw, indent) {
    const match = /^([A-Za-z][A-Za-z0-9]*):(?:\s+(.*))?$/.exec(raw);
    if (!match || Object.hasOwn(target, match[1])) fail();
    let value;
    if (match[2] !== undefined) value = scalar(match[2]);
    else if (lines[at]?.indent > indent) value = block(lines[at].indent);
    else fail();
    Object.defineProperty(target, match[1], { value, enumerable: true, writable: true, configurable: true });
  }
  function block(indent) {
    const array = /^-(?:\s|$)/.test(lines[at].value);
    const result = array ? [] : {};
    while (at < lines.length && lines[at].indent === indent) {
      const raw = lines[at++].value;
      if (array) {
        if (!raw.startsWith('- ')) fail();
        const body = raw.slice(2);
        if (body.includes(':')) {
          const item = {};
          entry(item, body, indent + 2);
          while (lines[at]?.indent === indent + 2) entry(item, lines[at++].value, indent + 2);
          result.push(item);
        } else result.push(scalar(body));
      } else entry(result, raw, indent);
      if (lines[at]?.indent > indent) fail();
    }
    return result;
  }
  if (!lines.length || lines[0].indent !== 0) fail();
  const result = block(0);
  if (at !== lines.length) fail();
  return validateStage(result);
}

// These validation and roster rules mirror scripts/aws-memory.py.
export function validateStage(value) {
  fields(value, ['schemaVersion', 'stage', 'region', 'memory', 'bucket', 'service', 'people', 'projects'], ['hostRoles']);
  if (value.schemaVersion !== 1 || !['dev', 'test', 'prod'].includes(value.stage)
      || typeof value.region !== 'string' || value.region.length > 32
      || !/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/.test(value.region)) fail();
  // Validate optional event persons and strategies before deriving their namespaces.
  fields(value.memory, ['eventExpiryDays'], ['events', 'strategies']);
  const days = value.memory.eventExpiryDays;
  if (!Number.isInteger(days) || days < 3 || days > 365) fail();
  fields(value.bucket, ['enabled']);
  fields(value.service, ['submit', 'workerRead']);
  if ([value.bucket.enabled, value.service.submit, value.service.workerRead].some((v) => typeof v !== 'boolean')) fail();
  const people = new Set();
  const pins = new Set();
  const active = new Set();
  for (const person of list(value.people)) {
    // The renderer field iamUser selects an IAM user; the explorer scope does not depend on it.
    fields(person, ['actorId', 'pin', 'status'], ['iamUser']);
    const actor = validateId(person.actorId);
    if (people.has(actor) || typeof person.pin !== 'string' || !/^XYZ[0-9]{4}$/.test(person.pin)
        || pins.has(person.pin) || !['active', 'offboarded'].includes(person.status)
        || typeof (person.iamUser ?? true) !== 'boolean') fail();
    people.add(actor);
    pins.add(person.pin);
    if (person.status === 'active') active.add(actor);
  }
  if (ids(value.memory.events ?? []).some((actor) => !active.has(actor))) fail();
  const strategyNames = new Set();
  for (const strategy of list(value.memory.strategies ?? [])) {
    fields(strategy, ['type', 'name', 'namespace']);
    if (!['semantic', 'summary', 'userPreference'].includes(strategy.type)
        || typeof strategy.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(strategy.name)
        || strategyNames.has(strategy.name) || typeof strategy.namespace !== 'string'
        || !/^\/(?:[A-Za-z0-9_{}-]+\/)+$/.test(strategy.namespace)) fail();
    strategyNames.add(strategy.name);
  }
  const projects = new Set();
  for (const project of list(value.projects)) {
    fields(project, ['projectId', 'maintainers', 'members'], ['deleters']);
    const id = validateId(project.projectId);
    if (projects.has(id)) fail();
    projects.add(id);
    const members = ids(project.members);
    const maintainers = ids(project.maintainers);
    const deleters = ids(project.deleters ?? []);
    if (!maintainers.length || members.some((member) => !active.has(member))
        || [...maintainers, ...deleters].some((actor) => !members.includes(actor))) fail();
  }
  const roles = new Set();
  const agents = new Set();
  for (const host of list(value.hostRoles ?? [])) {
    fields(host, ['roleSuffix', 'actorId', 'proposalProject']);
    const actor = validateId(host.actorId);
    const project = validateId(host.proposalProject);
    if (host.roleSuffix !== 'macos-role' || roles.has(host.roleSuffix) || people.has(actor)
        || agents.has(actor) || !projects.has(project)) fail();
    roles.add(host.roleSuffix);
    agents.add(actor);
  }
  return value;
}

// The own strategy namespaces of an event person, as the prototype grants them:
// {actorId} is the person; a namespace with {sessionId} is one namespace per session.
export function strategyScope(config, actorId) {
  if (!(config.memory.events ?? []).includes(actorId)) return [];
  return (config.memory.strategies ?? []).map(({ type, namespace }) => {
    const own = namespace.replaceAll('{actorId}', actorId);
    const cut = own.indexOf('{sessionId}');
    const prefix = cut === -1 ? own : own.slice(0, cut);
    if (prefix.includes('{') || !prefix.endsWith('/')) fail();
    return { kind: `own ${type} strategy`, prefix, perSession: cut !== -1, pattern: prefix + '*' };
  });
}

export function stageScope(config, actorId) {
  validateStage(config);
  validateId(actorId);
  if (!config.people.some((person) => person.actorId === actorId && person.status === 'active')) fail();
  const read = [namespaces.global() + '*', namespaces.actor(actorId) + '*'];
  for (const project of config.projects) {
    if (!project.members.includes(actorId)) continue;
    const id = project.projectId;
    read.push(namespaces.projectShared(id) + '*', namespaces.proposals(id, actorId) + '*');
    if (project.maintainers.includes(actorId)) {
      read.push(namespaces.proposalsOfProject(id) + '*', namespaces.rejectedOfProject(id) + '*');
    }
  }
  return { read: [...new Set(read)] };
}

function permitted(namespace, patterns) {
  return patterns.some((pattern) => pattern.endsWith('*') && namespace.startsWith(pattern.slice(0, -1)));
}
function exact(namespace) {
  return typeof namespace === 'string' && namespace.length <= 1024
    && /^\/(?:[A-Za-z0-9_-]+\/)+$/.test(namespace);
}

function inventoryFor(source, actorId, readPatterns) {
  validateId(actorId);
  if (!source.people.some((person) => person.actorId === actorId && person.status === 'active')) fail();
  const inventory = [];
  const add = (namespace, kind) => {
    if (!exact(namespace) || !permitted(namespace, readPatterns)) fail();
    if (!inventory.some((entry) => entry.namespace === namespace)) inventory.push({ namespace, kind });
  };
  add(namespaces.global(), 'global shared');
  // Session namespaces need an explicit namespace list; the stage has no session inventory.
  const strategies = source.memory ? strategyScope(source, actorId) : [];
  // The scope source supplies the private tree. No actor-tree literal lives here.
  const privatePatterns = readPatterns.filter((pattern) => pattern.endsWith(`/${actorId}/*`)
    && !strategies.some((strategy) => strategy.pattern === pattern)
    && !source.projects.some((project) => pattern.startsWith(namespaces.proposalsOfProject(project.projectId))));
  if (privatePatterns.length !== 1) fail();
  add(privatePatterns[0].slice(0, -1), 'own private');
  const projects = [];
  for (const project of source.projects) {
    if (!project.members.includes(actorId)) continue;
    const role = project.maintainers.includes(actorId) ? 'maintainer' : 'member';
    const id = project.projectId;
    projects.push({ projectId: id, role });
    add(namespaces.projectShared(id), 'project shared');
    add(namespaces.proposals(id, actorId), 'own proposals');
    if (role === 'maintainer') {
      for (const member of project.members) {
        add(namespaces.proposals(id, member), member === actorId ? 'own proposals' : 'member proposals');
        add(namespaces.rejected(id, member), member === actorId ? 'own rejected' : 'member rejected');
      }
      // Offboarding removes a person from every roster and deletes these records in every project.
      for (const person of source.people) {
        if (person.status !== 'offboarded') continue;
        add(namespaces.proposals(id, person.actorId), 'offboarded member proposals');
        add(namespaces.rejected(id, person.actorId), 'offboarded member rejected');
      }
    }
  }
  for (const strategy of strategies) if (!strategy.perSession) add(strategy.prefix, strategy.kind);
  return { inventory, projects };
}

// An explicit list replaces stage derivation, including an empty list.
export function resolveNamespaces(cfg, { read = readFileSync } = {}) {
  if (Object.hasOwn(cfg, 'namespaces')) {
    const inventory = [];
    for (const value of list(cfg.namespaces)) {
      const entry = typeof value === 'string' ? { namespace: value } : value;
      if (!object(entry) || !exact(entry.namespace)) fail();
      const label = entry.label ?? entry.namespace;
      if (typeof label !== 'string' || !label.trim() || /[\x00-\x1f\x7f]/.test(label)) fail();
      // An optional section name of the rail. Namespaces of one group stand together.
      const group = entry.group;
      if (group !== undefined && (typeof group !== 'string' || !group.trim() || group.length > 60 || /[\x00-\x1f\x7f]/.test(group))) fail();
      if (!inventory.some((n) => n.namespace === entry.namespace)) {
        inventory.push({ namespace: entry.namespace, label, ...(group === undefined ? {} : { group }) });
      }
    }
    return inventory;
  }
  fields(cfg.scope, ['kind', 'path']);
  if (cfg.scope.kind !== 'stage-file' || typeof cfg.scope.path !== 'string' || !cfg.scope.path.trim()) fail();
  let stage;
  try { stage = parseStageYaml(read(cfg.scope.path, 'utf8')); } catch { fail(); }
  if (stage.stage !== 'dev' || stage.region !== cfg.region) fail();
  const patterns = [...stageScope(stage, cfg.actorId).read, ...strategyScope(stage, cfg.actorId).map((s) => s.pattern)];
  return inventoryFor(stage, cfg.actorId, patterns).inventory.map((entry) => ({
    ...entry, label: `${entry.kind}: ${entry.namespace}`,
  }));
}
