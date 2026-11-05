import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheckInStore, inQuietHours, localMoment, startCheckInScheduler } from '../src/check-ins.mjs';

const claimChildFile = fileURLToPath(new URL('./support/check-in-claim-child.mjs', import.meta.url));

async function storeFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-checkins-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'state', 'check-ins.json');
}

// A clock the test moves by hand, in UTC.
function handClock(iso) {
  let now = new Date(iso);
  return {
    clock: () => now,
    set: next => { now = new Date(next); },
    add: hours => { now = new Date(now.getTime() + hours * 3_600_000); },
    addMinutes: minutes => { now = new Date(now.getTime() + minutes * 60_000); },
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
      if (message?.type === 'error') return fail(`check-in claim child failed: ${message.stack ?? message.message}`);
      if (message?.type !== expected) return fail(`check-in claim child sent ${JSON.stringify(message)} while waiting for ${expected}`);
      cleanup();
      resolve(message);
    };
    const onError = error => fail(`check-in claim child error: ${error.message}`);
    const onExit = (code, signal) => fail(`check-in claim child exited before ${expected} (code ${code}, signal ${signal})`);
    const timer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      fail(`check-in claim child timed out before ${expected}`);
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
      reject(new Error(`check-in claim child did not exit${run.stderr() ? `\n${run.stderr()}` : ''}`));
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
      reject(new Error(`check-in claim child did not accept the barrier${run.stderr() ? `\n${run.stderr()}` : ''}`));
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

test('check-ins are off until the person turns them on, and the first waits a full interval', async t => {
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file: await storeFile(t), clock: time.clock });
  assert.equal(store.view().settings.enabled, false);
  assert.equal(store.view().settings.destination, 'room');
  assert.equal(store.due({ timeZone: 'UTC' }), null);
  await store.update({ enabled: true, everyHours: 2 });
  assert.equal(store.due({ timeZone: 'UTC' }), null, 'not immediately after turning on');
  time.add(2);
  assert.equal(store.due({ timeZone: 'UTC' }), 'check-in');
  assert.equal(store.due({ timeZone: 'UTC', lastPersonAt: new Date(time.clock() - 5 * 60_000).toISOString() }), null, 'someone who just wrote is still here');
  await store.record({ kind: 'check-in', outcome: 'quiet', timeZone: 'UTC' });
  assert.equal(store.due({ timeZone: 'UTC' }), null, 'any outcome restarts the wait');
  assert.equal(store.view().history[0].outcome, 'quiet');
});

test('quiet hours wrap past midnight and follow the room time zone', async t => {
  assert.equal(inQuietHours(23 * 60 + 30, { enabled: true, from: '23:00', to: '08:00' }), true);
  assert.equal(inQuietHours(7 * 60, { enabled: true, from: '23:00', to: '08:00' }), true);
  assert.equal(inQuietHours(12 * 60, { enabled: true, from: '23:00', to: '08:00' }), false);
  assert.equal(inQuietHours(2 * 60, { enabled: false, from: '23:00', to: '08:00' }), false);
  assert.deepEqual(localMoment(new Date('2030-01-02T03:30:00Z'), 'America/New_York'), { day: '2030-01-01', minutes: 22 * 60 + 30 });

  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file: await storeFile(t), clock: time.clock });
  await store.update({ enabled: true, everyHours: 1, quiet: { enabled: true, from: '23:00', to: '08:00' } });
  time.set('2030-01-03T02:00:00Z');
  assert.equal(store.due({ timeZone: 'UTC' }), null, '2 a.m. is quiet');
  assert.equal(store.due({ timeZone: 'America/Los_Angeles' }), 'check-in', 'but it is 6 p.m. in Los Angeles');
  await assert.rejects(store.update({ everyHours: 5 }), /one of every/);
  await assert.rejects(store.update({ destination: 'everywhere' }), /room, telegram, or discord/);
  await assert.rejects(store.update({ quiet: { from: '25:00' } }), /a time like 08:00/);
  await assert.rejects(store.update({ surprise: true }), /unknown setting/);
});

