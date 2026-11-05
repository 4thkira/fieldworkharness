import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { STATE_TRANSACTION_LOCK_FORMAT } from './cooperative-state-lock.mjs';
import { canonicalJson, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

export const DURABLE_WRITER_LOCK_FORMAT = 'fieldwork-writer-lock/v1';
export const DEPENDENCY_INSTALL_LOCK_FORMAT = 'fieldwork-dependency-install-lock/v1';
export const STATE_LOCK_RECOVERY_GUARD_FORMAT = 'fieldwork-lock-recovery-guard/v1';

export const KNOWN_STATE_LOCKS = Object.freeze([
  ...[
    'memory.jsonl.lock',
    'conversation.jsonl.lock',
    'reply-context.jsonl.lock',
    'external-delivery.jsonl.lock',
    'tool-effects.jsonl.lock',
  ].map(name => Object.freeze({ name, format: DURABLE_WRITER_LOCK_FORMAT })),
  ...[
    'check-ins.json.lock',
    'task-heartbeats.json.lock',
    'outside-readers.json.lock',
  ].map(name => Object.freeze({ name, format: STATE_TRANSACTION_LOCK_FORMAT })),
]);

const SUPPORTED_LOCK_FORMATS = new Set([
  DURABLE_WRITER_LOCK_FORMAT,
  STATE_TRANSACTION_LOCK_FORMAT,
  DEPENDENCY_INSTALL_LOCK_FORMAT,
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_LOCK_BYTES = 4 * 1024;

function recoveryError(message, cause) {
  const error = new Error(`Lock recovery: ${message}`, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, 'code', { value: 'FIELDWORK_LOCK_RECOVERY_FAILED', enumerable: true });
  return error;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBounded(handle, maximumBytes) {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let used = 0;
  while (used < buffer.length) {
    const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
    if (!bytesRead) break;
    used += bytesRead;
  }
  if (used > maximumBytes) return { overflow: true, source: null };
  return { overflow: false, source: buffer.subarray(0, used).toString('utf8') };
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
}

function metadataFrom(source, expectedFormat) {
  let value;
  try { value = parseJsonNoDuplicates(source, { where: 'state lock metadata', maxDepth: 4 }); }
  catch { return null; }
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join('\0') !== ['createdAt', 'format', 'pid', 'token'].join('\0')) return null;
  if (value.format !== expectedFormat) return null;
  if (typeof value.token !== 'string' || !UUID_V4.test(value.token)) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (!validTimestamp(value.createdAt)) return null;
  if (source !== `${canonicalJson(value)}\n`) return null;
  return value;
}

async function readLock(file, expectedFormat) {
  let pathStat;
  try { pathStat = await fs.lstat(file, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unsafe', reason: 'unreadable' };
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    return { status: 'unsafe', reason: 'not-regular' };
  }
  if (pathStat.size < 1n || pathStat.size > BigInt(MAXIMUM_LOCK_BYTES)) {
    return { status: 'unsafe', reason: 'invalid-size' };
  }

  let handle;
  try { handle = await fs.open(file, 'r'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { status: 'changed', reason: 'disappeared' };
    return { status: 'unsafe', reason: 'unreadable' };
  }
  try {
    const openedStat = await handle.stat({ bigint: true });
    if (!sameIdentity(pathStat, openedStat)) return { status: 'changed', reason: 'replaced' };
    const read = await readBounded(handle, MAXIMUM_LOCK_BYTES);
    if (read.overflow) return { status: 'unsafe', reason: 'invalid-size' };
    const source = read.source;
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(file, { bigint: true }),
    ]);
    if (!sameIdentity(pathStat, afterHandle) || !sameIdentity(pathStat, afterPath)) {
      return { status: 'changed', reason: 'replaced' };
    }
    if (afterHandle.size !== BigInt(Buffer.byteLength(source, 'utf8'))) {
      return { status: 'changed', reason: 'changed' };
    }
    const metadata = metadataFrom(source, expectedFormat);
    if (!metadata) return { status: 'unsafe', reason: 'invalid-metadata' };
    return { status: 'valid', stat: pathStat, source, metadata };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'changed', reason: 'disappeared' };
    return { status: 'unsafe', reason: 'unreadable' };
  } finally {
    try { await handle.close(); } catch { /* Inspection remains fail-closed. */ }
  }
}

function defaultProcessStatus(pid) {
  if (pid === process.pid) return 'alive';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function cleanOptions(value) {
  if (value === undefined) return { processStatus: defaultProcessStatus, onPhase: null };
  if (!isPlainObject(value)) throw recoveryError('options must be an object');
  const allowed = new Set(['processStatus', 'onPhase']);
  const options = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw recoveryError(`options has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw recoveryError(`options.${key} must be an enumerable data property`);
    }
    options[key] = descriptor.value;
  }
  const processStatus = options.processStatus ?? defaultProcessStatus;
  const onPhase = options.onPhase ?? null;
  if (typeof processStatus !== 'function') throw recoveryError('options.processStatus must be a function');
  if (onPhase !== null && typeof onPhase !== 'function') throw recoveryError('options.onPhase must be a function');
  return { processStatus, onPhase };
}

async function processState(probe, pid) {
  let state;
  try { state = await probe(pid); }
  catch (error) { throw recoveryError('could not check whether the lock owner is running', error); }
  if (!['alive', 'dead', 'unknown'].includes(state)) {
    throw recoveryError('the process-status probe returned an unknown result');
  }
  return state;
}

async function acquireGuard(file) {
  const token = randomUUID();
  let handle;
  let openedStat;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw recoveryError('could not create the recovery guard', error);
  }
  try {
    openedStat = await handle.stat({ bigint: true });
    const payload = `${canonicalJson({
      format: STATE_LOCK_RECOVERY_GUARD_FORMAT,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`;
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    const pathStat = await fs.lstat(file, { bigint: true });
    if (!sameIdentity(stat, pathStat)) throw recoveryError('the recovery guard path changed during creation');
    return { file, handle, stat, payload, token };
  } catch (error) {
    try { await handle.close(); } catch { /* Preserve the initialization failure. */ }
    if (openedStat) {
      try {
        const pathStat = await fs.lstat(file, { bigint: true });
        if (sameIdentity(pathStat, openedStat)) await fs.unlink(file);
      } catch { /* Never remove an unverified path. */ }
    }
    throw error?.code === 'FIELDWORK_LOCK_RECOVERY_FAILED'
      ? error
      : recoveryError('could not initialize the recovery guard', error);
  }
}

async function releaseGuard(guard) {
  const failures = [];
  let verified = false;
  try {
    const [pathStat, handleStat] = await Promise.all([
      fs.lstat(guard.file, { bigint: true }),
      guard.handle.stat({ bigint: true }),
    ]);
    if (!sameIdentity(pathStat, guard.stat) || !sameIdentity(handleStat, guard.stat)) {
      throw recoveryError('the recovery guard path was replaced; refusing to remove another owner\'s guard');
    }
    if (handleStat.size !== BigInt(Buffer.byteLength(guard.payload, 'utf8'))) {
      throw recoveryError('the recovery guard payload changed; refusing to remove it');
    }
    let reader;
    try {
      reader = await fs.open(guard.file, 'r');
      const readerStat = await reader.stat({ bigint: true });
      if (!sameIdentity(readerStat, guard.stat)) {
        throw recoveryError('the recovery guard path was replaced before its token could be checked');
      }
      const read = await readBounded(reader, Buffer.byteLength(guard.payload, 'utf8'));
      const [afterReader, afterPath] = await Promise.all([
        reader.stat({ bigint: true }),
        fs.lstat(guard.file, { bigint: true }),
      ]);
      if (!sameIdentity(afterReader, guard.stat)
        || !sameIdentity(afterPath, guard.stat)
        || read.overflow
        || read.source !== guard.payload) {
        throw recoveryError('the recovery guard token changed; refusing to remove it');
      }
    } finally {
      if (reader) await reader.close();
    }
    verified = true;
  } catch (error) {
    failures.push(error?.code === 'FIELDWORK_LOCK_RECOVERY_FAILED'
      ? error
      : recoveryError('could not verify the recovery guard before release', error));
  }

  try { await guard.handle.close(); }
  catch (error) { failures.push(recoveryError('could not close the recovery guard', error)); }

  if (verified && failures.length === 0) {
    try {
      const pathStat = await fs.lstat(guard.file, { bigint: true });
      if (!sameIdentity(pathStat, guard.stat)) {
        throw recoveryError('the recovery guard path was replaced before removal; refusing to remove it');
      }
      await fs.unlink(guard.file);
    } catch (error) {
      failures.push(error?.code === 'FIELDWORK_LOCK_RECOVERY_FAILED'
        ? error
        : recoveryError('could not remove the recovery guard', error));
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw recoveryError('recovery guard release failed', new AggregateError(failures));
  }
}

function retained(file, reason, extra = {}) {
  return Object.freeze({ file, status: 'retained', reason, ...extra });
}

async function attemptRecovery(file, expectedFormat, guard, options) {
  const first = await readLock(file, expectedFormat);
  if (first.status === 'missing') return Object.freeze({ file, status: 'missing' });
  if (first.status !== 'valid') return retained(file, first.status === 'unsafe' ? first.reason : 'changed');

  const owner = await processState(options.processStatus, first.metadata.pid);
  if (owner === 'alive') return retained(file, 'live-process', { pid: first.metadata.pid, format: expectedFormat });
  if (owner === 'unknown') return retained(file, 'unknown-process', { pid: first.metadata.pid, format: expectedFormat });

  if (options.onPhase) {
    await options.onPhase(Object.freeze({
      phase: 'validated', file, guardFile: guard.file, pid: first.metadata.pid, format: expectedFormat,
    }));
  }

  const checked = await readLock(file, expectedFormat);
  if (checked.status !== 'valid'
    || !sameIdentity(first.stat, checked.stat)
    || first.source !== checked.source) {
    return retained(file, 'changed', { pid: first.metadata.pid, format: expectedFormat });
  }

  const quarantineFile = `${file}.recovered-${guard.token}`;
  try { await fs.rename(file, quarantineFile); }
  catch (error) {
    if (error?.code === 'ENOENT') return retained(file, 'changed', { pid: first.metadata.pid, format: expectedFormat });
    throw recoveryError('could not quarantine the verified stale lock', error);
  }

  const quarantined = await readLock(quarantineFile, expectedFormat);
  if (quarantined.status !== 'valid'
    || !sameIdentity(first.stat, quarantined.stat)
    || first.source !== quarantined.source) {
    throw recoveryError(`the quarantined lock could not be verified; it was preserved at ${quarantineFile}`);
  }

  if (options.onPhase) {
    await options.onPhase(Object.freeze({
      phase: 'quarantined', file, quarantineFile, guardFile: guard.file,
      pid: first.metadata.pid, format: expectedFormat,
    }));
  }

  const final = await readLock(quarantineFile, expectedFormat);
  if (final.status !== 'valid'
    || !sameIdentity(first.stat, final.stat)
    || first.source !== final.source) {
    throw recoveryError(`the quarantined lock changed before removal; it was preserved at ${quarantineFile}`);
  }
  try { await fs.unlink(quarantineFile); }
  catch (error) { throw recoveryError(`could not remove the verified quarantine ${quarantineFile}`, error); }
  return Object.freeze({
    file, status: 'recovered', pid: first.metadata.pid, format: expectedFormat,
  });
}

export async function recoverAbandonedLock(file, expectedFormat, rawOptions) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw recoveryError('file must be an absolute path');
  if (!SUPPORTED_LOCK_FORMATS.has(expectedFormat)) throw recoveryError('expectedFormat is not a supported Fieldwork lock format');
  const options = cleanOptions(rawOptions);
  let exists;
  try { exists = await fs.lstat(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ file, status: 'missing' });
    throw recoveryError('could not inspect the lock path', error);
  }
  if (!exists) return Object.freeze({ file, status: 'missing' });

  const guard = await acquireGuard(`${file}.recovery`);
  if (!guard) return retained(file, 'recovery-busy');

  let result;
  let failure = null;
  try { result = await attemptRecovery(file, expectedFormat, guard, options); }
  catch (error) {
    failure = error?.code === 'FIELDWORK_LOCK_RECOVERY_FAILED'
      ? error
      : recoveryError('lock recovery failed', error);
  }

  let releaseFailure = null;
  try { await releaseGuard(guard); }
  catch (error) { releaseFailure = error; }

  if (failure && releaseFailure) {
    throw recoveryError('lock recovery and guard release both failed', new AggregateError([failure, releaseFailure]));
  }
  if (failure) throw failure;
  if (releaseFailure) throw releaseFailure;
  return result;
}

export const recoverAbandonedStateLock = recoverAbandonedLock;

function stateDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw recoveryError('stateDir must be an absolute path');
  }
  return path.resolve(value);
}

export async function recoverAbandonedStateLocks(stateDir, rawOptions) {
  const directory = stateDirectory(stateDir);
  const results = [];
  for (const spec of KNOWN_STATE_LOCKS) {
    results.push(await recoverAbandonedLock(path.join(directory, spec.name), spec.format, rawOptions));
  }
  return Object.freeze({
    recovered: Object.freeze(results.filter(row => row.status === 'recovered')),
    retained: Object.freeze(results.filter(row => row.status === 'retained')),
  });
}

async function pathExists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    return true;
  }
}

export async function inspectStateLocks(stateDir, rawOptions) {
  const directory = stateDirectory(stateDir);
  const options = cleanOptions(rawOptions);
  const rows = [];
  for (const spec of KNOWN_STATE_LOCKS) {
    const file = path.join(directory, spec.name);
    const guardFile = `${file}.recovery`;
    const [lock, guardPresent] = await Promise.all([
      readLock(file, spec.format),
      pathExists(guardFile),
    ]);
    if (lock.status === 'missing' && !guardPresent) continue;
    let owner = null;
    if (lock.status === 'valid') owner = await processState(options.processStatus, lock.metadata.pid);
    rows.push(Object.freeze({
      file,
      guardFile,
      guardPresent,
      status: lock.status,
      reason: lock.reason ?? null,
      format: spec.format,
      pid: lock.status === 'valid' ? lock.metadata.pid : null,
      owner,
    }));
  }
  return Object.freeze(rows);
}

export async function stateLockAdvice(stateDir) {
  const rows = await inspectStateLocks(stateDir);
  if (!rows.length) return '';
  const lines = ['This agent home\'s state is locked:'];
  for (const row of rows) {
    if (row.status === 'valid') {
      lines.push(row.owner === 'alive'
        ? `  ${row.file}\n    held by process ${row.pid}, which is still running. Another room may be using this agent home.`
        : row.owner === 'dead'
          ? `  ${row.file}\n    names process ${row.pid}, which is not running on this computer, but guarded recovery could not safely finish.`
          : `  ${row.file}\n    names process ${row.pid}, whose status could not be verified; the lock was preserved.`);
    } else if (row.status !== 'missing') {
      lines.push(`  ${row.file}\n    could not be verified as a Fieldwork lock and was preserved for inspection.`);
    }
    if (row.guardPresent) {
      lines.push(`  ${row.guardFile}\n    a recovery guard exists; another launcher may be cleaning up, or an earlier cleanup was interrupted.`);
    }
  }
  lines.push(
    'Do not remove a lock held by a running process. If every Fieldwork room and launcher is stopped, inspect the named files before removing only the stale lock or recovery guard.',
    'Stopping a room with Ctrl+C or the room Stop button releases its locks cleanly.',
  );
  return lines.join('\n');
}

export function isStateLockFailure(error) {
  const seen = new Set();
  const visit = value => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return false;
    seen.add(value);
    const message = String(value.message ?? '');
    if (value.code === 'FIELDWORK_STATE_BUSY' || value.code === 'FIELDWORK_LOCK_RECOVERY_FAILED') return true;
    if (/writer lock already exists|State transaction lock:.*remained busy/u.test(message)) return true;
    if (value instanceof AggregateError && value.errors.some(visit)) return true;
    return visit(value.cause);
  };
  return visit(error);
}
