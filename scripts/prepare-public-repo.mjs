import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const SUPPORTED_MODES = new Set(['100644', '100755']);
const WINDOWS_RESERVED_COMPONENT = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"/\\|?*\u0000-\u001f\u007f]/u;

// A symbol-keyed hook cannot be supplied by the CLI argument parser. It exists only so tests
// can stop the transaction at deterministic boundaries without adding a production fault flag.
export const PUBLIC_REPO_TEST_SEAM = Symbol('fieldwork.public-repository.test-seam');

function publicRepoError(message, cause) {
  return new Error(`Public repository preparation: ${message}`, cause === undefined ? undefined : { cause });
}

function isolatedGitEnvironment(trusted = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') || upper.startsWith('GCM_') || upper === 'EMAIL') continue;
    environment[key] = value;
  }
  Object.assign(environment, {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LC_ALL: 'C',
  }, trusted);
  return environment;
}

async function git(arguments_, {
  cwd,
  encoding = 'utf8',
  maxBuffer = 64 * 1024 * 1024,
  trustedEnvironment,
} = {}) {
  try {
    return await run('git', arguments_, {
      cwd,
      encoding,
      env: isolatedGitEnvironment(trustedEnvironment),
      maxBuffer,
      windowsHide: true,
    });
  } catch (error) {
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw publicRepoError(detail || `git ${arguments_[0] ?? 'command'} failed`, error);
  }
}

function oneLine(value, label, maxLength) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > maxLength
    || /[\0\r\n]/u.test(value)) {
    throw publicRepoError(`${label} must be one trimmed line of 1-${maxLength} characters`);
  }
  return value;
}

function authorName(value) {
  const name = oneLine(value, 'author name', 100);
  if (/[<>\u0000-\u001f\u007f]/u.test(name)) {
    throw publicRepoError('author name cannot contain angle brackets or control characters');
  }
  return name;
}

function authorEmail(value) {
  const email = oneLine(value, 'author email', 254);
  if (!/^[^\s<>@]+@[^\s<>@]+$/u.test(email)) {
    throw publicRepoError('author email must contain one non-empty local part and domain');
  }
  return email;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function containsPath(parent, candidate) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

function sameFileIdentity(left, right) {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0n || right.ino !== 0n) return left.ino === right.ino;
  return left.birthtimeNs === right.birthtimeNs;
}

