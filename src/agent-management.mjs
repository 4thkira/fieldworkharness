import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';
import {
  exportPortableAgent,
  finalizePortableAgentImport,
  importPortableAgent,
  inspectPortableAgent,
  PORTABLE_AGENT_INCOMPLETE_MARKER,
} from './agent-portability.mjs';
import { loadProfile } from './profile.mjs';
import { readStableFile, StableFileReadError } from './stable-file-read.mjs';

export const AGENT_REGISTRY_FORMAT = 'fieldwork-agent-registry/v1';
export const AGENT_BACKUP_REGISTRY_FORMAT = 'fieldwork-agent-backups/v1';
export const AGENT_COMMAND_FORMAT = 'fieldwork-agent-command/v1';
export const AGENT_MANAGEMENT_LIMITS = Object.freeze({
  agents: 32,
  backups: 256,
  nameCharacters: 80,
  settingsFileBytes: 64 * 1024,
});

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const backupIdPattern = /^(state|agent)-[0-9a-f]{64}$/;
const backupTimestampSource = '(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z';
const stateBackupPattern = new RegExp(`^state-${backupTimestampSource}-[0-9a-f]{8}$`, 'i');
export const FIELDWORK_EXPERT_PRESET_ID = 'fieldwork-expert';

function agentError(message, cause) {
  return new Error(`Agent management: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw agentError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw agentError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw agentError(`${where}.${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function name(value, where = 'name') {
  if (typeof value !== 'string') throw agentError(`${where} must be text`);
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || [...normalized].length > AGENT_MANAGEMENT_LIMITS.nameCharacters || /\p{Cc}/u.test(normalized)) {
    throw agentError(`${where} must be 1-${AGENT_MANAGEMENT_LIMITS.nameCharacters} visible characters`);
  }
  return normalized;
}

function absolute(value, where) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw agentError(`${where} must be an absolute path`);
  return path.resolve(value);
}

function userPath(value, where) {
  if (typeof value !== 'string' || !value.trim()) throw agentError(`${where} must be a path`);
  const entered = value.trim();
  if (entered === '~') return path.resolve(os.homedir());
  if (/^~[\\/]/.test(entered)) return path.resolve(os.homedir(), entered.slice(2));
  return path.isAbsolute(entered) ? path.resolve(entered) : path.resolve(os.homedir(), entered);
}

async function ensureRealDirectory(directory, where) {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw agentError(`${where} must be a real directory, not a link`);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const created = await fs.mkdir(directory, { recursive: true });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw agentError(`${where} must be a real directory, not a link`);
    return created !== undefined;
  }
}

async function realDirectoryPath(directory, where) {
  const target = path.resolve(directory);
  let info;
  try { info = await fs.lstat(target); }
  catch (error) { throw agentError(`${where} is not available`, error); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw agentError(`${where} must be a real directory, not a link`);
  const canonical = path.resolve(await fs.realpath(target));
  const canonicalInfo = await fs.lstat(canonical);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) throw agentError(`${where} must resolve to a real directory`);
  return canonical;
}

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function slug(value) {
  const result = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return result && /^[a-z0-9]/.test(result) ? result : 'agent';
}

