import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createToolGroupSettings,
  NEW_AGENT_TOOL_GROUP_MODES,
  startingToolGroupModes,
  TOOL_GROUPS,
  TOOL_GROUP_SETTINGS_FORMAT,
  toolGroupOf,
} from '../src/tool-groups.mjs';

async function fixture(t, name = 'tool-groups.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-tool-groups-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

test('every lifecycle memory tool stays under the memory switch', () => {
  for (const name of [
    'remember', 'recall', 'inspect_memory', 'review_due_memories', 'update_memory_lifecycle',
    'search_conversations', 'revise_memory', 'forget',
  ]) assert.equal(toolGroupOf(name), 'memory', name);
  assert.equal(toolGroupOf('search_fieldwork_docs'), 'help');
  assert.equal(toolGroupOf('read_fieldwork_doc'), 'help');
  assert.equal(toolGroupOf('synthetic_unknown_tool'), 'other');
});

test('missing settings start resident and strict current modes persist', async t => {
  const file = await fixture(t);
  const settings = await createToolGroupSettings({ file });
  assert.ok(TOOL_GROUPS.every(group => settings.mode(group.id) === 'resident'));
  await settings.set('web', 'on-demand');
  await settings.set('shelf', 'off');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.format, TOOL_GROUP_SETTINGS_FORMAT);
  assert.equal(saved.modes.web, 'on-demand');
  assert.equal(saved.modes.shelf, 'off');
  assert.equal(Object.keys(saved.modes).length, TOOL_GROUPS.length);
  const reopened = await createToolGroupSettings({ file });
  assert.equal(reopened.mode('web'), 'on-demand');
  assert.equal(reopened.isAvailable('web'), true);
  assert.equal(reopened.isResident('web'), false);
  assert.equal(reopened.isAvailable('shelf'), false);
});

test('older settings migrate lazily and the next successful change writes the current format', async t => {
  const file = await fixture(t);
  const v1 = `${JSON.stringify({ format: 'fieldwork-tool-groups/v1', off: ['web', 'shelf'] })}\n`;
  await fs.writeFile(file, v1);
  const settings = await createToolGroupSettings({ file });
  assert.equal(settings.mode('web'), 'off');
  assert.equal(settings.mode('memory'), 'resident');
  assert.equal(settings.mode('help'), 'on-demand');
  assert.equal(await fs.readFile(file, 'utf8'), v1, 'opening alone does not rewrite the file');
  await settings.set('web', 'on-demand');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).format, TOOL_GROUP_SETTINGS_FORMAT);

  const v2File = await fixture(t, 'v2.json');
  const v2Modes = Object.fromEntries(TOOL_GROUPS.filter(group => group.id !== 'help').map(group => [group.id, 'resident']));
  const v2 = `${JSON.stringify({ format: 'fieldwork-tool-groups/v2', modes: v2Modes })}\n`;
  await fs.writeFile(v2File, v2);
  const migrated = await createToolGroupSettings({ file: v2File });
  assert.equal(migrated.mode('help'), 'on-demand');
  assert.equal(migrated.mode('memory'), 'resident');
  assert.equal(await fs.readFile(v2File, 'utf8'), v2, 'opening v2 alone does not rewrite it');
  await migrated.set('help', 'resident');
  assert.equal(JSON.parse(await fs.readFile(v2File, 'utf8')).format, TOOL_GROUP_SETTINGS_FORMAT);
});

test('malformed or unknown persisted modes fail closed instead of enabling tools', async t => {
  for (const [name, saved] of [
    ['bad-json.json', '{'],
    ['unknown-mode.json', JSON.stringify({
      format: TOOL_GROUP_SETTINGS_FORMAT,
      modes: Object.fromEntries(TOOL_GROUPS.map(group => [group.id, group.id === 'web' ? 'sometimes' : 'resident'])),
    })],
    ['missing-mode.json', JSON.stringify({
      format: TOOL_GROUP_SETTINGS_FORMAT,
      modes: Object.fromEntries(TOOL_GROUPS.slice(1).map(group => [group.id, 'resident'])),
    })],
  ]) {
    const file = await fixture(t, name);
    await fs.writeFile(file, `${saved}\n`);
    await assert.rejects(createToolGroupSettings({ file }), /Tool groups:/);
  }
});

