import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createTaskHeartbeatStore,
  startTaskHeartbeatScheduler,
  TASK_HEARTBEAT_FORMAT,
} from '../src/task-heartbeats.mjs';

const claimChildFile = fileURLToPath(new URL('./support/task-heartbeat-claim-child.mjs', import.meta.url));

async function storeFile(t, name = 'task-heartbeats.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-task-heartbeats-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'state', name);
}

function handClock(iso) {
  let now = new Date(iso);
  return {
    clock: () => new Date(now),
    set: next => { now = new Date(next); },
    addMinutes: minutes => { now = new Date(now.getTime() + minutes * 60_000); },
    addHours: hours => { now = new Date(now.getTime() + hours * 3_600_000); },
  };
}

function definition(overrides = {}) {
  return {
    name: 'Watch the specimen',
    task: 'Inspect the synthetic specimen and report only a material state change.',
    meaningfulChange: 'The specimen state differs from the last receipt.',
    completionRule: 'The specimen reaches its terminal synthetic state.',
    cadenceHours: 2,
    toolNames: ['inspect_zeta', 'inspect_alpha'],
    ...overrides,
  };
}

function launchClaimChild(t, file, at) {
  const child = fork(claimChildFile, [file, at], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return { child, stderr: () => stderr };
}

function nextChildMessage(run, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const fail = reason => {
      cleanup();
      reject(new Error(`${reason}${run.stderr() ? `\n${run.stderr()}` : ''}`));
    };
    const onMessage = message => {
      if (message?.type === 'error') return fail(`task heartbeat claim child failed: ${message.stack ?? message.message}`);
      if (message?.type !== expected) return fail(`task heartbeat claim child sent ${JSON.stringify(message)} while waiting for ${expected}`);
      cleanup();
      resolve(message);
    };
    const onError = error => fail(`task heartbeat claim child error: ${error.message}`);
    const onExit = (code, signal) => fail(`task heartbeat claim child exited before ${expected} (code ${code}, signal ${signal})`);
    const timer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      fail(`task heartbeat claim child timed out before ${expected}`);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      run.child.off('message', onMessage);
      run.child.off('error', onError);
      run.child.off('exit', onExit);
    };
    run.child.once('message', onMessage);
    run.child.once('error', onError);
    run.child.once('exit', onExit);
  });
}

function childExit(run, timeoutMs = 10_000) {
  if (run.child.exitCode !== null || run.child.signalCode !== null) {
    return Promise.resolve({ code: run.child.exitCode, signal: run.child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      reject(new Error(`task heartbeat claim child did not exit${run.stderr() ? `\n${run.stderr()}` : ''}`));
    }, timeoutMs);
    run.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function sendChild(run, message, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      reject(new Error(`task heartbeat claim child did not accept the barrier${run.stderr() ? `\n${run.stderr()}` : ''}`));
    }, timeoutMs);
    try {
      run.child.send(message, error => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

test('a durable heartbeat waits a full cadence and reloads with exact tools and history', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createTaskHeartbeatStore({ file, clock: time.clock });
  const created = await store.create({ definition: definition(), actor: 'agent' });

  assert.equal(created.status, 'active');
  assert.equal(created.nextRunAt, '2030-01-02T14:00:00.000Z');
  assert.deepEqual(created.toolNames, ['inspect_alpha', 'inspect_zeta']);
  assert.equal(created.running, false);
  assert.equal(store.view().revision, 1);
  assert.deepEqual(store.view().choices.cadenceHours, [1, 2, 3, 4, 6, 8, 12, 24]);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.toolNames), true);

  const inspected = store.inspect(created.id);
  assert.equal(inspected.versions.length, 1);
  assert.equal(inspected.versions[0].action, 'created');
  assert.equal(inspected.versions[0].by, 'agent');
  assert.equal(inspected.receipts.length, 0);

  const reloaded = await createTaskHeartbeatStore({ file, clock: time.clock });
  assert.equal(reloaded.view().format, TASK_HEARTBEAT_FORMAT);
  assert.deepEqual(reloaded.view().heartbeats, store.view().heartbeats);
  assert.deepEqual(await reloaded.claimDue(), { started: false, reason: 'not due' });
  time.addHours(2);
  assert.equal((await reloaded.claimDue()).started, true);
});

