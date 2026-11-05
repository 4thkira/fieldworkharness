import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDurableLog } from '../src/durable-log.mjs';
import {
  createToolEffectStore,
  isToolEffectStore,
  openToolEffectStore,
  TOOL_EFFECT_ACTION_FORMAT,
  TOOL_EFFECT_ATTEMPT_FORMAT,
  TOOL_EFFECT_DISPOSITION_FORMAT,
  TOOL_EFFECT_EVENT_FORMAT,
  TOOL_EFFECT_LIMITS,
  TOOL_EFFECT_POLICY,
  TOOL_EFFECT_REPORT_FORMAT,
  TOOL_EFFECT_RESOLUTION_FORMAT,
} from '../src/tool-effects.mjs';

const at = '2030-01-02T03:04:05.000Z';
const before = '2029-01-02T03:04:05.000Z';
const clock = () => Date.parse(at);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const always = Object.freeze({ mode: 'always', reason: 'policy-always' });
const oneTime = Object.freeze({
  mode: 'ask', reason: 'one-time-grant', requestId: '00000000-0000-4000-8000-000000000001',
});

function effect(run, label, overrides = {}) {
  return {
    run,
    tool: 'write_file',
    argumentsSha256: sha256(`synthetic arguments ${label}`),
    summary: `Write synthetic item ${label}.`,
    permission: always,
    callIdHash: sha256(`synthetic call ${label}`),
    ...overrides,
  };
}

function fenceOf(input) {
  return { tool: input.tool, argumentsSha256: input.argumentsSha256 };
}

async function temporaryDirectory(t, prefix = 'fieldwork-tool-effects-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, options = {}) {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'effects.jsonl');
  const store = await createToolEffectStore(file, {
    id: options.id ?? 'synthetic-effects',
    clock: options.clock ?? clock,
    sync: options.sync ?? true,
  });
  const runs = new Set();
  const attempts = new Set();
  const beginRun = async input => {
    const capability = await store.beginRun(input);
    runs.add(capability);
    return capability;
  };
  const beginAttempt = async input => {
    const result = await store.beginAttempt(input);
    attempts.add(result.capability);
    return result;
  };
  const reportOutcome = async input => {
    try { return await store.reportOutcome(input); }
    finally { attempts.delete(input.capability); }
  };
  const recordRunDisposition = async input => {
    const result = await store.recordRunDisposition(input);
    runs.delete(input.run);
    return result;
  };
  t.after(async () => {
    for (const capability of attempts) {
      try { await store.reportOutcome({ capability, outcome: 'interrupted' }); } catch { /* Cleanup only. */ }
    }
    for (const run of runs) {
      try { await store.recordRunDisposition({ run, disposition: 'run-failed' }); } catch { /* Cleanup only. */ }
    }
    try { await store.close(); } catch { /* A test may already close or poison it. */ }
  });
  return {
    directory, file, store, runs, attempts,
    beginRun, beginAttempt, reportOutcome, recordRunDisposition,
  };
}

function genesisData() {
  return {
    actionFormat: TOOL_EFFECT_ACTION_FORMAT,
    attemptFormat: TOOL_EFFECT_ATTEMPT_FORMAT,
    reportFormat: TOOL_EFFECT_REPORT_FORMAT,
    resolutionFormat: TOOL_EFFECT_RESOLUTION_FORMAT,
    dispositionFormat: TOOL_EFFECT_DISPOSITION_FORMAT,
    policy: TOOL_EFFECT_POLICY,
  };
}

async function rawLog(t, name, id = name, sync = true) {
  const directory = await temporaryDirectory(t, `fieldwork-tool-effects-${name}-`);
  const file = path.join(directory, 'effects.jsonl');
  const log = await openDurableLog(file, {
    create: true,
    format: TOOL_EFFECT_EVENT_FORMAT,
    idField: 'toolEffectStoreId',
    id,
    initial: { type: 'tool_effect_store_created', data: genesisData() },
    clock,
    sync,
  });
  t.after(async () => { try { await log.close(); } catch { /* Cleanup only. */ } });
  return { file, log, id };
}

