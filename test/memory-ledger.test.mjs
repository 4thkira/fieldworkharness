import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createMemoryLedger, isMemoryLedger, openMemoryLedger, readLiveMemoryLedgerReceipt,
  MEMORY_LEDGER_ACTION_FORMAT, MEMORY_LEDGER_EVENT_FORMAT, MEMORY_LEDGER_SNAPSHOT_FORMAT,
} from '../src/memory-ledger.mjs';
import { openDurableLog } from '../src/durable-log.mjs';
import { createMemoryRecord, isMemoryRecord } from '../src/provenance.mjs';

const at = '2030-01-02T03:04:05.000Z';
const clock = () => new Date(at);
const agent = { kind: 'agent', id: 'synthetic-agent' };
const operator = { kind: 'operator', id: 'synthetic-operator' };

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-memory-ledger-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'memory.jsonl');
}

function memory(text, id = 'memory:preference') {
  return createMemoryRecord({
    id, kind: 'authored-memory', text, author: agent, createdAt: at,
    basis: 'self-authored', confidence: 'asserted',
  });
}

test('a ledger survives restart with brands, current state and provenance intact', async t => {
  const file = await temporary(t);
  const first = memory('I prefer the first synthetic option.');
  const ledger = await createMemoryLedger(file, { ledgerId: 'synthetic-ledger', clock });
  assert.equal(isMemoryLedger(ledger), true);
  await ledger.record(first);
  const before = await ledger.snapshot();
  assert.equal(before.format, MEMORY_LEDGER_SNAPSHOT_FORMAT);
  assert.deepEqual(before.active.map(record => record.fingerprint), [first.fingerprint]);
  const head = before.receipt.head;
  await ledger.close();
  const finalReceipt = await ledger.receipt();
  assert.equal(finalReceipt.head, head);
  assert.equal(typeof finalReceipt.durability.directorySync, 'boolean');
  await assert.rejects(readLiveMemoryLedgerReceipt(ledger), /after close has begun/);

  const reopened = await openMemoryLedger(file, {
    expectedLedgerId: 'synthetic-ledger', expectedHead: head, clock,
  });
  const restored = await reopened.get(first.id);
  assert.equal(restored.active, true);
  assert.equal(restored.currentFingerprint, first.fingerprint);
  assert.equal(isMemoryRecord(restored.current), true);
  assert.equal(restored.current.text, first.text);
  await reopened.close();
});

test('supersede, retract and restore are attributed conflict-checked reversible events', async t => {
  const file = await temporary(t);
  const first = memory('First revision.');
  const second = memory('Second revision.');
  const ledger = await createMemoryLedger(file, { ledgerId: 'revision-ledger', clock });
  await ledger.record(first);
  let view = await ledger.supersede({
    id: first.id, expectedFingerprint: first.fingerprint, expectedSequence: 2, replacement: second,
    actor: agent, reason: 'The preference changed in a synthetic test.',
  });
  assert.equal(view.currentFingerprint, second.fingerprint);
  assert.equal(view.revisions.length, 2);
  await assert.rejects(ledger.retract({
    id: first.id, expectedFingerprint: first.fingerprint, expectedSequence: 2, actor: operator, reason: 'Stale edit.',
  }), /conflict: memory .* is at/);

  view = await ledger.retract({
    id: first.id, expectedFingerprint: second.fingerprint, expectedSequence: 3, actor: operator, reason: 'Withdraw the current claim.',
  });
  assert.equal(view.active, false);
  view = await ledger.restore({
    id: first.id, expectedFingerprint: second.fingerprint, expectedSequence: 4, targetFingerprint: first.fingerprint,
    actor: agent, reason: 'Restore the earlier revision for review.',
  });
  assert.equal(view.active, true);
  assert.equal(view.currentFingerprint, first.fingerprint);
  assert.equal(view.current.text, 'First revision.');
  const receipt = await ledger.receipt();
  assert.equal(receipt.events, 5);
  await ledger.close();

  const reopened = await openMemoryLedger(file, { expectedHead: receipt.head, clock });
  const afterRestart = await reopened.get(first.id);
  assert.equal(afterRestart.currentFingerprint, first.fingerprint);
  assert.equal(afterRestart.revisions.length, 2);
  assert.equal(afterRestart.active, true);
  await reopened.close();
});