test('the daily postcard comes once a day after its time, and settings survive a reload', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T17:00:00Z');
  const store = await createCheckInStore({ file, clock: time.clock });
  await store.update({ enabled: true, everyHours: 24, destination: 'telegram', postcard: { enabled: true, at: '18:00' } });
  assert.equal(store.due({ timeZone: 'UTC' }), null);
  time.set('2030-01-02T18:05:00Z');
  assert.equal(store.due({ timeZone: 'UTC' }), 'postcard');
  await store.record({ kind: 'postcard', outcome: 'sent', timeZone: 'UTC' });
  assert.equal(store.due({ timeZone: 'UTC' }), null, 'one postcard a day');
  time.set('2030-01-03T18:01:00Z');
  const reloaded = await createCheckInStore({ file, clock: time.clock });
  assert.equal(reloaded.view().settings.postcard.at, '18:00');
  assert.equal(reloaded.view().settings.destination, 'telegram');
  assert.equal(reloaded.due({ timeZone: 'UTC' }), 'postcard', 'the next day it is due again');
});

test('scheduled claims persist before work, survive reload, and require their exact token to finish', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file, clock: time.clock });
  await store.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);

  const claimed = await store.claimDue({ timeZone: 'UTC' });
  assert.equal(claimed.started, true);
  assert.equal(claimed.kind, 'check-in');
  assert.match(claimed.claim.token, /^[0-9a-f-]{36}$/);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.claim.token, claimed.claim.token, 'the claim reaches disk before a runner can begin');
  assert.equal(saved.claim.kind, 'check-in');
  assert.equal(saved.claim.runKind, 'scheduled');

  const reloaded = await createCheckInStore({ file, clock: time.clock });
  assert.deepEqual(await reloaded.claimDue({ timeZone: 'UTC' }), { started: false, reason: 'claimed' });
  assert.deepEqual(await reloaded.claimNow('postcard', { timeZone: 'UTC' }), { started: false, reason: 'claimed' }, 'manual wakes share the durable fence');
  await assert.rejects(reloaded.finish({
    claimToken: '00000000-0000-4000-8000-000000000000',
    outcome: 'quiet',
  }), error => error.status === 409);
  const finished = await reloaded.finish({
    claimToken: claimed.claim.token,
    outcome: 'sent',
    conversationId: 'conv-claimed',
  });
  assert.equal(finished.receipt.conversationId, 'conv-claimed');
  await assert.rejects(reloaded.finish({ claimToken: claimed.claim.token, outcome: 'quiet' }), error => error.status === 409);
  assert.equal(reloaded.due({ timeZone: 'UTC' }), null);
  assert.equal(reloaded.view().history[0].claimedAt, claimed.claim.claimedAt);
  assert.equal(reloaded.view().history[0].runKind, 'scheduled');
});

test('manual check-ins and postcards use the durable lane while free time remains separate', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file, clock: time.clock });
  const manual = await store.claimNow('postcard', { timeZone: 'UTC' });
  assert.equal(manual.started, true);
  assert.equal(manual.claim.runKind, 'manual');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).claim.runKind, 'manual');

  let runs = 0;
  const scheduler = startCheckInScheduler({
    store,
    timeZone: 'UTC',
    everyMs: 60 * 60 * 1000,
    run: async () => { runs += 1; return { outcome: 'quiet' }; },
  });
  t.after(() => scheduler.stop());
  assert.deepEqual(await scheduler.now('check-in'), { started: false, reason: 'claimed' });
  assert.equal(runs, 0);
  await store.finish({ claimToken: manual.claim.token, outcome: 'quiet' });

  const finished = await scheduler.now('check-in');
  assert.equal(finished.started, true);
  assert.equal(finished.outcome, 'quiet');
  assert.equal(runs, 1);
  assert.equal(store.view().history[0].runKind, 'manual');
});