function uniqueId(preferred, used) {
  const base = idPattern.test(preferred) ? preferred : slug(preferred);
  if (!used.has(base)) return base;
  for (let number = 2; number < 10_000; number++) {
    const suffix = `-${number}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw agentError('could not make a unique agent id');
}

function agentRow(value, index) {
  const raw = fields(value, ['id', 'name', 'home', 'preset'], `agents[${index}]`);
  if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw agentError(`agents[${index}].id must be a lowercase portable id`);
  if (raw.preset !== undefined && raw.preset !== FIELDWORK_EXPERT_PRESET_ID) {
    throw agentError(`agents[${index}].preset is not supported`);
  }
  return deepFreeze({
    id: raw.id,
    name: name(raw.name, `agents[${index}].name`),
    home: absolute(raw.home, `agents[${index}].home`),
    ...(raw.preset === undefined ? {} : { preset: raw.preset }),
  });
}

export function normalizeManagedSettings(value) {
  let settings;
  try {
    settings = boundedJson(value, {
      where: 'Fieldwork settings', object: true, maxBytes: AGENT_MANAGEMENT_LIMITS.settingsFileBytes, maxDepth: 12, maxNodes: 512,
    }).value;
  }
  catch (error) { throw agentError(error.message, error); }
  if (typeof settings.agentHome !== 'string' || !path.isAbsolute(settings.agentHome)) {
    throw agentError('agentHome must be an absolute path');
  }

  let agents;
  let activeAgentId;
  if (settings.agents === undefined) {
    const home = path.resolve(settings.agentHome);
    const basename = path.basename(home) || 'Agent';
    const id = uniqueId(slug(basename), new Set());
    agents = [deepFreeze({ id, name: basename.toLowerCase() === 'agent' ? 'Agent' : basename, home })];
    activeAgentId = id;
  } else {
    if (!Array.isArray(settings.agents) || settings.agents.length < 1 || settings.agents.length > AGENT_MANAGEMENT_LIMITS.agents) {
      throw agentError(`agents must contain 1-${AGENT_MANAGEMENT_LIMITS.agents} entries`);
    }
    agents = settings.agents.map(agentRow);
    const ids = new Set();
    const homes = new Set();
    let expertPresets = 0;
    for (const agent of agents) {
      if (ids.has(agent.id)) throw agentError(`agents repeats id ${agent.id}`);
      ids.add(agent.id);
      const homeKey = process.platform === 'win32' ? agent.home.toLowerCase() : agent.home;
      if (homes.has(homeKey)) throw agentError('two agents cannot use the same home');
      homes.add(homeKey);
      if (agent.preset === FIELDWORK_EXPERT_PRESET_ID && ++expertPresets > 1) {
        throw agentError('agents may designate only one Fieldwork Expert preset');
      }
    }
    if (typeof settings.activeAgentId !== 'string' || !ids.has(settings.activeAgentId)) {
      throw agentError('activeAgentId must name a registered agent');
    }
    activeAgentId = settings.activeAgentId;
  }

  const active = agents.find(agent => agent.id === activeAgentId);
  const agentRoot = settings.agentRoot === undefined
    ? path.join(path.dirname(active.home), 'agents')
    : absolute(settings.agentRoot, 'agentRoot');
  if (agentRoot === path.parse(agentRoot).root || agentRoot === path.resolve(os.homedir())) {
    throw agentError('agentRoot must not be a filesystem or home-directory root');
  }
  for (const agent of agents) {
    const relative = path.relative(agent.home, agentRoot);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw agentError('agentRoot cannot be inside an agent home');
    }
  }
  return deepFreeze({
    ...settings,
    // Every pre-connection-settings Fieldwork install used an
    // OpenAI-compatible base URL. Persist that meaning when the launcher next
    // saves an older file instead of making the missing discriminator fatal.
    service: settings.service === undefined ? 'openai-compatible' : settings.service,
    agentHome: active.home,
    agentRoot,
    activeAgentId,
    agents: [...agents].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function publicAgentRegistry(settings) {
  const normalized = normalizeManagedSettings(settings);
  return deepFreeze({
    format: AGENT_REGISTRY_FORMAT,
    activeAgentId: normalized.activeAgentId,
    agents: normalized.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      home: agent.home,
      active: agent.id === normalized.activeAgentId,
    })),
  });
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createdAtFromBackupName(name, pattern) {
  const match = pattern.exec(name);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === iso ? iso : null;
}

function backupIdentifier(kind, location) {
  const resolved = path.resolve(location);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return `${kind}-${createHash('sha256').update(`${kind}\0${key}`, 'utf8').digest('hex')}`;
}

async function backupRows(root, kind, pattern, warnings) {
  let rootInfo;
  try { rootInfo = await fs.lstat(root); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    warnings.push(`Could not inspect recovery copies at ${root}: ${error.message}`);
    return [];
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    warnings.push(`Ignored unsafe recovery-copy directory at ${root}.`);
    return [];
  }

  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) {
    warnings.push(`Could not inspect recovery copies at ${root}: ${error.message}`);
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    const createdAt = createdAtFromBackupName(entry.name, pattern);
    if (!createdAt) continue;
    const location = path.join(root, entry.name);
    if ([...location].length > 4096 || /\p{Cc}/u.test(location)) {
      if (warnings.length < 8) warnings.push('Ignored a recovery copy with an undisplayable path.');
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      if (warnings.length < 8) warnings.push(`Ignored unsafe recovery copy at ${location}.`);
      continue;
    }
    if (kind === 'agent') {
      try {
        const profile = await fs.lstat(path.join(location, 'profile.json'));
        if (!profile.isFile() || profile.isSymbolicLink()) throw agentError('profile.json is not a real file');
      } catch (error) {
        if (warnings.length < 8) warnings.push(`Ignored malformed agent recovery copy at ${location}: ${error.message}`);
        continue;
      }
    }
    rows.push(deepFreeze({
      id: backupIdentifier(kind, location),
      kind,
      createdAt,
      location,
    }));
  }
  return rows;
}

export async function publicAgentBackups(settings) {
  const normalized = normalizeManagedSettings(settings);
  const current = normalized.agents.find(agent => agent.id === normalized.activeAgentId);
  const warnings = [];
  let home;
  try { home = await resettableHome(current.home); }
  catch (error) {
    return deepFreeze({
      format: AGENT_BACKUP_REGISTRY_FORMAT,
      activeAgentId: current.id,
      backups: [],
      warning: error instanceof Error ? error.message : String(error),
    });
  }
  const agentPattern = new RegExp(`^${escapePattern(path.basename(home))}-${backupTimestampSource}-[0-9a-f]{8}$`, 'i');
  const rows = [
    ...await backupRows(path.join(home, 'backups'), 'state', stateBackupPattern, warnings),
    ...await backupRows(path.join(path.dirname(home), '.fieldwork-backups'), 'agent', agentPattern, warnings),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const backups = rows.slice(0, AGENT_MANAGEMENT_LIMITS.backups);
  if (rows.length > backups.length) warnings.push(`Only the newest ${AGENT_MANAGEMENT_LIMITS.backups} recovery copies are shown.`);
  const warning = warnings.slice(0, 8).join(' ').slice(0, 4096);
  return deepFreeze({
    format: AGENT_BACKUP_REGISTRY_FORMAT,
    activeAgentId: current.id,
    backups,
    ...(warning ? { warning } : {}),
  });
}

async function atomicWrite(file, value) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) {
    try { await fs.unlink(temporary); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export async function loadManagedSettingsSnapshot(file, { allowMissing = false, io } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw agentError('settings file must be an absolute path');
  let source;
  try {
    source = await readStableFile(file, {
      maxBytes: AGENT_MANAGEMENT_LIMITS.settingsFileBytes,
      allowMissing,
      label: 'settings file',
      ...(io ? { io } : {}),
    });
  } catch (error) {
    if (error instanceof StableFileReadError && error.reason === 'oversized') {
      throw agentError(`settings file is larger than the ${AGENT_MANAGEMENT_LIMITS.settingsFileBytes}-byte settings limit`, error);
    }
    throw agentError(`could not read ${file}: ${error.message}`, error);
  }
  if (source === null) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(source); }
  catch { throw agentError('settings are not valid UTF-8'); }
  let value;
  try { value = JSON.parse(text); }
  catch { throw agentError('settings are not valid JSON'); }
  return Object.freeze({ raw: value, settings: normalizeManagedSettings(value) });
}

export async function loadManagedSettings(file, options = {}) {
  return (await loadManagedSettingsSnapshot(file, options))?.settings ?? null;
}

export async function saveManagedSettings(file, value) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw agentError('settings file must be an absolute path');
  const normalized = normalizeManagedSettings(value);
  await atomicWrite(file, normalized);
  return normalized;
}

function entryIdentity(info) {
  return deepFreeze({
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeMs: Number(info.birthtimeMs),
    ctimeMs: Number(info.ctimeMs),
    mtimeMs: Number(info.mtimeMs),
  });
}

function sameEntryIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs;
}

async function creationReceipt(target, origin) {
  const info = await fs.lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw agentError('created agent home is not a real directory');
  return deepFreeze({
    home: target,
    created: true,
    origin,
    identity: entryIdentity(info),
  });
}

async function verifyCreatedHomeForRollback(receipt) {
  let info;
  try { info = await fs.lstat(receipt.home); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !sameEntryIdentity(receipt.identity, entryIdentity(info))) {
    throw agentError(`the unregistered home ${receipt.home} changed after creation; refusing to remove it automatically`);
  }
  return true;
}

async function seedFieldworkExpertState(home, expertTemplateDir) {
  const templateHome = absolute(expertTemplateDir, 'Fieldwork Expert template');
  const templateState = path.join(templateHome, 'state');
  const templateInfo = await fs.lstat(templateState);
  if (!templateInfo.isDirectory() || templateInfo.isSymbolicLink()) {
    throw agentError('Fieldwork Expert state template must be a real directory, not a link');
  }
  for (const name of ['look.json', 'tool-groups.json']) {
    const info = await fs.lstat(path.join(templateState, name));
    if (!info.isFile() || info.isSymbolicLink()) throw agentError(`Fieldwork Expert state template has an unsafe ${name}`);
  }

  const state = path.join(home, 'state');
  const staging = path.join(home, `.state.fieldwork-preset-${randomUUID()}`);
  try {
    await fs.cp(templateState, staging, { recursive: true, errorOnExist: true, force: false });
    const stagingInfo = await fs.lstat(staging);
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) throw agentError('staged Fieldwork Expert state is not a real directory');
    for (const name of ['look.json', 'tool-groups.json']) {
      const info = await fs.lstat(path.join(staging, name));
      if (!info.isFile() || info.isSymbolicLink()) throw agentError(`staged Fieldwork Expert state has an unsafe ${name}`);
    }
    try {
      await fs.lstat(state);
      throw agentError('agent state appeared while the Fieldwork Expert baseline was being staged');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rename(staging, state);
    return state;
  } catch (error) {
    try { await fs.rm(staging, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Fieldwork Expert state setup failed; inspect ${staging}`); }
    throw error;
  }
}

