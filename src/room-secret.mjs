import path from 'node:path';
import { readStableFile, StableFileReadError } from './stable-file-read.mjs';

export const ROOM_SECRET_LIMITS = Object.freeze({ fileBytes: 128 });

// A bearer is tiny, but it is also the password to the local room. Read it
// through one verified regular-file handle, never through an unbounded helper
// that can follow a replaced link or echo source text in a parse error.
export async function readRoomSecret(file, { label = 'room', io } = {}) {
  const target = path.resolve(file);
  let bytes;
  try {
    bytes = await readStableFile(target, {
      maxBytes: ROOM_SECRET_LIMITS.fileBytes,
      allowMissing: true,
      label: `room credential file (${label})`,
      ...(io ? { io } : {}),
    });
  }
  catch (error) {
    if (!(error instanceof StableFileReadError)) throw error;
    if (['unsafe', 'oversized'].includes(error.reason)) {
      throw new Error(`Room secret reader refused an unsafe room credential file (${label})`);
    }
    if (error.reason === 'changed-before') throw new Error(`Room credential file changed before it could be read (${label})`);
    if (error.reason === 'changed-during') throw new Error(`Room credential file changed while it was read (${label})`);
    const action = error.reason === 'open' ? 'opened' : 'inspected';
    throw new Error(`Room credential file could not be ${action} safely (${label})`, { cause: error });
  }
  if (bytes === null) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`Room credential file is not valid UTF-8 (${label})`); }
  const match = /^([A-Za-z0-9_-]{43})(?:\r?\n)?$/.exec(text);
  if (!match) throw new Error(`Room credential file has an invalid shape (${label})`);
  return match[1];
}
