import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  preparePublicRepo,
  PUBLIC_REPO_TEST_SEAM,
} from '../scripts/prepare-public-repo.mjs';

const run = promisify(execFile);
const STAGE_PREFIX = '.fieldwork-public-stage-';

async function git(arguments_, cwd, options = {}) {
  return run('git', arguments_, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-public-repo-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'private-source');
  const destination = path.join(root, 'public-snapshot');
  await fs.mkdir(source);
  await git(['init', '--initial-branch=main'], source);
  await git(['config', 'user.name', 'Private Builder'], source);
  await git(['config', 'user.email', 'private-builder@example.invalid'], source);
  await git(['config', 'core.autocrlf', 'false'], source);

  const historicalPath = path.join(source, 'private-history-only.txt');
  await fs.writeFile(historicalPath, 'synthetic private-history-only bytes\n');
  await git(['add', '--all'], source);
  await git(['commit', '-m', 'Synthetic private predecessor'], source);
  const { stdout: historicalHead } = await git(['rev-parse', 'HEAD^{commit}'], source);
  const { stdout: historicalTree } = await git(['rev-parse', 'HEAD^{tree}'], source);
  const { stdout: historicalBlob } = await git(['rev-parse', 'HEAD:private-history-only.txt'], source);

  await fs.rm(historicalPath);
  await fs.mkdir(path.join(source, 'nested'));
  await fs.mkdir(path.join(source, 'scripts'));
  await fs.writeFile(path.join(source, '.gitignore'), 'synthetic-private-leak.txt\n');
  await fs.writeFile(path.join(source, 'README.md'), '# Synthetic source\n');
  await fs.writeFile(path.join(source, 'nested', 'bytes.bin'), Buffer.from([0, 1, 2, 10, 13, 255]));
  const launchPath = path.join(source, 'scripts', 'launch.sh');
  await fs.writeFile(launchPath, '#!/bin/sh\nprintf "synthetic\\n"\n');
  await fs.chmod(launchPath, 0o755);
  await git(['add', '--all'], source);
  await git(['update-index', '--chmod=+x', '--', 'scripts/launch.sh'], source);
  await git(['commit', '-m', 'Private HEAD that must not travel'], source);
  return {
    root,
    source,
    destination,
    historicalHead: historicalHead.trim(),
    historicalTree: historicalTree.trim(),
    historicalBlob: historicalBlob.trim(),
  };
}

async function assertMissing(target) {
  await assert.rejects(fs.lstat(target), error => error?.code === 'ENOENT');
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertObjectMissing(repository, object) {
  await assert.rejects(
    git(['cat-file', '-e', object], repository),
    error => typeof error?.code === 'number' && error.code !== 0,
  );
}

async function assertNoOwnedStages(root) {
  const entries = await fs.readdir(root);
  assert.deepEqual(entries.filter(entry => entry.startsWith(STAGE_PREFIX)), []);
}

async function ownedStagePath(root) {
  const stages = (await fs.readdir(root)).filter(entry => entry.startsWith(STAGE_PREFIX));
  assert.equal(stages.length, 1);
  return path.join(root, stages[0]);
}

async function withEnvironment(overrides, operation) {
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a clean HEAD becomes one exact parentless public commit with no private history objects', async t => {
  const data = await fixture(t);
  const { stdout: privateHead } = await git(['rev-parse', 'HEAD^{commit}'], data.source);
  const { stdout: privateTree } = await git(['rev-parse', 'HEAD^{tree}'], data.source);
  const { stdout: privateObjectFormat } = await git(['rev-parse', '--show-object-format'], data.source);
  const { stdout: privateExecutable } = await git(['ls-tree', 'HEAD', '--', 'scripts/launch.sh'], data.source);

  const receipt = await preparePublicRepo({
    source: data.source,
    destination: data.destination,
    authorName: 'Public Maintainer',
    authorEmail: 'public-maintainer@users.noreply.github.com',
    message: 'Initial public release v0.1.0-alpha.1',
  });

  assert.equal(receipt.format, 'fieldwork-public-repository/v1');
  assert.equal(receipt.sourceHead, privateHead.trim());
  assert.equal(receipt.tree, privateTree.trim());
  assert.equal(receipt.files, 4);
  assert.equal(receipt.commits, 1);
  assert.equal(receipt.remotes, 0);
  assert.equal(receipt.branch, 'main');
  assert.equal(receipt.objectFormat, privateObjectFormat.trim());
  assert.equal(await fs.readFile(path.join(data.destination, 'README.md'), 'utf8'), '# Synthetic source\n');
  assert.deepEqual(
    await fs.readFile(path.join(data.destination, 'nested', 'bytes.bin')),
    Buffer.from([0, 1, 2, 10, 13, 255]),
  );

  const { stdout: count } = await git(['rev-list', '--count', 'HEAD'], data.destination);
  const { stdout: commit } = await git(['cat-file', '-p', 'HEAD'], data.destination);
  const { stdout: identity } = await git(
    ['show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD'],
    data.destination,
  );
  const { stdout: refs } = await git(['for-each-ref', '--format=%(refname)'], data.destination);
  const { stdout: remotes } = await git(['remote'], data.destination);
  const { stdout: status } = await git(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    data.destination,
  );
  const { stdout: publicExecutable } = await git(
    ['ls-tree', 'HEAD', '--', 'scripts/launch.sh'],
    data.destination,
  );
  assert.equal(count.trim(), '1');
  assert.doesNotMatch(commit, /^parent /mu);
  assert.equal(identity.trim(), [
    'Public Maintainer',
    'public-maintainer@users.noreply.github.com',
    'Public Maintainer',
    'public-maintainer@users.noreply.github.com',
  ].join('\n'));
  assert.equal(refs.trim(), 'refs/heads/main');
  assert.equal(remotes, '');
  assert.equal(status, '');
  assert.match(privateExecutable, /^100755 blob /u);
  assert.equal(publicExecutable, privateExecutable);
  await assertMissing(path.join(data.destination, '.git', 'objects', 'info', 'alternates'));
  await assertObjectMissing(data.destination, privateHead.trim());
  await assertObjectMissing(data.destination, data.historicalHead);
  await assertObjectMissing(data.destination, data.historicalTree);
  await assertObjectMissing(data.destination, data.historicalBlob);
  await assertNoOwnedStages(data.root);
});

