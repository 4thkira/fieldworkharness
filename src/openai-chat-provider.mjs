import { createHash } from 'node:crypto';
import { canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';
import { projectMessageText } from './message-content.mjs';
import { isReasoningEffort, OPENAI_CHAT_REASONING_EFFORTS } from './model-effort.mjs';

// A provider adapter for any service that speaks the OpenAI Chat Completions
// protocol: OpenAI, OpenRouter, Ollama, LM Studio, vLLM, and similar. Roles,
// tool declarations, tool calls, tool results, and image parts are sent
// natively rather than flattened into one prompt.

export const OPENAI_CHAT_PROVIDER_FORMAT = 'fieldwork-openai-chat-provider/v1';
export const OPENAI_CHAT_LIMITS = Object.freeze({
  requestBytes: 8 * 1024 * 1024,
  maximumRequestBytes: 32 * 1024 * 1024,
  responseBytes: 2 * 1024 * 1024,
  maximumResponseBytes: 16 * 1024 * 1024,
  timeoutMs: 300_000,
  maximumTimeoutMs: 3_600_000,
  maximumOutputTokens: 1_000_000,
  errorDetailCharacters: 500,
});

const encoder = new TextEncoder();
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const contentPartTypes = new Set(['text', 'image_url']);

function providerError(message, details) {
  const error = new Error(`OpenAI chat provider: ${message}`, details?.cause === undefined ? undefined : { cause: details.cause });
  if (details?.status !== undefined) Object.defineProperty(error, 'status', { value: details.status, enumerable: true });
  if (details?.retryAfterSeconds !== undefined) Object.defineProperty(error, 'retryAfterSeconds', { value: details.retryAfterSeconds, enumerable: true });
  return error;
}

function refedTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function exactFields(value, allowed, where) {
  if (!isPlainObject(value)) throw providerError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw providerError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw providerError(`${where}.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  return fields;
}

function boundedWhole(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw providerError(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return number;
}

function portableText(value, where, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || value !== value.toWellFormed() || /\p{Cc}/u.test(value)) {
    throw providerError(`${where} must be 1-${maximum} well-formed characters without control characters`);
  }
  return value;
}

// Plain HTTP is accepted only for loopback services such as a local Ollama.
// Anything that crosses the network must use HTTPS.
export function parseBaseURL(value) {
  portableText(value, 'baseURL', 2048);
  let url;
  try { url = new URL(value); }
  catch { throw providerError('baseURL must be an absolute URL'); }
  if (url.username || url.password) throw providerError('baseURL must not contain credentials; pass apiKey instead');
  if (url.search || url.hash) throw providerError('baseURL must not contain a query or fragment');
  if (url.protocol === 'http:') {
    if (!loopbackHosts.has(url.hostname)) throw providerError('baseURL may use plain http only for 127.0.0.1, localhost, or [::1]; use https for anything else');
  } else if (url.protocol !== 'https:') {
    throw providerError('baseURL must use https, or http on a loopback host');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return deepFreeze({ origin: url.origin, host: url.host, endpoint: `${url.origin}${pathname}/chat/completions` });
}

function apiKeyFrom(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 4096 || /[\s\p{Cc}]/u.test(value)) {
    throw providerError('apiKey must be at most 4096 characters without whitespace or control characters');
  }
  return value;
}

function redact(text, secret) {
  return secret ? text.split(secret).join('[redacted]') : text;
}

function sendContent(content, where) {
  try { projectMessageText(content, { where, nullable: true }); }
  catch (error) { throw providerError(error.message, { cause: error }); }
  if (content === null || typeof content === 'string') return content;
  return content.map((part, index) => {
    if (!contentPartTypes.has(part.type)) {
      throw providerError(`${where}[${index}] has content type ${JSON.stringify(part.type)}; this adapter sends only text and image_url parts`);
    }
    if (part.type === 'text') return { type: 'text', text: part.text };
    const fields = exactFields(part, ['type', 'image_url'], `${where}[${index}]`);
    const image = exactFields(fields.image_url, ['url', 'detail'], `${where}[${index}].image_url`);
    if (typeof image.url !== 'string' || !/^(?:https:|data:image\/)/.test(image.url)) {
      throw providerError(`${where}[${index}].image_url.url must be an https or data:image URL`);
    }
    if (image.detail !== undefined && !['auto', 'low', 'high'].includes(image.detail)) {
      throw providerError(`${where}[${index}].image_url.detail must be auto, low, or high`);
    }
    return { type: 'image_url', image_url: image.detail === undefined ? { url: image.url } : { url: image.url, detail: image.detail } };
  });
}

function sendCalls(calls, where) {
  if (!Array.isArray(calls)) throw providerError(`${where} must be an array`);
  return calls.map((call, index) => {
    const fields = exactFields(call, ['id', 'type', 'function'], `${where}[${index}]`);
    const fn = exactFields(fields.function, ['name', 'arguments'], `${where}[${index}].function`);
    if (typeof fields.id !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
      throw providerError(`${where}[${index}] must have a text id, function name, and JSON-text arguments`);
    }
    return { id: fields.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
  });
}

function wireMessages(messages, developerRole) {
  if (!Array.isArray(messages) || !messages.length) throw providerError('request.messages must be a nonempty array');
  return messages.map((message, index) => {
    const where = `request.messages[${index}]`;
    if (!isPlainObject(message)) throw providerError(`${where} must be an object`);
    const role = message.role;
    if (role === 'system' || role === 'user' || role === 'developer') {
      const fields = exactFields(message, ['role', 'content'], where);
      if (fields.content === null) throw providerError(`${where}.content must not be null`);
      return { role: role === 'developer' ? developerRole : role, content: sendContent(fields.content, `${where}.content`) };
    }
    if (role === 'assistant') {
      const fields = exactFields(message, ['role', 'content', 'tool_calls'], where);
      const wire = { role, content: sendContent(fields.content === undefined ? null : fields.content, `${where}.content`) };
      if (fields.tool_calls !== undefined && fields.tool_calls.length) wire.tool_calls = sendCalls(fields.tool_calls, `${where}.tool_calls`);
      if (wire.content === '' && wire.tool_calls) wire.content = null;
      return wire;
    }
    if (role === 'tool') {
      const fields = exactFields(message, ['role', 'content', 'tool_call_id'], where);
      if (typeof fields.content !== 'string' || typeof fields.tool_call_id !== 'string' || !fields.tool_call_id) {
        throw providerError(`${where} must have text content and a tool_call_id`);
      }
      return { role, tool_call_id: fields.tool_call_id, content: fields.content };
    }
    throw providerError(`${where}.role ${JSON.stringify(String(role))} is not supported`);
  });
}

function retryAfter(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 86_400);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(Math.ceil((date - Date.now()) / 1000), 86_400)) : undefined;
}

// Reads the body incrementally so an oversized reply is refused before it is
// buffered whole, unlike a bare response.text().
async function boundedBody(response, maximum) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw providerError(`response declares ${declared} bytes; the limit is ${maximum}`);
  if (!response.body?.getReader) {
    const text = await response.text();
    if (encoder.encode(text).length > maximum) throw providerError(`response exceeds ${maximum} bytes`);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        throw providerError(`response exceeds ${maximum} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw providerError('response body was not valid UTF-8', { cause: error });
    throw error;
  }
  return text;
}

// Reads a streamed chat completion, passing text on as it arrives, and
// rebuilds the same JSON a whole reply would have had.
async function streamedReply(response, maximum, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, buffered = '', content = '', finish = null, failure = null, sawDone = false;
  const calls = [];
  const handle = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { sawDone = true; return; }
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (isPlainObject(event?.error)) { failure = event; return; }
    const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
    if (!isPlainObject(choice)) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = isPlainObject(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      try { onText(delta.content); } catch { /* display only */ }
    }
    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(part?.index) ? part.index : calls.length;
      if (index < 0 || index > 64) continue;
      const call = calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (typeof part.id === 'string') call.id = part.id;
      if (typeof part.function?.name === 'string') call.function.name += part.function.name;
      if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) { await reader.cancel().catch(() => {}); throw providerError(`response exceeds ${maximum} bytes`); }
      buffered += decoder.decode(value, { stream: true });
      for (let match; (match = /\r?\n\r?\n/.exec(buffered));) {
        handle(buffered.slice(0, match.index));
        buffered = buffered.slice(match.index + match[0].length);
      }
    }
    buffered += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw providerError('response body was not valid UTF-8', { cause: error });
    throw error;
  }
  if (buffered.trim()) handle(buffered);
  if (failure) return JSON.stringify(failure);
  if (!sawDone && finish === null) throw providerError('reply stream ended before it finished');
  const message = { role: 'assistant', content: content || null };
  const toolCalls = calls.filter(Boolean);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish ?? 'stop' }] });
}

