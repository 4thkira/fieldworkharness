import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';
import { canonicalStateFile, withStateTransactionLock } from './cooperative-state-lock.mjs';

// Outside readers are scheduled, read-only reviews of an exact set of goal and
// promise records. The immutable record-id set is part of every definition, so
// a review cannot silently widen as the register grows.

export const OUTSIDE_READER_FORMAT = 'fieldwork-outside-readers/v1';
export const OUTSIDE_READER_LIMITS = Object.freeze({
  kept: 50,
  active: 12,
  versions: 50,
  receipts: 300,
  recordIds: 24,
  findings: 12,
  evidencePerFinding: 6,
  nameCharacters: 80,
  focusCharacters: 4000,
  summaryCharacters: 2000,
  referenceCharacters: 300,
  excerptCharacters: 1200,
  noteCharacters: 2000,
  providerCharacters: 300,
  sourceBytes: 256 * 1024,
  cadenceHours: Object.freeze([1, 2, 3, 4, 6, 8, 12, 24]),
  claimMinutes: 15,
  fileBytes: 2 * 1024 * 1024,
});

const READER_STATUSES = Object.freeze(['active', 'paused', 'removed']);
const RUN_OUTCOMES = Object.freeze(['source-unchanged', 'no-findings', 'findings', 'failed']);
const RECEIPT_OUTCOMES = new Set([...RUN_OUTCOMES, 'claim-expired']);
const VERSION_ACTIONS = new Set(['created', 'updated', 'paused', 'resumed', 'removed', 'restored']);
const FINDING_KINDS = new Set(['contradiction', 'broken-promise', 'unclear']);
const ACTORS = new Set(['person', 'agent', 'system']);
const idPattern = /^outside-reader-[0-9a-f-]{36}$/;
const receiptIdPattern = /^outside-reader-run-[0-9a-f-]{36}$/;
const tokenPattern = /^[0-9a-f-]{36}$/;
const recordIdPattern = /^(goal|promise)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const stores = new WeakSet();
const storeClocks = new WeakMap();

