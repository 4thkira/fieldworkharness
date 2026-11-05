import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';
import { buildMemoryForeground } from '../src/memory-foreground.mjs';
import { createMemoryLedger } from '../src/memory-ledger.mjs';
import { createMemoryRecord } from '../src/provenance.mjs';
import { ROOT_MARKER } from '../src/root-context.mjs';
import { createMemoryEventLog, verifyEventChain } from '../src/event-log.mjs';
import { createContextualToolSession, LOAD_TOOL_GROUP, UNLOAD_TOOL_GROUP } from '../src/contextual-tools.mjs';
import { createToolGroupSettings } from '../src/tool-groups.mjs';
import { createToolPermissionStore } from '../src/tool-permissions.mjs';
import { createToolEffectStore } from '../src/tool-effects.mjs';
import { createToolRegistry } from '../src/tools.mjs';
import { FINAL_STEP_NOTE, runConversation, runIsolatedConversation, transcriptContainsInjectedRoots } from '../src/run.mjs';

async function syntheticProfile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-profile-'));
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

const emptyTools = () => createToolRegistry();
const provider = (complete, id = 'synthetic/provider') => ({ id, complete });
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

async function effectFixture(t, runId, { origin = 'local-chat', clock = () => 0 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-effects-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createToolEffectStore(path.join(directory, 'effects.jsonl'), {
    id: `effects-${runId}`,
    clock,
    sync: false,
  });
  const log = createMemoryEventLog({ runId, clock: () => 0 });
  const run = await store.beginRun({ runId, origin });
  let active = true;
  const disposition = async (status = 'run-failed', conversationId = undefined) => {
    const value = await store.recordRunDisposition({
      run,
      disposition: status,
      ...(conversationId === undefined ? {} : { conversationId }),
    });
    active = false;
    return value;
  };
  t.after(async () => {
    if (active) {
      try { await disposition('run-failed'); } catch { /* Cleanup force-close preserves the orphan. */ }
    }
    try { await store.forceClose(); } catch { /* A poison test may intentionally make close fail. */ }
  });
  return { directory, store, log, run, disposition };
}

test('one provider step receives fresh roots while returned history and receipts contain no root text', async t => {
  const profile = await syntheticProfile(t);
  const source = [{ role: 'user', content: 'hello' }];
  let request;
  const log = createMemoryEventLog({ runId: 'one-step', clock: () => 0 });
  const result = await runConversation({
    profile,
    messages: source,
    tools: emptyTools(),
    eventLog: log,
    provider: provider(input => { request = input; return { role: 'assistant', content: 'hello back' }; }),
  });
  assert.equal(Object.isFrozen(request.messages), true);
  assert.match(request.messages[0].content, /SYNTHETIC IDENTITY ROOT/);
  assert.match(request.messages.at(-1).content, /SYNTHETIC VOICE ROOT/);
  assert.equal(result.answer, 'hello back');
  assert.equal(transcriptContainsInjectedRoots(result.messages), false);
  assert.deepEqual(source, [{ role: 'user', content: 'hello' }]);
  const events = await log.read();
  verifyEventChain(events, { expectedHead: result.receipt.head });
  assert.equal(JSON.stringify(events).includes('SYNTHETIC IDENTITY ROOT'), false);
  assert.equal(JSON.stringify(events).includes('SYNTHETIC VOICE ROOT'), false);
  assert.equal(events.find(event => event.type === 'provider_request').data.roots.profile, profile.receipt.fingerprint);
});

test('an isolated run receives exactly its supplied context without profile roots or memory seams', async () => {
  const source = [
    { role: 'system', content: 'SYNTHETIC REVIEW FRAME' },
    { role: 'user', content: 'SYNTHETIC FROZEN RECORD SET' },
  ];
  let request;
  const log = createMemoryEventLog({ runId: 'isolated-review', clock: () => 0 });
  const result = await runIsolatedConversation({
    messages: source,
    tools: emptyTools(),
    eventLog: log,
    provider: provider(input => { request = input; return { role: 'assistant', content: 'reviewed' }; }),
  });
  assert.deepEqual(request.messages, source);
  assert.equal(Object.isFrozen(request.messages), true);
  assert.equal(JSON.stringify(request.messages).includes(ROOT_MARKER), false);
  assert.equal(result.answer, 'reviewed');
  const events = await log.read();
  assert.equal(events.find(event => event.type === 'run_started').data.context, 'isolated');
  const requestEvent = events.find(event => event.type === 'provider_request');
  assert.equal(requestEvent.data.context, 'isolated');
  assert.equal(Object.hasOwn(requestEvent.data, 'roots'), false);
  assert.equal(Object.hasOwn(requestEvent.data, 'memoryForeground'), false);
  await assert.rejects(runIsolatedConversation({
    profile: {}, messages: source, tools: emptyTools(), provider: provider(() => ({})),
  }), /unknown field "profile"/);
  await assert.rejects(runIsolatedConversation({
    memoryForeground: {}, messages: source, tools: emptyTools(), provider: provider(() => ({})),
  }), /unknown field "memoryForeground"/);
});

test('a memory foreground is ephemeral, receipted, and remains before the user-tail voice root', async t => {
  const profile = await syntheticProfile(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-memory-'));
  const ledger = await createMemoryLedger(path.join(directory, 'memory.jsonl'), { ledgerId: 'synthetic-run-memory' });
  t.after(() => ledger.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await ledger.record(createMemoryRecord({
    id: 'memory:orchard', kind: 'authored-memory', text: 'The orchard latch is cobalt.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: '2030-01-02T03:04:05.000Z',
    basis: 'self-authored', confidence: 'asserted',
  }));
  const memoryForeground = await buildMemoryForeground(ledger, 'orchard latch');
  const source = [{ role: 'user', content: 'orchard latch' }];
  let request;
  const log = createMemoryEventLog({ runId: 'memory-foreground-run', clock: () => 0 });
  const result = await runConversation({
    profile, memoryForeground, messages: source, tools: emptyTools(), eventLog: log,
    provider: provider(input => { request = input; return { role: 'assistant', content: 'The latch is cobalt.' }; }),
  });

  const memoryIndex = request.messages.findIndex(message => /orchard latch is cobalt/.test(String(message.content)));
  const userIndex = request.messages.findLastIndex(message => message.role === 'user');
  assert.ok(memoryIndex >= 0 && memoryIndex < userIndex);
  assert.equal(request.messages[memoryIndex].role, 'user', 'memory never gains system authority');
  assert.match(request.messages[userIndex].content, /SYNTHETIC VOICE ROOT/);
  assert.doesNotMatch(request.messages[memoryIndex].content, /SYNTHETIC VOICE ROOT/, "the voice root stays on the person's own message");
  assert.deepEqual(source, [{ role: 'user', content: 'orchard latch' }]);
  assert.equal(JSON.stringify(result.messages).includes('FIELDWORK_MEMORY'), false);
  const events = await log.read();
  const requestEvent = events.find(event => event.type === 'provider_request');
  assert.equal(requestEvent.data.memoryForeground.status, 'ready');
  assert.equal(requestEvent.data.memoryForeground.context.characters > 0, true);
  assert.equal(JSON.stringify(events).includes('The orchard latch is cobalt.'), false, 'the trace keeps the receipt, not memory prose');
});

test('contextual tool groups load and unload only on the next provider step', async t => {
  const profile = await syntheticProfile(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-contextual-run-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = await createToolGroupSettings({ file: path.join(directory, 'tool-groups.json') });
  await settings.set('web', 'on-demand');
  await settings.set('shelf', 'off');
  let webExecutions = 0;
  const base = createToolRegistry([{
    name: 'what_time_is_it',
    description: 'Return one synthetic resident clock value.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ now: 'synthetic' }),
  }, {
    name: 'read_web_page',
    description: 'Read one synthetic on-demand web page.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { webExecutions += 1; return { text: 'synthetic page' }; },
  }, {
    name: 'put_on_shelf',
    description: 'Perform one synthetic shelf write that must stay off.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { throw new Error('off tool must never run'); },
  }]);
  const session = createContextualToolSession({ tools: base, settings });
  assert.match(session.catalogueText(), /Web \(web\) — on-demand: read_web_page/);
  assert.match(session.catalogueText(), /Shelf \(shelf\) — off: put_on_shelf/);
  await assert.rejects(runConversation({
    profile,
    tools: session,
    maxSteps: 0,
    messages: [{ role: 'user', content: 'invalid setup must not consume the session' }],
    provider: provider(() => ({ role: 'assistant', content: 'unreachable' })),
  }), /maxSteps/);
  const requests = [];
  const log = createMemoryEventLog({ runId: 'contextual-tools', clock: () => 0 });
  const result = await runConversation({
    profile,
    tools: session,
    eventLog: log,
    messages: [{ role: 'user', content: 'load, use, then unload the web group' }],
    provider: provider(request => {
      const names = request.tools.map(tool => tool.function.name);
      requests.push(names);
      if (request.step === 1) {
        assert.ok(names.includes('what_time_is_it'));
        assert.ok(names.includes(LOAD_TOOL_GROUP));
        assert.ok(!names.includes('read_web_page'));
        assert.ok(!names.includes('put_on_shelf'));
        return {
          role: 'assistant', content: null,
          tool_calls: [
            { id: 'load-web', type: 'function', function: { name: LOAD_TOOL_GROUP, arguments: '{"group":"web"}' } },
            { id: 'duplicate-load', type: 'function', function: { name: LOAD_TOOL_GROUP, arguments: '{"group":"web"}' } },
            { id: 'too-early', type: 'function', function: { name: 'read_web_page', arguments: '{}' } },
          ],
        };
      }
      if (request.step === 2) {
        assert.ok(names.includes('read_web_page'));
        assert.ok(names.includes(UNLOAD_TOOL_GROUP));
        return {
          role: 'assistant', content: null,
          tool_calls: [
            { id: 'unload-web', type: 'function', function: { name: UNLOAD_TOOL_GROUP, arguments: '{"group":"web"}' } },
            { id: 'same-step-use', type: 'function', function: { name: 'read_web_page', arguments: '{}' } },
          ],
        };
      }
      assert.ok(!names.includes('read_web_page'));
      assert.ok(names.includes(LOAD_TOOL_GROUP));
      return { role: 'assistant', content: 'done' };
    }),
  });
  assert.equal(result.answer, 'done');
  assert.equal(webExecutions, 1, 'loading and unloading never changes sibling-call authority');
  assert.equal(requests.length, 3);
  const events = await log.read();
  const refused = events.find(event => event.type === 'tool_refused' && event.data.callId === 'too-early');
  assert.equal(refused.data.result.effectMayHaveOccurred, false);
  assert.equal(events.some(event => event.type === 'tool_started' && event.data.callId === 'too-early'), false);
  const duplicate = events.find(event => event.type === 'tool_finished' && event.data.callId === 'duplicate-load');
  assert.equal(duplicate.data.result.value.accepted, false, 'the first same-envelope controller request wins');
  assert.deepEqual(events.filter(event => event.type === 'provider_request').map(event => event.data.tools), requests);
  await assert.rejects(runConversation({
    profile,
    tools: session,
    messages: [{ role: 'user', content: 'a second run must not inherit the first run\'s loaded groups' }],
    provider: provider(() => ({ role: 'assistant', content: 'unreachable' })),
  }), /session has already been used/);

  const raced = createContextualToolSession({ tools: base, settings });
  const race = await Promise.allSettled([0, 1].map(index => runConversation({
    profile,
    tools: raced,
    messages: [{ role: 'user', content: `valid concurrent run ${index}` }],
    provider: provider(() => ({ role: 'assistant', content: `winner ${index}` })),
  })));
  assert.equal(race.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(race.filter(outcome => outcome.status === 'rejected' && /session has already been used/.test(String(outcome.reason))).length, 1);

  const runOnly = [{
    name: 'run_only_probe',
    description: 'Return one immutable run-only synthetic probe.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ ok: true }),
  }];
  const captured = createContextualToolSession({ tools: base, settings, extraResident: runOnly });
  runOnly[0].name = 'mutated_probe';
  runOnly.push({
    name: 'late_probe',
    description: 'A late mutation that must not enter the session.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ ok: false }),
  });
  assert.ok(captured.stepRegistry().names.includes('run_only_probe'));
  assert.ok(!captured.stepRegistry().names.includes('mutated_probe'));
  assert.ok(!captured.stepRegistry().names.includes('late_probe'));

  const fresh = createContextualToolSession({ tools: base, settings });
  assert.ok(!fresh.stepRegistry().names.includes('read_web_page'), 'a new run forgets transient loads');
  await settings.set('web', 'off');
  const hardOff = createContextualToolSession({ tools: base, settings });
  assert.ok(!hardOff.stepRegistry().names.includes(LOAD_TOOL_GROUP));
  assert.match(hardOff.catalogueText(), /Web \(web\) — off/);
});

test('a tool-loop foreground follows ledger changes before the next provider step', async t => {
  const profile = await syntheticProfile(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-memory-refresh-'));
  const ledger = await createMemoryLedger(path.join(directory, 'memory.jsonl'), { ledgerId: 'synthetic-run-memory-refresh' });
  t.after(() => ledger.close());
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = createMemoryRecord({
    id: 'memory:orchard', kind: 'authored-memory', text: 'The orchard latch is cobalt.',
    author: { kind: 'agent', id: 'synthetic-agent' }, createdAt: '2030-01-02T03:04:05.000Z',
    basis: 'self-authored', confidence: 'asserted',
  });
  await ledger.record(original);
  const memoryForeground = await buildMemoryForeground(ledger, 'orchard latch');
  const tools = createToolRegistry([{
    name: 'forget_orchard', description: 'Retract the synthetic orchard memory.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: async () => {
      await ledger.retract({
        id: original.id, expectedFingerprint: original.fingerprint, expectedSequence: 2,
        actor: { kind: 'agent', id: 'synthetic-agent' }, reason: 'The synthetic claim is no longer current.',
      });
      return { forgotten: true };
    },
  }]);
  const requests = [];
  const log = createMemoryEventLog({ runId: 'memory-foreground-refresh-run', clock: () => 0 });
  await runConversation({
    profile, memoryForeground, tools, eventLog: log,
    messages: [{ role: 'user', content: 'orchard latch' }],
    provider: provider(input => {
      requests.push(input);
      if (requests.length === 1) return {
        role: 'assistant', content: 'I will retract that memory.',
        tool_calls: [{ id: 'forget-1', type: 'function', function: { name: 'forget_orchard', arguments: '{}' } }],
      };
      return { role: 'assistant', content: 'The retraction is current.' };
    }),
  });

  assert.match(JSON.stringify(requests[0].messages), /The orchard latch is cobalt/);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /The orchard latch is cobalt/);
  const requestEvents = (await log.read()).filter(event => event.type === 'provider_request');
  assert.deepEqual(requestEvents.map(event => event.data.memoryForeground.status), ['ready', 'empty']);
  assert.equal(requestEvents[1].data.memoryForeground.reason, 'no-current-memories');
});

test('a tool loop validates once, records effects, and reassembles one tail without storing it', async t => {
  const profile = await syntheticProfile(t);
  const seen = [];
  const tools = createToolRegistry([{
    name: 'add_numbers',
    description: 'Add two small integers for a synthetic test.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    execute: args => { seen.push(args); return { total: args.a + args.b }; },
  }]);
  let step = 0;
  const requests = [];
  const log = createMemoryEventLog({ runId: 'tool-loop', clock: () => step });
  const result = await runConversation({
    profile, tools, messages: [{ role: 'user', content: 'add them' }],
    eventLog: log,
    provider: provider(input => {
      requests.push(input);
      step++;
      if (step === 1) return {
        role: 'assistant', content: 'I will calculate.',
        tool_calls: [{ id: 'sum-1', type: 'function', function: { name: 'add_numbers', arguments: '{"a":2,"b":3}' } }],
      };
      const tool = input.messages.at(-1);
      assert.equal(tool.role, 'tool');
      assert.equal(JSON.parse(tool.content).value.total, 5);
      return { role: 'assistant', content: 'The total is 5.' };
    }),
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].function.name, 'add_numbers');
  for (const request of requests) {
    const text = JSON.stringify(request.messages);
    assert.equal(text.split(ROOT_MARKER).length - 1, 1);
  }
  assert.deepEqual(seen[0], { a: 2, b: 3 });
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(result.answer, 'I will calculate.\n\nThe total is 5.');
  assert.equal(transcriptContainsInjectedRoots(result.messages), false);
  const toolMessage = result.messages.find(message => message.role === 'tool');
  assert.match(JSON.parse(toolMessage.content).receipt.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual((await log.read()).find(event => event.type === 'tool_started').data.permission, {
    mode: 'not-configured', reason: 'no-store',
  });
});

test('an exact tracked input may enter its executor only twice in one run', async t => {
  const profile = await syntheticProfile(t);
  let executions = 0, step = 0;
  const tools = createToolRegistry([{
    name: 'repeat_effect', description: 'Perform one synthetic repeat-budget effect.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'], additionalProperties: false,
    },
    execute: ({ a, b }) => { executions += 1; return { saved: a + b }; },
  }]);
  const equivalentArguments = ['{"a":1,"b":2}', ' { "b": 2, "a": 1 } ', '{"b":2,"a":1}'];
  const log = createMemoryEventLog({ runId: 'tracked-repeat-budget', clock: () => 0 });
  const result = await runConversation({
    profile, tools, eventLog: log, messages: [{ role: 'user', content: 'repeat one exact effect' }],
    provider: provider(input => {
      step += 1;
      if (step <= 3) return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: `repeat-${step}`, type: 'function',
          function: { name: 'repeat_effect', arguments: equivalentArguments[step - 1] },
        }],
      };
      const refusal = JSON.parse(input.messages.at(-1).content);
      assert.equal(refusal.ok, false);
      assert.equal(refusal.effectMayHaveOccurred, false);
      assert.match(refusal.error, /already entered its executor 2 times/);
      return { role: 'assistant', content: 'stopped at the budget' };
    }),
  });

  assert.equal(executions, 2);
  assert.equal(result.answer, 'stopped at the budget');
  const events = await log.read();
  assert.equal(events.filter(event => event.type === 'tool_started').length, 2);
  const refused = events.find(event => event.type === 'tool_refused' && event.data.callId === 'repeat-3');
  assert.deepEqual(refused.data.budget, {
    kind: 'tracked-attempts-per-input',
    limit: 2,
    attempted: 2,
    argumentsSha256: sha256('{"a":1,"b":2}'),
  });
  assert.equal(refused.data.result.effectMayHaveOccurred, false);
  assert.equal(events.some(event => event.data?.callId === 'repeat-3' && event.type === 'tool_started'), false);
});