function providerDetail(text, apiKey) {
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
    if (typeof message === 'string') detail = message;
  } catch { detail = text; }
  detail = redact(detail.toWellFormed().replace(/\p{Cc}+/gu, ' ').trim(), apiKey);
  const characters = [...detail];
  return characters.length > OPENAI_CHAT_LIMITS.errorDetailCharacters
    ? `${characters.slice(0, OPENAI_CHAT_LIMITS.errorDetailCharacters).join('')}…`
    : detail;
}

function replyCalls(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw providerError('response message.tool_calls must be an array');
  // Leave id and argument repair to the run loop, which records each repair.
  return raw.map(call => {
    const fn = isPlainObject(call?.function) ? call.function : {};
    return {
      id: typeof call?.id === 'string' ? call.id : '',
      type: 'function',
      function: {
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : canonicalJson(isPlainObject(fn.arguments) ? fn.arguments : {}),
      },
    };
  });
}

function replyContent(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw.toWellFormed();
  if (Array.isArray(raw)) {
    return raw.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text.toWellFormed()).join('');
  }
  throw providerError('response message.content must be text, null, or an array of text parts');
}

// Readable when possible. If any character had to be replaced, a short digest
// of the exact host and model keeps two different selections from colliding.
function attributedId(host, model, reasoningEffort) {
  const effort = reasoningEffort ? `/effort-${reasoningEffort}` : '';
  const exact = `openai-chat/${host}/${model}${effort}`;
  if (providerIdPattern.test(exact)) return exact;
  const identity = reasoningEffort ? { host, model, reasoningEffort } : { host, model };
  const digest = createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex').slice(0, 12);
  const readable = `openai-chat/${host}/${model}${effort}`.replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 180);
  return `${readable}-${digest}`;
}

