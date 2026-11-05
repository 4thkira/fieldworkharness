import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readRoomSecret, ROOM_SECRET_LIMITS } from '../src/room-secret.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-room-secret-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'room-secret') };
}

test('room secrets are read through the bounded stable-file path', async t => {
  const data = await fixture(t);
  const secret = 'a'.repeat(43);
  assert.equal(await readRoomSecret(data.file), null);
  await fs.writeFile(data.file, `${secret}\n`);
  assert.equal(await readRoomSecret(data.file), secret);
});

test('oversized and malformed room secrets fail without echoing their source', async t => {
  const data = await fixture(t);
  const sentinel = 'DO_NOT_ECHO_ROOM_BEARER_123456789';
  await fs.writeFile(data.file, sentinel.repeat(8));
  await assert.rejects(readRoomSecret(data.file), error => {
    assert.match(error.message, /refused an unsafe room credential file/);
    assert.doesNotMatch(String(error.stack), /DO_NOT_ECHO/);
    return true;
  });
  await fs.writeFile(data.file, `${sentinel}\n`);
  await assert.rejects(readRoomSecret(data.file), error => {
    assert.match(error.message, /invalid shape/);
    assert.doesNotMatch(String(error.stack), /DO_NOT_ECHO/);
    return true;
  });
  assert.equal(ROOM_SECRET_LIMITS.fileBytes, 128);
});

test('linked room secrets are refused when file symlinks are available', async t => {
  const data = await fixture(t);
  const target = path.join(data.directory, 'target-secret');
  await fs.writeFile(target, `${'b'.repeat(43)}\n`);
  try { await fs.symlink(target, data.file, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`Windows did not permit a file symlink (${error.code})`);
      return;
    }
    throw error;
  }
  await assert.rejects(readRoomSecret(data.file), /refused an unsafe room credential file/);
});

test('a room secret replaced after opening is refused', async () => {
  const secret = 'c'.repeat(43);
  const stat = ino => ({
    dev: 1n, ino: BigInt(ino), size: 44n, mtimeNs: 2n, ctimeNs: 3n,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const opened = stat(10);
  const replacement = stat(11);
  let pathStats = 0;
  let reads = 0;
  const handle = {
    stat: async () => opened,
    async read(buffer, offset) {
      if (reads++) return { bytesRead: 0 };
      const source = Buffer.from(`${secret}\n`);
      source.copy(buffer, offset);
      return { bytesRead: source.length };
    },
    close: async () => {},
  };
  const io = {
    lstat: async () => (++pathStats === 1 ? opened : replacement),
    open: async () => handle,
  };
  await assert.rejects(
    readRoomSecret(path.resolve('synthetic-room-secret'), { io }),
    /changed while it was read/,
  );
});
