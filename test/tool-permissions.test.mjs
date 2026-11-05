import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createToolPermissionStore,
  isToolPermissionStore,
  TOOL_PERMISSION_FORMAT,
  TOOL_PERMISSION_LIMITS,
} from '../src/tool-permissions.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, name = 'tool-permissions.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-tool-permissions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, name) };
}

function clockFixture(start = '2030-04-05T06:07:08.000Z') {
  let milliseconds = new Date(start).getTime();
  return {
    clock: () => new Date(milliseconds),
    advance: amount => { milliseconds += amount; },
  };
}

test('tools default to always while explicit policies persist with attribution and revisions', async t => {
  const data = await fixture(t);
  const time = clockFixture();
  const store = await createToolPermissionStore({ file: data.file, clock: time.clock });
  assert.equal(isToolPermissionStore(store), true);
  assert.equal(isToolPermissionStore({}), false);
  assert.equal(store.mode('write_file'), 'always');
  assert.deepEqual(store.view(['write_file']).policies, [{
    tool: 'write_file', mode: 'always', explicit: false, revision: 0, updatedAt: null, actor: null,
  }]);
  assert.equal(store.view().boundary, 'same-room-single-writer');

  const changed = await store.setPolicy({ tool: 'write_file', mode: 'ask', expectedRevision: 0, actor: 'person' });
  assert.equal(changed.revision, 1);
  assert.deepEqual(changed.policies, [{
    tool: 'write_file', mode: 'ask', explicit: true, revision: 1,
    updatedAt: '2030-04-05T06:07:08.000Z', actor: 'person',
  }]);
  await assert.rejects(
    store.setPolicy({ tool: 'write_file', mode: 'never', expectedRevision: 0 }),
    error => error.status === 409 && /changed since/.test(error.message),
  );

  const reopened = await createToolPermissionStore({ file: data.file, clock: time.clock });
  assert.equal(reopened.mode('write_file'), 'ask');
  assert.equal(reopened.view(['write_file']).history[0].action, 'policy-set');
  assert.equal(JSON.parse(await fs.readFile(data.file, 'utf8')).format, TOOL_PERMISSION_FORMAT);
});

test('an explicit policy can return exactly to the implicit default', async t => {
  const data = await fixture(t);
  const time = clockFixture();
  const store = await createToolPermissionStore({ file: data.file, clock: time.clock });
  await store.setPolicy({ tool: 'write_file', mode: 'ask', expectedRevision: 0, actor: 'person' });
  const request = await store.authorize({
    tool: 'write_file', argumentsSha256: digest('one pending write'),
    summary: 'Write one synthetic file.', origin: 'local-chat', interactive: true,
  });
  await store.decide({
    requestId: request.requestId, expectedFingerprint: request.requestFingerprint,
    decision: 'once', actor: 'person',
  });
  await store.authorize({
    tool: 'write_file', argumentsSha256: digest('another pending write'),
    summary: 'Write another synthetic file.', origin: 'local-chat', interactive: true,
  });
  const before = store.view(['write_file']);
  assert.equal(before.pending.length, 1);
  assert.equal(before.grants.length, 1);

  await assert.rejects(
    store.clearPolicy({ tool: 'write_file', expectedRevision: before.revision - 1, actor: 'person' }),
    error => error.status === 409 && /changed since/.test(error.message),
  );
  time.advance(1);
  const cleared = await store.clearPolicy({
    tool: 'write_file', expectedRevision: before.revision, actor: 'person',
  });
  assert.deepEqual(cleared.policies, [{
    tool: 'write_file', mode: 'always', explicit: false,
    revision: 0, updatedAt: null, actor: null,
  }]);
  assert.equal(cleared.pending.length, 0);
  assert.equal(cleared.grants.length, 0);
  assert.equal(cleared.history.at(-1).action, 'policy-cleared');
  assert.equal(cleared.history.at(-1).value, 'ask');
  assert.ok(cleared.history.some(row => row.action === 'request-cancelled'));
  assert.ok(cleared.history.some(row => row.action === 'grant-cancelled'));

  const reopened = await createToolPermissionStore({ file: data.file, clock: time.clock });
  assert.equal(reopened.mode('write_file'), 'always');
  assert.equal(reopened.view(['write_file']).policies[0].explicit, false);
  const revision = reopened.view().revision;
  const noChange = await reopened.clearPolicy({
    tool: 'write_file', expectedRevision: revision, actor: 'person',
  });
  assert.equal(noChange.revision, revision, 'clearing an already implicit policy is a no-op');
  assert.equal(noChange.history.filter(row => row.action === 'policy-cleared').length, 1);
});

