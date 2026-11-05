import { createHash } from 'node:crypto';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';
import { isMemoryLifecycle, normalizeMemoryLifecycle } from './memory-lifecycle.mjs';

export const SOURCE_REFERENCE_FORMAT = 'fieldwork-source-reference/v2';
export const RETRIEVED_EVIDENCE_FORMAT = 'fieldwork-retrieved-evidence/v1';
export const MEMORY_RECORD_FORMAT = 'fieldwork-memory-record/v1';

export const SOURCE_KINDS = Object.freeze(['conversation', 'run-event', 'document', 'memory']);
export const MEMORY_KINDS = Object.freeze(['observation', 'authored-memory', 'summary']);
export const MEMORY_BASES = Object.freeze(['source-backed', 'inferred', 'self-authored']);
export const MEMORY_CONFIDENCE = Object.freeze(['uncertain', 'tentative', 'supported', 'asserted']);

const sourceReferences = new WeakSet();
const retrievedEvidence = new WeakSet();
const memoryRecords = new WeakSet();
const LEGACY_SOURCE_REFERENCE_FORMAT = 'fieldwork-source-reference/v1';
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const portableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[0-9a-f]{64}$/;

function provenanceError(message) {
  return new Error(`Provenance: ${message}`);
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw provenanceError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw provenanceError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw provenanceError(`${where}.${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function text(value, where, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw provenanceError(`${where} must be nonempty text`);
  const characters = [...value].length;
  if (characters > maximum) throw provenanceError(`${where} contains ${characters} characters; the limit is ${maximum}`);
  return value;
}

function instant(value, where) {
  if (typeof value !== 'string') throw provenanceError(`${where} must be an ISO timestamp`);
  let normalized = '';
  try { normalized = new Date(value).toISOString(); } catch { /* Rejected below. */ }
  if (normalized !== value) throw provenanceError(`${where} must be an exact ISO timestamp`);
  return value;
}

function actor(value) {
  let normalized;
  try { normalized = boundedJson(value, { where: 'author', object: true, maxBytes: 2048 }).value; }
  catch (error) { throw provenanceError(error.message); }
  const raw = fields(normalized, ['kind', 'id'], 'author');
  if (!['agent', 'operator', 'system', 'model'].includes(raw.kind)) throw provenanceError('author.kind must be agent, operator, system or model');
  text(raw.id, 'author.id', 200);
  return deepFreeze({ kind: raw.kind, id: raw.id });
}

function fingerprint(value) {
  return sha256(canonicalJson(value));
}

export function isSourceReference(value) {
  return Boolean(value) && sourceReferences.has(value);
}

export function isRetrievedEvidence(value) {
  return Boolean(value) && retrievedEvidence.has(value);
}

export function isMemoryRecord(value) {
  return Boolean(value) && memoryRecords.has(value);
}

function sourceReference(raw, format) {
  if (!SOURCE_KINDS.includes(raw.kind)) throw provenanceError(`source reference.kind must be one of ${SOURCE_KINDS.join(', ')}`);
  text(raw.id, 'source reference.id', 512);
  if (/[\u0000-\u001f\u007f]/u.test(raw.id) || raw.id !== raw.id.trim()) throw provenanceError('source reference.id may not contain control or surrounding whitespace');
  if (raw.locator !== undefined) {
    text(raw.locator, 'source reference.locator', 512);
    if (/[\u0000-\u001f\u007f]/u.test(raw.locator)) throw provenanceError('source reference.locator may not contain control characters');
  }
  if (typeof raw.sha256 !== 'string' || !hashPattern.test(raw.sha256)) throw provenanceError('source reference.sha256 must be a lowercase SHA-256 hash');
  if (format === LEGACY_SOURCE_REFERENCE_FORMAT && raw.observedThrough !== undefined) {
    throw provenanceError('stored v1 source references may not declare observedThrough');
  }
  const observedThrough = raw.observedThrough === undefined
    ? undefined
    : instant(raw.observedThrough, 'source reference.observedThrough');
  const base = {
    format,
    kind: raw.kind,
    id: raw.id,
    ...(raw.locator === undefined ? {} : { locator: raw.locator }),
    sha256: raw.sha256,
    ...(observedThrough === undefined ? {} : { observedThrough }),
  };
  const reference = deepFreeze({ ...base, fingerprint: fingerprint(base) });
  sourceReferences.add(reference);
  return reference;
}

export function createSourceReference(input) {
  let normalized;
  try { normalized = boundedJson(input, { where: 'source reference', object: true, maxBytes: 8192 }).value; }
  catch (error) { throw provenanceError(error.message); }
  const raw = fields(normalized, ['kind', 'id', 'locator', 'sha256', 'observedThrough'], 'source reference');
  return sourceReference(raw, SOURCE_REFERENCE_FORMAT);
}

export function restoreSourceReference(input) {
  let normalized;
  try { normalized = boundedJson(input, { where: 'stored source reference', object: true, maxBytes: 16 * 1024 }).value; }
  catch (error) { throw provenanceError(error.message); }
  const raw = fields(normalized, ['format', 'kind', 'id', 'locator', 'sha256', 'observedThrough', 'fingerprint'], 'stored source reference');
  if (![SOURCE_REFERENCE_FORMAT, LEGACY_SOURCE_REFERENCE_FORMAT].includes(raw.format)) {
    throw provenanceError(`stored source reference.format must be ${SOURCE_REFERENCE_FORMAT} or ${LEGACY_SOURCE_REFERENCE_FORMAT}`);
  }
  if (typeof raw.fingerprint !== 'string' || !hashPattern.test(raw.fingerprint)) throw provenanceError('stored source reference.fingerprint must be a lowercase SHA-256 hash');
  const restored = sourceReference({
    kind: raw.kind, id: raw.id,
    ...(raw.locator === undefined ? {} : { locator: raw.locator }),
    sha256: raw.sha256,
    ...(raw.observedThrough === undefined ? {} : { observedThrough: raw.observedThrough }),
  }, raw.format);
  if (restored.fingerprint !== raw.fingerprint) throw provenanceError('stored source reference fingerprint does not match its contents');
  return restored;
}

export function createRetrievedEvidence(input) {
  const raw = fields(input, ['source', 'excerpt', 'retrievedAt', 'retrieval'], 'retrieved evidence');
  if (!isSourceReference(raw.source)) throw provenanceError('retrieved evidence.source must be created by createSourceReference()');
  const excerpt = text(raw.excerpt, 'retrieved evidence.excerpt', 16_000);
  const retrievedAt = instant(raw.retrievedAt, 'retrieved evidence.retrievedAt');
  let retrieval;
  try { retrieval = boundedJson(raw.retrieval, { where: 'retrieved evidence.retrieval', object: true, maxBytes: 4096 }).value; }
  catch (error) { throw provenanceError(error.message); }
  const retrievalFields = fields(retrieval, ['method', 'queryHash', 'rank', 'score'], 'retrieved evidence.retrieval');
  if (!['exact', 'lexical', 'semantic', 'graph', 'manual'].includes(retrievalFields.method)) throw provenanceError('retrieval.method is not supported');
  if (typeof retrievalFields.queryHash !== 'string' || !hashPattern.test(retrievalFields.queryHash)) throw provenanceError('retrieval.queryHash must be a lowercase SHA-256 hash');
  if (!Number.isSafeInteger(retrievalFields.rank) || retrievalFields.rank < 1 || retrievalFields.rank > 10_000) throw provenanceError('retrieval.rank must be a whole number from 1 to 10000');
  if (retrievalFields.score !== undefined && (typeof retrievalFields.score !== 'number' || !Number.isFinite(retrievalFields.score) || retrievalFields.score < 0 || retrievalFields.score > 1)) {
    throw provenanceError('retrieval.score must be a finite number from 0 to 1');
  }
  retrieval = deepFreeze({
    method: retrievalFields.method,
    queryHash: retrievalFields.queryHash,
    rank: retrievalFields.rank,
    ...(retrievalFields.score === undefined ? {} : { score: retrievalFields.score }),
  });
  const base = {
    format: RETRIEVED_EVIDENCE_FORMAT,
    type: 'retrieved-evidence',
    source: raw.source,
    excerpt,
    retrievedAt,
    retrieval,
  };
  const evidence = deepFreeze({ ...base, fingerprint: fingerprint(base) });
  retrievedEvidence.add(evidence);
  return evidence;
}

export function restoreRetrievedEvidence(input) {
  let normalized;
  try { normalized = boundedJson(input, { where: 'stored retrieved evidence', object: true, maxBytes: 64 * 1024 }).value; }
  catch (error) { throw provenanceError(error.message); }
  const raw = fields(normalized, ['format', 'type', 'source', 'excerpt', 'retrievedAt', 'retrieval', 'fingerprint'], 'stored retrieved evidence');
  if (raw.format !== RETRIEVED_EVIDENCE_FORMAT) throw provenanceError(`stored retrieved evidence.format must be ${RETRIEVED_EVIDENCE_FORMAT}`);
  if (raw.type !== 'retrieved-evidence') throw provenanceError('stored retrieved evidence.type must be retrieved-evidence');
  if (typeof raw.fingerprint !== 'string' || !hashPattern.test(raw.fingerprint)) throw provenanceError('stored retrieved evidence.fingerprint must be a lowercase SHA-256 hash');
  const restored = createRetrievedEvidence({
    source: restoreSourceReference(raw.source), excerpt: raw.excerpt,
    retrievedAt: raw.retrievedAt, retrieval: raw.retrieval,
  });
  if (restored.fingerprint !== raw.fingerprint) throw provenanceError('stored retrieved evidence fingerprint does not match its contents');
  return restored;
}

function citations(rawSources, rawEvidence) {
  const strictArray = (value, where) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw provenanceError(`${where} must be an array`);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0) throw provenanceError(`${where} has an invalid length`);
    if (length > 32) throw provenanceError(`${where} may contain at most 32 entries`);
    const keys = Reflect.ownKeys(value).filter(key => key !== 'length');
    if (keys.length !== length || keys.some(key => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length)) {
      throw provenanceError(`${where} must contain only contiguous indexed entries`);
    }
    const result = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw provenanceError(`${where}[${index}] must be an enumerable data property`);
      result.push(descriptor.value);
    }
    return result;
  };
  rawSources = strictArray(rawSources, 'sources');
  rawEvidence = strictArray(rawEvidence, 'evidence');
  const sources = [], evidence = [], seenSources = new Set(), seenEvidence = new Set();
  for (const source of rawSources) {
    if (!isSourceReference(source)) throw provenanceError('every source must be created by createSourceReference()');
    if (!seenSources.has(source.fingerprint)) { seenSources.add(source.fingerprint); sources.push(source); }
  }
  for (const item of rawEvidence) {
    if (!isRetrievedEvidence(item)) throw provenanceError('every evidence item must be created by createRetrievedEvidence()');
    if (!seenEvidence.has(item.fingerprint)) { seenEvidence.add(item.fingerprint); evidence.push(item.fingerprint); }
    if (!seenSources.has(item.source.fingerprint)) { seenSources.add(item.source.fingerprint); sources.push(item.source); }
  }
  return { sources, evidence };
}

function finishMemoryRecord(raw, cited, expectedFingerprint, { storedLifecycle = false } = {}) {
  if (typeof raw.id !== 'string' || !portableId.test(raw.id)) throw provenanceError('memory record.id must be 1-128 portable identifier characters');
  if (!MEMORY_KINDS.includes(raw.kind)) throw provenanceError(`memory record.kind must be one of ${MEMORY_KINDS.join(', ')}`);
  const recordText = text(raw.text, 'memory record.text', 32_000);
  const author = actor(raw.author);
  const createdAt = instant(raw.createdAt, 'memory record.createdAt');
  if (!MEMORY_BASES.includes(raw.basis)) throw provenanceError(`memory record.basis must be one of ${MEMORY_BASES.join(', ')}`);
  if (!MEMORY_CONFIDENCE.includes(raw.confidence)) throw provenanceError(`memory record.confidence must be one of ${MEMORY_CONFIDENCE.join(', ')}`);
  if (raw.kind === 'authored-memory' && author.kind !== 'agent') throw provenanceError('authored-memory records must be authored by an agent');
  if (raw.kind === 'summary' && raw.basis !== 'source-backed') throw provenanceError('summary records must be source-backed');
  if (raw.kind === 'observation' && !['source-backed', 'inferred'].includes(raw.basis)) throw provenanceError('observation records must be source-backed or inferred');
  if (raw.basis !== 'self-authored' && !cited.sources.length) throw provenanceError(`${raw.basis} records must cite at least one source`);
  if (raw.basis === 'self-authored' && raw.kind !== 'authored-memory') throw provenanceError('only authored-memory records may use the self-authored basis');

  let lifecycle;
  try {
    lifecycle = raw.lifecycle === undefined
      ? undefined
      : normalizeMemoryLifecycle(raw.lifecycle, { stored: storedLifecycle });
  } catch (error) {
    throw provenanceError(error.message);
  }

  const base = {
    format: MEMORY_RECORD_FORMAT,
    id: raw.id,
    kind: raw.kind,
    text: recordText,
    author,
    createdAt,
    basis: raw.basis,
    confidence: raw.confidence,
    sources: cited.sources,
    evidence: cited.evidence,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(raw.kind === 'summary' ? { lossy: true } : {}),
  };
  const calculated = fingerprint(base);
  if (expectedFingerprint !== undefined && expectedFingerprint !== calculated) throw provenanceError('stored memory record fingerprint does not match its contents');
  const record = deepFreeze({ ...base, fingerprint: calculated });
  memoryRecords.add(record);
  return record;
}

export function createMemoryRecord(input) {
  const raw = fields(input, ['id', 'kind', 'text', 'author', 'createdAt', 'basis', 'confidence', 'sources', 'evidence', 'lifecycle'], 'memory record');
  return finishMemoryRecord(raw, citations(raw.sources, raw.evidence), undefined, { storedLifecycle: isMemoryLifecycle(raw.lifecycle) });
}

export function restoreMemoryRecord(input) {
  let normalized;
  try { normalized = boundedJson(input, { where: 'stored memory record', object: true, maxBytes: 256 * 1024, maxDepth: 64, maxNodes: 20_000 }).value; }
  catch (error) { throw provenanceError(error.message); }
  const raw = fields(normalized, [
    'format', 'id', 'kind', 'text', 'author', 'createdAt', 'basis', 'confidence',
    'sources', 'evidence', 'lifecycle', 'lossy', 'fingerprint',
  ], 'stored memory record');
  if (raw.format !== MEMORY_RECORD_FORMAT) throw provenanceError(`stored memory record.format must be ${MEMORY_RECORD_FORMAT}`);
  if (typeof raw.fingerprint !== 'string' || !hashPattern.test(raw.fingerprint)) throw provenanceError('stored memory record.fingerprint must be a lowercase SHA-256 hash');
  if (!Array.isArray(raw.sources)) throw provenanceError('stored memory record.sources must be an array');
  if (!Array.isArray(raw.evidence)) throw provenanceError('stored memory record.evidence must be an array');
  if (raw.sources.length > 32 || raw.evidence.length > 32) throw provenanceError('a stored memory record may cite at most 32 sources and 32 evidence items');
  const sources = [], seenSources = new Set();
  for (const value of raw.sources) {
    const source = restoreSourceReference(value);
    if (seenSources.has(source.fingerprint)) throw provenanceError('stored memory record.sources repeats a source');
    seenSources.add(source.fingerprint);
    sources.push(source);
  }
  const evidence = [], seenEvidence = new Set();
  for (const value of raw.evidence) {
    if (typeof value !== 'string' || !hashPattern.test(value)) throw provenanceError('stored memory record evidence entries must be lowercase SHA-256 hashes');
    if (seenEvidence.has(value)) throw provenanceError('stored memory record.evidence repeats a fingerprint');
    seenEvidence.add(value);
    evidence.push(value);
  }
  if (raw.kind === 'summary') {
    if (raw.lossy !== true) throw provenanceError('stored summary records must declare lossy: true');
  } else if (Object.hasOwn(normalized, 'lossy')) {
    throw provenanceError('only stored summary records may declare lossy');
  }
  return finishMemoryRecord(raw, { sources, evidence }, raw.fingerprint, { storedLifecycle: true });
}
