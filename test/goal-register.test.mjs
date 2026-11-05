import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGoalRegister, goalRegisterTools, GOAL_REGISTER_FORMAT } from '../src/goal-register.mjs';
import { createToolRegistry, prepareToolCall } from '../src/tools.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-goal-register-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = new Date('2030-01-02T03:04:05.000Z');
  const clock = () => new Date(now);
  const advance = milliseconds => { now = new Date(now.getTime() + milliseconds); return now; };
  const file = path.join(directory, 'goals.json');
  const store = await createGoalRegister({ file, clock });
  return { directory, file, store, clock, advance };
}

const goalDefinition = (overrides = {}) => ({
  kind: 'goal',
  name: 'Read the long shelf',
  statement: 'Read the deliberately selected shelf without turning it into an assignment treadmill.',
  chosenBy: 'agent',
  source: 'The agent explicitly chose this in the synthetic test conversation.',
  successSignals: 'The selected twelve books have exact notes and the goal still feels wanted.',
  reviewAt: '2030-02-01T12:00:00.000Z',
  measures: [{
    key: 'books_read', label: 'Books read', unit: 'books', source: 'The exact rows in reading-log.md',
    target: 12, targetCondition: 'at-least',
  }],
  ...overrides,
});

const promiseDefinition = (overrides = {}) => ({
  kind: 'promise',
  name: 'Return the annotated map',
  statement: 'Return the annotated synthetic map after checking its legend.',
  chosenBy: 'agent',
  source: 'Exact synthetic promise made in conversation test-message-4.',
  beneficiary: 'Synthetic collaborator',
  returnFrom: '2030-01-05T12:00:00.000Z',
  returnBy: '2030-01-07T12:00:00.000Z',
  measures: [],
  ...overrides,
});

test('goals and promises reload with exact distinctions, source edges, and raw statistics', async t => {
  const data = await fixture(t);
  const goal = await data.store.create({ definition: goalDefinition(), actor: 'agent' });
  const promise = await data.store.create({ definition: promiseDefinition(), actor: 'person' });
  assert.match(goal.id, /^goal-/);
  assert.match(promise.id, /^promise-/);
  assert.equal(goal.clock.due, false);
  assert.equal(promise.beneficiary, 'Synthetic collaborator');

  const first = await data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'observed', value: 2,
    observedThrough: '2030-01-01T23:59:59.000Z', note: 'Two exact rows.', actor: 'agent',
  });
  assert.equal(first.again, false);
  data.advance(60_000);
  const quiet = await data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'no-change',
    observedThrough: '2030-01-02T03:05:00.000Z', actor: 'agent',
  });
  assert.equal(quiet.record.statistics[0].samples, 1, 'no-change advances the edge without inventing a sample');
  assert.equal(quiet.record.statistics[0].observedThrough, '2030-01-02T03:05:00.000Z');
  const duplicate = await data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'no-change',
    observedThrough: '2030-01-02T03:05:00.000Z', actor: 'agent',
  });
  assert.equal(duplicate.again, true);
  await assert.rejects(data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'no-change',
    observedThrough: '2030-01-02T03:05:00.000Z', note: 'A conflicting account.', actor: 'agent',
  }), /already has a different check/);

  data.advance(60_000);
  await data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'observed', value: 5,
    observedThrough: '2030-01-02T03:05:30.000Z', actor: 'person',
  });
  const inspected = data.store.inspect(goal.id);
  assert.equal(inspected.checks.length, 3);
  assert.deepEqual(inspected.record.statistics[0], {
    key: 'books_read', label: 'Books read', unit: 'books', source: 'The exact rows in reading-log.md',
    target: 12, targetCondition: 'at-least', checks: 3, samples: 2,
    observedThrough: '2030-01-02T03:05:30.000Z', latestOutcome: 'observed',
    first: { value: 2, observedThrough: '2030-01-01T23:59:59.000Z', recordedAt: '2030-01-02T03:04:05.000Z' },
    latest: { value: 5, observedThrough: '2030-01-02T03:05:30.000Z', recordedAt: '2030-01-02T03:06:05.000Z' },
    minimum: 2, maximum: 5, change: 3, targetReached: false,
  });

  const reopened = await createGoalRegister({ file: data.file, clock: data.clock });
  assert.deepEqual(reopened.inspect(goal.id), inspected);
  assert.equal(reopened.view().records.length, 2);
});

