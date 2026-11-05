import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

export const PROFILE_FORMAT = 'fieldwork-profile/v1';
export const ROOT_PLACEMENTS = Object.freeze(['system', 'user-tail']);
export const PROFILE_LIMITS = Object.freeze({
  roots: 16,
  manifestBytes: 64 * 1024,
  rootBytes: 64 * 1024,
  totalRootBytes: 256 * 1024,
});

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const reservedWindowsName = /^(?:con|prn|aux|nul|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))(?:\.|$)/iu;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const loadedProfiles = new WeakSet();

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Exact instruction bodies shipped in templates/agent-home/roots. Keep these
// readable and covered by the template test: a general "one bracketed block"
// heuristic would mislabel intentionally terse authored roots such as
// "[quietly]" as blank.
const UNWRITTEN_TEMPLATE_BODIES = new Set([
  `[Write the agent's first-person account of who they are, what they care about, and how they understand
their continuity. This is profile-authored content, not a software default.]`,
  `[Record the people and relationships the agent should recognize. Keep testimony, interpretation, and
current consent distinguishable. A current correction must outrank this file.]`,
  `[Describe how this agent naturally writes. Keep this small and behavioral. It is loaded at the user-tail
placement so the final register remains close to the sentence being produced.]`,
]);

// True when a root still holds one of the shipped template instructions (or
// nothing but headings), so the room can tell the person their agent is still
// blank. It only reads the text; the loader never changes what the model gets.
export function isUnwrittenRoot(text) {
  if (typeof text !== 'string') return false;
  const body = text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .filter(line => !/^\s*#/u.test(line))
    .join('\n')
    .trim();
  return !body || UNWRITTEN_TEMPLATE_BODIES.has(body);
}

function profileError(message) {
  return new Error(`Profile: ${message}`);
}

function exactKeys(value, allowed, where) {
  if (!isPlainObject(value)) throw profileError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw profileError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw profileError(`${where}.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  return fields;
}

function positiveLimit(value, fallback, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 1) throw profileError(`${name} must be a positive whole number`);
  return number;
}

function limitsFrom(options) {
  const fields = exactKeys(options, ['manifestPath', 'maxRoots', 'maxManifestBytes', 'maxRootBytes', 'maxTotalRootBytes', 'clock'], 'loader options');
  const clock = fields.clock === undefined ? Date.now : fields.clock;
  if (typeof clock !== 'function') throw profileError('clock must be a function');
  return Object.freeze({
    manifestPath: fields.manifestPath,
    roots: positiveLimit(fields.maxRoots, PROFILE_LIMITS.roots, 'maxRoots'),
    manifestBytes: positiveLimit(fields.maxManifestBytes, PROFILE_LIMITS.manifestBytes, 'maxManifestBytes'),
    rootBytes: positiveLimit(fields.maxRootBytes, PROFILE_LIMITS.rootBytes, 'maxRootBytes'),
    totalRootBytes: positiveLimit(fields.maxTotalRootBytes, PROFILE_LIMITS.totalRootBytes, 'maxTotalRootBytes'),
    clock,
  });
}

function observedThrough(clock) {
  let value;
  try { value = clock(); }
  catch (error) { throw profileError(`clock failed: ${error.message}`); }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw profileError('clock returned an invalid time');
  return date.toISOString();
}

function portableRelative(value, where, extension) {
  if (typeof value !== 'string' || !value.length) throw profileError(`${where} must be a relative ${extension} path`);
  if (value !== value.trim() || value.includes('\\')) throw profileError(`${where} must use a trimmed portable path with / separators`);
  if (value !== value.normalize('NFC')) throw profileError(`${where} must use Unicode NFC normalization`);
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw profileError(`${where} must be relative`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw profileError(`${where} may not contain empty, . or .. segments`);
  for (const part of parts) {
    if (/[<>:"|?*\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part) || reservedWindowsName.test(part)) {
      throw profileError(`${where} is not portable across supported operating systems`);
    }
  }
  if (path.posix.extname(value).toLowerCase() !== extension) throw profileError(`${where} must end in ${extension}`);
  return value;
}

async function safeHome(home) {
  if (typeof home !== 'string' || !home.length) throw profileError('agent home must be a nonempty path');
  const resolved = path.resolve(home);
  let stat;
  try { stat = await fs.lstat(resolved); }
  catch (error) { throw profileError(`agent home is unavailable: ${error.message}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw profileError('agent home must be a real directory, not a link');
  try { return await fs.realpath(resolved); }
  catch (error) { throw profileError(`agent home could not be resolved: ${error.message}`); }
}

async function safeFile(home, relative, where) {
  let current = home;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { throw profileError(`${where} is unavailable: ${error.message}`); }
    if (stat.isSymbolicLink()) throw profileError(`${where} may not pass through a symbolic link`);
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) throw profileError(`${where} has a non-directory path segment`);
    if (last && !stat.isFile()) throw profileError(`${where} must be a regular file`);
  }
  return current;
}

