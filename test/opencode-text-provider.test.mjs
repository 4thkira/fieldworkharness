import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createOpenCodeTextProvider,
  OPENCODE_TEXT_BRIDGE_FORMAT,
  parseOpenCodeModel,
} from '../src/opencode-text-provider.mjs';
import { createMemoryEventLog } from '../src/event-log.mjs';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';
import { OPENCODE_CLIENT_VERSION, validateOpenCodeServiceEndpoint } from '../src/opencode-service-endpoint.mjs';
import { runConversation } from '../src/run.mjs';
import { createToolRegistry } from '../src/tools.mjs';

async function syntheticProfile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-opencode-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'roots'));
  await fs.writeFile(path.join(directory, 'profile.json'), JSON.stringify({
    format: PROFILE_FORMAT,
    roots: [
      { id: 'identity', path: 'roots/identity.md', placement: 'system' },
      { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' },
    ],
  }));
  await fs.writeFile(path.join(directory, 'roots', 'identity.md'), 'PRIVATE SYNTHETIC BRIDGE IDENTITY');
  await fs.writeFile(path.join(directory, 'roots', 'voice.md'), 'PRIVATE SYNTHETIC BRIDGE VOICE');
  return loadProfile(directory);
}

function request(overrides = {}) {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    signal: undefined,
    step: 1,
    ...overrides,
  };
}

test('OpenCode model selectors preserve nested model IDs and optional variants', () => {
  assert.deepEqual(parseOpenCodeModel('openai/gpt-6.1-sol#low'), {
    providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low',
  });
  assert.deepEqual(parseOpenCodeModel('openrouter/anthropic/claude-sonnet-5.5'), {
    providerID: 'openrouter', id: 'anthropic/claude-sonnet-5.5',
  });
  assert.throws(() => parseOpenCodeModel('missing-provider'), /provider\/model/);
  assert.throws(() => parseOpenCodeModel('openai/model#'), /must not be empty/);
  assert.throws(() => parseOpenCodeModel('openai/model#a#b'), /at most one/);

  const attributed = createOpenCodeTextProvider({
    model: { providerID: 'openrouter', id: 'synthetic/model:free' },
    generateText: () => ({ text: 'unused' }),
  });
  assert.match(attributed.id, /^opencode-text\/openrouter\/sha256-[a-f0-9]{32}$/);
});

