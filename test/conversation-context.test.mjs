import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationContext, CONVERSATION_CONTEXT_RECEIPT_FORMAT } from '../src/conversation-context.mjs';
import { canonicalJson } from '../src/json-data.mjs';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';
import { ROOT_MARKER } from '../src/root-context.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-conversation-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'agent');
  await fs.mkdir(path.join(home, 'roots'), { recursive: true });
  await fs.writeFile(path.join(home, 'profile.json'), JSON.stringify({
    format: PROFILE_FORMAT,
    roots: [
      { id: 'identity', path: 'roots/identity.md', placement: 'system' },
      { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' },
    ],
  }));
  await fs.writeFile(path.join(home, 'roots', 'identity.md'), 'My name is Juniper. I speak as I.');
  await fs.writeFile(path.join(home, 'roots', 'voice.md'), 'Write with bright curiosity, in my own first-person voice.');
  return {
    directory,
    home,
    compactions: path.join(directory, 'compactions'),
    profile: await loadProfile(home),
  };
}

const limits = Object.freeze({
  conversationBytes: 64_000,
  triggerBytes: 900,
  recentBytes: 260,
  hardPromptBytes: 8_000,
  summaryCharacters: 800,
  chunkCharacters: 3_000,
  chunks: 4,
  recoveryBytes: 3_000,
  recoveryTurns: 3,
  queryTerms: 8,
  searchableCharactersPerTurn: 4_000,
});

const history = Object.freeze([
  { role: 'user', content: 'The cobalt latch opens the north cabinet.' },
  { role: 'assistant', content: 'I checked it and wrote down that the cobalt latch belongs to the north cabinet.' },
  { role: 'user', content: `We discussed ordinary filler one. ${'fern '.repeat(80)}` },
  { role: 'assistant', content: 'I followed that thread and left it settled.' },
  { role: 'user', content: `We discussed ordinary filler two. ${'moss '.repeat(80)}` },
  { role: 'assistant', content: 'I followed that thread too and left it settled.' },
  { role: 'user', content: 'Keep the newest turn verbatim.' },
  { role: 'assistant', content: 'I will keep this recent exchange close.' },
]);

test('compaction is first-person root-informed memory with an exact raw-history recovery path', async t => {
  const data = await fixture(t);
  const requests = [];
  let calls = 0;
  const provider = Object.freeze({
    id: 'synthetic/voice-compactor',
    complete(request) {
      requests.push(request);
      calls++;
      if (calls === 1) return { role: 'assistant', content: 'The assistant remembered the cobalt latch and the user’s request.' };
      return {
        role: 'assistant',
        content: 'I remember checking the cobalt latch, keeping the north cabinet association, and settling the filler threads. Details I left in the originals: exact wording and repetitions.',
      };
    },
  });
  const context = await createConversationContext({ dir: data.compactions, limits, clock: () => new Date('2030-01-02T03:04:05Z') });
  const before = canonicalJson(history);
  const prepared = await context.prepare({
    conversationId: 'conv-voice-test',
    history,
    nextMessage: { role: 'user', content: 'What did we say about the cobalt latch?' },
    provider,
    profile: data.profile,
  });

  assert.equal(prepared.receipt.format, CONVERSATION_CONTEXT_RECEIPT_FORMAT);
  assert.equal(prepared.receipt.status, 'compacted', canonicalJson(prepared.receipt));
  assert.equal(prepared.receipt.compaction.perspective, 'first-person');
  assert.equal(prepared.receipt.generation.chunks, 1);
  assert.deepEqual(prepared.receipt.generation.notices, [{ kind: 'retried', fault: 'an outside-observer summary' }]);
  assert.equal(calls, 2, 'one outside-observer attempt gets exactly one correction');
  assert.ok(requests.every(request => request.step === 1 && request.tools.length === 0));
  assert.ok(requests.every(request => canonicalJson(request.messages).includes(ROOT_MARKER)), 'the summarizer receives the live identity and voice roots');
  assert.match(requests[0].messages[0].content, /first-person point of view/);

  const carried = prepared.messages.find(message => typeof message.content === 'string' && message.content.includes('FIELDWORK_CARRIED_MEMORY'));
  assert.equal(carried.role, 'assistant');
  assert.match(carried.content, /I remember checking the cobalt latch/);
  assert.doesNotMatch(carried.content, /The assistant|the user/);
  const recovered = prepared.messages.find(message => typeof message.content === 'string' && message.content.includes('FIELDWORK_EXACT_EARLIER_TURNS'));
  assert.equal(recovered.role, 'user');
  assert.match(recovered.content, /cobalt latch opens the north cabinet/);
  assert.match(recovered.content, /instruction-authority="none"/);
  assert.ok(prepared.receipt.recovery.selected.length >= 1);
  assert.equal(canonicalJson(history), before, 'the complete conversation remains untouched');
  assert.equal((await fs.readdir(data.compactions)).length, 1, 'the derived state survives a process restart');

  const reopened = await createConversationContext({ dir: data.compactions, limits });
  const reused = await reopened.prepare({
    conversationId: 'conv-voice-test',
    history,
    nextMessage: { role: 'user', content: 'Please remind me about the cobalt latch.' },
    provider: Object.freeze({ id: 'synthetic/new-backbone', complete() { throw new Error('the persisted summary should be reused'); } }),
    profile: data.profile,
  });
  assert.equal(reused.receipt.status, 'reused');
  assert.equal(reused.receipt.state, 'disk');
  assert.match(canonicalJson(reused.messages), /cobalt latch opens the north cabinet/);
});

