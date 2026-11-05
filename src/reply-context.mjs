import { createHash, randomUUID } from 'node:crypto';
import { openDurableLog } from './durable-log.mjs';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';

// A companion record for the conversation archive. Conversation messages stay
// literal and provider-safe; this log joins one bounded input receipt to the
// immutable assistant message that resulted from it. The message hash makes a
// stale or mismatched join fail closed after restart.

export const REPLY_CONTEXT_EVENT_FORMAT = 'fieldwork-reply-context-event/v1';
export const REPLY_CONTEXT_ENTRY_FORMAT = 'fieldwork-reply-context-entry/v1';
export const REPLY_CONTEXT_LIMITS = Object.freeze({
  contextBytes: 512 * 1024,
  eventBytes: 640 * 1024,
  lineBytes: 768 * 1024,
});

const stores = new WeakSet();
const entries = new WeakSet();
const portableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function contextError(message, cause) {
  return new Error(`Reply context: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw contextError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw contextError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw contextError(`${where}.${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function id(value, where) {
  if (typeof value !== 'string' || !portableId.test(value)) throw contextError(`${where} must be 1-128 portable identifier characters`);
  return value;
}

function instant(value, where) {
  if (typeof value !== 'string') throw contextError(`${where} must be an exact ISO timestamp`);
  let normalized = '';
  try { normalized = new Date(value).toISOString(); } catch { /* Rejected below. */ }
  if (normalized !== value) throw contextError(`${where} must be an exact ISO timestamp`);
  return value;
}

function entryKey(conversationId, messageId) {
  return `${conversationId}\u0000${messageId}`;
}

function normalizedContext(value, where) {
  try {
    return boundedJson(value, {
      where, object: true, maxBytes: REPLY_CONTEXT_LIMITS.contextBytes,
      maxDepth: 64, maxNodes: 100_000,
    }).value;
  } catch (error) {
    throw contextError(error.message, error);
  }
}

function entryBody(raw, context) {
  const messageSha256 = raw.messageSha256;
  if (typeof messageSha256 !== 'string' || !hashPattern.test(messageSha256)) {
    throw contextError('messageSha256 must be a lowercase SHA-256 hash');
  }
  return {
    format: REPLY_CONTEXT_ENTRY_FORMAT,
    conversationId: id(raw.conversationId, 'conversationId'),
    messageId: id(raw.messageId, 'messageId'),
    messageSha256,
    observedAt: instant(raw.observedAt, 'observedAt'),
    context,
  };
}

export function createReplyContextEntry(input) {
  const raw = fields(input, ['conversationId', 'messageId', 'messageSha256', 'observedAt', 'context'], 'reply context entry');
  const context = normalizedContext(raw.context, 'reply context entry.context');
  const body = entryBody(raw, context);
  const entry = deepFreeze({ ...body, fingerprint: sha256(canonicalJson(body)) });
  entries.add(entry);
  return entry;
}

export function restoreReplyContextEntry(input) {
  const normalized = normalizedContext(input, 'stored reply context entry');
  const raw = fields(normalized, [
    'format', 'conversationId', 'messageId', 'messageSha256', 'observedAt', 'context', 'fingerprint',
  ], 'stored reply context entry');
  if (raw.format !== REPLY_CONTEXT_ENTRY_FORMAT) throw contextError(`stored reply context entry.format must be ${REPLY_CONTEXT_ENTRY_FORMAT}`);
  if (typeof raw.fingerprint !== 'string' || !hashPattern.test(raw.fingerprint)) throw contextError('stored reply context entry.fingerprint must be a lowercase SHA-256 hash');
  const restored = createReplyContextEntry({
    conversationId: raw.conversationId,
    messageId: raw.messageId,
    messageSha256: raw.messageSha256,
    observedAt: raw.observedAt,
    context: raw.context,
  });
  if (restored.fingerprint !== raw.fingerprint) throw contextError('stored reply context entry fingerprint does not match its contents');
  return restored;
}

export function isReplyContextEntry(value) {
  return Boolean(value) && entries.has(value);
}

function newState() {
  return { sawGenesis: false, entries: new Map(), conversations: new Map() };
}

function applyEvent(event, state) {
  if (event.type === 'reply_context_created') {
    if (event.sequence !== 1 || state.sawGenesis) throw contextError('reply_context_created must be the first and only genesis event');
    const raw = fields(event.data, ['entryFormat'], 'reply_context_created data');
    if (raw.entryFormat !== REPLY_CONTEXT_ENTRY_FORMAT) throw contextError(`reply_context_created entryFormat must be ${REPLY_CONTEXT_ENTRY_FORMAT}`);
    state.sawGenesis = true;
    return;
  }
  if (!state.sawGenesis) throw contextError('the reply context log has no valid genesis event');
  if (event.type !== 'reply_context_recorded') throw contextError(`unsupported reply context event type ${JSON.stringify(event.type)}`);
  const raw = fields(event.data, ['entry'], 'reply_context_recorded data');
  const entry = restoreReplyContextEntry(raw.entry);
  const key = entryKey(entry.conversationId, entry.messageId);
  if (state.entries.has(key)) throw contextError(`conflict: context for message ${JSON.stringify(entry.messageId)} already exists in conversation ${JSON.stringify(entry.conversationId)}`);
  state.entries.set(key, entry);
  if (!state.conversations.has(entry.conversationId)) state.conversations.set(entry.conversationId, []);
  state.conversations.get(entry.conversationId).push(entry);
}

async function buildStore(log, state) {
  let queue = Promise.resolve();
  let closing = false;
  let closePromise = null;
  let projectionFailure = null;

  const ensureHealthy = () => {
    if (projectionFailure) throw projectionFailure;
  };
  const inspect = operation => {
    if (closing) return Promise.reject(contextError('cannot inspect after close has begun'));
    const job = queue.then(() => { ensureHealthy(); return operation(); });
    queue = job.then(() => undefined, () => undefined);
    return job;
  };
  const mutate = operation => {
    if (closing) return Promise.reject(contextError('cannot record after close has begun'));
    const job = queue.then(() => { ensureHealthy(); return operation(); });
    queue = job.then(() => undefined, () => undefined);
    return job;
  };

  const record = input => mutate(async () => {
    const entry = isReplyContextEntry(input) ? input : createReplyContextEntry(input);
    const key = entryKey(entry.conversationId, entry.messageId);
    if (state.entries.has(key)) throw contextError(`conflict: context for message ${JSON.stringify(entry.messageId)} already exists in conversation ${JSON.stringify(entry.conversationId)}`);
    let event;
    try { event = await log.append('reply_context_recorded', { entry }); }
    catch (error) {
      if (error?.commitStatus !== 'not-written') projectionFailure ??= error;
      throw error;
    }
    try { applyEvent(event, state); }
    catch (error) {
      projectionFailure = contextError('a durable event was written but the live reply-context projection failed; close and reopen before any further operation', error);
      throw projectionFailure;
    }
    return entry;
  });

  const forConversation = conversationId => inspect(() => {
    id(conversationId, 'conversationId');
    return deepFreeze([...(state.conversations.get(conversationId) ?? [])]);
  });

  const lookup = (conversationId, messageId) => inspect(() => {
    id(conversationId, 'conversationId');
    id(messageId, 'messageId');
    return state.entries.get(entryKey(conversationId, messageId)) ?? null;
  });

  const receipt = async () => {
    await queue;
    ensureHealthy();
    return log.receipt();
  };

  const close = () => {
    if (!closePromise) {
      closing = true;
      closePromise = queue.then(async () => {
        const errors = [];
        try { await log.close(); } catch (error) { errors.push(error); }
        if (projectionFailure && !errors.includes(projectionFailure)) errors.push(projectionFailure);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Reply context close preserved durable and projection failures');
      });
    }
    return closePromise;
  };

  const store = Object.freeze({ id: log.id, record, forConversation, lookup, receipt, close });
  stores.add(store);
  return store;
}

export function isReplyContextStore(value) {
  return Boolean(value) && stores.has(value);
}

export async function createReplyContextStore(file, options = {}) {
  const raw = fields(options, ['id', 'clock', 'sync'], 'create options');
  const storeId = raw.id === undefined ? randomUUID() : raw.id;
  const clock = raw.clock === undefined ? Date.now : raw.clock;
  const sync = raw.sync === undefined ? true : raw.sync;
  const state = newState();
  const log = await openDurableLog(file, {
    create: true,
    format: REPLY_CONTEXT_EVENT_FORMAT,
    idField: 'replyContextId',
    id: storeId,
    initial: { type: 'reply_context_created', data: { entryFormat: REPLY_CONTEXT_ENTRY_FORMAT } },
    clock,
    sync,
    maxDataBytes: REPLY_CONTEXT_LIMITS.eventBytes,
    maxLineBytes: REPLY_CONTEXT_LIMITS.lineBytes,
  });
  state.sawGenesis = true;
  return buildStore(log, state);
}

export async function openReplyContextStore(file, options = {}) {
  const raw = fields(options, ['expectedId', 'expectedHead', 'clock', 'sync'], 'open options');
  const clock = raw.clock === undefined ? Date.now : raw.clock;
  const sync = raw.sync === undefined ? true : raw.sync;
  const log = await openDurableLog(file, {
    format: REPLY_CONTEXT_EVENT_FORMAT,
    idField: 'replyContextId',
    expectedId: raw.expectedId,
    expectedHead: raw.expectedHead,
    clock,
    sync,
    maxDataBytes: REPLY_CONTEXT_LIMITS.eventBytes,
    maxLineBytes: REPLY_CONTEXT_LIMITS.lineBytes,
    replay: { create: newState, apply: (state, event) => applyEvent(event, state) },
  });
  return buildStore(log, log.replayState);
}
