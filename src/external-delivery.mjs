import { createHash, randomUUID } from 'node:crypto';
import { openDurableLog } from './durable-log.mjs';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';

// A bridge delivery is deliberately split into three facts:
//
//   1. Fieldwork approved an exact, route-bound plan before any network write.
//   2. Fieldwork durably marked the instant that plan became eligible to send.
//   3. The platform later acknowledged all, some, or none of that plan.
//
// Receipts retain hashes, counts and platform acknowledgement IDs, never a
// second copy of message text. A prepared plan is process-local and carries the
// exact chunks; durable attempt and recovery records are safe to inspect and
// export.

export const BRIDGE_OUTPUT_FORMAT = 'fieldwork-bridge-output/v1';
export const EXTERNAL_DELIVERY_EVENT_FORMAT = 'fieldwork-external-delivery-event/v1';
export const EXTERNAL_DELIVERY_ACTION_FORMAT = 'fieldwork-external-delivery-action/v1';
export const EXTERNAL_DELIVERY_ENVELOPE_FORMAT = 'fieldwork-external-delivery-envelope/v1';
export const EXTERNAL_DELIVERY_PREFLIGHT_FORMAT = 'fieldwork-external-delivery-preflight/v1';
export const EXTERNAL_DELIVERY_ATTEMPT_FORMAT = 'fieldwork-external-delivery-attempt/v1';
export const EXTERNAL_DELIVERY_SETTLEMENT_FORMAT_V1 = 'fieldwork-external-delivery-settlement/v1';
export const EXTERNAL_DELIVERY_SETTLEMENT_FORMAT = 'fieldwork-external-delivery-settlement/v2';
export const EXTERNAL_DELIVERY_POLICY = 'fieldwork-bridge-reply-policy/v1';
export const EXTERNAL_DELIVERY_PROACTIVE_POLICY = 'fieldwork-bridge-proactive-policy/v1';

export const EXTERNAL_DELIVERY_LIMITS = Object.freeze({
  contentBytes: 256 * 1024,
  chunks: 256,
  eventBytes: 384 * 1024,
  lineBytes: 512 * 1024,
  telegramCharacters: 4096,
  discordCharacters: 2000,
  platformMessageIds: 256,
});

const stores = new WeakSet();
const storeInternals = new WeakMap();
const coordinators = new WeakSet();
const plans = new WeakSet();
const outputs = new WeakSet();
const portableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const decimalId = /^[1-9][0-9]{0,31}$/;
const telegramDestination = /^-?[1-9][0-9]{0,31}$/;
// Conversation IDs are zero-padded to six digits, but continue growing after
// m999999. Proactive delivery must share that unbounded on-disk identity.
const conversationMessageId = /^m[0-9]{6,}$/;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const settlementFields = [
  'format', 'actionId', 'settledAt', 'outcome', 'failureKind', 'acceptedChunks', 'totalChunks',
  'platformMessageIds', 'acknowledgements', 'fingerprint',
];

