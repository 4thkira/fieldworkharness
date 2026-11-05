import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createDiscordBridge,
  DISCORD_BRIDGE_INTENTS,
  DISCORD_BRIDGE_STATUS_FORMAT,
} from '../src/discord-bridge.mjs';
import {
  BRIDGE_OUTPUT_FORMAT,
  createBridgeOutput,
  createExternalDeliveryCoordinator,
  createExternalDeliveryStore,
  openExternalDeliveryStore,
} from '../src/external-delivery.mjs';

const token = 'synthetic.discord.token.value';
const directRoute = Object.freeze({
  channelId: '123456789012345678',
  guildId: null,
  allowedUserId: '987654321098765432',
  scope: 'direct',
  respondTo: 'all',
  conversationId: null,
});

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});

async function waitUntil(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

class SyntheticWebSocket {
  constructor(url, sent) {
    this.url = url;
    this.sent = sent;
    this.readyState = 1;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(value) {
    const payload = JSON.parse(value);
    this.sent.push(payload);
    if (payload.op === 1) queueMicrotask(() => this.message({ op: 11, d: null }));
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code });
  }

  message(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function gatewayFactory(sequence, sent, sockets) {
  return url => {
    const socket = new SyntheticWebSocket(url, sent);
    sockets.push(socket);
    queueMicrotask(() => {
      socket.message({ op: 10, d: { heartbeat_interval: 45_000 } });
      for (const payload of sequence) socket.message(payload);
    });
    return socket;
  };
}

async function testDelivery(t, route, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-test-delivery-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'));
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    delivery: createExternalDeliveryCoordinator(store, {
      platform: 'discord', destinationId: route.channelId, sourceUserId: route.allowedUserId,
      ...overrides,
    }),
  };
}

test('Discord bridge requires an exact-route durable delivery coordinator before it can start', async t => {
  assert.throws(() => createDiscordBridge({
    token,
    route: directRoute,
    async onMessage() { return 'must not send'; },
  }), /delivery is required and must be a Fieldwork external delivery coordinator/);

  assert.throws(() => createDiscordBridge({
    token,
    route: directRoute,
    delivery: { route: { platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId } },
    async onMessage() { return 'must not send'; },
  }), /delivery is required and must be a Fieldwork external delivery coordinator/);

  for (const overrides of [
    { platform: 'telegram' },
    { destinationId: '123456789012345679' },
    { sourceUserId: '987654321098765431' },
  ]) {
    const { delivery } = await testDelivery(t, directRoute, overrides);
    assert.throws(() => createDiscordBridge({
      token,
      route: directRoute,
      delivery,
      async onMessage() { return 'must not send'; },
    }), /delivery coordinator route does not match the Discord route/);
  }
});

test('Discord Gateway input accepts one exact direct route and replies without mention expansion', async t => {
  const restCalls = [];
  const gatewaySent = [];
  const sockets = [];
  const accepted = [];
  const { delivery, store } = await testDelivery(t, directRoute);
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 10,
    random: () => 0.5,
    clock: () => Date.parse('2030-01-02T03:04:05.000Z'),
    createWebSocket: gatewayFactory([
      { op: 0, t: 'READY', s: 1, d: { user: { id: '111122223333444455', username: 'Synthetic Fieldwork' } } },
      {
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 2,
        d: {
          id: '222233334444555566',
          channel_id: directRoute.channelId,
          timestamp: '2030-01-02T03:04:05.000+00:00',
          author: { id: directRoute.allowedUserId },
          content: 'hello from synthetic Discord',
          mentions: [],
        },
      },
    ], gatewaySent, sockets),
    async fetch(url, options) {
      restCalls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg' });
      if (url.endsWith(`/channels/${directRoute.channelId}/messages`)) {
        return jsonResponse({ id: '333344445555666677', channel_id: directRoute.channelId });
      }
      throw new Error(`unexpected Discord API URL ${url}`);
    },
    async onMessage(message) {
      accepted.push(message);
      return 'Synthetic bridge reply @everyone';
    },
  });

  assert.equal(bridge.start().format, DISCORD_BRIDGE_STATUS_FORMAT);
  await waitUntil(() => restCalls.some(call => call.options.method === 'POST'), 'Discord reply was not sent');
  await bridge.close();

  assert.equal(sockets[0].url, 'wss://gateway.discord.gg/?v=10&encoding=json');
  assert.deepEqual(gatewaySent.find(payload => payload.op === 2), {
    op: 2,
    d: {
      token,
      intents: DISCORD_BRIDGE_INTENTS,
      properties: { os: process.platform, browser: 'fieldwork', device: 'fieldwork' },
    },
  });
  assert.equal(DISCORD_BRIDGE_INTENTS, 37376);
  assert.deepEqual(accepted, [{
    platform: 'discord',
    destinationId: directRoute.channelId,
    sourceUserId: directRoute.allowedUserId,
    sourceMessageId: '222233334444555566',
    at: '2030-01-02T03:04:05.000Z',
    text: 'hello from synthetic Discord',
    conversationId: null,
  }]);
  const sent = restCalls.find(call => call.options.method === 'POST');
  assert.equal(sent.url, `https://discord.com/api/v10/channels/${directRoute.channelId}/messages`);
  assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.options.headers.authorization, `Bot ${token}`);
  assert.deepEqual(sent.body, {
    content: 'Synthetic bridge reply @everyone',
    allowed_mentions: { parse: [], replied_user: false },
    message_reference: {
      message_id: '222233334444555566',
      channel_id: directRoute.channelId,
      fail_if_not_exists: false,
    },
  });
  assert.equal(bridge.snapshot().state, 'paused');
  assert.doesNotMatch(JSON.stringify(bridge.snapshot()), /synthetic\.discord\.token/);
  const [receipt] = await store.recent(1);
  assert.equal(receipt.action.envelope.action, 'bridge-reply');
  assert.equal(receipt.action.envelope.platform, 'discord');
  assert.equal(receipt.action.envelope.destinationId, directRoute.channelId);
  assert.equal(receipt.action.envelope.sourceUserId, directRoute.allowedUserId);
  assert.equal(receipt.action.envelope.sourceMessageId, '222233334444555566');
  assert.equal(receipt.action.preflight.decision, 'allow');
  assert.ok(receipt.attempt);
  assert.equal(receipt.settlement.outcome, 'platform-accepted');
  assert.equal(receipt.settlement.failureKind, null);
  assert.equal(receipt.settlement.acceptedChunks, 1);
  assert.equal(receipt.settlement.totalChunks, 1);
  assert.deepEqual(receipt.settlement.platformMessageIds, ['333344445555666677']);
  assert.deepEqual(receipt.settlement.acknowledgements, [{
    index: 0,
    chunkSha256: createHash('sha256').update('Synthetic bridge reply @everyone', 'utf8').digest('hex'),
    destinationId: directRoute.channelId,
    platformMessageId: '333344445555666677',
  }]);
});

