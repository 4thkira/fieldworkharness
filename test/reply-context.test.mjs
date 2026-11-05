import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createReplyContextEntry,
  createReplyContextStore,
  isReplyContextEntry,
  isReplyContextStore,
  openReplyContextStore,
  restoreReplyContextEntry,
} from '../src/reply-context.mjs';

const at = '2032-03-04T05:06:07.000Z';
const clock = () => new Date(at);
const messageSha256 = 'a'.repeat(64);

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-reply-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'reply-context.jsonl');
}

function input(context = { format: 'fieldwork-reply-input-receipt/v1', conversation: { historyMessages: 2 } }) {
  return { conversationId: 'conversation-1', messageId: 'm000003', messageSha256, observedAt: at, context };
}

test('reply input receipts stay outside messages and survive a verified restart', async t => {
  const file = await temporary(t);
  const context = { format: 'fieldwork-reply-input-receipt/v1', roots: [{ id: 'synthetic-root', version: 'b'.repeat(64) }] };
  const store = await createReplyContextStore(file, { id: 'synthetic-reply-contexts', clock });
  assert.equal(isReplyContextStore(store), true);
  const recorded = await store.record(input(context));
  context.roots[0].id = 'changed-after-record';
  assert.equal(isReplyContextEntry(recorded), true);
  assert.equal(recorded.context.roots[0].id, 'synthetic-root');
  assert.equal((await store.lookup('conversation-1', 'm000003')).fingerprint, recorded.fingerprint);
  assert.deepEqual(await store.forConversation('conversation-1'), [recorded]);
  const head = (await store.receipt()).head;
  await store.close();

  const reopened = await openReplyContextStore(file, {
    expectedId: 'synthetic-reply-contexts', expectedHead: head, clock,
  });
  assert.equal((await reopened.lookup('conversation-1', 'm000003')).fingerprint, recorded.fingerprint);
  assert.equal((await reopened.forConversation('missing-conversation')).length, 0);
  await reopened.close();
});

test('one immutable reply can have only one input receipt', async t => {
  const file = await temporary(t);
  const store = await createReplyContextStore(file, { id: 'conflict-contexts', clock });
  await store.record(input());
  const before = await store.receipt();
  await assert.rejects(store.record(input({ format: 'fieldwork-reply-input-receipt/v1', changed: true })), /already exists/);
  assert.equal((await store.receipt()).head, before.head);
  assert.equal((await store.forConversation('conversation-1')).length, 1);
  await store.close();
});

test('restoration detects changed context and entries reject unknown fields', () => {
  const entry = createReplyContextEntry(input());
  const stored = JSON.parse(JSON.stringify(entry));
  assert.equal(isReplyContextEntry(stored), false);
  assert.equal(restoreReplyContextEntry(stored).fingerprint, entry.fingerprint);
  stored.context.conversation.historyMessages = 99;
  assert.throws(() => restoreReplyContextEntry(stored), /fingerprint does not match/);
  assert.throws(() => createReplyContextEntry({ ...input(), extra: true }), /unknown field/);
});
