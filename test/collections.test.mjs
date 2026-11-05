import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectionTools, createCollections, entrySlug } from '../src/collections.mjs';
import { createToolRegistry, prepareToolCall } from '../src/tools.mjs';

async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-collections-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'workspace', 'collections');
}

let minute = 0;
const clock = () => new Date(Date.UTC(2030, 0, 2, 3, minute++));

test('a collection is a folder of markdown entries with fields, kept as plain files', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  const tools = createToolRegistry(collectionTools(collections));
  const summary = prepareToolCall(tools, 'save_entry', {
    collection: 'plants', title: 'Sundew', text: 'PRIVATE SYNTHETIC COLLECTION BODY',
  }).permissionSummary;
  assert.match(summary, /Save Sundew in collection plants/);
  assert.doesNotMatch(summary, /PRIVATE SYNTHETIC COLLECTION BODY/);
  await collections.make({ name: 'Plants', description: 'plants I have met', fields: ['light', 'water'] });
  const saved = await collections.save({ collection: 'plants', title: 'Sundew', fields: { light: 'bright', water: 'rainwater only' }, text: 'Sticky and **carnivorous**.' });
  assert.deepEqual({ entry: saved.entry, created: saved.created }, { entry: 'sundew', created: true });
  const file = await fs.readFile(path.join(dir, 'plants', 'sundew.md'), 'utf8');
  assert.match(file, /^---\ntitle: Sundew\nlight: bright\nwater: rainwater only\n/);
  assert.match(file, /Sticky and \*\*carnivorous\*\*\./);
  const listed = await collections.list();
  assert.deepEqual(listed.map(row => [row.name, row.description, row.fields, row.entries]), [['plants', 'plants I have met', ['light', 'water'], 1]]);
  const read = await collections.read({ collection: 'plants', entry: 'Sundew' });
  assert.equal(read.fields.water, 'rainwater only');
  assert.equal(entrySlug('Venus Flytrap!'), 'venus-flytrap');
});

test('saving again keeps the previous version, and removing keeps the entry aside', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'plants' });
  await collections.save({ collection: 'plants', title: 'Moss', fields: { light: 'shade' }, text: 'Soft.' });
  const again = await collections.save({ collection: 'plants', title: 'Moss', fields: { water: 'often' }, text: '', mergeFields: true });
  assert.equal(again.created, false);
  assert.deepEqual(again.retention, { limit: 10, retained: 1, pruned: 0 });
  const moss = await collections.read({ collection: 'plants', entry: 'moss' });
  assert.deepEqual(moss.fields, { light: 'shade', water: 'often' }, 'merge keeps old fields');
  assert.equal(moss.text.trim(), 'Soft.', 'empty text with merge keeps the old text');
  assert.equal((await fs.readdir(path.join(dir, 'plants', '.history', 'moss'))).length, 1);
  await collections.remove({ collection: 'plants', entry: 'Moss' });
  assert.equal((await collections.list())[0].entries, 0);
  assert.equal((await fs.readdir(path.join(dir, 'plants', '.removed'))).length, 1, 'removed is kept aside');
  const history = await collections.history({ collection: 'plants', entry: 'moss' });
  assert.equal(history.current, null, 'removal does not hide the earlier history');
  assert.equal(history.versions.length, 1);
  assert.equal((await collections.version({
    collection: 'plants', entry: history.entry, versionId: history.versions[0].versionId,
  })).value.fields.light, 'shade');
});

test('a single removed entry remains discoverable with an empty current history', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Only copy', text: 'kept aside' });
  await collections.remove({ collection: 'notes', entry: 'only-copy' });

  const history = await collections.history({ collection: 'notes', entry: 'only-copy' });
  assert.equal(history.current, null);
  assert.deepEqual(history.versions, []);
  await assert.rejects(collections.history({ collection: 'notes', entry: 'never-existed' }), /no entry/);
});

test('same-clock concurrent saves serialize and keep collision-proof versions', async t => {
  const dir = await root(t);
  const fixed = () => new Date('2030-01-02T03:04:05.000Z');
  const collections = await createCollections({ root: dir, clock: fixed });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'One', text: 'baseline' });

  const [first, second] = await Promise.all([
    collections.save({ collection: 'notes', title: 'One', text: 'first update' }),
    collections.save({ collection: 'notes', title: 'One', text: 'second update' }),
  ]);
  assert.deepEqual(first.retention, { limit: 10, retained: 1, pruned: 0 });
  assert.deepEqual(second.retention, { limit: 10, retained: 2, pruned: 0 });
  assert.equal((await collections.read({ collection: 'notes', entry: 'one' })).text.trim(), 'second update');
  const versions = (await fs.readdir(path.join(dir, 'notes', '.history', 'one'))).filter(name => name.endsWith('.md'));
  assert.equal(versions.length, 2);
  assert.equal(new Set(versions).size, 2);
  assert.ok(versions.every(name => /^2030-01-02T03-04-05-000Z\.\d{12}\.[0-9a-f-]{36}\.md$/.test(name)));
});