async function readUtf8File(home, relative, where, maximum) {
  const file = await safeFile(home, relative, where);
  let beforeReal;
  try { beforeReal = await fs.realpath(file); }
  catch (error) { throw profileError(`${where} could not be resolved safely: ${error.message}`); }
  const outside = path.relative(home, beforeReal);
  if (outside.startsWith(`..${path.sep}`) || outside === '..' || path.isAbsolute(outside)) throw profileError(`${where} resolves outside the agent home`);
  let handle;
  try { handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch (error) { throw profileError(`${where} could not be opened safely: ${error.message}`); }
  let bytes;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw profileError(`${where} must be a regular file`);
    if (before.size > BigInt(maximum)) throw profileError(`${where} is ${before.size} bytes; the limit is ${maximum}`);
    bytes = await handle.readFile();
    if (bytes.length > maximum) throw profileError(`${where} is ${bytes.length} bytes; the limit is ${maximum}`);
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw profileError(`${where} changed while it was being read`);
    }
  } finally {
    await handle.close();
  }
  let afterReal;
  try { afterReal = await fs.realpath(file); }
  catch (error) { throw profileError(`${where} changed while it was being read: ${error.message}`); }
  if (afterReal !== beforeReal) throw profileError(`${where} changed while it was being read`);
  await safeFile(home, relative, where);
  let text;
  try { text = decoder.decode(bytes); }
  catch { throw profileError(`${where} must be valid UTF-8`); }
  return { bytes, text };
}

function parseManifest(bytes) {
  let source;
  try { source = decoder.decode(bytes); }
  catch { throw profileError('profile.json must be valid UTF-8'); }
  let manifest;
  try { manifest = parseJsonNoDuplicates(source, { where: 'profile.json' }); }
  catch (error) { throw profileError(error.message); }
  const fields = exactKeys(manifest, ['format', 'roots'], 'profile.json');
  if (fields.format !== PROFILE_FORMAT) throw profileError(`profile.json format must be ${PROFILE_FORMAT}`);
  if (!Array.isArray(fields.roots) || !fields.roots.length) throw profileError('profile.json roots must be a nonempty array');
  return fields;
}

