import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryLedger } from '../src/memory-ledger.mjs';
import {
  buildMemoryForeground,
  isMemoryForeground,
  MEMORY_FOREGROUND_BUDGET_OMISSION,
  MEMORY_FOREGROUND_UNAVAILABLE,
  withMemoryForeground,
} from '../src/memory-foreground.mjs';
import { createMemoryRecord, createSourceReference } from '../src/provenance.mjs';
import { createMeaningRecall } from '../src/meaning-recall.mjs';

const at = '2030-01-02T03:04:05.000Z';
const author = { kind: 'agent', id: 'synthetic-agent' };
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');

function memory(id, text, createdAt = at, extra = {}) {
  return createMemoryRecord({
    id,
    kind: 'authored-memory',
    text,
    author,
    createdAt,
    basis: 'self-authored',
    confidence: 'asserted',
    ...extra,
  });
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-memory-foreground-'));
  const ledger = await createMemoryLedger(path.join(directory, 'memory.jsonl'), {
    ledgerId: 'synthetic-memory-foreground',
    clock: () => new Date(at),
  });
  t.after(() => ledger.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return ledger;
}

test('the foreground selects distinctive current memories and retains their typed record', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:orchard', 'The glass orchard uses a cobalt latch.'));
  await ledger.record(memory('memory:garden', 'The garden soil needs a weekly mist.'));
  await ledger.record(memory('memory:studio', 'The glass studio keeps a spare apron.'));

  const message = 'What did I choose for the glass orchard latch?';
  const foreground = await buildMemoryForeground(ledger, message);
  assert.equal(isMemoryForeground(foreground), true);
  assert.equal(foreground.receipt.status, 'ready');
  const ledgerReceipt = await ledger.receipt();
  assert.deepEqual(foreground.receipt.index, {
    kind: 'memory-ledger', ledgerId: ledgerReceipt.ledgerId, events: ledgerReceipt.events, head: ledgerReceipt.head,
  });
  assert.deepEqual(foreground.receipt.selection.map(row => row.id), ['memory:orchard']);
  assert.match(foreground.text, /FIELDWORK_MEMORY/);
  assert.match(foreground.text, /glass orchard uses a cobalt latch/);
  assert.doesNotMatch(foreground.text, /garden soil|spare apron/);
  assert.equal(foreground.receipt.query.characters, [...message].length);
  assert.equal(JSON.stringify(foreground.receipt).includes('What did I choose'), false, 'the receipt hashes the message instead of copying it');
  assert.equal(Object.isFrozen(foreground), true);
  assert.equal(Object.isFrozen(foreground.receipt.selection), true);
});

test('the foreground receipt keeps each safe source edge and names an unknown edge honestly', async t => {
  const ledger = await fixture(t);
  const edged = createSourceReference({
    kind: 'document', id: 'C:\\synthetic-private\\orchid.md',
    locator: 'https://synthetic-user:synthetic-secret@example.invalid/orchid',
    sha256: hash('orchid source'), observedThrough: at,
  });
  const unknown = createSourceReference({
    kind: 'document', id: 'C:\\synthetic-private\\calendula.md',
    sha256: hash('calendula source'),
  });
  await ledger.record(memory('observation:orchid-edge', 'The freshness orchid has a cobalt edge.', at, {
    kind: 'observation', basis: 'source-backed', confidence: 'supported', sources: [edged],
  }));
  await ledger.record(memory('observation:calendula-edge', 'The freshness calendula has an amber edge.', at, {
    kind: 'observation', basis: 'source-backed', confidence: 'supported', sources: [unknown],
  }));

  const observed = await buildMemoryForeground(ledger, 'freshness orchid cobalt');
  assert.deepEqual(observed.receipt.selection[0].sources, [{
    kind: 'document', fingerprint: edged.fingerprint, observedThrough: at,
  }]);
  assert.doesNotMatch(JSON.stringify(observed.receipt.selection), /synthetic-private|synthetic-secret|orchid\.md/);

  const unrecorded = await buildMemoryForeground(ledger, 'freshness calendula amber');
  assert.deepEqual(unrecorded.receipt.selection[0].sources, [{
    kind: 'document', fingerprint: unknown.fingerprint, observedThrough: null,
  }]);
});