test('non-Latin and colliding titles keep stable, distinct entry identities', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'notes' });

  const nonLatin = await collections.save({ collection: 'notes', title: '日本語', text: 'first' });
  const nonLatinAgain = await collections.save({ collection: 'notes', title: '日本語', text: 'second' });
  assert.equal(nonLatinAgain.entry, nonLatin.entry);
  assert.equal(nonLatinAgain.created, false);
  assert.match(nonLatin.entry, /^entry-[0-9a-f]{12}$/u);
  assert.equal((await fs.readdir(path.join(dir, 'notes', '.history', nonLatin.entry))).length, 1);

  const slash = await collections.save({ collection: 'notes', title: 'A/B', text: 'slash' });
  const space = await collections.save({ collection: 'notes', title: 'A B', text: 'space' });
  assert.notEqual(space.entry, slash.entry);
  assert.equal((await collections.read({ collection: 'notes', entry: slash.entry })).text.trim(), 'slash');
  assert.equal((await collections.read({ collection: 'notes', entry: space.entry })).text.trim(), 'space');
  assert.equal((await collections.read({ collection: 'notes', entry: 'A B' })).text.trim(), 'space');
  await collections.remove({ collection: 'notes', entry: 'A B' });
  assert.equal((await collections.read({ collection: 'notes', entry: 'A/B' })).text.trim(), 'slash');
  await assert.rejects(collections.read({ collection: 'notes', entry: 'A B' }), /no entry/);
});

test('history retention is bounded, reported, and leaves the latest current readable', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock: () => new Date('2030-01-02T03:04:05.000Z') });
  await collections.make({ name: 'notes' });
  let receipt = await collections.save({ collection: 'notes', title: 'Rolling', text: 'version 0' });
  for (let version = 1; version <= 12; version++) {
    receipt = await collections.save({ collection: 'notes', title: 'Rolling', text: `version ${version}` });
  }
  assert.equal((await collections.read({ collection: 'notes', entry: 'rolling' })).text.trim(), 'version 12');
  assert.deepEqual(receipt.retention, { limit: 10, retained: 10, pruned: 1 });
  const historyDir = path.join(dir, 'notes', '.history', 'rolling');
  const retained = (await fs.readdir(historyDir)).filter(name => name.endsWith('.md'));
  assert.equal(retained.length, 10);
  const retainedText = await Promise.all(retained.map(name => fs.readFile(path.join(historyDir, name), 'utf8')));
  assert.ok(retainedText.some(text => text.endsWith('version 11\n')), 'the immediately displaced version survives even when every clock value ties');
});

test('an exhausted retained sequence fails before changing the current entry', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock: () => new Date('2030-01-02T03:04:05.000Z') });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Sequence', text: 'first' });
  await collections.save({ collection: 'notes', title: 'Sequence', text: 'second' });
  const historyDir = path.join(dir, 'notes', '.history', 'sequence');
  const [version] = await fs.readdir(historyDir);
  await fs.rename(path.join(historyDir, version), path.join(historyDir, '2030-01-02T03-04-05-000Z.999999999999.00000000-0000-4000-8000-000000000000.md'));

  await assert.rejects(collections.save({ collection: 'notes', title: 'Sequence', text: 'must not land' }), /exhausted its version sequence/);
  assert.equal((await collections.read({ collection: 'notes', entry: 'sequence' })).text.trim(), 'second');
  assert.equal((await fs.readdir(historyDir)).length, 1);
});

