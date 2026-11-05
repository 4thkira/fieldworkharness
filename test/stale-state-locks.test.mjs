import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STATE_TRANSACTION_LOCK_FORMAT } from '../src/cooperative-state-lock.mjs';
import { canonicalJson } from '../src/json-data.mjs';
import {
  DURABLE_WRITER_LOCK_FORMAT,
  KNOWN_STATE_LOCKS,
  STATE_LOCK_RECOVERY_GUARD_FORMAT,
  recoverAbandonedStateLock,
  stateLockAdvice,
} from '../src/stale-state-locks.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-stale-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function lockSource(format, {
  token = randomUUID(),
  pid = 41_001,
  createdAt = '2030-01-02T03:04:05.000Z',
  extra = {},
} = {}) {
  return `${canonicalJson({ format, token, pid, createdAt, ...extra })}\n`;
}

async function writeLock(file, format, options) {
  const source = lockSource(format, options);
  await fs.writeFile(file, source, { encoding: 'utf8', flag: 'wx' });
  return source;
}

async function missing(file) {
  return fs.access(file).then(() => false, error => error?.code === 'ENOENT');
}

test('guarded recovery removes verified dead locks in both formats without changing adjacent state', async t => {
  const directory = await fixture(t);
  for (const [name, format] of [
    ['memory.jsonl.lock', DURABLE_WRITER_LOCK_FORMAT],
    ['check-ins.json.lock', STATE_TRANSACTION_LOCK_FORMAT],
  ]) {
    const file = path.join(directory, name);
    const stateFile = file.slice(0, -'.lock'.length);
    const state = `synthetic state beside ${name}\n`;
    await fs.writeFile(stateFile, state);
    await writeLock(file, format);
    const result = await recoverAbandonedStateLock(file, format, { processStatus: () => 'dead' });
    assert.deepEqual(result, { file, status: 'recovered', pid: 41_001, format });
    assert.equal(await fs.readFile(stateFile, 'utf8'), state);
    assert.equal(await missing(file), true);
    assert.equal(await missing(`${file}.recovery`), true);
    assert.equal((await fs.readdir(directory)).some(entry => entry.startsWith(`${name}.recovered-`)), false);
  }
});

test('live and uncertain owners remain byte-for-byte untouched', async t => {
  const directory = await fixture(t);
  const liveFile = path.join(directory, 'memory.jsonl.lock');
  const liveSource = await writeLock(liveFile, DURABLE_WRITER_LOCK_FORMAT, { pid: process.pid });
  const live = await recoverAbandonedStateLock(liveFile, DURABLE_WRITER_LOCK_FORMAT);
  assert.deepEqual(live, {
    file: liveFile, status: 'retained', reason: 'live-process',
    pid: process.pid, format: DURABLE_WRITER_LOCK_FORMAT,
  });
  assert.equal(await fs.readFile(liveFile, 'utf8'), liveSource);

  const unknownFile = path.join(directory, 'check-ins.json.lock');
  const unknownSource = await writeLock(unknownFile, STATE_TRANSACTION_LOCK_FORMAT, { pid: 41_002 });
  const unknown = await recoverAbandonedStateLock(unknownFile, STATE_TRANSACTION_LOCK_FORMAT, {
    processStatus: () => 'unknown',
  });
  assert.deepEqual(unknown, {
    file: unknownFile, status: 'retained', reason: 'unknown-process',
    pid: 41_002, format: STATE_TRANSACTION_LOCK_FORMAT,
  });
  assert.equal(await fs.readFile(unknownFile, 'utf8'), unknownSource);
});

