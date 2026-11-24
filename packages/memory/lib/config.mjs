// The source configuration: a JSON file with one entry for each memory system.
// config/sources.example.json in the repository shows every field.
//
//   { "sources": [ { "id", "type", "mode": "live" | "sample" | "off", ... } ] }
//
// Without a file, or with --sample, the hub runs all five types in sample mode.

import { lstatSync, readFileSync } from 'node:fs';
import { SOURCE_TYPES } from './adapters/base.mjs';
import { SourceError } from './model.mjs';

export const DEFAULT_ORDER = ['openviking', 'okknow', 'llmwiki', 'hermes', 'agentcore'];

export function sampleConfig() {
  return { sources: DEFAULT_ORDER.flatMap((type) => type === 'openviking' ? [
    { id: 'openviking', type, name: 'OpenViking \u00b7 Alice', mode: 'sample' },
    { id: 'openviking-bob', type, name: 'OpenViking \u00b7 Bob', mode: 'sample', fixture: 'openviking-bob.json' },
  ] : [{ id: type, type, mode: 'sample' }]) };
}

function readConfig(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('config: the source file is not readable JSON');
  }
}

export function loadConfig(file) {
  return validateConfig(readConfig(file));
}

export function validateConfig(raw) {
  if (!raw || !Array.isArray(raw.sources)) throw new Error('config: "sources" must be an array');
  const seen = new Set();
  const sources = raw.sources.map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`config: source ${i} is not an object`);
    if (typeof s.type !== 'string' || !Object.hasOwn(SOURCE_TYPES, s.type)) throw new Error(`config: source ${i} has an unknown type`);
    const id = s.id ?? s.type;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error(`config: source ${i} id must be lower case letters, digits and "-"`);
    if (seen.has(id)) throw new Error(`config: the source id ${id} occurs twice`);
    seen.add(id);
    const mode = s.mode ?? 'live';
    if (!['live', 'sample', 'off'].includes(mode)) throw new Error(`config: source ${id} has an unknown mode`);
    return { ...s, id, mode };
  });
  return { sources };
}

// A field name that holds a credential value. The settings file of the user names the path of a credential file
// (apiKeyFile, credentialFile) or a sign-in profile, never the value.
const VALUE_KEY = /^(?:api[-_]?key|key|token|password|passwd|secret|credentials?|authorization|auth)$/i;

// True when `file` is a regular file of this user that no other user can read or write (mode 0600 or less).
function privateFile(file) {
  let info;
  try { info = lstatSync(file); } catch { return false; }
  return info.isFile() && (info.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || info.uid === process.getuid());
}

// The settings file of the local module: the source configuration of one user outside the repository.
// It must be private to the user, and no source may hold a credential value.
export function loadSettings(file) {
  if (!privateFile(file)) throw new Error('config: the settings file must be a regular file of this user with mode 0600');
  const raw = readConfig(file);
  const holdsValue = (value) => value && typeof value === 'object' && Object.entries(value).some(([key, inner]) =>
    (VALUE_KEY.test(key) && typeof inner === 'string' && inner !== '') || holdsValue(inner));
  if (holdsValue(raw)) throw new Error('config: the settings file holds a credential value; name the path of a credential file');
  return validateConfig(raw);
}

// Read one credential file of the local module: as readSecret, and the file must be private to the user.
export function readPrivateSecret(file) {
  if (!file) throw new SourceError('credentials', 'The source has no credential file in its configuration.');
  if (!privateFile(file)) throw new SourceError('credentials', 'The credential file of this source must be a regular file of this user with mode 0600.');
  return readSecret(file);
}

// Read one credential file. The value is trimmed and never logged.
export function readSecret(file) {
  if (!file) throw new SourceError('credentials', 'The source has no credential file in its configuration.');
  let value;
  try {
    value = readFileSync(file, 'utf8').trim();
  } catch {
    throw new SourceError('credentials', 'The credential file of this source is not readable.');
  }
  if (!value) throw new SourceError('credentials', 'The credential file of this source is empty.');
  return value;
}
