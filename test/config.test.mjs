import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDWORK_CONFIG_FORMAT, normalizeFieldworkConfig, parseFieldworkConfig } from '../src/config.mjs';

const config = packs => ({ format: FIELDWORK_CONFIG_FORMAT, packs });

test('configuration is explicit, ordered, deeply frozen, and semantically fingerprinted', () => {
  const first = normalizeFieldworkConfig(config([
    { name: 'memory', options: { limit: 5, lanes: ['recent', 'exact'] } },
    { name: 'appearance' },
  ]));
  const reorderedKeys = normalizeFieldworkConfig(config([
    { name: 'memory', options: { lanes: ['recent', 'exact'], limit: 5 } },
    { name: 'appearance', options: {} },
  ]));
  assert.deepEqual(first.packs.map(pack => pack.name), ['memory', 'appearance']);
  assert.equal(first.receipt.fingerprint, reorderedKeys.receipt.fingerprint);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.packs[0].options.lanes), true);
  assert.throws(() => { first.packs[0].options.limit = 9; }, TypeError);
});

test('zero configured packs means an exact empty selection', () => {
  const empty = parseFieldworkConfig('{"format":"fieldwork-config/v1","packs":[]}');
  assert.deepEqual(empty.packs, []);
  assert.deepEqual(empty.receipt.totals, { packs: 0, optionBytes: 0 });
});

test('configuration rejects unknown fields, duplicate or invalid names, and non-JSON options', () => {
  assert.throws(() => normalizeFieldworkConfig({ ...config([]), enabled: true }), /unknown field "enabled"/);
  assert.throws(() => normalizeFieldworkConfig(config([{ name: 'memory', typo: true }])), /unknown field "typo"/);
  assert.throws(() => normalizeFieldworkConfig(config([{ name: '../memory' }])), /lowercase letters/);
  assert.throws(() => normalizeFieldworkConfig(config([{ name: 'memory' }, { name: 'memory' }])), /repeats "memory"/);
  assert.throws(() => normalizeFieldworkConfig(config([{ name: 'memory', options: { run() {} } }])), /JSON cannot represent/);
  assert.throws(() => normalizeFieldworkConfig(config([{ name: 'memory', options: null }])), /options must be a JSON object/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => normalizeFieldworkConfig(config([{ name: 'memory', options: cyclic }])), /contains a cycle/);

  let reads = 0;
  const accessor = config([]);
  Object.defineProperty(accessor, 'packs', { enumerable: true, get() { reads++; return []; } });
  assert.throws(() => normalizeFieldworkConfig(accessor), /enumerable data property/);
  assert.equal(reads, 0);
});

test('configuration enforces source, per-pack, aggregate, depth, and count bounds', () => {
  assert.throws(() => parseFieldworkConfig(' '.repeat(30), { maxSourceBytes: 20 }), /source is 30 bytes/);
  assert.throws(() => normalizeFieldworkConfig(config([{ name: 'one', options: { text: '123456' } }]), { maxOptionBytes: 8 }), /JSON bytes/);
  assert.throws(() => normalizeFieldworkConfig(config([
    { name: 'one', options: { x: '1234' } },
    { name: 'two', options: { x: '1234' } },
  ]), { maxTotalOptionBytes: 20 }), /options total/);
  assert.throws(() => normalizeFieldworkConfig(config([{ name: 'one' }, { name: 'two' }]), { maxPacks: 1 }), /limit is 1/);
  let nested = 'leaf';
  for (let index = 0; index < 34; index++) nested = { nested };
  assert.throws(() => normalizeFieldworkConfig(config([{ name: 'one', options: { nested } }])), /depth/);
});

test('an authenticated config is rechecked when a stricter boundary supplies limits', () => {
  const two = normalizeFieldworkConfig(config([{ name: 'one' }, { name: 'two' }]));
  assert.equal(normalizeFieldworkConfig(two), two);
  assert.throws(() => normalizeFieldworkConfig(two, { maxPacks: 1 }), /limit is 1/);
  assert.throws(() => normalizeFieldworkConfig(two, null), /normalizer options must be an object/);
  assert.throws(() => normalizeFieldworkConfig(two, { maxPacks: '2' }), /positive whole number/);
});

test('configuration parsing refuses malformed JSON and invalid UTF-8', () => {
  assert.throws(() => parseFieldworkConfig('{'), /not valid JSON/);
  assert.throws(() => parseFieldworkConfig('{"format":"fieldwork-config/v1","packs":[],"packs":[{"name":"memory"}]}'), /repeats object key "packs"/);
  assert.throws(() => parseFieldworkConfig(Uint8Array.from([0xc3, 0x28])), /valid UTF-8/);
  assert.throws(() => parseFieldworkConfig(42), /text or UTF-8 bytes/);
});

test('prototype pollution cannot supply required configuration fields or limits', () => {
  Object.prototype.format = FIELDWORK_CONFIG_FORMAT;
  Object.prototype.packs = [];
  Object.prototype.maxPacks = 1;
  try {
    assert.throws(() => normalizeFieldworkConfig({}), /format must be/);
    const two = normalizeFieldworkConfig(config([{ name: 'one' }, { name: 'two' }]));
    assert.equal(two.packs.length, 2);
  } finally {
    delete Object.prototype.format;
    delete Object.prototype.packs;
    delete Object.prototype.maxPacks;
  }
});
