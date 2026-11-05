import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  INSTALL_ARGUMENTS,
  assertSupportedNode,
  nodeMajor,
  prepareDependencies,
} from '../scripts/prepare-dependencies.mjs';
import { canonicalJson } from '../src/json-data.mjs';
import { DEPENDENCY_INSTALL_LOCK_FORMAT } from '../src/stale-state-locks.mjs';

const dependency = 'example-dependency';
const quiet = { log() {} };
const run = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installLockName = '.fieldwork-dependencies.lock';

function installLockSource({
  token = randomUUID(),
  pid = 987_654_321,
  createdAt = '2030-01-02T03:04:05.000Z',
  extra = {},
} = {}) {
  return `${canonicalJson({
    format: DEPENDENCY_INSTALL_LOCK_FORMAT,
    token,
    pid,
    createdAt,
    ...extra,
  })}\n`;
}

async function writeDefinition(root, version = '1.2.3', packageVersion = version) {
  const packageJson = {
    name: 'fieldwork-bootstrap-fixture',
    version: '0.0.0',
    private: true,
    dependencies: { [dependency]: packageVersion },
  };
  const shrinkwrap = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: { [dependency]: version },
      },
      [`node_modules/${dependency}`]: {
        version,
        resolved: `https://example.invalid/${dependency}-${version}.tgz`,
        integrity: 'sha512-synthetic',
      },
    },
  };
  await Promise.all([
    fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`),
    fs.writeFile(path.join(root, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap, null, 2)}\n`),
  ]);
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork bootstrap fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeDefinition(root);
  return root;
}

async function installLockedDependency(root) {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
  const version = lock.packages[`node_modules/${dependency}`].version;
  const directory = path.join(root, 'node_modules', dependency);
  await fs.rm(path.join(root, 'node_modules'), { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), `${JSON.stringify({ name: dependency, version })}\n`);
}

function options(root, runNpmCi, extra = {}) {
  return {
    root,
    nodeVersion: '22.0.0',
    platform: 'win32',
    arch: 'x64',
    moduleAbi: '127',
    runNpmCi,
    logger: quiet,
    lockOptions: { pollMs: 5, timeoutMs: 1_000, ...extra.lockOptions },
    ...extra,
  };
}

test('the bootstrap rejects old or malformed Node versions before touching the checkout', async () => {
  assert.equal(nodeMajor('22.0.0'), 22);
  assert.equal(assertSupportedNode('26.12.1'), 26);
  assert.throws(() => assertSupportedNode('21.99.0'), /needs Node\.js 22 or newer/);
  assert.throws(() => assertSupportedNode('not-a-version'), /invalid version/);
  await assert.rejects(
    prepareDependencies({ root: path.join(os.tmpdir(), 'does-not-exist'), nodeVersion: '21.0.0' }),
    /needs Node\.js 22 or newer/,
  );
});

test('a clean bootstrap runs the exact safe npm command and matching launches skip it', async t => {
  const root = await makeFixture(t);
  const calls = [];
  const runNpmCi = async call => {
    calls.push(call);
    const source = await fs.readFile(path.join(root, installLockName), 'utf8');
    const lock = JSON.parse(source);
    assert.deepEqual(Object.keys(lock).sort(), ['createdAt', 'format', 'pid', 'token']);
    assert.equal(lock.format, DEPENDENCY_INSTALL_LOCK_FORMAT);
    assert.equal(lock.pid, process.pid);
    assert.match(lock.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Date(lock.createdAt).toISOString(), lock.createdAt);
    assert.equal(source, `${canonicalJson(lock)}\n`);
    await installLockedDependency(root);
  };

  const first = await prepareDependencies(options(root, runNpmCi));
  assert.equal(first.installed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, root);
  assert.deepEqual(calls[0].arguments, [...INSTALL_ARGUMENTS]);
  const stamp = JSON.parse(await fs.readFile(
    path.join(root, 'node_modules', '.fieldwork-dependencies.json'), 'utf8',
  ));
  assert.equal(stamp.format, 1);
  assert.match(stamp.fingerprint, /^[a-f0-9]{64}$/);

  const second = await prepareDependencies(options(root, runNpmCi));
  assert.equal(second.installed, false);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(calls.length, 1);
});

