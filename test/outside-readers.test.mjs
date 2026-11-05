import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createOutsideReaderStore,
  startOutsideReaderScheduler,
  OUTSIDE_READER_FORMAT,
  OUTSIDE_READER_LIMITS,
} from '../src/outside-readers.mjs';

const claimChildFile = fileURLToPath(new URL('./support/outside-reader-claim-child.mjs', import.meta.url));

const GOAL_ONE = 'goal-00000000-0000-4000-8000-000000000001';
const GOAL_TWO = 'goal-00000000-0000-4000-8000-000000000002';
const PROMISE_ONE = 'promise-00000000-0000-4000-8000-000000000003';

async function storeFile(t, name = 'outside-readers.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-outside-readers-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'state', name);
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
      if (message?.type === 'error') return fail(`outside reader claim child failed: ${message.stack ?? message.message}`);
      if (message?.type !== expected) return fail(`outside reader claim child sent ${JSON.stringify(message)} while waiting for ${expected}`);
      cleanup();
      resolve(message);
    };
    const onError = error => fail(`outside reader claim child error: ${error.message}`);
    const onExit = (code, signal) => fail(`outside reader claim child exited before ${expected} (code ${code}, signal ${signal})`);
    const timer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      fail(`outside reader claim child timed out before ${expected}`);
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
      reject(new Error(`outside reader claim child did not exit${run.stderr() ? `\n${run.stderr()}` : ''}`));
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
      reject(new Error(`outside reader claim child did not accept the barrier${run.stderr() ? `\n${run.stderr()}` : ''}`));
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

function handClock(value) {
  let now = new Date(value);
  return {
    clock: () => new Date(now),
    set: next => { now = new Date(next); },
    addMinutes: minutes => { now = new Date(now.getTime() + minutes * 60_000); },
    addHours: hours => { now = new Date(now.getTime() + hours * 3_600_000); },
  };
}

function definition(overrides = {}) {
  return {
    name: 'Outside promise review',
    focus: 'Read only the selected records. Look for contradictions, broken promises, and unclear commitments.',
    cadenceHours: 2,
    source: { type: 'goal-record-set', recordIds: [GOAL_ONE, PROMISE_ONE] },
    ...overrides,
  };
}

function sourceReceipt(overrides = {}) {
  return {
    type: 'goal-record-set',
    fingerprint: 'a'.repeat(64),
    records: 2,
    items: 7,
    observedAt: '2030-01-02T12:00:00.000Z',
    ...overrides,
  };
}

function contradiction(overrides = {}) {
  return {
    kind: 'contradiction',
    summary: 'The two selected records make incompatible commitments.',
    evidence: [
      { ref: `${GOAL_ONE}#body`, excerpt: 'The launch must happen before the review.' },
      { ref: `${PROMISE_ONE}#body`, excerpt: 'The review must happen before the launch.' },
    ],
    ...overrides,
  };
}

function heavyFindings(label) {
  return Array.from({ length: OUTSIDE_READER_LIMITS.findings }, (_, findingIndex) => ({
    kind: 'unclear',
    summary: `Unclear synthetic item ${label}-${findingIndex}: ${'s'.repeat(1800)}`,
    evidence: Array.from({ length: OUTSIDE_READER_LIMITS.evidencePerFinding }, (_, evidenceIndex) => ({
      ref: `${GOAL_ONE}#${label}-${findingIndex}-${evidenceIndex}`,
      excerpt: `Synthetic evidence ${label}-${findingIndex}-${evidenceIndex}: ${'e'.repeat(1100)}`,
    })),
  }));
}

test('a reader persists its exact record set, waits a full cadence, and exposes runner limits', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file, clock: time.clock });
  const created = await store.create({ definition: definition(), actor: 'agent' });

  assert.equal(OUTSIDE_READER_FORMAT, 'fieldwork-outside-readers/v1');
  assert.equal(OUTSIDE_READER_LIMITS.sourceBytes, 256 * 1024);
  assert.equal(OUTSIDE_READER_LIMITS.findings, 12);
  assert.equal(OUTSIDE_READER_LIMITS.summaryCharacters, 2000);
  assert.equal(OUTSIDE_READER_LIMITS.evidencePerFinding, 6);
  assert.equal(OUTSIDE_READER_LIMITS.excerptCharacters, 1200);
  assert.equal(OUTSIDE_READER_LIMITS.focusCharacters, 4000);
  assert.deepEqual(OUTSIDE_READER_LIMITS.cadenceHours, [1, 2, 3, 4, 6, 8, 12, 24]);

  assert.equal(created.status, 'active');
  assert.equal(created.nextRunAt, '2030-01-02T14:00:00.000Z');
  assert.deepEqual(created.source, definition().source);
  assert.equal(created.running, false);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.source.recordIds), true);

  const view = store.view();
  assert.equal(view.format, OUTSIDE_READER_FORMAT);
  assert.equal(view.revision, 1);
  assert.deepEqual(view.choices.findingKinds, ['contradiction', 'broken-promise', 'unclear']);
  const inspection = store.inspect(created.id);
  assert.equal(inspection.versions.length, 1);
  assert.equal(inspection.versions[0].action, 'created');
  assert.equal(inspection.versions[0].by, 'agent');
  assert.deepEqual(inspection.receipts, []);

  const reloaded = await createOutsideReaderStore({ file, clock: time.clock });
  assert.deepEqual(reloaded.view().readers, store.view().readers);
  assert.deepEqual(await reloaded.claimDue(), { started: false, reason: 'not due' });
  time.addHours(2);
  const due = await reloaded.claimDue();
  assert.equal(due.started, true);
  assert.equal(due.claim.runKind, 'scheduled');
  assert.deepEqual(due.reader.source.recordIds, [GOAL_ONE, PROMISE_ONE]);
});

