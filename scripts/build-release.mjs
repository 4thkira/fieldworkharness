import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib';

const run = promisify(execFile);
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const SIMPLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SUPPORTED_GIT_MODES = new Set(['100644', '100755']);
const NPM_ARCHIVE_MTIME = 499_162_500;
const WINDOWS_RESERVED_COMPONENT = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"/\\|?*\u0000-\u001f\u007f]/u;
const SECRET_ENVIRONMENT_KEYS = Object.freeze([
  'FIELDWORK_API_KEY',
  'FIELDWORK_TELEGRAM_TOKEN',
  'FIELDWORK_DISCORD_TOKEN',
]);

// Symbol-keyed so the CLI cannot expose fault-injection checkpoints.
export const RELEASE_BUILD_TEST_SEAM = Symbol('fieldwork.release-build.test-seam');

function releaseError(message, cause) {
  return new Error(`Release build: ${message}`, cause === undefined ? undefined : { cause });
}

async function execute(command, arguments_, {
  cwd,
  encoding = 'utf8',
  env = process.env,
  timeout = 180_000,
} = {}) {
  try {
    return await run(command, arguments_, {
      cwd,
      env,
      encoding,
      maxBuffer: 32 * 1024 * 1024,
      timeout,
      windowsHide: true,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    throw releaseError(`command failed: ${path.basename(command)}`, error);
  }
}

function npmCommand(arguments_) {
  const npmCli = process.env.npm_execpath
    ?? (process.platform === 'win32'
      ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : null);
  if (npmCli) {
    return { command: process.execPath, arguments: [npmCli, ...arguments_] };
  }
  return {
    command: 'npm',
    arguments: arguments_,
  };
}

function isolatedEnvironment(source, { preserveFieldworkSecrets = false } = {}) {
  const environment = {};
  const secretKeys = new Set(SECRET_ENVIRONMENT_KEYS.map(key => key.toUpperCase()));
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') || upper.startsWith('GCM_') || upper === 'EMAIL') continue;
    if (!preserveFieldworkSecrets && secretKeys.has(upper)) continue;
    environment[key] = value;
  }
  Object.assign(environment, {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LC_ALL: 'C',
  });
  return environment;
}

export function sanitizedEnvironment(source = process.env) {
  return isolatedEnvironment(source);
}

function releaseCheckEnvironment() {
  return isolatedEnvironment(process.env, { preserveFieldworkSecrets: true });
}

function validatePackageIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw releaseError('package.json must contain an object');
  }
  if (typeof value.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(value.name)) {
    throw releaseError('package.json has an invalid package name');
  }
  const versionMatch = typeof value.version === 'string' ? SIMPLE_SEMVER.exec(value.version) : null;
  if (!versionMatch) {
    throw releaseError('package.json version must be a simple SemVer value without build metadata');
  }
  if (versionMatch[4]?.split('.').some(part => /^[0-9]+$/u.test(part) && part.length > 1 && part[0] === '0')) {
    throw releaseError('package.json version has a numeric prerelease identifier with a leading zero');
  }
  const versionParts = value.version.split('-', 1)[0].split('.').map(Number);
  if (versionParts.every(part => part === 0)) {
    throw releaseError('package.json still has a 0.0.0 placeholder version');
  }
  if (value.private !== true) {
    throw releaseError('package.json must keep private set to true for the GitHub-only release');
  }
  return Object.freeze({ name: value.name, version: value.version });
}

async function readPackageIdentity(root) {
  let source;
  try { source = await fs.readFile(path.join(root, 'package.json'), 'utf8'); }
  catch (error) { throw releaseError('could not read package.json', error); }
  let parsed;
  try { parsed = JSON.parse(source); }
  catch (error) { throw releaseError('package.json is not valid JSON', error); }
  return validatePackageIdentity(parsed);
}

async function repositoryState(root) {
  const environment = sanitizedEnvironment();
  const [{ stdout: topLevel }, { stdout: commit }, { stdout: status }] = await Promise.all([
    execute('git', ['rev-parse', '--show-toplevel'], { cwd: root, env: environment }),
    execute('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, env: environment }),
    execute('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: root,
      env: environment,
    }),
  ]);
  const actualRoot = await fs.realpath(root);
  const gitRoot = await fs.realpath(topLevel.trim());
  if (actualRoot !== gitRoot) throw releaseError('root must be the repository top level');
  const normalizedCommit = commit.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(normalizedCommit)) throw releaseError('Git returned an invalid commit id');
  return { commit: normalizedCommit, status };
}

function validatePortableComponent(component) {
  if (!component || component === '.' || component === '..' || component.toLowerCase() === '.git'
    || component.length > 255 || component.endsWith(' ') || component.endsWith('.')
    || WINDOWS_FORBIDDEN_CHARACTER.test(component) || WINDOWS_RESERVED_COMPONENT.test(component)) {
    throw releaseError(`release commit contains a path that is unsafe on Windows: ${component || '(empty component)'}`);
  }
}

async function trackedFilesAt(root, commit) {
  const { stdout } = await execute('git', [
    'ls-tree', '-r', '-z', commit,
  ], {
    cwd: root,
    encoding: 'buffer',
    env: sanitizedEnvironment(),
  });
  let text;
  try { text = utf8.decode(stdout); }
  catch (error) { throw releaseError('release commit contains a path that is not valid UTF-8', error); }
  const rows = text.split('\0');
  if (rows.at(-1) !== '') throw releaseError('Git returned a malformed tree inventory');
  rows.pop();
  if (!rows.length) throw releaseError('release commit has no tracked files');
  const files = new Map();
  const portableNames = new Set();
  for (const entry of rows) {
    const separator = entry.indexOf('\t');
    if (separator < 1) throw releaseError('Git returned a malformed tree entry');
    const metadata = entry.slice(0, separator).split(' ');
    const gitPath = entry.slice(separator + 1);
    if (metadata.length !== 3 || !SUPPORTED_GIT_MODES.has(metadata[0]) || metadata[1] !== 'blob'
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(metadata[2])) {
      throw releaseError(`release commit contains a link, submodule, or unsupported entry at ${gitPath || '(unnamed path)'}`);
    }
    if (!gitPath || gitPath.includes('\\') || path.posix.isAbsolute(gitPath)) {
      throw releaseError('release commit contains an unsafe path');
    }
    for (const component of gitPath.split('/')) validatePortableComponent(component);
    const portableName = gitPath.normalize('NFC').toLowerCase();
    if (portableNames.has(portableName)) {
      throw releaseError(`release commit contains paths that collide on Windows at ${gitPath}`);
    }
    portableNames.add(portableName);
    files.set(gitPath, Object.freeze({ mode: metadata[0], object: metadata[2] }));
  }
  if (!files.has('package.json')) throw releaseError('release commit does not contain package.json');
  return files;
}

function objectNameSet(output, label) {
  const names = new Set();
  for (const line of output.trim().split(/\r?\n/u).filter(Boolean)) {
    const object = line.split(' ', 1)[0];
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(object)) {
      throw releaseError(`Git returned an invalid object name while checking ${label}`);
    }
    names.add(object);
  }
  if (!names.size) throw releaseError(`Git returned no objects while checking ${label}`);
  return names;
}