test('policy reset reaps an elapsed one-time grant in the same revision', async t => {
  const data = await fixture(t);
  const time = clockFixture();
  const store = await createToolPermissionStore({ file: data.file, clock: time.clock });
  await store.setPolicy({ tool: 'write_file', mode: 'ask', expectedRevision: 0 });
  const request = await store.authorize({
    tool: 'write_file', argumentsSha256: digest('expiring exact write'),
    summary: 'Write one expiring synthetic file.', origin: 'local-chat', interactive: true,
  });
  await store.decide({
    requestId: request.requestId, expectedFingerprint: request.requestFingerprint, decision: 'once',
  });
  const before = store.view(['write_file']);
  assert.equal(before.grants.length, 1);
  time.advance(TOOL_PERMISSION_LIMITS.grantLifetimeMs + 1);
  const cleared = await store.clearPolicy({
    tool: 'write_file', expectedRevision: before.revision, actor: 'person',
  });
  assert.equal(cleared.revision, before.revision + 1, 'expiry and reset commit as one atomic revision');
  assert.equal(cleared.policies[0].explicit, false);
  assert.equal(cleared.grants.length, 0);
  assert.ok(cleared.history.some(row => row.action === 'grant-expired' && row.requestId === request.requestId));
  assert.ok(cleared.history.some(row => row.action === 'policy-cleared'));
  assert.equal(cleared.history.some(row => row.action === 'grant-cancelled' && row.requestId === request.requestId), false);
});

test('interactive ask creates one safe exact request while autonomous ask refuses without one', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  await store.setPolicy({ tool: 'save_entry', mode: 'ask', expectedRevision: 0 });
  const argumentsSha256 = digest('synthetic secret argument');
  const first = await store.authorize({
    tool: 'save_entry', argumentsSha256, origin: 'local-chat', interactive: true,
    callId: 'call-1', step: 2, runId: 'run-1',
  });
  assert.deepEqual(Object.keys(first), ['allowed', 'mode', 'reason', 'requestId', 'requestFingerprint']);
  assert.equal(first.allowed, false);
  assert.equal(first.mode, 'ask');
  assert.equal(first.reason, 'approval-required');
  assert.match(first.requestId, /^[0-9a-f-]{36}$/u);
  assert.match(first.requestFingerprint, /^[0-9a-f]{64}$/u);
  const afterFirst = store.view(['save_entry']);
  assert.equal(afterFirst.pending.length, 1);
  assert.equal(afterFirst.revision, 2);
  assert.equal(Object.hasOwn(afterFirst.pending[0], 'argumentsSha256'), false);
  assert.doesNotMatch(JSON.stringify(afterFirst), new RegExp(argumentsSha256, 'u'));

  const repeated = await store.authorize({ tool: 'save_entry', argumentsSha256, origin: 'local-chat', interactive: true });
  assert.equal(repeated.requestId, first.requestId);
  assert.equal(store.view().revision, 2, 'reusing a pending request does not churn durable state');

  const autonomous = await store.authorize({
    tool: 'save_entry', argumentsSha256: digest('different arguments'), origin: 'task-heartbeat', interactive: false,
  });
  assert.deepEqual(autonomous, {
    allowed: false, mode: 'ask', reason: 'approval-unavailable', requestId: null, requestFingerprint: null,
  });
  assert.equal(store.view().pending.length, 1, 'an autonomous run cannot leave an actionable request behind');
  assert.equal(store.view().revision, 2);
});

