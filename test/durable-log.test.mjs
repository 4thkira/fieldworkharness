import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDurableLog } from '../src/durable-log.mjs';

const format = 'fieldwork-synthetic-log/v1';
const clock = () => new Date('2030-01-02T03:04:05.000Z');

async function temporary(t, name = 'events.jsonl') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-durable-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

test('a durable log creates one genesis, reopens, verifies and continues the same hash chain', async t => {
  const file = await temporary(t);
  const created = await openDurableLog(file, {
    create: true, format, idField: 'ledgerId', id: 'synthetic-ledger',
    initial: { type: 'ledger_created', data: { schema: 'synthetic/v1' } }, clock,
  });
  const first = await created.receipt();
  assert.equal(first.events, 1);
  const appended = await created.append('item_added', { value: 1 });
  assert.equal(appended.sequence, 2);
  const head = (await created.receipt()).head;
  await created.close();
  assert.equal(await fs.stat(`${file}.lock`).catch(error => error.code), 'ENOENT');

  const reopened = await openDurableLog(file, {
    format, idField: 'ledgerId', expectedId: 'synthetic-ledger', expectedHead: head,
    replay: { create: () => [], apply: (state, event) => { state.push([event.sequence, event.type]); } }, clock,
  });
  assert.deepEqual(reopened.replayState, [[1, 'ledger_created'], [2, 'item_added']]);
  const third = await reopened.append('item_added', { value: 2 });
  assert.equal(third.sequence, 3);
  assert.equal(third.previous, head);
  await reopened.close();
});

test('verified event reads serialize with appends and bind the event to the current head', async t => {
  const file = await temporary(t);
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'reader',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  const pendingAppend = log.append('item_added', { value: 7 });
  const pendingRead = log.readEvent(2);
  const [appended, read] = await Promise.all([pendingAppend, pendingRead]);
  assert.equal(read.event.hash, appended.hash);
  assert.equal(read.event.data.value, 7);
  assert.equal(read.receipt.events, 2);
  assert.equal(read.receipt.head, appended.hash);
  assert.equal(read.receipt.streamId, 'reader');

  const missing = await log.readEvent(99);
  assert.equal(missing.event, null);
  assert.equal(missing.receipt.head, appended.hash);
  await assert.rejects(log.readEvent(0), /positive whole number/);
  await log.close();
  await assert.rejects(log.readEvent(1), /after close has begun/);
});

test('a verified live read detects same-size external mutation and poisons later reads', async t => {
  const file = await temporary(t);
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'live-tamper',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  const original = await fs.readFile(file, 'utf8');
  const changed = original.replace('stream_created', 'stream_mutated');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
  await fs.writeFile(file, changed, 'utf8');
  await assert.rejects(log.readEvent(1), /hash does not match|invalid event/);
  await assert.rejects(log.receipt(), /hash does not match|invalid event/);
  await assert.rejects(log.close(), /hash does not match|invalid event/);
});

test('the cooperating writer lock prevents two open writers', async t => {
  const file = await temporary(t);
  const first = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'one',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', expectedId: 'one', clock,
  }), /writer lock already exists/);
  await first.close();
});

test('tampering, a wrong independent head and duplicate keys are refused on reopen', async t => {
  const file = await temporary(t);
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'tamper',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  await log.append('item_added', { value: 1 });
  const receipt = await log.receipt();
  await log.close();

  await assert.rejects(openDurableLog(file, {
    format: 'fieldwork-synthetic-log/v2', idField: 'streamId', clock,
  }), /has format "fieldwork-synthetic-log\/v1" instead of fieldwork-synthetic-log\/v2/);

  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', expectedHead: 'f'.repeat(64), clock,
  }), /head does not match/);

  const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
  const second = JSON.parse(lines[1]);
  second.data.value = 9;
  lines[1] = JSON.stringify(second);
  await fs.writeFile(file, `${lines.join('\n')}\n`);
  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', expectedHead: receipt.head, clock,
  }), /hash does not match/);

  const duplicate = lines[0].replace('"sequence":1', '"sequence":1,"sequence":1');
  await fs.writeFile(file, `${duplicate}\n`);
  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', clock,
  }), /repeats object key "sequence"/);
});

test('an incomplete final line is never silently truncated or accepted', async t => {
  const file = await temporary(t);
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'torn',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  await log.close();
  await fs.appendFile(file, '{"partial":true}', 'utf8');
  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', clock,
  }), /incomplete line/);
  assert.match(await fs.readFile(file, 'utf8'), /\{"partial":true\}$/);
});

