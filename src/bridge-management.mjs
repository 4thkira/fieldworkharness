import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';
import { readStableFile, StableFileReadError } from './stable-file-read.mjs';

// Bridge destinations belong to the active agent's state. Bot tokens do not:
// the launcher keeps them in a separate ignored supervisor store and passes
// only the active token to a freshly spawned room.

export const BRIDGE_SETTINGS_FORMAT = 'fieldwork-bridges/v1';
export const BRIDGE_SECRETS_FORMAT = 'fieldwork-bridge-secrets/v1';
export const BRIDGE_COMMAND_FORMAT = 'fieldwork-bridge-command/v1';
export const BRIDGE_PUBLIC_FORMAT = 'fieldwork-bridge-status/v1';
export const BRIDGE_LIMITS = Object.freeze({
  fileBytes: 32 * 1024,
  tokenCharacters: 4096,
  identifierCharacters: 32,
});
export const BRIDGE_BINDING_STATES = Object.freeze(['unbound', 'saved', 'live-unsaved']);

const platforms = new Set(['telegram', 'discord']);
const tokenSources = new Set(['none', 'saved', 'environment']);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const decimalId = /^-?[1-9][0-9]{0,31}$/;
const positiveId = /^[1-9][0-9]{0,31}$/;
const conversationId = /^conv-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bridgeError(message, cause) {
  return new Error(`Bridge management: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw bridgeError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw bridgeError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw bridgeError(`${where}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function platform(value, where = 'platform') {
  if (typeof value !== 'string' || !platforms.has(value)) {
    throw bridgeError(`${where} must be telegram or discord`);
  }
  return value;
}

function id(value, where, { negative = false, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !(negative ? decimalId : positiveId).test(value)) {
    throw bridgeError(`${where} must be a decimal platform identifier${negative ? ' (negative chat IDs are allowed)' : ''}`);
  }
  return value;
}

function optionalConversation(value, where) {
  if (value === null) return null;
  if (typeof value !== 'string' || !conversationId.test(value)) {
    throw bridgeError(`${where} must be null or a Fieldwork conversation id`);
  }
  return value;
}

function route(value, which, where = `${which} route`) {
  if (value === null) return null;
  if (which === 'telegram') {
    const raw = fields(value, ['chatId', 'allowedUserId', 'scope', 'respondTo', 'conversationId'], where);
    if (!['direct', 'group'].includes(raw.scope)) throw bridgeError(`${where}.scope must be direct or group`);
    const respondTo = raw.respondTo;
    if ((raw.scope === 'direct' && respondTo !== 'all') || (raw.scope === 'group' && respondTo !== 'mention')) {
      throw bridgeError(`${where}.respondTo must be all for a direct chat or mention for a group`);
    }
    const chatId = id(raw.chatId, `${where}.chatId`, { negative: true });
    if ((raw.scope === 'direct') !== !chatId.startsWith('-')) {
      throw bridgeError(`${where}.chatId must be positive for a direct chat and negative for a group`);
    }
    return deepFreeze({
      chatId,
      allowedUserId: id(raw.allowedUserId, `${where}.allowedUserId`),
      scope: raw.scope,
      respondTo,
      conversationId: optionalConversation(raw.conversationId, `${where}.conversationId`),
    });
  }
  const raw = fields(value, ['channelId', 'guildId', 'allowedUserId', 'scope', 'respondTo', 'conversationId'], where);
  if (!['direct', 'guild'].includes(raw.scope)) throw bridgeError(`${where}.scope must be direct or guild`);
  if ((raw.scope === 'direct' && raw.respondTo !== 'all') || (raw.scope === 'guild' && raw.respondTo !== 'mention')) {
    throw bridgeError(`${where}.respondTo must be all for a direct message or mention for a guild channel`);
  }
  const guildId = id(raw.guildId, `${where}.guildId`, { nullable: true });
  if ((raw.scope === 'direct') !== (guildId === null)) {
    throw bridgeError(`${where}.guildId must be null for a direct message and present for a guild channel`);
  }
  return deepFreeze({
    channelId: id(raw.channelId, `${where}.channelId`),
    guildId,
    allowedUserId: id(raw.allowedUserId, `${where}.allowedUserId`),
    scope: raw.scope,
    respondTo: raw.respondTo,
    conversationId: optionalConversation(raw.conversationId, `${where}.conversationId`),
  });
}

const emptySettings = () => deepFreeze({ format: BRIDGE_SETTINGS_FORMAT, telegram: null, discord: null });
const emptySecrets = () => deepFreeze({ format: BRIDGE_SECRETS_FORMAT, telegramToken: null, discordToken: null });

function settingsProjection(value) {
  const raw = fields(value, ['format', 'telegram', 'discord'], 'bridge settings');
  if (raw.format !== BRIDGE_SETTINGS_FORMAT) throw bridgeError('bridge settings have an unsupported format');
  return deepFreeze({
    format: BRIDGE_SETTINGS_FORMAT,
    telegram: route(raw.telegram, 'telegram'),
    discord: route(raw.discord, 'discord'),
  });
}

function token(value, where) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > BRIDGE_LIMITS.tokenCharacters || /[\s\p{Cc}]/u.test(value)) {
    throw bridgeError(`${where} must be 1-${BRIDGE_LIMITS.tokenCharacters} characters without whitespace or control characters`);
  }
  return value;
}