test('Discord proactive delivery has durable acknowledgement evidence and no platform message reference', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-proactive-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'discord-proactive' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  });
  const restCalls = [];
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    createWebSocket() { throw new Error('proactive delivery must not open the Gateway'); },
    async fetch(url, options) {
      restCalls.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ id: '333344445555666677', channel_id: directRoute.channelId });
    },
    async onMessage() { return 'unused'; },
  });
  const text = 'A saved Discord check-in @everyone.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: {
      kind: 'conversation-reply',
      conversationId: 'conv-00000000-0000-4000-8000-000000000000',
      messageId: 'm000010',
      messageSha256: 'a'.repeat(64),
      contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
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
    assert.equal(restCalls.length, 1);
    assert.equal(restCalls[0].url, `https://discord.com/api/v10/channels/${directRoute.channelId}/messages`);
    assert.deepEqual(restCalls[0].body, {
      content: text,
      allowed_mentions: { parse: [], replied_user: false },
    });
    const [row] = await store.recent(1);
    assert.equal(row.action.envelope.action, 'bridge-proactive');
    assert.equal(row.action.envelope.sourceMessageId, 'm000010');
    assert.ok(row.attempt);
    assert.equal(row.settlement.outcome, 'platform-accepted');
    assert.deepEqual(row.settlement.acknowledgements, [{
      index: 0,
      chunkSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      destinationId: directRoute.channelId,
      platformMessageId: '333344445555666677',
    }]);
    await assert.rejects(bridge.deliverProactive(output), /source message already has a delivery action|saved reply already has a delivery action/);
    assert.equal(restCalls.length, 1);
  } finally {
    await bridge.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Discord close drains an in-flight proactive delivery and rejects later delivery work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-proactive-close-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), {
    id: 'discord-proactive-close',
  });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  });
  let releaseFetch = null;
  let fetchStartedResolve;
  const fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
  let posts = 0;
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    createWebSocket() { throw new Error('proactive delivery must not open the Gateway'); },
    async fetch(url) {
      assert.equal(url, `https://discord.com/api/v10/channels/${directRoute.channelId}/messages`);
      posts += 1;
      fetchStartedResolve();
      return new Promise(resolve => {
        releaseFetch = () => resolve(jsonResponse({
          id: '333344445555666683',
          channel_id: directRoute.channelId,
        }));
      });
    },
    async onMessage() { return 'unused'; },
  });
  const text = 'Discord closes after this saved check-in settles.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: {
      kind: 'conversation-reply',
      conversationId: 'conv-00000000-0000-4000-8000-000000000004',
      messageId: 'm000024',
      messageSha256: '9'.repeat(64),
      contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
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
    assert.equal(posts, 1);

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

