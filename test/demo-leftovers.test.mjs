import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/json-data.mjs';
import { DURABLE_WRITER_LOCK_FORMAT } from '../src/stale-state-locks.mjs';
import { removeAbandonedDemoFolders } from '../scripts/demo-leftovers.mjs';

const DEAD = 41_001;
const ALIVE = 41_002;
const processStatus = async pid => (pid === DEAD ? 'dead' : pid === ALIVE ? 'alive' : 'unknown');

async function writerLock(file, pid) {
  const value = { createdAt: new Date(0).toISOString(), format: DURABLE_WRITER_LOCK_FORMAT, pid, token: randomUUID() };
  await fs.writeFile(file, `${canonicalJson(value)}\n`);
}

async function demoFolder(base, suffix, { pid = DEAD, lock = true, extra = null } = {}) {
  const folder = path.join(base, `fieldwork-browser-demo-${suffix}`);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'conversation.jsonl'), '');
  await fs.writeFile(path.join(folder, 'memory.jsonl'), '');
  if (lock) {
    await writerLock(path.join(folder, 'conversation.jsonl.lock'), pid);
    await writerLock(path.join(folder, 'memory.jsonl.lock'), pid);
  }
  if (extra) await extra(folder);
  return folder;
}

const exists = async file => fs.lstat(file).then(() => true, () => false);

test('a new demo removes only earlier demo folders whose lock owners are gone', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-demo-sweep-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const abandoned = await demoFolder(base, 'Aband1');
  const live = await demoFolder(base, 'LiveO1', { pid: ALIVE });
  const lockless = await demoFolder(base, 'NoLck1', { lock: false });
  const nested = await demoFolder(base, 'Nestd1', { extra: folder => fs.mkdir(path.join(folder, 'keep-me')) });
  const malformed = await demoFolder(base, 'Malfm1', {
    extra: folder => fs.writeFile(path.join(folder, 'memory.jsonl.lock'), '{"not":"a fieldwork lock"}\n'),
  });
  const current = await demoFolder(base, 'Currn1');
  const unrelated = path.join(base, 'someone-elses-folder');
  await fs.mkdir(unrelated);
  await writerLock(path.join(unrelated, 'memory.jsonl.lock'), DEAD);

  const result = await removeAbandonedDemoFolders({ tmpdir: base, keep: current, processStatus });

  assert.deepEqual(result.removed, [abandoned]);
  assert.equal(await exists(abandoned), false);
  for (const folder of [live, lockless, nested, malformed, current, unrelated]) {
    assert.equal(await exists(folder), true, path.basename(folder));
  }
  assert.deepEqual([...result.kept].sort(), [lockless, live, malformed, nested].sort());
});

test('a missing temporary folder is not an error', async () => {
  const result = await removeAbandonedDemoFolders({ tmpdir: path.join(os.tmpdir(), `fieldwork-missing-${randomUUID()}`) });
  assert.deepEqual(result, { removed: [], kept: [] });
});
