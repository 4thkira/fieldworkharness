import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDurableLog } from '../src/durable-log.mjs';
import { canonicalJson } from '../src/json-data.mjs';
import {
  BRIDGE_OUTPUT_FORMAT,
  createBridgeOutput,
  createExternalDeliveryCoordinator,
  createExternalDeliveryStore,
  EXTERNAL_DELIVERY_ACTION_FORMAT,
  EXTERNAL_DELIVERY_ATTEMPT_FORMAT,
  EXTERNAL_DELIVERY_EVENT_FORMAT,
  EXTERNAL_DELIVERY_POLICY,
  EXTERNAL_DELIVERY_PROACTIVE_POLICY,
  EXTERNAL_DELIVERY_SETTLEMENT_FORMAT,
  EXTERNAL_DELIVERY_SETTLEMENT_FORMAT_V1,
  isBridgeOutput,
  isExternalDeliveryPlan,
  normalizeBridgeOutput,
  openExternalDeliveryStore,
} from '../src/external-delivery.mjs';

const at = '2030-01-02T03:04:05.000Z';
const clock = () => Date.parse(at);
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const telegramRoute = Object.freeze({
  platform: 'telegram', destinationId: '123456789', sourceUserId: '987654321',
});
const discordRoute = Object.freeze({
  platform: 'discord', destinationId: '123456789012345678', sourceUserId: '987654321098765432',
});
const replySource = Object.freeze({
  kind: 'conversation-reply',
  conversationId: 'conv-00000000-0000-4000-8000-000000000000',
  messageId: 'm000003',
  messageSha256: 'a'.repeat(64),
  contentSha256: 'b'.repeat(64),
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-external-delivery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'synthetic-deliveries', clock });
  t.after(async () => { try { await store.close(); } catch { /* A test may close it before reopen. */ } });
  return { directory, file, store };
}

function fingerprinted(body) {
  return { ...body, fingerprint: hash(canonicalJson(body)) };
}

async function createRawTrackedLog(file, id) {
  return openDurableLog(file, {
    create: true,
    format: EXTERNAL_DELIVERY_EVENT_FORMAT,
    idField: 'deliveryStoreId',
    id,
    initial: {
      type: 'external_delivery_created',
      data: {
        actionFormat: EXTERNAL_DELIVERY_ACTION_FORMAT,
        policy: EXTERNAL_DELIVERY_POLICY,
        attemptFormat: EXTERNAL_DELIVERY_ATTEMPT_FORMAT,
      },
    },
    clock,
  });
}

test('bridge outputs are strict, accessor-safe, and legacy strings normalize without gaining route authority', () => {
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text: 'Synthetic reply.',
    source: replySource,
  });
  assert.equal(isBridgeOutput(output), true);
  assert.deepEqual(output.source, replySource);
  assert.deepEqual(normalizeBridgeOutput('Legacy reply.'), {
    format: BRIDGE_OUTPUT_FORMAT,
    text: 'Legacy reply.',
    source: { kind: 'legacy' },
  });
  assert.throws(() => createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text: 'no',
    source: { ...replySource, destinationId: '999' },
  }), /unknown field/);
  let read = false;
  const accessor = { format: BRIDGE_OUTPUT_FORMAT, source: replySource };
  Object.defineProperty(accessor, 'text', { enumerable: true, get() { read = true; return 'must not run'; } });
  assert.throws(() => normalizeBridgeOutput(accessor), /enumerable data property/);
  assert.equal(read, false);
});

test('proactive delivery is truthfully bound to its saved local reply and keeps reply ids strict', async t => {
  const { file, store } = await fixture(t);
  const coordinator = createExternalDeliveryCoordinator(store, telegramRoute);
  const text = 'A proactive check-in, saved before transport.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: { ...replySource, contentSha256: hash(text) },
  });

  await assert.rejects(
    coordinator.prepare({ sourceMessageId: replySource.messageId, output }),
    /decimal platform identifier/,
  );
  await assert.rejects(
    coordinator.prepareProactive({ sourceMessageId: '42', output }),
    /must match its conversation reply messageId/,
  );
  await assert.rejects(
    coordinator.prepareProactive({
      sourceMessageId: 'm000004',
      output,
    }),
    /must match its conversation reply messageId/,
  );
  await assert.rejects(
    coordinator.prepareProactive({
      sourceMessageId: replySource.messageId,
      output: normalizeBridgeOutput(text),
    }),
    /must match its conversation reply messageId/,
  );

  const plan = await coordinator.prepareProactive({ sourceMessageId: replySource.messageId, output });
  assert.equal(plan.receipt.envelope.action, 'bridge-proactive');
  assert.equal(plan.receipt.envelope.policy, EXTERNAL_DELIVERY_PROACTIVE_POLICY);
  assert.equal(plan.receipt.envelope.sourceMessageId, replySource.messageId);
  assert.equal(plan.receipt.envelope.source.messageId, replySource.messageId);
  await assert.rejects(
    coordinator.prepareProactive({ sourceMessageId: replySource.messageId, output }),
    /source message already has a delivery action|saved reply already has a delivery action/,
  );

  await coordinator.beginAttempt({ actionId: plan.actionId });
  await coordinator.settle({
    actionId: plan.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: telegramRoute.destinationId, platformMessageId: '901' }],
  });
  const head = (await store.receipt()).head;
  await store.close();
  const reopened = await openExternalDeliveryStore(file, {
    expectedId: 'synthetic-deliveries', expectedHead: head, clock,
  });
  const [row] = await reopened.forConversation(replySource.conversationId);
  assert.equal(row.action.envelope.action, 'bridge-proactive');
  assert.equal(row.action.envelope.policy, EXTERNAL_DELIVERY_PROACTIVE_POLICY);
  assert.equal(row.settlement.outcome, 'platform-accepted');
  await reopened.close();
});

