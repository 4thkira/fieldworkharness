import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createToolRegistry,
  executePreparedTool,
  executeTool,
  onlyTools,
  permissionOfTool,
  prepareToolCall,
  withTools,
} from '../src/tools.mjs';

const schema = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 20 },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    tags: { type: 'array', items: { type: 'string', maxLength: 8 }, maxItems: 2 },
    meta: {
      type: 'object',
      properties: { quiet: { type: 'boolean' } },
      required: [],
      additionalProperties: false,
    },
  },
  required: ['text', 'count'],
  additionalProperties: false,
};

test('a tool registry exposes frozen provider declarations and executes with frozen validated arguments', async () => {
  let seen;
  const registry = createToolRegistry([{
    name: 'echo_text',
    description: 'Return a small synthetic echo for testing.',
    inputSchema: schema,
    execute: async (args, context) => { seen = { args, context }; return { echo: args.text }; },
  }]);
  assert.deepEqual(registry.names, ['echo_text']);
  assert.equal(registry.providerTools[0].function.parameters.additionalProperties, false);
  assert.equal(Object.isFrozen(registry.providerTools[0].function.parameters.properties), true);
  assert.equal(Object.hasOwn(registry.providerTools[0], 'effect'), false);
  assert.equal(Object.hasOwn(registry.providerTools[0].function, 'effect'), false);
  const result = await executeTool(registry, 'echo_text', { text: 'hello', count: 2, tags: ['one'], meta: {} }, { callId: 'c1', step: 1 });
  assert.deepEqual(result, { echo: 'hello' });
  assert.equal(Object.isFrozen(seen.args), true);
  assert.equal(seen.context.callId, 'c1');
  assert.throws(() => { seen.args.text = 'changed'; }, TypeError);
});

test('prepared calls expose only stable audit metadata and execute hidden validated arguments once', async () => {
  let seen;
  let release;
  const registry = createToolRegistry([{
    name: 'echo_text',
    description: 'Return a small synthetic echo for testing.',
    permission: 'internal',
    inputSchema: schema,
    execute: (args, context) => {
      seen = { args, context };
      return new Promise(resolve => { release = () => resolve({ echo: args.text }); });
    },
  }]);
  const raw = { text: 'private seed', count: 2, tags: ['one'], meta: { quiet: true } };
  const prepared = prepareToolCall(registry, 'echo_text', raw, { callId: 'prepared-1', step: 4 });
  const canonical = '{"count":2,"meta":{"quiet":true},"tags":["one"],"text":"private seed"}';
  assert.equal(Object.isFrozen(prepared), true);
  assert.deepEqual(Reflect.ownKeys(prepared), ['name', 'argumentsSha256', 'permission', 'effect', 'permissionSummary']);
  assert.deepEqual(prepared, {
    name: 'echo_text',
    argumentsSha256: createHash('sha256').update(canonical).digest('hex'),
    permission: 'internal',
    effect: 'tracked',
    permissionSummary: 'Return a small synthetic echo for testing. Inputs: count, meta, tags, text.',
  });
  assert.equal(JSON.stringify(prepared).includes('private seed'), false, 'raw arguments never enter the public projection');

  raw.text = 'mutated later';
  raw.meta.quiet = false;
  const first = executePreparedTool(prepared);
  await assert.rejects(executePreparedTool(prepared), /already been executed/);
  assert.equal(seen.args.text, 'private seed');
  assert.equal(seen.args.meta.quiet, true);
  assert.equal(seen.context.callId, 'prepared-1');
  assert.equal(seen.context.step, 4);
  assert.equal(Object.isFrozen(seen.args.meta), true);
  release();
  assert.deepEqual(await first, { echo: 'private seed' });
  await assert.rejects(executePreparedTool({ ...prepared }), /result of prepareToolCall/);
});

test('prepared execution stays one-shot after aborts or executor failures', async () => {
  let seenSignal;
  const registry = createToolRegistry([{
    name: 'one_tool',
    description: 'A synthetic tool used only by this test.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: (_args, context) => { seenSignal = context.signal; throw new Error('synthetic failure'); },
  }]);
  const execution = new AbortController();
  const failed = prepareToolCall(registry, 'one_tool', {});
  await assert.rejects(executePreparedTool(failed, { signal: execution.signal }), /synthetic failure/);
  assert.equal(seenSignal, execution.signal);
  await assert.rejects(executePreparedTool(failed), /already been executed/);

  const cancellation = new AbortController();
  const cancelled = prepareToolCall(registry, 'one_tool', {}, { signal: cancellation.signal });
  cancellation.abort(new Error('stopped after preparation'));
  await assert.rejects(executePreparedTool(cancelled), /stopped after preparation/);
  await assert.rejects(executePreparedTool(cancelled), /already been executed/);
});