async function inspectPlainDirectory(directory, label) {
  let stat;
  try { stat = await fs.lstat(directory, { bigint: true }); }
  catch (error) { throw publicRepoError(`${label} must be an existing readable directory`, error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw publicRepoError(`${label} must be a plain directory, not a link or junction`);
  }
  const real = await fs.realpath(directory);
  const realStat = await fs.lstat(real, { bigint: true });
  if (!realStat.isDirectory() || realStat.isSymbolicLink() || !sameFileIdentity(stat, realStat)) {
    throw publicRepoError(`${label} changed while it was inspected`);
  }
  return Object.freeze({ real, stat: realStat });
}

async function assertDirectoryIdentity(record, label) {
  const current = await inspectPlainDirectory(record.real, label);
  if (canonicalPath(current.real) !== canonicalPath(record.real)
    || !sameFileIdentity(current.stat, record.stat)) {
    throw publicRepoError(`${label} changed during public repository preparation`);
  }
}

async function destinationIdentity(destination) {
  try { await fs.lstat(destination, { bigint: true }); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw publicRepoError('could not inspect the destination safely', error);
    const parentInput = path.dirname(destination);
    let realParent;
    try { realParent = await fs.realpath(parentInput); }
    catch (parentError) { throw publicRepoError('destination parent must already exist', parentError); }
    const parent = await inspectPlainDirectory(realParent, 'destination parent');
    return Object.freeze({
      exists: false,
      parent,
      resolved: path.join(parent.real, path.basename(destination)),
    });
  }
  throw publicRepoError('destination must not exist; nothing is overwritten');
}

async function assertDestinationReservation(destination) {
  await assertDirectoryIdentity(destination.parent, 'destination parent');
  try {
    await fs.lstat(destination.resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw publicRepoError('could not recheck the destination', error);
  }
  throw publicRepoError('destination appeared while the public repository was prepared; nothing was replaced');
}

function validatePortableComponent(component) {
  if (!component || component === '.' || component === '..' || component.toLowerCase() === '.git'
    || component.length > 255 || component.endsWith(' ') || component.endsWith('.')
    || WINDOWS_FORBIDDEN_CHARACTER.test(component) || WINDOWS_RESERVED_COMPONENT.test(component)) {
    throw publicRepoError(`HEAD contains a path that is unsafe on Windows: ${component || '(empty component)'}`);
  }
}

function parseTree(buffer, objectFormat) {
  let text;
  try { text = utf8.decode(buffer); }
  catch (error) { throw publicRepoError('HEAD contains a path that is not valid UTF-8', error); }
  const rows = text.split('\0');
  if (rows.at(-1) === '') rows.pop();
  if (!rows.length) throw publicRepoError('HEAD has no tracked files');
  const seen = new Set();
  const objectPattern = objectFormat === 'sha256' ? /^[0-9a-f]{64}$/u : /^[0-9a-f]{40}$/u;
  return rows.map(row => {
    const separator = row.indexOf('\t');
    if (separator < 1) throw publicRepoError('git returned a malformed tree entry');
    const [mode, type, object, ...extra] = row.slice(0, separator).split(' ');
    const gitPath = row.slice(separator + 1);
    if (extra.length || !SUPPORTED_MODES.has(mode) || type !== 'blob' || !objectPattern.test(object)) {
      throw publicRepoError(`unsupported tree entry at ${gitPath || '(unnamed path)'}`);
    }
    if (!gitPath || gitPath.includes('\\') || path.posix.isAbsolute(gitPath)) {
      throw publicRepoError('HEAD contains an unsafe path');
    }
    const parts = gitPath.split('/');
    for (const part of parts) validatePortableComponent(part);
    const collisionKey = gitPath.normalize('NFC').toLowerCase();
    if (seen.has(collisionKey)) throw publicRepoError(`HEAD contains paths that collide on Windows at ${gitPath}`);
    seen.add(collisionKey);
    return { mode, object, gitPath };
  });
}

async function createOwnedStage(parent) {
  await assertDirectoryIdentity(parent, 'destination parent');
  const created = await fs.mkdtemp(path.join(parent.real, '.fieldwork-public-stage-'));
  const stage = await inspectPlainDirectory(created, 'temporary public repository');
  if (canonicalPath(path.dirname(stage.real)) !== canonicalPath(parent.real)) {
    throw publicRepoError('temporary public repository escaped the destination parent');
  }
  await assertDirectoryIdentity(parent, 'destination parent');
  return Object.freeze({ parent, real: stage.real, stat: stage.stat });
}

async function assertOwnedStageIdentity(stage) {
  await assertDirectoryIdentity(stage.parent, 'destination parent');
  await assertDirectoryIdentity(stage, 'temporary public repository');
  if (canonicalPath(path.dirname(stage.real)) !== canonicalPath(stage.parent.real)) {
    throw publicRepoError('temporary public repository moved outside the destination parent');
  }
}

async function assertEmptyOwnedStage(stage) {
  await assertOwnedStageIdentity(stage);
  if ((await fs.readdir(stage.real)).length) {
    throw publicRepoError('temporary public repository changed before export');
  }
}

async function readRegularFileNoFollow(file, label) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw publicRepoError(`${label} must be a regular file, not a link or reparse point`);
  }
  const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw publicRepoError(`${label} changed while it was opened`);
    }
    const bytes = await handle.readFile();
    const after = await fs.lstat(file, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || !sameFileIdentity(opened, after)) {
      throw publicRepoError(`${label} changed while it was read`);
    }
    return { bytes, stat: after };
  } finally {
    await handle?.close();
  }
}

function gitBlobObject(bytes, objectFormat) {
  const hash = createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1');
  hash.update(`blob ${bytes.length}\0`, 'utf8');
  hash.update(bytes);
  return hash.digest('hex');
}

