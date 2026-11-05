import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { builderNoteTools, createBuilderNotes } from '../src/builder-notes.mjs';
import { createToolRegistry, executeTool, prepareToolCall } from '../src/tools.mjs';

async function notesFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-notes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'state', 'builder-notes.json');
}

test('the agent sends a note, the person answers, and the agent can read the answer', async t => {
  const file = await notesFile(t);
  const notes = await createBuilderNotes({ file, clock: () => new Date('2030-01-02T03:04:05Z') });
  const tools = createToolRegistry(builderNoteTools(notes));
  const summary = prepareToolCall(tools, 'tell_my_builder', {
    what: 'PRIVATE SYNTHETIC BUILDER SUMMARY', detail: 'PRIVATE SYNTHETIC BUILDER DETAIL', kind: 'broken',
  }).permissionSummary;
  assert.match(summary, /one broken room note/);
  assert.doesNotMatch(summary, /PRIVATE SYNTHETIC/);
  await executeTool(tools, 'tell_my_builder', { what: 'The shelf tab is empty after a restart', detail: 'I shelved two things; after restarting I see none.', kind: 'broken' });
  assert.equal(notes.unread(), 1);
  const again = await executeTool(tools, 'tell_my_builder', { what: 'the shelf tab is EMPTY after a restart' });
  assert.match(again.note, /already sent/);
  assert.equal(notes.view().length, 1, 'the same open note is not doubled');

  const [note] = notes.view();
  await notes.answer({ id: note.id, status: 'done', reply: 'Fixed, thank you!' });
  assert.equal(notes.unread(), 0);
  const seen = await executeTool(tools, 'my_notes_to_builder', {});
  assert.deepEqual(seen.notes.map(row => [row.status, row.reply]), [['done', 'Fixed, thank you!']]);

  const reloaded = await createBuilderNotes({ file });
  assert.equal(reloaded.view()[0].reply, 'Fixed, thank you!');
});

test('notes are bounded: kinds, lengths, and at most ten new ones a day', async t => {
  const notes = await createBuilderNotes({ file: await notesFile(t), clock: () => new Date('2030-01-02T03:04:05Z') });
  await assert.rejects(notes.send({ what: '   ' }), /must not be empty/);
  await assert.rejects(notes.send({ what: 'x', kind: 'rant' }), /kind is one of/);
  await assert.rejects(notes.send({ what: 'x'.repeat(201) }), /at most 200/);
  for (let index = 0; index < 10; index += 1) await notes.send({ what: `note ${index}` });
  await assert.rejects(notes.send({ what: 'note 11' }), /at most 10 new notes a day/);
  await assert.rejects(notes.answer({ id: 'note-nope', status: 'done' }), /no note has that id/);
});
