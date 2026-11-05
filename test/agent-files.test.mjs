import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRoomLook, createRootEditor, roomLookTools } from '../src/agent-files.mjs';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';
import { createToolRegistry, executeTool, prepareToolCall } from '../src/tools.mjs';

let tick = 0;
const clock = () => new Date(Date.UTC(2030, 0, 2, 3, 4, tick++));

async function home(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-agent-files-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const agent = path.join(directory, 'agent');
  await fs.mkdir(path.join(agent, 'roots'), { recursive: true });
  await fs.writeFile(path.join(agent, 'profile.json'), JSON.stringify({
    format: PROFILE_FORMAT,
    roots: [
      { id: 'identity', path: 'roots/identity.md', placement: 'system' },
      { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' },
    ],
  }));
  await fs.writeFile(path.join(agent, 'roots', 'identity.md'), 'You are a synthetic test agent.');
  await fs.writeFile(path.join(agent, 'roots', 'voice.md'), 'Short sentences.');
  return { directory, agent, history: path.join(directory, 'history') };
}

test('saving a root writes it, reloads the profile, and keeps the old version', async t => {
  const { agent, history } = await home(t);
  const reloads = [];
  const initial = await loadProfile(agent);
  const editor = await createRootEditor({ profile: initial, historyDir: history, clock, onReload: next => reloads.push(next) });
  const before = editor.get('identity');
  assert.equal(before.text, 'You are a synthetic test agent.');
  const saved = await editor.save({ id: 'identity', text: 'You are Fern, a synthetic test agent.', expectedSha256: before.sha256 });
  assert.equal(saved.text, 'You are Fern, a synthetic test agent.');
  assert.equal(await fs.readFile(path.join(agent, 'roots', 'identity.md'), 'utf8'), 'You are Fern, a synthetic test agent.');
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0].roots[0].text, 'You are Fern, a synthetic test agent.');
  assert.match(reloads[0].roots[0].observedThrough, /^2030-01-02T03:04:/);
  assert.notEqual(reloads[0].roots[0].observedThrough, initial.roots[0].observedThrough);
  assert.equal(reloads[0].roots[1].sha256, initial.roots[1].sha256, 'an unchanged root keeps its content version');
  assert.equal(editor.profile.roots[0].text, 'You are Fern, a synthetic test agent.');

  const versions = await editor.history('identity');
  assert.equal(versions.length, 1);
  assert.match(versions[0].preview, /synthetic test agent/);
  const restored = await editor.restore({ id: 'identity', version: versions[0].version });
  assert.equal(restored.text, 'You are a synthetic test agent.');
  assert.equal((await editor.history('identity')).length, 2, 'restoring keeps the replaced text too');
});

test('a stale edit is refused, and empty or oversized text never reaches the file', async t => {
  const { agent, history } = await home(t);
  const editor = await createRootEditor({ profile: await loadProfile(agent), historyDir: history, clock });
  const opened = editor.get('voice');
  await fs.writeFile(path.join(agent, 'roots', 'voice.md'), 'Changed in another editor.');
  await assert.rejects(editor.save({ id: 'voice', text: 'Mine.', expectedSha256: opened.sha256 }), error => error.status === 409 && /changed since you opened it/.test(error.message));
  assert.equal(await fs.readFile(path.join(agent, 'roots', 'voice.md'), 'utf8'), 'Changed in another editor.');

  const fresh = editor.get('voice');
  const sha = (await import('node:crypto')).createHash('sha256').update('Changed in another editor.').digest('hex');
  await assert.rejects(editor.save({ id: 'voice', text: '   ', expectedSha256: sha }), /cannot be empty/);
  await assert.rejects(editor.save({ id: 'voice', text: 'x'.repeat(70 * 1024), expectedSha256: sha }), /at most/);
  await assert.rejects(editor.save({ id: 'nope', text: 'x', expectedSha256: sha }), error => error.status === 404);
  assert.ok(fresh);
  await assert.rejects(editor.restore({ id: 'voice', version: '../../etc' }), /not a saved version/);
});