function expectedWorktree(entries) {
  const files = new Map();
  const directories = new Set();
  for (const entry of entries) {
    files.set(entry.gitPath, entry);
    const parts = entry.gitPath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  return { directories, files };
}

async function verifyWorktreeInventory(root, entries, objectFormat, { requireGit = true } = {}) {
  const expected = expectedWorktree(entries);
  const seenDirectories = new Set();
  const seenFiles = new Set();
  let sawGit = false;
  async function walk(directory, relativeDirectory = '') {
    const inspected = await inspectPlainDirectory(directory, 'staged worktree directory');
    if (canonicalPath(inspected.real) !== canonicalPath(directory)) {
      throw publicRepoError('staged worktree contains a redirected directory');
    }
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const target = path.join(directory, child.name);
      const stat = await fs.lstat(target, { bigint: true });
      if (!relativeDirectory && child.name === '.git') {
        if (!requireGit || !stat.isDirectory() || stat.isSymbolicLink()) {
          throw publicRepoError('staged worktree contains an unexpected or redirected .git entry');
        }
        sawGit = true;
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw publicRepoError(`staged worktree contains a link or reparse point at ${relative}`);
      }
      if (stat.isDirectory()) {
        if (!expected.directories.has(relative)) {
          throw publicRepoError(`staged worktree contains an unexpected directory at ${relative}`);
        }
        seenDirectories.add(relative);
        await walk(target, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw publicRepoError(`staged worktree contains a non-regular entry at ${relative}`);
      }
      const expectedFile = expected.files.get(relative);
      if (!expectedFile) throw publicRepoError(`staged worktree contains an unexpected file at ${relative}`);
      const { bytes } = await readRegularFileNoFollow(target, `staged worktree file ${relative}`);
      if (gitBlobObject(bytes, objectFormat) !== expectedFile.object) {
        throw publicRepoError(`staged worktree bytes changed for ${relative}`);
      }
      seenFiles.add(relative);
    }
  }
  await walk(root);
  if (requireGit !== sawGit) throw publicRepoError('staged worktree .git presence does not match its phase');
  if (seenFiles.size !== expected.files.size
    || [...expected.files.keys()].some(file => !seenFiles.has(file))
    || seenDirectories.size !== expected.directories.size
    || [...expected.directories].some(directory => !seenDirectories.has(directory))) {
    throw publicRepoError('staged worktree inventory differs from the committed source tree');
  }
}

async function filesystemManifest(root) {
  const rows = [];
  async function walk(directory, relativeDirectory = '') {
    const inspected = await inspectPlainDirectory(directory, 'verified snapshot directory');
    if (canonicalPath(inspected.real) !== canonicalPath(directory)) {
      throw publicRepoError('verified snapshot contains a redirected directory');
    }
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const target = path.join(directory, child.name);
      const stat = await fs.lstat(target, { bigint: true });
      const mode = Number(stat.mode & 0o777n).toString(8).padStart(3, '0');
      if (stat.isSymbolicLink()) {
        throw publicRepoError(`verified snapshot contains a link or reparse point at ${relative}`);
      }
      if (stat.isDirectory()) {
        rows.push(`d\0${mode}\0${relative}`);
        await walk(target, relative);
        continue;
      }
      if (!stat.isFile()) throw publicRepoError(`verified snapshot contains a non-regular entry at ${relative}`);
      const { bytes } = await readRegularFileNoFollow(target, `verified snapshot file ${relative}`);
      rows.push(`f\0${mode}\0${bytes.length}\0${createHash('sha256').update(bytes).digest('hex')}\0${relative}`);
    }
  }
  await walk(root);
  return rows;
}

