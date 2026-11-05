import { deepFreeze, isPlainObject } from './json-data.mjs';
import {
  isExternalDeliveryCoordinator,
  isExternalDeliveryPlan,
  normalizeBridgeOutput,
} from './external-delivery.mjs';

// Discord Gateway input plus REST replies. The REST and Gateway origins are
// fixed: neither route settings nor API responses can choose where the bot
// token is sent.

export const DISCORD_BRIDGE_STATUS_FORMAT = 'fieldwork-discord-bridge-status/v1';
export const DISCORD_BRIDGE_LIMITS = Object.freeze({
  responseBytes: 1024 * 1024,
  gatewayPayloadBytes: 1024 * 1024,
  messageCharacters: 2000,
  rememberedMessages: 512,
  retryMilliseconds: 5000,
});

export const DISCORD_BRIDGE_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

const REST_ORIGIN = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const conversationIdPattern = /^conv-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const snowflakePattern = /^[1-9][0-9]{0,31}$/;
const deliveryFailures = new WeakMap();

function discordError(message, cause, failureKind = null) {
  const error = new Error(`Discord bridge: ${message}`, cause === undefined ? undefined : { cause });
  if (failureKind) deliveryFailures.set(error, failureKind);
  return error;
}

function dataProperty(value, key) {
  if (!isPlainObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function exactObject(value, allowed, where) {
  if (!isPlainObject(value)) throw discordError(`${where} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw discordError(`${where} has unknown fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw discordError(`${where}.${String(key)} must be an enumerable data property`);
    }
  }
  return value;
}

function routeProjection(value) {
  const route = exactObject(
    value,
    ['channelId', 'guildId', 'allowedUserId', 'scope', 'respondTo', 'conversationId'],
    'route',
  );
  for (const key of ['channelId', 'allowedUserId']) {
    if (typeof route[key] !== 'string' || !snowflakePattern.test(route[key])) throw discordError(`route.${key} is invalid`);
  }
  if (!['direct', 'guild'].includes(route.scope)) throw discordError('route.scope is invalid');
  if ((route.scope === 'direct' && route.respondTo !== 'all') || (route.scope === 'guild' && route.respondTo !== 'mention')) {
    throw discordError('route.respondTo is invalid for its scope');
  }
  if (route.guildId !== null && (typeof route.guildId !== 'string' || !snowflakePattern.test(route.guildId))) {
    throw discordError('route.guildId is invalid');
  }
  if ((route.scope === 'direct') !== (route.guildId === null)) {
    throw discordError('route.guildId must be null for a direct message and present for a guild channel');
  }
  if (route.conversationId !== null && (typeof route.conversationId !== 'string' || !conversationIdPattern.test(route.conversationId))) {
    throw discordError('route.conversationId is invalid');
  }
  return deepFreeze({
    channelId: route.channelId,
    guildId: route.guildId,
    allowedUserId: route.allowedUserId,
    scope: route.scope,
    respondTo: route.respondTo,
    conversationId: route.conversationId,
  });
}

function boundedToken(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\p{Cc}]/u.test(value)) {
    throw discordError('token must be 1-4096 characters without whitespace or control characters');
  }
  return value;
}

function redact(text, secret) {
  return secret ? String(text).split(secret).join('[redacted]') : String(text);
}

function boundedError(error, secret) {
  const message = redact(error instanceof Error ? error.message : String(error), secret).replace(/[\r\n]+/g, ' ').trim();
  return [...message].slice(0, 500).join('') || 'Discord request failed';
}

