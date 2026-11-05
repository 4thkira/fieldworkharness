import { randomUUID } from 'node:crypto';
import { openDurableLog } from './durable-log.mjs';
import { deepFreeze, isPlainObject } from './json-data.mjs';

// This store records only the boundary around an effectful tool call. Raw
// arguments, results, and errors never enter it. A durable attempt means only
// that an executor became eligible to run; it is not external-effect proof.

export const TOOL_EFFECT_EVENT_FORMAT = 'fieldwork-tool-effect-event/v1';
export const TOOL_EFFECT_ACTION_FORMAT = 'fieldwork-tool-effect-action/v1';
export const TOOL_EFFECT_ATTEMPT_FORMAT = 'fieldwork-tool-effect-attempt/v1';
export const TOOL_EFFECT_REPORT_FORMAT = 'fieldwork-tool-effect-report/v1';
export const TOOL_EFFECT_RESOLUTION_FORMAT = 'fieldwork-tool-effect-resolution/v1';
export const TOOL_EFFECT_DISPOSITION_FORMAT = 'fieldwork-tool-effect-disposition/v1';
export const TOOL_EFFECT_POLICY = 'fieldwork-tool-effect-recovery/v1';

export const TOOL_EFFECT_LIMITS = Object.freeze({
  unresolved: 64,
  history: 256,
  summaryCharacters: 240,
  dispositionRevisions: 64,
  eventBytes: 64 * 1024,
  lineBytes: 128 * 1024,
  replayBytes: 64 * 1024 * 1024,
  events: 1_000_000,
});