test('normalized permissions survive reconstruction and caller mutation', () => {
  const definition = {
    name: 'one_tool',
    description: '  A synthetic internal tool with padded prose.  ',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    permission: 'internal',
    effect: 'read-only',
    execute: () => null,
  };
  const registry = createToolRegistry([definition]);
  definition.description = 'A caller mutation that must not replace normalized metadata.';
  definition.permission = 'configurable';
  definition.effect = 'tracked';
  definition.inputSchema.properties.late = { type: 'boolean' };

  const selected = onlyTools(registry, name => name === 'one_tool');
  assert.equal(selected.providerTools[0].function.description, 'A synthetic internal tool with padded prose.');
  assert.deepEqual(selected.providerTools[0].function.parameters.properties, {});
  assert.equal(permissionOfTool(selected, 'one_tool'), 'internal');
  const selectedPrepared = prepareToolCall(selected, 'one_tool', {});
  assert.equal(selectedPrepared.permission, 'internal');
  assert.equal(selectedPrepared.effect, 'read-only');

  const extraRegistry = createToolRegistry([{
    name: 'two_tool',
    description: 'A default-permission synthetic tool for reconstruction.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => null,
  }]);
  const combined = withTools(selected, extraRegistry);
  assert.equal(permissionOfTool(combined, 'one_tool'), 'internal');
  assert.equal(permissionOfTool(combined, 'two_tool'), 'configurable');
  const defaultPrepared = prepareToolCall(combined, 'two_tool', {});
  assert.equal(defaultPrepared.permission, 'configurable');
  assert.equal(defaultPrepared.effect, 'tracked');
  assert.throws(() => permissionOfTool(combined, 'missing'), /unknown tool/);
  for (const permission of [null, false, 'person']) {
    assert.throws(() => createToolRegistry([{ ...definition, permission }]), /permission must be configurable or internal/);
  }
  for (const effect of [null, false, 'mutating']) {
    assert.throws(() => createToolRegistry([{ ...definition, effect }]), /effect must be tracked or read-only/);
  }
});

test('permission summaries are bounded, safe projections over validated arguments', () => {
  const registry = createToolRegistry([{
    name: 'describe_action',
    description: 'Describe one synthetic action without leaking its value.',
    permissionSummary: args => `Change the synthetic counter named ${args.name}.`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 20 }, secret: { type: 'string', minLength: 1, maxLength: 20 } },
      required: ['name', 'secret'],
      additionalProperties: false,
    },
    execute: () => null,
  }]);
  const prepared = prepareToolCall(registry, 'describe_action', { name: 'orchard', secret: 'do-not-project' });
  assert.equal(prepared.permissionSummary, 'Change the synthetic counter named orchard.');
  assert.doesNotMatch(JSON.stringify(prepared), /do-not-project/);

  assert.throws(() => createToolRegistry([{
    name: 'bad_summary', description: 'Reject a non-function summary definition.', permissionSummary: 'not callable',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: () => null,
  }]), /permissionSummary must be a function/);
  const normalized = createToolRegistry([{
    name: 'normalized_summary', description: 'Normalize a summary that contains control characters.', permissionSummary: () => 'bad\nsummary',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: () => null,
  }]);
  assert.equal(prepareToolCall(normalized, 'normalized_summary', {}).permissionSummary, 'bad summary');

  const visualSafety = createToolRegistry([{
    name: 'visual_safety', description: 'Neutralize controls that could visually spoof an approval target.',
    permissionSummary: () => 'safe\u202Etxt\u202C\u0085next\u2028line\u2066isolate\u2069\u206A and 👩‍🔬 emoji',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: () => null,
  }]);
  assert.equal(
    prepareToolCall(visualSafety, 'visual_safety', {}).permissionSummary,
    'safe txt next line isolate and 👩‍🔬 emoji',
  );

  const astral = '🧪'.repeat(130);
  const astralSummary = createToolRegistry([{
    name: 'astral_summary', description: 'Count Unicode code points instead of UTF-16 code units in summaries.',
    permissionSummary: () => astral,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: () => null,
  }]);
  assert.equal(prepareToolCall(astralSummary, 'astral_summary', {}).permissionSummary, astral);
});

