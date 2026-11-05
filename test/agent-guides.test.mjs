import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_GUIDE_CATALOG,
  AGENT_GUIDES_VIEW_FORMAT,
  agentGuideTools,
  createAgentGuideStore,
} from '../src/agent-guides.mjs';
import { createToolRegistry, executeTool, prepareToolCall } from '../src/tools.mjs';

async function fixture(t, { clock: suppliedClock } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-guides-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let tick = 0;
  const clock = suppliedClock ?? (() => new Date(Date.UTC(2030, 0, 2, 3, 4, tick++)));
  const file = path.join(directory, 'state', 'guides.json');
  return { directory, file, clock, store: await createAgentGuideStore({ file, clock }) };
}

const agent = Object.freeze({ kind: 'agent', id: 'synthetic-agent' });
const operator = Object.freeze({ kind: 'operator', id: 'browser' });

test('guide rewrites are attributed, conflict-checked, durable, and supplied only to matching tools', async t => {
  const data = await fixture(t);
  const initial = data.store.view();
  assert.equal(initial.format, AGENT_GUIDES_VIEW_FORMAT);
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.guides.map(row => row.id), AGENT_GUIDE_CATALOG.map(row => row.id));
  assert.ok(initial.guides.every(row => row.text === null && row.history.length === 0));
  assert.equal(data.store.contextText(['remember']), '');

  const read = data.store.read(['memory', 'discord']);
  assert.equal(read.revision, 0);
  assert.match(read.guides[0].canonical, /revise replaces/);
  const rewritten = await data.store.rewrite({
    expectedRevision: read.revision,
    author: agent,
    guides: [
      { id: 'memory', text: 'I keep what matters, cite what came from elsewhere, and leave every correction visible.' },
      { id: 'discord', text: 'One channel, one person, and in a server I wake only for a literal mention.' },
    ],
  });
  assert.equal(rewritten.revision, 1);
  assert.deepEqual(rewritten.guides.find(row => row.id === 'memory').author, agent);
  assert.equal(rewritten.guides.find(row => row.id === 'memory').history[0].preview, 'Fieldwork wording');
  assert.match(data.store.contextText(['remember']), /I keep what matters/);
  assert.equal(data.store.contextText(['read_web_page']), '', 'a memory note does not ride with unrelated tools');
  assert.doesNotMatch(data.store.contextText(['remember']), /One channel, one person/, 'person-facing bridge prose is not injected');

  await assert.rejects(data.store.rewrite({
    expectedRevision: 0, author: agent, guides: [{ id: 'memory', text: 'stale' }],
  }), error => error.status === 409 && /read them again/.test(error.message));

  const reloaded = await createAgentGuideStore({ file: data.file, clock: data.clock });
  assert.equal(reloaded.view().revision, 1);
  assert.match(reloaded.view().guides.find(row => row.id === 'discord').text, /literal mention/);
});

test('a person can return to canonical wording and restore an attributed earlier version', async t => {
  const data = await fixture(t);
  await data.store.rewrite({
    expectedRevision: 0,
    author: agent,
    guides: [{ id: 'telegram', text: 'My Telegram door is narrow, live-only, and mention-gated in a group.' }],
  });
  const reset = await data.store.reset({ id: 'telegram', expectedRevision: 1, author: operator });
  const guide = reset.guides.find(row => row.id === 'telegram');
  assert.equal(guide.text, null);
  assert.equal(guide.history[0].version, 'change-2');
  assert.match(guide.history[0].preview, /Telegram door/);

  const restored = await data.store.restore({
    id: 'telegram', version: 'change-2', expectedRevision: 2, author: operator,
  });
  const current = restored.guides.find(row => row.id === 'telegram');
  assert.match(current.text, /Telegram door/);
  assert.deepEqual(current.author, operator);
  assert.equal(restored.revision, 3);
});

