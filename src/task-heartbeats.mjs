import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalStateFile, withStateTransactionLock } from './cooperative-state-lock.mjs';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

// Task heartbeats are named, bounded watches over one explicit task. They are
// not social check-ins: each definition says what to inspect, which exact tools
// may be offered, what counts as a meaningful change, and when the watch is
// finished. A run always leaves a receipt, including honest no-change runs.

export const TASK_HEARTBEAT_FORMAT = 'fieldwork-task-heartbeats/v2';
const LEGACY_TASK_HEARTBEAT_FORMAT = 'fieldwork-task-heartbeats/v1';
export const TASK_HEARTBEAT_LIMITS = Object.freeze({
  kept: 50,
  active: 12,
  versions: 50,
  receipts: 300,
  nameCharacters: 80,
  taskCharacters: 4000,
  ruleCharacters: 2000,
  noteCharacters: 2000,
  toolNames: 32,
  toolNameCharacters: 64,
  cadenceHours: Object.freeze([1, 2, 3, 4, 6, 8, 12, 24]),
  claimMinutes: 15,
  fileBytes: 2 * 1024 * 1024,
});

const HEARTBEAT_STATUSES = Object.freeze(['active', 'paused', 'finished', 'removed']);
const RUN_OUTCOMES = Object.freeze(['no-change', 'changed', 'failed', 'finished']);
const RECEIPT_OUTCOMES = new Set([...RUN_OUTCOMES, 'claim-expired']);
const VERSION_ACTIONS = new Set(['created', 'updated', 'paused', 'resumed', 'finished', 'removed', 'restored']);
const ACTORS = new Set(['person', 'agent', 'system']);
const idPattern = /^heartbeat-[0-9a-f-]{36}$/;
const receiptIdPattern = /^heartbeat-run-[0-9a-f-]{36}$/;
const tokenPattern = /^[0-9a-f-]{36}$/;
const toolNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const registerRecordIdPattern = /^(goal|promise)-[0-9a-f-]{36}$/;
const registerMeasureKeyPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const stores = new WeakSet();

