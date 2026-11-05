import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpenAIChatProvider, parseBaseURL } from '../src/openai-chat-provider.mjs';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';
import { runConversation } from '../src/run.mjs';
import { createToolRegistry } from '../src/tools.mjs';

const SECRET = 'sk-synthetic-secret-0123456789';

function reply(message, { status = 200, headers = {}, finish = 'stop' } = {}) {
  return new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish }] }), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

function recorder(responses) {
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.shift();
    if (!next) throw new Error('no more synthetic responses');
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetch, calls };
}

function request(overrides = {}) {
  return { messages: [{ role: 'user', content: 'hello' }], tools: [], signal: undefined, step: 1, ...overrides };
}

async function syntheticProfile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-openai-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'roots'));
  await fs.writeFile(path.join(directory, 'profile.json'), JSON.stringify({
    format: PROFILE_FORMAT,
    roots: [
      { id: 'identity', path: 'roots/identity.md', placement: 'system' },
      { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' },
    ],
  }));
  await fs.writeFile(path.join(directory, 'roots', 'identity.md'), 'SYNTHETIC IDENTITY ROOT');
  await fs.writeFile(path.join(directory, 'roots', 'voice.md'), 'SYNTHETIC VOICE ROOT');
  return loadProfile(directory);
}

test('base URLs require https except on loopback hosts', () => {
  assert.equal(parseBaseURL('https://openrouter.ai/api/v1').endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(parseBaseURL('http://127.0.0.1:11434/v1/').endpoint, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(parseBaseURL('http://localhost:1234/v1').endpoint, 'http://localhost:1234/v1/chat/completions');
  assert.throws(() => parseBaseURL('http://example.com/v1'), /plain http only/);
  assert.throws(() => parseBaseURL('ftp://example.com'), /https/);
  assert.throws(() => parseBaseURL('https://user:pass@example.com/v1'), /credentials/);
  assert.throws(() => parseBaseURL('https://example.com/v1?key=x'), /query or fragment/);
  assert.throws(() => parseBaseURL('not a url'), /absolute URL/);
});

test('options are strict and the provider id names host and model without the key', () => {
  const provider = createOpenAIChatProvider({ baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:4b', apiKey: SECRET, fetch: async () => {} });
  assert.match(provider.id, /^openai-chat\/127\.0\.0\.1-11434\/qwen3\.5-4b-[a-f0-9]{12}$/);
  assert.ok(!provider.id.includes(SECRET));
  const other = createOpenAIChatProvider({ baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3.5-4b', fetch: async () => {} });
  assert.notEqual(other.id, provider.id);
  assert.equal(createOpenAIChatProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna', fetch: async () => {} }).id,
    'openai-chat/openrouter.ai/openai/gpt-6-luna');
  assert.equal(createOpenAIChatProvider({ baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna', reasoningEffort: 'high', fetch: async () => {} }).id,
    'openai-chat/openrouter.ai/openai/gpt-6-luna/effort-high');
  assert.throws(() => createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', surprise: true }), /unknown field/);
  assert.throws(() => createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', apiKey: 'has space' }), /apiKey/);
  assert.throws(() => createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', developerRole: 'boss' }), /developerRole/);
  assert.throws(() => createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', headers: { Authorization: 'x' } }), /not an allowed header/);
  assert.throws(() => createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', maxOutputTokens: 0 }), /maxOutputTokens/);
  assert.throws(() => createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', reasoningEffort: 'ultra' }), /reasoningEffort/);
});

test('a text reply is sent with native roles, auth header, and no tools field when none are declared', async () => {
  const { fetch, calls } = recorder([reply({ role: 'assistant', content: 'hi there' })]);
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'synthetic/model', apiKey: SECRET, fetch, reasoningEffort: 'high', maxOutputTokens: 512 });
  const result = await provider.complete(request({
    messages: [
      { role: 'system', content: 'host rules' },
      { role: 'developer', content: 'dev note' },
      { role: 'user', content: 'hello' },
    ],
  }));
  assert.deepEqual(result, { role: 'assistant', content: 'hi there' });
  assert.equal(calls[0].url, 'https://x.test/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(calls[0].body.messages.map(message => message.role), ['system', 'system', 'user']);
  assert.equal(calls[0].body.max_tokens, 512);
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal(calls[0].body.stream, false);
  assert.ok(!('tools' in calls[0].body));
});

test('developer messages may keep their role, and keyless local services get no auth header', async () => {
  const { fetch, calls } = recorder([reply({ role: 'assistant', content: 'ok' })]);
  const provider = createOpenAIChatProvider({ baseURL: 'http://127.0.0.1:11434/v1', model: 'm', fetch, developerRole: 'developer' });
  await provider.complete(request({ messages: [{ role: 'developer', content: 'note' }, { role: 'user', content: 'hi' }] }));
  assert.equal(calls[0].body.messages[0].role, 'developer');
  assert.ok(!('authorization' in calls[0].init.headers));
  assert.ok(!('reasoning_effort' in calls[0].body));
});

test('image parts pass through and unknown part types are refused before sending', async () => {
  const { fetch, calls } = recorder([reply({ role: 'assistant', content: 'a cat' })]);
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', fetch });
  await provider.complete(request({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }] }],
  }));
  assert.deepEqual(calls[0].body.messages[0].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } });
  await assert.rejects(provider.complete(request({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] })), /only text and image_url/);
  await assert.rejects(provider.complete(request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }] }] })), /https or data:image/);
  assert.equal(calls.length, 1);
});