test('Discord proactive delivery returns the exact durable failure outcome', async () => {
  const cases = [
    {
      name: 'partial',
      text: 'p'.repeat(2001),
      expectedOutcome: 'partially-accepted',
      expectedAcceptedChunks: 1,
      async response(post) {
        if (post === 1) return jsonResponse({ id: '333344445555666681', channel_id: directRoute.channelId });
        throw new Error('synthetic second-chunk network break');
      },
    },
    {
      name: 'uncertain',
      text: 'uncertain proactive Discord send',
      expectedOutcome: 'uncertain',
      expectedAcceptedChunks: 0,
      async response() { throw new Error('synthetic first-chunk network break'); },
    },
    {
      name: 'rejected',
      text: 'rejected proactive Discord send',
      expectedOutcome: 'platform-rejected',
      expectedAcceptedChunks: 0,
      async response() { return jsonResponse({ message: 'synthetic proactive rejection' }, 400); },
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const scenario = cases[index];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `fieldwork-discord-proactive-${scenario.name}-`));
    const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), {
      id: `discord-proactive-${scenario.name}`,
    });
    const delivery = createExternalDeliveryCoordinator(store, {
      platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
    });
    let posts = 0;
    const bridge = createDiscordBridge({
      token,
      route: directRoute,
      delivery,
      createWebSocket() { throw new Error('proactive delivery must not open the Gateway'); },
      async fetch() {
        posts += 1;
        return scenario.response(posts);
      },
      async onMessage() { return 'unused'; },
    });
    const output = createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: scenario.text,
      source: {
        kind: 'conversation-reply',
        conversationId: `conv-00000000-0000-4000-8000-00000000000${index}`,
        messageId: `m00002${index}`,
        messageSha256: String(index + 5).repeat(64),
        contentSha256: createHash('sha256').update(scenario.text, 'utf8').digest('hex'),
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

test('Discord proactive delivery reports a settlement write failure as may-have-been-sent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-proactive-settlement-closed-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'discord-proactive-settlement-closed' });
  const reportedErrors = [];
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  }, {
    onError(error) { reportedErrors.push(error); },
  });
  let closePromise = null;
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    createWebSocket() { throw new Error('proactive delivery must not open the Gateway'); },
    async fetch() {
      closePromise = store.close();
      await closePromise;
      return jsonResponse({ id: '333344445555666682', channel_id: directRoute.channelId });
    },
    async onMessage() { return 'unused'; },
  });
  const text = 'Discord accepts before the settlement store closes.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: {
      kind: 'conversation-reply',
      conversationId: 'conv-00000000-0000-4000-8000-000000000003',
      messageId: 'm000023',
      messageSha256: '8'.repeat(64),
      contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
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
    const reopened = await openExternalDeliveryStore(file, { expectedId: 'discord-proactive-settlement-closed' });
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