test('guide tools require a scoped person request before an atomic batch rewrite', async t => {
  const data = await fixture(t);
  const tools = createToolRegistry(agentGuideTools(data.store, { agentId: 'synthetic-agent' }));
  const request = data.store.request({ guides: ['memory', 'social-media'], author: operator });
  const summary = prepareToolCall(tools, 'rewrite_house_guides', {
    request_id: request.requestId,
    expected_revision: 0,
    guides: [
      { id: 'memory', text: 'PRIVATE SYNTHETIC GUIDE BODY ONE' },
      { id: 'social-media', text: 'PRIVATE SYNTHETIC GUIDE BODY TWO' },
    ],
  }).permissionSummary;
  assert.match(summary, /Rewrite 2 selected house guides/);
  assert.doesNotMatch(summary, /PRIVATE SYNTHETIC GUIDE BODY/);
  const read = await executeTool(tools, 'read_house_guides', { request_id: request.requestId });
  assert.equal(read.revision, 0);
  assert.deepEqual(read.selectedGuides, ['memory', 'social-media']);
  assert.match(read.guides[1].canonical, /does not post/);
  const result = await executeTool(tools, 'rewrite_house_guides', {
    request_id: request.requestId,
    expected_revision: read.revision,
    guides: [
      { id: 'memory', text: 'I write down what I intend to carry and keep the old claim when I correct it.' },
      { id: 'social-media', text: 'This sign has my voice, but it is not a key: no selected pack, no posting.' },
    ],
  });
  assert.deepEqual(result, { rewritten: ['memory', 'social-media'], revision: 1 });
  assert.deepEqual(data.store.view().guides.find(row => row.id === 'social-media').author, agent);
  await assert.rejects(
    executeTool(tools, 'read_house_guides', { request_id: request.requestId }),
    /missing, expired, or already used/,
  );

  const narrow = data.store.request({ guides: ['memory'], author: operator });
  const narrowRead = await executeTool(tools, 'read_house_guides', { request_id: narrow.requestId });
  await assert.rejects(executeTool(tools, 'rewrite_house_guides', {
    request_id: narrow.requestId,
    expected_revision: narrowRead.revision,
    guides: [{ id: 'discord', text: 'This was not selected.' }],
  }), /discord was not selected/);
});

test('guide stores reject malformed, excessive, duplicate, and hidden inputs', async t => {
  const data = await fixture(t);
  await assert.rejects(data.store.rewrite({
    expectedRevision: 0, author: agent,
    guides: [{ id: 'memory', text: 'first' }, { id: 'memory', text: 'second' }],
  }), /repeats memory/);
  await assert.rejects(data.store.rewrite({
    expectedRevision: 0, author: agent, guides: [{ id: 'memory', text: 'x'.repeat(2001) }],
  }), /at most 2000/);
  await assert.rejects(data.store.rewrite({
    expectedRevision: 0, author: agent, guides: [{ id: 'unknown', text: 'no' }],
  }), /not in the guide catalog/);
  await assert.rejects(data.store.rewrite({
    expectedRevision: 0, author: agent, guides: [{ id: 'memory', text: 'valid', surprise: true }],
  }), /unknown field/);
  await assert.rejects(data.store.restore({ id: 'memory', version: '../../outside', expectedRevision: 0, author: operator }), /does not exist/);
  assert.throws(() => data.store.request({ guides: ['memory'], author: agent }), /only the room operator/);
  assert.throws(() => data.store.request({ guides: ['memory', 'memory'], author: operator }), /repeats memory/);

  const malformed = path.join(data.directory, 'malformed.json');
  await fs.writeFile(malformed, '{"format":"fieldwork-agent-guides/v1","revision":0,"revision":1,"guides":{},"history":{}}');
  await assert.rejects(createAgentGuideStore({ file: malformed }), /repeats object key/);
});

test('concurrent rewrites serialize so only one stale revision can win', async t => {
  const data = await fixture(t);
  const attempts = await Promise.allSettled([
    data.store.rewrite({ expectedRevision: 0, author: agent, guides: [{ id: 'memory', text: 'first voice' }] }),
    data.store.rewrite({ expectedRevision: 0, author: agent, guides: [{ id: 'memory', text: 'second voice' }] }),
  ]);
  assert.deepEqual(attempts.map(row => row.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(data.store.view().revision, 1);
});

test('an unused guide rewrite request expires instead of becoming standing authority', async t => {
  let milliseconds = Date.UTC(2030, 0, 2, 3, 4, 0);
  const data = await fixture(t, { clock: () => new Date(milliseconds) });
  const request = data.store.request({ guides: ['memory'], author: operator });
  assert.equal(data.store.readRequest(request.requestId).guides[0].id, 'memory');
  milliseconds += 31 * 60 * 1000;
  assert.throws(() => data.store.readRequest(request.requestId), /missing, expired, or already used/);
});
