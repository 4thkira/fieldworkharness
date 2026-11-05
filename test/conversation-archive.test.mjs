import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONVERSATION_ARCHIVE_EVENT_FORMAT, CONVERSATION_ARCHIVE_SNAPSHOT_FORMAT,
  CONVERSATION_ENTRY_FORMAT, CONVERSATION_LOOKUP_RECEIPT_FORMAT, CONVERSATION_SOURCE_ID_FORMAT,
  createConversationArchive, createConversationEntry, isConversationArchive,
  isConversationEntry, openConversationArchive, restoreConversationEntry,
} from '../src/conversation-archive.mjs';
import { openDurableLog } from '../src/durable-log.mjs';
import { isSourceReference } from '../src/provenance.mjs';

const at = '2030-01-02T03:04:05.000Z';
const clock = () => new Date(at);

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-conversation-archive-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'conversation.jsonl');
}

function messageEntry(messageId = 'message-1', message = { role: 'user', content: 'Synthetic hello.' }) {
  return createConversationEntry({ conversationId: 'conversation-1', messageId, observedAt: at, message });
}

function titleChange(title, expectedRevision, actor = 'person', overrides = {}) {
  return {
    conversationId: 'conversation-1', title, expectedRevision, actor,
    conversationCreatedAt: at, conversationUpdatedAt: at,
    ...overrides,
  };
}

function lifecycleChange(archived, expectedRevision, actor = 'person', overrides = {}) {
  return {
    conversationId: 'conversation-1', archived, expectedRevision, actor,
    conversationCreatedAt: at, conversationUpdatedAt: at,
    ...overrides,
  };
}

function proactiveChange(mode, expectedRevision, actor = 'person', overrides = {}) {
  return {
    conversationId: 'conversation-1', mode, expectedRevision, actor,
    conversationCreatedAt: at, conversationUpdatedAt: at,
    ...overrides,
  };
}

test('raw bounded messages archive literally and produce source references without becoming memories', async t => {
  const file = await temporary(t);
  const sourceMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Literal marker <<<FIELDWORK_ROOTS>>> stays evidence.' },
      { type: 'synthetic_image', image: { id: 'image-1' } },
    ],
  };
  const archive = await createConversationArchive(file, { archiveId: 'synthetic-archive', clock });
  assert.equal(isConversationArchive(archive), true);
  const result = await archive.append({
    conversationId: 'conversation-1', messageId: 'message-1', observedAt: at, message: sourceMessage,
  });
  sourceMessage.content[0].text = 'Mutated after append.';
  assert.equal(isConversationEntry(result.entry), true);
  assert.equal(isSourceReference(result.source), true);
  assert.equal(result.source.kind, 'conversation');
  assert.equal(
    result.source.id,
    `${CONVERSATION_SOURCE_ID_FORMAT};archive=synthetic-archive;conversation=conversation-1`,
  );
  assert.equal(result.source.locator, 'message-1');
  assert.match(result.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.source.observedThrough, at);
  const stored = await fs.readFile(file, 'utf8');
  assert.match(stored, /Literal marker/);
  assert.doesNotMatch(stored, /Mutated after append/);
  await archive.close();
});