test('lockfile changes and damaged direct dependencies trigger a fresh verified install', async t => {
  const root = await makeFixture(t);
  let calls = 0;
  const runNpmCi = async () => {
    calls += 1;
    await installLockedDependency(root);
  };
  await prepareDependencies(options(root, runNpmCi));

  await writeDefinition(root, '1.2.4');
  const changed = await prepareDependencies(options(root, runNpmCi));
  assert.equal(changed.installed, true);
  assert.equal(calls, 2);

  await fs.rm(path.join(root, 'node_modules', dependency, 'package.json'));
  const repaired = await prepareDependencies(options(root, runNpmCi));
  assert.equal(repaired.installed, true);
  assert.equal(calls, 3);
});

test('package and shrinkwrap dependency definitions must agree', async t => {
  const root = await makeFixture(t);
  await writeDefinition(root, '1.2.3', '9.9.9');
  let called = false;
  await assert.rejects(
    prepareDependencies(options(root, async () => { called = true; })),
    /dependency lists do not match/,
  );
  assert.equal(called, false);
});

test('a failed install removes the old receipt and a later launch retries', async t => {
  const root = await makeFixture(t);
  await prepareDependencies(options(root, async () => installLockedDependency(root)));
  await writeDefinition(root, '1.2.4');

  await assert.rejects(
    prepareDependencies(options(root, async () => { throw new Error('synthetic network failure'); })),
    /synthetic network failure/,
  );
  await assert.rejects(
    fs.access(path.join(root, 'node_modules', '.fieldwork-dependencies.json')),
    error => error?.code === 'ENOENT',
  );

  const retried = await prepareDependencies(options(root, async () => installLockedDependency(root)));
  assert.equal(retried.installed, true);
});

test('a lockfile mutation during npm ci is never stamped as current', async t => {
  const root = await makeFixture(t);
  await assert.rejects(
    prepareDependencies(options(root, async () => {
      await installLockedDependency(root);
      await writeDefinition(root, '1.2.4');
    })),
    /changed while dependencies were installing/,
  );
  await assert.rejects(
    fs.access(path.join(root, 'node_modules', '.fieldwork-dependencies.json')),
    error => error?.code === 'ENOENT',
  );
});

test('concurrent launchers serialize and only one installs', async t => {
  const root = await makeFixture(t);
  await fs.writeFile(path.join(root, installLockName), installLockSource({ pid: 41_101 }));
  let calls = 0;
  let letInstallFinish;
  let installStarted;
  const started = new Promise(resolve => { installStarted = resolve; });
  const hold = new Promise(resolve => { letInstallFinish = resolve; });
  const runNpmCi = async () => {
    calls += 1;
    installStarted();
    await hold;
    await installLockedDependency(root);
  };

  const lockOptions = {
    pollMs: 5,
    timeoutMs: 1_000,
    processStatus: pid => (pid === process.pid ? 'alive' : 'dead'),
  };
  const first = prepareDependencies(options(root, runNpmCi, { lockOptions }));
  const second = prepareDependencies(options(root, runNpmCi, { lockOptions }));
  await started;
  letInstallFinish();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map(result => result.installed).sort(), [false, true]);
});

test('a demonstrably dead install lock is reclaimed, but a live one times out', async t => {
  const root = await makeFixture(t);
  const lockFile = path.join(root, installLockName);
  await fs.writeFile(lockFile, installLockSource());
  const recovered = await prepareDependencies(options(root, async () => installLockedDependency(root), {
    lockOptions: { pollMs: 5, timeoutMs: 100, processStatus: () => 'dead' },
  }));
  assert.equal(recovered.installed, true);

  await fs.rm(path.join(root, 'node_modules'), { recursive: true, force: true });
  const liveSource = installLockSource({ pid: process.pid });
  await fs.writeFile(lockFile, liveSource);
  await assert.rejects(
    prepareDependencies(options(root, async () => assert.fail('must not install'), {
      lockOptions: { pollMs: 5, timeoutMs: 25, processStatus: () => 'alive' },
    })),
    /still preparing dependencies/,
  );
  assert.equal(await fs.readFile(lockFile, 'utf8'), liveSource);
});

