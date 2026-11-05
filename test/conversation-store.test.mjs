import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationArchive, openConversationArchive } from '../src/conversation-archive.mjs';
import { conversationTitle, createConversationStore } from '../src/conversation-store.mjs';
import { createBridgeMessageOrigin, createMessageOrigin } from '../src/message-origin.mjs';

let tick = 0;
const clock = () => new Date(Date.UTC(2030, 0, 2, 3, 4, tick++));

// Archives opened in a test are closed before its folder is removed.
async function archiveFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-conversation-store-'));
  const open = [];
  t.after(async () => {
    for (const archive of open) { try { await archive.close(); } catch { /* Already closed. */ } }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { file: path.join(directory, 'conversation.jsonl'), keep: archive => { open.push(archive); return archive; } };
}

test('titles come from the first line of the first user message', () => {
  assert.equal(conversationTitle([{ role: 'system', content: 'x' }, { role: 'user', content: '  Hello\nthere  ' }]), 'Hello there');
  assert.equal(conversationTitle([{ role: 'assistant', content: 'hi' }]), '');
  assert.equal([...conversationTitle([{ role: 'user', content: 'é'.repeat(200) }])].length, 80);
  assert.equal(conversationTitle([{ role: 'user', content: [{ type: 'text', text: 'parts work' }] }]), 'parts work');
  const literal = '[Fieldwork check-in · 2030-01-02T03:04:05.000Z] literally my text';
  assert.equal(conversationTitle([{ role: 'user', content: literal }]), literal, 'prose is never treated as provenance');
  assert.equal(conversationTitle([{
    role: 'user', content: literal,
    fieldworkOrigin: createMessageOrigin({ kind: 'check-in', at: '2030-01-02T03:04:05.000Z' }),
  }]), 'Your agent checked in');
  assert.equal(conversationTitle([{
    role: 'user', content: 'The room opened unstructured time.',
    fieldworkOrigin: createMessageOrigin({ kind: 'free-time', at: '2030-01-02T03:04:05.000Z' }),
  }]), 'A free-time note from your agent');
  assert.equal(conversationTitle([{
    role: 'user', content: 'A literal bridge title',
    fieldworkOrigin: createBridgeMessageOrigin({
      platform: 'telegram', destinationId: '123', sourceUserId: '456', sourceMessageId: '789',
      at: '2030-01-02T03:04:05.000Z',
    }),
  }]), 'A literal bridge title');
});

test('conversations survive a restart exactly as committed, newest first', async t => {
  const { file, keep } = await archiveFile(t);
  let archive = await createConversationArchive(file, { archiveId: 'synthetic-archive' });
  let store = await createConversationStore({ archive, clock });
  assert.equal(store.persistent, true);
  assert.deepEqual(store.list(), []);

  const first = store.create();
  assert.equal(first.messageCount, 0);
  const turn = [
    { role: 'user', content: 'Tell me about moss.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'recall', arguments: '{"query":"moss"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { role: 'assistant', content: 'Moss has no roots.' },
  ];
  await store.commit(first.id, turn);
  const second = store.create();
  await store.commit(second.id, [{ role: 'user', content: 'Second chat' }, { role: 'assistant', content: 'Hi.' }]);
  const longer = [...turn, { role: 'user', content: 'More?' }, { role: 'assistant', content: 'Spores.' }];
  await store.commit(first.id, longer);
  assert.deepEqual(store.list().map(row => [row.title, row.messageCount]), [['Tell me about moss.', 6], ['Second chat', 2]]);
  await archive.close();

  archive = keep(await openConversationArchive(file));
  store = await createConversationStore({ archive, clock });
  assert.deepEqual(store.list().map(row => [row.id, row.title, row.messageCount]), [
    [first.id, 'Tell me about moss.', 6],
    [second.id, 'Second chat', 2],
  ]);
  assert.ok(store.list().every(row => row.proactiveMode === 'allow' && row.proactiveRevision === 0));
  assert.deepEqual(await store.messages(first.id), longer);
});

test('a commit cannot shrink a transcript, and unknown ids are refused', async t => {
  const { file, keep } = await archiveFile(t);
  const archive = keep(await createConversationArchive(file, { archiveId: 'synthetic-shrink' }));
  const store = await createConversationStore({ archive, clock });
  const { id } = store.create();
  await store.commit(id, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  await assert.rejects(store.commit(id, [{ role: 'user', content: 'a' }]), /cannot be shorter/);
  await assert.rejects(store.messages('conv-missing'), /no conversation has that id/);
  assert.equal(store.has('conv-missing'), false);
});

test('without an archive the store still works in memory', async () => {
  const store = await createConversationStore({ clock });
  assert.equal(store.persistent, false);
  const { id } = store.create();
  await store.commit(id, [{ role: 'user', content: 'only here' }, { role: 'assistant', content: 'ok' }]);
  assert.deepEqual(store.list().map(row => row.title), ['only here']);
  let current = store.list().find(row => row.id === id);
  await store.rename(id, '  Kept   here  ', { expectedRevision: current.titleRevision, actor: 'person' });
  assert.deepEqual(store.list().map(row => row.title), ['Kept here']);
  assert.equal((await store.messages(id)).length, 2);
});

test('custom titles survive restart and later messages never replace them', async t => {
  const { file, keep } = await archiveFile(t);
  let archive = await createConversationArchive(file, { archiveId: 'synthetic-titles' });
  let store = await createConversationStore({ archive, clock });
  const empty = store.create();
  let current = store.list().find(row => row.id === empty.id);
  await store.rename(empty.id, 'Untouched but named', { expectedRevision: current.titleRevision, actor: 'person' });
  await archive.close();

  archive = keep(await openConversationArchive(file));
  store = await createConversationStore({ archive, clock });
  assert.deepEqual(store.list().map(row => [row.id, row.title, row.messageCount]), [
    [empty.id, 'Untouched but named', 0],
  ]);
  await store.commit(empty.id, [{ role: 'user', content: 'This would normally become the title.' }]);
  assert.equal(store.list()[0].title, 'Untouched but named');
  current = store.list().find(row => row.id === empty.id);
  await store.rename(empty.id, 'Final title', { expectedRevision: current.titleRevision, actor: 'agent' });
  assert.equal(store.list()[0].title, 'Final title');
  assert.equal(store.list()[0].titleBy, 'agent');
  const beforeSameTitle = await archive.receipt();
  current = store.list().find(row => row.id === empty.id);
  await store.rename(empty.id, 'Final title', { expectedRevision: current.titleRevision, actor: 'person' });
  assert.equal((await archive.receipt()).events, beforeSameTitle.events, 'saving an unchanged custom title adds no archive event');
  await assert.rejects(store.rename(empty.id, 'Stale', { expectedRevision: 0, actor: 'person' }), /revision conflict/);
  await assert.rejects(store.rename('conv-missing', 'No', { expectedRevision: 0, actor: 'person' }), /no conversation has that id/);
  await assert.rejects(store.rename(empty.id, '   ', { expectedRevision: current.titleRevision, actor: 'person' }), /1-80 visible characters/);

  const cleared = await store.rename(empty.id, null, { expectedRevision: current.titleRevision, actor: 'person' });
  assert.equal(cleared.customTitle, false);
  assert.equal(cleared.title, 'This would normally become the title.');
  assert.equal(cleared.titleBy, 'person');
});

test('title edits keep conversation timestamps and ordering stable across restart', async t => {
  const { file, keep } = await archiveFile(t);
  let archiveNow = '2035-04-01T00:00:00.000Z';
  let storeNow = '2035-03-01T00:00:00.000Z';
  const archiveClock = () => new Date(archiveNow);
  const storeClock = () => new Date(storeNow);
  let archive = await createConversationArchive(file, { archiveId: 'stable-title-times', clock: archiveClock });
  let store = await createConversationStore({ archive, clock: storeClock });

  const first = store.create();
  let row = store.list().find(item => item.id === first.id);
  await store.rename(first.id, 'First title', { expectedRevision: row.titleRevision, actor: 'person' });
  const firstTimes = { createdAt: row.createdAt, updatedAt: row.updatedAt };

  storeNow = '2035-03-01T00:00:01.000Z';
  const second = store.create();
  await store.commit(second.id, [{ role: 'user', content: 'Second conversation' }]);
  assert.equal(store.list()[0].id, second.id);

  archiveNow = '2035-05-01T00:00:00.000Z';
  row = store.list().find(item => item.id === first.id);
  await store.rename(first.id, 'First title revised', { expectedRevision: row.titleRevision, actor: 'agent' });
  const beforeRestart = store.list();
  const firstBeforeRestart = beforeRestart.find(item => item.id === first.id);
  assert.deepEqual(
    { createdAt: firstBeforeRestart.createdAt, updatedAt: firstBeforeRestart.updatedAt },
    firstTimes,
  );
  assert.equal(beforeRestart[0].id, second.id, 'renaming is not conversation activity');
  await archive.close();

  archiveNow = '2035-06-01T00:00:00.000Z';
  archive = keep(await openConversationArchive(file, { clock: archiveClock }));
  store = await createConversationStore({ archive, clock: storeClock });
  assert.deepEqual(store.list(), beforeRestart);
});

test('archived conversations remain readable and renameable but reject commits until restored', async t => {
  const { file, keep } = await archiveFile(t);
  let archive = await createConversationArchive(file, { archiveId: 'conversation-lifecycle-store', clock });
  let store = await createConversationStore({ archive, clock });
  const first = store.create();
  await store.commit(first.id, [{ role: 'user', content: 'First retained conversation.' }]);
  const second = store.create();
  await store.commit(second.id, [{ role: 'user', content: 'Second active conversation.' }]);

  const firstBefore = store.get(first.id);
  const archived = await store.setArchived(first.id, true, {
    expectedRevision: firstBefore.lifecycleRevision, actor: 'person',
  });
  assert.equal(archived.archived, true);
  assert.equal(archived.lifecycleBy, 'person');
  assert.deepEqual(store.list({ archived: true }).map(row => row.id), [first.id]);
  assert.deepEqual(store.list({ archived: false }).map(row => row.id), [second.id]);
  assert.deepEqual(await store.messages(first.id), [{ role: 'user', content: 'First retained conversation.' }]);
  await assert.rejects(
    store.commit(first.id, [
      { role: 'user', content: 'First retained conversation.' },
      { role: 'assistant', content: 'This must not land.' },
    ]),
    /archived conversation cannot accept new messages/,
  );
  const renamed = await store.rename(first.id, 'Archived field notes', {
    expectedRevision: store.get(first.id).titleRevision, actor: 'agent',
  });
  assert.equal(renamed.title, 'Archived field notes');
  assert.equal(renamed.archived, true);

  const restored = await store.setArchived(first.id, false, {
    expectedRevision: renamed.lifecycleRevision, actor: 'person',
  });
  assert.equal(restored.archived, false);
  assert.equal(restored.archivedAt, null);
  await store.commit(first.id, [
    { role: 'user', content: 'First retained conversation.' },
    { role: 'assistant', content: 'This lands after restore.' },
  ]);
  await archive.close();

  archive = keep(await openConversationArchive(file));
  store = await createConversationStore({ archive, clock });
  const afterRestart = store.get(first.id);
  assert.equal(afterRestart.archived, false);
  assert.equal(afterRestart.title, 'Archived field notes');
  assert.equal(afterRestart.lifecycleRevision, restored.lifecycleRevision);
  assert.deepEqual((await store.messages(first.id)).map(message => message.content), [
    'First retained conversation.', 'This lands after restore.',
  ]);
});

test('automatic-check-in policy survives an empty-conversation restart, archive, and direct commits', async t => {
  const { file, keep } = await archiveFile(t);
  let archive = await createConversationArchive(file, { archiveId: 'conversation-proactive-store', clock });
  let store = await createConversationStore({ archive, clock });
  const conversation = store.create();

  const quiet = await store.setProactiveMode(conversation.id, 'suppress', {
    expectedRevision: store.get(conversation.id).proactiveRevision, actor: 'person',
  });
  assert.equal(quiet.proactiveMode, 'suppress');
  assert.equal(quiet.proactiveBy, 'person');
  assert.equal(store.allowsProactive(conversation.id), false);
  assert.equal(quiet.messageCount, 0);
  await archive.close();

  archive = await openConversationArchive(file);
  store = await createConversationStore({ archive, clock });
  const policyOnly = store.get(conversation.id);
  assert.equal(policyOnly.messageCount, 0);
  assert.equal(policyOnly.proactiveMode, 'suppress');
  assert.equal(policyOnly.proactiveRevision, quiet.proactiveRevision);
  await store.commit(conversation.id, [
    { role: 'user', content: 'A direct message.' },
    { role: 'assistant', content: 'Direct replies still land.' },
  ]);

  const archived = await store.setArchived(conversation.id, true, {
    expectedRevision: policyOnly.lifecycleRevision, actor: 'person',
  });
  const restored = await store.setArchived(conversation.id, false, {
    expectedRevision: archived.lifecycleRevision, actor: 'person',
  });
  assert.equal(restored.proactiveMode, 'suppress');
  await archive.close();

  archive = keep(await openConversationArchive(file));
  store = await createConversationStore({ archive, clock });
  const afterRestart = store.get(conversation.id);
  assert.equal(afterRestart.archived, false);
  assert.equal(afterRestart.proactiveMode, 'suppress');
  assert.equal(afterRestart.proactiveRevision, quiet.proactiveRevision);
  await assert.rejects(
    store.setProactiveMode(conversation.id, 'allow', { expectedRevision: 0, actor: 'person' }),
    /proactive revision conflict/,
  );
  const allowed = await store.setProactiveMode(conversation.id, 'allow', {
    expectedRevision: afterRestart.proactiveRevision, actor: 'agent',
  });
  assert.equal(allowed.proactiveMode, 'allow');
  assert.equal(allowed.proactiveBy, 'agent');
});

test('archive and commit are serialized so an archive cannot accept a partial later turn', async t => {
  const { file, keep } = await archiveFile(t);
  const archive = keep(await createConversationArchive(file, { archiveId: 'serialized-lifecycle-store', clock }));
  const store = await createConversationStore({ archive, clock });
  const conversation = store.create();
  const first = [{ role: 'user', content: 'One complete turn.' }];
  await store.commit(conversation.id, first);
  const current = store.get(conversation.id);
  const attempts = await Promise.allSettled([
    store.setArchived(conversation.id, true, { expectedRevision: current.lifecycleRevision, actor: 'person' }),
    store.commit(conversation.id, [...first, { role: 'assistant', content: 'A racing message.' }]),
  ]);
  assert.deepEqual(attempts.map(result => result.status), ['fulfilled', 'rejected']);
  assert.deepEqual(await store.messages(conversation.id), first);
  assert.equal((await archive.snapshot()).messages.length, 1);
  await assert.rejects(
    store.setArchived(conversation.id, false, { expectedRevision: 0, actor: 'person' }),
    /lifecycle revision conflict/,
  );

  const commitFirst = store.create();
  const commitFirstMessages = [
    { role: 'user', content: 'A commit that entered the queue first.' },
    { role: 'assistant', content: 'Its whole turn lands before the archive fence.' },
  ];
  const commitFirstRevision = store.get(commitFirst.id).lifecycleRevision;
  const commitFirstAttempts = await Promise.allSettled([
    store.commit(commitFirst.id, commitFirstMessages),
    store.setArchived(commitFirst.id, true, {
      expectedRevision: commitFirstRevision, actor: 'person',
    }),
  ]);
  assert.deepEqual(commitFirstAttempts.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(await store.messages(commitFirst.id), commitFirstMessages);
  assert.equal(store.get(commitFirst.id).archived, true);
});
