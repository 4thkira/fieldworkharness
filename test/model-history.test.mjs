import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelHistory } from '../src/model-history.mjs';

test('the model history notes each new model once and tells the agent plainly', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-models-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state', 'model-history.json');
  let now = new Date('2030-01-01T12:00:00Z');
  const history = await createModelHistory({ file, clock: () => now, timeZone: 'UTC' });
  assert.equal(await history.note('qwen3.5:4b'), true);
  assert.equal(await history.note('qwen3.5:4b'), false, 'the same model is not noted twice');
  assert.equal(history.contextText(), '', 'nothing to say with only one model');

  now = new Date('2030-01-03T08:00:00Z');
  assert.equal(await history.note('gpt-6-luna'), true);
  const text = history.contextText();
  assert.match(text, /You are thinking with gpt-6-luna since Jan 3, 2030/);
  assert.match(text, /Before that: qwen3\.5:4b \(Jan 1, 2030–Jan 3, 2030\)/);
  assert.match(text, /only the model changed/);

  const reloaded = await createModelHistory({ file, timeZone: 'UTC' });
  assert.deepEqual(reloaded.view().map(row => row.model), ['qwen3.5:4b', 'gpt-6-luna']);
  assert.equal(reloaded.current(), 'gpt-6-luna');
});