test('scheduler shutdown waits for its active check-in without letting a busy caller replace that run', async t => {
  const file = await storeFile(t);
  const store = await createCheckInStore({ file });
  let release;
  let entered;
  const startedRun = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const scheduler = startCheckInScheduler({
    store,
    timeZone: 'UTC',
    everyMs: 60 * 60 * 1000,
    async run() {
      entered();
      await gate;
      return { outcome: 'quiet' };
    },
  });
  t.after(() => scheduler.stop());

  const active = scheduler.now('check-in');
  await startedRun;
  const busy = await scheduler.now('postcard');
  assert.deepEqual(busy, { started: false, reason: 'busy' });
  scheduler.stop();
  let waited = false;
  const waiting = scheduler.wait().then(() => { waited = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waited, false, 'shutdown still owns the original active run');
  release();
  assert.equal((await active).outcome, 'quiet');
  await waiting;
  assert.equal(waited, true);
});

test('an expired scheduled check-in leaves a receipt and defers instead of repeating the same wake', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file, clock: time.clock, claimMinutes: 15 });
  await store.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);
  const abandoned = await store.claimDue({ timeZone: 'UTC' });
  time.addMinutes(16);

  assert.deepEqual(await store.claimDue({ timeZone: 'UTC' }), { started: false, reason: 'not due' });
  assert.equal(store.view().history[0].outcome, 'claim-expired');
  assert.equal(store.view().history[0].kind, 'check-in');
  assert.equal(store.view().lastAt, time.clock().toISOString(), 'expiry starts a new cadence instead of replaying');
  await assert.rejects(store.finish({ claimToken: abandoned.claim.token, outcome: 'failed' }), error => error.status === 409);

  const reloaded = await createCheckInStore({ file, clock: time.clock });
  assert.equal(reloaded.view().history[0].outcome, 'claim-expired');
  time.add(1);
  assert.equal((await reloaded.claimDue({ timeZone: 'UTC' })).started, true, 'a later cadence remains eligible');
});

test('a room restart reaps an already-expired check-in claim without reclaiming its scheduled edge', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00Z');
  const first = await createCheckInStore({ file, clock: time.clock, claimMinutes: 15 });
  await first.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);
  const abandoned = await first.claimDue({ timeZone: 'UTC' });
  assert.equal(abandoned.started, true);
  time.addMinutes(16);

  const restarted = await createCheckInStore({ file, clock: time.clock, claimMinutes: 15 });
  assert.deepEqual(await restarted.claimDue({ timeZone: 'UTC' }), { started: false, reason: 'not due' });
  assert.equal(restarted.view().history[0].outcome, 'claim-expired');
  assert.equal(restarted.view().history[0].claimedAt, abandoned.claim.claimedAt);
  assert.equal(restarted.view().lastAt, '2030-01-02T13:16:00.000Z');

  time.add(1);
  const next = await restarted.claimDue({ timeZone: 'UTC' });
  assert.equal(next.started, true);
  assert.notEqual(next.claim.token, abandoned.claim.token);
});

test('an expired postcard consumes only its claimed local day', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T17:00:00Z');
  const store = await createCheckInStore({ file, clock: time.clock, claimMinutes: 15 });
  await store.update({ enabled: true, everyHours: 24, postcard: { enabled: true, at: '18:00' } });
  time.set('2030-01-02T18:05:00Z');
  const abandoned = await store.claimDue({ timeZone: 'UTC' });
  assert.equal(abandoned.kind, 'postcard');
  assert.equal(abandoned.claim.postcardDay, '2030-01-02');
  time.addMinutes(16);

  assert.deepEqual(await store.claimDue({ timeZone: 'UTC' }), { started: false, reason: 'not due' });
  assert.equal(store.view().history[0].outcome, 'claim-expired');
  assert.equal(store.view().history[0].kind, 'postcard');
  time.set('2030-01-03T18:01:00Z');
  const nextDay = await store.claimDue({ timeZone: 'UTC' });
  assert.equal(nextDay.started, true);
  assert.equal(nextDay.kind, 'postcard');
  assert.equal(nextDay.claim.postcardDay, '2030-01-03');
});

test('two schedulers sharing a store cannot run the same scheduled wake', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file, clock: time.clock });
  await store.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);
  let release;
  let entered;
  const runnerEntered = new Promise(resolve => { entered = resolve; });
  let runs = 0;
  const run = () => {
    runs += 1;
    entered();
    return new Promise(resolve => { release = resolve; });
  };
  const firstScheduler = startCheckInScheduler({ store, timeZone: 'UTC', everyMs: 60 * 60 * 1000, run });
  const secondScheduler = startCheckInScheduler({ store, timeZone: 'UTC', everyMs: 60 * 60 * 1000, run });
  t.after(() => { firstScheduler.stop(); secondScheduler.stop(); });

  const first = firstScheduler.tick();
  const second = secondScheduler.tick();
  await runnerEntered;
  assert.equal(runs, 1);
  assert.ok(JSON.parse(await fs.readFile(file, 'utf8')).claim, 'the winning runner has a durable claim');
  release({ outcome: 'quiet' });
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(result => result.started).length, 1);
  assert.deepEqual(results.find(result => !result.started), { started: false, reason: 'claimed' });
  assert.equal(store.view().history.filter(row => row.outcome === 'quiet').length, 1);
});

