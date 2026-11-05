import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';
import { loadProfile } from './profile.mjs';

export const PORTABLE_AGENT_FORMAT = 'fieldwork-portable-agent/v1';
export const PORTABLE_AGENT_POLICY = 'fieldwork-portable-agent-policy/v1';
export const PORTABLE_AGENT_INCOMPLETE_MARKER = '.fieldwork-portable-incomplete';
export const PORTABLE_AGENT_LIMITS = Object.freeze({
  manifestBytes: 8 * 1024 * 1024,
  files: 20_000,
  directories: 10_000,
  totalBytes: 2 * 1024 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
  pathCharacters: 1024,
  segmentCharacters: 255,
  depth: 64,
});

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hashPattern = /^[0-9a-f]{64}$/;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const credentialFile = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.(?:credentials|secrets?)(?:\.(?:json|toml|ya?ml))?|credentials(?:\.(?:json|toml|ya?ml))?|secrets?(?:\.(?:json|toml|ya?ml))?|.+\.secrets\.json|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|ppk|p12|pfx|jks|keystore|kdbx))$/i;
const portableCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function portabilityError(message, cause) {
  return new Error(`Agent portability: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw portabilityError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw portabilityError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw portabilityError(`${where}.${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function exactIso(value, where) {
  if (typeof value !== 'string') throw portabilityError(`${where} must be an exact ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw portabilityError(`${where} must be an exact ISO timestamp`);
  return value;
}

function displayName(value, where = 'agent.name') {
  if (typeof value !== 'string') throw portabilityError(`${where} must be text`);
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || [...normalized].length > 80 || /\p{Cc}/u.test(normalized)) {
    throw portabilityError(`${where} must be 1-80 visible characters`);
  }
  return normalized;
}

function wholeNumber(value, maximum, where) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw portabilityError(`${where} is outside its supported bound`);
  return value;
}

function portablePath(value, where) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC')) {
    throw portabilityError(`${where} must be nonempty NFC text`);
  }
  if ([...value].length > PORTABLE_AGENT_LIMITS.pathCharacters || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw portabilityError(`${where} is not a portable relative path`);
  }
  const segments = value.split('/');
  if (segments.length > PORTABLE_AGENT_LIMITS.depth || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw portabilityError(`${where} is not a portable relative path`);
  }
  for (const segment of segments) {
    if ([...segment].length > PORTABLE_AGENT_LIMITS.segmentCharacters || /[<>:"|?*\p{Cc}]/u.test(segment)
      || /[. ]$/u.test(segment) || reservedWindowsName.test(segment)) {
      throw portabilityError(`${where} contains a nonportable path segment`);
    }
  }
  return value;
}

function portableKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function pathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realDirectory(directory, where) {
  const resolved = path.resolve(directory);
  let info;
  try { info = await fs.lstat(resolved); }
  catch (error) { throw portabilityError(`${where} is not available`, error); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw portabilityError(`${where} must be a real directory, not a link`);
  const canonical = await fs.realpath(resolved);
  const canonicalInfo = await fs.lstat(canonical);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) throw portabilityError(`${where} must resolve to a real directory`);
  return path.resolve(canonical);
}

async function absent(destination, where) {
  try { await fs.lstat(destination); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw portabilityError(`${where} already exists`);
}

function secretBuffers(values) {
  if (!Array.isArray(values)) throw portabilityError('knownSecrets must be an array');
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') throw portabilityError('knownSecrets may contain only text');
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length < 8) throw portabilityError('a configured credential is too short for safe portable-export scanning');
    if (bytes.length > 64 * 1024) throw portabilityError('a configured credential is too large for safe portable-export scanning');
    const key = createHash('sha256').update(bytes).digest('hex');
    if (!seen.has(key)) { seen.add(key); result.push(bytes); }
  }
  return result;
}

function secretScanner(secrets) {
  const overlap = Math.max(0, ...secrets.map(secret => secret.length - 1));
  let tail = Buffer.alloc(0);
  return chunk => {
    if (!secrets.length) return false;
    const haystack = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    const found = secrets.some(secret => haystack.indexOf(secret) !== -1);
    tail = overlap ? Buffer.from(haystack.subarray(Math.max(0, haystack.length - overlap))) : Buffer.alloc(0);
    return found;
  };
}

function containsSecret(value, secrets) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return secrets.some(secret => bytes.indexOf(secret) !== -1);
}

function refuseSecretMetadata(value, secrets, where) {
  if (containsSecret(value, secrets)) throw portabilityError(`refusing a portable copy because ${where} contains a configured Fieldwork credential`);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function copyAndHashFile(source, destination, relative, secrets, declaredExecutable = null) {
  const beforePath = await fs.lstat(source, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw portabilityError(`agent content contains unsupported filesystem entry ${relative}`);
  if (beforePath.size > BigInt(PORTABLE_AGENT_LIMITS.fileBytes)) throw portabilityError(`agent file exceeds the ${PORTABLE_AGENT_LIMITS.fileBytes}-byte limit: ${relative}`);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let input;
  try { input = await fs.open(source, flags); }
  catch (error) { throw portabilityError(`could not safely open agent file ${relative}`, error); }
  let output = null;
  try {
    const opened = await input.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(beforePath, opened)) throw portabilityError(`agent file changed before it could be copied: ${relative}`);
    const executable = declaredExecutable === null ? Boolean(opened.mode & 0o111n) : declaredExecutable;
    if (destination) output = await fs.open(destination, 'wx', executable ? 0o700 : 0o600);
    const digest = createHash('sha256');
    const scan = secretScanner(secrets);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      bytes += bytesRead;
      if (bytes > PORTABLE_AGENT_LIMITS.fileBytes) throw portabilityError(`agent file exceeds the ${PORTABLE_AGENT_LIMITS.fileBytes}-byte limit: ${relative}`);
      if (scan(chunk)) throw portabilityError(`refusing a portable copy because ${relative} contains a configured Fieldwork credential`);
      digest.update(chunk);
      if (output) {
        let offset = 0;
        while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
    }
    const afterHandle = await input.stat({ bigint: true });
    const afterPath = await fs.lstat(source, { bigint: true });
    if (!sameFile(opened, afterHandle) || !sameFile(opened, afterPath)) throw portabilityError(`agent file changed while it was copied: ${relative}`);
    if (bytes !== Number(opened.size)) throw portabilityError(`agent file size changed while it was copied: ${relative}`);
    if (destination) await fs.chmod(destination, executable ? 0o700 : 0o600);
    return { path: relative, bytes, sha256: digest.digest('hex'), executable };
  } finally {
    try { await output?.close(); } finally { await input.close(); }
  }
}

function exclusion(relative, entryName) {
  const key = relative.toLowerCase();
  const base = entryName.toLowerCase();
  if (key === 'backups' || key.startsWith('backups/')) return 'recoveryCopies';
  if (key === 'state/room-secret' || base === '.room-secret' || base.endsWith('.room-secret')) return 'roomCredentials';
  if (key === 'state/bridges.json') return 'bridgeBindings';
  return null;
}

function unsafeTransient(relative, entryName) {
  const base = entryName.toLowerCase();
  if (base.endsWith('.lock') || base.startsWith('.fieldwork-')) {
    throw portabilityError(`remove interrupted runtime state before exporting: ${relative}`);
  }
  if (credentialFile.test(entryName)) throw portabilityError(`move or remove credential-like file before exporting: ${relative}`);
}

function emptyOmissions() {
  return { recoveryCopies: 0, roomCredentials: 0, bridgeBindings: 0 };
}

async function walkPayload({ source, destination = null, secrets, exportMode, expectedFiles = null, ignoreRootMarker = false }) {
  const directories = [];
  const files = [];
  const omissions = emptyOmissions();
  const collisions = new Map();
  const declaredExecutables = expectedFiles === null
    ? null
    : new Map(expectedFiles.map(file => [portableKey(file.path), file.executable]));
  let totalBytes = 0;
  const remember = (relative, kind) => {
    const key = portableKey(relative);
    const earlier = collisions.get(key);
    if (earlier) throw portabilityError(`portable paths collide across filesystems: ${earlier} and ${relative}`);
    collisions.set(key, `${kind} ${relative}`);
  };
  const visit = async (directory, relativeDirectory = '') => {
    const directoryInfo = await fs.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw portabilityError(`agent content contains unsupported directory ${relativeDirectory || '.'}`);
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => portableCompare(left.name, right.name));
    for (const entry of entries) {
      if (ignoreRootMarker && relativeDirectory === '' && entry.name === PORTABLE_AGENT_INCOMPLETE_MARKER) continue;
      const relative = portablePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name, 'agent content path');
      refuseSecretMetadata(relative, secrets, 'an agent path');
      const omitted = exclusion(relative, entry.name);
      if (omitted) {
        if (!exportMode) throw portabilityError(`portable payload contains forbidden ${omitted} entry: ${relative}`);
        omissions[omitted]++;
        continue;
      }
      unsafeTransient(relative, entry.name);
      const sourceEntry = path.join(directory, entry.name);
      const info = await fs.lstat(sourceEntry);
      if (info.isSymbolicLink()) throw portabilityError(`agent content contains unsupported symbolic link ${relative}`);
      if (entry.isDirectory() && info.isDirectory()) {
        if (directories.length >= PORTABLE_AGENT_LIMITS.directories) throw portabilityError(`agent content exceeds ${PORTABLE_AGENT_LIMITS.directories} directories`);
        remember(relative, 'directory');
        directories.push(relative);
        if (destination) await fs.mkdir(path.join(destination, ...relative.split('/')), { mode: 0o700 });
        await visit(sourceEntry, relative);
      } else if (entry.isFile() && info.isFile()) {
        if (files.length >= PORTABLE_AGENT_LIMITS.files) throw portabilityError(`agent content exceeds ${PORTABLE_AGENT_LIMITS.files} files`);
        remember(relative, 'file');
        const destinationFile = destination ? path.join(destination, ...relative.split('/')) : null;
        const declaredExecutable = declaredExecutables?.get(portableKey(relative)) ?? null;
        const file = await copyAndHashFile(sourceEntry, destinationFile, relative, secrets, declaredExecutable);
        totalBytes += file.bytes;
        if (totalBytes > PORTABLE_AGENT_LIMITS.totalBytes) throw portabilityError(`agent content exceeds ${PORTABLE_AGENT_LIMITS.totalBytes} total bytes`);
        files.push(file);
      } else {
        throw portabilityError(`agent content contains unsupported filesystem entry ${relative}`);
      }
    }
  };
  await visit(source);
  directories.sort(portableCompare);
  files.sort((left, right) => portableCompare(left.path, right.path));
  return { directories, files, bytes: totalBytes, omissions };
}

function payloadDigest(payload) {
  return createHash('sha256').update(canonicalJson({
    directories: payload.directories,
    files: payload.files,
    bytes: payload.bytes,
  }), 'utf8').digest('hex');
}

function manifestFrom({ agentName, exportedAt, payload }) {
  return {
    format: PORTABLE_AGENT_FORMAT,
    policy: PORTABLE_AGENT_POLICY,
    exportedAt,
    agent: { name: displayName(agentName) },
    payload: {
      directories: payload.directories,
      files: payload.files,
      bytes: payload.bytes,
      sha256: payloadDigest(payload),
    },
    omitted: payload.omissions,
  };
}

function manifestProjection(value) {
  let bounded;
  try {
    bounded = boundedJson(value, {
      where: 'portable agent manifest', object: true,
      maxBytes: PORTABLE_AGENT_LIMITS.manifestBytes, maxDepth: 8,
      maxNodes: (PORTABLE_AGENT_LIMITS.files * 6) + PORTABLE_AGENT_LIMITS.directories + 64,
    }).value;
  } catch (error) { throw portabilityError(error.message, error); }
  const raw = fields(bounded, ['format', 'policy', 'exportedAt', 'agent', 'payload', 'omitted'], 'portable agent manifest');
  if (raw.format !== PORTABLE_AGENT_FORMAT) throw portabilityError(`portable agent manifest.format must be ${PORTABLE_AGENT_FORMAT}`);
  if (raw.policy !== PORTABLE_AGENT_POLICY) throw portabilityError(`portable agent manifest.policy must be ${PORTABLE_AGENT_POLICY}`);
  const agent = fields(raw.agent, ['name'], 'portable agent manifest.agent');
  const payload = fields(raw.payload, ['directories', 'files', 'bytes', 'sha256'], 'portable agent manifest.payload');
  const omitted = fields(raw.omitted, ['recoveryCopies', 'roomCredentials', 'bridgeBindings'], 'portable agent manifest.omitted');
  if (!Array.isArray(payload.directories) || payload.directories.length > PORTABLE_AGENT_LIMITS.directories) {
    throw portabilityError('portable agent manifest has too many directories');
  }
  if (!Array.isArray(payload.files) || payload.files.length > PORTABLE_AGENT_LIMITS.files) {
    throw portabilityError('portable agent manifest has too many files');
  }
  const collisions = new Map();
  const remember = (relative, kind) => {
    const key = portableKey(relative);
    const earlier = collisions.get(key);
    if (earlier) throw portabilityError(`portable manifest paths collide: ${earlier} and ${relative}`);
    collisions.set(key, `${kind} ${relative}`);
  };
  const directories = payload.directories.map((value, index) => {
    const relative = portablePath(value, `portable agent manifest.payload.directories[${index}]`);
    remember(relative, 'directory');
    return relative;
  });
  const files = payload.files.map((value, index) => {
    const row = fields(value, ['path', 'bytes', 'sha256', 'executable'], `portable agent manifest.payload.files[${index}]`);
    const relative = portablePath(row.path, `portable agent manifest.payload.files[${index}].path`);
    remember(relative, 'file');
    if (typeof row.sha256 !== 'string' || !hashPattern.test(row.sha256)) throw portabilityError(`portable agent manifest.payload.files[${index}].sha256 is invalid`);
    if (typeof row.executable !== 'boolean') throw portabilityError(`portable agent manifest.payload.files[${index}].executable must be boolean`);
    return { path: relative, bytes: wholeNumber(row.bytes, PORTABLE_AGENT_LIMITS.fileBytes, `portable agent manifest.payload.files[${index}].bytes`), sha256: row.sha256, executable: row.executable };
  });
  if (canonicalJson(directories) !== canonicalJson([...directories].sort(portableCompare))) {
    throw portabilityError('portable agent manifest directories must be sorted');
  }
  if (canonicalJson(files) !== canonicalJson([...files].sort((left, right) => portableCompare(left.path, right.path)))) {
    throw portabilityError('portable agent manifest files must be sorted');
  }
  const bytes = wholeNumber(payload.bytes, PORTABLE_AGENT_LIMITS.totalBytes, 'portable agent manifest.payload.bytes');
  if (files.reduce((sum, row) => sum + row.bytes, 0) !== bytes) throw portabilityError('portable agent manifest payload byte total does not match its files');
  if (typeof payload.sha256 !== 'string' || !hashPattern.test(payload.sha256)) throw portabilityError('portable agent manifest.payload.sha256 is invalid');
  const projectedPayload = { directories, files, bytes };
  if (payloadDigest(projectedPayload) !== payload.sha256) throw portabilityError('portable agent manifest payload digest does not match its entries');
  for (const [key, count] of Object.entries(omitted)) wholeNumber(count, PORTABLE_AGENT_LIMITS.files + PORTABLE_AGENT_LIMITS.directories, `portable agent manifest.omitted.${key}`);
  if (!files.some(row => row.path === 'profile.json')) throw portabilityError('portable agent manifest does not contain profile.json');
  return deepFreeze({
    format: PORTABLE_AGENT_FORMAT,
    policy: PORTABLE_AGENT_POLICY,
    exportedAt: exactIso(raw.exportedAt, 'portable agent manifest.exportedAt'),
    agent: { name: displayName(agent.name) },
    payload: { ...projectedPayload, sha256: payload.sha256 },
    omitted: { ...omitted },
  });
}

async function readManifest(bundle, secrets = []) {
  const file = path.join(bundle, 'manifest.json');
  const info = await fs.lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw portabilityError('portable bundle manifest.json must be a real file');
  if (info.size > BigInt(PORTABLE_AGENT_LIMITS.manifestBytes)) throw portabilityError(`portable bundle manifest exceeds ${PORTABLE_AGENT_LIMITS.manifestBytes} bytes`);
  let handle;
  try { handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch (error) { throw portabilityError('could not safely open portable bundle manifest.json', error); }
  let source;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(info, opened)) throw portabilityError('portable bundle manifest changed before it could be read');
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > PORTABLE_AGENT_LIMITS.manifestBytes) throw portabilityError(`portable bundle manifest exceeds ${PORTABLE_AGENT_LIMITS.manifestBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fs.lstat(file, { bigint: true });
    if (!sameFile(opened, afterHandle) || !sameFile(opened, afterPath)) throw portabilityError('portable bundle manifest changed while it was read');
    const manifestBytes = Buffer.concat(chunks, bytes);
    if (containsSecret(manifestBytes, secrets)) throw portabilityError('refusing a portable copy because its manifest contains a configured Fieldwork credential');
    try { source = utf8.decode(manifestBytes); }
    catch (error) { throw portabilityError('portable bundle manifest.json must be valid UTF-8', error); }
  } finally { await handle.close(); }
  let parsed;
  try { parsed = parseJsonNoDuplicates(source, { where: 'portable agent manifest', maxDepth: 8 }); }
  catch (error) { throw portabilityError(error.message, error); }
  const manifest = manifestProjection(parsed);
  refuseSecretMetadata(manifest.agent.name, secrets, 'the manifest agent name');
  for (const relative of manifest.payload.directories) refuseSecretMetadata(relative, secrets, 'a manifest path');
  for (const file of manifest.payload.files) refuseSecretMetadata(file.path, secrets, 'a manifest path');
  return manifest;
}

async function bundleRoot(source) {
  const bundle = await realDirectory(source, 'portable bundle');
  const entries = await fs.readdir(bundle, { withFileTypes: true });
  entries.sort((left, right) => portableCompare(left.name, right.name));
  if (entries.length !== 2 || entries[0].name !== 'agent' || entries[1].name !== 'manifest.json') {
    throw portabilityError('portable bundle must contain exactly agent/ and manifest.json');
  }
  for (const entry of entries) {
    const info = await fs.lstat(path.join(bundle, entry.name));
    if (entry.name === 'agent') {
      if (!entry.isDirectory() || !info.isDirectory() || info.isSymbolicLink()) throw portabilityError('portable bundle agent must be a real directory');
    } else if (!entry.isFile() || !info.isFile() || info.isSymbolicLink()) {
      throw portabilityError('portable bundle manifest.json must be a real file');
    }
  }
  return bundle;
}

function comparablePayload(value) {
  return { directories: value.directories, files: value.files, bytes: value.bytes };
}

async function cleanupAfterFailure(error, paths, message) {
  const cleanupErrors = [];
  for (const target of paths) {
    try { await fs.rm(target, { recursive: true, force: true }); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
  }
  if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], message);
  throw error;
}

async function reserveDirectory(target, where) {
  try { await fs.mkdir(target, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw portabilityError(`${where} already exists`, error);
    throw error;
  }
  try { await fs.writeFile(path.join(target, PORTABLE_AGENT_INCOMPLETE_MARKER), `${PORTABLE_AGENT_FORMAT}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    try { await fs.rmdir(target); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Portable publication reservation failed; remove ${target}`); }
    throw error;
  }
}

async function publishPortableBundle({ stage, target, manifest, secrets }) {
  let reserved = false;
  try {
    await reserveDirectory(target, 'portable export destination');
    reserved = true;
    await fs.rename(path.join(stage, 'agent'), path.join(target, 'agent'));
    await fs.rename(path.join(stage, 'manifest.json'), path.join(target, 'manifest.json'));
    const publishedManifest = await readManifest(target, secrets);
    if (canonicalJson(publishedManifest) !== canonicalJson(manifest)) throw portabilityError('published portable manifest changed during final verification');
    const payload = await walkPayload({
      source: path.join(target, 'agent'), secrets, exportMode: false, expectedFiles: manifest.payload.files,
    });
    assertPayloadMatches(payload, manifest);
    await loadProfile(path.join(target, 'agent'));
    await fs.rmdir(stage);
    await fs.unlink(path.join(target, PORTABLE_AGENT_INCOMPLETE_MARKER));
    await bundleRoot(target);
  } catch (error) {
    await cleanupAfterFailure(error, reserved ? [target, stage] : [stage],
      `Portable export failed and cleanup left incomplete content under ${path.dirname(target)}`);
  }
}

async function publishAgentHome({ stage, target, manifest, secrets, deferPublication }) {
  let reserved = false;
  try {
    await reserveDirectory(target, 'portable import destination');
    reserved = true;
    const entries = await fs.readdir(stage, { withFileTypes: true });
    entries.sort((left, right) => portableCompare(left.name, right.name));
    for (const entry of entries) await fs.rename(path.join(stage, entry.name), path.join(target, entry.name));
    const payload = await walkPayload({
      source: target, secrets, exportMode: false, expectedFiles: manifest.payload.files, ignoreRootMarker: true,
    });
    assertPayloadMatches(payload, manifest);
    await loadProfile(target);
    await fs.rmdir(stage);
    if (!deferPublication) await fs.unlink(path.join(target, PORTABLE_AGENT_INCOMPLETE_MARKER));
  } catch (error) {
    await cleanupAfterFailure(error, reserved ? [target, stage] : [stage],
      `Portable import failed and cleanup left incomplete content under ${path.dirname(target)}`);
  }
}

function assertPayloadMatches(actual, manifest) {
  const expected = comparablePayload(manifest.payload);
  const observed = comparablePayload(actual);
  if (canonicalJson(observed) !== canonicalJson(expected) || payloadDigest(observed) !== manifest.payload.sha256) {
    throw portabilityError('portable bundle payload does not match its manifest');
  }
}

export async function inspectPortableAgent(source, { knownSecrets = [] } = {}) {
  const secrets = secretBuffers(knownSecrets);
  refuseSecretMetadata(source, secrets, 'the import source');
  const bundle = await bundleRoot(path.resolve(source));
  refuseSecretMetadata(bundle, secrets, 'the resolved import source');
  return readManifest(bundle, secrets);
}

export async function finalizePortableAgentImport(destination) {
  const target = await realDirectory(path.resolve(destination), 'imported agent home');
  const marker = path.join(target, PORTABLE_AGENT_INCOMPLETE_MARKER);
  const before = await fs.lstat(marker, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 128n) {
    throw portabilityError('import publication marker is not a bounded regular file');
  }
  let handle;
  try { handle = await fs.open(marker, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch (error) { throw portabilityError('could not safely open the import publication marker', error); }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw portabilityError('import publication marker changed before finalization');
    const buffer = Buffer.alloc(129);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 128 || buffer.subarray(0, bytesRead).toString('utf8') !== `${PORTABLE_AGENT_FORMAT}\n`) {
      throw portabilityError('import publication marker has unexpected content');
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fs.lstat(marker, { bigint: true });
    if (!sameFile(opened, afterHandle) || !sameFile(opened, afterPath)) throw portabilityError('import publication marker changed during finalization');
  } finally { await handle.close(); }
  await fs.unlink(marker);
}

export async function exportPortableAgent({ home, agentName, destination, knownSecrets = [], clock = Date.now } = {}) {
  const secrets = secretBuffers(knownSecrets);
  refuseSecretMetadata(home, secrets, 'the agent home');
  refuseSecretMetadata(agentName, secrets, 'the agent name');
  refuseSecretMetadata(destination, secrets, 'the export destination');
  const source = await realDirectory(path.resolve(home), 'agent home');
  refuseSecretMetadata(source, secrets, 'the resolved agent home');
  try { await loadProfile(source); }
  catch (error) { throw portabilityError(`agent home has an invalid profile: ${error.message}`, error); }
  const requestedTarget = path.resolve(destination);
  const targetParent = await realDirectory(path.dirname(requestedTarget), 'portable export parent');
  const target = path.join(targetParent, path.basename(requestedTarget));
  refuseSecretMetadata(target, secrets, 'the resolved export destination');
  if (pathInside(source, target) || pathInside(target, source)) throw portabilityError('portable export destination must be separate from the agent home');
  await absent(target, 'portable export destination');
  const stage = path.join(path.dirname(target), `.${path.basename(target)}.fieldwork-export-${randomUUID()}`);
  await absent(stage, 'portable export staging directory');
  await fs.mkdir(path.join(stage, 'agent'), { recursive: true, mode: 0o700 });
  try {
    const first = await walkPayload({ source, destination: path.join(stage, 'agent'), secrets, exportMode: true });
    const second = await walkPayload({ source, secrets, exportMode: true });
    if (canonicalJson(first) !== canonicalJson(second)) throw portabilityError('agent home changed while the portable copy was being made');
    const staged = await walkPayload({ source: path.join(stage, 'agent'), secrets, exportMode: false, expectedFiles: first.files });
    assertPayloadMatches(staged, { payload: { ...comparablePayload(first), sha256: payloadDigest(first) } });
    try { await loadProfile(path.join(stage, 'agent')); }
    catch (error) { throw portabilityError(`portable copy has an invalid profile: ${error.message}`, error); }
    const exportedAt = new Date(clock());
    if (!Number.isFinite(exportedAt.getTime())) throw portabilityError('clock returned an invalid time');
    const manifest = manifestProjection(manifestFrom({ agentName, exportedAt: exportedAt.toISOString(), payload: first }));
    await fs.writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await readManifest(stage, secrets);
    await publishPortableBundle({ stage, target, manifest, secrets });
    return deepFreeze({
      format: PORTABLE_AGENT_FORMAT,
      destination: target,
      name: manifest.agent.name,
      files: manifest.payload.files.length,
      bytes: manifest.payload.bytes,
      omitted: manifest.omitted,
    });
  } catch (error) {
    await cleanupAfterFailure(error, [stage], `Portable export failed and staging cleanup failed at ${stage}`);
  }
}

export async function importPortableAgent({ source, destination, knownSecrets = [], deferPublication = false } = {}) {
  if (typeof deferPublication !== 'boolean') throw portabilityError('deferPublication must be boolean');
  const secrets = secretBuffers(knownSecrets);
  refuseSecretMetadata(source, secrets, 'the import source');
  refuseSecretMetadata(destination, secrets, 'the import destination');
  const bundle = await bundleRoot(path.resolve(source));
  refuseSecretMetadata(bundle, secrets, 'the resolved import source');
  const requestedTarget = path.resolve(destination);
  const targetParent = await realDirectory(path.dirname(requestedTarget), 'portable import parent');
  const target = path.join(targetParent, path.basename(requestedTarget));
  refuseSecretMetadata(target, secrets, 'the resolved import destination');
  if (pathInside(bundle, target) || pathInside(target, bundle)) throw portabilityError('portable import destination must be separate from the bundle');
  await absent(target, 'portable import destination');
  const manifest = await readManifest(bundle, secrets);
  const stage = path.join(path.dirname(target), `.${path.basename(target)}.fieldwork-import-${randomUUID()}`);
  await absent(stage, 'portable import staging directory');
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    const copied = await walkPayload({ source: path.join(bundle, 'agent'), destination: stage, secrets, exportMode: false, expectedFiles: manifest.payload.files });
    assertPayloadMatches(copied, manifest);
    const verified = await walkPayload({ source: stage, secrets, exportMode: false, expectedFiles: manifest.payload.files });
    assertPayloadMatches(verified, manifest);
    try { await loadProfile(stage); }
    catch (error) { throw portabilityError(`portable agent has an invalid profile: ${error.message}`, error); }
    await publishAgentHome({ stage, target, manifest, secrets, deferPublication });
    return deepFreeze({
      format: PORTABLE_AGENT_FORMAT,
      source: bundle,
      destination: target,
      name: manifest.agent.name,
      files: manifest.payload.files.length,
      bytes: manifest.payload.bytes,
      omitted: manifest.omitted,
      ...(deferPublication ? { incompleteMarker: path.join(target, PORTABLE_AGENT_INCOMPLETE_MARKER) } : {}),
    });
  } catch (error) {
    await cleanupAfterFailure(error, [stage], `Portable import failed and staging cleanup failed at ${stage}`);
  }
}
