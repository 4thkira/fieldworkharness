import { createHash } from 'node:crypto';
import { deepFreeze, isPlainObject } from './json-data.mjs';
import { isMemoryLedger, readLiveMemoryLedgerReceipt } from './memory-ledger.mjs';
import { memoryLifecycleStatus } from './memory-lifecycle.mjs';
import { renderMemoryContext } from './memory-context.mjs';
import { parseTimeCues, timeCueContentText, timeCuesMatchInstant } from './time-cues.mjs';
import { isMeaningRecall } from './meaning-recall.mjs';

// A small, conservative view of current memory for the newest user message.
// The ledger remains the source of truth. This module selects whole current
// records, keeps their provenance and type, and never writes or summarizes them.

export const MEMORY_FOREGROUND_RECEIPT_FORMAT = 'fieldwork-memory-foreground/v2';
export const MEMORY_FOREGROUND_UNAVAILABLE = '[Fieldwork could not read current memory for this turn, so it added no automatic memory context.]';
export const MEMORY_FOREGROUND_BUDGET_OMISSION = '[Fieldwork found possibly relevant memories, but none fit the automatic memory budget; no memory was added.]';
export const MEMORY_FOREGROUND_LIMITS = Object.freeze({
  messageCharacters: 8_000,
  terms: 16,
  candidates: 10_000,
  sourceBytes: 32 * 1024 * 1024,
  indexTokens: 2_000_000,
  selected: 8,
  contextCharacters: 4_000,
  evidenceCharacters: 1_000,
  observationCharacters: 2_500,
  memoryCharacters: 3_500,
  summaryCharacters: 2_500,
});

const encoder = new TextEncoder();
const tokenPattern = /[\p{L}\p{N}]+/gu;
const foregrounds = new WeakSet();
const foregroundSources = new WeakMap();
const stopWords = new Set([
  'about', 'after', 'again', 'also', 'allowed', 'always', 'another', 'any', 'are', 'back', 'because', 'been', 'before',
  'being', 'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'done', 'each', 'even', 'every', 'first',
  'check', 'checked', 'complete', 'completed', 'current', 'currently', 'day', 'finish', 'finished', 'fix', 'fixed',
  'do', 'for', 'from', 'get', 'give', 'going', 'got', 'had', 'happen', 'happened', 'has', 'have', 'hello', 'help', 'here', 'how', 'into',
  'just', 'know', 'last', 'like', 'look', 'made', 'make', 'many', 'maybe', 'memory', 'more', 'most', 'much',
  'month', 'must', 'new', 'not', 'note', 'notes', 'now', 'off', 'old', 'once', 'one', 'only', 'other', 'our', 'out', 'over', 'own',
  'please', 'really', 'remember', 'same', 'say', 'said', 'see', 'should', 'since', 'some', 'still', 'such',
  'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'think',
  'this', 'those', 'through', 'time', 'today', 'tonight', 'too', 'try', 'two', 'under', 'until', 'update', 'updated',
  'very', 'want', 'was', 'way', 'week', 'well', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why',
  'will', 'with', 'working', 'works', 'would', 'year', 'yes', 'you', 'your',
]);

function foregroundError(message) {
  return new Error(`Memory foreground: ${message}`);
}

function whole(value, fallback, maximum, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw foregroundError(`${name} must be a whole number from 1 to ${maximum}`);
  }
  return number;
}