test('tracked repeat budgets are independent for each tool and canonical input', async t => {
  const profile = await syntheticProfile(t);
  const executions = [];
  const definition = name => ({
    name, description: `Perform the synthetic ${name} effect.`,
    inputSchema: {
      type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false,
    },
    execute: ({ value }) => { executions.push(`${name}:${value}`); return true; },
  });
  const tools = createToolRegistry([definition('effect_one'), definition('effect_two')]);
  const calls = [
    ['effect_one', 1], ['effect_one', 1],
    ['effect_two', 1], ['effect_two', 1],
    ['effect_one', 2], ['effect_one', 2],
  ];
  let step = 0;
  const log = createMemoryEventLog({ runId: 'tracked-independent-budgets', clock: () => 0 });
  await runConversation({
    profile, tools, eventLog: log, messages: [{ role: 'user', content: 'run distinct effects' }],
    provider: provider(() => {
      const next = calls[step];
      step += 1;
      if (!next) return { role: 'assistant', content: 'done' };
      const [name, value] = next;
      return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: `distinct-${step}`, type: 'function',
          function: { name, arguments: JSON.stringify({ value }) },
        }],
      };
    }),
  });

  assert.deepEqual(executions, [
    'effect_one:1', 'effect_one:1',
    'effect_two:1', 'effect_two:1',
    'effect_one:2', 'effect_one:2',
  ]);
  assert.equal((await log.read()).some(event => event.type === 'tool_refused'), false);
});