test('Discord proactive delivery preserves a definitely unattempted action when the attempt marker cannot be written', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-proactive-attempt-closed-'));
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
    id: 'discord-proactive-attempt-closed',
    clock: deliveryClock,
  });
  const reportedErrors = [];
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  }, {
    onError(error) { reportedErrors.push(error); },
  });
  let posts = 0;
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    createWebSocket() { throw new Error('proactive delivery must not open the Gateway'); },
    async fetch() {
      posts += 1;
      return jsonResponse({ id: '333344445555666688', channel_id: directRoute.channelId });
    },
    async onMessage() { return 'unused'; },
  });
  const text = 'This proactive Discord text must stop before transport.';
  const output = createBridgeOutput({
    format: BRIDGE_OUTPUT_FORMAT,
    text,
    source: {
      kind: 'conversation-reply',
      conversationId: 'conv-00000000-0000-4000-8000-000000000004',
      messageId: 'm000014',
      messageSha256: '5'.repeat(64),
      contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
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
    assert.equal(posts, 0);
    assert.equal(reportedErrors.length, 1);
    assert.match(reportedErrors[0].message, /after close has begun/);
    await waitUntil(() => closePromise !== null, 'proactive attempt-marker close was not scheduled');
    await closePromise;
    const reopened = await openExternalDeliveryStore(file, { expectedId: 'discord-proactive-attempt-closed' });
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

test('a guild route ignores every source except a literal bot mention by the allowed person', async t => {
  const route = {
    channelId: '123456789012345678',
    guildId: '444455556666777788',
    allowedUserId: '987654321098765432',
    scope: 'guild',
    respondTo: 'mention',
    conversationId: 'conv-00000000-0000-4000-8000-000000000000',
  };
  const botId = '111122223333444455';
  const accepted = [];
  const replies = [];
  const messages = [
    { id: '100000000000000001', channel_id: route.channelId, guild_id: route.guildId, author: { id: '100000000000000099', bot: false }, content: `<@${botId}> wrong person`, mentions: [{ id: botId }] },
    { id: '100000000000000002', channel_id: route.channelId, guild_id: route.guildId, author: { id: route.allowedUserId, bot: false }, content: 'not addressed', mentions: [] },
    { id: '100000000000000003', channel_id: route.channelId, guild_id: route.guildId, author: { id: route.allowedUserId, bot: false }, content: 'reply metadata only', mentions: [{ id: botId }] },
    { id: '100000000000000004', channel_id: route.channelId, guild_id: route.guildId, author: { id: route.allowedUserId, bot: true }, content: `<@${botId}> bot echo`, mentions: [{ id: botId }] },
    { id: '100000000000000006', channel_id: route.channelId, guild_id: route.guildId, webhook_id: '200000000000000001', author: { id: route.allowedUserId }, content: `<@${botId}> webhook echo`, mentions: [{ id: botId }] },
    { id: '100000000000000005', channel_id: route.channelId, guild_id: route.guildId, author: { id: route.allowedUserId, bot: false }, content: `<@!${botId}> hello there`, mentions: [{ id: botId }] },
    { id: '100000000000000005', channel_id: route.channelId, guild_id: route.guildId, author: { id: route.allowedUserId, bot: false }, content: `<@!${botId}> duplicate`, mentions: [{ id: botId }] },
  ];
  const { delivery, store } = await testDelivery(t, route);
  const bridge = createDiscordBridge({
    token,
    route,
    delivery,
    retryMilliseconds: 10,
    random: () => 0.5,
    createWebSocket: gatewayFactory([
      { op: 0, t: 'READY', s: 1, d: { user: { id: botId, username: 'Synthetic Fieldwork' } } },
      ...messages.map((message, index) => ({ op: 0, t: 'MESSAGE_CREATE', s: index + 2, d: message })),
    ], [], []),
    async fetch(url, options) {
      if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg/' });
      replies.push(JSON.parse(options.body));
      return jsonResponse({ id: '333344445555666677', channel_id: route.channelId });
    },
    async onMessage(message) { accepted.push(message); return 'guild reply'; },
  });

  bridge.start();
  await waitUntil(() => replies.length === 1, 'guild reply was not sent');
  await bridge.close();
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].text, 'hello there');
  assert.equal(accepted[0].sourceMessageId, '100000000000000005');
  assert.equal(accepted[0].conversationId, route.conversationId);
  const [receipt] = await store.recent(1);
  assert.equal(receipt.action.envelope.action, 'bridge-reply');
  assert.equal(receipt.action.envelope.platform, 'discord');
  assert.equal(receipt.action.envelope.destinationId, route.channelId);
  assert.equal(receipt.action.envelope.sourceUserId, route.allowedUserId);
  assert.equal(receipt.action.envelope.sourceMessageId, '100000000000000005');
  assert.equal(receipt.action.preflight.decision, 'allow');
  assert.ok(receipt.attempt);
  assert.equal(receipt.settlement.outcome, 'platform-accepted');
  assert.equal(receipt.settlement.failureKind, null);
  assert.equal(receipt.settlement.acceptedChunks, 1);
  assert.equal(receipt.settlement.totalChunks, 1);
  assert.deepEqual(receipt.settlement.platformMessageIds, ['333344445555666677']);
  assert.deepEqual(receipt.settlement.acknowledgements, [{
    index: 0,
    chunkSha256: createHash('sha256').update('guild reply', 'utf8').digest('hex'),
    destinationId: route.channelId,
    platformMessageId: '333344445555666677',
  }]);
});

test('unexpected Gateway origins are refused and Discord credentials stay out of status errors', async t => {
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  let sockets = 0;
  const { delivery, store } = await testDelivery(t, directRoute);
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    async fetch() { return jsonResponse({ url: `wss://example.invalid/${token}` }); },
    createWebSocket() { sockets++; throw new Error('must not open'); },
    onMessage: async () => 'unused',
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  bridge.start();
  await failure;
  const snapshot = bridge.snapshot();
  await bridge.close();
  assert.equal(snapshot.state, 'failed');
  assert.match(snapshot.lastError.message, /unexpected Gateway origin/);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic\.discord\.token/);
  assert.equal(sockets, 0);
  assert.deepEqual(await store.recent(1), []);
});