test('malformed, oversized, legacy, and unknown-owner install locks fail closed', async t => {
  const root = await makeFixture(t);
  const lockFile = path.join(root, installLockName);
  const duplicateToken = randomUUID();
  const malformed = [
    `${JSON.stringify({ pid: 41_102, token: 'legacy-loose-token' })}\n`,
    `{"createdAt":"2030-01-02T03:04:05.000Z","format":"${DEPENDENCY_INSTALL_LOCK_FORMAT}","pid":41102,"pid":41102,"token":"${duplicateToken}"}\n`,
    `${JSON.stringify({
      pid: 41_102,
      token: randomUUID(),
      format: DEPENDENCY_INSTALL_LOCK_FORMAT,
      createdAt: '2030-01-02T03:04:05.000Z',
    })}\n`,
    'x'.repeat(4 * 1024 + 1),
  ];
  for (const source of malformed) {
    await fs.writeFile(lockFile, source, { flag: 'wx' });
    await assert.rejects(
      prepareDependencies(options(root, async () => assert.fail('must not install'), {
        lockOptions: {
          pollMs: 5,
          timeoutMs: 15,
          processStatus: () => assert.fail('unsafe metadata must not reach the process probe'),
        },
      })),
      /still preparing dependencies/,
    );
    assert.equal(await fs.readFile(lockFile, 'utf8'), source);
    await fs.rm(lockFile);
  }

  const unknown = installLockSource({ pid: 41_103 });
  await fs.writeFile(lockFile, unknown, { flag: 'wx' });
  await assert.rejects(
    prepareDependencies(options(root, async () => assert.fail('must not install'), {
      lockOptions: { pollMs: 5, timeoutMs: 15, processStatus: () => 'unknown' },
    })),
    /still preparing dependencies/,
  );
  assert.equal(await fs.readFile(lockFile, 'utf8'), unknown);
});

test('a replacement after stale-lock validation survives and prevents installation', async t => {
  const root = await makeFixture(t);
  const lockFile = path.join(root, installLockName);
  const held = `${lockFile}.held`;
  const original = installLockSource({ pid: 41_104 });
  const replacement = installLockSource({ pid: process.pid });
  await fs.writeFile(lockFile, original);
  let replaced = false;
  await assert.rejects(
    prepareDependencies(options(root, async () => assert.fail('must not install'), {
      lockOptions: {
        pollMs: 5,
        timeoutMs: 30,
        processStatus: pid => (pid === process.pid ? 'alive' : 'dead'),
        async onRecoveryPhase(event) {
          if (event.phase !== 'validated' || replaced) return;
          replaced = true;
          await fs.rename(lockFile, held);
          await fs.writeFile(lockFile, replacement, { flag: 'wx' });
        },
      },
    })),
    /still preparing dependencies/,
  );
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(lockFile, 'utf8'), replacement);
  assert.equal(await fs.readFile(held, 'utf8'), original);
});

test('a fresh incumbent created after quarantine survives guarded recovery', async t => {
  const root = await makeFixture(t);
  const lockFile = path.join(root, installLockName);
  const original = installLockSource({ pid: 41_105 });
  const incumbent = installLockSource({ pid: process.pid });
  await fs.writeFile(lockFile, original);
  let installedIncumbent = false;
  await assert.rejects(
    prepareDependencies(options(root, async () => assert.fail('must not install'), {
      lockOptions: {
        pollMs: 5,
        timeoutMs: 30,
        processStatus: pid => (pid === process.pid ? 'alive' : 'dead'),
        async onRecoveryPhase(event) {
          if (event.phase !== 'quarantined' || installedIncumbent) return;
          installedIncumbent = true;
          await fs.writeFile(lockFile, incumbent, { flag: 'wx' });
        },
      },
    })),
    /still preparing dependencies/,
  );
  assert.equal(installedIncumbent, true);
  assert.equal(await fs.readFile(lockFile, 'utf8'), incumbent);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith(`${installLockName}.recovered-`)), false);
});

