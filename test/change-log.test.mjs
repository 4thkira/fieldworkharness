import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHANGE_LOG_LIMITS, createChangeLog, inspectableSnapshot } from '../src/change-log.mjs';

async function fixture(t, name = 'changes.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, name) };
}

const change = (key, by = 'person') => ({
  key,
  area: 'synthetic',
  label: `Synthetic ${key}`,
  by,
  before: null,
  after: { value: key },
  beforeText: 'nothing',
  afterText: key,
});

const savedEntry = (overrides = {}) => ({
  id: 'chg-00000000-0000-4000-8000-000000000001',
  at: '2030-01-02T03:04:05.000Z',
  ...change('alpha'),
  ...overrides,
});

const savedFile = (entries = [savedEntry()]) => ({ format: 'fieldwork-change-log/v1', entries });

test('look names expose only strict current owners', () => {
  const snapshot = inspectableSnapshot({
    look: {
      agent: { name: 'Fern', nameBy: 'agent' },
      person: { name: 'Synthetic Person', nameBy: 'host' },
    },
  });
  assert.equal(snapshot['look.agent.name'].owner, 'agent');
  assert.equal(snapshot['look.person.name'].owner, null);
});

test('conversation automatic check-in policy is inspectable independently from archive status', () => {
  const snapshot = inspectableSnapshot({
    conversations: [{
      id: 'conv-synthetic', title: 'Synthetic', customTitle: false, titleRevision: 0,
      archived: false, lifecycleRevision: 0,
      proactiveMode: 'suppress', proactiveRevision: 7, proactiveBy: 'person',
      proactiveChangedAt: '2030-01-02T03:04:05.000Z',
    }],
  });
  assert.deepEqual(snapshot['conversation:conv-synthetic:proactive'], {
    area: 'conversations',
    label: 'Automatic check-ins',
    value: { mode: 'suppress', revision: 7, changedAt: '2030-01-02T03:04:05.000Z' },
    text: 'stopped here',
    owner: 'person',
  });
  assert.equal(snapshot['conversation:conv-synthetic:status'], undefined);
});

test('model effort is inspectable separately from the selected model', () => {
  const explicit = inspectableSnapshot({ model: 'synthetic/thinker', modelEffort: 'high' });
  assert.deepEqual(explicit['model-effort'], {
    area: 'model', label: 'Reasoning effort', value: 'high', text: 'high', owner: 'person',
  });
  const inherited = inspectableSnapshot({ model: 'synthetic/thinker', modelEffort: null });
  assert.equal(inherited['model-effort'].text, 'provider default');
  assert.equal(inspectableSnapshot({ model: 'synthetic/thinker' })['model-effort'], undefined);
});

test('change history survives reopening with exact values, order, and metadata', async t => {
  const data = await fixture(t);
  const store = await createChangeLog({ file: data.file, clock: () => new Date('2030-01-02T03:04:05.000Z') });
  assert.deepEqual(store.list(), []);

  const recorded = await store.record([change('alpha'), change('beta', 'agent')], {
    conversationId: 'conversation-one',
  });
  assert.deepEqual(recorded.map(row => row.key), ['alpha', 'beta']);
  assert.deepEqual(store.list().map(row => row.key), ['beta', 'alpha']);
  assert.ok(store.list().every(row => row.conversationId === 'conversation-one'));

  const source = await fs.readFile(data.file, 'utf8');
  assert.ok(Buffer.byteLength(source) <= CHANGE_LOG_LIMITS.fileBytes);
  const reopened = await createChangeLog({ file: data.file });
  assert.deepEqual(reopened.list(), store.list());
  assert.deepEqual(reopened.get(recorded[0].id), recorded[0]);
});

test('a value at the write depth boundary remains readable through the file wrapper', async t => {
  const data = await fixture(t);
  const store = await createChangeLog({ file: data.file, clock: () => new Date('2030-01-02T03:04:05.000Z') });
  let boundary = 'leaf';
  for (let depth = 0; depth < CHANGE_LOG_LIMITS.maxDepth; depth++) boundary = { nested: boundary };
  await store.record([{ ...change('deep'), after: boundary }]);

  const reopened = await createChangeLog({ file: data.file });
  assert.deepEqual(reopened.list(), store.list());
});