test('proactive source claims distinguish per-conversation message ids while saved replies remain one-winner', async t => {
  const { store } = await fixture(t);
  const telegram = createExternalDeliveryCoordinator(store, telegramRoute);
  const discord = createExternalDeliveryCoordinator(store, discordRoute);
  const text = 'The same per-conversation message number can recur safely.';
  const contentSha256 = hash(text);
  const firstSource = { ...replySource, contentSha256 };
  const secondSource = {
    ...replySource,
    conversationId: 'conv-11111111-1111-4111-8111-111111111111',
    contentSha256,
  };

  const first = await telegram.prepareProactive({
    sourceMessageId: replySource.messageId,
    output: createBridgeOutput({ format: BRIDGE_OUTPUT_FORMAT, text, source: firstSource }),
  });
  const second = await telegram.prepareProactive({
    sourceMessageId: replySource.messageId,
    output: createBridgeOutput({ format: BRIDGE_OUTPUT_FORMAT, text, source: secondSource }),
  });
  assert.notEqual(second.actionId, first.actionId);
  assert.equal((await store.forConversation(firstSource.conversationId)).length, 1);
  assert.equal((await store.forConversation(secondSource.conversationId)).length, 1);

  const beforeDuplicate = await store.receipt();
  await assert.rejects(discord.prepareProactive({
    sourceMessageId: replySource.messageId,
    output: createBridgeOutput({ format: BRIDGE_OUTPUT_FORMAT, text, source: firstSource }),
  }), /saved reply already has a delivery action/);
  const afterDuplicate = await store.receipt();
  assert.equal(afterDuplicate.head, beforeDuplicate.head);
  assert.equal(afterDuplicate.events, beforeDuplicate.events);
});

test('proactive delivery accepts conversation message ids beyond six digits without retaining raw text', async t => {
  const { file, store } = await fixture(t);
  const coordinator = createExternalDeliveryCoordinator(store, telegramRoute);
  const text = 'A private proactive check-in beyond the first million messages.';
  const source = {
    ...replySource,
    messageId: 'm1000000',
    messageSha256: 'c'.repeat(64),
    contentSha256: hash(text),
  };
  const output = createBridgeOutput({ format: BRIDGE_OUTPUT_FORMAT, text, source });

  const plan = await coordinator.prepareProactive({ sourceMessageId: source.messageId, output });
  assert.equal(plan.decision, 'allow');
  assert.equal(plan.receipt.envelope.sourceMessageId, 'm1000000');
  assert.equal(plan.receipt.envelope.source.messageId, 'm1000000');
  const persisted = await fs.readFile(file, 'utf8');
  assert.equal(persisted.includes(text), false);

  const shortSource = {
    ...source,
    messageId: 'm12345',
    messageSha256: 'd'.repeat(64),
  };
  await assert.rejects(coordinator.prepareProactive({
    sourceMessageId: shortSource.messageId,
    output: createBridgeOutput({ format: BRIDGE_OUTPUT_FORMAT, text, source: shortSource }),
  }), /must match its conversation reply messageId/);
});