function heartbeatError(message, status = 400, cause) {
  const error = new Error(`Task heartbeats: ${message}`, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function exactKeys(value, allowed, where) {
  if (!isPlainObject(value)) throw heartbeatError(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw heartbeatError(`${where} has unknown field ${JSON.stringify(key)}`);
}

function inputObject(value, where, maxBytes = 32 * 1024) {
  try { return boundedJson(value, { where, object: true, maxBytes, maxDepth: 8, maxNodes: 512 }).value; }
  catch (error) { throw heartbeatError(error.message, 400, error); }
}

function cleanText(value, limit, what, { required = false, multiline = false } = {}) {
  if (typeof value !== 'string') throw heartbeatError(`${what} must be text`);
  let text = multiline
    ? value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
    : value.replace(/\s+/gu, ' ').trim();
  if (required && !text) throw heartbeatError(`${what} must not be empty`);
  if ([...text].length > limit) throw heartbeatError(`${what} is at most ${limit} characters`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)) throw heartbeatError(`${what} contains control characters`);
  return text;
}

function iso(value, what, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw heartbeatError(`${what} must be an exact ISO timestamp`);
  let normalized;
  try { normalized = new Date(value).toISOString(); } catch { throw heartbeatError(`${what} must be an exact ISO timestamp`); }
  if (normalized !== value) throw heartbeatError(`${what} must be an exact ISO timestamp`);
  return value;
}

function whole(value, minimum, maximum, what) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw heartbeatError(`${what} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

function actor(value, fallback = 'person') {
  const normalized = value ?? fallback;
  if (!ACTORS.has(normalized)) throw heartbeatError('actor must be person, agent, or system');
  return normalized;
}

function toolNames(value) {
  if (!Array.isArray(value)) throw heartbeatError('toolNames must be an array');
  if (value.length > TASK_HEARTBEAT_LIMITS.toolNames) {
    throw heartbeatError(`at most ${TASK_HEARTBEAT_LIMITS.toolNames} tools may be named`);
  }
  const names = [];
  for (const item of value) {
    if (typeof item !== 'string' || !toolNamePattern.test(item) || [...item].length > TASK_HEARTBEAT_LIMITS.toolNameCharacters) {
      throw heartbeatError('every tool name must be a literal provider tool name');
    }
    if (names.includes(item)) throw heartbeatError(`toolNames repeats ${JSON.stringify(item)}`);
    names.push(item);
  }
  return names.sort();
}

function cadence(value) {
  if (!TASK_HEARTBEAT_LIMITS.cadenceHours.includes(value)) {
    throw heartbeatError(`cadenceHours must be one of ${TASK_HEARTBEAT_LIMITS.cadenceHours.join(', ')}`);
  }
  return value;
}

function registerBinding(value) {
  if (value === null) return null;
  exactKeys(value, ['type', 'recordId', 'measureKey'], 'heartbeat register binding');
  if (value.type !== 'goal-measure') throw heartbeatError('heartbeat register binding type must be goal-measure');
  if (typeof value.recordId !== 'string' || !registerRecordIdPattern.test(value.recordId)) {
    throw heartbeatError('heartbeat register binding needs an exact goal or promise id');
  }
  if (typeof value.measureKey !== 'string' || !registerMeasureKeyPattern.test(value.measureKey)) {
    throw heartbeatError('heartbeat register binding needs an exact measure key');
  }
  return { type: 'goal-measure', recordId: value.recordId, measureKey: value.measureKey };
}

function configuration(raw, base = null) {
  exactKeys(raw, ['name', 'task', 'meaningfulChange', 'completionRule', 'cadenceHours', 'toolNames', 'binding'], 'heartbeat definition');
  const value = base ? structuredClone(base) : null;
  if (!value) {
    for (const key of ['name', 'task', 'meaningfulChange', 'completionRule', 'cadenceHours', 'toolNames']) {
      if (!Object.hasOwn(raw, key)) throw heartbeatError(`heartbeat definition needs ${key}`);
    }
  }
  const next = value ?? { binding: null };
  if (Object.hasOwn(raw, 'name')) next.name = cleanText(raw.name, TASK_HEARTBEAT_LIMITS.nameCharacters, 'name', { required: true });
  if (Object.hasOwn(raw, 'task')) next.task = cleanText(raw.task, TASK_HEARTBEAT_LIMITS.taskCharacters, 'task', { required: true, multiline: true });
  if (Object.hasOwn(raw, 'meaningfulChange')) next.meaningfulChange = cleanText(raw.meaningfulChange, TASK_HEARTBEAT_LIMITS.ruleCharacters, 'meaningfulChange', { required: true, multiline: true });
  if (Object.hasOwn(raw, 'completionRule')) next.completionRule = cleanText(raw.completionRule, TASK_HEARTBEAT_LIMITS.ruleCharacters, 'completionRule', { required: true, multiline: true });
  if (Object.hasOwn(raw, 'cadenceHours')) next.cadenceHours = cadence(raw.cadenceHours);
  if (Object.hasOwn(raw, 'toolNames')) next.toolNames = toolNames(raw.toolNames);
  if (Object.hasOwn(raw, 'binding')) next.binding = registerBinding(raw.binding);
  return next;
}

function configFrom(row) {
  return {
    name: row.name,
    task: row.task,
    meaningfulChange: row.meaningfulChange,
    completionRule: row.completionRule,
    cadenceHours: row.cadenceHours,
    toolNames: [...row.toolNames],
    binding: row.binding ? structuredClone(row.binding) : null,
  };
}

function versionValue(row) {
  return deepFreeze({ ...configFrom(row), status: row.status });
}

function addVersion(row, { at, by, action }) {
  row.versions = [{ revision: row.revision, at, by, action, value: versionValue(row) }, ...row.versions]
    .slice(0, TASK_HEARTBEAT_LIMITS.versions);
}

function publicReceipt(receipt) {
  return {
    id: receipt.id,
    heartbeatId: receipt.heartbeatId,
    at: receipt.at,
    outcome: receipt.outcome,
    runKind: receipt.runKind,
    definitionRevision: receipt.definitionRevision,
    claimedAt: receipt.claimedAt,
    ...(receipt.note ? { note: receipt.note } : {}),
  };
}

function publicHeartbeat(row, state, at) {
  const claim = state.claims.find(item => item.heartbeatId === row.id && Date.parse(item.expiresAt) > at.getTime());
  const latest = state.receipts.find(item => item.heartbeatId === row.id);
  return {
    id: row.id,
    revision: row.revision,
    ...configFrom(row),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    finishedAt: row.finishedAt,
    removedAt: row.removedAt,
    running: Boolean(claim),
    claimExpiresAt: claim?.expiresAt ?? null,
    lastReceipt: latest ? publicReceipt(latest) : null,
  };
}

function receiptFromSaved(raw, knownIds) {
  exactKeys(raw, ['id', 'heartbeatId', 'at', 'outcome', 'runKind', 'definitionRevision', 'claimedAt', 'note'], 'saved receipt');
  if (!receiptIdPattern.test(raw.id)) throw heartbeatError('saved receipt id is invalid');
  if (!knownIds.has(raw.heartbeatId)) throw heartbeatError('saved receipt names an unknown heartbeat');
  if (!RECEIPT_OUTCOMES.has(raw.outcome)) throw heartbeatError('saved receipt outcome is invalid');
  if (!['scheduled', 'manual'].includes(raw.runKind)) throw heartbeatError('saved receipt runKind is invalid');
  const note = raw.note === undefined ? '' : cleanText(raw.note, TASK_HEARTBEAT_LIMITS.noteCharacters, 'saved receipt note', { multiline: true });
  return {
    id: raw.id,
    heartbeatId: raw.heartbeatId,
    at: iso(raw.at, 'saved receipt at'),
    outcome: raw.outcome,
    runKind: raw.runKind,
    definitionRevision: whole(raw.definitionRevision, 1, Number.MAX_SAFE_INTEGER, 'saved receipt definitionRevision'),
    claimedAt: iso(raw.claimedAt, 'saved receipt claimedAt'),
    ...(note ? { note } : {}),
  };
}

function versionFromSaved(raw, { legacy = false } = {}) {
  exactKeys(raw, ['revision', 'at', 'by', 'action', 'value'], 'saved version');
  if (!VERSION_ACTIONS.has(raw.action)) throw heartbeatError('saved version action is invalid');
  const by = actor(raw.by);
  exactKeys(raw.value, legacy
    ? ['name', 'task', 'meaningfulChange', 'completionRule', 'cadenceHours', 'toolNames', 'status']
    : ['name', 'task', 'meaningfulChange', 'completionRule', 'cadenceHours', 'toolNames', 'binding', 'status'], 'saved version value');
  if (!legacy && !Object.hasOwn(raw.value, 'binding')) throw heartbeatError('saved version value needs binding');
  const status = raw.value.status;
  if (!HEARTBEAT_STATUSES.includes(status)) throw heartbeatError('saved version status is invalid');
  const value = configuration({
    name: raw.value.name,
    task: raw.value.task,
    meaningfulChange: raw.value.meaningfulChange,
    completionRule: raw.value.completionRule,
    cadenceHours: raw.value.cadenceHours,
    toolNames: raw.value.toolNames,
    binding: legacy ? null : raw.value.binding,
  });
  return {
    revision: whole(raw.revision, 1, Number.MAX_SAFE_INTEGER, 'saved version revision'),
    at: iso(raw.at, 'saved version at'),
    by,
    action: raw.action,
    value: { ...value, status },
  };
}

function heartbeatFromSaved(raw, { legacy = false } = {}) {
  exactKeys(raw, [
    'id', 'revision', 'name', 'task', 'meaningfulChange', 'completionRule', 'cadenceHours', 'toolNames', 'status',
    ...(legacy ? [] : ['binding']),
    'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt', 'finishedAt', 'removedAt', 'versions',
  ], 'saved heartbeat');
  if (!legacy && !Object.hasOwn(raw, 'binding')) throw heartbeatError('saved heartbeat needs binding');
  if (!idPattern.test(raw.id)) throw heartbeatError('saved heartbeat id is invalid');
  const status = raw.status;
  if (!HEARTBEAT_STATUSES.includes(status)) throw heartbeatError('saved heartbeat status is invalid');
  const config = configuration({
    name: raw.name,
    task: raw.task,
    meaningfulChange: raw.meaningfulChange,
    completionRule: raw.completionRule,
    cadenceHours: raw.cadenceHours,
    toolNames: raw.toolNames,
    binding: legacy ? null : raw.binding,
  });
  if (!Array.isArray(raw.versions) || !raw.versions.length || raw.versions.length > TASK_HEARTBEAT_LIMITS.versions) {
    throw heartbeatError('saved heartbeat versions are invalid');
  }
  const row = {
    id: raw.id,
    revision: whole(raw.revision, 1, Number.MAX_SAFE_INTEGER, 'saved heartbeat revision'),
    ...config,
    status,
    createdAt: iso(raw.createdAt, 'saved heartbeat createdAt'),
    updatedAt: iso(raw.updatedAt, 'saved heartbeat updatedAt'),
    lastRunAt: iso(raw.lastRunAt, 'saved heartbeat lastRunAt', { nullable: true }),
    nextRunAt: iso(raw.nextRunAt, 'saved heartbeat nextRunAt', { nullable: true }),
    finishedAt: iso(raw.finishedAt, 'saved heartbeat finishedAt', { nullable: true }),
    removedAt: iso(raw.removedAt, 'saved heartbeat removedAt', { nullable: true }),
    versions: raw.versions.map(value => versionFromSaved(value, { legacy })),
  };
  if (row.versions[0].revision !== row.revision) throw heartbeatError('saved heartbeat latest version does not match its revision');
  if (canonicalJson(row.versions[0].value) !== canonicalJson(versionValue(row))) throw heartbeatError('saved heartbeat latest version does not match its value');
  if ((status === 'active') !== Boolean(row.nextRunAt)) throw heartbeatError('saved heartbeat nextRunAt is inconsistent with its status');
  if ((status === 'finished') !== Boolean(row.finishedAt)) throw heartbeatError('saved heartbeat finishedAt is inconsistent with its status');
  if ((status === 'removed') !== Boolean(row.removedAt)) throw heartbeatError('saved heartbeat removedAt is inconsistent with its status');
  return row;
}

function claimFromSaved(raw, knownIds) {
  exactKeys(raw, ['heartbeatId', 'token', 'claimedAt', 'expiresAt', 'runKind', 'definitionRevision'], 'saved claim');
  if (!knownIds.has(raw.heartbeatId)) throw heartbeatError('saved claim names an unknown heartbeat');
  if (!tokenPattern.test(raw.token)) throw heartbeatError('saved claim token is invalid');
  if (!['scheduled', 'manual'].includes(raw.runKind)) throw heartbeatError('saved claim runKind is invalid');
  return {
    heartbeatId: raw.heartbeatId,
    token: raw.token,
    claimedAt: iso(raw.claimedAt, 'saved claim claimedAt'),
    expiresAt: iso(raw.expiresAt, 'saved claim expiresAt'),
    runKind: raw.runKind,
    definitionRevision: whole(raw.definitionRevision, 1, Number.MAX_SAFE_INTEGER, 'saved claim definitionRevision'),
  };
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function emptyTaskHeartbeatState() {
  return { format: TASK_HEARTBEAT_FORMAT, revision: 0, heartbeats: [], receipts: [], claims: [] };
}

async function readTaskHeartbeatState(file) {
  try {
    const source = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(source) > TASK_HEARTBEAT_LIMITS.fileBytes) throw heartbeatError('saved file is too large', 500);
    const saved = parseJsonNoDuplicates(source, { where: 'task heartbeat file', maxDepth: 12 });
    exactKeys(saved, ['format', 'revision', 'heartbeats', 'receipts', 'claims'], 'saved task heartbeat file');
    if (![TASK_HEARTBEAT_FORMAT, LEGACY_TASK_HEARTBEAT_FORMAT].includes(saved.format)) {
      throw heartbeatError(`saved format must be ${TASK_HEARTBEAT_FORMAT}`, 500);
    }
    const legacy = saved.format === LEGACY_TASK_HEARTBEAT_FORMAT;
    if (!Array.isArray(saved.heartbeats) || saved.heartbeats.length > TASK_HEARTBEAT_LIMITS.kept) throw heartbeatError('saved heartbeats are invalid', 500);
    const heartbeats = saved.heartbeats.map(row => heartbeatFromSaved(row, { legacy }));
    const ids = new Set(heartbeats.map(row => row.id));
    if (ids.size !== heartbeats.length) throw heartbeatError('saved heartbeat ids repeat', 500);
    const liveNames = heartbeats.filter(row => row.status !== 'removed').map(row => row.name.toLocaleLowerCase('en-US'));
    if (new Set(liveNames).size !== liveNames.length) throw heartbeatError('saved live heartbeat names repeat', 500);
    if (!Array.isArray(saved.receipts) || saved.receipts.length > TASK_HEARTBEAT_LIMITS.receipts) throw heartbeatError('saved receipts are invalid', 500);
    if (!Array.isArray(saved.claims) || saved.claims.length > TASK_HEARTBEAT_LIMITS.kept) throw heartbeatError('saved claims are invalid', 500);
    const receipts = saved.receipts.map(row => receiptFromSaved(row, ids));
    const claims = saved.claims.map(row => claimFromSaved(row, ids));
    if (new Set(claims.map(row => row.heartbeatId)).size !== claims.length) throw heartbeatError('saved claims repeat a heartbeat', 500);
    return {
      format: TASK_HEARTBEAT_FORMAT,
      revision: whole(saved.revision, 0, Number.MAX_SAFE_INTEGER, 'saved revision'),
      heartbeats,
      receipts,
      claims,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyTaskHeartbeatState();
    throw error.message?.startsWith('Task heartbeats:') ? error : heartbeatError('could not read the saved file', 500, error);
  }
}

export async function createTaskHeartbeatStore({ file, clock = () => new Date(), claimMinutes = TASK_HEARTBEAT_LIMITS.claimMinutes } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw heartbeatError('file must be an absolute path', 500);
  if (typeof clock !== 'function') throw heartbeatError('clock must be a function', 500);
  whole(claimMinutes, 1, 60, 'claimMinutes');
  const atNow = () => {
    const value = clock();
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) throw heartbeatError('clock returned an invalid date', 500);
    return date;
  };
  const stateFile = await canonicalStateFile(file);
  let state = await withStateTransactionLock(stateFile, () => readTaskHeartbeatState(stateFile));

  const save = draft => atomicWrite(stateFile, draft);
  const freeze = value => deepFreeze(structuredClone(value));
  let queue = Promise.resolve();
  const serial = operation => {
    const job = queue.then(async () => {
      const committed = await withStateTransactionLock(stateFile, async () => {
        const latest = await readTaskHeartbeatState(stateFile);
        const draft = structuredClone(latest);
        const result = operation(draft);
        if (result.changed) {
          draft.revision = latest.revision + 1;
          await save(draft);
        }
        return { state: result.changed ? draft : latest, value: result.value };
      });
      state = committed.state;
      return freeze(committed.value);
    });
    queue = job.then(() => undefined, () => undefined);
    return job;
  };
  const find = (draft, id) => {
    const row = draft.heartbeats.find(item => item.id === id);
    if (!row) throw heartbeatError('no heartbeat has that id', 404);
    return row;
  };
  const claimFor = (draft, id) => draft.claims.find(item => item.heartbeatId === id) ?? null;
  const uniqueName = (draft, name, except = null) => {
    if (draft.heartbeats.some(row => row.id !== except && row.status !== 'removed' && row.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) {
      throw heartbeatError('another active heartbeat already has that name', 409);
    }
  };
  const receipt = (draft, value) => {
    const row = { id: `heartbeat-run-${randomUUID()}`, ...value };
    draft.receipts = [row, ...draft.receipts].slice(0, TASK_HEARTBEAT_LIMITS.receipts);
    return row;
  };
  const reapExpired = (draft, at) => {
    const expired = draft.claims.filter(item => Date.parse(item.expiresAt) <= at.getTime());
    if (!expired.length) return false;
    for (const claim of expired) {
      receipt(draft, {
        heartbeatId: claim.heartbeatId,
        at: at.toISOString(),
        outcome: 'claim-expired',
        runKind: claim.runKind,
        definitionRevision: claim.definitionRevision,
        claimedAt: claim.claimedAt,
      });
      const row = draft.heartbeats.find(item => item.id === claim.heartbeatId);
      if (row?.status === 'active') {
        row.nextRunAt = new Date(at.getTime() + row.cadenceHours * 3_600_000).toISOString();
      }
    }
    const expiredIds = new Set(expired.map(item => item.heartbeatId));
    draft.claims = draft.claims.filter(item => !expiredIds.has(item.heartbeatId));
    return true;
  };
  const viewAt = at => deepFreeze({
    format: TASK_HEARTBEAT_FORMAT,
    revision: state.revision,
    choices: { cadenceHours: TASK_HEARTBEAT_LIMITS.cadenceHours },
    heartbeats: state.heartbeats.map(row => publicHeartbeat(row, state, at)),
  });
  const editInput = (value, action) => {
    const raw = inputObject(value, `heartbeat ${action}`);
    exactKeys(raw, ['id', 'expectedRevision', 'actor'], `heartbeat ${action}`);
    if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw heartbeatError(`${action} needs a heartbeat id`);
    return { id: raw.id, expectedRevision: whole(raw.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision'), by: actor(raw.actor) };
  };
  const requireRevision = (row, expected) => {
    if (row.revision !== expected) throw heartbeatError(`heartbeat changed since it was read; expected revision ${expected}, current revision ${row.revision}`, 409);
  };

  const store = Object.freeze({
    view() { return viewAt(atNow()); },

    inspect(id) {
      if (typeof id !== 'string' || !idPattern.test(id)) throw heartbeatError('inspect needs a heartbeat id');
      const row = state.heartbeats.find(item => item.id === id);
      if (!row) throw heartbeatError('no heartbeat has that id', 404);
      const at = atNow();
      return deepFreeze({
        format: TASK_HEARTBEAT_FORMAT,
        heartbeat: publicHeartbeat(row, state, at),
        versions: structuredClone(row.versions),
        receipts: state.receipts.filter(item => item.heartbeatId === id).map(publicReceipt),
      });
    },

    create(value) {
      const raw = inputObject(value, 'heartbeat create');
      exactKeys(raw, ['definition', 'actor'], 'heartbeat create');
      const definition = configuration(inputObject(raw.definition, 'heartbeat definition'));
      const by = actor(raw.actor);
      const id = `heartbeat-${randomUUID()}`;
      return serial(draft => {
        if (draft.heartbeats.length >= TASK_HEARTBEAT_LIMITS.kept) throw heartbeatError(`at most ${TASK_HEARTBEAT_LIMITS.kept} heartbeats are kept`, 409);
        if (draft.heartbeats.filter(row => ['active', 'paused'].includes(row.status)).length >= TASK_HEARTBEAT_LIMITS.active) {
          throw heartbeatError(`at most ${TASK_HEARTBEAT_LIMITS.active} active or paused heartbeats are kept`, 409);
        }
        uniqueName(draft, definition.name);
        const at = atNow();
        const row = {
          id,
          revision: 1,
          ...definition,
          status: 'active',
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
          lastRunAt: null,
          nextRunAt: new Date(at.getTime() + definition.cadenceHours * 3_600_000).toISOString(),
          finishedAt: null,
          removedAt: null,
          versions: [],
        };
        addVersion(row, { at: row.updatedAt, by, action: 'created' });
        draft.heartbeats.unshift(row);
        return { changed: true, value: publicHeartbeat(row, draft, at) };
      });
    },

    update(value) {
      const raw = inputObject(value, 'heartbeat update');
      exactKeys(raw, ['id', 'expectedRevision', 'changes', 'actor'], 'heartbeat update');
      if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw heartbeatError('update needs a heartbeat id');
      const expected = whole(raw.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
      const changes = inputObject(raw.changes, 'heartbeat definition changes');
      if (!Object.keys(changes).length) throw heartbeatError('heartbeat definition changes must not be empty');
      const by = actor(raw.actor);
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, raw.id);
        requireRevision(row, expected);
        if (row.status === 'removed') throw heartbeatError('restore this heartbeat before editing it', 409);
        if (claimFor(draft, row.id)) throw heartbeatError('a running heartbeat cannot be edited', 409);
        const before = configFrom(row);
        const next = configuration(changes, before);
        uniqueName(draft, next.name, row.id);
        if (canonicalJson(before) === canonicalJson(next)) return { changed: reaped, value: publicHeartbeat(row, draft, at) };
        const cadenceChanged = row.cadenceHours !== next.cadenceHours;
        Object.assign(row, next, { revision: row.revision + 1, updatedAt: at.toISOString() });
        if (row.status === 'active' && cadenceChanged) row.nextRunAt = new Date(at.getTime() + row.cadenceHours * 3_600_000).toISOString();
        addVersion(row, { at: row.updatedAt, by, action: 'updated' });
        return { changed: true, value: publicHeartbeat(row, draft, at) };
      });
    },

    pause(value) {
      const edit = editInput(value, 'pause');
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'paused') return { changed: false, value: publicHeartbeat(row, draft, atNow()) };
        if (row.status !== 'active') throw heartbeatError('only an active heartbeat can be paused', 409);
        const at = atNow();
        Object.assign(row, { status: 'paused', revision: row.revision + 1, updatedAt: at.toISOString(), nextRunAt: null });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'paused' });
        return { changed: true, value: publicHeartbeat(row, draft, at) };
      });
    },

    resume(value) {
      const edit = editInput(value, 'resume');
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'active') return { changed: false, value: publicHeartbeat(row, draft, atNow()) };
        if (row.status !== 'paused') throw heartbeatError('only a paused heartbeat can be resumed', 409);
        const at = atNow();
        Object.assign(row, {
          status: 'active', revision: row.revision + 1, updatedAt: at.toISOString(),
          nextRunAt: new Date(at.getTime() + row.cadenceHours * 3_600_000).toISOString(),
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'resumed' });
        return { changed: true, value: publicHeartbeat(row, draft, at) };
      });
    },

    remove(value) {
      const edit = editInput(value, 'remove');
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'removed') return { changed: reaped, value: publicHeartbeat(row, draft, at) };
        if (claimFor(draft, row.id)) throw heartbeatError('a running heartbeat cannot be removed; pause it and wait for the run to finish', 409);
        Object.assign(row, {
          status: 'removed', revision: row.revision + 1, updatedAt: at.toISOString(),
          nextRunAt: null, finishedAt: null, removedAt: at.toISOString(),
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'removed' });
        return { changed: true, value: publicHeartbeat(row, draft, at) };
      });
    },

    restore(value) {
      const edit = editInput(value, 'restore');
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status !== 'removed') throw heartbeatError('only a removed heartbeat can be restored', 409);
        uniqueName(draft, row.name, row.id);
        if (draft.heartbeats.filter(item => ['active', 'paused'].includes(item.status)).length >= TASK_HEARTBEAT_LIMITS.active) {
          throw heartbeatError(`at most ${TASK_HEARTBEAT_LIMITS.active} active or paused heartbeats are kept`, 409);
        }
        const at = atNow();
        Object.assign(row, {
          status: 'paused', revision: row.revision + 1, updatedAt: at.toISOString(),
          nextRunAt: null, finishedAt: null, removedAt: null,
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'restored' });
        return { changed: true, value: publicHeartbeat(row, draft, at) };
      });
    },

    claimDue() {
      return serial(draft => {
        const at = atNow();
        let changed = reapExpired(draft, at);
        const claimed = new Set(draft.claims.map(item => item.heartbeatId));
        const row = draft.heartbeats
          .filter(item => item.status === 'active' && item.nextRunAt && Date.parse(item.nextRunAt) <= at.getTime() && !claimed.has(item.id))
          .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt) || a.createdAt.localeCompare(b.createdAt))[0];
        if (!row) return { changed, value: { started: false, reason: 'not due' } };
        const claim = {
          heartbeatId: row.id,
          token: randomUUID(),
          claimedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + claimMinutes * 60_000).toISOString(),
          runKind: 'scheduled',
          definitionRevision: row.revision,
        };
        draft.claims.push(claim);
        changed = true;
        return { changed, value: { started: true, claim, heartbeat: publicHeartbeat(row, draft, at) } };
      });
    },

    claimNow(id) {
      if (typeof id !== 'string' || !idPattern.test(id)) return Promise.reject(heartbeatError('run now needs a heartbeat id'));
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, id);
        if (['finished', 'removed'].includes(row.status)) return { changed: reaped, value: { started: false, reason: row.status } };
        if (claimFor(draft, row.id)) return { changed: reaped, value: { started: false, reason: 'claimed' } };
        const claim = {
          heartbeatId: row.id,
          token: randomUUID(),
          claimedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + claimMinutes * 60_000).toISOString(),
          runKind: 'manual',
          definitionRevision: row.revision,
        };
        draft.claims.push(claim);
        return { changed: true, value: { started: true, claim, heartbeat: publicHeartbeat(row, draft, at) } };
      });
    },

    async finish(value) {
      const raw = inputObject(value, 'heartbeat finish');
      exactKeys(raw, ['id', 'claimToken', 'outcome', 'note'], 'heartbeat finish');
      if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw heartbeatError('finish needs a heartbeat id');
      if (typeof raw.claimToken !== 'string' || !tokenPattern.test(raw.claimToken)) throw heartbeatError('finish needs the exact claim token');
      if (!RUN_OUTCOMES.includes(raw.outcome)) throw heartbeatError(`outcome must be ${RUN_OUTCOMES.join(', ')}`);
      const note = raw.note === undefined ? '' : cleanText(raw.note, TASK_HEARTBEAT_LIMITS.noteCharacters, 'note', { multiline: true });
      if (raw.outcome === 'no-change' && note) throw heartbeatError('no-change must not carry a message');
      if (['changed', 'finished'].includes(raw.outcome) && !note) throw heartbeatError(`${raw.outcome} needs a note for the person`);
      const result = await serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, raw.id);
        const index = draft.claims.findIndex(item => item.heartbeatId === row.id && item.token === raw.claimToken);
        if (index < 0) return { changed: reaped, value: { stale: true } };
        const [claim] = draft.claims.splice(index, 1);
        row.lastRunAt = at.toISOString();
        row.nextRunAt = row.status === 'active' ? new Date(at.getTime() + row.cadenceHours * 3_600_000).toISOString() : null;
        if (raw.outcome === 'finished' && row.status !== 'finished') {
          Object.assign(row, {
            status: 'finished', revision: row.revision + 1, updatedAt: at.toISOString(),
            nextRunAt: null, finishedAt: at.toISOString(), removedAt: null,
          });
          addVersion(row, { at: row.updatedAt, by: 'system', action: 'finished' });
        }
        const savedReceipt = receipt(draft, {
          heartbeatId: row.id,
          at: at.toISOString(),
          outcome: raw.outcome,
          runKind: claim.runKind,
          definitionRevision: claim.definitionRevision,
          claimedAt: claim.claimedAt,
          ...(note ? { note } : {}),
        });
        return { changed: true, value: { stale: false, receipt: publicReceipt(savedReceipt), heartbeat: publicHeartbeat(row, draft, at) } };
      });
      if (result.stale) throw heartbeatError('that heartbeat claim expired or was already finished', 409);
      return result;
    },
  });
  stores.add(store);
  return store;
}

// One local runner asks for the next due heartbeat and resolves it through the
// exact claim token. The durable claim is the cross-wake fence; the local busy
// flag also prevents two ticks in this scheduler from starting together.
export function startTaskHeartbeatScheduler({ store, run, canRun = () => true, everyMs = 60_000, onError = () => {}, onPersist } = {}) {
  if (!stores.has(store)) throw heartbeatError('store must come from createTaskHeartbeatStore()', 500);
  if (typeof run !== 'function') throw heartbeatError('run must be a function', 500);
  if (typeof canRun !== 'function' || typeof onError !== 'function') throw heartbeatError('canRun and onError must be functions', 500);
  if (onPersist !== undefined && typeof onPersist !== 'function') throw heartbeatError('onPersist must be a function', 500);
  if (!Number.isSafeInteger(everyMs) || everyMs < 10) throw heartbeatError('everyMs must be at least 10', 500);
  let stopped = false;
  let running = false;
  let runningId = null;
  let current = null;

  const start = async (id = null) => {
    if (stopped || running) return { started: false, reason: stopped ? 'stopped' : 'busy' };
    if (!canRun()) return { started: false, reason: 'busy' };
    running = true;
    const work = (async () => {
      let claim;
      try {
        claim = id ? await store.claimNow(id) : await store.claimDue();
        if (!claim.started) return claim;
        runningId = claim.heartbeat.id;
        let result;
        let runSucceeded = true;
        try {
          result = await run(claim.heartbeat);
        } catch (error) {
          runSucceeded = false;
          try { onError(error); } catch { /* diagnostics never replace the receipt */ }
          result = { outcome: 'failed', note: 'The heartbeat could not finish.' };
        }
        let cleanNote = '';
        try {
          if (isPlainObject(result) && result.note !== undefined) {
            cleanNote = cleanText(result.note, TASK_HEARTBEAT_LIMITS.noteCharacters, 'runner note', { multiline: true });
          }
        } catch {
          result = null;
        }
        if (
          !isPlainObject(result)
          || !RUN_OUTCOMES.includes(result.outcome)
          || (result.outcome === 'no-change' && cleanNote)
          || (['changed', 'finished'].includes(result.outcome) && !cleanNote)
        ) {
          runSucceeded = false;
          result = { outcome: 'failed', note: 'The heartbeat returned an invalid outcome.' };
        } else {
          result = { outcome: result.outcome, ...(cleanNote ? { note: cleanNote } : {}) };
        }
        let finished;
        let persistError = null;
        try {
          finished = await store.finish({
            id: claim.heartbeat.id,
            claimToken: claim.claim.token,
            outcome: result.outcome,
            ...(result.note === undefined ? {} : { note: result.note }),
          });
        } catch (error) {
          persistError = error;
        }
        try {
          await onPersist?.(Object.freeze({
            id: claim.heartbeat.id,
            runKind: claim.claim.runKind,
            outcome: result.outcome,
            runSucceeded,
            saved: persistError === null,
            error: persistError,
          }));
        } catch (error) {
          try { onError(error); } catch { /* diagnostics never restart the run */ }
        }
        if (persistError) throw persistError;
        return { started: true, heartbeatId: claim.heartbeat.id, ...finished };
      } finally {
        runningId = null;
        running = false;
        current = null;
      }
    })();
    current = work;
    return work;
  };
  const timer = setInterval(() => { void start().catch(error => { try { onError(error); } catch { /* keep the timer alive */ } }); }, everyMs);
  timer.unref?.();
  const scheduler = Object.freeze({
    get running() { return running; },
    get runningId() { return runningId; },
    tick: () => start(),
    now: id => start(id),
    wait: () => current ?? Promise.resolve(),
    stop() { stopped = true; clearInterval(timer); },
  });
  return scheduler;
}