test('a changed safe summary replaces its stale pending request atomically', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  await store.setPolicy({ tool: 'save_entry', mode: 'ask', expectedRevision: 0 });
  const argumentsSha256 = digest('same exact arguments');
  const first = await store.authorize({
    tool: 'save_entry', argumentsSha256, summary: 'Save the first displayed meaning.', origin: 'local-chat', interactive: true,
  });
  const changed = await store.authorize({
    tool: 'save_entry', argumentsSha256, summary: 'Save the corrected displayed meaning.', origin: 'local-chat', interactive: true,
  });
  assert.notEqual(changed.requestId, first.requestId);
  const view = store.view(['save_entry']);
  assert.equal(view.pending.length, 1);
  assert.equal(view.pending[0].id, changed.requestId);
  assert.equal(view.pending[0].summary, 'Save the corrected displayed meaning.');
  assert.ok(view.history.some(row => row.action === 'request-cancelled' && row.requestId === first.requestId));
  await assert.rejects(store.decide({
    requestId: first.requestId, expectedFingerprint: first.requestFingerprint, decision: 'once',
  }), error => error.status === 409 && /no longer pending/.test(error.message));

  await store.decide({
    requestId: changed.requestId, expectedFingerprint: changed.requestFingerprint, decision: 'once',
  });
  const changedAgain = await store.authorize({
    tool: 'save_entry', argumentsSha256, summary: 'Save the newest displayed meaning.', origin: 'local-chat', interactive: true,
  });
  const afterGrantDrift = store.view(['save_entry']);
  assert.equal(afterGrantDrift.grants.length, 0, 'a one-time grant with stale displayed meaning is cancelled');
  assert.equal(afterGrantDrift.pending[0].id, changedAgain.requestId);
  assert.ok(afterGrantDrift.history.some(row => row.action === 'grant-cancelled' && row.requestId === changed.requestId));
});

test('permission display text rejects directional controls and counts Unicode code points', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  await store.setPolicy({ tool: 'save_entry', mode: 'ask', expectedRevision: 0 });
  const argumentsSha256 = digest('unicode summary');
  const summary = '🌱'.repeat(240);
  await store.authorize({ tool: 'save_entry', argumentsSha256, summary, origin: 'local-chat', interactive: true });
  assert.equal([...store.view(['save_entry']).pending[0].summary].length, 240);
  for (const unsafe of ['\u0085', '\u061c', '\u200e', '\u2028', '\u202e', '\u2067', '\u206a']) {
    assert.throws(() => store.authorize({
      tool: 'save_entry', argumentsSha256, summary: `safe${unsafe}spoof`, origin: 'local-chat', interactive: true,
    }), /control-free text/);
  }
  assert.throws(() => store.authorize({
    tool: 'save_entry', argumentsSha256, summary: '🌱'.repeat(241), origin: 'local-chat', interactive: true,
  }), /1-240 characters/);
});

test('a once decision is stale-protected, origin-bound, exact, and consumed only once', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  await store.setPolicy({ tool: 'put_on_shelf', mode: 'ask', expectedRevision: 0 });
  const argumentsSha256 = digest('one exact shelf change');
  const request = await store.authorize({ tool: 'put_on_shelf', argumentsSha256, origin: 'local-chat', interactive: true });
  await assert.rejects(store.decide({
    requestId: request.requestId, expectedFingerprint: digest('stale'), decision: 'once',
  }), error => error.status === 409 && /changed since/.test(error.message));
  assert.equal(store.view().pending.length, 1);

  const decided = await store.decide({
    requestId: request.requestId, expectedFingerprint: request.requestFingerprint, decision: 'once', actor: 'person',
  });
  assert.equal(decided.pending.length, 0);
  assert.equal(decided.grants.length, 1);
  assert.equal(Object.hasOwn(decided.grants[0], 'argumentsSha256'), false);

  const wrongOrigin = await store.authorize({ tool: 'put_on_shelf', argumentsSha256, origin: 'task-heartbeat', interactive: false });
  assert.equal(wrongOrigin.reason, 'approval-unavailable');
  assert.equal(store.view().grants.length, 1, 'another origin cannot steal the local-chat approval');
  const wrongArguments = await store.authorize({
    tool: 'put_on_shelf', argumentsSha256: digest('different shelf change'), origin: 'local-chat', interactive: false,
  });
  assert.equal(wrongArguments.reason, 'approval-unavailable');
  assert.equal(store.view().grants.length, 1);

  const allowed = await store.authorize({ tool: 'put_on_shelf', argumentsSha256, origin: 'local-chat', interactive: true });
  assert.deepEqual(allowed, {
    allowed: true, mode: 'ask', reason: 'one-time-grant', requestId: request.requestId, requestFingerprint: null,
  });
  assert.equal(store.view().grants.length, 0);
  const second = await store.authorize({ tool: 'put_on_shelf', argumentsSha256, origin: 'local-chat', interactive: true });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'approval-required');
  assert.notEqual(second.requestId, request.requestId);
  await assert.rejects(store.decide({
    requestId: request.requestId, expectedFingerprint: request.requestFingerprint, decision: 'once',
  }), error => error.status === 409 && /no longer pending/.test(error.message));
});

