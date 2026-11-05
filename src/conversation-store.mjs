import { randomUUID } from 'node:crypto';
import { attachmentSummary, isFileAttachmentPart } from './attachments.mjs';
import { isConversationArchive } from './conversation-archive.mjs';
import { deepFreeze, isPlainObject } from './json-data.mjs';
import { projectMessageText } from './message-content.mjs';
import { messageOrigin } from './message-origin.mjs';

// Many conversations over one append-only archive. Each committed message is
// archived once, under its conversation id and a zero-padded sequence id, so a
// conversation can be rebuilt after a restart exactly as it was stored. Without
// an archive the store still works, in process memory only.

export const CONVERSATION_STORE_LIMITS = Object.freeze({
  conversations: 1000,
  titleCharacters: 80,
  titledOnOpen: 100,
});

export const conversationMessageId = index => {
  if (!Number.isSafeInteger(index) || index < 0) throw storeError('message index must be a nonnegative whole number');
  return `m${String(index + 1).padStart(6, '0')}`;
};

function storeError(message, status = 400) {
  const error = new Error(`Conversation store: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function isoNow(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function manualTitle(value) {
  if (typeof value !== 'string' || (typeof value.isWellFormed === 'function' && !value.isWellFormed())) {
    throw storeError('title must be well-formed text');
  }
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const characters = [...normalized];
  const hasVisibleCharacter = /[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized);
  if (!characters.length || characters.length > CONVERSATION_STORE_LIMITS.titleCharacters || /\p{Cc}/u.test(normalized) || !hasVisibleCharacter) {
    throw storeError(`title must be 1-${CONVERSATION_STORE_LIMITS.titleCharacters} visible characters`);
  }
  return normalized;
}

function mutationOptions(value, where) {
  if (!isPlainObject(value)) throw storeError(`${where} options must be an object`);
  const raw = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !['expectedRevision', 'actor'].includes(key)) {
      throw storeError(`${where} options have unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw storeError(`${where} options.${key} must be an enumerable data property`);
    }
    raw[key] = descriptor.value;
  }
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) {
    throw storeError('expectedRevision must be a nonnegative whole number');
  }
  if (!['person', 'agent', 'system'].includes(raw.actor)) throw storeError('actor must be person, agent, or system');
  return raw;
}

const firstInstant = values => values.filter(Boolean).sort()[0];

// The first line of the first user message, or nothing.
export function conversationTitle(messages) {
  const first = messages.find(message => message.role === 'user');
  if (!first) return '';
  const origin = messageOrigin(first);
  if (origin && origin.kind !== 'bridge') {
    if (origin.kind === 'postcard') return 'A postcard from your agent';
    if (origin.kind === 'free-time') return 'A free-time note from your agent';
    return 'Your agent checked in';
  }
  let text = '';
  try {
    // Attached files are not part of what the person wrote.
    const visibleContent = Array.isArray(first.content) ? first.content.filter(part => !isFileAttachmentPart(part)) : first.content;
    text = projectMessageText(visibleContent).blocks.map(block => block.text).join(' ');
  } catch { return ''; }
  if (!text.trim()) {
    const attached = attachmentSummary(first.content);
    if (attached.length) text = attached[0].kind === 'file' ? attached[0].name : 'A picture';
  }
  const line = text.replace(/\s+/g, ' ').trim();
  const characters = [...line];
  return characters.length > CONVERSATION_STORE_LIMITS.titleCharacters
    ? `${characters.slice(0, CONVERSATION_STORE_LIMITS.titleCharacters - 1).join('')}…`
    : line;
}

