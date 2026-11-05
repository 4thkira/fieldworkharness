import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { deepFreeze, isPlainObject } from './json-data.mjs';
import { projectMessageText } from './message-content.mjs';
import { CHATGPT_SUBSCRIPTION_REASONING_EFFORTS, isReasoningEffort } from './model-effort.mjs';

// An OPT-IN provider for people who use a ChatGPT subscription through OpenAI's
// Codex app or CLI. Codex owns the ChatGPT sign-in and the file it lives in
// (CODEX_HOME/auth.json). Fieldwork only reads the access token Codex already
// holds, asks `codex app-server` to renew it when it is stale, and sends it to
// chatgpt.com and nowhere else. It never signs in, never writes that file, and
// never logs, stores, or reports the token.
//
// The endpoint is the one Codex itself uses. It is not a documented public API:
// it can change without notice, and whether a subscription may be used this way
// is between the account holder and OpenAI's terms.

export const CHATGPT_SUBSCRIPTION_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const CHATGPT_SUBSCRIPTION_LIMITS = Object.freeze({
  requestBytes: 8 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  timeoutMs: 300_000,
  renewBeforeMs: 5 * 60 * 1000,
});

const SIGN_IN = 'Open the Codex app (or run `codex login`) and sign in with ChatGPT, then start Fieldwork again.';
const encoder = new TextEncoder();
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function boundedCatalogueText(value, maximum) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text && [...text].length <= maximum && !/\p{Cc}/u.test(text) ? text : '';
}

function catalogueEfforts(row) {
  const source = Array.isArray(row?.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [];
  const seen = new Set();
  const efforts = [];
  for (const item of source) {
    const id = item?.reasoningEffort;
    if (!isReasoningEffort(id, CHATGPT_SUBSCRIPTION_REASONING_EFFORTS) || seen.has(id)) continue;
    seen.add(id);
    const description = boundedCatalogueText(item?.description, 240);
    efforts.push({ id, ...(description ? { description } : {}) });
  }
  const advertisedDefault = row?.defaultReasoningEffort;
  const defaultEffort = isReasoningEffort(advertisedDefault, CHATGPT_SUBSCRIPTION_REASONING_EFFORTS)
    && seen.has(advertisedDefault) ? advertisedDefault : null;
  return { efforts, defaultEffort };
}

function subscriptionError(message, extra = {}) {
  const error = new Error(`ChatGPT subscription: ${message}`);
  for (const [key, value] of Object.entries(extra)) Object.defineProperty(error, key, { value, enumerable: true });
  return error;
}

const isFile = file => { try { return Boolean(file) && existsSync(file) && statSync(file).isFile(); } catch { return false; } };

// A configured path wins, then PATH, then the newest bundle the Codex desktop
// app keeps in a versioned folder on Windows.
export function findCodexBinary(env = process.env) {
  if (env.CODEX_BINARY) {
    if (!isFile(env.CODEX_BINARY)) throw subscriptionError('CODEX_BINARY does not point to an existing file');
    return path.resolve(env.CODEX_BINARY);
  }
  const windows = process.platform === 'win32';
  const lookup = spawnSync(windows ? 'where.exe' : 'which', [windows ? 'codex.exe' : 'codex'], { encoding: 'utf8', windowsHide: true, env });
  const onPath = String(lookup.stdout || '').trim().split(/\r?\n/).find(isFile);
  if (onPath) return path.resolve(onPath);
  const roots = [...new Set([
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'),
    path.join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'),
  ].filter(Boolean))];
  const found = [];
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const binary = path.join(root, entry.name, 'codex.exe');
        if (entry.isDirectory() && isFile(binary)) found.push({ binary, modified: statSync(binary).mtimeMs });
      }
    } catch { /* Not installed here. */ }
  }
  found.sort((a, b) => b.modified - a.modified);
  if (found.length) return found[0].binary;
  throw subscriptionError('Codex could not be found. Install the Codex app or CLI, or set CODEX_BINARY to its executable.');
}