function equalManifests(left, right) {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

async function removeDirectoryNoFollow(directory) {
  const children = await fs.readdir(directory, { withFileTypes: true });
  for (const child of children) {
    const target = path.join(directory, child.name);
    const stat = await fs.lstat(target, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const real = await fs.realpath(target);
      if (canonicalPath(real) !== canonicalPath(target)) {
        throw publicRepoError('refused to clean up a redirected directory');
      }
      await removeDirectoryNoFollow(target);
      continue;
    }
    await fs.unlink(target);
  }
  await fs.rmdir(directory);
}

async function removeOwnedStage(stage) {
  await assertDirectoryIdentity(stage.parent, 'destination parent during cleanup');
  let current;
  try { current = await fs.lstat(stage.real, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw publicRepoError('could not inspect temporary public repository during cleanup', error);
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, stage.stat)) {
    throw publicRepoError('refused to clean up a temporary path whose identity changed');
  }
  const real = await fs.realpath(stage.real);
  if (canonicalPath(real) !== canonicalPath(stage.real)) {
    throw publicRepoError('refused to clean up a redirected temporary path');
  }
  await removeDirectoryNoFollow(stage.real);
}

async function exportTree(source, stage, entries) {
  const ownedDirectories = new Map([['', Object.freeze({ real: stage.real, stat: stage.stat })]]);
  for (const entry of entries) {
    const parts = entry.gitPath.split('/');
    let directory = stage.real;
    let relativeDirectory = '';
    for (const component of parts.slice(0, -1)) {
      relativeDirectory = relativeDirectory ? `${relativeDirectory}/${component}` : component;
      directory = path.join(directory, component);
      const owned = ownedDirectories.get(relativeDirectory);
      if (owned) {
        await assertDirectoryIdentity(owned, `owned export directory ${relativeDirectory}`);
        continue;
      }
      try { await fs.mkdir(directory); }
      catch (error) { throw publicRepoError(`refused a pre-existing export directory at ${relativeDirectory}`, error); }
      const created = await inspectPlainDirectory(directory, `owned export directory ${relativeDirectory}`);
      if (canonicalPath(created.real) !== canonicalPath(directory)) {
        throw publicRepoError(`export directory was redirected at ${relativeDirectory}`);
      }
      ownedDirectories.set(relativeDirectory, created);
    }
    const target = path.join(stage.real, ...parts);
    if (!containsPath(stage.real, target)) throw publicRepoError('a tracked path escaped the destination');
    const { stdout } = await git(['cat-file', 'blob', entry.object], { cwd: source, encoding: 'buffer' });
    const parentKey = parts.slice(0, -1).join('/');
    await assertDirectoryIdentity(ownedDirectories.get(parentKey), `owned export directory ${parentKey || '(root)'}`);
    let handle;
    try {
      handle = await fs.open(target, 'wx', entry.mode === '100755' ? 0o755 : 0o644);
      await handle.writeFile(stdout);
    } catch (error) {
      throw publicRepoError(`refused to replace ${entry.gitPath}`, error);
    } finally {
      await handle?.close();
    }
    const written = await fs.lstat(target, { bigint: true });
    if (!written.isFile() || written.isSymbolicLink()) {
      throw publicRepoError(`exported path is not a regular file at ${entry.gitPath}`);
    }
    await assertDirectoryIdentity(ownedDirectories.get(parentKey), `owned export directory ${parentKey || '(root)'}`);
  }
}

async function buildExactIndex(destination, entries) {
  for (const entry of entries) {
    const target = path.join(destination, ...entry.gitPath.split('/'));
    const { stdout } = await git(['hash-object', '-w', '--no-filters', '--', target], { cwd: destination });
    const written = stdout.trim();
    if (written !== entry.object) throw publicRepoError(`exported bytes changed for ${entry.gitPath}`);
    await git(['update-index', '--add', '--cacheinfo', entry.mode, entry.object, entry.gitPath], {
      cwd: destination,
    });
  }
}

async function initializeRepository(destination, objectFormat) {
  const template = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-empty-git-template-'));
  try {
    await git([
      'init', '--initial-branch=main', `--object-format=${objectFormat}`, `--template=${template}`, destination,
    ], { cwd: path.dirname(destination) });
  } finally {
    await fs.rm(template, { recursive: true, force: true });
  }
  await git(['config', 'core.autocrlf', 'false'], { cwd: destination });
  await git(['config', 'core.logAllRefUpdates', 'false'], { cwd: destination });
}

function objectNames(output) {
  return new Set(output.split(/\r?\n/u).filter(Boolean).map(line => line.split(' ', 1)[0]));
}

function equalSets(left, right) {
  return left.size === right.size && [...left].every(value => right.has(value));
}

async function verifyNoAlternates(destination) {
  const alternates = path.join(destination, '.git', 'objects', 'info', 'alternates');
  try {
    await fs.lstat(alternates);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw publicRepoError('could not inspect the public object store', error);
  }
  throw publicRepoError('public repository unexpectedly uses an alternate object store');
}

async function verifyLocalConfig(destination, objectFormat) {
  const { stdout: namesOutput } = await git(['config', '--local', '--name-only', '--list'], {
    cwd: destination,
  });
  const names = namesOutput.split(/\r?\n/u).filter(Boolean);
  const allowed = new Set([
    'core.autocrlf',
    'core.bare',
    'core.filemode',
    'core.ignorecase',
    'core.logallrefupdates',
    'core.precomposeunicode',
    'core.repositoryformatversion',
    'core.symlinks',
    'extensions.objectformat',
  ]);
  if (new Set(names).size !== names.length || names.some(name => !allowed.has(name))) {
    throw publicRepoError('public repository local config contains unexpected or duplicate keys');
  }
  const required = new Map([
    ['core.autocrlf', 'false'],
    ['core.bare', 'false'],
    ['core.logallrefupdates', 'false'],
    ['core.repositoryformatversion', objectFormat === 'sha256' ? '1' : '0'],
  ]);
  if (objectFormat === 'sha256') required.set('extensions.objectformat', 'sha256');
  for (const [name, expected] of required) {
    const { stdout } = await git(['config', '--local', '--get-all', name], { cwd: destination });
    const values = stdout.split(/\r?\n/u).filter(Boolean);
    if (values.length !== 1 || values[0] !== expected) {
      throw publicRepoError(`public repository local config changed at ${name}`);
    }
  }
  const optionalBoolean = new Set([
    'core.filemode',
    'core.ignorecase',
    'core.precomposeunicode',
    'core.symlinks',
  ]);
  for (const name of names) {
    if (!optionalBoolean.has(name)) continue;
    const { stdout } = await git(['config', '--local', '--get-all', name], { cwd: destination });
    const values = stdout.split(/\r?\n/u).filter(Boolean);
    if (values.length !== 1 || !['true', 'false'].includes(values[0])) {
      throw publicRepoError(`public repository local config changed at ${name}`);
    }
  }
}

async function verifyGitLayout(destination, objects) {
  const gitRoot = path.join(destination, '.git');
  const expectedFiles = new Set(['HEAD', 'config', 'index', 'refs/heads/main']);
  const expectedDirectories = new Set(['objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/tags']);
  for (const object of objects) {
    const fanout = `objects/${object.slice(0, 2)}`;
    expectedDirectories.add(fanout);
    expectedFiles.add(`${fanout}/${object.slice(2)}`);
  }
  const actualFiles = new Set();
  const actualDirectories = new Set();
  async function walk(directory, relativeDirectory = '') {
    const inspected = await inspectPlainDirectory(directory, 'public .git directory');
    if (canonicalPath(inspected.real) !== canonicalPath(directory)) {
      throw publicRepoError('public .git directory contains a redirected directory');
    }
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const target = path.join(directory, child.name);
      const stat = await fs.lstat(target, { bigint: true });
      if (stat.isSymbolicLink()) throw publicRepoError(`public .git contains a link at ${relative}`);
      if (stat.isDirectory()) {
        actualDirectories.add(relative);
        await walk(target, relative);
      } else if (stat.isFile()) {
        await readRegularFileNoFollow(target, `public .git file ${relative}`);
        actualFiles.add(relative);
      } else {
        throw publicRepoError(`public .git contains a non-regular entry at ${relative}`);
      }
    }
  }
  await walk(gitRoot);
  if (actualFiles.size !== expectedFiles.size
    || [...expectedFiles].some(file => !actualFiles.has(file))
    || actualDirectories.size !== expectedDirectories.size
    || [...expectedDirectories].some(directory => !actualDirectories.has(directory))) {
    throw publicRepoError('public .git filesystem layout contains unexpected or missing entries');
  }
}

