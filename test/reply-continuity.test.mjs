import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFERED_MEMORY_BATCH_LIMIT,
  offeredMemoryBatches,
  offeredMemoryVersions,
  replyContinuityModel,
} from '../browser/reply-continuity.js';

const receipt = overrides => ({
  format: 'fieldwork-reply-input-receipt/v1',
  currentMessage: { included: true, attachments: 0 },
  profile: { roots: [] },
  room: [],
  conversation: { historyMessages: 0, recovery: { selected: [], omittedForBudget: 0 } },
  memory: { enabled: true, steps: [] },
  tools: { available: [], steps: [] },
  note: 'This records inputs offered to the model, not hidden reasoning.',
  ...overrides,
});

test('reply continuity stays absent without a valid receipt or visible step', () => {
  assert.equal(replyContinuityModel(null, null), null);
  assert.equal(replyContinuityModel([{ kind: 'unknown' }], { format: 'wrong' }), null);
  assert.equal(replyContinuityModel(null, { format: 'fieldwork-reply-input-receipt/v1' }), null);
});

test('reply continuity counts attempted tools from the trail, including failures', () => {
  const model = replyContinuityModel([
    { kind: 'note', text: 'Checking.' },
    { kind: 'tool', tool: 'read_clock', ok: false },
  ], null);
  assert.deepEqual(model.cues, ['1 tool call']);
  assert.equal(model.trail.length, 2);
  assert.equal(model.receipt, null);
});

test('reply continuity reports only memories actually offered and counts repeats once', () => {
  const model = replyContinuityModel([], receipt({
    profile: { roots: [{ id: 'identity' }, { id: 'voice' }] },
    memory: {
      enabled: true,
      steps: [
        {
          selected: [{ id: 'memory:offered' }, { id: 'memory:skipped' }],
          context: {
            included: [{ type: 'memory', id: 'memory:offered' }],
            skipped: [{ type: 'memory', id: 'memory:skipped', reason: 'budget' }],
          },
        },
        { selected: [], context: { included: [{ type: 'memory', id: 'memory:offered' }], skipped: [] } },
      ],
    },
    tools: { available: ['read_clock'], steps: [] },
  }));
  assert.deepEqual(model.cues, ['conversation', '2 roots', '1 memory offered', 'no tool calls']);
});

test('reply continuity merges a receipt and visible trail into one cue model', () => {
  const model = replyContinuityModel([
    { kind: 'note', text: 'Looking.' },
    { kind: 'tool', tool: 'read_clock', ok: null },
  ], receipt({
    profile: { roots: [{ id: 'identity' }] },
    memory: {
      enabled: true,
      steps: [{ selected: [], context: { included: [{ type: 'memory', id: 'memory:one' }], skipped: [] } }],
    },
  }));
  assert.deepEqual(model.cues, ['conversation', '1 root', '1 memory offered', '1 tool call']);
  assert.equal(model.trail.length, 2);
  assert.equal(model.receipt.format, 'fieldwork-reply-input-receipt/v1');
});

test('reply continuity validates independent root and memory-index edges while keeping legacy receipts readable', () => {
  const current = receipt({
    profile: { roots: [{ id: 'identity', observedThrough: '2030-01-02T03:04:05.000Z' }] },
    memory: {
      enabled: true,
      steps: [{
        index: { kind: 'memory-ledger', ledgerId: 'synthetic-ledger', events: 3, head: 'a'.repeat(64) },
        selected: [],
        context: { included: [], skipped: [] },
      }],
    },
  });
  assert.notEqual(replyContinuityModel(null, current), null);

  const malformedRoot = structuredClone(current);
  malformedRoot.profile.roots[0].observedThrough = 'tomorrow';
  assert.equal(replyContinuityModel(null, malformedRoot), null);
  const malformedIndex = structuredClone(current);
  malformedIndex.memory.steps[0].index.head = 'not-a-head';
  assert.equal(replyContinuityModel(null, malformedIndex), null);

  const legacy = receipt({
    profile: { roots: [{ id: 'identity' }] },
    memory: { enabled: true, steps: [{ ledger: { id: 'legacy', events: 2, head: 'b'.repeat(64) }, selected: [], context: { included: [], skipped: [] } }] },
  });
  assert.notEqual(replyContinuityModel(null, legacy), null);
  const malformedLegacy = structuredClone(legacy);
  malformedLegacy.memory.steps[0].ledger.events = 0;
  assert.equal(replyContinuityModel(null, malformedLegacy), null);
});