export function createOpenAIChatProvider(input = {}) {
  const raw = exactFields(input, [
    'baseURL', 'model', 'apiKey', 'fetch', 'id', 'headers', 'developerRole',
    'reasoningEffort', 'maxOutputTokens', 'maxRequestBytes', 'maxResponseBytes', 'timeoutMs',
  ], 'options');
  const base = parseBaseURL(raw.baseURL);
  const model = portableText(raw.model, 'options.model', 512);
  const apiKey = apiKeyFrom(raw.apiKey);
  const fetcher = raw.fetch === undefined ? globalThis.fetch : raw.fetch;
  if (typeof fetcher !== 'function') throw providerError('options.fetch must be a function');
  const reasoningEffort = raw.reasoningEffort === undefined ? null : raw.reasoningEffort;
  if (reasoningEffort !== null && !isReasoningEffort(reasoningEffort, OPENAI_CHAT_REASONING_EFFORTS)) {
    throw providerError(`options.reasoningEffort must be ${OPENAI_CHAT_REASONING_EFFORTS.join(', ')}, or omitted`);
  }
  const id = raw.id === undefined ? attributedId(base.host, model, reasoningEffort) : raw.id;
  if (typeof id !== 'string' || !providerIdPattern.test(id)) throw providerError('options.id must be a portable provider identifier');
  const developerRole = raw.developerRole === undefined ? 'system' : raw.developerRole;
  if (developerRole !== 'system' && developerRole !== 'developer') throw providerError('options.developerRole must be system or developer');
  const maxOutputTokens = raw.maxOutputTokens === undefined
    ? undefined
    : boundedWhole(raw.maxOutputTokens, 0, 1, OPENAI_CHAT_LIMITS.maximumOutputTokens, 'options.maxOutputTokens');
  const maxRequestBytes = boundedWhole(raw.maxRequestBytes, OPENAI_CHAT_LIMITS.requestBytes, 1024, OPENAI_CHAT_LIMITS.maximumRequestBytes, 'options.maxRequestBytes');
  const maxResponseBytes = boundedWhole(raw.maxResponseBytes, OPENAI_CHAT_LIMITS.responseBytes, 1024, OPENAI_CHAT_LIMITS.maximumResponseBytes, 'options.maxResponseBytes');
  const timeoutMs = boundedWhole(raw.timeoutMs, OPENAI_CHAT_LIMITS.timeoutMs, 1000, OPENAI_CHAT_LIMITS.maximumTimeoutMs, 'options.timeoutMs');
  const extraHeaders = Object.create(null);
  if (raw.headers !== undefined) {
    const fields = exactFields(raw.headers, Object.keys(raw.headers ?? {}), 'options.headers');
    for (const [name, value] of Object.entries(fields)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || /^(?:authorization|content-type|content-length|host)$/i.test(name)) {
        throw providerError(`options.headers.${name} is not an allowed header name`);
      }
      extraHeaders[name] = portableText(value, `options.headers.${name}`, 512);
    }
  }

  return Object.freeze({
    id,
    async complete(request) {
      const fields = exactFields(request, ['messages', 'tools', 'signal', 'step', 'onText'], 'request');
      if (fields.onText !== undefined && typeof fields.onText !== 'function') throw providerError('request.onText must be a function when present');
      const streaming = typeof fields.onText === 'function';
      if (fields.signal !== undefined && typeof fields.signal?.throwIfAborted !== 'function') {
        throw providerError('request.signal must be an AbortSignal when present');
      }
      fields.signal?.throwIfAborted();
      if (!Array.isArray(fields.tools)) throw providerError('request.tools must be an array');
      const body = { model, messages: wireMessages(fields.messages, developerRole), stream: streaming };
      if (fields.tools.length) body.tools = fields.tools;
      if (reasoningEffort !== null) body.reasoning_effort = reasoningEffort;
      if (maxOutputTokens !== undefined) body.max_tokens = maxOutputTokens;
      const json = JSON.stringify(body);
      const requestBytes = encoder.encode(json).length;
      if (requestBytes > maxRequestBytes) throw providerError(`request is ${requestBytes} bytes; the limit is ${maxRequestBytes}`);

      const deadline = refedTimeoutSignal(timeoutMs);
      const timeout = deadline.signal;
      const signal = fields.signal ? AbortSignal.any([fields.signal, timeout]) : timeout;
      const headers = { 'content-type': 'application/json', accept: streaming ? 'text/event-stream' : 'application/json', ...extraHeaders };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      let response, text;
      try {
        response = await fetcher(base.endpoint, { method: 'POST', headers, body: json, signal, redirect: 'error' });
        // A service may ignore stream: true and answer whole; both are read.
        const eventStream = streaming && response.ok && /text\/event-stream/i.test(response.headers?.get?.('content-type') ?? '');
        text = eventStream ? await streamedReply(response, maxResponseBytes, fields.onText) : await boundedBody(response, maxResponseBytes);
      } catch (error) {
        if (fields.signal?.aborted) throw fields.signal.reason ?? error;
        if (timeout.aborted) throw providerError(`no complete reply within ${timeoutMs} ms`, { cause: error });
        if (error instanceof Error && error.message.startsWith('OpenAI chat provider:')) throw error;
        throw providerError(`could not reach ${base.origin}: ${redact(error instanceof Error ? error.message : String(error), apiKey)}`);
      } finally {
        deadline.clear();
      }
      fields.signal?.throwIfAborted();

      if (!response.ok) {
        const detail = providerDetail(text, apiKey);
        throw providerError(`${base.origin} answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`, {
          status: response.status,
          retryAfterSeconds: response.status === 429 || response.status === 503 ? retryAfter(response.headers) : undefined,
        });
      }

      let parsed;
      try { parsed = parseJsonNoDuplicates(text, { where: 'provider response', maxDepth: 64 }); }
      catch (error) { throw providerError(`response was not one JSON document: ${error.message}`, { cause: error }); }
      if (isPlainObject(parsed?.error)) throw providerError(`provider reported an error: ${providerDetail(text, apiKey)}`);
      const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
      if (!isPlainObject(choice) || !isPlainObject(choice.message)) throw providerError('response contained no choices[0].message');

      const content = replyContent(choice.message.content);
      const calls = replyCalls(choice.message.tool_calls);
      if (!calls.length && !(content ?? '').trim()) {
        if (choice.finish_reason === 'length') throw providerError('the model reached its output-token ceiling before saying anything visible');
        if (choice.finish_reason === 'content_filter') throw providerError('the provider withheld the reply under its content filter');
        throw providerError(`the model returned no visible text and no tool call (finish_reason ${JSON.stringify(String(choice.finish_reason ?? 'none'))})`);
      }
      const message = { role: 'assistant', content };
      if (calls.length) message.tool_calls = calls;
      return deepFreeze(message);
    },
  });
}

