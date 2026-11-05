import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FIELDWORK_HELP_DOCUMENTS,
  FIELDWORK_HELP_LIMITS,
  fieldworkHelpTools,
} from '../src/fieldwork-help.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-help-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const document of FIELDWORK_HELP_DOCUMENTS) {
    const file = path.join(root, ...document.path.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const text = document.id === 'readme'
      ? '# Fieldwork\n\n## Start here\nThe local authenticated room keeps an inspectable receipt.\n'
      : `# ${document.title}\n\nNo matching synthetic phrase in this document.\n`;
    await fs.writeFile(file, text);
  }
  return root;
}

test('Fieldwork help searches and reads only bounded packaged documentation', async t => {
  const root = await fixture(t);
  const definitions = await fieldworkHelpTools({ root });
  assert.deepEqual(definitions.map(tool => [tool.name, tool.effect]), [
    ['search_fieldwork_docs', 'read-only'],
    ['read_fieldwork_doc', 'read-only'],
  ]);
  const search = definitions.find(tool => tool.name === 'search_fieldwork_docs');
  const read = definitions.find(tool => tool.name === 'read_fieldwork_doc');

  const found = await search.execute({ query: 'local authenticated', limit: 2 });
  assert.equal(found.matches.length, 1);
  assert.deepEqual(found.matches[0], {
    id: 'readme',
    title: 'Fieldwork README',
    section: 'Start here',
    line: 4,
    excerpt: '## Start here The local authenticated room keeps an inspectable receipt.',
    citation: '[readme > Start here]',
  });
  assert.match(found.note, /not observations of the live room/);

  const passage = await read.execute({ id: 'readme', line: 3 });
  assert.equal(passage.source, 'README.md');
  assert.equal(passage.section, 'Start here');
  assert.equal(passage.fromLine, 3);
  assert.match(passage.text, /local authenticated room/);
  assert.equal(Object.hasOwn(passage, 'path'), false);

  await assert.rejects(read.execute({ id: '../../private', line: 1 }), /not in the packaged help catalog/);
  await assert.rejects(read.execute({ id: 'readme', line: 999 }), /exceeds/);
  await assert.rejects(search.execute({ query: 'x'.repeat(FIELDWORK_HELP_LIMITS.queryCharacters + 1) }), /at most/);
});

test('Fieldwork help refuses linked documents and lines that cannot fit a bounded result', async t => {
  const root = await fixture(t);
  const definitions = await fieldworkHelpTools({ root });
  const read = definitions.find(tool => tool.name === 'read_fieldwork_doc');
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, `# Fieldwork\n${'x'.repeat(FIELDWORK_HELP_LIMITS.readCharacters + 1)}\n`);
  await assert.rejects(read.execute({ id: 'readme' }), /line too long/);

  const target = path.join(root, 'outside.md');
  await fs.writeFile(target, 'private');
  await fs.rm(readme);
  try { await fs.symlink(target, readme, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`Windows did not permit a file symlink (${error.code})`);
      return;
    }
    throw error;
  }
  await assert.rejects(read.execute({ id: 'readme' }), /linked path|regular file|outside the package root/);
});

test('Fieldwork help bounds headings and whole serialized results', async t => {
  const root = await fixture(t);
  const definitions = await fieldworkHelpTools({ root });
  const search = definitions.find(tool => tool.name === 'search_fieldwork_docs');
  const read = definitions.find(tool => tool.name === 'read_fieldwork_doc');
  const heading = `Help ${'wide'.repeat(5_000)}`;
  await fs.writeFile(path.join(root, 'README.md'), `# ${heading}\n\nneedle evidence\n`);

  const found = await search.execute({ query: 'needle evidence' });
  assert.ok([...found.matches[0].section].length <= FIELDWORK_HELP_LIMITS.sectionCharacters);
  assert.ok(Buffer.byteLength(JSON.stringify(found), 'utf8') <= FIELDWORK_HELP_LIMITS.searchResultBytes);
  assert.match(found.matches[0].section, /…$/u);

  const passage = await read.execute({ id: 'readme', line: 3 });
  assert.ok([...passage.section].length <= FIELDWORK_HELP_LIMITS.sectionCharacters);
  assert.ok(Buffer.byteLength(JSON.stringify(passage), 'utf8') <= FIELDWORK_HELP_LIMITS.readResultBytes);
});

test('Fieldwork help rejects an allowlisted path that crosses a linked directory', async t => {
  const root = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-help-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'how-fieldwork-works.md'), '# Outside\nnot packaged\n');
  await fs.rm(path.join(root, 'docs'), { recursive: true });
  try { await fs.symlink(outside, path.join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`Windows did not permit a directory link (${error.code})`);
      return;
    }
    throw error;
  }

  const definitions = await fieldworkHelpTools({ root });
  const read = definitions.find(tool => tool.name === 'read_fieldwork_doc');
  await assert.rejects(read.execute({ id: 'how-it-works' }), /crosses a linked path|outside the package root/);
});
