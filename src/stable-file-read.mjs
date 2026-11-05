import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class StableFileReadError extends Error {
  constructor(reason, label, cause) {
    const messages = {
      inspect: `${label} could not be inspected safely`,
      unsafe: `${label} is linked or is not a regular file`,
      oversized: `${label} is too large`,
      open: `${label} could not be opened safely`,
      'changed-before': `${label} changed before it could be read`,
      'changed-during': `${label} changed while it was read`,
    };
    super(messages[reason] ?? `${label} could not be read safely`, cause === undefined ? undefined : { cause });
    this.name = 'StableFileReadError';
    this.reason = reason;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function readStableFile(file, {
  maxBytes,
  allowMissing = false,
  label = 'file',
  io = fs,
} = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('stable file path must be absolute');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('stable file maxBytes must be a positive safe integer');
  const target = path.resolve(file);
  let before;
  try { before = await io.lstat(target, { bigint: true }); }
  catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw new StableFileReadError('inspect', label, error);
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new StableFileReadError('unsafe', label);
  if (before.size > BigInt(maxBytes)) throw new StableFileReadError('oversized', label);

  let handle;
  try { handle = await io.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch (error) { throw new StableFileReadError('open', label, error); }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new StableFileReadError('changed-before', label);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) throw new StableFileReadError('oversized', label);
    const afterHandle = await handle.stat({ bigint: true });
    let afterPath;
    try { afterPath = await io.lstat(target, { bigint: true }); }
    catch (error) { throw new StableFileReadError('changed-during', label, error); }
    if (!sameFile(opened, afterHandle) || !sameFile(opened, afterPath)) {
      throw new StableFileReadError('changed-during', label);
    }
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