test('independently opened stores choose one claim and preserve it through unrelated writes', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00Z');
  const [first, second] = await Promise.all([
    createCheckInStore({ file, clock: time.clock }),
    createCheckInStore({ file, clock: time.clock }),
  ]);
  await first.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);

  const claimed = await Promise.all([
    first.claimDue({ timeZone: 'UTC' }),
    second.claimDue({ timeZone: 'UTC' }),
  ]);
  const winnerIndex = claimed.findIndex(result => result.started);
  assert.notEqual(winnerIndex, -1);
  assert.equal(claimed.filter(result => result.started).length, 1);
  assert.deepEqual(claimed.find(result => !result.started), { started: false, reason: 'claimed' });
  const token = claimed[winnerIndex].claim.token;
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).claim.token, token);

  const other = winnerIndex === 0 ? second : first;
  await other.update({ destination: 'telegram' });
  const afterUpdate = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(afterUpdate.settings.destination, 'telegram');
  assert.equal(afterUpdate.claim.token, token, 'a stale instance reloads before an unrelated whole-file write');

  await other.finish({ claimToken: token, outcome: 'quiet' });
  const winner = winnerIndex === 0 ? first : second;
  assert.deepEqual(await winner.reapExpiredClaim(), { reaped: false }, 'a later operation refreshes the winning instance too');
  assert.equal(winner.view().claim, null);
  assert.equal(winner.view().settings.destination, 'telegram');
  assert.equal(winner.view().history.filter(row => row.outcome === 'quiet').length, 1);
  await assert.rejects(fs.access(`${file}.lock`), { code: 'ENOENT' });
});

test('independent processes choose one durable scheduled claim after a shared barrier', async t => {
  const file = await storeFile(t);
  const initialAt = '2030-01-02T12:00:00.000Z';
  const dueAt = '2030-01-02T13:00:00.000Z';
  const prepared = await createCheckInStore({ file, clock: () => new Date(initialAt) });
  await prepared.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });

  const runs = [launchClaimChild(t, file, dueAt), launchClaimChild(t, file, dueAt)];
  await Promise.all(runs.map(run => nextChildMessage(run, 'ready')));
  const resultsReady = runs.map(run => nextChildMessage(run, 'result'));
  await Promise.all(runs.map(run => sendChild(run, { type: 'claim' })));
  const messages = await Promise.all(resultsReady);
  const results = messages.map(message => message.result);
  const exits = await Promise.all(runs.map(run => childExit(run)));

  assert.deepEqual(exits, [{ code: 0, signal: null }, { code: 0, signal: null }]);
  assert.equal(results.filter(result => result.started).length, 1);
  assert.deepEqual(results.find(result => !result.started), { started: false, reason: 'claimed' });
  const winner = results.find(result => result.started);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.claim.token, winner.claim.token);
  await assert.rejects(fs.access(`${file}.lock`), { code: 'ENOENT' });
});

test('independent expiry maintenance records one uncertain edge', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00Z');
  const [first, second] = await Promise.all([
    createCheckInStore({ file, clock: time.clock, claimMinutes: 15 }),
    createCheckInStore({ file, clock: time.clock, claimMinutes: 15 }),
  ]);
  await first.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);
  const abandoned = await first.claimDue({ timeZone: 'UTC' });
  assert.equal(abandoned.started, true);
  time.addMinutes(16);

  const reaped = await Promise.all([first.reapExpiredClaim(), second.reapExpiredClaim()]);
  assert.equal(reaped.filter(result => result.reaped).length, 1);
  assert.equal(reaped.filter(result => !result.reaped).length, 1);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.claim, null);
  assert.equal(saved.history.filter(row => row.outcome === 'claim-expired').length, 1);
  assert.equal(saved.history[0].claimedAt, abandoned.claim.claimedAt);
  assert.equal(first.view().history.filter(row => row.outcome === 'claim-expired').length, 1);
  assert.equal(second.view().history.filter(row => row.outcome === 'claim-expired').length, 1);
});

