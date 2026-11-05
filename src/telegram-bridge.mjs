import { deepFreeze, isPlainObject } from './json-data.mjs';
import {
  isExternalDeliveryCoordinator,
  isExternalDeliveryPlan,
  normalizeBridgeOutput,
} from './external-delivery.mjs';

// Telegram Bot API long polling. The API origin is fixed so a configured chat
// can never redirect or rewrite where the bot token is sent.

export const TELEGRAM_BRIDGE_STATUS_FORMAT = 'fieldwork-telegram-bridge-status/v1';
export const TELEGRAM_BRIDGE_LIMITS = Object.freeze({
  responseBytes: 1024 * 1024,
  messageCharacters: 4096,
  rememberedUpdates: 512,
  retryMilliseconds: 5000,
});

const API_ORIGIN = 'https://api.telegram.org';
const conversationIdPattern = /^conv-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deliveryFailures = new WeakMap();

function telegramError(message, cause, failureKind = null) {
  const error = new Error(`Telegram bridge: ${message}`, cause === undefined ? undefined : { cause });
  if (failureKind) deliveryFailures.set(error, failureKind);
  return error;
}

function dataProperty(value, key) {
  if (!isPlainObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function routeProjection(value) {
  if (!isPlainObject(value)) throw telegramError('route must be a validated Telegram route');
  const keys = Reflect.ownKeys(value);
  const allowed = ['chatId', 'allowedUserId', 'scope', 'respondTo', 'conversationId'];
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) throw telegramError('route has unknown fields');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw telegramError(`route.${String(key)} must be an enumerable data property`);
  }
  if (typeof value.chatId !== 'string' || !/^-?[1-9][0-9]{0,31}$/.test(value.chatId)) throw telegramError('route.chatId is invalid');
  if (typeof value.allowedUserId !== 'string' || !/^[1-9][0-9]{0,31}$/.test(value.allowedUserId)) throw telegramError('route.allowedUserId is invalid');
  if (!['direct', 'group'].includes(value.scope)) throw telegramError('route.scope is invalid');
  if ((value.scope === 'direct' && value.respondTo !== 'all') || (value.scope === 'group' && value.respondTo !== 'mention')) {
    throw telegramError('route.respondTo is invalid for its scope');
  }
  if ((value.scope === 'direct') !== !value.chatId.startsWith('-')) {
    throw telegramError('route.chatId must be positive for a direct chat and negative for a group');
  }
  if (value.conversationId !== null && (typeof value.conversationId !== 'string' || !conversationIdPattern.test(value.conversationId))) {
    throw telegramError('route.conversationId is invalid');
  }
  return deepFreeze({
    chatId: value.chatId,
    allowedUserId: value.allowedUserId,
    scope: value.scope,
    respondTo: value.respondTo,
    conversationId: value.conversationId,
  });
}

function boundedToken(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,200}$/.test(value)) {
    throw telegramError('token must have the BotFather numeric-id:secret form');
  }
  return value;
}

function redact(text, secret) {
  return secret ? String(text).split(secret).join('[redacted]') : String(text);
}

function isoDate(value, clock) {
  const date = Number.isSafeInteger(value) && value >= 0 ? new Date(value * 1000) : new Date(clock());
  if (!Number.isFinite(date.getTime())) return new Date(clock()).toISOString();
  return date.toISOString();
}