async function unknownAfterSync(file, operation) {
  const probe = await fs.open(`${file}.probe-${randomUUID()}`, 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  prototype.sync = async function syntheticPostSyncFailure() {
    await originalSync.call(this);
    throw new Error('synthetic failure after sync');
  };
  try {
    await operation();
  } catch (error) {
    return error;
  } finally {
    prototype.sync = originalSync;
  }
  assert.fail('operation unexpectedly committed without the synthetic sync failure');
}

function rawAction(label, overrides = {}) {
  return {
    format: TOOL_EFFECT_ACTION_FORMAT,
    id: `effect:${label}`,
    preparedAt: at,
    tool: 'write_file',
    argumentsSha256: sha256(`raw arguments ${label}`),
    summary: `Write raw item ${label}.`,
    origin: 'local-chat',
    permission: { ...always, requestId: null },
    runId: `run-${label}`,
    callIdHash: sha256(`raw call ${label}`),
    revision: '10000000-0000-4000-8000-000000000001',
    ...overrides,
  };
}

function rawAttempt(action, overrides = {}) {
  return {
    format: TOOL_EFFECT_ATTEMPT_FORMAT,
    actionId: action.id,
    previousRevision: action.revision,
    revision: '20000000-0000-4000-8000-000000000002',
    attemptedAt: at,
    ...overrides,
  };
}

test('tool plus full argument digest is the invariant fence and safe views expose no argument oracle', async t => {
  const fx = await fixture(t);
  assert.equal(isToolEffectStore(fx.store), true);
  assert.equal(isToolEffectStore({}), false);
  const run = await fx.beginRun({ runId: 'run-primary', origin: 'local-chat' });
  const secret = '{"path":"C:\\\\synthetic\\\\orchard.txt","token":"never-store-me"}';
  const secretHash = sha256(secret);
  const input = effect(run, 'primary', {
    argumentsSha256: secretHash,
    summary: 'Write one synthetic orchard file.',
    permission: oneTime,
    // Even a hostile caller-provided call hash must not become a public
    // argument oracle. It remains trusted durable correlation metadata only.
    callIdHash: secretHash,
  });
  const prepared = await fx.store.prepare(input);
  assert.equal(prepared.state, 'prepared-not-attempted');
  assert.equal(prepared.runActive, true);
  assert.equal(prepared.recoverable, false);
  assert.equal(Object.hasOwn(prepared, 'argumentsSha256'), false);
  assert.equal(Object.hasOwn(prepared, 'argumentsFingerprint'), false);
  assert.equal(Object.hasOwn(prepared, 'fingerprint'), false);
  assert.equal(Object.hasOwn(prepared, 'callIdHash'), false);
  assert.equal(JSON.stringify(prepared).includes(input.argumentsSha256), false);
  assert.equal(JSON.stringify(prepared).includes(input.argumentsSha256.slice(0, 12)), false);
  assert.match(prepared.revision, /^[0-9a-f-]{36}$/u);
  assert.equal((await fx.store.fence(fenceOf(input))).actionId, prepared.actionId);

  const changedRun = await fx.beginRun({ runId: 'run-changed-display', origin: 'task-heartbeat' });
  await assert.rejects(fx.store.prepare(effect(changedRun, 'changed-display', {
    argumentsSha256: input.argumentsSha256,
    summary: 'A completely different safe display summary.',
  })), /same unresolved tool and argument digest/);
  await fx.recordRunDisposition({ run: changedRun, disposition: 'run-failed' });

  const attempt = await fx.beginAttempt({
    run, actionId: prepared.actionId, expectedRevision: prepared.revision,
  });
  assert.equal(Reflect.ownKeys(attempt.capability).length, 0);
  const returned = await fx.reportOutcome({ capability: attempt.capability, outcome: 'executor-returned' });
  assert.equal(returned.state, 'executor-returned-uncommitted');
  assert.equal((await fx.store.fence(fenceOf(input))).actionId, prepared.actionId);
  await assert.rejects(fx.store.resolve({
    actionId: returned.actionId,
    expectedRevision: returned.revision,
    resolution: 'acknowledge-completed',
  }), /containing run is active/);

  const disposition = await fx.recordRunDisposition({
    run, disposition: 'committed', conversationId: 'conv-00000000-0000-4000-8000-000000000001',
  });
  assert.equal(disposition.completed, 1);
  assert.equal(await fx.store.fence(fenceOf(input)), null);
  const terminal = (await fx.store.history())[0];
  assert.equal(terminal.outcome, 'executor-returned');
  assert.equal(terminal.runDisposition.status, 'committed');
  assert.equal(terminal.finishedAt, terminal.runDisposition.recordedAt);
  assert.equal(Object.hasOwn(terminal, 'callIdHash'), false);
  assert.equal(JSON.stringify(terminal).includes(input.argumentsSha256), false);

  const persisted = await fs.readFile(fx.file, 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('never-store-me'), false);
  assert.equal(persisted.includes(input.argumentsSha256), true);
  const receipt = await fx.store.receipt();
  await fx.store.close();
  const reopened = await openToolEffectStore(fx.file, {
    expectedId: 'synthetic-effects', expectedHead: receipt.head, clock,
  });
  t.after(async () => { try { await reopened.close(); } catch { /* Cleanup only. */ } });
  assert.equal((await reopened.history())[0].runDisposition.status, 'committed');
});

test('a run with no tracked effects releases authority without growing the durable ledger', async t => {
  const fx = await fixture(t, { id: 'empty-run' });
  const before = await fs.readFile(fx.file, 'utf8');
  const run = await fx.beginRun({ runId: 'run-empty', origin: 'local-chat' });
  const result = await fx.recordRunDisposition({ run, disposition: 'committed' });
  assert.equal(result.affected, 0);
  assert.equal(result.completed, 0);
  assert.equal((await fx.store.unresolved()).total, 0);
  assert.deepEqual(await fx.store.history(), []);
  assert.equal(await fs.readFile(fx.file, 'utf8'), before);
  await assert.rejects(
    fx.recordRunDisposition({ run, disposition: 'committed' }),
    /active run capability/,
  );
});

test('noncommitted executor returns remain fenced until a person acknowledges completion', async t => {
  const fx = await fixture(t);
  for (const disposition of ['discarded', 'save-failed', 'run-failed']) {
    const run = await fx.beginRun({ runId: `run-${disposition}`, origin: 'local-chat' });
    const input = effect(run, disposition);
    const prepared = await fx.store.prepare(input);
    const attempt = await fx.beginAttempt({ run, actionId: prepared.actionId, expectedRevision: prepared.revision });
    await fx.reportOutcome({ capability: attempt.capability, outcome: 'executor-returned' });
    await fx.recordRunDisposition({
      run,
      disposition,
      ...(disposition === 'save-failed' ? { conversationId: `conv-${disposition}` } : {}),
    });
    const unresolved = (await fx.store.inspect(prepared.actionId)).unresolved;
    assert.equal(unresolved.state, 'executor-returned-uncommitted');
    assert.equal(unresolved.runDisposition.status, disposition);
    assert.equal(unresolved.recoverable, true);
    assert.equal((await fx.store.fence(fenceOf(input))).actionId, prepared.actionId);
    await assert.rejects(fx.store.resolve({
      actionId: unresolved.actionId,
      expectedRevision: unresolved.revision,
      resolution: 'acknowledge-uncertain',
    }), /not valid for executor-returned-uncommitted/);
    const resolved = await fx.store.resolve({
      actionId: unresolved.actionId,
      expectedRevision: unresolved.revision,
      resolution: 'acknowledge-completed',
    });
    assert.equal(resolved.outcome, 'acknowledge-completed');
    assert.equal(resolved.actor, 'person');
  }
});

test('opaque run and attempt capabilities prevent forged reports and block resolution for the whole live run', async t => {
  const fx = await fixture(t);
  const run = await fx.beginRun({ runId: 'run-capabilities', origin: 'local-chat' });
  assert.equal(Reflect.ownKeys(run).length, 0);
  await assert.rejects(fx.store.prepare(effect({}, 'forged-run')), /active run capability/);
  const prepared = await fx.store.prepare(effect(run, 'capabilities'));
  const attempted = await fx.beginAttempt({ run, actionId: prepared.actionId, expectedRevision: prepared.revision });
  await assert.rejects(fx.store.reportOutcome({ capability: {}, outcome: 'executor-error' }), /active executor capability/);
  await assert.rejects(fx.store.reportOutcome({ capability: { ...attempted.capability }, outcome: 'executor-error' }), /active executor capability/);
  const errored = await fx.reportOutcome({ capability: attempted.capability, outcome: 'executor-error' });
  assert.equal(errored.state, 'executor-error-uncertain');
  await assert.rejects(fx.store.resolve({
    actionId: errored.actionId,
    expectedRevision: errored.revision,
    resolution: 'acknowledge-uncertain',
  }), /containing run is active/);
  await fx.recordRunDisposition({ run, disposition: 'run-failed' });
  const recoverable = (await fx.store.inspect(errored.actionId)).unresolved;
  assert.equal(recoverable.runActive, false);
  assert.equal(recoverable.recoverable, true);
  assert.notEqual(recoverable.revision, errored.revision);
  await assert.rejects(fx.store.resolve({
    actionId: recoverable.actionId,
    expectedRevision: errored.revision,
    resolution: 'acknowledge-uncertain',
  }), /changed after inspection/);
  const contenders = await Promise.allSettled([
    fx.store.resolve({
      actionId: recoverable.actionId,
      expectedRevision: recoverable.revision,
      resolution: 'acknowledge-uncertain',
    }),
    fx.store.resolve({
      actionId: recoverable.actionId,
      expectedRevision: recoverable.revision,
      resolution: 'acknowledge-uncertain',
    }),
  ]);
  assert.equal(contenders.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(contenders.filter(row => row.status === 'rejected').length, 1);
  assert.equal(contenders.find(row => row.status === 'fulfilled').value.outcome, 'acknowledge-uncertain');
});

test('graceful close retains the writer lock for a late executor report and run disposition', async t => {
  const fx = await fixture(t, { id: 'draining-effects' });
  const run = await fx.beginRun({ runId: 'run-late', origin: 'local-chat' });
  const prepared = await fx.store.prepare(effect(run, 'late'));
  const attempted = await fx.beginAttempt({ run, actionId: prepared.actionId, expectedRevision: prepared.revision });
  let closed = false;
  const closing = fx.store.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(fx.store.prepare(effect(run, 'too-late')), /close has begun/);
  const returned = await fx.reportOutcome({ capability: attempted.capability, outcome: 'executor-returned' });
  assert.equal(returned.state, 'executor-returned-uncommitted');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  const disposition = await fx.recordRunDisposition({
    run, disposition: 'committed', conversationId: 'conv-late',
  });
  assert.equal(disposition.completed, 1);
  await closing;
  assert.equal(await fs.stat(`${fx.file}.lock`).catch(error => error.code), 'ENOENT');

  const reopened = await openToolEffectStore(fx.file, { expectedId: 'draining-effects', clock });
  t.after(async () => { try { await reopened.close(); } catch { /* Cleanup only. */ } });
  assert.equal((await reopened.unresolved()).total, 0);
  assert.equal((await reopened.history())[0].runDisposition.status, 'committed');
});

test('force close abandons only live capabilities and preserves the durable orphan for recovery', async t => {
  const fx = await fixture(t, { id: 'force-close-effects' });
  const run = await fx.beginRun({ runId: 'run-force-close', origin: 'local-chat' });
  const prepared = await fx.store.prepare(effect(run, 'force-close'));
  const attempted = await fx.beginAttempt({
    run,
    actionId: prepared.actionId,
    expectedRevision: prepared.revision,
  });

  let closed = false;
  const graceful = fx.store.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  await fx.store.forceClose();
  await graceful;
  assert.equal(closed, true);
  await assert.rejects(fx.store.reportOutcome({
    capability: attempted.capability,
    outcome: 'executor-returned',
  }), /close has begun/);

  const reopened = await openToolEffectStore(fx.file, {
    expectedId: 'force-close-effects',
    clock,
  });
  t.after(async () => { try { await reopened.close(); } catch { /* Cleanup only. */ } });
  const orphan = (await reopened.inspect(prepared.actionId)).unresolved;
  assert.equal(orphan.state, 'attempted-unsettled');
  assert.equal(orphan.executorActive, false);
  assert.equal(orphan.runActive, false);
  assert.equal(orphan.recoverable, true);
  await reopened.resolve({
    actionId: orphan.actionId,
    expectedRevision: orphan.revision,
    resolution: 'acknowledge-uncertain',
  });
});

test('semantic timestamps are monotonic live and on replay', async t => {
  let calls = 0;
  const rollingClock = () => {
    calls++;
    return Date.parse(calls === 4 ? before : at);
  };
  const fx = await fixture(t, { id: 'clock-effects', clock: rollingClock });
  const run = await fx.beginRun({ runId: 'run-clock', origin: 'local-chat' });
  const prepared = await fx.store.prepare(effect(run, 'clock'));
  await assert.rejects(fx.store.beginAttempt({
    run, actionId: prepared.actionId, expectedRevision: prepared.revision,
  }), /precedes the state it follows/);
  assert.equal((await fx.store.receipt()).events, 2);
  await fx.recordRunDisposition({ run, disposition: 'run-failed' });
  const current = (await fx.store.inspect(prepared.actionId)).unresolved;
  await fx.store.resolve({
    actionId: current.actionId,
    expectedRevision: current.revision,
    resolution: 'abandon-not-attempted',
  });

  const reversedAttempt = await rawLog(t, 'reverse-attempt');
  const attemptAction = rawAction('reverse-attempt');
  await reversedAttempt.log.append('tool_effect_prepared', { action: attemptAction });
  await reversedAttempt.log.append('tool_effect_attempted', {
    attempt: rawAttempt(attemptAction, { attemptedAt: before }),
  });
  await reversedAttempt.log.close();
  await assert.rejects(openToolEffectStore(reversedAttempt.file, {
    expectedId: reversedAttempt.id, clock,
  }), /precedes the state it follows/);

  const reversedReport = await rawLog(t, 'reverse-report');
  const reportAction = rawAction('reverse-report', { preparedAt: before });
  const reportAttempt = rawAttempt(reportAction, { attemptedAt: at });
  await reversedReport.log.append('tool_effect_prepared', { action: reportAction });
  await reversedReport.log.append('tool_effect_attempted', { attempt: reportAttempt });
  await reversedReport.log.append('tool_effect_reported', {
    report: {
      format: TOOL_EFFECT_REPORT_FORMAT,
      actionId: reportAction.id,
      previousRevision: reportAttempt.revision,
      revision: '30000000-0000-4000-8000-000000000003',
      reportedAt: before,
      outcome: 'executor-error',
    },
  });
  await reversedReport.log.close();
  await assert.rejects(openToolEffectStore(reversedReport.file, {
    expectedId: reversedReport.id, clock,
  }), /precedes the state it follows/);

  const reversedResolution = await rawLog(t, 'reverse-resolution');
  const resolutionAction = rawAction('reverse-resolution');
  await reversedResolution.log.append('tool_effect_prepared', { action: resolutionAction });
  await reversedResolution.log.append('tool_effect_resolved', {
    resolution: {
      format: TOOL_EFFECT_RESOLUTION_FORMAT,
      actionId: resolutionAction.id,
      expectedRevision: resolutionAction.revision,
      resolvedAt: before,
      resolution: 'abandon-not-attempted',
      actor: 'person',
    },
  });
  await reversedResolution.log.close();
  await assert.rejects(openToolEffectStore(reversedResolution.file, {
    expectedId: reversedResolution.id, clock,
  }), /precedes the state it follows/);

  const reversedDisposition = await rawLog(t, 'reverse-disposition');
  const dispositionAction = rawAction('reverse-disposition');
  await reversedDisposition.log.append('tool_effect_prepared', { action: dispositionAction });
  await reversedDisposition.log.append('tool_effect_run_dispositioned', {
    disposition: {
      format: TOOL_EFFECT_DISPOSITION_FORMAT,
      runId: dispositionAction.runId,
      origin: dispositionAction.origin,
      disposition: 'run-failed',
      conversationId: null,
      recordedAt: before,
      revisions: [{
        actionId: dispositionAction.id,
        previousRevision: dispositionAction.revision,
        revision: '40000000-0000-4000-8000-000000000004',
      }],
    },
  });
  await reversedDisposition.log.close();
  await assert.rejects(openToolEffectStore(reversedDisposition.file, {
    expectedId: reversedDisposition.id, clock,
  }), /precedes the state it follows/);

  const resolutionBeforeDisposition = await rawLog(t, 'resolution-before-disposition');
  const disposedAction = rawAction('resolution-before-disposition', { preparedAt: before });
  const disposedRevision = '50000000-0000-4000-8000-000000000005';
  await resolutionBeforeDisposition.log.append('tool_effect_prepared', { action: disposedAction });
  await resolutionBeforeDisposition.log.append('tool_effect_run_dispositioned', {
    disposition: {
      format: TOOL_EFFECT_DISPOSITION_FORMAT,
      runId: disposedAction.runId,
      origin: disposedAction.origin,
      disposition: 'run-failed',
      conversationId: null,
      recordedAt: at,
      revisions: [{
        actionId: disposedAction.id,
        previousRevision: disposedAction.revision,
        revision: disposedRevision,
      }],
    },
  });
  await resolutionBeforeDisposition.log.append('tool_effect_resolved', {
    resolution: {
      format: TOOL_EFFECT_RESOLUTION_FORMAT,
      actionId: disposedAction.id,
      expectedRevision: disposedRevision,
      resolvedAt: before,
      resolution: 'abandon-not-attempted',
      actor: 'person',
    },
  });
  await resolutionBeforeDisposition.log.close();
  await assert.rejects(openToolEffectStore(resolutionBeforeDisposition.file, {
    expectedId: resolutionBeforeDisposition.id, clock,
  }), /precedes the state it follows/);
});

test('semantic replay rejects executor transitions after disposition and disposition after orphan resolution', async t => {
  const attemptedAfter = await rawLog(t, 'attempt-after-disposition');
  const attemptedAction = rawAction('attempt-after-disposition');
  const disposedRevision = '40000000-0000-4000-8000-000000000004';
  await attemptedAfter.log.append('tool_effect_prepared', { action: attemptedAction });
  await attemptedAfter.log.append('tool_effect_run_dispositioned', {
    disposition: {
      format: TOOL_EFFECT_DISPOSITION_FORMAT,
      runId: attemptedAction.runId,
      origin: attemptedAction.origin,
      disposition: 'run-failed',
      conversationId: null,
      recordedAt: at,
      revisions: [{
        actionId: attemptedAction.id,
        previousRevision: attemptedAction.revision,
        revision: disposedRevision,
      }],
    },
  });
  await attemptedAfter.log.append('tool_effect_attempted', {
    attempt: rawAttempt(attemptedAction, {
      previousRevision: disposedRevision,
      revision: '50000000-0000-4000-8000-000000000005',
    }),
  });
  await attemptedAfter.log.close();
  await assert.rejects(openToolEffectStore(attemptedAfter.file, {
    expectedId: attemptedAfter.id, clock,
  }), /cannot be attempted after its run disposition/);

  const reportedAfter = await rawLog(t, 'report-after-disposition');
  const reportedAction = rawAction('report-after-disposition');
  const reportedAttempt = rawAttempt(reportedAction);
  await reportedAfter.log.append('tool_effect_prepared', { action: reportedAction });
  await reportedAfter.log.append('tool_effect_attempted', { attempt: reportedAttempt });
  await reportedAfter.log.append('tool_effect_run_dispositioned', {
    disposition: {
      format: TOOL_EFFECT_DISPOSITION_FORMAT,
      runId: reportedAction.runId,
      origin: reportedAction.origin,
      disposition: 'run-failed',
      conversationId: null,
      recordedAt: at,
      revisions: [{
        actionId: reportedAction.id,
        previousRevision: reportedAttempt.revision,
        revision: disposedRevision,
      }],
    },
  });
  await reportedAfter.log.append('tool_effect_reported', {
    report: {
      format: TOOL_EFFECT_REPORT_FORMAT,
      actionId: reportedAction.id,
      previousRevision: disposedRevision,
      revision: '50000000-0000-4000-8000-000000000005',
      reportedAt: at,
      outcome: 'executor-error',
    },
  });
  await reportedAfter.log.close();
  await assert.rejects(openToolEffectStore(reportedAfter.file, {
    expectedId: reportedAfter.id, clock,
  }), /cannot be reported after its run disposition/);

  const dispositionAfterResolution = await rawLog(t, 'disposition-after-resolution');
  const resolvedAction = rawAction('disposition-after-resolution');
  await dispositionAfterResolution.log.append('tool_effect_prepared', { action: resolvedAction });
  await dispositionAfterResolution.log.append('tool_effect_resolved', {
    resolution: {
      format: TOOL_EFFECT_RESOLUTION_FORMAT,
      actionId: resolvedAction.id,
      expectedRevision: resolvedAction.revision,
      resolvedAt: at,
      resolution: 'abandon-not-attempted',
      actor: 'person',
    },
  });
  await dispositionAfterResolution.log.append('tool_effect_run_dispositioned', {
    disposition: {
      format: TOOL_EFFECT_DISPOSITION_FORMAT,
      runId: resolvedAction.runId,
      origin: resolvedAction.origin,
      disposition: 'run-failed',
      conversationId: null,
      recordedAt: at,
      revisions: [],
    },
  });
  await dispositionAfterResolution.log.close();
  await assert.rejects(openToolEffectStore(dispositionAfterResolution.file, {
    expectedId: dispositionAfterResolution.id, clock,
  }), /cannot gain a disposition after an orphan was resolved/);

  const mixedOrigin = await rawLog(t, 'mixed-run-origin');
  const firstOrigin = rawAction('mixed-origin-first', { runId: 'run-mixed-origin' });
  const secondOrigin = rawAction('mixed-origin-second', {
    runId: firstOrigin.runId,
    origin: 'task-heartbeat',
  });
  await mixedOrigin.log.append('tool_effect_prepared', { action: firstOrigin });
  await mixedOrigin.log.append('tool_effect_prepared', { action: secondOrigin });
  await mixedOrigin.log.close();
  await assert.rejects(openToolEffectStore(mixedOrigin.file, {
    expectedId: mixedOrigin.id, clock,
  }), /cannot mix origins/);

  const repeatedRevision = await rawLog(t, 'repeated-disposition-revision');
  const firstRevisionAction = rawAction('repeated-revision-first', {
    runId: 'run-repeated-revision',
  });
  const secondRevisionAction = rawAction('repeated-revision-second', {
    runId: firstRevisionAction.runId,
    revision: '11000000-0000-4000-8000-000000000011',
  });
  const replacementRevision = '60000000-0000-4000-8000-000000000006';
  await repeatedRevision.log.append('tool_effect_prepared', { action: firstRevisionAction });
  await repeatedRevision.log.append('tool_effect_prepared', { action: secondRevisionAction });
  await repeatedRevision.log.append('tool_effect_run_dispositioned', {
    disposition: {
      format: TOOL_EFFECT_DISPOSITION_FORMAT,
      runId: firstRevisionAction.runId,
      origin: firstRevisionAction.origin,
      disposition: 'run-failed',
      conversationId: null,
      recordedAt: at,
      revisions: [
        {
          actionId: firstRevisionAction.id,
          previousRevision: firstRevisionAction.revision,
          revision: replacementRevision,
        },
        {
          actionId: secondRevisionAction.id,
          previousRevision: secondRevisionAction.revision,
          revision: replacementRevision,
        },
      ],
    },
  });
  await repeatedRevision.log.close();
  await assert.rejects(openToolEffectStore(repeatedRevision.file, {
    expectedId: repeatedRevision.id,
    clock,
  }), /replacement revisions must be new and distinct/);
});

test('permanent action-id retention rejects reuse after bounded history eviction', async t => {
  const fx = await fixture(t, { id: 'seen-id-effects', sync: false });
  let oldestId;
  for (let index = 0; index < TOOL_EFFECT_LIMITS.history + 1; index++) {
    const run = await fx.beginRun({ runId: `run-history-${index}`, origin: 'local-chat' });
    const prepared = await fx.store.prepare(effect(run, `history-${index}`));
    oldestId ??= prepared.actionId;
    await fx.recordRunDisposition({ run, disposition: 'run-failed' });
    const current = (await fx.store.inspect(prepared.actionId)).unresolved;
    await fx.store.resolve({
      actionId: current.actionId,
      expectedRevision: current.revision,
      resolution: 'abandon-not-attempted',
    });
  }
  assert.deepEqual(await fx.store.inspect(oldestId), { unresolved: null, terminal: null });
  const receipt = await fx.store.receipt();
  await fx.store.close();
  const events = (await fs.readFile(fx.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const firstAction = events.find(event => event.type === 'tool_effect_prepared').data.action;
  const raw = await openDurableLog(fx.file, {
    format: TOOL_EFFECT_EVENT_FORMAT,
    idField: 'toolEffectStoreId',
    expectedId: 'seen-id-effects',
    expectedHead: receipt.head,
    clock,
    sync: false,
  });
  await raw.append('tool_effect_prepared', {
    action: {
      ...firstAction,
      runId: 'run-reused-id',
      callIdHash: sha256('reused call'),
      revision: randomUUID(),
    },
  });
  await raw.close();
  await assert.rejects(openToolEffectStore(fx.file, {
    expectedId: 'seen-id-effects', clock, sync: false,
  }), /is repeated/);
});

test('an orphan-closed run cannot resume or gain a late disposition after history eviction', async t => {
  const raw = await rawLog(t, 'closed-run-after-eviction', 'closed-run-after-eviction', false);
  const orphan = rawAction('old-orphan');
  await raw.log.append('tool_effect_prepared', { action: orphan });
  await raw.log.append('tool_effect_resolved', {
    resolution: {
      format: TOOL_EFFECT_RESOLUTION_FORMAT,
      actionId: orphan.id,
      expectedRevision: orphan.revision,
      resolvedAt: at,
      resolution: 'abandon-not-attempted',
      actor: 'person',
    },
  });
  for (let index = 0; index < TOOL_EFFECT_LIMITS.history + 1; index++) {
    const action = rawAction(`eviction-${index}`);
    const disposedRevision = randomUUID();
    await raw.log.append('tool_effect_prepared', { action });
    await raw.log.append('tool_effect_run_dispositioned', {
      disposition: {
        format: TOOL_EFFECT_DISPOSITION_FORMAT,
        runId: action.runId,
        origin: action.origin,
        disposition: 'run-failed',
        conversationId: null,
        recordedAt: at,
        revisions: [{
          actionId: action.id,
          previousRevision: action.revision,
          revision: disposedRevision,
        }],
      },
    });
    await raw.log.append('tool_effect_resolved', {
      resolution: {
        format: TOOL_EFFECT_RESOLUTION_FORMAT,
        actionId: action.id,
        expectedRevision: disposedRevision,
        resolvedAt: at,
        resolution: 'abandon-not-attempted',
        actor: 'person',
      },
    });
  }
  const prefixReceipt = await raw.log.receipt();
  await raw.log.close();
  const copiedFile = `${raw.file}.closed-run-copy`;
  await fs.copyFile(raw.file, copiedFile);

  const dispositionWriter = await openDurableLog(raw.file, {
    format: TOOL_EFFECT_EVENT_FORMAT,
    idField: 'toolEffectStoreId',
    expectedId: raw.id,
    expectedHead: prefixReceipt.head,
    clock,
    sync: false,
  });
  await dispositionWriter.append('tool_effect_run_dispositioned', {
    disposition: {
      format: TOOL_EFFECT_DISPOSITION_FORMAT,
      runId: orphan.runId,
      origin: orphan.origin,
      disposition: 'run-failed',
      conversationId: null,
      recordedAt: at,
      revisions: [],
    },
  });
  await dispositionWriter.close();
  await assert.rejects(openToolEffectStore(raw.file, {
    expectedId: raw.id, clock, sync: false,
  }), /cannot gain a disposition after an orphan was resolved/);

  const prepareWriter = await openDurableLog(copiedFile, {
    format: TOOL_EFFECT_EVENT_FORMAT,
    idField: 'toolEffectStoreId',
    expectedId: raw.id,
    expectedHead: prefixReceipt.head,
    clock,
    sync: false,
  });
  await prepareWriter.append('tool_effect_prepared', {
    action: rawAction('late-action-for-closed-run', { runId: orphan.runId }),
  });
  await prepareWriter.close();
  await assert.rejects(openToolEffectStore(copiedFile, {
    expectedId: raw.id, clock, sync: false,
  }), /cannot be prepared for a closed orphan run/);
});

test('unresolved capacity refuses without eviction and a disposition can revise the full bound', async t => {
  const fx = await fixture(t, { id: 'capacity-effects', sync: false });
  const run = await fx.beginRun({ runId: 'run-capacity', origin: 'local-chat' });
  let first;
  for (let index = 0; index < TOOL_EFFECT_LIMITS.unresolved; index++) {
    const row = await fx.store.prepare(effect(run, `capacity-${index}`));
    first ??= row;
  }
  await assert.rejects(fx.store.prepare(effect(run, 'over-capacity')), /unresolved effect limit/);
  assert.equal((await fx.store.unresolved({ limit: TOOL_EFFECT_LIMITS.unresolved })).total, TOOL_EFFECT_LIMITS.unresolved);
  const disposed = await fx.recordRunDisposition({ run, disposition: 'run-failed' });
  assert.equal(disposed.affected, TOOL_EFFECT_LIMITS.unresolved);
  const revisedFirst = (await fx.store.inspect(first.actionId)).unresolved;
  await fx.store.resolve({
    actionId: first.actionId,
    expectedRevision: revisedFirst.revision,
    resolution: 'abandon-not-attempted',
  });
  const replacementRun = await fx.beginRun({ runId: 'run-capacity-replacement', origin: 'local-chat' });
  await fx.store.prepare(effect(replacementRun, 'capacity-replacement'));
  await fx.recordRunDisposition({ run: replacementRun, disposition: 'run-failed' });
  assert.equal((await fx.store.unresolved({ limit: TOOL_EFFECT_LIMITS.unresolved })).total, TOOL_EFFECT_LIMITS.unresolved);
});

test('inputs are exact, accessor-safe, Unicode-bounded, and cannot smuggle raw data', async t => {
  const fx = await fixture(t);
  const run = await fx.beginRun({ runId: 'run-inputs', origin: 'local-chat' });
  let reads = 0;
  const accessor = effect(run, 'accessor');
  Object.defineProperty(accessor, 'tool', {
    enumerable: true,
    get() { reads++; return 'write_file'; },
  });
  assert.throws(() => fx.store.prepare(accessor), /enumerable data property/);
  assert.equal(reads, 0);
  assert.throws(() => fx.store.prepare({ ...effect(run, 'raw-arguments'), arguments: { token: 'secret' } }), /unknown field/);
  assert.throws(() => fx.store.prepare(effect(run, 'missing-request', {
    permission: { mode: 'ask', reason: 'one-time-grant' },
  })), /requestId is required/);
  for (const unsafe of ['\u0000', '\u202e', '\u2066']) {
    assert.throws(() => fx.store.prepare(effect(run, `unsafe-${unsafe.codePointAt(0)}`, {
      summary: `safe${unsafe}spoof`,
    })), /direction-safe text/);
  }
  const unicode = await fx.store.prepare(effect(run, 'unicode', {
    summary: '🌱'.repeat(TOOL_EFFECT_LIMITS.summaryCharacters),
  }));
  assert.equal([...unicode.summary].length, TOOL_EFFECT_LIMITS.summaryCharacters);
  assert.throws(() => fx.store.prepare(effect(run, 'too-long', {
    summary: '🌱'.repeat(TOOL_EFFECT_LIMITS.summaryCharacters + 1),
  })), /1-240 characters/);
  await assert.rejects(fx.store.prepare(effect(run, 'duplicate-call', {
    argumentsSha256: sha256('different arguments'),
    callIdHash: effect(run, 'unicode').callIdHash,
  })), /already prepared this call identity/);
  const attempt = await fx.beginAttempt({ run, actionId: unicode.actionId, expectedRevision: unicode.revision });
  assert.throws(() => fx.store.reportOutcome({
    capability: attempt.capability, outcome: 'executor-error', error: 'raw failure',
  }), /unknown field/);
  assert.throws(() => fx.store.reportOutcome({
    capability: attempt.capability, outcome: 'executor-returned', result: { raw: true },
  }), /unknown field/);
  await fx.reportOutcome({ capability: attempt.capability, outcome: 'executor-error' });
  await fx.recordRunDisposition({ run, disposition: 'run-failed' });
  const current = (await fx.store.inspect(unicode.actionId)).unresolved;
  await fx.store.resolve({
    actionId: current.actionId,
    expectedRevision: current.revision,
    resolution: 'acknowledge-uncertain',
  });

  const createOptions = {};
  Object.defineProperty(createOptions, 'clock', {
    enumerable: true,
    get() { reads++; return clock; },
  });
  await assert.rejects(createToolEffectStore(path.join(fx.directory, 'accessor-create.jsonl'), createOptions), /enumerable data property/);
  assert.equal(reads, 0);
});

test('the cooperative writer lock and semantic replay reject competing or malformed writers', async t => {
  const fx = await fixture(t, { id: 'locked-effects' });
  await assert.rejects(openToolEffectStore(fx.file, {
    expectedId: 'locked-effects', clock,
  }), /writer lock already exists/);
  const head = (await fx.store.receipt()).head;
  await fx.store.close();
  const reopened = await openToolEffectStore(fx.file, {
    expectedId: 'locked-effects', expectedHead: head, clock,
  });
  await reopened.close();

  const malformed = await rawLog(t, 'missing-action');
  await malformed.log.append('tool_effect_attempted', {
    attempt: {
      format: TOOL_EFFECT_ATTEMPT_FORMAT,
      actionId: 'effect:missing',
      previousRevision: '10000000-0000-4000-8000-000000000001',
      revision: '20000000-0000-4000-8000-000000000002',
      attemptedAt: at,
    },
  });
  await malformed.log.close();
  await assert.rejects(openToolEffectStore(malformed.file, {
    expectedId: malformed.id, clock,
  }), /missing action/);
});

test('unknown commits at every other transition poison live state and reconcile from the durable log', async t => {
  const preparedFx = await fixture(t, { id: 'unknown-prepare' });
  const prepareRun = await preparedFx.beginRun({ runId: 'run-unknown-prepare', origin: 'local-chat' });
  const prepareInput = effect(prepareRun, 'unknown-prepare');
  const prepareFailure = await unknownAfterSync(preparedFx.file, () => preparedFx.store.prepare(prepareInput));
  assert.equal(prepareFailure.commitStatus, 'unknown');
  await assert.rejects(preparedFx.store.close(), /outcome is unknown|synthetic failure/);
  const preparedReopened = await openToolEffectStore(preparedFx.file, { expectedId: 'unknown-prepare', clock });
  const preparedOrphan = (await preparedReopened.unresolved()).items[0];
  assert.equal(preparedOrphan.state, 'prepared-not-attempted');
  await preparedReopened.resolve({
    actionId: preparedOrphan.actionId,
    expectedRevision: preparedOrphan.revision,
    resolution: 'abandon-not-attempted',
  });
  await preparedReopened.close();

  const attemptedFx = await fixture(t, { id: 'unknown-attempt' });
  const attemptRun = await attemptedFx.beginRun({ runId: 'run-unknown-attempt', origin: 'local-chat' });
  const attemptPrepared = await attemptedFx.store.prepare(effect(attemptRun, 'unknown-attempt'));
  const attemptFailure = await unknownAfterSync(attemptedFx.file, () => attemptedFx.store.beginAttempt({
    run: attemptRun,
    actionId: attemptPrepared.actionId,
    expectedRevision: attemptPrepared.revision,
  }));
  assert.equal(attemptFailure.commitStatus, 'unknown');
  await assert.rejects(attemptedFx.store.close(), /outcome is unknown|synthetic failure/);
  const attemptedReopened = await openToolEffectStore(attemptedFx.file, { expectedId: 'unknown-attempt', clock });
  const attemptedOrphan = (await attemptedReopened.unresolved()).items[0];
  assert.equal(attemptedOrphan.state, 'attempted-unsettled');
  await attemptedReopened.resolve({
    actionId: attemptedOrphan.actionId,
    expectedRevision: attemptedOrphan.revision,
    resolution: 'acknowledge-uncertain',
  });
  await attemptedReopened.close();

  const dispositionFx = await fixture(t, { id: 'unknown-disposition' });
  const dispositionRun = await dispositionFx.beginRun({ runId: 'run-unknown-disposition', origin: 'local-chat' });
  const dispositionPrepared = await dispositionFx.store.prepare(effect(dispositionRun, 'unknown-disposition'));
  const dispositionAttempt = await dispositionFx.beginAttempt({
    run: dispositionRun,
    actionId: dispositionPrepared.actionId,
    expectedRevision: dispositionPrepared.revision,
  });
  await dispositionFx.reportOutcome({ capability: dispositionAttempt.capability, outcome: 'executor-returned' });
  const dispositionFailure = await unknownAfterSync(dispositionFx.file, () => dispositionFx.store.recordRunDisposition({
    run: dispositionRun,
    disposition: 'committed',
    conversationId: 'conv-unknown-disposition',
  }));
  assert.equal(dispositionFailure.commitStatus, 'unknown');
  await assert.rejects(dispositionFx.store.close(), /outcome is unknown|synthetic failure/);
  const dispositionReopened = await openToolEffectStore(dispositionFx.file, { expectedId: 'unknown-disposition', clock });
  assert.equal((await dispositionReopened.unresolved()).total, 0);
  assert.equal((await dispositionReopened.history())[0].runDisposition.status, 'committed');
  await dispositionReopened.close();

  const resolutionFx = await fixture(t, { id: 'unknown-resolution' });
  const resolutionRun = await resolutionFx.beginRun({ runId: 'run-unknown-resolution', origin: 'local-chat' });
  const resolutionPrepared = await resolutionFx.store.prepare(effect(resolutionRun, 'unknown-resolution'));
  await resolutionFx.recordRunDisposition({ run: resolutionRun, disposition: 'run-failed' });
  const resolutionCurrent = (await resolutionFx.store.inspect(resolutionPrepared.actionId)).unresolved;
  const resolutionFailure = await unknownAfterSync(resolutionFx.file, () => resolutionFx.store.resolve({
    actionId: resolutionCurrent.actionId,
    expectedRevision: resolutionCurrent.revision,
    resolution: 'abandon-not-attempted',
  }));
  assert.equal(resolutionFailure.commitStatus, 'unknown');
  await assert.rejects(resolutionFx.store.close(), /outcome is unknown|synthetic failure/);
  const resolutionReopened = await openToolEffectStore(resolutionFx.file, { expectedId: 'unknown-resolution', clock });
  assert.equal((await resolutionReopened.unresolved()).total, 0);
  assert.equal((await resolutionReopened.history())[0].outcome, 'abandon-not-attempted');
  await resolutionReopened.close();
});

test('an unknown returned-report commit reconciles as an orphan that only a person can resolve', async t => {
  const fx = await fixture(t, { id: 'unknown-commit-effects' });
  const run = await fx.beginRun({ runId: 'run-unknown', origin: 'local-chat' });
  const prepared = await fx.store.prepare(effect(run, 'unknown'));
  const attempted = await fx.beginAttempt({ run, actionId: prepared.actionId, expectedRevision: prepared.revision });
  const prior = await fx.store.receipt();
  const probe = await fs.open(`${fx.file}.probe`, 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  prototype.sync = async function syntheticPostSyncFailure() {
    await originalSync.call(this);
    throw new Error('synthetic failure after sync');
  };
  let failure;
  try {
    await fx.reportOutcome({ capability: attempted.capability, outcome: 'executor-returned' });
  } catch (error) {
    failure = error;
  } finally {
    prototype.sync = originalSync;
  }
  assert.equal(failure?.commitStatus, 'unknown');
  assert.equal(failure?.prior.head, prior.head);
  await assert.rejects(fx.store.receipt(), /outcome is unknown|synthetic failure/);
  await assert.rejects(fx.store.close(), /outcome is unknown|synthetic failure/);

  const reopened = await openToolEffectStore(fx.file, { expectedId: 'unknown-commit-effects', clock });
  t.after(async () => { try { await reopened.close(); } catch { /* Cleanup only. */ } });
  const orphan = (await reopened.inspect(prepared.actionId)).unresolved;
  assert.equal(orphan.state, 'executor-returned-uncommitted');
  assert.equal(orphan.runActive, false);
  assert.equal(orphan.recoverable, true);
  await assert.rejects(reopened.reportOutcome({ capability: {}, outcome: 'executor-returned' }), /active executor capability/);
  await assert.rejects(reopened.resolve({
    actionId: orphan.actionId,
    expectedRevision: orphan.revision,
    resolution: 'acknowledge-uncertain',
  }), /not valid for executor-returned-uncommitted/);
  const resolved = await reopened.resolve({
    actionId: orphan.actionId,
    expectedRevision: orphan.revision,
    resolution: 'acknowledge-completed',
  });
  assert.equal(resolved.outcome, 'acknowledge-completed');
});

test('definitely-not-written prepare, attempt, disposition, and resolution transitions remain safely retryable', async t => {
  const failingClock = target => {
    let calls = 0;
    return () => {
      calls++;
      if (calls === target) throw new Error(`synthetic prewrite clock failure ${target}`);
      return Date.parse(at);
    };
  };

  const prepareFx = await fixture(t, { id: 'not-written-prepare', clock: failingClock(3) });
  const prepareRun = await prepareFx.beginRun({ runId: 'run-not-written-prepare', origin: 'local-chat' });
  const prepareInput = effect(prepareRun, 'not-written-prepare');
  let prepareFailure;
  try { await prepareFx.store.prepare(prepareInput); } catch (error) { prepareFailure = error; }
  assert.equal(prepareFailure?.commitStatus, 'not-written');
  assert.equal(await prepareFx.store.fence(fenceOf(prepareInput)), null);
  const prepared = await prepareFx.store.prepare(prepareInput);
  await prepareFx.recordRunDisposition({ run: prepareRun, disposition: 'run-failed' });
  const prepareCurrent = (await prepareFx.store.inspect(prepared.actionId)).unresolved;
  await prepareFx.store.resolve({
    actionId: prepareCurrent.actionId,
    expectedRevision: prepareCurrent.revision,
    resolution: 'abandon-not-attempted',
  });

  const attemptFx = await fixture(t, { id: 'not-written-attempt', clock: failingClock(5) });
  const attemptRun = await attemptFx.beginRun({ runId: 'run-not-written-attempt', origin: 'local-chat' });
  const attemptPrepared = await attemptFx.store.prepare(effect(attemptRun, 'not-written-attempt'));
  let attemptFailure;
  try {
    await attemptFx.beginAttempt({
      run: attemptRun,
      actionId: attemptPrepared.actionId,
      expectedRevision: attemptPrepared.revision,
    });
  } catch (error) { attemptFailure = error; }
  assert.equal(attemptFailure?.commitStatus, 'not-written');
  assert.equal((await attemptFx.store.inspect(attemptPrepared.actionId)).unresolved.state, 'prepared-not-attempted');
  const retriedAttempt = await attemptFx.beginAttempt({
    run: attemptRun,
    actionId: attemptPrepared.actionId,
    expectedRevision: attemptPrepared.revision,
  });
  await attemptFx.reportOutcome({ capability: retriedAttempt.capability, outcome: 'interrupted' });
  await attemptFx.recordRunDisposition({ run: attemptRun, disposition: 'run-failed' });
  const attemptCurrent = (await attemptFx.store.inspect(attemptPrepared.actionId)).unresolved;
  await attemptFx.store.resolve({
    actionId: attemptCurrent.actionId,
    expectedRevision: attemptCurrent.revision,
    resolution: 'acknowledge-uncertain',
  });

  const dispositionFx = await fixture(t, { id: 'not-written-disposition', clock: failingClock(5) });
  const dispositionRun = await dispositionFx.beginRun({ runId: 'run-not-written-disposition', origin: 'local-chat' });
  const dispositionPrepared = await dispositionFx.store.prepare(effect(dispositionRun, 'not-written-disposition'));
  let dispositionFailure;
  try {
    await dispositionFx.recordRunDisposition({ run: dispositionRun, disposition: 'run-failed' });
  } catch (error) { dispositionFailure = error; }
  assert.equal(dispositionFailure?.commitStatus, 'not-written');
  const retriedDisposition = await dispositionFx.recordRunDisposition({
    run: dispositionRun, disposition: 'run-failed',
  });
  assert.equal(retriedDisposition.disposition.status, 'run-failed');
  const dispositionCurrent = (await dispositionFx.store.inspect(dispositionPrepared.actionId)).unresolved;
  await dispositionFx.store.resolve({
    actionId: dispositionCurrent.actionId,
    expectedRevision: dispositionCurrent.revision,
    resolution: 'abandon-not-attempted',
  });

  const resolutionFx = await fixture(t, { id: 'not-written-resolution', clock: failingClock(7) });
  const resolutionRun = await resolutionFx.beginRun({ runId: 'run-not-written-resolution', origin: 'local-chat' });
  const resolutionPrepared = await resolutionFx.store.prepare(effect(resolutionRun, 'not-written-resolution'));
  await resolutionFx.recordRunDisposition({ run: resolutionRun, disposition: 'run-failed' });
  const resolutionCurrent = (await resolutionFx.store.inspect(resolutionPrepared.actionId)).unresolved;
  let resolutionFailure;
  try {
    await resolutionFx.store.resolve({
      actionId: resolutionCurrent.actionId,
      expectedRevision: resolutionCurrent.revision,
      resolution: 'abandon-not-attempted',
    });
  } catch (error) { resolutionFailure = error; }
  assert.equal(resolutionFailure?.commitStatus, 'not-written');
  assert.equal((await resolutionFx.store.inspect(resolutionPrepared.actionId)).unresolved.actionId, resolutionPrepared.actionId);
  const retriedResolution = await resolutionFx.store.resolve({
    actionId: resolutionCurrent.actionId,
    expectedRevision: resolutionCurrent.revision,
    resolution: 'abandon-not-attempted',
  });
  assert.equal(retriedResolution.outcome, 'abandon-not-attempted');
});

test('a definitely-not-written report consumes only the executor capability and preserves uncertainty', async t => {
  let calls = 0;
  const failingClock = () => {
    calls++;
    if (calls === 7) throw new Error('synthetic outcome append clock failure');
    return Date.parse(at);
  };
  const fx = await fixture(t, { id: 'not-written-effects', clock: failingClock });
  const run = await fx.beginRun({ runId: 'run-not-written', origin: 'local-chat' });
  const prepared = await fx.store.prepare(effect(run, 'not-written'));
  const attempted = await fx.beginAttempt({ run, actionId: prepared.actionId, expectedRevision: prepared.revision });
  let failure;
  try {
    await fx.reportOutcome({ capability: attempted.capability, outcome: 'executor-returned' });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.commitStatus, 'not-written');
  await fx.recordRunDisposition({ run, disposition: 'run-failed' });
  const uncertain = (await fx.store.inspect(prepared.actionId)).unresolved;
  assert.equal(uncertain.state, 'attempted-unsettled');
  const resolved = await fx.store.resolve({
    actionId: uncertain.actionId,
    expectedRevision: uncertain.revision,
    resolution: 'acknowledge-uncertain',
  });
  assert.equal(resolved.outcome, 'acknowledge-uncertain');
});