test('a tracked pre-proactive ledger accepts, settles, and reopens a later proactive action', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-legacy-proactive-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'delivery.jsonl');
  const raw = await createRawTrackedLog(file, 'legacy-before-proactive-policy');
  await raw.close();

  const store = await openExternalDeliveryStore(file, {
    expectedId: 'legacy-before-proactive-policy', clock,
  });
  const coordinator = createExternalDeliveryCoordinator(store, telegramRoute);
  const text = 'A proactive action added after the original tracked genesis.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: { ...replySource, contentSha256: hash(text) },
  });
  const plan = await coordinator.prepareProactive({ sourceMessageId: replySource.messageId, output });
  await coordinator.beginAttempt({ actionId: plan.actionId });
  await coordinator.settle({
    actionId: plan.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: telegramRoute.destinationId, platformMessageId: '902' }],
  });
  const head = (await store.receipt()).head;
  await store.close();

  const reopened = await openExternalDeliveryStore(file, {
    expectedId: 'legacy-before-proactive-policy', expectedHead: head, clock,
  });
  const row = await reopened.lookup(plan.actionId);
  assert.equal(row.action.envelope.action, 'bridge-proactive');
  assert.equal(row.action.envelope.policy, EXTERNAL_DELIVERY_PROACTIVE_POLICY);
  assert.equal(row.settlement.outcome, 'platform-accepted');
  assert.equal((await fs.readFile(file, 'utf8')).includes(text), false);
  await reopened.close();
});

test('replay refuses proactive actions with a mismatched policy or saved message id', async t => {
  const { directory, store } = await fixture(t);
  const text = 'A valid proactive template whose replay claims will be forged.';
  const plan = await createExternalDeliveryCoordinator(store, telegramRoute).prepareProactive({
    sourceMessageId: replySource.messageId,
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text,
      source: { ...replySource, contentSha256: hash(text) },
    }),
  });
  const cases = [
    ['policy', action => { action.envelope.policy = EXTERNAL_DELIVERY_POLICY; }, /policy is invalid/],
    ['source-message', action => { action.envelope.source.messageId = 'm000004'; }, /must match its conversation reply messageId/],
  ];
  for (const [name, mutate, expected] of cases) {
    const action = structuredClone(plan.receipt);
    mutate(action);
    delete action.fingerprint;
    action.fingerprint = hash(canonicalJson(action));
    const file = path.join(directory, `forged-proactive-${name}.jsonl`);
    const raw = await createRawTrackedLog(file, `forged-proactive-${name}`);
    await raw.append('external_delivery_preflighted', { action });
    await raw.close();
    await assert.rejects(openExternalDeliveryStore(file, { clock }), expected);
    assert.equal(await fs.stat(`${file}.lock`).catch(error => error.code), 'ENOENT');
  }
});

test('an allowed plan is durable before send, contains exact Unicode chunks, settles, and reopens without raw text', async t => {
  const { file, store } = await fixture(t);
  const coordinator = createExternalDeliveryCoordinator(store, telegramRoute);
  const text = `${'a'.repeat(4095)}🧪z`;
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: { ...replySource, contentSha256: hash(text) },
  });
  const plan = await coordinator.prepare({ sourceMessageId: '42', output });
  assert.equal(isExternalDeliveryPlan(plan), true);
  assert.equal(plan.decision, 'allow');
  assert.deepEqual(plan.chunks.map(chunk => [...chunk].length), [4096, 1]);
  assert.equal(plan.receipt.format, EXTERNAL_DELIVERY_ACTION_FORMAT);
  assert.equal(plan.receipt.envelope.content.characters, 4097);
  assert.equal(plan.receipt.envelope.content.chunks.length, 2);
  assert.equal(JSON.stringify(plan.receipt).includes(text), false);
  const beforeSend = await fs.readFile(file, 'utf8');
  assert.match(beforeSend, /external_delivery_preflighted/);
  assert.equal(beforeSend.includes(text), false);

  const attempted = await coordinator.beginAttempt({ actionId: plan.actionId });
  assert.equal(attempted.attempt.format, EXTERNAL_DELIVERY_ATTEMPT_FORMAT);

  const settled = await coordinator.settle({
    actionId: plan.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [
      { destinationId: telegramRoute.destinationId, platformMessageId: '1001' },
      { destinationId: telegramRoute.destinationId, platformMessageId: '1002' },
    ],
  });
  assert.equal(settled.settlement.outcome, 'platform-accepted');
  assert.equal(settled.settlement.format, EXTERNAL_DELIVERY_SETTLEMENT_FORMAT);
  assert.deepEqual(settled.settlement.acknowledgements, [
    {
      index: 0,
      chunkSha256: plan.receipt.envelope.content.chunks[0].sha256,
      destinationId: telegramRoute.destinationId,
      platformMessageId: '1001',
    },
    {
      index: 1,
      chunkSha256: plan.receipt.envelope.content.chunks[1].sha256,
      destinationId: telegramRoute.destinationId,
      platformMessageId: '1002',
    },
  ]);
  const head = (await store.receipt()).head;
  await store.close();
  const reopened = await openExternalDeliveryStore(file, {
    expectedId: 'synthetic-deliveries', expectedHead: head, clock,
  });
  const rows = await reopened.forConversation(replySource.conversationId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action.envelope.source.messageId, replySource.messageId);
  assert.deepEqual(rows[0].settlement.platformMessageIds, ['1001', '1002']);
  await reopened.close();
});