test('concurrent stale revisions serialize so only one can win', async t => {
  const file = await temporary(t);
  const original = memory('Original revision.');
  const left = memory('Left revision.');
  const right = memory('Right revision.');
  const ledger = await createMemoryLedger(file, { ledgerId: 'concurrent-ledger', clock });
  await ledger.record(original);
  const attempts = await Promise.allSettled([
    ledger.supersede({ id: original.id, expectedFingerprint: original.fingerprint, expectedSequence: 2, replacement: left, actor: agent, reason: 'Left.' }),
    ledger.supersede({ id: original.id, expectedFingerprint: original.fingerprint, expectedSequence: 2, replacement: right, actor: agent, reason: 'Right.' }),
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const view = await ledger.get(original.id);
  assert.equal(view.revisions.length, 2);
  assert.ok([left.fingerprint, right.fingerprint].includes(view.currentFingerprint));
  await ledger.close();
});

test('duplicate IDs, forged records, malformed attribution and impossible restores are refused before append', async t => {
  const file = await temporary(t);
  const original = memory('Original revision.');
  const ledger = await createMemoryLedger(file, { ledgerId: 'refusal-ledger', clock });
  await ledger.record(original);
  const before = await ledger.receipt();
  await assert.rejects(ledger.record(memory('Duplicate logical ID.')), /already exists/);
  await assert.rejects(ledger.record({ ...memory('Forged.', 'memory:forged') }), /must be created/);
  await assert.rejects(ledger.retract({
    id: original.id, expectedFingerprint: original.fingerprint, expectedSequence: 2,
    actor: { kind: 'unknown', id: 'x' }, reason: 'No.',
  }), /actor.kind/);
  await assert.rejects(ledger.restore({
    id: original.id, expectedFingerprint: original.fingerprint, expectedSequence: 2, targetFingerprint: 'f'.repeat(64),
    actor: agent, reason: 'Impossible.',
  }), /not a revision/);
  assert.equal((await ledger.receipt()).head, before.head);
  await ledger.close();
});

test('active-state transitions advance the conflict token even when content returns to the same revision', async t => {
  const file = await temporary(t);
  const original = memory('Stable content with changing active state.');
  const replacement = memory('A stale writer must not land after state transitions.');
  const ledger = await createMemoryLedger(file, { ledgerId: 'state-token-ledger', clock });
  await ledger.record(original);
  const stale = {
    id: original.id, expectedFingerprint: original.fingerprint, expectedSequence: 2,
    replacement, actor: agent, reason: 'Prepared before retract and restore.',
  };
  await ledger.retract({
    id: original.id, expectedFingerprint: original.fingerprint, expectedSequence: 2,
    actor: operator, reason: 'Temporarily retract.',
  });
  await ledger.restore({
    id: original.id, expectedFingerprint: original.fingerprint, expectedSequence: 3,
    targetFingerprint: original.fingerprint, actor: agent, reason: 'Restore the same content revision.',
  });
  await assert.rejects(ledger.supersede(stale), /last changed at sequence 4, not 2/);
  const view = await ledger.get(original.id);
  assert.equal(view.currentFingerprint, original.fingerprint);
  assert.equal(view.lastSequence, 4);
  await ledger.close();
});

test('a valid hash chain with invalid memory semantics is refused during replay', async t => {
  const file = await temporary(t);
  const raw = await openDurableLog(file, {
    create: true, format: MEMORY_LEDGER_EVENT_FORMAT, idField: 'ledgerId', id: 'invalid-ledger',
    initial: {
      type: 'ledger_created',
      data: { recordFormat: 'fieldwork-memory-record/v1', actionFormat: MEMORY_LEDGER_ACTION_FORMAT },
    },
    clock,
  });
  await raw.append('memory_recorded', { record: { forged: true } });
  await raw.close();
  await assert.rejects(openMemoryLedger(file, { clock }), /memory_recorded record is invalid/);
  assert.equal(await fs.stat(`${file}.lock`).catch(error => error.code), 'ENOENT');
});

test('draft ledgers without the frozen action-schema discriminator are refused', async t => {
  for (const actionFormat of [undefined, 'fieldwork-memory-ledger-actions/v999']) {
    const file = await temporary(t);
    const data = { recordFormat: 'fieldwork-memory-record/v1' };
    if (actionFormat !== undefined) data.actionFormat = actionFormat;
    const draft = await openDurableLog(file, {
      create: true, format: MEMORY_LEDGER_EVENT_FORMAT,
      idField: 'ledgerId', id: `draft-${actionFormat === undefined ? 'missing' : 'unknown'}`,
      initial: { type: 'ledger_created', data }, clock,
    });
    await draft.close();
    await assert.rejects(openMemoryLedger(file, { clock }), new RegExp(`actionFormat must be ${MEMORY_LEDGER_ACTION_FORMAT.replaceAll('/', '\\/')}`));
  }
});

test('ledger option accessors and inherited values are not executed or accepted', async t => {
  const file = await temporary(t);
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'ledgerId', { enumerable: true, get() { reads++; return 'accessor'; } });
  await assert.rejects(createMemoryLedger(file, options), /must be an enumerable data property/);
  assert.equal(reads, 0);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('an ambiguous durable append poisons live reads until restart reconciliation', async t => {
  const file = await temporary(t);
  const ledger = await createMemoryLedger(file, { ledgerId: 'ambiguous-ledger', clock });
  const prior = await ledger.receipt();
  const probe = await fs.open(`${file}.probe`, 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  prototype.sync = async function syntheticPostSyncFailure() {
    await originalSync.call(this);
    throw new Error('synthetic failure after sync');
  };
  const candidate = memory('This event may have committed.', 'memory:ambiguous');
  let failure;
  try { await ledger.record(candidate); }
  catch (error) { failure = error; }
  finally { prototype.sync = originalSync; }
  assert.equal(failure.commitStatus, 'unknown');
  await assert.rejects(ledger.get(candidate.id), /outcome is unknown/);
  await assert.rejects(ledger.snapshot(), /outcome is unknown/);
  await assert.rejects(ledger.close(), /outcome is unknown/);

  await assert.rejects(openMemoryLedger(file, { expectedHead: prior.head, clock }), /head does not match/);
  const reconciled = await openMemoryLedger(file, { clock });
  assert.equal((await reconciled.get(candidate.id)).currentFingerprint, candidate.fingerprint);
  await reconciled.close();
});

test('a definitely unwritten durable rejection does not poison the memory projection', async t => {
  const file = await temporary(t);
  let calls = 0;
  const intermittentClock = () => {
    calls++;
    if (calls === 2) throw new Error('synthetic ledger clock failure');
    return new Date(at);
  };
  const ledger = await createMemoryLedger(file, {
    ledgerId: 'retryable-ledger', clock: intermittentClock,
  });
  const record = memory('Retryable synthetic memory.', 'memory:retryable');
  let failure;
  try { await ledger.record(record); }
  catch (error) { failure = error; }
  assert.equal(failure.commitStatus, 'not-written');
  assert.equal((await ledger.receipt()).events, 1);
  const view = await ledger.record(record);
  assert.equal(view.currentFingerprint, record.fingerprint);
  await ledger.close();
});