test('read-only tools are not consumed by the tracked repeat budget', async t => {
  const profile = await syntheticProfile(t);
  let executions = 0, step = 0;
  const tools = createToolRegistry([{
    name: 'repeat_read', description: 'Read one synthetic value repeatedly.', effect: 'read-only',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { executions += 1; return { observed: executions }; },
  }]);
  const log = createMemoryEventLog({ runId: 'read-only-repeat-budget', clock: () => 0 });
  await runConversation({
    profile, tools, eventLog: log, messages: [{ role: 'user', content: 'read repeatedly' }],
    provider: provider(() => {
      step += 1;
      if (step <= 3) return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: `read-${step}`, type: 'function', function: { name: 'repeat_read', arguments: '{}' },
        }],
      };
      return { role: 'assistant', content: 'done' };
    }),
  });

  assert.equal(executions, 3);
  const events = await log.read();
  assert.equal(events.filter(event => event.type === 'tool_started').length, 3);
  assert.equal(events.some(event => event.type === 'tool_refused'), false);
});

test('a permission refusal does not consume the tracked repeat budget', async t => {
  const profile = await syntheticProfile(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-repeat-permission-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const permissions = await createToolPermissionStore({ file: path.join(directory, 'permissions.json') });
  await permissions.setPolicy({ tool: 'permission_repeat', mode: 'ask', expectedRevision: 0 });
  let executions = 0, step = 0;
  const tools = createToolRegistry([{
    name: 'permission_repeat', description: 'Perform one permission-gated repeat-budget effect.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { executions += 1; return true; },
  }]);
  const log = createMemoryEventLog({ runId: 'permission-repeat-budget', clock: () => 0 });
  await runConversation({
    profile, tools, eventLog: log, toolPermissions: permissions,
    toolPermissionContext: { origin: 'local-chat', interactive: true },
    messages: [{ role: 'user', content: 'ask, then repeat' }],
    provider: provider(async input => {
      step += 1;
      if (step === 2) {
        const refused = JSON.parse(input.messages.at(-1).content);
        assert.equal(refused.permission.reason, 'approval-required');
        await permissions.setPolicy({
          tool: 'permission_repeat', mode: 'always', expectedRevision: permissions.view().revision,
        });
      }
      if (step <= 4) return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: `permission-repeat-${step}`, type: 'function',
          function: { name: 'permission_repeat', arguments: '{}' },
        }],
      };
      return { role: 'assistant', content: 'done' };
    }),
  });

  assert.equal(executions, 2);
  const events = await log.read();
  assert.equal(events.filter(event => event.type === 'tool_started').length, 2);
  assert.equal(events.filter(event => event.type === 'tool_refused').length, 2);
  assert.equal(events.find(event => event.data?.callId === 'permission-repeat-1').data.result.permission.reason, 'approval-required');
  assert.equal(events.find(event => event.data?.callId === 'permission-repeat-4').data.budget.attempted, 2);
});