test('attempt markers are route-bound, durable exactly once, hash-only, and survive reopen', async t => {
  const { file, store } = await fixture(t);
  const coordinator = createExternalDeliveryCoordinator(store, telegramRoute);
  const otherRoute = createExternalDeliveryCoordinator(store, discordRoute);
  const text = 'Attempt-only secret that must never enter the durable log.';
  const plan = await coordinator.prepare({ sourceMessageId: '301', output: normalizeBridgeOutput(text) });
  const preparedView = await store.unresolved({ limit: 1 });
  const [prepared] = preparedView.items;
  assert.deepEqual({ total: preparedView.total, hasMore: preparedView.hasMore }, { total: 1, hasMore: false });
  assert.equal(prepared.actionId, plan.actionId);
  assert.equal(prepared.state, 'prepared-not-attempted');
  assert.equal(prepared.attemptTracking, 'tracked');
  assert.equal(prepared.attemptFingerprint, null);
  assert.equal(prepared.content.sha256, hash(text));
  assert.equal(JSON.stringify(prepared).includes(text), false);
  await assert.rejects(store.unresolved({ limit: 0 }), /whole number from 1 to 256/);
  await assert.rejects(coordinator.settle({
    actionId: plan.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: telegramRoute.destinationId, platformMessageId: '3001' }],
  }), /must begin its durable attempt/);
  await assert.rejects(otherRoute.beginAttempt({ actionId: plan.actionId }), /different route/);

  const raced = await Promise.allSettled([
    coordinator.beginAttempt({ actionId: plan.actionId }),
    coordinator.beginAttempt({ actionId: plan.actionId }),
  ]);
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter(result => result.status === 'rejected').length, 1);
  assert.match(raced.find(result => result.status === 'rejected').reason.message, /already attempted/);

  const [attempted] = (await store.unresolved({ limit: 1 })).items;
  assert.equal(attempted.state, 'attempted-unsettled');
  assert.equal(attempted.attemptedAt, at);
  assert.match(attempted.attemptFingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(attempted.fingerprint, prepared.fingerprint);
  const persisted = await fs.readFile(file, 'utf8');
  assert.equal((persisted.match(/"type":"external_delivery_attempted"/g) ?? []).length, 1);
  assert.equal(persisted.includes(text), false);

  const head = (await store.receipt()).head;
  await store.close();
  const reopened = await openExternalDeliveryStore(file, {
    expectedId: 'synthetic-deliveries', expectedHead: head, clock,
  });
  const [recovered] = (await reopened.unresolved({ limit: 1 })).items;
  assert.equal(recovered.state, 'attempted-unsettled');
  assert.equal(recovered.fingerprint, attempted.fingerprint);
  assert.equal((await reopened.lookup(plan.actionId)).attempt.fingerprint, attempted.attemptFingerprint);
  await reopened.close();
});

