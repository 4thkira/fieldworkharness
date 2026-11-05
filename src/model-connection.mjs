import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeManagedSettings, saveManagedSettings } from './agent-management.mjs';
import { canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';
import { parseBaseURL } from './openai-chat-provider.mjs';
import { readStableFile, StableFileReadError } from './stable-file-read.mjs';

// Model-service settings belong to the launcher, not to an agent home. The
// public projection never contains credentials. A room may submit a new key to
// its supervisor once, but only the supervisor reads and writes the secret
// store and only a freshly spawned room receives the effective key.

export const MODEL_CONNECTION_FORMAT = 'fieldwork-model-connection/v1';
export const MODEL_CONNECTION_COMMAND_FORMAT = 'fieldwork-model-connection-command/v1';
export const FIELDWORK_SECRETS_FORMAT = 'fieldwork-supervisor-secrets/v1';
export const MODEL_CONNECTION_LIMITS = Object.freeze({
  modelCharacters: 200,
  baseURLCharacters: 2048,
  apiKeyCharacters: 4096,
  secretFileBytes: 16 * 1024,
});

const services = new Set(['openai-compatible', 'chatgpt-subscription']);
const keySources = new Set(['none', 'saved', 'environment']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

function connectionError(message, cause) {
  return new Error(`Model connection: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw connectionError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw connectionError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw connectionError(`${where}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function modelId(value, where = 'model') {
  if (typeof value !== 'string' || [...value].length < 1
    || [...value].length > MODEL_CONNECTION_LIMITS.modelCharacters
    || /[\s\p{Cc}]/u.test(value)) {
    throw connectionError(`${where} must be a portable model identifier of 1-${MODEL_CONNECTION_LIMITS.modelCharacters} characters`);
  }
  return value;
}

function baseURL(value, where = 'baseURL') {
  if (typeof value !== 'string' || [...value].length > MODEL_CONNECTION_LIMITS.baseURLCharacters) {
    throw connectionError(`${where} must be a bounded URL`);
  }
  try { parseBaseURL(value); }
  catch (error) { throw connectionError(error.message.replace(/^OpenAI chat provider: /, ''), error); }
  return new URL(value).href.replace(/\/+$/, '');
}

function apiKey(value, where = 'apiKey') {
  if (typeof value !== 'string' || !value
    || value.length > MODEL_CONNECTION_LIMITS.apiKeyCharacters
    || /[\s\p{Cc}]/u.test(value)) {
    throw connectionError(`${where} must be 1-${MODEL_CONNECTION_LIMITS.apiKeyCharacters} characters without whitespace or control characters`);
  }
  return value;
}

function service(value, where = 'service') {
  if (typeof value !== 'string' || !services.has(value)) {
    throw connectionError(`${where} must be openai-compatible or chatgpt-subscription`);
  }
  return value;
}

export function secretsFileFor(settingsFile) {
  if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) {
    throw connectionError('settings file must be an absolute path');
  }
  const extension = path.extname(settingsFile);
  const stem = extension ? path.basename(settingsFile, extension) : path.basename(settingsFile);
  return path.join(path.dirname(settingsFile), `${stem}.secrets.json`);
}

const emptySecrets = () => deepFreeze({ format: FIELDWORK_SECRETS_FORMAT, baseURL: null, apiKey: null });

function restoreSecrets(value) {
  const raw = fields(value, ['format', 'baseURL', 'apiKey'], 'secret store');
  if (raw.format !== FIELDWORK_SECRETS_FORMAT) throw connectionError('secret store has an unsupported format');
  if (raw.baseURL === null && raw.apiKey === null) return emptySecrets();
  if (raw.baseURL == null || raw.apiKey == null) {
    throw connectionError('secret store must bind its API key to one model-service URL');
  }
  return deepFreeze({
    format: FIELDWORK_SECRETS_FORMAT,
    baseURL: baseURL(raw.baseURL, 'secret store.baseURL'),
    apiKey: apiKey(raw.apiKey, 'secret store.apiKey'),
  });
}

export async function loadFieldworkSecrets(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw connectionError('secret file must be an absolute path');
  let source;
  try {
    source = await readStableFile(file, {
      maxBytes: MODEL_CONNECTION_LIMITS.secretFileBytes,
      allowMissing: true,
      label: 'secret store',
    });
  }
  catch (error) {
    if (error instanceof StableFileReadError && error.reason === 'oversized') {
      throw connectionError('secret store is too large', error);
    }
    throw connectionError(`could not read the secret store: ${error.message}`, error);
  }
  if (source === null) return emptySecrets();
  let text;
  try { text = utf8.decode(source); }
  catch (error) { throw connectionError('secret store is not valid UTF-8', error); }
  let parsed;
  try { parsed = parseJsonNoDuplicates(text, { where: 'Fieldwork secret store', maxDepth: 4 }); }
  catch { throw connectionError('secret store is not valid JSON'); }
  try { return restoreSecrets(parsed); }
  catch { throw connectionError('secret store has invalid data'); }
}

export async function saveFieldworkSecrets(file, value) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw connectionError('secret file must be an absolute path');
  const raw = fields(value, ['baseURL', 'apiKey'], 'secret update');
  let next;
  if (raw.apiKey == null) {
    if (raw.baseURL != null) throw connectionError('secret update.baseURL cannot remain without an API key');
    next = emptySecrets();
  } else {
    if (raw.baseURL == null) throw connectionError('secret update.baseURL is required with an API key');
    next = deepFreeze({
      format: FIELDWORK_SECRETS_FORMAT,
      baseURL: baseURL(raw.baseURL, 'secret update.baseURL'),
      apiKey: apiKey(raw.apiKey),
    });
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (next.apiKey === null) {
    await fs.rm(file, { force: true });
    return next;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${canonicalJson(next)}\n`, { flag: 'wx', mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) {
    try { await fs.rm(temporary, { force: true }); } catch { /* Preserve the write failure. */ }
    throw connectionError(`could not save the secret store: ${error.message}`, error);
  }
  return next;
}

function normalizedConnection(settings) {
  const managed = normalizeManagedSettings(settings);
  const kind = service(managed.service);
  const model = modelId(managed.model);
  return kind === 'chatgpt-subscription'
    ? { settings: managed, service: kind, model }
    : { settings: managed, service: kind, model, baseURL: baseURL(managed.baseURL) };
}

export function effectiveModelApiKey(settings, secrets, environmentApiKey = null) {
  const current = normalizedConnection(settings);
  const stored = restoreSecrets(secrets);
  if (current.service === 'chatgpt-subscription') {
    return deepFreeze({ key: null, source: 'none' });
  }
  if (stored.apiKey && stored.baseURL === current.baseURL) {
    return deepFreeze({ key: stored.apiKey, source: 'saved' });
  }
  if (environmentApiKey) {
    return deepFreeze({ key: apiKey(environmentApiKey, 'FIELDWORK_API_KEY'), source: 'environment' });
  }
  return deepFreeze({ key: null, source: 'none' });
}

export function publicModelConnection(settings, {
  apiKeySource = 'none',
  savedKeyPresent = apiKeySource === 'saved',
} = {}) {
  const current = normalizedConnection(settings);
  if (!keySources.has(apiKeySource)) throw connectionError('apiKeySource must be none, saved, or environment');
  if (typeof savedKeyPresent !== 'boolean') throw connectionError('savedKeyPresent must be boolean');
  if (current.service === 'chatgpt-subscription') {
    return deepFreeze({
      format: MODEL_CONNECTION_FORMAT,
      service: current.service,
      model: current.model,
      access: { kind: 'subscription', status: 'ready', source: 'codex', canSave: false, canForget: savedKeyPresent },
    });
  }
  const target = new URL(current.baseURL);
  const local = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  const keyed = apiKeySource !== 'none';
  return deepFreeze({
    format: MODEL_CONNECTION_FORMAT,
    service: current.service,
    baseURL: current.baseURL,
    model: current.model,
    access: {
      kind: keyed ? 'api-key' : local ? 'none' : 'api-key',
      status: keyed ? 'ready' : local ? 'not-needed' : 'missing',
      source: apiKeySource,
      canSave: true,
      canForget: savedKeyPresent,
    },
  });
}

function commandProjection(value) {
  const raw = fields(value, ['format', 'action', 'service', 'baseURL', 'model', 'apiKey', 'confirmation'], 'connection command');
  if (raw.format !== MODEL_CONNECTION_COMMAND_FORMAT) {
    throw connectionError(`connection command.format must be ${MODEL_CONNECTION_COMMAND_FORMAT}`);
  }
  if (!['configure', 'forget-api-key'].includes(raw.action)) throw connectionError('connection command.action is not supported');
  if (raw.action === 'forget-api-key') {
    if (raw.confirmation !== 'FORGET API KEY') throw connectionError('type FORGET API KEY to confirm');
    for (const key of Object.keys(raw)) {
      if (!['format', 'action', 'confirmation'].includes(key)) throw connectionError(`connection command.${raw.action} does not accept ${key}`);
    }
    return deepFreeze({ format: raw.format, action: raw.action, confirmation: raw.confirmation });
  }
  const kind = service(raw.service, 'connection command.service');
  const model = modelId(raw.model, 'connection command.model');
  if (raw.confirmation !== undefined) throw connectionError('connection command.configure does not accept confirmation');
  if (kind === 'chatgpt-subscription') {
    if (raw.baseURL !== undefined || raw.apiKey !== undefined) {
      throw connectionError('a ChatGPT subscription connection does not accept baseURL or apiKey');
    }
    return deepFreeze({ format: raw.format, action: raw.action, service: kind, model });
  }
  if (raw.baseURL === undefined) throw connectionError('connection command.configure needs baseURL');
  return deepFreeze({
    format: raw.format,
    action: raw.action,
    service: kind,
    baseURL: baseURL(raw.baseURL, 'connection command.baseURL'),
    model,
    ...(raw.apiKey === undefined ? {} : { apiKey: apiKey(raw.apiKey, 'connection command.apiKey') }),
  });
}

export async function applyModelConnectionCommand({
  settings,
  settingsFile,
  secretsFile,
  command,
  subscriptionReady = async () => true,
} = {}) {
  const before = normalizeManagedSettings(settings);
  const raw = commandProjection(command);
  if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) throw connectionError('settingsFile must be an absolute path');
  if (typeof secretsFile !== 'string' || !path.isAbsolute(secretsFile)) throw connectionError('secretsFile must be an absolute path');
  if (typeof subscriptionReady !== 'function') throw connectionError('subscriptionReady must be a function');

  if (raw.action === 'forget-api-key') {
    await saveFieldworkSecrets(secretsFile, { apiKey: null });
    return deepFreeze({ action: raw.action, settings: before, secretChanged: true });
  }

  if (raw.service === 'chatgpt-subscription' && !(await subscriptionReady())) {
    throw connectionError('no ChatGPT sign-in was found; sign in through Codex before choosing the subscription connection');
  }
  let candidate;
  if (raw.service === 'chatgpt-subscription') {
    const { baseURL: _unused, ...withoutBaseURL } = before;
    candidate = { ...withoutBaseURL, service: raw.service, model: raw.model };
  } else {
    candidate = { ...before, service: raw.service, baseURL: raw.baseURL, model: raw.model };
  }

  const saved = await saveManagedSettings(settingsFile, candidate);
  if (raw.apiKey === undefined) return deepFreeze({ action: raw.action, settings: saved, secretChanged: false });
  try {
    await saveFieldworkSecrets(secretsFile, { baseURL: raw.baseURL, apiKey: raw.apiKey });
  } catch (error) {
    try { await saveManagedSettings(settingsFile, before); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Model connection update and rollback both failed');
    }
    throw error;
  }
  return deepFreeze({ action: raw.action, settings: saved, secretChanged: true });
}
