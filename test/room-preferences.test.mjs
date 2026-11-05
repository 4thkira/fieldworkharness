import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createRoomPreferences,
  ROOM_PREFERENCES_FORMAT,
  roomServiceFingerprint,
} from '../src/room-preferences.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-room-preferences-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'room-preferences.json');
}

test('appearance and per-service model choices survive a restart without storing credentials', async t => {
  const file = await fixture(t);
  const openrouter = roomServiceFingerprint({ kind: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1' });
  const subscription = roomServiceFingerprint({ kind: 'chatgpt-subscription' });
  const preferences = await createRoomPreferences({ file });
  assert.equal(preferences.snapshot().format, ROOM_PREFERENCES_FORMAT);
  assert.equal(preferences.snapshot().appearance, null);
  assert.equal(preferences.selectedModel({ service: openrouter, configuredModel: 'maker/alpha' }), 'maker/alpha');
  assert.equal(preferences.selectedModel({ service: openrouter, configuredModel: 'qwen3.5:4b' }), 'qwen3.5:4b');
  assert.equal(preferences.selectedReasoningEffort({ service: openrouter, configuredModel: 'maker/alpha' }), null);

  await Promise.all([
    preferences.saveAppearance({ revision: 3, settings: { palette: 'amber', density: 'relaxed' } }),
    preferences.saveModel({ service: openrouter, configuredModel: 'maker/alpha', selectedModel: 'maker/beta', reasoningEffort: 'high' }),
  ]);
  await preferences.saveModel({ service: subscription, configuredModel: 'gpt/one', selectedModel: 'gpt/two', reasoningEffort: 'ultra' });

  const reopened = await createRoomPreferences({ file });
  assert.deepEqual(reopened.snapshot().appearance, {
    revision: 3,
    settings: { density: 'relaxed', palette: 'amber' },
  });
  assert.equal(reopened.selectedModel({ service: openrouter, configuredModel: 'maker/alpha' }), 'maker/beta');
  assert.equal(reopened.selectedModel({ service: subscription, configuredModel: 'gpt/one' }), 'gpt/two');
  assert.equal(reopened.selectedReasoningEffort({ service: openrouter, configuredModel: 'maker/alpha' }), 'high');
  assert.equal(reopened.selectedReasoningEffort({ service: subscription, configuredModel: 'gpt/one' }), 'ultra');
  assert.equal(reopened.selectedModel({ service: openrouter, configuredModel: 'maker/new-default' }), 'maker/new-default');
  assert.equal(reopened.selectedReasoningEffort({ service: openrouter, configuredModel: 'maker/new-default' }), null);
  const source = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(source, /api.?key|authorization|bearer|secret/i);
});

test('v1 preferences migrate to provider-default effort on the next ordinary save', async t => {
  const file = await fixture(t);
  const service = roomServiceFingerprint({ kind: 'openai-compatible', endpoint: 'https://example.invalid/v1' });
  await fs.writeFile(file, JSON.stringify({
    format: 'fieldwork-room-preferences/v1', appearance: null,
    models: [{ service, configuredModel: 'maker/alpha', selectedModel: 'maker/beta' }],
  }));
  const preferences = await createRoomPreferences({ file });
  assert.equal(preferences.snapshot().format, ROOM_PREFERENCES_FORMAT);
  assert.equal(preferences.selectedModel({ service, configuredModel: 'maker/alpha' }), 'maker/beta');
  assert.equal(preferences.selectedReasoningEffort({ service, configuredModel: 'maker/alpha' }), null);
  await preferences.saveModel({ service, configuredModel: 'maker/alpha', selectedModel: 'maker/beta', reasoningEffort: 'low' });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).format, ROOM_PREFERENCES_FORMAT);
});

test('preferences reject malformed files and accessor-backed updates', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ format: ROOM_PREFERENCES_FORMAT, appearance: null, models: [
    { service: 'a'.repeat(64), configuredModel: 'alpha', selectedModel: 'beta' },
    { service: 'a'.repeat(64), configuredModel: 'alpha', selectedModel: 'gamma' },
  ] }));
  await assert.rejects(createRoomPreferences({ file }), /repeats service/);

  await fs.rm(file);
  const preferences = await createRoomPreferences({ file });
  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, 'revision', { enumerable: true, get() { accessed = true; return 1; } });
  hostile.settings = {};
  assert.throws(() => preferences.saveAppearance(hostile), /enumerable data property/);
  assert.equal(accessed, false);
});

test('service fingerprints bind the provider kind and endpoint without containing either value', () => {
  const first = roomServiceFingerprint({ kind: 'openai-compatible', endpoint: 'https://example.invalid/v1' });
  const same = roomServiceFingerprint({ kind: 'openai-compatible', endpoint: 'https://example.invalid/v1' });
  const other = roomServiceFingerprint({ kind: 'chatgpt-subscription' });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.doesNotMatch(first, /example|openai/);
});