test('recovery resolutions are state-limited, fingerprint-guarded, and single-winner under races', async t => {
  const { file, store } = await fixture(t);
  const coordinator = createExternalDeliveryCoordinator(store, telegramRoute);
  const unsentText = 'Prepared recovery secret.';
  const attemptedText = 'Attempted recovery secret.';
  const unsentPlan = await coordinator.prepare({ sourceMessageId: '401', output: normalizeBridgeOutput(unsentText) });
  const attemptedPlan = await coordinator.prepare({ sourceMessageId: '402', output: normalizeBridgeOutput(attemptedText) });
  const bounded = await store.unresolved({ limit: 1 });
  assert.deepEqual({ total: bounded.total, hasMore: bounded.hasMore, shown: bounded.items.length }, {
    total: 2, hasMore: true, shown: 1,
  });
  const initial = (await store.unresolved({ limit: 2 })).items;
  const unsentRow = initial.find(row => row.actionId === unsentPlan.actionId);
  const beforeAttempt = initial.find(row => row.actionId === attemptedPlan.actionId);

  await assert.rejects(store.resolveRecovery({
    actionId: unsentPlan.actionId,
    expectedFingerprint: unsentRow.fingerprint,
    resolution: 'acknowledge-uncertain',
  }), /requires a durable attempt/);
  const abandonRace = await Promise.allSettled([
    store.resolveRecovery({
      actionId: unsentPlan.actionId,
      expectedFingerprint: unsentRow.fingerprint,
      resolution: 'abandon-unsent',
    }),
    store.resolveRecovery({
      actionId: unsentPlan.actionId,
      expectedFingerprint: unsentRow.fingerprint,
      resolution: 'abandon-unsent',
    }),
  ]);
  assert.equal(abandonRace.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(abandonRace.filter(result => result.status === 'rejected').length, 1);
  const abandoned = await store.lookup(unsentPlan.actionId);
  assert.equal(abandoned.settlement.outcome, 'not-sent');
  assert.equal(abandoned.settlement.failureKind, 'operator-abandoned');

  await coordinator.beginAttempt({ actionId: attemptedPlan.actionId });
  await assert.rejects(store.resolveRecovery({
    actionId: attemptedPlan.actionId,
    expectedFingerprint: beforeAttempt.fingerprint,
    resolution: 'acknowledge-uncertain',
  }), /changed after inspection/);
  const attemptedRow = (await store.unresolved({ limit: 1 })).items[0];
  assert.equal(attemptedRow.actionId, attemptedPlan.actionId);
  await assert.rejects(store.resolveRecovery({
    actionId: attemptedPlan.actionId,
    expectedFingerprint: attemptedRow.fingerprint,
    resolution: 'abandon-unsent',
  }), /tracked action with no durable attempt/);
  const uncertainRace = await Promise.allSettled([
    store.resolveRecovery({
      actionId: attemptedPlan.actionId,
      expectedFingerprint: attemptedRow.fingerprint,
      resolution: 'acknowledge-uncertain',
    }),
    store.resolveRecovery({
      actionId: attemptedPlan.actionId,
      expectedFingerprint: attemptedRow.fingerprint,
      resolution: 'acknowledge-uncertain',
    }),
  ]);
  assert.equal(uncertainRace.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(uncertainRace.filter(result => result.status === 'rejected').length, 1);
  const uncertain = await store.lookup(attemptedPlan.actionId);
  assert.equal(uncertain.settlement.outcome, 'uncertain');
  assert.equal(uncertain.settlement.failureKind, 'transport-uncertain');
  assert.deepEqual(await store.unresolved(), { total: 0, hasMore: false, items: [] });

  const persisted = await fs.readFile(file, 'utf8');
  assert.equal(persisted.includes(unsentText), false);
  assert.equal(persisted.includes(attemptedText), false);
  const head = (await store.receipt()).head;
  await store.close();
  const reopened = await openExternalDeliveryStore(file, {
    expectedId: 'synthetic-deliveries', expectedHead: head, clock,
  });
  assert.equal((await reopened.lookup(unsentPlan.actionId)).settlement.outcome, 'not-sent');
  assert.equal((await reopened.lookup(attemptedPlan.actionId)).settlement.outcome, 'uncertain');
  await reopened.close();
});

test('legacy v1 unresolved actions are conservatively attempted and later preflights gain tracking', async t => {
  const { directory, store } = await fixture(t);
  const templateText = 'Legacy content stays represented only by its hash.';
  const template = await createExternalDeliveryCoordinator(store, telegramRoute).prepare({
    sourceMessageId: '501',
    output: normalizeBridgeOutput(templateText),
  });
  const legacyFile = path.join(directory, 'legacy-delivery.jsonl');
  const raw = await openDurableLog(legacyFile, {
    create: true,
    format: EXTERNAL_DELIVERY_EVENT_FORMAT,
    idField: 'deliveryStoreId',
    id: 'legacy-deliveries',
    initial: {
      type: 'external_delivery_created',
      data: { actionFormat: EXTERNAL_DELIVERY_ACTION_FORMAT, policy: EXTERNAL_DELIVERY_POLICY },
    },
    clock,
  });
  await raw.append('external_delivery_preflighted', { action: template.receipt });
  await raw.close();

  const legacy = await openExternalDeliveryStore(legacyFile, { expectedId: 'legacy-deliveries', clock });
  const coordinator = createExternalDeliveryCoordinator(legacy, telegramRoute);
  const [row] = (await legacy.unresolved({ limit: 1 })).items;
  assert.equal(row.state, 'legacy-attempted-unsettled');
  assert.equal(row.attemptTracking, 'legacy-untracked');
  assert.equal(row.attemptFingerprint, null);
  await assert.rejects(coordinator.beginAttempt({ actionId: template.actionId }), /conservatively classified as attempted/);
  await assert.rejects(coordinator.settle({
    actionId: template.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: telegramRoute.destinationId, platformMessageId: '5001' }],
  }), /can only be acknowledged as uncertain through recovery/);
  await assert.rejects(legacy.resolveRecovery({
    actionId: template.actionId,
    expectedFingerprint: row.fingerprint,
    resolution: 'abandon-unsent',
  }), /tracked action with no durable attempt/);
  const acknowledged = await legacy.resolveRecovery({
    actionId: template.actionId,
    expectedFingerprint: row.fingerprint,
    resolution: 'acknowledge-uncertain',
  });
  assert.equal(acknowledged.settlement.outcome, 'uncertain');

  const newText = 'Post-upgrade tracked content also remains hash-only.';
  const trackedPlan = await coordinator.prepare({
    sourceMessageId: '502',
    output: normalizeBridgeOutput(newText),
  });
  const [trackedRow] = (await legacy.unresolved({ limit: 1 })).items;
  assert.equal(trackedRow.actionId, trackedPlan.actionId);
  assert.equal(trackedRow.state, 'prepared-not-attempted');
  assert.equal(trackedRow.attemptTracking, 'tracked');
  const head = (await legacy.receipt()).head;
  await legacy.close();

  const persisted = await fs.readFile(legacyFile, 'utf8');
  assert.match(persisted, /external_delivery_attempt_tracking_enabled/);
  assert.equal(persisted.includes(templateText), false);
  assert.equal(persisted.includes(newText), false);
  const reopened = await openExternalDeliveryStore(legacyFile, {
    expectedId: 'legacy-deliveries', expectedHead: head, clock,
  });
  const [reopenedTracked] = (await reopened.unresolved({ limit: 1 })).items;
  assert.equal(reopenedTracked.actionId, trackedPlan.actionId);
  assert.equal(reopenedTracked.state, 'prepared-not-attempted');
  await reopened.close();
});

