import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationArchive } from '../src/conversation-archive.mjs';
import { conversationSearchTools, searchConversationArchive } from '../src/conversation-search.mjs';
import { createMessageOrigin } from '../src/message-origin.mjs';
import { createToolRegistry, executeTool } from '../src/tools.mjs';

const at = index => `2030-01-02T03:04:0${index}.000Z`;
const clock = () => new Date('2030-01-03T04:05:06.000Z');

async function archiveWithMessages(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-conversation-search-'));
  const archive = await createConversationArchive(path.join(directory, 'conversation.jsonl'), {
    archiveId: 'synthetic-search-archive', clock,
  });
  t.after(async () => { await archive.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await archive.append({
    conversationId: 'conversation-one', messageId: 'm000001', observedAt: at(1),
    message: { role: 'user', content: 'The cobalt latch is blue.' },
  });
  await archive.append({
    conversationId: 'conversation-one', messageId: 'm000002', observedAt: at(2),
    message: { role: 'assistant', content: 'I remember the blue latch.' },
  });
  await archive.append({
    conversationId: 'conversation-two', messageId: 'm000001', observedAt: at(3),
    message: {
      role: 'user', content: 'Hidden room prompt mentions blue and should not look like the person.',
      fieldworkOrigin: createMessageOrigin({ kind: 'free-time', at: at(3) }),
    },
  });
  await archive.append({
    conversationId: 'conversation-two', messageId: 'm000002', observedAt: at(4),
    message: { role: 'assistant', content: 'A moss note from free time.' },
  });
  return archive;
}

test('conversation search returns exact attributed excerpts without treating room prompts as speech', async t => {
  const archive = await archiveWithMessages(t);
  const found = await searchConversationArchive(archive, { query: 'cobalt latch' }, { clock });
  assert.equal(found.returned, 1);
  assert.equal(found.complete, true);
  assert.equal(found.results[0].speaker, 'person');
  assert.equal(found.results[0].evidence.excerpt, 'The cobalt latch is blue.');
  assert.equal(found.results[0].evidence.source.kind, 'conversation');
  assert.equal(found.results[0].evidence.source.locator, 'm000001');
  assert.equal(found.results[0].observedAt, at(1));
  assert.equal(found.results[0].evidence.source.observedThrough, at(1));
  assert.equal(found.results[0].evidence.retrievedAt, clock().toISOString());
  assert.notEqual(found.results[0].evidence.source.observedThrough, found.results[0].evidence.retrievedAt);
  assert.equal(found.results[0].evidence.retrieval.method, 'exact');
  assert.match(found.results[0].evidence.retrieval.queryHash, /^[0-9a-f]{64}$/);

  const hidden = await searchConversationArchive(archive, { query: 'Hidden room prompt' }, { clock });
  assert.equal(hidden.returned, 0);
  assert.equal((await searchConversationArchive(archive, { query: 'lat' }, { clock })).returned, 0, 'one word does not match inside another');
  await assert.rejects(searchConversationArchive(archive, { query: { forged: true } }, { clock }), /query must be text/);
});

test('conversation search paginates newest matches with a stable archive cursor', async t => {
  const archive = await archiveWithMessages(t);
  const registry = createToolRegistry(conversationSearchTools({ archive, clock }));
  const first = await executeTool(registry, 'search_conversations', { query: 'blue', limit: 1 });
  assert.equal(first.returned, 1);
  assert.equal(first.results[0].speaker, 'agent');
  assert.equal(first.complete, false);
  assert.equal(first.nextBeforeSequence, 3);

  const second = await executeTool(registry, 'search_conversations', {
    query: 'blue', limit: 1, beforeSequence: first.nextBeforeSequence,
  });
  assert.equal(second.returned, 1);
  assert.equal(second.results[0].speaker, 'person');
  assert.equal(second.complete, true);

  const narrowed = await executeTool(registry, 'search_conversations', {
    query: 'moss', speaker: 'agent', conversationId: 'conversation-two',
  });
  assert.equal(narrowed.returned, 1);
  assert.equal(narrowed.results[0].conversationId, 'conversation-two');
  await assert.rejects(
    executeTool(registry, 'search_conversations', { query: 'blue', limit: 21 }),
    /maximum|20/,
  );
});

test('conversation search retains archived evidence and labels its lifecycle state', async t => {
  const archive = await archiveWithMessages(t);
  await archive.setArchived({
    conversationId: 'conversation-one',
    archived: true,
    expectedRevision: 0,
    actor: 'person',
    conversationCreatedAt: at(1),
    conversationUpdatedAt: at(2),
  });
  const archived = await searchConversationArchive(archive, { query: 'blue' }, { clock });
  assert.equal(archived.returned, 2);
  assert.ok(archived.results.every(result => result.conversationId === 'conversation-one' && result.archived === true));
  const active = await searchConversationArchive(archive, { query: 'moss' }, { clock });
  assert.equal(active.results[0].conversationId, 'conversation-two');
  assert.equal(active.results[0].archived, false);
  assert.equal(active.results[0].evidence.source.kind, 'conversation');
});