function secretsProjection(value) {
  const raw = fields(value, ['format', 'telegramToken', 'discordToken'], 'bridge secret store');
  if (raw.format !== BRIDGE_SECRETS_FORMAT) throw bridgeError('bridge secret store has an unsupported format');
  return deepFreeze({
    format: BRIDGE_SECRETS_FORMAT,
    telegramToken: token(raw.telegramToken, 'bridge secret store.telegramToken'),
    discordToken: token(raw.discordToken, 'bridge secret store.discordToken'),
  });
}

async function loadJson(file, missing, project, where) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw bridgeError(`${where} file must be an absolute path`);
  let bytes;
  if (where === 'bridge secret store') {
    try {
      bytes = await readStableFile(file, {
        maxBytes: BRIDGE_LIMITS.fileBytes,
        allowMissing: true,
        label: where,
      });
    } catch (error) {
      if (error instanceof StableFileReadError && error.reason === 'oversized') {
        throw bridgeError(`${where} is too large`, error);
      }
      throw bridgeError(`could not read ${where}: ${error.message}`, error);
    }
    if (bytes === null) return missing();
  } else {
    try { bytes = await fs.readFile(file); }
    catch (error) {
      if (error.code === 'ENOENT') return missing();
      throw bridgeError(`could not read ${where}: ${error.message}`, error);
    }
    if (bytes.length > BRIDGE_LIMITS.fileBytes) throw bridgeError(`${where} is too large`);
  }
  let text;
  try { text = utf8.decode(bytes); }
  catch (error) { throw bridgeError(`${where} is not valid UTF-8`, error); }
  let parsed;
  try { parsed = parseJsonNoDuplicates(text, { where, maxDepth: 8 }); }
  catch (error) {
    if (where === 'bridge secret store') throw bridgeError('bridge secret store is not valid JSON');
    throw bridgeError(error.message.replace(/^Bridge management: /, ''), error);
  }
  try { return project(parsed); }
  catch (error) {
    if (where === 'bridge secret store') throw bridgeError('bridge secret store has invalid data');
    throw bridgeError(error.message.replace(/^Bridge management: /, ''), error);
  }
}

async function atomicSave(file, value, { secret = false, removeWhenEmpty = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (removeWhenEmpty) {
    await fs.rm(file, { force: true });
    return value;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { flag: 'wx', ...(secret ? { mode: 0o600 } : {}) });
  try { await fs.rename(temporary, file); }
  catch (error) {
    try { await fs.rm(temporary, { force: true }); } catch { /* Preserve the write failure. */ }
    throw bridgeError(`could not save ${secret ? 'bridge secrets' : 'bridge settings'}: ${error.message}`, error);
  }
  return value;
}

export function bridgeSettingsFileFor(agentHome) {
  if (typeof agentHome !== 'string' || !path.isAbsolute(agentHome)) throw bridgeError('agent home must be an absolute path');
  return path.join(agentHome, 'state', 'bridges.json');
}

export function bridgeSecretsFileFor(settingsFile) {
  if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) throw bridgeError('settings file must be an absolute path');
  const extension = path.extname(settingsFile);
  const stem = extension ? path.basename(settingsFile, extension) : path.basename(settingsFile);
  return path.join(path.dirname(settingsFile), `${stem}.bridges.secrets.json`);
}

export const loadBridgeSettings = file => loadJson(file, emptySettings, settingsProjection, 'bridge settings');
export const loadBridgeSecrets = file => loadJson(file, emptySecrets, secretsProjection, 'bridge secret store');

export async function saveBridgeSettings(file, value) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw bridgeError('bridge settings file must be an absolute path');
  return atomicSave(file, settingsProjection(value));
}

