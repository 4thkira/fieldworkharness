import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonlEventLog, createMemoryEventLog, EMPTY_EVENT_HASH, verifyEventChain } from '../src/event-log.mjs';

const clock = () => new Date('2030-01-02T03:04:05.000Z');

test('memory events form an immutable append-only hash chain and snapshot input data', async () => {
  const log = createMemoryEventLog({ runId: 'synthetic-run', clock });
  const data = { value: { count: 1 } };
  const first = await log.append('run_started', data);
  data.value.count = 9;
  const second = await log.append('run_finished', { ok: true });
  const events = await log.read();
  assert.equal(events[0].data.value.count, 1);
  assert.equal(first.previous, EMPTY_EVENT_HASH);
  assert.equal(second.previous, first.hash);
  assert.equal(Object.isFrozen(events[0].data.value), true);
  assert.throws(() => { events[0].data.value.count = 3; }, TypeError);
  assert.deepEqual(verifyEventChain(events), await log.receipt());
  await log.close();
  await assert.rejects(log.append('too_late', {}), /after close/);
});

test('concurrent appends serialize without gaps', async () => {
  let tick = 0;
  const log = createMemoryEventLog({ runId: 'ordered', clock: () => tick++ });
  await Promise.all([
    log.append('one', { n: 1 }),
    log.append('two', { n: 2 }),
    log.append('three', { n: 3 }),
  ]);
  const events = await log.read();
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  assert.deepEqual(events.map(event => event.type), ['one', 'two', 'three']);
  verifyEventChain(events);
});

test('a JSONL log exclusively creates, syncs, and never rewrites its file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-events-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'run.jsonl');
  const log = await createJsonlEventLog(file, { runId: 'disk-run', clock });
  await log.append('run_started', { synthetic: true });
  await log.append('run_finished', { answer: 'done' });
  const receipt = await log.receipt();
  await log.close();
  const events = (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(verifyEventChain(events, { expectedRunId: 'disk-run', expectedHead: receipt.head }), receipt);
  await assert.rejects(createJsonlEventLog(file, { runId: 'replacement' }), /could not create a new log file/);
});

test('tampering, truncation against a known head, malformed data and invalid clocks are refused', async () => {
  const log = createMemoryEventLog({ runId: 'tamper-test', clock });
  await log.append('one', { value: 1 });
  await log.append('two', { value: 2 });
  const events = await log.read();
  const altered = structuredClone(events);
  altered[0].data.value = 7;
  assert.throws(() => verifyEventChain(altered), /hash does not match/);
  const invalidType = structuredClone(events);
  invalidType[0].type = 'Bad Type';
  assert.throws(() => verifyEventChain(invalidType), /invalid type/);
  const invalidTime = structuredClone(events);
  invalidTime[0].at = 'tomorrow-ish';
  assert.throws(() => verifyEventChain(invalidTime), /invalid timestamp/);
  assert.throws(() => verifyEventChain(events.slice(0, 1), { expectedHead: events.at(-1).hash }), /head does not match/);
  await assert.rejects(log.append('Bad Type', {}), /invalid event type/);
  await assert.rejects(log.append('bad_data', { value: undefined }), /JSON cannot represent/);
  const badClock = createMemoryEventLog({ runId: 'bad-clock', clock: () => 'not a date' });
  await assert.rejects(badClock.append('one', {}), /invalid time/);
});

test('invalid disk-log options are refused before a file is created', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-events-options-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'run.jsonl');
  await assert.rejects(createJsonlEventLog(file, { runId: '../bad' }), /runId/);
  await assert.rejects(createJsonlEventLog(file, { clock: null }), /clock must be a function/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