test('an unused one-time approval expires instead of authorizing a matching call much later', async t => {
  const data = await fixture(t);
  const time = clockFixture();
  const store = await createToolPermissionStore({ file: data.file, clock: time.clock });
  await store.setPolicy({ tool: 'save_entry', mode: 'ask', expectedRevision: 0 });
  const argumentsSha256 = digest('one exact delayed entry');
  const request = await store.authorize({
    tool: 'save_entry', argumentsSha256, summary: 'Save the orchard entry.', origin: 'local-chat', interactive: true,
  });
  await store.decide({
    requestId: request.requestId, expectedFingerprint: request.requestFingerprint, decision: 'once',
  });
  const grant = store.view().grants[0];
  assert.equal(grant.summary, 'Save the orchard entry.');
  assert.equal(grant.argumentsFingerprint, argumentsSha256.slice(0, 12));
  assert.equal(new Date(grant.expiresAt).getTime() - new Date(grant.createdAt).getTime(), TOOL_PERMISSION_LIMITS.grantLifetimeMs);

  time.advance(TOOL_PERMISSION_LIMITS.grantLifetimeMs + 1);
  const revisionBeforeReap = store.view().revision;
  assert.equal(store.view(['save_entry']).grants.length, 0, 'an elapsed approval is never displayed as active');
  assert.equal(store.view().revision, revisionBeforeReap, 'a synchronous view does not pretend expiry was durably recorded');
  const later = await store.authorize({
    tool: 'save_entry', argumentsSha256, summary: 'Save the orchard entry.', origin: 'local-chat', interactive: true,
  });
  assert.equal(later.allowed, false);
  assert.equal(later.reason, 'approval-required');
  const view = store.view();
  assert.equal(view.grants.length, 0);
  assert.equal(view.pending.length, 1);
  assert.ok(view.history.some(row => row.action === 'grant-expired' && row.requestId === request.requestId));
});

test('an explicit tool list hides policies and actions for tools no longer configurable', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  await store.setPolicy({ tool: 'old_control', mode: 'ask', expectedRevision: 0 });
  const first = await store.authorize({
    tool: 'old_control', argumentsSha256: digest('approved old call'), origin: 'local-chat', interactive: true,
  });
  await store.decide({ requestId: first.requestId, expectedFingerprint: first.requestFingerprint, decision: 'once' });
  await store.authorize({
    tool: 'old_control', argumentsSha256: digest('pending old call'), origin: 'local-chat', interactive: true,
  });
  await store.setPolicy({
    tool: 'current_tool', mode: 'never', expectedRevision: store.view().revision,
  });

  const current = store.view(['current_tool']);
  assert.deepEqual(current.policies.map(row => [row.tool, row.mode]), [['current_tool', 'never']]);
  assert.equal(current.pending.length, 0);
  assert.equal(current.grants.length, 0);
  assert.ok(current.history.some(row => row.tool === 'old_control'), 'historical inspection remains global');
  assert.deepEqual(store.view([]).policies, []);
  assert.equal(store.view([]).pending.length, 0);
  assert.equal(store.view([]).grants.length, 0);

  const complete = store.view();
  assert.ok(complete.policies.some(row => row.tool === 'old_control'));
  assert.equal(complete.pending.length, 1);
  assert.equal(complete.grants.length, 1);
});

test('reconciliation retires hidden policy capacity before a current tool is configured', async t => {
  const data = await fixture(t);
  const updatedAt = '2030-04-05T06:07:08.000Z';
  const policies = Array.from({ length: TOOL_PERMISSION_LIMITS.policies }, (_, index) => ({
    tool: `retired_${String(index).padStart(3, '0')}`,
    mode: 'never',
    revision: index + 1,
    updatedAt,
    actor: 'person',
  }));
  await fs.writeFile(data.file, JSON.stringify({
    format: TOOL_PERMISSION_FORMAT,
    revision: policies.length,
    policies,
    pending: [],
    grants: [],
    history: [],
  }));
  const store = await createToolPermissionStore({ file: data.file, clock: () => new Date(updatedAt) });
  assert.equal(store.view().policies.length, TOOL_PERMISSION_LIMITS.policies);
  const reconciled = await store.reconcileTools(['current_tool']);
  assert.equal(reconciled.revision, TOOL_PERMISSION_LIMITS.policies + 1);
  assert.deepEqual(reconciled.policies, [{
    tool: 'current_tool', mode: 'always', explicit: false, revision: 0, updatedAt: null, actor: null,
  }]);
  assert.equal(reconciled.history.length, TOOL_PERMISSION_LIMITS.history);
  assert.ok(reconciled.history.every(row => row.action === 'policy-retired'));
  const configured = await store.setPolicy({
    tool: 'current_tool', mode: 'ask', expectedRevision: reconciled.revision,
  });
  assert.equal(configured.policies[0].mode, 'ask');
});

