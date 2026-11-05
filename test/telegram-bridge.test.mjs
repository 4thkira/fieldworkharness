import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTelegramBridge, TELEGRAM_BRIDGE_STATUS_FORMAT } from '../src/telegram-bridge.mjs';
import {
  BRIDGE_OUTPUT_FORMAT,
  createBridgeOutput,
  createExternalDeliveryCoordinator,
  createExternalDeliveryStore,
  openExternalDeliveryStore,
} from '../src/external-delivery.mjs';

const token = '123456:synthetic_telegram_token_value_12345';
const directRoute = Object.freeze({
  chatId: '123456789',
  allowedUserId: '987654321',
  scope: 'direct',
  respondTo: 'all',
  conversationId: null,
});

const telegramResponse = result => new Response(JSON.stringify({ ok: true, result }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const methodOf = url => new URL(url).pathname.split('/').at(-1);
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');

async function waitUntil(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function pendingUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function testDelivery(t, route, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-test-delivery-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'));
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    delivery: createExternalDeliveryCoordinator(store, {
      platform: 'telegram', destinationId: route.chatId, sourceUserId: route.allowedUserId,
      ...overrides,
    }),
  };
}

test('Telegram bridge requires an exact-route durable delivery coordinator before it can start', async t => {
  assert.throws(() => createTelegramBridge({
    token,
    route: directRoute,
    async onMessage() { return 'must not send'; },
  }), /delivery is required and must be a Fieldwork external delivery coordinator/);

  assert.throws(() => createTelegramBridge({
    token,
    route: directRoute,
    delivery: { route: { platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId } },
    async onMessage() { return 'must not send'; },
  }), /delivery is required and must be a Fieldwork external delivery coordinator/);

  for (const overrides of [
    { platform: 'discord' },
    { destinationId: '123456780' },
    { sourceUserId: '987654320' },
  ]) {
    const { delivery } = await testDelivery(t, directRoute, overrides);
    assert.throws(() => createTelegramBridge({
      token,
      route: directRoute,
      delivery,
      async onMessage() { return 'must not send'; },
    }), /delivery coordinator route does not match the Telegram route/);
  }
});

test('Telegram long polling skips the backlog, accepts the exact route, and sends a bounded reply', async t => {
  const calls = [];
  const accepted = [];
  let polls = 0;
  const { delivery, store } = await testDelivery(t, directRoute);
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 10,
    clock: () => Date.parse('2030-01-02T03:04:05.000Z'),
    async fetch(url, options) {
      const method = methodOf(url);
      const body = JSON.parse(options.body);
      calls.push({ url, method, body });
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([{
          update_id: 41,
          message: {
            message_id: 17,
            date: 1893553445,
            chat: { id: 123456789 },
            from: { id: 987654321, is_bot: false },
            text: 'hello from synthetic Telegram',
          },
        }]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') return telegramResponse({ message_id: 18, chat: { id: 123456789 } });
      throw new Error(`unexpected method ${method}`);
    },
    async onMessage(message) {
      accepted.push(message);
      return 'Synthetic bridge reply';
    },
  });

  assert.equal(bridge.start().format, TELEGRAM_BRIDGE_STATUS_FORMAT);
  await waitUntil(() => calls.some(call => call.method === 'sendMessage'), 'Telegram reply was not sent');
  await bridge.close();

  const updateCalls = calls.filter(call => call.method === 'getUpdates');
  assert.deepEqual(updateCalls[0].body, { offset: -1, limit: 1, timeout: 0, allowed_updates: ['message'] });
  assert.equal(updateCalls[1].body.offset, 0);
  assert.deepEqual(accepted, [{
    platform: 'telegram',
    destinationId: '123456789',
    sourceUserId: '987654321',
    sourceMessageId: '17',
    at: '2030-01-02T03:04:05.000Z',
    text: 'hello from synthetic Telegram',
    conversationId: null,
  }]);
  const sent = calls.find(call => call.method === 'sendMessage').body;
  assert.deepEqual(sent, {
    chat_id: '123456789',
    text: 'Synthetic bridge reply',
    link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: 17, allow_sending_without_reply: true },
  });
  assert.equal(bridge.snapshot().state, 'paused');
  assert.doesNotMatch(JSON.stringify(bridge.snapshot()), /synthetic_telegram_token_value/);
  assert.ok(calls.every(call => call.url.startsWith('https://api.telegram.org/')));
  assert.ok(calls.every(call => call.url.includes(`/bot${token}/`)));
  const [receipt] = await store.recent(1);
  assert.equal(receipt.action.envelope.action, 'bridge-reply');
  assert.equal(receipt.action.envelope.platform, 'telegram');
  assert.equal(receipt.action.envelope.destinationId, directRoute.chatId);
  assert.equal(receipt.action.envelope.sourceUserId, directRoute.allowedUserId);
  assert.equal(receipt.action.envelope.sourceMessageId, '17');
  assert.equal(receipt.action.preflight.decision, 'allow');
  assert.ok(receipt.attempt);
  assert.equal(receipt.settlement.outcome, 'platform-accepted');
  assert.equal(receipt.settlement.failureKind, null);
  assert.equal(receipt.settlement.acceptedChunks, 1);
  assert.equal(receipt.settlement.totalChunks, 1);
  assert.deepEqual(receipt.settlement.platformMessageIds, ['18']);
  assert.deepEqual(receipt.settlement.acknowledgements, [{
    index: 0,
    chunkSha256: hash('Synthetic bridge reply'),
    destinationId: directRoute.chatId,
    platformMessageId: '18',
  }]);
});