test('tool calls run through the real run loop and their results return natively', async t => {
  const profile = await syntheticProfile(t);
  const { fetch, calls } = recorder([
    reply({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, { finish: 'tool_calls' }),
    reply({ role: 'assistant', content: 'The sum is 5.' }),
  ]);
  const tools = createToolRegistry([{
    name: 'add',
    description: 'Add two whole numbers and return the sum.',
    inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false },
    execute: ({ a, b }) => ({ sum: a + b }),
  }]);
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', fetch });
  const result = await runConversation({ profile, provider, tools, messages: [{ role: 'user', content: 'add 2 and 3' }] });
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'The sum is 5.');
  assert.equal(calls[0].body.tools[0].function.name, 'add');
  const second = calls[1].body.messages;
  const assistant = second.find(message => message.role === 'assistant');
  assert.equal(assistant.content, null);
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  const toolResult = second.find(message => message.role === 'tool');
  assert.equal(toolResult.tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(toolResult.content).value, { sum: 5 });
  assert.ok(second.some(message => message.role === 'system' && String(message.content).includes('SYNTHETIC IDENTITY ROOT')));
});

test('object-shaped tool arguments from local servers are carried as JSON text', async () => {
  const { fetch } = recorder([reply({ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'add', arguments: { a: 1 } } }] })]);
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', fetch });
  const result = await provider.complete(request());
  assert.equal(result.tool_calls[0].function.arguments, '{"a":1}');
});

test('HTTP errors carry status, bounded provider detail, retry-after, and never the key', async () => {
  const { fetch } = recorder([
    new Response(JSON.stringify({ error: { message: `bad key ${SECRET} rejected` } }), { status: 401 }),
    new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '7' } }),
  ]);
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', apiKey: SECRET, fetch });
  await assert.rejects(provider.complete(request()), error => {
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes(SECRET));
    assert.match(error.message, /HTTP 401: bad key \[redacted\] rejected/);
    return true;
  });
  await assert.rejects(provider.complete(request()), error => error.status === 429 && error.retryAfterSeconds === 7);
});

test('oversized responses are refused while streaming, not after buffering', async () => {
  const big = 'x'.repeat(4096);
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode(big)); },
  });
  const { fetch } = recorder([new Response(stream, { status: 200 })]);
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', fetch, maxResponseBytes: 8192 });
  await assert.rejects(provider.complete(request()), /exceeds 8192 bytes/);
});