// One short conversation with `codex app-server` over stdio, then it is ended.
export async function codexAppServer(work, { binary = findCodexBinary(), home, timeoutMs = 30_000, spawnImpl = spawn } = {}) {
  const child = spawnImpl(binary, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...(home ? { CODEX_HOME: home } : {}) },
  });
  const pending = new Map();
  let nextId = 1, failure = null;
  const fail = error => {
    failure ??= error;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(failure); }
    pending.clear();
  };
  child.once('error', error => fail(subscriptionError(`Codex could not start: ${error.message}`)));
  child.once('exit', code => fail(subscriptionError(`Codex stopped unexpectedly (${code ?? 'signal'})`)));
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message?.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(subscriptionError(`Codex refused: ${message.error.message || 'request failed'}`));
    else waiting.resolve(message.result ?? {});
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(subscriptionError(`Codex did not answer ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'fieldwork', title: 'Fieldwork', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return await work(rpc);
  } finally {
    lines.close();
    child.kill();
  }
}

// When an access token stops working, read from the token itself; unreadable
// means unknown, and a 401 settles it.
export function tokenExpiry(token) {
  try {
    const expires = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))?.exp;
    return Number.isFinite(expires) ? expires * 1000 : null;
  } catch { return null; }
}

export function codexAuth({ home = process.env.CODEX_HOME || path.join(homedir(), '.codex'), binary, appServer = codexAppServer, now = Date.now } = {}) {
  const file = path.join(home, 'auth.json');
  let renewing = null;
  const read = async () => {
    let saved;
    try { saved = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw subscriptionError(`no Codex sign-in was found. ${SIGN_IN}`); }
    const token = saved?.tokens?.access_token;
    if (typeof token !== 'string' || !token) throw subscriptionError(`Codex is not signed in with a ChatGPT account. ${SIGN_IN}`);
    return { token, accountId: typeof saved.tokens.account_id === 'string' ? saved.tokens.account_id : '' };
  };
  const options = () => ({ binary: binary || findCodexBinary(), home });
  const renew = () => renewing ??= appServer(async rpc => {
    const { account } = await rpc('account/read', { refreshToken: true });
    if (account?.type !== 'chatgpt') throw subscriptionError(`Codex is not signed in with a ChatGPT account. ${SIGN_IN}`);
  }, options()).finally(() => { renewing = null; });
  return Object.freeze({
    async token(forceRenew = false) {
      if (!forceRenew) {
        const held = await read();
        const expires = tokenExpiry(held.token);
        if (expires === null || expires - now() > CHATGPT_SUBSCRIPTION_LIMITS.renewBeforeMs) return held;
      }
      await renew();
      return read();
    },
    // The models this subscription may use, as Codex reports them. No inference.
    async models() {
      const result = await appServer(rpc => rpc('model/list', { limit: 100, includeHidden: false }), options());
      return (Array.isArray(result?.data) ? result.data : [])
        .map(row => {
          const { efforts, defaultEffort } = catalogueEfforts(row);
          return {
            id: String(row?.model ?? row?.id ?? ''),
            label: String(row?.displayName ?? row?.model ?? row?.id ?? ''),
            default: row?.isDefault === true,
            ...(efforts.length ? { efforts, effortSource: 'catalogue', ...(defaultEffort ? { defaultEffort } : {}) } : {}),
          };
        })
        .filter(row => row.id);
    },
    async signedIn() { try { await read(); return true; } catch { return false; } },
  });
}

// ---- Responses protocol -------------------------------------------------------

function textOf(content, where) {
  try { return projectMessageText(content, { where, nullable: true }).blocks.map(block => block.text).join('\n'); }
  catch (error) { throw subscriptionError(error.message); }
}

// The backend takes its instructions once; later system and developer messages
// go into the input as developer messages, which it accepts.
export function toResponsesInput(messages) {
  let instructions = '';
  const input = [];
  for (const [index, message] of messages.entries()) {
    const where = `request.messages[${index}]`;
    if (!isPlainObject(message)) throw subscriptionError(`${where} must be an object`);
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content, `${where}.content`);
      if (message.role === 'system' && !instructions) instructions = text;
      else input.push({ role: 'developer', content: text });
    } else if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        input.push({ role: 'user', content: message.content.map((part, partIndex) => {
          if (part?.type === 'text') return { type: 'input_text', text: part.text };
          if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') return { type: 'input_image', image_url: part.image_url.url };
          throw subscriptionError(`${where}.content[${partIndex}] must be a text or image_url part`);
        }) });
      } else {
        input.push({ role: 'user', content: textOf(message.content, `${where}.content`) });
      }
    } else if (message.role === 'assistant') {
      const text = textOf(message.content ?? null, `${where}.content`);
      if (text.trim()) input.push({ role: 'assistant', content: text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content) });
    } else {
      throw subscriptionError(`${where}.role ${JSON.stringify(String(message.role))} is not supported`);
    }
  }
  return { instructions, input };
}

export function fromResponsesOutput(output) {
  const items = Array.isArray(output) ? output.filter(Boolean) : [];
  const calls = items.filter(item => item.type === 'function_call').map(item => ({
    id: String(item.call_id ?? ''), type: 'function',
    function: { name: String(item.name ?? ''), arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
  }));
  const text = items.filter(item => item.type === 'message')
    .flatMap(item => (Array.isArray(item.content) ? item.content : []).filter(part => part?.type === 'output_text').map(part => String(part.text ?? '')))
    .join('\n').trim();
  if (!calls.length && !text) throw subscriptionError('the model returned no visible text and no tool call');
  return deepFreeze({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
}

// Reads the server-sent event stream with a byte bound. Output items arrive as
// `response.output_item.done`; the completed event's own output may be empty.
async function readEvents(response, maximum, onText) {
  const reader = response.body?.getReader();
  if (!reader) throw subscriptionError('the reply had no body');
  const decoder = new TextDecoder();
  const output = [];
  let buffered = '', bytes = 0, finished = null, failure = null;
  const handle = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data.trim() === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta && onText) {
      try { onText(event.delta); } catch { /* display only */ }
    } else if (event.type === 'response.output_item.done' && Number.isInteger(event.output_index) && event.item) output[event.output_index] = event.item;
    else if (event.type === 'response.completed' || event.type === 'response.incomplete') finished = event.response ?? {};
    else if (event.type === 'response.failed') failure = event.response?.error ?? { message: 'the response failed' };
    else if (event.type === 'error') failure = event.error ?? { message: event.message ?? 'the stream reported an error' };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) { await reader.cancel().catch(() => {}); throw subscriptionError(`the reply exceeded ${maximum} bytes`); }
    buffered += decoder.decode(value, { stream: true });
    for (let match; (match = /\r?\n\r?\n/.exec(buffered));) {
      handle(buffered.slice(0, match.index));
      buffered = buffered.slice(match.index + match[0].length);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) handle(buffered);
  if (failure) throw subscriptionError(`the model failed: ${String(failure.message ?? failure.code ?? 'unknown error').slice(0, 300)}`);
  if (!finished) throw subscriptionError('the reply stream ended before it finished');
  return Array.isArray(finished.output) && finished.output.length ? finished.output : output;
}

export function createChatGPTSubscriptionProvider({ model, auth = codexAuth(), fetch = globalThis.fetch, reasoningEffort, timeoutMs = CHATGPT_SUBSCRIPTION_LIMITS.timeoutMs } = {}) {
  if (typeof model !== 'string' || !model || model.length > 200 || /[\s\p{Cc}]/u.test(model)) throw subscriptionError('model must be a model ID without spaces');
  if (typeof fetch !== 'function') throw subscriptionError('fetch must be a function');
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort, CHATGPT_SUBSCRIPTION_REASONING_EFFORTS)) {
    throw subscriptionError(`reasoningEffort must be ${CHATGPT_SUBSCRIPTION_REASONING_EFFORTS.join(', ')}, or omitted`);
  }
  const effort = reasoningEffort ? `/effort-${reasoningEffort}` : '';
  const readable = `chatgpt-subscription/${model}${effort}`;
  const id = providerIdPattern.test(readable)
    ? readable
    : `chatgpt-subscription/${model.replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 150)}${effort}`;
  // The backend keys its prompt cache on this; one per provider keeps it warm.
  const cacheKey = randomUUID();

  async function send(body, signal, renew, onText) {
    const { token, accountId } = await auth.token(renew);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(CHATGPT_SUBSCRIPTION_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: {
          'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${token}`,
          session_id: cacheKey, ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
        },
        body,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (timeout.aborted) throw subscriptionError(`no reply within ${timeoutMs} ms`);
      throw subscriptionError(`could not reach chatgpt.com: ${String(error?.message ?? error).split(token).join('[redacted]')}`);
    }
    if (!response.ok) {
      let detail = '';
      try { const raw = (await response.text()).slice(0, 4000); detail = String(JSON.parse(raw)?.error?.message ?? JSON.parse(raw)?.detail ?? raw); } catch { /* No readable body. */ }
      detail = detail.split(token).join('[redacted]').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (response.status === 429 && /usage.?limit/i.test(detail)) {
        throw subscriptionError('this subscription has reached its usage limit for now. It resets on its own; try again later.', { status: 429 });
      }
      throw subscriptionError(`chatgpt.com answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status });
    }
    return readEvents(response, CHATGPT_SUBSCRIPTION_LIMITS.responseBytes, onText);
  }

  return Object.freeze({
    id,
    async complete(request) {
      if (!isPlainObject(request) || !Array.isArray(request.messages) || !Array.isArray(request.tools)) throw subscriptionError('request must have messages and tools arrays');
      request.signal?.throwIfAborted?.();
      const { instructions, input } = toResponsesInput(request.messages);
      const payload = {
        model, instructions, input, store: false, stream: true, prompt_cache_key: cacheKey,
        tools: request.tools.map(tool => ({ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })),
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      };
      const body = JSON.stringify(payload);
      const bytes = encoder.encode(body).length;
      if (bytes > CHATGPT_SUBSCRIPTION_LIMITS.requestBytes) throw subscriptionError(`request is ${bytes} bytes; the limit is ${CHATGPT_SUBSCRIPTION_LIMITS.requestBytes}`);
      let output;
      // A 401 means the token went stale since it was read: renew once and retry.
      const onText = typeof request.onText === 'function' ? request.onText : null;
      try { output = await send(body, request.signal, false, onText); }
      catch (error) { if (error?.status !== 401) throw error; output = await send(body, request.signal, true, onText); }
      return fromResponsesOutput(output);
    },
  });
}