export async function createConversationStore({ archive = null, clock = () => new Date() } = {}) {
  if (archive !== null && !isConversationArchive(archive)) throw storeError('archive must be a Fieldwork conversation archive');
  const conversations = new Map();
  let operationQueue = Promise.resolve();

  const mutate = operation => {
    const job = operationQueue.then(operation);
    operationQueue = job.then(() => undefined, () => undefined);
    return job;
  };

  if (archive) {
    const snapshot = await archive.snapshot();
    const grouped = new Map();
    for (const row of snapshot.messages) {
      if (!grouped.has(row.conversationId)) grouped.set(row.conversationId, []);
      grouped.get(row.conversationId).push(row);
    }
    const titles = new Map((snapshot.titles || []).map(row => [row.conversationId, row]));
    const lifecycles = new Map((snapshot.lifecycles || []).map(row => [row.conversationId, row]));
    const proactivePolicies = new Map((snapshot.proactivePolicies || []).map(row => [row.conversationId, row]));
    for (const id of new Set([...grouped.keys(), ...titles.keys(), ...lifecycles.keys(), ...proactivePolicies.keys()])) {
      const rows = grouped.get(id) || [];
      const named = titles.get(id) || null;
      const lifecycle = lifecycles.get(id) || null;
      const proactive = proactivePolicies.get(id) || null;
      rows.sort((a, b) => a.sequence - b.sequence);
      conversations.set(id, {
        id,
        title: named?.customTitle ? named.title : '',
        customTitle: named?.customTitle === true,
        titleRevision: named?.titleRevision ?? 0,
        titleBy: named?.titleBy ?? null,
        archived: lifecycle?.archived === true,
        lifecycleRevision: lifecycle?.lifecycleRevision ?? 0,
        lifecycleBy: lifecycle?.lifecycleBy ?? null,
        statusChangedAt: lifecycle?.statusChangedAt ?? null,
        archivedAt: lifecycle?.archivedAt ?? null,
        proactiveMode: proactive?.proactiveMode ?? 'allow',
        proactiveRevision: proactive?.proactiveRevision ?? 0,
        proactiveBy: proactive?.proactiveBy ?? null,
        proactiveChangedAt: proactive?.proactiveChangedAt ?? null,
        createdAt: named?.conversationCreatedAt || lifecycle?.conversationCreatedAt || proactive?.conversationCreatedAt
          || firstInstant([rows[0]?.observedAt, named?.at, lifecycle?.statusChangedAt, proactive?.proactiveChangedAt]),
        updatedAt: rows.at(-1)?.observedAt || named?.conversationUpdatedAt
          || lifecycle?.conversationUpdatedAt || proactive?.conversationUpdatedAt
          || named?.at || lifecycle?.statusChangedAt || proactive?.proactiveChangedAt,
        messageIds: rows.map(row => row.messageId),
        messages: null,
      });
    }
    // Titles need the first message's text; fetch them for the newest few now
    // and for the rest when they are opened.
    const newest = [...conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, CONVERSATION_STORE_LIMITS.titledOnOpen);
    for (const conversation of newest) {
      if (conversation.customTitle || !conversation.messageIds.length) continue;
      const found = await archive.lookup(conversation.id, conversation.messageIds[0]);
      if (found.entry) conversation.title = conversationTitle([found.entry.message]);
    }
  }

  const summary = conversation => deepFreeze({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    customTitle: conversation.customTitle,
    titleRevision: conversation.titleRevision,
    titleBy: conversation.titleBy,
    archived: conversation.archived,
    lifecycleRevision: conversation.lifecycleRevision,
    lifecycleBy: conversation.lifecycleBy,
    statusChangedAt: conversation.statusChangedAt,
    archivedAt: conversation.archivedAt,
    proactiveMode: conversation.proactiveMode,
    proactiveRevision: conversation.proactiveRevision,
    proactiveBy: conversation.proactiveBy,
    proactiveChangedAt: conversation.proactiveChangedAt,
    messageCount: conversation.messages ? conversation.messages.length : conversation.messageIds.length,
  });

  const find = id => {
    const conversation = typeof id === 'string' ? conversations.get(id) : undefined;
    if (!conversation) throw storeError('no conversation has that id', 404);
    return conversation;
  };

  const loadMessages = async conversation => {
    if (!conversation.messages) {
      const restored = [];
      for (const messageId of conversation.messageIds) {
        const found = await archive.lookup(conversation.id, messageId);
        if (!found.entry) throw storeError(`archived message ${messageId} of ${conversation.id} is missing`, 500);
        restored.push(found.entry.message);
      }
      conversation.messages = deepFreeze(restored);
    }
    return conversation.messages;
  };

  return Object.freeze({
    persistent: Boolean(archive),

    list({ archived = null } = {}) {
      if (archived !== null && typeof archived !== 'boolean') throw storeError('list.archived must be true, false, or null');
      return deepFreeze([...conversations.values()]
        .filter(conversation => archived === null || conversation.archived === archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))
        .map(summary));
    },

    // A new conversation exists in memory until its first committed turn.
    create() {
      if (conversations.size >= CONVERSATION_STORE_LIMITS.conversations) throw storeError(`at most ${CONVERSATION_STORE_LIMITS.conversations} conversations are kept open`);
      const at = isoNow(clock);
      const conversation = {
        id: `conv-${randomUUID()}`, title: '', customTitle: false, titleRevision: 0, titleBy: null,
        archived: false, lifecycleRevision: 0, lifecycleBy: null, statusChangedAt: null, archivedAt: null,
        proactiveMode: 'allow', proactiveRevision: 0, proactiveBy: null, proactiveChangedAt: null,
        createdAt: at, updatedAt: at, messageIds: [], messages: [],
      };
      conversations.set(conversation.id, conversation);
      return summary(conversation);
    },

    has(id) {
      return typeof id === 'string' && conversations.has(id);
    },

    get(id) {
      return summary(find(id));
    },

    isArchived(id) {
      return find(id).archived;
    },

    allowsProactive(id) {
      return find(id).proactiveMode === 'allow';
    },

    async messages(id) {
      const conversation = find(id);
      const restored = await loadMessages(conversation);
      if (!conversation.customTitle && !conversation.title) conversation.title = conversationTitle(restored);
      return restored;
    },

    rename(id, value, options) {
      return mutate(async () => {
        const conversation = find(id);
        const { expectedRevision, actor } = mutationOptions(options, 'title mutation');
        if (conversation.titleRevision !== expectedRevision) {
          throw storeError(`title revision conflict: expected ${expectedRevision}, current ${conversation.titleRevision}`, 409);
        }
        const title = value === null ? null : manualTitle(value);
        const customTitle = title !== null;
        if (conversation.customTitle === customTitle && (!customTitle || conversation.title === title)) return summary(conversation);
        const automaticTitle = customTitle ? '' : conversationTitle(await loadMessages(conversation));
        let changed;
        if (archive) {
          changed = await archive.setTitle({
            conversationId: conversation.id,
            title,
            expectedRevision,
            actor,
            conversationCreatedAt: conversation.createdAt,
            conversationUpdatedAt: conversation.updatedAt,
          });
        }
        conversation.title = customTitle ? title : automaticTitle;
        conversation.customTitle = customTitle;
        conversation.titleRevision = changed?.titleRevision ?? expectedRevision + 1;
        conversation.titleBy = changed?.titleBy ?? actor;
        return summary(conversation);
      });
    },

    setArchived(id, archived, options) {
      return mutate(async () => {
        const conversation = find(id);
        if (typeof archived !== 'boolean') throw storeError('archived must be true or false');
        const { expectedRevision, actor } = mutationOptions(options, 'lifecycle mutation');
        if (conversation.lifecycleRevision !== expectedRevision) {
          throw storeError(`lifecycle revision conflict: expected ${expectedRevision}, current ${conversation.lifecycleRevision}`, 409);
        }
        if (conversation.archived === archived) return summary(conversation);
        let changed;
        if (archive) {
          changed = await archive.setArchived({
            conversationId: conversation.id,
            archived,
            expectedRevision,
            actor,
            conversationCreatedAt: conversation.createdAt,
            conversationUpdatedAt: conversation.updatedAt,
          });
        }
        const changedAt = changed?.statusChangedAt ?? isoNow(clock);
        conversation.archived = archived;
        conversation.lifecycleRevision = changed?.lifecycleRevision ?? expectedRevision + 1;
        conversation.lifecycleBy = changed?.lifecycleBy ?? actor;
        conversation.statusChangedAt = changedAt;
        conversation.archivedAt = archived ? (changed?.archivedAt ?? changedAt) : null;
        return summary(conversation);
      });
    },

    setProactiveMode(id, mode, options) {
      return mutate(async () => {
        const conversation = find(id);
        if (!['allow', 'suppress'].includes(mode)) throw storeError('proactive mode must be allow or suppress');
        const { expectedRevision, actor } = mutationOptions(options, 'proactive mutation');
        if (conversation.proactiveRevision !== expectedRevision) {
          throw storeError(`proactive revision conflict: expected ${expectedRevision}, current ${conversation.proactiveRevision}`, 409);
        }
        if (conversation.proactiveMode === mode) return summary(conversation);
        let changed;
        if (archive) {
          changed = await archive.setProactiveMode({
            conversationId: conversation.id,
            mode,
            expectedRevision,
            actor,
            conversationCreatedAt: conversation.createdAt,
            conversationUpdatedAt: conversation.updatedAt,
          });
        }
        conversation.proactiveMode = mode;
        conversation.proactiveRevision = changed?.proactiveRevision ?? expectedRevision + 1;
        conversation.proactiveBy = changed?.proactiveBy ?? actor;
        conversation.proactiveChangedAt = changed?.proactiveChangedAt ?? isoNow(clock);
        return summary(conversation);
      });
    },

    // Records a finished run. `messages` must extend the stored transcript.
    commit(id, messages) {
      return mutate(async () => {
        const conversation = find(id);
        if (conversation.archived) throw storeError('an archived conversation cannot accept new messages; restore it first', 409);
        const before = conversation.messages ?? await loadMessages(conversation);
        if (messages.length < before.length) throw storeError('a committed transcript cannot be shorter than the stored one');
        const at = isoNow(clock);
        if (archive) {
          try {
            for (let index = before.length; index < messages.length; index++) {
              const messageId = conversationMessageId(index);
              await archive.append({ conversationId: conversation.id, messageId, observedAt: at, message: messages[index] });
              conversation.messageIds.push(messageId);
            }
          } catch (error) {
            // The archive is the record: rebuild from it next time rather than
            // trust a transcript that was only partly written.
            conversation.messages = null;
            throw error;
          }
        }
        conversation.messages = deepFreeze([...messages]);
        conversation.updatedAt = at;
        if (!conversation.customTitle && !conversation.title) conversation.title = conversationTitle(messages);
        return summary(conversation);
      });
    },
  });
}