async function verifyRepository({ author, email, sourceTree, destination, expectedHead, objectFormat }) {
  const [
    { stdout: publicTree },
    { stdout: count },
    { stdout: commit },
    { stdout: status },
    { stdout: remotes },
    { stdout: refs },
    { stdout: branch },
    { stdout: identityBytes },
    { stdout: allObjectOutput },
    { stdout: reachableObjectOutput },
  ] = await Promise.all([
    git(['rev-parse', 'HEAD^{tree}'], { cwd: destination }),
    git(['rev-list', '--count', 'HEAD'], { cwd: destination }),
    git(['cat-file', '-p', 'HEAD'], { cwd: destination }),
    git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: destination }),
    git(['remote'], { cwd: destination }),
    git(['for-each-ref', '--format=%(refname)'], { cwd: destination }),
    git(['symbolic-ref', '--short', 'HEAD'], { cwd: destination }),
    git(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', 'HEAD'], {
      cwd: destination,
      encoding: 'buffer',
    }),
    git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { cwd: destination }),
    git(['rev-list', '--objects', 'HEAD'], { cwd: destination }),
  ]);
  if (publicTree.trim() !== sourceTree) throw publicRepoError('public and private release trees differ');
  if (count.trim() !== '1') throw publicRepoError('public repository does not contain exactly one commit');
  if (/^parent /mu.test(commit)) throw publicRepoError('public commit unexpectedly has a parent');
  if (status.trim()) throw publicRepoError('public repository is not clean after its root commit');
  if (remotes.trim()) throw publicRepoError('public repository preparation must not add a remote');
  if (refs.trim() !== 'refs/heads/main' || branch.trim() !== 'main') {
    throw publicRepoError('public repository contains unexpected refs or is not on main');
  }
  let identity;
  try { identity = utf8.decode(identityBytes).replace(/\r?\n$/u, '').split('\0'); }
  catch (error) { throw publicRepoError('public commit identity is not valid UTF-8', error); }
  if (identity.length !== 4 || identity[0] !== author || identity[1] !== email
    || identity[2] !== author || identity[3] !== email) {
    throw publicRepoError('public commit author or committer differs from the supplied identity');
  }
  const allObjects = objectNames(allObjectOutput);
  const reachableObjects = objectNames(reachableObjectOutput);
  if (!equalSets(allObjects, reachableObjects)) {
    throw publicRepoError('public object store contains objects outside the root commit');
  }
  await verifyNoAlternates(destination);
  await verifyLocalConfig(destination, objectFormat);
  await verifyGitLayout(destination, allObjects);
  const { stdout: fsckOut, stderr: fsckError } = await git(
    ['fsck', '--full', '--strict', '--unreachable', '--no-reflogs', '--no-progress'],
    { cwd: destination },
  );
  if (fsckOut.trim() || fsckError.trim()) throw publicRepoError('public repository contains unreachable or invalid objects');
  const { stdout: finalStatus } = await git(
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no'],
    { cwd: destination },
  );
  if (finalStatus.trim()) throw publicRepoError('public repository worktree changed during verification');
  const { stdout: publicHeadOutput } = await git(['rev-parse', 'HEAD^{commit}'], { cwd: destination });
  const publicHead = publicHeadOutput.trim();
  if (expectedHead !== undefined && publicHead !== expectedHead) {
    throw publicRepoError('public commit changed after repository verification');
  }
  return Object.freeze({ head: publicHead, tree: publicTree.trim() });
}

