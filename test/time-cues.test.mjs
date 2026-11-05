import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTimeCues, parseTimeCues, resolveTimeZone, timeCueContentText, timeCuesMatchInstant,
} from '../src/time-cues.mjs';

const now = '2026-11-01T12:00:00.000Z';

test('relative days follow the configured calendar zone across daylight-saving changes', () => {
  const parsed = parseTimeCues('Compare yesterday with today.', { now, timeZone: 'America/New_York' });
  assert.equal(isTimeCues(parsed), true);
  assert.equal(parsed.receipt.timeZone, 'America/New_York');
  const yesterday = parsed.receipt.ranges.find(range => range.relation === 'yesterday');
  const today = parsed.receipt.ranges.find(range => range.relation === 'today');
  assert.deepEqual(yesterday, {
    from: '2026-10-31T04:00:00.000Z', to: '2026-11-01T04:00:00.000Z',
    kind: 'day', relation: 'yesterday',
  });
  assert.deepEqual(today, {
    from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z',
    kind: 'day', relation: 'today',
  });
  assert.equal(timeCuesMatchInstant(parsed, '2026-10-31T20:00:00.000Z'), true);
  assert.equal(timeCuesMatchInstant(parsed, '2026-10-30T20:00:00.000Z'), false);
});

test('recognized date phrases are removed without erasing the subject words', () => {
  const parsed = parseTimeCues('What happened yesterday with the cobalt gate?', { now, timeZone: 'UTC' });
  assert.equal(timeCueContentText(parsed), 'what happened with the cobalt gate?');
  assert.deepEqual(parsed.receipt.ranges.map(range => range.relation), ['yesterday']);
  assert.equal(parsed.receipt.contentCharacters, 35);
});

test('named dates and months choose the most recent past occurrence unless a year is explicit', () => {
  const parsed = parseTimeCues('March 3, 2024; in October; and December 12.', { now, timeZone: 'UTC' });
  assert.deepEqual(parsed.receipt.ranges, [
    { from: '2024-03-03T00:00:00.000Z', to: '2024-03-04T00:00:00.000Z', kind: 'day', relation: 'named-date' },
    { from: '2025-12-12T00:00:00.000Z', to: '2025-12-13T00:00:00.000Z', kind: 'day', relation: 'named-date' },
    { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', kind: 'month', relation: 'named-month' },
  ]);
});

test('calendar-week and days-ago cues are bounded and explicit', () => {
  const parsed = parseTimeCues('two days ago, last week, and this week', { now, timeZone: 'UTC' });
  assert.deepEqual(parsed.receipt.ranges.map(range => range.relation), ['ago', 'last-week', 'this-week']);
  assert.deepEqual(parsed.receipt.ranges[1], {
    from: '2026-10-19T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z',
    kind: 'week', relation: 'last-week',
  });
  assert.deepEqual(parsed.receipt.ranges[2], {
    from: '2026-10-26T00:00:00.000Z', to: '2026-11-01T12:00:00.001Z',
    kind: 'week', relation: 'this-week',
  });
});

test('time-cue inputs are strict, bounded, and accessor-safe', () => {
  assert.equal(resolveTimeZone('UTC'), 'UTC');
  assert.throws(() => resolveTimeZone('Not/AZone'), /not a valid IANA time zone/);
  assert.throws(() => parseTimeCues('x', { now: '2026-11-01' }), /exact ISO timestamp/);
  assert.throws(() => parseTimeCues('x'.repeat(100_001)), /limit is 100000/);
  let invoked = false;
  const options = {};
  Object.defineProperty(options, 'now', { enumerable: true, get() { invoked = true; return now; } });
  assert.throws(() => parseTimeCues('yesterday', options), /enumerable data property/);
  assert.equal(invoked, false);
  const empty = parseTimeCues('No calendar language here.', { now, timeZone: 'UTC' });
  assert.deepEqual(empty.receipt.ranges, []);
  assert.equal(timeCueContentText(empty), 'no calendar language here.');
  const orderOnly = parseTimeCues('the first cobalt gate', { now, timeZone: 'UTC' });
  assert.deepEqual(orderOnly.receipt.ranges, [], 'global first/last ordering is deliberately not inferred');
  assert.equal(timeCueContentText(orderOnly), 'the first cobalt gate');
  const many = parseTimeCues(Array.from({ length: 33 }, (_, index) => `${2000 + index}-01-01`).join(' '), { now, timeZone: 'UTC' });
  assert.equal(many.receipt.ranges.length, 32);
  assert.equal(many.receipt.omittedRanges, 1);
});
