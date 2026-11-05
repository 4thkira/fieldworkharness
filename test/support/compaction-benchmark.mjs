import { createHash } from 'node:crypto';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject } from '../../src/json-data.mjs';
import { restoreSourceReference } from '../../src/provenance.mjs';

export const COMPACTION_BENCHMARK_CANDIDATE_FORMAT = 'fieldwork-compaction-benchmark-candidate/v1';
export const COMPACTION_BENCHMARK_REPORT_FORMAT = 'fieldwork-compaction-benchmark-report/v1';

const encoder = new TextEncoder();
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const kinds = ['retrieved-evidence', 'observation', 'authored-memory', 'summary'];
const kindOrder = new Map(kinds.map((kind, index) => [kind, index]));
const bases = [null, 'source-backed', 'inferred', 'self-authored'];
const confidence = [null, 'uncertain', 'tentative', 'supported', 'asserted'];
const states = ['evidence', 'current'];
const authorities = ['none', 'assertive'];
const actions = ['supersede', 'restore', 'retract'];
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

function benchmarkError(message, cause) {
  return new Error(`Compaction benchmark: ${message}`, cause === undefined ? undefined : { cause });
}

function exactKeys(value, expected, where) {
  if (!isPlainObject(value)) throw benchmarkError(`${where} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw benchmarkError(`${where} has an invalid shape`);
  }
  return value;
}

function array(value, maximum, where) {
  if (!Array.isArray(value) || value.length > maximum) throw benchmarkError(`${where} must be an array with at most ${maximum} entries`);
  return value;
}

function text(value, maximum, where) {
  if (typeof value !== 'string' || !value.length || [...value].length > maximum) throw benchmarkError(`${where} must be 1-${maximum} characters of text`);
  return value;
}

function identifier(value, where) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw benchmarkError(`${where} must be a portable identifier`);
  return value;
}

function hash(value, where, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !hashPattern.test(value)) throw benchmarkError(`${where} must be a lowercase SHA-256 hash${nullable ? ' or null' : ''}`);
  return value;
}

function enumValue(value, allowed, where) {
  if (!allowed.includes(value)) throw benchmarkError(`${where} is not supported`);
  return value;
}

function stringArray(value, maximum, where, validator = item => text(item, 256, where)) {
  return array(value, maximum, where).map((item, index) => validator(item, `${where}[${index}]`));
}

function validateCandidate(candidate) {
  let normalized;
  try {
    normalized = boundedJson(candidate, {
      where: 'compaction candidate', object: true,
      maxBytes: 2 * 1024 * 1024, maxDepth: 32, maxNodes: 200_000,
    }).value;
  } catch (error) {
    throw benchmarkError(error.message, error);
  }
  exactKeys(normalized, [
    'format', 'specimenFingerprint', 'sources', 'items', 'lineage',
    'quotes', 'accounting', 'padding',
  ], 'candidate');
  if (normalized.format !== COMPACTION_BENCHMARK_CANDIDATE_FORMAT) throw benchmarkError(`candidate.format must be ${COMPACTION_BENCHMARK_CANDIDATE_FORMAT}`);
  hash(normalized.specimenFingerprint, 'candidate.specimenFingerprint');
  if (
    typeof normalized.padding !== 'string'
    || normalized.padding.length > 1024 * 1024
    || !/^(?:neutral-padding-block\n)*$/.test(normalized.padding)
  ) {
    throw benchmarkError('candidate.padding must contain only the reserved neutral-padding-block marker');
  }

  const sources = array(normalized.sources, 100, 'candidate.sources').map((source, index) => {
    try { return restoreSourceReference(source); }
    catch (error) { throw benchmarkError(`candidate.sources[${index}] is invalid`, error); }
  });
  const items = array(normalized.items, 100, 'candidate.items').map((item, index) => {
    const where = `candidate.items[${index}]`;
    exactKeys(item, [
      'id', 'kind', 'state', 'authority', 'atoms', 'recordFingerprint',
      'evidenceFingerprint', 'basis', 'confidence', 'lossy', 'instructionShaped',
      'sourceFingerprints', 'evidenceFingerprints',
    ], where);
    identifier(item.id, `${where}.id`);
    enumValue(item.kind, kinds, `${where}.kind`);
    enumValue(item.state, states, `${where}.state`);
    enumValue(item.authority, authorities, `${where}.authority`);
    stringArray(item.atoms, 16, `${where}.atoms`, (atom, atomWhere) => {
      text(atom, 200, atomWhere);
      if (!atom.startsWith('[[FW:') || !atom.endsWith(']]')) throw benchmarkError(`${atomWhere} must be a closed Fieldwork atom`);
      return atom;
    });
    hash(item.recordFingerprint, `${where}.recordFingerprint`, true);
    hash(item.evidenceFingerprint, `${where}.evidenceFingerprint`, true);
    enumValue(item.basis, bases, `${where}.basis`);
    enumValue(item.confidence, confidence, `${where}.confidence`);
    if (![true, false, null].includes(item.lossy)) throw benchmarkError(`${where}.lossy must be true, false or null`);
    if (typeof item.instructionShaped !== 'boolean') throw benchmarkError(`${where}.instructionShaped must be boolean`);
    stringArray(item.sourceFingerprints, 16, `${where}.sourceFingerprints`, (value, valueWhere) => hash(value, valueWhere));
    stringArray(item.evidenceFingerprints, 16, `${where}.evidenceFingerprints`, (value, valueWhere) => hash(value, valueWhere));
    return item;
  });
  const lineage = array(normalized.lineage, 100, 'candidate.lineage').map((row, index) => {
    const where = `candidate.lineage[${index}]`;
    exactKeys(row, [
      'id', 'sequence', 'action', 'logicalId', 'fromFingerprint', 'toFingerprint',
      'targetFingerprint', 'actionFingerprint', 'actor', 'reasonSha256',
    ], where);
    identifier(row.id, `${where}.id`);
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) throw benchmarkError(`${where}.sequence must be a positive whole number`);
    enumValue(row.action, actions, `${where}.action`);
    identifier(row.logicalId, `${where}.logicalId`);
    hash(row.fromFingerprint, `${where}.fromFingerprint`, true);
    hash(row.toFingerprint, `${where}.toFingerprint`, true);
    hash(row.targetFingerprint, `${where}.targetFingerprint`, true);
    hash(row.actionFingerprint, `${where}.actionFingerprint`);
    exactKeys(row.actor, ['kind', 'id'], `${where}.actor`);
    enumValue(row.actor.kind, ['agent', 'operator', 'system'], `${where}.actor.kind`);
    text(row.actor.id, 128, `${where}.actor.id`);
    hash(row.reasonSha256, `${where}.reasonSha256`);
    return row;
  });
  const quotes = array(normalized.quotes, 32, 'candidate.quotes').map((quote, index) => {
    const where = `candidate.quotes[${index}]`;
    exactKeys(quote, ['id', 'sourceFingerprint', 'path', 'startCharacter', 'endCharacter', 'text'], where);
    identifier(quote.id, `${where}.id`);
    hash(quote.sourceFingerprint, `${where}.sourceFingerprint`);
    text(quote.path, 256, `${where}.path`);
    if (!Number.isSafeInteger(quote.startCharacter) || quote.startCharacter < 0) throw benchmarkError(`${where}.startCharacter must be a nonnegative whole number`);
    if (!Number.isSafeInteger(quote.endCharacter) || quote.endCharacter < quote.startCharacter) throw benchmarkError(`${where}.endCharacter must follow startCharacter`);
    text(quote.text, 1000, `${where}.text`);
    return quote;
  });
  exactKeys(normalized.accounting, ['inputFingerprint', 'retained', 'omitted'], 'candidate.accounting');
  hash(normalized.accounting.inputFingerprint, 'candidate.accounting.inputFingerprint');
  const retained = array(normalized.accounting.retained, 200, 'candidate.accounting.retained').map((row, index) => {
    const where = `candidate.accounting.retained[${index}]`;
    exactKeys(row, ['inputFingerprint', 'outputIds'], where);
    hash(row.inputFingerprint, `${where}.inputFingerprint`);
    stringArray(row.outputIds, 32, `${where}.outputIds`, (value, valueWhere) => identifier(value, valueWhere));
    return row;
  });
  const omitted = array(normalized.accounting.omitted, 200, 'candidate.accounting.omitted').map((row, index) => {
    const where = `candidate.accounting.omitted[${index}]`;
    exactKeys(row, ['inputFingerprint', 'reason'], where);
    hash(row.inputFingerprint, `${where}.inputFingerprint`);
    identifier(row.reason, `${where}.reason`);
    return row;
  });
  return deepFreeze({
    ...normalized,
    sources,
    items,
    lineage,
    quotes,
    accounting: { ...normalized.accounting, retained, omitted },
  });
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values, key) {
  for (let index = 1; index < values.length; index++) {
    if (compare(key(values[index - 1]), key(values[index])) > 0) return false;
  }
  return true;
}

function sortedWith(values, comparator) {
  for (let index = 1; index < values.length; index++) {
    if (comparator(values[index - 1], values[index]) > 0) return false;
  }
  return true;
}

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function coverage(counter) {
  return counter.total ? Math.floor(counter.passed * 1_000_000 / counter.total) : 1_000_000;
}

function unique(values, key) {
  return new Set(values.map(key)).size === values.length;
}

export function evaluateCompactionCandidate(specimen, candidate) {
  if (!isPlainObject(specimen) || !isPlainObject(specimen.input) || !isPlainObject(specimen.oracle)) {
    throw benchmarkError('specimen must contain input and oracle objects');
  }
  const value = validateCandidate(candidate);
  const oracle = specimen.oracle;
  const violations = new Map();
  const counters = {
    semantic: { passed: 0, total: 0 },
    provenance: { passed: 0, total: 0 },
    accounting: { passed: 0, total: 0 },
  };
  const add = (code, subject = 'candidate') => {
    const key = `${code}\0${subject}`;
    if (!violations.has(key)) violations.set(key, { code, subject });
  };
  const gate = (category, condition, code, subject) => {
    counters[category].total++;
    if (condition) counters[category].passed++;
    else add(code, subject);
    return condition;
  };

  gate('semantic', value.specimenFingerprint === specimen.input.fingerprint, 'specimen-mismatch', 'specimen');
  gate('accounting', value.accounting.inputFingerprint === specimen.input.fingerprint, 'accounting-input-mismatch', 'accounting');

  const sourceKey = source => `${source.kind}\0${source.id}\0${source.locator ?? ''}\0${source.fingerprint}`;
  gate('semantic', sorted(value.sources, sourceKey), 'noncanonical-order', 'sources');
  gate('semantic', sorted(value.items, item => `${kindOrder.get(item.kind)}\0${item.id}`), 'noncanonical-order', 'items');
  gate('semantic', sortedWith(value.lineage, (left, right) => (
    left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : compare(left.id, right.id)
  )), 'noncanonical-order', 'lineage');
  gate('semantic', sortedWith(value.quotes, (left, right) => (
    compare(left.sourceFingerprint, right.sourceFingerprint)
    || (left.startCharacter < right.startCharacter ? -1 : left.startCharacter > right.startCharacter ? 1 : compare(left.id, right.id))
  )), 'noncanonical-order', 'quotes');
  gate('semantic', unique(value.sources, source => source.fingerprint), 'duplicate-output', 'sources');
  gate('semantic', unique(value.items, item => item.id), 'duplicate-output', 'items');
  gate('semantic', unique(value.lineage, row => row.id), 'duplicate-output', 'lineage');
  gate('semantic', unique(value.quotes, quote => quote.id), 'duplicate-output', 'quotes');
  gate('accounting', unique(value.accounting.retained, row => row.inputFingerprint), 'duplicate-accounting-input', 'accounting.retained');
  gate('accounting', unique(value.accounting.omitted, row => row.inputFingerprint), 'duplicate-accounting-input', 'accounting.omitted');
  for (const item of value.items) {
    gate('semantic', sorted(item.atoms, atom => atom), 'noncanonical-order', item.id);
    gate('provenance', sorted(item.sourceFingerprints, fingerprint => fingerprint), 'noncanonical-order', item.id);
    gate('provenance', sorted(item.evidenceFingerprints, fingerprint => fingerprint), 'noncanonical-order', item.id);
    for (const atom of item.atoms) {
      gate('semantic', oracle.allowedAtoms.includes(atom), 'counterfeit-atom', item.id);
      const lanes = oracle.atomLanes[atom] ?? [];
      gate('semantic', lanes.includes(item.kind), 'atom-lane-violation', item.id);
    }
  }

  const sourcesByFingerprint = new Map(value.sources.map(source => [source.fingerprint, source]));
  gate(
    'provenance',
    equal(value.sources.map(source => source.fingerprint), oracle.requiredSources.map(source => source.fingerprint)),
    'unexpected-output',
    'sources',
  );
  gate(
    'semantic',
    equal(value.items.map(item => item.id), oracle.expectedItems.map(item => item.id)),
    'unexpected-output',
    'items',
  );
  gate(
    'semantic',
    equal(value.lineage.map(row => row.id), oracle.expectedLineage.map(row => row.id)),
    'unexpected-output',
    'lineage',
  );
  gate(
    'semantic',
    equal(value.quotes.map(row => row.id), [oracle.expectedQuote.id]),
    'unexpected-output',
    'quotes',
  );
  for (const required of oracle.requiredSources) {
    const found = sourcesByFingerprint.get(required.fingerprint);
    gate('provenance', Boolean(found) && equal(found, required), 'provenance-loss', required.fingerprint);
  }

  const itemsById = new Map(value.items.map(item => [item.id, item]));
  for (const expected of oracle.expectedItems) {
    const found = itemsById.get(expected.id);
    gate('semantic', Boolean(found), expected.missingCode, expected.id);
    if (!found) continue;
    gate('semantic', found.kind === expected.kind, 'type-collapse', expected.id);
    gate('semantic', found.state === expected.state && found.authority === expected.authority, 'required-state-mismatch', expected.id);
    gate('semantic', equal(found.atoms, expected.atoms), expected.stateCode, expected.id);
    gate('semantic', found.basis === expected.basis && found.confidence === expected.confidence, 'type-collapse', expected.id);
    gate(
      'semantic',
      found.lossy === expected.lossy,
      expected.kind === 'summary' ? 'lossy-marker-missing' : 'lossy-marker-mismatch',
      expected.id,
    );
    gate(
      'semantic',
      found.instructionShaped === expected.instructionShaped,
      expected.id === 'evidence:hostile' ? 'archived-text-promoted' : 'instruction-shape-mismatch',
      expected.id,
    );
    if (expected.id === 'evidence:hostile') {
      gate('semantic', found.kind === 'retrieved-evidence' && found.authority === 'none' && found.instructionShaped, 'archived-text-promoted', expected.id);
    }
    gate('provenance', found.recordFingerprint === expected.recordFingerprint, 'provenance-loss', expected.id);
    gate('provenance', found.evidenceFingerprint === expected.evidenceFingerprint, 'provenance-loss', expected.id);
    gate('provenance', equal(found.sourceFingerprints, expected.sourceFingerprints), 'provenance-loss', expected.id);
    gate('provenance', equal(found.evidenceFingerprints, expected.evidenceFingerprints), 'provenance-loss', expected.id);
  }

  const assertive = value.items.filter(item => item.kind !== 'retrieved-evidence' && item.state === 'current');
  gate('semantic', !assertive.some(item => item.atoms.includes(oracle.atoms.routeAmber)), 'stale-claim-resurrected', 'route');
  gate('semantic', !assertive.some(item => item.atoms.includes(oracle.atoms.modeLoud)), 'restoration-target-mismatch', 'memory:mode');
  gate('semantic', !assertive.some(item => item.atoms.includes(oracle.atoms.signal)), 'retracted-claim-resurrected', 'signal');
  gate('semantic', !assertive.some(item => item.atoms.includes(oracle.atoms.ornamentCount)), 'archived-text-promoted', 'hostile-archive');
  const mode = itemsById.get('memory:mode');
  gate('semantic', Boolean(mode) && mode.recordFingerprint === oracle.currentModeFingerprint && mode.atoms.includes(oracle.atoms.modeQuiet), 'restoration-target-mismatch', 'memory:mode');
  const commitment = itemsById.get('memory:chart-commitment');
  gate('semantic', Boolean(commitment) && oracle.commitmentAtoms.every(atom => commitment.atoms.includes(atom)), 'open-commitment-lost', 'memory:chart-commitment');
  const uncertainty = itemsById.get('observation:key-uncertainty');
  gate('semantic', Boolean(uncertainty) && oracle.uncertaintyAtoms.every(atom => uncertainty.atoms.includes(atom)) && uncertainty.confidence === 'uncertain', 'uncertainty-collapsed', 'observation:key-uncertainty');

  const lineageById = new Map(value.lineage.map(row => [row.id, row]));
  for (const expected of oracle.expectedLineage) {
    const found = lineageById.get(expected.id);
    gate('semantic', Boolean(found) && found.action === expected.action && found.logicalId === expected.logicalId, 'lineage-loss', expected.id);
    gate('provenance', Boolean(found) && equal(found, expected), 'provenance-loss', expected.id);
  }

  const quote = value.quotes.find(row => row.id === oracle.expectedQuote.id);
  const quoteEvent = specimen.input.events.find(event => event.id === oracle.quoteInputId);
  const quoteMessage = quoteEvent?.payload?.message;
  const quoteBlock = quoteMessage?.content;
  const quoteSource = quote ? sourcesByFingerprint.get(quote.sourceFingerprint) : null;
  const quoteMatches = Boolean(quote)
    && isPlainObject(quoteMessage)
    && typeof quoteBlock === 'string'
    && quote.sourceFingerprint === oracle.expectedQuote.sourceFingerprint
    && quote.path === oracle.expectedQuote.path
    && quote.startCharacter === oracle.expectedQuote.startCharacter
    && quote.endCharacter === oracle.expectedQuote.endCharacter
    && quote.text === oracle.expectedQuote.text
    && [...quoteBlock].slice(quote.startCharacter, quote.endCharacter).join('') === quote.text
    && quoteSource?.sha256 === sha256(canonicalJson(quoteMessage));
  gate('semantic', quoteMatches, 'unsupported-exact-quote', oracle.expectedQuote.id);
  gate('provenance', quoteMatches && Boolean(quoteSource), 'provenance-loss', oracle.expectedQuote.id);

  const outputIds = new Set([
    ...value.sources.map(source => `source:${source.fingerprint}`),
    ...value.items.map(item => item.id),
    ...value.lineage.map(row => row.id),
    ...value.quotes.map(row => row.id),
  ]);
  const eventSequence = oracle.eventSequence;
  const accountingOrder = (left, right) => {
    const leftSequence = eventSequence[left.inputFingerprint] ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = eventSequence[right.inputFingerprint] ?? Number.MAX_SAFE_INTEGER;
    return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : compare(left.inputFingerprint, right.inputFingerprint);
  };
  gate('accounting', sortedWith(value.accounting.retained, accountingOrder), 'noncanonical-order', 'accounting.retained');
  gate('accounting', sortedWith(value.accounting.omitted, accountingOrder), 'noncanonical-order', 'accounting.omitted');
  const accountingRows = [
    ...value.accounting.retained.map(row => ({ ...row, disposition: 'retained' })),
    ...value.accounting.omitted.map(row => ({ ...row, disposition: 'omitted' })),
  ];
  const expectedAccounting = new Map(oracle.expectedAccounting.map(row => [row.inputFingerprint, row]));
  for (const event of specimen.input.events) {
    const rows = accountingRows.filter(row => row.inputFingerprint === event.fingerprint);
    gate('accounting', rows.length === 1, 'unaccounted-input', event.id);
    if (rows.length !== 1) continue;
    const row = rows[0];
    const expected = expectedAccounting.get(event.fingerprint);
    gate('accounting', Boolean(expected) && row.disposition === expected.disposition, 'accounting-disposition-mismatch', event.id);
    if (row.disposition === 'omitted') {
      gate('accounting', oracle.allowedOmissions[event.fingerprint] === row.reason, 'load-bearing-input-omitted', event.id);
      gate('accounting', Boolean(expected) && row.reason === expected.reason, 'accounting-reason-mismatch', event.id);
    } else {
      gate('accounting', row.outputIds.length > 0 && row.outputIds.every(id => outputIds.has(id)), 'invalid-output-reference', event.id);
      gate('accounting', Boolean(expected) && equal(row.outputIds, expected.outputIds), 'accounting-output-mismatch', event.id);
    }
  }
  const inputFingerprints = new Set(specimen.input.events.map(event => event.fingerprint));
  for (const row of accountingRows) gate('accounting', inputFingerprints.has(row.inputFingerprint), 'unknown-accounting-input', row.inputFingerprint);

  const inputBytes = encoder.encode(canonicalJson(specimen.input)).length;
  const outputCanonical = canonicalJson(value);
  const outputBytes = encoder.encode(outputCanonical).length;
  const savedBytes = inputBytes - outputBytes;
  const outputRatioPpm = Math.floor(outputBytes * 1_000_000 / inputBytes);
  if (outputRatioPpm > oracle.maximumOutputRatioPpm || savedBytes < oracle.minimumSavedBytes) {
    add('compression-insufficient', 'bytes');
  }

  const details = [...violations.values()].sort((left, right) => compare(`${left.code}\0${left.subject}`, `${right.code}\0${right.subject}`));
  const report = deepFreeze({
    format: COMPACTION_BENCHMARK_REPORT_FORMAT,
    specimenFingerprint: specimen.input.fingerprint,
    candidateFingerprint: sha256(outputCanonical),
    inputBytes,
    outputBytes,
    savedBytes,
    outputRatioPpm,
    semanticCoveragePpm: coverage(counters.semantic),
    provenanceCoveragePpm: coverage(counters.provenance),
    accountingCoveragePpm: coverage(counters.accounting),
    violationCount: details.length,
    violations: details,
    pass: details.length === 0
      && coverage(counters.semantic) === 1_000_000
      && coverage(counters.provenance) === 1_000_000
      && coverage(counters.accounting) === 1_000_000,
  });
  return report;
}
