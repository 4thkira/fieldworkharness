import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';

export const RUN_EVENT_FORMAT = 'fieldwork-run-event/v1';
export const EMPTY_EVENT_HASH = '0'.repeat(64);
export const EVENT_DATA_BYTES = 16 * 1024 * 1024;

const eventType = /^[a-z][a-z0-9_]{0,63}$/;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const logs = new WeakSet();
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function logError(message, cause) {
  return new Error(`Event log: ${message}`, cause === undefined ? undefined : { cause });
}

function validRunId(value) {
  if (typeof value !== 'string' || !runIdPattern.test(value)) throw logError('runId must be 1-128 portable letters, digits, dots, underscores or hyphens');
  return value;
}

function timestamp(clock) {
  let value;
  try { value = clock(); }
  catch (error) { throw logError(`clock failed: ${error.message}`, error); }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw logError('clock returned an invalid time');
  return date.toISOString();
}

function makeLog({ runId, clock, write, finish }) {
  validRunId(runId);
  if (typeof clock !== 'function') throw logError('clock must be a function');
  const events = [];
  let head = EMPTY_EVENT_HASH;
  let queue = Promise.resolve();
  let failure = null;
  let closing = false;
  let closePromise = null;

  const append = (type, data = {}) => {
    if (closing) return Promise.reject(logError('cannot append after close has begun'));
    if (typeof type !== 'string' || !eventType.test(type)) return Promise.reject(logError(`invalid event type ${JSON.stringify(type)}`));
    let normalized;
    try { normalized = boundedJson(data, { where: `event ${type} data`, object: true, maxBytes: EVENT_DATA_BYTES, maxDepth: 64, maxNodes: 200_000 }).value; }
    catch (error) { return Promise.reject(logError(error.message, error)); }
    const job = queue.then(async () => {
      if (failure) throw failure;
      const body = {
        format: RUN_EVENT_FORMAT,
        runId,
        sequence: events.length + 1,
        at: timestamp(clock),
        type,
        data: normalized,
        previous: head,
      };
      const event = deepFreeze({ ...body, hash: sha256(canonicalJson(body)) });
      if (write) await write(`${canonicalJson(event)}\n`);
      events.push(event);
      head = event.hash;
      return event;
    });
    queue = job.then(
      () => undefined,
      error => { failure ??= error; },
    );
    return job;
  };

  const read = async () => {
    await queue;
    if (failure) throw failure;
    return Object.freeze([...events]);
  };

  const receipt = async () => {
    await queue;
    if (failure) throw failure;
    return deepFreeze({ format: RUN_EVENT_FORMAT, runId, events: events.length, head });
  };

  const close = () => {
    if (!closePromise) {
      closing = true;
      closePromise = (async () => {
        await queue;
        const queuedFailure = failure;
        let closeFailure = null;
        try { await finish?.(); } catch (error) { closeFailure = error; }
        if (queuedFailure && closeFailure) throw new AggregateError([queuedFailure, closeFailure], 'Event log write and close both failed');
        if (queuedFailure) throw queuedFailure;
        if (closeFailure) throw closeFailure;
      })();
    }
    return closePromise;
  };

  const log = Object.freeze({ runId, append, read, receipt, close });
  logs.add(log);
  return log;
}

export function isEventLog(value) {
  return Boolean(value) && logs.has(value);
}

export function createMemoryEventLog({ runId = randomUUID(), clock = Date.now } = {}) {
  return makeLog({ runId, clock });
}

export async function createJsonlEventLog(file, { runId = randomUUID(), clock = Date.now, sync = true } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw logError('file must be a nonempty path');
  if (typeof sync !== 'boolean') throw logError('sync must be true or false');
  validRunId(runId);
  if (typeof clock !== 'function') throw logError('clock must be a function');
  let handle;
  try { handle = await fs.open(file, 'ax', 0o600); }
  catch (error) { throw logError(`could not create a new log file: ${error.message}`, error); }
  return makeLog({
    runId,
    clock,
    write: async line => {
      await handle.appendFile(line, 'utf8');
      if (sync) await handle.sync();
    },
    finish: () => handle.close(),
  });
}

export function verifyEventChain(events, { expectedRunId, expectedHead } = {}) {
  if (!Array.isArray(events)) throw logError('events must be an array');
  let previous = EMPTY_EVENT_HASH;
  let runId = expectedRunId;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!isPlainObject(event)) throw logError(`event ${index + 1} must be an object`);
    const keys = Object.keys(event).sort();
    const expectedKeys = ['at', 'data', 'format', 'hash', 'previous', 'runId', 'sequence', 'type'].sort();
    if (keys.length !== expectedKeys.length || keys.some((key, at) => key !== expectedKeys[at])) throw logError(`event ${index + 1} has an invalid shape`);
    if (event.format !== RUN_EVENT_FORMAT) throw logError(`event ${index + 1} has an unknown format`);
    if (event.sequence !== index + 1) throw logError(`event ${index + 1} has sequence ${JSON.stringify(event.sequence)}`);
    if (typeof event.type !== 'string' || !eventType.test(event.type)) throw logError(`event ${index + 1} has an invalid type`);
    let normalizedAt = '';
    try { normalizedAt = typeof event.at === 'string' ? new Date(event.at).toISOString() : ''; }
    catch { /* Rejected below with the event number. */ }
    if (normalizedAt !== event.at) throw logError(`event ${index + 1} has an invalid timestamp`);
    try { boundedJson(event.data, { where: `event ${index + 1} data`, object: true, maxBytes: EVENT_DATA_BYTES, maxDepth: 64, maxNodes: 200_000 }); }
    catch (error) { throw logError(error.message, error); }
    if (!runId) runId = validRunId(event.runId);
    else validRunId(event.runId);
    if (event.runId !== runId) throw logError(`event ${index + 1} belongs to a different run`);
    if (typeof event.previous !== 'string' || !/^[0-9a-f]{64}$/.test(event.previous)) throw logError(`event ${index + 1} has an invalid preceding hash`);
    if (typeof event.hash !== 'string' || !/^[0-9a-f]{64}$/.test(event.hash)) throw logError(`event ${index + 1} has an invalid hash`);
    if (event.previous !== previous) throw logError(`event ${index + 1} does not name the preceding hash`);
    const { hash, ...body } = event;
    const calculated = sha256(canonicalJson(body));
    if (hash !== calculated) throw logError(`event ${index + 1} hash does not match its contents`);
    previous = hash;
  }
  if (expectedHead !== undefined && previous !== expectedHead) throw logError('the event-chain head does not match the expected receipt');
  return deepFreeze({ format: RUN_EVENT_FORMAT, runId: runId ?? expectedRunId ?? null, events: events.length, head: previous });
}
