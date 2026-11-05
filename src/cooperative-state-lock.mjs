import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalJson, isPlainObject } from './json-data.mjs';

export const STATE_TRANSACTION_LOCK_FORMAT = 'fieldwork-state-transaction-lock/v1';
export const STATE_TRANSACTION_LOCK_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  pollMs: 10,
  maximumTimeoutMs: 60_000,
  maximumPollMs: 1_000,
});

// Windows may surface a sharing violation as an access/busy error while the
// current owner is closing or unlinking the lock. Retry only within the same
// bounded wait; this path never removes or replaces another owner's file.
const WINDOWS_TRANSIENT_CREATE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function retryableCreateError(error) {
  return error?.code === 'EEXIST'
    || (process.platform === 'win32' && WINDOWS_TRANSIENT_CREATE_CODES.has(error?.code));
}

function lockError(message, cause, details = null) {
  const error = new Error(`State transaction lock: ${message}`, cause === undefined ? undefined : { cause });
  if (details) {
    if (typeof details.code === 'string') Object.defineProperty(error, 'code', { value: details.code, enumerable: true });
    if (Number.isSafeInteger(details.status)) Object.defineProperty(error, 'status', { value: details.status, enumerable: true });
  }
  return error;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function whole(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw lockError(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return number;
}

function cleanOptions(value) {
  if (value === undefined) return {
    timeoutMs: STATE_TRANSACTION_LOCK_LIMITS.timeoutMs,
    pollMs: STATE_TRANSACTION_LOCK_LIMITS.pollMs,
  };
  if (!isPlainObject(value)) throw lockError('options must be an object');
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !['timeoutMs', 'pollMs'].includes(key)) {
      throw lockError(`options has unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw lockError(`options.${key} must be an enumerable data property`);
    }
    fields[key] = descriptor.value;
  }
  const timeoutMs = whole(
    fields.timeoutMs,
    STATE_TRANSACTION_LOCK_LIMITS.timeoutMs,
    1,
    STATE_TRANSACTION_LOCK_LIMITS.maximumTimeoutMs,
    'options.timeoutMs',
  );
  const pollMs = whole(
    fields.pollMs,
    STATE_TRANSACTION_LOCK_LIMITS.pollMs,
    1,
    STATE_TRANSACTION_LOCK_LIMITS.maximumPollMs,
    'options.pollMs',
  );
  if (pollMs > timeoutMs) throw lockError('options.pollMs cannot exceed options.timeoutMs');
  return { timeoutMs, pollMs };
}

async function existingRegularFile(file, where) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw lockError(`${where} must be a regular file`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error?.message?.startsWith('State transaction lock:')) throw error;
    throw lockError('could not inspect the state path', error);
  }
}

async function resolveStatePaths(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw lockError('file must be an absolute path');
  }
  const base = path.basename(file);
  if (!base || base === '.' || base === '..') throw lockError('file must name a state file');
  const stateFile = path.resolve(file);
  const requestedParent = path.dirname(stateFile);
  try { await fs.mkdir(requestedParent, { recursive: true }); }
  catch (error) { throw lockError('could not prepare the state directory', error); }
  let realParent;
  try { realParent = await fs.realpath(requestedParent); }
  catch (error) { throw lockError('could not resolve the state directory', error); }
  await existingRegularFile(stateFile, 'an existing state path');
  return {
    stateFile,
    lockFile: `${path.join(realParent, base)}.lock`,
  };
}

export async function canonicalStateFile(file) {
  return (await resolveStatePaths(file)).stateFile;
}

async function acquire(lockFile, { timeoutMs, pollMs }) {
  const token = randomUUID();
  const started = performance.now();
  while (true) {
    let handle;
    try {
      handle = await fs.open(lockFile, 'wx', 0o600);
    } catch (error) {
      if (!retryableCreateError(error)) {
        throw lockError('could not create the transaction lock', error);
      }
      if (performance.now() - started >= timeoutMs) {
        if (error?.code !== 'EEXIST') {
          throw lockError('could not create the transaction lock', error);
        }
        throw lockError(
          `the transaction lock remained busy for ${timeoutMs} ms; it was not removed`,
          undefined,
          { code: 'FIELDWORK_STATE_BUSY', status: 503 },
        );
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
      continue;
    }

    let openedStat;
    try {
      openedStat = await handle.stat({ bigint: true });
      const payload = `${canonicalJson({
        format: STATE_TRANSACTION_LOCK_FORMAT,
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`;
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      const stat = await handle.stat({ bigint: true });
      const pathStat = await fs.lstat(lockFile, { bigint: true });
      if (!sameIdentity(pathStat, stat)) throw lockError('the lock path changed while it was being initialized');
      return { file: lockFile, handle, stat, payload };
    } catch (error) {
      try { await handle.close(); } catch { /* Preserve the initialization failure. */ }
      if (openedStat) {
        try {
          const pathStat = await fs.lstat(lockFile, { bigint: true });
          if (sameIdentity(pathStat, openedStat)) await fs.unlink(lockFile);
        } catch { /* Preserve the initialization failure and never remove an unverified path. */ }
      }
      throw error?.message?.startsWith('State transaction lock:')
        ? error
        : lockError('could not initialize the transaction lock', error);
    }
  }
}

async function release(lock) {
  const errors = [];
  let verified = false;
  try {
    const [pathStat, handleStat] = await Promise.all([
      fs.lstat(lock.file, { bigint: true }),
      lock.handle.stat({ bigint: true }),
    ]);
    if (!sameIdentity(pathStat, lock.stat) || !sameIdentity(handleStat, lock.stat)) {
      throw lockError('the lock path was replaced; refusing to remove another owner\'s lock');
    }
    if (handleStat.size !== BigInt(Buffer.byteLength(lock.payload))) {
      throw lockError('the lock payload changed while it was held; refusing to remove it');
    }
    const payload = await fs.readFile(lock.file, 'utf8');
    const afterRead = await fs.lstat(lock.file, { bigint: true });
    if (!sameIdentity(afterRead, lock.stat)) {
      throw lockError('the lock path was replaced while its token was checked; refusing to remove another owner\'s lock');
    }
    if (payload !== lock.payload) {
      throw lockError('the lock token changed while it was held; refusing to remove it');
    }
    verified = true;
  } catch (error) {
    errors.push(error?.message?.startsWith('State transaction lock:')
      ? error
      : lockError('could not verify the lock before release', error));
  }

  try { await lock.handle.close(); }
  catch (error) { errors.push(lockError('could not close the transaction lock', error)); }

  if (verified && errors.length === 0) {
    try {
      const pathStat = await fs.lstat(lock.file, { bigint: true });
      if (!sameIdentity(pathStat, lock.stat)) {
        throw lockError('the lock path was replaced before removal; refusing to remove another owner\'s lock');
      }
      await fs.unlink(lock.file);
    } catch (error) {
      errors.push(error?.message?.startsWith('State transaction lock:')
        ? error
        : lockError('could not remove the transaction lock', error));
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Releasing the state transaction lock failed');
}

export async function withStateTransactionLock(file, operation, options) {
  if (typeof operation !== 'function') throw lockError('operation must be a function');
  const settings = cleanOptions(options);
  const { stateFile, lockFile } = await resolveStatePaths(file);
  const lock = await acquire(lockFile, settings);
  let value;
  let failure = null;
  try {
    await existingRegularFile(stateFile, 'an existing state path');
    value = await operation(stateFile);
  }
  catch (error) { failure = error; }

  let releaseFailure = null;
  try { await release(lock); }
  catch (error) { releaseFailure = error; }

  if (failure && releaseFailure) {
    throw new AggregateError([failure, releaseFailure], 'State transaction and lock release both failed');
  }
  if (failure) throw failure;
  if (releaseFailure) throw releaseFailure;
  return value;
}