test('restart restores an index and branded references without retaining raw message prose in the snapshot', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'restart-archive', clock });
  const first = await archive.append(messageEntry('message-1'));
  await archive.append(messageEntry('message-2', { role: 'assistant', content: 'Synthetic answer.' }));
  const head = (await archive.receipt()).head;
  await archive.close();

  const reopened = await openConversationArchive(file, {
    expectedArchiveId: 'restart-archive', expectedHead: head, clock,
  });
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.format, CONVERSATION_ARCHIVE_SNAPSHOT_FORMAT);
  assert.deepEqual(snapshot.totals, { conversations: 1, messages: 2 });
  assert.equal(snapshot.messages[0].message, undefined);
  assert.equal(snapshot.messages[0].messageSha256, first.entry.messageSha256);
  const reference = await reopened.reference('conversation-1', 'message-1');
  assert.equal(isSourceReference(reference), true);
  assert.equal(reference.fingerprint, first.source.fingerprint);
  assert.equal(reference.observedThrough, first.entry.observedAt);
  const lookup = await reopened.lookup('conversation-1', 'message-1');
  assert.equal(isConversationEntry(lookup.entry), true);
  assert.deepEqual(lookup.entry.message, { role: 'user', content: 'Synthetic hello.' });
  assert.equal(lookup.source.fingerprint, first.source.fingerprint);
  assert.equal(lookup.source.observedThrough, first.entry.observedAt);
  assert.equal(lookup.receipt.format, CONVERSATION_LOOKUP_RECEIPT_FORMAT);
  assert.equal(lookup.receipt.found, true);
  assert.deepEqual(lookup.receipt.target, { conversationId: 'conversation-1', messageId: 'message-1' });
  assert.equal(lookup.receipt.archive.archiveId, 'restart-archive');
  assert.equal(lookup.receipt.archive.head, head);
  assert.equal(lookup.receipt.event.sequence, 2);
  assert.equal(lookup.receipt.entry.fingerprint, first.entry.fingerprint);
  assert.equal(lookup.receipt.entry.messageSha256, first.entry.messageSha256);
  assert.equal(lookup.receipt.sourceFingerprint, first.source.fingerprint);
  assert.doesNotMatch(JSON.stringify(lookup.receipt), /Synthetic hello/);
  const missing = await reopened.lookup('conversation-1', 'missing');
  assert.equal(missing.entry, null);
  assert.equal(missing.source, null);
  assert.equal(missing.receipt.found, false);
  assert.deepEqual(missing.receipt.target, { conversationId: 'conversation-1', messageId: 'missing' });
  assert.equal(missing.receipt.archive.head, head);
  const otherMissing = await reopened.lookup('conversation-2', 'missing');
  assert.equal(otherMissing.receipt.archive.head, head);
  assert.notDeepEqual(otherMissing.receipt.target, missing.receipt.target);
  assert.notDeepEqual(otherMissing.receipt, missing.receipt);
  await reopened.close();
  await assert.rejects(reopened.lookup('conversation-1', 'message-1'), /after close has begun/);
  await assert.rejects(reopened.reference('conversation-1', 'message-1'), /after close has begun/);
  await assert.rejects(reopened.snapshot(), /after close has begun/);
});

test('conversation titles are append-only metadata whose latest value survives restart', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'title-archive', clock });
  const first = await archive.setTitle(titleChange('  First   field notes  ', 0));
  await archive.append(messageEntry());
  const second = await archive.setTitle(titleChange('Moss & moonlight', first.titleRevision, 'agent'));
  let snapshot = await archive.snapshot();
  assert.deepEqual(snapshot.totals, { conversations: 1, messages: 1 });
  assert.deepEqual(snapshot.titles.map(row => [
    row.conversationId, row.title, row.customTitle, row.titleRevision, row.titleBy,
    row.conversationCreatedAt, row.conversationUpdatedAt,
  ]), [
    ['conversation-1', 'Moss & moonlight', true, second.titleRevision, 'agent', at, at],
  ]);
  assert.equal((await archive.receipt()).events, 4, 'both title versions remain in the durable log');
  await assert.rejects(archive.setTitle(titleChange('   ', second.titleRevision)), /1-80 visible characters/);
  await assert.rejects(archive.setTitle(titleChange('x'.repeat(81), second.titleRevision)), /1-80 visible characters/);
  await assert.rejects(archive.setTitle(titleChange('\u200d', second.titleRevision)), /1-80 visible characters/);
  await assert.rejects(archive.setTitle(titleChange('Stale title', first.titleRevision)), /revision conflict/);
  await archive.close();
  await assert.rejects(archive.setTitle(titleChange('Too late', second.titleRevision)), /after close has begun/);

  const reopened = await openConversationArchive(file, { expectedArchiveId: 'title-archive', clock });
  snapshot = await reopened.snapshot();
  assert.deepEqual(snapshot.titles.map(row => [row.conversationId, row.title, row.titleRevision, row.titleBy]), [
    ['conversation-1', 'Moss & moonlight', second.titleRevision, 'agent'],
  ]);
  assert.equal((await reopened.lookup('conversation-1', 'message-1')).entry.message.content, 'Synthetic hello.');
  await reopened.close();
});