test('a genuine v1 accepted settlement reopens unchanged beside later destination-bound v2 evidence', async t => {
  const { directory, store } = await fixture(t);
  const template = await createExternalDeliveryCoordinator(store, telegramRoute).prepare({
    sourceMessageId: '601',
    output: normalizeBridgeOutput('One legacy accepted chunk.'),
  });
  const file = path.join(directory, 'mixed-settlements.jsonl');
  const raw = await createRawTrackedLog(file, 'mixed-settlements');
  const attempt = fingerprinted({
    format: EXTERNAL_DELIVERY_ATTEMPT_FORMAT,
    actionId: template.actionId,
    attemptedAt: at,
  });
  const legacyBody = {
    format: EXTERNAL_DELIVERY_SETTLEMENT_FORMAT_V1,
    actionId: template.actionId,
    settledAt: at,
    outcome: 'platform-accepted',
    failureKind: null,
    acceptedChunks: 1,
    totalChunks: 1,
    platformMessageIds: ['6001'],
  };
  const legacySettlement = fingerprinted(legacyBody);
  await raw.append('external_delivery_preflighted', { action: template.receipt });
  await raw.append('external_delivery_attempted', { attempt });
  await raw.append('external_delivery_settled', { settlement: legacySettlement });
  const legacyHead = (await raw.receipt()).head;
  await raw.close();

  const mixed = await openExternalDeliveryStore(file, {
    expectedId: 'mixed-settlements', expectedHead: legacyHead, clock,
  });
  const restoredLegacy = (await mixed.lookup(template.actionId)).settlement;
  assert.equal(restoredLegacy.format, EXTERNAL_DELIVERY_SETTLEMENT_FORMAT_V1);
  assert.equal(restoredLegacy.fingerprint, legacySettlement.fingerprint);
  assert.deepEqual(restoredLegacy.platformMessageIds, ['6001']);
  assert.equal(Object.hasOwn(restoredLegacy, 'acknowledgements'), false);

  const coordinator = createExternalDeliveryCoordinator(mixed, telegramRoute);
  const current = await coordinator.prepare({
    sourceMessageId: '602', output: normalizeBridgeOutput('One current accepted chunk.'),
  });
  await coordinator.beginAttempt({ actionId: current.actionId });
  const settled = await coordinator.settle({
    actionId: current.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: telegramRoute.destinationId, platformMessageId: '6002' }],
  });
  assert.equal(settled.settlement.format, EXTERNAL_DELIVERY_SETTLEMENT_FORMAT);
  assert.equal(settled.settlement.acknowledgements[0].chunkSha256, current.receipt.envelope.content.chunks[0].sha256);
  const head = (await mixed.receipt()).head;
  await mixed.close();

  const reopened = await openExternalDeliveryStore(file, {
    expectedId: 'mixed-settlements', expectedHead: head, clock,
  });
  assert.equal((await reopened.lookup(template.actionId)).settlement.format, EXTERNAL_DELIVERY_SETTLEMENT_FORMAT_V1);
  assert.equal((await reopened.lookup(current.actionId)).settlement.format, EXTERNAL_DELIVERY_SETTLEMENT_FORMAT);
  await reopened.close();
});