test('goal-measure bindings are versioned exactly and legacy v1 files migrate without inventing a link', async t => {
  const file = await storeFile(t);
  const store = await createTaskHeartbeatStore({ file });
  const binding = {
    type: 'goal-measure',
    recordId: `goal-${randomUUID()}`,
    measureKey: 'synthetic_count',
  };
  const created = await store.create({
    definition: definition({
      toolNames: ['read_goal_or_promise', 'record_goal_measure'],
      binding,
    }),
  });
  assert.deepEqual(created.binding, binding);
  assert.deepEqual(store.inspect(created.id).versions[0].value.binding, binding);

  const cleared = await store.update({
    id: created.id,
    expectedRevision: created.revision,
    changes: { binding: null },
  });
  assert.equal(cleared.binding, null);
  assert.deepEqual(store.inspect(created.id).versions.map(version => version.value.binding), [null, binding]);

  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.format = 'fieldwork-task-heartbeats/v1';
  for (const row of saved.heartbeats) {
    delete row.binding;
    for (const version of row.versions) delete version.value.binding;
  }
  await fs.writeFile(file, `${JSON.stringify(saved)}\n`);
  const legacy = await createTaskHeartbeatStore({ file });
  assert.equal(legacy.view().format, TASK_HEARTBEAT_FORMAT);
  assert.equal(legacy.inspect(created.id).heartbeat.binding, null);
  assert.equal(legacy.inspect(created.id).versions[0].value.binding, null);

  await legacy.update({
    id: created.id,
    expectedRevision: cleared.revision,
    changes: { binding },
  });
  const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(migrated.format, TASK_HEARTBEAT_FORMAT);
  assert.deepEqual(migrated.heartbeats[0].binding, binding);
});

test('definition edits are conflict-checked and pause, remove, and restore stay reversible', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createTaskHeartbeatStore({ file: await storeFile(t), clock: time.clock });
  const created = await store.create({ definition: definition() });

  time.addMinutes(10);
  const updated = await store.update({
    id: created.id,
    expectedRevision: created.revision,
    changes: { cadenceHours: 4, task: 'Inspect the revised synthetic specimen.' },
    actor: 'person',
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.nextRunAt, '2030-01-02T16:10:00.000Z', 'cadence changes restart the wait');
  await assert.rejects(store.update({
    id: created.id,
    expectedRevision: 1,
    changes: { name: 'Stale edit' },
  }), error => error.status === 409 && /changed since it was read/.test(error.message));

  const concurrent = await Promise.allSettled([
    store.update({ id: created.id, expectedRevision: 2, changes: { name: 'First edit' } }),
    store.update({ id: created.id, expectedRevision: 2, changes: { name: 'Second edit' } }),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);

  let current = store.inspect(created.id).heartbeat;
  current = await store.pause({ id: current.id, expectedRevision: current.revision, actor: 'agent' });
  assert.equal(current.status, 'paused');
  assert.equal(current.nextRunAt, null);
  current = await store.resume({ id: current.id, expectedRevision: current.revision });
  assert.equal(current.status, 'active');
  current = await store.remove({ id: current.id, expectedRevision: current.revision });
  assert.equal(current.status, 'removed');
  assert.equal(current.removedAt, time.clock().toISOString());
  current = await store.restore({ id: current.id, expectedRevision: current.revision, actor: 'agent' });
  assert.equal(current.status, 'paused', 'restoring never silently schedules work');
  assert.equal(current.removedAt, null);

  const actions = store.inspect(created.id).versions.map(version => version.action);
  assert.deepEqual(actions.slice(0, 5), ['restored', 'removed', 'resumed', 'paused', 'updated']);
});

test('claim tokens fence overlapping work and every valid outcome leaves the right receipt', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createTaskHeartbeatStore({ file: await storeFile(t), clock: time.clock });
  const created = await store.create({ definition: definition({ cadenceHours: 1 }) });
  time.addHours(1);

  const due = await store.claimDue();
  assert.equal(due.started, true);
  assert.equal(due.heartbeat.running, true);
  assert.deepEqual(await store.claimDue(), { started: false, reason: 'not due' });
  assert.deepEqual(await store.claimNow(created.id), { started: false, reason: 'claimed' });
  await assert.rejects(store.finish({
    id: created.id,
    claimToken: randomUUID(),
    outcome: 'no-change',
  }), error => error.status === 409 && /expired or was already finished/.test(error.message));
  await assert.rejects(store.finish({
    id: created.id,
    claimToken: due.claim.token,
    outcome: 'no-change',
    note: 'Nothing happened.',
  }), /no-change must not carry/);

  const quiet = await store.finish({ id: created.id, claimToken: due.claim.token, outcome: 'no-change' });
  assert.equal(quiet.receipt.outcome, 'no-change');
  assert.equal(Object.hasOwn(quiet.receipt, 'note'), false);
  assert.equal(quiet.heartbeat.nextRunAt, '2030-01-02T14:00:00.000Z');

  const manual = await store.claimNow(created.id);
  await assert.rejects(store.finish({
    id: created.id,
    claimToken: manual.claim.token,
    outcome: 'changed',
  }), /changed needs a note/);
  const changed = await store.finish({
    id: created.id,
    claimToken: manual.claim.token,
    outcome: 'changed',
    note: 'The synthetic state changed from blue to gold.',
  });
  assert.equal(changed.receipt.runKind, 'manual');
  assert.equal(changed.receipt.note, 'The synthetic state changed from blue to gold.');

  const finalClaim = await store.claimNow(created.id);
  const finished = await store.finish({
    id: created.id,
    claimToken: finalClaim.claim.token,
    outcome: 'finished',
    note: 'The terminal synthetic state was reached.',
  });
  assert.equal(finished.heartbeat.status, 'finished');
  assert.equal(finished.heartbeat.nextRunAt, null);
  assert.equal(finished.heartbeat.finishedAt, time.clock().toISOString());
  assert.deepEqual(await store.claimNow(created.id), { started: false, reason: 'finished' });
  assert.deepEqual(store.inspect(created.id).receipts.map(receipt => receipt.outcome), ['finished', 'changed', 'no-change']);
});

