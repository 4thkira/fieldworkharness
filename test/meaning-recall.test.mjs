import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMeaningRecall, isMeaningRecall, MEANING_RECALL_DEFAULTS, meaningQuery } from '../src/meaning-recall.mjs';

// A fake loopback embedding service with readable "topic" vectors: dogs, tea, garden.
const TOPICS = [/dog|puppy|biscuit|pup/i, /tea|lapsang|drink/i, /garden|tomato|plant/i];
function fakeService({ dimensions = 4, transform = vector => vector, indices = null, padding = 0 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, inputs: body.input, model: body.model });
    const data = body.input.map((text, index) => ({
      index: indices ? indices(index, body.input.length) : index,
      embedding: transform(Array.from({ length: dimensions }, (_, position) => (
        (TOPICS[position]?.test(text) ? 1 : 0) + (position === dimensions - 1 ? 0.2 : 0)
      )), text),
    }));
    return new Response(JSON.stringify({ data, ...(padding ? { padding: 'x'.repeat(padding) } : {}) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

async function stateDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-meaning-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const memories = [
  { id: 'memory:puppy', text: 'Sam adopted a puppy named Biscuit last spring.' },
  { id: 'memory:tea', text: 'Sam likes smoky lapsang souchong.' },
  { id: 'memory:garden', text: 'The tomatoes by the fence need staking.' },
];

test('meaning recall gives the closest memory a seat, only above the floor', async t => {
  const service = fakeService();
  const recall = await createMeaningRecall({ stateDir: await stateDir(t), fetch: service.fetch, floor: 0.5 });
  assert.equal(isMeaningRecall(recall), true);

  const dog = await recall.pick({ message: 'How is my dog doing?', items: memories });
  assert.deepEqual(dog.picks.map(row => row.id), ['memory:puppy']);
  assert.ok(dog.picks[0].similarityPpm >= 500_000);
  assert.equal(dog.trace.embedded, 3);
  assert.equal(service.calls.at(-1).inputs[0].startsWith('Instruct: '), true, 'qwen3-embedding queries get their instruction');

  const greeting = await recall.pick({ message: 'hi there!', items: memories });
  assert.deepEqual(greeting.picks, [], 'nothing clears the floor for a greeting');
  assert.equal(greeting.trace.embedded, 0, 'memory vectors are cached; only the message is embedded');

  const taken = await recall.pick({ message: 'my pup', items: memories, taken: ['memory:puppy'] });
  assert.deepEqual(taken.picks, [], 'a memory already chosen by its words is never picked twice');
});

test('vectors survive a restart and new memories are embedded a few at a time', async t => {
  const directory = await stateDir(t);
  const first = fakeService();
  const recall = await createMeaningRecall({ stateDir: directory, fetch: first.fetch, newPerLookup: 2 });
  const one = await recall.pick({ message: 'tea please', items: memories });
  assert.equal(one.trace.embedded, 2);
  assert.equal(one.trace.waiting, 1, 'the rest wait for a later lookup');
  const two = await recall.pick({ message: 'tea please', items: memories });
  assert.equal(two.trace.embedded, 1);
  assert.equal(two.trace.waiting, 0);

  const second = fakeService();
  const reopened = await createMeaningRecall({ stateDir: directory, fetch: second.fetch });
  const again = await reopened.pick({ message: 'what should I drink?', items: memories });
  assert.equal(again.trace.embedded, 0, 'the cache file was read back');
  assert.deepEqual(again.picks.map(row => row.id), ['memory:tea']);
  assert.equal(second.calls.length, 2, 'a fixed space probe and the message went to the service');
});

test('a failing or absent service gives no seat instead of an error', async t => {
  const recall = await createMeaningRecall({
    stateDir: await stateDir(t),
    fetch: async () => { throw new Error('connection refused'); },
  });
  const result = await recall.pick({ message: 'How is my dog?', items: memories });
  assert.deepEqual(result.picks, []);
  assert.match(result.trace.error, /connection refused/);
});

test('memory text is only sent to a configured loopback endpoint', async t => {
  const directory = await stateDir(t);
  for (const baseURL of ['https://api.example.com/v1', 'http://192.168.1.5:11434/v1', 'http://user:pass@127.0.0.1:11434/v1']) {
    await assert.rejects(createMeaningRecall({ stateDir: directory, baseURL }), /loopback|credentials/);
  }
  const local = await createMeaningRecall({ stateDir: directory, baseURL: 'http://localhost:1234/v1', fetch: fakeService().fetch });
  assert.equal(local.model, MEANING_RECALL_DEFAULTS.model);
  assert.equal(meaningQuery('nomic-embed-text', 'hello'), 'hello');
});

test('cache identity and a fixed probe rebuild changed embedding spaces', async t => {
  const directory = await stateDir(t);
  const baseURL = 'http://127.0.0.1:11431/v1';
  const first = fakeService();
  const original = await createMeaningRecall({ stateDir: directory, baseURL, fetch: first.fetch });
  await original.pick({ message: 'my dog', items: memories });

  const rotated = fakeService({
    transform(vector) { return [vector[1], vector[0], ...vector.slice(2)]; },
  });
  const sameNameNewSpace = await createMeaningRecall({ stateDir: directory, baseURL, fetch: rotated.fetch });
  const rebuilt = await sameNameNewSpace.pick({ message: 'my dog', items: memories });
  assert.equal(rebuilt.trace.cacheInvalidated, true, 'the fixed probe notices a same-name, same-size space change');
  assert.equal(rebuilt.trace.embedded, memories.length);
  assert.deepEqual(rebuilt.picks.map(row => row.id), ['memory:puppy']);

  const resized = fakeService({ dimensions: 5 });
  const changedDimensions = await createMeaningRecall({ stateDir: directory, baseURL, fetch: resized.fetch });
  const resizedResult = await changedDimensions.pick({ message: 'my dog', items: memories });
  assert.equal(resizedResult.trace.cacheInvalidated, true);
  assert.equal(resizedResult.trace.embedded, memories.length, 'a new dimension rebuilds instead of bricking later lookups');
  assert.deepEqual(resizedResult.picks.map(row => row.id), ['memory:puppy']);

  const otherEndpoint = 'http://127.0.0.1:11432/v1';
  const moved = fakeService({ dimensions: 3 });
  const movedRecall = await createMeaningRecall({ stateDir: directory, baseURL: otherEndpoint, fetch: moved.fetch });
  const movedResult = await movedRecall.pick({ message: 'my dog', items: memories });
  assert.equal(movedResult.trace.embedded, memories.length, 'a different endpoint gets a distinct cache namespace');
  assert.deepEqual(movedResult.picks.map(row => row.id), ['memory:puppy']);
  const cacheFiles = (await fs.readdir(directory)).filter(name => name.startsWith('meaning-vectors-'));
  assert.equal(cacheFiles.length, 2);
  for (const name of cacheFiles) {
    const source = await fs.readFile(path.join(directory, name), 'utf8');
    assert.equal(source.includes(baseURL) || source.includes(otherEndpoint), false, 'cache metadata keeps raw endpoints private');
  }
});

test('a concurrent startup check cannot overwrite vectors persisted by the first pick', async t => {
  const directory = await stateDir(t);
  const initial = fakeService();
  const seeded = await createMeaningRecall({ stateDir: directory, fetch: initial.fetch });
  await seeded.pick({ message: 'my dog', items: memories });

  const changed = fakeService({
    transform(vector) { return [vector[1], vector[0], ...vector.slice(2)]; },
  });
  const reopened = await createMeaningRecall({ stateDir: directory, fetch: changed.fetch });
  const [health, picked] = await Promise.all([
    reopened.check(),
    reopened.pick({ message: 'my dog', items: memories }),
  ]);
  assert.equal(health.ok, true);
  assert.equal(picked.trace.embedded, memories.length);
  const cacheFile = (await fs.readdir(directory)).find(name => /^meaning-vectors-[0-9a-f]{32}\.json$/u.test(name));
  const saved = JSON.parse(await fs.readFile(path.join(directory, cacheFile), 'utf8'));
  assert.equal(Object.keys(saved.vectors).length, memories.length);

  const afterRestart = await createMeaningRecall({ stateDir: directory, fetch: fakeService({
    transform(vector) { return [vector[1], vector[0], ...vector.slice(2)]; },
  }).fetch });
  const reused = await afterRestart.pick({ message: 'my dog', items: memories });
  assert.equal(reused.trace.embedded, 0, 'the final queued write retained the populated cache');
});

test('legacy and poisoned caches fail soft and rebuild from the service', async t => {
  const directory = await stateDir(t);
  const legacyFile = path.join(directory, 'meaning-vectors-qwen3-embedding_0.6b.json');
  await fs.writeFile(legacyFile, JSON.stringify({
    format: 'fieldwork-meaning-recall/v1', model: MEANING_RECALL_DEFAULTS.model, dims: 1, vectors: {},
  }));
  const firstService = fakeService();
  const first = await createMeaningRecall({ stateDir: directory, fetch: firstService.fetch });
  const built = await first.pick({ message: 'my dog', items: memories });
  assert.equal(built.trace.embedded, memories.length, 'v1 is ignored rather than trusted as v2');

  const cacheFile = (await fs.readdir(directory)).find(name => /^meaning-vectors-[0-9a-f]{32}\.json$/u.test(name));
  assert.ok(cacheFile);
  const fullPath = path.join(directory, cacheFile);
  const saved = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  const [hash] = Object.keys(saved.vectors);
  const poison = Buffer.alloc(saved.dims * 4);
  poison.writeFloatLE(Number.NaN, 0);
  saved.vectors[hash] = poison.toString('base64');
  await fs.writeFile(fullPath, JSON.stringify(saved));

  const secondService = fakeService();
  const reopened = await createMeaningRecall({ stateDir: directory, fetch: secondService.fetch });
  const safe = await reopened.pick({ message: 'my dog', items: memories });
  assert.equal(safe.trace.embedded, memories.length, 'one invalid vector rejects the derived cache');
  assert.deepEqual(safe.picks.map(row => row.id), ['memory:puppy']);
  assert.equal(Number.isFinite(safe.picks[0].similarityPpm), true);
});

test('a startup check replaces an observed invalid cache even without memory items', async t => {
  const directory = await stateDir(t);
  const seeded = await createMeaningRecall({ stateDir: directory, fetch: fakeService().fetch });
  await seeded.pick({ message: 'my dog', items: memories });
  const cacheFile = (await fs.readdir(directory)).find(name => /^meaning-vectors-[0-9a-f]{32}\.json$/u.test(name));
  const fullPath = path.join(directory, cacheFile);
  const legacyAtCurrentPath = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  legacyAtCurrentPath.format = 'fieldwork-meaning-recall/v1';
  await fs.writeFile(fullPath, JSON.stringify(legacyAtCurrentPath));

  const reopened = await createMeaningRecall({ stateDir: directory, fetch: fakeService().fetch });
  assert.deepEqual(await reopened.check(), { ok: true });
  const rebuilt = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  assert.equal(rebuilt.format, 'fieldwork-meaning-recall/v2');
  assert.deepEqual(Object.keys(rebuilt.vectors), [], 'check rewrites invalid derived state without needing documents');
});

test('service responses require unique indices and stay under the byte cap', async t => {
  const duplicate = fakeService({ indices: () => 0 });
  const duplicateRecall = await createMeaningRecall({ stateDir: await stateDir(t), fetch: duplicate.fetch });
  const badIndices = await duplicateRecall.pick({ message: 'my dog', items: memories });
  assert.deepEqual(badIndices.picks, []);
  assert.match(badIndices.trace.error, /indices/);

  const oversized = fakeService({ padding: 2_000 });
  const oversizedRecall = await createMeaningRecall({
    stateDir: await stateDir(t), fetch: oversized.fetch, responseBytes: 1_024,
  });
  const tooLarge = await oversizedRecall.pick({ message: 'my dog', items: memories });
  assert.deepEqual(tooLarge.picks, []);
  assert.match(tooLarge.trace.error, /exceeds 1024 bytes/);
});

test('cache entries, live vectors, and cache reads remain bounded', async t => {
  const directory = await stateDir(t);
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: `memory:${index}`,
    text: `${index % 2 ? 'tea' : 'puppy'} note number ${index}`,
  }));
  const service = fakeService();
  const recall = await createMeaningRecall({
    stateDir: directory,
    fetch: service.fetch,
    cacheEntries: 2,
    cacheBytes: 4_096,
    newPerLookup: 6,
  });
  const first = await recall.pick({ message: 'my dog', items });
  assert.equal(first.trace.embedded, items.length);
  assert.equal(first.trace.waiting, items.length - 2, 'eviction also bounds the live map');
  const cacheFile = (await fs.readdir(directory)).find(name => name.startsWith('meaning-vectors-'));
  const fullPath = path.join(directory, cacheFile);
  const saved = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  assert.equal(Object.keys(saved.vectors).length, 2);
  assert.ok((await fs.stat(fullPath)).size <= 4_096);

  await fs.writeFile(fullPath, Buffer.alloc(4_097, 0x20));
  const reopenedService = fakeService();
  const reopened = await createMeaningRecall({
    stateDir: directory,
    fetch: reopenedService.fetch,
    cacheEntries: 2,
    cacheBytes: 4_096,
    newPerLookup: 6,
  });
  const rebuilt = await reopened.pick({ message: 'my dog', items });
  assert.equal(rebuilt.trace.embedded, items.length, 'an oversized cache is ignored and rebuilt');
  assert.ok((await fs.stat(fullPath)).size <= 4_096);
});

test('caller cancellation propagates while a local timeout remains fail-soft', async t => {
  const hangingFetch = async (_url, init) => new Promise((resolve, reject) => {
    const cancelled = () => reject(init.signal.reason ?? new Error('aborted'));
    if (init.signal.aborted) cancelled();
    else init.signal.addEventListener('abort', cancelled, { once: true });
  });
  const recall = await createMeaningRecall({ stateDir: await stateDir(t), fetch: hangingFetch, timeoutMs: 100 });
  const controller = new AbortController();
  const pending = recall.pick({ message: 'my dog', items: memories, signal: controller.signal });
  controller.abort(new Error('person stopped this run'));
  await assert.rejects(pending, /person stopped this run/);

  const checkController = new AbortController();
  const checking = recall.check({ signal: checkController.signal });
  checkController.abort(new Error('room is closing'));
  await assert.rejects(checking, /room is closing/);

  const timedOut = await recall.pick({ message: 'my dog', items: memories });
  assert.deepEqual(timedOut.picks, []);
  assert.match(timedOut.trace.error, /abort|timeout/i);
});