test('Discord bridge validates route shape, token bounds, and injected interfaces', () => {
  assert.throws(() => createDiscordBridge({
    token: 'has whitespace', route: directRoute, onMessage: async () => 'reply',
  }), /without whitespace/);
  assert.throws(() => createDiscordBridge({
    token, route: { ...directRoute, guildId: '123' }, onMessage: async () => 'reply',
  }), /guildId must be null/);
  assert.throws(() => createDiscordBridge({
    token, route: { ...directRoute, surprise: true }, onMessage: async () => 'reply',
  }), /unknown fields/);
  assert.throws(() => createDiscordBridge({
    token, route: directRoute, onMessage: async () => 'reply', createWebSocket: 42,
  }), /createWebSocket must be a function/);
});

test('Discord preflight refusal is a normal no-send outcome and the next message remains deliverable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-delivery-'));
  const store = await createExternalDeliveryStore(path.join(directory, 'delivery.jsonl'), { id: 'discord-deliveries' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  });
  const restCalls = [];
  let markerObservedBeforeSend = false;
  let replies = 0;
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 10,
    random: () => 0.5,
    createWebSocket: gatewayFactory([
      { op: 0, t: 'READY', s: 1, d: { user: { id: '111122223333444455', username: 'Synthetic Fieldwork' } } },
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: {
        id: '222233334444555561', channel_id: directRoute.channelId,
        author: { id: directRoute.allowedUserId }, content: 'refuse', mentions: [],
      } },
      { op: 0, t: 'MESSAGE_CREATE', s: 3, d: {
        id: '222233334444555562', channel_id: directRoute.channelId,
        author: { id: directRoute.allowedUserId }, content: 'accept', mentions: [],
      } },
    ], [], []),
    async fetch(url, options) {
      if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg/' });
      const [row] = await store.recent(1);
      markerObservedBeforeSend = Boolean(row?.attempt);
      restCalls.push(JSON.parse(options.body));
      return jsonResponse({ id: '333344445555666677', channel_id: directRoute.channelId });
    },
    async onMessage() {
      replies += 1;
      return replies === 1 ? '' : 'Accepted after refusal.';
    },
  });
  try {
    bridge.start();
    await waitUntil(() => restCalls.length === 1, 'accepted Discord reply was not sent');
    await waitUntil(async () => {
      const [row] = await store.recent(1);
      return row?.settlement?.outcome === 'platform-accepted';
    }, 'accepted Discord reply was not durably settled');
    assert.equal(bridge.snapshot().state, 'connected');
    assert.equal(markerObservedBeforeSend, true);
    assert.equal(restCalls[0].content, 'Accepted after refusal.');
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

test('Discord keeps a wrong or missing returned channel uncertain without retrying', async t => {
  const cases = [
    { name: 'missing channel', response: { id: '333344445555666681' } },
    {
      name: 'wrong channel',
      response: { id: '333344445555666682', channel_id: '123456789012345679' },
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-invalid-ack-'));
      const file = path.join(directory, 'delivery.jsonl');
      const store = await createExternalDeliveryStore(file, { id: `discord-invalid-ack-${index}` });
      const delivery = createExternalDeliveryCoordinator(store, {
        platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
      });
      let posts = 0;
      let failed;
      const failure = new Promise(resolve => { failed = resolve; });
      const bridge = createDiscordBridge({
        token,
        route: directRoute,
        delivery,
        retryMilliseconds: 60_000,
        random: () => 0.5,
        createWebSocket: gatewayFactory([
          { op: 0, t: 'READY', s: 1, d: { user: { id: '111122223333444455', username: 'Synthetic Fieldwork' } } },
          { op: 0, t: 'MESSAGE_CREATE', s: 2, d: {
            id: `22223333444455558${index}`, channel_id: directRoute.channelId,
            author: { id: directRoute.allowedUserId }, content: 'check returned channel', mentions: [],
          } },
        ], [], []),
        async fetch(url) {
          if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg/' });
          posts += 1;
          return jsonResponse(scenario.response);
        },
        onMessage: async () => 'One synthetic acknowledgement check.',
        onStatus(status) { if (status.state === 'failed') failed(); },
      });
      try {
        bridge.start();
        await failure;
        assert.equal(posts, 1);
        assert.match(bridge.snapshot().lastError.message, /expected channel/);
        const [row] = await store.recent(1);
        assert.equal(row.settlement.outcome, 'uncertain');
        assert.equal(row.settlement.failureKind, 'invalid-acknowledgement');
        assert.equal(row.settlement.acceptedChunks, 0);
        assert.deepEqual(row.settlement.platformMessageIds, []);
        assert.deepEqual(row.settlement.acknowledgements, []);
      } finally {
        await bridge.close();
        await store.close();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('a later wrong Discord channel keeps only the earlier destination-bound chunk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-partial-ack-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'discord-partial-ack' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  });
  const reply = 'x'.repeat(2001);
  let posts = 0;
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    random: () => 0.5,
    createWebSocket: gatewayFactory([
      { op: 0, t: 'READY', s: 1, d: { user: { id: '111122223333444455', username: 'Synthetic Fieldwork' } } },
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: {
        id: '222233334444555583', channel_id: directRoute.channelId,
        author: { id: directRoute.allowedUserId }, content: 'send two parts', mentions: [],
      } },
    ], [], []),
    async fetch(url) {
      if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg/' });
      posts += 1;
      return posts === 1
        ? jsonResponse({ id: '333344445555666683', channel_id: directRoute.channelId })
        : jsonResponse({ id: '333344445555666684', channel_id: '123456789012345679' });
    },
    onMessage: async () => reply,
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    assert.equal(posts, 2);
    const [row] = await store.recent(1);
    assert.equal(row.settlement.outcome, 'partially-accepted');
    assert.equal(row.settlement.failureKind, 'invalid-acknowledgement');
    assert.equal(row.settlement.acceptedChunks, 1);
    assert.equal(row.settlement.totalChunks, 2);
    assert.deepEqual(row.settlement.platformMessageIds, ['333344445555666683']);
    assert.deepEqual(row.settlement.acknowledgements, [{
      index: 0,
      chunkSha256: createHash('sha256').update('x'.repeat(2000), 'utf8').digest('hex'),
      destinationId: directRoute.channelId,
      platformMessageId: '333344445555666683',
    }]);
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /xxxxxxxxxxxxxxxx/);
  } finally {
    await bridge.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a repeated Discord message id keeps only the first destination-bound chunk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-repeated-ack-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'discord-repeated-ack' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  });
  const repeatedMessageId = '333344445555666685';
  let posts = 0;
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    random: () => 0.5,
    createWebSocket: gatewayFactory([
      { op: 0, t: 'READY', s: 1, d: { user: { id: '111122223333444455', username: 'Synthetic Fieldwork' } } },
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: {
        id: '222233334444555584', channel_id: directRoute.channelId,
        author: { id: directRoute.allowedUserId }, content: 'repeat an acknowledgement id', mentions: [],
      } },
    ], [], []),
    async fetch(url) {
      if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg/' });
      posts += 1;
      return jsonResponse({ id: repeatedMessageId, channel_id: directRoute.channelId });
    },
    onMessage: async () => 'y'.repeat(2001),
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    assert.equal(posts, 2);
    assert.match(bridge.snapshot().lastError.message, /repeated an acknowledgement id/);
    const [row] = await store.recent(1);
    assert.equal(row.settlement.outcome, 'partially-accepted');
    assert.equal(row.settlement.failureKind, 'invalid-acknowledgement');
    assert.equal(row.settlement.acceptedChunks, 1);
    assert.equal(row.settlement.totalChunks, 2);
    assert.deepEqual(row.settlement.platformMessageIds, [repeatedMessageId]);
    assert.deepEqual(row.settlement.acknowledgements, [{
      index: 0,
      chunkSha256: createHash('sha256').update('y'.repeat(2000), 'utf8').digest('hex'),
      destinationId: directRoute.channelId,
      platformMessageId: repeatedMessageId,
    }]);
  } finally {
    await bridge.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a Discord settlement write failure after acceptance is reported without retry or false settlement', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-settlement-closed-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'discord-settlement-closed' });
  const reportedErrors = [];
  let reported;
  const report = new Promise(resolve => { reported = resolve; });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  }, {
    onError(error) { reportedErrors.push(error); reported(); },
  });
  let posts = 0;
  let closePromise = null;
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    random: () => 0.5,
    createWebSocket: gatewayFactory([
      { op: 0, t: 'READY', s: 1, d: { user: { id: '111122223333444455', username: 'Synthetic Fieldwork' } } },
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: {
        id: '222233334444555592', channel_id: directRoute.channelId,
        author: { id: directRoute.allowedUserId }, content: 'accept before settlement closes', mentions: [],
      } },
    ], [], []),
    async fetch(url) {
      if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg/' });
      posts += 1;
      closePromise = store.close();
      await closePromise;
      return jsonResponse({ id: '333344445555666679', channel_id: directRoute.channelId });
    },
    onMessage: async () => 'The platform accepts this exactly once.',
  });
  try {
    bridge.start();
    await report;
    assert.equal(posts, 1);
    assert.equal(reportedErrors.length, 1);
    assert.match(reportedErrors[0].message, /after close has begun/);
    assert.equal(bridge.snapshot().state, 'connected');
    await bridge.close();
    const reopened = await openExternalDeliveryStore(file, { expectedId: 'discord-settlement-closed' });
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

test('an attempt-marker write failure fails closed after prepare and before Discord sees a POST', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-attempt-closed-'));
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
  store = await createExternalDeliveryStore(file, { id: 'discord-attempt-closed', clock });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  });
  closeOnNextClock = true;
  let posts = 0;
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    random: () => 0.5,
    createWebSocket: gatewayFactory([
      { op: 0, t: 'READY', s: 1, d: { user: { id: '111122223333444455', username: 'Synthetic Fieldwork' } } },
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: {
        id: '222233334444555591', channel_id: directRoute.channelId,
        author: { id: directRoute.allowedUserId }, content: 'prepare, then fail the marker', mentions: [],
      } },
    ], [], []),
    async fetch(url) {
      if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg/' });
      posts += 1;
      return jsonResponse({ id: '333344445555666678', channel_id: directRoute.channelId });
    },
    onMessage: async () => 'Never cross the attempt edge.',
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    assert.equal(posts, 0);
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