test('Telegram proactive delivery has durable acknowledgement evidence and no platform reply reference', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-proactive-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'telegram-proactive' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  });
  const sent = [];
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    async fetch(url, options) {
      assert.equal(methodOf(url), 'sendMessage');
      sent.push(JSON.parse(options.body));
      return telegramResponse({ message_id: 71, chat: { id: 123456789 } });
    },
    async onMessage() { return 'unused'; },
  });
  const text = 'A saved Telegram check-in.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: {
      kind: 'conversation-reply',
      conversationId: 'conv-00000000-0000-4000-8000-000000000000',
      messageId: 'm000009',
      messageSha256: 'a'.repeat(64),
      contentSha256: hash(text),
    },
  });
  try {
    const result = await bridge.deliverProactive(output);
    assert.equal(Object.isFrozen(result), true);
    assert.match(result.actionId, /^delivery:/);
    assert.deepEqual({ ...result, actionId: '<id>' }, {
      actionId: '<id>',
      decision: 'allow',
      outcome: 'platform-accepted',
    });
    assert.deepEqual(sent, [{
      chat_id: directRoute.chatId,
      text,
      link_preview_options: { is_disabled: true },
    }]);
    const [row] = await store.recent(1);
    assert.equal(row.action.envelope.action, 'bridge-proactive');
    assert.equal(row.action.envelope.sourceMessageId, 'm000009');
    assert.ok(row.attempt);
    assert.equal(row.settlement.outcome, 'platform-accepted');
    assert.deepEqual(row.settlement.acknowledgements, [{
      index: 0,
      chunkSha256: hash(text),
      destinationId: directRoute.chatId,
      platformMessageId: '71',
    }]);
    await assert.rejects(bridge.deliverProactive(output), /source message already has a delivery action|saved reply already has a delivery action/);
    assert.equal(sent.length, 1);
    const refused = await bridge.deliverProactive(createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: '',
      source: {
        ...output.source,
        messageId: 'm000011',
        messageSha256: 'b'.repeat(64),
        contentSha256: hash(''),
      },
    }));
    assert.equal(Object.isFrozen(refused), true);
    assert.deepEqual({ ...refused, actionId: '<id>' }, {
      actionId: '<id>',
      decision: 'refuse',
      outcome: 'not-attempted',
    });
    assert.equal(sent.length, 1);
  } finally {
    await bridge.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Telegram close drains an in-flight proactive delivery and rejects later delivery work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-proactive-close-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), {
    id: 'telegram-proactive-close',
  });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  });
  let releaseFetch = null;
  let fetchStartedResolve;
  const fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
  let sends = 0;
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    async fetch(url) {
      assert.equal(methodOf(url), 'sendMessage');
      sends += 1;
      fetchStartedResolve();
      return new Promise(resolve => {
        releaseFetch = () => resolve(telegramResponse({ message_id: 83, chat: { id: 123456789 } }));
      });
    },
    async onMessage() { return 'unused'; },
  });
  const text = 'Telegram closes after this saved check-in settles.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: {
      kind: 'conversation-reply',
      conversationId: 'conv-00000000-0000-4000-8000-000000000004',
      messageId: 'm000014',
      messageSha256: '5'.repeat(64),
      contentSha256: hash(text),
    },
  });
  let closePromise = null;
  try {
    const deliveryPromise = bridge.deliverProactive(output);
    await fetchStarted;
    let closed = false;
    closePromise = bridge.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    await assert.rejects(bridge.deliverProactive(output), /bridge is closing/);
    assert.equal(sends, 1);

    releaseFetch();
    const result = await deliveryPromise;
    await closePromise;
    assert.equal(closed, true);
    assert.equal(result.outcome, 'platform-accepted');
    const [row] = await store.recent(1);
    assert.equal(row.action.id, result.actionId);
    assert.equal(row.settlement.outcome, 'platform-accepted');
  } finally {
    releaseFetch?.();
    if (closePromise) await closePromise;
    else await bridge.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Telegram proactive delivery returns the exact durable failure outcome', async () => {
  const cases = [
    {
      name: 'partial',
      text: 'p'.repeat(4097),
      expectedOutcome: 'partially-accepted',
      expectedAcceptedChunks: 1,
      async response(send) {
        if (send === 1) return telegramResponse({ message_id: 81, chat: { id: 123456789 } });
        throw new Error('synthetic second-chunk network break');
      },
    },
    {
      name: 'uncertain',
      text: 'uncertain proactive Telegram send',
      expectedOutcome: 'uncertain',
      expectedAcceptedChunks: 0,
      async response() { throw new Error('synthetic first-chunk network break'); },
    },
    {
      name: 'rejected',
      text: 'rejected proactive Telegram send',
      expectedOutcome: 'platform-rejected',
      expectedAcceptedChunks: 0,
      async response() {
        return new Response(JSON.stringify({ ok: false, description: 'synthetic proactive rejection' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const scenario = cases[index];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `fieldwork-telegram-proactive-${scenario.name}-`));
    const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), {
      id: `telegram-proactive-${scenario.name}`,
    });
    const delivery = createExternalDeliveryCoordinator(store, {
      platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
    });
    let sends = 0;
    const bridge = createTelegramBridge({
      token,
      route: directRoute,
      delivery,
      async fetch(url) {
        assert.equal(methodOf(url), 'sendMessage');
        sends += 1;
        return scenario.response(sends);
      },
      async onMessage() { return 'unused'; },
    });
    const output = createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: scenario.text,
      source: {
        kind: 'conversation-reply',
        conversationId: `conv-00000000-0000-4000-8000-00000000000${index}`,
        messageId: `m00001${index}`,
        messageSha256: String(index + 1).repeat(64),
        contentSha256: hash(scenario.text),
      },
    });
    try {
      const result = await bridge.deliverProactive(output);
      assert.equal(Object.isFrozen(result), true);
      assert.match(result.actionId, /^delivery:/);
      assert.deepEqual({ ...result, actionId: '<id>' }, {
        actionId: '<id>',
        decision: 'allow',
        outcome: scenario.expectedOutcome,
      });
      const [row] = await store.recent(1);
      assert.equal(row.action.id, result.actionId);
      assert.equal(row.settlement.outcome, scenario.expectedOutcome);
      assert.equal(row.settlement.acceptedChunks, scenario.expectedAcceptedChunks);
    } finally {
      await bridge.close();
      await store.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('Telegram proactive delivery reports a settlement write failure as may-have-been-sent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-proactive-settlement-closed-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'telegram-proactive-settlement-closed' });
  const reportedErrors = [];
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  }, {
    onError(error) { reportedErrors.push(error); },
  });
  let closePromise = null;
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    async fetch(url) {
      assert.equal(methodOf(url), 'sendMessage');
      closePromise = store.close();
      await closePromise;
      return telegramResponse({ message_id: 82, chat: { id: 123456789 } });
    },
    async onMessage() { return 'unused'; },
  });
  const text = 'Telegram accepts before the settlement store closes.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: {
      kind: 'conversation-reply',
      conversationId: 'conv-00000000-0000-4000-8000-000000000003',
      messageId: 'm000013',
      messageSha256: '4'.repeat(64),
      contentSha256: hash(text),
    },
  });
  try {
    const result = await bridge.deliverProactive(output);
    assert.deepEqual({ ...result, actionId: '<id>' }, {
      actionId: '<id>',
      decision: 'allow',
      outcome: 'may-have-been-sent',
    });
    assert.equal(reportedErrors.length, 1);
    assert.match(reportedErrors[0].message, /after close has begun/);
    const reopened = await openExternalDeliveryStore(file, { expectedId: 'telegram-proactive-settlement-closed' });
    const [row] = await reopened.recent(1);
    assert.equal(row.action.id, result.actionId);
    assert.ok(row.attempt);
    assert.equal(row.settlement, null);
    await reopened.close();
  } finally {
    await bridge.close();
    if (closePromise) await closePromise;
    else await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Telegram proactive delivery preserves a definitely unattempted action when the attempt marker cannot be written', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-proactive-attempt-closed-'));
  const file = path.join(directory, 'delivery.jsonl');
  let store;
  let closePromise = null;
  let closeOnNextClock = false;
  const deliveryClock = () => {
    if (closeOnNextClock) {
      closeOnNextClock = false;
      queueMicrotask(() => { closePromise = store.close(); });
    }
    return Date.parse('2030-01-02T03:04:05.000Z');
  };
  store = await createExternalDeliveryStore(file, {
    id: 'telegram-proactive-attempt-closed',
    clock: deliveryClock,
  });
  const reportedErrors = [];
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  }, {
    onError(error) { reportedErrors.push(error); },
  });
  let sends = 0;
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    async fetch() {
      sends += 1;
      return telegramResponse({ message_id: 83, chat: { id: 123456789 } });
    },
    async onMessage() { return 'unused'; },
  });
  const text = 'This proactive Telegram text must stop before transport.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: {
      kind: 'conversation-reply',
      conversationId: 'conv-00000000-0000-4000-8000-000000000004',
      messageId: 'm000014',
      messageSha256: '5'.repeat(64),
      contentSha256: hash(text),
    },
  });
  closeOnNextClock = true;
  try {
    const result = await bridge.deliverProactive(output);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual({ ...result, actionId: '<id>' }, {
      actionId: '<id>',
      decision: 'allow',
      outcome: 'not-attempted',
    });
    assert.equal(sends, 0);
    assert.equal(reportedErrors.length, 1);
    assert.match(reportedErrors[0].message, /after close has begun/);
    await waitUntil(() => closePromise !== null, 'proactive attempt-marker close was not scheduled');
    await closePromise;
    const reopened = await openExternalDeliveryStore(file, { expectedId: 'telegram-proactive-attempt-closed' });
    const [row] = await reopened.recent(1);
    assert.equal(row.action.id, result.actionId);
    assert.equal(row.settlement, null);
    assert.ok(row.attempt === null || row.attempt?.actionId === result.actionId);
    await reopened.close();
  } finally {
    await bridge.close();
    if (closePromise) await closePromise;
    else await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a group route ignores every source except an explicit mention by the allowed person', async t => {
  const accepted = [];
  const sent = [];
  let polls = 0;
  const route = {
    chatId: '-1001234567890',
    allowedUserId: '987654321',
    scope: 'group',
    respondTo: 'mention',
    conversationId: 'conv-00000000-0000-4000-8000-000000000000',
  };
  const { delivery, store } = await testDelivery(t, route);
  const bridge = createTelegramBridge({
    token,
    route,
    delivery,
    retryMilliseconds: 10,
    async fetch(url, options) {
      const method = methodOf(url);
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([
          { update_id: 1, message: { message_id: 1, chat: { id: -1001234567890 }, from: { id: 111 }, text: '@synthetic_fieldwork_bot wrong person' } },
          { update_id: 2, message: { message_id: 2, chat: { id: -1001234567890 }, from: { id: 987654321 }, text: 'not addressed to the bot' } },
          { update_id: 3, message: { message_id: 3, chat: { id: -1001234567890 }, from: { id: 987654321, is_bot: false }, text: '@synthetic_fieldwork_bot, hello there' } },
          { update_id: 4, message: { message_id: 4, chat: { id: -1001234567890 }, from: { id: 987654321, is_bot: true }, text: '@synthetic_fieldwork_bot bot echo' } },
        ]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') { sent.push(JSON.parse(options.body)); return telegramResponse({ message_id: 9, chat: { id: -1001234567890 } }); }
      throw new Error(`unexpected method ${method}`);
    },
    async onMessage(message) { accepted.push(message); return 'group reply'; },
  });
  bridge.start();
  await waitUntil(() => sent.length === 1, 'group reply was not sent');
  await bridge.close();
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].text, 'hello there');
  assert.equal(accepted[0].sourceMessageId, '3');
  assert.equal(accepted[0].conversationId, 'conv-00000000-0000-4000-8000-000000000000');
  const [receipt] = await store.recent(1);
  assert.equal(receipt.action.envelope.action, 'bridge-reply');
  assert.equal(receipt.action.envelope.platform, 'telegram');
  assert.equal(receipt.action.envelope.destinationId, route.chatId);
  assert.equal(receipt.action.envelope.sourceUserId, route.allowedUserId);
  assert.equal(receipt.action.envelope.sourceMessageId, '3');
  assert.equal(receipt.action.preflight.decision, 'allow');
  assert.ok(receipt.attempt);
  assert.equal(receipt.settlement.outcome, 'platform-accepted');
  assert.equal(receipt.settlement.failureKind, null);
  assert.equal(receipt.settlement.acceptedChunks, 1);
  assert.equal(receipt.settlement.totalChunks, 1);
  assert.deepEqual(receipt.settlement.platformMessageIds, ['9']);
  assert.deepEqual(receipt.settlement.acknowledgements, [{
    index: 0,
    chunkSha256: hash('group reply'),
    destinationId: route.chatId,
    platformMessageId: '9',
  }]);
});