function configurationFrom(options) {
  if (!isPlainObject(options)) throw foregroundError('options must be an object');
  const allowed = [...Object.keys(MEMORY_FOREGROUND_LIMITS), 'now', 'timeZone', 'meaning', 'signal'];
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw foregroundError(`options has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw foregroundError(`options.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  const limits = {
    messageCharacters: whole(fields.messageCharacters, MEMORY_FOREGROUND_LIMITS.messageCharacters, 100_000, 'messageCharacters'),
    terms: whole(fields.terms, MEMORY_FOREGROUND_LIMITS.terms, 128, 'terms'),
    candidates: whole(fields.candidates, MEMORY_FOREGROUND_LIMITS.candidates, 100_000, 'candidates'),
    sourceBytes: whole(fields.sourceBytes, MEMORY_FOREGROUND_LIMITS.sourceBytes, 512 * 1024 * 1024, 'sourceBytes'),
    indexTokens: whole(fields.indexTokens, MEMORY_FOREGROUND_LIMITS.indexTokens, 20_000_000, 'indexTokens'),
    selected: whole(fields.selected, MEMORY_FOREGROUND_LIMITS.selected, 100, 'selected'),
    contextCharacters: whole(fields.contextCharacters, MEMORY_FOREGROUND_LIMITS.contextCharacters, 100_000, 'contextCharacters'),
    evidenceCharacters: whole(fields.evidenceCharacters, MEMORY_FOREGROUND_LIMITS.evidenceCharacters, 100_000, 'evidenceCharacters'),
    observationCharacters: whole(fields.observationCharacters, MEMORY_FOREGROUND_LIMITS.observationCharacters, 100_000, 'observationCharacters'),
    memoryCharacters: whole(fields.memoryCharacters, MEMORY_FOREGROUND_LIMITS.memoryCharacters, 100_000, 'memoryCharacters'),
    summaryCharacters: whole(fields.summaryCharacters, MEMORY_FOREGROUND_LIMITS.summaryCharacters, 100_000, 'summaryCharacters'),
  };
  if (limits.contextCharacters < 256) throw foregroundError('contextCharacters must be at least 256');
  if (fields.meaning !== undefined && fields.meaning !== null && !isMeaningRecall(fields.meaning)) {
    throw foregroundError('meaning must be created by createMeaningRecall()');
  }
  if (fields.signal !== undefined
      && (typeof fields.signal !== 'object' || typeof fields.signal.throwIfAborted !== 'function')) {
    throw foregroundError('signal must be an AbortSignal when present');
  }
  return Object.freeze({
    limits: Object.freeze(limits),
    meaning: fields.meaning ?? null,
    ...(fields.signal === undefined ? {} : { signal: fields.signal }),
    ...(fields.now === undefined ? {} : { now: fields.now }),
    ...(fields.timeZone === undefined ? {} : { timeZone: fields.timeZone }),
  });
}

function isWellFormed(value) {
  if (typeof value.isWellFormed === 'function') return value.isWellFormed();
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function lexicalTokens(value) {
  return value.normalize('NFKC').toLowerCase().match(tokenPattern) ?? [];
}

function boundedMessage(message, limits) {
  if (typeof message !== 'string') throw foregroundError('message must be primitive text');
  if (!isWellFormed(message)) throw foregroundError('message must contain well-formed Unicode');
  let characters = 0;
  const prefix = [];
  for (const point of message) {
    characters++;
    if (prefix.length < limits.messageCharacters) prefix.push(point);
  }
  return Object.freeze({
    characters,
    prefix: prefix.join(''),
    consideredCharacters: prefix.length,
    truncated: characters > limits.messageCharacters,
  });
}

function queryFor(message, lexicalMessage, view, limits, time) {
  const unique = [];
  const seen = new Set();
  for (const token of lexicalTokens(lexicalMessage)) {
    if ([...token].length < 3 || stopWords.has(token) || seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
    if (unique.length >= limits.terms) break;
  }
  return Object.freeze({
    hash: createHash('sha256').update(message, 'utf8').digest('hex'),
    characters: view.characters,
    consideredCharacters: view.consideredCharacters,
    truncated: view.truncated,
    terms: unique,
    time,
  });
}

function receiptQuery(query) {
  return {
    hash: query.hash,
    characters: query.characters,
    consideredCharacters: query.consideredCharacters,
    truncated: query.truncated,
    terms: query.terms.length,
    normalization: 'NFKC-lower-alphanumeric-stopwords/v1',
    time: query.time.receipt,
    timeRanking: {
      basis: 'memory-record-createdAt',
      matchMultiplierPpm: 2_000_000,
    },
  };
}

function makeForeground(text, receipt) {
  const foreground = deepFreeze({ text, receipt });
  foregrounds.add(foreground);
  return foreground;
}

function emptyForeground(query, limits, reason, extra = {}) {
  return makeForeground('', {
    format: MEMORY_FOREGROUND_RECEIPT_FORMAT,
    status: 'empty',
    reason,
    query: receiptQuery(query),
    limits,
    ...extra,
  });
}

function unavailableForeground(query, limits, reason, extra = {}) {
  return makeForeground(MEMORY_FOREGROUND_UNAVAILABLE, {
    format: MEMORY_FOREGROUND_RECEIPT_FORMAT,
    status: 'unavailable',
    reason,
    query: receiptQuery(query),
    limits,
    ...extra,
  });
}

function sameLedgerReceipt(view, current) {
  return view.ledgerId === current.ledgerId
    && view.receipt.events === current.events
    && view.receipt.head === current.head;
}

function indexedWitness(view) {
  return {
    ledger: { ledgerId: view.ledgerId, events: view.receipt.events, head: view.receipt.head },
    index: { kind: 'memory-ledger', ledgerId: view.ledgerId, events: view.receipt.events, head: view.receipt.head },
  };
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isMemoryForeground(value) {
  return Boolean(value) && foregrounds.has(value);
}

async function buildMemoryForegroundOnce(ledger, message, options = {}) {
  if (!isMemoryLedger(ledger)) throw foregroundError('ledger must be a live Fieldwork memory ledger');
  const configuration = configurationFrom(options);
  configuration.signal?.throwIfAborted();
  const limits = configuration.limits;
  const messageView = boundedMessage(message, limits);
  const time = parseTimeCues(messageView.prefix, {
    ...(configuration.now === undefined ? {} : { now: configuration.now }),
    ...(configuration.timeZone === undefined ? {} : { timeZone: configuration.timeZone }),
  });
  const query = queryFor(message, timeCueContentText(time), messageView, limits, time);
  if (!query.terms.length) return emptyForeground(query, limits, 'no-informative-terms');

  try {
    const view = await ledger.retrievalView({ mode: 'current', maxCandidates: limits.candidates });
    if (!view.rows.length) {
      const current = await readLiveMemoryLedgerReceipt(ledger);
      if (!sameLedgerReceipt(view, current)) return unavailableForeground(query, limits, 'memory-changed');
      return emptyForeground(query, limits, 'no-current-memories', {
        ...indexedWitness(view),
        lifecycle: { asOf: query.time.receipt.now, considered: 0, eligible: 0, scheduled: 0, expired: 0, due: 0 },
      });
    }

    const evaluated = view.rows.map(row => ({
      row,
      lifecycleStatus: memoryLifecycleStatus(row.record.lifecycle, query.time.receipt.now),
    }));
    const eligibleRows = evaluated.filter(item => item.lifecycleStatus.eligible);
    const lifecycle = {
      asOf: query.time.receipt.now,
      considered: evaluated.length,
      eligible: eligibleRows.length,
      scheduled: evaluated.filter(item => item.lifecycleStatus.phase === 'scheduled').length,
      expired: evaluated.filter(item => item.lifecycleStatus.phase === 'expired').length,
      due: evaluated.filter(item => item.lifecycleStatus.due).length,
    };
    if (!eligibleRows.length) {
      const current = await readLiveMemoryLedgerReceipt(ledger);
      if (!sameLedgerReceipt(view, current)) return unavailableForeground(query, limits, 'memory-changed');
      return emptyForeground(query, limits, 'no-lifecycle-eligible-memories', {
        ...indexedWitness(view),
        lifecycle,
      });
    }

    const frequencies = new Map(query.terms.map(term => [term, 0]));
    let sourceBytes = 0;
    let indexTokens = 0;
    const documents = [];
    for (const { row, lifecycleStatus } of eligibleRows) {
      const text = row.record.text;
      sourceBytes += encoder.encode(text).length;
      if (sourceBytes > limits.sourceBytes) throw foregroundError(`memory source text exceeds ${limits.sourceBytes} bytes`);
      const tokens = lexicalTokens(text);
      indexTokens += tokens.length;
      if (indexTokens > limits.indexTokens) throw foregroundError(`memory index exceeds ${limits.indexTokens} tokens`);
      const tokenSet = new Set(tokens);
      const matches = query.terms.filter(term => tokenSet.has(term));
      for (const term of matches) frequencies.set(term, frequencies.get(term) + 1);
      documents.push({
        row, lifecycleStatus, tokens, matches,
        timeMatch: timeCuesMatchInstant(query.time, row.record.createdAt),
        stableKey: `${row.logicalId}\0${row.record.fingerprint}`,
      });
    }

    const corpus = documents.length;
    const commonLimit = corpus <= 8 ? Math.max(1, Math.ceil(corpus / 2)) : Math.max(2, Math.floor(corpus * 0.2));
    const singleLimit = Math.max(2, Math.floor(Math.sqrt(corpus)));
    const informative = query.terms.filter(term => {
      const frequency = frequencies.get(term) ?? 0;
      return frequency > 0 && frequency <= commonLimit;
    });
    const informativeSet = new Set(informative);
    const candidates = [];
    for (const document of documents) {
      const matches = document.matches.filter(term => informativeSet.has(term));
      if (!matches.length) continue;
      const rarest = Math.min(...matches.map(term => frequencies.get(term)));
      if (matches.length < 2 && rarest > (informative.length > 1 ? 1 : singleLimit)) continue;
      let adjacentPairs = 0;
      for (let index = 0; index + 1 < query.terms.length; index++) {
        const left = query.terms[index], right = query.terms[index + 1];
        if (!informativeSet.has(left) || !informativeSet.has(right)) continue;
        for (let at = 0; at + 1 < document.tokens.length; at++) {
          if (document.tokens[at] === left && document.tokens[at + 1] === right) {
            adjacentPairs++;
            break;
          }
        }
      }
      const rarityPpm = matches.reduce((sum, term) => sum + Math.floor(1_000_000 / frequencies.get(term)), 0);
      const lexicalScorePpm = matches.length * 1_000_000 + adjacentPairs * 250_000 + rarityPpm;
      const scorePpm = document.timeMatch ? lexicalScorePpm * 2 : lexicalScorePpm;
      candidates.push({ ...document, matches, adjacentPairs, scorePpm });
    }
    candidates.sort((left, right) => (
      right.scorePpm - left.scorePpm
      || right.matches.length - left.matches.length
      || stableCompare(left.stableKey, right.stableKey)
    ));

    const selected = candidates.slice(0, limits.selected);
    // An optional meaning seat: the closest memory by meaning that the word
    // matches did not already choose, if it clears the floor. It only adds;
    // it never reorders or replaces a word match.
    let meaning = null;
    if (configuration.meaning) {
      const taken = new Set(selected.map(item => item.row.logicalId));
      const outcome = await configuration.meaning.pick({
        message: messageView.prefix,
        items: documents
          .filter(document => !taken.has(document.row.logicalId))
          .map(document => ({ id: document.row.logicalId, text: document.row.record.text })),
        ...(configuration.signal ? { signal: configuration.signal } : {}),
      });
      meaning = outcome.trace;
      for (const pick of outcome.picks) {
        const document = documents.find(item => item.row.logicalId === pick.id);
        if (!document || taken.has(pick.id)) continue;
        taken.add(pick.id);
        selected.push({ ...document, matches: [], adjacentPairs: 0, scorePpm: 0, meaningPpm: pick.similarityPpm });
      }
    }
    if (!selected.length) {
      const current = await readLiveMemoryLedgerReceipt(ledger);
      if (!sameLedgerReceipt(view, current)) return unavailableForeground(query, limits, 'memory-changed');
      return emptyForeground(query, limits, 'no-distinctive-match', {
        ...indexedWitness(view),
        lifecycle,
        corpus: { candidates: corpus, sourceBytes, indexTokens, matched: candidates.length },
        ...(meaning ? { meaning } : {}),
      });
    }

    const current = await readLiveMemoryLedgerReceipt(ledger);
    if (!sameLedgerReceipt(view, current)) return unavailableForeground(query, limits, 'memory-changed');

    const grouped = { observations: [], memories: [], summaries: [] };
    for (const item of selected) {
      if (item.row.record.kind === 'observation') grouped.observations.push(item.row.record);
      else if (item.row.record.kind === 'authored-memory') grouped.memories.push(item.row.record);
      else grouped.summaries.push(item.row.record);
    }
    const rendered = renderMemoryContext(grouped, {
      maxCharacters: limits.contextCharacters,
      evidenceCharacters: limits.evidenceCharacters,
      observationCharacters: limits.observationCharacters,
      memoryCharacters: limits.memoryCharacters,
      summaryCharacters: limits.summaryCharacters,
    });
    const selection = selected.map(item => ({
      id: item.row.logicalId,
      fingerprint: item.row.record.fingerprint,
      matchedTerms: item.matches.length,
      ...(Number.isSafeInteger(item.meaningPpm) ? { matchedBy: 'meaning', meaningPpm: item.meaningPpm } : {}),
      adjacentPairs: item.adjacentPairs,
      timeMatch: item.timeMatch,
      scorePpm: item.scorePpm,
      lifecycleType: item.lifecycleStatus.type,
      lifecyclePhase: item.lifecycleStatus.phase,
      due: item.lifecycleStatus.due,
      sources: item.row.record.sources.map(source => ({
        kind: source.kind,
        fingerprint: source.fingerprint,
        observedThrough: source.observedThrough ?? null,
      })),
    }));
    const receipt = {
      format: MEMORY_FOREGROUND_RECEIPT_FORMAT,
      status: rendered.text ? 'ready' : 'omitted',
      reason: rendered.text ? 'selected' : 'context-budget',
      query: receiptQuery(query),
      limits,
      ...indexedWitness(view),
      lifecycle,
      corpus: {
        candidates: corpus, sourceBytes, indexTokens, informativeTerms: informative.length,
        matched: candidates.length, timeMatched: candidates.filter(item => item.timeMatch).length,
      },
      selection,
      context: rendered.receipt,
      ...(meaning ? { meaning } : {}),
    };
    return makeForeground(rendered.text || MEMORY_FOREGROUND_BUDGET_OMISSION, receipt);
  } catch (error) {
    // A stopped chat or Fieldwork is not a memory outage. Preserve its exact
    // cancellation so the enclosing run stops instead of continuing with an
    // apparently ordinary "no memory" result.
    if (configuration.signal?.aborted) throw configuration.signal.reason ?? error;
    return unavailableForeground(query, limits, 'memory-read-failed');
  }
}

export async function buildMemoryForeground(ledger, message, options = {}) {
  const foreground = await buildMemoryForegroundOnce(ledger, message, options);
  foregroundSources.set(foreground, Object.freeze({
    ledger,
    message,
    options: Object.freeze({
      ...foreground.receipt.limits,
      now: foreground.receipt.query.time.now,
      timeZone: foreground.receipt.query.time.timeZone,
      ...(options?.meaning ? { meaning: options.meaning } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
  }));
  return foreground;
}

// A tool may revise, retract, restore, or add memory between provider steps.
// Reuse the foreground only while its witnessed ledger head is still current;
// otherwise rebuild it from the original user message and the same limits.
export async function refreshMemoryForeground(foreground) {
  if (!isMemoryForeground(foreground)) throw foregroundError('foreground must be returned by buildMemoryForeground()');
  const source = foregroundSources.get(foreground);
  if (!source) throw foregroundError('foreground has no live source');
  source.options.signal?.throwIfAborted();
  if (foreground.receipt.reason === 'no-informative-terms') return foreground;
  const witnessed = foreground.receipt.index ?? foreground.receipt.ledger;
  if (witnessed) {
    try {
      const current = await readLiveMemoryLedgerReceipt(source.ledger);
      if (witnessed.ledgerId === current.ledgerId
          && witnessed.events === current.events
          && witnessed.head === current.head) return foreground;
    } catch {
      // The ordinary builder converts an unavailable ledger into a fixed,
      // provenance-free marker. Use that one failure path for refreshes too.
    }
  }
  return buildMemoryForegroundOnce(source.ledger, source.message, source.options).then(next => {
    foregroundSources.set(next, source);
    return next;
  });
}

// Insert the ephemeral foreground immediately before the newest user message.
// Root assembly happens afterwards, so a user-tail voice root remains later.
// It goes in at user level, not system: memory text is written by the agent,
// often from what people said, and must not gain the host's authority. A
// memory that reads like an instruction stays as weak as anything a person typed.
// The transcript itself is never changed or returned with this context stored.
export function withMemoryForeground(messages, foreground) {
  if (!Array.isArray(messages)) throw foregroundError('messages must be an array');
  if (!isMemoryForeground(foreground)) throw foregroundError('foreground must be returned by buildMemoryForeground()');
  if (!foreground.text) return messages;
  let newestUser = -1;
  for (let index = 0; index < messages.length; index++) if (messages[index]?.role === 'user') newestUser = index;
  if (newestUser < 0) throw foregroundError('messages need a user turn');
  const result = messages.slice();
  result.splice(newestUser, 0, { role: 'user', content: foreground.text });
  return result;
}
