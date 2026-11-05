import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLoadedProfile, isUnwrittenRoot, loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';

const manifest = roots => ({ format: PROFILE_FORMAT, roots });
const rows = [
  { id: 'identity', path: 'roots/identity.md', placement: 'system' },
  { id: 'relationships', path: 'roots/relationships.md', placement: 'system' },
  { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' },
];
const observedAt = '2030-01-02T03:04:05.000Z';

async function home(t, { profile = manifest(rows), files = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'roots'), { recursive: true });
  await fs.writeFile(path.join(directory, 'profile.json'), JSON.stringify(profile, null, 2));
  const defaults = {
    'roots/identity.md': '# Identity\nI am a test agent.\n',
    'roots/relationships.md': '# Relationships\nThe test operator may correct this file.\n',
    'roots/voice.md': '# Voice\nWrite with exact, plain language.\n',
  };
  for (const [relative, content] of Object.entries({ ...defaults, ...files })) {
    const target = path.join(directory, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return directory;
}

test('roots load in declared order, preserve exact text, and produce a deterministic health receipt', async t => {
  const directory = await home(t, { files: { 'roots/voice.md': '# Voice\r\nToken-shaped {owner} text stays literal. ☆\r\n' } });
  const clock = () => new Date(observedAt);
  const first = await loadProfile(directory, { clock });
  const second = await loadProfile(directory, { clock });
  assert.deepEqual(first.roots.map(root => root.id), ['identity', 'relationships', 'voice']);
  assert.deepEqual(first.systemRoots.map(root => root.id), ['identity', 'relationships']);
  assert.deepEqual(first.tailRoots.map(root => root.id), ['voice']);
  assert.equal(first.tailRoots[0].text, '# Voice\r\nToken-shaped {owner} text stays literal. ☆\r\n');
  assert.deepEqual(first.receipt, second.receipt);
  assert.equal(first.receipt.manifest.observedThrough, observedAt);
  assert.deepEqual(first.receipt.roots.map(root => root.observedThrough), [observedAt, observedAt, observedAt]);
  assert.match(first.receipt.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.receipt.totals.roots, 3);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.receipt.roots[0]), true);
  assert.equal(isLoadedProfile(first), true);
  assert.equal(isLoadedProfile({ ...first }), false);
});

test('each root keeps its own exact load edge without changing the content fingerprint', async t => {
  const directory = await home(t);
  let tick = 0;
  const first = await loadProfile(directory, { clock: () => new Date(Date.parse(observedAt) + tick++ * 1000) });
  const edges = [first.receipt.manifest.observedThrough, ...first.receipt.roots.map(root => root.observedThrough)];
  assert.equal(edges.every(edge => new Date(edge).toISOString() === edge), true);
  assert.equal(new Set(edges).size, edges.length, 'the manifest and each root keep their own completed-read edge');
  assert.deepEqual(edges, [...edges].sort(), 'root edges follow manifest order');
  assert.deepEqual(first.roots.map(root => root.observedThrough), first.receipt.roots.map(root => root.observedThrough));

  const second = await loadProfile(directory, { clock: () => new Date('2030-01-03T00:00:00.000Z') });
  assert.equal(second.receipt.fingerprint, first.receipt.fingerprint);
  assert.deepEqual(second.receipt.roots.map(root => root.sha256), first.receipt.roots.map(root => root.sha256));
  assert.notDeepEqual(second.receipt.roots.map(root => root.observedThrough), first.receipt.roots.map(root => root.observedThrough));
});

test('changing one root changes its hash and the profile fingerprint, not another root receipt', async t => {
  const directory = await home(t);
  const before = await loadProfile(directory);
  await fs.appendFile(path.join(directory, 'roots', 'voice.md'), 'Another sentence.\n');
  const after = await loadProfile(directory);
  assert.equal(after.receipt.roots[0].sha256, before.receipt.roots[0].sha256);
  assert.notEqual(after.receipt.roots[2].sha256, before.receipt.roots[2].sha256);
  assert.notEqual(after.receipt.fingerprint, before.receipt.fingerprint);
});