test('the register refuses to blur goals, promises, reminders, and possibilities', async t => {
  const { store } = await fixture(t);
  assert.throws(() => store.create({ definition: goalDefinition({ kind: 'reminder' }) }), /kind must be goal or promise/);
  assert.throws(() => store.create({ definition: goalDefinition({ beneficiary: 'Someone' }) }), /goal does not use beneficiary/);
  assert.throws(() => store.create({ definition: goalDefinition({ successSignals: '' }) }), /needs explicit successSignals/);
  assert.throws(() => store.create({ definition: promiseDefinition({ beneficiary: '' }) }), /promise needs a beneficiary/);
  assert.throws(() => store.create({ definition: promiseDefinition({ returnFrom: '2030-01-08T00:00:00.000Z' }) }), /must not be after/);
  assert.throws(() => store.create({ definition: promiseDefinition({ reviewAt: '2030-02-01T00:00:00.000Z' }) }), /promise uses its beneficiary/);
  assert.throws(() => store.create({ definition: goalDefinition({ measures: [
    { key: 'count', label: 'Count', unit: 'items', source: 'Source A' },
    { key: 'count', label: 'Count again', unit: 'items', source: 'Source B' },
  ] }) }), /measure keys must be unique/);
  assert.throws(() => store.create({ definition: goalDefinition({ measures: [
    { key: 'count', label: 'Count', unit: 'items', source: '' },
  ] }) }), /source must not be empty/);
});

test('definition edits conflict cleanly and every status transition stays reversible or explicit', async t => {
  const { store } = await fixture(t);
  const created = await store.create({ definition: goalDefinition(), actor: 'agent' });
  const [left, right] = await Promise.allSettled([
    store.update({ id: created.id, expectedRevision: 1, changes: { name: 'Read the chosen shelf' }, actor: 'agent' }),
    store.update({ id: created.id, expectedRevision: 1, changes: { name: 'Read every shelf' }, actor: 'person' }),
  ]);
  assert.equal([left, right].filter(result => result.status === 'fulfilled').length, 1);
  assert.equal([left, right].filter(result => result.status === 'rejected').length, 1);
  let row = store.view().records[0];
  assert.equal(row.revision, 2);

  row = await store.pause({ id: row.id, expectedRevision: row.revision, actor: 'agent' });
  assert.equal(row.status, 'paused');
  row = await store.resume({ id: row.id, expectedRevision: row.revision, actor: 'agent' });
  assert.equal(row.status, 'active');
  row = await store.remove({ id: row.id, expectedRevision: row.revision, actor: 'person' });
  assert.equal(row.status, 'removed');
  assert.equal(row.removedFrom, 'active');
  row = await store.restore({ id: row.id, expectedRevision: row.revision, actor: 'person' });
  assert.equal(row.status, 'paused', 'restoring active work does not silently schedule or resume it');
  row = await store.finish({ id: row.id, expectedRevision: row.revision, reason: 'All twelve exact notes exist.', actor: 'agent' });
  assert.equal(row.status, 'finished');
  assert.equal(row.statusNote, 'All twelve exact notes exist.');
  row = await store.remove({ id: row.id, expectedRevision: row.revision, actor: 'person' });
  row = await store.restore({ id: row.id, expectedRevision: row.revision, actor: 'person' });
  assert.equal(row.status, 'finished', 'restoring a terminal record does not revive it');
  assert.deepEqual(store.inspect(row.id).versions.slice(0, 7).map(version => version.action),
    ['restored', 'removed', 'finished', 'restored', 'removed', 'resumed', 'paused']);

  const second = await store.create({ definition: goalDefinition({ name: 'A goal allowed to end' }), actor: 'person' });
  const retired = await store.retire({ id: second.id, expectedRevision: 1, reason: 'The agent no longer wants this goal.', actor: 'agent' });
  assert.equal(retired.status, 'retired');
  await assert.rejects(store.resume({ id: retired.id, expectedRevision: retired.revision, actor: 'agent' }), /only a paused record/);
});

test('measure checks preserve no-change and no-data without manufacturing progress', async t => {
  const data = await fixture(t);
  const goal = await data.store.create({ definition: goalDefinition(), actor: 'agent' });
  assert.throws(() => data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'observed', observedThrough: '2030-01-02T00:00:00.000Z', actor: 'agent',
  }), /observed needs value/);
  assert.throws(() => data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'no-change', value: 2, observedThrough: '2030-01-02T00:00:00.000Z', actor: 'agent',
  }), /no-change needs observedThrough and no value/);
  assert.throws(() => data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'no-data', actor: 'agent',
  }), /no-data needs a note/);
  await assert.rejects(data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'observed', value: 2, observedThrough: '2031-01-02T00:00:00.000Z', actor: 'agent',
  }), /cannot be in the future/);
  const unavailable = await data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'no-data', note: 'The named log was unavailable.', actor: 'agent',
  });
  assert.equal(unavailable.record.statistics[0].samples, 0);
  assert.equal(unavailable.record.statistics[0].observedThrough, null);
  assert.equal(unavailable.check.outcome, 'no-data');
  const again = await data.store.recordCheck({
    id: goal.id, measureKey: 'books_read', outcome: 'no-data', note: 'It remained unavailable.', actor: 'agent',
  });
  assert.equal(again.again, false, 'no-data has no source edge and remains a distinct attempt');
  const retired = await data.store.retire({ id: goal.id, expectedRevision: 1, reason: 'Chosen abandonment.', actor: 'agent' });
  await assert.rejects(data.store.recordCheck({
    id: retired.id, measureKey: 'books_read', outcome: 'no-data', note: 'Late check.', actor: 'agent',
  }), /only to active or paused records/);
});