export async function saveBridgeSecrets(file, value) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw bridgeError('bridge secret file must be an absolute path');
  const projected = secretsProjection(value);
  return atomicSave(file, projected, {
    secret: true,
    removeWhenEmpty: projected.telegramToken === null && projected.discordToken === null,
  });
}

function commandProjection(value) {
  const raw = fields(value, [
    'format', 'action', 'platform', 'token', 'destinationId', 'guildId', 'allowedUserId', 'scope',
    'groupConfirmation', 'confirmation',
  ], 'bridge command');
  if (raw.format !== BRIDGE_COMMAND_FORMAT) throw bridgeError(`bridge command.format must be ${BRIDGE_COMMAND_FORMAT}`);
  if (!['configure', 'disconnect', 'forget-token'].includes(raw.action)) throw bridgeError('bridge command.action is not supported');
  const which = platform(raw.platform, 'bridge command.platform');
  if (raw.action !== 'configure') {
    const expected = raw.action === 'disconnect' ? `DISCONNECT ${which.toUpperCase()}` : `FORGET ${which.toUpperCase()} TOKEN`;
    if (raw.confirmation !== expected) throw bridgeError(`type ${expected} to confirm`);
    for (const key of Object.keys(raw)) {
      if (!['format', 'action', 'platform', 'confirmation'].includes(key)) {
        throw bridgeError(`bridge command.${raw.action} does not accept ${key}`);
      }
    }
    return deepFreeze({ format: raw.format, action: raw.action, platform: which, confirmation: raw.confirmation });
  }
  if (raw.confirmation !== undefined) throw bridgeError('bridge command.configure does not accept confirmation');
  if (raw.destinationId === undefined || raw.allowedUserId === undefined || raw.scope === undefined) {
    throw bridgeError('bridge command.configure needs destinationId, allowedUserId, and scope');
  }
  if (raw.token !== undefined) raw.token = token(raw.token, 'bridge command.token');
  if (which === 'telegram') {
    if (!['direct', 'group'].includes(raw.scope)) throw bridgeError('Telegram scope must be direct or group');
    if (raw.guildId !== undefined) throw bridgeError('a Telegram connection does not accept guildId');
    if (raw.token !== undefined && !/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,200}$/.test(raw.token)) {
      throw bridgeError('Telegram token must have the BotFather numeric-id:secret form');
    }
  } else if (!['direct', 'guild'].includes(raw.scope)) {
    throw bridgeError('Discord scope must be direct or guild');
  }
  const grouped = raw.scope !== 'direct';
  if (which === 'discord' && !grouped && raw.guildId !== undefined) {
    throw bridgeError('a direct Discord destination does not accept guildId');
  }
  if (grouped && raw.groupConfirmation !== 'ALLOW GROUP LISTENING') {
    throw bridgeError('type ALLOW GROUP LISTENING to confirm a group or guild destination');
  }
  if (!grouped && raw.groupConfirmation !== undefined) {
    throw bridgeError('a direct destination does not accept groupConfirmation');
  }
  return deepFreeze({
    format: raw.format,
    action: raw.action,
    platform: which,
    ...(raw.token === undefined ? {} : { token: raw.token }),
    destinationId: id(raw.destinationId, 'bridge command.destinationId', { negative: which === 'telegram' }),
    ...(which === 'discord' ? { guildId: grouped ? id(raw.guildId, 'bridge command.guildId') : null } : {}),
    allowedUserId: id(raw.allowedUserId, 'bridge command.allowedUserId'),
    scope: raw.scope,
  });
}

function configuredRoute(command, before) {
  const sameDestination = command.platform === 'telegram'
    ? before?.chatId === command.destinationId
    : before?.channelId === command.destinationId;
  // A bound conversation belongs to the complete route identity, not merely
  // its destination. Reusing it after the allowed person, scope, or Discord
  // server changes could expose the former participant's conversation to a
  // newly authorized account. Rotating only the bot token is safe because it
  // does not change who or where the route admits.
  const sameRouteIdentity = sameDestination
    && before?.allowedUserId === command.allowedUserId
    && before?.scope === command.scope
    && (command.platform === 'telegram' || before?.guildId === command.guildId);
  const shared = {
    allowedUserId: command.allowedUserId,
    scope: command.scope,
    respondTo: command.scope === 'direct' ? 'all' : 'mention',
    conversationId: sameRouteIdentity ? before.conversationId : null,
  };
  return command.platform === 'telegram'
    ? route({ chatId: command.destinationId, ...shared }, 'telegram')
    : route({ channelId: command.destinationId, guildId: command.guildId, ...shared }, 'discord');
}

