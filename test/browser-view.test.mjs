import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  startBrowserView,
  BROWSER_APPEARANCE_DEFAULTS,
  BROWSER_APPEARANCE_FORMAT,
  BROWSER_VIEW_FORMAT,
  BROWSER_VIEW_LIMITS,
  CHANGE_OPEN_TARGETS,
} from '../src/browser-view.mjs';
import { createConversationArchive, openConversationArchive } from '../src/conversation-archive.mjs';
import { createConversationStore } from '../src/conversation-store.mjs';
import { createReplyContextStore, openReplyContextStore } from '../src/reply-context.mjs';
import {
  BRIDGE_OUTPUT_FORMAT,
  createBridgeOutput,
  createExternalDeliveryCoordinator,
  createExternalDeliveryStore,
  EXTERNAL_DELIVERY_ACTION_FORMAT,
  EXTERNAL_DELIVERY_EVENT_FORMAT,
  EXTERNAL_DELIVERY_POLICY,
  openExternalDeliveryStore,
} from '../src/external-delivery.mjs';
import { openDurableLog } from '../src/durable-log.mjs';
import { createMemoryLedger } from '../src/memory-ledger.mjs';
import { createMeaningRecall } from '../src/meaning-recall.mjs';
import { PACK_HOST_RECEIPT_FORMAT } from '../src/packs.mjs';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';
import { createMemoryRecord, createRetrievedEvidence, createSourceReference } from '../src/provenance.mjs';
import { createToolRegistry } from '../src/tools.mjs';
import { createToolPermissionStore } from '../src/tool-permissions.mjs';
import { createToolEffectStore, openToolEffectStore } from '../src/tool-effects.mjs';
import { MODEL_CONNECTION_COMMAND_FORMAT, MODEL_CONNECTION_FORMAT } from '../src/model-connection.mjs';
import { BRIDGE_COMMAND_FORMAT, BRIDGE_PUBLIC_FORMAT } from '../src/bridge-management.mjs';
import { agentGuideTools, createAgentGuideStore } from '../src/agent-guides.mjs';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const at = '2030-01-02T03:04:05.000Z';
const clock = () => new Date(at);
const actor = { kind: 'operator', id: 'synthetic-browser-operator' };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-browser-view-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'agent-home');
  await fs.mkdir(path.join(home, 'roots'), { recursive: true });
  await fs.writeFile(path.join(home, 'profile.json'), JSON.stringify({
    format: PROFILE_FORMAT,
    roots: [
      { id: 'identity', path: 'roots/identity.md', placement: 'system' },
      { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' },
    ],
  }));
  await fs.writeFile(path.join(home, 'roots', 'identity.md'), 'PRIVATE SYNTHETIC ROOT SENTINEL');
  await fs.writeFile(path.join(home, 'roots', 'voice.md'), 'Speak in a synthetic browser-test register.');
  const profile = await loadProfile(home);

  const ledger = await createMemoryLedger(path.join(directory, 'memory.jsonl'), {
    ledgerId: 'browser-memory', clock,
  });
  const source = createSourceReference({
    kind: 'document',
    id: 'C:\\synthetic-private\\memory.md',
    locator: 'https://synthetic-user:synthetic-secret@example.invalid/item',
    sha256: hash('source'),
    observedThrough: at,
  });
  const oldEvidence = createRetrievedEvidence({
    source, excerpt: 'The browser route uses the amber gate.', retrievedAt: at,
    retrieval: { method: 'exact', queryHash: hash('amber'), rank: 1, score: 1 },
  });
  const oldRecord = createMemoryRecord({
    id: 'observation:browser-route', kind: 'observation', text: 'The browser route uses the amber gate.',
    author: actor, createdAt: at, basis: 'source-backed', confidence: 'supported',
    sources: [source], evidence: [oldEvidence],
  });
  const oldView = await ledger.record(oldRecord);
  const newEvidence = createRetrievedEvidence({
    source, excerpt: 'Correction: the browser route uses the cobalt gate.', retrievedAt: at,
    retrieval: { method: 'exact', queryHash: hash('cobalt'), rank: 1, score: 1 },
  });
  const newRecord = createMemoryRecord({
    id: 'observation:browser-route', kind: 'observation', text: 'The browser route uses the cobalt gate.',
    author: actor, createdAt: at, basis: 'source-backed', confidence: 'supported',
    sources: [source], evidence: [newEvidence],
  });
  await ledger.supersede({
    id: oldRecord.id,
    expectedFingerprint: oldView.currentFingerprint,
    expectedSequence: oldView.lastSequence,
    replacement: newRecord,
    actor,
    reason: 'Synthetic correction for the browser view.',
  });

  const archive = await createConversationArchive(path.join(directory, 'conversation.jsonl'), {
    archiveId: 'browser-archive', clock,
  });
  t.after(async () => {
    try { await archive.close(); } catch { /* A failed test may already have closed it. */ }
    try { await ledger.close(); } catch { /* A failed test may already have closed it. */ }
  });
  return { directory, home, profile, ledger, archive, source };
}

async function waitForCondition(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function settleWithin(promise, message, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('state-history editor targets are complete and point to real settings panels', async () => {
  assert.deepEqual(CHANGE_OPEN_TARGETS, {
    guides: 'guides',
    roots: 'roots',
    look: 'identity',
    moods: 'expression',
    emoji: 'expression',
    thinking: 'expression',
    checkins: 'checkins',
    model: 'connection',
    appearance: 'appearance',
    tools: 'tools',
    'tool-permissions': 'tools',
  });
  const html = await fs.readFile(new URL('../browser/index.html', import.meta.url), 'utf8');
  for (const target of new Set(Object.values(CHANGE_OPEN_TARGETS))) {
    if (target === 'roots') continue;
    assert.match(html, new RegExp(`data-settings-page="${target}"`));
    assert.match(html, new RegExp(`data-settings-page-panel="${target}"`));
  }
  const script = await fs.readFile(new URL('../browser/app.js', import.meta.url), 'utf8');
  assert.match(script, /if \(opens === 'roots'\)/);
  assert.match(script, /void openRootEditor\(key\.slice\('root:'\.length\)\)/);
  assert.match(script, /if \(response\.model\) applyModelResponse\(response\)/);
});

test('state-history filters keep readable control and placeholder colors', async () => {
  const css = await fs.readFile(new URL('../browser/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.changes-search input, \.changes-search select \{[^}]*background: var\(--void\);[^}]*color: var\(--paper\);/);
  assert.match(css, /\.changes-search input::placeholder \{ color: var\(--muted\); opacity: 1; \}/);
  assert.doesNotMatch(css, /\.changes-search input, \.changes-search select \{[^}]*background: var\(--ink\);/);
});

test('portable agent controls stay compact, searchable, and explicit about dormant imports', async () => {
  const html = await fs.readFile(new URL('../browser/index.html', import.meta.url), 'utf8');
  const script = await fs.readFile(new URL('../browser/app.js', import.meta.url), 'utf8');
  assert.match(html, /data-settings-keywords="[^"]*export import portable copy[^"]*"/);
  assert.match(html, /<details[^>]+id="agent-portable-copy">[\s\S]*?id="agent-export-form"[\s\S]*?id="agent-import-form"[\s\S]*?remains dormant until you switch/);
  assert.match(script, /action: 'export-agent', id: active\.id, destination: elements\.agentExportDestination\.value/);
  assert.match(script, /action: 'import-agent', source: elements\.agentImportSource\.value/);
  assert.match(script, /elements\.agentExportForm, elements\.agentImportForm/);
  assert.match(script, /body\.action === 'export-agent' \|\| body\.action === 'import-agent'[\s\S]*?timeoutMs: 30 \* 60_000/);
});

test('reasoning effort lives in the connection settings and uses a dedicated bounded route', async () => {
  const html = await fs.readFile(new URL('../browser/index.html', import.meta.url), 'utf8');
  const script = await fs.readFile(new URL('../browser/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="model-effort-form"[\s\S]*?id="model-effort"[\s\S]*?Provider default/);
  assert.match(html, /id="model-effort-status" role="status" aria-live="polite"/);
  assert.match(script, /request\('\/api\/model\/effort', \{ method: 'POST', body: \{ effort \} \}\)/);
  assert.match(script, /not currently advertised/);
});

function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

function streamingRequest(url, { method = 'POST', headers = {}, chunk }) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      signal: AbortSignal.timeout(5000),
    }, response => {
      const chunks = [];
      response.on('data', value => chunks.push(value));
      response.on('end', () => {
        request.destroy();
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on('error', reject);
    request.write(chunk);
  });
}

function launchAuthorization(view) {
  const url = new URL(view.url);
  const values = new URLSearchParams(url.hash.slice(1)).getAll('token');
  assert.equal(values.length, 1);
  assert.match(values[0], /^[A-Za-z0-9_-]{43}$/);
  url.hash = '';
  return { token: values[0], url, origin: url.origin };
}

async function bootstrapRequest(view, token) {
  const response = await fetch(new URL('/api/bootstrap', view.url), {
    headers: token === undefined ? {} : { 'x-fieldwork-token': token },
  });
  let value;
  try { value = await response.json(); } catch { value = null; }
  return { response, value };
}

async function jsonRequest(view, route, token, body, extraHeaders = {}) {
  const response = await fetch(new URL(route, view.url), {
    method: 'POST',
    headers: {
      origin: new URL(view.url).origin,
      'content-type': 'application/json',
      'x-fieldwork-token': token,
      ...extraHeaders,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { response, value: await response.json() };
}

async function exactOutsideReaderFixture(data, selectedClock = clock, suffix = 'reservation') {
  const { createOutsideReaderStore } = await import('../src/outside-readers.mjs');
  const { createGoalRegister } = await import('../src/goal-register.mjs');
  const outsideReaders = await createOutsideReaderStore({
    file: path.join(data.directory, `outside-readers-${suffix}.json`),
    clock: selectedClock,
  });
  const goals = await createGoalRegister({
    file: path.join(data.directory, `outside-reader-goals-${suffix}.json`),
    clock: selectedClock,
  });
  const record = await goals.create({
    definition: {
      kind: 'promise',
      name: `Synthetic reservation promise ${suffix}`,
      statement: 'Keep this exact synthetic record inside the reservation test.',
      chosenBy: 'agent',
      source: 'Synthetic reservation source.',
      beneficiary: 'Synthetic beneficiary',
      successSignals: '',
      reviewAt: null,
      returnFrom: '2029-12-01T00:00:00.000Z',
      returnBy: '2030-01-01T00:00:00.000Z',
      measures: [],
    },
  });
  const reader = await outsideReaders.create({
    definition: {
      name: `Synthetic reservation reader ${suffix}`,
      focus: 'Review only the exact selected synthetic promise.',
      cadenceHours: 24,
      source: { type: 'goal-record-set', recordIds: [record.id] },
    },
  });
  return { outsideReaders, goals, record, reader };
}

test('an opt-in browser room adds relevant current memory without storing the foreground in chat', async t => {
  const data = await fixture(t);
  let providerRequest;
  const view = await startBrowserView({
    profile: data.profile,
    ledger: data.ledger,
    archive: data.archive,
    memoryForeground: true,
    clock,
    timeZone: 'UTC',
    provider: {
      id: 'synthetic/memory-foreground-provider',
      complete(input) {
        providerRequest = input;
        return { role: 'assistant', content: 'The current synthetic gate is cobalt.' };
      },
    },
  });
  t.after(() => view.close());
  const launch = launchAuthorization(view);
  const boot = await bootstrapRequest(view, launch.token);
  assert.equal(boot.value.capabilities.automaticMemory, true);
  assert.match(boot.value.notice, /Relevant current memories may be brought/);

  const chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'What uses the cobalt gate?' });
  assert.equal(chat.response.status, 200);
  const memoryIndex = providerRequest.messages.findIndex(message => /browser route uses the cobalt gate/.test(String(message.content)));
  const userIndex = providerRequest.messages.findLastIndex(message => message.role === 'user');
  assert.ok(memoryIndex >= 0 && memoryIndex < userIndex);
  assert.equal(providerRequest.messages[memoryIndex].role, 'user');
  assert.doesNotMatch(JSON.stringify(providerRequest.messages), /browser route uses the amber gate/);
  assert.match(String(providerRequest.messages[userIndex].content), /Speak in a synthetic browser-test register/);
  assert.doesNotMatch(JSON.stringify(chat.value.conversation), /FIELDWORK_MEMORY|browser route uses the cobalt gate/);
  const foregroundReceipt = chat.value.receipt.events.find(event => event.type === 'run_started').memoryForeground;
  assert.equal(foregroundReceipt.status, 'ready');
  assert.deepEqual(foregroundReceipt.selected.map(row => row.id), ['observation:browser-route']);
  assert.deepEqual(foregroundReceipt.selected[0].sources, [{
    kind: 'document', fingerprint: data.source.fingerprint, observedThrough: at,
  }]);
  assert.equal(foregroundReceipt.context.included[0].id, 'observation:browser-route');
  assert.equal(foregroundReceipt.query.time.now, at);
  assert.equal(foregroundReceipt.query.time.timeZone, 'UTC');
  assert.doesNotMatch(JSON.stringify(foregroundReceipt), /browser route|synthetic-private|synthetic-secret/);
  assert.equal(chat.value.receipt.events.find(event => event.type === 'provider_request').memoryForeground.status, 'ready');
});

test('browser provenance keeps eight lexical memories plus one meaning seat coherent', async t => {
  const data = await fixture(t);
  const lexical = ['zephyr', 'quasar', 'marmalade', 'xylophone', 'saffron', 'thimble', 'wainscot', 'vellum'];
  for (const [index, term] of lexical.entries()) {
    await data.ledger.record(createMemoryRecord({
      id: `memory:lexical-${index + 1}`,
      kind: 'authored-memory',
      text: `The synthetic lexical marker is ${term}.`,
      author: { kind: 'agent', id: 'synthetic-agent' },
      createdAt: at,
      basis: 'self-authored',
      confidence: 'asserted',
    }));
  }
  await data.ledger.record(createMemoryRecord({
    id: 'memory:puppy-seat',
    kind: 'authored-memory',
    text: 'Biscuit is the puppy adopted last spring.',
    author: { kind: 'agent', id: 'synthetic-agent' },
    createdAt: at,
    basis: 'self-authored',
    confidence: 'asserted',
  }));
  const topicFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      data: body.input.map((text, index) => ({
        index,
        embedding: [/dog|puppy|biscuit/i.test(text) ? 1 : 0, 0.2],
      })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const meaningRecall = await createMeaningRecall({
    stateDir: path.join(data.directory, 'meaning-projection'),
    floor: 0.5,
    fetch: topicFetch,
  });
  const view = await startBrowserView({
    profile: data.profile,
    ledger: data.ledger,
    archive: data.archive,
    memoryForeground: true,
    meaningRecall,
    clock,
    timeZone: 'UTC',
    provider: { id: 'synthetic/provenance-provider', complete: () => ({ role: 'assistant', content: 'ok' }) },
  });
  t.after(() => view.close());
  const launch = launchAuthorization(view);
  await bootstrapRequest(view, launch.token);
  const message = `dog ${lexical.join(' ')}`;
  const chat = await jsonRequest(view, '/api/chat', launch.token, { text: message });
  assert.equal(chat.response.status, 200);

  const foreground = chat.value.receipt.events.find(event => event.type === 'provider_request').memoryForeground;
  assert.equal(foreground.selected.length, 9, JSON.stringify(foreground.meaning));
  assert.equal(foreground.selected.filter(row => row.matchedBy !== 'meaning').length, 8);
  assert.deepEqual(foreground.selected.filter(row => row.matchedBy === 'meaning').map(row => row.id), ['memory:puppy-seat']);
  const selectedIds = new Set(foreground.selected.map(row => row.id));
  const includedIds = new Set(foreground.context.included.map(row => row.id));
  const skippedIds = new Set(foreground.context.skipped.map(row => row.id));
  assert.equal([...includedIds].some(id => skippedIds.has(id)), false);
  assert.deepEqual(new Set([...includedIds, ...skippedIds]), selectedIds);
});

test('a client disconnect during meaning recall releases the room for the next chat', async t => {
  const data = await fixture(t);
  const { createAttachmentStore } = await import('../src/attachments.mjs');
  const attachments = await createAttachmentStore({ dir: path.join(data.directory, 'disconnect-attachments') });
  await data.ledger.record(createMemoryRecord({
    id: 'memory:disconnect-puppy',
    kind: 'authored-memory',
    text: 'Biscuit is the puppy adopted last spring.',
    author: { kind: 'agent', id: 'synthetic-agent' },
    createdAt: at,
    basis: 'self-authored',
    confidence: 'asserted',
  }));
  const readyFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      data: body.input.map((text, index) => ({
        index,
        embedding: [/dog|puppy|biscuit/i.test(text) ? 1 : 0, 0.2],
      })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let enterLookup;
  const lookupEntered = new Promise(resolve => { enterLookup = resolve; });
  let finishCancellation;
  const lookupCancelled = new Promise(resolve => { finishCancellation = resolve; });
  let firstRequest = true;
  const meaningRecall = await createMeaningRecall({
    stateDir: path.join(data.directory, 'meaning-disconnect'),
    fetch: async (url, init) => {
      if (!firstRequest) return readyFetch(url, init);
      firstRequest = false;
      enterLookup();
      return new Promise((_resolve, reject) => {
        const stop = () => {
          finishCancellation();
          reject(init.signal.reason ?? new Error('synthetic semantic lookup stopped'));
        };
        if (init.signal.aborted) stop();
        else init.signal.addEventListener('abort', stop, { once: true });
      });
    },
  });
  let chatProviderCalls = 0;
  let fieldworkProviderCalls = 0;
  let fieldworkToolResult = '';
  const view = await startBrowserView({
    profile: data.profile,
    ledger: data.ledger,
    archive: data.archive,
    memoryForeground: true,
    meaningRecall,
    attachments,
    lookFile: path.join(data.directory, 'disconnect-look.json'),
    fieldworkDir: path.join(data.directory, 'disconnect-fieldworks'),
    clock,
    timeZone: 'UTC',
    provider: {
      id: 'synthetic/disconnect-provider',
      complete(request) {
        const isFieldwork = request.messages.some(message => message.role === 'system'
          && typeof message.content === 'string' && message.content.includes('This is a Fieldwork'));
        if (isFieldwork) {
          fieldworkProviderCalls += 1;
          const result = request.messages.findLast(message => message.role === 'tool');
          if (result) {
            fieldworkToolResult = String(result.content);
            return { role: 'assistant', content: 'The canceled picture was unavailable.' };
          }
          return {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'try-canceled-picture',
              type: 'function',
              function: { name: 'set_my_portrait', arguments: '{"picture":1}' },
            }],
          };
        }
        chatProviderCalls += 1;
        return { role: 'assistant', content: 'The room accepted the next message.' };
      },
    },
  });
  t.after(() => view.close());
  const launch = launchAuthorization(view);

  const controller = new AbortController();
  const interrupted = fetch(new URL('/api/chat', view.url), {
    method: 'POST',
    headers: {
      origin: launch.origin,
      'content-type': 'application/json',
      'x-fieldwork-token': launch.token,
    },
    body: JSON.stringify({
      text: 'How is my dog doing?',
      attachments: [{
        name: 'canceled.png',
        dataUrl: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]).toString('base64')}`,
      }],
    }),
    signal: controller.signal,
  });
  await lookupEntered;
  controller.abort(new Error('synthetic browser client disconnected'));
  await assert.rejects(interrupted, /synthetic browser client disconnected|abort/i);
  await lookupCancelled;
  assert.equal(chatProviderCalls, 0, 'the abandoned lookup never reaches the model');

  let started;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    started = await jsonRequest(view, '/api/fieldworks/start', launch.token, {
      prompt: 'Try to use the picture from the canceled message.',
      maxSteps: 3,
    });
    if (started.response.status !== 409) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(started.response.status, 200, started.value?.error);
  let fieldwork;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    fieldwork = (await jsonRequest(view, '/api/fieldworks/get', launch.token, { id: started.value.fieldwork.id })).value.fieldwork;
    if (fieldwork.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fieldwork.status, 'completed');
  assert.match(fieldworkToolResult, /No pictures have been attached in this conversation yet/);
  assert.equal((await bootstrapRequest(view, launch.token)).value.look.agent.icon, null);
  assert.equal(fieldworkProviderCalls, 2);

  let recovered;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    recovered = await jsonRequest(view, '/api/chat', launch.token, { text: 'How is my dog doing now?' });
    if (recovered.response.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(recovered.response.status, 200, recovered.value?.error);
  assert.equal(chatProviderCalls, 1);
  assert.deepEqual(recovered.value.conversation.messages.map(message => message.display), [
    'How is my dog doing now?',
    'The room accepted the next message.',
  ]);
});

test('a background Fieldwork cannot use an overlapping chat\'s uncommitted picture', async t => {
  const data = await fixture(t);
  const { createAttachmentStore } = await import('../src/attachments.mjs');
  const attachments = await createAttachmentStore({ dir: path.join(data.directory, 'overlap-attachments') });
  let enterChat;
  const chatEntered = new Promise(resolve => { enterChat = resolve; });
  let releaseChat;
  const chatGate = new Promise(resolve => { releaseChat = resolve; });
  let fieldworkToolResult = '';
  const provider = {
    id: 'synthetic/overlap-provider',
    async complete(request) {
      const isFieldwork = request.messages.some(message => message.role === 'system'
        && typeof message.content === 'string' && message.content.includes('This is a Fieldwork'));
      if (!isFieldwork) {
        enterChat();
        await chatGate;
        return { role: 'assistant', content: 'The overlapping chat finished.' };
      }
      const result = request.messages.findLast(message => message.role === 'tool');
      if (result) {
        fieldworkToolResult = String(result.content);
        return { role: 'assistant', content: 'No uncommitted picture crossed into Fieldwork.' };
      }
      await chatEntered;
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'overlap-picture-attempt',
          type: 'function',
          function: { name: 'set_my_portrait', arguments: '{"picture":1}' },
        }],
      };
    },
  };
  const view = await startBrowserView({
    profile: data.profile,
    provider,
    archive: data.archive,
    attachments,
    lookFile: path.join(data.directory, 'overlap-look.json'),
    fieldworkDir: path.join(data.directory, 'overlap-fieldworks'),
    clock,
  });
  t.after(async () => {
    releaseChat();
    await view.close();
  });
  const { token } = launchAuthorization(view);

  const started = await jsonRequest(view, '/api/fieldworks/start', token, {
    prompt: 'Try to use any picture visible to this exact Fieldwork run.',
    maxSteps: 3,
  });
  assert.equal(started.response.status, 200);
  const pendingChat = jsonRequest(view, '/api/chat', token, {
    text: 'Keep this picture inside my still-uncommitted chat.',
    attachments: [{
      name: 'overlap.png',
      dataUrl: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString('base64')}`,
    }],
  });
  await chatEntered;

  let fieldwork;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    fieldwork = (await jsonRequest(view, '/api/fieldworks/get', token, { id: started.value.fieldwork.id })).value.fieldwork;
    if (fieldwork.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fieldwork.status, 'completed');
  assert.match(fieldworkToolResult, /No pictures have been attached in this conversation yet/);
  assert.equal((await bootstrapRequest(view, token)).value.look.agent.icon, null);

  releaseChat();
  const chat = await pendingChat;
  assert.equal(chat.response.status, 200);
});

test('the reply fold reads offered memory words from the ledger, never from receipts', async t => {
  const data = await fixture(t);
  const view = await startBrowserView({
    profile: data.profile, ledger: data.ledger, archive: data.archive, clock, timeZone: 'UTC',
    provider: { id: 'synthetic/offered-memory-provider', complete: () => ({ role: 'assistant', content: 'ok' }) },
  });
  t.after(() => view.close());
  const launch = launchAuthorization(view);
  await bootstrapRequest(view, launch.token);
  const entry = await data.ledger.get('observation:browser-route');
  const current = entry.current.fingerprint;
  const earlier = entry.revisions.find(revision => revision.record.fingerprint !== current).record.fingerprint;
  const ask = memories => jsonRequest(view, '/api/memory/offered', launch.token, { memories });

  const first = await ask([
    { id: 'observation:browser-route', fingerprint: current },
    { id: 'observation:browser-route', fingerprint: earlier },
    { id: 'observation:browser-route', fingerprint: 'a'.repeat(64) },
    { id: 'observation:missing-route', fingerprint: current },
  ]);
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.value.memories.map(row => [row.state, row.text]), [
    ['unchanged', 'The browser route uses the cobalt gate.'],
    ['revised', 'The browser route uses the amber gate.'],
    ['version-not-retained', null],
    ['missing', null],
  ]);

  await data.ledger.retract({
    id: 'observation:browser-route', expectedFingerprint: current, expectedSequence: entry.lastSequence,
    actor: { kind: 'operator', id: 'synthetic-test' }, reason: 'Withdraw the synthetic route.',
  });
  const later = await ask([{ id: 'observation:browser-route', fingerprint: current }]);
  assert.deepEqual(later.value.memories.map(row => [row.state, row.text]), [['withdrawn', 'The browser route uses the cobalt gate.']]);

  const tooMany = await ask(Array.from({ length: BROWSER_VIEW_LIMITS.offeredMemories + 1 }, () => ({ id: 'observation:browser-route', fingerprint: current })));
  assert.equal(tooMany.response.status, 400);
  const malformed = await ask([{ id: 'observation:browser-route', fingerprint: 'not-a-hash' }]);
  assert.equal(malformed.response.status, 400);
});

test('the browser memory view separates due records from current influence and history', async t => {
  const data = await fixture(t);
  await data.ledger.record(createMemoryRecord({
    id: 'memory:browser-future', kind: 'authored-memory', text: 'Browser lifecycle future reminder.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'self-authored', confidence: 'asserted',
    lifecycle: { type: 'reminder', notBefore: '2030-02-01T00:00:00.000Z' },
  }));
  await data.ledger.record(createMemoryRecord({
    id: 'memory:browser-expired', kind: 'authored-memory', text: 'Browser lifecycle expired verdict.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'self-authored', confidence: 'supported',
    lifecycle: {
      type: 'verdict', expiresAt: at,
      evidence: 'The synthetic browser check failed.', changeCriteria: 'The check succeeds.',
    },
  }));
  const view = await startBrowserView({ profile: data.profile, ledger: data.ledger, clock });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  const current = await jsonRequest(view, '/api/memory/search', token, { query: 'browser lifecycle', mode: 'current' });
  assert.equal(current.response.status, 200);
  assert.deepEqual(current.value.results, []);

  const due = await jsonRequest(view, '/api/memory/search', token, { query: '', mode: 'due' });
  assert.equal(due.response.status, 200);
  assert.deepEqual(due.value.results.map(result => result.id), ['memory:browser-expired']);
  assert.equal(due.value.results[0].lifecycle.type, 'verdict');
  assert.equal(due.value.results[0].lifecycleStatus.phase, 'expired');
  assert.equal(due.value.results[0].lifecycleStatus.due, true);

  const history = await jsonRequest(view, '/api/memory/search', token, { query: 'browser lifecycle', mode: 'history' });
  assert.equal(history.response.status, 200);
  assert.deepEqual(history.value.results.map(result => result.id).sort(), ['memory:browser-expired', 'memory:browser-future']);
  assert.equal(history.value.results.find(result => result.id === 'memory:browser-future').lifecycleStatus.phase, 'scheduled');

  const html = await (await fetch(new URL('/', view.url))).text();
  assert.match(html, /name="mode" value="due"/);
});

test('each saved reply can show its durable input receipt without putting that receipt in conversation text', async t => {
  const data = await fixture(t);
  const contextFile = path.join(data.directory, 'reply-context.jsonl');
  const replyContexts = await createReplyContextStore(contextFile, { id: 'browser-reply-contexts', clock });
  let reopenedArchive = null;
  let reopenedContexts = null;
  const diagnostics = [];
  let providerRequest;
  let view = await startBrowserView({
    profile: data.profile,
    ledger: data.ledger,
    archive: data.archive,
    replyContexts,
    memoryForeground: true,
    clock,
    timeZone: 'UTC',
    onError(error, receipt) { diagnostics.push({ operation: receipt.operation, message: error.message }); },
    provider: {
      id: 'synthetic/input-receipt-provider',
      complete(input) {
        providerRequest = input;
        return { role: 'assistant', content: 'A synthetic answer with inspectable inputs.' };
      },
    },
  });
  t.after(async () => {
    try { await view?.close(); } catch { /* Assertion failures may leave it closed already. */ }
    try { await replyContexts.close(); } catch { /* Assertion failures may leave it closed already. */ }
    try { await reopenedContexts?.close(); } catch { /* Assertion failures may leave it closed already. */ }
    try { await reopenedArchive?.close(); } catch { /* Assertion failures may leave it closed already. */ }
  });
  let launch = launchAuthorization(view);
  const chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'Which memory mentions the cobalt gate?' });
  assert.equal(chat.response.status, 200);
  assert.equal(chat.value.inputReceiptSaved, true, JSON.stringify(diagnostics));
  const reply = chat.value.conversation.messages.at(-1);
  assert.equal(reply.inputs.format, 'fieldwork-reply-input-receipt/v1');
  assert.equal(reply.inputs.currentMessage.included, true);
  assert.deepEqual(reply.inputs.profile.roots.map(root => root.id), ['identity', 'voice']);
  assert.equal(reply.inputs.profile.roots.every(root => new Date(root.observedThrough).toISOString() === root.observedThrough), true);
  assert.equal(reply.inputs.profile.roots.some(root => Object.hasOwn(root, 'path') || Object.hasOwn(root, 'text')), false);
  assert.equal(reply.inputs.conversation.historyMessages, 0);
  assert.equal(reply.inputs.conversation.recentVerbatimMessages, 0);
  assert.equal(reply.inputs.memory.steps[0].selected[0].id, 'observation:browser-route');
  assert.deepEqual(reply.inputs.memory.steps[0].context.included.map(row => row.id), ['observation:browser-route']);
  assert.equal(reply.inputs.memory.steps[0].ledger.events, 3);
  assert.deepEqual(reply.inputs.memory.steps[0].index, {
    kind: 'memory-ledger', ledgerId: 'browser-memory', events: 3, head: reply.inputs.memory.steps[0].ledger.head,
  });
  assert.match(reply.inputs.note, /not a sentence-level citation/);
  assert.doesNotMatch(JSON.stringify(providerRequest.messages), /fieldwork-reply-input-receipt/);
  const archived = await data.archive.lookup(chat.value.conversationId, 'm000002');
  assert.deepEqual(archived.entry.message, { role: 'assistant', content: 'A synthetic answer with inspectable inputs.' });

  await view.close();
  await replyContexts.close();
  await data.archive.close();
  reopenedArchive = await openConversationArchive(path.join(data.directory, 'conversation.jsonl'), { clock });
  reopenedContexts = await openReplyContextStore(contextFile, { clock });
  view = await startBrowserView({
    profile: data.profile,
    archive: reopenedArchive,
    replyContexts: reopenedContexts,
    provider: { id: 'synthetic/restarted-provider', complete() { return { role: 'assistant', content: 'unused' }; } },
    clock,
  });
  launch = launchAuthorization(view);
  const boot = await bootstrapRequest(view, launch.token);
  assert.equal(boot.response.status, 200);
  assert.equal(boot.value.conversation.messages.at(-1).inputs.format, 'fieldwork-reply-input-receipt/v1');
  assert.equal(boot.value.health.replyContexts.status, 'ready');
  assert.equal(boot.value.capabilities.replyInputs, true);
  await view.close();
  await reopenedContexts.close();
  await reopenedArchive.close();
});

test('the loopback browser view serves a generic, hardened health surface without root text or paths', async t => {
  const data = await fixture(t);
  const tools = createToolRegistry([{
    name: 'synthetic_probe',
    description: 'Return one bounded synthetic probe result.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ ok: true }),
  }]);
  const packReceipt = {
    format: PACK_HOST_RECEIPT_FORMAT,
    configuration: hash('configuration'),
    packs: [{
      name: 'synthetic-pack', version: '1.0.0', config: hash('pack-config'),
      services: { required: [], optional: [] },
    }],
  };
  let providerCalls = 0;
  const provider = {
    id: 'synthetic/browser-provider',
    complete(request) {
      providerCalls++;
      assert.match(JSON.stringify(request.messages), /PRIVATE SYNTHETIC ROOT SENTINEL/);
      return { role: 'assistant', content: 'Literal reply: <img src=x onerror=alert(1)>' };
    },
  };
  const diagnostics = [];
  const view = await startBrowserView({
    profile: data.profile, provider, tools, packReceipt,
    ledger: data.ledger, archive: data.archive,
    bodyBytes: 1024, clock,
    onError: (error, receipt) => diagnostics.push({ error, receipt }),
  });
  t.after(() => view.close());

  assert.equal(view.format, BROWSER_VIEW_FORMAT);
  assert.equal(view.host, '127.0.0.1');
  assert.match(view.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/);
  const launch = launchAuthorization(view);

  const page = await fetch(view.url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy'), /worker-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /font-src 'self'/);
  assert.doesNotMatch(html, /PRIVATE SYNTHETIC ROOT SENTINEL|synthetic-pack|browser-provider/);
  assert.match(html, /A clean local room/);
  assert.match(html, /Room controls/);
  assert.match(html, /madoromi-haru-yoru/);
  assert.match(html, /madoromi\.moonwit\.ch/);
  assert.match(html, /the-moonwitch/);
  assert.match(html, /<meta name="description" content="A local Fieldwork room/);
  assert.match(html, /aria-label="Restart Fieldwork"/);
  assert.match(html, /class="skip-link" href="#conversation-title">Skip to conversation/);
  assert.match(html, /<h1 id="conversation-title" tabindex="-1">/);
  assert.match(html, /id="conversation-title-edit"[^>]+aria-label="Rename conversation"/);
  assert.match(html, /id="conversation-title-form" hidden/);
  assert.match(html, /id="conversation-title-input"[^>]+aria-describedby="conversation-title-status"/);
  assert.match(html, /id="conversation-title-cancel"/);
  assert.match(html, /id="conversation-title-status" role="status" hidden/);
  assert.match(html, /id="conversation-actions"/);
  assert.match(html, /<summary aria-label="Conversation actions" title="Conversation actions">⋯<\/summary>/);
  assert.match(html, /id="conversation-proactive-action"[^>]*>Stop automatic check-ins here<\/button>/);
  assert.match(html, /id="conversation-proactive-action"[^>]*aria-label="Stop automatic check-ins for this conversation"/);
  assert.match(html, /id="conversation-archive-action"[^>]*>Archive<\/button>/);
  assert.match(html, /id="conversation-notice" role="status" hidden/);
  assert.match(html, /id="conversation-announcement" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="archived-conversations" hidden/);
  assert.match(html, /id="archived-conversation-count">0<\/span>/);
  assert.match(html, /id="archived-conversation-list"/);
  assert.match(html, /class="brand-mark" aria-hidden="true">\s*<svg viewBox="0 0 32 36" focusable="false">/);
  assert.doesNotMatch(html, /class="brand-mark"[^>]*><i>/);
  assert.equal((html.match(/name="textSize"/g) || []).length, 1);
  assert.match(html, /<span>Display font<\/span><select name="typeface">/);
  assert.match(html, /<span>Interface font<\/span><select name="interfaceTypeface">/);
  assert.match(html, /<span>Technical font<\/span><select name="technicalTypeface">/);
  assert.match(html, /option value="extra-small">Extra small · 81\.25%/);
  assert.match(html, /option value="small">Small · 87\.5%/);
  assert.match(html, /option value="extra-large">Extra large/);
  assert.match(html, /option value="dither">Dither/);
  assert.match(html, /<optgroup label="Monospace &amp; pixel">/);
  assert.match(html, /option value="cozette">Cozette/);
  assert.match(html, /option value="comic-neue">Comic Neue/);
  assert.match(html, /option value="lexend">Lexend/);
  assert.match(html, /option value="shantell">Shantell Sans/);
  assert.match(html, /Atkinson Hyperlegible Mono/);
  assert.match(html, /id="typeface-preview" aria-hidden="true">Il1 O0/);
  assert.match(html, /id="interface-typeface-preview" aria-hidden="true">HEALTH · MEMORY · RECEIPTS/);
  assert.match(html, /id="technical-typeface-preview" aria-hidden="true">tool\.run\(\) · 01:23 · Il1\/O0/);
  assert.match(html, /data-settings-keywords="[^"]*interface tabs buttons labels technical code receipts metadata/);
  assert.match(html, /name="lineSpacing"/);
  assert.match(html, /name="readingWidth"/);
  assert.match(html, /name="messageLayout"/);
  assert.match(html, /name="avatars"/);
  assert.match(html, /name="panelOrder"/);
  assert.match(html, /name="sidebarVisibility"/);
  assert.match(html, /name="inspectorVisibility"/);
  assert.doesNotMatch(html, /name="side"/);
  assert.match(html, /class="settings-categories" aria-label="Settings categories" role="tablist"/);
  assert.match(html, /id="settings-search" type="search"/);
  assert.match(html, /id="connection-api-key" type="password"[^>]+autocomplete="new-password"/);
  assert.match(html, /id="telegram-bridge-token" type="password"[^>]+autocomplete="new-password"/);
  assert.match(html, /id="discord-bridge-token" type="password"[^>]+autocomplete="new-password"/);
  assert.match(html, /data-settings-keywords="telegram discord bridge bot token/);
  assert.match(html, /id="delivery-recovery" hidden/);
  assert.match(html, /Fieldwork never resends them automatically/);
  assert.match(html, /id="delivery-recovery-range" hidden/);
  assert.match(html, /id="delivery-recovery-status" role="status" aria-live="polite"/);
  assert.match(html, /id="guide-rewrite-form"/);
  assert.match(html, /Names, icons &amp; pronouns/);
  assert.match(html, /id="fieldwork-steps-copy"/);
  assert.match(html, /id="checkin-fieldwork-copy"/);
  assert.match(html, /id="checkin-destination"/);
  assert.match(html, /option value="room">This room/);
  assert.match(html, /option value="telegram">Telegram/);
  assert.match(html, /option value="discord">Discord/);
  assert.match(html, /id="checkin-destination-note" hidden/);
  assert.match(html, /id="checkin-conversation-policy" hidden/);
  assert.match(html, /id="heartbeat-form"/);
  assert.match(html, /<legend>Tools it may use<\/legend>/);
  assert.match(html, /id="heartbeat-binding-record"/);
  assert.match(html, /id="heartbeat-binding-measure"/);
  assert.match(html, /id="goal-form"/);
  assert.match(html, /Goals &amp; promises/);
  assert.match(html, /id="outside-reader-form"/);
  assert.match(html, /id="outside-reader-source-list"/);
  assert.match(html, /reads the goals and promises you pick/);
  assert.match(html, /<details class="outside-reader-boundaries"><summary>What it can and can't see<\/summary>/);
  assert.match(html, /<fieldset class="outside-reader-sources"><legend>Sources \(1–24\)<\/legend>/);
  assert.match(html, /id="outside-reader-status" role="status"/);
  assert.match(html, /leads to check, not proof\./);
  assert.match(html, /id="tool-permission-pending"[^>]+hidden/);
  assert.match(html, /A choice does not resume the call\. Ask your agent to retry afterward\./);
  assert.match(html, /id="tool-permission-history" hidden/);
  assert.match(html, /id="changes-status" role="status" tabindex="-1"/);
  assert.match(html, /id="changes-detail-open" type="button" hidden/);
  assert.match(html, /id="changes-detail-current" tabindex="0" role="region" aria-label="Current exact value"/);
  assert.match(html, /data-collection-mode="current" aria-pressed="true">Current/);
  assert.match(html, /data-collection-mode="removed" aria-pressed="false">Removed/);
  assert.match(html, /id="changes-open-collections" type="button" hidden>Open collection history/);
  assert.match(html, /data-settings-keywords="tools groups[^\"]+permission ask allow once always never approval recovery interrupted uncertain effect review"/);
  assert.match(html, /id="tool-effect-recovery" hidden/);
  assert.match(html, /Fieldwork won’t repeat these actions automatically\./);
  assert.match(html, /id="tool-effect-recovery-history" hidden/);
  assert.doesNotMatch(html, /A scheduled reviewer receives|The corpus is bounded and never silently truncated/);
  assert.match(html, /nothing here becomes an obligation unless someone writes it down here/);
  assert.match(html, /Name where each number comes from before collecting it/);
  assert.doesNotMatch(html, /Your agent can write to you on its own|Steps it may take|It works without waiting|How it got there/);
  assert.equal((html.match(/data-settings-page="[^"]+"/g) || []).length, 15);
  assert.equal((html.match(/role="tabpanel" aria-labelledby="settings-tab-/g) || []).length, 15);
  assert.doesNotMatch(html, /class="brand"[^>]+aria-label=/);

  const script = await (await fetch(new URL('/assets/app.js', view.url))).text();
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(script, /cssText|style\.setProperty/);
  assert.match(script, /textContent/);
  assert.match(script, /remove\.className = 'attachment-remove'/);
  assert.match(script, /function renderPanelOrder\(value\)/);
  assert.match(script, /elements\.workspace\.append\(\.\.\.panels\[slot\]\)/);
  assert.match(script, /function clearSettingsSearch\(\)[\s\S]*?elements\.settingsSearch\.value = '';[\s\S]*?applySettingsSearch\(\)/);
  assert.match(script, /const selected = settingsCategoryButtons\.find\(button => button\.getAttribute\('aria-selected'\) === 'true' && !button\.hidden\)/);
  assert.match(script, /elements\.settingsDialog\.addEventListener\('close', \(\) => \{\s*clearSettingsSearch\(\)/);
  assert.match(script, /document\.body\.append\(elements\.settingsDialog\)/);
  assert.match(script, /function renderTypefacePreview\(key, value\)/);
  assert.match(script, /elements\[`\$\{key\}Preview`\]/);
  assert.match(script, /\['typeface', 'interfaceTypeface', 'technicalTypeface'\]/);
  assert.match(script, /renderTypefacePreview\(key, event\.currentTarget\.value\)/);
  assert.match(script, /request\('\/api\/conversations\/rename'/);
  assert.match(script, /request\('\/api\/conversations\/archive'/);
  assert.match(script, /request\('\/api\/conversations\/proactive'/);
  assert.match(script, /body: \{ id, archived, expectedRevision: row\.lifecycleRevision \?\? 0 \}/);
  assert.match(script, /const activeRows = rows\.filter\(row => !row\.archived\)/);
  assert.match(script, /const archivedRows = rows\.filter\(row => row\.archived\)/);
  assert.match(script, /function mergeConversationRows\(incoming\)/);
  assert.match(script, /incomingLifecycleRevision < currentLifecycleRevision/);
  assert.match(script, /incomingProactiveRevision < currentProactiveRevision/);
  assert.match(script, /state\.conversations = merged;\s+renderConversationPolicyNotice\(\)/);
  assert.match(script, /function renderConversationPolicyNotice\(\)/);
  assert.match(script, /byId\('checkin-destination'\)\.value = settings\.destination \|\| 'room'/);
  assert.match(script, /destination: byId\('checkin-destination'\)\.value/);
  assert.match(script, /renderRest\(\);\s+renderConversationPolicyNotice\(\);\s+if \(!view\) return/);
  assert.match(script, /checkIns\.view = response\.checkIns;\s+renderConversationPolicyNotice\(\);\s+renderRest\(\)/);
  assert.match(script, /setAttribute\('aria-label', proactiveActionLabel\)/);
  assert.match(script, /automatic check-ins for “\$\{conversationLabel\(active\)\}”/);
  assert.match(script, /const summary = elements\.conversationActions\.querySelector\('summary'\);\s+elements\.conversationActions\.open = false;\s+summary\?\.focus\(\)/);
  assert.match(script, /const announcement = mode === 'suppress'/);
  assert.match(script, /elements\.conversationAnnouncement\.textContent = announcement/);
  assert.match(script, /elements\.conversationAnnouncement\.textContent = message/);
  assert.match(script, /if \(response\.conversationStatus\)/);
  assert.match(script, /state\.busy \|\| state\.conversationLifecycleBusy \|\| chatUnavailable/);
  assert.match(script, /focusAfter = archived \? elements\.conversationTitle : elements\.input/);
  assert.match(script, /if \(focusAfter\) setTimeout\(\(\) => focusAfter\.focus\(\), 0\)/);
  assert.doesNotMatch(script, /state\.conversations = response\.conversations/);
  assert.match(script, /event\.key !== 'Escape'/);
  assert.match(script, /elements\.conversationTitleInput\.select\(\)/);
  assert.match(script, /state\.conversationTitleEditorGeneration \+= 1/);
  assert.match(script, /state\.conversationTitleEditorGeneration !== editorGeneration/);
  assert.match(script, /body: \{ id, title, expectedRevision: active\.titleRevision \?\? 0 \}/);
  assert.match(script, /function mergeConversationTitle\(response, id\)/);
  assert.match(script, /incoming\.titleRevision <= currentRevision/);
  assert.match(script, /mergeConversationTitle\(response, id\)/);
  assert.match(script, /mergeConversationTitle\(\{ conversations: \[response\.conversationTitle\] \}, response\.conversationTitle\.id\)/);
  assert.match(script, /shelfState\.items = response\.shelf; renderShelf\(\)/);
  assert.match(script, /if \(state\.conversationTitleEditingId !== id \|\| state\.conversationTitleEditorGeneration !== editorGeneration\) \{\s*showError\(error\);/);
  assert.match(script, /\.filter\(key => data\.has\(key\)\)/);
  assert.match(script, /ArrowRight/);
  assert.match(script, /event\.key === 'ArrowDown'/);
  assert.match(script, /settingsCategoryButtons\.filter\(candidate => !candidate\.hidden\)/);
  assert.match(script, /function applySettingsSearch\(\)/);
  assert.match(script, /const selectedPanel = selected \? byId\(selected\.getAttribute\('aria-controls'\)\) : null/);
  assert.match(script, /else if \(selectedPanel\?\.hidden\)/);
  assert.match(script, /function captureOutsideReaderRenderState\(\)/);
  assert.match(script, /preserved\.open\.has\(row\.id\)/);
  assert.match(script, /preserved\.disclosures\.get\(row\.id\)/);
  assert.match(script, /function applyOutsideReaderView\(view, inspection = null\)/);
  assert.match(script, /applyOutsideReaderView\(response\.outsideReaders, inspection\)/);
  assert.match(script, /if \(name === 'outside-reader'\)[\s\S]+refreshOutsideReaderView\(\)/);
  assert.match(script, /card\.setAttribute\('aria-labelledby', title\.id\)/);
  assert.match(script, /accessibleLabel: `Run \$\{row\.name\} now`/);
  assert.match(script, /loaded = await loadOutsideReaderInspection\(row, body, load, openDisclosures\)/);
  assert.match(script, /Retry inspection/);
  assert.match(script, /summary\.textContent = 'Inspect'/);
  assert.match(script, /outsideReaderDisclosure\('Definition & sources', 'definition'/);
  assert.match(script, /outsideReaderDisclosure\(`History \(\$\{versions\.length\}\)`, 'history'/);
  assert.match(script, /outsideReaderDisclosure\(`Review leads \(\$\{retainedFindings\.length\}\)`, 'leads'/);
  assert.match(script, /outsideReaderDisclosure\(`Run receipts \(\$\{receipts\.length\}\)`, 'receipts'/);
  assert.match(script, /outsideReaderDisclosure\('Raw definition', 'definition-raw'/);
  assert.match(script, /outsideReaderDisclosure\('Raw receipt', `receipt-raw:/);
  assert.doesNotMatch(script, /Future goals and promises are not added automatically/);
  assert.match(script, /function agentGrammar\(\)/);
  assert.match(script, /How \$\{agentGrammar\(\)\.subject\} got there/);
  assert.match(script, /offeredMemoryBatches[\s\S]+replyContinuityModel[\s\S]+from '\.\/reply-continuity\.js'/);
  assert.match(script, /function replyContinuityDetails\(rawTrail, receipt\)/);
  assert.match(script, /const continuity = replyContinuityDetails\(message\.trail, message\.inputs\)/);
  assert.match(script, /if \(continuity\) item\.append\(continuity\)/);
  assert.match(script, /No automatic memory was offered\./);
  assert.match(script, /function rootVerificationDetails\(root\)[\s\S]+document\.createElement\('details'\)[\s\S]+summary\.textContent = 'Verify'/);
  assert.match(script, /edit\.type = 'button'[\s\S]+edit\.setAttribute\('aria-label', `Edit \$\{root\.id\}`\)/);
  assert.doesNotMatch(script, /elements\.roots\.lastElementChild\.title|item\.classList\.add\('editable'\)/);
  assert.match(script, /const rootEdgeLabel = root =>[\s\S]+loaded through[\s\S]+loaded edge not recorded/);
  assert.match(script, /const exactVersionLabel = value =>/);
  assert.match(script, /const memoryIndexLabel = \(receipt, \{ exact = false \} = \{\}\) =>[\s\S]+memory index edge not recorded[\s\S]+memory index ·/);
  assert.match(script, /const sourceEdgeLabel = \(source, \{ exact = false \} = \{\}\) =>[\s\S]+observed through[\s\S]+edge not recorded/);
  assert.match(script, /sourceEdgeDetails\(sources, `\$\{base\} · \$\{sourceEdgeSummary\(sources\)\}`, \{ exact: true \}\)/);
  assert.match(script, /memoryIndexLabel\(step, \{ exact: true \}\)/);
  assert.match(script, /Technical details: full versions, hashes and exact times/);
  assert.match(script, /for \(const batch of offeredMemoryBatches\(offered\)\)/);
  assert.match(script, /addMetaNode\(meta, 'Sources', sourceEdgeDetails\(sources\)\)/);
  assert.match(script, /No tool schemas were offered\./);
  assert.doesNotMatch(script, /trailDetails|inputReceiptDetails|reply-inputs/);
  assert.match(script, /function deliveryDetails\(receipt\)/);
  assert.match(script, /function renderDeliveryRecovery\(view\)/);
  assert.match(script, /Showing the latest \$\{shown\} of \$\{count\} unresolved replies\./);
  assert.match(script, /I understand this reply may already have been delivered\./);
  assert.match(script, /body: \{ id, expectedFingerprint, action \}/);
  assert.match(script, /'\/api\/deliveries\/recovery\/action'/);
  assert.match(script, /Not attempted/);
  assert.match(script, /May have been sent/);
  assert.match(script, /Send status unknown/);
  assert.match(script, /Delivery receipts unavailable/);
  assert.match(script, /Accepted parts/);
  assert.match(script, /Destination-bound messages/);
  assert.match(script, /summary\.textContent = failed/);
  assert.match(script, /item\.append\(delivery\)/);
  assert.match(script, /\['resident', 'Resident'\], \['on-demand', 'On demand'\], \['off', 'Off'\]/);
  assert.match(script, /select\.setAttribute\('aria-labelledby'/);
  assert.match(script, /select\.setAttribute\('aria-describedby'/);
  assert.match(script, /select\.disabled = true/);
  assert.match(script, /function captureToolRenderState\(\)/);
  assert.match(script, /preserved\.groups\.has\(group\.id\)/);
  assert.match(script, /\['always', 'Always'\], \['ask', 'Ask'\], \['never', 'Never'\]/);
  assert.match(script, /permissionSelect\.setAttribute\('aria-labelledby'/);
  assert.match(script, /inspect\.setAttribute\('aria-label', `Inspect \$\{item\.label\}`\)/);
  assert.match(script, /action\.setAttribute\('aria-label', `Undo change to \$\{entry\.label\}`\)/);
  assert.match(script, /function openChangeTarget\(opens, key\)/);
  assert.match(script, /Object\.hasOwn\(changeAreaLabels, area\)/);
  assert.match(script, /open\.setAttribute\('aria-label', detail\.opens === 'roots'/);
  assert.match(script, /exact\.tabIndex = 0/);
  assert.match(script, /exact\.setAttribute\('role', 'region'\)/);
  assert.match(script, /exact\.setAttribute\('aria-label', `\$\{labelText\} exact value`\)/);
  assert.match(script, /request\('\/api\/collections\/restore'/);
  assert.match(script, /expectedCurrentFingerprint: version\.kind === 'history'/);
  assert.match(script, /const canRestore = version\.kind === 'history' \|\| \(version\.kind === 'removed' && !history\?\.current\)/);
  assert.match(script, /if \(!resolvedHistory && row\.kind === 'removed'\)[\s\S]+request\('\/api\/collections\/history'/);
  assert.match(script, /function beginCollectionViewerRequest\(\)[\s\S]+collectionState\.viewerGeneration \+= 1/);
  assert.match(script, /function selectTab\(tab, focus = false\) \{\s*beginCollectionViewerRequest\(\);/);
  assert.match(script, /button\.addEventListener\('click', \(\) => \{\s*beginCollectionViewerRequest\(\);\s*collectionState\.generation \+= 1;\s*memoryView/);
  assert.match(script, /button\.dataset\.collectionValue = value/);
  assert.match(script, /beginCollectionViewerRequest\(\);\s*collectionState\.generation \+= 1;\s*collectionState\.chosen = value;\s*clear\(byId\('collection-results'\)\)/);
  assert.match(script, /previouslyFocused\?\.classList\.contains\('collection-load-more'\)[\s\S]+querySelector\('\.collection-load-more'\) \|\| collectionFocusFallback\(\)/);
  assert.match(script, /if \(!collectionViewerRequestIsCurrent\(viewerGeneration\)\) return/);
  assert.match(script, /if \(!collectionViewerRequestIsCurrent\(restoreGeneration\) \|\| !viewer\.open\) return/);
  assert.match(script, /viewer\.addEventListener\('close', \(\) => \{ collectionState\.viewerGeneration \+= 1; \}\)/);
  assert.match(script, /actions\.replaceChildren\(reload\)/);
  assert.match(script, /reload\.focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /const target = returnFocus\?\.isConnected \? returnFocus : collectionFocusFallback\(\)/);
  assert.match(script, /requestAnimationFrame\(\(\) => \{\s*const active = document\.activeElement;\s*if \(active\?\.isConnected && active !== document\.body && !viewer\.contains\(active\)\) return;/);
  assert.match(script, /restoreCollectionListFocus\(previouslyFocused\)/);
  assert.match(script, /Inspect version \$\{versionIndex \+ 1\} from \$\{collectionTime\(row\.updated\)\} · \$\{row\.fingerprint\.slice\(0, 8\)\}/);
  assert.match(script, /raw\.setAttribute\('role', 'region'\)/);
  assert.match(script, /raw\.setAttribute\('aria-label', `Exact Markdown for/);
  assert.match(script, /card\.setAttribute\('aria-label', `Open \$\{row\.title \|\| row\.entry\} in \$\{row\.collection\}`\)/);
  assert.match(script, /byId\('changes-detail-close'\)\.focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /if \(trigger\?\.isConnected\) trigger\.focus\(\)/);
  assert.match(script, /status\.focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /Allow next exact retry once/);
  assert.match(script, /Nothing resumed automatically\./);
  assert.match(script, /'\/api\/tools\/permission'/);
  assert.match(script, /'\/api\/tools\/decision'/);
  assert.match(script, /body: \{ requestId: row\.id, expectedFingerprint: row\.fingerprint, decision \}/);
  assert.match(script, /function renderToolRecovery\(view\)/);
  assert.match(script, /'\/api\/tools\/recovery'/);
  assert.match(script, /'\/api\/tools\/recovery\/action'/);
  assert.match(script, /'abandon-not-attempted'/);
  assert.match(script, /'acknowledge-uncertain'/);
  assert.match(script, /'acknowledge-completed'/);
  assert.match(script, /I understand this action may already have happened\./);
  assert.match(script, /I confirm this completed even though its run was not saved\./);
  assert.match(script, /id: item\.id,[\s\S]+expectedRevision: item\.revision,[\s\S]+resolution: spec\.resolution,[\s\S]+confirmed,/);
  assert.match(script, /Boolean\(bootstrap\.capabilities\?\.toolGroups \|\| bootstrap\.capabilities\?\.toolPermissions \|\| bootstrap\.capabilities\?\.toolRecovery\)/);
  assert.doesNotMatch(script, /Retry tool effect|Retry action/);
  assert.match(script, /tool schema\$\{tools\.length === 1/);
  assert.doesNotMatch(script, /\$\{tools\.length\} available/);
  assert.match(script, /Steps \$\{grammar\.subject\} may take/);
  assert.match(script, /grammar\.possessiveDeterminer/);
  assert.match(script, /agentVerb\(grammar, 'leaves', 'leave'\)/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^\n]+connection-api-key/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^\n]+telegram-bridge-token/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^\n]+discord-bridge-token/);
  const continuityModule = await fetch(new URL('/assets/reply-continuity.js', view.url));
  assert.equal(continuityModule.status, 200);
  assert.match(continuityModule.headers.get('content-type'), /^text\/javascript/);
  assert.match(await continuityModule.text(), /export function replyContinuityModel/);
  const styles = await (await fetch(new URL('/assets/styles.css', view.url))).text();
  assert.match(styles, /\.reply-continuity > summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.source-edges > summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.root-verification > summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.root-edit-button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.continuity-technical li,[\s\S]+user-select:\s*text/s);
  assert.match(styles, /\.reply-continuity \.input-text pre:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--acid\)/s);
  assert.match(styles, /\.changes-detail-actions button\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.changes-detail-close\s*\{[^}]*min-inline-size:\s*44px/s);
  assert.match(styles, /\.collection-chips button\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.collection-mode button\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.collection-entry-actions button[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.attachment-viewer \.collection-exact pre:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--acid\)/s);
  assert.match(styles, /\.changes-detail-heading\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(styles, /\.changes-detail-heading h3\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(styles, /\.changes-exact:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--acid\)/s);
  assert.match(styles, /html\[data-density="relaxed"\] \.settings-page > \.section-heading\.compact,\s*html\[data-density="relaxed"\] \.settings-page > div > \.section-heading\.compact\s*\{[^}]*margin-inline:\s*-10px/s);
  assert.doesNotMatch(styles, /\.trail\s*\{|\.reply-inputs\s*\{/);
  assert.match(styles, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(108px,\s*1fr\)\)/);
  assert.match(styles, /\.settings-categories\s*\{[^}]*overflow-x:\s*visible/s);
  assert.match(styles, /\.outside-reader-button\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.outside-reader-boundaries summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.outside-reader-history summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.message-delivery > summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.delivery-recovery > summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.delivery-recovery-actions \.secondary-button\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.delivery-recovery-confirmation\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.tool-group-mode select\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.tool-group-mode select\s*\{[^}]*background:\s*var\(--void\)/s);
  assert.match(styles, /\.tool-group-tools summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.tool-permission-actions button\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.tool-permission-mode select\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.tool-permission-history > summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.tool-effect-recovery > summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.tool-effect-recovery-actions \.secondary-button\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.tool-effect-recovery-confirmation\s*\{[^}]*min-block-size:\s*44px/s);
  assert.doesNotMatch(styles, /\.tool-group-row\[data-mode="off"\]\s*\{[^}]*opacity:/s);
  assert.doesNotMatch(styles, /\.tool-list li\.switched-off\s*\{[^}]*opacity:/s);
  assert.match(styles, /font-family:\s*"Atkinson Hyperlegible Next"/);
  assert.match(styles, /font-family:\s*"Cozette Vector"/);
  assert.match(styles, /font-family:\s*"Comic Neue"/);
  assert.match(styles, /font-family:\s*"Lexend"/);
  assert.match(styles, /font-family:\s*"Shantell Sans"/);
  for (const value of ['serif', 'sans', 'mono', 'system-sans', 'system-mono', 'cozette', 'comic-neue', 'lexend', 'shantell']) {
    assert.match(styles, new RegExp(`html\\[data-interface-typeface="${value}"\\]\\s*\\{\\s*--ui:`));
    assert.match(styles, new RegExp(`html\\[data-technical-typeface="${value}"\\]\\s*\\{\\s*--mono:`));
  }
  assert.match(styles, /\.brand-mark svg\s*\{[^}]*stroke:\s*currentColor/s);
  assert.doesNotMatch(styles, /\.brand-mark(?:::before|::after)|\.brand-mark i/);
  assert.match(styles, /html\[data-text-size="extra-large"\]\s*\{\s*font-size:\s*125%/);
  assert.match(styles, /html\[data-text-size="extra-small"\]\s*\{\s*font-size:\s*81\.25%/);
  assert.match(styles, /html\[data-text-size="small"\]\s*\{\s*font-size:\s*87\.5%/);
  assert.match(styles, /html\[data-line-spacing="airy"\]\s*\{\s*--reading-leading:\s*1\.8/);
  assert.match(styles, /html\[data-reading-width="full"\]/);
  assert.match(styles, /html\[data-message-layout="stacked"\]/);
  assert.match(styles, /html\[data-avatars="hidden"\]/);
  assert.match(styles, /html\[data-sidebar-visibility="hidden"\] \.sidebar/);
  assert.match(styles, /html\[data-inspector-visibility="hidden"\] \.inspector\s*\{\s*display:\s*none/s);
  assert.match(styles, /\.workspace\s*\{[^}]*display:\s*flex;[^}]*gap:\s*1px;[^}]*background:\s*var\(--rule-hot\)/s);
  assert.doesNotMatch(styles, /\.sidebar\s*\{[^}]*border-right:/s);
  assert.doesNotMatch(styles, /\.inspector\s*\{[^}]*border-left:/s);
  assert.match(styles, /@media \(max-width: 1280px\)[\s\S]*?\.sidebar, \.inspector\s*\{\s*flex:\s*none;\s*width:\s*100%/);
  assert.match(styles, /@media \(min-width: 1281px\)[\s\S]*?html, body\s*\{\s*height:\s*100%;\s*overflow:\s*hidden/);
  assert.doesNotMatch(styles, /@media \(min-width: 901px\)/);
  assert.match(styles, /\.appearance-section > summary::before\s*\{\s*content:\s*"▸"/);
  assert.match(styles, /\.typeface-control\s*\{\s*grid-column:\s*1 \/ -1/);
  assert.match(styles, /\.memory-switch button\s*\{[^}]*font:\s*\.8125rem var\(--ui\)/s);
  assert.match(styles, /\.settings-categories button\s*\{[^}]*font:\s*\.8125rem var\(--ui\)/s);
  assert.match(styles, /\.conversation-title-edit\s*,\s*\.conversation-actions > summary\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.match(styles, /\.archived-conversations > summary\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.archived-conversation-item button\s*\{[^}]*min-block-size:\s*44px/s);
  assert.match(styles, /\.conversation-title-form\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(styles, /code, pre, kbd, samp\s*\{\s*font-family:\s*var\(--mono\)/);
  assert.match(styles, /\.delivery-recovery-exact code\s*\{[^}]*font-family:\s*var\(--mono\)/s);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.conversation-panel \.conversation-heading\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.doesNotMatch(styles, /html\[data-side=/);
  assert.match(styles, /html\[data-texture="dither"\]/);
  assert.match(styles, /@media \(forced-colors: active\), \(prefers-contrast: more\)/);
  assert.match(styles, /\.icon-button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.match(styles, /\.look-earlier button\.avatar\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.match(styles, /\.search-row button\s*\{[^}]*width:\s*44px/s);
  assert.match(styles, /\.attachment-chip \.attachment-remove\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.doesNotMatch(styles, /\.attachment-chip button\s*\{/);
  assert.match(styles, /outline:\s*2px solid var\(--acid\)/);
  assert.doesNotMatch(styles, /font(?:-size)?\s*:[^;{}\r\n]*\d+(?:\.\d+)?px/);
  const madoromi = await fetch(new URL('/assets/madoromi-palettes.css', view.url));
  const madoromiCss = await madoromi.text();
  assert.equal(madoromi.status, 200);
  assert.match(madoromi.headers.get('content-type'), /^text\/css/);
  assert.match(madoromiCss, /SPDX-License-Identifier: MPL-2\.0 OR GPL-3\.0-or-later/);
  assert.match(madoromiCss, /madoromi-fuyu-yoru/);
  for (const file of [
    'AtkinsonHyperlegibleNext-Variable.woff2',
    'AtkinsonHyperlegibleNext-Italic-Variable.woff2',
    'AtkinsonHyperlegibleMono-Variable.woff2',
    'AtkinsonHyperlegibleMono-Italic-Variable.woff2',
    'CozetteVector.woff2',
    'CozetteVectorBold.woff2',
    'ComicNeue-Regular.woff2',
    'ComicNeue-Bold.woff2',
    'ComicNeue-Italic.woff2',
    'ComicNeue-BoldItalic.woff2',
    'Lexend-Regular.woff2',
    'Lexend-Bold.woff2',
    'Shantell_Sans-Normal-Regular.woff2',
    'Shantell_Sans-Normal-Bold.woff2',
    'Shantell_Sans-Normal-Regular_Italic.woff2',
    'Shantell_Sans-Normal-Bold_Italic.woff2',
  ]) {
    const font = await fetch(new URL(`/assets/fonts/${file}`, view.url));
    const bytes = Buffer.from(await font.arrayBuffer());
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2');
  }

  const anonymousBootstrap = await bootstrapRequest(view);
  assert.equal(anonymousBootstrap.response.status, 403);
  assert.equal(anonymousBootstrap.value.error, 'request token is missing or invalid');
  const wrongBootstrap = await bootstrapRequest(view, 'x'.repeat(43));
  assert.equal(wrongBootstrap.response.status, 403);

  const bootstrapResponse = await fetch(new URL('/api/bootstrap', view.url), {
    headers: { 'x-fieldwork-token': launch.token },
  });
  const bootstrapText = await bootstrapResponse.text();
  const bootstrap = JSON.parse(bootstrapText);
  assert.equal(bootstrap.format, BROWSER_VIEW_FORMAT);
  assert.equal(bootstrap.health.status, 'ready');
  assert.equal(bootstrap.capabilities.chat, true);
  assert.equal(bootstrap.capabilities.memory, true);
  assert.equal(bootstrap.capabilities.appearance, true);
  assert.equal(bootstrap.health.provider.id, provider.id);
  assert.deepEqual(bootstrap.health.tools.map(tool => tool.name), ['synthetic_probe']);
  assert.equal(bootstrap.health.tools.some(tool => Object.hasOwn(tool, 'inputSchema')), false);
  assert.deepEqual(bootstrap.health.packs.map(pack => pack.name), ['synthetic-pack']);
  assert.deepEqual(bootstrap.health.ledger, { status: 'ready' });
  assert.deepEqual(bootstrap.health.archive, { status: 'ready' });
  assert.equal(bootstrap.health.profile.roots.length, 2);
  assert.equal(bootstrap.health.profile.roots.every(root => new Date(root.observedThrough).toISOString() === root.observedThrough), true);
  assert.equal(Object.hasOwn(bootstrap.health.profile, 'home'), false);
  assert.equal(bootstrap.health.profile.roots.some(root => Object.hasOwn(root, 'path') || Object.hasOwn(root, 'text')), false);
  assert.doesNotMatch(bootstrapText, /PRIVATE SYNTHETIC ROOT SENTINEL/);
  assert.doesNotMatch(bootstrapText, new RegExp(data.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(bootstrapResponse.headers.get('access-control-allow-origin'), null);
  assert.equal(Object.hasOwn(bootstrap, 'token'), false);

  const hostileHost = await rawRequest(view.url, { headers: { host: 'evil.example' } });
  assert.equal(hostileHost.status, 421);
  const hostileOrigin = await fetch(new URL('/api/bootstrap', view.url), { headers: { origin: 'https://evil.example' } });
  assert.equal(hostileOrigin.status, 403);
  const crossSite = await fetch(new URL('/api/bootstrap', view.url), {
    headers: { 'x-fieldwork-token': launch.token, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  const queryString = await fetch(new URL('/api/bootstrap?token=leak', view.url));
  assert.equal(queryString.status, 400);
  const traversal = await fetch(new URL('/package.json', view.url));
  assert.equal(traversal.status, 404);

  const noToken = await fetch(new URL('/api/chat', view.url), {
    method: 'POST',
    headers: { origin: new URL(view.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(noToken.status, 403);

  // An empty search lists the newest memories, newest first.
  const emptyQuery = await jsonRequest(view, '/api/memory/search', launch.token, { query: '', mode: 'current' });
  assert.equal(emptyQuery.response.status, 200);
  assert.equal(emptyQuery.value.recent, true);
  assert.ok(emptyQuery.value.results.length >= 1);
  assert.equal(emptyQuery.value.receipt.index.kind, 'memory-ledger');
  assert.equal(emptyQuery.value.receipt.index.ledgerId, 'browser-memory');
  assert.equal(emptyQuery.value.receipt.index.head, emptyQuery.value.receipt.ledger.head);
  const sequences = emptyQuery.value.results.map(result => result.lastSequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => b - a));
  assert.doesNotMatch(JSON.stringify(emptyQuery.value), /synthetic-private|synthetic-secret/);
  const recentHistory = await jsonRequest(view, '/api/memory/search', launch.token, { query: '   ', mode: 'history' });
  assert.equal(recentHistory.response.status, 200);
  assert.ok(recentHistory.value.results.length >= emptyQuery.value.results.length, 'history also lists corrected and forgotten ones');
  const punctuationQuery = await jsonRequest(view, '/api/memory/search', launch.token, { query: '...?!', mode: 'current' });
  assert.equal(punctuationQuery.response.status, 400);
  assert.match(punctuationQuery.value.error, /at least one letter or number/);

  const duplicate = await jsonRequest(view, '/api/chat', launch.token, '{"text":"first","text":"second"}');
  assert.equal(duplicate.response.status, 400);
  assert.match(duplicate.value.error, /repeats object key/);
  const unknown = await jsonRequest(view, '/api/chat', launch.token, { text: 'hello', role: 'system' });
  assert.equal(unknown.response.status, 400);
  assert.match(unknown.value.error, /unknown field/);
  const malformedUnicode = await jsonRequest(view, '/api/chat', launch.token, { text: '\ud800' });
  assert.equal(malformedUnicode.response.status, 400);
  assert.match(malformedUnicode.value.error, /well-formed Unicode/);
  const tooLarge = await jsonRequest(view, '/api/chat', launch.token, { text: 'x'.repeat(2000) });
  assert.equal(tooLarge.response.status, 413);

  const invalidUtf8 = await rawRequest(new URL('/api/chat', view.url), {
    method: 'POST',
    headers: {
      host: `${view.host}:${view.port}`,
      origin: new URL(view.url).origin,
      'content-type': 'application/json',
      'x-fieldwork-token': launch.token,
    },
    body: Buffer.from([0xff]),
  });
  assert.equal(invalidUtf8.status, 400);

  const chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'Hello from the browser.' });
  assert.equal(chat.response.status, 200);
  assert.equal(providerCalls, 1);
  assert.deepEqual(chat.value.conversation.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(chat.value.conversation.messages[1].display, 'Literal reply: <img src=x onerror=alert(1)>');
  assert.doesNotMatch(JSON.stringify(chat.value), /PRIVATE SYNTHETIC ROOT SENTINEL/);
  assert.ok(chat.value.receipt.events.some(event => event.type === 'provider_request'));
  assert.equal(chat.value.receipt.events.some(event => Object.hasOwn(event, 'data')), false);

  const refreshed = (await bootstrapRequest(view, launch.token)).value;
  assert.deepEqual(refreshed.conversation.messages, chat.value.conversation.messages);
  assert.equal(refreshed.receipts[0].label, 'Conversation run');
  assert.equal(diagnostics.length, 0);

  const current = await jsonRequest(view, '/api/memory/search', launch.token, { query: 'cobalt gate', mode: 'current' });
  assert.equal(current.response.status, 200);
  assert.equal(current.value.results.length, 1);
  assert.equal(current.value.results[0].state, 'current');
  assert.equal(current.value.results[0].kind, 'observation');
  assert.deepEqual(Object.keys(current.value.results[0].sources[0]).sort(), ['fingerprint', 'kind', 'observedThrough']);
  assert.equal(current.value.results[0].sources[0].observedThrough, at);
  assert.equal(current.value.receipt.search.index.kind, 'memory-ledger');
  assert.equal(current.value.receipt.search.index.ledgerId, 'browser-memory');
  assert.equal(current.value.receipt.search.index.head, current.value.receipt.search.ledger.head);
  assert.equal(Object.hasOwn(current.value.results[0].sources[0], 'id'), false);
  assert.equal(Object.hasOwn(current.value.results[0].sources[0], 'locator'), false);
  assert.equal(Object.hasOwn(current.value.results[0].sources[0], 'sha256'), false);
  assert.doesNotMatch(JSON.stringify(current.value), /synthetic-private|synthetic-secret/);
  assert.equal(current.value.receipt.context.context.skipped.length, 0);

  const history = await jsonRequest(view, '/api/memory/search', launch.token, { query: 'amber gate', mode: 'history' });
  assert.equal(history.response.status, 200);
  assert.equal(history.value.results.length, 1);
  assert.equal(history.value.results[0].state, 'superseded');
  assert.equal(Object.hasOwn(history.value.receipt, 'context'), false);

  await view.close();
  assert.equal((await data.ledger.receipt()).ledgerId, 'browser-memory');
  assert.equal((await data.archive.receipt()).archiveId, 'browser-archive');
});

test('failed and over-limit runs never commit their candidate user turn', async t => {
  const data = await fixture(t);
  let fail = true;
  const requests = [];
  const provider = {
    id: 'synthetic/rollback-provider',
    complete(request) {
      requests.push(JSON.stringify(request.messages));
      if (fail) throw new Error('synthetic provider failure');
      return { role: 'assistant', content: 'accepted' };
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, clock });
  t.after(() => view.close());
  const launch = launchAuthorization(view);

  const failed = await jsonRequest(view, '/api/chat', launch.token, { text: 'FAILED ATTACKER TURN' });
  assert.equal(failed.response.status, 502);
  const afterFailure = (await bootstrapRequest(view, launch.token)).value;
  assert.deepEqual(afterFailure.conversation.messages, []);

  fail = false;
  const accepted = await jsonRequest(view, '/api/chat', launch.token, { text: 'accepted user turn' });
  assert.equal(accepted.response.status, 200);
  assert.equal(requests.length, 2);
  assert.match(requests[0], /FAILED ATTACKER TURN/);
  assert.doesNotMatch(requests[1], /FAILED ATTACKER TURN/);
  assert.match(requests[1], /accepted user turn/);

  const largeProvider = {
    id: 'synthetic/large-provider',
    complete() { return { role: 'assistant', content: 'r'.repeat(240_000) }; },
  };
  await view.close();
  const largeView = await startBrowserView({ profile: data.profile, provider: largeProvider, clock });
  t.after(() => largeView.close());
  const largeLaunch = launchAuthorization(largeView);
  const text = 'u'.repeat(BROWSER_VIEW_LIMITS.messageCharacters);
  for (let turn = 0; turn < 4; turn++) {
    const response = await jsonRequest(largeView, '/api/chat', largeLaunch.token, { text });
    assert.equal(response.response.status, 200, `large turn ${turn + 1} should fit`);
  }
  const beforeOverflow = (await bootstrapRequest(largeView, largeLaunch.token)).value.conversation;
  assert.equal(beforeOverflow.totalMessages, 8);
  assert.ok(beforeOverflow.omittedMessages > 0, 'the browser keeps a bounded recent display window');
  const overflow = await jsonRequest(largeView, '/api/chat', largeLaunch.token, { text });
  assert.equal(overflow.response.status, 502);
  const repeated = await jsonRequest(largeView, '/api/chat', largeLaunch.token, { text });
  assert.equal(repeated.response.status, 502);
  const afterOverflow = (await bootstrapRequest(largeView, largeLaunch.token)).value.conversation;
  assert.deepEqual(afterOverflow, beforeOverflow);
});

test('long browser conversations compact in the agent voice while exact raw turns survive restart', async t => {
  const data = await fixture(t);
  const compactionDir = path.join(data.directory, 'compactions');
  const ordinaryRequests = [];
  let compactionCalls = 0;
  const provider = {
    id: 'synthetic/first-person-context-provider',
    complete(request) {
      const serialized = JSON.stringify(request.messages);
      if (serialized.includes('Carry earlier conversation forward as the agent')) {
        compactionCalls++;
        assert.match(serialized, /<<<FIELDWORK_ROOTS>>>/);
        return {
          role: 'assistant',
          content: 'I remember the earlier exchange, including the cobalt latch and the later filler work. Details I left in the originals: exact wording and repeated filler.',
        };
      }
      ordinaryRequests.push(serialized);
      const newestUser = [...request.messages].reverse().find(message => message.role === 'user');
      const latest = typeof newestUser?.content === 'string' ? newestUser.content : '';
      if (latest.includes('Please recover the exact cobalt latch turn')) {
        return { role: 'assistant', content: 'I recovered the exact cobalt latch turn.' };
      }
      if (latest.includes('The cobalt latch opens the north cabinet')) {
        return { role: 'assistant', content: 'I recorded that small exact fact.' };
      }
      return { role: 'assistant', content: `I am carrying this filler forward. ${'fern '.repeat(36_000)}` };
    },
  };
  const view = await startBrowserView({
    profile: data.profile,
    provider,
    archive: data.archive,
    compactionDir,
    clock,
  });
  t.after(() => view.close());
  const launch = launchAuthorization(view);

  let response = await jsonRequest(view, '/api/chat', launch.token, { text: 'The cobalt latch opens the north cabinet.' });
  assert.equal(response.response.status, 200);
  for (let turn = 1; turn <= 6; turn++) {
    response = await jsonRequest(view, '/api/chat', launch.token, { text: `Filler turn ${turn}.` });
    assert.equal(response.response.status, 200, `filler turn ${turn} should continue beyond the old raw-transcript limit`);
  }
  response = await jsonRequest(view, '/api/chat', launch.token, { text: 'Please recover the exact cobalt latch turn.' });
  assert.equal(response.response.status, 200);
  assert.ok(compactionCalls >= 1);
  assert.equal(response.value.receipt.context.compaction.perspective, 'first-person');
  assert.ok(response.value.receipt.context.recovery.selected.length >= 1);
  const finalRequest = ordinaryRequests.at(-1);
  assert.match(finalRequest, /FIELDWORK_CARRIED_MEMORY/);
  assert.match(finalRequest, /FIELDWORK_EXACT_EARLIER_TURNS/);
  assert.match(finalRequest, /The cobalt latch opens the north cabinet/);

  const boot = (await bootstrapRequest(view, launch.token)).value;
  assert.equal(boot.conversation.totalMessages, 16);
  assert.ok(boot.conversation.omittedMessages > 0);
  const snapshot = await data.archive.snapshot();
  assert.equal(snapshot.messages.length, 16);
  const archived = await Promise.all(snapshot.messages.map(async row =>
    (await data.archive.lookup(row.conversationId, row.messageId)).entry.message));
  assert.deepEqual([...new Set(archived.map(message => message.role))].sort(), ['assistant', 'user']);
  assert.doesNotMatch(JSON.stringify(archived), /FIELDWORK_(?:CARRIED_MEMORY|EXACT_EARLIER_TURNS|CONTEXT)/);
  assert.ok((await fs.readdir(compactionDir)).length >= 1);

  await view.close();
  let restartedRequest = '';
  const restarted = await startBrowserView({
    profile: data.profile,
    archive: data.archive,
    compactionDir,
    clock,
    provider: {
      id: 'synthetic/restarted-backbone',
      complete(request) {
        if (JSON.stringify(request.messages).includes('Carry earlier conversation forward as the agent')) {
          throw new Error('the persisted first-person memory should be reusable');
        }
        restartedRequest = JSON.stringify(request.messages);
        return { role: 'assistant', content: 'I still have the exact archived turn after restart.' };
      },
    },
  });
  t.after(() => restarted.close());
  const restartedLaunch = launchAuthorization(restarted);
  const afterRestart = await jsonRequest(restarted, '/api/chat', restartedLaunch.token, { text: 'What was the cobalt latch fact?' });
  assert.equal(afterRestart.response.status, 200);
  assert.match(restartedRequest, /FIELDWORK_CARRIED_MEMORY/);
  assert.match(restartedRequest, /FIELDWORK_EXACT_EARLIER_TURNS/);
  assert.match(restartedRequest, /The cobalt latch opens the north cabinet/);
  assert.equal(afterRestart.value.receipt.context.state, 'disk');
});

test('chat concurrency, timeout and shutdown stay bounded when a yielding provider ignores abort', async t => {
  const data = await fixture(t);
  let entered;
  const called = new Promise(resolve => { entered = resolve; });
  const provider = {
    id: 'synthetic/stuck-provider',
    complete() {
      entered();
      return new Promise(() => {});
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, clock, runTimeoutMs: 1000 });
  const launch = launchAuthorization(view);

  const first = jsonRequest(view, '/api/chat', launch.token, { text: 'first' });
  await called;
  const second = await jsonRequest(view, '/api/chat', launch.token, { text: 'second' });
  assert.equal(second.response.status, 429);
  assert.match(second.value.error, /already active/);

  const timedOut = await first;
  assert.equal(timedOut.response.status, 504);
  const bootstrap = (await bootstrapRequest(view, launch.token)).value;
  assert.deepEqual(bootstrap.conversation.messages, []);
  assert.equal(bootstrap.receipts[0].label, 'Conversation interruption');

  const started = Date.now();
  await view.close();
  assert.ok(Date.now() - started < 2500, 'close should not await an abort-ignoring provider');
  await assert.rejects(fetch(view.url), /fetch failed|ECONNREFUSED/);
});

test('shared model-run reservation fences review and model switch while chat setup is paused', async t => {
  const data = await fixture(t);
  const outside = await exactOutsideReaderFixture(data, clock, 'paused-chat');
  let releaseAttachment;
  let enteredAttachment;
  const attachmentEntered = new Promise(resolve => { enteredAttachment = resolve; });
  const attachmentGate = new Promise(resolve => { releaseAttachment = resolve; });
  const attachments = {
    async accept() {
      enteredAttachment();
      await attachmentGate;
      return { parts: [] };
    },
    async expand(messages) { return messages; },
  };
  let providerCalls = 0;
  let modelChoices = 0;
  const makeProvider = model => ({
    id: `synthetic/reservation-${model}`,
    complete() {
      providerCalls += 1;
      return { role: 'assistant', content: `Reply from ${model}.` };
    },
  });
  const models = {
    current: 'alpha',
    async list() { return [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }]; },
    async choose(id) { modelChoices += 1; return makeProvider(id); },
  };
  const view = await startBrowserView({
    profile: data.profile,
    provider: makeProvider('alpha'),
    models,
    archive: data.archive,
    attachments,
    goals: outside.goals,
    outsideReaders: outside.outsideReaders,
    clock,
  });
  t.after(async () => {
    releaseAttachment();
    await view.close();
  });
  const { token } = launchAuthorization(view);

  const chat = jsonRequest(view, '/api/chat', token, {
    text: 'Pause before provider entry.',
    attachments: [{ id: 'synthetic-paused-attachment' }],
  });
  await attachmentEntered;
  assert.equal(providerCalls, 0, 'the chat has reserved the slot but has not entered the provider');

  const review = await jsonRequest(view, '/api/outside-readers/run', token, { id: outside.reader.id });
  assert.equal(review.response.status, 429);
  assert.match(review.value.error, /busy|model run/);
  const switched = await jsonRequest(view, '/api/model', token, { id: 'beta' });
  assert.equal(switched.response.status, 409);
  assert.match(switched.value.error, /current model run/);
  assert.equal(providerCalls, 0, 'neither rejected operation starts a second provider call');
  assert.equal(modelChoices, 0, 'the rejected switch never reaches the model host');
  assert.equal(outside.outsideReaders.inspect(outside.reader.id).reader.running, false, 'the rejected review never claims work');

  releaseAttachment();
  const completed = await chat;
  assert.equal(completed.response.status, 200);
  assert.equal(providerCalls, 1);
  assert.equal(completed.value.conversation.messages.at(-1).display, 'Reply from alpha.');
});

test('shared model-run reservation outlives a timed-out outside reader until its abort-ignoring provider settles', async t => {
  const data = await fixture(t);
  const outside = await exactOutsideReaderFixture(data, clock, 'late-review');
  let releaseProvider;
  let enteredProvider;
  const providerEntered = new Promise(resolve => { enteredProvider = resolve; });
  const lateProvider = new Promise(resolve => { releaseProvider = resolve; });
  let providerCalls = 0;
  let betaCalls = 0;
  const provider = {
    id: 'synthetic/abort-ignoring-outside-reader',
    complete() {
      providerCalls += 1;
      if (providerCalls === 1) {
        enteredProvider();
        return lateProvider;
      }
      return { role: 'assistant', content: 'A forbidden late second step.' };
    },
  };
  const beta = {
    id: 'synthetic/reservation-beta',
    complete() {
      betaCalls += 1;
      return { role: 'assistant', content: 'The released slot accepts a fresh chat.' };
    },
  };
  const models = {
    current: 'alpha',
    async list() { return [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }]; },
    async choose(id) { return id === 'beta' ? beta : provider; },
  };
  const view = await startBrowserView({
    profile: data.profile,
    provider,
    models,
    archive: data.archive,
    goals: outside.goals,
    outsideReaders: outside.outsideReaders,
    clock,
    runTimeoutMs: 1000,
  });
  t.after(async () => {
    releaseProvider({ role: 'assistant', content: 'Late cleanup release.' });
    await view.close();
  });
  const { token } = launchAuthorization(view);

  const running = jsonRequest(view, '/api/outside-readers/run', token, { id: outside.reader.id });
  await providerEntered;
  const timedOut = await settleWithin(
    running,
    'the outside-reader API did not return while its abort-ignoring provider remained unsettled',
  );
  assert.equal(timedOut.response.status, 200);
  assert.equal(timedOut.value.result.receipt.outcome, 'failed');
  assert.match(timedOut.value.result.receipt.note, /interrupted/);
  assert.equal(providerCalls, 1);

  const fencedChat = await jsonRequest(view, '/api/chat', token, { text: 'Do not overlap the late outside review.' });
  assert.equal(fencedChat.response.status, 429);
  assert.match(fencedChat.value.error, /outside review|model run/);
  const fencedSwitch = await jsonRequest(view, '/api/model', token, { id: 'beta' });
  assert.equal(fencedSwitch.response.status, 409);
  assert.equal(providerCalls, 1, 'fenced work never enters the still-live provider');

  releaseProvider({
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'late-outside-report',
      type: 'function',
      function: { name: 'report_outside_review', arguments: '{"outcome":"no-findings"}' },
    }],
  });
  let switched = fencedSwitch;
  for (let attempt = 0; attempt < 50 && switched.response.status !== 200; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    switched = await jsonRequest(view, '/api/model', token, { id: 'beta' });
  }
  assert.equal(switched.response.status, 200, 'the slot releases after the late provider actually settles');
  assert.equal(providerCalls, 1, 'late structured output is discarded before any tool-loop continuation');
  const inspection = outside.outsideReaders.inspect(outside.reader.id);
  assert.equal(inspection.receipts.length, 1);
  assert.equal(inspection.receipts[0].outcome, 'failed');
  assert.equal(Object.hasOwn(inspection.receipts[0], 'findings'), false, 'late structured output cannot replace the failed receipt');

  const freshChat = await jsonRequest(view, '/api/chat', token, { text: 'The late provider has settled.' });
  assert.equal(freshChat.response.status, 200);
  assert.equal(betaCalls, 1);
});

test('shared model-run reservation releases after an early chat setup failure', async t => {
  const data = await fixture(t);
  let alphaCalls = 0;
  let betaCalls = 0;
  const alpha = {
    id: 'synthetic/setup-alpha',
    complete() { alphaCalls += 1; return { role: 'assistant', content: 'Unexpected alpha call.' }; },
  };
  const beta = {
    id: 'synthetic/setup-beta',
    complete() { betaCalls += 1; return { role: 'assistant', content: 'Setup recovered on beta.' }; },
  };
  const attachments = {
    async accept() { throw new Error('Synthetic attachment setup failure.'); },
    async expand(messages) { return messages; },
  };
  const models = {
    current: 'alpha',
    async list() { return [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }]; },
    async choose(id) { return id === 'beta' ? beta : alpha; },
  };
  const view = await startBrowserView({
    profile: data.profile,
    provider: alpha,
    models,
    archive: data.archive,
    attachments,
    clock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  const failed = await jsonRequest(view, '/api/chat', token, {
    text: 'Fail before provider entry.',
    attachments: [{ id: 'synthetic-broken-attachment' }],
  });
  assert.equal(failed.response.status, 400);
  assert.match(failed.value.error, /Synthetic attachment setup failure/);
  assert.equal(alphaCalls, 0);

  const switched = await jsonRequest(view, '/api/model', token, { id: 'beta' });
  assert.equal(switched.response.status, 200, 'the failed setup released the shared slot');
  const chat = await jsonRequest(view, '/api/chat', token, { text: 'Use the released slot.' });
  assert.equal(chat.response.status, 200);
  assert.equal(betaCalls, 1);
});

test('a synchronous provider overrun is rejected instead of committing a late reply', async t => {
  const data = await fixture(t);
  const provider = {
    id: 'synthetic/blocking-provider',
    complete() {
      const until = performance.now() + 1050;
      while (performance.now() < until) { /* Deliberately block the event loop past the deadline. */ }
      return { role: 'assistant', content: 'too late' };
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, clock, runTimeoutMs: 1000 });
  t.after(() => view.close());
  const launch = launchAuthorization(view);

  const response = await jsonRequest(view, '/api/chat', launch.token, { text: 'block' });
  assert.equal(response.response.status, 504);
  const bootstrap = (await bootstrapRequest(view, launch.token)).value;
  assert.deepEqual(bootstrap.conversation.messages, []);
  assert.ok(bootstrap.receipts.some(receipt => receipt.label === 'Conversation interruption'));
  assert.equal(bootstrap.receipts.some(receipt => receipt.label === 'Conversation run'), false);
});

test('oversized declared and streaming bodies are rejected without being drained', async t => {
  const data = await fixture(t);
  const provider = { id: 'synthetic/body-provider', complete: () => ({ role: 'assistant', content: 'unused' }) };
  const view = await startBrowserView({ profile: data.profile, provider, bodyBytes: 1024, clock });
  t.after(() => view.close());
  const launch = launchAuthorization(view);
  const headers = {
    host: `${view.host}:${view.port}`,
    origin: launch.origin,
    'content-type': 'application/json',
    'x-fieldwork-token': launch.token,
  };

  const declared = await rawRequest(new URL('/api/chat', view.url), {
    method: 'POST',
    headers: { ...headers, 'content-length': '2048' },
  });
  assert.equal(declared.status, 413);
  assert.equal(declared.headers.connection, 'close');

  const expected = await rawRequest(new URL('/api/chat', view.url), {
    method: 'POST',
    headers: { ...headers, expect: '100-continue', 'content-length': '2048' },
  });
  assert.equal(expected.status, 413);
  assert.equal(expected.headers.connection, 'close');

  const streamed = await streamingRequest(new URL('/api/chat', view.url), {
    headers: { ...headers, 'transfer-encoding': 'chunked' },
    chunk: Buffer.alloc(2048, 0x78),
  });
  assert.equal(streamed.status, 413);
  assert.equal(streamed.headers.connection, 'close');
});

test('every rejection before body consumption closes the connection', async t => {
  const data = await fixture(t);
  const provider = { id: 'synthetic/rejection-provider', complete: () => ({ role: 'assistant', content: 'unused' }) };
  const view = await startBrowserView({ profile: data.profile, provider, bodyBytes: 1024, clock });
  t.after(() => view.close());
  const launch = launchAuthorization(view);
  const base = {
    origin: launch.origin,
    'content-type': 'application/json',
    'x-fieldwork-token': launch.token,
  };
  const cases = [
    {
      name: 'invalid token', route: '/api/chat', method: 'POST', status: 403,
      headers: { ...base, 'x-fieldwork-token': 'x'.repeat(43), 'content-length': '100000000' },
    },
    {
      name: 'hostile origin', route: '/api/chat', method: 'POST', status: 403,
      headers: { ...base, origin: 'https://evil.example', 'content-length': '100000000' },
    },
    {
      name: 'bad content type', route: '/api/chat', method: 'POST', status: 415,
      headers: { ...base, 'content-type': 'text/plain', 'content-length': '1' },
    },
    {
      name: 'wrong API method', route: '/api/chat', method: 'PUT', status: 405,
      headers: { ...base, 'content-length': '100000000' },
    },
    {
      name: 'wrong static method', route: '/assets/app.js', method: 'POST', status: 405,
      headers: { 'content-length': '100000000' },
    },
    {
      name: 'unknown route', route: '/missing', method: 'POST', status: 404,
      headers: { 'content-length': '100000000' },
    },
    {
      name: 'body on bootstrap', route: '/api/bootstrap', method: 'GET', status: 413,
      headers: { 'x-fieldwork-token': launch.token, 'content-length': '100000000' },
    },
    {
      name: 'unauthorized expectation', route: '/api/chat', method: 'POST', status: 403,
      headers: { ...base, 'x-fieldwork-token': 'x'.repeat(43), expect: '100-continue', 'content-length': '100000000' },
    },
  ];

  for (const specimen of cases) {
    const response = await rawRequest(new URL(specimen.route, view.url), specimen);
    assert.equal(response.status, specimen.status, specimen.name);
    assert.equal(response.headers.connection, 'close', specimen.name);
  }
});

test('a failed run names completed tools without exposing arguments or result bodies', async t => {
  const data = await fixture(t);
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'failed-run-effects.jsonl'), {
    id: 'failed-run-effects', clock,
  });
  t.after(async () => { try { await toolEffects.close(); } catch { /* Cleanup only. */ } });
  let step = 0;
  let effects = 0;
  const tools = createToolRegistry([{
    name: 'synthetic_effect',
    description: 'Increment one synthetic counter.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute() { effects++; return { privateResult: 'must stay out of the browser receipt' }; },
  }]);
  const provider = {
    id: 'synthetic/effect-provider',
    complete() {
      step++;
      if (step === 1) return {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'effect-1', type: 'function', function: { name: 'synthetic_effect', arguments: '{}' } }],
      };
      throw new Error('synthetic failure after effect');
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, tools, toolEffects, clock });
  t.after(() => view.close());
  const launch = launchAuthorization(view);

  const failed = await jsonRequest(view, '/api/chat', launch.token, { text: 'perform once' });
  assert.equal(failed.response.status, 502);
  assert.equal(effects, 1);
  const bootstrap = (await bootstrapRequest(view, launch.token)).value;
  assert.deepEqual(bootstrap.conversation.messages, []);
  const event = bootstrap.receipts[0].value.events.find(value => value.type === 'tool_finished');
  assert.equal(event.tool, 'synthetic_effect');
  assert.equal(event.outcome, 'ok');
  assert.equal(Object.hasOwn(event, 'data'), false);
  assert.doesNotMatch(JSON.stringify(bootstrap), /privateResult|must stay out/);
  const unresolved = await toolEffects.unresolved();
  assert.equal(unresolved.items.length, 1);
  assert.equal(unresolved.items[0].state, 'executor-returned-uncommitted');
  assert.equal(unresolved.items[0].runDisposition.status, 'run-failed');
});

test('repeated-effect budget receipts survive the browser projection without raw arguments or results', async t => {
  const data = await fixture(t);
  const privateArgument = 'PRIVATE REPEAT ARGUMENT MUST STAY OUT';
  const privateResult = 'PRIVATE REPEAT RESULT MUST STAY OUT';
  const argumentsText = JSON.stringify({ value: privateArgument });
  let step = 0;
  let executions = 0;
  const tools = createToolRegistry([{
    name: 'synthetic_repeat_effect',
    description: 'Exercise one synthetic repeated-effect budget.',
    inputSchema: {
      type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
    },
    execute() { executions += 1; return { privateResult }; },
  }]);
  const provider = {
    id: 'synthetic/repeat-budget-provider',
    complete() {
      step += 1;
      if (step <= 3) return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: `repeat-budget-${step}`, type: 'function',
          function: { name: 'synthetic_repeat_effect', arguments: argumentsText },
        }],
      };
      return { role: 'assistant', content: 'budget observed' };
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, tools, clock });
  t.after(() => view.close());
  const launch = launchAuthorization(view);

  const chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'repeat the exact effect' });
  assert.equal(chat.response.status, 200);
  assert.equal(executions, 2);
  const started = chat.value.receipt.events.find(event => event.type === 'run_started');
  assert.equal(started.trackedAttemptsPerInput, 2);
  const refused = chat.value.receipt.events.find(event => event.type === 'tool_refused');
  assert.equal(refused.tool, 'synthetic_repeat_effect');
  assert.equal(refused.outcome, 'error');
  assert.deepEqual(refused.budget, {
    kind: 'tracked-attempts-per-input',
    limit: 2,
    attempted: 2,
    argumentsSha256: hash(argumentsText),
  });
  assert.equal(Object.hasOwn(refused, 'data'), false);
  assert.doesNotMatch(JSON.stringify(chat.value.receipt), /PRIVATE REPEAT|privateResult/);

  const bootstrap = (await bootstrapRequest(view, launch.token)).value;
  const persisted = bootstrap.receipts[0].value.events;
  assert.equal(persisted.find(event => event.type === 'run_started').trackedAttemptsPerInput, 2);
  assert.deepEqual(persisted.find(event => event.type === 'tool_refused').budget, refused.budget);
  assert.doesNotMatch(JSON.stringify(bootstrap.receipts[0]), /PRIVATE REPEAT|privateResult/);
});

test('provider-supplied unregistered tool names never enter browser receipts', async t => {
  const data = await fixture(t);
  const hostileName = '<img src=x onerror=alert(1)> PRIVATE_RECEIPT_TEXT';
  let step = 0;
  const provider = {
    id: 'synthetic/unregistered-tool-provider',
    complete() {
      step++;
      if (step === 1) return {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'unknown-1', type: 'function', function: { name: hostileName, arguments: '{}' } }],
      };
      throw new Error('synthetic failure after unregistered tool call');
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, clock });
  t.after(() => view.close());
  const launch = launchAuthorization(view);

  const failed = await jsonRequest(view, '/api/chat', launch.token, { text: 'try an unknown tool' });
  assert.equal(failed.response.status, 502);
  const bootstrap = (await bootstrapRequest(view, launch.token)).value;
  const event = bootstrap.receipts[0].value.events.find(value => value.type === 'tool_refused');
  assert.equal(event.unregisteredTool, true);
  assert.equal(event.outcome, 'error');
  assert.equal(Object.hasOwn(event, 'tool'), false);
  assert.doesNotMatch(JSON.stringify(bootstrap), /PRIVATE_RECEIPT_TEXT|onerror/);
});

test('the browser captures one provider implementation and identity at startup', async t => {
  const data = await fixture(t);
  let originalCalls = 0;
  let replacementCalls = 0;
  const provider = {
    id: 'synthetic/original-provider',
    complete() {
      originalCalls++;
      return { role: 'assistant', content: 'original implementation' };
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, clock });
  t.after(() => view.close());
  provider.id = 'synthetic/replacement-provider';
  provider.complete = () => {
    replacementCalls++;
    return { role: 'assistant', content: 'replacement implementation' };
  };

  const launch = launchAuthorization(view);
  const bootstrap = (await bootstrapRequest(view, launch.token)).value;
  assert.equal(bootstrap.health.provider.id, 'synthetic/original-provider');
  const chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'which provider?' });
  assert.equal(chat.response.status, 200);
  assert.equal(chat.value.conversation.messages[1].display, 'original implementation');
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
});

test('appearance settings are closed, revision-checked and attributable to browser or agent hosts', async t => {
  const data = await fixture(t);
  const view = await startBrowserView({
    profile: data.profile,
    appearance: { palette: 'amber', inspector: 'wide' },
    clock,
  });
  t.after(() => view.close());
  const launch = launchAuthorization(view);
  const initial = (await bootstrapRequest(view, launch.token)).value;
  assert.equal(initial.capabilities.appearance, true);
  assert.equal(initial.appearance.format, BROWSER_APPEARANCE_FORMAT);
  assert.equal(initial.appearance.revision, 0);
  assert.deepEqual(initial.appearance.settings, {
    ...BROWSER_APPEARANCE_DEFAULTS,
    palette: 'amber',
    inspector: 'wide',
  });
  assert.deepEqual(initial.appearance.defaults, initial.appearance.settings);

  const browserUpdate = await jsonRequest(view, '/api/appearance', launch.token, {
    expectedRevision: 0,
    changes: {
      density: 'dense', textSize: 'extra-small', typeface: 'cozette',
      interfaceTypeface: 'shantell', technicalTypeface: 'comic-neue', lineSpacing: 'airy',
      readingWidth: 'full', messageLayout: 'stacked', avatars: 'hidden', sidebarWidth: 'wide',
      panelOrder: 'conversation-inspector-navigator', sidebarVisibility: 'hidden',
      inspectorVisibility: 'shown', texture: 'dither',
    },
  });
  assert.equal(browserUpdate.response.status, 200);
  assert.equal(browserUpdate.value.appearance.revision, 1);
  assert.equal(browserUpdate.value.appearance.settings.palette, 'amber');
  assert.equal(browserUpdate.value.appearance.settings.density, 'dense');
  assert.equal(browserUpdate.value.appearance.settings.textSize, 'extra-small');
  assert.equal(browserUpdate.value.appearance.settings.typeface, 'cozette');
  assert.equal(browserUpdate.value.appearance.settings.interfaceTypeface, 'shantell');
  assert.equal(browserUpdate.value.appearance.settings.technicalTypeface, 'comic-neue');
  assert.equal(browserUpdate.value.appearance.settings.lineSpacing, 'airy');
  assert.equal(browserUpdate.value.appearance.settings.readingWidth, 'full');
  assert.equal(browserUpdate.value.appearance.settings.messageLayout, 'stacked');
  assert.equal(browserUpdate.value.appearance.settings.avatars, 'hidden');
  assert.equal(browserUpdate.value.appearance.settings.sidebarWidth, 'wide');
  assert.equal(browserUpdate.value.appearance.settings.panelOrder, 'conversation-inspector-navigator');
  assert.equal(browserUpdate.value.appearance.settings.sidebarVisibility, 'hidden');
  assert.equal(browserUpdate.value.appearance.settings.inspectorVisibility, 'shown');
  assert.equal(browserUpdate.value.appearance.settings.texture, 'dither');
  assert.deepEqual(browserUpdate.value.receipt.actor, { kind: 'operator', id: 'browser-user' });

  const stale = await jsonRequest(view, '/api/appearance', launch.token, {
    expectedRevision: 0,
    changes: { texture: 'plain' },
  });
  assert.equal(stale.response.status, 409);
  assert.match(stale.value.error, /conflicts/);

  const arbitraryCss = await jsonRequest(view, '/api/appearance', launch.token, {
    expectedRevision: 1,
    changes: { customCss: 'body { display: none }' },
  });
  assert.equal(arbitraryCss.response.status, 400);
  assert.match(arbitraryCss.value.error, /unknown field/);

  const agentUpdate = await view.updateAppearance({
    expectedRevision: 1,
    changes: { palette: 'madoromi-fuyu-yoru', side: 'left', motion: 'reduced' },
    actor: { kind: 'agent', id: 'synthetic-agent' },
  });
  assert.equal(agentUpdate.appearance.revision, 2);
  assert.deepEqual(agentUpdate.receipt.actor, { kind: 'agent', id: 'synthetic-agent' });
  const refreshed = (await bootstrapRequest(view, launch.token)).value;
  assert.equal(refreshed.appearance.settings.palette, 'madoromi-fuyu-yoru');
  assert.equal(refreshed.appearance.settings.side, 'left');
  assert.equal(refreshed.appearance.settings.panelOrder, 'navigator-inspector-conversation', 'a legacy side-only change maps to the equivalent panel order');
  assert.equal(refreshed.receipts[0].label, 'Appearance update');

  await assert.rejects(view.updateAppearance({
    expectedRevision: 2,
    changes: { textSize: 'enormous' },
    actor: { kind: 'host', id: 'test-host' },
  }), /must be one of/);
  await assert.rejects(view.updateAppearance({
    expectedRevision: 2,
    changes: { typeface: 'remote-font-url' },
    actor: { kind: 'host', id: 'test-host' },
  }), /must be one of/);
  await assert.rejects(view.updateAppearance({
    expectedRevision: 2,
    changes: { interfaceTypeface: 'remote-font-url' },
    actor: { kind: 'host', id: 'test-host' },
  }), /must be one of/);
  await assert.rejects(view.updateAppearance({
    expectedRevision: 2,
    changes: { technicalTypeface: 'remote-font-url' },
    actor: { kind: 'host', id: 'test-host' },
  }), /must be one of/);
});

test('a host can restore appearance and durably accept each revision before publishing it', async t => {
  const data = await fixture(t);
  const saved = [];
  const view = await startBrowserView({
    profile: data.profile,
    appearanceState: {
      revision: 4,
      settings: {
        palette: 'amber', density: 'relaxed', textSize: 'small', typeface: 'comic-neue',
        interfaceTypeface: 'lexend', technicalTypeface: 'cozette',
        panelOrder: 'inspector-conversation-navigator', inspectorVisibility: 'hidden', texture: 'dither',
      },
    },
    onAppearanceChange: async receipt => { saved.push(receipt); },
    clock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const initial = (await bootstrapRequest(view, token)).value;
  assert.equal(initial.appearance.revision, 4);
  assert.equal(initial.appearance.settings.palette, 'amber');
  assert.equal(initial.appearance.settings.density, 'relaxed');
  assert.equal(initial.appearance.settings.textSize, 'small');
  assert.equal(initial.appearance.settings.typeface, 'comic-neue');
  assert.equal(initial.appearance.settings.interfaceTypeface, 'lexend');
  assert.equal(initial.appearance.settings.technicalTypeface, 'cozette');
  assert.equal(initial.appearance.settings.panelOrder, 'inspector-conversation-navigator');
  assert.equal(initial.appearance.settings.inspectorVisibility, 'hidden');
  assert.equal(initial.appearance.settings.texture, 'dither');

  const changed = await jsonRequest(view, '/api/appearance', token, {
    expectedRevision: 4,
    changes: { texture: 'grid' },
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.value.appearance.revision, 5);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].revision, 5);
  assert.equal(saved[0].settings.texture, 'grid');
});

test('missing hosted-provider access is explicit and prevents network-bearing actions', async t => {
  const data = await fixture(t);
  let completions = 0;
  let listings = 0;
  const provider = Object.freeze({
    id: 'openai-chat/openrouter.invalid/maker/model',
    complete() { completions++; return { role: 'assistant', content: 'should not run' }; },
  });
  const models = {
    current: 'maker/model', persistent: true,
    async list() { listings++; return [{ id: 'maker/model', label: 'Model' }]; },
    async choose() { return provider; },
  };
  const help = 'This hosted model service needs FIELDWORK_API_KEY. Fully stop Fieldwork, set it, then start again.';
  const view = await startBrowserView({
    profile: data.profile, provider, models, archive: data.archive,
    providerAccess: { kind: 'api-key', status: 'missing', label: 'openrouter.invalid', help },
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.health.status, 'degraded');
  assert.deepEqual(boot.health.provider.access, { kind: 'api-key', status: 'missing', label: 'openrouter.invalid', help });
  assert.equal(boot.capabilities.chat, false);
  assert.deepEqual(boot.model, { current: 'maker/model', switchable: true, available: false, persistent: true });
  assert.equal(boot.notice, help);

  const chat = await jsonRequest(view, '/api/chat', token, { text: 'do not send' });
  assert.equal(chat.response.status, 409);
  assert.equal(chat.value.error, help);
  const list = await jsonRequest(view, '/api/models', token, {});
  assert.equal(list.response.status, 409);
  assert.equal(completions, 0);
  assert.equal(listings, 0);
});

test('supervised agent actions project discovered recovery copies and restart cleanly', async t => {
  const data = await fixture(t);
  const performed = [];
  let restarts = 0;
  const home = path.join(data.directory, 'managed-agent');
  const backupId = `state-${'a'.repeat(64)}`;
  const backupLocation = path.join(home, 'backups', 'state-2035-04-05T06-07-08-000Z-deadbeef');
  const agentManager = {
    async snapshot() {
      return {
        format: 'fieldwork-agent-registry/v1', activeAgentId: 'fern',
        agents: [{ id: 'fern', name: 'Fern', home, active: true }],
      };
    },
    async backups() {
      return {
        format: 'fieldwork-agent-backups/v1', activeAgentId: 'fern',
        backups: [{ id: backupId, kind: 'state', createdAt: '2035-04-05T06:07:08.000Z', location: backupLocation }],
      };
    },
    async perform(command) { performed.push(command); },
  };
  const view = await startBrowserView({ profile: data.profile, agentManager, onRestart: () => { restarts++; } });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.manageAgents, true);
  assert.deepEqual(boot.agents.agents[0], { id: 'fern', name: 'Fern', home, active: true });
  assert.deepEqual(boot.agentBackups.backups[0], {
    id: backupId, kind: 'state', createdAt: '2035-04-05T06:07:08.000Z', location: backupLocation,
  });

  const refused = await jsonRequest(view, '/api/agents/action', token, {
    action: 'reset-agent', id: 'fern', confirmation: 'almost',
  });
  assert.equal(refused.response.status, 400);
  assert.equal(performed.length, 0);

  const refusedRestore = await jsonRequest(view, '/api/agents/action', token, {
    action: 'restore-state', id: 'fern', backupId, confirmation: 'almost',
  });
  assert.equal(refusedRestore.response.status, 400);
  assert.equal(performed.length, 0);

  const accepted = await jsonRequest(view, '/api/agents/action', token, {
    action: 'restore-state', id: 'fern', backupId, confirmation: 'RESTORE STATE',
  });
  assert.deepEqual([accepted.response.status, accepted.value.restarting, accepted.value.action], [200, true, 'restore-state']);
  assert.deepEqual(performed, [{
    format: 'fieldwork-agent-command/v1', action: 'restore-state', id: 'fern', backupId, confirmation: 'RESTORE STATE',
  }]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(restarts, 1);
});

test('supervised preset and portable agent actions keep exact closed command shapes', async t => {
  const data = await fixture(t);
  const home = path.join(data.directory, 'managed-agent');
  const cases = [
    {
      body: { action: 'create-expert' },
      command: { format: 'fieldwork-agent-command/v1', action: 'create-expert' },
    },
    {
      body: { action: 'export-agent', id: 'fern', destination: path.join(data.directory, 'Fern portable') },
      command: { format: 'fieldwork-agent-command/v1', action: 'export-agent', id: 'fern', destination: path.join(data.directory, 'Fern portable') },
    },
    {
      body: { action: 'import-agent', source: path.join(data.directory, 'Imported portable') },
      command: { format: 'fieldwork-agent-command/v1', action: 'import-agent', source: path.join(data.directory, 'Imported portable') },
    },
  ];
  for (const example of cases) {
    const performed = [];
    let restarts = 0;
    const agentManager = {
      async snapshot() {
        return {
          format: 'fieldwork-agent-registry/v1', activeAgentId: 'fern',
          agents: [{ id: 'fern', name: 'Fern', home, active: true }],
        };
      },
      async perform(command) { performed.push(command); },
    };
    const view = await startBrowserView({ profile: data.profile, agentManager, onRestart: () => { restarts++; } });
    const { token } = launchAuthorization(view);
    const refused = await jsonRequest(view, '/api/agents/action', token, { ...example.body, name: 'not accepted here' });
    assert.equal(refused.response.status, 400);
    assert.equal(performed.length, 0);
    const accepted = await jsonRequest(view, '/api/agents/action', token, example.body);
    assert.deepEqual([accepted.response.status, accepted.value.restarting, accepted.value.action], [200, true, example.body.action]);
    assert.deepEqual(performed, [example.command]);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(restarts, 1);
    await view.close();
  }
});

test('supervised model connection changes accept a write-only key and restart cleanly', async t => {
  const data = await fixture(t);
  const performed = [];
  let restarts = 0;
  const connectionManager = {
    async snapshot() {
      return {
        format: MODEL_CONNECTION_FORMAT,
        service: 'openai-compatible',
        baseURL: 'https://models.example.invalid/v1',
        model: 'synthetic/alpha',
        access: { kind: 'api-key', status: 'missing', source: 'none', canSave: true, canForget: false },
      };
    },
    async perform(command) { performed.push(command); },
  };
  const view = await startBrowserView({
    profile: data.profile,
    connectionManager,
    onRestart: () => { restarts++; },
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.manageConnection, true);
  assert.equal(boot.connection.model, 'synthetic/alpha');
  assert.doesNotMatch(JSON.stringify(boot), /synthetic-secret/);

  const refused = await jsonRequest(view, '/api/connection', token, {
    action: 'configure',
    service: 'openai-compatible',
    baseURL: 'https://models.example.invalid/v1',
    model: 'synthetic/beta',
    apiKey: 'not allowed whitespace',
  });
  assert.equal(refused.response.status, 400);
  assert.equal(performed.length, 0);

  const accepted = await jsonRequest(view, '/api/connection', token, {
    action: 'configure',
    service: 'openai-compatible',
    baseURL: 'https://models.example.invalid/v1',
    model: 'synthetic/beta',
    apiKey: 'synthetic-secret',
  });
  assert.deepEqual([accepted.response.status, accepted.value.restarting, accepted.value.action], [200, true, 'configure']);
  assert.doesNotMatch(JSON.stringify(accepted.value), /synthetic-secret/);
  assert.deepEqual(performed, [{
    format: MODEL_CONNECTION_COMMAND_FORMAT,
    action: 'configure',
    service: 'openai-compatible',
    baseURL: 'https://models.example.invalid/v1',
    model: 'synthetic/beta',
    apiKey: 'synthetic-secret',
  }]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(restarts, 1);
});

test('a live-unsaved bridge binding remains explicit through the browser projection', async t => {
  const data = await fixture(t);
  const conversationId = 'conv-00000000-0000-4000-8000-000000000001';
  const bridgeManager = {
    async snapshot() {
      return {
        format: BRIDGE_PUBLIC_FORMAT,
        telegram: {
          configured: true,
          token: { source: 'saved', available: true, canSave: true, canForget: true },
          state: 'connected',
          binding: 'live-unsaved',
          route: {
            chatId: '123456789', allowedUserId: '987654321', scope: 'direct', respondTo: 'all', conversationId,
          },
        },
        discord: {
          configured: false,
          token: { source: 'none', available: false, canSave: true, canForget: false },
          state: 'not-configured',
          binding: 'unbound',
        },
      };
    },
  };
  const view = await startBrowserView({ profile: data.profile, bridgeManager });
  t.after(() => view.close());
  const boot = (await bootstrapRequest(view, launchAuthorization(view).token)).value;
  assert.equal(boot.bridges.telegram.binding, 'live-unsaved');
  assert.equal(boot.bridges.telegram.route.conversationId, conversationId);
  assert.equal(boot.bridges.discord.binding, 'unbound');
  const script = await fs.readFile(new URL('../browser/app.js', import.meta.url), 'utf8');
  assert.match(script, /binding === 'live-unsaved'[\s\S]*?Do not restart; Refresh status or another message will retry/);
});

test('external bridge turns resume their bound conversation without sending route provenance to the provider', async t => {
  const data = await fixture(t);
  const { createToolGroupSettings } = await import('../src/tool-groups.mjs');
  const toolGroups = await createToolGroupSettings({ file: path.join(data.directory, 'bridge-tool-groups.json') });
  await toolGroups.set('clock', 'on-demand');
  const tools = createToolRegistry([{
    name: 'what_time_is_it', description: 'Return one synthetic bridge time.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ iso: at }),
  }]);
  const externalDeliveries = await createExternalDeliveryStore(path.join(data.directory, 'external-delivery.jsonl'), {
    id: 'synthetic-browser-deliveries', clock,
  });
  t.after(async () => { try { await externalDeliveries.close(); } catch { /* The fixture may already be gone after a failed assertion. */ } });
  const providerRequests = [];
  const provider = Object.freeze({
    id: 'synthetic/bridge-provider',
    complete(request) {
      providerRequests.push(request);
      return { role: 'assistant', content: 'A synthetic bridged reply.' };
    },
  });
  const bridgeManager = {
    async snapshot() {
      return {
        format: BRIDGE_PUBLIC_FORMAT,
        telegram: {
          configured: true,
          token: { source: 'saved', available: true, canSave: true, canForget: true },
          state: 'connected',
          route: {
            chatId: '123456789', allowedUserId: '987654321', scope: 'direct', respondTo: 'all', conversationId: null,
          },
        },
        discord: {
          configured: false,
          token: { source: 'none', available: false, canSave: true, canForget: false },
          state: 'not-configured',
        },
      };
    },
  };
  const view = await startBrowserView({
    profile: data.profile,
    provider,
    tools,
    toolGroups,
    archive: data.archive,
    externalDeliveries,
    bridgeManager,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.manageBridges, false, 'read-only bridge inspection does not expose mutation controls');
  assert.equal(boot.bridges.telegram.state, 'connected');
  const boundConversation = boot.conversations.find(row => row.id === boot.conversationId);
  const stopped = await jsonRequest(view, '/api/conversations/proactive', token, {
    id: boot.conversationId, mode: 'suppress', expectedRevision: boundConversation.proactiveRevision,
  });
  assert.equal(stopped.response.status, 200);
  assert.equal(stopped.value.conversationProactive.proactiveMode, 'suppress');
  const status = await jsonRequest(view, '/api/bridges/view', token, {});
  assert.equal(status.response.status, 200);
  assert.equal(status.value.bridges.telegram.state, 'connected');

  const result = await view.receiveExternalMessage({
    platform: 'telegram',
    destinationId: '123456789',
    sourceUserId: '987654321',
    sourceMessageId: '42',
    at: '2030-01-02T03:04:05.000Z',
    text: 'Literal bridged question.',
    conversationId: boot.conversationId,
  });
  assert.equal(result.reply, 'A synthetic bridged reply.');
  assert.equal(result.saved, true);
  assert.equal(result.conversationId, boot.conversationId);
  assert.match(result.replyReference.messageId, /^m[0-9]{6}$/);
  assert.match(result.replyReference.messageSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.replyReference.contentSha256, hash(result.reply));
  const providerRequest = providerRequests.at(-1);
  assert.doesNotMatch(JSON.stringify(providerRequest.messages), /fieldworkOrigin|sourceMessageId|123456789|987654321/);
  assert.match(JSON.stringify(providerRequest.messages), /Literal bridged question/);
  assert.match(JSON.stringify(providerRequest.messages), /Clock \(clock\) — on-demand: what_time_is_it/);
  assert.ok(providerRequest.tools.some(tool => tool.function.name === 'load_tool_group'));
  assert.ok(!providerRequest.tools.some(tool => tool.function.name === 'what_time_is_it'));

  const delivery = createExternalDeliveryCoordinator(externalDeliveries, {
    platform: 'telegram', destinationId: '123456789', sourceUserId: '987654321',
  });
  const plan = await delivery.prepare({
    sourceMessageId: '42',
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: result.reply,
      source: { kind: 'conversation-reply', ...result.replyReference },
    }),
  });
  const preparedView = await jsonRequest(view, '/api/conversations/open', token, { id: result.conversationId });
  const preparedAssistant = preparedView.value.conversation.messages.find(message => message.role === 'assistant');
  assert.equal(preparedAssistant.delivery.outcome, 'not-attempted');
  assert.equal(Object.hasOwn(preparedAssistant.delivery, 'attemptedAt'), false);
  const attempted = await delivery.beginAttempt({ actionId: plan.actionId });
  const attemptedView = await jsonRequest(view, '/api/conversations/open', token, { id: result.conversationId });
  const attemptedAssistant = attemptedView.value.conversation.messages.find(message => message.role === 'assistant');
  assert.equal(attemptedAssistant.delivery.outcome, 'may-have-been-sent');
  assert.equal(attemptedAssistant.delivery.attemptedAt, at);
  assert.equal(attemptedAssistant.delivery.attemptFingerprint, attempted.attempt.fingerprint);
  const settled = await delivery.settle({
    actionId: plan.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: '123456789', platformMessageId: '43' }],
  });

  const opened = await jsonRequest(view, '/api/conversations/open', token, { id: result.conversationId });
  assert.equal(opened.response.status, 200);
  assert.equal(opened.value.conversations.find(row => row.id === result.conversationId).proactiveMode, 'suppress');
  assert.deepEqual(opened.value.conversation.messages, [
    {
      role: 'user',
      display: 'Literal bridged question.',
      kind: 'bridge',
      at: '2030-01-02T03:04:05.000Z',
      route: {
        platform: 'telegram', destinationId: '123456789', sourceUserId: '987654321', sourceMessageId: '42',
      },
    },
    {
      role: 'assistant',
      display: 'A synthetic bridged reply.',
      delivery: {
        format: 'fieldwork-external-delivery-action/v1',
        id: plan.actionId,
        at,
        actionFingerprint: plan.receipt.fingerprint,
        platform: 'telegram',
        destinationId: '123456789',
        sourceMessageId: '42',
        decision: 'allow',
        checks: [
          { id: 'route-bound', status: 'passed' },
          { id: 'content', status: 'passed' },
          { id: 'source-bound', status: 'passed' },
          { id: 'chunk-plan', status: 'passed' },
        ],
        failedChecks: 0,
        content: plan.receipt.envelope.content,
        outcome: 'platform-accepted',
        attemptedAt: at,
        attemptFingerprint: attempted.attempt.fingerprint,
        settledAt: at,
        settlementFingerprint: settled.settlement.fingerprint,
        failureKind: null,
        acceptedChunks: 1,
        totalChunks: 1,
        platformMessageIds: ['43'],
        acknowledgements: [{
          index: 0,
          chunkSha256: plan.receipt.envelope.content.chunks[0].sha256,
          destinationId: '123456789',
          platformMessageId: '43',
        }],
      },
    },
  ]);
  assert.equal(opened.value.conversations.find(row => row.id === result.conversationId).title, 'Literal bridged question.');
  const fallback = await delivery.prepare({
    sourceMessageId: '44',
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: 'Synthetic operational fallback.',
      source: { kind: 'fieldwork-fallback', diagnosticId: 'synthetic-diagnostic-44' },
    }),
  });
  await delivery.beginAttempt({ actionId: fallback.actionId });
  await delivery.settle({
    actionId: fallback.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: '123456789', platformMessageId: '45' }],
  });
  const refreshed = (await bootstrapRequest(view, token)).value;
  const fallbackReceipt = refreshed.receipts.find(receipt => receipt.label === 'Telegram fallback delivery');
  assert.equal(fallbackReceipt.value.diagnosticId, 'synthetic-diagnostic-44');
  assert.equal(fallbackReceipt.value.outcome, 'platform-accepted');

  const second = await view.receiveExternalMessage({
    platform: 'telegram',
    destinationId: '123456789',
    sourceUserId: '987654321',
    sourceMessageId: '46',
    at: '2030-01-02T03:04:05.000Z',
    text: 'A second literal question.',
    conversationId: result.conversationId,
  });
  assert.equal(providerRequests.length, 2);
  const resumedPrompt = JSON.stringify(providerRequests[1].messages);
  const carriedTurns = [
    'Literal bridged question.',
    'A synthetic bridged reply.',
    'A second literal question.',
  ];
  const carriedPositions = carriedTurns.map(turn => resumedPrompt.indexOf(turn));
  assert.ok(carriedPositions.every(position => position >= 0),
    'the next bridge reply receives every earlier turn in the bound conversation');
  assert.ok(carriedPositions[0] < carriedPositions[1] && carriedPositions[1] < carriedPositions[2],
    'bound conversation turns retain their original order');
  assert.doesNotMatch(resumedPrompt, /fieldworkOrigin|sourceMessageId|123456789|987654321/,
    'route provenance stays out of both current and historical provider messages');
  const differentText = 'Different outbound text.';
  const mismatched = await delivery.prepare({
    sourceMessageId: '46',
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: differentText,
      source: {
        kind: 'conversation-reply',
        conversationId: second.replyReference.conversationId,
        messageId: second.replyReference.messageId,
        messageSha256: second.replyReference.messageSha256,
        contentSha256: hash(differentText),
      },
    }),
  });
  await delivery.beginAttempt({ actionId: mismatched.actionId });
  await delivery.settle({
    actionId: mismatched.actionId,
    outcome: 'platform-accepted',
    failureKind: null,
    acknowledgements: [{ destinationId: '123456789', platformMessageId: '47' }],
  });
  const mismatchView = await jsonRequest(view, '/api/conversations/open', token, { id: result.conversationId });
  const latestAssistant = mismatchView.value.conversation.messages.filter(message => message.role === 'assistant').at(-1);
  assert.equal(latestAssistant.display, second.reply);
  assert.equal(Object.hasOwn(latestAssistant, 'delivery'), false);
  await externalDeliveries.close();
});

test('delivery recovery survives restart and resolves prepared and attempted sends without exposing text', async t => {
  const data = await fixture(t);
  const file = path.join(data.directory, 'delivery-recovery.jsonl');
  const rawPrepared = 'RAW PREPARED RECOVERY TEXT MUST STAY OUT OF THE BROWSER';
  const rawAttempted = 'RAW ATTEMPTED RECOVERY TEXT MUST STAY OUT OF THE BROWSER';
  let store = await createExternalDeliveryStore(file, {
    id: 'synthetic-browser-recovery', clock,
  });
  let view = null;
  t.after(async () => {
    try { await view?.close(); } catch { /* A failed assertion may already have closed it. */ }
    try { await store?.close(); } catch { /* A failed assertion may already have closed it. */ }
  });

  const delivery = createExternalDeliveryCoordinator(store, {
    platform: 'telegram', destinationId: '123456789', sourceUserId: '987654321',
  });
  const prepared = await delivery.prepare({
    sourceMessageId: '510',
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: rawPrepared,
      source: { kind: 'fieldwork-fallback', diagnosticId: 'synthetic-recovery-prepared' },
    }),
  });
  const attemptedPlan = await delivery.prepare({
    sourceMessageId: '511',
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: rawAttempted,
      source: { kind: 'fieldwork-fallback', diagnosticId: 'synthetic-recovery-attempted' },
    }),
  });
  const attempted = await delivery.beginAttempt({ actionId: attemptedPlan.actionId });

  view = await startBrowserView({
    profile: data.profile,
    archive: data.archive,
    externalDeliveries: store,
  });
  let token = launchAuthorization(view).token;
  let boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.deliveryRecovery, true);
  assert.equal(boot.deliveryRecovery.available, true);
  assert.equal(boot.deliveryRecovery.count, 2);
  assert.equal(boot.deliveryRecovery.shown, 2);
  assert.equal(boot.deliveryRecovery.hasMore, false);
  assert.doesNotMatch(JSON.stringify(boot.deliveryRecovery), new RegExp(`${rawPrepared}|${rawAttempted}`));
  const preparedReceipt = boot.receipts.find(receipt => receipt.value?.diagnosticId === 'synthetic-recovery-prepared');
  const attemptedReceipt = boot.receipts.find(receipt => receipt.value?.diagnosticId === 'synthetic-recovery-attempted');
  assert.equal(preparedReceipt.value.outcome, 'not-attempted');
  assert.equal(Object.hasOwn(preparedReceipt.value, 'attemptedAt'), false);
  assert.equal(attemptedReceipt.value.outcome, 'may-have-been-sent');
  assert.equal(attemptedReceipt.value.attemptFingerprint, attempted.attempt.fingerprint);
  const preparedItem = boot.deliveryRecovery.items.find(item => item.id === prepared.actionId);
  const attemptedItem = boot.deliveryRecovery.items.find(item => item.id === attemptedPlan.actionId);
  assert.deepEqual({
    state: preparedItem.state,
    tracking: preparedItem.tracking,
    platform: preparedItem.platform,
    sourceMessageId: preparedItem.sourceMessageId,
    contentHash: preparedItem.content.sha256,
    chunks: preparedItem.content.chunks.length,
  }, {
    state: 'prepared-not-attempted',
    tracking: 'tracked',
    platform: 'telegram',
    sourceMessageId: '510',
    contentHash: hash(rawPrepared),
    chunks: 1,
  });
  assert.equal(Object.hasOwn(preparedItem, 'attemptedAt'), false);
  assert.equal(attemptedItem.state, 'attempted-unsettled');
  assert.equal(attemptedItem.attemptFingerprint, attempted.attempt.fingerprint);
  assert.equal(attemptedItem.attemptedAt, at);

  const firstView = await jsonRequest(view, '/api/deliveries/recovery', token, {});
  assert.equal(firstView.response.status, 200);
  assert.equal(firstView.value.deliveryRecovery.count, 2);
  assert.doesNotMatch(JSON.stringify(firstView.value), new RegExp(`${rawPrepared}|${rawAttempted}`));

  await view.close();
  view = null;
  await store.close();
  store = await openExternalDeliveryStore(file, {
    expectedId: 'synthetic-browser-recovery', clock,
  });
  view = await startBrowserView({
    profile: data.profile,
    archive: data.archive,
    externalDeliveries: store,
  });
  token = launchAuthorization(view).token;
  boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.deliveryRecovery.count, 2);
  const reopenedPrepared = boot.deliveryRecovery.items.find(item => item.id === prepared.actionId);
  const reopenedAttempted = boot.deliveryRecovery.items.find(item => item.id === attemptedPlan.actionId);
  assert.equal(reopenedPrepared.fingerprint, preparedItem.fingerprint);
  assert.equal(reopenedAttempted.fingerprint, attemptedItem.fingerprint);

  const wrongPrepared = await jsonRequest(view, '/api/deliveries/recovery/action', token, {
    id: reopenedPrepared.id,
    expectedFingerprint: reopenedPrepared.fingerprint,
    action: 'acknowledge-uncertain',
  });
  assert.equal(wrongPrepared.response.status, 400);
  assert.match(wrongPrepared.value.error, /requires a durable attempt or a legacy untracked action/);
  const wrongAttempted = await jsonRequest(view, '/api/deliveries/recovery/action', token, {
    id: reopenedAttempted.id,
    expectedFingerprint: reopenedAttempted.fingerprint,
    action: 'abandon-unsent',
  });
  assert.equal(wrongAttempted.response.status, 400);
  assert.match(wrongAttempted.value.error, /valid only for a tracked action with no durable attempt/);
  const stale = await jsonRequest(view, '/api/deliveries/recovery/action', token, {
    id: reopenedPrepared.id,
    expectedFingerprint: '0'.repeat(64),
    action: 'abandon-unsent',
  });
  assert.equal(stale.response.status, 409);
  assert.match(stale.value.error, /changed after inspection/);

  const abandoned = await jsonRequest(view, '/api/deliveries/recovery/action', token, {
    id: reopenedPrepared.id,
    expectedFingerprint: reopenedPrepared.fingerprint,
    action: 'abandon-unsent',
  });
  assert.equal(abandoned.response.status, 200);
  assert.equal(abandoned.value.deliveryRecovery.count, 1);
  assert.equal(abandoned.value.deliveryRecovery.items[0].id, reopenedAttempted.id);
  const acknowledged = await jsonRequest(view, '/api/deliveries/recovery/action', token, {
    id: reopenedAttempted.id,
    expectedFingerprint: reopenedAttempted.fingerprint,
    action: 'acknowledge-uncertain',
  });
  assert.equal(acknowledged.response.status, 200);
  assert.deepEqual(acknowledged.value.deliveryRecovery, {
    available: true, count: 0, shown: 0, hasMore: false, items: [],
  });

  const preparedRecord = await store.lookup(prepared.actionId);
  assert.deepEqual({
    outcome: preparedRecord.settlement.outcome,
    failureKind: preparedRecord.settlement.failureKind,
    attempted: preparedRecord.attempt,
  }, {
    outcome: 'not-sent',
    failureKind: 'operator-abandoned',
    attempted: null,
  });
  const attemptedRecord = await store.lookup(attemptedPlan.actionId);
  assert.equal(attemptedRecord.settlement.outcome, 'uncertain');
  assert.equal(attemptedRecord.settlement.failureKind, 'transport-uncertain');
  assert.equal(attemptedRecord.attempt.fingerprint, attempted.attempt.fingerprint);

  await view.close();
  view = null;
  await store.close();
  store = await openExternalDeliveryStore(file, {
    expectedId: 'synthetic-browser-recovery', clock,
  });
  assert.deepEqual(await store.unresolved({ limit: 32 }), { total: 0, hasMore: false, items: [] });
  assert.equal((await store.lookup(prepared.actionId)).settlement.outcome, 'not-sent');
  assert.equal((await store.lookup(attemptedPlan.actionId)).settlement.outcome, 'uncertain');
});

test('legacy delivery recovery stays conservative through the browser endpoint', async t => {
  const data = await fixture(t);
  const templateFile = path.join(data.directory, 'delivery-recovery-template.jsonl');
  const legacyFile = path.join(data.directory, 'delivery-recovery-legacy.jsonl');
  const templateStore = await createExternalDeliveryStore(templateFile, {
    id: 'synthetic-browser-recovery-template', clock,
  });
  const templateDelivery = createExternalDeliveryCoordinator(templateStore, {
    platform: 'discord', destinationId: '123456789012345678', sourceUserId: '987654321098765432',
  });
  const plan = await templateDelivery.prepare({
    sourceMessageId: '555555555555555555',
    output: createBridgeOutput({
      format: BRIDGE_OUTPUT_FORMAT,
      text: 'LEGACY RAW RECOVERY TEXT MUST STAY OUT OF THE BROWSER',
      source: { kind: 'fieldwork-fallback', diagnosticId: 'synthetic-legacy-recovery' },
    }),
  });
  await templateStore.close();

  const rawLegacy = await openDurableLog(legacyFile, {
    create: true,
    format: EXTERNAL_DELIVERY_EVENT_FORMAT,
    idField: 'deliveryStoreId',
    id: 'synthetic-browser-recovery-legacy',
    initial: {
      type: 'external_delivery_created',
      data: { actionFormat: EXTERNAL_DELIVERY_ACTION_FORMAT, policy: EXTERNAL_DELIVERY_POLICY },
    },
    clock,
  });
  await rawLegacy.append('external_delivery_preflighted', { action: plan.receipt });
  await rawLegacy.close();

  const store = await openExternalDeliveryStore(legacyFile, {
    expectedId: 'synthetic-browser-recovery-legacy', clock,
  });
  const view = await startBrowserView({
    profile: data.profile,
    archive: data.archive,
    externalDeliveries: store,
  });
  t.after(async () => {
    try { await view.close(); } catch { /* A failed assertion may already have closed it. */ }
    try { await store.close(); } catch { /* A failed assertion may already have closed it. */ }
  });
  const token = launchAuthorization(view).token;
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.deliveryRecovery.count, 1);
  const [item] = boot.deliveryRecovery.items;
  assert.equal(item.state, 'legacy-attempted-unsettled');
  assert.equal(item.tracking, 'legacy-untracked');
  assert.equal(Object.hasOwn(item, 'attemptedAt'), false);
  assert.doesNotMatch(JSON.stringify(boot.deliveryRecovery), /LEGACY RAW RECOVERY TEXT/);

  const refused = await jsonRequest(view, '/api/deliveries/recovery/action', token, {
    id: item.id,
    expectedFingerprint: item.fingerprint,
    action: 'abandon-unsent',
  });
  assert.equal(refused.response.status, 400);
  assert.match(refused.value.error, /valid only for a tracked action with no durable attempt/);
  const acknowledged = await jsonRequest(view, '/api/deliveries/recovery/action', token, {
    id: item.id,
    expectedFingerprint: item.fingerprint,
    action: 'acknowledge-uncertain',
  });
  assert.equal(acknowledged.response.status, 200);
  assert.equal(acknowledged.value.deliveryRecovery.count, 0);
  assert.equal((await store.lookup(plan.actionId)).settlement.outcome, 'uncertain');
});

test('supervised bridge changes require explicit group consent and keep tokens write-only', async t => {
  const data = await fixture(t);
  const performed = [];
  let restarts = 0;
  const bridgeManager = {
    async snapshot() {
      return {
        format: BRIDGE_PUBLIC_FORMAT,
        telegram: {
          configured: false,
          token: { source: 'none', available: false, canSave: true, canForget: false },
          state: 'not-configured',
        },
        discord: {
          configured: false,
          token: { source: 'none', available: false, canSave: true, canForget: false },
          state: 'not-configured',
        },
      };
    },
    async perform(command) { performed.push(command); },
  };
  const view = await startBrowserView({
    profile: data.profile,
    bridgeManager,
    onRestart: () => { restarts++; },
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.capabilities.manageBridges, true);

  const base = {
    action: 'configure',
    platform: 'telegram',
    token: '123456:synthetic_write_only_token_value_123',
    destinationId: '-1001234567890',
    allowedUserId: '987654321',
    scope: 'group',
  };
  const refused = await jsonRequest(view, '/api/bridges/action', token, base);
  assert.equal(refused.response.status, 400);
  assert.match(refused.value.error, /ALLOW GROUP LISTENING/);
  assert.equal(performed.length, 0);

  const accepted = await jsonRequest(view, '/api/bridges/action', token, {
    ...base,
    groupConfirmation: 'ALLOW GROUP LISTENING',
  });
  assert.deepEqual(
    [accepted.response.status, accepted.value.restarting, accepted.value.action, accepted.value.platform],
    [200, true, 'configure', 'telegram'],
  );
  assert.doesNotMatch(JSON.stringify(accepted.value), /synthetic_write_only_token_value/);
  assert.deepEqual(performed, [{
    format: BRIDGE_COMMAND_FORMAT,
    ...base,
    groupConfirmation: 'ALLOW GROUP LISTENING',
  }]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(restarts, 1);
});

test('zero injected capabilities stay visibly disabled and no HTTP request can activate them', async t => {
  const data = await fixture(t);
  const view = await startBrowserView({ profile: data.profile, clock });
  t.after(() => view.close());
  const launch = launchAuthorization(view);
  const bootstrap = (await bootstrapRequest(view, launch.token)).value;
  assert.equal(bootstrap.capabilities.chat, false);
  assert.equal(bootstrap.capabilities.memory, false);
  assert.equal(bootstrap.capabilities.automaticMemory, false);
  assert.deepEqual(bootstrap.health.tools, []);
  assert.deepEqual(bootstrap.health.packs, []);

  const chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'activate something' });
  assert.equal(chat.response.status, 409);
  assert.match(chat.value.error, /no provider is connected/);
  const memory = await jsonRequest(view, '/api/memory/search', launch.token, { query: 'anything', mode: 'current' });
  assert.equal(memory.response.status, 409);
  assert.match(memory.value.error, /no memory ledger is connected/);
});

test('startup rejects accessors and every non-loopback binding before listening', async t => {
  const data = await fixture(t);
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'profile', {
    enumerable: true,
    get() { reads++; return data.profile; },
  });
  await assert.rejects(startBrowserView(options), /options\.profile must be an enumerable data property/);
  assert.equal(reads, 0);
  await assert.rejects(
    startBrowserView({ profile: data.profile, host: '0.0.0.0' }),
    /host must be 127\.0\.0\.1/,
  );
  await assert.rejects(
    startBrowserView({ profile: data.profile, appearance: { customCss: 'body{}' } }),
    /unknown field "customCss"/,
  );
  await assert.rejects(
    startBrowserView({ profile: data.profile, memoryForeground: true }),
    /memoryForeground needs a memory ledger/,
  );
  await assert.rejects(
    startBrowserView({ profile: data.profile, ledger: data.ledger, memoryForeground: 'yes' }),
    /memoryForeground must be true or false/,
  );
  await assert.rejects(
    startBrowserView({ profile: data.profile, timeZone: 'Not/AZone' }),
    /not a valid IANA time zone/,
  );
  await assert.rejects(
    startBrowserView({ profile: data.profile, goals: { view() {}, inspect() {}, create() {}, recordCheck() {} } }),
    /goals must be created by createGoalRegister/,
  );
  await assert.rejects(
    startBrowserView({ profile: data.profile, checkIns: { due() {}, update() {} } }),
    /checkIns must be created by createCheckInStore/,
  );
});

test('the sidebar routes keep separate conversations that survive a restart', async t => {
  const data = await fixture(t);
  const provider = Object.freeze({
    id: 'synthetic-echo',
    complete(request) {
      const last = request.messages.filter(message => message.role === 'user').at(-1);
      return { role: 'assistant', content: `echo ${String(last.content).split('\n')[0]}` };
    },
  });
  const secret = 'S'.repeat(43);
  let view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, secret });
  let launch = launchAuthorization(view);
  assert.equal(launch.token, secret, 'a host-supplied secret becomes the launch token');

  let boot = (await bootstrapRequest(view, launch.token)).value;
  assert.equal(boot.conversations.length, 1);
  assert.equal(boot.conversations[0].messageCount, 0);
  const firstId = boot.conversationId;

  let chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'alpha', conversationId: firstId });
  assert.equal(chat.response.status, 200);
  assert.equal(chat.value.saved, true);
  assert.deepEqual(chat.value.conversation.messages.map(message => message.display), ['alpha', 'echo alpha']);

  const fresh = await jsonRequest(view, '/api/conversations/new', launch.token, {});
  const secondId = fresh.value.conversationId;
  assert.notEqual(secondId, firstId);
  assert.deepEqual(fresh.value.conversation.messages, []);
  const again = await jsonRequest(view, '/api/conversations/new', launch.token, {});
  assert.equal(again.value.conversationId, secondId, 'an untouched empty conversation is reused');

  chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'beta', conversationId: secondId });
  assert.deepEqual(chat.value.conversations.map(row => row.title), ['beta', 'alpha']);

  const secondBeforeRename = chat.value.conversations.find(row => row.id === secondId);
  const renamed = await jsonRequest(view, '/api/conversations/rename', launch.token, {
    id: secondId, title: '  Beta   greenhouse  ', expectedRevision: secondBeforeRename.titleRevision,
  });
  assert.equal(renamed.response.status, 200);
  const secondRenamed = renamed.value.conversations.find(row => row.id === secondId);
  assert.equal(secondRenamed.title, 'Beta greenhouse');
  assert.equal(secondRenamed.titleBy, 'person');
  assert.ok(secondRenamed.titleRevision > secondBeforeRename.titleRevision);
  assert.equal((await jsonRequest(view, '/api/conversations/rename', launch.token, { id: secondId, title: '   ', expectedRevision: secondRenamed.titleRevision })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/conversations/rename', launch.token, { id: secondId, title: 'x'.repeat(81), expectedRevision: secondRenamed.titleRevision })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/conversations/rename', launch.token, { id: secondId, title: '\u200d', expectedRevision: secondRenamed.titleRevision })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/conversations/rename', launch.token, { id: 'conv-nope', title: 'Nope', expectedRevision: 0 })).response.status, 404);
  assert.equal((await jsonRequest(view, '/api/conversations/rename', launch.token, { id: secondId, title: 'Nope', expectedRevision: secondRenamed.titleRevision, extra: true })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/conversations/rename', launch.token, { id: secondId, title: 'Stale', expectedRevision: secondBeforeRename.titleRevision })).response.status, 409);

  const opened = await jsonRequest(view, '/api/conversations/open', launch.token, { id: firstId });
  assert.deepEqual(opened.value.conversation.messages.map(message => message.display), ['alpha', 'echo alpha']);
  const missing = await jsonRequest(view, '/api/conversations/open', launch.token, { id: 'conv-nope' });
  assert.equal(missing.response.status, 404);

  await view.close();
  await data.archive.close();
  const { openConversationArchive } = await import('../src/conversation-archive.mjs');
  const reopened = await openConversationArchive(path.join(data.directory, 'conversation.jsonl'));
  t.after(async () => { try { await reopened.close(); } catch { /* Already closed. */ } });
  view = await startBrowserView({ profile: data.profile, provider, archive: reopened, secret });
  t.after(() => view.close());
  launch = launchAuthorization(view);
  boot = (await bootstrapRequest(view, launch.token)).value;
  assert.deepEqual(boot.conversations.map(row => [row.title, row.messageCount]), [['Beta greenhouse', 2], ['alpha', 2]]);
  assert.equal(boot.conversationId, secondId, 'the newest conversation opens first');
  assert.match(boot.notice, /saved in the agent's folder/);
  chat = await jsonRequest(view, '/api/chat', launch.token, { text: 'gamma', conversationId: firstId });
  assert.deepEqual(chat.value.conversation.messages.map(message => message.display), ['alpha', 'echo alpha', 'gamma', 'echo gamma']);
});

test('conversation archiving is reversible, restart-safe, and refuses model work until restore', async t => {
  const data = await fixture(t);
  const secret = 'L'.repeat(43);
  let providerCalls = 0;
  const provider = {
    id: 'synthetic/lifecycle-provider',
    complete(request) {
      providerCalls += 1;
      const text = String(request.messages.findLast(message => message.role === 'user')?.content ?? '')
        .split('\n\n<<<FIELDWORK_ROOTS>>>', 1)[0];
      return { role: 'assistant', content: `echo ${text}` };
    },
  };
  let view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, secret, clock });
  t.after(async () => { try { await view?.close(); } catch { /* A failed assertion may already have closed it. */ } });
  let token = launchAuthorization(view).token;
  let boot = (await bootstrapRequest(view, token)).value;
  const firstId = boot.conversationId;
  await jsonRequest(view, '/api/chat', token, { text: 'first', conversationId: firstId });
  const fresh = await jsonRequest(view, '/api/conversations/new', token, {});
  const secondId = fresh.value.conversationId;
  const secondChat = await jsonRequest(view, '/api/chat', token, { text: 'second', conversationId: secondId });

  const secondBeforeArchive = secondChat.value.conversations.find(row => row.id === secondId);
  const archivedSecond = await jsonRequest(view, '/api/conversations/archive', token, {
    id: secondId, archived: true, expectedRevision: secondBeforeArchive.lifecycleRevision,
  });
  assert.equal(archivedSecond.response.status, 200);
  assert.equal(archivedSecond.value.conversationStatus.archived, true);
  assert.equal(archivedSecond.value.conversationStatus.lifecycleBy, 'person');
  assert.equal(archivedSecond.value.conversationId, firstId, 'archiving the current conversation selects the newest active fallback');
  const archivedRow = archivedSecond.value.conversations.find(row => row.id === secondId);
  assert.equal(archivedRow.archived, true);

  const openedArchived = await jsonRequest(view, '/api/conversations/open', token, { id: secondId });
  assert.deepEqual(openedArchived.value.conversation.messages.map(message => message.display), ['second', 'echo second']);
  const callsBeforeRefusal = providerCalls;
  const refused = await jsonRequest(view, '/api/chat', token, { text: 'must not run', conversationId: secondId });
  assert.equal(refused.response.status, 409);
  assert.match(refused.value.error, /archived.*restore/i);
  assert.equal(providerCalls, callsBeforeRefusal, 'archived chat is refused before the provider runs');

  const restoredSecond = await jsonRequest(view, '/api/conversations/archive', token, {
    id: secondId, archived: false, expectedRevision: archivedRow.lifecycleRevision,
  });
  assert.equal(restoredSecond.response.status, 200);
  assert.equal(restoredSecond.value.conversationId, secondId);
  assert.equal(restoredSecond.value.conversationStatus.archived, false);
  const stale = await jsonRequest(view, '/api/conversations/archive', token, {
    id: secondId, archived: true, expectedRevision: archivedRow.lifecycleRevision,
  });
  assert.equal(stale.response.status, 409);

  const firstRow = restoredSecond.value.conversations.find(row => row.id === firstId);
  const archivedFirst = await jsonRequest(view, '/api/conversations/archive', token, {
    id: firstId, archived: true, expectedRevision: firstRow.lifecycleRevision,
  });
  const secondRestoredRow = archivedFirst.value.conversations.find(row => row.id === secondId);
  const allArchived = await jsonRequest(view, '/api/conversations/archive', token, {
    id: secondId, archived: true, expectedRevision: secondRestoredRow.lifecycleRevision,
  });
  assert.equal(allArchived.response.status, 200);
  assert.equal(allArchived.value.conversations.filter(row => row.archived).length, 2);
  const cleanId = allArchived.value.conversationId;
  assert.equal(allArchived.value.conversations.find(row => row.id === cleanId).messageCount, 0);
  assert.equal(allArchived.value.conversations.find(row => row.id === cleanId).archived, false);

  await view.close();
  await data.archive.close();
  const reopened = await openConversationArchive(path.join(data.directory, 'conversation.jsonl'), { clock });
  t.after(async () => { try { await reopened.close(); } catch { /* Already closed. */ } });
  view = await startBrowserView({ profile: data.profile, provider, archive: reopened, secret, clock });
  token = launchAuthorization(view).token;
  boot = (await bootstrapRequest(view, token)).value;
  assert.notEqual(boot.conversationId, cleanId, 'an uncommitted clean room is recreated after restart');
  assert.equal(boot.conversations.filter(row => row.archived).length, 2);
  assert.equal(boot.conversations.find(row => row.id === boot.conversationId).archived, false);
  assert.equal(boot.conversations.find(row => row.id === boot.conversationId).messageCount, 0);
});

test('conversation automatic check-ins can be stopped without archiving or muting direct chat', async t => {
  const data = await fixture(t);
  let providerCalls = 0;
  const provider = Object.freeze({
    id: 'synthetic/proactive-policy',
    complete(request) {
      providerCalls += 1;
      const text = String(request.messages.findLast(message => message.role === 'user')?.content ?? '')
        .split('\n\n<<<FIELDWORK_ROOTS>>>', 1)[0];
      return { role: 'assistant', content: `echo ${text}` };
    },
  });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, clock });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  const id = boot.conversationId;
  const original = boot.conversations.find(row => row.id === id);
  assert.equal(original.proactiveMode, 'allow');
  assert.equal(original.proactiveRevision, 0);

  const stopped = await jsonRequest(view, '/api/conversations/proactive', token, {
    id, mode: 'suppress', expectedRevision: original.proactiveRevision,
  });
  assert.equal(stopped.response.status, 200);
  assert.equal(Object.hasOwn(stopped.value, 'conversationId'), false, 'policy response cannot replace the selected transcript');
  assert.equal(stopped.value.conversationProactive.proactiveMode, 'suppress');
  assert.equal(stopped.value.conversationProactive.proactiveBy, 'person');
  const stoppedRow = stopped.value.conversations.find(row => row.id === id);
  assert.equal(stoppedRow.archived, false);
  assert.equal(stoppedRow.proactiveMode, 'suppress');
  assert.equal(providerCalls, 0, 'changing policy does not call the model');

  const stale = await jsonRequest(view, '/api/conversations/proactive', token, {
    id, mode: 'allow', expectedRevision: 0,
  });
  assert.equal(stale.response.status, 409);
  assert.equal((await jsonRequest(view, '/api/conversations/proactive', token, {
    id, mode: 'mute', expectedRevision: stoppedRow.proactiveRevision,
  })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/conversations/proactive', token, {
    mode: 'allow', expectedRevision: stoppedRow.proactiveRevision,
  })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/conversations/proactive', token, {
    id: 42, mode: 'allow', expectedRevision: stoppedRow.proactiveRevision,
  })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/conversations/proactive', token, {
    id, mode: 'allow', expectedRevision: stoppedRow.proactiveRevision, extra: true,
  })).response.status, 400);

  const direct = await jsonRequest(view, '/api/chat', token, { text: 'still answer me', conversationId: id });
  assert.equal(direct.response.status, 200);
  assert.equal(direct.value.conversation.messages.at(-1).display, 'echo still answer me');
  assert.equal(direct.value.conversations.find(row => row.id === id).proactiveMode, 'suppress');

  const archived = await jsonRequest(view, '/api/conversations/archive', token, {
    id, archived: true, expectedRevision: direct.value.conversations.find(row => row.id === id).lifecycleRevision,
  });
  const restored = await jsonRequest(view, '/api/conversations/archive', token, {
    id, archived: false, expectedRevision: archived.value.conversationStatus.lifecycleRevision,
  });
  assert.equal(restored.value.conversationStatus.proactiveMode, 'suppress');
  const allowed = await jsonRequest(view, '/api/conversations/proactive', token, {
    id, mode: 'allow', expectedRevision: stoppedRow.proactiveRevision,
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.value.conversationProactive.proactiveMode, 'allow');
});

test('a live model run fences conversation archiving until its complete turn is saved', async t => {
  const data = await fixture(t);
  let enteredResolve;
  let finishResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const finish = new Promise(resolve => { finishResolve = resolve; });
  const provider = {
    id: 'synthetic/lifecycle-race',
    complete() {
      enteredResolve();
      return finish;
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, clock });
  t.after(() => {
    finishResolve?.({ role: 'assistant', content: 'Synthetic cleanup reply.' });
    return view.close();
  });
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  const row = boot.conversations.find(conversation => conversation.id === boot.conversationId);
  const chatPromise = jsonRequest(view, '/api/chat', token, {
    text: 'finish this whole turn first', conversationId: row.id,
  });
  await entered;

  const refused = await jsonRequest(view, '/api/conversations/archive', token, {
    id: row.id, archived: true, expectedRevision: row.lifecycleRevision,
  });
  assert.equal(refused.response.status, 429);
  assert.equal((await data.archive.snapshot()).lifecycles.length, 0);

  finishResolve({ role: 'assistant', content: 'The whole turn landed.' });
  const chat = await chatPromise;
  assert.equal(chat.response.status, 200);
  assert.deepEqual(chat.value.conversation.messages.map(message => message.display), [
    'finish this whole turn first', 'The whole turn landed.',
  ]);
  const current = chat.value.conversations.find(conversation => conversation.id === row.id);
  const archived = await jsonRequest(view, '/api/conversations/archive', token, {
    id: row.id, archived: true, expectedRevision: current.lifecycleRevision,
  });
  assert.equal(archived.response.status, 200);
  assert.equal(archived.value.conversationStatus.archived, true);
});

test('an archived bridge target fails closed before model work', async t => {
  const data = await fixture(t);
  let providerCalls = 0;
  const provider = {
    id: 'synthetic/stale-bridge-archive',
    complete() { providerCalls += 1; return { role: 'assistant', content: 'must not run' }; },
  };
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, clock });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  const row = boot.conversations.find(conversation => conversation.id === boot.conversationId);
  const archived = await jsonRequest(view, '/api/conversations/archive', token, {
    id: row.id, archived: true, expectedRevision: row.lifecycleRevision,
  });
  assert.equal(archived.response.status, 200);

  await assert.rejects(view.receiveExternalMessage({
    platform: 'telegram',
    destinationId: '123456789',
    sourceUserId: '987654321',
    sourceMessageId: '42',
    at,
    text: 'This stale route must not wake the model.',
    conversationId: row.id,
  }), error => error?.status === 409 && /archived.*restore/i.test(error.message));
  assert.equal(providerCalls, 0);
  assert.equal((await data.archive.snapshot()).messages.length, 0);
});

test('a configured bridge binding blocks conversation archiving even while paused', async t => {
  const data = await fixture(t);
  let boundId = null;
  const bridgeManager = {
    async snapshot() {
      return {
        format: BRIDGE_PUBLIC_FORMAT,
        telegram: {
          configured: true,
          token: { source: 'saved', available: true, canSave: true, canForget: true },
          state: 'paused',
          route: {
            chatId: '123456789', allowedUserId: '987654321', scope: 'direct', respondTo: 'all', conversationId: boundId,
          },
        },
        discord: {
          configured: false,
          token: { source: 'none', available: false, canSave: true, canForget: false },
          state: 'not-configured',
        },
      };
    },
    async perform() {},
  };
  const view = await startBrowserView({
    profile: data.profile,
    provider: { id: 'synthetic/bridge-archive', complete() { return { role: 'assistant', content: 'saved' }; } },
    archive: data.archive,
    bridgeManager,
    onRestart() {},
    clock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  boundId = boot.conversationId;
  const chat = await jsonRequest(view, '/api/chat', token, { text: 'bind this conversation', conversationId: boundId });
  const row = chat.value.conversations.find(conversation => conversation.id === boundId);
  const refused = await jsonRequest(view, '/api/conversations/archive', token, {
    id: boundId, archived: true, expectedRevision: row.lifecycleRevision,
  });
  assert.equal(refused.response.status, 409);
  assert.match(refused.value.error, /Disconnect or rebind Telegram/);
  assert.equal((await data.archive.snapshot()).lifecycles.length, 0, 'the refusal writes no lifecycle event');
});

test('a named empty conversation is kept when New opens another draft', async t => {
  const data = await fixture(t);
  const view = await startBrowserView({ profile: data.profile, archive: data.archive, clock });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  const namedId = boot.conversationId;
  const namedBefore = boot.conversations.find(row => row.id === namedId);
  const renamed = await jsonRequest(view, '/api/conversations/rename', token, {
    id: namedId, title: 'A named empty draft', expectedRevision: namedBefore.titleRevision,
  });
  assert.equal(renamed.response.status, 200);

  const fresh = await jsonRequest(view, '/api/conversations/new', token, {});
  assert.notEqual(fresh.value.conversationId, namedId);
  assert.equal(fresh.value.conversations.find(row => row.id === namedId).title, 'A named empty draft');
  const reused = await jsonRequest(view, '/api/conversations/new', token, {});
  assert.equal(reused.value.conversationId, fresh.value.conversationId, 'only the still-untouched draft is reused');
});

test('the room can be stopped from the browser only when the host allows it', async t => {
  const data = await fixture(t);
  let stopped = 0;
  const view = await startBrowserView({ profile: data.profile, onShutdown: () => { stopped += 1; } });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.capabilities.shutdown, true);
  const answer = await jsonRequest(view, '/api/shutdown', token, {});
  assert.deepEqual([answer.response.status, answer.value.stopping], [200, true]);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(stopped, 1);

  const plain = await startBrowserView({ profile: data.profile });
  t.after(() => plain.close());
  const plainToken = launchAuthorization(plain).token;
  assert.equal((await jsonRequest(plain, '/api/shutdown', plainToken, {})).response.status, 409);
});

test('the room can request a restart only when a host supervisor allows it', async t => {
  const data = await fixture(t);
  let restarted = 0;
  const view = await startBrowserView({ profile: data.profile, onRestart: () => { restarted += 1; } });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.capabilities.restart, true);
  const answer = await jsonRequest(view, '/api/restart', token, {});
  assert.deepEqual([answer.response.status, answer.value.restarting], [200, true]);
  const closing = await bootstrapRequest(view, token);
  assert.equal(closing.value.health.status, 'closing');
  assert.equal(closing.value.capabilities.restart, false);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(restarted, 1);

  const plain = await startBrowserView({ profile: data.profile });
  t.after(() => plain.close());
  const plainToken = launchAuthorization(plain).token;
  assert.equal((await bootstrapRequest(plain, plainToken)).value.capabilities.restart, false);
  assert.equal((await jsonRequest(plain, '/api/restart', plainToken, {})).response.status, 409);
});

test('a host-supplied secret must be as strong as a generated one', async t => {
  const data = await fixture(t);
  await assert.rejects(startBrowserView({ profile: data.profile, secret: 'short' }), /secret must be 32 random bytes/);
});

test('the room switches only to models the host offers, and never mid-reply', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'model-changes.json'), clock });
  const make = (model, effort = null) => Object.freeze({
    id: `synthetic/${model}${effort ? `/effort-${effort}` : ''}`,
    complete: () => ({ role: 'assistant', content: `from ${model}` }),
  });
  const chosen = [];
  const efforts = [];
  const models = {
    current: 'alpha',
    effort: null,
    list: async () => [
      { id: 'alpha', label: 'Alpha', efforts: [{ id: 'low' }, { id: 'high', description: 'Thinks longer.' }], defaultEffort: 'low', effortSource: 'catalogue' },
      { id: 'beta', label: 'Beta', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high', effortSource: 'catalogue' },
    ],
    choose: async id => { chosen.push(id); models.current = id; models.effort = null; return make(id); },
    chooseEffort: async effort => { efforts.push(effort); models.effort = effort; return make(models.current, effort); },
  };
  const view = await startBrowserView({ profile: data.profile, provider: make('alpha'), models, archive: data.archive, changeLog });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  const boot = (await bootstrapRequest(view, token)).value;
  assert.deepEqual(boot.model, { current: 'alpha', effort: null, switchable: true, effortConfigurable: true });
  const listed = await jsonRequest(view, '/api/models', token, {});
  assert.deepEqual(listed.value.model.choices.map(row => row.id), ['alpha', 'beta']);
  assert.deepEqual(listed.value.model.choices[0], {
    id: 'alpha', label: 'Alpha', efforts: [{ id: 'low' }, { id: 'high', description: 'Thinks longer.' }],
    defaultEffort: 'low', effortSource: 'catalogue',
  });

  assert.equal((await jsonRequest(view, '/api/model/effort', token, { effort: 'max' })).response.status, 400);
  const thought = await jsonRequest(view, '/api/model/effort', token, { effort: 'high' });
  assert.equal(thought.value.model.effort, 'high');
  assert.equal(thought.value.health.provider.id, 'synthetic/alpha/effort-high');
  let effortChange;
  for (let attempt = 0; attempt < 20 && !effortChange; attempt++) {
    const effortChanges = (await jsonRequest(view, '/api/changes/view', token, {})).value;
    effortChange = effortChanges.entries.find(entry => entry.key === 'model-effort' && entry.afterText === 'high');
    if (!effortChange) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(effortChange, 'the explicit effort change reaches durable room history');
  assert.equal(effortChange.undoable, true);
  const effortUndone = await jsonRequest(view, '/api/changes/undo', token, { id: effortChange.id });
  assert.equal(effortUndone.response.status, 200);
  assert.equal(effortUndone.value.model.effort, null);
  assert.equal(effortUndone.value.health.provider.id, 'synthetic/alpha');

  const refused = await jsonRequest(view, '/api/model', token, { id: 'gamma' });
  assert.equal(refused.response.status, 400);
  const switched = await jsonRequest(view, '/api/model', token, { id: 'beta' });
  assert.equal(switched.value.model.current, 'beta');
  assert.equal(switched.value.health.provider.id, 'synthetic/beta');
  const [wrongKey, noOp] = await changeLog.record([
    { key: 'not-model', area: 'model', label: 'Forged model row', by: 'person', before: 'alpha', after: null, beforeText: 'alpha', afterText: 'none' },
    { key: 'model', area: 'model', label: 'No-op model row', by: 'person', before: 'beta', after: 'beta', beforeText: 'beta', afterText: 'beta' },
  ]);
  const changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.equal(changes.entries.find(entry => entry.id === wrongKey.id).undoable, false);
  assert.equal(changes.entries.find(entry => entry.id === noOp.id).undoable, false);
  const modelChange = changes.entries.find(entry => entry.key === 'model' && entry.beforeText === 'alpha');
  assert.equal(modelChange.undoable, true);
  const undone = await jsonRequest(view, '/api/changes/undo', token, { id: modelChange.id });
  assert.equal(undone.response.status, 200);
  assert.equal(undone.value.entries[0].undoOf, modelChange.id);
  assert.equal(undone.value.model.current, 'alpha');
  assert.equal(undone.value.health.provider.id, 'synthetic/alpha');
  assert.equal((await jsonRequest(view, '/api/models', token, {})).value.model.current, 'alpha');
  assert.deepEqual(chosen, ['beta', 'alpha']);
  assert.deepEqual(efforts, ['high', null]);
  await jsonRequest(view, '/api/model', token, { id: 'beta' });
  const chat = await jsonRequest(view, '/api/chat', token, { text: 'hi' });
  assert.equal(chat.value.conversation.messages.at(-1).display, 'from beta');
});

test('a room without a host model list refuses model changes', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'fixed-model-changes.json'), clock });
  await changeLog.record([{
    key: 'model', area: 'model', label: 'Model', by: 'person',
    before: 'alpha', after: 'fixed', beforeText: 'alpha', afterText: 'fixed',
  }]);
  const view = await startBrowserView({
    profile: data.profile,
    provider: Object.freeze({ id: 'fixed', complete: () => ({ role: 'assistant', content: 'x' }) }),
    changeLog,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.model, null);
  assert.equal((await jsonRequest(view, '/api/model', token, { id: 'x' })).response.status, 409);
  assert.equal((await jsonRequest(view, '/api/changes/view', token, {})).value.entries.find(entry => entry.key === 'model').undoable, false);
});

test('a running Fieldwork keeps its starting model and fences model changes', async t => {
  const data = await fixture(t);
  let releaseNote;
  const noteGate = new Promise(resolve => { releaseNote = resolve; });
  let enterNote;
  const noteEntered = new Promise(resolve => { enterNote = resolve; });
  const noted = [];
  const modelHistory = {
    async note(model) {
      noted.push(model);
      enterNote();
      await noteGate;
    },
    contextText() { return ''; },
  };
  let alphaCalls = 0;
  let betaCalls = 0;
  const alpha = Object.freeze({
    id: 'synthetic/fieldwork-alpha',
    complete() {
      alphaCalls += 1;
      return { role: 'assistant', content: 'Alpha completed the Fieldwork.' };
    },
  });
  const beta = Object.freeze({
    id: 'synthetic/fieldwork-beta',
    complete() {
      betaCalls += 1;
      return { role: 'assistant', content: 'Beta should not enter the running Fieldwork.' };
    },
  });
  const models = {
    current: 'alpha',
    effort: null,
    async list() {
      return [
        { id: 'alpha', label: 'Alpha', efforts: [{ id: 'low' }] },
        { id: 'beta', label: 'Beta', efforts: [{ id: 'low' }] },
      ];
    },
    async choose(id) { models.current = id; return id === 'beta' ? beta : alpha; },
    async chooseEffort(effort) { models.effort = effort; return models.current === 'beta' ? beta : alpha; },
  };
  const view = await startBrowserView({
    profile: data.profile,
    provider: alpha,
    models,
    modelHistory,
    fieldworkDir: path.join(data.directory, 'model-fenced-fieldworks'),
    clock,
  });
  t.after(async () => {
    releaseNote();
    await view.close();
  });
  const { token } = launchAuthorization(view);

  const started = await jsonRequest(view, '/api/fieldworks/start', token, {
    prompt: 'Which model is doing this work?',
    maxSteps: 2,
  });
  assert.equal(started.response.status, 200);
  await noteEntered;
  const refusedModel = await jsonRequest(view, '/api/model', token, { id: 'beta' });
  assert.equal(refusedModel.response.status, 409);
  assert.match(refusedModel.value.error, /current model run|finish/);
  const refusedEffort = await jsonRequest(view, '/api/model/effort', token, { effort: null });
  assert.equal(refusedEffort.response.status, 409);
  assert.match(refusedEffort.value.error, /finish/);

  releaseNote();
  let fieldwork;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    fieldwork = (await jsonRequest(view, '/api/fieldworks/get', token, { id: started.value.fieldwork.id })).value.fieldwork;
    if (fieldwork.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fieldwork.status, 'completed');
  assert.equal(fieldwork.model, 'alpha');
  assert.deepEqual(noted, ['alpha']);
  assert.equal(alphaCalls, 1);
  assert.equal(betaCalls, 0);

  const switched = await jsonRequest(view, '/api/model', token, { id: 'beta' });
  assert.equal(switched.response.status, 200, switched.value?.error);
});

test('stopping a Fieldwork aborts pending meaning recall before provider entry', async t => {
  const data = await fixture(t);
  await data.ledger.record(createMemoryRecord({
    id: 'memory:fieldwork-stop-puppy',
    kind: 'authored-memory',
    text: 'Biscuit is the puppy adopted last spring.',
    author: { kind: 'agent', id: 'synthetic-agent' },
    createdAt: at,
    basis: 'self-authored',
    confidence: 'asserted',
  }));
  let enterLookup;
  const lookupEntered = new Promise(resolve => { enterLookup = resolve; });
  let firstRequest = true;
  const readyFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      data: body.input.map((text, index) => ({
        index,
        embedding: [/dog|puppy|biscuit/i.test(text) ? 1 : 0, 0.2],
      })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const meaningRecall = await createMeaningRecall({
    stateDir: path.join(data.directory, 'stopped-fieldwork-meaning'),
    fetch: async (url, init) => {
      if (!firstRequest) return readyFetch(url, init);
      firstRequest = false;
      enterLookup();
      return new Promise((_resolve, reject) => {
        const stop = () => reject(init.signal.reason ?? new Error('stopped semantic lookup'));
        if (init.signal.aborted) stop();
        else init.signal.addEventListener('abort', stop, { once: true });
      });
    },
  });
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'stopped-fieldwork-effects.jsonl'), {
    id: 'stopped-fieldwork-effects',
    clock,
  });
  let providerCalls = 0;
  const view = await startBrowserView({
    profile: data.profile,
    provider: {
      id: 'synthetic/stopped-fieldwork-provider',
      complete() {
        providerCalls += 1;
        return { role: 'assistant', content: 'The next Fieldwork completed.' };
      },
    },
    ledger: data.ledger,
    memoryForeground: true,
    meaningRecall,
    fieldworkDir: path.join(data.directory, 'stopped-fieldworks'),
    toolEffects,
    clock,
  });
  let closed = false;
  t.after(async () => {
    if (closed) return;
    try { await view.close(); } catch { /* The assertion failure is more useful. */ }
    try { await toolEffects.close(); } catch { /* The fixture may already be gone after a failed test. */ }
  });
  const { token } = launchAuthorization(view);

  const started = await jsonRequest(view, '/api/fieldworks/start', token, {
    prompt: 'How is my dog doing?',
    maxSteps: 2,
  });
  assert.equal(started.response.status, 200);
  await lookupEntered;
  const stopped = await jsonRequest(view, '/api/fieldworks/stop', token, { id: started.value.fieldwork.id });
  assert.equal(stopped.response.status, 200);
  let first;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    first = (await jsonRequest(view, '/api/fieldworks/get', token, { id: started.value.fieldwork.id })).value.fieldwork;
    if (first.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(first.status, 'stopped');
  assert.equal(providerCalls, 0, 'stopping semantic recall prevents model entry');
  assert.equal((await toolEffects.unresolved()).total, 0);

  const next = await jsonRequest(view, '/api/fieldworks/start', token, {
    prompt: 'How is my dog doing now?',
    maxSteps: 2,
  });
  assert.equal(next.response.status, 200, next.value?.error);
  let second;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    second = (await jsonRequest(view, '/api/fieldworks/get', token, { id: next.value.fieldwork.id })).value.fieldwork;
    if (second.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(second.status, 'completed');
  assert.equal(providerCalls, 1);
  await view.close();
  await toolEffects.close();
  closed = true;
});

test('Fieldworks run in the background through the room and can be brought into a conversation', async t => {
  const data = await fixture(t);
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'fieldwork-effects.jsonl'), {
    id: 'fieldwork-effects', clock,
  });
  t.after(async () => { try { await toolEffects.close(); } catch { /* Cleanup only. */ } });
  const { createToolGroupSettings } = await import('../src/tool-groups.mjs');
  const toolGroups = await createToolGroupSettings({ file: path.join(data.directory, 'fieldwork-tool-groups.json') });
  await toolGroups.set('clock', 'on-demand');
  await data.ledger.record(createMemoryRecord({
    id: 'memory:fieldwork-time', kind: 'authored-memory', text: 'The synthetic time belongs to the quartz clock.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: at,
    basis: 'self-authored', confidence: 'asserted',
  }));
  const fieldworkDir = path.join(data.directory, 'fieldworks');
  const calls = [];
  const provider = Object.freeze({
    id: 'synthetic/fieldwork',
    complete(request) {
      calls.push(request);
      const lastTool = request.messages.at(-1).role === 'tool';
      const names = request.tools.map(tool => tool.function.name);
      if (lastTool && request.messages.at(-1).tool_call_id === 'c1') return { role: 'assistant', content: 'The clock says it is a synthetic day.' };
      if (!names.includes('what_time_is_it')) {
        return { role: 'assistant', content: null, tool_calls: [{ id: 'load-clock', type: 'function', function: { name: 'load_tool_group', arguments: '{"group":"clock"}' } }] };
      }
      return { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'what_time_is_it', arguments: '{}' } }] };
    },
  });
  const tools = createToolRegistry([{
    name: 'what_time_is_it', description: 'Get the current synthetic time.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ iso: at }),
  }]);
  const view = await startBrowserView({
    profile: data.profile, provider, tools, toolGroups, ledger: data.ledger, archive: data.archive,
    memoryForeground: true, fieldworkDir, toolEffects,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.capabilities.fieldwork, true);

  const started = await jsonRequest(view, '/api/fieldworks/start', token, { prompt: 'What time is it on the quartz clock?', maxSteps: 4 });
  assert.equal(started.response.status, 200);
  const id = started.value.fieldwork.id;
  let fieldwork;
  for (let tries = 0; tries < 100; tries++) {
    fieldwork = (await jsonRequest(view, '/api/fieldworks/get', token, { id })).value.fieldwork;
    if (fieldwork.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(fieldwork.status, 'completed');
  assert.equal(fieldwork.answer, 'The clock says it is a synthetic day.');
  assert.deepEqual(fieldwork.steps, [
    { kind: 'tool', tool: 'load_tool_group', detail: 'group: clock', ok: true },
    { kind: 'tool', tool: 'what_time_is_it', detail: '', ok: true },
  ]);
  assert.ok(!('messages' in fieldwork), 'tool results never reach the browser');
  assert.match(calls[0].messages[0].content, /This is a Fieldwork/);
  assert.ok(!calls[0].tools.some(tool => tool.function.name === 'what_time_is_it'));
  assert.ok(calls[1].tools.some(tool => tool.function.name === 'what_time_is_it'));
  assert.match(JSON.stringify(calls[0].messages), /synthetic time belongs to the quartz clock/);
  assert.equal((await toolEffects.unresolved()).items.length, 0);
  const effectHistory = await toolEffects.history();
  assert.equal(effectHistory.length, 1);
  assert.equal(effectHistory[0].tool, 'what_time_is_it');
  assert.equal(effectHistory[0].origin, 'fieldwork');
  assert.equal(effectHistory[0].runDisposition.status, 'committed');

  const brought = await jsonRequest(view, '/api/fieldworks/bring', token, { id });
  assert.deepEqual(brought.value.conversation.messages.map(message => message.display), ['Fieldwork: What time is it on the quartz clock?', 'The clock says it is a synthetic day.']);
  assert.equal(brought.value.conversations[0].title, 'Fieldwork: What time is it on the quartz clock?');
  const listed = await jsonRequest(view, '/api/fieldworks/list', token, {});
  assert.equal(listed.value.fieldworks.length, 1);
  assert.equal((await jsonRequest(view, '/api/fieldworks/start', token, { prompt: '' })).response.status, 400);
});

test('each reply carries how it got there, and tool messages fold into it', async t => {
  const data = await fixture(t);
  const provider = Object.freeze({
    id: 'synthetic/trail',
    complete(request) {
      return request.messages.at(-1).role === 'tool'
        ? { role: 'assistant', content: 'It is a synthetic day.' }
        : { role: 'assistant', content: 'Checking the clock.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'what_time_is_it', arguments: '{}' } }] };
    },
  });
  const tools = createToolRegistry([{
    name: 'what_time_is_it', description: 'Get the current synthetic time.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ iso: at }),
  }]);
  const view = await startBrowserView({ profile: data.profile, provider, tools, archive: data.archive });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const chat = await jsonRequest(view, '/api/chat', token, { text: 'What time is it?' });
  assert.deepEqual(chat.value.conversation.messages, [
    { role: 'user', display: 'What time is it?' },
    { role: 'assistant', display: 'It is a synthetic day.', trail: [
      { kind: 'note', text: 'Checking the clock.' },
      { kind: 'tool', tool: 'what_time_is_it', detail: '', ok: true },
    ] },
  ]);
});

test('editing a root from the room changes what the next reply is given', async t => {
  const data = await fixture(t);
  const seen = [];
  const provider = Object.freeze({ id: 'synthetic/roots', complete(request) { seen.push(JSON.stringify(request.messages)); return { role: 'assistant', content: 'ok' }; } });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive,
    rootHistoryDir: path.join(data.directory, 'root-history'), lookFile: path.join(data.directory, 'look.json'),
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.editRoots, true);
  assert.deepEqual(boot.look.agent, { name: 'Agent', nameBy: null, icon: null, iconBy: null, iconHistory: [], pronouns: null, pronounForms: null, pronounsBy: null });

  const opened = (await jsonRequest(view, '/api/roots/get', token, { id: 'identity' })).value.root;
  assert.equal(opened.text, 'PRIVATE SYNTHETIC ROOT SENTINEL');
  const saved = await jsonRequest(view, '/api/roots/save', token, { id: 'identity', text: 'EDITED SYNTHETIC IDENTITY', expectedSha256: opened.sha256 });
  assert.equal(saved.response.status, 200);
  assert.notEqual(saved.value.health.profile.fingerprint, boot.health.profile.fingerprint);
  await jsonRequest(view, '/api/chat', token, { text: 'hello' });
  assert.match(seen.at(-1), /EDITED SYNTHETIC IDENTITY/);
  assert.doesNotMatch(seen.at(-1), /PRIVATE SYNTHETIC ROOT SENTINEL/);

  const stale = await jsonRequest(view, '/api/roots/save', token, { id: 'identity', text: 'again', expectedSha256: opened.sha256 });
  assert.equal(stale.response.status, 409);
  const named = await jsonRequest(view, '/api/look/update', token, { who: 'agent', name: 'Fern', icon: { kind: 'emoji', value: '🌿' } });
  assert.equal(named.value.look.agent.name, 'Fern');
});

test('guide rewrite requests are selection-scoped and agent-set pronouns return to the room', async t => {
  const data = await fixture(t);
  const guides = await createAgentGuideStore({ file: path.join(data.directory, 'guides.json'), clock });
  let requestId = null;
  let phase = 0;
  let finished = false;
  const seen = [];
  const provider = Object.freeze({
    id: 'synthetic/self-authorship',
    complete(request) {
      seen.push(request.messages);
      if (finished) return { role: 'assistant', content: 'The room still fits.' };
      if (phase === 0) {
        phase += 1;
        return { role: 'assistant', content: null, tool_calls: [{
          id: 'g1', type: 'function', function: { name: 'read_house_guides', arguments: JSON.stringify({ request_id: requestId }) },
        }] };
      }
      if (phase === 1) {
        phase += 1;
        return { role: 'assistant', content: null, tool_calls: [{
          id: 'g2', type: 'function', function: {
            name: 'rewrite_house_guides',
            arguments: JSON.stringify({
              request_id: requestId,
              expected_revision: 0,
              guides: [{ id: 'memory', text: 'I keep what matters, mark where it came from, and leave corrections visible.' }],
            }),
          },
        }] };
      }
      if (phase === 2) {
        phase += 1;
        return { role: 'assistant', content: null, tool_calls: [{
          id: 'p1', type: 'function', function: { name: 'set_my_pronouns', arguments: '{"pronouns":"she/her + xe/xem"}' },
        }] };
      }
      finished = true;
      return { role: 'assistant', content: 'I rewrote the memory guide and set my room pronouns.' };
    },
  });
  const tools = createToolRegistry([
    ...agentGuideTools(guides, { agentId: 'synthetic-agent' }),
    {
      name: 'remember', description: 'Synthetic memory tool used only to expose the matching guide.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () => ({ ok: true }),
    },
  ]);
  const view = await startBrowserView({
    profile: data.profile,
    provider,
    tools,
    archive: data.archive,
    guides,
    lookFile: path.join(data.directory, 'look.json'),
    clock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.guides, true);
  assert.equal(boot.look.agent.pronouns, null);

  const invited = await jsonRequest(view, '/api/guides/request', token, { guides: ['memory'] });
  assert.equal(invited.response.status, 200);
  assert.deepEqual(invited.value.invitation.guides, ['memory']);
  requestId = invited.value.invitation.requestId;

  const chat = await jsonRequest(view, '/api/chat', token, { text: `Please use guide request ${requestId}.` });
  assert.equal(chat.response.status, 200);
  assert.equal(chat.value.guides.revision, 1);
  assert.match(chat.value.guides.guides.find(row => row.id === 'memory').text, /leave corrections visible/);
  assert.equal(chat.value.guides.guides.find(row => row.id === 'discord').text, null);
  assert.deepEqual(chat.value.look.agent, {
    name: 'Agent', nameBy: null, icon: null, iconBy: null, iconHistory: [], pronouns: 'she/her + xe/xem',
    pronounForms: { subject: 'she', object: 'her', possessiveDeterminer: 'her', possessivePronoun: 'hers', reflexive: 'herself', agreement: 'singular' },
    pronounsBy: 'agent',
  });

  await jsonRequest(view, '/api/chat', token, { text: 'Are those choices still present?' });
  const nextPrompt = JSON.stringify(seen.at(-1));
  assert.match(nextPrompt, /I keep what matters/);
  assert.match(nextPrompt, /she\/her \+ xe\/xem/);

  const reset = await jsonRequest(view, '/api/guides/reset', token, { id: 'memory', expectedRevision: 1 });
  assert.equal(reset.value.guides.guides.find(row => row.id === 'memory').text, null);
  const restored = await jsonRequest(view, '/api/guides/restore', token, {
    id: 'memory', version: 'change-2', expectedRevision: 2,
  });
  assert.match(restored.value.guides.guides.find(row => row.id === 'memory').text, /leave corrections visible/);
  assert.deepEqual(restored.value.guides.guides.find(row => row.id === 'memory').author, { kind: 'operator', id: 'browser' });
});

test('moods and emoji reach the agent as a temporary note, and the agent can change its mood', async t => {
  const data = await fixture(t);
  const { createExpressionStore, expressionTools } = await import('../src/expression.mjs');
  const expression = await createExpressionStore({ file: path.join(data.directory, 'expression.json') });
  const seen = [];
  const provider = Object.freeze({
    id: 'synthetic/expression',
    complete(request) {
      seen.push(request.messages);
      return request.messages.at(-1).role === 'tool'
        ? { role: 'assistant', content: 'Feeling it :sprout:' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'm1', type: 'function', function: { name: 'set_mood', arguments: '{"mood":"happy"}' } }] };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, expression,
    tools: createToolRegistry(expressionTools(expression)), lookFile: path.join(data.directory, 'look.json'),
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.capabilities.expression, true);

  await jsonRequest(view, '/api/expression/mood/starter', token, {});
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]).toString('base64')}`;
  const added = await jsonRequest(view, '/api/expression/emoji/add', token, { name: 'sprout', description: 'something small and growing', dataUrl: png });
  assert.deepEqual(added.value.expression.emoji, [{ name: 'sprout', description: 'something small and growing' }]);

  const chat = await jsonRequest(view, '/api/chat', token, { text: 'How are you?' });
  assert.equal(chat.response.status, 200);
  assert.match(JSON.stringify(seen[0]), /Fieldwork expression/);
  assert.match(JSON.stringify(seen[0]), /:sprout: something small and growing/);
  assert.equal(chat.value.expression.current.name, 'happy');
  assert.equal(chat.value.conversation.messages.at(-1).display, 'Feeling it :sprout:');
  const reopened = await jsonRequest(view, '/api/conversations/open', token, { id: chat.value.conversationId });
  assert.doesNotMatch(JSON.stringify(reopened.value), /Fieldwork expression/, 'the note is never saved into the conversation');

  const image = await jsonRequest(view, '/api/expression/emoji/image', token, { name: 'sprout' });
  assert.equal(image.value.dataUrl, png);

  // Picture uploads larger than the ordinary 64 KB request limit now fit.
  const big = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(150 * 1024, 3)]).toString('base64')}`;
  const icon = await jsonRequest(view, '/api/look/update', token, { who: 'agent', icon: { kind: 'image', dataUrl: big } });
  assert.equal(icon.response.status, 200);
  assert.equal(icon.value.look.agent.icon.kind, 'image');
});

test('pictures reach the model as pictures while the saved conversation keeps only a reference', async t => {
  const data = await fixture(t);
  const { createAttachmentStore } = await import('../src/attachments.mjs');
  const attachments = await createAttachmentStore({ dir: path.join(data.directory, 'attachments') });
  const seen = [];
  const provider = Object.freeze({ id: 'synthetic/vision', complete(request) { seen.push(request.messages); return { role: 'assistant', content: 'A tiny picture.' }; } });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, attachments });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.capabilities.attachments, true);

  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]).toString('base64')}`;
  const note = `data:text/plain;base64,${Buffer.from('fern notes').toString('base64')}`;
  const chat = await jsonRequest(view, '/api/chat', token, { text: '', attachments: [{ name: 'leaf.png', dataUrl: png }, { name: 'fern.txt', dataUrl: note }] });
  assert.equal(chat.response.status, 200);
  const sentUser = seen[0].findLast(message => message.role === 'user');
  assert.ok(sentUser.content.some(part => part.type === 'image_url' && part.image_url.url === png), 'the model gets the real picture');
  assert.ok(sentUser.content.some(part => part.type === 'text' && part.text.includes('fern notes')));

  const shown = chat.value.conversation.messages[0];
  assert.equal(shown.display, '', 'the file text does not flood the bubble');
  assert.deepEqual(shown.attachments.map(row => row.kind), ['image', 'file']);
  const reopened = await jsonRequest(view, '/api/conversations/open', token, { id: chat.value.conversationId });
  assert.doesNotMatch(JSON.stringify(reopened.value), /base64/);
  const imageResponse = await fetch(new URL('/api/attachments/image', view.url), {
    method: 'POST',
    headers: { origin: new URL(view.url).origin, 'content-type': 'application/json', 'x-fieldwork-token': token },
    body: JSON.stringify({ ref: shown.attachments[0].ref }),
  });
  assert.equal(imageResponse.headers.get('content-type'), 'image/png', 'pictures come back as pictures, not JSON, so size is no problem');
  assert.equal(`data:image/png;base64,${Buffer.from(await imageResponse.arrayBuffer()).toString('base64')}`, png);

  // A real photo is megabytes: far over the 2 MB JSON reply limit, still shown.
  const photoBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3 * 1024 * 1024, 7)]);
  const photo = await jsonRequest(view, '/api/chat', token, { text: 'a photo', attachments: [{ name: 'photo.png', dataUrl: `data:image/png;base64,${photoBytes.toString('base64')}` }] });
  assert.equal(photo.response.status, 200);
  const photoRef = photo.value.conversation.messages.at(-2).attachments[0].ref;
  const photoBack = await fetch(new URL('/api/attachments/image', view.url), {
    method: 'POST',
    headers: { origin: new URL(view.url).origin, 'content-type': 'application/json', 'x-fieldwork-token': token },
    body: JSON.stringify({ ref: photoRef }),
  });
  assert.equal(photoBack.status, 200);
  assert.equal((await photoBack.arrayBuffer()).byteLength, photoBytes.length);

  const refused = await jsonRequest(view, '/api/chat', token, { text: 'see', attachments: [{ name: 'doc.pdf', dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}` }] });
  assert.equal(refused.response.status, 400);
  assert.match(refused.value.error, /cannot read yet/);
});

test('a streamed chat sends the reply line by line and ends with the same reply a plain request gets', async t => {
  const data = await fixture(t);
  const provider = Object.freeze({ id: 'synthetic/streamer', complete(request) { request.onText?.('Hello '); request.onText?.('there'); return { role: 'assistant', content: 'Hello there' }; } });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const response = await fetch(new URL('/api/chat', view.url), {
    method: 'POST',
    headers: { origin: new URL(view.url).origin, 'content-type': 'application/json', 'x-fieldwork-token': token },
    body: JSON.stringify({ text: 'hi', stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.delta), ['Hello ', 'there']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.reply.conversation.messages.at(-1).display, 'Hello there');

  const failing = Object.freeze({ id: 'synthetic/broken', complete() { throw new Error('model offline'); } });
  const broken = await startBrowserView({ profile: data.profile, provider: failing });
  t.after(() => broken.close());
  const brokenToken = launchAuthorization(broken).token;
  const failed = await fetch(new URL('/api/chat', broken.url), {
    method: 'POST',
    headers: { origin: new URL(broken.url).origin, 'content-type': 'application/json', 'x-fieldwork-token': brokenToken },
    body: JSON.stringify({ text: 'hi', stream: true }),
  });
  const last = JSON.parse((await failed.text()).trim().split('\n').at(-1));
  assert.equal(last.type, 'error');
  assert.ok(last.error);
});

test('task heartbeats run outside chat with only their exact tools and a mandatory structured verdict', async t => {
  const data = await fixture(t);
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'heartbeat-effects.jsonl'), {
    id: 'heartbeat-effects', clock,
  });
  t.after(async () => { try { await toolEffects.close(); } catch { /* Cleanup only. */ } });
  const { createTaskHeartbeatStore } = await import('../src/task-heartbeats.mjs');
  const { createToolGroupSettings } = await import('../src/tool-groups.mjs');
  const heartbeats = await createTaskHeartbeatStore({ file: path.join(data.directory, 'task-heartbeats.json'), clock });
  const toolGroups = await createToolGroupSettings({ file: path.join(data.directory, 'tool-groups.json') });
  await toolGroups.set('other', 'on-demand');
  let inspections = 0;
  const tools = createToolRegistry([{
    name: 'inspect_specimen',
    description: 'Inspect one synthetic test specimen.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() { inspections += 1; return { state: 'unchanged' }; },
  }]);
  const requests = [];
  const replies = [
    {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'inspect-1', type: 'function', function: { name: 'inspect_specimen', arguments: '{}' } },
        { id: 'report-1', type: 'function', function: { name: 'report_task_heartbeat', arguments: '{"outcome":"no-change"}' } },
      ],
    },
    { role: 'assistant', content: 'This ordinary final prose must not enter a conversation.' },
    { role: 'assistant', content: 'I forgot to use the structured result tool.' },
  ];
  const provider = Object.freeze({
    id: 'synthetic/task-heartbeat-provider',
    complete(request) { requests.push(request); return replies.shift(); },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, tools, toolGroups, toolEffects, archive: data.archive, heartbeats, clock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.heartbeats, true);
  assert.equal(boot.heartbeats.heartbeats.length, 0);
  assert.equal(boot.heartbeats.runnable, true);

  const definition = {
    name: 'Synthetic specimen watch',
    task: 'Inspect the synthetic specimen.',
    meaningfulChange: 'Its state differs from the previous receipt.',
    completionRule: 'Its state is terminal.',
    cadenceHours: 2,
    toolNames: ['inspect_specimen'],
  };
  const created = await jsonRequest(view, '/api/heartbeats/create', token, { definition });
  assert.equal(created.response.status, 200);
  const heartbeat = created.value.heartbeat;
  assert.equal(heartbeat.status, 'active');
  assert.equal(heartbeat.nextRunAt, '2030-01-02T05:04:05.000Z');

  const unknownTool = await jsonRequest(view, '/api/heartbeats/create', token, {
    definition: { ...definition, name: 'Bad tool watch', toolNames: ['not_a_room_tool'] },
  });
  assert.equal(unknownTool.response.status, 400);
  assert.match(unknownTool.value.error, /not currently available/);

  const run = await jsonRequest(view, '/api/heartbeats/run', token, { id: heartbeat.id });
  assert.equal(run.response.status, 200);
  assert.equal(run.value.result.receipt.outcome, 'no-change');
  assert.equal(run.value.heartbeats.heartbeats[0].lastReceipt.outcome, 'no-change');
  assert.equal(inspections, 1);
  assert.equal((await toolEffects.unresolved()).items.length, 0);
  const heartbeatEffects = await toolEffects.history();
  assert.equal(heartbeatEffects.length, 1);
  assert.equal(heartbeatEffects[0].tool, 'inspect_specimen');
  assert.equal(heartbeatEffects[0].origin, 'task-heartbeat');
  assert.equal(heartbeatEffects[0].runDisposition.status, 'committed');
  assert.ok(!requests[0].tools.some(tool => ['load_tool_group', 'unload_tool_group'].includes(tool.function.name)), 'heartbeats get their exact selected tools, never contextual controllers');
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name).sort(), ['inspect_specimen', 'report_task_heartbeat']);
  assert.deepEqual(requests[1].tools.map(tool => tool.function.name).sort(), ['inspect_specimen', 'report_task_heartbeat']);
  assert.match(String(requests[0].messages.findLast(message => message.role === 'user').content), /Synthetic specimen watch/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /ordinary final prose|forgot to use/);
  assert.equal((await data.archive.snapshot()).totals.messages, 0, 'heartbeat prompts and prose never enter chat');

  const inspection = await jsonRequest(view, '/api/heartbeats/inspect', token, { id: heartbeat.id });
  assert.equal(inspection.value.inspection.receipts[0].outcome, 'no-change');
  assert.equal(inspection.value.inspection.versions[0].action, 'created');

  await toolGroups.set('other', 'off');
  const requestCount = requests.length;
  const unavailable = await jsonRequest(view, '/api/heartbeats/run', token, { id: heartbeat.id });
  assert.equal(unavailable.value.result.receipt.outcome, 'failed');
  assert.match(unavailable.value.result.receipt.note, /inspection tools are unavailable/i);
  assert.equal(requests.length, requestCount, 'a hard-off heartbeat tool fails before any provider request');
  const offDefinition = await jsonRequest(view, '/api/heartbeats/create', token, {
    definition: { ...definition, name: 'Hard-off specimen watch' },
  });
  assert.equal(offDefinition.response.status, 400);
  await toolGroups.set('other', 'on-demand');

  const missingReport = await jsonRequest(view, '/api/heartbeats/create', token, {
    definition: { ...definition, name: 'Missing report watch', toolNames: [] },
  });
  const failed = await jsonRequest(view, '/api/heartbeats/run', token, { id: missingReport.value.heartbeat.id });
  assert.equal(failed.response.status, 200);
  assert.equal(failed.value.result.receipt.outcome, 'failed');
  assert.match(failed.value.result.receipt.note, /structured result/);
  assert.deepEqual(requests[2].tools.map(tool => tool.function.name), ['report_task_heartbeat']);
  assert.equal((await data.archive.snapshot()).totals.messages, 0);

  const updated = await jsonRequest(view, '/api/heartbeats/update', token, {
    id: heartbeat.id, expectedRevision: heartbeat.revision, changes: { cadenceHours: 4 },
  });
  assert.equal(updated.value.heartbeat.revision, 2);
  const stale = await jsonRequest(view, '/api/heartbeats/pause', token, { id: heartbeat.id, expectedRevision: 1 });
  assert.equal(stale.response.status, 409);
  const paused = await jsonRequest(view, '/api/heartbeats/pause', token, { id: heartbeat.id, expectedRevision: 2 });
  assert.equal(paused.value.heartbeat.status, 'paused');
  const resumed = await jsonRequest(view, '/api/heartbeats/resume', token, { id: heartbeat.id, expectedRevision: 3 });
  assert.equal(resumed.value.heartbeat.status, 'active');
  const removed = await jsonRequest(view, '/api/heartbeats/remove', token, { id: heartbeat.id, expectedRevision: 4 });
  assert.equal(removed.value.heartbeat.status, 'removed');
  const restored = await jsonRequest(view, '/api/heartbeats/restore', token, { id: heartbeat.id, expectedRevision: 5 });
  assert.equal(restored.value.heartbeat.status, 'paused', 'restore does not silently schedule work');
  const history = await jsonRequest(view, '/api/heartbeats/inspect', token, { id: heartbeat.id });
  assert.deepEqual(history.value.inspection.versions.slice(0, 5).map(version => version.action), ['restored', 'removed', 'resumed', 'paused', 'updated']);
});

test('a goal-measure heartbeat fixes register tools to one exact record and measure', async t => {
  const data = await fixture(t);
  const { createTaskHeartbeatStore } = await import('../src/task-heartbeats.mjs');
  const { createGoalRegister, goalRegisterTools } = await import('../src/goal-register.mjs');
  const heartbeats = await createTaskHeartbeatStore({ file: path.join(data.directory, 'task-heartbeats.json'), clock });
  const goals = await createGoalRegister({ file: path.join(data.directory, 'goals.json'), clock });
  const goalDefinition = name => ({
    kind: 'goal',
    name,
    statement: `Observe ${name} without manufacturing activity.`,
    chosenBy: 'agent',
    source: `Exact synthetic source for ${name}.`,
    beneficiary: '',
    successSignals: 'The named source has an exact observed-through edge.',
    reviewAt: '2030-02-01T00:00:00.000Z',
    returnFrom: null,
    returnBy: null,
    measures: [{ key: 'items', label: 'Items checked', unit: 'items', source: `${name} source`, target: 10, targetCondition: 'at-least' }],
  });
  const boundRecord = await goals.create({ definition: goalDefinition('Bound archive') });
  const otherRecord = await goals.create({ definition: goalDefinition('Other archive') });
  let inspections = 0;
  const tools = createToolRegistry([...goalRegisterTools(goals), {
    name: 'inspect_specimen',
    description: 'Inspect one synthetic test specimen. Do not change it.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() { inspections += 1; return { count: 7, observedThrough: at }; },
  }]);
  const requests = [];
  const replies = [{
    role: 'assistant', content: null,
    tool_calls: [
      { id: 'inspect-bound', type: 'function', function: { name: 'inspect_specimen', arguments: '{}' } },
      { id: 'record-bound', type: 'function', function: { name: 'record_goal_measure', arguments: `{"outcome":"observed","value":7,"observedThrough":"${at}"}` } },
      { id: 'report-bound', type: 'function', function: { name: 'report_task_heartbeat', arguments: '{"outcome":"no-change"}' } },
    ],
  }, { role: 'assistant', content: 'Discarded ordinary prose.' }];
  const provider = Object.freeze({
    id: 'synthetic/bound-heartbeat-provider',
    complete(request) { requests.push(request); return replies.shift(); },
  });
  const view = await startBrowserView({ profile: data.profile, provider, tools, archive: data.archive, heartbeats, goals, clock });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  const definition = {
    name: 'Bound archive watch',
    task: 'Inspect only the selected archive measure.',
    meaningfulChange: 'The selected measure changed materially.',
    completionRule: 'The selected measure reaches its declared target.',
    cadenceHours: 2,
    toolNames: ['inspect_specimen', 'read_goal_or_promise', 'record_goal_measure'],
    binding: { type: 'goal-measure', recordId: boundRecord.id, measureKey: 'items' },
  };
  const created = await jsonRequest(view, '/api/heartbeats/create', token, { definition });
  assert.equal(created.response.status, 200);
  assert.deepEqual(created.value.heartbeat.binding, definition.binding);

  const missingRecord = await jsonRequest(view, '/api/heartbeats/create', token, {
    definition: { ...definition, name: 'Missing record', binding: { ...definition.binding, recordId: `goal-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}` } },
  });
  assert.equal(missingRecord.response.status, 404);
  const missingMeasure = await jsonRequest(view, '/api/heartbeats/create', token, {
    definition: { ...definition, name: 'Missing measure', binding: { ...definition.binding, measureKey: 'missing' } },
  });
  assert.equal(missingMeasure.response.status, 409);
  const missingBoundTool = await jsonRequest(view, '/api/heartbeats/create', token, {
    definition: { ...definition, name: 'Missing bound tool', toolNames: ['read_goal_or_promise'] },
  });
  assert.equal(missingBoundTool.response.status, 400);
  const broadRegisterTool = await jsonRequest(view, '/api/heartbeats/create', token, {
    definition: { ...definition, name: 'Broad register tool', toolNames: [...definition.toolNames, 'change_goal_or_promise_status'] },
  });
  assert.equal(broadRegisterTool.response.status, 400);

  const run = await jsonRequest(view, '/api/heartbeats/run', token, { id: created.value.heartbeat.id });
  assert.equal(run.response.status, 200);
  assert.equal(run.value.result.receipt.outcome, 'no-change');
  assert.equal(inspections, 1);
  const declarations = requests[0].tools;
  assert.deepEqual(declarations.map(tool => tool.function.name).sort(),
    ['inspect_specimen', 'read_goal_or_promise', 'record_goal_measure', 'report_task_heartbeat']);
  const readSchema = declarations.find(tool => tool.function.name === 'read_goal_or_promise').function.parameters;
  const recordSchema = declarations.find(tool => tool.function.name === 'record_goal_measure').function.parameters;
  assert.deepEqual(readSchema.properties, {});
  assert.equal(Object.hasOwn(recordSchema.properties, 'id'), false);
  assert.equal(Object.hasOwn(recordSchema.properties, 'measureKey'), false);
  assert.match(String(requests[0].messages.findLast(message => message.role === 'user').content), new RegExp(boundRecord.id));
  assert.match(String(requests[0].messages.findLast(message => message.role === 'user').content), /identifiers cannot be supplied or changed/);
  assert.equal(goals.inspect(boundRecord.id).checks[0].value, 7);
  assert.equal(goals.inspect(boundRecord.id).checks[0].measureKey, 'items');
  assert.equal(goals.inspect(otherRecord.id).checks.length, 0, 'the wrapper cannot write to another record');
  const escaped = await heartbeats.create({
    definition: {
      ...definition,
      name: 'Programmatic broad binding',
      toolNames: [...definition.toolNames, 'change_goal_or_promise_status'],
    },
  });
  const requestsBeforeEscape = requests.length;
  const refusedEscape = await jsonRequest(view, '/api/heartbeats/run', token, { id: escaped.id });
  assert.equal(refusedEscape.response.status, 200);
  assert.equal(refusedEscape.value.result.receipt.outcome, 'failed');
  assert.match(refusedEscape.value.result.receipt.note, /cannot include unbound register tools/);
  assert.equal(requests.length, requestsBeforeEscape, 'an invalid saved binding never reaches the provider');
  assert.equal(goals.inspect(boundRecord.id).record.status, 'active');
  assert.equal(goals.inspect(otherRecord.id).checks.length, 0);
  await goals.finish({ id: boundRecord.id, expectedRevision: boundRecord.revision, reason: 'Synthetic target reached.' });
  const retained = await jsonRequest(view, '/api/heartbeats/update', token, {
    id: created.value.heartbeat.id,
    expectedRevision: created.value.heartbeat.revision,
    changes: { task: 'Keep the exact closed-record link visible for inspection.' },
  });
  assert.equal(retained.response.status, 200);
  assert.deepEqual(retained.value.heartbeat.binding, definition.binding);
  const closedNewLink = await jsonRequest(view, '/api/heartbeats/create', token, {
    definition: { ...definition, name: 'Closed new link' },
  });
  assert.equal(closedNewLink.response.status, 409, 'new bindings require an active or paused record');
  assert.equal((await data.archive.snapshot()).totals.messages, 0);
});

test('an outside reader sees only its exact frozen records and keeps evidence-linked leads without source writes', async t => {
  const data = await fixture(t);
  const { createOutsideReaderStore } = await import('../src/outside-readers.mjs');
  const { createGoalRegister } = await import('../src/goal-register.mjs');
  const outsideReaders = await createOutsideReaderStore({ file: path.join(data.directory, 'outside-readers.json'), clock });
  const goals = await createGoalRegister({ file: path.join(data.directory, 'goals.json'), clock });
  const selected = await goals.create({
    definition: {
      kind: 'promise',
      name: 'Selected synthetic promise',
      statement: 'SELECTED OUTSIDE READER MARKER must be returned before its exact edge.',
      chosenBy: 'agent',
      source: 'Synthetic exact promise source.',
      beneficiary: 'Synthetic beneficiary',
      successSignals: '',
      reviewAt: null,
      returnFrom: '2029-12-01T00:00:00.000Z',
      returnBy: '2030-01-01T00:00:00.000Z',
      measures: [],
    },
  });
  const unselected = await goals.create({
    definition: {
      kind: 'goal',
      name: 'Unselected synthetic goal',
      statement: 'UNSELECTED OUTSIDE READER MARKER must never cross the review boundary.',
      chosenBy: 'person',
      source: 'Synthetic unselected source.',
      beneficiary: '',
      successSignals: 'The marker stays outside the selected review body.',
      reviewAt: '2030-03-01T00:00:00.000Z',
      returnFrom: null,
      returnBy: null,
      measures: [],
    },
  });
  const requests = [];
  let step = 0;
  const provider = Object.freeze({
    id: 'synthetic/outside-reader-provider',
    complete(request) {
      requests.push(request);
      step += 1;
      if (step === 1) return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'outside-report-1', type: 'function', function: {
            name: 'report_outside_review',
            arguments: JSON.stringify({
              outcome: 'findings',
              findings: [{
                kind: 'broken-promise',
                summary: 'The selected promise is beyond its exact return edge without a completion status.',
                evidence: [{ ref: `record:${selected.id}`, excerpt: '"overdue":true' }],
              }],
            }),
          },
        }],
      };
      if (step === 3) return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'outside-report-invalid', type: 'function', function: {
            name: 'report_outside_review',
            arguments: JSON.stringify({
              outcome: 'findings',
              findings: [{
                kind: 'broken-promise',
                summary: 'This lead cites a record that was not selected.',
                evidence: [{ ref: `record:${unselected.id}`, excerpt: 'UNSELECTED OUTSIDE READER MARKER' }],
              }],
            }),
          },
        }],
      };
      return { role: 'assistant', content: 'Structured review recorded.' };
    },
  });
  const beforeSelected = goals.inspect(selected.id);
  const beforeUnselected = goals.inspect(unselected.id);
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, goals, outsideReaders, clock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.outsideReaders, true);
  assert.deepEqual(boot.outsideReaders.choices.sources.map(row => row.id).sort(), [selected.id, unselected.id].sort());

  const definition = {
    name: 'Exact promise reader',
    focus: 'Look for contradictions and promises whose exact return edge passed without completion evidence.',
    cadenceHours: 24,
    source: { type: 'goal-record-set', recordIds: [selected.id] },
  };
  const created = await jsonRequest(view, '/api/outside-readers/create', token, { definition });
  assert.equal(created.response.status, 200);
  assert.deepEqual(created.value.reader.source.recordIds, [selected.id]);
  const run = await jsonRequest(view, '/api/outside-readers/run', token, { id: created.value.reader.id });
  assert.equal(run.response.status, 200);
  assert.equal(run.value.result.receipt.outcome, 'findings');
  assert.equal(run.value.result.receipt.findings[0].evidence[0].ref, `record:${selected.id}`);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['report_outside_review']);
  const supplied = JSON.stringify(requests[0].messages);
  assert.match(supplied, /SELECTED OUTSIDE READER MARKER/);
  assert.doesNotMatch(supplied, /UNSELECTED OUTSIDE READER MARKER/);
  assert.doesNotMatch(supplied, /PRIVATE SYNTHETIC ROOT SENTINEL|synthetic browser-test register/);
  assert.equal(requests[0].messages.length, 2, 'the review receives one fixed frame and one frozen source message');

  const again = await jsonRequest(view, '/api/outside-readers/run', token, { id: created.value.reader.id });
  assert.equal(again.response.status, 200);
  assert.equal(again.value.result.receipt.outcome, 'source-unchanged');
  assert.equal(requests.length, 2, 'an unchanged semantic source edge skips the provider');
  const inspection = await jsonRequest(view, '/api/outside-readers/inspect', token, { id: created.value.reader.id });
  assert.deepEqual(inspection.value.inspection.receipts.slice(0, 2).map(row => row.outcome), ['source-unchanged', 'findings']);
  assert.equal(inspection.value.inspection.receipts[1].findings[0].summary.includes('return edge'), true);
  const invalid = await jsonRequest(view, '/api/outside-readers/create', token, {
    definition: { ...definition, name: 'Invalid evidence reader', focus: 'Exercise the evidence boundary.' },
  });
  const refused = await jsonRequest(view, '/api/outside-readers/run', token, { id: invalid.value.reader.id });
  assert.equal(refused.response.status, 200);
  assert.equal(refused.value.result.receipt.outcome, 'failed');
  assert.match(refused.value.result.receipt.note, /structured result/);
  const missingId = `goal-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`;
  const savedInvalid = await outsideReaders.create({
    definition: { ...definition, name: 'Missing saved source', source: { type: 'goal-record-set', recordIds: [missingId] } },
  });
  const requestsBeforeMissing = requests.length;
  const missingRun = await jsonRequest(view, '/api/outside-readers/run', token, { id: savedInvalid.id });
  assert.equal(missingRun.response.status, 200);
  assert.equal(missingRun.value.result.receipt.outcome, 'failed');
  assert.equal(requests.length, requestsBeforeMissing, 'an invalid saved source fails before the provider');
  assert.deepEqual(goals.inspect(selected.id), beforeSelected, 'the selected source is read-only');
  assert.deepEqual(goals.inspect(unselected.id), beforeUnselected, 'unselected sources are untouched');
  assert.equal((await data.archive.snapshot()).totals.messages, 0, 'outside review context never enters chat');
});

test('an outside-reader source edge changes when a selected promise crosses its deadline', async t => {
  const data = await fixture(t);
  const { createOutsideReaderStore } = await import('../src/outside-readers.mjs');
  const { createGoalRegister } = await import('../src/goal-register.mjs');
  let now = new Date('2030-01-02T00:00:00.000Z');
  const movingClock = () => new Date(now);
  const outsideReaders = await createOutsideReaderStore({ file: path.join(data.directory, 'outside-edge.json'), clock: movingClock });
  const goals = await createGoalRegister({ file: path.join(data.directory, 'outside-edge-goals.json'), clock: movingClock });
  const promise = await goals.create({
    definition: {
      kind: 'promise', name: 'Clock-edge promise', statement: 'Return after the explicit review window.',
      chosenBy: 'agent', source: 'Synthetic clock-edge source.', beneficiary: 'Synthetic beneficiary',
      successSignals: '', reviewAt: null,
      returnFrom: '2030-01-01T23:00:00.000Z', returnBy: '2030-01-02T01:00:00.000Z', measures: [],
    },
  });
  const requests = [];
  const provider = Object.freeze({
    id: 'synthetic/outside-edge-provider',
    complete(request) {
      requests.push(request);
      return requests.length % 2 === 1
        ? { role: 'assistant', content: null, tool_calls: [{
          id: `edge-${requests.length}`, type: 'function',
          function: { name: 'report_outside_review', arguments: '{"outcome":"no-findings"}' },
        }] }
        : { role: 'assistant', content: 'Review complete.' };
    },
  });
  const view = await startBrowserView({ profile: data.profile, provider, goals, outsideReaders, clock: movingClock });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const created = await jsonRequest(view, '/api/outside-readers/create', token, { definition: {
    name: 'Deadline edge review', focus: 'Notice whether the exact promise is overdue.', cadenceHours: 24,
    source: { type: 'goal-record-set', recordIds: [promise.id] },
  } });
  const first = await jsonRequest(view, '/api/outside-readers/run', token, { id: created.value.reader.id });
  assert.equal(first.value.result.receipt.outcome, 'no-findings');
  assert.equal(requests.length, 2);
  const unchanged = await jsonRequest(view, '/api/outside-readers/run', token, { id: created.value.reader.id });
  assert.equal(unchanged.value.result.receipt.outcome, 'source-unchanged');
  assert.equal(requests.length, 2);
  now = new Date('2030-01-02T02:00:00.000Z');
  const crossed = await jsonRequest(view, '/api/outside-readers/run', token, { id: created.value.reader.id });
  assert.equal(crossed.value.result.receipt.outcome, 'no-findings');
  assert.equal(requests.length, 4, 'crossing the clock edge triggers a new review without a register edit');
  assert.notEqual(crossed.value.result.receipt.source.fingerprint, first.value.result.receipt.source.fingerprint);
  assert.match(String(requests[2].messages.at(-1).content), /"overdue":true/);
});

test('goal register routes keep exact sources, raw measures, conflicts, and recoverable status history', async t => {
  const data = await fixture(t);
  const { createGoalRegister, goalRegisterTools } = await import('../src/goal-register.mjs');
  const goals = await createGoalRegister({ file: path.join(data.directory, 'goals.json'), clock });
  const tools = createToolRegistry(goalRegisterTools(goals));
  const view = await startBrowserView({ profile: data.profile, tools, archive: data.archive, goals, clock });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.goals, true);
  assert.equal(boot.goals.records.length, 0);
  assert.ok(boot.health.tools.some(tool => tool.name === 'record_goal_measure'));

  const definition = {
    kind: 'goal',
    name: 'Synthetic archive tending',
    statement: 'Tend the selected synthetic archive without manufacturing activity.',
    chosenBy: 'agent',
    source: 'Exact synthetic choice in conversation specimen-7.',
    beneficiary: '',
    successSignals: 'Every selected item has an exact source edge.',
    reviewAt: '2030-02-01T00:00:00.000Z',
    returnFrom: null,
    returnBy: null,
    measures: [{ key: 'items', label: 'Items checked', unit: 'items', source: 'Synthetic archive index', target: 10, targetCondition: 'at-least' }],
  };
  const created = await jsonRequest(view, '/api/goals/create', token, { definition });
  assert.equal(created.response.status, 200);
  const record = created.value.record;
  assert.equal(record.source, definition.source);
  assert.equal(created.value.goals.records.length, 1);

  const blurred = await jsonRequest(view, '/api/goals/create', token, { definition: { ...definition, kind: 'reminder', name: 'Not a goal' } });
  assert.equal(blurred.response.status, 400);
  assert.match(blurred.value.error, /kind must be goal or promise/);

  const measured = await jsonRequest(view, '/api/goals/record', token, {
    id: record.id, measureKey: 'items', outcome: 'observed', value: 3, observedThrough: '2030-01-02T00:00:00.000Z',
  });
  assert.equal(measured.response.status, 200);
  assert.equal(measured.value.record.statistics[0].latest.value, 3);
  assert.equal(measured.value.record.statistics[0].source, 'Synthetic archive index');
  const conflict = await jsonRequest(view, '/api/goals/record', token, {
    id: record.id, measureKey: 'items', outcome: 'observed', value: 4, observedThrough: '2030-01-02T00:00:00.000Z',
  });
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.value.error, /different check/);

  const inspection = await jsonRequest(view, '/api/goals/inspect', token, { id: record.id });
  assert.equal(inspection.value.inspection.checks[0].source, 'Synthetic archive index');
  assert.equal(inspection.value.inspection.versions[0].action, 'created');
  assert.equal((await data.archive.snapshot()).totals.messages, 0, 'register management never enters conversation history');

  const updated = await jsonRequest(view, '/api/goals/update', token, {
    id: record.id, expectedRevision: 1, changes: { reviewAt: '2030-03-01T00:00:00.000Z' },
  });
  assert.equal(updated.value.record.revision, 2);
  const stale = await jsonRequest(view, '/api/goals/pause', token, { id: record.id, expectedRevision: 1 });
  assert.equal(stale.response.status, 409);
  const paused = await jsonRequest(view, '/api/goals/pause', token, { id: record.id, expectedRevision: 2 });
  const resumed = await jsonRequest(view, '/api/goals/resume', token, { id: record.id, expectedRevision: paused.value.record.revision });
  const retired = await jsonRequest(view, '/api/goals/retire', token, {
    id: record.id, expectedRevision: resumed.value.record.revision, reason: 'The agent deliberately chose to stop.',
  });
  assert.equal(retired.value.record.status, 'retired');
  const removed = await jsonRequest(view, '/api/goals/remove', token, { id: record.id, expectedRevision: retired.value.record.revision });
  const restored = await jsonRequest(view, '/api/goals/restore', token, { id: record.id, expectedRevision: removed.value.record.revision });
  assert.equal(restored.value.record.status, 'retired', 'restore does not revive retired work');
  const history = await jsonRequest(view, '/api/goals/inspect', token, { id: record.id });
  assert.deepEqual(history.value.inspection.versions.slice(0, 6).map(version => version.action),
    ['restored', 'removed', 'retired', 'resumed', 'paused', 'updated']);
});

test('a check-in never appends to an archived conversation even when it was opened last', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'active-only-check-ins.json') });
  const provider = {
    id: 'synthetic/active-only-check-in',
    complete(request) {
      const note = String(request.messages.findLast(message => message.role === 'user')?.content ?? '');
      return {
        role: 'assistant',
        content: note.startsWith('[Fieldwork check-in') ? 'I found the active conversation.' : 'Saved ordinary chat.',
      };
    },
  };
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, checkIns, clock });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  const activeId = boot.conversationId;
  await jsonRequest(view, '/api/chat', token, { text: 'keep this active', conversationId: activeId });
  const fresh = await jsonRequest(view, '/api/conversations/new', token, {});
  const archivedId = fresh.value.conversationId;
  const second = await jsonRequest(view, '/api/chat', token, { text: 'archive this one', conversationId: archivedId });
  const beforeArchive = second.value.conversations.find(row => row.id === archivedId);
  const archived = await jsonRequest(view, '/api/conversations/archive', token, {
    id: archivedId, archived: true, expectedRevision: beforeArchive.lifecycleRevision,
  });
  assert.equal(archived.value.conversationId, activeId);
  await jsonRequest(view, '/api/conversations/open', token, { id: archivedId });

  const sent = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(sent.response.status, 200);
  assert.equal(sent.value.outcome, 'sent');
  assert.equal(sent.value.conversationId, activeId);
  assert.equal(sent.value.conversation.messages.at(-1).display, 'I found the active conversation.');
  const archivedMessages = await jsonRequest(view, '/api/conversations/open', token, { id: archivedId });
  assert.deepEqual(archivedMessages.value.conversation.messages.map(message => message.display), [
    'archive this one', 'Saved ordinary chat.',
  ]);
  assert.equal(archivedMessages.value.conversations.find(row => row.id === archivedId).archived, true);
});

test('automatic check-ins run with no browser page connected', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  let now = Date.parse('2030-01-02T12:00:00.000Z');
  const movingClock = () => new Date(now);

  const seededStore = await createConversationStore({ archive: data.archive, clock: movingClock });
  const seeded = seededStore.create();
  await seededStore.commit(seeded.id, [
    { role: 'user', content: 'Keep watch while the room page is closed.' },
    { role: 'assistant', content: 'I can leave a note here later.' },
  ]);

  const checkIns = await createCheckInStore({
    file: path.join(data.directory, 'closed-page-check-ins.json'),
    clock: movingClock,
  });
  await checkIns.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  let providerCalls = 0;
  const provider = Object.freeze({
    id: 'synthetic/closed-page-check-in',
    complete() {
      providerCalls += 1;
      return { role: 'assistant', content: 'This note arrived while no room page was connected.' };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, checkIns, clock: movingClock,
  });
  t.after(() => view.close());

  // No launch authorization, bootstrap, HTTP request, or browser page exists yet.
  now += 61 * 60_000;
  t.mock.timers.tick(60_000);
  await waitForCondition(() => checkIns.view().history.length >= 1, 'closed-page check-in history did not settle');
  assert.equal(providerCalls, 1);
  assert.deepEqual(checkIns.view().history.map(row => [row.kind, row.outcome, row.conversationId]), [
    ['check-in', 'sent', seeded.id],
  ]);

  // The first page connection only observes the note the server already saved.
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.conversationId, seeded.id);
  assert.equal(boot.conversation.messages.at(-2).kind, 'check-in');
  assert.equal(boot.conversation.messages.at(-1).display, 'This note arrived while no room page was connected.');
});

test('automatic external check-ins use only the saved bound conversation and leave cadence due when it disappears', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  let now = Date.parse('2030-01-02T12:00:00.000Z');
  const movingClock = () => new Date(now);

  const seededStore = await createConversationStore({ archive: data.archive, clock: movingClock });
  const seeded = seededStore.create();
  await seededStore.commit(seeded.id, [
    { role: 'user', content: 'The saved Telegram conversation.' },
    { role: 'assistant', content: 'I will use this exact thread if it stays bound.' },
  ]);
  const checkIns = await createCheckInStore({
    file: path.join(data.directory, 'external-closed-page-check-ins.json'),
    clock: movingClock,
  });
  await checkIns.update({
    enabled: true,
    everyHours: 1,
    destination: 'telegram',
    quiet: { enabled: false },
  });
  let bindingAvailable = true;
  let targetChecks = 0;
  let providerCalls = 0;
  const deliveries = [];
  const checkInBridge = Object.freeze({
    proactiveTarget(platform) {
      targetChecks += 1;
      assert.equal(platform, 'telegram');
      return bindingAvailable ? { conversationId: seeded.id } : null;
    },
    async deliverProactive(input) {
      deliveries.push(input);
      return { actionId: 'delivery:scheduled-check-in', decision: 'allow', outcome: 'platform-accepted' };
    },
  });
  const provider = Object.freeze({
    id: 'synthetic/scheduled-external-check-in',
    complete() {
      providerCalls += 1;
      return { role: 'assistant', content: 'One scheduled Telegram note.' };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, checkIns, checkInBridge, clock: movingClock,
  });
  t.after(() => view.close());

  // No page or browser authorization exists: the server-side scheduler owns this path.
  now += 61 * 60_000;
  t.mock.timers.tick(60_000);
  await waitForCondition(() => checkIns.view().history.length >= 1, 'external check-in history did not settle');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerCalls, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].conversationId, seeded.id);
  assert.equal(deliveries[0].sourceMessageId, 'm000004');
  assert.equal(deliveries[0].output.source.conversationId, seeded.id);
  assert.equal(deliveries[0].output.source.messageId, 'm000004');
  assert.equal(deliveries[0].output.text, 'One scheduled Telegram note.');
  assert.deepEqual(checkIns.view().history.map(row => [row.outcome, row.conversationId, row.note]), [
    ['sent', seeded.id, 'Delivered to Telegram.'],
  ]);

  bindingAvailable = false;
  const checksBeforeMissingBinding = targetChecks;
  now += 61 * 60_000;
  t.mock.timers.tick(60_000);
  await waitForCondition(
    () => targetChecks > checksBeforeMissingBinding,
    'the later due tick did not check the current bridge binding',
  );
  assert.ok(targetChecks > checksBeforeMissingBinding, 'the later due tick checked the current binding');
  await checkIns.reapExpiredClaim();
  assert.equal(providerCalls, 1, 'a missing saved binding stops before model work');
  assert.equal(deliveries.length, 1, 'a missing saved binding never reaches transport');
  assert.equal(checkIns.view().history.length, 1, 'suppression does not invent a failed visit');
  assert.equal(checkIns.due({ timeZone: 'UTC' }), 'check-in', 'the missing binding does not consume cadence');
});

test('an external check-in destination fails closed before model work and delivers only the exact saved reply', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'external-check-ins.json') });
  let boundConversationId = null;
  let failDelivery = false;
  let deliveryOutcome = 'platform-accepted';
  let changeDestinationDuringRun = false;
  let providerCalls = 0;
  const deliveries = [];
  const checkInBridge = {
    proactiveTarget(platform) {
      assert.equal(platform, 'telegram');
      return boundConversationId ? { conversationId: boundConversationId } : null;
    },
    async deliverProactive(input) {
      deliveries.push(input);
      if (failDelivery) throw new Error('synthetic transport failure');
      return { actionId: 'delivery:synthetic-check-in', decision: 'allow', outcome: deliveryOutcome };
    },
  };
  const provider = Object.freeze({
    id: 'synthetic/external-check-in',
    async complete() {
      providerCalls += 1;
      if (changeDestinationDuringRun) await checkIns.update({ destination: 'room' });
      return { role: 'assistant', content: `bridge check-in ${providerCalls}` };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, checkIns, checkInBridge, clock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  await jsonRequest(view, '/api/checkins/update', token, { settings: { destination: 'telegram' } });

  const unavailable = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(unavailable.response.status, 200);
  assert.equal(unavailable.value.outcome, 'failed');
  assert.match(unavailable.value.note, /not ready with a saved active conversation/);
  assert.equal(providerCalls, 0, 'an unavailable route fails before model work');
  assert.equal(deliveries.length, 0);

  boundConversationId = boot.conversationId;
  const sent = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(sent.value.outcome, 'sent');
  assert.equal(sent.value.delivery.platform, 'telegram');
  assert.equal(sent.value.delivery.outcome, 'platform-accepted');
  assert.equal(sent.value.note, 'Delivered to Telegram.');
  assert.equal(sent.value.checkIns.history[0].note, 'Delivered to Telegram.');
  assert.equal(providerCalls, 1);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(Object.keys(deliveries[0]).sort(), ['conversationId', 'output', 'platform', 'sourceMessageId']);
  assert.equal(deliveries[0].conversationId, boundConversationId);
  assert.equal(deliveries[0].sourceMessageId, 'm000002');
  assert.equal(deliveries[0].output.format, BRIDGE_OUTPUT_FORMAT);
  assert.equal(deliveries[0].output.text, 'bridge check-in 1');
  assert.equal(deliveries[0].output.source.messageId, deliveries[0].sourceMessageId);
  assert.equal(deliveries[0].output.source.contentSha256, hash(deliveries[0].output.text));
  assert.equal(Object.hasOwn(deliveries[0], 'destinationId'), false, 'browser code never supplies route authority');

  changeDestinationDuringRun = true;
  const revoked = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(revoked.value.outcome, 'sent', 'the locally saved check-in remains sent');
  assert.match(revoked.value.note, /turned off or redirected before delivery/);
  assert.equal(deliveries.length, 1, 'changing the destination during model work revokes the external send');

  changeDestinationDuringRun = false;
  await jsonRequest(view, '/api/checkins/update', token, { settings: { destination: 'telegram' } });
  deliveryOutcome = 'partially-accepted';
  const partialDelivery = await jsonRequest(view, '/api/checkins/now', token, { kind: 'postcard' });
  assert.equal(partialDelivery.value.outcome, 'sent', 'the exact local reply remains saved');
  assert.equal(partialDelivery.value.delivery.actionId, 'delivery:synthetic-check-in');
  assert.equal(partialDelivery.value.delivery.outcome, 'partially-accepted');
  assert.match(partialDelivery.value.note, /delivery is partially-accepted/);

  deliveryOutcome = 'not-attempted';
  const notAttempted = await jsonRequest(view, '/api/checkins/now', token, { kind: 'postcard' });
  assert.equal(notAttempted.value.outcome, 'sent', 'the local reply remains saved before an attempt-marker failure');
  assert.equal(notAttempted.value.delivery.actionId, 'delivery:synthetic-check-in');
  assert.equal(notAttempted.value.delivery.decision, 'allow');
  assert.equal(notAttempted.value.delivery.outcome, 'not-attempted');
  assert.equal(notAttempted.value.note, 'Saved here; Telegram delivery was not attempted.');

  failDelivery = true;
  const failedDelivery = await jsonRequest(view, '/api/checkins/now', token, { kind: 'postcard' });
  assert.equal(failedDelivery.value.outcome, 'sent', 'the locally saved postcard remains sent');
  assert.equal(failedDelivery.value.delivery.outcome, 'failed');
  assert.match(failedDelivery.value.note, /Saved here; Telegram delivery failed/);
  assert.equal(providerCalls, 5, 'transport failure never regenerates the model reply');
  assert.equal(deliveries.length, 4);
});

test('scheduled check-ins choose the newest allowed conversation and all-off leaves the cadence untouched', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  let now = Date.parse('2030-01-02T12:00:00.000Z');
  const movingClock = () => new Date(now);
  const storedCheckIns = await createCheckInStore({
    file: path.join(data.directory, 'conversation-policy-check-ins.json'),
    clock: movingClock,
  });
  let completedReaps = 0;
  const checkIns = Object.freeze({
    ...storedCheckIns,
    async reapExpiredClaim() {
      const result = await storedCheckIns.reapExpiredClaim();
      completedReaps += 1;
      return result;
    },
  });
  await checkIns.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  let checkInCalls = 0;
  const waitForHistory = async count => {
    await waitForCondition(
      () => checkIns.view().history.length >= count,
      `check-in history did not reach ${count} rows`,
    );
  };
  const waitForReaps = async count => {
    await waitForCondition(
      () => completedReaps >= count,
      `suppressed scheduler maintenance did not complete ${count} time(s)`,
    );
  };
  const provider = Object.freeze({
    id: 'synthetic/conversation-policy-check-in',
    complete(request) {
      const note = String(request.messages.findLast(message => message.role === 'user')?.content ?? '');
      if (note.startsWith('[Fieldwork check-in')) {
        checkInCalls += 1;
        return { role: 'assistant', content: `scheduled note ${checkInCalls}` };
      }
      return { role: 'assistant', content: 'ordinary reply' };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, checkIns, clock: movingClock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  const olderId = boot.conversationId;
  await jsonRequest(view, '/api/chat', token, { text: 'older', conversationId: olderId });
  now += 1_000;
  const fresh = await jsonRequest(view, '/api/conversations/new', token, {});
  const newerId = fresh.value.conversationId;
  const newer = await jsonRequest(view, '/api/chat', token, { text: 'newer', conversationId: newerId });
  assert.deepEqual(
    newer.value.conversations.filter(row => !row.archived).map(row => row.id).slice(0, 2),
    [newerId, olderId],
    'the suppressed specimen is truly the newest active conversation',
  );
  const newerRow = newer.value.conversations.find(row => row.id === newerId);
  await jsonRequest(view, '/api/conversations/proactive', token, {
    id: newerId, mode: 'suppress', expectedRevision: newerRow.proactiveRevision,
  });

  now += 61 * 60_000;
  t.mock.timers.tick(60_000);
  await waitForHistory(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checkInCalls, 1);
  assert.equal(checkIns.view().history[0].conversationId, olderId, 'the newer suppressed conversation is skipped');

  const afterScheduled = (await bootstrapRequest(view, token)).value;
  const olderRow = afterScheduled.conversations.find(row => row.id === olderId);
  const allOff = await jsonRequest(view, '/api/conversations/proactive', token, {
    id: olderId, mode: 'suppress', expectedRevision: olderRow.proactiveRevision,
  });
  assert.equal(allOff.response.status, 200, allOff.value.error);
  const conversationIdsBeforeAllOff = allOff.value.conversations.map(row => row.id).sort();
  now += 61 * 60_000;
  const beforeAllOff = checkIns.view();
  t.mock.timers.tick(60_000);
  await waitForReaps(1);
  assert.equal(checkInCalls, 1, 'no provider call is made when every active conversation is off');
  assert.equal(checkIns.view().claim, null);
  assert.deepEqual(checkIns.view().history, beforeAllOff.history);
  assert.equal(checkIns.due({ timeZone: 'UTC' }), 'check-in', 'the scheduled edge remains due');

  await checkIns.update({ postcard: { enabled: true, at: '00:00' } });
  assert.equal(checkIns.due({ timeZone: 'UTC' }), 'postcard');
  const beforeSuppressedPostcard = checkIns.view();
  t.mock.timers.tick(60_000);
  await waitForReaps(2);
  assert.equal(checkInCalls, 1, 'a due postcard also stops before the provider');
  assert.equal(checkIns.view().claim, null);
  assert.deepEqual(checkIns.view().history, beforeSuppressedPostcard.history);
  assert.equal(checkIns.due({ timeZone: 'UTC' }), 'postcard', 'suppression does not consume the local postcard day');
  const afterAllOff = (await bootstrapRequest(view, token)).value;
  assert.deepEqual(afterAllOff.conversations.map(row => row.id).sort(), conversationIdsBeforeAllOff,
    'an all-off scheduler tick does not create a conversation');

  for (const kind of ['check-in', 'postcard', 'free-time']) {
    const manual = await jsonRequest(view, '/api/checkins/now', token, { kind });
    assert.equal(manual.response.status, 200);
    assert.equal(manual.value.outcome, 'sent');
    assert.equal(manual.value.conversationId, olderId, `a person-triggered ${kind} bypasses the automatic policy`);
  }
  assert.equal(checkInCalls, 2);
});

test('incoming browser and bridge turns cannot steal the provider while a scheduled claim is being saved', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  let now = Date.parse('2030-01-02T12:00:00.000Z');
  const movingClock = () => new Date(now);
  const base = await createCheckInStore({
    file: path.join(data.directory, 'claim-gap-check-ins.json'),
    clock: movingClock,
  });
  await base.update({ enabled: true, everyHours: 1, quiet: { enabled: false } });
  let releaseClaim;
  let enteredClaim;
  const claimEntered = new Promise(resolve => { enteredClaim = resolve; });
  const checkIns = Object.freeze({
    ...base,
    async claimDue(options) {
      enteredClaim();
      await new Promise(resolve => { releaseClaim = resolve; });
      return base.claimDue(options);
    },
  });
  let providerCalls = 0;
  let modelChoices = 0;
  const provider = Object.freeze({
    id: 'synthetic/claim-gap',
    complete() { providerCalls += 1; return { role: 'assistant', content: 'The scheduled visit survived.' }; },
  });
  const models = {
    current: 'alpha',
    async list() { return [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }]; },
    async choose() { modelChoices += 1; return provider; },
  };
  const view = await startBrowserView({
    profile: data.profile, provider, models, archive: data.archive, checkIns, clock: movingClock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  now += 61 * 60_000;
  t.mock.timers.tick(60_000);
  await claimEntered;

  const chat = await jsonRequest(view, '/api/chat', token, {
    text: 'Do not steal the pending wake.', conversationId: boot.conversationId,
  });
  assert.equal(chat.response.status, 429);
  const selected = boot.conversations.find(row => row.id === boot.conversationId);
  const archive = await jsonRequest(view, '/api/conversations/archive', token, {
    id: boot.conversationId, archived: true, expectedRevision: selected.lifecycleRevision,
  });
  assert.equal(archive.response.status, 429);
  const suppress = await jsonRequest(view, '/api/conversations/proactive', token, {
    id: boot.conversationId, mode: 'suppress', expectedRevision: selected.proactiveRevision,
  });
  assert.equal(suppress.response.status, 429);
  const switched = await jsonRequest(view, '/api/model', token, { id: 'beta' });
  assert.equal(switched.response.status, 409);
  assert.equal(modelChoices, 0, 'the model host is not entered during the durable-claim gap');
  const conversationsBeforeBridge = boot.conversations.map(row => row.id).sort();
  await assert.rejects(view.receiveExternalMessage({
    platform: 'telegram',
    destinationId: '123456789',
    sourceUserId: '987654321',
    sourceMessageId: '42',
    at: new Date(now).toISOString(),
    text: 'This bridge turn should wait too.',
    conversationId: null,
  }), error => error?.status === 429 && /check-in is choosing or using/i.test(error.message));
  const afterBridge = (await bootstrapRequest(view, token)).value;
  assert.deepEqual(afterBridge.conversations.map(row => row.id).sort(), conversationsBeforeBridge,
    'an unbound first bridge turn cannot leave an empty conversation behind the fence');
  assert.equal(providerCalls, 0);

  releaseClaim();
  await waitForCondition(
    () => base.view().history.length > 0,
    'the scheduled check-in did not settle after its claim barrier opened',
  );
  assert.equal(providerCalls, 1);
  assert.equal(base.view().history[0].outcome, 'sent');
  assert.equal(base.view().history[0].conversationId, boot.conversationId);
});

test('a check-in can stay quiet, or leave a message the page shows under a small divider', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const { createToolGroupSettings } = await import('../src/tool-groups.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'check-ins.json') });
  const toolGroups = await createToolGroupSettings({ file: path.join(data.directory, 'check-in-tool-groups.json') });
  await toolGroups.set('clock', 'on-demand');
  const tools = createToolRegistry([{
    name: 'what_time_is_it', description: 'Return one synthetic check-in time.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ iso: at }),
  }]);
  const seen = [];
  let visit = 0;
  const provider = Object.freeze({
    id: 'synthetic/checker',
    complete(request) {
      seen.push(request);
      if (request.step === 1) visit += 1;
      if (visit === 1) return { role: 'assistant', content: '[quiet]' };
      if (request.step === 1) {
        return { role: 'assistant', content: null, tool_calls: [{ id: 'load-clock', type: 'function', function: { name: 'load_tool_group', arguments: '{"group":"clock"}' } }] };
      }
      return { role: 'assistant', content: 'I found a new moss species in my notes!' };
    },
  });
  const view = await startBrowserView({ profile: data.profile, provider, tools, toolGroups, archive: data.archive, checkIns, fieldworkDir: path.join(data.directory, 'fieldworks') });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = await bootstrapRequest(view, token);
  assert.equal(boot.value.capabilities.checkIns, true);
  assert.equal(boot.value.checkIns.settings.enabled, false);

  const quiet = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(quiet.response.status, 200);
  assert.equal(quiet.value.outcome, 'quiet');
  assert.equal(quiet.value.checkIns.history[0].outcome, 'quiet');
  const note = seen[0].messages.findLast(message => message.role === 'user');
  assert.match(String(note.content), /This is not the person writing/);
  assert.match(String(note.content), /asked you to check in now/);
  assert.doesNotMatch(String(note.content), /schedule the person chose/);
  assert.ok(!seen[0].tools.some(tool => tool.function.name === 'start_fieldwork'), 'no Fieldwork tool unless the person allows it');

  await jsonRequest(view, '/api/checkins/update', token, { settings: { fieldworks: true } });
  const sent = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(sent.value.outcome, 'sent');
  assert.ok(seen[1].tools.some(tool => tool.function.name === 'start_fieldwork'), 'allowed now');
  assert.ok(!seen[1].tools.some(tool => tool.function.name === 'what_time_is_it'), 'on-demand clock starts undeclared');
  assert.ok(seen[1].tools.some(tool => tool.function.name === 'load_tool_group'));
  assert.match(JSON.stringify(seen[1].messages), /Clock \(clock\) — on-demand: what_time_is_it/);
  assert.ok(seen[2].tools.some(tool => tool.function.name === 'start_fieldwork'), 'run-only Fieldwork remains resident after a contextual load');
  assert.ok(seen[2].tools.some(tool => tool.function.name === 'what_time_is_it'), 'clock is declared on the next step only');
  const shown = sent.value.conversation.messages;
  assert.equal(shown.at(-2).kind, 'check-in', 'the room note shows as a divider');
  assert.equal(shown.at(-2).display, '');
  assert.equal(shown.at(-1).display, 'I found a new moss species in my notes!');
  assert.equal(sent.value.checkIns.latest.conversationId, sent.value.conversationId);
  assert.equal(sent.value.conversations.find(row => row.id === sent.value.conversationId).title, 'Your agent checked in');

  const refused = await jsonRequest(view, '/api/checkins/update', token, { settings: { everyHours: 7 } });
  assert.equal(refused.response.status, 400);
});

test('an Ask policy refuses unattended check-in tools without leaving an approval behind', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'permission-check-ins.json') });
  const toolPermissions = await createToolPermissionStore({ file: path.join(data.directory, 'permission-check-in-tools.json'), clock });
  await toolPermissions.setPolicy({ tool: 'autonomous_effect', mode: 'ask', expectedRevision: 0 });
  let effects = 0;
  const tools = createToolRegistry([{
    name: 'autonomous_effect', description: 'Perform one synthetic unattended effect.',
    permissionSummary: () => 'Perform one synthetic unattended effect.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { effects++; return true; },
  }]);
  const provider = Object.freeze({
    id: 'synthetic/permission-check-in',
    complete(request) {
      if (request.step === 1) return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'unattended', type: 'function', function: { name: 'autonomous_effect', arguments: '{}' } }],
      };
      const result = JSON.parse(request.messages.at(-1).content);
      assert.equal(result.permission.reason, 'approval-unavailable');
      return { role: 'assistant', content: '[quiet]' };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, checkIns, tools, toolPermissions,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const result = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.outcome, 'quiet');
  assert.equal(effects, 0);
  assert.equal(toolPermissions.view().pending.length, 0);
});

test('a recovered check-in claim stays visible and fences manual wakes without exposing its token', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'claimed-check-ins.json') });
  const claimed = await checkIns.claimNow('check-in', { timeZone: 'UTC' });
  const provider = Object.freeze({ id: 'synthetic/claimed-check-in', complete: () => ({ role: 'assistant', content: 'must not run' }) });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, checkIns });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  const bootstrap = (await bootstrapRequest(view, token)).value;
  assert.equal(bootstrap.checkIns.running, true);
  assert.deepEqual(bootstrap.checkIns.claim, {
    kind: 'check-in',
    runKind: 'manual',
    claimedAt: claimed.claim.claimedAt,
    expiresAt: claimed.claim.expiresAt,
  });
  assert.equal(Object.hasOwn(bootstrap.checkIns.claim, 'token'), false);

  const refused = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(refused.response.status, 429);
  assert.match(refused.value.error, /already claimed or running/);
});

test('free time has no task, and a quiet visit leaves no conversation or check-in history', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'free-time-check-ins.json') });
  const replies = ['[quiet]', 'I chose to leave this small note.'];
  const seen = [];
  const provider = Object.freeze({
    id: 'synthetic/free-time',
    complete(request) { seen.push(request); return { role: 'assistant', content: replies.shift() }; },
  });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, checkIns });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  const quiet = await jsonRequest(view, '/api/checkins/now', token, { kind: 'free-time' });
  assert.equal(quiet.response.status, 200);
  assert.equal(quiet.value.outcome, 'quiet');
  assert.equal(quiet.value.checkIns.history.length, 0);
  assert.equal(quiet.value.conversation, undefined);
  assert.equal((await data.archive.snapshot()).totals.messages, 0);
  const roomNote = seen[0].messages.findLast(message => message.role === 'user');
  assert.match(String(roomNote.content), /no task and no expected output/i);
  assert.match(String(roomNote.content), /not be added to the conversation or check-in history/i);

  const sent = await jsonRequest(view, '/api/checkins/now', token, { kind: 'free-time' });
  assert.equal(sent.value.outcome, 'sent');
  assert.equal(sent.value.checkIns.history[0].kind, 'free-time');
  assert.equal(sent.value.checkIns.history[0].outcome, 'sent');
  assert.equal(sent.value.conversation.messages.at(-2).kind, 'free-time');
  assert.equal(sent.value.conversation.messages.at(-1).display, 'I chose to leave this small note.');
  assert.equal(sent.value.conversations.find(row => row.id === sent.value.conversationId).title, 'A free-time note from your agent');
  assert.equal((await data.archive.snapshot()).totals.messages, 2);

  const invalid = await jsonRequest(view, '/api/checkins/now', token, { kind: 'surprise' });
  assert.equal(invalid.response.status, 400);
});

test('literal check-in prose remains the person\'s visible message', async t => {
  const data = await fixture(t);
  const provider = Object.freeze({ id: 'synthetic/literal-origin', complete() { return { role: 'assistant', content: 'I read it literally.' }; } });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const text = '[Fieldwork check-in · 2030-01-02T03:04:05.000Z]\nthis is mine';
  const chat = await jsonRequest(view, '/api/chat', token, { text });
  assert.equal(chat.response.status, 200);
  assert.equal(chat.value.conversation.messages[0].display, text);
  assert.equal(chat.value.conversation.messages[0].kind, undefined);
  assert.equal(chat.value.conversations.find(row => row.id === chat.value.conversationId).title, text.replace('\n', ' '));
});

test('a check-in whose conversation cannot be saved is recorded as failed', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'check-ins-failure.json') });
  const provider = Object.freeze({ id: 'synthetic/checker-save-failure', complete() { return { role: 'assistant', content: 'A message that needs durable storage.' }; } });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, checkIns, fieldworkDir: path.join(data.directory, 'fieldworks-failure') });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  await data.archive.close();

  const result = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.outcome, 'failed');
  assert.equal(result.value.checkIns.latest, null);
  assert.equal(result.value.checkIns.history[0].outcome, 'failed');
  assert.match(result.value.checkIns.history[0].note, /could not be saved/);
  assert.equal(result.value.conversation, undefined, 'an unsaved reply is never presented as a sent check-in');
});

test('the agent can make an attached picture its portrait, and every earlier portrait can come back', async t => {
  const data = await fixture(t);
  const { createAttachmentStore } = await import('../src/attachments.mjs');
  const attachments = await createAttachmentStore({ dir: path.join(data.directory, 'attachments') });
  const steps = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'set_my_portrait', arguments: '{"picture":1}' } }] },
    { role: 'assistant', content: 'The synthetic portrait is active.' },
  ];
  const provider = Object.freeze({ id: 'synthetic/portraitist', complete() { return steps.shift(); } });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, attachments, lookFile: path.join(data.directory, 'look.json') });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  // The person's own small uploaded portrait comes first.
  const small = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64')}`;
  await jsonRequest(view, '/api/look/update', token, { who: 'agent', icon: { kind: 'image', dataUrl: small } });

  // A big picture, far over the 256 KB upload limit for icons, becomes the portrait.
  const portraitPng = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(900 * 1024, 5)]).toString('base64')}`;
  const chat = await jsonRequest(view, '/api/chat', token, { text: 'use this synthetic portrait', attachments: [{ name: 'synthetic-portrait.png', dataUrl: portraitPng }] });
  assert.equal(chat.response.status, 200);
  const agent = chat.value.look.agent;
  assert.equal(agent.icon.kind, 'picture');
  assert.equal(agent.iconBy, 'agent');
  assert.equal(agent.iconHistory.length, 1);
  assert.equal(agent.iconHistory[0].icon.kind, 'picture', 'the old uploaded portrait moved into the picture store');
  assert.equal(agent.iconHistory[0].by, 'person');
  assert.doesNotMatch(JSON.stringify(chat.value.look), /base64/, 'look stays small');

  // The person undoes it; the synthetic portrait is kept in turn.
  const undone = await jsonRequest(view, '/api/look/restore', token, { who: 'agent', index: 0 });
  assert.equal(undone.response.status, 200);
  assert.equal(undone.value.look.agent.iconBy, 'person');
  assert.equal(undone.value.look.agent.iconHistory[0].icon.ref, agent.icon.ref);
  const missing = await jsonRequest(view, '/api/look/restore', token, { who: 'agent', index: 5 });
  assert.equal(missing.response.status, 404);
});

test('the change log records who changed what, and the person can undo an agent change', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const { createExpressionStore } = await import('../src/expression.mjs');
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'changes.json') });
  const expression = await createExpressionStore({ file: path.join(data.directory, 'expression.json') });
  const steps = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'm1', type: 'function', function: { name: 'set_my_pronouns', arguments: '{"pronouns":"she/her"}' } }] },
    { role: 'assistant', content: 'Done.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'review_changes', arguments: '{"key":"look.agent.pronouns","limit":5}' } }] },
    { role: 'assistant', content: 'I checked the live value.' },
  ];
  const seen = [];
  const appearanceSaves = [];
  const provider = Object.freeze({ id: 'synthetic/changer', complete(request) { seen.push(request); return steps.shift(); } });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, expression, changeLog,
    lookFile: path.join(data.directory, 'look.json'),
    onAppearanceChange: async receipt => { appearanceSaves.push(receipt); },
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const initial = (await bootstrapRequest(view, token)).value;
  assert.equal(initial.capabilities.changes, true);
  const initialConversation = initial.conversations.find(row => row.id === initial.conversationId);
  const titled = await jsonRequest(view, '/api/conversations/rename', token, {
    id: initial.conversationId,
    title: 'Synthetic room notes',
    expectedRevision: initialConversation.titleRevision,
  });
  assert.equal(titled.response.status, 200);
  const conversationAfterTitle = titled.value.conversations.find(row => row.id === initial.conversationId);
  const automaticStopped = await jsonRequest(view, '/api/conversations/proactive', token, {
    id: initial.conversationId,
    mode: 'suppress',
    expectedRevision: conversationAfterTitle.proactiveRevision,
  });
  assert.equal(automaticStopped.response.status, 200);

  // The person adds a mood in Settings; the agent changes its pronouns in a reply.
  await jsonRequest(view, '/api/expression/mood/define', token, { name: 'calm', description: 'settled', icon: null, color: 'sky' });
  await jsonRequest(view, '/api/appearance', token, { expectedRevision: 0, changes: { palette: 'amber', density: 'dense', textSize: 'large', texture: 'dither' } });
  const renamed = await jsonRequest(view, '/api/look/update', token, { who: 'person', name: 'Synthetic Person' });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.value.look.person.nameBy, 'person');
  await jsonRequest(view, '/api/chat', token, { text: 'pick pronouns' });
  const before = await jsonRequest(view, '/api/changes/view', token, {});
  assert.equal(before.response.status, 200);
  const pronouns = before.value.entries.find(entry => entry.key === 'look.agent.pronouns');
  assert.equal(pronouns.by, 'agent');
  assert.equal(pronouns.afterText, 'she/her');
  assert.equal(pronouns.undoable, true);
  assert.equal(Object.hasOwn(pronouns, 'after'), false, 'the ordinary list stays compact');
  const mood = before.value.entries.find(entry => entry.key === 'mood:calm');
  assert.equal(mood.by, 'person');
  assert.equal(before.value.now.find(item => item.key === 'look.agent.pronouns').owner, 'agent');
  const personName = before.value.entries.find(entry => entry.key === 'look.person.name');
  assert.equal(personName.by, 'person');
  assert.equal(personName.undoable, true);
  assert.equal(before.value.now.find(item => item.key === 'look.person.name').owner, 'person');
  const appearance = before.value.entries.find(entry => entry.key === 'appearance');
  assert.equal(appearance.by, 'person');
  assert.equal(appearance.undoable, true);
  assert.equal(before.value.now.find(item => item.key === 'appearance').owner, 'person');
  const conversationTitleChange = before.value.entries.find(entry => entry.key === `conversation:${initial.conversationId}:title`);
  assert.equal(conversationTitleChange.by, 'person');
  assert.equal(conversationTitleChange.afterText, 'Synthetic room notes');
  assert.equal(conversationTitleChange.undoable, true);
  assert.equal(before.value.now.find(item => item.key === conversationTitleChange.key).owner, 'person');
  const proactiveChange = before.value.entries.find(entry => entry.key === `conversation:${initial.conversationId}:proactive`);
  assert.equal(proactiveChange.by, 'person');
  assert.equal(proactiveChange.afterText, 'stopped here');
  assert.equal(proactiveChange.undoable, true);
  assert.equal(before.value.now.find(item => item.key === proactiveChange.key).owner, 'person');

  // Exact values and retained history are fetched only when inspected or exported.
  const detail = await jsonRequest(view, '/api/changes/detail', token, { key: 'look.agent.pronouns' });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.value.opens, 'identity');
  assert.equal(detail.value.current.opens, 'identity');
  assert.equal(detail.value.current.owner, 'agent');
  assert.equal(detail.value.current.value.pronouns, 'she/her');
  assert.equal(detail.value.history[0].after.pronouns, 'she/her');
  assert.equal(detail.value.history[0].before, null);
  const exported = await jsonRequest(view, '/api/changes/export', token, {});
  assert.equal(exported.response.status, 200);
  assert.equal(exported.value.format, 'fieldwork-change-export/v1');
  assert.equal(exported.value.current.find(item => item.key === 'look.agent.pronouns').value.pronouns, 'she/her');
  assert.equal(exported.value.changes.find(entry => entry.key === 'look.agent.pronouns').after.pronouns, 'she/her');
  assert.equal((await jsonRequest(view, '/api/changes/detail', token, { key: 'look.person.name' })).value.current.owner, 'person');
  assert.equal(exported.value.current.find(item => item.key === 'look.person.name').owner, 'person');
  assert.equal(exported.value.current.find(item => item.key === 'appearance').value.palette, 'amber');
  assert.equal((await jsonRequest(view, '/api/changes/detail', token, { key: 'appearance' })).value.opens, 'appearance');
  const titleDetail = await jsonRequest(view, '/api/changes/detail', token, { key: conversationTitleChange.key });
  assert.equal(titleDetail.response.status, 200);
  assert.deepEqual(titleDetail.value.history[0].before, null);
  assert.equal(titleDetail.value.current.value.title, 'Synthetic room notes');
  assert.equal(titleDetail.value.current.value.customTitle, true);
  assert.ok(titleDetail.value.current.value.revision > 0);
  assert.equal(exported.value.current.find(item => item.key === conversationTitleChange.key).value.title, 'Synthetic room notes');
  const proactiveDetail = await jsonRequest(view, '/api/changes/detail', token, { key: proactiveChange.key });
  assert.equal(proactiveDetail.response.status, 200);
  assert.equal(proactiveDetail.value.current.value.mode, 'suppress');
  assert.equal(proactiveDetail.value.history[0].before, null);
  assert.equal(exported.value.current.find(item => item.key === proactiveChange.key).value.mode, 'suppress');
  assert.equal((await jsonRequest(view, '/api/changes/detail', token, { key: 'not-a-real-key' })).response.status, 404);

  const reviewed = await jsonRequest(view, '/api/chat', token, { text: 'check what actually landed' });
  assert.equal(reviewed.response.status, 200);
  const reviewResult = seen.at(-1).messages.filter(message => message.role === 'tool').at(-1);
  assert.match(String(reviewResult.content), /"key":"look\.agent\.pronouns"/);
  assert.match(String(reviewResult.content), /"pronouns":"she\/her"/);

  const currentBeforeArchive = reviewed.value.conversations.find(row => row.id === initial.conversationId);
  const archivedConversation = await jsonRequest(view, '/api/conversations/archive', token, {
    id: initial.conversationId,
    archived: true,
    expectedRevision: currentBeforeArchive.lifecycleRevision,
  });
  assert.equal(archivedConversation.response.status, 200);
  assert.notEqual(archivedConversation.value.conversationId, initial.conversationId);
  const lifecycleLog = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const statusChange = lifecycleLog.entries.find(entry => entry.key === `conversation:${initial.conversationId}:status` && entry.afterText === 'archived');
  assert.equal(statusChange.by, 'person');
  assert.equal(statusChange.undoable, true);
  assert.equal(lifecycleLog.now.find(item => item.key === statusChange.key).owner, 'person');
  const statusDetail = await jsonRequest(view, '/api/changes/detail', token, { key: statusChange.key });
  assert.equal(statusDetail.response.status, 200);
  assert.equal(statusDetail.value.current.value.archived, true);
  assert.equal(statusDetail.value.history[0].before, null);
  const statusExport = await jsonRequest(view, '/api/changes/export', token, {});
  assert.equal(statusExport.value.current.find(item => item.key === statusChange.key).value.archived, true);
  const statusUndone = await jsonRequest(view, '/api/changes/undo', token, { id: statusChange.id });
  assert.equal(statusUndone.response.status, 200);
  assert.equal(statusUndone.value.conversationStatus.id, initial.conversationId);
  assert.equal(statusUndone.value.conversationStatus.archived, false);
  assert.equal(statusUndone.value.conversations.find(row => row.id === initial.conversationId).archived, false);
  assert.equal(statusUndone.value.entries[0].undoOf, statusChange.id);

  const proactiveUndone = await jsonRequest(view, '/api/changes/undo', token, { id: proactiveChange.id });
  assert.equal(proactiveUndone.response.status, 200);
  assert.equal(proactiveUndone.value.conversationProactive.id, initial.conversationId);
  assert.equal(proactiveUndone.value.conversationProactive.proactiveMode, 'allow');
  assert.equal(proactiveUndone.value.conversations.find(row => row.id === initial.conversationId).proactiveMode, 'allow');
  assert.equal(proactiveUndone.value.entries[0].undoOf, proactiveChange.id);

  const titleUndone = await jsonRequest(view, '/api/changes/undo', token, { id: conversationTitleChange.id });
  assert.equal(titleUndone.response.status, 200);
  const restoredConversation = titleUndone.value.conversationTitle;
  assert.equal(restoredConversation.id, initial.conversationId);
  assert.equal(restoredConversation.customTitle, false);
  assert.equal(restoredConversation.title, 'pick pronouns');
  assert.equal(restoredConversation.titleBy, 'person');
  assert.ok(restoredConversation.titleRevision > titleDetail.value.current.value.revision);
  assert.equal(titleUndone.value.entries[0].undoOf, conversationTitleChange.id);

  // Undo puts it back, logs the undo, and the same change cannot be undone twice.
  const undone = await jsonRequest(view, '/api/changes/undo', token, { id: pronouns.id });
  assert.equal(undone.response.status, 200);
  assert.equal(undone.value.look.agent.pronouns, null);
  assert.equal(undone.value.entries[0].undoOf, pronouns.id);
  assert.equal(undone.value.entries[0].by, 'person');
  const newestPage = await jsonRequest(view, '/api/changes/detail', token, { key: 'look.agent.pronouns', limit: 1 });
  assert.equal(newestPage.value.historyCount, 2);
  assert.equal(newestPage.value.history.length, 1);
  assert.equal(newestPage.value.nextCursor, 1);
  const olderPage = await jsonRequest(view, '/api/changes/detail', token, { key: 'look.agent.pronouns', cursor: newestPage.value.nextCursor, limit: 1 });
  assert.equal(olderPage.value.history.length, 1);
  assert.equal(olderPage.value.nextCursor, undefined);
  const again = await jsonRequest(view, '/api/changes/undo', token, { id: pronouns.id });
  assert.equal(again.response.status, 409);

  const nameUndone = await jsonRequest(view, '/api/changes/undo', token, { id: personName.id });
  assert.equal(nameUndone.response.status, 200);
  assert.equal(nameUndone.value.look.person.name, 'You');
  assert.equal(nameUndone.value.look.person.nameBy, 'person');
  assert.equal((await jsonRequest(view, '/api/changes/detail', token, { key: 'look.person.name' })).value.current.owner, 'person');

  const appearanceUndone = await jsonRequest(view, '/api/changes/undo', token, { id: appearance.id });
  assert.equal(appearanceUndone.response.status, 200);
  assert.equal(appearanceUndone.value.appearance.settings.palette, 'fieldwork');
  assert.equal(appearanceUndone.value.appearance.settings.density, 'relaxed');
  assert.equal(appearanceUndone.value.appearance.settings.textSize, 'standard');
  assert.equal(appearanceUndone.value.appearance.settings.interfaceTypeface, 'sans');
  assert.equal(appearanceUndone.value.appearance.settings.technicalTypeface, 'mono');
  assert.equal(appearanceUndone.value.appearance.settings.texture, 'plain');
  assert.equal(appearanceUndone.value.appearance.revision, 2);
  assert.equal(appearanceSaves.length, 2, 'ordinary updates and history undo both reach the persistence boundary');
  assert.equal(appearanceSaves[1].settings.palette, 'fieldwork');
});

test('a failed change-log write retries without losing or changing actor attribution', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const durable = await createChangeLog({ file: path.join(data.directory, 'retry-changes.json'), clock });
  const diagnostics = [];
  let attempts = 0;
  const changeLog = Object.freeze({
    list: (...arguments_) => durable.list(...arguments_),
    get: (...arguments_) => durable.get(...arguments_),
    record(changes, extra) {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('synthetic change-log write failure'));
      return durable.record(changes, extra);
    },
  });
  const view = await startBrowserView({
    profile: data.profile,
    archive: data.archive,
    changeLog,
    lookFile: path.join(data.directory, 'retry-look.json'),
    onError(error, receipt) { diagnostics.push({ message: error.message, operation: receipt.operation }); },
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  await bootstrapRequest(view, token);

  const personChange = await jsonRequest(view, '/api/look/update', token, { who: 'person', name: 'Synthetic Person' });
  assert.equal(personChange.response.status, 200);
  const agentChange = await view.updateAppearance({
    expectedRevision: 0,
    changes: { palette: 'amber' },
    actor: { kind: 'agent', id: 'synthetic-agent' },
  });
  assert.equal(agentChange.appearance.revision, 1);
  assert.equal((await jsonRequest(view, '/api/changes/view', token, {})).response.status, 200);

  const entries = durable.list();
  const name = entries.find(row => row.key === 'look.person.name' && row.afterText === 'Synthetic Person');
  const appearance = entries.find(row => row.key === 'appearance' && row.after?.palette === 'amber');
  assert.equal(name.by, 'person');
  assert.equal(appearance.by, 'agent');
  assert.equal(entries.filter(row => row.key === 'look.person.name').length, 1);
  assert.equal(entries.filter(row => row.key === 'appearance').length, 1);
  assert.deepEqual(diagnostics.map(row => row.operation), ['change-log']);
});

test('retained unknown areas cannot inherit editor or undo capabilities', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'unknown-area-changes.json'), clock });
  const [retained] = await changeLog.record([{
    key: 'synthetic:unknown-area',
    area: '__proto__',
    label: 'Synthetic unknown area',
    by: 'person',
    before: null,
    after: null,
    beforeText: 'nothing',
    afterText: 'nothing',
  }]);
  const prototypeWasFrozen = Object.isFrozen(Object.prototype);
  const view = await startBrowserView({ profile: data.profile, archive: data.archive, changeLog });
  t.after(() => view.close());
  const token = launchAuthorization(view).token;

  const summary = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const row = summary.entries.find(entry => entry.id === retained.id);
  assert.equal(row.undoable, false);
  assert.equal(Object.hasOwn(row, 'opens'), false);
  const detail = (await jsonRequest(view, '/api/changes/detail', token, { key: retained.key })).value;
  assert.equal(Object.hasOwn(detail, 'opens'), false);
  assert.equal(Object.hasOwn(detail.current ?? {}, 'opens'), false);
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: retained.id })).response.status, 409);
  assert.equal(Object.isFrozen(Object.prototype), prototypeWasFrozen);
});

test('appearance ownership follows the actor, survives restart, and returns to the person on undo', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const changeFile = path.join(data.directory, 'appearance-owner-changes.json');
  let savedAppearance = null;
  let first = null;
  let second = null;
  let third = null;
  t.after(async () => {
    for (const view of [third, second, first]) {
      if (view) try { await view.close(); } catch { /* A completed phase already closed its room. */ }
    }
  });
  const saveAppearance = async receipt => {
    savedAppearance = { revision: receipt.revision, settings: receipt.settings };
  };

  first = await startBrowserView({
    profile: data.profile,
    archive: data.archive,
    changeLog: await createChangeLog({ file: changeFile, clock }),
    onAppearanceChange: saveAppearance,
  });
  const firstToken = launchAuthorization(first).token;
  let state = (await jsonRequest(first, '/api/changes/view', firstToken, {})).value;
  assert.equal(state.now.find(row => row.key === 'appearance').owner, null);

  const changed = await first.updateAppearance({
    expectedRevision: 0,
    changes: { palette: 'amber' },
    actor: { kind: 'agent', id: 'synthetic-agent' },
  });
  assert.equal(changed.appearance.revision, 1);
  state = (await jsonRequest(first, '/api/changes/view', firstToken, {})).value;
  const agentEntry = state.entries.find(row => row.key === 'appearance' && row.afterText.includes('palette: amber'));
  assert.equal(agentEntry.by, 'agent');
  assert.equal(state.now.find(row => row.key === 'appearance').owner, 'agent');
  assert.equal((await jsonRequest(first, '/api/changes/detail', firstToken, { key: 'appearance' })).value.current.owner, 'agent');
  assert.equal((await jsonRequest(first, '/api/changes/export', firstToken, {})).value.current.find(row => row.key === 'appearance').owner, 'agent');

  await first.close();
  first = null;
  second = await startBrowserView({
    profile: data.profile,
    archive: data.archive,
    changeLog: await createChangeLog({ file: changeFile, clock }),
    appearanceState: savedAppearance,
    onAppearanceChange: saveAppearance,
  });
  const secondToken = launchAuthorization(second).token;
  state = (await jsonRequest(second, '/api/changes/view', secondToken, {})).value;
  assert.equal(state.now.find(row => row.key === 'appearance').owner, 'agent');

  const undone = await jsonRequest(second, '/api/changes/undo', secondToken, { id: agentEntry.id });
  assert.equal(undone.response.status, 200);
  assert.equal(undone.value.now.find(row => row.key === 'appearance').owner, 'person');
  assert.equal(savedAppearance.revision, 2);
  assert.equal(savedAppearance.settings.palette, 'fieldwork');

  await second.close();
  second = null;
  third = await startBrowserView({
    profile: data.profile,
    archive: data.archive,
    changeLog: await createChangeLog({ file: changeFile, clock }),
    appearanceState: savedAppearance,
    onAppearanceChange: saveAppearance,
  });
  const thirdToken = launchAuthorization(third).token;
  state = (await jsonRequest(third, '/api/changes/view', thirdToken, {})).value;
  assert.equal(state.now.find(row => row.key === 'appearance').owner, 'person');
});

test('selected moods have sparse exact history with independent undo and definition ordering', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const { createExpressionStore, expressionTools } = await import('../src/expression.mjs');
  let milliseconds = Date.parse('2031-02-03T04:05:06.000Z');
  const movingClock = () => new Date(milliseconds);
  const advance = () => { milliseconds += 60_000; };
  const rawAgent = value => value && ({ name: value.name, at: value.at, by: value.by, note: value.note });
  const rawPerson = value => value && ({ name: value.name, at: value.at });
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'mood-selection-changes.json'), clock: movingClock });
  const expression = await createExpressionStore({ file: path.join(data.directory, 'mood-selection-expression.json'), clock: movingClock });
  await expression.defineMood({ name: 'calm', description: 'settled' });
  await expression.defineMood({ name: 'curious', description: 'looking closely', color: 'sky' });
  await expression.defineMood({ name: 'focused', description: 'narrow attention' });
  await expression.setMood({ name: 'calm', by: 'agent', note: 'first light' });
  const baselineAgent = rawAgent(expression.view().current);

  const providerRequests = [];
  const providerReplies = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'mood-change', type: 'function',
      function: { name: 'set_mood', arguments: '{"mood":"curious","note":"new question"}' },
    }] },
    { role: 'assistant', content: 'Changed.' },
    { role: 'assistant', content: null, tool_calls: [{
      id: 'mood-review', type: 'function',
      function: { name: 'review_changes', arguments: '{"key":"mood-selection:agent","limit":5}' },
    }] },
    { role: 'assistant', content: 'Inspected.' },
  ];
  const provider = Object.freeze({
    id: 'synthetic/mood-history',
    complete(request) {
      providerRequests.push(request);
      return providerReplies.shift();
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, expression, changeLog,
    tools: createToolRegistry(expressionTools(expression)), clock: movingClock,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  let changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.deepEqual(changes.now.find(item => item.key === 'mood-selection:agent'), {
    key: 'mood-selection:agent', area: 'moods', label: 'Agent\'s current mood',
    text: 'calm — first light', owner: 'agent',
  });
  assert.equal(changes.entries.some(entry => entry.key.startsWith('mood-selection:')), false,
    'the selection present at startup is a baseline, not a phantom agent change');

  advance();
  assert.equal((await jsonRequest(view, '/api/chat', token, { text: 'How are you now?' })).response.status, 200);
  const curiousAgent = rawAgent(expression.view().current);
  advance();
  assert.equal((await jsonRequest(view, '/api/expression/mood/mine', token, { name: 'focused' })).response.status, 200);
  const focusedPerson = rawPerson(expression.view().person);

  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const agentChange = changes.entries.find(entry => entry.key === 'mood-selection:agent' && entry.afterText === 'curious — new question');
  const personChange = changes.entries.find(entry => entry.key === 'mood-selection:person' && entry.afterText === 'focused');
  assert.equal(agentChange.by, 'agent');
  assert.equal(agentChange.undoable, true, 'changing the person slot does not stale the agent slot');
  assert.equal(personChange.by, 'person');
  assert.equal(personChange.undoable, true);
  assert.equal(changes.now.find(item => item.key === 'mood-selection:agent').owner, 'agent');
  assert.equal(changes.now.find(item => item.key === 'mood-selection:person').owner, 'person');

  const agentDetail = (await jsonRequest(view, '/api/changes/detail', token, { key: 'mood-selection:agent' })).value;
  const personDetail = (await jsonRequest(view, '/api/changes/detail', token, { key: 'mood-selection:person' })).value;
  assert.deepEqual(agentDetail.current.value, curiousAgent);
  assert.deepEqual(agentDetail.history[0].before, baselineAgent);
  assert.deepEqual(agentDetail.history[0].after, curiousAgent);
  assert.deepEqual(Object.keys(agentDetail.current.value).sort(), ['at', 'by', 'name', 'note']);
  assert.deepEqual(personDetail.current.value, focusedPerson);
  assert.deepEqual(personDetail.history[0].before, null);
  assert.deepEqual(Object.keys(personDetail.current.value).sort(), ['at', 'name']);
  const exported = (await jsonRequest(view, '/api/changes/export', token, {})).value;
  assert.deepEqual(exported.current.find(item => item.key === 'mood-selection:agent').value, curiousAgent);
  assert.deepEqual(exported.current.find(item => item.key === 'mood-selection:person').value, focusedPerson);
  assert.equal(JSON.stringify(agentDetail).includes('looking closely'), false,
    'definition prose is not copied into selection history');

  assert.equal((await jsonRequest(view, '/api/chat', token, { text: 'Inspect that mood selection.' })).response.status, 200);
  const reviewResult = providerRequests.at(-1).messages.filter(message => message.role === 'tool').at(-1);
  const reviewText = String(reviewResult.content);
  const reviewedSelection = JSON.parse(reviewText);
  assert.match(reviewText, /"key":"mood-selection:agent"/);
  assert.match(reviewText, /"note":"new question"/);
  assert.equal(reviewedSelection.ok, true);
  assert.deepEqual(reviewedSelection.value.current.value, curiousAgent);
  assert.deepEqual(Object.keys(reviewedSelection.value.current.value).sort(), ['at', 'by', 'name', 'note']);
  assert.equal(reviewText.includes('looking closely'), false);

  const selectionEntries = changes.entries.filter(entry => entry.key === 'mood-selection:agent').length;
  const redefined = await jsonRequest(view, '/api/expression/mood/define', token, {
    name: 'curious', description: 'definition changed, selection did not', icon: null, color: 'lavender',
  });
  assert.equal(redefined.response.status, 200);
  assert.deepEqual(
    redefined.value.expression.moods.find(mood => mood.name === 'curious'),
    { name: 'curious', description: 'definition changed, selection did not', icon: null, color: 'lavender', by: 'person' },
  );
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.equal(changes.entries.filter(entry => entry.key === 'mood-selection:agent').length, selectionEntries);
  assert.equal(changes.entries.find(entry => entry.id === agentChange.id).undoable, true);

  const agentUndone = await jsonRequest(view, '/api/changes/undo', token, { id: agentChange.id });
  assert.equal(agentUndone.response.status, 200);
  assert.deepEqual(rawAgent(agentUndone.value.expression.current), baselineAgent,
    'undo restores the exact timestamp, author and note');
  assert.deepEqual(rawPerson(agentUndone.value.expression.person), focusedPerson,
    'undoing the agent slot leaves the person slot alone');
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: agentChange.id })).response.status, 409);

  const personUndone = await jsonRequest(view, '/api/changes/undo', token, { id: personChange.id });
  assert.equal(personUndone.response.status, 200);
  assert.equal(personUndone.value.expression.person, null, 'the first person selection returns to genuinely unset');

  advance();
  await jsonRequest(view, '/api/expression/mood/mine', token, { name: 'focused' });
  const selectedBeforeDeletion = rawPerson(expression.view().person);
  advance();
  await jsonRequest(view, '/api/expression/mood/remove', token, { name: 'focused' });
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const definitionRemoval = changes.entries.find(entry => entry.key === 'mood:focused' && entry.afterText === 'removed');
  const selectionClear = changes.entries.find(entry => entry.key === 'mood-selection:person' && entry.afterText === 'removed');
  assert.equal(definitionRemoval.undoable, true);
  assert.equal(selectionClear.undoable, false, 'a missing definition blocks restoration of its selection');
  assert.equal(selectionClear.opens, 'expression');

  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: definitionRemoval.id })).response.status, 200);
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.equal(changes.entries.find(entry => entry.id === selectionClear.id).undoable, true,
    'restoring the definition makes the exact selection restoration available');
  const selectionRestored = await jsonRequest(view, '/api/changes/undo', token, { id: selectionClear.id });
  assert.equal(selectionRestored.response.status, 200);
  assert.deepEqual(rawPerson(selectionRestored.value.expression.person), selectedBeforeDeletion);

  advance();
  await expression.defineMood({ name: 'invented', description: 'made by the agent', by: 'agent' });
  await jsonRequest(view, '/api/changes/view', token, {});
  advance();
  await jsonRequest(view, '/api/expression/mood/remove', token, { name: 'invented' });
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const agentDefinitionRemoval = changes.entries.find(entry => entry.key === 'mood:invented' && entry.afterText === 'removed');
  assert.equal(agentDefinitionRemoval.undoable, true);
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: agentDefinitionRemoval.id })).response.status, 200);
  assert.equal(expression.view().moods.find(mood => mood.name === 'invented').by, 'agent',
    'new mood history preserves the definition maker through deletion and undo');

  const liveAgent = rawAgent(expression.view().current);
  const [malformed] = await changeLog.record([{
    key: 'mood-selection:agent', area: 'moods', label: 'Agent\'s current mood', by: 'person',
    before: { ...liveAgent, at: 'not-an-instant' }, after: liveAgent,
    beforeText: 'malformed', afterText: liveAgent.name,
  }]);
  const [noOp] = await changeLog.record([{
    key: 'mood-selection:agent', area: 'moods', label: 'Agent\'s current mood', by: 'person',
    before: liveAgent, after: liveAgent, beforeText: liveAgent.name, afterText: liveAgent.name,
  }]);
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.equal(changes.entries.find(entry => entry.id === malformed.id).undoable, false);
  assert.equal(changes.entries.find(entry => entry.id === noOp.id).undoable, false);
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: malformed.id })).response.status, 409);
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: noOp.id })).response.status, 409);
});

test('a pre-decoration appearance history entry remains exactly undoable', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'legacy-appearance-changes.json') });
  const legacyDefaults = {
    palette: 'fieldwork', density: 'dense', typeface: 'serif', inspector: 'standard',
    texture: 'grid', motion: 'system', side: 'right',
  };
  const normalizedLegacyDefaults = { ...BROWSER_APPEARANCE_DEFAULTS, ...legacyDefaults };
  const legacyChanged = { ...legacyDefaults, palette: 'amber', density: 'relaxed' };
  const [legacyEntry] = await changeLog.record([{
    key: 'appearance', area: 'appearance', label: 'Room appearance', by: 'person',
    before: legacyDefaults, after: legacyChanged,
    beforeText: 'legacy defaults', afterText: 'legacy amber room',
  }]);
  const saved = [];
  const view = await startBrowserView({
    profile: data.profile, archive: data.archive, changeLog,
    appearanceState: { revision: 1, settings: legacyChanged },
    onAppearanceChange: async receipt => { saved.push(receipt); },
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  const changes = await jsonRequest(view, '/api/changes/view', token, {});
  assert.equal(changes.response.status, 200);
  const retained = changes.value.entries.find(entry => entry.id === legacyEntry.id);
  assert.equal(retained.undoable, true, 'new defaulted fields do not make the old complete snapshot look stale');
  assert.equal(changes.value.now.find(row => row.key === 'appearance').owner, null,
    'default-filled legacy history is not exact enough to manufacture current ownership');

  const undone = await jsonRequest(view, '/api/changes/undo', token, { id: legacyEntry.id });
  assert.equal(undone.response.status, 200);
  assert.deepEqual(undone.value.appearance.settings, normalizedLegacyDefaults);
  assert.equal(undone.value.appearance.settings.interfaceTypeface, 'sans');
  assert.equal(undone.value.appearance.settings.technicalTypeface, 'mono');
  assert.deepEqual(saved[0].settings, normalizedLegacyDefaults, 'the normalized snapshot crosses the persistence boundary');
});

test('the agent shelves a picture and a notebook file; the person takes down, puts back, and sees it in the change log', async t => {
  const data = await fixture(t);
  const { createAttachmentStore } = await import('../src/attachments.mjs');
  const { createShelf } = await import('../src/shelf.mjs');
  const { createChangeLog } = await import('../src/change-log.mjs');
  const attachments = await createAttachmentStore({ dir: path.join(data.directory, 'attachments') });
  const shelf = await createShelf({ dir: path.join(data.directory, 'shelf') });
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'changes.json') });
  const notebookRoot = path.join(data.directory, 'workspace');
  await fs.mkdir(path.join(notebookRoot, 'poems'), { recursive: true });
  await fs.writeFile(path.join(notebookRoot, 'poems', 'rain.md'), 'Rain on the leaves.');
  const steps = [
    { role: 'assistant', content: null, tool_calls: [
      { id: 's1', type: 'function', function: { name: 'put_on_shelf', arguments: '{"picture":1,"title":"Sprout","note":"a gift"}' } },
      { id: 's2', type: 'function', function: { name: 'put_on_shelf', arguments: '{"notebook_file":"poems/rain.md","title":"Rain poem"}' } },
      { id: 's3', type: 'function', function: { name: 'put_on_shelf', arguments: '{"notebook_file":"../escape.md","title":"Nope"}' } },
    ] },
    { role: 'assistant', content: 'Shelved!' },
  ];
  const seen = [];
  const provider = Object.freeze({ id: 'synthetic/shelver', complete(request) { seen.push(request); return steps.shift(); } });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, attachments, shelf, changeLog, notebookRoot });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.capabilities.shelf, true);

  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 4]).toString('base64')}`;
  const chat = await jsonRequest(view, '/api/chat', token, { text: 'for your shelf', attachments: [{ name: 'sprout.png', dataUrl: png }] });
  assert.equal(chat.response.status, 200);
  const toolResults = seen[1].messages.filter(message => message.role === 'tool').map(message => String(message.content));
  assert.match(toolResults[2], /must be relative|must not be|error/i, 'the notebook path check still applies');

  const shelved = (await jsonRequest(view, '/api/shelf/view', token, {})).value.shelf;
  assert.deepEqual(shelved.map(item => [item.kind, item.title, item.by]).sort(), [['picture', 'Sprout', 'agent'], ['text', 'Rain poem', 'agent']]);
  const poem = shelved.find(item => item.kind === 'text');
  assert.equal((await jsonRequest(view, '/api/shelf/text', token, { id: poem.id })).value.text, 'Rain on the leaves.');

  // The person adds their own text file, takes the poem down, and puts it back.
  const note = `data:text/plain;base64,${Buffer.from('A note from me.').toString('base64')}`;
  const added = await jsonRequest(view, '/api/shelf/add', token, { name: 'note.txt', dataUrl: note, title: 'My note' });
  assert.equal(added.response.status, 200);
  assert.equal((await jsonRequest(view, '/api/shelf/text', token, { id: added.value.shelf.find(item => item.title === 'My note').id })).value.text, 'A note from me.');
  const down = await jsonRequest(view, '/api/shelf/takedown', token, { id: poem.id });
  assert.equal(down.value.shelf.find(item => item.id === poem.id).takenDown, true);
  const log = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const shelving = log.entries.find(entry => entry.key === `shelf:${poem.id}` && entry.by === 'agent');
  assert.ok(shelving, 'the agent shelving the poem is in the change log');
  const takedown = log.entries.find(entry => entry.key === `shelf:${poem.id}` && entry.by === 'person');
  assert.equal(takedown.undoable, true);
  const undone = await jsonRequest(view, '/api/changes/undo', token, { id: takedown.id });
  assert.equal(undone.value.shelf.find(item => item.id === poem.id).takenDown, false, 'undoing the take-down puts it back');
});

test('tools the room adds late (shelf, change log) still show in health and receipts', async t => {
  const data = await fixture(t);
  const { createShelf } = await import('../src/shelf.mjs');
  const { createChangeLog } = await import('../src/change-log.mjs');
  const shelf = await createShelf({ dir: path.join(data.directory, 'shelf') });
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'changes.json') });
  const steps = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'l1', type: 'function', function: { name: 'look_at_shelf', arguments: '{}' } }] },
    { role: 'assistant', content: 'Empty shelf.' },
  ];
  const provider = Object.freeze({ id: 'synthetic/late', complete() { return steps.shift(); } });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, shelf, changeLog });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const names = (await bootstrapRequest(view, token)).value.health.tools.map(tool => tool.name);
  for (const name of ['put_on_shelf', 'look_at_shelf', 'review_changes']) assert.ok(names.includes(name), `${name} is listed`);
  const chat = await jsonRequest(view, '/api/chat', token, { text: 'shelf?' });
  const events = chat.value.receipt.events.filter(event => event.type === 'tool_finished');
  assert.equal(events[0].tool, 'look_at_shelf');
  assert.equal(events[0].unregisteredTool, undefined);
});

test('the person can browse, inspect, and conflict-safely restore collection versions', async t => {
  const data = await fixture(t);
  const { createCollections } = await import('../src/collections.mjs');
  const collections = await createCollections({ root: path.join(data.directory, 'workspace', 'collections') });
  await collections.make({ name: 'plants', description: 'plants I have met', fields: ['water'] });
  await collections.save({ collection: 'plants', title: 'Sundew', fields: { water: 'rainwater' }, text: 'First sticky note.' });
  await collections.save({ collection: 'plants', title: 'Sundew', fields: { water: 'weekly' }, text: 'Current sticky note.' });
  await collections.save({ collection: 'plants', title: 'Moss', fields: { water: 'often' }, text: 'Soft.' });
  await collections.remove({ collection: 'plants', entry: 'moss' });
  const view = await startBrowserView({ profile: data.profile, archive: data.archive, collections });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  assert.equal((await bootstrapRequest(view, token)).value.capabilities.collections, true);
  const list = await jsonRequest(view, '/api/collections/list', token, {});
  assert.deepEqual(list.value.collections.map(row => [row.name, row.entries]), [['plants', 1]]);
  const found = await jsonRequest(view, '/api/collections/search', token, { query: 'sundew', collection: 'plants' });
  assert.equal(found.value.results[0].title, 'Sundew');
  const entry = await jsonRequest(view, '/api/collections/entry', token, { collection: 'plants', entry: 'sundew' });
  assert.equal(entry.value.entry.fields.water, 'weekly');

  const history = await jsonRequest(view, '/api/collections/history', token, { collection: 'plants', entry: 'sundew' });
  assert.equal(history.response.status, 200);
  assert.equal(history.value.history.current.kind, 'current');
  assert.equal(history.value.history.versions.length, 1);
  assert.equal(history.value.history.versions[0].raw, undefined, 'the list stays metadata-only');
  assert.doesNotMatch(JSON.stringify(history.value), new RegExp(data.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const earlier = history.value.history.versions[0];
  const exactEarlier = await jsonRequest(view, '/api/collections/version', token, {
    collection: 'plants', entry: 'sundew', versionId: earlier.versionId,
  });
  assert.match(exactEarlier.value.version.raw, /First sticky note\./);
  assert.equal(exactEarlier.value.version.fingerprint, earlier.fingerprint);
  assert.doesNotMatch(JSON.stringify(exactEarlier.value), new RegExp(data.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const restoredHistory = await jsonRequest(view, '/api/collections/restore', token, {
    collection: 'plants', entry: 'sundew', versionId: earlier.versionId,
    expectedCurrentFingerprint: history.value.history.current.fingerprint,
  });
  assert.equal(restoredHistory.response.status, 200);
  assert.equal(restoredHistory.value.restore.restored.by, 'person');
  assert.equal(restoredHistory.value.restore.restoredFrom.versionId, earlier.versionId);
  assert.doesNotMatch(JSON.stringify(restoredHistory.value), new RegExp(data.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const restoredEntry = await jsonRequest(view, '/api/collections/entry', token, { collection: 'plants', entry: 'sundew' });
  assert.equal(restoredEntry.value.entry.text.trim(), 'First sticky note.');
  assert.equal(restoredEntry.value.entry.restoredFrom.versionId, earlier.versionId);
  assert.equal((await jsonRequest(view, '/api/collections/version', token, {
    collection: 'plants', entry: 'sundew', versionId: earlier.versionId,
  })).response.status, 200, 'the selected history copy remains inspectable');

  const removed = await jsonRequest(view, '/api/collections/removed', token, { collection: 'plants', cursor: 0, limit: 25 });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.value.removed.total, 1);
  assert.equal(removed.value.removed.items[0].title, 'Moss');
  const removedMoss = removed.value.removed.items[0];
  const exactRemoved = await jsonRequest(view, '/api/collections/version', token, {
    collection: 'plants', entry: removedMoss.entry, versionId: removedMoss.versionId,
  });
  assert.match(exactRemoved.value.version.raw, /Soft\./);
  assert.doesNotMatch(JSON.stringify(exactRemoved.value), new RegExp(data.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const restoredRemoved = await jsonRequest(view, '/api/collections/restore', token, {
    collection: 'plants', entry: removedMoss.entry, versionId: removedMoss.versionId,
    expectedCurrentFingerprint: null,
  });
  assert.equal(restoredRemoved.response.status, 200);
  assert.doesNotMatch(JSON.stringify(restoredRemoved.value), new RegExp(data.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((await jsonRequest(view, '/api/collections/entry', token, { collection: 'plants', entry: 'moss' })).value.entry.by, 'person');
  assert.equal((await jsonRequest(view, '/api/collections/version', token, {
    collection: 'plants', entry: removedMoss.entry, versionId: removedMoss.versionId,
  })).response.status, 200, 'the removed recovery copy is not consumed');
  assert.equal((await jsonRequest(view, '/api/collections/restore', token, {
    collection: 'plants', entry: removedMoss.entry, versionId: removedMoss.versionId,
    expectedCurrentFingerprint: null,
  })).response.status, 409, 'a recreated current entry fences a stale removed restore');

  assert.equal((await jsonRequest(view, '/api/collections/version', token, {
    collection: 'plants', entry: 'sundew', versionId: 'history:not-a-version',
  })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/collections/restore', token, {
    collection: 'plants', entry: 'sundew', versionId: earlier.versionId,
    expectedCurrentFingerprint: restoredHistory.value.restore.restored.fingerprint, by: 'agent',
  })).response.status, 400, 'the browser route owns person attribution');
  const malformedRequests = [
    ['/api/collections/search', { query: { text: 'sundew' }, collection: 'plants' }],
    ['/api/collections/entry', { collection: 'plants', entry: 42 }],
    ['/api/collections/history', { collection: false, entry: 'sundew' }],
    ['/api/collections/history', { collection: 'plants', entry: ['sundew'] }],
    ['/api/collections/version', { collection: 'plants', entry: 'sundew', versionId: [earlier.versionId] }],
    ['/api/collections/restore', {
      collection: 'plants', entry: 'sundew', versionId: earlier.versionId,
      expectedCurrentFingerprint: [restoredHistory.value.restore.restored.fingerprint],
    }],
    ['/api/collections/removed', { collection: 'plants', cursor: 1, limit: 25 }],
    ['/api/collections/removed', { collection: 'plants', cursor: 0, limit: '25' }],
  ];
  for (const [endpoint, body] of malformedRequests) {
    assert.equal((await jsonRequest(view, endpoint, token, body)).response.status, 400, `${endpoint} rejects malformed field types`);
  }
  const missing = await jsonRequest(view, '/api/collections/entry', token, { collection: '../x', entry: 'y' });
  assert.equal(missing.response.status, 400);
});

test('collection routes preserve unexpected store failures as server errors', async t => {
  const data = await fixture(t);
  const fail = async () => { throw new Error('synthetic collection storage failure'); };
  const collections = Object.freeze({
    list: fail, search: fail, read: fail, history: fail, removed: fail, version: fail, restore: fail,
  });
  const view = await startBrowserView({ profile: data.profile, archive: data.archive, collections });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const failed = await jsonRequest(view, '/api/collections/history', token, { collection: 'plants', entry: 'sundew' });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.value.error, 'The browser view could not complete this request.');
});

test('tool-group modes are resident, per-run on demand, or hard off without restart', async t => {
  const data = await fixture(t);
  const { createToolGroupSettings } = await import('../src/tool-groups.mjs');
  const { createShelf } = await import('../src/shelf.mjs');
  const { createChangeLog } = await import('../src/change-log.mjs');
  const toolGroups = await createToolGroupSettings({ file: path.join(data.directory, 'tool-groups.json') });
  const shelf = await createShelf({ dir: path.join(data.directory, 'shelf') });
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'changes.json') });
  const seen = [];
  let turn = 0;
  let restarts = 0;
  const provider = Object.freeze({
    id: 'synthetic/counter',
    complete(request) {
      if (request.step === 1) turn += 1;
      const names = request.tools.map(tool => tool.function.name);
      seen.push({ turn, step: request.step, names, messages: request.messages });
      if (turn === 2 && request.step === 1) {
        return {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'load-shelf', type: 'function', function: { name: 'load_tool_group', arguments: '{"group":"shelf"}' } }],
        };
      }
      return { role: 'assistant', content: 'ok' };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, shelf, changeLog, toolGroups,
    onRestart: () => { restarts++; },
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  const before = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  const shelfGroup = before.groups.find(group => group.id === 'shelf');
  assert.equal(shelfGroup.mode, 'resident');
  assert.ok(shelfGroup.tokens > 0, 'each group shows roughly what it costs');
  assert.equal(before.initial, before.resident, 'without on-demand groups the initial declaration count is the resident count');
  await jsonRequest(view, '/api/chat', token, { text: 'one' });
  assert.ok(seen[0].names.includes('put_on_shelf'));

  const after = (await jsonRequest(view, '/api/tools/set', token, { group: 'shelf', mode: 'on-demand' })).value;
  assert.equal(after.resident, before.resident - shelfGroup.tools.length);
  assert.equal(after.initial, after.resident + 1, 'the initial count includes the dynamic loader schema');
  assert.equal(after.onDemand, 1);
  assert.equal(restarts, 0, 'changing the offered kit does not restart the room');
  const reopenedSettings = await createToolGroupSettings({ file: path.join(data.directory, 'tool-groups.json') });
  assert.equal(reopenedSettings.mode('shelf'), 'on-demand', 'the next room start keeps the mode');
  await jsonRequest(view, '/api/chat', token, { text: 'two' });
  const turnTwo = seen.filter(row => row.turn === 2);
  assert.ok(!turnTwo[0].names.some(name => name.includes('shelf')), 'on-demand schemas start absent');
  assert.ok(turnTwo[0].names.includes('load_tool_group'));
  assert.ok(turnTwo[1].names.includes('put_on_shelf'), 'the requested group appears on the next provider step');
  assert.match(JSON.stringify(turnTwo[0].messages), /Shelf \(shelf\) — on-demand: put_on_shelf/);

  await jsonRequest(view, '/api/chat', token, { text: 'three' });
  const turnThree = seen.find(row => row.turn === 3 && row.step === 1);
  assert.ok(!turnThree.names.includes('put_on_shelf'), 'the next user turn starts a fresh transient load set');

  const health = (await bootstrapRequest(view, token)).value.health.tools;
  assert.equal(health.find(tool => tool.name === 'put_on_shelf').available, true);
  assert.equal(health.find(tool => tool.name === 'put_on_shelf').mode, 'on-demand');
  assert.equal(health.find(tool => tool.name === 'put_on_shelf').group, 'shelf');

  const hardOff = (await jsonRequest(view, '/api/tools/set', token, { group: 'shelf', mode: 'off' })).value;
  assert.equal(hardOff.groups.find(group => group.id === 'shelf').mode, 'off');
  await jsonRequest(view, '/api/chat', token, { text: 'four' });
  const turnFour = seen.find(row => row.turn === 4 && row.step === 1);
  assert.ok(!turnFour.names.includes('put_on_shelf'));
  assert.doesNotMatch(JSON.stringify(turnFour.messages), /Shelf \(shelf\) — on-demand/);

  const log = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const change = log.entries.find(entry => entry.key === 'tools' && /shelf: off/.test(entry.afterText));
  assert.equal(change.by, 'person');
  const detail = (await jsonRequest(view, '/api/changes/detail', token, { key: 'tools' })).value;
  assert.equal(detail.opens, 'tools');
  assert.equal(detail.history.find(entry => entry.id === change.id).after.shelf, 'off');
  const undone = await jsonRequest(view, '/api/changes/undo', token, { id: change.id });
  assert.equal(undone.response.status, 200);
  assert.equal((await jsonRequest(view, '/api/tools/view', token, {})).value.groups.find(group => group.id === 'shelf').mode, 'on-demand');
  assert.equal(restarts, 0);
  assert.equal((await jsonRequest(view, '/api/tools/set', token, { group: 'nope', mode: 'off' })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/tools/set', token, { group: 'shelf', mode: 'sometimes' })).response.status, 400);

  await jsonRequest(view, '/api/tools/set', token, { group: 'shelf', mode: 'resident' });
  const [legacy] = await changeLog.record([{
    key: 'tools', area: 'tools', label: 'Tool groups switched off', by: 'person',
    before: ['shelf'], after: null, beforeText: 'shelf', afterText: 'none',
  }]);
  const legacyUndo = await jsonRequest(view, '/api/changes/undo', token, { id: legacy.id });
  assert.equal(legacyUndo.response.status, 200);
  assert.equal((await jsonRequest(view, '/api/tools/view', token, {})).value.groups.find(group => group.id === 'shelf').mode, 'off');
});

test('explicit tool permissions are inspectable, private, and exactly reversible', async t => {
  const data = await fixture(t);
  const { createChangeLog } = await import('../src/change-log.mjs');
  const permissions = await createToolPermissionStore({
    file: path.join(data.directory, 'inspectable-tool-permissions.json'), clock,
  });
  await permissions.setPolicy({ tool: 'retired_synthetic_tool', mode: 'never', expectedRevision: 0, actor: 'host' });
  const changeLog = await createChangeLog({ file: path.join(data.directory, 'tool-permission-changes.json'), clock });
  const tools = createToolRegistry([{
    name: 'save_synthetic_value',
    description: 'Save one synthetic value.',
    permissionSummary: () => 'Save one synthetic value.',
    inputSchema: {
      type: 'object', properties: { value: { type: 'string' } },
      required: ['value'], additionalProperties: false,
    },
    execute: () => ({ saved: true }),
  }, {
    name: 'read_synthetic_value',
    description: 'Read one synthetic value.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ value: 'synthetic' }),
  }]);
  const providerRequests = [];
  const providerReplies = [
    { role: 'assistant', content: null, tool_calls: [{
      id: 'review-policy', type: 'function',
      function: { name: 'review_changes', arguments: '{"key":"tool-permission:save_synthetic_value","limit":5}' },
    }] },
    { role: 'assistant', content: 'I inspected the policy.' },
  ];
  const provider = Object.freeze({
    id: 'synthetic/tool-permission-reviewer',
    complete(request) { providerRequests.push(request); return providerReplies.shift(); },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, archive: data.archive, tools,
    toolPermissions: permissions, changeLog,
  });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);

  let changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.equal(changes.now.some(item => item.area === 'tool-permissions'), false,
    'implicit Always defaults do not make the general ledger noisy');
  assert.equal(changes.entries.some(item => item.key === 'tool-permission:retired_synthetic_tool'), false,
    'startup reconciliation is not misattributed to the next actor');
  let toolView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  assert.ok(toolView.permissions.history.some(row => row.tool === 'retired_synthetic_tool' && row.action === 'policy-retired'));
  toolView = (await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'save_synthetic_value', mode: 'ask', expectedRevision: toolView.permissions.revision,
  })).value;

  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const key = 'tool-permission:save_synthetic_value';
  const askChange = changes.entries.find(entry => entry.key === key);
  assert.equal(askChange.by, 'person');
  assert.equal(askChange.area, 'tool-permissions');
  assert.equal(askChange.beforeText, 'nothing');
  assert.equal(askChange.afterText, 'Ask (explicit)');
  assert.equal(askChange.undoable, true);
  assert.equal(changes.now.find(item => item.key === key).owner, 'person');
  const detail = (await jsonRequest(view, '/api/changes/detail', token, { key })).value;
  assert.equal(detail.opens, 'tools');
  assert.equal(detail.current.value.tool, 'save_synthetic_value');
  assert.equal(detail.current.value.mode, 'ask');
  assert.equal(detail.current.value.explicit, true);
  assert.equal(detail.current.value.actor, 'person');
  assert.equal(detail.history[0].before, null);

  const privateSummary = 'SYNTHETIC PRIVATE PERMISSION SUMMARY';
  const privateDigest = hash('SYNTHETIC PRIVATE TOOL ARGUMENTS');
  const privateRequest = await permissions.authorize({
    tool: 'save_synthetic_value', argumentsSha256: privateDigest,
    summary: privateSummary, origin: 'local-chat', interactive: true,
  });
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.equal(changes.entries.filter(entry => entry.key === key).length, 1,
    'pending approval activity stays in its dedicated Tools history');
  const exported = (await jsonRequest(view, '/api/changes/export', token, {})).value;
  const privatePermissionValues = [
    privateSummary, privateDigest, privateDigest.slice(0, 12),
    privateRequest.requestId, privateRequest.requestFingerprint,
  ];
  const exportedText = JSON.stringify(exported);
  const privateDetailText = JSON.stringify((await jsonRequest(view, '/api/changes/detail', token, { key })).value);
  for (const privateValue of privatePermissionValues) {
    assert.equal(exportedText.includes(privateValue), false);
    assert.equal(privateDetailText.includes(privateValue), false);
  }
  assert.equal((await jsonRequest(view, '/api/chat', token, { text: 'Inspect that policy.' })).response.status, 200);
  const reviewResult = providerRequests.at(-1).messages.filter(message => message.role === 'tool').at(-1);
  const reviewText = String(reviewResult.content);
  assert.match(reviewText, /tool-permission:save_synthetic_value/);
  for (const privateValue of privatePermissionValues) assert.equal(reviewText.includes(privateValue), false);

  const undone = await jsonRequest(view, '/api/changes/undo', token, { id: askChange.id });
  assert.equal(undone.response.status, 200);
  toolView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  const implicit = toolView.permissions.policies.find(row => row.tool === 'save_synthetic_value');
  assert.equal(implicit.mode, 'always');
  assert.equal(implicit.explicit, false, 'undo restores the untouched default rather than explicit Always');
  assert.equal(toolView.permissions.pending.length, 0, 'reset does not leave an Ask request usable under Always');
  assert.ok(toolView.permissions.history.some(row => row.action === 'policy-cleared'));
  assert.equal(undone.value.now.some(item => item.key === key), false);
  const clearChange = undone.value.entries.find(entry => entry.undoOf === askChange.id);
  assert.equal(clearChange.undoable, true, 'the explicit-policy reset can itself be undone');

  const restored = await jsonRequest(view, '/api/changes/undo', token, { id: clearChange.id });
  assert.equal(restored.response.status, 200);
  toolView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  assert.equal(toolView.permissions.policies.find(row => row.tool === 'save_synthetic_value').mode, 'ask');
  assert.equal(toolView.permissions.policies.find(row => row.tool === 'save_synthetic_value').explicit, true);

  toolView = (await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'save_synthetic_value', mode: 'always', expectedRevision: toolView.permissions.revision,
  })).value;
  toolView = (await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'save_synthetic_value', mode: 'never', expectedRevision: toolView.permissions.revision,
  })).value;
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const neverChange = changes.entries.find(entry => entry.key === key && entry.afterText === 'Never (explicit)');
  assert.equal(neverChange.undoable, true);
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: neverChange.id })).response.status, 200);
  toolView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  const explicitAlways = toolView.permissions.policies.find(row => row.tool === 'save_synthetic_value');
  assert.equal(explicitAlways.mode, 'always');
  assert.equal(explicitAlways.explicit, true, 'an earlier explicit Always remains explicit when restored');

  toolView = (await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'save_synthetic_value', mode: 'never', expectedRevision: toolView.permissions.revision,
  })).value;
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const independentA = changes.entries.find(entry => entry.key === key && entry.afterText === 'Never (explicit)' && entry.undoable);
  toolView = (await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'read_synthetic_value', mode: 'ask', expectedRevision: toolView.permissions.revision,
  })).value;
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.equal(changes.entries.find(entry => entry.id === independentA.id).undoable, true,
    'changing another tool does not stale this tool\'s exact history entry');
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: independentA.id })).response.status, 200);
  toolView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  assert.equal(toolView.permissions.policies.find(row => row.tool === 'save_synthetic_value').mode, 'always');
  assert.equal(toolView.permissions.policies.find(row => row.tool === 'read_synthetic_value').mode, 'ask');
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: independentA.id })).response.status, 409,
    'a newer change to the same tool makes the older entry stale');

  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  const readChange = changes.entries.find(entry => entry.key === 'tool-permission:read_synthetic_value' && entry.afterText === 'Ask (explicit)');
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: readChange.id })).response.status, 200);
  const livePolicy = (await jsonRequest(view, '/api/changes/detail', token, { key })).value.current.value;
  const [nullNoOp] = await changeLog.record([{
    key: 'tool-permission:read_synthetic_value', area: 'tool-permissions',
    label: 'Tool permission override "read_synthetic_value"', by: 'person',
    before: null, after: null, beforeText: 'nothing', afterText: 'nothing',
  }]);
  const [sameModeNoOp] = await changeLog.record([{
    key, area: 'tool-permissions', label: 'Tool permission override "save_synthetic_value"', by: 'person',
    before: livePolicy, after: livePolicy, beforeText: 'Always (explicit)', afterText: 'Always (explicit)',
  }]);
  changes = (await jsonRequest(view, '/api/changes/view', token, {})).value;
  assert.equal(changes.entries.find(entry => entry.id === nullNoOp.id).undoable, false);
  assert.equal(changes.entries.find(entry => entry.id === sameModeNoOp.id).undoable, false);
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: nullNoOp.id })).response.status, 409);
  assert.equal((await jsonRequest(view, '/api/changes/undo', token, { id: sameModeNoOp.id })).response.status, 409);
});

test('tool permission choices are safe, stale-checked, and gate local execution without changing availability', async t => {
  const data = await fixture(t);
  const permissions = await createToolPermissionStore({ file: path.join(data.directory, 'tool-permissions.json'), clock });
  await permissions.setPolicy({ tool: 'internal_control', mode: 'never', expectedRevision: 0, actor: 'host' });
  const privateValue = 'PRIVATE-PERMISSION-ARGUMENT';
  let effects = 0, callNumber = 0;
  const tools = createToolRegistry([{
    name: 'save_synthetic_value',
    description: 'Save one synthetic browser-test value.',
    permissionSummary: () => 'Save one synthetic value without exposing its contents.',
    inputSchema: {
      type: 'object', properties: { value: { type: 'string', minLength: 1, maxLength: 100 } },
      required: ['value'], additionalProperties: false,
    },
    execute: () => { effects++; return { saved: true }; },
  }, {
    name: 'internal_control',
    description: 'Run one synthetic internal browser control.',
    permission: 'internal',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => true,
  }]);
  const provider = Object.freeze({
    id: 'synthetic/tool-permission-browser',
    complete(request) {
      if (request.messages.at(-1).role === 'tool') {
        const result = JSON.parse(request.messages.at(-1).content);
        return { role: 'assistant', content: result.ok ? 'saved' : 'refused' };
      }
      callNumber++;
      return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: `permission-${callNumber}`, type: 'function',
          function: { name: 'save_synthetic_value', arguments: JSON.stringify({ value: privateValue }) },
        }],
      };
    },
  });
  await assert.rejects(
    startBrowserView({ profile: data.profile, tools, toolPermissions: {} }),
    /toolPermissions must be created by createToolPermissionStore/,
  );
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, tools, toolPermissions: permissions });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.toolPermissions, true);
  assert.equal(boot.capabilities.toolGroups, false, 'permission and availability are separate capabilities');

  let toolView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  assert.equal(toolView.permissions.policies.find(row => row.tool === 'save_synthetic_value').mode, 'always');
  assert.equal(toolView.permissions.policies.some(row => row.tool === 'internal_control'), false);
  assert.ok(toolView.permissions.history.some(row => row.tool === 'internal_control' && row.action === 'policy-retired'));
  assert.equal((await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'internal_control', mode: 'ask', expectedRevision: 0,
  })).response.status, 400);
  assert.equal((await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'missing_tool', mode: 'ask', expectedRevision: 0,
  })).response.status, 400);

  const revisionBeforeAsk = toolView.permissions.revision;
  toolView = (await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'save_synthetic_value', mode: 'ask', expectedRevision: toolView.permissions.revision,
  })).value;
  assert.equal(toolView.permissions.revision, revisionBeforeAsk + 1);
  const refused = await jsonRequest(view, '/api/chat', token, { text: 'save it' });
  assert.equal(refused.response.status, 200);
  assert.equal(effects, 0);
  assert.equal(refused.value.receipt.events.find(event => event.type === 'tool_refused').permission.reason, 'approval-required');
  toolView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  assert.equal(toolView.permissions.pending.length, 1);
  const pending = toolView.permissions.pending[0];
  assert.equal(pending.summary, 'Save one synthetic value without exposing its contents.');
  assert.doesNotMatch(JSON.stringify(toolView.permissions), new RegExp(privateValue));

  const repeated = await jsonRequest(view, '/api/chat', token, { text: 'try the same save again' });
  assert.equal(repeated.response.status, 200);
  const repeatedView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  assert.equal(repeatedView.permissions.pending.length, 1);
  assert.equal(repeatedView.permissions.pending[0].id, pending.id, 'an exact repeat reuses one pending request');
  assert.equal((await jsonRequest(view, '/api/tools/decision', token, {
    requestId: pending.id, expectedFingerprint: '0'.repeat(64), decision: 'once',
  })).response.status, 409);

  toolView = (await jsonRequest(view, '/api/tools/decision', token, {
    requestId: pending.id, expectedFingerprint: pending.fingerprint, decision: 'once',
  })).value;
  assert.equal(toolView.permissions.grants.length, 1);
  const allowed = await jsonRequest(view, '/api/chat', token, { text: 'retry the approved save' });
  assert.equal(allowed.response.status, 200);
  assert.equal(effects, 1);
  assert.deepEqual(allowed.value.receipt.events.find(event => event.type === 'tool_started').permission, {
    mode: 'ask', reason: 'one-time-grant', requestId: pending.id,
  });
  assert.doesNotMatch(JSON.stringify(allowed.value.receipt), new RegExp(privateValue));
  assert.equal((await jsonRequest(view, '/api/tools/view', token, {})).value.permissions.grants.length, 0);

  await jsonRequest(view, '/api/chat', token, { text: 'one more save' });
  assert.equal(effects, 1, 'the one-time approval was consumed');
  toolView = (await jsonRequest(view, '/api/tools/view', token, {})).value;
  assert.equal(toolView.permissions.pending.length, 1);
  toolView = (await jsonRequest(view, '/api/tools/decision', token, {
    requestId: toolView.permissions.pending[0].id,
    expectedFingerprint: toolView.permissions.pending[0].fingerprint,
    decision: 'never',
  })).value;
  assert.equal(toolView.permissions.policies.find(row => row.tool === 'save_synthetic_value').mode, 'never');
  await jsonRequest(view, '/api/chat', token, { text: 'never means never' });
  assert.equal(effects, 1);

  toolView = (await jsonRequest(view, '/api/tools/permission', token, {
    tool: 'save_synthetic_value', mode: 'always', expectedRevision: toolView.permissions.revision,
  })).value;
  assert.equal(toolView.permissions.policies.find(row => row.tool === 'save_synthetic_value').mode, 'always');
  const always = await jsonRequest(view, '/api/chat', token, { text: 'always now' });
  assert.equal(effects, 2);
  assert.deepEqual(always.value.receipt.events.find(event => event.type === 'tool_started').permission, {
    mode: 'always', reason: 'policy-always',
  });
});

test('"check in now" respects the agent\'s own rest unless the person knowingly knocks', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'check-ins.json') });
  const provider = Object.freeze({ id: 'synthetic/sleepy', complete() { return { role: 'assistant', content: '[quiet]' }; } });
  const view = await startBrowserView({ profile: data.profile, provider, archive: data.archive, checkIns });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  await checkIns.takeBreak({ hours: 2 });
  assert.ok((await bootstrapRequest(view, token)).value.checkIns.resting.until);
  const refused = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(refused.response.status, 423);
  assert.match(refused.value.error, /resting until/);
  const knocked = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in', anyway: true });
  assert.equal(knocked.response.status, 200);
});

test('notes from the agent reach the person, and the reply goes back', async t => {
  const data = await fixture(t);
  const { createBuilderNotes } = await import('../src/builder-notes.mjs');
  const builderNotes = await createBuilderNotes({ file: path.join(data.directory, 'builder-notes.json') });
  const view = await startBrowserView({ profile: data.profile, archive: data.archive, builderNotes });
  t.after(() => view.close());
  const { token } = launchAuthorization(view);
  await builderNotes.send({ what: 'Tool search hides my tools', kind: 'confusing' });
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.capabilities.builderNotes, true);
  assert.equal(boot.builderNotesUnread, 1);
  const listed = await jsonRequest(view, '/api/builder/view', token, {});
  const id = listed.value.notes[0].id;
  const answered = await jsonRequest(view, '/api/builder/answer', token, { id, status: 'seen', reply: 'Looking into it.' });
  assert.equal(answered.value.unread, 0);
  assert.equal(answered.value.notes[0].reply, 'Looking into it.');
  assert.equal((await jsonRequest(view, '/api/builder/answer', token, { id, status: 'lost' })).response.status, 400);
});

test('after a model switch the agent is told which model it ran on before', async t => {
  const data = await fixture(t);
  const { createModelHistory } = await import('../src/model-history.mjs');
  const modelHistory = await createModelHistory({ file: path.join(data.directory, 'model-history.json') });
  const seen = [];
  const make = id => Object.freeze({ id, complete(request) { seen.push(request.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n')); return { role: 'assistant', content: 'ok' }; } });
  const first = await startBrowserView({ profile: data.profile, provider: make('synthetic/old-model'), archive: data.archive, modelHistory });
  const firstToken = launchAuthorization(first).token;
  await jsonRequest(first, '/api/chat', firstToken, { text: 'hello' });
  await first.close();
  assert.doesNotMatch(seen[0], /Fieldwork model note/);

  const second = await startBrowserView({ profile: data.profile, provider: make('synthetic/new-model'), archive: data.archive, modelHistory });
  t.after(() => second.close());
  const token = launchAuthorization(second).token;
  await jsonRequest(second, '/api/chat', token, { text: 'hello again' });
  assert.match(seen[1], /You are thinking with synthetic\/new-model since/);
  assert.match(seen[1], /Before that: synthetic\/old-model/);
});

test('tool-effect recovery exposes only safe recoverable rows and enforces fixed person resolutions', async t => {
  const data = await fixture(t);
  const diagnostics = [];
  const effectFile = path.join(data.directory, 'browser-tool-effects.jsonl');
  let effects = await createToolEffectStore(effectFile, { id: 'browser-tool-effects', clock });
  let view = null;
  t.after(async () => {
    try { await view?.close(); } catch { /* Cleanup only. */ }
    try { await effects?.forceClose(); } catch { /* Cleanup only. */ }
  });

  await assert.rejects(
    startBrowserView({ profile: data.profile, toolEffects: {} }),
    /toolEffects must be created by createToolEffectStore/,
  );

  const inputFor = (run, label, permission = { mode: 'always', reason: 'policy-always' }) => ({
    run,
    tool: 'write_file',
    argumentsSha256: hash(`private arguments ${label}`),
    summary: `Write synthetic recovery item ${label}.`,
    permission,
    callIdHash: hash(`private call ${label}`),
  });
  const prepare = async (label, origin = 'local-chat', permission) => {
    const run = await effects.beginRun({ runId: `private-run-${label}`, origin });
    const row = await effects.prepare(inputFor(run, label, permission));
    return { run, row };
  };

  const prepared = await prepare('prepared', 'local-chat', {
    mode: 'ask', reason: 'one-time-grant', requestId: '00000000-0000-4000-8000-000000000001',
  });
  const attempted = await prepare('attempted', 'bridge');
  await effects.beginAttempt({
    run: attempted.run, actionId: attempted.row.actionId, expectedRevision: attempted.row.revision,
  });

  const errored = await prepare('errored', 'fieldwork');
  const errorAttempt = await effects.beginAttempt({
    run: errored.run, actionId: errored.row.actionId, expectedRevision: errored.row.revision,
  });
  await effects.reportOutcome({ capability: errorAttempt.capability, outcome: 'executor-error' });
  await effects.recordRunDisposition({ run: errored.run, disposition: 'run-failed' });

  const interrupted = await prepare('interrupted', 'task-heartbeat');
  const interruptedAttempt = await effects.beginAttempt({
    run: interrupted.run, actionId: interrupted.row.actionId, expectedRevision: interrupted.row.revision,
  });
  await effects.reportOutcome({ capability: interruptedAttempt.capability, outcome: 'interrupted' });
  await effects.recordRunDisposition({ run: interrupted.run, disposition: 'run-failed' });

  const completed = await prepare('completed', 'outside-reader');
  const completedAttempt = await effects.beginAttempt({
    run: completed.run, actionId: completed.row.actionId, expectedRevision: completed.row.revision,
  });
  await effects.reportOutcome({ capability: completedAttempt.capability, outcome: 'executor-returned' });
  await effects.recordRunDisposition({
    run: completed.run,
    disposition: 'discarded',
    conversationId: 'private-conversation-id',
  });

  // Simulate a process ending with two orphan states, then reopen the durable
  // store exactly as the launcher does.
  await effects.forceClose();
  effects = await openToolEffectStore(effectFile, { expectedId: 'browser-tool-effects', clock });
  const active = await prepare('active', 'check-in');

  view = await startBrowserView({
    profile: data.profile,
    toolEffects: effects,
    clock,
    onError(error, receipt) { diagnostics.push({ error, operation: receipt.operation }); },
  });
  const { token } = launchAuthorization(view);
  const boot = (await bootstrapRequest(view, token)).value;
  assert.equal(boot.health.toolEffects.status, 'ready');
  assert.equal(boot.capabilities.toolRecovery, true);
  assert.equal(boot.toolRecovery.available, true);
  assert.equal(boot.toolRecovery.count, 5);
  assert.equal(boot.toolRecovery.shown, 5);
  assert.equal(boot.toolRecovery.settling, 1);
  assert.deepEqual(boot.toolRecovery.items.map(row => row.state).sort(), [
    'attempted-unsettled',
    'executor-error-uncertain',
    'executor-returned-uncommitted',
    'interrupted-uncertain',
    'prepared-not-attempted',
  ]);
  const recoveryText = JSON.stringify(boot.toolRecovery);
  for (const privateValue of [
    'private-run-', '00000000-0000-4000-8000-000000000001', 'private-conversation-id',
    hash('private arguments prepared'), hash('private call prepared'),
  ]) assert.doesNotMatch(recoveryText, new RegExp(privateValue));
  const exposedKeys = new Set();
  JSON.parse(recoveryText, (key, value) => { if (key) exposedKeys.add(key); return value; });
  for (const forbidden of ['runId', 'callIdHash', 'argumentsSha256', 'requestId', 'conversationId', 'result', 'error', 'receipt']) {
    assert.equal(exposedKeys.has(forbidden), false, `recovery must omit ${forbidden}`);
  }

  const byState = new Map(boot.toolRecovery.items.map(row => [row.state, row]));
  const resolve = (row, resolution, confirmed) => jsonRequest(view, '/api/tools/recovery/action', token, {
    id: row.id, expectedRevision: row.revision, resolution, ...(confirmed === undefined ? {} : { confirmed }),
  });
  assert.equal((await jsonRequest(view, '/api/tools/recovery', token, {})).response.status, 200);
  assert.equal((await jsonRequest(view, '/api/tools/recovery/action', token, {
    id: active.row.actionId,
    expectedRevision: active.row.revision,
    resolution: 'abandon-not-attempted',
  })).response.status, 409);
  assert.equal((await jsonRequest(view, '/api/tools/recovery/action', token, {
    id: 'effect:00000000-0000-4000-8000-000000000099',
    expectedRevision: '00000000-0000-4000-8000-000000000099',
    resolution: 'abandon-not-attempted',
  })).response.status, 404);
  assert.equal((await resolve(byState.get('prepared-not-attempted'), 'acknowledge-uncertain')).response.status, 400);
  assert.equal((await resolve(byState.get('prepared-not-attempted'), 'abandon-not-attempted')).response.status, 200);

  const attemptedRow = byState.get('attempted-unsettled');
  assert.equal((await resolve(attemptedRow, 'acknowledge-uncertain', false)).response.status, 400);
  const concurrent = await Promise.all([
    resolve(attemptedRow, 'acknowledge-uncertain', true),
    resolve(attemptedRow, 'acknowledge-uncertain', true),
  ]);
  assert.deepEqual(concurrent.map(result => result.response.status).sort(), [200, 409]);

  assert.equal((await resolve(byState.get('executor-error-uncertain'), 'acknowledge-uncertain', true)).response.status, 200);
  assert.equal((await resolve(byState.get('interrupted-uncertain'), 'acknowledge-uncertain', true)).response.status, 200);
  const completedRow = byState.get('executor-returned-uncommitted');
  assert.equal((await resolve(completedRow, 'acknowledge-uncertain', true)).response.status, 400);
  const final = await resolve(completedRow, 'acknowledge-completed', true);
  assert.equal(final.response.status, 200);
  assert.equal(final.value.toolRecovery.history.length, 5);
  assert.ok(final.value.toolRecovery.history.every(row => !Object.hasOwn(row, 'permission')));
  assert.doesNotMatch(JSON.stringify(final.value.toolRecovery.history), /private-run-|private-conversation-id/);

  await effects.recordRunDisposition({ run: active.run, disposition: 'run-failed' });
  await effects.close();
  const unavailable = await jsonRequest(view, '/api/tools/recovery', token, {});
  assert.equal(unavailable.response.status, 503);
  assert.ok(diagnostics.some(row => row.operation === 'tool-effect-recovery-view'));
  await view.close();
  view = null;
});

test('a saved chat commits returned tool effects only after the conversation commit', async t => {
  const data = await fixture(t);
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'saved-chat-effects.jsonl'), {
    id: 'saved-chat-effects', clock,
  });
  let effectCalls = 0;
  const tools = createToolRegistry([{
    name: 'save_synthetic_value',
    description: 'Save one synthetic value.',
    permissionSummary: () => 'Save one synthetic value.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute() { effectCalls += 1; return { saved: true }; },
  }]);
  const provider = Object.freeze({
    id: 'synthetic/saved-effect-chat',
    complete(request) {
      if (request.messages.at(-1).role === 'tool') return { role: 'assistant', content: 'saved once' };
      return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'save-once', type: 'function', function: { name: 'save_synthetic_value', arguments: '{}' } }],
      };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, tools, toolEffects, archive: data.archive, clock,
  });
  t.after(async () => {
    try { await view.close(); } catch { /* Cleanup only. */ }
    try { await toolEffects.close(); } catch { /* Cleanup only. */ }
  });
  const { token } = launchAuthorization(view);
  const reply = await jsonRequest(view, '/api/chat', token, { text: 'save this once' });
  assert.equal(reply.response.status, 200);
  assert.equal(reply.value.saved, true);
  assert.equal(effectCalls, 1);
  assert.equal((await toolEffects.unresolved()).items.length, 0);
  const terminal = (await toolEffects.history())[0];
  assert.equal(terminal.outcome, 'executor-returned');
  assert.equal(terminal.origin, 'local-chat');
  assert.equal(terminal.runDisposition.status, 'committed');
  assert.equal(terminal.runDisposition.conversationId, reply.value.conversationId);
});

test('a chat archive failure leaves returned effects recoverable with save-failed disposition', async t => {
  const data = await fixture(t);
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'failed-save-effects.jsonl'), {
    id: 'failed-save-effects', clock,
  });
  const tools = createToolRegistry([{
    name: 'save_synthetic_value',
    description: 'Save one synthetic value.',
    permissionSummary: () => 'Save one synthetic value.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ saved: true }),
  }]);
  const provider = Object.freeze({
    id: 'synthetic/failed-save-effect-chat',
    complete(request) {
      if (request.messages.at(-1).role === 'tool') return { role: 'assistant', content: 'this reply cannot be archived' };
      return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'save-before-archive-failure', type: 'function', function: { name: 'save_synthetic_value', arguments: '{}' } }],
      };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, tools, toolEffects, archive: data.archive, clock,
  });
  t.after(async () => {
    try { await view.close(); } catch { /* Cleanup only. */ }
    try { await toolEffects.close(); } catch { /* Cleanup only. */ }
  });
  const { token } = launchAuthorization(view);
  await data.archive.close();
  const reply = await jsonRequest(view, '/api/chat', token, { text: 'save before the archive fails' });
  assert.equal(reply.response.status, 200);
  assert.equal(reply.value.saved, false);
  const unresolved = (await toolEffects.unresolved()).items;
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].state, 'executor-returned-uncommitted');
  assert.equal(unresolved[0].runDisposition.status, 'save-failed');
  assert.equal(unresolved[0].runDisposition.conversationId, reply.value.conversationId);
});

test('a quiet check-in discards returned effects at the keep boundary', async t => {
  const data = await fixture(t);
  const { createCheckInStore } = await import('../src/check-ins.mjs');
  const checkIns = await createCheckInStore({ file: path.join(data.directory, 'quiet-effect-check-ins.json') });
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'quiet-check-in-effects.jsonl'), {
    id: 'quiet-check-in-effects', clock,
  });
  const tools = createToolRegistry([{
    name: 'autonomous_effect',
    description: 'Perform one synthetic autonomous effect.',
    permissionSummary: () => 'Perform one synthetic autonomous effect.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ done: true }),
  }]);
  const provider = Object.freeze({
    id: 'synthetic/quiet-effect-check-in',
    complete(request) {
      if (request.messages.at(-1).role === 'tool') return { role: 'assistant', content: '[quiet]' };
      return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'quiet-effect', type: 'function', function: { name: 'autonomous_effect', arguments: '{}' } }],
      };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, tools, toolEffects, archive: data.archive, checkIns, clock,
  });
  t.after(async () => {
    try { await view.close(); } catch { /* Cleanup only. */ }
    try { await toolEffects.close(); } catch { /* Cleanup only. */ }
  });
  const { token } = launchAuthorization(view);
  const result = await jsonRequest(view, '/api/checkins/now', token, { kind: 'check-in' });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.outcome, 'quiet');
  const unresolved = (await toolEffects.unresolved()).items;
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].origin, 'check-in');
  assert.equal(unresolved[0].state, 'executor-returned-uncommitted');
  assert.equal(unresolved[0].runDisposition.status, 'discarded');
});

test('a timed-out chat keeps its effect run active until the ignored provider settles', async t => {
  const data = await fixture(t);
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'late-timeout-effects.jsonl'), {
    id: 'late-timeout-effects', clock,
  });
  let releaseProvider;
  const tools = createToolRegistry([{
    name: 'slow_followup_effect',
    description: 'Perform one effect before a slow follow-up.',
    permissionSummary: () => 'Perform one effect before a slow follow-up.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ done: true }),
  }]);
  let providerStep = 0;
  const provider = Object.freeze({
    id: 'synthetic/late-timeout-effect-chat',
    complete() {
      providerStep += 1;
      if (providerStep === 1) return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'before-timeout', type: 'function', function: { name: 'slow_followup_effect', arguments: '{}' } }],
      };
      return new Promise(resolve => { releaseProvider = resolve; });
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, tools, toolEffects, archive: data.archive, runTimeoutMs: 1000, clock,
  });
  t.after(async () => {
    releaseProvider?.({ role: 'assistant', content: 'late output' });
    try { await view.close(); } catch { /* Cleanup only. */ }
    try { await toolEffects.forceClose(); } catch { /* Cleanup only. */ }
  });
  const { token } = launchAuthorization(view);
  const timedOut = await jsonRequest(view, '/api/chat', token, { text: 'time out after the effect' });
  assert.equal(timedOut.response.status, 504);
  const whilePending = (await toolEffects.unresolved()).items;
  assert.equal(whilePending.length, 1);
  assert.equal(whilePending[0].runActive, true);
  assert.equal(whilePending[0].runDisposition, null, 'timeout itself does not invent a disposition');

  releaseProvider({ role: 'assistant', content: 'late output that must not be kept' });
  let settled = null;
  for (let tries = 0; tries < 100; tries += 1) {
    [settled] = (await toolEffects.unresolved()).items;
    if (settled && !settled.runActive) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(settled.runActive, false);
  assert.equal(settled.runDisposition.status, 'run-failed');
  assert.deepEqual((await bootstrapRequest(view, token)).value.conversation.messages, []);
});

test('a successful operation that settles after interruption discards its returned effects', async t => {
  const data = await fixture(t);
  const toolEffects = await createToolEffectStore(path.join(data.directory, 'late-success-effects.jsonl'), {
    id: 'late-success-effects', clock,
  });
  const tools = createToolRegistry([{
    name: 'effect_before_interruption',
    description: 'Perform one effect before a synthetic interruption race.',
    permissionSummary: () => 'Perform one effect before a synthetic interruption race.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ done: true }),
  }]);
  let providerStep = 0;
  const provider = Object.freeze({
    id: 'synthetic/late-success-effect-chat',
    complete(request) {
      providerStep += 1;
      if (providerStep === 1) return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'before-interruption', type: 'function', function: { name: 'effect_before_interruption', arguments: '{}' } }],
      };
      // Deterministically make the browser's interruption branch win while
      // leaving the underlying run able to settle successfully afterward.
      request.signal.dispatchEvent(new Event('abort'));
      return { role: 'assistant', content: 'late successful output that must be discarded' };
    },
  });
  const view = await startBrowserView({
    profile: data.profile, provider, tools, toolEffects, archive: data.archive, clock,
  });
  t.after(async () => {
    try { await view.close(); } catch { /* Cleanup only. */ }
    try { await toolEffects.forceClose(); } catch { /* Cleanup only. */ }
  });
  const { token } = launchAuthorization(view);
  const interrupted = await jsonRequest(view, '/api/chat', token, { text: 'interrupt after success is ready' });
  assert.equal(interrupted.response.status, 504);
  let settled = null;
  for (let tries = 0; tries < 100; tries += 1) {
    [settled] = (await toolEffects.unresolved()).items;
    if (settled && !settled.runActive) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(settled.runActive, false);
  assert.equal(settled.state, 'executor-returned-uncommitted');
  assert.equal(settled.runDisposition.status, 'discarded');
  assert.deepEqual((await bootstrapRequest(view, token)).value.conversation.messages, []);
});