test('unknown, malformed, excessive and final-step calls are paired with refusals and never execute', async t => {
  const profile = await syntheticProfile(t);
  let executions = 0, turn = 0;
  const log = createMemoryEventLog({ runId: 'refusal-effects', clock: () => 0 });
  const tools = createToolRegistry([{
    name: 'small_action', description: 'Perform one tiny synthetic action for testing.',
    inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
    execute: () => { executions++; return true; },
  }]);
  const calls = [
    { id: 'bad-json', type: 'function', function: { name: 'small_action', arguments: '{' } },
    { id: 'unknown', type: 'function', function: { name: 'missing_tool', arguments: '{}' } },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `extra-${index}`, type: 'function', function: { name: 'small_action', arguments: JSON.stringify({ value: index }) } })),
  ];
  const result = await runConversation({
    profile, tools, eventLog: log, messages: [{ role: 'user', content: 'try calls' }], maxSteps: 2,
    provider: provider(input => {
      turn++;
      if (turn === 1) return { role: 'assistant', content: null, tool_calls: calls };
      assert.equal(input.messages.filter(message => message.role === 'tool').length, calls.length);
      return {
        role: 'assistant', content: 'final call will not run',
        tool_calls: [{ id: 'last', type: 'function', function: { name: 'small_action', arguments: '{"value":1}' } }],
      };
    }),
  });
  assert.equal(executions, 6, 'two invalid calls plus calls 9-10 are refused; six valid calls run');
  assert.equal(result.status, 'exhausted');
  const last = JSON.parse(result.messages.at(-1).content);
  assert.match(last.error, /final provider step/);
  const events = await log.read();
  const malformed = events.find(event => event.type === 'tool_refused' && event.data.callId === 'bad-json');
  assert.equal(malformed.data.result.effectMayHaveOccurred, false);
  assert.equal(events.some(event => event.type === 'tool_started' && event.data.callId === 'bad-json'), false);
});

