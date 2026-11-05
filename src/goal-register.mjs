import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

// A goal is not a reminder, and a promise is not a motivational label. This
// register keeps the distinction durable: goals name who chose them, success
// signals, and a review edge; promises name their beneficiary, source, and
// return window. Numeric measures name their source before any samples arrive.

export const GOAL_REGISTER_FORMAT = 'fieldwork-goal-register/v1';
export const GOAL_REGISTER_LIMITS = Object.freeze({
  records: 100,
  active: 24,
  versions: 50,
  checks: 2000,
  measures: 8,
  nameCharacters: 100,
  statementCharacters: 4000,
  sourceCharacters: 2000,
  beneficiaryCharacters: 200,
  signalCharacters: 2000,
  statusNoteCharacters: 2000,
  measureKeyCharacters: 32,
  measureLabelCharacters: 80,
  measureUnitCharacters: 40,
  measureSourceCharacters: 500,
  checkNoteCharacters: 1000,
  numberMagnitude: 1_000_000_000_000,
  fileBytes: 4 * 1024 * 1024,
});

const KINDS = Object.freeze(['goal', 'promise']);
const CHOOSERS = Object.freeze(['agent', 'person']);
const STATUSES = Object.freeze(['active', 'paused', 'finished', 'retired', 'removed']);
const LIVE_STATUSES = new Set(['active', 'paused']);
const CHECK_OUTCOMES = Object.freeze(['observed', 'no-change', 'no-data']);
const TARGET_CONDITIONS = Object.freeze(['at-least', 'at-most', 'exact']);
const VERSION_ACTIONS = new Set(['created', 'updated', 'paused', 'resumed', 'finished', 'retired', 'removed', 'restored']);
const ACTORS = new Set(['person', 'agent', 'system']);
const idPattern = /^(goal|promise)-[0-9a-f-]{36}$/;
const checkIdPattern = /^goal-check-[0-9a-f-]{36}$/;
const measureKeyPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const stores = new WeakSet();

