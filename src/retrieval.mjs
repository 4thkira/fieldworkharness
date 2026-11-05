import { createHash } from 'node:crypto';
import { isConversationArchive } from './conversation-archive.mjs';
import { canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';
import { isMemoryLedger, readLiveMemoryLedgerReceipt } from './memory-ledger.mjs';
import { memoryLifecycleStatus } from './memory-lifecycle.mjs';
import { renderMemoryContext } from './memory-context.mjs';
import { MESSAGE_TEXT_PROJECTION_FORMAT, projectMessageText } from './message-content.mjs';
import { createRetrievedEvidence, isRetrievedEvidence } from './provenance.mjs';

export const LEXICAL_QUERY_FORMAT = 'fieldwork-lexical-query/v1';
export const MEMORY_RETRIEVAL_RECEIPT_FORMAT = 'fieldwork-memory-retrieval/v1';
export const CONVERSATION_RETRIEVAL_RECEIPT_FORMAT = 'fieldwork-conversation-retrieval/v1';
export const RETRIEVAL_CONTEXT_RECEIPT_FORMAT = 'fieldwork-retrieval-context/v1';
export const RETRIEVAL_LIMITS = Object.freeze({
  maxQueryCharacters: 512,
  maxQueryBytes: 2048,
  maxQueryTokens: 64,
  maxResults: 50,
  maxCandidates: 10_000,
  maxIndexBytes: 32 * 1024 * 1024,
  maxIndexTokens: 2_000_000,
  maxSourceBytes: 32 * 1024 * 1024,
  maxExcerptCharacters: 4_000,
});
export const RETRIEVAL_CONTEXT_LIMITS = Object.freeze({
  maxSearches: 64,
  maxResults: 256,
  maxSourceBytes: 8 * 1024 * 1024,
});

const memorySearches = new WeakSet();
const memorySearchLedgers = new WeakMap();
const conversationSearches = new WeakSet();
const encoder = new TextEncoder();
const unicodeVersion = process.versions.unicode ?? 'unknown';
const portableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const tokenPattern = /[\p{L}\p{N}]+/gu;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function retrievalError(message, cause) {
  return new Error(`Retrieval: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw retrievalError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw retrievalError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw retrievalError(`${where}.${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function whole(value, fallback, maximum, where) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw retrievalError(`${where} must be a whole number from 1 to ${maximum}`);
  }
  return number;
}

function limitsFrom(options, mode) {
  const common = ['maxQueryCharacters', 'maxQueryBytes', 'maxQueryTokens', 'maxResults', 'maxCandidates'];
  const allowed = mode === 'memory'
    ? [...common, 'maxIndexBytes', 'maxIndexTokens', 'now']
    : [...common, 'maxSourceBytes', 'maxExcerptCharacters'];
  const raw = fields(options, allowed, 'options');
  const normalized = {
    maxQueryCharacters: whole(raw.maxQueryCharacters, RETRIEVAL_LIMITS.maxQueryCharacters, 4096, 'maxQueryCharacters'),
    maxQueryBytes: whole(raw.maxQueryBytes, RETRIEVAL_LIMITS.maxQueryBytes, 16 * 1024, 'maxQueryBytes'),
    maxQueryTokens: whole(raw.maxQueryTokens, RETRIEVAL_LIMITS.maxQueryTokens, 512, 'maxQueryTokens'),
    maxResults: whole(raw.maxResults, RETRIEVAL_LIMITS.maxResults, 1000, 'maxResults'),
    maxCandidates: whole(raw.maxCandidates, RETRIEVAL_LIMITS.maxCandidates, 100_000, 'maxCandidates'),
  };
  if (mode === 'memory') {
    normalized.maxIndexBytes = whole(raw.maxIndexBytes, RETRIEVAL_LIMITS.maxIndexBytes, 512 * 1024 * 1024, 'maxIndexBytes');
    normalized.maxIndexTokens = whole(raw.maxIndexTokens, RETRIEVAL_LIMITS.maxIndexTokens, 20_000_000, 'maxIndexTokens');
    normalized.now = exactInstant(raw.now ?? new Date().toISOString(), 'options.now');
  } else {
    normalized.maxSourceBytes = whole(raw.maxSourceBytes, RETRIEVAL_LIMITS.maxSourceBytes, 512 * 1024 * 1024, 'maxSourceBytes');
    normalized.maxExcerptCharacters = whole(raw.maxExcerptCharacters, RETRIEVAL_LIMITS.maxExcerptCharacters, 16_000, 'maxExcerptCharacters');
  }
  return Object.freeze(normalized);
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

function lexicalForm(value) {
  const normalized = value.normalize('NFKC').toLowerCase();
  return {
    characters: [...normalized].length,
    bytes: encoder.encode(normalized).length,
    tokens: normalized.match(tokenPattern) ?? [],
  };
}

function queryFrom(value, limits) {
  if (typeof value !== 'string' || !value.length) throw retrievalError('query must be nonempty primitive text');
  if (!isWellFormed(value)) throw retrievalError('query must contain well-formed Unicode');
  const characters = [...value].length;
  const bytes = encoder.encode(value).length;
  if (characters > limits.maxQueryCharacters) throw retrievalError(`query contains ${characters} characters; the limit is ${limits.maxQueryCharacters}`);
  if (bytes > limits.maxQueryBytes) throw retrievalError(`query contains ${bytes} UTF-8 bytes; the limit is ${limits.maxQueryBytes}`);
  const lexical = lexicalForm(value);
  if (lexical.characters > limits.maxQueryCharacters) {
    throw retrievalError(`normalized query contains ${lexical.characters} characters; the limit is ${limits.maxQueryCharacters}`);
  }
  if (lexical.bytes > limits.maxQueryBytes) {
    throw retrievalError(`normalized query contains ${lexical.bytes} UTF-8 bytes; the limit is ${limits.maxQueryBytes}`);
  }
  const tokens = lexical.tokens;
  if (!tokens.length) throw retrievalError('query must contain at least one letter or number token');
  if (tokens.length > limits.maxQueryTokens) throw retrievalError(`query contains ${tokens.length} tokens; the limit is ${limits.maxQueryTokens}`);
  return deepFreeze({
    format: LEXICAL_QUERY_FORMAT,
    hash: sha256(value),
    characters,
    bytes,
    normalizedCharacters: lexical.characters,
    normalizedBytes: lexical.bytes,
    tokens,
    normalization: 'NFKC-lower-alphanumeric/v1',
    literalMatch: 'raw-utf16-includes/v1',
    scoring: 'conjunctive-coverage-adjacency-fixed-point/v1',
    unicodeVersion,
    raw: value,
  });
}

function publicQuery(query) {
  return deepFreeze({
    format: query.format,
    hash: query.hash,
    characters: query.characters,
    bytes: query.bytes,
    normalizedCharacters: query.normalizedCharacters,
    normalizedBytes: query.normalizedBytes,
    tokens: query.tokens.length,
    normalization: query.normalization,
    literalMatch: query.literalMatch,
    scoring: query.scoring,
    unicodeVersion: query.unicodeVersion,
  });
}

// The index boundary is the exact durable ledger projection that was ranked.
// It is deliberately not a wall clock: query/lifecycle time is a separate
// concern, while this head names the bytes the lexical index actually saw.
function memoryIndexEdge(view) {
  return {
    kind: 'memory-ledger',
    ledgerId: view.ledgerId,
    events: view.receipt.events,
    head: view.receipt.head,
  };
}

function searchRequest(input, limits) {
  const raw = fields(input, ['query', 'limit'], 'search request');
  const query = queryFrom(raw.query, limits);
  const limit = whole(raw.limit, Math.min(10, limits.maxResults), limits.maxResults, 'search request.limit');
  return { query, limit };
}

function containsPair(tokens, left, right) {
  for (let index = 0; index + 1 < tokens.length; index++) {
    if (tokens[index] === left && tokens[index + 1] === right) return true;
  }
  return false;
}

function compareStable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rankDocuments(documents, query, limits, limit) {
  if (documents.length > limits.maxCandidates) {
    throw retrievalError(`corpus contains ${documents.length} candidates; the limit is ${limits.maxCandidates}`);
  }
  let sourceTextBytes = 0;
  let indexBytes = 0;
  let indexTokens = 0;
  const seenKeys = new Set();
  const indexed = documents.map(document => {
    if (seenKeys.has(document.stableKey)) throw retrievalError(`corpus repeats stable key ${JSON.stringify(document.stableKey)}`);
    seenKeys.add(document.stableKey);
    sourceTextBytes += encoder.encode(document.text).length;
    if (sourceTextBytes > limits.maxIndexBytes) {
      throw retrievalError(`source text exceeds the ${limits.maxIndexBytes}-byte index limit`);
    }
    const lexical = lexicalForm(document.text);
    indexBytes += lexical.bytes;
    if (indexBytes > limits.maxIndexBytes) {
      throw retrievalError(`normalized index text exceeds the ${limits.maxIndexBytes}-byte limit`);
    }
    indexTokens += lexical.tokens.length;
    if (indexTokens > limits.maxIndexTokens) {
      throw retrievalError(`lexical index exceeds the ${limits.maxIndexTokens}-token limit`);
    }
    return { ...document, tokens: lexical.tokens, tokenSet: new Set(lexical.tokens) };
  });

  const uniqueQuery = [...new Set(query.tokens)];

  const matches = [];
  for (const document of indexed) {
    let matchedTerms = 0;
    for (const token of uniqueQuery) if (document.tokenSet.has(token)) matchedTerms++;
    const literal = document.text.includes(query.raw);
    if (!literal && matchedTerms !== uniqueQuery.length) continue;
    const coveragePpm = Math.floor(1_000_000 * matchedTerms / uniqueQuery.length);
    let matchedPairs = 0;
    for (let index = 0; index + 1 < query.tokens.length; index++) {
      if (containsPair(document.tokens, query.tokens[index], query.tokens[index + 1])) matchedPairs++;
    }
    const adjacencyPpm = query.tokens.length === 1
      ? coveragePpm
      : Math.floor(1_000_000 * matchedPairs / (query.tokens.length - 1));
    const lexicalPpm = Math.floor((85 * coveragePpm + 15 * adjacencyPpm) / 100);
    const scorePpm = literal
      ? 500_000 + Math.floor(499_999 * lexicalPpm / 1_000_000)
      : Math.floor(499_999 * lexicalPpm / 1_000_000);
    matches.push({
      ...document,
      method: literal ? 'exact' : 'lexical',
      matchedTerms,
      scorePpm,
    });
  }

  matches.sort((left, right) => (
    right.scorePpm - left.scorePpm
    || right.matchedTerms - left.matchedTerms
    || left.tokens.length - right.tokens.length
    || compareStable(left.stableKey, right.stableKey)
  ));
  return {
    sourceTextBytes,
    indexBytes,
    indexTokens,
    matched: matches.length,
    selected: matches.slice(0, limit),
  };
}

async function searchMemory(ledger, input, options, mode) {
  if (!isMemoryLedger(ledger)) throw retrievalError('ledger must be a live Fieldwork memory ledger');
  const limits = limitsFrom(options, 'memory');
  const request = searchRequest(input, limits);
  const viewMode = mode === 'history' ? 'history' : 'current';
  const view = await ledger.retrievalView({ mode: viewMode, maxCandidates: limits.maxCandidates });
  const considered = view.rows.map(row => ({ row, lifecycleStatus: memoryLifecycleStatus(row.record.lifecycle, limits.now) }));
  const included = considered.filter(item => mode === 'history'
    || (mode === 'current' ? item.lifecycleStatus.eligible : item.lifecycleStatus.due));
  const documents = included.map(({ row, lifecycleStatus }) => ({
    ...row,
    lifecycleStatus,
    text: row.record.text,
    stableKey: `memory\0${row.logicalId}\0${row.record.fingerprint}`,
  }));
  const ranked = rankDocuments(documents, request.query, limits, request.limit);
  const results = ranked.selected.map((match, index) => deepFreeze({
    record: match.record,
    state: match.state,
    logicalId: match.logicalId,
    revisionSequence: match.revisionSequence,
    currentFingerprint: match.currentFingerprint,
    active: match.active,
    lastSequence: match.lastSequence,
    lifecycleStatus: match.lifecycleStatus,
    match: {
      method: match.method,
      queryHash: request.query.hash,
      rank: index + 1,
      score: match.scorePpm / 1_000_000,
      scorePpm: match.scorePpm,
    },
  }));
  const receipt = deepFreeze({
    format: MEMORY_RETRIEVAL_RECEIPT_FORMAT,
    mode,
    query: publicQuery(request.query),
    ledger: {
      format: view.receipt.format,
      ledgerId: view.ledgerId,
      events: view.receipt.events,
      head: view.receipt.head,
    },
    index: memoryIndexEdge(view),
    corpus: {
      candidates: documents.length,
      sourceTextBytes: ranked.sourceTextBytes,
      indexBytes: ranked.indexBytes,
      indexTokens: ranked.indexTokens,
    },
    lifecycle: {
      asOf: limits.now,
      considered: considered.length,
      included: documents.length,
      scheduled: considered.filter(item => item.lifecycleStatus.phase === 'scheduled').length,
      expired: considered.filter(item => item.lifecycleStatus.phase === 'expired').length,
      due: considered.filter(item => item.lifecycleStatus.due).length,
    },
    matched: ranked.matched,
    returned: results.length,
    omittedByLimit: ranked.matched - results.length,
    limit: request.limit,
    complete: true,
  });
  const search = deepFreeze({ results, receipt });
  memorySearches.add(search);
  memorySearchLedgers.set(search, ledger);
  return search;
}

export function searchCurrentMemories(ledger, input, options = {}) {
  return searchMemory(ledger, input, options, 'current');
}

export function searchDueMemories(ledger, input, options = {}) {
  return searchMemory(ledger, input, options, 'due');
}

// The newest memories, by when each was last written, without a query.
export async function recentMemories(ledger, { mode = 'current', limit = 20, now = new Date().toISOString() } = {}) {
  if (!isMemoryLedger(ledger)) throw retrievalError('ledger must be a live Fieldwork memory ledger');
  if (!['current', 'history', 'due'].includes(mode)) throw retrievalError('mode must be current, due or history');
  const asOf = exactInstant(now, 'now');
  const viewMode = mode === 'history' ? 'history' : 'current';
  const view = await ledger.retrievalView({ mode: viewMode, maxCandidates: RETRIEVAL_LIMITS.maxCandidates });
  const considered = view.rows.map(row => ({ ...row, lifecycleStatus: memoryLifecycleStatus(row.record.lifecycle, asOf) }));
  const included = considered.filter(row => mode === 'history'
    || (mode === 'current' ? row.lifecycleStatus.eligible : row.lifecycleStatus.due));
  const rows = included.sort((a, b) => mode === 'due'
    ? (a.lifecycleStatus.dueAt ?? '').localeCompare(b.lifecycleStatus.dueAt ?? '') || b.lastSequence - a.lastSequence
    : b.lastSequence - a.lastSequence).slice(0, Math.max(1, Math.min(limit, 100)));
  return deepFreeze({
    results: rows.map((row, index) => ({
      record: row.record, state: row.state, logicalId: row.logicalId, revisionSequence: row.revisionSequence,
      currentFingerprint: row.currentFingerprint, active: row.active, lastSequence: row.lastSequence,
      lifecycleStatus: row.lifecycleStatus,
      match: { method: 'recent', rank: index + 1 },
    })),
    receipt: {
      format: MEMORY_RETRIEVAL_RECEIPT_FORMAT, mode, recent: true,
      ledger: { format: view.receipt.format, ledgerId: view.ledgerId, events: view.receipt.events, head: view.receipt.head },
      index: memoryIndexEdge(view),
      candidates: view.rows.length, returned: rows.length,
      lifecycle: {
        asOf, considered: considered.length, included: included.length,
        scheduled: considered.filter(row => row.lifecycleStatus.phase === 'scheduled').length,
        expired: considered.filter(row => row.lifecycleStatus.phase === 'expired').length,
        due: considered.filter(row => row.lifecycleStatus.due).length,
      },
    },
  });
}

export function searchMemoryHistory(ledger, input, options = {}) {
  return searchMemory(ledger, input, options, 'history');
}

function exactInstant(value, where) {
  if (typeof value !== 'string') throw retrievalError(`${where} must be an exact ISO timestamp`);
  let normalized = '';
  try { normalized = new Date(value).toISOString(); } catch { /* Rejected below. */ }
  if (normalized !== value) throw retrievalError(`${where} must be an exact ISO timestamp`);
  return value;
}

function portable(value, where) {
  if (typeof value !== 'string' || !portableId.test(value)) throw retrievalError(`${where} must be 1-128 portable identifier characters`);
  return value;
}

function messageTextBlocks(message, maximumCandidates) {
  const content = Object.getOwnPropertyDescriptor(message, 'content')?.value;
  let candidates = 0;
  if (typeof content === 'string') candidates = 1;
  else if (Array.isArray(content)) {
    const length = Object.getOwnPropertyDescriptor(content, 'length')?.value;
    if (Number.isSafeInteger(length) && length >= 0) candidates = length;
  }
  if (candidates > maximumCandidates) {
    throw retrievalError(`message content contains ${candidates} projection candidates; the limit is ${maximumCandidates}`);
  }
  let projection;
  try { projection = projectMessageText(content, { where: 'archived message.content', nullable: true }); }
  catch (error) { throw retrievalError(`archived message text projection failed: ${error.message}`, error); }
  return {
    candidates,
    blocks: projection.blocks.map(block => ({
      ...block,
      path: block.path ? `content${block.path}` : 'content',
    })),
  };
}

function excerptFor(block, query, maximum) {
  const unitIndex = block.indexOf(query);
  if (unitIndex < 0) return null;
  const blockCharacters = [...block];
  const queryCharacters = [...query];
  const matchStart = [...block.slice(0, unitIndex)].length;
  const matchEnd = matchStart + queryCharacters.length;
  if (blockCharacters.length <= maximum) {
    return { excerpt: block, start: 0, end: blockCharacters.length, matchStart, matchEnd, completeBlock: true };
  }
  const spare = maximum - queryCharacters.length;
  let start = Math.max(0, matchStart - Math.floor(spare / 2));
  let end = start + maximum;
  if (end > blockCharacters.length) {
    end = blockCharacters.length;
    start = end - maximum;
  }
  return {
    excerpt: blockCharacters.slice(start, end).join(''),
    start,
    end,
    matchStart,
    matchEnd,
    completeBlock: false,
  };
}

export async function retrieveConversationEvidence(archive, input, options = {}) {
  if (!isConversationArchive(archive)) throw retrievalError('archive must be a live Fieldwork conversation archive');
  const limits = limitsFrom(options, 'conversation');
  const raw = fields(input, ['conversationId', 'messageId', 'query', 'retrievedAt', 'limit'], 'conversation retrieval request');
  const conversationId = portable(raw.conversationId, 'conversationId');
  const messageId = portable(raw.messageId, 'messageId');
  const query = queryFrom(raw.query, limits);
  const retrievedAt = exactInstant(raw.retrievedAt, 'retrievedAt');
  const limit = whole(raw.limit, 1, limits.maxResults, 'conversation retrieval request.limit');
  if (query.characters > limits.maxExcerptCharacters) throw retrievalError('query is longer than maxExcerptCharacters and cannot be returned exactly');
  const lookup = await archive.lookup(conversationId, messageId);
  if (!lookup.entry) {
    const search = deepFreeze({
      results: [],
      receipt: {
        format: CONVERSATION_RETRIEVAL_RECEIPT_FORMAT,
        method: 'exact',
        query: publicQuery(query),
        source: lookup.receipt,
        textProjection: MESSAGE_TEXT_PROJECTION_FORMAT,
        projection: { candidates: 0, textBlocks: 0, sourceBytes: 0 },
        matchedBlocks: 0,
        returned: 0,
        omittedByLimit: 0,
        limit,
        complete: true,
      },
    });
    conversationSearches.add(search);
    return search;
  }

  const projection = messageTextBlocks(lookup.entry.message, limits.maxCandidates);
  const blocks = projection.blocks;
  let sourceBytes = 0;
  for (const block of blocks) {
    sourceBytes += encoder.encode(block.text).length;
    if (sourceBytes > limits.maxSourceBytes) {
      throw retrievalError(`message text projection exceeds the ${limits.maxSourceBytes}-byte source limit`);
    }
  }
  const matches = [];
  for (const block of blocks) {
    const excerpt = excerptFor(block.text, query.raw, limits.maxExcerptCharacters);
    if (excerpt) matches.push({ block, ...excerpt });
  }
  const results = matches.slice(0, limit).map((match, index) => {
    const evidence = createRetrievedEvidence({
      source: lookup.source,
      excerpt: match.excerpt,
      retrievedAt,
      retrieval: { method: 'exact', queryHash: query.hash, rank: index + 1, score: 1 },
    });
    return deepFreeze({
      evidence,
      match: {
        block: match.block.index,
        path: match.block.path,
        excerptStartCharacter: match.start,
        excerptEndCharacter: match.end,
        matchStartCharacter: match.matchStart,
        matchEndCharacter: match.matchEnd,
        completeBlock: match.completeBlock,
      },
      sourceVerification: lookup.receipt,
    });
  });
  const receipt = deepFreeze({
    format: CONVERSATION_RETRIEVAL_RECEIPT_FORMAT,
    method: 'exact',
    query: publicQuery(query),
    source: lookup.receipt,
    textProjection: MESSAGE_TEXT_PROJECTION_FORMAT,
    projection: { candidates: projection.candidates, textBlocks: blocks.length, sourceBytes },
    matchedBlocks: matches.length,
    returned: results.length,
    omittedByLimit: matches.length - results.length,
    limit,
    complete: true,
  });
  const search = deepFreeze({ results, receipt });
  conversationSearches.add(search);
  return search;
}

function strictArray(value, where, maximum = 1000) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw retrievalError(`${where} must be an array`);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw retrievalError(`${where} may contain at most ${maximum} entries`);
  const keys = Reflect.ownKeys(value).filter(key => key !== 'length');
  if (keys.length !== length || keys.some(key => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length)) {
    throw retrievalError(`${where} must contain only contiguous indexed entries`);
  }
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw retrievalError(`${where}[${index}] must be an enumerable data property`);
    result.push(descriptor.value);
  }
  return result;
}

function contextLimitsFrom(value) {
  if (value === undefined) return RETRIEVAL_CONTEXT_LIMITS;
  const raw = fields(value, ['maxSearches', 'maxResults', 'maxSourceBytes'], 'retrieval context limits');
  return Object.freeze({
    maxSearches: whole(raw.maxSearches, RETRIEVAL_CONTEXT_LIMITS.maxSearches, RETRIEVAL_CONTEXT_LIMITS.maxSearches, 'retrieval context limits.maxSearches'),
    maxResults: whole(raw.maxResults, RETRIEVAL_CONTEXT_LIMITS.maxResults, RETRIEVAL_CONTEXT_LIMITS.maxResults, 'retrieval context limits.maxResults'),
    maxSourceBytes: whole(raw.maxSourceBytes, RETRIEVAL_CONTEXT_LIMITS.maxSourceBytes, RETRIEVAL_CONTEXT_LIMITS.maxSourceBytes, 'retrieval context limits.maxSourceBytes'),
  });
}

export async function renderRetrievalContext(input, options = {}) {
  const raw = fields(input, ['conversation', 'memory', 'limits', 'asOf'], 'retrieval context input');
  const limits = contextLimitsFrom(raw.limits);
  const asOf = exactInstant(raw.asOf ?? new Date().toISOString(), 'retrieval context input.asOf');
  const conversation = strictArray(raw.conversation, 'retrieval context input.conversation', limits.maxSearches);
  const memory = strictArray(raw.memory, 'retrieval context input.memory', limits.maxSearches);
  if (conversation.length + memory.length > limits.maxSearches) {
    throw retrievalError(`retrieval context contains more than ${limits.maxSearches} searches`);
  }
  const currentReceipts = new Map();
  const validatedMemory = [];
  for (const search of memory) {
    if (!memorySearches.has(search) || search.receipt.mode !== 'current') {
      throw retrievalError('memory context accepts only current-memory retrievals');
    }
    const ledger = memorySearchLedgers.get(search);
    if (!ledger) throw retrievalError('current-memory retrieval has no live ledger witness');
    validatedMemory.push({ search, ledger });
  }
  for (const search of conversation) {
    if (!conversationSearches.has(search)) throw retrievalError('conversation retrievals must be returned by retrieveConversationEvidence()');
  }
  const freshnessChecks = [];
  for (const { search, ledger } of validatedMemory) {
    let receiptPromise = currentReceipts.get(ledger);
    if (!receiptPromise) {
      receiptPromise = readLiveMemoryLedgerReceipt(ledger);
      currentReceipts.set(ledger, receiptPromise);
    }
    freshnessChecks.push(receiptPromise.then(receipt => {
      const expected = search.receipt.ledger;
      if (receipt.ledgerId !== expected.ledgerId || receipt.events !== expected.events || receipt.head !== expected.head) {
        throw retrievalError('current-memory retrieval is stale; search again before rendering context');
      }
      if (search.results.some(result => !memoryLifecycleStatus(result.record.lifecycle, asOf).eligible)) {
        throw retrievalError('current-memory retrieval crossed a lifecycle clock; search again before rendering context');
      }
    }));
  }
  await Promise.all(freshnessChecks);
  const evidence = [], observations = [], memories = [], summaries = [];
  const evidenceSeen = new Set(), memorySeen = new Set();
  const selection = {
    evidence: { input: 0, unique: 0, deduplicated: 0 },
    observation: { input: 0, unique: 0, deduplicated: 0 },
    memory: { input: 0, unique: 0, deduplicated: 0 },
    summary: { input: 0, unique: 0, deduplicated: 0 },
  };
  let resultCount = 0;
  let sourceBytes = 0;
  const account = value => {
    resultCount++;
    if (resultCount > limits.maxResults) {
      throw retrievalError(`retrieval context contains more than ${limits.maxResults} results`);
    }
    sourceBytes += encoder.encode(canonicalJson(value)).length;
    if (sourceBytes > limits.maxSourceBytes) {
      throw retrievalError(`retrieval context source data exceeds ${limits.maxSourceBytes} bytes`);
    }
  };
  for (const search of conversation) {
    for (const result of search.results) {
      if (!isRetrievedEvidence(result.evidence)) throw retrievalError('conversation retrieval result contains invalid evidence');
      account(result.evidence);
      selection.evidence.input++;
      if (!evidenceSeen.has(result.evidence.fingerprint)) {
        evidenceSeen.add(result.evidence.fingerprint);
        evidence.push(result.evidence);
        selection.evidence.unique++;
      } else {
        selection.evidence.deduplicated++;
      }
    }
  }
  for (const search of memory) {
    for (const result of search.results) {
      const record = result.record;
      account(record);
      const type = record.kind === 'authored-memory' ? 'memory' : record.kind;
      if (!Object.hasOwn(selection, type)) throw retrievalError(`unsupported memory kind ${JSON.stringify(record.kind)}`);
      selection[type].input++;
      if (memorySeen.has(record.fingerprint)) {
        selection[type].deduplicated++;
        continue;
      }
      memorySeen.add(record.fingerprint);
      selection[type].unique++;
      if (type === 'observation') observations.push(record);
      else if (type === 'memory') memories.push(record);
      else summaries.push(record);
    }
  }
  const rendered = renderMemoryContext({ evidence, observations, memories, summaries }, options);
  return deepFreeze({
    text: rendered.text,
    receipt: {
      format: RETRIEVAL_CONTEXT_RECEIPT_FORMAT,
      retrieval: {
        conversation: conversation.map(search => search.receipt),
        memory: memory.map(search => search.receipt),
      },
      limits,
      asOf,
      selection: { ...selection, results: resultCount, sourceBytes },
      context: rendered.receipt,
    },
  });
}
