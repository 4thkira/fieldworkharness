import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createMemoryRecord, createRetrievedEvidence, createSourceReference,
  isMemoryRecord, isRetrievedEvidence, isSourceReference,
  restoreMemoryRecord, restoreRetrievedEvidence, restoreSourceReference,
} from '../src/provenance.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const at = '2030-01-02T03:04:05.000Z';

function source(extra = {}) {
  return createSourceReference({
    kind: 'conversation', id: 'conversation-synthetic', locator: 'message-7', sha256: hash('source'), ...extra,
  });
}

function evidence(extra = {}) {
  return createRetrievedEvidence({
    source: source(), excerpt: 'The synthetic door was blue.', retrievedAt: at,
    retrieval: { method: 'lexical', queryHash: hash('blue door'), rank: 1, score: 0.9 },
    ...extra,
  });
}

test('source references and retrieved evidence are immutable, fingerprinted, and separately branded', () => {
  const ref = source({ observedThrough: at });
  const found = createRetrievedEvidence({
    source: ref, excerpt: 'The synthetic door was blue.', retrievedAt: at,
    retrieval: { method: 'exact', queryHash: hash('door'), rank: 1 },
  });
  assert.equal(isSourceReference(ref), true);
  assert.equal(isRetrievedEvidence(found), true);
  assert.equal(isMemoryRecord(found), false);
  assert.match(ref.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(ref.format, 'fieldwork-source-reference/v2');
  assert.equal(ref.observedThrough, at);
  assert.equal(found.retrievedAt, at);
  assert.match(found.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(found.source), true);
  assert.throws(() => { found.excerpt = 'changed'; }, TypeError);
});

test('source freshness edges are exact, fingerprinted and backward-compatible with v1 references', () => {
  const withoutEdge = source();
  const withEdge = source({ observedThrough: at });
  assert.equal(Object.hasOwn(withoutEdge, 'observedThrough'), false);
  assert.notEqual(withEdge.fingerprint, withoutEdge.fingerprint);
  const restoredWithoutEdge = restoreSourceReference(JSON.parse(JSON.stringify(withoutEdge)));
  assert.equal(restoredWithoutEdge.fingerprint, withoutEdge.fingerprint);
  assert.equal(Object.hasOwn(restoredWithoutEdge, 'observedThrough'), false);
  assert.equal(restoreSourceReference(JSON.parse(JSON.stringify(withEdge))).fingerprint, withEdge.fingerprint);

  const changed = JSON.parse(JSON.stringify(withEdge));
  changed.observedThrough = '2030-01-03T03:04:05.000Z';
  assert.throws(() => restoreSourceReference(changed), /fingerprint does not match/);
  assert.throws(() => source({ observedThrough: 'tomorrow' }), /exact ISO timestamp/);
  assert.throws(() => source({ observedThrough: '2030-01-02T03:04:05Z' }), /exact ISO timestamp/);

  const legacyBase = {
    format: 'fieldwork-source-reference/v1',
    kind: 'conversation',
    id: 'conversation-synthetic',
    locator: 'message-7',
    sha256: hash('source'),
  };
  const legacy = { ...legacyBase, fingerprint: 'c9047a8f19953398f188fb0e65aedadc4fc86b4408b1f1e540b95001cc78eddb' };
  const restoredLegacy = restoreSourceReference(legacy);
  assert.equal(restoredLegacy.format, legacyBase.format);
  assert.equal(restoredLegacy.fingerprint, legacy.fingerprint);
  assert.equal(Object.hasOwn(restoredLegacy, 'observedThrough'), false);
  assert.throws(() => restoreSourceReference({ ...legacy, observedThrough: at }), /v1 source references may not declare observedThrough/);

  const legacyEvidence = createRetrievedEvidence({
    source: restoredLegacy, excerpt: 'Legacy source evidence.', retrievedAt: at,
    retrieval: { method: 'exact', queryHash: hash('legacy'), rank: 1 },
  });
  const legacyMemory = createMemoryRecord({
    id: 'observation:legacy-source', kind: 'observation', text: 'The legacy source remains restorable.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'source-backed', confidence: 'supported', evidence: [legacyEvidence],
  });
  assert.equal(restoreRetrievedEvidence(JSON.parse(JSON.stringify(legacyEvidence))).fingerprint, legacyEvidence.fingerprint);
  assert.equal(restoreMemoryRecord(JSON.parse(JSON.stringify(legacyMemory))).fingerprint, legacyMemory.fingerprint);
});

test('an observation cites evidence without silently becoming an authored memory', () => {
  const found = evidence();
  const observation = createMemoryRecord({
    id: 'observation:blue-door', kind: 'observation', text: 'The door may currently be blue.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'inferred', confidence: 'tentative', evidence: [found],
  });
  assert.equal(observation.kind, 'observation');
  assert.deepEqual(observation.evidence, [found.fingerprint]);
  assert.deepEqual(observation.sources, [found.source]);
  assert.equal(isMemoryRecord(observation), true);
});

test('agent-authored memory may be self-authored while summaries remain lossy and source-backed', () => {
  const memory = createMemoryRecord({
    id: 'memory:preference', kind: 'authored-memory', text: 'I prefer concise synthetic examples.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'self-authored', confidence: 'asserted',
  });
  assert.deepEqual(memory.sources, []);
  assert.equal(memory.kind, 'authored-memory');

  const summary = createMemoryRecord({
    id: 'summary:week-1', kind: 'summary', text: 'A synthetic week included one blue door.',
    author: { kind: 'model', id: 'summary-model' }, createdAt: at,
    basis: 'source-backed', confidence: 'supported', sources: [source()],
  });
  assert.equal(summary.lossy, true);
  assert.equal(summary.sources.length, 1);
});

test('memory lifecycle metadata is fingerprinted, immutable, and restart-safe', () => {
  const memory = createMemoryRecord({
    id: 'memory:scheduled-verdict', kind: 'authored-memory', text: 'The synthetic gate is not ready.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'self-authored', confidence: 'supported',
    lifecycle: {
      type: 'verdict', reviewAt: '2030-02-01T00:00:00.000Z',
      evidence: 'The last three synthetic checks failed.',
      changeCriteria: 'A complete synthetic check succeeds.',
      reviewPrompt: 'Has a complete check succeeded?',
    },
  });
  assert.equal(memory.lifecycle.type, 'verdict');
  assert.equal(Object.isFrozen(memory.lifecycle), true);
  const stored = JSON.parse(JSON.stringify(memory));
  assert.equal(restoreMemoryRecord(stored).fingerprint, memory.fingerprint);
  stored.lifecycle.reviewAt = '2030-03-01T00:00:00.000Z';
  assert.throws(() => restoreMemoryRecord(stored), /fingerprint does not match/);
});

test('record kinds enforce authorship, basis, citations, timestamps, and brands', () => {
  const base = {
    id: 'memory:test', kind: 'authored-memory', text: 'Synthetic memory.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'self-authored', confidence: 'asserted',
  };
  assert.throws(() => createMemoryRecord({ ...base, author: { kind: 'operator', id: 'operator' } }), /must be authored by an agent/);
  assert.throws(() => createMemoryRecord({ ...base, kind: 'summary' }), /summary records must be source-backed/);
  assert.throws(() => createMemoryRecord({ ...base, kind: 'observation' }), /source-backed or inferred/);
  assert.throws(() => createMemoryRecord({ ...base, basis: 'source-backed' }), /cite at least one source/);
  assert.throws(() => createMemoryRecord({ ...base, createdAt: 'tomorrow' }), /exact ISO timestamp/);
  assert.throws(() => createRetrievedEvidence({
    source: { ...source() }, excerpt: 'Forged source.', retrievedAt: at,
    retrieval: { method: 'exact', queryHash: hash('x'), rank: 1 },
  }), /must be created by createSourceReference/);
});

test('source and evidence validation is strict and bounded', () => {
  assert.throws(() => createSourceReference({ kind: 'conversation', id: 'x', sha256: 'bad' }), /SHA-256/);
  assert.throws(() => createSourceReference({ kind: 'unknown', id: 'x', sha256: hash('x') }), /must be one of/);
  assert.throws(() => createSourceReference({ kind: 'document', id: ' x ', sha256: hash('x') }), /surrounding whitespace/);
  assert.throws(() => createRetrievedEvidence({
    source: source(), excerpt: 'x', retrievedAt: at,
    retrieval: { method: 'magic', queryHash: hash('x'), rank: 1 },
  }), /not supported/);
});

test('stored provenance restores brands after restart only when fingerprints still match', () => {
  const originalSource = source();
  const originalEvidence = createRetrievedEvidence({
    source: originalSource, excerpt: 'Synthetic restart evidence.', retrievedAt: at,
    retrieval: { method: 'exact', queryHash: hash('restart'), rank: 1 },
  });
  const originalMemory = createMemoryRecord({
    id: 'memory:restart', kind: 'observation', text: 'A restart-safe synthetic observation.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'source-backed', confidence: 'supported', evidence: [originalEvidence],
  });
  const storedSource = JSON.parse(JSON.stringify(originalSource));
  const storedEvidence = JSON.parse(JSON.stringify(originalEvidence));
  const storedMemory = JSON.parse(JSON.stringify(originalMemory));
  assert.equal(isSourceReference(storedSource), false);
  assert.equal(isRetrievedEvidence(storedEvidence), false);
  assert.equal(isMemoryRecord(storedMemory), false);

  const restoredSource = restoreSourceReference(storedSource);
  const restoredEvidence = restoreRetrievedEvidence(storedEvidence);
  const restoredMemory = restoreMemoryRecord(storedMemory);
  assert.equal(isSourceReference(restoredSource), true);
  assert.equal(isRetrievedEvidence(restoredEvidence), true);
  assert.equal(isMemoryRecord(restoredMemory), true);
  assert.equal(restoredSource.fingerprint, originalSource.fingerprint);
  assert.equal(restoredEvidence.fingerprint, originalEvidence.fingerprint);
  assert.equal(restoredMemory.fingerprint, originalMemory.fingerprint);

  const wrongFormat = JSON.parse(JSON.stringify(originalSource));
  wrongFormat.format = 'fieldwork-source-reference/v999';
  assert.throws(() => restoreSourceReference(wrongFormat), /format must be fieldwork-source-reference\/v2 or fieldwork-source-reference\/v1/);

  storedMemory.text = 'Tampered after storage.';
  assert.throws(() => restoreMemoryRecord(storedMemory), /fingerprint does not match/);
});

test('prototype pollution cannot supply required provenance fields', () => {
  Object.prototype.kind = 'conversation';
  Object.prototype.id = 'polluted';
  Object.prototype.sha256 = hash('polluted');
  Object.prototype.method = 'exact';
  Object.prototype.queryHash = hash('query');
  Object.prototype.rank = 1;
  try {
    assert.throws(() => createSourceReference({}), /kind must be one of/);
    assert.throws(() => createRetrievedEvidence({
      source: source(), excerpt: 'Synthetic.', retrievedAt: at, retrieval: {},
    }), /method is not supported/);
  } finally {
    for (const key of ['kind', 'id', 'sha256', 'method', 'queryHash', 'rank']) delete Object.prototype[key];
  }
});

test('citation arrays are bounded before traversal and never invoke indexed accessors', () => {
  const branded = source();
  const oversized = Array(33).fill(branded);
  assert.throws(() => createMemoryRecord({
    id: 'observation:oversized', kind: 'observation', text: 'Synthetic.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'source-backed', confidence: 'supported', sources: oversized,
  }), /at most 32/);

  let reads = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return branded; } });
  accessor.length = 1;
  assert.throws(() => createMemoryRecord({
    id: 'observation:accessor', kind: 'observation', text: 'Synthetic.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'source-backed', confidence: 'supported', sources: accessor,
  }), /enumerable data property/);
  assert.equal(reads, 0);
});