test('Ask refuses before tool start, and one exact approved retry runs only once', async t => {
  const profile = await syntheticProfile(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-permissions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const permissions = await createToolPermissionStore({ file: path.join(directory, 'permissions.json') });
  await permissions.setPolicy({ tool: 'save_value', mode: 'ask', expectedRevision: 0 });
  let executions = 0;
  const tools = createToolRegistry([{
    name: 'save_value', description: 'Save one synthetic value for permission testing.',
    inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
    execute: ({ value }) => { executions++; return { saved: value }; },
  }]);
  const call = value => ({ id: `save-${value}`, type: 'function', function: { name: 'save_value', arguments: JSON.stringify({ value }) } });
  const run = async (value, id) => {
    let step = 0;
    const log = createMemoryEventLog({ runId: id, clock: () => 0 });
    const result = await runConversation({
      profile, tools, eventLog: log, toolPermissions: permissions,
      toolPermissionContext: { origin: 'local-chat', interactive: true },
      messages: [{ role: 'user', content: `save ${value}` }],
      provider: provider(input => {
        step++;
        if (step === 1) return { role: 'assistant', content: null, tool_calls: [call(value)] };
        const tool = JSON.parse(input.messages.at(-1).content);
        return { role: 'assistant', content: tool.ok ? 'saved' : 'not saved' };
      }),
    });
    return { result, events: await log.read() };
  };

  const asked = await run(7, 'permission-ask');
  assert.equal(executions, 0);
  assert.equal(asked.result.answer, 'not saved');
  assert.equal(asked.events.some(event => event.type === 'tool_started'), false);
  const refused = asked.events.find(event => event.type === 'tool_refused');
  assert.equal(refused.data.result.effectMayHaveOccurred, false);
  assert.equal(refused.data.result.permission.reason, 'approval-required');
  const request = permissions.view(['save_value']).pending[0];
  assert.equal(request.tool, 'save_value');

  await permissions.decide({
    requestId: request.id, expectedFingerprint: request.fingerprint, decision: 'once',
  });
  const allowed = await run(7, 'permission-once');
  assert.equal(executions, 1);
  assert.equal(allowed.result.answer, 'saved');
  assert.equal(allowed.events.filter(event => event.type === 'tool_started').length, 1);
  assert.deepEqual(allowed.events.find(event => event.type === 'tool_started').data.permission, {
    mode: 'ask', reason: 'one-time-grant', requestId: request.id,
  });
  assert.equal(permissions.view().grants.length, 0);

  const askedAgain = await run(7, 'permission-ask-again');
  assert.equal(executions, 1);
  assert.equal(askedAgain.result.answer, 'not saved');
  assert.equal(permissions.view().pending.length, 1);
});

test('Ask is nonactionable in autonomous runs while internal tools bypass person policy', async t => {
  const profile = await syntheticProfile(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-autonomous-permissions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const permissions = await createToolPermissionStore({ file: path.join(directory, 'permissions.json') });
  await permissions.setPolicy({ tool: 'ordinary_probe', mode: 'ask', expectedRevision: 0 });
  await permissions.setPolicy({ tool: 'internal_probe', mode: 'never', expectedRevision: 1 });
  let ordinary = 0, internal = 0, step = 0;
  const tools = createToolRegistry([{
    name: 'ordinary_probe', description: 'Run one configurable synthetic permission probe.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { ordinary++; return true; },
  }, {
    name: 'internal_probe', description: 'Run one internal synthetic control probe.', permission: 'internal',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { internal++; return true; },
  }]);
  const log = createMemoryEventLog({ runId: 'autonomous-permission', clock: () => 0 });
  await runConversation({
    profile, tools, eventLog: log, toolPermissions: permissions,
    toolPermissionContext: { origin: 'task-heartbeat', interactive: false },
    messages: [{ role: 'user', content: 'run probes' }],
    provider: provider(() => {
      step++;
      if (step === 1) return { role: 'assistant', content: null, tool_calls: [
        { id: 'ordinary', type: 'function', function: { name: 'ordinary_probe', arguments: '{}' } },
        { id: 'internal', type: 'function', function: { name: 'internal_probe', arguments: '{}' } },
      ] };
      return { role: 'assistant', content: 'done' };
    }),
  });
  assert.equal(ordinary, 0);
  assert.equal(internal, 1);
  assert.equal(permissions.view().pending.length, 0);
  const events = await log.read();
  assert.equal(events.find(event => event.data?.callId === 'ordinary').data.result.permission.reason, 'approval-unavailable');
  assert.equal(events.some(event => event.type === 'tool_started' && event.data.callId === 'ordinary'), false);
  assert.deepEqual(events.find(event => event.type === 'tool_started' && event.data.callId === 'internal').data.permission, {
    mode: 'internal', reason: 'internal',
  });
});

test('schema and permission-store failures refuse before any tool effect', async t => {
  const profile = await syntheticProfile(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-permission-failure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state', 'permissions.json');
  const permissions = await createToolPermissionStore({ file });
  await permissions.setPolicy({ tool: 'bounded_effect', mode: 'ask', expectedRevision: 0 });
  await fs.rm(path.dirname(file), { recursive: true, force: true });
  await fs.writeFile(path.dirname(file), 'blocks permission persistence');
  let effects = 0, step = 0;
  const tools = createToolRegistry([{
    name: 'bounded_effect', description: 'Perform one schema-bounded synthetic effect.',
    inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
    execute: () => { effects++; return true; },
  }]);
  const log = createMemoryEventLog({ runId: 'permission-store-failure', clock: () => 0 });
  await runConversation({
    profile, tools, eventLog: log, toolPermissions: permissions,
    toolPermissionContext: { origin: 'local-chat', interactive: true },
    messages: [{ role: 'user', content: 'try both' }],
    provider: provider(() => {
      step++;
      if (step === 1) return { role: 'assistant', content: null, tool_calls: [
        { id: 'bad-schema', type: 'function', function: { name: 'bounded_effect', arguments: '{"value":"wrong"}' } },
        { id: 'failed-check', type: 'function', function: { name: 'bounded_effect', arguments: '{"value":1}' } },
      ] };
      return { role: 'assistant', content: 'both refused' };
    }),
  });
  assert.equal(effects, 0);
  const events = await log.read();
  for (const callId of ['bad-schema', 'failed-check']) {
    assert.equal(events.some(event => event.type === 'tool_started' && event.data.callId === callId), false);
    assert.equal(events.find(event => event.type === 'tool_refused' && event.data.callId === callId).data.result.effectMayHaveOccurred, false);
  }
  assert.match(events.find(event => event.data?.callId === 'bad-schema').data.result.error, /must be integer/);
  assert.equal(events.find(event => event.data?.callId === 'failed-check').data.result.permission.reason, 'check-failed');
});

test('multimodal input remains unchanged and provider requests are immutable', async t => {
  const profile = await syntheticProfile(t);
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const source = [{ role: 'user', content: [image] }];
  const result = await runConversation({
    profile, messages: source, tools: emptyTools(),
    provider: provider(input => {
      assert.deepEqual(input.messages.at(-1).content[0], image);
      assert.equal(Object.isFrozen(input.messages.at(-1).content[0].image_url), true);
      return { role: 'assistant', content: [{ type: 'text', text: 'I can answer.' }] };
    }),
  });
  assert.equal(result.answer, 'I can answer.');
  assert.equal(Object.isFrozen(source[0].content[0].image_url), false, 'source objects are not frozen as a side effect');
  assert.deepEqual(source, [{ role: 'user', content: [image] }]);
});

test('invalid replies and provider failures leave bounded failure receipts', async t => {
  const profile = await syntheticProfile(t);
  const invalidLog = createMemoryEventLog({ runId: 'invalid-reply', clock: () => 0 });
  await assert.rejects(runConversation({
    profile, messages: [{ role: 'user', content: 'hello' }], tools: emptyTools(), eventLog: invalidLog,
    provider: provider(() => ({ role: 'assistant', content: '' })),
  }), /neither visible content nor a tool call/);
  assert.equal((await invalidLog.read()).at(-1).type, 'run_failed');

  const failedLog = createMemoryEventLog({ runId: 'provider-failure', clock: () => 0 });
  await assert.rejects(runConversation({
    profile, messages: [{ role: 'user', content: 'hello' }], tools: emptyTools(), eventLog: failedLog,
    provider: provider(() => { throw new Error('synthetic outage'); }),
  }), /synthetic outage/);
  assert.deepEqual((await failedLog.read()).slice(-2).map(event => event.type), ['provider_failed', 'run_failed']);
});

test('cancellation stops later tools and records an interrupted run', async t => {
  const profile = await syntheticProfile(t);
  const controller = new AbortController();
  let second = 0;
  const tools = createToolRegistry([{
    name: 'stop_now', description: 'Abort this synthetic run during its first action.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { controller.abort(new Error('operator stopped')); return true; },
  }, {
    name: 'later_action', description: 'A later synthetic action that must not execute.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { second++; return true; },
  }]);
  const log = createMemoryEventLog({ runId: 'cancelled', clock: () => 0 });
  await assert.rejects(runConversation({
    profile, tools, eventLog: log, signal: controller.signal, messages: [{ role: 'user', content: 'stop' }],
    provider: provider(() => ({ role: 'assistant', content: null, tool_calls: [
      { id: 'one', type: 'function', function: { name: 'stop_now', arguments: '{}' } },
      { id: 'two', type: 'function', function: { name: 'later_action', arguments: '{}' } },
    ] })),
  }), /operator stopped/);
  assert.equal(second, 0);
  assert.equal((await log.read()).at(-1).type, 'run_stopped');
});

test('a run refuses reused logs, invalid providers, and malformed history before effects', async t => {
  const profile = await syntheticProfile(t);
  const log = createMemoryEventLog({ runId: 'already-used', clock: () => 0 });
  await log.append('existing', {});
  await assert.rejects(runConversation({
    profile, eventLog: log, tools: emptyTools(), messages: [{ role: 'user', content: 'x' }], provider: provider(() => ({ role: 'assistant', content: 'x' })),
  }), /already contains events/);
  await assert.rejects(runConversation({ profile, tools: emptyTools(), messages: [{ role: 'user', content: 'x' }], provider: { complete() {} } }), /provider\.id/);
  await assert.rejects(runConversation({ profile, tools: emptyTools(), messages: [{ role: 'unknown', content: 'x' }], provider: provider(() => ({})) }), /role "unknown" is not supported/);
});

test('the run layer rejects malformed and bare content parts on both sides of the provider boundary', async t => {
  const profile = await syntheticProfile(t);
  let calls = 0;
  const inertProvider = provider(() => {
    calls++;
    return { role: 'assistant', content: 'unreachable' };
  });
  await assert.rejects(runConversation({
    profile, tools: emptyTools(), provider: inertProvider,
    messages: [{ role: 'user', content: [{ type: 'text' }] }],
  }), /messages\[0\]\.content\[0\]\.text must be own data text/);
  await assert.rejects(runConversation({
    profile, tools: emptyTools(), provider: inertProvider,
    messages: [{ role: 'user', content: ['bare text is not a declared content part'] }],
  }), /messages\[0\]\.content\[0\] must be a content-part object/);
  assert.equal(calls, 0);

  await assert.rejects(runConversation({
    profile, tools: emptyTools(), messages: [{ role: 'user', content: 'hello' }],
    provider: provider(() => ({ role: 'assistant', content: [{ type: 'text' }] })),
  }), /provider reply content\[0\]\.text must be own data text/);
  await assert.rejects(runConversation({
    profile, tools: emptyTools(), messages: [{ role: 'user', content: 'hello' }],
    provider: provider(() => ({ role: 'assistant', content: ['bare provider text'] })),
  }), /provider reply content\[0\] must be a content-part object/);
});

test('run input accessors are rejected and a validated provider method is captured once', async t => {
  let accessorReads = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, 'provider', {
    enumerable: true,
    get() { accessorReads++; return provider(() => ({})); },
  });
  await assert.rejects(runConversation(accessorInput), /input\.provider must be an enumerable data property/);
  assert.equal(accessorReads, 0);

  const profile = await syntheticProfile(t);
  let validatedCalls = 0, replacementCalls = 0;
  const mutableProvider = {
    id: 'synthetic/mutable-provider',
    complete() {
      validatedCalls++;
      assert.equal(this, mutableProvider);
      if (validatedCalls === 1) {
        mutableProvider.complete = () => {
          replacementCalls++;
          return { role: 'assistant', content: 'unvalidated replacement ran' };
        };
        return {
          role: 'assistant', content: 'Continue through one tool.',
          tool_calls: [{ id: 'continue', type: 'function', function: { name: 'continue_once', arguments: '{}' } }],
        };
      }
      return { role: 'assistant', content: 'Captured provider finished.' };
    },
  };
  const tools = createToolRegistry([{
    name: 'continue_once', description: 'Provide one synthetic continuation step.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => true,
  }]);
  const result = await runConversation({
    profile, tools, provider: mutableProvider,
    messages: [{ role: 'user', content: 'continue' }],
  });
  assert.equal(result.status, 'completed');
  assert.equal(validatedCalls, 2);
  assert.equal(replacementCalls, 0);
});

test('transcript bounds stop side-effecting tools before an oversized reply can run them', async t => {
  const profile = await syntheticProfile(t);
  let executions = 0;
  const tools = createToolRegistry([{
    name: 'bounded_effect', description: 'A synthetic effect that must remain uncalled.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { executions++; return true; },
  }]);
  await assert.rejects(runConversation({
    profile, tools, maxTranscriptBytes: 200,
    messages: [{ role: 'user', content: 'bounded' }],
    provider: provider(() => ({
      role: 'assistant', content: 'R'.repeat(300),
      tool_calls: [{ id: 'must-not-run', type: 'function', function: { name: 'bounded_effect', arguments: '{}' } }],
    })),
  }), /transcript is .* JSON bytes; the limit is 200/);
  assert.equal(executions, 0);
});

test('an oversized first tool result prevents every later tool effect in the step', async t => {
  const profile = await syntheticProfile(t);
  let first = 0, second = 0;
  const tools = createToolRegistry([{
    name: 'large_result', description: 'Return one large synthetic result.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { first++; return 'X'.repeat(350); },
  }, {
    name: 'later_effect', description: 'A later synthetic effect that must not execute.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { second++; return true; },
  }]);
  await assert.rejects(runConversation({
    profile, tools, maxTranscriptBytes: 500, maxToolResultBytes: 1000,
    messages: [{ role: 'user', content: 'run bounded tools' }],
    provider: provider(() => ({
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'large', type: 'function', function: { name: 'large_result', arguments: '{}' } },
        { id: 'later', type: 'function', function: { name: 'later_effect', arguments: '{}' } },
      ],
    })),
  }), /transcript is .* JSON bytes; the limit is 500/);
  assert.equal(first, 1);
  assert.equal(second, 0);
});

