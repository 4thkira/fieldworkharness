import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib';
import {
  buildRelease,
  RELEASE_BUILD_TEST_SEAM,
  sameFileIdentity,
  sanitizedEnvironment,
} from '../scripts/build-release.mjs';

const run = promisify(execFile);
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

async function command(cwd, commandName, arguments_) {
  return run(commandName, arguments_, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function withEnvironment(values, work) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  try { return await work(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function fixture(t, {
  version = '0.1.0-alpha.1',
  privatePackage = true,
  includeIgnoredPackageFile = false,
  defaultVerification = false,
  includeReleaseNote = true,
  longPackageFile = false,
  releaseNote = '# Synthetic release notes\n',
  readme = '# Synthetic release fixture\n',
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-release-build-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'repository');
  const output = path.join(directory, 'output');
  await fs.mkdir(repository);
  await command(repository, 'git', ['init', '-b', 'main']);
  await command(repository, 'git', ['config', 'user.name', 'Synthetic Release Test']);
  await command(repository, 'git', ['config', 'user.email', 'synthetic@example.invalid']);
  const packageJson = {
    name: 'fieldwork-synthetic',
    version,
    private: privatePackage,
    license: 'GPL-3.0-or-later',
    files: [
      'README.md',
      ...(includeIgnoredPackageFile ? ['private.txt'] : []),
      ...(longPackageFile ? ['long'] : []),
    ],
    ...(defaultVerification ? { scripts: { check: 'node scripts/check.mjs' } } : {}),
  };
  await fs.writeFile(path.join(repository, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await fs.writeFile(path.join(repository, 'README.md'), readme);
  await fs.writeFile(path.join(repository, '.gitignore'), 'private.txt\n');
  const tracked = ['.gitignore', 'package.json', 'README.md'];
  if (includeReleaseNote) {
    const notesDirectory = path.join(repository, 'docs', 'releases');
    await fs.mkdir(notesDirectory, { recursive: true });
    await fs.writeFile(path.join(notesDirectory, `${version}.md`), releaseNote);
    tracked.push(`docs/releases/${version}.md`);
  }
  if (longPackageFile) {
    const longDirectory = path.join(repository, 'long');
    const longBasename = `${'a'.repeat(145)}.txt`;
    await fs.mkdir(longDirectory);
    await fs.writeFile(path.join(longDirectory, longBasename), 'synthetic long path bytes\n');
    tracked.push(`long/${longBasename}`);
  }
  if (defaultVerification) {
    await fs.mkdir(path.join(repository, 'scripts'));
    await fs.writeFile(
      path.join(repository, 'scripts', 'check.mjs'),
      "import fs from 'node:fs/promises';\nawait fs.access(new URL('../README.md', import.meta.url));\n",
    );
    await fs.writeFile(
      path.join(repository, 'scripts', 'release-check.mjs'),
      "import { execFileSync } from 'node:child_process';\nconst files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0');\nif (!files.includes('README.md')) throw new Error('captured source inventory is unavailable');\n",
    );
    await fs.writeFile(path.join(repository, 'npm-shrinkwrap.json'), `${JSON.stringify({
      name: packageJson.name,
      version: packageJson.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: packageJson.name,
          version: packageJson.version,
          license: packageJson.license,
        },
      },
    }, null, 2)}\n`);
    tracked.push('npm-shrinkwrap.json', 'scripts/check.mjs', 'scripts/release-check.mjs');
  }
  await command(repository, 'git', ['add', '--', ...tracked]);
  await command(repository, 'git', ['commit', '-m', 'Synthetic public root']);
  if (includeIgnoredPackageFile) {
    await fs.writeFile(path.join(repository, 'private.txt'), 'ignored but package-selected\n');
  }
  return { directory, repository, output };
}

async function sha256(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function paxValues(data) {
  const values = new Map();
  let cursor = 0;
  while (cursor < data.length) {
    const separator = data.indexOf(0x20, cursor);
    assert.notEqual(separator, -1);
    const length = Number(data.subarray(cursor, separator).toString('ascii'));
    const end = cursor + length;
    assert.ok(Number.isSafeInteger(length) && data[end - 1] === 0x0a);
    const body = data.subarray(separator + 1, end - 1);
    const equals = body.indexOf(0x3d);
    assert.ok(equals > 0);
    values.set(body.subarray(0, equals).toString('ascii'), body.subarray(equals + 1).toString('utf8'));
    cursor = end;
  }
  return values;
}

function tarRecords(archive) {
  const records = [];
  let offset = 0;
  let pendingPax = null;
  while (offset + 512 <= archive.length) {
    const headerOffset = offset;
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) break;
    const field = header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim();
    const size = Number.parseInt(field, 8);
    assert.ok(Number.isSafeInteger(size));
    const type = String.fromCharCode(header[156]);
    const stringField = (start, length) => {
      const value = header.subarray(start, start + length);
      const end = value.indexOf(0);
      return value.subarray(0, end === -1 ? value.length : end).toString('utf8');
    };
    const dataOffset = offset;
    const data = archive.subarray(dataOffset, dataOffset + size);
    if (type === 'x') {
      pendingPax = paxValues(data);
    } else if (type !== 'g') {
      const name = stringField(0, 100);
      const prefix = stringField(345, 155);
      const headerPath = prefix ? `${prefix}/${name}` : name;
      records.push({
        headerOffset,
        dataOffset,
        path: pendingPax?.get('path') ?? headerPath,
        type,
        size,
        mode: Number.parseInt(header.subarray(100, 108).toString('ascii').replace(/\0.*$/su, '').trim(), 8),
      });
      pendingPax = null;
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return records;
}

function tarEntryPaths(archive) {
  return tarRecords(archive).map(record => record.path);
}

function refreshTarChecksum(header) {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, '0')} \0`, 'ascii').copy(header, 148);
}

async function canonicalTestGzip(archive) {
  const compressed = Buffer.from(await gzip(archive, { level: 9, mtime: 0 }));
  compressed[9] = 0xff;
  return compressed;
}

const noVerification = async () => {};

test('release subprocess environments remove secret names without case assumptions', () => {
  const environment = sanitizedEnvironment({
    PATH: 'synthetic-path',
    git_dir: 'synthetic-routing',
    GIT_CONFIG_COUNT: '1',
    GCM_INTERACTIVE: 'Always',
    fieldwork_api_key: 'synthetic-model-secret',
    Fieldwork_Telegram_Token: 'synthetic-telegram-secret',
    FIELDWORK_DISCORD_TOKEN: 'synthetic-discord-secret',
    FIELDWORK_SAFE_VALUE: 'kept',
  });
  assert.equal(environment.PATH, 'synthetic-path');
  assert.equal(environment.FIELDWORK_SAFE_VALUE, 'kept');
  assert.equal(environment.fieldwork_api_key, undefined);
  assert.equal(environment.Fieldwork_Telegram_Token, undefined);
  assert.equal(environment.FIELDWORK_DISCORD_TOKEN, undefined);
  assert.equal(environment.git_dir, undefined);
  assert.equal(environment.GIT_CONFIG_COUNT, undefined);
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GCM_INTERACTIVE, 'Never');
});

test('file identity fails closed when a filesystem reports zero inodes', () => {
  const base = { dev: 3n, ino: 0n, birthtimeNs: 101n, mode: 0o100644n };
  assert.equal(sameFileIdentity(base, { ...base }), false);
  assert.equal(sameFileIdentity(base, { ...base, birthtimeNs: 102n }), false);
  assert.equal(sameFileIdentity(base, { ...base, birthtimeNs: 0n }), false);
  assert.equal(sameFileIdentity(base, { ...base, mode: 0o040755n }), false);
  assert.equal(sameFileIdentity({ ...base, ino: 7n }, { ...base, ino: 7n, birthtimeNs: 999n }), true);
});

test('the default verification gates run inside a captured tree with a synthetic public index', async t => {
  const data = await fixture(t, { defaultVerification: true });
  const result = await buildRelease({ root: data.repository, outputRoot: data.output });
  assert.ok(result.files.includes('fieldwork-synthetic-0.1.0-alpha.1.tgz'));
  assert.equal((await command(data.repository, 'git', ['status', '--porcelain'])).stdout, '');
});

test('a clean commit builds exact source and package archives with reviewable checksums', async t => {
  const data = await fixture(t);
  const result = await buildRelease({
    root: data.repository,
    outputRoot: data.output,
    verify: noVerification,
  });
  const expectedCommit = (await command(data.repository, 'git', ['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(result.commit, expectedCommit);
  assert.equal(result.version, '0.1.0-alpha.1');
  assert.equal(result.directory, await fs.realpath(path.join(data.output, 'v0.1.0-alpha.1')));
  assert.deepEqual(result.files, [
    'RELEASE-MANIFEST.json',
    'SHA256SUMS.txt',
    'fieldwork-synthetic-0.1.0-alpha.1.tgz',
    'fieldwork-synthetic-v0.1.0-alpha.1-release-notes.md',
    'fieldwork-synthetic-v0.1.0-alpha.1-source.tar',
  ]);

  const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'RELEASE-MANIFEST.json'), 'utf8'));
  assert.equal(manifest.format, 'fieldwork-release/v1');
  assert.deepEqual(manifest.package, { name: 'fieldwork-synthetic', version: '0.1.0-alpha.1' });
  assert.equal(manifest.commit, expectedCommit);
  assert.deepEqual(manifest.artifacts.map(row => row.filename), [
    'fieldwork-synthetic-0.1.0-alpha.1.tgz',
    'fieldwork-synthetic-v0.1.0-alpha.1-release-notes.md',
    'fieldwork-synthetic-v0.1.0-alpha.1-source.tar',
  ]);
  assert.equal(
    await fs.readFile(path.join(result.directory, 'fieldwork-synthetic-v0.1.0-alpha.1-release-notes.md'), 'utf8'),
    '# Synthetic release notes\n',
  );

  const checksumLines = (await fs.readFile(path.join(result.directory, 'SHA256SUMS.txt'), 'utf8'))
    .trimEnd().split('\n');
  assert.deepEqual(checksumLines.map(line => line.slice(66)), [
    'RELEASE-MANIFEST.json',
    'fieldwork-synthetic-0.1.0-alpha.1.tgz',
    'fieldwork-synthetic-v0.1.0-alpha.1-release-notes.md',
    'fieldwork-synthetic-v0.1.0-alpha.1-source.tar',
  ]);
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/u.exec(line);
    assert.ok(match, line);
    assert.equal(match[1], await sha256(path.join(result.directory, match[2])));
  }

  const sourcePrefix = 'fieldwork-synthetic-v0.1.0-alpha.1';
  const sourceArtifact = path.join(result.directory, 'fieldwork-synthetic-v0.1.0-alpha.1-source.tar');
  const sourcePaths = tarEntryPaths(await fs.readFile(sourceArtifact));
  assert.deepEqual(sourcePaths, [
    `${sourcePrefix}/`,
    `${sourcePrefix}/.gitignore`,
    `${sourcePrefix}/README.md`,
    `${sourcePrefix}/docs/`,
    `${sourcePrefix}/docs/releases/`,
    `${sourcePrefix}/docs/releases/0.1.0-alpha.1.md`,
    `${sourcePrefix}/package.json`,
  ]);
});

test('release output is deterministic and an existing version is never replaced', async t => {
  const data = await fixture(t);
  const firstRoot = path.join(data.directory, 'first-output');
  const secondRoot = path.join(data.directory, 'second-output');
  const first = await buildRelease({ root: data.repository, outputRoot: firstRoot, verify: noVerification });
  const second = await buildRelease({ root: data.repository, outputRoot: secondRoot, verify: noVerification });
  for (const filename of first.files) {
    assert.equal(
      await sha256(path.join(first.directory, filename)),
      await sha256(path.join(second.directory, filename)),
      filename,
    );
  }

  const protectedFile = path.join(first.directory, 'SHA256SUMS.txt');
  const before = await fs.readFile(protectedFile);
  await assert.rejects(
    buildRelease({ root: data.repository, outputRoot: firstRoot, verify: noVerification }),
    /release output already exists/,
  );
  assert.deepEqual(await fs.readFile(protectedFile), before);
});

test('the default output is a verified outside sibling and inside roots are refused', async t => {
  const data = await fixture(t);
  const result = await buildRelease({ root: data.repository, verify: noVerification });
  assert.equal(
    result.directory,
    await fs.realpath(path.join(data.directory, 'repository-releases', 'v0.1.0-alpha.1')),
  );
  assert.equal((await command(data.repository, 'git', ['status', '--porcelain'])).stdout, '');

  for (const outputRoot of [data.repository, path.join(data.repository, 'release')]) {
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot, verify: noVerification }),
      /release output must be outside the source repository/,
    );
  }
  await assert.rejects(fs.stat(path.join(data.repository, 'release')), error => error?.code === 'ENOENT');
});

test('an outside symlink that resolves into the repository is not an output escape hatch', async t => {
  const data = await fixture(t);
  const alias = path.join(data.directory, 'repository-alias');
  try {
    await fs.symlink(data.repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('creating a directory link is not permitted on this host');
      return;
    }
    throw error;
  }
  await assert.rejects(
    buildRelease({
      root: data.repository,
      outputRoot: path.join(alias, 'release'),
      verify: noVerification,
    }),
    /release output must be outside the source repository/,
  );
  await assert.rejects(fs.stat(path.join(data.repository, 'release')), error => error?.code === 'ENOENT');
});

test('verification runs against the captured commit while the live checkout may change and return', async t => {
  const data = await fixture(t);
  const original = await fs.readFile(path.join(data.repository, 'README.md'));
  const result = await buildRelease({
    root: data.repository,
    outputRoot: data.output,
    verify: async (verificationRoot, context) => {
      assert.notEqual(await fs.realpath(verificationRoot), await fs.realpath(context.repositoryRoot));
      assert.deepEqual(await fs.readFile(path.join(verificationRoot, 'README.md')), original);
      await fs.writeFile(path.join(context.repositoryRoot, 'README.md'), '# Transient live bytes\n');
      assert.deepEqual(await fs.readFile(path.join(verificationRoot, 'README.md')), original);
      await fs.writeFile(path.join(context.repositoryRoot, 'README.md'), original);
    },
  });
  assert.ok(result.files.includes('fieldwork-synthetic-0.1.0-alpha.1.tgz'));
  assert.equal((await command(data.repository, 'git', ['status', '--porcelain'])).stdout, '');
});

test('the npm archive is packed from the captured commit even if live bytes change and return', async t => {
  const data = await fixture(t);
  const baseline = await buildRelease({
    root: data.repository,
    outputRoot: path.join(data.directory, 'baseline-output'),
    verify: noVerification,
  });
  const original = await fs.readFile(path.join(data.repository, 'README.md'));
  const stressed = await buildRelease({
    root: data.repository,
    outputRoot: path.join(data.directory, 'stressed-output'),
    verify: noVerification,
    async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
      if (checkpoint !== 'before-artifact-snapshot') return;
      assert.deepEqual(Object.keys(context).sort(), ['commit', 'repositoryRoot', 'stagingRoot']);
      const { repositoryRoot } = context;
      await fs.writeFile(path.join(repositoryRoot, 'README.md'), '# Transient uncommitted bytes\n');
      await fs.writeFile(path.join(repositoryRoot, 'README.md'), original);
    },
  });
  const packageName = 'fieldwork-synthetic-0.1.0-alpha.1.tgz';
  assert.equal(
    await sha256(path.join(stressed.directory, packageName)),
    await sha256(path.join(baseline.directory, packageName)),
  );
  assert.equal((await command(data.repository, 'git', ['status', '--porcelain'])).stdout, '');
});

test('the artifact snapshot does not exist while the post-verification callback can run', async t => {
  const data = await fixture(t);
  const baseline = await buildRelease({
    root: data.repository,
    outputRoot: path.join(data.directory, 'baseline-output'),
    verify: noVerification,
  });
  let checked = false;
  const stressed = await buildRelease({
    root: data.repository,
    outputRoot: path.join(data.directory, 'stressed-output'),
    verify: noVerification,
    async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
      if (checkpoint !== 'before-artifact-snapshot') return;
      assert.deepEqual(Object.keys(context).sort(), ['commit', 'repositoryRoot', 'stagingRoot']);
      checked = true;
      await assert.rejects(
        fs.stat(path.join(context.stagingRoot, 'committed-tree')),
        error => error?.code === 'ENOENT',
      );
    },
  });
  assert.equal(checked, true);
  const packageName = 'fieldwork-synthetic-0.1.0-alpha.1.tgz';
  assert.equal(
    await sha256(path.join(stressed.directory, packageName)),
    await sha256(path.join(baseline.directory, packageName)),
  );
});

test('the emitted npm TGZ is inspected and bound to the release commit bytes', async t => {
  const poison = await fixture(t, { readme: '# Substituted release fixture\n' });
  const poisonRelease = await buildRelease({
    root: poison.repository,
    outputRoot: poison.output,
    verify: noVerification,
  });
  const poisonPackage = path.join(poisonRelease.directory, 'fieldwork-synthetic-0.1.0-alpha.1.tgz');
  const data = await fixture(t);
  await assert.rejects(
    buildRelease({
      root: data.repository,
      outputRoot: data.output,
      verify: noVerification,
      async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
        if (checkpoint !== 'before-package-validate') return;
        await fs.copyFile(poisonPackage, context.archive);
      },
    }),
    /npm package archive bytes or mode differ from the release commit/,
  );
  await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
});

test('published archives have canonical metadata, padding, and gzip framing', async t => {
  await t.test('gzip comments are removed from the published package', async t => {
    const data = await fixture(t);
    const marker = Buffer.from('SYNTHETIC-GZIP-COMMENT\0', 'ascii');
    const result = await buildRelease({
      root: data.repository,
      outputRoot: data.output,
      verify: noVerification,
      async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
        if (checkpoint !== 'before-package-validate') return;
        const original = await fs.readFile(context.archive);
        const header = Buffer.from(original.subarray(0, 10));
        header[3] |= 0x10;
        await fs.writeFile(context.archive, Buffer.concat([header, marker, original.subarray(10)]));
      },
    });
    const published = await fs.readFile(
      path.join(result.directory, 'fieldwork-synthetic-0.1.0-alpha.1.tgz'),
    );
    assert.equal(published[3], 0);
    assert.equal(published.indexOf(marker.subarray(0, -1)), -1);
  });

  await t.test('nonzero TAR entry padding is refused', async t => {
    const data = await fixture(t);
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
          if (checkpoint !== 'before-package-validate') return;
          const archive = Buffer.from(await gunzip(await fs.readFile(context.archive)));
          const record = tarRecords(archive).find(row => row.size % 512 !== 0);
          assert.ok(record);
          archive[record.dataOffset + record.size] = 0x58;
          await fs.writeFile(context.archive, await canonicalTestGzip(archive));
        },
      }),
      /nonzero entry padding/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('permission bits outside the exact committed mode are refused', async t => {
    const data = await fixture(t);
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
          if (checkpoint !== 'before-package-validate') return;
          const archive = Buffer.from(await gunzip(await fs.readFile(context.archive)));
          const record = tarRecords(archive).find(row => row.type === '0');
          assert.ok(record);
          const header = archive.subarray(record.headerOffset, record.headerOffset + 512);
          Buffer.from('004644 \0', 'ascii').copy(header, 100);
          refreshTarChecksum(header);
          await fs.writeFile(context.archive, await canonicalTestGzip(archive));
        },
      }),
      /noncanonical entry mode/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });
});

test('local tar.umask cannot change the source artifact', async t => {
  const data = await fixture(t);
  await command(data.repository, 'git', ['config', 'tar.umask', '0077']);
  const first = await buildRelease({
    root: data.repository,
    outputRoot: path.join(data.directory, 'first-output'),
    verify: noVerification,
  });
  await command(data.repository, 'git', ['config', 'tar.umask', '0000']);
  const second = await buildRelease({
    root: data.repository,
    outputRoot: path.join(data.directory, 'second-output'),
    verify: noVerification,
  });
  const filename = 'fieldwork-synthetic-v0.1.0-alpha.1-source.tar';
  assert.equal(
    await sha256(path.join(first.directory, filename)),
    await sha256(path.join(second.directory, filename)),
  );
  const records = tarRecords(await fs.readFile(path.join(first.directory, filename)));
  assert.ok(records.some(record => record.type === '5' && record.mode === 0o755));
  assert.ok(records.some(record => record.type === '0' && record.mode === 0o644));
});

test('a Windows-portable long basename survives npm PAX metadata canonically', async t => {
  const data = await fixture(t, { longPackageFile: true });
  const result = await buildRelease({
    root: data.repository,
    outputRoot: data.output,
    verify: noVerification,
  });
  const archive = await gunzip(await fs.readFile(
    path.join(result.directory, 'fieldwork-synthetic-0.1.0-alpha.1.tgz'),
  ));
  const longPath = `package/long/${'a'.repeat(145)}.txt`;
  const record = tarRecords(archive).find(row => row.path === longPath);
  assert.ok(record);
  assert.equal(record.mode, 0o644);
  assert.equal(
    archive.subarray(record.dataOffset, record.dataOffset + record.size).toString('utf8'),
    'synthetic long path bytes\n',
  );
});

test('hostile inherited Git routing and config variables cannot redirect the release boundary', async t => {
  const data = await fixture(t);
  const hostileIndex = path.join(data.directory, 'hostile-index');
  const result = await withEnvironment({
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(data.repository, '.git', 'objects'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_DIR: path.join(data.directory, 'hostile-git-dir'),
    GIT_INDEX_FILE: hostileIndex,
    GIT_OBJECT_DIRECTORY: path.join(data.directory, 'hostile-objects'),
    GIT_WORK_TREE: data.repository,
  }, () => buildRelease({
    root: data.repository,
    outputRoot: data.output,
    verify: noVerification,
  }));
  assert.equal(result.commit, (await command(data.repository, 'git', ['rev-parse', 'HEAD'])).stdout.trim());
  await assert.rejects(fs.stat(hostileIndex), error => error?.code === 'ENOENT');
});

test('only a self-contained one-commit public checkout may produce release artifacts', async t => {
  await t.test('multiple commits are refused', async t => {
    const data = await fixture(t);
    await fs.appendFile(path.join(data.repository, 'README.md'), 'second history entry\n');
    await command(data.repository, 'git', ['add', '--', 'README.md']);
    await command(data.repository, 'git', ['commit', '-m', 'Synthetic private predecessor']);
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /exactly one parentless public commit/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('unreachable objects are refused', async t => {
    const data = await fixture(t);
    const orphan = path.join(data.directory, 'orphan-object.txt');
    await fs.writeFile(orphan, 'synthetic unreachable bytes\n');
    await command(data.repository, 'git', ['hash-object', '-w', orphan]);
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /objects outside the public HEAD/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('an unreachable object added after verification is refused before publication', async t => {
    const data = await fixture(t);
    const orphan = path.join(data.directory, 'late-orphan-object.txt');
    await fs.writeFile(orphan, 'synthetic late unreachable bytes\n');
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint, { repositoryRoot }) {
          if (checkpoint !== 'before-artifact-snapshot') return;
          await command(repositoryRoot, 'git', ['hash-object', '-w', orphan]);
        },
      }),
      /objects outside the public HEAD/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('a shallow clone whose raw HEAD still names a parent is refused', async t => {
    const data = await fixture(t);
    await fs.appendFile(path.join(data.repository, 'README.md'), 'second history entry\n');
    await command(data.repository, 'git', ['add', '--', 'README.md']);
    await command(data.repository, 'git', ['commit', '-m', 'Synthetic public-looking head']);
    const shallow = path.join(data.directory, 'shallow');
    await command(data.directory, 'git', [
      '-c', 'core.autocrlf=false', 'clone', '--depth=1', '--branch', 'main',
      pathToFileURL(data.repository).href, shallow,
    ]);
    await command(shallow, 'git', ['config', 'core.autocrlf', 'false']);
    assert.equal((await command(shallow, 'git', ['rev-parse', '--is-shallow-repository'])).stdout.trim(), 'true');
    assert.match((await command(shallow, 'git', ['cat-file', '-p', 'HEAD'])).stdout, /^parent [0-9a-f]+$/mu);
    await assert.rejects(
      buildRelease({ root: shallow, outputRoot: data.output, verify: noVerification }),
      /must not be a shallow repository|exactly one parentless public commit/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });
});

test('portable archive paths are validated before Git archive extraction', async t => {
  const data = await fixture(t);
  const blob = (await command(data.repository, 'git', ['rev-parse', 'HEAD:README.md'])).stdout.trim();
  await command(data.repository, 'git', [
    '-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},NUL.txt`,
  ]);
  await command(data.repository, 'git', ['update-index', '--skip-worktree', 'NUL.txt']);
  await command(data.repository, 'git', ['commit', '-m', 'Synthetic unsafe tree path']);
  await assert.rejects(
    buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
    /path that is unsafe on Windows/,
  );
  await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
});

test('release notes are required, non-empty, exact, and commit-bound', async t => {
  await t.test('missing note', async t => {
    const data = await fixture(t, { includeReleaseNote: false });
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /release note is missing from the commit/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('empty note', async t => {
    const data = await fixture(t, { releaseNote: '' });
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /release note must be a non-empty regular file/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('repository-relative Markdown links are refused in the standalone note', async t => {
    const data = await fixture(t, {
      releaseNote: '# Synthetic release notes\n\nRead the [guide](../../README.md).\n',
    });
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /repository-relative Markdown link/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  for (const [label, releaseNote, expected] of [
    ['relative Markdown image', '![room](../../docs/images/room.png)\n', /repository-relative Markdown link/],
    ['reference-style Markdown link', '[guide][manual]\n\n[manual]: https://example.invalid/guide\n', /reference-style Markdown links/],
    ['nested-label Markdown link', '[outer [inner]](../../README.md)\n', /repository-relative Markdown link/],
    ['quoted reference definition', '> [manual]: ../../README.md\n', /reference-style Markdown links/],
    ['relative raw HTML source', '<img src="../../docs/images/room.png" alt="room">\n', /repository-relative Markdown link/],
  ]) {
    await t.test(label, async t => {
      const data = await fixture(t, { releaseNote });
      await assert.rejects(
        buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
        expected,
      );
      await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
    });
  }

  await t.test('absolute tagged links and local fragments remain portable', async t => {
    const releaseNote = [
      '# Synthetic release notes',
      '',
      '[tagged guide](https://github.com/example/project/blob/v0.1.0/README.md)',
      '[local details](#details)',
      '<a href="https://example.invalid/security">security</a>',
      '',
    ].join('\n');
    const data = await fixture(t, { releaseNote });
    const result = await buildRelease({
      root: data.repository,
      outputRoot: data.output,
      verify: noVerification,
    });
    assert.equal(
      await fs.readFile(
        path.join(result.directory, 'fieldwork-synthetic-v0.1.0-alpha.1-release-notes.md'),
        'utf8',
      ),
      releaseNote,
    );
  });
});

test('an output root swapped to a repository junction during verification is refused', async t => {
  const data = await fixture(t);
  const probeTarget = path.join(data.directory, 'junction-probe-target');
  const probeLink = path.join(data.directory, 'junction-probe-link');
  await fs.mkdir(probeTarget);
  try {
    await fs.symlink(probeTarget, probeLink, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.unlink(probeLink);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('creating a directory link is not permitted on this host');
      return;
    }
    throw error;
  }
  await assert.rejects(
    buildRelease({
      root: data.repository,
      outputRoot: data.output,
      verify: async () => {
        await fs.rmdir(data.output);
        await fs.symlink(data.repository, data.output, process.platform === 'win32' ? 'junction' : 'dir');
      },
    }),
    /release output root must be a plain directory|release output root changed/,
  );
  await assert.rejects(
    fs.stat(path.join(data.repository, 'v0.1.0-alpha.1')),
    error => error?.code === 'ENOENT',
  );
  await fs.unlink(data.output);
});

test('archive extraction refuses a parent directory replaced with a junction before writes', async t => {
  const data = await fixture(t);
  const outsideTarget = path.join(data.directory, 'outside-extraction-target');
  const probeLink = path.join(data.directory, 'extraction-junction-probe');
  await fs.mkdir(outsideTarget);
  try {
    await fs.symlink(outsideTarget, probeLink, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.unlink(probeLink);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('creating a directory link is not permitted on this host');
      return;
    }
    throw error;
  }
  await assert.rejects(
    buildRelease({
      root: data.repository,
      outputRoot: data.output,
      verify: noVerification,
      async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
        if (checkpoint !== 'before-extract' || context.phase !== 'verification') return;
        const docs = path.join(context.directory, 'docs');
        await fs.rm(docs, { recursive: true, force: true });
        await fs.symlink(outsideTarget, docs, process.platform === 'win32' ? 'junction' : 'dir');
      },
    }),
    /Git archive parent directory must be a plain directory|Git archive parent directory changed/,
  );
  assert.deepEqual(await fs.readdir(outsideTarget), []);
  await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
});

test('the published source TAR is written only from the exact validated archive bytes', async t => {
  const data = await fixture(t);
  let injected = false;
  await assert.rejects(
    buildRelease({
      root: data.repository,
      outputRoot: data.output,
      verify: noVerification,
      async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
        if (checkpoint !== 'before-extract' || context.phase !== 'artifact') return;
        injected = true;
        await fs.writeFile(
          path.join(path.dirname(context.directory), 'fieldwork-synthetic-v0.1.0-alpha.1-source.tar'),
          'synthetic substituted archive bytes\n',
          { flag: 'wx' },
        );
      },
    }),
    /could not create the release artifacts/,
  );
  assert.equal(injected, true);
  await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
});

test('the standalone note record remains bound to its validated commit bytes', async t => {
  const data = await fixture(t);
  await assert.rejects(
    buildRelease({
      root: data.repository,
      outputRoot: data.output,
      verify: noVerification,
      async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
        if (checkpoint !== 'before-package-validate') return;
        await fs.writeFile(
          path.join(path.dirname(context.archive), 'fieldwork-synthetic-v0.1.0-alpha.1-release-notes.md'),
          '# Substituted standalone release notes\n',
        );
      },
    }),
    /artifact that differs from its manifest/,
  );
  await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
});

test('publication failures expose no partial owned release and preserve a concurrent target', async t => {
  await t.test('an unreachable object injected at the pre-publish seam is refused', async t => {
    const data = await fixture(t);
    const orphan = path.join(data.directory, 'prepublish-orphan-object.txt');
    await fs.writeFile(orphan, 'synthetic prepublish unreachable bytes\n');
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint) {
          if (checkpoint === 'before-publish') {
            await command(data.repository, 'git', ['hash-object', '-w', orphan]);
          }
        },
      }),
      /objects outside the public HEAD/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('an alternate object store injected at the pre-publish seam is refused', async t => {
    const data = await fixture(t);
    const alternateRepository = path.join(data.directory, 'alternate.git');
    await command(data.directory, 'git', ['init', '--bare', alternateRepository]);
    const alternatesFile = path.join(data.repository, '.git', 'objects', 'info', 'alternates');
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint) {
          if (checkpoint === 'before-publish') {
            await fs.writeFile(alternatesFile, `${path.join(alternateRepository, 'objects')}\n`);
          }
        },
      }),
      /alternate object store/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('injected failure removes the complete sibling stage', async t => {
    const data = await fixture(t);
    await fs.mkdir(data.output);
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        [RELEASE_BUILD_TEST_SEAM](checkpoint) {
          if (checkpoint === 'before-publish') throw new Error('synthetic publish failure');
        },
      }),
      error => error?.message === 'Release build: could not create the release artifacts'
        && error?.cause?.message === 'synthetic publish failure',
    );
    assert.deepEqual(await fs.readdir(data.output), []);
  });

  await t.test('an extra file injected into the sibling stage is detected and removed', async t => {
    const data = await fixture(t);
    await fs.mkdir(data.output);
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
          if (checkpoint !== 'before-publish') return;
          const stage = (await fs.readdir(context.releaseRoot))
            .find(name => name.startsWith('.fieldwork-release-stage-'));
          assert.ok(stage);
          await fs.writeFile(path.join(context.releaseRoot, stage, 'private.txt'), 'synthetic private bytes\n');
        },
      }),
      /unexpected artifact inventory/,
    );
    assert.deepEqual(await fs.readdir(data.output), []);
  });

  await t.test('an extra file injected immediately after rename invalidates and removes owned output', async t => {
    const data = await fixture(t);
    await fs.mkdir(data.output);
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint, context) {
          if (checkpoint === 'after-publish') {
            await fs.writeFile(path.join(context.target, 'private.txt'), 'synthetic private bytes\n');
          }
        },
      }),
      /unexpected artifact inventory/,
    );
    assert.deepEqual(await fs.readdir(data.output), []);
  });

  await t.test('an unreachable object injected immediately after rename invalidates and removes owned output', async t => {
    const data = await fixture(t);
    const orphan = path.join(data.directory, 'post-publish-orphan-object.txt');
    await fs.writeFile(orphan, 'synthetic post-publish unreachable bytes\n');
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint) {
          if (checkpoint === 'after-publish') {
            await command(data.repository, 'git', ['hash-object', '-w', orphan]);
          }
        },
      }),
      /objects outside the public HEAD/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('a target that appears before rename is not replaced', async t => {
    const data = await fixture(t);
    const target = path.join(data.output, 'v0.1.0-alpha.1');
    const sentinel = path.join(target, 'keep.txt');
    await assert.rejects(
      buildRelease({
        root: data.repository,
        outputRoot: data.output,
        verify: noVerification,
        async [RELEASE_BUILD_TEST_SEAM](checkpoint) {
          if (checkpoint !== 'before-publish') return;
          await fs.mkdir(target);
          await fs.writeFile(sentinel, 'concurrent owner\n');
        },
      }),
      /release output already exists/,
    );
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'concurrent owner\n');
    assert.deepEqual(await fs.readdir(data.output), ['v0.1.0-alpha.1']);
  });
});