test('v2 replay rejects rehashed acknowledgement evidence that is not bound to its plan', async t => {
  const { directory, store } = await fixture(t);
  const template = await createExternalDeliveryCoordinator(store, telegramRoute).prepare({
    sourceMessageId: '701', output: normalizeBridgeOutput('Destination-bound evidence.'),
  });
  const attempt = fingerprinted({
    format: EXTERNAL_DELIVERY_ATTEMPT_FORMAT,
    actionId: template.actionId,
    attemptedAt: at,
  });
  const validAcknowledgement = {
    index: 0,
    chunkSha256: template.receipt.envelope.content.chunks[0].sha256,
    destinationId: telegramRoute.destinationId,
    platformMessageId: '7001',
  };
  const base = {
    format: EXTERNAL_DELIVERY_SETTLEMENT_FORMAT,
    actionId: template.actionId,
    settledAt: at,
    outcome: 'platform-accepted',
    failureKind: null,
    acceptedChunks: 1,
    totalChunks: 1,
    platformMessageIds: ['7001'],
    acknowledgements: [validAcknowledgement],
  };
  const mutants = [
    ['index', { ...base, acknowledgements: [{ ...validAcknowledgement, index: 1 }] }],
    ['chunk hash', { ...base, acknowledgements: [{ ...validAcknowledgement, chunkSha256: 'f'.repeat(64) }] }],
    ['destination', { ...base, acknowledgements: [{ ...validAcknowledgement, destinationId: '123456788' }] }],
    ['message id', { ...base, acknowledgements: [{ ...validAcknowledgement, platformMessageId: '7002' }] }],
    ['count', { ...base, acknowledgements: [] }],
    ['unknown field', { ...base, acknowledgements: [{ ...validAcknowledgement, extra: true }] }],
  ];
  for (let index = 0; index < mutants.length; index++) {
    const [label, body] = mutants[index];
    const file = path.join(directory, `mutant-${index}.jsonl`);
    const raw = await createRawTrackedLog(file, `mutant-${index}`);
    await raw.append('external_delivery_preflighted', { action: template.receipt });
    await raw.append('external_delivery_attempted', { attempt });
    await raw.append('external_delivery_settled', { settlement: fingerprinted(body) });
    await raw.close();
    await assert.rejects(
      openExternalDeliveryStore(file, { expectedId: `mutant-${index}`, clock }),
      undefined,
      label,
    );
  }
});

test('policy refusals are persisted as normal no-send plans and retain no chunks or raw content', async t => {
  const { file, store } = await fixture(t);
  const coordinator = createExternalDeliveryCoordinator(store, discordRoute);
  const cases = [
    ['', 'empty-content'],
    ['\ud800', 'malformed-unicode'],
    ['x'.repeat((256 * 1024) + 1), 'content-too-large'],
  ];
  for (let index = 0; index < cases.length; index++) {
    const [text, reason] = cases[index];
    const plan = await coordinator.prepare({
      sourceMessageId: String(100 + index),
      output: normalizeBridgeOutput(text),
    });
    assert.equal(plan.decision, 'refuse');
    assert.deepEqual(plan.chunks, []);
    assert.equal(plan.receipt.preflight.checks.find(check => check.status === 'failed').reason, reason);
    assert.deepEqual(plan.receipt.envelope.content.chunks, []);
  }
  const persisted = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(persisted, /xxxxxxxxxxxxxxxx/);
});

