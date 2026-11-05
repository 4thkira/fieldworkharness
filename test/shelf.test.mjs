import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createShelf, SHELF_LIMITS } from '../src/shelf.mjs';

async function shelfDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-shelf-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'shelf');
}

test('things are shelved with who and when, taken down without loss, and survive a reload', async t => {
  const dir = await shelfDir(t);
  const shelf = await createShelf({ dir, clock: () => new Date('2030-01-02T03:04:05Z') });
  const picture = await shelf.put({ kind: 'picture', ref: 'a'.repeat(64), title: 'Synthetic print', note: 'fixture for shelf history', by: 'agent' });
  const text = await shelf.put({ kind: 'text', text: '# Field notes\nMoss grows slowly.', name: 'notes.md', title: 'Field notes', by: 'person' });
  assert.equal(shelf.view().length, 2);
  assert.equal(shelf.view()[0].id, text.id, 'newest first');
  assert.equal(picture.by, 'agent');
  assert.equal(await shelf.readText(text.id), '# Field notes\nMoss grows slowly.');

  const again = await shelf.put({ kind: 'picture', ref: 'a'.repeat(64), title: 'Synthetic print, relabelled', by: 'agent' });
  assert.equal(again.already, true, 'the same picture updates its label instead of doubling up');
  assert.equal(shelf.view().length, 2);

  await shelf.takeDown({ id: picture.id, by: 'agent' });
  assert.equal(shelf.view().find(row => row.id === picture.id).takenDown, true);
  assert.equal(shelf.view().length, 2, 'taken down is kept');

  const reloaded = await createShelf({ dir });
  assert.equal(reloaded.view().find(row => row.id === picture.id).title, 'Synthetic print, relabelled');
  await reloaded.putBack({ id: picture.id });
  assert.equal(reloaded.view().find(row => row.id === picture.id).takenDown, false);
  await reloaded.remove({ id: text.id });
  assert.equal(reloaded.view().length, 1);
  await assert.rejects(reloaded.readText(text.id), /nothing on the shelf has that id/);
});

test('the shelf refuses empty titles, oversized files and unknown kinds', async t => {
  const shelf = await createShelf({ dir: await shelfDir(t) });
  await assert.rejects(shelf.put({ kind: 'picture', ref: 'b'.repeat(64), title: '   ' }), /title must not be empty/);
  await assert.rejects(shelf.put({ kind: 'picture', ref: '../etc/passwd', title: 'x' }), /picture reference/);
  await assert.rejects(shelf.put({ kind: 'text', text: 'x'.repeat(SHELF_LIMITS.textBytes + 1), title: 'big' }), /at most 200 KB/);
  await assert.rejects(shelf.put({ kind: 'video', ref: 'c'.repeat(64), title: 'x' }), /picture or text/);
});