test('independently opened stores choose one due claim, refresh the loser, and finish through either instance', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const [first, second] = await Promise.all([
    createTaskHeartbeatStore({ file, clock: time.clock }),
    createTaskHeartbeatStore({ file, clock: time.clock }),
  ]);
  const created = await first.create({ definition: definition({ cadenceHours: 1 }) });
  time.addHours(1);

  const claimed = await Promise.all([first.claimDue(), second.claimDue()]);
  const winnerIndex = claimed.findIndex(result => result.started);
  assert.notEqual(winnerIndex, -1);
  assert.equal(claimed.filter(result => result.started).length, 1);
  assert.deepEqual(claimed.find(result => !result.started), { started: false, reason: 'not due' });
  const winner = winnerIndex === 0 ? first : second;
  const loser = winnerIndex === 0 ? second : first;
  const token = claimed[winnerIndex].claim.token;
  const savedClaim = JSON.parse(await fs.readFile(file, 'utf8')).claims;
  assert.equal(savedClaim.length, 1);
  assert.equal(savedClaim[0].token, token);
  assert.equal(loser.inspect(created.id).heartbeat.running, true, 'the no-change loser refreshed from disk');

  const finished = await loser.finish({ id: created.id, claimToken: token, outcome: 'no-change' });
  assert.equal(finished.stale, false);
  assert.equal(finished.heartbeat.running, false);
  assert.deepEqual(await winner.claimDue(), { started: false, reason: 'not due' });
  assert.equal(winner.inspect(created.id).heartbeat.running, false, 'a later no-change operation refreshes the winner');
  assert.deepEqual(winner.inspect(created.id).receipts.map(receipt => receipt.outcome), ['no-change']);
  await assert.rejects(fs.access(`${file}.lock`), { code: 'ENOENT' });
});

test('a stale revisioned edit merges without erasing a newer claim', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const [runner, editor] = await Promise.all([
    createTaskHeartbeatStore({ file, clock: time.clock }),
    createTaskHeartbeatStore({ file, clock: time.clock }),
  ]);
  const created = await runner.create({ definition: definition({ cadenceHours: 1 }) });
  time.addHours(1);
  const claimed = await runner.claimDue();
  assert.equal(claimed.started, true);

  const paused = await editor.pause({ id: created.id, expectedRevision: created.revision, actor: 'person' });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.running, true);
  const afterEdit = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(afterEdit.heartbeats[0].status, 'paused');
  assert.equal(afterEdit.claims.length, 1);
  assert.equal(afterEdit.claims[0].token, claimed.claim.token, 'the whole-file edit preserved the fresh claim');

  const finished = await runner.finish({
    id: created.id,
    claimToken: claimed.claim.token,
    outcome: 'changed',
    note: 'The claimed specimen changed before the watch was paused.',
  });
  assert.equal(finished.heartbeat.status, 'paused');
  assert.equal(finished.heartbeat.running, false);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).claims.length, 0);
});