test('the scheduler runs one check-in at a time, records failures, and can check in on request', async t => {
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file: await storeFile(t), clock: time.clock });
  await store.update({ enabled: true, everyHours: 1 });
  time.add(1);
  const runs = [];
  let release;
  let entered;
  const runnerEntered = new Promise(resolve => { entered = resolve; });
  const scheduler = startCheckInScheduler({
    store, timeZone: 'UTC', everyMs: 60 * 60 * 1000,
    run: kind => { runs.push(kind); entered(); return new Promise(resolve => { release = resolve; }); },
  });
  t.after(() => scheduler.stop());
  const first = scheduler.tick();
  await runnerEntered;
  assert.deepEqual(await scheduler.tick(), { started: false, reason: 'busy' }, 'never two at once');
  release({ outcome: 'sent', conversationId: 'conv-1' });
  assert.equal((await first).outcome, 'sent');
  assert.deepEqual(runs, ['check-in']);
  assert.equal(store.view().history[0].conversationId, 'conv-1');

  const failing = startCheckInScheduler({ store, timeZone: 'UTC', everyMs: 60 * 60 * 1000, run: async () => { throw new Error('model offline'); } });
  t.after(() => failing.stop());
  const result = await failing.now('postcard');
  assert.equal(result.outcome, 'failed');
  assert.equal(store.view().history[0].kind, 'postcard');

  time.add(1);
  const invalid = startCheckInScheduler({ store, timeZone: 'UTC', everyMs: 60 * 60 * 1000, run: async () => ({ outcome: 'mystery' }) });
  t.after(() => invalid.stop());
  const invalidResult = await invalid.tick();
  assert.equal(invalidResult.outcome, 'failed');
  assert.equal(store.view().history[0].outcome, 'failed');
  assert.match(store.view().history[0].note, /invalid outcome/);
  assert.equal(store.due({ timeZone: 'UTC' }), null, 'an invalid runner settles instead of stranding its claim');
});

test('automatic suppression happens before a claim while manual wakes still run', async t => {
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file: await storeFile(t), clock: time.clock });
  await store.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);
  const runs = [];
  const scheduler = startCheckInScheduler({
    store,
    timeZone: 'UTC',
    everyMs: 60 * 60 * 1000,
    canSchedule: () => false,
    run: async (kind, options) => {
      runs.push([kind, options.runKind]);
      return { outcome: 'quiet', ...(kind === 'free-time' ? { record: false } : {}) };
    },
  });
  t.after(() => scheduler.stop());

  assert.deepEqual(await scheduler.tick(), { started: false, reason: 'suppressed' });
  assert.equal(store.view().claim, null);
  assert.equal(store.view().history.length, 0);
  assert.equal(store.due({ timeZone: 'UTC' }), 'check-in', 'suppression does not consume the cadence edge');
  for (const kind of ['check-in', 'postcard', 'free-time']) {
    const manual = await scheduler.now(kind);
    assert.equal(manual.started, true, `${kind} bypasses automatic suppression when requested manually`);
  }
  assert.deepEqual(runs, [
    ['check-in', 'manual'],
    ['postcard', 'manual'],
    ['free-time', 'manual'],
  ]);
  assert.deepEqual(store.view().history.map(row => [row.kind, row.runKind]), [
    ['postcard', 'manual'],
    ['check-in', 'manual'],
  ], 'quiet free time bypasses suppression without manufacturing history');
});

test('automatic suppression reaps an expired crash claim without claiming a new wake', async t => {
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file: await storeFile(t), clock: time.clock, claimMinutes: 15 });
  await store.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);
  const abandoned = await store.claimDue({ timeZone: 'UTC' });
  assert.equal(abandoned.started, true);
  time.addMinutes(16);
  let runs = 0;
  const scheduler = startCheckInScheduler({
    store,
    timeZone: 'UTC',
    everyMs: 60 * 60 * 1000,
    canSchedule: () => false,
    run: async () => { runs += 1; return { outcome: 'quiet' }; },
  });
  t.after(() => scheduler.stop());

  assert.deepEqual(await scheduler.tick(), { started: false, reason: 'suppressed' });
  assert.equal(runs, 0);
  assert.equal(store.view().claim, null);
  assert.equal(store.view().history[0].outcome, 'claim-expired');
  assert.equal(store.view().history[0].claimedAt, abandoned.claim.claimedAt);
  assert.equal(store.due({ timeZone: 'UTC' }), null, 'expiry defers the uncertain edge instead of claiming a replacement');
});