test('a linked install lock is retained without touching its target', async t => {
  const root = await makeFixture(t);
  const lockFile = path.join(root, installLockName);
  const target = path.join(root, 'linked-install-lock-target');
  const source = installLockSource({ pid: 41_106 });
  await fs.writeFile(target, source);
  try { await fs.symlink(target, lockFile, 'file'); }
  catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) throw error;
    return t.skip(`file symlinks are unavailable: ${error.code}`);
  }
  await assert.rejects(
    prepareDependencies(options(root, async () => assert.fail('must not install'), {
      lockOptions: {
        pollMs: 5,
        timeoutMs: 15,
        processStatus: () => assert.fail('a link must not reach the process probe'),
      },
    })),
    /still preparing dependencies/,
  );
  assert.equal((await fs.lstat(lockFile)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), source);
});

test('an owned install lock that changes is retained and both operation failures survive', async t => {
  const root = await makeFixture(t);
  const lockFile = path.join(root, installLockName);
  const changed = installLockSource({ pid: process.pid });
  let failure;
  try {
    await prepareDependencies(options(root, async () => {
      await fs.writeFile(lockFile, changed);
      throw new Error('synthetic install failure');
    }));
  } catch (error) { failure = error; }
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /preparation and install-lock release both failed/);
  assert.equal(failure.errors.length, 2);
  assert.match(failure.errors[0].message, /synthetic install failure/);
  assert.match(failure.errors[1].message, /lock (?:payload|token) changed/);
  assert.equal(await fs.readFile(lockFile, 'utf8'), changed);
});

test('a linked node_modules is refused without touching its target', async t => {
  const root = await makeFixture(t);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork linked modules target-'));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  await fs.writeFile(path.join(target, 'sentinel.txt'), 'keep me');
  try { await fs.symlink(target, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error?.code === 'EPERM') return t.skip('this Windows account cannot create a test junction');
    throw error;
  }
  let called = false;
  await assert.rejects(
    prepareDependencies(options(root, async () => { called = true; })),
    /node_modules must be a plain directory/,
  );
  assert.equal(called, false);
  assert.equal(await fs.readFile(path.join(target, 'sentinel.txt'), 'utf8'), 'keep me');
});

test('a Windows double-click launch finds npm without an inherited npm_execpath', {
  skip: process.platform === 'win32' ? false : 'the adjacent npm CLI fallback is Windows-specific',
  timeout: 60_000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork npm fallback & ()-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const realRoot = path.join(directory, 'real package');
  const scripts = path.join(realRoot, 'scripts');
  const sourceDirectory = path.join(realRoot, 'src');
  await Promise.all([
    fs.mkdir(scripts, { recursive: true }),
    fs.mkdir(sourceDirectory, { recursive: true }),
  ]);
  await fs.copyFile(
    path.join(repo, 'scripts', 'prepare-dependencies.mjs'),
    path.join(scripts, 'prepare-dependencies.mjs'),
  );
  await fs.copyFile(
    path.join(repo, 'scripts', 'prepare-dependencies-cli.mjs'),
    path.join(scripts, 'prepare-dependencies-cli.mjs'),
  );
  for (const name of ['cooperative-state-lock.mjs', 'json-data.mjs', 'stale-state-locks.mjs']) {
    await fs.copyFile(path.join(repo, 'src', name), path.join(sourceDirectory, name));
  }
  const packageJson = { name: 'fieldwork-empty-bootstrap', version: '0.0.0', private: true };
  const shrinkwrap = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: packageJson.name, version: packageJson.version } },
  };
  await Promise.all([
    fs.writeFile(path.join(realRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`),
    fs.writeFile(path.join(realRoot, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap, null, 2)}\n`),
  ]);
  const aliasRoot = path.join(directory, 'junction alias');
  try { await fs.symlink(realRoot, aliasRoot, 'junction'); }
  catch (error) {
    if (error?.code === 'EPERM') return t.skip('this Windows account cannot create a test junction');
    throw error;
  }
  const environment = { ...process.env };
  delete environment.npm_execpath;
  const result = await run(process.execPath, [path.join(aliasRoot, 'scripts', 'prepare-dependencies-cli.mjs')], {
    cwd: aliasRoot,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  assert.match(result.stdout, /Installing lockfile-pinned dependencies/);
  const stamp = JSON.parse(await fs.readFile(
    path.join(realRoot, 'node_modules', '.fieldwork-dependencies.json'), 'utf8',
  ));
  assert.equal(stamp.format, 1);
});