const stores = new WeakSet();
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const ORIGIN = /^[a-z][a-z0-9-]{0,63}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const UNSAFE_DISPLAY_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/u;
const REPORT_OUTCOMES = new Set(['executor-returned', 'executor-error', 'interrupted']);
const RESOLUTIONS = new Set(['abandon-not-attempted', 'acknowledge-uncertain', 'acknowledge-completed']);
const RUN_DISPOSITIONS = new Set(['committed', 'save-failed', 'discarded', 'run-failed']);
const PERMISSIONS = new Map([
  ['internal\0internal', { request: false }],
  ['always\0policy-always', { request: false }],
  ['ask\0one-time-grant', { request: true }],
  ['not-configured\0no-store', { request: false }],
]);
function effectError(message, cause) {
  return new Error(`Tool effects: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw effectError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw effectError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw effectError(`${where}.${String(key)} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value, where, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw effectError(`${where} must be an array of at most ${maximum} items`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      throw effectError(`${where} has an unexpected property`);
    }
  }
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw effectError(`${where}[${index}] must be an enumerable data property`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function identifier(value, where) {
  if (typeof value !== 'string' || !PORTABLE_ID.test(value)) throw effectError(`${where} must be a portable identifier`);
  return value;
}

function toolName(value, where = 'tool') {
  if (typeof value !== 'string' || !TOOL_NAME.test(value)) {
    throw effectError(`${where} must be lowercase letters, digits, and underscores, beginning with a letter`);
  }
  return value;
}

function originName(value, where) {
  if (typeof value !== 'string' || !ORIGIN.test(value)) {
    throw effectError(`${where} must be 1-64 lowercase letters, digits, or hyphens, beginning with a letter`);
  }
  return value;
}

function digest(value, where) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw effectError(`${where} must be a lowercase SHA-256 digest`);
  return value;
}

function uuid(value, where) {
  if (typeof value !== 'string' || !UUID.test(value)) throw effectError(`${where} must be a UUID`);
  return value.toLowerCase();
}

function instant(value, where) {
  let normalized = '';
  try { normalized = typeof value === 'string' ? new Date(value).toISOString() : ''; }
  catch { /* Rejected below. */ }
  if (normalized !== value) throw effectError(`${where} must be an exact ISO timestamp`);
  return value;
}

function timestamp(clock) {
  let value;
  try { value = clock(); }
  catch (error) { throw effectError(`clock failed: ${error instanceof Error ? error.message : String(error)}`, error); }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw effectError('clock returned an invalid time');
  return date.toISOString();
}

function orderedAt(later, earlier, where) {
  if (later < earlier) throw effectError(`${where} precedes the state it follows`);
  return later;
}

function safeText(value, where, maximum) {
  const length = typeof value === 'string' ? [...value].length : 0;
  if (typeof value !== 'string' || length < 1 || length > maximum || value.trim() !== value || UNSAFE_DISPLAY_TEXT.test(value)) {
    throw effectError(`${where} must be 1-${maximum} characters of trimmed direction-safe text`);
  }
  return value;
}

function permissionBasis(value, where = 'permission') {
  const raw = fields(value, ['mode', 'reason', 'requestId'], where);
  if (typeof raw.mode !== 'string' || typeof raw.reason !== 'string') throw effectError(`${where} must name an exact mode and reason`);
  const rule = PERMISSIONS.get(`${raw.mode}\0${raw.reason}`);
  if (!rule) throw effectError(`${where} mode and reason are not an allowed execution basis`);
  const requestId = raw.requestId === undefined || raw.requestId === null
    ? null
    : uuid(raw.requestId, `${where}.requestId`);
  if (rule.request !== Boolean(requestId)) {
    throw effectError(rule.request ? `${where}.requestId is required for a one-time grant` : `${where}.requestId is valid only for a one-time grant`);
  }
  return deepFreeze({ mode: raw.mode, reason: raw.reason, requestId });
}

function revision(value, where) {
  return uuid(value, where);
}

function optionalConversationId(value, where) {
  return value === null || value === undefined ? null : identifier(value, where);
}

function fenceInput(value, where = 'effect fence') {
  const raw = fields(value, ['tool', 'argumentsSha256'], where);
  return deepFreeze({
    tool: toolName(raw.tool, `${where}.tool`),
    argumentsSha256: digest(raw.argumentsSha256, `${where}.argumentsSha256`),
  });
}

function fenceKey(tool, argumentsSha256) {
  return `${tool}\0${argumentsSha256}`;
}

function prepareInput(value) {
  const raw = fields(value, ['run', 'tool', 'argumentsSha256', 'summary', 'permission', 'callIdHash'], 'effect preparation');
  return deepFreeze({
    run: raw.run,
    tool: toolName(raw.tool, 'effect preparation.tool'),
    argumentsSha256: digest(raw.argumentsSha256, 'effect preparation.argumentsSha256'),
    summary: safeText(raw.summary, 'effect preparation.summary', TOOL_EFFECT_LIMITS.summaryCharacters),
    permission: permissionBasis(raw.permission, 'effect preparation.permission'),
    callIdHash: digest(raw.callIdHash, 'effect preparation.callIdHash'),
  });
}

function createAction(input, run, id, preparedAt, stateRevision) {
  return deepFreeze({
    format: TOOL_EFFECT_ACTION_FORMAT,
    id,
    preparedAt,
    tool: input.tool,
    argumentsSha256: input.argumentsSha256,
    summary: input.summary,
    origin: run.origin,
    permission: input.permission,
    runId: run.runId,
    callIdHash: input.callIdHash,
    revision: stateRevision,
  });
}

function restoreAction(value, where = 'stored action') {
  const raw = fields(value, [
    'format', 'id', 'preparedAt', 'tool', 'argumentsSha256', 'summary', 'origin',
    'permission', 'runId', 'callIdHash', 'revision',
  ], where);
  if (raw.format !== TOOL_EFFECT_ACTION_FORMAT) throw effectError(`${where}.format is unsupported`);
  return deepFreeze({
    format: raw.format,
    id: identifier(raw.id, `${where}.id`),
    preparedAt: instant(raw.preparedAt, `${where}.preparedAt`),
    tool: toolName(raw.tool, `${where}.tool`),
    argumentsSha256: digest(raw.argumentsSha256, `${where}.argumentsSha256`),
    summary: safeText(raw.summary, `${where}.summary`, TOOL_EFFECT_LIMITS.summaryCharacters),
    origin: originName(raw.origin, `${where}.origin`),
    permission: permissionBasis(raw.permission, `${where}.permission`),
    runId: identifier(raw.runId, `${where}.runId`),
    callIdHash: digest(raw.callIdHash, `${where}.callIdHash`),
    revision: revision(raw.revision, `${where}.revision`),
  });
}

function createAttempt(record, attemptedAt, stateRevision) {
  orderedAt(attemptedAt, record.stateAt, 'effect attempt.attemptedAt');
  return deepFreeze({
    format: TOOL_EFFECT_ATTEMPT_FORMAT,
    actionId: record.action.id,
    previousRevision: record.revision,
    revision: stateRevision,
    attemptedAt,
  });
}

function restoreAttempt(value, record, where = 'stored attempt') {
  const raw = fields(value, ['format', 'actionId', 'previousRevision', 'revision', 'attemptedAt'], where);
  if (raw.format !== TOOL_EFFECT_ATTEMPT_FORMAT) throw effectError(`${where}.format is unsupported`);
  const attempt = deepFreeze({
    format: raw.format,
    actionId: identifier(raw.actionId, `${where}.actionId`),
    previousRevision: revision(raw.previousRevision, `${where}.previousRevision`),
    revision: revision(raw.revision, `${where}.revision`),
    attemptedAt: instant(raw.attemptedAt, `${where}.attemptedAt`),
  });
  if (attempt.actionId !== record.action.id || attempt.previousRevision !== record.revision) {
    throw effectError(`${where} does not match its prepared action state`);
  }
  if (attempt.revision === attempt.previousRevision) throw effectError(`${where} must advance the action revision`);
  orderedAt(attempt.attemptedAt, record.stateAt, `${where}.attemptedAt`);
  return attempt;
}

function createReport(record, outcome, reportedAt, stateRevision) {
  orderedAt(reportedAt, record.stateAt, 'effect report.reportedAt');
  return deepFreeze({
    format: TOOL_EFFECT_REPORT_FORMAT,
    actionId: record.action.id,
    previousRevision: record.revision,
    revision: stateRevision,
    reportedAt,
    outcome,
  });
}

function restoreReport(value, record, where = 'stored report') {
  const raw = fields(value, ['format', 'actionId', 'previousRevision', 'revision', 'reportedAt', 'outcome'], where);
  if (raw.format !== TOOL_EFFECT_REPORT_FORMAT) throw effectError(`${where}.format is unsupported`);
  if (!REPORT_OUTCOMES.has(raw.outcome)) throw effectError(`${where}.outcome is unsupported`);
  const report = deepFreeze({
    format: raw.format,
    actionId: identifier(raw.actionId, `${where}.actionId`),
    previousRevision: revision(raw.previousRevision, `${where}.previousRevision`),
    revision: revision(raw.revision, `${where}.revision`),
    reportedAt: instant(raw.reportedAt, `${where}.reportedAt`),
    outcome: raw.outcome,
  });
  if (report.actionId !== record.action.id || !record.attempt || report.previousRevision !== record.revision) {
    throw effectError(`${where} does not match its durable attempt state`);
  }
  if (report.revision === report.previousRevision) throw effectError(`${where} must advance the action revision`);
  orderedAt(report.reportedAt, record.stateAt, `${where}.reportedAt`);
  return report;
}

function latestAt(record) {
  return record.stateAt;
}

function stateName(record) {
  if (!record.attempt) return 'prepared-not-attempted';
  if (!record.report) return 'attempted-unsettled';
  if (record.report.outcome === 'executor-returned') return 'executor-returned-uncommitted';
  return record.report.outcome === 'executor-error' ? 'executor-error-uncertain' : 'interrupted-uncertain';
}

function validResolutionFor(record, resolutionValue) {
  if (!record.attempt) return resolutionValue === 'abandon-not-attempted';
  if (record.report?.outcome === 'executor-returned') return resolutionValue === 'acknowledge-completed';
  return resolutionValue === 'acknowledge-uncertain';
}

function createResolution(record, resolutionValue, resolvedAt) {
  orderedAt(resolvedAt, latestAt(record), 'effect resolution.resolvedAt');
  return deepFreeze({
    format: TOOL_EFFECT_RESOLUTION_FORMAT,
    actionId: record.action.id,
    expectedRevision: record.revision,
    resolvedAt,
    resolution: resolutionValue,
    actor: 'person',
  });
}

function restoreResolution(value, record, where = 'stored resolution') {
  const raw = fields(value, ['format', 'actionId', 'expectedRevision', 'resolvedAt', 'resolution', 'actor'], where);
  if (raw.format !== TOOL_EFFECT_RESOLUTION_FORMAT) throw effectError(`${where}.format is unsupported`);
  if (!RESOLUTIONS.has(raw.resolution)) throw effectError(`${where}.resolution is unsupported`);
  if (raw.actor !== 'person') throw effectError(`${where}.actor must be person`);
  const restored = deepFreeze({
    format: raw.format,
    actionId: identifier(raw.actionId, `${where}.actionId`),
    expectedRevision: revision(raw.expectedRevision, `${where}.expectedRevision`),
    resolvedAt: instant(raw.resolvedAt, `${where}.resolvedAt`),
    resolution: raw.resolution,
    actor: raw.actor,
  });
  if (restored.actionId !== record.action.id || restored.expectedRevision !== record.revision) {
    throw effectError(`${where} does not match the unresolved state it resolves`);
  }
  orderedAt(restored.resolvedAt, latestAt(record), `${where}.resolvedAt`);
  if (!validResolutionFor(record, restored.resolution)) {
    throw effectError(`${where}.resolution is not valid for ${stateName(record)}`);
  }
  return restored;
}

function dispositionRevision(value, where) {
  const raw = fields(value, ['actionId', 'previousRevision', 'revision'], where);
  return deepFreeze({
    actionId: identifier(raw.actionId, `${where}.actionId`),
    previousRevision: revision(raw.previousRevision, `${where}.previousRevision`),
    revision: revision(raw.revision, `${where}.revision`),
  });
}

function createDisposition(run, disposition, conversationId, recordedAt, revisions) {
  return deepFreeze({
    format: TOOL_EFFECT_DISPOSITION_FORMAT,
    runId: run.runId,
    origin: run.origin,
    disposition,
    conversationId,
    recordedAt,
    revisions: deepFreeze(revisions),
  });
}

function restoreDisposition(value, where = 'stored run disposition') {
  const raw = fields(value, ['format', 'runId', 'origin', 'disposition', 'conversationId', 'recordedAt', 'revisions'], where);
  if (raw.format !== TOOL_EFFECT_DISPOSITION_FORMAT) throw effectError(`${where}.format is unsupported`);
  if (!RUN_DISPOSITIONS.has(raw.disposition)) throw effectError(`${where}.disposition is unsupported`);
  const revisions = denseArray(raw.revisions, `${where}.revisions`, TOOL_EFFECT_LIMITS.dispositionRevisions)
    .map((row, index) => dispositionRevision(row, `${where}.revisions[${index}]`));
  return deepFreeze({
    format: raw.format,
    runId: identifier(raw.runId, `${where}.runId`),
    origin: originName(raw.origin, `${where}.origin`),
    disposition: raw.disposition,
    conversationId: optionalConversationId(raw.conversationId, `${where}.conversationId`),
    recordedAt: instant(raw.recordedAt, `${where}.recordedAt`),
    revisions: deepFreeze(revisions),
  });
}

function runDispositionProjection(value) {
  return value ? deepFreeze({
    status: value.disposition,
    conversationId: value.conversationId,
    recordedAt: value.recordedAt,
  }) : null;
}

// The durable file needs the full argument digest for exact fencing, but a
// digest of low-entropy arguments is guessable offline. Treat the file and its
// trusted receipt as private metadata. Safe views expose no derivative of it.
function projection(record, { executorActive = false, runActive = false } = {}) {
  const action = record.action;
  return deepFreeze({
    actionId: action.id,
    revision: record.revision,
    state: stateName(record),
    tool: action.tool,
    summary: action.summary,
    origin: action.origin,
    permission: action.permission,
    runId: action.runId,
    runDisposition: runDispositionProjection(record.disposition),
    preparedAt: action.preparedAt,
    attemptedAt: record.attempt?.attemptedAt ?? null,
    reportedAt: record.report?.reportedAt ?? null,
    executorActive,
    runActive,
    recoverable: !executorActive && !runActive,
  });
}

function terminalHistory(record, terminal, finishedAt = null) {
  const action = record.action;
  const report = terminal.kind === 'report' ? terminal.value : null;
  const resolutionValue = terminal.kind === 'resolution' ? terminal.value : null;
  return deepFreeze({
    actionId: action.id,
    tool: action.tool,
    summary: action.summary,
    origin: action.origin,
    permission: action.permission,
    runId: action.runId,
    preparedAt: action.preparedAt,
    attemptedAt: record.attempt?.attemptedAt ?? null,
    reportedAt: record.report?.reportedAt ?? null,
    finishedAt: finishedAt ?? report?.reportedAt ?? resolutionValue.resolvedAt,
    outcome: report?.outcome ?? resolutionValue.resolution,
    actor: resolutionValue?.actor ?? 'executor',
    runDisposition: runDispositionProjection(record.disposition),
  });
}

function newState() {
  return {
    sawGenesis: false,
    actions: new Map(),
    order: [],
    history: [],
    seenActionIds: new Set(),
    seenRunIds: new Set(),
    disposedRunIds: new Set(),
    closedUndisposedRuns: new Set(),
  };
}

function pushHistory(state, row) {
  state.history.push(row);
  if (state.history.length > TOOL_EFFECT_LIMITS.history) {
    state.history.splice(0, state.history.length - TOOL_EFFECT_LIMITS.history);
  }
}

function finishAction(state, record, terminal, finishedAt = null) {
  state.actions.delete(record.action.id);
  state.order = state.order.filter(id => id !== record.action.id);
  if (!state.disposedRunIds.has(record.action.runId)) {
    // A human may close a crashed run's orphan without a machine disposition.
    // That run can never legitimately resume or acquire a later disposition.
    state.closedUndisposedRuns.add(record.action.runId);
  }
  pushHistory(state, terminalHistory(record, terminal, finishedAt));
}

function applyDisposition(state, disposition) {
  if (state.disposedRunIds.has(disposition.runId)) {
    throw effectError(`run ${JSON.stringify(disposition.runId)} already has a disposition`);
  }
  if (state.closedUndisposedRuns.has(disposition.runId)) {
    throw effectError('a run cannot gain a disposition after an orphan was resolved');
  }
  const current = state.order
    .map(id => state.actions.get(id))
    .filter(record => record.action.runId === disposition.runId);
  if (disposition.revisions.length !== current.length) {
    throw effectError('run disposition does not revise every unresolved action in its run');
  }
  const byAction = new Map();
  for (const row of disposition.revisions) {
    if (byAction.has(row.actionId)) throw effectError('run disposition repeats an action revision');
    byAction.set(row.actionId, row);
  }
  const reservedRevisions = new Set(current.map(record => record.revision));
  for (const record of current) {
    if (record.action.origin !== disposition.origin) throw effectError('run disposition origin does not match its actions');
    const row = byAction.get(record.action.id);
    if (!row || row.previousRevision !== record.revision) {
      throw effectError('run disposition revisions do not match the current run state');
    }
    orderedAt(disposition.recordedAt, latestAt(record), 'run disposition.recordedAt');
    if (reservedRevisions.has(row.revision)) throw effectError('run disposition replacement revisions must be new and distinct');
    reservedRevisions.add(row.revision);
  }
  state.seenRunIds.add(disposition.runId);
  state.disposedRunIds.add(disposition.runId);
  for (const record of current) {
    const row = byAction.get(record.action.id);
    const revised = {
      ...record, revision: row.revision, stateAt: disposition.recordedAt, disposition,
    };
    state.actions.set(record.action.id, revised);
    if (disposition.disposition === 'committed' && record.report?.outcome === 'executor-returned') {
      finishAction(state, revised, { kind: 'report', value: record.report }, disposition.recordedAt);
    }
  }
}

function applyEvent(event, state) {
  if (event.type === 'tool_effect_store_created') {
    if (state.sawGenesis || event.sequence !== 1) throw effectError('the store genesis must be the first and only genesis event');
    const raw = fields(event.data, [
      'actionFormat', 'attemptFormat', 'reportFormat', 'resolutionFormat', 'dispositionFormat', 'policy',
    ], 'tool_effect_store_created data');
    if (raw.actionFormat !== TOOL_EFFECT_ACTION_FORMAT
      || raw.attemptFormat !== TOOL_EFFECT_ATTEMPT_FORMAT
      || raw.reportFormat !== TOOL_EFFECT_REPORT_FORMAT
      || raw.resolutionFormat !== TOOL_EFFECT_RESOLUTION_FORMAT
      || raw.dispositionFormat !== TOOL_EFFECT_DISPOSITION_FORMAT
      || raw.policy !== TOOL_EFFECT_POLICY) {
      throw effectError('the store genesis declares unsupported formats');
    }
    state.sawGenesis = true;
    return;
  }
  if (!state.sawGenesis) throw effectError('a tool-effect event appeared before the store genesis');
  if (event.type === 'tool_effect_prepared') {
    const raw = fields(event.data, ['action'], 'tool_effect_prepared data');
    const action = restoreAction(raw.action);
    if (state.seenActionIds.has(action.id)) throw effectError(`action ${JSON.stringify(action.id)} is repeated`);
    if (state.disposedRunIds.has(action.runId)) throw effectError('an action cannot be prepared for a disposed run');
    if (state.closedUndisposedRuns.has(action.runId)) throw effectError('an action cannot be prepared for a closed orphan run');
    const sameRun = [...state.actions.values()].filter(record => record.action.runId === action.runId);
    if (sameRun.some(record => record.action.origin !== action.origin)) throw effectError('a durable run cannot mix origins');
    if (sameRun.some(record => record.action.callIdHash === action.callIdHash)) throw effectError('a run repeats a tool call identity');
    if ([...state.actions.values()].some(record => fenceKey(record.action.tool, record.action.argumentsSha256)
      === fenceKey(action.tool, action.argumentsSha256))) {
      throw effectError('an unresolved tool and argument digest is already fenced');
    }
    if (state.actions.size >= TOOL_EFFECT_LIMITS.unresolved) throw effectError('the unresolved effect limit was exceeded during replay');
    state.seenActionIds.add(action.id);
    state.seenRunIds.add(action.runId);
    state.actions.set(action.id, {
      action, attempt: null, report: null, revision: action.revision,
      stateAt: action.preparedAt, disposition: null,
    });
    state.order.push(action.id);
    return;
  }
  if (event.type === 'tool_effect_attempted') {
    const raw = fields(event.data, ['attempt'], 'tool_effect_attempted data');
    const shell = fields(raw.attempt, ['format', 'actionId', 'previousRevision', 'revision', 'attemptedAt'], 'tool_effect_attempted attempt');
    const current = state.actions.get(shell.actionId);
    if (!current) throw effectError(`attempt refers to missing action ${JSON.stringify(shell.actionId)}`);
    if (state.disposedRunIds.has(current.action.runId)) throw effectError('an effect cannot be attempted after its run disposition');
    if (state.closedUndisposedRuns.has(current.action.runId)) throw effectError('an effect cannot be attempted after its orphan run closed');
    if (current.attempt) throw effectError(`action ${JSON.stringify(shell.actionId)} was already attempted`);
    const attempt = restoreAttempt(raw.attempt, current);
    state.actions.set(attempt.actionId, {
      ...current, attempt, revision: attempt.revision, stateAt: attempt.attemptedAt,
    });
    return;
  }
  if (event.type === 'tool_effect_reported') {
    const raw = fields(event.data, ['report'], 'tool_effect_reported data');
    const shell = fields(raw.report, ['format', 'actionId', 'previousRevision', 'revision', 'reportedAt', 'outcome'], 'tool_effect_reported report');
    const current = state.actions.get(shell.actionId);
    if (!current) throw effectError(`report refers to missing action ${JSON.stringify(shell.actionId)}`);
    if (state.disposedRunIds.has(current.action.runId)) throw effectError('an effect cannot be reported after its run disposition');
    if (state.closedUndisposedRuns.has(current.action.runId)) throw effectError('an effect cannot be reported after its orphan run closed');
    if (!current.attempt) throw effectError('an effect cannot be reported before its durable attempt');
    if (current.report) throw effectError(`action ${JSON.stringify(shell.actionId)} already has a report`);
    const report = restoreReport(raw.report, current);
    state.actions.set(report.actionId, {
      ...current, report, revision: report.revision, stateAt: report.reportedAt,
    });
    return;
  }
  if (event.type === 'tool_effect_resolved') {
    const raw = fields(event.data, ['resolution'], 'tool_effect_resolved data');
    const shell = fields(raw.resolution, ['format', 'actionId', 'expectedRevision', 'resolvedAt', 'resolution', 'actor'], 'tool_effect_resolved resolution');
    const current = state.actions.get(shell.actionId);
    if (!current) throw effectError(`resolution refers to missing action ${JSON.stringify(shell.actionId)}`);
    const resolutionValue = restoreResolution(raw.resolution, current);
    finishAction(state, current, { kind: 'resolution', value: resolutionValue });
    return;
  }
  if (event.type === 'tool_effect_run_dispositioned') {
    const raw = fields(event.data, ['disposition'], 'tool_effect_run_dispositioned data');
    applyDisposition(state, restoreDisposition(raw.disposition));
    return;
  }
  throw effectError(`unsupported event type ${JSON.stringify(event.type)}`);
}

function limitOptions(value, where) {
  const raw = fields(value, ['limit'], where);
  const limit = raw.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOOL_EFFECT_LIMITS.history) {
    throw effectError(`${where}.limit must be a whole number from 1 to ${TOOL_EFFECT_LIMITS.history}`);
  }
  return limit;
}