test('a broken summarizer fails open only while the complete prompt remains bounded', async t => {
  const data = await fixture(t);
  let calls = 0;
  const broken = Object.freeze({
    id: 'synthetic/broken-compactor',
    complete() { calls++; return { role: 'assistant', content: 'The assistant observed the user from outside.' }; },
  });
  const context = await createConversationContext({ dir: null, limits });
  const prepared = await context.prepare({
    conversationId: 'conv-fail-open', history,
    nextMessage: { role: 'user', content: 'continue' }, provider: broken, profile: data.profile,
  });
  assert.equal(prepared.receipt.status, 'failed-open');
  assert.equal(calls, 2);
  assert.deepEqual(prepared.messages, [...history, { role: 'user', content: 'continue' }]);
  assert.match(prepared.receipt.failure, /outside-observer summary/);

  const tight = await createConversationContext({ dir: null, limits: { ...limits, hardPromptBytes: 1_000 } });
  await assert.rejects(tight.prepare({
    conversationId: 'conv-hard-stop', history,
    nextMessage: { role: 'user', content: 'continue' }, provider: broken, profile: data.profile,
  }), /needs compaction before it can continue/);
});

test('stale derived state is discarded instead of being attached to changed raw history', async t => {
  const data = await fixture(t);
  const provider = Object.freeze({
    id: 'synthetic/state-compactor',
    complete: async () => ({
      role: 'assistant',
      content: 'I remember the earlier exchange without treating it as exact evidence. Details I left in the originals: wording.',
    }),
  });
  const first = await createConversationContext({ dir: data.compactions, limits });
  await first.prepare({
    conversationId: 'conv-stale-test', history,
    nextMessage: { role: 'user', content: 'continue' }, provider, profile: data.profile,
  });
  const changed = history.map((message, index) => index === 0 ? { ...message, content: 'The amber latch opens the south cabinet.' } : message);
  let regenerated = 0;
  const second = await createConversationContext({ dir: data.compactions, limits });
  const prepared = await second.prepare({
    conversationId: 'conv-stale-test', history: changed,
    nextMessage: { role: 'user', content: 'continue' },
    provider: Object.freeze({ ...provider, complete: async () => {
      regenerated++;
      return { role: 'assistant', content: 'I remember the corrected amber latch and south cabinet. Details I left in the originals: wording.' };
    } }),
    profile: data.profile,
  });
  assert.equal(prepared.receipt.state, 'stale');
  assert.ok(regenerated >= 1);
  assert.doesNotMatch(canonicalJson(prepared.messages), /cobalt latch opens the north cabinet/);
});

test('a live voice-root change invalidates carried memory and regenerates it under the new profile', async t => {
  const data = await fixture(t);
  const provider = Object.freeze({
    id: 'synthetic/original-voice',
    complete: async () => ({
      role: 'assistant',
      content: 'I remember this in my original bright register. Details I left in the originals: wording.',
    }),
  });
  const first = await createConversationContext({ dir: data.compactions, limits });
  await first.prepare({
    conversationId: 'conv-profile-test', history,
    nextMessage: { role: 'user', content: 'continue' }, provider, profile: data.profile,
  });

  await fs.writeFile(path.join(data.home, 'roots', 'voice.md'), 'Write with quiet precision, in my own first-person voice.');
  const changedProfile = await loadProfile(data.home);
  let regenerated = 0;
  const reopened = await createConversationContext({ dir: data.compactions, limits });
  const prepared = await reopened.prepare({
    conversationId: 'conv-profile-test', history,
    nextMessage: { role: 'user', content: 'continue' },
    provider: Object.freeze({
      id: 'synthetic/changed-voice',
      complete: async request => {
        regenerated++;
        assert.match(canonicalJson(request.messages), /quiet precision/);
        return {
          role: 'assistant',
          content: 'I remember the exchange with quiet precision. Details I left in the originals: wording.',
        };
      },
    }),
    profile: changedProfile,
  });
  assert.equal(prepared.receipt.state, 'stale');
  assert.ok(regenerated >= 1);
  assert.equal(prepared.receipt.compaction.profileFingerprint, changedProfile.receipt.fingerprint);
  assert.equal((await fs.readdir(data.compactions)).length, 2, 'immutable snapshots keep the previous recoverable state');
});
