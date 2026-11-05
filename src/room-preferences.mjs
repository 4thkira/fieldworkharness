import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';
import { isReasoningEffort, MODEL_REASONING_EFFORTS } from './model-effort.mjs';

// Non-secret room choices that should survive a supervised restart. Provider
// credentials deliberately do not belong here; browser-chat receives those
// through its process environment.

export const ROOM_PREFERENCES_FORMAT = 'fieldwork-room-preferences/v2';
const LEGACY_ROOM_PREFERENCES_FORMAT = 'fieldwork-room-preferences/v1';
export const ROOM_PREFERENCES_LIMITS = Object.freeze({
  fileBytes: 64 * 1024,
  appearanceBytes: 8 * 1024,
  models: 16,
});

const hashPattern = /^[0-9a-f]{64}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function preferenceError(message, cause) {
  return new Error(`Room preferences: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw preferenceError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw preferenceError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw preferenceError(`${where}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function modelId(value, where) {
  if (typeof value !== 'string' || [...value].length < 1 || [...value].length > 200 || /[\s\p{Cc}]/u.test(value)) {
    throw preferenceError(`${where} must be a portable model identifier`);
  }
  return value;
}

function reasoningEffort(value, where) {
  if (value === undefined || value === null) return null;
  if (!isReasoningEffort(value, MODEL_REASONING_EFFORTS)) {
    throw preferenceError(`${where} must be ${MODEL_REASONING_EFFORTS.join(', ')}, or null`);
  }
  return value;
}

function appearanceState(value, where = 'appearance') {
  if (value === null) return null;
  const raw = fields(value, ['revision', 'settings'], where);
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) {
    throw preferenceError(`${where}.revision must be a nonnegative whole number`);
  }
  let settings;
  try {
    settings = boundedJson(raw.settings, {
      where: `${where}.settings`, object: true,
      maxBytes: ROOM_PREFERENCES_LIMITS.appearanceBytes, maxDepth: 8, maxNodes: 128,
    }).value;
  } catch (error) {
    throw preferenceError(error.message, error);
  }
  return deepFreeze({ revision: raw.revision, settings });
}

function modelSelection(value, index, legacy = false) {
  const where = `models[${index}]`;
  const raw = fields(value, legacy
    ? ['service', 'configuredModel', 'selectedModel']
    : ['service', 'configuredModel', 'selectedModel', 'reasoningEffort'], where);
  if (typeof raw.service !== 'string' || !hashPattern.test(raw.service)) {
    throw preferenceError(`${where}.service must be a lowercase SHA-256 hash`);
  }
  return deepFreeze({
    service: raw.service,
    configuredModel: modelId(raw.configuredModel, `${where}.configuredModel`),
    selectedModel: modelId(raw.selectedModel, `${where}.selectedModel`),
    reasoningEffort: legacy ? null : reasoningEffort(raw.reasoningEffort, `${where}.reasoningEffort`),
  });
}

function restore(value) {
  const raw = fields(value, ['format', 'appearance', 'models'], 'preferences');
  if (![ROOM_PREFERENCES_FORMAT, LEGACY_ROOM_PREFERENCES_FORMAT].includes(raw.format)) {
    throw preferenceError('preferences have an unsupported format');
  }
  if (!Array.isArray(raw.models) || raw.models.length > ROOM_PREFERENCES_LIMITS.models) {
    throw preferenceError(`preferences.models must contain at most ${ROOM_PREFERENCES_LIMITS.models} entries`);
  }
  const legacy = raw.format === LEGACY_ROOM_PREFERENCES_FORMAT;
  const models = raw.models.map((row, index) => modelSelection(row, index, legacy));
  const seen = new Set();
  for (const row of models) {
    if (seen.has(row.service)) throw preferenceError(`preferences.models repeats service ${row.service}`);
    seen.add(row.service);
  }
  models.sort((left, right) => left.service.localeCompare(right.service));
  return deepFreeze({
    format: ROOM_PREFERENCES_FORMAT,
    appearance: appearanceState(raw.appearance),
    models,
  });
}

const emptyState = () => deepFreeze({ format: ROOM_PREFERENCES_FORMAT, appearance: null, models: [] });

async function atomicWrite(file, state) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${canonicalJson(state)}\n`, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) {
    try { await fs.unlink(temporary); } catch { /* Preserve the original write failure. */ }
    throw error;
  }
}

export function roomServiceFingerprint({ kind, endpoint = '' } = {}) {
  if (!['openai-compatible', 'chatgpt-subscription'].includes(kind)) {
    throw preferenceError('service kind must be openai-compatible or chatgpt-subscription');
  }
  if (typeof endpoint !== 'string' || endpoint.length > 2048) {
    throw preferenceError('service endpoint must be bounded text');
  }
  return createHash('sha256').update(canonicalJson({ kind, endpoint }), 'utf8').digest('hex');
}

export async function createRoomPreferences({ file } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw preferenceError('file must be an absolute path');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state;
  try {
    const source = await fs.readFile(file);
    if (source.length > ROOM_PREFERENCES_LIMITS.fileBytes) throw preferenceError('preferences file is too large');
    let text;
    try { text = utf8.decode(source); }
    catch (error) { throw preferenceError('preferences file is not valid UTF-8', error); }
    state = restore(parseJsonNoDuplicates(text, { where: 'room preferences', maxDepth: 16 }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw preferenceError(`could not load ${file}: ${error.message}`, error);
    state = emptyState();
  }

  let queue = Promise.resolve();
  const change = update => {
    const job = queue.then(async () => {
      const next = restore(update(state));
      if (canonicalJson(next) !== canonicalJson(state)) await atomicWrite(file, next);
      state = next;
      return state;
    });
    queue = job.then(() => undefined, () => undefined);
    return job;
  };

  return Object.freeze({
    file,

    snapshot() {
      return state;
    },

    selectedModel({ service, configuredModel } = {}) {
      if (typeof service !== 'string' || !hashPattern.test(service)) throw preferenceError('service must be a lowercase SHA-256 hash');
      const configured = modelId(configuredModel, 'configuredModel');
      const saved = state.models.find(row => row.service === service);
      return saved?.configuredModel === configured ? saved.selectedModel : configured;
    },

    selectedReasoningEffort({ service, configuredModel } = {}) {
      if (typeof service !== 'string' || !hashPattern.test(service)) throw preferenceError('service must be a lowercase SHA-256 hash');
      const configured = modelId(configuredModel, 'configuredModel');
      const saved = state.models.find(row => row.service === service);
      return saved?.configuredModel === configured ? saved.reasoningEffort : null;
    },

    saveAppearance(value) {
      const appearance = appearanceState(value);
      return change(before => ({ ...before, appearance }));
    },

    saveModel({ service, configuredModel, selectedModel, reasoningEffort: requestedEffort = null } = {}) {
      if (typeof service !== 'string' || !hashPattern.test(service)) throw preferenceError('service must be a lowercase SHA-256 hash');
      const next = deepFreeze({
        service,
        configuredModel: modelId(configuredModel, 'configuredModel'),
        selectedModel: modelId(selectedModel, 'selectedModel'),
        reasoningEffort: reasoningEffort(requestedEffort, 'reasoningEffort'),
      });
      return change(before => ({
        ...before,
        models: [...before.models.filter(row => row.service !== service), next]
          .sort((left, right) => left.service.localeCompare(right.service)),
      }));
    },
  });
}