test('the foreground never lets delayed or expired memory steer a reply', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:lifecycle-active', 'Lifecycle orchid active fact.'));
  await ledger.record(memory('memory:lifecycle-future', 'Lifecycle orchid future reminder.', at, {
    lifecycle: { type: 'reminder', notBefore: '2030-02-01T00:00:00.000Z' },
  }));
  await ledger.record(memory('memory:lifecycle-expired', 'Lifecycle orchid expired verdict.', at, {
    lifecycle: {
      type: 'verdict', expiresAt: at,
      evidence: 'The synthetic reading was low.', changeCriteria: 'A new reading is high.',
    },
  }));

  const foreground = await buildMemoryForeground(ledger, 'lifecycle orchid', { now: at, timeZone: 'UTC' });
  assert.equal(foreground.receipt.status, 'ready');
  assert.deepEqual(foreground.receipt.lifecycle, {
    asOf: at, considered: 3, eligible: 1, scheduled: 1, expired: 1, due: 1,
  });
  assert.deepEqual(foreground.receipt.selection.map(row => row.id), ['memory:lifecycle-active']);
  assert.match(foreground.text, /active fact/);
  assert.doesNotMatch(foreground.text, /future reminder|expired verdict/);
});

test('generic or content-free messages carry no decorative memory block', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:one', 'The project keeps a cobalt latch.'));
  await ledger.record(memory('memory:two', 'The project keeps an amber hinge.'));
  await ledger.record(memory('memory:three', 'The project keeps a violet handle.'));
  await ledger.record(memory('memory:harvest', 'The harvest report is complete.'));

  const generic = await buildMemoryForeground(ledger, 'How is the project?');
  assert.equal(generic.text, '');
  assert.equal(generic.receipt.reason, 'no-distinctive-match');
  assert.equal(generic.receipt.index.kind, 'memory-ledger');
  const greeting = await buildMemoryForeground(ledger, 'hello :3');
  assert.equal(greeting.text, '');
  assert.equal(greeting.receipt.reason, 'no-informative-terms');
  assert.equal(Object.hasOwn(greeting.receipt, 'index'), false, 'no index edge is claimed when the ledger was never read');
  const stateWord = await buildMemoryForeground(ledger, 'complete with a relay response :)');
  assert.equal(stateWord.text, '');
  assert.equal(stateWord.receipt.reason, 'no-distinctive-match');
});

test('a relative date boosts subject-matching memories written in that local day', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:older-gate', 'The cobalt gate used the older brass latch.', '2026-10-30T12:00:00.000Z'));
  await ledger.record(memory('memory:yesterday-gate', 'The cobalt gate uses the newer blue latch.', '2026-10-31T12:00:00.000Z'));
  await ledger.record(memory('memory:garden', 'The fern garden needs a weekly mist.', '2026-10-31T15:00:00.000Z'));

  const foreground = await buildMemoryForeground(ledger, 'What changed about the cobalt gate yesterday?', {
    now: '2026-11-01T12:00:00.000Z', timeZone: 'UTC',
  });
  assert.deepEqual(foreground.receipt.query.time.ranges, [{
    from: '2026-10-31T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z',
    kind: 'day', relation: 'yesterday',
  }]);
  assert.deepEqual(foreground.receipt.selection.map(row => [row.id, row.timeMatch]), [
    ['memory:yesterday-gate', true],
    ['memory:older-gate', false],
  ]);
  assert.equal(foreground.receipt.corpus.timeMatched, 1);
  assert.ok(foreground.text.indexOf('newer blue latch') < foreground.text.indexOf('older brass latch'));

  const timeOnly = await buildMemoryForeground(ledger, 'What happened yesterday?', {
    now: '2026-11-01T12:00:00.000Z', timeZone: 'UTC',
  });
  assert.equal(timeOnly.text, '');
  assert.equal(timeOnly.receipt.reason, 'no-informative-terms');
  assert.equal(timeOnly.receipt.query.time.ranges.length, 1);
});