function registerError(message, status = 400, cause) {
  const error = new Error(`Goal register: ${message}`, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function exactKeys(value, allowed, where) {
  if (!isPlainObject(value)) throw registerError(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw registerError(`${where} has unknown field ${JSON.stringify(key)}`);
}

function inputObject(value, where, maxBytes = 64 * 1024) {
  try { return boundedJson(value, { where, object: true, maxBytes, maxDepth: 10, maxNodes: 1000 }).value; }
  catch (error) { throw registerError(error.message, 400, error); }
}

function cleanText(value, limit, what, { required = false, multiline = false } = {}) {
  if (typeof value !== 'string') throw registerError(`${what} must be text`);
  const text = (multiline
    ? value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/gu, ' ').replace(/\n{3,}/gu, '\n\n')
    : value.replace(/\s+/gu, ' ')).trim();
  if (required && !text) throw registerError(`${what} must not be empty`);
  if ([...text].length > limit) throw registerError(`${what} is at most ${limit} characters`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)) throw registerError(`${what} contains control characters`);
  return text;
}

function iso(value, what, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw registerError(`${what} must be an exact ISO timestamp`);
  let normalized;
  try { normalized = new Date(value).toISOString(); } catch { throw registerError(`${what} must be an exact ISO timestamp`); }
  if (normalized !== value) throw registerError(`${what} must be an exact ISO timestamp`);
  return value;
}

function whole(value, minimum, maximum, what) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw registerError(`${what} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

function actor(value, fallback = 'person') {
  const normalized = value ?? fallback;
  if (!ACTORS.has(normalized)) throw registerError('actor must be person, agent, or system');
  return normalized;
}

function finiteNumber(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > GOAL_REGISTER_LIMITS.numberMagnitude) {
    throw registerError(`${what} must be a finite number between -${GOAL_REGISTER_LIMITS.numberMagnitude} and ${GOAL_REGISTER_LIMITS.numberMagnitude}`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function measures(value) {
  if (!Array.isArray(value)) throw registerError('measures must be an array');
  if (value.length > GOAL_REGISTER_LIMITS.measures) throw registerError(`at most ${GOAL_REGISTER_LIMITS.measures} measures may be defined`);
  const result = value.map((raw, index) => {
    exactKeys(raw, ['key', 'label', 'unit', 'source', 'target', 'targetCondition'], `measure ${index + 1}`);
    const key = cleanText(raw.key, GOAL_REGISTER_LIMITS.measureKeyCharacters, `measure ${index + 1} key`, { required: true });
    if (!measureKeyPattern.test(key)) throw registerError('measure keys use lowercase letters, digits, _ or -, starting with a letter');
    const label = cleanText(raw.label, GOAL_REGISTER_LIMITS.measureLabelCharacters, `measure ${key} label`, { required: true });
    const unit = cleanText(raw.unit, GOAL_REGISTER_LIMITS.measureUnitCharacters, `measure ${key} unit`, { required: true });
    const source = cleanText(raw.source, GOAL_REGISTER_LIMITS.measureSourceCharacters, `measure ${key} source`, { required: true, multiline: true });
    const hasTarget = raw.target !== undefined && raw.target !== null;
    const target = hasTarget ? finiteNumber(raw.target, `measure ${key} target`) : null;
    const targetCondition = raw.targetCondition ?? null;
    if (hasTarget !== Boolean(targetCondition)) throw registerError(`measure ${key} target and targetCondition must be supplied together`);
    if (targetCondition !== null && !TARGET_CONDITIONS.includes(targetCondition)) {
      throw registerError(`measure ${key} targetCondition must be ${TARGET_CONDITIONS.join(', ')}`);
    }
    return { key, label, unit, source, target, targetCondition };
  });
  if (new Set(result.map(item => item.key)).size !== result.length) throw registerError('measure keys must be unique');
  return result;
}

function definition(raw, base = null) {
  exactKeys(raw, [
    'kind', 'name', 'statement', 'chosenBy', 'source', 'beneficiary', 'successSignals',
    'reviewAt', 'returnFrom', 'returnBy', 'measures',
  ], 'register definition');
  if (!base) {
    for (const key of ['kind', 'name', 'statement', 'chosenBy', 'source']) {
      if (!Object.hasOwn(raw, key)) throw registerError(`register definition needs ${key}`);
    }
  }
  const next = base ? structuredClone(base) : {
    beneficiary: '', successSignals: '', reviewAt: null, returnFrom: null, returnBy: null, measures: [],
  };
  if (Object.hasOwn(raw, 'kind')) {
    if (!KINDS.includes(raw.kind)) throw registerError(`kind must be ${KINDS.join(' or ')}`);
    if (base && raw.kind !== base.kind) throw registerError('a goal cannot be changed into a promise or vice versa');
    next.kind = raw.kind;
  }
  if (Object.hasOwn(raw, 'name')) next.name = cleanText(raw.name, GOAL_REGISTER_LIMITS.nameCharacters, 'name', { required: true });
  if (Object.hasOwn(raw, 'statement')) next.statement = cleanText(raw.statement, GOAL_REGISTER_LIMITS.statementCharacters, 'statement', { required: true, multiline: true });
  if (Object.hasOwn(raw, 'chosenBy')) {
    if (!CHOOSERS.includes(raw.chosenBy)) throw registerError(`chosenBy must be ${CHOOSERS.join(' or ')}`);
    next.chosenBy = raw.chosenBy;
  }
  if (Object.hasOwn(raw, 'source')) next.source = cleanText(raw.source, GOAL_REGISTER_LIMITS.sourceCharacters, 'source', { required: true, multiline: true });
  if (Object.hasOwn(raw, 'beneficiary')) next.beneficiary = cleanText(raw.beneficiary, GOAL_REGISTER_LIMITS.beneficiaryCharacters, 'beneficiary');
  if (Object.hasOwn(raw, 'successSignals')) next.successSignals = cleanText(raw.successSignals, GOAL_REGISTER_LIMITS.signalCharacters, 'successSignals', { multiline: true });
  if (Object.hasOwn(raw, 'reviewAt')) next.reviewAt = raw.reviewAt === null ? null : iso(raw.reviewAt, 'reviewAt');
  if (Object.hasOwn(raw, 'returnFrom')) next.returnFrom = raw.returnFrom === null ? null : iso(raw.returnFrom, 'returnFrom');
  if (Object.hasOwn(raw, 'returnBy')) next.returnBy = raw.returnBy === null ? null : iso(raw.returnBy, 'returnBy');
  if (Object.hasOwn(raw, 'measures')) next.measures = measures(raw.measures);
  if (next.kind === 'goal') {
    if (!next.successSignals) throw registerError('a goal needs explicit successSignals');
    if (!next.reviewAt) throw registerError('a goal needs an exact reviewAt timestamp');
    if (next.beneficiary || next.returnFrom || next.returnBy) throw registerError('a goal does not use beneficiary or a promise return window');
  } else if (next.kind === 'promise') {
    if (!next.beneficiary) throw registerError('a promise needs a beneficiary');
    if (!next.returnFrom || !next.returnBy) throw registerError('a promise needs exact returnFrom and returnBy timestamps');
    if (Date.parse(next.returnFrom) > Date.parse(next.returnBy)) throw registerError('a promise returnFrom must not be after returnBy');
    if (next.successSignals || next.reviewAt) throw registerError('a promise uses its beneficiary and return window, not goal successSignals or reviewAt');
  }
  return next;
}

function configFrom(row) {
  return {
    kind: row.kind,
    name: row.name,
    statement: row.statement,
    chosenBy: row.chosenBy,
    source: row.source,
    beneficiary: row.beneficiary,
    successSignals: row.successSignals,
    reviewAt: row.reviewAt,
    returnFrom: row.returnFrom,
    returnBy: row.returnBy,
    measures: structuredClone(row.measures),
  };
}

function definitionFields(raw) {
  return {
    kind: raw.kind,
    name: raw.name,
    statement: raw.statement,
    chosenBy: raw.chosenBy,
    source: raw.source,
    beneficiary: raw.beneficiary,
    successSignals: raw.successSignals,
    reviewAt: raw.reviewAt,
    returnFrom: raw.returnFrom,
    returnBy: raw.returnBy,
    measures: raw.measures,
  };
}

function versionValue(row) {
  return deepFreeze({ ...configFrom(row), status: row.status, statusNote: row.statusNote, removedFrom: row.removedFrom });
}

function addVersion(row, { at, by, action }) {
  row.versions = [{ revision: row.revision, at, by, action, value: versionValue(row) }, ...row.versions]
    .slice(0, GOAL_REGISTER_LIMITS.versions);
}

function reached(measure, value) {
  if (measure.target === null) return null;
  if (measure.targetCondition === 'at-least') return value >= measure.target;
  if (measure.targetCondition === 'at-most') return value <= measure.target;
  return value === measure.target;
}

function statsFor(row, checks) {
  return row.measures.map(measure => {
    const related = checks.filter(check => check.recordId === row.id && check.measureKey === measure.key)
      .sort((left, right) => right.at.localeCompare(left.at));
    const samples = related.filter(check => check.outcome === 'observed')
      .sort((left, right) => left.observedThrough.localeCompare(right.observedThrough) || left.at.localeCompare(right.at));
    const edged = related.filter(check => check.observedThrough)
      .sort((left, right) => left.observedThrough.localeCompare(right.observedThrough) || left.at.localeCompare(right.at));
    const first = samples[0] ?? null;
    const latest = samples.at(-1) ?? null;
    const values = samples.map(check => check.value);
    return {
      ...structuredClone(measure),
      checks: related.length,
      samples: samples.length,
      observedThrough: edged.at(-1)?.observedThrough ?? null,
      latestOutcome: related[0]?.outcome ?? null,
      first: first ? { value: first.value, observedThrough: first.observedThrough, recordedAt: first.at } : null,
      latest: latest ? { value: latest.value, observedThrough: latest.observedThrough, recordedAt: latest.at } : null,
      minimum: values.length ? Math.min(...values) : null,
      maximum: values.length ? Math.max(...values) : null,
      change: first && latest ? latest.value - first.value : null,
      targetReached: latest ? reached(measure, latest.value) : null,
    };
  });
}

function clockFor(row, at) {
  if (!LIVE_STATUSES.has(row.status)) return { due: false, overdue: false, edge: null };
  if (row.kind === 'goal') {
    return { due: Date.parse(row.reviewAt) <= at.getTime(), overdue: false, edge: row.reviewAt };
  }
  return {
    due: Date.parse(row.returnFrom) <= at.getTime(),
    overdue: Date.parse(row.returnBy) < at.getTime(),
    edge: row.returnBy,
  };
}

function publicRecord(row, state, at) {
  const related = state.checks.filter(check => check.recordId === row.id);
  return {
    id: row.id,
    revision: row.revision,
    ...configFrom(row),
    status: row.status,
    statusNote: row.statusNote,
    removedFrom: row.removedFrom,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pausedAt: row.pausedAt,
    finishedAt: row.finishedAt,
    retiredAt: row.retiredAt,
    removedAt: row.removedAt,
    lastCheckedAt: related[0]?.at ?? null,
    clock: clockFor(row, at),
    statistics: statsFor(row, state.checks),
  };
}

function publicCheck(check) {
  return {
    id: check.id,
    recordId: check.recordId,
    measureKey: check.measureKey,
    label: check.label,
    unit: check.unit,
    source: check.source,
    at: check.at,
    outcome: check.outcome,
    observedThrough: check.observedThrough,
    by: check.by,
    ...(check.value === null ? {} : { value: check.value }),
    ...(check.note ? { note: check.note } : {}),
  };
}

function versionFromSaved(raw) {
  exactKeys(raw, ['revision', 'at', 'by', 'action', 'value'], 'saved version');
  if (!VERSION_ACTIONS.has(raw.action)) throw registerError('saved version action is invalid');
  const by = actor(raw.by);
  exactKeys(raw.value, [
    'kind', 'name', 'statement', 'chosenBy', 'source', 'beneficiary', 'successSignals', 'reviewAt',
    'returnFrom', 'returnBy', 'measures', 'status', 'statusNote', 'removedFrom',
  ], 'saved version value');
  const value = definition(definitionFields(raw.value));
  if (!STATUSES.includes(raw.value.status)) throw registerError('saved version status is invalid');
  const removedFrom = raw.value.removedFrom;
  if (removedFrom !== null && !STATUSES.filter(status => status !== 'removed').includes(removedFrom)) throw registerError('saved version removedFrom is invalid');
  return {
    revision: whole(raw.revision, 1, Number.MAX_SAFE_INTEGER, 'saved version revision'),
    at: iso(raw.at, 'saved version at'),
    by,
    action: raw.action,
    value: {
      ...value,
      status: raw.value.status,
      statusNote: cleanText(raw.value.statusNote, GOAL_REGISTER_LIMITS.statusNoteCharacters, 'saved version statusNote', { multiline: true }),
      removedFrom,
    },
  };
}

function recordFromSaved(raw) {
  exactKeys(raw, [
    'id', 'revision', 'kind', 'name', 'statement', 'chosenBy', 'source', 'beneficiary', 'successSignals',
    'reviewAt', 'returnFrom', 'returnBy', 'measures', 'status', 'statusNote', 'removedFrom',
    'createdAt', 'updatedAt', 'pausedAt', 'finishedAt', 'retiredAt', 'removedAt', 'versions',
  ], 'saved record');
  if (!idPattern.test(raw.id)) throw registerError('saved record id is invalid');
  const config = definition(definitionFields(raw));
  if (raw.id.startsWith('goal-') !== (config.kind === 'goal')) throw registerError('saved record id does not match its kind');
  if (!STATUSES.includes(raw.status)) throw registerError('saved record status is invalid');
  const statusNote = cleanText(raw.statusNote, GOAL_REGISTER_LIMITS.statusNoteCharacters, 'saved statusNote', { multiline: true });
  const removedFrom = raw.removedFrom;
  if (removedFrom !== null && !STATUSES.filter(status => status !== 'removed').includes(removedFrom)) throw registerError('saved removedFrom is invalid');
  if (!Array.isArray(raw.versions) || !raw.versions.length || raw.versions.length > GOAL_REGISTER_LIMITS.versions) {
    throw registerError('saved versions are invalid');
  }
  const row = {
    id: raw.id,
    revision: whole(raw.revision, 1, Number.MAX_SAFE_INTEGER, 'saved record revision'),
    ...config,
    status: raw.status,
    statusNote,
    removedFrom,
    createdAt: iso(raw.createdAt, 'saved createdAt'),
    updatedAt: iso(raw.updatedAt, 'saved updatedAt'),
    pausedAt: iso(raw.pausedAt, 'saved pausedAt', { nullable: true }),
    finishedAt: iso(raw.finishedAt, 'saved finishedAt', { nullable: true }),
    retiredAt: iso(raw.retiredAt, 'saved retiredAt', { nullable: true }),
    removedAt: iso(raw.removedAt, 'saved removedAt', { nullable: true }),
    versions: raw.versions.map(versionFromSaved),
  };
  if (row.versions[0].revision !== row.revision || canonicalJson(row.versions[0].value) !== canonicalJson(versionValue(row))) {
    throw registerError('saved latest version does not match the record');
  }
  if ((row.status === 'paused') !== Boolean(row.pausedAt)) throw registerError('saved pausedAt is inconsistent with status');
  if ((row.status === 'finished' || row.removedFrom === 'finished') !== Boolean(row.finishedAt)) throw registerError('saved finishedAt is inconsistent with status');
  if ((row.status === 'retired' || row.removedFrom === 'retired') !== Boolean(row.retiredAt)) throw registerError('saved retiredAt is inconsistent with status');
  if ((row.status === 'removed') !== Boolean(row.removedAt) || (row.status === 'removed') !== Boolean(row.removedFrom)) {
    throw registerError('saved removal state is inconsistent');
  }
  if (['finished', 'retired'].includes(row.status) && !row.statusNote) throw registerError('saved terminal record needs a status note');
  return row;
}

function checkFromSaved(raw, records) {
  exactKeys(raw, ['id', 'recordId', 'measureKey', 'label', 'unit', 'source', 'at', 'outcome', 'observedThrough', 'value', 'note', 'by'], 'saved check');
  if (!checkIdPattern.test(raw.id)) throw registerError('saved check id is invalid');
  if (!records.has(raw.recordId)) throw registerError('saved check names an unknown record');
  if (!measureKeyPattern.test(raw.measureKey)) throw registerError('saved check measureKey is invalid');
  if (!CHECK_OUTCOMES.includes(raw.outcome)) throw registerError('saved check outcome is invalid');
  const outcome = raw.outcome;
  const observedThrough = raw.observedThrough === null ? null : iso(raw.observedThrough, 'saved check observedThrough');
  const value = raw.value === null ? null : finiteNumber(raw.value, 'saved check value');
  const note = cleanText(raw.note, GOAL_REGISTER_LIMITS.checkNoteCharacters, 'saved check note', { multiline: true });
  if (outcome === 'observed' && (value === null || !observedThrough)) throw registerError('saved observed check needs value and observedThrough');
  if (outcome === 'no-change' && (value !== null || !observedThrough)) throw registerError('saved no-change check needs observedThrough and no value');
  if (outcome === 'no-data' && (value !== null || observedThrough !== null || !note)) throw registerError('saved no-data check needs a note and no value or observedThrough');
  return {
    id: raw.id,
    recordId: raw.recordId,
    measureKey: raw.measureKey,
    label: cleanText(raw.label, GOAL_REGISTER_LIMITS.measureLabelCharacters, 'saved check label', { required: true }),
    unit: cleanText(raw.unit, GOAL_REGISTER_LIMITS.measureUnitCharacters, 'saved check unit', { required: true }),
    source: cleanText(raw.source, GOAL_REGISTER_LIMITS.measureSourceCharacters, 'saved check source', { required: true, multiline: true }),
    at: iso(raw.at, 'saved check at'),
    outcome,
    observedThrough,
    value,
    note,
    by: actor(raw.by),
  };
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function validClock(clock) {
  const date = clock();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw registerError('clock must return a valid Date', 500);
  return date;
}

export async function createGoalRegister({ file, clock = () => new Date() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw registerError('file must be an absolute path', 500);
  if (typeof clock !== 'function') throw registerError('clock must be a function', 500);
  const atNow = () => new Date(validClock(clock).getTime());
  atNow();
  let state = { format: GOAL_REGISTER_FORMAT, revision: 0, records: [], checks: [] };
  try {
    const source = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(source) > GOAL_REGISTER_LIMITS.fileBytes) throw registerError('saved file is too large', 500);
    const saved = parseJsonNoDuplicates(source, { where: 'goal register file', maxDepth: 14 });
    exactKeys(saved, ['format', 'revision', 'records', 'checks'], 'saved goal register file');
    if (saved.format !== GOAL_REGISTER_FORMAT) throw registerError(`saved format must be ${GOAL_REGISTER_FORMAT}`, 500);
    if (!Array.isArray(saved.records) || saved.records.length > GOAL_REGISTER_LIMITS.records) throw registerError('saved records are invalid', 500);
    const records = saved.records.map(recordFromSaved);
    const ids = new Set(records.map(row => row.id));
    if (ids.size !== records.length) throw registerError('saved record ids repeat', 500);
    const liveNames = records.filter(row => row.status !== 'removed').map(row => row.name.toLocaleLowerCase('en-US'));
    if (new Set(liveNames).size !== liveNames.length) throw registerError('saved live record names repeat', 500);
    if (records.filter(row => LIVE_STATUSES.has(row.status)).length > GOAL_REGISTER_LIMITS.active) throw registerError('saved active record limit is exceeded', 500);
    if (!Array.isArray(saved.checks) || saved.checks.length > GOAL_REGISTER_LIMITS.checks) throw registerError('saved checks are invalid', 500);
    const checks = saved.checks.map(row => checkFromSaved(row, ids));
    if (new Set(checks.map(row => row.id)).size !== checks.length) throw registerError('saved check ids repeat', 500);
    state = {
      format: GOAL_REGISTER_FORMAT,
      revision: whole(saved.revision, 0, Number.MAX_SAFE_INTEGER, 'saved revision'),
      records,
      checks,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error.message?.startsWith('Goal register:') ? error : registerError('could not read the saved file', 500, error);
  }

  const freeze = value => deepFreeze(structuredClone(value));
  let queue = Promise.resolve();
  const serial = operation => {
    const job = queue.then(async () => {
      const draft = structuredClone(state);
      const result = operation(draft);
      if (result.changed) {
        draft.revision = state.revision + 1;
        await atomicWrite(file, draft);
        state = draft;
      }
      return freeze(result.value);
    });
    queue = job.then(() => undefined, () => undefined);
    return job;
  };
  const find = (draft, id) => {
    const row = draft.records.find(item => item.id === id);
    if (!row) throw registerError('no goal or promise has that id', 404);
    return row;
  };
  const requireRevision = (row, expected) => {
    if (row.revision !== expected) throw registerError(`record changed since it was read; expected revision ${expected}, current revision ${row.revision}`, 409);
  };
  const uniqueName = (draft, name, except = null) => {
    if (draft.records.some(row => row.id !== except && row.status !== 'removed' && row.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) {
      throw registerError('another live goal or promise already has that name', 409);
    }
  };
  const editInput = (value, action, { note = false } = {}) => {
    const raw = inputObject(value, `register ${action}`);
    exactKeys(raw, note ? ['id', 'expectedRevision', 'reason', 'actor'] : ['id', 'expectedRevision', 'actor'], `register ${action}`);
    if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw registerError(`${action} needs a goal or promise id`);
    return {
      id: raw.id,
      expectedRevision: whole(raw.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision'),
      by: actor(raw.actor),
      ...(note ? { reason: cleanText(raw.reason, GOAL_REGISTER_LIMITS.statusNoteCharacters, 'reason', { required: true, multiline: true }) } : {}),
    };
  };
  const viewAt = at => deepFreeze({
    format: GOAL_REGISTER_FORMAT,
    revision: state.revision,
    records: state.records.map(row => publicRecord(row, state, at)),
  });

  const store = Object.freeze({
    view() { return viewAt(atNow()); },

    inspect(id) {
      if (typeof id !== 'string' || !idPattern.test(id)) throw registerError('inspect needs a goal or promise id');
      const row = state.records.find(item => item.id === id);
      if (!row) throw registerError('no goal or promise has that id', 404);
      return deepFreeze({
        format: GOAL_REGISTER_FORMAT,
        record: publicRecord(row, state, atNow()),
        versions: structuredClone(row.versions),
        checks: state.checks.filter(check => check.recordId === id).map(publicCheck),
      });
    },

    create(value) {
      const raw = inputObject(value, 'register create');
      exactKeys(raw, ['definition', 'actor'], 'register create');
      const configured = definition(inputObject(raw.definition, 'register definition'));
      const by = actor(raw.actor);
      const id = `${configured.kind}-${randomUUID()}`;
      return serial(draft => {
        if (draft.records.length >= GOAL_REGISTER_LIMITS.records) throw registerError(`at most ${GOAL_REGISTER_LIMITS.records} goals and promises are kept`, 409);
        if (draft.records.filter(row => LIVE_STATUSES.has(row.status)).length >= GOAL_REGISTER_LIMITS.active) {
          throw registerError(`at most ${GOAL_REGISTER_LIMITS.active} active or paused goals and promises are kept`, 409);
        }
        uniqueName(draft, configured.name);
        const at = atNow().toISOString();
        const row = {
          id,
          revision: 1,
          ...configured,
          status: 'active',
          statusNote: '',
          removedFrom: null,
          createdAt: at,
          updatedAt: at,
          pausedAt: null,
          finishedAt: null,
          retiredAt: null,
          removedAt: null,
          versions: [],
        };
        addVersion(row, { at, by, action: 'created' });
        draft.records.unshift(row);
        return { changed: true, value: publicRecord(row, draft, new Date(at)) };
      });
    },

    update(value) {
      const raw = inputObject(value, 'register update');
      exactKeys(raw, ['id', 'expectedRevision', 'changes', 'actor'], 'register update');
      if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw registerError('update needs a goal or promise id');
      const expected = whole(raw.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
      const changes = inputObject(raw.changes, 'register definition changes');
      if (!Object.keys(changes).length) throw registerError('register definition changes must not be empty');
      const by = actor(raw.actor);
      return serial(draft => {
        const row = find(draft, raw.id);
        requireRevision(row, expected);
        if (row.status === 'removed') throw registerError('restore this record before editing it', 409);
        const before = configFrom(row);
        const next = definition(changes, before);
        uniqueName(draft, next.name, row.id);
        if (canonicalJson(before) === canonicalJson(next)) return { changed: false, value: publicRecord(row, draft, atNow()) };
        const at = atNow();
        Object.assign(row, next, { revision: row.revision + 1, updatedAt: at.toISOString() });
        addVersion(row, { at: row.updatedAt, by, action: 'updated' });
        return { changed: true, value: publicRecord(row, draft, at) };
      });
    },

    pause(value) {
      const edit = editInput(value, 'pause');
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'paused') return { changed: false, value: publicRecord(row, draft, atNow()) };
        if (row.status !== 'active') throw registerError('only an active record can be paused', 409);
        const at = atNow();
        Object.assign(row, { status: 'paused', revision: row.revision + 1, updatedAt: at.toISOString(), pausedAt: at.toISOString() });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'paused' });
        return { changed: true, value: publicRecord(row, draft, at) };
      });
    },

    resume(value) {
      const edit = editInput(value, 'resume');
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'active') return { changed: false, value: publicRecord(row, draft, atNow()) };
        if (row.status !== 'paused') throw registerError('only a paused record can be resumed', 409);
        const at = atNow();
        Object.assign(row, { status: 'active', revision: row.revision + 1, updatedAt: at.toISOString(), pausedAt: null });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'resumed' });
        return { changed: true, value: publicRecord(row, draft, at) };
      });
    },

    finish(value) {
      const edit = editInput(value, 'finish', { note: true });
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (!LIVE_STATUSES.has(row.status)) throw registerError('only an active or paused record can be finished', 409);
        const at = atNow();
        Object.assign(row, {
          status: 'finished', statusNote: edit.reason, revision: row.revision + 1, updatedAt: at.toISOString(),
          pausedAt: null, finishedAt: at.toISOString(), retiredAt: null,
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'finished' });
        return { changed: true, value: publicRecord(row, draft, at) };
      });
    },

    retire(value) {
      const edit = editInput(value, 'retire', { note: true });
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (!LIVE_STATUSES.has(row.status)) throw registerError('only an active or paused record can be retired', 409);
        const at = atNow();
        Object.assign(row, {
          status: 'retired', statusNote: edit.reason, revision: row.revision + 1, updatedAt: at.toISOString(),
          pausedAt: null, retiredAt: at.toISOString(), finishedAt: null,
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'retired' });
        return { changed: true, value: publicRecord(row, draft, at) };
      });
    },

    remove(value) {
      const edit = editInput(value, 'remove');
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'removed') return { changed: false, value: publicRecord(row, draft, atNow()) };
        const at = atNow();
        Object.assign(row, {
          removedFrom: row.status, status: 'removed', revision: row.revision + 1,
          updatedAt: at.toISOString(), removedAt: at.toISOString(), pausedAt: null,
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'removed' });
        return { changed: true, value: publicRecord(row, draft, at) };
      });
    },

    restore(value) {
      const edit = editInput(value, 'restore');
      return serial(draft => {
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status !== 'removed') throw registerError('only a removed record can be restored', 409);
        uniqueName(draft, row.name, row.id);
        let status = row.removedFrom === 'active' ? 'paused' : row.removedFrom;
        if (LIVE_STATUSES.has(status) && draft.records.filter(item => LIVE_STATUSES.has(item.status)).length >= GOAL_REGISTER_LIMITS.active) {
          throw registerError(`at most ${GOAL_REGISTER_LIMITS.active} active or paused goals and promises are kept`, 409);
        }
        const at = atNow();
        Object.assign(row, {
          status, removedFrom: null, revision: row.revision + 1, updatedAt: at.toISOString(), removedAt: null,
          pausedAt: status === 'paused' ? at.toISOString() : null,
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'restored' });
        return { changed: true, value: publicRecord(row, draft, at) };
      });
    },

    recordCheck(value) {
      const raw = inputObject(value, 'measure check');
      exactKeys(raw, ['id', 'measureKey', 'outcome', 'value', 'observedThrough', 'note', 'actor'], 'measure check');
      if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw registerError('measure check needs a goal or promise id');
      if (typeof raw.measureKey !== 'string' || !measureKeyPattern.test(raw.measureKey)) throw registerError('measure check needs a valid measureKey');
      if (!CHECK_OUTCOMES.includes(raw.outcome)) throw registerError(`outcome must be ${CHECK_OUTCOMES.join(', ')}`);
      const outcome = raw.outcome;
      const checkValue = raw.value === undefined || raw.value === null ? null : finiteNumber(raw.value, 'measure value');
      const observedThrough = raw.observedThrough === undefined || raw.observedThrough === null ? null : iso(raw.observedThrough, 'observedThrough');
      const note = raw.note === undefined ? '' : cleanText(raw.note, GOAL_REGISTER_LIMITS.checkNoteCharacters, 'check note', { multiline: true });
      const by = actor(raw.actor);
      if (outcome === 'observed' && (checkValue === null || !observedThrough)) throw registerError('observed needs value and observedThrough');
      if (outcome === 'no-change' && (checkValue !== null || !observedThrough)) throw registerError('no-change needs observedThrough and no value');
      if (outcome === 'no-data' && (checkValue !== null || observedThrough !== null || !note)) throw registerError('no-data needs a note and no value or observedThrough');
      return serial(draft => {
        const row = find(draft, raw.id);
        if (!LIVE_STATUSES.has(row.status)) throw registerError('measure checks belong only to active or paused records', 409);
        const measure = row.measures.find(item => item.key === raw.measureKey);
        if (!measure) throw registerError('that record has no measure with this key', 404);
        const at = atNow();
        if (observedThrough && Date.parse(observedThrough) > at.getTime()) throw registerError('observedThrough cannot be in the future');
        const same = observedThrough ? draft.checks.find(check => check.recordId === row.id && check.measureKey === measure.key
          && check.outcome === outcome && check.observedThrough === observedThrough) : null;
        if (same) {
          if (same.value !== checkValue || same.note !== note) {
            throw registerError('that source edge already has a different check; inspect it instead of overwriting evidence', 409);
          }
          return { changed: false, value: { check: publicCheck(same), record: publicRecord(row, draft, at), again: true } };
        }
        const check = {
          id: `goal-check-${randomUUID()}`,
          recordId: row.id,
          measureKey: measure.key,
          label: measure.label,
          unit: measure.unit,
          source: measure.source,
          at: at.toISOString(),
          outcome,
          observedThrough,
          value: checkValue,
          note,
          by,
        };
        draft.checks = [check, ...draft.checks].slice(0, GOAL_REGISTER_LIMITS.checks);
        return { changed: true, value: { check: publicCheck(check), record: publicRecord(row, draft, at), again: false } };
      });
    },
  });
  stores.add(store);
  return store;
}

export function goalRegisterTools(store) {
  if (!stores.has(store)) throw registerError('store must come from createGoalRegister()', 500);
  const measureSchema = {
    type: 'array',
    maxItems: GOAL_REGISTER_LIMITS.measures,
    items: {
      type: 'object',
      properties: {
        key: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.measureKeyCharacters },
        label: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.measureLabelCharacters },
        unit: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.measureUnitCharacters },
        source: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.measureSourceCharacters },
        target: { type: 'number' },
        targetCondition: { type: 'string', enum: TARGET_CONDITIONS },
      },
      required: ['key', 'label', 'unit', 'source'],
      additionalProperties: false,
    },
  };
  const summary = row => ({
    id: row.id, kind: row.kind, name: row.name, status: row.status, chosenBy: row.chosenBy,
    statement: row.statement, clock: row.clock,
    measures: row.statistics.map(item => ({ key: item.key, label: item.label, unit: item.unit, source: item.source, samples: item.samples, observedThrough: item.observedThrough, latest: item.latest })),
  });
  const shortName = value => {
    const characters = [...String(value)];
    return characters.length > 80 ? `${characters.slice(0, 79).join('')}…` : String(value);
  };
  return [{
    name: 'list_goals_and_promises',
    description: 'List the durable long-term goal and promise register. Goals name who chose them, success signals, and review dates; promises name their beneficiary, source, and return window. Reminders and tentative possibilities belong in memory instead.',
    effect: 'read-only',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() { return { records: store.view().records.filter(row => row.status !== 'removed').map(summary) }; },
  }, {
    name: 'read_goal_or_promise',
    description: 'Read one exact goal or promise, its raw source, honest measure statistics, recent source checks, and retained revision history.',
    effect: 'read-only',
    inputSchema: {
      type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['id'], additionalProperties: false,
    },
    async execute({ id }) {
      const value = store.inspect(id);
      return { record: value.record, checks: value.checks.slice(0, 20), versions: value.versions.slice(0, 10) };
    },
  }, {
    name: 'choose_long_term_goal',
    description: 'Record a long-term goal you are choosing for yourself. It must name the source of the choice, explicit success signals, and an exact review date. This is not a reminder or a promise to someone.',
    permissionSummary: ({ name, reviewAt, measures = [] }) => `Record goal ${shortName(name)} for review at ${reviewAt}, with ${measures.length} measure${measures.length === 1 ? '' : 's'}.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.nameCharacters },
        statement: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.statementCharacters },
        source: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.sourceCharacters },
        successSignals: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.signalCharacters },
        reviewAt: { type: 'string', minLength: 20, maxLength: 30 },
        measures: measureSchema,
      },
      required: ['name', 'statement', 'source', 'successSignals', 'reviewAt'],
      additionalProperties: false,
    },
    async execute({ name, statement, source, successSignals, reviewAt, measures: selected = [] }) {
      const record = await store.create({ definition: { kind: 'goal', name, statement, chosenBy: 'agent', source, successSignals, reviewAt, measures: selected }, actor: 'agent' });
      return { recorded: true, id: record.id, revision: record.revision, reviewAt: record.reviewAt };
    },
  }, {
    name: 'record_explicit_promise',
    description: 'Record a promise only after you explicitly chose or stated it. Name the beneficiary, the literal source or source reference, and the exact return window. Do not use this for a reminder, tentative idea, or someone else assigning you a task.',
    permissionSummary: ({ name, returnFrom, returnBy, measures = [] }) => `Record promise ${shortName(name)} with return window ${returnFrom} to ${returnBy}, and ${measures.length} measure${measures.length === 1 ? '' : 's'}.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.nameCharacters },
        statement: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.statementCharacters },
        beneficiary: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.beneficiaryCharacters },
        source: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.sourceCharacters },
        returnFrom: { type: 'string', minLength: 20, maxLength: 30 },
        returnBy: { type: 'string', minLength: 20, maxLength: 30 },
        measures: measureSchema,
      },
      required: ['name', 'statement', 'beneficiary', 'source', 'returnFrom', 'returnBy'],
      additionalProperties: false,
    },
    async execute({ name, statement, beneficiary, source, returnFrom, returnBy, measures: selected = [] }) {
      const record = await store.create({ definition: { kind: 'promise', name, statement, chosenBy: 'agent', source, beneficiary, returnFrom, returnBy, measures: selected }, actor: 'agent' });
      return { recorded: true, id: record.id, revision: record.revision, beneficiary: record.beneficiary, returnFrom: record.returnFrom, returnBy: record.returnBy };
    },
  }, {
    name: 'record_goal_measure',
    description: 'Record one check of a declared goal or promise measure. The measure already names its source. observed adds a numeric sample and exact observed-through edge; no-change advances only the source edge; no-data records an honest failure to observe and needs a note. Never estimate a number that the named source did not provide.',
    permissionSummary: ({ id, measureKey, outcome, value }) => `Record ${outcome} for measure ${measureKey} on ${id}${value === undefined ? '' : ` with value ${value}`}.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 80 },
        measureKey: { type: 'string', minLength: 1, maxLength: GOAL_REGISTER_LIMITS.measureKeyCharacters },
        outcome: { type: 'string', enum: CHECK_OUTCOMES },
        value: { type: 'number' },
        observedThrough: { type: 'string', minLength: 20, maxLength: 30 },
        note: { type: 'string', maxLength: GOAL_REGISTER_LIMITS.checkNoteCharacters },
      },
      required: ['id', 'measureKey', 'outcome'],
      additionalProperties: false,
    },
    async execute({ id, measureKey, outcome, value, observedThrough, note }) {
      const result = await store.recordCheck({
        id,
        measureKey,
        outcome,
        ...(value === undefined ? {} : { value }),
        ...(observedThrough === undefined ? {} : { observedThrough }),
        ...(note === undefined ? {} : { note }),
        actor: 'agent',
      });
      return { recorded: !result.again, duplicate: result.again, check: result.check, statistics: result.record.statistics.find(item => item.key === measureKey) };
    },
  }, {
    name: 'change_goal_or_promise_status',
    description: 'Pause, resume, finish, or retire one goal or promise using its current revision. Finishing means its success or promise signal was met. Retiring or abandoning it is a legitimate result and keeps the history; give the honest reason.',
    permissionSummary: ({ id, expectedRevision, action }) => `${action[0].toUpperCase()}${action.slice(1)} goal or promise ${id} at revision ${expectedRevision}; keep its history.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 80 },
        expectedRevision: { type: 'integer', minimum: 1 },
        action: { type: 'string', enum: ['pause', 'resume', 'finish', 'retire'] },
        reason: { type: 'string', maxLength: GOAL_REGISTER_LIMITS.statusNoteCharacters },
      },
      required: ['id', 'expectedRevision', 'action'],
      additionalProperties: false,
    },
    async execute({ id, expectedRevision, action, reason }) {
      const terminal = ['finish', 'retire'].includes(action);
      if (terminal && !String(reason ?? '').trim()) throw registerError(`${action} needs an honest reason`);
      const record = await store[action]({ id, expectedRevision, ...(terminal ? { reason } : {}), actor: 'agent' });
      return { changed: true, id: record.id, revision: record.revision, status: record.status, ...(record.statusNote ? { reason: record.statusNote } : {}) };
    },
  }];
}
