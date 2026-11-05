import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CHATGPT_SUBSCRIPTION_ENDPOINT,
  codexAuth,
  createChatGPTSubscriptionProvider,
  fromResponsesOutput,
  tokenExpiry,
  toResponsesInput,
} from '../src/chatgpt-subscription-provider.mjs';

const TOKEN = 'synthetic.subscription.token';

function fakeAuth({ tokens = [TOKEN] } = {}) {
  const calls = [];
  return {
    calls,
    async token(renew) { calls.push(renew); return { token: tokens[Math.min(calls.length - 1, tokens.length - 1)], accountId: 'acct-synthetic' }; },
  };
}

function stream(events) {
  const text = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status: 200 });
}

const textItem = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('messages become Responses input: one instruction block, later system as developer, tools as items', () => {
  const { instructions, input } = toResponsesInput([
    { role: 'system', content: 'host rules' },
    { role: 'system', content: 'profile root' },
    { role: 'developer', content: 'dev note' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'recall', arguments: '{"query":"x"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.equal(instructions, 'host rules');
  assert.deepEqual(input, [
    { role: 'developer', content: 'profile root' },
    { role: 'developer', content: 'dev note' },
    { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] },
    { type: 'function_call', call_id: 'c1', name: 'recall', arguments: '{"query":"x"}' },
    { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    { role: 'assistant', content: 'done' },
  ]);
});

test('output items become a chat message with tool calls', () => {
  assert.deepEqual(fromResponsesOutput([textItem('hi')]), { role: 'assistant', content: 'hi' });
  const withCall = fromResponsesOutput([{ type: 'reasoning' }, { type: 'function_call', call_id: 'c9', name: 'what_time_is_it', arguments: '{}' }]);
  assert.deepEqual(withCall, { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'what_time_is_it', arguments: '{}' } }] });
  assert.throws(() => fromResponsesOutput([{ type: 'reasoning' }]), /no visible text and no tool call/);
});

test('a streamed reply is read from output_item.done events and sent only to chatgpt.com', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return stream([
      { type: 'response.created' },
      { type: 'response.output_item.done', output_index: 0, item: textItem('Hello from the subscription.') },
      { type: 'response.completed', response: { output: [] } },
    ]);
  };
  const auth = fakeAuth();
  const provider = createChatGPTSubscriptionProvider({ model: 'synthetic-model', auth, fetch });
  assert.equal(provider.id, 'chatgpt-subscription/synthetic-model');
  const reply = await provider.complete({
    messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'recall', description: 'Search memories.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }],
  });
  assert.deepEqual(reply, { role: 'assistant', content: 'Hello from the subscription.' });
  assert.equal(seen[0].url, CHATGPT_SUBSCRIPTION_ENDPOINT);
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].init.headers['chatgpt-account-id'], 'acct-synthetic');
  assert.equal(seen[0].body.store, false);
  assert.equal(seen[0].body.stream, true);
  assert.equal(seen[0].body.instructions, 'rules');
  assert.deepEqual(seen[0].body.tools.map(tool => tool.name), ['recall']);
  assert.equal(seen[0].body.prompt_cache_key, seen[0].init.headers.session_id);
  assert.ok(!('reasoning' in seen[0].body), 'provider default sends no reasoning override');
});

test('an advertised reasoning effort is explicit in the provider identity and request', async () => {
  const seen = [];
  const provider = createChatGPTSubscriptionProvider({
    model: 'synthetic-model',
    reasoningEffort: 'ultra',
    auth: fakeAuth(),
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return stream([
        { type: 'response.output_item.done', output_index: 0, item: textItem('carefully considered') },
        { type: 'response.completed', response: { output: [] } },
      ]);
    },
  });
  assert.equal(provider.id, 'chatgpt-subscription/synthetic-model/effort-ultra');
  assert.deepEqual(await provider.complete({ messages: [{ role: 'user', content: 'think' }], tools: [] }), {
    role: 'assistant', content: 'carefully considered',
  });
  assert.deepEqual(seen[0].reasoning, { effort: 'ultra' });
  assert.throws(() => createChatGPTSubscriptionProvider({ model: 'm', reasoningEffort: 'heroic' }), /reasoningEffort/);
});