test('empty replies explain why: token ceiling, content filter, or nothing', async () => {
  const { fetch } = recorder([
    reply({ role: 'assistant', content: '' }, { finish: 'length' }),
    reply({ role: 'assistant', content: null }, { finish: 'content_filter' }),
    reply({ role: 'assistant', content: '   ' }),
    new Response('{"choices":[]}', { status: 200 }),
    new Response('not json', { status: 200 }),
  ]);
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', fetch });
  await assert.rejects(provider.complete(request()), /output-token ceiling/);
  await assert.rejects(provider.complete(request()), /content filter/);
  await assert.rejects(provider.complete(request()), /no visible text/);
  await assert.rejects(provider.complete(request()), /no choices/);
  await assert.rejects(provider.complete(request()), /not one JSON document/);
});

test('an aborted caller signal wins, and a slow service times out', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const controller = new AbortController();
  const { fetch } = recorder([hang, hang]);
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', fetch, timeoutMs: 1000 });
  const pending = provider.complete(request({ signal: controller.signal }));
  controller.abort(new Error('caller stopped'));
  await assert.rejects(pending, /caller stopped/);
  await assert.rejects(provider.complete(request()), /no complete reply within 1000 ms/);
});

test('network failures name the origin and redact the key', async () => {
  const fetch = async () => { throw new TypeError(`connect ECONNREFUSED with ${SECRET}`); };
  const provider = createOpenAIChatProvider({ baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: SECRET, fetch });
  await assert.rejects(provider.complete(request()), error => {
    assert.match(error.message, /could not reach http:\/\/127\.0\.0\.1:9/);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
});

test('model lists come from GET /models, sorted, with the key sent but never echoed', async () => {
  const { listOpenAIModels } = await import('../src/openai-chat-provider.mjs');
  let seen;
  const fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha', name: 'Alpha Model' }, { id: '' }] }), { status: 200 });
  };
  const rows = await listOpenAIModels({ baseURL: 'https://x.test/v1', apiKey: SECRET, fetch });
  assert.equal(seen.url, 'https://x.test/v1/models');
  assert.equal(seen.init.headers.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(rows, [{ id: 'alpha', label: 'Alpha Model' }, { id: 'zeta', label: 'zeta' }]);
  const failing = async () => new Response(JSON.stringify({ error: { message: `nope ${SECRET}` } }), { status: 401 });
  await assert.rejects(listOpenAIModels({ baseURL: 'https://x.test/v1', apiKey: SECRET, fetch: failing }), error => !error.message.includes(SECRET) && /HTTP 401/.test(error.message));
});

test('asked to stream, text is passed on as it arrives and tool calls are pieced together', async () => {
  const chunk = delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
  const sse = chunk({ role: 'assistant', content: 'Hel' }) + chunk({ content: 'lo' })
    + chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'rec', arguments: '{"q":' } }] })
    + chunk({ tool_calls: [{ index: 0, function: { name: 'all', arguments: '"x"}' } }] })
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
  const calls = [];
  const fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  const provider = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', fetch });
  const pieces = [];
  const result = await provider.complete(request({ onText: delta => pieces.push(delta) }));
  assert.equal(calls[0].stream, true);
  assert.deepEqual(pieces, ['Hel', 'lo']);
  assert.equal(result.content, 'Hello');
  assert.deepEqual(result.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'recall', arguments: '{"q":"x"}' } }]);

  // A service that ignores stream: true and answers whole still works.
  const whole = createOpenAIChatProvider({ baseURL: 'https://x.test/v1', model: 'm', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'whole' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal((await whole.complete(request({ onText: () => {} }))).content, 'whole');
});

test('a stream must end with DONE or an explicit finish reason', async () => {
  const event = choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
  const truncated = createOpenAIChatProvider({
    baseURL: 'https://x.test/v1', model: 'm',
    fetch: async () => new Response(event({ index: 0, delta: { content: 'partial' } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  await assert.rejects(truncated.complete(request({ onText: () => {} })), /stream ended before it finished/);

  const finished = createOpenAIChatProvider({
    baseURL: 'https://x.test/v1', model: 'm',
    fetch: async () => new Response(
      event({ index: 0, delta: { content: 'complete' } }) + event({ index: 0, delta: {}, finish_reason: 'stop' }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  });
  assert.equal((await finished.complete(request({ onText: () => {} }))).content, 'complete');
});