test('damaged history fails closed and remains byte-for-byte untouched', async t => {
  const data = await fixture(t);
  const damaged = Buffer.from('{"format":"fieldwork-change-log/v1","entries":[}');
  await fs.writeFile(data.file, damaged);

  await assert.rejects(
    createChangeLog({ file: data.file }),
    error => error.status === 500 && /not valid JSON/.test(error.message),
  );
  assert.deepEqual(await fs.readFile(data.file), damaged);
});

test('saved history rejects ambiguous, malformed, and unbounded files', async t => {
  const cases = [
    {
      name: 'duplicate object key',
      source: '{"format":"fieldwork-change-log/v1","format":"fieldwork-change-log/v1","entries":[]}',
      pattern: /repeats object key/,
    },
    {
      name: 'unknown root field',
      source: JSON.stringify({ ...savedFile(), surprise: true }),
      pattern: /unknown field/,
    },
    {
      name: 'wrong format',
      source: JSON.stringify({ ...savedFile(), format: 'fieldwork-change-log/v0' }),
      pattern: /saved format/,
    },
    {
      name: 'unknown entry field',
      source: JSON.stringify(savedFile([{ ...savedEntry(), surprise: true }])),
      pattern: /unknown field/,
    },
    {
      name: 'repeating entry id',
      source: JSON.stringify(savedFile([savedEntry(), savedEntry({ key: 'beta' })])),
      pattern: /ids repeat/,
    },
    {
      name: 'too many entries',
      source: JSON.stringify(savedFile(Array.from({ length: CHANGE_LOG_LIMITS.entries + 1 }, (_, index) => savedEntry({ id: `chg-${index}`, key: `key-${index}` })))),
      pattern: /entries are invalid/,
    },
    {
      name: 'invalid UTF-8',
      source: Buffer.from([0xc3, 0x28]),
      pattern: /not valid UTF-8/,
    },
    {
      name: 'oversized file',
      source: Buffer.alloc(CHANGE_LOG_LIMITS.fileBytes + 1, 0x20),
      pattern: /too large/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async t => {
      const data = await fixture(t, `${item.name.replaceAll(' ', '-')}.json`);
      await fs.writeFile(data.file, item.source);
      await assert.rejects(
        createChangeLog({ file: data.file }),
        error => error.status === 500 && item.pattern.test(error.message),
      );
    });
  }
});

test('a failed atomic write does not alter the live history projection', async t => {
  const data = await fixture(t, path.join('state', 'changes.json'));
  const store = await createChangeLog({ file: data.file, clock: () => new Date('2030-01-02T03:04:05.000Z') });
  const parent = path.dirname(data.file);
  await fs.writeFile(parent, 'This regular file prevents creation of the state directory.');

  await assert.rejects(store.record([change('unwritten')]), /EEXIST|ENOTDIR/);
  assert.deepEqual(store.list(), []);
  await assert.rejects(fs.readFile(data.file), error => ['ENOENT', 'ENOTDIR'].includes(error.code));
});

test('byte pressure prunes only the oldest retained entries and never splits a new batch', async t => {
  const data = await fixture(t);
  const store = await createChangeLog({ file: data.file, clock: () => new Date('2030-01-02T03:04:05.000Z') });
  const payload = 'x'.repeat(900_000);
  const largeChange = key => ({ ...change(key), after: { key, payload } });

  for (let index = 0; index < 6; index++) await store.record([largeChange(`large-${index}`)]);
  const retained = store.list();
  assert.ok(retained.length < 6, 'the byte edge evicts older entries before the loader edge');
  assert.equal(retained[0].key, 'large-5');
  assert.equal(retained.some(row => row.key === 'large-0'), false);
  assert.ok(Buffer.byteLength(await fs.readFile(data.file, 'utf8')) <= CHANGE_LOG_LIMITS.fileBytes);

  const before = store.list();
  await assert.rejects(
    store.record(Array.from({ length: 5 }, (_, index) => largeChange(`batch-${index}`))),
    error => error.status === 409 && /new change batch is too large/.test(error.message),
  );
  assert.deepEqual(store.list(), before);
  assert.deepEqual((await createChangeLog({ file: data.file })).list(), before);
});

test('recording rejects unknown fields and non-JSON values before writing', async t => {
  const data = await fixture(t);
  const store = await createChangeLog({ file: data.file });

  await assert.rejects(store.record([{ ...change('unknown'), surprise: true }]), /unknown field/);
  await assert.rejects(store.record([{ ...change('function'), after: { nope: () => true } }]), /not bounded JSON/);
  await assert.rejects(fs.readFile(data.file), error => error.code === 'ENOENT');
  assert.deepEqual(store.list(), []);
});