export async function ensureAgentHome(home, templateDir, options = {}) {
  const target = absolute(home, 'agent home');
  const template = absolute(templateDir, 'agent template');
  const rawOptions = fields(options, ['allowExisting'], 'agent home options');
  const allowExisting = rawOptions.allowExisting ?? true;
  if (typeof allowExisting !== 'boolean') throw agentError('agent home options.allowExisting must be true or false');
  const templateInfo = await fs.lstat(template);
  if (!templateInfo.isDirectory() || templateInfo.isSymbolicLink()) {
    throw agentError('agent template must be a real directory, not a link');
  }
  let targetInfo = null;
  try {
    targetInfo = await fs.lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (targetInfo) {
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
      throw agentError(`${target} must be a real directory, not a link`);
    }
    if (!allowExisting) {
      throw agentError(`${target} already exists; refusing to adopt or replace an unregistered agent home`);
    }
    try {
      const profile = await fs.lstat(path.join(target, 'profile.json'));
      if (!profile.isFile() || profile.isSymbolicLink()) throw agentError(`${target} has an unsafe profile.json`);
      return deepFreeze({ home: target, created: false, origin: 'existing-agent-home', identity: null });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const entries = await fs.readdir(target);
    if (entries.length) {
      throw agentError(`${target} already exists but is not an agent home because profile.json is missing`);
    }
  }
  const parent = path.dirname(target);
  await ensureRealDirectory(parent, 'agent home parent');
  const staging = path.join(parent, `.${path.basename(target)}.fieldwork-create-${randomUUID()}`);
  let removedEmptyTarget = false;
  try {
    await fs.cp(template, staging, { recursive: true, errorOnExist: true, force: false });
    const stagingInfo = await fs.lstat(staging);
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) throw agentError('staged agent home is not a real directory');
    const profile = await fs.lstat(path.join(staging, 'profile.json'));
    if (!profile.isFile() || profile.isSymbolicLink()) throw agentError('staged agent home has an unsafe profile.json');
    if (targetInfo) {
      await fs.rmdir(target);
      removedEmptyTarget = true;
    } else {
      try {
        await fs.lstat(target);
        throw agentError(`${target} appeared while the agent home was being staged`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await fs.rename(staging, target);
    return creationReceipt(target, targetInfo ? 'empty-directory' : 'absent');
  } catch (error) {
    const cleanupErrors = [];
    try { await fs.rm(staging, { recursive: true, force: true }); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (removedEmptyTarget) {
      try { await fs.mkdir(target); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], `Agent-home creation failed; inspect ${staging} and ${target}`);
    }
    throw error;
  }
}

function commandProjection(value) {
  const raw = fields(value, ['format', 'action', 'id', 'name', 'source', 'destination', 'backupId', 'confirmation'], 'agent command');
  if (raw.format !== AGENT_COMMAND_FORMAT) throw agentError(`agent command.format must be ${AGENT_COMMAND_FORMAT}`);
  if (!['switch', 'create', 'create-expert', 'rename', 'move', 'export-agent', 'import-agent', 'clear-state', 'reset-agent', 'restore-state', 'restore-agent'].includes(raw.action)) throw agentError('agent command.action is not supported');
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !idPattern.test(raw.id))) throw agentError('agent command.id must be a lowercase portable id');
  if (raw.name !== undefined) raw.name = name(raw.name, 'agent command.name');
  if (raw.source !== undefined) raw.source = userPath(raw.source, 'agent command.source');
  if (raw.destination !== undefined) raw.destination = userPath(raw.destination, 'agent command.destination');
  if (raw.backupId !== undefined && (typeof raw.backupId !== 'string' || !backupIdPattern.test(raw.backupId))) throw agentError('agent command.backupId is not a recovery-copy id');
  if (raw.confirmation !== undefined && typeof raw.confirmation !== 'string') throw agentError('agent command.confirmation must be text');
  return raw;
}

function timestamp(clock) {
  const value = new Date(clock());
  if (!Number.isFinite(value.getTime())) throw agentError('clock returned an invalid time');
  return value.toISOString().replace(/[:.]/g, '-');
}

async function resettableHome(home) {
  const target = absolute(home, 'agent home');
  const root = path.parse(target).root;
  if (target === root || target === path.resolve(os.homedir()) || path.dirname(target) === root) {
    throw agentError('refusing to reset a broad filesystem location');
  }
  const info = await fs.lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw agentError('agent home must be a real directory, not a link');
  const profile = await fs.lstat(path.join(target, 'profile.json'));
  if (!profile.isFile() || profile.isSymbolicLink()) throw agentError('agent home does not contain a safe profile.json');
  try {
    await fs.lstat(path.join(target, PORTABLE_AGENT_INCOMPLETE_MARKER));
    throw agentError(`agent home is an incomplete portable import; inspect it, then remove ${path.join(target, PORTABLE_AGENT_INCOMPLETE_MARKER)} before switching`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

async function directoryFingerprint(root, where = 'agent home') {
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw agentError(`${where} must be a real directory, not a link`);
  const fingerprint = createHash('sha256');
  const visit = async (directory, relative = '') => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw agentError(`${where} contains unsupported symbolic link ${nextRelative}`);
      if (entry.isDirectory()) {
        fingerprint.update(`d\0${nextRelative}\0`, 'utf8');
        await visit(file, nextRelative);
      } else if (entry.isFile()) {
        const handle = await fs.open(file, 'r');
        const content = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let size = 0;
        try {
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            size += bytesRead;
            content.update(buffer.subarray(0, bytesRead));
          }
        } finally { await handle.close(); }
        fingerprint.update(`f\0${nextRelative}\0${size}\0${content.digest('hex')}\0`, 'utf8');
      } else {
        throw agentError(`${where} contains unsupported filesystem entry ${nextRelative}`);
      }
    }
  };
  await visit(root);
  return fingerprint.digest('hex');
}

async function copyVerifiedDirectory(source, destination) {
  const before = await directoryFingerprint(source, 'recovery copy');
  try {
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    const [sourceAfter, copied] = await Promise.all([
      directoryFingerprint(source, 'recovery copy'),
      directoryFingerprint(destination, 'staged recovery copy'),
    ]);
    if (sourceAfter !== before || copied !== before) throw agentError('the recovery copy changed or did not verify byte-for-byte');
  } catch (error) {
    try { await fs.rm(destination, { recursive: true, force: true }); } catch { /* Preserve the copy or verification failure. */ }
    throw error;
  }
}

async function selectedBackup(settings, backupId, kind) {
  if (backupId === undefined) throw agentError(`${kind} restore needs a backupId`);
  const discovered = await publicAgentBackups(settings);
  const selected = discovered.backups.find(row => row.id === backupId && row.kind === kind);
  if (!selected) throw agentError(`the selected ${kind} recovery copy is not available for the active agent`);
  return selected;
}

async function restoreStateBackup({ before, current, raw, clock }) {
  if (raw.id !== current.id) throw agentError('only the active agent state can be restored');
  if (raw.confirmation !== 'RESTORE STATE') throw agentError('restore-state needs the exact confirmation RESTORE STATE');
  const selected = await selectedBackup(before, raw.backupId, 'state');
  const home = await resettableHome(current.home);
  const state = path.join(home, 'state');
  const backupRoot = path.join(home, 'backups');
  await ensureRealDirectory(backupRoot, 'state backup directory');
  const staging = path.join(home, `.fieldwork-state-restore-${randomUUID()}`);
  await copyVerifiedDirectory(selected.location, staging);

  try {
    let stateInfo = null;
    try { stateInfo = await fs.lstat(state); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stateInfo && (!stateInfo.isDirectory() || stateInfo.isSymbolicLink())) {
      throw agentError('agent state must be a real directory, not a link');
    }
    const backup = stateInfo ? path.join(backupRoot, `state-${timestamp(clock)}-${randomUUID().slice(0, 8)}`) : null;
    if (backup) await fs.rename(state, backup);
    try { await fs.rename(staging, state); }
    catch (error) {
      if (backup) {
        try { await fs.rename(backup, state); }
        catch (restoreError) { throw new AggregateError([error, restoreError], 'Agent state restore and rollback both failed'); }
      }
      throw error;
    }
    return { backup, restoredFrom: selected.location };
  } catch (error) {
    try { await fs.rm(staging, { recursive: true, force: true }); } catch { /* Preserve the restore or rollback failure. */ }
    throw error;
  }
}

async function restoreAgentBackup({ before, current, raw, clock }) {
  if (raw.id !== current.id) throw agentError('only the active agent can be restored');
  if (raw.confirmation !== 'RESTORE AGENT') throw agentError('restore-agent needs the exact confirmation RESTORE AGENT');
  const selected = await selectedBackup(before, raw.backupId, 'agent');
  const home = await resettableHome(current.home);
  const parent = path.dirname(home);
  const backupRoot = path.join(parent, '.fieldwork-backups');
  await ensureRealDirectory(backupRoot, 'agent backup directory');
  const staging = path.join(parent, `.${path.basename(home)}.fieldwork-restore-${randomUUID()}`);
  await copyVerifiedDirectory(selected.location, staging);
  try {
    try { await loadProfile(staging); }
    catch (error) { throw agentError(`the selected agent recovery copy has an invalid profile: ${error.message}`, error); }
    const backup = path.join(backupRoot, `${path.basename(home)}-${timestamp(clock)}-${randomUUID().slice(0, 8)}`);
    await fs.rename(home, backup);
    try { await fs.rename(staging, home); }
    catch (error) {
      try { await fs.rename(backup, home); }
      catch (restoreError) { throw new AggregateError([error, restoreError], 'Agent restore and rollback both failed'); }
      throw error;
    }
    return { backup, restoredFrom: selected.location };
  } catch (error) {
    try { await fs.rm(staging, { recursive: true, force: true }); } catch { /* Preserve the restore or rollback failure. */ }
    throw error;
  }
}

export async function applyAgentCommand({
  settings,
  settingsFile,
  templateDir,
  expertTemplateDir,
  command,
  clock = Date.now,
  knownSecrets = [],
  removeCreatedHome = home => fs.rm(home, { recursive: true, force: true }),
} = {}) {
  const before = normalizeManagedSettings(settings);
  const raw = commandProjection(command);
  if (typeof removeCreatedHome !== 'function') throw agentError('removeCreatedHome must be a function');
  const current = before.agents.find(agent => agent.id === before.activeAgentId);
  const template = absolute(templateDir, 'agent template');
  if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) throw agentError('settings file must be an absolute path');
  let next = before;
  let backup = null;
  let restoredFrom = null;
  let portable = null;
  let imported = null;
  let createdAgentRoot = false;
  let importAgentRoot = null;
  let publicationWarning = null;
  let expertDisposition = null;
  let createdHome = null;

  if (raw.action === 'switch') {
    const selected = before.agents.find(agent => agent.id === raw.id);
    if (!selected) throw agentError('no registered agent has that id');
    await resettableHome(selected.home);
    next = { ...before, activeAgentId: selected.id, agentHome: selected.home };
  } else if (raw.action === 'create' || raw.action === 'create-expert') {
    if (raw.action === 'create' && raw.name === undefined) throw agentError('create needs a name');
    if (raw.action === 'create-expert') {
      const extras = Object.keys(raw).filter(key => !['format', 'action'].includes(key));
      if (extras.length) throw agentError(`create-expert does not accept ${extras[0]}`);
    }
    let existingExpert = null;
    if (raw.action === 'create-expert') {
      existingExpert = before.agents.find(agent => agent.preset === FIELDWORK_EXPERT_PRESET_ID) ?? null;
    }
    if (existingExpert) {
      await ensureAgentHome(existingExpert.home, absolute(expertTemplateDir, 'Fieldwork Expert template'));
      await resettableHome(existingExpert.home);
      next = { ...before, activeAgentId: existingExpert.id, agentHome: existingExpert.home };
      expertDisposition = 'existing';
    } else {
      if (before.agents.length >= AGENT_MANAGEMENT_LIMITS.agents) throw agentError('the agent limit has been reached');
      const agentName = raw.action === 'create-expert' ? 'Fieldwork Expert' : raw.name;
      const selectedTemplate = raw.action === 'create-expert'
        ? absolute(expertTemplateDir, 'Fieldwork Expert template')
        : template;
      const id = uniqueId(slug(agentName), new Set(before.agents.map(agent => agent.id)));
      const home = path.resolve(before.agentRoot, id);
      const relative = path.relative(path.resolve(before.agentRoot), home);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw agentError('new agent home escaped agentRoot');
      const homeReceipt = await ensureAgentHome(home, selectedTemplate, { allowExisting: false });
      if (homeReceipt.created) createdHome = homeReceipt;
      next = {
        ...before,
        activeAgentId: id,
        agentHome: home,
        agents: [...before.agents, {
          id,
          name: agentName,
          home,
          ...(raw.action === 'create-expert' ? { preset: FIELDWORK_EXPERT_PRESET_ID } : {}),
        }],
      };
      if (raw.action === 'create-expert') expertDisposition = 'created';
    }
  } else if (raw.action === 'rename') {
    if (raw.id === undefined || raw.name === undefined) throw agentError('rename needs an id and name');
    if (!before.agents.some(agent => agent.id === raw.id)) throw agentError('no registered agent has that id');
    next = { ...before, agents: before.agents.map(agent => agent.id === raw.id ? { ...agent, name: raw.name } : agent) };
  } else if (raw.action === 'move') {
    if (raw.id !== current.id) throw agentError('only the active agent can be moved');
    if (raw.destination === undefined) throw agentError('move needs a destination');
    const source = await resettableHome(current.home);
    const destination = raw.destination;
    const sourceKey = process.platform === 'win32' ? source.toLowerCase() : source;
    const destinationKey = process.platform === 'win32' ? destination.toLowerCase() : destination;
    if (sourceKey === destinationKey) throw agentError('the destination is already this agent home');
    const nested = path.relative(source, destination);
    if (nested && !nested.startsWith('..') && !path.isAbsolute(nested)) throw agentError('the destination cannot be inside the current agent home');
    if (before.agents.some(agent => agent.id !== current.id
      && (process.platform === 'win32' ? agent.home.toLowerCase() : agent.home) === destinationKey)) {
      throw agentError('another registered agent already uses the destination');
    }
    for (const agent of before.agents.filter(agent => agent.id !== current.id)) {
      const relative = path.relative(agent.home, destination);
      if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw agentError('the destination cannot be inside another agent home');
      }
    }
    try { await fs.lstat(destination); throw agentError('the destination already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await ensureRealDirectory(path.dirname(destination), 'destination parent');
    let movedByRename = false;
    try {
      await fs.rename(source, destination);
      movedByRename = true;
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
      try {
        const [sourceFingerprint, destinationFingerprint] = await Promise.all([
          directoryFingerprint(source), directoryFingerprint(destination),
        ]);
        if (sourceFingerprint !== destinationFingerprint) throw agentError('the copied agent did not verify byte-for-byte');
        const backupRoot = path.join(path.dirname(source), '.fieldwork-moved-backups');
        await ensureRealDirectory(backupRoot, 'move backup directory');
        backup = path.join(backupRoot, `${path.basename(source)}-${timestamp(clock)}-${randomUUID().slice(0, 8)}`);
        await fs.rename(source, backup);
      } catch (copyError) {
        try { await fs.rm(destination, { recursive: true, force: true }); } catch { /* Preserve the verification failure. */ }
        throw copyError;
      }
    }
    next = {
      ...before,
      agentHome: destination,
      agents: before.agents.map(agent => agent.id === current.id ? { ...agent, home: destination } : agent),
    };
    try { next = await saveManagedSettings(settingsFile, next); }
    catch (error) {
      if (movedByRename) {
        try { await fs.rename(destination, source); } catch (restoreError) { throw new AggregateError([error, restoreError], 'Agent move and rollback both failed'); }
      } else {
        try { await fs.rename(backup, source); } catch { /* The verified source backup remains discoverable. */ }
        try { await fs.rm(destination, { recursive: true, force: true }); } catch { /* Preserve the settings failure. */ }
      }
      throw error;
    }
    return deepFreeze({ settings: normalizeManagedSettings(next), action: raw.action, backup });
  } else if (raw.action === 'export-agent') {
    if (raw.id !== current.id) throw agentError('only the active agent can be exported');
    if (raw.destination === undefined) throw agentError('export-agent needs a destination');
    const destinationParent = await realDirectoryPath(path.dirname(raw.destination), 'portable export destination parent');
    const destination = path.join(destinationParent, path.basename(raw.destination));
    for (const agent of before.agents) {
      const home = await realDirectoryPath(agent.home, `registered agent home ${agent.id}`);
      if (containsPath(home, destination) || containsPath(destination, home)) {
        throw agentError('portable export destination must be separate from every registered agent home');
      }
    }
    portable = await exportPortableAgent({
      home: current.home,
      agentName: current.name,
      destination,
      knownSecrets,
      clock,
    });
  } else if (raw.action === 'import-agent') {
    if (raw.source === undefined) throw agentError('import-agent needs a source');
    if (before.agents.length >= AGENT_MANAGEMENT_LIMITS.agents) throw agentError('the agent limit has been reached');
    const preview = await inspectPortableAgent(raw.source, { knownSecrets });
    const id = uniqueId(slug(preview.agent.name), new Set(before.agents.map(agent => agent.id)));
    createdAgentRoot = await ensureRealDirectory(before.agentRoot, 'agent root');
    let home;
    try {
      importAgentRoot = await realDirectoryPath(before.agentRoot, 'agent root');
      home = path.resolve(importAgentRoot, id);
      const relative = path.relative(importAgentRoot, home);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw agentError('imported agent home escaped agentRoot');
      for (const agent of before.agents) {
        const registeredHome = await realDirectoryPath(agent.home, `registered agent home ${agent.id}`);
        if (containsPath(registeredHome, home) || containsPath(home, registeredHome)) {
          throw agentError('imported agent home must be separate from every registered agent home');
        }
      }
      portable = await importPortableAgent({ source: raw.source, destination: home, knownSecrets, deferPublication: true });
    }
    catch (error) {
      if (createdAgentRoot) {
        const rootToRemove = importAgentRoot ?? before.agentRoot;
        try { await fs.rmdir(rootToRemove); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], `Agent import failed; remove the newly created agent root at ${rootToRemove}`); }
      }
      throw error;
    }
    if (portable.name !== preview.agent.name) {
      const changed = agentError('the portable bundle changed while it was imported');
      const cleanupErrors = [];
      try { await fs.rm(home, { recursive: true, force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (createdAgentRoot) try { await fs.rmdir(importAgentRoot); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (cleanupErrors.length) throw new AggregateError([changed, ...cleanupErrors], `Agent import changed during inspection; remove the unregistered content under ${importAgentRoot}`);
      throw changed;
    }
    imported = { id, name: portable.name, home };
    next = { ...before, agentRoot: importAgentRoot, agents: [...before.agents, imported] };
  } else if (raw.action === 'clear-state') {
    if (raw.id !== current.id) throw agentError('only the active agent state can be cleared');
    if (raw.confirmation !== 'CLEAR STATE') throw agentError('clear-state needs the exact confirmation CLEAR STATE');
    const home = await resettableHome(current.home);
    const state = path.join(home, 'state');
    let movedState = false;
    try {
      const info = await fs.lstat(state);
      if (!info.isDirectory() || info.isSymbolicLink()) throw agentError('agent state must be a real directory, not a link');
      const backupRoot = path.join(home, 'backups');
      await ensureRealDirectory(backupRoot, 'state backup directory');
      backup = path.join(backupRoot, `state-${timestamp(clock)}-${randomUUID().slice(0, 8)}`);
      await fs.rename(state, backup);
      movedState = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current.preset === FIELDWORK_EXPERT_PRESET_ID) {
      try { await seedFieldworkExpertState(home, expertTemplateDir); }
      catch (error) {
        if (!movedState) throw error;
        try {
          try {
            await fs.lstat(state);
            throw agentError('new agent state appeared while the cleared Fieldwork Expert state was being restored');
          } catch (stateError) {
            if (stateError.code !== 'ENOENT') throw stateError;
          }
          await fs.rename(backup, state);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `Fieldwork Expert state clear failed; the previous state remains at ${backup}`);
        }
        throw error;
      }
    }
  } else if (raw.action === 'reset-agent') {
    if (raw.id !== current.id) throw agentError('only the active agent can be reset');
    if (raw.confirmation !== 'RESET AGENT') throw agentError('reset-agent needs the exact confirmation RESET AGENT');
    const home = await resettableHome(current.home);
    const backupRoot = path.join(path.dirname(home), '.fieldwork-backups');
    await ensureRealDirectory(backupRoot, 'agent backup directory');
    backup = path.join(backupRoot, `${path.basename(home)}-${timestamp(clock)}-${randomUUID().slice(0, 8)}`);
    const resetTemplate = current.preset === FIELDWORK_EXPERT_PRESET_ID
      ? absolute(expertTemplateDir, 'Fieldwork Expert template')
      : template;
    await fs.rename(home, backup);
    try { await fs.cp(resetTemplate, home, { recursive: true, errorOnExist: true, force: false }); }
    catch (error) {
      try { await fs.rm(home, { recursive: true, force: true }); } catch { /* Rollback still tries to restore the backup. */ }
      try { await fs.rename(backup, home); } catch (restoreError) { throw new AggregateError([error, restoreError], 'Agent reset and rollback both failed'); }
      throw error;
    }
  } else if (raw.action === 'restore-state') {
    ({ backup, restoredFrom } = await restoreStateBackup({ before, current, raw, clock }));
  } else if (raw.action === 'restore-agent') {
    ({ backup, restoredFrom } = await restoreAgentBackup({ before, current, raw, clock }));
  } else {
    throw agentError('agent command.action is not implemented');
  }

  if (canonicalJson(next) !== canonicalJson(before)) {
    try { next = await saveManagedSettings(settingsFile, next); }
    catch (error) {
      if (raw.action === 'create' || raw.action === 'create-expert') {
        const created = next.agents.find(agent => !before.agents.some(row => row.id === agent.id));
        if (created && createdHome?.home === created.home) {
          try {
            if (await verifyCreatedHomeForRollback(createdHome)) await removeCreatedHome(created.home);
          }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], `Agent registration failed; remove the unregistered home ${created.home}`); }
        }
      } else if (raw.action === 'import-agent' && imported) {
        const cleanupErrors = [];
        try { await fs.rm(imported.home, { recursive: true, force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        if (createdAgentRoot) try { await fs.rmdir(importAgentRoot); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], `Agent import registration failed; remove the unregistered content under ${importAgentRoot}`);
      }
      throw error;
    }
  }
  if (raw.action === 'import-agent' && imported) {
    try {
      await finalizePortableAgentImport(imported.home);
      imported = { ...imported, ready: true };
    } catch (error) {
      publicationWarning = `The agent is registered but remains visibly incomplete at ${portable.incompleteMarker}: ${error instanceof Error ? error.message : String(error)}`;
      imported = { ...imported, ready: false, incompleteMarker: portable.incompleteMarker };
    }
  }
  return deepFreeze({ settings: normalizeManagedSettings(next), action: raw.action, backup, restoredFrom, portable, imported, publicationWarning, expertDisposition });
}
