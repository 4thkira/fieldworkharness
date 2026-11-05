import { deepFreeze, isPlainObject } from './json-data.mjs';

// Provenance that belongs to the room rather than to message prose. It is kept
// in the conversation archive for projections such as check-in dividers, then
// removed before messages cross the provider boundary.
export const MESSAGE_ORIGIN_FORMAT = 'fieldwork-message-origin/v1';
export const BRIDGE_MESSAGE_ORIGIN_FORMAT = 'fieldwork-message-origin/v2';
export const FREE_TIME_MESSAGE_ORIGIN_FORMAT = 'fieldwork-message-origin/v3';

const originalKinds = new Set(['check-in', 'postcard']);
const currentKinds = new Set(['check-in', 'postcard', 'free-time']);
const bridgePlatforms = new Set(['telegram', 'discord']);

function exactOrigin(value) {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !keys.every(key => typeof key === 'string' && ['format', 'kind', 'at'].includes(key))) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  }
  const validFormat = (value.format === MESSAGE_ORIGIN_FORMAT && originalKinds.has(value.kind))
    || (value.format === FREE_TIME_MESSAGE_ORIGIN_FORMAT && currentKinds.has(value.kind));
  if (!validFormat || typeof value.at !== 'string') return null;
  let normalized = '';
  try { normalized = new Date(value.at).toISOString(); } catch { return null; }
  return normalized === value.at ? { format: value.format, kind: value.kind, at: value.at } : null;
}

function exactBridgeOrigin(value) {
  if (!isPlainObject(value)) return null;
  const expected = ['format', 'kind', 'at', 'platform', 'destinationId', 'sourceUserId', 'sourceMessageId'];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || !keys.every(key => typeof key === 'string' && expected.includes(key))) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  }
  if (value.format !== BRIDGE_MESSAGE_ORIGIN_FORMAT || value.kind !== 'bridge' || !bridgePlatforms.has(value.platform)) return null;
  for (const key of ['destinationId', 'sourceUserId', 'sourceMessageId']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 128 || /[\s\p{Cc}]/u.test(value[key])) return null;
  }
  let normalized = '';
  try { normalized = new Date(value.at).toISOString(); } catch { return null; }
  return normalized === value.at ? {
    format: value.format,
    kind: value.kind,
    at: value.at,
    platform: value.platform,
    destinationId: value.destinationId,
    sourceUserId: value.sourceUserId,
    sourceMessageId: value.sourceMessageId,
  } : null;
}

export function createMessageOrigin({ kind, at } = {}) {
  const format = kind === 'free-time' ? FREE_TIME_MESSAGE_ORIGIN_FORMAT : MESSAGE_ORIGIN_FORMAT;
  const origin = exactOrigin({ format, kind, at });
  if (!origin) throw new Error('Message origin: kind must be check-in, postcard, or free-time and at must be an exact ISO timestamp');
  return deepFreeze(origin);
}

export function createBridgeMessageOrigin({ platform, destinationId, sourceUserId, sourceMessageId, at } = {}) {
  const origin = exactBridgeOrigin({
    format: BRIDGE_MESSAGE_ORIGIN_FORMAT,
    kind: 'bridge',
    at,
    platform,
    destinationId,
    sourceUserId,
    sourceMessageId,
  });
  if (!origin) throw new Error('Message origin: bridge route and timestamp must be exact portable values');
  return deepFreeze(origin);
}

export function messageOrigin(message) {
  if (!isPlainObject(message)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(message, 'fieldworkOrigin');
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  const origin = exactOrigin(descriptor.value) ?? exactBridgeOrigin(descriptor.value);
  return origin ? deepFreeze(origin) : null;
}

export function withoutMessageOrigin(message) {
  if (!isPlainObject(message) || !Object.hasOwn(message, 'fieldworkOrigin')) return message;
  const copy = { ...message };
  delete copy.fieldworkOrigin;
  return copy;
}