test('tracked run inputs are paired, branded, and bound to the exact event run and permission origin', async t => {
  const profile = await syntheticProfile(t);
  const fx = await effectFixture(t, 'effect-input-run');
  const other = await effectFixture(t, 'other-effect-input-run');
  const base = {
    profile,
    messages: [{ role: 'user', content: 'hello' }],
    tools: emptyTools(),
    provider: provider(() => ({ role: 'assistant', content: 'hello' })),
  };

  await assert.rejects(runConversation({ ...base, toolEffects: fx.store }), /must be supplied together/);
  await assert.rejects(runConversation({ ...base, toolEffectRun: fx.run }), /must be supplied together/);
  await assert.rejects(runConversation({ ...base, toolEffects: {}, toolEffectRun: fx.run }), /createToolEffectStore/);
  await assert.rejects(runConversation({
    ...base,
    eventLog: createMemoryEventLog({ runId: 'effect-input-run', clock: () => 0 }),
    toolEffects: other.store,
    toolEffectRun: fx.run,
  }), /active run capability/);
  const mismatchedLog = createMemoryEventLog({ runId: 'different-event-run', clock: () => 0 });
  await assert.rejects(runConversation({
    ...base,
    eventLog: mismatchedLog,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
  }), /different event-log run/);
  assert.equal((await mismatchedLog.read()).length, 0);
  const originLog = createMemoryEventLog({ runId: 'effect-input-run', clock: () => 0 });
  const permissionsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-run-effect-input-permissions-'));
  t.after(() => fs.rm(permissionsDirectory, { recursive: true, force: true }));
  const permissions = await createToolPermissionStore({ file: path.join(permissionsDirectory, 'permissions.json') });
  await assert.rejects(runConversation({
    ...base,
    eventLog: originLog,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
    toolPermissions: permissions,
    toolPermissionContext: { origin: 'bridge', interactive: false },
  }), /origin must match/);
  assert.equal((await originLog.read()).length, 0);

  await fx.disposition('run-failed');
  await other.disposition('run-failed');
});

test('a tracked tool crosses its durable attempt before executor entry and waits for external commit', async t => {
  const profile = await syntheticProfile(t);
  const fx = await effectFixture(t, 'tracked-success-run');
  let attemptsSeen = 0, providerCalls = 0;
  const privateArgument = 'synthetic-private-argument';
  const tools = createToolRegistry([{
    name: 'save_item',
    description: 'Save one synthetic item for durable effect testing.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    execute: async () => {
      const view = await fx.store.unresolved();
      assert.equal(view.total, 1);
      assert.equal(view.items[0].state, 'attempted-unsettled');
      assert.equal(view.items[0].executorActive, true);
      attemptsSeen++;
      return { saved: true };
    },
  }]);
  const result = await runConversation({
    profile,
    tools,
    eventLog: fx.log,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
    messages: [{ role: 'user', content: 'save it' }],
    provider: provider(input => {
      providerCalls++;
      if (providerCalls === 1) return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'save-private',
          type: 'function',
          function: { name: 'save_item', arguments: JSON.stringify({ value: privateArgument }) },
        }],
      };
      assert.equal(JSON.parse(input.messages.at(-1).content).value.saved, true);
      return { role: 'assistant', content: 'saved' };
    }),
  });
  assert.equal(result.answer, 'saved');
  assert.equal(attemptsSeen, 1);
  assert.equal(providerCalls, 2);
  const pending = await fx.store.unresolved();
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].state, 'executor-returned-uncommitted');
  assert.equal(pending.items[0].runActive, true);
  const started = (await fx.log.read()).find(event => event.type === 'tool_started');
  assert.equal(Object.hasOwn(started.data, 'arguments'), false);
  assert.equal(JSON.stringify(started).includes(privateArgument), false);
  assert.equal(typeof started.data.effectId, 'string');

  const disposition = await fx.disposition('committed', 'conv-tracked-success');
  assert.equal(disposition.completed, 1);
  assert.equal((await fx.store.unresolved()).total, 0);
});

test('an unresolved effect fences before a one-time grant can be consumed', async t => {
  const profile = await syntheticProfile(t);
  const fx = await effectFixture(t, 'fenced-current-run');
  const priorRun = await fx.store.beginRun({ runId: 'fenced-prior-run', origin: 'local-chat' });
  const argumentsSha256 = sha256('{"value":7}');
  const prior = await fx.store.prepare({
    run: priorRun,
    tool: 'save_value',
    argumentsSha256,
    summary: 'Save one synthetic value.',
    permission: { mode: 'not-configured', reason: 'no-store' },
    callIdHash: sha256('prior-call'),
  });
  await fx.store.recordRunDisposition({ run: priorRun, disposition: 'run-failed' });

  const permissions = await createToolPermissionStore({ file: path.join(fx.directory, 'permissions.json') });
  await permissions.setPolicy({ tool: 'save_value', mode: 'ask', expectedRevision: 0 });
  await permissions.authorize({
    tool: 'save_value', argumentsSha256, summary: 'Save one synthetic value.',
    origin: 'local-chat', interactive: true, callId: 'approval-call', step: 1, runId: 'approval-run',
  });
  const request = permissions.view(['save_value']).pending[0];
  await permissions.decide({
    requestId: request.id,
    expectedFingerprint: request.fingerprint,
    decision: 'once',
  });
  let executions = 0, providerCalls = 0;
  const tools = createToolRegistry([{
    name: 'save_value',
    description: 'Save one synthetic value for a fence ordering test.',
    inputSchema: {
      type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false,
    },
    execute: () => { executions++; return true; },
  }]);
  await assert.rejects(runConversation({
    profile,
    tools,
    eventLog: fx.log,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
    toolPermissions: permissions,
    toolPermissionContext: { origin: 'local-chat', interactive: true },
    messages: [{ role: 'user', content: 'save seven' }],
    provider: provider(() => {
      providerCalls++;
      return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'save-seven', type: 'function', function: { name: 'save_value', arguments: '{"value":7}' } }],
      };
    }),
  }), /needs recovery review/);
  assert.equal(executions, 0);
  assert.equal(providerCalls, 1);
  assert.equal(permissions.view(['save_value']).grants.length, 1);
  assert.equal((await fx.log.read()).some(event => event.type === 'tool_recovery_required'), true);
  await fx.disposition('run-failed');
  const recoverable = (await fx.store.inspect(prior.actionId)).unresolved;
  await fx.store.resolve({
    actionId: recoverable.actionId,
    expectedRevision: recoverable.revision,
    resolution: 'abandon-not-attempted',
  });
});