test('a dirty source is refused before staging or creating the destination', async t => {
  const data = await fixture(t);
  await fs.writeFile(path.join(data.source, 'untracked.txt'), 'not committed\n');
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
    }),
    /source worktree must be clean/,
  );
  await assertMissing(data.destination);
  await assertNoOwnedStages(data.root);
});

test('unsafe or occupied destinations and implicit authors are refused without replacement', async t => {
  const data = await fixture(t);
  await assert.rejects(
    preparePublicRepo({ source: data.source, destination: data.destination }),
    /author name/,
  );

  const inside = path.join(data.source, 'public-copy');
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: inside,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
    }),
    /destination must be outside/,
  );
  await assertMissing(inside);

  await fs.mkdir(data.destination);
  const sentinel = path.join(data.destination, 'keep.txt');
  await fs.writeFile(sentinel, 'keep me\n');
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
    }),
    /destination must not exist/,
  );
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep me\n');
  assert.deepEqual((await fs.readdir(data.destination)).sort(), ['keep.txt']);
  await assertNoOwnedStages(data.root);
});

test('an existing empty destination is refused without changing its identity, and a source subdirectory is not accepted', async t => {
  const data = await fixture(t);
  await fs.mkdir(data.destination);
  const before = await fs.lstat(data.destination, { bigint: true });
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
    }),
    /destination must not exist/,
  );
  const after = await fs.lstat(data.destination, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.birthtimeNs, before.birthtimeNs);
  assert.deepEqual(await fs.readdir(data.destination), []);

  await assert.rejects(
    preparePublicRepo({
      source: path.join(data.source, 'nested'),
      destination: path.join(data.root, 'another-public-copy'),
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
    }),
    /source must name the repository root exactly/,
  );
  await assertNoOwnedStages(data.root);
});

test('inherited Git identity, routing, alternate-object, and config variables are ignored', async t => {
  const data = await fixture(t);
  const { stdout: privateHead } = await git(['rev-parse', 'HEAD^{commit}'], data.source);
  const hostileIndex = path.join(data.root, 'hostile-index');
  await withEnvironment({
    EMAIL: 'fallback-private@example.invalid',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(data.source, '.git', 'objects'),
    GIT_AUTHOR_EMAIL: 'private-author@example.invalid',
    GIT_AUTHOR_NAME: 'Inherited Private Author',
    GIT_COMMITTER_EMAIL: 'private-committer@example.invalid',
    GIT_COMMITTER_NAME: 'Inherited Private Committer',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'init.defaultObjectFormat',
    GIT_CONFIG_VALUE_0: 'sha256',
    GIT_DIR: path.join(data.source, '.git'),
    GIT_INDEX_FILE: hostileIndex,
    GIT_WORK_TREE: data.source,
  }, () => preparePublicRepo({
    source: data.source,
    destination: data.destination,
    authorName: 'Public Maintainer',
    authorEmail: 'public-maintainer@users.noreply.github.com',
  }));

  const { stdout: identity } = await git(
    ['show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD'],
    data.destination,
  );
  assert.equal(identity.trim(), [
    'Public Maintainer',
    'public-maintainer@users.noreply.github.com',
    'Public Maintainer',
    'public-maintainer@users.noreply.github.com',
  ].join('\n'));
  await assertMissing(path.join(data.destination, '.git', 'objects', 'info', 'alternates'));
  await assertObjectMissing(data.destination, privateHead.trim());
  await assertMissing(hostileIndex);
  await assertNoOwnedStages(data.root);
});