test('names, icons, and pronouns are checked, saved, and survive a reload', async t => {
  const { directory } = await home(t);
  const file = path.join(directory, 'state', 'look.json');
  const look = await createRoomLook({ file });
  assert.deepEqual(look.get(), {
    agent: { name: 'Agent', nameBy: null, icon: null, iconBy: null, iconHistory: [], pronouns: null, pronounForms: null, pronounsBy: null },
    person: { name: 'You', nameBy: null, icon: null, iconBy: null, iconHistory: [], pronouns: null, pronounForms: null, pronounsBy: null },
  });
  await look.update({ who: 'agent', name: '  Fern  ', icon: { kind: 'emoji', value: '🌿' }, pronouns: ' they / them ', by: 'agent' });
  await look.update({ who: 'agent', name: 'Fern', by: 'person' });
  assert.equal(look.get().agent.nameBy, 'agent', 'a normalized no-op cannot steal attribution');
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')}`;
  await look.update({ who: 'person', name: 'Synthetic Person', icon: { kind: 'image', dataUrl: png } });
  const reloaded = await createRoomLook({ file });
  assert.deepEqual(reloaded.get().agent, {
    name: 'Fern', nameBy: 'agent', icon: { kind: 'emoji', value: '🌿' }, iconBy: 'agent', iconHistory: [], pronouns: 'they / them',
    pronounForms: {
      subject: 'they', object: 'them', possessiveDeterminer: 'their', possessivePronoun: 'theirs', reflexive: 'themself', agreement: 'plural',
    },
    pronounsBy: 'agent',
  });
  assert.equal(reloaded.get().person.name, 'Synthetic Person');
  assert.equal(reloaded.get().person.nameBy, 'person');
  assert.equal(reloaded.get().person.icon.kind, 'image');
  assert.match(reloaded.contextText(), /"they \/ them"/);
  assert.match(reloaded.contextText(), /"agreement":"plural"/);

  await assert.rejects(look.update({ who: 'person', icon: { kind: 'image', dataUrl: 'data:image/png;base64,SGVsbG8=' } }), /not the kind of image/);
  await assert.rejects(look.update({ who: 'person', icon: { kind: 'image', dataUrl: 'data:text/html;base64,PGI+' } }), /PNG, JPEG, WebP or GIF/);
  await assert.rejects(look.update({ who: 'agent', icon: { kind: 'emoji', value: '<script>' } }), /one to eight characters/);
  await assert.rejects(look.update({ who: 'agent', name: 'x'.repeat(41) }), /at most 40/);
  await assert.rejects(look.update({ who: 'agent', pronouns: 'x'.repeat(81) }), /at most 80/);
  await assert.rejects(look.update({ who: 'stranger', name: 'x' }), /agent or person/);
  await look.update({ who: 'agent', name: 'Agent', by: 'person' });
  assert.equal(look.get().agent.nameBy, 'person', 'an intentional literal default name keeps its actor');
  assert.equal((await createRoomLook({ file })).get().agent.nameBy, 'person', 'literal default attribution survives reopening');
  await look.update({ who: 'agent', name: 'Agent', by: 'agent' });
  assert.equal(look.get().agent.nameBy, 'person', 'an identical literal name keeps its earlier actor');
  await look.update({ who: 'agent', name: '', icon: null, pronouns: '', by: 'agent' });
  const { iconHistory, ...cleared } = look.get().agent;
  assert.deepEqual(cleared, { name: 'Agent', nameBy: null, icon: null, iconBy: null, pronouns: null, pronounForms: null, pronounsBy: null });
  assert.ok(Array.isArray(iconHistory), 'earlier portraits are kept');
});

test('legacy pronoun badges gain safe grammar without guessing ambiguous labels', async t => {
  const { directory } = await home(t);
  const file = path.join(directory, 'state', 'look.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    agent: { name: 'Fern', icon: null, pronouns: 'she/her', pronounsBy: 'agent' },
    person: { name: '', nameBy: 'agent', icon: null, pronouns: null, pronounsBy: null },
  }));
  const look = await createRoomLook({ file });
  assert.equal(look.get().agent.nameBy, null, 'legacy names do not gain an invented owner');
  assert.equal(look.get().person.name, 'You');
  assert.equal(look.get().person.nameBy, null, 'an empty saved name cannot claim the generated default');
  assert.deepEqual(look.get().agent.pronounForms, {
    subject: 'she', object: 'her', possessiveDeterminer: 'her', possessivePronoun: 'hers', reflexive: 'herself', agreement: 'singular',
  });
  await look.update({ who: 'agent', pronouns: 'any pronouns', by: 'person' });
  assert.equal(look.get().agent.pronounForms, null);
  assert.match(look.contextText(), /use "the agent"/);
});

test('the agent can set its own UI pronouns through a bounded room tool', async t => {
  const { directory } = await home(t);
  const look = await createRoomLook({ file: path.join(directory, 'state', 'look.json') });
  const tools = createToolRegistry(roomLookTools(look));
  assert.equal(
    prepareToolCall(tools, 'set_my_pronouns', { pronouns: 'she/her + xe/xem' }).permissionSummary,
    "Set this agent's room pronouns to she/her + xe/xem.",
  );
  const result = await executeTool(tools, 'set_my_pronouns', { pronouns: 'she/her + xe/xem' });
  const she = { subject: 'she', object: 'her', possessiveDeterminer: 'her', possessivePronoun: 'hers', reflexive: 'herself', agreement: 'singular' };
  assert.deepEqual(result, { pronouns: 'she/her + xe/xem', pronounForms: she, displayed: true });
  assert.deepEqual(look.get().agent, {
    name: 'Agent', nameBy: null, icon: null, iconBy: null, iconHistory: [], pronouns: 'she/her + xe/xem', pronounForms: she, pronounsBy: 'agent',
  });
  await assert.rejects(executeTool(tools, 'set_my_pronouns', { pronouns: 'ze/zem', subject: 'ze' }), /custom pronouns need/);
  const custom = await executeTool(tools, 'set_my_pronouns', {
    pronouns: 'ze/zem', subject: 'ze', object: 'zem', possessive_determiner: 'zes', possessive_pronoun: 'zes', reflexive: 'zemself', agreement: 'singular',
  });
  assert.deepEqual(custom.pronounForms, {
    subject: 'ze', object: 'zem', possessiveDeterminer: 'zes', possessivePronoun: 'zes', reflexive: 'zemself', agreement: 'singular',
  });
  assert.deepEqual(await executeTool(tools, 'set_my_pronouns', { pronouns: '' }), { pronouns: null, pronounForms: null, displayed: false });
});
