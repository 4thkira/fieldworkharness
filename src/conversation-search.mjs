import { createHash } from 'node:crypto';
import { isConversationArchive } from './conversation-archive.mjs';
import { projectMessageText } from './message-content.mjs';
import { messageOrigin } from './message-origin.mjs';
import { createRetrievedEvidence } from './provenance.mjs';

// On-demand lexical search over the verified conversation archive. Nothing is
// injected automatically: the agent has to ask, and every returned excerpt
// keeps the exact archived message as its source.

export const CONVERSATION_SEARCH_LIMITS = Object.freeze({
  queryCharacters: 200,
  results: 20,
  excerptCharacters: 1200,
});

function searchError(message) {
  return new Error(`Conversation search: ${message}`);
}

function exactText(value, maximum, where) {
  if (typeof value !== 'string') throw searchError(`${where} must be text`);
  const text = value.trim();
  if (!text) throw searchError(`${where} must not be empty`);
  if ([...text].length > maximum) throw searchError(`${where} is at most ${maximum} characters`);
  return text;
}

function exactInstant(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw searchError('clock returned an invalid time');
  return date.toISOString();
}

function normalized(value) {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function termsFor(query) {
  const words = normalized(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.length ? words : [normalized(query)])];
}

function textMatches(text, query, terms) {
  const haystack = normalized(text);
  const haystackTerms = new Set(haystack.match(/[\p{L}\p{N}]+/gu) ?? []);
  const phrase = normalized(query);
  const structuredPhrase = !/[\p{L}\p{N}]/u.test(phrase) || terms.length > 1 || terms[0] !== phrase;
  return (structuredPhrase && haystack.includes(phrase)) || terms.every(term => haystackTerms.has(term));
}

function exactExcerpt(text, terms) {
  const characters = [...text];
  if (characters.length <= CONVERSATION_SEARCH_LIMITS.excerptCharacters) return text;
  const lowered = text.toLocaleLowerCase('und');
  const firstTerm = terms.find(term => lowered.includes(term)) ?? '';
  const codeUnitIndex = firstTerm ? lowered.indexOf(firstTerm) : 0;
  const characterIndex = [...text.slice(0, Math.max(0, codeUnitIndex))].length;
  const before = Math.floor(CONVERSATION_SEARCH_LIMITS.excerptCharacters / 3);
  const start = Math.max(0, Math.min(characterIndex - before, characters.length - CONVERSATION_SEARCH_LIMITS.excerptCharacters));
  return characters.slice(start, start + CONVERSATION_SEARCH_LIMITS.excerptCharacters).join('');
}

function portableConversationId(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw searchError('conversationId must be a portable conversation identifier');
  }
  return value;
}

