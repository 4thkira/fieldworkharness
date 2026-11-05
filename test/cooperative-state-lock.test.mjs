import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalStateFile,
  STATE_TRANSACTION_LOCK_FORMAT,
  withStateTransactionLock,
} from '../src/cooperative-state-lock.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-state-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'state.json') };
}

async function lockFileFor(file) {
  const requested = path.resolve(file);
  const realParent = await fs.realpath(path.dirname(requested));
  return `${path.join(realParent, path.basename(requested))}.lock`;
}

test('independent callers serialize through one short state transaction lock', async t => {
  const data = await fixture(t);
  const order = [];
  let releaseFirst;
  let firstEntered;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  const first = withStateTransactionLock(data.file, async requested => {
    assert.equal(requested, path.resolve(data.file));
    assert.equal(requested, await canonicalStateFile(data.file));
    order.push('first-enter');
    firstEntered();
    await new Promise(resolve => { releaseFirst = resolve; });
    order.push('first-leave');
    return 'first';
  }, { timeoutMs: 500, pollMs: 5 });
  await entered;
  const second = withStateTransactionLock(data.file, async () => {
    order.push('second-enter');
    return 'second';
  }, { timeoutMs: 500, pollMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(order, ['first-enter']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(order, ['first-enter', 'first-leave', 'second-enter']);
  await assert.rejects(fs.access(await lockFileFor(data.file)), { code: 'ENOENT' });
});

test('a bounded waiter times out without stealing or changing the incumbent lock', async t => {
  const data = await fixture(t);
  let releaseFirst;
  let firstEntered;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  const first = withStateTransactionLock(data.file, async () => {
    firstEntered();
    await new Promise(resolve => { releaseFirst = resolve; });
  }, { timeoutMs: 500, pollMs: 5 });
  await entered;
  const lockFile = await lockFileFor(data.file);
  const before = await fs.readFile(lockFile, 'utf8');
  const metadata = JSON.parse(before);
  assert.equal(metadata.format, STATE_TRANSACTION_LOCK_FORMAT);
  assert.equal(metadata.pid, process.pid);
  assert.match(metadata.token, /^[0-9a-f-]{36}$/u);
  await assert.rejects(
    withStateTransactionLock(data.file, async () => assert.fail('busy work must not start'), { timeoutMs: 25, pollMs: 5 }),
    error => error?.code === 'FIELDWORK_STATE_BUSY'
      && error?.status === 503
      && Object.keys(error).includes('code')
      && Object.keys(error).includes('status')
      && /remained busy for 25 ms; it was not removed/.test(error.message)
      && !error.message.includes(data.directory)
      && !error.message.includes(lockFile),
  );
  assert.equal(await fs.readFile(lockFile, 'utf8'), before);
  releaseFirst();
  await first;
  await assert.rejects(fs.access(lockFile), { code: 'ENOENT' });
});

test('a transient Windows create denial is retried without stealing a lock', async t => {
  if (process.platform !== 'win32') return t.skip('Windows-specific exclusive-create behavior');
  const data = await fixture(t);
  const realOpen = fs.open.bind(fs);
  let createAttempts = 0;
  t.mock.method(fs, 'open', async (...args) => {
    if (args[1] === 'wx' && createAttempts++ === 0) {
      const error = new Error('synthetic transient create denial');
      error.code = 'EPERM';
      throw error;
    }
    return realOpen(...args);
  });

  assert.equal(
    await withStateTransactionLock(data.file, async () => 'kept', { timeoutMs: 100, pollMs: 1 }),
    'kept',
  );
  assert.equal(createAttempts, 2);
  await assert.rejects(fs.access(await lockFileFor(data.file)), { code: 'ENOENT' });
});

test('a persistent Windows create denial remains an honest bounded failure', async t => {
  if (process.platform !== 'win32') return t.skip('Windows-specific exclusive-create behavior');
  const data = await fixture(t);
  const realOpen = fs.open.bind(fs);
  let createAttempts = 0;
  let operationRan = false;
  t.mock.method(fs, 'open', async (...args) => {
    if (args[1] === 'wx') {
      createAttempts += 1;
      const error = new Error('synthetic persistent create denial');
      error.code = 'EACCES';
      throw error;
    }
    return realOpen(...args);
  });

  await assert.rejects(
    withStateTransactionLock(data.file, async () => { operationRan = true; }, { timeoutMs: 15, pollMs: 2 }),
    error => /could not create the transaction lock/u.test(error?.message)
      && error?.cause?.code === 'EACCES'
      && error?.code === undefined,
  );
  assert.equal(operationRan, false);
  assert.ok(createAttempts > 1);
  await assert.rejects(fs.access(await lockFileFor(data.file)), { code: 'ENOENT' });
});

test('a changed lock token is retained and reported instead of being removed', async t => {
  const data = await fixture(t);
  const lockFile = await lockFileFor(data.file);
  await assert.rejects(
    withStateTransactionLock(data.file, async () => {
      const current = JSON.parse(await fs.readFile(lockFile, 'utf8'));
      await fs.writeFile(lockFile, `${JSON.stringify({ ...current, token: 'replacement-token' })}\n`);
    }),
    /lock (?:payload|token) changed while it was held/,
  );
  assert.match(await fs.readFile(lockFile, 'utf8'), /replacement-token/);
  await fs.rm(lockFile, { force: true });
});

test('work failure is preserved, the owned lock is cleaned, and later work can proceed', async t => {
  const data = await fixture(t);
  const primary = new Error('synthetic state mutation failed');
  await assert.rejects(
    withStateTransactionLock(data.file, async () => { throw primary; }),
    error => error === primary,
  );
  await assert.rejects(fs.access(await lockFileFor(data.file)), { code: 'ENOENT' });
  assert.equal(await withStateTransactionLock(data.file, async () => 7), 7);
});

test('a work failure and a replaced lock are both retained in one aggregate', async t => {
  const data = await fixture(t);
  const lockFile = await lockFileFor(data.file);
  const primary = new Error('primary mutation failure');
  await assert.rejects(
    withStateTransactionLock(data.file, async () => {
      const held = `${lockFile}.held`;
      try {
        await fs.rename(lockFile, held);
        await fs.writeFile(lockFile, '{}\n', { flag: 'wx' });
      } catch (error) {
        if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
        await fs.writeFile(lockFile, '{}\n');
      }
      throw primary;
    }),
    error => error instanceof AggregateError
      && error.errors.includes(primary)
      && error.errors.some(item => /lock (?:path was replaced|payload changed|token changed)/.test(item.message)),
  );
  await fs.rm(lockFile, { force: true });
  await fs.rm(`${lockFile}.held`, { force: true });
});

test('requested I/O paths retain aliases while lock identity serializes aliases', async t => {
  const data = await fixture(t);
  let aliasDirectory = path.resolve(data.directory);
  let targetDirectory = await fs.realpath(aliasDirectory);
  if (aliasDirectory === targetDirectory) {
    targetDirectory = path.join(data.directory, 'target');
    aliasDirectory = path.join(data.directory, 'alias');
    await fs.mkdir(targetDirectory);
    try { await fs.symlink(targetDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (!['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
      t.diagnostic(`directory links are unavailable: ${error.code}`);
    }
  }
  if (await fs.lstat(aliasDirectory).then(() => true, () => false)) {
    const aliasFile = path.join(aliasDirectory, 'state.json');
    const targetFile = path.join(targetDirectory, 'state.json');
    assert.equal(await canonicalStateFile(aliasFile), path.resolve(aliasFile));
    assert.equal(await canonicalStateFile(targetFile), path.resolve(targetFile));
    assert.equal(await lockFileFor(aliasFile), await lockFileFor(targetFile));

    const order = [];
    let enteredFirst;
    let releaseFirst;
    const entered = new Promise(resolve => { enteredFirst = resolve; });
    const first = withStateTransactionLock(aliasFile, async requested => {
      assert.equal(requested, path.resolve(aliasFile));
      order.push('alias-enter');
      enteredFirst();
      await new Promise(resolve => { releaseFirst = resolve; });
      order.push('alias-leave');
    }, { timeoutMs: 500, pollMs: 5 });
    await entered;
    const second = withStateTransactionLock(targetFile, async requested => {
      assert.equal(requested, path.resolve(targetFile));
      order.push('target-enter');
    }, { timeoutMs: 500, pollMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(order, ['alias-enter']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['alias-enter', 'alias-leave', 'target-enter']);
  }

  const directoryPath = path.join(data.directory, 'not-a-file');
  await fs.mkdir(directoryPath);
  await assert.rejects(
    canonicalStateFile(directoryPath),
    error => /existing state path must be a regular file/.test(error.message)
      && !error.message.includes(data.directory),
  );
  const targetFile = path.join(data.directory, 'target-state.json');
  const linkedFile = path.join(data.directory, 'linked-state.json');
  await fs.writeFile(targetFile, '{}\n');
  try {
    await fs.symlink(targetFile, linkedFile, 'file');
    await assert.rejects(canonicalStateFile(linkedFile), /existing state path must be a regular file/);
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
    t.diagnostic(`file links are unavailable: ${error.code}`);
  }
  await assert.rejects(canonicalStateFile('relative.json'), /file must be an absolute path/);
  await assert.rejects(
    withStateTransactionLock(data.file, async () => {}, { timeoutMs: 10, pollMs: 11 }),
    /pollMs cannot exceed options.timeoutMs/,
  );
});

test('the state path is rechecked after waiting for the transaction lock', async t => {
  const data = await fixture(t);
  let releaseFirst;
  let enteredFirst;
  const entered = new Promise(resolve => { enteredFirst = resolve; });
  const first = withStateTransactionLock(data.file, async () => {
    enteredFirst();
    await new Promise(resolve => { releaseFirst = resolve; });
    await fs.mkdir(data.file);
  }, { timeoutMs: 500, pollMs: 5 });
  await entered;
  let secondRan = false;
  const second = withStateTransactionLock(data.file, async () => { secondRan = true; }, { timeoutMs: 500, pollMs: 5 });
  const refused = assert.rejects(
    second,
    error => /existing state path must be a regular file/.test(error.message)
      && !error.message.includes(data.directory),
  );
  releaseFirst();
  await first;
  await refused;
  assert.equal(secondRan, false);
  await assert.rejects(fs.access(await lockFileFor(data.file)), { code: 'ENOENT' });
});