test('agent tools can choose, inspect, measure, and retire without inventing a promise', async t => {
  const { store } = await fixture(t);
  const definitions = goalRegisterTools(store);
  const registry = createToolRegistry(definitions);
  const summary = prepareToolCall(registry, 'choose_long_term_goal', {
    name: 'Tend one synthetic archive',
    statement: 'PRIVATE SYNTHETIC GOAL STATEMENT',
    source: 'PRIVATE SYNTHETIC GOAL SOURCE',
    successSignals: 'PRIVATE SYNTHETIC SUCCESS SIGNALS',
    reviewAt: '2030-02-01T00:00:00.000Z',
  }).permissionSummary;
  assert.match(summary, /Record goal Tend one synthetic archive/);
  assert.doesNotMatch(summary, /PRIVATE SYNTHETIC/);
  const tools = new Map(definitions.map(tool => [tool.name, tool]));
  const chosen = await tools.get('choose_long_term_goal').execute({
    name: 'Tend one synthetic archive',
    statement: 'Tend the selected archive carefully.',
    source: 'I chose this in the current synthetic turn.',
    successSignals: 'Every selected item has an exact source edge.',
    reviewAt: '2030-02-01T00:00:00.000Z',
    measures: [{ key: 'items', label: 'Items checked', unit: 'items', source: 'Synthetic archive index' }],
  });
  const listed = await tools.get('list_goals_and_promises').execute({});
  assert.equal(listed.records[0].chosenBy, 'agent');
  assert.equal(listed.records[0].id, chosen.id);
  const measured = await tools.get('record_goal_measure').execute({
    id: chosen.id, measureKey: 'items', outcome: 'observed', value: 3, observedThrough: '2030-01-02T00:00:00.000Z',
  });
  assert.equal(measured.statistics.latest.value, 3);
  const read = await tools.get('read_goal_or_promise').execute({ id: chosen.id });
  assert.equal(read.record.source, 'I chose this in the current synthetic turn.');
  const retired = await tools.get('change_goal_or_promise_status').execute({
    id: chosen.id, expectedRevision: 1, action: 'retire', reason: 'This no longer catches my interest.',
  });
  assert.equal(retired.status, 'retired');
  await assert.rejects(tools.get('change_goal_or_promise_status').execute({
    id: chosen.id, expectedRevision: retired.revision, action: 'finish',
  }), /needs an honest reason/);
  assert.equal(tools.has('record_explicit_promise'), true);
  assert.equal(listed.records.some(row => row.kind === 'promise'), false, 'choosing a goal does not silently create a promise');
});

test('saved state and inputs are closed-shape, duplicate-key, and accessor safe', async t => {
  const data = await fixture(t);
  let touched = false;
  const hostile = {};
  Object.defineProperty(hostile, 'definition', { enumerable: true, get() { touched = true; return goalDefinition(); } });
  assert.throws(() => data.store.create(hostile), /enumerable data property/);
  assert.equal(touched, false);
  assert.throws(() => data.store.create({ definition: { ...goalDefinition(), surprise: true } }), /unknown field/);

  const duplicateFile = path.join(data.directory, 'duplicate.json');
  await fs.writeFile(duplicateFile, `{"format":"${GOAL_REGISTER_FORMAT}","format":"${GOAL_REGISTER_FORMAT}","revision":0,"records":[],"checks":[]}\n`);
  await assert.rejects(createGoalRegister({ file: duplicateFile }), /could not read the saved file/);

  const malformedFile = path.join(data.directory, 'malformed.json');
  await fs.writeFile(malformedFile, JSON.stringify({ format: GOAL_REGISTER_FORMAT, revision: 0, records: [], checks: [{ nope: true }] }));
  await assert.rejects(createGoalRegister({ file: malformedFile }), /saved check/);
});