export async function searchConversationArchive(archive, input = {}, { clock = () => new Date() } = {}) {
  if (!isConversationArchive(archive)) throw searchError('a live Fieldwork conversation archive is required');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw searchError('input must be an object');
  const allowed = new Set(['query', 'speaker', 'conversationId', 'beforeSequence', 'limit']);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw searchError(`unknown input ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw searchError(`${key} must be an enumerable data property`);
  }
  const query = exactText(input.query, CONVERSATION_SEARCH_LIMITS.queryCharacters, 'query');
  const speaker = input.speaker ?? 'either';
  if (!['person', 'agent', 'either'].includes(speaker)) throw searchError('speaker must be person, agent, or either');
  const conversationId = portableConversationId(input.conversationId);
  const beforeSequence = input.beforeSequence ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 2) throw searchError('beforeSequence must be a whole archive sequence of 2 or greater');
  const limit = input.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_SEARCH_LIMITS.results) {
    throw searchError(`limit must be a whole number from 1 to ${CONVERSATION_SEARCH_LIMITS.results}`);
  }

  const terms = termsFor(query);
  const snapshot = await archive.snapshot();
  const lifecycleByConversation = new Map((snapshot.lifecycles ?? []).map(row => [row.conversationId, row]));
  const candidates = snapshot.messages
    .filter(row => row.sequence < beforeSequence && (!conversationId || row.conversationId === conversationId))
    .sort((left, right) => right.sequence - left.sequence);
  const found = [];
  let searchedMessages = 0;
  let lastSequence = null;
  let stoppedAt = candidates.length;

  for (let index = 0; index < candidates.length; index += 1) {
    const row = candidates[index];
    lastSequence = row.sequence;
    searchedMessages += 1;
    const verified = await archive.lookup(row.conversationId, row.messageId);
    if (!verified.entry) throw searchError(`archived message ${row.messageId} disappeared during search`);
    const message = verified.entry.message;
    if (!['user', 'assistant'].includes(message.role)) continue;
    const origin = messageOrigin(message);
    // Room-authored check-in/free-time prompts are dividers, not something the
    // person said. Their resulting assistant messages remain searchable.
    if (message.role === 'user' && origin && origin.kind !== 'bridge') continue;
    const who = message.role === 'assistant' ? 'agent' : 'person';
    if (speaker !== 'either' && speaker !== who) continue;
    let text = '';
    try {
      text = projectMessageText(message.content, {
        where: 'archived conversation message.content', nullable: message.role === 'assistant',
      }).blocks.map(block => block.text).join('\n\n');
    } catch { continue; }
    if (!text || !textMatches(text, query, terms)) continue;
    found.push({
      conversationId: row.conversationId,
      messageId: row.messageId,
      observedAt: verified.entry.observedAt,
      speaker: who,
      archived: lifecycleByConversation.get(row.conversationId)?.archived === true,
      excerpt: exactExcerpt(text, terms),
      source: verified.source,
      ...(origin?.kind === 'bridge' ? { via: origin.platform } : {}),
    });
    if (found.length >= limit) { stoppedAt = index + 1; break; }
  }

  const complete = stoppedAt >= candidates.length;
  const queryHash = createHash('sha256')
    .update(`fieldwork-conversation-search/v1\0${speaker}\0${conversationId ?? ''}\0${normalized(query)}`, 'utf8')
    .digest('hex');
  const retrievedAt = exactInstant(clock);
  const results = found.map((row, index) => ({
    conversationId: row.conversationId,
    messageId: row.messageId,
    observedAt: row.observedAt,
    speaker: row.speaker,
    archived: row.archived,
    ...(row.via ? { via: row.via } : {}),
    evidence: createRetrievedEvidence({
      source: row.source,
      excerpt: row.excerpt,
      retrievedAt,
      retrieval: { method: 'exact', queryHash, rank: index + 1 },
    }),
  }));

  return {
    returned: results.length,
    searchedMessages,
    complete,
    ...(complete || lastSequence === null ? {} : { nextBeforeSequence: lastSequence }),
    results,
    note: 'These are exact archived excerpts with source receipts, not memories. Search again with nextBeforeSequence to continue farther back.',
  };
}

export function conversationSearchTools({ archive, clock = () => new Date() } = {}) {
  if (!isConversationArchive(archive)) throw searchError('conversationSearchTools needs a live Fieldwork conversation archive');
  return [{
    name: 'search_conversations',
    description: 'Search exact words or a short phrase across saved conversations. Results are source-attributed excerpts, not memories. Use speaker or conversationId to narrow it; if nextBeforeSequence is returned, pass it back to continue farther into the archive.',
    effect: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: CONVERSATION_SEARCH_LIMITS.queryCharacters, description: 'Distinctive exact words or a short phrase.' },
        speaker: { type: 'string', enum: ['person', 'agent', 'either'], description: 'Whose visible words to search. Default: either.' },
        conversationId: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional exact conversation id from an earlier result.' },
        beforeSequence: { type: 'integer', minimum: 2, description: 'Optional pagination cursor returned by an earlier search.' },
        limit: { type: 'integer', minimum: 1, maximum: CONVERSATION_SEARCH_LIMITS.results, description: 'How many newest matches to return. Default: 8.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute(input) { return searchConversationArchive(archive, input, { clock }); },
  }];
}