test('definition edits are conflict checked and every lifecycle change is reversible and versioned', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file: await storeFile(t), clock: time.clock });
  const created = await store.create({ definition: definition() });

  time.addMinutes(10);
  const updated = await store.update({
    id: created.id,
    expectedRevision: created.revision,
    changes: {
      focus: 'Review the revised exact record set without taking any action.',
      cadenceHours: 4,
      source: { type: 'goal-record-set', recordIds: [GOAL_ONE, GOAL_TWO, PROMISE_ONE] },
    },
    actor: 'person',
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.nextRunAt, '2030-01-02T16:10:00.000Z');
  assert.deepEqual(updated.source.recordIds, [GOAL_ONE, GOAL_TWO, PROMISE_ONE]);
  await assert.rejects(store.update({
    id: created.id,
    expectedRevision: 1,
    changes: { name: 'Stale outside edit' },
  }), error => error.status === 409 && /changed since it was read/.test(error.message));

  const concurrent = await Promise.allSettled([
    store.update({ id: created.id, expectedRevision: 2, changes: { name: 'First exact edit' } }),
    store.update({ id: created.id, expectedRevision: 2, changes: { name: 'Second exact edit' } }),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);

  let current = store.inspect(created.id).reader;
  current = await store.pause({ id: current.id, expectedRevision: current.revision, actor: 'agent' });
  assert.equal(current.status, 'paused');
  assert.equal(current.nextRunAt, null);
  current = await store.resume({ id: current.id, expectedRevision: current.revision });
  assert.equal(current.status, 'active');
  current = await store.remove({ id: current.id, expectedRevision: current.revision });
  assert.equal(current.status, 'removed');
  assert.equal(current.removedAt, time.clock().toISOString());
  assert.deepEqual(await store.claimNow(current.id), { started: false, reason: 'removed' });
  current = await store.restore({ id: current.id, expectedRevision: current.revision, actor: 'agent' });
  assert.equal(current.status, 'paused', 'restoring never silently schedules a review');
  assert.equal(current.removedAt, null);

  assert.deepEqual(
    store.inspect(created.id).versions.slice(0, 5).map(version => version.action),
    ['restored', 'removed', 'resumed', 'paused', 'updated'],
  );
  await assert.rejects(store.create({ definition: definition({ name: current.name.toUpperCase() }) }), error => error.status === 409);
});

test('all four result outcomes leave strict, durable receipts', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file, clock: time.clock });
  const created = await store.create({ definition: definition() });

  let claim = await store.claimNow(created.id);
  let result = await store.finish({
    id: created.id,
    claimToken: claim.claim.token,
    outcome: 'source-unchanged',
    source: sourceReceipt(),
    provider: null,
  });
  assert.equal(result.receipt.outcome, 'source-unchanged');
  assert.equal(result.receipt.provider, null);
  assert.equal(Object.hasOwn(result.receipt, 'findings'), false);

  claim = await store.claimNow(created.id);
  result = await store.finish({
    id: created.id,
    claimToken: claim.claim.token,
    outcome: 'no-findings',
    source: sourceReceipt({ fingerprint: 'b'.repeat(64) }),
    provider: 'synthetic-reviewer-v1',
    findings: [],
  });
  assert.deepEqual(result.receipt.findings, []);
  assert.equal(result.receipt.provider, 'synthetic-reviewer-v1');

  claim = await store.claimNow(created.id);
  result = await store.finish({
    id: created.id,
    claimToken: claim.claim.token,
    outcome: 'findings',
    source: sourceReceipt({ fingerprint: 'c'.repeat(64) }),
    provider: 'synthetic-reviewer-v1',
    findings: [
      contradiction(),
      {
        kind: 'broken-promise',
        summary: 'The promise has passed its explicit due date without a completion receipt.',
        evidence: [{ ref: `${PROMISE_ONE}#due`, excerpt: 'Due 2029-12-31; status remains active.' }],
      },
    ],
  });
  assert.equal(result.receipt.findings.length, 2);
  assert.equal(result.receipt.findings[0].kind, 'contradiction');

  claim = await store.claimNow(created.id);
  result = await store.finish({
    id: created.id,
    claimToken: claim.claim.token,
    outcome: 'failed',
    note: 'The isolated reviewer was unavailable.',
    source: sourceReceipt({ fingerprint: 'd'.repeat(64) }),
    provider: 'synthetic-reviewer-v1',
  });
  assert.equal(result.receipt.note, 'The isolated reviewer was unavailable.');
  assert.equal(Object.hasOwn(result.receipt, 'findings'), false);

  assert.deepEqual(
    store.inspect(created.id).receipts.map(receipt => receipt.outcome),
    ['failed', 'findings', 'no-findings', 'source-unchanged'],
  );
  const reloaded = await createOutsideReaderStore({ file, clock: time.clock });
  assert.deepEqual(reloaded.inspect(created.id).receipts, store.inspect(created.id).receipts);
});