test('independent processes choose one durable heartbeat claim after a shared barrier', async t => {
  const file = await storeFile(t);
  const initialAt = '2030-01-02T12:00:00.000Z';
  const dueAt = '2030-01-02T13:00:00.000Z';
  const prepared = await createTaskHeartbeatStore({ file, clock: () => new Date(initialAt) });
  await prepared.create({ definition: definition({ cadenceHours: 1 }) });

  const runs = [launchClaimChild(t, file, dueAt), launchClaimChild(t, file, dueAt)];
  await Promise.all(runs.map(run => nextChildMessage(run, 'ready')));
  const resultsReady = runs.map(run => nextChildMessage(run, 'result'));
  await Promise.all(runs.map(run => sendChild(run, { type: 'claim' })));
  const messages = await Promise.all(resultsReady);
  const results = messages.map(message => message.result);
  const exits = await Promise.all(runs.map(run => childExit(run)));

  assert.deepEqual(exits, [{ code: 0, signal: null }, { code: 0, signal: null }]);
  assert.equal(results.filter(result => result.started).length, 1);
  assert.deepEqual(results.find(result => !result.started), { started: false, reason: 'not due' });
  const winner = results.find(result => result.started);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.claims.length, 1);
  assert.equal(saved.claims[0].token, winner.claim.token);
  await assert.rejects(fs.access(`${file}.lock`), { code: 'ENOENT' });
});

test('independent expiry races record one claim-expired receipt', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const [first, second] = await Promise.all([
    createTaskHeartbeatStore({ file, clock: time.clock, claimMinutes: 15 }),
    createTaskHeartbeatStore({ file, clock: time.clock, claimMinutes: 15 }),
  ]);
  const created = await first.create({ definition: definition({ cadenceHours: 1 }) });
  time.addHours(1);
  const abandoned = await first.claimDue();
  assert.equal(abandoned.started, true);
  time.addMinutes(16);

  const reaped = await Promise.all([first.claimDue(), second.claimDue()]);
  assert.deepEqual(reaped, [
    { started: false, reason: 'not due' },
    { started: false, reason: 'not due' },
  ]);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.claims.length, 0);
  assert.equal(saved.receipts.filter(receipt => receipt.outcome === 'claim-expired').length, 1);
  assert.equal(saved.receipts[0].claimedAt, abandoned.claim.claimedAt);
  assert.equal(saved.heartbeats[0].nextRunAt, '2030-01-02T14:16:00.000Z');
  assert.equal(first.inspect(created.id).receipts.filter(receipt => receipt.outcome === 'claim-expired').length, 1);
  assert.equal(second.inspect(created.id).receipts.filter(receipt => receipt.outcome === 'claim-expired').length, 1);
});

test('an expired durable claim records its own receipt and cannot haunt a later edit', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const file = await storeFile(t);
  const store = await createTaskHeartbeatStore({ file, clock: time.clock, claimMinutes: 15 });
  const created = await store.create({ definition: definition() });
  const abandoned = await store.claimNow(created.id);
  time.addMinutes(16);

  const edited = await store.update({
    id: created.id,
    expectedRevision: created.revision,
    changes: { meaningfulChange: 'The revised synthetic threshold is crossed.' },
  });
  assert.equal(edited.revision, 2);
  assert.equal(edited.running, false);
  assert.equal(store.inspect(created.id).receipts[0].outcome, 'claim-expired');
  await assert.rejects(store.finish({
    id: created.id,
    claimToken: abandoned.claim.token,
    outcome: 'failed',
  }), error => error.status === 409);

  const reloaded = await createTaskHeartbeatStore({ file, clock: time.clock });
  assert.equal(reloaded.inspect(created.id).receipts[0].outcome, 'claim-expired');
});