test('a tracked executor error halts without a model-visible retry', async t => {
  const profile = await syntheticProfile(t);
  const fx = await effectFixture(t, 'executor-error-run');
  let providerCalls = 0, executions = 0;
  const tools = createToolRegistry([{
    name: 'failing_effect',
    description: 'Fail one synthetic effect after executor entry.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { executions++; throw new Error('synthetic executor failure'); },
  }]);
  await assert.rejects(runConversation({
    profile,
    tools,
    eventLog: fx.log,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
    messages: [{ role: 'user', content: 'fail once' }],
    provider: provider(() => {
      providerCalls++;
      return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'fail-once', type: 'function', function: { name: 'failing_effect', arguments: '{}' } }],
      };
    }),
  }), /synthetic executor failure/);
  assert.equal(executions, 1);
  assert.equal(providerCalls, 1);
  const pending = (await fx.store.unresolved()).items[0];
  assert.equal(pending.state, 'executor-error-uncertain');
  const events = await fx.log.read();
  assert.equal(events.some(event => event.type === 'tool_finished'), false);
  const interrupted = events.find(event => event.type === 'tool_interrupted');
  assert.deepEqual(interrupted.data, {
    step: 1,
    callId: 'fail-once',
    name: 'failing_effect',
    effectId: pending.actionId,
    outcome: 'executor-error',
  });
  assert.equal(events.at(-1).type, 'run_failed');
  await fx.disposition('run-failed');
});

test('a tracked executor that returns after abort is receipted before the run stops', async t => {
  const profile = await syntheticProfile(t);
  const fx = await effectFixture(t, 'abort-return-run');
  const controller = new AbortController();
  let providerCalls = 0;
  const tools = createToolRegistry([{
    name: 'abort_then_return',
    description: 'Abort the synthetic run and still return from the executor.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: async () => {
      controller.abort(new Error('synthetic stop'));
      await new Promise(resolve => setImmediate(resolve));
      return { returned: true };
    },
  }]);
  await assert.rejects(runConversation({
    profile,
    tools,
    eventLog: fx.log,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
    signal: controller.signal,
    messages: [{ role: 'user', content: 'stop after starting' }],
    provider: provider(() => {
      providerCalls++;
      return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'abort-return', type: 'function', function: { name: 'abort_then_return', arguments: '{}' } }],
      };
    }),
  }), /synthetic stop/);
  assert.equal(providerCalls, 1);
  assert.equal((await fx.store.unresolved()).items[0].state, 'executor-returned-uncommitted');
  assert.equal((await fx.log.read()).at(-1).type, 'run_stopped');
  await fx.disposition('run-failed');
});

test('tracked return normalization failure stays fenced and prevents later effects', async t => {
  const profile = await syntheticProfile(t);
  const fx = await effectFixture(t, 'normalization-failure-run');
  let later = 0;
  const tools = createToolRegistry([{
    name: 'unrepresentable_result',
    description: 'Return an unrepresentable synthetic result after an effect.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => 1n,
  }, {
    name: 'later_effect',
    description: 'A later effect that must remain uncalled after failure.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { later++; return true; },
  }]);
  await assert.rejects(runConversation({
    profile,
    tools,
    eventLog: fx.log,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
    messages: [{ role: 'user', content: 'run effects' }],
    provider: provider(() => ({
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'bad-result', type: 'function', function: { name: 'unrepresentable_result', arguments: '{}' } },
        { id: 'later-result', type: 'function', function: { name: 'later_effect', arguments: '{}' } },
      ],
    })),
  }));
  assert.equal(later, 0);
  assert.equal((await fx.store.unresolved()).items[0].state, 'executor-returned-uncommitted');
  assert.equal((await fx.log.read()).some(event => event.type === 'tool_finished'), false);
  await fx.disposition('run-failed');
});

test('a durable outcome-report failure halts after one executor entry and preserves uncertainty', async t => {
  const profile = await syntheticProfile(t);
  let failClock = false;
  const fx = await effectFixture(t, 'report-failure-run', {
    clock: () => {
      if (failClock) {
        failClock = false;
        throw new Error('synthetic report clock failure');
      }
      return 0;
    },
  });
  let executions = 0, providerCalls = 0;
  const tools = createToolRegistry([{
    name: 'return_before_report_failure',
    description: 'Return once before a synthetic durable report failure.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { executions++; failClock = true; return true; },
  }]);
  await assert.rejects(runConversation({
    profile,
    tools,
    eventLog: fx.log,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
    messages: [{ role: 'user', content: 'return once' }],
    provider: provider(() => {
      providerCalls++;
      return {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'report-failure', type: 'function', function: { name: 'return_before_report_failure', arguments: '{}' },
        }],
      };
    }),
  }), /synthetic report clock failure/);
  assert.equal(executions, 1);
  assert.equal(providerCalls, 1);
  assert.equal((await fx.store.unresolved()).items[0].state, 'attempted-unsettled');
  await fx.disposition('run-failed');
});

test('tracked trace failures halt after durable outcome reporting without repeating the executor', async t => {
  const profile = await syntheticProfile(t);
  for (const [phase, failingAppend] of [['tool-started', 4], ['tool-finished', 5]]) {
    const runId = `trace-failure-${phase}`;
    const fx = await effectFixture(t, runId);
    let clockCalls = 0;
    const log = createMemoryEventLog({
      runId,
      clock: () => {
        clockCalls++;
        if (clockCalls === failingAppend) throw new Error(`synthetic ${phase} trace failure`);
        return 0;
      },
    });
    let executions = 0, providerCalls = 0;
    const tools = createToolRegistry([{
      name: 'trace_effect',
      description: 'Run one synthetic effect around a failing trace append.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () => { executions++; return { returned: true }; },
    }]);
    await assert.rejects(runConversation({
      profile,
      tools,
      eventLog: log,
      toolEffects: fx.store,
      toolEffectRun: fx.run,
      messages: [{ role: 'user', content: 'run once' }],
      provider: provider(() => {
        providerCalls++;
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `call-${phase}`, type: 'function', function: { name: 'trace_effect', arguments: '{}' } }],
        };
      }),
    }), new RegExp(`synthetic ${phase} trace failure`));
    assert.equal(executions, 1);
    assert.equal(providerCalls, 1);
    assert.equal((await fx.store.unresolved()).items[0].state, 'executor-returned-uncommitted');
    await assert.rejects(log.read(), new RegExp(`synthetic ${phase} trace failure`));
    await fx.disposition('run-failed');
  }
});