test('result validation rejects ambiguous sources, providers, findings, and failure payloads without consuming the claim', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file: await storeFile(t), clock: time.clock });
  const created = await store.create({ definition: definition() });
  const claim = await store.claimNow(created.id);
  const finish = payload => store.finish({ id: created.id, claimToken: claim.claim.token, ...payload });

  await assert.rejects(finish({ outcome: 'source-unchanged', source: sourceReceipt() }), /requires provider null/);
  await assert.rejects(finish({
    outcome: 'source-unchanged', source: sourceReceipt(), provider: 'a-model',
  }), /requires provider null/);
  await assert.rejects(finish({
    outcome: 'source-unchanged', source: sourceReceipt(), provider: null, note: 'leak',
  }), /must not carry findings or a note/);
  await assert.rejects(finish({
    outcome: 'no-findings', source: sourceReceipt(), provider: null,
  }), /needs a provider/);
  await assert.rejects(finish({
    outcome: 'no-findings', source: sourceReceipt(), provider: 'reviewer', findings: [contradiction()],
  }), /zero findings/);
  await assert.rejects(finish({
    outcome: 'findings', source: sourceReceipt(), provider: 'reviewer', findings: [],
  }), /must not be empty/);
  await assert.rejects(finish({
    outcome: 'findings',
    source: sourceReceipt(),
    provider: 'reviewer',
    findings: [contradiction({ evidence: [{ ref: `${GOAL_ONE}#body`, excerpt: 'Only one side.' }] })],
  }), /at least two distinct/);
  await assert.rejects(finish({
    outcome: 'findings',
    source: sourceReceipt(),
    provider: 'reviewer',
    findings: [contradiction({
      evidence: [
        { ref: `${GOAL_ONE}#body`, excerpt: 'First.' },
        { ref: `${GOAL_ONE}#body`, excerpt: 'Repeated.' },
      ],
    })],
  }), /refs must be distinct/);
  await assert.rejects(finish({
    outcome: 'findings',
    source: sourceReceipt(),
    provider: 'reviewer',
    findings: Array.from({ length: 13 }, (_, index) => ({
      kind: 'unclear',
      summary: `Unclear item ${index}`,
      evidence: [{ ref: `${GOAL_ONE}#${index}`, excerpt: 'The commitment lacks a measurable condition.' }],
    })),
  }), /at most 12/);
  await assert.rejects(finish({
    outcome: 'no-findings',
    source: sourceReceipt({ fingerprint: 'NOT-A-DIGEST' }),
    provider: 'reviewer',
  }), /lowercase SHA-256/);
  await assert.rejects(finish({
    outcome: 'no-findings', source: sourceReceipt({ records: -1 }), provider: 'reviewer',
  }), /whole number/);
  await assert.rejects(finish({
    outcome: 'no-findings',
    source: sourceReceipt({ observedAt: '2030-01-02T12:00:00Z' }),
    provider: 'reviewer',
  }), /exact ISO/);
  await assert.rejects(finish({
    outcome: 'no-findings',
    source: sourceReceipt({ observedAt: '2030-01-02T12:00:01.000Z' }),
    provider: 'reviewer',
  }), /must not be in the future/);
  await assert.rejects(finish({ outcome: 'failed' }), /needs a note/);
  await assert.rejects(finish({ outcome: 'failed', note: 'Failed.', findings: [] }), /must not carry findings/);

  assert.equal(store.inspect(created.id).reader.running, true, 'validation failures preserve the fenced claim');
  const resolved = await finish({ outcome: 'failed', note: 'The synthetic validation exercise ended.' });
  assert.equal(resolved.receipt.outcome, 'failed');
});

test('a source receipt must describe an observation made during its exact claim', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file: await storeFile(t), clock: time.clock });
  const created = await store.create({ definition: definition() });
  time.addMinutes(5);
  const claim = await store.claimNow(created.id);

  await assert.rejects(store.finish({
    id: created.id,
    claimToken: claim.claim.token,
    outcome: 'no-findings',
    source: sourceReceipt({ observedAt: '2030-01-02T12:00:00.000Z' }),
    provider: 'reviewer',
  }), /must not predate the claim/);
  assert.equal(store.inspect(created.id).reader.running, true);
  await store.finish({
    id: created.id,
    claimToken: claim.claim.token,
    outcome: 'no-findings',
    source: sourceReceipt({ observedAt: '2030-01-02T12:05:00.000Z' }),
    provider: 'reviewer',
  });
});