async function assertSnapshotRoot(root, stage) {
  const stat = await fs.lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(stat, stage.stat)) {
    throw publicRepoError('verified snapshot root changed identity');
  }
  const real = await fs.realpath(root);
  if (canonicalPath(real) !== canonicalPath(root)) {
    throw publicRepoError('verified snapshot root was redirected');
  }
}

async function assertGitDirectoryIdentity(root, gitDirectory) {
  const target = path.join(root, '.git');
  const stat = await fs.lstat(target, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(stat, gitDirectory.stat)) {
    throw publicRepoError('verified snapshot .git directory changed identity');
  }
  const real = await fs.realpath(target);
  if (canonicalPath(real) !== canonicalPath(target)) {
    throw publicRepoError('verified snapshot .git directory was redirected');
  }
}

async function verifyStableSnapshot({
  author,
  baselineManifest,
  email,
  entries,
  expectedHead,
  gitDirectory,
  objectFormat,
  root,
  sourceTree,
  stage,
}) {
  await assertSnapshotRoot(root, stage);
  await assertGitDirectoryIdentity(root, gitDirectory);
  const repository = await verifyRepository({
    author,
    email,
    expectedHead,
    objectFormat,
    sourceTree,
    destination: root,
  });
  await verifyWorktreeInventory(root, entries, objectFormat);
  const currentManifest = await filesystemManifest(root);
  if (!equalManifests(currentManifest, baselineManifest)) {
    throw publicRepoError('verified snapshot filesystem changed after repository verification');
  }
  await assertSnapshotRoot(root, stage);
  await assertGitDirectoryIdentity(root, gitDirectory);
  const { stdout: finalHead } = await git(['rev-parse', 'HEAD^{commit}'], { cwd: root });
  if (finalHead.trim() !== expectedHead || repository.head !== expectedHead) {
    throw publicRepoError('public commit changed at the publication boundary');
  }
  return repository;
}

async function runTestSeam(seam, checkpoint) {
  if (seam === undefined) return;
  return seam(checkpoint);
}

async function assertPathAbsent(target, label) {
  try {
    await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw publicRepoError(`could not recheck ${label}`, error);
  }
  throw publicRepoError(`${label} appeared during public repository preparation; nothing was replaced`);
}

