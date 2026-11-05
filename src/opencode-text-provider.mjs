import { createHash } from 'node:crypto';
import { canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';
import { projectMessageText } from './message-content.mjs';

export const OPENCODE_TEXT_BRIDGE_FORMAT = 'fieldwork-opencode-text-bridge/v1';
export const OPENCODE_TEXT_BRIDGE_LIMITS = Object.freeze({
  promptBytes: 2 * 1024 * 1024,
  maximumPromptBytes: 16 * 1024 * 1024,
  replyBytes: 1024 * 1024,
  maximumReplyBytes: 4 * 1024 * 1024,
  messages: 16_384,
});

const encoder = new TextEncoder();
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const providerSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const promptPreamble = [
  'Continue the ordered Fieldwork chat transcript in the JSON document below.',
  'Treat every message according to its role. System and developer messages govern the reply; user, assistant, and earlier conversation messages retain their ordinary chat meanings.',
  'Return exactly one assistant text reply, without a role label, wrapper, transcript, tool call, or commentary about this bridge.',
  `The document format is ${OPENCODE_TEXT_BRIDGE_FORMAT}.`,
  '',
].join('\n');

function bridgeError(message, cause) {
  return new Error(`OpenCode text provider: ${message}`, cause === undefined ? undefined : { cause });
}

function exactFields(value, allowed, where) {
  if (!isPlainObject(value)) throw bridgeError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw bridgeError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw bridgeError(`${where}.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  return fields;
}

function portableText(value, where, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || value !== value.toWellFormed()) {
    throw bridgeError(`${where} must be 1-${maximum} well-formed Unicode characters`);
  }
  if (/\p{Cc}/u.test(value)) throw bridgeError(`${where} must not contain control characters`);
  return value;
}

function modelReference(value, where = 'model') {
  const raw = exactFields(value, ['providerID', 'id', 'variant'], where);
  if (typeof raw.providerID !== 'string' || !providerSegmentPattern.test(raw.providerID)) {
    throw bridgeError(`${where}.providerID must be a portable provider identifier`);
  }
  const model = {
    providerID: raw.providerID,
    id: portableText(raw.id, `${where}.id`, 512),
  };
  if (raw.id.includes('#')) throw bridgeError(`${where}.id must not contain #; put a variant in ${where}.variant`);
  if (raw.variant !== undefined) {
    model.variant = portableText(raw.variant, `${where}.variant`, 128);
    if (raw.variant.includes('#')) throw bridgeError(`${where}.variant must not contain #`);
  }
  return deepFreeze(model);
}

export function parseOpenCodeModel(selector) {
  portableText(selector, 'model selector', 768);
  const hash = selector.indexOf('#');
  if (hash !== -1 && selector.indexOf('#', hash + 1) !== -1) throw bridgeError('model selector may contain at most one #');
  const base = hash === -1 ? selector : selector.slice(0, hash);
  const slash = base.indexOf('/');
  if (slash < 1 || slash === base.length - 1) throw bridgeError('model selector must be provider/model with an optional #variant');
  const model = {
    providerID: base.slice(0, slash),
    id: base.slice(slash + 1),
  };
  if (hash !== -1) {
    const variant = selector.slice(hash + 1);
    if (!variant) throw bridgeError('model selector variant must not be empty');
    model.variant = variant;
  }
  return modelReference(model, 'model selector');
}

function promptLimit(value) {
  const limit = value === undefined ? OPENCODE_TEXT_BRIDGE_LIMITS.promptBytes : value;
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > OPENCODE_TEXT_BRIDGE_LIMITS.maximumPromptBytes) {
    throw bridgeError(`maxPromptBytes must be a whole number from 1024 to ${OPENCODE_TEXT_BRIDGE_LIMITS.maximumPromptBytes}`);
  }
  return limit;
}

function replyLimit(value) {
  const limit = value === undefined ? OPENCODE_TEXT_BRIDGE_LIMITS.replyBytes : value;
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > OPENCODE_TEXT_BRIDGE_LIMITS.maximumReplyBytes) {
    throw bridgeError(`maxReplyBytes must be a whole number from 1024 to ${OPENCODE_TEXT_BRIDGE_LIMITS.maximumReplyBytes}`);
  }
  return limit;
}

function wellFormedText(value, where) {
  if (typeof value !== 'string') throw bridgeError(`${where} must be text`);
  if (value !== value.toWellFormed()) throw bridgeError(`${where} must be well-formed Unicode text`);
  return value;
}

function textOnlyContent(content, where) {
  let projected;
  try { projected = projectMessageText(content, { where }); }
  catch (error) { throw bridgeError(error.message, error); }
  if (typeof content === 'string') return wellFormedText(content, where);
  if (projected.blocks.length !== content.length) throw bridgeError(`${where} contains non-text content; this bridge is text-only`);
  const texts = [];
  for (let index = 0; index < content.length; index++) {
    const part = exactFields(content[index], ['type', 'text'], `${where}[${index}]`);
    if (part.type !== 'text') throw bridgeError(`${where}[${index}] contains non-text content; this bridge is text-only`);
    texts.push(wellFormedText(part.text, `${where}[${index}].text`));
  }
  return texts.join('\n');
}