function boundedError(error, secret) {
  const message = redact(error instanceof Error ? error.message : String(error), secret).replace(/[\r\n]+/g, ' ').trim();
  return [...message].slice(0, 500).join('') || 'Telegram request failed';
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

function mentionedText(text, username) {
  if (!username) return null;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s)@${escaped}[,.!?;:]*(?=\\s|$)`, 'iu');
  if (!pattern.test(text)) return null;
  return text.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
}

export function createTelegramBridge(options = {}) {
  if (!isPlainObject(options)) throw telegramError('options must be an object');
  const allowedOptions = ['token', 'route', 'onMessage', 'onStatus', 'fetch', 'clock', 'retryMilliseconds', 'delivery'];
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowedOptions.includes(key)) throw telegramError(`options has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw telegramError(`options.${String(key)} must be an enumerable data property`);
  }
  const token = boundedToken(options.token);
  const route = routeProjection(options.route);
  const onMessage = options.onMessage;
  if (typeof onMessage !== 'function') throw telegramError('onMessage must be a function');
  const onStatus = options.onStatus ?? (() => {});
  if (typeof onStatus !== 'function') throw telegramError('onStatus must be a function');
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw telegramError('fetch must be a function');
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') throw telegramError('clock must be a function');
  const retryMilliseconds = options.retryMilliseconds ?? TELEGRAM_BRIDGE_LIMITS.retryMilliseconds;
  if (!Number.isSafeInteger(retryMilliseconds) || retryMilliseconds < 10 || retryMilliseconds > 60_000) {
    throw telegramError('retryMilliseconds must be a whole number from 10 to 60000');
  }
  const delivery = options.delivery;
  if (!isExternalDeliveryCoordinator(delivery)) {
    throw telegramError('delivery is required and must be a Fieldwork external delivery coordinator');
  }
  if (delivery.route.platform !== 'telegram'
    || delivery.route.destinationId !== route.chatId
    || delivery.route.sourceUserId !== route.allowedUserId) {
    throw telegramError('delivery coordinator route does not match the Telegram route');
  }

  const controller = new AbortController();
  let state = 'saved';
  let bot = null;
  let lastError = null;
  let loopPromise = null;
  const proactiveDeliveries = new Set();
  let offset = null;
  let firstConnection = true;
  const seen = new Set();
  const seenOrder = [];

  const snapshot = () => deepFreeze({
    format: TELEGRAM_BRIDGE_STATUS_FORMAT,
    state,
    bot: bot ? { id: bot.id, username: bot.username } : null,
    lastError,
  });

  const publish = next => {
    state = next;
    try { onStatus(snapshot()); } catch { /* Status observers do not own the bridge. */ }
  };

  async function call(method, body, signal = controller.signal) {
    let response;
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 15_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      response = await fetcher(`${API_ORIGIN}/bot${token}/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw telegramError(`could not reach the Bot API: ${boundedError(error, token)}`, error, 'transport-uncertain');
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > TELEGRAM_BRIDGE_LIMITS.responseBytes) throw telegramError('Bot API response is too large', undefined, 'transport-uncertain');
    let text;
    try { text = await response.text(); }
    catch (error) { throw telegramError(`could not read the Bot API response: ${boundedError(error, token)}`, error, 'transport-uncertain'); }
    if (Buffer.byteLength(text, 'utf8') > TELEGRAM_BRIDGE_LIMITS.responseBytes) throw telegramError('Bot API response is too large', undefined, 'transport-uncertain');
    let document;
    try { document = JSON.parse(text); }
    catch (error) { throw telegramError('Bot API returned invalid JSON', error, 'transport-uncertain'); }
    const ok = dataProperty(document, 'ok');
    const result = dataProperty(document, 'result');
    if (!response.ok || ok !== true) {
      const description = dataProperty(document, 'description');
      throw telegramError(`Bot API rejected ${method}${typeof description === 'string' ? `: ${boundedError(description, token)}` : ''}`, undefined, 'platform-rejected');
    }
    return result;
  }

  function remember(updateId) {
    if (seen.has(updateId)) return false;
    seen.add(updateId);
    seenOrder.push(updateId);
    if (seenOrder.length > TELEGRAM_BRIDGE_LIMITS.rememberedUpdates) seen.delete(seenOrder.shift());
    return true;
  }

  async function sendChunks(chunks, sourceMessageId, acknowledgements = []) {
    for (const content of chunks) {
      const result = await call('sendMessage', {
        chat_id: route.chatId,
        text: content,
        link_preview_options: { is_disabled: true },
        ...(sourceMessageId ? { reply_parameters: { message_id: sourceMessageId, allow_sending_without_reply: true } } : {}),
      });
      const messageId = dataProperty(result, 'message_id');
      if (!Number.isSafeInteger(messageId) || messageId < 1) {
        throw telegramError('sendMessage did not return a usable message id', undefined, 'invalid-acknowledgement');
      }
      const returnedChatId = dataProperty(dataProperty(result, 'chat'), 'id');
      if (!Number.isSafeInteger(returnedChatId) || String(returnedChatId) !== route.chatId) {
        throw telegramError('sendMessage did not acknowledge the prepared chat', undefined, 'invalid-acknowledgement');
      }
      const platformMessageId = String(messageId);
      if (acknowledgements.some(row => row.platformMessageId === platformMessageId)) {
        throw telegramError('sendMessage repeated an acknowledgement id', undefined, 'invalid-acknowledgement');
      }
      acknowledgements.push({ destinationId: route.chatId, platformMessageId });
    }
    return acknowledgements;
  }

  async function deliver(value, sourceMessageId, proactive = false) {
    const output = normalizeBridgeOutput(value);
    const plan = proactive
      ? await delivery.prepareProactive({ sourceMessageId: output.source.messageId, output })
      : await delivery.prepare({ sourceMessageId: String(sourceMessageId), output });
    if (!isExternalDeliveryPlan(plan)) throw telegramError('delivery coordinator returned an invalid plan');
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
      // The platform already accepted the message. Reporting a receipt failure
      // must not reconnect and risk turning evidence trouble into a resend.
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
    if (controller.signal.aborted) return Promise.reject(telegramError('bridge is closing'));
    const operation = deliver(value, null, true);
    proactiveDeliveries.add(operation);
    void operation.then(
      () => proactiveDeliveries.delete(operation),
      () => proactiveDeliveries.delete(operation),
    );
    return operation;
  };

  async function handleUpdate(update) {
    const updateId = dataProperty(update, 'update_id');
    if (!Number.isSafeInteger(updateId) || updateId < 0 || !remember(updateId)) return;
    const message = dataProperty(update, 'message');
    if (!isPlainObject(message)) return;
    const chat = dataProperty(message, 'chat');
    const from = dataProperty(message, 'from');
    const chatId = dataProperty(chat, 'id');
    const userId = dataProperty(from, 'id');
    if (String(chatId) !== route.chatId || String(userId) !== route.allowedUserId || dataProperty(from, 'is_bot') !== false) return;
    let text = dataProperty(message, 'text');
    if (typeof text !== 'string' || !text.trim()) return;
    if (route.scope === 'group') {
      text = mentionedText(text, bot?.username);
      if (!text) return;
    }
    const sourceMessageId = dataProperty(message, 'message_id');
    const reply = await onMessage(deepFreeze({
      platform: 'telegram',
      destinationId: route.chatId,
      sourceUserId: route.allowedUserId,
      sourceMessageId: Number.isSafeInteger(sourceMessageId) ? String(sourceMessageId) : String(updateId),
      at: isoDate(dataProperty(message, 'date'), clock),
      text,
      conversationId: route.conversationId,
    }));
    await deliverReply(reply, Number.isSafeInteger(sourceMessageId) ? sourceMessageId : updateId);
  }

  async function connect() {
    const webhook = await call('getWebhookInfo', {});
    if (typeof dataProperty(webhook, 'url') === 'string' && dataProperty(webhook, 'url')) {
      throw telegramError('this bot still has a webhook; remove it before using Fieldwork long polling');
    }
    const identity = await call('getMe', {});
    const botId = dataProperty(identity, 'id');
    const username = dataProperty(identity, 'username');
    if (!Number.isSafeInteger(botId) || botId < 1 || typeof username !== 'string' || !/^[A-Za-z0-9_]{5,64}$/.test(username)) {
      throw telegramError('getMe did not return a usable bot identity');
    }
    bot = { id: String(botId), username };
    if (firstConnection) {
      const newest = await call('getUpdates', { offset: -1, limit: 1, timeout: 0, allowed_updates: ['message'] });
      if (!Array.isArray(newest)) throw telegramError('getUpdates did not return an array');
      const lastId = newest.map(row => dataProperty(row, 'update_id')).filter(Number.isSafeInteger).sort((a, b) => b - a)[0];
      offset = Number.isSafeInteger(lastId) ? lastId + 1 : 0;
      firstConnection = false;
    }
    lastError = null;
    publish('connected');
  }

  async function loop() {
    while (!controller.signal.aborted) {
      try {
        publish('connecting');
        await connect();
        while (!controller.signal.aborted) {
          const updates = await call('getUpdates', { offset, limit: 100, timeout: 25, allowed_updates: ['message'] });
          if (!Array.isArray(updates)) throw telegramError('getUpdates did not return an array');
          for (const update of updates) {
            const updateId = dataProperty(update, 'update_id');
            if (Number.isSafeInteger(updateId) && updateId >= 0) offset = Math.max(offset, updateId + 1);
            await handleUpdate(update);
          }
        }
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
      if (!controller.signal.aborted) controller.abort(telegramError('bridge is closing'));
      try { await loopPromise; } catch { /* The public status carries failures. */ }
      await Promise.allSettled([...proactiveDeliveries]);
    },
  });
}
