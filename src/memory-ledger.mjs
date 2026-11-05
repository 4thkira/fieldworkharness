import { randomUUID } from 'node:crypto';
import { openDurableLog } from './durable-log.mjs';
import { boundedJson, deepFreeze, isPlainObject } from './json-data.mjs';
import { isMemoryRecord, MEMORY_RECORD_FORMAT, restoreMemoryRecord } from './provenance.mjs';

export const MEMORY_LEDGER_EVENT_FORMAT = 'fieldwork-memory-ledger-event/v1';
export const MEMORY_LEDGER_SNAPSHOT_FORMAT = 'fieldwork-memory-ledger-snapshot/v1';
export const MEMORY_LEDGER_ACTION_FORMAT = 'fieldwork-memory-ledger-actions/v1';
export const MEMORY_LEDGER_RETRIEVAL_VIEW_FORMAT = 'fieldwork-memory-ledger-retrieval-view/v1';

const ledgers = new WeakSet();
const liveReceiptReaders = new WeakMap();
const fingerprintPattern = /^[0-9a-f]{64}$/;
const memoryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function ledgerError(message, cause) {
  return new Error(`Memory ledger: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw ledgerError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw ledgerError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw ledgerError(`${where}.${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function fingerprint(value, where) {
  if (typeof value !== 'string' || !fingerprintPattern.test(value)) throw ledgerError(`${where} must be a lowercase SHA-256 fingerprint`);
  return value;
}

function memoryId(value, where = 'id') {
  if (typeof value !== 'string' || !memoryIdPattern.test(value)) throw ledgerError(`${where} must be 1-128 portable identifier characters`);
  return value;
}

function reason(value) {
  if (typeof value !== 'string' || !value.trim()) throw ledgerError('reason must be nonempty text');
  const characters = [...value].length;
  if (characters > 2000) throw ledgerError(`reason contains ${characters} characters; the limit is 2000`);
  return value;
}

function actor(value) {
  let normalized;
  try { normalized = boundedJson(value, { where: 'actor', object: true, maxBytes: 2048 }).value; }
  catch (error) { throw ledgerError(error.message, error); }
  const raw = fields(normalized, ['kind', 'id'], 'actor');
  if (!['agent', 'operator', 'system', 'model'].includes(raw.kind)) throw ledgerError('actor.kind must be agent, operator, system or model');
  if (typeof raw.id !== 'string' || !raw.id.trim() || [...raw.id].length > 200) throw ledgerError('actor.id must be 1-200 nonblank characters');
  return deepFreeze({ kind: raw.kind, id: raw.id });
}

function restoreRecord(value, where) {
  try { return restoreMemoryRecord(value); }
  catch (error) { throw ledgerError(`${where} is invalid: ${error.message}`, error); }
}

function newState() {
  return { entries: new Map(), sawGenesis: false };
}

function currentEntry(state, id) {
  const entry = state.entries.get(id);
  if (!entry) throw ledgerError(`conflict: memory ${JSON.stringify(id)} does not exist`);
  return entry;
}

function expectCurrent(entry, expected, expectedSequence) {
  fingerprint(expected, 'expectedFingerprint');
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1) throw ledgerError('expectedSequence must be a positive whole number');
  if (entry.currentFingerprint !== expected) {
    throw ledgerError(`conflict: memory ${JSON.stringify(entry.id)} is at ${entry.currentFingerprint}, not ${expected}`);
  }
  if (entry.lastSequence !== expectedSequence) {
    throw ledgerError(`conflict: memory ${JSON.stringify(entry.id)} last changed at sequence ${entry.lastSequence}, not ${expectedSequence}`);
  }
}

function validateGenesis(event, state) {
  if (event.sequence !== 1 || state.sawGenesis) throw ledgerError('ledger_created must be the first and only genesis event');
  const raw = fields(event.data, ['recordFormat', 'actionFormat'], 'ledger_created data');
  if (raw.recordFormat !== MEMORY_RECORD_FORMAT) throw ledgerError(`ledger_created recordFormat must be ${MEMORY_RECORD_FORMAT}`);
  if (raw.actionFormat !== MEMORY_LEDGER_ACTION_FORMAT) throw ledgerError(`ledger_created actionFormat must be ${MEMORY_LEDGER_ACTION_FORMAT}`);
  state.sawGenesis = true;
}

function applyRecorded(event, state) {
  const raw = fields(event.data, ['record'], 'memory_recorded data');
  const record = restoreRecord(raw.record, 'memory_recorded record');
  if (state.entries.has(record.id)) throw ledgerError(`conflict: memory ${JSON.stringify(record.id)} already exists`);
  state.entries.set(record.id, {
    id: record.id,
    revisions: new Map([[record.fingerprint, { record, sequence: event.sequence }]]),
    currentFingerprint: record.fingerprint,
    active: true,
    lastSequence: event.sequence,
  });
}

function actionFields(data, allowed, where) {
  const raw = fields(data, allowed, where);
  memoryId(raw.id);
  fingerprint(raw.expectedFingerprint, `${where}.expectedFingerprint`);
  if (!Number.isSafeInteger(raw.expectedSequence) || raw.expectedSequence < 1) throw ledgerError(`${where}.expectedSequence must be a positive whole number`);
  raw.reason = reason(raw.reason);
  raw.actor = actor(raw.actor);
  return raw;
}

function applySuperseded(event, state) {
  const raw = actionFields(event.data, ['id', 'expectedFingerprint', 'expectedSequence', 'replacement', 'reason', 'actor'], 'memory_superseded data');
  const replacement = restoreRecord(raw.replacement, 'memory_superseded replacement');
  const entry = currentEntry(state, raw.id);
  expectCurrent(entry, raw.expectedFingerprint, raw.expectedSequence);
  if (!entry.active) throw ledgerError(`conflict: memory ${JSON.stringify(raw.id)} is retracted`);
  if (replacement.id !== raw.id) throw ledgerError('replacement.id must equal the superseded memory id');
  if (entry.revisions.has(replacement.fingerprint)) throw ledgerError('replacement fingerprint already exists in this memory lineage');
  entry.revisions.set(replacement.fingerprint, { record: replacement, sequence: event.sequence });
  entry.currentFingerprint = replacement.fingerprint;
  entry.active = true;
  entry.lastSequence = event.sequence;
}

function applyRetracted(event, state) {
  const raw = actionFields(event.data, ['id', 'expectedFingerprint', 'expectedSequence', 'reason', 'actor'], 'memory_retracted data');
  const entry = currentEntry(state, raw.id);
  expectCurrent(entry, raw.expectedFingerprint, raw.expectedSequence);
  if (!entry.active) throw ledgerError(`conflict: memory ${JSON.stringify(raw.id)} is already retracted`);
  entry.active = false;
  entry.lastSequence = event.sequence;
}

function applyRestored(event, state) {
  const raw = actionFields(event.data, ['id', 'expectedFingerprint', 'expectedSequence', 'targetFingerprint', 'reason', 'actor'], 'memory_restored data');
  fingerprint(raw.targetFingerprint, 'memory_restored data.targetFingerprint');
  const entry = currentEntry(state, raw.id);
  expectCurrent(entry, raw.expectedFingerprint, raw.expectedSequence);
  if (!entry.revisions.has(raw.targetFingerprint)) throw ledgerError(`conflict: target fingerprint is not a revision of memory ${JSON.stringify(raw.id)}`);
  if (entry.active && entry.currentFingerprint === raw.targetFingerprint) throw ledgerError('conflict: the requested memory revision is already active');
  entry.currentFingerprint = raw.targetFingerprint;
  entry.active = true;
  entry.lastSequence = event.sequence;
}

function applyEvent(event, state) {
  if (event.type === 'ledger_created') return validateGenesis(event, state);
  if (!state.sawGenesis) throw ledgerError('the ledger has no valid genesis event');
  if (event.type === 'memory_recorded') return applyRecorded(event, state);
  if (event.type === 'memory_superseded') return applySuperseded(event, state);
  if (event.type === 'memory_retracted') return applyRetracted(event, state);
  if (event.type === 'memory_restored') return applyRestored(event, state);
  throw ledgerError(`unsupported ledger event type ${JSON.stringify(event.type)}`);
}

function entryView(entry) {
  return deepFreeze({
    id: entry.id,
    active: entry.active,
    currentFingerprint: entry.currentFingerprint,
    current: entry.revisions.get(entry.currentFingerprint).record,
    revisions: [...entry.revisions].map(([revisionFingerprint, revision]) => ({
      fingerprint: revisionFingerprint,
      sequence: revision.sequence,
      record: revision.record,
    })),
    lastSequence: entry.lastSequence,
  });
}

async function buildLedger(log, state) {
  let operationQueue = Promise.resolve();
  let closing = false;
  let closePromise = null;
  let projectionFailure = null;

  const ensureHealthy = () => {
    if (projectionFailure) throw projectionFailure;
  };

  const appendAndApply = async (type, data) => {
    let event;
    try { event = await log.append(type, data); }
    catch (error) {
      if (error?.commitStatus !== 'not-written') {
        projectionFailure ??= error instanceof Error ? error : ledgerError('durable append failed', error);
        throw projectionFailure;
      }
      throw error;
    }
    try { applyEvent(event, state); }
    catch (error) {
      const failure = ledgerError('a durable event was written but the live memory projection failed; close and reopen before any further operation', error);
      Object.defineProperty(failure, 'event', {
        value: deepFreeze({ sequence: event.sequence, hash: event.hash, type: event.type }), enumerable: true,
      });
      projectionFailure = failure;
      throw failure;
    }
    return event;
  };

  const mutate = operation => {
    if (closing) return Promise.reject(ledgerError('cannot mutate after close has begun'));
    const job = operationQueue.then(() => { ensureHealthy(); return operation(); });
    operationQueue = job.then(() => undefined, () => undefined);
    return job;
  };

  const inspect = operation => {
    if (closing) return Promise.reject(ledgerError('cannot inspect after close has begun'));
    const job = operationQueue.then(() => { ensureHealthy(); return operation(); });
    operationQueue = job.then(() => undefined, () => undefined);
    return job;
  };

  const record = value => mutate(async () => {
    if (!isMemoryRecord(value)) throw ledgerError('record must be created by createMemoryRecord() or restored by Fieldwork');
    if (state.entries.has(value.id)) throw ledgerError(`conflict: memory ${JSON.stringify(value.id)} already exists`);
    await appendAndApply('memory_recorded', { record: value });
    return entryView(state.entries.get(value.id));
  });

  const supersede = input => mutate(async () => {
    const raw = fields(input, ['id', 'expectedFingerprint', 'expectedSequence', 'replacement', 'reason', 'actor'], 'supersede request');
    memoryId(raw.id);
    const entry = currentEntry(state, raw.id);
    expectCurrent(entry, raw.expectedFingerprint, raw.expectedSequence);
    if (!entry.active) throw ledgerError(`conflict: memory ${JSON.stringify(raw.id)} is retracted`);
    if (!isMemoryRecord(raw.replacement)) throw ledgerError('replacement must be created by createMemoryRecord() or restored by Fieldwork');
    if (raw.replacement.id !== raw.id) throw ledgerError('replacement.id must equal the superseded memory id');
    if (entry.revisions.has(raw.replacement.fingerprint)) throw ledgerError('replacement fingerprint already exists in this memory lineage');
    const normalizedActor = actor(raw.actor), normalizedReason = reason(raw.reason);
    await appendAndApply('memory_superseded', {
      id: raw.id, expectedFingerprint: raw.expectedFingerprint, expectedSequence: raw.expectedSequence, replacement: raw.replacement,
      reason: normalizedReason, actor: normalizedActor,
    });
    return entryView(entry);
  });

  const retract = input => mutate(async () => {
    const raw = fields(input, ['id', 'expectedFingerprint', 'expectedSequence', 'reason', 'actor'], 'retract request');
    memoryId(raw.id);
    const entry = currentEntry(state, raw.id);
    expectCurrent(entry, raw.expectedFingerprint, raw.expectedSequence);
    if (!entry.active) throw ledgerError(`conflict: memory ${JSON.stringify(raw.id)} is already retracted`);
    await appendAndApply('memory_retracted', {
      id: raw.id, expectedFingerprint: raw.expectedFingerprint, expectedSequence: raw.expectedSequence,
      reason: reason(raw.reason), actor: actor(raw.actor),
    });
    return entryView(entry);
  });

  const restore = input => mutate(async () => {
    const raw = fields(input, ['id', 'expectedFingerprint', 'expectedSequence', 'targetFingerprint', 'reason', 'actor'], 'restore request');
    memoryId(raw.id);
    const entry = currentEntry(state, raw.id);
    expectCurrent(entry, raw.expectedFingerprint, raw.expectedSequence);
    fingerprint(raw.targetFingerprint, 'targetFingerprint');
    if (!entry.revisions.has(raw.targetFingerprint)) throw ledgerError(`conflict: target fingerprint is not a revision of memory ${JSON.stringify(raw.id)}`);
    if (entry.active && entry.currentFingerprint === raw.targetFingerprint) throw ledgerError('conflict: the requested memory revision is already active');
    await appendAndApply('memory_restored', {
      id: raw.id, expectedFingerprint: raw.expectedFingerprint, expectedSequence: raw.expectedSequence, targetFingerprint: raw.targetFingerprint,
      reason: reason(raw.reason), actor: actor(raw.actor),
    });
    return entryView(entry);
  });

  const get = id => inspect(async () => {
    memoryId(id);
    const entry = state.entries.get(id);
    return entry ? entryView(entry) : null;
  });

  const snapshot = () => inspect(async () => {
    const receipt = await log.receipt();
    const entries = [...state.entries.values()].map(entryView);
    return deepFreeze({
      format: MEMORY_LEDGER_SNAPSHOT_FORMAT,
      ledgerId: log.id,
      receipt,
      active: entries.filter(entry => entry.active).map(entry => entry.current),
      entries,
    });
  });

  const retrievalView = input => inspect(async () => {
    const raw = fields(input, ['mode', 'maxCandidates'], 'retrieval view request');
    if (!['current', 'history'].includes(raw.mode)) throw ledgerError('retrieval view mode must be current or history');
    if (!Number.isSafeInteger(raw.maxCandidates) || raw.maxCandidates < 1 || raw.maxCandidates > 100_000) {
      throw ledgerError('retrieval view maxCandidates must be a whole number from 1 to 100000');
    }
    const rows = [];
    const add = row => {
      if (rows.length >= raw.maxCandidates) {
        throw ledgerError(`retrieval view exceeds the ${raw.maxCandidates}-candidate limit`);
      }
      rows.push(row);
    };
    for (const entry of state.entries.values()) {
      if (raw.mode === 'current') {
        if (!entry.active) continue;
        const revision = entry.revisions.get(entry.currentFingerprint);
        if (!revision) throw ledgerError(`memory ${JSON.stringify(entry.id)} has no current revision`);
        add({
          record: revision.record,
          state: 'current',
          logicalId: entry.id,
          revisionSequence: revision.sequence,
          currentFingerprint: entry.currentFingerprint,
          active: true,
          lastSequence: entry.lastSequence,
        });
        continue;
      }
      for (const [revisionFingerprint, revision] of entry.revisions) {
        const isCurrent = revisionFingerprint === entry.currentFingerprint;
        add({
          record: revision.record,
          state: isCurrent ? (entry.active ? 'current' : 'retracted') : 'superseded',
          logicalId: entry.id,
          revisionSequence: revision.sequence,
          currentFingerprint: entry.currentFingerprint,
          active: entry.active,
          lastSequence: entry.lastSequence,
        });
      }
    }
    const receipt = await log.receipt();
    return deepFreeze({
      format: MEMORY_LEDGER_RETRIEVAL_VIEW_FORMAT,
      mode: raw.mode,
      ledgerId: log.id,
      receipt,
      rows,
    });
  });

  const close = () => {
    if (!closePromise) {
      closing = true;
      closePromise = operationQueue.then(async () => {
        const errors = [];
        try { await log.close(); } catch (error) { errors.push(error); }
        if (projectionFailure && !errors.includes(projectionFailure)) errors.push(projectionFailure);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Memory ledger close preserved durable and projection failures');
      });
    }
    return closePromise;
  };

  const receipt = async () => {
    if (closePromise) await closePromise;
    else await operationQueue;
    ensureHealthy();
    return log.receipt();
  };

  const ledger = Object.freeze({
    ledgerId: log.id,
    record,
    supersede,
    retract,
    restore,
    get,
    snapshot,
    retrievalView,
    receipt,
    close,
  });
  ledgers.add(ledger);
  liveReceiptReaders.set(ledger, () => inspect(() => log.receipt()));
  return ledger;
}

export function isMemoryLedger(value) {
  return Boolean(value) && ledgers.has(value);
}

export function readLiveMemoryLedgerReceipt(value) {
  if (!isMemoryLedger(value)) return Promise.reject(ledgerError('value must be a live Fieldwork memory ledger'));
  return liveReceiptReaders.get(value)();
}

export async function createMemoryLedger(file, options = {}) {
  const raw = fields(options, ['ledgerId', 'clock', 'sync'], 'create options');
  const ledgerId = raw.ledgerId === undefined ? randomUUID() : raw.ledgerId;
  const clock = raw.clock === undefined ? Date.now : raw.clock;
  const sync = raw.sync === undefined ? true : raw.sync;
  const state = newState();
  const log = await openDurableLog(file, {
    create: true,
    format: MEMORY_LEDGER_EVENT_FORMAT,
    idField: 'ledgerId',
    id: ledgerId,
    initial: {
      type: 'ledger_created',
      data: { recordFormat: MEMORY_RECORD_FORMAT, actionFormat: MEMORY_LEDGER_ACTION_FORMAT },
    },
    clock,
    sync,
  });
  state.sawGenesis = true;
  return buildLedger(log, state);
}

export async function openMemoryLedger(file, options = {}) {
  const raw = fields(options, ['expectedLedgerId', 'expectedHead', 'clock', 'sync'], 'open options');
  const expectedLedgerId = raw.expectedLedgerId;
  const expectedHead = raw.expectedHead;
  const clock = raw.clock === undefined ? Date.now : raw.clock;
  const sync = raw.sync === undefined ? true : raw.sync;
  const log = await openDurableLog(file, {
    format: MEMORY_LEDGER_EVENT_FORMAT,
    idField: 'ledgerId',
    expectedId: expectedLedgerId,
    expectedHead,
    clock,
    sync,
    replay: { create: newState, apply: (state, event) => applyEvent(event, state) },
  });
  return buildLedger(log, log.replayState);
}