test('an existing webhook is left untouched and credentials are redacted from status errors', async t => {
  const methods = [];
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const { delivery, store } = await testDelivery(t, directRoute);
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    async fetch(url) {
      methods.push(methodOf(url));
      return telegramResponse({ url: 'https://webhook.example.invalid/bot' });
    },
    onMessage: async () => 'unused',
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  bridge.start();
  await failure;
  const snapshot = bridge.snapshot();
  await bridge.close();
  assert.equal(snapshot.state, 'failed');
  assert.match(snapshot.lastError.message, /still has a webhook/);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic_telegram_token_value/);
  assert.deepEqual(methods, ['getWebhookInfo']);
  assert.ok(!methods.includes('deleteWebhook'));
  assert.deepEqual(await store.recent(1), []);
});

test('a durable preflight refusal sends nothing, keeps polling, and a later accepted reply settles once', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-delivery-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), { id: 'telegram-deliveries' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  });
  let polls = 0;
  let replies = 0;
  let markerObservedBeforeSend = false;
  const sent = [];
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 10,
    async fetch(url, options) {
      const method = methodOf(url);
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([
          { update_id: 51, message: { message_id: 21, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: 'refuse this reply' } },
          { update_id: 52, message: { message_id: 22, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: 'send this reply' } },
        ]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') {
        const [row] = await store.recent(1);
        markerObservedBeforeSend = Boolean(row?.attempt);
        sent.push(JSON.parse(options.body));
        return telegramResponse({ message_id: 23, chat: { id: 123456789 } });
      }
      throw new Error(`unexpected method ${method}`);
    },
    async onMessage() {
      replies += 1;
      return replies === 1 ? '' : 'Accepted after refusal.';
    },
  });
  try {
    bridge.start();
    await waitUntil(() => sent.length === 1, 'accepted reply was not sent');
    assert.equal(bridge.snapshot().state, 'connected');
    assert.equal(markerObservedBeforeSend, true);
    assert.equal(sent[0].text, 'Accepted after refusal.');
    const persisted = await fs.readFile(path.join(directory, 'delivery.jsonl'), 'utf8');
    assert.equal((persisted.match(/external_delivery_preflighted/g) || []).length, 2);
    assert.equal((persisted.match(/external_delivery_attempted/g) || []).length, 1);
    assert.match(persisted, /"decision":"refuse"/);
    assert.match(persisted, /"outcome":"platform-accepted"/);
  } finally {
    await bridge.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a later Telegram wrong-destination acknowledgement keeps only the earlier verified chunk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-partial-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), { id: 'telegram-partial' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  });
  let polls = 0;
  let sends = 0;
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    async fetch(url, options) {
      const method = methodOf(url);
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([{
          update_id: 61,
          message: { message_id: 31, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: 'make two chunks' },
        }]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') {
        sends += 1;
        if (sends === 1) return telegramResponse({ message_id: 32, chat: { id: 123456789 } });
        return telegramResponse({ message_id: 33, chat: { id: 123456788 } });
      }
      throw new Error(`unexpected method ${method}`);
    },
    onMessage: async () => 'x'.repeat(4097),
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    assert.equal(sends, 2);
    const [row] = await store.recent(1);
    assert.equal(row.settlement.outcome, 'partially-accepted');
    assert.equal(row.settlement.failureKind, 'invalid-acknowledgement');
    assert.equal(row.settlement.acceptedChunks, 1);
    assert.deepEqual(row.settlement.platformMessageIds, ['32']);
    assert.deepEqual(row.settlement.acknowledgements, [{
      index: 0,
      chunkSha256: row.action.envelope.content.chunks[0].sha256,
      destinationId: directRoute.chatId,
      platformMessageId: '32',
    }]);
    const persisted = await fs.readFile(path.join(directory, 'delivery.jsonl'), 'utf8');
    assert.match(persisted, /external_delivery_attempted/);
    assert.match(persisted, /"outcome":"partially-accepted"/);
    assert.match(persisted, /"platformMessageIds":\["32"\]/);
  } finally {
    await bridge.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a repeated Telegram acknowledgement id keeps only the first verified chunk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-duplicate-ack-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), { id: 'telegram-duplicate-ack' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  });
  let polls = 0;
  let sends = 0;
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    async fetch(url, options) {
      const method = methodOf(url);
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([{
          update_id: 63,
          message: { message_id: 34, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: 'repeat the acknowledgement id' },
        }]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') {
        sends += 1;
        return telegramResponse({ message_id: 35, chat: { id: 123456789 } });
      }
      throw new Error(`unexpected method ${method}`);
    },
    onMessage: async () => 'x'.repeat(4097),
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    assert.equal(sends, 2);
    const [row] = await store.recent(1);
    assert.equal(row.settlement.outcome, 'partially-accepted');
    assert.equal(row.settlement.failureKind, 'invalid-acknowledgement');
    assert.equal(row.settlement.acceptedChunks, 1);
    assert.deepEqual(row.settlement.platformMessageIds, ['35']);
    assert.deepEqual(row.settlement.acknowledgements, [{
      index: 0,
      chunkSha256: row.action.envelope.content.chunks[0].sha256,
      destinationId: directRoute.chatId,
      platformMessageId: '35',
    }]);
  } finally {
    await bridge.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a Telegram settlement write failure after acceptance is reported without retry or false settlement', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-settlement-closed-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'telegram-settlement-closed' });
  const reportedErrors = [];
  let reported;
  const report = new Promise(resolve => { reported = resolve; });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  }, {
    onError(error) { reportedErrors.push(error); reported(); },
  });
  let polls = 0;
  let sends = 0;
  let closePromise = null;
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    async fetch(url, options) {
      const method = methodOf(url);
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([{
          update_id: 62,
          message: { message_id: 32, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: 'accept before settlement closes' },
        }]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') {
        sends += 1;
        closePromise = store.close();
        await closePromise;
        return telegramResponse({ message_id: 33, chat: { id: 123456789 } });
      }
      throw new Error(`unexpected method ${method}`);
    },
    onMessage: async () => 'The platform accepts this exactly once.',
  });
  try {
    bridge.start();
    await report;
    assert.equal(sends, 1);
    assert.equal(reportedErrors.length, 1);
    assert.match(reportedErrors[0].message, /after close has begun/);
    assert.equal(bridge.snapshot().state, 'connected');
    await bridge.close();
    const reopened = await openExternalDeliveryStore(file, { expectedId: 'telegram-settlement-closed' });
    const [row] = await reopened.recent(1);
    assert.ok(row.attempt);
    assert.equal(row.settlement, null);
    await reopened.close();
  } finally {
    await bridge.close();
    if (closePromise) await closePromise;
    else await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an explicit Telegram rejection is durably distinct from an uncertain send', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-rejected-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'telegram-rejected' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  });
  let polls = 0;
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    async fetch(url, options) {
      const method = methodOf(url);
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([{
          update_id: 81,
          message: { message_id: 51, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: 'reject this send' },
        }]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') {
        return new Response(JSON.stringify({ ok: false, description: 'synthetic platform rejection' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected method ${method}`);
    },
    onMessage: async () => 'A rejected synthetic reply.',
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    await bridge.close();
    await store.close();
    const reopened = await openExternalDeliveryStore(file, { expectedId: 'telegram-rejected' });
    const [row] = await reopened.recent(1);
    assert.ok(row.attempt);
    assert.equal(row.settlement.outcome, 'platform-rejected');
    assert.equal(row.settlement.failureKind, 'platform-rejected');
    assert.equal(row.settlement.acceptedChunks, 0);
    await reopened.close();
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /synthetic platform rejection/);
  } finally {
    await bridge.close();
    try { await store.close(); } catch { /* It may already be closed after the assertion path. */ }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Telegram keeps transport ambiguity and an invalid acknowledgement distinct', async () => {
  const cases = [
    ['transport-uncertain', async () => { throw new Error('synthetic network break'); }],
    ['invalid-acknowledgement', async () => telegramResponse({ accepted_without_message_id: true })],
    ['invalid-acknowledgement', async () => telegramResponse({ message_id: 71 })],
    ['invalid-acknowledgement', async () => telegramResponse({ message_id: 72, chat: { id: 123456788 } })],
    ['invalid-acknowledgement', async () => telegramResponse({ message_id: 73, chat: { id: Number.MAX_SAFE_INTEGER + 1 } })],
  ];
  for (let index = 0; index < cases.length; index++) {
    const [expectedKind, sendResult] = cases[index];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `fieldwork-telegram-${expectedKind}-`));
    const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), { id: `telegram-ambiguity-${index}` });
    const delivery = createExternalDeliveryCoordinator(store, {
      platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
    });
    let polls = 0;
    let sends = 0;
    let failed;
    const failure = new Promise(resolve => { failed = resolve; });
    const bridge = createTelegramBridge({
      token,
      route: directRoute,
      delivery,
      retryMilliseconds: 60_000,
      async fetch(url, options) {
        const method = methodOf(url);
        if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
        if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
        if (method === 'getUpdates') {
          polls += 1;
          if (polls === 1) return telegramResponse([]);
          if (polls === 2) return telegramResponse([{
            update_id: 90 + index,
            message: { message_id: 60 + index, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: expectedKind },
          }]);
          return pendingUntilAbort(options.signal);
        }
        if (method === 'sendMessage') { sends += 1; return sendResult(); }
        throw new Error(`unexpected method ${method}`);
      },
      onMessage: async () => 'An ambiguously delivered synthetic reply.',
      onStatus(status) { if (status.state === 'failed') failed(); },
    });
    try {
      bridge.start();
      await failure;
      const [row] = await store.recent(1);
      assert.ok(row.attempt);
      assert.equal(row.settlement.outcome, 'uncertain');
      assert.equal(row.settlement.failureKind, expectedKind);
      assert.equal(row.settlement.acceptedChunks, 0);
      assert.deepEqual(row.settlement.platformMessageIds, []);
      assert.deepEqual(row.settlement.acknowledgements, []);
      assert.equal(sends, 1);
    } finally {
      await bridge.close();
      await store.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('an attempt-marker write failure fails closed after prepare and before Telegram sees a send request', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-attempt-closed-'));
  const file = path.join(directory, 'delivery.jsonl');
  let store;
  let closePromise = null;
  let closeOnNextClock = false;
  const clock = () => {
    if (closeOnNextClock) {
      closeOnNextClock = false;
      queueMicrotask(() => { closePromise = store.close(); });
    }
    return Date.parse('2030-01-02T03:04:05.000Z');
  };
  store = await createExternalDeliveryStore(file, { id: 'telegram-attempt-closed', clock });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  });
  closeOnNextClock = true;
  let polls = 0;
  let sends = 0;
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    async fetch(url, options) {
      const method = methodOf(url);
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([{
          update_id: 72,
          message: { message_id: 42, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: 'prepare, then fail the marker' },
        }]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') { sends += 1; return telegramResponse({ message_id: 43, chat: { id: 123456789 } }); }
      throw new Error(`unexpected method ${method}`);
    },
    onMessage: async () => 'Never cross the attempt edge.',
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    assert.equal(sends, 0);
    await waitUntil(() => closePromise !== null, 'attempt-marker close was not scheduled');
    await closePromise;
    const persisted = await fs.readFile(file, 'utf8');
    assert.match(persisted, /external_delivery_preflighted/);
    assert.doesNotMatch(persisted, /external_delivery_attempted/);
    assert.doesNotMatch(persisted, /external_delivery_settled/);
  } finally {
    await bridge.close();
    if (closePromise) await closePromise;
    else await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a preflight receipt write failure fails closed before Telegram sees a send request', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-telegram-closed-store-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), { id: 'telegram-closed' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: directRoute.chatId, sourceUserId: directRoute.allowedUserId,
  });
  await store.close();
  let polls = 0;
  let sends = 0;
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createTelegramBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    async fetch(url, options) {
      const method = methodOf(url);
      if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
      if (method === 'getMe') return telegramResponse({ id: 112233, username: 'synthetic_fieldwork_bot' });
      if (method === 'getUpdates') {
        polls += 1;
        if (polls === 1) return telegramResponse([]);
        if (polls === 2) return telegramResponse([{
          update_id: 71,
          message: { message_id: 41, chat: { id: 123456789 }, from: { id: 987654321, is_bot: false }, text: 'must fail closed' },
        }]);
        return pendingUntilAbort(options.signal);
      }
      if (method === 'sendMessage') { sends += 1; return telegramResponse({ message_id: 42, chat: { id: 123456789 } }); }
      throw new Error(`unexpected method ${method}`);
    },
    onMessage: async () => 'Never send this.',
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    assert.equal(sends, 0);
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