function bindingProjection(value) {
  const raw = fields(value, [
    'platform', 'destinationId', 'guildId', 'allowedUserId', 'scope', 'conversationId',
  ], 'bridge conversation binding');
  const which = platform(raw.platform, 'bridge conversation binding.platform');
  const bound = optionalConversation(raw.conversationId, 'bridge conversation binding.conversationId');
  if (bound === null) throw bridgeError('bridge conversation binding.conversationId must name a conversation');
  if (which === 'telegram' && raw.guildId !== undefined) {
    throw bridgeError('a Telegram conversation binding does not accept guildId');
  }
  const expected = which === 'telegram'
    ? route({
      chatId: raw.destinationId,
      allowedUserId: raw.allowedUserId,
      scope: raw.scope,
      respondTo: raw.scope === 'direct' ? 'all' : 'mention',
      conversationId: null,
    }, 'telegram', 'bridge conversation binding route')
    : route({
      channelId: raw.destinationId,
      guildId: raw.guildId,
      allowedUserId: raw.allowedUserId,
      scope: raw.scope,
      respondTo: raw.scope === 'direct' ? 'all' : 'mention',
      conversationId: null,
    }, 'discord', 'bridge conversation binding route');
  return deepFreeze({
    platform: which,
    destinationId: which === 'telegram' ? expected.chatId : expected.channelId,
    ...(which === 'discord' ? { guildId: expected.guildId } : {}),
    allowedUserId: expected.allowedUserId,
    scope: expected.scope,
    conversationId: bound,
  });
}

function routeIdentityMatches(current, expected) {
  const destination = expected.platform === 'telegram' ? current.chatId : current.channelId;
  return destination === expected.destinationId
    && current.allowedUserId === expected.allowedUserId
    && current.scope === expected.scope
    && (expected.platform === 'telegram' || current.guildId === expected.guildId);
}

function bindingRequest(which, current, bound) {
  const destinationId = Object.hasOwn(current, 'destinationId')
    ? current.destinationId
    : which === 'telegram' ? current.chatId : current.channelId;
  return deepFreeze({
    platform: which,
    destinationId,
    ...(which === 'discord' ? { guildId: current.guildId } : {}),
    allowedUserId: current.allowedUserId,
    scope: current.scope,
    conversationId: bound,
  });
}