test('claim tokens fence overlap, expiration leaves a receipt, and a stale token cannot finish', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const file = await storeFile(t);
  const store = await createOutsideReaderStore({ file, clock: time.clock, claimMinutes: 15 });
  const created = await store.create({ definition: definition() });
  const abandoned = await store.claimNow(created.id);

  assert.deepEqual(await store.claimNow(created.id), { started: false, reason: 'claimed' });
  await assert.rejects(store.finish({
    id: created.id,
    claimToken: randomUUID(),
    outcome: 'failed',
    note: 'Wrong fence.',
  }), error => error.status === 409);
  await assert.rejects(store.update({
    id: created.id,
    expectedRevision: created.revision,
    changes: { focus: 'A running reader cannot accept this edit.' },
  }), error => error.status === 409 && /cannot be edited/.test(error.message));
  await assert.rejects(store.remove({
    id: created.id,
    expectedRevision: created.revision,
  }), error => error.status === 409 && /cannot be removed/.test(error.message));

  time.addMinutes(16);
  const edited = await store.update({
    id: created.id,
    expectedRevision: created.revision,
    changes: { focus: 'The expired fence no longer blocks this exact edit.' },
  });
  assert.equal(edited.revision, 2);
  assert.equal(edited.running, false);
  assert.equal(store.inspect(created.id).receipts[0].outcome, 'claim-expired');
  await assert.rejects(store.finish({
    id: created.id,
    claimToken: abandoned.claim.token,
    outcome: 'failed',
    note: 'Too late.',
  }), error => error.status === 409);

  const reloaded = await createOutsideReaderStore({ file, clock: time.clock });
  assert.equal(reloaded.inspect(created.id).receipts[0].outcome, 'claim-expired');
});

test('independently opened stores choose one due claim, refresh the loser, and finish through either instance', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const [first, second] = await Promise.all([
    createOutsideReaderStore({ file, clock: time.clock }),
    createOutsideReaderStore({ file, clock: time.clock }),
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
  assert.equal(loser.inspect(created.id).reader.running, true, 'the no-change loser refreshed from disk');

  const finished = await loser.finish({
    id: created.id,
    claimToken: token,
    outcome: 'failed',
    note: 'Synthetic cross-instance completion.',
  });
  assert.equal(finished.stale, false);
  assert.equal(finished.reader.running, false);
  assert.deepEqual(await winner.claimDue(), { started: false, reason: 'not due' });
  assert.equal(winner.inspect(created.id).reader.running, false, 'a later no-change operation refreshes the winner');
  assert.deepEqual(winner.inspect(created.id).receipts.map(receipt => receipt.outcome), ['failed']);
  await assert.rejects(fs.access(`${file}.lock`), { code: 'ENOENT' });
});

test('a stale unrelated edit merges without erasing a newer outside-reader claim', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const [runner, editor] = await Promise.all([
    createOutsideReaderStore({ file, clock: time.clock }),
    createOutsideReaderStore({ file, clock: time.clock }),
  ]);
  const claimedReader = await runner.create({ definition: definition({ name: 'Claimed review', cadenceHours: 1 }) });
  const editedReader = await runner.create({ definition: definition({ name: 'Separate review', cadenceHours: 2 }) });
  time.addHours(1);
  const claimed = await runner.claimDue();
  assert.equal(claimed.started, true);
  assert.equal(claimed.reader.id, claimedReader.id);

  const paused = await editor.pause({ id: editedReader.id, expectedRevision: editedReader.revision, actor: 'person' });
  assert.equal(paused.status, 'paused');
  const afterEdit = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(afterEdit.readers.find(reader => reader.id === editedReader.id).status, 'paused');
  assert.equal(afterEdit.claims.length, 1);
  assert.equal(afterEdit.claims[0].token, claimed.claim.token, 'the whole-file edit preserved the fresh claim');

  const finished = await editor.finish({
    id: claimedReader.id,
    claimToken: claimed.claim.token,
    outcome: 'failed',
    note: 'The claimed review finished after the separate edit.',
  });
  assert.equal(finished.reader.running, false);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).claims.length, 0);
});