function deliveryError(message, cause) {
  return new Error(`External delivery: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw deliveryError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw deliveryError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw deliveryError(`${where}.${String(key)} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function identifier(value, where) {
  if (typeof value !== 'string' || !portableId.test(value)) {
    throw deliveryError(`${where} must be 1-128 portable identifier characters`);
  }
  return value;
}

function instant(value, where) {
  if (typeof value !== 'string') throw deliveryError(`${where} must be an exact ISO timestamp`);
  let normalized = '';
  try { normalized = new Date(value).toISOString(); } catch { /* Rejected below. */ }
  if (normalized !== value) throw deliveryError(`${where} must be an exact ISO timestamp`);
  return value;
}

function fingerprint(value, where) {
  if (typeof value !== 'string' || !hashPattern.test(value)) {
    throw deliveryError(`${where} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function normalizedJson(value, where, maxBytes = EXTERNAL_DELIVERY_LIMITS.eventBytes) {
  try {
    return boundedJson(value, { where, object: true, maxBytes, maxDepth: 32, maxNodes: 20_000 }).value;
  } catch (error) {
    throw deliveryError(error.message, error);
  }
}

function outputSource(value, where = 'bridge output.source') {
  const raw = fields(value, ['kind', 'conversationId', 'messageId', 'messageSha256', 'contentSha256', 'diagnosticId'], where);
  if (raw.kind === 'conversation-reply') {
    if (raw.diagnosticId !== undefined) throw deliveryError(`${where}.diagnosticId is not valid for a conversation reply`);
    return deepFreeze({
      kind: raw.kind,
      conversationId: identifier(raw.conversationId, `${where}.conversationId`),
      messageId: identifier(raw.messageId, `${where}.messageId`),
      messageSha256: fingerprint(raw.messageSha256, `${where}.messageSha256`),
      contentSha256: fingerprint(raw.contentSha256, `${where}.contentSha256`),
    });
  }
  if (raw.kind === 'fieldwork-fallback') {
    if (raw.conversationId !== undefined || raw.messageId !== undefined || raw.messageSha256 !== undefined || raw.contentSha256 !== undefined) {
      throw deliveryError(`${where} has conversation fields for a fallback`);
    }
    return deepFreeze({
      kind: raw.kind,
      diagnosticId: identifier(raw.diagnosticId, `${where}.diagnosticId`),
    });
  }
  if (raw.kind === 'legacy') {
    if (Reflect.ownKeys(raw).some(key => key !== 'kind')) throw deliveryError(`${where} has fields for a legacy reply`);
    return deepFreeze({ kind: 'legacy' });
  }
  throw deliveryError(`${where}.kind must be conversation-reply, fieldwork-fallback, or legacy`);
}

function makeOutput(text, source) {
  if (typeof text !== 'string') throw deliveryError('bridge output.text must be text');
  const output = deepFreeze({ format: BRIDGE_OUTPUT_FORMAT, text, source });
  outputs.add(output);
  return output;
}

export function createBridgeOutput(input) {
  const raw = fields(input, ['format', 'text', 'source'], 'bridge output');
  if (raw.format !== BRIDGE_OUTPUT_FORMAT) throw deliveryError(`bridge output.format must be ${BRIDGE_OUTPUT_FORMAT}`);
  return makeOutput(raw.text, outputSource(raw.source));
}

export function normalizeBridgeOutput(value) {
  if (outputs.has(value)) return value;
  if (typeof value === 'string') return makeOutput(value, deepFreeze({ kind: 'legacy' }));
  return createBridgeOutput(value);
}

export function isBridgeOutput(value) {
  return Boolean(value) && outputs.has(value);
}

function routeProjection(value, where = 'delivery route') {
  const raw = fields(value, ['platform', 'destinationId', 'sourceUserId'], where);
  if (!['telegram', 'discord'].includes(raw.platform)) throw deliveryError(`${where}.platform must be telegram or discord`);
  const destinationPattern = raw.platform === 'telegram' ? telegramDestination : decimalId;
  if (typeof raw.destinationId !== 'string' || !destinationPattern.test(raw.destinationId)) {
    throw deliveryError(`${where}.destinationId is invalid for ${raw.platform}`);
  }
  if (typeof raw.sourceUserId !== 'string' || !decimalId.test(raw.sourceUserId)) {
    throw deliveryError(`${where}.sourceUserId is invalid`);
  }
  return deepFreeze({
    platform: raw.platform,
    destinationId: raw.destinationId,
    sourceUserId: raw.sourceUserId,
  });
}

function chunkLimit(platform) {
  return platform === 'telegram'
    ? EXTERNAL_DELIVERY_LIMITS.telegramCharacters
    : EXTERNAL_DELIVERY_LIMITS.discordCharacters;
}

function check(id, status, reason) {
  return deepFreeze({ id, status, ...(reason ? { reason } : {}) });
}

function contentPlan(text, platform, source) {
  const obviouslyTooLarge = text.length > EXTERNAL_DELIVERY_LIMITS.contentBytes;
  const wellFormed = !obviouslyTooLarge && (typeof text.isWellFormed !== 'function' || text.isWellFormed());
  const nonempty = wellFormed && Boolean(text.trim());
  const bytes = wellFormed ? Buffer.byteLength(text, 'utf8') : null;
  const characters = wellFormed ? [...text].length : null;
  const contentHash = wellFormed ? sha256(text) : null;
  const checks = [check('route-bound', 'passed')];
  let reason = null;
  if (obviouslyTooLarge) reason = 'content-too-large';
  else if (!wellFormed) reason = 'malformed-unicode';
  else if (!nonempty) reason = 'empty-content';
  else if (bytes > EXTERNAL_DELIVERY_LIMITS.contentBytes) reason = 'content-too-large';
  checks.push(check('content', reason ? 'failed' : 'passed', reason));

  const sourceMismatch = !reason
    && source.kind === 'conversation-reply'
    && source.contentSha256 !== contentHash;
  checks.push(check(
    'source-bound',
    source.kind === 'conversation-reply' && !reason ? (sourceMismatch ? 'failed' : 'passed') : 'skipped',
    sourceMismatch ? 'source-content-mismatch' : null,
  ));
  if (sourceMismatch) reason = 'source-content-mismatch';

  const chunks = [];
  if (!reason) {
    const codePoints = [...text];
    const limit = chunkLimit(platform);
    for (let offset = 0; offset < codePoints.length; offset += limit) {
      chunks.push(codePoints.slice(offset, offset + limit).join(''));
    }
    if (!chunks.length || chunks.length > EXTERNAL_DELIVERY_LIMITS.chunks) reason = 'chunk-plan-too-large';
  }
  checks.push(check('chunk-plan', reason ? (chunks.length ? 'failed' : 'skipped') : 'passed', reason === 'chunk-plan-too-large' ? reason : null));
  const chunkReceipts = reason ? [] : chunks.map((chunk, index) => deepFreeze({
    index,
    sha256: sha256(chunk),
    characters: [...chunk].length,
    bytes: Buffer.byteLength(chunk, 'utf8'),
  }));
  return {
    decision: reason ? 'refuse' : 'allow',
    chunks: reason ? [] : chunks,
    checks,
    content: deepFreeze({
      sha256: contentHash,
      characters,
      bytes,
      chunks: deepFreeze(chunkReceipts),
    }),
  };
}

function sourceKey(envelope) {
  if (envelope.action === 'bridge-proactive' && envelope.source.kind === 'conversation-reply') {
    return `${envelope.platform}\u0000${envelope.destinationId}\u0000${envelope.source.conversationId}\u0000${envelope.sourceMessageId}`;
  }
  return `${envelope.platform}\u0000${envelope.destinationId}\u0000${envelope.sourceMessageId}`;
}

function savedReplyKey(envelope) {
  const source = envelope.source;
  return source.kind === 'conversation-reply'
    ? `${source.conversationId}\u0000${source.messageId}\u0000${source.messageSha256}`
    : null;
}

function actionBody({ id, createdAt, route, sourceMessageId, output, planned, action = 'bridge-reply' }) {
  const policy = action === 'bridge-proactive'
    ? EXTERNAL_DELIVERY_PROACTIVE_POLICY
    : EXTERNAL_DELIVERY_POLICY;
  const envelope = deepFreeze({
    format: EXTERNAL_DELIVERY_ENVELOPE_FORMAT,
    action,
    policy,
    platform: route.platform,
    destinationId: route.destinationId,
    sourceUserId: route.sourceUserId,
    sourceMessageId,
    source: output.source,
    content: planned.content,
  });
  const preflight = deepFreeze({
    format: EXTERNAL_DELIVERY_PREFLIGHT_FORMAT,
    decision: planned.decision,
    checks: deepFreeze(planned.checks),
  });
  return {
    format: EXTERNAL_DELIVERY_ACTION_FORMAT,
    id,
    createdAt,
    envelope,
    preflight,
  };
}

function validateContentReceipt(value, platform, where) {
  const raw = fields(value, ['sha256', 'characters', 'bytes', 'chunks'], where);
  if (raw.sha256 !== null) fingerprint(raw.sha256, `${where}.sha256`);
  if (raw.characters !== null && (!Number.isSafeInteger(raw.characters) || raw.characters < 0)) throw deliveryError(`${where}.characters is invalid`);
  if (raw.bytes !== null && (!Number.isSafeInteger(raw.bytes) || raw.bytes < 0)) throw deliveryError(`${where}.bytes is invalid`);
  const evidence = [raw.sha256, raw.characters, raw.bytes];
  if (!evidence.every(value => value === null) && evidence.some(value => value === null)) {
    throw deliveryError(`${where} content evidence must be entirely present or entirely absent`);
  }
  if (!Array.isArray(raw.chunks) || raw.chunks.length > EXTERNAL_DELIVERY_LIMITS.chunks) throw deliveryError(`${where}.chunks is invalid`);
  const chunks = raw.chunks.map((value, index) => {
    const chunk = fields(value, ['index', 'sha256', 'characters', 'bytes'], `${where}.chunks[${index}]`);
    if (chunk.index !== index) throw deliveryError(`${where}.chunks[${index}].index is invalid`);
    fingerprint(chunk.sha256, `${where}.chunks[${index}].sha256`);
    for (const key of ['characters', 'bytes']) {
      if (!Number.isSafeInteger(chunk[key]) || chunk[key] < 1) throw deliveryError(`${where}.chunks[${index}].${key} is invalid`);
    }
    if (chunk.characters > chunkLimit(platform)) throw deliveryError(`${where}.chunks[${index}].characters exceeds the platform limit`);
    return deepFreeze({ index, sha256: chunk.sha256, characters: chunk.characters, bytes: chunk.bytes });
  });
  if (chunks.length) {
    if (raw.sha256 === null) throw deliveryError(`${where} chunks need complete content evidence`);
    const characters = chunks.reduce((sum, chunk) => sum + chunk.characters, 0);
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
    if (raw.characters !== characters || raw.bytes !== bytes) throw deliveryError(`${where} totals do not match its chunks`);
  }
  return deepFreeze({ sha256: raw.sha256, characters: raw.characters, bytes: raw.bytes, chunks: deepFreeze(chunks) });
}

function validateChecks(value, decision, source, where) {
  if (!Array.isArray(value) || value.length !== 4) throw deliveryError(`${where} must contain exactly four checks`);
  const expected = ['route-bound', 'content', 'source-bound', 'chunk-plan'];
  const checks = value.map((value, index) => {
    const raw = fields(value, ['id', 'status', 'reason'], `${where}[${index}]`);
    if (raw.id !== expected[index]) throw deliveryError(`${where}[${index}].id is invalid`);
    if (!['passed', 'failed', 'skipped'].includes(raw.status)) throw deliveryError(`${where}[${index}].status is invalid`);
    if (raw.reason !== undefined && !['malformed-unicode', 'empty-content', 'content-too-large', 'source-content-mismatch', 'chunk-plan-too-large'].includes(raw.reason)) {
      throw deliveryError(`${where}[${index}].reason is invalid`);
    }
    if ((raw.status === 'failed') !== Boolean(raw.reason)) throw deliveryError(`${where}[${index}] must have a reason exactly when it failed`);
    return deepFreeze({ id: raw.id, status: raw.status, ...(raw.reason ? { reason: raw.reason } : {}) });
  });
  const failed = checks.filter(row => row.status === 'failed');
  if ((decision === 'allow') !== (failed.length === 0)) throw deliveryError(`${where} does not match the preflight decision`);
  if (decision === 'refuse' && failed.length !== 1) throw deliveryError(`${where} must have exactly one failed check for a refusal`);
  if (checks[0].status !== 'passed' || checks[0].reason) throw deliveryError(`${where}[0] must pass`);
  if (checks[1].status === 'skipped') throw deliveryError(`${where}[1] cannot be skipped`);
  if (source.kind === 'conversation-reply') {
    if (checks[1].status === 'failed') {
      if (checks[2].status !== 'skipped') throw deliveryError(`${where}[2] must skip when content validation failed`);
    } else {
      if (!['passed', 'failed'].includes(checks[2].status)) throw deliveryError(`${where}[2] must check a conversation source`);
      if (checks[2].status === 'failed' && checks[2].reason !== 'source-content-mismatch') throw deliveryError(`${where}[2] has the wrong failure reason`);
    }
  } else if (checks[2].status !== 'skipped') throw deliveryError(`${where}[2] must skip an unlinked source`);
  if (decision === 'allow' && checks[3].status !== 'passed') throw deliveryError(`${where}[3] must pass an allowed plan`);
  if (checks[3].status === 'failed' && checks[3].reason !== 'chunk-plan-too-large') throw deliveryError(`${where}[3] has the wrong failure reason`);
  if (checks[1].status === 'failed' && !['malformed-unicode', 'empty-content', 'content-too-large'].includes(checks[1].reason)) {
    throw deliveryError(`${where}[1] has the wrong failure reason`);
  }
  if (checks[1].status === 'failed' && checks[3].status !== 'skipped') throw deliveryError(`${where}[3] must skip after a content failure`);
  if (checks[2].status === 'failed' && checks[3].status !== 'skipped') throw deliveryError(`${where}[3] must skip after a source-binding failure`);
  if (checks[3].status === 'failed' && (checks[1].status !== 'passed' || !['passed', 'skipped'].includes(checks[2].status))) {
    throw deliveryError(`${where}[3] cannot fail after an earlier failed check`);
  }
  return deepFreeze(checks);
}

function restoreAction(input) {
  const normalized = normalizedJson(input, 'stored delivery action');
  const raw = fields(normalized, ['format', 'id', 'createdAt', 'envelope', 'preflight', 'fingerprint'], 'stored delivery action');
  if (raw.format !== EXTERNAL_DELIVERY_ACTION_FORMAT) throw deliveryError(`stored delivery action.format must be ${EXTERNAL_DELIVERY_ACTION_FORMAT}`);
  const id = identifier(raw.id, 'stored delivery action.id');
  const createdAt = instant(raw.createdAt, 'stored delivery action.createdAt');
  const envelopeRaw = fields(raw.envelope, [
    'format', 'action', 'policy', 'platform', 'destinationId', 'sourceUserId', 'sourceMessageId', 'source', 'content',
  ], 'stored delivery action.envelope');
  if (envelopeRaw.format !== EXTERNAL_DELIVERY_ENVELOPE_FORMAT) throw deliveryError('stored delivery action.envelope.format is invalid');
  const reply = envelopeRaw.action === 'bridge-reply' && envelopeRaw.policy === EXTERNAL_DELIVERY_POLICY;
  const proactive = envelopeRaw.action === 'bridge-proactive' && envelopeRaw.policy === EXTERNAL_DELIVERY_PROACTIVE_POLICY;
  if (!reply && !proactive) throw deliveryError('stored delivery action.envelope policy is invalid');
  const route = routeProjection({
    platform: envelopeRaw.platform,
    destinationId: envelopeRaw.destinationId,
    sourceUserId: envelopeRaw.sourceUserId,
  }, 'stored delivery action.envelope');
  const sourceMessageId = identifier(envelopeRaw.sourceMessageId, 'stored delivery action.envelope.sourceMessageId');
  const source = outputSource(envelopeRaw.source, 'stored delivery action.envelope.source');
  if (reply && !decimalId.test(sourceMessageId)) {
    throw deliveryError('stored bridge reply sourceMessageId is not a decimal platform identifier');
  }
  if (proactive && (!conversationMessageId.test(sourceMessageId)
    || source.kind !== 'conversation-reply'
    || source.messageId !== sourceMessageId)) {
    throw deliveryError('stored proactive sourceMessageId must match its conversation reply messageId');
  }
  const content = validateContentReceipt(envelopeRaw.content, route.platform, 'stored delivery action.envelope.content');
  const preflightRaw = fields(raw.preflight, ['format', 'decision', 'checks'], 'stored delivery action.preflight');
  if (preflightRaw.format !== EXTERNAL_DELIVERY_PREFLIGHT_FORMAT) throw deliveryError('stored delivery action.preflight.format is invalid');
  if (!['allow', 'refuse'].includes(preflightRaw.decision)) throw deliveryError('stored delivery action.preflight.decision is invalid');
  const checks = validateChecks(preflightRaw.checks, preflightRaw.decision, source, 'stored delivery action.preflight.checks');
  if (preflightRaw.decision === 'allow' && !content.chunks.length) throw deliveryError('an allowed delivery action needs chunks');
  if (preflightRaw.decision === 'refuse' && content.chunks.length) throw deliveryError('a refused delivery action cannot retain chunks');
  if (preflightRaw.decision === 'allow' && (content.sha256 === null || content.characters < 1 || content.bytes < 1)) {
    throw deliveryError('an allowed delivery action needs complete content evidence');
  }
  if (preflightRaw.decision === 'allow' && content.bytes > EXTERNAL_DELIVERY_LIMITS.contentBytes) {
    throw deliveryError('an allowed delivery action exceeds the content byte limit');
  }
  const failedCheck = checks.find(check => check.status === 'failed') ?? null;
  if (checks[1].status === 'passed'
    && (content.sha256 === null || content.characters < 1 || content.bytes < 1 || content.bytes > EXTERNAL_DELIVERY_LIMITS.contentBytes)) {
    throw deliveryError('a passed content check needs bounded complete content evidence');
  }
  if (source.kind === 'conversation-reply' && checks[2].status === 'passed' && source.contentSha256 !== content.sha256) {
    throw deliveryError('a source-bound delivery action must match its saved reply content hash');
  }
  if (failedCheck?.reason === 'source-content-mismatch' && (content.sha256 === null || source.contentSha256 === content.sha256)) {
    throw deliveryError('a source-content-mismatch refusal must retain contradictory content hashes');
  }
  if (failedCheck?.reason === 'empty-content' && content.sha256 === null) {
    throw deliveryError('an empty-content refusal must retain complete content evidence');
  }
  if (failedCheck?.reason === 'content-too-large') {
    const measuredOversize = content.bytes !== null && content.bytes > EXTERNAL_DELIVERY_LIMITS.contentBytes;
    const unmeasuredOversize = content.sha256 === null && content.characters === null && content.bytes === null;
    if (!measuredOversize && !unmeasuredOversize) throw deliveryError('a content-too-large refusal needs oversize evidence');
  }
  if (failedCheck?.reason === 'malformed-unicode' && content.sha256 !== null) {
    throw deliveryError('a malformed-unicode refusal cannot retain normalized content evidence');
  }
  if (failedCheck?.reason === 'chunk-plan-too-large'
    && (content.sha256 === null || content.characters < 1 || content.bytes < 1 || content.bytes > EXTERNAL_DELIVERY_LIMITS.contentBytes)) {
    throw deliveryError('a chunk-plan-too-large refusal needs bounded complete content evidence');
  }
  const envelope = deepFreeze({
    format: EXTERNAL_DELIVERY_ENVELOPE_FORMAT,
    action: envelopeRaw.action,
    policy: envelopeRaw.policy,
    ...route,
    sourceMessageId,
    source,
    content,
  });
  const preflight = deepFreeze({ format: EXTERNAL_DELIVERY_PREFLIGHT_FORMAT, decision: preflightRaw.decision, checks });
  const body = { format: EXTERNAL_DELIVERY_ACTION_FORMAT, id, createdAt, envelope, preflight };
  fingerprint(raw.fingerprint, 'stored delivery action.fingerprint');
  const restored = deepFreeze({ ...body, fingerprint: sha256(canonicalJson(body)) });
  if (restored.fingerprint !== raw.fingerprint) throw deliveryError('stored delivery action fingerprint does not match its contents');
  return restored;
}

function createAction(value) {
  const body = actionBody(value);
  return deepFreeze({ ...body, fingerprint: sha256(canonicalJson(body)) });
}

function restoreAttempt(input, action) {
  const normalized = normalizedJson(input, 'stored delivery attempt');
  const raw = fields(normalized, ['format', 'actionId', 'attemptedAt', 'fingerprint'], 'stored delivery attempt');
  if (raw.format !== EXTERNAL_DELIVERY_ATTEMPT_FORMAT) throw deliveryError('stored delivery attempt.format is invalid');
  if (identifier(raw.actionId, 'stored delivery attempt.actionId') !== action.id) throw deliveryError('stored delivery attempt.actionId does not match');
  const attemptedAt = instant(raw.attemptedAt, 'stored delivery attempt.attemptedAt');
  if (Date.parse(attemptedAt) < Date.parse(action.createdAt)) throw deliveryError('stored delivery attempt predates its action');
  const body = { format: EXTERNAL_DELIVERY_ATTEMPT_FORMAT, actionId: action.id, attemptedAt };
  fingerprint(raw.fingerprint, 'stored delivery attempt.fingerprint');
  const restored = deepFreeze({ ...body, fingerprint: sha256(canonicalJson(body)) });
  if (restored.fingerprint !== raw.fingerprint) throw deliveryError('stored delivery attempt fingerprint does not match its contents');
  return restored;
}

function createAttempt(action, attemptedAt) {
  const body = { format: EXTERNAL_DELIVERY_ATTEMPT_FORMAT, actionId: action.id, attemptedAt };
  return restoreAttempt({ ...body, fingerprint: sha256(canonicalJson(body)) }, action);
}

function restoreSettlement(input, action) {
  const normalized = normalizedJson(input, 'stored delivery settlement');
  const raw = fields(normalized, settlementFields, 'stored delivery settlement');
  const legacy = raw.format === EXTERNAL_DELIVERY_SETTLEMENT_FORMAT_V1;
  if (!legacy && raw.format !== EXTERNAL_DELIVERY_SETTLEMENT_FORMAT) throw deliveryError('stored delivery settlement.format is invalid');
  if (legacy && raw.acknowledgements !== undefined) throw deliveryError('a v1 delivery settlement cannot contain destination-bound acknowledgements');
  if (identifier(raw.actionId, 'stored delivery settlement.actionId') !== action.id) throw deliveryError('stored delivery settlement.actionId does not match');
  const settledAt = instant(raw.settledAt, 'stored delivery settlement.settledAt');
  if (!['platform-accepted', 'partially-accepted', 'platform-rejected', 'uncertain', 'not-sent'].includes(raw.outcome)) throw deliveryError('stored delivery settlement.outcome is invalid');
  const failureKinds = ['platform-rejected', 'transport-uncertain', 'invalid-acknowledgement', 'operator-abandoned'];
  if (raw.failureKind !== null && !failureKinds.includes(raw.failureKind)) throw deliveryError('stored delivery settlement.failureKind is invalid');
  const total = action.envelope.content.chunks.length;
  if (raw.totalChunks !== total) throw deliveryError('stored delivery settlement.totalChunks does not match the plan');
  if (!Number.isSafeInteger(raw.acceptedChunks) || raw.acceptedChunks < 0 || raw.acceptedChunks > total) {
    throw deliveryError('stored delivery settlement.acceptedChunks is invalid');
  }
  if (!Array.isArray(raw.platformMessageIds) || raw.platformMessageIds.length !== raw.acceptedChunks || raw.platformMessageIds.length > EXTERNAL_DELIVERY_LIMITS.platformMessageIds) {
    throw deliveryError('stored delivery settlement.platformMessageIds must match acceptedChunks');
  }
  const ids = raw.platformMessageIds.map((value, index) => {
    if (typeof value !== 'string' || !decimalId.test(value)) throw deliveryError(`stored delivery settlement.platformMessageIds[${index}] is invalid`);
    return value;
  });
  if (new Set(ids).size !== ids.length) throw deliveryError('stored delivery settlement.platformMessageIds must be unique');
  let acknowledgements = null;
  if (!legacy) {
    if (!Array.isArray(raw.acknowledgements) || raw.acknowledgements.length !== raw.acceptedChunks
      || raw.acknowledgements.length > EXTERNAL_DELIVERY_LIMITS.chunks) {
      throw deliveryError('stored delivery settlement.acknowledgements must match acceptedChunks');
    }
    acknowledgements = raw.acknowledgements.map((value, index) => {
      const acknowledgement = fields(
        value,
        ['index', 'chunkSha256', 'destinationId', 'platformMessageId'],
        `stored delivery settlement.acknowledgements[${index}]`,
      );
      if (acknowledgement.index !== index) {
        throw deliveryError(`stored delivery settlement.acknowledgements[${index}].index must name the accepted prefix`);
      }
      const expectedChunk = action.envelope.content.chunks[index];
      if (!expectedChunk || acknowledgement.chunkSha256 !== expectedChunk.sha256) {
        throw deliveryError(`stored delivery settlement.acknowledgements[${index}].chunkSha256 does not match the plan`);
      }
      if (acknowledgement.destinationId !== action.envelope.destinationId) {
        throw deliveryError(`stored delivery settlement.acknowledgements[${index}].destinationId does not match the plan`);
      }
      if (acknowledgement.platformMessageId !== ids[index]) {
        throw deliveryError(`stored delivery settlement.acknowledgements[${index}].platformMessageId does not match its message id`);
      }
      return deepFreeze({
        index,
        chunkSha256: expectedChunk.sha256,
        destinationId: action.envelope.destinationId,
        platformMessageId: ids[index],
      });
    });
  }
  if (raw.outcome === 'platform-accepted' && raw.acceptedChunks !== total) throw deliveryError('platform-accepted must acknowledge every chunk');
  if (raw.outcome === 'partially-accepted' && !(raw.acceptedChunks > 0 && raw.acceptedChunks < total)) throw deliveryError('partially-accepted needs some but not all chunks');
  if (raw.outcome === 'platform-rejected' && raw.acceptedChunks !== 0) throw deliveryError('platform-rejected cannot claim an acknowledged chunk');
  if (raw.outcome === 'uncertain' && raw.acceptedChunks !== 0) throw deliveryError('uncertain must not claim an acknowledged chunk');
  if (raw.outcome === 'not-sent' && raw.acceptedChunks !== 0) throw deliveryError('not-sent cannot claim an acknowledged chunk');
  if ((raw.outcome === 'platform-accepted') !== (raw.failureKind === null)) {
    throw deliveryError('stored delivery settlement needs a failure kind exactly when it was not fully accepted');
  }
  if (raw.outcome === 'platform-rejected' && raw.failureKind !== 'platform-rejected') {
    throw deliveryError('platform-rejected needs the matching failure kind');
  }
  if (raw.outcome === 'uncertain' && raw.failureKind === 'platform-rejected') {
    throw deliveryError('an explicit platform rejection cannot have an uncertain outcome');
  }
  if (raw.outcome === 'not-sent' && raw.failureKind !== 'operator-abandoned') {
    throw deliveryError('not-sent needs operator-abandoned');
  }
  if (raw.outcome !== 'not-sent' && raw.failureKind === 'operator-abandoned') {
    throw deliveryError('operator-abandoned is valid only for not-sent');
  }
  if (Date.parse(settledAt) < Date.parse(action.createdAt)) throw deliveryError('stored delivery settlement predates its action');
  const body = {
    format: raw.format,
    actionId: action.id,
    settledAt,
    outcome: raw.outcome,
    failureKind: raw.failureKind,
    acceptedChunks: raw.acceptedChunks,
    totalChunks: total,
    platformMessageIds: deepFreeze(ids),
    ...(legacy ? {} : { acknowledgements: deepFreeze(acknowledgements) }),
  };
  fingerprint(raw.fingerprint, 'stored delivery settlement.fingerprint');
  const restored = deepFreeze({ ...body, fingerprint: sha256(canonicalJson(body)) });
  if (restored.fingerprint !== raw.fingerprint) throw deliveryError('stored delivery settlement fingerprint does not match its contents');
  return restored;
}

function createSettlement(input, action, settledAt) {
  const raw = fields(input, ['actionId', 'outcome', 'failureKind', 'acknowledgements'], 'delivery settlement');
  const observations = raw.acknowledgements;
  if (!Array.isArray(observations) || observations.length > EXTERNAL_DELIVERY_LIMITS.chunks) {
    throw deliveryError('delivery settlement.acknowledgements is invalid');
  }
  const acknowledgements = observations.map((value, index) => {
    const observation = fields(
      value,
      ['destinationId', 'platformMessageId'],
      `delivery settlement.acknowledgements[${index}]`,
    );
    const chunk = action.envelope.content.chunks[index];
    if (!chunk) throw deliveryError('delivery settlement has more acknowledgements than planned chunks');
    return {
      index,
      chunkSha256: chunk.sha256,
      destinationId: observation.destinationId,
      platformMessageId: observation.platformMessageId,
    };
  });
  const body = {
    format: EXTERNAL_DELIVERY_SETTLEMENT_FORMAT,
    actionId: raw.actionId,
    settledAt,
    outcome: raw.outcome,
    failureKind: raw.failureKind,
    acceptedChunks: acknowledgements.length,
    totalChunks: action.envelope.content.chunks.length,
    platformMessageIds: acknowledgements.map(row => row.platformMessageId),
    acknowledgements,
  };
  return restoreSettlement({ ...body, fingerprint: sha256(canonicalJson(body)) }, action);
}

function newState() {
  return { sawGenesis: false, attemptTracking: false, actions: new Map(), sources: new Map(), replies: new Map(), conversations: new Map(), order: [] };
}

function indexAction(state, action) {
  const key = sourceKey(action.envelope);
  if (state.actions.has(action.id)) throw deliveryError(`conflict: delivery action ${JSON.stringify(action.id)} already exists`);
  if (state.sources.has(key)) throw deliveryError('conflict: this source message already has a delivery action');
  const reply = savedReplyKey(action.envelope);
  if (reply && state.replies.has(reply)) throw deliveryError('conflict: this saved reply already has a delivery action');
  state.actions.set(action.id, deepFreeze({ action, tracked: state.attemptTracking, attempt: null, settlement: null }));
  state.sources.set(key, action.id);
  state.order.push(action.id);
  if (reply) state.replies.set(reply, action.id);
  if (action.envelope.source.kind === 'conversation-reply') {
    const conversationId = action.envelope.source.conversationId;
    if (!state.conversations.has(conversationId)) state.conversations.set(conversationId, []);
    state.conversations.get(conversationId).push(action.id);
  }
}

function applyEvent(event, state) {
  if (event.type === 'external_delivery_created') {
    if (event.sequence !== 1 || state.sawGenesis) throw deliveryError('external_delivery_created must be the first and only genesis event');
    const raw = fields(event.data, ['actionFormat', 'policy', 'proactivePolicy', 'attemptFormat'], 'external_delivery_created data');
    if (raw.actionFormat !== EXTERNAL_DELIVERY_ACTION_FORMAT || raw.policy !== EXTERNAL_DELIVERY_POLICY) throw deliveryError('external_delivery_created data is incompatible');
    if (raw.proactivePolicy !== undefined && raw.proactivePolicy !== EXTERNAL_DELIVERY_PROACTIVE_POLICY) {
      throw deliveryError('external_delivery_created proactive policy is incompatible');
    }
    if (raw.attemptFormat !== undefined && raw.attemptFormat !== EXTERNAL_DELIVERY_ATTEMPT_FORMAT) throw deliveryError('external_delivery_created attempt format is incompatible');
    state.sawGenesis = true;
    state.attemptTracking = raw.attemptFormat === EXTERNAL_DELIVERY_ATTEMPT_FORMAT;
    return;
  }
  if (!state.sawGenesis) throw deliveryError('the external delivery log has no valid genesis event');
  if (event.type === 'external_delivery_attempt_tracking_enabled') {
    const raw = fields(event.data, ['attemptFormat'], 'external_delivery_attempt_tracking_enabled data');
    if (raw.attemptFormat !== EXTERNAL_DELIVERY_ATTEMPT_FORMAT) throw deliveryError('external_delivery_attempt_tracking_enabled data is incompatible');
    if (state.attemptTracking) throw deliveryError('external delivery attempt tracking is already enabled');
    state.attemptTracking = true;
    return;
  }
  if (event.type === 'external_delivery_preflighted') {
    const raw = fields(event.data, ['action'], 'external_delivery_preflighted data');
    indexAction(state, restoreAction(raw.action));
    return;
  }
  if (event.type === 'external_delivery_attempted') {
    const raw = fields(event.data, ['attempt'], 'external_delivery_attempted data');
    const attemptRaw = fields(raw.attempt, ['format', 'actionId', 'attemptedAt', 'fingerprint'], 'external_delivery_attempted attempt');
    const current = state.actions.get(attemptRaw.actionId);
    if (!current) throw deliveryError(`attempt refers to missing delivery action ${JSON.stringify(attemptRaw.actionId)}`);
    if (!current.tracked) throw deliveryError('a legacy untracked action cannot gain an attempt marker');
    if (current.action.preflight.decision !== 'allow') throw deliveryError('a refused action cannot be attempted');
    if (current.attempt) throw deliveryError(`conflict: delivery action ${JSON.stringify(attemptRaw.actionId)} was already attempted`);
    if (current.settlement) throw deliveryError(`conflict: delivery action ${JSON.stringify(attemptRaw.actionId)} is already settled`);
    const attempt = restoreAttempt(raw.attempt, current.action);
    state.actions.set(attempt.actionId, deepFreeze({ ...current, attempt }));
    return;
  }
  if (event.type === 'external_delivery_settled') {
    const raw = fields(event.data, ['settlement'], 'external_delivery_settled data');
    const peek = fields(raw.settlement, settlementFields, 'external_delivery_settled settlement');
    const actionId = peek.actionId;
    const current = state.actions.get(actionId);
    if (!current) throw deliveryError(`settlement refers to missing delivery action ${JSON.stringify(actionId)}`);
    if (current.action.preflight.decision !== 'allow') throw deliveryError('a refused action cannot be settled');
    if (current.settlement) throw deliveryError(`conflict: delivery action ${JSON.stringify(actionId)} is already settled`);
    if (current.tracked && !current.attempt) {
      const outcome = peek.outcome;
      if (outcome !== 'not-sent') throw deliveryError('a tracked delivery action must be attempted before platform settlement');
    }
    const settlement = restoreSettlement(raw.settlement, current.action);
    if (settlement.outcome === 'not-sent' && !current.tracked) throw deliveryError('a legacy untracked action cannot be abandoned as not-sent');
    if (settlement.outcome === 'not-sent' && current.attempt) throw deliveryError('an attempted delivery action cannot be abandoned as not-sent');
    if (current.attempt && Date.parse(settlement.settledAt) < Date.parse(current.attempt.attemptedAt)) throw deliveryError('stored delivery settlement predates its attempt');
    state.actions.set(actionId, deepFreeze({ ...current, settlement }));
    return;
  }
  throw deliveryError(`unsupported external delivery event type ${JSON.stringify(event.type)}`);
}

function routeOwnsAction(route, action) {
  const envelope = action.envelope;
  return envelope.platform === route.platform
    && envelope.destinationId === route.destinationId
    && envelope.sourceUserId === route.sourceUserId;
}

function recoveryState(record) {
  if (!record.tracked) return 'legacy-attempted-unsettled';
  return record.attempt ? 'attempted-unsettled' : 'prepared-not-attempted';
}

function recoveryFingerprint(record) {
  return sha256(canonicalJson({
    actionFingerprint: record.action.fingerprint,
    attemptFingerprint: record.attempt?.fingerprint ?? null,
    state: recoveryState(record),
  }));
}

function recoveryProjection(record) {
  const envelope = record.action.envelope;
  return deepFreeze({
    actionId: record.action.id,
    fingerprint: recoveryFingerprint(record),
    state: recoveryState(record),
    attemptTracking: record.tracked ? 'tracked' : 'legacy-untracked',
    actionFingerprint: record.action.fingerprint,
    attemptFingerprint: record.attempt?.fingerprint ?? null,
    preparedAt: record.action.createdAt,
    attemptedAt: record.attempt?.attemptedAt ?? null,
    route: deepFreeze({
      platform: envelope.platform,
      destinationId: envelope.destinationId,
      sourceUserId: envelope.sourceUserId,
    }),
    sourceMessageId: envelope.sourceMessageId,
    source: envelope.source,
    content: envelope.content,
  });
}

async function buildStore(log, state, clock) {
  let queue = Promise.resolve();
  let closing = false;
  let closePromise = null;
  let projectionFailure = null;

  const ensureHealthy = () => { if (projectionFailure) throw projectionFailure; };
  const enqueue = (operation, mutation = false) => {
    if (closing) return Promise.reject(deliveryError(`cannot ${mutation ? 'record' : 'inspect'} after close has begun`));
    const job = queue.then(() => { ensureHealthy(); return operation(); });
    queue = job.then(() => undefined, () => undefined);
    return job;
  };
  const append = async (type, data) => {
    let event;
    try { event = await log.append(type, data); }
    catch (error) {
      if (error?.commitStatus !== 'not-written') projectionFailure ??= error;
      throw error;
    }
    try { applyEvent(event, state); }
    catch (error) {
      projectionFailure = deliveryError('a durable event was written but the live delivery projection failed; close and reopen before any further operation', error);
      throw projectionFailure;
    }
    return event;
  };

  const prepareFor = (route, input, actionKind) => enqueue(async () => {
    const raw = fields(input, ['sourceMessageId', 'output'], 'delivery preparation');
    const sourceMessageId = identifier(raw.sourceMessageId, 'delivery preparation.sourceMessageId');
    const output = normalizeBridgeOutput(raw.output);
    if (actionKind === 'bridge-reply' && !decimalId.test(sourceMessageId)) {
      throw deliveryError('delivery preparation.sourceMessageId must be a decimal platform identifier');
    }
    if (actionKind === 'bridge-proactive' && (!conversationMessageId.test(sourceMessageId)
      || output.source.kind !== 'conversation-reply'
      || output.source.messageId !== sourceMessageId)) {
      throw deliveryError('proactive delivery sourceMessageId must match its conversation reply messageId');
    }
    const planned = contentPlan(output.text, route.platform, output.source);
    const action = createAction({
      id: `delivery:${randomUUID()}`,
      createdAt: new Date(clock()).toISOString(),
      route,
      sourceMessageId,
      output,
      planned,
      action: actionKind,
    });
    if (state.sources.has(sourceKey(action.envelope))) throw deliveryError('conflict: this source message already has a delivery action');
    const reply = savedReplyKey(action.envelope);
    if (reply && state.replies.has(reply)) throw deliveryError('conflict: this saved reply already has a delivery action');
    if (!state.attemptTracking) {
      await append('external_delivery_attempt_tracking_enabled', { attemptFormat: EXTERNAL_DELIVERY_ATTEMPT_FORMAT });
    }
    await append('external_delivery_preflighted', { action });
    const plan = deepFreeze({
      actionId: action.id,
      decision: action.preflight.decision,
      chunks: deepFreeze([...planned.chunks]),
      receipt: action,
    });
    plans.add(plan);
    return plan;
  }, true);
  const prepare = (route, input) => prepareFor(route, input, 'bridge-reply');
  const prepareProactive = (route, input) => prepareFor(route, input, 'bridge-proactive');

  const beginAttempt = (route, input) => enqueue(async () => {
    const raw = fields(input, ['actionId'], 'delivery attempt');
    const actionId = identifier(raw.actionId, 'delivery attempt.actionId');
    const current = state.actions.get(actionId);
    if (!current) throw deliveryError(`no delivery action has id ${JSON.stringify(actionId)}`);
    if (!routeOwnsAction(route, current.action)) throw deliveryError('the delivery action belongs to a different route');
    if (current.action.preflight.decision !== 'allow') throw deliveryError('a refused action cannot be attempted');
    if (!current.tracked) throw deliveryError('a legacy untracked action is already conservatively classified as attempted');
    if (current.attempt) throw deliveryError(`conflict: delivery action ${JSON.stringify(actionId)} was already attempted`);
    if (current.settlement) throw deliveryError(`conflict: delivery action ${JSON.stringify(actionId)} is already settled`);
    const attempt = createAttempt(current.action, new Date(clock()).toISOString());
    await append('external_delivery_attempted', { attempt });
    return state.actions.get(actionId);
  }, true);

  const settle = (route, input) => enqueue(async () => {
    const raw = fields(input, ['actionId', 'outcome', 'failureKind', 'acknowledgements'], 'delivery settlement');
    const actionId = identifier(raw.actionId, 'delivery settlement.actionId');
    const current = state.actions.get(actionId);
    if (!current) throw deliveryError(`no delivery action has id ${JSON.stringify(actionId)}`);
    if (!routeOwnsAction(route, current.action)) throw deliveryError('the delivery action belongs to a different route');
    if (current.action.preflight.decision !== 'allow') throw deliveryError('a refused action cannot be settled');
    if (current.settlement) throw deliveryError(`conflict: delivery action ${JSON.stringify(actionId)} is already settled`);
    if (!current.tracked) throw deliveryError('a legacy untracked action can only be acknowledged as uncertain through recovery');
    if (current.tracked && !current.attempt) throw deliveryError('a tracked delivery action must begin its durable attempt before platform settlement');
    if (raw.outcome === 'not-sent' || raw.failureKind === 'operator-abandoned') {
      throw deliveryError('not-sent is reserved for conflict-safe recovery');
    }
    const settlement = createSettlement(raw, current.action, new Date(clock()).toISOString());
    await append('external_delivery_settled', { settlement });
    return state.actions.get(actionId);
  }, true);

  const unresolved = (options = {}) => enqueue(() => {
    const raw = fields(options, ['limit'], 'unresolved options');
    const limit = raw.limit ?? 32;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw deliveryError('unresolved limit must be a whole number from 1 to 256');
    }
    const items = [];
    let total = 0;
    for (let index = state.order.length - 1; index >= 0; index--) {
      const current = state.actions.get(state.order[index]);
      if (current.action.preflight.decision !== 'allow' || current.settlement) continue;
      total += 1;
      if (items.length < limit) items.push(recoveryProjection(current));
    }
    return deepFreeze({ total, hasMore: total > items.length, items: deepFreeze(items) });
  });

  const resolveRecovery = input => enqueue(async () => {
    const raw = fields(input, ['actionId', 'expectedFingerprint', 'resolution'], 'delivery recovery resolution');
    const actionId = identifier(raw.actionId, 'delivery recovery resolution.actionId');
    const expectedFingerprint = fingerprint(raw.expectedFingerprint, 'delivery recovery resolution.expectedFingerprint');
    if (!['abandon-unsent', 'acknowledge-uncertain'].includes(raw.resolution)) {
      throw deliveryError('delivery recovery resolution.resolution must be abandon-unsent or acknowledge-uncertain');
    }
    const current = state.actions.get(actionId);
    if (!current) throw deliveryError(`no delivery action has id ${JSON.stringify(actionId)}`);
    if (current.action.preflight.decision !== 'allow') throw deliveryError('a refused action has no unresolved delivery');
    if (current.settlement) throw deliveryError(`conflict: delivery action ${JSON.stringify(actionId)} is already settled`);
    if (recoveryFingerprint(current) !== expectedFingerprint) {
      throw deliveryError(`conflict: delivery action ${JSON.stringify(actionId)} changed after inspection`);
    }
    if (raw.resolution === 'abandon-unsent' && (!current.tracked || current.attempt)) {
      throw deliveryError('abandon-unsent is valid only for a tracked action with no durable attempt');
    }
    if (raw.resolution === 'acknowledge-uncertain' && current.tracked && !current.attempt) {
      throw deliveryError('acknowledge-uncertain requires a durable attempt or a legacy untracked action');
    }
    const settlement = createSettlement({
      actionId,
      outcome: raw.resolution === 'abandon-unsent' ? 'not-sent' : 'uncertain',
      failureKind: raw.resolution === 'abandon-unsent' ? 'operator-abandoned' : 'transport-uncertain',
      acknowledgements: [],
    }, current.action, new Date(clock()).toISOString());
    await append('external_delivery_settled', { settlement });
    return state.actions.get(actionId);
  }, true);

  const lookup = actionId => enqueue(() => {
    identifier(actionId, 'actionId');
    return state.actions.get(actionId) ?? null;
  });
  const forConversation = conversationId => enqueue(() => {
    identifier(conversationId, 'conversationId');
    return deepFreeze((state.conversations.get(conversationId) ?? []).map(actionId => state.actions.get(actionId)));
  });
  const recent = (limit = 32) => enqueue(() => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw deliveryError('recent limit must be a whole number from 1 to 256');
    return deepFreeze(state.order.slice(-limit).reverse().map(actionId => state.actions.get(actionId)));
  });
  const receipt = async () => {
    await queue;
    ensureHealthy();
    return log.receipt();
  };
  const close = () => {
    if (!closePromise) {
      closing = true;
      closePromise = queue.then(async () => {
        const errors = [];
        try { await log.close(); } catch (error) { errors.push(error); }
        if (projectionFailure && !errors.includes(projectionFailure)) errors.push(projectionFailure);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'External delivery close preserved durable and projection failures');
      });
    }
    return closePromise;
  };
  const store = Object.freeze({ id: log.id, lookup, forConversation, recent, unresolved, resolveRecovery, receipt, close });
  stores.add(store);
  storeInternals.set(store, { prepare, prepareProactive, beginAttempt, settle });
  return store;
}

export function isExternalDeliveryStore(value) {
  return Boolean(value) && stores.has(value);
}

export function createExternalDeliveryCoordinator(store, route, options = {}) {
  if (!isExternalDeliveryStore(store)) throw deliveryError('store must be a Fieldwork external delivery store');
  const boundRoute = routeProjection(route);
  const raw = fields(options, ['onError'], 'coordinator options');
  const onError = raw.onError ?? (() => {});
  if (typeof onError !== 'function') throw deliveryError('coordinator options.onError must be a function');
  const internal = storeInternals.get(store);
  const coordinator = Object.freeze({
    route: boundRoute,
    prepare(input) { return internal.prepare(boundRoute, input); },
    prepareProactive(input) { return internal.prepareProactive(boundRoute, input); },
    beginAttempt(input) { return internal.beginAttempt(boundRoute, input); },
    settle(input) { return internal.settle(boundRoute, input); },
    report(error) { try { onError(error); } catch { /* Diagnostics never own transport state. */ } },
  });
  coordinators.add(coordinator);
  return coordinator;
}

export function isExternalDeliveryCoordinator(value) {
  return Boolean(value) && coordinators.has(value);
}

export function isExternalDeliveryPlan(value) {
  return Boolean(value) && plans.has(value);
}

export async function createExternalDeliveryStore(file, options = {}) {
  const raw = fields(options, ['id', 'clock', 'sync'], 'create options');
  const id = raw.id === undefined ? randomUUID() : identifier(raw.id, 'create options.id');
  const clock = raw.clock ?? Date.now;
  const sync = raw.sync ?? true;
  if (typeof clock !== 'function') throw deliveryError('create options.clock must be a function');
  if (typeof sync !== 'boolean') throw deliveryError('create options.sync must be true or false');
  const state = newState();
  const log = await openDurableLog(file, {
    create: true,
    format: EXTERNAL_DELIVERY_EVENT_FORMAT,
    idField: 'deliveryStoreId',
    id,
    initial: {
      type: 'external_delivery_created',
      data: {
        actionFormat: EXTERNAL_DELIVERY_ACTION_FORMAT,
        policy: EXTERNAL_DELIVERY_POLICY,
        proactivePolicy: EXTERNAL_DELIVERY_PROACTIVE_POLICY,
        attemptFormat: EXTERNAL_DELIVERY_ATTEMPT_FORMAT,
      },
    },
    clock,
    sync,
    maxDataBytes: EXTERNAL_DELIVERY_LIMITS.eventBytes,
    maxLineBytes: EXTERNAL_DELIVERY_LIMITS.lineBytes,
  });
  state.sawGenesis = true;
  state.attemptTracking = true;
  return buildStore(log, state, clock);
}

export async function openExternalDeliveryStore(file, options = {}) {
  const raw = fields(options, ['expectedId', 'expectedHead', 'clock', 'sync'], 'open options');
  const clock = raw.clock ?? Date.now;
  const sync = raw.sync ?? true;
  if (typeof clock !== 'function') throw deliveryError('open options.clock must be a function');
  if (typeof sync !== 'boolean') throw deliveryError('open options.sync must be true or false');
  const log = await openDurableLog(file, {
    format: EXTERNAL_DELIVERY_EVENT_FORMAT,
    idField: 'deliveryStoreId',
    expectedId: raw.expectedId,
    expectedHead: raw.expectedHead,
    clock,
    sync,
    maxDataBytes: EXTERNAL_DELIVERY_LIMITS.eventBytes,
    maxLineBytes: EXTERNAL_DELIVERY_LIMITS.lineBytes,
    replay: { create: newState, apply: (state, event) => applyEvent(event, state) },
  });
  return buildStore(log, log.replayState, clock);
}