test('invalid creation options fail before a file or lock is created', async t => {
  const file = await temporary(t);
  await assert.rejects(openDurableLog(file, {
    create: true, format, idField: 'streamId', id: '../bad',
    initial: { type: 'stream_created', data: {} }, clock,
  }), /streamId must be/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${file}.lock`), { code: 'ENOENT' });

  for (const [name, extra, pattern] of [
    ['expected-id.jsonl', { expectedId: 'old-stream' }, /expectedId is only accepted while opening/],
    ['expected-head.jsonl', { expectedHead: 'not-even-a-hash' }, /expectedHead is only accepted while opening/],
  ]) {
    const incompatible = await temporary(t, name);
    await assert.rejects(openDurableLog(incompatible, {
      create: true, format, idField: 'streamId', id: 'new-stream',
      initial: { type: 'stream_created', data: {} }, clock, ...extra,
    }), pattern);
    await assert.rejects(fs.stat(incompatible), { code: 'ENOENT' });
    await assert.rejects(fs.stat(`${incompatible}.lock`), { code: 'ENOENT' });
  }
});

test('a definitely unwritten append rejection leaves the live log usable', async t => {
  const file = await temporary(t);
  let clockCalls = 0;
  const intermittentClock = () => {
    clockCalls++;
    if (clockCalls === 2) throw new Error('synthetic append clock failure');
    return new Date('2030-01-02T03:04:05.000Z');
  };
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'retryable',
    initial: { type: 'stream_created', data: {} }, clock: intermittentClock,
  });
  let failure;
  try { await log.append('item_added', { value: 1 }); }
  catch (error) { failure = error; }
  assert.equal(failure.commitStatus, 'not-written');
  assert.match(failure.message, /synthetic append clock failure/);
  assert.equal((await log.receipt()).events, 1);
  const appended = await log.append('item_added', { value: 2 });
  assert.equal(appended.sequence, 2);
  assert.equal((await log.readEvent(2)).event.data.value, 2);
  await log.close();
});

test('invalid genesis data and clocks fail before creating a file or lock', async t => {
  const accessorFile = await temporary(t, 'accessor-genesis.jsonl');
  let reads = 0;
  const data = {};
  Object.defineProperty(data, 'value', {
    enumerable: true,
    get() { reads++; return 1; },
  });
  await assert.rejects(openDurableLog(accessorFile, {
    create: true, format, idField: 'streamId', id: 'accessor-genesis',
    initial: { type: 'stream_created', data }, clock,
  }), /must be an enumerable data property/);
  assert.equal(reads, 0);
  await assert.rejects(fs.stat(accessorFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${accessorFile}.lock`), { code: 'ENOENT' });

  const clockFile = await temporary(t, 'clock-genesis.jsonl');
  await assert.rejects(openDurableLog(clockFile, {
    create: true, format, idField: 'streamId', id: 'clock-genesis',
    initial: { type: 'stream_created', data: {} },
    clock() { throw new Error('synthetic clock failure'); },
  }), /clock failed: synthetic clock failure/);
  await assert.rejects(fs.stat(clockFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${clockFile}.lock`), { code: 'ENOENT' });
});

test('reserved event fields cannot be used as the stream ID field', async t => {
  for (const idField of ['format', 'sequence', 'at', 'type', 'data', 'previous', 'hash']) {
    const file = await temporary(t, `${idField}.jsonl`);
    await assert.rejects(openDurableLog(file, {
      create: true, format, idField, id: 'synthetic',
      initial: { type: 'stream_created', data: {} }, clock,
    }), /collides with a reserved event field/);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  }
});

test('replay is bounded early and begins only after the independent head verifies', async t => {
  const file = await temporary(t);
  const created = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'bounded',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  await created.append('item_added', { value: 1 });
  await created.close();

  const effects = [];
  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', expectedHead: 'f'.repeat(64),
    replay: { create: () => [], apply: (_state, event) => { effects.push(event.sequence); } }, clock,
  }), /head does not match/);
  assert.deepEqual(effects, []);

  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', maxEvents: 1, clock,
  }), /more than 1 events/);
});

test('replay reducers must be synchronous and option accessors are never invoked', async t => {
  const file = await temporary(t);
  const created = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'replay',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  await created.close();
  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', replay: { create: () => ({}), apply: async () => {} }, clock,
  }), /must be synchronous/);

  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'format', { enumerable: true, get() { reads++; return format; } });
  await assert.rejects(openDurableLog('', options), /file must be a nonempty path/);
  assert.equal(reads, 0);
  const unopened = await temporary(t, 'accessor.jsonl');
  await assert.rejects(openDurableLog(unopened, options), /must be an enumerable data property/);
  assert.equal(reads, 0);
});

test('a complete write followed by sync failure reports an unknown commit and reconciles against the prior head', async t => {
  const file = await temporary(t);
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'ambiguous',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  const prior = await log.receipt();
  const probe = await fs.open(`${file}.probe`, 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  prototype.sync = async function syntheticPostSyncFailure() {
    await originalSync.call(this);
    throw new Error('synthetic failure after sync');
  };
  let failure;
  try {
    await log.append('item_added', { value: 1 });
  } catch (error) {
    failure = error;
  } finally {
    prototype.sync = originalSync;
  }
  assert.equal(failure.commitStatus, 'unknown');
  assert.equal(failure.prior.head, prior.head);
  assert.equal(failure.candidate.previous, prior.head);
  await assert.rejects(log.receipt(), /outcome is unknown/);
  await assert.rejects(log.close(), /outcome is unknown/);

  await assert.rejects(openDurableLog(file, {
    format, idField: 'streamId', expectedHead: prior.head, clock,
  }), /head does not match/);
  const reconciled = await openDurableLog(file, { format, idField: 'streamId', clock });
  const after = await reconciled.receipt();
  assert.equal(after.events, prior.events + 1);
  assert.equal(after.head, failure.candidate.hash);
  await reconciled.close();
});

test('receipts expose the selected crash-durability policy', async t => {
  const file = await temporary(t);
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'unsynced', sync: false,
    initial: { type: 'stream_created', data: {} }, clock,
  });
  const receipt = await log.receipt();
  assert.equal(receipt.durability.fileSync, false);
  assert.equal(typeof receipt.durability.directorySync, 'boolean');
  if (process.platform === 'win32') assert.equal(receipt.durability.directorySync, false);
  assert.equal(receipt.durability.writerLock, 'cooperative-path');
  await log.close();
});

test('a post-close receipt includes lock-removal directory-sync failure', {
  skip: process.platform === 'win32' ? 'Windows does not expose directory fsync through Node' : false,
}, async t => {
  const file = await temporary(t);
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'close-directory-sync',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  const before = await log.receipt();
  if (!before.durability.directorySync) {
    t.skip('This filesystem does not support directory fsync');
    await log.close();
    return;
  }

  const probe = await fs.open(`${file}.probe`, 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  prototype.sync = async function syntheticDirectorySyncFailure() {
    throw new Error('synthetic directory sync failure');
  };
  try { await log.close(); }
  finally { prototype.sync = originalSync; }

  const after = await log.receipt();
  assert.equal(after.durability.directorySync, false);
});

test('a directory-handle close failure also lowers the post-close durability receipt', {
  skip: process.platform === 'win32' ? 'Windows does not expose directory fsync through Node' : false,
}, async t => {
  const file = await temporary(t);
  const log = await openDurableLog(file, {
    create: true, format, idField: 'streamId', id: 'directory-close',
    initial: { type: 'stream_created', data: {} }, clock,
  });
  const before = await log.receipt();
  if (!before.durability.directorySync) {
    t.skip('This filesystem does not support directory fsync');
    await log.close();
    return;
  }

  // Modern Node releases install close directly on each FileHandle rather than
  // on a shared prototype. Wrap the exact directory handle opened while the
  // log closes so the synthetic failure exercises syncDirectory itself.
  const originalOpen = fs.open;
  const expectedDirectory = path.dirname(path.resolve(file));
  let wrapped = 0;
  fs.open = async function openWithSyntheticDirectoryCloseFailure(...args) {
    const handle = await Reflect.apply(originalOpen, fs, args);
    if (typeof args[0] !== 'string' || path.resolve(args[0]) !== expectedDirectory) return handle;
    wrapped += 1;
    const originalClose = handle.close;
    handle.close = async function syntheticDirectoryCloseFailure() {
      await originalClose.call(this);
      throw new Error('synthetic directory handle close failure');
    };
    return handle;
  };
  try { await log.close(); }
  finally { fs.open = originalOpen; }

  const after = await log.receipt();
  assert.equal(wrapped, 1);
  assert.equal(after.durability.directorySync, false);
});