test('title revisions fence concurrent writers and a clear remains attributed and restart-safe', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'title-conflict-archive', clock });
  const attempts = await Promise.allSettled([
    archive.setTitle(titleChange('First concurrent title', 0, 'person')),
    archive.setTitle(titleChange('Second concurrent title', 0, 'agent')),
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const current = (await archive.snapshot()).titles[0];
  const cleared = await archive.setTitle(titleChange(null, current.titleRevision, 'person'));
  assert.equal(cleared.title, null);
  assert.equal(cleared.customTitle, false);
  assert.equal(cleared.titleBy, 'person');
  await archive.close();

  const reopened = await openConversationArchive(file, { expectedArchiveId: 'title-conflict-archive', clock });
  const restored = (await reopened.snapshot()).titles[0];
  assert.equal(restored.title, null);
  assert.equal(restored.customTitle, false);
  assert.equal(restored.titleRevision, cleared.titleRevision);
  assert.equal(restored.titleBy, 'person');
  await reopened.close();
});

test('conversation lifecycle changes are append-only, conflict-fenced, and restart-safe without messages', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'lifecycle-archive', clock });
  const archived = await archive.setArchived(lifecycleChange(true, 0, 'agent'));
  assert.equal(archived.archived, true);
  assert.equal(archived.lifecycleBy, 'agent');
  assert.equal(archived.archivedAt, at);
  let snapshot = await archive.snapshot();
  assert.deepEqual(snapshot.totals, { conversations: 1, messages: 0 });
  assert.deepEqual(snapshot.lifecycles.map(row => [
    row.conversationId, row.status, row.lifecycleRevision, row.lifecycleBy, row.statusChangedAt, row.archivedAt,
  ]), [['conversation-1', 'archived', archived.lifecycleRevision, 'agent', at, at]]);

  const beforeNoop = await archive.receipt();
  const unchanged = await archive.setArchived(lifecycleChange(true, archived.lifecycleRevision, 'person'));
  assert.equal(unchanged.event, null);
  assert.equal((await archive.receipt()).events, beforeNoop.events);
  await assert.rejects(archive.setArchived(lifecycleChange(false, 0)), /lifecycle revision conflict/);
  await assert.rejects(archive.setArchived(lifecycleChange('yes', archived.lifecycleRevision)), /true or false/);

  const restored = await archive.setArchived(lifecycleChange(false, archived.lifecycleRevision, 'person'));
  assert.equal(restored.archived, false);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.lifecycleBy, 'person');
  await archive.close();

  const reopened = await openConversationArchive(file, { expectedArchiveId: 'lifecycle-archive', clock });
  snapshot = await reopened.snapshot();
  assert.equal(snapshot.lifecycles[0].archived, false);
  assert.equal(snapshot.lifecycles[0].lifecycleRevision, restored.lifecycleRevision);
  assert.equal(snapshot.lifecycles[0].conversationCreatedAt, at);
  assert.equal(snapshot.lifecycles[0].conversationUpdatedAt, at);
  await reopened.close();
});