async function assertPublicReleaseHistory(root, commit) {
  const environment = sanitizedEnvironment();
  const [
    { stdout: count },
    { stdout: ancestry },
    { stdout: allOutput },
    { stdout: reachableOutput },
    { stdout: alternatesPath },
    { stdout: shallow },
    { stdout: rawCommit },
  ] = await Promise.all([
    execute('git', ['rev-list', '--count', commit], { cwd: root, env: environment }),
    execute('git', ['rev-list', '--parents', '--max-count=1', commit], { cwd: root, env: environment }),
    execute('git', ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], {
      cwd: root,
      env: environment,
    }),
    execute('git', ['rev-list', '--objects', commit], { cwd: root, env: environment }),
    execute('git', ['rev-parse', '--git-path', 'objects/info/alternates'], {
      cwd: root,
      env: environment,
    }),
    execute('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, env: environment }),
    execute('git', ['--no-replace-objects', 'cat-file', 'commit', commit], {
      cwd: root,
      encoding: 'buffer',
      env: environment,
    }),
  ]);
  if (shallow.trim() !== 'false') {
    throw releaseError('release checkout must not be a shallow repository');
  }
  const headerEnd = rawCommit.indexOf(Buffer.from('\n\n'));
  if (headerEnd === -1) throw releaseError('release HEAD has a malformed commit object');
  const commitHeaders = rawCommit.subarray(0, headerEnd).toString('ascii').split('\n');
  if (commitHeaders.some(header => header.startsWith('parent '))) {
    throw releaseError('release checkout must contain exactly one parentless public commit');
  }
  if (count.trim() !== '1' || ancestry.trim().split(/\s+/u).length !== 1) {
    throw releaseError('release checkout must contain exactly one parentless public commit');
  }
  const allObjects = objectNameSet(allOutput, 'the public object store');
  const reachableObjects = objectNameSet(reachableOutput, 'objects reachable from HEAD');
  if (allObjects.size !== reachableObjects.size
    || [...allObjects].some(object => !reachableObjects.has(object))) {
    throw releaseError('release checkout contains Git objects outside the public HEAD');
  }
  const alternates = path.resolve(root, alternatesPath.trim());
  try {
    await fs.lstat(alternates);
    throw releaseError('release checkout uses a Git alternate object store');
  } catch (error) {
    if (error?.message?.startsWith('Release build:')) throw error;
    if (error?.code !== 'ENOENT') throw releaseError('could not inspect Git alternates', error);
  }
}

function assertCleanState(state) {
  if (state.status.length !== 0) {
    throw releaseError('working tree is not clean; commit or remove every tracked and untracked change first');
  }
}

async function verifyReleaseCandidate(root) {
  const environment = sanitizedEnvironment();
  const emptyTemplate = path.join(root, `.fieldwork-empty-git-template-${randomUUID()}`);
  await fs.mkdir(emptyTemplate);
  try {
    await execute('git', [
      '-c', 'core.autocrlf=false', 'init', '--quiet', `--template=${emptyTemplate}`,
    ], {
      cwd: root,
      env: environment,
    });
  } finally {
    await fs.rmdir(emptyTemplate);
  }
  await execute('git', ['-c', 'core.autocrlf=false', 'add', '--force', '--all', '--', '.'], {
    cwd: root,
    env: environment,
  });
  const install = npmCommand(['ci', '--no-fund', '--no-audit', '--ignore-scripts']);
  await execute(install.command, install.arguments, {
    cwd: root,
    env: environment,
    timeout: 300_000,
  });
  const check = npmCommand(['run', 'check']);
  await execute(check.command, check.arguments, {
    cwd: root,
    env: environment,
    timeout: 300_000,
  });
  await execute(process.execPath, [path.join(root, 'scripts', 'release-check.mjs')], {
    cwd: root,
    env: releaseCheckEnvironment(),
    timeout: 300_000,
  });
}