async function buildStore(log, state, clock) {
  let queue = Promise.resolve();
  let draining = false;
  let abandoning = false;
  let closePromise = null;
  let projectionFailure = null;
  const runCapabilities = new WeakMap();
  const activeRuns = new Map();
  const attemptCapabilities = new WeakMap();
  const activeAttempts = new Map();
  const idleWaiters = new Set();

  const signalIdle = () => {
    if (activeRuns.size || activeAttempts.size) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  const releaseAttempt = capability => {
    const actionId = attemptCapabilities.get(capability);
    if (!actionId) return;
    attemptCapabilities.delete(capability);
    if (activeAttempts.get(actionId) === capability) activeAttempts.delete(actionId);
    signalIdle();
  };
  const releaseRun = capability => {
    const run = runCapabilities.get(capability);
    if (!run) return;
    runCapabilities.delete(capability);
    if (activeRuns.get(run.runId)?.capability === capability) activeRuns.delete(run.runId);
    signalIdle();
  };
  const releaseAllCapabilities = () => {
    for (const capability of activeAttempts.values()) attemptCapabilities.delete(capability);
    for (const { capability } of activeRuns.values()) runCapabilities.delete(capability);
    activeAttempts.clear();
    activeRuns.clear();
    signalIdle();
  };
  const waitForIdle = () => activeRuns.size || activeAttempts.size
    ? new Promise(resolve => idleWaiters.add(resolve))
    : Promise.resolve();
  const ensureHealthy = () => { if (projectionFailure) throw projectionFailure; };
  const enqueue = (operation, { duringDrain = false } = {}) => {
    if (abandoning || (draining && !duringDrain)) {
      return Promise.reject(effectError('cannot inspect or change effects after close has begun'));
    }
    const job = queue.then(() => { ensureHealthy(); return operation(); });
    queue = job.then(() => undefined, () => undefined);
    return job;
  };
  const append = async (type, data) => {
    let event;
    try { event = await log.append(type, data); }
    catch (error) {
      if (error?.commitStatus !== 'not-written') {
        projectionFailure ??= error;
        releaseAllCapabilities();
      }
      throw error;
    }
    try { applyEvent(event, state); }
    catch (error) {
      projectionFailure = effectError('a durable event was written but the live effect projection failed; close and reopen before continuing', error);
      releaseAllCapabilities();
      throw projectionFailure;
    }
    return event;
  };
  const nextRevision = (reserved = null) => {
    let value;
    do { value = randomUUID(); } while (reserved?.has(value));
    reserved?.add(value);
    return value;
  };
  const nextActionId = () => {
    let value;
    do { value = `effect:${randomUUID()}`; } while (state.seenActionIds.has(value));
    return value;
  };
  const view = record => projection(record, {
    executorActive: activeAttempts.has(record.action.id),
    runActive: activeRuns.has(record.action.runId),
  });

  const beginRun = value => {
    const raw = fields(value, ['runId', 'origin'], 'effect run');
    const run = deepFreeze({
      runId: identifier(raw.runId, 'effect run.runId'),
      origin: originName(raw.origin, 'effect run.origin'),
    });
    return enqueue(() => {
      if (activeRuns.has(run.runId)) throw effectError('that run is already active in this process');
      if (state.seenRunIds.has(run.runId)) throw effectError('that run id already exists in durable effect history');
      const capability = Object.freeze(Object.create(null));
      runCapabilities.set(capability, run);
      activeRuns.set(run.runId, { capability, run });
      return capability;
    });
  };

  const runContext = capability => enqueue(() => {
    const run = runCapabilities.get(capability);
    if (!run || activeRuns.get(run.runId)?.capability !== capability) {
      throw effectError('run capability is not an active run capability from this store');
    }
    return run;
  });

  const prepare = value => {
    const normalized = prepareInput(value);
    return enqueue(async () => {
      const run = runCapabilities.get(normalized.run);
      if (!run || activeRuns.get(run.runId)?.capability !== normalized.run) {
        throw effectError('effect preparation.run is not an active run capability from this store');
      }
      if (state.disposedRunIds.has(run.runId)) throw effectError('cannot prepare an effect for a disposed run');
      if ([...state.actions.values()].some(record => record.action.runId === run.runId
        && record.action.callIdHash === normalized.callIdHash)) {
        throw effectError('that run already prepared this call identity');
      }
      const key = fenceKey(normalized.tool, normalized.argumentsSha256);
      const existing = [...state.actions.values()].find(record => fenceKey(record.action.tool, record.action.argumentsSha256) === key);
      if (existing) throw effectError(`the same unresolved tool and argument digest is already fenced by ${existing.action.id}`);
      if (state.actions.size >= TOOL_EFFECT_LIMITS.unresolved) {
        throw effectError(`the unresolved effect limit of ${TOOL_EFFECT_LIMITS.unresolved} has been reached`);
      }
      const action = createAction(normalized, run, nextActionId(), timestamp(clock), nextRevision());
      await append('tool_effect_prepared', { action });
      return view(state.actions.get(action.id));
    });
  };

  const fence = value => {
    const normalized = fenceInput(value);
    const key = fenceKey(normalized.tool, normalized.argumentsSha256);
    return enqueue(() => {
      const current = [...state.actions.values()].find(record => fenceKey(record.action.tool, record.action.argumentsSha256) === key);
      return current ? view(current) : null;
    });
  };

  const beginAttempt = value => {
    const raw = fields(value, ['run', 'actionId', 'expectedRevision'], 'effect attempt');
    const actionId = identifier(raw.actionId, 'effect attempt.actionId');
    const expectedRevision = revision(raw.expectedRevision, 'effect attempt.expectedRevision');
    return enqueue(async () => {
      const run = runCapabilities.get(raw.run);
      if (!run || activeRuns.get(run.runId)?.capability !== raw.run) {
        throw effectError('effect attempt.run is not an active run capability from this store');
      }
      const current = state.actions.get(actionId);
      if (!current) throw effectError(`no unresolved effect has id ${JSON.stringify(actionId)}`);
      if (current.action.runId !== run.runId) throw effectError('the effect belongs to a different run');
      if (current.revision !== expectedRevision) throw effectError(`conflict: effect ${JSON.stringify(actionId)} changed after inspection`);
      if (current.attempt) throw effectError(`effect ${JSON.stringify(actionId)} was already attempted`);
      const attempt = createAttempt(current, timestamp(clock), nextRevision(new Set([current.revision])));
      await append('tool_effect_attempted', { attempt });
      const capability = Object.freeze(Object.create(null));
      attemptCapabilities.set(capability, actionId);
      activeAttempts.set(actionId, capability);
      return Object.freeze({ effect: view(state.actions.get(actionId)), capability });
    });
  };

  const reportOutcome = value => {
    const raw = fields(value, ['capability', 'outcome'], 'effect report');
    if (!REPORT_OUTCOMES.has(raw.outcome)) {
      throw effectError('effect report.outcome must be executor-returned, executor-error, or interrupted');
    }
    return enqueue(async () => {
      const actionId = attemptCapabilities.get(raw.capability);
      if (!actionId || activeAttempts.get(actionId) !== raw.capability) {
        throw effectError('effect report.capability is not an active executor capability from this store');
      }
      const current = state.actions.get(actionId);
      if (!current?.attempt || current.report) throw effectError('the active executor no longer matches an unsettled attempt');
      try {
        const report = createReport(current, raw.outcome, timestamp(clock), nextRevision(new Set([current.revision])));
        await append('tool_effect_reported', { report });
        return view(state.actions.get(actionId));
      } finally {
        // A report call consumes the capability. A definitely-unwritten report
        // remains uncertain and recoverable; an unknown commit poisons safely.
        releaseAttempt(raw.capability);
      }
    }, { duringDrain: true });
  };

  const recordRunDisposition = value => {
    const raw = fields(value, ['run', 'disposition', 'conversationId'], 'run disposition');
    if (!RUN_DISPOSITIONS.has(raw.disposition)) {
      throw effectError('run disposition.disposition must be committed, save-failed, discarded, or run-failed');
    }
    const conversationId = optionalConversationId(raw.conversationId, 'run disposition.conversationId');
    return enqueue(async () => {
      const run = runCapabilities.get(raw.run);
      if (!run || activeRuns.get(run.runId)?.capability !== raw.run) {
        throw effectError('run disposition.run is not an active run capability from this store');
      }
      if (state.disposedRunIds.has(run.runId)) throw effectError('that run already has a disposition');
      const active = [...activeAttempts.keys()].filter(actionId => state.actions.get(actionId)?.action.runId === run.runId);
      if (active.length) throw effectError('cannot disposition a run while one of its executors is active');
      const current = state.order.map(id => state.actions.get(id)).filter(record => record.action.runId === run.runId);
      const recordedAt = timestamp(clock);
      for (const record of current) orderedAt(recordedAt, latestAt(record), 'run disposition.recordedAt');
      const reserved = new Set(current.map(record => record.revision));
      const revisions = current.map(record => deepFreeze({
        actionId: record.action.id,
        previousRevision: record.revision,
        revision: nextRevision(reserved),
      }));
      const disposition = createDisposition(run, raw.disposition, conversationId, recordedAt, revisions);
      // A run with no tracked effects owns only in-process authority. Releasing
      // that authority is sufficient; an empty durable disposition would add
      // one ledger event to every read-only chat without protecting anything.
      if (current.length === 0) {
        releaseRun(raw.run);
        return deepFreeze({
          runId: run.runId,
          disposition: runDispositionProjection(disposition),
          affected: 0,
          completed: 0,
        });
      }
      try {
        await append('tool_effect_run_dispositioned', { disposition });
      } catch (error) {
        if (error?.commitStatus !== 'not-written') releaseRun(raw.run);
        throw error;
      }
      releaseRun(raw.run);
      const completed = current.filter(record => raw.disposition === 'committed'
        && record.report?.outcome === 'executor-returned').length;
      return deepFreeze({
        runId: run.runId,
        disposition: runDispositionProjection(disposition),
        affected: revisions.length,
        completed,
      });
    }, { duringDrain: true });
  };

  const unresolved = (options = {}) => {
    const limit = limitOptions(options, 'unresolved options');
    return enqueue(() => {
      const items = state.order.slice(-limit).reverse().map(id => view(state.actions.get(id)));
      return deepFreeze({ total: state.order.length, hasMore: state.order.length > items.length, items: deepFreeze(items) });
    });
  };

  const history = (options = {}) => {
    const limit = limitOptions(options, 'history options');
    return enqueue(() => deepFreeze(state.history.slice(-limit).reverse()));
  };

  const inspect = actionId => {
    const id = identifier(actionId, 'actionId');
    return enqueue(() => {
      const current = state.actions.get(id);
      if (current) return deepFreeze({ unresolved: view(current), terminal: null });
      const terminal = [...state.history].reverse().find(row => row.actionId === id) ?? null;
      return deepFreeze({
        unresolved: null,
        terminal,
      });
    });
  };

  const resolve = value => {
    const raw = fields(value, ['actionId', 'expectedRevision', 'resolution'], 'effect resolution');
    const actionId = identifier(raw.actionId, 'effect resolution.actionId');
    const expectedRevision = revision(raw.expectedRevision, 'effect resolution.expectedRevision');
    if (!RESOLUTIONS.has(raw.resolution)) {
      throw effectError('effect resolution.resolution must be abandon-not-attempted, acknowledge-uncertain, or acknowledge-completed');
    }
    return enqueue(async () => {
      const current = state.actions.get(actionId);
      if (!current) throw effectError(`no unresolved effect has id ${JSON.stringify(actionId)}`);
      if (current.revision !== expectedRevision) throw effectError(`conflict: effect ${JSON.stringify(actionId)} changed after inspection`);
      if (activeRuns.has(current.action.runId)) throw effectError('operator resolution is blocked while the containing run is active');
      if (activeAttempts.has(actionId)) throw effectError('operator resolution is blocked while the executor is active');
      if (!validResolutionFor(current, raw.resolution)) {
        throw effectError(`resolution ${JSON.stringify(raw.resolution)} is not valid for ${stateName(current)}`);
      }
      const resolutionValue = createResolution(current, raw.resolution, timestamp(clock));
      await append('tool_effect_resolved', { resolution: resolutionValue });
      return state.history.at(-1);
    });
  };

  const receipt = () => enqueue(() => log.receipt());
  const close = () => {
    if (!closePromise) {
      draining = true;
      closePromise = (async () => {
        // Run and attempt capabilities own the right to write their terminal
        // facts. Keep the lock and admit their reports/disposition while
        // draining. A poisoned store cannot accept them and closes fail-safe.
        while (true) {
          await queue;
          if (projectionFailure || (!activeRuns.size && !activeAttempts.size)) break;
          await waitForIdle();
        }
        await queue;
        const errors = [];
        try { await log.close(); } catch (error) { errors.push(error); }
        if (projectionFailure && !errors.includes(projectionFailure)) errors.push(projectionFailure);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Tool-effect close preserved durable and projection failures');
      })();
    }
    return closePromise;
  };

  const forceClose = () => {
    // A host may need to finish restart/reset even when an executor or
    // provider ignores cancellation forever. This abandons only in-process
    // authority: no completion or disposition is invented, and replay keeps
    // every durable boundary fenced for explicit recovery.
    abandoning = true;
    draining = true;
    releaseAllCapabilities();
    return close();
  };

  const store = Object.freeze({
    id: log.id,
    beginRun,
    runContext,
    prepare,
    fence,
    beginAttempt,
    reportOutcome,
    recordRunDisposition,
    unresolved,
    history,
    inspect,
    resolve,
    receipt,
    close,
    forceClose,
  });
  stores.add(store);
  return store;
}

export function isToolEffectStore(value) {
  return Boolean(value) && stores.has(value);
}

export async function createToolEffectStore(file, options = {}) {
  const raw = fields(options, ['id', 'clock', 'sync'], 'create options');
  const id = raw.id === undefined ? randomUUID() : identifier(raw.id, 'create options.id');
  const clock = raw.clock ?? Date.now;
  const sync = raw.sync ?? true;
  if (typeof clock !== 'function') throw effectError('create options.clock must be a function');
  if (typeof sync !== 'boolean') throw effectError('create options.sync must be true or false');
  const state = newState();
  const log = await openDurableLog(file, {
    create: true,
    format: TOOL_EFFECT_EVENT_FORMAT,
    idField: 'toolEffectStoreId',
    id,
    initial: {
      type: 'tool_effect_store_created',
      data: {
        actionFormat: TOOL_EFFECT_ACTION_FORMAT,
        attemptFormat: TOOL_EFFECT_ATTEMPT_FORMAT,
        reportFormat: TOOL_EFFECT_REPORT_FORMAT,
        resolutionFormat: TOOL_EFFECT_RESOLUTION_FORMAT,
        dispositionFormat: TOOL_EFFECT_DISPOSITION_FORMAT,
        policy: TOOL_EFFECT_POLICY,
      },
    },
    clock,
    sync,
    maxDataBytes: TOOL_EFFECT_LIMITS.eventBytes,
    maxLineBytes: TOOL_EFFECT_LIMITS.lineBytes,
    maxReplayBytes: TOOL_EFFECT_LIMITS.replayBytes,
    maxEvents: TOOL_EFFECT_LIMITS.events,
  });
  state.sawGenesis = true;
  return buildStore(log, state, clock);
}

export async function openToolEffectStore(file, options = {}) {
  const raw = fields(options, ['expectedId', 'expectedHead', 'clock', 'sync'], 'open options');
  const clock = raw.clock ?? Date.now;
  const sync = raw.sync ?? true;
  if (typeof clock !== 'function') throw effectError('open options.clock must be a function');
  if (typeof sync !== 'boolean') throw effectError('open options.sync must be true or false');
  const log = await openDurableLog(file, {
    format: TOOL_EFFECT_EVENT_FORMAT,
    idField: 'toolEffectStoreId',
    ...(raw.expectedId === undefined ? {} : { expectedId: identifier(raw.expectedId, 'open options.expectedId') }),
    ...(raw.expectedHead === undefined ? {} : { expectedHead: digest(raw.expectedHead, 'open options.expectedHead') }),
    clock,
    sync,
    maxDataBytes: TOOL_EFFECT_LIMITS.eventBytes,
    maxLineBytes: TOOL_EFFECT_LIMITS.lineBytes,
    maxReplayBytes: TOOL_EFFECT_LIMITS.replayBytes,
    maxEvents: TOOL_EFFECT_LIMITS.events,
    replay: { create: newState, apply: (state, event) => applyEvent(event, state) },
  });
  return buildStore(log, log.replayState, clock);
}
