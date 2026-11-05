import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

// This store serializes decisions made by one Fieldwork room. Its in-process
// queue prevents stale writes inside that room; the JSON file is not a
// cross-process lock and callers must still enforce a single writer per home.

export const TOOL_PERMISSION_FORMAT = 'fieldwork-tool-permissions/v1';
export const TOOL_PERMISSION_MODES = Object.freeze(['ask', 'always', 'never']);
export const TOOL_PERMISSION_DECISIONS = Object.freeze(['once', 'always', 'never']);
export const TOOL_PERMISSION_LIMITS = Object.freeze({
  policies: 512,
  pending: 64,
  grants: 64,
  history: 256,
  fileBytes: 512 * 1024,
  grantLifetimeMs: 15 * 60_000,
});

const stores = new WeakSet();
const MODES = new Set(TOOL_PERMISSION_MODES);
const DECISIONS = new Set(TOOL_PERMISSION_DECISIONS);
const ACTORS = new Set(['person', 'host', 'system']);
const HISTORY_ACTIONS = new Set([
  'policy-set',
  'policy-cleared',
  'policy-retired',
  'request-created',
  'request-decided',
  'request-cancelled',
  'grant-cancelled',
  'grant-consumed',
  'grant-expired',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const UNSAFE_DISPLAY_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/u;

function permissionError(message, status = 400) {
  const error = new Error(`Tool permissions: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function exactKeys(value, allowed, where, status = 400) {
  if (!isPlainObject(value)) throw permissionError(`${where} must be an object`, status);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw permissionError(`${where} has unknown fields`, status);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw permissionError(`${where}.${String(key)} must be an enumerable data property`, status);
    }
  }
  return value;
}

function boundedText(value, where, maximum = 128, status = 400) {
  const length = typeof value === 'string' ? [...value].length : 0;
  if (typeof value !== 'string' || length < 1 || length > maximum || value.trim() !== value || UNSAFE_DISPLAY_TEXT.test(value)) {
    throw permissionError(`${where} must be 1-${maximum} characters of trimmed control-free text`, status);
  }
  return value;
}

function toolName(value, where = 'tool', status = 400) {
  if (typeof value !== 'string' || !TOOL_NAME.test(value)) {
    throw permissionError(`${where} must be lowercase letters, digits, and underscores, beginning with a letter`, status);
  }
  return value;
}

function permissionSummary(value, where = 'summary', status = 400) {
  return boundedText(value, where, 240, status);
}

function mode(value, where = 'mode', status = 400) {
  if (!MODES.has(value)) throw permissionError(`${where} must be ask, always, or never`, status);
  return value;
}

function actor(value, where = 'actor', status = 400) {
  if (!ACTORS.has(value)) throw permissionError(`${where} must be person, host, or system`, status);
  return value;
}

function whole(value, minimum, maximum, where, status = 400) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw permissionError(`${where} must be a whole number from ${minimum} to ${maximum}`, status);
  }
  return value;
}

function uuid(value, where, status = 400) {
  if (typeof value !== 'string' || !UUID.test(value)) throw permissionError(`${where} must be a UUID`, status);
  return value.toLowerCase();
}

function sha256(value, where = 'argumentsSha256', status = 400) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw permissionError(`${where} must be a lowercase SHA-256 digest`, status);
  return value;
}

function instant(value, where, status = 500) {
  if (typeof value !== 'string') throw permissionError(`${where} must be an ISO timestamp`, status);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw permissionError(`${where} must be an ISO timestamp`, status);
  return value;
}

function nullable(value, validator) {
  return value === null ? null : validator(value);
}

function now(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw permissionError('clock must return a valid Date', 500);
  return value.toISOString();
}

function requestFingerprint({ id, tool, argumentsSha256, summary, origin, createdAt }) {
  return createHash('sha256').update(canonicalJson({ id, tool, argumentsSha256, summary, origin, createdAt })).digest('hex');
}

function normalizePolicy(value, where) {
  const raw = exactKeys(value, ['tool', 'mode', 'revision', 'updatedAt', 'actor'], where, 500);
  return {
    tool: toolName(raw.tool, `${where}.tool`, 500),
    mode: mode(raw.mode, `${where}.mode`, 500),
    revision: whole(raw.revision, 1, Number.MAX_SAFE_INTEGER, `${where}.revision`, 500),
    updatedAt: instant(raw.updatedAt, `${where}.updatedAt`),
    actor: actor(raw.actor, `${where}.actor`, 500),
  };
}

function normalizeRequest(value, where) {
  const raw = exactKeys(value, ['id', 'fingerprint', 'tool', 'argumentsSha256', 'summary', 'origin', 'createdAt'], where, 500);
  const normalized = {
    id: uuid(raw.id, `${where}.id`, 500),
    fingerprint: sha256(raw.fingerprint, `${where}.fingerprint`, 500),
    tool: toolName(raw.tool, `${where}.tool`, 500),
    argumentsSha256: sha256(raw.argumentsSha256, `${where}.argumentsSha256`, 500),
    summary: permissionSummary(raw.summary, `${where}.summary`, 500),
    origin: boundedText(raw.origin, `${where}.origin`, 64, 500),
    createdAt: instant(raw.createdAt, `${where}.createdAt`),
  };
  if (normalized.fingerprint !== requestFingerprint(normalized)) throw permissionError(`${where}.fingerprint does not match its request`, 500);
  return normalized;
}

function normalizeGrant(value, where) {
  const raw = exactKeys(value, ['id', 'requestId', 'tool', 'argumentsSha256', 'summary', 'origin', 'createdAt', 'expiresAt'], where, 500);
  const normalized = {
    id: uuid(raw.id, `${where}.id`, 500),
    requestId: uuid(raw.requestId, `${where}.requestId`, 500),
    tool: toolName(raw.tool, `${where}.tool`, 500),
    argumentsSha256: sha256(raw.argumentsSha256, `${where}.argumentsSha256`, 500),
    summary: permissionSummary(raw.summary, `${where}.summary`, 500),
    origin: boundedText(raw.origin, `${where}.origin`, 64, 500),
    createdAt: instant(raw.createdAt, `${where}.createdAt`),
    expiresAt: instant(raw.expiresAt, `${where}.expiresAt`),
  };
  if (new Date(normalized.expiresAt).getTime() - new Date(normalized.createdAt).getTime() !== TOOL_PERMISSION_LIMITS.grantLifetimeMs) {
    throw permissionError(`${where}.expiresAt must be exactly ${TOOL_PERMISSION_LIMITS.grantLifetimeMs} milliseconds after creation`, 500);
  }
  return normalized;
}

function normalizeHistory(value, where) {
  const raw = exactKeys(value, ['id', 'at', 'action', 'tool', 'actor', 'requestId', 'origin', 'value'], where, 500);
  if (!HISTORY_ACTIONS.has(raw.action)) throw permissionError(`${where}.action is unsupported`, 500);
  const historyValue = raw.value === null ? null : boundedText(raw.value, `${where}.value`, 32, 500);
  if (historyValue !== null && !MODES.has(historyValue) && !DECISIONS.has(historyValue)) {
    throw permissionError(`${where}.value is unsupported`, 500);
  }
  return {
    id: uuid(raw.id, `${where}.id`, 500),
    at: instant(raw.at, `${where}.at`),
    action: raw.action,
    tool: toolName(raw.tool, `${where}.tool`, 500),
    actor: actor(raw.actor, `${where}.actor`, 500),
    requestId: nullable(raw.requestId, item => uuid(item, `${where}.requestId`, 500)),
    origin: nullable(raw.origin, item => boundedText(item, `${where}.origin`, 64, 500)),
    value: historyValue,
  };
}

function unique(rows, key, where) {
  const seen = new Set();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) throw permissionError(`${where} contains duplicate entries`, 500);
    seen.add(value);
  }
}

function normalizeState(value) {
  const raw = exactKeys(value, ['format', 'revision', 'policies', 'pending', 'grants', 'history'], 'saved permission file', 500);
  if (raw.format !== TOOL_PERMISSION_FORMAT) throw permissionError('saved permission file.format is unsupported', 500);
  const revision = whole(raw.revision, 0, Number.MAX_SAFE_INTEGER, 'saved permission file.revision', 500);
  for (const [name, limit] of [
    ['policies', TOOL_PERMISSION_LIMITS.policies],
    ['pending', TOOL_PERMISSION_LIMITS.pending],
    ['grants', TOOL_PERMISSION_LIMITS.grants],
    ['history', TOOL_PERMISSION_LIMITS.history],
  ]) {
    if (!Array.isArray(raw[name]) || raw[name].length > limit) throw permissionError(`saved permission file.${name} must be an array with at most ${limit} entries`, 500);
  }
  const policies = raw.policies.map((row, index) => normalizePolicy(row, `saved permission file.policies[${index}]`));
  const pending = raw.pending.map((row, index) => normalizeRequest(row, `saved permission file.pending[${index}]`));
  const grants = raw.grants.map((row, index) => normalizeGrant(row, `saved permission file.grants[${index}]`));
  const history = raw.history.map((row, index) => normalizeHistory(row, `saved permission file.history[${index}]`));
  unique(policies, row => row.tool, 'saved permission file.policies');
  unique(pending, row => row.id, 'saved permission file.pending ids');
  unique(pending, row => `${row.tool}\0${row.argumentsSha256}\0${row.summary}\0${row.origin}`, 'saved permission file.pending request identities');
  unique(pending, row => `${row.tool}\0${row.argumentsSha256}\0${row.origin}`, 'saved permission file.pending action targets');
  unique(grants, row => row.id, 'saved permission file.grant ids');
  unique(grants, row => row.requestId, 'saved permission file.grant request ids');
  unique(grants, row => `${row.tool}\0${row.argumentsSha256}\0${row.origin}`, 'saved permission file.grants');
  unique(history, row => row.id, 'saved permission file.history ids');
  const policyModes = new Map(policies.map(row => [row.tool, row.mode]));
  for (const row of policies) if (row.revision > revision) throw permissionError('saved policy revision exceeds the store revision', 500);
  for (const row of [...pending, ...grants]) {
    if (policyModes.get(row.tool) !== 'ask') throw permissionError(`saved ${pending.includes(row) ? 'request' : 'grant'} requires an explicit ask policy`, 500);
  }
  return deepFreeze({ format: TOOL_PERMISSION_FORMAT, revision, policies, pending, grants, history });
}

function initialState() {
  return deepFreeze({ format: TOOL_PERMISSION_FORMAT, revision: 0, policies: [], pending: [], grants: [], history: [] });
}

function cloneState(state) {
  return {
    format: TOOL_PERMISSION_FORMAT,
    revision: state.revision,
    policies: state.policies.map(row => ({ ...row })),
    pending: state.pending.map(row => ({ ...row })),
    grants: state.grants.map(row => ({ ...row })),
    history: state.history.map(row => ({ ...row })),
  };
}

async function atomicWrite(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateToolList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw permissionError(`tool list must contain at most ${TOOL_PERMISSION_LIMITS.policies} names`);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > TOOL_PERMISSION_LIMITS.policies) {
    throw permissionError(`tool list must contain at most ${TOOL_PERMISSION_LIMITS.policies} names`);
  }
  const keys = Reflect.ownKeys(value).filter(key => key !== 'length');
  if (keys.length !== length || keys.some(key => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length)) {
    throw permissionError('tool list must contain only contiguous indexed names');
  }
  const tools = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw permissionError(`tools[${index}] must be an enumerable data property`);
    }
    tools.push(toolName(descriptor.value, `tools[${index}]`));
  }
  if (new Set(tools).size !== tools.length) throw permissionError('tool list must not contain duplicates');
  return tools;
}

function safeRequest(row) {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    tool: row.tool,
    summary: row.summary,
    argumentsFingerprint: row.argumentsSha256.slice(0, 12),
    origin: row.origin,
    createdAt: row.createdAt,
  };
}

function safeGrant(row) {
  return {
    id: row.id, requestId: row.requestId, tool: row.tool,
    summary: row.summary, argumentsFingerprint: row.argumentsSha256.slice(0, 12),
    origin: row.origin, createdAt: row.createdAt, expiresAt: row.expiresAt,
  };
}

function safeView(state, requestedTools, observedAt) {
  const byTool = new Map(state.policies.map(row => [row.tool, row]));
  const allowed = requestedTools === null ? null : new Set(requestedTools);
  const names = [...new Set(requestedTools === null ? byTool.keys() : requestedTools)].sort((left, right) => left.localeCompare(right));
  const visible = row => allowed === null || allowed.has(row.tool);
  const observedMilliseconds = new Date(observedAt).getTime();
  return deepFreeze({
    format: TOOL_PERMISSION_FORMAT,
    revision: state.revision,
    boundary: 'same-room-single-writer',
    policies: names.map(tool => {
      const row = byTool.get(tool);
      return row
        ? { tool, mode: row.mode, explicit: true, revision: row.revision, updatedAt: row.updatedAt, actor: row.actor }
        : { tool, mode: 'always', explicit: false, revision: 0, updatedAt: null, actor: null };
    }),
    pending: state.pending.filter(visible).map(safeRequest),
    grants: state.grants
      .filter(row => visible(row) && new Date(row.expiresAt).getTime() > observedMilliseconds)
      .map(safeGrant),
    history: state.history.map(row => ({ ...row })),
  });
}

function authorization(allowed, modeValue, reason, request = null) {
  return deepFreeze({
    allowed,
    mode: modeValue,
    reason,
    requestId: request?.requestId ?? request?.id ?? null,
    requestFingerprint: request?.fingerprint ?? null,
  });
}

export async function createToolPermissionStore({ file, clock = () => new Date() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw permissionError('file must be an absolute path', 500);
  if (typeof clock !== 'function') throw permissionError('clock must be a function', 500);

  let state = initialState();
  try {
    const source = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > TOOL_PERMISSION_LIMITS.fileBytes) throw permissionError('saved permission file is too large', 500);
    state = normalizeState(parseJsonNoDuplicates(source, { where: 'saved tool-permission file', maxDepth: 16 }));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (String(error?.message ?? '').startsWith('Tool permissions:')) throw error;
      throw permissionError(`could not read saved permission file: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  }

  let queue = Promise.resolve();
  const enqueue = operation => {
    const job = queue.then(operation);
    queue = job.then(() => undefined, () => undefined);
    return job;
  };
  const currentMode = name => state.policies.find(row => row.tool === name)?.mode ?? 'always';
  const pushHistory = (draft, entry) => {
    draft.history.push({ id: randomUUID(), ...entry });
    if (draft.history.length > TOOL_PERMISSION_LIMITS.history) {
      draft.history.splice(0, draft.history.length - TOOL_PERMISSION_LIMITS.history);
    }
  };
  const saveDraft = async draft => {
    const normalized = normalizeState(draft);
    await atomicWrite(file, normalized);
    state = normalized;
  };
  const cancelForTool = (draft, name, at, exceptRequestId = null) => {
    const cancelled = draft.pending.filter(row => row.tool === name && row.id !== exceptRequestId);
    const grants = draft.grants.filter(row => row.tool === name);
    draft.pending = draft.pending.filter(row => row.tool !== name || row.id === exceptRequestId);
    draft.grants = draft.grants.filter(row => row.tool !== name);
    for (const row of cancelled) pushHistory(draft, {
      at, action: 'request-cancelled', tool: name, actor: 'system', requestId: row.id, origin: row.origin, value: null,
    });
    for (const row of grants) pushHistory(draft, {
      at, action: 'grant-cancelled', tool: name, actor: 'system', requestId: row.requestId, origin: row.origin, value: null,
    });
  };
  const reapExpiredFromDraft = (draft, at) => {
    const atMilliseconds = new Date(at).getTime();
    const expired = draft.grants.filter(row => new Date(row.expiresAt).getTime() <= atMilliseconds);
    if (!expired.length) return 0;
    const ids = new Set(expired.map(row => row.id));
    draft.grants = draft.grants.filter(row => !ids.has(row.id));
    for (const row of expired) pushHistory(draft, {
      at, action: 'grant-expired', tool: row.tool, actor: 'system',
      requestId: row.requestId, origin: row.origin, value: 'once',
    });
    return expired.length;
  };
  const reapExpired = async at => {
    const draft = cloneState(state);
    if (!reapExpiredFromDraft(draft, at)) return false;
    draft.revision = state.revision + 1;
    await saveDraft(draft);
    return true;
  };
  const cancelSummaryMismatches = (draft, { name, argumentsDigest, summary, origin, at }) => {
    const stalePending = draft.pending.filter(row => row.tool === name
      && row.argumentsSha256 === argumentsDigest
      && row.origin === origin
      && row.summary !== summary);
    const staleGrants = draft.grants.filter(row => row.tool === name
      && row.argumentsSha256 === argumentsDigest
      && row.origin === origin
      && row.summary !== summary);
    const pendingIds = new Set(stalePending.map(row => row.id));
    const grantIds = new Set(staleGrants.map(row => row.id));
    draft.pending = draft.pending.filter(row => !pendingIds.has(row.id));
    draft.grants = draft.grants.filter(row => !grantIds.has(row.id));
    for (const row of stalePending) pushHistory(draft, {
      at, action: 'request-cancelled', tool: name, actor: 'system', requestId: row.id, origin, value: null,
    });
    for (const row of staleGrants) pushHistory(draft, {
      at, action: 'grant-cancelled', tool: name, actor: 'system', requestId: row.requestId, origin, value: null,
    });
    return stalePending.length + staleGrants.length;
  };

  const store = Object.freeze({
    mode(value) {
      const name = toolName(value);
      return currentMode(name);
    },

    view(toolNames) {
      const requested = toolNames === undefined ? null : validateToolList(toolNames);
      return safeView(state, requested, now(clock));
    },

    setPolicy(value) {
      const raw = exactKeys(value, ['tool', 'mode', 'expectedRevision', 'actor'], 'policy change');
      const name = toolName(raw.tool);
      const nextMode = mode(raw.mode);
      const expectedRevision = whole(raw.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision');
      const by = Object.hasOwn(raw, 'actor') ? actor(raw.actor) : 'person';
      return enqueue(async () => {
        if (expectedRevision !== state.revision) throw permissionError(`permissions changed since they were read; expected revision ${expectedRevision}, current revision ${state.revision}`, 409);
        const at = now(clock);
        const current = state.policies.find(row => row.tool === name);
        if (!current && state.policies.length >= TOOL_PERMISSION_LIMITS.policies) throw permissionError('the policy limit has been reached', 409);
        const draft = cloneState(state);
        const reaped = reapExpiredFromDraft(draft, at);
        if (current?.mode === nextMode) {
          if (reaped) {
            draft.revision = state.revision + 1;
            await saveDraft(draft);
          }
          return safeView(state, [name], at);
        }
        const revision = state.revision + 1;
        cancelForTool(draft, name, at);
        draft.policies = draft.policies.filter(row => row.tool !== name);
        draft.policies.push({ tool: name, mode: nextMode, revision, updatedAt: at, actor: by });
        draft.policies.sort((left, right) => left.tool.localeCompare(right.tool));
        pushHistory(draft, { at, action: 'policy-set', tool: name, actor: by, requestId: null, origin: null, value: nextMode });
        draft.revision = revision;
        await saveDraft(draft);
        return safeView(state, [name], at);
      });
    },

    clearPolicy(value) {
      const raw = exactKeys(value, ['tool', 'expectedRevision', 'actor'], 'policy reset');
      const name = toolName(raw.tool);
      const expectedRevision = whole(raw.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision');
      const by = Object.hasOwn(raw, 'actor') ? actor(raw.actor) : 'person';
      return enqueue(async () => {
        if (expectedRevision !== state.revision) throw permissionError(`permissions changed since they were read; expected revision ${expectedRevision}, current revision ${state.revision}`, 409);
        const at = now(clock);
        const current = state.policies.find(row => row.tool === name);
        const draft = cloneState(state);
        const reaped = reapExpiredFromDraft(draft, at);
        if (!current) {
          if (reaped) {
            draft.revision = state.revision + 1;
            await saveDraft(draft);
          }
          return safeView(state, [name], at);
        }
        cancelForTool(draft, name, at);
        draft.policies = draft.policies.filter(row => row.tool !== name);
        pushHistory(draft, {
          at, action: 'policy-cleared', tool: name, actor: by,
          requestId: null, origin: null, value: current.mode,
        });
        draft.revision = state.revision + 1;
        await saveDraft(draft);
        return safeView(state, [name], at);
      });
    },

    reconcileTools(toolNames) {
      if (toolNames === undefined) throw permissionError('reconcileTools needs an explicit tool list');
      const currentTools = validateToolList(toolNames);
      return enqueue(async () => {
        const at = now(clock);
        await reapExpired(at);
        const current = new Set(currentTools);
        const retiredPolicies = state.policies.filter(row => !current.has(row.tool));
        const retiredPending = state.pending.filter(row => !current.has(row.tool));
        const retiredGrants = state.grants.filter(row => !current.has(row.tool));
        if (!retiredPolicies.length && !retiredPending.length && !retiredGrants.length) {
          return safeView(state, currentTools, at);
        }
        const draft = cloneState(state);
        draft.policies = draft.policies.filter(row => current.has(row.tool));
        draft.pending = draft.pending.filter(row => current.has(row.tool));
        draft.grants = draft.grants.filter(row => current.has(row.tool));
        for (const row of retiredPolicies) pushHistory(draft, {
          at, action: 'policy-retired', tool: row.tool, actor: 'system', requestId: null, origin: null, value: row.mode,
        });
        for (const row of retiredPending) pushHistory(draft, {
          at, action: 'request-cancelled', tool: row.tool, actor: 'system', requestId: row.id, origin: row.origin, value: null,
        });
        for (const row of retiredGrants) pushHistory(draft, {
          at, action: 'grant-cancelled', tool: row.tool, actor: 'system', requestId: row.requestId, origin: row.origin, value: null,
        });
        draft.revision = state.revision + 1;
        await saveDraft(draft);
        return safeView(state, currentTools, at);
      });
    },

    authorize(value) {
      const raw = exactKeys(value, ['tool', 'argumentsSha256', 'summary', 'origin', 'interactive', 'callId', 'step', 'runId'], 'authorization');
      const name = toolName(raw.tool);
      const argumentsDigest = sha256(raw.argumentsSha256);
      const summary = Object.hasOwn(raw, 'summary')
        ? permissionSummary(raw.summary)
        : `Use ${name} for this exact call.`;
      const origin = boundedText(raw.origin, 'origin', 64);
      if (typeof raw.interactive !== 'boolean') throw permissionError('interactive must be a boolean');
      if (Object.hasOwn(raw, 'callId')) boundedText(raw.callId, 'callId', 256);
      if (Object.hasOwn(raw, 'runId')) boundedText(raw.runId, 'runId', 256);
      if (Object.hasOwn(raw, 'step')) whole(raw.step, 0, Number.MAX_SAFE_INTEGER, 'step');
      return enqueue(async () => {
        const checkedAt = now(clock);
        await reapExpired(checkedAt);
        const activeMode = currentMode(name);
        if (activeMode === 'always') return authorization(true, activeMode, 'policy-always');
        if (activeMode === 'never') return authorization(false, activeMode, 'policy-never');
        const grant = state.grants.find(row => row.tool === name
          && row.argumentsSha256 === argumentsDigest
          && row.summary === summary
          && row.origin === origin);
        if (grant) {
          const draft = cloneState(state);
          const at = now(clock);
          draft.grants = draft.grants.filter(row => row.id !== grant.id);
          pushHistory(draft, {
            at, action: 'grant-consumed', tool: name, actor: 'system', requestId: grant.requestId, origin, value: 'once',
          });
          draft.revision = state.revision + 1;
          await saveDraft(draft);
          return authorization(true, activeMode, 'one-time-grant', grant);
        }
        const pending = state.pending.find(row => row.tool === name
          && row.argumentsSha256 === argumentsDigest
          && row.summary === summary
          && row.origin === origin);
        const changedAt = now(clock);
        const draft = cloneState(state);
        const cancelled = cancelSummaryMismatches(draft, { name, argumentsDigest, summary, origin, at: changedAt });
        if (pending || !raw.interactive) {
          if (cancelled) {
            draft.revision = state.revision + 1;
            await saveDraft(draft);
          }
          return pending
            ? authorization(false, activeMode, 'approval-required', pending)
            : authorization(false, activeMode, 'approval-unavailable');
        }
        if (draft.pending.length >= TOOL_PERMISSION_LIMITS.pending) {
          if (cancelled) {
            draft.revision = state.revision + 1;
            await saveDraft(draft);
          }
          return authorization(false, activeMode, 'request-capacity');
        }
        const request = {
          id: randomUUID(),
          fingerprint: '',
          tool: name,
          argumentsSha256: argumentsDigest,
          summary,
          origin,
          createdAt: changedAt,
        };
        request.fingerprint = requestFingerprint(request);
        draft.pending.push(request);
        pushHistory(draft, {
          at: changedAt, action: 'request-created', tool: name, actor: 'system', requestId: request.id, origin, value: 'ask',
        });
        draft.revision = state.revision + 1;
        await saveDraft(draft);
        return authorization(false, activeMode, 'approval-required', request);
      });
    },

    decide(value) {
      const raw = exactKeys(value, ['requestId', 'expectedFingerprint', 'decision', 'actor'], 'permission decision');
      const requestId = uuid(raw.requestId, 'requestId');
      const expectedFingerprint = sha256(raw.expectedFingerprint, 'expectedFingerprint');
      if (!DECISIONS.has(raw.decision)) throw permissionError('decision must be once, always, or never');
      const by = Object.hasOwn(raw, 'actor') ? actor(raw.actor) : 'person';
      return enqueue(async () => {
        const at = now(clock);
        await reapExpired(at);
        const request = state.pending.find(row => row.id === requestId);
        if (!request) throw permissionError('that request is no longer pending; refresh before deciding', 409);
        if (request.fingerprint !== expectedFingerprint) throw permissionError('that request changed since it was read; refresh before deciding', 409);
        if (currentMode(request.tool) !== 'ask') throw permissionError('that tool is no longer set to ask; refresh before deciding', 409);
        if (raw.decision === 'once' && state.grants.length >= TOOL_PERMISSION_LIMITS.grants) {
          throw permissionError('the one-time approval limit has been reached; use or cancel an earlier approval first', 409);
        }
        const draft = cloneState(state);
        const revision = state.revision + 1;
        draft.pending = draft.pending.filter(row => row.id !== request.id);
        if (raw.decision === 'once') {
          draft.grants.push({
            id: randomUUID(), requestId: request.id, tool: request.tool,
            argumentsSha256: request.argumentsSha256, summary: request.summary,
            origin: request.origin, createdAt: at,
            expiresAt: new Date(new Date(at).getTime() + TOOL_PERMISSION_LIMITS.grantLifetimeMs).toISOString(),
          });
        } else {
          cancelForTool(draft, request.tool, at);
          draft.policies = draft.policies.filter(row => row.tool !== request.tool);
          draft.policies.push({ tool: request.tool, mode: raw.decision, revision, updatedAt: at, actor: by });
          draft.policies.sort((left, right) => left.tool.localeCompare(right.tool));
        }
        pushHistory(draft, {
          at, action: 'request-decided', tool: request.tool, actor: by,
          requestId: request.id, origin: request.origin, value: raw.decision,
        });
        draft.revision = revision;
        await saveDraft(draft);
        return safeView(state, [request.tool], at);
      });
    },
  });
  stores.add(store);
  return store;
}

export function isToolPermissionStore(value) {
  return Boolean(value) && stores.has(value);
}