test('conversation proactive policy is independent, conflict-fenced, and restart-safe without messages', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'proactive-archive', clock });
  const suppressed = await archive.setProactiveMode(proactiveChange('suppress', 0, 'agent'));
  assert.equal(suppressed.proactiveMode, 'suppress');
  assert.equal(suppressed.proactiveBy, 'agent');
  assert.equal(suppressed.proactiveChangedAt, at);
  let snapshot = await archive.snapshot();
  assert.deepEqual(snapshot.totals, { conversations: 1, messages: 0 });
  assert.deepEqual(snapshot.proactivePolicies.map(row => [
    row.conversationId, row.proactiveMode, row.proactiveRevision, row.proactiveBy, row.proactiveChangedAt,
  ]), [['conversation-1', 'suppress', suppressed.proactiveRevision, 'agent', at]]);

  const beforeNoop = await archive.receipt();
  const unchanged = await archive.setProactiveMode(proactiveChange('suppress', suppressed.proactiveRevision, 'person'));
  assert.equal(unchanged.event, null);
  assert.equal((await archive.receipt()).events, beforeNoop.events);
  await assert.rejects(archive.setProactiveMode(proactiveChange('allow', 0)), /proactive revision conflict/);
  await assert.rejects(archive.setProactiveMode(proactiveChange('mute', suppressed.proactiveRevision)), /allow or suppress/);

  const allowed = await archive.setProactiveMode(proactiveChange('allow', suppressed.proactiveRevision, 'person'));
  assert.equal(allowed.proactiveMode, 'allow');
  assert.equal(allowed.proactiveBy, 'person');
  await archive.close();

  const reopened = await openConversationArchive(file, { expectedArchiveId: 'proactive-archive', clock });
  snapshot = await reopened.snapshot();
  assert.equal(snapshot.proactivePolicies[0].proactiveMode, 'allow');
  assert.equal(snapshot.proactivePolicies[0].proactiveRevision, allowed.proactiveRevision);
  assert.equal(snapshot.proactivePolicies[0].conversationCreatedAt, at);
  assert.equal(snapshot.proactivePolicies[0].conversationUpdatedAt, at);
  await reopened.close();
});

test('proactive writers have one winner and metadata mismatches never reach the durable log', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'proactive-conflict-archive', clock });
  const attempts = await Promise.allSettled([
    archive.setProactiveMode(proactiveChange('suppress', 0, 'person')),
    archive.setProactiveMode(proactiveChange('suppress', 0, 'agent')),
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const current = (await archive.snapshot()).proactivePolicies[0];
  const beforeMismatch = await archive.receipt();
  await assert.rejects(archive.setTitle(titleChange('Wrong creation edge', 0, 'person', {
    conversationCreatedAt: '2030-01-02T03:04:06.000Z',
    conversationUpdatedAt: '2030-01-02T03:04:06.000Z',
  })), /conflicts with conversation proactive policy/);
  assert.deepEqual(await archive.receipt(), beforeMismatch, 'a rejected cross-projection mismatch appends nothing');
  const allowed = await archive.setProactiveMode(proactiveChange('allow', current.proactiveRevision));
  assert.equal(allowed.proactiveMode, 'allow');
  await archive.close();
});

test('concurrent lifecycle writers have one winner and lifecycle creation time agrees with title history', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'lifecycle-conflict-archive', clock });
  const attempts = await Promise.allSettled([
    archive.setArchived(lifecycleChange(true, 0, 'person')),
    archive.setArchived(lifecycleChange(true, 0, 'agent')),
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const current = (await archive.snapshot()).lifecycles[0];
  await archive.setTitle(titleChange('A lifecycle title', 0));
  await assert.rejects(archive.setArchived(lifecycleChange(false, current.lifecycleRevision, 'person', {
    conversationCreatedAt: '2030-01-02T03:04:06.000Z',
    conversationUpdatedAt: '2030-01-02T03:04:06.000Z',
  })), /cannot change|conflicts with conversation title/);
  await archive.close();
});

test('entry restoration rebrands exact stored data and detects changed messages', () => {
  const original = messageEntry();
  const stored = JSON.parse(JSON.stringify(original));
  assert.equal(isConversationEntry(stored), false);
  const restored = restoreConversationEntry(stored);
  assert.equal(isConversationEntry(restored), true);
  assert.equal(restored.fingerprint, original.fingerprint);
  stored.message.content = 'Changed.';
  assert.throws(() => restoreConversationEntry(stored), /message hash does not match|fingerprint does not match/);
});

test('duplicate message IDs are conflict-checked and concurrent duplicates cannot both append', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'duplicate-archive', clock });
  const attempts = await Promise.allSettled([
    archive.append(messageEntry()),
    archive.append(messageEntry()),
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await archive.snapshot()).totals.messages, 1);
  const before = await archive.receipt();
  await assert.rejects(archive.append(messageEntry()), /already exists/);
  assert.equal((await archive.receipt()).head, before.head);
  await archive.close();
});