test('source-message fencing, route binding, and settlement transitions reject ambiguous reuse', async t => {
  const { store } = await fixture(t);
  assert.throws(() => createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: 'not-a-chat', sourceUserId: '987654321',
  }), /destinationId/);
  const telegram = createExternalDeliveryCoordinator(store, telegramRoute);
  const mismatched = await telegram.prepare({
    sourceMessageId: '41',
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: 'Text B',
      source: {
        kind: 'conversation-reply',
        conversationId: replySource.conversationId,
        messageId: 'm000004',
        messageSha256: 'c'.repeat(64),
        contentSha256: hash('Text A'),
      },
    }),
  });
  assert.equal(mismatched.decision, 'refuse');
  assert.equal(mismatched.receipt.preflight.checks[2].reason, 'source-content-mismatch');
  const plan = await telegram.prepare({ sourceMessageId: '42', output: normalizeBridgeOutput('first') });
  await assert.rejects(
    telegram.prepare({ sourceMessageId: '42', output: normalizeBridgeOutput('duplicate') }),
    /source message already has/,
  );
  await telegram.beginAttempt({ actionId: plan.actionId });
  await assert.rejects(telegram.settle({
    actionId: plan.actionId,
    outcome: 'uncertain',
    failureKind: 'transport-uncertain',
  }), /acknowledgements is invalid/);
  await assert.rejects(telegram.settle({
    actionId: plan.actionId,
    outcome: 'uncertain',
    failureKind: 'transport-uncertain',
    acknowledgements: null,
  }), /acknowledgements is invalid/);
  await assert.rejects(telegram.settle({
    actionId: plan.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [],
  }), /acknowledge every chunk/);
  await assert.rejects(telegram.settle({
    actionId: plan.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: '123456788', platformMessageId: '87' }],
  }), /destinationId does not match the plan/);
  const multipart = await telegram.prepare({ sourceMessageId: '43', output: normalizeBridgeOutput('x'.repeat(4097)) });
  await telegram.beginAttempt({ actionId: multipart.actionId });
  await assert.rejects(telegram.settle({
    actionId: multipart.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [
      { destinationId: telegramRoute.destinationId, platformMessageId: '88' },
      { destinationId: telegramRoute.destinationId, platformMessageId: '88' },
    ],
  }), /must be unique/);
  await assert.rejects(telegram.settle({
    actionId: plan.actionId,
    outcome: 'platform-rejected',
    failureKind: 'transport-uncertain',
    acknowledgements: [],
  }), /matching failure kind/);
  await assert.rejects(telegram.settle({
    actionId: plan.actionId,
    outcome: 'uncertain',
    failureKind: 'platform-rejected',
    acknowledgements: [],
  }), /cannot have an uncertain outcome/);
  await telegram.settle({
    actionId: plan.actionId,
    outcome: 'uncertain',
    failureKind: 'transport-uncertain',
    acknowledgements: [],
  });
  await assert.rejects(telegram.settle({
    actionId: plan.actionId,
    outcome: 'uncertain',
    failureKind: 'transport-uncertain',
    acknowledgements: [],
  }), /already settled/);

  const discord = createExternalDeliveryCoordinator(store, discordRoute);
  await assert.rejects(discord.settle({
    actionId: plan.actionId,
    outcome: 'uncertain',
    failureKind: 'transport-uncertain',
    acknowledgements: [],
  }), /different route|already settled/);
});

test('a duplicate saved-reply claim is rejected before append and leaves a reopenable log', async t => {
  const { file, store } = await fixture(t);
  const coordinator = createExternalDeliveryCoordinator(store, telegramRoute);
  const text = 'One saved reply.';
  const source = { ...replySource, contentSha256: hash(text) };
  await coordinator.prepare({
    sourceMessageId: '80',
    output: createBridgeOutput({ format: BRIDGE_OUTPUT_FORMAT, text, source }),
  });
  const before = await store.receipt();
  await assert.rejects(coordinator.prepare({
    sourceMessageId: '81',
    output: createBridgeOutput({ format: BRIDGE_OUTPUT_FORMAT, text, source }),
  }), /saved reply already has/);
  const after = await store.receipt();
  assert.equal(after.head, before.head);
  assert.equal(after.events, before.events);
  await store.close();
  const reopened = await openExternalDeliveryStore(file, {
    expectedId: 'synthetic-deliveries', expectedHead: before.head, clock,
  });
  assert.equal((await reopened.forConversation(replySource.conversationId)).length, 1);
  await reopened.close();
});

test('replay refuses a rehashed action whose passed source binding contradicts its content receipt', async t => {
  const { directory, store } = await fixture(t);
  const text = 'Bound synthetic reply.';
  const coordinator = createExternalDeliveryCoordinator(store, telegramRoute);
  const plan = await coordinator.prepare({
    sourceMessageId: '90',
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text,
      source: { ...replySource, contentSha256: hash(text) },
    }),
  });
  const forged = JSON.parse(canonicalJson(plan.receipt));
  forged.envelope.source.contentSha256 = 'f'.repeat(64);
  delete forged.fingerprint;
  forged.fingerprint = hash(canonicalJson(forged));

  const file = path.join(directory, 'forged-delivery.jsonl');
  const raw = await openDurableLog(file, {
    create: true,
    format: EXTERNAL_DELIVERY_EVENT_FORMAT,
    idField: 'deliveryStoreId',
    id: 'forged-deliveries',
    initial: {
      type: 'external_delivery_created',
      data: { actionFormat: EXTERNAL_DELIVERY_ACTION_FORMAT, policy: EXTERNAL_DELIVERY_POLICY },
    },
    clock,
  });
  await raw.append('external_delivery_preflighted', { action: forged });
  await raw.close();
  await assert.rejects(openExternalDeliveryStore(file, { clock }), /must match its saved reply content hash/);
  assert.equal(await fs.stat(`${file}.lock`).catch(error => error.code), 'ENOENT');
});
