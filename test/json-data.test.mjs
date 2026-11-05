import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedJson, canonicalJson, deepFreeze, parseJsonNoDuplicates } from '../src/json-data.mjs';

test('bounded JSON serializes the inspected data without invoking inherited toJSON', () => {
  Object.defineProperty(Object.prototype, 'toJSON', {
    value() { return { replaced: true }; }, configurable: true,
  });
  try {
    const normalized = boundedJson({ safe: 1 }, { object: true });
    assert.deepEqual(normalized.value, { safe: 1 });
    assert.equal(normalized.canonical, '{"safe":1}');
  } finally {
    delete Object.prototype.toJSON;
  }
});

test('arrays reject holes, accessors, symbols, and numeric-looking properties outside length', () => {
  const hole = new Array(1);
  assert.throws(() => boundedJson(hole), /holes or accessors|contiguous/);
  const accessor = [];
  Object.defineProperty(accessor, '0', { get: () => 1, enumerable: true });
  assert.throws(() => boundedJson(accessor), /holes or accessors/);
  const outside = [];
  Object.defineProperty(outside, '4294967295', { value: 'discarded', enumerable: true });
  assert.throws(() => boundedJson(outside), /contiguous indexed/);
  const symbol = [];
  symbol[Symbol('hidden')] = 1;
  assert.throws(() => boundedJson(symbol), /contiguous indexed/);
});

test('objects reject accessors and symbols while safely preserving __proto__ as data', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'value', { get: () => 1, enumerable: true });
  assert.throws(() => boundedJson(accessor), /enumerable data property/);
  const symbol = { [Symbol('hidden')]: 1 };
  assert.throws(() => boundedJson(symbol), /symbol keys/);
  const proto = JSON.parse('{"__proto__":{"safe":true}}');
  const normalized = boundedJson(proto, { object: true }).value;
  assert.equal(Object.hasOwn(normalized, '__proto__'), true);
  assert.deepEqual(normalized.__proto__, { safe: true });
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
});

test('depth, node, byte, cycle, and root-object limits apply to the cloned value', () => {
  assert.throws(() => boundedJson({ a: { b: 1 } }, { maxDepth: 1 }), /depth/);
  assert.throws(() => boundedJson([1, 2, 3], { maxNodes: 3 }), /value count/);
  assert.throws(() => boundedJson({ text: '123456' }, { maxBytes: 8 }), /JSON bytes/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => boundedJson(cycle), /cycle/);
  assert.throws(() => boundedJson([], { object: true }), /must be a JSON object/);
});

test('deepFreeze descends through cycles, symbols, and already-frozen parents', () => {
  const child = { value: 1 };
  const symbolChild = { value: 2 };
  const parent = { child, [Symbol('child')]: symbolChild };
  parent.self = parent;
  Object.freeze(parent);
  deepFreeze(parent);
  assert.equal(Object.isFrozen(child), true);
  assert.equal(Object.isFrozen(symbolChild), true);
  assert.equal(Object.isFrozen(parent), true);
});

test('canonical JSON is key-order stable and refuses non-JSON values', () => {
  assert.equal(canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  assert.throws(() => canonicalJson(undefined), /requires JSON data/);
});

test('bounded JSON normalizes negative zero so values and receipts agree', () => {
  const negative = boundedJson({ n: -0 }, { object: true });
  const positive = boundedJson({ n: 0 }, { object: true });
  assert.equal(Object.is(negative.value.n, -0), false);
  assert.equal(negative.canonical, positive.canonical);
});

test('strict JSON parsing rejects duplicate keys at every object depth', () => {
  assert.deepEqual(parseJsonNoDuplicates('{"a":1,"nested":{"b":2}}'), { a: 1, nested: { b: 2 } });
  assert.throws(() => parseJsonNoDuplicates('{"a":1,"a":2}'), /repeats object key "a" at \$/);
  assert.throws(() => parseJsonNoDuplicates('{"a":1,"\\u0061":2}'), /repeats object key "a" at \$/);
  assert.throws(() => parseJsonNoDuplicates('{"nested":{"b":1,"b":2}}'), /repeats object key "b" at \$\.nested/);
  assert.throws(() => parseJsonNoDuplicates('{'), /not valid JSON/);
  const deep = '['.repeat(200) + '0' + ']'.repeat(200);
  assert.throws(() => parseJsonNoDuplicates(deep, { maxDepth: 64 }), /maximum JSON depth of 64/);
});

test('strict JSON depth is rejected before the native parser constructs the value', () => {
  const original = JSON.parse;
  let calls = 0;
  JSON.parse = (...args) => { calls++; return original(...args); };
  try {
    const exact = '['.repeat(32) + '0' + ']'.repeat(32);
    assert.ok(Array.isArray(parseJsonNoDuplicates(exact, { maxDepth: 32 })));
    assert.equal(calls, 1);
    calls = 0;
    const oneTooDeep = '['.repeat(33) + '0' + ']'.repeat(33);
    assert.throws(() => parseJsonNoDuplicates(oneTooDeep, { maxDepth: 32 }), /maximum JSON depth of 32/);
    assert.equal(calls, 0);
  } finally {
    JSON.parse = original;
  }
});