test('malformed, unknown and noncanonical metadata is preserved without probing a PID', async t => {
  const directory = await fixture(t);
  const malformed = [
    'not json\n',
    `${canonicalJson({ format: DURABLE_WRITER_LOCK_FORMAT, token: randomUUID(), pid: 41_003, createdAt: 'not-a-date' })}\n`,
    `${canonicalJson({ format: DURABLE_WRITER_LOCK_FORMAT, token: 'not-a-token', pid: 41_003, createdAt: '2030-01-02T03:04:05.000Z' })}\n`,
    `${canonicalJson({ format: DURABLE_WRITER_LOCK_FORMAT, token: randomUUID(), pid: 0, createdAt: '2030-01-02T03:04:05.000Z' })}\n`,
    lockSource(DURABLE_WRITER_LOCK_FORMAT, { extra: { surprise: true } }),
    `${JSON.stringify({ format: DURABLE_WRITER_LOCK_FORMAT, token: randomUUID(), pid: 41_003, createdAt: '2030-01-02T03:04:05.000Z' })}\n`,
  ];
  for (let index = 0; index < malformed.length; index++) {
    const file = path.join(directory, `bad-${index}.lock`);
    await fs.writeFile(file, malformed[index]);
    const result = await recoverAbandonedStateLock(file, DURABLE_WRITER_LOCK_FORMAT, {
      processStatus: () => assert.fail('unsafe metadata must not reach the process probe'),
    });
    assert.deepEqual(result, { file, status: 'retained', reason: 'invalid-metadata' });
    assert.equal(await fs.readFile(file, 'utf8'), malformed[index]);
  }
});

test('a lock symlink is preserved and its target is never removed', async t => {
  const directory = await fixture(t);
  const target = path.join(directory, 'target.lock');
  const file = path.join(directory, 'memory.jsonl.lock');
  const source = await writeLock(target, DURABLE_WRITER_LOCK_FORMAT);
  try { await fs.symlink(target, file, 'file'); }
  catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) throw error;
    t.diagnostic(`file symlinks are unavailable: ${error.code}`);
    return;
  }
  const result = await recoverAbandonedStateLock(file, DURABLE_WRITER_LOCK_FORMAT, {
    processStatus: () => assert.fail('a symlink must not reach the process probe'),
  });
  assert.deepEqual(result, { file, status: 'retained', reason: 'not-regular' });
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), source);
});

test('a replacement installed after validation survives the final identity and payload recheck', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'memory.jsonl.lock');
  const held = `${file}.old`;
  const original = await writeLock(file, DURABLE_WRITER_LOCK_FORMAT, { pid: 41_004 });
  let replacement;
  const result = await recoverAbandonedStateLock(file, DURABLE_WRITER_LOCK_FORMAT, {
    processStatus: () => 'dead',
    async onPhase(event) {
      if (event.phase !== 'validated') return;
      await fs.rename(file, held);
      replacement = await writeLock(file, DURABLE_WRITER_LOCK_FORMAT, { pid: process.pid });
    },
  });
  assert.deepEqual(result, {
    file, status: 'retained', reason: 'changed',
    pid: 41_004, format: DURABLE_WRITER_LOCK_FORMAT,
  });
  assert.equal(await fs.readFile(file, 'utf8'), replacement);
  assert.equal(await fs.readFile(held, 'utf8'), original);
});

test('quarantine cleanup cannot remove a fresh incumbent at the original lock path', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'check-ins.json.lock');
  await writeLock(file, STATE_TRANSACTION_LOCK_FORMAT, { pid: 41_005 });
  let incumbent;
  let quarantineFile;
  const result = await recoverAbandonedStateLock(file, STATE_TRANSACTION_LOCK_FORMAT, {
    processStatus: () => 'dead',
    async onPhase(event) {
      if (event.phase !== 'quarantined') return;
      quarantineFile = event.quarantineFile;
      incumbent = await writeLock(file, STATE_TRANSACTION_LOCK_FORMAT, { pid: process.pid });
    },
  });
  assert.equal(result.status, 'recovered');
  assert.equal(await fs.readFile(file, 'utf8'), incumbent);
  assert.equal(await missing(quarantineFile), true);
});

