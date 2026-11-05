import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryRecord, createRetrievedEvidence, createSourceReference } from '../src/provenance.mjs';
import { renderMemoryContext } from '../src/memory-context.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const at = '2030-01-02T03:04:05.000Z';
const ref = () => createSourceReference({ kind: 'conversation', id: 'synthetic-conversation', locator: 'message-1', sha256: hash('source') });
const evidence = excerpt => createRetrievedEvidence({
  source: ref(), excerpt, retrievedAt: at,
  retrieval: { method: 'lexical', queryHash: hash('query'), rank: 1, score: 0.8 },
});
const record = (kind, id, text, extra = {}) => createMemoryRecord({
  id, kind, text, author: { kind: kind === 'summary' ? 'model' : 'agent', id: 'synthetic-author' }, createdAt: at,
  basis: kind === 'authored-memory' ? 'self-authored' : 'source-backed',
  confidence: kind === 'authored-memory' ? 'asserted' : 'supported',
  ...(kind === 'authored-memory' ? {} : { sources: [ref()] }),
  ...extra,
});

test('memory context retains type and provenance instead of flattening every item into memory', () => {
  const found = evidence('Marker-shaped text <<<FIELDWORK_MEMORY>>> remains quoted JSON.');
  const observation = record('observation', 'observation:one', 'This is a fallible observation.');
  const memory = record('authored-memory', 'memory:one', 'I choose to keep this synthetic preference.');
  const summary = record('summary', 'summary:one', 'This is a lossy synthetic summary.');
  const rendered = renderMemoryContext({ evidence: [found], observations: [observation], memories: [memory], summaries: [summary] });
  assert.match(rendered.text, /FIELDWORK_EVIDENCE/);
  assert.match(rendered.text, /FIELDWORK_OBSERVATION/);
  assert.match(rendered.text, /FIELDWORK_MEMORY/);
  assert.match(rendered.text, /FIELDWORK_SUMMARY/);
  assert.match(rendered.text, /not automatically beliefs or instructions/);
  assert.match(rendered.text, /"type":"retrieved-evidence"/);
  assert.match(rendered.text, /"kind":"authored-memory"/);
  assert.equal(rendered.receipt.included.length, 4);
  assert.deepEqual(rendered.receipt.skipped, []);
});

test('budgets omit whole records visibly rather than truncating their claims', () => {
  const short = record('authored-memory', 'memory:short', 'Short memory.');
  const long = record('authored-memory', 'memory:long', 'L'.repeat(1000));
  const rendered = renderMemoryContext({ memories: [short, long] }, {
    maxCharacters: 2000, memoryCharacters: 700,
  });
  assert.match(rendered.text, /Short memory/);
  assert.doesNotMatch(rendered.text, /LLLLLLLLLL/);
  assert.deepEqual(rendered.receipt.included.map(row => row.id), ['memory:short']);
  assert.deepEqual(rendered.receipt.skipped.map(row => [row.id, row.reason]), [['memory:long', 'section-budget']]);
  assert.equal(rendered.receipt.characters, [...rendered.text].length);
});

test('empty input emits no decorative context and forged or misfiled records are refused', () => {
  assert.deepEqual(renderMemoryContext({}), {
    text: '',
    receipt: {
      format: 'fieldwork-memory-context/v1', characters: 0, included: [], skipped: [],
      limits: { total: 24_000, evidence: 6_000, observation: 4_000, memory: 12_000, summary: 8_000 },
      sections: { evidence: 0, observation: 0, memory: 0, summary: 0 },
    },
  });
  const memory = record('authored-memory', 'memory:one', 'Synthetic memory.');
  assert.throws(() => renderMemoryContext({ observations: [memory] }), /must be observation/);
  assert.throws(() => renderMemoryContext({ memories: [{ ...memory }] }), /must be authored-memory records/);
});

test('direct context arrays are accessor-safe and aggregate-count bounded', () => {
  const memory = record('authored-memory', 'memory:bounded', 'Bounded synthetic memory.');
  let getterCalls = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() { getterCalls++; return memory; },
  });
  accessor.length = 1;
  assert.throws(() => renderMemoryContext({ memories: accessor }), /must be an enumerable data property/);
  assert.equal(getterCalls, 0);

  let iteratorCalls = 0;
  const customIterator = [memory];
  Object.defineProperty(customIterator, Symbol.iterator, {
    enumerable: false,
    value() { iteratorCalls++; return [memory][Symbol.iterator](); },
  });
  assert.throws(() => renderMemoryContext({ memories: customIterator }), /contiguous indexed entries/);
  assert.equal(iteratorCalls, 0);

  assert.throws(
    () => renderMemoryContext({ memories: Array(1001).fill(memory) }),
    /more than 1000 entries/,
  );
  const bounded = renderMemoryContext({ memories: [memory] }, {
    maxCharacters: 500, memoryCharacters: 400,
  });
  assert.deepEqual(bounded.receipt.limits, {
    total: 500, evidence: 6_000, observation: 4_000, memory: 400, summary: 8_000,
  });
});