test('an explicitly read-only tool bypasses recovery and reports a definite no-effect failure', async t => {
  const profile = await syntheticProfile(t);
  const fx = await effectFixture(t, 'read-only-effect-run');
  let providerCalls = 0, executions = 0;
  const tools = createToolRegistry([{
    name: 'read_probe',
    description: 'Read one synthetic probe without changing any durable state.',
    effect: 'read-only',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { executions++; throw new Error('synthetic read failure'); },
  }]);
  const result = await runConversation({
    profile,
    tools,
    eventLog: fx.log,
    toolEffects: fx.store,
    toolEffectRun: fx.run,
    messages: [{ role: 'user', content: 'inspect once' }],
    provider: provider(input => {
      providerCalls++;
      if (providerCalls === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'read-once', type: 'function', function: { name: 'read_probe', arguments: '{}' } }],
        };
      }
      const toolResult = JSON.parse(input.messages.at(-1).content);
      assert.equal(toolResult.ok, false);
      assert.equal(toolResult.effectMayHaveOccurred, false);
      return { role: 'assistant', content: 'read failed safely' };
    }),
  });
  assert.equal(result.answer, 'read failed safely');
  assert.equal(executions, 1);
  assert.equal(providerCalls, 2);
  assert.equal((await fx.store.unresolved()).total, 0);
  assert.equal((await fx.log.read()).some(event => event.data?.effectId), false);
  await fx.disposition('committed');
});

test('failure reasons mark code-point-safe diagnostic truncation', async t => {
  const profile = await syntheticProfile(t);
  const log = createMemoryEventLog({ runId: 'long-failure', clock: () => 0 });
  await assert.rejects(runConversation({
    profile, eventLog: log, tools: emptyTools(),
    messages: [{ role: 'user', content: 'fail verbosely' }],
    provider: provider(() => { throw new Error('🧪'.repeat(2100)); }),
  }));
  const reason = (await log.read()).find(event => event.type === 'provider_failed').data.reason;
  assert.equal([...reason].length, 2000);
  assert.match(reason, /…\[truncated\]$/);
  assert.equal(reason.includes('\ufffd'), false);
});

test('a watcher hears the reply as it is written and which tools start, without changing the run', async t => {
  const profile = await syntheticProfile(t);
  const heard = [];
  let step = 0;
  const tools = createToolRegistry([{ name: 'ping', description: 'Answers a ping.', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: async () => ({ ok: true }) }]);
  const result = await runConversation({
    profile,
    messages: [{ role: 'user', content: 'hello' }],
    tools,
    onProgress: event => { heard.push(event); throw new Error('a broken watcher is ignored'); },
    provider: provider(input => {
      step += 1;
      if (step === 1) return { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'ping', arguments: '{}' } }] };
      input.onText('hi ');
      input.onText('there');
      return { role: 'assistant', content: 'hi there' };
    }),
  });
  assert.equal(result.answer, 'hi there');
  assert.deepEqual(heard.map(event => event.type), ['step', 'tools', 'step', 'text', 'text']);
  assert.deepEqual(heard[1].names, ['ping']);
  assert.equal(heard.filter(event => event.type === 'text').map(event => event.delta).join(''), 'hi there');
});

const lookTool = () => createToolRegistry([{
  name: 'look', description: 'Look at one synthetic thing for testing.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  execute: () => ({ seen: true }),
}]);

test('the last step carries a request-only note before the final voice root, keeps tools declared, and stays out of the transcript', async t => {
  const profile = await syntheticProfile(t);
  const log = createMemoryEventLog({ runId: 'final-step-note', clock: () => 0 });
  const requests = [];
  const result = await runConversation({
    profile, tools: lookTool(), eventLog: log, messages: [{ role: 'user', content: 'look twice' }], maxSteps: 2,
    provider: provider(input => {
      requests.push(input);
      if (requests.length === 1) {
        return { role: 'assistant', content: null, tool_calls: [{ id: 'look-1', type: 'function', function: { name: 'look', arguments: '{}' } }] };
      }
      return { role: 'assistant', content: 'I could look once, so here is what I saw.' };
    }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'I could look once, so here is what I saw.');
  assert.equal(requests[0].messages.some(message => message.content === FINAL_STEP_NOTE), false, 'an earlier step has no note');
  assert.equal(requests[1].messages.at(-1).role, 'user');
  assert.ok(requests[1].messages.at(-1).content.startsWith(`${FINAL_STEP_NOTE}\n\n${ROOT_MARKER}\n`));
  assert.match(requests[1].messages.at(-1).content, /SYNTHETIC VOICE ROOT/);
  assert.ok(requests[1].messages.at(-1).content.endsWith('<<<END_FIELDWORK_ROOT voice>>>'), 'the voice root remains the final request context');
  assert.equal(requests[1].messages.at(-2).role, 'tool', 'the note follows the last tool result');
  assert.deepEqual(requests[1].tools.map(tool => tool.function.name), ['look'], 'tools stay declared on the last step');
  assert.equal(result.messages.some(message => typeof message.content === 'string' && message.content.includes(FINAL_STEP_NOTE)), false, 'the note is never saved');
  const logged = (await log.read()).filter(event => event.type === 'provider_request');
  assert.equal(Object.hasOwn(logged[0].data, 'finalStepNote'), false);
  assert.equal(logged[1].data.finalStepNote, FINAL_STEP_NOTE);
  assert.equal(logged[1].data.requestMessages, requests[1].messages.length);
  verifyEventChain(await log.read(), { expectedHead: result.receipt.head });
});

test('a tool call on the last step is still refused after the note', async t => {
  const profile = await syntheticProfile(t);
  let executions = 0;
  const tools = createToolRegistry([{
    name: 'look', description: 'Look at one synthetic thing for testing.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => { executions++; return { seen: true }; },
  }]);
  const result = await runConversation({
    profile, tools, messages: [{ role: 'user', content: 'look' }], maxSteps: 1,
    provider: provider(input => {
      assert.equal(input.messages.at(-1).role, 'user');
      assert.ok(input.messages.at(-1).content.startsWith(`${FINAL_STEP_NOTE}\n\n${ROOT_MARKER}\n`));
      assert.ok(input.messages.at(-1).content.endsWith('<<<END_FIELDWORK_ROOT voice>>>'));
      return { role: 'assistant', content: '', tool_calls: [{ id: 'look-1', type: 'function', function: { name: 'look', arguments: '{}' } }] };
    }),
  });
  assert.equal(result.status, 'exhausted');
  assert.equal(executions, 0);
  assert.match(JSON.parse(result.messages.at(-1).content).error, /final provider step/);
});

test('isolated runs and runs without tools get no last-step note', async t => {
  const profile = await syntheticProfile(t);
  const isolated = [];
  await runIsolatedConversation({
    tools: lookTool(), maxSteps: 1,
    messages: [{ role: 'system', content: 'synthetic frame' }, { role: 'user', content: 'go' }],
    provider: provider(input => { isolated.push(input.messages); return { role: 'assistant', content: 'done' }; }),
  });
  assert.equal(isolated[0].some(message => message.content === FINAL_STEP_NOTE), false);
  assert.equal(isolated[0].length, 2, 'an isolated caller keeps exactly its own messages');

  const toolless = [];
  await runConversation({
    profile, maxSteps: 1, messages: [{ role: 'user', content: 'hello' }],
    provider: provider(input => { toolless.push(input.messages); return { role: 'assistant', content: 'hi' }; }),
  });
  assert.equal(toolless[0].some(message => message.content === FINAL_STEP_NOTE), false);
});