async function rollbackPublishedStage(destination, stage) {
  await assertDirectoryIdentity(destination.parent, 'destination parent during rollback');
  const stat = await fs.lstat(destination.resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(stat, stage.stat)) {
    throw publicRepoError('refused to roll back a published path whose identity changed');
  }
  const real = await fs.realpath(destination.resolved);
  if (canonicalPath(real) !== canonicalPath(destination.resolved)) {
    throw publicRepoError('refused to roll back a redirected published path');
  }
  await assertPathAbsent(stage.real, 'owned staging rollback path');
  await fs.rename(destination.resolved, stage.real);
  await assertOwnedStageIdentity(stage);
}

async function publishStage({ destination, seam, stage, verifySnapshot }) {
  await assertDestinationReservation(destination);
  await assertOwnedStageIdentity(stage);
  await runTestSeam(seam, 'before-publish');
  await assertDestinationReservation(destination);
  await assertOwnedStageIdentity(stage);
  await verifySnapshot(stage.real);
  await assertDestinationReservation(destination);
  let moved = false;
  try {
    await fs.rename(stage.real, destination.resolved);
    moved = true;
    await runTestSeam(seam, 'after-publish');
    await verifySnapshot(destination.resolved);
  } catch (error) {
    if (moved) {
      try { await rollbackPublishedStage(destination, stage); }
      catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Public repository preparation failed after publication and its owned directory could not be rolled back safely',
        );
      }
    }
    throw error;
  }
}