test('the pinned client version and discovered service endpoint are independently constrained', async () => {
  const clientPackage = JSON.parse(await fs.readFile(new URL('../node_modules/@opencode/client/package.json', import.meta.url), 'utf8'));
  assert.equal(OPENCODE_CLIENT_VERSION, clientPackage.version);

  const accepted = validateOpenCodeServiceEndpoint({
    url: 'http://127.0.0.1:28894/',
    auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' },
  });
  assert.deepEqual(accepted, {
    url: 'http://127.0.0.1:28894',
    auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' },
  });
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.auth));

  for (const endpoint of [
    { url: 'https://127.0.0.1:28894', auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' } },
    { url: 'http://localhost:28894', auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' } },
    { url: 'http://2130706433:28894', auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' } },
    { url: 'http://127.0.0.1', auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' } },
    { url: 'http://127.0.0.1:28894/api', auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' } },
    { url: 'http://127.0.0.1:28894?remote=true', auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' } },
    { url: 'http://person:secret@127.0.0.1:28894', auth: { type: 'basic', username: 'opencode', password: 'synthetic-local-password-1234' } },
    { url: 'http://127.0.0.1:28894', auth: undefined },
    { url: 'http://127.0.0.1:28894', auth: { type: 'basic', username: 'someone-else', password: 'synthetic-local-password-1234' } },
    { url: 'http://127.0.0.1:28894', auth: { type: 'basic', username: 'opencode', password: 'short' } },
  ]) {
    assert.throws(() => validateOpenCodeServiceEndpoint(endpoint), /OpenCode service endpoint:/);
  }
});

test('the text bridge gives a rooted transcript to OpenCode without putting roots in Fieldwork history', async t => {
  const profile = await syntheticProfile(t);
  const calls = [];
  const controller = new AbortController();
  const provider = createOpenCodeTextProvider({
    model: { providerID: 'openai', id: 'gpt-synthetic', variant: 'low' },
    generateText(input, options) {
      calls.push({ input, options });
      return { text: 'A live synthetic reply.' };
    },
  });
  const result = await runConversation({
    profile,
    provider,
    messages: [{ role: 'user', content: 'Who are you?' }],
    tools: createToolRegistry(),
    eventLog: createMemoryEventLog({ runId: 'opencode-text-rooted', clock: () => 0 }),
    signal: controller.signal,
  });

  assert.equal(provider.id, 'opencode-text/openai/gpt-synthetic/low');
  assert.equal(result.answer, 'A live synthetic reply.');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input.model, { providerID: 'openai', id: 'gpt-synthetic', variant: 'low' });
  assert.equal(calls[0].options.signal, controller.signal);
  const start = calls[0].input.prompt.indexOf(`{"format":"${OPENCODE_TEXT_BRIDGE_FORMAT}"`);
  assert.ok(start > 0);
  const document = JSON.parse(calls[0].input.prompt.slice(start));
  assert.equal(document.format, OPENCODE_TEXT_BRIDGE_FORMAT);
  assert.match(document.messages[0].content, /PRIVATE SYNTHETIC BRIDGE IDENTITY/);
  assert.match(document.messages.at(-1).content, /Who are you\?/);
  assert.match(document.messages.at(-1).content, /PRIVATE SYNTHETIC BRIDGE VOICE/);
  assert.doesNotMatch(JSON.stringify(result.messages), /PRIVATE SYNTHETIC BRIDGE/);
  assert.doesNotMatch(JSON.stringify(result.receipt), /PRIVATE SYNTHETIC BRIDGE/);
});

test('the compatibility bridge fails closed on tools, non-text media, oversized prompts and malformed replies', async () => {
  let calls = 0;
  const provider = createOpenCodeTextProvider({
    model: { providerID: 'openrouter', id: 'synthetic/model' },
    maxPromptBytes: 1024,
    generateText() { calls++; return { text: 'unused' }; },
  });

  await assert.rejects(provider.complete(request({ tools: [{ type: 'function' }] })), /must be empty/);
  await assert.rejects(provider.complete(request({
    messages: [{ role: 'assistant', content: '', tool_calls: [] }],
  })), /cannot round-trip tools/);
  await assert.rejects(provider.complete(request({
    messages: [{ role: 'tool', tool_call_id: 'call-1', content: '{}' }],
  })), /tool result/);
  await assert.rejects(provider.complete(request({
    messages: [{ role: 'user', content: [{ type: 'image', url: 'synthetic://image' }] }],
  })), /text-only/);
  await assert.rejects(provider.complete(request({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', hidden: 'smuggled field' }] }],
  })), /unknown field "hidden"/);
  await assert.rejects(provider.complete(request({
    messages: [{ role: 'user', content: '\uD800' }],
  })), /well-formed Unicode/);
  await assert.rejects(provider.complete(request({ step: 2 })), /must be 1/);
  await assert.rejects(provider.complete(request({
    messages: [{ role: 'user', content: 'x'.repeat(2000) }],
  })), /flattened prompt is/);
  assert.equal(calls, 0);

  const malformed = createOpenCodeTextProvider({
    model: { providerID: 'openai', id: 'synthetic' },
    generateText: () => ({ content: 'wrong field' }),
  });
  await assert.rejects(malformed.complete(request()), /unknown field "content"/);

  const failed = createOpenCodeTextProvider({
    model: { providerID: 'openai', id: 'synthetic' },
    generateText: () => { throw new Error('PRIVATE UPSTREAM BODY'); },
  });
  await assert.rejects(failed.complete(request()), error => {
    assert.match(error.message, /generation failed inside the local OpenCode service/);
    assert.doesNotMatch(error.message, /PRIVATE UPSTREAM BODY/);
    assert.equal(error.cause.message, 'PRIVATE UPSTREAM BODY');
    return true;
  });

  const malformedUnicode = createOpenCodeTextProvider({
    model: { providerID: 'openai', id: 'synthetic' },
    generateText: () => ({ text: '\uD800' }),
  });
  await assert.rejects(malformedUnicode.complete(request()), /well-formed Unicode/);

  const oversizedReply = createOpenCodeTextProvider({
    model: { providerID: 'openai', id: 'synthetic' },
    maxReplyBytes: 1024,
    generateText: () => ({ text: 'r'.repeat(1025) }),
  });
  await assert.rejects(oversizedReply.complete(request()), /response\.text is 1025 UTF-8 bytes/);

  let abortedCalls = 0;
  const preAborted = createOpenCodeTextProvider({
    model: { providerID: 'openai', id: 'synthetic' },
    generateText: () => { abortedCalls++; return { text: 'unused' }; },
  });
  const controller = new AbortController();
  controller.abort(new Error('synthetic stop'));
  await assert.rejects(preAborted.complete(request({ signal: controller.signal })), /synthetic stop/);
  assert.equal(abortedCalls, 0);
});