// The models a service offers, from its GET /models list (Ollama, LM Studio,
// OpenRouter and OpenAI all answer it). Bounded, and the key is never echoed.
export async function listOpenAIModels({ baseURL, apiKey, fetch = globalThis.fetch, timeoutMs = 20_000, maxModels = 1000 } = {}) {
  const base = parseBaseURL(baseURL);
  const key = apiKeyFrom(apiKey);
  const endpoint = base.endpoint.replace(/\/chat\/completions$/, '/models');
  const deadline = refedTimeoutSignal(timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      redirect: 'error', signal: deadline.signal,
    });
  } catch (error) {
    deadline.clear();
    throw providerError(`could not reach ${base.origin}: ${redact(error instanceof Error ? error.message : String(error), key)}`);
  }
  let text;
  try {
    text = await boundedBody(response, OPENAI_CHAT_LIMITS.responseBytes);
  } finally {
    deadline.clear();
  }
  if (!response.ok) throw providerError(`${base.origin} answered HTTP ${response.status} for its model list${providerDetail(text, key) ? `: ${providerDetail(text, key)}` : ''}`, { status: response.status });
  let parsed;
  try { parsed = parseJsonNoDuplicates(text, { where: 'model list', maxDepth: 64 }); }
  catch (error) { throw providerError(`model list was not JSON: ${error.message}`); }
  const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
  return deepFreeze(rows.slice(0, maxModels)
    .map(row => ({ id: String(row?.id ?? row?.name ?? ''), label: String(row?.name ?? row?.id ?? '') }))
    .filter(row => row.id && row.id.length <= 512 && !/[\p{Cc}]/u.test(row.id))
    .sort((a, b) => a.id.localeCompare(b.id, 'en')));
}
