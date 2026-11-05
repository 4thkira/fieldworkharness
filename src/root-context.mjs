import { isLoadedProfile } from './profile.mjs';
import { boundedJson, deepFreeze, isPlainObject } from './json-data.mjs';

export const ROOT_MARKER = '<<<FIELDWORK_ROOTS>>>';
export const ROOT_CONTEXT_RECEIPT_FORMAT = 'fieldwork-root-context/v1';
export const ROOT_CONTEXT_MESSAGE_BYTES = 32 * 1024 * 1024;

function contextError(message) {
  return new Error(`Root context: ${message}`);
}

function loadedProfile(profile) {
  if (!isLoadedProfile(profile)) throw contextError('profile must be the result of loadProfile()');
  return profile;
}

function rootText(root) {
  return `<<<FIELDWORK_ROOT ${root.id}>>>\n${root.text}\n<<<END_FIELDWORK_ROOT ${root.id}>>>`;
}

function tailText(profile) {
  return `${ROOT_MARKER}\n${profile.tailRoots.map(rootText).join('\n')}`;
}

function checkMessage(message, index) {
  if (!isPlainObject(message)) throw contextError(`messages[${index}] must have a role`);
  const role = Object.getOwnPropertyDescriptor(message, 'role');
  if (!role?.enumerable || !Object.hasOwn(role, 'value') || typeof role.value !== 'string' || !role.value) throw contextError(`messages[${index}] must have an own data role`);
  const contentField = Object.getOwnPropertyDescriptor(message, 'content');
  if (contentField && (!contentField.enumerable || !Object.hasOwn(contentField, 'value'))) throw contextError(`messages[${index}].content must be an enumerable data property`);
  const content = contentField?.value;
  if (content === null || content === undefined) {
    if (role.value !== 'assistant') throw contextError(`messages[${index}].content may be null only for an assistant message`);
    return;
  }
  if (typeof content !== 'string' && !Array.isArray(content)) throw contextError(`messages[${index}].content must be text, null, or an array of content parts`);
  if (Array.isArray(content)) for (let partIndex = 0; partIndex < content.length; partIndex++) {
    if (!isPlainObject(content[partIndex])) throw contextError(`messages[${index}].content[${partIndex}] content parts must be objects`);
  }
}

function appendTail(message, text) {
  if (typeof message.content === 'string') {
    return { ...message, content: message.content ? `${message.content}\n\n${text}` : text };
  }
  return { ...message, content: [...message.content, { type: 'text', text }] };
}

// Assemble one provider request from unrooted messages. The caller keeps its
// conversation record unmodified and calls this again for each provider step.
// That makes recurrence explicit and avoids storing or duplicating root text in
// conversation history.
export function assembleRootedMessages(messages, profile) {
  loadedProfile(profile);
  if (!Array.isArray(messages) || !messages.length) throw contextError('messages must be a nonempty array');
  let cloned;
  try {
    cloned = boundedJson(messages, {
      where: 'messages', maxBytes: ROOT_CONTEXT_MESSAGE_BYTES, maxDepth: 64, maxNodes: 200_000,
    }).value;
  } catch (error) {
    throw contextError(error.message);
  }
  const base = structuredClone(cloned);
  base.forEach(checkMessage);
  let newestUser = -1;
  for (let index = 0; index < base.length; index++) if (base[index].role === 'user') newestUser = index;
  if (newestUser < 0) throw contextError('messages need a user turn for user-tail roots');

  const systemMessages = profile.systemRoots.map(root => ({ role: 'system', content: rootText(root) }));
  const tail = tailText(profile);
  const currentUserContent = base[newestUser].content;
  if (typeof currentUserContent !== 'string' && !Array.isArray(currentUserContent)) throw contextError('the newest user message must contain text or content parts');
  let insertAt = 0;
  while (insertAt < base.length && ['system', 'developer'].includes(base[insertAt].role)) insertAt++;
  base[newestUser] = appendTail(base[newestUser], tail);
  base.splice(insertAt, 0, ...systemMessages);

  const rootedUserIndex = newestUser + (insertAt <= newestUser ? systemMessages.length : 0);
  const receipt = {
    format: ROOT_CONTEXT_RECEIPT_FORMAT,
    profile: profile.receipt.fingerprint,
    systemRoots: profile.systemRoots.map(root => root.id),
    tailRoots: profile.tailRoots.map(root => root.id),
    systemInsertIndex: insertAt,
    userTailIndex: rootedUserIndex,
    systemCharacters: systemMessages.reduce((total, message) => total + [...message.content].length, 0),
    tailCharacters: [...tail].length,
    tailSeparatorCharacters: typeof currentUserContent === 'string' && currentUserContent ? 2 : 0,
  };
  return deepFreeze({ messages: base, receipt });
}