test('the foreground follows a correction and never revives the superseded record', async t => {
  const ledger = await fixture(t);
  const original = memory('memory:route', 'The orchard latch is amber.');
  const entry = await ledger.record(original);
  await ledger.supersede({
    id: original.id,
    expectedFingerprint: entry.currentFingerprint,
    expectedSequence: entry.lastSequence,
    replacement: memory('memory:route', 'Correction: the orchard latch is cobalt.'),
    reason: 'The synthetic route changed.',
    actor: author,
  });

  const foreground = await buildMemoryForeground(ledger, 'orchard latch cobalt');
  assert.equal(foreground.receipt.status, 'ready');
  assert.match(foreground.text, /latch is cobalt/);
  assert.doesNotMatch(foreground.text, /latch is amber/);
});

test('whole records that do not fit become an honest omission instead of a truncated claim', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:large', `Asterism detail ${'x'.repeat(1200)}`));
  const foreground = await buildMemoryForeground(ledger, 'asterism detail', {
    contextCharacters: 300,
    memoryCharacters: 250,
  });
  assert.equal(foreground.text, MEMORY_FOREGROUND_BUDGET_OMISSION);
  assert.equal(foreground.receipt.status, 'omitted');
  assert.equal(foreground.receipt.reason, 'context-budget');
  assert.deepEqual(foreground.receipt.context.included, []);
  assert.equal(foreground.receipt.context.skipped[0].id, 'memory:large');
  assert.doesNotMatch(foreground.text, /Asterism detail/);
});

test('an unavailable ledger fails to a fixed marker rather than throwing or dumping state', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:closed', 'The closed cabinet holds a brass key.'));
  await ledger.close();
  const foreground = await buildMemoryForeground(ledger, 'closed cabinet brass key');
  assert.equal(foreground.text, MEMORY_FOREGROUND_UNAVAILABLE);
  assert.equal(foreground.receipt.status, 'unavailable');
  assert.equal(foreground.receipt.reason, 'memory-read-failed');
  assert.equal(Object.hasOwn(foreground.receipt, 'index'), false);
  assert.equal(JSON.stringify(foreground).includes('brass key'), false);
});

test('ephemeral context lands before the newest user message without changing history', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:orchard', 'The orchard latch is cobalt.'));
  const foreground = await buildMemoryForeground(ledger, 'orchard latch');
  const messages = [
    { role: 'system', content: 'Synthetic host instruction.' },
    { role: 'user', content: 'earlier turn' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'orchard latch' },
  ];
  const assembled = withMemoryForeground(messages, foreground);
  assert.deepEqual(assembled.map(message => message.role), ['system', 'user', 'assistant', 'user', 'user'], 'memory sits at user level, never system');
  assert.match(assembled[3].content, /orchard latch is cobalt/);
  assert.deepEqual(messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.throws(() => withMemoryForeground(messages, { ...foreground }), /must be returned by buildMemoryForeground/);
});

test('foreground inputs are strict and option accessors are never invoked', async t => {
  const ledger = await fixture(t);
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'terms', {
    enumerable: true,
    get() { reads++; return 4; },
  });
  await assert.rejects(buildMemoryForeground(ledger, 'synthetic subject', options), /must be an enumerable data property/);
  assert.equal(reads, 0);
  await assert.rejects(buildMemoryForeground(ledger, new String('synthetic subject')), /message must be primitive text/);
  await assert.rejects(buildMemoryForeground(ledger, '\ud800'), /well-formed Unicode/);
  await assert.rejects(buildMemoryForeground(ledger, 'synthetic subject', { unknown: true }), /unknown field/);
  await assert.rejects(buildMemoryForeground(ledger, 'synthetic subject', { contextCharacters: 255 }), /at least 256/);
  await assert.rejects(buildMemoryForeground(ledger, 'synthetic subject', { meaning: { pick: () => ({}) } }), /createMeaningRecall/);
  await assert.rejects(buildMemoryForeground(ledger, 'synthetic subject', { signal: {} }), /AbortSignal/);
});