test('exact lookup joins the archive queue behind an earlier append', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'queued-archive', clock });
  const pendingAppend = archive.append(messageEntry('queued-message'));
  const pendingLookup = archive.lookup('conversation-1', 'queued-message');
  const [appended, lookup] = await Promise.all([pendingAppend, pendingLookup]);
  assert.equal(lookup.entry.fingerprint, appended.entry.fingerprint);
  assert.equal(lookup.source.fingerprint, appended.source.fingerprint);
  assert.equal(lookup.receipt.event.hash, appended.event.hash);
  assert.equal(lookup.receipt.archive.head, appended.event.hash);
  await archive.close();
});

test('a failed verified absence poisons every live archive projection', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, {
    archiveId: 'absence-failure-archive', clock,
  });
  await archive.append(messageEntry('existing'));
  const probe = await fs.open(`${file}.probe`, 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  prototype.read = async function syntheticVerifiedReadFailure() {
    throw new Error('synthetic verified read failure');
  };
  try {
    await assert.rejects(
      archive.lookup('conversation-1', 'missing'),
      /synthetic verified read failure/,
    );
  } finally {
    prototype.read = originalRead;
  }
  await assert.rejects(archive.reference('conversation-1', 'existing'), /synthetic verified read failure/);
  await assert.rejects(archive.lookup('conversation-1', 'existing'), /synthetic verified read failure/);
  await assert.rejects(archive.snapshot(), /synthetic verified read failure/);
  await assert.rejects(archive.close(), /synthetic verified read failure/);
});

test('a hash-valid archive with invalid entry semantics is refused during replay', async t => {
  const file = await temporary(t);
  const raw = await openDurableLog(file, {
    create: true,
    format: CONVERSATION_ARCHIVE_EVENT_FORMAT,
    idField: 'archiveId',
    id: 'invalid-archive',
    initial: {
      type: 'archive_created',
      data: { entryFormat: CONVERSATION_ENTRY_FORMAT, sourceIdFormat: CONVERSATION_SOURCE_ID_FORMAT },
    },
    clock,
    maxDataBytes: 1536 * 1024,
    maxLineBytes: 2 * 1024 * 1024,
  });
  await raw.append('message_archived', { entry: { forged: true } });
  await raw.close();
  await assert.rejects(openConversationArchive(file, { clock }), /message_archived entry is invalid/);
  assert.equal(await fs.stat(`${file}.lock`).catch(error => error.code), 'ENOENT');
});

test('hash-valid malformed lifecycle events are refused during replay', async t => {
  const cases = [
    {
      id: 'unknown-status',
      data: {
        conversationId: 'conversation-1', status: 'buried', actor: 'person',
        conversationCreatedAt: at, conversationUpdatedAt: at,
      },
      expected: /must be active or archived/,
    },
    {
      id: 'reversed-time',
      data: {
        conversationId: 'conversation-1', status: 'archived', actor: 'person',
        conversationCreatedAt: '2030-01-02T03:04:06.000Z', conversationUpdatedAt: at,
      },
      expected: /cannot be before conversationCreatedAt/,
    },
  ];
  for (const specimen of cases) {
    const file = await temporary(t);
    const raw = await openDurableLog(file, {
      create: true,
      format: CONVERSATION_ARCHIVE_EVENT_FORMAT,
      idField: 'archiveId',
      id: `invalid-lifecycle-${specimen.id}`,
      initial: {
        type: 'archive_created',
        data: { entryFormat: CONVERSATION_ENTRY_FORMAT, sourceIdFormat: CONVERSATION_SOURCE_ID_FORMAT },
      },
      clock,
      maxDataBytes: 1536 * 1024,
      maxLineBytes: 2 * 1024 * 1024,
    });
    await raw.append('conversation_lifecycle_changed', specimen.data);
    await raw.close();
    await assert.rejects(openConversationArchive(file, { clock }), specimen.expected);
    assert.equal(await fs.stat(`${file}.lock`).catch(error => error.code), 'ENOENT');
  }
});