test('prepared-call option accessors are rejected without being invoked', async () => {
  const registry = createToolRegistry([{
    name: 'one_tool', description: 'A synthetic tool for option-boundary testing.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: () => null,
  }]);
  let prepareReads = 0, executeReads = 0;
  const prepareOptions = {};
  Object.defineProperty(prepareOptions, 'step', { enumerable: true, get() { prepareReads++; return 1; } });
  assert.throws(() => prepareToolCall(registry, 'one_tool', {}, prepareOptions), /enumerable data property/);
  assert.equal(prepareReads, 0);

  const prepared = prepareToolCall(registry, 'one_tool', {});
  const executeOptions = {};
  Object.defineProperty(executeOptions, 'signal', { enumerable: true, get() { executeReads++; return undefined; } });
  await assert.rejects(executePreparedTool(prepared, executeOptions), /enumerable data property/);
  assert.equal(executeReads, 0);
  await executePreparedTool(prepared);
});

test('arguments are strict JSON objects checked recursively without coercion', async () => {
  const registry = createToolRegistry([{
    name: 'echo_text', description: 'Return a small synthetic echo for testing.', inputSchema: schema, execute: args => args,
  }]);
  const bad = [
    [{ count: 1 }, /missing required field "text"/],
    [{ text: 'x', count: '2' }, /count must be integer/],
    [{ text: 'x', count: 4 }, /at most 3/],
    [{ text: 'x', count: 1, extra: true }, /unknown field "extra"/],
    [{ text: 'x', count: 1, tags: ['one', 'two', 'three'] }, /limit is 2/],
    [{ text: 'x', count: 1, meta: { other: true } }, /unknown field "other"/],
    [[], /must be a JSON object/],
  ];
  for (const [args, pattern] of bad) await assert.rejects(executeTool(registry, 'echo_text', args), pattern);
  await assert.rejects(executeTool(registry, 'missing', {}), /unknown tool "missing"/);
});

test('schemas are bounded, closed, typed, and reject typos', () => {
  const definition = inputSchema => ({
    name: 'strict_tool', description: 'Exercise strict schema validation safely.', inputSchema, execute: () => null,
  });
  assert.throws(() => createToolRegistry([definition({ ...schema, typo: true })]), /unknown field "typo"/);
  assert.throws(() => createToolRegistry([definition({ type: 'object', properties: {}, required: [] })]), /additionalProperties must be false/);
  assert.throws(() => createToolRegistry([definition({ type: 'array', items: { type: 'string' } })]), /must have type object/);
  assert.throws(() => createToolRegistry([definition({ ...schema, required: ['missing'] })]), /must name one declared property/);
  assert.throws(() => createToolRegistry([definition({ ...schema, properties: { bad: { type: 'mystery' } } })]), /\.type must be/);
});

test('definition names are unique and execution honors cancellation', async () => {
  const definition = {
    name: 'one_tool', description: 'A synthetic tool used only by this test.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => 'should not run',
  };
  assert.throws(() => createToolRegistry([definition, definition]), /repeats tool/);
  const registry = createToolRegistry([definition]);
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await assert.rejects(executeTool(registry, 'one_tool', {}, { signal: controller.signal }), /stopped/);
});

test('tool definition accessors are rejected without being invoked', () => {
  let reads = 0;
  const definition = {
    name: 'accessor_tool',
    description: 'A synthetic accessor boundary used only for testing.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  };
  Object.defineProperty(definition, 'execute', { enumerable: true, get() { reads++; return () => null; } });
  assert.throws(() => createToolRegistry([definition]), /execute must be an enumerable data property/);
  assert.equal(reads, 0);

  const effectDefinition = {
    name: 'effect_accessor',
    description: 'A synthetic effect accessor boundary used only for testing.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => null,
  };
  Object.defineProperty(effectDefinition, 'effect', { enumerable: true, get() { reads++; return 'read-only'; } });
  assert.throws(() => createToolRegistry([effectDefinition]), /effect must be an enumerable data property/);
  assert.equal(reads, 0);
});