test('dirty trees and unsafe package identities fail before creating output', async t => {
  await t.test('tracked change', async t => {
    const data = await fixture(t);
    await fs.appendFile(path.join(data.repository, 'README.md'), 'dirty\n');
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /working tree is not clean/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('untracked file', async t => {
    const data = await fixture(t);
    await fs.writeFile(path.join(data.repository, 'local-secret.txt'), 'synthetic-only\n');
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /working tree is not clean/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('placeholder version', async t => {
    const data = await fixture(t, { version: '0.0.0' });
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /placeholder version/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('publishable npm package', async t => {
    const data = await fixture(t, { privatePackage: false });
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /private set to true/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('numeric prerelease identifier with a leading zero', async t => {
    const data = await fixture(t, { version: '1.0.0-01' });
    await assert.rejects(
      buildRelease({ root: data.repository, outputRoot: data.output, verify: noVerification }),
      /numeric prerelease identifier with a leading zero/,
    );
    await assert.rejects(fs.stat(data.output), error => error?.code === 'ENOENT');
  });

  await t.test('ignored untracked file selected by npm', async t => {
    const data = await fixture(t, { includeIgnoredPackageFile: true });
    const result = await buildRelease({
      root: data.repository,
      outputRoot: data.output,
      verify: noVerification,
    });
    assert.ok(result.files.includes('fieldwork-synthetic-0.1.0-alpha.1.tgz'));
    assert.equal((await command(data.repository, 'git', ['status', '--porcelain'])).stdout, '');
  });
});