test('hash-valid malformed proactive events are refused during replay', async t => {
  const cases = [
    {
      id: 'unknown-mode',
      data: {
        conversationId: 'conversation-1', mode: 'mute', actor: 'person',
        conversationCreatedAt: at, conversationUpdatedAt: at,
      },
      expected: /must be allow or suppress/,
    },
    {
      id: 'reversed-time',
      data: {
        conversationId: 'conversation-1', mode: 'suppress', actor: 'person',
        conversationCreatedAt: '2030-01-02T03:04:06.000Z', conversationUpdatedAt: at,
      },
      expected: /cannot be before conversationCreatedAt/,
    },
  ];
  for (const specimen of cases) {
    const file = await temporary(t);
    const raw = await openDurableLog(file, {
      create: true,
      format: CONVERSATION_ARCHIVE_EVENT_FORMAT,
      idField: 'archiveId',
      id: `invalid-proactive-${specimen.id}`,
      initial: {
        type: 'archive_created',
        data: { entryFormat: CONVERSATION_ENTRY_FORMAT, sourceIdFormat: CONVERSATION_SOURCE_ID_FORMAT },
      },
      clock,
      maxDataBytes: 1536 * 1024,
      maxLineBytes: 2 * 1024 * 1024,
    });
    await raw.append('conversation_proactive_changed', specimen.data);
    await raw.close();
    await assert.rejects(openConversationArchive(file, { clock }), specimen.expected);
    assert.equal(await fs.stat(`${file}.lock`).catch(error => error.code), 'ENOENT');
  }
});

test('replay rejects proactive creation-time conflicts in either cross-stream order', async t => {
  const otherAt = '2030-01-02T03:04:06.000Z';
  const cases = [
    {
      id: 'title-then-proactive',
      events: [
        ['conversation_titled', {
          conversationId: 'conversation-1', title: 'Exact title', actor: 'person',
          conversationCreatedAt: at, conversationUpdatedAt: at,
        }],
        ['conversation_proactive_changed', {
          conversationId: 'conversation-1', mode: 'suppress', actor: 'person',
          conversationCreatedAt: otherAt, conversationUpdatedAt: otherAt,
        }],
      ],
      expected: /conflicts with conversation title/,
    },
    {
      id: 'proactive-then-lifecycle',
      events: [
        ['conversation_proactive_changed', {
          conversationId: 'conversation-1', mode: 'suppress', actor: 'person',
          conversationCreatedAt: at, conversationUpdatedAt: at,
        }],
        ['conversation_lifecycle_changed', {
          conversationId: 'conversation-1', status: 'archived', actor: 'person',
          conversationCreatedAt: otherAt, conversationUpdatedAt: otherAt,
        }],
      ],
      expected: /conflicts with conversation proactive policy/,
    },
  ];
  for (const specimen of cases) {
    const file = await temporary(t);
    const raw = await openDurableLog(file, {
      create: true,
      format: CONVERSATION_ARCHIVE_EVENT_FORMAT,
      idField: 'archiveId',
      id: `cross-stream-proactive-${specimen.id}`,
      initial: {
        type: 'archive_created',
        data: { entryFormat: CONVERSATION_ENTRY_FORMAT, sourceIdFormat: CONVERSATION_SOURCE_ID_FORMAT },
      },
      clock,
      maxDataBytes: 1536 * 1024,
      maxLineBytes: 2 * 1024 * 1024,
    });
    for (const [type, data] of specimen.events) await raw.append(type, data);
    await raw.close();
    await assert.rejects(openConversationArchive(file, { clock }), specimen.expected);
    assert.equal(await fs.stat(`${file}.lock`).catch(error => error.code), 'ENOENT');
  }
});

test('draft archives without the frozen source-ID discriminator are refused', async t => {
  for (const sourceIdFormat of [undefined, 'fieldwork-conversation-source-id/v999']) {
    const file = await temporary(t);
    const data = { entryFormat: CONVERSATION_ENTRY_FORMAT };
    if (sourceIdFormat !== undefined) data.sourceIdFormat = sourceIdFormat;
    const draft = await openDurableLog(file, {
      create: true, format: CONVERSATION_ARCHIVE_EVENT_FORMAT,
      idField: 'archiveId', id: `draft-${sourceIdFormat === undefined ? 'missing' : 'unknown'}`,
      initial: { type: 'archive_created', data }, clock,
      maxDataBytes: 1536 * 1024,
      maxLineBytes: 2 * 1024 * 1024,
    });
    await draft.close();
    await assert.rejects(openConversationArchive(file, { clock }), new RegExp(`sourceIdFormat must be ${CONVERSATION_SOURCE_ID_FORMAT.replaceAll('/', '\\/')}`));
  }
});