test('a 401 renews the sign-in once and retries', async () => {
  const responses = [new Response('{"detail":"expired"}', { status: 401 }), stream([
    { type: 'response.output_item.done', output_index: 0, item: textItem('ok') },
    { type: 'response.completed', response: {} },
  ])];
  const auth = fakeAuth({ tokens: ['old.token.x', 'new.token.y'] });
  const provider = createChatGPTSubscriptionProvider({ model: 'm', auth, fetch: async () => responses.shift() });
  assert.deepEqual(await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }), { role: 'assistant', content: 'ok' });
  assert.deepEqual(auth.calls, [false, true]);
});

test('failures are plain and never carry the token', async () => {
  const cases = [
    [new Response(JSON.stringify({ error: { message: 'You have hit your usage limit.' } }), { status: 429 }), /usage limit for now/],
    [new Response(JSON.stringify({ detail: `bad ${TOKEN}` }), { status: 403 }), /HTTP 403: bad \[redacted\]/],
    [stream([{ type: 'response.failed', response: { error: { message: 'model overloaded' } } }]), /model failed: model overloaded/],
    [new Response('event: x\ndata: {"type":"response.created"}\n\n', { status: 200 }), /ended before it finished/],
  ];
  for (const [response, pattern] of cases) {
    const provider = createChatGPTSubscriptionProvider({ model: 'm', auth: fakeAuth(), fetch: async () => response });
    await assert.rejects(provider.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }), error => {
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  }
  assert.throws(() => createChatGPTSubscriptionProvider({ model: 'has space' }), /model ID/);
});

test('the sign-in is read from CODEX_HOME, renewed through Codex when close to expiry, and never written', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-codex-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const jwt = exp => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const now = Date.UTC(2030, 0, 1);
  const write = token => fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: token, account_id: 'acct' } }));
  const renewals = [];
  const appServer = async work => {
    renewals.push('renew');
    await write(jwt(now / 1000 + 3600));
    return work(async method => (method === 'account/read' ? { account: { type: 'chatgpt' } } : { data: [{
      model: 'm1', displayName: 'Model One', isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Quickly reasons through a small problem.' },
        { reasoningEffort: 'ultra', description: 'Uses the deepest effort this model advertises.' },
        { reasoningEffort: 'ultra', description: 'Duplicate ignored.' },
        { reasoningEffort: 'heroic', description: 'Unknown ignored.' },
      ],
      defaultReasoningEffort: 'low',
    }] }));
  };
  const auth = codexAuth({ home, appServer, binary: 'unused', now: () => now });
  assert.equal(await auth.signedIn(), false);
  await assert.rejects(auth.token(), /no Codex sign-in was found/);

  await write(jwt(now / 1000 + 3600));
  const before = await fs.readFile(path.join(home, 'auth.json'), 'utf8');
  assert.equal((await auth.token()).accountId, 'acct');
  assert.equal(renewals.length, 0, 'a fresh token is used as is');
  assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), before, 'Fieldwork never writes the sign-in');

  await write(jwt(now / 1000 + 60));
  await auth.token();
  assert.equal(renewals.length, 1, 'a token within five minutes of expiry is renewed');
  assert.deepEqual(await auth.models(), [{
    id: 'm1', label: 'Model One', default: true,
    efforts: [
      { id: 'low', description: 'Quickly reasons through a small problem.' },
      { id: 'ultra', description: 'Uses the deepest effort this model advertises.' },
    ],
    effortSource: 'catalogue',
    defaultEffort: 'low',
  }]);
  assert.equal(tokenExpiry('not-a-jwt'), null);
});

test('text pieces are passed on as the stream delivers them', async () => {
  const provider = createChatGPTSubscriptionProvider({ model: 'm', auth: fakeAuth(), fetch: async () => stream([
    { type: 'response.output_text.delta', delta: 'Hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.output_item.done', output_index: 0, item: textItem('Hello') },
    { type: 'response.completed', response: { output: [] } },
  ]) });
  const pieces = [];
  const reply = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [], onText: delta => pieces.push(delta) });
  assert.deepEqual(pieces, ['Hel', 'lo']);
  assert.equal(reply.content, 'Hello');
});
