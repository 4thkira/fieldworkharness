import { createHash, randomUUID } from 'node:crypto';
import { openDurableLog } from './durable-log.mjs';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';
import { createSourceReference, isSourceReference } from './provenance.mjs';

export const CONVERSATION_ARCHIVE_EVENT_FORMAT = 'fieldwork-conversation-archive-event/v1';
export const CONVERSATION_ENTRY_FORMAT = 'fieldwork-conversation-entry/v1';
export const CONVERSATION_ARCHIVE_SNAPSHOT_FORMAT = 'fieldwork-conversation-archive-snapshot/v1';
export const CONVERSATION_SOURCE_ID_FORMAT = 'fieldwork-conversation-source-id/v1';
export const CONVERSATION_LOOKUP_RECEIPT_FORMAT = 'fieldwork-conversation-lookup/v1';
export const CONVERSATION_ARCHIVE_LIMITS = Object.freeze({
  messageBytes: 1024 * 1024,
  eventBytes: 1536 * 1024,
  lineBytes: 2 * 1024 * 1024,
  titleCharacters: 80,
});

const archives = new WeakSet();
const entries = new WeakSet();
const portableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function archiveError(message, cause) {
  return new Error(`Conversation archive: ${message}`, cause === undefined ? undefined : { cause });
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw archiveError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw archiveError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw archiveError(`${where}.${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function id(value, where) {
  if (typeof value !== 'string' || !portableId.test(value)) throw archiveError(`${where} must be 1-128 portable identifier characters`);
  return value;
}

function title(value, where) {
  if (typeof value !== 'string' || (typeof value.isWellFormed === 'function' && !value.isWellFormed())) {
    throw archiveError(`${where} must be well-formed text`);
  }
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const characters = [...normalized];
  const hasVisibleCharacter = /[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized);
  if (!characters.length || characters.length > CONVERSATION_ARCHIVE_LIMITS.titleCharacters || /\p{Cc}/u.test(normalized) || !hasVisibleCharacter) {
    throw archiveError(`${where} must be 1-${CONVERSATION_ARCHIVE_LIMITS.titleCharacters} visible characters`);
  }
  return normalized;
}

function nullableTitle(value, where) {
  return value === null ? null : title(value, where);
}

function titleActor(value, where) {
  if (!['person', 'agent', 'system'].includes(value)) {
    throw archiveError(`${where} must be person, agent, or system`);
  }
  return value;
}

function titleRevision(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) throw archiveError(`${where} must be a nonnegative whole number`);
  return value;
}

function titleConflict(expected, current) {
  const error = archiveError(`title revision conflict: expected ${expected}, current ${current}`);
  Object.defineProperty(error, 'status', { value: 409, enumerable: true });
  return error;
}

function lifecycleStatus(value, where) {
  if (!['active', 'archived'].includes(value)) throw archiveError(`${where} must be active or archived`);
  return value;
}

function lifecycleConflict(expected, current) {
  const error = archiveError(`lifecycle revision conflict: expected ${expected}, current ${current}`);
  Object.defineProperty(error, 'status', { value: 409, enumerable: true });
  return error;
}

function proactiveMode(value, where) {
  if (!['allow', 'suppress'].includes(value)) throw archiveError(`${where} must be allow or suppress`);
  return value;
}

function proactiveConflict(expected, current) {
  const error = archiveError(`proactive revision conflict: expected ${expected}, current ${current}`);
  Object.defineProperty(error, 'status', { value: 409, enumerable: true });
  return error;
}

function instant(value, where) {
  if (typeof value !== 'string') throw archiveError(`${where} must be an exact ISO timestamp`);
  let normalized = '';
  try { normalized = new Date(value).toISOString(); } catch { /* Rejected below. */ }
  if (normalized !== value) throw archiveError(`${where} must be an exact ISO timestamp`);
  return value;
}

function entryKey(conversationId, messageId) {
  return `${conversationId}\u0000${messageId}`;
}

function entryBase(raw, message) {
  const messageSha256 = sha256(canonicalJson(message));
  return {
    format: CONVERSATION_ENTRY_FORMAT,
    conversationId: id(raw.conversationId, 'conversationId'),
    messageId: id(raw.messageId, 'messageId'),
    observedAt: instant(raw.observedAt, 'observedAt'),
    message,
    messageSha256,
  };
}

export function isConversationEntry(value) {
  return Boolean(value) && entries.has(value);
}

export function createConversationEntry(input) {
  const raw = fields(input, ['conversationId', 'messageId', 'observedAt', 'message'], 'conversation entry');
  let message;
  try {
    message = boundedJson(raw.message, {
      where: 'conversation entry.message', object: true,
      maxBytes: CONVERSATION_ARCHIVE_LIMITS.messageBytes, maxDepth: 64, maxNodes: 200_000,
    }).value;
  } catch (error) {
    throw archiveError(error.message, error);
  }
  const base = entryBase(raw, message);
  const entry = deepFreeze({ ...base, fingerprint: sha256(canonicalJson(base)) });
  entries.add(entry);
  return entry;
}

export function restoreConversationEntry(input) {
  let normalized;
  try {
    normalized = boundedJson(input, {
      where: 'stored conversation entry', object: true,
      maxBytes: CONVERSATION_ARCHIVE_LIMITS.eventBytes, maxDepth: 64, maxNodes: 200_000,
    }).value;
  } catch (error) {
    throw archiveError(error.message, error);
  }
  const raw = fields(normalized, [
    'format', 'conversationId', 'messageId', 'observedAt', 'message', 'messageSha256', 'fingerprint',
  ], 'stored conversation entry');
  if (raw.format !== CONVERSATION_ENTRY_FORMAT) throw archiveError(`stored conversation entry.format must be ${CONVERSATION_ENTRY_FORMAT}`);
  if (typeof raw.messageSha256 !== 'string' || !hashPattern.test(raw.messageSha256)) throw archiveError('stored conversation entry.messageSha256 must be a lowercase SHA-256 hash');
  if (typeof raw.fingerprint !== 'string' || !hashPattern.test(raw.fingerprint)) throw archiveError('stored conversation entry.fingerprint must be a lowercase SHA-256 hash');
  const restored = createConversationEntry({
    conversationId: raw.conversationId,
    messageId: raw.messageId,
    observedAt: raw.observedAt,
    message: raw.message,
  });
  if (restored.messageSha256 !== raw.messageSha256) throw archiveError('stored conversation entry message hash does not match its contents');
  if (restored.fingerprint !== raw.fingerprint) throw archiveError('stored conversation entry fingerprint does not match its contents');
  return restored;
}

function newState() {
  return {
    sawGenesis: false,
    messages: new Map(),
    titles: new Map(),
    lifecycles: new Map(),
    proactivePolicies: new Map(),
  };
}

function sourceFor(archiveId, entry) {
  return createSourceReference({
    kind: 'conversation',
    id: `${CONVERSATION_SOURCE_ID_FORMAT};archive=${archiveId};conversation=${entry.conversationId}`,
    locator: entry.messageId,
    sha256: entry.messageSha256,
    observedThrough: entry.observedAt,
  });
}

function applyEvent(event, state) {
  if (event.type === 'archive_created') {
    if (event.sequence !== 1 || state.sawGenesis) throw archiveError('archive_created must be the first and only genesis event');
    const raw = fields(event.data, ['entryFormat', 'sourceIdFormat'], 'archive_created data');
    if (raw.entryFormat !== CONVERSATION_ENTRY_FORMAT) throw archiveError(`archive_created entryFormat must be ${CONVERSATION_ENTRY_FORMAT}`);
    if (raw.sourceIdFormat !== CONVERSATION_SOURCE_ID_FORMAT) throw archiveError(`archive_created sourceIdFormat must be ${CONVERSATION_SOURCE_ID_FORMAT}`);
    state.sawGenesis = true;
    return;
  }
  if (!state.sawGenesis) throw archiveError('the conversation archive has no valid genesis event');
  if (event.type === 'conversation_titled') {
    const raw = fields(event.data, [
      'conversationId', 'title', 'actor', 'conversationCreatedAt', 'conversationUpdatedAt',
    ], 'conversation_titled data');
    const conversationId = id(raw.conversationId, 'conversation_titled data.conversationId');
    const previous = state.titles.get(conversationId);
    const conversationCreatedAt = instant(raw.conversationCreatedAt, 'conversation_titled data.conversationCreatedAt');
    const conversationUpdatedAt = instant(raw.conversationUpdatedAt, 'conversation_titled data.conversationUpdatedAt');
    if (conversationUpdatedAt < conversationCreatedAt) {
      throw archiveError('conversation_titled data.conversationUpdatedAt cannot be before conversationCreatedAt');
    }
    if (previous && previous.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_titled data.conversationCreatedAt cannot change');
    }
    const lifecycle = state.lifecycles.get(conversationId);
    if (lifecycle && lifecycle.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_titled data.conversationCreatedAt conflicts with conversation lifecycle');
    }
    const proactive = state.proactivePolicies.get(conversationId);
    if (proactive && proactive.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_titled data.conversationCreatedAt conflicts with conversation proactive policy');
    }
    state.titles.set(conversationId, {
      conversationId,
      title: nullableTitle(raw.title, 'conversation_titled data.title'),
      customTitle: raw.title !== null,
      titleRevision: event.sequence,
      titleBy: titleActor(raw.actor, 'conversation_titled data.actor'),
      conversationCreatedAt,
      conversationUpdatedAt,
      at: event.at,
      sequence: event.sequence,
    });
    return;
  }
  if (event.type === 'conversation_lifecycle_changed') {
    const raw = fields(event.data, [
      'conversationId', 'status', 'actor', 'conversationCreatedAt', 'conversationUpdatedAt',
    ], 'conversation_lifecycle_changed data');
    const conversationId = id(raw.conversationId, 'conversation_lifecycle_changed data.conversationId');
    const previous = state.lifecycles.get(conversationId);
    const conversationCreatedAt = instant(raw.conversationCreatedAt, 'conversation_lifecycle_changed data.conversationCreatedAt');
    const conversationUpdatedAt = instant(raw.conversationUpdatedAt, 'conversation_lifecycle_changed data.conversationUpdatedAt');
    if (conversationUpdatedAt < conversationCreatedAt) {
      throw archiveError('conversation_lifecycle_changed data.conversationUpdatedAt cannot be before conversationCreatedAt');
    }
    if (previous && previous.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_lifecycle_changed data.conversationCreatedAt cannot change');
    }
    const titled = state.titles.get(conversationId);
    if (titled && titled.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_lifecycle_changed data.conversationCreatedAt conflicts with conversation title');
    }
    const proactive = state.proactivePolicies.get(conversationId);
    if (proactive && proactive.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_lifecycle_changed data.conversationCreatedAt conflicts with conversation proactive policy');
    }
    const status = lifecycleStatus(raw.status, 'conversation_lifecycle_changed data.status');
    state.lifecycles.set(conversationId, {
      conversationId,
      status,
      archived: status === 'archived',
      lifecycleRevision: event.sequence,
      lifecycleBy: titleActor(raw.actor, 'conversation_lifecycle_changed data.actor'),
      conversationCreatedAt,
      conversationUpdatedAt,
      statusChangedAt: event.at,
      archivedAt: status === 'archived' ? event.at : null,
      sequence: event.sequence,
    });
    return;
  }
  if (event.type === 'conversation_proactive_changed') {
    const raw = fields(event.data, [
      'conversationId', 'mode', 'actor', 'conversationCreatedAt', 'conversationUpdatedAt',
    ], 'conversation_proactive_changed data');
    const conversationId = id(raw.conversationId, 'conversation_proactive_changed data.conversationId');
    const previous = state.proactivePolicies.get(conversationId);
    const conversationCreatedAt = instant(raw.conversationCreatedAt, 'conversation_proactive_changed data.conversationCreatedAt');
    const conversationUpdatedAt = instant(raw.conversationUpdatedAt, 'conversation_proactive_changed data.conversationUpdatedAt');
    if (conversationUpdatedAt < conversationCreatedAt) {
      throw archiveError('conversation_proactive_changed data.conversationUpdatedAt cannot be before conversationCreatedAt');
    }
    if (previous && previous.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_proactive_changed data.conversationCreatedAt cannot change');
    }
    const titled = state.titles.get(conversationId);
    if (titled && titled.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_proactive_changed data.conversationCreatedAt conflicts with conversation title');
    }
    const lifecycle = state.lifecycles.get(conversationId);
    if (lifecycle && lifecycle.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('conversation_proactive_changed data.conversationCreatedAt conflicts with conversation lifecycle');
    }
    state.proactivePolicies.set(conversationId, {
      conversationId,
      proactiveMode: proactiveMode(raw.mode, 'conversation_proactive_changed data.mode'),
      proactiveRevision: event.sequence,
      proactiveBy: titleActor(raw.actor, 'conversation_proactive_changed data.actor'),
      conversationCreatedAt,
      conversationUpdatedAt,
      proactiveChangedAt: event.at,
      sequence: event.sequence,
    });
    return;
  }
  if (event.type !== 'message_archived') throw archiveError(`unsupported archive event type ${JSON.stringify(event.type)}`);
  const raw = fields(event.data, ['entry'], 'message_archived data');
  let entry;
  try { entry = restoreConversationEntry(raw.entry); }
  catch (error) { throw archiveError(`message_archived entry is invalid: ${error.message}`, error); }
  const key = entryKey(entry.conversationId, entry.messageId);
  if (state.messages.has(key)) throw archiveError(`conflict: message ${JSON.stringify(entry.messageId)} already exists in conversation ${JSON.stringify(entry.conversationId)}`);
  const source = sourceFor(event.archiveId, entry);
  state.messages.set(key, {
    conversationId: entry.conversationId,
    messageId: entry.messageId,
    observedAt: entry.observedAt,
    messageSha256: entry.messageSha256,
    entryFingerprint: entry.fingerprint,
    sequence: event.sequence,
    source,
  });
}

function messageView(value) {
  return deepFreeze({ ...value });
}

async function buildArchive(log, state) {
  let operationQueue = Promise.resolve();
  let closing = false;
  let closePromise = null;
  let projectionFailure = null;

  const ensureHealthy = () => {
    if (projectionFailure) throw projectionFailure;
  };

  const appendAndApply = async (type, data) => {
    let event;
    try { event = await log.append(type, data); }
    catch (error) {
      if (error?.commitStatus !== 'not-written') {
        projectionFailure ??= error instanceof Error ? error : archiveError('durable append failed', error);
        throw projectionFailure;
      }
      throw error;
    }
    try { applyEvent(event, state); }
    catch (error) {
      const failure = archiveError('a durable event was written but the live archive projection failed; close and reopen before any further operation', error);
      Object.defineProperty(failure, 'event', {
        value: deepFreeze({ sequence: event.sequence, hash: event.hash, type: event.type }), enumerable: true,
      });
      projectionFailure = failure;
      throw failure;
    }
    return event;
  };

  const mutate = operation => {
    if (closing) return Promise.reject(archiveError('cannot append after close has begun'));
    const job = operationQueue.then(() => { ensureHealthy(); return operation(); });
    operationQueue = job.then(() => undefined, () => undefined);
    return job;
  };

  const inspect = operation => {
    if (closing) return Promise.reject(archiveError('cannot inspect after close has begun'));
    const job = operationQueue.then(() => { ensureHealthy(); return operation(); });
    operationQueue = job.then(() => undefined, () => undefined);
    return job;
  };

  const append = input => mutate(async () => {
    const entry = isConversationEntry(input) ? input : createConversationEntry(input);
    const key = entryKey(entry.conversationId, entry.messageId);
    if (state.messages.has(key)) throw archiveError(`conflict: message ${JSON.stringify(entry.messageId)} already exists in conversation ${JSON.stringify(entry.conversationId)}`);
    const event = await appendAndApply('message_archived', { entry });
    const indexed = state.messages.get(key);
    return deepFreeze({ entry, event, source: indexed.source });
  });

  const setTitle = input => mutate(async () => {
    const raw = fields(input, [
      'conversationId', 'title', 'expectedRevision', 'actor', 'conversationCreatedAt', 'conversationUpdatedAt',
    ], 'title change');
    const normalizedId = id(raw.conversationId, 'title change.conversationId');
    const normalizedTitle = nullableTitle(raw.title, 'title change.title');
    const expectedRevision = titleRevision(raw.expectedRevision, 'title change.expectedRevision');
    const current = state.titles.get(normalizedId);
    const currentRevision = current?.titleRevision ?? 0;
    if (expectedRevision !== currentRevision) throw titleConflict(expectedRevision, currentRevision);
    const actor = titleActor(raw.actor, 'title change.actor');
    const conversationCreatedAt = instant(raw.conversationCreatedAt, 'title change.conversationCreatedAt');
    const conversationUpdatedAt = instant(raw.conversationUpdatedAt, 'title change.conversationUpdatedAt');
    if (conversationUpdatedAt < conversationCreatedAt) {
      throw archiveError('title change.conversationUpdatedAt cannot be before conversationCreatedAt');
    }
    if (current && current.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('title change.conversationCreatedAt cannot change');
    }
    const lifecycle = state.lifecycles.get(normalizedId);
    if (lifecycle && lifecycle.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('title change.conversationCreatedAt conflicts with conversation lifecycle');
    }
    const proactive = state.proactivePolicies.get(normalizedId);
    if (proactive && proactive.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('title change.conversationCreatedAt conflicts with conversation proactive policy');
    }
    const event = await appendAndApply('conversation_titled', {
      conversationId: normalizedId,
      title: normalizedTitle,
      actor,
      conversationCreatedAt,
      conversationUpdatedAt,
    });
    return deepFreeze({ ...state.titles.get(normalizedId), event });
  });

  const setArchived = input => mutate(async () => {
    const raw = fields(input, [
      'conversationId', 'archived', 'expectedRevision', 'actor', 'conversationCreatedAt', 'conversationUpdatedAt',
    ], 'lifecycle change');
    const normalizedId = id(raw.conversationId, 'lifecycle change.conversationId');
    if (typeof raw.archived !== 'boolean') throw archiveError('lifecycle change.archived must be true or false');
    const expectedRevision = titleRevision(raw.expectedRevision, 'lifecycle change.expectedRevision');
    const current = state.lifecycles.get(normalizedId);
    const currentRevision = current?.lifecycleRevision ?? 0;
    if (expectedRevision !== currentRevision) throw lifecycleConflict(expectedRevision, currentRevision);
    const actor = titleActor(raw.actor, 'lifecycle change.actor');
    const conversationCreatedAt = instant(raw.conversationCreatedAt, 'lifecycle change.conversationCreatedAt');
    const conversationUpdatedAt = instant(raw.conversationUpdatedAt, 'lifecycle change.conversationUpdatedAt');
    if (conversationUpdatedAt < conversationCreatedAt) {
      throw archiveError('lifecycle change.conversationUpdatedAt cannot be before conversationCreatedAt');
    }
    if (current && current.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('lifecycle change.conversationCreatedAt cannot change');
    }
    const titled = state.titles.get(normalizedId);
    if (titled && titled.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('lifecycle change.conversationCreatedAt conflicts with conversation title');
    }
    const proactive = state.proactivePolicies.get(normalizedId);
    if (proactive && proactive.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('lifecycle change.conversationCreatedAt conflicts with conversation proactive policy');
    }
    const status = raw.archived ? 'archived' : 'active';
    if ((current?.status ?? 'active') === status) {
      return deepFreeze(current ? { ...current, event: null } : {
        conversationId: normalizedId,
        status: 'active',
        archived: false,
        lifecycleRevision: 0,
        lifecycleBy: null,
        conversationCreatedAt,
        conversationUpdatedAt,
        statusChangedAt: null,
        archivedAt: null,
        sequence: 0,
        event: null,
      });
    }
    const event = await appendAndApply('conversation_lifecycle_changed', {
      conversationId: normalizedId,
      status,
      actor,
      conversationCreatedAt,
      conversationUpdatedAt,
    });
    return deepFreeze({ ...state.lifecycles.get(normalizedId), event });
  });

  const setProactiveMode = input => mutate(async () => {
    const raw = fields(input, [
      'conversationId', 'mode', 'expectedRevision', 'actor', 'conversationCreatedAt', 'conversationUpdatedAt',
    ], 'proactive change');
    const normalizedId = id(raw.conversationId, 'proactive change.conversationId');
    const mode = proactiveMode(raw.mode, 'proactive change.mode');
    const expectedRevision = titleRevision(raw.expectedRevision, 'proactive change.expectedRevision');
    const current = state.proactivePolicies.get(normalizedId);
    const currentRevision = current?.proactiveRevision ?? 0;
    if (expectedRevision !== currentRevision) throw proactiveConflict(expectedRevision, currentRevision);
    const actor = titleActor(raw.actor, 'proactive change.actor');
    const conversationCreatedAt = instant(raw.conversationCreatedAt, 'proactive change.conversationCreatedAt');
    const conversationUpdatedAt = instant(raw.conversationUpdatedAt, 'proactive change.conversationUpdatedAt');
    if (conversationUpdatedAt < conversationCreatedAt) {
      throw archiveError('proactive change.conversationUpdatedAt cannot be before conversationCreatedAt');
    }
    if (current && current.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('proactive change.conversationCreatedAt cannot change');
    }
    const titled = state.titles.get(normalizedId);
    if (titled && titled.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('proactive change.conversationCreatedAt conflicts with conversation title');
    }
    const lifecycle = state.lifecycles.get(normalizedId);
    if (lifecycle && lifecycle.conversationCreatedAt !== conversationCreatedAt) {
      throw archiveError('proactive change.conversationCreatedAt conflicts with conversation lifecycle');
    }
    if ((current?.proactiveMode ?? 'allow') === mode) {
      return deepFreeze(current ? { ...current, event: null } : {
        conversationId: normalizedId,
        proactiveMode: 'allow',
        proactiveRevision: 0,
        proactiveBy: null,
        conversationCreatedAt,
        conversationUpdatedAt,
        proactiveChangedAt: null,
        sequence: 0,
        event: null,
      });
    }
    const event = await appendAndApply('conversation_proactive_changed', {
      conversationId: normalizedId,
      mode,
      actor,
      conversationCreatedAt,
      conversationUpdatedAt,
    });
    return deepFreeze({ ...state.proactivePolicies.get(normalizedId), event });
  });

  const reference = (conversationId, messageId) => inspect(async () => {
    id(conversationId, 'conversationId');
    id(messageId, 'messageId');
    return state.messages.get(entryKey(conversationId, messageId))?.source ?? null;
  });

  const lookup = (conversationId, messageId) => inspect(async () => {
    id(conversationId, 'conversationId');
    id(messageId, 'messageId');
    const indexed = state.messages.get(entryKey(conversationId, messageId));
    try {
      if (!indexed) {
        const verified = await log.readEvent(1);
        const durable = verified.receipt;
        return deepFreeze({
          entry: null,
          source: null,
          receipt: {
            format: CONVERSATION_LOOKUP_RECEIPT_FORMAT,
            found: false,
            target: { conversationId, messageId },
            archive: {
              format: durable.format,
              archiveId: durable.archiveId,
              events: durable.events,
              head: durable.head,
            },
          },
        });
      }
      const read = await log.readEvent(indexed.sequence);
      const event = read.event;
      if (!event || event.type !== 'message_archived') throw archiveError('the indexed event is not an archived message');
      const raw = fields(event.data, ['entry'], 'message_archived data');
      const entry = restoreConversationEntry(raw.entry);
      if (entry.conversationId !== conversationId || entry.messageId !== messageId) {
        throw archiveError('the indexed event identifies a different message');
      }
      if (entry.fingerprint !== indexed.entryFingerprint || entry.messageSha256 !== indexed.messageSha256) {
        throw archiveError('the indexed event no longer matches the compact archive projection');
      }
      const source = sourceFor(log.id, entry);
      if (source.fingerprint !== indexed.source.fingerprint) {
        throw archiveError('the indexed source no longer matches the verified archive entry');
      }
      const receipt = deepFreeze({
        format: CONVERSATION_LOOKUP_RECEIPT_FORMAT,
        found: true,
        target: { conversationId, messageId },
        archive: {
          format: read.receipt.format,
          archiveId: read.receipt.archiveId,
          events: read.receipt.events,
          head: read.receipt.head,
        },
        event: { sequence: event.sequence, hash: event.hash },
        entry: { fingerprint: entry.fingerprint, messageSha256: entry.messageSha256 },
        sourceFingerprint: source.fingerprint,
      });
      return deepFreeze({ entry, source, receipt });
    } catch (error) {
      projectionFailure ??= error instanceof Error
        ? error
        : archiveError('verified archive lookup failed', error);
      throw projectionFailure;
    }
  });

  const snapshot = () => inspect(async () => {
    const receipt = await log.receipt();
    const messages = [...state.messages.values()].map(messageView);
    const titles = [...state.titles.values()].map(row => deepFreeze({ ...row }));
    const lifecycles = [...state.lifecycles.values()].map(row => deepFreeze({ ...row }));
    const proactivePolicies = [...state.proactivePolicies.values()].map(row => deepFreeze({ ...row }));
    const conversations = new Set([
      ...messages.map(message => message.conversationId),
      ...titles.map(row => row.conversationId),
      ...lifecycles.map(row => row.conversationId),
      ...proactivePolicies.map(row => row.conversationId),
    ]).size;
    return deepFreeze({
      format: CONVERSATION_ARCHIVE_SNAPSHOT_FORMAT,
      archiveId: log.id,
      receipt,
      totals: { conversations, messages: messages.length },
      messages,
      titles,
      lifecycles,
      proactivePolicies,
    });
  });

  const close = () => {
    if (!closePromise) {
      closing = true;
      closePromise = operationQueue.then(async () => {
        const errors = [];
        try { await log.close(); } catch (error) { errors.push(error); }
        if (projectionFailure && !errors.includes(projectionFailure)) errors.push(projectionFailure);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Conversation archive close preserved durable and projection failures');
      });
    }
    return closePromise;
  };

  const receipt = async () => {
    await operationQueue;
    ensureHealthy();
    return log.receipt();
  };

  const archive = Object.freeze({
    archiveId: log.id,
    append,
    setTitle,
    setArchived,
    setProactiveMode,
    lookup,
    reference,
    snapshot,
    receipt,
    close,
  });
  archives.add(archive);
  return archive;
}

export function isConversationArchive(value) {
  return Boolean(value) && archives.has(value);
}

export async function createConversationArchive(file, options = {}) {
  const raw = fields(options, ['archiveId', 'clock', 'sync'], 'create options');
  const archiveId = raw.archiveId === undefined ? randomUUID() : raw.archiveId;
  const clock = raw.clock === undefined ? Date.now : raw.clock;
  const sync = raw.sync === undefined ? true : raw.sync;
  const state = newState();
  const log = await openDurableLog(file, {
    create: true,
    format: CONVERSATION_ARCHIVE_EVENT_FORMAT,
    idField: 'archiveId',
    id: archiveId,
    initial: {
      type: 'archive_created',
      data: { entryFormat: CONVERSATION_ENTRY_FORMAT, sourceIdFormat: CONVERSATION_SOURCE_ID_FORMAT },
    },
    clock,
    sync,
    maxDataBytes: CONVERSATION_ARCHIVE_LIMITS.eventBytes,
    maxLineBytes: CONVERSATION_ARCHIVE_LIMITS.lineBytes,
  });
  state.sawGenesis = true;
  return buildArchive(log, state);
}

export async function openConversationArchive(file, options = {}) {
  const raw = fields(options, ['expectedArchiveId', 'expectedHead', 'clock', 'sync'], 'open options');
  const expectedArchiveId = raw.expectedArchiveId;
  const expectedHead = raw.expectedHead;
  const clock = raw.clock === undefined ? Date.now : raw.clock;
  const sync = raw.sync === undefined ? true : raw.sync;
  const log = await openDurableLog(file, {
    format: CONVERSATION_ARCHIVE_EVENT_FORMAT,
    idField: 'archiveId',
    expectedId: expectedArchiveId,
    expectedHead,
    clock,
    sync,
    maxDataBytes: CONVERSATION_ARCHIVE_LIMITS.eventBytes,
    maxLineBytes: CONVERSATION_ARCHIVE_LIMITS.lineBytes,
    replay: { create: newState, apply: (state, event) => applyEvent(event, state) },
  });
  return buildArchive(log, log.replayState);
}