test('the manifest is strict, ordered, and requires both root placements', async t => {
  const cases = [
    [{ ...manifest(rows), extra: true }, /unknown field "extra"/],
    [manifest([{ ...rows[0], extra: true }, rows[2]]), /roots\[0\] has unknown field "extra"/],
    [manifest([rows[0], { ...rows[2], id: 'identity' }]), /repeats root id "identity"/],
    [manifest([rows[0], { ...rows[2], path: 'ROOTS\/IDENTITY.MD' }]), /repeats root path/],
    [manifest([rows[2], rows[0]]), /system roots must precede/],
    [manifest([rows[0]]), /at least one user-tail/],
    [manifest([rows[2]]), /at least one system root/],
    [{ format: 'fieldwork-profile/v2', roots: rows }, /format must be fieldwork-profile\/v1/],
  ];
  for (const [profile, pattern] of cases) {
    const directory = await home(t, { profile });
    await assert.rejects(loadProfile(directory), pattern);
  }
  const duplicate = await home(t);
  await fs.writeFile(path.join(duplicate, 'profile.json'), `{"format":"${PROFILE_FORMAT}","roots":[],"roots":${JSON.stringify(rows)}}`);
  await assert.rejects(loadProfile(duplicate), /repeats object key "roots"/);
});

test('root paths are portable, relative, contained, and Markdown', async t => {
  const badPaths = [
    '../outside.md', 'roots/../outside.md', '/absolute.md', 'C:/absolute.md',
    'roots\\voice.md', 'roots//voice.md', 'roots/voice.txt', 'roots/con.md', 'roots/com¹.md',
    'roots/trailing. /voice.md', 'roots/cafe\u0301.md',
  ];
  for (const badPath of badPaths) {
    const profile = manifest([rows[0], { ...rows[2], path: badPath }]);
    const directory = await home(t, { profile });
    await assert.rejects(loadProfile(directory), /Profile:/);
  }
});