test('conversation entries reject malformed IDs, timestamps and non-JSON messages', () => {
  assert.throws(() => createConversationEntry({ conversationId: '../bad', messageId: 'one', observedAt: at, message: {} }), /conversationId/);
  assert.throws(() => createConversationEntry({ conversationId: 'one', messageId: 'two', observedAt: 'tomorrow', message: {} }), /exact ISO/);
  assert.throws(() => createConversationEntry({ conversationId: 'one', messageId: 'two', observedAt: at, message: [] }), /must be a JSON object/);
  assert.throws(() => createConversationEntry({ conversationId: 'one', messageId: 'two', observedAt: at, message: { value: undefined } }), /JSON cannot represent/);
});

test('source IDs encode archive and conversation components without delimiter collisions', async t => {
  const leftFile = await temporary(t);
  const rightFile = await temporary(t);
  const left = await createConversationArchive(leftFile, { archiveId: 'a:b', clock });
  const right = await createConversationArchive(rightFile, { archiveId: 'a', clock });
  const leftResult = await left.append({ conversationId: 'c', messageId: 'same', observedAt: at, message: { role: 'user', content: 'Same.' } });
  const rightResult = await right.append({ conversationId: 'b:c', messageId: 'same', observedAt: at, message: { role: 'user', content: 'Same.' } });
  assert.notEqual(leftResult.source.id, rightResult.source.id);
  assert.notEqual(leftResult.source.fingerprint, rightResult.source.fingerprint);
  await left.close();
  await right.close();
});

test('archive option accessors are rejected without execution', async t => {
  const file = await temporary(t);
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'archiveId', { enumerable: true, get() { reads++; return 'accessor'; } });
  await assert.rejects(createConversationArchive(file, options), /must be an enumerable data property/);
  assert.equal(reads, 0);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('an uncertain archive append blocks stale references until the file is reconciled', async t => {
  const file = await temporary(t);
  const archive = await createConversationArchive(file, { archiveId: 'ambiguous-archive', clock });
  const probe = await fs.open(`${file}.probe`, 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  prototype.sync = async function syntheticPostSyncFailure() {
    await originalSync.call(this);
    throw new Error('synthetic failure after sync');
  };
  let failure;
  try { await archive.append(messageEntry('uncertain')); }
  catch (error) { failure = error; }
  finally { prototype.sync = originalSync; }
  assert.equal(failure.commitStatus, 'unknown');
  await assert.rejects(archive.reference('conversation-1', 'uncertain'), /outcome is unknown/);
  await assert.rejects(archive.lookup('conversation-1', 'uncertain'), /outcome is unknown/);
  await assert.rejects(archive.snapshot(), /outcome is unknown/);
  await assert.rejects(archive.close(), /outcome is unknown/);

  const reconciled = await openConversationArchive(file, { clock });
  assert.equal(isSourceReference(await reconciled.reference('conversation-1', 'uncertain')), true);
  await reconciled.close();
});

test('a definitely unwritten durable rejection does not poison the archive projection', async t => {
  const file = await temporary(t);
  let calls = 0;
  const intermittentClock = () => {
    calls++;
    if (calls === 2) throw new Error('synthetic archive clock failure');
    return new Date(at);
  };
  const archive = await createConversationArchive(file, {
    archiveId: 'retryable-archive', clock: intermittentClock,
  });
  const entry = messageEntry('retryable-message');
  let failure;
  try { await archive.append(entry); }
  catch (error) { failure = error; }
  assert.equal(failure.commitStatus, 'not-written');
  assert.equal((await archive.receipt()).events, 1);
  const appended = await archive.append(entry);
  assert.equal(appended.entry.messageId, 'retryable-message');
  assert.equal(
    (await archive.reference('conversation-1', 'retryable-message')).fingerprint,
    appended.source.fingerprint,
  );
  await archive.close();
});