test('the recovery guard serializes competing recoverers', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'outside-readers.json.lock');
  const source = await writeLock(file, STATE_TRANSACTION_LOCK_FORMAT, { pid: 41_006 });
  let enterProbe;
  let releaseProbe;
  const entered = new Promise(resolve => { enterProbe = resolve; });
  const released = new Promise(resolve => { releaseProbe = resolve; });
  const first = recoverAbandonedStateLock(file, STATE_TRANSACTION_LOCK_FORMAT, {
    async processStatus() {
      enterProbe();
      await released;
      return 'dead';
    },
  });
  await entered;
  const second = await recoverAbandonedStateLock(file, STATE_TRANSACTION_LOCK_FORMAT, {
    processStatus: () => 'dead',
  });
  assert.deepEqual(second, { file, status: 'retained', reason: 'recovery-busy' });
  assert.equal(await fs.readFile(file, 'utf8'), source);
  releaseProbe();
  assert.equal((await first).status, 'recovered');
  assert.equal(await missing(file), true);
  assert.equal(await missing(`${file}.recovery`), true);
});

test('a replaced or changed recovery guard is retained instead of unlinked', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'task-heartbeats.json.lock');
  await writeLock(file, STATE_TRANSACTION_LOCK_FORMAT, { pid: 41_007 });
  let replacement;
  let heldGuard = null;
  await assert.rejects(
    recoverAbandonedStateLock(file, STATE_TRANSACTION_LOCK_FORMAT, {
      processStatus: () => 'dead',
      async onPhase(event) {
        if (event.phase !== 'quarantined') return;
        replacement = lockSource(STATE_LOCK_RECOVERY_GUARD_FORMAT, { pid: process.pid });
        heldGuard = `${event.guardFile}.held`;
        try {
          await fs.rename(event.guardFile, heldGuard);
          await fs.writeFile(event.guardFile, replacement, { flag: 'wx' });
        } catch (error) {
          if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
          heldGuard = null;
          await fs.writeFile(event.guardFile, replacement);
        }
      },
    }),
    /recovery guard (?:path was replaced|payload changed|token changed)/,
  );
  assert.equal(await fs.readFile(`${file}.recovery`, 'utf8'), replacement);
  if (heldGuard) assert.equal((await fs.stat(heldGuard)).isFile(), true);
  assert.equal(await missing(file), true);
});

test('the launcher recovery catalogue covers every durable and queued state lock', () => {
  assert.deepEqual(KNOWN_STATE_LOCKS, [
    ...['memory.jsonl.lock', 'conversation.jsonl.lock', 'reply-context.jsonl.lock', 'external-delivery.jsonl.lock', 'tool-effects.jsonl.lock']
      .map(name => ({ name, format: DURABLE_WRITER_LOCK_FORMAT })),
    ...['check-ins.json.lock', 'task-heartbeats.json.lock', 'outside-readers.json.lock']
      .map(name => ({ name, format: STATE_TRANSACTION_LOCK_FORMAT })),
  ]);
});

test('lock advice names unsafe files and recovery guards without leaking their payloads', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'check-ins.json.lock');
  const guardFile = `${file}.recovery`;
  const lockSecret = 'malformed-lock-secret-must-not-leak';
  const guardSecret = 'recovery-guard-secret-must-not-leak';
  await fs.writeFile(file, `${lockSecret}\n`);
  await fs.writeFile(guardFile, `${guardSecret}\n`);
  const advice = await stateLockAdvice(directory);
  assert.ok(advice.includes(file));
  assert.ok(advice.includes(guardFile));
  assert.match(advice, /could not be verified as a Fieldwork lock and was preserved/);
  assert.match(advice, /another launcher may be cleaning up, or an earlier cleanup was interrupted/);
  assert.match(advice, /every Fieldwork room and launcher is stopped/);
  assert.doesNotMatch(advice, new RegExp(`${lockSecret}|${guardSecret}`));
});