function tarNumber(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  if (field[0] === undefined || (field[0] & 0x80) !== 0) {
    throw releaseError(`Git archive has an unsupported ${label}`);
  }
  const text = field.toString('ascii').replace(/\0.*$/su, '').trim();
  if (!/^[0-7]+$/u.test(text)) throw releaseError(`Git archive has an invalid ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw releaseError(`Git archive has an unsafe ${label}`);
  return value;
}

function tarString(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  if (end !== -1 && !field.subarray(end).every(byte => byte === 0)) {
    throw releaseError(`Git archive has nonzero bytes after ${label}`);
  }
  try { return utf8.decode(end === -1 ? field : field.subarray(0, end)); }
  catch (error) { throw releaseError(`Git archive has invalid UTF-8 in ${label}`, error); }
}

function tarChecksum(header) {
  let checksum = 0;
  for (let index = 0; index < header.length; index++) {
    checksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return checksum;
}

function assertTarChecksum(header) {
  const expected = tarNumber(header, 148, 8, 'header checksum');
  const actual = tarChecksum(header);
  if (actual !== expected) throw releaseError('Git archive has an invalid header checksum');
  return actual;
}

function tarOctalBytes(value, length, style, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw releaseError(`archive has an unsafe ${label}`);
  const terminatorLength = style === 'npm' ? 2 : 1;
  const digits = value.toString(8);
  if (digits.length > length - terminatorLength) {
    throw releaseError(`archive has an oversized ${label}`);
  }
  const suffix = style === 'npm' ? ' \0' : '\0';
  return Buffer.from(`${digits.padStart(length - terminatorLength, '0')}${suffix}`, 'ascii');
}

function assertExactOctalField(header, offset, length, value, style, label) {
  const actual = header.subarray(offset, offset + length);
  const expected = tarOctalBytes(value, length, style, label);
  if (!actual.equals(expected)) throw releaseError(`archive has noncanonical ${label}`);
}

function assertZeroField(header, offset, length, label) {
  if (!header.subarray(offset, offset + length).every(byte => byte === 0)) {
    throw releaseError(`archive has nonzero ${label}`);
  }
}

function assertCanonicalTarHeader(header, {
  style,
  mode,
  size,
  mtime,
  type,
}) {
  if (style !== 'git' && style !== 'npm') throw new TypeError('unknown TAR header style');
  const name = tarString(header, 0, 100, 'entry name');
  const prefix = tarString(header, 345, 155, 'entry prefix');
  if (tarString(header, 157, 100, 'entry link name')) {
    throw releaseError('archive contains an unexpected linked entry');
  }
  assertExactOctalField(header, 100, 8, mode, style, 'entry mode');
  if (style === 'npm') {
    assertZeroField(header, 108, 8, 'entry uid');
    assertZeroField(header, 116, 8, 'entry gid');
  } else {
    assertExactOctalField(header, 108, 8, 0, style, 'entry uid');
    assertExactOctalField(header, 116, 8, 0, style, 'entry gid');
  }
  assertExactOctalField(header, 124, 12, size, style, 'entry size');
  assertExactOctalField(header, 136, 12, mtime, style, 'entry modification time');
  const checksum = tarChecksum(header);
  assertExactOctalField(header, 148, 8, checksum, style, 'header checksum');
  if (header[156] !== type.charCodeAt(0)) throw releaseError('archive has an unexpected entry type');
  if (!header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii'))
    || !header.subarray(263, 265).equals(Buffer.from('00', 'ascii'))) {
    throw releaseError('archive contains a non-USTAR header');
  }
  const expectedOwner = style === 'git' ? 'root' : '';
  if (tarString(header, 265, 32, 'owner name') !== expectedOwner
    || tarString(header, 297, 32, 'group name') !== expectedOwner) {
    throw releaseError('archive has noncanonical owner metadata');
  }
  assertExactOctalField(header, 329, 8, 0, style, 'device major');
  assertExactOctalField(header, 337, 8, 0, style, 'device minor');
  assertZeroField(header, 500, 12, 'USTAR trailer');
  return Object.freeze({ name, prefix });
}

function assertZeroPadding(archive, start, end, label) {
  if (!archive.subarray(start, end).every(byte => byte === 0)) {
    throw releaseError(`${label} contains nonzero entry padding`);
  }
}

function parsePax(data, label) {
  const values = new Map();
  let cursor = 0;
  while (cursor < data.length) {
    const separator = data.indexOf(0x20, cursor);
    if (separator === -1) throw releaseError(`Git archive has malformed ${label} metadata`);
    const lengthText = data.subarray(cursor, separator).toString('ascii');
    if (!/^[1-9][0-9]*$/u.test(lengthText)) throw releaseError(`Git archive has malformed ${label} metadata`);
    const length = Number(lengthText);
    const end = cursor + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw releaseError(`Git archive has malformed ${label} metadata`);
    }
    const record = data.subarray(separator + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw releaseError(`Git archive has malformed ${label} metadata`);
    const key = record.subarray(0, equals).toString('ascii');
    if (!/^[A-Za-z0-9_.-]+$/u.test(key) || values.has(key)) {
      throw releaseError(`Git archive has unsupported ${label} metadata`);
    }
    let value;
    try { value = utf8.decode(record.subarray(equals + 1)); }
    catch (error) { throw releaseError(`Git archive has invalid UTF-8 in ${label} metadata`, error); }
    values.set(key, value);
    cursor = end;
  }
  return values;
}

function writeTarStringField(header, offset, length, value, label) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw releaseError(`canonical TAR ${label} is too long`);
  bytes.copy(header, offset);
}

function writeTarOctalField(header, offset, length, value, style, label) {
  tarOctalBytes(value, length, style, label).copy(header, offset);
}

function splitUstarPath(value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= 100) return Object.freeze({ name: value, prefix: '' });
  let selected = null;
  for (let index = value.indexOf('/'); index !== -1; index = value.indexOf('/', index + 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      selected = { name, prefix };
    }
  }
  return selected ? Object.freeze(selected) : null;
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  const payloadLength = Buffer.byteLength(payload, 'utf8');
  let length = payloadLength + 2;
  for (;;) {
    const next = payloadLength + String(length).length + 1;
    if (next === length) return Buffer.from(`${length} ${payload}`, 'utf8');
    length = next;
  }
}

function canonicalPaxData(fields) {
  return Buffer.concat(fields.map(([key, value]) => paxRecord(key, String(value))));
}

function canonicalTarHeader({
  style,
  name,
  prefix = '',
  mode,
  size,
  mtime,
  type,
}) {
  const header = Buffer.alloc(512);
  writeTarStringField(header, 0, 100, name, 'entry name');
  writeTarOctalField(header, 100, 8, mode, style, 'entry mode');
  if (style === 'git') {
    writeTarOctalField(header, 108, 8, 0, style, 'entry uid');
    writeTarOctalField(header, 116, 8, 0, style, 'entry gid');
  }
  writeTarOctalField(header, 124, 12, size, style, 'entry size');
  writeTarOctalField(header, 136, 12, mtime, style, 'entry modification time');
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  Buffer.from('ustar\0', 'ascii').copy(header, 257);
  Buffer.from('00', 'ascii').copy(header, 263);
  if (style === 'git') {
    writeTarStringField(header, 265, 32, 'root', 'owner name');
    writeTarStringField(header, 297, 32, 'root', 'group name');
  }
  writeTarOctalField(header, 329, 8, 0, style, 'device major');
  writeTarOctalField(header, 337, 8, 0, style, 'device minor');
  writeTarStringField(header, 345, 155, prefix, 'entry prefix');
  writeTarOctalField(header, 148, 8, tarChecksum(header), style, 'header checksum');
  return header;
}

function appendCanonicalTarRecord(chunks, header, data) {
  chunks.push(header, data);
  const padding = (512 - (data.length % 512)) % 512;
  if (padding) chunks.push(Buffer.alloc(padding));
}

function canonicalTarArchive(entries, {
  style,
  mtime,
  globalComment,
}) {
  const chunks = [];
  let length = 0;
  const append = (header, data) => {
    appendCanonicalTarRecord(chunks, header, data);
    length += 512 + Math.ceil(data.length / 512) * 512;
  };
  if (globalComment !== undefined) {
    const data = canonicalPaxData([['comment', globalComment]]);
    append(canonicalTarHeader({
      style,
      name: 'pax_global_header',
      mode: 0o666,
      size: data.length,
      mtime,
      type: 'g',
    }), data);
  }
  for (const entry of entries) {
    const directory = entry.type === '5';
    const normalized = directory && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
    archivePath(normalized);
    const data = directory ? Buffer.alloc(0) : entry.data;
    if (!Buffer.isBuffer(data)) throw releaseError('canonical TAR entry data must be bytes');
    let fields = splitUstarPath(entry.path);
    if (!fields) {
      const paxFields = [['path', entry.path]];
      if (style === 'npm') paxFields.push(['mtime', mtime], ['size', data.length]);
      const paxData = canonicalPaxData(paxFields);
      const digest = createHash('sha256').update(entry.path, 'utf8').digest('hex').slice(0, 32);
      append(canonicalTarHeader({
        style,
        name: `PaxHeader/${digest}`,
        mode: style === 'git' ? 0o666 : 0o644,
        size: paxData.length,
        mtime,
        type: 'x',
      }), paxData);
      const fallback = directory ? `PaxFiles/${digest}/` : `PaxFiles/${digest}`;
      fields = splitUstarPath(fallback);
    }
    append(canonicalTarHeader({
      style,
      name: fields.name,
      prefix: fields.prefix,
      mode: entry.mode,
      size: data.length,
      mtime,
      type: entry.type,
    }), data);
  }
  const minimumLength = length + 1024;
  const finalLength = style === 'git'
    ? Math.ceil(minimumLength / 10_240) * 10_240
    : minimumLength;
  chunks.push(Buffer.alloc(finalLength - length));
  return Buffer.concat(chunks, finalLength);
}

async function canonicalSourceArchive(directory, trackedFiles, archivePrefix, mtime, commit) {
  const directories = new Set([`${archivePrefix}/`]);
  const entries = [];
  for (const [gitPath, expected] of trackedFiles) {
    const parts = gitPath.split('/');
    for (let length = 1; length < parts.length; length++) {
      directories.add(`${archivePrefix}/${parts.slice(0, length).join('/')}/`);
    }
    const data = await fs.readFile(path.join(directory, ...parts));
    if (gitBlobObject(data, expected.object) !== expected.object) {
      throw releaseError(`source TAR input changed at ${gitPath}`);
    }
    entries.push({
      path: `${archivePrefix}/${gitPath}`,
      type: '0',
      mode: expected.mode === '100755' ? 0o755 : 0o644,
      data,
    });
  }
  for (const directoryPath of directories) {
    entries.push({ path: directoryPath, type: '5', mode: 0o755, data: Buffer.alloc(0) });
  }
  entries.sort((left, right) => compareFilenames(left.path, right.path));
  return canonicalTarArchive(entries, { style: 'git', mtime, globalComment: commit });
}

async function canonicalGzipArchive(archive) {
  const compressed = Buffer.from(await gzip(archive, { level: 9, mtime: 0 }));
  if (compressed.length < 18 || compressed[0] !== 0x1f || compressed[1] !== 0x8b
    || compressed[2] !== 0x08 || compressed[3] !== 0x00
    || !compressed.subarray(4, 8).every(byte => byte === 0) || compressed[8] !== 0x02) {
    throw releaseError('could not create a canonical gzip archive');
  }
  compressed[9] = 0xff;
  return compressed;
}

function archivePath(value) {
  if (!value || value.includes('\\') || path.posix.isAbsolute(value) || value.endsWith('/')) {
    throw releaseError('Git archive contains an unsafe path');
  }
  for (const component of value.split('/')) validatePortableComponent(component);
  return value;
}

function gitBlobObject(data, expectedObject) {
  const algorithm = expectedObject.length === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm)
    .update(Buffer.from(`blob ${data.length}\0`, 'utf8'))
    .update(data)
    .digest('hex');
}

function expectedExtractionTree(trackedFiles) {
  const children = new Map([['', new Map()]]);
  const directories = new Set(['']);
  for (const gitPath of trackedFiles.keys()) {
    const parts = gitPath.split('/');
    let parent = '';
    for (let index = 0; index < parts.length - 1; index++) {
      const child = parts[index];
      children.get(parent).set(child, 'directory');
      parent = parent ? `${parent}/${child}` : child;
      directories.add(parent);
      if (!children.has(parent)) children.set(parent, new Map());
    }
    children.get(parent).set(parts.at(-1), 'file');
  }
  return { children, directories };
}

async function prepareExtractionDirectories(directory, extractionTree) {
  const records = new Map();
  const root = await inspectPlainDirectory(directory, 'Git archive extraction root');
  records.set('', root);
  const directories = [...extractionTree.directories]
    .filter(Boolean)
    .sort((left, right) => left.split('/').length - right.split('/').length || compareFilenames(left, right));
  for (const gitDirectory of directories) {
    const parentKey = path.posix.dirname(gitDirectory) === '.' ? '' : path.posix.dirname(gitDirectory);
    const parent = await assertDirectoryIdentity(records.get(parentKey), 'Git archive parent directory');
    const target = path.join(directory, ...gitDirectory.split('/'));
    try { await fs.mkdir(target, { recursive: false }); }
    catch (error) { throw releaseError('could not exclusively create a Git archive directory', error); }
    const record = await inspectPlainDirectory(target, 'Git archive directory');
    if (!samePath(path.dirname(record.real), parent.real)) {
      throw releaseError('Git archive directory escaped its extraction parent');
    }
    records.set(gitDirectory, record);
  }
  return records;
}

async function assertExtractionChain(directoryKey, records) {
  await assertDirectoryIdentity(records.get(''), 'Git archive extraction root');
  if (!directoryKey) return;
  const parts = directoryKey.split('/');
  for (let length = 1; length <= parts.length; length++) {
    await assertDirectoryIdentity(
      records.get(parts.slice(0, length).join('/')),
      'Git archive parent directory',
    );
  }
}

async function writeExtractedFile(directory, gitPath, data, expected, records) {
  const parentKey = path.posix.dirname(gitPath) === '.' ? '' : path.posix.dirname(gitPath);
  await assertExtractionChain(parentKey, records);
  const parent = records.get(parentKey);
  const destination = path.join(directory, ...gitPath.split('/'));
  const mode = expected.mode === '100755' ? 0o755 : 0o644;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
  let createdStat;
  let handle;
  let failure;
  try {
    handle = await fs.open(destination, flags, mode);
    createdStat = await handle.stat({ bigint: true });
    const onPath = await fs.lstat(destination, { bigint: true });
    const real = await fs.realpath(destination);
    assertStableFileIdentity(createdStat, 'Git archive file');
    assertStableFileIdentity(onPath, 'Git archive file');
    if (!createdStat.isFile() || createdStat.nlink !== 1n || !sameFileIdentity(createdStat, onPath)
      || !samePath(path.dirname(real), parent.real) || !pathIsWithin(records.get('').real, real)) {
      throw releaseError('Git archive file escaped its extraction directory');
    }
    await handle.writeFile(data);
    if (process.platform !== 'win32') await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    if (handle) await handle.close();
  }
  if (failure) {
    if (createdStat) {
      try {
        const current = await fs.lstat(destination, { bigint: true });
        if (sameFileIdentity(current, createdStat)) await fs.unlink(destination);
      } catch { /* Identity failure is safer than deleting an unknown replacement. */ }
    }
    throw failure;
  }
  await assertExtractionChain(parentKey, records);
  const finalStat = await fs.lstat(destination, { bigint: true });
  if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.nlink !== 1n
    || !sameFileIdentity(finalStat, createdStat)) {
    throw releaseError('Git archive file changed while it was extracted');
  }
}

async function assertExtractedTree(directory, extractionTree, records, trackedFiles) {
  for (const [directoryKey, expectedChildren] of extractionTree.children) {
    const record = await assertDirectoryIdentity(
      records.get(directoryKey),
      directoryKey ? 'Git archive directory' : 'Git archive extraction root',
    );
    const entries = await fs.readdir(record.path, { withFileTypes: true });
    const actualNames = entries.map(entry => entry.name).sort(compareFilenames);
    const expectedNames = [...expectedChildren.keys()].sort(compareFilenames);
    if (actualNames.length !== expectedNames.length
      || actualNames.some((name, index) => name !== expectedNames[index])) {
      throw releaseError('Git archive extraction contains an unexpected filesystem entry');
    }
    for (const entry of entries) {
      const kind = expectedChildren.get(entry.name);
      const child = path.join(record.path, entry.name);
      const stat = await fs.lstat(child, { bigint: true });
      if (kind === 'directory') {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink()) {
          throw releaseError('Git archive extraction contains a linked directory');
        }
      } else if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()
        || stat.nlink !== 1n) {
        throw releaseError('Git archive extraction contains a linked or non-regular file');
      }
    }
  }
  for (const [gitPath, expected] of trackedFiles) {
    const file = path.join(directory, ...gitPath.split('/'));
    const stat = await fs.lstat(file, { bigint: true });
    if (process.platform !== 'win32') {
      const actualExecutable = (stat.mode & 0o111n) !== 0n;
      if (actualExecutable !== (expected.mode === '100755')) {
        throw releaseError(`extracted Git archive mode changed at ${gitPath}`);
      }
    }
    const bytes = await fs.readFile(file);
    if (gitBlobObject(bytes, expected.object) !== expected.object) {
      throw releaseError(`extracted Git archive bytes changed at ${gitPath}`);
    }
  }
}

function stripArchivePrefix(suppliedPath, archivePrefix, { directory = false } = {}) {
  const normalized = directory && suppliedPath.endsWith('/')
    ? suppliedPath.slice(0, -1)
    : suppliedPath;
  if (!archivePrefix) return archivePath(normalized);
  if (directory && normalized === archivePrefix) return '';
  const required = `${archivePrefix}/`;
  if (!normalized.startsWith(required)) {
    throw releaseError('Git archive contains a path outside its required top-level directory');
  }
  return archivePath(normalized.slice(required.length));
}

async function extractGitArchive(archive, directory, trackedFiles, {
  archivePrefix = '',
  commit,
  phase,
  testSeam,
} = {}) {
  if (!Buffer.isBuffer(archive) || archive.length === 0) {
    throw releaseError('Git archive is empty or unavailable');
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit ?? '') || archive.length % 10_240 !== 0) {
    throw releaseError('Git archive does not have the required commit-bound block shape');
  }
  if (archivePrefix) archivePath(archivePrefix);
  const extractionTree = expectedExtractionTree(trackedFiles);
  const directoryRecords = await prepareExtractionDirectories(directory, extractionTree);
  await runTestSeam(testSeam, 'before-extract', { directory, phase });
  const extracted = new Set();
  let pendingPax = null;
  let archiveMtime = null;
  let sawGlobalHeader = false;
  let entryIndex = 0;
  let offset = 0;
  let ended = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) {
      const markerStart = offset - 512;
      if (archive.length - markerStart < 1024 || !archive.subarray(markerStart).every(byte => byte === 0)) {
        throw releaseError('Git archive has data after its end marker');
      }
      ended = true;
      break;
    }
    assertTarChecksum(header);
    const size = tarNumber(header, 124, 12, 'entry size');
    const mtime = tarNumber(header, 136, 12, 'entry modification time');
    const paddedSize = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(paddedSize) || offset + paddedSize > archive.length) {
      throw releaseError('Git archive contains a truncated entry');
    }
    const data = archive.subarray(offset, offset + size);
    assertZeroPadding(archive, offset + size, offset + paddedSize, 'Git archive');
    offset += paddedSize;
    const type = String.fromCharCode(header[156]);
    if (type === 'g') {
      const values = parsePax(data, 'global PAX');
      const fields = assertCanonicalTarHeader(header, {
        style: 'git', mode: 0o666, size, mtime, type,
      });
      if (entryIndex !== 0 || sawGlobalHeader || pendingPax || fields.name !== 'pax_global_header'
        || fields.prefix !== '' || values.size !== 1 || values.get('comment') !== commit) {
        throw releaseError('Git archive has unsupported global PAX metadata');
      }
      archiveMtime = mtime;
      sawGlobalHeader = true;
      entryIndex += 1;
      continue;
    }
    if (!sawGlobalHeader || archiveMtime === null || mtime !== archiveMtime) {
      throw releaseError('Git archive has inconsistent commit metadata');
    }
    if (type === 'x') {
      const values = parsePax(data, 'PAX');
      const fields = assertCanonicalTarHeader(header, {
        style: 'git', mode: 0o666, size, mtime, type,
      });
      const headerPath = fields.prefix ? `${fields.prefix}/${fields.name}` : fields.name;
      archivePath(headerPath);
      if (pendingPax || values.size !== 1 || !values.has('path')) {
        throw releaseError('Git archive has unsupported PAX metadata');
      }
      pendingPax = values;
      entryIndex += 1;
      continue;
    }
    const name = tarString(header, 0, 100, 'entry name');
    const prefix = tarString(header, 345, 155, 'entry prefix');
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const suppliedPath = pendingPax?.get('path') ?? headerPath;
    pendingPax = null;
    if (type === '5') {
      const safeDirectory = stripArchivePrefix(suppliedPath, archivePrefix, { directory: true });
      if (size !== 0 || (safeDirectory && !extractionTree.directories.has(safeDirectory))) {
        throw releaseError(`Git archive contains an unexpected directory: ${safeDirectory}`);
      }
      assertCanonicalTarHeader(header, {
        style: 'git', mode: 0o755, size, mtime, type,
      });
      entryIndex += 1;
      continue;
    }
    if (type !== '0') {
      throw releaseError(`Git archive contains an unsupported entry type at ${suppliedPath || '(unnamed path)'}`);
    }
    const safePath = stripArchivePrefix(suppliedPath, archivePrefix);
    const expected = trackedFiles.get(safePath);
    if (!expected || extracted.has(safePath)) {
      throw releaseError(`Git archive contains an unexpected or duplicate file: ${safePath}`);
    }
    assertCanonicalTarHeader(header, {
      style: 'git',
      mode: expected.mode === '100755' ? 0o755 : 0o644,
      size,
      mtime,
      type,
    });
    if (gitBlobObject(data, expected.object) !== expected.object) {
      throw releaseError(`Git archive bytes do not match the release commit at ${safePath}`);
    }
    await writeExtractedFile(directory, safePath, data, expected, directoryRecords);
    extracted.add(safePath);
    entryIndex += 1;
  }
  if (!ended || pendingPax || !sawGlobalHeader) throw releaseError('Git archive is incomplete');
  if (extracted.size !== trackedFiles.size) {
    const missing = [...trackedFiles.keys()].find(gitPath => !extracted.has(gitPath));
    throw releaseError(`Git archive is missing a tracked file: ${missing}`);
  }
  await assertExtractedTree(directory, extractionTree, directoryRecords, trackedFiles);
  return Object.freeze({
    assertCurrent: () => assertExtractedTree(
      directory,
      extractionTree,
      directoryRecords,
      trackedFiles,
    ),
    mtime: archiveMtime,
  });
}

function artifactRecordForBytes(filename, bytes) {
  if (path.basename(filename) !== filename || !Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw releaseError('could not form an artifact record from generated bytes');
  }
  return Object.freeze({
    filename,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

async function exportCommitTree(root, commit, directory, archiveFile, trackedFiles, options = {}) {
  const archivePrefix = options.archivePrefix ?? '';
  const scratchArchive = path.join(
    path.dirname(directory),
    `.fieldwork-git-archive-${randomUUID()}.tar`,
  );
  await fs.mkdir(directory);
  let archive;
  try {
    const arguments_ = [
      '-c', 'core.autocrlf=false', '-c', 'tar.umask=0022',
      'archive', '--format=tar', `--output=${scratchArchive}`,
    ];
    if (archivePrefix) arguments_.push(`--prefix=${archivePrefix}/`);
    arguments_.push(commit);
    await execute('git', arguments_, { cwd: root, env: sanitizedEnvironment() });
    archive = await fs.readFile(scratchArchive);
  } finally {
    try { await fs.unlink(scratchArchive); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const extracted = await extractGitArchive(archive, directory, trackedFiles, { ...options, commit });
  let archiveRecord;
  if (archiveFile !== null) {
    if (!archivePrefix) throw releaseError('published source TAR requires a top-level directory');
    await extracted.assertCurrent();
    const canonicalArchive = await canonicalSourceArchive(
      directory,
      trackedFiles,
      archivePrefix,
      extracted.mtime,
      commit,
    );
    archiveRecord = artifactRecordForBytes(path.basename(archiveFile), canonicalArchive);
    await fs.writeFile(archiveFile, canonicalArchive, { flag: 'wx' });
  }
  return Object.freeze({ ...extracted, archiveRecord });
}

async function sha256File(file) {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

async function artifactRecord(directory, filename) {
  if (path.basename(filename) !== filename) throw releaseError('an artifact filename was not a basename');
  const file = path.join(directory, filename);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw releaseError(`artifact is not a non-empty regular file: ${filename}`);
  }
  return Object.freeze({ filename, bytes: stat.size, sha256: await sha256File(file) });
}

function escapedAt(source, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) count++;
  return count % 2 === 1;
}

function matchingMarkdownBracket(source, opening) {
  let depth = 1;
  for (let index = opening + 1; index < source.length; index++) {
    if (escapedAt(source, index)) continue;
    if (source[index] === '[') depth++;
    else if (source[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

function quotedMarkdownTitle(source, start, quote) {
  const closing = quote === '(' ? ')' : quote;
  for (let index = start + 1; index < source.length; index++) {
    if (escapedAt(source, index)) continue;
    if (source[index] === '\r' || source[index] === '\n') return -1;
    if (source[index] === closing) return index + 1;
  }
  return -1;
}

function couldStartReferenceDefinition(source, opening) {
  const carriage = source.lastIndexOf('\r', opening - 1);
  const newline = source.lastIndexOf('\n', opening - 1);
  const prefix = source.slice(Math.max(carriage, newline) + 1, opening);
  return /^[\t >+*().0-9-]*$/u.test(prefix);
}

function inlineMarkdownDestination(source, opening) {
  let index = opening + 1;
  while (source[index] === ' ' || source[index] === '\t') index++;
  let target = '';
  if (source[index] === '<') {
    const start = ++index;
    while (index < source.length && source[index] !== '>'
      && source[index] !== '\r' && source[index] !== '\n') index++;
    if (source[index] !== '>') throw releaseError('standalone release note has an unterminated link destination');
    target = source.slice(start, index++);
  } else {
    const start = index;
    let depth = 0;
    for (; index < source.length; index++) {
      if (escapedAt(source, index)) continue;
      const character = source[index];
      if (character === '\r' || character === '\n') break;
      if ((character === ' ' || character === '\t') && depth === 0) break;
      if (character === '(') depth++;
      else if (character === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (depth !== 0) throw releaseError('standalone release note has an unbalanced link destination');
    target = source.slice(start, index);
  }
  if (!target) throw releaseError('standalone release note has an empty link destination');
  while (source[index] === ' ' || source[index] === '\t') index++;
  if (source[index] !== ')') {
    if (!/["'(]/u.test(source[index] ?? '')) {
      throw releaseError('standalone release note has an invalid link title');
    }
    const afterTitle = quotedMarkdownTitle(source, index, source[index]);
    if (afterTitle === -1) throw releaseError('standalone release note has an unterminated link title');
    index = afterTitle;
    while (source[index] === ' ' || source[index] === '\t') index++;
  }
  if (source[index] !== ')') throw releaseError('standalone release note has an unterminated link');
  return { target, end: index + 1 };
}

function collectInlineMarkdownLinks(source, start = 0, end = source.length) {
  const links = [];
  for (let index = start; index < end; index++) {
    if (source[index] !== '[' || escapedAt(source, index)) continue;
    const closing = matchingMarkdownBracket(source, index);
    if (closing === -1 || closing >= end) continue;
    if (source[closing + 1] === ':' && couldStartReferenceDefinition(source, index)) {
      throw releaseError('standalone release note uses unsupported reference-style Markdown links');
    }
    let suffix = closing + 1;
    while (suffix < end && /[\t \r\n]/u.test(source[suffix])) suffix++;
    if (source[suffix] === '[') {
      throw releaseError('standalone release note uses unsupported reference-style Markdown links');
    }
    if (source[closing + 1] !== '(') continue;
    const parsed = inlineMarkdownDestination(source, closing + 1);
    if (parsed.end > end) throw releaseError('standalone release note has an invalid nested link');
    links.push(...collectInlineMarkdownLinks(source, index + 1, closing));
    links.push(parsed.target);
    index = parsed.end - 1;
  }
  return links;
}

function markdownLinkDestinations(source) {
  const destinations = collectInlineMarkdownLinks(source);
  const rawAttribute = /\b(?:href|src)\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s>]+))/giu;
  for (const match of source.matchAll(rawAttribute)) {
    destinations.push(match.slice(1).find(value => value !== undefined));
  }
  return destinations;
}

function assertStandaloneReleaseNotes(source, releaseNotePath) {
  let text;
  try { text = utf8.decode(source); }
  catch (error) { throw releaseError(`release note is not valid UTF-8: ${releaseNotePath}`, error); }
  for (const destination of markdownLinkDestinations(text)) {
    if (!destination.startsWith('#')
      && !/^(?:https?:|mailto:)/iu.test(destination)) {
      throw releaseError(`standalone release note contains a repository-relative Markdown link: ${destination}`);
    }
  }
}

async function validatePackedFiles(item, trackedFiles, root) {
  if (!Array.isArray(item.files) || item.files.length === 0) {
    throw releaseError('npm pack returned no file inventory');
  }
  const seen = new Set();
  for (const row of item.files) {
    const filename = row?.path;
    if (typeof filename !== 'string' || !filename || filename.includes('\\')
      || filename.startsWith('/') || filename.split('/').includes('..')) {
      throw releaseError('npm pack returned an invalid file path');
    }
    if (seen.has(filename)) throw releaseError('npm pack returned a duplicate file path');
    seen.add(filename);
    const expected = trackedFiles.get(filename);
    if (!expected) {
      throw releaseError('npm pack included a file that is not tracked in the release commit');
    }
    const expectedMode = expected.mode === '100755' ? 0o755 : 0o644;
    if (!Number.isSafeInteger(row.size) || row.size < 0 || row.mode !== expectedMode) {
      throw releaseError(`npm pack reported metadata that differs from the release commit at ${filename}`);
    }
    const file = path.join(root, ...filename.split('/'));
    const stat = await fs.lstat(file, { bigint: true });
    const bytes = await fs.readFile(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || BigInt(row.size) !== stat.size || gitBlobObject(bytes, expected.object) !== expected.object) {
      throw releaseError(`npm pack selected bytes that differ from the release commit at ${filename}`);
    }
  }
}

function npmArchivePath(value, { directory = false } = {}) {
  const normalized = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (directory && normalized === 'package') return '';
  if (!normalized.startsWith('package/')) {
    throw releaseError('npm package archive contains a path outside its package directory');
  }
  return archivePath(normalized.slice('package/'.length));
}

async function validateNpmPackageArchive(archiveBytes, item, trackedFiles) {
  let archive;
  try { archive = await gunzip(archiveBytes); }
  catch (error) { throw releaseError('npm pack produced an invalid gzip archive', error); }
  if (!archive.length || archive.length % 512 !== 0) {
    throw releaseError('npm package archive has an invalid TAR block shape');
  }
  const expectedFiles = new Map();
  const expectedDirectories = new Set(['']);
  for (const row of item.files) {
    const expected = trackedFiles.get(row.path);
    expectedFiles.set(row.path, expected);
    const parts = row.path.split('/');
    for (let length = 1; length < parts.length; length++) {
      expectedDirectories.add(parts.slice(0, length).join('/'));
    }
  }

  const seen = new Set();
  const canonicalEntries = [];
  let pendingPax = null;
  let offset = 0;
  let ended = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) {
      const markerStart = offset - 512;
      if (archive.length - markerStart !== 1024 || !archive.subarray(markerStart).every(byte => byte === 0)) {
        throw releaseError('npm package archive has data after its end marker');
      }
      ended = true;
      break;
    }
    assertTarChecksum(header);
    const size = tarNumber(header, 124, 12, 'entry size');
    const mtime = tarNumber(header, 136, 12, 'entry modification time');
    const paddedSize = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(paddedSize) || offset + paddedSize > archive.length) {
      throw releaseError('npm package archive contains a truncated entry');
    }
    const data = archive.subarray(offset, offset + size);
    assertZeroPadding(archive, offset + size, offset + paddedSize, 'npm package archive');
    offset += paddedSize;
    const type = String.fromCharCode(header[156]);
    if (type === 'g') throw releaseError('npm package archive has unsupported global PAX metadata');
    if (type === 'x') {
      const values = parsePax(data, 'PAX');
      const fields = assertCanonicalTarHeader(header, {
        style: 'npm', mode: 0o644, size, mtime: NPM_ARCHIVE_MTIME, type,
      });
      const headerPath = fields.prefix ? `${fields.prefix}/${fields.name}` : fields.name;
      archivePath(headerPath);
      const allowed = new Set(['path', 'mtime', 'size']);
      if (pendingPax || !values.has('path') || [...values.keys()].some(key => !allowed.has(key))
        || (values.has('mtime') && values.get('mtime') !== String(NPM_ARCHIVE_MTIME))
        || (values.has('size') && !/^(?:0|[1-9][0-9]*)$/u.test(values.get('size')))) {
        throw releaseError('npm package archive has unsupported PAX metadata');
      }
      pendingPax = values;
      continue;
    }
    const name = tarString(header, 0, 100, 'entry name');
    const prefix = tarString(header, 345, 155, 'entry prefix');
    const headerPath = prefix ? `${prefix}/${name}` : name;
    archivePath(headerPath.endsWith('/') ? headerPath.slice(0, -1) : headerPath);
    if (pendingPax?.has('size') && pendingPax.get('size') !== String(size)) {
      throw releaseError('npm package archive has inconsistent PAX size metadata');
    }
    const suppliedPath = pendingPax?.get('path') ?? headerPath;
    pendingPax = null;
    if (type === '5') {
      const directoryPath = npmArchivePath(suppliedPath, { directory: true });
      if (size !== 0 || !expectedDirectories.has(directoryPath)) {
        throw releaseError(`npm package archive contains an unexpected directory: ${directoryPath}`);
      }
      assertCanonicalTarHeader(header, {
        style: 'npm', mode: 0o755, size, mtime: NPM_ARCHIVE_MTIME, type,
      });
      continue;
    }
    if (type !== '0') {
      throw releaseError(`npm package archive contains an unsupported entry type at ${suppliedPath}`);
    }
    const filename = npmArchivePath(suppliedPath);
    const expected = expectedFiles.get(filename);
    if (!expected || seen.has(filename)) {
      throw releaseError(`npm package archive contains an unexpected or duplicate file: ${filename}`);
    }
    const expectedMode = expected.mode === '100755' ? 0o755 : 0o644;
    assertCanonicalTarHeader(header, {
      style: 'npm', mode: expectedMode, size, mtime: NPM_ARCHIVE_MTIME, type,
    });
    if (gitBlobObject(data, expected.object) !== expected.object) {
      throw releaseError(`npm package archive bytes or mode differ from the release commit at ${filename}`);
    }
    canonicalEntries.push({
      path: `package/${filename}`,
      type: '0',
      mode: expectedMode,
      data: Buffer.from(data),
    });
    seen.add(filename);
  }
  if (!ended || pendingPax) throw releaseError('npm package archive is incomplete');
  if (seen.size !== expectedFiles.size) {
    const missing = [...expectedFiles.keys()].find(filename => !seen.has(filename));
    throw releaseError(`npm package archive is missing a selected file: ${missing}`);
  }
  canonicalEntries.sort((left, right) => compareFilenames(left.path, right.path));
  return canonicalTarArchive(canonicalEntries, { style: 'npm', mtime: NPM_ARCHIVE_MTIME });
}

async function npmPack(root, directory, trackedFiles, { testSeam } = {}) {
  const invocation = npmCommand([
    'pack', '--json', '--ignore-scripts', '--pack-destination', directory,
  ]);
  const { stdout } = await execute(invocation.command, invocation.arguments, {
    cwd: root,
    env: sanitizedEnvironment(),
  });
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch (error) { throw releaseError('npm pack did not return valid JSON', error); }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw releaseError('npm pack must return exactly one package');
  }
  const item = parsed[0];
  if (!item || typeof item.filename !== 'string' || path.basename(item.filename) !== item.filename) {
    throw releaseError('npm pack returned an invalid archive filename');
  }
  await validatePackedFiles(item, trackedFiles, root);
  const archiveFile = path.join(directory, item.filename);
  await runTestSeam(testSeam, 'before-package-validate', {
    archive: archiveFile,
    directory: root,
  });
  const flags = fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let opened;
  let canonicalBytes;
  try {
    handle = await fs.open(archiveFile, flags);
    opened = await handle.stat({ bigint: true });
    const onPath = await fs.lstat(archiveFile, { bigint: true });
    assertStableFileIdentity(opened, 'npm package archive');
    assertStableFileIdentity(onPath, 'npm package archive');
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(opened, onPath)) {
      throw releaseError('npm package archive is not a stable regular file');
    }
    const archiveBytes = await handle.readFile();
    const canonicalTar = await validateNpmPackageArchive(archiveBytes, item, trackedFiles);
    canonicalBytes = await canonicalGzipArchive(canonicalTar);
    await handle.truncate(0);
    let written = 0;
    while (written < canonicalBytes.length) {
      const result = await handle.write(
        canonicalBytes,
        written,
        canonicalBytes.length - written,
        written,
      );
      if (!result.bytesWritten) throw releaseError('could not write the canonical npm package archive');
      written += result.bytesWritten;
    }
    await handle.truncate(canonicalBytes.length);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  const finalStat = await fs.lstat(archiveFile, { bigint: true });
  if (!sameFileIdentity(opened, finalStat) || finalStat.size !== BigInt(canonicalBytes.length)) {
    throw releaseError('npm package archive changed while it was canonicalized');
  }
  return Object.freeze({
    ...item,
    archiveRecord: artifactRecordForBytes(item.filename, canonicalBytes),
  });
}

function sourceStem(packageName) {
  const unscoped = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName;
  const stem = unscoped.replace(/[^0-9A-Za-z._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!stem) throw releaseError('package name cannot form an artifact filename');
  return stem;
}

function compareFilenames(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function pathExists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function pathIsWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function canonicalDestination(target) {
  const missing = [];
  let cursor = path.resolve(target);
  for (;;) {
    try {
      const existing = await fs.realpath(cursor);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw releaseError('could not resolve the release output root', error);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw releaseError('could not resolve the release output root', error);
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function releaseOutputRoot(repositoryRoot, suppliedRoot) {
  if (suppliedRoot !== undefined && (typeof suppliedRoot !== 'string' || suppliedRoot.length === 0)) {
    throw releaseError('output root must be a non-empty path');
  }
  const requested = path.resolve(suppliedRoot ?? path.join(
    path.dirname(repositoryRoot),
    `${path.basename(repositoryRoot)}-releases`,
  ));
  if (pathIsWithin(repositoryRoot, requested)) {
    throw releaseError('release output must be outside the source repository');
  }
  const canonical = await canonicalDestination(requested);
  if (pathIsWithin(repositoryRoot, canonical)) {
    throw releaseError('release output must be outside the source repository');
  }
  return canonical;
}

function samePath(left, right) {
  return path.relative(left, right) === '';
}

export function sameFileIdentity(left, right) {
  if (left.dev !== right.dev || typeof left.ino !== typeof right.ino) return false;
  const zero = typeof left.ino === 'bigint' ? 0n : 0;
  // A zero inode is not an identity. Fail closed rather than collapse every
  // file on filesystems that cannot provide a stable file id.
  return left.ino !== zero && right.ino !== zero && left.ino === right.ino;
}

function assertStableFileIdentity(stat, label) {
  const zero = typeof stat.ino === 'bigint' ? 0n : 0;
  if (stat.ino === zero) {
    throw releaseError(`${label} filesystem cannot provide a stable file identity`);
  }
}

async function inspectPlainDirectory(directory, label) {
  let stat;
  try { stat = await fs.lstat(directory, { bigint: true }); }
  catch (error) { throw releaseError(`could not inspect ${label}`, error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw releaseError(`${label} must be a plain directory`);
  }
  assertStableFileIdentity(stat, label);
  const real = await fs.realpath(directory);
  return Object.freeze({ path: directory, real, stat });
}

async function materializeReleaseRoot(repositoryRoot, releaseRoot) {
  let existed = true;
  try { await fs.lstat(releaseRoot); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw releaseError('could not inspect the release output root', error);
    existed = false;
  }
  const firstCreated = await fs.mkdir(releaseRoot, { recursive: true });
  const directory = await inspectPlainDirectory(releaseRoot, 'release output root');
  if (!samePath(directory.real, releaseRoot) || pathIsWithin(repositoryRoot, directory.real)) {
    throw releaseError('release output root changed or entered the source repository');
  }
  return Object.freeze({
    created: !existed && firstCreated !== undefined,
    directory,
  });
}

async function assertDirectoryIdentity(record, label) {
  const current = await inspectPlainDirectory(record.path, label);
  if (!samePath(current.real, record.real) || !sameFileIdentity(current.stat, record.stat)) {
    throw releaseError(`${label} changed while the release was built`);
  }
  return current;
}

async function removeOwnedDirectory(record) {
  if (!record) return;
  let current;
  try { current = await inspectPlainDirectory(record.path, 'owned release staging directory'); }
  catch (error) {
    if (error?.cause?.code === 'ENOENT') return;
    return;
  }
  if (!samePath(current.real, record.real) || !sameFileIdentity(current.stat, record.stat)) return;
  await fs.rm(record.path, { recursive: true, force: false });
}

async function removeOwnedEmptyRoot(reservation) {
  if (!reservation?.created) return;
  let current;
  try { current = await assertDirectoryIdentity(reservation.directory, 'release output root'); }
  catch { return; }
  if (!sameFileIdentity(current.stat, reservation.directory.stat)) return;
  try { await fs.rmdir(reservation.directory.path); }
  catch (error) { if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error; }
}

async function runTestSeam(seam, checkpoint, context) {
  if (seam === undefined) return;
  await seam(checkpoint, Object.freeze(context));
}

async function copyArtifactsExclusively(staging, target, filenames) {
  for (const filename of filenames) {
    await fs.copyFile(
      path.join(staging, filename),
      path.join(target, filename),
      fsConstants.COPYFILE_EXCL,
    );
  }
}

async function assertArtifactDirectory(directory, records, label) {
  const expected = new Map(records.map(record => [record.filename, record]));
  if (expected.size !== records.length) throw releaseError('release artifact records contain duplicate names');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const actualNames = entries.map(entry => entry.name).sort(compareFilenames);
  const expectedNames = [...expected.keys()].sort(compareFilenames);
  if (actualNames.length !== expectedNames.length
    || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw releaseError(`${label} contains an unexpected artifact inventory`);
  }
  for (const entry of entries) {
    const record = expected.get(entry.name);
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()
      || stat.size !== record.bytes || await sha256File(file) !== record.sha256) {
      throw releaseError(`${label} contains an artifact that differs from its manifest`);
    }
  }
}

export async function buildRelease({
  root = scriptRoot,
  outputRoot,
  verify = verifyReleaseCandidate,
  [RELEASE_BUILD_TEST_SEAM]: testSeam,
} = {}) {
  const repositoryRoot = await fs.realpath(path.resolve(root));
  const identity = await readPackageIdentity(repositoryRoot);
  const initialState = await repositoryState(repositoryRoot);
  const trackedFiles = await trackedFilesAt(repositoryRoot, initialState.commit);
  assertCleanState(initialState);
  await assertPublicReleaseHistory(repositoryRoot, initialState.commit);
  const releaseNotePath = `docs/releases/${identity.version}.md`;
  if (!trackedFiles.has(releaseNotePath)) {
    throw releaseError(`release note is missing from the commit: ${releaseNotePath}`);
  }
  const releaseRoot = await releaseOutputRoot(repositoryRoot, outputRoot);
  const target = path.join(releaseRoot, `v${identity.version}`);
  if (await pathExists(target)) throw releaseError(`release output already exists: ${target}`);
  if (typeof verify !== 'function') throw new TypeError('release verify hook must be a function');
  if (testSeam !== undefined && typeof testSeam !== 'function') {
    throw new TypeError('release test seam must be a function');
  }

  let completed = false;
  let outputReservation;
  let staging;
  let publishStage;
  let publishedTarget;
  try {
    outputReservation = await materializeReleaseRoot(repositoryRoot, releaseRoot);
    if (await pathExists(target)) throw releaseError(`release output already exists: ${target}`);
    staging = await fs.mkdtemp(path.join(os.tmpdir(), `fieldwork-release-${randomUUID()}-`));
    const verificationRoot = path.join(staging, 'verified-tree');
    await exportCommitTree(
      repositoryRoot,
      initialState.commit,
      verificationRoot,
      null,
      trackedFiles,
      { phase: 'verification', testSeam },
    );
    const verificationIdentity = await readPackageIdentity(verificationRoot);
    if (verificationIdentity.name !== identity.name || verificationIdentity.version !== identity.version) {
      throw releaseError('committed package identity changed before verification');
    }
    await verify(verificationRoot, Object.freeze({
      repositoryRoot,
      commit: initialState.commit,
    }));
    const verifiedState = await repositoryState(repositoryRoot);
    assertCleanState(verifiedState);
    if (verifiedState.commit !== initialState.commit) {
      throw releaseError('HEAD changed while the candidate was being verified');
    }

    await runTestSeam(testSeam, 'before-artifact-snapshot', {
      repositoryRoot,
      commit: initialState.commit,
      stagingRoot: staging,
    });
    const postCallbackState = await repositoryState(repositoryRoot);
    assertCleanState(postCallbackState);
    if (postCallbackState.commit !== initialState.commit) {
      throw releaseError('HEAD changed before the artifact snapshot was captured');
    }
    await assertPublicReleaseHistory(repositoryRoot, initialState.commit);

    const stem = sourceStem(identity.name);
    const sourceArchive = `${stem}-v${identity.version}-source.tar`;
    const sourcePrefix = `${stem}-v${identity.version}`;
    const snapshotRoot = path.join(staging, 'committed-tree');
    const artifactSnapshot = await exportCommitTree(
      repositoryRoot,
      initialState.commit,
      snapshotRoot,
      path.join(staging, sourceArchive),
      trackedFiles,
      { archivePrefix: sourcePrefix, phase: 'artifact', testSeam },
    );
    const snapshotIdentity = await readPackageIdentity(snapshotRoot);
    if (snapshotIdentity.name !== identity.name || snapshotIdentity.version !== identity.version) {
      throw releaseError('committed package identity changed after verification');
    }
    const releaseNotes = `${stem}-v${identity.version}-release-notes.md`;
    const noteSource = path.join(snapshotRoot, ...releaseNotePath.split('/'));
    const noteStat = await fs.lstat(noteSource);
    if (!noteStat.isFile() || noteStat.isSymbolicLink() || noteStat.size < 1) {
      throw releaseError(`release note must be a non-empty regular file: ${releaseNotePath}`);
    }
    const noteBytes = await fs.readFile(noteSource);
    if (gitBlobObject(noteBytes, trackedFiles.get(releaseNotePath).object)
      !== trackedFiles.get(releaseNotePath).object) {
      throw releaseError(`release note bytes differ from the release commit: ${releaseNotePath}`);
    }
    assertStandaloneReleaseNotes(noteBytes, releaseNotePath);
    await fs.writeFile(path.join(staging, releaseNotes), noteBytes, { flag: 'wx' });
    await artifactSnapshot.assertCurrent();
    const packed = await npmPack(snapshotRoot, staging, trackedFiles, { testSeam });
    if (packed.name !== identity.name || packed.version !== identity.version) {
      throw releaseError('npm pack identity does not match package.json');
    }
    await artifactSnapshot.assertCurrent();

    const records = [
      artifactSnapshot.archiveRecord,
      packed.archiveRecord,
      artifactRecordForBytes(releaseNotes, noteBytes),
    ].sort((left, right) => compareFilenames(left.filename, right.filename));
    const manifest = {
      format: 'fieldwork-release/v1',
      package: identity,
      commit: initialState.commit,
      artifacts: records,
    };
    const manifestFilename = 'RELEASE-MANIFEST.json';
    await fs.writeFile(
      path.join(staging, manifestFilename),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    const manifestRecord = await artifactRecord(staging, manifestFilename);
    const checksummed = [...records, manifestRecord]
      .sort((left, right) => compareFilenames(left.filename, right.filename));
    const checksumsFilename = 'SHA256SUMS.txt';
    const checksums = checksummed.map(row => `${row.sha256}  ${row.filename}`).join('\n');
    await fs.writeFile(path.join(staging, checksumsFilename), `${checksums}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const checksumsRecord = await artifactRecord(staging, checksumsFilename);

    const publicationRecords = [...checksummed, checksumsRecord]
      .sort((left, right) => compareFilenames(left.filename, right.filename));
    const filenames = publicationRecords.map(row => row.filename);
    await assertDirectoryIdentity(outputReservation.directory, 'release output root');
    if (await pathExists(target)) throw releaseError(`release output already exists: ${target}`);
    const stagePath = await fs.mkdtemp(path.join(releaseRoot, '.fieldwork-release-stage-'));
    publishStage = await inspectPlainDirectory(stagePath, 'release staging directory');
    if (!samePath(path.dirname(publishStage.real), outputReservation.directory.real)) {
      throw releaseError('release staging directory escaped its output root');
    }
    await copyArtifactsExclusively(staging, publishStage.path, filenames);
    await assertArtifactDirectory(publishStage.path, publicationRecords, 'release staging directory');
    await runTestSeam(testSeam, 'before-publish', {
      releaseRoot,
      repositoryRoot,
      target,
    });
    await assertDirectoryIdentity(outputReservation.directory, 'release output root');
    await assertDirectoryIdentity(publishStage, 'release staging directory');
    await assertArtifactDirectory(publishStage.path, publicationRecords, 'release staging directory');
    const finalState = await repositoryState(repositoryRoot);
    assertCleanState(finalState);
    if (finalState.commit !== initialState.commit) {
      throw releaseError('HEAD changed while artifacts were being built');
    }
    await assertPublicReleaseHistory(repositoryRoot, initialState.commit);
    if (await pathExists(target)) throw releaseError(`release output already exists: ${target}`);
    await fs.rename(publishStage.path, target);
    publishedTarget = Object.freeze({ ...publishStage, path: target, real: target });
    publishStage = null;
    await runTestSeam(testSeam, 'after-publish', {
      releaseRoot,
      repositoryRoot,
      target,
    });
    const published = await assertDirectoryIdentity(publishedTarget, 'published release directory');
    if (!samePath(published.real, target) || pathIsWithin(repositoryRoot, published.real)) {
      throw releaseError('published release directory escaped its output root');
    }
    await assertArtifactDirectory(target, publicationRecords, 'published release directory');
    const postPublicationState = await repositoryState(repositoryRoot);
    assertCleanState(postPublicationState);
    if (postPublicationState.commit !== initialState.commit) {
      throw releaseError('HEAD changed after artifacts were published');
    }
    await assertPublicReleaseHistory(repositoryRoot, initialState.commit);
    completed = true;
    return Object.freeze({
      directory: target,
      commit: initialState.commit,
      version: identity.version,
      files: Object.freeze(filenames),
    });
  } catch (error) {
    await removeOwnedDirectory(publishedTarget ?? publishStage);
    if (error?.message?.startsWith('Release build:')) throw error;
    throw releaseError('could not create the release artifacts', error);
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    if (!completed) await removeOwnedEmptyRoot(outputReservation);
  }
}

function parseArguments(arguments_) {
  let outputRoot;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--output-root') {
      if (outputRoot !== undefined || index + 1 >= arguments_.length) {
        throw releaseError('--output-root requires one value and may be used only once');
      }
      outputRoot = arguments_[++index];
    } else {
      throw releaseError(`unknown argument: ${argument}`);
    }
  }
  return { outputRoot };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await buildRelease(options);
    console.log(`Built Fieldwork ${result.version} from ${result.commit}.`);
    console.log(result.directory);
    for (const file of result.files) console.log(`- ${file}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