test('Win32 device, ADS, trailing, forbidden, and case-colliding tree paths are rejected before staging', async t => {
  const data = await fixture(t);
  const { stdout: blobOutput } = await git(['rev-parse', 'HEAD:README.md'], data.source);
  const blob = blobOutput.trim();
  const unsafeTrees = [
    `100644 blob ${blob}\tNUL.txt\0`,
    `100644 blob ${blob}\tfile:stream\0`,
    `100644 blob ${blob}\ttrailing.\0`,
    `100644 blob ${blob}\ttrailing \0`,
    `100644 blob ${blob}\tbad<name\0`,
    `100644 blob ${blob}\tReadme\0` + `100644 blob ${blob}\tREADME\0`,
  ];
  for (const [index, tree] of unsafeTrees.entries()) {
    const destination = path.join(data.root, `unsafe-public-${index}`);
    await assert.rejects(
      preparePublicRepo({
        source: data.source,
        destination,
        authorName: 'Public Maintainer',
        authorEmail: 'public@example.invalid',
        [PUBLIC_REPO_TEST_SEAM](checkpoint) {
          if (checkpoint === 'tree-read') return Buffer.from(tree, 'utf8');
        },
      }),
      /unsafe on Windows|collide on Windows/,
    );
    await assertMissing(destination);
  }
  await assertNoOwnedStages(data.root);
});

test('a verified-stage failure leaves no destination or owned staging directory', async t => {
  const data = await fixture(t);
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
      [PUBLIC_REPO_TEST_SEAM](checkpoint) {
        if (checkpoint === 'repository-verified') throw new Error('injected verified-stage failure');
      },
    }),
    /injected verified-stage failure/,
  );
  await assertMissing(data.destination);
  await assertNoOwnedStages(data.root);
});

test('an ignored private file injected before publish is refused and cleaned safely', async t => {
  const data = await fixture(t);
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
      async [PUBLIC_REPO_TEST_SEAM](checkpoint) {
        if (checkpoint !== 'before-publish') return;
        const stage = await ownedStagePath(data.root);
        await fs.writeFile(path.join(stage, 'synthetic-private-leak.txt'), 'ignored private bytes\n');
      },
    }),
    /unexpected file|filesystem changed|\.git filesystem layout/,
  );
  await assertMissing(data.destination);
  await assertNoOwnedStages(data.root);
});

test('private metadata injected into .git before publish is refused and cleaned safely', async t => {
  const data = await fixture(t);
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
      async [PUBLIC_REPO_TEST_SEAM](checkpoint) {
        if (checkpoint !== 'before-publish') return;
        const stage = await ownedStagePath(data.root);
        await fs.writeFile(path.join(stage, '.git', 'synthetic-private-metadata'), 'private metadata\n');
      },
    }),
    /\.git filesystem layout|filesystem changed/,
  );
  await assertMissing(data.destination);
  await assertNoOwnedStages(data.root);
});

test('a nested junction injected before export is removed without writing through it', async t => {
  const data = await fixture(t);
  const alternateTarget = path.join(data.root, 'nested-junction-target');
  await fs.mkdir(alternateTarget);
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
      async [PUBLIC_REPO_TEST_SEAM](checkpoint) {
        if (checkpoint !== 'stage-created') return;
        const stage = await ownedStagePath(data.root);
        await fs.symlink(
          alternateTarget,
          path.join(stage, 'nested'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    }),
    /changed before export/,
  );
  assert.deepEqual(await fs.readdir(alternateTarget), []);
  await assertMissing(data.destination);
  await assertNoOwnedStages(data.root);
});