test('quiet free time leaves no history and does not move the regular schedule', async t => {
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file: await storeFile(t), clock: time.clock });
  await store.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(1);
  assert.equal(store.due({ timeZone: 'UTC' }), 'check-in');
  const scheduler = startCheckInScheduler({
    store, timeZone: 'UTC', everyMs: 60 * 60 * 1000,
    run: async kind => ({ outcome: 'quiet', record: kind !== 'free-time' }),
  });
  t.after(() => scheduler.stop());
  const result = await scheduler.now('free-time');
  assert.equal(result.outcome, 'quiet');
  assert.equal(store.view().history.length, 0);
  assert.equal(store.due({ timeZone: 'UTC' }), 'check-in', 'manual free time does not delay a scheduled check-in');

  await store.record({ kind: 'free-time', outcome: 'sent', conversationId: 'conv-free', timeZone: 'UTC' });
  assert.equal(store.view().history[0].kind, 'free-time');
  assert.equal(store.due({ timeZone: 'UTC' }), 'check-in');
  await assert.rejects(store.record({ kind: 'surprise', outcome: 'sent' }), /kind must be/);
});

test('overlapping settings and history writes are serialized and survive reload', async t => {
  const file = await storeFile(t);
  const time = handClock('2030-01-02T12:00:00Z');
  const store = await createCheckInStore({ file, clock: time.clock });
  await Promise.all([
    store.update({ enabled: true, everyHours: 2 }),
    store.record({ kind: 'check-in', outcome: 'sent', conversationId: 'conv-one', timeZone: 'UTC' }),
  ]);
  const reloaded = await createCheckInStore({ file, clock: time.clock });
  assert.equal(reloaded.view().settings.enabled, true);
  assert.equal(reloaded.view().settings.everyHours, 2);
  assert.equal(reloaded.view().history[0].conversationId, 'conv-one');
});

test('the agent can set its own quiet hours and breaks, and check-ins wait for them', async t => {
  const time = handClock('2030-01-02T12:00:00Z');
  const { restTools } = await import('../src/check-ins.mjs');
  const { createToolRegistry, executeTool, prepareToolCall } = await import('../src/tools.mjs');
  const store = await createCheckInStore({ file: await storeFile(t), clock: time.clock });
  store.useTimeZone('UTC');
  await store.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  time.add(2);
  assert.equal(store.due({ timeZone: 'UTC' }), 'check-in');

  const tools = createToolRegistry(restTools(store));
  assert.equal(
    prepareToolCall(tools, 'set_my_quiet_hours', { from: '11:00', to: '15:00' }).permissionSummary,
    'Set daily quiet hours from 11:00 to 15:00.',
  );
  await executeTool(tools, 'set_my_quiet_hours', { from: '11:00', to: '15:00' });
  assert.equal(store.due({ timeZone: 'UTC' }), null, 'its own quiet hours come first');
  assert.equal(store.view().resting.why, 'quiet hours');
  await executeTool(tools, 'set_my_quiet_hours', { from: '', to: '' });
  assert.equal(store.due({ timeZone: 'UTC' }), 'check-in');

  await executeTool(tools, 'take_a_break', { hours: 3 });
  assert.equal(store.due({ timeZone: 'UTC' }), null);
  assert.equal(store.view().resting.until, '2030-01-02T17:00:00.000Z');
  // The person saving their settings never touches the agent's rest.
  await store.update({ everyHours: 2 });
  assert.equal(store.view().own.breakUntil, '2030-01-02T17:00:00.000Z');
  time.add(4);
  assert.equal(store.view().resting, null, 'the break ends by itself');
  assert.equal(store.due({ timeZone: 'UTC' }), 'check-in');
  await assert.rejects(executeTool(tools, 'take_a_break', { hours: 100 }), /72/);
  assert.equal(store.view().history.length, 0, 'nothing was recorded about the resting');
});
