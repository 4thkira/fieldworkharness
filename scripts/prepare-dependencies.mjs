import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/json-data.mjs';
import {
  DEPENDENCY_INSTALL_LOCK_FORMAT,
  recoverAbandonedLock,
} from '../src/stale-state-locks.mjs';

export const MINIMUM_NODE_MAJOR = 22;
export const INSTALL_ARGUMENTS = Object.freeze(['ci', '--no-fund', '--no-audit', '--ignore-scripts']);
export const STAMP_FORMAT = 1;

const moduleFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(moduleFile), '..');
const stampName = '.fieldwork-dependencies.json';
const lockName = '.fieldwork-dependencies.lock';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function nodeMajor(version) {
  const match = /^(\d+)(?:\.|$)/.exec(String(version ?? ''));
  if (!match) throw new Error(`Node.js reported an invalid version: ${String(version ?? '') || '(empty)'}.`);
  return Number(match[1]);
}

export function assertSupportedNode(version = process.versions.node) {
  const major = nodeMajor(version);
  if (major < MINIMUM_NODE_MAJOR) {
    throw new Error(`Fieldwork needs Node.js ${MINIMUM_NODE_MAJOR} or newer; this is Node.js ${version}.`);
  }
  return major;
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`); }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dependencyNames(lock) {
  const dependencies = lock?.packages?.['']?.dependencies ?? {};
  if (!plainObject(dependencies)) throw new Error('npm-shrinkwrap.json has an invalid root dependency list.');
  return Object.keys(dependencies).sort();
}

function dependencyMap(value, label) {
  if (value === undefined) return {};
  if (!plainObject(value) || Object.values(value).some(version => typeof version !== 'string')) {
    throw new Error(`${label} must be an object of dependency versions.`);
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
}

function installMaps(manifest, label) {
  return {
    dependencies: dependencyMap(manifest.dependencies, `${label} dependencies`),
    devDependencies: dependencyMap(manifest.devDependencies, `${label} devDependencies`),
    optionalDependencies: dependencyMap(manifest.optionalDependencies, `${label} optionalDependencies`),
  };
}

function lockedDependency(lock, name) {
  const entry = lock?.packages?.[`node_modules/${name}`];
  if (!plainObject(entry) || typeof entry.version !== 'string' || !entry.version) {
    throw new Error(`npm-shrinkwrap.json does not pin the direct dependency ${name}.`);
  }
  return entry.version;
}

function safeDependencyName(name) {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}

export function dependencyFingerprint(lockBytes, {
  platform = process.platform,
  arch = process.arch,
  moduleAbi = process.versions.modules ?? '',
  major = nodeMajor(process.versions.node),
  packageDependencies = {},
} = {}) {
  const hash = createHash('sha256');
  hash.update('fieldwork-dependencies/v1\0');
  hash.update(lockBytes);
  hash.update('\0');
  hash.update(JSON.stringify({
    platform,
    arch,
    moduleAbi: String(moduleAbi),
    nodeMajor: major,
    packageDependencies,
  }));
  return hash.digest('hex');
}

async function regularFile(file, label) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a plain file: ${file}`);
  return stat;
}