test('an explicit Discord REST rejection is durably recorded as not sent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-discord-rejected-'));
  const file = path.join(directory, 'delivery.jsonl');
  const store = await createExternalDeliveryStore(file, { id: 'discord-rejected' });
  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'discord', destinationId: directRoute.channelId, sourceUserId: directRoute.allowedUserId,
  });
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const bridge = createDiscordBridge({
    token,
    route: directRoute,
    delivery,
    retryMilliseconds: 60_000,
    random: () => 0.5,
    createWebSocket: gatewayFactory([
      { op: 0, t: 'READY', s: 1, d: { user: { id: '111122223333444455', username: 'Synthetic Fieldwork' } } },
      { op: 0, t: 'MESSAGE_CREATE', s: 2, d: {
        id: '222233334444555590', channel_id: directRoute.channelId,
        author: { id: directRoute.allowedUserId }, content: 'reject this send', mentions: [],
      } },
    ], [], []),
    async fetch(url) {
      if (url.endsWith('/gateway/bot')) return jsonResponse({ url: 'wss://gateway.discord.gg/' });
      return jsonResponse({ message: 'synthetic platform rejection' }, 400);
    },
    onMessage: async () => 'A rejected synthetic reply.',
    onStatus(status) { if (status.state === 'failed') failed(); },
  });
  try {
    bridge.start();
    await failure;
    await bridge.close();
    await store.close();
    const reopened = await openExternalDeliveryStore(file, { expectedId: 'discord-rejected' });
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
