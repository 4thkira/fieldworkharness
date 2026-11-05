import { deepFreeze, isPlainObject } from './json-data.mjs';

export const MEMORY_LIFECYCLE_FORMAT = 'fieldwork-memory-lifecycle/v1';
export const MEMORY_LIFECYCLE_STATUS_FORMAT = 'fieldwork-memory-lifecycle-status/v1';
export const MEMORY_LIFECYCLE_TYPES = Object.freeze([
  'fact',
  'possibility',
  'reminder',
  'obligation',
  'verdict',
]);

const verdictFields = Object.freeze(['evidence', 'changeCriteria', 'reviewPrompt']);
const lifecycles = new WeakSet();
const defaultLifecycle = deepFreeze({ format: MEMORY_LIFECYCLE_FORMAT, type: 'fact' });
lifecycles.add(defaultLifecycle);

function lifecycleError(message) {
  return new Error(`Memory lifecycle: ${message}`);
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw lifecycleError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw lifecycleError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw lifecycleError(`${where}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function instant(value, where) {
  if (typeof value !== 'string') throw lifecycleError(`${where} must be an exact ISO timestamp`);
  let normalized = '';
  try { normalized = new Date(value).toISOString(); } catch { /* Rejected below. */ }
  if (normalized !== value) throw lifecycleError(`${where} must be an exact ISO timestamp`);
  return value;
}

function text(value, where, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw lifecycleError(`${where} must be nonempty text`);
  const characters = [...value].length;
  if (characters > maximum) throw lifecycleError(`${where} contains ${characters} characters; the limit is ${maximum}`);
  return value;
}

export function normalizeMemoryLifecycle(value, { stored = false } = {}) {
  const allowed = [
    ...(stored ? ['format'] : []),
    'type', 'notBefore', 'reviewAt', 'expiresAt', ...verdictFields,
  ];
  const raw = fields(value, allowed, stored ? 'stored lifecycle' : 'lifecycle');
  if (stored && raw.format !== MEMORY_LIFECYCLE_FORMAT) {
    throw lifecycleError(`stored lifecycle.format must be ${MEMORY_LIFECYCLE_FORMAT}`);
  }
  if (!MEMORY_LIFECYCLE_TYPES.includes(raw.type)) {
    throw lifecycleError(`lifecycle.type must be one of ${MEMORY_LIFECYCLE_TYPES.join(', ')}`);
  }
  const lifecycle = {
    format: MEMORY_LIFECYCLE_FORMAT,
    type: raw.type,
    ...(raw.notBefore === undefined ? {} : { notBefore: instant(raw.notBefore, 'lifecycle.notBefore') }),
    ...(raw.reviewAt === undefined ? {} : { reviewAt: instant(raw.reviewAt, 'lifecycle.reviewAt') }),
    ...(raw.expiresAt === undefined ? {} : { expiresAt: instant(raw.expiresAt, 'lifecycle.expiresAt') }),
    ...(raw.evidence === undefined ? {} : { evidence: text(raw.evidence, 'lifecycle.evidence', 2000) }),
    ...(raw.changeCriteria === undefined ? {} : { changeCriteria: text(raw.changeCriteria, 'lifecycle.changeCriteria', 2000) }),
    ...(raw.reviewPrompt === undefined ? {} : { reviewPrompt: text(raw.reviewPrompt, 'lifecycle.reviewPrompt', 1000) }),
  };

  if (lifecycle.notBefore && lifecycle.expiresAt && lifecycle.notBefore >= lifecycle.expiresAt) {
    throw lifecycleError('lifecycle.expiresAt must be later than lifecycle.notBefore');
  }
  if (lifecycle.notBefore && lifecycle.reviewAt && lifecycle.reviewAt < lifecycle.notBefore) {
    throw lifecycleError('lifecycle.reviewAt must not be earlier than lifecycle.notBefore');
  }
  if (lifecycle.reviewAt && lifecycle.expiresAt && lifecycle.reviewAt > lifecycle.expiresAt) {
    throw lifecycleError('lifecycle.reviewAt must not be later than lifecycle.expiresAt');
  }
  if (lifecycle.type !== 'verdict') {
    for (const key of verdictFields) if (Object.hasOwn(lifecycle, key)) {
      throw lifecycleError(`lifecycle.${key} is only valid for verdict memories`);
    }
  } else {
    if (!lifecycle.evidence) throw lifecycleError('verdict memories must state their evidence');
    if (!lifecycle.changeCriteria) throw lifecycleError('verdict memories must state what could change the verdict');
    if (!lifecycle.reviewAt && !lifecycle.expiresAt) {
      throw lifecycleError('verdict memories need reviewAt or expiresAt so the judgment can be reopened');
    }
  }
  const normalized = deepFreeze(lifecycle);
  lifecycles.add(normalized);
  return normalized;
}

export function isMemoryLifecycle(value) {
  return Boolean(value) && lifecycles.has(value);
}

export function memoryLifecycle(value) {
  if (value === undefined) return defaultLifecycle;
  const format = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'format') : null;
  return normalizeMemoryLifecycle(value, { stored: format?.value !== undefined });
}

export function memoryLifecycleStatus(value, asOf) {
  const lifecycle = memoryLifecycle(value);
  const at = instant(asOf, 'asOf');
  const now = Date.parse(at);
  const notBefore = lifecycle.notBefore ? Date.parse(lifecycle.notBefore) : null;
  const reviewAt = lifecycle.reviewAt ? Date.parse(lifecycle.reviewAt) : null;
  const expiresAt = lifecycle.expiresAt ? Date.parse(lifecycle.expiresAt) : null;
  const phase = notBefore !== null && now < notBefore
    ? 'scheduled'
    : expiresAt !== null && now >= expiresAt
      ? 'expired'
      : 'active';
  const attention = [];
  if (['reminder', 'obligation'].includes(lifecycle.type) && notBefore !== null && now >= notBefore) attention.push('ready');
  if (reviewAt !== null && now >= reviewAt) attention.push('review-due');
  if (expiresAt !== null && now >= expiresAt) attention.push('expired');
  const reached = [
    ['ready', notBefore],
    ['review-due', reviewAt],
    ['expired', expiresAt],
  ].filter(([reason, instantValue]) => attention.includes(reason) && instantValue !== null);
  const upcoming = [notBefore, reviewAt, expiresAt].filter(instantValue => instantValue !== null && instantValue > now);
  return deepFreeze({
    format: MEMORY_LIFECYCLE_STATUS_FORMAT,
    type: lifecycle.type,
    asOf: at,
    phase,
    eligible: phase === 'active',
    due: attention.length > 0,
    attention,
    ...(reached.length ? { dueAt: new Date(Math.min(...reached.map(([, instantValue]) => instantValue))).toISOString() } : {}),
    ...(upcoming.length ? { nextAt: new Date(Math.min(...upcoming)).toISOString() } : {}),
  });
}