test('independent processes choose one durable outside-reader claim after a shared barrier', async t => {
  const file = await storeFile(t);
  const initialAt = '2030-01-02T12:00:00.000Z';
  const dueAt = '2030-01-02T13:00:00.000Z';
  const prepared = await createOutsideReaderStore({ file, clock: () => new Date(initialAt) });
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

test('independent outside-reader expiry races record one claim-expired receipt', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const [first, second] = await Promise.all([
    createOutsideReaderStore({ file, clock: time.clock, claimMinutes: 15 }),
    createOutsideReaderStore({ file, clock: time.clock, claimMinutes: 15 }),
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
  assert.equal(saved.readers[0].nextRunAt, '2030-01-02T14:16:00.000Z');
  assert.equal(first.inspect(created.id).receipts.filter(receipt => receipt.outcome === 'claim-expired').length, 1);
  assert.equal(second.inspect(created.id).receipts.filter(receipt => receipt.outcome === 'claim-expired').length, 1);
});

test('an expired scheduled claim defers its edge by one cadence instead of being reclaimed immediately', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const file = await storeFile(t);
  const store = await createOutsideReaderStore({ file, clock: time.clock, claimMinutes: 15 });
  const created = await store.create({ definition: definition({ cadenceHours: 1 }) });

  time.addHours(1);
  const abandoned = await store.claimDue();
  assert.equal(abandoned.started, true);
  assert.equal(abandoned.claim.runKind, 'scheduled');

  time.addMinutes(16);
  assert.deepEqual(await store.claimDue(), { started: false, reason: 'not due' });
  const inspection = store.inspect(created.id);
  assert.equal(inspection.reader.running, false);
  assert.equal(inspection.reader.nextRunAt, '2030-01-02T14:16:00.000Z');
  assert.equal(inspection.receipts[0].outcome, 'claim-expired');
  assert.equal(inspection.receipts[0].claimedAt, abandoned.claim.claimedAt);
  await assert.rejects(store.finish({
    id: created.id,
    claimToken: abandoned.claim.token,
    outcome: 'failed',
    note: 'The expired token must stay stale.',
  }), error => error.status === 409);

  time.addMinutes(59);
  assert.deepEqual(await store.claimDue(), { started: false, reason: 'not due' });
  time.addMinutes(1);
  const next = await store.claimDue();
  assert.equal(next.started, true);
  assert.notEqual(next.claim.token, abandoned.claim.token);
  assert.equal(next.claim.claimedAt, '2030-01-02T14:16:00.000Z');
});

test('a room restart reaps an already-expired outside-reader claim without reclaiming its scheduled edge', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00.000Z');
  const first = await createOutsideReaderStore({ file, clock: time.clock, claimMinutes: 15 });
  const created = await first.create({ definition: definition({ cadenceHours: 1 }) });
  time.addHours(1);
  const abandoned = await first.claimDue();
  assert.equal(abandoned.started, true);
  time.addMinutes(16);

  const restarted = await createOutsideReaderStore({ file, clock: time.clock, claimMinutes: 15 });
  assert.deepEqual(await restarted.claimDue(), { started: false, reason: 'not due' });
  const deferred = restarted.inspect(created.id);
  assert.equal(deferred.receipts[0].outcome, 'claim-expired');
  assert.equal(deferred.receipts[0].claimedAt, abandoned.claim.claimedAt);
  assert.equal(deferred.reader.nextRunAt, '2030-01-02T14:16:00.000Z');

  time.addHours(1);
  const next = await restarted.claimDue();
  assert.equal(next.started, true);
  assert.notEqual(next.claim.token, abandoned.claim.token);
});

test('the scheduler is single-flight and converts throws, malformed returns, and future source receipts into failures', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file: await storeFile(t), clock: time.clock });
  const firstReader = await store.create({ definition: definition({ name: 'First outside review', cadenceHours: 1 }) });
  time.addHours(1);
  let release;
  let entered;
  const runnerEntered = new Promise(resolve => { entered = resolve; });
  const errors = [];
  const scheduler = startOutsideReaderScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    onError: error => errors.push(error.message),
    run: reader => new Promise(resolve => {
      assert.equal(reader.id, firstReader.id);
      release = resolve;
      entered();
    }),
  });
  t.after(() => scheduler.stop());

  const first = scheduler.tick();
  await runnerEntered;
  assert.equal(scheduler.running, true);
  assert.equal(scheduler.runningId, firstReader.id);
  assert.deepEqual(await scheduler.tick(), { started: false, reason: 'busy' });
  release({
    outcome: 'no-findings',
    source: sourceReceipt({ observedAt: '2030-01-02T13:00:00.000Z' }),
    provider: 'isolated-reviewer',
    findings: [],
  });
  assert.equal((await first).receipt.outcome, 'no-findings');
  assert.equal(scheduler.running, false);

  const second = await store.create({ definition: definition({ name: 'Throwing outside review' }) });
  const throwing = startOutsideReaderScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    onError: error => errors.push(error.message),
    run: async () => { throw new Error('synthetic isolated-provider failure'); },
  });
  t.after(() => throwing.stop());
  assert.equal((await throwing.now(second.id)).receipt.outcome, 'failed');
  assert.deepEqual(errors, ['synthetic isolated-provider failure']);

  const third = await store.create({ definition: definition({ name: 'Malformed outside review' }) });
  const invalid = startOutsideReaderScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    run: async () => ({ outcome: 'no-findings', source: sourceReceipt(), provider: null }),
  });
  t.after(() => invalid.stop());
  assert.equal((await invalid.now(third.id)).receipt.outcome, 'failed');
  assert.equal(store.inspect(third.id).reader.running, false);

  const fourth = await store.create({ definition: definition({ name: 'Future source review' }) });
  const future = startOutsideReaderScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    run: async () => ({
      outcome: 'no-findings',
      source: sourceReceipt({ observedAt: '2030-01-02T13:00:01.000Z' }),
      provider: 'isolated-reviewer',
    }),
  });
  t.after(() => future.stop());
  const futureResult = await future.now(fourth.id);
  assert.equal(futureResult.receipt.outcome, 'failed');
  assert.match(futureResult.receipt.note, /invalid result/);

  future.stop();
  assert.deepEqual(await future.now(fourth.id), { started: false, reason: 'stopped' });
});