export async function preparePublicRepo(options = {}) {
  const {
    source = process.cwd(),
    destination,
    authorName: suppliedAuthorName,
    authorEmail: suppliedAuthorEmail,
    message = 'Initial public snapshot',
  } = options;
  const seam = options[PUBLIC_REPO_TEST_SEAM];
  if (seam !== undefined && typeof seam !== 'function') {
    throw publicRepoError('test seam must be a function when supplied programmatically');
  }
  if (typeof source !== 'string' || !source) throw publicRepoError('source must be a directory path');
  if (typeof destination !== 'string' || !destination) throw publicRepoError('destination is required');
  const name = authorName(suppliedAuthorName);
  const email = authorEmail(suppliedAuthorEmail);
  const commitMessage = oneLine(message, 'commit message', 200);

  const sourceInput = path.resolve(source);
  let sourceRoot;
  try {
    const { stdout } = await git(['rev-parse', '--show-toplevel'], { cwd: sourceInput });
    sourceRoot = await fs.realpath(stdout.trim());
  } catch (error) {
    throw publicRepoError('source must be a readable Git worktree', error);
  }
  const suppliedReal = await fs.realpath(sourceInput);
  if (canonicalPath(suppliedReal) !== canonicalPath(sourceRoot)) {
    throw publicRepoError('source must name the repository root exactly');
  }
  const { stdout: status } = await git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: sourceRoot });
  if (status.trim()) throw publicRepoError('source worktree must be clean');

  const destinationPath = path.resolve(destination);
  const destinationState = await destinationIdentity(destinationPath);
  if (containsPath(sourceRoot, destinationState.resolved)) {
    throw publicRepoError('destination must be outside the source repository');
  }
  if (containsPath(destinationState.resolved, sourceRoot)) {
    throw publicRepoError('destination cannot contain the source repository');
  }

  const { stdout: objectFormatOutput } = await git(['rev-parse', '--show-object-format'], { cwd: sourceRoot });
  const objectFormat = objectFormatOutput.trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    throw publicRepoError(`unsupported Git object format ${objectFormat || '(empty)'}`);
  }
  const { stdout: sourceHeadOutput } = await git(['rev-parse', 'HEAD^{commit}'], { cwd: sourceRoot });
  const sourceHead = sourceHeadOutput.trim();
  const { stdout: sourceTreeOutput } = await git(['rev-parse', `${sourceHead}^{tree}`], { cwd: sourceRoot });
  const sourceTree = sourceTreeOutput.trim();
  const { stdout: treeBytes } = await git(
    ['ls-tree', '-r', '-z', '--full-tree', sourceHead],
    { cwd: sourceRoot, encoding: 'buffer' },
  );
  const replacementTreeBytes = await runTestSeam(seam, 'tree-read');
  if (replacementTreeBytes !== undefined && !Buffer.isBuffer(replacementTreeBytes)) {
    throw publicRepoError('tree-read test seam must return a Buffer when replacing the tree');
  }
  const entries = parseTree(replacementTreeBytes ?? treeBytes, objectFormat);

  let stage;
  let published = false;
  try {
    stage = await createOwnedStage(destinationState.parent);
    await runTestSeam(seam, 'stage-created');
    await assertEmptyOwnedStage(stage);
    await exportTree(sourceRoot, stage, entries);
    await assertOwnedStageIdentity(stage);
    await verifyWorktreeInventory(stage.real, entries, objectFormat, { requireGit: false });
    await initializeRepository(stage.real, objectFormat);
    await assertOwnedStageIdentity(stage);
    const gitDirectory = await inspectPlainDirectory(path.join(stage.real, '.git'), 'owned .git directory');
    await buildExactIndex(stage.real, entries);
    await assertOwnedStageIdentity(stage);

    const { stdout: stagedTree } = await git(['write-tree'], { cwd: stage.real });
    if (stagedTree.trim() !== sourceTree) {
      throw publicRepoError('staged public tree differs from the committed source tree');
    }
    const emptyHooks = path.join(stage.real, '.git', 'fieldwork-empty-hooks');
    await fs.mkdir(emptyHooks);
    await git([
      '-c', `core.hooksPath=${emptyHooks}`,
      '-c', 'commit.gpgSign=false',
      'commit', '--no-gpg-sign', '--no-verify', '-m', commitMessage,
    ], {
      cwd: stage.real,
      trustedEnvironment: {
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_NAME: name,
      },
    });
    await fs.rm(path.join(stage.real, '.git', 'COMMIT_EDITMSG'), { force: true });
    await fs.rmdir(emptyHooks);
    await assertOwnedStageIdentity(stage);
    await assertGitDirectoryIdentity(stage.real, gitDirectory);
    await verifyWorktreeInventory(stage.real, entries, objectFormat);

    const initialRepository = await verifyRepository({
      author: name,
      email,
      objectFormat,
      sourceTree,
      destination: stage.real,
    });
    const baselineManifest = await filesystemManifest(stage.real);
    const verifySnapshot = root => verifyStableSnapshot({
      author: name,
      baselineManifest,
      email,
      entries,
      expectedHead: initialRepository.head,
      gitDirectory,
      objectFormat,
      root,
      sourceTree,
      stage,
    });
    await verifySnapshot(stage.real);
    await assertOwnedStageIdentity(stage);
    await runTestSeam(seam, 'repository-verified');
    await verifySnapshot(stage.real);
    const [{ stdout: finalSourceHead }, { stdout: finalSourceStatus }] = await Promise.all([
      git(['rev-parse', 'HEAD^{commit}'], { cwd: sourceRoot }),
      git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: sourceRoot }),
    ]);
    if (finalSourceHead.trim() !== sourceHead || finalSourceStatus.trim()) {
      throw publicRepoError('source changed while the public repository was prepared');
    }
    const receipt = Object.freeze({
      format: 'fieldwork-public-repository/v1',
      sourceHead,
      tree: initialRepository.tree,
      publicHead: initialRepository.head,
      objectFormat,
      files: entries.length,
      destination: destinationState.resolved,
      branch: 'main',
      commits: 1,
      remotes: 0,
    });
    await publishStage({ destination: destinationState, seam, stage, verifySnapshot });
    published = true;
    return receipt;
  } catch (error) {
    if (stage && !published) {
      try { await removeOwnedStage(stage); }
      catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Public repository preparation failed and its owned staging directory could not be cleaned safely',
        );
      }
    }
    throw error;
  }
}

function usage() {
  return `Usage:
  node scripts/prepare-public-repo.mjs --destination <nonexistent-path> \\
    --author-name <name> --author-email <email> [--source <repo>] [--message <one-line>]

Creates one local root commit from the exact clean HEAD tree. It never adds a remote or pushes.`;
}

function parseArguments(arguments_) {
  const allowed = new Set(['--source', '--destination', '--author-name', '--author-email', '--message']);
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(key) || value === undefined || values[key] !== undefined) {
      throw publicRepoError(`invalid arguments\n${usage()}`);
    }
    values[key] = value;
  }
  return {
    source: values['--source'] ?? process.cwd(),
    destination: values['--destination'],
    authorName: values['--author-name'],
    authorEmail: values['--author-email'],
    message: values['--message'] ?? 'Initial public snapshot',
  };
}

const invoked = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    const receipt = await preparePublicRepo(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
