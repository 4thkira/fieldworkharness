import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_LIFECYCLE_FORMAT,
  memoryLifecycle,
  memoryLifecycleStatus,
  normalizeMemoryLifecycle,
} from '../src/memory-lifecycle.mjs';

const before = '2029-12-31T00:00:00.000Z';
const due = '2030-01-02T03:04:05.000Z';
const after = '2030-01-03T00:00:00.000Z';

test('legacy memories are active facts without rewriting their stored record', () => {
  const lifecycle = memoryLifecycle(undefined);
  assert.deepEqual(lifecycle, { format: MEMORY_LIFECYCLE_FORMAT, type: 'fact' });
  assert.deepEqual(memoryLifecycleStatus(undefined, due), {
    format: 'fieldwork-memory-lifecycle-status/v1',
    type: 'fact',
    asOf: due,
    phase: 'active',
    eligible: true,
    due: false,
    attention: [],
  });
  assert.equal(Object.isFrozen(lifecycle), true);
});

test('clock status separates delayed resurfacing, due review, and expired influence', () => {
  const lifecycle = normalizeMemoryLifecycle({
    type: 'verdict',
    notBefore: due,
    reviewAt: after,
    expiresAt: after,
    evidence: 'Three synthetic checks agreed.',
    changeCriteria: 'A new check disagrees.',
    reviewPrompt: 'Do the checks still agree?',
  });
  const scheduled = memoryLifecycleStatus(lifecycle, before);
  assert.equal(scheduled.phase, 'scheduled');
  assert.equal(scheduled.eligible, false);
  assert.equal(scheduled.due, false);
  assert.equal(scheduled.nextAt, due);

  const active = memoryLifecycleStatus(lifecycle, due);
  assert.equal(active.phase, 'active');
  assert.equal(active.eligible, true);
  assert.equal(active.due, false);
  assert.equal(active.nextAt, after);

  const expired = memoryLifecycleStatus(lifecycle, after);
  assert.equal(expired.phase, 'expired');
  assert.equal(expired.eligible, false);
  assert.equal(expired.due, true);
  assert.deepEqual(expired.attention, ['review-due', 'expired']);
  assert.equal(expired.dueAt, after);
});

test('reminders become due without silently becoming obligations', () => {
  const reminder = normalizeMemoryLifecycle({ type: 'reminder', notBefore: due });
  const status = memoryLifecycleStatus(reminder, due);
  assert.equal(status.type, 'reminder');
  assert.equal(status.phase, 'active');
  assert.deepEqual(status.attention, ['ready']);
  assert.equal(status.dueAt, due);
});

test('lifecycle metadata rejects ambiguous clocks and incomplete verdicts', () => {
  assert.throws(() => normalizeMemoryLifecycle({ type: 'reminder', notBefore: 'tomorrow' }), /exact ISO timestamp/);
  assert.throws(() => normalizeMemoryLifecycle({ type: 'fact', evidence: 'Synthetic evidence.' }), /only valid for verdict/);
  assert.throws(() => normalizeMemoryLifecycle({ type: 'verdict', reviewAt: due, changeCriteria: 'New evidence.' }), /must state their evidence/);
  assert.throws(() => normalizeMemoryLifecycle({
    type: 'verdict', evidence: 'Synthetic evidence.', changeCriteria: 'New evidence.',
  }), /need reviewAt or expiresAt/);
  assert.throws(() => normalizeMemoryLifecycle({ type: 'reminder', notBefore: after, expiresAt: due }), /later than lifecycle.notBefore/);
  assert.throws(() => normalizeMemoryLifecycle({ type: 'reminder', notBefore: after, reviewAt: due }), /not be earlier/);
  assert.throws(() => normalizeMemoryLifecycle({ type: 'fact', reviewAt: after, expiresAt: due }), /must not be later/);
  assert.throws(() => normalizeMemoryLifecycle({ type: 'fact', unknown: true }), /unknown field/);
});

test('stored lifecycle values carry an explicit format and reject format drift', () => {
  const created = normalizeMemoryLifecycle({ type: 'possibility', reviewAt: due });
  const restored = normalizeMemoryLifecycle(JSON.parse(JSON.stringify(created)), { stored: true });
  assert.deepEqual(restored, created);
  assert.throws(() => normalizeMemoryLifecycle({ ...created, format: 'fieldwork-memory-lifecycle/v9' }, { stored: true }), /format must be/);
  assert.throws(() => normalizeMemoryLifecycle({ ...created }), /unknown field "format"/);
});