test('the scheduler run gate never claims durable work', async t => {
  const store = await createOutsideReaderStore({ file: await storeFile(t) });
  const created = await store.create({ definition: definition() });
  const scheduler = startOutsideReaderScheduler({
    store,
    canRun: () => false,
    everyMs: 60 * 60 * 1000,
    run: async () => ({ outcome: 'failed', note: 'Must never run.' }),
  });
  t.after(() => scheduler.stop());
  assert.deepEqual(await scheduler.now(created.id), { started: false, reason: 'busy' });
  assert.equal(store.inspect(created.id).reader.running, false);
});

test('the outside-reader persistence hook follows the one definitive finish and remains inside single-flight', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file: await storeFile(t), clock: time.clock });
  const created = await store.create({ definition: definition({ name: 'Persistence ordering review' }) });
  let releaseHook;
  let hookEntered;
  const hookGate = new Promise(resolve => { releaseHook = resolve; });
  const entered = new Promise(resolve => { hookEntered = resolve; });
  let receipt;
  let scheduler;
  scheduler = startOutsideReaderScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    run: async () => ({
      outcome: 'no-findings', source: sourceReceipt(), provider: 'isolated-reviewer', findings: [],
    }),
    onPersist: async value => {
      receipt = value;
      assert.equal(store.inspect(value.id).receipts[0].outcome, 'no-findings');
      assert.equal(store.inspect(value.id).reader.running, false, 'the durable claim is already finished');
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
    id: created.id, runKind: 'manual', outcome: 'no-findings', runSucceeded: true, saved: true, error: null,
  });
  releaseHook();
  assert.equal((await work).receipt.outcome, 'no-findings');
  assert.equal(scheduler.running, false);
});

test('outside-reader persistence distinguishes runner and save failure, and hook failure never refinishes', async t => {
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file: await storeFile(t), clock: time.clock });
  const invalid = await store.create({ definition: definition({ name: 'Invalid runner review' }) });
  const runnerReceipts = [];
  const invalidRunner = startOutsideReaderScheduler({
    store,
    everyMs: 60 * 60 * 1000,
    run: async () => ({ outcome: 'no-findings', source: sourceReceipt(), provider: null }),
    onPersist: value => runnerReceipts.push(value),
  });
  t.after(() => invalidRunner.stop());
  assert.equal((await invalidRunner.now(invalid.id)).receipt.outcome, 'failed');
  assert.deepEqual(runnerReceipts[0], {
    id: invalid.id, runKind: 'manual', outcome: 'failed', runSucceeded: false, saved: true, error: null,
  });

  const file = await storeFile(t, 'save-failure.json');
  const saveStore = await createOutsideReaderStore({ file, clock: time.clock });
  const unsavable = await saveStore.create({ definition: definition({ name: 'Save failure review' }) });
  let releaseRun;
  let runEntered;
  const gate = new Promise(resolve => { releaseRun = resolve; });
  const entered = new Promise(resolve => { runEntered = resolve; });
  const saveReceipts = [];
  let runs = 0;
  const saveFailure = startOutsideReaderScheduler({
    store: saveStore,
    everyMs: 60 * 60 * 1000,
    run: async () => {
      runs += 1;
      runEntered();
      await gate;
      return { outcome: 'no-findings', source: sourceReceipt(), provider: 'isolated-reviewer', findings: [] };
    },
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
  assert.equal(saveReceipts[0].outcome, 'no-findings');
  assert.equal(saveReceipts[0].runSucceeded, true);
  assert.equal(saveReceipts[0].saved, false);
  assert.ok(saveReceipts[0].error instanceof Error);

  const hookStore = await createOutsideReaderStore({ file: await storeFile(t, 'hook-failure.json'), clock: time.clock });
  const hookReader = await hookStore.create({ definition: definition({ name: 'Hook failure review' }) });
  let hookRuns = 0;
  let effectRuns = 0;
  const errors = [];
  const hookFailure = startOutsideReaderScheduler({
    store: hookStore,
    everyMs: 60 * 60 * 1000,
    run: async () => { effectRuns += 1; return { outcome: 'failed', note: 'Synthetic result.' }; },
    onPersist: () => { hookRuns += 1; throw new Error('synthetic hook failure'); },
    onError: error => errors.push(error.message),
  });
  t.after(() => hookFailure.stop());
  assert.equal((await hookFailure.now(hookReader.id)).receipt.outcome, 'failed');
  assert.equal(effectRuns, 1);
  assert.equal(hookRuns, 1);
  assert.deepEqual(errors, ['synthetic hook failure']);
  assert.equal(hookStore.inspect(hookReader.id).receipts.length, 1);
  assert.throws(() => startOutsideReaderScheduler({ store: hookStore, run: async () => ({}), onPersist: true }), /onPersist must be a function/);
});

