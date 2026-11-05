import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

export const DURABLE_LOG_EMPTY_HASH = '0'.repeat(64);
export const DURABLE_LOG_LIMITS = Object.freeze({
  dataBytes: 512 * 1024,
  lineBytes: 1024 * 1024,
  replayBytes: 512 * 1024 * 1024,
  events: 10_000_000,
});

const durableLogs = new WeakSet();
const eventTypePattern = /^[a-z][a-z0-9_]{0,63}$/;
const formatPattern = /^fieldwork-[a-z0-9-]+\/v[1-9]\d*$/;
const fieldPattern = /^[a-z][a-zA-Z0-9]{0,63}$/;
const streamIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const reservedEventFields = new Set(['format', 'sequence', 'at', 'type', 'data', 'previous', 'hash']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function durableError(message, cause) {
  return new Error(`Durable log: ${message}`, cause === undefined ? undefined : { cause });
}

function reasonOf(error) {
  try { return error instanceof Error ? String(error.message || error.name) : String(error); }
  catch { return 'a thrown value that could not be rendered'; }
}

function exactFields(value, allowed, where) {
  if (!isPlainObject(value)) throw durableError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw durableError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw durableError(`${where}.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  return fields;
}

function positiveWhole(value, fallback, maximum, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw durableError(`${name} must be a whole number from 1 to ${maximum}`);
  }
  return number;
}

function validStreamId(value, name = 'stream id') {
  if (typeof value !== 'string' || !streamIdPattern.test(value)) {
    throw durableError(`${name} must be 1-128 portable letters, digits, dots, colons, underscores or hyphens`);
  }
  return value;
}

function timestamp(clock) {
  let value;
  try { value = clock(); }
  catch (error) { throw durableError(`clock failed: ${reasonOf(error)}`, error); }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw durableError('clock returned an invalid time');
  return date.toISOString();
}

function exactEvent(value, idField, lineNumber) {
  if (!isPlainObject(value)) throw durableError(`line ${lineNumber} must contain one event object`);
  const expected = ['format', idField, 'sequence', 'at', 'type', 'data', 'previous', 'hash'].sort();
  const keys = Reflect.ownKeys(value).sort();
  if (keys.some(key => typeof key !== 'string') || keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw durableError(`line ${lineNumber} has an invalid event shape`);
  }
}

function exactIso(value, lineNumber) {
  let normalized = '';
  try { normalized = typeof value === 'string' ? new Date(value).toISOString() : ''; }
  catch { /* Rejected below. */ }
  if (normalized !== value) throw durableError(`line ${lineNumber} has an invalid timestamp`);
}

function validateEvent(raw, {
  format, idField, streamId, sequence, previous, maxDataBytes, lineNumber,
}) {
  exactEvent(raw, idField, lineNumber);
  if (raw.format !== format) throw durableError(`line ${lineNumber} has format ${JSON.stringify(raw.format)} instead of ${format}`);
  validStreamId(raw[idField], idField);
  if (streamId !== null && raw[idField] !== streamId) throw durableError(`line ${lineNumber} belongs to a different ${idField}`);
  if (raw.sequence !== sequence) throw durableError(`line ${lineNumber} has sequence ${JSON.stringify(raw.sequence)} instead of ${sequence}`);
  exactIso(raw.at, lineNumber);
  if (typeof raw.type !== 'string' || !eventTypePattern.test(raw.type)) throw durableError(`line ${lineNumber} has an invalid event type`);
  let data;
  try {
    data = boundedJson(raw.data, {
      where: `line ${lineNumber} event data`, object: true,
      maxBytes: maxDataBytes, maxDepth: 64, maxNodes: 200_000,
    }).value;
  } catch (error) {
    throw durableError(error.message, error);
  }
  if (typeof raw.previous !== 'string' || !hashPattern.test(raw.previous)) throw durableError(`line ${lineNumber} has an invalid preceding hash`);
  if (raw.previous !== previous) throw durableError(`line ${lineNumber} does not name the preceding hash`);
  if (typeof raw.hash !== 'string' || !hashPattern.test(raw.hash)) throw durableError(`line ${lineNumber} has an invalid event hash`);
  const body = {
    format: raw.format,
    [idField]: raw[idField],
    sequence: raw.sequence,
    at: raw.at,
    type: raw.type,
    data,
    previous: raw.previous,
  };
  if (sha256(canonicalJson(body)) !== raw.hash) throw durableError(`line ${lineNumber} hash does not match its contents`);
  return deepFreeze({ ...body, hash: raw.hash });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function scanLines(handle, { maxLineBytes, maxReplayBytes, maxEvents }, onLine) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) throw durableError('the log path must name a regular file');
  if (before.size > BigInt(maxReplayBytes)) throw durableError(`the log is ${before.size} bytes; the replay limit is ${maxReplayBytes}`);
  const size = Number(before.size);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pieces = [];
  let pendingBytes = 0;
  let position = 0;
  let lines = 0;

  const add = bytes => {
    if (!bytes.length) return;
    pieces.push(Buffer.from(bytes));
    pendingBytes += bytes.length;
    if (pendingBytes > maxLineBytes) throw durableError(`line ${lines + 1} exceeds the ${maxLineBytes}-byte limit`);
  };

  while (position < size) {
    const wanted = Math.min(chunk.length, size - position);
    const { bytesRead } = await handle.read(chunk, 0, wanted, position);
    if (!bytesRead) throw durableError('the log changed while it was being read');
    position += bytesRead;
    let start = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (chunk[index] !== 0x0a) continue;
      add(chunk.subarray(start, index));
      lines++;
      if (lines > maxEvents) throw durableError(`the log has more than ${maxEvents} events`);
      if (!pendingBytes) throw durableError(`line ${lines} is empty`);
      const bytes = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, pendingBytes);
      let text;
      try { text = decoder.decode(bytes); }
      catch (error) { throw durableError(`line ${lines} must be valid UTF-8`, error); }
      await onLine(text, lines);
      pieces = [];
      pendingBytes = 0;
      start = index + 1;
    }
    add(chunk.subarray(start, bytesRead));
  }
  if (pendingBytes) throw durableError('the log ends with an incomplete line; refusing to guess whether a write committed');
  const after = await handle.stat({ bigint: true });
  if (!sameFile(before, after)) throw durableError('the log changed while it was being verified');
  return { stat: after, lines };
}

async function verifyExisting(handle, limits, config, apply) {
  let streamId = null;
  let sequence = 0;
  let head = DURABLE_LOG_EMPTY_HASH;
  const scanned = await scanLines(handle, limits, async (text, lineNumber) => {
    let raw;
    try { raw = parseJsonNoDuplicates(text, { where: `line ${lineNumber}`, maxDepth: 64 }); }
    catch (error) { throw durableError(error.message, error); }
    const event = validateEvent(raw, {
      ...config, streamId, sequence: lineNumber, previous: head, lineNumber,
    });
    if (streamId === null) streamId = event[config.idField];
    if (apply) {
      const returned = apply(event);
      if (returned !== undefined) {
        if (returned instanceof Promise) returned.catch(() => {});
        throw durableError('replay.apply must be synchronous and return undefined');
      }
    }
    sequence = event.sequence;
    head = event.hash;
  });
  if (!sequence) throw durableError('an existing durable log may not be empty');
  return { streamId, sequence, head, stat: scanned.stat };
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return false;
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    try { await handle?.close(); } catch { /* The false result already reports failure. */ }
    return false;
  }
  try { await handle.close(); }
  catch { return false; }
  return true;
}

async function acquireLock(file) {
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  let handle;
  let openedStat;
  try { handle = await fs.open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw durableError(`writer lock already exists at ${lockFile}; verify that no writer is active before removing a stale lock`, error);
    throw durableError(`could not create writer lock: ${reasonOf(error)}`, error);
  }
  try {
    openedStat = await handle.stat({ bigint: true });
    const payload = {
      format: 'fieldwork-writer-lock/v1', token, pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await handle.writeFile(`${canonicalJson(payload)}\n`, 'utf8');
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    const pathStat = await fs.lstat(lockFile, { bigint: true });
    if (!sameIdentity(pathStat, stat)) throw durableError('writer lock path changed while it was being initialized');
    const directorySync = await syncDirectory(path.dirname(path.resolve(lockFile)));
    return { handle, file: lockFile, stat, token, directorySync };
  } catch (error) {
    try { await handle.close(); } catch { /* Preserve the creation failure. */ }
    if (openedStat) {
      try {
        const pathStat = await fs.lstat(lockFile, { bigint: true });
        if (sameIdentity(pathStat, openedStat)) await fs.unlink(lockFile);
      } catch { /* Preserve the creation failure and never unlink an unverified replacement. */ }
    }
    throw durableError(`could not initialize writer lock: ${reasonOf(error)}`, error);
  }
}

async function releaseLock(lock) {
  const errors = [];
  let pathStat;
  try { pathStat = await fs.lstat(lock.file, { bigint: true }); }
  catch (error) {
    lock.directorySync = false;
    errors.push(durableError('writer lock path disappeared before release', error));
  }
  if (pathStat && !sameIdentity(pathStat, lock.stat)) {
    lock.directorySync = false;
    errors.push(durableError('writer lock path was replaced; refusing to remove another writer\'s lock'));
  }
  try { await lock.handle.close(); }
  catch (error) {
    lock.directorySync = false;
    errors.push(error);
  }
  if (!errors.length) {
    try { await fs.unlink(lock.file); }
    catch (error) {
      lock.directorySync = false;
      errors.push(error);
    }
    if (!errors.length && !await syncDirectory(path.dirname(path.resolve(lock.file)))) lock.directorySync = false;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Closing or removing the durable-log lock failed');
}

function ambiguousAppend(error, event, prior) {
  const failure = durableError('append outcome is unknown; close and inspect the log against the prior head before retrying', error);
  Object.defineProperties(failure, {
    commitStatus: { value: 'unknown', enumerable: true },
    candidate: {
      value: deepFreeze({ sequence: event.sequence, hash: event.hash, previous: event.previous, type: event.type }),
      enumerable: true,
    },
    prior: { value: deepFreeze(prior), enumerable: true },
  });
  return failure;
}

function rejectedAppend(error) {
  const failure = error instanceof Error ? error : durableError('append was rejected before writing', error);
  if (!Object.hasOwn(failure, 'commitStatus')) {
    Object.defineProperty(failure, 'commitStatus', { value: 'not-written', enumerable: true });
  }
  return failure;
}

async function writeAtEnd(handle, bytes, expectedSize, sync) {
  const before = await handle.stat({ bigint: true });
  if (before.size !== BigInt(expectedSize)) throw durableError('the log size changed outside the active writer');
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, expectedSize + offset);
    if (!bytesWritten) throw durableError('the filesystem accepted no bytes while appending');
    offset += bytesWritten;
  }
  if (sync) await handle.sync();
  const after = await handle.stat({ bigint: true });
  if (after.size !== BigInt(expectedSize + bytes.length)) throw durableError('the log size after append is not the expected size');
  return expectedSize + bytes.length;
}

export function isDurableLog(value) {
  return Boolean(value) && durableLogs.has(value);
}

export async function openDurableLog(file, options = {}) {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')) throw durableError('file must be a nonempty path');
  const raw = exactFields(options, [
    'create', 'format', 'idField', 'id', 'expectedId', 'expectedHead', 'initial', 'clock', 'sync',
    'maxDataBytes', 'maxLineBytes', 'maxReplayBytes', 'maxEvents', 'replay',
  ], 'options');
  const create = raw.create === undefined ? false : raw.create;
  const format = raw.format;
  const idField = raw.idField;
  const id = raw.id;
  const expectedId = raw.expectedId;
  const expectedHead = raw.expectedHead;
  const clock = raw.clock === undefined ? Date.now : raw.clock;
  const sync = raw.sync === undefined ? true : raw.sync;
  const maxDataBytes = positiveWhole(raw.maxDataBytes, DURABLE_LOG_LIMITS.dataBytes, 16 * 1024 * 1024, 'maxDataBytes');
  const maxLineBytes = positiveWhole(raw.maxLineBytes, DURABLE_LOG_LIMITS.lineBytes, 32 * 1024 * 1024, 'maxLineBytes');
  const maxReplayBytes = positiveWhole(raw.maxReplayBytes, DURABLE_LOG_LIMITS.replayBytes, 16 * 1024 * 1024 * 1024, 'maxReplayBytes');
  const maxEvents = positiveWhole(raw.maxEvents, DURABLE_LOG_LIMITS.events, 100_000_000, 'maxEvents');
  if (typeof create !== 'boolean') throw durableError('create must be true or false');
  if (typeof format !== 'string' || !formatPattern.test(format)) throw durableError('format must be versioned Fieldwork format text');
  if (typeof idField !== 'string' || !fieldPattern.test(idField)) throw durableError('idField must be a portable field name');
  if (reservedEventFields.has(idField)) throw durableError(`idField ${JSON.stringify(idField)} collides with a reserved event field`);
  if (typeof clock !== 'function') throw durableError('clock must be a function');
  if (typeof sync !== 'boolean') throw durableError('sync must be true or false');
  if (maxLineBytes <= maxDataBytes) throw durableError('maxLineBytes must be larger than maxDataBytes');
  if (maxReplayBytes <= maxLineBytes) throw durableError('maxReplayBytes must be larger than maxLineBytes');
  let initial = null;
  let replay = null;
  if (create) {
    if (expectedId !== undefined) throw durableError('expectedId is only accepted while opening an existing log');
    if (expectedHead !== undefined) throw durableError('expectedHead is only accepted while opening an existing log');
    validStreamId(id, idField);
    if (raw.replay !== undefined) throw durableError('replay is only accepted while opening an existing log');
    const initialFields = exactFields(raw.initial, ['type', 'data'], 'initial');
    if (typeof initialFields.type !== 'string' || !eventTypePattern.test(initialFields.type) || !isPlainObject(initialFields.data)) {
      throw durableError('a created log requires an initial { type, data } event');
    }
    let data;
    try {
      data = boundedJson(initialFields.data, {
        where: `event ${initialFields.type} data`, object: true,
        maxBytes: maxDataBytes, maxDepth: 64, maxNodes: 200_000,
      }).value;
    } catch (error) {
      throw durableError(error.message, error);
    }
    initial = { type: initialFields.type, data, at: timestamp(clock) };
    const body = {
      format,
      [idField]: id,
      sequence: 1,
      at: initial.at,
      type: initial.type,
      data: initial.data,
      previous: DURABLE_LOG_EMPTY_HASH,
    };
    const event = { ...body, hash: sha256(canonicalJson(body)) };
    const lineBytes = Buffer.byteLength(canonicalJson(event), 'utf8');
    if (lineBytes > maxLineBytes) throw durableError(`event line is ${lineBytes} bytes; the limit is ${maxLineBytes}`);
    if (lineBytes + 1 > maxReplayBytes) throw durableError(`the initial event would exceed the ${maxReplayBytes}-byte replay limit`);
  } else {
    if (id !== undefined) throw durableError('id is only accepted while creating a log');
    if (expectedId !== undefined) validStreamId(expectedId, `expected ${idField}`);
    if (expectedHead !== undefined && (typeof expectedHead !== 'string' || !hashPattern.test(expectedHead))) throw durableError('expectedHead must be a lowercase SHA-256 hash');
    if (raw.initial !== undefined) throw durableError('initial is only accepted while creating a log');
    if (raw.replay !== undefined) {
      const replayFields = exactFields(raw.replay, ['create', 'apply'], 'replay');
      if (typeof replayFields.create !== 'function' || typeof replayFields.apply !== 'function') throw durableError('replay requires create and apply functions');
      replay = { create: replayFields.create, apply: replayFields.apply };
    }
  }

  const lock = await acquireLock(file);
  let handle;
  let createdFile = false;
  let createdFileStat = null;
  let preserveCreatedFile = false;
  try {
    let directorySync = lock.directorySync;
    if (!create) {
      const stat = await fs.lstat(file, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) throw durableError('the log path must be an existing regular file, not a symbolic link');
      handle = await fs.open(file, 'r+', 0o600);
      const opened = await handle.stat({ bigint: true });
      if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw durableError('the log path changed while it was being opened');
    } else {
      handle = await fs.open(file, 'ax+', 0o600);
      createdFile = true;
      createdFileStat = await handle.stat({ bigint: true });
      const pathStat = await fs.lstat(file, { bigint: true });
      if (!sameIdentity(pathStat, createdFileStat)) throw durableError('the created log path changed while it was being opened');
      if (!await syncDirectory(path.dirname(path.resolve(file)))) directorySync = false;
    }

    let streamId = create ? id : null;
    let sequence = 0;
    let head = DURABLE_LOG_EMPTY_HASH;
    let fileBytes = 0;
    const limits = { maxLineBytes, maxReplayBytes, maxEvents };
    const validation = { format, idField, maxDataBytes };
    if (!create) {
      const verified = await verifyExisting(handle, limits, validation);
      streamId = verified.streamId;
      sequence = verified.sequence;
      head = verified.head;
      fileBytes = Number(verified.stat.size);
      if (expectedId !== undefined && streamId !== expectedId) throw durableError(`the log ${idField} does not match the expected value`);
      if (expectedHead !== undefined && head !== expectedHead) throw durableError('the log head does not match the independently retained receipt');
      if (replay) {
        replay.state = replay.create();
        if (replay.state instanceof Promise) {
          replay.state.catch(() => {});
          throw durableError('replay.create must be synchronous');
        }
        const replayed = await verifyExisting(handle, limits, validation, event => replay.apply(replay.state, event));
        if (replayed.streamId !== streamId || replayed.sequence !== sequence || replayed.head !== head || !sameFile(replayed.stat, verified.stat)) {
          throw durableError('the log changed between verification and semantic replay');
        }
      }
    }

    let queue = Promise.resolve();
    let failure = null;
    let closing = false;
    let closePromise = null;

    const enqueueAppend = (type, normalized, fixedAt) => {
      const job = queue.then(async () => {
        if (failure) throw failure;
        let event, bytes;
        try {
          if (sequence >= maxEvents) throw durableError(`the log reached its ${maxEvents}-event limit`);
          const body = {
            format,
            [idField]: streamId,
            sequence: sequence + 1,
            at: fixedAt ?? timestamp(clock),
            type,
            data: normalized,
            previous: head,
          };
          event = deepFreeze({ ...body, hash: sha256(canonicalJson(body)) });
          bytes = Buffer.from(`${canonicalJson(event)}\n`, 'utf8');
          const lineBytes = bytes.length - 1;
          if (lineBytes > maxLineBytes) throw durableError(`event line is ${lineBytes} bytes; the limit is ${maxLineBytes}`);
          if (fileBytes + bytes.length > maxReplayBytes) throw durableError(`the append would exceed the ${maxReplayBytes}-byte replay limit`);
        } catch (error) {
          throw rejectedAppend(error);
        }
        const prior = { events: sequence, head };
        try { fileBytes = await writeAtEnd(handle, bytes, fileBytes, sync); }
        catch (error) { throw ambiguousAppend(error, event, prior); }
        sequence = event.sequence;
        head = event.hash;
        return event;
      });
      queue = job.then(
        () => undefined,
        error => {
          if (error?.commitStatus !== 'not-written') failure ??= error;
        },
      );
      return job;
    };

    const append = (type, data = {}) => {
      if (closing) return Promise.reject(durableError('cannot append after close has begun'));
      if (typeof type !== 'string' || !eventTypePattern.test(type)) return Promise.reject(rejectedAppend(durableError(`invalid event type ${JSON.stringify(type)}`)));
      let normalized;
      try {
        normalized = boundedJson(data, {
          where: `event ${type} data`, object: true,
          maxBytes: maxDataBytes, maxDepth: 64, maxNodes: 200_000,
        }).value;
      } catch (error) {
        return Promise.reject(rejectedAppend(durableError(error.message, error)));
      }
      return enqueueAppend(type, normalized);
    };

    const currentReceipt = () => deepFreeze({
        format,
        [idField]: streamId,
        events: sequence,
        head,
        durability: {
          fileSync: sync,
          directorySync: directorySync && lock.directorySync,
          writerLock: 'cooperative-path',
        },
      });

    const receipt = async () => {
      await queue;
      if (failure) throw failure;
      return currentReceipt();
    };

    const readEvent = eventSequence => {
      if (closing) return Promise.reject(durableError('cannot read after close has begun'));
      if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
        return Promise.reject(durableError('event sequence must be a positive whole number'));
      }
      const job = queue.then(async () => {
        if (failure) throw failure;
        let found = null;
        const verified = await verifyExisting(handle, limits, validation, event => {
          if (event.sequence === eventSequence) found = event;
        });
        if (
          verified.streamId !== streamId
          || verified.sequence !== sequence
          || verified.head !== head
          || Number(verified.stat.size) !== fileBytes
        ) {
          throw durableError('the log changed outside the active writer while an event was being read');
        }
        return deepFreeze({ event: found, receipt: currentReceipt() });
      });
      queue = job.then(
        () => undefined,
        error => { failure ??= error; },
      );
      return job;
    };

    const close = () => {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          await queue;
          const errors = [];
          if (failure) errors.push(failure);
          try { await handle.close(); } catch (error) { errors.push(error); }
          try { await releaseLock(lock); } catch (error) { errors.push(error); }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, 'Durable log append, close or lock release failed');
        })();
      }
      return closePromise;
    };

    const log = Object.freeze({
      format,
      idField,
      get id() { return streamId; },
      append,
      readEvent,
      receipt,
      close,
      ...(replay ? { replayState: replay.state } : {}),
    });
    durableLogs.add(log);

    if (create) {
      try { await enqueueAppend(initial.type, initial.data, initial.at); }
      catch (error) {
        preserveCreatedFile = error?.commitStatus === 'unknown';
        try { await close(); } catch { /* Preserve the append failure with its reconciliation receipt. */ }
        throw error;
      }
    }
    return log;
  } catch (error) {
    try { await handle?.close(); } catch { /* Preserve the opening failure. */ }
    try { await releaseLock(lock); } catch { /* Preserve the opening failure. */ }
    if (createdFile && createdFileStat && !preserveCreatedFile) {
      try {
        const stat = await fs.lstat(file, { bigint: true });
        if (stat.isFile() && stat.size === 0n && sameIdentity(stat, createdFileStat)) {
          await fs.unlink(file);
          await syncDirectory(path.dirname(path.resolve(file)));
        }
      } catch { /* Preserve the opening failure and never delete a nonempty or unverified path. */ }
    }
    throw error;
  }
}