test('always and never decisions update policy and cancel sibling requests atomically', async t => {
  for (const decision of ['always', 'never']) {
    const data = await fixture(t, `${decision}.json`);
    const store = await createToolPermissionStore({ file: data.file });
    await store.setPolicy({ tool: 'write_file', mode: 'ask', expectedRevision: 0 });
    const chosen = await store.authorize({
      tool: 'write_file', argumentsSha256: digest(`${decision}-chosen`), origin: 'local-chat', interactive: true,
    });
    await store.authorize({
      tool: 'write_file', argumentsSha256: digest(`${decision}-sibling`), origin: 'local-chat', interactive: true,
    });
    const view = await store.decide({
      requestId: chosen.requestId, expectedFingerprint: chosen.requestFingerprint, decision,
    });
    assert.equal(view.policies[0].mode, decision);
    assert.equal(view.pending.length, 0);
    assert.ok(view.history.some(row => row.action === 'request-cancelled'));
    assert.ok(view.history.some(row => row.action === 'request-decided' && row.value === decision));
    const next = await store.authorize({
      tool: 'write_file', argumentsSha256: digest(`${decision}-later`), origin: 'local-chat', interactive: true,
    });
    assert.equal(next.allowed, decision === 'always');
    assert.equal(next.reason, `policy-${decision}`);
  }
});

test('changing a policy cancels pending requests and unused grants without exposing their digests', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  await store.setPolicy({ tool: 'remember', mode: 'ask', expectedRevision: 0 });
  const pending = await store.authorize({
    tool: 'remember', argumentsSha256: digest('memory one'), origin: 'local-chat', interactive: true,
  });
  await store.decide({ requestId: pending.requestId, expectedFingerprint: pending.requestFingerprint, decision: 'once' });
  await store.authorize({
    tool: 'remember', argumentsSha256: digest('memory two'), origin: 'local-chat', interactive: true,
  });
  const before = store.view(['remember']);
  const changed = await store.setPolicy({
    tool: 'remember', mode: 'never', expectedRevision: before.revision, actor: 'host',
  });
  assert.equal(changed.pending.length, 0);
  assert.equal(changed.grants.length, 0);
  assert.ok(changed.history.some(row => row.action === 'request-cancelled'));
  assert.ok(changed.history.some(row => row.action === 'grant-cancelled'));
  assert.equal(changed.policies[0].actor, 'host');
});

test('concurrent policy writes serialize and only one stale revision wins', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  const settled = await Promise.allSettled([
    store.setPolicy({ tool: 'read_web_page', mode: 'ask', expectedRevision: 0 }),
    store.setPolicy({ tool: 'read_web_page', mode: 'never', expectedRevision: 0 }),
  ]);
  assert.equal(settled.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(row => row.status === 'rejected' && row.reason.status === 409).length, 1);
  assert.equal(store.view(['read_web_page']).revision, 1);
});

test('failed atomic persistence leaves live state untouched', async t => {
  const data = await fixture(t);
  const blocker = path.join(data.directory, 'not-a-directory');
  const file = path.join(blocker, 'tool-permissions.json');
  const store = await createToolPermissionStore({ file });
  await fs.writeFile(blocker, 'blocks mkdir');
  await assert.rejects(store.setPolicy({ tool: 'write_file', mode: 'ask', expectedRevision: 0 }));
  assert.equal(store.mode('write_file'), 'always');
  assert.equal(store.view().revision, 0);
});