function transcriptDocument(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > OPENCODE_TEXT_BRIDGE_LIMITS.messages) {
    throw bridgeError(`request.messages must contain 1-${OPENCODE_TEXT_BRIDGE_LIMITS.messages} messages`);
  }
  const projected = [];
  for (let index = 0; index < messages.length; index++) {
    const where = `request.messages[${index}]`;
    const message = messages[index];
    if (!isPlainObject(message)) throw bridgeError(`${where} must be an object`);
    const role = Object.getOwnPropertyDescriptor(message, 'role');
    if (!role?.enumerable || !Object.hasOwn(role, 'value') || typeof role.value !== 'string') {
      throw bridgeError(`${where}.role must be an enumerable data property`);
    }
    if (['system', 'developer', 'user'].includes(role.value)) {
      const raw = exactFields(message, ['role', 'content'], where);
      projected.push({ role: raw.role, content: textOnlyContent(raw.content, `${where}.content`) });
      continue;
    }
    if (role.value === 'assistant') {
      const raw = exactFields(message, ['role', 'content', 'tool_calls'], where);
      if (raw.tool_calls !== undefined) throw bridgeError(`${where}.tool_calls is unsupported; this bridge cannot round-trip tools`);
      projected.push({ role: raw.role, content: textOnlyContent(raw.content, `${where}.content`) });
      continue;
    }
    if (role.value === 'tool') throw bridgeError(`${where} is a tool result; this bridge cannot round-trip tools`);
    throw bridgeError(`${where}.role ${JSON.stringify(role.value)} is unsupported`);
  }
  return deepFreeze({ format: OPENCODE_TEXT_BRIDGE_FORMAT, messages: projected });
}

function requestPrompt(request, maximum) {
  const raw = exactFields(request, ['messages', 'tools', 'signal', 'step', 'onText'], 'request');
  if (!Array.isArray(raw.tools)) throw bridgeError('request.tools must be an array');
  if (raw.tools.length) throw bridgeError('request.tools must be empty; the OpenCode text bridge cannot round-trip tools');
  if (raw.step !== 1) throw bridgeError('request.step must be 1; this tool-free bridge cannot continue a tool loop');
  if (raw.signal !== undefined && (typeof raw.signal !== 'object' || typeof raw.signal.throwIfAborted !== 'function')) {
    throw bridgeError('request.signal must be an AbortSignal when present');
  }
  raw.signal?.throwIfAborted();
  const prompt = `${promptPreamble}${canonicalJson(transcriptDocument(raw.messages))}`;
  const bytes = encoder.encode(prompt).length;
  if (bytes > maximum) throw bridgeError(`flattened prompt is ${bytes} UTF-8 bytes; the limit is ${maximum}`);
  return { prompt, signal: raw.signal };
}

function attributedProviderId(model) {
  const readable = ['opencode-text', model.providerID, model.id, model.variant].filter(value => value !== undefined).join('/');
  if (providerIdPattern.test(readable)) return readable;
  const digest = createHash('sha256').update(canonicalJson(model), 'utf8').digest('hex');
  return `opencode-text/${model.providerID}/sha256-${digest.slice(0, 32)}`;
}

export function createOpenCodeTextProvider(input = {}) {
  const raw = exactFields(input, ['generateText', 'model', 'id', 'maxPromptBytes', 'maxReplyBytes'], 'options');
  if (typeof raw.generateText !== 'function') throw bridgeError('options.generateText must be a function');
  const generateText = raw.generateText;
  const model = modelReference(raw.model, 'options.model');
  const id = raw.id === undefined ? attributedProviderId(model) : raw.id;
  if (typeof id !== 'string' || !providerIdPattern.test(id)) throw bridgeError('options.id must be a portable provider identifier');
  const maxPromptBytes = promptLimit(raw.maxPromptBytes);
  const maxReplyBytes = replyLimit(raw.maxReplyBytes);

  return Object.freeze({
    id,
    async complete(request) {
      const { prompt, signal } = requestPrompt(request, maxPromptBytes);
      let output;
      try {
        output = await generateText({ prompt, model }, { signal });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw bridgeError('generation failed inside the local OpenCode service', error);
      }
      signal?.throwIfAborted();
      const response = exactFields(output, ['text'], 'OpenCode response');
      const text = wellFormedText(response.text, 'OpenCode response.text');
      const replyBytes = encoder.encode(text).length;
      if (replyBytes > maxReplyBytes) throw bridgeError(`OpenCode response.text is ${replyBytes} UTF-8 bytes; the limit is ${maxReplyBytes}`);
      return deepFreeze({ role: 'assistant', content: text });
    },
  });
}