test('an expired scheduled claim defers the same edge by a full cadence without weakening its token fence', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createTaskHeartbeatStore({ file: await storeFile(t), clock: time.clock, claimMinutes: 15 });
  const created = await store.create({ definition: definition({ cadenceHours: 1 }) });
  time.addHours(1);

  const abandoned = await store.claimDue();
  assert.equal(abandoned.started, true);
  assert.equal(abandoned.claim.claimedAt, '2030-01-02T13:00:00.000Z');
  time.addMinutes(16);

  assert.deepEqual(await store.claimDue(), { started: false, reason: 'not due' });
  const deferred = store.inspect(created.id);
  assert.equal(deferred.heartbeat.nextRunAt, '2030-01-02T14:16:00.000Z');
  assert.equal(deferred.receipts[0].outcome, 'claim-expired');
  assert.equal(deferred.receipts[0].at, '2030-01-02T13:16:00.000Z');

  time.addHours(1);
  const replacement = await store.claimDue();
  assert.equal(replacement.started, true);
  assert.notEqual(replacement.claim.token, abandoned.claim.token);
  await assert.rejects(store.finish({
    id: created.id,
    claimToken: abandoned.claim.token,
    outcome: 'no-change',
  }), error => error.status === 409 && /expired or was already finished/.test(error.message));
  assert.equal(store.inspect(created.id).heartbeat.running, true, 'a stale token cannot consume the replacement claim');

  const finished = await store.finish({
    id: created.id,
    claimToken: replacement.claim.token,
    outcome: 'no-change',
  });
  assert.equal(finished.receipt.claimedAt, '2030-01-02T14:16:00.000Z');
  assert.equal(finished.heartbeat.running, false);
});

test('a room restart reaps an already-expired heartbeat claim without reclaiming its scheduled edge', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const first = await createTaskHeartbeatStore({ file, clock: time.clock, claimMinutes: 15 });
  const created = await first.create({ definition: definition({ cadenceHours: 1 }) });
  time.addHours(1);
  const abandoned = await first.claimDue();
  assert.equal(abandoned.started, true);
  time.addMinutes(16);

  const restarted = await createTaskHeartbeatStore({ file, clock: time.clock, claimMinutes: 15 });
  assert.deepEqual(await restarted.claimDue(), { started: false, reason: 'not due' });
  const deferred = restarted.inspect(created.id);
  assert.equal(deferred.receipts[0].outcome, 'claim-expired');
  assert.equal(deferred.receipts[0].claimedAt, abandoned.claim.claimedAt);
  assert.equal(deferred.heartbeat.nextRunAt, '2030-01-02T14:16:00.000Z');

  time.addHours(1);
  const next = await restarted.claimDue();
  assert.equal(next.started, true);
  assert.notEqual(next.claim.token, abandoned.claim.token);
});

test('the scheduler is single-flight and turns throws or invalid reports into failure receipts', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createTaskHeartbeatStore({ file: await storeFile(t), clock: time.clock });
  const firstHeartbeat = await store.create({ definition: definition({ name: 'First watch', cadenceHours: 1 }) });
  time.addHours(1);
  let release;
  let entered;
  const runnerEntered = new Promise(resolve => { entered = resolve; });
  const errors = [];
  const scheduler = startTaskHeartbeatScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    onError: error => errors.push(error.message),
    run: heartbeat => new Promise(resolve => {
      assert.equal(heartbeat.id, firstHeartbeat.id);
      release = resolve;
      entered();
    }),
  });
  t.after(() => scheduler.stop());

  const first = scheduler.tick();
  await runnerEntered;
  assert.equal(typeof release, 'function', 'the runner began');
  assert.equal(scheduler.running, true);
  assert.equal(scheduler.runningId, firstHeartbeat.id);
  assert.deepEqual(await scheduler.tick(), { started: false, reason: 'busy' });
  release({ outcome: 'changed', note: 'The scheduled specimen changed.' });
  assert.equal((await first).receipt.outcome, 'changed');
  assert.equal(scheduler.running, false);

  const second = await store.create({ definition: definition({ name: 'Second watch' }) });
  const throwing = startTaskHeartbeatScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    onError: error => errors.push(error.message),
    run: async () => { throw new Error('synthetic provider failure'); },
  });
  t.after(() => throwing.stop());
  assert.equal((await throwing.now(second.id)).receipt.outcome, 'failed');
  assert.deepEqual(errors, ['synthetic provider failure']);

  const third = await store.create({ definition: definition({ name: 'Third watch' }) });
  const invalid = startTaskHeartbeatScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    run: async () => ({ outcome: 'no-change', note: 'This prose must not escape.' }),
  });
  t.after(() => invalid.stop());
  const invalidResult = await invalid.now(third.id);
  assert.equal(invalidResult.receipt.outcome, 'failed');
  assert.equal(store.inspect(third.id).heartbeat.running, false, 'invalid runners never strand a claim');
  invalid.stop();
  assert.deepEqual(await invalid.now(third.id), { started: false, reason: 'stopped' });
});