export async function applyBridgeCommand({ settingsFile, secretsFile, command } = {}) {
  const raw = commandProjection(command);
  const [beforeSettings, beforeSecrets] = await Promise.all([
    loadBridgeSettings(settingsFile),
    loadBridgeSecrets(secretsFile),
  ]);
  const tokenField = `${raw.platform}Token`;
  let nextSettings = beforeSettings;
  let nextSecrets = beforeSecrets;
  if (raw.action === 'configure') {
    nextSettings = settingsProjection({
      ...beforeSettings,
      [raw.platform]: configuredRoute(raw, beforeSettings[raw.platform]),
    });
    if (raw.token !== undefined) nextSecrets = secretsProjection({ ...beforeSecrets, [tokenField]: raw.token });
  } else if (raw.action === 'disconnect') {
    nextSettings = settingsProjection({ ...beforeSettings, [raw.platform]: null });
  } else {
    nextSecrets = secretsProjection({ ...beforeSecrets, [tokenField]: null });
  }

  const secretChanged = nextSecrets[tokenField] !== beforeSecrets[tokenField];
  if (secretChanged) await saveBridgeSecrets(secretsFile, nextSecrets);
  try {
    if (nextSettings !== beforeSettings) await saveBridgeSettings(settingsFile, nextSettings);
  } catch (error) {
    if (secretChanged) {
      try { await saveBridgeSecrets(secretsFile, beforeSecrets); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Bridge update and secret rollback both failed'); }
    }
    throw error;
  }
  return deepFreeze({ action: raw.action, platform: raw.platform, settings: nextSettings, secretChanged });
}

export async function bindBridgeConversation(file, request = {}) {
  const expected = bindingProjection(request);
  const name = expected.platform;
  const settings = await loadBridgeSettings(file);
  const current = settings[name];
  if (!current) throw bridgeError(`${name} is not configured`);
  if (!routeIdentityMatches(current, expected)) {
    throw bridgeError(`${name} route identity changed before conversation binding`);
  }
  if (current.conversationId === expected.conversationId) return settings;
  if (current.conversationId !== null) {
    throw bridgeError(`${name} route is already bound to a different conversation`);
  }
  const next = settingsProjection({
    ...settings,
    [name]: { ...current, conversationId: expected.conversationId },
  });
  await saveBridgeSettings(file, next);
  return next;
}

export function createBridgeBindingCoordinator(options = {}) {
  const raw = fields(options, ['settings', 'bind'], 'bridge binding coordinator options');
  const initial = settingsProjection(raw.settings);
  if (typeof raw.bind !== 'function') throw bridgeError('bridge binding coordinator.bind must be a function');
  const bind = raw.bind;
  const live = {
    telegram: initial.telegram ? { ...bindingRequest('telegram', initial.telegram, initial.telegram.conversationId) } : null,
    discord: initial.discord ? { ...bindingRequest('discord', initial.discord, initial.discord.conversationId) } : null,
  };
  const durable = {
    telegram: live.telegram?.conversationId !== null,
    discord: live.discord?.conversationId !== null,
  };
  let queue = Promise.resolve();

  const view = which => {
    const name = platform(which, 'bridge binding coordinator platform');
    const current = live[name];
    const state = !current || current.conversationId === null
      ? 'unbound'
      : durable[name] ? 'saved' : 'live-unsaved';
    return deepFreeze({
      state,
      ...(current ? { ...current } : { platform: name, conversationId: null }),
    });
  };

  const adopt = (which, bound) => {
    const name = platform(which, 'bridge binding coordinator platform');
    const current = live[name];
    if (!current) throw bridgeError(`${name} is not configured`);
    const conversation = optionalConversation(bound, 'bridge binding coordinator conversationId');
    if (conversation === null) throw bridgeError('bridge binding coordinator conversationId must name a conversation');
    if (current.conversationId !== null && current.conversationId !== conversation) {
      throw bridgeError(`${name} live route is already bound to a different conversation`);
    }
    if (current.conversationId === null) {
      current.conversationId = conversation;
      durable[name] = false;
    }
    return view(name);
  };

  const ensure = which => {
    const name = platform(which, 'bridge binding coordinator platform');
    const operation = queue.then(async () => {
      const current = live[name];
      if (!current || current.conversationId === null || durable[name]) return null;
      const saved = await bind(bindingRequest(name, current, current.conversationId));
      durable[name] = true;
      return saved;
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return Object.freeze({
    adopt,
    ensure,
    view,
    drain: () => queue,
  });
}

export function publicBridgeSettings(settings, { sources = {}, live = {}, bindings = {} } = {}) {
  const current = settingsProjection(settings);
  const rows = Object.create(null);
  for (const name of platforms) {
    const source = sources[name] ?? 'none';
    if (!tokenSources.has(source)) throw bridgeError(`sources.${name} must be none, saved, or environment`);
    const observed = live[name];
    let state = observed;
    let detail;
    if (isPlainObject(observed)) {
      const projected = fields(observed, ['state', 'detail'], `live.${name}`);
      state = projected.state;
      if (projected.detail !== undefined) {
        if (typeof projected.detail !== 'string' || !projected.detail.trim()
          || projected.detail.length > 500 || /\p{Cc}/u.test(projected.detail)) {
          throw bridgeError(`live.${name}.detail must be bounded visible text`);
        }
        detail = projected.detail;
      }
    }
    state ??= current[name] ? source === 'none' ? 'missing-token' : 'saved' : 'not-configured';
    if (!['not-configured', 'missing-token', 'saved', 'connecting', 'connected', 'paused', 'failed'].includes(state)) {
      throw bridgeError(`live.${name} is not a public bridge state`);
    }
    const binding = bindings[name] ?? (current[name]?.conversationId ? 'saved' : 'unbound');
    if (!BRIDGE_BINDING_STATES.includes(binding)) throw bridgeError(`bindings.${name} is not supported`);
    if ((binding === 'unbound') !== (current[name]?.conversationId == null)) {
      throw bridgeError(`bindings.${name} is inconsistent with its conversation`);
    }
    rows[name] = deepFreeze({
      configured: Boolean(current[name]),
      token: { source, available: source !== 'none', canSave: true, canForget: source === 'saved' },
      state,
      binding,
      ...(detail === undefined ? {} : { detail }),
      ...(current[name] ? { route: current[name] } : {}),
    });
  }
  return deepFreeze({ format: BRIDGE_PUBLIC_FORMAT, telegram: rows.telegram, discord: rows.discord });
}