test('reply continuity rejects malformed same-format evidence without inventing empty cues', () => {
  const malformed = receipt({ tools: { available: 'read_clock', steps: [] } });
  assert.equal(replyContinuityModel(null, malformed), null);
  const trailOnly = replyContinuityModel([{ kind: 'tool', tool: 'read_clock', ok: true }], malformed);
  assert.deepEqual(trailOnly.cues, ['1 tool call']);
  const validReceiptWithMalformedTrail = replyContinuityModel([{ kind: 'tool' }], receipt({}));
  assert.deepEqual(validReceiptWithMalformedTrail.cues, ['conversation', 'no memory offered']);
  const validSourceEdge = receipt({
    memory: {
      enabled: true,
      steps: [{
        selected: [{
          id: 'memory:one',
          sources: [{
            kind: 'conversation', fingerprint: 'a'.repeat(64), observedThrough: '2030-01-02T03:04:05.000Z',
          }],
        }],
        context: { included: [{ type: 'memory', id: 'memory:one' }], skipped: [] },
      }],
    },
  });
  assert.notEqual(replyContinuityModel(null, validSourceEdge), null);
  const malformedSourceEdge = structuredClone(validSourceEdge);
  delete malformedSourceEdge.memory.steps[0].selected[0].sources[0].observedThrough;
  assert.equal(replyContinuityModel(null, malformedSourceEdge), null);
  const malformedSourceList = structuredClone(validSourceEdge);
  malformedSourceList.memory.steps[0].selected[0].sources = null;
  assert.equal(replyContinuityModel(null, malformedSourceList), null);
  const malformedSourceTime = structuredClone(validSourceEdge);
  malformedSourceTime.memory.steps[0].selected[0].sources[0].observedThrough = 'tomorrow';
  assert.equal(replyContinuityModel(null, malformedSourceTime), null);
});

test('reply continuity keeps note-only and receipt-only disclosures inspectable', () => {
  assert.deepEqual(replyContinuityModel([{ kind: 'note', text: 'Looking.' }], null).cues, []);
  assert.deepEqual(replyContinuityModel([], receipt({ currentMessage: { included: false } })).cues, ['no memory offered', 'no tool calls']);
  assert.deepEqual(replyContinuityModel([], receipt({ memory: { enabled: false, steps: [] } })).cues, ['conversation', 'memory off', 'no tool calls']);
});

test('offered-memory rows preserve revisions and batch requests at the endpoint cap', () => {
  const fingerprints = Array.from({ length: 18 }, (_, index) => index.toString(16).padStart(64, '0'));
  const firstStep = Array.from({ length: 17 }, (_, index) => ({
    id: `memory:${index}`,
    fingerprint: fingerprints[index],
    matchedTerms: 1,
  }));
  const revised = { id: 'memory:0', fingerprint: fingerprints[17], matchedBy: 'meaning', meaningPpm: 900_000 };
  const memory = {
    steps: [
      {
        step: 1,
        selected: firstStep,
        context: { included: firstStep.map(row => ({ id: row.id })), skipped: [] },
      },
      {
        step: 2,
        selected: [firstStep[0], revised, { id: 'memory:omitted', fingerprint: 'f'.repeat(64) }],
        context: {
          included: [{ id: firstStep[0].id }, { id: revised.id }],
          skipped: [{ id: 'memory:omitted', reason: 'budget' }],
        },
      },
    ],
  };

  const versions = offeredMemoryVersions(memory);
  assert.equal(versions.rows.length, 18);
  assert.deepEqual(versions.omittedIds, ['memory:omitted']);
  const sameId = versions.rows.filter(row => row.id === 'memory:0');
  assert.deepEqual(sameId.map(row => row.fingerprint), [fingerprints[0], fingerprints[17]]);
  assert.deepEqual(sameId.map(row => row.versioned), [true, true]);
  assert.deepEqual(sameId.map(row => row.steps), [[1, 2], [2]]);

  const batches = offeredMemoryBatches(versions.rows);
  assert.equal(OFFERED_MEMORY_BATCH_LIMIT, 16);
  assert.deepEqual(batches.map(batch => batch.length), [16, 2]);
  assert.deepEqual(batches.flat(), versions.rows);
});