// A fake local embedding service with readable "topic" vectors: dogs, tea, garden.
function topicService(calls) {
  const topics = [/dog|puppy|biscuit|pup/i, /tea|lapsang|drink/i, /garden|tomato|plant/i];
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.input);
    const data = body.input.map((text, index) => ({ index, embedding: [...topics.map(pattern => (pattern.test(text) ? 1 : 0)), 0.2] }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('an optional meaning seat finds a memory that shares no words with the message', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:puppy', 'Sam adopted a puppy named Biscuit last spring.'));
  await ledger.record(memory('memory:tea', 'Sam likes smoky lapsang souchong.'));
  await ledger.record(memory('memory:garden', 'The tomatoes by the fence need staking.'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-meaning-seat-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const meaning = await createMeaningRecall({ stateDir, floor: 0.5, fetch: topicService(calls) });

  const wordsOnly = await buildMemoryForeground(ledger, 'How is my dog doing?');
  assert.equal(wordsOnly.receipt.status, 'empty', 'word matching alone finds nothing');

  const seated = await buildMemoryForeground(ledger, 'How is my dog doing?', { meaning });
  assert.equal(seated.receipt.status, 'ready');
  assert.deepEqual(seated.receipt.selection.map(row => [row.id, row.matchedBy]), [['memory:puppy', 'meaning']]);
  assert.ok(seated.receipt.selection[0].meaningPpm >= 500_000);
  assert.match(seated.text, /Biscuit/);
  assert.equal(seated.receipt.meaning.picked, 1);
  assert.doesNotMatch(JSON.stringify(seated.receipt), /Biscuit|puppy named/, 'receipts stay free of memory text');

  const before = calls.length;
  const greeting = await buildMemoryForeground(ledger, 'hello there', { meaning });
  assert.equal(greeting.receipt.reason, 'no-informative-terms');
  assert.equal(calls.length, before, 'a greeting never reaches the embedding service');

  const words = await buildMemoryForeground(ledger, 'What are the fence tomatoes waiting for?', { meaning });
  assert.deepEqual(words.receipt.selection.map(row => row.id), ['memory:garden'], 'word matches keep their place; the seat only adds above the floor');
  assert.equal(words.receipt.selection[0].matchedBy, undefined);
});

test('a floor-zero orthogonal meaning seat remains labeled as meaning in provenance', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:puppy', 'Biscuit is a puppy.'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-meaning-zero-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const meaning = await createMeaningRecall({
    stateDir,
    floor: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const data = body.input.map((text, index) => ({
        index,
        embedding: /puppy|biscuit/i.test(text) ? [1, 0] : /orbital|theorem/i.test(text) ? [0, 1] : [1, 1],
      }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const foreground = await buildMemoryForeground(ledger, 'Which orbital theorem applies?', { meaning });
  assert.equal(foreground.receipt.status, 'ready');
  assert.deepEqual(foreground.receipt.selection.map(row => ({
    id: row.id,
    matchedBy: row.matchedBy,
    meaningPpm: row.meaningPpm,
  })), [{ id: 'memory:puppy', matchedBy: 'meaning', meaningPpm: 0 }]);
});

test('caller cancellation stops a meaning lookup instead of becoming an ordinary empty foreground', async t => {
  const ledger = await fixture(t);
  await ledger.record(memory('memory:puppy', 'Sam adopted a puppy named Biscuit last spring.'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-meaning-cancel-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let started;
  const reachedService = new Promise(resolve => { started = resolve; });
  const meaning = await createMeaningRecall({
    stateDir,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      started();
      const stop = () => reject(init.signal.reason ?? new Error('embedding request aborted'));
      if (init.signal.aborted) stop();
      else init.signal.addEventListener('abort', stop, { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = buildMemoryForeground(ledger, 'How is my dog doing?', { meaning, signal: controller.signal });
  await reachedService;
  const reason = new Error('synthetic caller stopped');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
});