function isoDate(value, clock) {
  const date = typeof value === 'string' && value ? new Date(value) : new Date(clock());
  if (!Number.isFinite(date.getTime())) return new Date(clock()).toISOString();
  return date.toISOString();
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function mentionedText(content, botId, mentions) {
  if (!Array.isArray(mentions) || !mentions.some(value => String(dataProperty(value, 'id')) === botId)) return null;
  const pattern = new RegExp(`<@!?${botId}>`, 'gu');
  if (!pattern.test(content)) return null;
  pattern.lastIndex = 0;
  return content.replace(pattern, ' ').replace(/\s+/g, ' ').trim() || null;
}

function gatewayPayload(data) {
  if (typeof data !== 'string') throw discordError('Gateway sent a non-text payload');
  if (Buffer.byteLength(data, 'utf8') > DISCORD_BRIDGE_LIMITS.gatewayPayloadBytes) throw discordError('Gateway payload is too large');
  let payload;
  try { payload = JSON.parse(data); }
  catch (error) { throw discordError('Gateway sent invalid JSON', error); }
  if (!isPlainObject(payload)) throw discordError('Gateway payload must be an object');
  return payload;
}

function gatewayAddress(value) {
  const raw = dataProperty(value, 'url');
  let address;
  try { address = new URL(raw); }
  catch (error) { throw discordError('Get Gateway Bot did not return a valid Gateway URL', error); }
  if (address.protocol !== 'wss:' || address.hostname !== 'gateway.discord.gg' || address.port || address.username || address.password) {
    throw discordError('Get Gateway Bot returned an unexpected Gateway origin');
  }
  return GATEWAY_URL;
}

export function createDiscordBridge(options = {}) {
  const input = exactObject(
    options,
    ['token', 'route', 'onMessage', 'onStatus', 'fetch', 'clock', 'retryMilliseconds', 'createWebSocket', 'random', 'delivery'],
    'options',
  );
  const token = boundedToken(input.token);
  const route = routeProjection(input.route);
  const onMessage = input.onMessage;
  if (typeof onMessage !== 'function') throw discordError('onMessage must be a function');
  const onStatus = input.onStatus ?? (() => {});
  if (typeof onStatus !== 'function') throw discordError('onStatus must be a function');
  const fetcher = input.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw discordError('fetch must be a function');
  const clock = input.clock ?? Date.now;
  if (typeof clock !== 'function') throw discordError('clock must be a function');
  const retryMilliseconds = input.retryMilliseconds ?? DISCORD_BRIDGE_LIMITS.retryMilliseconds;
  if (!Number.isSafeInteger(retryMilliseconds) || retryMilliseconds < 10 || retryMilliseconds > 60_000) {
    throw discordError('retryMilliseconds must be a whole number from 10 to 60000');
  }
  const createWebSocket = input.createWebSocket ?? (url => {
    if (typeof globalThis.WebSocket !== 'function') throw discordError('this Node runtime does not provide WebSocket support');
    return new globalThis.WebSocket(url);
  });
  if (typeof createWebSocket !== 'function') throw discordError('createWebSocket must be a function');
  const random = input.random ?? Math.random;
  if (typeof random !== 'function') throw discordError('random must be a function');
  const delivery = input.delivery;
  if (!isExternalDeliveryCoordinator(delivery)) {
    throw discordError('delivery is required and must be a Fieldwork external delivery coordinator');
  }
  if (delivery.route.platform !== 'discord'
    || delivery.route.destinationId !== route.channelId
    || delivery.route.sourceUserId !== route.allowedUserId) {
    throw discordError('delivery coordinator route does not match the Discord route');
  }

  const controller = new AbortController();
  let state = 'saved';
  let bot = null;
  let lastError = null;
  let loopPromise = null;
  const proactiveDeliveries = new Set();
  let activeSocket = null;
  let dispatchQueue = Promise.resolve();
  const seen = new Set();
  const seenOrder = [];

  const snapshot = () => deepFreeze({
    format: DISCORD_BRIDGE_STATUS_FORMAT,
    state,
    bot: bot ? { id: bot.id, username: bot.username } : null,
    lastError,
  });

  const publish = next => {
    state = next;
    try { onStatus(snapshot()); } catch { /* Status observers do not own the bridge. */ }
  };

  async function rest(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetcher(`${REST_ORIGIN}${path}`, {
        method,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bot ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw discordError(`could not reach the Discord API: ${boundedError(error, token)}`, error, 'transport-uncertain');
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > DISCORD_BRIDGE_LIMITS.responseBytes) throw discordError('Discord API response is too large', undefined, 'transport-uncertain');
    let text;
    try { text = await response.text(); }
    catch (error) { throw discordError(`could not read the Discord API response: ${boundedError(error, token)}`, error, 'transport-uncertain'); }
    if (Buffer.byteLength(text, 'utf8') > DISCORD_BRIDGE_LIMITS.responseBytes) throw discordError('Discord API response is too large', undefined, 'transport-uncertain');
    let document = null;
    if (text) {
      try { document = JSON.parse(text); }
      catch (error) { throw discordError('Discord API returned invalid JSON', error, 'transport-uncertain'); }
    }
    if (!response.ok) {
      const message = dataProperty(document, 'message');
      const rateLimited = response.status === 429
        ? ' (not retried automatically)'
        : '';
      throw discordError(`Discord API rejected ${method} ${path}${typeof message === 'string' ? `: ${boundedError(message, token)}` : ''}${rateLimited}`, undefined, 'platform-rejected');
    }
    return document;
  }

  function remember(messageId) {
    if (seen.has(messageId)) return false;
    seen.add(messageId);
    seenOrder.push(messageId);
    if (seenOrder.length > DISCORD_BRIDGE_LIMITS.rememberedMessages) seen.delete(seenOrder.shift());
    return true;
  }

  async function sendChunks(chunks, sourceMessageId, acknowledgements = []) {
    for (const content of chunks) {
      const result = await rest(`/channels/${route.channelId}/messages`, {
        method: 'POST',
        body: {
          content,
          allowed_mentions: { parse: [], replied_user: false },
          ...(sourceMessageId ? { message_reference: {
            message_id: sourceMessageId,
            channel_id: route.channelId,
            fail_if_not_exists: false,
          } } : {}),
        },
      });
      const messageId = dataProperty(result, 'id');
      if (typeof messageId !== 'string' || !snowflakePattern.test(messageId)) {
        throw discordError('Create Message did not return a usable message id', undefined, 'invalid-acknowledgement');
      }
      const destinationId = dataProperty(result, 'channel_id');
      if (typeof destinationId !== 'string' || !snowflakePattern.test(destinationId) || destinationId !== route.channelId) {
        throw discordError('Create Message did not confirm the expected channel', undefined, 'invalid-acknowledgement');
      }
      if (acknowledgements.some(row => row.platformMessageId === messageId)) {
        throw discordError('Create Message repeated an acknowledgement id', undefined, 'invalid-acknowledgement');
      }
      acknowledgements.push({ destinationId, platformMessageId: messageId });
    }
    return acknowledgements;
  }

  async function deliver(value, sourceMessageId, proactive = false) {
    const output = normalizeBridgeOutput(value);
    const plan = proactive
      ? await delivery.prepareProactive({ sourceMessageId: output.source.messageId, output })
      : await delivery.prepare({ sourceMessageId, output });
    if (!isExternalDeliveryPlan(plan)) throw discordError('delivery coordinator returned an invalid plan');
    if (plan.decision === 'refuse') return deepFreeze({
      actionId: plan.actionId,
      decision: plan.decision,
      outcome: 'not-attempted',
    });
    const acknowledgements = [];
    try {
      await delivery.beginAttempt({ actionId: plan.actionId });
    } catch (error) {
      if (!proactive) throw error;
      delivery.report(error);
      return deepFreeze({
        actionId: plan.actionId,
        decision: plan.decision,
        outcome: 'not-attempted',
      });
    }
    try {
      await sendChunks(plan.chunks, proactive ? null : sourceMessageId, acknowledgements);
    } catch (error) {
      const failureKind = deliveryFailures.get(error) ?? 'transport-uncertain';
      const outcome = acknowledgements.length
        ? 'partially-accepted'
        : failureKind === 'platform-rejected' ? 'platform-rejected' : 'uncertain';
      let settled = null;
      try {
        settled = await delivery.settle({
          actionId: plan.actionId,
          outcome,
          failureKind,
          acknowledgements,
        });
      } catch (settlementError) { delivery.report(settlementError); }
      if (proactive) return deepFreeze({
        actionId: plan.actionId,
        decision: plan.decision,
        outcome: settled?.settlement?.outcome ?? 'may-have-been-sent',
      });
      throw error;
    }
    let settled = null;
    try {
      settled = await delivery.settle({
        actionId: plan.actionId,
        outcome: 'platform-accepted',
        failureKind: null,
        acknowledgements,
      });
    } catch (error) {
      delivery.report(error);
    }
    return deepFreeze({
      actionId: plan.actionId,
      decision: plan.decision,
      outcome: settled?.settlement?.outcome ?? 'may-have-been-sent',
    });
  }

  const deliverReply = (value, sourceMessageId) => deliver(value, sourceMessageId, false);
  const deliverProactive = value => {
    if (controller.signal.aborted) return Promise.reject(discordError('bridge is closing'));
    const operation = deliver(value, null, true);
    proactiveDeliveries.add(operation);
    void operation.then(
      () => proactiveDeliveries.delete(operation),
      () => proactiveDeliveries.delete(operation),
    );
    return operation;
  };

  async function handleMessage(message) {
    const messageId = dataProperty(message, 'id');
    const channelId = dataProperty(message, 'channel_id');
    const guildId = dataProperty(message, 'guild_id');
    const author = dataProperty(message, 'author');
    const authorId = dataProperty(author, 'id');
    if (typeof messageId !== 'string' || !snowflakePattern.test(messageId) || !remember(messageId)) return;
    if (channelId !== route.channelId || authorId !== route.allowedUserId || dataProperty(author, 'bot') === true) return;
    if (dataProperty(message, 'webhook_id') !== undefined) return;
    if (route.scope === 'direct' ? guildId !== undefined : guildId !== route.guildId) return;
    let text = dataProperty(message, 'content');
    if (typeof text !== 'string' || !text.trim()) return;
    if (route.scope === 'guild') {
      text = mentionedText(text, bot?.id, dataProperty(message, 'mentions'));
      if (!text) return;
    }
    const reply = await onMessage(deepFreeze({
      platform: 'discord',
      destinationId: route.channelId,
      sourceUserId: route.allowedUserId,
      sourceMessageId: messageId,
      at: isoDate(dataProperty(message, 'timestamp'), clock),
      text,
      conversationId: route.conversationId,
    }));
    await deliverReply(reply, messageId);
  }

  async function gatewaySession(url) {
    await new Promise((resolve, reject) => {
      let socket;
      let finished = false;
      let hello = false;
      let sequence = null;
      let heartbeatInterval = null;
      let heartbeatTimer = null;
      let handshakeTimer = null;
      let awaitingHeartbeatAck = false;

      const cleanTimer = () => {
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        heartbeatTimer = null;
        handshakeTimer = null;
      };
      const cleanup = () => {
        cleanTimer();
        controller.signal.removeEventListener('abort', onAbort);
        if (socket?.removeEventListener) {
          socket.removeEventListener('message', onSocketMessage);
          socket.removeEventListener('close', onClose);
          socket.removeEventListener('error', onError);
        }
        if (activeSocket === socket) activeSocket = null;
      };
      const closeSocket = () => {
        try {
          if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close(1000, 'Fieldwork is closing');
        } catch { /* The status path already owns the failure. */ }
      };
      const fail = error => {
        if (finished) return;
        finished = true;
        cleanup();
        closeSocket();
        reject(error instanceof Error ? error : discordError(String(error)));
      };
      const send = payload => {
        if (!socket || socket.readyState !== 1) throw discordError('Gateway socket is not open');
        socket.send(JSON.stringify(payload));
      };
      const sendHeartbeat = () => {
        if (awaitingHeartbeatAck) throw discordError('Gateway stopped acknowledging heartbeats');
        send({ op: 1, d: sequence });
        awaitingHeartbeatAck = true;
      };
      const scheduleHeartbeat = milliseconds => {
        cleanTimer();
        heartbeatTimer = setTimeout(() => {
          try {
            sendHeartbeat();
            scheduleHeartbeat(heartbeatInterval);
          } catch (error) { fail(error); }
        }, milliseconds);
        heartbeatTimer.unref?.();
      };
      const onAbort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        closeSocket();
        dispatchQueue.then(resolve, resolve);
      };
      const onClose = event => {
        if (controller.signal.aborted) { onAbort(); return; }
        const code = Number.isInteger(event?.code) ? event.code : 0;
        fail(discordError(`Gateway closed the connection${code ? ` with code ${code}` : ''}`));
      };
      const onError = () => fail(discordError('Gateway WebSocket failed'));
      const handlePayload = payload => {
        const op = dataProperty(payload, 'op');
        const nextSequence = dataProperty(payload, 's');
        if (Number.isSafeInteger(nextSequence) && nextSequence >= 0) sequence = nextSequence;
        if (op === 10) {
          if (hello) throw discordError('Gateway sent Hello more than once');
          const interval = dataProperty(dataProperty(payload, 'd'), 'heartbeat_interval');
          if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 120_000) throw discordError('Gateway Hello has an invalid heartbeat interval');
          const jitter = Number(random());
          if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) throw discordError('random must return a number from 0 up to 1');
          hello = true;
          heartbeatInterval = interval;
          send({
            op: 2,
            d: {
              token,
              intents: DISCORD_BRIDGE_INTENTS,
              properties: { os: process.platform, browser: 'fieldwork', device: 'fieldwork' },
            },
          });
          scheduleHeartbeat(Math.floor(interval * jitter));
          return;
        }
        if (!hello) throw discordError('Gateway sent an event before Hello');
        if (op === 11) { awaitingHeartbeatAck = false; return; }
        if (op === 1) { sendHeartbeat(); return; }
        if (op === 7) throw discordError('Gateway requested a reconnect');
        if (op === 9) throw discordError('Gateway rejected the session');
        if (op !== 0) return;
        const type = dataProperty(payload, 't');
        const data = dataProperty(payload, 'd');
        if (type === 'READY') {
          const user = dataProperty(data, 'user');
          const id = dataProperty(user, 'id');
          const username = dataProperty(user, 'username');
          if (typeof id !== 'string' || !snowflakePattern.test(id) || typeof username !== 'string' || !username || username.length > 80 || /\p{Cc}/u.test(username)) {
            throw discordError('Gateway Ready did not include a usable bot identity');
          }
          bot = { id, username };
          if (handshakeTimer !== null) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          lastError = null;
          publish('connected');
          return;
        }
        if (type === 'MESSAGE_CREATE' && bot) {
          const task = dispatchQueue.then(() => handleMessage(data));
          dispatchQueue = task.then(() => undefined, () => undefined);
          task.catch(fail);
        }
      };
      const onSocketMessage = event => {
        try { handlePayload(gatewayPayload(event?.data)); }
        catch (error) { fail(error); }
      };

      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        socket = createWebSocket(url);
        activeSocket = socket;
        if (!socket || typeof socket.addEventListener !== 'function' || typeof socket.send !== 'function' || typeof socket.close !== 'function') {
          throw discordError('createWebSocket did not return a WebSocket-like object');
        }
        socket.addEventListener('message', onSocketMessage);
        socket.addEventListener('close', onClose);
        socket.addEventListener('error', onError);
        handshakeTimer = setTimeout(() => fail(discordError('Gateway did not become ready within 30 seconds')), 30_000);
        handshakeTimer.unref?.();
      } catch (error) { fail(error); }
    });
  }

  async function loop() {
    while (!controller.signal.aborted) {
      try {
        publish('connecting');
        const gateway = gatewayAddress(await rest('/gateway/bot'));
        await gatewaySession(gateway);
      } catch (error) {
        if (controller.signal.aborted) break;
        lastError = deepFreeze({ at: new Date(clock()).toISOString(), message: boundedError(error, token) });
        publish('failed');
        try { await delay(retryMilliseconds, controller.signal); } catch { break; }
      }
    }
    publish('paused');
  }

  return Object.freeze({
    snapshot,
    deliverProactive,
    start() {
      if (!loopPromise) loopPromise = loop();
      return snapshot();
    },
    async close() {
      if (!controller.signal.aborted) controller.abort(discordError('bridge is closing'));
      try { activeSocket?.close(1000, 'Fieldwork is closing'); } catch { /* The loop owns close failures. */ }
      try { await loopPromise; } catch { /* The public status carries failures. */ }
      await Promise.allSettled([...proactiveDeliveries]);
    },
  });
}