test('a source worktree change after verification prevents publication and removes staging', async t => {
  const data = await fixture(t);
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
      async [PUBLIC_REPO_TEST_SEAM](checkpoint) {
        if (checkpoint === 'repository-verified') {
          await fs.writeFile(path.join(data.source, 'late-private-change.txt'), 'do not publish\n');
        }
      },
    }),
    /source changed while the public repository was prepared/,
  );
  await assertMissing(data.destination);
  await assertNoOwnedStages(data.root);
});

test('a post-publish ignored-file injection is rolled back with no destination or staging residue', async t => {
  const data = await fixture(t);
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
      async [PUBLIC_REPO_TEST_SEAM](checkpoint) {
        if (checkpoint !== 'after-publish') return;
        await fs.writeFile(
          path.join(data.destination, 'synthetic-private-leak.txt'),
          'ignored private bytes\n',
        );
      },
    }),
    /unexpected file|filesystem changed|\.git filesystem layout/,
  );
  await assertMissing(data.destination);
  await assertNoOwnedStages(data.root);
});

test('a destination that appears during publication is preserved and staging is removed', async t => {
  const data = await fixture(t);
  const sentinel = path.join(data.destination, 'keep.txt');
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
      async [PUBLIC_REPO_TEST_SEAM](checkpoint) {
        if (checkpoint !== 'before-publish') return;
        await fs.mkdir(data.destination);
        await fs.writeFile(sentinel, 'concurrent owner\n');
      },
    }),
  );
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'concurrent owner\n');
  await assertNoOwnedStages(data.root);
});

test('a destination junction is refused without touching its target', async t => {
  const data = await fixture(t);
  const junctionTarget = path.join(data.root, 'junction-target');
  await fs.mkdir(junctionTarget);
  await fs.symlink(junctionTarget, data.destination, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    preparePublicRepo({
      source: data.source,
      destination: data.destination,
      authorName: 'Public Maintainer',
      authorEmail: 'public@example.invalid',
    }),
    /destination must not exist/,
  );
  assert.deepEqual(await fs.readdir(junctionTarget), []);
  await assertNoOwnedStages(data.root);
});

test('a destination swapped to a junction at the publish seam is refused before rename', async t => {
  const data = await fixture(t);
  const junctionTarget = path.join(data.root, 'late-junction-target');
  await fs.mkdir(junctionTarget);
  let linked = false;
  try {
    await assert.rejects(
      preparePublicRepo({
        source: data.source,
        destination: data.destination,
        authorName: 'Public Maintainer',
        authorEmail: 'public@example.invalid',
        async [PUBLIC_REPO_TEST_SEAM](checkpoint) {
          if (checkpoint !== 'before-publish') return;
          await fs.symlink(
            junctionTarget,
            data.destination,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          linked = true;
        },
      }),
      /destination appeared/,
    );
    assert.deepEqual(await fs.readdir(junctionTarget), []);
  } finally {
    if (linked && await pathExists(data.destination)) await fs.unlink(data.destination);
  }
  await assertNoOwnedStages(data.root);
});

test('an ancestor swapped to a junction after staging is detected before export reaches its target', async t => {
  const data = await fixture(t);
  const publicationParent = path.join(data.root, 'publication-parent');
  const heldParent = path.join(data.root, 'publication-parent-held');
  const alternateTarget = path.join(data.root, 'alternate-publication-target');
  const destination = path.join(publicationParent, 'public-snapshot');
  await fs.mkdir(publicationParent);
  await fs.mkdir(alternateTarget);
  let swapped = false;
  try {
    await assert.rejects(
      preparePublicRepo({
        source: data.source,
        destination,
        authorName: 'Public Maintainer',
        authorEmail: 'public@example.invalid',
        async [PUBLIC_REPO_TEST_SEAM](checkpoint) {
          if (checkpoint !== 'stage-created') return;
          await fs.rename(publicationParent, heldParent);
          await fs.symlink(
            alternateTarget,
            publicationParent,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          swapped = true;
        },
      }),
      error => error instanceof AggregateError
        && error.errors.some(item => /destination parent/u.test(String(item?.message))),
    );
    assert.deepEqual(await fs.readdir(alternateTarget), []);
  } finally {
    if (swapped && await pathExists(publicationParent)) await fs.unlink(publicationParent);
    if (await pathExists(heldParent)) await fs.rename(heldParent, publicationParent);
  }
  const quarantinedStages = (await fs.readdir(publicationParent))
    .filter(entry => entry.startsWith(STAGE_PREFIX));
  assert.equal(quarantinedStages.length, 1);
  await fs.rm(path.join(publicationParent, quarantinedStages[0]), { recursive: true, force: false });
  await assertNoOwnedStages(publicationParent);
});