async function makeDirectoryLink(t, target, link) {
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP') {
      t.diagnostic(`directory links are unavailable here: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('history and removed archives refuse linked directories', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock: () => new Date('2030-01-02T03:04:05.000Z') });

  await collections.make({ name: 'linked-history' });
  await collections.save({ collection: 'linked-history', title: 'Entry', text: 'safe' });
  const outsideHistory = path.join(path.dirname(dir), 'outside-history');
  await fs.mkdir(outsideHistory, { recursive: true });
  if (await makeDirectoryLink(t, outsideHistory, path.join(dir, 'linked-history', '.history'))) {
    await assert.rejects(collections.save({ collection: 'linked-history', title: 'Entry', text: 'blocked' }), /plain directory/);
    assert.deepEqual(await fs.readdir(outsideHistory), []);
  }

  await collections.make({ name: 'linked-entry-history' });
  await collections.save({ collection: 'linked-entry-history', title: 'Entry', text: 'safe' });
  await fs.mkdir(path.join(dir, 'linked-entry-history', '.history'));
  const outsideEntryHistory = path.join(path.dirname(dir), 'outside-entry-history');
  await fs.mkdir(outsideEntryHistory, { recursive: true });
  if (await makeDirectoryLink(t, outsideEntryHistory, path.join(dir, 'linked-entry-history', '.history', 'entry'))) {
    await assert.rejects(collections.save({ collection: 'linked-entry-history', title: 'Entry', text: 'blocked' }), /plain directory/);
    assert.deepEqual(await fs.readdir(outsideEntryHistory), []);
  }

  await collections.make({ name: 'linked-removed' });
  await collections.save({ collection: 'linked-removed', title: 'Entry', text: 'safe' });
  const outsideRemoved = path.join(path.dirname(dir), 'outside-removed');
  await fs.mkdir(outsideRemoved, { recursive: true });
  if (await makeDirectoryLink(t, outsideRemoved, path.join(dir, 'linked-removed', '.removed'))) {
    await assert.rejects(collections.remove({ collection: 'linked-removed', entry: 'entry' }), /plain directory/);
    assert.deepEqual(await fs.readdir(outsideRemoved), []);
  }
});

test('malformed, oversized, linked, and special current entries are never treated as absent', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'notes' });
  const folder = path.join(dir, 'notes');

  const malformedFile = path.join(folder, 'malformed.md');
  await fs.writeFile(malformedFile, 'plain text without a collection header');
  await assert.rejects(collections.save({ collection: 'notes', title: 'Malformed', text: 'replacement' }), /no valid field header/);
  assert.equal(await fs.readFile(malformedFile, 'utf8'), 'plain text without a collection header');

  const oversizedFile = path.join(folder, 'oversized.md');
  const oversized = 'x'.repeat(128 * 1024 + 1);
  await fs.writeFile(oversizedFile, oversized);
  await assert.rejects(collections.save({ collection: 'notes', title: 'Oversized', text: 'replacement' }), /too large/);
  assert.equal((await fs.stat(oversizedFile)).size, Buffer.byteLength(oversized));

  const specialFile = path.join(folder, 'special.md');
  await fs.mkdir(specialFile);
  await assert.rejects(collections.save({ collection: 'notes', title: 'Special', text: 'replacement' }), /plain file/);

  const outside = path.join(path.dirname(dir), 'outside-entry.md');
  await fs.writeFile(outside, 'OUTSIDE MUST STAY UNCHANGED');
  try {
    await fs.symlink(outside, path.join(folder, 'linked.md'));
    await assert.rejects(collections.save({ collection: 'notes', title: 'Linked', text: 'replacement' }), /plain file/);
    assert.equal(await fs.readFile(outside, 'utf8'), 'OUTSIDE MUST STAY UNCHANGED');
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'ENOTSUP') throw error;
    t.diagnostic(`file links are unavailable here: ${error.code}`);
  }
});

test('a same-size backdated edit cannot hide behind the read cache during a save', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Cached', text: 'warm the parsed cache' });
  await collections.read({ collection: 'notes', entry: 'cached' });

  const file = path.join(dir, 'notes', 'cached.md');
  const before = await fs.readFile(file);
  const times = await fs.stat(file);
  const malformed = Buffer.alloc(before.length, 0x78);
  await fs.writeFile(file, malformed);
  await fs.utimes(file, times.atime, times.mtime);

  await assert.rejects(collections.save({ collection: 'notes', title: 'Cached', text: 'must not land' }), /no valid field header/);
  assert.deepEqual(await fs.readFile(file), malformed);
  await assert.rejects(fs.access(path.join(dir, 'notes', '.history', 'cached')));
});

test('search ranks by title, fields and text, filters exact fields, and lists the newest with no words', async t => {
  const collections = await createCollections({ root: await root(t), clock });
  await collections.make({ name: 'plants' });
  await collections.make({ name: 'recipes' });
  await collections.save({ collection: 'plants', title: 'Sundew', fields: { water: 'rainwater' }, text: 'Catches gnats.' });
  await collections.save({ collection: 'plants', title: 'Fern', fields: { water: 'weekly' }, text: 'A sundew grew beside it once.' });
  await collections.save({ collection: 'recipes', title: 'Moss tea', fields: { water: 'weekly' }, text: 'Not real tea.' });
  const sundew = await collections.search({ query: 'sundew' });
  assert.deepEqual(sundew.map(row => row.title), ['Sundew', 'Fern'], 'a title match outranks a text match');
  assert.match(sundew[1].snippet, /sundew grew/);
  const weekly = await collections.search({ where: { water: 'Weekly' } });
  assert.deepEqual(weekly.map(row => row.title).sort(), ['Fern', 'Moss tea']);
  const onlyPlants = await collections.search({ where: { water: 'weekly' }, collection: 'plants' });
  assert.deepEqual(onlyPlants.map(row => row.title), ['Fern']);
  const newest = await collections.search({});
  assert.equal(newest[0].title, 'Moss tea');
});

test('names and fields are checked, and nothing escapes the collections folder', async t => {
  const collections = await createCollections({ root: await root(t), clock });
  await assert.rejects(collections.make({ name: '../outside' }), /collection name/);
  await collections.make({ name: 'notes' });
  await assert.rejects(collections.make({ name: 'notes' }), /already exists/);
  await assert.rejects(collections.save({ collection: 'notes', title: 'x', fields: { title: 'sneaky' } }), /cannot be a field name/);
  await assert.rejects(collections.save({ collection: 'missing', title: 'x' }), /no collection called "missing"/);
  const saved = await collections.save({ collection: 'notes', title: '../../etc/passwd' });
  assert.equal(saved.entry, 'etc-passwd', 'a title can only ever become a plain file name');
  await assert.rejects(collections.read({ collection: 'notes', entry: 'nope' }), /no entry/);
});

test('history exposes path-free exact fingerprints and raw versions newest first', async t => {
  const dir = await root(t);
  let tick = 0;
  const localClock = () => new Date(Date.UTC(2031, 0, 2, 3, tick++));
  const collections = await createCollections({ root: dir, clock: localClock });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Trace', text: 'zero' });
  await collections.save({ collection: 'notes', title: 'Trace', text: 'one' });
  await collections.save({ collection: 'notes', title: 'Trace', text: 'two' });

  const history = await collections.history({ collection: 'notes', entry: 'Trace' });
  assert.equal(history.retentionLimit, 10);
  assert.equal(history.current.kind, 'current');
  assert.match(history.current.fingerprint, /^[0-9a-f]{64}$/u);
  assert.deepEqual(history.versions.map(row => row.updated), [
    '2031-01-02T03:02:00.000Z',
    '2031-01-02T03:01:00.000Z',
  ]);
  assert.ok(history.versions.every(row => row.kind === 'history' && /^history:[A-Za-z0-9_-]+:[0-9a-f]{64}$/u.test(row.versionId)));
  assert.equal(JSON.stringify(history).includes(dir), false);

  const exact = await collections.version({ collection: 'notes', entry: history.entry, versionId: history.versions[0].versionId });
  assert.equal(exact.value.text.trim(), 'one');
  assert.match(exact.raw, /\none\n$/u);
  assert.equal(exact.fingerprint, history.versions[0].fingerprint);
  assert.equal(JSON.stringify(exact).includes(dir), false);

  const reopened = await createCollections({ root: dir, clock: localClock });
  assert.deepEqual((await reopened.history({ collection: 'notes', entry: 'trace' })).versions.map(row => row.versionId), history.versions.map(row => row.versionId));
  await assert.rejects(reopened.version({ collection: 'notes', entry: 'trace', versionId: '../history.md' }), /versionId/);
});

test('removed versions page newest first with a stable insertion-safe cursor and exact reads', async t => {
  const dir = await root(t);
  const fixed = () => new Date('2032-02-03T04:05:06.000Z');
  let collections = await createCollections({ root: dir, clock: fixed });
  await collections.make({ name: 'notes' });
  for (const title of ['First', 'Second', 'Third']) {
    await collections.save({ collection: 'notes', title, text: `${title} body` });
    await collections.remove({ collection: 'notes', entry: title });
  }

  const firstPage = await collections.removed({ collection: 'notes', cursor: 0, limit: 2 });
  assert.deepEqual(firstPage.items.map(row => row.title), ['Third', 'Second']);
  assert.equal(firstPage.total, 3);
  assert.equal(typeof firstPage.nextCursor, 'string');
  assert.match(firstPage.nextCursor, /^[A-Za-z0-9_-]+$/u);
  collections = await createCollections({ root: dir, clock: fixed });
  await collections.save({ collection: 'notes', title: 'Fourth', text: 'Fourth body' });
  await collections.remove({ collection: 'notes', entry: 'fourth' });
  const secondPage = await collections.removed({ collection: 'notes', cursor: firstPage.nextCursor, limit: 2 });
  assert.deepEqual(secondPage.items.map(row => row.title), ['First']);
  assert.equal(secondPage.total, 3, 'a cursor keeps the original snapshot edge when a newer removal arrives');
  assert.equal(secondPage.nextCursor, null);
  assert.equal((await collections.removed({ collection: 'notes', cursor: 0, limit: 1 })).items[0].title, 'Fourth');
  assert.ok(firstPage.items.every(row => row.kind === 'removed' && /^removed:[A-Za-z0-9_-]+:[0-9a-f]{64}$/u.test(row.versionId)));

  const exact = await collections.version({ collection: 'notes', entry: firstPage.items[0].entry, versionId: firstPage.items[0].versionId });
  assert.equal(exact.value.text.trim(), 'Third body');
  assert.match(exact.raw, /Third body\n$/u);
  assert.equal(JSON.stringify({ firstPage, exact }).includes(dir), false);
  await assert.rejects(collections.removed({ cursor: -1 }), /cursor/);
  await assert.rejects(collections.removed({ cursor: 1 }), /cursor/);
  await assert.rejects(collections.removed({ limit: 26 }), /limit/);
});

test('removed ordering uses one durable sequence across collections when clocks tie', async t => {
  const dir = await root(t);
  const fixed = () => new Date('2032-02-03T04:05:06.000Z');
  const collections = await createCollections({ root: dir, clock: fixed });
  await collections.make({ name: 'first' });
  await collections.make({ name: 'second' });
  await collections.save({ collection: 'first', title: 'Earlier', text: 'one' });
  await collections.remove({ collection: 'first', entry: 'earlier' });
  await collections.save({ collection: 'second', title: 'Later', text: 'two' });
  await collections.remove({ collection: 'second', entry: 'later' });

  const rows = await collections.removed({ limit: 10 });
  assert.deepEqual(rows.items.map(row => [row.collection, row.title]), [['second', 'Later'], ['first', 'Earlier']]);
  const reopened = await createCollections({ root: dir, clock: fixed });
  await reopened.save({ collection: 'first', title: 'Latest', text: 'three' });
  await reopened.remove({ collection: 'first', entry: 'latest' });
  assert.deepEqual((await reopened.removed({ limit: 10 })).items.map(row => row.title), ['Latest', 'Later', 'Earlier']);
});

test('retained timestamps reject impossible calendar dates', async t => {
  const dir = await root(t);
  const fixed = () => new Date('2032-02-03T04:05:06.000Z');
  const collections = await createCollections({ root: dir, clock: fixed });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Calendar', text: 'first' });
  await collections.save({ collection: 'notes', title: 'Calendar', text: 'second' });
  const historyDir = path.join(dir, 'notes', '.history', 'calendar');
  const [name] = await fs.readdir(historyDir);
  await fs.rename(path.join(historyDir, name), path.join(historyDir, name.replace('2032-02-03', '2032-99-03')));
  await assert.rejects(collections.history({ collection: 'notes', entry: 'calendar' }), /invalid version name/);
});

test('history inspection refuses over-retention before reading archived bodies', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Bounded', text: 'current' });
  const historyDir = path.join(dir, 'notes', '.history', 'bounded');
  await fs.mkdir(historyDir, { recursive: true });
  for (let index = 1; index <= 11; index++) {
    const sequence = String(index).padStart(12, '0');
    const tail = index.toString(16).padStart(12, '0');
    const name = `2032-02-03T04-05-06-000Z.${sequence}.00000000-0000-4000-8000-${tail}.md`;
    await fs.writeFile(path.join(historyDir, name), 'this malformed body must not be read');
  }
  await assert.rejects(collections.history({ collection: 'notes', entry: 'bounded' }), /more than its 10 retained versions/);
});

test('restoration provenance requires the version id and fingerprint to name the same bytes', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'notes' });
  const retainedName = '2032-02-03T04-05-06-000Z.000000000001.00000000-0000-4000-8000-000000000001.md';
  const locator = Buffer.from(retainedName, 'utf8').toString('base64url');
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  await fs.writeFile(path.join(dir, 'notes', 'contradiction.md'), [
    '---',
    'title: Contradiction',
    'created: 2032-02-03T04:05:06.000Z',
    'updated: 2032-02-03T04:05:06.000Z',
    'by: person',
    'restored_kind: history',
    `restored_fingerprint: ${first}`,
    `restored_version: history:${locator}:${second}`,
    '---',
    '',
    'body',
  ].join('\n'));
  await assert.rejects(collections.read({ collection: 'notes', entry: 'contradiction' }), /invalid restoration provenance/);
});

test('removed inspection refuses unbounded archive scans before reading bodies', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'notes' });
  const removed = path.join(dir, 'notes', '.removed');
  await fs.mkdir(removed);
  const names = Array.from({ length: 2001 }, (_, index) => {
    const sequence = String(index + 1).padStart(12, '0');
    const tail = index.toString(16).padStart(12, '0');
    return `bulk.2032-02-03T04-05-06-000Z.${sequence}.00000000-0000-4000-8000-${tail}.md`;
  });
  for (let start = 0; start < names.length; start += 100) {
    await Promise.all(names.slice(start, start + 100).map(name => fs.writeFile(path.join(removed, name), '')));
  }
  await assert.rejects(collections.removed({ collection: 'notes' }), /limited to 2000 retained files/);
});

test('removed sequence discovery rejects non-plain archive entries before using their names', async t => {
  const dir = await root(t);
  const collections = await createCollections({ root: dir, clock });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Safe', text: 'still current' });
  const removed = path.join(dir, 'notes', '.removed');
  await fs.mkdir(removed);
  const falseVersion = path.join(removed, 'poison.2032-02-03T04-05-06-000Z.999999999999.00000000-0000-4000-8000-000000000001.md');
  await fs.mkdir(falseVersion);

  await assert.rejects(collections.remove({ collection: 'notes', entry: 'safe' }), /plain file/);
  assert.equal((await collections.read({ collection: 'notes', entry: 'safe' })).text.trim(), 'still current');
  await assert.rejects(fs.access(path.join(dir, '.removed-sequence')));

  await fs.rm(falseVersion, { recursive: true });
  await collections.remove({ collection: 'notes', entry: 'safe' });
  const [removedName] = await fs.readdir(removed);
  assert.match(removedName, /\.000000000001\./u, 'the rejected directory name did not seed durable ordering');
});

test('restoring retained history is fenced, attributed, durable, and keeps both source and displaced current', async t => {
  const dir = await root(t);
  let tick = 0;
  const localClock = () => new Date(Date.UTC(2033, 3, 5, 6, tick++));
  const collections = await createCollections({ root: dir, clock: localClock });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Promise', fields: { state: 'old' }, text: 'old body' });
  await collections.save({ collection: 'notes', title: 'Promise', fields: { state: 'new' }, text: 'new body' });
  const before = await collections.history({ collection: 'notes', entry: 'promise' });
  const source = before.versions[0];

  const attempts = await Promise.allSettled([0, 1].map(() => collections.restore({
    collection: 'notes', entry: before.entry, versionId: source.versionId,
    expectedCurrentFingerprint: before.current.fingerprint, by: 'person',
  })));
  assert.deepEqual(attempts.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const restored = attempts.find(result => result.status === 'fulfilled').value;
  assert.match(attempts.find(result => result.status === 'rejected').reason.message, /changed since it was inspected/);
  assert.equal(restored.restored.by, 'person');
  assert.deepEqual(restored.restoredFrom, { kind: 'history', fingerprint: source.fingerprint, versionId: source.versionId });
  const current = await collections.read({ collection: 'notes', entry: 'promise' });
  assert.equal(current.text.trim(), 'old body');
  assert.equal(current.by, 'person');
  assert.deepEqual(current.restoredFrom, restored.restoredFrom);

  const after = await collections.history({ collection: 'notes', entry: 'promise' });
  assert.ok(after.versions.some(row => row.versionId === source.versionId), 'the selected source remains retained');
  assert.ok(after.versions.some(row => row.fingerprint === before.current.fingerprint), 'the displaced current becomes retained history');
  assert.equal((await collections.version({ collection: 'notes', entry: 'promise', versionId: source.versionId })).value.text.trim(), 'old body');

  await assert.rejects(collections.restore({
    collection: 'notes', entry: 'promise', versionId: source.versionId,
    expectedCurrentFingerprint: before.current.fingerprint, by: 'person',
  }), /changed since it was inspected/);
  assert.equal((await collections.read({ collection: 'notes', entry: 'promise' })).text.trim(), 'old body');

  const reopened = await createCollections({ root: dir, clock: localClock });
  assert.deepEqual((await reopened.read({ collection: 'notes', entry: 'promise' })).restoredFrom, restored.restoredFrom);
});

test('retained history can recreate an absent current entry behind the null fence', async t => {
  const dir = await root(t);
  let tick = 0;
  const localClock = () => new Date(Date.UTC(2033, 3, 5, 7, tick++));
  const collections = await createCollections({ root: dir, clock: localClock });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Return earlier', text: 'earlier body' });
  await collections.save({ collection: 'notes', title: 'Return earlier', text: 'later body' });
  const beforeRemoval = await collections.history({ collection: 'notes', entry: 'return-earlier' });
  const earlier = beforeRemoval.versions[0];
  await collections.remove({ collection: 'notes', entry: 'return-earlier' });
  const absent = await collections.history({ collection: 'notes', entry: 'return-earlier' });
  assert.equal(absent.current, null);
  assert.equal(absent.versions[0].versionId, earlier.versionId);

  const restored = await collections.restore({
    collection: 'notes', entry: 'return-earlier', versionId: earlier.versionId,
    expectedCurrentFingerprint: null, by: 'person',
  });
  assert.deepEqual(restored.restoredFrom, { kind: 'history', fingerprint: earlier.fingerprint, versionId: earlier.versionId });
  assert.equal((await collections.read({ collection: 'notes', entry: 'return-earlier' })).text.trim(), 'earlier body');
  assert.equal((await collections.version({
    collection: 'notes', entry: 'return-earlier', versionId: earlier.versionId,
  })).value.text.trim(), 'earlier body');
  assert.equal((await collections.removed({ collection: 'notes' })).items[0].title, 'Return earlier');
  await assert.rejects(collections.restore({
    collection: 'notes', entry: 'return-earlier', versionId: earlier.versionId,
    expectedCurrentFingerprint: null, by: 'person',
  }), /changed since it was inspected/);
});

test('failed current publication rolls back the just-created history for save and restore', async t => {
  const dir = await root(t);
  let tick = 0;
  const collections = await createCollections({ root: dir, clock: () => new Date(Date.UTC(2033, 3, 5, 8, tick++)) });
  const fill = async (collection, title) => {
    await collections.make({ name: collection });
    await collections.save({ collection, title, text: 'version 0' });
    for (let version = 1; version <= 10; version++) {
      await collections.save({ collection, title, text: `version ${version}` });
    }
    return collections.history({ collection, entry: entrySlug(title) });
  };
  const saveBefore = await fill('save-case', 'Save pressure');
  const restoreBefore = await fill('restore-case', 'Restore pressure');
  const originalRename = fs.rename.bind(fs);
  let failureTarget = null;
  let failNext = false;
  t.mock.method(fs, 'rename', async (from, to, ...args) => {
    if (failNext && path.resolve(String(to)) === failureTarget
      && path.basename(String(from)).startsWith(`.${path.basename(failureTarget)}.`)) {
      failNext = false;
      throw Object.assign(new Error('synthetic current publication failure'), { code: 'EIO' });
    }
    return originalRename(from, to, ...args);
  });

  failureTarget = await fs.realpath(path.resolve(dir, 'save-case', 'save-pressure.md'));
  failNext = true;
  await assert.rejects(collections.save({
    collection: 'save-case', title: 'Save pressure', text: 'must not land',
  }), /synthetic current publication failure/);
  const saveAfterFailure = await collections.history({ collection: 'save-case', entry: 'save-pressure' });
  assert.equal(saveAfterFailure.current.fingerprint, saveBefore.current.fingerprint);
  assert.deepEqual(saveAfterFailure.versions.map(row => row.versionId), saveBefore.versions.map(row => row.versionId));
  assert.equal(saveAfterFailure.versions.length, 10);
  const saveRetry = await collections.save({ collection: 'save-case', title: 'Save pressure', text: 'retry lands' });
  assert.deepEqual(saveRetry.retention, { limit: 10, retained: 10, pruned: 1 });

  failureTarget = await fs.realpath(path.resolve(dir, 'restore-case', 'restore-pressure.md'));
  failNext = true;
  const restoreSource = restoreBefore.versions.at(-1);
  await assert.rejects(collections.restore({
    collection: 'restore-case', entry: 'restore-pressure', versionId: restoreSource.versionId,
    expectedCurrentFingerprint: restoreBefore.current.fingerprint, by: 'person',
  }), /synthetic current publication failure/);
  const restoreAfterFailure = await collections.history({ collection: 'restore-case', entry: 'restore-pressure' });
  assert.equal(restoreAfterFailure.current.fingerprint, restoreBefore.current.fingerprint);
  assert.deepEqual(restoreAfterFailure.versions.map(row => row.versionId), restoreBefore.versions.map(row => row.versionId));
  assert.equal(restoreAfterFailure.versions.length, 10);
  const restoreRetry = await collections.restore({
    collection: 'restore-case', entry: 'restore-pressure', versionId: restoreSource.versionId,
    expectedCurrentFingerprint: restoreBefore.current.fingerprint, by: 'person',
  });
  assert.deepEqual(restoreRetry.retention, { limit: 10, retained: 10, pruned: 1 });
});

test('restoring the oldest retained version protects it while pruning under pressure', async t => {
  const dir = await root(t);
  let tick = 0;
  const collections = await createCollections({ root: dir, clock: () => new Date(Date.UTC(2033, 3, 5, 6, tick++)) });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Pressure', text: 'version 0' });
  for (let version = 1; version <= 10; version++) {
    await collections.save({ collection: 'notes', title: 'Pressure', text: `version ${version}` });
  }
  const before = await collections.history({ collection: 'notes', entry: 'pressure' });
  assert.equal(before.versions.length, 10);
  const oldest = before.versions.at(-1);
  const restored = await collections.restore({
    collection: 'notes', entry: 'pressure', versionId: oldest.versionId,
    expectedCurrentFingerprint: before.current.fingerprint, by: 'person',
  });
  assert.deepEqual(restored.retention, { limit: 10, retained: 10, pruned: 1 });
  const after = await collections.history({ collection: 'notes', entry: 'pressure' });
  assert.equal(after.versions.length, 10);
  assert.ok(after.versions.some(row => row.versionId === oldest.versionId));
  assert.ok(after.versions.some(row => row.fingerprint === before.current.fingerprint));
});

test('restoring a removed version requires absence and never consumes the recovery copy', async t => {
  const dir = await root(t);
  let tick = 0;
  const localClock = () => new Date(Date.UTC(2034, 4, 6, 7, tick++));
  const collections = await createCollections({ root: dir, clock: localClock });
  await collections.make({ name: 'notes' });
  await collections.save({ collection: 'notes', title: 'Return', text: 'kept aside' });
  await collections.remove({ collection: 'notes', entry: 'return' });
  const source = (await collections.removed({ collection: 'notes' })).items[0];

  const restored = await collections.restore({
    collection: 'notes', entry: source.entry, versionId: source.versionId,
    expectedCurrentFingerprint: null, by: 'person',
  });
  assert.equal(restored.restoredFrom.kind, 'removed');
  assert.equal((await collections.read({ collection: 'notes', entry: 'return' })).text.trim(), 'kept aside');
  assert.equal((await collections.version({ collection: 'notes', entry: source.entry, versionId: source.versionId })).value.text.trim(), 'kept aside');
  assert.equal((await collections.removed({ collection: 'notes' })).items[0].versionId, source.versionId);

  await assert.rejects(collections.restore({
    collection: 'notes', entry: source.entry, versionId: source.versionId,
    expectedCurrentFingerprint: null, by: 'person',
  }), /changed since it was inspected/);
  await assert.rejects(collections.restore({
    collection: 'notes', entry: source.entry, versionId: restored.restored.versionId,
    expectedCurrentFingerprint: restored.restored.fingerprint, by: 'person',
  }), /only a retained history or removed version/);
});

test('removed restore respects current collection capacity', async t => {
  const dir = await root(t);
  const fixed = () => new Date('2035-06-07T08:09:10.000Z');
  const collections = await createCollections({ root: dir, clock: fixed });
  await collections.make({ name: 'full' });
  await collections.save({ collection: 'full', title: 'Recovery', text: 'source' });
  await collections.remove({ collection: 'full', entry: 'recovery' });
  const source = (await collections.removed({ collection: 'full' })).items[0];
  const folder = path.join(dir, 'full');
  const raw = index => `---\ntitle: Item ${index}\ncreated: 2035-06-07T08:09:10.000Z\nupdated: 2035-06-07T08:09:10.000Z\nby: agent\n---\n`;
  for (let index = 0; index < 2000; index++) await fs.writeFile(path.join(folder, `item-${index}.md`), raw(index));

  await assert.rejects(collections.restore({
    collection: 'full', entry: source.entry, versionId: source.versionId,
    expectedCurrentFingerprint: null, by: 'person',
  }), /collection is full/);
  assert.equal((await collections.version({ collection: 'full', entry: source.entry, versionId: source.versionId })).value.text.trim(), 'source');
});