test('definitions reject expanding, unsorted, duplicate, unknown, oversized, and accessor-backed input', async t => {
  const store = await createOutsideReaderStore({ file: await storeFile(t) });
  await store.create({ definition: definition() });
  await assert.rejects(store.create({ definition: definition({ name: 'outside PROMISE review' }) }), error => error.status === 409);
  assert.throws(() => store.create({ definition: { ...definition({ name: 'Unknown field' }), surprise: true } }), /unknown field/);
  assert.throws(() => store.create({
    definition: definition({ name: 'Expanding source', source: { type: 'goal-register', recordIds: [GOAL_ONE] } }),
  }), /type must be goal-record-set/);
  assert.throws(() => store.create({
    definition: definition({ name: 'Unsorted source', source: { type: 'goal-record-set', recordIds: [PROMISE_ONE, GOAL_ONE] } }),
  }), /must be sorted/);
  assert.throws(() => store.create({
    definition: definition({ name: 'Repeated source', source: { type: 'goal-record-set', recordIds: [GOAL_ONE, GOAL_ONE] } }),
  }), /must be unique/);
  assert.throws(() => store.create({
    definition: definition({ name: 'Unknown source field', source: { type: 'goal-record-set', recordIds: [GOAL_ONE], all: true } }),
  }), /unknown field/);
  assert.throws(() => store.create({
    definition: definition({ name: 'Bad record id', source: { type: 'goal-record-set', recordIds: ['goal-not-exact'] } }),
  }), /exact goal or promise id/);
  assert.throws(() => store.create({ definition: definition({ name: 'Bad cadence', cadenceHours: 5 }) }), /must be one of/);
  assert.throws(() => store.create({ definition: definition({ name: 'Large focus', focus: 'x'.repeat(4001) }) }), /at most 4000/);
  assert.throws(() => store.create({
    definition: definition({
      name: 'Too many exact records',
      source: {
        type: 'goal-record-set',
        recordIds: Array.from({ length: 25 }, (_, index) => `goal-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
      },
    }),
  }), /1 to 24/);

  let getterRead = false;
  const hostile = definition({ name: 'Accessor definition' });
  Object.defineProperty(hostile, 'focus', {
    enumerable: true,
    get() { getterRead = true; return 'do not execute this getter'; },
  });
  assert.throws(() => store.create({ definition: hostile }), /data property/);
  assert.equal(getterRead, false);
});

test('write-heavy receipts prune oldest history before the file can outgrow its loader', async t => {
  const file = await storeFile(t, 'receipt-pressure.json');
  const time = handClock('2030-01-02T12:00:00.000Z');
  const store = await createOutsideReaderStore({ file, clock: time.clock });
  const created = await store.create({ definition: definition({ name: 'Receipt pressure reader' }) });
  const fingerprints = [];

  for (let index = 1; index <= 28; index += 1) {
    time.addMinutes(1);
    const fingerprint = index.toString(16).padStart(64, '0');
    fingerprints.push(fingerprint);
    const claim = await store.claimNow(created.id);
    await store.finish({
      id: created.id,
      claimToken: claim.claim.token,
      outcome: 'findings',
      source: sourceReceipt({ fingerprint, observedAt: time.clock().toISOString() }),
      provider: 'synthetic-pressure-reviewer',
      findings: heavyFindings(index),
    });
  }

  const source = await fs.readFile(file, 'utf8');
  assert.ok(Buffer.byteLength(source) <= OUTSIDE_READER_LIMITS.fileBytes);
  const inspection = store.inspect(created.id);
  assert.ok(inspection.receipts.length < fingerprints.length, 'retention was pruned before exceeding the byte ceiling');
  assert.equal(inspection.receipts[0].source.fingerprint, fingerprints.at(-1), 'the newest receipt remains');
  assert.equal(inspection.receipts.some(receipt => receipt.source.fingerprint === fingerprints[0]), false, 'the oldest receipt yields first');
  assert.equal(inspection.versions.length, 1, 'receipt pressure does not spend definition history');

  const reloaded = await createOutsideReaderStore({ file, clock: time.clock });
  assert.deepEqual(reloaded.inspect(created.id), inspection);
});

test('version pressure prunes only oldest noncurrent versions and every current definition survives reload', async t => {
  const file = await storeFile(t, 'version-pressure.json');
  const time = handClock('2030-01-02T12:00:00.000Z');
  const base = await createOutsideReaderStore({ file, clock: time.clock });
  for (let index = 0; index < OUTSIDE_READER_LIMITS.active; index += 1) {
    await base.create({ definition: definition({ name: `Version pressure reader ${index + 1}`, focus: 'Seed focus.' }) });
  }
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const expanded = focusCharacters => {
    const candidate = structuredClone(saved);
    candidate.readers.forEach((row, rowIndex) => {
      row.revision = OUTSIDE_READER_LIMITS.versions;
      row.focus = rowIndex === 0 ? 'Seed focus.' : 'x'.repeat(focusCharacters);
      row.versions = Array.from({ length: OUTSIDE_READER_LIMITS.versions }, (_, versionIndex) => {
        const revision = OUTSIDE_READER_LIMITS.versions - versionIndex;
        return {
          revision,
          at: row.updatedAt,
          by: revision === 1 ? 'person' : 'agent',
          action: revision === 1 ? 'created' : 'updated',
          value: {
            name: row.name,
            focus: row.focus,
            cadenceHours: row.cadenceHours,
            source: structuredClone(row.source),
            status: row.status,
          },
        };
      });
    });
    return candidate;
  };
  const bytes = value => Buffer.byteLength(`${JSON.stringify(value)}\n`);
  let low = 1;
  let high = OUTSIDE_READER_LIMITS.focusCharacters;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = expanded(middle);
    if (bytes(candidate) <= OUTSIDE_READER_LIMITS.fileBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  assert.ok(best, 'a valid near-ceiling fixture was built');
  assert.ok(bytes(best) <= OUTSIDE_READER_LIMITS.fileBytes);
  assert.ok(bytes(expanded(high + 1)) > OUTSIDE_READER_LIMITS.fileBytes, 'the fixture sits on the durable byte edge');
  await fs.writeFile(file, `${JSON.stringify(best)}\n`);

  const loaded = await createOutsideReaderStore({ file, clock: time.clock });
  const target = loaded.view().readers.find(reader => reader.name === 'Version pressure reader 1');
  const updated = await loaded.update({
    id: target.id,
    expectedRevision: target.revision,
    changes: { focus: 'z'.repeat(OUTSIDE_READER_LIMITS.focusCharacters) },
    actor: 'agent',
  });
  assert.equal(updated.focus.length, OUTSIDE_READER_LIMITS.focusCharacters);

  const durable = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(bytes(durable) <= OUTSIDE_READER_LIMITS.fileBytes);
  assert.ok(durable.readers.some(row => row.versions.length < OUTSIDE_READER_LIMITS.versions), 'old noncurrent versions yielded');
  assert.ok(durable.readers.every(row => row.versions.length >= 1), 'every current version remains');
  assert.ok(durable.readers.every(row => row.versions[0].revision === row.revision));

  const reloaded = await createOutsideReaderStore({ file, clock: time.clock });
  for (const reader of reloaded.view().readers) {
    const current = reloaded.inspect(reader.id).versions[0];
    assert.equal(current.revision, reader.revision);
    assert.deepEqual(current.value, {
      name: reader.name,
      focus: reader.focus,
      cadenceHours: reader.cadenceHours,
      source: reader.source,
      status: reader.status,
    });
  }
  assert.equal(reloaded.inspect(target.id).reader.focus.length, OUTSIDE_READER_LIMITS.focusCharacters);
});

test('malformed, duplicate-key, and noncanonical saved state is refused rather than reset', async t => {
  const malformed = await storeFile(t, 'malformed.json');
  await fs.mkdir(path.dirname(malformed), { recursive: true });
  await fs.writeFile(malformed, '{"format":"fieldwork-outside-readers/v1", nope}');
  await assert.rejects(createOutsideReaderStore({ file: malformed }), /could not read the saved file/);

  const repeated = await storeFile(t, 'repeated.json');
  await fs.mkdir(path.dirname(repeated), { recursive: true });
  await fs.writeFile(repeated, '{"format":"fieldwork-outside-readers/v1","format":"fieldwork-outside-readers/v1","revision":0,"readers":[],"receipts":[],"claims":[]}');
  await assert.rejects(createOutsideReaderStore({ file: repeated }), /could not read the saved file/);

  const file = await storeFile(t, 'tampered.json');
  const store = await createOutsideReaderStore({ file });
  await store.create({ definition: definition({ name: 'Tamper target' }) });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.readers[0].source.recordIds.reverse();
  saved.readers[0].versions[0].value.source.recordIds.reverse();
  await fs.writeFile(file, `${JSON.stringify(saved)}\n`);
  await assert.rejects(createOutsideReaderStore({ file }), /recordIds must be sorted/);
});