test('the scheduler respects its run gate without claiming durable work', async t => {
  const store = await createTaskHeartbeatStore({ file: await storeFile(t) });
  const created = await store.create({ definition: definition() });
  const scheduler = startTaskHeartbeatScheduler({
    store,
    canRun: () => false,
    everyMs: 60 * 60 * 1000,
    run: async () => ({ outcome: 'no-change' }),
  });
  t.after(() => scheduler.stop());
  assert.deepEqual(await scheduler.now(created.id), { started: false, reason: 'busy' });
  assert.equal(store.inspect(created.id).heartbeat.running, false);
});

test('the heartbeat persistence hook is ordered after finish and keeps the scheduler busy until it settles', async t => {
  const store = await createTaskHeartbeatStore({ file: await storeFile(t) });
  const created = await store.create({ definition: definition({ name: 'Persistence ordering watch' }) });
  let releaseHook;
  let hookEntered;
  const hookGate = new Promise(resolve => { releaseHook = resolve; });
  const entered = new Promise(resolve => { hookEntered = resolve; });
  let receipt;
  let scheduler;
  scheduler = startTaskHeartbeatScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    run: async () => ({ outcome: 'changed', note: 'The synthetic state changed.' }),
    onPersist: async value => {
      receipt = value;
      assert.equal(store.inspect(value.id).receipts[0].outcome, 'changed');
      assert.equal(store.inspect(value.id).heartbeat.running, false, 'the durable claim is already finished');
      assert.equal(scheduler.running, true, 'local single-flight includes host finalization');
      hookEntered();
      await hookGate;
    },
  });
  t.after(() => scheduler.stop());
  const work = scheduler.now(created.id);
  await entered;
  let resolved = false;
  void work.then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.deepEqual(Object.keys(receipt), ['id', 'runKind', 'outcome', 'runSucceeded', 'saved', 'error']);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(receipt, {
    id: created.id, runKind: 'manual', outcome: 'changed', runSucceeded: true, saved: true, error: null,
  });
  releaseHook();
  assert.equal((await work).receipt.outcome, 'changed');
  assert.equal(scheduler.running, false);
});

test('heartbeat persistence reports runner and save failures, and hook failure never replays a run', async t => {
  const store = await createTaskHeartbeatStore({ file: await storeFile(t) });
  const failed = await store.create({ definition: definition({ name: 'Runner failure watch' }) });
  const runnerReceipts = [];
  const runnerFailure = startTaskHeartbeatScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    run: async () => { throw new Error('synthetic runner failure'); },
    onPersist: value => runnerReceipts.push(value),
  });
  t.after(() => runnerFailure.stop());
  assert.equal((await runnerFailure.now(failed.id)).receipt.outcome, 'failed');
  assert.deepEqual(runnerReceipts[0], {
    id: failed.id, runKind: 'manual', outcome: 'failed', runSucceeded: false, saved: true, error: null,
  });

  const file = await storeFile(t, 'save-failure.json');
  const saveStore = await createTaskHeartbeatStore({ file });
  const unsavable = await saveStore.create({ definition: definition({ name: 'Save failure watch' }) });
  let releaseRun;
  let runEntered;
  const gate = new Promise(resolve => { releaseRun = resolve; });
  const entered = new Promise(resolve => { runEntered = resolve; });
  const saveReceipts = [];
  let runs = 0;
  const saveFailure = startTaskHeartbeatScheduler({
    store: saveStore,
    everyMs: 60 * 60 * 1000,
    run: async () => { runs += 1; runEntered(); await gate; return { outcome: 'no-change' }; },
    onPersist: value => saveReceipts.push(value),
  });
  t.after(() => saveFailure.stop());
  const work = saveFailure.now(unsavable.id);
  await entered;
  await fs.rm(path.dirname(file), { recursive: true, force: true });
  await fs.writeFile(path.dirname(file), 'this file blocks the state directory');
  releaseRun();
  await assert.rejects(work);
  assert.equal(runs, 1);
  assert.equal(saveReceipts.length, 1);
  assert.equal(saveReceipts[0].runSucceeded, true);
  assert.equal(saveReceipts[0].saved, false);
  assert.ok(saveReceipts[0].error instanceof Error);

  const hookStore = await createTaskHeartbeatStore({ file: await storeFile(t, 'hook-failure.json') });
  const hookHeartbeat = await hookStore.create({ definition: definition({ name: 'Hook failure watch' }) });
  let hookRuns = 0;
  let effectRuns = 0;
  const errors = [];
  const hookFailure = startTaskHeartbeatScheduler({
    store: hookStore,
    everyMs: 60 * 60 * 1000,
    run: async () => { effectRuns += 1; return { outcome: 'no-change' }; },
    onPersist: () => { hookRuns += 1; throw new Error('synthetic hook failure'); },
    onError: error => errors.push(error.message),
  });
  t.after(() => hookFailure.stop());
  assert.equal((await hookFailure.now(hookHeartbeat.id)).receipt.outcome, 'no-change');
  assert.equal(effectRuns, 1);
  assert.equal(hookRuns, 1);
  assert.deepEqual(errors, ['synthetic hook failure']);
  assert.equal(hookStore.inspect(hookHeartbeat.id).receipts.length, 1);
  assert.throws(() => startTaskHeartbeatScheduler({ store: hookStore, run: async () => ({}), onPersist: true }), /onPersist must be a function/);
});

