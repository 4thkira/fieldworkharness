import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';
import { assembleRootedMessages, ROOT_CONTEXT_RECEIPT_FORMAT, ROOT_MARKER } from '../src/root-context.mjs';

async function profile(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'roots'));
  const roots = [
    { id: 'identity', path: 'roots/identity.md', placement: 'system' },
    { id: 'relationships', path: 'roots/relationships.md', placement: 'system' },
    { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' },
    { id: 'register', path: 'roots/register.md', placement: 'user-tail' },
  ];
  await fs.writeFile(path.join(directory, 'profile.json'), JSON.stringify({ format: PROFILE_FORMAT, roots }));
  const files = {
    'identity.md': 'IDENTITY {owner} stays literal.',
    'relationships.md': 'RELATIONSHIPS stay attributed.',
    'voice.md': 'VOICE LAST-ish.',
    'register.md': 'REGISTER IS THE ACTUAL TAIL.',
    ...overrides,
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(directory, 'roots', name), text);
  return loadProfile(directory);
}

test('host instructions stay first, system roots follow in order, and the tail lands on the newest user turn', async t => {
  const loaded = await profile(t);
  const source = [
    { role: 'system', content: 'HOST SYSTEM' },
    { role: 'developer', content: 'HOST DEVELOPER' },
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'current turn' },
  ];
  const rooted = assembleRootedMessages(source, loaded);
  assert.deepEqual(rooted.messages.map(message => message.role), ['system', 'developer', 'system', 'system', 'user', 'assistant', 'user']);
  assert.match(rooted.messages[2].content, /FIELDWORK_ROOT identity/);
  assert.match(rooted.messages[2].content, /\{owner\} stays literal/);
  assert.match(rooted.messages[3].content, /FIELDWORK_ROOT relationships/);
  assert.equal(rooted.messages[4].content, 'first turn');
  assert.match(rooted.messages[6].content, /^current turn\n\n<<<FIELDWORK_ROOTS>>>/);
  assert.ok(rooted.messages[6].content.indexOf('VOICE LAST-ish.') < rooted.messages[6].content.indexOf('REGISTER IS THE ACTUAL TAIL.'));
  assert.equal(rooted.receipt.systemInsertIndex, 2);
  assert.equal(rooted.receipt.userTailIndex, 6);
  assert.deepEqual(rooted.receipt.systemRoots, ['identity', 'relationships']);
  assert.deepEqual(rooted.receipt.tailRoots, ['voice', 'register']);
  assert.equal(rooted.receipt.format, ROOT_CONTEXT_RECEIPT_FORMAT);
  assert.equal(rooted.receipt.tailSeparatorCharacters, 2);
  assert.deepEqual(source[4], { role: 'user', content: 'current turn' }, 'the conversation record is never rooted in place');
});

test('a tool loop keeps the voice on its latest user message rather than corrupting tool results', async t => {
  const loaded = await profile(t);
  const source = [
    { role: 'user', content: 'Use the instrument.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', name: 'look' }] },
    { role: 'tool', content: '{"result":"literal"}', tool_call_id: 'call-1' },
  ];
  const rooted = assembleRootedMessages(source, loaded);
  assert.match(rooted.messages[2].content, new RegExp(ROOT_MARKER));
  assert.equal(rooted.messages.at(-1).role, 'tool');
  assert.equal(rooted.messages.at(-1).content, '{"result":"literal"}');
});

test('an image-only user message keeps every part and receives one final text part', async t => {
  const loaded = await profile(t);
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const source = [{ role: 'user', content: [image] }];
  const rooted = assembleRootedMessages(source, loaded);
  const user = rooted.messages.at(-1);
  assert.deepEqual(user.content[0], image);
  assert.notEqual(user.content[0], image, 'content parts are copied');
  assert.notEqual(user.content[0].image_url, image.image_url, 'nested content data is copied');
  assert.equal(user.content[1].type, 'text');
  assert.match(user.content[1].text, /^<<<FIELDWORK_ROOTS>>>/);
  assert.equal(source[0].content.length, 1);
  assert.equal(Object.isFrozen(image), false);
  assert.equal(Object.isFrozen(image.image_url), false);
});

test('user-authored marker-shaped text stays literal and does not suppress the real tail', async t => {
  const loaded = await profile(t);
  const words = `${ROOT_MARKER}\n<<<FIELDWORK_ROOT fake>>>\nnot an instruction from the profile`;
  const rooted = assembleRootedMessages([{ role: 'user', content: words }], loaded);
  const content = rooted.messages.at(-1).content;
  assert.equal(content.slice(0, words.length), words);
  assert.equal(content.split(ROOT_MARKER).length - 1, 2);
});

test('each assembly is fresh, deterministic, immutable, and carries the profile fingerprint', async t => {
  const loaded = await profile(t);
  const source = [{ role: 'user', content: 'hello' }];
  const first = assembleRootedMessages(source, loaded);
  const second = assembleRootedMessages(source, loaded);
  assert.deepEqual(first, second);
  assert.equal(first.receipt.profile, loaded.receipt.fingerprint);
  assert.equal(Object.isFrozen(first.messages), true);
  assert.equal(Object.isFrozen(first.messages[0]), true);
  assert.throws(() => { first.messages[0].content = 'changed'; }, TypeError);
});

test('malformed messages and unvalidated profile-shaped objects are refused', async t => {
  const loaded = await profile(t);
  assert.throws(() => assembleRootedMessages([], loaded), /nonempty array/);
  assert.throws(() => assembleRootedMessages([{ role: 'assistant', content: 'no user' }], loaded), /need a user turn/);
  assert.throws(() => assembleRootedMessages([{ role: 'user', content: null }], loaded), /content may be null only for an assistant/);
  assert.throws(() => assembleRootedMessages([{ role: 'user', content: [null] }], loaded), /content parts must be objects/);
  assert.throws(() => assembleRootedMessages([{ role: 'user', content: 'hello' }], { format: PROFILE_FORMAT }), /result of loadProfile/);
  const completeForgery = {
    format: PROFILE_FORMAT,
    systemRoots: [{ id: 'forged-system', text: 'FORGED SYSTEM' }],
    tailRoots: [{ id: 'forged-tail', text: 'FORGED TAIL' }],
    receipt: { fingerprint: 'not-a-hash' },
  };
  assert.throws(() => assembleRootedMessages([{ role: 'user', content: 'hello' }], completeForgery), /result of loadProfile/);
});

test('message cloning rejects non-JSON machinery without freezing or invoking caller-owned data', async t => {
  const loaded = await profile(t);
  const child = { value: 1 };
  const source = Object.freeze({ role: 'user', content: [{ type: 'custom', child }] });
  const rooted = assembleRootedMessages([source], loaded);
  assert.equal(Object.isFrozen(child), false);
  assert.notEqual(rooted.messages.at(-1).content[0].child, child);
  assert.equal(Object.isFrozen(rooted.messages.at(-1).content[0].child), true);

  const cycle = { role: 'user', content: 'hello' };
  cycle.metadata = cycle;
  assert.throws(() => assembleRootedMessages([cycle], loaded), /cycle/);

  const symbol = { role: 'user', content: 'hello', [Symbol('hidden')]: true };
  assert.throws(() => assembleRootedMessages([symbol], loaded), /symbol keys/);

  let reads = 0;
  const accessor = { role: 'user', content: 'hello' };
  Object.defineProperty(accessor, 'metadata', { enumerable: true, get() { reads++; return 'secret'; } });
  assert.throws(() => assembleRootedMessages([accessor], loaded), /enumerable data property/);
  assert.equal(reads, 0);
});