async function plainDirectory(directory, label) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory, not a link or another file: ${directory}`);
  }
  return stat;
}

async function readInstallDefinition(root, identity) {
  const lockFile = path.join(root, 'npm-shrinkwrap.json');
  const packageFile = path.join(root, 'package.json');
  await regularFile(lockFile, 'The dependency lockfile');
  await regularFile(packageFile, 'package.json');
  const lockBytes = await fs.readFile(lockFile);
  const packageManifest = parseJson(await fs.readFile(packageFile), 'package.json');
  const lock = parseJson(lockBytes, 'npm-shrinkwrap.json');
  if (lock.lockfileVersion !== 3 || !plainObject(lock.packages)) {
    throw new Error('npm-shrinkwrap.json must be an npm lockfileVersion 3 package lock.');
  }
  const packageDependencies = installMaps(packageManifest, 'package.json');
  const lockDependencies = installMaps(lock.packages[''], 'npm-shrinkwrap.json root package');
  if (JSON.stringify(packageDependencies) !== JSON.stringify(lockDependencies)) {
    throw new Error('package.json dependency lists do not match npm-shrinkwrap.json; update the lockfile before starting Fieldwork.');
  }
  const dependencies = dependencyNames(lock).map(name => {
    if (!safeDependencyName(name)) throw new Error(`npm-shrinkwrap.json contains an unsafe dependency name: ${name}.`);
    return { name, version: lockedDependency(lock, name) };
  });
  return {
    lockFile,
    lockBytes,
    dependencies,
    fingerprint: dependencyFingerprint(lockBytes, { ...identity, packageDependencies }),
  };
}

async function readStamp(stampFile) {
  try {
    await regularFile(stampFile, 'The dependency receipt');
    const stamp = parseJson(await fs.readFile(stampFile), 'The dependency receipt');
    if (stamp?.format !== STAMP_FORMAT || typeof stamp.fingerprint !== 'string') return null;
    return stamp;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (/not valid JSON|must be a plain file/.test(errorMessage(error))) return null;
    throw error;
  }
}

async function verifyInstalledDependencies(root, dependencies) {
  const modules = path.join(root, 'node_modules');
  try { await plainDirectory(modules, 'node_modules'); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  for (const dependency of dependencies) {
    const directory = path.join(modules, ...dependency.name.split('/'));
    try {
      await plainDirectory(directory, `Installed dependency ${dependency.name}`);
      const manifestFile = path.join(directory, 'package.json');
      await regularFile(manifestFile, `Installed dependency manifest for ${dependency.name}`);
      const manifest = parseJson(await fs.readFile(manifestFile), `${dependency.name}/package.json`);
      if (manifest?.version !== dependency.version) return false;
    } catch (error) {
      if (error?.code === 'ENOENT' || /not valid JSON/.test(errorMessage(error))) return false;
      throw error;
    }
  }
  return true;
}

async function installIsCurrent(root, definition) {
  const stamp = await readStamp(path.join(root, 'node_modules', stampName));
  if (!stamp || stamp.fingerprint !== definition.fingerprint) return false;
  return verifyInstalledDependencies(root, definition.dependencies);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBounded(handle, maximumBytes) {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let used = 0;
  while (used < buffer.length) {
    const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
    if (!bytesRead) break;
    used += bytesRead;
  }
  if (used > maximumBytes) return { overflow: true, source: null };
  return { overflow: false, source: buffer.subarray(0, used).toString('utf8') };
}

async function createInstallLock(lockFile) {
  const token = randomUUID();
  let handle;
  let openedStat;
  try { handle = await fs.open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  try {
    openedStat = await handle.stat({ bigint: true });
    const payload = `${canonicalJson({
      format: DEPENDENCY_INSTALL_LOCK_FORMAT,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`;
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    const pathStat = await fs.lstat(lockFile, { bigint: true });
    if (!sameIdentity(stat, pathStat)) {
      throw new Error('The dependency install lock path changed while it was being initialized.');
    }
    return { file: lockFile, handle, stat, payload };
  } catch (error) {
    try { await handle.close(); } catch { /* Preserve the initialization failure. */ }
    if (openedStat) {
      try {
        const pathStat = await fs.lstat(lockFile, { bigint: true });
        if (sameIdentity(pathStat, openedStat)) await fs.unlink(lockFile);
      } catch { /* Never remove an unverified replacement. */ }
    }
    throw error;
  }
}

async function verifyOwnedInstallLock(lock) {
  const [pathStat, handleStat] = await Promise.all([
    fs.lstat(lock.file, { bigint: true }),
    lock.handle.stat({ bigint: true }),
  ]);
  if (!sameIdentity(pathStat, lock.stat) || !sameIdentity(handleStat, lock.stat)) {
    throw new Error('The dependency install lock path was replaced; refusing to remove another launcher\'s lock.');
  }
  const payloadBytes = Buffer.byteLength(lock.payload, 'utf8');
  if (handleStat.size !== BigInt(payloadBytes)) {
    throw new Error('The dependency install lock payload changed; refusing to remove it.');
  }
  let reader;
  try {
    reader = await fs.open(lock.file, 'r');
    const readerStat = await reader.stat({ bigint: true });
    if (!sameIdentity(readerStat, lock.stat)) {
      throw new Error('The dependency install lock path changed before its token could be checked.');
    }
    const read = await readBounded(reader, payloadBytes);
    const [afterReader, afterPath] = await Promise.all([
      reader.stat({ bigint: true }),
      fs.lstat(lock.file, { bigint: true }),
    ]);
    if (!sameIdentity(afterReader, lock.stat)
      || !sameIdentity(afterPath, lock.stat)
      || read.overflow
      || read.source !== lock.payload) {
      throw new Error('The dependency install lock token changed; refusing to remove it.');
    }
  } finally {
    if (reader) await reader.close();
  }
}

async function releaseInstallLock(lock) {
  const failures = [];
  let verified = false;
  try {
    await verifyOwnedInstallLock(lock);
    verified = true;
  } catch (error) { failures.push(error); }

  try { await lock.handle.close(); }
  catch (error) { failures.push(error); }

  if (verified && failures.length === 0) {
    try {
      const pathStat = await fs.lstat(lock.file, { bigint: true });
      if (!sameIdentity(pathStat, lock.stat)) {
        throw new Error('The dependency install lock path was replaced before removal; refusing to remove it.');
      }
      await fs.unlink(lock.file);
    } catch (error) { failures.push(error); }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Dependency install lock release failed.');
}

async function acquireInstallLock(lockFile, {
  timeoutMs = 10 * 60_000,
  pollMs = 150,
  processStatus,
  onRecoveryPhase,
  logger = console,
} = {}) {
  const started = Date.now();
  let announced = false;
  while (true) {
    const lock = await createInstallLock(lockFile);
    if (lock) return () => releaseInstallLock(lock);

    const recovery = await recoverAbandonedLock(lockFile, DEPENDENCY_INSTALL_LOCK_FORMAT, {
      processStatus,
      onPhase: onRecoveryPhase,
    });
    if (recovery.status === 'missing' || recovery.status === 'recovered') continue;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `Another Fieldwork launcher is still preparing dependencies. If none is running, inspect ${lockFile} and ${lockFile}.recovery.`,
      );
    }
    if (!announced) {
      logger.log('Another Fieldwork launcher is preparing dependencies; waiting...');
      announced = true;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

async function resolveNpmCli(environment = process.env) {
  const candidates = [];
  if (environment.npm_execpath && /\.(?:c?m?js)$/i.test(environment.npm_execpath)) {
    candidates.push(path.resolve(environment.npm_execpath));
  }
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const candidate of [...new Set(candidates)]) {
    try {
      await regularFile(candidate, 'The npm command');
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('npm could not be found beside Node.js. Reinstall Node.js 22 or newer, including npm.');
}

async function defaultRunNpmCi({ root, arguments: arguments_ }) {
  const npmCli = await resolveNpmCli();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...arguments_], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) throw new Error(`npm ci stopped by ${result.signal}.`);
  if (result.code !== 0) throw new Error(`npm ci exited with code ${result.code ?? 'unknown'}.`);
}

async function atomicWriteStamp(stampFile, stamp) {
  const temporary = `${stampFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(stamp, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, stampFile);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function prepareDependencies({
  root = defaultRoot,
  nodeVersion = process.versions.node,
  platform = process.platform,
  arch = process.arch,
  moduleAbi = process.versions.modules ?? '',
  runNpmCi = defaultRunNpmCi,
  lockOptions,
  logger = console,
} = {}) {
  const major = assertSupportedNode(nodeVersion);
  const identity = { platform, arch, moduleAbi, major };
  let definition = await readInstallDefinition(root, identity);
  if (await installIsCurrent(root, definition)) return { installed: false, fingerprint: definition.fingerprint };

  const lockFile = path.join(root, lockName);
  const release = await acquireInstallLock(lockFile, { ...lockOptions, logger });
  let result;
  let operationFailure = null;
  try {
    result = await (async () => {
      definition = await readInstallDefinition(root, identity);
      if (await installIsCurrent(root, definition)) return { installed: false, fingerprint: definition.fingerprint };

      const modules = path.join(root, 'node_modules');
      try { await plainDirectory(modules, 'node_modules'); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const stampFile = path.join(modules, stampName);
      await fs.rm(stampFile, { force: true });
      logger.log('Installing lockfile-pinned dependencies...');
      await runNpmCi({ root, arguments: [...INSTALL_ARGUMENTS] });

      const after = await readInstallDefinition(root, identity);
      if (after.fingerprint !== definition.fingerprint) {
        throw new Error('npm-shrinkwrap.json changed while dependencies were installing; run Fieldwork again.');
      }
      if (after.dependencies.length === 0) {
        try { await plainDirectory(path.join(root, 'node_modules'), 'node_modules'); }
        catch (error) {
          if (error?.code === 'ENOENT') await fs.mkdir(path.join(root, 'node_modules'));
          else throw error;
        }
      }
      if (!await verifyInstalledDependencies(root, after.dependencies)) {
        throw new Error('npm ci finished, but the pinned direct dependencies could not be verified.');
      }
      await atomicWriteStamp(path.join(root, 'node_modules', stampName), {
        format: STAMP_FORMAT,
        fingerprint: after.fingerprint,
        installedAt: new Date().toISOString(),
      });
      return { installed: true, fingerprint: after.fingerprint };
    })();
  } catch (error) { operationFailure = error; }

  let releaseFailure = null;
  try { await release(); }
  catch (error) { releaseFailure = error; }
  if (operationFailure && releaseFailure) {
    throw new AggregateError(
      [operationFailure, releaseFailure],
      'Dependency preparation and install-lock release both failed.',
    );
  }
  if (operationFailure) throw operationFailure;
  if (releaseFailure) throw releaseFailure;
  return result;
}