test('definitions reject ambiguous JSON, unknown fields, duplicate tools, and duplicate live names', async t => {
  const store = await createTaskHeartbeatStore({ file: await storeFile(t) });
  await store.create({ definition: definition() });
  await assert.rejects(store.create({ definition: definition({ name: 'watch THE specimen' }) }), error => error.status === 409);
  assert.throws(() => store.create({ definition: { ...definition({ name: 'Unknown' }), surprise: true } }), /unknown field/);
  assert.throws(() => store.create({ definition: definition({ name: 'Tools', toolNames: ['inspect_one', 'inspect_one'] }) }), /repeats/);
  assert.throws(() => store.create({ definition: definition({ name: 'Cadence', cadenceHours: 5 }) }), /must be one of/);
  assert.throws(() => store.create({ definition: definition({ name: 'Large', task: 'x'.repeat(4001) }) }), /at most 4000/);
  assert.throws(() => store.create({ definition: definition({ name: 'Bad binding', binding: { type: 'goal-measure', recordId: 'goal-nope', measureKey: 'count' } }) }), /exact goal or promise id/);
  assert.throws(() => store.create({ definition: definition({ name: 'Bad measure', binding: { type: 'goal-measure', recordId: `goal-${randomUUID()}`, measureKey: 'Not Valid' } }) }), /exact measure key/);
  assert.throws(() => store.create({ definition: definition({ name: 'Bad binding field', binding: { type: 'goal-measure', recordId: `goal-${randomUUID()}`, measureKey: 'count', extra: true } }) }), /unknown field/);

  let getterRead = false;
  const hostile = definition({ name: 'Accessor' });
  Object.defineProperty(hostile, 'task', {
    enumerable: true,
    get() { getterRead = true; return 'do not execute this getter'; },
  });
  assert.throws(() => store.create({ definition: hostile }), /data property/);
  assert.equal(getterRead, false);
});

test('malformed and duplicate-key saved files are refused instead of silently reset', async t => {
  const malformed = await storeFile(t, 'malformed.json');
  await fs.mkdir(path.dirname(malformed), { recursive: true });
  await fs.writeFile(malformed, '{"format":"fieldwork-task-heartbeats/v1", nope}');
  await assert.rejects(createTaskHeartbeatStore({ file: malformed }), /could not read the saved file/);

  const repeated = await storeFile(t, 'repeated.json');
  await fs.mkdir(path.dirname(repeated), { recursive: true });
  await fs.writeFile(repeated, '{"format":"fieldwork-task-heartbeats/v1","format":"fieldwork-task-heartbeats/v1","revision":0,"heartbeats":[],"receipts":[],"claims":[]}');
  await assert.rejects(createTaskHeartbeatStore({ file: repeated }), /could not read the saved file/);
});