test('saved data is closed, bounded, duplicate-key checked, and fails closed', async t => {
  const malformed = await fixture(t, 'malformed.json');
  await fs.writeFile(malformed.file, '{');
  await assert.rejects(createToolPermissionStore({ file: malformed.file }), /Tool permissions:/);

  const repeated = await fixture(t, 'repeated.json');
  await fs.writeFile(repeated.file, '{"format":"fieldwork-tool-permissions/v1","format":"fieldwork-tool-permissions/v1","revision":0,"policies":[],"pending":[],"grants":[],"history":[]}');
  await assert.rejects(createToolPermissionStore({ file: repeated.file }), /repeats object key/);

  const unknown = await fixture(t, 'unknown.json');
  await fs.writeFile(unknown.file, JSON.stringify({
    format: TOOL_PERMISSION_FORMAT, revision: 0, policies: [], pending: [], grants: [], history: [], surprise: true,
  }));
  await assert.rejects(createToolPermissionStore({ file: unknown.file }), /unknown fields/);

  const oversized = await fixture(t, 'oversized.json');
  await fs.writeFile(oversized.file, ' '.repeat(TOOL_PERMISSION_LIMITS.fileBytes + 1));
  await assert.rejects(createToolPermissionStore({ file: oversized.file }), /too large/);

  const inconsistent = await fixture(t, 'inconsistent.json');
  const id = randomUUID();
  const createdAt = '2030-04-05T06:07:08.000Z';
  const request = { id, tool: 'write_file', argumentsSha256: digest('x'), summary: 'Write one file.', origin: 'local-chat', createdAt };
  await fs.writeFile(inconsistent.file, JSON.stringify({
    format: TOOL_PERMISSION_FORMAT,
    revision: 1,
    policies: [],
    pending: [{ ...request, fingerprint: digest(JSON.stringify(request)) }],
    grants: [],
    history: [],
  }));
  await assert.rejects(createToolPermissionStore({ file: inconsistent.file }), /fingerprint|explicit ask policy/);
});

test('the store never accepts or persists raw tool arguments or results', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  await store.setPolicy({ tool: 'save_entry', mode: 'ask', expectedRevision: 0 });
  const secret = 'synthetic-password-do-not-store';
  assert.throws(() => store.authorize({
    tool: 'save_entry', argumentsSha256: digest(secret), origin: 'local-chat', interactive: true,
    arguments: { password: secret },
  }), /unknown fields/);
  const request = await store.authorize({
    tool: 'save_entry', argumentsSha256: digest(secret), origin: 'local-chat', interactive: true,
  });
  await store.decide({ requestId: request.requestId, expectedFingerprint: request.requestFingerprint, decision: 'once' });
  const source = await fs.readFile(data.file, 'utf8');
  assert.doesNotMatch(source, new RegExp(secret, 'u'));
  assert.doesNotMatch(JSON.stringify(store.view(['save_entry'])), new RegExp(digest(secret), 'u'));

  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, 'tool', { enumerable: true, get() { accessed = true; return 'save_entry'; } });
  assert.throws(() => store.authorize(hostile), /enumerable data property/);
  assert.equal(accessed, false);
  assert.throws(() => store.mode('not a tool'), /lowercase letters/);
  const hostileTools = [];
  Object.defineProperty(hostileTools, '0', { enumerable: true, get() { accessed = true; return 'save_entry'; } });
  assert.throws(() => store.view(hostileTools), /enumerable data property/);
  assert.equal(accessed, false);
  assert.throws(() => store.reconcileTools(), /explicit tool list/);
  assert.throws(() => store.reconcileTools(['save_entry', 'save_entry']), /duplicates/);
});

test('pending requests stop at bounded capacity and reconciliation reclaims retired requests', async t => {
  const data = await fixture(t);
  const store = await createToolPermissionStore({ file: data.file });
  await store.setPolicy({ tool: 'save_entry', mode: 'ask', expectedRevision: 0 });
  for (let index = 0; index < TOOL_PERMISSION_LIMITS.pending; index++) {
    const result = await store.authorize({
      tool: 'save_entry', argumentsSha256: digest(`entry-${index}`), origin: 'local-chat', interactive: true,
    });
    assert.equal(result.reason, 'approval-required');
  }
  const before = store.view();
  const overflow = await store.authorize({
    tool: 'save_entry', argumentsSha256: digest('overflow'), origin: 'local-chat', interactive: true,
  });
  assert.equal(overflow.reason, 'request-capacity');
  assert.equal(store.view().pending.length, TOOL_PERMISSION_LIMITS.pending);
  assert.equal(store.view().revision, before.revision);

  const reconciled = await store.reconcileTools([]);
  assert.equal(reconciled.pending.length, 0);
  assert.equal(reconciled.policies.length, 0);
  assert.ok(reconciled.history.some(row => row.action === 'request-cancelled'));
  const configured = await store.setPolicy({
    tool: 'current_tool', mode: 'ask', expectedRevision: reconciled.revision,
  });
  const current = await store.authorize({
    tool: 'current_tool', argumentsSha256: digest('current request'), origin: 'local-chat', interactive: true,
  });
  assert.equal(current.reason, 'approval-required');
  assert.equal(store.view(['current_tool']).pending.length, 1);
  assert.equal(configured.policies[0].tool, 'current_tool');
});