test('queued mode writes merge in call order and replace restores one exact snapshot', async t => {
  const file = await fixture(t);
  const settings = await createToolGroupSettings({ file });
  await Promise.all([
    settings.set('web', 'on-demand'),
    settings.set('shelf', 'off'),
    settings.set('clock', 'on-demand'),
  ]);
  assert.deepEqual(
    Object.fromEntries(['web', 'shelf', 'clock'].map(id => [id, settings.mode(id)])),
    { web: 'on-demand', shelf: 'off', clock: 'on-demand' },
  );
  const before = Object.fromEntries(TOOL_GROUPS.map(group => [group.id, 'resident']));
  await settings.replace(before);
  assert.deepEqual(settings.modes(), before);
  await assert.rejects(settings.set('web', 'sometimes'), /mode must be/);
  await assert.rejects(settings.replace({ ...before, surprise: 'off' }), /unknown fields/);
});

test('a failed atomic save leaves the live mode unchanged', async t => {
  const rootFile = await fixture(t, 'anchor');
  const parent = path.join(path.dirname(rootFile), 'not-a-directory');
  const file = path.join(parent, 'tool-groups.json');
  const settings = await createToolGroupSettings({ file });
  await fs.writeFile(parent, 'blocks mkdir');
  await assert.rejects(settings.set('web', 'off'));
  assert.equal(settings.mode('web'), 'resident');
});

test('a brand-new agent starts light, saves that choice once, and never flips later', async t => {
  const file = await fixture(t);
  const settings = await createToolGroupSettings({ file, initialModes: NEW_AGENT_TOOL_GROUP_MODES });
  assert.deepEqual({ ...settings.modes() }, { ...NEW_AGENT_TOOL_GROUP_MODES });
  for (const id of ['memory', 'notebook', 'web', 'clock']) assert.equal(settings.mode(id), 'resident', id);
  for (const id of ['help', 'collections', 'shelf', 'expression', 'self', 'other']) assert.equal(settings.mode(id), 'on-demand', id);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.format, TOOL_GROUP_SETTINGS_FORMAT);
  assert.deepEqual(saved.modes, { ...NEW_AGENT_TOOL_GROUP_MODES });

  // A later start with no starting modes reads the saved choice.
  const reopened = await createToolGroupSettings({ file });
  assert.deepEqual({ ...reopened.modes() }, { ...NEW_AGENT_TOOL_GROUP_MODES });
});

test('starting modes never override settings that already exist', async t => {
  const file = await fixture(t);
  const first = await createToolGroupSettings({ file });
  await first.set('shelf', 'off');
  const reopened = await createToolGroupSettings({ file, initialModes: NEW_AGENT_TOOL_GROUP_MODES });
  assert.equal(reopened.mode('shelf'), 'off');
  assert.equal(reopened.mode('self'), 'resident');
  await assert.rejects(
    createToolGroupSettings({ file: await fixture(t), initialModes: { memory: 'resident' } }),
    /modes must name every tool group/,
  );
});

test('only an agent with no conversation or memory yet gets the light starting set', async t => {
  const stateDir = path.dirname(await fixture(t));
  assert.deepEqual(await startingToolGroupModes(stateDir), NEW_AGENT_TOOL_GROUP_MODES);
  for (const name of ['memory.jsonl', 'conversation.jsonl', 'tool-groups.json']) {
    const existing = path.dirname(await fixture(t));
    await fs.writeFile(path.join(existing, name), '');
    assert.equal(await startingToolGroupModes(existing), null, name);
  }
  await assert.rejects(startingToolGroupModes('relative/state'), /stateDir must be an absolute path/);
});