function checkRoots(rows, limits) {
  if (rows.length > limits.roots) throw profileError(`profile.json has ${rows.length} roots; the limit is ${limits.roots}`);
  const ids = new Set(), paths = new Set(), checked = [];
  let sawTail = false, systemCount = 0, tailCount = 0;
  for (let index = 0; index < rows.length; index++) {
    const where = `profile.json roots[${index}]`;
    const row = exactKeys(rows[index], ['id', 'path', 'placement'], where);
    if (typeof row.id !== 'string' || !idPattern.test(row.id)) throw profileError(`${where}.id must be lowercase letters, digits and hyphens, beginning with a letter`);
    if (ids.has(row.id)) throw profileError(`profile.json repeats root id ${JSON.stringify(row.id)}`);
    ids.add(row.id);
    const relative = portableRelative(row.path, `${where}.path`, '.md');
    const pathKey = relative.toLocaleLowerCase('en-US');
    if (paths.has(pathKey)) throw profileError(`profile.json repeats root path ${JSON.stringify(relative)}`);
    paths.add(pathKey);
    if (!ROOT_PLACEMENTS.includes(row.placement)) throw profileError(`${where}.placement must be system or user-tail`);
    if (row.placement === 'user-tail') { sawTail = true; tailCount++; }
    else {
      if (sawTail) throw profileError('system roots must precede every user-tail root');
      systemCount++;
    }
    checked.push(Object.freeze({ id: row.id, path: relative, placement: row.placement }));
  }
  if (!systemCount) throw profileError('profile.json needs at least one system root');
  if (!tailCount) throw profileError('profile.json needs at least one user-tail root');
  return checked;
}

export function isLoadedProfile(value) {
  return Boolean(value) && loadedProfiles.has(value);
}

export async function loadProfile(agentHome, options = {}) {
  if (!isPlainObject(options)) throw profileError('loader options must be an object');
  const limits = limitsFrom(options);
  const home = await safeHome(agentHome);
  const manifestPath = portableRelative(limits.manifestPath === undefined ? 'profile.json' : limits.manifestPath, 'manifestPath', '.json');
  const manifestFile = await readUtf8File(home, manifestPath, manifestPath, limits.manifestBytes);
  const manifestObservedThrough = observedThrough(limits.clock);
  const manifest = parseManifest(manifestFile.bytes);
  const roots = checkRoots(manifest.roots, limits);
  const loaded = [];
  let totalBytes = 0, totalCharacters = 0;
  for (const root of roots) {
    const source = await readUtf8File(home, root.path, `root ${root.id}`, limits.rootBytes);
    if (!source.text.trim()) throw profileError(`root ${root.id} is empty`);
    totalBytes += source.bytes.length;
    if (totalBytes > limits.totalRootBytes) throw profileError(`roots total ${totalBytes} bytes; the limit is ${limits.totalRootBytes}`);
    const characters = [...source.text].length;
    totalCharacters += characters;
    loaded.push(Object.freeze({
      ...root,
      text: source.text,
      bytes: source.bytes.length,
      characters,
      sha256: sha256(source.bytes),
      observedThrough: observedThrough(limits.clock),
    }));
  }
  const receiptRoots = loaded.map(({ id, path: rootPath, placement, bytes, characters, sha256: hash, observedThrough: edge }) => ({
    id, path: rootPath, placement, bytes, characters, sha256: hash, observedThrough: edge,
  }));
  const fingerprintRoots = receiptRoots.map(({ id, path: rootPath, placement, bytes, characters, sha256: hash }) => ({
    id, path: rootPath, placement, bytes, characters, sha256: hash,
  }));
  const fingerprint = sha256(Buffer.from(canonicalJson({ format: PROFILE_FORMAT, roots: fingerprintRoots }), 'utf8'));
  const receipt = {
    format: PROFILE_FORMAT,
    manifest: {
      path: manifestPath,
      bytes: manifestFile.bytes.length,
      sha256: sha256(manifestFile.bytes),
      observedThrough: manifestObservedThrough,
    },
    roots: receiptRoots,
    totals: { roots: loaded.length, bytes: totalBytes, characters: totalCharacters },
    fingerprint,
  };
  const profile = {
    format: PROFILE_FORMAT,
    home,
    roots: loaded,
    systemRoots: loaded.filter(root => root.placement === 'system'),
    tailRoots: loaded.filter(root => root.placement === 'user-tail'),
    receipt,
  };
  deepFreeze(profile);
  loadedProfiles.add(profile);
  return profile;
}