function readerError(message, status = 400, cause) {
  const error = new Error(`Outside readers: ${message}`, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function exactKeys(value, allowed, where) {
  if (!isPlainObject(value)) throw readerError(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw readerError(`${where} has unknown field ${JSON.stringify(key)}`);
  }
}

function inputObject(value, where, maxBytes = OUTSIDE_READER_LIMITS.sourceBytes) {
  try {
    return boundedJson(value, { where, object: true, maxBytes, maxDepth: 10, maxNodes: 1000 }).value;
  } catch (error) {
    throw readerError(error.message, 400, error);
  }
}

function cleanText(value, limit, what, { required = false, multiline = false } = {}) {
  if (typeof value !== 'string') throw readerError(`${what} must be text`);
  const text = multiline
    ? value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
    : value.replace(/\s+/gu, ' ').trim();
  if (required && !text) throw readerError(`${what} must not be empty`);
  if ([...text].length > limit) throw readerError(`${what} is at most ${limit} characters`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)) throw readerError(`${what} contains control characters`);
  return text;
}

function iso(value, what, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw readerError(`${what} must be an exact ISO timestamp`);
  let normalized;
  try { normalized = new Date(value).toISOString(); }
  catch { throw readerError(`${what} must be an exact ISO timestamp`); }
  if (normalized !== value) throw readerError(`${what} must be an exact ISO timestamp`);
  return value;
}

function whole(value, minimum, maximum, what) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw readerError(`${what} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

function actor(value, fallback = 'person') {
  const normalized = value ?? fallback;
  if (!ACTORS.has(normalized)) throw readerError('actor must be person, agent, or system');
  return normalized;
}

function cadence(value) {
  if (!OUTSIDE_READER_LIMITS.cadenceHours.includes(value)) {
    throw readerError(`cadenceHours must be one of ${OUTSIDE_READER_LIMITS.cadenceHours.join(', ')}`);
  }
  return value;
}

function sourceDefinition(raw) {
  exactKeys(raw, ['type', 'recordIds'], 'outside reader source');
  if (raw.type !== 'goal-record-set') throw readerError('outside reader source type must be goal-record-set');
  if (!Array.isArray(raw.recordIds) || raw.recordIds.length < 1 || raw.recordIds.length > OUTSIDE_READER_LIMITS.recordIds) {
    throw readerError(`outside reader source needs 1 to ${OUTSIDE_READER_LIMITS.recordIds} recordIds`);
  }
  const recordIds = raw.recordIds.map((value, index) => {
    if (typeof value !== 'string' || !recordIdPattern.test(value)) {
      throw readerError(`outside reader source recordIds[${index}] must be an exact goal or promise id`);
    }
    return value;
  });
  if (new Set(recordIds).size !== recordIds.length) throw readerError('outside reader source recordIds must be unique');
  const sorted = [...recordIds].sort();
  if (canonicalJson(recordIds) !== canonicalJson(sorted)) throw readerError('outside reader source recordIds must be sorted');
  return { type: 'goal-record-set', recordIds };
}

function configuration(raw, base = null) {
  exactKeys(raw, ['name', 'focus', 'cadenceHours', 'source'], 'outside reader definition');
  if (!base) {
    for (const key of ['name', 'focus', 'cadenceHours', 'source']) {
      if (!Object.hasOwn(raw, key)) throw readerError(`outside reader definition needs ${key}`);
    }
  }
  const next = base ? structuredClone(base) : {};
  if (Object.hasOwn(raw, 'name')) {
    next.name = cleanText(raw.name, OUTSIDE_READER_LIMITS.nameCharacters, 'name', { required: true });
  }
  if (Object.hasOwn(raw, 'focus')) {
    next.focus = cleanText(raw.focus, OUTSIDE_READER_LIMITS.focusCharacters, 'focus', { required: true, multiline: true });
  }
  if (Object.hasOwn(raw, 'cadenceHours')) next.cadenceHours = cadence(raw.cadenceHours);
  if (Object.hasOwn(raw, 'source')) next.source = sourceDefinition(raw.source);
  return next;
}

function configFrom(row) {
  return {
    name: row.name,
    focus: row.focus,
    cadenceHours: row.cadenceHours,
    source: structuredClone(row.source),
  };
}

function versionValue(row) {
  return deepFreeze({ ...configFrom(row), status: row.status });
}

function addVersion(row, { at, by, action }) {
  row.versions = [{ revision: row.revision, at, by, action, value: versionValue(row) }, ...row.versions]
    .slice(0, OUTSIDE_READER_LIMITS.versions);
}

function sourceReceipt(raw, where = 'source receipt') {
  exactKeys(raw, ['type', 'fingerprint', 'records', 'items', 'observedAt'], where);
  if (raw.type !== 'goal-record-set') throw readerError(`${where} type must be goal-record-set`);
  if (typeof raw.fingerprint !== 'string' || !fingerprintPattern.test(raw.fingerprint)) {
    throw readerError(`${where} fingerprint must be a lowercase SHA-256 digest`);
  }
  return {
    type: 'goal-record-set',
    fingerprint: raw.fingerprint,
    records: whole(raw.records, 0, Number.MAX_SAFE_INTEGER, `${where} records`),
    items: whole(raw.items, 0, Number.MAX_SAFE_INTEGER, `${where} items`),
    observedAt: iso(raw.observedAt, `${where} observedAt`),
  };
}

function providerValue(value, what = 'provider') {
  if (value === null) return null;
  return cleanText(value, OUTSIDE_READER_LIMITS.providerCharacters, what, { required: true });
}

function findingValue(raw, index, where = 'finding') {
  exactKeys(raw, ['kind', 'summary', 'evidence'], `${where} ${index + 1}`);
  if (!FINDING_KINDS.has(raw.kind)) throw readerError(`${where} ${index + 1} kind is invalid`);
  const summary = cleanText(raw.summary, OUTSIDE_READER_LIMITS.summaryCharacters, `${where} ${index + 1} summary`, {
    required: true,
    multiline: true,
  });
  if (!Array.isArray(raw.evidence) || raw.evidence.length < 1 || raw.evidence.length > OUTSIDE_READER_LIMITS.evidencePerFinding) {
    throw readerError(`${where} ${index + 1} needs 1 to ${OUTSIDE_READER_LIMITS.evidencePerFinding} evidence entries`);
  }
  const evidence = raw.evidence.map((item, evidenceIndex) => {
    exactKeys(item, ['ref', 'excerpt'], `${where} ${index + 1} evidence ${evidenceIndex + 1}`);
    return {
      ref: cleanText(item.ref, OUTSIDE_READER_LIMITS.referenceCharacters, `${where} evidence ref`, { required: true }),
      excerpt: cleanText(item.excerpt, OUTSIDE_READER_LIMITS.excerptCharacters, `${where} evidence excerpt`, {
        required: true,
        multiline: true,
      }),
    };
  });
  const distinctRefs = new Set(evidence.map(item => item.ref));
  if (distinctRefs.size !== evidence.length) throw readerError(`${where} ${index + 1} evidence refs must be distinct`);
  if (raw.kind === 'contradiction' && distinctRefs.size < 2) {
    throw readerError(`${where} ${index + 1} contradiction needs at least two distinct evidence refs`);
  }
  return { kind: raw.kind, summary, evidence };
}

function findingsValue(value, { required = false, where = 'findings' } = {}) {
  if (!Array.isArray(value)) throw readerError(`${where} must be an array`);
  if (value.length > OUTSIDE_READER_LIMITS.findings) {
    throw readerError(`${where} has at most ${OUTSIDE_READER_LIMITS.findings} entries`);
  }
  if (required && !value.length) throw readerError(`${where} must not be empty`);
  return value.map((item, index) => findingValue(item, index, where));
}

function outcomePayload(raw, { where = 'outside reader result' } = {}) {
  if (!RUN_OUTCOMES.includes(raw.outcome)) throw readerError(`outcome must be ${RUN_OUTCOMES.join(', ')}`);
  const hasSource = Object.hasOwn(raw, 'source');
  const hasProvider = Object.hasOwn(raw, 'provider');
  const hasFindings = Object.hasOwn(raw, 'findings');
  const hasNote = Object.hasOwn(raw, 'note');
  if (raw.outcome === 'source-unchanged') {
    if (!hasSource) throw readerError('source-unchanged needs a source receipt');
    if (!hasProvider || raw.provider !== null) throw readerError('source-unchanged requires provider null');
    if (hasFindings || hasNote) throw readerError('source-unchanged must not carry findings or a note');
    return { outcome: raw.outcome, source: sourceReceipt(raw.source, `${where} source`), provider: null };
  }
  if (raw.outcome === 'no-findings') {
    if (!hasSource) throw readerError('no-findings needs a source receipt');
    if (!hasProvider || raw.provider === null) throw readerError('no-findings needs a provider');
    if (hasNote) throw readerError('no-findings must not carry a note');
    const findings = hasFindings ? findingsValue(raw.findings, { where: `${where} findings` }) : [];
    if (findings.length) throw readerError('no-findings must carry zero findings');
    return {
      outcome: raw.outcome,
      source: sourceReceipt(raw.source, `${where} source`),
      provider: providerValue(raw.provider),
      findings: [],
    };
  }
  if (raw.outcome === 'findings') {
    if (!hasSource) throw readerError('findings needs a source receipt');
    if (!hasProvider || raw.provider === null) throw readerError('findings needs a provider');
    if (!hasFindings) throw readerError('findings needs findings');
    if (hasNote) throw readerError('findings must not carry a note');
    return {
      outcome: raw.outcome,
      source: sourceReceipt(raw.source, `${where} source`),
      provider: providerValue(raw.provider),
      findings: findingsValue(raw.findings, { required: true, where: `${where} findings` }),
    };
  }
  if (!hasNote) throw readerError('failed needs a note');
  if (hasFindings) throw readerError('failed must not carry findings');
  return {
    outcome: 'failed',
    note: cleanText(raw.note, OUTSIDE_READER_LIMITS.noteCharacters, `${where} note`, { required: true, multiline: true }),
    ...(hasSource ? { source: sourceReceipt(raw.source, `${where} source`) } : {}),
    ...(hasProvider ? { provider: providerValue(raw.provider) } : {}),
  };
}

function publicReceipt(receipt) {
  return structuredClone(receipt);
}

function publicReader(row, state, at) {
  const claim = state.claims.find(item => item.readerId === row.id && Date.parse(item.expiresAt) > at.getTime());
  const latest = state.receipts.find(item => item.readerId === row.id);
  return {
    id: row.id,
    revision: row.revision,
    ...configFrom(row),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    removedAt: row.removedAt,
    running: Boolean(claim),
    claimExpiresAt: claim?.expiresAt ?? null,
    lastReceipt: latest ? publicReceipt(latest) : null,
  };
}

function versionFromSaved(raw) {
  exactKeys(raw, ['revision', 'at', 'by', 'action', 'value'], 'saved version');
  if (!VERSION_ACTIONS.has(raw.action)) throw readerError('saved version action is invalid');
  exactKeys(raw.value, ['name', 'focus', 'cadenceHours', 'source', 'status'], 'saved version value');
  if (!READER_STATUSES.includes(raw.value.status)) throw readerError('saved version status is invalid');
  return {
    revision: whole(raw.revision, 1, Number.MAX_SAFE_INTEGER, 'saved version revision'),
    at: iso(raw.at, 'saved version at'),
    by: actor(raw.by),
    action: raw.action,
    value: {
      ...configuration({
        name: raw.value.name,
        focus: raw.value.focus,
        cadenceHours: raw.value.cadenceHours,
        source: raw.value.source,
      }),
      status: raw.value.status,
    },
  };
}

function readerFromSaved(raw) {
  exactKeys(raw, [
    'id', 'revision', 'name', 'focus', 'cadenceHours', 'source', 'status', 'createdAt', 'updatedAt',
    'lastRunAt', 'nextRunAt', 'removedAt', 'versions',
  ], 'saved outside reader');
  if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw readerError('saved outside reader id is invalid');
  if (!READER_STATUSES.includes(raw.status)) throw readerError('saved outside reader status is invalid');
  if (!Array.isArray(raw.versions) || !raw.versions.length || raw.versions.length > OUTSIDE_READER_LIMITS.versions) {
    throw readerError('saved outside reader versions are invalid');
  }
  const row = {
    id: raw.id,
    revision: whole(raw.revision, 1, Number.MAX_SAFE_INTEGER, 'saved outside reader revision'),
    ...configuration({ name: raw.name, focus: raw.focus, cadenceHours: raw.cadenceHours, source: raw.source }),
    status: raw.status,
    createdAt: iso(raw.createdAt, 'saved outside reader createdAt'),
    updatedAt: iso(raw.updatedAt, 'saved outside reader updatedAt'),
    lastRunAt: iso(raw.lastRunAt, 'saved outside reader lastRunAt', { nullable: true }),
    nextRunAt: iso(raw.nextRunAt, 'saved outside reader nextRunAt', { nullable: true }),
    removedAt: iso(raw.removedAt, 'saved outside reader removedAt', { nullable: true }),
    versions: raw.versions.map(versionFromSaved),
  };
  if (row.versions[0].revision !== row.revision) throw readerError('saved outside reader latest version does not match its revision');
  if (canonicalJson(row.versions[0].value) !== canonicalJson(versionValue(row))) {
    throw readerError('saved outside reader latest version does not match its value');
  }
  if ((row.status === 'active') !== Boolean(row.nextRunAt)) {
    throw readerError('saved outside reader nextRunAt is inconsistent with its status');
  }
  if ((row.status === 'removed') !== Boolean(row.removedAt)) {
    throw readerError('saved outside reader removedAt is inconsistent with its status');
  }
  return row;
}

function receiptFromSaved(raw, knownIds) {
  exactKeys(raw, [
    'id', 'readerId', 'at', 'outcome', 'runKind', 'definitionRevision', 'claimedAt',
    'source', 'provider', 'findings', 'note',
  ], 'saved receipt');
  if (typeof raw.id !== 'string' || !receiptIdPattern.test(raw.id)) throw readerError('saved receipt id is invalid');
  if (!knownIds.has(raw.readerId)) throw readerError('saved receipt names an unknown outside reader');
  if (!RECEIPT_OUTCOMES.has(raw.outcome)) throw readerError('saved receipt outcome is invalid');
  if (!['scheduled', 'manual'].includes(raw.runKind)) throw readerError('saved receipt runKind is invalid');
  const base = {
    id: raw.id,
    readerId: raw.readerId,
    at: iso(raw.at, 'saved receipt at'),
    outcome: raw.outcome,
    runKind: raw.runKind,
    definitionRevision: whole(raw.definitionRevision, 1, Number.MAX_SAFE_INTEGER, 'saved receipt definitionRevision'),
    claimedAt: iso(raw.claimedAt, 'saved receipt claimedAt'),
  };
  if (raw.outcome === 'claim-expired') {
    if (['source', 'provider', 'findings', 'note'].some(key => Object.hasOwn(raw, key))) {
      throw readerError('saved claim-expired receipt has result fields');
    }
    if (Date.parse(base.at) < Date.parse(base.claimedAt)) throw readerError('saved receipt predates its claim');
    return base;
  }
  const payload = outcomePayload(raw, { where: 'saved receipt' });
  if (Date.parse(base.at) < Date.parse(base.claimedAt)) throw readerError('saved receipt predates its claim');
  if (payload.source) {
    const observed = Date.parse(payload.source.observedAt);
    if (observed < Date.parse(base.claimedAt) || observed > Date.parse(base.at)) {
      throw readerError('saved source observedAt must fall within its run');
    }
  }
  return { ...base, ...payload };
}

function claimFromSaved(raw, knownIds) {
  exactKeys(raw, ['readerId', 'token', 'claimedAt', 'expiresAt', 'runKind', 'definitionRevision'], 'saved claim');
  if (!knownIds.has(raw.readerId)) throw readerError('saved claim names an unknown outside reader');
  if (typeof raw.token !== 'string' || !tokenPattern.test(raw.token)) throw readerError('saved claim token is invalid');
  if (!['scheduled', 'manual'].includes(raw.runKind)) throw readerError('saved claim runKind is invalid');
  const claim = {
    readerId: raw.readerId,
    token: raw.token,
    claimedAt: iso(raw.claimedAt, 'saved claim claimedAt'),
    expiresAt: iso(raw.expiresAt, 'saved claim expiresAt'),
    runKind: raw.runKind,
    definitionRevision: whole(raw.definitionRevision, 1, Number.MAX_SAFE_INTEGER, 'saved claim definitionRevision'),
  };
  if (Date.parse(claim.expiresAt) <= Date.parse(claim.claimedAt)) throw readerError('saved claim expiry is invalid');
  return claim;
}

function encodedState(value, { removedReceipts = new Set(), removedVersions = new Set() } = {}) {
  const projected = removedReceipts.size || removedVersions.size
    ? {
        ...value,
        readers: removedVersions.size
          ? value.readers.map(row => ({ ...row, versions: row.versions.filter(version => !removedVersions.has(version)) }))
          : value.readers,
        receipts: removedReceipts.size
          ? value.receipts.filter(receipt => !removedReceipts.has(receipt))
          : value.receipts,
      }
    : value;
  return `${JSON.stringify(projected)}\n`;
}

function fitsSavedFile(source) {
  return Buffer.byteLength(source) <= OUTSIDE_READER_LIMITS.fileBytes;
}

function minimumRemoval(candidates, sourceAfterRemoving) {
  let low = 1;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fitsSavedFile(sourceAfterRemoving(middle))) high = middle;
    else low = middle + 1;
  }
  return low;
}

function prepareStateForWrite(value) {
  let source = encodedState(value);
  if (fitsSavedFile(source)) return source;

  // Receipts are derived run history. Retain the newest evidence first, with
  // stable IDs breaking timestamp ties, before touching definition history.
  const receiptCandidates = [...value.receipts]
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  if (receiptCandidates.length) {
    const sourceAfterRemoving = count => encodedState(value, {
      removedReceipts: new Set(receiptCandidates.slice(0, count)),
    });
    const withoutReceipts = sourceAfterRemoving(receiptCandidates.length);
    if (fitsSavedFile(withoutReceipts)) {
      const removeCount = minimumRemoval(receiptCandidates, sourceAfterRemoving);
      const removed = new Set(receiptCandidates.slice(0, removeCount));
      value.receipts = value.receipts.filter(receipt => !removed.has(receipt));
      source = encodedState(value);
      if (fitsSavedFile(source)) return source;
    } else {
      value.receipts = [];
      source = encodedState(value);
    }
  }

  if (fitsSavedFile(source)) return source;

  // Every reader keeps versions[0], which is the conflict token and exact
  // current definition. Only older versions may yield to the durable byte
  // ceiling, globally oldest first and with deterministic tie-breakers.
  const versionCandidates = value.readers
    .flatMap(row => row.versions.slice(1).map((version, index) => ({ row, version, index: index + 1 })))
    .sort((left, right) => (
      left.version.at.localeCompare(right.version.at)
      || left.row.id.localeCompare(right.row.id)
      || left.version.revision - right.version.revision
      || right.index - left.index
    ));
  if (versionCandidates.length) {
    const sourceAfterRemoving = count => encodedState(value, {
      removedVersions: new Set(versionCandidates.slice(0, count).map(candidate => candidate.version)),
    });
    const withoutHistory = sourceAfterRemoving(versionCandidates.length);
    if (fitsSavedFile(withoutHistory)) {
      const removeCount = minimumRemoval(versionCandidates, sourceAfterRemoving);
      const removed = new Set(versionCandidates.slice(0, removeCount).map(candidate => candidate.version));
      for (const row of value.readers) row.versions = row.versions.filter(version => !removed.has(version));
      source = encodedState(value);
      if (fitsSavedFile(source)) return source;
    }
  }

  throw readerError('the current outside reader state is too large to save', 409);
}

async function atomicWrite(file, value) {
  const source = prepareStateForWrite(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, source, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function emptyOutsideReaderState() {
  return { format: OUTSIDE_READER_FORMAT, revision: 0, readers: [], receipts: [], claims: [] };
}

async function readOutsideReaderState(file) {
  try {
    const source = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(source) > OUTSIDE_READER_LIMITS.fileBytes) throw readerError('saved file is too large', 500);
    const saved = parseJsonNoDuplicates(source, { where: 'outside reader file', maxDepth: 14 });
    exactKeys(saved, ['format', 'revision', 'readers', 'receipts', 'claims'], 'saved outside reader file');
    if (saved.format !== OUTSIDE_READER_FORMAT) throw readerError(`saved format must be ${OUTSIDE_READER_FORMAT}`, 500);
    if (!Array.isArray(saved.readers) || saved.readers.length > OUTSIDE_READER_LIMITS.kept) {
      throw readerError('saved outside readers are invalid', 500);
    }
    const readers = saved.readers.map(readerFromSaved);
    const ids = new Set(readers.map(row => row.id));
    if (ids.size !== readers.length) throw readerError('saved outside reader ids repeat', 500);
    const liveNames = readers.filter(row => row.status !== 'removed').map(row => row.name.toLocaleLowerCase('en-US'));
    if (new Set(liveNames).size !== liveNames.length) throw readerError('saved live outside reader names repeat', 500);
    if (readers.filter(row => row.status !== 'removed').length > OUTSIDE_READER_LIMITS.active) {
      throw readerError('saved live outside readers exceed the limit', 500);
    }
    if (!Array.isArray(saved.receipts) || saved.receipts.length > OUTSIDE_READER_LIMITS.receipts) {
      throw readerError('saved receipts are invalid', 500);
    }
    if (!Array.isArray(saved.claims) || saved.claims.length > OUTSIDE_READER_LIMITS.kept) {
      throw readerError('saved claims are invalid', 500);
    }
    const receipts = saved.receipts.map(row => receiptFromSaved(row, ids));
    if (new Set(receipts.map(row => row.id)).size !== receipts.length) throw readerError('saved receipt ids repeat', 500);
    const claims = saved.claims.map(row => claimFromSaved(row, ids));
    if (new Set(claims.map(row => row.readerId)).size !== claims.length) {
      throw readerError('saved claims repeat an outside reader', 500);
    }
    for (const claim of claims) {
      if (readers.find(row => row.id === claim.readerId)?.status === 'removed') {
        throw readerError('saved removed outside reader has a claim', 500);
      }
    }
    return {
      format: OUTSIDE_READER_FORMAT,
      revision: whole(saved.revision, 0, Number.MAX_SAFE_INTEGER, 'saved revision'),
      readers,
      receipts,
      claims,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyOutsideReaderState();
    throw error.message?.startsWith('Outside readers:') ? error : readerError('could not read the saved file', 500, error);
  }
}

export async function createOutsideReaderStore({ file, clock = () => new Date(), claimMinutes = OUTSIDE_READER_LIMITS.claimMinutes } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw readerError('file must be an absolute path', 500);
  if (typeof clock !== 'function') throw readerError('clock must be a function', 500);
  whole(claimMinutes, 1, 60, 'claimMinutes');
  const atNow = () => {
    const date = new Date(clock());
    if (Number.isNaN(date.getTime())) throw readerError('clock returned an invalid date', 500);
    return date;
  };
  const stateFile = await canonicalStateFile(file);
  let state = await withStateTransactionLock(stateFile, () => readOutsideReaderState(stateFile));

  const save = draft => atomicWrite(stateFile, draft);
  const freeze = value => deepFreeze(structuredClone(value));
  let queue = Promise.resolve();
  const serial = operation => {
    const job = queue.then(async () => {
      const committed = await withStateTransactionLock(stateFile, async () => {
        const latest = await readOutsideReaderState(stateFile);
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
    const row = draft.readers.find(item => item.id === id);
    if (!row) throw readerError('no outside reader has that id', 404);
    return row;
  };
  const claimFor = (draft, id) => draft.claims.find(item => item.readerId === id) ?? null;
  const requireRevision = (row, expected) => {
    if (row.revision !== expected) {
      throw readerError(`outside reader changed since it was read; expected revision ${expected}, current revision ${row.revision}`, 409);
    }
  };
  const uniqueName = (draft, name, except = null) => {
    if (draft.readers.some(row => row.id !== except && row.status !== 'removed' && row.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) {
      throw readerError('another active outside reader already has that name', 409);
    }
  };
  const addReceipt = (draft, value) => {
    const row = { id: `outside-reader-run-${randomUUID()}`, ...value };
    draft.receipts = [row, ...draft.receipts].slice(0, OUTSIDE_READER_LIMITS.receipts);
    return row;
  };
  const reapExpired = (draft, at) => {
    const expired = draft.claims.filter(item => Date.parse(item.expiresAt) <= at.getTime());
    if (!expired.length) return false;
    for (const claim of expired) {
      addReceipt(draft, {
        readerId: claim.readerId,
        at: at.toISOString(),
        outcome: 'claim-expired',
        runKind: claim.runKind,
        definitionRevision: claim.definitionRevision,
        claimedAt: claim.claimedAt,
      });
      const reader = draft.readers.find(item => item.id === claim.readerId);
      if (reader?.status === 'active') {
        reader.nextRunAt = new Date(at.getTime() + reader.cadenceHours * 3_600_000).toISOString();
      }
    }
    const expiredIds = new Set(expired.map(item => item.readerId));
    draft.claims = draft.claims.filter(item => !expiredIds.has(item.readerId));
    return true;
  };
  const editInput = (value, action) => {
    const raw = inputObject(value, `outside reader ${action}`);
    exactKeys(raw, ['id', 'expectedRevision', 'actor'], `outside reader ${action}`);
    if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw readerError(`${action} needs an outside reader id`);
    return {
      id: raw.id,
      expectedRevision: whole(raw.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision'),
      by: actor(raw.actor),
    };
  };
  const viewAt = at => deepFreeze({
    format: OUTSIDE_READER_FORMAT,
    revision: state.revision,
    choices: {
      cadenceHours: OUTSIDE_READER_LIMITS.cadenceHours,
      findingKinds: Object.freeze([...FINDING_KINDS]),
    },
    readers: state.readers.map(row => publicReader(row, state, at)),
  });

  const store = Object.freeze({
    view() { return viewAt(atNow()); },

    inspect(id) {
      if (typeof id !== 'string' || !idPattern.test(id)) throw readerError('inspect needs an outside reader id');
      const row = state.readers.find(item => item.id === id);
      if (!row) throw readerError('no outside reader has that id', 404);
      const at = atNow();
      return deepFreeze({
        format: OUTSIDE_READER_FORMAT,
        reader: publicReader(row, state, at),
        versions: structuredClone(row.versions),
        receipts: state.receipts.filter(item => item.readerId === id).map(publicReceipt),
      });
    },

    create(value) {
      const raw = inputObject(value, 'outside reader create');
      exactKeys(raw, ['definition', 'actor'], 'outside reader create');
      const definition = configuration(inputObject(raw.definition, 'outside reader definition'));
      const by = actor(raw.actor);
      const id = `outside-reader-${randomUUID()}`;
      return serial(draft => {
        if (draft.readers.length >= OUTSIDE_READER_LIMITS.kept) {
          throw readerError(`at most ${OUTSIDE_READER_LIMITS.kept} outside readers are kept`, 409);
        }
        if (draft.readers.filter(row => row.status !== 'removed').length >= OUTSIDE_READER_LIMITS.active) {
          throw readerError(`at most ${OUTSIDE_READER_LIMITS.active} active or paused outside readers are kept`, 409);
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
          removedAt: null,
          versions: [],
        };
        addVersion(row, { at: row.updatedAt, by, action: 'created' });
        draft.readers.unshift(row);
        return { changed: true, value: publicReader(row, draft, at) };
      });
    },

    update(value) {
      const raw = inputObject(value, 'outside reader update');
      exactKeys(raw, ['id', 'expectedRevision', 'changes', 'actor'], 'outside reader update');
      if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw readerError('update needs an outside reader id');
      const expected = whole(raw.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
      const changes = inputObject(raw.changes, 'outside reader definition changes');
      if (!Object.keys(changes).length) throw readerError('outside reader definition changes must not be empty');
      const by = actor(raw.actor);
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, raw.id);
        requireRevision(row, expected);
        if (row.status === 'removed') throw readerError('restore this outside reader before editing it', 409);
        if (claimFor(draft, row.id)) throw readerError('a running outside reader cannot be edited', 409);
        const before = configFrom(row);
        const next = configuration(changes, before);
        uniqueName(draft, next.name, row.id);
        if (canonicalJson(before) === canonicalJson(next)) {
          return { changed: reaped, value: publicReader(row, draft, at) };
        }
        const cadenceChanged = row.cadenceHours !== next.cadenceHours;
        Object.assign(row, next, { revision: row.revision + 1, updatedAt: at.toISOString() });
        if (row.status === 'active' && cadenceChanged) {
          row.nextRunAt = new Date(at.getTime() + row.cadenceHours * 3_600_000).toISOString();
        }
        addVersion(row, { at: row.updatedAt, by, action: 'updated' });
        return { changed: true, value: publicReader(row, draft, at) };
      });
    },

    pause(value) {
      const edit = editInput(value, 'pause');
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'paused') return { changed: reaped, value: publicReader(row, draft, at) };
        if (row.status !== 'active') throw readerError('only an active outside reader can be paused', 409);
        Object.assign(row, { status: 'paused', revision: row.revision + 1, updatedAt: at.toISOString(), nextRunAt: null });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'paused' });
        return { changed: true, value: publicReader(row, draft, at) };
      });
    },

    resume(value) {
      const edit = editInput(value, 'resume');
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'active') return { changed: reaped, value: publicReader(row, draft, at) };
        if (row.status !== 'paused') throw readerError('only a paused outside reader can be resumed', 409);
        Object.assign(row, {
          status: 'active',
          revision: row.revision + 1,
          updatedAt: at.toISOString(),
          nextRunAt: new Date(at.getTime() + row.cadenceHours * 3_600_000).toISOString(),
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'resumed' });
        return { changed: true, value: publicReader(row, draft, at) };
      });
    },

    remove(value) {
      const edit = editInput(value, 'remove');
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status === 'removed') return { changed: reaped, value: publicReader(row, draft, at) };
        if (claimFor(draft, row.id)) {
          throw readerError('a running outside reader cannot be removed; pause it and wait for the run to finish', 409);
        }
        Object.assign(row, {
          status: 'removed',
          revision: row.revision + 1,
          updatedAt: at.toISOString(),
          nextRunAt: null,
          removedAt: at.toISOString(),
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'removed' });
        return { changed: true, value: publicReader(row, draft, at) };
      });
    },

    restore(value) {
      const edit = editInput(value, 'restore');
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, edit.id);
        requireRevision(row, edit.expectedRevision);
        if (row.status !== 'removed') throw readerError('only a removed outside reader can be restored', 409);
        uniqueName(draft, row.name, row.id);
        if (draft.readers.filter(item => item.status !== 'removed').length >= OUTSIDE_READER_LIMITS.active) {
          throw readerError(`at most ${OUTSIDE_READER_LIMITS.active} active or paused outside readers are kept`, 409);
        }
        Object.assign(row, {
          status: 'paused',
          revision: row.revision + 1,
          updatedAt: at.toISOString(),
          nextRunAt: null,
          removedAt: null,
        });
        addVersion(row, { at: row.updatedAt, by: edit.by, action: 'restored' });
        return { changed: true, value: publicReader(row, draft, at) };
      });
    },

    claimDue() {
      return serial(draft => {
        const at = atNow();
        let changed = reapExpired(draft, at);
        const claimed = new Set(draft.claims.map(item => item.readerId));
        const row = draft.readers
          .filter(item => item.status === 'active' && item.nextRunAt && Date.parse(item.nextRunAt) <= at.getTime() && !claimed.has(item.id))
          .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt) || left.createdAt.localeCompare(right.createdAt))[0];
        if (!row) return { changed, value: { started: false, reason: 'not due' } };
        const claim = {
          readerId: row.id,
          token: randomUUID(),
          claimedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + claimMinutes * 60_000).toISOString(),
          runKind: 'scheduled',
          definitionRevision: row.revision,
        };
        draft.claims.push(claim);
        changed = true;
        return { changed, value: { started: true, claim, reader: publicReader(row, draft, at) } };
      });
    },

    claimNow(id) {
      if (typeof id !== 'string' || !idPattern.test(id)) return Promise.reject(readerError('run now needs an outside reader id'));
      return serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, id);
        if (row.status === 'removed') return { changed: reaped, value: { started: false, reason: 'removed' } };
        if (claimFor(draft, row.id)) return { changed: reaped, value: { started: false, reason: 'claimed' } };
        const claim = {
          readerId: row.id,
          token: randomUUID(),
          claimedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + claimMinutes * 60_000).toISOString(),
          runKind: 'manual',
          definitionRevision: row.revision,
        };
        draft.claims.push(claim);
        return { changed: true, value: { started: true, claim, reader: publicReader(row, draft, at) } };
      });
    },

    async finish(value) {
      const raw = inputObject(value, 'outside reader finish', 256 * 1024);
      exactKeys(raw, ['id', 'claimToken', 'outcome', 'source', 'provider', 'findings', 'note'], 'outside reader finish');
      if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) throw readerError('finish needs an outside reader id');
      if (typeof raw.claimToken !== 'string' || !tokenPattern.test(raw.claimToken)) {
        throw readerError('finish needs the exact claim token');
      }
      const payload = outcomePayload(raw);
      const validationTime = atNow();
      if (payload.source && Date.parse(payload.source.observedAt) > validationTime.getTime()) {
        throw readerError('source observedAt must not be in the future');
      }
      const result = await serial(draft => {
        const at = atNow();
        const reaped = reapExpired(draft, at);
        const row = find(draft, raw.id);
        const index = draft.claims.findIndex(item => item.readerId === row.id && item.token === raw.claimToken);
        if (index < 0) return { changed: reaped, value: { stale: true } };
        const claim = draft.claims[index];
        if (payload.source && Date.parse(payload.source.observedAt) < Date.parse(claim.claimedAt)) {
          throw readerError('source observedAt must not predate the claim');
        }
        draft.claims.splice(index, 1);
        row.lastRunAt = at.toISOString();
        row.nextRunAt = row.status === 'active'
          ? new Date(at.getTime() + row.cadenceHours * 3_600_000).toISOString()
          : null;
        const savedReceipt = addReceipt(draft, {
          readerId: row.id,
          at: at.toISOString(),
          runKind: claim.runKind,
          definitionRevision: claim.definitionRevision,
          claimedAt: claim.claimedAt,
          ...payload,
        });
        return {
          changed: true,
          value: { stale: false, receipt: publicReceipt(savedReceipt), reader: publicReader(row, draft, at) },
        };
      });
      if (result.stale) throw readerError('that outside reader claim expired or was already finished', 409);
      return result;
    },
  });
  stores.add(store);
  storeClocks.set(store, atNow);
  return store;
}

function runnerResult(value) {
  const raw = inputObject(value, 'outside reader runner result', 256 * 1024);
  exactKeys(raw, ['outcome', 'source', 'provider', 'findings', 'note'], 'outside reader runner result');
  return outcomePayload(raw, { where: 'outside reader runner result' });
}

// The durable claim is the same-store, cross-wake fence; the local flag
// prevents two ticks from this scheduler entering the provider concurrently.
// The room host separately enforces one writer process per agent home.
export function startOutsideReaderScheduler({ store, run, canRun = () => true, everyMs = 60_000, onError = () => {}, onPersist } = {}) {
  if (!stores.has(store)) throw readerError('store must come from createOutsideReaderStore()', 500);
  if (typeof run !== 'function') throw readerError('run must be a function', 500);
  if (typeof canRun !== 'function' || typeof onError !== 'function') {
    throw readerError('canRun and onError must be functions', 500);
  }
  if (onPersist !== undefined && typeof onPersist !== 'function') throw readerError('onPersist must be a function', 500);
  if (!Number.isSafeInteger(everyMs) || everyMs < 10) throw readerError('everyMs must be at least 10', 500);
  let stopped = false;
  let running = false;
  let runningId = null;
  let current = null;

  const start = async (id = null) => {
    if (stopped || running) return { started: false, reason: stopped ? 'stopped' : 'busy' };
    if (!canRun()) return { started: false, reason: 'busy' };
    running = true;
    const work = (async () => {
      try {
        const claim = id ? await store.claimNow(id) : await store.claimDue();
        if (!claim.started) return claim;
        runningId = claim.reader.id;
        let result;
        let runSucceeded = true;
        try {
          result = await run(claim.reader);
        } catch (error) {
          runSucceeded = false;
          try { onError(error); } catch { /* diagnostics never replace the receipt */ }
          result = { outcome: 'failed', note: 'The outside reader could not finish.' };
        }
        if (runSucceeded) {
          try {
            result = runnerResult(result);
            if (result.source) {
              const observed = Date.parse(result.source.observedAt);
              if (observed < Date.parse(claim.claim.claimedAt) || observed > storeClocks.get(store)().getTime()) {
                throw readerError('runner source observedAt must fall within its run');
              }
            }
          } catch {
            runSucceeded = false;
            result = { outcome: 'failed', note: 'The outside reader returned an invalid result.' };
          }
        }
        let finished;
        let persistError = null;
        try {
          finished = await store.finish({
            id: claim.reader.id,
            claimToken: claim.claim.token,
            ...result,
          });
        } catch (error) {
          persistError = error;
        }
        try {
          await onPersist?.(Object.freeze({
            id: claim.reader.id,
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
        return { started: true, readerId: claim.reader.id, ...finished };
      } finally {
        runningId = null;
        running = false;
        current = null;
      }
    })();
    current = work;
    return work;
  };
  const timer = setInterval(() => {
    void start().catch(error => { try { onError(error); } catch { /* keep the timer alive */ } });
  }, everyMs);
  timer.unref?.();
  return Object.freeze({
    get running() { return running; },
    get runningId() { return runningId; },
    tick: () => start(),
    now: id => start(id),
    wait: () => current ?? Promise.resolve(),
    stop() { stopped = true; clearInterval(timer); },
  });
}