test('empty, invalid UTF-8, per-root excess and aggregate excess are refused', async t => {
  const empty = await home(t, { files: { 'roots/voice.md': ' \r\n' } });
  await assert.rejects(loadProfile(empty), /root voice is empty/);

  const invalid = await home(t);
  await fs.writeFile(path.join(invalid, 'roots', 'voice.md'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(loadProfile(invalid), /root voice must be valid UTF-8/);

  const large = await home(t, {
    profile: manifest([rows[0], rows[2]]),
    files: { 'roots/identity.md': '12345', 'roots/voice.md': '123456' },
  });
  await assert.rejects(loadProfile(large, { maxRootBytes: 5 }), /root voice is 6 bytes; the limit is 5/);

  const aggregate = await home(t);
  await assert.rejects(loadProfile(aggregate, { maxTotalRootBytes: 20 }), /roots total .* the limit is 20/);

  const manifestLimit = await home(t);
  await assert.rejects(loadProfile(manifestLimit, { maxManifestBytes: 10 }), /profile\.json is .* bytes; the limit is 10/);

  const invalidManifest = await home(t);
  await fs.writeFile(path.join(invalidManifest, 'profile.json'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(loadProfile(invalidManifest), /profile\.json must be valid UTF-8/);

  const tooMany = await home(t);
  await assert.rejects(loadProfile(tooMany, { maxRoots: 2 }), /has 3 roots; the limit is 2/);
});

test('a symbolic-link file cannot supply a root', async t => {
  const directory = await home(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-profile-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'voice.md'), '# Outside\n');
  const voice = path.join(directory, 'roots', 'voice.md');
  await fs.rm(voice);
  try { await fs.symlink(path.join(outside, 'voice.md'), voice, 'file'); }
  catch (error) { t.skip(`symbolic links unavailable: ${error.code}`); return; }
  await assert.rejects(loadProfile(directory), /root voice may not pass through a symbolic link/);
});

test('a junction cannot supply an intermediate root directory', async t => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-profile-junction-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const second = await home(t);
  await fs.rm(path.join(second, 'roots'), { recursive: true });
  try { await fs.symlink(outside, path.join(second, 'roots'), 'junction'); }
  catch (error) { t.skip(`junctions unavailable: ${error.code}`); return; }
  await assert.rejects(loadProfile(second), /root identity may not pass through a symbolic link/);
});

test('two homes load independently and loader options cannot be malformed', async t => {
  const one = await home(t, { files: { 'roots/identity.md': '# Identity\nOne.\n' } });
  const two = await home(t, { files: { 'roots/identity.md': '# Identity\nTwo.\n' } });
  const [first, second] = await Promise.all([loadProfile(one), loadProfile(two)]);
  assert.match(first.systemRoots[0].text, /One/);
  assert.match(second.systemRoots[0].text, /Two/);
  await assert.rejects(loadProfile(one, []), /loader options must be an object/);
  await assert.rejects(loadProfile(one, { maxRoots: 0 }), /maxRoots must be a positive whole number/);
  await assert.rejects(loadProfile(one, { maxRoots: '3' }), /maxRoots must be a positive whole number/);
  await assert.rejects(loadProfile(one, { maxRootByte: 1 }), /unknown field "maxRootByte"/);
  await assert.rejects(loadProfile(one, { clock: 'now' }), /clock must be a function/);
  await assert.rejects(loadProfile(one, { clock: () => 'not-a-time' }), /clock returned an invalid time/);
  await assert.rejects(loadProfile(one, { clock: () => { throw new Error('synthetic clock failure'); } }), /clock failed: synthetic clock failure/);
  await assert.rejects(loadProfile(one, { manifestPath: '' }), /manifestPath must be a relative/);
  await assert.rejects(loadProfile(undefined), /agent home must be a nonempty path/);
  await assert.rejects(loadProfile('', {}), /agent home must be a nonempty path/);
  await assert.rejects(loadProfile(one, new Date()), /loader options must be an object/);
});

test('an initial UTF-8 BOM remains part of exact root text and its byte receipt', async t => {
  const directory = await home(t);
  const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Voice\nExact.\n')]);
  await fs.writeFile(path.join(directory, 'roots', 'voice.md'), source);
  const loaded = await loadProfile(directory);
  assert.equal(loaded.tailRoots[0].text.charCodeAt(0), 0xfeff);
  assert.equal(loaded.tailRoots[0].bytes, source.length);
});

test('prototype pollution cannot supply manifest, root, or loader-option fields', async t => {
  const directory = await home(t);
  Object.prototype.format = PROFILE_FORMAT;
  Object.prototype.roots = rows;
  Object.prototype.maxRoots = 1;
  try {
    await fs.writeFile(path.join(directory, 'profile.json'), '{}');
    await assert.rejects(loadProfile(directory), /format must be/);

    await fs.writeFile(path.join(directory, 'profile.json'), JSON.stringify({ format: PROFILE_FORMAT, roots: [{}] }));
    Object.prototype.id = 'identity';
    Object.prototype.path = 'roots/identity.md';
    Object.prototype.placement = 'system';
    await assert.rejects(loadProfile(directory), /\.id must be/);
  } finally {
    for (const key of ['format', 'roots', 'maxRoots', 'id', 'path', 'placement']) delete Object.prototype[key];
  }
});

test('the shipped template roots read as unwritten until a person writes them', async () => {
  for (const name of ['identity', 'relationships', 'voice']) {
    const text = await fs.readFile(new URL(`../templates/agent-home/roots/${name}.md`, import.meta.url), 'utf8');
    assert.equal(isUnwrittenRoot(text), true, name);
    assert.equal(isUnwrittenRoot(text.replace(/\r?\n/g, '\r\n')), true, `${name} with CRLF`);
  }
  assert.equal(isUnwrittenRoot('# Identity\n\n'), true, 'a heading alone is still blank');
  assert.equal(isUnwrittenRoot('# Identity\n\nI am Wren, and I keep a notebook.'), false);
  assert.equal(isUnwrittenRoot('# Voice\n\n[quietly, in short paragraphs]'), false, 'bracket-only authored prose is not a template');
  assert.equal(isUnwrittenRoot('[Write who the agent is.]'), false, 'an arbitrary bracketed instruction is not a shipped template');
  assert.equal(isUnwrittenRoot('# Identity\n\n[Write who the agent is.]\n\nI am Wren.'), false, 'a kept instruction plus real text counts as written');
  assert.equal(isUnwrittenRoot('[I like [nested] brackets]'), false);
  assert.equal(isUnwrittenRoot(undefined), false);
});
